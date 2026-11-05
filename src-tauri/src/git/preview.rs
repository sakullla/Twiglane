//! Bounded, read-only previews. Archives are listed, never extracted.
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::git::command::cat_blob_command;
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, safe_relative, validate_input_path,
    Backend,
};
use crate::git::schedule::{internal_request_id, CommandSpec, GitJob, JobKind};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
static PREVIEW_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSource {
    pub revision: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSources {
    pub repository: String,
    pub old: Option<PreviewSource>,
    pub new: Option<PreviewSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub generation: u64,
    pub kind: String,
    pub size: Option<u64>,
    pub data_url: Option<String>,
    pub entries: Vec<ArchiveEntry>,
    pub truncated: bool,
    pub message: String,
    pub lfs_oid: Option<String>,
    pub can_download: bool,
}

impl FilePreview {
    fn message(kind: &str, message: &str, generation: u64) -> Self {
        Self {
            generation,
            kind: kind.into(),
            message: message.into(),
            size: None,
            data_url: None,
            entries: vec![],
            truncated: false,
            lfs_oid: None,
            can_download: false,
        }
    }
}

pub fn wants_preview(path: &str, raw: &[u8]) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".zip", ".tar", ".gz",
        ".tgz",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
        || raw
            .windows(b"https://git-lfs.github.com/spec/v1".len())
            .any(|w| w == b"https://git-lfs.github.com/spec/v1")
}

fn pointer(bytes: &[u8]) -> Option<(String, u64)> {
    if bytes.len() > 1024 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if lines.next()? != "version https://git-lfs.github.com/spec/v1" {
        return None;
    }
    let oid = lines.next()?.strip_prefix("oid sha256:")?;
    if oid.len() != 64
        || !oid
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let size = lines.next()?.strip_prefix("size ")?.parse().ok()?;
    if lines.any(|line| !line.is_empty()) {
        return None;
    }
    Some((oid.into(), size))
}

fn args(root: &Path, tail: &[&str]) -> Vec<std::ffi::OsString> {
    let mut args = vec!["-C".into(), root.as_os_str().to_owned()];
    args.extend(tail.iter().map(std::ffi::OsString::from));
    args
}

async fn read_git(
    backend: &Backend,
    root: &Path,
    git: &Path,
    args: Vec<std::ffi::OsString>,
    generation: u64,
) -> Result<crate::git::runner::ProcessOutput, AppError> {
    Ok(backend
        .scheduler
        .execute(GitJob {
            repo_key: repo_key(root),
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation,
            program: git.into(),
            args,
            stdin: None,
            truncate_stdout: true,
            output_limit: Some(MAX_BYTES + 1),
        })
        .await?
        .output)
}

fn validate_source(source: &PreviewSource) -> Result<(), AppError> {
    safe_relative(&source.path)?;
    let rev = source.revision.as_str();
    if !matches!(rev, "worktree" | "index" | "HEAD")
        && !(matches!(rev.len(), 40 | 64) && rev.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(AppError::new("preview_revision", "预览版本无效。"));
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Vec<u8>, AppError> {
    let file = std::fs::File::open(path)
        .map_err(|_| AppError::new("preview_read", "无法读取预览文件。"))?;
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return Err(AppError::new("preview_read", "仅支持普通文件预览。"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AppError::new("preview_read", "无法读取预览文件。"))?;
    Ok(bytes)
}

async fn source_bytes(
    backend: &Backend,
    root: &Path,
    git: &Path,
    source: &PreviewSource,
    generation: u64,
) -> Result<Option<Vec<u8>>, AppError> {
    if source.revision == "worktree" {
        let path = root.join(safe_relative(&source.path)?);
        let Ok(meta) = path.symlink_metadata() else {
            return Ok(None);
        };
        let resolved = canonical_existing(&path)?;
        if !meta.is_file() || !resolved.starts_with(root) {
            return Err(AppError::new(
                "preview_path",
                "预览文件必须位于当前仓库内且不是符号链接。",
            ));
        }
        return tokio::task::spawn_blocking(move || read_file(&resolved).map(Some))
            .await
            .map_err(|_| AppError::new("preview_read", "预览读取已中断。"))?;
    }
    let rev = if source.revision == "index" {
        ""
    } else {
        &source.revision
    };
    let (_, args) = cat_blob_command(git, root, &format!("{rev}:{}", source.path));
    let output = read_git(backend, root, git, args, generation).await?;
    if output.stdout_truncated {
        return Ok(Some(vec![0; MAX_BYTES + 1]));
    }
    if output.exit_code != 0 {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}

fn ensure_generation(backend: &Backend, root: &Path, generation: u64) -> Result<(), AppError> {
    let now = backend.scheduler.current_generation(&repo_key(root));
    if now != generation {
        return Err(AppError::new("stale", "仓库状态已变化，请刷新预览。").with_generation(now));
    }
    Ok(())
}

/// Downloads only the pointer selected by the user; never writes the index or working file.
pub async fn file_preview(
    backend: &Backend,
    path: &str,
    source: &PreviewSource,
    generation: u64,
    download: bool,
) -> Result<FilePreview, AppError> {
    let _slot = PREVIEW_SLOTS
        .acquire()
        .await
        .map_err(|_| AppError::new("cancelled", "预览已关闭。"))?;
    validate_source(source)?;
    let root = canonical_existing(&validate_input_path(path)?)?;
    ensure_generation(backend, &root, generation)?;
    let git = require_git(backend).await?;
    let Some(mut bytes) = source_bytes(backend, &root, &git.path, source, generation).await? else {
        return Ok(FilePreview::message(
            "missing",
            "此版本中没有文件。",
            generation,
        ));
    };
    let mut result_generation = generation;
    let mut lfs = None;
    if let Some((oid, size)) = pointer(&bytes) {
        lfs = Some(oid.clone());
        let mut missing = FilePreview::message("lfs", "LFS 内容尚未下载。", generation);
        missing.lfs_oid = Some(oid.clone());
        missing.size = Some(size);
        if size > MAX_BYTES as u64 {
            missing.message = "文件超过 16 MB 预览上限。".into();
            return Ok(missing);
        }
        // LFS itself resolves custom storage and linked worktrees. Never expose its credential-bearing env output.
        let env = read_git(
            backend,
            &root,
            &git.path,
            args(&root, &["lfs", "env"]),
            generation,
        )
        .await?;
        if env.exit_code != 0 {
            missing.message = "需要安装 Git LFS 后才能读取或下载此文件。".into();
            return Ok(missing);
        }
        let media = String::from_utf8_lossy(&env.stdout)
            .lines()
            .find_map(|line| line.strip_prefix("LocalMediaDir=").map(PathBuf::from));
        let cached = media.map(|dir| dir.join(&oid[..2]).join(&oid[2..4]).join(&oid));
        let local = cached
            .filter(|file| file.is_file())
            .and_then(|file| read_file(&file).ok());
        let valid =
            |data: &[u8]| data.len() as u64 == size && format!("{:x}", Sha256::digest(data)) == oid;
        if let Some(local) = local.filter(|data| valid(data)) {
            bytes = local;
        } else if download {
            let mut guard = backend
                .scheduler
                .lock_write(&repo_key(&root), internal_request_id(), generation)
                .await?;
            let output = guard
                .run(CommandSpec {
                    program: git.path.clone(),
                    args: args(
                        &root,
                        &[
                            "-c",
                            "lfs.fetchinclude=",
                            "-c",
                            "lfs.fetchexclude=",
                            "lfs",
                            "smudge",
                        ],
                    ),
                    stdin: Some(bytes),
                    truncate_stdout: false,
                    output_limit: Some(MAX_BYTES + 1),
                    writes: true,
                })
                .await;
            result_generation = guard.finish();
            let output = output.map_err(|e| e.with_generation(result_generation))?;
            if output.exit_code != 0 {
                return Err(git_failure("lfs_download", &output, "LFS 下载失败。")
                    .with_generation(result_generation));
            }
            if !valid(&output.stdout) {
                return Err(AppError::new(
                    "lfs_download",
                    "LFS 未返回完整内容；请检查跳过下载的设置或远程对象。",
                )
                .with_generation(result_generation));
            }
            bytes = output.stdout;
        } else {
            missing.can_download = true;
            return Ok(missing);
        }
    }
    let name = source.path.clone();
    let mut preview = tokio::task::spawn_blocking(move || decode(&name, &bytes, result_generation))
        .await
        .map_err(|_| AppError::new("preview_decode", "预览解析已中断。"))?;
    preview.lfs_oid = lfs;
    ensure_generation(backend, &root, result_generation)?;
    Ok(preview)
}

fn decode(name: &str, bytes: &[u8], generation: u64) -> FilePreview {
    let mut result = FilePreview::message("unsupported", "此格式暂不支持内容预览。", generation);
    result.size = Some(bytes.len() as u64);
    if bytes.len() > MAX_BYTES {
        result.message = "文件超过 16 MB 预览上限。".into();
        return result;
    }
    let lower = name.to_ascii_lowercase();
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"\0\0\x01\0") {
        Some("image/x-icon")
    } else if lower.ends_with(".svg")
        && std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg"))
    {
        Some("image/svg+xml")
    } else {
        None
    };
    if let Some(mime) = mime {
        if mime != "image/svg+xml" {
            match imagesize::blob_size(bytes) {
                Ok(size) if size.width.saturating_mul(size.height) <= 16_000_000 => {}
                Ok(_) => {
                    result.message = "图片超过 1600 万像素预览上限。".into();
                    return result;
                }
                Err(_) => {
                    result.kind = "error".into();
                    result.message = "图片文件损坏或格式不受支持。".into();
                    return result;
                }
            }
        }
        result.kind = "image".into();
        result.message.clear();
        result.data_url = Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
        return result;
    }
    let archive = if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        zip_entries(bytes)
    } else if lower.ends_with(".tar") {
        tar_entries(Cursor::new(bytes))
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        tar_entries(flate2::read::GzDecoder::new(bytes))
    } else {
        return result;
    };
    match archive {
        Ok((entries, truncated)) => {
            result.kind = "archive".into();
            result.entries = entries;
            result.truncated = truncated;
            result.message = if truncated {
                "目录已截断，最多预览 2000 项或扫描 64 MB 内容。".into()
            } else {
                String::new()
            };
        }
        Err(_) => {
            result.kind = "error".into();
            result.message = "压缩包损坏、格式不受支持或目录超过读取上限。".into();
        }
    }
    result
}

fn zip_entries(bytes: &[u8]) -> Result<(Vec<ArchiveEntry>, bool), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for index in 0..archive.len().min(MAX_ENTRIES) {
        let file = archive.by_index_raw(index).map_err(|e| e.to_string())?;
        entries.push(ArchiveEntry {
            name: file
                .name()
                .map_err(|e| e.to_string())?
                .chars()
                .take(1024)
                .collect(),
            size: file.size(),
            directory: file.is_dir(),
        });
    }
    Ok((entries, archive.len() > MAX_ENTRIES))
}

fn tar_entries(reader: impl Read) -> Result<(Vec<ArchiveEntry>, bool), String> {
    let mut archive = tar::Archive::new(reader.take(MAX_EXPANDED));
    let mut entries = Vec::new();
    let mut scanned = 0_u64;
    for item in archive.entries().map_err(|e| e.to_string())? {
        if entries.len() == MAX_ENTRIES {
            return Ok((entries, true));
        }
        let file = item.map_err(|e| e.to_string())?;
        let size = file.size();
        entries.push(ArchiveEntry {
            name: file
                .path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .chars()
                .take(1024)
                .collect(),
            size,
            directory: file.header().entry_type().is_dir(),
        });
        scanned = scanned
            .saturating_add(512)
            .saturating_add(size.div_ceil(512).saturating_mul(512));
        if scanned >= MAX_EXPANDED {
            return Ok((entries, true));
        }
    }
    Ok((entries, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new(crate::test_support::system_git())
            .current_dir(root)
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
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().into()
    }
    fn png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=").unwrap()
    }

    #[test]
    fn image_archive_and_limits() {
        assert_eq!(decode("x.png", &png(), 1).kind, "image");
        assert_eq!(
            decode("big.png", &vec![0; MAX_BYTES + 1], 1).kind,
            "unsupported"
        );
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for i in 0..2005 {
            zip.start_file(
                format!("dir/file-{i}.txt"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(b"data").unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let view = decode("x.zip", &bytes, 1);
        assert_eq!(view.kind, "archive");
        assert_eq!(view.entries.len(), MAX_ENTRIES);
        assert!(view.truncated);
        assert_eq!(view.entries[0].size, 4);
        assert_eq!(decode("bad.zip", b"PK\x03\x04broken", 1).kind, "error");
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "folder/a.txt", &b"data"[..])
            .unwrap();
        let bytes = builder.into_inner().unwrap();
        assert_eq!(decode("x.tar", &bytes, 1).entries[0].name, "folder/a.txt");
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&bytes).unwrap();
        assert_eq!(
            decode("x.tar.gz", &gzip.finish().unwrap(), 1).entries[0].size,
            4
        );
    }

    #[tokio::test]
    async fn historical_index_and_worktree_versions_are_independent() {
        let fixture = crate::test_support::git_fixture("preview");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        std::fs::write(root.join("a.svg"), "<svg>old</svg>").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "image"]);
        let oid = git(&root, &["rev-parse", "HEAD"]);
        std::fs::write(root.join("a.svg"), "<svg>index</svg>").unwrap();
        git(&root, &["add", "."]);
        std::fs::write(root.join("a.svg"), "<svg>worktree</svg>").unwrap();
        let path = root.to_str().unwrap();
        let mut urls = Vec::new();
        for revision in [&oid, "index", "worktree"] {
            let view = file_preview(
                &backend,
                path,
                &PreviewSource {
                    revision: revision.into(),
                    path: "a.svg".into(),
                },
                1,
                false,
            )
            .await
            .unwrap();
            assert_eq!(view.kind, "image");
            urls.push(view.data_url.unwrap());
        }
        assert_ne!(urls[0], urls[1]);
        assert_ne!(urls[1], urls[2]);
        let source = PreviewSource {
            revision: "worktree".into(),
            path: "../secret".into(),
        };
        assert!(file_preview(&backend, path, &source, 1, false)
            .await
            .is_err());
        backend.scheduler.bump_generation(&repo_key(&root));
        let source = PreviewSource {
            revision: oid,
            path: "a.svg".into(),
        };
        assert_eq!(
            file_preview(&backend, path, &source, 1, false)
                .await
                .unwrap_err()
                .code,
            "stale"
        );
    }

    #[tokio::test]
    async fn lfs_missing_download_and_cached_content_preserve_worktree() {
        if !Command::new(crate::test_support::system_git())
            .args(["lfs", "version"])
            .output()
            .is_ok_and(|o| o.status.success())
        {
            eprintln!("Git LFS not installed: LFS integration test skipped");
            return;
        }
        let fixture = crate::test_support::git_fixture("preview-lfs");
        let root = fixture.repo("repo");
        let remote = fixture.repo("remote.git");
        let backend = fixture.backend();
        git(&root, &["init", "-b", "main"]);
        git(&remote, &["init", "--bare"]);
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let bytes = png();
        let oid = format!("{:x}", Sha256::digest(&bytes));
        let text = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {}\n",
            bytes.len()
        );
        std::fs::write(root.join("asset.png"), &text).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "pointer"]);
        let source = PreviewSource {
            revision: "HEAD".into(),
            path: "asset.png".into(),
        };
        let missing = file_preview(&backend, root.to_str().unwrap(), &source, 1, false)
            .await
            .unwrap();
        assert_eq!(missing.kind, "lfs");
        assert!(missing.can_download);
        let object = remote
            .join("lfs/objects")
            .join(&oid[..2])
            .join(&oid[2..4])
            .join(&oid);
        std::fs::create_dir_all(object.parent().unwrap()).unwrap();
        std::fs::write(object, bytes).unwrap();
        let fetched = file_preview(&backend, root.to_str().unwrap(), &source, 1, true)
            .await
            .unwrap();
        assert_eq!(fetched.kind, "image");
        assert_eq!(fetched.lfs_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(
            std::fs::read_to_string(root.join("asset.png")).unwrap(),
            text
        );
        assert!(git(&root, &["status", "--porcelain"]).is_empty());
        let cached = file_preview(
            &backend,
            root.to_str().unwrap(),
            &source,
            fetched.generation,
            false,
        )
        .await
        .unwrap();
        assert_eq!(cached.kind, "image");
        assert!(pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:../bad\nsize 1\n"
        )
        .is_none());
    }
}
