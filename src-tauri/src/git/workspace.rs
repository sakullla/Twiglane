//! 工作区里的文件级便捷动作：在系统文件管理器中显示、用默认程序打开、加入忽略规则。
//!
//! 约束与其它写操作一致：
//! - 路径只接受仓库内的相对路径（不含 `..`、绝对路径或控制字符），解析后必须仍在仓库根目录下；
//! - 打开外部程序不经过 shell，参数逐个传入（Windows `explorer.exe`、macOS `open`、Linux `xdg-open`）；
//! - 改写 .gitignore 或 `.git/info/exclude` 走仓库写锁，完成后 generation 递增，过期的响应照常被拒绝；
//!   写入用临时文件替换，原文件末尾缺换行时先补一个，已存在的同一条规则不重复追加。
//!   本地排除先用 `git rev-parse --git-path info/exclude` 定位，失败时两个文件都保持原样。

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::atomic::atomic_write;
use crate::error::AppError;
use crate::git::command::{git_path_command, ls_files_command};
use crate::git::ops::{
    canonical_existing, repo_key, require_git, run_git, safe_relative, validate_input_path, Backend,
};
use crate::git::schedule::{internal_request_id, JobKind};

const MAX_PATTERN_LEN: usize = 1024;

fn repo_root(path: &str) -> Result<PathBuf, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    if !root.join(".git").exists() {
        return Err(AppError::new(
            "not_repository",
            "该目录不是 Git 仓库，未执行此操作。",
        ));
    }
    Ok(root)
}

/// 仓库内的目标：文件已被删除时退回到仍存在的最近一级目录。
fn resolve_inside(root: &Path, relative: &str) -> Result<(PathBuf, bool), AppError> {
    let relative = if relative.is_empty() {
        PathBuf::new()
    } else {
        safe_relative(relative)?
    };
    let mut candidate = root.join(&relative);
    let mut exact = true;
    while !candidate.exists() {
        exact = false;
        if !candidate.pop() || !candidate.starts_with(root) {
            candidate = root.to_path_buf();
            break;
        }
    }
    let resolved = canonical_existing(&candidate)?;
    if !resolved.starts_with(root) {
        return Err(AppError::new(
            "invalid_path",
            "只能打开仓库内部的文件，未执行。",
        ));
    }
    Ok((resolved, exact))
}

fn spawn(program: &str, args: &[&std::ffi::OsStr]) -> Result<(), AppError> {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            AppError::new(
                "open_failed",
                format!(
                    "没有打开系统程序：{}",
                    crate::redact::redact_error_text(&error.to_string())
                ),
            )
        })
}

/// 在系统文件管理器里显示（并选中）仓库内的文件；文件已删除时打开它所在的目录。
pub fn reveal_path(path: &str, relative: &str) -> Result<(), AppError> {
    let root = repo_root(path)?;
    let (target, exact) = resolve_inside(&root, relative)?;
    let target = target.as_os_str();
    if cfg!(target_os = "windows") {
        if exact {
            // explorer 的 /select, 与路径必须拼成一个参数。
            let mut arg = std::ffi::OsString::from("/select,");
            arg.push(target);
            spawn("explorer.exe", &[arg.as_os_str()])
        } else {
            spawn("explorer.exe", &[target])
        }
    } else if cfg!(target_os = "macos") {
        if exact {
            spawn("open", &[std::ffi::OsStr::new("-R"), target])
        } else {
            spawn("open", &[target])
        }
    } else {
        let folder = if exact {
            Path::new(target)
                .parent()
                .map(Path::as_os_str)
                .unwrap_or(target)
        } else {
            target
        };
        spawn("xdg-open", &[folder])
    }
}

/// 用系统默认程序打开仓库内的文件。文件不存在时不打开任何东西。
pub fn open_path(path: &str, relative: &str) -> Result<(), AppError> {
    let root = repo_root(path)?;
    let (target, exact) = resolve_inside(&root, relative)?;
    if !exact {
        return Err(AppError::new(
            "path_missing",
            "文件已不在工作区（可能已删除），未打开。",
        ));
    }
    let target = target.as_os_str();
    if cfg!(target_os = "windows") {
        spawn("explorer.exe", &[target])
    } else if cfg!(target_os = "macos") {
        spawn("open", &[target])
    } else {
        spawn("xdg-open", &[target])
    }
}

/// .gitignore 规则的最小校验：单行、非空、不含控制字符、不以 `!`/`#` 开头、不跳出仓库。
pub fn validate_ignore_pattern(pattern: &str) -> Result<String, AppError> {
    let trimmed = pattern.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_PATTERN_LEN
        || trimmed.starts_with('!')
        || trimmed.starts_with('#')
        || trimmed.chars().any(|character| character.is_control())
        || trimmed.split('/').any(|part| part == "..")
    {
        return Err(AppError::new(
            "ignore_invalid",
            "忽略规则无效，未修改 .gitignore 或本地排除。",
        ));
    }
    Ok(trimmed.to_string())
}

/// 把规则追加到 .gitignore 末尾后的完整内容；已有同一条规则时返回 None（不重复写）。
pub fn append_ignore_rule(existing: &str, pattern: &str) -> Option<String> {
    if existing.lines().any(|line| line.trim() == pattern) {
        return None;
    }
    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut next = existing.to_string();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push_str(newline);
    }
    next.push_str(pattern);
    next.push_str(newline);
    Some(next)
}

#[derive(Debug)]
pub struct IgnoreWrite {
    pub generation: u64,
    pub note: String,
}

fn ignore_failed() -> AppError {
    AppError::new(
        "ignore_failed",
        "无法写入忽略规则，.gitignore 和 .git/info/exclude 都保持原样。",
    )
}

fn ignore_note(local: bool, existed: bool, tracked: bool) -> String {
    match (existed, local, tracked) {
        (true, true, true) => "这条规则已经在本地排除里，未再追加。规则只对未跟踪文件生效，该文件仍留在改动中。",
        (true, true, false) => "这条规则已经在本地排除里，未再追加。",
        (true, false, true) => "这条规则已经在 .gitignore 里，未再追加。规则只对未跟踪文件生效，该文件仍留在改动中。",
        (true, false, false) => "这条规则已经在 .gitignore 里，未再追加。",
        (false, true, true) => "已把规则写入本地排除。规则只对未跟踪文件生效，该文件仍留在改动中，索引和文件内容未改。",
        (false, true, false) => "已把规则写入本地排除。该文件不再进入改动列表，这条规则也不会进入提交。",
        (false, false, true) => "已把规则写入 .gitignore。规则只对未跟踪文件生效，该文件仍留在改动中，索引和文件内容未改。",
        (false, false, false) => "已把规则写入 .gitignore。这次修改会出现在改动列表里。",
    }
    .to_string()
}

/// 单文件规则 `/relative` 才拿去核对索引。通配、目录规则不把路径当成已跟踪文件。
fn tracked_relative(pattern: &str) -> Option<&str> {
    let relative = pattern.strip_prefix('/')?;
    if relative.is_empty()
        || relative.ends_with('/')
        || relative.contains(['*', '?', '['])
        || relative.split('/').any(|part| part.is_empty() || part == "..")
    {
        return None;
    }
    Some(relative)
}

fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
}

fn resolve_exclude_location(root: &Path, raw: &str) -> Result<PathBuf, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains(['\0', '\n', '\r']) {
        return Err(ignore_failed());
    }
    let given = PathBuf::from(trimmed);
    let joined = if given.is_absolute() {
        given
    } else {
        root.join(given)
    };
    let name = joined.file_name().and_then(|item| item.to_str());
    let parent = joined.parent().ok_or_else(ignore_failed)?;
    let parent_name = parent.file_name().and_then(|item| item.to_str());
    if name != Some("exclude") || parent_name != Some("info") {
        return Err(ignore_failed());
    }
    if is_symlink(parent) || is_symlink(&joined) {
        return Err(ignore_failed());
    }
    let parent = if parent.exists() {
        canonical_existing(parent).map_err(|_| ignore_failed())?
    } else {
        parent.to_path_buf()
    };
    Ok(parent.join("exclude"))
}

async fn git_exclude_spec(backend: &Backend, root: &Path) -> Result<String, AppError> {
    let git = require_git(backend).await.map_err(|_| ignore_failed())?;
    let (program, args) = git_path_command(&git.path, root, "info/exclude");
    let scheduled = run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        internal_request_id(),
        program,
        args,
        None,
    )
    .await
    .map_err(|_| ignore_failed())?;
    if scheduled.output.exit_code != 0 {
        return Err(ignore_failed());
    }
    String::from_utf8(scheduled.output.stdout).map_err(|_| ignore_failed())
}

async fn path_is_tracked(backend: &Backend, root: &Path, relative: &str) -> Result<bool, AppError> {
    let git = require_git(backend).await.map_err(|_| ignore_failed())?;
    let (program, args) = ls_files_command(&git.path, root, Path::new(relative));
    let scheduled = run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        internal_request_id(),
        program,
        args,
        None,
    )
    .await
    .map_err(|_| ignore_failed())?;
    if scheduled.output.exit_code != 0 {
        return Err(ignore_failed());
    }
    Ok(scheduled
        .output
        .stdout
        .iter()
        .any(|byte| !byte.is_ascii_whitespace()))
}

fn append_rule_file(target: &Path, pattern: &str) -> Result<bool, AppError> {
    if is_symlink(target) {
        return Err(ignore_failed());
    }
    let existing = match std::fs::read(target) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| ignore_failed())?,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(_) => return Err(ignore_failed()),
    };
    let Some(next) = append_ignore_rule(&existing, pattern) else {
        return Ok(false);
    };
    atomic_write(target, next.as_bytes()).map_err(|_| ignore_failed())?;
    Ok(true)
}

/// 把规则加入 `.gitignore`（`local` 为 false）或本地 `info/exclude`。
/// 已跟踪文件仍写入规则，但不改索引和磁盘内容。
pub async fn ignore_path(
    backend: &Backend,
    path: &str,
    pattern: &str,
    local: bool,
    generation: u64,
    request_id: u64,
) -> Result<IgnoreWrite, AppError> {
    let pattern = validate_ignore_pattern(pattern)?;
    let root = repo_root(path)?;
    let target = if local {
        let raw = git_exclude_spec(backend, &root).await?;
        resolve_exclude_location(&root, &raw)?
    } else {
        root.join(".gitignore")
    };
    let tracked = match tracked_relative(&pattern) {
        Some(relative) => path_is_tracked(backend, &root, relative).await?,
        None => false,
    };
    let mut guard = backend
        .scheduler
        .lock_write(&repo_key(&root), request_id, generation)
        .await?;
    let wrote = append_rule_file(&target, &pattern)?;
    if wrote {
        guard.mark_written();
    }
    Ok(IgnoreWrite {
        generation: guard.finish(),
        note: ignore_note(local, !wrote, tracked),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_rules_are_single_line_and_not_negations() {
        assert_eq!(validate_ignore_pattern("  /build/  ").unwrap(), "/build/");
        assert_eq!(validate_ignore_pattern("*.log").unwrap(), "*.log");
        for bad in [
            "",
            "   ",
            "!keep.txt",
            "# comment",
            "a\nb",
            "../outside",
            "a/../../b",
            "x\u{0}y",
        ] {
            assert_eq!(
                validate_ignore_pattern(bad).unwrap_err().code,
                "ignore_invalid",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn appending_keeps_existing_content_and_line_endings() {
        assert_eq!(append_ignore_rule("", "*.log").as_deref(), Some("*.log\n"));
        assert_eq!(
            append_ignore_rule("dist", "*.log").as_deref(),
            Some("dist\n*.log\n")
        );
        assert_eq!(
            append_ignore_rule("dist\r\n", "*.log").as_deref(),
            Some("dist\r\n*.log\r\n")
        );
        assert_eq!(append_ignore_rule("dist\n*.log\n", "*.log"), None);
    }

    #[test]
    fn targets_must_stay_inside_the_repository() {
        let temp = std::env::temp_dir().join(format!("twiglane-ws-{}", std::process::id()));
        std::fs::create_dir_all(temp.join("src")).unwrap();
        std::fs::write(temp.join("src/a.txt"), "x").unwrap();
        let root = canonical_existing(&temp).unwrap();
        let (found, exact) = resolve_inside(&root, "src/a.txt").unwrap();
        assert!(exact && found.ends_with("a.txt"));
        let (fallback, exact) = resolve_inside(&root, "src/gone/b.txt").unwrap();
        assert!(!exact && fallback.ends_with("src"));
        assert!(resolve_inside(&root, "../escape").is_err());
        let _ = std::fs::remove_dir_all(&temp);
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new(crate::test_support::system_git())
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

    fn git_text(dir: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?} {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn status_lists_files_and_local_exclude_does_not_enter_the_commit() {
        let fixture = crate::test_support::git_fixture("ignore-lines");
        let repo = fixture.repo("demo");
        let backend = fixture.backend();
        git(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("tracked.txt"), "a\nb\nc\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        std::fs::write(repo.join("tracked.txt"), "a\nB\nc\nd\ne\n").unwrap();
        std::fs::create_dir(repo.join("notes")).unwrap();
        std::fs::write(repo.join("notes/todo.log"), "a\nb\nc\n").unwrap();
        std::fs::write(repo.join("notes/hidden.log"), "secret\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "hidden.log\n").unwrap();
        std::fs::write(repo.join("blob.bin"), [b'a', 0, b'b']).unwrap();
        let path = repo.to_string_lossy().into_owned();
        let opened = crate::git::ops::open_repository(&backend, &path, 11)
            .await
            .unwrap();
        let paths: Vec<_> = opened
            .snapshot
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert!(paths.contains(&"tracked.txt"));
        assert!(paths.contains(&"notes/todo.log"));
        assert!(paths.contains(&"blob.bin"));
        assert!(!paths.iter().any(|item| item.ends_with('/')));
        assert!(!paths.contains(&"notes"));
        assert!(!paths.contains(&"notes/hidden.log"));
        assert!(!paths.iter().any(|item| item.contains("info/exclude")));
        let tracked = opened
            .snapshot
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert_eq!(tracked.unstaged_lines.unwrap().additions, Some(3));
        assert_eq!(tracked.unstaged_lines.unwrap().deletions, Some(1));
        assert!(tracked.staged_lines.is_none());
        let todo = opened
            .snapshot
            .files
            .iter()
            .find(|file| file.path == "notes/todo.log")
            .unwrap();
        assert!(todo.untracked);
        assert_eq!(todo.unstaged_lines.unwrap().additions, Some(3));
        assert_eq!(todo.unstaged_lines.unwrap().deletions, Some(0));
        let blob = opened
            .snapshot
            .files
            .iter()
            .find(|file| file.path == "blob.bin")
            .unwrap();
        assert_eq!(blob.unstaged_lines.unwrap().additions, None);
        assert_eq!(blob.unstaged_lines.unwrap().deletions, None);
        let index_before = git_text(&repo, &["rev-parse", ":tracked.txt"]);
        let bytes_before = std::fs::read(repo.join("tracked.txt")).unwrap();
        let ignore_before = std::fs::read(repo.join(".gitignore")).unwrap();
        let first = ignore_path(
            &backend,
            &path,
            "/tracked.txt",
            true,
            opened.generation,
            12,
        )
        .await
        .unwrap();
        assert!(first.note.contains("仍留在改动中"));
        assert!(first.note.contains("索引和文件内容未改"));
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches("/tracked.txt").count(), 1);
        assert_eq!(std::fs::read(repo.join(".gitignore")).unwrap(), ignore_before);
        assert_eq!(std::fs::read(repo.join("tracked.txt")).unwrap(), bytes_before);
        assert_eq!(git_text(&repo, &["rev-parse", ":tracked.txt"]), index_before);
        let again = ignore_path(&backend, &path, "/tracked.txt", true, first.generation, 13)
            .await
            .unwrap();
        assert!(again.note.contains("已经在本地排除里"));
        assert_eq!(
            std::fs::read_to_string(repo.join(".git/info/exclude"))
                .unwrap()
                .matches("/tracked.txt")
                .count(),
            1
        );
        let hidden = ignore_path(
            &backend,
            &path,
            "/notes/todo.log",
            true,
            again.generation,
            14,
        )
        .await
        .unwrap();
        assert!(hidden.note.contains("不会进入提交"));
        let snapshot = crate::git::ops::refresh_status(&backend, &path, hidden.generation, 15)
            .await
            .unwrap();
        let after: Vec<_> = snapshot.files.iter().map(|file| file.path.as_str()).collect();
        assert!(after.contains(&"tracked.txt"));
        assert!(!after.contains(&"notes/todo.log"));
        assert!(!after.iter().any(|item| item.contains("info/exclude")));
        assert_eq!(std::fs::read(repo.join(".gitignore")).unwrap(), ignore_before);

        let broken = fixture.repo("broken");
        let broken_backend = fixture.backend();
        git(&broken, &["init", "-b", "main"]);
        std::fs::write(broken.join(".gitignore"), "keep\n").unwrap();
        let broken_path = broken.to_string_lossy().into_owned();
        let opened_broken = crate::git::ops::open_repository(&broken_backend, &broken_path, 21)
            .await
            .unwrap();
        // 先成功打开，再模拟目标损坏。部分平台上的 Git status 会拒绝目录形式的
        // exclude；本用例验证的是写入失败时不改文件，不依赖 Git 容忍这个损坏。
        let exclude = broken.join(".git/info/exclude");
        std::fs::remove_file(&exclude).unwrap();
        std::fs::create_dir(&exclude).unwrap();
        let error = ignore_path(
            &broken_backend,
            &broken_path,
            "/keep-me.txt",
            true,
            opened_broken.generation,
            22,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains(".gitignore 和 .git/info/exclude 都保持原样"));
        assert_eq!(std::fs::read(broken.join(".gitignore")).unwrap(), b"keep\n");
        assert!(broken.join(".git/info/exclude").is_dir());
    }
}
