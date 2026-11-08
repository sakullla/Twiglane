//! Version-bound document reads. No document action writes files, the index, or Git objects.
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

use crate::error::AppError;
use crate::git::ops::{
    canonical_existing, repo_key, require_git, safe_relative, validate_input_path, Backend,
};
use crate::git::preview::{self, FilePreview};
use crate::git::runner::ProcessOutput;
use crate::git::schedule::{internal_request_id, GitJob, JobKind};
use crate::shutdown::Shutdown;

const DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const PAGE_BYTES: usize = 256 * 1024;
const LINE_BYTES: usize = 64 * 1024;
const INDEX_BYTES: usize = 64 * 1024 * 1024;
const IMAGE_BYTES: usize = 16 * 1024 * 1024;
static NETWORK_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static NETWORK_REQUESTS: OnceLock<Mutex<HashMap<u64, Arc<Shutdown>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSource {
    pub revision: String,
    pub path: String,
    /// Index-file digest, reused for every linked document and resource in this session.
    #[serde(default)]
    pub snapshot: Option<String>,
    /// Repository root this source was read from. Optional so sources built from a diff side
    /// (revision + path only) stay valid, but when present it is bound to the repository root
    /// passed to the read entry points: a source from another repository is rejected instead of
    /// silently reading a same-named file out of the newly opened repository.
    #[serde(default)]
    pub repository: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDocument {
    pub generation: u64,
    pub source: DocumentSource,
    pub kind: String,
    pub size: u64,
    pub version: Option<String>,
    pub text: Option<String>,
    pub complete: bool,
    pub offset: u64,
    pub lines: Vec<String>,
    pub next_offset: u64,
    pub has_more: bool,
    pub truncated: bool,
    pub message: Option<String>,
}

impl RepositoryDocument {
    fn empty(source: DocumentSource, generation: u64, offset: u64) -> Self {
        Self {
            generation,
            source,
            kind: "missing".into(),
            size: 0,
            version: None,
            text: None,
            complete: false,
            offset,
            lines: vec![],
            next_offset: offset,
            has_more: false,
            truncated: false,
            message: Some("该版本中没有这个文件。".into()),
        }
    }
}

pub fn is_markdown(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    [".md", ".markdown", ".mdown", ".rmd"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

fn document_path(path: &str) -> Result<PathBuf, AppError> {
    if path.contains(['\\', ':']) {
        return Err(AppError::new(
            "document_path",
            "文档路径必须是仓库相对路径。",
        ));
    }
    let relative = safe_relative(path)?;
    if path.split('/').any(|part| {
        part.trim_end_matches(['.', ' '])
            .eq_ignore_ascii_case(".git")
    }) {
        return Err(AppError::new("document_path", "文档不能读取 Git 元数据。"));
    }
    Ok(relative)
}

/// Git normalizes `./` out of both pathspecs and the paths it prints back, so identity
/// checks have to compare the same spelling. `document_path` deliberately accepts CurDir
/// components (relative links such as `./a.md` are legal), which are dropped here before a
/// path becomes a pathspec or is compared with `git ls-tree`/`git ls-files` output.
fn normalized_path(path: &str) -> Result<String, AppError> {
    let relative = document_path(path)?;
    let mut normalized = String::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => {
                if !normalized.is_empty() {
                    normalized.push('/');
                }
                normalized.push_str(&part.to_string_lossy());
            }
            std::path::Component::CurDir => {}
            _ => return Err(AppError::new("document_path", "文档路径必须是仓库相对路径。")),
        }
    }
    if normalized.is_empty() {
        return Err(AppError::new("document_path", "文档路径必须是仓库内的文件。"));
    }
    Ok(normalized)
}

/// Bind an optional source repository to the root this read is about to touch. A caller that
/// switched repositories cannot reuse the previous repository's source to relabel a same-named
/// file in the new one; the mismatch is reported instead of silently read.
fn bind_repository(source: &DocumentSource, root: &Path) -> Result<DocumentSource, AppError> {
    let canonical = root.to_string_lossy().into_owned();
    let Some(expected) = source.repository.as_deref() else {
        let mut bound = source.clone();
        bound.repository = Some(canonical);
        return Ok(bound);
    };
    let given = validate_input_path(expected)
        .and_then(|path| canonical_existing(&path))
        .map_err(|_| {
            AppError::new(
                "document_repository",
                "文档来源所在的仓库已无法访问，请重新打开文档。",
            )
        })?;
    if given != root {
        return Err(AppError::new(
            "document_repository",
            "该文档来源属于另一个仓库，未读取当前仓库中的同名文件。",
        ));
    }
    Ok(source.clone())
}

fn validate_source(source: &DocumentSource) -> Result<(), AppError> {
    document_path(&source.path)?;
    let revision = source.revision.as_str();
    if !matches!(revision, "worktree" | "index" | "HEAD")
        && !(matches!(revision.len(), 40 | 64)
            && revision.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(AppError::new("document_revision", "文档版本无效。"));
    }
    if source.snapshot.as_ref().is_some_and(|value| {
        value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(AppError::new("document_snapshot", "文档快照无效。"));
    }
    Ok(())
}

fn cancelled(cancel: &Shutdown) -> Result<(), AppError> {
    if cancel.is_cancelled() {
        Err(AppError::new("cancelled", "文档读取已取消。"))
    } else {
        Ok(())
    }
}

fn stale(generation: u64) -> AppError {
    AppError::new("stale", "文档或暂存区已变化，请重新读取。").with_generation(generation)
}

async fn git_read(
    backend: &Backend,
    root: &Path,
    git: &Path,
    args: &[&str],
    generation: u64,
    limit: usize,
) -> Result<ProcessOutput, AppError> {
    let mut argv: Vec<OsString> = vec![
        "--literal-pathspecs".into(),
        "-C".into(),
        root.as_os_str().to_owned(),
    ];
    argv.extend(args.iter().map(OsString::from));
    Ok(backend
        .scheduler
        .execute(GitJob {
            repo_key: repo_key(root),
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation,
            program: git.to_owned(),
            args: argv,
            stdin: None,
            truncate_stdout: true,
            output_limit: Some(limit),
            env: vec![],
        })
        .await?
        .output)
}

async fn index_snapshot(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
) -> Result<String, AppError> {
    let output = git_read(
        backend,
        root,
        git,
        &["rev-parse", "--git-path", "index"],
        generation,
        16 * 1024,
    )
    .await?;
    if output.exit_code != 0 || output.stdout_truncated {
        return Err(AppError::new("document_snapshot", "无法确定暂存区快照。"));
    }
    let value = std::str::from_utf8(&output.stdout)
        .map_err(|_| AppError::new("document_snapshot", "暂存区路径无效。"))?
        .trim_end_matches(['\r', '\n']);
    let path = root.join(value);
    backend
        .scheduler
        .execute_blocking_read(
            &repo_key(root),
            internal_request_id(),
            generation,
            move |cancel| {
                let mut hash = Sha256::new();
                let mut file = match fs::File::open(path) {
                    Ok(file) => file,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(format!("{:x}", hash.finalize()))
                    }
                    Err(_) => {
                        return Err(AppError::new("document_snapshot", "无法读取暂存区快照。"))
                    }
                };
                let mut buffer = [0; 64 * 1024];
                let mut total = 0;
                loop {
                    cancelled(&cancel)?;
                    let count = file
                        .read(&mut buffer)
                        .map_err(|_| AppError::new("document_snapshot", "无法读取暂存区快照。"))?;
                    if count == 0 {
                        break;
                    }
                    total += count;
                    if total > INDEX_BYTES {
                        return Err(AppError::new(
                            "document_snapshot",
                            "暂存区过大，无法确认文档快照。",
                        ));
                    }
                    hash.update(&buffer[..count]);
                }
                Ok(format!("{:x}", hash.finalize()))
            },
        )
        .await
}

async fn bind_source(
    backend: &Backend,
    root: &Path,
    git: &Path,
    source: &DocumentSource,
    generation: u64,
) -> Result<DocumentSource, AppError> {
    let mut source = source.clone();
    if source.revision == "index" {
        let snapshot = index_snapshot(backend, root, git, generation).await?;
        if source
            .snapshot
            .as_ref()
            .is_some_and(|expected| expected != &snapshot)
        {
            return Err(stale(generation));
        }
        source.snapshot = Some(snapshot);
    } else if source.revision != "worktree" {
        let target = format!("{}^{{commit}}", source.revision);
        let output = git_read(
            backend,
            root,
            git,
            &["rev-parse", "--verify", &target],
            generation,
            1024,
        )
        .await?;
        if output.exit_code != 0 {
            return Err(AppError::new(
                "document_revision",
                "该提交已不存在或尚无提交。",
            ));
        }
        let revision = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !matches!(revision.len(), 40 | 64) || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::new("document_revision", "无法确定文档提交。"));
        }
        source.revision = revision;
        source.snapshot = None;
    } else {
        source.snapshot = None;
    }
    Ok(source)
}

async fn verify_snapshot(
    backend: &Backend,
    root: &Path,
    git: &Path,
    source: &DocumentSource,
    generation: u64,
) -> Result<(), AppError> {
    if source.revision == "index"
        && source.snapshot.as_ref() != Some(&index_snapshot(backend, root, git, generation).await?)
    {
        return Err(stale(generation));
    }
    Ok(())
}

struct Loaded {
    bytes: Vec<u8>,
    size: u64,
    version: String,
    limited: bool,
    special: bool,
}

fn metadata_version(meta: &fs::Metadata) -> String {
    super::files::file_version(meta)
        .unwrap_or_else(|| format!("{}:{:?}", meta.len(), meta.modified().ok()))
}

fn checked_worktree_path(root: &Path, relative: &Path) -> Result<Option<PathBuf>, AppError> {
    let mut candidate = root.to_owned();
    for component in relative.components() {
        candidate.push(component);
        match candidate.symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(AppError::new("document_path", "文档不跟随符号链接。"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(AppError::new("document_read", "文档路径无法读取。")),
        }
    }
    let resolved = canonical_existing(&candidate)?;
    if !resolved.starts_with(root) {
        return Err(AppError::new("document_path", "文档必须位于当前仓库内。"));
    }
    Ok(Some(resolved))
}

async fn load(
    backend: &Backend,
    root: &Path,
    git: &Path,
    source: &DocumentSource,
    generation: u64,
    budget: usize,
) -> Result<Option<Loaded>, AppError> {
    if source.revision == "worktree" {
        let relative = document_path(&source.path)?;
        let root = root.to_owned();
        return backend
            .scheduler
            .execute_blocking_read(
                &repo_key(&root),
                internal_request_id(),
                generation,
                move |cancel| {
                    let Some(path) = checked_worktree_path(&root, &relative)? else {
                        return Ok(None);
                    };
                    let before = fs::metadata(&path)
                        .map_err(|_| AppError::new("document_read", "无法读取文档。"))?;
                    if !before.is_file() {
                        return Ok(Some(Loaded {
                            bytes: vec![],
                            size: before.len(),
                            version: metadata_version(&before),
                            limited: false,
                            special: true,
                        }));
                    }
                    let mut file = fs::File::open(&path)
                        .map_err(|_| AppError::new("document_read", "无法打开文档。"))?;
                    let opened = file
                        .metadata()
                        .map_err(|_| AppError::new("document_read", "无法读取文档状态。"))?;
                    if !opened.is_file() || metadata_version(&opened) != metadata_version(&before) {
                        return Err(stale(generation));
                    }
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 64 * 1024];
                    while bytes.len() <= budget {
                        cancelled(&cancel)?;
                        let wanted = buffer.len().min(budget + 1 - bytes.len());
                        let count = file
                            .read(&mut buffer[..wanted])
                            .map_err(|_| AppError::new("document_read", "无法读取文档。"))?;
                        if count == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                    }
                    let after_path = checked_worktree_path(&root, &relative)?
                        .ok_or_else(|| stale(generation))?;
                    let after = fs::metadata(after_path).map_err(|_| stale(generation))?;
                    if metadata_version(&before) != metadata_version(&after)
                        || file.metadata().is_err()
                    {
                        return Err(stale(generation));
                    }
                    let limited = bytes.len() > budget;
                    bytes.truncate(budget);
                    let version = metadata_version(&after);
                    Ok(Some(Loaded {
                        bytes,
                        size: after.len(),
                        version,
                        limited,
                        special: false,
                    }))
                },
            )
            .await;
    }
    let Some((oid, size)) = blob_identity(backend, root, git, source, generation).await? else {
        return Ok(None);
    };
    let output = git_read(
        backend,
        root,
        git,
        &["cat-file", "blob", &oid],
        generation,
        budget + 1,
    )
    .await?;
    if output.exit_code != 0 && !output.stdout_truncated {
        return Err(AppError::new("document_read", "无法读取版本正文。"));
    }
    let mut bytes = output.stdout;
    let limited = size > budget as u64 || output.stdout_truncated || bytes.len() > budget;
    bytes.truncate(budget);
    Ok(Some(Loaded {
        bytes,
        size,
        version: oid,
        limited,
        special: false,
    }))
}

async fn blob_identity(
    backend: &Backend,
    root: &Path,
    git: &Path,
    source: &DocumentSource,
    generation: u64,
) -> Result<Option<(String, u64)>, AppError> {
    let path = normalized_path(&source.path)?;
    let output = if source.revision == "index" {
        git_read(
            backend,
            root,
            git,
            &["ls-files", "--stage", "-z", "--", &path],
            generation,
            64 * 1024,
        )
        .await?
    } else {
        git_read(
            backend,
            root,
            git,
            &["ls-tree", "-z", &source.revision, "--", &path],
            generation,
            64 * 1024,
        )
        .await?
    };
    if output.exit_code != 0 || output.stdout_truncated {
        return Err(AppError::new("document_read", "无法读取版本中的文件身份。"));
    }
    let record = output
        .stdout
        .split(|b| *b == 0)
        .find(|entry| {
            entry
                .split_once_byte(b'\t')
                .is_some_and(|(_, found)| found == path.as_bytes())
        });
    let Some(record) = record else {
        return Ok(None);
    };
    let (header, _) = record.split_once_byte(b'\t').expect("record has tab");
    let fields: Vec<_> = header.split(|b| *b == b' ').collect();
    let regular = fields
        .first()
        .is_some_and(|mode| *mode == b"100644" || *mode == b"100755");
    if !regular {
        return Err(AppError::new(
            "document_path",
            "该版本中的目标不是普通文件，不跟随符号链接。",
        ));
    }
    let oid = if source.revision == "index" {
        if fields.get(2) != Some(&b"0".as_slice()) {
            return Err(AppError::new(
                "document_conflict",
                "暂存区文档仍有未解决冲突。",
            ));
        }
        fields.get(1)
    } else {
        fields.get(2)
    }
    .ok_or_else(|| AppError::new("document_read", "文件身份无效。"))?;
    let oid =
        std::str::from_utf8(oid).map_err(|_| AppError::new("document_read", "文件身份无效。"))?;
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new("document_read", "文件身份无效。"));
    }
    let size = git_read(
        backend,
        root,
        git,
        &["cat-file", "-s", oid],
        generation,
        1024,
    )
    .await?;
    let size: u64 = std::str::from_utf8(&size.stdout)
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .ok_or_else(|| AppError::new("document_read", "无法读取文件大小。"))?;
    Ok(Some((oid.into(), size)))
}

trait SplitByte {
    fn split_once_byte(&self, byte: u8) -> Option<(&[u8], &[u8])>;
}
impl SplitByte for [u8] {
    fn split_once_byte(&self, byte: u8) -> Option<(&[u8], &[u8])> {
        self.iter()
            .position(|b| *b == byte)
            .map(|at| (&self[..at], &self[at + 1..]))
    }
}

/// Scan one complete line without ever retaining an unbounded line allocation.
async fn stream_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    budget: usize,
) -> Result<Option<(Vec<u8>, bool, bool)>, AppError> {
    let mut bytes = Vec::new();
    let mut any = false;
    let mut truncated = false;
    let mut binary = false;
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|_| AppError::new("document_read", "无法读取源码。"))?;
        if buffer.is_empty() {
            return Ok(any.then_some((bytes, truncated, binary)));
        }
        any = true;
        let count = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |at| at + 1);
        let end = buffer[count - 1] == b'\n';
        binary |= buffer[..count].contains(&0);
        let keep = count.min(budget.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
        reader.consume(count);
        if end {
            return Ok(Some((bytes, truncated, binary)));
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn source_page(
    backend: &Backend,
    root: &Path,
    git: &Path,
    source: DocumentSource,
    generation: u64,
    offset: u64,
    limit: Option<usize>,
    expected: Option<&str>,
) -> Result<RepositoryDocument, AppError> {
    let mut result = RepositoryDocument::empty(source.clone(), generation, offset);
    let limit = limit.unwrap_or(500).clamp(1, 1000);
    if source.revision == "worktree" {
        let relative = document_path(&source.path)?;
        let root_copy = root.to_owned();
        let expected = expected.map(str::to_owned);
        let page = backend
            .scheduler
            .execute_blocking_read(
                &repo_key(root),
                internal_request_id(),
                generation,
                move |cancel| {
                    let Some(path) = checked_worktree_path(&root_copy, &relative)? else {
                        return Ok(None);
                    };
                    let before = fs::metadata(&path)
                        .map_err(|_| AppError::new("document_read", "无法读取源码状态。"))?;
                    let version = metadata_version(&before);
                    if expected
                        .as_ref()
                        .is_some_and(|expected| expected != &version)
                    {
                        return Err(stale(generation));
                    }
                    let page = super::files::read_text_page(
                        root_copy.clone(),
                        relative.clone(),
                        offset,
                        limit,
                        cancel,
                    )?;
                    let after_path = checked_worktree_path(&root_copy, &relative)?
                        .ok_or_else(|| stale(generation))?;
                    let after = fs::metadata(after_path).map_err(|_| stale(generation))?;
                    if version != metadata_version(&after) {
                        return Err(stale(generation));
                    }
                    Ok(Some(page))
                },
            )
            .await?;
        if let Some(page) = page {
            result.kind = serde_json::to_value(page.kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "special".into());
            result.size = page.size;
            result.version = page.version;
            result.lines = page.lines;
            result.next_offset = page.next_offset;
            result.has_more = page.has_more;
            result.truncated = page.truncated;
            result.complete =
                offset == 0 && !page.has_more && !page.truncated && result.kind == "text";
            result.message = page.message;
        }
        return Ok(result);
    }
    let Some((oid, size)) = blob_identity(backend, root, git, &source, generation).await? else {
        verify_snapshot(backend, root, git, &source, generation).await?;
        return Ok(result);
    };
    if expected.is_some_and(|expected| expected != oid) {
        return Err(stale(generation));
    }
    result.version = Some(oid.clone());
    result.size = size;
    let mut result = backend
        .scheduler
        .execute_streaming_read(
            &repo_key(root),
            internal_request_id(),
            generation,
            |_| async {
                let mut command = tokio::process::Command::new(git);
                #[cfg(windows)]
                command.creation_flags(0x0800_0000);
                command
                    .args([
                        OsString::from("-C"),
                        root.as_os_str().to_owned(),
                        "cat-file".into(),
                        "blob".into(),
                        oid.into(),
                    ])
                    .envs(backend.runner.extra_env.iter().cloned())
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                let mut child = command
                    .spawn()
                    .map_err(|_| AppError::new("document_read", "无法读取版本源码。"))?;
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| AppError::new("document_read", "无法读取源码输出。"))?;
                let mut reader = BufReader::new(stdout);
                let mut skipped = 0;
                while skipped < offset {
                    let Some((_, _, binary)) = stream_line(&mut reader, 0).await? else {
                        break;
                    };
                    if binary {
                        result.kind = "binary".into();
                        result.message = Some("二进制文件不能作为源码读取。".into());
                        break;
                    }
                    skipped += 1;
                }
                let mut used = 0;
                let mut dropped = false;
                if result.kind != "binary" {
                    result.kind = "text".into();
                    result.message = None;
                    while result.lines.len() < limit {
                        let Some((mut line, truncated, binary)) =
                            stream_line(&mut reader, LINE_BYTES).await?
                        else {
                            break;
                        };
                        if binary {
                            result.kind = "binary".into();
                            result.lines.clear();
                            result.message = Some("二进制文件不能作为源码读取。".into());
                            break;
                        }
                        if !truncated {
                            if line.last() == Some(&b'\n') {
                                line.pop();
                            }
                            if line.last() == Some(&b'\r') {
                                line.pop();
                            }
                        }
                        let end = match std::str::from_utf8(&line) {
                            Ok(_) => line.len(),
                            Err(error) if truncated && error.error_len().is_none() => {
                                error.valid_up_to()
                            }
                            Err(_) => {
                                result.kind = "invalidUtf8".into();
                                result.lines.clear();
                                result.message = Some("文件不是有效 UTF-8 文本。".into());
                                break;
                            }
                        };
                        if !result.lines.is_empty() && used + end > PAGE_BYTES {
                            dropped = true;
                            break;
                        }
                        used += end;
                        result.truncated |= truncated;
                        result.lines.push(
                            std::str::from_utf8(&line[..end])
                                .expect("validated UTF-8")
                                .into(),
                        );
                    }
                }
                let has_more = dropped
                    || !reader
                        .fill_buf()
                        .await
                        .map_err(|_| AppError::new("document_read", "无法继续读取源码。"))?
                        .is_empty();
                if has_more {
                    let _ = child.kill().await;
                } else {
                    let status = child
                        .wait()
                        .await
                        .map_err(|_| AppError::new("document_read", "源码读取中断。"))?;
                    if !status.success() {
                        return Err(AppError::new("document_read", "无法读取版本源码。"));
                    }
                }
                if result.kind == "text" {
                    result.next_offset = offset + result.lines.len() as u64;
                    result.has_more = has_more;
                    result.complete = offset == 0 && !has_more && !result.truncated;
                    if result.truncated {
                        result.message = Some("部分超长行已截断。".into());
                    }
                }
                Ok(result)
            },
        )
        .await?;
    verify_snapshot(backend, root, git, &source, generation).await?;
    // Resource formats still route to the existing resource reader instead of binary-looking source.
    if preview::wants_preview(&source.path, &[])
        && !source.path.to_ascii_lowercase().ends_with(".svg")
    {
        result.kind = "resource".into();
        result.lines.clear();
        result.has_more = false;
        result.complete = false;
        result.message = Some("此文件使用只读资源预览。".into());
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub async fn repository_document(
    backend: &Backend,
    path: &str,
    source: &DocumentSource,
    generation: u64,
    request_id: u64,
    mode: &str,
    offset: u64,
    limit: Option<usize>,
    expected_version: Option<&str>,
) -> Result<RepositoryDocument, AppError> {
    validate_source(source)?;
    if !matches!(mode, "document" | "source") {
        return Err(AppError::new("document_mode", "文档读取模式无效。"));
    }
    let root = canonical_existing(&validate_input_path(path)?)?;
    let source = bind_repository(source, &root)?;
    backend
        .scheduler
        .read_session(
            &repo_key(&root),
            request_id,
            generation,
            |cancel| async move {
                cancelled(&cancel)?;
                let git = require_git(backend).await?;
                let bound = bind_source(backend, &root, &git.path, &source, generation).await?;
                if mode == "source" {
                    return source_page(
                        backend,
                        &root,
                        &git.path,
                        bound,
                        generation,
                        offset,
                        limit,
                        expected_version,
                    )
                    .await;
                }
                let budget = DOCUMENT_BYTES;
                let loaded = load(backend, &root, &git.path, &bound, generation, budget).await?;
                verify_snapshot(backend, &root, &git.path, &bound, generation).await?;
                let mut result = RepositoryDocument::empty(bound, generation, offset);
                let Some(loaded) = loaded else {
                    return Ok(result);
                };
                result.size = loaded.size;
                result.version = Some(loaded.version.clone());
                if expected_version.is_some_and(|version| version != loaded.version) {
                    return Err(stale(generation));
                }
                if loaded.special {
                    result.kind = "special".into();
                    result.message = Some("仅支持普通文件。".into());
                    return Ok(result);
                }
                if preview::wants_preview(&source.path, &loaded.bytes) {
                    result.kind = "resource".into();
                    result.message = Some("此文件使用只读资源预览。".into());
                    return Ok(result);
                }
                if loaded.bytes.contains(&0) {
                    result.kind = "binary".into();
                    result.message = Some("二进制文件不能作为 Markdown 阅读。".into());
                    return Ok(result);
                }
                if mode == "document" && loaded.limited {
                    result.kind = "tooLarge".into();
                    result.truncated = true;
                    result.message = Some("文档超过 2 MiB 排版预览上限，请查看源码。".into());
                    return Ok(result);
                }
                let valid = match std::str::from_utf8(&loaded.bytes) {
                    Ok(text) => text,
                    Err(error) if loaded.limited && error.error_len().is_none() => {
                        std::str::from_utf8(&loaded.bytes[..error.valid_up_to()])
                            .expect("valid prefix")
                    }
                    Err(_) => {
                        result.kind = "invalidUtf8".into();
                        result.message = Some("文件不是有效 UTF-8 文本。".into());
                        return Ok(result);
                    }
                };
                result.kind = "text".into();
                result.message = None;
                result.truncated = loaded.limited;
                result.complete = true;
                result.text = Some(valid.into());
                Ok(result)
            },
        )
        .await
}

pub async fn document_resource(
    backend: &Backend,
    path: &str,
    source: &DocumentSource,
    generation: u64,
    request_id: u64,
) -> Result<FilePreview, AppError> {
    validate_source(source)?;
    let root = canonical_existing(&validate_input_path(path)?)?;
    let source = bind_repository(source, &root)?;
    backend
        .scheduler
        .read_session(&repo_key(&root), request_id, generation, |_| async {
            let git = require_git(backend).await?;
            let bound = bind_source(backend, &root, &git.path, &source, generation).await?;
            let loaded = load(backend, &root, &git.path, &bound, generation, IMAGE_BYTES).await?;
            verify_snapshot(backend, &root, &git.path, &bound, generation).await?;
            let Some(loaded) = loaded else {
                return Ok(FilePreview::message(
                    "missing",
                    "该版本中没有这个资源。",
                    generation,
                ));
            };
            if loaded.special {
                return Ok(FilePreview::message(
                    "unsupported",
                    "资源不是普通文件。",
                    generation,
                ));
            }
            if loaded.limited {
                return Ok(FilePreview::message(
                    "unsupported",
                    "资源超过 16 MiB 预览上限。",
                    generation,
                ));
            }
            if loaded
                .bytes
                .starts_with(b"version https://git-lfs.github.com/spec/v1")
            {
                return Ok(FilePreview::message(
                    "lfs",
                    "这是 LFS 指针；阅读文档不会自动下载资源。",
                    generation,
                ));
            }
            let name = bound.path;
            tokio::task::spawn_blocking(move || preview::decode(&name, &loaded.bytes, generation))
                .await
                .map_err(|_| AppError::new("document_resource", "资源解析已中断。"))
        })
        .await
}

pub fn validate_web_url(value: &str) -> Result<reqwest::Url, AppError> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err(AppError::new("document_url", "网页地址无效。"));
    }
    let url =
        reqwest::Url::parse(value).map_err(|_| AppError::new("document_url", "网页地址无效。"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::new(
            "document_url",
            "只允许不含凭据的 HTTP(S) 网页地址。",
        ));
    }
    Ok(url)
}

struct NetworkGuard(u64);
impl Drop for NetworkGuard {
    fn drop(&mut self) {
        NETWORK_REQUESTS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

pub fn cancel_document_resources(request_id: u64) {
    if let Some(token) = NETWORK_REQUESTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&request_id)
    {
        token.cancel();
    }
}

async fn fetch_image(url: reqwest::Url) -> Result<FilePreview, AppError> {
    // Match the updater's existing ring provider without pulling another TLS backend.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .map_err(|_| AppError::new("document_network", "无法初始化图片请求。"))?;
    let mut url = url;
    for redirects in 0..=5 {
        let mut response = client
            .get(url.clone())
            .header(
                reqwest::header::ACCEPT,
                "image/png,image/jpeg,image/gif,image/webp,image/bmp,image/x-icon",
            )
            .send()
            .await
            .map_err(|_| AppError::new("document_network", "图片加载失败，请检查网络或重试。"))?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err(AppError::new("document_network", "图片重定向次数过多。"));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::new("document_network", "图片重定向地址无效。"))?;
            url = validate_web_url(
                url.join(location)
                    .map_err(|_| AppError::new("document_url", "图片地址无效。"))?
                    .as_str(),
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::new(
                "document_network",
                format!("图片请求失败（HTTP {}）。", response.status().as_u16()),
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > IMAGE_BYTES as u64)
        {
            return Err(AppError::new(
                "document_image_limit",
                "图片超过 16 MiB 预览上限。",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AppError::new("document_network", "图片读取失败。"))?
        {
            if bytes.len().saturating_add(chunk.len()) > IMAGE_BYTES {
                return Err(AppError::new(
                    "document_image_limit",
                    "图片超过 16 MiB 预览上限。",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        // Empty name deliberately disables SVG/archives: remote content only accepts decoded raster images.
        let image = tokio::task::spawn_blocking(move || preview::decode("", &bytes, 0))
            .await
            .map_err(|_| AppError::new("document_image", "图片解析失败。"))?;
        if image.kind != "image" {
            return Err(AppError::new(
                "document_image",
                "响应不是受支持的栅格图片，或图片超过尺寸上限。",
            ));
        }
        return Ok(image);
    }
    unreachable!("redirect loop always returns")
}

pub async fn document_remote_image(
    backend: &Backend,
    url: &str,
    request_id: u64,
) -> Result<FilePreview, AppError> {
    remote_image_with_timeout(backend, url, request_id, Duration::from_secs(20)).await
}

async fn remote_image_with_timeout(
    backend: &Backend,
    url: &str,
    request_id: u64,
    timeout: Duration,
) -> Result<FilePreview, AppError> {
    let url = validate_web_url(url)?;
    let cancel = Arc::new(Shutdown::new());
    {
        let mut requests = NETWORK_REQUESTS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if requests.contains_key(&request_id) {
            return Err(AppError::new("duplicate_request", "图片请求正在执行。"));
        }
        requests.insert(request_id, cancel.clone());
    }
    let _guard = NetworkGuard(request_id);
    tokio::select! {
        biased;
        _ = backend.shutdown.cancelled() => Err(AppError::new("cancelled", "图片读取已关闭。")),
        _ = cancel.cancelled() => Err(AppError::new("cancelled", "图片读取已取消。")),
        result = async {
            let _slot = NETWORK_SLOTS.acquire().await.map_err(|_| AppError::new("cancelled", "图片读取已关闭。"))?;
            tokio::time::timeout(timeout, fetch_image(url)).await.map_err(|_| AppError::new("document_network", "图片加载超时，请重试。"))?
        } => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().into()
    }
    fn source(revision: &str, path: &str) -> DocumentSource {
        DocumentSource {
            revision: revision.into(),
            path: path.into(),
            snapshot: None,
            repository: None,
        }
    }
    /// Diff 侧只带 `revision`+`path`；快照由第一次 index 读取返回并复用。
    fn document_source(source: &crate::git::preview::PreviewSource) -> DocumentSource {
        DocumentSource {
            revision: source.revision.clone(),
            path: source.path.clone(),
            snapshot: None,
            repository: None,
        }
    }
    async fn read(backend: &Backend, root: &Path, source: &DocumentSource) -> RepositoryDocument {
        read_request(backend, root, source, 1101).await
    }
    /// 并行测试共用 1101 会撞上请求去重；需要独立请求的用例自带 request id。
    async fn read_request(
        backend: &Backend,
        root: &Path,
        source: &DocumentSource,
        request_id: u64,
    ) -> RepositoryDocument {
        repository_document(
            backend,
            root.to_str().unwrap(),
            source,
            1,
            request_id,
            "document",
            0,
            None,
            None,
        )
        .await
        .unwrap()
    }
    fn png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=").unwrap()
    }

    #[tokio::test]
    async fn document_versions_preserve_original_text_and_pin_head() {
        let fixture = crate::test_support::git_fixture("document-versions");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        fs::write(root.join("README.md"), "# 历史\r\n\r\n原文\r\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "old"]);
        let oid = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join("README.md"), "# 暂存\n").unwrap();
        git(&root, &["add", "."]);
        fs::write(root.join("README.md"), "# 工作区\n").unwrap();
        let old = read(&backend, &root, &source("HEAD", "README.md")).await;
        let index = read(&backend, &root, &source("index", "README.md")).await;
        let worktree = read(&backend, &root, &source("worktree", "README.md")).await;
        assert_eq!(old.text.as_deref(), Some("# 历史\r\n\r\n原文\r\n"));
        assert_eq!(old.source.revision, oid);
        assert_eq!(index.text.as_deref(), Some("# 暂存\n"));
        assert!(index.source.snapshot.is_some());
        assert_eq!(worktree.text.as_deref(), Some("# 工作区\n"));
        let status = git(&root, &["status", "--porcelain"]);
        let again = read(&backend, &root, &old.source).await;
        assert_eq!(again.text, old.text);
        assert_eq!(git(&root, &["status", "--porcelain"]), status);
        git(&root, &["commit", "-m", "next"]);
        assert_eq!(read(&backend, &root, &old.source).await.text, old.text);
    }

    #[tokio::test]
    async fn document_curdir_spelling_reads_the_same_version_on_all_three_sides() {
        let fixture = crate::test_support::git_fixture("document-curdir");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/a.md"), "# 历史\n").unwrap();
        fs::write(root.join("docs/图.svg"), "<svg>old</svg>").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "old"]);
        let oid = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join("docs/a.md"), "# 暂存\n").unwrap();
        git(&root, &["add", "."]);
        fs::write(root.join("docs/a.md"), "# 工作区\n").unwrap();
        // `document_path`/`safe_relative` 允许 CurDir 组件，Git 却把 pathspec 与输出路径都
        // 归一化掉 `./`；身份比较必须归一化，否则真实存在的正文会被报成 missing。
        for (revision, expected, plain_id, dotted_id) in [
            ("worktree", "# 工作区\n", 1310, 1311),
            ("index", "# 暂存\n", 1312, 1313),
            (oid.as_str(), "# 历史\n", 1314, 1315),
        ] {
            let plain = read_request(&backend, &root, &source(revision, "docs/a.md"), plain_id).await;
            let dotted =
                read_request(&backend, &root, &source(revision, "docs/./a.md"), dotted_id).await;
            assert_eq!(plain.kind, "text", "{revision}");
            assert_eq!(
                dotted.kind, "text",
                "{revision}: `./` 拼写必须命中版本中的同一文件"
            );
            assert_eq!(dotted.text.as_deref(), Some(expected), "{revision}");
            assert_eq!(plain.text, dotted.text, "{revision}");
            if revision != "worktree" {
                assert_eq!(plain.version, dotted.version, "{revision}");
            }
        }
        // 资源读取走同一条身份比较：`./` 资源不能退化成 missing。
        let plain = document_resource(
            &backend,
            root.to_str().unwrap(),
            &source(oid.as_str(), "docs/图.svg"),
            1,
            1301,
        )
        .await
        .unwrap();
        let dotted = document_resource(
            &backend,
            root.to_str().unwrap(),
            &source(oid.as_str(), "docs/./图.svg"),
            1,
            1302,
        )
        .await
        .unwrap();
        assert_eq!(plain.kind, "image");
        assert_eq!(dotted.kind, "image");
        assert_eq!(plain.data_url, dotted.data_url);
    }

    #[tokio::test]
    async fn document_source_from_another_repository_is_rejected() {
        let fixture = crate::test_support::git_fixture("document-cross-repository");
        let first = fixture.repo("first");
        let second = fixture.repo("second");
        let backend = fixture.backend();
        for root in [&first, &second] {
            git(root, &["init"]);
            fs::write(root.join("a.md"), "# 各自仓库\n").unwrap();
            git(root, &["add", "."]);
            git(root, &["commit", "-m", "doc"]);
        }
        let doc = read_request(&backend, &first, &source("HEAD", "a.md"), 1330).await;
        let first_root = canonical_existing(&first)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(doc.source.repository.as_deref(), Some(first_root.as_str()));
        // 切仓后旧来源 + 新仓库根：必须报真实错误，不能把新仓库同名文件按旧来源标注版本。
        let error = repository_document(
            &backend,
            second.to_str().unwrap(),
            &doc.source,
            1,
            1303,
            "document",
            0,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "document_repository");
        assert!(error.generation.is_none());
        assert_eq!(
            document_resource(&backend, second.to_str().unwrap(), &doc.source, 1, 1304)
                .await
                .unwrap_err()
                .code,
            "document_repository"
        );
        let mut reversed = doc.source.clone();
        reversed.repository = Some(
            canonical_existing(&second)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(
            repository_document(
                &backend,
                first.to_str().unwrap(),
                &reversed,
                1,
                1305,
                "document",
                0,
                None,
                None
            )
            .await
            .unwrap_err()
            .code,
            "document_repository"
        );
        // 同仓库继续读取（含分页）不受影响，返回的来源仍绑定该仓库。
        let again = repository_document(
            &backend,
            first.to_str().unwrap(),
            &doc.source,
            1,
            1306,
            "source",
            0,
            Some(1),
            doc.version.as_deref(),
        )
        .await
        .unwrap();
        assert_eq!(again.source.repository, doc.source.repository);
        assert_eq!(again.lines, ["# 各自仓库"]);
        // 来源仓库已不存在时同样是真实错误码，而不是悄悄读当前仓库。
        let mut gone = doc.source.clone();
        gone.repository = Some(first.join("missing").to_string_lossy().into_owned());
        assert_eq!(
            repository_document(
                &backend,
                first.to_str().unwrap(),
                &gone,
                1,
                1307,
                "document",
                0,
                None,
                None
            )
            .await
            .unwrap_err()
            .code,
            "document_repository"
        );
        // Diff 侧来源（没有 repository 字段）保持向后兼容：由入口绑定当前仓库。
        let legacy = source("HEAD", "a.md");
        assert_eq!(legacy.repository, None);
        let legacy = read_request(&backend, &second, &legacy, 1331).await;
        assert_eq!(legacy.text.as_deref(), Some("# 各自仓库\n"));
        assert!(legacy.source.repository.is_some());
    }

    #[tokio::test]
    async fn document_index_snapshot_rejects_changed_related_resource() {
        let fixture = crate::test_support::git_fixture("document-snapshot");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        fs::write(root.join("README.md"), "![图](a.svg)").unwrap();
        fs::write(root.join("a.svg"), "<svg>old</svg>").unwrap();
        git(&root, &["add", "."]);
        let doc = read(&backend, &root, &source("index", "README.md")).await;
        let mut image = doc.source.clone();
        image.path = "a.svg".into();
        let first = document_resource(&backend, root.to_str().unwrap(), &image, 1, 1102)
            .await
            .unwrap();
        assert_eq!(first.kind, "image");
        fs::write(root.join("a.svg"), "<svg>new</svg>").unwrap();
        git(&root, &["add", "a.svg"]);
        let error = document_resource(&backend, root.to_str().unwrap(), &image, 1, 1103)
            .await
            .unwrap_err();
        assert_eq!(error.code, "stale");
        assert_eq!(
            repository_document(
                &backend,
                root.to_str().unwrap(),
                &doc.source,
                1,
                1104,
                "source",
                0,
                None,
                doc.version.as_deref()
            )
            .await
            .unwrap_err()
            .code,
            "stale"
        );
    }

    #[tokio::test]
    async fn document_historical_resources_never_fall_back_to_worktree() {
        let fixture = crate::test_support::git_fixture("document-resource");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        fs::write(root.join("a.svg"), "<svg>old</svg>").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "old"]);
        let oid = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join("a.svg"), "<svg>index</svg>").unwrap();
        git(&root, &["add", "."]);
        fs::write(root.join("a.svg"), "<svg>worktree</svg>").unwrap();
        let mut urls = vec![];
        for revision in [&oid, "index", "worktree"] {
            urls.push(
                document_resource(
                    &backend,
                    root.to_str().unwrap(),
                    &source(revision, "a.svg"),
                    1,
                    1105,
                )
                .await
                .unwrap()
                .data_url
                .unwrap(),
            );
        }
        assert_ne!(urls[0], urls[1]);
        assert_ne!(urls[1], urls[2]);
        fs::write(root.join("new.svg"), "<svg>new file</svg>").unwrap();
        assert_eq!(
            document_resource(
                &backend,
                root.to_str().unwrap(),
                &source(&oid, "new.svg"),
                1,
                1106
            )
            .await
            .unwrap()
            .kind,
            "missing"
        );
        fs::remove_file(root.join("a.svg")).unwrap();
        assert_eq!(
            document_resource(
                &backend,
                root.to_str().unwrap(),
                &source(&oid, "a.svg"),
                1,
                1107
            )
            .await
            .unwrap()
            .data_url
            .as_ref(),
            Some(&urls[0])
        );
    }

    #[test]
    fn document_markdown_detection_covers_only_markdown_extensions() {
        for path in ["README.md", "docs/Guide.MARKDOWN", "notes.mdown", "x.rmd"] {
            assert!(is_markdown(path), "{path}");
        }
        // 文档图标类别（docx/pdf/txt…）不等于 Markdown，不能一律按 Markdown 解释。
        for path in ["notes.txt", "docs/readme", "a.mdx", "image.md.png", "doc.docx"] {
            assert!(!is_markdown(path), "{path}");
        }
    }

    #[tokio::test]
    async fn document_limits_types_pages_and_expected_version_are_truthful() {
        let fixture = crate::test_support::git_fixture("document-limits");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        for (name, bytes, kind) in [
            ("empty.md", &b""[..], "text"),
            ("bad.md", &b"\xff"[..], "invalidUtf8"),
            ("binary.md", &b"a\0b"[..], "binary"),
        ] {
            fs::write(root.join(name), bytes).unwrap();
            let doc = read(&backend, &root, &source("worktree", name)).await;
            assert_eq!(doc.kind, kind);
            if name == "empty.md" {
                assert!(doc.complete);
                assert_eq!(doc.text.as_deref(), Some(""));
            }
        }
        assert_eq!(
            read(&backend, &root, &source("worktree", "missing.md"))
                .await
                .kind,
            "missing"
        );
        fs::write(root.join("large.md"), "x\n".repeat(DOCUMENT_BYTES)).unwrap();
        let doc = read(&backend, &root, &source("worktree", "large.md")).await;
        assert_eq!(doc.kind, "tooLarge");
        assert!(doc.text.is_none());
        assert!(!doc.complete);
        // 预算本身是允许的边界：正好 2 MiB 仍然完整，不提前判定为超限。
        let exact = format!("{}\n", "a".repeat(DOCUMENT_BYTES - 1));
        fs::write(root.join("exact.md"), &exact).unwrap();
        let doc = read(&backend, &root, &source("worktree", "exact.md")).await;
        assert_eq!(doc.kind, "text");
        assert!(doc.complete);
        assert!(!doc.truncated);
        assert_eq!(doc.text.as_deref(), Some(exact.as_str()));
        let page = repository_document(
            &backend,
            root.to_str().unwrap(),
            &source("worktree", "large.md"),
            1,
            1110,
            "source",
            10,
            Some(2),
            None,
        )
        .await
        .unwrap();
        assert_eq!(page.lines, ["x", "x"]);
        assert_eq!(page.next_offset, 12);
        assert!(page.has_more);
        fs::write(root.join("large.md"), "changed").unwrap();
        assert_eq!(
            repository_document(
                &backend,
                root.to_str().unwrap(),
                &page.source,
                1,
                1111,
                "source",
                12,
                Some(2),
                page.version.as_deref()
            )
            .await
            .unwrap_err()
            .code,
            "stale"
        );
        fs::write(root.join("page.md"), "一\r\n二\n三\n").unwrap();
        git(&root, &["add", "page.md"]);
        let index = repository_document(
            &backend,
            root.to_str().unwrap(),
            &source("index", "page.md"),
            1,
            1112,
            "source",
            1,
            Some(1),
            None,
        )
        .await
        .unwrap();
        assert_eq!(index.lines, ["二"]);
        assert!(index.has_more);
        let last = repository_document(
            &backend,
            root.to_str().unwrap(),
            &index.source,
            1,
            1113,
            "source",
            2,
            Some(1),
            index.version.as_deref(),
        )
        .await
        .unwrap();
        assert_eq!(last.lines, ["三"]);
        assert!(!last.has_more);
    }

    #[tokio::test]
    async fn document_source_streams_beyond_preview_limit_and_bounds_long_lines() {
        let fixture = crate::test_support::git_fixture("document-stream");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        let line = format!("{}\n", "a".repeat(100));
        fs::write(root.join("large.md"), line.repeat(170_000)).unwrap();
        git(&root, &["add", "."]);
        let page = repository_document(
            &backend,
            root.to_str().unwrap(),
            &source("index", "large.md"),
            1,
            1114,
            "source",
            169_999,
            Some(2),
            None,
        )
        .await
        .unwrap();
        assert_eq!(page.lines, ["a".repeat(100)]);
        assert!(!page.has_more);
        assert!(!page.truncated);
        fs::write(
            root.join("long.md"),
            format!("{}\nend\n", "中".repeat(LINE_BYTES)),
        )
        .unwrap();
        git(&root, &["add", "long.md"]);
        let page = repository_document(
            &backend,
            root.to_str().unwrap(),
            &source("index", "long.md"),
            1,
            1115,
            "source",
            0,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(page.truncated);
        assert!(page.lines[0].len() <= LINE_BYTES);
        assert_eq!(page.lines[1], "end");
    }

    #[tokio::test]
    async fn document_rejects_metadata_traversal_git_symlinks_and_stale_requests() {
        let fixture = crate::test_support::git_fixture("document-paths");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        for path in [
            "../README.md",
            ".git/config",
            "dir/.GIT/config",
            "C:/outside.md",
        ] {
            assert!(repository_document(
                &backend,
                root.to_str().unwrap(),
                &source("worktree", path),
                1,
                1116,
                "document",
                0,
                None,
                None
            )
            .await
            .is_err());
            assert!(document_resource(
                &backend,
                root.to_str().unwrap(),
                &source("worktree", path),
                1,
                1117
            )
            .await
            .is_err());
        }
        fs::write(root.join("target.md"), "outside.md").unwrap();
        git(&root, &["add", "."]);
        let blob = git(&root, &["rev-parse", ":target.md"]);
        git(
            &root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("120000,{blob},link.md"),
            ],
        );
        assert_eq!(
            repository_document(
                &backend,
                root.to_str().unwrap(),
                &source("index", "link.md"),
                1,
                1118,
                "document",
                0,
                None,
                None
            )
            .await
            .unwrap_err()
            .code,
            "document_path"
        );
        assert_eq!(
            document_resource(
                &backend,
                root.to_str().unwrap(),
                &source("index", "link.md"),
                1,
                1119
            )
            .await
            .unwrap_err()
            .code,
            "document_path"
        );
        backend.scheduler.bump_generation(&repo_key(&root));
        assert_eq!(
            repository_document(
                &backend,
                root.to_str().unwrap(),
                &source("worktree", "target.md"),
                1,
                1120,
                "document",
                0,
                None,
                None
            )
            .await
            .unwrap_err()
            .code,
            "stale"
        );
    }

    #[tokio::test]
    async fn document_rename_and_deleted_diff_sides_match_real_versions() {
        let fixture = crate::test_support::git_fixture("document-diff-sides");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        fs::write(root.join("old.md"), "# old\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "old"]);
        git(&root, &["mv", "old.md", "new.md"]);
        let diff = super::super::changes::load_diff(
            &backend,
            root.to_str().unwrap(),
            "new.md",
            Some("old.md"),
            true,
            1,
            1121,
            0,
            0,
        )
        .await
        .unwrap();
        let sides = diff.document.unwrap();
        assert_eq!(sides.old.unwrap().path, "old.md");
        assert_eq!(sides.new.unwrap().path, "new.md");
        assert!(diff.preview.is_none());
        git(&root, &["commit", "-m", "rename"]);
        git(&root, &["rm", "new.md"]);
        let diff = super::super::changes::load_diff(
            &backend,
            root.to_str().unwrap(),
            "new.md",
            None,
            true,
            1,
            1122,
            0,
            0,
        )
        .await
        .unwrap();
        let sides = diff.document.unwrap();
        assert!(sides.old.is_some());
        assert!(sides.new.is_none());
        // 非 Markdown 差异不提供文档来源：消费者只能对文档侧使用只读正文接口。
        fs::write(root.join("notes.txt"), "plain\n").unwrap();
        git(&root, &["add", "notes.txt"]);
        let plain = super::super::changes::load_diff(
            &backend,
            root.to_str().unwrap(),
            "notes.txt",
            None,
            true,
            1,
            1125,
            0,
            0,
        )
        .await
        .unwrap();
        assert!(plain.document.is_none());
    }

    #[tokio::test]
    async fn document_history_sides_pin_the_parent_and_rename_source() {
        let fixture = crate::test_support::git_fixture("document-history-sides");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        fs::write(root.join("old.md"), "# 第一版\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "first"]);
        let base = git(&root, &["rev-parse", "HEAD"]);
        git(&root, &["mv", "old.md", "new.md"]);
        fs::write(root.join("new.md"), "# 第一版\n\n第二段\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "rename"]);
        let head = git(&root, &["rev-parse", "HEAD"]);
        let diff = crate::git::history::commit_file_diff(
            &backend,
            root.to_str().unwrap(),
            &head,
            Some(&base),
            "new.md",
            1,
            1126,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        let sides = diff.document.expect("Markdown 提交差异必须给出两侧来源");
        let old = sides.old.expect("父提交一侧");
        assert_eq!(old.revision, base);
        assert_eq!(old.path, "old.md");
        let new = sides.new.expect("提交一侧");
        assert_eq!(new.revision, head);
        assert_eq!(new.path, "new.md");
        // 两侧各自读取固定提交里的正文，而不是工作区或其他版本。
        assert_eq!(
            read(&backend, &root, &document_source(&old))
                .await
                .text
                .as_deref(),
            Some("# 第一版\n")
        );
        assert_eq!(
            read(&backend, &root, &document_source(&new))
                .await
                .text
                .as_deref(),
            Some("# 第一版\n\n第二段\n")
        );
        git(&root, &["rm", "new.md"]);
        git(&root, &["commit", "-m", "remove"]);
        let removed = git(&root, &["rev-parse", "HEAD"]);
        let diff = crate::git::history::commit_file_diff(
            &backend,
            root.to_str().unwrap(),
            &removed,
            Some(&head),
            "new.md",
            1,
            1127,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        let sides = diff.document.expect("删除也要能从父提交侧阅读");
        assert_eq!(sides.old.expect("父提交一侧").revision, head);
        assert!(sides.new.is_none());
        fs::write(root.join("added.md"), "# 新增\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "add"]);
        let added = git(&root, &["rev-parse", "HEAD"]);
        let sides = crate::git::history::commit_file_diff(
            &backend,
            root.to_str().unwrap(),
            &added,
            Some(&removed),
            "added.md",
            1,
            1128,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap()
        .document
        .expect("新增文件也要有提交侧");
        assert!(sides.old.is_none(), "新增文件没有父提交侧");
        assert_eq!(sides.new.expect("提交一侧").path, "added.md");
    }

    #[tokio::test]
    async fn document_read_session_cancellation_spans_steps_without_holding_permits() {
        let fixture = crate::test_support::git_fixture("document-cancel");
        let backend = fixture.backend();
        let task = backend
            .scheduler
            .read_session("session", 1123, 1, |_| async {
                backend
                    .scheduler
                    .execute_blocking_read("session", 1124, 1, |_| Ok(()))
                    .await?;
                tokio::time::sleep(Duration::from_secs(10)).await;
                Ok(())
            });
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            backend.scheduler.cancel_reads();
        };
        let (result, ()) = tokio::join!(task, cancel);
        assert_eq!(result.unwrap_err().code, "cancelled");
    }

    #[test]
    fn document_url_allows_web_only_and_never_accepts_credentials() {
        for url in [
            "javascript:alert(1)",
            "file:///C:/secret",
            "data:image/png,a",
            "https://user:pass@example.com/x",
            "https://example.com/\n",
        ] {
            assert!(validate_web_url(url).is_err(), "{url}");
        }
        assert!(validate_web_url("https://example.com/中文?q=1#part").is_ok());
        assert!(validate_web_url("http://127.0.0.1:8080/image.png").is_ok());
    }

    fn serve(replies: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/image", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut requests = vec![];
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = [0; 8192];
                let count = stream.read(&mut bytes).unwrap();
                requests.push(String::from_utf8_lossy(&bytes[..count]).into_owned());
                stream.write_all(&reply).unwrap();
            }
            requests
        });
        (url, thread)
    }
    fn response(body: &[u8], content_type: &str) -> Vec<u8> {
        let mut bytes = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    /// 没有 Content-Length 的响应由连接关闭界定长度，只能由读取过程中的上限拦截。
    fn serve_stream(reply: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stream", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0; 8192];
            let _ = stream.read(&mut bytes);
            // 客户端到达上限会提前断开，写入失败是预期结果。
            let _ = stream.write_all(&reply);
        });
        (url, thread)
    }

    #[tokio::test]
    async fn document_remote_images_are_explicit_typed_and_credential_free() {
        let fixture = crate::test_support::git_fixture("document-http");
        let backend = fixture.backend();
        let (url, thread) = serve(vec![response(&png(), "image/png")]);
        let image = document_remote_image(&backend, &url, 1201).await.unwrap();
        assert_eq!(image.kind, "image");
        let requests = thread.join().unwrap();
        let request = requests[0].to_ascii_lowercase();
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("cookie:"));
        let (url, thread) = serve(vec![response(
            b"<html><script>alert(1)</script></html>",
            "image/png",
        )]);
        assert_eq!(
            document_remote_image(&backend, &url, 1202)
                .await
                .unwrap_err()
                .code,
            "document_image"
        );
        thread.join().unwrap();
        let (url, thread) = serve(vec![b"HTTP/1.1 302 Found\r\nLocation: file:///C:/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]);
        assert_eq!(
            document_remote_image(&backend, &url, 1203)
                .await
                .unwrap_err()
                .code,
            "document_url"
        );
        thread.join().unwrap();
        let (url, thread) = serve(vec![
            b"HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\nConnection: close\r\n\r\n".to_vec(),
        ]);
        assert_eq!(
            document_remote_image(&backend, &url, 1204)
                .await
                .unwrap_err()
                .code,
            "document_image_limit"
        );
        thread.join().unwrap();
    }

    #[tokio::test]
    async fn document_remote_streamed_body_is_capped_without_content_length() {
        let fixture = crate::test_support::git_fixture("document-http-stream");
        let backend = fixture.backend();
        let header = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n";
        let mut reply = header.to_vec();
        reply.resize(header.len() + IMAGE_BYTES + 1, 0);
        let (url, thread) = serve_stream(reply);
        assert_eq!(
            document_remote_image(&backend, &url, 1207)
                .await
                .unwrap_err()
                .code,
            "document_image_limit"
        );
        thread.join().unwrap();
    }

    #[tokio::test]
    async fn document_remote_timeout_and_redirect_budget_are_bounded() {
        let fixture = crate::test_support::git_fixture("document-network-bounds");
        let backend = fixture.backend();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/slow", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(300));
            drop(stream);
        });
        let error = remote_image_with_timeout(&backend, &url, 1210, Duration::from_millis(80))
            .await
            .unwrap_err();
        assert_eq!(error.code, "document_network");
        assert!(error.message.contains("超时"));
        thread.join().unwrap();
        let redirect = b"HTTP/1.1 302 Found\r\nLocation: /image\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (url, thread) = serve(vec![redirect; 6]);
        let error = document_remote_image(&backend, &url, 1211)
            .await
            .unwrap_err();
        assert!(error.message.contains("重定向"));
        assert_eq!(thread.join().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn document_rejects_worktree_parent_symlinks() {
        let fixture = crate::test_support::git_fixture("document-parent-link");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init"]);
        fs::create_dir(root.join("real")).unwrap();
        fs::write(root.join("real/a.md"), "# linked").unwrap();
        #[cfg(windows)]
        let link = std::os::windows::fs::symlink_dir(root.join("real"), root.join("linked"));
        #[cfg(unix)]
        let link = std::os::unix::fs::symlink(root.join("real"), root.join("linked"));
        if let Err(error) = link {
            // Windows 创建目录符号链接需要开发者模式或管理员权限；未开启时系统返回 1314
            // （ERROR_PRIVILEGE_NOT_HELD，Rust 不会映射成 PermissionDenied）。只有确认是
            // 权限不足才按平台限制跳过，其他失败仍让夹具报错。索引内 120000 符号链接的
            // 拒绝不受这条平台限制影响，由 document_rejects_metadata_traversal_git_symlinks_and_stale_requests 覆盖。
            let privilege_missing = error.kind() == std::io::ErrorKind::PermissionDenied
                || (cfg!(windows) && error.raw_os_error() == Some(1314));
            if privilege_missing {
                eprintln!("document filesystem symlink check unavailable: {error}");
                return;
            }
            panic!("cannot create link fixture: {error}");
        }
        let source = source("worktree", "linked/a.md");
        assert_eq!(
            repository_document(
                &backend,
                root.to_str().unwrap(),
                &source,
                1,
                1212,
                "document",
                0,
                None,
                None
            )
            .await
            .unwrap_err()
            .code,
            "document_path"
        );
        assert_eq!(
            document_resource(&backend, root.to_str().unwrap(), &source, 1, 1213)
                .await
                .unwrap_err()
                .code,
            "document_path"
        );
    }

    #[tokio::test]
    async fn document_remote_cancellation_only_affects_its_own_request() {
        let fixture = crate::test_support::git_fixture("document-network-cancel");
        let backend = fixture.backend();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/slow", listener.local_addr().unwrap());
        let (signal, received) = tokio::sync::oneshot::channel();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _ = signal.send(());
            std::thread::sleep(Duration::from_millis(250));
            drop(stream);
        });
        let slow = document_remote_image(&backend, &url, 1205);
        let (fast_url, fast_thread) = serve(vec![response(&png(), "image/png")]);
        let cancel_and_fast = async {
            received.await.unwrap();
            cancel_document_resources(1205);
            document_remote_image(&backend, &fast_url, 1206).await
        };
        let (slow, fast) = tokio::join!(slow, cancel_and_fast);
        assert_eq!(slow.unwrap_err().code, "cancelled");
        assert_eq!(fast.unwrap().kind, "image");
        server.join().unwrap();
        fast_thread.join().unwrap();
    }
}
