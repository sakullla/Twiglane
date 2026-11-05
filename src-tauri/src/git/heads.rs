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
}

pub fn repo_heads(paths: &[String]) -> Vec<RepoHead> {
    paths.iter().take(MAX_HEADS).map(|path| read_head(path)).collect()
}

fn read_head(path: &str) -> RepoHead {
    let mut head = RepoHead { path: path.to_string(), branch: None, detached: None, missing: false };
    let Ok(root) = validate_input_path(path) else {
        head.missing = true;
        return head;
    };
    let Some(git_dir) = git_dir(&root) else {
        head.missing = true;
        return head;
    };
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
        assert_eq!(read_head(worktree.to_str().unwrap()).branch.as_deref(), Some("wt-branch"));

        let gone = repo.join("does-not-exist");
        assert!(read_head(gone.to_str().unwrap()).missing);
        assert!(read_head("relative/path").missing);

        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&worktree);
    }
}
