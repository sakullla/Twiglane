use std::ffi::OsString;
use std::path::Path;

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::git::ops::{self, Backend};
use crate::git::schedule::{internal_request_id, JobKind};

#[derive(Clone)]
pub struct WorktreeIdentity {
    pub path: String,
    pub digest: String,
    root: DirectoryIdentity,
}

impl WorktreeIdentity {
    pub async fn read(backend: &Backend, root: &Path) -> Result<Self, AppError> {
        let git = ops::require_git(backend).await?;
        let args = [
            OsString::from("--no-optional-locks"),
            OsString::from("-C"),
            root.as_os_str().to_owned(),
            OsString::from("rev-parse"),
            OsString::from("--absolute-git-dir"),
        ];
        let output = ops::run_git(
            backend,
            &ops::repo_key(root),
            JobKind::Read,
            internal_request_id(),
            git.path,
            args.into(),
            None,
        )
        .await?;
        if output.output.exit_code != 0 || output.output.stdout_truncated {
            return Err(AppError::new(
                "worktree_identity_unavailable",
                "无法定位远端工作树的 Git 目录。",
            ));
        }
        let git_dir = dunce::canonicalize(git_path(&output.output.stdout)?)
            .map_err(|_| unavailable())?;
        let path = wire_path(root)?;
        let git_path = wire_path(&git_dir)?;
        let root = DirectoryIdentity::read(root)?;
        let git = DirectoryIdentity::read(&git_dir)?;
        let host = gethostname::gethostname()
            .into_string()
            .map_err(|_| unavailable())?;
        if host.is_empty() {
            return Err(unavailable());
        }
        let host = if cfg!(windows) {
            host.to_lowercase()
        } else {
            host
        };
        // Preserve the wire bytes produced by the Cliora source and the v1 agent.
        let wire = json!([
            host,
            [path, root.0, root.1],
            [git_path, git.0, git.1]
        ]);
        let mut ascii = String::new();
        for character in wire.to_string().chars() {
            if character <= '~' {
                ascii.push(character);
            } else {
                use std::fmt::Write;
                for unit in character.encode_utf16(&mut [0; 2]) {
                    write!(ascii, "\\u{unit:04x}").expect("writing to a String cannot fail");
                }
            }
        }
        let digest = format!("{:x}", Sha256::digest(ascii.as_bytes()));
        Ok(Self { path, digest, root })
    }

    pub fn check_root(&self, root: &Path) -> Result<(), AppError> {
        self.root.check(root)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct DirectoryIdentity(u64, u64);

impl DirectoryIdentity {
    pub fn read(path: &Path) -> Result<Self, AppError> {
        directory_identity(path)
    }

    pub fn check(self, path: &Path) -> Result<(), AppError> {
        if Self::read(path).ok() == Some(self) {
            Ok(())
        } else {
            Err(worktree_changed())
        }
    }
}

pub fn worktree_changed() -> AppError {
    AppError::new("target_changed", "远端工作树身份已变化，请重新打开。")
}

pub fn git_path(stdout: &[u8]) -> Result<&Path, AppError> {
    let raw = std::str::from_utf8(stdout).map_err(|_| unavailable())?;
    // A Git path is data. Remove only the line ending added by the command.
    let path = if cfg!(windows) && raw.ends_with("\r\n") {
        &raw[..raw.len() - 2]
    } else {
        raw.strip_suffix('\n').unwrap_or(raw)
    };
    if path.is_empty() || path.contains('\0') {
        return Err(unavailable());
    }
    Ok(Path::new(path))
}

fn unavailable() -> AppError {
    AppError::new(
        "worktree_identity_unavailable",
        "无法确认远端工作树的目录与 Git 身份。",
    )
}

fn wire_path(path: &Path) -> Result<String, AppError> {
    let path = path.to_str().ok_or_else(unavailable)?;
    #[cfg(windows)]
    {
        let normalized = path.replace('\\', "/");
        if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
            return Ok(format!("//{unc}"));
        }
        let mut normalized = normalized
            .strip_prefix("//?/")
            .unwrap_or(&normalized)
            .to_owned();
        if matches!(normalized.as_bytes(), [drive, b':', b'/', ..] if drive.is_ascii_alphabetic()) {
            normalized[..1].make_ascii_uppercase();
        }
        Ok(normalized)
    }
    #[cfg(unix)]
    Ok(path.to_owned())
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentity, AppError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path).map_err(|_| unavailable())?;
    if !metadata.is_dir() {
        return Err(unavailable());
    }
    Ok(DirectoryIdentity(metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentity, AppError> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
    };

    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .map_err(|_| unavailable())?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The opened directory handle and the output buffer live through the call.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|_| unavailable())?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
        return Err(unavailable());
    }
    let file = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok(DirectoryIdentity(u64::from(info.dwVolumeSerialNumber), file))
}
