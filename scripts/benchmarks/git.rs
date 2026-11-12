//! 按需运行的独立 Git benchmark；不注册为单元测试。
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::git::{history, ops, resolve, sync};
use crate::test_support::{git_fixture, isolated_gitconfig, system_git, GitFixture};

fn uncommitted_diff_paging_at_scale() {
    use crate::git::patch::{parse_diff, view_lines};
    let mut raw = String::from("diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -0,0 +1,50000 @@\n");
    for i in 0..50_000 {
        raw.push_str(&format!("+generated working tree line {i}\n"));
    }
    let parsed = parse_diff(raw.as_bytes(), false).unwrap();
    let start = Instant::now();
    for _ in 0..100 {
        for offset in [0, 25_000, 49_604] {
            let (lines, hunks, total) = std::hint::black_box(view_lines(&parsed, offset, 400));
            assert_eq!(lines.len(), 400);
            assert_eq!(hunks.len(), 1);
            assert_eq!(total, 50_004);
        }
    }
    eprintln!(
        "50000-line diff, 300 pages of 400 lines: {:?}",
        start.elapsed()
    );
}

struct PerformanceFixture {
    _fixture: GitFixture,
    root: PathBuf,
    path: String,
    backend: ops::Backend,
    trace: PathBuf,
}

async fn uncommitted_reads_at_scale() {
    let fixture = PerformanceFixture::new(1, 0, 5_000);
    fixture.git(&["checkout", "-f", "topic"], None);
    fs::write(fixture.root.join("large.txt"), "changed\n").unwrap();
    ops::require_git(&fixture.backend).await.unwrap();
    let start = Instant::now();
    for id in 1..=10 {
        let diff = crate::git::changes::load_diff_with_context(
            &fixture.backend,
            &fixture.path,
            "large.txt",
            None,
            false,
            fixture.generation(),
            id,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        assert_eq!((diff.additions, diff.deletions), (1, 5_000));
    }
    eprintln!(
        "10 uncommitted diffs: {:?}, {} diff processes",
        start.elapsed(),
        fixture.count("diff")
    );
    assert_eq!(
        fixture.count("diff"),
        10,
        "complete patches must not run a second diff for numstat"
    );

    // 大型导出文件不应让状态刷新遍历全部内容。
    fs::write(
        fixture.root.join("export.txt"),
        "exported row\n".repeat(8_000_000),
    )
    .unwrap();
    let start = Instant::now();
    for id in 11..=13 {
        let status = ops::refresh_status(&fixture.backend, &fixture.path, fixture.generation(), id)
            .await
            .unwrap();
        assert!(status
            .files
            .iter()
            .any(|file| file.path == "export.txt" && file.untracked));
        assert!(status
            .files
            .iter()
            .find(|file| file.path == "export.txt")
            .unwrap()
            .unstaged_lines
            .is_none());
    }
    eprintln!(
        "3 status refreshes with 104 MB untracked export: {:?}",
        start.elapsed()
    );
}

async fn huge_text_sequential_pages_reuse_byte_positions() {
    use std::sync::Arc;
    let mut fixture = PerformanceFixture::new(1, 0, 1);
    let file = fs::File::create(fixture.root.join("huge.txt")).unwrap();
    let mut writer = std::io::BufWriter::new(file);
    let padding = "x".repeat(200);
    for line in 0..500_000 {
        writeln!(writer, "{line:06} {padding}").unwrap();
    }
    writer.flush().unwrap();
    drop(writer);
    let mut request = 1000;
    for cached in [false, true] {
        fixture.backend.text_cursors =
            Arc::new(crate::git::text_cursor::TextCursorCache::default());
        if cached {
            crate::git::files::repository_file_content(
                &fixture.backend,
                &fixture.path,
                "huge.txt",
                99_500,
                Some(500),
                fixture.generation(),
                request,
            )
            .await
            .unwrap();
            request += 1;
        }
        let start = Instant::now();
        for page in 0..8 {
            if !cached {
                fixture.backend.text_cursors =
                    Arc::new(crate::git::text_cursor::TextCursorCache::default());
            }
            let offset = 100_000 + page * 500;
            let result = crate::git::files::repository_file_content(
                &fixture.backend,
                &fixture.path,
                "huge.txt",
                offset,
                Some(500),
                fixture.generation(),
                request,
            )
            .await
            .unwrap();
            request += 1;
            assert_eq!(result.lines.len(), 500);
            assert!(result.lines[0].starts_with(&format!("{offset:06} ")));
            assert_eq!(result.next_offset, offset + 500);
        }
        eprintln!(
            "104 MB text, eight pages after line 100000, cached={cached}: {:?}",
            start.elapsed()
        );
    }
}

async fn immutable_diff_paging_reuses_git_at_scale() {
    let mut fixture = PerformanceFixture::new(1, 0, 5_000);
    let oid = fixture.git(&["rev-parse", "topic"], None);
    let mut request = 2000;
    // 两组都先完成 Git 探测和文件目录读取，只对比补丁缓存本身。
    history::commit_file_diff(
        &fixture.backend,
        &fixture.path,
        &oid,
        None,
        "large.txt",
        fixture.generation(),
        request,
        0,
        400,
        3,
        false,
    )
    .await
    .unwrap();
    request += 1;
    for cached in [false, true] {
        fixture.backend.history_diffs = crate::git::diff_cache::DiffCache::default();
        let start = Instant::now();
        let before = if fixture.trace.exists() {
            fixture.count("diff")
        } else {
            0
        };
        for page in 0..8 {
            if !cached {
                fixture.backend.history_diffs = crate::git::diff_cache::DiffCache::default();
            }
            let result = history::commit_file_diff(
                &fixture.backend,
                &fixture.path,
                &oid,
                None,
                "large.txt",
                fixture.generation(),
                request,
                page * 400,
                400,
                3,
                false,
            )
            .await
            .unwrap();
            request += 1;
            assert_eq!(result.additions, 5000);
            assert_eq!(result.lines.len(), 400);
        }
        let processes = fixture.count("diff") - before;
        eprintln!("5000-line historical diff, eight pages, cached={cached}: {:?}, {processes} diff processes (including numstat)", start.elapsed());
        if cached {
            assert_eq!(processes, 1);
        }
    }
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

async fn branches_files_and_merge_at_scale() {
    let fixture = PerformanceFixture::new(20_000, 5_000, 5_000);
    ops::require_git(&fixture.backend).await.unwrap();
    let started = Instant::now();
    let branches = sync::branch_state(&fixture.backend, &fixture.path, fixture.generation(), 1)
        .await
        .unwrap();
    assert_eq!(branches.branches.len(), 5_002);
    eprintln!("5002 branches: {:?}", started.elapsed());

    let lists = fixture.count("for-each-ref");
    let statuses = fixture.count("status");
    let started = Instant::now();
    let listing = sync::branch_list(&fixture.backend, &fixture.path, fixture.generation(), 999)
        .await
        .unwrap();
    assert_eq!(listing.branches.len(), 5_002);
    assert_eq!(fixture.count("for-each-ref"), lists + 1);
    assert_eq!(fixture.count("status"), statuses);
    eprintln!(
        "5002 branches lightweight (one Git process): {:?}",
        started.elapsed()
    );

    let oid = fixture.git(&["rev-parse", "topic"], None);
    let git = ops::require_git(&fixture.backend).await.unwrap();
    let mut names = vec![format!("{oid}:large.txt")];
    names.extend((1..20_000).map(|i| format!("{oid}:files/file-{i}.txt")));
    names.push(names[0].clone());
    let batches = fixture.count("cat-file");
    let tree_scans = fixture.count("ls-tree");
    let started = Instant::now();
    let sizes = crate::git::sizes::object_sizes(
        &fixture.backend,
        &git.path,
        &fixture.root,
        fixture.generation(),
        &names,
    )
    .await;
    assert_eq!(sizes.len(), 20_000);
    assert_eq!(sizes[&names[1]], 2);
    assert_eq!(
        sizes[&names[0]],
        (0..5_000)
            .map(|i| format!("line {i}\n").len() as u64)
            .sum::<u64>()
    );
    assert_eq!(
        fixture.count("ls-tree"),
        tree_scans + 1,
        "large same-tree requests traverse the tree once"
    );
    assert_eq!(fixture.count("cat-file"), batches);
    eprintln!(
        "20000 object sizes (one tree scan): {:?}",
        started.elapsed()
    );
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
            0,
            false,
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
            0,
            0,
            false
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
        0,
        false,
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

/// 明确选择场景；默认运行两个与大文本优化直接相关的 benchmark。
pub fn run() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "text".into());
    let runtime = tokio::runtime::Runtime::new().expect("benchmark runtime");
    runtime.block_on(async {
        match scenario.as_str() {
            "text" => {
                huge_text_sequential_pages_reuse_byte_positions().await;
                immutable_diff_paging_reuses_git_at_scale().await;
            }
            "all" => {
                branches_files_and_merge_at_scale().await;
                huge_text_sequential_pages_reuse_byte_positions().await;
                immutable_diff_paging_reuses_git_at_scale().await;
                uncommitted_reads_at_scale().await;
                uncommitted_diff_paging_at_scale();
            }
            "paging" => uncommitted_diff_paging_at_scale(),
            _ => panic!("支持的场景：text、paging、all"),
        }
    });
}
