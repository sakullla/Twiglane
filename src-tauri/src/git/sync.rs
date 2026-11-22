// The shared Git implementation also compiles in the Agent crate, which defines `agent`.
#![allow(unexpected_cfgs)]

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::error::{AppError, SyncEffect};
use crate::git::advice::{classify_problem, problem_error, remote_timeout};
use crate::git::changes::commit_index;
use crate::git::command::{
    branch_list_command, check_branch_command, credential_approve_command, credential_helper_command, merged_branches_command, clone_command, create_branch_at_command,
    create_branch_command, delete_branch_command, delete_remote_branch_command,
    fetch_command, publish_command, pull_ff_command, push_command, remote_names_command,
    push_to_remote_command, push_to_upstream_command,
    remote_add_command, remote_set_url_command, remote_verbose_command, verify_ref_command,
    rename_branch_command,
    set_upstream_to_command, status_command, switch_command, switch_track_as_command,
    switch_track_command,
};
use crate::git::credential::{approve_input, auth_env, HttpCredential};
use crate::git::gate::action_key;
use crate::git::ops::{
    canonical_existing, ensure_directory, git_failure, open_repository, repo_key, require_git,
    run_git, run_remote_git, status_from_output, validate_input_path, Backend,
};
use crate::git::runner::ProcessOutput;
use crate::git::schedule::{internal_request_id, GitJob, JobKind, ScheduledOutput};
use crate::model::{
    BranchRecord, BranchState, CloneResult, CommitPushReport, RemoteInfo, RemoteState,
    StatusSnapshot,
};
use crate::redact::{contains_secret, redact};
use crate::state::now_ms;

fn sync_readback(error: AppError) -> AppError {
    error.after_sync_effect(SyncEffect::Completed)
}

pub async fn clone_repository(
    backend: &Backend,
    url: &str,
    parent: &str,
    name: &str,
    credential: Option<&HttpCredential>,
    request_id: u64,
) -> Result<CloneResult, AppError> {
    validate_remote_url(url)?;
    let auth = match credential {
        Some(credential) => auth_env(url, credential)?,
        None => Vec::new(),
    };
    let parent = canonical_existing(&validate_input_path(parent)?)?;
    ensure_directory(&parent)?;
    let directory = if name.trim().is_empty() {
        clone_dir_name(url)?
    } else {
        name.trim().to_string()
    };
    validate_clone_name(&directory)?;
    let destination = parent.join(&directory);
    if destination.exists() && (!destination.is_dir() || !dir_empty(&destination)?) {
        return Err(AppError::new(
            "clone_destination",
            format!(
                "目标目录已有文件，未覆盖任何内容。{}",
                destination.display()
            ),
        ));
    }
    let _guard = backend
        .actions
        .enter(action_key("clone", &destination.to_string_lossy()))?;
    let git = require_git(backend).await?;
    let (program, args) = clone_command(&git.path, url, &destination);
    let key = destination.to_string_lossy().into_owned();
    let scheduled = match backend
        .scheduler
        .execute(GitJob {
            repo_key: key.clone(),
            kind: JobKind::Write,
            request_id,
            generation: backend.scheduler.current_generation(&key),
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            env: auth,
        })
        .await
    {
        Err(error) => return Err(clone_failure(&destination, remote_timeout(error))),
        Ok(scheduled) => scheduled,
    };
    if scheduled.output.exit_code != 0 {
        let error = finish_remote("clone_failed", &scheduled, "克隆没有完成。");
        // 带了用户名密码仍被拒绝：说清楚是这组凭据不被接受，而不是让用户去配凭据助手。
        let error = if credential.is_some() && matches!(error.code.as_str(), "auth" | "permission") {
            AppError::new(
                "auth",
                "服务器没有接受这组用户名和密码（或访问令牌）。请核对后重试；启用了双重验证的平台需要使用访问令牌代替密码。",
            )
        } else {
            error
        };
        return Err(clone_failure(&destination, error));
    }
    let opened = open_repository(
        backend,
        &destination.to_string_lossy(),
        request_id.wrapping_add(1),
    )
    .await
    .map_err(|error| {
        AppError::new(
            "clone_open",
            format!(
                "克隆命令已结束，但无法打开仓库。目标路径仍在：{}。{}",
                destination.display(),
                error.message
            ),
        )
    })?;
    let credential_note = match credential {
        Some(credential) if credential.remember => {
            Some(remember_credential(backend, &git.path, &destination, url, credential).await)
        }
        Some(_) => Some(
            "这次输入的凭据没有保存；之后拉取或推送时如需认证，会再次提示。".to_string(),
        ),
        None => None,
    };
    Ok(CloneResult {
        path: opened.summary.path.clone(),
        opened,
        credential_note,
    })
}

/// 交给用户已配置的凭据助手保存；没有配置时不保存。返回给用户看的一句说明，不含凭据本身。
async fn remember_credential(
    backend: &Backend,
    git: &Path,
    root: &Path,
    url: &str,
    credential: &HttpCredential,
) -> String {
    let key = repo_key(root);
    let (program, args) = credential_helper_command(git, root);
    let helper = run_git(backend, &key, JobKind::Read, internal_request_id(), program, args, None).await;
    let configured = matches!(&helper, Ok(found) if found.output.exit_code == 0 && !String::from_utf8_lossy(&found.output.stdout).trim().is_empty());
    if !configured {
        return "没有检测到 Git 凭据助手（credential.helper），凭据未保存；之后拉取或推送时需要再次输入。可在 Git 中配置凭据助手后再克隆或推送。".to_string();
    }
    let Some(stdin) = approve_input(url, credential) else {
        return "凭据格式不支持保存，未保存。".to_string();
    };
    let (program, args) = credential_approve_command(git, root);
    let result = backend
        .scheduler
        .execute(GitJob {
            repo_key: key.clone(),
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation: backend.scheduler.current_generation(&key),
            program,
            args,
            stdin: Some(stdin),
            truncate_stdout: false,
            output_limit: None,
            env: Vec::new(),
        })
        .await;
    match result {
        Ok(done) if done.output.exit_code == 0 => {
            "凭据已交给系统凭据助手保存，之后拉取和推送会自动使用。".to_string()
        }
        _ => "凭据助手没有保存这组凭据；之后拉取或推送时可能需要再次输入。".to_string(),
    }
}

pub async fn remote_state(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    let root = repo_root(path)?;
    load_remote_state(backend, &root, generation, request_id).await
}

/// change-request 只读上下文：当前分支、远程列表和本地默认分支推导。
/// 读路径与 remote_state/branch_list 相同，不进入写队列，也不改 HEAD、工作区或上游。
pub(crate) struct ChangeRequestGitState {
    pub generation: u64,
    pub branch: crate::model::BranchInfo,
    pub remotes: Vec<RemoteInfo>,
    pub default_branch: Option<String>,
}

pub(crate) async fn change_request_git_state(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<ChangeRequestGitState, AppError> {
    let root = repo_root(path)?;
    // 前端带来的 generation 只是提示：这两步都是只读重读，遇到仓库状态变化
    // 就按调度器报告的新 generation 再读一次，不把过期编号当成用户错误。
    let mut expected = generation;
    for attempt in 0..2 {
        let remote = match load_remote_state(backend, &root, expected, request_id).await {
            Ok(remote) => remote,
            Err(error) if error.code == "stale" && attempt == 0 => {
                expected = error.generation.unwrap_or(expected);
                continue;
            }
            Err(error) => return Err(error),
        };
        let listed = match load_branch_list(
            backend,
            &root,
            remote.generation,
            internal_request_id(),
        )
        .await
        {
            Ok(listed) => listed,
            Err(error) if error.code == "stale" && attempt == 0 => {
                expected = error.generation.unwrap_or(remote.generation);
                continue;
            }
            Err(error) => return Err(error),
        };
        return Ok(ChangeRequestGitState {
            generation: listed.generation,
            branch: remote.snapshot.branch,
            remotes: remote.remotes,
            default_branch: listed.default_branch,
        });
    }
    Err(AppError::new(
        "change_request_stale",
        "仓库状态在读取过程中持续变化，未创建 MR/PR。请刷新后重试。",
    ))
}

/// 令牌操作只依赖远程地址，不读取工作区状态或分支列表。
pub(crate) async fn change_request_remotes(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<Vec<RemoteInfo>, AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    let (pairs, _) = settle_read!(backend, &root, generation, |current| {
        remote_pairs(backend, &root, &git.path, current, request_id).await
    })?;
    Ok(pairs.into_iter().map(RemotePair::present).collect())
}

/// Only verify the selected tracking ref, at the generation that read its remote.
pub(crate) async fn remote_tracking_ref_exists(
    backend: &Backend,
    path: &str,
    remote: &str,
    branch: &str,
    generation: u64,
    request_id: u64,
) -> Result<(bool, u64), AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    let reference = format!("refs/remotes/{remote}/{branch}");
    let (program, args) = verify_ref_command(&git.path, &root, &reference);
    let read = read_repo(backend, &root, generation, request_id, program, args).await?;
    match read.output.exit_code {
        0 => Ok((true, read.generation)),
        1 => Ok((false, read.generation)),
        _ => Err(git_failure("remote_failed", &read.output, "无法读取远程分支。")
            .with_generation(read.generation)),
    }
}

pub async fn add_remote(
    backend: &Backend,
    path: &str,
    name: &str,
    url: &str,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("remote", &repo_key(&root)))?;
    validate_remote_name(name)?;
    validate_remote_url(url)?;
    let git = require_git(backend).await?;
    let (pairs, generation) =
        remote_pairs(backend, &root, &git.path, generation, request_id).await?;
    if pairs.iter().any(|remote| remote.name == name) {
        return Err(AppError::new(
            "remote_exists",
            "已有同名远程，未覆盖它的地址。",
        ));
    }
    let (program, args) = remote_add_command(&git.path, &root, name, url);
    let scheduled = write_repo(
        backend,
        &root,
        generation,
        request_id.wrapping_add(1),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote("remote_failed", &scheduled, "没有添加远程。"));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        confirm_remote_url(backend, &root, &git.path, name, url, current).await
    })?;
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_remote_state(backend, &root, current, internal_request_id()).await
    })
}

pub async fn set_remote_url(
    backend: &Backend,
    path: &str,
    name: &str,
    url: &str,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("remote", &repo_key(&root)))?;
    validate_remote_name(name)?;
    validate_remote_url(url)?;
    let git = require_git(backend).await?;
    let (pairs, generation) =
        remote_pairs(backend, &root, &git.path, generation, request_id).await?;
    if !pairs.iter().any(|remote| remote.name == name) {
        return Err(AppError::new(
            "remote_missing",
            "没有这个远程，未写入地址。",
        ));
    }
    let (program, args) = remote_set_url_command(&git.path, &root, name, url);
    let scheduled = write_repo(
        backend,
        &root,
        generation,
        request_id.wrapping_add(1),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "remote_failed",
            &scheduled,
            "没有修改远程地址。",
        ));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        confirm_remote_url(backend, &root, &git.path, name, url, current).await
    })?;
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_remote_state(backend, &root, current, internal_request_id()).await
    })
}

pub async fn fetch_remote(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    let generation = fetch_refs(backend, &root, generation, request_id).await?;
    settle_read!(backend, &root, generation, |current| snapshot_at(
        backend, &root, current, internal_request_id()
    ).await).map_err(sync_readback)
}

pub async fn fetch_branches(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend.actions.enter(action_key("sync", &repo_key(&root)))?;
    let generation = fetch_refs(backend, &root, generation, request_id).await?;
    settle_read!(backend, &root, generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    }).map_err(sync_readback)
}

async fn fetch_refs(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<u64, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = remote_names_command(&git.path, root);
    let remotes = read_repo(backend, root, generation, request_id, program, args).await?;
    if remotes.output.exit_code != 0 {
        return Err(git_failure("remote_failed", &remotes.output, "无法读取远程。")
            .with_generation(remotes.generation));
    }
    if remotes.output.stdout.is_empty() {
        return Err(AppError::new(
            "no_remote",
            "还没有远程，无法检查。工作区没有改动。",
        ));
    }
    let (program, args) = fetch_command(&git.path, root);
    let scheduled = remote_write_repo(
        backend,
        root,
        remotes.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "fetch_failed",
            &scheduled,
            "检查远程失败，工作区没有改动。",
        ));
    }
    backend.remote_checks.note(&repo_key(root), now_ms());
    Ok(scheduled.generation)
}

pub async fn pull_fast_forward(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    let git = require_git(backend).await?;
    let before = snapshot_at(backend, &root, generation, request_id).await?;
    if before.branch.detached || before.branch.name.is_none() {
        return Err(detached_error());
    }
    if before.branch.upstream.is_none() {
        return Err(AppError::new(
            "no_upstream",
            "当前分支没有上游。请先发布，或只关联上游后再快进拉取。工作区没有改动。",
        )
        .with_generation(before.generation));
    }
    let initial_fetch = fetch_evidence(backend, &root, &git.path, before.generation).await;
    let (program, args) = pull_ff_command(&git.path, &root);
    let scheduled = remote_write_repo(
        backend,
        &root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        let error = finish_remote(
            "pull_failed",
            &scheduled,
            "拉取没有完成，工作区保持原样。",
        );
        let current = backend.scheduler.current_generation(&key);
        let final_fetch = fetch_evidence(backend, &root, &git.path, current).await;
        let effect = initial_fetch.changed_from(&final_fetch);
        // Divergence also proves that Git reached integration after fetching.
        return Err(match effect {
            _ if error.code == "diverged" => error.after_sync_effect(SyncEffect::Fetched),
            Some(true) => error.after_sync_effect(SyncEffect::Fetched),
            Some(false) => error.after_sync_effect(SyncEffect::NoFetchUpdate),
            None => AppError::new("pull_unverified", "拉取结果待确认，无法核对远程引用或 FETCH_HEAD。")
                .with_generation(current)
                .after_unconfirmed_write(),
        });
    }
    backend.remote_checks.note(&key, now_ms());
    settle_read!(backend, &root, scheduled.generation, |current| snapshot_at(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await).map_err(sync_readback)
}

#[derive(PartialEq, Eq)]
enum FetchHead {
    NoRecords,
    Entries([u8; 32]),
}

struct FetchEvidence {
    refs: Option<Vec<u8>>,
    head: Option<FetchHead>,
}

impl FetchEvidence {
    fn changed_from(&self, later: &Self) -> Option<bool> {
        let refs = self.refs.as_ref().zip(later.refs.as_ref()).map(|(before, after)| before != after);
        let head = match (self.head.as_ref(), later.head.as_ref()) {
            (Some(before), Some(after @ FetchHead::Entries(_))) => Some(before != after),
            // Git may clear an old FETCH_HEAD before failing to reach the remote.
            (Some(_), Some(FetchHead::NoRecords)) => Some(false),
            _ => None,
        };
        match (refs, head) {
            (Some(true), _) | (_, Some(true)) => Some(true),
            (Some(false), Some(false)) => Some(false),
            _ => None,
        }
    }
}

async fn fetch_evidence(backend: &Backend, root: &Path, git: &Path, generation: u64) -> FetchEvidence {
    let (program, args) = crate::git::command::fetch_refs_evidence_command(git, root);
    let refs = read_repo(backend, root, generation, internal_request_id(), program, args)
        .await
        .ok()
        .filter(|read| read.output.exit_code == 0 && !read.output.stdout_truncated)
        .map(|read| read.output.stdout);
    let (program, args) = crate::git::command::git_path_command(git, root, "FETCH_HEAD");
    let path = read_repo(backend, root, generation, internal_request_id(), program, args)
        .await
        .ok()
        .filter(|read| read.output.exit_code == 0 && !read.output.stdout_truncated)
        .and_then(|read| String::from_utf8(read.output.stdout).ok())
        .map(|path| path.trim_end_matches(['\r', '\n']).to_owned())
        .filter(|path| !path.is_empty());
    let head = match path {
        Some(path) => fetch_head_evidence(&root.join(path)).await,
        None => None,
    };
    FetchEvidence { refs, head }
}

async fn fetch_head_evidence(path: &Path) -> Option<FetchHead> {
    match tokio::fs::metadata(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(FetchHead::NoRecords),
        Ok(metadata) if metadata.is_file() => {}
        _ => return None,
    }
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut hasher = Sha256::new();
    let mut bytes = [0u8; 8 * 1024];
    let mut prefix = Vec::with_capacity(65);
    loop {
        let length = file.read(&mut bytes).await.ok()?;
        if length == 0 {
            if prefix.is_empty() {
                return Some(FetchHead::NoRecords);
            }
            let oid_len = prefix.iter().position(|byte| *byte == b'\t')?;
            return (matches!(oid_len, 40 | 64) && prefix[..oid_len].iter().all(u8::is_ascii_hexdigit))
                .then(|| FetchHead::Entries(hasher.finalize().into()));
        }
        let prefix_bytes = (65 - prefix.len()).min(length);
        prefix.extend_from_slice(&bytes[..prefix_bytes]);
        hasher.update(&bytes[..length]);
    }
}

pub async fn push_branch(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    push_with_upstream(backend, &root, generation, request_id).await
}

pub async fn publish_branch(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    publish_to(backend, &root, remote, generation, request_id).await
}

pub async fn associate_upstream(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    let git = require_git(backend).await?;
    let before = snapshot_at(backend, &root, generation, request_id).await?;
    if before.branch.unborn {
        return Err(AppError::new(
            "no_commit",
            "还没有提交，不能关联上游。没有推送。",
        ));
    }
    if before.branch.detached {
        return Err(detached_error());
    }
    let Some(branch) = before.branch.name.clone() else {
        return Err(detached_error());
    };
    validate_branch_input(&branch)?;
    let remote = resolve_remote(backend, &root, &git.path, remote, before.generation).await?;
    let upstream = format!("{remote}/{branch}");
    let (program, args) = fetch_command(&git.path, &root);
    reject_force(&args)?;
    let fetched = remote_write_repo(
        backend,
        &root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if fetched.output.exit_code != 0 {
        return Err(finish_remote(
            "fetch_failed",
            &fetched,
            "没有关联上游，工作区没有改动。",
        ));
    }
    let (program, args) = set_upstream_to_command(&git.path, &root, &upstream, &branch);
    let after_fetch = |error: AppError| error.after_sync_effect(SyncEffect::Fetched);
    reject_force(&args).map_err(after_fetch)?;
    let scheduled = write_repo(
        backend,
        &root,
        fetched.generation,
        internal_request_id(),
        program,
        args,
    )
    .await.map_err(after_fetch)?;
    if scheduled.output.exit_code != 0 {
        let text = output_text(&scheduled.output);
        if upstream_ref_missing(&text) {
            return Err(AppError::new(
                "upstream_missing",
                format!("远程还没有 {upstream}，未建立上游，也没有推送。请使用发布创建远程分支。"),
            )
            .with_generation(scheduled.generation)
            .after_sync_effect(SyncEffect::Fetched));
        }
        return Err(finish_remote(
            "upstream_failed",
            &scheduled,
            "没有关联上游，也没有推送。",
        ).after_sync_effect(SyncEffect::Fetched));
    }
    backend.remote_checks.note(&key, now_ms());
    let after = settle_read!(backend, &root, scheduled.generation, |current| snapshot_at(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await).map_err(sync_readback)?;
    if after.branch.upstream.as_deref() != Some(upstream.as_str()) {
        return Err(AppError::new(
            "upstream_unconfirmed",
            "上游关联没有被 Git 确认，没有推送。",
        )
        .with_generation(after.generation)
        .after_sync_effect(SyncEffect::Fetched));
    }
    Ok(after)
}

/// 把当前分支的上游改成任意已有的远程跟踪分支（例如 origin/develop）。
/// 只改 `branch.<name>.remote/merge` 配置，不推送、不改工作区。
pub async fn set_upstream(
    backend: &Backend,
    path: &str,
    upstream: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    validate_branch_input(upstream).map_err(|_| {
        AppError::new("upstream_invalid", "上游分支名称无效，上游没有修改。")
    })?;
    let git = require_git(backend).await?;
    let current = load_branch_state(backend, &root, generation, request_id).await?;
    let branch = &current.snapshot.branch;
    if branch.unborn {
        return Err(AppError::new("no_commit", "还没有提交，不能修改上游。")
            .with_generation(current.generation));
    }
    if branch.detached {
        return Err(detached_error().with_generation(current.generation));
    }
    let Some(local) = branch.name.clone() else {
        return Err(detached_error().with_generation(current.generation));
    };
    if upstream.ends_with("/HEAD")
        || !current
            .branches
            .iter()
            .any(|item| item.remote && item.name == upstream)
    {
        return Err(AppError::new(
            "upstream_missing",
            format!("没有远程分支 {upstream}。可以先获取更新再选择。上游没有修改。"),
        )
        .with_generation(current.generation));
    }
    if branch.upstream.as_deref() == Some(upstream) {
        return Ok(current);
    }
    let (program, args) = set_upstream_to_command(&git.path, &root, upstream, &local);
    reject_force(&args)?;
    let scheduled = write_repo(
        backend,
        &root,
        current.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "upstream_failed",
            &scheduled,
            "上游没有修改，也没有推送。",
        ));
    }
    let after = settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })?;
    if after.snapshot.branch.upstream.as_deref() != Some(upstream) {
        return Err(AppError::new(
            "upstream_unconfirmed",
            "上游修改没有被 Git 确认。请刷新后查看。",
        )
        .with_generation(after.generation));
    }
    Ok(after)
}

pub async fn commit_and_push(
    backend: &Backend,
    path: &str,
    message: &str,
    generation: u64,
    request_id: u64,
) -> Result<CommitPushReport, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    let commit = commit_index(backend, path, message, generation, request_id).await?;
    match push_after_commit(backend, &root, commit.generation).await {
        Ok(snapshot) => Ok(CommitPushReport {
            summary: format!(
                "已在 {} 创建本地提交 {}。推送已完成。",
                commit.branch,
                short_oid(&commit.oid)
            ),
            committed: true,
            pushed: true,
            retry_push: false,
            oid: commit.oid,
            branch: commit.branch,
            push_error: None,
            generation: snapshot.generation,
            snapshot,
        }),
        Err(error) => {
            let generation = error
                .generation
                .unwrap_or_else(|| backend.scheduler.current_generation(&key));
            let snapshot =
                match snapshot_at(backend, &root, generation, internal_request_id()).await {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        let mut snapshot = commit.snapshot.clone();
                        snapshot.generation = generation;
                        snapshot
                    }
                };
            Ok(CommitPushReport {
                summary: format!(
                    "已在 {} 创建本地提交 {}。推送没有成功。可以只重试推送，不会再次提交。",
                    commit.branch,
                    short_oid(&commit.oid)
                ),
                committed: true,
                pushed: false,
                retry_push: true,
                oid: commit.oid,
                branch: commit.branch,
                push_error: Some(error.message),
                generation: snapshot.generation,
                snapshot,
            })
        }
    }
}

pub async fn branch_state(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    load_branch_state(backend, &root, generation, request_id).await
}

pub async fn create_branch(
    backend: &Backend,
    path: &str,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("branch", &repo_key(&root)))?;
    validate_branch_input(name)?;
    let git = require_git(backend).await?;
    ensure_branch_format(backend, &root, &git.path, name, generation, request_id).await?;
    let current = load_branch_state(backend, &root, generation, internal_request_id()).await?;
    if current
        .branches
        .iter()
        .any(|branch| !branch.remote && branch.name == name)
    {
        return Err(duplicate_branch());
    }
    let (program, args) = create_branch_command(&git.path, &root, name);
    let scheduled = write_repo(
        backend,
        &root,
        current.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        let text = output_text(&scheduled.output);
        if text.to_ascii_lowercase().contains("already exists") || text.contains("已经存在") {
            return Err(duplicate_branch().with_generation(scheduled.generation));
        }
        return Err(finish_remote("branch_failed", &scheduled, "没有创建分支。"));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })
}

/// 从指定起点创建分支，可选创建后立即切换。
///
/// 起点只接受已知分支（本地或远程跟踪）或 7–40 位提交标识，不接受任意表达式；
/// 切换沿用 `switch_branch` 的全部保护（会覆盖未提交修改时停下）。切换失败时分支已经创建，
/// 错误里会说明这一点，不会回滚删除。
#[allow(clippy::too_many_arguments)]
pub async fn create_branch_from(
    backend: &Backend,
    path: &str,
    name: &str,
    start: &str,
    checkout: bool,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    validate_branch_input(name)?;
    let created = {
        let _guard = backend
            .actions
            .enter(action_key("branch", &repo_key(&root)))?;
        let git = require_git(backend).await?;
        ensure_branch_format(backend, &root, &git.path, name, generation, request_id).await?;
        let current = load_branch_state(backend, &root, generation, internal_request_id()).await?;
        if current
            .branches
            .iter()
            .any(|branch| !branch.remote && branch.name == name)
        {
            return Err(duplicate_branch().with_generation(current.generation));
        }
        let start = validate_start_point(&current, start)?;
        let (program, args) = create_branch_at_command(&git.path, &root, name, &start);
        let scheduled = write_repo(
            backend,
            &root,
            current.generation,
            internal_request_id(),
            program,
            args,
        )
        .await?;
        if scheduled.output.exit_code != 0 {
            let text = output_text(&scheduled.output);
            if text.to_ascii_lowercase().contains("already exists") || text.contains("已经存在")
            {
                return Err(duplicate_branch().with_generation(scheduled.generation));
            }
            return Err(finish_remote("branch_failed", &scheduled, "没有创建分支。"));
        }
        settle_read!(backend, &root, scheduled.generation, |current| {
            load_branch_state(backend, &root, current, internal_request_id()).await
        })?
    };
    if !checkout {
        return Ok(created);
    }
    switch_branch(
        backend,
        path,
        name,
        created.generation,
        internal_request_id(),
    )
    .await
    .map_err(|error| {
        AppError::new(
            error.code,
            format!("分支 {name} 已创建，但没有切换过去：{}", error.message),
        )
        .with_generation(error.generation.unwrap_or(created.generation))
    })
}

/// 起点：已知分支名原样使用；否则必须是 7–40 位十六进制提交标识。
fn validate_start_point(state: &BranchState, start: &str) -> Result<String, AppError> {
    let start = start.trim();
    if state.branches.iter().any(|branch| branch.name == start) {
        return Ok(start.to_string());
    }
    let hex = start.len() >= 7 && start.len() <= 40 && start.chars().all(|c| c.is_ascii_hexdigit());
    if hex {
        return Ok(start.to_ascii_lowercase());
    }
    Err(AppError::new(
        "branch_start_invalid",
        "新分支的起点必须是已有分支或提交标识，未创建分支。",
    )
    .with_generation(state.generation))
}

/// 重命名本地分支。目标名称按创建分支的同一套规则校验；目标已存在、分支正被其他工作区使用时拒绝。
pub async fn rename_branch(
    backend: &Backend,
    path: &str,
    old: &str,
    new: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("branch", &repo_key(&root)))?;
    validate_branch_input(old)?;
    validate_branch_input(new)?;
    let git = require_git(backend).await?;
    ensure_branch_format(backend, &root, &git.path, new, generation, request_id).await?;
    let current = load_branch_state(backend, &root, generation, internal_request_id()).await?;
    let Some(branch) = current
        .branches
        .iter()
        .find(|branch| !branch.remote && branch.name == old)
    else {
        return Err(
            AppError::new("branch_missing", "没有这个本地分支，未重命名。")
                .with_generation(current.generation),
        );
    };
    if let Some(worktree) = &branch.worktree {
        if !branch.current && !same_worktree(worktree, &root) {
            return Err(AppError::new(
                "branch_worktree",
                format!("该分支正被其他工作区使用，未重命名。工作区路径：{worktree}"),
            )
            .with_generation(current.generation));
        }
    }
    if old == new {
        return Ok(current);
    }
    if current
        .branches
        .iter()
        .any(|branch| !branch.remote && branch.name == new)
    {
        return Err(duplicate_branch().with_generation(current.generation));
    }
    let (program, args) = rename_branch_command(&git.path, &root, old, new);
    let scheduled = write_repo(
        backend,
        &root,
        current.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "branch_rename_failed",
            &scheduled,
            "没有重命名分支。",
        ));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })
}

/// 远程分支的短名已被另一个跟踪别处的本地分支占用（例如 upstream/main 与跟踪 origin/main 的 main）：
/// 用新的本地名检出并跟踪它。名称已存在时由 Git 拒绝，不覆盖任何分支。
pub async fn track_remote_as(
    backend: &Backend,
    path: &str,
    remote_branch: &str,
    local: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("branch", &repo_key(&root)))?;
    validate_branch_input(remote_branch)?;
    validate_branch_input(local)?;
    let git = require_git(backend).await?;
    ensure_branch_format(backend, &root, &git.path, local, generation, request_id).await?;
    let current = load_branch_state(backend, &root, generation, internal_request_id()).await?;
    if !current
        .branches
        .iter()
        .any(|branch| branch.remote && branch.name == remote_branch)
    {
        return Err(AppError::new("branch_missing", "没有这个远程分支，未切换。")
            .with_generation(current.generation));
    }
    if current
        .branches
        .iter()
        .any(|branch| !branch.remote && branch.name == local)
    {
        return Err(duplicate_branch().with_generation(current.generation));
    }
    let (program, args) = switch_track_as_command(&git.path, &root, local, remote_branch);
    let scheduled = write_repo(
        backend,
        &root,
        current.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "switch_failed",
            &scheduled,
            "没有切换，HEAD 和工作区保持原样。",
        ));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })
}

pub async fn switch_branch(
    backend: &Backend,
    path: &str,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("branch", &repo_key(&root)))?;
    validate_branch_input(name)?;
    let git = require_git(backend).await?;
    let current = load_branch_state(backend, &root, generation, request_id).await?;
    let (program, args) = match switch_plan(&current.branches, name) {
        SwitchPlan::Local(local) => switch_command(&git.path, &root, &local),
        SwitchPlan::Track(remote) => switch_track_command(&git.path, &root, &remote),
        SwitchPlan::UpstreamMismatch { local, selected } => {
            return Err(AppError::new(
                "branch_upstream_mismatch",
                format!(
                    "本地分支 {local} 已占用这个短名，但它的上游不是 {selected}。没有切换，HEAD 和工作区保持原样。"
                ),
            )
            .with_generation(current.generation));
        }
        SwitchPlan::Missing => {
            return Err(AppError::new("branch_missing", "没有这个分支，未切换。"));
        }
    };
    let scheduled = write_repo(
        backend,
        &root,
        current.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "switch_failed",
            &scheduled,
            "没有切换分支，工作区保持原样。",
        ));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })
}

pub async fn delete_branch(
    backend: &Backend,
    path: &str,
    name: &str,
    confirm_unmerged: bool,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("branch", &repo_key(&root)))?;
    validate_branch_input(name)?;
    let git = require_git(backend).await?;
    let current = load_branch_state(backend, &root, generation, request_id).await?;
    protect_local_delete(&current, &root, name)?;
    let (program, args) = delete_branch_command(&git.path, &root, name, false);
    let scheduled = write_repo(
        backend,
        &root,
        current.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        let text = output_text(&scheduled.output);
        if classify_problem(&text) == Some(crate::git::advice::GitProblem::UnmergedBranch)
            && confirm_unmerged
        {
            let (program, args) = delete_branch_command(&git.path, &root, name, true);
            let forced = write_repo(
                backend,
                &root,
                scheduled.generation,
                internal_request_id(),
                program,
                args,
            )
            .await?;
            if forced.output.exit_code != 0 {
                return Err(finish_remote("delete_failed", &forced, "没有删除分支。"));
            }
            return settle_read!(backend, &root, forced.generation, |current| {
                load_branch_state(backend, &root, current, internal_request_id()).await
            });
        }
        return Err(finish_remote("delete_failed", &scheduled, "没有删除分支。"));
    }
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })
}

pub async fn delete_remote_branch(
    backend: &Backend,
    path: &str,
    remote: &str,
    name: &str,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    if !confirm {
        return Err(AppError::new(
            "confirm_required",
            "删除远程分支会从远程移除它。尚未确认，未执行。",
        ));
    }
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("sync", &repo_key(&root)))?;
    validate_remote_name(remote)?;
    validate_branch_input(name)?;
    let git = require_git(backend).await?;
    let (program, args) = delete_remote_branch_command(&git.path, &root, remote, name);
    let scheduled = remote_write_repo(backend, &root, generation, request_id, program, args).await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_push(
            "delete_failed",
            &scheduled,
            "没有删除远程分支。",
        ));
    }
    // push 按远程的 fetch refspec 同步本地跟踪引用。
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    }).map_err(sync_readback)
}

async fn push_after_commit(
    backend: &Backend,
    root: &Path,
    generation: u64,
) -> Result<StatusSnapshot, AppError> {
    let before = snapshot_at(backend, root, generation, internal_request_id()).await?;
    if before.branch.upstream.is_some() {
        return push_with_upstream(backend, root, before.generation, internal_request_id()).await;
    }
    publish_to(backend, root, "", before.generation, internal_request_id()).await
}

async fn push_with_upstream(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let before = snapshot_at(backend, root, generation, request_id).await?;
    if before.branch.detached || before.branch.name.is_none() {
        return Err(detached_error());
    }
    let Some(upstream) = before.branch.upstream.clone() else {
        return publish_to(backend, root, "", before.generation, internal_request_id()).await;
    };
    let git = require_git(backend).await?;
    let branch = before.branch.name.clone().unwrap_or_default();
    let (program, args) = if upstream_matches_branch(&upstream, &branch) {
        push_command(&git.path, root)
    } else {
        push_to_upstream_command(&git.path, root)
    };
    let scheduled = remote_write_repo(
        backend,
        root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_push(
            "push_failed",
            &scheduled,
            "推送没有完成，没有强行推送。",
        ));
    }
    backend.remote_checks.note(&repo_key(root), now_ms());
    settle_read!(backend, root, scheduled.generation, |current| snapshot_at(
        backend,
        root,
        current,
        internal_request_id()
    )
    .await).map_err(sync_readback)
}

async fn publish_to(
    backend: &Backend,
    root: &Path,
    remote: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let git = require_git(backend).await?;
    let before = snapshot_at(backend, root, generation, request_id).await?;
    if before.branch.unborn {
        return Err(AppError::new("no_commit", "还没有提交，不能发布分支。"));
    }
    if before.branch.detached {
        return Err(detached_error());
    }
    let Some(branch) = before.branch.name.clone() else {
        return Err(detached_error());
    };
    let remote = resolve_remote(backend, root, &git.path, remote, before.generation).await?;
    let (program, args) = publish_command(&git.path, root, &remote, &branch);
    let scheduled = remote_write_repo(
        backend,
        root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_push(
            "publish_failed",
            &scheduled,
            "没有发布分支，也没有强行推送。",
        ));
    }
    backend.remote_checks.note(&repo_key(root), now_ms());
    settle_read!(backend, root, scheduled.generation, |current| snapshot_at(
        backend,
        root,
        current,
        internal_request_id()
    )
    .await).map_err(sync_readback)
}

#[cfg(feature = "agent")]
pub(crate) use push_continuation::{capture_push_destination, resume_pinned_push};

#[cfg(feature = "agent")]
mod push_continuation {
    use super::*;

    fn lock_config(git_dir: &Path) -> std::io::Result<tempfile::TempPath> {
        let path = git_dir.join("config.lock");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?;
        tempfile::TempPath::try_from_path(path)
    }

    struct PushDestination {
        remote: String,
        remote_ref: String,
        publish: bool,
        digest: String,
        urls: Vec<u8>,
    }

    async fn read_sync_config(
        backend: &Backend,
        root: &Path,
        git: &Path,
        key: &str,
        generation: u64,
    ) -> Result<Vec<String>, AppError> {
        let (program, args) = crate::git::command::config_values_command(git, root, key);
        let read = read_repo(backend, root, generation, internal_request_id(), program, args).await?;
        match read.output.exit_code {
            0 if !read.output.stdout_truncated => String::from_utf8(read.output.stdout)
                .map(|values| values.split_terminator('\0').map(str::to_owned).collect())
                .map_err(|_| AppError::new("push_config_unavailable", "无法读取当前推送配置。")),
            1 if read.output.stdout.is_empty() => Ok(Vec::new()),
            _ => Err(AppError::new("push_config_unavailable", "无法读取当前推送配置。")),
        }
    }

    async fn push_urls(
        backend: &Backend,
        root: &Path,
        git: &Path,
        remote: &str,
        generation: u64,
    ) -> Result<Vec<u8>, AppError> {
        let (program, args) = crate::git::command::push_urls_command(git, root, remote);
        let urls = read_repo(backend, root, generation, internal_request_id(), program, args).await?;
        if urls.output.exit_code != 0 || urls.output.stdout.is_empty() {
            return Err(AppError::new("push_target_missing", "无法读取远程的推送地址。"));
        }
        let count = urls.output.stdout.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()).count();
        if count != 1 {
            return Err(AppError::new("push_target_ambiguous", "这个远程配置了多个推送地址。请选择并单独推送。"));
        }
        Ok(urls.output.stdout)
    }

    async fn tracked_push_ref(
        backend: &Backend,
        root: &Path,
        git: &Path,
        line: &TrackLine,
        remote: &str,
        generation: u64,
    ) -> Result<String, AppError> {
        let branch = &line.track.name;
        let local_ref = format!("refs/heads/{branch}");
        let unsupported = || AppError::new("push_target_ambiguous", "当前 Git 推送配置没有唯一的单分支目标。请单独推送。");
        let mapping = read_sync_config(backend, root, git, &format!("remote.{remote}.push"), generation).await?;
        match mapping.as_slice() {
            [] => {}
            [spec] => {
                let (source, target) = spec.split_once(':').unwrap_or((spec, spec));
                if source != branch && source != local_ref {
                    return Err(unsupported());
                }
                let target = if target.starts_with("refs/") { target.to_owned() } else { format!("refs/heads/{target}") };
                validate_remote_ref(&target).map_err(|_| unsupported())?;
                return Ok(target);
            }
            _ => return Err(unsupported()),
        }
        let raw_mode = read_sync_config(backend, root, git, "push.default", generation).await?;
        let mode = if line.remote_ref != local_ref { "upstream" } else {
            raw_mode.last().map_or("simple", String::as_str)
        };
        match mode {
            "simple" | "current" => Ok(local_ref),
            "upstream" | "tracking" if remote == line.remote => Ok(line.remote_ref.clone()),
            _ => Err(unsupported()),
        }
    }

    async fn resolve_push_destination(
        backend: &Backend,
        root: &Path,
        git: &Path,
        branch: &str,
        generation: u64,
    ) -> Result<PushDestination, AppError> {
        validate_branch_input(branch)?;
        let (branches, generation) =
            read_tracking(backend, root, git, generation, internal_request_id()).await?;
        let tracked = branches.into_iter().find(|line| {
            line.track.name == branch && line.track.upstream.is_some()
        });
        let publish = tracked.is_none();
        let (remote, remote_ref) = match tracked {
            Some(line) => {
                let remote = line.push_remote.clone();
                validate_remote_name(&remote)?;
                let mirror = read_sync_config(backend, root, git, &format!("remote.{remote}.mirror"), generation).await?;
                if mirror.last().is_some_and(|value| !matches!(value.to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0")) {
                    return Err(AppError::new("push_target_ambiguous", "镜像远程可能推送多个引用。请核对远程后单独推送。"));
                }
                let target = tracked_push_ref(backend, root, git, &line, &remote, generation).await?;
                (remote, target)
            }
            None => (
                resolve_remote(backend, root, git, "", generation).await?,
                format!("refs/heads/{branch}"),
            ),
        };
        validate_remote_name(&remote)?;
        validate_remote_ref(&remote_ref)?;
        let urls = push_urls(backend, root, git, &remote, generation).await?;
        let mut digest = Sha256::new();
        digest.update(b"twiglane-push-destination/v1\0");
        digest.update([u8::from(publish)]);
        for field in [branch.as_bytes(), remote.as_bytes(), remote_ref.as_bytes(), &urls] {
            digest.update((field.len() as u64).to_be_bytes());
            digest.update(field);
        }
        Ok(PushDestination {
            remote,
            remote_ref,
            publish,
            digest: format!("{:x}", digest.finalize()),
            urls,
        })
    }

    pub(crate) async fn capture_push_destination(
        backend: &Backend,
        root: &Path,
        branch: Option<&str>,
        generation: u64,
    ) -> Result<String, AppError> {
        let branch = branch.ok_or_else(detached_error)?;
        let git = require_git(backend).await?;
        Ok(resolve_push_destination(backend, root, &git.path, branch, generation).await?.digest)
    }

    pub(crate) async fn resume_pinned_push(
        backend: &Backend,
        root: &Path,
        git_dir: &Path,
        branch: &str,
        oid: &str,
        expected: &str,
        generation: u64,
    ) -> Result<StatusSnapshot, AppError> {
        let changed = || AppError::new(
            "push_target_changed",
            "原推送目标已变化。请恢复提交时的远程地址和上游分支后再重试。",
        );
        let key = repo_key(root);
        let _guard = backend.actions.enter(action_key("sync", &key))?;
        let git = require_git(backend).await?;
        let destination = resolve_push_destination(backend, root, &git.path, branch, generation)
            .await
            .map_err(|_| changed())?;
        if destination.digest != expected {
            return Err(changed());
        }
        if push_urls(backend, root, &git.path, &destination.remote, generation)
            .await
            .map_err(|_| changed())? != destination.urls
        {
            return Err(changed());
        }
        let (program, args) = crate::git::command::push_continuation_command(
            &git.path, root, &destination.remote, oid, &destination.remote_ref,
        );
        let scheduled =
            remote_write_repo(backend, root, generation, internal_request_id(), program, args).await?;
        if scheduled.output.exit_code != 0 {
            if push_ref_updated(&scheduled.output) {
                return Err(tracking_unfinished(scheduled.generation));
            }
            return Err(finish_push("push_failed", &scheduled, "推送没有完成，没有强行推送。"));
        }
        backend.remote_checks.note(&key, now_ms());
        let after = settle_read!(backend, root, scheduled.generation, |current| snapshot_at(
            backend, root, current, internal_request_id()
        ).await)
        .map_err(|error| {
            if destination.publish { tracking_unfinished(error.generation.unwrap_or(scheduled.generation)) }
            else { sync_readback(error) }
        })?;
        if !destination.publish {
            return Ok(after);
        }
        if after.branch.name.as_deref() != Some(branch) || after.branch.head_oid.as_deref() != Some(oid) {
            return Err(tracking_unfinished(after.generation));
        }
        let linked_generation = establish_published_upstream(
            backend, root, &git.path, git_dir, &destination, &after,
        ).await?;
        settle_read!(backend, root, linked_generation, |current| snapshot_at(
            backend, root, current, internal_request_id()
        ).await)
        .map_err(sync_readback)
    }

    /// A narrow fetch refspec may not create refs/remotes/<remote>/<branch>.
    /// Use Git to prepare both branch settings and publish them under its
    /// normal config lock without requiring that tracking ref.
    async fn establish_published_upstream(
        backend: &Backend,
        root: &Path,
        git: &Path,
        git_dir: &Path,
        destination: &PushDestination,
        pushed: &StatusSnapshot,
    ) -> Result<u64, AppError> {
        let generation = pushed.generation;
        let unfinished = || tracking_unfinished(generation);
        let branch = pushed.branch.name.as_deref().ok_or_else(unfinished)?;
        let remote_key = format!("branch.{branch}.remote");
        let merge_key = format!("branch.{branch}.merge");
        let draft = lock_config(git_dir).map_err(|_| unfinished())?;
        let remote = read_sync_config(backend, root, git, &remote_key, generation).await.map_err(|_| unfinished())?;
        let merge = read_sync_config(backend, root, git, &merge_key, generation).await.map_err(|_| unfinished())?;
        if remote == [destination.remote.as_str()] && merge == [destination.remote_ref.as_str()] {
            return Ok(generation);
        }
        if !remote.is_empty() || !merge.is_empty() {
            return Err(unfinished());
        }

        let config = git_dir.join("config");
        let metadata = fs::symlink_metadata(&config).map_err(|_| unfinished())?;
        if !metadata.is_file() {
            return Err(unfinished());
        }
        let before = fs::read(&config).map_err(|_| unfinished())?;
        fs::write(&draft, &before).map_err(|_| unfinished())?;
        for (key, value) in [(&remote_key, &destination.remote), (&merge_key, &destination.remote_ref)] {
            let (program, args) = crate::git::command::set_config_in_file_command(git, root, &draft, key, value);
            let edit = read_repo(backend, root, generation, internal_request_id(), program, args)
                .await
                .map_err(|_| unfinished())?;
            if edit.output.exit_code != 0 {
                return Err(unfinished());
            }
        }
        let prepared = fs::OpenOptions::new().write(true).open(&draft).map_err(|_| unfinished())?;
        prepared.set_permissions(metadata.permissions()).map_err(|_| unfinished())?;
        prepared.sync_all().map_err(|_| unfinished())?;
        drop(prepared);
        if !read_sync_config(backend, root, git, &remote_key, generation).await.map_err(|_| unfinished())?.is_empty()
            || !read_sync_config(backend, root, git, &merge_key, generation).await.map_err(|_| unfinished())?.is_empty()
        {
            return Err(unfinished());
        }
        let current = snapshot_at(backend, root, generation, internal_request_id()).await.map_err(|_| unfinished())?;
        if current.branch.name != pushed.branch.name
            || current.branch.head_oid != pushed.branch.head_oid
            || !fs::read(&config).is_ok_and(|bytes| bytes == before)
        {
            return Err(unfinished());
        }
        draft.persist(&config).map_err(|_| unfinished())?;
        Ok(backend.scheduler.bump_generation(&repo_key(root)))
    }

    fn tracking_unfinished(generation: u64) -> AppError {
        AppError::new(
            "push_tracking_unfinished",
            "请刷新分支列表并核对上游。如需建立跟踪，请从分支列表设置。",
        )
        .with_generation(generation)
        .after_sync_effect(SyncEffect::Pushed)
    }
}

async fn resolve_remote(
    backend: &Backend,
    root: &Path,
    git: &Path,
    requested: &str,
    generation: u64,
) -> Result<String, AppError> {
    let (pairs, _) = remote_pairs(backend, root, git, generation, internal_request_id()).await?;
    if requested.is_empty() {
        if pairs.iter().any(|remote| remote.name == "origin") {
            return Ok("origin".to_string());
        }
        if pairs.len() == 1 {
            return Ok(pairs[0].name.clone());
        }
        if pairs.is_empty() {
            return Err(AppError::new(
                "no_remote",
                "还没有远程，不能发布。没有推送。",
            ));
        }
        return Err(AppError::new(
            "remote_choice",
            "有多个远程。请指定要发布到的名称。没有推送。",
        ));
    }
    validate_remote_name(requested)?;
    if !pairs.iter().any(|remote| remote.name == requested) {
        return Err(AppError::new("remote_missing", "没有这个远程，没有推送。"));
    }
    Ok(requested.to_string())
}

async fn confirm_remote_url(
    backend: &Backend,
    root: &Path,
    git: &Path,
    name: &str,
    url: &str,
    generation: u64,
) -> Result<(), AppError> {
    let (pairs, _) = remote_pairs(backend, root, git, generation, internal_request_id()).await?;
    let Some(found) = pairs.iter().find(|remote| remote.name == name) else {
        return Err(AppError::new(
            "remote_unverified",
            "Git 没有留下这个远程，请刷新后重试。",
        ));
    };
    if found.fetch != url {
        return Err(AppError::new(
            "remote_unverified",
            format!(
                "远程地址与 Git 记录不一致，未把它当作已更新。当前记录是 {}。",
                redact(&found.fetch)
            ),
        ));
    }
    Ok(())
}

async fn load_remote_state(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    let git = require_git(backend).await?;
    let (pairs, generation) =
        remote_pairs(backend, root, &git.path, generation, request_id).await?;
    let snapshot = snapshot_at(backend, root, generation, internal_request_id()).await?;
    Ok(RemoteState {
        generation: snapshot.generation,
        remotes: pairs.into_iter().map(RemotePair::present).collect(),
        snapshot,
    })
}

async fn remote_pairs(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(Vec<RemotePair>, u64), AppError> {
    let (program, args) = remote_verbose_command(git, root);
    let scheduled = read_repo(backend, root, generation, request_id, program, args).await?;
    if scheduled.output.exit_code != 0 {
        return Err(
            git_failure("remote_failed", &scheduled.output, "无法读取远程。")
                .with_generation(scheduled.generation),
        );
    }
    let pairs = parse_remote_pairs(&scheduled.output.stdout)?;
    Ok((pairs, scheduled.generation))
}

pub async fn branch_list(backend: &Backend, path: &str, generation: u64, request_id: u64) -> Result<crate::model::BranchListing, AppError> {
    let root = repo_root(path)?;
    load_branch_list(backend, &root, generation, request_id).await
}

async fn load_branch_list(backend: &Backend, root: &Path, generation: u64, request_id: u64) -> Result<crate::model::BranchListing, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = branch_list_command(&git.path, root);
    let listed = read_repo(backend, root, generation, request_id, program, args).await?;
    if listed.output.exit_code != 0 {
        return Err(
            git_failure("branch_failed", &listed.output, "无法读取分支。")
                .with_generation(listed.generation),
        );
    }
    let parsed = parse_branches(&listed.output.stdout)?;
    let mut branches = parsed.branches;
    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then(left.remote.cmp(&right.remote))
            .then(left.name.cmp(&right.name))
    });
    let default_branch = choose_default_branch(&branches, &parsed.origin_head);
    let bases = merge_bases(&branches, default_branch.as_deref());
    Ok(crate::model::BranchListing {
        generation: listed.generation,
        branches, default_branch,
        merge_bases: bases.into_iter().map(|(name, _)| name).collect(),
    })
}

async fn load_branch_state(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let git = require_git(backend).await?;
    let listed = load_branch_list(backend, root, generation, request_id).await?;
    let mut branches = listed.branches;
    let default_branch = listed.default_branch;
    let bases = merge_bases(&branches, default_branch.as_deref());
    let mut generation = listed.generation;
    let mut merged: Option<HashSet<String>> = None;
    for (_, base) in &bases {
        let (program, args) = merged_branches_command(&git.path, root, base);
        let read = read_repo(backend, root, generation, internal_request_id(), program, args).await?;
        generation = read.generation;
        // 只是提示：读不出来就不标记，不让整份分支列表失败。
        if read.output.exit_code != 0 {
            merged = Some(HashSet::new());
            break;
        }
        let refs: HashSet<String> = String::from_utf8_lossy(&read.output.stdout)
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        merged = Some(match merged {
            None => refs,
            Some(previous) => previous.intersection(&refs).cloned().collect(),
        });
    }
    if let Some(merged) = merged {
        for branch in &mut branches {
            let refname = branch_refname(branch);
            branch.merged = merged.contains(&refname) && !bases.iter().any(|(_, base)| *base == refname);
        }
    }
    let snapshot = snapshot_at(backend, root, generation, internal_request_id()).await?;
    Ok(BranchState {
        generation: snapshot.generation,
        branches,
        snapshot,
        default_branch,
        merge_bases: bases.into_iter().map(|(name, _)| name).collect(),
    })
}

fn branch_refname(branch: &BranchRecord) -> String {
    if branch.remote {
        format!("refs/remotes/{}", branch.name)
    } else {
        format!("refs/heads/{}", branch.name)
    }
}

/// 判定「已合入主干」的基准：本地默认分支，以及它的远程对应分支（优先上游，否则 origin/同名）。
/// 返回（显示名，完整引用名）。
fn merge_bases(branches: &[BranchRecord], default_branch: Option<&str>) -> Vec<(String, String)> {
    let Some(name) = default_branch else {
        return Vec::new();
    };
    let Some(local) = branches.iter().find(|branch| !branch.remote && branch.name == name) else {
        return Vec::new();
    };
    let mut bases = vec![(local.name.clone(), branch_refname(local))];
    let fallback = format!("origin/{name}");
    let remote = local
        .upstream
        .as_deref()
        .and_then(|upstream| branches.iter().find(|branch| branch.remote && branch.name == upstream))
        .or_else(|| branches.iter().find(|branch| branch.remote && branch.name == fallback));
    if let Some(remote) = remote {
        bases.push((remote.name.clone(), branch_refname(remote)));
    }
    bases
}

async fn ensure_branch_format(
    backend: &Backend,
    root: &Path,
    git: &Path,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<(), AppError> {
    let (program, args) = check_branch_command(git, root, name);
    let scheduled = read_repo(backend, root, generation, request_id, program, args).await?;
    if scheduled.output.exit_code != 0 {
        return Err(
            AppError::new("branch_invalid", "分支名称无效，未创建分支。")
                .with_generation(scheduled.generation),
        );
    }
    Ok(())
}

async fn snapshot_at(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, root);
    let scheduled = read_repo(backend, root, generation, request_id, program, args).await?;
    status_from_output(backend, root, &scheduled).await
}

async fn read_repo(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
) -> Result<ScheduledOutput, AppError> {
    run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await
}

async fn write_repo(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
) -> Result<ScheduledOutput, AppError> {
    match run_git(
        backend,
        &repo_key(root),
        JobKind::Write,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await
    {
        Err(error) => Err(attach_generation(backend, root, remote_timeout(error))),
        Ok(scheduled) => Ok(scheduled),
    }
}

/// 访问远程的写入：用户可以在设备卡住（网络、凭据）时取消。取消后远程可能已经收到请求，
/// 本地只按刷新后的实际状态显示，不假设成功或失败。
async fn remote_write_repo(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
) -> Result<ScheduledOutput, AppError> {
    match run_remote_git(
        backend,
        &repo_key(root),
        JobKind::Write,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await
    {
        Err(error) if error.code == "cancelled" => Err(attach_generation(
            backend,
            root,
            AppError::new(
                "cancelled",
                "已取消远程操作。远程可能已经收到部分请求，请以刷新后的状态为准。",
            ),
        )),
        Err(error) => Err(attach_generation(backend, root, remote_timeout(error))),
        Ok(scheduled) => Ok(scheduled),
    }
}

/// 停止这个仓库正在进行的远程操作。
pub fn cancel_remote(backend: &Backend, path: &str) -> Result<(), AppError> {
    let root = repo_root(path)?;
    backend.scheduler.cancel_remote(&repo_key(&root));
    Ok(())
}

/// 把当前分支推送到指定远程的同名分支。用于有多个远程时推送到上游以外的远程；
/// 不强推，也不改变当前分支的上游。
pub async fn push_to_remote(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    let git = require_git(backend).await?;
    let before = snapshot_at(backend, &root, generation, request_id).await?;
    if before.branch.unborn {
        return Err(AppError::new("no_commit", "还没有提交，不能推送。"));
    }
    if before.branch.detached {
        return Err(detached_error());
    }
    let Some(branch) = before.branch.name.clone() else {
        return Err(detached_error());
    };
    validate_branch_input(&branch)?;
    let remote = resolve_remote(backend, &root, &git.path, remote, before.generation).await?;
    let (program, args) = push_to_remote_command(&git.path, &root, &remote, &branch);
    reject_force(&args)?;
    let scheduled = remote_write_repo(
        backend,
        &root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_push(
            "push_failed",
            &scheduled,
            &format!("没有推送到 {remote}，也没有强行推送。"),
        ));
    }
    backend.remote_checks.note(&key, now_ms());
    settle_read!(backend, &root, scheduled.generation, |current| snapshot_at(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await).map_err(sync_readback)
}

/// 一条本地分支的上游跟踪信息（含快进/推送需要的远程名与远程引用名）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrackLine {
    track: crate::model::BranchTrack,
    remote: String,
    remote_ref: String,
    #[cfg(feature = "agent")]
    push_remote: String,
}

/// 解析 `ahead 3, behind 2` / `ahead 1` / `behind 4` / `gone` / 空。
fn parse_track(text: &str) -> (u32, u32, bool) {
    let text = text.trim();
    if text == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in text.split(',') {
        let mut words = part.split_whitespace();
        match (words.next(), words.next().and_then(|n| n.parse::<u32>().ok())) {
            (Some("ahead"), Some(n)) => ahead = n,
            (Some("behind"), Some(n)) => behind = n,
            _ => {}
        }
    }
    (ahead, behind, false)
}

fn parse_tracking(bytes: &[u8]) -> Vec<TrackLine> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let mut parts = line.split('\u{1f}');
        let Some(name) = parts.next().and_then(|refname| refname.strip_prefix("refs/heads/")) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let upstream = parts.next().unwrap_or("").trim();
        let (ahead, behind, gone) = parse_track(parts.next().unwrap_or(""));
        let remote = parts.next().unwrap_or("").trim().to_string();
        let remote_ref = parts.next().unwrap_or("").trim().to_string();
        #[cfg(feature = "agent")]
        let push_remote = parts.next().unwrap_or("").trim().to_string();
        lines.push(TrackLine {
            track: crate::model::BranchTrack {
                name: name.to_string(),
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                ahead,
                behind,
                gone,
            },
            remote,
            remote_ref,
            #[cfg(feature = "agent")]
            push_remote,
        });
    }
    lines
}

async fn read_tracking(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(Vec<TrackLine>, u64), AppError> {
    let (program, args) = crate::git::command::branch_tracking_command(git, root);
    let read = read_repo(backend, root, generation, request_id, program, args).await?;
    if read.output.exit_code != 0 {
        return Err(git_failure("branch_failed", &read.output, "无法读取分支的上游状态。")
            .with_generation(read.generation));
    }
    Ok((parse_tracking(&read.output.stdout), read.generation))
}

/// 全部本地分支相对上游的领先/落后：只读、不访问远程，一次 `for-each-ref`。
pub async fn branch_tracking(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::BranchTracking, AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    let (lines, generation) = read_tracking(backend, &root, &git.path, generation, request_id).await?;
    Ok(crate::model::BranchTracking {
        generation,
        branches: lines.into_iter().map(|line| line.track).collect(),
    })
}

/// 远程引用名只接受普通的 `refs/heads/...`，拼进 refspec 前排除冒号、通配符与强制前缀。
fn validate_remote_ref(remote_ref: &str) -> Result<(), AppError> {
    let Some(short) = remote_ref.strip_prefix("refs/heads/") else {
        return Err(AppError::new("upstream_invalid", "上游不是普通分支，未执行。"));
    };
    validate_branch_input(short)
        .map_err(|_| AppError::new("upstream_invalid", "上游分支名称无效，未执行。"))
}

fn validate_track_remote(remote: &str) -> Result<(), AppError> {
    if remote == "." {
        return Ok(());
    }
    validate_remote_name(remote)
}

/// 不切换分支地把一个非当前的本地分支快进到上游（`git fetch <remote> <src>:<dst>`）。
/// 不能快进时 Git 拒绝更新，分支保持原样；当前分支走常规拉取，其他工作区检出的分支不碰。
pub async fn update_branch(
    backend: &Backend,
    path: &str,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    validate_branch_input(name)?;
    let git = require_git(backend).await?;
    let current = load_branch_state(backend, &root, generation, request_id).await?;
    let Some(branch) = current.branches.iter().find(|branch| !branch.remote && branch.name == name) else {
        return Err(AppError::new("branch_missing", "没有这个本地分支，未拉取。")
            .with_generation(current.generation));
    };
    if branch.current || current.snapshot.branch.name.as_deref() == Some(name) {
        return Err(AppError::new(
            "branch_current",
            "这是当前分支，请用同步菜单里的「拉取」更新它和工作区。",
        )
        .with_generation(current.generation));
    }
    if let Some(worktree) = &branch.worktree {
        if !same_worktree(worktree, &root) {
            return Err(AppError::new(
                "branch_worktree",
                format!("{name} 正在其他工作区检出，请在那个工作区里拉取。工作区路径：{worktree}"),
            )
            .with_generation(current.generation));
        }
    }
    let (lines, generation) =
        read_tracking(backend, &root, &git.path, current.generation, internal_request_id()).await?;
    let Some(line) = lines.into_iter().find(|line| line.track.name == name) else {
        return Err(AppError::new("branch_missing", "没有这个本地分支，未拉取。").with_generation(generation));
    };
    let Some(upstream) = line.track.upstream.clone() else {
        return Err(AppError::new(
            "no_upstream",
            format!("{name} 没有上游，无法拉取。可以先推送并建立上游。"),
        )
        .with_generation(generation));
    };
    if line.track.gone {
        return Err(AppError::new(
            "upstream_gone",
            format!("{name} 的上游 {upstream} 已经不在远程上，未拉取。"),
        )
        .with_generation(generation));
    }
    validate_track_remote(&line.remote)?;
    validate_remote_ref(&line.remote_ref)?;
    let (program, args) =
        crate::git::command::fetch_into_branch_command(&git.path, &root, &line.remote, &line.remote_ref, name);
    reject_force(&args)?;
    let scheduled = remote_write_repo(backend, &root, generation, internal_request_id(), program, args).await?;
    if scheduled.output.exit_code != 0 {
        let text = output_text(&scheduled.output);
        let lower = text.to_ascii_lowercase();
        if lower.contains("non-fast-forward") || lower.contains("[rejected]") || text.contains("非快进") || text.contains("[已拒绝]") {
            return Err(AppError::new(
                "branch_not_fast_forward",
                format!(
                    "{name} 与 {upstream} 已经分叉（本地领先 {} 个提交），不能快进。分支保持原样；请切换到它后合并或变基。",
                    line.track.ahead
                ),
            )
            .with_generation(scheduled.generation));
        }
        if lower.contains("refusing to fetch into") || lower.contains("checked out at") {
            return Err(AppError::new(
                "branch_worktree",
                format!("{name} 正在某个工作区检出，Git 拒绝直接更新它。请在那个工作区里拉取。"),
            )
            .with_generation(scheduled.generation));
        }
        return Err(finish_remote("pull_failed", &scheduled, "拉取没有完成，分支保持原样。"));
    }
    backend.remote_checks.note(&key, now_ms());
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    }).map_err(sync_readback)
}

/// 不切换分支地推送一个本地分支：有上游时推到上游，没有上游时发布到默认远程并建立跟踪。不强推。
pub async fn push_local_branch(
    backend: &Backend,
    path: &str,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let root = repo_root(path)?;
    let key = repo_key(&root);
    let _guard = backend.actions.enter(action_key("sync", &key))?;
    validate_branch_input(name)?;
    let git = require_git(backend).await?;
    let (lines, generation) = read_tracking(backend, &root, &git.path, generation, request_id).await?;
    let Some(line) = lines.into_iter().find(|line| line.track.name == name) else {
        return Err(AppError::new("branch_missing", "没有这个本地分支，未推送。").with_generation(generation));
    };
    let (program, args) = match (&line.track.upstream, line.remote.as_str()) {
        (Some(_), remote) if !remote.is_empty() && remote != "." && !line.track.gone => {
            validate_remote_name(remote)?;
            validate_remote_ref(&line.remote_ref)?;
            crate::git::command::push_branch_to_command(&git.path, &root, remote, name, &line.remote_ref)
        }
        _ => {
            let remote = resolve_remote(backend, &root, &git.path, "", generation).await?;
            publish_command(&git.path, &root, &remote, name)
        }
    };
    reject_force(&args)?;
    let scheduled = remote_write_repo(backend, &root, generation, internal_request_id(), program, args).await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_push(
            "push_failed",
            &scheduled,
            &format!("{name} 没有推送，也没有强行推送。"),
        ));
    }
    backend.remote_checks.note(&key, now_ms());
    settle_read!(backend, &root, scheduled.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    }).map_err(sync_readback)
}

fn attach_generation(backend: &Backend, root: &Path, error: AppError) -> AppError {
    if error.generation.is_some() {
        error
    } else {
        error.with_generation(backend.scheduler.current_generation(&repo_key(root)))
    }
}

fn repo_root(path: &str) -> Result<PathBuf, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    if !root.join(".git").exists() {
        return Err(AppError::new(
            "not_repository",
            "该目录不是 Git 仓库，未执行此操作。",
        ));
    }
    Ok(root)
}

fn finish_remote(code: &str, scheduled: &ScheduledOutput, fallback: &str) -> AppError {
    let text = output_text(&scheduled.output);
    let error = if let Some(problem) = classify_problem(&text) {
        problem_error(problem, &text)
    } else {
        git_failure(code, &scheduled.output, fallback)
    };
    error.with_generation(scheduled.generation)
}

pub(super) fn push_ref_updated(output: &ProcessOutput) -> bool {
    // Only Git's porcelain status records prove an effect. '=' is already up
    // to date and '!' is a rejection. The destination is a full refname.
    output.stdout.split(|byte| *byte == b'\n').any(|line| {
        let mut fields = line.splitn(3, |byte| *byte == b'\t');
        matches!(fields.next(), Some(b" " | b"+" | b"-" | b"*"))
            && fields.next().is_some_and(|refspec| {
                refspec
                    .splitn(2, |byte| *byte == b':')
                    .nth(1)
                    .is_some_and(|target| target.starts_with(b"refs/"))
            })
            && fields.next().is_some_and(|summary| !summary.is_empty())
    })
}

fn finish_push(code: &str, scheduled: &ScheduledOutput, fallback: &str) -> AppError {
    if push_ref_updated(&scheduled.output) {
        finish_remote(code, scheduled, "还有远程引用未能更新。")
            .after_sync_effect(SyncEffect::PushRefsUpdated)
    } else if scheduled.output.stdout_truncated {
        finish_remote(code, scheduled, "推送回执不完整。").after_unconfirmed_write()
    } else {
        finish_remote(code, scheduled, fallback)
    }
}

fn clone_failure(destination: &Path, error: AppError) -> AppError {
    let residual = if destination.exists() {
        format!(
            "目标路径仍在：{}。请检查是否有未完成内容。其他目录没有被覆盖。",
            destination.display()
        )
    } else {
        "没有留下目标目录，已有文件没有被改写。".to_string()
    };
    AppError::new(error.code, format!("{} {residual}", error.message))
}

fn output_text(output: &ProcessOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

fn detached_error() -> AppError {
    AppError::new(
        "detached",
        "当前是游离 HEAD，不能推送或发布。请先创建或切换到分支。没有改写远程。",
    )
}

fn duplicate_branch() -> AppError {
    AppError::new("branch_duplicate", "已有同名分支，未再创建一个。")
}

fn short_oid(oid: &str) -> String {
    oid.chars().take(7).collect()
}

fn dir_empty(path: &Path) -> Result<bool, AppError> {
    let mut entries = fs::read_dir(path).map_err(|error| {
        AppError::new(
            "path_unreadable",
            format!(
                "无法读取克隆目标，未写入文件。{}",
                crate::redact::redact_error_text(&error.to_string())
            ),
        )
    })?;
    Ok(entries.next().is_none())
}

fn validate_clone_name(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('-')
        || name.contains(['/', '\\', '\0', '\n', '\r'])
    {
        return Err(AppError::new(
            "clone_name",
            "克隆目录名无效，未创建目标，也没有覆盖已有文件。",
        ));
    }
    Ok(())
}

fn clone_dir_name(url: &str) -> Result<String, AppError> {
    let trimmed = url.trim_end_matches(['/', '\\']);
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let name = trimmed.rsplit(['/', '\\', ':']).next().unwrap_or("");
    validate_clone_name(name)?;
    Ok(name.to_string())
}

fn validate_remote_name(name: &str) -> Result<(), AppError> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if ok {
        Ok(())
    } else {
        Err(AppError::new(
            "remote_name",
            "远程名称无效，未修改远程配置。",
        ))
    }
}

fn validate_remote_url(url: &str) -> Result<(), AppError> {
    if url.is_empty()
        || url
            .chars()
            .any(|character| character.is_whitespace() || character == '\0')
        || url.starts_with('-')
    {
        return Err(AppError::new(
            "remote_url",
            "远程地址无效，未修改配置，也没有覆盖文件。",
        ));
    }
    if contains_secret(url) {
        return Err(AppError::new(
            "remote_secret",
            "远程地址包含凭据或令牌，未写入 Git 配置。请使用系统凭据助手或 SSH agent，不要把秘密放进地址。",
        ));
    }
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git://")
        || url.starts_with("file://")
        || Path::new(url).is_absolute()
        || scp_like(url);
    if allowed {
        Ok(())
    } else {
        Err(AppError::new(
            "remote_url",
            "只接受 HTTPS、SSH、file 或本机绝对路径。未修改远程配置。",
        ))
    }
}

fn scp_like(url: &str) -> bool {
    let Some((user_host, path)) = url.split_once(':') else {
        return false;
    };
    let Some((user, host)) = user_host.split_once('@') else {
        return false;
    };
    !user.is_empty() && !host.is_empty() && !host.contains('/') && !path.is_empty()
}

fn validate_branch_input(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name.starts_with('-')
        || name
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        || name.contains(['~', '^', ':', '?', '*', '[', '\\'])
        || name.contains("..")
        || name.contains("@{")
        || name.ends_with('.')
        || name.ends_with(".lock")
    {
        return Err(AppError::new(
            "branch_invalid",
            "分支名称无效，未创建或切换分支。",
        ));
    }
    Ok(())
}

enum SwitchPlan {
    Local(String),
    Track(String),
    UpstreamMismatch { local: String, selected: String },
    Missing,
}

fn switch_plan(branches: &[BranchRecord], name: &str) -> SwitchPlan {
    if branches
        .iter()
        .any(|branch| branch.remote && branch.name == name)
    {
        // 远程行只在本地分支已经跟踪这条远程 ref 时复用短名。
        let Some((_, short)) = name.split_once('/') else {
            return SwitchPlan::Track(name.to_string());
        };
        if let Some(local) = branches
            .iter()
            .find(|branch| !branch.remote && branch.name == short)
        {
            if local.upstream.as_deref() == Some(name) {
                return SwitchPlan::Local(short.to_string());
            }
            return SwitchPlan::UpstreamMismatch {
                local: short.to_string(),
                selected: name.to_string(),
            };
        }
        return SwitchPlan::Track(name.to_string());
    }
    if branches
        .iter()
        .any(|branch| !branch.remote && branch.name == name)
    {
        return SwitchPlan::Local(name.to_string());
    }
    SwitchPlan::Missing
}

fn reject_force(args: &[OsString]) -> Result<(), AppError> {
    let forced = args.iter().any(|arg| {
        let text = arg.to_string_lossy();
        text == "--force"
            || text == "-f"
            || text == "--force-with-lease"
            || text.starts_with("--force=")
            || text.starts_with("--force-with-lease")
    });
    if forced {
        Err(AppError::new(
            "force_rejected",
            "不会强行推送，也不会强行改写分支。这次没有改写远程。",
        ))
    } else {
        Ok(())
    }
}

/// 上游是否就是「某个远程/同名分支」。只有同名时才沿用 Git 默认推送规则；
/// 否则（包括无法确定时）按上游推送，避免 `simple` 模式因名称不同而拒绝。
fn upstream_matches_branch(upstream: &str, branch: &str) -> bool {
    if branch.is_empty() {
        return false;
    }
    upstream
        .strip_suffix(branch)
        .and_then(|prefix| prefix.strip_suffix('/'))
        .is_some_and(|remote| !remote.is_empty() && !remote.contains('/'))
}

fn upstream_ref_missing(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("does not exist")
        || lower.contains("no such ref")
        || text.contains("不存在")
        || text.contains("没有这个")
}

fn protect_local_delete(state: &BranchState, root: &Path, name: &str) -> Result<(), AppError> {
    let Some(branch) = state
        .branches
        .iter()
        .find(|branch| !branch.remote && branch.name == name)
    else {
        return Err(AppError::new(
            "branch_missing",
            "没有这个本地分支，未删除。",
        ));
    };
    if branch.current || state.snapshot.branch.name.as_deref() == Some(name) {
        return Err(AppError::new(
            "branch_current",
            "不能删除当前分支。请先切换到其他分支。",
        ));
    }
    if let Some(worktree) = &branch.worktree {
        if !same_worktree(worktree, root) {
            return Err(AppError::new(
                "branch_worktree",
                format!("该分支正被工作区占用，未删除。工作区路径：{worktree}"),
            ));
        }
    }
    Ok(())
}

fn same_worktree(worktree: &str, root: &Path) -> bool {
    let path = Path::new(worktree);
    match (dunce::canonicalize(path), dunce::canonicalize(root)) {
        (Ok(left), Ok(right)) => left == right,
        _ => path == root,
    }
}

struct RemotePair {
    name: String,
    fetch: String,
    push: Option<String>,
}

impl RemotePair {
    fn present(self) -> RemoteInfo {
        let fetch_url = redact(&self.fetch);
        let push_url = self
            .push
            .map(|url| redact(&url))
            .filter(|url| url != &fetch_url);
        RemoteInfo {
            name: self.name,
            fetch_url,
            push_url,
        }
    }
}

fn parse_remote_pairs(bytes: &[u8]) -> Result<Vec<RemotePair>, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("remote_encoding", "远程地址无法安全解码，未修改配置。"))?;
    let mut pairs: Vec<RemotePair> = Vec::new();
    for line in text.lines() {
        let Some((name, rest)) = line.split_once('\t').or_else(|| line.split_once(' ')) else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let (url, fetch) = if let Some(url) = rest.strip_suffix(" (fetch)") {
            (url.trim(), true)
        } else if let Some(url) = rest.strip_suffix(" (push)") {
            (url.trim(), false)
        } else {
            continue;
        };
        if let Some(existing) = pairs.iter_mut().find(|remote| remote.name == name) {
            if fetch {
                existing.fetch = url.to_string();
            } else {
                existing.push = Some(url.to_string());
            }
        } else {
            pairs.push(RemotePair {
                name: name.to_string(),
                fetch: if fetch {
                    url.to_string()
                } else {
                    String::new()
                },
                push: if fetch { None } else { Some(url.to_string()) },
            });
        }
    }
    Ok(pairs)
}

enum OriginHead {
    Missing,
    /// 有 `origin/HEAD`，但指不到一个本地分支名。此时不再退回 main/master/develop。
    Unreadable,
    Local(String),
}

struct ParsedBranchList {
    branches: Vec<BranchRecord>,
    origin_head: OriginHead,
}

fn local_name_from_origin_head(symref: &str) -> Option<String> {
    let trimmed = symref.trim();
    let name = trimmed
        .strip_prefix("refs/remotes/origin/")
        .or_else(|| trimmed.strip_prefix("origin/"))?;
    if name.is_empty() || name == "HEAD" || name.ends_with("/HEAD") {
        None
    } else {
        Some(name.to_string())
    }
}

fn choose_default_branch(branches: &[BranchRecord], origin_head: &OriginHead) -> Option<String> {
    let named = |name: &str| {
        branches
            .iter()
            .find(|branch| !branch.remote && branch.name == name)
            .map(|branch| branch.name.clone())
    };
    match origin_head {
        OriginHead::Local(name) => named(name),
        OriginHead::Unreadable => None,
        OriginHead::Missing => ["main", "master", "develop"].into_iter().find_map(named),
    }
}

fn parse_branches(bytes: &[u8]) -> Result<ParsedBranchList, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("branch_encoding", "分支名称无法安全解码，未修改仓库。"))?;
    let mut branches = Vec::new();
    let mut origin_head = OriginHead::Missing;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\u{1f}');
        let Some(refname) = parts.next() else {
            continue;
        };
        let upstream = parts.next().unwrap_or("");
        let worktree = parts.next().unwrap_or("");
        let head = parts.next().unwrap_or("");
        let target_oid = parts
            .next()
            .filter(|oid| !oid.is_empty())
            .map(str::to_string);
        let symref = parts.next().unwrap_or("");
        let (name, remote) = if let Some(short) = refname.strip_prefix("refs/remotes/") {
            if short == "origin/HEAD" {
                origin_head = match local_name_from_origin_head(symref) {
                    Some(local) => OriginHead::Local(local),
                    None => OriginHead::Unreadable,
                };
                continue;
            }
            if short.ends_with("/HEAD") {
                continue;
            }
            (short, true)
        } else if let Some(short) = refname.strip_prefix("refs/heads/") {
            (short, false)
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        branches.push(BranchRecord {
            merged: false,
            target_oid,
            name: name.to_string(),
            remote,
            current: !remote && head.trim() == "*",
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            worktree: if worktree.is_empty() {
                None
            } else {
                Some(worktree.to_string())
            },
        });
    }
    Ok(ParsedBranchList {
        branches,
        origin_head,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::process::Command;

    use crate::git::changes::stage_files;
    use crate::git::ops::{add_repository, refresh_status};

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "{args:?} in {}", dir.display());
    }

    fn git_text(dir: &Path, args: &[&str]) -> String {
        let output = Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?} {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn seed_bare(fixture: &crate::test_support::GitFixture) -> (PathBuf, PathBuf) {
        let seed = fixture.repo("seed");
        git(&seed, &["init", "-b", "main"]);
        fs::write(seed.join("file.txt"), "base\n").unwrap();
        git(&seed, &["add", "--", "file.txt"]);
        git(&seed, &["commit", "-m", "base"]);
        let origin = fixture.path().join("origin.git");
        git(
            fixture.path(),
            &["clone", "--bare", repo_key(&seed).as_str(), "origin.git"],
        );
        let work = fixture.path().join("work");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "work"],
        );
        (origin, work)
    }

    /// 本机监听一个端口，记下 Git 发来的第一份 HTTP 请求头并回 401。
    fn capture_http_once() -> (u16, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            String::from_utf8_lossy(&request).into_owned()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn http_clone_sends_credential_only_as_scoped_header_and_explains_rejection() {
        use base64::Engine;
        let fixture = crate::test_support::git_fixture("clone-http-auth");
        let backend = fixture.backend();
        let parent = fixture.repo("parent");

        let (port, server) = capture_http_once();
        let url = format!("http://127.0.0.1:{port}/group/app.git");
        let plain = clone_repository(&backend, &url, &repo_key(&parent), "plain", None, 1)
            .await
            .unwrap_err();
        let request = server.join().unwrap();
        assert!(!request.to_ascii_lowercase().contains("authorization:"), "{request}");
        assert_eq!(plain.code, "auth", "{}", plain.message);

        let (port, server) = capture_http_once();
        let url = format!("http://127.0.0.1:{port}/group/app.git");
        let credential = HttpCredential { username: "alice".into(), password: "s3cret-token".into(), remember: true };
        let rejected = clone_repository(&backend, &url, &repo_key(&parent), "with-auth", Some(&credential), 2)
            .await
            .unwrap_err();
        let request = server.join().unwrap();
        let expected = base64::engine::general_purpose::STANDARD.encode("alice:s3cret-token");
        assert!(request.contains(&format!("Authorization: Basic {expected}")), "{request}");
        assert_eq!(rejected.code, "auth");
        assert!(rejected.message.contains("用户名和密码"), "{}", rejected.message);
        assert!(!rejected.message.contains("s3cret-token"));
        assert!(!parent.join("with-auth").exists(), "失败的克隆不留下目录");
        let state = std::fs::read_to_string(fixture.path().join("state.json")).unwrap_or_default();
        assert!(!state.contains("s3cret-token"), "凭据不进应用数据");

        // SSH / 本机地址不接受用户名密码，直接拒绝，不启动克隆。
        let local = fixture.repo("local");
        let refused = clone_repository(&backend, &repo_key(&local), &repo_key(&parent), "x", Some(&credential), 3)
            .await
            .unwrap_err();
        assert_eq!(refused.code, "credential_scheme");
    }

    #[tokio::test]
    async fn clone_opens_new_directory_and_refuses_to_overwrite() {
        let fixture = crate::test_support::git_fixture("clone-safe");
        let backend = fixture.backend();
        let (origin, _work) = seed_bare(&fixture);
        let parent = fixture.path().join("destinations");
        fs::create_dir(&parent).unwrap();
        let occupied = parent.join("occupied");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), b"keep").unwrap();
        let refused = clone_repository(
            &backend,
            &repo_key(&origin),
            &repo_key(&parent),
            "occupied",
            None,
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "clone_destination");
        assert_eq!(fs::read(occupied.join("keep.txt")).unwrap(), b"keep");
        assert!(!occupied.join(".git").exists());

        let secret = clone_repository(
            &backend,
            "https://user:ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/acme/app.git",
            &repo_key(&parent),
            "secret-dest",
            None,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(secret.code, "remote_secret");
        assert!(!secret
            .message
            .contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));
        assert!(!parent.join("secret-dest").exists());

        let cloned = clone_repository(
            &backend,
            &repo_key(&origin),
            &repo_key(&parent),
            "copied",
            None,
            3,
        )
        .await
        .unwrap();
        assert_eq!(cloned.opened.snapshot.branch.name.as_deref(), Some("main"));
        assert_eq!(
            fs::read(parent.join("copied").join("file.txt")).unwrap(),
            b"base\n"
        );
        assert_eq!(
            cloned.opened.summary.path,
            repo_key(&canonical_existing(&parent.join("copied")).unwrap())
        );
    }

    #[tokio::test]
    async fn failed_clone_reports_the_residual_path() {
        let fixture = crate::test_support::git_fixture("clone-fail");
        let backend = fixture.backend();
        let parent = fixture.path().join("parent");
        fs::create_dir(&parent).unwrap();
        // Exercise a path alias even when TEMP does not use Windows 8.3 names.
        let parent = parent.join(".");
        let sibling = parent.join("sibling.txt");
        fs::write(&sibling, b"same").unwrap();
        let destination = parent.join("residual");
        fs::create_dir(&destination).unwrap();
        let expected_destination = canonical_existing(&destination).unwrap();
        let error = clone_repository(
            &backend,
            "https://127.0.0.1:9/nope.git",
            &repo_key(&parent),
            "residual",
            None,
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "network");
        assert!(
            error
                .message
                .contains(&expected_destination.display().to_string()),
            "{}",
            error.message
        );
        assert!(error.message.contains("重试"));
        assert!(destination.is_dir());
        assert_eq!(fs::read(&sibling).unwrap(), b"same");

        let missing = parent.join("missing-origin");
        let gone = clone_repository(
            &backend,
            &repo_key(&missing),
            &repo_key(&parent),
            "no-residual",
            None,
            2,
        )
        .await
        .unwrap_err();
        assert!(!parent.join("no-residual").exists());
        assert!(gone.message.contains("没有留下目标目录"));
    }

    #[tokio::test]
    async fn remote_url_matches_git_and_existing_secrets_are_hidden() {
        let fixture = crate::test_support::git_fixture("remote-url");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let listed = remote_state(&backend, &opened.summary.path, opened.generation, 2)
            .await
            .unwrap();
        assert_eq!(listed.remotes[0].name, "origin");
        assert_eq!(listed.remotes[0].fetch_url, repo_key(&origin));
        let replacement = fixture.path().join("other.git");
        git(
            fixture.path(),
            &["clone", "--bare", repo_key(&origin).as_str(), "other.git"],
        );
        let updated = set_remote_url(
            &backend,
            &opened.summary.path,
            "origin",
            &repo_key(&replacement),
            listed.generation,
            3,
        )
        .await
        .unwrap();
        assert_eq!(updated.remotes[0].fetch_url, repo_key(&replacement));
        assert_eq!(
            git_text(&work, &["remote", "get-url", "origin"]),
            repo_key(&replacement)
        );
        let secret = "https://user:ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/acme/app.git";
        let rejected = set_remote_url(
            &backend,
            &opened.summary.path,
            "origin",
            secret,
            updated.generation,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.code, "remote_secret");
        assert!(!rejected
            .message
            .contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));
        assert_eq!(
            git_text(&work, &["remote", "get-url", "origin"]),
            repo_key(&replacement)
        );
        git(&work, &["remote", "set-url", "origin", secret]);
        let hidden = remote_state(&backend, &opened.summary.path, updated.generation, 5)
            .await
            .unwrap();
        let shown = &hidden.remotes[0].fetch_url;
        assert!(!shown.contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));
        assert!(shown.contains("[redacted]"));
    }

    #[tokio::test]
    async fn fetch_does_not_touch_worktree_and_fast_forward_pull_refreshes() {
        let fixture = crate::test_support::git_fixture("fetch-pull");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        let other = fixture.path().join("other");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "other"],
        );
        fs::write(other.join("file.txt"), "base\nupstream\n").unwrap();
        git(&other, &["commit", "-am", "upstream"]);
        git(&other, &["push"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let before = fs::read(work.join("file.txt")).unwrap();
        let head = git_text(&work, &["rev-parse", "HEAD"]);
        let fetched = fetch_remote(&backend, &opened.summary.path, opened.generation, 2)
            .await
            .unwrap();
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), before);
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), head);
        assert_eq!(fetched.branch.behind, Some(1));
        assert!(fetched.branch.live_remote_checked);
        assert!(!fetched.branch.remote_check_stale);
        assert!(fetched.branch.remote_checked_at_ms.is_some());
        let pulled = pull_fast_forward(&backend, &opened.summary.path, fetched.generation, 3)
            .await
            .unwrap();
        assert_eq!(
            fs::read(work.join("file.txt")).unwrap(),
            b"base\nupstream\n"
        );
        assert_eq!(pulled.branch.behind, Some(0));
        assert_eq!(pulled.branch.ahead, Some(0));
        assert_eq!(
            git_text(&work, &["log", "-1", "--format=%P"])
                .split_whitespace()
                .count(),
            1,
            "快进不创建合并提交"
        );
        assert!(pulled.branch.live_remote_checked);
        backend.remote_checks.note(&opened.summary.path, 1);
        let stale = refresh_status(&backend, &opened.summary.path, pulled.generation, 4)
            .await
            .unwrap();
        assert!(stale.branch.remote_check_stale);
        assert!(!stale.branch.live_remote_checked);
        assert_eq!(stale.branch.remote_checked_at_ms, Some(1));
    }

    #[tokio::test]
    async fn divergence_is_not_merged_or_force_pushed_and_duplicate_sync_is_rejected() {
        let fixture = crate::test_support::git_fixture("diverge");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        let other = fixture.path().join("other");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "other"],
        );
        fs::write(other.join("file.txt"), "base\nupstream\n").unwrap();
        git(&other, &["commit", "-am", "upstream"]);
        git(&other, &["push"]);
        fs::write(work.join("file.txt"), "base\nlocal\n").unwrap();
        git(&work, &["commit", "-am", "local"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let before = fs::read(work.join("file.txt")).unwrap();
        let head = git_text(&work, &["rev-parse", "HEAD"]);
        let origin_head = git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "rev-parse", "main"],
        );
        let pulled = pull_fast_forward(&backend, &opened.summary.path, opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(pulled.code, "diverged");
        assert!(pulled.message.contains("合并"));
        assert!(pulled.message.contains("变基"));
        assert!(pulled.message.contains("当前分支没有移动"));
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), before);
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), head);
        let pushed = push_branch(
            &backend,
            &opened.summary.path,
            pulled.generation.unwrap(),
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(pushed.code, "push_rejected");
        assert!(pushed.message.contains("没有强行推送"));
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            origin_head
        );
        let _held = backend
            .actions
            .enter(action_key("sync", &opened.summary.path))
            .unwrap();
        let duplicate = fetch_remote(
            &backend,
            &opened.summary.path,
            pushed.generation.unwrap(),
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(duplicate.code, "duplicate");
    }

    #[tokio::test]
    async fn detached_pull_keeps_the_existing_explanation() {
        let fixture = crate::test_support::git_fixture("detached-pull");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "--detach"]);
        let opened = add_repository(&backend, &repo_key(&repo), 1).await.unwrap();
        let head = git_text(&repo, &["rev-parse", "HEAD"]);
        let pulled = pull_fast_forward(&backend, &opened.summary.path, opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(pulled.code, "detached");
        assert!(pulled.message.contains("游离"));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "base\n");
    }

    #[tokio::test]
    async fn publish_sets_upstream_and_commit_push_retries_only_the_push() {
        let fixture = crate::test_support::git_fixture("publish-push");
        let backend = fixture.backend();
        let origin = fixture.path().join("origin.git");
        git(
            fixture.path(),
            &["init", "--bare", "-b", "main", "origin.git"],
        );
        let work = fixture.repo("local");
        git(&work, &["init", "-b", "main"]);
        fs::write(work.join("file.txt"), "one\n").unwrap();
        git(&work, &["add", "--", "file.txt"]);
        git(&work, &["commit", "-m", "one"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let added = add_remote(
            &backend,
            &opened.summary.path,
            "origin",
            &repo_key(&origin),
            opened.generation,
            2,
        )
        .await
        .unwrap();
        assert!(added.snapshot.branch.upstream.is_none());
        let published = publish_branch(
            &backend,
            &opened.summary.path,
            "origin",
            added.generation,
            3,
        )
        .await
        .unwrap();
        assert_eq!(published.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            git_text(&work, &["rev-parse", "HEAD"])
        );
        fs::write(work.join("file.txt"), "one\ntwo\n").unwrap();
        let staged = stage_files(
            &backend,
            &opened.summary.path,
            &["file.txt".into()],
            published.generation,
            4,
        )
        .await
        .unwrap();
        let report = commit_and_push(&backend, &opened.summary.path, "two", staged.generation, 5)
            .await
            .unwrap();
        assert!(report.committed);
        assert!(report.pushed);
        assert!(!report.retry_push);
        assert!(report.summary.contains("推送已完成"));
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            report.oid
        );
        let other = fixture.path().join("other");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "other"],
        );
        fs::write(other.join("file.txt"), "one\nupstream\n").unwrap();
        git(&other, &["commit", "-am", "upstream"]);
        git(&other, &["push"]);
        fs::write(work.join("file.txt"), "one\ntwo\nlocal\n").unwrap();
        let staged = stage_files(
            &backend,
            &opened.summary.path,
            &["file.txt".into()],
            report.generation,
            6,
        )
        .await
        .unwrap();
        let failed = commit_and_push(
            &backend,
            &opened.summary.path,
            "local only",
            staged.generation,
            7,
        )
        .await
        .unwrap();
        assert!(failed.committed);
        assert!(!failed.pushed);
        assert!(failed.retry_push);
        assert!(failed.push_error.unwrap().contains("没有强行推送"));
        let commits = git_text(&work, &["rev-list", "--count", "HEAD"]);
        let origin_head = git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "rev-parse", "main"],
        );
        let again = push_branch(&backend, &opened.summary.path, failed.generation, 8)
            .await
            .unwrap_err();
        assert_eq!(again.code, "push_rejected");
        assert_eq!(git_text(&work, &["rev-list", "--count", "HEAD"]), commits);
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            origin_head
        );
        assert_ne!(origin_head, failed.oid);
        let empty = commit_and_push(&backend, &opened.summary.path, "   ", failed.generation, 9)
            .await
            .unwrap_err();
        assert_eq!(empty.code, "empty_message");
        assert_eq!(git_text(&work, &["rev-list", "--count", "HEAD"]), commits);
    }

    #[tokio::test]
    async fn branches_are_created_switched_and_protected() {
        let fixture = crate::test_support::git_fixture("branches");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let invalid = create_branch(
            &backend,
            &opened.summary.path,
            "bad..name",
            opened.generation,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(invalid.code, "branch_invalid");
        assert!(!git_text(&work, &["branch", "--list"]).contains("bad..name"));
        let created = create_branch(
            &backend,
            &opened.summary.path,
            "feature",
            opened.generation,
            3,
        )
        .await
        .unwrap();
        assert!(created
            .branches
            .iter()
            .any(|branch| branch.name == "feature" && !branch.remote));
        assert_eq!(created.snapshot.branch.name.as_deref(), Some("main"));
        let duplicate = create_branch(
            &backend,
            &opened.summary.path,
            "feature",
            created.generation,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(duplicate.code, "branch_duplicate");
        let switched = switch_branch(
            &backend,
            &opened.summary.path,
            "feature",
            created.generation,
            5,
        )
        .await
        .unwrap();
        assert_eq!(switched.snapshot.branch.name.as_deref(), Some("feature"));
        fs::write(work.join("file.txt"), "changed\n").unwrap();
        git(&work, &["commit", "-am", "feature work"]);
        let back = switch_branch(
            &backend,
            &opened.summary.path,
            "main",
            switched.generation,
            6,
        )
        .await
        .unwrap();
        fs::write(work.join("file.txt"), "dirty\n").unwrap();
        let blocked = switch_branch(
            &backend,
            &opened.summary.path,
            "feature",
            back.generation,
            7,
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.code, "local_changes");
        assert!(blocked.message.contains("临时保存"));
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"dirty\n");
        assert_eq!(git_text(&work, &["branch", "--show-current"]), "main");
        fs::write(work.join("file.txt"), "base\n").unwrap();
        let generation = blocked.generation.expect("switch failure generation");
        let current = delete_branch(&backend, &opened.summary.path, "main", false, generation, 8)
            .await
            .unwrap_err();
        assert_eq!(current.code, "branch_current");
        let unmerged = delete_branch(
            &backend,
            &opened.summary.path,
            "feature",
            false,
            generation,
            9,
        )
        .await
        .unwrap_err();
        assert_eq!(unmerged.code, "branch_unmerged");
        assert!(git_text(&work, &["branch", "--list"]).contains("feature"));
        let removed = delete_branch(
            &backend,
            &opened.summary.path,
            "feature",
            true,
            unmerged.generation.expect("delete failure generation"),
            10,
        )
        .await
        .unwrap();
        assert!(!removed
            .branches
            .iter()
            .any(|branch| !branch.remote && branch.name == "feature"));
        git(&work, &["branch", "occupied"]);
        let linked = fixture.path().join("linked");
        git(
            &work,
            &["worktree", "add", repo_key(&linked).as_str(), "occupied"],
        );
        let protected = delete_branch(
            &backend,
            &opened.summary.path,
            "occupied",
            true,
            removed.generation,
            11,
        )
        .await
        .unwrap_err();
        assert_eq!(protected.code, "branch_worktree");
        assert!(
            protected.message.contains(&linked.display().to_string())
                || protected.message.contains("linked")
        );
        assert!(git_text(&work, &["branch", "--list"]).contains("occupied"));
    }

    #[tokio::test]
    async fn remote_branch_delete_requires_confirmation_and_preserves_tag_on_repeat() {
        let fixture = crate::test_support::git_fixture("remote-branch");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        git(&work, &["push", "origin", "HEAD:refs/heads/topic", "HEAD:refs/tags/topic"]);
        let tag = git_text(&origin, &["rev-parse", "refs/tags/topic"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let held = delete_remote_branch(
            &backend,
            &opened.summary.path,
            "origin",
            "topic",
            false,
            opened.generation,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(held.code, "confirm_required");
        assert_eq!(git_text(&origin, &["rev-parse", "refs/heads/topic"]), tag);
        let removed = delete_remote_branch(
            &backend,
            &opened.summary.path,
            "origin",
            "topic",
            true,
            opened.generation,
            3,
        )
        .await
        .unwrap();
        assert!(git_text(&origin, &["branch", "--list", "topic"]).is_empty());
        assert!(!removed
            .branches
            .iter()
            .any(|branch| branch.remote && branch.name == "origin/topic"));

        // 模拟远程已删除、客户端仍持有旧跟踪引用的状态。
        git(&work, &["update-ref", "refs/remotes/origin/topic", "HEAD"]);
        let removed = delete_remote_branch(
            &backend,
            &opened.summary.path,
            "origin",
            "topic",
            true,
            removed.generation,
            4,
        )
        .await
        .unwrap();
        assert!(!removed
            .branches
            .iter()
            .any(|branch| branch.remote && branch.name == "origin/topic"));
        assert_eq!(git_text(&origin, &["rev-parse", "refs/tags/topic"]), tag);
    }

    #[tokio::test]
    async fn fetch_branches_returns_discovered_and_pruned_refs_with_current_snapshot() {
        let fixture = crate::test_support::git_fixture("fetch-branches");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        git(&origin, &["branch", "new-topic", "main"]);
        git(&work, &["update-ref", "refs/remotes/origin/old-topic", "HEAD"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let state = fetch_branches(&backend, &opened.summary.path, opened.generation, 2).await.unwrap();
        assert!(state.branches.iter().any(|b| b.remote && b.name == "origin/new-topic"));
        assert!(!state.branches.iter().any(|b| b.remote && b.name == "origin/old-topic"));
        assert_eq!(state.snapshot.generation, state.generation);
    }

    #[tokio::test]
    async fn push_to_named_remote_reaches_the_second_remote_without_moving_upstream() {
        let fixture = crate::test_support::git_fixture("push-second-remote");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        git(
            fixture.path(),
            &["clone", "--bare", repo_key(&work).as_str(), "mirror.git"],
        );
        let mirror = fixture.path().join("mirror.git");
        git(&work, &["remote", "add", "mirror", repo_key(&mirror).as_str()]);
        fs::write(work.join("file.txt"), "next\n").unwrap();
        git(&work, &["commit", "-am", "next"]);
        let head = git_text(&work, &["rev-parse", "HEAD"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let missing = push_to_remote(&backend, &opened.summary.path, "nowhere", opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "remote_missing");
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        let pushed = push_to_remote(&backend, &opened.summary.path, "mirror", generation, 3)
            .await
            .unwrap();
        assert_eq!(
            git_text(fixture.path(), &["--git-dir", "mirror.git", "rev-parse", "main"]).trim(),
            head.trim()
        );
        // 上游仍是 origin/main，origin 没有收到这次推送。
        assert_eq!(pushed.branch.upstream.as_deref(), Some("origin/main"));
        assert_ne!(
            git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "main"]).trim(),
            head.trim()
        );
        // 没有进行中的远程操作时取消不报错，也不影响随后的推送。
        cancel_remote(&backend, &opened.summary.path).unwrap();
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        push_branch(&backend, &opened.summary.path, generation, 4).await.unwrap();
        assert_eq!(
            git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "main"]).trim(),
            head.trim()
        );
    }

    #[tokio::test]
    async fn remote_short_name_taken_can_be_checked_out_under_a_new_name() {
        let fixture = crate::test_support::git_fixture("track-as");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        git(&work, &["remote", "add", "upstream", repo_key(&origin).as_str()]);
        git(&work, &["fetch", "upstream"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let held = switch_branch(&backend, &opened.summary.path, "upstream/main", opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(held.code, "branch_upstream_mismatch");
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        let taken = track_remote_as(&backend, &opened.summary.path, "upstream/main", "main", generation, 3)
            .await
            .unwrap_err();
        assert_eq!(taken.code, "branch_duplicate");
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        let state = track_remote_as(&backend, &opened.summary.path, "upstream/main", "upstream-main", generation, 4)
            .await
            .unwrap();
        assert_eq!(state.snapshot.branch.name.as_deref(), Some("upstream-main"));
        assert_eq!(state.snapshot.branch.upstream.as_deref(), Some("upstream/main"));
        let main = state.branches.iter().find(|branch| !branch.remote && branch.name == "main").unwrap();
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    }

    fn record(name: &str, remote: bool, upstream: Option<&str>) -> BranchRecord {
        BranchRecord {
            name: name.to_string(),
            remote,
            current: false,
            upstream: upstream.map(str::to_string),
            worktree: None,
            target_oid: None,
            merged: false,
        }
    }

    #[test]
    fn remote_switch_reuses_local_only_when_upstream_matches() {
        let branches = vec![
            record("feature", false, None),
            record("origin/feature", true, None),
            record("tracked", false, Some("origin/tracked")),
            record("origin/tracked", true, None),
            record("origin/fresh", true, None),
            record("other", false, Some("upstream/other")),
            record("upstream/other", true, None),
            record("origin/other", true, None),
            record("origin/feature", false, None),
        ];
        assert!(
            matches!(switch_plan(&branches, "feature"), SwitchPlan::Local(name) if name == "feature")
        );
        assert!(matches!(
            switch_plan(&branches, "origin/feature"),
            SwitchPlan::UpstreamMismatch { local, selected }
                if local == "feature" && selected == "origin/feature"
        ));
        assert!(
            matches!(switch_plan(&branches, "origin/tracked"), SwitchPlan::Local(name) if name == "tracked")
        );
        assert!(
            matches!(switch_plan(&branches, "origin/fresh"), SwitchPlan::Track(name) if name == "origin/fresh")
        );
        assert!(matches!(
            switch_plan(&branches, "origin/other"),
            SwitchPlan::UpstreamMismatch { local, .. } if local == "other"
        ));
        assert!(
            matches!(switch_plan(&branches, "upstream/other"), SwitchPlan::Local(name) if name == "other")
        );
        assert!(matches!(
            switch_plan(&branches, "missing"),
            SwitchPlan::Missing
        ));
        let exact_name = vec![
            record("origin/feature", true, None),
            record("origin/feature", false, Some("origin/main")),
        ];
        assert!(matches!(
            switch_plan(&exact_name, "origin/feature"),
            SwitchPlan::Track(name) if name == "origin/feature"
        ));
        let forced = vec![OsString::from("branch"), OsString::from("--force")];
        assert_eq!(reject_force(&forced).unwrap_err().code, "force_rejected");
        assert!(reject_force(&[OsString::from("--force-with-lease")]).is_err());
    }

    #[tokio::test]
    async fn remote_switch_does_not_move_head_onto_unrelated_local_branch() {
        let fixture = crate::test_support::git_fixture("remote-switch");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        let other = fixture.path().join("other");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "other"],
        );
        git(&other, &["switch", "-c", "feature"]);
        fs::write(other.join("feature.txt"), "remote-b\n").unwrap();
        git(&other, &["add", "--", "feature.txt"]);
        git(&other, &["commit", "-m", "remote feature"]);
        git(&other, &["push", "-u", "origin", "feature"]);
        git(&work, &["fetch", "origin"]);
        git(&work, &["branch", "feature"]);
        let main_oid = git_text(&work, &["rev-parse", "HEAD"]);
        let local_feature = git_text(&work, &["rev-parse", "feature"]);
        let remote_feature = git_text(&work, &["rev-parse", "origin/feature"]);
        assert_eq!(local_feature, main_oid);
        assert_ne!(local_feature, remote_feature);
        fs::write(work.join("file.txt"), "base\ndirty\n").unwrap();
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let blocked = switch_branch(
            &backend,
            &opened.summary.path,
            "origin/feature",
            opened.generation,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.code, "branch_upstream_mismatch");
        assert!(blocked.message.contains("origin/feature"));
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), main_oid);
        assert_eq!(git_text(&work, &["branch", "--show-current"]), "main");
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"base\ndirty\n");
        assert!(!work.join("feature.txt").exists());

        fs::write(work.join("file.txt"), "base\n").unwrap();
        git(
            &work,
            &["branch", "--set-upstream-to=origin/main", "feature"],
        );
        let wrong_upstream = switch_branch(
            &backend,
            &opened.summary.path,
            "origin/feature",
            blocked.generation.expect("mismatch generation"),
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(wrong_upstream.code, "branch_upstream_mismatch");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), main_oid);
        assert!(!work.join("feature.txt").exists());

        git(
            &work,
            &["branch", "--set-upstream-to=origin/feature", "feature"],
        );
        let switched = switch_branch(
            &backend,
            &opened.summary.path,
            "origin/feature",
            wrong_upstream
                .generation
                .expect("second mismatch generation"),
            4,
        )
        .await
        .unwrap();
        assert_eq!(switched.snapshot.branch.name.as_deref(), Some("feature"));
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), local_feature);
        assert_ne!(git_text(&work, &["rev-parse", "HEAD"]), remote_feature);
        assert!(!work.join("feature.txt").exists());
        let back = switch_branch(
            &backend,
            &opened.summary.path,
            "main",
            switched.generation,
            5,
        )
        .await
        .unwrap();
        git(&work, &["branch", "-D", "feature"]);
        let tracked = switch_branch(
            &backend,
            &opened.summary.path,
            "origin/feature",
            back.generation,
            6,
        )
        .await
        .unwrap();
        assert_eq!(tracked.snapshot.branch.name.as_deref(), Some("feature"));
        assert_eq!(
            tracked.snapshot.branch.upstream.as_deref(),
            Some("origin/feature")
        );
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), remote_feature);
        assert_eq!(fs::read(work.join("feature.txt")).unwrap(), b"remote-b\n");
    }

    fn upstream_configured(dir: &Path) -> bool {
        Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args([
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .output()
            .unwrap()
            .status
            .success()
    }

    #[tokio::test]
    async fn rejected_publish_associates_without_push_then_fast_forwards() {
        let fixture = crate::test_support::git_fixture("associate-ff");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        git(&work, &["branch", "--unset-upstream"]);
        let other = fixture.path().join("other");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "other"],
        );
        fs::write(other.join("file.txt"), "base\nremote\n").unwrap();
        git(&other, &["commit", "-am", "remote"]);
        git(&other, &["push"]);
        let remote_oid = git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "rev-parse", "main"],
        );
        let local_oid = git_text(&work, &["rev-parse", "HEAD"]);
        assert_ne!(local_oid, remote_oid);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        assert!(opened.snapshot.branch.upstream.is_none());
        let published = publish_branch(&backend, &opened.summary.path, "", opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(published.code, "push_rejected");
        assert!(published.message.contains("只关联上游"));
        assert!(published.message.contains("快进拉取"));
        assert!(published.message.contains("没有强行推送"));
        assert!(!published.message.contains("请先拉取或合并"));
        assert!(!upstream_configured(&work));
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            remote_oid
        );
        let pulled = pull_fast_forward(
            &backend,
            &opened.summary.path,
            published.generation.expect("publish generation"),
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(pulled.code, "no_upstream");
        assert!(pulled.message.contains("只关联上游"));
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"base\n");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), local_oid);
        let retried = push_branch(
            &backend,
            &opened.summary.path,
            pulled.generation.expect("pull generation"),
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(retried.code, "push_rejected");
        assert_ne!(retried.code, "no_upstream");
        assert_eq!(git_text(&work, &["rev-list", "--count", "HEAD"]), "1");
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            remote_oid
        );
        let associated = associate_upstream(
            &backend,
            &opened.summary.path,
            "",
            retried.generation.expect("retry generation"),
            5,
        )
        .await
        .unwrap();
        assert_eq!(associated.branch.upstream.as_deref(), Some("origin/main"));
        assert!(associated.branch.live_remote_checked);
        assert_eq!(associated.branch.behind, Some(1));
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"base\n");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), local_oid);
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            remote_oid
        );
        let forwarded = pull_fast_forward(&backend, &opened.summary.path, associated.generation, 6)
            .await
            .unwrap();
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"base\nremote\n");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), remote_oid);
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            remote_oid
        );
        assert_eq!(forwarded.branch.ahead, Some(0));
        assert_eq!(forwarded.branch.behind, Some(0));
    }

    #[tokio::test]
    async fn associate_does_not_merge_or_force_when_histories_diverge() {
        let fixture = crate::test_support::git_fixture("associate-diverge");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        git(&work, &["branch", "--unset-upstream"]);
        let other = fixture.path().join("other");
        git(
            fixture.path(),
            &["clone", repo_key(&origin).as_str(), "other"],
        );
        fs::write(other.join("file.txt"), "base\nremote\n").unwrap();
        git(&other, &["commit", "-am", "remote"]);
        git(&other, &["push"]);
        fs::write(work.join("file.txt"), "base\nlocal\n").unwrap();
        git(&work, &["commit", "-am", "local"]);
        let remote_oid = git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "rev-parse", "main"],
        );
        let local_oid = git_text(&work, &["rev-parse", "HEAD"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let published = publish_branch(&backend, &opened.summary.path, "", opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(published.code, "push_rejected");
        assert!(!upstream_configured(&work));
        let associated = associate_upstream(
            &backend,
            &opened.summary.path,
            "origin",
            published.generation.expect("publish generation"),
            3,
        )
        .await
        .unwrap();
        assert_eq!(associated.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"base\nlocal\n");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), local_oid);
        let diverged = pull_fast_forward(&backend, &opened.summary.path, associated.generation, 4)
            .await
            .unwrap_err();
        assert_eq!(diverged.code, "diverged");
        assert!(diverged.message.contains("合并"));
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), b"base\nlocal\n");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), local_oid);
        assert_eq!(
            git_text(
                fixture.path(),
                &["--git-dir", "origin.git", "rev-parse", "main"]
            ),
            remote_oid
        );
    }

    #[tokio::test]
    async fn associate_refuses_missing_remote_branch_without_pushing() {
        let fixture = crate::test_support::git_fixture("associate-missing");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        git(&work, &["branch", "--unset-upstream"]);
        git(&work, &["switch", "-c", "topic"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let missing = associate_upstream(
            &backend,
            &opened.summary.path,
            "origin",
            opened.generation,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(missing.code, "upstream_missing");
        assert!(!missing.message.contains("强行推送已"));
        assert!(!upstream_configured(&work));
        assert!(!git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "branch", "--list"]
        )
        .contains("topic"));
        assert_eq!(git_text(&work, &["branch", "--show-current"]), "topic");
        let broken = fixture.path().join("not-a-repo");
        git(
            &work,
            &["remote", "set-url", "origin", repo_key(&broken).as_str()],
        );
        let failed = associate_upstream(
            &backend,
            &opened.summary.path,
            "origin",
            missing.generation.expect("missing generation"),
            3,
        )
        .await
        .unwrap_err();
        assert_ne!(failed.code, "upstream_unconfirmed");
        assert!(!upstream_configured(&work));
        assert_eq!(
            git_text(&work, &["rev-parse", "HEAD"]),
            git_text(&work, &["rev-parse", "topic"])
        );
    }

    #[tokio::test]
    async fn set_upstream_to_differently_named_branch_and_push_reaches_it() {
        let fixture = crate::test_support::git_fixture("upstream-rename");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        git(&work, &["push", "origin", "main:develop"]);
        git(&work, &["fetch", "origin"]);
        git(&work, &["switch", "-c", "topic"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let missing = set_upstream(&backend, &opened.summary.path, "origin/nowhere", opened.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "upstream_missing");
        let invalid = set_upstream(&backend, &opened.summary.path, "-origin/x", opened.generation, 3)
            .await
            .unwrap_err();
        assert_eq!(invalid.code, "upstream_invalid");
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        let changed = set_upstream(&backend, &opened.summary.path, "origin/develop", generation, 4)
            .await
            .unwrap();
        assert_eq!(changed.snapshot.branch.upstream.as_deref(), Some("origin/develop"));
        fs::write(work.join("file.txt"), "topic\n").unwrap();
        git(&work, &["commit", "-am", "topic"]);
        let head = git_text(&work, &["rev-parse", "HEAD"]);
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        let pushed = push_branch(&backend, &opened.summary.path, generation, 5).await.unwrap();
        assert_eq!(pushed.branch.upstream.as_deref(), Some("origin/develop"));
        assert_eq!(
            git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "develop"]).trim(),
            head.trim()
        );
        // 没有在远程新建同名的 topic。
        assert!(!git_text(fixture.path(), &["--git-dir", "origin.git", "branch", "--list"]).contains("topic"));
        // 再改回 origin/main：同名上游切换也只改配置。
        let generation = backend.scheduler.current_generation(&repo_key(&work));
        let back = set_upstream(&backend, &opened.summary.path, "origin/main", generation, 6)
            .await
            .unwrap();
        assert_eq!(back.snapshot.branch.upstream.as_deref(), Some("origin/main"));
        assert_ne!(
            git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "main"]).trim(),
            head.trim()
        );
    }

    #[test]
    fn upstream_name_match_only_for_same_named_branch() {
        assert!(upstream_matches_branch("origin/main", "main"));
        assert!(upstream_matches_branch("origin/feature/x", "feature/x"));
        assert!(!upstream_matches_branch("origin/develop", "main"));
        assert!(!upstream_matches_branch("origin/feature/x", "x"));
        assert!(!upstream_matches_branch("origin/main", ""));
    }

    fn branch_line(fields: [&str; 6]) -> String {
        fields.join("\u{1f}")
    }

    #[test]
    fn default_branch_prefers_origin_head_then_main_master_develop() {
        let origin_main = parse_branches(
            [
                branch_line(["refs/remotes/origin/HEAD", "", "", " ", "abc", "origin/main"]),
                branch_line(["refs/heads/master", "", "", " ", "def", ""]),
                branch_line(["refs/heads/main", "", "", "*", "abc", ""]),
                branch_line(["refs/remotes/origin/main", "", "", " ", "abc", ""]),
                branch_line(["refs/remotes/upstream/HEAD", "", "", " ", "def", "upstream/master"]),
            ]
            .join("\n")
            .as_bytes(),
        )
        .unwrap();
        assert!(
            !origin_main
                .branches
                .iter()
                .any(|branch| branch.name.ends_with("/HEAD")),
            "远程 HEAD 不进入分支列表"
        );
        assert_eq!(
            choose_default_branch(&origin_main.branches, &origin_main.origin_head).as_deref(),
            Some("main")
        );

        let release = parse_branches(
            [
                branch_line(["refs/remotes/origin/HEAD", "", "", " ", "abc", "origin/release"]),
                branch_line(["refs/heads/main", "", "", "*", "abc", ""]),
                branch_line(["refs/heads/release", "", "", " ", "abc", ""]),
            ]
            .join("\n")
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            choose_default_branch(&release.branches, &release.origin_head).as_deref(),
            Some("release")
        );

        let missing_local = parse_branches(
            [
                branch_line(["refs/remotes/origin/HEAD", "", "", " ", "abc", "origin/release"]),
                branch_line(["refs/heads/master", "", "", "*", "def", ""]),
                branch_line(["refs/heads/develop", "", "", " ", "ghi", ""]),
            ]
            .join("\n")
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            choose_default_branch(&missing_local.branches, &missing_local.origin_head).as_deref(),
            None
        );

        let unreadable = parse_branches(
            [
                branch_line(["refs/remotes/origin/HEAD", "", "", " ", "abc", ""]),
                branch_line(["refs/heads/master", "", "", "*", "def", ""]),
            ]
            .join("\n")
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            choose_default_branch(&unreadable.branches, &unreadable.origin_head).as_deref(),
            None
        );

        let fallback = parse_branches(
            [
                branch_line(["refs/heads/develop", "", "", " ", "ghi", ""]),
                branch_line(["refs/heads/master", "", "", "*", "def", ""]),
                branch_line(["refs/heads/topic", "", "", " ", "jkl", ""]),
            ]
            .join("\n")
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            choose_default_branch(&fallback.branches, &fallback.origin_head).as_deref(),
            Some("master")
        );

        let none = parse_branches(
            branch_line(["refs/heads/topic", "", "", "*", "jkl", ""]).as_bytes(),
        )
        .unwrap();
        assert_eq!(
            choose_default_branch(&none.branches, &none.origin_head).as_deref(),
            None
        );
    }

    #[tokio::test]
    async fn branch_state_default_follows_origin_head_without_rewriting_commits() {
        let fixture = crate::test_support::git_fixture("default-branch");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        let head = git_text(&work, &["rev-parse", "HEAD"]);
        let file = fs::read(work.join("file.txt")).unwrap();
        let opened = open_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let mut generation = opened.generation;
        let mut listed = branch_state(&backend, &opened.summary.path, generation, 2)
            .await
            .unwrap();
        assert_eq!(listed.default_branch.as_deref(), Some("main"));
        assert!(!listed.branches.iter().any(|branch| branch.name.ends_with("/HEAD")));

        git(&work, &["branch", "master"]);
        git(&work, &["branch", "develop"]);
        git(&work, &["branch", "release"]);
        git(&work, &["update-ref", "refs/remotes/origin/release", "HEAD"]);
        git(
            &work,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/release",
            ],
        );
        generation = listed.generation;
        listed = branch_state(&backend, &opened.summary.path, generation, 3)
            .await
            .unwrap();
        assert_eq!(listed.default_branch.as_deref(), Some("release"));

        git(&work, &["branch", "-D", "release"]);
        generation = listed.generation;
        listed = branch_state(&backend, &opened.summary.path, generation, 4)
            .await
            .unwrap();
        assert_eq!(listed.default_branch.as_deref(), None);

        git(&work, &["update-ref", "-d", "refs/remotes/origin/HEAD"]);
        generation = listed.generation;
        listed = branch_state(&backend, &opened.summary.path, generation, 5)
            .await
            .unwrap();
        assert_eq!(listed.default_branch.as_deref(), Some("main"));

        git(&work, &["switch", "develop"]);
        git(&work, &["branch", "-D", "main"]);
        generation = listed.generation;
        listed = branch_state(&backend, &opened.summary.path, generation, 6)
            .await
            .unwrap();
        assert_eq!(listed.default_branch.as_deref(), Some("master"));

        git(&work, &["switch", "-c", "topic"]);
        git(&work, &["branch", "-D", "master"]);
        git(&work, &["branch", "-D", "develop"]);
        generation = listed.generation;
        listed = branch_state(&backend, &opened.summary.path, generation, 7)
            .await
            .unwrap();
        assert_eq!(listed.default_branch.as_deref(), None);
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), file);
        assert_eq!(git_text(&work, &["rev-parse", "topic"]), head);
    }

    #[tokio::test]
    async fn branch_state_marks_branches_contained_in_local_and_remote_main() {
        let fixture = crate::test_support::git_fixture("merged-branches");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        // done：主干本地和远程都包含；origin/done 同理。
        git(&work, &["branch", "done"]);
        git(&work, &["update-ref", "refs/remotes/origin/done", "HEAD"]);
        // ahead：多一个主干没有的提交。
        git(&work, &["switch", "-c", "ahead"]);
        fs::write(work.join("file.txt"), "ahead\n").unwrap();
        git(&work, &["commit", "-am", "ahead"]);
        git(&work, &["switch", "main"]);
        // local-only：只合进了本地 main，远程 main 还没有，不能算安全。
        git(&work, &["switch", "-c", "local-only"]);
        fs::write(work.join("file.txt"), "local\n").unwrap();
        git(&work, &["commit", "-am", "local"]);
        git(&work, &["switch", "main"]);
        git(&work, &["merge", "--ff-only", "local-only"]);
        let head = git_text(&work, &["rev-parse", "HEAD"]);

        let opened = open_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let listed = branch_state(&backend, &opened.summary.path, opened.generation, 2)
            .await
            .unwrap();
        let merged = |name: &str| {
            listed
                .branches
                .iter()
                .find(|branch| branch.name == name)
                .unwrap_or_else(|| panic!("没有 {name}"))
                .merged
        };
        assert_eq!(listed.merge_bases, vec!["main".to_string(), "origin/main".to_string()]);
        assert!(merged("done"));
        assert!(merged("origin/done"));
        assert!(!merged("ahead"));
        assert!(!merged("local-only"));
        assert!(!merged("main"), "主干自己不标记");
        assert!(!merged("origin/main"), "主干的远程对应分支不标记");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), head, "只读判断，不移动任何分支");
    }

    #[tokio::test]
    async fn opening_another_worktree_leaves_both_checkouts_unchanged() {
        let fixture = crate::test_support::git_fixture("open-worktree");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        git(&work, &["branch", "occupied"]);
        let linked = fixture.path().join("linked");
        git(
            &work,
            &["worktree", "add", repo_key(&linked).as_str(), "occupied"],
        );
        let main_head = git_text(&work, &["rev-parse", "HEAD"]);
        let linked_head = git_text(&linked, &["rev-parse", "HEAD"]);
        let main_file = fs::read(work.join("file.txt")).unwrap();
        let linked_file = fs::read(linked.join("file.txt")).unwrap();
        let opened = open_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let switched = open_repository(&backend, &repo_key(&linked), 2).await.unwrap();
        assert_eq!(
            switched.summary.path,
            repo_key(&canonical_existing(&linked).unwrap())
        );
        assert_ne!(switched.summary.path, opened.summary.path);
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), main_head);
        assert_eq!(git_text(&linked, &["rev-parse", "HEAD"]), linked_head);
        assert_eq!(git_text(&work, &["branch", "--show-current"]), "main");
        assert_eq!(git_text(&linked, &["branch", "--show-current"]), "occupied");
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), main_file);
        assert_eq!(fs::read(linked.join("file.txt")).unwrap(), linked_file);
        let listed = branch_state(&backend, &opened.summary.path, opened.generation, 3)
            .await
            .unwrap();
        let occupied = listed
            .branches
            .iter()
            .find(|branch| branch.name == "occupied")
            .expect("occupied branch");
        let worktree = occupied.worktree.as_deref().unwrap_or("");
        assert_eq!(
            canonical_existing(Path::new(worktree)).unwrap(),
            canonical_existing(&linked).unwrap()
        );

        let missing = fixture.path().join("missing-worktree");
        let missing_error = open_repository(&backend, &repo_key(&missing), 4)
            .await
            .unwrap_err();
        assert!(
            missing_error.code == "path_missing" || missing_error.code == "path_unreadable",
            "{}",
            missing_error.code
        );
        assert!(!missing.exists());
        let plain = fixture.path().join("plain-dir");
        fs::create_dir(&plain).unwrap();
        let plain_error = open_repository(&backend, &repo_key(&plain), 5)
            .await
            .unwrap_err();
        assert_eq!(plain_error.code, "not_repository");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), main_head);
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), main_file);
    }

    #[test]
    fn parses_tracking_counts_and_gone_upstreams() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("ahead 3"), (3, 0, false));
        assert_eq!(parse_track("behind 12"), (0, 12, false));
        assert_eq!(parse_track("ahead 1, behind 2"), (1, 2, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
        let text = "refs/heads/main\u{1f}origin/main\u{1f}behind 2\u{1f}origin\u{1f}refs/heads/main\nrefs/heads/solo\u{1f}\u{1f}\u{1f}\u{1f}\n";
        let lines = parse_tracking(text.as_bytes());
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].track.behind, 2);
        assert_eq!(lines[0].remote, "origin");
        assert_eq!(lines[0].remote_ref, "refs/heads/main");
        assert_eq!(lines[1].track.upstream, None);
        assert!(validate_remote_ref("refs/heads/feature/x").is_ok());
        for bad in ["refs/tags/v1", "refs/heads/a:b", "refs/heads/-x", "+refs/heads/main", "refs/heads/*"] {
            assert!(validate_remote_ref(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn branch_remote_commands_use_argument_arrays_without_force() {
        let root = Path::new("/repo");
        let (_, args) = crate::git::command::fetch_into_branch_command(Path::new("git"), root, "origin", "refs/heads/dev", "dev");
        let text: Vec<String> = args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = text.iter().position(|arg| arg == "fetch").unwrap();
        assert_eq!(&text[at..], ["fetch", "--", "origin", "refs/heads/dev:refs/heads/dev"]);
        assert!(reject_force(&args).is_ok());
        let (_, args) = crate::git::command::push_branch_to_command(Path::new("git"), root, "origin", "dev", "refs/heads/dev");
        let text: Vec<String> = args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = text.iter().position(|arg| arg == "push").unwrap();
        assert_eq!(&text[at..], ["push", "--", "origin", "refs/heads/dev:refs/heads/dev"]);
        assert!(!text.iter().any(|arg| arg.starts_with('+')));
    }

    /// 在 work 里准备一个跟踪 origin/dev 的非当前分支 dev，并让远程 dev 前进一个提交。
    fn seed_dev_behind(fixture: &crate::test_support::GitFixture, origin: &Path, work: &Path) -> PathBuf {
        git(work, &["switch", "-c", "dev"]);
        git(work, &["push", "-u", "origin", "dev"]);
        git(work, &["switch", "main"]);
        let other = fixture.path().join("other");
        git(fixture.path(), &["clone", "-b", "dev", repo_key(origin).as_str(), "other"]);
        fs::write(other.join("file.txt"), "base\ndev upstream\n").unwrap();
        git(&other, &["commit", "-am", "dev upstream"]);
        git(&other, &["push"]);
        other
    }

    #[tokio::test]
    async fn tracking_reports_ahead_behind_after_fetch_and_updates_branch_without_switching() {
        let fixture = crate::test_support::git_fixture("branch-update-ff");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        let other = seed_dev_behind(&fixture, &origin, &work);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let fetched = fetch_remote(&backend, &opened.summary.path, opened.generation, 2).await.unwrap();
        let tracking = branch_tracking(&backend, &opened.summary.path, fetched.generation, 3).await.unwrap();
        let dev = tracking.branches.iter().find(|item| item.name == "dev").unwrap();
        assert_eq!((dev.ahead, dev.behind, dev.gone), (0, 1, false));
        assert_eq!(dev.upstream.as_deref(), Some("origin/dev"));
        let main = tracking.branches.iter().find(|item| item.name == "main").unwrap();
        assert_eq!((main.ahead, main.behind), (0, 0));

        let head = git_text(&work, &["rev-parse", "HEAD"]);
        let file = fs::read(work.join("file.txt")).unwrap();
        let updated = update_branch(&backend, &opened.summary.path, "dev", tracking.generation, 4).await.unwrap();
        assert_eq!(updated.snapshot.branch.name.as_deref(), Some("main"), "不切换分支");
        assert_eq!(git_text(&work, &["rev-parse", "HEAD"]), head);
        assert_eq!(fs::read(work.join("file.txt")).unwrap(), file, "工作区不变");
        assert_eq!(git_text(&work, &["rev-parse", "dev"]), git_text(&other, &["rev-parse", "HEAD"]));

        // 当前分支不走这条路，交给常规拉取。
        let current = update_branch(&backend, &opened.summary.path, "main", updated.generation, 5).await.unwrap_err();
        assert_eq!(current.code, "branch_current");
    }

    #[tokio::test]
    async fn update_branch_refuses_diverged_branch_and_leaves_it_untouched() {
        let fixture = crate::test_support::git_fixture("branch-update-diverged");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        seed_dev_behind(&fixture, &origin, &work);
        git(&work, &["switch", "dev"]);
        fs::write(work.join("file.txt"), "base\nlocal dev\n").unwrap();
        git(&work, &["commit", "-am", "local dev"]);
        git(&work, &["switch", "main"]);
        let local_dev = git_text(&work, &["rev-parse", "dev"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let error = update_branch(&backend, &opened.summary.path, "dev", opened.generation, 2).await.unwrap_err();
        assert_eq!(error.code, "branch_not_fast_forward", "{}", error.message);
        assert!(error.message.contains("不能快进"));
        assert_eq!(git_text(&work, &["rev-parse", "dev"]), local_dev, "分叉时分支不动");

        let missing = update_branch(&backend, &opened.summary.path, "nope", error.generation.unwrap(), 3).await.unwrap_err();
        assert_eq!(missing.code, "branch_missing");
        let invalid = update_branch(&backend, &opened.summary.path, "--force", error.generation.unwrap(), 4).await.unwrap_err();
        assert_eq!(invalid.code, "branch_invalid");
    }

    #[tokio::test]
    async fn push_local_branch_pushes_non_current_branch_and_publishes_untracked_one() {
        let fixture = crate::test_support::git_fixture("branch-push-local");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        git(&work, &["switch", "-c", "dev"]);
        git(&work, &["push", "-u", "origin", "dev"]);
        fs::write(work.join("file.txt"), "base\ndev local\n").unwrap();
        git(&work, &["commit", "-am", "dev local"]);
        git(&work, &["switch", "main"]);
        git(&work, &["branch", "solo"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let tracking = branch_tracking(&backend, &opened.summary.path, opened.generation, 2).await.unwrap();
        assert_eq!(tracking.branches.iter().find(|item| item.name == "dev").unwrap().ahead, 1);

        let pushed = push_local_branch(&backend, &opened.summary.path, "dev", tracking.generation, 3).await.unwrap();
        assert_eq!(pushed.snapshot.branch.name.as_deref(), Some("main"));
        assert_eq!(
            git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "dev"]),
            git_text(&work, &["rev-parse", "dev"])
        );
        let published = push_local_branch(&backend, &opened.summary.path, "solo", pushed.generation, 4).await.unwrap();
        let solo = published.branches.iter().find(|item| !item.remote && item.name == "solo").unwrap();
        assert_eq!(solo.upstream.as_deref(), Some("origin/solo"));
    }

    #[tokio::test]
    async fn push_local_branch_is_rejected_without_force_when_remote_moved() {
        let fixture = crate::test_support::git_fixture("branch-push-rejected");
        let backend = fixture.backend();
        let (origin, work) = seed_bare(&fixture);
        seed_dev_behind(&fixture, &origin, &work);
        git(&work, &["switch", "dev"]);
        fs::write(work.join("file.txt"), "base\nlocal dev\n").unwrap();
        git(&work, &["commit", "-am", "local dev"]);
        git(&work, &["switch", "main"]);
        let remote_dev = git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "dev"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        let error = push_local_branch(&backend, &opened.summary.path, "dev", opened.generation, 2).await.unwrap_err();
        assert_eq!(error.code, "push_rejected", "{}", error.message);
        assert_eq!(
            git_text(fixture.path(), &["--git-dir", "origin.git", "rev-parse", "dev"]),
            remote_dev,
            "不强推"
        );
    }
}

#[cfg(test)]
mod start_point_tests {
    use super::*;
    use crate::model::{BranchInfo, StatusSnapshot};

    fn state(names: &[(&str, bool)]) -> BranchState {
        BranchState {
            generation: 3,
            branches: names
                .iter()
                .map(|(name, remote)| BranchRecord {
                    name: (*name).to_string(),
                    remote: *remote,
                    current: false,
                    upstream: None,
                    worktree: None,
                    target_oid: None,
                    merged: false,
                })
                .collect(),
            snapshot: StatusSnapshot {
                generation: 3,
                branch: BranchInfo::default(),
                files: Vec::new(),
            },
            default_branch: None,
            merge_bases: Vec::new(),
        }
    }

    #[test]
    fn start_point_accepts_known_branches_and_commit_ids_only() {
        let known = state(&[("main", false), ("origin/main", true)]);
        assert_eq!(validate_start_point(&known, "main").unwrap(), "main");
        assert_eq!(
            validate_start_point(&known, "origin/main").unwrap(),
            "origin/main"
        );
        assert_eq!(validate_start_point(&known, "ABCDEF1").unwrap(), "abcdef1");
        for bad in [
            "--orphan",
            "HEAD~1",
            "main^",
            "abc",
            "deadbeef; rm",
            "",
            "nope/branch",
        ] {
            let error = validate_start_point(&known, bad).unwrap_err();
            assert_eq!(error.code, "branch_start_invalid", "{bad}");
        }
    }
}
