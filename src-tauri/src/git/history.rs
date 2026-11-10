use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::AppError;
use crate::git::changes::response_from_diff;
use crate::git::command::{
    any_commit_command, commit_detail_command, commit_diff_command, commit_header_command,
    commit_numstat_command, diff_tree_command, history_details_command, history_log_command,
    ignored_files_command, local_branch_names_command, ref_labels_command, rev_parse_command,
    show_current_branch_command, stash_apply_command, stash_drop_command, stash_list_command,
    stash_push_command, status_command, verify_local_branch_command, verify_upstream_command,
    HistoryLog, EMPTY_TREE_OID,
    HISTORY_PAGE_SIZE,
};
use crate::git::gate::action_key;
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, run_git, safe_relative,
    status_from_output, validate_input_path, Backend,
};
use crate::git::parse::parse_status;
use crate::git::patch::{
    apply_commit_numstat, first_file_diff, numstat_map, parse_diff, parse_numstat,
    parse_numstat_list, DIFF_PREVIEW_BYTES,
};
use crate::git::runner::{ProcessOutput, RealRunner};
use crate::git::schedule::{internal_request_id, CommandSpec, JobKind, WriteGuard};
use crate::model::{
    ChangeKind, CommitDetail, CommitFileChange, FileHistoryPage, HistoryCommit, HistoryLabel,
    HistoryPage, StashApplyResult, StashPreview, StashRecord, StashSaveResult, StashState,
    StatusSnapshot,
};
use crate::redact::contains_secret;

const MAX_QUERY_CHARS: usize = 200;
const MAX_STASH_MESSAGE_CHARS: usize = 8 * 1024;
const MAX_BODY_CHARS: usize = 16 * 1024;
const MAX_PREVIEW_PATHS: usize = 200;
const MAX_IGNORED_NAMES: usize = 20;
const MAX_LABELS: usize = 32;
const MAX_CONTAINING_BRANCHES: usize = 300;

// 多提交浏览复用文件目录；按条目数和估算字节数淘汰，generation 变化后失效。
const COMMIT_FILES_CACHE_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub(crate) struct CommitFilesCache(Mutex<VecDeque<CachedCommitFiles>>);

struct CachedCommitFiles {
    root: PathBuf,
    oid: String,
    parent: Option<String>,
    generation: u64,
    files: Arc<Vec<CommitFileChange>>,
    bytes: usize,
}

#[derive(Debug, Clone)]
pub struct HistoryRequest {
    pub query: String,
    pub offset: u32,
    pub scope: String,
    pub author: String,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub path: String,
}

impl Default for HistoryRequest {
    fn default() -> Self {
        Self {
            query: String::new(),
            offset: 0,
            scope: "current".to_string(),
            author: String::new(),
            since: None,
            until: None,
            path: String::new(),
        }
    }
}

pub async fn history_page(
    backend: &Backend,
    path: &str,
    request: &HistoryRequest,
    generation: u64,
    request_id: u64,
) -> Result<HistoryPage, AppError> {
    let root = repo_root(path)?;
    let mut resolved = resolve_history(request, None)?;
    let git = require_git(backend).await?;
    let generation = ensure_scope(backend, &root, &git.path, &mut resolved, generation, request_id).await?;
    let refs = load_labels(backend, &root, &git.path, generation, request_id).await?;
    let generation = refs.0;
    let (mut commits, has_more, generation) = load_history_page(
        backend,
        &root,
        &git.path,
        &resolved,
        request.offset,
        false,
        generation,
    )
    .await?;
    attach_labels(&mut commits, &refs.1);
    let meta = load_branch_meta(backend, &root, &git.path, generation).await?;
    let state = classify_history(
        backend,
        &root,
        &git.path,
        &resolved,
        request.offset,
        commits.is_empty(),
        false,
        meta.2,
    )
    .await?;
    Ok(HistoryPage {
        generation: state.0,
        query: resolved.query,
        offset: request.offset,
        page_size: HISTORY_PAGE_SIZE,
        has_more,
        state: state.1,
        commits,
        scope: resolved.scope_label,
        branches: meta.0,
        head: meta.1,
    })
}

pub async fn commit_detail(
    backend: &Backend,
    path: &str,
    oid: &str,
    parent: Option<&str>,
    generation: u64,
    request_id: u64,
) -> Result<CommitDetail, AppError> {
    let root = repo_root(path)?;
    let oid = validate_oid(oid)?;
    let git = require_git(backend).await?;
    let (record, generation) = read_log(
        backend,
        &root,
        &git.path,
        generation,
        request_id,
        commit_detail_command(&git.path, &root, &oid),
    )
    .await?;
    let separator = record
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| AppError::new("history_failed", "提交详情不完整，未修改仓库。"))?;
    let mut commits = parse_history_records(&record[..separator])?;
    let body = bounded_body(&record[separator + 1..])?;
    let Some(mut commit) = commits.pop() else {
        return Err(AppError::new(
            "commit_missing",
            "找不到这个提交，未改变当前分支、暂存区或工作区。",
        ));
    };
    if commit.oid != oid {
        return Err(AppError::new(
            "commit_missing",
            "找不到这个提交，未改变当前分支、暂存区或工作区。",
        ));
    }
    let (generation, labels) =
        load_labels(backend, &root, &git.path, generation, internal_request_id()).await?;
    attach_labels(std::slice::from_mut(&mut commit), &labels);
    let selected = choose_parent(&commit, parent)?;
    let (files, generation) = load_commit_files(
        backend,
        &root,
        &git.path,
        &oid,
        selected.as_deref(),
        generation,
    )
    .await?;
    Ok(CommitDetail {
        generation,
        root: commit.parents.is_empty(),
        merge: commit.parents.len() > 1,
        selected_parent: selected,
        body,
        commit,
        files: files.as_ref().clone(),
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn commit_file_diff(
    backend: &Backend,
    path: &str,
    oid: &str,
    parent: Option<&str>,
    relative: &str,
    generation: u64,
    request_id: u64,
    offset: u32,
    limit: u32,
    context: u32,
    as_text: bool,
) -> Result<crate::model::DiffResponse, AppError> {
    let root = repo_root(path)?;
    let oid = validate_oid(oid)?;
    let requested = safe_relative(relative)?;
    let git = require_git(backend).await?;
    let (header, generation) = read_log(
        backend,
        &root,
        &git.path,
        generation,
        request_id,
        commit_header_command(&git.path, &root, &oid),
    )
    .await?;
    let mut commits = parse_history_records(&header)?;
    let Some(commit) = commits.pop() else {
        return Err(AppError::new(
            "commit_missing",
            "找不到这个提交，未改变当前分支、暂存区或工作区。",
        ));
    };
    let selected = choose_parent(&commit, parent)?;
    diff_file_between(
        backend, &root, &git.path, oid, selected, relative, &requested, generation, offset, limit, context,
        as_text,
    )
    .await
}

/// 任意两个提交之间某个文件的差异：合并预览里查看「来源相对共同祖先带入了什么」。
#[allow(clippy::too_many_arguments)]
pub async fn compare_file_diff(
    backend: &Backend,
    path: &str,
    base: &str,
    head: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
    offset: u32,
    limit: u32,
    context: u32,
) -> Result<crate::model::DiffResponse, AppError> {
    let root = repo_root(path)?;
    // 空起点按空树比较：历史多选的最早一个是首个提交时没有父提交。
    let base = if base.trim().is_empty() { EMPTY_TREE_OID.to_string() } else { validate_oid(base)? };
    let head = validate_oid(head)?;
    let requested = safe_relative(relative)?;
    let git = require_git(backend).await?;
    // 先确认两个提交都存在：同时作为本次读取的 generation 校验。
    let (header, generation) = read_log(
        backend,
        &root,
        &git.path,
        generation,
        request_id,
        commit_header_command(&git.path, &root, &head),
    )
    .await?;
    if parse_history_records(&header)?.is_empty() {
        return Err(AppError::new(
            "commit_missing",
            "找不到来源分支的提交，可能已被移动。请重新检查。",
        ));
    }
    diff_file_between(
        backend, &root, &git.path, head, Some(base), relative, &requested, generation, offset, limit, context,
        false,
    )
    .await
}

/// 任意两点之间的净文件清单：历史多选时只看这批提交合起来的最终结果。
/// `base` 为 `None` 时按空树比较（最早所选是首个提交）。只读，不碰工作区与暂存区。
pub async fn compare_files(
    backend: &Backend,
    path: &str,
    base: Option<&str>,
    head: &str,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::CompareFiles, AppError> {
    let root = repo_root(path)?;
    let head = validate_oid(head)?;
    let base = match base.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(validate_oid(value)?),
        None => None,
    };
    // 没有起点时显式和空树比：`diff-tree --root` 对非根提交比的是它自己的父提交。
    let compare_base = base.clone().unwrap_or_else(|| EMPTY_TREE_OID.to_string());
    let git = require_git(backend).await?;
    let (header, generation) = read_log(
        backend,
        &root,
        &git.path,
        generation,
        request_id,
        commit_header_command(&git.path, &root, &head),
    )
    .await?;
    if parse_history_records(&header)?.is_empty() {
        return Err(AppError::new(
            "commit_missing",
            "找不到这个提交，未改变当前分支、暂存区或工作区。",
        ));
    }
    let (files, generation) =
        load_commit_files(backend, &root, &git.path, &head, Some(&compare_base), generation).await?;
    Ok(crate::model::CompareFiles {
        generation,
        base,
        head,
        files: files.as_ref().clone(),
    })
}

/// 包含这个提交的本地与远程分支；当前检出的分支排在最前。
pub async fn commit_branches(
    backend: &Backend,
    path: &str,
    oid: &str,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::CommitBranches, AppError> {
    let root = repo_root(path)?;
    let oid = validate_oid(oid)?;
    let git = require_git(backend).await?;
    let (output, generation) = read_output(
        backend,
        &root,
        generation,
        request_id,
        crate::git::command::branches_containing_command(&git.path, &root, &oid),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "history_failed",
            &output,
            "无法读取包含这个提交的分支，未修改仓库。",
        ));
    }
    let (head, generation) = read_output(
        backend,
        &root,
        generation,
        internal_request_id(),
        show_current_branch_command(&git.path, &root),
    )
    .await?;
    let current = String::from_utf8_lossy(&head.stdout).trim().to_string();
    let current = (head.exit_code == 0 && !current.is_empty()).then_some(current);
    let mut branches = parse_containing_refs(&output.stdout, current.as_deref());
    let total = u32::try_from(branches.len()).unwrap_or(u32::MAX);
    branches.truncate(MAX_CONTAINING_BRANCHES);
    Ok(crate::model::CommitBranches {
        generation,
        oid,
        branches,
        total,
        current,
    })
}

fn parse_containing_refs(bytes: &[u8], current: Option<&str>) -> Vec<crate::model::ContainingBranch> {
    let text = String::from_utf8_lossy(bytes);
    let mut branches: Vec<crate::model::ContainingBranch> = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if let Some(name) = line.strip_prefix("refs/heads/") {
                return Some(crate::model::ContainingBranch {
                    name: name.to_string(),
                    remote: false,
                    current: Some(name) == current,
                });
            }
            let name = line.strip_prefix("refs/remotes/")?;
            // origin/HEAD 只是指向默认分支的别名，列出来是重复的。
            if name.ends_with("/HEAD") {
                return None;
            }
            Some(crate::model::ContainingBranch { name: name.to_string(), remote: true, current: false })
        })
        .collect();
    branches.sort_by(|a, b| b.current.cmp(&a.current).then(a.remote.cmp(&b.remote)).then(a.name.cmp(&b.name)));
    branches
}

#[allow(clippy::too_many_arguments)]
async fn diff_file_between(
    backend: &Backend,
    root: &Path,
    git: &Path,
    oid: String,
    selected: Option<String>,
    relative: &str,
    requested: &Path,
    generation: u64,
    offset: u32,
    limit: u32,
    context: u32,
    as_text: bool,
) -> Result<crate::model::DiffResponse, AppError> {
    let context = context.min(crate::git::changes::FULL_FILE_CONTEXT);
    let (files, generation) = load_commit_files(
        backend,
        root,
        git,
        &oid,
        selected.as_deref(),
        generation,
    )
    .await?;
    let Some(file) = files.iter().find(|file| file.path == relative) else {
        return Err(AppError::new(
            "file_missing",
            "这个提交没有该文件的变化，未修改仓库。",
        ));
    };
    let parent_oid = selected.as_deref().unwrap_or(EMPTY_TREE_OID);
    let paths = diff_paths(file, requested)?;
    let (program, args) = commit_diff_command(git, root, parent_oid, &oid, &paths, context, as_text);
    let scheduled = backend
        .scheduler
        .execute(crate::git::schedule::GitJob {
            repo_key: repo_key(root),
            kind: JobKind::Read,
            request_id: internal_request_id(),
            generation,
            program,
            args,
            stdin: None,
            truncate_stdout: true,
            output_limit: Some(capture_limit(backend)),
            env: Vec::new(),
        })
        .await
        .map_err(history_limit)?;
    if diff_failed(&scheduled.output) {
        return Err(git_failure(
            "diff_failed",
            &scheduled.output,
            "无法读取这次提交的差异，未修改仓库。",
        ));
    }
    let raw = first_file_diff(&scheduled.output.stdout);
    let truncated = scheduled.output.stdout_truncated || raw.len() != scheduled.output.stdout.len();
    let parsed = if as_text {
        crate::git::patch::parse_diff_as_text(raw, truncated)?
    } else {
        parse_diff(raw, truncated)?
    };
    // 文件目录已按仓库、提交、父提交和 generation 缓存完整统计。
    // 切换文件或继续读取差异时直接复用；目录统计失败时仍可单独补读。
    // 按文本查看时目录把它记成二进制，只用这份文本差异里数到的行数。
    let counts = if as_text {
        None
    } else if file.binary {
        Some((None, None))
    } else if let (Some(additions), Some(deletions)) = (file.additions, file.deletions) {
        Some((Some(additions), Some(deletions)))
    } else {
        commit_numstat(
            backend,
            git,
            root,
            parent_oid,
            &oid,
            &paths,
            scheduled.generation,
        )
        .await?
    };
    let sizes = if crate::git::changes::diff_is_binary(&parsed, counts) {
        (file.old_size, file.new_size)
    } else {
        (None, None)
    };
    let mut response = response_from_diff(
        scheduled.generation,
        relative,
        false,
        &parsed,
        raw,
        counts,
        sizes,
        offset,
        limit,
    )?;
    if !as_text && crate::git::preview::wants_preview(relative, raw) {
        response.preview = Some(crate::git::preview::PreviewSources {
            repository: root.to_string_lossy().into_owned(),
            old: selected.as_ref().map(|revision| crate::git::preview::PreviewSource {
                revision: revision.clone(), path: file.original_path.as_deref().unwrap_or(relative).into(),
            }),
            new: Some(crate::git::preview::PreviewSource { revision: oid.clone(), path: relative.into() }),
        });
    }
    if crate::git::document::is_markdown(relative) || file.original_path.as_deref().is_some_and(crate::git::document::is_markdown) {
        // 提交文件状态是 "added"/"deleted"/"renamed" 这样的名称（见 parse_name_status），
        // 不是 diff 首字母；新增没有父提交侧，删除没有提交侧，都不提供正文来源。
        let old = if file.status == "added" { None } else { selected.map(|revision| crate::git::preview::PreviewSource {
            revision, path: file.original_path.as_deref().unwrap_or(relative).into(),
        }) };
        let new = (file.status != "deleted").then(|| crate::git::preview::PreviewSource { revision: oid, path: relative.into() });
        response.document = Some(crate::git::preview::PreviewSources {
            repository: root.to_string_lossy().into_owned(),
            old,
            new,
        });
    }
    Ok(response)
}

pub async fn file_history(
    backend: &Backend,
    path: &str,
    relative: &str,
    request: &HistoryRequest,
    generation: u64,
    request_id: u64,
) -> Result<FileHistoryPage, AppError> {
    let root = repo_root(path)?;
    let relative_path = safe_relative(relative)?;
    let mut resolved = resolve_history(request, Some(relative_path))?;
    let git = require_git(backend).await?;
    let generation = ensure_scope(backend, &root, &git.path, &mut resolved, generation, request_id).await?;
    let (mut commits, has_more, generation) = load_history_page(
        backend,
        &root,
        &git.path,
        &resolved,
        request.offset,
        true,
        generation,
    )
    .await?;
    // 上一页已经报告还有更早提交时，调用方才会带 offset。空页是读取中断，不是历史结束。
    if request.offset > 0 && commits.is_empty() {
        return Err(AppError::new(
            "history_incomplete",
            "还有更早的提交，但这一页没有读到。未修改仓库。",
        )
        .with_generation(generation));
    }
    let (generation, labels) =
        load_labels(backend, &root, &git.path, generation, internal_request_id()).await?;
    attach_labels(&mut commits, &labels);
    let meta = load_branch_meta(backend, &root, &git.path, generation).await?;
    let state = classify_history(
        backend,
        &root,
        &git.path,
        &resolved,
        request.offset,
        commits.is_empty(),
        true,
        meta.2,
    )
    .await?;
    Ok(FileHistoryPage {
        generation: state.0,
        path: relative.to_string(),
        offset: request.offset,
        page_size: HISTORY_PAGE_SIZE,
        has_more,
        state: state.1,
        commits,
        scope: resolved.scope_label,
        branches: meta.0,
        head: meta.1,
    })
}

pub async fn stash_state(
    backend: &Backend,
    path: &str,
    include_untracked: bool,
    generation: u64,
    request_id: u64,
) -> Result<StashState, AppError> {
    let root = repo_root(path)?;
    let git = require_git(backend).await?;
    load_stash_state(
        backend,
        &root,
        &git.path,
        include_untracked,
        generation,
        request_id,
    )
    .await
}

pub async fn save_stash(
    backend: &Backend,
    path: &str,
    include_untracked: bool,
    message: &str,
    generation: u64,
    request_id: u64,
) -> Result<StashSaveResult, AppError> {
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let message = normalize_stash_message(message)?;
    let git = require_git(backend).await?;
    let _gate = backend
        .actions
        .enter(action_key("stash", &repo_key(&root)))?;
    let mut guard = stash_lock(backend, &root, generation, request_id).await?;
    let outcome = save_in_guard(
        &mut guard,
        backend,
        &git.path,
        &root,
        include_untracked,
        message.as_deref(),
    )
    .await;
    let generation = guard.finish();
    let (before, pushed) = outcome.map_err(|error| attach_generation(error, generation))?;
    if pushed.exit_code != 0 {
        let text = command_text(&pushed).to_ascii_lowercase();
        if text.contains("no local changes") {
            return Err(AppError::new("stash_empty", before.summary).with_generation(generation));
        }
        return Err(
            git_failure("stash_failed", &pushed, "没有保存改动，工作区保持原样。")
                .with_generation(generation),
        );
    }
    let state = settle_read!(backend, &root, generation, |current| load_stash_state(
        backend,
        &root,
        &git.path,
        include_untracked,
        current,
        internal_request_id(),
    )
    .await)?;
    let oid = state
        .records
        .first()
        .map(|record| record.oid.clone())
        .ok_or_else(|| {
            AppError::new("stash_failed", "保存命令已结束，但没有找到新的记录。")
                .with_generation(generation)
        })?;
    let note = format!("已按保存前的范围完成临时保存。{}", before.summary);
    Ok(StashSaveResult { oid, note, state })
}

pub async fn apply_stash(
    backend: &Backend,
    path: &str,
    oid: &str,
    generation: u64,
    request_id: u64,
) -> Result<StashApplyResult, AppError> {
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let oid = validate_oid(oid)?;
    let git = require_git(backend).await?;
    let _gate = backend
        .actions
        .enter(action_key("stash", &repo_key(&root)))?;
    let mut guard = stash_lock(backend, &root, generation, request_id).await?;
    let outcome = apply_in_guard(&mut guard, backend, &git.path, &root, &oid).await;
    let generation = guard.finish();
    let applied = outcome.map_err(|error| attach_generation(error, generation))?;
    let (snapshot, records) = settle_read!(backend, &root, generation, |current| {
        match read_status(backend, &root, current, internal_request_id()).await {
            Ok(snapshot) => list_stashes(
                backend,
                &root,
                &git.path,
                snapshot.generation,
                internal_request_id(),
            )
            .await
            .map(|records| (snapshot, records)),
            Err(error) => Err(error),
        }
    })?;
    if !records.iter().any(|record| record.oid == oid) {
        return Err(AppError::new(
            "stash_lost",
            "恢复过程后没有再找到原来的保存记录。请刷新后确认工作区，不要假设记录已删除。",
        )
        .with_generation(snapshot.generation));
    }
    // Paths already unmerged belong to an earlier merge. A failed apply that
    // adds none is not a restored stash conflict.
    let conflict_paths = new_unmerged_paths(&snapshot, &applied.before_unmerged);
    if applied.output.exit_code != 0 && conflict_paths.is_empty() {
        let fallback = if applied.merge_in_progress {
            "没有恢复成功。仓库正在进行分支合并，临时保存没有写入工作区，记录仍保留，已有内容没有被丢弃。"
        } else {
            "没有恢复成功。临时保存记录仍保留，已有内容没有被丢弃。"
        };
        return Err(git_failure("stash_apply_failed", &applied.output, fallback)
            .with_generation(snapshot.generation));
    }
    let conflicted = !conflict_paths.is_empty();
    Ok(StashApplyResult {
        generation: snapshot.generation,
        oid,
        kept: true,
        operation: "stash".to_string(),
        conflicted,
        conflict_paths,
        can_abort_merge: false,
        note: stash_apply_note(conflicted, applied.merge_in_progress),
        snapshot,
    })
}

pub async fn delete_stash(
    backend: &Backend,
    path: &str,
    oid: &str,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<StashState, AppError> {
    if !confirm {
        return Err(AppError::new(
            "stash_confirm",
            "删除临时保存需要明确确认。记录仍在，没有改动工作区。",
        ));
    }
    let root = repo_root(path)?;
    ensure_no_index_lock(&root)?;
    let oid = validate_oid(oid)?;
    let git = require_git(backend).await?;
    let _gate = backend
        .actions
        .enter(action_key("stash", &repo_key(&root)))?;
    let mut guard = stash_lock(backend, &root, generation, request_id).await?;
    let outcome = delete_in_guard(&mut guard, &git.path, &root, &oid).await;
    let generation = guard.finish();
    outcome.map_err(|error| attach_generation(error, generation))?;
    settle_read!(backend, &root, generation, |current| load_stash_state(
        backend,
        &root,
        &git.path,
        false,
        current,
        internal_request_id(),
    )
    .await)
}

struct ResolvedHistory {
    scope_all: bool,
    revision: Option<String>,
    scope_label: String,
    head_scope: bool,
    /// 「未推送」：当前分支上还没到远程的提交。有上游时是 `@{upstream}..HEAD`，
    /// 没有上游时是 `HEAD --not --remotes`；由 ensure_scope 在读取前确定。
    unpushed: bool,
    /// 任务范围：`<起点>..HEAD`。起点是已校验的完整提交标识，不是分支名，不走分支存在性校验。
    range: bool,
    exclude_remotes: bool,
    author: Option<String>,
    path: Option<PathBuf>,
    since: Option<i64>,
    until: Option<i64>,
    query: String,
}

fn resolve_history(request: &HistoryRequest, file_path: Option<PathBuf>) -> Result<ResolvedHistory, AppError> {
    let query = normalize_query(&request.query)?;
    let author = normalize_query(&request.author)?;
    let raw = request.scope.trim();
    let unpushed = raw == "unpushed";
    let range_base = raw.strip_prefix("range:");
    let (scope_all, revision, scope_label, head_scope) = if raw.is_empty() || raw == "current" {
        (false, None, "current".to_string(), true)
    } else if let Some(base) = range_base {
        let base = validate_oid(base)?;
        (false, Some(format!("{base}..HEAD")), format!("range:{base}"), false)
    } else if unpushed {
        (false, None, "unpushed".to_string(), false)
    } else if raw == "all" {
        (true, None, "all".to_string(), false)
    } else {
        let name = raw.strip_prefix("branch:").unwrap_or(raw);
        validate_scope_branch(name)?;
        (false, Some(name.to_string()), name.to_string(), false)
    };
    let path = if let Some(path) = file_path {
        Some(path)
    } else if request.path.trim().is_empty() {
        None
    } else {
        Some(safe_relative(request.path.trim())?)
    };
    Ok(ResolvedHistory {
        scope_all,
        revision,
        scope_label,
        head_scope,
        unpushed,
        range: range_base.is_some(),
        exclude_remotes: false,
        author: if author.is_empty() { None } else { Some(author) },
        path,
        since: request.since,
        until: request.until,
        query,
    })
}

fn validate_scope_branch(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name.starts_with('-')
        || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with('/')
        || name.ends_with(".lock")
        || name.contains([' ', '\t', '~', '^', ':', '?', '*', '[', '\\', '\0'])
        || name.contains("..")
        || name.contains("@{")
        || name.contains("//")
    {
        return Err(AppError::new(
            "branch_invalid",
            "分支名称无效，未读取历史，仓库没有改动。",
        ));
    }
    Ok(())
}

fn history_log(resolved: &ResolvedHistory, follow: bool, skip: Option<u32>, max_count: Option<u32>, hits_only: bool, grep: Option<String>) -> HistoryLog {
    HistoryLog {
        scope_all: resolved.scope_all,
        revision: resolved.revision.clone(),
        author: resolved.author.clone(),
        grep,
        path: resolved.path.clone(),
        follow,
        skip,
        max_count,
        hits_only,
        name_status: false,
        exclude_remotes: resolved.exclude_remotes,
    }
}

/// 一次 git log 最多取这么多条。日期和文件历史都按这个上限往更早的提交凑，
/// 不把整段历史读进输出上限后再过滤。
const HISTORY_SCAN_BATCH: u32 = HISTORY_PAGE_SIZE + 1;

fn in_date(at: i64, since: Option<i64>, until: Option<i64>) -> bool {
    if since.is_some_and(|since| at < since) {
        return false;
    }
    if until.is_some_and(|until| at > until) {
        return false;
    }
    true
}

fn filter_hits(hits: Vec<Hit>, resolved: &ResolvedHistory) -> Vec<Hit> {
    hits.into_iter()
        .filter(|hit| in_date(hit.at, resolved.since, resolved.until))
        .collect()
}

async fn ensure_scope(
    backend: &Backend,
    root: &Path,
    git: &Path,
    resolved: &mut ResolvedHistory,
    generation: u64,
    request_id: u64,
) -> Result<u64, AppError> {
    if resolved.unpushed {
        let (output, generation) = read_output(
            backend,
            root,
            generation,
            request_id,
            verify_upstream_command(git, root),
        )
        .await?;
        if output.exit_code == 0 {
            resolved.revision = Some("@{upstream}..HEAD".to_string());
            resolved.exclude_remotes = false;
            return Ok(generation);
        }
        // 没有上游：只留任何远程跟踪分支都还没有的提交。还没有提交的分支不写 HEAD，
        // 交给 `git log` 自己报「没有提交」，得到空列表而不是「找不到提交」。
        let (head, generation) = read_output(
            backend,
            root,
            generation,
            internal_request_id(),
            rev_parse_command(git, root, "HEAD"),
        )
        .await?;
        let born = head.exit_code == 0;
        resolved.revision = born.then(|| "HEAD".to_string());
        resolved.exclude_remotes = born;
        return Ok(generation);
    }
    if resolved.range {
        return Ok(generation);
    }
    let Some(revision) = &resolved.revision else {
        return Ok(generation);
    };
    let (output, generation) = read_output(
        backend,
        root,
        generation,
        request_id,
        verify_local_branch_command(git, root, revision),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(AppError::new(
            "branch_missing",
            "没有这个分支，未读取历史，仓库没有改动。",
        )
        .with_generation(generation));
    }
    Ok(generation)
}

async fn load_history_page(
    backend: &Backend,
    root: &Path,
    git: &Path,
    resolved: &ResolvedHistory,
    offset: u32,
    follow: bool,
    generation: u64,
) -> Result<(Vec<HistoryCommit>, bool, u64), AppError> {
    let prefix = is_oid_prefix(&resolved.query);
    let dated = resolved.since.is_some() || resolved.until.is_some();
    // 无日期、非文件历史仍是一条带 --skip 和 --max-count 的日志。文件历史不能走这条，
    // 因为 --follow 和 --skip 不能同时使用。
    if !prefix && !dated && !follow {
        let limit = HISTORY_PAGE_SIZE.saturating_add(1);
        let grep = if resolved.query.is_empty() {
            None
        } else {
            Some(resolved.query.clone())
        };
        let (bytes, generation) = read_log(
            backend,
            root,
            git,
            generation,
            internal_request_id(),
            history_log_command(
                git,
                root,
                &history_log(resolved, false, Some(offset), Some(limit), false, grep),
            ),
        )
        .await?;
        let mut commits = parse_history_records(&bytes)?;
        let has_more = commits.len() > HISTORY_PAGE_SIZE as usize;
        commits.truncate(HISTORY_PAGE_SIZE as usize);
        return Ok((commits, has_more, generation));
    }
    if prefix {
        let mut groups = Vec::new();
        let mut generation = generation;
        if !resolved.query.is_empty() {
            let (bytes, next) = read_log(
                backend,
                root,
                git,
                generation,
                internal_request_id(),
                history_log_command(
                    git,
                    root,
                    &history_log(resolved, follow, None, None, true, Some(resolved.query.clone())),
                ),
            )
            .await?;
            generation = next;
            groups.push(filter_hits(parse_hits(&bytes)?, resolved));
        }
        if prefix || resolved.query.is_empty() {
            let (bytes, next) = read_log(
                backend,
                root,
                git,
                generation,
                internal_request_id(),
                history_log_command(
                    git,
                    root,
                    &history_log(resolved, follow, None, None, true, None),
                ),
            )
            .await?;
            generation = next;
            let mut hits = parse_hits(&bytes)?;
            if prefix {
                let needle = resolved.query.to_ascii_lowercase();
                hits.retain(|hit| hit.oid.starts_with(&needle));
            }
            groups.push(filter_hits(hits, resolved));
        }
        return page_from_hits(backend, root, git, merge_hits(&groups), offset, generation).await;
    }
    let (hits, generation) =
        collect_bounded_hits(backend, root, git, resolved, offset, follow, generation).await?;
    page_from_hits(backend, root, git, hits, offset, generation).await
}

async fn page_from_hits(
    backend: &Backend,
    root: &Path,
    git: &Path,
    hits: Vec<Hit>,
    offset: u32,
    generation: u64,
) -> Result<(Vec<HistoryCommit>, bool, u64), AppError> {
    let offset_usize = offset as usize;
    let page_size = HISTORY_PAGE_SIZE as usize;
    let has_more = hits.len() > offset_usize.saturating_add(page_size);
    let page: Vec<String> = hits
        .into_iter()
        .skip(offset_usize)
        .take(page_size)
        .map(|hit| hit.oid)
        .collect();
    if page.is_empty() {
        return Ok((Vec::new(), false, generation));
    }
    let (bytes, generation) = read_log(
        backend,
        root,
        git,
        generation,
        internal_request_id(),
        history_details_command(git, root, &page),
    )
    .await?;
    let commits = parse_history_records(&bytes)?;
    Ok((order_commits(&page, commits)?, has_more, generation))
}

/// 按有上限的 git log 向前扫描。命中在每一批里用作者时间 `%at` 过滤。
/// 文件历史每次都从本次查询的同一个起点（HEAD、选定分支或 `--all`）重新 `--follow`，
/// 只用更大的 `--max-count` 覆盖到本页。不能改成批末提交的祖先游标，否则合并另一侧的更早修改会丢。
async fn collect_bounded_hits(
    backend: &Backend,
    root: &Path,
    git: &Path,
    resolved: &ResolvedHistory,
    offset: u32,
    follow: bool,
    generation: u64,
) -> Result<(Vec<Hit>, u64), AppError> {
    let want = offset as usize + HISTORY_PAGE_SIZE as usize + 1;
    let grep = if resolved.query.is_empty() {
        None
    } else {
        Some(resolved.query.clone())
    };
    let mut matched = Vec::new();
    let mut generation = generation;
    if follow {
        if resolved.path.is_none() {
            return Err(AppError::new("invalid_path", "文件历史缺少路径，未读取仓库。"));
        }
        // offset 加一页；日期没命中时再按批加大，但每一跳都从同一起点重走。
        let mut limit = offset.saturating_add(HISTORY_PAGE_SIZE).saturating_add(1);
        loop {
            let log = history_log(resolved, true, None, Some(limit), true, grep.clone());
            let (bytes, next) = read_log(
                backend,
                root,
                git,
                generation,
                internal_request_id(),
                history_log_command(git, root, &log),
            )
            .await?;
            generation = next;
            let hits = parse_hits(&bytes)?;
            let produced = hits.len();
            matched = hits
                .into_iter()
                .filter(|hit| in_date(hit.at, resolved.since, resolved.until))
                .collect();
            if matched.len() >= want || produced < limit as usize {
                break;
            }
            let next_limit = limit.saturating_add(HISTORY_SCAN_BATCH);
            if next_limit == limit {
                break;
            }
            limit = next_limit;
        }
    } else {
        let mut skip = 0_u32;
        loop {
            let log = history_log(
                resolved,
                false,
                Some(skip),
                Some(HISTORY_SCAN_BATCH),
                true,
                grep.clone(),
            );
            let (bytes, next) = read_log(
                backend,
                root,
                git,
                generation,
                internal_request_id(),
                history_log_command(git, root, &log),
            )
            .await?;
            generation = next;
            let hits = parse_hits(&bytes)?;
            let produced = hits.len();
            for hit in hits {
                if in_date(hit.at, resolved.since, resolved.until) {
                    matched.push(hit);
                }
            }
            if matched.len() >= want || produced < HISTORY_SCAN_BATCH as usize {
                break;
            }
            let next_skip = skip.saturating_add(produced as u32);
            if next_skip == skip {
                break;
            }
            skip = next_skip;
        }
    }
    matched.truncate(want);
    Ok((matched, generation))
}

#[allow(clippy::too_many_arguments)]
async fn classify_history(
    backend: &Backend,
    root: &Path,
    git: &Path,
    resolved: &ResolvedHistory,
    offset: u32,
    empty_page: bool,
    file_history: bool,
    generation: u64,
) -> Result<(u64, String), AppError> {
    if !empty_page || offset > 0 {
        return Ok((generation, "ok".to_string()));
    }
    let (bytes, generation) = read_bytes(
        backend,
        root,
        generation,
        internal_request_id(),
        any_commit_command(git, root),
    )
    .await?;
    if !bytes.iter().any(|byte| !byte.is_ascii_whitespace()) {
        return Ok((generation, "empty_repository".to_string()));
    }
    let narrowing = !resolved.query.is_empty()
        || resolved.author.is_some()
        || resolved.since.is_some()
        || resolved.until.is_some()
        || (!file_history && resolved.path.is_some())
        || !resolved.head_scope;
    let state = if file_history {
        if narrowing { "no_match" } else { "no_file_history" }
    } else if resolved.head_scope && !narrowing {
        "empty_branch"
    } else {
        "no_match"
    };
    Ok((generation, state.to_string()))
}

async fn load_branch_meta(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
) -> Result<(Vec<String>, Option<String>, u64), AppError> {
    let (bytes, generation) = read_bytes(
        backend,
        root,
        generation,
        internal_request_id(),
        local_branch_names_command(git, root),
    )
    .await?;
    let mut branches = parse_branch_names(&bytes)?;
    branches.sort();
    let (current, generation) = read_bytes(
        backend,
        root,
        generation,
        internal_request_id(),
        show_current_branch_command(git, root),
    )
    .await?;
    let head = String::from_utf8(current).map_err(|_| {
        AppError::new(
            "history_encoding",
            "分支名称包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    let head = head.trim();
    Ok((
        branches,
        if head.is_empty() { None } else { Some(head.to_string()) },
        generation,
    ))
}

fn parse_branch_names(bytes: &[u8]) -> Result<Vec<String>, AppError> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "history_encoding",
            "分支名称包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .collect())
}

async fn load_labels(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<(u64, HashMap<String, Vec<HistoryLabel>>), AppError> {
    let (bytes, generation) = read_bytes(
        backend,
        root,
        generation,
        request_id,
        ref_labels_command(git, root),
    )
    .await?;
    Ok((generation, parse_ref_labels(&bytes)?))
}

async fn load_commit_files(
    backend: &Backend,
    root: &Path,
    git: &Path,
    oid: &str,
    parent: Option<&str>,
    generation: u64,
) -> Result<(Arc<Vec<CommitFileChange>>, u64), AppError> {
    let current = backend.scheduler.current_generation(&repo_key(root));
    if current != generation {
        return Err(
            AppError::new("stale", "仓库状态已变化，请查看刷新后的结果。").with_generation(current),
        );
    }
    {
        let mut cache = backend
            .history_files
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(index) = cache.iter().position(|entry| {
            entry.root == root
                && entry.oid == oid
                && entry.parent.as_deref() == parent
                && entry.generation == generation
        }) {
            let entry = cache.remove(index).expect("cache index exists");
            let files = entry.files.clone();
            cache.push_back(entry);
            return Ok((files, generation));
        }
    }
    let (output, mut generation) = read_output(
        backend,
        root,
        generation,
        internal_request_id(),
        diff_tree_command(git, root, parent, oid),
    )
    .await?;
    if diff_failed(&output) {
        return Err(git_failure(
            "history_failed",
            &output,
            "无法读取提交中的文件，未修改仓库。",
        ));
    }
    let mut parsed = parse_name_status(&output.stdout)?;
    let parent_oid = parent.unwrap_or(EMPTY_TREE_OID);
    if let Ok((stats, stats_generation)) = read_output(
        backend,
        root,
        generation,
        internal_request_id(),
        commit_numstat_command(git, root, parent_oid, oid, &[]),
    )
    .await
    {
        if !diff_failed(&stats) {
            apply_commit_numstat(&mut parsed, &numstat_map(parse_numstat_list(&stats.stdout)));
            generation = stats_generation;
        }
    }
    apply_commit_sizes(backend, git, root, parent_oid, oid, generation, &mut parsed).await;
    let files = Arc::new(parsed);
    let bytes = files
        .iter()
        .map(|file| {
            std::mem::size_of::<CommitFileChange>()
                + file.path.len()
                + file.original_path.as_ref().map_or(0, String::len)
        })
        .sum::<usize>()
        + root.as_os_str().len() * 2
        + oid.len()
        + parent.map_or(0, str::len);
    let mut cache = backend
        .history_files
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.retain(|entry| {
        entry.root == root
            && entry.generation == generation
            && !(entry.oid == oid && entry.parent.as_deref() == parent)
    });
    if bytes <= COMMIT_FILES_CACHE_BYTES {
        while cache.len() >= 32
            || cache.iter().map(|entry| entry.bytes).sum::<usize>() + bytes
                > COMMIT_FILES_CACHE_BYTES
        {
            cache.pop_front();
        }
        cache.push_back(CachedCommitFiles {
            root: root.to_path_buf(),
            oid: oid.to_string(),
            parent: parent.map(str::to_string),
            generation,
            files: files.clone(),
            bytes,
        });
    }
    Ok((files, generation))
}

/// 提交里的二进制文件补上前后大小：父提交（重命名看原路径）与这次提交里的版本。
async fn apply_commit_sizes(
    backend: &Backend,
    git: &Path,
    root: &Path,
    parent: &str,
    commit: &str,
    generation: u64,
    files: &mut [CommitFileChange],
) {
    use crate::git::sizes::{object_sizes, tree_name};
    let mut names = Vec::new();
    for file in files.iter().filter(|file| file.binary) {
        names.push(tree_name(parent, file.original_path.as_deref().unwrap_or(&file.path)));
        names.push(tree_name(commit, &file.path));
    }
    if names.is_empty() {
        return;
    }
    let found = object_sizes(backend, git, root, generation, &names).await;
    for file in files.iter_mut().filter(|file| file.binary) {
        file.old_size = found
            .get(&tree_name(parent, file.original_path.as_deref().unwrap_or(&file.path)))
            .copied();
        file.new_size = found.get(&tree_name(commit, &file.path)).copied();
    }
}

async fn commit_numstat(
    backend: &Backend,
    git: &Path,
    root: &Path,
    parent: &str,
    commit: &str,
    paths: &[PathBuf],
    generation: u64,
) -> Result<Option<(Option<u64>, Option<u64>)>, AppError> {
    let (output, _) = read_output(
        backend,
        root,
        generation,
        internal_request_id(),
        commit_numstat_command(git, root, parent, commit, paths),
    )
    .await?;
    if diff_failed(&output) {
        return Ok(None);
    }
    Ok(parse_numstat(&output.stdout))
}

async fn load_stash_state(
    backend: &Backend,
    root: &Path,
    git: &Path,
    include_untracked: bool,
    generation: u64,
    request_id: u64,
) -> Result<StashState, AppError> {
    let snapshot = read_status(backend, root, generation, request_id).await?;
    let records = list_stashes(
        backend,
        root,
        git,
        snapshot.generation,
        internal_request_id(),
    )
    .await?;
    let (ignored, generation) = ignored_paths(backend, root, git, snapshot.generation).await?;
    let (tracked, untracked) = classify_changes(&snapshot);
    let blocked = snapshot.files.iter().any(|file| file.unmerged);
    Ok(StashState {
        generation,
        preview: build_preview(&tracked, &untracked, &ignored, include_untracked, blocked),
        records,
        snapshot,
    })
}

async fn list_stashes(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
    request_id: u64,
) -> Result<Vec<StashRecord>, AppError> {
    let (bytes, _) = read_log(
        backend,
        root,
        git,
        generation,
        request_id,
        stash_list_command(git, root),
    )
    .await?;
    parse_stash_list(&bytes)
}

async fn ignored_paths(
    backend: &Backend,
    root: &Path,
    git: &Path,
    generation: u64,
) -> Result<(Vec<String>, u64), AppError> {
    let (output, generation) = read_output(
        backend,
        root,
        generation,
        internal_request_id(),
        ignored_files_command(git, root),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "stash_failed",
            &output,
            "无法确认忽略文件，因此没有保存或声明范围。",
        ));
    }
    let mut paths = Vec::new();
    for part in output.stdout.split(|byte| *byte == 0) {
        if part.is_empty() {
            continue;
        }
        let path = String::from_utf8(part.to_vec()).map_err(|_| {
            AppError::new("stash_failed", "忽略文件的路径无法安全显示，因此没有保存。")
        })?;
        paths.push(path);
    }
    Ok((paths, generation))
}

async fn save_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    include_untracked: bool,
    message: Option<&str>,
) -> Result<(StashPreview, ProcessOutput), AppError> {
    let snapshot = status_in_guard(guard, backend, git, root).await?;
    if snapshot.files.iter().any(|file| file.unmerged) {
        return Err(AppError::new(
            "stash_blocked",
            "工作区有未解决冲突，不能临时保存。忽略文件也不会被保存。",
        ));
    }
    let ignored = ignored_in_guard(guard, git, root).await?;
    let (tracked, untracked) = classify_changes(&snapshot);
    let preview = build_preview(&tracked, &untracked, &ignored, include_untracked, false);
    if !preview.can_save {
        return Err(AppError::new("stash_empty", preview.summary));
    }
    let (program, args) = stash_push_command(git, root, include_untracked, message);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: true,
        })
        .await?;
    Ok((preview, output))
}

struct StashApplyAttempt {
    output: ProcessOutput,
    before_unmerged: HashSet<String>,
    merge_in_progress: bool,
}

async fn apply_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
    oid: &str,
) -> Result<StashApplyAttempt, AppError> {
    let records = stash_records_in_guard(guard, git, root).await?;
    if !records.iter().any(|record| record.oid == oid) {
        return Err(AppError::new(
            "stash_missing",
            "没有找到这条临时保存，未恢复，也没有删除其他记录。",
        ));
    }
    let before = status_in_guard(guard, backend, git, root).await?;
    let before_unmerged = unmerged_path_set(&before);
    let (program, args) = stash_apply_command(git, root, oid);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: true,
        })
        .await?;
    let merge_in_progress = merge_head_present(guard, git, root).await?;
    Ok(StashApplyAttempt {
        output,
        before_unmerged,
        merge_in_progress,
    })
}

fn unmerged_path_set(snapshot: &StatusSnapshot) -> HashSet<String> {
    snapshot
        .files
        .iter()
        .filter(|file| file.unmerged)
        .map(|file| file.path.clone())
        .collect()
}

fn new_unmerged_paths(snapshot: &StatusSnapshot, before: &HashSet<String>) -> Vec<String> {
    snapshot
        .files
        .iter()
        .filter(|file| file.unmerged && !before.contains(&file.path))
        .map(|file| file.path.clone())
        .collect()
}

fn stash_apply_note(conflicted: bool, merge_in_progress: bool) -> String {
    if !conflicted {
        return "已把改动恢复到工作区，临时保存记录仍保留。需要移除时请单独确认删除。".to_string();
    }
    if merge_in_progress {
        return "恢复发生冲突，原保存记录仍保留。仓库仍有正在进行的分支合并。请在改动里处理冲突文件。"
            .to_string();
    }
    "恢复发生冲突，原保存记录仍保留。这不是分支合并，没有可中止的合并。请在改动里处理冲突文件。"
        .to_string()
}

async fn merge_head_present(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<bool, AppError> {
    let (program, args) = rev_parse_command(git, root, "MERGE_HEAD");
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await?;
    Ok(output.exit_code == 0 && !normalized_oid(&output.stdout).is_empty())
}

async fn delete_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
    oid: &str,
) -> Result<(), AppError> {
    let records = stash_records_in_guard(guard, git, root).await?;
    let Some(index) = records.iter().position(|record| record.oid == oid) else {
        return Err(AppError::new(
            "stash_missing",
            "没有找到这条临时保存，未删除其他记录。",
        ));
    };
    let stash_ref = format!("stash@{{{index}}}");
    let (program, args) = rev_parse_command(git, root, &stash_ref);
    let resolved = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await?;
    if resolved.exit_code != 0 || normalized_oid(&resolved.stdout) != oid {
        return Err(AppError::new(
            "stash_identity",
            "这条记录的身份已经变化，未删除任何临时保存。",
        ));
    }
    let expected: HashSet<String> = records
        .iter()
        .filter(|record| record.oid != oid)
        .map(|record| record.oid.clone())
        .collect();
    let (program, args) = stash_drop_command(git, root, &stash_ref);
    let dropped = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: true,
        })
        .await?;
    if dropped.exit_code != 0 {
        return Err(git_failure(
            "stash_failed",
            &dropped,
            "没有删除这条临时保存。",
        ));
    }
    let after = stash_records_in_guard(guard, git, root).await?;
    let actual: HashSet<String> = after.into_iter().map(|record| record.oid).collect();
    if actual.contains(oid) || actual != expected {
        return Err(AppError::new(
            "stash_identity",
            "删除后的记录与删除前核对的身份不一致。请刷新后确认，不要继续删除其他记录。",
        ));
    }
    Ok(())
}

async fn status_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    backend: &Backend,
    git: &Path,
    root: &Path,
) -> Result<StatusSnapshot, AppError> {
    let (program, args) = status_command(git, root);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await?;
    if output.exit_code != 0 {
        return Err(git_failure("status_failed", &output, "无法读取仓库状态。"));
    }
    let mut snapshot = parse_status(&output.stdout)?;
    snapshot.generation = backend.scheduler.current_generation(&repo_key(root));
    crate::git::ops::decorate_guard_status(guard, git, root, &mut snapshot).await;
    Ok(snapshot)
}

async fn ignored_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<Vec<String>, AppError> {
    let (program, args) = ignored_files_command(git, root);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "stash_failed",
            &output,
            "无法确认忽略文件，因此没有保存。",
        ));
    }
    let mut paths = Vec::new();
    for part in output.stdout.split(|byte| *byte == 0) {
        if part.is_empty() {
            continue;
        }
        paths.push(String::from_utf8(part.to_vec()).map_err(|_| {
            AppError::new("stash_failed", "忽略文件的路径无法安全显示，因此没有保存。")
        })?);
    }
    Ok(paths)
}

async fn stash_records_in_guard(
    guard: &mut WriteGuard<'_, RealRunner>,
    git: &Path,
    root: &Path,
) -> Result<Vec<StashRecord>, AppError> {
    let (program, args) = stash_list_command(git, root);
    let output = guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "stash_failed",
            &output,
            "无法读取临时保存记录，未继续写入。",
        ));
    }
    parse_stash_list(&output.stdout)
}

async fn read_status(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, root);
    let scheduled = run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await
    .map_err(history_limit)?;
    status_from_output(backend, root, &scheduled).await
}

async fn read_log(
    backend: &Backend,
    root: &Path,
    _git: &Path,
    generation: u64,
    request_id: u64,
    command: (PathBuf, Vec<std::ffi::OsString>),
) -> Result<(Vec<u8>, u64), AppError> {
    let (output, generation) = read_output(backend, root, generation, request_id, command).await?;
    Ok((log_bytes(&output)?, generation))
}

async fn read_bytes(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
    command: (PathBuf, Vec<std::ffi::OsString>),
) -> Result<(Vec<u8>, u64), AppError> {
    let (output, generation) = read_output(backend, root, generation, request_id, command).await?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "history_failed",
            &output,
            "无法读取提交历史，未修改仓库。",
        ));
    }
    Ok((output.stdout, generation))
}

async fn read_output(
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
    .await
    .map_err(history_limit)?;
    Ok((scheduled.output, scheduled.generation))
}

fn log_bytes(output: &ProcessOutput) -> Result<Vec<u8>, AppError> {
    if output.exit_code == 0 {
        return Ok(output.stdout.clone());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("does not have any commits") {
        return Ok(Vec::new());
    }
    if stderr.contains("bad object")
        || stderr.contains("unknown revision")
        || stderr.contains("ambiguous argument")
        || stderr.contains("not a valid object name")
    {
        return Err(AppError::new(
            "commit_missing",
            "找不到这个提交，未改变当前分支、暂存区或工作区。",
        ));
    }
    Err(git_failure(
        "history_failed",
        output,
        "无法读取提交历史，未修改仓库。",
    ))
}

pub(crate) fn parse_history_records(bytes: &[u8]) -> Result<Vec<HistoryCommit>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "history_encoding",
            "提交历史包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    let mut commits = Vec::new();
    for record in text.split('\u{1e}') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\u{1f}').collect();
        if fields.len() < 6 {
            return Err(AppError::new(
                "history_parse",
                "无法解析提交历史，未修改仓库。",
            ));
        }
        let parents = if fields[1].is_empty() {
            Vec::new()
        } else {
            fields[1]
                .split_whitespace()
                .map(|oid| oid.to_ascii_lowercase())
                .collect()
        };
        commits.push(HistoryCommit {
            oid: fields[0].trim().to_ascii_lowercase(),
            parents,
            author_name: fields[2].to_string(),
            author_email: fields[3].to_string(),
            authored_at: fields[4].trim().parse().unwrap_or(0),
            summary: fields[5..].join("\u{1f}"),
            labels: Vec::new(),
        });
    }
    Ok(commits)
}

struct Hit {
    oid: String,
    at: i64,
}

#[cfg(test)]
struct FollowRecord {
    oid: String,
    at: i64,
    /// 这个提交里文件的名字。下一页从这里继续 `--follow`。
    path_in_commit: String,
}

#[cfg(test)]
fn parse_follow_records(bytes: &[u8]) -> Result<Vec<FollowRecord>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "history_encoding",
            "提交历史包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    let mut records = Vec::new();
    for chunk in text.split('\u{1e}') {
        let chunk = chunk.trim_start_matches(['\n', '\r', '\0']);
        if chunk.is_empty() {
            continue;
        }
        let header_end = chunk.find(['\n', '\0']).unwrap_or(chunk.len());
        let header = chunk[..header_end].trim_end_matches('\r');
        let body = if header_end < chunk.len() {
            &chunk[header_end + 1..]
        } else {
            ""
        };
        let mut parts = header.split('\u{1f}');
        let oid = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let at = parts.next().unwrap_or("").trim().parse().unwrap_or(0);
        if oid.len() < 4 || !oid.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err(AppError::new(
                "history_parse",
                "无法解析提交标识，未修改仓库。",
            ));
        }
        records.push(FollowRecord {
            oid,
            at,
            path_in_commit: path_in_commit(body)?,
        });
    }
    Ok(records)
}

#[cfg(test)]
fn path_in_commit(body: &str) -> Result<String, AppError> {
    let fields: Vec<&str> = body
        .split('\0')
        .map(|field| field.trim_matches(['\n', '\r']))
        .filter(|field| !field.is_empty())
        .collect();
    if fields.is_empty() {
        return Err(follow_path_error());
    }
    let mut index = 0;
    let mut path: Option<&str> = None;
    while index < fields.len() {
        let status = fields[index];
        let renamed = status.starts_with('R') || status.starts_with('C');
        if renamed {
            if index + 2 >= fields.len() {
                return Err(follow_path_error());
            }
            path = Some(fields[index + 2]);
            index += 3;
        } else if index + 1 >= fields.len() {
            return Err(follow_path_error());
        } else {
            path = Some(fields[index + 1]);
            index += 2;
        }
    }
    path.map(ToString::to_string).ok_or_else(follow_path_error)
}

#[cfg(test)]
fn follow_path_error() -> AppError {
    AppError::new(
        "history_parse",
        "无法确定文件在该提交中的路径，未修改仓库。",
    )
}

fn parse_hits(bytes: &[u8]) -> Result<Vec<Hit>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "history_encoding",
            "提交历史包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    let mut hits = Vec::new();
    for line in text.split(['\n', '\u{1e}']) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\u{1f}');
        let oid = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let at = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
        if oid.len() < 4 || !oid.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err(AppError::new(
                "history_parse",
                "无法解析提交标识，未修改仓库。",
            ));
        }
        hits.push(Hit { oid, at });
    }
    Ok(hits)
}

fn merge_hits(groups: &[Vec<Hit>]) -> Vec<Hit> {
    let mut found: HashMap<String, i64> = HashMap::new();
    for hit in groups.iter().flatten() {
        found.entry(hit.oid.clone()).or_insert(hit.at);
    }
    let mut hits: Vec<Hit> = found.into_iter().map(|(oid, at)| Hit { oid, at }).collect();
    hits.sort_by(|left, right| {
        right
            .at
            .cmp(&left.at)
            .then_with(|| right.oid.cmp(&left.oid))
    });
    hits
}

fn order_commits(
    oids: &[String],
    commits: Vec<HistoryCommit>,
) -> Result<Vec<HistoryCommit>, AppError> {
    let by_oid: HashMap<String, HistoryCommit> = commits
        .into_iter()
        .map(|commit| (commit.oid.clone(), commit))
        .collect();
    let mut ordered = Vec::with_capacity(oids.len());
    for oid in oids {
        let Some(commit) = by_oid.get(oid) else {
            return Err(AppError::new(
                "history_failed",
                "有提交在读取期间对不上，请重新搜索。未修改仓库。",
            ));
        };
        ordered.push(commit.clone());
    }
    Ok(ordered)
}

fn parse_ref_labels(bytes: &[u8]) -> Result<HashMap<String, Vec<HistoryLabel>>, AppError> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "history_encoding",
            "分支标签包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    let mut labels: HashMap<String, Vec<HistoryLabel>> = HashMap::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let oid = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let refname = parts.next().unwrap_or("").trim();
        let head = parts.next().unwrap_or("").trim();
        if oid.is_empty() || refname.is_empty() {
            continue;
        }
        let Some(label) = label_from_ref(refname, head == "*") else {
            continue;
        };
        labels.entry(oid).or_default().push(label);
    }
    for values in labels.values_mut() {
        values.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| left.name.cmp(&right.name))
        });
        values.dedup_by(|left, right| left.kind == right.kind && left.name == right.name);
        values.truncate(MAX_LABELS);
    }
    Ok(labels)
}

fn label_from_ref(refname: &str, current: bool) -> Option<HistoryLabel> {
    if refname == "HEAD" {
        return Some(HistoryLabel {
            name: "HEAD".to_string(),
            kind: "head".to_string(),
            current: true,
        });
    }
    if let Some(name) = refname.strip_prefix("refs/heads/") {
        if name.is_empty() {
            return None;
        }
        return Some(HistoryLabel {
            name: name.to_string(),
            kind: "branch".to_string(),
            current,
        });
    }
    if let Some(name) = refname.strip_prefix("refs/remotes/") {
        if name.is_empty() || name.ends_with("/HEAD") {
            return None;
        }
        return Some(HistoryLabel {
            name: name.to_string(),
            kind: "remote".to_string(),
            current: false,
        });
    }
    if let Some(name) = refname.strip_prefix("refs/tags/") {
        if name.is_empty() {
            return None;
        }
        return Some(HistoryLabel {
            name: name.to_string(),
            kind: "tag".to_string(),
            current: false,
        });
    }
    None
}

fn attach_labels(commits: &mut [HistoryCommit], labels: &HashMap<String, Vec<HistoryLabel>>) {
    for commit in commits {
        if let Some(found) = labels.get(&commit.oid) {
            commit.labels.clone_from(found);
        }
    }
}

pub(crate) fn parse_name_status(bytes: &[u8]) -> Result<Vec<CommitFileChange>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == 0 {
            parts.push(&bytes[start..index]);
            start = index + 1;
        }
    }
    if start < bytes.len() {
        parts.push(&bytes[start..]);
    }
    let mut files = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let code = utf8_piece(parts[index])?;
        if code.is_empty() {
            index += 1;
            continue;
        }
        let kind = code.chars().next().unwrap_or('?');
        if kind == 'R' || kind == 'C' {
            if index + 2 >= parts.len() {
                return Err(name_status_error());
            }
            files.push(CommitFileChange {
                original_path: Some(utf8_piece(parts[index + 1])?),
                path: utf8_piece(parts[index + 2])?,
                status: status_name(kind),
                additions: None,
                deletions: None,
                binary: false,
                old_size: None,
                new_size: None,
            });
            index += 3;
        } else {
            if index + 1 >= parts.len() {
                return Err(name_status_error());
            }
            files.push(CommitFileChange {
                path: utf8_piece(parts[index + 1])?,
                original_path: None,
                status: status_name(kind),
                additions: None,
                deletions: None,
                binary: false,
                old_size: None,
                new_size: None,
            });
            index += 2;
        }
    }
    Ok(files)
}

fn status_name(kind: char) -> String {
    match kind {
        'A' => "added",
        'M' => "modified",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typeChanged",
        _ => "unknown",
    }
    .to_string()
}

fn parse_stash_list(bytes: &[u8]) -> Result<Vec<StashRecord>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "stash_failed",
            "临时保存记录包含无法安全显示的内容，未继续写入。",
        )
    })?;
    let mut records = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\u{1f}');
        let oid = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let at = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let message = parts.next().unwrap_or("").trim().to_string();
        if validate_oid(&oid).is_err() {
            return Err(AppError::new(
                "stash_failed",
                "临时保存记录的标识无法核对，未继续写入。",
            ));
        }
        records.push(StashRecord {
            oid,
            message,
            committed_at: at,
        });
    }
    Ok(records)
}

fn choose_parent(
    commit: &HistoryCommit,
    requested: Option<&str>,
) -> Result<Option<String>, AppError> {
    if commit.parents.is_empty() {
        if requested
            .map(str::trim)
            .is_some_and(|parent| !parent.is_empty())
        {
            return Err(AppError::new(
                "invalid_revision",
                "首个提交没有父提交。差异按空树比较，未修改仓库。",
            ));
        }
        return Ok(None);
    }
    match requested.map(str::trim).filter(|parent| !parent.is_empty()) {
        Some(parent) => {
            let parent = validate_oid(parent)?;
            if !commit.parents.iter().any(|item| item == &parent) {
                return Err(AppError::new(
                    "invalid_revision",
                    "所选父提交不属于这个提交，未修改仓库。",
                ));
            }
            Ok(Some(parent))
        }
        None => Ok(Some(commit.parents[0].clone())),
    }
}

fn diff_paths(file: &CommitFileChange, requested: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = Vec::new();
    if let Some(original) = &file.original_path {
        paths.push(safe_relative(original)?);
    }
    if paths.iter().all(|path| path != requested) {
        paths.push(requested.to_path_buf());
    }
    Ok(paths)
}

fn classify_changes(snapshot: &StatusSnapshot) -> (Vec<String>, Vec<String>) {
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for file in &snapshot.files {
        if file.untracked {
            untracked.push(file.path.clone());
        } else if file.staged != ChangeKind::None || file.unstaged != ChangeKind::None {
            tracked.push(file.path.clone());
        }
    }
    (tracked, untracked)
}

fn build_preview(
    tracked: &[String],
    untracked: &[String],
    ignored: &[String],
    include_untracked: bool,
    blocked: bool,
) -> StashPreview {
    let (can_save, summary) = if blocked {
        (
            false,
            "工作区有未解决冲突，不能临时保存。忽略文件也不会被保存。".to_string(),
        )
    } else {
        scope_summary(
            tracked.len(),
            untracked.len(),
            ignored.len(),
            include_untracked,
        )
    };
    StashPreview {
        tracked_count: tracked.len() as u32,
        untracked_count: untracked.len() as u32,
        ignored_count: ignored.len() as u32,
        tracked_paths: take_paths(tracked, MAX_PREVIEW_PATHS),
        untracked_paths: take_paths(untracked, MAX_PREVIEW_PATHS),
        ignored_paths: take_paths(ignored, MAX_IGNORED_NAMES),
        include_untracked,
        can_save,
        summary,
    }
}

fn scope_summary(
    tracked: usize,
    untracked: usize,
    ignored: usize,
    include_untracked: bool,
) -> (bool, String) {
    let can_save = tracked > 0 || (include_untracked && untracked > 0);
    let untracked_text = if include_untracked {
        format!("未跟踪文件 {untracked} 个会一并保存。")
    } else if untracked > 0 {
        format!("未跟踪文件 {untracked} 个这次不保存。")
    } else {
        "没有未跟踪文件。".to_string()
    };
    let lead = if can_save {
        format!("将保存已跟踪的暂存和未暂存改动 {tracked} 个。")
    } else {
        "没有可保存的内容。".to_string()
    };
    (
        can_save,
        format!("{lead}{untracked_text}忽略文件 {ignored} 个不会保存。"),
    )
}

fn take_paths(paths: &[String], limit: usize) -> Vec<String> {
    paths.iter().take(limit).cloned().collect()
}

fn bounded_body(bytes: &[u8]) -> Result<String, AppError> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "history_encoding",
            "提交说明包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    if text.chars().count() <= MAX_BODY_CHARS {
        return Ok(text);
    }
    let mut body: String = text.chars().take(MAX_BODY_CHARS).collect();
    body.push_str("\n…说明过长，已停止继续读取。");
    Ok(body)
}

fn normalize_query(query: &str) -> Result<String, AppError> {
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::new("invalid_query", "搜索内容过长，未读取历史。"));
    }
    if query.contains(['\0', '\n', '\r']) {
        return Err(AppError::new(
            "invalid_query",
            "搜索内容包含无法安全传递的字符，未读取历史。",
        ));
    }
    Ok(query.trim().to_string())
}

fn normalize_stash_message(message: &str) -> Result<Option<String>, AppError> {
    if message.contains('\0') {
        return Err(AppError::new(
            "invalid_message",
            "说明包含无法保存的字符，未保存改动。",
        ));
    }
    if message.chars().count() > MAX_STASH_MESSAGE_CHARS {
        return Err(AppError::new("invalid_message", "说明过长，未保存改动。"));
    }
    if contains_secret(message) {
        return Err(AppError::new(
            "stash_secret",
            "说明包含疑似凭据或私钥，未保存改动。",
        ));
    }
    let trimmed = message.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn is_oid_prefix(query: &str) -> bool {
    (4..=64).contains(&query.len()) && query.chars().all(|character| character.is_ascii_hexdigit())
}

pub(crate) fn validate_oid(oid: &str) -> Result<String, AppError> {
    let oid = oid.trim().to_ascii_lowercase();
    if (oid.len() == 40 || oid.len() == 64)
        && oid.chars().all(|character| character.is_ascii_hexdigit())
    {
        Ok(oid)
    } else {
        Err(AppError::new(
            "invalid_revision",
            "提交标识无效，未读取或修改仓库。",
        ))
    }
}

fn normalized_oid(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_ascii_lowercase()
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
    let git_dir = root.join(".git");
    if git_dir.is_dir() && git_dir.join("index.lock").exists() {
        return Err(AppError::new(
            "index_lock",
            "索引锁仍在，可能有另一个 Git 进程正在写入。未删除该锁，也没有保存或恢复改动。",
        ));
    }
    Ok(())
}

async fn stash_lock<'a>(
    backend: &'a Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<WriteGuard<'a, RealRunner>, AppError> {
    let key = repo_key(root);
    backend
        .scheduler
        .lock_write(&key, request_id, generation)
        .await
}

fn capture_limit(backend: &Backend) -> usize {
    backend.runner.output_limit.min(DIFF_PREVIEW_BYTES)
}

fn diff_failed(output: &ProcessOutput) -> bool {
    output.exit_code > 1
}

fn history_limit(error: AppError) -> AppError {
    if error.code == "output_limit" {
        let generation = error.generation;
        let mapped = AppError::new(
            "history_truncated",
            "历史输出达到上限，没有把不完整结果当成无匹配。请缩小说明、作者或提交标识。",
        );
        if let Some(generation) = generation {
            mapped.with_generation(generation)
        } else {
            mapped
        }
    } else {
        error
    }
}

fn attach_generation(error: AppError, generation: u64) -> AppError {
    if error.generation.is_some() {
        error
    } else {
        error.with_generation(generation)
    }
}

fn command_text(output: &ProcessOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

fn utf8_piece(bytes: &[u8]) -> Result<String, AppError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| name_status_error())
}

fn name_status_error() -> AppError {
    AppError::new("history_parse", "无法解析提交中的文件，未修改仓库。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    use crate::git::command::{stash_push_command, HISTORY_PAGE_SIZE};

    fn git(dir: &Path, args: &[&str]) {
        git_env(dir, &[], args);
    }

    fn git_exit(dir: &Path, args: &[&str]) -> std::process::ExitStatus {
        Command::new(crate::test_support::system_git())
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
            .unwrap()
    }

    fn git_env(dir: &Path, env: &[(&str, &str)], args: &[&str]) {
        let mut command = Command::new(crate::test_support::system_git());
        command
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
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com");
        for (key, value) in env {
            command.env(key, value);
        }
        let status = command.status().unwrap();
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

    fn stamp(dir: &Path) -> String {
        format!(
            "{}\n{}\n{}",
            git_text(dir, &["rev-parse", "HEAD"]),
            git_text(dir, &["status", "--porcelain=v2", "-z"]),
            git_text(dir, &["write-tree"])
        )
    }

    #[tokio::test]
    async fn sixteen_commit_details_share_metadata_reads_and_keep_file_directories() {
        let fixture = crate::test_support::git_fixture("history-multi-read");
        let trace = fixture.path().join("git-trace.log");
        let backend = fixture
            .backend_with_extra_env(vec![("GIT_TRACE".into(), trace.as_os_str().to_os_string())]);
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        let mut ids = Vec::new();
        for index in 0..16 {
            fs::write(repo.join("file.txt"), format!("line {index}\n")).unwrap();
            git(&repo, &["add", "."]);
            git(
                &repo,
                &[
                    "commit",
                    "-m",
                    &format!("commit-{index}"),
                    "-m",
                    &format!("正文 {index}"),
                ],
            );
            ids.push(git_text(&repo, &["rev-parse", "HEAD"]));
        }
        let gen = generation(&backend, &repo);
        let start = std::time::Instant::now();
        for (index, oid) in ids.iter().enumerate() {
            let detail =
                commit_detail(&backend, &repo_key(&repo), oid, None, gen, index as u64 + 1)
                    .await
                    .unwrap();
            assert_eq!(detail.commit.oid, *oid);
            assert!(detail.body.contains(&format!("正文 {index}")));
            assert_eq!(detail.files[0].path, "file.txt");
        }
        let metadata = fs::read_to_string(&trace).unwrap();
        assert_eq!(
            metadata
                .lines()
                .filter(|line| line.contains("built-in: git log "))
                .count(),
            16,
            "每份详情用一次 log 同时读取头信息和正文"
        );
        for (index, oid) in ids.iter().enumerate() {
            commit_file_diff(
                &backend,
                &repo_key(&repo),
                oid,
                None,
                "file.txt",
                gen,
                100 + index as u64,
                0,
                0,
                3,
                false,
            )
            .await
            .unwrap();
        }
        let trace = fs::read_to_string(&trace).unwrap();
        assert_eq!(
            trace
                .lines()
                .filter(|line| line.contains("built-in: git diff-tree "))
                .count(),
            16,
            "逐提交读取差异时不重复扫描已读取的文件目录"
        );
        assert_eq!(
            trace
                .lines()
                .filter(|line| line.contains("built-in: git diff --numstat "))
                .count(),
            16
        );
        eprintln!("16 commit details and diffs: {:?}", start.elapsed());
    }

    #[tokio::test]
    async fn file_directory_cache_is_scoped_to_commit_parent_repo_and_generation() {
        let fixture = crate::test_support::git_fixture("history-file-cache");
        let trace = fixture.path().join("trace.log");
        let backend = fixture
            .backend_with_extra_env(vec![("GIT_TRACE".into(), trace.as_os_str().to_os_string())]);
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("file.txt"), "changed\n").unwrap();
        git(&repo, &["commit", "-am", "edit"]);
        let oid = git_text(&repo, &["rev-parse", "HEAD"]);
        let git = require_git(&backend).await.unwrap();
        let gen = generation(&backend, &repo);
        let first = load_commit_files(&backend, &repo, &git.path, &oid, Some(&base), gen)
            .await
            .unwrap();
        let second = load_commit_files(&backend, &repo, &git.path, &oid, Some(&base), gen)
            .await
            .unwrap();
        assert_eq!(first.0[0].path, second.0[0].path);
        for request_id in [301, 302] {
            let diff = commit_file_diff(
                &backend,
                &repo_key(&repo),
                &oid,
                Some(&base),
                "file.txt",
                gen,
                request_id,
                0,
                0,
                3,
                false,
            )
            .await
            .unwrap();
            assert_eq!(diff.additions, 1);
            assert_eq!(diff.deletions, 1);
        }
        assert_eq!(
            fs::read_to_string(&trace)
                .unwrap()
                .lines()
                .filter(|line| line.contains("built-in: git diff --numstat "))
                .count(),
            1,
            "file previews reuse the directory's complete line counts"
        );
        assert_eq!(
            fs::read_to_string(&trace)
                .unwrap()
                .lines()
                .filter(|line| line.contains("built-in: git diff-tree "))
                .count(),
            1
        );
        let next = backend.scheduler.bump_generation(&repo_key(&repo));
        assert_eq!(
            load_commit_files(&backend, &repo, &git.path, &oid, Some(&base), gen)
                .await
                .unwrap_err()
                .code,
            "stale"
        );
        load_commit_files(&backend, &repo, &git.path, &oid, Some(&base), next)
            .await
            .unwrap();
        load_commit_files(&backend, &repo, &git.path, &base, None, next)
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(&trace)
                .unwrap()
                .lines()
                .filter(|line| line.contains("built-in: git diff-tree "))
                .count(),
            3
        );
    }

    fn generation(backend: &Backend, root: &Path) -> u64 {
        backend.scheduler.current_generation(&repo_key(root))
    }

    #[tokio::test]
    async fn unpushed_scope_follows_upstream_and_falls_back_to_remotes() {
        let fixture = crate::test_support::git_fixture("history-unpushed");
        let backend = fixture.backend();
        let unborn = fixture.repo("unborn");
        git(&unborn, &["init", "-b", "main"]);
        let unborn_root = canonical_existing(&unborn).unwrap();
        let request = HistoryRequest { scope: "unpushed".to_string(), ..HistoryRequest::default() };
        let empty = history_page(&backend, &repo_key(&unborn_root), &request, generation(&backend, &unborn_root), 1)
            .await
            .unwrap();
        assert!(empty.commits.is_empty(), "还没有提交的分支不报错");

        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        let commit = |message: &str| {
            fs::write(repo.join("file.txt"), message).unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-m", message]);
            git_text(&repo, &["rev-parse", "HEAD"])
        };
        let a = commit("a");
        let b = commit("b");
        let c = commit("c");
        git(&repo, &["remote", "add", "origin", "../nowhere"]);
        git(&repo, &["update-ref", "refs/remotes/origin/main", &a]);
        let root = canonical_existing(&repo).unwrap();
        let oids = |page: &HistoryPage| page.commits.iter().map(|commit| commit.oid.clone()).collect::<Vec<_>>();

        // 没有上游：任何远程分支上都还没有的提交。
        let page = history_page(&backend, &repo_key(&root), &request, generation(&backend, &root), 2)
            .await
            .unwrap();
        assert_eq!(page.scope, "unpushed");
        assert_eq!(oids(&page), vec![c.clone(), b.clone()]);

        // 有上游：按上游计算，与状态栏的领先数一致；别的远程分支上有也不算推送到了上游。
        git(&repo, &["update-ref", "refs/remotes/origin/main", &b]);
        git(&repo, &["branch", "--set-upstream-to=origin/main", "main"]);
        git(&repo, &["update-ref", "refs/remotes/origin/other", &c]);
        let page = history_page(&backend, &repo_key(&root), &request, generation(&backend, &root), 3)
            .await
            .unwrap();
        assert_eq!(oids(&page), vec![c.clone()]);

        git(&repo, &["update-ref", "refs/remotes/origin/main", &c]);
        let page = history_page(&backend, &repo_key(&root), &request, generation(&backend, &root), 4)
            .await
            .unwrap();
        assert!(page.commits.is_empty());
        assert_eq!(page.state, "no_match");
    }

    #[tokio::test]
    async fn commit_diff_reads_full_file_and_binary_text_on_request() {
        let fixture = crate::test_support::git_fixture("history-full-text");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        let body: String = (1..=40).map(|line| format!("line {line}\n")).collect();
        fs::write(repo.join("file.txt"), &body).unwrap();
        fs::write(repo.join("zero.rs"), b"fn a() {}\nlet raw = b\"abc\x00def\";\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("file.txt"), body.replace("line 20\n", "line twenty\n")).unwrap();
        fs::write(repo.join("zero.rs"), b"fn b() {}\nlet raw = b\"abc\x00def\";\n").unwrap();
        git(&repo, &["commit", "-am", "edit"]);
        let oid = git_text(&repo, &["rev-parse", "HEAD"]);
        let root = canonical_existing(&repo).unwrap();
        let key = repo_key(&root);
        let gen = generation(&backend, &root);

        let hunks = commit_file_diff(&backend, &key, &oid, Some(&base), "file.txt", gen, 1, 0, 0, 3, false)
            .await
            .unwrap();
        let full = commit_file_diff(
            &backend, &key, &oid, Some(&base), "file.txt", hunks.generation, 2, 0, 0,
            crate::git::changes::FULL_FILE_CONTEXT, false,
        )
        .await
        .unwrap();
        let has = |diff: &crate::model::DiffResponse, text: &str| diff.lines.iter().any(|line| line.text.trim_end() == text);
        assert!(!has(&hunks, " line 1"));
        assert!(has(&full, " line 1"));
        assert!(has(&full, " line 40"));

        let binary = commit_file_diff(&backend, &key, &oid, Some(&base), "zero.rs", full.generation, 3, 0, 0, 3, false)
            .await
            .unwrap();
        assert!(binary.binary);
        let text = commit_file_diff(&backend, &key, &oid, Some(&base), "zero.rs", binary.generation, 4, 0, 0, 3, true)
            .await
            .unwrap();
        assert!(!text.binary);
        assert_eq!((text.additions, text.deletions), (1, 1));
        assert!(text.lines.iter().any(|line| line.text.contains("abc\u{2400}def")));
        assert!(text.hunks.iter().all(|hunk| !hunk.stageable));
    }

    #[test]
    fn parsers_cover_parents_renames_and_stash_scope() {
        let raw = "abc\u{1f}def 123\u{1f}Ada\u{1f}ada@example.com\u{1f}10\u{1f}subject\u{1e}";
        let commits = parse_history_records(raw.as_bytes()).unwrap();
        assert_eq!(
            commits[0].parents,
            vec!["def".to_string(), "123".to_string()]
        );
        assert_eq!(commits[0].summary, "subject");
        let files =
            parse_name_status(b"M\0file.txt\0R100\0old name.txt\0new.txt\0D\0gone.txt\0").unwrap();
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].status, "renamed");
        assert_eq!(files[1].original_path.as_deref(), Some("old name.txt"));
        assert_eq!(files[2].status, "deleted");
        let followed = parse_follow_records(
            b"\x1eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f1700000300\nM\0new name.txt\0\0\
              \x1ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1f1700000200\nR100\0old.txt\0new name.txt\0\0\
              \x1ecccccccccccccccccccccccccccccccccccccccc\x1f1700000100\nA\0old.txt\0",
        )
        .unwrap();
        assert_eq!(followed.len(), 3);
        assert_eq!(followed[0].oid, "a".repeat(40));
        assert_eq!(followed[0].path_in_commit, "new name.txt");
        assert_eq!(followed[1].path_in_commit, "new name.txt");
        assert_eq!(followed[1].at, 1_700_000_200);
        assert_eq!(followed[2].path_in_commit, "old.txt");
        let (_can, summary) = scope_summary(1, 2, 3, false);
        assert!(summary.contains("已跟踪"));
        assert!(summary.contains("未跟踪文件 2 个这次不保存"));
        assert!(summary.contains("忽略文件 3 个不会保存"));
        let (program, args) =
            stash_push_command(Path::new("git"), Path::new("/tmp/repo"), true, Some("note"));
        assert!(program.ends_with("git"));
        assert!(args.iter().any(|arg| arg == "--include-untracked"));
        assert!(!args
            .iter()
            .any(|arg| arg == "--all" || arg == "-a" || arg == "--include-ignored"));
    }

    #[tokio::test]
    async fn containing_branches_and_range_diffs_answer_where_a_commit_lives() {
        let fixture = crate::test_support::git_fixture("history-contains");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["rev-parse", "HEAD"]).trim().to_string();
        git(&repo, &["switch", "-c", "topic"]);
        fs::write(repo.join("file.txt"), "one\n").unwrap();
        git(&repo, &["commit", "-am", "one"]);
        fs::write(repo.join("file.txt"), "two\n").unwrap();
        git(&repo, &["commit", "-am", "two"]);
        let tip = git_text(&repo, &["rev-parse", "HEAD"]).trim().to_string();
        git(&repo, &["switch", "main"]);
        git(&repo, &["update-ref", "refs/remotes/origin/main", &base]);
        git(&repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        let gen = generation(&backend, &repo);
        let found = commit_branches(&backend, &repo_key(&repo), &base, gen, 401).await.unwrap();
        let names: Vec<_> = found.branches.iter().map(|branch| (branch.name.as_str(), branch.remote, branch.current)).collect();
        assert_eq!(names, vec![("main", false, true), ("topic", false, false), ("origin/main", true, false)]);
        assert_eq!(found.current.as_deref(), Some("main"));
        assert_eq!(found.total, 3);
        let only_topic = commit_branches(&backend, &repo_key(&repo), &tip, found.generation, 402).await.unwrap();
        assert_eq!(only_topic.branches.len(), 1);
        assert!(!only_topic.branches[0].current);

        // 合并预览里的文件差异：共同祖先 → 来源顶端，跨越两个提交。
        let diff = compare_file_diff(&backend, &repo_key(&repo), &base, &tip, "file.txt", only_topic.generation, 403, 0, 0, 3)
            .await
            .unwrap();
        assert_eq!((diff.additions, diff.deletions), (1, 1));
        assert!(diff.lines.iter().any(|line| line.text.contains("two")));
        assert!(!diff.lines.iter().any(|line| line.text == "+one"));
        let invalid = compare_file_diff(&backend, &repo_key(&repo), "HEAD", &tip, "file.txt", diff.generation, 404, 0, 0, 3)
            .await
            .unwrap_err();
        assert_eq!(invalid.code, "invalid_revision");

        // 多选净结果：两点之间只列最终变化的文件，行数是净行数。
        let net = compare_files(&backend, &repo_key(&repo), Some(&base), &tip, diff.generation, 405).await.unwrap();
        assert_eq!(net.files.len(), 1);
        assert_eq!(net.files[0].path, "file.txt");
        assert_eq!((net.files[0].additions, net.files[0].deletions), (Some(1), Some(1)));
        // 没有起点按空树比较：首个提交里的文件都算新增。
        let from_empty = compare_files(&backend, &repo_key(&repo), None, &tip, net.generation, 406).await.unwrap();
        assert_eq!(from_empty.files[0].status, "added");
        let root_diff = compare_file_diff(&backend, &repo_key(&repo), "", &tip, "file.txt", from_empty.generation, 407, 0, 0, 3)
            .await
            .unwrap();
        assert_eq!((root_diff.additions, root_diff.deletions), (1, 0));
        let bad = compare_files(&backend, &repo_key(&repo), Some("HEAD"), &tip, root_diff.generation, 408).await.unwrap_err();
        assert_eq!(bad.code, "invalid_revision");
    }

    #[tokio::test]
    async fn range_scope_lists_only_commits_after_the_baseline() {
        let fixture = crate::test_support::git_fixture("history-range");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["rev-parse", "HEAD"]).trim().to_string();
        fs::write(repo.join("file.txt"), "one\n").unwrap();
        git(&repo, &["commit", "-am", "one"]);
        fs::write(repo.join("file.txt"), "two\n").unwrap();
        git(&repo, &["commit", "-am", "two"]);

        let gen = generation(&backend, &repo);
        let request = HistoryRequest { scope: format!("range:{base}"), ..HistoryRequest::default() };
        let page = history_page(&backend, &repo_key(&repo), &request, gen, 501).await.unwrap();
        let summaries: Vec<_> = page.commits.iter().map(|commit| commit.summary.as_str()).collect();
        assert_eq!(summaries, vec!["two", "one"]);
        assert_eq!(page.scope, format!("range:{base}"));

        let invalid = HistoryRequest { scope: "range:HEAD~1".to_string(), ..HistoryRequest::default() };
        let error = history_page(&backend, &repo_key(&repo), &invalid, page.generation, 502).await.unwrap_err();
        assert_eq!(error.code, "invalid_revision");
    }

    #[tokio::test]
    async fn search_reads_beyond_the_loaded_page_and_keeps_parents_and_labels() {
        let fixture = crate::test_support::git_fixture("history-page");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::create_dir(repo.join("docs")).unwrap();
        fs::write(repo.join("docs/文件 1.txt"), "root-line\n").unwrap();
        git(&repo, &["add", "--", "docs/文件 1.txt"]);
        git_env(
            &repo,
            &[
                ("GIT_AUTHOR_NAME", "Ada Lovelace"),
                ("GIT_AUTHOR_EMAIL", "ada@example.com"),
                ("GIT_AUTHOR_DATE", "1000000000 +0000"),
                ("GIT_COMMITTER_DATE", "1000000000 +0000"),
            ],
            &["commit", "-m", "unique-needle-message"],
        );
        let needle = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["tag", "v1", &needle]);
        git(&repo, &["branch", "feature", &needle]);
        for index in 0..HISTORY_PAGE_SIZE {
            let stamp = format!("{} +0000", 1_100_000_000u64 + u64::from(index));
            let message = format!("filler {index}");
            git_env(
                &repo,
                &[("GIT_AUTHOR_DATE", &stamp), ("GIT_COMMITTER_DATE", &stamp)],
                &["commit", "--allow-empty", "-m", &message],
            );
        }
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let before = stamp(&root);
        let page = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest::default(),
            generation,
            1,
        )
        .await
        .unwrap();
        assert_eq!(page.state, "ok");
        assert_eq!(page.commits.len(), HISTORY_PAGE_SIZE as usize);
        assert!(page.has_more);
        assert!(page
            .commits
            .iter()
            .all(|commit| commit.summary.starts_with("filler")));
        assert!(page.commits[0]
            .labels
            .iter()
            .any(|label| label.name == "main" && label.current));
        assert!(page.commits.iter().all(|commit| !commit.parents.is_empty()));
        let by_message = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                query: "UNIQUE-NEEDLE".to_string(),
                ..HistoryRequest::default()
            },
            page.generation,
            2,
        )
        .await
        .unwrap();
        assert_eq!(by_message.commits.len(), 1);
        assert_eq!(by_message.commits[0].oid, needle);
        assert!(by_message.commits[0]
            .labels
            .iter()
            .any(|label| label.kind == "branch" && label.name == "feature"));
        assert!(by_message.commits[0]
            .labels
            .iter()
            .any(|label| label.kind == "tag" && label.name == "v1"));
        let author_as_text = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                query: "Lovelace".to_string(),
                ..HistoryRequest::default()
            },
            generation,
            3,
        )
        .await
        .unwrap();
        assert!(author_as_text.commits.is_empty());
        assert_eq!(author_as_text.state, "no_match");
        let by_author = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                author: "Lovelace".to_string(),
                ..HistoryRequest::default()
            },
            generation,
            4,
        )
        .await
        .unwrap();
        assert_eq!(by_author.commits.len(), 1);
        assert_eq!(by_author.commits[0].oid, needle);
        let by_oid = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                query: needle[..7].to_ascii_uppercase(),
                ..HistoryRequest::default()
            },
            generation,
            5,
        )
        .await
        .unwrap();
        assert_eq!(by_oid.commits.len(), 1);
        assert_eq!(by_oid.commits[0].oid, needle);
        let missing = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                query: "zzz-no-such-commit".to_string(),
                ..HistoryRequest::default()
            },
            generation,
            6,
        )
        .await
        .unwrap();
        assert_eq!(missing.state, "no_match");
        assert!(missing.commits.is_empty());
        assert_eq!(stamp(&root), before);
    }

    #[tokio::test]
    async fn detail_shows_root_merge_and_deleted_files_without_changing_the_worktree() {
        let fixture = crate::test_support::git_fixture("history-detail");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "root"]);
        let root_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "-b", "side"]);
        fs::write(repo.join("side.txt"), "from-side\n").unwrap();
        git(&repo, &["add", "--", "side.txt"]);
        git(&repo, &["commit", "-m", "side"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("main.txt"), "from-main\n").unwrap();
        git(&repo, &["add", "--", "main.txt"]);
        git(&repo, &["commit", "-m", "mainline"]);
        git(&repo, &["merge", "--no-ff", "side", "-m", "merge-topic"]);
        let merge_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("main.txt"), "edited\n").unwrap();
        git(&repo, &["add", "--", "main.txt"]);
        git(&repo, &["commit", "-m", "edit-main"]);
        git(&repo, &["rm", "file.txt"]);
        git(&repo, &["commit", "-m", "remove-file"]);
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let before = stamp(&root);

        let root_detail = commit_detail(&backend, &repo_key(&root), &root_oid, None, generation, 1)
            .await
            .unwrap();
        assert!(root_detail.root);
        assert!(root_detail.selected_parent.is_none());
        assert!(root_detail
            .files
            .iter()
            .any(|file| file.path == "file.txt" && file.status == "added"));
        let root_diff = commit_file_diff(
            &backend,
            &repo_key(&root),
            &root_oid,
            None,
            "file.txt",
            root_detail.generation,
            2,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        assert!(root_diff.additions > 0);

        let merge = commit_detail(&backend, &repo_key(&root), &merge_oid, None, generation, 3)
            .await
            .unwrap();
        assert!(merge.merge);
        assert_eq!(merge.commit.parents.len(), 2);
        assert_eq!(
            merge.selected_parent.as_deref(),
            Some(merge.commit.parents[0].as_str())
        );
        assert!(merge.files.iter().any(|file| file.path == "side.txt"));
        let other = commit_detail(
            &backend,
            &repo_key(&root),
            &merge_oid,
            Some(&merge.commit.parents[1]),
            merge.generation,
            4,
        )
        .await
        .unwrap();
        assert_eq!(
            other.selected_parent.as_deref(),
            Some(merge.commit.parents[1].as_str())
        );
        assert!(other.files.iter().any(|file| file.path == "main.txt"));
        assert!(other.files.iter().all(|file| file.path != "side.txt"));

        let history = file_history(
            &backend,
            &repo_key(&root),
            "file.txt",
            &HistoryRequest::default(),
            generation,
            5,
        )
            .await
            .unwrap();
        assert_eq!(history.state, "ok");
        let removal = history
            .commits
            .iter()
            .find(|commit| commit.summary == "remove-file")
            .unwrap();
        let removal_detail = commit_detail(
            &backend,
            &repo_key(&root),
            &removal.oid,
            None,
            generation,
            6,
        )
        .await
        .unwrap();
        assert!(removal_detail
            .files
            .iter()
            .any(|file| file.path == "file.txt" && file.status == "deleted"));
        let removal_diff = commit_file_diff(
            &backend,
            &repo_key(&root),
            &removal.oid,
            removal_detail.selected_parent.as_deref(),
            "file.txt",
            removal_detail.generation,
            7,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        assert!(removal_diff.deletions > 0);
        let edits = file_history(
            &backend,
            &repo_key(&root),
            "main.txt",
            &HistoryRequest::default(),
            generation,
            8,
        )
            .await
            .unwrap();
        let edit = edits
            .commits
            .iter()
            .find(|commit| commit.summary == "edit-main")
            .unwrap();
        let edit_diff = commit_file_diff(
            &backend,
            &repo_key(&root),
            &edit.oid,
            None,
            "main.txt",
            generation,
            9,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        assert!(edit_diff
            .lines
            .iter()
            .any(|line| line.text.contains("edited")));
        let absent = file_history(
            &backend,
            &repo_key(&root),
            "missing.txt",
            &HistoryRequest::default(),
            generation,
            10,
        )
            .await
            .unwrap();
        assert_eq!(absent.state, "no_file_history");
        assert_eq!(stamp(&root), before);
    }

    #[tokio::test]
    async fn history_filters_intersect_on_the_current_branch_without_writing() {
        let fixture = crate::test_support::git_fixture("history-filters");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::create_dir(repo.join("docs")).unwrap();
        let day1 = "1700000000 +0000";
        let day2 = "1700086400 +0000";
        let commit_as = |message: &str, author: &str, date: &str, file: &str, body: &str| {
            fs::write(repo.join(file), body).unwrap();
            git(&repo, &["add", "--", file]);
            git_env(
                &repo,
                &[
                    ("GIT_AUTHOR_NAME", author),
                    ("GIT_AUTHOR_EMAIL", "person@example.com"),
                    ("GIT_AUTHOR_DATE", date),
                    ("GIT_COMMITTER_DATE", date),
                ],
                &["commit", "-m", message],
            );
        };
        commit_as("needle alpha", "Ada", day1, "docs/a.txt", "alpha\n");
        let alpha = git_text(&repo, &["rev-parse", "HEAD"]);
        commit_as("needle beta", "Ada", day1, "other.txt", "beta\n");
        let beta = git_text(&repo, &["rev-parse", "HEAD"]);
        commit_as("needle gamma", "Grace", day1, "docs/a.txt", "gamma\n");
        commit_as("needle delta", "Ada", day2, "docs/a.txt", "delta\n");
        git(&repo, &["checkout", "-b", "feature", &alpha]);
        commit_as("needle feature", "Ada", day1, "docs/a.txt", "feature\n");
        let feature_oid = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let before = stamp(&root);
        let narrow = HistoryRequest {
            query: "needle".to_string(),
            author: "Ada".to_string(),
            since: Some(1_700_000_000),
            until: Some(1_700_000_000 + 86_399),
            path: "docs".to_string(),
            ..HistoryRequest::default()
        };
        let page = history_page(&backend, &repo_key(&root), &narrow, generation, 1)
            .await
            .unwrap();
        assert_eq!(page.commits.iter().map(|commit| commit.oid.as_str()).collect::<Vec<_>>(), vec![alpha.as_str()]);
        assert_eq!(page.scope, "current");
        assert_eq!(page.head.as_deref(), Some("main"));
        assert!(page.branches.iter().any(|branch| branch == "feature"));
        let cleared_path = HistoryRequest {
            path: String::new(),
            ..narrow.clone()
        };
        let cleared = history_page(&backend, &repo_key(&root), &cleared_path, page.generation, 2)
            .await
            .unwrap();
        let cleared_oids: Vec<&str> = cleared.commits.iter().map(|commit| commit.oid.as_str()).collect();
        assert!(cleared_oids.contains(&alpha.as_str()));
        assert!(cleared_oids.contains(&beta.as_str()));
        assert!(!cleared_oids.contains(&feature_oid.as_str()));
        assert!(cleared.commits.iter().all(|commit| commit.author_name == "Ada"));
        assert!(cleared.commits.iter().all(|commit| commit.summary != "needle delta" && commit.summary != "needle gamma"));
        let all = HistoryRequest {
            scope: "all".to_string(),
            ..narrow.clone()
        };
        let all_page = history_page(&backend, &repo_key(&root), &all, cleared.generation, 3)
            .await
            .unwrap();
        let all_oids: Vec<&str> = all_page.commits.iter().map(|commit| commit.oid.as_str()).collect();
        assert!(all_oids.contains(&alpha.as_str()));
        assert!(all_oids.contains(&feature_oid.as_str()));
        assert!(!all_oids.contains(&beta.as_str()));
        let exact = HistoryRequest {
            query: "needle alpha".to_string(),
            since: Some(1_700_000_000),
            until: Some(1_700_000_000),
            ..HistoryRequest::default()
        };
        let exact_page = history_page(&backend, &repo_key(&root), &exact, all_page.generation, 4)
            .await
            .unwrap();
        assert_eq!(exact_page.commits.len(), 1);
        let before_second = HistoryRequest {
            query: "needle alpha".to_string(),
            since: Some(1_700_000_000),
            until: Some(1_699_999_999),
            ..HistoryRequest::default()
        };
        let missed = history_page(&backend, &repo_key(&root), &before_second, exact_page.generation, 5)
            .await
            .unwrap();
        assert_eq!(missed.state, "no_match");
        assert!(missed.commits.is_empty());
        let default_page = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest::default(),
            missed.generation,
            6,
        )
        .await
        .unwrap();
        assert!(default_page.commits.iter().all(|commit| commit.oid != feature_oid));
        assert!(default_page.commits.iter().any(|commit| commit.summary == "needle delta"));
        let all_plain = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                scope: "all".to_string(),
                ..HistoryRequest::default()
            },
            default_page.generation,
            7,
        )
        .await
        .unwrap();
        assert!(all_plain.commits.iter().any(|commit| commit.oid == feature_oid));
        assert_eq!(stamp(&root), before);
        git(&repo, &["checkout", "--orphan", "empty"]);
        let empty = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest::default(),
            all_plain.generation,
            8,
        )
        .await
        .unwrap();
        assert!(empty.commits.is_empty());
        assert_eq!(empty.state, "empty_branch");
        assert_eq!(empty.head.as_deref(), Some("empty"));
        assert_eq!(empty.scope, "current");
    }

    #[tokio::test]
    async fn file_history_page_follows_the_rename_instead_of_skipping_it() {
        let fixture = crate::test_support::git_fixture("history-follow-page");
        let trace = fixture.path().join("trace.log");
        let backend = fixture.backend_with_extra_env(vec![(
            "GIT_TRACE".into(),
            trace.as_os_str().to_os_string(),
        )]);
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("old.txt"), "v0\n").unwrap();
        git(&repo, &["add", "--", "old.txt"]);
        git(&repo, &["commit", "-m", "old-base"]);
        let oldest = git_text(&repo, &["rev-parse", "HEAD"]);
        for index in 1..30 {
            fs::write(repo.join("old.txt"), format!("v{index}\n")).unwrap();
            git(&repo, &["commit", "-am", &format!("old-{index}")]);
        }
        git(&repo, &["mv", "--", "old.txt", "new.txt"]);
        git(&repo, &["commit", "-m", "rename-file"]);
        for index in 0..80 {
            fs::write(repo.join("new.txt"), format!("n{index}\n")).unwrap();
            git(&repo, &["commit", "-am", &format!("new-{index}")]);
        }
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let first = file_history(
            &backend,
            &repo_key(&root),
            "new.txt",
            &HistoryRequest::default(),
            generation,
            1,
        )
        .await
        .unwrap();
        assert_eq!(first.commits.len(), HISTORY_PAGE_SIZE as usize);
        assert!(first.has_more);
        assert!(first.commits.iter().any(|commit| commit.summary == "rename-file"));
        assert!(first
            .commits
            .iter()
            .any(|commit| commit.summary.starts_with("old-")));
        let second = file_history(
            &backend,
            &repo_key(&root),
            "new.txt",
            &HistoryRequest {
                offset: HISTORY_PAGE_SIZE,
                ..HistoryRequest::default()
            },
            first.generation,
            2,
        )
        .await
        .unwrap();
        assert!(!second.commits.is_empty());
        assert!(second.commits.iter().any(|commit| commit.oid == oldest));
        assert!(!second.has_more);
        let stalled = file_history(
            &backend,
            &repo_key(&root),
            "new.txt",
            &HistoryRequest {
                offset: 1_000,
                ..HistoryRequest::default()
            },
            second.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(stalled.code, "history_incomplete");
        let trace_text = fs::read_to_string(&trace).unwrap();
        let followed: Vec<_> = trace_text
            .lines()
            .filter(|line| line.contains("--follow"))
            .collect();
        assert!(!followed.is_empty());
        assert!(followed.iter().all(|line| !line.contains("--skip")));
        assert!(followed.iter().any(|line| line.contains("--max-count=")));
    }

    #[tokio::test]
    async fn file_history_page_includes_side_line_commits_beyond_the_first_page() {
        let fixture = crate::test_support::git_fixture("history-follow-side");
        let trace = fixture.path().join("trace.log");
        let backend = fixture.backend_with_extra_env(vec![(
            "GIT_TRACE".into(),
            trace.as_os_str().to_os_string(),
        )]);
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git_env(
            &repo,
            &[
                ("GIT_AUTHOR_DATE", "1000000000 +0000"),
                ("GIT_COMMITTER_DATE", "1000000000 +0000"),
            ],
            &["commit", "-m", "base"],
        );
        git(&repo, &["checkout", "-b", "side"]);
        fs::write(repo.join("file.txt"), "side\n").unwrap();
        git_env(
            &repo,
            &[
                ("GIT_AUTHOR_DATE", "1000000010 +0000"),
                ("GIT_COMMITTER_DATE", "1000000010 +0000"),
            ],
            &["commit", "-am", "side-old"],
        );
        let side_old = git_text(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        for index in 0u32..101 {
            fs::write(repo.join("file.txt"), format!("main-{index}\n")).unwrap();
            let stamp = format!("{} +0000", 1_100_000_000u64 + u64::from(index));
            git_env(
                &repo,
                &[
                    ("GIT_AUTHOR_DATE", &stamp),
                    ("GIT_COMMITTER_DATE", &stamp),
                ],
                &["commit", "-am", &format!("main-{index}")],
            );
        }
        let conflicted = git_exit(&repo, &["merge", "--no-ff", "side", "-m", "merge-side"]);
        assert!(!conflicted.success());
        fs::write(repo.join("file.txt"), "merged\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git_env(
            &repo,
            &[
                ("GIT_AUTHOR_DATE", "1200000000 +0000"),
                ("GIT_COMMITTER_DATE", "1200000000 +0000"),
            ],
            &["commit", "--no-edit"],
        );
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let first = file_history(
            &backend,
            &repo_key(&root),
            "file.txt",
            &HistoryRequest::default(),
            generation,
            1,
        )
        .await
        .unwrap();
        assert_eq!(first.commits.len(), HISTORY_PAGE_SIZE as usize);
        assert!(first.has_more);
        assert!(first.commits.iter().all(|commit| commit.oid != side_old));
        let second = file_history(
            &backend,
            &repo_key(&root),
            "file.txt",
            &HistoryRequest {
                offset: HISTORY_PAGE_SIZE,
                ..HistoryRequest::default()
            },
            first.generation,
            2,
        )
        .await
        .unwrap();
        assert!(second.commits.iter().any(|commit| commit.oid == side_old));
        let trace_text = fs::read_to_string(&trace).unwrap();
        let followed: Vec<_> = trace_text
            .lines()
            .filter(|line| line.contains("--follow"))
            .collect();
        assert!(!followed.is_empty());
        assert!(followed.iter().all(|line| !line.contains("--skip")));
    }

    #[tokio::test]
    async fn dated_history_filters_author_time_inside_bounded_log_pages() {
        let fixture = crate::test_support::git_fixture("history-date-page");
        let trace = fixture.path().join("trace.log");
        let backend = fixture.backend_with_limit(
            8192,
            vec![("GIT_TRACE".into(), trace.as_os_str().to_os_string())],
        );
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        for index in 0..180 {
            git_env(
                &repo,
                &[
                    ("GIT_AUTHOR_DATE", "1600000000 +0000"),
                    ("GIT_COMMITTER_DATE", "1600000000 +0000"),
                ],
                &["commit", "--allow-empty", "-m", &format!("filler-{index}")],
            );
        }
        git_env(
            &repo,
            &[
                ("GIT_AUTHOR_DATE", "1700000000 +0000"),
                ("GIT_COMMITTER_DATE", "1900000000 +0000"),
            ],
            &["commit", "--allow-empty", "-m", "inside-day"],
        );
        let marker = git_text(&repo, &["rev-parse", "HEAD"]);
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let page = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                since: Some(1_700_000_000),
                until: Some(1_700_000_000 + 86_399),
                ..HistoryRequest::default()
            },
            generation,
            1,
        )
        .await
        .unwrap();
        assert_eq!(page.state, "ok");
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].oid, marker);
        assert_eq!(page.commits[0].authored_at, 1_700_000_000);
        assert!(!page.has_more);
        let trace_text = fs::read_to_string(&trace).unwrap();
        let logs: Vec<_> = trace_text
            .lines()
            .filter(|line| line.contains(" git log ") || line.contains("git.exe log "))
            .collect();
        assert!(logs.len() >= 2, "{trace_text}");
        assert!(logs.iter().all(|line| !line.contains("--since") && !line.contains("--until")));
        assert!(logs.iter().any(|line| line.contains("--max-count=")));
        assert!(logs
            .iter()
            .filter(|line| !line.contains("--no-walk"))
            .all(|line| line.contains("--max-count=")));
    }

    #[tokio::test]
    async fn empty_repository_is_not_reported_as_a_search_miss() {
        let fixture = crate::test_support::git_fixture("history-empty");
        let repo = fixture.repo("empty");
        git(&repo, &["init", "-b", "main"]);
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let page = history_page(
            &backend,
            &repo_key(&root),
            &HistoryRequest {
                query: "needle".to_string(),
                ..HistoryRequest::default()
            },
            generation,
            1,
        )
        .await
        .unwrap();
        assert_eq!(page.state, "empty_repository");
        let files = file_history(
            &backend,
            &repo_key(&root),
            "file.txt",
            &HistoryRequest::default(),
            generation,
            2,
        )
            .await
            .unwrap();
        assert_eq!(files.state, "empty_repository");
    }

    /// 写后读取遇到 stale（文件监视器在写锁释放后推高 generation）时，后端用最新
    /// generation 重读，不把 stale 交给前端——否则前端会把已成功的写操作再执行一次。
    #[tokio::test]
    async fn post_write_reads_settle_instead_of_reporting_stale() {
        let fixture = crate::test_support::git_fixture("settle-read");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let start = generation(&backend, &root);
        let mut seen = Vec::new();
        let result: Result<u64, AppError> = settle_read!(&backend, &root, start, |current| {
            seen.push(current);
            if seen.len() < 3 {
                backend.scheduler.bump_generation(&repo_key(&root));
                Err(AppError::new("stale", "changed"))
            } else {
                Ok(current)
            }
        });
        assert_eq!(result.unwrap(), start + 2);
        assert_eq!(seen, vec![start, start + 1, start + 2]);
        let other: Result<u64, AppError> = settle_read!(&backend, &root, start, |_current| Err(
            AppError::new("boom", "x")
        ));
        assert_eq!(other.unwrap_err().code, "boom");
    }

    #[tokio::test]
    async fn stash_declares_scope_keeps_records_and_checks_identity() {
        let fixture = crate::test_support::git_fixture("stash-scope");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        fs::write(repo.join(".gitignore"), "ignored.log\n").unwrap();
        git(&repo, &["add", "--", "file.txt", ".gitignore"]);
        git(&repo, &["commit", "-m", "base"]);
        let head = git_text(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("file.txt"), "tracked\n").unwrap();
        fs::write(repo.join("new.txt"), "free\n").unwrap();
        fs::write(repo.join("ignored.log"), "secret\n").unwrap();
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let preview = stash_state(&backend, &repo_key(&root), false, generation, 1)
            .await
            .unwrap();
        assert!(preview.preview.summary.contains("已跟踪"));
        assert!(preview
            .preview
            .summary
            .contains("未跟踪文件 1 个这次不保存"));
        assert!(preview.preview.summary.contains("忽略文件 1 个不会保存"));
        assert!(preview.preview.can_save);
        assert_eq!(preview.preview.tracked_paths, vec!["file.txt".to_string()]);
        let saved = save_stash(
            &backend,
            &repo_key(&root),
            false,
            "keep tracked",
            preview.generation,
            2,
        )
        .await
        .unwrap();
        assert!(saved.note.contains("未跟踪文件 1 个这次不保存"));
        assert!(saved.note.contains("忽略文件"));
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "base\n");
        assert_eq!(fs::read_to_string(repo.join("new.txt")).unwrap(), "free\n");
        assert_eq!(
            fs::read_to_string(repo.join("ignored.log")).unwrap(),
            "secret\n"
        );
        let shown = git_text(&repo, &["stash", "show", "--name-only", "stash@{0}"]);
        assert!(shown.contains("file.txt"));
        assert!(!shown.contains("new.txt"));
        assert!(!shown.contains("ignored.log"));
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), head);

        fs::write(repo.join("file.txt"), "second\n").unwrap();
        let again = save_stash(
            &backend,
            &repo_key(&root),
            true,
            "",
            saved.state.generation,
            3,
        )
        .await
        .unwrap();
        assert!(!repo.join("new.txt").exists());
        assert_eq!(
            fs::read_to_string(repo.join("ignored.log")).unwrap(),
            "secret\n"
        );
        let shown_untracked = git_text(
            &repo,
            &[
                "stash",
                "show",
                "--include-untracked",
                "--name-only",
                "stash@{0}",
            ],
        );
        assert!(shown_untracked.contains("new.txt"));
        assert!(!shown_untracked.contains("ignored.log"));
        assert!(again
            .state
            .records
            .iter()
            .any(|record| record.oid == saved.oid));

        let refused = delete_stash(
            &backend,
            &repo_key(&root),
            &saved.oid,
            false,
            again.state.generation,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "stash_confirm");
        assert!(git_text(&repo, &["stash", "list", "--format=%H"]).contains(&saved.oid));
        let wrong = delete_stash(
            &backend,
            &repo_key(&root),
            "0123456789abcdef0123456789abcdef01234567",
            true,
            again.state.generation,
            5,
        )
        .await
        .unwrap_err();
        assert_eq!(wrong.code, "stash_missing");
        let kept_file = fs::read_to_string(repo.join("file.txt")).unwrap();
        let deleted = delete_stash(
            &backend,
            &repo_key(&root),
            &saved.oid,
            true,
            wrong.generation.unwrap(),
            6,
        )
        .await
        .unwrap();
        assert!(deleted.records.iter().all(|record| record.oid != saved.oid));
        assert!(deleted.records.iter().any(|record| record.oid == again.oid));
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            kept_file
        );
        assert_eq!(git_text(&repo, &["rev-parse", "HEAD"]), head);

        let empty = save_stash(&backend, &repo_key(&root), false, "", deleted.generation, 7)
            .await
            .unwrap_err();
        assert_eq!(empty.code, "stash_empty");
        assert_eq!(
            deleted.records.len(),
            git_text(&repo, &["stash", "list", "--format=%H"])
                .lines()
                .count()
        );
    }

    #[tokio::test]
    async fn applying_a_stash_keeps_it_and_conflict_does_not_invent_merge_abort() {
        let fixture = crate::test_support::git_fixture("stash-conflict");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "keep\n").unwrap();
        git(&repo, &["add", "--", "file.txt", "other.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        fs::write(repo.join("file.txt"), "stashed\n").unwrap();
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        let saved = save_stash(&backend, &repo_key(&root), false, "conflict", generation, 1)
            .await
            .unwrap();
        fs::write(repo.join("file.txt"), "local\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "local"]);
        let applied = apply_stash(
            &backend,
            &repo_key(&root),
            &saved.oid,
            saved.state.generation,
            2,
        )
        .await
        .unwrap();
        assert!(applied.conflicted);
        assert!(applied.kept);
        assert!(!applied.can_abort_merge);
        assert_eq!(applied.operation, "stash");
        assert_eq!(applied.conflict_paths, vec!["file.txt".to_string()]);
        assert!(applied.note.contains("没有可中止的合并"));
        let body = fs::read_to_string(repo.join("file.txt")).unwrap();
        assert!(body.contains("local"));
        assert!(body.contains("stashed"));
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "keep\n"
        );
        assert!(!repo.join(".git/MERGE_HEAD").exists());
        assert!(git_text(&repo, &["stash", "list", "--format=%H"]).contains(&saved.oid));

        git(&repo, &["reset", "--hard", "HEAD"]);
        fs::write(repo.join("file.txt"), "dirty\n").unwrap();
        let blocked = apply_stash(
            &backend,
            &repo_key(&root),
            &saved.oid,
            applied.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.code, "stash_apply_failed");
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "dirty\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "keep\n"
        );
        assert!(git_text(&repo, &["stash", "list", "--format=%H"]).contains(&saved.oid));
        assert!(!repo.join(".git/MERGE_HEAD").exists());
    }

    #[tokio::test]
    async fn stash_apply_during_an_open_merge_is_not_a_restored_conflict() {
        let fixture = crate::test_support::git_fixture("stash-during-merge");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base\n").unwrap();
        fs::write(repo.join("both.txt"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "keep\n").unwrap();
        git(&repo, &["add", "--", "file.txt", "both.txt", "other.txt"]);
        git(&repo, &["commit", "-m", "base"]);
        let backend = fixture.backend();
        let root = canonical_existing(&repo).unwrap();
        let generation = generation(&backend, &root);
        fs::write(repo.join("file.txt"), "stashed\n").unwrap();
        let saved_file = save_stash(&backend, &repo_key(&root), false, "file", generation, 1)
            .await
            .unwrap();
        fs::write(repo.join("other.txt"), "restored-other\n").unwrap();
        let saved_other = save_stash(
            &backend,
            &repo_key(&root),
            false,
            "other",
            saved_file.state.generation,
            2,
        )
        .await
        .unwrap();
        fs::write(repo.join("file.txt"), "local\n").unwrap();
        git(&repo, &["commit", "-am", "local"]);
        git(&repo, &["checkout", "-b", "side"]);
        fs::write(repo.join("both.txt"), "side\n").unwrap();
        git(&repo, &["commit", "-am", "side"]);
        git(&repo, &["checkout", "main"]);
        fs::write(repo.join("both.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-am", "main"]);
        let merge = git_exit(&repo, &["merge", "side"]);
        assert_eq!(merge.code(), Some(1));
        assert!(repo.join(".git/MERGE_HEAD").exists());
        let markers = fs::read_to_string(repo.join("both.txt")).unwrap();
        assert!(markers.contains("<<<<<<<"));
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "local\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "keep\n"
        );

        let blocked = apply_stash(
            &backend,
            &repo_key(&root),
            &saved_file.oid,
            saved_other.state.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.code, "stash_apply_failed");
        assert!(blocked.message.contains("正在进行分支合并"));
        assert!(!blocked.message.contains("没有可中止的合并"));
        assert!(!blocked.message.contains("恢复发生冲突"));
        assert!(!blocked.message.contains("已把改动恢复"));
        assert_eq!(fs::read_to_string(repo.join("both.txt")).unwrap(), markers);
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "local\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "keep\n"
        );
        assert!(repo.join(".git/MERGE_HEAD").exists());
        let stashes = git_text(&repo, &["stash", "list", "--format=%H"]);
        assert!(stashes.contains(&saved_file.oid));
        assert!(stashes.contains(&saved_other.oid));

        git(&repo, &["checkout", "--ours", "--", "both.txt"]);
        git(&repo, &["add", "--", "both.txt"]);
        assert!(repo.join(".git/MERGE_HEAD").exists());
        assert!(git_text(&repo, &["diff", "--name-only", "--diff-filter=U"]).is_empty());
        let restored = apply_stash(
            &backend,
            &repo_key(&root),
            &saved_other.oid,
            blocked.generation.expect("failed apply generation"),
            4,
        )
        .await
        .unwrap();
        assert!(!restored.conflicted);
        assert!(restored.conflict_paths.is_empty());
        assert!(!restored.can_abort_merge);
        assert!(restored.note.contains("已把改动恢复"));
        assert!(!restored.note.contains("没有可中止的合并"));
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "restored-other\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "local\n"
        );
        assert_eq!(fs::read_to_string(repo.join("both.txt")).unwrap(), "main\n");
        assert!(repo.join(".git/MERGE_HEAD").exists());

        let applied = apply_stash(
            &backend,
            &repo_key(&root),
            &saved_file.oid,
            restored.generation,
            5,
        )
        .await
        .unwrap();
        assert!(applied.conflicted);
        assert!(applied.kept);
        assert!(!applied.can_abort_merge);
        assert_eq!(applied.operation, "stash");
        assert_eq!(applied.conflict_paths, vec!["file.txt".to_string()]);
        assert!(applied.note.contains("正在进行的分支合并"));
        assert!(!applied.note.contains("没有可中止的合并"));
        let body = fs::read_to_string(repo.join("file.txt")).unwrap();
        assert!(body.contains("local"));
        assert!(body.contains("stashed"));
        assert_eq!(fs::read_to_string(repo.join("both.txt")).unwrap(), "main\n");
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "restored-other\n"
        );
        assert!(repo.join(".git/MERGE_HEAD").exists());
        let stashes = git_text(&repo, &["stash", "list", "--format=%H"]);
        assert!(stashes.contains(&saved_file.oid));
        assert!(stashes.contains(&saved_other.oid));
    }
}
