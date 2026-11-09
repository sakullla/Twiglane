//! 仓库切换列表的数据源：
//! - 直接读各仓库的 HEAD 文件得到当前检出的分支（不启动 Git，出错就返回空）；
//! - 从最近仓库出发解析主仓库，用 `git worktree list --porcelain` 枚举实际附属工作区，
//!   再逐项读取未提交、冲突与本地 upstream 的 ahead/behind，供 worktree 总览使用（ADR-4）。
//!
//! 全部只读、限量、绝不自动 fetch：单项失败只把该项标为未知，其他项照常返回。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::command::{status_command, worktree_list_command};
use crate::git::gate::remote_check_is_stale;
use crate::git::ops::{
    canonical_existing, repo_key, require_git, run_git, validate_input_path, Backend,
};
use crate::git::parse::parse_status;
use crate::git::schedule::{internal_request_id, JobKind};
use crate::model::ChangeKind;
use crate::redact::redact_error_text;

/// 一次最多读这么多仓库；最近列表再长，用户也只看得见前面一屏。
const MAX_HEADS: usize = 600;
/// 一次总览最多启动这么多次 `git status`：超出上限的工作区标为未知，而不是悄悄省略。
const MAX_OVERVIEW_STATUS: usize = 200;
/// 一次总览最多枚举这么多个主仓库的工作区（同一 common dir 只算一次）：超出同样标未知。
const MAX_OVERVIEW_ENUMERATE: usize = 64;
/// HEAD 与 .git 文件都很小；超过这个大小说明不是我们认识的格式。
const MAX_HEAD_BYTES: u64 = 4096;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHead {
    pub path: String,
    /// 当前检出的分支短名；游离 HEAD 或读取失败时为空。
    pub branch: Option<String>,
    /// 游离 HEAD 时的短提交标识。
    pub detached: Option<String>,
    /// 目录已不存在或不再是 Git 仓库。
    pub missing: bool,
    /// 是 `git worktree add` 建出来的附属工作区（不是主工作区，也不是子模块）。
    pub worktree: bool,
    /// 附属工作区所属主仓库的工作目录；主仓库是裸仓库时为仓库目录本身。
    pub main_path: Option<String>,
}

pub fn repo_heads(paths: &[String]) -> Vec<RepoHead> {
    paths.iter().take(MAX_HEADS).map(|path| read_head(path)).collect()
}

fn read_head(path: &str) -> RepoHead {
    let mut head = RepoHead {
        path: path.to_string(),
        branch: None,
        detached: None,
        missing: false,
        worktree: false,
        main_path: None,
    };
    let Ok(root) = validate_input_path(path) else {
        head.missing = true;
        return head;
    };
    let Some(git_dir) = git_dir(&root) else {
        head.missing = true;
        return head;
    };
    if let Some(main) = linked_main(&root, &git_dir) {
        head.worktree = true;
        head.main_path = Some(main.to_string_lossy().into_owned());
    }
    let Some(text) = read_small(&git_dir.join("HEAD")) else {
        return head;
    };
    let text = text.trim();
    if let Some(reference) = text.strip_prefix("ref:") {
        let reference = reference.trim();
        head.branch = Some(reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string());
    } else if text.len() >= 7 && text.chars().all(|character| character.is_ascii_hexdigit()) {
        head.detached = Some(text[..7].to_ascii_lowercase());
    }
    head
}

/// `.git` 是目录时就是它；是文件（工作区、子模块）时按 `gitdir:` 指向的位置。
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    let meta = fs::metadata(&dot).ok()?;
    if meta.is_dir() {
        return Some(dot);
    }
    let text = read_small(&dot)?;
    let target = text.lines().find_map(|line| line.trim().strip_prefix("gitdir:"))?.trim();
    if target.is_empty() {
        return None;
    }
    let target = PathBuf::from(target);
    let resolved = if target.is_absolute() { target } else { root.join(target) };
    resolved.is_dir().then_some(resolved)
}

/// 附属工作区的管理目录里有 `commondir`，指向主仓库的 `.git`；子模块没有这个文件。
/// 返回主仓库的工作目录（`.git` 的上一级），主仓库是裸仓库时返回仓库目录本身。
pub(crate) fn linked_main(root: &Path, git_dir: &Path) -> Option<PathBuf> {
    if fs::metadata(root.join(".git")).ok()?.is_dir() {
        return None;
    }
    let text = read_small(&git_dir.join("commondir"))?;
    let target = PathBuf::from(text.trim());
    if target.as_os_str().is_empty() {
        return None;
    }
    let common = if target.is_absolute() { target } else { git_dir.join(target) };
    let common = dunce::canonicalize(&common).ok()?;
    if common.file_name().is_some_and(|name| name == ".git") {
        common.parent().map(Path::to_path_buf)
    } else {
        Some(common)
    }
}

/// 仓库根目录对应的 Git 目录；公开给删除工作区时判定目标类型。
pub(crate) fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    git_dir(root)
}

/// 一项工作区的真实状态。每项自带 `checkedAtMs` 与状态来源，
/// 失败、缺失与未核各用不同字段表达，绝不把旧数字说成新鲜结果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeItem {
    /// 规范化后的工作区路径；目录缺失时是最近列表里记下的原路径。
    pub path: String,
    /// 所属主仓库的工作区路径；无法归属时为空。
    pub main_path: Option<String>,
    pub branch: Option<String>,
    pub detached: Option<String>,
    /// 目录已不存在或不再是 Git 仓库。
    pub missing: bool,
    /// 是 `git worktree add` 建出来的附属工作区。
    pub linked: bool,
    /// `git worktree lock` 锁定；删除保护不受影响。
    pub locked: bool,
    /// 这一项来自最近仓库列表（枚举出来的附属工作区可能不在其中）。
    pub recent: bool,
    /// 未提交状态是否读到；读不到时为空，界面显示未知而不是「干净」。
    pub dirty: Option<bool>,
    pub changed: Option<u32>,
    pub staged: Option<u32>,
    pub unstaged: Option<u32>,
    pub untracked: Option<u32>,
    pub conflicted: Option<u32>,
    /// 本地 upstream 与其计数：未 fetch 时只代表本地已记录的远端分支。
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    /// 只在用户本会话确实核对过远程且仍在新鲜窗口内时为真；总览自身不 fetch。
    pub live_remote_checked: bool,
    pub remote_checked_at_ms: Option<u64>,
    pub remote_check_stale: bool,
    /// ready（读到）/ missing（目录不在）/ unknown（读失败或超限）。
    pub status: String,
    /// 该项的失败或限制说明；空字符串表示没有。
    pub note: String,
    /// 读到状态的时间；失败、超限、缺失这类没有读到的项为空，界面不得拿它冒充当前状态。
    pub checked_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOverview {
    pub items: Vec<WorktreeItem>,
    pub checked_at_ms: u64,
}

/// `git worktree list --porcelain` 的一条记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// 解析工作区列表：空行分隔记录，路径原样给出（porcelain 不做引号转义）。
pub fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, value),
            None => (line, ""),
        };
        match key {
            "worktree" => {
                if !value.is_empty() {
                    if let Some(entry) = current.take() {
                        entries.push(entry);
                    }
                    current = Some(WorktreeEntry {
                        path: PathBuf::from(value),
                        head: None,
                        branch: None,
                        bare: false,
                        locked: false,
                        prunable: false,
                    });
                }
            }
            "HEAD" => {
                if let Some(entry) = current.as_mut() {
                    entry.head = Some(value.to_string());
                }
            }
            "branch" => {
                if let Some(entry) = current.as_mut() {
                    entry.branch =
                        Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string());
                }
            }
            "bare" => {
                if let Some(entry) = current.as_mut() {
                    entry.bare = true;
                }
            }
            "locked" => {
                if let Some(entry) = current.as_mut() {
                    entry.locked = true;
                }
            }
            "prunable" => {
                if let Some(entry) = current.as_mut() {
                    entry.prunable = true;
                }
            }
            _ => {}
        }
    }
    if let Some(entry) = current.take() {
        entries.push(entry);
    }
    entries
}

/// 用于去重与归属比对的路径身份：Windows 上大小写与分隔符都不参与判定。
fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn short_oid(oid: &str) -> Option<String> {
    let oid = oid.trim();
    let short: String = oid.chars().take(7).collect();
    (short.len() == 7).then(|| short.to_ascii_lowercase())
}

/// 一项还没读到状态的条目：字段未知、读取时间为空，绝不用调用时刻伪装成读过。
fn blank_item(path: String, main_path: Option<String>) -> WorktreeItem {
    WorktreeItem {
        path,
        main_path,
        branch: None,
        detached: None,
        missing: false,
        linked: false,
        locked: false,
        recent: false,
        dirty: None,
        changed: None,
        staged: None,
        unstaged: None,
        untracked: None,
        conflicted: None,
        upstream: None,
        ahead: None,
        behind: None,
        live_remote_checked: false,
        remote_checked_at_ms: None,
        remote_check_stale: false,
        status: "unknown".to_string(),
        note: String::new(),
        checked_at_ms: None,
    }
}

fn note_from(error: &crate::error::AppError) -> String {
    redact_error_text(error.message.trim())
}

/// 工作区总览：从最近仓库解析主仓库，枚举实际附属工作区，再逐项读取真实状态。
///
/// 只读且不 fetch；每项独立读取，单项失败只把该项标成未知并带上原因。
pub async fn worktree_overview(
    backend: &Backend,
    paths: &[String],
    request_id: u64,
) -> Result<WorktreeOverview, crate::error::AppError> {
    worktree_overview_with(
        backend,
        paths,
        request_id,
        MAX_OVERVIEW_STATUS,
        MAX_OVERVIEW_ENUMERATE,
    )
    .await
}

/// 枚举与状态读取的预算显式传入：测试用很小的预算就能覆盖「超限只影响该项」。
async fn worktree_overview_with(
    backend: &Backend,
    paths: &[String],
    request_id: u64,
    max_status: usize,
    max_enumerate: usize,
) -> Result<WorktreeOverview, crate::error::AppError> {
    let git = require_git(backend).await?;
    let now = crate::state::now_ms();
    let mut items: Vec<WorktreeItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut recent_keys: HashSet<String> = HashSet::new();
    let mut status_budget = max_status;
    let mut list_budget = max_enumerate;
    // 同一主仓库（common dir）只枚举一次：最近列表里主仓库与它的附属工作区常常同时在场，
    // 各起一次 `git worktree list` 只是把同一份结果重复 spawn。
    let mut listed: HashMap<String, Vec<WorktreeEntry>> = HashMap::new();

    for raw in paths.iter().take(MAX_HEADS) {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        recent_keys.insert(raw.replace('\\', "/").to_lowercase());

        // 最近项本身读不到：保留这一项，标成缺失，而不是从总览里消失。
        let input = match validate_input_path(raw) {
            Ok(input) => input,
            Err(_) => {
                let mut item = blank_item(raw.to_string(), None);
                item.missing = true;
                item.status = "missing".to_string();
                item.note = "路径无效，无法读取这个工作区。".to_string();
                if seen.insert(raw.replace('\\', "/").to_lowercase()) {
                    items.push(item);
                }
                continue;
            }
        };
        let root = match canonical_existing(&input) {
            Ok(root) => root,
            Err(error) => {
                let mut item = blank_item(raw.to_string(), None);
                item.missing = true;
                item.status = "missing".to_string();
                item.note = note_from(&error);
                if seen.insert(raw.replace('\\', "/").to_lowercase()) {
                    items.push(item);
                }
                continue;
            }
        };
        let Some(git_dir) = resolve_git_dir(&root) else {
            let mut item = blank_item(repo_key(&root), None);
            item.missing = true;
            item.status = "missing".to_string();
            item.note = "目录已存在，但不再是 Git 仓库。".to_string();
            if seen.insert(path_key(&root)) {
                items.push(item);
            }
            continue;
        };
        let main = linked_main(&root, &git_dir).unwrap_or_else(|| root.clone());
        let main_path = repo_key(&main);
        let main_key = path_key(&main);

        // 同一主仓库已经有枚举结果时直接复用，不再为每个最近路径各起一次进程。
        let entries = if let Some(cached) = listed.get(&main_key) {
            cached.clone()
        } else if list_budget == 0 {
            let mut item = blank_item(repo_key(&root), Some(main_path.clone()));
            item.note = format!("本次最多枚举 {max_enumerate} 个主仓库的工作区，这一项没有读取。");
            if seen.insert(path_key(&root)) {
                items.push(item);
            }
            continue;
        } else {
            list_budget -= 1;
            let (program, args) = worktree_list_command(&git.path, &root);
            let scheduled = run_git(
                backend,
                &repo_key(&main),
                JobKind::Read,
                request_id,
                program,
                args,
                None,
            )
            .await;
            let text = match scheduled {
                Ok(scheduled) if scheduled.output.exit_code == 0 => {
                    String::from_utf8_lossy(&scheduled.output.stdout).into_owned()
                }
                Ok(scheduled) => {
                    let mut item = blank_item(repo_key(&root), Some(main_path.clone()));
                    item.note = if scheduled.output.stderr.is_empty() {
                        "Git 没有列出这个仓库的工作区。".to_string()
                    } else {
                        redact_error_text(String::from_utf8_lossy(&scheduled.output.stderr).trim())
                    };
                    if seen.insert(path_key(&root)) {
                        items.push(item);
                    }
                    continue;
                }
                Err(error) => {
                    let mut item = blank_item(repo_key(&root), Some(main_path.clone()));
                    item.note = note_from(&error);
                    if seen.insert(path_key(&root)) {
                        items.push(item);
                    }
                    continue;
                }
            };
            let entries = parse_worktree_list(&text);
            if entries.is_empty() {
                let mut item = blank_item(repo_key(&root), Some(main_path.clone()));
                item.note = "Git 没有列出这个仓库的工作区。".to_string();
                if seen.insert(path_key(&root)) {
                    items.push(item);
                }
                continue;
            }
            // 统一成绝对路径并规范化：复用同一主仓库的枚举结果时不再关心是哪个最近项发起的。
            let entries: Vec<WorktreeEntry> = entries
                .into_iter()
                .map(|mut entry| {
                    let path = if entry.path.is_absolute() {
                        entry.path.clone()
                    } else {
                        root.join(&entry.path)
                    };
                    entry.path = dunce::canonicalize(&path).unwrap_or(path);
                    entry
                })
                .collect();
            listed.insert(main_key.clone(), entries.clone());
            entries
        };

        for entry in entries {
            let canonical = entry.path;
            let key = path_key(&canonical);
            if !seen.insert(key) {
                continue;
            }
            let mut item = blank_item(repo_key(&canonical), Some(main_path.clone()));
            item.linked = main_key != path_key(&canonical);
            item.locked = entry.locked;
            item.branch = entry.branch.clone();
            if entry.branch.is_none() {
                item.detached = entry.head.as_deref().and_then(short_oid);
            }
            if entry.bare {
                item.status = "unknown".to_string();
                item.note = "裸仓库没有工作区，读不到未提交状态。".to_string();
                items.push(item);
                continue;
            }
            if entry.prunable || !canonical.is_dir() {
                item.missing = true;
                item.status = "missing".to_string();
                item.note = "目录已不存在（Git 把这个工作区标记为可清理）。".to_string();
                items.push(item);
                continue;
            }
            if status_budget == 0 {
                item.note = format!("本次最多读取 {max_status} 个工作区的状态，这一项没有读取。");
                items.push(item);
                continue;
            }
            status_budget -= 1;

            let (program, args) = status_command(&git.path, &canonical);
            let scheduled = run_git(
                backend,
                &repo_key(&canonical),
                JobKind::Read,
                internal_request_id(),
                program,
                args,
                None,
            )
            .await;
            let outcome = match scheduled {
                Ok(scheduled) => status_outcome(
                    scheduled.output.exit_code,
                    &scheduled.output.stdout,
                    &scheduled.output.stderr,
                ),
                Err(error) => Err(note_from(&error)),
            };
            let snapshot = match outcome {
                Ok(snapshot) => Some(snapshot),
                Err(note) => {
                    item.note = note;
                    None
                }
            };

            if let Some(snapshot) = snapshot {
                let branch = snapshot.branch;
                if branch.name.is_some() {
                    item.branch = branch.name.clone();
                    item.detached = None;
                } else if branch.detached {
                    item.detached = branch.head_oid.as_deref().and_then(short_oid);
                }
                item.upstream = branch.upstream.clone();
                item.ahead = branch.ahead;
                item.behind = branch.behind;
                let files = &snapshot.files;
                item.changed = Some(files.len() as u32);
                item.dirty = Some(!files.is_empty());
                item.conflicted = Some(files.iter().filter(|file| file.unmerged).count() as u32);
                item.staged = Some(
                    files
                        .iter()
                        .filter(|file| file.unmerged || file.staged != ChangeKind::None)
                        .count() as u32,
                );
                item.unstaged = Some(
                    files
                        .iter()
                        .filter(|file| {
                            !file.untracked
                                && (file.unmerged || file.unstaged != ChangeKind::None)
                        })
                        .count() as u32,
                );
                item.untracked = Some(files.iter().filter(|file| file.untracked).count() as u32);
                item.status = "ready".to_string();
                // 只有真读到状态时才记读取时间；未知项不带时间，界面就不会说它刚读过。
                item.checked_at_ms = Some(now);
                let checked = backend.remote_checks.get(&repo_key(&canonical));
                let stale = checked.is_some_and(|at| remote_check_is_stale(at, now));
                item.remote_checked_at_ms = checked;
                item.remote_check_stale = stale;
                item.live_remote_checked = checked.is_some() && !stale;
            }
            items.push(item);
        }
    }

    for item in &mut items {
        if recent_keys.contains(&item.path.replace('\\', "/").to_lowercase()) {
            item.recent = true;
        }
    }

    Ok(WorktreeOverview {
        items,
        checked_at_ms: now,
    })
}

/// `git status` 的输出归类：非零退出是进程失败，零退出但读不懂是解析失败。
/// 两者都只让这一项变成未知，并带上已脱敏的原因；不会被当成干净。
fn status_outcome(
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<crate::model::StatusSnapshot, String> {
    if exit_code != 0 {
        let detail = redact_error_text(String::from_utf8_lossy(stderr).trim());
        return Err(if detail.is_empty() {
            "无法读取这个工作区的状态。".to_string()
        } else {
            detail
        });
    }
    parse_status(stdout).map_err(|error| note_from(&error))
}

fn read_small(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_HEAD_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("twiglane-heads-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_branch_detached_worktree_and_missing() {
        let repo = temp("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feature/a\n").unwrap();
        let head = read_head(repo.to_str().unwrap());
        assert_eq!(head.branch.as_deref(), Some("feature/a"));
        assert!(!head.missing);

        fs::write(repo.join(".git/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        let head = read_head(repo.to_str().unwrap());
        assert_eq!(head.branch, None);
        assert_eq!(head.detached.as_deref(), Some("0123456"));

        let worktree = temp("worktree");
        let admin = repo.join(".git/worktrees/wt");
        fs::create_dir_all(&admin).unwrap();
        fs::write(admin.join("HEAD"), "ref: refs/heads/wt-branch\n").unwrap();
        fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        let linked = read_head(worktree.to_str().unwrap());
        assert_eq!(linked.branch.as_deref(), Some("wt-branch"));
        // 没有 commondir 的 gitdir 文件是子模块那种形态，不算附属工作区。
        assert!(!linked.worktree);
        fs::write(admin.join("commondir"), "../..\n").unwrap();
        let linked = read_head(worktree.to_str().unwrap());
        assert!(linked.worktree);
        let main = dunce::canonicalize(&repo).unwrap();
        assert_eq!(linked.main_path.as_deref(), Some(main.to_str().unwrap()));
        assert!(!read_head(repo.to_str().unwrap()).worktree);

        let gone = repo.join("does-not-exist");
        assert!(read_head(gone.to_str().unwrap()).missing);
        assert!(read_head("relative/path").missing);

        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&worktree);
    }
}

#[cfg(test)]
mod overview_tests {
    use super::*;
    use std::process::Command;

    /// 真实 Git 夹具：参数逐个传入，环境隔离，任何非零退出都直接失败。
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", crate::test_support::isolated_gitconfig())
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?} {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// 允许失败的 Git 调用（冲突合并预期非零退出）。
    fn git_try(dir: &Path, args: &[&str]) -> bool {
        Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", crate::test_support::isolated_gitconfig())
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .status()
            .unwrap()
            .success()
    }

    fn base_repo(fixture: &crate::test_support::GitFixture) -> PathBuf {
        let main = fixture.repo("main");
        git(&main, &["init", "-b", "main"]);
        fs::write(main.join("a.txt"), "one\n").unwrap();
        git(&main, &["add", "--", "a.txt"]);
        git(&main, &["commit", "-m", "base"]);
        main
    }

    fn item_at(overview: &WorktreeOverview, path: &Path) -> WorktreeItem {
        let key = path_key(path);
        overview
            .items
            .iter()
            .find(|item| path_key(Path::new(&item.path)) == key)
            .cloned()
            .unwrap_or_else(|| panic!("总览里没有 {path:?}：{:?}", overview.items))
    }

    #[test]
    fn parses_worktree_list_records() {
        let text = "worktree /repo\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\n\
                    worktree /repo-wt\nHEAD abcdef0123456789\ndetached\nlocked held by me\n\n\
                    worktree /repo-gone\nHEAD fedcba9876543210\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\n\
                    worktree /repo.git\nHEAD 1111111111111111\nbare\n\n";
        let entries = parse_worktree_list(text);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[0].path, PathBuf::from("/repo"));
        assert!(entries[1].branch.is_none());
        assert!(entries[1].locked);
        assert_eq!(entries[1].head.as_deref(), Some("abcdef0123456789"));
        assert!(entries[2].prunable);
        assert!(entries[3].bare);
        // 空输入不会伪造记录。
        assert!(parse_worktree_list("").is_empty());
    }

    #[tokio::test]
    async fn groups_worktrees_by_main_and_reports_clean_dirty_locked_missing() {
        let fixture = crate::test_support::git_fixture("overview-basic");
        let backend = fixture.backend();
        let main = base_repo(&fixture);
        let clean = fixture.path().join("clean");
        git(&main, &["worktree", "add", "-b", "clean-branch", repo_key(&clean).as_str()]);
        let dirty = fixture.path().join("dirty");
        git(&main, &["worktree", "add", "-b", "dirty-branch", repo_key(&dirty).as_str()]);
        fs::write(dirty.join("scratch.txt"), "keep\n").unwrap();
        let locked = fixture.path().join("locked");
        git(&main, &["worktree", "add", "-b", "locked-branch", repo_key(&locked).as_str()]);
        git(&main, &["worktree", "lock", repo_key(&locked).as_str()]);
        // 最近列表里记着但目录已经不在的一项：必须保留并标成缺失。
        let gone = fixture.path().join("gone");

        let before = git(&main, &["rev-parse", "HEAD"]);
        let overview = worktree_overview(
            &backend,
            &[repo_key(&main), repo_key(&dirty), repo_key(&gone)],
            1,
        )
        .await
        .unwrap();

        // 主仓库 + 三个附属工作区 + 缺失项，同一路径只出现一次。
        assert_eq!(overview.items.len(), 5, "{:?}", overview.items);
        let main_key = path_key(&dunce::canonicalize(&main).unwrap());

        let root = item_at(&overview, &main);
        assert!(!root.linked);
        assert!(root.recent);
        assert_eq!(root.status, "ready");
        assert_eq!(root.dirty, Some(false));
        assert_eq!(root.changed, Some(0));
        assert_eq!(root.branch.as_deref(), Some("main"));
        assert_eq!(root.main_path.as_deref().map(|path| path_key(Path::new(path))), Some(main_key.clone()));
        // 默认总览不 fetch：没有任何远程核对时间，只靠本地 upstream。
        assert!(!root.live_remote_checked);
        assert_eq!(root.remote_checked_at_ms, None);

        let clean_item = item_at(&overview, &clean);
        assert!(clean_item.linked);
        assert!(!clean_item.recent, "枚举出来的工作区不在最近列表里");
        assert_eq!(clean_item.status, "ready");
        assert_eq!(clean_item.dirty, Some(false));
        assert_eq!(clean_item.branch.as_deref(), Some("clean-branch"));
        assert_eq!(clean_item.main_path.as_deref().map(|path| path_key(Path::new(path))), Some(main_key.clone()));

        let dirty_item = item_at(&overview, &dirty);
        assert_eq!(dirty_item.dirty, Some(true));
        assert_eq!(dirty_item.untracked, Some(1));
        assert!(dirty_item.recent);

        let locked_item = item_at(&overview, &locked);
        assert!(locked_item.locked);
        assert_eq!(locked_item.status, "ready", "锁定的工作区状态仍然可读");
        assert_eq!(locked_item.dirty, Some(false));

        let gone_item = item_at(&overview, &gone);
        assert!(gone_item.missing);
        assert_eq!(gone_item.status, "missing");
        assert!(gone_item.recent);
        assert!(!gone_item.note.is_empty());
        assert_eq!(gone_item.main_path, None);

        // 总览只读：HEAD 与未跟踪文件都没有被改动或清理。
        assert_eq!(git(&main, &["rev-parse", "HEAD"]), before);
        assert!(dirty.join("scratch.txt").exists());
        assert!(git(&dirty, &["status", "--porcelain"]).contains("scratch.txt"));
    }

    #[tokio::test]
    async fn reports_conflict_ahead_behind_and_keeps_other_items() {
        let fixture = crate::test_support::git_fixture("overview-sync");
        let backend = fixture.backend();
        let main = base_repo(&fixture);
        let origin = fixture.path().join("origin.git");
        git(fixture.path(), &["init", "--bare", repo_key(&origin).as_str()]);
        git(&main, &["remote", "add", "origin", repo_key(&origin).as_str()]);
        git(&main, &["push", "-u", "origin", "main"]);

        // 冲突：同一条路径两侧各改一次后合并，Git 以非零退出留下冲突。
        let conflict = fixture.path().join("conflict");
        git(&main, &["worktree", "add", "-b", "conflict-branch", repo_key(&conflict).as_str()]);
        fs::write(conflict.join("a.txt"), "theirs\n").unwrap();
        git(&conflict, &["commit", "-am", "theirs"]);
        fs::write(main.join("a.txt"), "ours\n").unwrap();
        git(&main, &["commit", "-am", "ours"]);
        // 先把主工作区的提交推上去，后面 ahead/behind 的计数才有确定的起点。
        git(&main, &["push", "origin", "main"]);
        assert!(!git_try(&conflict, &["merge", "main"]), "预期合并冲突");

        // ahead：本地分支比 upstream 多一个提交。
        let ahead = fixture.path().join("ahead");
        git(&main, &["worktree", "add", "-b", "ahead-branch", repo_key(&ahead).as_str(), "origin/main"]);
        git(&ahead, &["branch", "--set-upstream-to=origin/main"]);
        fs::write(ahead.join("b.txt"), "b\n").unwrap();
        git(&ahead, &["add", "--", "b.txt"]);
        git(&ahead, &["commit", "-m", "ahead"]);

        // behind：远端由主工作区推进，behind 自己 fetch 一次（用户动作，不是总览触发）。
        let behind = fixture.path().join("behind");
        git(&main, &["worktree", "add", "-b", "behind-branch", repo_key(&behind).as_str(), "origin/main"]);
        git(&behind, &["branch", "--set-upstream-to=origin/main"]);
        fs::write(main.join("c.txt"), "c\n").unwrap();
        git(&main, &["add", "--", "c.txt"]);
        git(&main, &["commit", "-m", "remote-ahead"]);
        git(&main, &["push", "origin", "main"]);
        git(&behind, &["fetch", "origin"]);

        // 一个普通目录：无法归属，只让这一项失败。
        let plain = fixture.repo("plain");
        let overview =
            worktree_overview(&backend, &[repo_key(&main), repo_key(&plain)], 2).await.unwrap();

        let conflict_item = item_at(&overview, &conflict);
        assert_eq!(conflict_item.status, "ready");
        assert_eq!(conflict_item.conflicted, Some(1));
        assert_eq!(conflict_item.dirty, Some(true));

        let ahead_item = item_at(&overview, &ahead);
        assert_eq!(ahead_item.upstream.as_deref(), Some("origin/main"));
        assert_eq!(ahead_item.ahead, Some(1));
        // 之后主工作区又推了一个提交，共享的 origin/main 跟着前进：这个分支同时落后 1。
        assert_eq!(ahead_item.behind, Some(1));
        assert_eq!(ahead_item.status, "ready");
        // 没有实时核对过远程：界面必须能说「未核」而不是把本地 upstream 当远端真相。
        assert!(!ahead_item.live_remote_checked);
        assert_eq!(ahead_item.remote_checked_at_ms, None);

        let behind_item = item_at(&overview, &behind);
        assert_eq!(behind_item.behind, Some(1));
        assert_eq!(behind_item.ahead, Some(0));

        let plain_item = item_at(&overview, &plain);
        assert!(plain_item.missing);
        assert_eq!(plain_item.status, "missing");
        // 普通目录失败不影响其他工作区继续可读。
        let ready = overview.items.iter().filter(|item| item.status == "ready").count();
        assert_eq!(ready, 4, "{:?}", overview.items);
    }

    #[tokio::test]
    async fn reports_each_entry_when_the_batch_shares_one_recent_path() {
        let fixture = crate::test_support::git_fixture("overview-dedupe");
        let backend = fixture.backend();
        let main = base_repo(&fixture);
        let linked = fixture.path().join("linked");
        git(&main, &["worktree", "add", "-b", "linked-branch", repo_key(&linked).as_str()]);
        // 同一路径重复传入 + 主仓库与附属工作区都在最近列表里：按路径去重。
        let paths = vec![repo_key(&main), repo_key(&linked), repo_key(&main)];
        let overview = worktree_overview(&backend, &paths, 3).await.unwrap();
        assert_eq!(overview.items.len(), 2, "{:?}", overview.items);
        assert!(overview.items.iter().all(|item| item.recent));
        assert_eq!(
            overview.items.iter().filter(|item| item.status == "ready").count(),
            2
        );
    }

    /// 200 超限：超出的项只标未知，不伪造读取时间，其他项照常是真实状态。
    #[tokio::test]
    async fn marks_over_limit_items_unknown_without_fake_check_time() {
        let fixture = crate::test_support::git_fixture("overview-limit");
        let backend = fixture.backend();
        let main = base_repo(&fixture);
        for name in ["one", "two", "three"] {
            let path = fixture.path().join(name);
            let branch = format!("{name}-branch");
            git(&main, &["worktree", "add", "-b", branch.as_str(), repo_key(&path).as_str()]);
        }
        // 预算只够读主仓库加一个工作区：其余两项必须标未知，并且没有「读过」的时间。
        let overview = worktree_overview_with(&backend, &[repo_key(&main)], 1, 2, 8)
            .await
            .unwrap();
        assert_eq!(overview.items.len(), 4, "{:?}", overview.items);

        let ready: Vec<&WorktreeItem> = overview
            .items
            .iter()
            .filter(|item| item.status == "ready")
            .collect();
        assert_eq!(ready.len(), 2, "{:?}", overview.items);
        for item in ready {
            assert_eq!(item.checked_at_ms, Some(overview.checked_at_ms));
            assert!(item.dirty.is_some() && item.changed.is_some());
        }

        let limited: Vec<&WorktreeItem> = overview
            .items
            .iter()
            .filter(|item| item.status == "unknown")
            .collect();
        assert_eq!(limited.len(), 2, "{:?}", overview.items);
        for item in limited {
            assert_eq!(item.checked_at_ms, None, "没读到的项不能带检查时间");
            assert_eq!(item.dirty, None, "没读到的项不能伪装成干净");
            assert_eq!(item.changed, None);
            assert!(item.note.contains("最多读取 2 个"), "{}", item.note);
            // 分支来自权威枚举，仍然可信；不可信的只是未提交状态。
            assert!(item.branch.is_some(), "{:?}", item);
            assert!(item.linked || item.recent);
        }
    }

    /// status 进程失败与解析失败都只让这一项未知，邻居不受影响。
    #[tokio::test]
    async fn marks_status_process_and_parse_failure_as_single_item_unknown() {
        let fixture = crate::test_support::git_fixture("overview-status-failure");
        let backend = fixture.backend();
        let main = base_repo(&fixture);
        let bad = fixture.path().join("bad");
        git(&main, &["worktree", "add", "-b", "bad-branch", repo_key(&bad).as_str()]);
        // 受控夹具：Git 仍然列出这个工作区，但 .git 指向不存在的 gitdir，status 非零退出。
        fs::write(bad.join(".git"), "gitdir: /twiglane-missing-gitdir
").unwrap();

        let overview = worktree_overview_with(&backend, &[repo_key(&main)], 1, 8, 8)
            .await
            .unwrap();
        let failed = item_at(&overview, &bad);
        assert_eq!(failed.status, "unknown");
        assert_eq!(failed.dirty, None, "读取失败不能伪装成干净");
        assert_eq!(failed.changed, None);
        assert_eq!(failed.checked_at_ms, None, "读取失败不能带伪造的检查时间");
        assert!(!failed.note.is_empty());
        assert_eq!(
            failed.branch.as_deref(),
            Some("bad-branch"),
            "分支来自枚举，仍然给出"
        );
        assert_eq!(item_at(&overview, &main).status, "ready", "邻居照旧是真实状态");

        // 解析失败是另一条分支：零退出但读不懂，同样只是这一项未知。
        assert!(
            status_outcome(0, b"this is not porcelain v2\n", b"").is_err(),
            "零退出但读不懂必须是解析失败"
        );
        let process = status_outcome(128, b"", b"fatal: not a git repository\n").unwrap_err();
        assert!(process.contains("not a git repository"), "{process}");
        assert_eq!(
            status_outcome(1, b"", b"").unwrap_err(),
            "无法读取这个工作区的状态。"
        );
    }

    /// 同一主仓库只枚举一次：主仓库与其附属工作区同在最近列表也只花一份预算。
    #[tokio::test]
    async fn enumerates_each_main_once_and_counts_it_into_the_budget() {
        let fixture = crate::test_support::git_fixture("overview-enumerate-budget");
        let backend = fixture.backend();
        let main = base_repo(&fixture);
        let linked = fixture.path().join("linked");
        git(&main, &["worktree", "add", "-b", "linked-branch", repo_key(&linked).as_str()]);

        // 预算只够枚举一个主仓库：主仓库与附属工作区共用同一次枚举，两项都读到状态。
        let overview =
            worktree_overview_with(&backend, &[repo_key(&main), repo_key(&linked)], 1, 8, 1)
                .await
                .unwrap();
        assert_eq!(overview.items.len(), 2, "{:?}", overview.items);
        assert!(
            overview.items.iter().all(|item| item.status == "ready"),
            "{:?}",
            overview.items
        );

        // 另一个主仓库需要自己的一份预算：用完后只让它未知，既不重复枚举也不悄悄省略。
        let other = fixture.repo("other");
        git(&other, &["init", "-b", "main"]);
        fs::write(other.join("b.txt"), "b\n").unwrap();
        git(&other, &["add", "--", "b.txt"]);
        git(&other, &["commit", "-m", "base"]);
        let overview =
            worktree_overview_with(&backend, &[repo_key(&main), repo_key(&other)], 2, 8, 1)
                .await
                .unwrap();
        assert_eq!(item_at(&overview, &main).status, "ready");
        let blocked = item_at(&overview, &other);
        assert_eq!(blocked.status, "unknown");
        assert_eq!(blocked.checked_at_ms, None);
        assert!(blocked.note.contains("最多枚举 1 个"), "{}", blocked.note);
    }
}
