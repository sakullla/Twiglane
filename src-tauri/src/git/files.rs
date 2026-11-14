use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::sync::atomic::{AtomicU64, Ordering};
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
use crate::git::schedule::{internal_request_id, CommandSpec, GitJob, JobKind};
use crate::model::{
    ChangeKind, RepositoryContentMatch, RepositoryContentSearch, RepositoryDirectory,
    RepositoryDirectoryEntry, RepositoryEditSnapshot, RepositoryEditState, RepositoryEntryKind,
    RepositoryFileContent, RepositoryFileKind, RepositoryLineEnding, RepositoryPathEntry,
    RepositoryPathKind, RepositoryPathSearch, RepositoryReviewState, RepositoryReviewToken,
    RepositorySearchScope, RepositorySearchSkip, RepositorySkipReason,
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

pub(super) fn file_version(meta: &fs::Metadata) -> Option<String> {
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
            .then_with(|| natural_cmp(&left.name, &right.name))
    });
    Ok((entries, errors))
}

fn is_directory_entry(kind: RepositoryEntryKind) -> bool {
    matches!(
        kind,
        RepositoryEntryKind::Directory | RepositoryEntryKind::NestedRepository
    )
}

enum NaturalChunk {
    Num(String),
    Str(String),
}

/// 把名称拆成数字段与文本段：数字段按数值参与比较，其余保持原样顺序。
fn natural_chunks(text: &str) -> Vec<NaturalChunk> {
    let mut chunks = Vec::new();
    let mut digits = String::new();
    let mut letters = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            if !letters.is_empty() {
                chunks.push(NaturalChunk::Str(std::mem::take(&mut letters)));
            }
            digits.push(ch);
        } else {
            if !digits.is_empty() {
                chunks.push(NaturalChunk::Num(std::mem::take(&mut digits)));
            }
            letters.push(ch);
        }
    }
    if !digits.is_empty() {
        chunks.push(NaturalChunk::Num(digits));
    }
    if !letters.is_empty() {
        chunks.push(NaturalChunk::Str(letters));
    }
    chunks
}

fn compare_natural_chunks(
    left: &[NaturalChunk],
    right: &[NaturalChunk],
    case_sensitive: bool,
) -> std::cmp::Ordering {
    let mut left = left.iter();
    let mut right = right.iter();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(NaturalChunk::Num(a)), Some(NaturalChunk::Num(b))) => {
                let a_trim = a.trim_start_matches('0');
                let b_trim = b.trim_start_matches('0');
                let ord = a_trim
                    .len()
                    .cmp(&b_trim.len())
                    .then_with(|| a_trim.cmp(b_trim));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
                // 数值相同但前导零不同：零少的在前，保证次序确定。
                let ord = a.len().cmp(&b.len());
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(NaturalChunk::Num(_)), Some(NaturalChunk::Str(_))) => {
                return std::cmp::Ordering::Less;
            }
            (Some(NaturalChunk::Str(_)), Some(NaturalChunk::Num(_))) => {
                return std::cmp::Ordering::Greater;
            }
            (Some(NaturalChunk::Str(a)), Some(NaturalChunk::Str(b))) => {
                let ord = if case_sensitive {
                    a.cmp(b)
                } else {
                    a.to_lowercase().cmp(&b.to_lowercase())
                };
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

/// 自然排序：连续数字按数值比较（`T2` 排在 `T11` 前）；先不区分大小写，再按原样打破平手。
fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    compare_natural_chunks(&natural_chunks(left), &natural_chunks(right), false)
        .then_with(|| compare_natural_chunks(&natural_chunks(left), &natural_chunks(right), true))
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
    let output = match backend
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
        .await
    {
        Ok(output) => output,
        // `git check-ignore` 一启动就失败（例如仓库已经不是 Git 仓库）时，Git 会在读完
        // stdin 之前退出，而写 stdin 拿到的是 EPIPE。谁先发生取决于管道时序：同样的失败
        // 在 Windows 上常拿到退出码 128、在 Linux 上常拿到读写的 IO 错误。两者都表示
        // 「无法判断忽略状态」，必须同样按 ignore_check 报告，否则同一契约会在平台间摇摆，
        // 而吞掉这种失败就等于把子项当成未被忽略。
        Err(error) if error.code == "git_io" => {
            return Err(AppError::new(
                "ignore_check",
                format!("无法判断目录忽略状态。{}", error.message),
            ));
        }
        Err(error) => return Err(error),
    };
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
    consumed: u64,
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
        chunk.consumed += consumed as u64;
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
pub(super) fn read_text_page(
    root: PathBuf,
    relative: PathBuf,
    offset: u64,
    limit: usize,
    cancel: Arc<Shutdown>,
) -> Result<RepositoryFileContent, AppError> {
    read_text_page_cached(root, relative, offset, limit, cancel, None)
}

fn read_text_page_cached(
    root: PathBuf,
    relative: PathBuf,
    offset: u64,
    limit: usize,
    cancel: Arc<Shutdown>,
    cache: Option<&super::text_cursor::TextCursorCache>,
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
    let meta = file
        .metadata()
        .map_err(|error| AppError::new("path_unreadable", format!("无法读取文件信息：{error}")))?;
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
    let version = file_version(&meta);
    let (mut skipped, mut position) = cache
        .zip(version.as_deref())
        .map(|(cache, version)| cache.nearest(&resolved, version, offset))
        .unwrap_or((0, 0));
    file.seek(SeekFrom::Start(position))
        .map_err(|error| AppError::new("path_unreadable", format!("无法定位文件：{error}")))?;
    let mut reader = BufReader::new(file);
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
        position += chunk.consumed;
        skipped += 1;
    }
    let page_start = position;
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
        position += chunk.consumed;
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
    check_cancel(&cancel)?;
    // 文件在读取中改变时不发布索引；下一页仍通过版本变化触发正文重读。
    if let Some((cache, version)) = cache.zip(version) {
        if reader
            .get_ref()
            .metadata()
            .ok()
            .and_then(|meta| file_version(&meta))
            .as_deref()
            == Some(&version)
        {
            cache.remember(
                resolved,
                version,
                [
                    (offset, page_start),
                    (offset + lines.len() as u64, position),
                ],
            );
        }
    }
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
    let cursors = Arc::clone(&backend.text_cursors);
    let mut result = backend
        .scheduler
        .execute_blocking_read(&repo_key(&root), request_id, generation, move |cancel| {
            read_text_page_cached(root, relative_path, offset, limit, cancel, Some(&cursors))
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

/// 判断一个路径组件在任一受支持的文件系统上是否可能打开 Git 元数据目录或 gitfile。
///
/// Windows 与 macOS 默认大小写不敏感；Windows 还会去掉名字末尾的点和空格、把 `name:stream`
/// 解析到同一条目，并接受 8.3 短名（`GIT~1`）；HFS+ 会忽略部分零宽字符。这里按最宽的规则判断，
/// 宁可拒绝一个罕见的同名普通文件，也不让编辑写入 `.git`。
fn is_git_metadata_name(name: &OsStr) -> bool {
    let text = name.to_string_lossy();
    let visible: String = text
        .chars()
        .filter(|ch| {
            !matches!(
                *ch,
                '\u{200C}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{206A}'..='\u{206F}' | '\u{FEFF}'
            )
        })
        .collect();
    let stem = visible.split(':').next().unwrap_or_default();
    let trimmed = stem.trim_end_matches(['.', ' ']);
    trimmed.eq_ignore_ascii_case(".git") || trimmed.eq_ignore_ascii_case("git~1")
}

fn has_git_metadata_component(relative: &Path) -> bool {
    relative
        .components()
        .any(|component| is_git_metadata_name(component.as_os_str()))
}

fn git_metadata_error() -> AppError {
    AppError::new(
        "invalid_path",
        "不能把 .git 元数据当作普通文件读取或写入。",
    )
}

/// 编辑读写的文件系统边界：由 Git 确认的工作区根目录，以及必须排除的 Git 元数据目录。
///
/// 调用方传入的路径只是一个绝对目录，不能直接当作仓库根：否则 `path=<repo>/.git`
/// 或任意非仓库目录都会把里面的文本变成“可编辑工作区文件”。
struct EditBoundary {
    root: PathBuf,
    git_dirs: Vec<PathBuf>,
}

/// 对已规范化的根目录询问 Git 工作区顶层、当前 gitdir 与公共 gitdir。只读。
fn edit_layout_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = review_prefix(root);
    args.extend([
        OsString::from("rev-parse"),
        OsString::from("--path-format=absolute"),
        OsString::from("--show-toplevel"),
        OsString::from("--absolute-git-dir"),
        OsString::from("--git-common-dir"),
    ]);
    (git.to_path_buf(), args)
}

const MAX_EDIT_LAYOUT_BYTES: usize = 64 * 1024;

fn not_worktree_root_error() -> AppError {
    AppError::new(
        "invalid_path",
        "只能编辑已打开仓库工作区内的文件，未读取或写入任何内容。",
    )
}

/// 按 Git 的回答建立边界：必须是非裸仓库的工作区，且顶层正好等于传入的根目录。
/// 在 gitdir 内、子目录、非仓库目录或无法确认时一律拒绝（fail closed）。
fn edit_boundary_from_output(
    root: &Path,
    output: &ProcessOutput,
) -> Result<EditBoundary, AppError> {
    if output.exit_code != 0 || output.stdout_truncated {
        return Err(not_worktree_root_error());
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| not_worktree_root_error())?;
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
        .collect();
    let [toplevel, git_dir, common_dir] = lines.as_slice() else {
        return Err(not_worktree_root_error());
    };
    let toplevel =
        canonical_existing(Path::new(toplevel)).map_err(|_| not_worktree_root_error())?;
    if toplevel != root {
        return Err(not_worktree_root_error());
    }
    let mut git_dirs = Vec::with_capacity(2);
    for dir in [git_dir, common_dir] {
        let dir = canonical_existing(Path::new(dir)).map_err(|_| not_worktree_root_error())?;
        if root.starts_with(&dir) {
            // 工作区本身落在 gitdir 里：无法把元数据和工作区文件分开，整体拒绝。
            return Err(git_metadata_error());
        }
        if !git_dirs.contains(&dir) {
            git_dirs.push(dir);
        }
    }
    Ok(EditBoundary {
        root: root.to_path_buf(),
        git_dirs,
    })
}

/// 只读通道里确认编辑边界：沿用读取请求的代次检查。
async fn read_edit_boundary(
    backend: &Backend,
    key: &str,
    generation: u64,
    request_id: u64,
    root: &Path,
) -> Result<EditBoundary, AppError> {
    let git = require_git(backend).await?;
    let output = run_review_git(
        backend,
        key,
        generation,
        request_id,
        edit_layout_command(&git.path, root),
    )
    .await?;
    edit_boundary_from_output(root, &output)
}

/// 按真实解析后的路径复核：大小写变体、末尾点、短名和流名都已被文件系统还原成真实名字，
/// 只要解析结果落在仓库外、落在 Git 确认的 gitdir/公共 gitdir 内，或任一组件是 Git 元数据就拒绝。
fn ensure_editable_location(boundary: &EditBoundary, resolved: &Path) -> Result<(), AppError> {
    let Ok(inside) = resolved.strip_prefix(&boundary.root) else {
        return Err(AppError::new(
            "invalid_path",
            "文件必须位于当前仓库内，不能编辑仓库外的内容。",
        ));
    };
    if has_git_metadata_component(inside)
        || boundary
            .git_dirs
            .iter()
            .any(|dir| resolved.starts_with(dir))
    {
        return Err(git_metadata_error());
    }
    Ok(())
}

/// 审阅路径必须是仓库内的普通相对路径：绝对路径、..、.git（含大小写、末尾点等别名）都拒绝。
pub(crate) fn review_path(path: &str) -> Result<PathBuf, AppError> {
    let relative = safe_relative(path)?;
    if has_git_metadata_component(&relative) {
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

/// 轻量编辑一次读取/保存的字节预算：与全文搜索的单文件上限一致（2 MiB）。
const MAX_EDIT_BYTES: usize = 2 * 1024 * 1024;
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// 一条路径的完整读取结果，包含只读原因；只有 `Editable` 会带 text。
#[derive(Debug)]
struct EditRead {
    state: RepositoryEditState,
    size: u64,
    digest: Option<String>,
    text: Option<String>,
    bom: bool,
    line_ending: RepositoryLineEnding,
    final_newline: bool,
    message: String,
}

fn edit_read_only(state: RepositoryEditState, size: u64, message: &str) -> EditRead {
    EditRead {
        state,
        size,
        digest: None,
        text: None,
        bom: false,
        line_ending: RepositoryLineEnding::None,
        final_newline: false,
        message: message.to_string(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 统一行尾判定。单独一个 CR 或 LF/CRLF 混用都算 Mixed：首轮只读，避免保存时整份转换。
fn scan_line_ending(bytes: &[u8]) -> RepositoryLineEnding {
    let mut lf = 0_usize;
    let mut crlf = 0_usize;
    let mut lone_cr = false;
    let mut index = 0_usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                crlf += 1;
                index += 2;
                continue;
            }
            b'\r' => lone_cr = true,
            b'\n' => lf += 1,
            _ => {}
        }
        index += 1;
    }
    if lone_cr || (lf > 0 && crlf > 0) {
        RepositoryLineEnding::Mixed
    } else if crlf > 0 {
        RepositoryLineEnding::Crlf
    } else if lf > 0 {
        RepositoryLineEnding::Lf
    } else {
        RepositoryLineEnding::None
    }
}

/// 读取一份可编辑文件的完整内容。所有只读边界都返回结构化状态，只有 I/O 自身失败才向上报错。
fn read_edit_file(
    boundary: &EditBoundary,
    relative: &Path,
    cancel: &Shutdown,
) -> Result<EditRead, AppError> {
    let root = boundary.root.as_path();
    let display = display_path(relative);
    let target = root.join(relative);
    let meta = match fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(edit_read_only(
                RepositoryEditState::Missing,
                0,
                "文件不存在。",
            ));
        }
        Err(error) => {
            return Err(AppError::new(
                "path_unreadable",
                format!(
                    "无法读取文件：{}",
                    crate::redact::redact_error_text(&error.to_string())
                ),
            ));
        }
    };
    if meta.file_type().is_symlink() {
        return Ok(edit_read_only(
            RepositoryEditState::Symlink,
            meta.len(),
            "不跟随符号链接编辑仓库文件。",
        ));
    }
    if !meta.is_file() {
        return Ok(edit_read_only(
            RepositoryEditState::Special,
            meta.len(),
            "仅支持普通文本文件。",
        ));
    }
    if let Err(error) = reject_symlink_components(root, relative) {
        let state = match error.code.as_str() {
            "file_path" => RepositoryEditState::Symlink,
            "path_missing" => RepositoryEditState::Missing,
            _ => return Err(error),
        };
        let message = if state == RepositoryEditState::Symlink {
            "不跟随符号链接编辑仓库文件。"
        } else {
            "文件不存在。"
        };
        return Ok(edit_read_only(state, meta.len(), message));
    }
    let resolved = canonical_existing(&target)?;
    if !resolved.starts_with(root) {
        return Ok(edit_read_only(
            RepositoryEditState::Symlink,
            meta.len(),
            "文件必须位于当前仓库内，不能编辑仓库外的内容。",
        ));
    }
    // 词法检查无法穷举文件系统别名（如 8.3 短名）：按解析后的真实名字再拒绝一次 .git。
    ensure_editable_location(boundary, &resolved)?;
    if meta.len() > MAX_EDIT_BYTES as u64 {
        return Ok(edit_read_only(
            RepositoryEditState::TooLarge,
            meta.len(),
            &format!("文件超过 {MAX_EDIT_BYTES} 字节编辑上限，保持只读。"),
        ));
    }
    let mut file = fs::File::open(&resolved).map_err(|error| {
        AppError::new(
            "path_unreadable",
            format!(
                "无法打开文件：{}",
                crate::redact::redact_error_text(&error.to_string())
            ),
        )
    })?;
    let mut bytes: Vec<u8> = Vec::with_capacity(meta.len() as usize);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let count = file.read(&mut chunk).map_err(|error| {
            AppError::new(
                "path_unreadable",
                format!(
                    "无法读取文件：{}",
                    crate::redact::redact_error_text(&error.to_string())
                ),
            )
        })?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_EDIT_BYTES {
            // 元数据之后文件可能又变大：按实际读到的内容判定超限，不按旧长度放行。
            return Ok(edit_read_only(
                RepositoryEditState::TooLarge,
                meta.len(),
                &format!("文件超过 {MAX_EDIT_BYTES} 字节编辑上限，保持只读。"),
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let size = bytes.len() as u64;
    let digest = Some(sha256_hex(&bytes));
    if wants_preview(&display, &bytes) && !svg_source_text(&display, &bytes) {
        return Ok(EditRead {
            state: RepositoryEditState::Resource,
            size,
            digest,
            text: None,
            bom: false,
            line_ending: RepositoryLineEnding::None,
            final_newline: false,
            message: "此文件使用只读资源预览，不作为文本编辑。".to_string(),
        });
    }
    if bytes.contains(&0) {
        return Ok(EditRead {
            state: RepositoryEditState::Binary,
            size,
            digest,
            text: None,
            bom: false,
            line_ending: RepositoryLineEnding::None,
            final_newline: false,
            message: "二进制内容不支持编辑。".to_string(),
        });
    }
    let bom = bytes.starts_with(UTF8_BOM);
    let content = if bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        &bytes[..]
    };
    let Ok(text) = std::str::from_utf8(content) else {
        return Ok(EditRead {
            state: RepositoryEditState::InvalidUtf8,
            size,
            digest,
            text: None,
            bom,
            line_ending: RepositoryLineEnding::None,
            final_newline: false,
            message: "文件不是有效 UTF-8 文本，保持只读。".to_string(),
        });
    };
    let line_ending = scan_line_ending(content);
    if line_ending == RepositoryLineEnding::Mixed {
        return Ok(EditRead {
            state: RepositoryEditState::MixedLineEndings,
            size,
            digest,
            text: None,
            bom,
            line_ending,
            final_newline: content.ends_with(b"\n"),
            message: "文件包含混合行尾，保持只读以免保存时整份转换。".to_string(),
        });
    }
    Ok(EditRead {
        state: RepositoryEditState::Editable,
        size,
        digest,
        // 传输文本统一 LF；BOM 与原始行尾分别记录，保存时再还原。
        text: Some(text.replace("\r\n", "\n")),
        bom,
        line_ending,
        final_newline: content.ends_with(b"\n"),
        message: String::new(),
    })
}

fn edit_snapshot(generation: u64, path: &str, read: EditRead) -> RepositoryEditSnapshot {
    RepositoryEditSnapshot {
        generation,
        path: path.to_string(),
        state: read.state,
        editable: read.state == RepositoryEditState::Editable,
        size: read.size,
        digest: read.digest,
        text: read.text,
        bom: read.bom,
        line_ending: read.line_ending,
        final_newline: read.final_newline,
        message: read.message,
    }
}

/// 编辑读取：完整、有界、只读。成功时给出原始内容摘要与统一行尾，
/// 不适用时给出具体只读原因；分页只读合同 `repository_file_content` 不受影响。
pub async fn repository_edit_snapshot(
    backend: &Backend,
    path: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryEditSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = review_path(relative)?;
    let relative_text = display_path(&relative_path);
    let key = repo_key(&root);
    // 先由 Git 确认这是工作区顶层并得到 gitdir，再读文件；不是仓库根就不读。
    let boundary = read_edit_boundary(backend, &key, generation, request_id, &root).await?;
    let task_relative = relative_path.clone();
    let read = backend
        .scheduler
        .execute_blocking_read(&key, request_id, generation, move |cancel| {
            read_edit_file(&boundary, &task_relative, &cancel)
        })
        .await?;
    Ok(edit_snapshot(generation, &relative_text, read))
}

fn validate_edit_text(content: &str) -> Result<(), AppError> {
    if content.contains('\0') {
        return Err(AppError::new(
            "edit_content",
            "编辑内容包含空字符，未写入任何文件。",
        ));
    }
    if content.contains('\r') {
        return Err(AppError::new(
            "edit_content",
            "编辑内容必须使用 LF 行尾，未写入任何文件。",
        ));
    }
    if content.len() > MAX_EDIT_BYTES {
        return Err(AppError::new(
            "edit_content",
            format!("编辑内容超过 {MAX_EDIT_BYTES} 字节上限，未写入任何文件。"),
        ));
    }
    Ok(())
}

/// 按原 BOM 与统一行尾重建字节；不补也不删末尾换行，完全由编辑文本决定。
fn encode_edit_text(content: &str, bom: bool, line_ending: RepositoryLineEnding) -> Vec<u8> {
    let body = if line_ending == RepositoryLineEnding::Crlf {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    };
    let mut bytes = Vec::with_capacity(body.len() + UTF8_BOM.len());
    if bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

fn edit_conflict(message: &str) -> AppError {
    AppError::new("edit_conflict", message)
}

/// 编辑保存：在仓库写锁内复核 generation、路径能力与 expectedDigest，
/// 只有全部吻合才用同目录临时文件原子替换目标工作区文件。
///
/// 不运行 Git 写命令：不暂存、不提交、不推送、不合入。成功后 generation 前进，
/// 返回重新读取的新快照；失败时原文件保持不变。
pub async fn repository_edit_save(
    backend: &Backend,
    path: &str,
    relative: &str,
    expected_digest: &str,
    content: &str,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryEditSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = review_path(relative)?;
    let relative_text = display_path(&relative_path);
    let expected = expected_digest.trim().to_ascii_lowercase();
    if !is_sha256_hex(&expected) {
        return Err(AppError::new(
            "edit_digest",
            "编辑基线摘要无效，未写入任何文件。",
        ));
    }
    validate_edit_text(content)?;
    let git = require_git(backend).await?;
    let mut guard = backend
        .scheduler
        .lock_write(&repo_key(&root), request_id, generation)
        .await?;

    // 写锁内重新向 Git 确认工作区顶层与 gitdir：传入路径不是仓库根、位于 gitdir 内
    // 或不是仓库时，任何内容都不读不写。
    let (program, args) = edit_layout_command(&git.path, &root);
    let layout = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: Some(MAX_EDIT_LAYOUT_BYTES),
            writes: false,
        })
        .await?;
    let boundary = edit_boundary_from_output(&root, &layout)?;

    let current = read_edit_file(&boundary, &relative_path, &Shutdown::new())?;
    if current.state != RepositoryEditState::Editable {
        return Err(edit_conflict(
            "文件已不再处于可编辑状态，保存未写入，未覆盖外部内容。",
        ));
    }
    if current.digest.as_deref() != Some(expected.as_str()) {
        return Err(edit_conflict(
            "文件在编辑期间已被外部修改，保存未写入，未覆盖外部内容。",
        ));
    }
    let bytes = encode_edit_text(content, current.bom, current.line_ending);
    if bytes.len() > MAX_EDIT_BYTES {
        return Err(AppError::new(
            "edit_content",
            format!("保存后的内容超过 {MAX_EDIT_BYTES} 字节上限，未写入任何文件。"),
        ));
    }
    // 写锁内再解析一次目标：父目录在读取后被换成符号链接时也不能写到仓库外。
    let target = canonical_existing(&root.join(&relative_path))?;
    if !target.starts_with(&root) {
        return Err(edit_conflict("文件路径已不再安全，保存未写入。"));
    }
    ensure_editable_location(&boundary, &target)?;
    let metadata = fs::metadata(&target).map_err(|error| {
        AppError::new(
            "edit_write_failed",
            format!(
                "无法确认文件状态，未写入任何内容。{}",
                crate::redact::redact_error_text(&error.to_string())
            ),
        )
    })?;
    if metadata.permissions().readonly() {
        return Err(AppError::new(
            "edit_write_failed",
            "文件是只读的，保存未写入任何内容。",
        ));
    }
    if let Err(error) = crate::atomic::atomic_write_preserving_permissions(&target, &bytes) {
        let detail = crate::redact::redact_error_text(&error.to_string());
        if fs::symlink_metadata(&target).is_ok() {
            return Err(AppError::new(
                "edit_write_failed",
                format!("无法写入文件，原文件保持不变。{detail}"),
            ));
        }
        // 极少数替换失败会先移除原文件：如实告知，新内容保留在错误中指出的临时文件里。
        guard.mark_written();
        return Err(AppError::new(
            "edit_write_failed",
            format!("替换文件失败且原文件已被移除，新内容保留在临时文件中。{detail}"),
        ));
    }
    guard.mark_written();

    let written = read_edit_file(&boundary, &relative_path, &Shutdown::new())?;
    let expected_after = sha256_hex(&bytes);
    if written.state != RepositoryEditState::Editable
        || written.digest.as_deref() != Some(expected_after.as_str())
    {
        return Err(AppError::new(
            "edit_verify",
            "文件已写入，但保存后的内容无法确认，请重新读取。",
        ));
    }
    let new_generation = guard.finish();
    Ok(edit_snapshot(new_generation, &relative_text, written))
}

/// 新建项目的封闭类型；前端不能用任意文件类型或永久删除选项扩大命令能力。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepositoryCreateEntryKind {
    File,
    Directory,
}

/// 结构操作的封闭类型；只在提供 fd 相对写入原语的平台上存在。
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrdinaryEntryKind {
    File,
    Directory,
}

fn mutation_path(path: &str) -> Result<PathBuf, AppError> {
    let path = review_path(path)?;
    let normalized: PathBuf = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name),
            Component::CurDir => None,
            _ => None,
        })
        .collect();
    if normalized.as_os_str().is_empty() {
        return Err(AppError::new(
            "invalid_path",
            "文件或目录路径不能为空，未修改仓库。",
        ));
    }
    Ok(normalized)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn nested_repository_error() -> AppError {
    AppError::new(
        "nested_repository",
        "嵌套仓库及其内部路径不支持文件结构操作，未修改任何内容。",
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unsupported_entry_error() -> AppError {
    AppError::new(
        "unsupported_entry",
        "仅支持普通文件和普通目录；符号链接、特殊文件不受支持。",
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn entry_io_error(error: std::io::Error, message: &'static str) -> AppError {
    let code = match error.kind() {
        ErrorKind::AlreadyExists => "entry_exists",
        ErrorKind::PermissionDenied => "permission",
        ErrorKind::NotFound => "path_missing",
        _ => "entry_write_failed",
    };
    // 不把操作系统错误中的本机绝对路径回传给 IPC；稳定错误码与操作结果已足够定位。
    AppError::new(code, message)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
static TEMP_ENTRY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

// 没有 fd 相对原语的平台上 `trash_entry` 在校验前就失败关闭，永远不会构造这些取值；
// 枚举仍要保留，让 `repository_delete_entry_with` 的结果分派跨平台共用同一份代码。
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryTargetState {
    Present,
    Missing,
    Unknown,
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_entry_unsupported() -> AppError {
    AppError::new(
        "entry_platform_unsupported",
        "当前平台尚不能绑定最终文件身份执行安全结构操作，未修改任何内容。",
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
use secure_entry_ops::BoundTrashTarget;

/// 不提供 fd 相对写入原语的平台没有可绑定的回收站目标：命令在校验前就失败关闭，
/// 适配器永远不会被调用。保留该类型只为让 `repository_delete_entry` 的适配器签名跨平台一致。
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[allow(dead_code)]
struct BoundTrashTarget;

/// 所有最终写操作都相对于已打开、no-follow 的目录或文件描述符完成。
/// 路径校验之后即使外部进程替换父目录，也不会让写入转到另一个目录。
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod secure_entry_ops {
    use super::*;
    use std::ffi::{CStr, CString, OsString};
    use std::os::fd::{FromRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Identity {
        device: u64,
        inode: u64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct NodeStat {
        identity: Identity,
        mode: u32,
    }

    impl NodeStat {
        // `libc::stat` 的字段宽度依平台而变（macOS 的 st_dev/st_mode 窄于 Linux），
        // 这些提升到 u64/u32 的转换在其中一个平台必然“多余”，故整体允许该 lint。
        #[allow(clippy::unnecessary_cast)]
        fn from_raw(stat: &libc::stat) -> Self {
            Self {
                identity: Identity {
                    device: stat.st_dev as u64,
                    inode: stat.st_ino,
                },
                mode: stat.st_mode as u32,
            }
        }

        fn from_metadata(metadata: &fs::Metadata) -> Self {
            Self {
                identity: Identity {
                    device: metadata.dev(),
                    inode: metadata.ino(),
                },
                mode: metadata.mode(),
            }
        }

        #[allow(clippy::unnecessary_cast)]
        fn kind(self) -> Option<OrdinaryEntryKind> {
            match self.mode & libc::S_IFMT as u32 {
                value if value == libc::S_IFREG as u32 => Some(OrdinaryEntryKind::File),
                value if value == libc::S_IFDIR as u32 => Some(OrdinaryEntryKind::Directory),
                _ => None,
            }
        }

        fn writable(self) -> bool {
            self.mode & 0o222 != 0
        }
    }

    fn c_string(name: &OsStr) -> std::io::Result<CString> {
        CString::new(name.as_bytes()).map_err(|error| {
            std::io::Error::new(ErrorKind::InvalidInput, error)
        })
    }

    #[cfg(target_os = "macos")]
    fn fd_path(fd: RawFd) -> PathBuf {
        PathBuf::from(format!("/dev/fd/{fd}"))
    }

    /// 已打开目录 fd 的当前绝对路径。只用于 `--separate-git-dir` 等场景下回收站的
    /// 原始路径记录，不参与任何写入解析。
    #[cfg(target_os = "linux")]
    fn fd_directory_path(fd: RawFd) -> std::io::Result<PathBuf> {
        let path = fs::read_link(PathBuf::from(format!("/proc/self/fd/{fd}")))?;
        if path.is_absolute() {
            Ok(path)
        } else {
            Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "directory descriptor has no absolute path",
            ))
        }
    }

    fn stat_fd(fd: RawFd) -> std::io::Result<NodeStat> {
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        // SAFETY: stat 指向有效且可写的存储，fd 由本模块持有。
        if unsafe { libc::fstat(fd, &mut stat) } == 0 {
            Ok(NodeStat::from_raw(&stat))
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn stat_at(directory: RawFd, name: &OsStr) -> std::io::Result<NodeStat> {
        let name = c_string(name)?;
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        // SAFETY: name 以 NUL 结尾，stat 可写；NOFOLLOW 防止读取链接目标。
        if unsafe {
            libc::fstatat(directory, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW)
        } == 0
        {
            Ok(NodeStat::from_raw(&stat))
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    /// 打开已存在项目。带 `O_CREAT` 的调用必须走 [`create_at`]：可变参数缺省时
    /// 内核会拿到未定义的权限位。
    fn open_at(directory: RawFd, name: &OsStr, flags: libc::c_int) -> std::io::Result<RawFd> {
        let name = c_string(name)?;
        // SAFETY: name 以 NUL 结尾；directory 是存活的本模块目录 fd。
        let fd = unsafe {
            libc::openat(
                directory,
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd >= 0 {
            Ok(fd)
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    /// 排他创建新项目；显式给出权限位，避免依赖 `openat` 可变参数的未定义值。
    /// `mode` 用 C 的 `unsigned int`，在可变参数调用里对两种平台都是正确的提升类型。
    fn create_at(
        directory: RawFd,
        name: &OsStr,
        flags: libc::c_int,
        mode: libc::c_uint,
    ) -> std::io::Result<RawFd> {
        let name = c_string(name)?;
        // SAFETY: name 以 NUL 结尾；带 O_CREAT 时第四参数是必需的权限位。
        let fd = unsafe {
            libc::openat(
                directory,
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        };
        if fd >= 0 {
            Ok(fd)
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    struct DirectoryStream(*mut libc::DIR);

    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            // SAFETY: fdopendir 成功后 DIR 唯一归本 guard，closedir 同时关闭其 dup fd。
            let _ = unsafe { libc::closedir(self.0) };
        }
    }

    #[cfg(target_os = "macos")]
    fn errno_pointer() -> *mut libc::c_int {
        // SAFETY: macOS 返回当前线程的 errno 地址。
        unsafe { libc::__error() }
    }

    #[cfg(target_os = "linux")]
    fn errno_pointer() -> *mut libc::c_int {
        // SAFETY: Linux 返回当前线程的 errno 地址。
        unsafe { libc::__errno_location() }
    }

    fn directory_names(fd: RawFd) -> std::io::Result<Vec<OsString>> {
        // SAFETY: 复制 fd，F_DUPFD_CLOEXEC 防止新描述符泄漏到子进程。
        let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if duplicated < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fdopendir 接管 duplicated；失败时仍由这里关闭。
        let stream = unsafe { libc::fdopendir(duplicated) };
        if stream.is_null() {
            let error = std::io::Error::last_os_error();
            // SAFETY: fdopendir 失败时所有权尚未移交。
            let _ = unsafe { libc::close(duplicated) };
            return Err(error);
        }
        let stream = DirectoryStream(stream);
        let mut names = Vec::new();
        loop {
            // SAFETY: errno 指针属于当前线程，先清零以区分目录结束和读取失败。
            unsafe { *errno_pointer() = 0 };
            // SAFETY: stream 是存活的 DIR；返回的 entry 在下一次 readdir 前读取。
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                // SAFETY: 读取刚才 readdir 设置/保留的 errno。
                let errno = unsafe { *errno_pointer() };
                if errno == 0 {
                    break;
                }
                return Err(std::io::Error::from_raw_os_error(errno));
            }
            // SAFETY: readdir 的 d_name 是以 NUL 结尾的当前目录项名称。
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if matches!(bytes, b"." | b"..") {
                continue;
            }
            names.push(OsString::from_vec(bytes.to_vec()));
        }
        names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        Ok(names)
    }

    struct Directory {
        fd: RawFd,
    }

    impl Directory {
        fn open_path(path: &Path) -> std::io::Result<Self> {
            let path = c_string(path.as_os_str())?;
            // SAFETY: path 以 NUL 结尾；NOFOLLOW + DIRECTORY 只接受真实目录。
            let fd = unsafe {
                libc::open(
                    path.as_ptr(),
                    libc::O_RDONLY
                        | libc::O_DIRECTORY
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                )
            };
            if fd >= 0 {
                Ok(Self { fd })
            } else {
                Err(std::io::Error::last_os_error())
            }
        }

        fn open_at(parent: &Self, name: &OsStr) -> std::io::Result<Self> {
            open_at(parent.fd, name, libc::O_RDONLY | libc::O_DIRECTORY)
                .map(|fd| Self { fd })
        }

        fn duplicate(&self) -> std::io::Result<Self> {
            Self::open_at(self, OsStr::new("."))
        }

        fn stat(&self) -> std::io::Result<NodeStat> {
            stat_fd(self.fd)
        }

        fn has_dot_git(&self) -> std::io::Result<bool> {
            match stat_at(self.fd, OsStr::new(".git")) {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error),
            }
        }

        fn set_mode(&self, mode: u32) -> std::io::Result<()> {
            // SAFETY: fd 是本模块持有的目录；只修改该描述符指向的临时目录权限。
            if unsafe { libc::fchmod(self.fd, (mode & 0o7777) as libc::mode_t) } == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        }

        fn names(&self) -> std::io::Result<Vec<OsString>> {
            directory_names(self.fd)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            // SAFETY: fd 只在这里关闭一次，Directory 不实现 Clone/Copy。
            let _ = unsafe { libc::close(self.fd) };
        }
    }

    struct EntryParent {
        directory: Directory,
        name: OsString,
        ancestors: Vec<Identity>,
    }

    impl EntryParent {
        fn ensure_absent(&self) -> Result<(), AppError> {
            match stat_at(self.directory.fd, &self.name) {
                Ok(_) => Err(AppError::new(
                    "entry_exists",
                    "目标已存在，未覆盖已有内容。",
                )),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(entry_io_error(error, "无法确认目标状态，未修改任何内容。")),
            }
        }
    }

    /// 回收站适配器收到的已绑定目标：字段全部来自校验时打开的描述符，
    /// 适配器无法退回按字符串重新解析的仓库路径。
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) struct BoundTrashTarget {
        /// macOS 回收站实现按 /dev/fd/N 重新打开同一 inode 后交给系统回收站。
        #[cfg(target_os = "macos")]
        pub(super) fd_path: PathBuf,
        /// Linux freedesktop 实现在这个已打开的父目录里改名，绝不重新解析仓库路径。
        #[cfg(target_os = "linux")]
        parent: RawFd,
        #[cfg(target_os = "linux")]
        name: OsString,
        #[cfg(target_os = "linux")]
        identity: Identity,
        #[cfg(target_os = "linux")]
        kind: OrdinaryEntryKind,
        /// 跨卷复制会生成新 inode，副本只能按类型与权限核对，故保留校验时的权限位。
        #[cfg(target_os = "linux")]
        mode: u32,
        /// 写入 `.trashinfo` 的原始路径；取自已打开父目录的当前路径。
        #[cfg(target_os = "linux")]
        original_path: PathBuf,
    }

    struct EntrySource {
        parent: EntryParent,
        kind: OrdinaryEntryKind,
        stat: NodeStat,
        file: Option<fs::File>,
        directory: Option<Directory>,
    }

    impl EntrySource {
        #[cfg(target_os = "macos")]
        fn fd(&self) -> RawFd {
            self.file
                .as_ref()
                .map(std::os::fd::AsRawFd::as_raw_fd)
                .or_else(|| self.directory.as_ref().map(|directory| directory.fd))
                .expect("entry source always owns an open descriptor")
        }

        fn bound_trash_target(&self) -> Result<BoundTrashTarget, AppError> {
            // 回收站实现只拿到校验时打开的描述符与身份，拿不到可被替换的仓库路径字符串。
            #[cfg(target_os = "macos")]
            {
                Ok(BoundTrashTarget {
                    fd_path: fd_path(self.fd()),
                })
            }
            #[cfg(target_os = "linux")]
            {
                // 只用于 .trashinfo 记录的原始绝对路径，来自已打开父目录的当前路径 + 目标名。
                let parent_path = fd_directory_path(self.parent.directory.fd).map_err(|error| {
                    entry_io_error(error, "无法确认回收站目标的原始路径，未删除任何内容。")
                })?;
                Ok(BoundTrashTarget {
                    parent: self.parent.directory.fd,
                    name: self.parent.name.clone(),
                    identity: self.stat.identity,
                    kind: self.kind,
                    mode: self.stat.mode,
                    original_path: parent_path.join(&self.parent.name),
                })
            }
        }

        fn original_state(&self) -> EntryTargetState {
            match stat_at(self.parent.directory.fd, &self.parent.name) {
                Ok(_) => EntryTargetState::Present,
                Err(error) if error.kind() == ErrorKind::NotFound => EntryTargetState::Missing,
                Err(_) => EntryTargetState::Unknown,
            }
        }
    }

    struct SecureRoot {
        root: Directory,
        git_directories: Vec<Directory>,
    }

    impl SecureRoot {
        fn open(boundary: &EditBoundary) -> Result<Self, AppError> {
            let expected = fs::symlink_metadata(&boundary.root)
                .map_err(|error| entry_io_error(error, "无法确认工作区身份，未修改内容。"))?;
            let root = Directory::open_path(&boundary.root)
                .map_err(|error| entry_io_error(error, "无法安全打开工作区，未修改内容。"))?;
            if root.stat().map_err(|error| entry_io_error(error, "无法绑定工作区身份。"))?
                != NodeStat::from_metadata(&expected)
            {
                return Err(AppError::new(
                    "invalid_path",
                    "工作区在校验期间已变化，未修改任何内容。",
                ));
            }
            let mut git_directories = Vec::new();
            for path in &boundary.git_dirs {
                let expected = fs::symlink_metadata(path)
                    .map_err(|_| git_metadata_error())?;
                let directory = Directory::open_path(path).map_err(|_| git_metadata_error())?;
                if directory.stat().map_err(|_| git_metadata_error())?
                    != NodeStat::from_metadata(&expected)
                {
                    return Err(git_metadata_error());
                }
                git_directories.push(directory);
            }
            Ok(Self {
                root,
                git_directories,
            })
        }

        fn is_git_directory(&self, directory: &Directory) -> Result<bool, AppError> {
            let identity = directory
                .stat()
                .map_err(|error| entry_io_error(error, "无法确认目录身份。"))?
                .identity;
            self.git_directories
                .iter()
                .map(|git| {
                    git.stat()
                        .map(|stat| stat.identity == identity)
                        .map_err(|_| git_metadata_error())
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|matches| matches.into_iter().any(|matched| matched))
        }

        fn parent(&self, relative: &Path, writable: bool) -> Result<EntryParent, AppError> {
            let parent = relative.parent().unwrap_or_else(|| Path::new(""));
            let name = relative.file_name().ok_or_else(|| {
                AppError::new("invalid_path", "目标名称无效，未修改任何内容。")
            })?;
            let mut directory = self.root.duplicate().map_err(|error| {
                entry_io_error(error, "无法打开工作区目录，未修改任何内容。")
            })?;
            let mut ancestors = vec![directory
                .stat()
                .map_err(|error| entry_io_error(error, "无法确认工作区目录身份。"))?
                .identity];
            for component in parent.components() {
                let Component::Normal(name) = component else {
                    return Err(AppError::new("invalid_path", "父路径无效，未修改内容。"));
                };
                let stat = stat_at(directory.fd, name)
                    .map_err(|error| entry_io_error(error, "父目录不存在或无法读取。"))?;
                if stat.kind() != Some(OrdinaryEntryKind::Directory) {
                    return Err(AppError::new(
                        "file_path",
                        "父路径包含符号链接或非目录，未跟随。",
                    ));
                }
                let next = Directory::open_at(&directory, name).map_err(|error| {
                    entry_io_error(error, "父目录在校验期间已变化，未跟随符号链接。")
                })?;
                if self.is_git_directory(&next)? {
                    return Err(git_metadata_error());
                }
                if next
                    .has_dot_git()
                    .map_err(|error| entry_io_error(error, "无法确认嵌套仓库边界。"))?
                {
                    return Err(nested_repository_error());
                }
                ancestors.push(next
                    .stat()
                    .map_err(|error| entry_io_error(error, "无法确认父目录身份。"))?
                    .identity);
                directory = next;
            }
            if writable
                && !directory
                    .stat()
                    .map_err(|error| entry_io_error(error, "无法确认父目录权限。"))?
                    .writable()
            {
                return Err(AppError::new(
                    "permission",
                    "父目录是只读的，未修改任何内容。",
                ));
            }
            Ok(EntryParent {
                directory,
                name: name.to_os_string(),
                ancestors,
            })
        }

        fn target(&self, relative: &Path) -> Result<EntryParent, AppError> {
            let target = self.parent(relative, true)?;
            target.ensure_absent()?;
            Ok(target)
        }

        fn source(&self, relative: &Path, writable: bool) -> Result<EntrySource, AppError> {
            let parent = self.parent(relative, writable)?;
            let expected = stat_at(parent.directory.fd, &parent.name)
                .map_err(|error| entry_io_error(error, "源项目不存在或无法读取。"))?;
            let Some(kind) = expected.kind() else {
                return Err(unsupported_entry_error());
            };
            let fd = match kind {
                OrdinaryEntryKind::File => open_at(
                    parent.directory.fd,
                    &parent.name,
                    libc::O_RDONLY,
                ),
                OrdinaryEntryKind::Directory => open_at(
                    parent.directory.fd,
                    &parent.name,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                ),
            }
            .map_err(|error| entry_io_error(error, "源项目已变化或为符号链接，未跟随。"))?;
            let stat = stat_fd(fd).map_err(|error| {
                // SAFETY: open_at 成功返回新 fd；失败路径需要自行关闭。
                let _ = unsafe { libc::close(fd) };
                entry_io_error(error, "无法绑定源项目身份。")
            })?;
            if stat.kind() != Some(kind) {
                // SAFETY: 同上，fd 尚未移交所有权。
                let _ = unsafe { libc::close(fd) };
                return Err(unsupported_entry_error());
            }
            let (file, directory) = match kind {
                OrdinaryEntryKind::File => {
                    // SAFETY: fd 已确认是普通文件，所有权唯一移交给 File。
                    (Some(unsafe { fs::File::from_raw_fd(fd) }), None)
                }
                OrdinaryEntryKind::Directory => {
                    let directory = Directory { fd };
                    // 入口自身也必须与 Git 报告的实际 gitdir 身份比较：`--separate-git-dir`
                    // 可以把元数据放在工作区内并且不叫 .git，只看名字会把 gitdir 当普通目录，
                    // 让 copy/move/trash 作用在仓库元数据上。
                    if self.is_git_directory(&directory)? {
                        return Err(git_metadata_error());
                    }
                    if directory
                        .has_dot_git()
                        .map_err(|error| entry_io_error(error, "无法确认嵌套仓库边界。"))?
                    {
                        return Err(nested_repository_error());
                    }
                    (None, Some(directory))
                }
            };
            Ok(EntrySource {
                parent,
                kind,
                stat,
                file,
                directory,
            })
        }
    }

    fn open_new_file(directory: &Directory, name: &OsStr) -> std::io::Result<fs::File> {
        create_at(
            directory.fd,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o666,
        )
        // SAFETY: create_at 成功返回由本次调用独占的新文件 fd。
        .map(|fd| unsafe { fs::File::from_raw_fd(fd) })
    }

    fn mkdir_at(directory: &Directory, name: &OsStr) -> std::io::Result<()> {
        let name = c_string(name)?;
        // SAFETY: name 有效；mkdirat 只在这个已绑定目录里创建单级目录。
        if unsafe { libc::mkdirat(directory.fd, name.as_ptr(), 0o777) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn unlink_at_fd(directory: RawFd, name: &OsStr, flags: libc::c_int) -> std::io::Result<()> {
        let name = c_string(name)?;
        // SAFETY: name 有效；不会跟随末级符号链接。
        if unsafe { libc::unlinkat(directory, name.as_ptr(), flags) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn unlink_at(directory: &Directory, name: &OsStr, flags: libc::c_int) -> std::io::Result<()> {
        unlink_at_fd(directory.fd, name, flags)
    }

    fn rename_exclusive_at(
        source: RawFd,
        source_name: &OsStr,
        target: RawFd,
        target_name: &OsStr,
    ) -> std::io::Result<()> {
        let source_name = c_string(source_name)?;
        let target_name = c_string(target_name)?;
        #[cfg(target_os = "macos")]
        // SAFETY: 名称有效，两个目录 fd 均存活；RENAME_EXCL 禁止覆盖。
        let result = unsafe {
            libc::renameatx_np(
                source,
                source_name.as_ptr(),
                target,
                target_name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        // SAFETY: 名称有效，两个目录 fd 均存活；RENAME_NOREPLACE 禁止覆盖。
        let result = unsafe {
            libc::renameat2(
                source,
                source_name.as_ptr(),
                target,
                target_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn rename_exclusive(
        source: &Directory,
        source_name: &OsStr,
        target: &Directory,
        target_name: &OsStr,
    ) -> std::io::Result<()> {
        rename_exclusive_at(source.fd, source_name, target.fd, target_name)
    }

    /// 文件系统不支持 `RENAME_NOREPLACE` 时的普通改名；只在调用方已独占确认目标不存在后使用。
    #[cfg(target_os = "linux")]
    fn rename_without_flags(
        source: RawFd,
        source_name: &OsStr,
        target: RawFd,
        target_name: &OsStr,
    ) -> std::io::Result<()> {
        let source_name = c_string(source_name)?;
        let target_name = c_string(target_name)?;
        // SAFETY: 名称有效，两个目录 fd 均存活；调用方已确认目标不存在。
        let result = unsafe {
            libc::renameat(source, source_name.as_ptr(), target, target_name.as_ptr())
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn copy_open_file(
        mut input: fs::File,
        target: &Directory,
        target_name: &OsStr,
        mode: u32,
    ) -> Result<(), AppError> {
        let mut output = open_new_file(target, target_name)
            .map_err(|error| entry_io_error(error, "无法创建复制文件，未发布目标。"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|error| entry_io_error(error, "复制文件失败，未发布目标。"))?;
        output
            .set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|error| entry_io_error(error, "复制文件权限失败，未发布目标。"))
    }

    fn copy_directory_contents(source: &Directory, target: &Directory) -> Result<(), AppError> {
        let names = source
            .names()
            .map_err(|error| entry_io_error(error, "无法读取源目录，未发布复制目标。"))?;
        for name in names {
            if is_git_metadata_name(&name) {
                return Err(nested_repository_error());
            }
            let stat = stat_at(source.fd, &name)
                .map_err(|error| entry_io_error(error, "无法确认目录项，未发布复制目标。"))?;
            let Some(kind) = stat.kind() else {
                return Err(AppError::new(
                    "unsupported_entry",
                    "目录含符号链接或特殊文件，未跟随且未发布复制目标。",
                ));
            };
            match kind {
                OrdinaryEntryKind::File => {
                    let input = open_at(source.fd, &name, libc::O_RDONLY)
                        .map_err(|error| entry_io_error(error, "源文件已变化或为符号链接。"))?;
                    // SAFETY: open_at 返回独占 fd；下面 fstat 后再移交 File。
                    let input = unsafe { fs::File::from_raw_fd(input) };
                    let opened = NodeStat::from_metadata(
                        &input
                            .metadata()
                            .map_err(|error| entry_io_error(error, "无法绑定源文件身份。"))?,
                    );
                    // 绑定同一已验证身份： opened inode 必须等于先前 NOFOLLOW stat，
                    // 否则说明校验后被替换，失败关闭而不是复制替换物。
                    if opened.kind() != Some(OrdinaryEntryKind::File)
                        || opened.identity != stat.identity
                    {
                        return Err(AppError::new(
                            "entry_changed",
                            "源文件在复制前已变化，未发布复制目标。",
                        ));
                    }
                    copy_open_file(input, target, &name, stat.mode)?;
                }
                OrdinaryEntryKind::Directory => {
                    let child_source = Directory::open_at(source, &name)
                        .map_err(|error| entry_io_error(error, "源目录已变化或为符号链接。"))?;
                    let child_stat = child_source
                        .stat()
                        .map_err(|error| entry_io_error(error, "无法绑定源目录身份。"))?;
                    if child_stat.identity != stat.identity {
                        return Err(AppError::new(
                            "entry_changed",
                            "源目录在复制前已变化，未发布复制目标。",
                        ));
                    }
                    if child_source
                        .has_dot_git()
                        .map_err(|error| entry_io_error(error, "无法确认嵌套仓库边界。"))?
                    {
                        return Err(nested_repository_error());
                    }
                    mkdir_at(target, &name)
                        .map_err(|error| entry_io_error(error, "创建复制目录失败，未发布目标。"))?;
                    let child_target = Directory::open_at(target, &name)
                        .map_err(|error| entry_io_error(error, "无法绑定复制目录身份。"))?;
                    copy_directory_contents(&child_source, &child_target)?;
                    child_target
                        .set_mode(stat.mode)
                        .map_err(|error| entry_io_error(error, "复制目录权限失败，未发布目标。"))?;
                }
            }
        }
        Ok(())
    }

    struct TemporaryEntry<'a> {
        parent: &'a Directory,
        name: OsString,
        directory: Option<Directory>,
        active: bool,
    }

    impl<'a> TemporaryEntry<'a> {
        fn candidate() -> OsString {
            OsString::from(format!(
                ".twiglane-entry-{}-{}",
                std::process::id(),
                TEMP_ENTRY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ))
        }

        fn file(parent: &'a Directory) -> std::io::Result<(Self, fs::File)> {
            for _ in 0..100 {
                let name = Self::candidate();
                match open_new_file(parent, &name) {
                    Ok(file) => {
                        return Ok((
                            Self {
                                parent,
                                name,
                                directory: None,
                                active: true,
                            },
                            file,
                        ));
                    }
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(std::io::Error::new(ErrorKind::AlreadyExists, "temporary names exhausted"))
        }

        fn directory(parent: &'a Directory) -> std::io::Result<Self> {
            for _ in 0..100 {
                let name = Self::candidate();
                match mkdir_at(parent, &name) {
                    Ok(()) => {
                        let directory = match Directory::open_at(parent, &name) {
                            Ok(directory) => directory,
                            Err(error) => {
                                // mkdir 已成功但打开失败时也必须清掉这个空临时目录。
                                return match unlink_at(parent, &name, libc::AT_REMOVEDIR) {
                                    Ok(()) => Err(error),
                                    Err(cleanup) => Err(cleanup),
                                };
                            }
                        };
                        return Ok(Self {
                            parent,
                            name,
                            directory: Some(directory),
                            active: true,
                        });
                    }
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(std::io::Error::new(ErrorKind::AlreadyExists, "temporary names exhausted"))
        }

        fn publish(&mut self, target_name: &OsStr) -> std::io::Result<()> {
            rename_exclusive(self.parent, &self.name, self.parent, target_name)?;
            self.active = false;
            Ok(())
        }

        fn cleanup(&mut self) -> std::io::Result<()> {
            if !self.active {
                return Ok(());
            }
            let result = if let Some(directory) = &self.directory {
                cleanup_directory(directory).and_then(|()| {
                    unlink_at(self.parent, &self.name, libc::AT_REMOVEDIR)
                })
            } else {
                unlink_at(self.parent, &self.name, 0)
            };
            match result {
                Ok(()) => {
                    self.active = false;
                    Ok(())
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    self.active = false;
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
    }

    impl Drop for TemporaryEntry<'_> {
        fn drop(&mut self) {
            // 正常错误路径在返回前显式 cleanup；这里只兜底 panic/提前退出，不吞并业务结果。
            let _ = self.cleanup();
        }
    }

    fn cleanup_directory(directory: &Directory) -> std::io::Result<()> {
        let mode = directory.stat()?.mode;
        // 只恢复本次临时树的用户 rwx，确保只读子目录也可清理；不还原成只读后再删父项。
        directory.set_mode(mode | 0o700)?;
        for name in directory.names()? {
            let stat = stat_at(directory.fd, &name)?;
            if stat.kind() == Some(OrdinaryEntryKind::Directory) {
                let child = Directory::open_at(directory, &name)?;
                cleanup_directory(&child)?;
                unlink_at(directory, &name, libc::AT_REMOVEDIR)?;
            } else {
                unlink_at(directory, &name, 0)?;
            }
        }
        Ok(())
    }

    fn finish_temporary(
        temporary: &mut TemporaryEntry<'_>,
        result: Result<(), AppError>,
    ) -> Result<(), AppError> {
        match result {
            Ok(()) => Ok(()),
            Err(error) => match temporary.cleanup() {
                Ok(()) => Err(error),
                Err(_) => Err(AppError::new(
                    "entry_cleanup_failed",
                    format!(
                        "{} 本次临时内容也未能完全清理；最终目标未发布，请检查临时项。",
                        error.message
                    ),
                )),
            },
        }
    }

    pub(super) fn create(
        boundary: &EditBoundary,
        relative: &Path,
        kind: RepositoryCreateEntryKind,
    ) -> Result<(), AppError> {
        let root = SecureRoot::open(boundary)?;
        let target = root.target(relative)?;
        match kind {
            RepositoryCreateEntryKind::File => open_new_file(&target.directory, &target.name).map(|_| ()),
            RepositoryCreateEntryKind::Directory => mkdir_at(&target.directory, &target.name),
        }
        .map_err(|error| entry_io_error(error, "新建失败，未覆盖已有内容。"))
    }

    pub(super) fn copy(
        boundary: &EditBoundary,
        source_relative: &Path,
        target_relative: &Path,
        wrote: &mut bool,
    ) -> Result<(), AppError> {
        let root = SecureRoot::open(boundary)?;
        let source = root.source(source_relative, false)?;
        let target = root.target(target_relative)?;
        if source.kind == OrdinaryEntryKind::Directory
            && (target_relative.starts_with(source_relative)
                || target.ancestors.contains(&source.stat.identity))
        {
            return Err(AppError::new(
                "invalid_target",
                "不能把目录复制到自身或自身后代，未修改任何内容。",
            ));
        }
        let mut temporary = match source.kind {
            OrdinaryEntryKind::File => {
                let (mut temporary, output) = TemporaryEntry::file(&target.directory)
                    .map_err(|error| entry_io_error(error, "无法创建复制临时文件。"))?;
                // 临时文件已落盘：即使后续复制失败，也属写锁内已发生的部分写入。
                *wrote = true;
                let input = source.file.expect("file source");
                let result = (|| {
                    let mut input = input;
                    let mut output = output;
                    std::io::copy(&mut input, &mut output)
                        .map_err(|error| entry_io_error(error, "复制文件失败，未发布目标。"))?;
                    output
                        .set_permissions(fs::Permissions::from_mode(source.stat.mode))
                        .map_err(|error| entry_io_error(error, "复制文件权限失败，未发布目标。"))?;
                    drop(output);
                    temporary_publish(&mut temporary, &target.name)
                })();
                return finish_temporary(&mut temporary, result);
            }
            OrdinaryEntryKind::Directory => {
                let temporary = TemporaryEntry::directory(&target.directory)
                    .map_err(|error| entry_io_error(error, "无法创建复制临时目录。"))?;
                // 临时目录已落盘：即使后续内容复制失败，也属写锁内已发生的部分写入。
                *wrote = true;
                temporary
            }
        };
        let result = (|| {
            let temporary_directory = temporary.directory.as_ref().expect("directory temporary");
            copy_directory_contents(
                source.directory.as_ref().expect("directory source"),
                temporary_directory,
            )?;
            temporary_directory
                .set_mode(source.stat.mode)
                .map_err(|error| entry_io_error(error, "复制目录权限失败，未发布目标。"))?;
            temporary_publish(&mut temporary, &target.name)
        })();
        finish_temporary(&mut temporary, result)
    }

    fn temporary_publish(
        temporary: &mut TemporaryEntry<'_>,
        target_name: &OsStr,
    ) -> Result<(), AppError> {
        temporary
            .publish(target_name)
            .map_err(|error| entry_io_error(error, "发布复制失败，已有目标未被覆盖。"))
    }

    pub(super) fn move_entry(
        boundary: &EditBoundary,
        source_relative: &Path,
        target_relative: &Path,
    ) -> Result<(), AppError> {
        let root = SecureRoot::open(boundary)?;
        let source = root.source(source_relative, true)?;
        let target = root.target(target_relative)?;
        if source.kind == OrdinaryEntryKind::Directory
            && (target_relative.starts_with(source_relative)
                || target.ancestors.contains(&source.stat.identity))
        {
            return Err(AppError::new(
                "invalid_target",
                "不能把目录移到自身或自身后代，未修改任何内容。",
            ));
        }
        let current = stat_at(source.parent.directory.fd, &source.parent.name)
            .map_err(|error| entry_io_error(error, "源项目在移动前已变化，未执行移动。"))?;
        if current.identity != source.stat.identity || current.kind() != Some(source.kind) {
            return Err(AppError::new(
                "entry_changed",
                "源项目在移动前已变化，未执行移动。",
            ));
        }
        rename_exclusive(
            &source.parent.directory,
            &source.parent.name,
            &target.directory,
            &target.name,
        )
        .map_err(|error| entry_io_error(error, "移动或重命名失败，未覆盖已有内容。"))
    }

    pub(super) fn trash<F>(
        boundary: &EditBoundary,
        relative: &Path,
        adapter: F,
    ) -> Result<(Result<(), AppError>, EntryTargetState), AppError>
    where
        F: FnOnce(&BoundTrashTarget) -> Result<(), AppError>,
    {
        let root = SecureRoot::open(boundary)?;
        let source = root.source(relative, true)?;
        let target = source.bound_trash_target()?;
        let result = adapter(&target);
        Ok((result, source.original_state()))
    }

    // ---- Linux：按 freedesktop 规范直接写入系统回收站目录 ----
    //
    // 不能把 `/proc/self/fd/N` 交给路径型的回收站库：它的 freedesktop 后端只
    // canonicalize 父目录、保留末级名字，随后 rename / copy+delete 都在 procfs 上失败，
    // 还会在回收站留下以 fd 序号命名的副本。这里的所有步骤都相对已打开的父目录 fd 完成。

    #[cfg(target_os = "linux")]
    fn trash_unavailable() -> AppError {
        AppError::new("trash_failed", "系统回收站不可用，未执行永久删除。")
    }

    #[cfg(target_os = "linux")]
    fn trash_failed_with(message: &'static str) -> AppError {
        AppError::new("trash_failed", message)
    }

    /// `$XDG_DATA_HOME/Trash`；未设置或不是绝对路径时回退 `~/.local/share/Trash`。
    #[cfg(target_os = "linux")]
    pub(super) fn freedesktop_trash_root() -> Result<PathBuf, AppError> {
        let data_home = match std::env::var_os("XDG_DATA_HOME") {
            Some(value) if !value.is_empty() && Path::new(&value).is_absolute() => PathBuf::from(value),
            _ => {
                let home = std::env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(trash_unavailable)?;
                PathBuf::from(home).join(".local").join("share")
            }
        };
        Ok(data_home.join("Trash"))
    }

    #[cfg(target_os = "linux")]
    fn prepare_trash_directory(root: &Path, name: &str) -> Result<Directory, AppError> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        // 回收站根目录沿用数据目录的默认权限，只有 files/info 收紧到本人可访问。
        builder.create(root).map_err(|_| trash_unavailable())?;
        let path = root.join(name);
        match fs::create_dir(&path) {
            Ok(()) => {
                // 回收站可能保存未提交的源码。
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o700));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(_) => return Err(trash_unavailable()),
        }
        let path = canonical_existing(&path).map_err(|_| trash_unavailable())?;
        Directory::open_path(&path).map_err(|_| trash_unavailable())
    }

    #[cfg(target_os = "linux")]
    fn absent_in(directory: &Directory, name: &OsStr) -> Result<bool, AppError> {
        match stat_at(directory.fd, name) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
            Err(error) => Err(entry_io_error(
                error,
                "无法确认回收站目录内容，未执行删除。",
            )),
        }
    }

    /// 与 gio 一致：先尝试原名，冲突时依次使用 `名字.2`、`名字.3`……，绝不覆盖已有项目。
    #[cfg(target_os = "linux")]
    fn suffixed_name(name: &OsStr, attempt: u32) -> OsString {
        if attempt == 0 {
            return name.to_os_string();
        }
        let mut bytes = name.to_os_string().into_vec();
        bytes.extend_from_slice(format!(".{}", attempt + 1).as_bytes());
        OsString::from_vec(bytes)
    }

    #[cfg(target_os = "linux")]
    fn trash_info_name(file_name: &OsStr) -> OsString {
        let mut bytes = file_name.to_os_string().into_vec();
        bytes.extend_from_slice(b".trashinfo");
        OsString::from_vec(bytes)
    }

    #[cfg(target_os = "linux")]
    fn reserve_trash_names(
        files: &Directory,
        info: &Directory,
        name: &OsStr,
    ) -> Result<(OsString, OsString), AppError> {
        for attempt in 0..100u32 {
            let candidate = suffixed_name(name, attempt);
            let info_name = trash_info_name(&candidate);
            if absent_in(files, &candidate)? && absent_in(info, &info_name)? {
                return Ok((candidate, info_name));
            }
        }
        Err(trash_failed_with(
            "回收站中同名项目过多，未执行删除，也未永久删除源项目。",
        ))
    }

    /// freedesktop 的 `.trashinfo` 只保留非保留字符，其余按 UTF-8 字节百分号编码。
    #[cfg(target_os = "linux")]
    fn percent_encoded_path(path: &Path) -> String {
        let mut encoded = String::new();
        for &byte in path.as_os_str().as_bytes() {
            let keep = byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/');
            if keep {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    #[cfg(target_os = "linux")]
    fn deletion_timestamp() -> Result<String, AppError> {
        let mut now: libc::time_t = 0;
        // SAFETY: 输出参数可写；time 只把当前时间写入该变量。
        unsafe { libc::time(&mut now) };
        // SAFETY: broken_down 可写，now 有效；localtime_r 使用调用方存储。
        let mut broken_down = unsafe { std::mem::zeroed::<libc::tm>() };
        let converted = unsafe { libc::localtime_r(&now, &mut broken_down) };
        if converted.is_null() {
            return Err(trash_failed_with(
                "无法记录回收站删除时间，未执行删除。",
            ));
        }
        Ok(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            broken_down.tm_year + 1900,
            broken_down.tm_mon + 1,
            broken_down.tm_mday,
            broken_down.tm_hour,
            broken_down.tm_min,
            broken_down.tm_sec
        ))
    }

    #[cfg(target_os = "linux")]
    fn trash_info_contents(original: &Path) -> Result<Vec<u8>, AppError> {
        let mut text = String::from("[Trash Info]\nPath=");
        text.push_str(&percent_encoded_path(original));
        text.push_str("\nDeletionDate=");
        text.push_str(&deletion_timestamp()?);
        text.push('\n');
        Ok(text.into_bytes())
    }

    #[cfg(target_os = "linux")]
    fn write_trash_info(
        info: &Directory,
        info_name: &OsStr,
        contents: &[u8],
    ) -> Result<(), AppError> {
        use std::io::Write;
        let fd = create_at(
            info.fd,
            info_name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o666,
        )
        .map_err(|error| entry_io_error(error, "无法写入回收站信息，未执行删除。"))?;
        // SAFETY: create_at 返回本次独占的新文件 fd。
        let mut file = unsafe { fs::File::from_raw_fd(fd) };
        file.write_all(contents)
            .and_then(|()| file.flush())
            .map_err(|error| entry_io_error(error, "写入回收站信息失败，未执行删除。"))
    }

    #[cfg(target_os = "linux")]
    pub(super) fn trash_to_freedesktop(target: &BoundTrashTarget) -> Result<(), AppError> {
        let root = freedesktop_trash_root()?;
        trash_to_freedesktop_in(target, &root)
    }

    /// 目标进入回收站的方式：同卷 rename 保留原 inode，跨卷回退会发布新 inode 的副本。
    #[cfg(target_os = "linux")]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TrashMoveStrategy {
        Rename,
        Copy,
    }

    /// 发布策略可替换，便于在单卷宿主上验证跨卷（EXDEV）回退的结果，而不必真实挂载两卷。
    #[cfg(target_os = "linux")]
    type TrashPlacement =
        fn(&BoundTrashTarget, &Directory, &OsStr) -> Result<TrashMoveStrategy, AppError>;

    /// 实际回收站根目录由调用方给出，便于用临时目录验证真实写入行为。
    #[cfg(target_os = "linux")]
    pub(super) fn trash_to_freedesktop_in(
        target: &BoundTrashTarget,
        trash_root: &Path,
    ) -> Result<(), AppError> {
        trash_to_freedesktop_with(target, trash_root, move_into_trash)
    }

    #[cfg(target_os = "linux")]
    fn trash_to_freedesktop_with(
        target: &BoundTrashTarget,
        trash_root: &Path,
        place: TrashPlacement,
    ) -> Result<(), AppError> {
        // 先按已绑定的父目录 fd 复核目标身份，避免校验后被替换的项目进入回收站。
        let current = stat_at(target.parent, &target.name)
            .map_err(|error| entry_io_error(error, "无法确认回收站目标，未删除任何内容。"))?;
        if current.identity != target.identity || current.kind() != Some(target.kind) {
            return Err(AppError::new(
                "entry_changed",
                "目标在删除前已变化，未移入回收站。",
            ));
        }
        let files = prepare_trash_directory(trash_root, "files")?;
        let info = prepare_trash_directory(trash_root, "info")?;
        let (file_name, info_name) = reserve_trash_names(&files, &info, &target.name)?;
        write_trash_info(&info, &info_name, &trash_info_contents(&target.original_path)?)?;
        let strategy = match place(target, &files, &file_name) {
            Ok(strategy) => strategy,
            Err(error) => {
                // 目标没有进入回收站时不留下孤立的 .trashinfo；跨卷复制已落地则保留配对信息。
                if absent_in(&files, &file_name).unwrap_or(false) {
                    let _ = unlink_at(&info, &info_name, 0);
                }
                return Err(error);
            }
        };
        verify_trashed_entry(target, &files, &file_name, strategy)?;
        match stat_at(target.parent, &target.name) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            _ => Err(trash_failed_with(
                "回收站未移除工作区目标，未报告删除成功。",
            )),
        }
    }

    /// 回收站结果的核对方式取决于进入方式：跨卷副本是新 inode，不能按 device+inode 比对。
    #[cfg(target_os = "linux")]
    fn verify_trashed_entry(
        target: &BoundTrashTarget,
        files: &Directory,
        file_name: &OsStr,
        strategy: TrashMoveStrategy,
    ) -> Result<(), AppError> {
        let trashed = stat_at(files.fd, file_name)
            .map_err(|error| entry_io_error(error, "无法确认回收站结果，未执行永久删除。"))?;
        match strategy {
            TrashMoveStrategy::Rename => {
                if trashed.identity != target.identity {
                    return Err(trash_failed_with(
                        "回收站项目身份与目标不一致，未报告删除成功。",
                    ));
                }
            }
            // 副本必然落在回收站所在的卷，但 inode 与原项目不同；改核对类型与权限位。
            // 副本完整性由复制时逐字节写入与源文件大小比对保证，源项目移除也在其后。
            // 只比较 rwx：fchmod 可能按调用者身份丢弃 setuid/setgid，那不能把已完成的
            // 移动重新报成失败。
            TrashMoveStrategy::Copy => {
                let trash_volume = files
                    .stat()
                    .map_err(|error| entry_io_error(error, "无法确认回收站卷，未报告删除成功。"))?
                    .identity
                    .device;
                let intact = trashed.identity.device == trash_volume
                    && trashed.kind() == Some(target.kind)
                    && trashed.mode & 0o777 == target.mode & 0o777;
                if !intact {
                    return Err(trash_failed_with(
                        "回收站副本与目标不一致，未报告删除成功。",
                    ));
                }
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn move_into_trash(
        target: &BoundTrashTarget,
        files: &Directory,
        file_name: &OsStr,
    ) -> Result<TrashMoveStrategy, AppError> {
        match rename_exclusive_at(target.parent, &target.name, files.fd, file_name) {
            Ok(()) => Ok(TrashMoveStrategy::Rename),
            // 跨卷：按规范回退“复制到回收站 + 移除源”，两者都相对已打开的 fd 执行。
            Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
                copy_then_remove_source(target, files, file_name)
                    .map(|()| TrashMoveStrategy::Copy)
            }
            // 文件系统不支持 RENAME_NOREPLACE：名称已确认不存在，仍以普通 renameat 完成。
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EINVAL) | Some(libc::ENOSYS)
                ) =>
            {
                if !absent_in(files, file_name)? {
                    return Err(trash_failed_with(
                        "回收站中已存在同名项目，未执行删除。",
                    ));
                }
                rename_without_flags(target.parent, &target.name, files.fd, file_name)
                    .map_err(|error| entry_io_error(error, "无法把目标移入回收站，未执行永久删除。"))?;
                Ok(TrashMoveStrategy::Rename)
            }
            Err(error) => Err(entry_io_error(
                error,
                "无法把目标移入回收站，未执行永久删除。",
            )),
        }
    }

    #[cfg(target_os = "linux")]
    fn open_bound_source(target: &BoundTrashTarget, flags: libc::c_int) -> Result<(RawFd, NodeStat), AppError> {
        let fd = open_at(target.parent, &target.name, flags)
            .map_err(|error| entry_io_error(error, "源项目已变化或为符号链接，未执行删除。"))?;
        let opened = match stat_fd(fd) {
            Ok(stat) => stat,
            Err(error) => {
                // SAFETY: open_at 成功返回新 fd，尚未移交所有权。
                let _ = unsafe { libc::close(fd) };
                return Err(entry_io_error(error, "无法绑定源项目身份。"));
            }
        };
        if opened.identity != target.identity || opened.kind() != Some(target.kind) {
            // SAFETY: 同上，fd 尚未移交所有权。
            let _ = unsafe { libc::close(fd) };
            return Err(AppError::new(
                "entry_changed",
                "源项目在删除前已变化，未执行删除。",
            ));
        }
        Ok((fd, opened))
    }

    #[cfg(target_os = "linux")]
    fn copy_then_remove_source(
        target: &BoundTrashTarget,
        files: &Directory,
        file_name: &OsStr,
    ) -> Result<(), AppError> {
        match target.kind {
            OrdinaryEntryKind::File => {
                let (fd, opened) = open_bound_source(target, libc::O_RDONLY)?;
                // SAFETY: fd 已确认是本次绑定的普通文件，所有权唯一移交给 File。
                let mut input = unsafe { fs::File::from_raw_fd(fd) };
                let (mut temporary, mut target_file) = TemporaryEntry::file(files)
                    .map_err(|error| entry_io_error(error, "无法在回收站创建临时文件。"))?;
                let result = (|| {
                    let expected = input
                        .metadata()
                        .map(|metadata| metadata.len())
                        .map_err(|error| entry_io_error(error, "无法读取源文件大小，未移除源项目。"))?;
                    let copied = std::io::copy(&mut input, &mut target_file)
                        .map_err(|error| entry_io_error(error, "复制到回收站失败，源项目未移除。"))?;
                    // 少复制了才说明副本不完整：源文件在复制期间被追加不属于失败，
                    // 而副本不完整时源项目必须留在原地。
                    if copied < expected {
                        return Err(trash_failed_with("回收站副本不完整，源项目未移除。"));
                    }
                    target_file
                        .set_permissions(fs::Permissions::from_mode(opened.mode))
                        .map_err(|error| entry_io_error(error, "设置回收站副本权限失败。"))?;
                    drop(target_file);
                    temporary
                        .publish(file_name)
                        .map_err(|error| entry_io_error(error, "无法发布回收站项目。"))
                })();
                finish_temporary(&mut temporary, result)?;
            }
            OrdinaryEntryKind::Directory => {
                let (fd, opened) =
                    open_bound_source(target, libc::O_RDONLY | libc::O_DIRECTORY)?;
                let source = Directory { fd };
                let mut temporary = TemporaryEntry::directory(files)
                    .map_err(|error| entry_io_error(error, "无法在回收站创建临时目录。"))?;
                let result = (|| {
                    let destination = temporary
                        .directory
                        .as_ref()
                        .expect("directory temporary");
                    copy_directory_contents(&source, destination)?;
                    destination
                        .set_mode(opened.mode)
                        .map_err(|error| entry_io_error(error, "设置回收站副本权限失败。"))?;
                    temporary
                        .publish(file_name)
                        .map_err(|error| entry_io_error(error, "无法发布回收站项目。"))
                })();
                finish_temporary(&mut temporary, result)?;
            }
        }
        remove_source_entry(target)
    }

    /// 副本已在回收站落地后才移除源项目；删除仍相对已绑定父目录执行。
    #[cfg(target_os = "linux")]
    fn remove_source_entry(target: &BoundTrashTarget) -> Result<(), AppError> {
        match target.kind {
            OrdinaryEntryKind::File => unlink_at_fd(target.parent, &target.name, 0).map_err(|error| {
                entry_io_error(error, "文件已复制到回收站，但工作区源文件未能移除。")
            }),
            OrdinaryEntryKind::Directory => {
                let (fd, _) = open_bound_source(target, libc::O_RDONLY | libc::O_DIRECTORY)?;
                let directory = Directory { fd };
                cleanup_directory(&directory).map_err(|error| {
                    entry_io_error(error, "目录已复制到回收站，但工作区源目录未能完全移除。")
                })?;
                unlink_at_fd(target.parent, &target.name, libc::AT_REMOVEDIR).map_err(|error| {
                    entry_io_error(error, "目录已复制到回收站，但工作区源目录未能移除。")
                })
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Read;
        use std::os::unix::fs::symlink;

        fn boundary(root: &Path) -> EditBoundary {
            fs::create_dir(root.join(".git")).unwrap();
            let root = canonical_existing(root).unwrap();
            EditBoundary {
                root: root.clone(),
                git_dirs: vec![root.join(".git")],
            }
        }

        #[test]
        fn create_stays_in_the_open_parent_after_path_replacement() {
            let fixture = crate::test_support::git_fixture("secure-create-race");
            let root = fixture.repo("repo");
            fs::create_dir(root.join("work")).unwrap();
            let outside = fixture.path().join("outside");
            fs::create_dir(&outside).unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let parent = secure.parent(Path::new("work/new.txt"), true).unwrap();

            fs::rename(root.join("work"), root.join("original-work")).unwrap();
            symlink(&outside, root.join("work")).unwrap();
            open_new_file(&parent.directory, &parent.name).unwrap();

            assert!(root.join("original-work/new.txt").is_file());
            assert!(!outside.join("new.txt").exists());
        }

        #[test]
        fn copied_file_is_the_open_source_not_a_replacement_symlink() {
            let fixture = crate::test_support::git_fixture("secure-copy-race");
            let root = fixture.repo("repo");
            fs::write(root.join("source.txt"), b"original\n").unwrap();
            let outside = fixture.path().join("outside.txt");
            fs::write(&outside, b"outside secret\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let source = secure.source(Path::new("source.txt"), false).unwrap();
            let target = secure.target(Path::new("copy.txt")).unwrap();

            fs::rename(root.join("source.txt"), root.join("original.txt")).unwrap();
            symlink(&outside, root.join("source.txt")).unwrap();
            copy_open_file(
                source.file.expect("open source file"),
                &target.directory,
                &target.name,
                source.stat.mode,
            )
            .unwrap();

            assert_eq!(fs::read(root.join("copy.txt")).unwrap(), b"original\n");
            assert_eq!(fs::read(outside).unwrap(), b"outside secret\n");
            let mut opened = fs::File::open(root.join("source.txt")).unwrap();
            let mut replacement = String::new();
            opened.read_to_string(&mut replacement).unwrap();
            assert_eq!(replacement, "outside secret\n");
        }

        #[test]
        fn move_uses_open_source_and_target_parents_after_replacement() {
            let fixture = crate::test_support::git_fixture("secure-move-race");
            let root = fixture.repo("repo");
            fs::create_dir(root.join("work")).unwrap();
            fs::write(root.join("work/source.txt"), b"original\n").unwrap();
            let outside = fixture.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("source.txt"), b"outside\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let source = secure.source(Path::new("work/source.txt"), true).unwrap();
            let target = secure.target(Path::new("moved.txt")).unwrap();

            fs::rename(root.join("work"), root.join("original-work")).unwrap();
            symlink(&outside, root.join("work")).unwrap();
            assert_eq!(
                stat_at(source.parent.directory.fd, &source.parent.name)
                    .unwrap()
                    .identity,
                source.stat.identity
            );
            rename_exclusive(
                &source.parent.directory,
                &source.parent.name,
                &target.directory,
                &target.name,
            )
            .unwrap();

            assert_eq!(fs::read(root.join("moved.txt")).unwrap(), b"original\n");
            assert_eq!(fs::read(outside.join("source.txt")).unwrap(), b"outside\n");
            assert!(!root.join("original-work/source.txt").exists());
        }

        #[test]
        fn trash_adapter_receives_the_open_target_after_parent_replacement() {
            let fixture = crate::test_support::git_fixture("secure-trash-race");
            let root = fixture.repo("repo");
            fs::create_dir(root.join("work")).unwrap();
            fs::write(root.join("work/trash.txt"), b"original\n").unwrap();
            let outside = fixture.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("trash.txt"), b"outside\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let source = secure.source(Path::new("work/trash.txt"), true).unwrap();
            // 校验阶段绑定给回收站的目标：父目录在替换后仍然指向原项目。
            let target = source.bound_trash_target().unwrap();

            fs::rename(root.join("work"), root.join("original-work")).unwrap();
            symlink(&outside, root.join("work")).unwrap();

            // 适配器拿到的是已打开的描述符与身份，不是替换后的仓库路径。
            #[cfg(target_os = "macos")]
            {
                let mut observed = Vec::new();
                fs::File::open(&target.fd_path)
                    .unwrap()
                    .read_to_end(&mut observed)
                    .unwrap();
                assert_eq!(observed, b"original\n");
            }
            #[cfg(target_os = "linux")]
            {
                assert_eq!(target.kind, OrdinaryEntryKind::File);
                assert_eq!(
                    stat_at(target.parent, &target.name).unwrap().identity,
                    target.identity
                );
                // .trashinfo 记录的原始路径来自已打开父目录，而不是被替换的名字。
                assert_eq!(
                    target.original_path,
                    boundary.root.join("work").join("trash.txt")
                );
                let fd = open_at(target.parent, &target.name, libc::O_RDONLY).unwrap();
                // SAFETY: open_at 返回本次独占的 fd，读取后由 File 关闭。
                let mut file = unsafe { fs::File::from_raw_fd(fd) };
                let mut observed = Vec::new();
                file.read_to_end(&mut observed).unwrap();
                assert_eq!(observed, b"original\n");
            }

            assert_eq!(source.original_state(), EntryTargetState::Present);
            assert_eq!(fs::read(outside.join("trash.txt")).unwrap(), b"outside\n");
            assert_eq!(
                fs::read(root.join("original-work/trash.txt")).unwrap(),
                b"original\n"
            );
        }

        /// Linux 回收站在临时目录上真实写入：普通文件与非空目录必须离开工作区、
        /// 出现在 `Trash/files`，并写下记录原始路径的 `.trashinfo`。
        #[cfg(target_os = "linux")]
        #[test]
        fn linux_trash_moves_files_and_directories_into_the_xdg_trash() {
            let fixture = crate::test_support::git_fixture("secure-trash-xdg");
            let root = fixture.repo("repo");
            fs::write(root.join("note.txt"), b"note\n").unwrap();
            fs::create_dir(root.join("tree")).unwrap();
            fs::write(root.join("tree/child.txt"), b"child\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let trash_root = fixture.path().join("xdg-data").join("Trash");

            let source = secure.source(Path::new("note.txt"), true).unwrap();
            let file = source.bound_trash_target().unwrap();
            trash_to_freedesktop_in(&file, &trash_root).unwrap();
            drop(source);

            let files = trash_root.join("files");
            assert!(!root.join("note.txt").exists());
            assert_eq!(fs::read(files.join("note.txt")).unwrap(), b"note\n");
            let info = fs::read_to_string(trash_root.join("info/note.txt.trashinfo")).unwrap();
            assert!(info.starts_with("[Trash Info]\n"), "{info}");
            assert!(
                info.contains(&format!(
                    "Path={}",
                    percent_encoded_path(&boundary.root.join("note.txt"))
                )),
                "{info}"
            );
            assert!(info.contains("\nDeletionDate="), "{info}");

            let source = secure.source(Path::new("tree"), true).unwrap();
            let directory = source.bound_trash_target().unwrap();
            trash_to_freedesktop_in(&directory, &trash_root).unwrap();
            drop(source);

            assert!(!root.join("tree").exists());
            assert_eq!(fs::read(files.join("tree/child.txt")).unwrap(), b"child\n");
            assert!(trash_root.join("info/tree.trashinfo").is_file());
        }

        /// 回收站已有同名项目时不得覆盖，而是以不冲突的新名称发布。
        #[cfg(target_os = "linux")]
        #[test]
        fn linux_trash_publishes_a_new_name_instead_of_overwriting() {
            let fixture = crate::test_support::git_fixture("secure-trash-xdg-collision");
            let root = fixture.repo("repo");
            fs::write(root.join("note.txt"), b"new\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let trash_root = fixture.path().join("xdg-data").join("Trash");
            let files = trash_root.join("files");
            fs::create_dir_all(&files).unwrap();
            fs::write(files.join("note.txt"), b"older\n").unwrap();

            let source = secure.source(Path::new("note.txt"), true).unwrap();
            let target = source.bound_trash_target().unwrap();
            trash_to_freedesktop_in(&target, &trash_root).unwrap();

            assert!(!root.join("note.txt").exists());
            assert_eq!(fs::read(files.join("note.txt")).unwrap(), b"older\n");
            assert_eq!(fs::read(files.join("note.txt.2")).unwrap(), b"new\n");
            assert!(trash_root.join("info/note.txt.2.trashinfo").is_file());
        }

        /// 跨卷（EXDEV）回退发布的是新 inode 的副本，必须按复制策略报告成功。
        #[cfg(target_os = "linux")]
        fn forced_copy_placement(
            target: &BoundTrashTarget,
            files: &Directory,
            file_name: &OsStr,
        ) -> Result<TrashMoveStrategy, AppError> {
            copy_then_remove_source(target, files, file_name)
                .map(|()| TrashMoveStrategy::Copy)
        }

        /// 单卷宿主无法真实构造 EXDEV，这里在同一入口注入复制策略：磁盘结果与
        /// rename 路径一致（目标离开工作区、副本与 .trashinfo 成对出现），且不得
        /// 因为副本 inode 与原项目不同就报删除失败。
        #[cfg(target_os = "linux")]
        #[test]
        fn linux_trash_cross_volume_copy_fallback_reports_success() {
            let fixture = crate::test_support::git_fixture("secure-trash-xdg-exdev");
            let root = fixture.repo("repo");
            fs::write(root.join("note.txt"), b"note\n").unwrap();
            fs::create_dir(root.join("tree")).unwrap();
            fs::write(root.join("tree/child.txt"), b"child\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let trash_root = fixture.path().join("xdg-data").join("Trash");
            let trashed_files = trash_root.join("files");

            let source = secure.source(Path::new("note.txt"), true).unwrap();
            let file = source.bound_trash_target().unwrap();
            trash_to_freedesktop_with(&file, &trash_root, forced_copy_placement).unwrap();
            let identity = file.identity;
            drop(source);

            assert!(!root.join("note.txt").exists());
            assert_eq!(fs::read(trashed_files.join("note.txt")).unwrap(), b"note\n");
            assert!(trash_root.join("info/note.txt.trashinfo").is_file());
            // 副本是重新创建的 inode（真实跨卷时还在另一个 device 上），
            // 旧实现正是在按 inode 比对时把这次成功误报为删除失败。
            let trashed_dir = Directory::open_path(&trashed_files).unwrap();
            let trashed = stat_at(trashed_dir.fd, OsStr::new("note.txt")).unwrap();
            assert_ne!(trashed.identity.inode, identity.inode);
            assert_eq!(trashed.kind(), Some(OrdinaryEntryKind::File));

            let source = secure.source(Path::new("tree"), true).unwrap();
            let directory = source.bound_trash_target().unwrap();
            trash_to_freedesktop_with(&directory, &trash_root, forced_copy_placement).unwrap();
            drop(source);

            assert!(!root.join("tree").exists());
            assert_eq!(
                fs::read(trashed_files.join("tree/child.txt")).unwrap(),
                b"child\n"
            );
            assert!(trash_root.join("info/tree.trashinfo").is_file());
        }

        /// 校验必须跟随进入方式：rename 策略要求 inode 相同，复制策略要求类型与权限一致。
        #[cfg(target_os = "linux")]
        #[test]
        fn linux_trash_verification_follows_the_placement_strategy() {
            use std::os::unix::fs::PermissionsExt;

            let fixture = crate::test_support::git_fixture("secure-trash-xdg-verify");
            let root = fixture.repo("repo");
            fs::write(root.join("note.txt"), b"note\n").unwrap();
            let boundary = boundary(&root);
            let secure = SecureRoot::open(&boundary).unwrap();
            let trash_root = fixture.path().join("xdg-data").join("Trash");
            let trashed_files = trash_root.join("files");
            let files = prepare_trash_directory(&trash_root, "files").unwrap();

            let source = secure.source(Path::new("note.txt"), true).unwrap();
            let target = source.bound_trash_target().unwrap();
            let source_mode = source.stat.mode & 0o777;

            // 同卷 rename 保留原 inode，两种策略都接受这个结果。
            rename_exclusive_at(target.parent, &target.name, files.fd, OsStr::new("note.txt"))
                .unwrap();
            verify_trashed_entry(
                &target,
                &files,
                OsStr::new("note.txt"),
                TrashMoveStrategy::Rename,
            )
            .unwrap();
            verify_trashed_entry(&target, &files, OsStr::new("note.txt"), TrashMoveStrategy::Copy)
                .unwrap();

            // 新 inode 的副本不能冒充 rename 结果。
            fs::write(trashed_files.join("copy.txt"), b"note\n").unwrap();
            let error = verify_trashed_entry(
                &target,
                &files,
                OsStr::new("copy.txt"),
                TrashMoveStrategy::Rename,
            )
            .unwrap_err();
            assert_eq!(error.code, "trash_failed");

            // 权限与源项目不一致的副本也不能报告删除成功。
            let mismatched = trashed_files.join("mode.txt");
            fs::write(&mismatched, b"note\n").unwrap();
            fs::set_permissions(&mismatched, fs::Permissions::from_mode(source_mode ^ 0o001))
                .unwrap();
            let error = verify_trashed_entry(
                &target,
                &files,
                OsStr::new("mode.txt"),
                TrashMoveStrategy::Copy,
            )
            .unwrap_err();
            assert_eq!(error.code, "trash_failed");
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn create_entry(
    boundary: &EditBoundary,
    relative: &Path,
    kind: RepositoryCreateEntryKind,
) -> Result<(), AppError> {
    secure_entry_ops::create(boundary, relative, kind)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn create_entry(
    _boundary: &EditBoundary,
    _relative: &Path,
    _kind: RepositoryCreateEntryKind,
) -> Result<(), AppError> {
    Err(platform_entry_unsupported())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn copy_entry(
    boundary: &EditBoundary,
    source: &Path,
    target: &Path,
    wrote: &mut bool,
) -> Result<(), AppError> {
    secure_entry_ops::copy(boundary, source, target, wrote)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn copy_entry(
    _boundary: &EditBoundary,
    _source: &Path,
    _target: &Path,
    _wrote: &mut bool,
) -> Result<(), AppError> {
    Err(platform_entry_unsupported())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn move_entry(boundary: &EditBoundary, source: &Path, target: &Path) -> Result<(), AppError> {
    secure_entry_ops::move_entry(boundary, source, target)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn move_entry(_boundary: &EditBoundary, _source: &Path, _target: &Path) -> Result<(), AppError> {
    Err(platform_entry_unsupported())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn trash_entry<F>(
    boundary: &EditBoundary,
    relative: &Path,
    adapter: F,
) -> Result<(Result<(), AppError>, EntryTargetState), AppError>
where
    F: FnOnce(&BoundTrashTarget) -> Result<(), AppError>,
{
    secure_entry_ops::trash(boundary, relative, adapter)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn trash_entry<F>(
    _boundary: &EditBoundary,
    _relative: &Path,
    _adapter: F,
) -> Result<(Result<(), AppError>, EntryTargetState), AppError>
where
    F: FnOnce(&BoundTrashTarget) -> Result<(), AppError>,
{
    Err(platform_entry_unsupported())
}

async fn run_entry_mutation<F>(
    backend: &Backend,
    path: &str,
    root: PathBuf,
    generation: u64,
    request_id: u64,
    operation: F,
) -> Result<crate::model::StatusSnapshot, AppError>
where
    F: FnOnce(&EditBoundary, &mut bool) -> Result<(), AppError>,
{
    let git = require_git(backend).await?;
    let key = repo_key(&root);
    let mut guard = backend
        .scheduler
        .lock_write(&key, request_id, generation)
        .await?;
    let (program, args) = edit_layout_command(&git.path, &root);
    let layout = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: Some(MAX_EDIT_LAYOUT_BYTES),
            writes: false,
        })
        .await?;
    let boundary = edit_boundary_from_output(&root, &layout)?;
    // wrote 由操作在真正落盘时置位：复制可能先建临时项再失败，仍属写锁内已发生
    // 的部分写入，必须推进代次；纯校验失败（未落盘）则不推进。
    let mut wrote = false;
    let result = operation(&boundary, &mut wrote);
    if wrote {
        guard.mark_written();
    }
    let new_generation = guard.finish();
    match result {
        Ok(()) => settle_read!(backend, &root, new_generation, |current| {
            crate::git::ops::refresh_status(backend, path, current, internal_request_id()).await
        }),
        Err(error) if wrote => Err(error.with_generation(new_generation)),
        Err(error) => Err(error),
    }
}

pub async fn repository_create_entry(
    backend: &Backend,
    path: &str,
    relative: &str,
    kind: RepositoryCreateEntryKind,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative = mutation_path(relative)?;
    run_entry_mutation(backend, path, root, generation, request_id, |boundary, wrote| {
        let result = create_entry(boundary, &relative, kind);
        // 新建是原子操作：只有成功才真正落盘。
        *wrote = result.is_ok();
        result
    })
    .await
}

pub async fn repository_copy_entry(
    backend: &Backend,
    path: &str,
    source: &str,
    target: &str,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let source = mutation_path(source)?;
    let target = mutation_path(target)?;
    run_entry_mutation(backend, path, root, generation, request_id, |boundary, wrote| {
        copy_entry(boundary, &source, &target, wrote)
    })
    .await
}

pub async fn repository_move_entry(
    backend: &Backend,
    path: &str,
    source: &str,
    target: &str,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let source = mutation_path(source)?;
    let target = mutation_path(target)?;
    run_entry_mutation(backend, path, root, generation, request_id, |boundary, wrote| {
        let result = move_entry(boundary, &source, &target);
        // 移动/重命名是原子操作：只有成功才真正落盘。
        *wrote = result.is_ok();
        result
    })
    .await
}

/// 系统回收站适配器：只消费已绑定的目标身份，绝不退回按字符串重新解析的仓库路径，
/// 也绝不调用永久删除。macOS 走 NSFileManager 的 file reference URL，Linux 按
/// freedesktop 规范直接写入 `$XDG_DATA_HOME/Trash`；其它平台在校验阶段就已失败关闭。
fn move_to_system_trash(target: &BoundTrashTarget) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        // target.fd_path 是已校验目标的 /dev/fd/N。
        macos_trash::trash_bound_to_fd_path(&target.fd_path)
    }
    #[cfg(target_os = "linux")]
    {
        secure_entry_ops::trash_to_freedesktop(target)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = target;
        Err(platform_entry_unsupported())
    }
}

/// macOS 回收站删除绑定"已打开 fd 的文件身份"，而不是可被外部替换的路径字符串。
///
/// 流程：重新打开 /dev/fd/N（内核引用同一已打开文件）→ fstat 取 inode →
/// F_GETPATH 取当前路径 → 构造 NSURL file reference URL（.file/id=fsid.inode）→
/// 用 NSURLFileResourceIdentifierKey/NSURLVolumeIdentifierKey 校验 inode 与卷均与
/// 已打开 fd 一致 → trashItemAtURL 只删除该身份。任何一步失败都关闭报错，
/// 绝不回退到仓库路径，也绝不永久删除。
#[cfg(target_os = "macos")]
mod macos_trash {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        NSData, NSFileManager, NSNumber, NSString, NSURL, NSURLFileResourceIdentifierKey,
        NSURLVolumeIdentifierKey,
    };
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    fn trash_failed() -> AppError {
        AppError::new(
            "trash_failed",
            "系统回收站操作失败，未执行永久删除。",
        )
    }

    pub(super) fn trash_bound_to_fd_path(fd_path: &Path) -> Result<(), AppError> {
        let c = CString::new(fd_path.as_os_str().as_bytes()).map_err(|_| trash_failed())?;
        // SAFETY: c 以 NUL 结尾；/dev/fd/N 指向已校验的打开文件，O_NOFOLLOW 不跟随链接。
        let fd = unsafe {
            libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        if fd < 0 {
            return Err(trash_failed());
        }
        let result = trash_open_fd(fd);
        // SAFETY: fd 由本次 open 独占，无论成败都关闭，不影响源 EntrySource 的 fd。
        unsafe { libc::close(fd) };
        result
    }

    fn trash_open_fd(fd: libc::c_int) -> Result<(), AppError> {
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        // SAFETY: stat 可写，fd 存活。
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return Err(trash_failed());
        }
        let inode = stat.st_ino;
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: buf 容量 PATH_MAX，fd 存活；F_GETPATH 写入 NUL 结尾路径。
        if unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) } != 0 {
            return Err(trash_failed());
        }
        let end = buf.iter().position(|&b| b == 0).ok_or_else(trash_failed)?;
        let path = std::str::from_utf8(&buf[..end]).map_err(|_| trash_failed())?;
        let file_url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let path_volume = volume_id(&file_url).ok_or_else(trash_failed)?;
        let reference = file_url.fileReferenceURL().ok_or_else(trash_failed)?;
        let (ref_inode, ref_fsid) = file_id(&reference).ok_or_else(trash_failed)?;
        // 身份必须与已打开 fd 完全一致：inode 绑定文件本身，fsid 绑定所在卷。
        // 路径在校验后被替换时，reference 仍指向原 inode，此处不会误删替换物。
        if ref_inode != inode || ref_fsid != path_volume {
            return Err(trash_failed());
        }
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&reference, None)
            .map_err(|_| trash_failed())
    }

    fn resource(url: &NSURL, key: &NSString) -> Option<Retained<AnyObject>> {
        // SAFETY: key 为 Foundation 常量；value 输出参数由 objc2 负责内存管理。
        unsafe {
            let mut value: Option<Retained<AnyObject>> = None;
            url.getResourceValue_forKey_error(&mut value, key).ok()?;
            value
        }
    }

    fn as_u64(obj: Retained<AnyObject>) -> Option<u64> {
        if let Ok(number) = obj.clone().downcast::<NSNumber>() {
            return Some(number.unsignedLongLongValue());
        }
        if let Ok(data) = obj.downcast::<NSData>() {
            let bytes = data.to_vec();
            let mut arr = [0u8; 8];
            let n = bytes.len().min(8);
            arr[..n].copy_from_slice(&bytes[..n]);
            return Some(u64::from_le_bytes(arr));
        }
        None
    }

    fn volume_id(url: &NSURL) -> Option<u64> {
        // SAFETY: NSURLVolumeIdentifierKey 为 Foundation extern 常量。
        as_u64(resource(url, unsafe { NSURLVolumeIdentifierKey })?)
    }

    // NSURLFileResourceIdentifierKey 在本机返回 [inode(8 LE), fsid(8 LE)] 的 NSData；
    // 格式不符时返回 None，由调用方失败关闭。
    fn file_id(url: &NSURL) -> Option<(u64, u64)> {
        // SAFETY: NSURLFileResourceIdentifierKey 为 Foundation extern 常量。
        let obj = resource(url, unsafe { NSURLFileResourceIdentifierKey })?;
        let data = obj.downcast::<NSData>().ok()?;
        let bytes = data.to_vec();
        if bytes.len() < 16 {
            return None;
        }
        let inode = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
        let fsid = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
        Some((inode, fsid))
    }
}

async fn repository_delete_entry_with<F>(
    backend: &Backend,
    path: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
    trash_adapter: F,
) -> Result<crate::model::StatusSnapshot, AppError>
where
    F: FnOnce(&BoundTrashTarget) -> Result<(), AppError>,
{
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative = mutation_path(relative)?;
    let git = require_git(backend).await?;
    let key = repo_key(&root);
    let mut guard = backend
        .scheduler
        .lock_write(&key, request_id, generation)
        .await?;
    let (program, args) = edit_layout_command(&git.path, &root);
    let layout = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: Some(MAX_EDIT_LAYOUT_BYTES),
            writes: false,
        })
        .await?;
    let boundary = edit_boundary_from_output(&root, &layout)?;
    let (adapter_result, target_state) = trash_entry(&boundary, &relative, trash_adapter)?;
    match (adapter_result, target_state) {
        (Ok(()), EntryTargetState::Missing) => {
            guard.mark_written();
            let new_generation = guard.finish();
            settle_read!(backend, &root, new_generation, |current| {
                crate::git::ops::refresh_status(backend, path, current, internal_request_id()).await
            })
        }
        (Ok(()), EntryTargetState::Present) => {
            let current = guard.finish();
            let _ = crate::git::ops::refresh_status(
                backend,
                path,
                current,
                internal_request_id(),
            )
            .await;
            Err(AppError::new(
                "trash_failed",
                "回收站未移除目标，未报告删除成功，也未执行永久删除。",
            ))
        }
        (Ok(()), EntryTargetState::Unknown) => {
            let current = guard.finish();
            let refreshed = crate::git::ops::refresh_status(
                backend,
                path,
                current,
                internal_request_id(),
            )
            .await
            .is_ok();
            Err(AppError::new(
                "trash_failed",
                if refreshed {
                    "无法确认回收站结果，已刷新真实状态；未执行永久删除。"
                } else {
                    "无法确认回收站结果及当前状态；未执行永久删除。"
                },
            ))
        }
        (Err(_), EntryTargetState::Present) => {
            let current = guard.finish();
            let _ = crate::git::ops::refresh_status(
                backend,
                path,
                current,
                internal_request_id(),
            )
            .await;
            Err(AppError::new(
                "trash_failed",
                "系统回收站操作失败，目标仍保留；未执行永久删除。",
            ))
        }
        (Err(_), EntryTargetState::Missing) => {
            // 库可能移动后报告错误：代次和真实状态仍要推进，但绝不把错误改成成功。
            guard.mark_written();
            let new_generation = guard.finish();
            let refreshed = settle_read!(backend, &root, new_generation, |current| {
                crate::git::ops::refresh_status(backend, path, current, internal_request_id()).await
            })
            .is_ok();
            Err(AppError::new(
                "trash_failed",
                if refreshed {
                    "回收站返回错误，但目标已离开工作区；已推进代次并刷新状态，未执行永久删除。"
                } else {
                    "回收站返回错误，目标已离开工作区；已推进代次，但状态刷新失败，未执行永久删除。"
                },
            )
            .with_generation(new_generation))
        }
        (Err(_), EntryTargetState::Unknown) => {
            let current = guard.finish();
            let refreshed = crate::git::ops::refresh_status(
                backend,
                path,
                current,
                internal_request_id(),
            )
            .await
            .is_ok();
            Err(AppError::new(
                "trash_failed",
                if refreshed {
                    "回收站返回错误，无法确认目标是否仍保留；已刷新真实状态，未执行永久删除。"
                } else {
                    "回收站返回错误，无法确认目标及当前状态；未执行永久删除。"
                },
            ))
        }
    }
}

pub async fn repository_delete_entry(
    backend: &Backend,
    path: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::StatusSnapshot, AppError> {
    repository_delete_entry_with(
        backend,
        path,
        relative,
        generation,
        request_id,
        move_to_system_trash,
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn cached_pages_preserve_byte_boundaries_and_invalidate_changed_files() {
        let dir = crate::test_support::TempDir::new("text-cursors");
        let root = dir.path().to_path_buf();
        let path = root.join("large.txt");
        let cache = super::super::text_cursor::TextCursorCache::default();
        let line = "界".repeat(20_000);
        let original = format!("{line}\r\n").repeat(8);
        fs::write(&path, &original).unwrap();
        let read = |offset| {
            read_text_page_cached(
                root.clone(),
                "large.txt".into(),
                offset,
                500,
                Arc::new(Shutdown::new()),
                Some(&cache),
            )
            .unwrap()
        };
        let first = read(0);
        assert_eq!(first.lines.len(), 4);
        assert_eq!(first.next_offset, 4);
        let version = first.version.as_deref().unwrap();
        assert_eq!(
            cache.nearest(&path, version, 4),
            (4, 4 * (line.len() + 2) as u64)
        );
        let second = read(4);
        assert_eq!(second.lines, vec![line.clone(); 4]);
        assert_eq!(second.next_offset, 8);
        assert!(!second.has_more);
        // 同名文件被替换后不能继续使用旧字节位置。
        fs::write(&path, "one\ntwo\nthree\nfour\nlast").unwrap();
        assert_eq!(read(4).lines, vec!["last"]);
        assert_eq!(read(0).lines, vec!["one", "two", "three", "four", "last"]);
    }

    #[test]
    fn cached_pages_keep_long_line_positions_and_cancellation() {
        let dir = crate::test_support::TempDir::new("text-long-cursor");
        let root = dir.path().to_path_buf();
        let path = root.join("large.txt");
        fs::write(
            &path,
            format!("{}\nnext😀\nlast", "x".repeat(2 * 1024 * 1024)),
        )
        .unwrap();
        let cache = super::super::text_cursor::TextCursorCache::default();
        let first = read_text_page_cached(
            root.clone(),
            "large.txt".into(),
            0,
            1,
            Arc::new(Shutdown::new()),
            Some(&cache),
        )
        .unwrap();
        assert!(first.truncated);
        assert_eq!(
            cache.nearest(&path, first.version.as_deref().unwrap(), 1),
            (1, 2 * 1024 * 1024 + 1)
        );
        let second = read_text_page_cached(
            root.clone(),
            "large.txt".into(),
            1,
            1,
            Arc::new(Shutdown::new()),
            Some(&cache),
        )
        .unwrap();
        assert_eq!(second.lines, vec!["next😀"]);
        let cancel = Arc::new(Shutdown::new());
        cancel.cancel();
        assert_eq!(
            read_text_page_cached(root, "large.txt".into(), 1, 1, cancel, Some(&cache))
                .unwrap_err()
                .code,
            "cancelled"
        );
    }

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
    async fn directory_sorts_names_naturally() {
        let fixture = crate::test_support::git_fixture("repository-files-directory");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("T11-run.md"), "11").unwrap();
        fs::write(root.join("T2-run.md"), "2").unwrap();
        fs::write(root.join("T9-run.md"), "9").unwrap();
        fs::write(root.join("a10.txt"), "10").unwrap();
        fs::write(root.join("a2.txt"), "2").unwrap();
        fs::write(root.join("1.md"), "1").unwrap();
        let path = root.to_str().unwrap();
        let visible = repository_directory(&backend, path, "", false, 1, 1)
            .await
            .unwrap();
        let names: Vec<_> = visible
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["1.md", "a2.txt", "a10.txt", "T2-run.md", "T9-run.md", "T11-run.md"]);
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

    /// 忽略检查失败时必须报告，而不是把子项当成「未被忽略」照常返回。
    ///
    /// 为了让这条契约跨平台稳定，`git_io`（写 stdin 时 Git 已经退出的 EPIPE）与
    /// 非 0/1 退出码都归到 `ignore_check`：前者在 Linux 上比 Windows 更容易出现，
    /// 只断言其中一种会让同一语义随管道时序摇摆（见 `ignore_rule_matches`）。
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

    fn set_read_only(path: &Path, read_only: bool) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(read_only);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn bytes_of(parts: &[&[u8]]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for part in parts {
            bytes.extend_from_slice(part);
        }
        bytes
    }

    #[tokio::test]
    async fn edit_snapshot_reads_complete_text_with_digest_bom_and_line_endings() {
        let fixture = crate::test_support::git_fixture("repository-edit-snapshot");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let lf = b"one\ntwo\n";
        let crlf = b"one\r\ntwo\r\n";
        let bom = bytes_of(&[UTF8_BOM, b"one\ntwo\n"]);
        fs::write(root.join("lf.txt"), lf).unwrap();
        fs::write(root.join("crlf.txt"), crlf).unwrap();
        fs::write(root.join("bom.txt"), &bom).unwrap();
        fs::write(root.join("empty.txt"), b"").unwrap();
        fs::write(root.join("none.txt"), b"single line").unwrap();
        // 未跟踪文件同样可编辑：普通仓库没有 AI 元数据也能小改当前工作区文本。
        fs::write(root.join("untracked.txt"), b"fresh\n").unwrap();
        git(&root, &["add", "."]);
        let path = root.to_str().unwrap();

        let lf_digest = sha256_hex(lf);
        let lf_snapshot = repository_edit_snapshot(&backend, path, "lf.txt", 1, 1)
            .await
            .unwrap();
        assert_eq!(lf_snapshot.generation, 1);
        assert_eq!(lf_snapshot.path, "lf.txt");
        assert_eq!(lf_snapshot.state, RepositoryEditState::Editable);
        assert!(lf_snapshot.editable);
        assert_eq!(lf_snapshot.text.as_deref(), Some("one\ntwo\n"));
        assert_eq!(lf_snapshot.line_ending, RepositoryLineEnding::Lf);
        assert!(!lf_snapshot.bom);
        assert!(lf_snapshot.final_newline);
        assert_eq!(lf_snapshot.size, lf.len() as u64);
        assert_eq!(lf_snapshot.digest.as_deref(), Some(lf_digest.as_str()));
        assert!(lf_snapshot.message.is_empty());

        let crlf_snapshot = repository_edit_snapshot(&backend, path, "crlf.txt", 1, 2)
            .await
            .unwrap();
        assert_eq!(crlf_snapshot.state, RepositoryEditState::Editable);
        assert_eq!(crlf_snapshot.text.as_deref(), Some("one\ntwo\n"));
        assert_eq!(crlf_snapshot.line_ending, RepositoryLineEnding::Crlf);
        assert!(crlf_snapshot.final_newline);
        assert_eq!(crlf_snapshot.digest.as_deref(), Some(sha256_hex(crlf).as_str()));

        let bom_digest = sha256_hex(&bom);
        let bom_snapshot = repository_edit_snapshot(&backend, path, "bom.txt", 1, 3)
            .await
            .unwrap();
        assert_eq!(bom_snapshot.state, RepositoryEditState::Editable);
        assert!(bom_snapshot.bom);
        // 传输文本不带 BOM；摘要仍按含 BOM 的原始字节计算。
        assert_eq!(bom_snapshot.text.as_deref(), Some("one\ntwo\n"));
        assert_eq!(bom_snapshot.size, bom.len() as u64);
        assert_eq!(bom_snapshot.digest.as_deref(), Some(bom_digest.as_str()));

        let empty = repository_edit_snapshot(&backend, path, "empty.txt", 1, 4)
            .await
            .unwrap();
        assert_eq!(empty.state, RepositoryEditState::Editable);
        assert_eq!(empty.text.as_deref(), Some(""));
        assert_eq!(empty.line_ending, RepositoryLineEnding::None);
        assert!(!empty.final_newline);
        assert_eq!(empty.digest.as_deref(), Some(sha256_hex(b"").as_str()));

        let none = repository_edit_snapshot(&backend, path, "none.txt", 1, 5)
            .await
            .unwrap();
        assert_eq!(none.text.as_deref(), Some("single line"));
        assert_eq!(none.line_ending, RepositoryLineEnding::None);
        assert!(!none.final_newline);

        let untracked = repository_edit_snapshot(&backend, path, "untracked.txt", 1, 6)
            .await
            .unwrap();
        assert_eq!(untracked.state, RepositoryEditState::Editable);
        assert_eq!(untracked.text.as_deref(), Some("fresh\n"));
    }

    #[tokio::test]
    async fn edit_snapshot_explains_every_read_only_boundary() {
        let fixture = crate::test_support::git_fixture("repository-edit-readonly");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("too-large.txt"), vec![b'a'; MAX_EDIT_BYTES + 1]).unwrap();
        fs::write(root.join("binary.bin"), b"a\0b").unwrap();
        fs::write(root.join("invalid.txt"), [0xff_u8, 0xfe, 0xfd]).unwrap();
        fs::write(root.join("mixed.txt"), b"one\r\ntwo\n").unwrap();
        fs::write(root.join("lone-cr.txt"), b"one\rtwo").unwrap();
        fs::write(root.join("logo.png"), b"not really a png").unwrap();
        fs::create_dir_all(root.join("dir")).unwrap();
        let path = root.to_str().unwrap();

        let too_large = repository_edit_snapshot(&backend, path, "too-large.txt", 1, 1)
            .await
            .unwrap();
        assert_eq!(too_large.state, RepositoryEditState::TooLarge);
        assert!(!too_large.editable && too_large.text.is_none());
        assert!(too_large.message.contains("编辑上限"), "{}", too_large.message);

        let binary = repository_edit_snapshot(&backend, path, "binary.bin", 1, 2)
            .await
            .unwrap();
        assert_eq!(binary.state, RepositoryEditState::Binary);
        assert!(binary.text.is_none());
        assert!(binary.message.contains("二进制"), "{}", binary.message);

        let invalid = repository_edit_snapshot(&backend, path, "invalid.txt", 1, 3)
            .await
            .unwrap();
        assert_eq!(invalid.state, RepositoryEditState::InvalidUtf8);
        assert!(invalid.text.is_none());
        assert!(invalid.message.contains("UTF-8"), "{}", invalid.message);

        let mixed = repository_edit_snapshot(&backend, path, "mixed.txt", 1, 4)
            .await
            .unwrap();
        assert_eq!(mixed.state, RepositoryEditState::MixedLineEndings);
        assert_eq!(mixed.line_ending, RepositoryLineEnding::Mixed);
        assert!(mixed.text.is_none());
        assert!(mixed.message.contains("混合行尾"), "{}", mixed.message);

        // 单独一个 CR 也不是可保留的统一行尾，同样只读。
        let lone = repository_edit_snapshot(&backend, path, "lone-cr.txt", 1, 5)
            .await
            .unwrap();
        assert_eq!(lone.state, RepositoryEditState::MixedLineEndings);

        let resource = repository_edit_snapshot(&backend, path, "logo.png", 1, 6)
            .await
            .unwrap();
        assert_eq!(resource.state, RepositoryEditState::Resource);
        assert!(resource.text.is_none());

        let special = repository_edit_snapshot(&backend, path, "dir", 1, 7)
            .await
            .unwrap();
        assert_eq!(special.state, RepositoryEditState::Special);
        assert!(special.text.is_none());

        let missing = repository_edit_snapshot(&backend, path, "gone.txt", 1, 8)
            .await
            .unwrap();
        assert_eq!(missing.state, RepositoryEditState::Missing);
        assert!(missing.text.is_none());

        for unsafe_path in ["../escape.txt", ".git/config", ""] {
            let error = repository_edit_snapshot(&backend, path, unsafe_path, 1, 9)
                .await
                .unwrap_err();
            assert_eq!(error.code, "invalid_path", "{unsafe_path}");
        }

        // 代次变化后旧读取不接纳。
        backend.scheduler.bump_generation(&repo_key(&root));
        let stale = repository_edit_snapshot(&backend, path, "mixed.txt", 1, 10)
            .await
            .unwrap_err();
        assert_eq!(stale.code, "stale");
        assert_eq!(stale.generation, Some(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn edit_snapshot_and_save_refuse_symlinks() {
        use std::os::unix::fs::symlink;

        let fixture = crate::test_support::git_fixture("repository-edit-symlink");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("target.txt"), b"secret\n").unwrap();
        symlink(root.join("target.txt"), root.join("link.txt")).unwrap();
        let path = root.to_str().unwrap();

        let snapshot = repository_edit_snapshot(&backend, path, "link.txt", 1, 1)
            .await
            .unwrap();
        assert_eq!(snapshot.state, RepositoryEditState::Symlink);
        assert!(!snapshot.editable && snapshot.text.is_none());

        let error = repository_edit_save(
            &backend,
            path,
            "link.txt",
            &sha256_hex(b"secret\n"),
            "mine\n",
            1,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "edit_conflict");
        assert_eq!(fs::read(root.join("target.txt")).unwrap(), b"secret\n");
    }

    #[tokio::test]
    async fn edit_save_preserves_bom_crlf_permissions_and_final_newline() {
        let fixture = crate::test_support::git_fixture("repository-edit-save-crlf");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let original = bytes_of(&[UTF8_BOM, b"one\r\ntwo\r\n"]);
        fs::write(root.join("crlf.txt"), &original).unwrap();
        fs::write(root.join("other.txt"), b"keep\r\n").unwrap();
        git(&root, &["add", "."]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let target = root.join("crlf.txt");
            fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let path = root.to_str().unwrap();

        let before = repository_edit_snapshot(&backend, path, "crlf.txt", 1, 1)
            .await
            .unwrap();
        assert_eq!(before.line_ending, RepositoryLineEnding::Crlf);
        assert!(before.bom);

        let saved = repository_edit_save(
            &backend,
            path,
            "crlf.txt",
            before.digest.as_deref().unwrap(),
            "ONE\ntwo\nthree\n",
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(saved.generation, 2);
        assert_eq!(saved.state, RepositoryEditState::Editable);
        assert_eq!(saved.text.as_deref(), Some("ONE\ntwo\nthree\n"));
        assert_eq!(saved.line_ending, RepositoryLineEnding::Crlf);
        assert!(saved.bom);
        assert!(saved.final_newline);

        let expected = bytes_of(&[UTF8_BOM, b"ONE\r\ntwo\r\nthree\r\n"]);
        assert_eq!(fs::read(root.join("crlf.txt")).unwrap(), expected);
        let expected_digest = sha256_hex(&expected);
        assert_eq!(saved.digest.as_deref(), Some(expected_digest.as_str()));
        assert_eq!(saved.size, expected.len() as u64);
        // 未选择保存的文件不被修改。
        assert_eq!(fs::read(root.join("other.txt")).unwrap(), b"keep\r\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(root.join("crlf.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o640);
        }
    }

    #[tokio::test]
    async fn edit_save_keeps_lf_and_respects_missing_final_newline() {
        let fixture = crate::test_support::git_fixture("repository-edit-save-lf");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("note.txt"), b"one\ntwo").unwrap();
        let path = root.to_str().unwrap();

        let before = repository_edit_snapshot(&backend, path, "note.txt", 1, 1)
            .await
            .unwrap();
        assert_eq!(before.line_ending, RepositoryLineEnding::Lf);
        assert!(!before.final_newline);

        // 编辑文本没有末尾换行，保存也不补。
        let first = repository_edit_save(
            &backend,
            path,
            "note.txt",
            before.digest.as_deref().unwrap(),
            "ONE\ntwo",
            1,
            2,
        )
        .await
        .unwrap();
        assert!(!first.final_newline);
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"ONE\ntwo");
        assert_eq!(first.generation, 2);

        let second = repository_edit_save(
            &backend,
            path,
            "note.txt",
            first.digest.as_deref().unwrap(),
            "ONE\ntwo\n",
            2,
            3,
        )
        .await
        .unwrap();
        assert!(second.final_newline);
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"ONE\ntwo\n");
        assert_eq!(second.generation, 3);
    }

    #[tokio::test]
    async fn edit_save_detects_same_length_external_change_without_overwriting() {
        let fixture = crate::test_support::git_fixture("repository-edit-save-conflict");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("note.txt"), b"alpha\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();

        let before = repository_edit_snapshot(&backend, path, "note.txt", 1, 1)
            .await
            .unwrap();
        // 同长度的外部修改：长度与时间戳之外的摘要必须能识别出来。
        fs::write(root.join("note.txt"), b"bravo\n").unwrap();
        let error = repository_edit_save(
            &backend,
            path,
            "note.txt",
            before.digest.as_deref().unwrap(),
            "mines\n",
            1,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "edit_conflict");
        assert!(error.message.contains("外部修改"), "{}", error.message);
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"bravo\n");
        // 冲突不写入也不推进代次。
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);

        // 用户重新读取后，以新摘要保存成功。
        let refreshed = repository_edit_snapshot(&backend, path, "note.txt", 1, 3)
            .await
            .unwrap();
        let saved = repository_edit_save(
            &backend,
            path,
            "note.txt",
            refreshed.digest.as_deref().unwrap(),
            "mines\n",
            1,
            4,
        )
        .await
        .unwrap();
        assert_eq!(saved.digest.as_deref(), Some(sha256_hex(b"mines\n").as_str()));
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"mines\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 2);

        // 写锁内还复核 generation：外部刷新推进代次后，旧代次的保存不能写入。
        backend.scheduler.bump_generation(&repo_key(&root));
        let stale = repository_edit_save(
            &backend,
            path,
            "note.txt",
            saved.digest.as_deref().unwrap(),
            "stale\n",
            1,
            5,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, "stale");
        assert_eq!(stale.generation, Some(3));
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"mines\n");
    }

    #[tokio::test]
    async fn edit_save_rejects_files_that_stop_being_editable_after_the_snapshot() {
        let fixture = crate::test_support::git_fixture("repository-edit-save-capability");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("target.txt"), b"keep\n").unwrap();
        let path = root.to_str().unwrap();
        let before = repository_edit_snapshot(&backend, path, "target.txt", 1, 1)
            .await
            .unwrap();
        let digest = before.digest.unwrap();

        // 文件被删除：不重建、不覆盖。
        fs::remove_file(root.join("target.txt")).unwrap();
        let missing = repository_edit_save(&backend, path, "target.txt", &digest, "mine\n", 1, 2)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "edit_conflict");
        assert!(!root.join("target.txt").exists());

        // 同一路径变成目录：不写入。
        fs::create_dir_all(root.join("target.txt")).unwrap();
        let special = repository_edit_save(&backend, path, "target.txt", &digest, "mine\n", 1, 3)
            .await
            .unwrap_err();
        assert_eq!(special.code, "edit_conflict");
        assert!(root.join("target.txt").is_dir());
        fs::remove_dir(root.join("target.txt")).unwrap();

        // 恢复普通文件后再变成非法 UTF-8：旧摘要失配，保存不覆盖外部内容。
        fs::write(root.join("target.txt"), b"keep\n").unwrap();
        let again = repository_edit_snapshot(&backend, path, "target.txt", 1, 4)
            .await
            .unwrap();
        assert_eq!(again.digest, Some(digest));
        fs::write(root.join("target.txt"), [0xff_u8, 0xfe]).unwrap();
        let invalid = repository_edit_save(
            &backend,
            path,
            "target.txt",
            again.digest.as_deref().unwrap(),
            "mine\n",
            1,
            5,
        )
        .await
        .unwrap_err();
        assert_eq!(invalid.code, "edit_conflict");
        assert_eq!(fs::read(root.join("target.txt")).unwrap(), [0xff_u8, 0xfe]);
    }

    #[tokio::test]
    async fn edit_save_write_failures_keep_the_original_file_and_generation() {
        let fixture = crate::test_support::git_fixture("repository-edit-save-failure");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("locked.txt"), b"keep\n").unwrap();
        let path = root.to_str().unwrap();
        let before = repository_edit_snapshot(&backend, path, "locked.txt", 1, 1)
            .await
            .unwrap();
        let digest = before.digest.unwrap();

        // 只读文件：保留原内容，不报告成功。
        set_read_only(&root.join("locked.txt"), true);
        let readonly = repository_edit_save(
            &backend,
            path,
            "locked.txt",
            &digest,
            "mine\n",
            1,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(readonly.code, "edit_write_failed");
        assert_eq!(fs::read(root.join("locked.txt")).unwrap(), b"keep\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);
        set_read_only(&root.join("locked.txt"), false);

        // 摘要格式、正文边界都必须在写入前拒绝。
        let bad_digest =
            repository_edit_save(&backend, path, "locked.txt", "not-a-digest", "mine\n", 1, 3)
                .await
                .unwrap_err();
        assert_eq!(bad_digest.code, "edit_digest");
        let nul = repository_edit_save(
            &backend,
            path,
            "locked.txt",
            &digest,
            "bad\0text",
            1,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(nul.code, "edit_content");
        let cr = repository_edit_save(
            &backend,
            path,
            "locked.txt",
            &digest,
            "bad\r\ntext",
            1,
            5,
        )
        .await
        .unwrap_err();
        assert_eq!(cr.code, "edit_content");
        let oversized_content = "a".repeat(MAX_EDIT_BYTES + 1);
        let oversized = repository_edit_save(
            &backend,
            path,
            "locked.txt",
            &digest,
            &oversized_content,
            1,
            6,
        )
        .await
        .unwrap_err();
        assert_eq!(oversized.code, "edit_content");
        assert_eq!(fs::read(root.join("locked.txt")).unwrap(), b"keep\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);
    }

    #[tokio::test]
    async fn edit_save_keeps_head_and_index_and_the_new_generation_refreshes() {
        let fixture = crate::test_support::git_fixture("repository-edit-save-git");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("app.txt"), b"a\n").unwrap();
        fs::write(root.join("other.txt"), b"b\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let before_head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let before_index = git_stdout(&root, &["ls-files", "--stage"]);
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]), "");

        let before = repository_edit_snapshot(&backend, path, "app.txt", 1, 1)
            .await
            .unwrap();
        let saved = repository_edit_save(
            &backend,
            path,
            "app.txt",
            before.digest.as_deref().unwrap(),
            "a\nb\n",
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(saved.generation, 2);
        // 保存只改工作区文件：HEAD、暂存区与其他文件都不动。
        assert_eq!(git_stdout(&root, &["rev-parse", "HEAD"]), before_head);
        assert_eq!(git_stdout(&root, &["ls-files", "--stage"]), before_index);
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]), " M app.txt\n");
        assert_eq!(fs::read(root.join("other.txt")).unwrap(), b"b\n");

        // 新代次可以直接用于状态与单文件审阅刷新。
        let status = crate::git::ops::refresh_status(
            &backend,
            path,
            saved.generation,
            crate::git::schedule::internal_request_id(),
        )
        .await
        .unwrap();
        assert_eq!(status.generation, saved.generation);
        let app = status
            .files
            .iter()
            .find(|file| file.path == "app.txt")
            .unwrap();
        assert_eq!(app.unstaged, ChangeKind::Modified);
        assert!(status.files.iter().all(|file| file.path != "other.txt"));
        let token = repository_review_token(
            &backend,
            path,
            "app.txt",
            saved.generation,
            crate::git::schedule::internal_request_id(),
        )
        .await
        .unwrap();
        assert_eq!(token.state, RepositoryReviewState::Current);
        assert!(token.token.is_some());

        // 保存前的旧代次已经失效，不能继续拿旧快照写入。
        let stale = repository_edit_snapshot(&backend, path, "app.txt", before.generation, 7)
            .await
            .unwrap_err();
        assert_eq!(stale.code, "stale");
        assert_eq!(stale.generation, Some(saved.generation));
    }

    #[test]
    fn git_metadata_names_cover_case_trailing_dots_streams_and_short_names() {
        for name in [
            ".git",
            ".GIT",
            ".Git",
            ".git.",
            ".git..",
            ".git ",
            ".git. ",
            ".git::$INDEX_ALLOCATION",
            ".git:stream",
            "GIT~1",
            "git~1",
            ".g\u{200C}it",
            "\u{FEFF}.git",
        ] {
            assert!(is_git_metadata_name(OsStr::new(name)), "{name:?}");
        }
        for name in [".gitignore", ".github", "git", "a.git", ".gitx", "GIT~2x"] {
            assert!(!is_git_metadata_name(OsStr::new(name)), "{name:?}");
        }
        for path in [".GIT/config", ".git./config", ".Git/HEAD", "sub/.git /config"] {
            let error = review_path(path).unwrap_err();
            assert_eq!(error.code, "invalid_path", "{path}");
        }
        assert!(review_path(".github/workflows/ci.yml").is_ok());
        assert!(review_path("docs/.gitignore").is_ok());
    }

    #[tokio::test]
    async fn edit_snapshot_and_save_refuse_git_metadata_aliases() {
        let fixture = crate::test_support::git_fixture("repository-edit-git-alias");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let config_before = fs::read(root.join(".git/config")).unwrap();
        let head_before = fs::read(root.join(".git/HEAD")).unwrap();
        let path = root.to_str().unwrap();

        for alias in [
            ".git/config",
            ".GIT/config",
            ".git./config",
            ".git /config",
            ".Git/HEAD",
            ".git::$INDEX_ALLOCATION/config",
            "GIT~1/config",
        ] {
            let snapshot = repository_edit_snapshot(&backend, path, alias, 1, 1)
                .await
                .unwrap_err();
            assert_eq!(snapshot.code, "invalid_path", "{alias}");
            let current = if alias.ends_with("HEAD") {
                &head_before
            } else {
                &config_before
            };
            let save = repository_edit_save(
                &backend,
                path,
                alias,
                &sha256_hex(current),
                "[core]\n\tfsmonitor = probe-marker\n",
                1,
                2,
            )
            .await
            .unwrap_err();
            assert_eq!(save.code, "invalid_path", "{alias}");
        }
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), config_before);
        assert_eq!(fs::read(root.join(".git/HEAD")).unwrap(), head_before);
        // 拒绝不产生写入，代次不前进。
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);
    }

    /// 词法检查之外的第二道防线：绕过 review_path 直接读取时，大小写不敏感的文件系统会把别名
    /// 解析到真实的 .git，解析后的路径仍必须被拒绝。
    #[cfg(windows)]
    #[test]
    fn resolved_git_metadata_is_rejected_even_without_the_lexical_guard() {
        let fixture = crate::test_support::git_fixture("repository-edit-git-resolved");
        let root = fixture.repo("repo");
        git(&root, &["init", "-b", "main"]);
        let root = canonical_existing(&root).unwrap();
        // 不带 gitdir 列表：只验证“解析后的真实名字”这一道防线。
        let boundary = EditBoundary {
            root: root.clone(),
            git_dirs: Vec::new(),
        };
        for alias in [".GIT/config", ".git./config", ".Git/HEAD"] {
            let error = read_edit_file(&boundary, Path::new(alias), &Shutdown::new()).unwrap_err();
            assert_eq!(error.code, "invalid_path", "{alias}");
        }
        let resolved = canonical_existing(&root.join(".GIT").join("config")).unwrap();
        assert_eq!(
            ensure_editable_location(&boundary, &resolved).unwrap_err().code,
            "invalid_path"
        );
        let ordinary = root.join("note.txt");
        fs::write(&ordinary, b"x\n").unwrap();
        assert!(
            ensure_editable_location(&boundary, &canonical_existing(&ordinary).unwrap()).is_ok()
        );
    }

    /// 传入的仓库路径必须由 Git 确认是工作区顶层：gitdir 自身、子目录与非仓库目录都不能当作根。
    #[tokio::test]
    async fn edit_snapshot_and_save_require_the_git_worktree_root() {
        let fixture = crate::test_support::git_fixture("repository-edit-worktree-root");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.txt"), b"app\n").unwrap();
        let outside = fixture.repo("plain");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("settings.txt"), b"plain\n").unwrap();
        let config_before = fs::read(root.join(".git/config")).unwrap();

        let git_dir = root.join(".git");
        let sub_dir = root.join("src");
        let cases: [(&Path, &str, Vec<u8>); 3] = [
            (git_dir.as_path(), "config", config_before.clone()),
            (sub_dir.as_path(), "app.txt", b"app\n".to_vec()),
            (outside.as_path(), "settings.txt", b"plain\n".to_vec()),
        ];
        for (index, (base, relative, current)) in cases.iter().enumerate() {
            let path = base.to_str().unwrap();
            let id = (index as u64) * 2 + 1;
            let snapshot = repository_edit_snapshot(&backend, path, relative, 1, id)
                .await
                .unwrap_err();
            assert_eq!(snapshot.code, "invalid_path", "{path}");
            let save = repository_edit_save(
                &backend,
                path,
                relative,
                &sha256_hex(current),
                "[core]\n\tfsmonitor = probe-marker\n",
                1,
                id + 1,
            )
            .await
            .unwrap_err();
            assert_eq!(save.code, "invalid_path", "{path}");
            assert_eq!(&fs::read(base.join(relative)).unwrap(), current, "{path}");
            let key = repo_key(&canonical_existing(base).unwrap());
            assert_eq!(backend.scheduler.current_generation(&key), 1, "{path}");
        }
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), config_before);

        // 同一仓库从真正的工作区根打开时，普通文件仍可编辑。
        let ok = repository_edit_snapshot(&backend, root.to_str().unwrap(), "src/app.txt", 1, 20)
            .await
            .unwrap();
        assert_eq!(ok.state, RepositoryEditState::Editable);
    }

    /// gitdir 不叫 .git 也不能编辑：这里用 gitfile 把元数据放在工作区内的 store/ 目录，
    /// 词法检查看不出来，必须靠 Git 报告的 gitdir 拒绝。
    #[tokio::test]
    async fn edit_snapshot_and_save_refuse_a_gitdir_without_a_git_name() {
        let fixture = crate::test_support::git_fixture("repository-edit-separate-gitdir");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        fs::create_dir_all(&root).unwrap();
        let store = root.join("store");
        git(
            &root,
            &["init", "-b", "main", "--separate-git-dir", store.to_str().unwrap()],
        );
        assert!(root.join(".git").is_file());
        fs::write(root.join("note.txt"), b"note\n").unwrap();
        let config_before = fs::read(store.join("config")).unwrap();
        let path = root.to_str().unwrap();

        let snapshot = repository_edit_snapshot(&backend, path, "store/config", 1, 1)
            .await
            .unwrap_err();
        assert_eq!(snapshot.code, "invalid_path");
        let save = repository_edit_save(
            &backend,
            path,
            "store/config",
            &sha256_hex(&config_before),
            "[core]\n\tfsmonitor = probe-marker\n",
            1,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(save.code, "invalid_path");
        assert_eq!(fs::read(store.join("config")).unwrap(), config_before);
        // gitfile 本身仍由 .git 名字拦住。
        let gitfile = repository_edit_snapshot(&backend, path, ".git", 1, 3)
            .await
            .unwrap_err();
        assert_eq!(gitfile.code, "invalid_path");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);

        let note = repository_edit_snapshot(&backend, path, "note.txt", 1, 4)
            .await
            .unwrap();
        assert_eq!(note.state, RepositoryEditState::Editable);
    }

    /// 关联工作树的 gitdir 与公共 gitdir 都在工作区外：普通文件可以保存，且不动主仓库。
    #[tokio::test]
    async fn edit_save_works_in_a_linked_worktree() {
        let fixture = crate::test_support::git_fixture("repository-edit-linked-worktree");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("note.txt"), b"main\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let linked = fixture.repo("linked");
        git(
            &root,
            &["worktree", "add", "-q", "-b", "topic", linked.to_str().unwrap()],
        );
        let path = linked.to_str().unwrap();
        let before = repository_edit_snapshot(&backend, path, "note.txt", 1, 1)
            .await
            .unwrap();
        assert_eq!(before.state, RepositoryEditState::Editable);
        let saved = repository_edit_save(
            &backend,
            path,
            "note.txt",
            before.digest.as_deref().unwrap(),
            "linked\n",
            1,
            2,
        )
        .await
        .unwrap();
        assert_eq!(saved.text.as_deref(), Some("linked\n"));
        assert_eq!(fs::read(linked.join("note.txt")).unwrap(), b"linked\n");
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"main\n");
    }

    #[test]
    fn edit_boundary_rejects_failed_or_mismatched_git_answers() {
        let fixture = crate::test_support::git_fixture("repository-edit-boundary-parse");
        let root = fixture.repo("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let root = canonical_existing(&root).unwrap();
        let git_dir = root.join(".git");
        let output = |exit_code: i32, stdout: String| ProcessOutput {
            exit_code,
            stdout: stdout.into_bytes(),
            stderr: Vec::new(),
            stdout_truncated: false,
        };
        let answer = |top: &Path| {
            format!("{}\n{}\n{}\n", top.display(), git_dir.display(), git_dir.display())
        };

        let ok = edit_boundary_from_output(&root, &output(0, answer(&root))).unwrap();
        assert_eq!(ok.git_dirs, vec![git_dir.clone()]);
        for (code, stdout) in [
            (128, String::new()),
            (0, String::new()),
            (0, answer(&root.join("src"))),
            (0, format!("{}\n", root.display())),
            (0, format!("{}\n{}\n", root.display(), root.join("missing").display())),
            // 工作区落在 gitdir 里时无法区分元数据，整体拒绝。
            (0, format!("{}\n{}\n{}\n", root.display(), root.display(), root.display())),
        ] {
            let error = edit_boundary_from_output(&root, &output(code, stdout.clone()));
            assert_eq!(error.err().map(|e| e.code), Some("invalid_path".to_string()), "{stdout:?}");
        }
    }

    fn assert_head_and_index(root: &Path, head: &str, index: &str) {
        assert_eq!(git_stdout(root, &["rev-parse", "HEAD"]), head);
        assert_eq!(git_stdout(root, &["ls-files", "--stage"]), index);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn assert_no_entry_temporaries(root: &Path) {
        let names: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(
            names
                .iter()
                .all(|name| !name.to_string_lossy().starts_with(".twiglane-entry-")),
            "{names:?}"
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn platforms_without_descriptor_relative_writes_fail_closed() {
        let boundary = EditBoundary {
            root: PathBuf::from("unsupported-platform"),
            git_dirs: Vec::new(),
        };
        let errors = [
            create_entry(
                &boundary,
                Path::new("new.txt"),
                RepositoryCreateEntryKind::File,
            )
            .unwrap_err(),
            copy_entry(&boundary, Path::new("a"), Path::new("b"), &mut false).unwrap_err(),
            move_entry(&boundary, Path::new("a"), Path::new("b")).unwrap_err(),
            trash_entry(&boundary, Path::new("a"), |_| {
                panic!("不支持的平台不得调用回收站适配器")
            })
            .unwrap_err(),
        ];
        for error in errors {
            assert_eq!(error.code, "entry_platform_unsupported");
        }
    }

    /// 非 macOS/Linux 目标没有 fd 相对原语：四个命令必须给出结构化错误并停在校验前，
    /// 而不是 panic 或写入磁盘。Windows CI 用这个用例证明失败关闭的具体形态。
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[tokio::test]
    async fn entry_commands_fail_closed_without_descriptor_relative_primitives() {
        let fixture = crate::test_support::git_fixture("repository-entry-unsupported-platform");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("note.txt"), b"note\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);

        let errors = [
            repository_create_entry(
                &backend,
                path,
                "new.txt",
                RepositoryCreateEntryKind::File,
                1,
                300,
            )
            .await
            .unwrap_err(),
            repository_copy_entry(&backend, path, "note.txt", "copy.txt", 1, 301)
                .await
                .unwrap_err(),
            repository_move_entry(&backend, path, "note.txt", "moved.txt", 1, 302)
                .await
                .unwrap_err(),
            repository_delete_entry(&backend, path, "note.txt", 1, 303)
                .await
                .unwrap_err(),
        ];
        for error in errors {
            assert_eq!(error.code, "entry_platform_unsupported");
        }
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"note\n");
        assert!(!root.join("new.txt").exists());
        assert!(!root.join("copy.txt").exists());
        assert!(!root.join("moved.txt").exists());
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);
        assert_head_and_index(&root, &head, &index);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn entry_create_copy_and_move_return_same_generation_status_without_git_writes() {
        let fixture = crate::test_support::git_fixture("repository-entry-success");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("tree/sub")).unwrap();
        fs::write(root.join("tree/root.txt"), b"root\n").unwrap();
        fs::write(root.join("tree/sub/child.txt"), b"child\n").unwrap();
        fs::write(root.join("tracked.txt"), b"tracked\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);

        let created_file = repository_create_entry(
            &backend,
            path,
            "empty.txt",
            RepositoryCreateEntryKind::File,
            1,
            10,
        )
        .await
        .unwrap();
        assert_eq!(created_file.generation, 2);
        assert_eq!(fs::metadata(root.join("empty.txt")).unwrap().len(), 0);
        assert!(created_file.files.iter().any(|file| file.path == "empty.txt"));

        let created_directory = repository_create_entry(
            &backend,
            path,
            "copies",
            RepositoryCreateEntryKind::Directory,
            created_file.generation,
            11,
        )
        .await
        .unwrap();
        assert_eq!(created_directory.generation, 3);
        assert!(root.join("copies").is_dir());
        assert_eq!(fs::read_dir(root.join("copies")).unwrap().count(), 0);

        let copied_file = repository_copy_entry(
            &backend,
            path,
            "tracked.txt",
            "copies/file.txt",
            created_directory.generation,
            12,
        )
        .await
        .unwrap();
        assert_eq!(copied_file.generation, 4);
        assert_eq!(fs::read(root.join("copies/file.txt")).unwrap(), b"tracked\n");
        assert_eq!(fs::read(root.join("tracked.txt")).unwrap(), b"tracked\n");

        let copied_directory = repository_copy_entry(
            &backend,
            path,
            "tree",
            "cloned",
            copied_file.generation,
            13,
        )
        .await
        .unwrap();
        assert_eq!(copied_directory.generation, 5);
        assert_eq!(fs::read(root.join("cloned/root.txt")).unwrap(), b"root\n");
        assert_eq!(
            fs::read(root.join("cloned/sub/child.txt")).unwrap(),
            b"child\n"
        );

        let renamed = repository_move_entry(
            &backend,
            path,
            "copies/file.txt",
            "renamed.txt",
            copied_directory.generation,
            14,
        )
        .await
        .unwrap();
        assert_eq!(renamed.generation, 6);
        assert!(!root.join("copies/file.txt").exists());
        assert_eq!(fs::read(root.join("renamed.txt")).unwrap(), b"tracked\n");

        let moved = repository_move_entry(
            &backend,
            path,
            "cloned",
            "moved",
            renamed.generation,
            15,
        )
        .await
        .unwrap();
        assert_eq!(moved.generation, 7);
        assert!(!root.join("cloned").exists());
        assert_eq!(fs::read(root.join("moved/sub/child.txt")).unwrap(), b"child\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), moved.generation);
        assert_head_and_index(&root, &head, &index);
        assert_no_entry_temporaries(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn entry_operations_reject_conflicts_unsafe_paths_and_special_targets() {
        let fixture = crate::test_support::git_fixture("repository-entry-rejections");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("dir/sub")).unwrap();
        fs::write(root.join("dir/sub/keep.txt"), b"keep\n").unwrap();
        fs::write(root.join("source.txt"), b"source\n").unwrap();
        fs::write(root.join("target.txt"), b"existing\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);

        let conflict = repository_create_entry(
            &backend,
            path,
            "target.txt",
            RepositoryCreateEntryKind::File,
            1,
            20,
        )
        .await
        .unwrap_err();
        assert_eq!(conflict.code, "entry_exists");
        let conflict = repository_copy_entry(&backend, path, "source.txt", "target.txt", 1, 21)
            .await
            .unwrap_err();
        assert_eq!(conflict.code, "entry_exists");
        let conflict = repository_move_entry(&backend, path, "source.txt", "target.txt", 1, 22)
            .await
            .unwrap_err();
        assert_eq!(conflict.code, "entry_exists");
        assert_eq!(fs::read(root.join("target.txt")).unwrap(), b"existing\n");
        assert_eq!(fs::read(root.join("source.txt")).unwrap(), b"source\n");

        let absolute = fixture.path().join("outside.txt").to_string_lossy().into_owned();
        for (offset, invalid) in [
            "".to_string(),
            "../outside.txt".to_string(),
            absolute,
            ".git/config".to_string(),
            "bad\0name".to_string(),
            "bad\nname".to_string(),
        ]
        .into_iter()
        .enumerate()
        {
            let id = 30 + offset as u64 * 4;
            for error in [
                repository_create_entry(
                    &backend,
                    path,
                    &invalid,
                    RepositoryCreateEntryKind::File,
                    1,
                    id,
                )
                .await
                .unwrap_err(),
                repository_copy_entry(&backend, path, "source.txt", &invalid, 1, id + 1)
                    .await
                    .unwrap_err(),
                repository_move_entry(&backend, path, &invalid, "other.txt", 1, id + 2)
                    .await
                    .unwrap_err(),
                repository_delete_entry(&backend, path, &invalid, 1, id + 3)
                    .await
                    .unwrap_err(),
            ] {
                assert_eq!(error.code, "invalid_path", "{invalid:?}");
            }
        }
        assert!(!fixture.path().join("outside.txt").exists());

        let missing_parent = repository_create_entry(
            &backend,
            path,
            "absent/child.txt",
            RepositoryCreateEntryKind::File,
            1,
            60,
        )
        .await
        .unwrap_err();
        assert_eq!(missing_parent.code, "path_missing");

        for (source, target, id) in [("dir", "dir", 61), ("dir", "dir/sub/copy", 62)] {
            let error = repository_move_entry(&backend, path, source, target, 1, id)
                .await
                .unwrap_err();
            assert!(matches!(error.code.as_str(), "entry_exists" | "invalid_target"));
            let error = repository_copy_entry(&backend, path, source, target, 1, id + 10)
                .await
                .unwrap_err();
            assert!(matches!(error.code.as_str(), "entry_exists" | "invalid_target"));
        }

        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        git(&child, &["init", "-b", "main"]);
        fs::write(child.join("inside.txt"), b"nested\n").unwrap();
        for error in [
            repository_copy_entry(&backend, path, "child", "child-copy", 1, 80)
                .await
                .unwrap_err(),
            repository_move_entry(&backend, path, "child", "child-moved", 1, 81)
                .await
                .unwrap_err(),
            repository_delete_entry(&backend, path, "child", 1, 82)
                .await
                .unwrap_err(),
            repository_copy_entry(&backend, path, "child/inside.txt", "nested.txt", 1, 83)
                .await
                .unwrap_err(),
        ] {
            assert_eq!(error.code, "nested_repository");
        }
        assert_eq!(fs::read(child.join("inside.txt")).unwrap(), b"nested\n");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink("source.txt", root.join("link.txt")).unwrap();
            let outside = fixture.path().join("outside");
            fs::create_dir(&outside).unwrap();
            symlink(&outside, root.join("escape")).unwrap();
            let fifo = root.join("fifo");
            let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            // SAFETY: fifo_c 是有效的 NUL 结尾路径；只在测试临时仓库创建 FIFO。
            assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
            for (source, id) in [("link.txt", 90), ("fifo", 94)] {
                for error in [
                    repository_copy_entry(&backend, path, source, "special-copy", 1, id)
                        .await
                        .unwrap_err(),
                    repository_move_entry(&backend, path, source, "special-move", 1, id + 1)
                        .await
                        .unwrap_err(),
                    repository_delete_entry(&backend, path, source, 1, id + 2)
                        .await
                        .unwrap_err(),
                ] {
                    assert_eq!(error.code, "unsupported_entry", "{source}");
                }
            }
            let linked_parent = repository_create_entry(
                &backend,
                path,
                "escape/new.txt",
                RepositoryCreateEntryKind::File,
                1,
                100,
            )
            .await
            .unwrap_err();
            assert_eq!(linked_parent.code, "file_path");
            assert!(!outside.join("new.txt").exists());

            // 已创建过部分临时内容也必须整体失败，不能留下半个目标或跟随链接。
            symlink("../source.txt", root.join("dir/link.txt")).unwrap();
            let partial = repository_copy_entry(&backend, path, "dir", "partial-copy", 1, 101)
                .await
                .unwrap_err();
            assert_eq!(partial.code, "unsupported_entry");
            // 复制已创建临时目录（写锁内部分写入），失败后仍推进代次并随错误返回。
            assert_eq!(partial.generation, Some(2));
            assert!(!root.join("partial-copy").exists());
            assert_eq!(fs::read(root.join("source.txt")).unwrap(), b"source\n");
        }

        // 安全结构路径会执行 dir→partial-copy 并推进代次；其余拒绝用例都不落盘。
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 2);
        assert_head_and_index(&root, &head, &index);
        assert_no_entry_temporaries(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn entry_names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// `--separate-git-dir` 把 gitdir 放在工作区内且不叫 `.git` 时，入口自身也必须按身份拒绝：
    /// copy/move/trash 一旦作用在仓库元数据上，移动或删除会直接损坏仓库。
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn entry_operations_refuse_a_gitdir_without_a_git_name() {
        let fixture = crate::test_support::git_fixture("repository-entry-separate-gitdir");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        let store = root.join("store");
        git(
            &root,
            &["init", "-b", "main", "--separate-git-dir", store.to_str().unwrap()],
        );
        assert!(root.join(".git").is_file());
        assert!(store.join("HEAD").is_file());
        fs::write(root.join("note.txt"), b"note\n").unwrap();
        let path = root.to_str().unwrap();
        let config = fs::read(store.join("config")).unwrap();
        let names_before = entry_names(&root);

        for (source, target, id) in [
            ("store", "store-copy", 200u64),
            ("store", "store-moved", 202),
            ("store/config", "config-copy", 204),
            ("store/config", "config-moved", 206),
        ] {
            let copied = repository_copy_entry(&backend, path, source, target, 1, id)
                .await
                .unwrap_err();
            assert_eq!(copied.code, "invalid_path", "{source} -> {target}");
            let moved = repository_move_entry(&backend, path, source, target, 1, id + 1)
                .await
                .unwrap_err();
            assert_eq!(moved.code, "invalid_path", "{source} -> {target}");
        }
        for (source, id) in [("store", 210u64), ("store/config", 211)] {
            let deleted = repository_delete_entry(&backend, path, source, 1, id)
                .await
                .unwrap_err();
            assert_eq!(deleted.code, "invalid_path", "{source}");
        }
        // gitdir 及其内容必须原样保留，也没有任何新条目落地。
        assert_eq!(fs::read(store.join("config")).unwrap(), config);
        assert!(store.join("HEAD").is_file());
        assert_eq!(entry_names(&root), names_before);
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);

        // 同仓库的普通文件仍可复制：防线只针对 gitdir，不误伤工作区文件。
        let copied = repository_copy_entry(&backend, path, "note.txt", "note-copy.txt", 1, 220)
            .await
            .unwrap();
        assert_eq!(copied.generation, 2);
        assert_eq!(fs::read(root.join("note-copy.txt")).unwrap(), b"note\n");
        assert_eq!(fs::read(store.join("config")).unwrap(), config);
        assert!(store.join("HEAD").is_file());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn entry_write_failures_and_stale_requests_do_not_change_disk_or_generation() {
        let fixture = crate::test_support::git_fixture("repository-entry-write-failure");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir(root.join("locked")).unwrap();
        fs::write(root.join("source.txt"), b"source\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);

        set_read_only(&root.join("locked"), true);
        for error in [
            repository_create_entry(
                &backend,
                path,
                "locked/new.txt",
                RepositoryCreateEntryKind::File,
                1,
                110,
            )
            .await
            .unwrap_err(),
            repository_copy_entry(&backend, path, "source.txt", "locked/copy.txt", 1, 111)
                .await
                .unwrap_err(),
            repository_move_entry(&backend, path, "source.txt", "locked/move.txt", 1, 112)
                .await
                .unwrap_err(),
        ] {
            assert_eq!(error.code, "permission");
        }
        set_read_only(&root.join("locked"), false);
        assert_eq!(fs::read_dir(root.join("locked")).unwrap().count(), 0);
        assert_eq!(fs::read(root.join("source.txt")).unwrap(), b"source\n");

        backend.scheduler.bump_generation(&repo_key(&root));
        for error in [
            repository_create_entry(
                &backend,
                path,
                "stale.txt",
                RepositoryCreateEntryKind::File,
                1,
                120,
            )
            .await
            .unwrap_err(),
            repository_copy_entry(&backend, path, "source.txt", "stale-copy.txt", 1, 121)
                .await
                .unwrap_err(),
            repository_move_entry(&backend, path, "source.txt", "stale-move.txt", 1, 122)
                .await
                .unwrap_err(),
            repository_delete_entry(&backend, path, "source.txt", 1, 123)
                .await
                .unwrap_err(),
        ] {
            assert_eq!(error.code, "stale");
            assert_eq!(error.generation, Some(2));
        }
        assert!(root.join("source.txt").exists());
        assert!(!root.join("stale.txt").exists());
        assert!(!root.join("stale-copy.txt").exists());
        assert!(!root.join("stale-move.txt").exists());
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 2);
        assert_head_and_index(&root, &head, &index);
        assert_no_entry_temporaries(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn trash_adapter_failures_preserve_files_directories_and_git_state() {
        let fixture = crate::test_support::git_fixture("repository-entry-trash-failure");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("directory/sub")).unwrap();
        fs::write(root.join("file.txt"), b"file\n").unwrap();
        fs::write(root.join("directory/sub/keep.txt"), b"keep\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);

        for (relative, id) in [("file.txt", 130), ("directory", 131)] {
            let error = repository_delete_entry_with(
                &backend,
                path,
                relative,
                1,
                id,
                |_| Err(AppError::new("trash_failed", "injected unavailable trash")),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "trash_failed");
            assert!(error.message.contains("目标仍保留"));
            assert!(!error.message.contains("injected"));
        }
        assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"file\n");
        assert_eq!(
            fs::read(root.join("directory/sub/keep.txt")).unwrap(),
            b"keep\n"
        );
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 1);
        assert_head_and_index(&root, &head, &index);
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]), "");
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn failed_copy_cleans_nested_readonly_temporary_directories() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let fixture = crate::test_support::git_fixture("repository-entry-readonly-cleanup");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::create_dir_all(root.join("source/a-readonly/nested")).unwrap();
        fs::write(root.join("source/a-readonly/nested/file.txt"), b"read only\n").unwrap();
        fs::write(root.join("source/a-readonly/root.txt"), b"root\n").unwrap();
        fs::write(root.join("existing.txt"), b"keep\n").unwrap();
        symlink("../existing.txt", root.join("source/z-link")).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let readonly = root.join("source/a-readonly/nested");
        fs::set_permissions(&readonly, fs::Permissions::from_mode(0o555)).unwrap();
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);

        // 名称排序保证 a-readonly 已复制并设为只读，然后才遇到 z-link 失败。
        let error = repository_copy_entry(&backend, path, "source", "destination", 1, 135)
            .await
            .unwrap_err();
        assert_eq!(error.code, "unsupported_entry");
        // 临时树已落盘（写锁内部分写入）：清理成功后代次仍推进，并随错误返回。
        assert_eq!(error.generation, Some(2));
        assert!(!root.join("destination").exists());
        assert_eq!(fs::read(root.join("existing.txt")).unwrap(), b"keep\n");
        assert_eq!(fs::read(readonly.join("file.txt")).unwrap(), b"read only\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 2);
        assert_no_entry_temporaries(&root);
        assert_head_and_index(&root, &head, &index);
        fs::set_permissions(&readonly, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn trash_error_after_removal_distinguishes_refresh_success_and_failure() {
        let fixture = crate::test_support::git_fixture("repository-entry-trash-refresh");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("first.txt"), b"first\n").unwrap();
        fs::write(root.join("second.txt"), b"second\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let quarantine = fixture.path().join("quarantine");
        fs::create_dir(&quarantine).unwrap();
        let path = root.to_str().unwrap();

        let first_root = root.clone();
        let first_quarantine = quarantine.clone();
        let refreshed = repository_delete_entry_with(
            &backend,
            path,
            "first.txt",
            1,
            136,
            move |_| {
                fs::rename(
                    first_root.join("first.txt"),
                    first_quarantine.join("first.txt"),
                )
                .unwrap();
                Err(AppError::new("trash_failed", "injected after removal"))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refreshed.generation, Some(2));
        assert!(refreshed.message.contains("已推进代次并刷新状态"));
        assert!(!refreshed.message.contains("刷新失败"));
        assert!(!root.join("first.txt").exists());
        assert_eq!(fs::read(quarantine.join("first.txt")).unwrap(), b"first\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 2);

        let second_root = root.clone();
        let second_quarantine = quarantine.clone();
        let detached_git = fixture.path().join("detached-git");
        let refresh_failed = repository_delete_entry_with(
            &backend,
            path,
            "second.txt",
            2,
            137,
            move |_| {
                fs::rename(
                    second_root.join("second.txt"),
                    second_quarantine.join("second.txt"),
                )
                .unwrap();
                fs::rename(second_root.join(".git"), detached_git).unwrap();
                Err(AppError::new("trash_failed", "injected refresh failure"))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refresh_failed.generation, Some(3));
        assert!(refresh_failed.message.contains("已推进代次"));
        assert!(refresh_failed.message.contains("状态刷新失败"));
        assert!(!refresh_failed.message.contains("并刷新状态"));
        assert!(!root.join("second.txt").exists());
        assert_eq!(fs::read(quarantine.join("second.txt")).unwrap(), b"second\n");
        assert_eq!(backend.scheduler.current_generation(&repo_key(&root)), 3);
    }

    #[cfg(target_os = "macos")]
    struct RestoreFromTrash {
        trashed: PathBuf,
        original: PathBuf,
    }
    #[cfg(target_os = "macos")]
    impl Drop for RestoreFromTrash {
        fn drop(&mut self) {
            if self.trashed.symlink_metadata().is_ok() {
                let _ = fs::rename(&self.trashed, &self.original);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn delete_file_and_nonempty_directory_use_the_real_macos_trash() {
        let fixture = crate::test_support::git_fixture("repository-entry-real-trash");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        let unique = format!(
            "twiglane-t2-{}-{}",
            std::process::id(),
            TEMP_ENTRY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let file_name = format!("{unique}.txt");
        let directory_name = format!("{unique}-directory");
        fs::write(root.join(&file_name), b"trash file\n").unwrap();
        fs::create_dir_all(root.join(&directory_name).join("sub")).unwrap();
        fs::write(
            root.join(&directory_name).join("sub/keep.txt"),
            b"trash directory\n",
        )
        .unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let path = root.to_str().unwrap();
        let head = git_stdout(&root, &["rev-parse", "HEAD"]);
        let index = git_stdout(&root, &["ls-files", "--stage"]);
        let trash = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");

        let original_file = root.join(&file_name);
        let trashed_file = trash.join(&file_name);
        assert!(!trashed_file.exists());
        let _restore_file = RestoreFromTrash {
            trashed: trashed_file.clone(),
            original: original_file.clone(),
        };
        let deleted_file = repository_delete_entry(&backend, path, &file_name, 1, 140)
            .await
            .unwrap();
        assert_eq!(deleted_file.generation, 2);
        assert!(!original_file.exists());
        assert!(trashed_file.is_file(), "真实文件必须进入 ~/.Trash");
        assert!(deleted_file.files.iter().any(|file| {
            file.path == file_name && file.unstaged == ChangeKind::Deleted
        }));

        let original_directory = root.join(&directory_name);
        let trashed_directory = trash.join(&directory_name);
        assert!(!trashed_directory.exists());
        let _restore_directory = RestoreFromTrash {
            trashed: trashed_directory.clone(),
            original: original_directory.clone(),
        };
        let deleted_directory = repository_delete_entry(
            &backend,
            path,
            &directory_name,
            deleted_file.generation,
            141,
        )
        .await
        .unwrap();
        assert_eq!(deleted_directory.generation, 3);
        assert!(!original_directory.exists());
        assert!(trashed_directory.join("sub/keep.txt").is_file());
        assert!(deleted_directory.files.iter().any(|file| {
            file.path == format!("{directory_name}/sub/keep.txt")
                && file.unstaged == ChangeKind::Deleted
        }));
        assert_head_and_index(&root, &head, &index);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_trash_binds_the_open_identity_after_path_replacement() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let fixture = crate::test_support::git_fixture("repository-entry-trash-identity-race");
        let root = fixture.repo("repo");
        let unique = format!(
            "twiglane-t2-race-{}-{}",
            std::process::id(),
            TEMP_ENTRY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let original_name = format!("{unique}-original.txt");
        let target = root.join(format!("{unique}.txt"));
        let outside = fixture.path().join("outside.txt");
        fs::write(&target, b"original content\n").unwrap();
        fs::write(&outside, b"outside secret\n").unwrap();

        // 打开并绑定目标身份（模拟 source 校验后持有的 fd）。
        let c = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
        // SAFETY: c 以 NUL 结尾；只在测试临时仓库打开普通文件。
        let fd = unsafe {
            libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        assert!(fd >= 0, "open failed: {}", std::io::Error::last_os_error());

        let trash = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        let trashed = trash.join(&original_name);
        let _restore = RestoreFromTrash {
            trashed: trashed.clone(),
            original: root.join(&original_name),
        };

        // 路径替换：原文件改名，目标位置换成指向 outside 的符号链接。
        fs::rename(&target, root.join(&original_name)).unwrap();
        symlink(&outside, &target).unwrap();

        // 通过 /dev/fd 绑定身份删除：必须删原 inode，绝不跟随替换后的链接。
        let result = super::macos_trash::trash_bound_to_fd_path(&PathBuf::from(format!(
            "/dev/fd/{fd}"
        )));
        // SAFETY: fd 由本次 open 独占。
        unsafe { libc::close(fd) };
        result.unwrap();

        assert_eq!(fs::read(&outside).unwrap(), b"outside secret\n");
        assert!(!root.join(&original_name).exists(), "原文件必须被回收站删除");
        assert_eq!(fs::read(&target).unwrap(), b"outside secret\n");
        assert_eq!(fs::read(&trashed).unwrap(), b"original content\n");
    }
}
