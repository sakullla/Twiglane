//! Structure writes on Windows. Ancestors stay pinned; each new object is
//! created exclusively relative to a directory handle and published by handle.

use super::windows_trash::{final_path, identity, info, pin_parents, verify_tree, Identity};
use super::*;
use std::io::Write;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileRenameInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    FILE_RENAME_INFO,
};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, OBJ_CASE_INSENSITIVE, UNICODE_STRING};
use windows_sys::Win32::Storage::FileSystem::{
    ReplaceFileW, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

static COPY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn open_edit_file(path: &Path, share: u32, delete_access: bool) -> Result<fs::File, AppError> {
    let file = fs::OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | if delete_access { DELETE } else { 0 })
        .share_mode(share)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| changed_edit_target())?;
    if info(&file)?.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
        != 0
    {
        return Err(changed_edit_target());
    }
    Ok(file)
}

pub(super) fn replace_edit_file(
    boundary: &EditBoundary,
    relative: &Path,
    expected: &str,
    bytes: &[u8],
    observe: &mut impl FnMut(EditSaveStage),
) -> Result<(), AppError> {
    let destination = Destination::bind(boundary, relative)?;
    let share = FILE_SHARE_READ | FILE_SHARE_DELETE;
    let original = open_edit_file(&destination.path, share | FILE_SHARE_WRITE, false)?;
    let original_path = final_path(&original)?;
    ensure_editable_location(boundary, &original_path)?;
    let original_id = identity(&original)?;
    verify_edit_digest(&original, expected)?;

    let temporary_name = format!(
        ".twiglane-edit-{}-{}",
        std::process::id(),
        COPY_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    );
    let temporary = relative.with_file_name(&temporary_name);
    let stage_path = destination.path.with_file_name(&temporary_name);
    let staged = create_relative(
        destination.parent(),
        OsStr::new(&temporary_name),
        true,
        true,
    )?;
    let mut draft = match create_relative(&staged, OsStr::new("draft"), false, true) {
        Ok(file) => file,
        Err(error) => return Err(rollback(staged, Vec::new(), error)),
    };
    let prepared = (|| {
        draft.write_all(bytes).map_err(edit_io_error)?;
        draft.sync_all().map_err(edit_io_error)?;
        observe(EditSaveStage::Prepared);
        // Deny data writers on the verified file while Windows replaces its
        // name. Delete sharing allows ReplaceFileW to retain the displaced file.
        let current = open_edit_file(&destination.path, share, false)?;
        if identity(&current)? != original_id || final_path(&current)? != original_path {
            return Err(changed_edit_target());
        }
        verify_edit_digest(&current, expected)?;
        Ok(current)
    })();
    let current = match prepared {
        Ok(current) => current,
        Err(error) => return Err(rollback(staged, vec![draft], error)),
    };
    observe(EditSaveStage::Publishing);
    drop(draft);
    let wide_path = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let replaced = wide_path(&destination.path);
    let replacement = wide_path(&stage_path.join("draft"));
    let original_backup = stage_path.join("original");
    let backup = wide_path(&original_backup);
    // SAFETY: all paths are live NUL-terminated buffers. The destination's
    // ancestors and the exclusively created staging directory remain pinned.
    if unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            backup.as_ptr(),
            0,
            ptr::null(),
            ptr::null(),
        )
    } == 0
    {
        // ReplaceFileW can fail after moving the original name. Keep both
        // possible versions so the caller can verify the actual result.
        return Err(edit_needs_reconciliation(&temporary));
    }
    observe(EditSaveStage::Published);
    let preserve = || {
        let mut error = edit_needs_reconciliation(&temporary);
        let name = OsStr::new("draft-recovery");
        if let Ok(mut file) = create_relative(&staged, name, false, true) {
            if file.write_all(bytes).and_then(|()| file.sync_all()).is_ok() {
                let path = temporary.join(name);
                error
                    .message
                    .push_str(&format!("本次编辑草稿另保留在 {}。", display_path(&path)));
            } else {
                let _ = dispose(file);
            }
        }
        error
    };
    let displaced = open_edit_file(&original_backup, share, true).map_err(|_| preserve())?;
    if identity(&displaced).ok() != Some(original_id)
        || verify_edit_digest(&displaced, expected).is_err()
    {
        return Err(preserve());
    }
    drop(current);
    drop(original);
    if !dispose(displaced) || !dispose(staged) {
        return Err(edit_needs_reconciliation(&temporary));
    }
    Ok(())
}

pub(crate) fn validate_name(name: &OsStr) -> Result<(), AppError> {
    if is_git_metadata_name(name) {
        return Err(git_metadata_error());
    }
    let invalid = || AppError::new("invalid_path", "文件名不是 Windows 普通路径，未修改仓库。");
    let name = name.to_str().ok_or_else(invalid)?;
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
    {
        return Err(invalid());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|digit| {
            matches!(
                digit,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    {
        return Err(invalid());
    }
    Ok(())
}

struct Destination<'a> {
    parents: Vec<Arc<fs::File>>,
    path: PathBuf,
    name: &'a OsStr,
}

impl<'a> Destination<'a> {
    fn bind(boundary: &EditBoundary, relative: &'a Path) -> Result<Self, AppError> {
        let name = relative
            .file_name()
            .ok_or_else(|| AppError::new("invalid_path", "缺少文件名，未修改仓库。"))?;
        validate_name(name)?;
        let parents = pin_parents(boundary, relative)?;
        let path = final_path(parents.last().expect("a relative entry has a parent"))?;
        ensure_editable_location(boundary, &path)?;
        Ok(Self {
            parents,
            path: path.join(name),
            name,
        })
    }

    fn parent(&self) -> &fs::File {
        self.parents
            .last()
            .expect("a bound destination has a parent")
    }
}

struct Source {
    file: fs::File,
    path: PathBuf,
    directory: bool,
}

#[cfg(feature = "agent")]
pub(super) fn open_file_copy(boundary: &EditBoundary, relative: &Path) -> Result<fs::File, AppError> {
    let target = Destination::bind(boundary, relative)?;
    let source = Source::open(boundary, &target.path, false)?;
    if source.directory {
        return Err(unsupported_entry_error());
    }
    Ok(source.file)
}

impl Source {
    fn open(boundary: &EditBoundary, path: &Path, moving: bool) -> Result<Self, AppError> {
        let file = fs::OpenOptions::new()
            .access_mode(if moving {
                DELETE | FILE_READ_ATTRIBUTES
            } else {
                FILE_GENERIC_READ
            })
            .share_mode(if moving {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            } else {
                FILE_SHARE_READ
            })
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| entry_io_error(error, "无法打开源项目，未修改内容。"))?;
        let metadata = info(&file)?;
        let directory = metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if metadata.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (!directory && metadata.nNumberOfLinks != 1)
        {
            return Err(unsupported_entry_error());
        }
        let path = final_path(&file)?;
        ensure_editable_location(boundary, &path)?;
        Ok(Self {
            file,
            path,
            directory,
        })
    }
}

fn create_relative(
    parent: &fs::File,
    name: &OsStr,
    directory: bool,
    staging: bool,
) -> Result<fs::File, AppError> {
    validate_name(name)?;
    let mut wide: Vec<u16> = name.encode_wide().collect();
    let length = u16::try_from(wide.len().saturating_mul(2))
        .map_err(|_| AppError::new("invalid_path", "文件名过长，未修改仓库。"))?;
    let name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let access =
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE | if staging { DELETE } else { 0 };
    let options = FILE_SYNCHRONOUS_IO_NONALERT
        | if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    let mut handle = ptr::null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    // ReplaceFileW opens the directory containing its backup for changes.
    // The pinned directory allows this access while still excluding rename.
    let share = FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 };
    // SAFETY: the parent, one-component UTF-16 name and output buffers live
    // through this synchronous call. FILE_CREATE cannot open an existing name.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status_block,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            FILE_CREATE,
            options,
            ptr::null(),
            0,
        )
    };
    if status < 0 {
        let error =
            std::io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32);
        return Err(entry_io_error(
            error,
            "无法新建文件或目录，未覆盖已有内容。",
        ));
    }
    // SAFETY: success returns an owned file handle.
    Ok(unsafe { fs::File::from_raw_handle(handle) })
}

fn publish(file: &fs::File, target: &Path) -> Result<(), AppError> {
    let mut name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let name_bytes = (name.len() * size_of::<u16>()) as u32;
    name.push(0);
    let offset = offset_of!(FILE_RENAME_INFO, FileName);
    let bytes = (offset + name.len() * size_of::<u16>()).max(size_of::<FILE_RENAME_INFO>());
    let mut buffer = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
    let data = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: the aligned buffer holds the header and all UTF-16 units. All
    // ancestors of the absolute target are pinned until the rename completes.
    unsafe {
        let info = &mut *data;
        info.FileNameLength = name_bytes;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            data.cast::<u8>().add(offset).cast(),
            name.len(),
        );
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileRenameInfo,
            data.cast(),
            bytes as u32,
        )
    }
    .map_err(|error| {
        entry_io_error(
            std::io::Error::from_raw_os_error(error.code().0 & 0xffff),
            "无法完成移动或复制发布，未覆盖已有内容。",
        )
    })
}

fn dispose(file: fs::File) -> bool {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: the file was exclusively created by this operation and opened
    // with DELETE. The synchronous call only reads the provided structure.
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            ptr::from_ref(&disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
        .is_ok()
    }
}

fn copy_contents(
    boundary: &EditBoundary,
    source: &Source,
    mut destination: &fs::File,
    inserted: &mut Vec<fs::File>,
) -> Result<(), AppError> {
    if !source.directory {
        std::io::copy(&mut &source.file, &mut destination)
            .map_err(|error| entry_io_error(error, "复制文件失败，未发布目标。"))?;
        return Ok(());
    }
    let error = |error| entry_io_error(error, "无法读取源目录，未发布目标。");
    for item in fs::read_dir(&source.path).map_err(error)? {
        let item = item.map_err(error)?;
        let name = item.file_name();
        if is_git_metadata_name(&name) {
            return Err(nested_repository_error());
        }
        let child = Source::open(boundary, &item.path(), false)?;
        let new = create_relative(destination, &name, child.directory, true)?;
        let result = copy_contents(boundary, &child, &new, inserted);
        // Post-order keeps child paths removable before their parent on rollback.
        inserted.push(new);
        result?;
    }
    Ok(())
}

fn refuse_descendant(source: &Source, destination: &Destination<'_>) -> Result<(), AppError> {
    if destination.path.starts_with(&source.path) {
        Err(AppError::new(
            "invalid_path",
            "目标不能是自身或源目录的后代，未修改内容。",
        ))
    } else {
        Ok(())
    }
}

fn ensure_unoccupied(target: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(target) {
        Ok(_) => Err(AppError::new(
            "entry_exists",
            "目标已存在，未覆盖任何内容。",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(entry_io_error(error, "无法核对目标，未修改内容。")),
    }
}

pub(super) fn create(
    boundary: &EditBoundary,
    relative: &Path,
    kind: RepositoryCreateEntryKind,
) -> Result<(), AppError> {
    let destination = Destination::bind(boundary, relative)?;
    create_relative(
        destination.parent(),
        destination.name,
        matches!(kind, RepositoryCreateEntryKind::Directory),
        false,
    )?;
    Ok(())
}

pub(super) fn copy(
    boundary: &EditBoundary,
    source: &Path,
    target: &Path,
    wrote: &mut bool,
) -> Result<(), AppError> {
    let source_parent = Destination::bind(boundary, source)?;
    let source = Source::open(boundary, &source_parent.path, false)?;
    let target = Destination::bind(boundary, target)?;
    refuse_descendant(&source, &target)?;
    ensure_unoccupied(&target.path)?;
    let name = format!(
        ".twiglane-copy-{}-{}",
        std::process::id(),
        COPY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let staging = create_relative(target.parent(), OsStr::new(&name), source.directory, true)?;
    *wrote = true;
    let mut inserted = Vec::new();
    let prepared = copy_contents(boundary, &source, &staging, &mut inserted).and_then(|()| {
        inserted
            .iter()
            .map(|file| Ok((final_path(file)?, identity(file)?)))
            .collect::<Result<Vec<_>, AppError>>()
    });
    let created = match prepared {
        Ok(created) => created,
        Err(error) => return Err(rollback(staging, inserted, error)),
    };
    // Close descendants for directory rename. Keep the staging root pinned.
    drop(inserted);
    match publish(&staging, &target.path) {
        Ok(()) => Ok(()),
        Err(error) => Err(rollback_pinned(boundary, staging, created, error)),
    }
}

fn rollback(staging: fs::File, inserted: Vec<fs::File>, error: AppError) -> AppError {
    let mut removed = true;
    for file in inserted {
        removed &= dispose(file);
    }
    removed &= dispose(staging);
    if removed {
        error
    } else {
        cleanup_failed()
    }
}

fn rollback_pinned(
    boundary: &EditBoundary,
    staging: fs::File,
    created: Vec<(PathBuf, Identity)>,
    error: AppError,
) -> AppError {
    let mut removed = true;
    for (path, expected) in created {
        // Verify the exact created identity after reopening. A changed entry
        // or a path redirected through a reparse point is never deleted.
        match Source::open(boundary, &path, true) {
            Ok(source) if source.path == path && identity(&source.file).ok() == Some(expected) => {
                removed &= dispose(source.file);
            }
            _ => removed = false,
        }
    }
    removed &= dispose(staging);
    if removed {
        error
    } else {
        cleanup_failed()
    }
}

fn cleanup_failed() -> AppError {
    AppError::new(
        "entry_cleanup_failed",
        "复制目标未发布，部分临时条目无法清理。",
    )
    .after_unconfirmed_write()
}

pub(super) fn move_entry(
    boundary: &EditBoundary,
    source: &Path,
    target: &Path,
) -> Result<(), AppError> {
    let source_parent = Destination::bind(boundary, source)?;
    let source = Source::open(boundary, &source_parent.path, true)?;
    let target = Destination::bind(boundary, target)?;
    refuse_descendant(&source, &target)?;
    ensure_unoccupied(&target.path)?;
    verify_tree(boundary, &source.path)?;
    publish(&source.file, &target.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_reparse_target_does_not_redirect_the_edit() {
        let workspace = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(workspace.path()).unwrap();
        let root = base.join("repo");
        fs::create_dir(&root).unwrap();
        let boundary = EditBoundary {
            root: root.clone(),
            git_dirs: vec![],
        };
        let target = root.join("note.txt");
        let outside = base.join("outside.txt");
        fs::write(&outside, b"outside\n").unwrap();
        fs::write(&target, b"original\n").unwrap();
        let probe = root.join("probe");
        if let Err(error) = std::os::windows::fs::symlink_file(&outside, &probe) {
            assert_eq!(error.raw_os_error(), Some(1314), "{error}");
            eprintln!("Windows account lacks file symlink permission; reparse race not executed");
            return;
        }
        fs::remove_file(probe).unwrap();

        let error = replace_edit_file(
            &boundary,
            Path::new("note.txt"),
            &sha256_hex(b"original\n"),
            b"draft\n",
            &mut |stage| {
                if stage == EditSaveStage::Publishing {
                    fs::rename(&target, root.join("earlier.txt")).unwrap();
                    std::os::windows::fs::symlink_file(&outside, &target).unwrap();
                }
            },
        )
        .unwrap_err();
        assert!(error.write_unconfirmed);
        assert!(fs::symlink_metadata(&target).unwrap().is_symlink());
        assert_eq!(fs::read(&outside).unwrap(), b"outside\n");
    }

    #[test]
    fn editing_preserves_the_file_acl_and_named_streams() {
        let workspace = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(workspace.path()).unwrap();
        let boundary = EditBoundary {
            root: root.clone(),
            git_dirs: vec![],
        };
        let target = root.join("note.txt");
        let stream = root.join("note.txt:twiglane-test");
        fs::write(&target, b"alpha\n").unwrap();
        fs::write(&stream, b"secondary stream").unwrap();
        let acl = |extra: &[&str]| {
            let result = std::process::Command::new("icacls.exe")
                .arg(&target)
                .args(extra)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            result.stdout
        };
        acl(&["/grant", "*S-1-5-32-545:R"]);
        let original_acl = acl(&[]);

        replace_edit_file(
            &boundary,
            Path::new("note.txt"),
            &sha256_hex(b"alpha\n"),
            b"updated\n",
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"updated\n");
        assert_eq!(acl(&[]), original_acl);
        assert_eq!(fs::read(stream).unwrap(), b"secondary stream");
    }

    #[test]
    fn publishing_through_the_bound_handle_preserves_a_late_target() {
        let workspace = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(workspace.path()).unwrap();
        let boundary = EditBoundary {
            root: root.clone(),
            git_dirs: vec![],
        };
        let target = Destination::bind(&boundary, Path::new("target.txt")).unwrap();
        ensure_unoccupied(&target.path).unwrap();
        let prepared =
            create_relative(target.parent(), OsStr::new("staging"), false, true).unwrap();
        fs::write(&target.path, "另一个进程已创建目标").unwrap();
        assert!(publish(&prepared, &target.path).is_err());
        assert_eq!(
            fs::read_to_string(&target.path).unwrap(),
            "另一个进程已创建目标"
        );
        assert!(dispose(prepared));
        assert!(!root.join("staging").exists());
    }

    #[test]
    fn bound_writes_preserve_targets_and_reject_nested_repositories() {
        let workspace = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(workspace.path()).unwrap();
        let boundary = EditBoundary {
            root: root.clone(),
            git_dirs: vec![],
        };
        let mut wrote = false;

        create(
            &boundary,
            Path::new("目录 空格"),
            RepositoryCreateEntryKind::Directory,
        )
        .unwrap();
        create(
            &boundary,
            Path::new("目录 空格/中文.txt"),
            RepositoryCreateEntryKind::File,
        )
        .unwrap();
        fs::write(root.join("目录 空格/中文.txt"), "版本").unwrap();
        copy(
            &boundary,
            Path::new("目录 空格"),
            Path::new("copy"),
            &mut wrote,
        )
        .unwrap();
        assert!(wrote);
        assert_eq!(
            fs::read_to_string(root.join("copy/中文.txt")).unwrap(),
            "版本"
        );
        move_entry(&boundary, Path::new("copy"), Path::new("moved")).unwrap();
        assert!(!root.join("copy").exists());
        assert_eq!(
            fs::read_to_string(root.join("moved/中文.txt")).unwrap(),
            "版本"
        );
        assert_eq!(
            move_entry(&boundary, Path::new("moved"), Path::new("目录 空格"))
                .unwrap_err()
                .code,
            "entry_exists"
        );
        assert_eq!(
            fs::read_to_string(root.join("目录 空格/中文.txt")).unwrap(),
            "版本"
        );

        fs::create_dir(root.join("moved/.git")).unwrap();
        assert_eq!(
            copy(
                &boundary,
                Path::new("moved"),
                Path::new("refused"),
                &mut wrote
            )
            .unwrap_err()
            .code,
            "nested_repository"
        );
        assert!(!root.join("refused").exists());
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".twiglane-copy-")));
        for name in ["CON.txt", "Junk:stream", "ending.", "LPT².txt"] {
            assert!(validate_name(OsStr::new(name)).is_err(), "{name}");
        }
    }
}
