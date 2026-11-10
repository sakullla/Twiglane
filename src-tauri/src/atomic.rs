use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomically(path, bytes, None)
}

/// 与 `atomic_write` 相同，但保留目标文件已有的权限。目标必须存在。
///
/// Unix 复制 mode 位；Windows 的只读属性由调用方在写入前拒绝，替换时由 `ReplaceFileW`
/// 保留原文件的安全描述符。写入失败或替换失败且原文件仍在时删除临时文件，原文件保持不变；
/// 若替换中途原文件已被移除，则保留临时文件并在错误中给出位置。
pub fn atomic_write_preserving_permissions(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let permissions = fs::metadata(path)?.permissions();
    write_atomically(path, bytes, Some(permissions))
}

fn write_atomically(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "state path has no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = temp_path(path);
    let write_result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        if let Some(permissions) = &permissions {
            apply_permissions(&tmp, permissions)?;
        }
        file.sync_all()?;
        Ok::<(), io::Error>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    let replace = if permissions.is_some() {
        replace_file_preserving(&tmp, path)
    } else {
        replace_file(&tmp, path)
    };
    if let Err(error) = replace {
        return Err(discard_failed_replacement(&tmp, path, error));
    }
    sync_dir(parent);
    Ok(())
}

/// 替换失败后的清理。目标仍在时删除临时文件，原文件保持不变；
/// 目标已经不存在时（例如 Windows `ReplaceFileW` 在删除原文件后无法重命名替换文件），
/// 临时文件是磁盘上仅存的一份内容：保留它并在错误里给出位置，绝不删除。
fn discard_failed_replacement(tmp: &Path, target: &Path, error: io::Error) -> io::Error {
    match fs::symlink_metadata(target) {
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => io::Error::new(
            error.kind(),
            format!(
                "replace failed after the original file was removed; new content kept at {}: {error}",
                tmp.display()
            ),
        ),
        _ => {
            let _ = fs::remove_file(tmp);
            error
        }
    }
}

#[cfg(unix)]
fn apply_permissions(path: &Path, permissions: &fs::Permissions) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(permissions.mode()))
}

#[cfg(not(unix))]
fn apply_permissions(_path: &Path, _permissions: &fs::Permissions) -> io::Result<()> {
    // Windows 的只读属性由保存层在写入前拒绝；ACL 由 ReplaceFileW 在替换时继承。
    Ok(())
}

#[cfg(unix)]
fn replace_file_preserving(from: &Path, to: &Path) -> io::Result<()> {
    replace_file(from, to)
}

/// Windows 的普通 `MoveFileExW` 替换会让新文件继承父目录 ACL，丢掉目标文件已有的
/// 安全描述符。`ReplaceFileW` 会保留被替换文件的身份与安全描述符；不支持时退回普通替换。
#[cfg(windows)]
fn replace_file_preserving(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *const u16,
            reserved: *const u16,
        ) -> i32;
    }
    const REPLACEFILE_WRITE_THROUGH: u32 = 0x1;
    let src: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let dst: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        ReplaceFileW(
            dst.as_ptr(),
            src.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        // 目标不存在或文件系统不支持时仍按普通替换完成，不因为保留权限而让保存失败。
        // ERROR_UNABLE_TO_MOVE_REPLACEMENT 时原文件可能已被删除：普通替换也失败的话，
        // 由 `discard_failed_replacement` 保留临时文件，不会两份内容都丢失。
        let replace_error = io::Error::last_os_error();
        return replace_file(from, to).map_err(|fallback| {
            io::Error::new(
                fallback.kind(),
                format!("{fallback} (ReplaceFileW: {replace_error})"),
            )
        });
    }
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{name}.{}.{seq}.tmp", std::process::id()))
}

fn sync_dir(parent: &Path) {
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
}

#[cfg(unix)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let src: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let dst: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_file_and_removes_temp() {
        let dir = crate::test_support::TempDir::new("atomic");
        let path = dir.path().join("state.json");
        atomic_write(&path, b"{\"v\":1}").unwrap();
        atomic_write(&path, b"{\"v\":2}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"v\":2}");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn failed_replace_drops_temp_only_while_the_original_still_exists() {
        let dir = crate::test_support::TempDir::new("atomic-failed-replace");
        let target = dir.path().join("note.txt");
        fs::write(&target, b"old").unwrap();
        let tmp = temp_path(&target);
        fs::write(&tmp, b"new").unwrap();
        let error = discard_failed_replacement(&tmp, &target, io::Error::other("denied"));
        assert_eq!(error.to_string(), "denied");
        assert!(!tmp.exists());
        assert_eq!(fs::read(&target).unwrap(), b"old");

        // 原文件已在替换中途消失：临时文件是仅存的内容，必须保留并在错误中指出。
        fs::remove_file(&target).unwrap();
        fs::write(&tmp, b"new").unwrap();
        let error = discard_failed_replacement(&tmp, &target, io::Error::other("denied"));
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert!(error.to_string().contains("new content kept at"), "{error}");
        assert!(error.to_string().contains(&tmp.display().to_string()));
        assert_eq!(fs::read(&tmp).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_permissions_when_replacing() {
        use std::os::unix::fs::PermissionsExt;

        let dir = crate::test_support::TempDir::new("atomic-permissions");
        let path = dir.path().join("note.txt");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        atomic_write_preserving_permissions(&path, b"new").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }
}
