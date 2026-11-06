//! 二进制文件的大小。
//!
//! 二进制没有行数可言，界面改为显示改动前后的文件大小。大小只为二进制条目去取：
//! 仓库里的版本用 `git cat-file --batch-check` 批量读类型与大小（对象名按 `<树>:<路径>` 或
//! `:<路径>` 写进 stdin），工作区的版本读文件元数据。读不到就留空，界面退回「二进制」，
//! 不影响状态、差异和提交本身。
//! 同一树的大量路径用一次 ls-tree 读取大小，避免每个路径重复解析整棵树。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::git::command::{batch_check_command, tree_sizes_command};
use crate::git::ops::{repo_key, safe_relative, Backend};
use crate::git::runner::RealRunner;
use crate::git::schedule::{internal_request_id, CommandSpec, GitJob, JobKind, WriteGuard};
use crate::model::{ChangeKind, FileChange, LineStat};

/// 字节数的人读写法：1023 B、1.5 KB、12 KB、3.4 MB。与前端 formatBytes 同一口径。
pub fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 {
        format!("{:.1} {}", value, UNITS[unit]).replace(".0 ", " ")
    } else {
        format!("{:.0} {}", value, UNITS[unit])
    }
}

/// 二进制差异的一句摘要：说明前后大小，读不到时只说有变化。
pub fn binary_summary(old_size: Option<u64>, new_size: Option<u64>) -> String {
    match (old_size, new_size) {
        (Some(old), Some(new)) => format!(
            "二进制文件有变化：{} → {}。",
            format_size(old),
            format_size(new)
        ),
        (None, Some(new)) => format!("新增二进制文件，{}。", format_size(new)),
        (Some(old), None) => format!("删除二进制文件，原为 {}。", format_size(old)),
        (None, None) => "二进制文件有变化，但不能按文本预览。".to_string(),
    }
}

/// 行数两侧都是未知时就是二进制（`git diff --numstat` 记作 `-\t-`）。
pub fn is_binary(stat: &LineStat) -> bool {
    stat.additions.is_none() && stat.deletions.is_none()
}

/// 对象名能否安全写进 batch-check 的一行：换行会把一个名字拆成两个请求。
fn usable(name: &str) -> bool {
    !name.is_empty() && !name.contains('\n') && !name.contains('\r') && !name.contains('\0')
}

fn parse_size(line: &str) -> Option<u64> {
    let mut parts = line.trim_end().rsplitn(3, ' ');
    let size = parts.next()?.parse::<u64>().ok()?;
    let kind = parts.next()?;
    (kind == "blob").then_some(size)
}

/// 解析 `<type> <size>`（也兼容默认的 `<oid> <type> <size>`），与输入逐行对应。
#[cfg(test)]
pub fn parse_batch_check(stdout: &[u8], count: usize) -> Vec<Option<u64>> {
    let text = String::from_utf8_lossy(stdout);
    let mut sizes: Vec<Option<u64>> = text.lines().take(count).map(parse_size).collect();
    sizes.resize(count, None);
    sizes
}

fn batch_names(names: &[String]) -> Vec<&str> {
    let mut seen = HashSet::new();
    names
        .iter()
        .map(String::as_str)
        .filter(|name| usable(name) && seen.insert(*name))
        .collect()
}

fn batch_input(names: &[&str]) -> Vec<u8> {
    let mut input = Vec::with_capacity(names.iter().map(|name| name.len() + 1).sum());
    for name in names {
        input.extend_from_slice(name.as_bytes());
        input.push(b'\n');
    }
    input
}

fn collect(names: &[&str], stdout: &[u8]) -> HashMap<String, u64> {
    let text = String::from_utf8_lossy(stdout);
    names
        .iter()
        .zip(text.lines())
        .filter_map(|(name, line)| parse_size(line).map(|size| ((*name).to_string(), size)))
        .collect()
}

// 少量查询仍用 cat-file；同一树的路径达到这个数量时，逐条解析路径比遍历整棵树昂贵。
const TREE_SCAN_THRESHOLD: usize = 512;

fn tree_batches<'a>(names: &[&'a str]) -> Vec<(&'a str, HashSet<&'a str>)> {
    let mut groups: HashMap<&str, HashSet<&str>> = HashMap::new();
    for name in names {
        let Some((tree, path)) = name.split_once(':') else {
            continue;
        };
        // 只处理调用方生成的 HEAD / 完整提交 OID。索引请求留在 batch-check，
        // 并拒绝把任意对象表达式或选项带入 ls-tree。
        if tree == "HEAD"
            || (matches!(tree.len(), 40 | 64) && tree.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            groups.entry(tree).or_default().insert(path);
        }
    }
    groups
        .into_iter()
        .filter(|(_, paths)| paths.len() >= TREE_SCAN_THRESHOLD)
        .collect()
}

fn collect_tree_sizes(tree: &str, paths: &HashSet<&str>, stdout: &[u8]) -> HashMap<String, u64> {
    let mut sizes = HashMap::new();
    for record in stdout.split(|byte| *byte == 0) {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let Ok(path) = std::str::from_utf8(&record[tab + 1..]) else {
            continue;
        };
        if !paths.contains(path) {
            continue;
        }
        let Ok(header) = std::str::from_utf8(&record[..tab]) else {
            continue;
        };
        if let Some(size) = parse_size(header) {
            sizes.insert(tree_name(tree, path), size);
        }
    }
    sizes
}

/// 读取一批对象的大小（只读，走调度器的读名额）。失败时返回空表。
pub async fn object_sizes(
    backend: &Backend,
    git: &Path,
    root: &Path,
    generation: u64,
    names: &[String],
) -> HashMap<String, u64> {
    let mut names = batch_names(names);
    let mut sizes = HashMap::new();
    for (tree, paths) in tree_batches(&names) {
        let (program, args) = tree_sizes_command(git, root, tree);
        let output = backend
            .scheduler
            .execute(GitJob {
                repo_key: repo_key(root),
                kind: JobKind::Read,
                request_id: internal_request_id(),
                generation,
                program,
                args,
                stdin: None,
                truncate_stdout: false,
                output_limit: None,
                env: Vec::new(),
            })
            .await;
        if let Ok(output) = output {
            if output.output.exit_code == 0 {
                sizes.extend(collect_tree_sizes(tree, &paths, &output.output.stdout));
                names.retain(|name| {
                    name.split_once(':')
                        .is_none_or(|(revision, _)| revision != tree)
                });
            }
        }
    }
    if names.is_empty() {
        return sizes;
    }
    let (program, args) = batch_check_command(git, root);
    let Ok(scheduled) = backend
        .scheduler
        .execute(GitJob {
            repo_key: repo_key(root),
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation,
            program,
            args,
            stdin: Some(batch_input(&names)),
            truncate_stdout: false,
            output_limit: None,
            env: Vec::new(),
        })
        .await
    else {
        return sizes;
    };
    if scheduled.output.exit_code != 0 {
        return sizes;
    }
    sizes.extend(collect(&names, &scheduled.output.stdout));
    sizes
}

/// 写锁内的同一读取，走 guard.run，避免再进调度器造成死锁。
pub async fn object_sizes_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    names: &[String],
) -> HashMap<String, u64> {
    let mut names = batch_names(names);
    let mut sizes = HashMap::new();
    for (tree, paths) in tree_batches(&names) {
        let (program, args) = tree_sizes_command(git, root, tree);
        let output = guard
            .run(CommandSpec {
                program,
                args,
                stdin: None,
                truncate_stdout: false,
                output_limit: None,
                writes: false,
            })
            .await;
        if let Ok(output) = output {
            if output.exit_code == 0 {
                sizes.extend(collect_tree_sizes(tree, &paths, &output.stdout));
                names.retain(|name| {
                    name.split_once(':')
                        .is_none_or(|(revision, _)| revision != tree)
                });
            }
        }
    }
    if names.is_empty() {
        return sizes;
    }
    let (program, args) = batch_check_command(git, root);
    let Ok(output) = guard
        .run(CommandSpec {
            program,
            args,
            stdin: Some(batch_input(&names)),
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await
    else {
        return sizes;
    };
    if output.exit_code != 0 {
        return sizes;
    }
    sizes.extend(collect(&names, &output.stdout));
    sizes
}

/// 工作区里的文件大小；不存在、不是普通文件（符号链接、目录）时为空。
pub fn worktree_size(root: &Path, path: &str) -> Option<u64> {
    let relative = safe_relative(path).ok()?;
    let meta = root.join(relative).symlink_metadata().ok()?;
    meta.is_file().then_some(meta.len())
}

/// `HEAD:<路径>`：已暂存改动的「改动前」。
pub fn head_name(path: &str) -> String {
    format!("HEAD:{path}")
}

/// `:<路径>`：索引里的版本，既是已暂存改动的「改动后」，也是未暂存改动的「改动前」。
pub fn index_name(path: &str) -> String {
    format!(":{path}")
}

/// `<提交>:<路径>`：提交或父提交里的版本。
pub fn tree_name(tree: &str, path: &str) -> String {
    format!("{tree}:{path}")
}

/// 状态里每个二进制条目需要的对象名：已暂存看 HEAD 与索引，未暂存看索引（另一侧是工作区文件）。
pub fn status_requests(files: &[FileChange]) -> Vec<String> {
    let mut names = Vec::new();
    for file in files {
        if file.untracked {
            continue;
        }
        if file.staged_lines.as_ref().is_some_and(is_binary) {
            names.push(head_name(
                file.original_path.as_deref().unwrap_or(&file.path),
            ));
            names.push(index_name(&file.path));
        }
        if file.unstaged_lines.as_ref().is_some_and(is_binary) {
            names.push(index_name(&file.path));
        }
    }
    names.sort();
    names.dedup();
    names
}

/// 把读到的大小填回状态里的二进制条目。删除、新增时缺的一侧留空。
pub fn apply_status_sizes(root: &Path, files: &mut [FileChange], sizes: &HashMap<String, u64>) {
    for file in files {
        if file.untracked {
            if let Some(stat) = file.unstaged_lines.as_mut().filter(|stat| is_binary(stat)) {
                stat.old_size = None;
                stat.new_size = worktree_size(root, &file.path);
            }
            continue;
        }
        if let Some(stat) = file.staged_lines.as_mut().filter(|stat| is_binary(stat)) {
            let old = head_name(file.original_path.as_deref().unwrap_or(&file.path));
            stat.old_size = sizes.get(&old).copied();
            stat.new_size = if file.staged == ChangeKind::Deleted {
                None
            } else {
                sizes.get(&index_name(&file.path)).copied()
            };
        }
        if let Some(stat) = file.unstaged_lines.as_mut().filter(|stat| is_binary(stat)) {
            stat.old_size = sizes.get(&index_name(&file.path)).copied();
            stat.new_size = if file.unstaged == ChangeKind::Deleted {
                None
            } else {
                worktree_size(root, &file.path)
            };
        }
    }
}

/// 状态读取后补二进制大小（不持写锁）。
pub async fn decorate_status_sizes(
    backend: &Backend,
    git: &Path,
    root: &Path,
    generation: u64,
    files: &mut [FileChange],
) {
    if !files.iter().any(has_binary) {
        return;
    }
    let names = status_requests(files);
    let sizes = object_sizes(backend, git, root, generation, &names).await;
    apply_status_sizes(root, files, &sizes);
}

/// 写锁内补二进制大小。
pub async fn decorate_status_sizes_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    files: &mut [FileChange],
) {
    if !files.iter().any(has_binary) {
        return;
    }
    let names = status_requests(files);
    let sizes = object_sizes_guard(guard, git, root, &names).await;
    apply_status_sizes(root, files, &sizes);
}

fn has_binary(file: &FileChange) -> bool {
    file.staged_lines.as_ref().is_some_and(is_binary)
        || file.unstaged_lines.as_ref().is_some_and(is_binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn large_tree_and_index_reads_match_inside_and_outside_write_guard() {
        use crate::test_support::{git_fixture, isolated_gitconfig, system_git};
        use std::io::Write;
        use std::process::{Command, Stdio};

        let fixture = git_fixture("large-size-batch");
        let root = fixture.repo("demo");
        let git = system_git();
        let run = |args: &[&str], input: Option<&[u8]>| {
            let mut child = Command::new(&git)
                .current_dir(&root)
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
            if let Some(input) = input {
                child.stdin.take().unwrap().write_all(input).unwrap();
            }
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "-b", "main"], None);
        let mut input = String::from("blob\nmark :1\ndata 2\nx\n\ncommit refs/heads/main\ncommitter Test <test@example.com> 1700000000 +0000\ndata 4\nbase\n");
        for i in 0..TREE_SCAN_THRESHOLD {
            input.push_str(&format!("M 100644 :1 file-{i}\n"));
        }
        input.push_str("\ndone\n");
        run(&["fast-import", "--quiet"], Some(input.as_bytes()));
        run(&["read-tree", "HEAD"], None);
        let trace = fixture.path().join("trace.log");
        let backend = fixture
            .backend_with_extra_env(vec![("GIT_TRACE".into(), trace.as_os_str().to_os_string())]);
        let key = repo_key(&root);
        let generation = backend.scheduler.current_generation(&key);
        let mut names: Vec<String> = (0..TREE_SCAN_THRESHOLD)
            .flat_map(|i| {
                [
                    head_name(&format!("file-{i}")),
                    index_name(&format!("file-{i}")),
                ]
            })
            .collect();
        names.extend([head_name("missing"), index_name("missing")]);
        let sizes = object_sizes(&backend, &git, &root, generation, &names).await;
        assert_eq!(sizes.len(), TREE_SCAN_THRESHOLD * 2);
        assert!(sizes.values().all(|size| *size == 2));
        let mut guard = backend
            .scheduler
            .lock_write(&key, 701, generation)
            .await
            .unwrap();
        assert_eq!(
            object_sizes_guard(&mut guard, &git, &root, &names).await,
            sizes
        );
        guard.finish();
        let trace = std::fs::read_to_string(trace).unwrap();
        assert_eq!(
            trace
                .lines()
                .filter(|line| line.contains("built-in: git ls-tree "))
                .count(),
            2
        );
        assert_eq!(
            trace
                .lines()
                .filter(|line| line.contains("built-in: git cat-file "))
                .count(),
            2
        );

        run(&["update-index", "--force-remove", "file-0"], None);
        let next = backend.scheduler.bump_generation(&key);
        assert!(object_sizes(&backend, &git, &root, generation, &names)
            .await
            .is_empty());
        let updated = object_sizes(&backend, &git, &root, next, &names).await;
        assert_eq!(updated.get("HEAD:file-0"), Some(&2));
        assert!(!updated.contains_key(":file-0"));
    }

    #[test]
    fn parses_sizes_missing_and_non_blobs_in_order() {
        let stdout = b"aaaa blob 1234\nHEAD:gone.png missing\nbbbb tree 96\ncccc blob 0\n";
        assert_eq!(
            parse_batch_check(stdout, 4),
            vec![Some(1234), None, None, Some(0)]
        );
        // 输出比请求少时补空，不会错位到别的文件上。
        assert_eq!(
            parse_batch_check(b"aaaa blob 7\n", 3),
            vec![Some(7), None, None]
        );
        assert_eq!(
            parse_batch_check(b"blob 1234\nHEAD:gone.png missing\ntree 96\nblob 0\n", 4),
            vec![Some(1234), None, None, Some(0)]
        );
    }

    #[test]
    fn batch_omits_duplicate_and_unusable_names_without_shifting_results() {
        let names: Vec<String> = [
            "HEAD:a",
            "HEAD:a",
            "HEAD:bad\nname",
            ":b",
            "HEAD:missing",
            "HEAD:c",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let names = batch_names(&names);
        assert_eq!(batch_input(&names), b"HEAD:a\n:b\nHEAD:missing\nHEAD:c\n");
        assert_eq!(
            collect(&names, b"blob 7\nblob 9\nHEAD:missing missing\nblob 0\n"),
            HashMap::from([
                ("HEAD:a".to_string(), 7),
                (":b".to_string(), 9),
                ("HEAD:c".to_string(), 0),
            ])
        );
    }

    #[test]
    fn large_tree_requests_do_not_include_index_names_or_arbitrary_revisions() {
        let mut names: Vec<String> = (0..TREE_SCAN_THRESHOLD)
            .flat_map(|i| {
                [
                    format!("HEAD:file-{i}"),
                    format!(":file-{i}"),
                    format!("--bad:file-{i}"),
                ]
            })
            .collect();
        names.push("other:one".to_string());
        let borrowed = batch_names(&names);
        let batches = tree_batches(&borrowed);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].0, "HEAD");
        assert_eq!(batches[0].1.len(), TREE_SCAN_THRESHOLD);
        let sizes = collect_tree_sizes(
            "HEAD",
            &HashSet::from(["file-0", "a\tb", "missing", "submodule"]),
            b"blob 7\tfile-0\0blob 0\ta\tb\0blob 99\tunrequested\0commit -\tsubmodule\0",
        );
        assert_eq!(
            sizes,
            HashMap::from([("HEAD:file-0".to_string(), 7), ("HEAD:a\tb".to_string(), 0)])
        );
    }

    #[test]
    fn formats_sizes_like_the_interface() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(1023), "1023 B");
        assert_eq!(format_size(1024), "1 KB");
        assert_eq!(format_size(1536), "1.5 KB");
        assert_eq!(format_size(12 * 1024 + 300), "12 KB");
        assert_eq!(format_size(3 * 1024 * 1024 + 400 * 1024), "3.4 MB");
        assert_eq!(
            binary_summary(Some(1024), Some(2048)),
            "二进制文件有变化：1 KB → 2 KB。"
        );
        assert_eq!(
            binary_summary(None, None),
            "二进制文件有变化，但不能按文本预览。"
        );
    }

    #[test]
    fn names_with_line_breaks_are_not_requested() {
        assert!(usable("HEAD:img/a b.png"));
        assert!(!usable("HEAD:bad\nname.png"));
        assert!(!usable(""));
    }

    #[test]
    fn status_requests_cover_both_sides_and_follow_renames() {
        let binary = LineStat {
            additions: None,
            deletions: None,
            old_size: None,
            new_size: None,
        };
        let text = LineStat {
            additions: Some(1),
            deletions: Some(0),
            old_size: None,
            new_size: None,
        };
        let files = vec![
            FileChange {
                path: "img/new.png".into(),
                original_path: Some("img/old.png".into()),
                staged: ChangeKind::Renamed,
                unstaged: ChangeKind::None,
                untracked: false,
                unmerged: false,
                staged_lines: Some(binary),
                unstaged_lines: None,
            },
            FileChange {
                path: "logo.png".into(),
                original_path: None,
                staged: ChangeKind::None,
                unstaged: ChangeKind::Modified,
                untracked: false,
                unmerged: false,
                staged_lines: None,
                unstaged_lines: Some(binary),
            },
            FileChange {
                path: "a.txt".into(),
                original_path: None,
                staged: ChangeKind::Modified,
                unstaged: ChangeKind::None,
                untracked: false,
                unmerged: false,
                staged_lines: Some(text),
                unstaged_lines: None,
            },
        ];
        assert_eq!(
            status_requests(&files),
            vec![":img/new.png", ":logo.png", "HEAD:img/old.png"]
        );

        let mut files = files;
        let sizes = HashMap::from([
            ("HEAD:img/old.png".to_string(), 100),
            (":img/new.png".to_string(), 120),
            (":logo.png".to_string(), 2048),
        ]);
        apply_status_sizes(Path::new("/nonexistent-root"), &mut files, &sizes);
        let renamed = files[0].staged_lines.unwrap();
        assert_eq!((renamed.old_size, renamed.new_size), (Some(100), Some(120)));
        // 工作区文件读不到时只留改动前的大小。
        let worktree = files[1].unstaged_lines.unwrap();
        assert_eq!((worktree.old_size, worktree.new_size), (Some(2048), None));
        assert_eq!(files[2].staged_lines.unwrap().old_size, None);
    }
}
