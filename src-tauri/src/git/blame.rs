//! 逐行追溯（git blame）：只读，回答「当前工作区这个文件的每一行最后由哪个提交写入」。
//!
//! 追溯对象是工作区里的当前内容（与文件视图读到的一致），未提交的行归到一个
//! 「尚未提交」的虚拟提交上。读取走仓库读通道，带 generation 校验；不改 HEAD、
//! 索引或工作区。结果按「连续同一提交」压成区间，前端按行号二分即可查到归属。

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, run_git, safe_relative,
    validate_input_path, Backend,
};
use crate::git::schedule::JobKind;
use crate::model::{BlameCommit, BlameRange, FileBlame};

/// 未提交内容在 porcelain 输出里的提交号（SHA-1 与 SHA-256 仓库分别是 40/64 个 0）。
fn is_zero_oid(oid: &str) -> bool {
    !oid.is_empty() && oid.bytes().all(|byte| byte == b'0')
}

fn is_oid(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn blame_command(git: &Path, root: &Path, relative: &Path) -> (PathBuf, Vec<OsString>) {
    let args = vec![
        OsString::from("-c"),
        OsString::from("core.quotePath=false"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
        OsString::from("blame"),
        OsString::from("--porcelain"),
        OsString::from("--"),
        relative.as_os_str().to_os_string(),
    ];
    (git.to_path_buf(), args)
}

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

pub async fn file_blame(
    backend: &Backend,
    path: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
) -> Result<FileBlame, AppError> {
    let root = repo_root(path)?;
    let relative_path = safe_relative(relative)?;
    let git = require_git(backend).await?;
    let (program, args) = blame_command(&git.path, &root, &relative_path);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await
    .map_err(|error| {
        if error.code == "output_limit" {
            let mapped = AppError::new(
                "blame_truncated",
                "这个文件太大，逐行追溯的输出超过上限，没有显示不完整的结果。",
            );
            match error.generation {
                Some(generation) => mapped.with_generation(generation),
                None => mapped,
            }
        } else {
            error
        }
    })?;
    let output = scheduled.output;
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("no such path") {
            return Err(AppError::new(
                "blame_untracked",
                "这个文件还没有提交过，没有可以追溯的历史。",
            )
            .with_generation(scheduled.generation));
        }
        if stderr.contains("no such ref") || stderr.contains("does not have any commits") {
            return Err(AppError::new(
                "blame_unborn",
                "仓库还没有任何提交，没有可以追溯的历史。",
            )
            .with_generation(scheduled.generation));
        }
        if stderr.contains("binary") {
            return Err(AppError::new("blame_binary", "二进制文件不能逐行追溯。")
                .with_generation(scheduled.generation));
        }
        return Err(git_failure(
            "blame_failed",
            &output,
            "无法读取这个文件的逐行追溯，未修改仓库。",
        )
        .with_generation(scheduled.generation));
    }
    let (commits, ranges, lines) = parse_blame_porcelain(&output.stdout, relative);
    Ok(FileBlame {
        generation: scheduled.generation,
        path: relative.to_string(),
        lines,
        commits,
        ranges,
    })
}

/// 解析 `git blame --porcelain`：每一行先是「提交 原行号 现行号 [组行数]」，
/// 提交第一次出现时跟着它的元数据，最后是以制表符开头的行内容。
pub fn parse_blame_porcelain(bytes: &[u8], path: &str) -> (Vec<BlameCommit>, Vec<BlameRange>, u32) {
    let text = String::from_utf8_lossy(bytes);
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut ranges: Vec<BlameRange> = Vec::new();
    // 当前条目：(提交下标, 原行号, 现行号)
    let mut current: Option<(usize, u32, u32)> = None;
    let mut lines = 0u32;

    for raw in text.split('\n') {
        if raw.starts_with('\t') {
            if let Some((commit, orig, final_line)) = current.take() {
                lines = lines.max(final_line);
                let merged = ranges.last_mut().is_some_and(|last| {
                    if last.commit as usize == commit
                        && last.start + last.count == final_line
                        && last.orig_start + last.count == orig
                    {
                        last.count += 1;
                        true
                    } else {
                        false
                    }
                });
                if !merged {
                    ranges.push(BlameRange {
                        start: final_line,
                        count: 1,
                        commit: u32::try_from(commit).unwrap_or(u32::MAX),
                        orig_start: orig,
                    });
                }
            }
            continue;
        }
        let line = raw.trim_end_matches('\r');
        if current.is_none() {
            let mut parts = line.split(' ');
            let Some(oid) = parts.next().filter(|oid| is_oid(oid)) else { continue };
            let orig = parts.next().and_then(|value| value.parse::<u32>().ok());
            let final_line = parts.next().and_then(|value| value.parse::<u32>().ok());
            let (Some(orig), Some(final_line)) = (orig, final_line) else { continue };
            let at = *index.entry(oid.to_string()).or_insert_with(|| {
                let uncommitted = is_zero_oid(oid);
                commits.push(BlameCommit {
                    oid: oid.to_string(),
                    author: if uncommitted { "尚未提交".to_string() } else { String::new() },
                    author_time: 0,
                    summary: if uncommitted { "工作区里还没有提交的修改".to_string() } else { String::new() },
                    uncommitted,
                    boundary: false,
                    previous_path: None,
                });
                commits.len() - 1
            });
            current = Some((at, orig, final_line));
            continue;
        }
        let Some((at, _, _)) = current else { continue };
        let commit = &mut commits[at];
        if commit.uncommitted {
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "author" => commit.author = value.to_string(),
            "author-time" => commit.author_time = value.parse().unwrap_or(0),
            "summary" => commit.summary = value.to_string(),
            "boundary" => commit.boundary = true,
            "filename" if value != path => commit.previous_path = Some(value.to_string()),
            _ => {}
        }
    }
    (commits, ranges, lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str], date: &str) {
        let status = Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", crate::test_support::isolated_gitconfig())
            .env("GIT_AUTHOR_NAME", "Alice")
            .env("GIT_AUTHOR_EMAIL", "alice@example.com")
            .env("GIT_COMMITTER_NAME", "Alice")
            .env("GIT_COMMITTER_EMAIL", "alice@example.com")
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }

    #[test]
    fn porcelain_groups_consecutive_lines_and_reuses_commit_metadata() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let zero = "0".repeat(40);
        let text = format!(
            "{a} 1 1 2\nauthor Alice\nauthor-time 100\nsummary first\nfilename f.txt\n\tone\n{a} 2 2\n\ttwo\n\
             {b} 3 3 1\nauthor Bob\nauthor-time 200\nsummary second\nprevious {a} old.txt\nfilename old.txt\n\tthree\n\
             {zero} 4 4 1\nauthor Not Committed Yet\nauthor-time 300\nsummary Version of f.txt from f.txt\nfilename f.txt\n\tfour\n\
             {a} 5 5 1\n\tfive\n"
        );
        let (commits, ranges, lines) = parse_blame_porcelain(text.as_bytes(), "f.txt");
        assert_eq!(lines, 5);
        assert_eq!(commits.len(), 3);
        assert_eq!((commits[0].author.as_str(), commits[0].author_time, commits[0].summary.as_str()), ("Alice", 100, "first"));
        assert_eq!(commits[1].previous_path.as_deref(), Some("old.txt"));
        assert!(commits[2].uncommitted);
        assert_eq!(commits[2].author, "尚未提交");
        let spans: Vec<_> = ranges.iter().map(|range| (range.start, range.count, range.commit)).collect();
        assert_eq!(spans, vec![(1, 2, 0), (3, 1, 1), (4, 1, 2), (5, 1, 0)]);
    }

    #[tokio::test]
    async fn blames_worktree_lines_including_uncommitted_and_reports_untracked() {
        let fixture = crate::test_support::git_fixture("blame");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"], "2024-01-01T00:00:00Z");
        fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        git(&repo, &["add", "."], "2024-01-01T00:00:00Z");
        git(&repo, &["commit", "-m", "first"], "2024-01-01T00:00:00Z");
        fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(&repo, &["commit", "-am", "second"], "2024-02-01T00:00:00Z");
        fs::write(repo.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
        fs::write(repo.join("new.txt"), "x\n").unwrap();

        let key = repo_key(&repo);
        let generation = backend.scheduler.current_generation(&key);
        let blame = file_blame(&backend, &key, "a.txt", generation, 1).await.unwrap();
        assert_eq!(blame.lines, 3);
        let owner = |line: u32| {
            let range = blame.ranges.iter().find(|range| range.start <= line && line < range.start + range.count).unwrap();
            &blame.commits[range.commit as usize]
        };
        assert!(owner(1).uncommitted);
        assert_eq!(owner(2).summary, "first");
        assert_eq!(owner(3).summary, "second");
        assert_eq!(owner(3).author, "Alice");
        assert!(owner(3).author_time > owner(2).author_time);

        let untracked = file_blame(&backend, &key, "new.txt", blame.generation, 2).await.unwrap_err();
        assert_eq!(untracked.code, "blame_untracked");
        let escaped = file_blame(&backend, &key, "../outside.txt", blame.generation, 3).await.unwrap_err();
        assert_eq!(escaped.code, "invalid_path");
    }
}
