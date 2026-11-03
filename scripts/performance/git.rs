//! 按需运行的真实 Git 压力工具。仅 performance-tests feature 编译此模块。
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::git::{history, ops, resolve, sync};
use crate::test_support::{git_fixture, isolated_gitconfig, system_git, GitFixture};

struct PerformanceFixture {
    _fixture: GitFixture,
    root: PathBuf,
    path: String,
    backend: ops::Backend,
    trace: PathBuf,
}

impl PerformanceFixture {
    fn new(files: usize, branches: usize, lines: usize) -> Self {
        let fixture = git_fixture("performance");
        let root = fixture.repo("large repo");
        let trace = fixture.path().join("git-trace.log");
        let backend = fixture.backend_with_limit(
            8 * 1024 * 1024,
            vec![("GIT_TRACE".into(), trace.as_os_str().to_os_string())],
        );
        let result = Self {
            path: ops::repo_key(&root),
            root,
            backend,
            trace,
            _fixture: fixture,
        };
        result.git(&["init", "-b", "main"], None);
        let large: String = (0..lines).map(|i| format!("line {i}\n")).collect();
        let mut input = format!(
            "blob\nmark :1\ndata 2\nx\n\nblob\nmark :2\ndata {}\n{}\n\
             commit refs/heads/main\nmark :3\ncommitter Test <test@example.com> 1700000000 +0000\ndata 5\nbase\n\n\
             commit refs/heads/topic\nmark :4\ncommitter Test <test@example.com> 1700000001 +0000\ndata 6\nscale\nfrom :3\nM 100644 :2 large.txt\n",
            large.len(), large,
        );
        for i in 1..files {
            input.push_str(&format!("M 100644 :1 files/file-{i}.txt\n"));
        }
        input.push('\n');
        for i in 0..branches {
            input.push_str(&format!("reset refs/heads/scale-{i}\nfrom :3\n\n"));
        }
        input.push_str("done\n");
        result.git(&["fast-import", "--quiet"], Some(input.as_bytes()));
        result.git(&["checkout", "-f", "main"], None);
        result
    }

    fn git(&self, args: &[&str], input: Option<&[u8]>) -> String {
        let mut child = Command::new(system_git())
            .current_dir(&self.root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", isolated_gitconfig())
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(bytes) = input {
            child.stdin.take().unwrap().write_all(bytes).unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn generation(&self) -> u64 {
        self.backend.scheduler.current_generation(&self.path)
    }

    fn count(&self, command: &str) -> usize {
        let needle = format!("built-in: git {command} ");
        fs::read_to_string(&self.trace)
            .unwrap()
            .lines()
            .filter(|line| line.contains(&needle))
            .count()
    }
}

#[tokio::test]
async fn branches_files_and_merge_at_scale() {
    let fixture = PerformanceFixture::new(20_000, 5_000, 5_000);
    ops::require_git(&fixture.backend).await.unwrap();
    let started = Instant::now();
    let branches = sync::branch_state(&fixture.backend, &fixture.path, fixture.generation(), 1)
        .await
        .unwrap();
    assert_eq!(branches.branches.len(), 5_002);
    eprintln!("5002 branches: {:?}", started.elapsed());

    let oid = fixture.git(&["rev-parse", "topic"], None);
    let started = Instant::now();
    let detail = history::commit_detail(
        &fixture.backend,
        &fixture.path,
        &oid,
        None,
        fixture.generation(),
        2,
    )
    .await
    .unwrap();
    assert_eq!(detail.files.len(), 20_000);
    eprintln!("20000-file commit detail: {:?}", started.elapsed());
    let trees = fixture.count("diff-tree");
    let started = Instant::now();
    for (id, path) in [(3, "large.txt"), (4, "files/file-19999.txt")] {
        let diff = history::commit_file_diff(
            &fixture.backend,
            &fixture.path,
            &oid,
            None,
            path,
            fixture.generation(),
            id,
            0,
            0,
        )
        .await
        .unwrap();
        assert!(!diff.lines.is_empty());
        assert!(!diff.truncated);
    }
    assert_eq!(
        fixture.count("diff-tree"),
        trees,
        "file selection reuses the one bounded file directory"
    );
    eprintln!(
        "two file diffs (one 5000 lines), cached directory: {:?}",
        started.elapsed()
    );
    let old = fixture.generation();
    fixture.backend.scheduler.bump_generation(&fixture.path);
    assert_eq!(
        history::commit_file_diff(
            &fixture.backend,
            &fixture.path,
            &oid,
            None,
            "large.txt",
            old,
            5,
            0,
            0
        )
        .await
        .unwrap_err()
        .code,
        "stale"
    );
    history::commit_file_diff(
        &fixture.backend,
        &fixture.path,
        &oid,
        None,
        "large.txt",
        fixture.generation(),
        6,
        0,
        0,
    )
    .await
    .unwrap();
    assert_eq!(fixture.count("diff-tree"), trees + 1);

    let started = Instant::now();
    let preview = resolve::merge_preview(
        &fixture.backend,
        &fixture.path,
        "topic",
        None,
        fixture.generation(),
        7,
    )
    .await
    .unwrap();
    assert_eq!(preview.files_total, 20_000);
    assert!(preview.files.len() <= 200);
    eprintln!("20000-file merge preview: {:?}", started.elapsed());
    let started = Instant::now();
    let merged = resolve::start_merge(
        &fixture.backend,
        &fixture.path,
        "topic",
        None,
        Some("ff-only"),
        fixture.generation(),
        8,
    )
    .await
    .unwrap();
    assert!(merged.fast_forwarded);
    assert_eq!(fixture.git(&["rev-parse", "HEAD"], None), oid);
    assert_eq!(
        fs::read_dir(fixture.root.join("files")).unwrap().count(),
        19_999
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("large.txt"))
            .unwrap()
            .lines()
            .count(),
        5_000
    );
    eprintln!(
        "real fast-forward merge of 20000 files: {:?}",
        started.elapsed()
    );
}
