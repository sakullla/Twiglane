use std::fs::{self, DirBuilder};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::error::AppError;

const FILE: &str = "journal-identity";

pub fn load() -> Result<String, AppError> {
    let identity = account_state_dir().and_then(|dir| load_or_create(&dir).ok());
    identity.ok_or_else(|| {
        AppError::new(
            "remote_journal_identity",
            "无法读取或保存远端账号的待确认操作身份。请检查远端用户的状态目录。",
        )
    })
}

fn account_state_dir() -> Option<PathBuf> {
    let configured = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    #[cfg(windows)]
    let default = || {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|profile| PathBuf::from(profile).join("AppData").join("Local"))
        })
    };
    #[cfg(not(windows))]
    let default = || {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
    };
    configured
        .or_else(default)
        .filter(|path| path.is_absolute())
        .map(|path| path.join("twiglane").join("agent").join("v2").join("journal"))
}

fn load_or_create(dir: &Path) -> io::Result<String> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    let metadata = fs::symlink_metadata(dir)?;
    if !metadata.is_dir() || !owned_state(&metadata) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }

    let path = dir.join(FILE);
    match read_identity(&path) {
        Ok(identity) => return Ok(identity),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let mut random = [0; 32];
    getrandom::fill(&mut random).map_err(|_| io::Error::other("random identity unavailable"))?;
    let hex = b"0123456789abcdef";
    let identity: String = random
        .into_iter()
        .flat_map(|byte| [hex[(byte >> 4) as usize] as char, hex[(byte & 15) as usize] as char])
        .collect();
    let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
    temporary.write_all(identity.as_bytes())?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(&path) {
        Ok(_) => {
            #[cfg(unix)]
            fs::File::open(dir)?.sync_all()?;
            Ok(identity)
        }
        // The winning process publishes the complete, synced file before it can be read.
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => read_identity(&path),
        Err(error) => Err(error.error),
    }
}

fn read_identity(path: &Path) -> io::Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() != 64 || !owned_state(&metadata) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let value = fs::read_to_string(path)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(value)
}

#[cfg(unix)]
fn owned_state(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    let user = unsafe { libc::geteuid() };
    metadata.uid() == user && metadata.mode() & 0o022 == 0
}

#[cfg(not(unix))]
fn owned_state(_metadata: &fs::Metadata) -> bool {
    // The account's LocalAppData directory supplies the inherited Windows ACL.
    true
}
