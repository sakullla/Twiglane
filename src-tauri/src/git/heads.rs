//! 不启动 Git，直接读各仓库的 HEAD 文件：仓库切换列表里显示每个仓库当前检出的分支。
//! 只读、限量、出错就返回空，绝不阻塞界面，也不触碰索引或工作区。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::ops::validate_input_path;

/// 一次最多读这么多仓库；最近列表再长，用户也只看得见前面一屏。
const MAX_HEADS: usize = 600;
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
