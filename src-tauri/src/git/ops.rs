use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::git::command::{
    abbrev_command, git_path_command, head_command, init_command, numstat_command, status_command,
    toplevel_command,
};
use crate::git::gate::{remote_check_is_stale, ActionGate, RemoteChecks};
use crate::git::locate::{detect_git_binary, validate_git, GitLocator, ResolvedGit};
use crate::git::parse::parse_status;
use crate::git::patch::{assign_worktree_numstat, numstat_map, parse_numstat_list};
use crate::git::runner::{ProcessOutput, RealRunner};
use crate::git::schedule::{
    internal_request_id, CommandSpec, GitJob, GitScheduler, JobKind, ScheduledOutput, WriteGuard,
};
use crate::model::{
    ChangeKind, FileChange, GitInfo, LineStat, OpenedRepository, PanelWidths, RecentRepo,
    RepoSummary, SettingsDto, StatusSnapshot, Theme, DEFAULT_ABBREV_LENGTH,
};
use crate::redact::redact_error_text;
use crate::shutdown::Shutdown;
use crate::state::{AppStore, PullIntegration, TerminalPrefs};
use crate::watch::WatchHub;

pub struct Backend {
    pub git: StdMutex<GitLocator>,
    pub scheduler: GitScheduler<RealRunner>,
    pub store: AppStore,
    pub watches: WatchHub,
    pub shutdown: Arc<Shutdown>,
    pub runner: RealRunner,
    pub actions: ActionGate,
    pub remote_checks: RemoteChecks,
    pub(crate) history_files: crate::git::history::CommitFilesCache,
    pub(crate) history_diffs: crate::git::diff_cache::DiffCache,
    pub(crate) text_cursors: Arc<crate::git::text_cursor::TextCursorCache>,
}

impl Backend {
    pub fn new(store: AppStore, runner: RealRunner, shutdown: Arc<Shutdown>) -> Self {
        let locator = GitLocator::from_configured(store.snapshot().git_executable.clone());
        let scheduler = GitScheduler::new(
            runner.clone(),
            shutdown.clone(),
            runner.timeout,
            runner.output_limit,
            runner.extra_env.clone(),
        );
        Self {
            git: StdMutex::new(locator),
            scheduler,
            store,
            watches: WatchHub::new(),
            shutdown,
            runner,
            actions: ActionGate::default(),
            remote_checks: RemoteChecks::default(),
            history_files: crate::git::history::CommitFilesCache::default(),
            history_diffs: crate::git::diff_cache::DiffCache::default(),
            text_cursors: Arc::new(crate::git::text_cursor::TextCursorCache::default()),
        }
    }
}

pub async fn detect_git(backend: &Backend) -> Result<GitInfo, AppError> {
    let configured = lock_git(backend).configured_path();
    let detection = detect_git_binary(&backend.runner, &backend.shutdown, configured.clone()).await;
    Ok(lock_git(backend).apply_detection(configured, detection))
}

pub async fn set_git_executable(backend: &Backend, path: &str) -> Result<GitInfo, AppError> {
    if path.is_empty() {
        return clear_git_executable(backend).await;
    }
    let input = validate_input_path(path)?;
    let resolved = validate_git(&backend.runner, &backend.shutdown, &input).await?;
    let stored = resolved.path.display().to_string();
    backend.store.set_git_executable(Some(stored))?;
    let mut git = lock_git(backend);
    git.set_resolved(resolved);
    Ok(git.info())
}

pub async fn clear_git_executable(backend: &Backend) -> Result<GitInfo, AppError> {
    backend.store.set_git_executable(None)?;
    lock_git(backend).clear_override();
    detect_git(backend).await
}

/// `get_settings` 的返回值。新字段摊平进原有设置，旧前端可以忽略它们。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(flatten)]
    pub settings: SettingsDto,
    pub pull_integration: PullIntegration,
    pub branch_groups: bool,
    pub files_view: bool,
    /// 「创建 MR / PR」开关；旧前端缺这个字段时按关闭处理。
    pub change_requests_enabled: bool,
    /// 终端默认类型与字号。
    pub terminal: TerminalPrefs,
}

pub async fn get_settings(backend: &Backend) -> Result<AppSettings, AppError> {
    let git = detect_git(backend).await?;
    let snapshot = backend.store.snapshot();
    Ok(AppSettings {
        settings: SettingsDto {
            theme: snapshot.theme,
            panel_widths: snapshot.panel_widths,
            git,
            recent: snapshot.recent,
            settings_warning: backend.store.settings_warning(),
        },
        pull_integration: snapshot.pull_integration,
        branch_groups: snapshot.branch_groups,
        files_view: snapshot.files_view,
        change_requests_enabled: snapshot.change_requests_enabled,
        terminal: snapshot.terminal,
    })
}

pub fn set_theme(backend: &Backend, theme: Theme) -> Result<(), AppError> {
    backend.store.set_theme(theme)
}

pub fn set_pull_integration(
    backend: &Backend,
    pull_integration: PullIntegration,
) -> Result<(), AppError> {
    backend.store.set_pull_integration(pull_integration)
}

pub fn set_branch_groups(backend: &Backend, branch_groups: bool) -> Result<(), AppError> {
    backend.store.set_branch_groups(branch_groups)
}

pub fn set_files_view(backend: &Backend, files_view: bool) -> Result<(), AppError> {
    backend.store.set_files_view(files_view)
}

pub fn set_change_requests_enabled(
    backend: &Backend,
    change_requests_enabled: bool,
) -> Result<(), AppError> {
    backend.store.set_change_requests_enabled(change_requests_enabled)
}

/// 「创建 MR / PR」的原生门禁：平台相关命令（T2 的 prepare/create/令牌读写）在进入
/// 平台发现、钥匙串或 HTTP 之前先走这里。关闭时只读持久化开关就返回，不读钥匙串、
/// 不探测远程、不发平台请求；关闭也不删除任何令牌。
// T2 接上平台命令前只有本 Task 的测试调用；cdylib 不把仅测试调用算作可达。
#[allow(dead_code)]
pub fn require_change_requests(backend: &Backend) -> Result<(), AppError> {
    if backend.store.change_requests_enabled() {
        Ok(())
    } else {
        Err(AppError::new(
            "change_requests_disabled",
            "「创建 MR / PR」已关闭，未读取令牌也未发起平台请求。可在设置中启用。",
        ))
    }
}

pub fn set_panel_widths(backend: &Backend, widths: PanelWidths) -> Result<PanelWidths, AppError> {
    let widths = widths.clamped();
    backend.store.set_panel_widths(widths.clone())?;
    Ok(widths)
}

pub fn save_draft(backend: &Backend, path: &str, message: &str) -> Result<(), AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    backend.store.save_draft(&repo_key(&root), message)
}

pub fn forget_recent(backend: &Backend, path: &str) -> Result<Vec<RecentRepo>, AppError> {
    let input = validate_input_path(path)?;
    // 列表里存的是打开时的路径。目录还在时按规范路径删，避免同一仓库留两条；
    // 目录已经不在时解析会失败，这时按用户点到的那条路径删，不能因此拒绝移出列表。
    let mut keys = vec![repo_key(&input)];
    if let Ok(root) = canonical_existing(&input) {
        let canonical = repo_key(&root);
        if !keys.contains(&canonical) {
            keys.push(canonical);
        }
    }
    let mut recent = Vec::new();
    for key in keys {
        recent = backend.store.forget_recent(&key)?;
    }
    Ok(recent)
}

pub fn close_repository(backend: &Backend) {
    backend.watches.stop();
}

pub async fn add_repository(
    backend: &Backend,
    path: &str,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let input = validate_input_path(path)?;
    ensure_directory(&input)?;
    let git = require_git(backend).await?;
    let toplevel = match show_toplevel(backend, &git.path, &input, request_id).await {
        Ok(found) => found,
        Err(Probe::NotRepo) => {
            return Err(AppError::new(
                "not_repository",
                "该目录不是 Git 仓库，未做任何修改。",
            ));
        }
        Err(Probe::Failed(error)) => return Err(error),
    };
    let root = canonical_existing(&toplevel)?;
    open_root(backend, root, request_id.wrapping_add(1)).await
}

pub async fn create_repository(
    backend: &Backend,
    path: &str,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let input = validate_input_path(path)?;
    ensure_directory(&input)?;
    let root = canonical_existing(&input)?;
    if root.join(".git").exists() {
        return Err(AppError::new(
            "git_dir_exists",
            "该目录已有 .git，未重新初始化。",
        ));
    }
    let git = require_git(backend).await?;
    match show_toplevel(backend, &git.path, &root, request_id).await {
        Ok(parent) => {
            let parent = canonical_existing(&parent)?;
            if parent == root {
                return Err(AppError::new(
                    "already_repository",
                    "该目录已经是 Git 仓库，未重新初始化。",
                ));
            }
            return Err(AppError::new(
                "inside_repository",
                "所选目录位于已有仓库内部，未初始化嵌套仓库。",
            ));
        }
        Err(Probe::NotRepo) => {}
        Err(Probe::Failed(error)) => return Err(error),
    }
    let (program, args) = init_command(&git.path, &root);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        request_id.wrapping_add(1),
        program,
        args,
        None,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(git_failure(
            "init_failed",
            &scheduled.output,
            "初始化失败。未删除已有文件。",
        ));
    }
    open_root(backend, root, request_id.wrapping_add(2)).await
}

pub async fn open_repository(
    backend: &Backend,
    path: &str,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    ensure_directory(&root)?;
    if !root.join(".git").exists() {
        return Err(AppError::new(
            "not_repository",
            "该目录不是 Git 仓库，未做任何修改。",
        ));
    }
    open_root(backend, root, request_id).await
}

pub async fn refresh_status(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, &root);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await?;
    status_from_output(backend, &root, &scheduled).await
}

/// 远端写入前的仓库状态令牌（v2 协议）。
///
/// 数值 generation 只是界面侧的仓库代次，agent 进程重启后会从 1 重新开始，它证明不了
/// 客户端读到的就是当前状态。令牌把 HEAD、索引字节、状态条目和每个改动路径的文件身份
/// 摘要在一起；写入前比对令牌即可发现 HEAD、索引或工作树在上次读取之后发生了变化。
// 状态令牌由远端 agent v2 在写入前核对；桌面主窗口在 T6 接入同一入口。库以 cdylib 发布，
// 只有远端消费者用到的入口在这里仍算不可达，按既有约定显式放行。
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub head: Option<String>,
    pub index_digest: String,
    pub worktree_digest: String,
    pub token: String,
}

/// 令牌里最多读取多少个改动文件的内容。超出预算的路径只按大小与修改时间参与摘要，
/// 与 Git 自己判断「文件是否可能变化」的 stat 规则一致。
#[allow(dead_code)]
const TOKEN_CONTENT_BYTES: u64 = 64 * 1024;
#[allow(dead_code)]
const TOKEN_CONTENT_FILES: usize = 256;

#[allow(dead_code)]
pub async fn state_token(
    backend: &Backend,
    root: &Path,
    request_id: u64,
) -> Result<RepoState, AppError> {
    let git = require_git(backend).await?;
    let key = repo_key(root);

    let (program, args) = head_command(&git.path, root);
    let head = run_git(backend, &key, JobKind::Read, request_id, program, args, None).await?;
    let head_oid = (head.output.exit_code == 0)
        .then(|| String::from_utf8_lossy(&head.output.stdout).trim().to_string())
        .filter(|oid| !oid.is_empty());

    let (program, args) = git_path_command(&git.path, root, "index");
    let index = run_git(
        backend,
        &key,
        JobKind::Read,
        request_id,
        program,
        args,
        None,
    )
    .await?;
    let index_digest = if index.output.exit_code == 0 {
        let raw = String::from_utf8_lossy(&index.output.stdout).trim().to_string();
        digest_file(&resolve_repo_path(root, &raw))
    } else {
        "unavailable".to_string()
    };

    let (program, args) = status_command(&git.path, root);
    let status = run_git(
        backend,
        &key,
        JobKind::Read,
        request_id,
        program,
        args,
        None,
    )
    .await?;
    if status.output.exit_code != 0 {
        return Err(git_failure(
            "status_failed",
            &status.output,
            "无法读取仓库状态。",
        ));
    }
    let snapshot = parse_status(&status.output.stdout)?;
    let worktree_digest = digest_worktree(root, &snapshot.files, &status.output.stdout);

    let mut hasher = Sha256::new();
    hasher.update(b"twiglane-repo-state/v2\0");
    hasher.update(head_oid.as_deref().unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(index_digest.as_bytes());
    hasher.update([0]);
    hasher.update(worktree_digest.as_bytes());
    Ok(RepoState {
        head: head_oid,
        index_digest,
        worktree_digest,
        token: hex_digest(hasher),
    })
}

/// `git rev-parse --git-path` 的输出可能相对仓库根（`-C root` 之后的当前目录）。
#[allow(dead_code)]
fn resolve_repo_path(root: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

#[allow(dead_code)]
fn digest_file(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            hex_digest(hasher)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => "absent".to_string(),
        Err(_) => "unreadable".to_string(),
    }
}

/// 状态条目本身加上每个改动路径的文件身份。工作树一侧有改动的路径在预算内直接摘要内容，
/// 因此「大小和修改时间都没变但内容变了」也会得到不同的令牌。
#[allow(dead_code)]
fn digest_worktree(root: &Path, files: &[FileChange], status_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"worktree\0");
    hasher.update(status_bytes);
    let mut ordered: Vec<&FileChange> = files.iter().collect();
    ordered.sort_by(|left, right| left.path.cmp(&right.path));
    let mut content_budget = TOKEN_CONTENT_FILES;
    for file in ordered {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(file.original_path.as_deref().unwrap_or("").as_bytes());
        hasher.update([0]);
        hasher.update(format!("{:?}/{:?}", file.staged, file.unstaged).as_bytes());
        hasher.update([
            u8::from(file.untracked),
            u8::from(file.unmerged),
        ]);
        let changed = file.untracked || file.unmerged || file.unstaged != ChangeKind::None;
        let mut sides = vec![file.path.as_str()];
        if let Some(original) = file.original_path.as_deref() {
            sides.push(original);
        }
        for side in sides {
            match fs::metadata(root.join(side)) {
                Ok(metadata) => {
                    hasher.update(side.as_bytes());
                    hasher.update(metadata.len().to_le_bytes());
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
                            hasher.update(since.as_nanos().to_le_bytes());
                        }
                    }
                    if changed && content_budget > 0 && metadata.len() <= TOKEN_CONTENT_BYTES {
                        content_budget -= 1;
                        if let Ok(bytes) = fs::read(root.join(side)) {
                            hasher.update((bytes.len() as u64).to_le_bytes());
                            hasher.update(&bytes);
                        }
                    }
                }
                Err(_) => hasher.update(side.as_bytes()),
            }
        }
    }
    hex_digest(hasher)
}

#[allow(dead_code)]
fn hex_digest(hasher: Sha256) -> String {
    let digest = hasher.finalize();
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

async fn open_root(
    backend: &Backend,
    root: PathBuf,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, &root);
    // 状态和提交缩写长度互不依赖：并行读，打开仓库少等一个 Git 进程。
    let key = repo_key(&root);
    let (scheduled, abbrev_length) = tokio::join!(
        run_git(
            backend,
            &key,
            JobKind::Read,
            request_id,
            program,
            args,
            None,
        ),
        read_abbrev_length(backend, &git.path, &root),
    );
    let snapshot = status_from_output(backend, &root, &scheduled?).await?;
    let summary = RepoSummary {
        name: repo_name(&root),
        path: repo_key(&root),
    };
    backend
        .store
        .touch_recent(summary.name.clone(), summary.path.clone())?;
    let draft = backend.store.draft(&summary.path);
    let generation = snapshot.generation;
    Ok(OpenedRepository {
        summary,
        generation,
        snapshot,
        draft,
        watch_degraded: false,
        abbrev_length,
    })
}

/// 读取仓库的提交缩写长度。只是显示偏好：空仓库、命令失败或输出异常都退回 7 位，不阻塞打开仓库。
async fn read_abbrev_length(backend: &Backend, git: &Path, root: &Path) -> u8 {
    let (program, args) = abbrev_command(git, root);
    match run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        internal_request_id(),
        program,
        args,
        None,
    )
    .await
    {
        Ok(scheduled) if scheduled.output.exit_code == 0 => {
            parse_abbrev_length(&scheduled.output.stdout)
        }
        _ => DEFAULT_ABBREV_LENGTH,
    }
}

/// `rev-parse --short` 的输出就是缩写本身：长度落在 Git 允许的范围（4–64，含 SHA-256）且全是十六进制才采用。
pub(crate) fn parse_abbrev_length(stdout: &[u8]) -> u8 {
    let text = String::from_utf8_lossy(stdout);
    let abbrev = text.trim();
    if (4..=64).contains(&abbrev.len()) && abbrev.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        abbrev.len() as u8
    } else {
        DEFAULT_ABBREV_LENGTH
    }
}

pub(crate) async fn status_from_output(
    backend: &Backend,
    root: &Path,
    scheduled: &ScheduledOutput,
) -> Result<StatusSnapshot, AppError> {
    if scheduled.output.exit_code != 0 {
        return Err(git_failure(
            "status_failed",
            &scheduled.output,
            "无法读取仓库状态。",
        ));
    }
    let mut snapshot = parse_status(&scheduled.output.stdout)?;
    snapshot.generation = scheduled.generation;
    let repo = repo_key(root);
    let checked_at = backend.remote_checks.get(&repo);
    snapshot.branch.remote_checked_at_ms = checked_at;
    let stale = checked_at.is_some_and(|at| remote_check_is_stale(at, crate::state::now_ms()));
    snapshot.branch.remote_check_stale = stale;
    snapshot.branch.live_remote_checked = checked_at.is_some() && !stale;
    decorate_status(backend, root, &mut snapshot).await;
    Ok(snapshot)
}

fn needs_staged_stats(files: &[FileChange]) -> bool {
    files
        .iter()
        .any(|file| file.unmerged || file.staged != ChangeKind::None)
}

fn needs_unstaged_stats(files: &[FileChange]) -> bool {
    files
        .iter()
        .any(|file| !file.untracked && (file.unmerged || file.unstaged != ChangeKind::None))
}

/// 行数读失败时保持未知，状态本身仍然返回。不在持有写锁时调用。
async fn decorate_status(backend: &Backend, root: &Path, snapshot: &mut StatusSnapshot) {
    if snapshot.files.is_empty() {
        return;
    }
    let Ok(git) = require_git(backend).await else {
        fill_untracked_lines(root, &mut snapshot.files).await;
        return;
    };
    // 两次 numstat 与未跟踪文件数行互不依赖：一起跑，打开和刷新都少等一轮。
    let (staged, unstaged, untracked) = tokio::join!(
        async {
            if needs_staged_stats(&snapshot.files) {
                read_numstat_map(backend, root, &git.path, true, snapshot.generation).await
            } else {
                HashMap::new()
            }
        },
        async {
            if needs_unstaged_stats(&snapshot.files) {
                read_numstat_map(backend, root, &git.path, false, snapshot.generation).await
            } else {
                HashMap::new()
            }
        },
        untracked_line_stats(root, &snapshot.files),
    );
    assign_worktree_numstat(&mut snapshot.files, &staged, &unstaged);
    apply_untracked_lines(&mut snapshot.files, untracked);
    crate::git::sizes::decorate_status_sizes(backend, &git.path, root, snapshot.generation, &mut snapshot.files).await;
}

/// 写锁内补行数。走 guard.run，避免再进调度器造成死锁。
pub(crate) async fn decorate_guard_status(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    snapshot: &mut StatusSnapshot,
) {
    if snapshot.files.is_empty() {
        return;
    }
    let staged = if needs_staged_stats(&snapshot.files) {
        read_numstat_guard(guard, git, root, true).await
    } else {
        HashMap::new()
    };
    let unstaged = if needs_unstaged_stats(&snapshot.files) {
        read_numstat_guard(guard, git, root, false).await
    } else {
        HashMap::new()
    };
    assign_worktree_numstat(&mut snapshot.files, &staged, &unstaged);
    fill_untracked_lines(root, &mut snapshot.files).await;
    crate::git::sizes::decorate_status_sizes_guard(guard, git, root, &mut snapshot.files).await;
}

async fn read_numstat_map(
    backend: &Backend,
    root: &Path,
    git: &Path,
    staged: bool,
    generation: u64,
) -> HashMap<String, LineStat> {
    let (program, args) = numstat_command(git, root, staged);
    let Ok(scheduled) = run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        internal_request_id(),
        program,
        args,
        Some(generation),
    )
    .await
    else {
        return HashMap::new();
    };
    if scheduled.output.exit_code != 0 {
        return HashMap::new();
    }
    numstat_map(parse_numstat_list(&scheduled.output.stdout))
}

async fn read_numstat_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    staged: bool,
) -> HashMap<String, LineStat> {
    let (program, args) = numstat_command(git, root, staged);
    let Ok(output) = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await
    else {
        return HashMap::new();
    };
    if output.exit_code != 0 {
        return HashMap::new();
    }
    numstat_map(parse_numstat_list(&output.stdout))
}

// 状态列表的可选统计不能随导出文件大小无限增长；超预算保持未知，打开差异时再读。
const UNTRACKED_FILE_BYTES: u64 = 2 * 1024 * 1024;
const UNTRACKED_STATUS_BYTES: u64 = 16 * 1024 * 1024;

async fn fill_untracked_lines(root: &Path, files: &mut [FileChange]) {
    let stats = untracked_line_stats(root, files).await;
    apply_untracked_lines(files, stats);
}

/// 未跟踪文件的行数（按字节预算）。只读文件，不改 `files`，可以和 Git 读取并行。
async fn untracked_line_stats(root: &Path, files: &[FileChange]) -> Vec<(usize, Option<LineStat>)> {
    let paths: Vec<_> = files
        .iter()
        .enumerate()
        .filter(|(_, file)| file.untracked)
        .map(|(index, file)| (index, file.path.clone()))
        .collect();
    if paths.is_empty() {
        return Vec::new();
    }
    let root = root.to_path_buf();
    // 文件 I/O 和数行在阻塞线程执行，避免占用异步 Git 调度线程。
    tokio::task::spawn_blocking(move || {
        let mut budget = UNTRACKED_STATUS_BYTES;
        paths
            .into_iter()
            .map(|(index, path)| (index, untracked_line_stat(&root, &path, &mut budget)))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
}

fn apply_untracked_lines(files: &mut [FileChange], stats: Vec<(usize, Option<LineStat>)>) {
    for (index, stat) in stats {
        if let Some(file) = files.get_mut(index) {
            file.unstaged_lines = stat;
        }
    }
}

fn untracked_line_stat(root: &Path, path: &str, budget: &mut u64) -> Option<LineStat> {
    if *budget == 0 {
        return None;
    }
    let relative = safe_relative(path).ok()?;
    let path = root.join(relative);
    let meta = path.symlink_metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut opened = fs::File::open(path).ok()?;
    let mut probe = [0_u8; 8000];
    let mut filled = 0;
    let probe_limit = probe.len().min(*budget as usize);
    while filled < probe_limit {
        match opened.read(&mut probe[filled..probe_limit]) {
            Ok(0) => break,
            Ok(count) => {
                filled += count;
                *budget -= count as u64;
            }
            Err(_) => return None,
        }
    }
    if probe[..filled].contains(&0) {
        return Some(LineStat {
            additions: None,
            deletions: None,
            old_size: None,
            new_size: None,
        });
    }
    if meta.len() > UNTRACKED_FILE_BYTES || meta.len().saturating_sub(filled as u64) > *budget {
        return None;
    }
    let mut newlines = probe[..filled]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count() as u64;
    let mut last = probe[..filled].last().copied();
    let mut rest = [0_u8; 8192];
    let mut read_bytes = filled as u64;
    loop {
        // 多读一字节检测读取期间增长的文件；不返回被截断的行数。
        let limit = rest
            .len()
            .min((UNTRACKED_FILE_BYTES - read_bytes).min(*budget) as usize + 1);
        let count = match opened.read(&mut rest[..limit]) {
            Ok(0) => break,
            Ok(count) => count,
            Err(_) => return None,
        };
        if count as u64 > *budget || read_bytes + count as u64 > UNTRACKED_FILE_BYTES {
            *budget = budget.saturating_sub(count as u64);
            return None;
        }
        *budget -= count as u64;
        read_bytes += count as u64;
        newlines += rest[..count]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count() as u64;
        last = rest[..count].last().copied();
    }
    let additions = if read_bytes == 0 {
        0
    } else if last == Some(b'\n') {
        newlines
    } else {
        newlines + 1
    };
    Some(LineStat {
        additions: Some(additions),
        deletions: Some(0),
        old_size: None,
        new_size: None,
    })
}

#[derive(Debug)]
enum Probe {
    NotRepo,
    Failed(AppError),
}

enum ProbeClass {
    NotRepo,
    Failed(&'static str),
}

async fn show_toplevel(
    backend: &Backend,
    git: &Path,
    path: &Path,
    request_id: u64,
) -> Result<PathBuf, Probe> {
    let (program, args) = toplevel_command(git, path);
    let scheduled = match run_git(
        backend,
        &repo_key(path),
        JobKind::Read,
        request_id,
        program,
        args,
        None,
    )
    .await
    {
        Ok(scheduled) => scheduled,
        Err(error) => return Err(Probe::Failed(error)),
    };
    classify_toplevel(&scheduled.output)
}

fn classify_toplevel(output: &ProcessOutput) -> Result<PathBuf, Probe> {
    if output.exit_code == 0 {
        let found = toplevel_text(&output.stdout);
        if found.is_empty() {
            return Err(Probe::Failed(AppError::new(
                "repository_probe",
                "无法确认仓库根目录，未创建或修改任何文件。",
            )));
        }
        return Ok(PathBuf::from(found));
    }
    match probe_class(&probe_text(output)) {
        ProbeClass::NotRepo => Err(Probe::NotRepo),
        ProbeClass::Failed(code) => Err(Probe::Failed(probe_failure(code, output))),
    }
}

// Git localizes these lines. Only an explicit "not a repository" may allow init.
fn probe_class(text: &str) -> ProbeClass {
    let lower = text.to_ascii_lowercase();
    if has_probe_phrase(
        &lower,
        &[
            "dubious ownership",
            "unsafe repository",
            "safe.directory",
            "可疑的仓库所有权",
        ],
    ) {
        return ProbeClass::Failed("repository_ownership");
    }
    if has_probe_phrase(
        &lower,
        &["permission denied", "operation not permitted", "权限不够"],
    ) {
        return ProbeClass::Failed("permission");
    }
    if has_probe_phrase(
        &lower,
        &[
            "must be run in a work tree",
            "not a working tree",
            "必须在一个工作区中运行",
        ],
    ) {
        return ProbeClass::Failed("not_work_tree");
    }
    if has_probe_phrase(&lower, &["not a git repository", "不是 git 仓库"]) {
        return ProbeClass::NotRepo;
    }
    ProbeClass::Failed("repository_probe")
}

fn has_probe_phrase(haystack: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| haystack.contains(phrase))
}

fn probe_failure(code: &str, output: &ProcessOutput) -> AppError {
    let fallback = match code {
        "repository_ownership" => "Git 因仓库所有权拒绝读取，未创建或修改任何文件。",
        "permission" => "Git 因权限拒绝读取，未创建或修改任何文件。",
        "not_work_tree" => "该路径不是 Git 工作区，未创建或修改任何文件。",
        _ => "无法确认该目录是否为 Git 仓库，未创建或修改任何文件。",
    };
    let detail = redact_error_text(command_detail(output).trim());
    if detail.is_empty() {
        AppError::new(code, fallback)
    } else {
        AppError::new(code, format!("{fallback} {detail}"))
    }
}

fn probe_text(output: &ProcessOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

fn command_detail(output: &ProcessOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn toplevel_text(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0 || *byte == b'\n')
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

pub(crate) async fn run_git(
    backend: &Backend,
    repo_key: &str,
    kind: JobKind,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
    generation: Option<u64>,
) -> Result<ScheduledOutput, AppError> {
    run_git_job(backend, repo_key, kind, request_id, program, args, generation, false).await
}

/// 访问远程的命令：用户可以通过 cancel_remote 中途取消。
pub(crate) async fn run_remote_git(
    backend: &Backend,
    repo_key: &str,
    kind: JobKind,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
    generation: Option<u64>,
) -> Result<ScheduledOutput, AppError> {
    run_git_job(backend, repo_key, kind, request_id, program, args, generation, true).await
}

#[allow(clippy::too_many_arguments)]
async fn run_git_job(
    backend: &Backend,
    repo_key: &str,
    kind: JobKind,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
    generation: Option<u64>,
    remote: bool,
) -> Result<ScheduledOutput, AppError> {
    let mut attempt = 0_u64;
    let mut current = generation.unwrap_or_else(|| backend.scheduler.current_generation(repo_key));
    loop {
        let job = GitJob {
            repo_key: repo_key.to_string(),
            kind,
            request_id: request_id.wrapping_add(attempt),
            generation: current,
            program: program.clone(),
            args: args.clone(),
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            env: Vec::new(),
        };
        let result = if remote {
            backend.scheduler.execute_remote(job).await
        } else {
            backend.scheduler.execute(job).await
        };
        match result {
            Err(error) if error.code == "stale" && generation.is_none() && attempt < 2 => {
                current = error
                    .generation
                    .unwrap_or_else(|| backend.scheduler.current_generation(repo_key));
                attempt += 1;
            }
            other => return other,
        }
    }
}

pub(crate) async fn require_git(backend: &Backend) -> Result<ResolvedGit, AppError> {
    if let Some(resolved) = lock_git(backend).resolved().cloned() {
        return Ok(resolved);
    }
    let info = detect_git(backend).await?;
    if !info.available {
        return Err(AppError::new("git_missing", info.message));
    }
    lock_git(backend).resolved().cloned().ok_or_else(|| {
        AppError::new(
            "git_missing",
            "未检测到 Git。请安装 Git 或选择可执行文件后重试。",
        )
    })
}

fn lock_git(backend: &Backend) -> std::sync::MutexGuard<'_, GitLocator> {
    backend
        .git
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

pub fn validate_input_path(path: &str) -> Result<PathBuf, AppError> {
    if path.is_empty() || path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err(AppError::new(
            "invalid_path",
            "路径无效，未创建或修改任何文件。",
        ));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::new(
            "invalid_path",
            "需要绝对路径，未创建或修改任何文件。",
        ));
    }
    Ok(path)
}

pub fn safe_relative(path: &str) -> Result<PathBuf, AppError> {
    if path.is_empty() || path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err(AppError::new(
            "invalid_path",
            "该路径无法安全读取，未修改仓库。",
        ));
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(AppError::new("invalid_path", "差异路径必须留在仓库内部。"));
    }
    Ok(relative.to_path_buf())
}

pub(crate) fn ensure_directory(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::new(
            "path_missing",
            "路径不存在，未创建或修改任何文件。",
        ));
    }
    if !path.is_dir() {
        return Err(AppError::new(
            "not_directory",
            "所选路径不是目录，原文件保持不变。",
        ));
    }
    match fs::read_dir(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => Err(AppError::new(
            "permission",
            "无法读取该目录，未修改其中的文件。",
        )),
        Err(error) => Err(AppError::new(
            "path_unreadable",
            format!(
                "无法读取该目录，未修改其中的文件。{}",
                redact_error_text(&error.to_string())
            ),
        )),
    }
}

pub fn canonical_existing(path: &Path) -> Result<PathBuf, AppError> {
    dunce::canonicalize(path).map_err(|error| {
        AppError::new(
            "path_unreadable",
            format!(
                "无法解析路径，未修改文件。{}",
                redact_error_text(&error.to_string())
            ),
        )
    })
}

pub fn repo_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn repo_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| repo_key(path))
}

pub(crate) fn git_failure(code: &str, output: &ProcessOutput, fallback: &str) -> AppError {
    let detail = redact_error_text(String::from_utf8_lossy(&output.stderr).trim());
    if detail.is_empty() {
        AppError::new(code, fallback)
    } else {
        AppError::new(code, format!("{fallback} {detail}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::process::Command;

    use crate::git::runner::ProcessOutput;
    use crate::state::AppStore;

    #[test]
    fn untracked_stats_are_exact_within_budget_and_unknown_beyond_it() {
        let dir = crate::test_support::TempDir::new("untracked-stats-budget");
        for (name, bytes, expected) in [
            ("empty", &b""[..], 0),
            ("lines", &b"one\r\ntwo\n"[..], 2),
            ("no-newline", &b"one\ntwo"[..], 2),
        ] {
            fs::write(dir.path().join(name), bytes).unwrap();
            let mut budget = bytes.len() as u64 + 1;
            let stats = untracked_line_stat(dir.path(), name, &mut budget).unwrap();
            assert_eq!(stats.additions, Some(expected));
            assert_eq!(stats.deletions, Some(0));
            assert_eq!(budget, 1);
        }
        fs::write(dir.path().join("binary"), b"a\0b").unwrap();
        let mut budget = 3;
        assert_eq!(untracked_line_stat(dir.path(), "binary", &mut budget).unwrap().additions, None);
        assert_eq!(budget, 0);
        assert!(untracked_line_stat(dir.path(), "lines", &mut budget).is_none());

        let large = vec![b'x'; UNTRACKED_FILE_BYTES as usize + 1];
        fs::write(dir.path().join("large"), &large).unwrap();
        let mut budget = UNTRACKED_STATUS_BYTES;
        assert!(untracked_line_stat(dir.path(), "large", &mut budget).is_none());
        assert_eq!(UNTRACKED_STATUS_BYTES - budget, 8000);
        fs::write(dir.path().join("boundary"), &large[..UNTRACKED_FILE_BYTES as usize]).unwrap();
        let mut budget = UNTRACKED_FILE_BYTES;
        assert_eq!(untracked_line_stat(dir.path(), "boundary", &mut budget).unwrap().additions, Some(1));
        assert_eq!(budget, 0);
        let mut budget = 2;
        assert!(untracked_line_stat(dir.path(), "lines", &mut budget).is_none());
        assert_eq!(budget, 0);
        assert!(untracked_line_stat(dir.path(), ".", &mut 100).is_none());
        assert!(untracked_line_stat(dir.path(), "../outside", &mut 100).is_none());
    }

    #[tokio::test]
    async fn add_does_not_modify_invalid_paths_and_create_is_explicit() {
        let fixture = crate::test_support::git_fixture("repo-safety");
        let backend = fixture.backend();
        let missing = fixture.path().join("missing-dir");
        let missing_error = add_repository(&backend, &repo_key(&missing), 1)
            .await
            .unwrap_err();
        assert_eq!(missing_error.code, "path_missing");
        assert!(!missing.exists());

        let file_path = fixture.path().join("plain.txt");
        fs::write(&file_path, b"keep").unwrap();
        let before = fs::read(&file_path).unwrap();
        let file_error = add_repository(&backend, &repo_key(&file_path), 2)
            .await
            .unwrap_err();
        assert_eq!(file_error.code, "not_directory");
        assert_eq!(fs::read(&file_path).unwrap(), before);

        let plain = fixture.path().join("plain-dir");
        fs::create_dir(&plain).unwrap();
        let keep = plain.join("keep.txt");
        fs::write(&keep, b"same").unwrap();
        let modified = fs::metadata(&keep).unwrap().modified().unwrap();
        let add_error = add_repository(&backend, &repo_key(&plain), 3)
            .await
            .unwrap_err();
        assert_eq!(add_error.code, "not_repository");
        assert!(!plain.join(".git").exists());
        assert_eq!(fs::read(&keep).unwrap(), b"same");
        assert_eq!(fs::metadata(&keep).unwrap().modified().unwrap(), modified);

        let newline = add_repository(&backend, "/tmp/bad\npath", 4)
            .await
            .unwrap_err();
        assert_eq!(newline.code, "invalid_path");
        assert!(safe_relative("a\nb").is_err());
        assert!(safe_relative("../outside").is_err());

        let created = create_repository(&backend, &repo_key(&plain), 5)
            .await
            .unwrap();
        assert!(plain.join(".git").is_dir());
        assert_eq!(fs::read(&keep).unwrap(), b"same");
        assert_eq!(created.summary.name, "plain-dir");
        assert!(created.snapshot.branch.unborn || created.snapshot.branch.name.is_some());
        assert!(!created.snapshot.branch.live_remote_checked);

        let again = create_repository(&backend, &created.summary.path, 8)
            .await
            .unwrap_err();
        assert_eq!(again.code, "git_dir_exists");

        let nested = plain.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_error = create_repository(&backend, &repo_key(&nested), 9)
            .await
            .unwrap_err();
        assert_eq!(nested_error.code, "inside_repository");
        assert!(!nested.join(".git").exists());
    }

    #[tokio::test]
    async fn opens_real_repository_and_keeps_same_names_distinct() {
        let fixture = crate::test_support::git_fixture("repo-open");
        let backend = fixture.backend();
        let first = fixture.repo("demo");
        let second = fixture.repo("demo");
        fs::create_dir_all(first.join("sub")).unwrap();
        run_git_ok(&first, &["init", "-b", "main"]);
        fs::write(first.join("sub").join("说明.txt"), "你好\n").unwrap();
        fs::write(first.join("file one.txt"), "before\n").unwrap();
        run_git_ok(&first, &["add", "--", "file one.txt", "sub/说明.txt"]);
        run_git_ok(&first, &["commit", "-m", "init"]);
        fs::write(first.join("file one.txt"), "before\nafter\n").unwrap();
        fs::write(second.join("keep.txt"), b"untouched").unwrap();
        run_git_ok(&second, &["init", "-b", "main"]);

        let opened = add_repository(&backend, &repo_key(&first.join("sub")), 1)
            .await
            .unwrap();
        assert_eq!(
            opened.summary.path,
            repo_key(&canonical_existing(&first).unwrap())
        );
        assert_eq!(opened.snapshot.branch.name.as_deref(), Some("main"));
        assert!(opened
            .snapshot
            .files
            .iter()
            .any(|file| file.path == "file one.txt"));
        let diff = crate::git::changes::load_diff(
            &backend,
            &opened.summary.path,
            "file one.txt",
            None,
            false,
            opened.generation,
            2,
            0,
            0,
        )
        .await
        .unwrap();
        let text = diff.text.unwrap();
        assert!(text.contains("+after"));
        assert!(!diff.binary);

        let other = add_repository(&backend, &repo_key(&second), 3)
            .await
            .unwrap();
        assert_ne!(opened.summary.path, other.summary.path);
        assert_eq!(opened.summary.name, other.summary.name);
        // 缩写长度跟 Git 一致：有提交的仓库按 core.abbrev（小仓库自动长度为 7），空仓库退回 7。
        assert_eq!(opened.abbrev_length, 7);
        assert_eq!(other.abbrev_length, DEFAULT_ABBREV_LENGTH);
        run_git_ok(&first, &["config", "core.abbrev", "12"]);
        let longer = add_repository(&backend, &repo_key(&first), 4)
            .await
            .unwrap();
        assert_eq!(longer.abbrev_length, 12);
        let recent = backend.store.snapshot().recent;
        assert_eq!(recent.len(), 2);
        assert_eq!(fs::read(second.join("keep.txt")).unwrap(), b"untouched");

        backend
            .store
            .save_draft(&opened.summary.path, "第一份草稿")
            .unwrap();
        backend
            .store
            .save_draft(&other.summary.path, "第二份草稿")
            .unwrap();
        let reloaded = AppStore::open(backend.store.path().to_path_buf());
        assert_eq!(reloaded.draft(&opened.summary.path), "第一份草稿");
        assert_eq!(reloaded.draft(&other.summary.path), "第二份草稿");
    }

    #[test]
    fn abbrev_length_accepts_only_hex_abbreviations_in_git_range() {
        assert_eq!(parse_abbrev_length(b"1a2b3c4
"), 7);
        assert_eq!(parse_abbrev_length(b"1a2b3c4d5e6f
"), 12);
        assert_eq!(parse_abbrev_length(&[b'a'; 64]), 64);
        assert_eq!(parse_abbrev_length(b""), DEFAULT_ABBREV_LENGTH);
        assert_eq!(parse_abbrev_length(b"abc"), DEFAULT_ABBREV_LENGTH);
        assert_eq!(parse_abbrev_length(b"fatal: bad"), DEFAULT_ABBREV_LENGTH);
        assert_eq!(parse_abbrev_length(&[b'a'; 65]), DEFAULT_ABBREV_LENGTH);
    }

    fn run_git_ok(dir: &Path, args: &[&str]) {
        let git = crate::test_support::system_git();
        let status = Command::new(git)
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }

    fn extra_env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(key, value)| (OsString::from(*key), OsString::from(*value)))
            .collect()
    }

    fn git_output(exit_code: i32, stderr: &[u8]) -> ProcessOutput {
        ProcessOutput {
            exit_code,
            stdout: Vec::new(),
            stderr: stderr.to_vec(),
            stdout_truncated: false,
        }
    }

    #[test]
    fn only_confirmed_non_repositories_allow_initialization() {
        let not_repo = git_output(
            128,
            b"fatal: not a git repository (or any of the parent directories): .git\n",
        );
        assert!(matches!(
            super::classify_toplevel(&not_repo),
            Err(super::Probe::NotRepo)
        ));
        let chinese = git_output(
            128,
            "致命错误：不是 git 仓库（或者任何父目录）：.git\n".as_bytes(),
        );
        assert!(matches!(
            super::classify_toplevel(&chinese),
            Err(super::Probe::NotRepo)
        ));

        let owned = git_output(
            128,
            b"fatal: detected dubious ownership in repository at '/tmp/repo'\n\tgit config --global --add safe.directory /tmp/repo\n",
        );
        match super::classify_toplevel(&owned) {
            Err(super::Probe::Failed(error)) => {
                assert_eq!(error.code, "repository_ownership");
                assert!(error.message.contains("dubious ownership"));
                assert!(!error.message.contains("不是 Git 仓库"));
            }
            other => panic!("ownership probe was not rejected: {other:?}"),
        }
        let owned_zh = git_output(
            128,
            "致命错误：在 '/tmp/repo' 检测到可疑的仓库所有权\n\tgit config --global --add safe.directory /tmp/repo\n"
                .as_bytes(),
        );
        match super::classify_toplevel(&owned_zh) {
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "repository_ownership"),
            other => panic!("{other:?}"),
        }

        let bare = git_output(128, b"fatal: this operation must be run in a work tree\n");
        match super::classify_toplevel(&bare) {
            Err(super::Probe::Failed(error)) => {
                assert_eq!(error.code, "not_work_tree");
                assert!(error.message.contains("work tree"));
            }
            other => panic!("{other:?}"),
        }
        let bare_zh = git_output(128, "致命错误：该操作必须在一个工作区中运行\n".as_bytes());
        match super::classify_toplevel(&bare_zh) {
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "not_work_tree"),
            other => panic!("{other:?}"),
        }

        let denied = git_output(
            128,
            b"fatal: cannot change to '/tmp/locked': Permission denied\n",
        );
        match super::classify_toplevel(&denied) {
            Err(super::Probe::Failed(error)) => {
                assert_eq!(error.code, "permission");
                assert!(error
                    .message
                    .to_ascii_lowercase()
                    .contains("permission denied"));
            }
            other => panic!("{other:?}"),
        }

        let unknown = git_output(128, b"fatal: something unexpected\n");
        match super::classify_toplevel(&unknown) {
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "repository_probe"),
            other => panic!("{other:?}"),
        }
        let empty = git_output(0, b"");
        match super::classify_toplevel(&empty) {
            Err(super::Probe::NotRepo) => {
                panic!("empty success was treated as a missing repository")
            }
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "repository_probe"),
            Ok(path) => panic!("empty success returned {}", path.display()),
        }

        let secret = git_output(
            128,
            b"fatal: detected dubious ownership in repository at '/tmp/ghp_abcdefghijklmnopqrstuvwxyz1234'\n",
        );
        match super::classify_toplevel(&secret) {
            Err(super::Probe::Failed(error)) => {
                assert!(!error.message.contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));
                assert!(error.message.contains("dubious ownership"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_failures_do_not_initialize_a_nested_repository() {
        let fixture = crate::test_support::git_fixture("probe-guard");
        let owned = fixture.repo("owned");
        fs::write(owned.join("keep.txt"), b"keep").unwrap();
        run_git_ok(&owned, &["init", "-b", "main"]);
        let ownership =
            fixture.backend_with_extra_env(extra_env(&[("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1")]));
        let added = add_repository(&ownership, &repo_key(&owned), 1)
            .await
            .unwrap_err();
        assert_eq!(added.code, "repository_ownership");
        assert!(
            added.message.contains("dubious ownership") || added.message.contains("safe.directory"),
            "{}",
            added.message
        );
        assert!(!added.message.contains("不是 Git 仓库"));
        assert_eq!(fs::read(owned.join("keep.txt")).unwrap(), b"keep");
        assert!(owned.join(".git").is_dir());

        let child = owned.join("child");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("keep.txt"), b"child").unwrap();
        let created = create_repository(&ownership, &repo_key(&child), 2)
            .await
            .unwrap_err();
        assert_eq!(created.code, "repository_ownership");
        assert!(!created.message.contains("不是 Git 仓库"));
        assert!(!child.join(".git").exists());
        assert_eq!(fs::read(child.join("keep.txt")).unwrap(), b"child");

        let normal = fixture.backend();
        let opened = add_repository(&normal, &repo_key(&owned), 3).await.unwrap();
        assert_eq!(opened.snapshot.branch.name.as_deref(), Some("main"));

        let bare = fixture.path().join("bare.git");
        run_git_ok(fixture.path(), &["init", "--bare", "bare.git"]);
        let head = fs::read(bare.join("HEAD")).unwrap();
        let bare_add = add_repository(&normal, &repo_key(&bare), 4)
            .await
            .unwrap_err();
        assert_eq!(bare_add.code, "not_work_tree");
        assert!(
            bare_add.message.to_ascii_lowercase().contains("work tree")
                || bare_add.message.contains("工作区")
        );
        assert!(!bare_add.message.contains("不是 Git 仓库"));
        assert!(!bare.join(".git").exists());
        assert_eq!(fs::read(bare.join("HEAD")).unwrap(), head);
        let bare_create = create_repository(&normal, &repo_key(&bare), 5)
            .await
            .unwrap_err();
        assert_ne!(bare_create.code, "not_repository");
        assert!(!bare.join(".git").exists());
        assert_eq!(fs::read(bare.join("HEAD")).unwrap(), head);
    }

    #[tokio::test]
    async fn localized_probe_keeps_explicit_create_and_blocks_nested_init() {
        let fixture = crate::test_support::git_fixture("probe-locale");
        let backend = fixture.backend_with_extra_env(extra_env(&[
            ("LC_ALL", "zh_CN.UTF-8"),
            ("LANG", "zh_CN.UTF-8"),
        ]));
        let plain = fixture.path().join("plain-dir");
        fs::create_dir(&plain).unwrap();
        fs::write(plain.join("keep.txt"), b"same").unwrap();
        let missing = add_repository(&backend, &repo_key(&plain), 1)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "not_repository");
        assert!(!plain.join(".git").exists());
        let created = create_repository(&backend, &repo_key(&plain), 2)
            .await
            .unwrap();
        assert!(plain.join(".git").is_dir());
        assert_eq!(fs::read(plain.join("keep.txt")).unwrap(), b"same");
        assert!(created.snapshot.branch.unborn || created.snapshot.branch.name.is_some());
        let nested = plain.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_error = create_repository(&backend, &repo_key(&nested), 5)
            .await
            .unwrap_err();
        assert_eq!(nested_error.code, "inside_repository");
        assert!(!nested.join(".git").exists());

        let owned = fixture.repo("owned");
        fs::write(owned.join("keep.txt"), b"keep").unwrap();
        run_git_ok(&owned, &["init", "-b", "main"]);
        let ownership = fixture.backend_with_extra_env(extra_env(&[
            ("LC_ALL", "zh_CN.UTF-8"),
            ("LANG", "zh_CN.UTF-8"),
            ("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1"),
        ]));
        let child = owned.join("child");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("keep.txt"), b"child").unwrap();
        let blocked = create_repository(&ownership, &repo_key(&child), 6)
            .await
            .unwrap_err();
        assert_ne!(blocked.code, "not_repository");
        assert!(!blocked.message.contains("不是 Git 仓库"));
        assert!(!child.join(".git").exists());
        assert_eq!(fs::read(child.join("keep.txt")).unwrap(), b"child");

        let bare = fixture.path().join("bare.git");
        run_git_ok(fixture.path(), &["init", "--bare", "bare.git"]);
        let bare_add = add_repository(&backend, &repo_key(&bare), 7)
            .await
            .unwrap_err();
        assert_eq!(bare_add.code, "not_work_tree");
        assert!(!bare.join(".git").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_directory_probe_is_permission_and_does_not_init() {
        use std::os::unix::fs::PermissionsExt;
        // root 绕过目录权限检查，无法制造不可读目录（容器与部分 CI 以 root 运行）。
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let fixture = crate::test_support::git_fixture("probe-permission");
        let backend = fixture.backend();
        let locked = fixture.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("keep.txt"), b"perm").unwrap();
        let info = detect_git(&backend).await.unwrap();
        let git = PathBuf::from(info.path.expect("git"));
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o0);
        fs::set_permissions(&locked, perms).unwrap();
        struct Reset(PathBuf);
        impl Drop for Reset {
            fn drop(&mut self) {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&self.0) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&self.0, perms);
                }
            }
        }
        let _reset = Reset(locked.clone());
        let error = match super::show_toplevel(&backend, &git, &locked, 1).await {
            Err(super::Probe::Failed(error)) => error,
            Err(super::Probe::NotRepo) => {
                panic!("permission failure was treated as a missing repository")
            }
            Ok(path) => panic!("unexpected toplevel {}", path.display()),
        };
        let created = create_repository(&backend, &repo_key(&locked), 2)
            .await
            .unwrap_err();
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&locked, perms).unwrap();
        assert_eq!(error.code, "permission");
        assert!(error
            .message
            .to_ascii_lowercase()
            .contains("permission denied"));
        assert_eq!(created.code, "permission");
        assert!(!locked.join(".git").exists());
        assert_eq!(fs::read(locked.join("keep.txt")).unwrap(), b"perm");
    }

    #[tokio::test]
    async fn recorded_divergence_uses_non_negative_counts() {
        let fixture = crate::test_support::git_fixture("divergence");
        let backend = fixture.backend();
        let origin = fixture.repo("origin");
        run_git_ok(&origin, &["init", "-b", "main"]);
        fs::write(origin.join("file.txt"), "base\n").unwrap();
        run_git_ok(&origin, &["add", "--", "file.txt"]);
        run_git_ok(&origin, &["commit", "-m", "base"]);
        let work = fixture.path().join("work");
        let origin_path = repo_key(&origin);
        run_git_ok(fixture.path(), &["clone", origin_path.as_str(), "work"]);
        fs::write(work.join("file.txt"), "base\nlocal\n").unwrap();
        run_git_ok(&work, &["commit", "-am", "local"]);
        fs::write(origin.join("file.txt"), "base\nupstream\n").unwrap();
        run_git_ok(&origin, &["commit", "-am", "upstream"]);
        run_git_ok(&work, &["fetch", "origin"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        assert_eq!(opened.snapshot.branch.ahead, Some(1));
        assert_eq!(opened.snapshot.branch.behind, Some(1));
        assert!(!opened.snapshot.branch.live_remote_checked);
    }

    #[test]
    fn forget_recent_removes_a_deleted_directory_without_touching_others() {
        let fixture = crate::test_support::git_fixture("forget-missing");
        let backend = fixture.backend();
        let gone_dir = fixture.path().join("gone-repo");
        fs::create_dir(&gone_dir).unwrap();
        let gone = repo_key(&canonical_existing(&gone_dir).unwrap());
        fs::remove_dir(&gone_dir).unwrap();
        assert!(!gone_dir.exists());
        let kept_dir = fixture.path().join("kept-repo");
        fs::create_dir(&kept_dir).unwrap();
        let kept = repo_key(&canonical_existing(&kept_dir).unwrap());
        backend.store.touch_recent("gone".into(), gone.clone()).unwrap();
        backend.store.touch_recent("kept".into(), kept.clone()).unwrap();

        let left = forget_recent(&backend, &gone).unwrap();
        assert!(left.iter().all(|repo| repo.path != gone));
        assert!(left.iter().any(|repo| repo.path == kept));
        assert!(kept_dir.exists());

        let messy = format!("{}/.", kept_dir.display());
        let after = forget_recent(&backend, &messy).unwrap();
        assert!(after.iter().all(|repo| repo.path != kept));
        assert!(kept_dir.exists());

        let invalid = forget_recent(&backend, "relative/nope").unwrap_err();
        assert_eq!(invalid.code, "invalid_path");
    }

    #[tokio::test]
    async fn settings_report_change_requests_switch_off_by_default() {
        let fixture = crate::test_support::git_fixture("change-request-settings");
        let backend = fixture.backend();
        let settings = get_settings(&backend).await.unwrap();
        assert!(!settings.change_requests_enabled);
        // 与前端约定的 camelCase 字段名，旧前端缺这个字段时按关闭处理。
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["changeRequestsEnabled"], false);
        assert_eq!(json["branchGroups"], true);

        set_change_requests_enabled(&backend, true).unwrap();
        let settings = get_settings(&backend).await.unwrap();
        assert!(settings.change_requests_enabled);
        assert_eq!(
            serde_json::to_value(&settings).unwrap()["changeRequestsEnabled"],
            true
        );
    }

    #[test]
    fn change_request_gate_rejects_while_disabled_without_writing_state() {
        let fixture = crate::test_support::git_fixture("change-request-gate");
        let backend = fixture.backend();
        let state_path = backend.store.path().to_path_buf();
        let before = fs::read(&state_path).ok();

        let error = require_change_requests(&backend).unwrap_err();
        assert_eq!(error.code, "change_requests_disabled");
        assert!(error.message.contains("已关闭"));
        // 门禁只读开关：被拒时既不写设置，也没有平台侧动作可发生（T2 才接命令）。
        assert_eq!(fs::read(&state_path).ok(), before);

        backend.store.set_change_requests_enabled(true).unwrap();
        require_change_requests(&backend).unwrap();
        // 关闭后门禁重新生效；关闭本身不删除令牌由 T2 的钥匙串测试覆盖。
        backend.store.set_change_requests_enabled(false).unwrap();
        assert_eq!(
            require_change_requests(&backend).unwrap_err().code,
            "change_requests_disabled"
        );
    }

    /// 状态令牌要能区分 HEAD、索引与工作树真实内容，而不是只跟着数值 generation 走。
    #[tokio::test]
    async fn state_token_tracks_head_index_and_worktree_content() {
        let fixture = crate::test_support::git_fixture("state-token");
        let backend = fixture.backend();
        let repo = fixture.repo("repo");
        run_git_ok(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("note.txt"), "one\n").unwrap();
        run_git_ok(&repo, &["add", "--", "note.txt"]);
        run_git_ok(&repo, &["commit", "-m", "init"]);

        let opened = open_repository(&backend, &repo_key(&repo), 1).await.unwrap();
        let root = PathBuf::from(&opened.summary.path);
        let before = state_token(&backend, &root, 2).await.unwrap();

        // 同样的输入必须得到同样的令牌，否则写入前的比对会误判。
        let again = state_token(&backend, &root, 3).await.unwrap();
        assert_eq!(before, again);
        assert!(before.head.is_some());
        assert_ne!(before.index_digest, "absent");

        // 内容变了但大小、修改时间都没变：只有摘要内容才能发现。
        let mut same_size = fs::read(repo.join("note.txt")).unwrap();
        same_size[0] = b't';
        fs::write(repo.join("note.txt"), &same_size).unwrap();
        let edited = state_token(&backend, &root, 4).await.unwrap();
        assert_ne!(before.token, edited.token);
        assert_ne!(before.worktree_digest, edited.worktree_digest);

        // 暂存区变化（索引字节）同样换令牌，HEAD 不变。
        run_git_ok(&repo, &["add", "--", "note.txt"]);
        let staged = state_token(&backend, &root, 5).await.unwrap();
        assert_ne!(edited.token, staged.token);
        assert_ne!(edited.index_digest, staged.index_digest);
        assert_eq!(edited.head, staged.head);

        // 提交推进 HEAD。
        run_git_ok(
            &repo,
            &["commit", "-m", "edit", "--no-verify", "--allow-empty-message"],
        );
        let committed = state_token(&backend, &root, 6).await.unwrap();
        assert_ne!(staged.token, committed.token);
        assert_ne!(staged.head, committed.head);
    }
}