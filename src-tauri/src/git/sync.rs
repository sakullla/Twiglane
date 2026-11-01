use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::git::advice::{classify_problem, problem_error, remote_timeout};
use crate::git::changes::commit_index;
use crate::git::command::{
    branch_list_command, check_branch_command, clone_command, create_branch_at_command,
    create_branch_command, delete_branch_command, delete_remote_branch_command,
    delete_remote_tracking_command, fetch_command, publish_command, pull_ff_command, push_command,
    remote_add_command, remote_set_url_command, remote_verbose_command, rename_branch_command,
    set_upstream_to_command, status_command, switch_command, switch_track_command,
};
use crate::git::gate::action_key;
use crate::git::ops::{
    canonical_existing, ensure_directory, git_failure, open_repository, repo_key, require_git,
    run_git, status_from_output, validate_input_path, Backend,
};
use crate::git::runner::ProcessOutput;
use crate::git::schedule::{internal_request_id, JobKind, ScheduledOutput};
use crate::model::{
    BranchRecord, BranchState, CloneResult, CommitPushReport, RemoteInfo, RemoteState,
    StatusSnapshot,
};
use crate::redact::{contains_secret, redact};
use crate::state::now_ms;

pub async fn clone_repository(
    backend: &Backend,
    url: &str,
    parent: &str,
    name: &str,
    request_id: u64,
) -> Result<CloneResult, AppError> {
    validate_remote_url(url)?;
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
    let scheduled = match run_git(
        backend,
        &destination.to_string_lossy(),
        JobKind::Write,
        request_id,
        program,
        args,
        None,
    )
    .await
    {
        Err(error) => return Err(clone_failure(&destination, remote_timeout(error))),
        Ok(scheduled) => scheduled,
    };
    if scheduled.output.exit_code != 0 {
        return Err(clone_failure(
            &destination,
            finish_remote("clone_failed", &scheduled, "克隆没有完成。"),
        ));
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
    Ok(CloneResult {
        path: opened.summary.path.clone(),
        opened,
    })
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
    settle_read!(backend, &root, scheduled.generation, |current| confirm_remote_url(backend, &root, &git.path, name, url, current).await)?;
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
    settle_read!(backend, &root, scheduled.generation, |current| confirm_remote_url(backend, &root, &git.path, name, url, current).await)?;
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
    let git = require_git(backend).await?;
    let (pairs, generation) =
        remote_pairs(backend, &root, &git.path, generation, request_id).await?;
    if pairs.is_empty() {
        return Err(AppError::new(
            "no_remote",
            "还没有远程，无法检查。工作区没有改动。",
        ));
    }
    let (program, args) = fetch_command(&git.path, &root);
    let scheduled = write_repo(
        backend,
        &root,
        generation,
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
    backend.remote_checks.note(&key, now_ms());
    settle_read!(backend, &root, scheduled.generation, |current| snapshot_at(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)
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
    let (program, args) = pull_ff_command(&git.path, &root);
    let scheduled = write_repo(
        backend,
        &root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "pull_failed",
            &scheduled,
            "拉取没有完成，工作区保持原样。",
        ));
    }
    backend.remote_checks.note(&key, now_ms());
    settle_read!(backend, &root, scheduled.generation, |current| snapshot_at(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)
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
    let fetched = write_repo(
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
    reject_force(&args)?;
    let scheduled = write_repo(
        backend,
        &root,
        fetched.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        let text = output_text(&scheduled.output);
        if upstream_ref_missing(&text) {
            return Err(AppError::new(
                "upstream_missing",
                format!("远程还没有 {upstream}，未建立上游，也没有推送。请使用发布创建远程分支。"),
            )
            .with_generation(scheduled.generation));
        }
        return Err(finish_remote(
            "upstream_failed",
            &scheduled,
            "没有关联上游，也没有推送。",
        ));
    }
    backend.remote_checks.note(&key, now_ms());
    let after = settle_read!(backend, &root, scheduled.generation, |current| snapshot_at(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)?;
    if after.branch.upstream.as_deref() != Some(upstream.as_str()) {
        return Err(AppError::new(
            "upstream_unconfirmed",
            "上游关联没有被 Git 确认，没有推送。",
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
    let scheduled = write_repo(backend, &root, generation, request_id, program, args).await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
            "delete_failed",
            &scheduled,
            "没有删除远程分支。",
        ));
    }
    let tracking = format!("{remote}/{name}");
    let (program, args) = delete_remote_tracking_command(&git.path, &root, &tracking);
    let pruned = write_repo(
        backend,
        &root,
        scheduled.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    settle_read!(backend, &root, pruned.generation, |current| {
        load_branch_state(backend, &root, current, internal_request_id()).await
    })
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
    if before.branch.upstream.is_none() {
        return publish_to(backend, root, "", before.generation, internal_request_id()).await;
    }
    let git = require_git(backend).await?;
    let (program, args) = push_command(&git.path, root);
    let scheduled = write_repo(
        backend,
        root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
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
    .await)
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
    let scheduled = write_repo(
        backend,
        root,
        before.generation,
        internal_request_id(),
        program,
        args,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(finish_remote(
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
    .await)
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

async fn load_branch_state(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = branch_list_command(&git.path, root);
    let listed = read_repo(backend, root, generation, request_id, program, args).await?;
    if listed.output.exit_code != 0 {
        return Err(
            git_failure("branch_failed", &listed.output, "无法读取分支。")
                .with_generation(listed.generation),
        );
    }
    let mut branches = parse_branches(&listed.output.stdout)?;
    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then(left.remote.cmp(&right.remote))
            .then(left.name.cmp(&right.name))
    });
    let snapshot = snapshot_at(backend, root, listed.generation, internal_request_id()).await?;
    Ok(BranchState {
        generation: snapshot.generation,
        branches,
        snapshot,
    })
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
    status_from_output(backend, &repo_key(root), &scheduled)
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

fn parse_branches(bytes: &[u8]) -> Result<Vec<BranchRecord>, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("branch_encoding", "分支名称无法安全解码，未修改仓库。"))?;
    let mut branches = Vec::new();
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
        let (name, remote) = if let Some(short) = refname.strip_prefix("refs/remotes/") {
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
    Ok(branches)
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
    async fn remote_branch_delete_requires_confirmation() {
        let fixture = crate::test_support::git_fixture("remote-branch");
        let backend = fixture.backend();
        let (_origin, work) = seed_bare(&fixture);
        git(&work, &["switch", "-c", "topic"]);
        fs::write(work.join("topic.txt"), "topic\n").unwrap();
        git(&work, &["add", "--", "topic.txt"]);
        git(&work, &["commit", "-m", "topic"]);
        git(&work, &["push", "-u", "origin", "topic"]);
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
        assert!(git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "branch", "--list"]
        )
        .contains("topic"));
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
        assert!(!git_text(
            fixture.path(),
            &["--git-dir", "origin.git", "branch", "--list"]
        )
        .contains("topic"));
        assert!(!removed
            .branches
            .iter()
            .any(|branch| branch.remote && branch.name == "origin/topic"));
    }

    fn record(name: &str, remote: bool, upstream: Option<&str>) -> BranchRecord {
        BranchRecord {
            name: name.to_string(),
            remote,
            current: false,
            upstream: upstream.map(str::to_string),
            worktree: None,
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
                })
                .collect(),
            snapshot: StatusSnapshot {
                generation: 3,
                branch: BranchInfo::default(),
                files: Vec::new(),
            },
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
