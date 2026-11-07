use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use crate::error::AppError;
use crate::git::command::{ignore_check_command, index_paths_command};
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, safe_relative, validate_input_path,
    Backend,
};
use crate::git::preview::wants_preview;
use crate::git::schedule::{internal_request_id, GitJob, JobKind};
use crate::model::{
    RepositoryDirectory, RepositoryDirectoryEntry, RepositoryEntryKind, RepositoryFileContent,
    RepositoryFileKind,
};
use crate::shutdown::Shutdown;

const DEFAULT_PAGE_LINES: usize = 500;
const MAX_PAGE_LINES: usize = 1000;
const MAX_PAGE_BYTES: usize = 256 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const PROBE_BYTES: usize = 8000;
/// 一份索引路径快照最多解析多少条路径；超过就退化为"不隐藏"，而不是继续堆内存。
const MAX_INDEX_ENTRIES: usize = 300_000;
/// `ls-files` 的 stdout 上限（约 24 MiB）：超过即认为无法完整判定索引。
const MAX_INDEX_BYTES: usize = 24 * 1024 * 1024;

fn check_cancel(cancel: &Shutdown) -> Result<(), AppError> {
    if cancel.is_cancelled() {
        Err(AppError::new("cancelled", "读取已取消。"))
    } else {
        Ok(())
    }
}

fn relative_directory(path: &str) -> Result<PathBuf, AppError> {
    if path.is_empty() {
        return Ok(PathBuf::new());
    }
    safe_relative(path)
}

fn display_path(relative: &Path) -> String {
    relative.to_string_lossy().replace('\\', "/")
}

/// 逐级检查路径分量，拒绝符号链接与不存在的中途分量。
fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), AppError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let meta = current.symlink_metadata().map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                AppError::new("path_missing", "路径不存在。")
            } else {
                AppError::new("path_unreadable", "无法读取路径。")
            }
        })?;
        if meta.file_type().is_symlink() {
            return Err(AppError::new(
                "file_path",
                "不跟随符号链接读取仓库文件或目录。",
            ));
        }
    }
    Ok(())
}

/// 读取一个目录的直接子项。后代目录只在被展开时单独读取。
fn read_directory(
    root: PathBuf,
    relative: PathBuf,
    cancel: Arc<Shutdown>,
) -> Result<(Vec<RepositoryDirectoryEntry>, Vec<String>), AppError> {
    check_cancel(&cancel)?;
    reject_symlink_components(&root, &relative)?;
    let directory = canonical_existing(&root.join(&relative))?;
    if !directory.starts_with(&root) || !directory.is_dir() {
        return Err(AppError::new("file_path", "目录必须位于当前仓库内。"));
    }
    let mut entries = Vec::new();
    let mut errors = Vec::new();
    for item in fs::read_dir(&directory).map_err(|error| {
        AppError::new(
            if error.kind() == ErrorKind::PermissionDenied {
                "permission"
            } else {
                "path_unreadable"
            },
            format!("无法读取目录：{error}"),
        )
    })? {
        check_cancel(&cancel)?;
        let item = match item {
            Ok(item) => item,
            Err(error) => {
                errors.push(format!("一个目录项无法读取：{error}"));
                continue;
            }
        };
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let path = if relative.as_os_str().is_empty() {
            name.clone()
        } else {
            format!("{}/{}", display_path(&relative), name)
        };
        let mut entry = RepositoryDirectoryEntry {
            name,
            path,
            kind: RepositoryEntryKind::Error,
            ignored: false,
            size: None,
            error: None,
        };
        match item.path().symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => {
                entry.kind = RepositoryEntryKind::Symlink;
            }
            Ok(meta) if meta.is_dir() => {
                entry.kind = if item.path().join(".git").symlink_metadata().is_ok() {
                    RepositoryEntryKind::NestedRepository
                } else {
                    RepositoryEntryKind::Directory
                };
            }
            Ok(meta) if meta.is_file() => {
                entry.kind = RepositoryEntryKind::File;
                entry.size = Some(meta.len());
            }
            Ok(_) => entry.kind = RepositoryEntryKind::Special,
            Err(error) => entry.error = Some(format!("无法读取目录项类型：{error}")),
        }
        entries.push(entry);
    }
    entries.sort_by(|left, right| {
        let left_dir = is_directory_entry(left.kind);
        let right_dir = is_directory_entry(right.kind);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok((entries, errors))
}

fn is_directory_entry(kind: RepositoryEntryKind) -> bool {
    matches!(
        kind,
        RepositoryEntryKind::Directory | RepositoryEntryKind::NestedRepository
    )
}

/// 把本目录的直接子项拼成 `git check-ignore --stdin` 的输入（NUL 分隔，末尾同样带分隔符）。
fn ignore_input(entries: &[RepositoryDirectoryEntry]) -> Vec<u8> {
    let mut input = Vec::new();
    for entry in entries {
        let mut path = entry.path.clone();
        if is_directory_entry(entry.kind) {
            // 目录必须带尾部路径分隔符，Git 才会用 `dir/` 这类只匹配目录的模式判定。
            path.push('/');
        }
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    input
}

/// 一份索引路径快照：用来判断某个直接子项是否已被 Git 跟踪。
///
/// 选择与边界（判定"是否忽略"必须同时看规则和索引）：
/// - 只在当前目录真的出现"被规则匹配"的子项时才加载，并按 repo_key + generation 缓存一份，
///   所以同一代次内展开多少个目录都只跑一次 `git ls-files`，不会每个目录重复全仓扫描；
/// - 失效只靠代次：写操作和外部工作区变化都会 bump generation，代次不同就重新读取，
///   换仓库（root 不同）也不复用，避免把上一个仓库的索引用到新仓库；
/// - 内存有界：无论多少条路径都只保留这些路径本身和它们的祖先目录；
///   一旦超过 `MAX_INDEX_ENTRIES` 条或 `MAX_INDEX_BYTES` 输出上限，就标记 degraded，
///   此时把每个路径都当成"可能已被跟踪"，只会少隐藏，绝不会把已跟踪文件藏起来。
struct TrackedIndex {
    files: HashSet<Box<str>>,
    dirs: HashSet<Box<str>>,
    degraded: bool,
}

impl TrackedIndex {
    fn degraded() -> Self {
        Self {
            files: HashSet::new(),
            dirs: HashSet::new(),
            degraded: true,
        }
    }

    fn parse(stdout: &[u8], truncated: bool) -> Self {
        if truncated {
            return Self::degraded();
        }
        let mut index = Self {
            files: HashSet::new(),
            dirs: HashSet::new(),
            degraded: false,
        };
        for raw in stdout.split(|byte| *byte == 0) {
            if raw.is_empty() {
                continue;
            }
            let path = String::from_utf8_lossy(raw).replace('\\', "/");
            index.files.insert(path.clone().into_boxed_str());
            // 索引里只有文件：把祖先目录也记下来，这样"含已跟踪文件的目录"不会被忽略规则藏起来。
            // 必须从仓库根累积完整前缀（src/a/b.rs -> src、src/a），只记末段会让深层目录查不到。
            for end in path.match_indices('/').map(|(offset, _)| offset) {
                index.dirs.insert(path[..end].to_string().into_boxed_str());
            }
            if index.files.len() + index.dirs.len() > MAX_INDEX_ENTRIES {
                return Self::degraded();
            }
        }
        index
    }

    fn is_tracked(&self, path: &str) -> bool {
        self.degraded || self.files.contains(path) || self.dirs.contains(path)
    }
}

/// 每个仓库代次最多一份索引快照；只保留最近用到的那个仓库，内存不会随目录数增长。
static TRACKED_INDEX_CACHE: StdMutex<Option<CachedTrackedIndex>> = StdMutex::new(None);

struct CachedTrackedIndex {
    root: PathBuf,
    generation: u64,
    index: Arc<TrackedIndex>,
}

fn cached_tracked_index(root: &Path, generation: u64) -> Option<Arc<TrackedIndex>> {
    let cache = TRACKED_INDEX_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache
        .as_ref()
        .filter(|entry| entry.root == root && entry.generation == generation)
        .map(|entry| entry.index.clone())
}

fn store_tracked_index(root: &Path, generation: u64, index: &Arc<TrackedIndex>) {
    let mut cache = TRACKED_INDEX_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *cache = Some(CachedTrackedIndex {
        root: root.to_path_buf(),
        generation,
        index: index.clone(),
    });
}

async fn tracked_index(
    backend: &Backend,
    root: &Path,
    key: &str,
    generation: u64,
) -> Result<Arc<TrackedIndex>, AppError> {
    if let Some(index) = cached_tracked_index(root, generation) {
        return Ok(index);
    }
    let git = require_git(backend).await?;
    let (program, args) = index_paths_command(&git.path, root);
    let output = backend
        .scheduler
        .execute(GitJob {
            repo_key: key.to_string(),
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation,
            program,
            args,
            stdin: None,
            // 超限时保留已读到的部分并标记截断，由 TrackedIndex 退化为"不隐藏"，而不是让目录读取失败。
            truncate_stdout: true,
            output_limit: Some(MAX_INDEX_BYTES),
            env: Vec::new(),
        })
        .await?;
    if output.output.exit_code != 0 {
        return Err(git_failure(
            "index_check",
            &output.output,
            "无法读取 Git 索引，不能判断文件是否已被跟踪。",
        ));
    }
    let index = Arc::new(TrackedIndex::parse(
        &output.output.stdout,
        output.output.stdout_truncated,
    ));
    store_tracked_index(root, generation, &index);
    Ok(index)
}

/// 只把本目录直接子项交给 Git 与忽略规则匹配：不枚举、也不读取任何未展开的后代。
///
/// 返回的是"路径本身匹配了某条排除规则"的子项。`check-ignore` 默认也会跳过索引里已有的路径，
/// 但调用方仍要按索引复核一次（见 `TrackedIndex`）：忽略规则永远不该让已跟踪路径消失。
async fn ignore_rule_matches(
    backend: &Backend,
    root: &Path,
    key: String,
    generation: u64,
    entries: &[RepositoryDirectoryEntry],
) -> Result<HashSet<Vec<u8>>, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = ignore_check_command(&git.path, root);
    let output = backend
        .scheduler
        .execute(GitJob {
            repo_key: key,
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation,
            program,
            args,
            stdin: Some(ignore_input(entries)),
            truncate_stdout: false,
            output_limit: None,
            env: Vec::new(),
        })
        .await?;
    // 0 表示有子项被忽略，1 表示一个都没有；其他退出码才是真的失败。
    if !matches!(output.output.exit_code, 0 | 1) {
        return Err(git_failure(
            "ignore_check",
            &output.output,
            "无法判断目录忽略状态。",
        ));
    }
    Ok(output
        .output
        .stdout
        .split(|byte| *byte == 0)
        .map(|path| path.strip_suffix(b"/".as_slice()).unwrap_or(path))
        .filter(|path| !path.is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

pub async fn repository_directory(
    backend: &Backend,
    path: &str,
    relative: &str,
    include_ignored: bool,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryDirectory, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = relative_directory(relative)?;
    let relative_text = display_path(&relative_path);
    let key = repo_key(&root);
    let task_root = root.clone();
    let task_relative = relative_path.clone();
    let (mut entries, errors) = backend
        .scheduler
        .execute_blocking_read(&key, request_id, generation, move |cancel| {
            read_directory(task_root, task_relative, cancel)
        })
        .await?;
    if !entries.is_empty() {
        let matched =
            ignore_rule_matches(backend, &root, key.clone(), generation, &entries).await?;
        if !matched.is_empty() {
            // 规则匹配只是"可以被忽略"：还必须确认它不在索引里，已跟踪路径不算忽略项。
            let tracked = tracked_index(backend, &root, &key, generation).await?;
            for entry in &mut entries {
                entry.ignored =
                    matched.contains(entry.path.as_bytes()) && !tracked.is_tracked(&entry.path);
            }
        }
    }
    if !include_ignored {
        entries.retain(|entry| !entry.ignored);
    }
    Ok(RepositoryDirectory {
        generation,
        path: relative_text,
        entries,
        errors,
    })
}

fn empty_content(
    path: &str,
    kind: RepositoryFileKind,
    size: u64,
    offset: u64,
    message: &str,
) -> RepositoryFileContent {
    RepositoryFileContent {
        generation: 0,
        path: path.into(),
        kind,
        size,
        offset,
        lines: Vec::new(),
        next_offset: offset,
        has_more: false,
        truncated: false,
        message: (!message.is_empty()).then(|| message.into()),
    }
}

#[derive(Debug, Default)]
struct LineChunk {
    any: bool,
    truncated: bool,
    binary: bool,
}

/// 读取一行，最多保留 \`max\` 字节；超出部分整行消费但不保留，避免超长行撑爆内存。
///
/// 每消费一个读取块都观察取消令牌：极长单行需要连续多块消费，不能等到整行结束才响应取消。
fn read_line_chunk<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    max: usize,
    cancel: &Shutdown,
) -> Result<LineChunk, AppError> {
    buffer.clear();
    let mut chunk = LineChunk::default();
    loop {
        check_cancel(cancel)?;
        let consumed;
        let mut at_line_end = false;
        {
            let available = reader.fill_buf().map_err(|error| {
                AppError::new("path_unreadable", format!("无法读取文件：{error}"))
            })?;
            if available.is_empty() {
                return Ok(chunk);
            }
            chunk.any = true;
            consumed = match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => {
                    at_line_end = true;
                    index + 1
                }
                None => available.len(),
            };
            let head = &available[..consumed];
            if head.contains(&0) {
                chunk.binary = true;
            }
            let room = max.saturating_sub(buffer.len());
            let take = consumed.min(room);
            buffer.extend_from_slice(&head[..take]);
            if take < consumed {
                chunk.truncated = true;
            }
        }
        reader.consume(consumed);
        if at_line_end {
            return Ok(chunk);
        }
    }
}

fn strip_line_end(buffer: &mut Vec<u8>) {
    if buffer.last() == Some(&b'\n') {
        buffer.pop();
        if buffer.last() == Some(&b'\r') {
            buffer.pop();
        }
    }
}

/// 按行偏移读取一页文本；非 UTF-8、二进制、缺失与资源各自返回真实类型。
fn read_text_page(
    root: PathBuf,
    relative: PathBuf,
    offset: u64,
    limit: usize,
    cancel: Arc<Shutdown>,
) -> Result<RepositoryFileContent, AppError> {
    check_cancel(&cancel)?;
    let display = display_path(&relative);
    let candidate = root.join(&relative);
    let meta = match candidate.symlink_metadata() {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(empty_content(
                &display,
                RepositoryFileKind::Missing,
                0,
                offset,
                "文件不存在。",
            ));
        }
        Err(error) => {
            return Err(AppError::new(
                "path_unreadable",
                format!("无法读取文件：{error}"),
            ));
        }
    };
    if meta.file_type().is_symlink() {
        return Err(AppError::new(
            "file_path",
            "不跟随符号链接读取仓库文件或目录。",
        ));
    }
    reject_symlink_components(&root, &relative)?;
    if !meta.is_file() {
        return Ok(empty_content(
            &display,
            RepositoryFileKind::Special,
            meta.len(),
            offset,
            "仅支持普通文本文件。",
        ));
    }
    let resolved = canonical_existing(&candidate)?;
    if !resolved.starts_with(&root) {
        return Err(AppError::new("file_path", "文件必须位于当前仓库内。"));
    }
    let mut file = fs::File::open(&resolved)
        .map_err(|error| AppError::new("path_unreadable", format!("无法打开文件：{error}")))?;
    let mut probe = [0_u8; PROBE_BYTES];
    let count = file
        .read(&mut probe)
        .map_err(|error| AppError::new("path_unreadable", format!("无法读取文件：{error}")))?;
    let probe = &probe[..count];
    if wants_preview(&display, probe) {
        return Ok(empty_content(
            &display,
            RepositoryFileKind::Resource,
            meta.len(),
            offset,
            "此文件使用只读资源预览。",
        ));
    }
    if probe.contains(&0) {
        return Ok(empty_content(
            &display,
            RepositoryFileKind::Binary,
            meta.len(),
            offset,
            "二进制内容不作为文本读取。",
        ));
    }
    let chain = std::io::Cursor::new(probe.to_vec()).chain(file);
    let mut reader = BufReader::new(chain);
    let mut skipped = 0_u64;
    let mut buffer = Vec::new();
    while skipped < offset {
        check_cancel(&cancel)?;
        let chunk = read_line_chunk(&mut reader, &mut buffer, MAX_LINE_BYTES, &cancel)?;
        if !chunk.any {
            return Ok(empty_content(
                &display,
                RepositoryFileKind::Text,
                meta.len(),
                offset,
                "",
            ));
        }
        if chunk.binary {
            return Ok(empty_content(
                &display,
                RepositoryFileKind::Binary,
                meta.len(),
                offset,
                "二进制内容不作为文本读取。",
            ));
        }
        skipped += 1;
    }
    let mut lines: Vec<String> = Vec::new();
    let mut bytes = 0_usize;
    let mut truncated = false;
    let mut dropped = false;
    while lines.len() < limit {
        check_cancel(&cancel)?;
        let chunk = read_line_chunk(&mut reader, &mut buffer, MAX_LINE_BYTES, &cancel)?;
        if !chunk.any {
            break;
        }
        if chunk.binary {
            return Ok(empty_content(
                &display,
                RepositoryFileKind::Binary,
                meta.len(),
                offset,
                "二进制内容不作为文本读取。",
            ));
        }
        if !chunk.truncated {
            strip_line_end(&mut buffer);
        }
        let mut end = buffer.len();
        if chunk.truncated {
            while end > 0 && std::str::from_utf8(&buffer[..end]).is_err() {
                end -= 1;
            }
        }
        if !lines.is_empty() && bytes + end > MAX_PAGE_BYTES {
            // 这一行留给下一页，保证单页字节预算；行内容可按偏移重新读取。
            dropped = true;
            break;
        }
        let line = match String::from_utf8(buffer[..end].to_vec()) {
            Ok(line) => line,
            Err(_) => {
                return Ok(empty_content(
                    &display,
                    RepositoryFileKind::InvalidUtf8,
                    meta.len(),
                    offset,
                    "文件不是有效 UTF-8 文本。",
                ));
            }
        };
        truncated |= chunk.truncated;
        bytes += line.len();
        lines.push(line);
        if bytes >= MAX_PAGE_BYTES {
            break;
        }
    }
    let has_more = if dropped {
        true
    } else {
        !reader
            .fill_buf()
            .map_err(|error| AppError::new("path_unreadable", format!("无法读取文件：{error}")))?
            .is_empty()
    };
    Ok(RepositoryFileContent {
        generation: 0,
        path: display,
        kind: RepositoryFileKind::Text,
        size: meta.len(),
        offset,
        next_offset: offset + lines.len() as u64,
        lines,
        has_more,
        truncated,
        message: truncated.then(|| "部分超长行已截断。".into()),
    })
}

pub async fn repository_file_content(
    backend: &Backend,
    path: &str,
    relative: &str,
    offset: u64,
    limit: Option<usize>,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryFileContent, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = safe_relative(relative)?;
    let limit = limit.unwrap_or(DEFAULT_PAGE_LINES).clamp(1, MAX_PAGE_LINES);
    let mut result = backend
        .scheduler
        .execute_blocking_read(&repo_key(&root), request_id, generation, move |cancel| {
            read_text_page(root, relative_path, offset, limit, cancel)
        })
        .await?;
    result.generation = generation;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new(crate::test_support::system_git())
            .current_dir(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn directory_is_direct_sorted_and_honours_ignore_switch() {
        let fixture = crate::test_support::git_fixture("repository-files-directory");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::create_dir_all(root.join("child/.git")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        fs::write(root.join("z.txt"), "z").unwrap();
        fs::write(root.join("debug.log"), "ignored").unwrap();
        fs::write(root.join("ignored/file.txt"), "ignored").unwrap();
        fs::write(root.join("src/nested/deep.txt"), "not read").unwrap();
        let path = root.to_str().unwrap();
        let visible = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        let names: Vec<_> = visible
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["child", "empty", "src", ".gitignore", "z.txt"]);
        assert_eq!(
            visible.entries[0].kind,
            RepositoryEntryKind::NestedRepository
        );
        assert!(visible.entries.iter().all(|entry| entry.name != "deep.txt"));
        let all = repository_directory(&backend, path, "", true, 1, 2)
            .await
            .unwrap();
        assert!(all
            .entries
            .iter()
            .any(|entry| entry.name == "debug.log" && entry.ignored));
        assert!(all
            .entries
            .iter()
            .any(|entry| entry.name == "ignored" && entry.ignored));
        let empty = repository_directory(&backend, path, "empty", false, 1, 3)
            .await
            .unwrap();
        assert!(empty.entries.is_empty());
        let nested = repository_directory(&backend, path, "src", false, 1, 4)
            .await
            .unwrap();
        assert_eq!(nested.entries[0].name, "nested");
        assert!(repository_directory(&backend, path, "../", false, 1, 5)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn deep_ignored_entries_stay_hidden_until_their_parent_is_expanded() {
        let fixture = crate::test_support::git_fixture("repository-files-deep-ignore");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src/deep/inner")).unwrap();
        fs::create_dir_all(root.join("ignored/nested")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        fs::write(root.join("src/visible.txt"), "visible").unwrap();
        fs::write(root.join("src/trace.log"), "ignored").unwrap();
        fs::write(root.join("src/deep/inner/debug.log"), "ignored").unwrap();
        fs::write(root.join("ignored/nested/file.txt"), "ignored").unwrap();
        let path = root.to_str().unwrap();

        let root_visible = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        let names: Vec<_> = root_visible
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["src", ".gitignore"]);
        let root_all = repository_directory(&backend, path, "", true, 1, 2)
            .await
            .unwrap();
        let names: Vec<_> = root_all
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        // 被忽略目录只出现自身，其后代永远不因为父目录而被枚举出来。
        assert_eq!(names, ["ignored", "src", ".gitignore"]);
        assert!(root_all
            .entries
            .iter()
            .any(|entry| entry.name == "ignored" && entry.ignored));
        assert!(root_all
            .entries
            .iter()
            .all(|entry| entry.name != "nested" && entry.name != "file.txt"));
        assert!(root_all
            .entries
            .iter()
            .any(|entry| entry.name == "src" && !entry.ignored));

        // 非忽略目录里存在更深层的忽略文件，也只返回直接子项。
        let src_visible = repository_directory(&backend, path, "src", false, 1, 3)
            .await
            .unwrap();
        let names: Vec<_> = src_visible
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["deep", "visible.txt"]);
        let src_all = repository_directory(&backend, path, "src", true, 1, 4)
            .await
            .unwrap();
        assert!(src_all
            .entries
            .iter()
            .any(|entry| entry.name == "trace.log" && entry.ignored));
        assert!(src_all
            .entries
            .iter()
            .any(|entry| entry.name == "deep" && !entry.ignored));

        let deep = repository_directory(&backend, path, "src/deep", false, 1, 5)
            .await
            .unwrap();
        assert_eq!(deep.entries.len(), 1);
        assert_eq!(deep.entries[0].name, "inner");
        assert!(!deep.entries[0].ignored);
        let inner_visible = repository_directory(&backend, path, "src/deep/inner", false, 1, 6)
            .await
            .unwrap();
        assert!(inner_visible.entries.is_empty());
        let inner_all = repository_directory(&backend, path, "src/deep/inner", true, 1, 7)
            .await
            .unwrap();
        assert_eq!(inner_all.entries.len(), 1);
        assert!(inner_all.entries[0].ignored);
    }

    #[tokio::test]
    async fn tracked_paths_in_deep_ignored_directories_stay_visible() {
        // 真实 Git 回归：多层目录本身匹配忽略规则，但目录内仍有已跟踪文件。
        // 目录规则只能隐藏"完全未跟踪的子树"，不能因为只看末段前缀就丢掉 docs/generated 这类深层目录。
        let fixture = crate::test_support::git_fixture("repository-files-tracked-deep-ignore");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("docs/generated/nested")).unwrap();
        fs::write(root.join(".gitignore"), "generated/\n*.log\n").unwrap();
        fs::write(root.join("docs/generated/tracked.md"), "tracked").unwrap();
        fs::write(root.join("docs/generated/notes.log"), "untracked").unwrap();
        fs::write(root.join("docs/generated/scratch.tmp"), "untracked").unwrap();
        fs::write(root.join("docs/generated/nested/tracked.txt"), "tracked").unwrap();
        fs::write(root.join("docs/generated/nested/other.tmp"), "untracked").unwrap();
        git(
            &root,
            &[
                "add",
                "-f",
                ".gitignore",
                "docs/generated/tracked.md",
                "docs/generated/nested/tracked.txt",
            ],
        );
        let path = root.to_str().unwrap();

        // 根：docs 只是"含已跟踪文件"，不是忽略项。
        let top = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        assert_eq!(names_of(&top), ["docs", ".gitignore"]);
        assert_eq!(ignored_of(&top, "docs"), Some(false));

        // 关键断言：docs/generated 本身匹配 "generated/"，但它含已跟踪文件，所以仍要可见且 ignored=false。
        let docs = repository_directory(&backend, path, "docs", false, 1, 2)
            .await
            .unwrap();
        assert_eq!(names_of(&docs), ["generated"]);
        assert_eq!(ignored_of(&docs, "generated"), Some(false));

        // 同一目录树里未跟踪的忽略文件仍按开关处理：关闭时隐藏，打开时出现并标记 ignored。
        let generated_visible = repository_directory(&backend, path, "docs/generated", false, 1, 3)
            .await
            .unwrap();
        assert_eq!(names_of(&generated_visible), ["nested", "tracked.md"]);
        assert_eq!(ignored_of(&generated_visible, "nested"), Some(false));
        assert_eq!(ignored_of(&generated_visible, "tracked.md"), Some(false));
        assert_eq!(ignored_of(&generated_visible, "notes.log"), None);
        assert_eq!(ignored_of(&generated_visible, "scratch.tmp"), None);
        let generated_all = repository_directory(&backend, path, "docs/generated", true, 1, 4)
            .await
            .unwrap();
        assert_eq!(ignored_of(&generated_all, "tracked.md"), Some(false));
        assert_eq!(ignored_of(&generated_all, "nested"), Some(false));
        assert_eq!(ignored_of(&generated_all, "notes.log"), Some(true));
        // 名字本身不匹配任何规则，只因为父目录被忽略：仍须按 ignored 处理。
        assert_eq!(ignored_of(&generated_all, "scratch.tmp"), Some(true));

        // 再深一层：祖先前缀累积错误同样会让 nested 消失。
        let nested_visible =
            repository_directory(&backend, path, "docs/generated/nested", false, 1, 5)
                .await
                .unwrap();
        assert_eq!(names_of(&nested_visible), ["tracked.txt"]);
        assert_eq!(ignored_of(&nested_visible, "tracked.txt"), Some(false));
        let nested_all = repository_directory(&backend, path, "docs/generated/nested", true, 1, 6)
            .await
            .unwrap();
        assert_eq!(ignored_of(&nested_all, "tracked.txt"), Some(false));
        assert_eq!(ignored_of(&nested_all, "other.tmp"), Some(true));
    }

    /// 目录结果里的条目名字，保持后端返回的顺序。
    fn names_of(directory: &RepositoryDirectory) -> Vec<&str> {
        directory
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    /// 按名字取目录结果里的 ignored 标记；没有这个条目时返回 None。
    fn ignored_of(directory: &RepositoryDirectory, name: &str) -> Option<bool> {
        directory
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.ignored)
    }

    #[tokio::test]
    async fn tracked_paths_are_never_hidden_by_ignore_rules() {
        let fixture = crate::test_support::git_fixture("repository-files-tracked-ignore");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        // 同时存在：被规则匹配的已跟踪文件、未跟踪的忽略文件、忽略目录、普通未跟踪文件。
        fs::write(root.join("tracked.log"), "tracked").unwrap();
        fs::write(root.join("untracked.log"), "ignored").unwrap();
        fs::write(root.join("ignored/tracked.txt"), "tracked").unwrap();
        fs::write(root.join("ignored/untracked.txt"), "ignored").unwrap();
        fs::write(root.join("plain.txt"), "plain").unwrap();
        git(
            &root,
            &[
                "add",
                "-f",
                "tracked.log",
                "ignored/tracked.txt",
                ".gitignore",
            ],
        );
        let path = root.to_str().unwrap();

        // 关闭忽略显示：已跟踪的 tracked.log 与含已跟踪文件的 ignored/ 必须仍在，且不是忽略项。
        let visible = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        let names: Vec<_> = visible
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["ignored", ".gitignore", "plain.txt", "tracked.log"]);
        assert_eq!(ignored_of(&visible, "tracked.log"), Some(false));
        assert_eq!(ignored_of(&visible, "ignored"), Some(false));
        assert_eq!(ignored_of(&visible, "plain.txt"), Some(false));
        assert_eq!(ignored_of(&visible, ".gitignore"), Some(false));
        // 未跟踪的忽略文件按开关隐藏。
        assert_eq!(ignored_of(&visible, "untracked.log"), None);

        // 打开忽略显示：未跟踪忽略文件出现并标记 ignored，已跟踪项仍然不是忽略项。
        let all = repository_directory(&backend, path, "", true, 1, 2)
            .await
            .unwrap();
        assert_eq!(ignored_of(&all, "tracked.log"), Some(false));
        assert_eq!(ignored_of(&all, "plain.txt"), Some(false));
        assert_eq!(ignored_of(&all, "ignored"), Some(false));
        assert_eq!(ignored_of(&all, "untracked.log"), Some(true));

        // 展开忽略目录：只看直接子项，已跟踪的 child 可见，未跟踪的按开关显示。
        let nested_visible = repository_directory(&backend, path, "ignored", false, 1, 3)
            .await
            .unwrap();
        let names: Vec<_> = nested_visible
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["tracked.txt"]);
        assert_eq!(ignored_of(&nested_visible, "tracked.txt"), Some(false));
        let nested_all = repository_directory(&backend, path, "ignored", true, 1, 4)
            .await
            .unwrap();
        assert_eq!(ignored_of(&nested_all, "tracked.txt"), Some(false));
        assert_eq!(ignored_of(&nested_all, "untracked.txt"), Some(true));
    }

    #[tokio::test]
    async fn tracked_index_cache_is_scoped_to_repository_generation() {
        let fixture = crate::test_support::git_fixture("repository-files-index-generation");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        fs::write(root.join("one.log"), "tracked").unwrap();
        git(&root, &["add", "-f", ".gitignore", "one.log"]);
        let path = root.to_str().unwrap();

        // 同一代次内重复列目录：只命中缓存的那份索引，已跟踪文件始终不是忽略项。
        for request_id in 1..=3 {
            let listed = repository_directory(&backend, path, "", false, 1, request_id)
                .await
                .unwrap();
            assert_eq!(ignored_of(&listed, "one.log"), Some(false));
        }

        // 索引变化后代次推进，缓存必须失效：one.log 变成真正未跟踪的忽略文件。
        git(&root, &["rm", "-q", "--cached", "one.log"]);
        let next = backend.scheduler.bump_generation(&repo_key(&root));
        assert_eq!(next, 2);
        let visible = repository_directory(&backend, path, "", false, next, 4)
            .await
            .unwrap();
        assert_eq!(ignored_of(&visible, "one.log"), None);
        let all = repository_directory(&backend, path, "", true, next, 5)
            .await
            .unwrap();
        assert_eq!(ignored_of(&all, "one.log"), Some(true));
    }

    #[test]
    fn tracked_index_membership_and_bounds_are_explicit() {
        let index = TrackedIndex::parse(b"src/lib.rs\0ignored/tracked.txt\0", false);
        assert!(index.is_tracked("src/lib.rs"));
        assert!(index.is_tracked("ignored/tracked.txt"));
        // 目录不在索引里：含已跟踪文件的祖先目录也必须算"已跟踪"，否则整棵子树会被藏起来。
        assert!(index.is_tracked("src"));
        assert!(index.is_tracked("ignored"));
        assert!(!index.is_tracked("untracked.log"));
        // 输出被截断或超过条目上限时退化为"都算已跟踪"：宁可少隐藏，也不藏已跟踪文件。
        assert!(TrackedIndex::parse(b"a\0", true).is_tracked("b"));
        let mut many = Vec::new();
        for number in 0..=MAX_INDEX_ENTRIES {
            many.extend_from_slice(format!("f{number}\0").as_bytes());
        }
        assert!(TrackedIndex::parse(&many, false).is_tracked("whatever"));
    }

    #[test]
    fn tracked_index_keeps_every_ancestor_prefix_and_counts_real_entries() {
        // 深层路径必须从仓库根累积完整前缀，而不是只记最靠右的末段（src/a/b.rs 曾被记成 src + a）。
        let index = TrackedIndex::parse(b"src/a/b.rs\0src/a/c.rs\0deep/one/two/three.txt\0", false);
        for dir in ["src", "src/a", "deep", "deep/one", "deep/one/two"] {
            assert!(index.is_tracked(dir), "{dir} 必须算已跟踪目录");
        }
        assert!(!index.is_tracked("a"));
        assert!(!index.is_tracked("src/b"));
        assert!(!index.is_tracked("one"));
        assert!(!index.is_tracked("two"));
        // 同名祖先被多条路径共享时只存一份，且不把文件路径混进目录集合。
        assert_eq!(index.dirs.len(), 5);
        assert_eq!(index.files.len(), 3);
        assert!(index.dirs.iter().all(|dir| !index.files.contains(dir)));

        // 计数按实际条目：两条路径共享一个祖先目录只算一次，正好等于上限时不能提前退化。
        let mut exact = Vec::new();
        for number in 0..MAX_INDEX_ENTRIES / 2 {
            exact.extend_from_slice(format!("d{number}/f{number}\0").as_bytes());
        }
        let bounded = TrackedIndex::parse(&exact, false);
        assert!(!bounded.degraded);
        assert_eq!(bounded.files.len() + bounded.dirs.len(), MAX_INDEX_ENTRIES);
        exact.extend_from_slice(b"over/limit.txt\0");
        assert!(TrackedIndex::parse(&exact, false).is_tracked("whatever"));
    }

    #[test]
    fn tracked_index_cache_is_keyed_by_root_and_generation() {
        let root = Path::new("twiglane-index-cache-scope");
        let index = Arc::new(TrackedIndex::parse(b"a.txt\0", false));
        store_tracked_index(root, 7, &index);
        assert!(cached_tracked_index(root, 7).is_some());
        // 代次或仓库根不同都必须重新读取，不能把旧索引套到新状态上。
        assert!(cached_tracked_index(root, 8).is_none());
        assert!(cached_tracked_index(Path::new("twiglane-index-cache-other"), 7).is_none());
    }

    #[tokio::test]
    async fn ignore_check_failure_is_reported_instead_of_hiding_entries() {
        let fixture = crate::test_support::git_fixture("repository-files-ignore-failure");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("keep.txt"), "keep").unwrap();
        let path = root.to_str().unwrap();
        assert_eq!(
            repository_directory(&backend, path, "", false, 1, 1)
                .await
                .unwrap()
                .entries
                .len(),
            1
        );
        fs::remove_dir_all(root.join(".git")).unwrap();
        let error = repository_directory(&backend, path, "", false, 1, 2)
            .await
            .unwrap_err();
        assert_eq!(error.code, "ignore_check");
    }

    struct CancelAfterFirstRead {
        inner: std::io::Cursor<Vec<u8>>,
        cancel: Arc<Shutdown>,
        reads: usize,
    }

    impl Read for CancelAfterFirstRead {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            // 第二块开始时取消：模拟超长单行仍在逐块消费的过程中收到 cancel_reads。
            if self.reads > 1 {
                self.cancel.cancel();
            }
            self.inner.read(buf)
        }
    }

    #[test]
    fn cancel_is_observed_while_consuming_a_long_line() {
        let cancel = Arc::new(Shutdown::new());
        let mut data = vec![b'a'; MAX_LINE_BYTES * 4];
        data.push(b'\n');
        let source = CancelAfterFirstRead {
            inner: std::io::Cursor::new(data),
            cancel: cancel.clone(),
            reads: 0,
        };
        let mut reader = BufReader::with_capacity(4096, source);
        let mut buffer = Vec::new();
        let error = read_line_chunk(&mut reader, &mut buffer, MAX_LINE_BYTES, &cancel).unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[tokio::test]
    async fn cancelled_long_line_read_is_neither_success_nor_binary() {
        let fixture = crate::test_support::git_fixture("repository-files-cancelled-long-line");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("huge.txt"), "a".repeat(MAX_LINE_BYTES * 8)).unwrap();
        backend.shutdown.cancel();
        let path = root.to_str().unwrap();
        let error = repository_file_content(&backend, path, "huge.txt", 0, None, 1, 1)
            .await
            .unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[tokio::test]
    async fn text_pages_resources_and_invalid_types_are_distinct() {
        let fixture = crate::test_support::git_fixture("repository-files-content");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("many.txt"), "one\ntwo\nthree\nfour").unwrap();
        fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        fs::write(root.join("binary.dat"), b"abc\x00def").unwrap();
        fs::write(root.join("invalid.txt"), [0xff, 0xfe]).unwrap();
        fs::create_dir(root.join("directory")).unwrap();
        let path = root.to_str().unwrap();
        let first = repository_file_content(&backend, path, "many.txt", 0, Some(2), 1, 1)
            .await
            .unwrap();
        assert_eq!(first.kind, RepositoryFileKind::Text);
        assert_eq!(first.lines, ["one", "two"]);
        assert_eq!(first.next_offset, 2);
        assert!(first.has_more);
        let second = repository_file_content(&backend, path, "many.txt", 2, Some(2), 1, 2)
            .await
            .unwrap();
        assert_eq!(second.lines, ["three", "four"]);
        assert!(!second.has_more);
        assert_eq!(
            repository_file_content(&backend, path, "image.png", 0, None, 1, 3)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::Resource
        );
        assert_eq!(
            repository_file_content(&backend, path, "binary.dat", 0, None, 1, 4)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::Binary
        );
        assert_eq!(
            repository_file_content(&backend, path, "invalid.txt", 0, None, 1, 5)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::InvalidUtf8
        );
        assert_eq!(
            repository_file_content(&backend, path, "absent.txt", 0, None, 1, 6)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::Missing
        );
        assert_eq!(
            repository_file_content(&backend, path, "directory", 0, None, 1, 7)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::Special
        );
        assert!(
            repository_file_content(&backend, path, "../secret", 0, None, 1, 8)
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_are_visible_but_never_followed() {
        use std::os::unix::fs::symlink;
        let fixture = crate::test_support::git_fixture("repository-files-links");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("inside.txt"), "inside").unwrap();
        symlink("inside.txt", root.join("link.txt")).unwrap();
        symlink("loop", root.join("loop")).unwrap();
        let outside = fixture.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside").unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        let path = root.to_str().unwrap();
        let directory = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        assert_eq!(
            directory
                .entries
                .iter()
                .filter(|entry| entry.kind == RepositoryEntryKind::Symlink)
                .count(),
            3
        );
        assert!(
            repository_file_content(&backend, path, "link.txt", 0, None, 1, 2)
                .await
                .is_err()
        );
        assert!(repository_directory(&backend, path, "loop", false, 1, 3)
            .await
            .is_err());
        assert!(repository_directory(&backend, path, "escape", false, 1, 4)
            .await
            .is_err());
        assert!(
            repository_file_content(&backend, path, "escape/secret.txt", 0, None, 1, 5)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn long_lines_and_page_budget_stay_bounded() {
        let fixture = crate::test_support::git_fixture("repository-files-paging");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let wide = "中".repeat(30_000);
        fs::write(root.join("wide.txt"), format!("{wide}\n尾行\n")).unwrap();
        let mut many = String::new();
        for index in 0..400 {
            many.push_str(&format!("{index} {}\n", "x".repeat(1024)));
        }
        fs::write(root.join("many.txt"), &many).unwrap();
        let path = root.to_str().unwrap();
        let wide_page = repository_file_content(&backend, path, "wide.txt", 0, Some(1), 1, 1)
            .await
            .unwrap();
        assert_eq!(wide_page.kind, RepositoryFileKind::Text);
        assert!(wide_page.truncated);
        assert!(wide_page.lines[0].len() <= MAX_LINE_BYTES);
        assert!(wide_page.lines[0]
            .chars()
            .all(|character| character == '中'));
        assert_eq!(wide_page.next_offset, 1);
        assert!(wide_page.has_more);
        let tail = repository_file_content(&backend, path, "wide.txt", 1, Some(10), 1, 2)
            .await
            .unwrap();
        assert_eq!(tail.lines, ["尾行"]);
        assert!(!tail.has_more);
        assert!(!tail.truncated);

        let first = repository_file_content(&backend, path, "many.txt", 0, Some(1000), 1, 3)
            .await
            .unwrap();
        assert!(first.has_more);
        assert!(first.lines.len() < 400);
        let page_bytes: usize = first.lines.iter().map(|line| line.len()).sum();
        assert!(page_bytes <= MAX_PAGE_BYTES, "{page_bytes}");
        let rest = repository_file_content(
            &backend,
            path,
            "many.txt",
            first.next_offset,
            Some(1000),
            1,
            4,
        )
        .await
        .unwrap();
        assert!(!rest.has_more);
        assert_eq!(first.lines.len() + rest.lines.len(), 400);
    }

    #[tokio::test]
    async fn binary_content_after_the_probe_is_not_text() {
        let fixture = crate::test_support::git_fixture("repository-files-late-binary");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let mut bytes = vec![b'a'; PROBE_BYTES + 1000];
        bytes.push(b'\n');
        bytes.extend_from_slice(b"tail\x00bytes\n");
        fs::write(root.join("late.dat"), &bytes).unwrap();
        let path = root.to_str().unwrap();
        let page = repository_file_content(&backend, path, "late.dat", 0, None, 1, 1)
            .await
            .unwrap();
        assert_eq!(page.kind, RepositoryFileKind::Binary);
        assert!(page.lines.is_empty());
    }

    #[tokio::test]
    async fn cancelled_shutdown_rejects_filesystem_reads() {
        let fixture = crate::test_support::git_fixture("repository-files-cancelled");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("file.txt"), "text").unwrap();
        backend.shutdown.cancel();
        let path = root.to_str().unwrap();
        assert_eq!(
            repository_directory(&backend, path, "", false, 1, 1)
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert_eq!(
            repository_file_content(&backend, path, "file.txt", 0, None, 1, 2)
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_directory_is_a_local_error() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = crate::test_support::git_fixture("repository-files-permission");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/keep.txt"), "keep").unwrap();
        let locked = root.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("secret.txt"), "secret").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let path = root.to_str().unwrap();
        let listed = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        assert!(listed
            .entries
            .iter()
            .any(|entry| entry.name == "locked" && is_directory_entry(entry.kind)));
        let other = repository_directory(&backend, path, "src", false, 1, 2)
            .await
            .unwrap();
        assert_eq!(other.entries[0].name, "keep.txt");
        // 以 root 运行时仍可读取；只有真正被拒绝时才断言错误码。
        if let Err(error) = repository_directory(&backend, path, "locked", false, 1, 3).await {
            assert!(
                matches!(error.code.as_str(), "permission" | "path_unreadable"),
                "{}",
                error.code
            );
        }
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[tokio::test]
    async fn stale_file_read_does_not_start_io() {
        let fixture = crate::test_support::git_fixture("repository-files-stale");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        backend.scheduler.bump_generation(&repo_key(&root));
        let error =
            repository_file_content(&backend, root.to_str().unwrap(), "missing", 0, None, 1, 1)
                .await
                .unwrap_err();
        assert_eq!(error.code, "stale");
        assert_eq!(error.generation, Some(2));
    }
}
