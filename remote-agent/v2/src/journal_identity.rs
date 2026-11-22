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

pub(crate) fn account_state_dir() -> Option<PathBuf> {
    // SSH clients can forward environment variables. Resolve the account's
    // storage through the OS so changing a connection profile cannot fork it.
    let profile = account_profile()?;
    if !profile.is_absolute() {
        return None;
    }
    #[cfg(windows)]
    let root = profile.join("AppData").join("Local");
    #[cfg(unix)]
    let root = profile.join(".local").join("state");
    Some(root.join("twiglane").join("agent").join("v2").join("journal"))
}

#[cfg(unix)]
fn account_profile() -> Option<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt;
    use std::ptr;

    let mut record = MaybeUninit::<libc::passwd>::uninit();
    let mut result = ptr::null_mut();
    let mut buffer = vec![0; 4096];
    loop {
        // SAFETY: passwd and result are writable, and the buffer remains
        // alive while reading the home pointer returned by getpwuid_r.
        let status = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                record.as_mut_ptr(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE && buffer.len() < 1024 * 1024 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        // SAFETY: a successful lookup with a non-null result initializes passwd.
        let home = unsafe { (*result).pw_dir };
        if home.is_null() {
            return None;
        }
        // SAFETY: the successful lookup supplies a NUL-terminated home in buffer.
        return Some(PathBuf::from(OsStr::from_bytes(unsafe { CStr::from_ptr(home) }.to_bytes())));
    }
}

#[cfg(windows)]
fn account_profile() -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr;
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Shell::GetUserProfileDirectoryW;

    let mut token = ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo handle. token holds the owned
    // access token on success, and is closed when OwnedHandle is dropped.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut length = 0;
    // SAFETY: a null output buffer asks this API for the required UTF-16 length.
    unsafe { GetUserProfileDirectoryW(token.as_raw_handle(), ptr::null_mut(), &mut length) };
    if !(2..=32768).contains(&length) {
        return None;
    }
    let mut profile = vec![0; length as usize];
    // SAFETY: profile owns a writable buffer of the length requested by the API.
    if unsafe { GetUserProfileDirectoryW(token.as_raw_handle(), profile.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    let length = profile.iter().position(|&unit| unit == 0)?;
    Some(PathBuf::from(OsString::from_wide(&profile[..length])))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_identity_distinguishes_stores_and_preserves_corruption() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let identity = load_or_create(&first).unwrap();
        assert_eq!(load_or_create(&first).unwrap(), identity);
        assert_ne!(load_or_create(&second).unwrap(), identity);

        let damaged = first.join(FILE);
        fs::write(&damaged, "damaged").unwrap();
        assert_eq!(load_or_create(&first).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_to_string(damaged).unwrap(), "damaged");
    }
}
