use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::git::command::{
    ignore_check_command, index_paths_command, list_ignored_paths_command, list_paths_command,
    status_command,
};
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, safe_relative, validate_input_path,
    Backend,
};
use crate::git::parse::parse_status;
use crate::git::preview::wants_preview;
use crate::git::runner::ProcessOutput;
use crate::git::schedule::{internal_request_id, GitJob, JobKind};
use crate::model::{
    ChangeKind, RepositoryContentMatch, RepositoryContentSearch, RepositoryDirectory,
    RepositoryDirectoryEntry, RepositoryEntryKind, RepositoryFileContent, RepositoryFileKind,
    RepositoryPathEntry, RepositoryPathKind, RepositoryPathSearch, RepositoryReviewState,
    RepositoryReviewToken, RepositorySearchScope, RepositorySearchSkip, RepositorySkipReason,
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

fn file_version(meta: &fs::Metadata) -> Option<String> {
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let created = meta
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |time| time.as_nanos());
    Some(format!("{:x}:{modified:x}:{created:x}", meta.len()))
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
            version: None,
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
                entry.version = file_version(&meta);
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
    let index = Arc::new(tracked_index_result(&output.output)?);
    store_tracked_index(root, generation, &index);
    Ok(index)
}

/// 索引读取的结果判定：截断优先于退出码。
///
/// runner 达到 `output_limit` 时会 kill 子进程，所以"输出被截断"必然伴随非零退出码
/// （通常是 -1 或信号退出）。如果先判退出码，大仓库里一次 `ls-files` 超过上限就会让
/// 每一次目录展开都变成硬错误，正好丢掉 ADR-3 要求的降级状态。
/// 截断时退化为降级索引：把每个路径都当成"可能已被跟踪"，只会少隐藏，绝不让目录展开失败。
fn tracked_index_result(output: &ProcessOutput) -> Result<TrackedIndex, AppError> {
    if output.stdout_truncated {
        return Ok(TrackedIndex::degraded());
    }
    if output.exit_code != 0 {
        return Err(git_failure(
            "index_check",
            output,
            "无法读取 Git 索引，不能判断文件是否已被跟踪。",
        ));
    }
    Ok(TrackedIndex::parse(&output.stdout, false))
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
        version: None,
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
    // SVG 是文本源码（XML）：wants_preview 只按扩展名把它归入资源，但 R3 要求全文搜索
    // 命中后能打开源码并定位到行。这里让 SVG 走文本分页，图片与压缩包仍是 Resource，
    // 未下载的 LFS 指针仍是 Resource；真正的二进制与非法编码由下方的 NUL/UTF-8 判定拦下。
    if wants_preview(&display, probe) && !svg_source_text(&display, probe) {
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
        let chunk = read_line_chunk(&mut reader, &mut buffer, 0, &cancel)?;
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
            // 只裁掉预算边界处不完整的字符；非法编码交给下方报告。
            // 逐字节缩短并反复验证会让长行退化成平方复杂度。
            if let Err(error) = std::str::from_utf8(&buffer) {
                if error.error_len().is_none() {
                    end = error.valid_up_to();
                }
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
        version: file_version(&meta),
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

/// 路径搜索一次最多返回多少条：前端只展示有限条，更多结果靠更精确的关键词缩小。
const DEFAULT_PATH_LIMIT: usize = 200;
const MAX_PATH_LIMIT: usize = 1000;
/// 一次路径枚举最多处理多少条路径；超过即标记截断，而不是继续堆内存。
const MAX_ENUMERATED_PATHS: usize = 200_000;
const DEFAULT_MATCH_LIMIT: usize = 200;
const MAX_MATCH_LIMIT: usize = 2_000;
/// 单个文件参与内容搜索的字节上限：超过按 tooLarge 跳过并说明，不做部分匹配冒充完整。
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 一次内容搜索最多读取多少个文件 / 多少字节；达到即截断。
const MAX_SEARCH_FILES: u64 = 20_000;
const MAX_SEARCH_SCAN_BYTES: u64 = 64 * 1024 * 1024;
/// 单条匹配结果保留的展示文本上限（字节，切在字符边界）。
const MAX_MATCH_TEXT_BYTES: usize = 400;
/// 跳过原因明细条数上限：真实数量仍在 skippedFiles 里。
const MAX_SKIP_RECORDS: usize = 64;
const MAX_QUERY_CHARS: usize = 200;

/// 一条被枚举到的仓库路径。ignored 只表示"来自忽略枚举"，不改变本次请求之外的任何状态。
#[derive(Debug, Clone)]
struct EnumeratedPath {
    path: String,
    directory: bool,
    ignored: bool,
}

/// 解析 git ls-files -z 的输出：目录与被忽略目录都以尾部 "/" 出现，去掉尾部分隔符后交给去重。
fn parse_list_output(stdout: &[u8], ignored: bool, out: &mut Vec<EnumeratedPath>) {
    for raw in stdout.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(raw).replace('\\', "/");
        let (path, directory) = match text.strip_suffix('/') {
            Some(stripped) => (stripped.to_string(), true),
            None => (text, false),
        };
        if path.is_empty() {
            continue;
        }
        out.push(EnumeratedPath {
            path,
            directory,
            ignored,
        });
    }
}

/// 执行一条路径枚举命令。输出超限时保留已读到的部分并标记截断，由调用方如实返回。
async fn run_path_list(
    backend: &Backend,
    key: &str,
    generation: u64,
    command: (PathBuf, Vec<std::ffi::OsString>),
    ignored: bool,
    failure: &str,
) -> Result<(Vec<EnumeratedPath>, bool), AppError> {
    let (program, args) = command;
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
            truncate_stdout: true,
            output_limit: Some(MAX_INDEX_BYTES),
            env: Vec::new(),
        })
        .await?;
    path_list_result(&output.output, ignored, failure)
}

/// 丢掉截断切在路径中间时留下的残片：`git ls-files -z` 的每条路径都以 NUL 结尾，
/// 输出末尾没有 NUL 说明最后一段是不完整的路径，保留它会伪造一个不存在的条目。
fn strip_partial_tail(stdout: &[u8]) -> &[u8] {
    if stdout.last() == Some(&0) {
        return stdout;
    }
    match stdout.iter().rposition(|byte| *byte == 0) {
        Some(index) => &stdout[..=index],
        None => &[],
    }
}

/// 路径枚举的结果判定：截断优先于退出码。
///
/// runner 达到 `output_limit` 时会 kill 子进程，所以"输出被截断"必然伴随非零退出码；
/// 先判退出码会让大仓库的路径搜索与目录 scope 全文搜索直接硬失败，
/// ADR-3 的 truncated/缩小范围状态永远不可达。只有未截断时的非零退出码才是真的失败。
/// 截断时返回已经读到的部分并标记 truncated，由调用方给出缩小范围的提示。
fn path_list_result(
    output: &ProcessOutput,
    ignored: bool,
    failure: &str,
) -> Result<(Vec<EnumeratedPath>, bool), AppError> {
    if !output.stdout_truncated && output.exit_code != 0 {
        return Err(git_failure("path_list", output, failure));
    }
    let stdout = if output.stdout_truncated {
        strip_partial_tail(&output.stdout)
    } else {
        output.stdout.as_slice()
    };
    let mut paths = Vec::new();
    parse_list_output(stdout, ignored, &mut paths);
    Ok((paths, output.stdout_truncated))
}

/// 枚举仓库路径（已跟踪 + 未跟踪非忽略，可选合并忽略文件）。
///
/// 只读、幂等：不写索引、不改忽略规则。目录范围用 Git pathspec 前缀限制，
/// 因此"目录 scope"不会隐式枚举其他目录。
async fn list_repository_paths(
    backend: &Backend,
    root: &Path,
    key: &str,
    generation: u64,
    directory: Option<&Path>,
    include_ignored: bool,
) -> Result<(Vec<EnumeratedPath>, bool), AppError> {
    let git = require_git(backend).await?;
    let (mut paths, mut truncated) = run_path_list(
        backend,
        key,
        generation,
        list_paths_command(&git.path, root, directory),
        false,
        "无法枚举仓库路径。",
    )
    .await?;
    if include_ignored {
        let (ignored, ignored_truncated) = run_path_list(
            backend,
            key,
            generation,
            list_ignored_paths_command(&git.path, root, directory),
            true,
            "无法枚举被忽略的路径。",
        )
        .await?;
        truncated |= ignored_truncated;
        paths.extend(ignored);
    }
    // 去重：同一路径可能同时来自 --cached 与 --ignored（已跟踪但匹配忽略规则），
    // 保留先出现的那条（未标记 ignored），忽略合并只影响本次请求。
    let mut seen = HashSet::new();
    paths.retain(|entry| seen.insert(entry.path.clone()));
    if paths.len() > MAX_ENUMERATED_PATHS {
        paths.truncate(MAX_ENUMERATED_PATHS);
        truncated = true;
    }
    Ok((paths, truncated))
}

/// 关键词的匹配质量：文件名前缀优先，其次文件名包含，最后是路径其他部分包含。
fn path_match_rank(path: &str, query: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(lower.as_str());
    if name.starts_with(query) {
        Some(0)
    } else if name.contains(query) {
        Some(1)
    } else if lower.contains(query) {
        Some(2)
    } else {
        None
    }
}

/// 在已枚举的路径上做有界匹配：文件来自 Git，目录由文件祖先与 Git 给出的目录合并派生。
///
/// 排序完全确定（质量、路径长度、字典序），同样输入必得同样顺序，方便前端做键盘导航。
fn rank_path_entries(
    paths: &[EnumeratedPath],
    query: &str,
    limit: usize,
) -> (Vec<RepositoryPathEntry>, u64, bool) {
    let query = query.to_lowercase();
    let mut directories: HashMap<&str, bool> = HashMap::new();
    for entry in paths {
        if entry.directory {
            let slot = directories.entry(entry.path.as_str()).or_insert(true);
            *slot &= entry.ignored;
        }
        for (offset, _) in entry.path.match_indices('/') {
            let slot = directories.entry(&entry.path[..offset]).or_insert(true);
            *slot &= entry.ignored;
        }
    }
    let mut candidates: Vec<(u32, &str, bool, bool)> = Vec::new();
    for entry in paths {
        if entry.directory {
            // 目录统一由派生集合给出，避免同一个目录既是条目又被派生一次。
            continue;
        }
        if let Some(rank) = path_match_rank(&entry.path, &query) {
            candidates.push((rank, entry.path.as_str(), false, entry.ignored));
        }
    }
    for (path, ignored) in &directories {
        if let Some(rank) = path_match_rank(path, &query) {
            candidates.push((rank, path, true, *ignored));
        }
    }
    let scanned = (paths.len() + directories.len()) as u64;
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.len().cmp(&right.1.len()))
            .then_with(|| left.1.cmp(right.1))
    });
    let truncated = candidates.len() > limit;
    candidates.truncate(limit);
    let entries = candidates
        .into_iter()
        .map(|(_, path, directory, ignored)| RepositoryPathEntry {
            path: path.to_string(),
            kind: if directory {
                RepositoryPathKind::Directory
            } else {
                RepositoryPathKind::File
            },
            ignored,
        })
        .collect();
    (entries, scanned, truncated)
}

fn validate_query(query: &str) -> Result<(), AppError> {
    if query.contains('\0') || query.contains('\n') || query.contains('\r') {
        return Err(AppError::new("query", "搜索关键词不能包含换行或空字符。"));
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::new(
            "query",
            format!("搜索关键词过长，请缩短到 {MAX_QUERY_CHARS} 个字符以内。"),
        ));
    }
    Ok(())
}

/// 按仓库相对路径查找文件与派生目录，可限定到某个目录并显式包含忽略文件。
///
/// 结果有界（limit）、排序稳定；枚举本身被 Git 输出上限或本地条数上限截断时，
/// 返回 truncated 而不是把部分结果当成完整结果。
#[allow(clippy::too_many_arguments)]
pub async fn repository_path_search(
    backend: &Backend,
    path: &str,
    query: &str,
    directory: Option<&str>,
    include_ignored: bool,
    limit: Option<usize>,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryPathSearch, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let directory_path = match directory {
        Some(directory) => Some(relative_directory(directory)?),
        None => None,
    };
    validate_query(query)?;
    let limit = limit.unwrap_or(DEFAULT_PATH_LIMIT).clamp(1, MAX_PATH_LIMIT);
    let key = repo_key(&root);
    let (paths, enumeration_truncated) = list_repository_paths(
        backend,
        &root,
        &key,
        generation,
        directory_path.as_deref(),
        include_ignored,
    )
    .await?;
    let directory_label = directory_path.as_deref().map(display_path);
    let query_for_search = query.to_string();
    let (entries, scanned, hit_limit) = backend
        .scheduler
        .execute_blocking_read(&key, request_id, generation, move |cancel| {
            check_cancel(&cancel)?;
            Ok(rank_path_entries(&paths, &query_for_search, limit))
        })
        .await?;
    let truncated = enumeration_truncated || hit_limit;
    Ok(RepositoryPathSearch {
        generation,
        query: query.to_string(),
        directory: directory_label,
        include_ignored,
        scanned,
        entries,
        truncated,
        message: truncated.then(|| "结果已截断：请缩小目录范围或细化关键词。".to_string()),
    })
}

/// 只保留文件路径（目录由树自己展开），并给出确定的顺序。
fn collect_file_paths(paths: &[EnumeratedPath]) -> Vec<String> {
    let mut files: Vec<String> = paths
        .iter()
        .filter(|entry| !entry.directory)
        .map(|entry| entry.path.clone())
        .collect();
    files.sort();
    files.dedup();
    files
}

/// changed-only 范围：直接用当前 git status 的路径集合，不做全仓枚举。
///
/// 已删除路径（任一侧为 D）不参与搜索；其余路径是否可读由逐文件读取时再确认，
/// 单个文件失败只影响自己。
async fn changed_paths(
    backend: &Backend,
    root: &Path,
    key: &str,
    generation: u64,
) -> Result<Vec<String>, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, root);
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
            truncate_stdout: false,
            output_limit: None,
            env: Vec::new(),
        })
        .await?;
    if output.output.exit_code != 0 {
        return Err(git_failure(
            "status_failed",
            &output.output,
            "无法读取仓库状态。",
        ));
    }
    let snapshot = parse_status(&output.output.stdout)?;
    let mut paths: Vec<String> = snapshot
        .files
        .into_iter()
        .filter(|file| {
            !matches!(file.staged, ChangeKind::Deleted)
                && !matches!(file.unstaged, ChangeKind::Deleted)
        })
        .map(|file| file.path)
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[derive(Debug, Default)]
struct SearchOutcome {
    matches: Vec<RepositoryContentMatch>,
    skipped: Vec<RepositorySearchSkip>,
    skipped_files: u64,
    files_scanned: u64,
    scanned_bytes: u64,
    truncated: bool,
    text_truncated: bool,
}

fn record_skip(outcome: &mut SearchOutcome, path: &str, reason: RepositorySkipReason) {
    outcome.skipped_files += 1;
    if outcome.skipped.len() < MAX_SKIP_RECORDS {
        outcome.skipped.push(RepositorySearchSkip {
            path: path.to_string(),
            reason,
        });
    }
}

/// 一行里的第一条匹配；列号按字符计数，展示文本有界（超长时截短并单独标记）。
fn line_match(
    relative: &str,
    line_no: u64,
    line: &str,
    query: &str,
) -> Option<(RepositoryContentMatch, bool)> {
    let byte_index = line.find(query)?;
    let column = line[..byte_index].chars().count() as u64 + 1;
    let mut text = line.to_string();
    let mut text_truncated = false;
    if text.len() > MAX_MATCH_TEXT_BYTES {
        let mut end = MAX_MATCH_TEXT_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text_truncated = true;
    }
    Some((
        RepositoryContentMatch {
            path: relative.to_string(),
            line: line_no,
            column,
            text,
        },
        text_truncated,
    ))
}

/// 打开一个可供搜索的普通文件：逐级拒绝符号链接，canonicalize 后确认仍在仓库内。
///
/// 枚举路径（Git 给出的文件、changed-only 路径）与单文件 scope 走同一个入口：
/// 路径本身来自 Git 不代表工作区仍与索引一致，中间父目录被换成指向仓库外的符号链接时
/// 必须在这里被拦住，否则 `File::open` 会读到仓库外的内容。
/// 返回 None 表示该路径不作为可搜索文件（已记录跳过原因）。
fn open_search_file(
    root: &Path,
    relative: &str,
    outcome: &mut SearchOutcome,
) -> Option<(fs::File, u64)> {
    let relative_path = match safe_relative(relative) {
        Ok(path) => path,
        Err(_) => {
            record_skip(outcome, relative, RepositorySkipReason::Special);
            return None;
        }
    };
    let full = root.join(&relative_path);
    let meta = match full.symlink_metadata() {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            record_skip(outcome, relative, RepositorySkipReason::Missing);
            return None;
        }
        Err(_) => {
            record_skip(outcome, relative, RepositorySkipReason::Unreadable);
            return None;
        }
    };
    if meta.file_type().is_symlink() {
        record_skip(outcome, relative, RepositorySkipReason::Symlink);
        return None;
    }
    if meta.is_dir() {
        // 嵌套仓库（含 gitlink 与未跟踪的子仓库）与普通目录都不进入内部。
        let reason = if full.join(".git").symlink_metadata().is_ok() {
            RepositorySkipReason::NestedRepository
        } else {
            RepositorySkipReason::Special
        };
        record_skip(outcome, relative, reason);
        return None;
    }
    if !meta.is_file() {
        record_skip(outcome, relative, RepositorySkipReason::Special);
        return None;
    }
    if meta.len() > MAX_SEARCH_FILE_BYTES {
        record_skip(outcome, relative, RepositorySkipReason::TooLarge);
        return None;
    }
    // 末级不是符号链接仍不够：中间的父目录可能是。逐级复查分量，再解析真实路径。
    if let Err(error) = reject_symlink_components(root, &relative_path) {
        let reason = match error.code.as_str() {
            "file_path" => RepositorySkipReason::Symlink,
            "path_missing" => RepositorySkipReason::Missing,
            _ => RepositorySkipReason::Unreadable,
        };
        record_skip(outcome, relative, reason);
        return None;
    }
    let resolved = match canonical_existing(&full) {
        Ok(resolved) => resolved,
        Err(_) => {
            record_skip(outcome, relative, RepositorySkipReason::Unreadable);
            return None;
        }
    };
    if !resolved.starts_with(root) {
        record_skip(outcome, relative, RepositorySkipReason::Symlink);
        return None;
    }
    let file = match fs::File::open(&resolved) {
        Ok(file) => file,
        Err(_) => {
            record_skip(outcome, relative, RepositorySkipReason::Unreadable);
            return None;
        }
    };
    Some((file, meta.len()))
}

/// SVG 是文本源码（XML），内容搜索与内容读取都必须按文本处理；图片、压缩包与 LFS 指针不是文本。
///
/// `wants_preview` 只看扩展名与 LFS 指纹，把 .svg 一并当成资源会让 R3 的全文搜索跳过
/// SVG 源码，也会让搜索命中后的源码定位只能拿到 Resource。这里只对 SVG 放行：真正的
/// 二进制仍由 NUL 与非 UTF-8 判定拦下，已下载与否未知的 LFS 指针仍然按资源处理，
/// 不伪造成文本。`file_preview` 仍按原逻辑把 .svg 当图片资源预览。
fn svg_source_text(relative: &str, probe: &[u8]) -> bool {
    const LFS_MARKER: &[u8] = b"https://git-lfs.github.com/spec/v1";
    relative.to_ascii_lowercase().ends_with(".svg")
        && !probe
            .windows(LFS_MARKER.len())
            .any(|window| window == LFS_MARKER)
}

/// 搜索单个文件的可读文本。取消是唯一向上传播的错误：其余失败都变成局部跳过原因。
///
/// 一个文件的匹配先在本地积累，只有整份文本都被完整解码后才提交；
/// 中途发现二进制或非法 UTF-8 时丢弃该文件的匹配，避免"半个文件的匹配"冒充真实结果。
fn search_file(
    root: &Path,
    relative: &str,
    query: &str,
    limit: usize,
    outcome: &mut SearchOutcome,
    cancel: &Shutdown,
) -> Result<(), AppError> {
    let Some((mut file, size)) = open_search_file(root, relative, outcome) else {
        return Ok(());
    };
    let mut probe = [0_u8; PROBE_BYTES];
    let count = match file.read(&mut probe) {
        Ok(count) => count,
        Err(_) => {
            record_skip(outcome, relative, RepositorySkipReason::Unreadable);
            return Ok(());
        }
    };
    let probe = &probe[..count];
    if wants_preview(relative, probe) && !svg_source_text(relative, probe) {
        record_skip(outcome, relative, RepositorySkipReason::Unsupported);
        return Ok(());
    }
    if probe.contains(&0) {
        record_skip(outcome, relative, RepositorySkipReason::Binary);
        return Ok(());
    }
    outcome.scanned_bytes += size;
    let chain = std::io::Cursor::new(probe.to_vec()).chain(file);
    let mut reader = BufReader::new(chain);
    let mut buffer = Vec::new();
    let mut line_no = 0_u64;
    let mut file_matches = Vec::new();
    let mut text_truncated = false;
    loop {
        check_cancel(cancel)?;
        let chunk = read_line_chunk(&mut reader, &mut buffer, MAX_LINE_BYTES, cancel)?;
        if !chunk.any {
            break;
        }
        if chunk.binary {
            record_skip(outcome, relative, RepositorySkipReason::Binary);
            return Ok(());
        }
        line_no += 1;
        if chunk.truncated {
            // 单行超过 64 KiB：只搜索保留的前缀，并把"结果可能不完整"如实标记。
            outcome.truncated = true;
        } else {
            strip_line_end(&mut buffer);
        }
        let mut end = buffer.len();
        if chunk.truncated {
            while end > 0 && std::str::from_utf8(&buffer[..end]).is_err() {
                end -= 1;
            }
        }
        let Ok(line) = std::str::from_utf8(&buffer[..end]) else {
            record_skip(outcome, relative, RepositorySkipReason::InvalidUtf8);
            return Ok(());
        };
        if let Some((found, cut)) = line_match(relative, line_no, line, query) {
            text_truncated |= cut;
            file_matches.push(found);
            // 多保留一条匹配（limit + 1）才能区分"还有结果"和"恰好 limit 条且已搜完"：
            // 只有真的多出匹配时才截断；调用方在收尾时再裁回 limit。
            if outcome.matches.len() + file_matches.len() > limit {
                outcome.truncated = true;
                break;
            }
        }
    }
    outcome.matches.extend(file_matches);
    outcome.files_scanned += 1;
    outcome.text_truncated |= text_truncated;
    Ok(())
}

/// 按已排序的显式路径逐文件搜索：文件数、读取字节数与取消都在文件之间复查。
fn search_paths(
    root: &Path,
    query: &str,
    paths: &[String],
    limit: usize,
    cancel: &Shutdown,
) -> Result<SearchOutcome, AppError> {
    let mut outcome = SearchOutcome::default();
    for relative in paths {
        check_cancel(cancel)?;
        // 只有真的多出一条匹配才算截断；正好 limit 条时继续把剩余候选搜完，
        // 否则"恰好 limit 且已完整搜索"会被误报成结果不完整。
        if outcome.matches.len() > limit {
            break;
        }
        if outcome.files_scanned >= MAX_SEARCH_FILES
            || outcome.scanned_bytes >= MAX_SEARCH_SCAN_BYTES
        {
            // 文件数/字节上限触发时确实还有未搜索的内容，仍按截断处理。
            outcome.truncated = true;
            break;
        }
        search_file(root, relative, query, limit, &mut outcome, cancel)?;
    }
    if outcome.matches.len() > limit {
        outcome.matches.truncate(limit);
        outcome.truncated = true;
    }
    Ok(outcome)
}

fn content_search_message(
    outcome: &SearchOutcome,
    empty_scope: bool,
    truncated: bool,
) -> Option<String> {
    if truncated {
        return Some(
            "结果未完整：已达到结果数、文件数或读取上限，请缩小范围或细化关键词。".to_string(),
        );
    }
    if empty_scope {
        return Some("当前范围内没有可搜索的文件。".to_string());
    }
    if outcome.files_scanned == 0 && outcome.skipped_files > 0 {
        return Some("范围内的文件都无法作为文本搜索，已按原因标记。".to_string());
    }
    if outcome.skipped_files > 0 {
        return Some("部分文件被跳过，其余文件已完整搜索。".to_string());
    }
    None
}

/// 在工作区文本里逐行搜索固定字符串，支持全仓 / 目录 / 单文件 / 仅改动四种范围。
///
/// 只读：不写工作区、索引或忽略规则；二进制、非法 UTF-8、符号链接、特殊文件与嵌套仓库
/// 各自返回跳过原因，达到上限时返回 truncated，绝不把提前停止说成"没有匹配"。
/// 空关键词在这里是错误：全文搜索没有"列出全部"的语义（路径搜索才有）。
#[allow(clippy::too_many_arguments)]
pub async fn repository_content_search(
    backend: &Backend,
    path: &str,
    query: &str,
    scope: RepositorySearchScope,
    include_ignored: bool,
    limit: Option<usize>,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryContentSearch, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    validate_query(query)?;
    // 路径搜索用空关键词表示"列出当前可见路径"，全文搜索则不同：空关键词会让
    // 每一行都算一次匹配，结果量爆炸且没有意义，所以这里单独拒绝，错误码仍是 query。
    if query.is_empty() {
        return Err(AppError::new(
            "query",
            "全文搜索关键词不能为空，请先输入要查找的内容。",
        ));
    }
    let limit = limit
        .unwrap_or(DEFAULT_MATCH_LIMIT)
        .clamp(1, MAX_MATCH_LIMIT);
    let key = repo_key(&root);
    let scope_label = scope.label().to_string();
    let (candidates, enumeration_truncated, scope_path) = match &scope {
        RepositorySearchScope::File { path: relative } => {
            let relative = safe_relative(relative)?;
            let label = display_path(&relative);
            (vec![label.clone()], false, Some(label))
        }
        RepositorySearchScope::Directory { path: relative } => {
            let directory = relative_directory(relative)?;
            let (paths, truncated) = list_repository_paths(
                backend,
                &root,
                &key,
                generation,
                Some(directory.as_path()),
                include_ignored,
            )
            .await?;
            (
                collect_file_paths(&paths),
                truncated,
                Some(display_path(&directory)),
            )
        }
        RepositorySearchScope::Repository => {
            let (paths, truncated) =
                list_repository_paths(backend, &root, &key, generation, None, include_ignored)
                    .await?;
            (collect_file_paths(&paths), truncated, None)
        }
        RepositorySearchScope::Changed => (
            changed_paths(backend, &root, &key, generation).await?,
            false,
            None,
        ),
    };
    let scope_path = scope_path.filter(|value| !value.is_empty());
    let empty_scope = candidates.is_empty();
    let query_for_search = query.to_string();
    let outcome = backend
        .scheduler
        .execute_blocking_read(&key, request_id, generation, move |cancel| {
            search_paths(&root, &query_for_search, &candidates, limit, &cancel)
        })
        .await?;
    let truncated = enumeration_truncated || outcome.truncated;
    let message = content_search_message(&outcome, empty_scope, truncated);
    Ok(RepositoryContentSearch {
        generation,
        query: query.to_string(),
        scope: scope_label,
        scope_path,
        matches: outcome.matches,
        files_scanned: outcome.files_scanned,
        skipped: outcome.skipped,
        skipped_files: outcome.skipped_files,
        truncated,
        text_truncated: outcome.text_truncated,
        message,
    })
}

/// 审阅确认只读这一条路径：状态、索引与工作区内容。
///
/// 全部命令都带 pathspec，不枚举其他改动、不做全仓 diff；工作区内容用 git hash-object
/// 读取 Git 自己的对象摘要，既流式读到文件末尾，也与既有 snapshot/hash 语义一致。
const MAX_REVIEW_BYTES: usize = 1024 * 1024;

/// 审阅路径必须是仓库内的普通相对路径：绝对路径、..、.git 都拒绝。
fn review_path(path: &str) -> Result<PathBuf, AppError> {
    let relative = safe_relative(path)?;
    if relative
        .components()
        .any(|component| component.as_os_str() == ".git")
    {
        return Err(AppError::new(
            "invalid_path",
            "不能把 .git 当作普通文件确认。",
        ));
    }
    Ok(relative)
}

fn review_prefix(root: &Path) -> Vec<OsString> {
    vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
    ]
}

fn review_status_command(git: &Path, root: &Path, relative: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = review_prefix(root);
    args.extend([
        OsString::from("status"),
        OsString::from("--porcelain=v2"),
        OsString::from("-z"),
        OsString::from("--untracked-files=all"),
        OsString::from("--"),
        relative.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

fn review_index_command(git: &Path, root: &Path, relative: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = review_prefix(root);
    args.extend([
        OsString::from("ls-files"),
        OsString::from("-z"),
        OsString::from("--stage"),
        OsString::from("--"),
        relative.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

fn review_hash_command(git: &Path, root: &Path, relative: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = review_prefix(root);
    args.extend([
        OsString::from("hash-object"),
        OsString::from("--"),
        relative.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

/// 一条只读 Git 命令：沿用读取通道的请求 id、并发许可、取消域与代次检查。
async fn run_review_git(
    backend: &Backend,
    key: &str,
    generation: u64,
    request_id: u64,
    command: (PathBuf, Vec<OsString>),
) -> Result<ProcessOutput, AppError> {
    let (program, args) = command;
    let output = backend
        .scheduler
        .execute(GitJob {
            repo_key: key.to_string(),
            kind: JobKind::Read,
            request_id,
            generation,
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: Some(MAX_REVIEW_BYTES),
            env: Vec::new(),
        })
        .await?;
    Ok(output.output)
}

/// 工作区内容探测：不跟随符号链接，也不把目录当文件。
enum ReviewProbe {
    File,
    Missing,
    Blocked(String),
}

async fn review_probe(
    backend: &Backend,
    key: &str,
    generation: u64,
    request_id: u64,
    root: &Path,
    relative: &Path,
) -> Result<ReviewProbe, AppError> {
    let task_root = root.to_path_buf();
    let task_relative = relative.to_path_buf();
    backend
        .scheduler
        .execute_blocking_read(key, request_id, generation, move |cancel| {
            check_cancel(&cancel)?;
            let target = task_root.join(&task_relative);
            Ok(match fs::symlink_metadata(&target) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    ReviewProbe::Blocked("符号链接不作为普通文件确认。".to_string())
                }
                Ok(meta) if !meta.is_file() => {
                    ReviewProbe::Blocked("这不是一个普通文件。".to_string())
                }
                Ok(_) => ReviewProbe::File,
                Err(error) if error.kind() == ErrorKind::NotFound => ReviewProbe::Missing,
                Err(error) => {
                    ReviewProbe::Blocked(crate::redact::redact_error_text(&error.to_string()))
                }
            })
        })
        .await
}

enum ReviewContent {
    File(String),
    Missing,
    Unreadable(String),
}

async fn review_content(
    backend: &Backend,
    key: &str,
    generation: u64,
    request_id: u64,
    root: &Path,
    relative: &Path,
) -> Result<ReviewContent, AppError> {
    let git = require_git(backend).await?;
    match review_probe(backend, key, generation, request_id, root, relative).await? {
        ReviewProbe::Blocked(reason) => Ok(ReviewContent::Unreadable(reason)),
        ReviewProbe::Missing => Ok(ReviewContent::Missing),
        ReviewProbe::File => {
            let output = run_review_git(
                backend,
                key,
                generation,
                request_id,
                review_hash_command(&git.path, root, relative),
            )
            .await?;
            if output.exit_code != 0 {
                let detail = crate::redact::redact_error_text(
                    String::from_utf8_lossy(&output.stderr).trim(),
                );
                let reason = if detail.is_empty() {
                    "无法读取当前文件内容。".to_string()
                } else {
                    detail
                };
                return Ok(ReviewContent::Unreadable(reason));
            }
            let oid = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if oid.is_empty() {
                return Ok(ReviewContent::Unreadable(
                    "Git 没有返回这个文件的内容版本。".to_string(),
                ));
            }
            Ok(ReviewContent::File(oid))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn review_result(
    generation: u64,
    path: &str,
    state: RepositoryReviewState,
    token: Option<String>,
    staged: ChangeKind,
    unstaged: ChangeKind,
    untracked: bool,
    unmerged: bool,
    content_version: Option<String>,
    message: String,
) -> RepositoryReviewToken {
    RepositoryReviewToken {
        generation,
        path: path.to_string(),
        state,
        token,
        staged,
        unstaged,
        untracked,
        unmerged,
        content_version,
        message,
    }
}

fn expect_worktree_missing(change: &crate::model::FileChange) -> bool {
    matches!(change.unstaged, ChangeKind::Deleted)
        || (matches!(change.staged, ChangeKind::Deleted)
            && matches!(change.unstaged, ChangeKind::None))
}

/// 单个改动路径的整文件审阅快照。
///
/// 只读：状态用带 pathspec 的 git status，索引读这一条路径的 ls-files --stage，
/// 内容用 git hash-object。token 覆盖路径、两侧状态、索引项与工作区内容版本，
/// 因此暂存、改内容、删除或变成冲突都会换一个新 token，而其他文件的改动不影响它。
pub async fn repository_review_token(
    backend: &Backend,
    path: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryReviewToken, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = review_path(relative)?;
    let relative_text = display_path(&relative_path);
    let git = require_git(backend).await?;
    let key = repo_key(&root);

    let status_output = run_review_git(
        backend,
        &key,
        generation,
        request_id,
        review_status_command(&git.path, &root, &relative_path),
    )
    .await?;
    if status_output.exit_code != 0 {
        return Err(git_failure(
            "review_status",
            &status_output,
            "无法读取这个文件的状态。",
        ));
    }
    let snapshot = parse_status(&status_output.stdout)?;
    let change = snapshot
        .files
        .into_iter()
        .find(|file| file.path == relative_text);
    let Some(change) = change else {
        return Ok(review_result(
            generation,
            &relative_text,
            RepositoryReviewState::Unchanged,
            None,
            ChangeKind::None,
            ChangeKind::None,
            false,
            false,
            None,
            "这条路径当前没有未提交的改动，不能标记已审阅。".to_string(),
        ));
    };

    let index_output = run_review_git(
        backend,
        &key,
        generation,
        request_id,
        review_index_command(&git.path, &root, &relative_path),
    )
    .await?;
    if index_output.exit_code != 0 {
        return Err(git_failure(
            "review_index",
            &index_output,
            "无法确认这个文件的暂存状态。",
        ));
    }
    let index_version = String::from_utf8_lossy(&index_output.stdout).into_owned();

    let missing_expected = expect_worktree_missing(&change);
    let (content_version, state, message) =
        match review_content(backend, &key, generation, request_id, &root, &relative_path).await? {
            ReviewContent::File(oid) => (
                Some(format!("worktree:{oid}")),
                RepositoryReviewState::Current,
                "已确认这个文件当前的整份内容与改动。".to_string(),
            ),
            ReviewContent::Missing if missing_expected => (
                Some("missing".to_string()),
                RepositoryReviewState::Current,
                "这个文件在工作区已被删除，快照就是删除本身。".to_string(),
            ),
            ReviewContent::Missing => (
                None,
                RepositoryReviewState::Missing,
                "工作区里已经没有这个文件，无法确认快照，保持未审阅。".to_string(),
            ),
            ReviewContent::Unreadable(reason) => (
                None,
                RepositoryReviewState::Unconfirmed,
                format!("无法确认这个文件的内容，保持未审阅：{reason}"),
            ),
        };

    let token = if state == RepositoryReviewState::Current {
        let mut hasher = Sha256::new();
        hasher.update(relative_text.as_bytes());
        hasher.update([0u8]);
        hasher.update(
            format!(
                "{:?}|{:?}|{}|{}|{:?}",
                change.staged,
                change.unstaged,
                change.untracked,
                change.unmerged,
                change.original_path
            )
            .as_bytes(),
        );
        hasher.update([0u8]);
        hasher.update(index_version.as_bytes());
        hasher.update([0u8]);
        hasher.update(content_version.as_deref().unwrap_or("none").as_bytes());
        Some(format!("{:x}", hasher.finalize()))
    } else {
        None
    };

    Ok(review_result(
        generation,
        &relative_text,
        state,
        token,
        change.staged,
        change.unstaged,
        change.untracked,
        change.unmerged,
        content_version,
        message,
    ))
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
            // changed-only 用例需要真实提交作为"改动前的快照"，所以测试 Git 自带身份。
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn directory_versions_follow_only_the_file_metadata() {
        let fixture = crate::test_support::git_fixture("repository-file-versions");
        let root = fixture.repo("repo");
        fs::write(root.join("read.txt"), "before").unwrap();
        let version = || {
            read_directory(root.clone(), PathBuf::new(), Arc::new(Shutdown::new()))
                .unwrap().0.into_iter()
                .find(|entry| entry.name == "read.txt")
                .unwrap().version.unwrap()
        };
        let initial = version();
        let content = read_text_page(
            root.clone(), PathBuf::from("read.txt"), 0, 1, Arc::new(Shutdown::new()),
        ).unwrap();
        assert_eq!(content.version.as_ref(), Some(&initial));
        fs::write(root.join("unrelated.txt"), "other").unwrap();
        assert_eq!(version(), initial);
        let file = fs::OpenOptions::new().write(true).open(root.join("read.txt")).unwrap();
        let modified = file.metadata().unwrap().modified().unwrap();
        fs::write(root.join("read.txt"), "after!").unwrap();
        file.set_times(fs::FileTimes::new().set_modified(modified + std::time::Duration::from_secs(2))).unwrap();
        assert_ne!(version(), initial);
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

    /// 构造一条真实的 runner 输出，用于验证"截断 + 非零退出码"这一组合的结果判定。
    fn process_output(
        exit_code: i32,
        stdout: &[u8],
        stderr: &[u8],
        stdout_truncated: bool,
    ) -> ProcessOutput {
        ProcessOutput {
            exit_code,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
            stdout_truncated,
        }
    }

    #[test]
    fn path_list_truncation_is_a_partial_result_not_a_hard_failure() {
        // runner 达到输出上限会 kill 子进程，所以截断输出必然带非零退出码。
        // 这个组合必须变成"已读部分 + truncated"，否则大仓库的路径搜索与目录 scope 搜索直接硬失败。
        let killed = process_output(-1, b"src/a.rs\0src/b", b"killed", true);
        let (paths, truncated) = path_list_result(&killed, false, "无法枚举仓库路径。").unwrap();
        assert!(truncated);
        assert_eq!(
            paths
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["src/a.rs"],
        );

        // 未截断时的非零退出码才是真的失败。
        let failed = process_output(128, &[], b"fatal: not a git repository", false);
        let error = path_list_result(&failed, false, "无法枚举仓库路径。").unwrap_err();
        assert_eq!(error.code, "path_list");

        // 未截断且正常退出：完整结果，不标记截断，忽略标记照旧生效。
        let complete = process_output(0, b"src/a.rs\0", &[], false);
        let (paths, truncated) = path_list_result(&complete, true, "无法枚举仓库路径。").unwrap();
        assert!(!truncated);
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ignored);
    }

    #[test]
    fn tracked_index_truncation_degrades_instead_of_failing() {
        // 索引输出被截断时无法判断哪些路径已被跟踪：退化为降级索引（宁可少隐藏），
        // 而不是让大仓库的目录展开失败。
        let killed = process_output(-1, b"src/a.rs\0", b"killed", true);
        let index = tracked_index_result(&killed).unwrap();
        assert!(index.degraded);
        assert!(index.is_tracked("anything.log"));

        // 未截断的非零退出码仍然是硬失败。
        let failed = process_output(128, &[], b"fatal: not a git repository", false);
        let error = tracked_index_result(&failed)
            .err()
            .expect("未截断的非零退出码必须失败");
        assert_eq!(error.code, "index_check");

        // 未截断且正常退出：按真实索引判定。
        let complete = process_output(0, b"src/a.rs\0", &[], false);
        let index = tracked_index_result(&complete).unwrap();
        assert!(!index.degraded);
        assert!(index.is_tracked("src"));
        assert!(!index.is_tracked("other.rs"));
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

    /// R3：SVG 既要在内容搜索里可命中，也要能在命中后用 `line` 打开源码并读回同一行。
    /// 扩展名不能让真实二进制、非法 UTF-8 或未下载的 LFS 指针伪装成文本，
    /// 图片与压缩包仍走资源预览，超高行仍按行预算截断。
    #[tokio::test]
    async fn svg_source_pages_as_text_and_search_hits_open_their_line() {
        let fixture = crate::test_support::git_fixture("repository-files-svg-content");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(
            root.join("icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\">\n  <title>needle in svg</title>\n  <circle r=\"1\"/>\n</svg>\n",
        )
        .unwrap();
        fs::write(root.join("photo.png"), b"\x89PNG\r\n\x1a\nneedle").unwrap();
        fs::write(root.join("bundle.zip"), b"PK\x03\x04needle").unwrap();
        // 未下载的 LFS 指针即使扩展名是 .svg 也仍然是资源，不是可读文本。
        fs::write(
            root.join("vector.svg"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 12\n",
        )
        .unwrap();
        fs::write(root.join("broken.svg"), b"<svg>\x00</svg>").unwrap();
        fs::write(
            root.join("legacy.svg"),
            [b"<svg>".as_slice(), &[0xff, 0xfe], b"</svg>"].concat(),
        )
        .unwrap();
        let wide = "中".repeat(30_000);
        fs::write(root.join("wide.svg"), format!("<svg>\n{wide}\n</svg>\n")).unwrap();
        let path = root.to_str().unwrap();

        let page = repository_file_content(&backend, path, "icon.svg", 0, Some(2), 1, 1)
            .await
            .unwrap();
        assert_eq!(page.kind, RepositoryFileKind::Text);
        assert_eq!(
            page.lines,
            [
                "<svg xmlns=\"http://www.w3.org/2000/svg\">",
                "  <title>needle in svg</title>"
            ]
        );
        assert_eq!(page.next_offset, 2);
        assert!(page.has_more);
        assert!(!page.truncated);

        // 搜索命中后的源码定位：`line` 是 1 起算，`offset` 是 0 起算。
        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(match_keys(&found), [("icon.svg", 2, 10)]);
        let hit = &found.matches[0];
        let located =
            repository_file_content(&backend, path, &hit.path, hit.line - 1, Some(1), 1, 3)
                .await
                .unwrap();
        assert_eq!(located.kind, RepositoryFileKind::Text);
        assert_eq!(located.lines, [hit.text.as_str()]);
        assert!(located.has_more);

        // 真实资源与 LFS 指针在内容页仍是资源，只有预览层负责它们。
        for relative in ["photo.png", "bundle.zip", "vector.svg"] {
            let resource = repository_file_content(&backend, path, relative, 0, None, 1, 4)
                .await
                .unwrap();
            assert_eq!(resource.kind, RepositoryFileKind::Resource, "{relative}");
            assert!(resource.lines.is_empty(), "{relative}");
        }
        // 扩展名不掩盖真实内容：NUL 与非法 UTF-8 仍是各自类型。
        assert_eq!(
            repository_file_content(&backend, path, "broken.svg", 0, None, 1, 5)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::Binary
        );
        assert_eq!(
            repository_file_content(&backend, path, "legacy.svg", 0, None, 1, 6)
                .await
                .unwrap()
                .kind,
            RepositoryFileKind::InvalidUtf8
        );
        // 超高行仍按行预算截断，SVG 不走特例绕过限制。
        let wide_page = repository_file_content(&backend, path, "wide.svg", 1, Some(1), 1, 7)
            .await
            .unwrap();
        assert_eq!(wide_page.kind, RepositoryFileKind::Text);
        assert!(wide_page.truncated);
        assert!(wide_page.lines[0].len() <= MAX_LINE_BYTES);
        assert!(wide_page.lines[0]
            .chars()
            .all(|character| character == '中'));
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
    async fn truncated_text_preserves_utf8_validation() {
        let fixture = crate::test_support::git_fixture("repository-files-long-encoding");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        // 错误在预算内：不能反复缩短到错误之前，把非法文件伪装成有效文本。
        let mut invalid = vec![b'a'; MAX_LINE_BYTES * 2];
        invalid[MAX_LINE_BYTES / 2] = 0xff;
        fs::write(root.join("invalid.txt"), invalid).unwrap();
        let page = repository_file_content(
            &backend,
            root.to_str().unwrap(),
            "invalid.txt",
            0,
            Some(1),
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(page.kind, RepositoryFileKind::InvalidUtf8);
        assert!(page.lines.is_empty());
        // 跳行仍须检查 NUL，但无需为跳过的行分配或复制文本。
        let mut reader = std::io::Cursor::new(b"skipped\0line\nnext\n");
        let mut buffer = Vec::new();
        let chunk = read_line_chunk(&mut reader, &mut buffer, 0, &Shutdown::new()).unwrap();
        assert!(chunk.binary);
        assert!(buffer.is_empty());
        assert_eq!(buffer.capacity(), 0);
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

    fn git_stdout(root: &Path, args: &[&str]) -> String {
        let output = Command::new(crate::test_support::system_git())
            .current_dir(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            // changed-only 用例需要真实提交作为"改动前的快照"，所以测试 Git 自带身份。
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn entry_paths(search: &RepositoryPathSearch) -> Vec<&str> {
        search
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect()
    }

    fn match_keys(search: &RepositoryContentSearch) -> Vec<(&str, u64, u64)> {
        search
            .matches
            .iter()
            .map(|found| (found.path.as_str(), found.line, found.column))
            .collect()
    }

    fn skip_reason(search: &RepositoryContentSearch, path: &str) -> Option<RepositorySkipReason> {
        search
            .skipped
            .iter()
            .find(|skip| skip.path == path)
            .map(|skip| skip.reason)
    }

    #[tokio::test]
    async fn path_search_returns_tracked_untracked_and_derived_directories() {
        let fixture = crate::test_support::git_fixture("repository-path-search");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src/lib")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(root.join("src/lib/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("src/lib/util.rs"), "pub fn util() {}\n").unwrap();
        fs::write(root.join("notes.txt"), "untracked\n").unwrap();
        fs::write(root.join("debug.log"), "ignored\n").unwrap();
        fs::write(root.join("target/build.bin"), "ignored\n").unwrap();
        git(
            &root,
            &["add", ".gitignore", "src/lib/main.rs", "src/lib/util.rs"],
        );
        let path = root.to_str().unwrap();

        let searched = repository_path_search(&backend, path, "src", None, false, None, 1, 1)
            .await
            .unwrap();
        assert_eq!(searched.generation, 1);
        assert!(!searched.truncated);
        assert!(searched.scanned > 0);
        let paths = entry_paths(&searched);
        // 已跟踪文件。
        assert!(paths.contains(&"src/lib/main.rs"), "{paths:?}");
        // 派生目录：src/lib 从没单独出现在索引里，但含匹配文件时必须作为目录结果出现。
        assert!(paths.contains(&"src/lib"), "{paths:?}");
        assert!(paths.contains(&"src"), "{paths:?}");
        assert_eq!(
            searched.entries[0].kind,
            RepositoryPathKind::Directory,
            "{paths:?}"
        );
        // 未跟踪但未被忽略的文件同样从路径搜索可见。
        let untracked = repository_path_search(&backend, path, "notes", None, false, None, 1, 2)
            .await
            .unwrap();
        assert_eq!(entry_paths(&untracked), ["notes.txt"]);
        assert_eq!(untracked.entries[0].kind, RepositoryPathKind::File);
    }

    #[tokio::test]
    async fn path_search_ignored_switch_merges_ignored_paths_and_dedupes() {
        let fixture = crate::test_support::git_fixture("repository-path-search-ignore");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("ignored")).unwrap();
        let ignore_rules = "*.log\nignored/\n";
        fs::write(root.join(".gitignore"), ignore_rules).unwrap();
        fs::write(root.join("tracked.log"), "tracked\n").unwrap();
        fs::write(root.join("untracked.log"), "ignored\n").unwrap();
        fs::write(root.join("ignored/deep.log"), "ignored\n").unwrap();
        git(&root, &["add", "-f", ".gitignore", "tracked.log"]);
        let path = root.to_str().unwrap();

        let visible = repository_path_search(&backend, path, "log", None, false, None, 1, 1)
            .await
            .unwrap();
        // 已跟踪且匹配忽略规则的文件不是忽略项，关闭开关时仍然可见。
        assert_eq!(entry_paths(&visible), ["tracked.log"]);

        let all = repository_path_search(&backend, path, "log", None, true, None, 1, 2)
            .await
            .unwrap();
        let paths = entry_paths(&all);
        assert!(paths.contains(&"untracked.log"), "{paths:?}");
        assert!(paths.contains(&"ignored/deep.log"), "{paths:?}");
        // 两个来源合并后必须去重：tracked.log 只出现一次，且不会被误标成忽略项。
        assert_eq!(
            paths.iter().filter(|path| **path == "tracked.log").count(),
            1,
            "{paths:?}"
        );
        let tracked = all
            .entries
            .iter()
            .find(|entry| entry.path == "tracked.log")
            .unwrap();
        assert!(!tracked.ignored);
        assert!(
            all.entries
                .iter()
                .find(|entry| entry.path == "untracked.log")
                .unwrap()
                .ignored
        );
        // 包含忽略文件只影响本次请求：规则文件本身没有变化。
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            ignore_rules
        );
    }

    #[tokio::test]
    async fn path_search_is_bounded_and_orders_stably() {
        let fixture = crate::test_support::git_fixture("repository-path-search-limit");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        for index in 1..=12 {
            fs::write(root.join(format!("f{index:02}.txt")), "x\n").unwrap();
        }
        git(&root, &["add", "."]);
        let path = root.to_str().unwrap();

        let first = repository_path_search(&backend, path, "f", None, false, Some(3), 1, 1)
            .await
            .unwrap();
        assert_eq!(first.entries.len(), 3);
        assert!(first.truncated);
        // 截断必须被明确标记，不能只靠空结果让调用方猜测。
        assert!(first.message.is_some());
        assert_eq!(entry_paths(&first), ["f01.txt", "f02.txt", "f03.txt"]);
        let second = repository_path_search(&backend, path, "f", None, false, Some(3), 1, 2)
            .await
            .unwrap();
        assert_eq!(entry_paths(&first), entry_paths(&second));
        // limit 只是上限：不截断时不宣称截断。
        let full = repository_path_search(&backend, path, "f", None, false, Some(100), 1, 3)
            .await
            .unwrap();
        assert_eq!(full.entries.len(), 12);
        assert_eq!(full.scanned, 12);
        assert!(!full.truncated);
        assert!(full.message.is_none());
    }

    #[tokio::test]
    async fn path_search_scope_stays_inside_the_requested_directory() {
        let fixture = crate::test_support::git_fixture("repository-path-search-scope");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/inner.txt"), "x\n").unwrap();
        fs::write(root.join("top.txt"), "x\n").unwrap();
        git(&root, &["add", "."]);
        let path = root.to_str().unwrap();

        let scoped = repository_path_search(&backend, path, "txt", Some("sub"), false, None, 1, 1)
            .await
            .unwrap();
        let paths = entry_paths(&scoped);
        assert!(scoped
            .entries
            .iter()
            .all(|entry| entry.path.starts_with("sub")));
        assert!(paths.contains(&"sub/inner.txt"), "{paths:?}");
        assert!(
            !paths.iter().any(|path| path.starts_with("top")),
            "{paths:?}"
        );
        assert_eq!(scoped.directory.as_deref(), Some("sub"));

        let error = repository_path_search(&backend, path, "txt", Some("../"), false, None, 1, 2)
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_path");
        let empty = repository_path_search(&backend, path, "txt", Some(""), false, None, 1, 3)
            .await
            .unwrap();
        assert!(entry_paths(&empty).contains(&"top.txt"));
    }

    #[tokio::test]
    async fn content_search_reports_line_column_and_special_characters() {
        let fixture = crate::test_support::git_fixture("repository-content-search-lines");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src/lib")).unwrap();
        // 固定字符串：正则元字符与括号都按字面量匹配。
        let needle = "a+b*c(d)[e]";
        let lines = [
            "fn first() {}".to_string(),
            format!("  let needle = \"{needle}\";"),
            "fn second() {}".to_string(),
            format!("    {needle} again"),
            format!("中文中文 {needle}"),
        ];
        fs::write(root.join("src/lib/parse.rs"), lines.join("\n") + "\n").unwrap();
        git(&root, &["add", "."]);
        let path = root.to_str().unwrap();

        let found = repository_content_search(
            &backend,
            path,
            needle,
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            match_keys(&found),
            [
                ("src/lib/parse.rs", 2, 17),
                ("src/lib/parse.rs", 4, 5),
                // 多字节字符按字符计数：中文中文(4) + 空格 = 第 5 个字符后开始匹配。
                ("src/lib/parse.rs", 5, 6),
            ]
        );
        assert_eq!(found.matches[1].text, lines[3]);
        assert_eq!(found.files_scanned, 1);
        assert!(!found.truncated);
        assert!(found.skipped.is_empty());

        let single = repository_content_search(
            &backend,
            path,
            needle,
            RepositorySearchScope::File {
                path: "src/lib/parse.rs".to_string(),
            },
            false,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(match_keys(&single), match_keys(&found));
        assert_eq!(found.scope, "repository");
        assert!(found.scope_path.is_none());
        assert_eq!(single.scope, "file");
        assert_eq!(single.scope_path.as_deref(), Some("src/lib/parse.rs"));

        // 真的没有匹配：不截断、没有跳过，才算"无匹配"。
        let empty = repository_content_search(
            &backend,
            path,
            "no-such-needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            3,
        )
        .await
        .unwrap();
        assert!(empty.matches.is_empty());
        assert!(!empty.truncated);
        assert!(empty.message.is_none());
    }

    #[tokio::test]
    async fn content_search_scopes_directory_and_changed_only() {
        let fixture = crate::test_support::git_fixture("repository-content-search-scope");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("legacy")).unwrap();
        fs::write(root.join("src/app.rs"), "needle one\n").unwrap();
        fs::write(root.join("docs/other.rs"), "needle two\n").unwrap();
        fs::write(root.join("legacy/gone.rs"), "needle three\n").unwrap();
        git(&root, &["add", "."]);
        // 真实提交作为改动前的基线：否则未提交仓库里所有文件都会是"新增改动"。
        git(&root, &["commit", "-q", "-m", "init"]);
        // 改动：改一个已跟踪文件、删除一个、再新增一个未跟踪文件。
        fs::write(root.join("src/app.rs"), "needle one changed\n").unwrap();
        fs::remove_file(root.join("legacy/gone.rs")).unwrap();
        fs::write(root.join("new.txt"), "needle four\n").unwrap();
        let path = root.to_str().unwrap();

        let whole = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        let mut whole_paths: Vec<&str> = whole.matches.iter().map(|m| m.path.as_str()).collect();
        whole_paths.sort();
        assert_eq!(whole_paths, ["docs/other.rs", "new.txt", "src/app.rs"]);
        // 已删除的路径仍被 Git 跟踪，但磁盘上已不存在：如实标成 missing，不伪造匹配。
        assert_eq!(
            skip_reason(&whole, "legacy/gone.rs"),
            Some(RepositorySkipReason::Missing)
        );

        let docs = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Directory {
                path: "docs".to_string(),
            },
            false,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(docs.scope, "directory");
        assert_eq!(docs.scope_path.as_deref(), Some("docs"));
        assert_eq!(match_keys(&docs), [("docs/other.rs", 1, 1)]);

        let changed = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Changed,
            false,
            None,
            1,
            3,
        )
        .await
        .unwrap();
        let mut changed_paths: Vec<&str> =
            changed.matches.iter().map(|m| m.path.as_str()).collect();
        changed_paths.sort();
        assert_eq!(changed_paths, ["new.txt", "src/app.rs"]);
        assert!(changed.skipped.is_empty());
    }

    #[tokio::test]
    async fn content_search_honours_ignore_switch_for_the_current_request() {
        let fixture = crate::test_support::git_fixture("repository-content-search-ignore");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let rules = "*.log\n";
        fs::write(root.join(".gitignore"), rules).unwrap();
        fs::write(root.join("app.rs"), "needle\n").unwrap();
        fs::write(root.join("debug.log"), "needle\n").unwrap();
        git(&root, &["add", ".gitignore", "app.rs"]);
        let path = root.to_str().unwrap();

        let visible = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(match_keys(&visible), [("app.rs", 1, 1)]);
        let all = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            true,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        let mut paths: Vec<&str> = all.matches.iter().map(|m| m.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["app.rs", "debug.log"]);
        assert_eq!(fs::read_to_string(root.join(".gitignore")).unwrap(), rules);
    }

    #[tokio::test]
    async fn content_search_marks_binary_invalid_utf8_and_unsupported_files() {
        let fixture = crate::test_support::git_fixture("repository-content-search-skips");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("text.txt"), "needle\n").unwrap();
        fs::write(root.join("binary.dat"), b"needle\x00more").unwrap();
        fs::write(root.join("invalid.txt"), [b'n', 0xff, 0xfe]).unwrap();
        fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\nneedle").unwrap();
        // 超过单文件读取上限：按体积跳过，而不是静默返回"没有匹配"。
        fs::write(root.join("oversized.txt"), b"needle\n".repeat(300_000)).unwrap();
        let path = root.to_str().unwrap();

        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(match_keys(&found), [("text.txt", 1, 1)]);
        assert_eq!(
            skip_reason(&found, "binary.dat"),
            Some(RepositorySkipReason::Binary)
        );
        assert_eq!(
            skip_reason(&found, "invalid.txt"),
            Some(RepositorySkipReason::InvalidUtf8)
        );
        // 资源类型走只读预览，不生成伪文本匹配。
        assert_eq!(
            skip_reason(&found, "image.png"),
            Some(RepositorySkipReason::Unsupported)
        );
        assert_eq!(
            skip_reason(&found, "oversized.txt"),
            Some(RepositorySkipReason::TooLarge)
        );
        assert_eq!(found.skipped_files, 4);
        // 只有 text.txt 真正被逐行搜索，其余都是按原因标记的跳过。
        assert_eq!(found.files_scanned, 1);
        assert!(!found.truncated);
        // 有跳过时不能说"已完整搜索"。
        assert!(found.message.is_some());
    }

    #[tokio::test]
    async fn content_search_truncates_at_limit_instead_of_claiming_no_match() {
        let fixture = crate::test_support::git_fixture("repository-content-search-limit");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        for index in 1..=5 {
            fs::write(root.join(format!("f{index}.txt")), "needle\n").unwrap();
        }
        let path = root.to_str().unwrap();

        let limited = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            Some(2),
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(limited.matches.len(), 2);
        assert!(limited.truncated);
        let message = limited.message.clone().unwrap();
        assert!(message.contains("未完整"), "{message}");
        // 提前停止不等于没有匹配：结果非空。
        assert!(!limited.matches.is_empty());

        // 反面基线：真的扫完所有文件也没有命中，才允许显示"无匹配"（无截断、无提示）。
        let none = repository_content_search(
            &backend,
            path,
            "absent-string",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        assert!(none.matches.is_empty());
        assert!(!none.truncated);
        assert!(none.message.is_none());
        assert_eq!(none.files_scanned, 5);
    }

    #[tokio::test]
    async fn content_search_limit_is_exact_when_the_scope_is_exhausted() {
        let fixture = crate::test_support::git_fixture("repository-content-search-exact-limit");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        // 命中数正好等于 limit，后面还有可读但没有额外匹配的文件。
        for index in 1..=3 {
            fs::write(root.join(format!("hit{index}.txt")), "needle\n").unwrap();
        }
        fs::write(root.join("clean-a.txt"), "no match here\n").unwrap();
        fs::write(root.join("clean-b.txt"), "still nothing\n").unwrap();
        let path = root.to_str().unwrap();

        let exact = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            Some(3),
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(exact.matches.len(), 3);
        // 恰好 limit 条且剩余候选已全部搜完：不能声称"结果不完整"。
        assert!(!exact.truncated);
        assert!(exact.message.is_none(), "{:?}", exact.message);
        assert_eq!(exact.files_scanned, 5);

        // 多出一条匹配就说明还有结果：必须截断并保留 limit 条。
        let overflow = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            Some(2),
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(overflow.matches.len(), 2);
        assert!(overflow.truncated);
        let message = overflow.message.clone().unwrap();
        assert!(message.contains("未完整"), "{message}");
    }

    #[tokio::test]
    async fn content_search_reads_svg_source_but_still_skips_real_resources() {
        let fixture = crate::test_support::git_fixture("repository-content-search-svg");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(
            root.join("icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\">\n  <title>needle in svg</title>\n</svg>\n",
        )
        .unwrap();
        // 真正的二进制资源仍然按资源跳过，不生成伪文本匹配。
        fs::write(root.join("photo.png"), b"\x89PNG\r\n\x1a\nneedle").unwrap();
        fs::write(root.join("bundle.zip"), b"PK\x03\x04needle").unwrap();
        // 未下载的 LFS 指针即使扩展名是 .svg 也不当作文本源码。
        fs::write(
            root.join("vector.svg"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 12\n",
        )
        .unwrap();
        let path = root.to_str().unwrap();

        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        // SVG 源码参与全文搜索：不再是 Unsupported。
        assert_eq!(match_keys(&found), [("icon.svg", 2, 10)]);
        assert_eq!(found.matches[0].text, "  <title>needle in svg</title>");
        assert_eq!(
            skip_reason(&found, "photo.png"),
            Some(RepositorySkipReason::Unsupported)
        );
        assert_eq!(
            skip_reason(&found, "bundle.zip"),
            Some(RepositorySkipReason::Unsupported)
        );
        assert_eq!(
            skip_reason(&found, "vector.svg"),
            Some(RepositorySkipReason::Unsupported)
        );
        assert_eq!(found.files_scanned, 1);
        assert_eq!(found.skipped_files, 3);
        assert!(!found.truncated);
    }

    #[tokio::test]
    async fn content_search_single_file_covers_lines_beyond_the_loaded_page() {
        let fixture = crate::test_support::git_fixture("repository-content-search-page");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let mut lines: Vec<String> = (1..=1200).map(|line| format!("line {line}")).collect();
        lines[1099] = "needle is far below the first page".to_string();
        fs::write(root.join("long.txt"), lines.join("\n") + "\n").unwrap();
        let path = root.to_str().unwrap();

        let page = repository_file_content(&backend, path, "long.txt", 0, Some(100), 1, 1)
            .await
            .unwrap();
        assert_eq!(page.lines.len(), 100);
        assert!(page.lines.iter().all(|line| !line.contains("needle")));

        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::File {
                path: "long.txt".to_string(),
            },
            false,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        // 文件内搜索必须覆盖未加载的后续文本页。
        assert_eq!(match_keys(&found), [("long.txt", 1100, 1)]);
        assert_eq!(found.matches[0].text, "needle is far below the first page");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn content_search_skips_symlinks_without_reading_outside_content() {
        use std::os::unix::fs::symlink;
        let fixture = crate::test_support::git_fixture("repository-content-search-links");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let outside = fixture.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "needle outside\n").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        symlink("link.txt", root.join("loop.txt")).unwrap();
        fs::write(root.join("inside.txt"), "needle inside\n").unwrap();
        let path = root.to_str().unwrap();

        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(match_keys(&found), [("inside.txt", 1, 1)]);
        assert_eq!(
            skip_reason(&found, "link.txt"),
            Some(RepositorySkipReason::Symlink)
        );
        assert_eq!(
            skip_reason(&found, "loop.txt"),
            Some(RepositorySkipReason::Symlink)
        );
    }

    /// 目录符号链接：Unix 一直可用；Windows 需要开发者模式或管理员权限，
    /// 拿不到权限时用例按平台限制跳过，而不是失败。
    #[cfg(unix)]
    fn directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[tokio::test]
    async fn content_search_refuses_a_symlinked_parent_directory_instead_of_reading_outside() {
        let fixture = crate::test_support::git_fixture("repository-content-search-parent-link");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        // 先以真实目录入库，让 Git 枚举里确实留下 src/link/secret.txt 这条路径。
        fs::create_dir_all(root.join("src/link")).unwrap();
        fs::write(root.join("src/link/secret.txt"), "needle tracked inside\n").unwrap();
        git(&root, &["add", "src"]);
        let outside = fixture.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "needle outside secret\n").unwrap();
        // 入库后把父目录换成指向仓库外的符号链接：索引仍列出旧路径，工作区已经越界。
        fs::remove_dir_all(root.join("src/link")).unwrap();
        if directory_symlink(&outside, &root.join("src/link")).is_err() {
            // Windows 上创建目录符号链接需要额外权限：无权限时按平台限制跳过。
            return;
        }
        let path = root.to_str().unwrap();

        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        // 来自 Git 枚举的路径同样要复查父级：不能因为“在 ls-files 里”就相信它。
        assert!(found.matches.is_empty(), "{:?}", match_keys(&found));
        assert_eq!(
            skip_reason(&found, "src/link/secret.txt"),
            Some(RepositorySkipReason::Symlink)
        );

        // 单文件 scope 直接指向这条越界路径，也只能被拒绝，不能读出仓库外的内容。
        let single = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::File {
                path: "src/link/secret.txt".to_string(),
            },
            false,
            None,
            1,
            2,
        )
        .await
        .unwrap();
        assert!(single.matches.is_empty(), "{:?}", match_keys(&single));
        assert!(
            !single
                .matches
                .iter()
                .any(|found| found.text.contains("outside")),
            "{:?}",
            match_keys(&single)
        );
        assert_eq!(
            skip_reason(&single, "src/link/secret.txt"),
            Some(RepositorySkipReason::Symlink)
        );
    }

    #[tokio::test]
    async fn content_search_rejects_an_empty_query_while_path_search_lists_paths() {
        let fixture = crate::test_support::git_fixture("repository-search-empty-query");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("a.txt"), "alpha\n").unwrap();
        fs::create_dir_all(root.join("dir")).unwrap();
        fs::write(root.join("dir/b.txt"), "beta\n").unwrap();
        let path = root.to_str().unwrap();

        // 全文搜索的空关键词会让每一行都匹配，结果无意义，因此返回稳定的 query 错误。
        let empty_content = repository_content_search(
            &backend,
            path,
            "",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(empty_content.code, "query");
        assert!(
            empty_content.message.contains("不能为空"),
            "{}",
            empty_content.message
        );

        // 路径搜索的空关键词保留“列出当前可见路径”的语义，不是错误。
        let listed = repository_path_search(&backend, path, "", None, false, None, 1, 2)
            .await
            .unwrap();
        let paths = entry_paths(&listed);
        assert!(paths.contains(&"a.txt"), "{paths:?}");
        assert!(paths.contains(&"dir"), "{paths:?}");
        assert!(paths.contains(&"dir/b.txt"), "{paths:?}");
        assert!(!listed.truncated);
    }

    #[tokio::test]
    async fn content_search_does_not_enter_nested_repositories() {
        let fixture = crate::test_support::git_fixture("repository-content-search-nested");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("child")).unwrap();
        fs::write(root.join("child/secret.txt"), "needle nested\n").unwrap();
        let child = root.join("child");
        git(&child, &["init", "-b", "main"]);
        // 子仓库要有自己的提交，父仓库才肯把它登记成 gitlink（未出生分支无法 add）。
        git(&child, &["add", "secret.txt"]);
        git(&child, &["commit", "-q", "-m", "child init"]);
        // 把子仓库登记成 gitlink：父仓库确实知道这个路径，只是不能进入它的内部。
        git(&root, &["add", "child"]);
        let path = root.to_str().unwrap();

        let found = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap();
        // 嵌套仓库只作为边界出现，不递归进入它的内容。
        assert!(found.matches.is_empty(), "{:?}", match_keys(&found));
        assert_eq!(
            skip_reason(&found, "child"),
            Some(RepositorySkipReason::NestedRepository)
        );
    }

    #[tokio::test]
    async fn content_search_rejects_cancelled_and_stale_requests() {
        let fixture = crate::test_support::git_fixture("repository-content-search-cancel");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("a.txt"), "needle\n").unwrap();
        let path = root.to_str().unwrap();

        // 代次变化（例如工作区刷新）：旧代次的结果一律不接纳。
        backend.scheduler.bump_generation(&repo_key(&root));
        let stale = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            1,
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, "stale");
        assert_eq!(stale.generation, Some(2));

        let current = backend.scheduler.current_generation(&repo_key(&root));
        backend.shutdown.cancel();
        let cancelled = repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Repository,
            false,
            None,
            current,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(cancelled.code, "cancelled");
    }

    #[test]
    fn content_search_stops_between_files_when_the_read_is_cancelled() {
        let fixture = crate::test_support::git_fixture("repository-content-search-token");
        let root = fixture.repo("repo");
        fs::write(root.join("a.txt"), "needle\n").unwrap();
        fs::write(root.join("b.txt"), "needle\n").unwrap();
        let cancel = Arc::new(Shutdown::new());
        cancel.cancel();
        let paths = vec!["a.txt".to_string(), "b.txt".to_string()];
        let error = search_paths(&root, "needle", &paths, 10, &cancel).unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[tokio::test]
    async fn searches_do_not_modify_the_worktree_or_ignore_rules() {
        let fixture = crate::test_support::git_fixture("repository-search-readonly");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let rules = "*.log\n";
        fs::write(root.join(".gitignore"), rules).unwrap();
        fs::write(root.join("app.rs"), "needle\n").unwrap();
        fs::write(root.join("debug.log"), "needle\n").unwrap();
        git(&root, &["add", ".gitignore", "app.rs"]);
        fs::write(root.join("app.rs"), "needle changed\n").unwrap();
        let path = root.to_str().unwrap();
        let before = git_stdout(&root, &["status", "--porcelain"]);

        repository_path_search(&backend, path, "app", None, true, None, 1, 1)
            .await
            .unwrap();
        repository_content_search(
            &backend,
            path,
            "needle",
            RepositorySearchScope::Changed,
            true,
            None,
            1,
            2,
        )
        .await
        .unwrap();

        // 只读：工作区状态与忽略规则都必须保持原样。
        assert_eq!(fs::read_to_string(root.join(".gitignore")).unwrap(), rules);
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]), before);
    }

    #[tokio::test]
    async fn review_token_follows_content_and_both_diff_sides() {
        let fixture = crate::test_support::git_fixture("repository-review-token");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("app.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("other.rs"), "fn other() {}\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        fs::write(root.join("app.rs"), "fn main() {\n    changed();\n}\n").unwrap();
        let path = root.to_str().unwrap();

        let first = repository_review_token(&backend, path, "app.rs", 1, 1)
            .await
            .unwrap();
        assert_eq!(first.state, RepositoryReviewState::Current);
        assert_eq!(first.staged, ChangeKind::None);
        assert_eq!(first.unstaged, ChangeKind::Modified);
        assert!(first.token.is_some());
        assert!(first.content_version.unwrap().starts_with("worktree:"));
        // 未变化时重复确认拿到同一个 token：刷新后才能保留标记。
        let again = repository_review_token(&backend, path, "app.rs", 1, 2)
            .await
            .unwrap();
        assert_eq!(again.token, first.token);

        // 其他文件的改动不改变这个路径的 token。
        fs::write(root.join("other.rs"), "fn other() {}\n// tail\n").unwrap();
        let unrelated = repository_review_token(&backend, path, "app.rs", 1, 3)
            .await
            .unwrap();
        assert_eq!(unrelated.token, first.token);

        // 内容变化：新 token。
        fs::write(root.join("app.rs"), "fn main() {\n    changed_twice();\n}\n").unwrap();
        let content = repository_review_token(&backend, path, "app.rs", 1, 4)
            .await
            .unwrap();
        assert_ne!(content.token, first.token);

        // 部分暂存：同一路径的两侧状态与内容一起进快照。
        git(&root, &["add", "--", "app.rs"]);
        fs::write(root.join("app.rs"), "fn main() {\n    changed_thrice();\n}\n").unwrap();
        let partial = repository_review_token(&backend, path, "app.rs", 1, 5)
            .await
            .unwrap();
        assert_eq!(partial.state, RepositoryReviewState::Current);
        assert_eq!(partial.staged, ChangeKind::Modified);
        assert_eq!(partial.unstaged, ChangeKind::Modified);
        assert_ne!(partial.token, content.token);

        // 只剩已暂存：即使工作区内容没动，状态变化也要换 token。
        git(&root, &["add", "--", "app.rs"]);
        let staged_only = repository_review_token(&backend, path, "app.rs", 1, 6)
            .await
            .unwrap();
        assert_eq!(staged_only.unstaged, ChangeKind::None);
        assert_ne!(staged_only.token, partial.token);
    }

    #[tokio::test]
    async fn review_token_separates_unchanged_deleted_and_untracked_paths() {
        let fixture = crate::test_support::git_fixture("repository-review-token-states");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("kept.rs"), "fn kept() {}\n").unwrap();
        fs::write(root.join("gone.rs"), "fn gone() {}\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();

        // 没有改动的路径不能标记。
        let unchanged = repository_review_token(&backend, path, "kept.rs", 1, 1)
            .await
            .unwrap();
        assert_eq!(unchanged.state, RepositoryReviewState::Unchanged);
        assert!(unchanged.token.is_none());

        // 工作区删除：快照就是删除本身，内容版本是 missing。
        fs::remove_file(root.join("gone.rs")).unwrap();
        let deleted = repository_review_token(&backend, path, "gone.rs", 1, 2)
            .await
            .unwrap();
        assert_eq!(deleted.state, RepositoryReviewState::Current);
        assert_eq!(deleted.unstaged, ChangeKind::Deleted);
        assert_eq!(deleted.content_version.as_deref(), Some("missing"));
        assert!(deleted.token.is_some());

        // 未跟踪文件同样能确认；内容变化后 token 改变。
        fs::write(root.join("fresh.rs"), "fn fresh() {}\n").unwrap();
        let fresh = repository_review_token(&backend, path, "fresh.rs", 1, 3)
            .await
            .unwrap();
        assert!(fresh.untracked);
        assert_eq!(fresh.state, RepositoryReviewState::Current);
        fs::write(root.join("fresh.rs"), "fn fresh() {}\n// more\n").unwrap();
        let fresh_changed = repository_review_token(&backend, path, "fresh.rs", 1, 4)
            .await
            .unwrap();
        assert_ne!(fresh_changed.token, fresh.token);

        // 恢复删除后旧 token 不再成立：同一路径回到未改动。
        fs::write(root.join("gone.rs"), "fn gone() {}\n").unwrap();
        let restored = repository_review_token(&backend, path, "gone.rs", 1, 5)
            .await
            .unwrap();
        assert_eq!(restored.state, RepositoryReviewState::Unchanged);
        assert!(restored.token.is_none());
    }

    #[tokio::test]
    async fn review_token_rejects_unsafe_paths_and_stale_generations() {
        let fixture = crate::test_support::git_fixture("repository-review-token-paths");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("app.rs"), "fn main() {}\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        fs::write(root.join("app.rs"), "fn main() {}\n// edit\n").unwrap();
        let path = root.to_str().unwrap();

        for unsafe_path in [
            "../outside.rs",
            ".git/config",
            "",
            std::env::temp_dir().join("outside.rs").to_str().unwrap(),
        ] {
            let error = repository_review_token(&backend, path, unsafe_path, 1, 9)
                .await
                .unwrap_err();
            assert_eq!(error.code, "invalid_path", "{unsafe_path}");
        }

        let stale = repository_review_token(&backend, path, "app.rs", 9, 10)
            .await
            .unwrap_err();
        assert_eq!(stale.code, "stale");

        backend.shutdown.cancel();
        let cancelled = repository_review_token(&backend, path, "app.rs", 9, 11)
            .await
            .unwrap_err();
        assert_eq!(cancelled.code, "cancelled");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn review_token_does_not_confirm_symlinked_content() {
        let fixture = crate::test_support::git_fixture("repository-review-token-symlink");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("target.rs"), "fn main() {}\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let link = root.join("link.rs");
        directory_symlink(&root.join("target.rs"), &link).unwrap();
        let path = root.to_str().unwrap();
        // 符号链接本身不是可确认的普通文件：给出明确状态而不是伪造内容。
        let result = repository_review_token(&backend, path, "link.rs", 1, 3)
            .await
            .unwrap();
        assert!(result.token.is_none());
        assert!(matches!(
            result.state,
            RepositoryReviewState::Unconfirmed | RepositoryReviewState::Unchanged
        ));
    }
}
