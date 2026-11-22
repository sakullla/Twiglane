use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "state path has no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = temp_path(path);
    let write_result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok::<(), io::Error>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    // 只有替换前目标确实存在、替换失败后又不见了，临时文件才是仅存的内容；
    // 首次创建（目标原本不存在）失败时照旧删除临时文件，不留下来历不明的未跟踪文件。
    let target_existed = fs::symlink_metadata(path).is_ok();
    if let Err(error) = replace_file(&tmp, path) {
        return Err(discard_failed_replacement(
            &tmp,
            path,
            target_existed,
            error,
        ));
    }
    sync_dir(parent);
    Ok(())
}

/// 替换失败后的清理。目标仍在、或目标本来就不存在时删除临时文件，原状态保持不变；
/// 目标替换前存在而现在已经不存在时，保留磁盘上可能仅存的临时文件。
fn discard_failed_replacement(
    tmp: &Path,
    target: &Path,
    target_existed: bool,
    error: io::Error,
) -> io::Error {
    match fs::symlink_metadata(target) {
        Err(missing) if target_existed && missing.kind() == io::ErrorKind::NotFound => io::Error::new(
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
        let error = discard_failed_replacement(&tmp, &target, true, io::Error::other("denied"));
        assert_eq!(error.to_string(), "denied");
        assert!(!tmp.exists());
        assert_eq!(fs::read(&target).unwrap(), b"old");

        // 首次创建失败：目标本来就不存在，临时文件不是仅存内容，照旧删除。
        let fresh = dir.path().join(".gitignore");
        let fresh_tmp = temp_path(&fresh);
        fs::write(&fresh_tmp, b"new").unwrap();
        let error =
            discard_failed_replacement(&fresh_tmp, &fresh, false, io::Error::other("denied"));
        assert_eq!(error.to_string(), "denied");
        assert!(!fresh_tmp.exists());
        assert!(!fresh.exists());

        // 原文件已在替换中途消失：临时文件是仅存的内容，必须保留并在错误中指出。
        fs::remove_file(&target).unwrap();
        fs::write(&tmp, b"new").unwrap();
        let error = discard_failed_replacement(&tmp, &target, true, io::Error::other("denied"));
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert!(error.to_string().contains("new content kept at"), "{error}");
        assert!(error.to_string().contains(&tmp.display().to_string()));
        assert_eq!(fs::read(&tmp).unwrap(), b"new");
    }

}
