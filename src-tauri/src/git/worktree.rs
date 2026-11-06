//! 删除 `git worktree add` 建出来的附属工作区。
//!
//! 约束：
//! - 只接受附属工作区；主工作区、子模块、普通目录一律拒绝，绝不退化成删目录；
//! - 删除交给 `git worktree remove`，在主仓库的写锁里执行，参数逐个传入不经过 shell；
//! - 默认不带 `--force`：有未提交改动或未跟踪文件时 Git 拒绝，返回 `worktree_dirty`，
//!   由界面再确认一次才带 `--force`；锁定的工作区（`git worktree lock`）始终拒绝；
//! - 成功后把它移出最近列表，分支本身和提交都保留。

use crate::error::AppError;
use crate::git::command::worktree_remove_command;
use crate::git::heads::{linked_main, resolve_git_dir};
use crate::git::ops::{
    canonical_existing, forget_recent, repo_key, require_git, run_git, validate_input_path, Backend,
};
use crate::git::schedule::JobKind;
use crate::model::RecentRepo;
use crate::redact::redact_error_text;

pub async fn remove_worktree(
    backend: &Backend,
    path: &str,
    force: bool,
    request_id: u64,
) -> Result<Vec<RecentRepo>, AppError> {
    let input = validate_input_path(path)?;
    let root = canonical_existing(&input)?;
    let main = resolve_git_dir(&root)
        .and_then(|git_dir| linked_main(&root, &git_dir))
        .ok_or_else(|| {
            AppError::new(
                "not_worktree",
                "这个目录不是附属工作区（git worktree），未删除任何文件。",
            )
        })?;
    let git = require_git(backend).await?;
    let (program, args) = worktree_remove_command(&git.path, &main, &root, force);
    let scheduled = run_git(
        backend,
        &repo_key(&main),
        JobKind::Write,
        request_id,
        program,
        args,
        None,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        let detail = redact_error_text(String::from_utf8_lossy(&scheduled.output.stderr).trim());
        let lower = detail.to_ascii_lowercase();
        return Err(if lower.contains("locked") {
            AppError::new(
                "worktree_locked",
                "该工作区已被锁定（git worktree lock），未删除。请先在命令行解锁后再试。",
            )
        } else if lower.contains("modified or untracked") {
            AppError::new(
                "worktree_dirty",
                "该工作区有未提交的改动或未跟踪文件，未删除。",
            )
        } else if detail.is_empty() {
            AppError::new("worktree_remove_failed", "Git 没有删除这个工作区。")
        } else {
            AppError::new("worktree_remove_failed", format!("Git 没有删除这个工作区。{detail}"))
        });
    }
    forget_recent(backend, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

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
        assert!(output.status.success(), "{args:?} {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn removes_clean_linked_worktree_and_keeps_branch() {
        let fixture = crate::test_support::git_fixture("wt-remove");
        let backend = fixture.backend();
        let main = fixture.repo("main");
        git(&main, &["init", "-b", "main"]);
        fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "--", "a.txt"]);
        git(&main, &["commit", "-m", "base"]);
        let linked = fixture.path().join("linked");
        git(&main, &["worktree", "add", "-b", "feature", repo_key(&linked).as_str()]);
        let key = repo_key(&canonical_existing(&linked).unwrap());
        backend.store.touch_recent("linked".into(), key.clone()).unwrap();
        backend.store.touch_recent("main".into(), repo_key(&main)).unwrap();

        // 主工作区不是附属工作区，拒绝且不动文件。
        let refused = remove_worktree(&backend, &repo_key(&main), true, 1).await.unwrap_err();
        assert_eq!(refused.code, "not_worktree");
        assert!(main.join("a.txt").exists());

        // 有未跟踪文件时不带 force 被拒绝，文件还在。
        fs::write(linked.join("scratch.txt"), "keep\n").unwrap();
        let dirty = remove_worktree(&backend, &key, false, 2).await.unwrap_err();
        assert_eq!(dirty.code, "worktree_dirty");
        assert!(linked.join("scratch.txt").exists());

        let left = remove_worktree(&backend, &key, true, 3).await.unwrap();
        assert!(!linked.exists());
        assert!(left.iter().all(|repo| repo.path != key));
        assert!(left.iter().any(|repo| repo.path == repo_key(&main)));
        assert_eq!(git(&main, &["branch", "--list", "feature"]), "feature");
        assert!(!git(&main, &["worktree", "list"]).contains("linked"));
    }

    #[tokio::test]
    async fn locked_worktree_is_refused_even_with_force() {
        let fixture = crate::test_support::git_fixture("wt-locked");
        let backend = fixture.backend();
        let main = fixture.repo("main");
        git(&main, &["init", "-b", "main"]);
        fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "--", "a.txt"]);
        git(&main, &["commit", "-m", "base"]);
        let linked = fixture.path().join("locked");
        git(&main, &["worktree", "add", "-b", "held", repo_key(&linked).as_str()]);
        git(&main, &["worktree", "lock", repo_key(&linked).as_str()]);
        let error = remove_worktree(&backend, &repo_key(&linked), true, 1).await.unwrap_err();
        assert_eq!(error.code, "worktree_locked");
        assert!(linked.join("a.txt").exists());
    }
}
