use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::git::gate::RepoWriteLock;
use crate::git::ops::{self, Backend};
use crate::git::schedule::internal_request_id;
use crate::git::sync;
use crate::identity::{DirectoryIdentity, WorktreeIdentity};
use crate::remote_provision::RepositoryProvision;

#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum Receipt {
    Registered { request: String },
    Completed { request: String, path: String, worktree: String },
}

fn journal_error() -> AppError {
    AppError::new("provision_journal", "无法核对新仓库的操作记录。请检查远端账号状态目录。")
}

fn pending() -> AppError {
    AppError::new("operation_pending", "创建或克隆的结果待确认。请检查选中的远端目录，核对后从 SSH 打开仓库。")
}

fn absolute_parent(input: &Path, create: bool) -> Result<(PathBuf, String), AppError> {
    if create {
        let name = input.file_name().and_then(|name| name.to_str())
            .ok_or_else(|| AppError::new("invalid_path", "请选择远端父目录下的仓库路径。"))?;
        let parent = input.parent().ok_or_else(|| AppError::new("invalid_path", "请选择远端父目录。"))?;
        return Ok((ops::canonical_existing(parent)?, name.to_owned()));
    }
    Ok((ops::canonical_existing(input)?, String::new()))
}

fn canonical_destination(parent: &Path, name: &str) -> Result<PathBuf, AppError> {
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_dir() => {
            let resolved = ops::canonical_existing(&target)?;
            if resolved.parent() != Some(parent) {
                return Err(crate::identity::worktree_changed());
            }
            Ok(resolved)
        }
        Ok(_) => Err(AppError::new("invalid_path", "目标必须是父目录下的真实目录。")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(_) => Err(AppError::new("path_unreadable", "无法核对远端目标目录。")),
    }
}

fn persist(file: &Path, receipt: &Receipt) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| journal_error())?;
    crate::atomic::atomic_write(file, &bytes).map_err(|_| journal_error())
}

fn safe_to_retry(destination: &Path, create: bool) -> bool {
    match fs::symlink_metadata(destination) {
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        Ok(metadata) if metadata.is_dir() && create => {
            fs::symlink_metadata(destination.join(".git")).is_err_and(|error| {
                error.kind() == std::io::ErrorKind::NotFound
            })
        }
        Ok(metadata) if metadata.is_dir() => fs::read_dir(destination).is_ok_and(|mut entries| entries.next().is_none()),
        Ok(_) => false,
    }
}

pub async fn run(backend: &Backend, input: &str, operation: RepositoryProvision) -> Result<Value, AppError> {
    let create = matches!(operation, RepositoryProvision::Create);
    let input = ops::validate_input_path(input)?;
    let journal = crate::journal_identity::account_state_dir().ok_or_else(journal_error)?;
    // The journal directory has already passed the account ownership check in hello.
    let directory = journal.clone();
    let _lock = tokio::task::spawn_blocking(move || RepoWriteLock::acquire(&directory, Duration::from_secs(5)))
        .await
        .map_err(|_| journal_error())??;
    let (parent, mut name) = absolute_parent(&input, create)?;
    ops::ensure_directory(&parent)?;
    let parent_identity = DirectoryIdentity::read(&parent)?;
    if let RepositoryProvision::Clone { url, name: supplied, .. } = &operation {
        name = sync::clone_destination_name(url, supplied)?;
    }
    let destination = canonical_destination(&parent, &name)?;
    let path = ops::repo_key(&destination);
    let request = match &operation {
        RepositoryProvision::Create => "create".to_owned(),
        RepositoryProvision::Clone { url, .. } => format!("clone:{:x}", Sha256::digest(url.as_bytes())),
    };
    let file = journal.join(format!("provision-{:x}.json", Sha256::digest(path.as_bytes())));
    match fs::read(&file) {
        Ok(data) => match serde_json::from_slice(&data).map_err(|_| journal_error())? {
            Receipt::Completed { request: saved, path, worktree } if saved == request => {
                let current = WorktreeIdentity::read(backend, &destination).await
                    .map_err(|_| crate::identity::worktree_changed())?;
                if current.digest != worktree || current.path != path {
                    return Err(crate::identity::worktree_changed());
                }
                return Ok(json!({"path":path,"worktreeIdentity":worktree}));
            }
            Receipt::Completed { .. } => {
                return Err(AppError::new("target_changed", "这个远端目录已有不同的仓库创建记录。请选择其他目录。"));
            }
            Receipt::Registered { .. } => return Err(pending()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(journal_error()),
    }
    if !safe_to_retry(&destination, create) {
        let (code, message) = if create {
            ("git_dir_exists", "目标目录已有 Git 数据，未重新初始化。")
        } else {
            ("clone_destination", "目标目录已有文件，未覆盖任何内容。")
        };
        return Err(AppError::new(code, message));
    }
    parent_identity.check(&parent)?;
    persist(&file, &Receipt::Registered { request: request.clone() })?;

    let result = match operation {
        RepositoryProvision::Create => {
            if !destination.exists() && fs::create_dir(&destination).is_err() {
                fs::remove_file(&file).map_err(|_| pending())?;
                return Err(AppError::new("create_failed", "无法创建远端仓库目录。"));
            }
            ops::create_repository(backend, &path, internal_request_id()).await.map(|_| None)
        }
        RepositoryProvision::Clone { url, credential, .. } => sync::clone_repository(
            backend, &url, &ops::repo_key(&parent), &name, credential.as_ref(), internal_request_id(),
        ).await.map(|result| result.credential_note),
    };
    let credential_note = match result {
        Ok(note) => note,
        Err(error) if safe_to_retry(&destination, create) => {
            fs::remove_file(&file).map_err(|_| pending())?;
            return Err(error);
        }
        Err(_) => return Err(pending()),
    };
    parent_identity.check(&parent).map_err(|_| pending())?;
    let identity = WorktreeIdentity::read(backend, &destination).await.map_err(|_| pending())?;
    persist(&file, &Receipt::Completed {
        request, path: identity.path.clone(), worktree: identity.digest.clone(),
    }).map_err(|_| pending())?;
    Ok(json!({"path":identity.path,"worktreeIdentity":identity.digest,"credentialNote":credential_note}))
}
