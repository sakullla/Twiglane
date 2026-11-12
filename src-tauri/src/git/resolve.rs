use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::atomic::atomic_write;
use crate::error::AppError;
use crate::git::advice::{classify_problem, problem_error, GitProblem};
use crate::git::command::{
    add_command, ancestor_command, branch_contains_command, cached_diff_quiet_command,
    cat_blob_command, checkout_index_stage_command, checkout_side_command,
    cherry_pick_abort_command, cherry_pick_continue_command, cherry_pick_range_command,
    clean_files_command, commit_command, commit_no_edit_command, detach_at_command,
    fetch_one_command, git_path_command, git_paths_command, hash_object_command, head_command,
    history_details_command,
    head_match_command, head_record_command, ls_remote_tags_command, merge_abort_command,
    merge_base_command, merge_divergence_command, merge_ff_only_command, merge_incoming_files_command,
    merge_incoming_log_command, merge_no_commit_command, merge_tree_command, push_reflog_command,
    rebase_abort_command, rebase_command, rebase_continue_command, remote_names_command,
    remote_tracking_command, remove_path_command, reset_soft_command, restore_worktree_command,
    rev_parse_command, stash_list_command, status_command, switch_command, unmerged_index_command,
    update_index_info_command,
};
use crate::git::gate::action_key;
use crate::git::history::{parse_history_records, parse_name_status, validate_oid as history_oid};
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, run_git, safe_relative,
    status_from_output, validate_input_path, Backend,
};
use crate::git::parse::parse_status;
use crate::git::patch::DIFF_PREVIEW_BYTES;
use crate::git::runner::{ProcessOutput, RealRunner};
use crate::git::schedule::{internal_request_id, CommandSpec, JobKind, WriteGuard};
use crate::model::{
    AbortImpact, ChangeKind, CherryPickOutcome, CommitFileChange, ConflictEntry, ConflictSide,
    ConflictView,
    DiscardFilePlan, DiscardResult, FileChange, HistoryCommit, MergeComplete, MergePreview,
    MergeSession, StatusSnapshot, UndoResult, MAX_DRAFT_CHARS,
};
use crate::redact::{contains_secret, redact_error_text};

const MAX_LISTED_PATHS: usize = 200;
const MERGE_MSG_LIMIT: usize = 8 * 1024;

struct Stages {
    #[allow(dead_code)]
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
    ours_mode: String,
    theirs_mode: String,
}

struct HeadRecord {
    oid: String,
    parents: Vec<String>,
    summary: String,
}

struct SideBytes {
    present: bool,
    truncated: bool,
    bytes: Vec<u8>,
}

pub async fn merge_preview(
    backend: &Backend,
    path: &str,
    source: &str,
    target: Option<&str>,
    generation: u64,
    request_id: u64,
) -> Result<MergePreview, AppError> {
    let root = repo_root(path)?;
    let source = validate_branch_name(source)?;
    let target = match target.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => Some(validate_branch_name(name)?),
        None => None,
    };
    let git = require_git(backend).await?;
    let snapshot = read_status(backend, &root, generation, request_id).await?;
    let operation =
        operation_from_snapshot(backend, &root, &git.path, &snapshot, internal_request_id())
            .await?;
    ensure_ref(
        backend,
        &root,
        &git.path,
        &source,
        snapshot.generation,
        internal_request_id(),
    )
    .await?;
    let mut preview = preview_from(&snapshot, &source, target.as_deref(), &operation);
    let target_name = preview.target.clone();
    let target_local = if target.is_none() && (snapshot.branch.detached || snapshot.branch.unborn) {
        false
    } else {
        ref_exists(
            backend,
            &root,
            &git.path,
            &format!("refs/heads/{target_name}"),
            preview.generation,
        )
        .await?
    };
    if !target_local {
        if target.is_some() {
            block_preview(
                &mut preview,
                "remote_target",
                format!("{target_name} 不是本地分支。只能合并到本地分支，未开始合并。"),
            );
        }
        return Ok(preview);
    }
    if source == target_name {
        return Ok(preview);
    }
    let facts = read_merge_facts(
        backend,
        &root,
        &git.path,
        &target_name,
        &source,
        preview.generation,
    )
    .await?;
    apply_facts(&mut preview, facts);
    Ok(preview)
}

#[allow(clippy::too_many_arguments)]
pub async fn start_merge(
    backend: &Backend,
    path: &str,
    source: &str,
    target: Option<&str>,
    mode: Option<&str>,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let source = validate_branch_name(source)?;
    let target = match target.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => Some(validate_branch_name(name)?),
        None => None,
    };
    let mode = match mode.unwrap_or("merge") {
        "merge" | "no-ff" => IntegrationMode::Merge,
        "ff-only" => IntegrationMode::FastForward,
        "rebase" => IntegrationMode::Rebase,
        _ => {
            return Err(AppError::new(
                "merge_mode_invalid",
                "不支持的合并方式，未开始合并。",
            ))
        }
    };
    let git = require_git(backend).await?;
    let _gate = backend
        .actions
        .enter(action_key("merge", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, generation, request_id).await?;
    let outcome = start_in_guard(
        &mut guard,
        backend,
        &git.path,
        &root,
        &source,
        target.as_deref(),
        mode,
    )
    .await;
    let generation = guard.finish();
    let started = outcome.map_err(|error| attach_generation(error, generation))?;
    let mut session = settle_read!(backend, &root, generation, |current| merge_session(
        backend,
        path,
        current,
        internal_request_id()
    )
    .await)?;
    session.switched_from = started.switched_from;
    session.fast_forwarded = started.fast_forwarded;
    session.rebased = started.rebased;
    Ok(session)
}

pub async fn merge_session(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    let snapshot = read_status(backend, &root, generation, request_id).await?;
    let operation =
        operation_from_snapshot(backend, &root, &git.path, &snapshot, internal_request_id())
            .await?;
    let stages = if conflict_operation(&operation) {
        read_stages(
            backend,
            &root,
            &git.path,
            snapshot.generation,
            internal_request_id(),
        )
        .await?
    } else {
        (snapshot.generation, BTreeMap::new())
    };
    let message = if operation == "merge" {
        read_named_file(
            backend,
            &root,
            &git.path,
            "MERGE_MSG",
            stages.0,
            internal_request_id(),
        )
        .await?
    } else {
        (stages.0, String::new())
    };
    Ok(session_from(
        &snapshot, &operation, &stages.1, &message.1, message.0,
    ))
}

pub async fn conflict_view(
    backend: &Backend,
    path: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
) -> Result<ConflictView, AppError> {
    let root = repo_root(path)?;
    let relative_path = safe_relative(relative)?;
    let git = require_git(backend).await?;
    let operation = operation_kind(backend, &root, &git.path, generation, request_id).await?;
    if !resolvable_operation(&operation) {
        return Err(AppError::new(
            "unsupported_operation",
            "当前不是可继续的合并、变基、拣选或未合并文件，不能逐个处理冲突。",
        ));
    }
    let (generation, stages) =
        read_stages(backend, &root, &git.path, generation, internal_request_id()).await?;
    let Some(entry) = stages.get(relative) else {
        return Err(AppError::new(
            "conflict_resolved",
            "这个文件已经不在冲突列表中，未读取为可编辑的合并结果。",
        )
        .with_generation(generation));
    };
    let limit = capture_limit(backend);
    let ours = read_blob(
        backend,
        &root,
        &git.path,
        entry.ours.as_deref(),
        generation,
        internal_request_id(),
        limit,
    )
    .await?;
    let theirs = read_blob(
        backend,
        &root,
        &git.path,
        entry.theirs.as_deref(),
        ours.0,
        internal_request_id(),
        limit,
    )
    .await?;
    let result = read_worktree_side(&root, &relative_path, limit)?;
    Ok(view_from(
        relative, entry, &ours.1, &theirs.1, &result, theirs.0,
    ))
}

pub async fn resolve_conflict(
    backend: &Backend,
    path: &str,
    relative: &str,
    choice: &str,
    content: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let relative_path = safe_relative(relative)?;
    let git = require_git(backend).await?;
    let _gate = backend
        .actions
        .enter(action_key("merge", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, generation, request_id).await?;
    let outcome = resolve_in_guard(
        &mut guard,
        backend,
        &git.path,
        &root,
        &relative_path,
        choice,
        content.as_deref(),
    )
    .await;
    let generation = guard.finish();
    outcome.map_err(|error| attach_generation(error, generation))?;
    settle_read!(backend, &root, generation, |current| merge_session(
        backend,
        path,
        current,
        internal_request_id()
    )
    .await)
}

pub async fn complete_merge(
    backend: &Backend,
    path: &str,
    message: &str,
    generation: u64,
    request_id: u64,
) -> Result<MergeComplete, AppError> {
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let git = require_git(backend).await?;
    let _gate = backend
        .actions
        .enter(action_key("merge", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, generation, request_id).await?;
    let outcome = complete_in_guard(&mut guard, backend, &git.path, &root, message).await;
    let generation = guard.finish();
    let prepared = outcome.map_err(|error| attach_generation(error, generation))?;
    let snapshot = settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)?;
    if snapshot.branch.head_oid.as_deref() != Some(prepared.oid.as_str()) {
        return Err(AppError::new(
            "commit_unverified",
            "合并提交命令已返回，但 HEAD 与预期不一致。请刷新后查看历史，不要重复完成。",
        )
        .with_generation(snapshot.generation));
    }
    Ok(MergeComplete {
        oid: prepared.oid,
        generation: snapshot.generation,
        summary: prepared.summary,
        files: prepared.files,
        snapshot,
    })
}

pub async fn abort_merge(
    backend: &Backend,
    path: &str,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<AbortImpact, AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    if !confirm {
        return abort_preview(backend, &root, &git.path, generation, request_id).await;
    }
    ensure_no_index_lock(&root)?;
    let _gate = backend
        .actions
        .enter(action_key("merge", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, generation, request_id).await?;
    let outcome = abort_in_guard(&mut guard, backend, &git.path, &root).await;
    let generation = guard.finish();
    let impact = outcome.map_err(|error| attach_generation(error, generation))?;
    let snapshot = settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)?;
    Ok(AbortImpact {
        generation: snapshot.generation,
        wrote: true,
        paths: impact.paths,
        stash_oids: impact.stash_oids,
        note: impact.note,
        snapshot,
    })
}

pub async fn undo_commit(
    backend: &Backend,
    path: &str,
    expected_head: &str,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<UndoResult, AppError> {
    let expected_head = validate_oid(expected_head)?;
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    if !confirm {
        return undo_preview(
            backend,
            &root,
            &git.path,
            &expected_head,
            generation,
            request_id,
        )
        .await;
    }
    ensure_no_index_lock(&root)?;
    let _gate = backend
        .actions
        .enter(action_key("undo", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, generation, request_id).await?;
    let outcome = undo_in_guard(&mut guard, backend, &git.path, &root, &expected_head).await;
    let generation = guard.finish();
    let undone = outcome.map_err(|error| attach_generation(error, generation))?;
    let snapshot = settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)?;
    if snapshot.branch.head_oid.as_deref() != Some(undone.parent.as_str()) {
        return Err(AppError::new(
            "undo_unverified",
            "撤销命令已返回，但 HEAD 与父提交不一致。请刷新后确认，不要再次撤销。",
        )
        .with_generation(snapshot.generation));
    }
    Ok(UndoResult {
        generation: snapshot.generation,
        code: "ok".to_string(),
        eligible: true,
        wrote: true,
        head_oid: undone.parent.clone(),
        parent_oid: Some(undone.parent),
        summary: undone.summary,
        reason: "已撤销最近一次未推送的普通提交，文件改动仍保留在暂存区。".to_string(),
        snapshot,
    })
}

pub async fn discard_changes(
    backend: &Backend,
    path: &str,
    paths: &[String],
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<DiscardResult, AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    let snapshot = read_status(backend, &root, generation, request_id).await?;
    let plan = discard_plan(&snapshot, paths)
        .map_err(|error| attach_generation(error, snapshot.generation))?;
    if !confirm {
        return Ok(DiscardResult {
            generation: snapshot.generation,
            wrote: false,
            files: plan,
            boundary: discard_boundary(),
            snapshot,
        });
    }
    ensure_no_index_lock(&root)?;
    let _gate = backend
        .actions
        .enter(action_key("discard", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, snapshot.generation, internal_request_id()).await?;
    let outcome = discard_in_guard(&mut guard, backend, &git.path, &root, paths).await;
    let generation = guard.finish();
    let files = outcome.map_err(|error| attach_generation(error, generation))?;
    let snapshot = settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)?;
    Ok(DiscardResult {
        generation: snapshot.generation,
        wrote: true,
        files,
        boundary: discard_boundary(),
        snapshot,
    })
}

fn preview_from(
    snapshot: &StatusSnapshot,
    source: &str,
    target: Option<&str>,
    operation: &str,
) -> MergePreview {
    let current = if snapshot.branch.detached || snapshot.branch.unborn {
        None
    } else {
        snapshot.branch.name.clone()
    };
    let explicit = target.is_some();
    let target = target
        .map(str::to_string)
        .unwrap_or_else(|| target_name(snapshot));
    let needs_switch = current.as_deref() != Some(target.as_str());
    // 未跟踪文件不阻止合并：Git 只会在合并或切换要覆盖它们时拒绝，且拒绝时不写入任何内容。
    // 只有已跟踪文件的未提交改动才需要先提交或临时保存。
    let local_paths: Vec<String> = snapshot
        .files
        .iter()
        .filter(|file| !file.untracked)
        .map(|file| file.path.clone())
        .collect();
    let dirty = !local_paths.is_empty();
    let same = source == target;
    let (blocker, note) = if operation != "none" {
        (Some("operation"), operation_note(operation, None, 0))
    } else if current.is_none() && !explicit {
        (
            Some("detached"),
            "当前不在可合并的本地分支上。请先选择一个本地分支作为目标，未开始合并。".to_string(),
        )
    } else if same {
        (
            Some("same"),
            "来源和目标是同一个分支，未开始合并。".to_string(),
        )
    } else if dirty {
        let omitted = local_paths.len().saturating_sub(MAX_LISTED_PATHS);
        let action = if needs_switch {
            "切换分支并合并前"
        } else {
            "合并前"
        };
        let note = if omitted > 0 {
            format!(
                "工作区有 {} 处未提交改动，下面只展示 {} 条，还有 {omitted} 条未展示。{action}请先提交或临时保存，避免覆盖。未开始合并。",
                local_paths.len(),
                local_paths.len() - omitted
            )
        } else {
            format!(
                "工作区有 {} 处未提交改动，{action}请先提交或临时保存，避免覆盖。未开始合并。",
                local_paths.len()
            )
        };
        (Some("dirty"), note)
    } else if needs_switch {
        (
            None,
            format!("将先切换到 {target}，再把 {source} 合并进去。当前没有未提交改动。"),
        )
    } else {
        (
            None,
            format!("将把 {source} 合并到 {target}。当前没有未提交改动。"),
        )
    };
    let shown = local_paths.iter().take(MAX_LISTED_PATHS).cloned().collect();
    MergePreview {
        generation: snapshot.generation,
        source: source.to_string(),
        target,
        head_oid: snapshot.branch.head_oid.clone(),
        dirty,
        local_paths: shown,
        can_start: blocker.is_none(),
        operation: operation.to_string(),
        note,
        current,
        needs_switch,
        incoming: 0,
        outgoing: 0,
        up_to_date: false,
        fast_forward: false,
        commits: Vec::new(),
        files: Vec::new(),
        files_total: 0,
        conflict_check: "unknown".to_string(),
        conflict_paths: Vec::new(),
        blocker: blocker.map(str::to_string),
        base_oid: None,
        source_oid: None,
    }
}

fn block_preview(preview: &mut MergePreview, code: &str, note: String) {
    preview.can_start = false;
    preview.blocker = Some(code.to_string());
    preview.note = note;
}

struct MergeFacts {
    generation: u64,
    incoming: u32,
    outgoing: u32,
    commits: Vec<HistoryCommit>,
    files: Vec<CommitFileChange>,
    files_total: u32,
    conflict_check: String,
    conflict_paths: Vec<String>,
    base_oid: Option<String>,
    source_oid: Option<String>,
}

fn apply_facts(preview: &mut MergePreview, facts: MergeFacts) {
    preview.generation = facts.generation;
    preview.incoming = facts.incoming;
    preview.outgoing = facts.outgoing;
    preview.up_to_date = facts.incoming == 0;
    preview.fast_forward = facts.incoming > 0 && facts.outgoing == 0;
    preview.commits = facts.commits;
    preview.files = facts.files;
    preview.files_total = facts.files_total;
    preview.conflict_check = facts.conflict_check;
    preview.conflict_paths = facts.conflict_paths;
    preview.base_oid = facts.base_oid;
    preview.source_oid = facts.source_oid;
    // 目标已经包含全部提交比「工作区有改动」更根本：什么都不用做。
    if preview.up_to_date && preview.operation == "none" {
        let note = format!(
            "{} 已经包含 {} 的全部提交，不需要合并。",
            preview.target, preview.source
        );
        block_preview(preview, "up_to_date", note);
    }
}

async fn ref_exists(
    backend: &Backend,
    root: &Path,
    git: &Path,
    name: &str,
    generation: u64,
) -> Result<bool, AppError> {
    let (output, _) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        rev_parse_command(git, root, name),
    )
    .await?;
    Ok(output.exit_code == 0)
}

const MAX_PREVIEW_COMMITS: u32 = 100;

async fn read_merge_facts(
    backend: &Backend,
    root: &Path,
    git: &Path,
    target: &str,
    source: &str,
    generation: u64,
) -> Result<MergeFacts, AppError> {
    let (counts, generation) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        merge_divergence_command(git, root, target, source),
    )
    .await?;
    if counts.exit_code != 0 {
        return Err(git_failure(
            "merge_preview_failed",
            &counts,
            "无法比较两个分支，未开始合并。",
        )
        .with_generation(generation));
    }
    let (outgoing, incoming) = parse_divergence(&counts.stdout)?;
    if incoming == 0 {
        return Ok(MergeFacts {
            generation,
            incoming,
            outgoing,
            commits: Vec::new(),
            files: Vec::new(),
            files_total: 0,
            conflict_check: "clean".to_string(),
            conflict_paths: Vec::new(),
            base_oid: None,
            source_oid: None,
        });
    }
    // 预览里点开文件看差异要用到两端的确切提交：共同祖先 → 来源顶端。读不到时只是不能点开，不影响结论。
    let (tip, generation) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        rev_parse_command(git, root, &format!("{source}^{{commit}}")),
    )
    .await?;
    let source_oid = (tip.exit_code == 0).then(|| first_line_oid(&tip.stdout)).flatten();
    let (base, generation) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        merge_base_command(git, root, target, source),
    )
    .await?;
    let base_oid = (base.exit_code == 0).then(|| first_line_oid(&base.stdout)).flatten();
    let (log, generation) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        merge_incoming_log_command(git, root, target, source, MAX_PREVIEW_COMMITS),
    )
    .await?;
    let commits = if log.exit_code == 0 {
        parse_history_records(&log.stdout).unwrap_or_default()
    } else {
        Vec::new()
    };
    let (names, generation) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        merge_incoming_files_command(git, root, target, source),
    )
    .await?;
    let mut files = if names.exit_code == 0 && !names.stdout_truncated {
        parse_name_status(&names.stdout).unwrap_or_default()
    } else {
        Vec::new()
    };
    let files_total = u32::try_from(files.len()).unwrap_or(u32::MAX);
    files.truncate(MAX_LISTED_PATHS);
    let (conflict_check, conflict_paths, generation) = if outgoing == 0 {
        ("clean".to_string(), Vec::new(), generation)
    } else {
        let (tree, generation) = run_read(
            backend,
            root,
            generation,
            internal_request_id(),
            merge_tree_command(git, root, target, source),
        )
        .await?;
        match tree.exit_code {
            0 => ("clean".to_string(), Vec::new(), generation),
            1 => (
                "conflicts".to_string(),
                parse_merge_tree_conflicts(&tree.stdout),
                generation,
            ),
            _ => ("unknown".to_string(), Vec::new(), generation),
        }
    };
    Ok(MergeFacts {
        generation,
        incoming,
        outgoing,
        commits,
        files,
        files_total,
        conflict_check,
        conflict_paths,
        base_oid,
        source_oid,
    })
}

fn first_line_oid(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let line = text.lines().next()?.trim().to_ascii_lowercase();
    ((line.len() == 40 || line.len() == 64) && line.chars().all(|c| c.is_ascii_hexdigit())).then_some(line)
}

fn parse_divergence(bytes: &[u8]) -> Result<(u32, u32), AppError> {
    let text = String::from_utf8_lossy(bytes);
    let mut parts = text.split_whitespace().map(str::parse::<u32>);
    match (parts.next(), parts.next()) {
        (Some(Ok(left)), Some(Ok(right))) => Ok((left, right)),
        _ => Err(AppError::new(
            "merge_preview_failed",
            "无法解析分支差异，未开始合并。",
        )),
    }
}

/// `merge-tree --write-tree --name-only -z` 的输出：树 oid、冲突路径（各以 NUL 结尾），
/// 之后是空段与（已用 --no-messages 关闭的）消息区。
fn parse_merge_tree_conflicts(bytes: &[u8]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for (index, part) in bytes.split(|byte| *byte == 0).enumerate() {
        if index == 0 {
            continue;
        }
        if part.is_empty() {
            break;
        }
        let path = String::from_utf8_lossy(part).to_string();
        if !paths.contains(&path) {
            paths.push(path);
        }
        if paths.len() >= MAX_LISTED_PATHS {
            break;
        }
    }
    paths
}

fn session_from(
    snapshot: &StatusSnapshot,
    operation: &str,
    stages: &BTreeMap<String, Stages>,
    merge_message: &str,
    generation: u64,
) -> MergeSession {
    let conflicts = conflict_entries(stages);
    let unresolved = u32::try_from(conflicts.len()).unwrap_or(u32::MAX);
    let source = parse_merge_source(merge_message);
    let can_abort = abortable_operation(operation);
    let can_continue = abortable_operation(operation) && unresolved == 0;
    let note = operation_note(operation, source.as_deref(), unresolved);
    MergeSession {
        generation,
        operation: operation.to_string(),
        can_continue,
        can_abort,
        source,
        target: snapshot.branch.name.clone(),
        head_oid: snapshot.branch.head_oid.clone(),
        conflicts,
        unresolved,
        note,
        snapshot: snapshot.clone(),
        switched_from: None,
        fast_forwarded: false,
        rebased: false,
    }
}

fn conflict_operation(operation: &str) -> bool {
    matches!(operation, "merge" | "unmerged" | "rebase" | "cherry-pick")
}

fn abortable_operation(operation: &str) -> bool {
    matches!(operation, "merge" | "rebase" | "cherry-pick")
}

fn resolvable_operation(operation: &str) -> bool {
    conflict_operation(operation)
}

fn operation_note(operation: &str, source: Option<&str>, unresolved: u32) -> String {
    match operation {
        "merge" if unresolved == 0 => {
            let source = source.unwrap_or("来源分支");
            format!("正在把 {source} 合并到当前分支，冲突已全部标记。完成前不会结束合并；中止会撤销合并中的编辑。")
        }
        "merge" => {
            let source = source.unwrap_or("来源分支");
            format!("正在把 {source} 合并到当前分支。还有 {unresolved} 个未解决冲突，不能完成。中止会撤销合并中的编辑，并恢复合并前的状态。")
        }
        "rebase" if unresolved == 0 => {
            "正在变基（rebase）。冲突已全部标记，可以继续把尚未进入基底的提交接上去。不会逐条挑选、压缩或改写说明，也不能跳过。中止会让当前分支回到变基前。不会推送。".to_string()
        }
        "rebase" => format!(
            "正在变基（rebase）。还有 {unresolved} 个未解决冲突，不能完成。解决后可以继续，也可以中止回到变基前。不能跳过。"
        ),
        "cherry-pick" if unresolved == 0 => {
            "正在拣选（cherry-pick）。冲突已全部标记，可以继续。不能跳过。中止会让当前分支回到拣选前。不会推送。".to_string()
        }
        "cherry-pick" => format!(
            "正在拣选（cherry-pick）。还有 {unresolved} 个未解决冲突，不能完成。解决后可以继续，也可以中止。不能跳过。"
        ),
        "revert" => "检测到 revert 进行中。这里不会伪造 revert 的继续或中止。".to_string(),
        "bisect" => "检测到 bisect 进行中。这里不会伪造 bisect 操作。".to_string(),
        "unmerged" => "工作区有未合并文件，但没有分支合并进行中。这不是合并，不能完成合并，也不能中止合并。可以逐个文件编辑结果、选择一侧或处理修改/删除。若来自临时保存，原记录仍保留。".to_string(),
        "none" => "当前没有进行中的合并。".to_string(),
        _ => "检测到未支持的进行中状态。不会伪造对应操作。".to_string(),
    }
}

fn conflict_entries(stages: &BTreeMap<String, Stages>) -> Vec<ConflictEntry> {
    stages
        .iter()
        .map(|(path, entry)| {
            let kind = stage_kind(entry);
            ConflictEntry {
                path: path.clone(),
                summary: kind_summary(kind).to_string(),
                kind: kind.to_string(),
            }
        })
        .collect()
}

fn stage_kind(entry: &Stages) -> &'static str {
    match (entry.ours.is_some(), entry.theirs.is_some()) {
        (true, true) => "content",
        (true, false) => "modify_delete",
        (false, true) => "delete_modify",
        (false, false) => "both_deleted",
    }
}

fn kind_summary(kind: &str) -> &'static str {
    match kind {
        "text" => "文本冲突，可以对照三方并编辑合并结果。",
        "binary" => "二进制冲突，不能按文本合并，只能选择一侧的完整版本。",
        "content" => "双方都改了这个文件。打开后可以按文本编辑，或在二进制时选择一侧。",
        "modify_delete" => "当前分支修改了文件，来源分支删除了它。",
        "delete_modify" => "当前分支删除了文件，来源分支修改了它。",
        "both_deleted" => "双方都删除了这个文件。",
        _ => "冲突",
    }
}

fn view_from(
    path: &str,
    entry: &Stages,
    ours: &SideBytes,
    theirs: &SideBytes,
    result: &SideBytes,
    generation: u64,
) -> ConflictView {
    let ours_side = side_from(ours, "本地版本");
    let theirs_side = side_from(theirs, "另一分支版本");
    let result_side = side_from(result, "当前合并结果");
    let binary = ours_side.binary || theirs_side.binary || result_side.binary;
    let truncated = ours_side.truncated || theirs_side.truncated || result_side.truncated;
    let stage_kind = stage_kind(entry);
    let kind = match stage_kind {
        "content" if binary => "binary",
        "content" => "text",
        other => other,
    };
    let editable = kind == "text" && !truncated && !binary;
    let note = if kind == "binary" {
        "这是二进制冲突，不能按文本合并。请明确保留本地版本或另一分支版本。".to_string()
    } else if truncated {
        "内容超过预览上限。不能把截断文本写回；可以改用本地或另一分支的完整版本。".to_string()
    } else if kind == "text" {
        "可以编辑合并结果。标记后只解决这个文件，其他冲突保持不变。".to_string()
    } else {
        kind_summary(kind).to_string()
    };
    ConflictView {
        generation,
        path: path.to_string(),
        kind: kind.to_string(),
        editable,
        ours: ours_side,
        theirs: theirs_side,
        result: result_side,
        note,
    }
}

fn side_from(side: &SideBytes, label: &str) -> ConflictSide {
    // 截断的读取只知道「超过上限」，不冒充真实大小。
    let size = (!side.truncated).then_some(side.bytes.len() as u64);
    if !side.present {
        return ConflictSide {
            present: false,
            binary: false,
            truncated: false,
            text: None,
            summary: format!("{label}不存在。"),
            size: None,
        };
    }
    if side.bytes.contains(&0) || std::str::from_utf8(&side.bytes).is_err() {
        return ConflictSide {
            present: true,
            binary: true,
            truncated: side.truncated,
            text: None,
            summary: match size {
                Some(bytes) => format!("{label}是二进制，{}，不显示伪文本。", crate::git::sizes::format_size(bytes)),
                None => format!("{label}是二进制，不显示伪文本。"),
            },
            size,
        };
    }
    if side.truncated {
        return ConflictSide {
            present: true,
            binary: false,
            truncated: true,
            text: None,
            summary: format!("{label}超过预览上限，未当作可编辑全文。"),
            size,
        };
    }
    let text = String::from_utf8(side.bytes.clone()).unwrap_or_default();
    ConflictSide {
        present: true,
        binary: false,
        truncated: false,
        summary: format!("{label}，{} 个字符。", text.chars().count()),
        text: Some(text),
        size,
    }
}

enum IntegrationMode {
    Merge,
    FastForward,
    Rebase,
}

struct StartedMerge {
    switched_from: Option<String>,
    fast_forwarded: bool,
    rebased: bool,
}

async fn start_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    source: &str,
    target: Option<&str>,
    mode: IntegrationMode,
) -> Result<StartedMerge, AppError> {
    let mut snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if operation != "none" {
        return Err(AppError::new(
            "unsupported_operation",
            operation_note(&operation, None, 0),
        ));
    }
    if target == Some(source) {
        return Err(AppError::new(
            "merge_same",
            "来源和目标是同一个分支，未开始合并。",
        ));
    }
    let rebasing = matches!(mode, IntegrationMode::Rebase);
    if snapshot.files.iter().any(|file| !file.untracked) {
        return Err(AppError::new(
            "merge_dirty",
            if rebasing {
                "工作区有未提交改动。请先提交或临时保存，未开始变基。"
            } else {
                "工作区有未提交改动。请先提交或临时保存，未开始合并。"
            },
        ));
    }
    if !ref_in_guard(guard, git, root, source).await? {
        return Err(AppError::new(
            "branch_missing",
            if rebasing {
                "找不到基底分支，未开始变基。"
            } else {
                "找不到来源分支，未开始合并。"
            },
        ));
    }
    let original = if snapshot.branch.detached || snapshot.branch.unborn {
        None
    } else {
        snapshot.branch.name.clone()
    };
    if rebasing {
        return start_rebase(guard, git, root, source, target, &snapshot, original.as_deref()).await;
    }
    let mut switched_from = None;
    if let Some(target) = target.filter(|name| original.as_deref() != Some(*name)) {
        if !ref_in_guard(guard, git, root, &format!("refs/heads/{target}")).await? {
            return Err(AppError::new(
                "merge_target_invalid",
                format!("{target} 不是本地分支。只能合并到本地分支，未开始合并。"),
            ));
        }
        let output = run_spec(guard, switch_command(git, root, target), true, false).await?;
        if output.exit_code != 0 {
            return Err(git_failure(
                "switch_failed",
                &output,
                &format!("无法切换到 {target}，未开始合并。"),
            ));
        }
        switched_from = Some(original.clone().unwrap_or_else(|| "游离 HEAD".to_string()));
        snapshot = status_in_guard(guard, backend, git, root).await?;
    }
    let landed = |message: String| -> String {
        match (&switched_from, target) {
            (Some(_), Some(target)) => {
                format!("{message}（已切换到 {target}，可以从分支菜单切回。）")
            }
            _ => message,
        }
    };
    if snapshot.branch.detached || snapshot.branch.unborn {
        return Err(AppError::new(
            "merge_detached",
            "当前不在可合并的本地分支上，未开始合并。",
        ));
    }
    if snapshot.branch.name.as_deref() == Some(source) {
        return Err(AppError::new(
            "merge_same",
            landed("来源分支就是当前分支，未开始合并。".to_string()),
        ));
    }
    if matches!(mode, IntegrationMode::FastForward) {
        let output = run_spec(guard, merge_ff_only_command(git, root, source), true, false).await?;
        if output.exit_code != 0 {
            let error = git_failure(
                "merge_ff_failed",
                &output,
                "两个分支已经分叉，不能快进。请改用「创建合并提交」。",
            );
            return Err(AppError::new(error.code, landed(error.message)));
        }
        return Ok(StartedMerge {
            switched_from,
            fast_forwarded: true,
            rebased: false,
        });
    }
    let output = run_spec(
        guard,
        merge_no_commit_command(git, root, source),
        true,
        false,
    )
    .await?;
    let started = path_exists_in_guard(guard, git, root, "MERGE_HEAD").await?;
    if started || output.exit_code == 0 {
        return Ok(StartedMerge {
            switched_from,
            fast_forwarded: false,
            rebased: false,
        });
    }
    let error = git_failure("merge_failed", &output, "合并没有开始，工作区应保持原样。");
    Err(AppError::new(error.code, landed(error.message)))
}

async fn start_rebase(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    base: &str,
    target: Option<&str>,
    snapshot: &StatusSnapshot,
    current: Option<&str>,
) -> Result<StartedMerge, AppError> {
    if snapshot.branch.detached || snapshot.branch.unborn || current.is_none() {
        return Err(AppError::new(
            "merge_detached",
            "当前不在可改写的本地分支上，未开始变基。",
        ));
    }
    if let Some(target) = target {
        if current != Some(target) {
            return Err(AppError::new(
                "rebase_target",
                "变基只会改写当前分支。请把目标留在当前分支，未开始变基。",
            ));
        }
    }
    if current == Some(base) {
        return Err(AppError::new(
            "merge_same",
            "基底就是当前分支，未开始变基。",
        ));
    }
    let output = run_spec(guard, rebase_command(git, root, base), true, false).await?;
    let still = operation_in_guard(guard, git, root, snapshot).await?;
    if still == "rebase" {
        // 会覆盖未提交内容时 Git 可能已经留下变基目录。这种失败不算开始，先中止再返回。
        if classify_problem(&command_text(&output)) == Some(GitProblem::LocalChanges) {
            let _ = run_spec(guard, rebase_abort_command(git, root), true, false).await;
            return Err(classified_git(
                "rebase_failed",
                &output,
                "变基没有开始，当前分支和工作区应保持原样。",
            ));
        }
        return Ok(StartedMerge {
            switched_from: None,
            fast_forwarded: false,
            rebased: false,
        });
    }
    if output.exit_code == 0 && still == "none" {
        return Ok(StartedMerge {
            switched_from: None,
            fast_forwarded: false,
            rebased: true,
        });
    }
    Err(classified_git(
        "rebase_failed",
        &output,
        "变基没有开始，当前分支和工作区应保持原样。",
    ))
}

async fn resolve_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    relative: &Path,
    choice: &str,
    content: Option<&str>,
) -> Result<(), AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if !resolvable_operation(&operation) {
        return Err(AppError::new(
            "unsupported_operation",
            "当前不是可继续的合并、变基、拣选或未合并文件，未写入解决结果。",
        ));
    }
    let stages = stages_in_guard(guard, git, root).await?;
    let key = relative.to_string_lossy();
    let Some(entry) = stages.get(key.as_ref()) else {
        return Err(AppError::new(
            "conflict_resolved",
            "这个文件已经不在冲突列表中，未再次写入。",
        ));
    };
    apply_choice(
        guard,
        git,
        root,
        ConflictResolution {
            relative,
            entry,
            choice,
            content,
            sequencer: abortable_operation(&operation),
        },
    )
    .await
}

struct ConflictResolution<'a> {
    relative: &'a Path,
    entry: &'a Stages,
    choice: &'a str,
    content: Option<&'a str>,
    sequencer: bool,
}

async fn apply_choice(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    request: ConflictResolution<'_>,
) -> Result<(), AppError> {
    let ConflictResolution {
        relative,
        entry,
        choice,
        content,
        sequencer,
    } = request;
    let limit = DIFF_PREVIEW_BYTES;
    match choice {
        "text" => {
            if entry.ours.is_none() || entry.theirs.is_none() {
                return Err(AppError::new(
                    "resolve_choice",
                    "修改/删除冲突不能按文本结果写回。请选择保留的一侧。",
                ));
            }
            let ours = blob_in_guard(guard, git, root, entry.ours.as_deref(), limit).await?;
            let theirs = blob_in_guard(guard, git, root, entry.theirs.as_deref(), limit).await?;
            if side_blocks_text(&ours) || side_blocks_text(&theirs) {
                return Err(AppError::new(
                    "resolve_binary",
                    "二进制或超过预览上限的文件不能按编辑文本写回，未修改这个文件。",
                ));
            }
            let Some(content) = content else {
                return Err(AppError::new("resolve_empty", "合并结果是空的，未写入。"));
            };
            if content.len() > DIFF_PREVIEW_BYTES {
                return Err(AppError::new(
                    "resolve_too_large",
                    "合并结果超过预览上限，未写入。",
                ));
            }
            write_conflict_file(root, relative, content.as_bytes())?;
            if sequencer {
                add_path(guard, git, root, relative).await
            } else {
                stage_unmerged_worktree(guard, git, root, relative, &resolution_mode(entry)).await
            }
        }
        "ours" | "theirs" => {
            let selected = if choice == "ours" {
                (
                    entry.ours.as_deref(),
                    entry.ours_mode.as_str(),
                    "2",
                    "--ours",
                )
            } else {
                (
                    entry.theirs.as_deref(),
                    entry.theirs_mode.as_str(),
                    "3",
                    "--theirs",
                )
            };
            let Some(oid) = selected.0 else {
                return Err(AppError::new("resolve_choice", "这一侧没有版本，未写入。"));
            };
            if sequencer {
                let output = run_spec(
                    guard,
                    checkout_side_command(git, root, selected.3, relative),
                    true,
                    false,
                )
                .await?;
                if output.exit_code != 0 {
                    return Err(git_failure("resolve_failed", &output, "没有取回所选版本。"));
                }
                add_path(guard, git, root, relative).await
            } else if selected.1 != "100644" && selected.1 != "100755" {
                Err(AppError::new(
                    "resolve_choice",
                    "这个冲突不是普通文件，未写入。",
                ))
            } else {
                // Without MERGE_HEAD, checkout --ours/--theirs restores HEAD and leaves the conflict.
                let output = run_spec(
                    guard,
                    checkout_index_stage_command(git, root, selected.2, relative),
                    true,
                    false,
                )
                .await?;
                if output.exit_code != 0 {
                    return Err(git_failure("resolve_failed", &output, "没有取回所选版本。"));
                }
                replace_unmerged_entry(guard, git, root, relative, Some(oid), selected.1).await
            }
        }
        "delete" => {
            if entry.ours.is_some() && entry.theirs.is_some() {
                return Err(AppError::new(
                    "resolve_choice",
                    "双方都有版本时不能直接删除，请编辑结果或选择一侧。",
                ));
            }
            if sequencer {
                let output = run_spec(
                    guard,
                    remove_path_command(git, root, &[relative.to_path_buf()]),
                    true,
                    false,
                )
                .await?;
                if output.exit_code != 0 {
                    return Err(git_failure("resolve_failed", &output, "没有接受删除。"));
                }
                Ok(())
            } else {
                remove_worktree_file(root, relative)?;
                replace_unmerged_entry(guard, git, root, relative, None, "100644").await
            }
        }
        _ => Err(AppError::new(
            "resolve_choice",
            "不支持的解决方式，未写入。",
        )),
    }
}

fn side_blocks_text(side: &SideBytes) -> bool {
    !side.present
        || side.truncated
        || side.bytes.contains(&0)
        || std::str::from_utf8(&side.bytes).is_err()
}

fn resolution_mode(entry: &Stages) -> String {
    if entry.ours_mode == "100755" || entry.theirs_mode == "100755" {
        "100755".to_string()
    } else {
        "100644".to_string()
    }
}

async fn stage_unmerged_worktree(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    relative: &Path,
    mode: &str,
) -> Result<(), AppError> {
    let output = run_spec(guard, hash_object_command(git, root, relative), true, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "resolve_failed",
            &output,
            "文件内容已保留，但还没有标记为已解决。请修正后重试。",
        ));
    }
    let oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    if !is_oid(&oid) {
        return Err(AppError::new(
            "resolve_failed",
            "无法核对写入后的文件内容，未把它标记为已解决。",
        ));
    }
    replace_unmerged_entry(guard, git, root, relative, Some(&oid), mode).await
}

async fn replace_unmerged_entry(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    relative: &Path,
    oid: Option<&str>,
    mode: &str,
) -> Result<(), AppError> {
    let path = relative.to_string_lossy();
    let bytes = index_resolution_bytes(&path, oid, mode)?;
    let (program, args) = update_index_info_command(git, root);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: Some(bytes),
            truncate_stdout: false,
            output_limit: None,
            writes: true,
        })
        .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "resolve_failed",
            &output,
            "文件内容已保留，但还没有标记为已解决。请修正后重试。",
        ));
    }
    Ok(())
}

fn index_resolution_bytes(path: &str, oid: Option<&str>, mode: &str) -> Result<Vec<u8>, AppError> {
    if path.contains(['\t', '\n', '\0']) || path.is_empty() {
        return Err(AppError::new(
            "invalid_path",
            "冲突路径无法安全写入索引，未标记为已解决。",
        ));
    }
    if let Some(oid) = oid {
        if !is_oid(oid) || (mode != "100644" && mode != "100755") {
            return Err(AppError::new(
                "resolve_choice",
                "这个冲突不是普通文件，未写入。",
            ));
        }
    }
    let width = oid.map(|item| item.len()).unwrap_or(40);
    let zero = "0".repeat(width);
    let mut body = String::new();
    for stage in ["1", "2", "3"] {
        body.push_str(&format!("0 {zero} {stage}\t{path}\n"));
    }
    if let Some(oid) = oid {
        body.push_str(&format!("{mode} {oid} 0\t{path}\n"));
    }
    Ok(body.into_bytes())
}

fn remove_worktree_file(root: &Path, relative: &Path) -> Result<(), AppError> {
    let target = root.join(relative);
    let metadata = match target.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(AppError::new(
                "resolve_failed",
                "无法删除冲突文件，未把它标记为已解决。",
            ))
        }
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        std::fs::remove_file(&target).map_err(|_| {
            AppError::new("resolve_failed", "无法删除冲突文件，未把它标记为已解决。")
        })?;
        return Ok(());
    }
    Err(AppError::new(
        "resolve_choice",
        "冲突路径不是普通文件，未删除。",
    ))
}

async fn add_path(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    relative: &Path,
) -> Result<(), AppError> {
    let output = run_spec(
        guard,
        add_command(git, root, &[relative.to_path_buf()]),
        true,
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "resolve_failed",
            &output,
            "文件内容已保留，但还没有标记为已解决。请修正后重试。",
        ));
    }
    Ok(())
}

fn write_conflict_file(root: &Path, relative: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let target = root.join(relative);
    let parent = target.parent().unwrap_or(root);
    let canon_root = canonical_existing(root)?;
    let canon_parent = canonical_existing(parent)
        .map_err(|_| AppError::new("invalid_path", "冲突文件的目录不可用，未写入合并结果。"))?;
    if !canon_parent.starts_with(&canon_root) {
        return Err(AppError::new("invalid_path", "合并结果必须留在仓库内部。"));
    }
    if target
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(AppError::new(
            "resolve_link",
            "冲突路径是符号链接，不能按文本覆盖，未写入。",
        ));
    }
    atomic_write(&target, bytes).map_err(|_| {
        AppError::new(
            "resolve_failed",
            "无法写入合并结果，原文件保持写入前的内容。",
        )
    })
}

struct CompletedMerge {
    oid: String,
    summary: String,
    files: Vec<String>,
}

async fn complete_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    message: &str,
) -> Result<CompletedMerge, AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if operation == "rebase" || operation == "cherry-pick" {
        return continue_sequencer(guard, backend, git, root, &snapshot, &operation).await;
    }
    if operation != "merge" {
        return Err(AppError::new(
            "unsupported_operation",
            format!("{} 未创建提交。", operation_note(&operation, None, 0)),
        ));
    }
    let message = normalize_message(message)?;
    let stages = stages_in_guard(guard, git, root).await?;
    if !stages.is_empty() {
        return Err(AppError::new(
            "conflicts_open",
            "还有未解决的冲突，不能完成合并。已填写的说明和文件内容都还保留。",
        ));
    }
    let files: Vec<String> = snapshot
        .files
        .iter()
        .filter(|file| file.staged != ChangeKind::None || file.unstaged != ChangeKind::None)
        .map(|file| file.path.clone())
        .collect();
    let before = head_in_guard(guard, git, root).await?;
    let output = run_spec(guard, commit_command(git, root, &message), true, false).await?;
    if output.exit_code != 0 {
        return Err(classify_commit(&output));
    }
    let after = head_in_guard(guard, git, root).await?;
    if after.is_empty() || after == before {
        return Err(AppError::new(
            "commit_unverified",
            "提交命令已返回，但没有确认新的合并提交。请刷新后查看，不要重复完成。说明和暂存内容都还保留。",
        ));
    }
    if !path_exists_in_guard(guard, git, root, "MERGE_HEAD").await? {
        return Ok(CompletedMerge {
            oid: after,
            summary: format!("已完成合并提交，包含 {} 个路径。", files.len()),
            files,
        });
    }
    Err(AppError::new(
        "commit_unverified",
        "提交命令已返回，但合并仍在进行。请刷新后查看，不要重复完成。",
    ))
}

async fn continue_sequencer(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    snapshot: &StatusSnapshot,
    operation: &str,
) -> Result<CompletedMerge, AppError> {
    let stages = stages_in_guard(guard, git, root).await?;
    if !stages.is_empty() {
        return Err(AppError::new(
            "conflicts_open",
            "还有未解决的冲突，不能完成。可以解决后继续，或中止回到操作前。不能跳过。",
        ));
    }
    let files: Vec<String> = snapshot
        .files
        .iter()
        .filter(|file| file.staged != ChangeKind::None || file.unstaged != ChangeKind::None)
        .map(|file| file.path.clone())
        .collect();
    let quiet = run_spec(guard, cached_diff_quiet_command(git, root), false, false).await?;
    if quiet.exit_code > 1 {
        return Err(git_failure(
            "commit_failed",
            &quiet,
            "无法确认暂存内容，未继续。",
        ));
    }
    if quiet.exit_code == 1 {
        let committed = run_spec(guard, commit_no_edit_command(git, root), true, false).await?;
        if committed.exit_code != 0 {
            let text = command_text(&committed).to_ascii_lowercase();
            let empty = text.contains("nothing to commit")
                || text.contains("no changes added")
                || text.contains("没有需要提交");
            if empty {
                return Err(AppError::new(
                    "sequencer_paused",
                    "这次没有可以提交的内容，不能算完成，也没有跳过。可以中止回到操作前。",
                ));
            }
            return Err(classify_commit(&committed));
        }
    }
    let mid = status_in_guard(guard, backend, git, root).await?;
    let now = operation_in_guard(guard, git, root, &mid).await?;
    // commit --no-edit removes CHERRY_PICK_HEAD before later picks run.
    // sequencer/todo still lists those picks, so this is not completion.
    let cherry_pick_remains = if operation == "cherry-pick" && now == "none" {
        cherry_pick_todo_pending(guard, git, root).await?
    } else {
        false
    };
    if now == "none" && !cherry_pick_remains {
        return Ok(CompletedMerge {
            oid: head_in_guard(guard, git, root).await?,
            summary: continue_summary(operation),
            files,
        });
    }
    if now != operation && !cherry_pick_remains {
        return Err(AppError::new(
            "unsupported_operation",
            format!("{} 未继续。", operation_note(&now, None, 0)),
        ));
    }
    let command = match operation {
        "rebase" => rebase_continue_command(git, root),
        "cherry-pick" => cherry_pick_continue_command(git, root),
        _ => {
            return Err(AppError::new(
                "unsupported_operation",
                "不能继续这个操作，也没有跳过。",
            ))
        }
    };
    let output = run_spec(guard, command, true, false).await?;
    let after = status_in_guard(guard, backend, git, root).await?;
    let after_op = operation_in_guard(guard, git, root, &after).await?;
    if after_op == "none" && output.exit_code == 0 {
        if operation == "cherry-pick" && cherry_pick_todo_pending(guard, git, root).await? {
            return Err(AppError::new(
                "sequencer_paused",
                "拣选还有后续提交，不能算完成。可以继续，或中止回到操作前。不能跳过。",
            ));
        }
        return Ok(CompletedMerge {
            oid: head_in_guard(guard, git, root).await?,
            summary: continue_summary(operation),
            files,
        });
    }
    if after_op == "rebase" || after_op == "cherry-pick" {
        let paused = stages_in_guard(guard, git, root).await?;
        if !paused.is_empty() {
            return Err(AppError::new(
                "sequencer_paused",
                "这次继续又遇到冲突，不能算完成。后面的提交还没有应用。可以解决后继续，或中止回到操作前。不能跳过。",
            ));
        }
        return Err(classified_git(
            "sequencer_paused",
            &output,
            "不能继续，也没有跳过。可以中止回到操作前。",
        ));
    }
    Err(classified_git(
        "commit_failed",
        &output,
        "没有完成。没有跳过。",
    ))
}

fn continue_summary(operation: &str) -> String {
    match operation {
        "rebase" => "已把当前分支上尚未进入基底的提交接到基底顶端。没有推送。".to_string(),
        "cherry-pick" => "已继续拣选。没有推送。".to_string(),
        _ => "已继续。没有推送。".to_string(),
    }
}

fn classified_git(code: &str, output: &ProcessOutput, fallback: &str) -> AppError {
    let text = command_text(output);
    if let Some(problem) = classify_problem(&text) {
        return problem_error(problem, &text);
    }
    git_failure(code, output, fallback)
}

struct AbortPreview {
    paths: Vec<String>,
    stash_oids: Vec<String>,
    note: String,
}

async fn abort_preview(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<AbortImpact, AppError> {
    let snapshot = read_status(backend, root, generation, request_id).await?;
    let operation =
        operation_from_snapshot(backend, root, git, &snapshot, internal_request_id()).await?;
    if !abortable_operation(&operation) {
        return Err(AppError::new(
            "unsupported_operation",
            format!("{} 未中止任何合并。", operation_note(&operation, None, 0)),
        )
        .with_generation(snapshot.generation));
    }
    let (generation, stash_oids) = stash_oids(
        backend,
        root,
        git,
        snapshot.generation,
        internal_request_id(),
    )
    .await?;
    let (paths, note) = abort_listing(&snapshot, &operation);
    Ok(AbortImpact {
        generation,
        wrote: false,
        note,
        paths,
        stash_oids,
        snapshot,
    })
}

async fn abort_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
) -> Result<AbortPreview, AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if !abortable_operation(&operation) {
        return Err(AppError::new(
            "unsupported_operation",
            format!("{} 未中止任何合并。", operation_note(&operation, None, 0)),
        ));
    }
    let before = stash_oids_in_guard(guard, git, root).await?;
    let (paths, total) = listed_path_counts(&snapshot);
    let output = run_spec(guard, abort_command(&operation, git, root)?, true, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "merge_abort_failed",
            &output,
            "没有中止。编辑和临时保存都还保留。",
        ));
    }
    let refreshed = status_in_guard(guard, backend, git, root).await?;
    let after_op = operation_in_guard(guard, git, root, &refreshed).await?;
    if after_op != "none" {
        return Err(AppError::new(
            "merge_abort_failed",
            "中止命令已返回，但操作标记仍在。请刷新后确认，不要假设已经恢复。",
        ));
    }
    let after = stash_oids_in_guard(guard, git, root).await?;
    if after != before {
        return Err(AppError::new(
            "stash_changed",
            "操作已中止，但临时保存记录与中止前不一致。请先核对临时保存，不要继续删除。",
        ));
    }
    let verb = operation_verb(&operation);
    Ok(AbortPreview {
        paths,
        stash_oids: after,
        note: if operation == "merge" {
            format!(
                "已中止合并，工作区恢复到合并前的状态。合并中的编辑共 {total} 处，已全部撤销。预先存在的临时保存仍保留。"
            )
        } else {
            format!(
                "已中止{verb}，当前分支回到操作前。{verb}中的编辑共 {total} 处，已全部撤销。预先存在的临时保存仍保留。"
            )
        },
    })
}

fn abort_command(
    operation: &str,
    git: &Path,
    root: &Path,
) -> Result<(PathBuf, Vec<std::ffi::OsString>), AppError> {
    Ok(match operation {
        "merge" => merge_abort_command(git, root),
        "rebase" => rebase_abort_command(git, root),
        "cherry-pick" => cherry_pick_abort_command(git, root),
        _ => {
            return Err(AppError::new(
                "unsupported_operation",
                "不能中止这个操作。",
            ))
        }
    })
}

fn operation_verb(operation: &str) -> &'static str {
    match operation {
        "rebase" => "变基",
        "cherry-pick" => "拣选",
        _ => "合并",
    }
}

fn abort_listing(snapshot: &StatusSnapshot, operation: &str) -> (Vec<String>, String) {
    let (paths, total) = listed_path_counts(snapshot);
    let note = abort_note(operation, paths.len(), total);
    (paths, note)
}

fn abort_note(operation: &str, shown: usize, total: usize) -> String {
    if operation == "merge" {
        if total == 0 {
            return "中止会撤销合并中的编辑，并把暂存区和工作区恢复到合并前。预先存在的临时保存会保留。取消不会写入。".to_string();
        }
        if shown < total {
            return format!(
                "中止会撤销全部 {total} 处合并中的编辑，包括已经标记但尚未完成提交的内容，并恢复到合并前的状态。下面只展示 {shown} 条，还有 {} 条未展示；未列出的编辑也会被撤销。预先存在的临时保存会保留。取消不会写入。",
                total - shown
            );
        }
        return format!(
            "中止会撤销全部 {total} 处合并中的编辑，包括已经标记但尚未完成提交的内容，并恢复到合并前的状态。预先存在的临时保存会保留。取消不会写入。"
        );
    }
    let verb = operation_verb(operation);
    if total == 0 {
        format!("中止会撤销这次{verb}，并把当前分支、暂存区和工作区恢复到操作前。预先存在的临时保存会保留。取消不会写入。")
    } else if shown < total {
        format!(
            "中止会撤销全部 {total} 处{verb}中的编辑，并恢复到操作前的状态。下面只展示 {shown} 条，还有 {} 条未展示；未列出的编辑也会被撤销。预先存在的临时保存会保留。取消不会写入。",
            total - shown
        )
    } else {
        format!(
            "中止会撤销全部 {total} 处{verb}中的编辑，并恢复到操作前的状态。预先存在的临时保存会保留。取消不会写入。"
        )
    }
}

struct UndoPlan {
    code: String,
    eligible: bool,
    head_oid: String,
    parent_oid: Option<String>,
    summary: String,
    reason: String,
    remote: Option<String>,
}

async fn undo_preview(
    backend: &Backend,
    root: &Path,
    git: &Path,
    expected_head: &str,
    generation: u64,
    request_id: u64,
) -> Result<UndoResult, AppError> {
    let snapshot = read_status(backend, root, generation, request_id).await?;
    let operation =
        operation_from_snapshot(backend, root, git, &snapshot, internal_request_id()).await?;
    let record = read_head_record(
        backend,
        root,
        git,
        snapshot.generation,
        internal_request_id(),
    )
    .await?;
    let dirty = index_dirty(backend, root, git, record.0, internal_request_id()).await?;
    let remotes = remote_names(backend, root, git, dirty.0, internal_request_id()).await?;
    let plan = undo_plan(
        &snapshot,
        &operation,
        record.1.as_ref(),
        dirty.1,
        &remotes.1,
        expected_head,
        false,
    );
    if !plan.eligible {
        return Ok(undo_result(remotes.0, &plan, false, snapshot));
    }
    let remote = plan
        .remote
        .clone()
        .ok_or_else(|| AppError::new("undo_unclear", "没有可核对的单个远程，未撤销提交。"))?;
    ensure_no_index_lock(root)?;
    let _gate = backend.actions.enter(action_key("undo", &repo_key(root)))?;
    let mut guard = write_lock(backend, root, remotes.0, internal_request_id()).await?;
    let outcome = assess_unpushed(&mut guard, git, root, &remote, expected_head).await;
    let generation = guard.finish();
    let refreshed = settle_read!(backend, root, generation, |current| read_status(
        backend,
        root,
        current,
        internal_request_id()
    )
    .await);
    match outcome {
        Ok(ready) => {
            let snapshot = refreshed.map_err(|error| attach_generation(error, generation))?;
            Ok(UndoResult {
                generation: snapshot.generation,
                code: "ok".to_string(),
                eligible: true,
                wrote: false,
                head_oid: ready.oid,
                parent_oid: Some(ready.parent),
                summary: ready.summary,
                reason: "已核对唯一远程的分支、tag 和本地推送记录，没有发现这个提交。确认后会再核对一次；离线、已发布或记录无法解析都不会撤销。".to_string(),
                snapshot,
            })
        }
        Err(error) => {
            let error = attach_generation(error, generation);
            if !preview_refusal_code(&error.code) {
                return Err(error);
            }
            let snapshot = match refreshed {
                Ok(snapshot) => snapshot,
                Err(read_error) => return Err(attach_generation(read_error, generation)),
            };
            Ok(UndoResult {
                generation: snapshot.generation,
                code: error.code,
                eligible: false,
                wrote: false,
                head_oid: plan.head_oid,
                parent_oid: plan.parent_oid,
                summary: plan.summary,
                reason: error.message,
                snapshot,
            })
        }
    }
}

struct Undone {
    parent: String,
    summary: String,
}

async fn undo_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    expected_head: &str,
) -> Result<Undone, AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    let record = head_record_in_guard(guard, git, root).await?;
    let dirty = cached_dirty_in_guard(guard, git, root).await?;
    let remotes = remote_names_in_guard(guard, git, root).await?;
    let plan = undo_plan(
        &snapshot,
        &operation,
        record.as_ref(),
        dirty,
        &remotes,
        expected_head,
        true,
    );
    if !plan.eligible {
        return Err(AppError::new(plan.code, plan.reason));
    }
    let remote = plan
        .remote
        .clone()
        .ok_or_else(|| AppError::new("undo_unclear", "没有可核对的单个远程，未撤销提交。"))?;
    let ready = assess_unpushed(guard, git, root, &remote, expected_head).await?;
    let output = run_spec(
        guard,
        reset_soft_command(git, root, &ready.parent),
        true,
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "undo_failed",
            &output,
            "没有撤销提交，HEAD 应保持原样。",
        ));
    }
    Ok(Undone {
        parent: ready.parent,
        summary: ready.summary,
    })
}

struct ReadyUndo {
    oid: String,
    parent: String,
    summary: String,
}

fn preview_refusal_code(code: &str) -> bool {
    matches!(
        code,
        "undo_pushed" | "undo_unclear" | "undo_offline" | "undo_head_changed" | "undo_dirty_index"
    )
}

async fn assess_unpushed(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    remote: &str,
    expected_head: &str,
) -> Result<ReadyUndo, AppError> {
    if !remote_ref_name_ok(remote) {
        return Err(AppError::new(
            "undo_unclear",
            "远程名称无法安全核对，未撤销提交。",
        ));
    }
    let fetched = run_spec(guard, fetch_one_command(git, root, remote), true, false).await?;
    if fetched.exit_code != 0 {
        return Err(git_failure(
            "undo_offline",
            &fetched,
            "无法检查远程分支和 tag，不能确认这次提交是否已经传播。未撤销提交。",
        ));
    }
    let reread = head_record_in_guard(guard, git, root).await?;
    let Some(reread) = reread else {
        return Err(AppError::new(
            "undo_head_changed",
            "当前提交已经变化，未撤销。",
        ));
    };
    if reread.oid != expected_head || reread.parents.len() != 1 {
        return Err(AppError::new(
            "undo_head_changed",
            "写入前核对时 HEAD 已变化，未撤销提交。",
        ));
    }
    if cached_dirty_in_guard(guard, git, root).await? {
        return Err(AppError::new(
            "undo_dirty_index",
            "暂存区在写入前发生了变化，未撤销提交。",
        ));
    }
    ensure_not_published(guard, git, root, remote, &reread.oid).await?;
    let parent = reread.parents[0].clone();
    Ok(ReadyUndo {
        oid: reread.oid,
        parent,
        summary: reread.summary,
    })
}

async fn ensure_not_published(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    remote: &str,
    oid: &str,
) -> Result<(), AppError> {
    let contained = run_spec(guard, branch_contains_command(git, root, oid), false, false).await?;
    if contained.exit_code != 0 && contained.exit_code != 1 {
        return Err(git_failure(
            "undo_unclear",
            &contained,
            "无法确认提交是否已在远程分支上，未撤销。",
        ));
    }
    if contained.stdout_truncated {
        return Err(AppError::new(
            "undo_unclear",
            "远程分支列表不完整，不能确认传播范围。未撤销提交。",
        ));
    }
    if remote_contains(&contained.stdout)? {
        return Err(AppError::new(
            "undo_pushed",
            "这个提交已经出现在该远程的分支上，未改写共享历史。",
        ));
    }
    let tags = run_spec(
        guard,
        ls_remote_tags_command(git, root, remote),
        false,
        false,
    )
    .await?;
    if tags.exit_code != 0 {
        return Err(git_failure(
            "undo_offline",
            &tags,
            "无法读取远程 tag，不能确认这次提交是否已经传播。未撤销提交。",
        ));
    }
    if tags.stdout_truncated {
        return Err(AppError::new(
            "undo_unclear",
            "远程 tag 列表不完整，不能确认传播范围。未撤销提交。",
        ));
    }
    if remote_tag_contains(&tags.stdout, oid)? {
        return Err(AppError::new(
            "undo_pushed",
            "这个提交已经出现在该远程的 tag 上，未改写共享历史。",
        ));
    }
    // A rewritten remote branch drops `branch -r --contains`, but the local
    // remote-tracking reflog still records `update by push` for that OID.
    if push_reflog_contains(guard, git, root, remote, oid).await? {
        return Err(AppError::new(
            "undo_pushed",
            "本地推送记录显示这个提交曾经推送到该远程，未改写共享历史。",
        ));
    }
    Ok(())
}

async fn push_reflog_contains(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    remote: &str,
    oid: &str,
) -> Result<bool, AppError> {
    let listed = run_spec(
        guard,
        remote_tracking_command(git, root, remote),
        false,
        false,
    )
    .await?;
    if listed.exit_code != 0 || listed.stdout_truncated {
        return Err(git_failure(
            "undo_unclear",
            &listed,
            "无法读取远程跟踪记录，不能确认传播范围。未撤销提交。",
        ));
    }
    let refs = parse_remote_refs(&listed.stdout, remote)?;
    for refname in refs {
        let output = run_spec(
            guard,
            push_reflog_command(git, root, &refname),
            false,
            false,
        )
        .await?;
        if output.exit_code != 0 || output.stdout_truncated {
            return Err(git_failure(
                "undo_unclear",
                &output,
                "本地推送记录无法解析，不能确认传播范围。未撤销提交。",
            ));
        }
        if parse_push_reflog(&output.stdout, oid)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn undo_plan(
    snapshot: &StatusSnapshot,
    operation: &str,
    record: Option<&HeadRecord>,
    dirty_index: bool,
    remotes: &[String],
    expected_head: &str,
    confirming: bool,
) -> UndoPlan {
    let head_oid = record.map(|item| item.oid.clone()).unwrap_or_default();
    let parent_oid = record.and_then(|item| item.parents.first().cloned());
    let summary = record.map(|item| item.summary.clone()).unwrap_or_default();
    let blocked = |code: &str, reason: &str| UndoPlan {
        code: code.to_string(),
        eligible: false,
        head_oid: head_oid.clone(),
        parent_oid: parent_oid.clone(),
        summary: summary.clone(),
        reason: reason.to_string(),
        remote: None,
    };
    if operation != "none" {
        return blocked("undo_in_progress", "有进行中的操作，未撤销提交。");
    }
    if snapshot.branch.detached {
        return blocked("undo_detached", "当前不在分支上，不能用这个入口撤销提交。");
    }
    let Some(record) = record else {
        return blocked("undo_root", "还没有可以撤销的普通提交。");
    };
    if record.oid != expected_head {
        return blocked(
            "undo_head_changed",
            "当前提交与打开撤销时看到的不一致，未写入。",
        );
    }
    if record.parents.is_empty() {
        return blocked("undo_root", "这是首个提交，不能撤销并保留改动。");
    }
    if record.parents.len() != 1 {
        return blocked("undo_merge", "这是合并提交，不能用这个入口撤销。");
    }
    if dirty_index {
        return blocked(
            "undo_dirty_index",
            "暂存区已有内容。撤销会和它混在一起，未撤销提交。",
        );
    }
    if remotes.len() != 1 {
        return blocked(
            "undo_unclear",
            "需要且仅能核对一个远程。没有唯一远程时，传播范围不明，未撤销提交。",
        );
    }
    let remote = remotes[0].clone();
    if !confirming {
        return UndoPlan {
            code: "needs_remote".to_string(),
            eligible: true,
            head_oid,
            parent_oid,
            summary,
            reason: format!(
                "确认时会检查远程 {remote}。离线、已推送或 HEAD 已变化都会停止，不会撤销。"
            ),
            remote: Some(remote),
        };
    }
    UndoPlan {
        code: "ok".to_string(),
        eligible: true,
        head_oid,
        parent_oid,
        summary,
        reason: String::new(),
        remote: Some(remote),
    }
}

fn undo_result(
    generation: u64,
    plan: &UndoPlan,
    wrote: bool,
    snapshot: StatusSnapshot,
) -> UndoResult {
    UndoResult {
        generation,
        code: plan.code.clone(),
        eligible: plan.eligible,
        wrote,
        head_oid: plan.head_oid.clone(),
        parent_oid: plan.parent_oid.clone(),
        summary: plan.summary.clone(),
        reason: plan.reason.clone(),
        snapshot,
    }
}

fn discard_plan(
    snapshot: &StatusSnapshot,
    paths: &[String],
) -> Result<Vec<DiscardFilePlan>, AppError> {
    if paths.is_empty() {
        return Err(AppError::new(
            "discard_empty",
            "没有选择文件，未放弃任何改动。",
        ));
    }
    if paths.len() > MAX_LISTED_PATHS {
        return Err(AppError::new(
            "discard_too_many",
            "一次放弃的文件过多。请缩小范围，未写入。",
        ));
    }
    let mut selected = Vec::new();
    for path in paths {
        let relative = safe_relative(path)?;
        let key = relative.to_string_lossy();
        let Some(file) = snapshot.files.iter().find(|file| file.path == key) else {
            return Err(AppError::new(
                "discard_unknown",
                format!("未在当前改动中找到 {path}，没有放弃任何文件。"),
            ));
        };
        if file.unmerged {
            return Err(AppError::new(
                "discard_unmerged",
                "冲突文件不能用放弃改动处理。请在合并里解决，或中止合并。未写入。",
            ));
        }
        selected.push(discard_file(file));
    }
    Ok(selected)
}

fn discard_file(file: &FileChange) -> DiscardFilePlan {
    let original_path = rename_original(file);
    let (impact, recovery) = if file.untracked {
        (
            "这是未跟踪文件。确认后会删除该文件。".to_string(),
            "删除后不能通过 Git 恢复，本应用也不能撤销这次放弃。".to_string(),
        )
    } else if let Some(original) = &original_path {
        (
            format!(
                "这是重命名：{original} → {}。确认后原路径和新路径都会回到当前提交。",
                file.path
            ),
            "放弃后 Git 不保留这份未提交内容，本应用不能撤销这次放弃。".to_string(),
        )
    } else {
        let staged = file.staged != ChangeKind::None;
        let unstaged = file.unstaged != ChangeKind::None;
        let impact = match (staged, unstaged) {
            (true, true) => "暂存区和未暂存的修改都会回到当前提交。",
            (true, false) => "已暂存的修改会从暂存区和工作区移除，回到当前提交。",
            (false, true) => "未暂存的修改会回到当前提交。",
            (false, false) => "这个文件没有可放弃的本地修改。",
        };
        (
            impact.to_string(),
            "放弃后 Git 不保留这份未提交内容，本应用不能撤销这次放弃。".to_string(),
        )
    };
    DiscardFilePlan {
        path: file.path.clone(),
        original_path,
        staged: file.staged,
        unstaged: file.unstaged,
        untracked: file.untracked,
        impact,
        recovery,
    }
}

fn rename_original(file: &FileChange) -> Option<String> {
    if file.staged == ChangeKind::Renamed || file.unstaged == ChangeKind::Renamed {
        file.original_path.clone()
    } else {
        None
    }
}

fn discard_boundary() -> String {
    "确认只影响所选文件。取消不写入，未选择的文件保持原内容。已放弃的内容不能用撤销提交找回。"
        .to_string()
}

async fn discard_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    paths: &[String],
) -> Result<Vec<DiscardFilePlan>, AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if operation == "merge"
        || operation == "rebase"
        || operation == "cherry-pick"
        || operation == "revert"
    {
        return Err(AppError::new(
            "discard_busy",
            "有进行中的合并或其他操作时，不能放弃文件。未写入。",
        ));
    }
    let plan = discard_plan(&snapshot, paths)?;
    let (tracked, untracked) = restore_targets(&snapshot, &plan)?;
    if !tracked.is_empty() {
        let output = run_spec(
            guard,
            restore_worktree_command(git, root, &tracked),
            true,
            false,
        )
        .await?;
        if output.exit_code != 0 {
            return Err(git_failure("discard_failed", &output, "没有放弃所选文件。"));
        }
    }
    if !untracked.is_empty() {
        let output = run_spec(
            guard,
            clean_files_command(git, root, &untracked),
            true,
            false,
        )
        .await?;
        if output.exit_code != 0 {
            return Err(git_failure(
                "discard_failed",
                &output,
                "已跟踪文件可能已经恢复，未跟踪文件没有全部删除。请刷新后确认范围。",
            ));
        }
    }
    if !tracked.is_empty() {
        ensure_matches_head(guard, git, root, &tracked).await?;
    }
    Ok(plan)
}

fn restore_targets(
    snapshot: &StatusSnapshot,
    plan: &[DiscardFilePlan],
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), AppError> {
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for item in plan {
        let Some(file) = snapshot.files.iter().find(|file| file.path == item.path) else {
            return Err(AppError::new(
                "discard_unknown",
                "所选文件在写入前已变化，未放弃。",
            ));
        };
        if file.untracked {
            untracked.push(safe_relative(&file.path)?);
            continue;
        }
        push_unique_path(&mut tracked, safe_relative(&file.path)?);
        if let Some(original) = rename_original(file) {
            push_unique_path(&mut tracked, safe_relative(&original)?);
        }
    }
    Ok((tracked, untracked))
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

async fn ensure_matches_head(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
) -> Result<(), AppError> {
    for cached in [false, true] {
        let output = run_spec(
            guard,
            head_match_command(git, root, cached, paths),
            false,
            false,
        )
        .await?;
        if output.exit_code == 0 {
            continue;
        }
        if output.exit_code == 1 {
            return Err(AppError::new(
                "discard_unverified",
                "放弃后所选路径没有全部回到当前提交。重命名需要原路径和新路径都一致。请刷新后查看，不要假设已经恢复。",
            ));
        }
        return Err(git_failure(
            "discard_unverified",
            &output,
            "放弃后无法核对路径是否回到当前提交。请刷新后查看，不要假设已经恢复。",
        ));
    }
    Ok(())
}

fn listed_path_counts(snapshot: &StatusSnapshot) -> (Vec<String>, usize) {
    let total = snapshot.files.len();
    let paths = snapshot
        .files
        .iter()
        .take(MAX_LISTED_PATHS)
        .map(|file| file.path.clone())
        .collect();
    (paths, total)
}

fn target_name(snapshot: &StatusSnapshot) -> String {
    if snapshot.branch.detached {
        "游离 HEAD".to_string()
    } else {
        snapshot
            .branch
            .name
            .clone()
            .unwrap_or_else(|| "当前分支".to_string())
    }
}

fn parse_merge_source(message: &str) -> Option<String> {
    let line = message.lines().next()?.trim();
    let start = line.find('\'')?;
    let end = line[start + 1..].find('\'')?;
    let name = &line[start + 1..start + 1 + end];
    validate_branch_name(name).ok()
}

fn normalize_message(message: &str) -> Result<String, AppError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "empty_message",
            "请先填写合并说明。冲突处理结果未改动。",
        ));
    }
    if trimmed.chars().count() > MAX_DRAFT_CHARS {
        return Err(AppError::new(
            "message_too_large",
            "合并说明过长，未创建提交。已标记的结果都还保留。",
        ));
    }
    if contains_secret(trimmed) {
        return Err(AppError::new(
            "draft_secret",
            "合并说明包含疑似凭据或私钥，未创建提交。已标记的结果都还保留。",
        ));
    }
    Ok(trimmed.to_string())
}

fn classify_commit(output: &ProcessOutput) -> AppError {
    let detail = redact_error_text(command_text(output).trim());
    let lower = detail.to_ascii_lowercase();
    if lower.contains("author identity unknown")
        || lower.contains("committer identity unknown")
        || lower.contains("empty ident")
        || detail.contains("作者身份未知")
    {
        return AppError::new(
            "identity_missing",
            format!("缺少提交身份，合并没有完成。说明和已标记的结果都还保留。{detail}"),
        );
    }
    if lower.contains("hook") {
        return AppError::new(
            "hook_rejected",
            format!("提交钩子拒绝了合并完成。说明和已标记的结果都还保留。{detail}"),
        );
    }
    AppError::new(
        "commit_failed",
        format!("合并没有完成。说明和已标记的结果都还保留。{detail}"),
    )
}

fn validate_branch_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
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
        || name == "HEAD"
    {
        return Err(AppError::new(
            "branch_invalid",
            "分支名称无效，未开始合并。",
        ));
    }
    Ok(name.to_string())
}

fn validate_oid(oid: &str) -> Result<String, AppError> {
    let oid = oid.trim().to_ascii_lowercase();
    if (oid.len() == 40 || oid.len() == 64)
        && oid.chars().all(|character| character.is_ascii_hexdigit())
    {
        Ok(oid)
    } else {
        Err(AppError::new(
            "invalid_revision",
            "提交标识无效，未撤销提交。",
        ))
    }
}

fn remote_contains(bytes: &[u8]) -> Result<bool, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("undo_unclear", "远程分支列表无法安全解析，未撤销提交。"))?;
    Ok(text.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('(')
    }))
}

fn remote_ref_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        && !name.ends_with('.')
        && !name.contains("..")
}

fn remote_tag_contains(bytes: &[u8], oid: &str) -> Result<bool, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("undo_unclear", "远程 tag 记录无法解析，未撤销提交。"))?;
    let mut found = false;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let Some((left, right)) = line.split_once('\t') else {
            return Err(AppError::new(
                "undo_unclear",
                "远程 tag 记录无法解析，未撤销提交。",
            ));
        };
        let left = left.trim().to_ascii_lowercase();
        if !is_oid(&left) || !right.starts_with("refs/tags/") {
            return Err(AppError::new(
                "undo_unclear",
                "远程 tag 记录无法解析，未撤销提交。",
            ));
        }
        if left == oid {
            found = true;
        }
    }
    Ok(found)
}

fn parse_remote_refs(bytes: &[u8], remote: &str) -> Result<Vec<String>, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("undo_unclear", "远程跟踪记录无法解析，未撤销提交。"))?;
    let prefix = format!("refs/remotes/{remote}/");
    let mut refs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !line.starts_with(&prefix)
            || line
                .chars()
                .any(|character| character.is_whitespace() || character == '\\')
            || line.contains("..")
        {
            return Err(AppError::new(
                "undo_unclear",
                "远程跟踪记录无法解析，未撤销提交。",
            ));
        }
        refs.push(line.to_string());
    }
    Ok(refs)
}

fn parse_push_reflog(bytes: &[u8], oid: &str) -> Result<bool, AppError> {
    if bytes.is_empty() {
        return Ok(false);
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("undo_unclear", "本地推送记录无法解析，未撤销提交。"))?;
    let mut found = false;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let Some((raw_oid, subject)) = line.split_once('\u{1f}') else {
            return Err(AppError::new(
                "undo_unclear",
                "本地推送记录无法解析，未撤销提交。",
            ));
        };
        let raw_oid = raw_oid.trim().to_ascii_lowercase();
        if !is_oid(&raw_oid) {
            return Err(AppError::new(
                "undo_unclear",
                "本地推送记录无法解析，未撤销提交。",
            ));
        }
        if raw_oid == oid && subject.contains("update by push") {
            found = true;
        }
    }
    Ok(found)
}

fn parse_stages(bytes: &[u8]) -> Result<BTreeMap<String, Stages>, AppError> {
    let mut stages = BTreeMap::new();
    for part in bytes.split(|byte| *byte == 0) {
        if part.is_empty() {
            continue;
        }
        let text = std::str::from_utf8(part).map_err(|_| {
            AppError::new("status_encoding", "冲突路径无法安全显示，未据此修改仓库。")
        })?;
        let Some((meta, path)) = text.split_once('\t') else {
            return Err(AppError::new(
                "status_parse",
                "冲突索引不完整，未据此修改仓库。",
            ));
        };
        let mut fields = meta.split_whitespace();
        let raw_mode = fields.next();
        let oid = fields.next().unwrap_or("");
        let stage = fields.next().unwrap_or("");
        if !is_oid(oid) {
            return Err(AppError::new(
                "status_parse",
                "冲突索引中的对象无效，未据此修改仓库。",
            ));
        }
        let entry = stages.entry(path.to_string()).or_insert_with(|| Stages {
            base: None,
            ours: None,
            theirs: None,
            ours_mode: "100644".to_string(),
            theirs_mode: "100644".to_string(),
        });
        let mode = raw_mode.unwrap_or("100644");
        match stage {
            "1" => entry.base = Some(oid.to_string()),
            "2" => {
                entry.ours = Some(oid.to_string());
                entry.ours_mode = mode.to_string();
            }
            "3" => {
                entry.theirs = Some(oid.to_string());
                entry.theirs_mode = mode.to_string();
            }
            _ => {
                return Err(AppError::new(
                    "status_parse",
                    "冲突阶段无法识别，未据此修改仓库。",
                ))
            }
        }
    }
    Ok(stages)
}

fn is_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn parse_head_record(bytes: &[u8]) -> Result<Option<HeadRecord>, AppError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("history_parse", "当前提交无法安全显示，未撤销。"))?;
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Ok(None);
    }
    let mut parts = line.splitn(3, '\u{1f}');
    let oid = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let parents = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let summary = parts.next().unwrap_or("").trim().to_string();
    if !is_oid(&oid) {
        return Err(AppError::new(
            "history_parse",
            "当前提交标识无法核对，未撤销。",
        ));
    }
    let parents = if parents.is_empty() {
        Vec::new()
    } else {
        parents
            .split_whitespace()
            .map(|item| item.to_ascii_lowercase())
            .collect()
    };
    if parents.iter().any(|item| !is_oid(item)) {
        return Err(AppError::new(
            "history_parse",
            "父提交标识无法核对，未撤销。",
        ));
    }
    Ok(Some(HeadRecord {
        oid,
        parents,
        summary,
    }))
}

fn parse_remote_names(bytes: &[u8]) -> Result<Vec<String>, AppError> {
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("undo_unclear", "远程名称无法安全显示，未撤销提交。"))?;
    let mut names = Vec::new();
    for line in text.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if name.starts_with('-')
            || name
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(AppError::new(
                "undo_unclear",
                "远程名称无法安全核对，未撤销提交。",
            ));
        }
        names.push(name.to_string());
    }
    Ok(names)
}

fn parse_stash_oids(bytes: &[u8]) -> Result<Vec<String>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("stash_failed", "临时保存记录无法安全显示，未继续写入。"))?;
    let mut oids = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let oid = line
            .split('\u{1f}')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !is_oid(&oid) {
            return Err(AppError::new(
                "stash_failed",
                "临时保存标识无法核对，未继续写入。",
            ));
        }
        oids.push(oid);
    }
    Ok(oids)
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

fn ensure_no_index_lock(root: &Path) -> Result<(), AppError> {
    if root.join(".git").join("index.lock").exists() {
        return Err(AppError::new(
            "index_lock",
            "索引锁仍在，可能有另一个 Git 进程正在写入。未删除该锁，也没有继续。",
        ));
    }
    Ok(())
}

fn capture_limit(backend: &Backend) -> usize {
    backend.runner.output_limit.min(DIFF_PREVIEW_BYTES)
}

async fn write_lock<'a>(
    backend: &'a Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<WriteGuard<'a, RealRunner>, AppError> {
    backend
        .scheduler
        .lock_write(&repo_key(root), request_id, generation)
        .await
}

async fn run_spec(
    guard: &mut WriteGuard<'_, RealRunner>,
    command: (PathBuf, Vec<std::ffi::OsString>),
    writes: bool,
    truncate: bool,
) -> Result<ProcessOutput, AppError> {
    let (program, args) = command;
    guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: truncate,
            output_limit: None,
            writes,
        })
        .await
}

async fn run_read(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
    command: (PathBuf, Vec<std::ffi::OsString>),
) -> Result<(ProcessOutput, u64), AppError> {
    let (program, args) = command;
    let scheduled = run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await?;
    Ok((scheduled.output, scheduled.generation))
}

async fn read_status(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let git = require_git(backend).await?;
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        status_command(&git.path, root),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(
            git_failure("status_failed", &output, "无法读取仓库状态。").with_generation(generation)
        );
    }
    status_from_output(
        backend,
        root,
        &crate::git::schedule::ScheduledOutput { output, generation },
    )
    .await
}

async fn status_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
) -> Result<StatusSnapshot, AppError> {
    let output = run_spec(guard, status_command(git, root), false, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure("status_failed", &output, "无法读取仓库状态。"));
    }
    let mut snapshot = parse_status(&output.stdout)?;
    snapshot.generation = backend.scheduler.current_generation(&repo_key(root));
    crate::git::ops::decorate_guard_status(guard, git, root, &mut snapshot).await;
    Ok(snapshot)
}

async fn operation_kind(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<String, AppError> {
    let snapshot = read_status(backend, root, generation, request_id).await?;
    operation_from_snapshot(backend, root, git, &snapshot, internal_request_id()).await
}

async fn operation_from_snapshot(
    backend: &Backend,
    root: &Path,
    git: &Path,
    snapshot: &StatusSnapshot,
    request_id: u64,
) -> Result<String, AppError> {
    let names: Vec<_> = sequencer_markers().iter().map(|(name, _)| *name).collect();
    let (output, _) = run_read(
        backend,
        root,
        snapshot.generation,
        request_id,
        git_paths_command(git, root, &names),
    )
    .await?;
    operation_from_paths(root, snapshot, &output)
}

async fn operation_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    snapshot: &StatusSnapshot,
) -> Result<String, AppError> {
    let names: Vec<_> = sequencer_markers().iter().map(|(name, _)| *name).collect();
    let output = run_spec(guard, git_paths_command(git, root, &names), false, false).await?;
    operation_from_paths(root, snapshot, &output)
}

fn operation_from_paths(
    root: &Path,
    snapshot: &StatusSnapshot,
    output: &ProcessOutput,
) -> Result<String, AppError> {
    if output.exit_code != 0 {
        return Err(git_failure(
            "operation_failed",
            output,
            "无法读取仓库操作状态。",
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<_> = text.lines().collect();
    let markers = sequencer_markers();
    if paths.len() != markers.len() {
        return Err(AppError::new(
            "operation_failed",
            "仓库操作状态路径不完整，未修改仓库。",
        ));
    }
    for (path, (_, kind)) in paths.iter().zip(markers) {
        if git_path_exists(root, path.as_bytes()) {
            return Ok(kind.to_string());
        }
    }
    Ok(if snapshot.files.iter().any(|file| file.unmerged) {
        "unmerged"
    } else {
        "none"
    }
    .to_string())
}

fn sequencer_markers() -> [(&'static str, &'static str); 6] {
    [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_START", "bisect"),
        ("MERGE_HEAD", "merge"),
    ]
}

fn git_path_exists(root: &Path, stdout: &[u8]) -> bool {
    resolved_git_path(root, stdout).is_some_and(|path| path.exists())
}

fn resolved_git_path(root: &Path, stdout: &[u8]) -> Option<PathBuf> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let path = PathBuf::from(text);
    Some(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn sequencer_todo_has_instruction(contents: &str) -> bool {
    contents.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('#') && !line.starts_with("hint:")
    })
}

async fn cherry_pick_todo_pending(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<bool, AppError> {
    let output = run_spec(
        guard,
        git_path_command(git, root, "sequencer/todo"),
        false,
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "operation_failed",
            &output,
            "无法确认拣选是否还有后续提交，未把它标成完成。",
        ));
    }
    let Some(path) = resolved_git_path(root, &output.stdout) else {
        return Err(AppError::new(
            "operation_failed",
            "无法确认拣选是否还有后续提交，未把它标成完成。",
        ));
    };
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => {
            return Err(AppError::new(
                "operation_failed",
                "无法确认拣选是否还有后续提交，未把它标成完成。",
            ))
        }
    };
    Ok(sequencer_todo_has_instruction(&contents))
}

async fn path_exists_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    name: &str,
) -> Result<bool, AppError> {
    let output = run_spec(guard, git_path_command(git, root, name), false, false).await?;
    if output.exit_code != 0 {
        return Ok(false);
    }
    Ok(git_path_exists(root, &output.stdout))
}

async fn ensure_ref(
    backend: &Backend,
    root: &Path,
    git: &Path,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<(), AppError> {
    let (output, _) = run_read(
        backend,
        root,
        generation,
        request_id,
        rev_parse_command(git, root, name),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(AppError::new(
            "branch_missing",
            "找不到来源分支，未开始合并。",
        ));
    }
    Ok(())
}

async fn ref_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    name: &str,
) -> Result<bool, AppError> {
    let output = run_spec(guard, rev_parse_command(git, root, name), false, false).await?;
    Ok(output.exit_code == 0)
}

async fn read_stages(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(u64, BTreeMap<String, Stages>), AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        unmerged_index_command(git, root),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(
            git_failure("status_failed", &output, "无法读取冲突索引。").with_generation(generation)
        );
    }
    Ok((generation, parse_stages(&output.stdout)?))
}

async fn stages_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<BTreeMap<String, Stages>, AppError> {
    let output = run_spec(guard, unmerged_index_command(git, root), false, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure("status_failed", &output, "无法读取冲突索引。"));
    }
    parse_stages(&output.stdout)
}

async fn read_blob(
    backend: &Backend,
    root: &Path,
    git: &Path,
    oid: Option<&str>,
    generation: u64,
    request_id: u64,
    limit: usize,
) -> Result<(u64, SideBytes), AppError> {
    let Some(oid) = oid else {
        return Ok((
            generation,
            SideBytes {
                present: false,
                truncated: false,
                bytes: Vec::new(),
            },
        ));
    };
    let (program, args) = cat_blob_command(git, root, oid);
    let scheduled = backend
        .scheduler
        .execute(crate::git::schedule::GitJob {
            repo_key: repo_key(root),
            kind: JobKind::Read,
            request_id,
            generation,
            program,
            args,
            stdin: None,
            truncate_stdout: true,
            output_limit: Some(limit),
            env: Vec::new(),
        })
        .await?;
    if scheduled.output.exit_code != 0 {
        return Err(
            git_failure("conflict_read", &scheduled.output, "无法读取冲突中的版本。")
                .with_generation(scheduled.generation),
        );
    }
    Ok((
        scheduled.generation,
        SideBytes {
            present: true,
            truncated: scheduled.output.stdout_truncated,
            bytes: scheduled.output.stdout,
        },
    ))
}

async fn blob_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    oid: Option<&str>,
    limit: usize,
) -> Result<SideBytes, AppError> {
    let Some(oid) = oid else {
        return Ok(SideBytes {
            present: false,
            truncated: false,
            bytes: Vec::new(),
        });
    };
    let (program, args) = cat_blob_command(git, root, oid);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: true,
            output_limit: Some(limit),
            writes: false,
        })
        .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "conflict_read",
            &output,
            "无法读取冲突中的版本。",
        ));
    }
    Ok(SideBytes {
        present: true,
        truncated: output.stdout_truncated,
        bytes: output.stdout,
    })
}

fn read_worktree_side(root: &Path, relative: &Path, limit: usize) -> Result<SideBytes, AppError> {
    let target = root.join(relative);
    if !target.exists() {
        return Ok(SideBytes {
            present: false,
            truncated: false,
            bytes: Vec::new(),
        });
    }
    if target
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Ok(SideBytes {
            present: true,
            truncated: false,
            bytes: vec![0],
        });
    }
    let (bytes, truncated) = read_prefix(&target, limit)
        .map_err(|_| AppError::new("conflict_read", "无法读取当前合并结果，未修改仓库。"))?;
    Ok(SideBytes {
        present: true,
        truncated,
        bytes,
    })
}

fn read_prefix(path: &Path, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut file = File::open(path)?;
    let mut buf = vec![0_u8; limit + 1];
    let mut read = 0;
    while read <= limit {
        let size = file.read(&mut buf[read..])?;
        if size == 0 {
            break;
        }
        read += size;
    }
    let truncated = read > limit;
    buf.truncate(read.min(limit));
    Ok((buf, truncated))
}

async fn read_named_file(
    backend: &Backend,
    root: &Path,
    git: &Path,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<(u64, String), AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        git_path_command(git, root, name),
    )
    .await?;
    if output.exit_code != 0 {
        return Ok((generation, String::new()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let path = PathBuf::from(text.trim());
    let full = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    if !full.is_file() {
        return Ok((generation, String::new()));
    }
    let (bytes, _) = read_prefix(&full, MERGE_MSG_LIMIT).unwrap_or((Vec::new(), false));
    Ok((generation, String::from_utf8_lossy(&bytes).into_owned()))
}

async fn read_head_record(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(u64, Option<HeadRecord>), AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        head_record_command(git, root),
    )
    .await?;
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("does not have any commits") {
            return Ok((generation, None));
        }
        return Err(
            git_failure("history_failed", &output, "无法读取当前提交，未撤销。")
                .with_generation(generation),
        );
    }
    Ok((generation, parse_head_record(&output.stdout)?))
}

async fn head_record_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<Option<HeadRecord>, AppError> {
    let output = run_spec(guard, head_record_command(git, root), false, false).await?;
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("does not have any commits") {
            return Ok(None);
        }
        return Err(git_failure(
            "history_failed",
            &output,
            "无法读取当前提交，未撤销。",
        ));
    }
    parse_head_record(&output.stdout)
}

async fn head_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<String, AppError> {
    let output = run_spec(guard, head_command(git, root), false, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure("history_failed", &output, "无法读取 HEAD。"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase())
}

async fn index_dirty(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(u64, bool), AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        cached_diff_quiet_command(git, root),
    )
    .await?;
    match output.exit_code {
        0 => Ok((generation, false)),
        1 => Ok((generation, true)),
        _ => Err(
            git_failure("status_failed", &output, "无法核对暂存区，未撤销。")
                .with_generation(generation),
        ),
    }
}

async fn cached_dirty_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<bool, AppError> {
    let output = run_spec(guard, cached_diff_quiet_command(git, root), false, false).await?;
    match output.exit_code {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(git_failure(
            "status_failed",
            &output,
            "无法核对暂存区，未撤销。",
        )),
    }
}

async fn remote_names(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(u64, Vec<String>), AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        remote_names_command(git, root),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(
            git_failure("undo_unclear", &output, "无法读取远程列表，未撤销提交。")
                .with_generation(generation),
        );
    }
    Ok((generation, parse_remote_names(&output.stdout)?))
}

async fn remote_names_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<Vec<String>, AppError> {
    let output = run_spec(guard, remote_names_command(git, root), false, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "undo_unclear",
            &output,
            "无法读取远程列表，未撤销提交。",
        ));
    }
    parse_remote_names(&output.stdout)
}

async fn stash_oids(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(u64, Vec<String>), AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        request_id,
        stash_list_command(git, root),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(
            git_failure("stash_failed", &output, "无法读取临时保存，未中止合并。")
                .with_generation(generation),
        );
    }
    Ok((generation, parse_stash_oids(&output.stdout)?))
}

async fn stash_oids_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<Vec<String>, AppError> {
    let output = run_spec(guard, stash_list_command(git, root), false, false).await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "stash_failed",
            &output,
            "无法读取临时保存，未继续写入。",
        ));
    }
    parse_stash_oids(&output.stdout)
}

fn command_text(output: &ProcessOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

fn attach_generation(error: AppError, generation: u64) -> AppError {
    if error.generation.is_some() {
        error
    } else {
        error.with_generation(generation)
    }
}

const MAX_CHERRY_PICKS: usize = 100;

pub async fn cherry_pick_commits(
    backend: &Backend,
    path: &str,
    oids: &[String],
    generation: u64,
    request_id: u64,
) -> Result<CherryPickOutcome, AppError> {
    if oids.is_empty() {
        return Err(AppError::new("cherry_pick_empty", "没有选择提交，未拣选。"));
    }
    if oids.len() > MAX_CHERRY_PICKS {
        return Err(AppError::new(
            "cherry_pick_limit",
            "一次最多拣选 100 个提交，未执行。",
        ));
    }
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for oid in oids {
        let oid = history_oid(oid)?;
        if seen.insert(oid.clone()) {
            unique.push(oid);
        }
    }
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let git = require_git(backend).await?;
    let snapshot = read_status(backend, &root, generation, request_id).await?;
    if snapshot.branch.detached || snapshot.branch.unborn || snapshot.branch.name.is_none() {
        return Err(AppError::new(
            "detached",
            "当前不在分支上，不能拣选到当前分支。仓库没有改动。",
        )
        .with_generation(snapshot.generation));
    }
    let operation = operation_from_snapshot(
        backend,
        &root,
        &git.path,
        &snapshot,
        internal_request_id(),
    )
    .await?;
    if operation != "none" {
        return Err(AppError::new(
            "unsupported_operation",
            "已有进行中的合并、变基或拣选，未开始新的拣选。",
        )
        .with_generation(snapshot.generation));
    }
    let commits = load_pick_commits(backend, &root, &git.path, &unique, snapshot.generation).await?;
    if commits.iter().any(|commit| commit.parents.len() != 1) {
        return Err(AppError::new(
            "cherry_pick_merge",
            "合并提交或没有父提交的提交不能拣选，未执行。仓库没有改动。",
        )
        .with_generation(snapshot.generation));
    }
    let mut ordered = commits;
    ordered.sort_by(|left, right| {
        left.authored_at
            .cmp(&right.authored_at)
            .then_with(|| left.oid.cmp(&right.oid))
    });
    let mut skipped = Vec::new();
    let mut todo = Vec::new();
    let mut generation = snapshot.generation;
    for commit in &ordered {
        let (output, next) = run_read(
            backend,
            &root,
            generation,
            internal_request_id(),
            ancestor_command(&git.path, &root, &commit.oid, "HEAD"),
        )
        .await?;
        generation = next;
        if output.exit_code == 0 {
            skipped.push(commit.oid.clone());
        } else if output.exit_code == 1 {
            todo.push(commit.oid.clone());
        } else {
            return Err(git_failure(
                "cherry_pick_failed",
                &output,
                "无法确认提交是否已在当前分支中，未拣选。",
            )
            .with_generation(generation));
        }
    }
    if todo.is_empty() {
        return Ok(CherryPickOutcome {
            generation,
            conflicted: false,
            skipped: skipped.clone(),
            note: only_skipped_note(&skipped),
            snapshot,
        });
    }
    let _gate = backend
        .actions
        .enter(action_key("cherry-pick", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, generation, request_id).await?;
    let outcome = cherry_pick_in_guard(&mut guard, backend, &git.path, &root, &todo, &skipped).await;
    let generation = guard.finish();
    let outcome = outcome.map_err(|error| attach_generation(error, generation))?;
    let snapshot = settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id(),
    )
    .await)?;
    Ok(CherryPickOutcome {
        generation: snapshot.generation,
        conflicted: outcome.0,
        skipped,
        note: outcome.1,
        snapshot,
    })
}

pub async fn checkout_commit(
    backend: &Backend,
    path: &str,
    oid: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let oid = history_oid(oid)?;
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let git = require_git(backend).await?;
    let snapshot = read_status(backend, &root, generation, request_id).await?;
    let operation = operation_from_snapshot(
        backend,
        &root,
        &git.path,
        &snapshot,
        internal_request_id(),
    )
    .await?;
    if operation != "none" {
        return Err(AppError::new(
            "unsupported_operation",
            "已有进行中的合并、变基或拣选，未检出。当前分支没有移动。",
        )
        .with_generation(snapshot.generation));
    }
    let _gate = backend
        .actions
        .enter(action_key("branch", &repo_key(&root)))?;
    let mut guard = write_lock(backend, &root, snapshot.generation, request_id).await?;
    let outcome = detach_in_guard(&mut guard, backend, &git.path, &root, &oid).await;
    let generation = guard.finish();
    outcome.map_err(|error| attach_generation(error, generation))?;
    settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id(),
    )
    .await)
}

async fn load_pick_commits(
    backend: &Backend,
    root: &Path,
    git: &Path,
    oids: &[String],
    generation: u64,
) -> Result<Vec<HistoryCommit>, AppError> {
    let (output, generation) = run_read(
        backend,
        root,
        generation,
        internal_request_id(),
        history_details_command(git, root, oids),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "commit_missing",
            &output,
            "找不到所选提交，未拣选。",
        )
        .with_generation(generation));
    }
    let commits = parse_history_records(&output.stdout)
        .map_err(|error| attach_generation(error, generation))?;
    if oids.iter().any(|oid| commits.iter().all(|commit| commit.oid != *oid)) {
        return Err(AppError::new("commit_missing", "找不到所选提交，未拣选。").with_generation(generation));
    }
    Ok(commits)
}

async fn cherry_pick_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    todo: &[String],
    skipped: &[String],
) -> Result<(bool, String), AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    if snapshot.branch.detached || snapshot.branch.unborn || snapshot.branch.name.is_none() {
        return Err(AppError::new(
            "detached",
            "当前不在分支上，不能拣选到当前分支。仓库没有改动。",
        ));
    }
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if operation != "none" {
        return Err(AppError::new(
            "unsupported_operation",
            "已有进行中的合并、变基或拣选，未开始新的拣选。",
        ));
    }
    let output = run_spec(
        guard,
        cherry_pick_range_command(git, root, todo),
        true,
        false,
    )
    .await?;
    let after = status_in_guard(guard, backend, git, root).await?;
    let after_op = operation_in_guard(guard, git, root, &after).await?;
    if after_op == "cherry-pick" {
        return Ok((true, conflict_note(skipped)));
    }
    if output.exit_code != 0 {
        return Err(classified_git(
            "cherry_pick_failed",
            &output,
            "拣选没有完成。会覆盖未提交修改时不会开始，当前分支应保持原样。",
        ));
    }
    Ok((false, success_note(skipped)))
}

async fn detach_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    oid: &str,
) -> Result<(), AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    let operation = operation_in_guard(guard, git, root, &snapshot).await?;
    if operation != "none" {
        return Err(AppError::new(
            "unsupported_operation",
            "已有进行中的合并、变基或拣选，未检出。当前分支没有移动。",
        ));
    }
    let output = run_spec(guard, detach_at_command(git, root, oid), true, false).await?;
    if output.exit_code != 0 {
        return Err(classified_git(
            "checkout_failed",
            &output,
            "没有检出这个提交。会覆盖未提交修改时不会切换，当前分支和工作区应保持原样。",
        ));
    }
    Ok(())
}

fn oid_list(oids: &[String]) -> String {
    oids.iter()
        .take(8)
        .map(|oid| &oid[..oid.len().min(7)])
        .collect::<Vec<_>>()
        .join("、")
}

fn only_skipped_note(skipped: &[String]) -> String {
    format!(
        "这些提交已经在当前分支中，已跳过，没有新增提交：{}。",
        oid_list(skipped)
    )
}

fn success_note(skipped: &[String]) -> String {
    if skipped.is_empty() {
        "已按从旧到新拣选到当前分支。没有推送。".to_string()
    } else {
        format!(
            "已跳过已在当前分支中的提交：{}。其余提交已按从旧到新拣选。没有推送。",
            oid_list(skipped)
        )
    }
}

fn conflict_note(skipped: &[String]) -> String {
    let skipped = if skipped.is_empty() {
        String::new()
    } else {
        format!("已跳过已在当前分支中的提交：{}。", oid_list(skipped))
    };
    format!("{skipped}拣选停在冲突，更晚的提交还没有应用。解决后可以继续，也可以中止回到拣选前。不能跳过。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

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
        assert!(status.success(), "{args:?}");
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

    fn generation(backend: &Backend, root: &Path) -> u64 {
        backend.scheduler.current_generation(&repo_key(root))
    }

    fn init_pair(repo: &Path) {
        git(repo, &["init", "-b", "main"]);
        fs::write(repo.join("my file.txt"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "other\n").unwrap();
        git(repo, &["add", "--", "my file.txt", "other.txt"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("my file.txt"), "theirs\n").unwrap();
        fs::write(repo.join("other.txt"), "other-theirs\n").unwrap();
        git(repo, &["commit", "-am", "feature"]);
        git(repo, &["checkout", "main"]);
        fs::write(repo.join("my file.txt"), "ours\n").unwrap();
        fs::write(repo.join("other.txt"), "other-ours\n").unwrap();
        git(repo, &["commit", "-am", "ours"]);
    }

    #[test]
    fn stage_parser_keeps_modify_delete_sides() {
        let raw = b"100644 abcdefabcdefabcdefabcdefabcdefabcdefabcd 2\tmy file.txt\0";
        let stages = parse_stages(raw).unwrap();
        assert!(stages["my file.txt"].ours.is_some());
        assert!(stages["my file.txt"].theirs.is_none());
        assert_eq!(stage_kind(&stages["my file.txt"]), "modify_delete");
        let record = parse_head_record(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{1f}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u{1f}subject\n"
                .as_bytes(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(record.parents.len(), 1);
        assert_eq!(record.summary, "subject");
        assert!(parse_head_record(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{1f}\u{1f}root\n".as_bytes(),
        )
        .unwrap()
        .unwrap()
        .parents
        .is_empty());
    }

    #[tokio::test]
    async fn idle_merge_probe_scans_status_once_and_batches_marker_paths() {
        let fixture = crate::test_support::git_fixture("merge-probe-cost");
        let trace = fixture.path().join("git-trace.log");
        let backend = fixture
            .backend_with_extra_env(vec![("GIT_TRACE".into(), trace.as_os_str().to_os_string())]);
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        let session = merge_session(&backend, &repo_key(&repo), generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert_eq!(session.operation, "none");
        let log = fs::read_to_string(trace).unwrap();
        let statuses = log
            .lines()
            .filter(|line| line.contains("built-in: git status "))
            .count();
        let paths = log
            .lines()
            .filter(|line| line.contains("built-in: git rev-parse "))
            .count();
        assert_eq!(
            statuses, 1,
            "a merge probe must not scan the worktree twice"
        );
        assert_eq!(paths, 1, "resolve all sequencer paths with one Git process");
    }

    #[tokio::test]
    async fn merge_into_another_branch_switches_first_and_can_fast_forward() {
        let fixture = crate::test_support::git_fixture("merge-reverse");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(
            repo.join("a.txt"),
            "base
",
        )
        .unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(
            repo.join("b.txt"),
            "feature
",
        )
        .unwrap();
        git(&repo, &["add", "--", "b.txt"]);
        git(&repo, &["commit", "-m", "add b"]);
        let path = repo_key(&repo);

        // 站在 feature 上，把 feature 合并到 main：预览只读，不切换分支。
        let preview = merge_preview(
            &backend,
            &path,
            "feature",
            Some("main"),
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert!(preview.can_start, "{}", preview.note);
        assert!(preview.needs_switch);
        assert_eq!(preview.current.as_deref(), Some("feature"));
        assert_eq!(preview.incoming, 1);
        assert_eq!(preview.outgoing, 0);
        assert!(preview.fast_forward);
        assert_eq!(preview.conflict_check, "clean");
        assert_eq!(git_text(&repo, &["branch", "--show-current"]), "feature");

        // 远程或不存在的本地分支不能作为目标。
        let remote = merge_preview(
            &backend,
            &path,
            "main",
            Some("origin/main"),
            generation(&backend, &repo),
            2,
        )
        .await
        .unwrap();
        assert!(!remote.can_start);
        assert_eq!(remote.blocker.as_deref(), Some("remote_target"));

        let session = start_merge(
            &backend,
            &path,
            "feature",
            Some("main"),
            Some("ff-only"),
            preview.generation,
            3,
        )
        .await
        .unwrap();
        assert_eq!(session.operation, "none");
        assert!(session.fast_forwarded);
        assert_eq!(session.switched_from.as_deref(), Some("feature"));
        assert_eq!(git_text(&repo, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_text(&repo, &["rev-parse", "main"]),
            git_text(&repo, &["rev-parse", "feature"])
        );

        // 合并完成后目标已包含来源：再次预览明确提示不需要合并。
        let again = merge_preview(
            &backend,
            &path,
            "feature",
            Some("main"),
            session.generation,
            4,
        )
        .await
        .unwrap();
        assert!(!again.can_start);
        assert!(again.up_to_date);
        assert_eq!(again.blocker.as_deref(), Some("up_to_date"));
    }

    #[test]
    fn merge_tree_conflict_output_lists_unique_paths() {
        let raw = b"0123456789abcdef0123456789abcdef01234567\0a.txt\0dir/b c.txt\0a.txt\0\0";
        assert_eq!(
            parse_merge_tree_conflicts(raw),
            vec!["a.txt".to_string(), "dir/b c.txt".to_string()]
        );
        assert_eq!(parse_divergence(b"3\t5\n").unwrap(), (3, 5));
        assert!(parse_divergence(b"oops").is_err());
    }

    #[tokio::test]
    async fn text_merge_edits_one_file_and_blocks_until_both_are_resolved() {
        let fixture = crate::test_support::git_fixture("merge-text");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        init_pair(&repo);
        let path = repo_key(&repo);
        let generation = generation(&backend, &repo);
        let preview = merge_preview(&backend, &path, "feature", None, generation, 1)
            .await
            .unwrap();
        assert_eq!(preview.source, "feature");
        assert_eq!(preview.target, "main");
        assert!(!preview.dirty);
        assert!(preview.can_start);
        assert!(preview.note.contains("feature"));
        assert!(!preview.needs_switch);
        assert_eq!(preview.incoming, 1);
        assert_eq!(preview.outgoing, 1);
        assert!(!preview.fast_forward);
        assert_eq!(preview.commits.len(), 1);
        assert_eq!(preview.commits[0].summary, "feature");
        assert_eq!(preview.files_total, 2);
        assert_eq!(preview.conflict_check, "conflicts");
        assert!(preview
            .conflict_paths
            .iter()
            .any(|path| path == "my file.txt"));
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        let session = start_merge(
            &backend,
            &path,
            "feature",
            None,
            None,
            preview.generation,
            2,
        )
        .await
        .unwrap();
        assert_eq!(session.operation, "merge");
        assert_eq!(session.unresolved, 2);
        assert!(!session.can_continue);
        assert!(session.can_abort);
        assert!(repo.join(".git/MERGE_HEAD").exists());
        let blocked = complete_merge(&backend, &path, "应该失败", session.generation, 3)
            .await
            .unwrap_err();
        assert_eq!(blocked.code, "conflicts_open");
        assert!(fs::read_to_string(repo.join("my file.txt"))
            .unwrap()
            .contains("<<<<<<<"));
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "ours");
        let view = conflict_view(&backend, &path, "my file.txt", session.generation, 4)
            .await
            .unwrap();
        assert_eq!(view.kind, "text");
        assert!(view.editable);
        assert_eq!(view.ours.text.as_deref(), Some("ours\n"));
        assert_eq!(view.theirs.text.as_deref(), Some("theirs\n"));
        assert!(view.result.text.unwrap().contains("<<<<<<<"));
        let resolved = resolve_conflict(
            &backend,
            &path,
            "my file.txt",
            "text",
            Some("final\n".to_string()),
            session.generation,
            5,
        )
        .await
        .unwrap();
        assert_eq!(resolved.unresolved, 1);
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "final\n"
        );
        assert!(fs::read_to_string(repo.join("other.txt"))
            .unwrap()
            .contains("<<<<<<<"));
        let still = complete_merge(&backend, &path, "还不行", resolved.generation, 6)
            .await
            .unwrap_err();
        assert_eq!(still.code, "conflicts_open");
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "final\n"
        );
        let both = resolve_conflict(
            &backend,
            &path,
            "other.txt",
            "ours",
            None,
            resolved.generation,
            7,
        )
        .await
        .unwrap();
        assert_eq!(both.unresolved, 0);
        assert!(both.can_continue);
        let done = complete_merge(&backend, &path, "合并结果", both.generation, 8)
            .await
            .unwrap();
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert_eq!(
            done.snapshot.branch.head_oid.as_deref(),
            Some(done.oid.as_str())
        );
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "final\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "other-ours\n"
        );
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "合并结果");
        assert_eq!(
            git_text(&repo, &["log", "-1", "--format=%P"])
                .split_whitespace()
                .count(),
            2
        );
        let quiet = merge_session(&backend, &path, done.generation, 9)
            .await
            .unwrap();
        assert_eq!(quiet.operation, "none");
        assert!(!quiet.can_abort);
    }

    #[tokio::test]
    async fn hook_rejection_keeps_the_resolved_file_and_message_is_not_committed() {
        let fixture = crate::test_support::git_fixture("merge-hook");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        init_pair(&repo);
        let path = repo_key(&repo);
        let session = start_merge(
            &backend,
            &path,
            "feature",
            None,
            None,
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        let first = resolve_conflict(
            &backend,
            &path,
            "my file.txt",
            "text",
            Some("kept\n".to_string()),
            session.generation,
            2,
        )
        .await
        .unwrap();
        let ready = resolve_conflict(
            &backend,
            &path,
            "other.txt",
            "theirs",
            None,
            first.generation,
            3,
        )
        .await
        .unwrap();
        let hook = repo.join(".git/hooks/commit-msg");
        fs::write(&hook, "#!/bin/sh\necho hook refused >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).unwrap();
        }
        let rejected = complete_merge(&backend, &path, "保留的说明", ready.generation, 4)
            .await
            .unwrap_err();
        assert_eq!(rejected.code, "hook_rejected");
        assert!(rejected.message.contains("保留"));
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "kept\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "other-theirs\n"
        );
        assert!(repo.join(".git/MERGE_HEAD").exists());
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "ours");
        fs::remove_file(&hook).unwrap();
        let done = complete_merge(
            &backend,
            &path,
            "保留的说明",
            rejected.generation.unwrap(),
            5,
        )
        .await
        .unwrap();
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "保留的说明");
        assert_eq!(fs::read(repo.join("my file.txt")).unwrap(), b"kept\n");
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert!(done.files.iter().any(|file| file == "my file.txt"));
    }

    #[tokio::test]
    async fn binary_choice_and_modify_delete_follow_the_selected_side() {
        let fixture = crate::test_support::git_fixture("merge-binary");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("bin.dat"), b"bin\0ours").unwrap();
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        fs::write(repo.join("gone.txt"), "base-gone\n").unwrap();
        git(&repo, &["add", "--", "bin.dat", "file.txt", "gone.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("bin.dat"), b"bin\0theirs").unwrap();
        git(&repo, &["rm", "file.txt"]);
        fs::write(repo.join("gone.txt"), "theirs-gone\n").unwrap();
        git(&repo, &["add", "--", "bin.dat", "gone.txt"]);
        git(&repo, &["commit", "-m", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("bin.dat"), b"bin\0local").unwrap();
        fs::write(repo.join("file.txt"), "ours-file\n").unwrap();
        git(&repo, &["rm", "gone.txt"]);
        git(&repo, &["add", "--", "bin.dat", "file.txt"]);
        git(&repo, &["commit", "-m", "ours"]);
        let path = repo_key(&repo);
        let session = start_merge(
            &backend,
            &path,
            "feature",
            None,
            None,
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        let binary = conflict_view(&backend, &path, "bin.dat", session.generation, 2)
            .await
            .unwrap();
        assert_eq!(binary.kind, "binary");
        assert!(!binary.editable);
        assert!(binary.ours.text.is_none());
        assert!(binary.note.contains("二进制"));
        let text_choice = resolve_conflict(
            &backend,
            &path,
            "bin.dat",
            "text",
            Some("nope".to_string()),
            session.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(text_choice.code, "resolve_binary");
        assert!(fs::read(repo.join("bin.dat")).unwrap().contains(&0));
        let after_bin = resolve_conflict(
            &backend,
            &path,
            "bin.dat",
            "theirs",
            None,
            session.generation,
            4,
        )
        .await
        .unwrap();
        assert_eq!(fs::read(repo.join("bin.dat")).unwrap(), b"bin\0theirs");
        let modify_delete = conflict_view(&backend, &path, "file.txt", after_bin.generation, 5)
            .await
            .unwrap();
        assert_eq!(modify_delete.kind, "modify_delete");
        let delete_modify = conflict_view(&backend, &path, "gone.txt", after_bin.generation, 6)
            .await
            .unwrap();
        assert_eq!(delete_modify.kind, "delete_modify");
        let kept = resolve_conflict(
            &backend,
            &path,
            "file.txt",
            "ours",
            None,
            after_bin.generation,
            7,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "ours-file\n"
        );
        let deleted = resolve_conflict(
            &backend,
            &path,
            "gone.txt",
            "delete",
            None,
            kept.generation,
            8,
        )
        .await
        .unwrap();
        assert_eq!(deleted.unresolved, 0);
        let done = complete_merge(&backend, &path, "选择版本", deleted.generation, 9)
            .await
            .unwrap();
        assert_eq!(fs::read(repo.join("bin.dat")).unwrap(), b"bin\0theirs");
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "ours-file\n"
        );
        assert!(!repo.join("gone.txt").exists());
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert!(done.summary.contains("完成"));
    }

    #[tokio::test]
    async fn dirty_worktree_is_not_merged_and_abort_restores_without_dropping_stash() {
        let fixture = crate::test_support::git_fixture("merge-abort");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        init_pair(&repo);
        fs::write(repo.join("notes.txt"), "stashed\n").unwrap();
        git(&repo, &["add", "--", "notes.txt"]);
        git(&repo, &["stash", "push", "-m", "keep-me"]);
        let stashed = git_text(&repo, &["rev-parse", "stash@{0}"]);
        fs::write(repo.join("other.txt"), "dirty\n").unwrap();
        // 未跟踪文件不算阻止合并的本地改动。
        fs::write(repo.join("scratch.txt"), "untracked\n").unwrap();
        let path = repo_key(&repo);
        let generation = generation(&backend, &repo);
        let preview = merge_preview(&backend, &path, "feature", None, generation, 1)
            .await
            .unwrap();
        assert!(preview.dirty);
        assert!(!preview.can_start);
        assert_eq!(preview.blocker.as_deref(), Some("dirty"));
        assert_eq!(preview.local_paths, vec!["other.txt".to_string()]);
        assert!(preview.note.contains("临时保存"));
        let refused = start_merge(
            &backend,
            &path,
            "feature",
            None,
            None,
            preview.generation,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "merge_dirty");
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "dirty\n"
        );
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        git(&repo, &["checkout", "--", "other.txt"]);
        let untracked_only = merge_preview(
            &backend,
            &path,
            "feature",
            None,
            refused.generation.unwrap(),
            6,
        )
        .await
        .unwrap();
        assert!(untracked_only.can_start, "{}", untracked_only.note);
        assert!(!untracked_only.dirty);
        let head = git_text(&repo, &["rev-parse", "HEAD"]);
        let session = start_merge(
            &backend,
            &path,
            "feature",
            None,
            None,
            untracked_only.generation,
            3,
        )
        .await
        .unwrap();
        fs::write(repo.join("my file.txt"), "edited during merge\n").unwrap();
        let impact = abort_merge(&backend, &path, false, session.generation, 4)
            .await
            .unwrap();
        assert!(!impact.wrote);
        assert!(impact.paths.iter().any(|item| item == "my file.txt"));
        assert!(impact.note.contains("取消不会写入"));
        assert!(impact.stash_oids.iter().any(|oid| oid == &stashed));
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "edited during merge\n"
        );
        assert!(repo.join(".git/MERGE_HEAD").exists());
        let aborted = abort_merge(&backend, &path, true, impact.generation, 5)
            .await
            .unwrap();
        assert!(aborted.wrote);
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "ours\n"
        );
        assert_eq!(git_text(&repo, &["rev-parse", "stash@{0}"]), stashed);
        assert!(aborted.stash_oids.iter().any(|oid| oid == &stashed));
    }

    #[tokio::test]
    async fn external_sequencer_and_stash_conflicts_are_not_merge_actions() {
        let fixture = crate::test_support::git_fixture("merge-external");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("file.txt"), "feature\n").unwrap();
        git(&repo, &["commit", "-am", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("file.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-am", "main"]);
        let path = repo_key(&repo);
        let status = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["cherry-pick", "feature"])
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
        assert!(!status.success());
        assert!(repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        let session = merge_session(&backend, &path, generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert_eq!(session.operation, "cherry-pick");
        assert!(session.can_abort);
        assert!(!session.can_continue);
        assert!(session.note.contains("cherry-pick"));
        assert!(session.note.contains("不能跳过"));
        let blocked = complete_merge(&backend, &path, "nope", session.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(blocked.code, "conflicts_open");
        assert!(repo.join(".git/CHERRY_PICK_HEAD").exists());
        let preview = abort_merge(&backend, &path, false, blocked.generation.unwrap(), 3)
            .await
            .unwrap();
        assert!(!preview.wrote);
        assert!(preview.note.contains("取消不会写入"));
        let main_tip = git_text(&repo, &["rev-parse", "refs/heads/main"]);
        let aborted = abort_merge(&backend, &path, true, preview.generation, 4)
            .await
            .unwrap();
        assert!(aborted.wrote);
        assert!(!repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), main_tip);
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        let again = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["cherry-pick", "feature"])
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
        assert!(!again.success());
        let paused = merge_session(&backend, &path, generation(&backend, &repo), 5)
            .await
            .unwrap();
        let resolved = resolve_conflict(
            &backend,
            &path,
            "file.txt",
            "text",
            Some("picked\n".to_string()),
            paused.generation,
            6,
        )
        .await
        .unwrap();
        assert_eq!(resolved.unresolved, 0);
        assert!(resolved.can_continue);
        let done = complete_merge(
            &backend,
            &path,
            "should-not-replace-the-subject",
            resolved.generation,
            7,
        )
        .await
        .unwrap();
        assert!(done.summary.contains("没有推送"));
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "feature");
        assert_eq!(
            git_text(&repo, &["log", "-1", "--format=%P"]),
            main_tip
        );
        assert!(!repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "picked\n");
        fs::write(repo.join("file.txt"), "local\n").unwrap();
        git(&repo, &["stash", "push", "-m", "wip"]);
        fs::write(repo.join("file.txt"), "other\n").unwrap();
        git(&repo, &["commit", "-am", "other"]);
        let apply = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["stash", "apply"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .status()
            .unwrap();
        assert!(!apply.success());
        let stash = merge_session(&backend, &path, generation(&backend, &repo), 8)
            .await
            .unwrap();
        assert_eq!(stash.operation, "unmerged");
        assert!(!stash.can_abort);
        assert!(stash.note.contains("不是合并"));
        let refused = abort_merge(&backend, &path, false, stash.generation, 9)
            .await
            .unwrap_err();
        assert_eq!(refused.code, "unsupported_operation");
        assert!(!repo.join(".git/MERGE_HEAD").exists());
    }

    #[test]
    fn sequencer_todo_with_a_later_pick_is_not_finished() {
        let todo = "pick abcdef1 one\npick abcdef2 two\nhint: already committed\n# comment\n";
        assert!(sequencer_todo_has_instruction(todo));
        assert!(!sequencer_todo_has_instruction("hint: nothing\n# done\n\n"));
        assert!(!sequencer_todo_has_instruction(""));
    }

    #[tokio::test]
    async fn multi_commit_cherry_pick_continue_keeps_later_commits() {
        let fixture = crate::test_support::git_fixture("cherry-pick-two");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "base\n").unwrap();
        fs::write(repo.join("b.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "a.txt", "b.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("a.txt"), "feature-a\n").unwrap();
        git(&repo, &["commit", "-am", "one"]);
        fs::write(repo.join("b.txt"), "feature-b\n").unwrap();
        git(&repo, &["commit", "-am", "two"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("a.txt"), "main-a\n").unwrap();
        git(&repo, &["commit", "-am", "main-a"]);
        fs::write(repo.join("b.txt"), "main-b\n").unwrap();
        git(&repo, &["commit", "-am", "main-b"]);
        let one = git_text(&repo, &["rev-parse", "feature~1"]);
        let two = git_text(&repo, &["rev-parse", "feature"]);
        let main_tip = git_text(&repo, &["rev-parse", "HEAD"]);
        let started = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["cherry-pick", &one, &two])
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
        assert!(!started.success());
        assert!(repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert!(repo.join(".git/sequencer/todo").exists());
        let path = repo_key(&repo);
        let session = merge_session(&backend, &path, generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert_eq!(session.operation, "cherry-pick");
        assert!(session.can_abort);
        assert!(!session.can_continue);
        assert!(session.note.contains("不能跳过"));
        let resolved = resolve_conflict(
            &backend,
            &path,
            "a.txt",
            "text",
            Some("a-ok\n".to_string()),
            session.generation,
            2,
        )
        .await
        .unwrap();
        assert_eq!(resolved.unresolved, 0);
        assert!(resolved.can_continue);
        let paused = complete_merge(
            &backend,
            &path,
            "should-not-finish-the-sequence",
            resolved.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(paused.code, "sequencer_paused");
        assert!(paused.message.contains("不能算完成"));
        assert!(repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert!(repo.join(".git/sequencer/todo").exists());
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "one");
        assert_eq!(
            git_text(&repo, &["log", "-1", "--format=%P"]),
            main_tip
        );
        let mid = merge_session(&backend, &path, paused.generation.unwrap(), 4)
            .await
            .unwrap();
        assert_eq!(mid.operation, "cherry-pick");
        assert!(mid.can_abort);
        assert!(mid.unresolved > 0);
        assert!(!mid.can_continue);
        let resolved_next = resolve_conflict(
            &backend,
            &path,
            "b.txt",
            "text",
            Some("b-ok\n".to_string()),
            mid.generation,
            5,
        )
        .await
        .unwrap();
        assert_eq!(resolved_next.unresolved, 0);
        assert!(resolved_next.can_continue);
        let done = complete_merge(
            &backend,
            &path,
            "should-not-replace-the-subject",
            resolved_next.generation,
            6,
        )
        .await
        .unwrap();
        assert!(done.summary.contains("没有推送"));
        assert_eq!(git_text(&repo, &["log", "-2", "--format=%s"]), "two\none");
        assert_eq!(
            git_text(&repo, &["log", "-1", "--format=%P", "HEAD~1"]),
            main_tip
        );
        assert!(!repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert!(!repo.join(".git/sequencer").exists());
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "a-ok\n");
        assert_eq!(fs::read_to_string(repo.join("b.txt")).unwrap(), "b-ok\n");
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    }

    fn commit_dated(repo: &Path, message: &str, date: &str) {
        let name = format!("{message}.txt");
        fs::write(repo.join(&name), format!("{message}\n")).unwrap();
        git(repo, &["add", "--", &name]);
        let status = Command::new(crate::test_support::system_git())
            .current_dir(repo)
            .args(["commit", "-m", message])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .status()
            .unwrap();
        assert!(status.success(), "{message}");
    }

    fn commit_at(repo: &Path, message: &str, date: &str) {
        let status = Command::new(crate::test_support::system_git())
            .current_dir(repo)
            .args(["commit", "-m", message])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .status()
            .unwrap();
        assert!(status.success(), "{message}");
    }

    #[tokio::test]
    async fn cherry_pick_applies_oldest_first_skips_ancestors_and_abort_restores() {
        let fixture = crate::test_support::git_fixture("history-cherry-pick");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["rev-parse", "HEAD"]);
        commit_dated(&repo, "already", "1000000100 +0000");
        let already = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "-b", "feature", &base]);
        commit_dated(&repo, "newer", "1000000300 +0000");
        let newer = git_text(&repo, &["rev-parse", "HEAD"]);
        commit_dated(&repo, "older", "1000000200 +0000");
        let older = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        let path = repo_key(&repo);
        let started = cherry_pick_commits(
            &backend,
            &path,
            &[newer.clone(), already.clone(), older.clone()],
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert!(!started.conflicted);
        assert_eq!(started.skipped, vec![already.clone()]);
        assert!(started.note.contains("已跳过"));
        assert_eq!(git_text(&repo, &["log", "-3", "--format=%s"]), "newer\nolder\nalready");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD~1~1"]), already);
        let main_tip = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "-b", "side", &base]);
        fs::write(repo.join("a.txt"), "side-a\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        commit_at(&repo, "side-a", "2000000100 +0000");
        fs::write(repo.join("b.txt"), "side-b\n").unwrap();
        git(&repo, &["add", "--", "b.txt"]);
        commit_at(&repo, "side-b", "2000000200 +0000");
        let side_old = git_text(&repo, &["rev-parse", "HEAD~1"]);
        let side_new = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("a.txt"), "main-a\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "main-a"]);
        let tip_before = git_text(&repo, &["rev-parse", "HEAD"]);
        let conflicted = cherry_pick_commits(
            &backend,
            &path,
            &[side_new, side_old],
            generation(&backend, &repo),
            2,
        )
        .await
        .unwrap();
        assert!(conflicted.conflicted);
        assert!(conflicted.note.contains("更晚的提交还没有应用"));
        assert!(conflicted.note.contains("不能跳过"));
        assert_ne!(fs::read_to_string(repo.join("b.txt")).unwrap_or_default(), "side-b\n");
        let session = merge_session(&backend, &path, conflicted.generation, 3)
            .await
            .unwrap();
        assert_eq!(session.operation, "cherry-pick");
        assert!(session.can_abort);
        let aborted = abort_merge(&backend, &path, true, session.generation, 4)
            .await
            .unwrap();
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), tip_before);
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert!(!repo.join(".git/CHERRY_PICK_HEAD").exists());
        assert_eq!(aborted.snapshot.branch.name.as_deref(), Some("main"));
        let _ = main_tip;
    }

    #[tokio::test]
    async fn checkout_commit_detaches_and_refuses_to_overwrite() {
        let fixture = crate::test_support::git_fixture("history-checkout");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("file.txt"), "next\n").unwrap();
        git(&repo, &["commit", "-am", "next"]);
        let path = repo_key(&repo);
        fs::write(repo.join("file.txt"), "dirty\n").unwrap();
        let blocked = checkout_commit(&backend, &path, &base, generation(&backend, &repo), 1)
            .await
            .unwrap_err();
        assert_eq!(blocked.code, "local_changes");
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "dirty\n");
        fs::write(repo.join("file.txt"), "next\n").unwrap();
        let detached = checkout_commit(&backend, &path, &base, blocked.generation.unwrap(), 2)
            .await
            .unwrap();
        assert!(detached.branch.detached);
        assert_eq!(detached.branch.head_oid.as_deref(), Some(base.as_str()));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), base);
    }

    #[tokio::test]
    async fn rebase_in_progress_is_reported_without_actions() {
        let fixture = crate::test_support::git_fixture("merge-rebase");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("file.txt"), "feature\n").unwrap();
        git(&repo, &["commit", "-am", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("file.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-am", "main"]);
        git(&repo, &["checkout", "feature"]);
        let status = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["rebase", "main"])
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
        assert!(!status.success());
        let session = merge_session(&backend, &repo_key(&repo), generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert_eq!(session.operation, "rebase");
        assert!(session.can_abort);
        assert!(!session.can_continue);
        assert!(session.note.contains("rebase"));
        assert!(session.note.contains("不能跳过"));
        let tip = git_text(&repo, &["rev-parse", "refs/heads/feature"]);
        let refused = complete_merge(&backend, &repo_key(&repo), "no", session.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(refused.code, "conflicts_open");
        assert_eq!(git_text(&repo, &["rev-parse", "refs/heads/feature"]), tip);
        let preview = abort_merge(&backend, &repo_key(&repo), false, refused.generation.unwrap(), 3)
            .await
            .unwrap();
        assert!(preview.note.contains("取消不会写入"));
        let aborted = abort_merge(&backend, &repo_key(&repo), true, preview.generation, 4)
            .await
            .unwrap();
        assert!(aborted.wrote);
        assert!(!repo.join(".git/rebase-merge").exists());
        assert!(!repo.join(".git/rebase-apply").exists());
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), tip);
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/feature");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "feature\n");
    }

    #[tokio::test]
    async fn clean_rebase_replays_unique_commits_without_pushing() {
        let fixture = crate::test_support::git_fixture("rebase-clean");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        let bare = fixture.path().join("origin.git");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "base.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare"]);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        git(&repo, &["add", "--", "feature.txt"]);
        git(&repo, &["commit", "-m", "feature only"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("main.txt"), "main\n").unwrap();
        git(&repo, &["add", "--", "main.txt"]);
        git(&repo, &["commit", "-m", "main only"]);
        let origin = git_text(&bare, &["rev-parse", "main"]);
        git(&repo, &["checkout", "feature"]);
        let path = repo_key(&repo);
        let session = start_merge(
            &backend,
            &path,
            "main",
            None,
            Some("rebase"),
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert!(session.rebased, "{}", session.note);
        assert_eq!(session.operation, "none");
        assert_eq!(session.snapshot.branch.name.as_deref(), Some("feature"));
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "feature only");
        let parents = git_text(&repo, &["log", "-1", "--format=%P"]);
        assert_eq!(parents.split_whitespace().count(), 1);
        assert_eq!(parents, git_text(&repo, &["rev-parse", "main"]));
        assert_eq!(fs::read_to_string(repo.join("feature.txt")).unwrap(), "feature\n");
        assert_eq!(fs::read_to_string(repo.join("main.txt")).unwrap(), "main\n");
        assert_eq!(git_text(&bare, &["rev-parse", "main"]), origin);
        assert!(!repo.join(".git/rebase-merge").exists());
    }

    #[tokio::test]
    async fn rebase_conflict_continue_keeps_the_original_message() {
        let fixture = crate::test_support::git_fixture("rebase-conflict");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        let bare = fixture.path().join("origin.git");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare"]);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("file.txt"), "feature\n").unwrap();
        git(&repo, &["commit", "-am", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("file.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-am", "main"]);
        let origin = git_text(&bare, &["rev-parse", "main"]);
        git(&repo, &["checkout", "feature"]);
        let path = repo_key(&repo);
        let session = start_merge(
            &backend,
            &path,
            "main",
            None,
            Some("rebase"),
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert!(!session.rebased);
        assert_eq!(session.operation, "rebase");
        assert!(session.unresolved > 0);
        assert!(!session.can_continue);
        let blocked = complete_merge(&backend, &path, "rewritten subject", session.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(blocked.code, "conflicts_open");
        assert!(repo.join(".git/rebase-merge").exists() || repo.join(".git/rebase-apply").exists());
        let resolved = resolve_conflict(
            &backend,
            &path,
            "file.txt",
            "text",
            Some("resolved\n".to_string()),
            blocked.generation.unwrap(),
            3,
        )
        .await
        .unwrap();
        assert_eq!(resolved.unresolved, 0);
        assert!(resolved.can_continue);
        let done = complete_merge(
            &backend,
            &path,
            "rewritten subject",
            resolved.generation,
            4,
        )
        .await
        .unwrap();
        assert!(done.summary.contains("没有推送"));
        assert_eq!(git_text(&repo, &["log", "-1", "--format=%s"]), "feature");
        assert_eq!(
            git_text(&repo, &["log", "-1", "--format=%P"]),
            git_text(&repo, &["rev-parse", "main"])
        );
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/feature");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "resolved\n");
        assert_eq!(git_text(&bare, &["rev-parse", "main"]), origin);
        assert!(!repo.join(".git/rebase-merge").exists());
    }

    #[tokio::test]
    async fn rebase_second_conflict_is_not_complete_and_abort_restores_the_tip() {
        let fixture = crate::test_support::git_fixture("rebase-two");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "base\n").unwrap();
        fs::write(repo.join("b.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "a.txt", "b.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("a.txt"), "feature-a\n").unwrap();
        git(&repo, &["commit", "-am", "one"]);
        fs::write(repo.join("b.txt"), "feature-b\n").unwrap();
        git(&repo, &["commit", "-am", "two"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("a.txt"), "main-a\n").unwrap();
        git(&repo, &["commit", "-am", "main-a"]);
        fs::write(repo.join("b.txt"), "main-b\n").unwrap();
        git(&repo, &["commit", "-am", "main-b"]);
        git(&repo, &["checkout", "feature"]);
        let tip = git_text(&repo, &["rev-parse", "HEAD"]);
        let path = repo_key(&repo);
        let session = start_merge(
            &backend,
            &path,
            "main",
            None,
            Some("rebase"),
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert_eq!(session.operation, "rebase");
        assert!(session.unresolved > 0);
        let resolved = resolve_conflict(
            &backend,
            &path,
            "a.txt",
            "text",
            Some("a-ok\n".to_string()),
            session.generation,
            2,
        )
        .await
        .unwrap();
        let paused = complete_merge(&backend, &path, "ignored", resolved.generation, 3)
            .await
            .unwrap_err();
        assert_eq!(paused.code, "sequencer_paused");
        let mid = merge_session(&backend, &path, paused.generation.unwrap(), 4)
            .await
            .unwrap();
        assert_eq!(mid.operation, "rebase");
        assert!(mid.unresolved > 0);
        assert!(!mid.can_continue);
        let aborted = abort_merge(&backend, &path, true, mid.generation, 5)
            .await
            .unwrap();
        assert!(aborted.wrote);
        assert!(aborted.note.contains("操作前"));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), tip);
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/feature");
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "feature-a\n");
        assert_eq!(fs::read_to_string(repo.join("b.txt")).unwrap(), "feature-b\n");
        assert!(!repo.join(".git/rebase-merge").exists());
        let after = merge_session(&backend, &path, aborted.generation, 6)
            .await
            .unwrap();
        assert_eq!(after.operation, "none");
    }

    #[tokio::test]
    async fn dirty_worktree_does_not_start_rebase() {
        let fixture = crate::test_support::git_fixture("rebase-dirty");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("file.txt"), "feature\n").unwrap();
        git(&repo, &["commit", "-am", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("other.txt"), "main\n").unwrap();
        git(&repo, &["add", "--", "other.txt"]);
        git(&repo, &["commit", "-m", "main"]);
        git(&repo, &["checkout", "feature"]);
        let tip = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("file.txt"), "dirty\n").unwrap();
        let path = repo_key(&repo);
        let dirty = start_merge(
            &backend,
            &path,
            "main",
            None,
            Some("rebase"),
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(dirty.code, "merge_dirty");
        assert!(!repo.join(".git/rebase-merge").exists());
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), tip);
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "dirty\n");
        git(&repo, &["checkout", "--", "file.txt"]);
        fs::write(repo.join("other.txt"), "untracked\n").unwrap();
        let blocked = start_merge(
            &backend,
            &path,
            "main",
            None,
            Some("rebase"),
            generation(&backend, &repo),
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.code, "local_changes");
        assert!(!repo.join(".git/rebase-merge").exists());
        assert!(!repo.join(".git/rebase-apply").exists());
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), tip);
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/feature");
        assert_eq!(fs::read_to_string(repo.join("other.txt")).unwrap(), "untracked\n");
    }

    #[tokio::test]
    async fn rebase_does_not_switch_when_the_target_is_another_branch() {
        let fixture = crate::test_support::git_fixture("rebase-target");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        git(&repo, &["add", "--", "feature.txt"]);
        git(&repo, &["commit", "-m", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("main.txt"), "main\n").unwrap();
        git(&repo, &["add", "--", "main.txt"]);
        git(&repo, &["commit", "-m", "main"]);
        git(&repo, &["checkout", "-b", "side"]);
        git(&repo, &["checkout", "feature"]);
        let tip = git_text(&repo, &["rev-parse", "HEAD"]);
        let path = repo_key(&repo);
        let refused = start_merge(
            &backend,
            &path,
            "main",
            Some("side"),
            Some("rebase"),
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "rebase_target");
        assert_eq!(git_text(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/feature");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), tip);
        assert!(!repo.join(".git/rebase-merge").exists());
    }

    #[tokio::test]
    async fn undo_keeps_unpushed_changes_and_refuses_unsafe_history() {
        let fixture = crate::test_support::git_fixture("undo-commit");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        let bare = fixture.path().join("remote.git");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "root\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "root"]);
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare"]);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        let root_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("a.txt"), "local\n").unwrap();
        git(&repo, &["commit", "-am", "local"]);
        let local_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        let path = repo_key(&repo);
        let generation = generation(&backend, &repo);
        let preview = undo_commit(&backend, &path, &local_oid, false, generation, 1)
            .await
            .unwrap();
        assert!(preview.eligible);
        assert!(!preview.wrote);
        assert_eq!(preview.code, "ok");
        assert!(preview.reason.contains("tag"));
        assert!(preview.reason.contains("推送记录"));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), local_oid);
        let undone = undo_commit(&backend, &path, &local_oid, true, preview.generation, 2)
            .await
            .unwrap();
        assert!(undone.wrote);
        assert_eq!(
            undone.snapshot.branch.head_oid.as_deref(),
            Some(root_oid.as_str())
        );
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "local\n");
        assert_eq!(
            git_text(&repo, &["diff", "--cached", "--name-only"]),
            "a.txt"
        );
        git(&repo, &["commit", "-m", "local again"]);
        let again = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["push", "origin", "main"]);
        let pushed = undo_commit(&backend, &path, &again, true, undone.generation, 3)
            .await
            .unwrap_err();
        assert_eq!(pushed.code, "undo_pushed");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), again);
        let mismatch = undo_commit(
            &backend,
            &path,
            &root_oid,
            true,
            pushed.generation.unwrap(),
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(mismatch.code, "undo_head_changed");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), again);
        fs::write(repo.join("a.txt"), "staged\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        let dirty = undo_commit(
            &backend,
            &path,
            &again,
            true,
            mismatch.generation.unwrap(),
            5,
        )
        .await
        .unwrap_err();
        assert_eq!(dirty.code, "undo_dirty_index");
        assert_eq!(
            git_text(&repo, &["diff", "--cached", "--name-only"]),
            "a.txt"
        );
        git(&repo, &["reset", "--hard", "HEAD"]);
        git(&repo, &["remote", "add", "other", bare.to_str().unwrap()]);
        let unclear = undo_commit(&backend, &path, &again, true, dirty.generation.unwrap(), 6)
            .await
            .unwrap_err();
        assert_eq!(unclear.code, "undo_unclear");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), again);
        git(&repo, &["remote", "remove", "other"]);
        git(&repo, &["remote", "remove", "origin"]);
        let none = undo_commit(
            &backend,
            &path,
            &again,
            false,
            unclear.generation.unwrap(),
            7,
        )
        .await
        .unwrap();
        assert!(!none.eligible);
        assert_eq!(none.code, "undo_unclear");
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let offline_remote = fixture.path().join("missing.git");
        git(
            &repo,
            &[
                "remote",
                "set-url",
                "origin",
                offline_remote.to_str().unwrap(),
            ],
        );
        let offline = undo_commit(&backend, &path, &again, true, none.generation, 8)
            .await
            .unwrap_err();
        assert_eq!(offline.code, "undo_offline");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), again);
    }

    #[tokio::test]
    async fn undo_refuses_root_merge_and_in_progress_before_writing() {
        let fixture = crate::test_support::git_fixture("undo-shape");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        let bare = fixture.path().join("remote.git");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "root\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "root"]);
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare"]);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let root_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        let path = repo_key(&repo);
        let root = undo_commit(
            &backend,
            &path,
            &root_oid,
            true,
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(root.code, "undo_root");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), root_oid);
        git(&repo, &["checkout", "-b", "feature"]);
        fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        git(&repo, &["add", "--", "feature.txt"]);
        git(&repo, &["commit", "-m", "feature"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("main.txt"), "main\n").unwrap();
        git(&repo, &["add", "--", "main.txt"]);
        git(&repo, &["commit", "-m", "main"]);
        git(&repo, &["merge", "--no-ff", "--no-edit", "feature"]);
        let merge_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        let merged = undo_commit(
            &backend,
            &path,
            &merge_oid,
            true,
            root.generation.unwrap(),
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(merged.code, "undo_merge");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), merge_oid);
        git(&repo, &["checkout", "-b", "side"]);
        fs::write(repo.join("a.txt"), "side\n").unwrap();
        git(&repo, &["commit", "-am", "side"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("a.txt"), "again\n").unwrap();
        git(&repo, &["commit", "-am", "again"]);
        let status = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["merge", "--no-commit", "--no-ff", "side"])
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
        assert!(!status.success());
        let head = git_text(&repo, &["rev-parse", "HEAD"]);
        let busy = undo_commit(&backend, &path, &head, true, merged.generation.unwrap(), 3)
            .await
            .unwrap_err();
        assert_eq!(busy.code, "undo_in_progress");
        assert!(repo.join(".git/MERGE_HEAD").exists());
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), head);
    }

    #[tokio::test]
    async fn discard_cancel_writes_nothing_and_confirm_keeps_the_other_file() {
        let fixture = crate::test_support::git_fixture("discard-files");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("my file.txt"), "one\n").unwrap();
        fs::write(repo.join("other.txt"), "two\n").unwrap();
        git(&repo, &["add", "--", "my file.txt", "other.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        fs::write(repo.join("my file.txt"), "one changed\n").unwrap();
        git(&repo, &["add", "--", "my file.txt"]);
        fs::write(repo.join("my file.txt"), "one changed again\n").unwrap();
        fs::write(repo.join("other.txt"), "two changed\n").unwrap();
        fs::write(repo.join("extra.txt"), "new\n").unwrap();
        let path = repo_key(&repo);
        let paths = vec![
            "my file.txt".to_string(),
            "other.txt".to_string(),
            "extra.txt".to_string(),
        ];
        let preview = discard_changes(
            &backend,
            &path,
            &paths,
            false,
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert!(!preview.wrote);
        assert!(preview.boundary.contains("取消不写入"));
        let staged = preview
            .files
            .iter()
            .find(|file| file.path == "my file.txt")
            .unwrap();
        assert!(staged.impact.contains("暂存区"));
        assert!(staged.impact.contains("未暂存"));
        assert!(staged.recovery.contains("不能撤销"));
        let extra = preview
            .files
            .iter()
            .find(|file| file.path == "extra.txt")
            .unwrap();
        assert!(extra.untracked);
        assert!(extra.recovery.contains("不能通过 Git 恢复"));
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "one changed again\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "two changed\n"
        );
        assert_eq!(fs::read_to_string(repo.join("extra.txt")).unwrap(), "new\n");
        let selected = vec!["my file.txt".to_string()];
        let discarded = discard_changes(&backend, &path, &selected, true, preview.generation, 2)
            .await
            .unwrap();
        assert!(discarded.wrote);
        assert_eq!(discarded.files.len(), 1);
        assert_eq!(
            fs::read_to_string(repo.join("my file.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "two changed\n"
        );
        assert_eq!(fs::read_to_string(repo.join("extra.txt")).unwrap(), "new\n");
        let unknown = discard_changes(
            &backend,
            &path,
            &["missing.txt".to_string()],
            true,
            discarded.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.code, "discard_unknown");
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "two changed\n"
        );
        let removed = discard_changes(
            &backend,
            &path,
            &["extra.txt".to_string()],
            true,
            unknown.generation.unwrap(),
            4,
        )
        .await
        .unwrap();
        assert!(!repo.join("extra.txt").exists());
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "two changed\n"
        );
        assert!(removed.wrote);
    }

    #[test]
    fn publication_parsers_keep_unreadable_records_closed() {
        let oid = "a".repeat(40);
        let pushed = format!("{oid}\u{1f}update by push\n");
        assert!(parse_push_reflog(pushed.as_bytes(), &oid).unwrap());
        let fetched = format!("{oid}\u{1f}fetch\n");
        assert!(!parse_push_reflog(fetched.as_bytes(), &oid).unwrap());
        assert!(parse_push_reflog(b"not a record\n", &oid).is_err());
        assert!(parse_push_reflog(b"\xff", &oid).is_err());
        let tags = format!("{oid}\trefs/tags/v1\n");
        assert!(remote_tag_contains(tags.as_bytes(), &oid).unwrap());
        let other = format!("{}\trefs/tags/v1\n", "b".repeat(40));
        assert!(!remote_tag_contains(other.as_bytes(), &oid).unwrap());
        assert!(remote_tag_contains(b"nope\n", &oid).is_err());
        let peeled = format!(
            "{}\trefs/tags/v1\n{oid}\trefs/tags/v1^{{}}\n",
            "c".repeat(40)
        );
        assert!(remote_tag_contains(peeled.as_bytes(), &oid).unwrap());
    }

    #[test]
    fn abort_note_names_the_full_total_when_the_list_is_cut() {
        use crate::model::{BranchInfo, ChangeKind, FileChange, StatusSnapshot};
        let mut files = Vec::new();
        for index in 0..205 {
            files.push(FileChange {
                path: format!("dir/file {index}.txt"),
                original_path: None,
                staged: ChangeKind::Modified,
                unstaged: ChangeKind::None,
                untracked: false,
                unmerged: false,
                staged_lines: None,
                unstaged_lines: None,
            });
        }
        let snapshot = StatusSnapshot {
            generation: 1,
            branch: BranchInfo::default(),
            files,
        };
        let (paths, note) = abort_listing(&snapshot, "merge");
        assert_eq!(paths.len(), 200);
        assert!(note.contains("全部 205"));
        assert!(note.contains("还有 5 条未展示"));
        assert!(!note.contains("这 200"));
        let full = abort_note("merge", 3, 3);
        assert!(full.contains("全部 3"));
        assert!(!full.contains("未展示"));
        let clean = StatusSnapshot {
            generation: 1,
            branch: BranchInfo {
                name: Some("main".to_string()),
                ..BranchInfo::default()
            },
            files: Vec::new(),
        };
        let preview = preview_from(&clean, "feature", None, "none");
        assert!(preview.can_start);
        assert!(preview.local_paths.is_empty());
        assert!(preview.note.contains("没有未提交改动"));
        let mut dirty_files = Vec::new();
        for index in 0..201 {
            dirty_files.push(FileChange {
                path: format!("wip {index}.txt"),
                original_path: None,
                staged: ChangeKind::None,
                unstaged: ChangeKind::Modified,
                untracked: false,
                unmerged: false,
                staged_lines: None,
                unstaged_lines: None,
            });
        }
        let dirty = StatusSnapshot {
            generation: 2,
            branch: clean.branch.clone(),
            files: dirty_files,
        };
        let blocked = preview_from(&dirty, "feature", None, "none");
        assert!(!blocked.can_start);
        assert_eq!(blocked.local_paths.len(), 200);
        assert!(blocked.note.contains("201"));
        assert!(blocked.note.contains("还有 1 条未展示"));
    }

    #[tokio::test]
    async fn discard_rename_restores_the_original_path_and_leaves_the_other_file() {
        let fixture = crate::test_support::git_fixture("discard-rename");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "original\n").unwrap();
        fs::write(repo.join("keep.txt"), "keep\n").unwrap();
        git(&repo, &["add", "--", "a.txt", "keep.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        git(&repo, &["mv", "a.txt", "b.txt"]);
        fs::write(repo.join("keep.txt"), "keep changed\n").unwrap();
        let path = repo_key(&repo);
        let selected = vec!["b.txt".to_string()];
        let preview = discard_changes(
            &backend,
            &path,
            &selected,
            false,
            generation(&backend, &repo),
            1,
        )
        .await
        .unwrap();
        assert!(!preview.wrote);
        let plan = preview
            .files
            .iter()
            .find(|file| file.path == "b.txt")
            .unwrap();
        assert_eq!(plan.original_path.as_deref(), Some("a.txt"));
        assert!(plan.impact.contains("a.txt"));
        assert!(plan.impact.contains("b.txt"));
        assert!(plan.impact.contains("原路径和新路径"));
        assert_eq!(
            fs::read_to_string(repo.join("b.txt")).unwrap(),
            "original\n"
        );
        assert!(!repo.join("a.txt").exists());
        let discarded = discard_changes(&backend, &path, &selected, true, preview.generation, 2)
            .await
            .unwrap();
        assert!(discarded.wrote);
        assert_eq!(
            fs::read_to_string(repo.join("a.txt")).unwrap(),
            "original\n"
        );
        assert!(!repo.join("b.txt").exists());
        assert_eq!(
            fs::read_to_string(repo.join("keep.txt")).unwrap(),
            "keep changed\n"
        );
        let status = git_text(&repo, &["status", "--porcelain"]);
        assert!(!status.contains("a.txt"));
        assert!(!status.contains("b.txt"));
        assert!(status.contains("keep.txt"));
    }

    #[tokio::test]
    async fn undo_refuses_a_commit_published_only_as_a_tag() {
        let fixture = crate::test_support::git_fixture("undo-tag");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        let bare = fixture.path().join("remote.git");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "root\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "root"]);
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare"]);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        fs::write(repo.join("a.txt"), "tagged\n").unwrap();
        git(&repo, &["commit", "-am", "tagged"]);
        let oid = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["tag", "v1"]);
        git(&repo, &["push", "origin", "v1"]);
        assert!(git_text(&repo, &["ls-remote", "--tags", "origin"]).contains(&oid));
        assert!(git_text(&repo, &["branch", "-r", "--contains", &oid]).is_empty());
        let path = repo_key(&repo);
        let preview = undo_commit(&backend, &path, &oid, false, generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert!(!preview.eligible);
        assert!(!preview.wrote);
        assert_eq!(preview.code, "undo_pushed");
        assert!(preview.reason.contains("tag"));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), oid);
        let refused = undo_commit(&backend, &path, &oid, true, preview.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(refused.code, "undo_pushed");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), oid);
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "tagged\n");
    }

    #[tokio::test]
    async fn undo_refuses_a_commit_still_recorded_by_an_earlier_push() {
        let fixture = crate::test_support::git_fixture("undo-reflog");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        let bare = fixture.path().join("remote.git");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "root\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "root"]);
        fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare"]);
        git(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        let root_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("a.txt"), "pushed\n").unwrap();
        git(&repo, &["commit", "-am", "pushed"]);
        let oid = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["push", "origin", "main"]);
        let spec = format!("{root_oid}:refs/heads/main");
        git(&repo, &["push", "origin", &spec, "--force"]);
        let reflog = git_text(
            &repo,
            &[
                "reflog",
                "show",
                "--format=%H %gs",
                "refs/remotes/origin/main",
            ],
        );
        assert!(reflog.contains(&oid));
        assert!(reflog.contains("update by push"));
        assert!(git_text(&repo, &["branch", "-r", "--contains", &oid]).is_empty());
        let path = repo_key(&repo);
        let preview = undo_commit(&backend, &path, &oid, false, generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert!(!preview.eligible);
        assert_eq!(preview.code, "undo_pushed");
        assert!(preview.reason.contains("推送"));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), oid);
        let refused = undo_commit(&backend, &path, &oid, true, preview.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(refused.code, "undo_pushed");
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), oid);
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "pushed\n");
    }

    #[tokio::test]
    async fn stash_unmerged_files_resolve_without_merge_abort() {
        let fixture = crate::test_support::git_fixture("stash-unmerged");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        fs::write(repo.join("bin.dat"), b"bin\0base").unwrap();
        fs::write(repo.join("mod.txt"), "mod\n").unwrap();
        fs::write(repo.join("gone.txt"), "gone\n").unwrap();
        git(
            &repo,
            &["add", "--", "file.txt", "bin.dat", "mod.txt", "gone.txt"],
        );
        git(&repo, &["commit", "-m", "base"]);
        fs::write(repo.join("file.txt"), "stashed\n").unwrap();
        git(&repo, &["stash", "push", "-m", "keep-me"]);
        let stashed = git_text(&repo, &["rev-parse", "stash@{0}"]);
        fs::write(repo.join("file.txt"), "other\n").unwrap();
        git(&repo, &["commit", "-am", "other"]);
        let apply = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["stash", "apply"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .status()
            .unwrap();
        assert!(!apply.success());
        let path = repo_key(&repo);
        let session = merge_session(&backend, &path, generation(&backend, &repo), 1)
            .await
            .unwrap();
        assert_eq!(session.operation, "unmerged");
        assert!(!session.can_abort);
        assert!(session
            .conflicts
            .iter()
            .any(|entry| entry.path == "file.txt"));
        let aborted = abort_merge(&backend, &path, false, session.generation, 2)
            .await
            .unwrap_err();
        assert_eq!(aborted.code, "unsupported_operation");
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        let view = conflict_view(&backend, &path, "file.txt", session.generation, 3)
            .await
            .unwrap();
        assert_eq!(view.kind, "text");
        assert!(view.editable);
        let resolved = resolve_conflict(
            &backend,
            &path,
            "file.txt",
            "text",
            Some("kept\n".to_string()),
            view.generation,
            4,
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "kept\n");
        assert!(!resolved.can_abort);
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert!(resolved
            .conflicts
            .iter()
            .all(|entry| entry.path != "file.txt"));
        assert_eq!(git_text(&repo, &["rev-parse", "stash@{0}"]), stashed);
        let committed = crate::git::changes::commit_index(
            &backend,
            &path,
            "保留冲突结果",
            resolved.generation,
            5,
        )
        .await
        .unwrap();
        assert_eq!(
            git_text(&repo, &["log", "-1", "--format=%s"]),
            "保留冲突结果"
        );
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "kept\n");
        assert_eq!(git_text(&repo, &["rev-parse", "stash@{0}"]), stashed);
        fs::write(repo.join("bin.dat"), b"bin\0ours").unwrap();
        let bin_ours = git_text(&repo, &["hash-object", "-w", "--", "bin.dat"]);
        let bin_theirs_path = repo.join("bin-theirs.dat");
        fs::write(&bin_theirs_path, b"bin\0theirs").unwrap();
        let bin_theirs = git_text(&repo, &["hash-object", "-w", "--", "bin-theirs.dat"]);
        let text_oid = git_text(&repo, &["hash-object", "-w", "--", "mod.txt"]);
        let index_info = format!(
            "100644 {bin_ours} 2\tbin.dat\n100644 {bin_theirs} 3\tbin.dat\n100644 {text_oid} 2\tmod.txt\n100644 {text_oid} 3\tgone.txt\n"
        );
        let mut update = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["update-index", "--index-info"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        {
            use std::io::Write;
            let mut stdin = update.stdin.take().unwrap();
            stdin.write_all(index_info.as_bytes()).unwrap();
        }
        let updated = update.wait().unwrap();
        assert!(updated.success());
        fs::remove_file(&bin_theirs_path).unwrap();
        let conflicted = merge_session(&backend, &path, committed.generation, 6)
            .await
            .unwrap();
        assert_eq!(conflicted.operation, "unmerged");
        assert!(!conflicted.can_abort);
        let binary = conflict_view(&backend, &path, "bin.dat", conflicted.generation, 7)
            .await
            .unwrap();
        assert_eq!(binary.kind, "binary");
        assert!(!binary.editable);
        let text_choice = resolve_conflict(
            &backend,
            &path,
            "bin.dat",
            "text",
            Some("nope".to_string()),
            binary.generation,
            8,
        )
        .await
        .unwrap_err();
        assert_eq!(text_choice.code, "resolve_binary");
        let after_bin = resolve_conflict(
            &backend,
            &path,
            "bin.dat",
            "theirs",
            None,
            conflicted.generation,
            9,
        )
        .await
        .unwrap();
        assert_eq!(fs::read(repo.join("bin.dat")).unwrap(), b"bin\0theirs");
        let modify = conflict_view(&backend, &path, "mod.txt", after_bin.generation, 10)
            .await
            .unwrap();
        assert_eq!(modify.kind, "modify_delete");
        let delete = conflict_view(&backend, &path, "gone.txt", after_bin.generation, 11)
            .await
            .unwrap();
        assert_eq!(delete.kind, "delete_modify");
        let kept = resolve_conflict(
            &backend,
            &path,
            "mod.txt",
            "ours",
            None,
            after_bin.generation,
            12,
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(repo.join("mod.txt")).unwrap(), "mod\n");
        let cleared = resolve_conflict(
            &backend,
            &path,
            "gone.txt",
            "delete",
            None,
            kept.generation,
            13,
        )
        .await
        .unwrap();
        assert!(!repo.join("gone.txt").exists());
        assert_eq!(cleared.operation, "none");
        assert!(!cleared.can_abort);
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        let still = abort_merge(&backend, &path, true, cleared.generation, 14)
            .await
            .unwrap_err();
        assert_eq!(still.code, "unsupported_operation");
        assert_eq!(git_text(&repo, &["rev-parse", "stash@{0}"]), stashed);
    }
}
