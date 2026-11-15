//! Windows Shell recycling, with pinned ancestors and identity checks at the Shell callback.
use super::*;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::sync::{Arc, Mutex};
use windows::core::{implement, Ref, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{E_ABORT, HANDLE};
use windows::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
    IShellItem, SHCreateItemFromParsingName, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
    FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_NO_CONNECTED_ELEMENTS, FOF_SILENT, SIGDN_FILESYSPATH,
    TSF_DELETE_RECYCLE_IF_POSSIBLE,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity(u32, u32, u32);

fn info(file: &fs::File) -> Result<BY_HANDLE_FILE_INFORMATION, AppError> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|_| changed())?;
    Ok(info)
}

fn identity(file: &fs::File) -> Result<Identity, AppError> {
    let info = info(file)?;
    Ok(Identity(
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

fn changed() -> AppError {
    AppError::new(
        "invalid_path",
        "删除目标在校验期间已变化，未继续执行回收站操作。",
    )
}

fn failed() -> AppError {
    AppError::new("trash_failed", "系统回收站操作未完成，未执行永久删除。")
}

fn open(path: &Path, allow_delete: bool) -> Result<fs::File, AppError> {
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(
            FILE_SHARE_READ.0
                | FILE_SHARE_WRITE.0
                | if allow_delete { FILE_SHARE_DELETE.0 } else { 0 },
        )
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .map_err(|e| entry_io_error(e, "无法打开删除目标，文件可能正被占用。"))?;
    if info(&file)?.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(unsupported_entry_error());
    }
    Ok(file)
}

fn final_path(file: &fs::File) -> Result<PathBuf, AppError> {
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = vec![0; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            HANDLE(file.as_raw_handle()),
            &mut buffer,
            FILE_NAME_NORMALIZED,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(changed());
    }
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
    Ok(dunce::simplified(&path).to_path_buf())
}

#[derive(Clone)]
pub(super) struct BoundTrashTarget {
    path: PathBuf,
    file: Arc<fs::File>,
    // No FILE_SHARE_DELETE: ancestors cannot be renamed or replaced while Shell resolves the path.
    _parents: Vec<Arc<fs::File>>,
    boundary: Arc<EditBoundary>,
    git_ids: Vec<Identity>,
    entries: Vec<(PathBuf, Identity)>,
}

impl BoundTrashTarget {
    fn verify(&self) -> Result<(), AppError> {
        if final_path(&self.file)? != self.path {
            return Err(changed());
        }
        for (path, expected) in &self.entries {
            if identity(&open(path, true)?)? != *expected {
                return Err(changed());
            }
        }
        let mut current = Vec::new();
        scan(&self.boundary, &self.path, &self.git_ids, &mut current)?;
        current.sort_by(|a, b| a.0.cmp(&b.0));
        if current != self.entries {
            return Err(changed());
        }
        Ok(())
    }
}

fn scan(
    boundary: &EditBoundary,
    path: &Path,
    git_ids: &[Identity],
    entries: &mut Vec<(PathBuf, Identity)>,
) -> Result<(), AppError> {
    let file = open(path, true)?;
    let resolved = final_path(&file)?;
    ensure_editable_location(boundary, &resolved)?;
    let id = identity(&file)?;
    if git_ids.contains(&id) {
        return Err(git_metadata_error());
    }
    entries.push((resolved.clone(), id));
    if info(&file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        for entry in
            fs::read_dir(&resolved).map_err(|e| entry_io_error(e, "无法检查待删除目录。"))?
        {
            let entry = entry.map_err(|e| entry_io_error(e, "无法检查待删除目录。"))?;
            if is_git_metadata_name(&entry.file_name()) {
                return Err(nested_repository_error());
            }
            scan(boundary, &entry.path(), git_ids, entries)?;
        }
    }
    Ok(())
}

fn bind(boundary: &EditBoundary, relative: &Path) -> Result<BoundTrashTarget, AppError> {
    let path = boundary.root.join(relative);
    let mut parents = Vec::new();
    // Pin from the volume root down, including ancestors outside the repository.
    let mut ancestors: Vec<_> = path.parent().ok_or_else(changed)?.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        let file = open(ancestor, false)?;
        if info(&file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err(unsupported_entry_error());
        }
        parents.push(Arc::new(file));
    }
    let git_ids = boundary
        .git_dirs
        .iter()
        .map(|path| identity(&open(path, true)?))
        .collect::<Result<Vec<_>, _>>()?;
    let mut current = boundary.root.clone();
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        current.push(component);
        ensure_editable_location(boundary, &final_path(&open(&current, false)?)?)?;
        if current.join(".git").symlink_metadata().is_ok() {
            return Err(nested_repository_error());
        }
    }
    let file = Arc::new(open(&path, true)?);
    let path = final_path(&file)?;
    let mut entries = Vec::new();
    scan(boundary, &path, &git_ids, &mut entries)?;
    if entries.first().map(|entry| entry.1) != Some(identity(&file)?) {
        return Err(changed());
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let boundary = Arc::new(EditBoundary {
        root: boundary.root.clone(),
        git_dirs: boundary.git_dirs.clone(),
    });
    let target = BoundTrashTarget {
        path,
        file,
        _parents: parents,
        boundary,
        git_ids,
        entries,
    };
    target.verify()?;
    Ok(target)
}

pub(super) fn trash<F>(
    boundary: &EditBoundary,
    relative: &Path,
    adapter: F,
) -> Result<(Result<(), AppError>, EntryTargetState), AppError>
where
    F: FnOnce(&BoundTrashTarget) -> Result<(), AppError>,
{
    let target = bind(boundary, relative)?;
    let result = adapter(&target);
    let state = match fs::symlink_metadata(&target.path) {
        Ok(_) => match open(&target.path, true).and_then(|file| identity(&file)) {
            Ok(id) if identity(&target.file).ok() == Some(id) => EntryTargetState::Present,
            _ => EntryTargetState::Unknown,
        },
        Err(e) if e.kind() == ErrorKind::NotFound => EntryTargetState::Missing,
        Err(_) => EntryTargetState::Unknown,
    };
    Ok((result, state))
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn shell_path(item: &IShellItem) -> windows::core::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    unsafe {
        let value = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = PathBuf::from(std::ffi::OsString::from_wide(value.as_wide()));
        CoTaskMemFree(Some(value.0.cast()));
        Ok(path)
    }
}

#[implement(IFileOperationProgressSink)]
struct RecycleSink {
    target: BoundTrashTarget,
    completed: Arc<Mutex<bool>>,
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
    fn PreDeleteItem(&self, flags: u32, item: Ref<IShellItem>) -> windows::core::Result<()> {
        // The Shell may otherwise fall back to permanent deletion (e.g. an unavailable bin).
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            return Err(E_ABORT.into());
        }
        let path = shell_path(item.ok()?)?;
        let file = open(&path, true).map_err(|_| windows::core::Error::from(E_ABORT))?;
        let actual = identity(&file).map_err(|_| windows::core::Error::from(E_ABORT))?;
        let expected =
            identity(&self.target.file).map_err(|_| windows::core::Error::from(E_ABORT))?;
        if actual != expected || self.target.verify().is_err() {
            return Err(E_ABORT.into());
        }
        Ok(())
    }

    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        result: HRESULT,
        new: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        result.ok()?;
        let path = shell_path(new.ok()?)?;
        let file = open(&path, true).map_err(|_| windows::core::Error::from(E_ABORT))?;
        let actual = identity(&file).map_err(|_| windows::core::Error::from(E_ABORT))?;
        let expected =
            identity(&self.target.file).map_err(|_| windows::core::Error::from(E_ABORT))?;
        if actual != expected {
            return Err(E_ABORT.into());
        }
        *self.completed.lock().unwrap() = true;
        Ok(())
    }

    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, result: HRESULT) -> windows::core::Result<()> {
        result.ok()
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

pub(super) fn delete_permanently(target: &BoundTrashTarget) -> Result<(), AppError> {
    target.verify()?;
    let directory = info(&target.file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    let result = if directory {
        fs::remove_dir_all(&target.path)
    } else {
        fs::remove_file(&target.path)
    };
    result.map_err(|error| {
        entry_io_error(
            error,
            "永久删除失败；已删除的内容无法恢复，其余内容保留。",
        )
    })
}

pub(super) fn recycle(target: &BoundTrashTarget) -> Result<(), AppError> {
    // A dedicated STA avoids a caller's existing COM apartment and keeps all COM objects local.
    std::thread::scope(|scope| {
        scope
            .spawn(|| -> Result<(), AppError> {
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                    .ok()
                    .map_err(|_| failed())?;
                let _apartment = Apartment;
                target.verify()?;
                let completed = Arc::new(Mutex::new(false));
                let sink: IFileOperationProgressSink = RecycleSink {
                    target: target.clone(),
                    completed: completed.clone(),
                }
                .into();
                let result = unsafe {
                    (|| -> windows::core::Result<()> {
                        let operation: IFileOperation =
                            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
                        operation.SetOperationFlags(
                            FOFX_RECYCLEONDELETE
                                | FOFX_EARLYFAILURE
                                | FOF_SILENT
                                | FOF_NOCONFIRMATION
                                | FOF_NOERRORUI
                                | FOF_NO_CONNECTED_ELEMENTS,
                        )?;
                        let item: IShellItem = SHCreateItemFromParsingName(
                            &HSTRING::from(target.path.as_os_str()),
                            None,
                        )?;
                        operation.DeleteItem(&item, &sink)?;
                        operation.PerformOperations()?;
                        if operation.GetAnyOperationsAborted()?.as_bool() {
                            return Err(E_ABORT.into());
                        }
                        Ok(())
                    })()
                };
                result.map_err(|_| failed())?;
                if !*completed.lock().unwrap() {
                    return Err(failed());
                }
                Ok(())
            })
            .join()
            .map_err(|_| failed())?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundary(root: &Path) -> EditBoundary {
        EditBoundary {
            root: root.to_path_buf(),
            git_dirs: vec![root.join(".git")],
        }
    }

    #[test]
    fn windows_trash_rejects_metadata_nested_repos_and_reparse_points() {
        let fixture = crate::test_support::TempDir::new("windows-trash-boundary");
        let root = fixture.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("nested/.git")).unwrap();
        fs::write(root.join("nested/note.txt"), b"keep").unwrap();
        let boundary = boundary(root);
        for path in [".git", "nested", "nested/note.txt"] {
            assert!(trash(&boundary, Path::new(path), |_| panic!(
                "unsafe adapter call"
            ))
            .is_err());
        }
        let outside = crate::test_support::TempDir::new("windows-trash-outside");
        fs::write(outside.path().join("keep.txt"), b"outside").unwrap();
        // Both directory symlinks and junctions carry FILE_ATTRIBUTE_REPARSE_POINT.
        std::os::windows::fs::symlink_dir(outside.path(), root.join("junction")).unwrap();
        for path in ["junction", "junction/keep.txt"] {
            assert!(trash(&boundary, Path::new(path), |_| panic!("junction followed")).is_err());
        }
        assert_eq!(
            fs::read(outside.path().join("keep.txt")).unwrap(),
            b"outside"
        );
        fs::remove_dir(root.join("junction")).unwrap();
    }

    #[test]
    fn windows_trash_pins_parents_and_rejects_replaced_targets() {
        let fixture = crate::test_support::TempDir::new("windows-trash-race");
        let root = fixture.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("parent")).unwrap();
        fs::write(root.join("parent/note.txt"), b"original").unwrap();
        let target = bind(&boundary(root), Path::new("parent/note.txt")).unwrap();
        assert!(fs::rename(root.join("parent"), root.join("replaced-parent")).is_err());
        fs::rename(
            root.join("parent/note.txt"),
            root.join("parent/original.txt"),
        )
        .unwrap();
        fs::write(root.join("parent/note.txt"), b"replacement").unwrap();
        assert!(recycle(&target).is_err());
        assert_eq!(
            fs::read(root.join("parent/note.txt")).unwrap(),
            b"replacement"
        );
        assert_eq!(
            fs::read(root.join("parent/original.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn windows_trash_rechecks_directory_contents_and_refuses_permanent_delete() {
        let fixture = crate::test_support::TempDir::new("windows-trash-recheck");
        let root = fixture.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("directory")).unwrap();
        let target = bind(&boundary(root), Path::new("directory")).unwrap();
        let sink: IFileOperationProgressSink = RecycleSink {
            target: target.clone(),
            completed: Arc::new(Mutex::new(false)),
        }
        .into();
        assert!(unsafe { sink.PreDeleteItem(0, None) }.is_err());
        fs::create_dir(root.join("directory/.git")).unwrap();
        assert!(recycle(&target).is_err());
        assert!(root.join("directory/.git").is_dir());
    }

    // Only restores the exact $R item created by this test; never empties the user's bin.
    struct Restore {
        original: PathBuf,
        recycled: PathBuf,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            if fs::rename(&self.recycled, &self.original).is_ok() {
                let name = self.recycled.file_name().unwrap().to_string_lossy();
                if let Some(suffix) = name.strip_prefix("$R") {
                    let _ = fs::remove_file(self.recycled.with_file_name(format!("$I{suffix}")));
                }
            }
        }
    }

    #[tokio::test]
    async fn windows_trash_recycles_real_files_and_nonempty_directories() {
        let fixture = crate::test_support::git_fixture("windows-real-trash");
        let root = fixture.repo("repo");
        let backend = fixture.backend();
        fs::create_dir_all(root.join("目录/sub")).unwrap();
        fs::write(root.join("文档 with spaces.md"), b"file contents").unwrap();
        fs::write(root.join("目录/sub/keep.txt"), b"directory contents").unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["add", "."],
            vec!["commit", "-qm", "init"],
        ] {
            let output = std::process::Command::new(crate::test_support::system_git())
                .current_dir(&root)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env(
                    "GIT_CONFIG_GLOBAL",
                    crate::test_support::isolated_gitconfig(),
                )
                .args([
                    "-c",
                    "user.name=Twiglane Test",
                    "-c",
                    "user.email=twiglane-test@example.com",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let head = fs::read(root.join(".git/refs/heads/main")).unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        for (i, relative) in ["文档 with spaces.md", "目录"].into_iter().enumerate() {
            let mut restore = None;
            let snapshot = repository_delete_entry_with(
                &backend,
                root.to_str().unwrap(),
                relative,
                i as u64 + 1,
                900 + i as u64,
                DeleteMode::Trash,
                |target| {
                    let result = recycle(target);
                    let recycled = final_path(&target.file).unwrap();
                    if recycled != target.path {
                        assert!(recycled
                            .components()
                            .any(|c| c.as_os_str().eq_ignore_ascii_case("$Recycle.Bin")));
                        restore = Some(Restore {
                            original: target.path.clone(),
                            recycled,
                        });
                    }
                    result
                },
            )
            .await
            .unwrap();
            assert_eq!(snapshot.generation, i as u64 + 2);
            assert!(!root.join(relative).exists());
            assert_eq!(fs::read(root.join(".git/refs/heads/main")).unwrap(), head);
            assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
            let stale = repository_delete_entry(
                &backend,
                root.to_str().unwrap(),
                relative,
                1,
                950 + i as u64,
            )
            .await
            .unwrap_err();
            assert_eq!(stale.code, "stale");
            let restored = restore.as_ref().unwrap();
            let contents = if relative == "目录" {
                fs::read(restored.recycled.join("sub/keep.txt")).unwrap()
            } else {
                fs::read(&restored.recycled).unwrap()
            };
            assert_eq!(
                contents,
                if relative == "目录" {
                    b"directory contents".as_slice()
                } else {
                    b"file contents".as_slice()
                }
            );
            // Windows writes restore information pointing at the original worktree path.
            let name = restored.recycled.file_name().unwrap().to_string_lossy();
            let metadata = fs::read(
                restored
                    .recycled
                    .with_file_name(format!("$I{}", &name[2..])),
            )
            .unwrap();
            use std::os::windows::ffi::OsStrExt;
            let original: Vec<u8> = restored
                .original
                .as_os_str()
                .encode_wide()
                .flat_map(u16::to_le_bytes)
                .collect();
            assert!(metadata
                .windows(original.len())
                .any(|bytes| bytes == original));
            drop(restore);
            assert!(root.join(relative).exists());
        }
    }
}
