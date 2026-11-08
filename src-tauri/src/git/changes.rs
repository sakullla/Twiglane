use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::git::command::{
    add_command, apply_cached_command, commit_command, file_diff_command, head_command,
    identity_command, ls_files_command, restore_staged_command, status_command,
    unstage_unborn_command,
};
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, run_git, safe_relative,
    status_from_output, validate_input_path,
};
use crate::git::patch::{
    build_line_patch, build_patch, first_file_diff, parse_diff, parse_numstat, snapshot_token,
    view_lines, DIFF_PREVIEW_BYTES,
};
use crate::git::runner::ProcessOutput;
use crate::git::schedule::{internal_request_id, CommandSpec, JobKind, WriteGuard};
use crate::model::{
    CommitResult, DiffLineSelection, DiffResponse, FileChange, StatusSnapshot, MAX_DRAFT_CHARS,
};
use crate::redact::{redact_error_text, reject_secret_draft};

const MAX_PATHS: usize = 500;

/// 默认 3 行上下文的差异（既有测试的入口；命令层统一走 `load_diff_with_context`）。
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub async fn load_diff(
    backend: &crate::git::ops::Backend,
    path: &str,
    relative: &str,
    original: Option<&str>,
    staged: bool,
    generation: u64,
    request_id: u64,
    offset: u32,
    limit: u32,
) -> Result<DiffResponse, AppError> {
    load_diff_with_context(
        backend, path, relative, original, staged, generation, request_id, offset, limit, 3, false,
    )
    .await
}

/// 「查看完整文件」用到的最大上下文行数：足够覆盖整份文件，又不会让 Git 拿到离谱的数值。
pub const FULL_FILE_CONTEXT: u32 = 1_000_000;

#[allow(clippy::too_many_arguments)]
pub async fn load_diff_with_context(
    backend: &crate::git::ops::Backend,
    path: &str,
    relative: &str,
    original: Option<&str>,
    staged: bool,
    generation: u64,
    request_id: u64,
    offset: u32,
    limit: u32,
    context: u32,
    as_text: bool,
) -> Result<DiffResponse, AppError> {
    let context = context.clamp(0, FULL_FILE_CONTEXT);
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = repo_file(relative)?;
    let original_path = match original {
        Some(value) if !value.is_empty() => Some(repo_file(value)?),
        _ => None,
    };
    let git = require_git(backend).await?;
    let key = repo_key(&root);
    let untracked = if staged {
        false
    } else {
        is_untracked(
            backend,
            &git.path,
            &root,
            &relative_path,
            generation,
            request_id,
        )
        .await?
    };
    let paths = diff_paths(&relative_path, original_path.as_ref());
    let (program, args) = crate::git::command::file_diff_command_with_context(
        &git.path, &root, &paths, staged, false, untracked, context, as_text,
    );
    let scheduled = backend
        .scheduler
        .execute(crate::git::schedule::GitJob {
            repo_key: key,
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
        .await?;
    if fatal_git(&scheduled.output) {
        return Err(git_failure(
            "diff_failed",
            &scheduled.output,
            "无法读取差异，未修改仓库。",
        ));
    }
    let raw = first_file_diff(&scheduled.output.stdout);
    let truncated = scheduled.output.stdout_truncated || raw.len() != scheduled.output.stdout.len();
    let parsed = if as_text {
        crate::git::patch::parse_diff_as_text(raw, truncated)?
    } else {
        parse_diff(raw, truncated)?
    };
    // 完整补丁已经包含精确行数和二进制标记，避免再启动 Git 重算同一份差异。
    // 截断时仍需 numstat，不能把预览中的部分行数当作整个文件的统计。
    // 按文本查看时 numstat 会把文件报成二进制，只用预览里数到的行数。
    let counts = if parsed.truncated && !as_text {
        numstat_counts(
            backend,
            &git.path,
            &root,
            &paths,
            staged,
            untracked,
            generation,
            internal_request_id(),
        )
        .await?
    } else {
        None
    };
    // 二进制没有行数，改为给出改动前后的大小：已暂存看 HEAD 与索引，未暂存看索引与工作区文件。
    let sizes = if diff_is_binary(&parsed, counts) {
        use crate::git::sizes::{head_name, index_name, object_sizes, worktree_size};
        let old_path = original.filter(|value| !value.is_empty()).unwrap_or(relative);
        if staged {
            let names = [head_name(old_path), index_name(relative)];
            let found = object_sizes(backend, &git.path, &root, scheduled.generation, &names).await;
            (found.get(&names[0]).copied(), found.get(&names[1]).copied())
        } else if untracked {
            (None, worktree_size(&root, relative))
        } else {
            let names = [index_name(relative)];
            let found = object_sizes(backend, &git.path, &root, scheduled.generation, &names).await;
            (found.get(&names[0]).copied(), worktree_size(&root, relative))
        }
    } else {
        (None, None)
    };
    let mut response = response_from_diff(
        scheduled.generation,
        relative,
        staged,
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
            old: Some(crate::git::preview::PreviewSource {
                revision: if staged { "HEAD" } else { "index" }.into(),
                path: original.filter(|s| !s.is_empty()).unwrap_or(relative).into(),
            }),
            new: Some(crate::git::preview::PreviewSource {
                revision: if staged { "index" } else { "worktree" }.into(), path: relative.into(),
            }),
        });
    }
    if crate::git::document::is_markdown(relative) || original.is_some_and(crate::git::document::is_markdown) {
        let patch = String::from_utf8_lossy(raw);
        response.document = Some(crate::git::preview::PreviewSources {
            repository: root.to_string_lossy().into_owned(),
            old: (!untracked && !patch.lines().any(|line| line == "--- /dev/null" || line.starts_with("new file mode "))).then(|| crate::git::preview::PreviewSource {
                revision: if staged { "HEAD" } else { "index" }.into(),
                path: original.filter(|value| !value.is_empty()).unwrap_or(relative).into(),
            }),
            new: (!patch.lines().any(|line| line == "+++ /dev/null" || line.starts_with("deleted file mode "))).then(|| crate::git::preview::PreviewSource {
                revision: if staged { "index" } else { "worktree" }.into(), path: relative.into(),
            }),
        });
    }
    Ok(response)
}

pub async fn stage_files(
    backend: &crate::git::ops::Backend,
    path: &str,
    paths: &[String],
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let requested = validate_paths(paths)?;
    ensure_no_index_lock(&root)?;
    let git = require_git(backend).await?;
    let status = read_status(backend, &root, generation, request_id).await?;
    reject_unmerged(&status, &requested)?;
    let targets = expand_paths(&status, &requested);
    let (program, args) = add_command(&git.path, &root, &targets);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        internal_request_id(),
        program,
        args,
        Some(status.generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(classify_write(
            "stage_failed",
            &scheduled.output,
            "暂存失败，暂存区保持原样。",
        )
        .with_generation(scheduled.generation));
    }
    settle_read!(backend, &root, scheduled.generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)
}

pub async fn unstage_files(
    backend: &crate::git::ops::Backend,
    path: &str,
    paths: &[String],
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let requested = validate_paths(paths)?;
    ensure_no_index_lock(&root)?;
    let git = require_git(backend).await?;
    let status = read_status(backend, &root, generation, request_id).await?;
    reject_unmerged(&status, &requested)?;
    let targets = expand_paths(&status, &requested);
    if !targets.iter().any(|target| {
        let text = target.to_string_lossy();
        status.files.iter().any(|file| {
            file.staged != crate::model::ChangeKind::None
                && (file.path == text.as_ref()
                    || file.original_path.as_deref() == Some(text.as_ref()))
        })
    }) {
        return Err(AppError::new(
            "nothing_staged",
            "这些文件没有已暂存的变化，未改动暂存区。",
        ));
    }
    ensure_no_index_lock(&root)?;
    let (program, args) = if status.branch.unborn {
        unstage_unborn_command(&git.path, &root, &targets)
    } else {
        restore_staged_command(&git.path, &root, &targets)
    };
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        internal_request_id(),
        program,
        args,
        Some(status.generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(classify_write(
            "unstage_failed",
            &scheduled.output,
            "取消暂存失败，暂存区保持原样。",
        )
        .with_generation(scheduled.generation));
    }
    settle_read!(backend, &root, scheduled.generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)
}

/// 逐行暂存与取消暂存。行身份来自前端读取的 canonical diff，后端只把它当作定位信息：
/// 写锁内重新读取未过滤差异、校验 snapshot 与行身份，再构造逐行补丁。
#[allow(clippy::too_many_arguments)]
pub async fn stage_lines(
    backend: &crate::git::ops::Backend,
    path: &str,
    relative: &str,
    original: Option<&str>,
    staged: bool,
    lines: &[DiffLineSelection],
    snapshot: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    if lines.is_empty() {
        return Err(AppError::new(
            "empty_lines",
            "没有选中的行，未修改暂存区。",
        ));
    }
    stage_patch(
        backend,
        path,
        relative,
        original,
        staged,
        snapshot,
        generation,
        request_id,
        |parsed| build_line_patch(parsed, lines, staged),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn stage_hunks(
    backend: &crate::git::ops::Backend,
    path: &str,
    relative: &str,
    original: Option<&str>,
    staged: bool,
    hunks: &[u32],
    snapshot: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    stage_patch(
        backend,
        path,
        relative,
        original,
        staged,
        snapshot,
        generation,
        request_id,
        |parsed| {
            if parsed.binary || parsed.undecodable {
                return Err(AppError::new(
                    "not_text",
                    "二进制或无法解码的文件不能按代码块暂存。可以暂存整个文件。",
                ));
            }
            build_patch(parsed, hunks)
        },
    )
    .await
}

/// 按块与按行共用的写入顺序：写锁 → index.lock → 重新读取未过滤差异 → snapshot 校验 →
/// 构造补丁 → apply --cached --check → 实际 apply → 刷新 generation。
/// 补丁构造（含行身份校验）由调用方传入，失败时什么都不写。
#[allow(clippy::too_many_arguments)]
async fn stage_patch<F>(
    backend: &crate::git::ops::Backend,
    path: &str,
    relative: &str,
    original: Option<&str>,
    staged: bool,
    snapshot: &str,
    generation: u64,
    request_id: u64,
    build: F,
) -> Result<StatusSnapshot, AppError>
where
    F: FnOnce(&crate::git::patch::ParsedDiff) -> Result<Vec<u8>, AppError>,
{
    if snapshot.is_empty() {
        return Err(AppError::new(
            "invalid_snapshot",
            "缺少差异快照，未修改暂存区。",
        ));
    }
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = repo_file(relative)?;
    let original_path = match original {
        Some(value) if !value.is_empty() => Some(repo_file(value)?),
        _ => None,
    };
    let git = require_git(backend).await?;
    let mut guard = backend
        .scheduler
        .lock_write(&repo_key(&root), request_id, generation)
        .await?;
    if let Err(error) = ensure_no_index_lock(&root) {
        return Err(finish_error(guard, error));
    }
    let untracked = if staged {
        false
    } else {
        match untracked_in_guard(&mut guard, &git.path, &root, &relative_path).await {
            Ok(value) => value,
            Err(error) => return Err(finish_error(guard, error)),
        }
    };
    let paths = diff_paths(&relative_path, original_path.as_ref());
    let (program, args) = file_diff_command(&git.path, &root, &paths, staged, false, untracked);
    let diff = match guard
        .run(CommandSpec {
            program,
            args,
            stdin: None,
            truncate_stdout: true,
            output_limit: Some(capture_limit(backend)),
            writes: false,
        })
        .await
    {
        Ok(diff) => diff,
        Err(error) => return Err(finish_error(guard, error)),
    };
    if fatal_git(&diff) {
        return Err(finish_error(
            guard,
            git_failure("diff_failed", &diff, "无法核对差异，未修改暂存区。"),
        ));
    }
    let raw = first_file_diff(&diff.stdout);
    let truncated = diff.stdout_truncated || raw.len() != diff.stdout.len();
    let parsed = match parse_diff(raw, truncated) {
        Ok(parsed) => parsed,
        Err(error) => return Err(finish_error(guard, error)),
    };
    let token = snapshot_token(raw, truncated, relative, staged);
    if token != snapshot {
        return Err(finish_error(
            guard,
            AppError::new(
                "stale_patch",
                "差异已变化，未应用过期的代码块。请查看刷新后的内容。",
            ),
        ));
    }
    if parsed.binary || parsed.undecodable {
        return Err(finish_error(
            guard,
            AppError::new(
                "not_text",
                "二进制或无法解码的文件不能按代码块暂存。可以暂存整个文件。",
            ),
        ));
    }
    let patch = match build(&parsed) {
        Ok(patch) => patch,
        Err(error) => return Err(finish_error(guard, error)),
    };
    let (check_program, check_args) = apply_cached_command(&git.path, &root, staged, true);
    let check = match guard
        .run(CommandSpec {
            program: check_program,
            args: check_args,
            stdin: Some(patch.clone()),
            truncate_stdout: false,
            output_limit: None,
            writes: false,
        })
        .await
    {
        Ok(check) => check,
        Err(error) => return Err(finish_error(guard, error)),
    };
    if check.exit_code != 0 {
        return Err(finish_error(
            guard,
            classify_write(
                "apply_failed",
                &check,
                "代码块与当前索引不一致，未修改暂存区。",
            ),
        ));
    }
    let (apply_program, apply_args) = apply_cached_command(&git.path, &root, staged, false);
    let applied = match guard
        .run(CommandSpec {
            program: apply_program,
            args: apply_args,
            stdin: Some(patch),
            truncate_stdout: false,
            output_limit: None,
            writes: true,
        })
        .await
    {
        Ok(applied) => applied,
        Err(error) => return Err(finish_error(guard, error)),
    };
    if applied.exit_code != 0 {
        return Err(finish_error(
            guard,
            classify_write("apply_failed", &applied, "代码块没有写入暂存区。"),
        ));
    }
    let generation = guard.finish();
    settle_read!(backend, &root, generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)
}

pub async fn commit_index(
    backend: &crate::git::ops::Backend,
    path: &str,
    message: &str,
    generation: u64,
    request_id: u64,
) -> Result<CommitResult, AppError> {
    if message.trim().is_empty() {
        return Err(AppError::new(
            "empty_message",
            "请先填写提交说明。说明草稿和暂存区都未改动。",
        ));
    }
    if message.chars().count() > MAX_DRAFT_CHARS {
        return Err(AppError::new(
            "message_too_large",
            "提交说明过长，未创建提交。说明草稿和暂存区都未改动。",
        ));
    }
    reject_secret_draft(message)?;
    let root = canonical_existing(&validate_input_path(path)?)?;
    ensure_no_index_lock(&root)?;
    let git = require_git(backend).await?;
    let status = read_status(backend, &root, generation, request_id).await?;
    if status.files.iter().any(|file| file.unmerged) {
        return Err(AppError::new(
            "unmerged",
            "还有未解决的冲突，不能创建提交。说明和暂存区都未改动。",
        ));
    }
    let files: Vec<String> = status
        .files
        .iter()
        .filter(|file| file.staged != crate::model::ChangeKind::None)
        .map(|file| file.path.clone())
        .collect();
    if files.is_empty() {
        return Err(AppError::new(
            "empty_index",
            "暂存区是空的，没有可以提交的内容。说明草稿未改动。",
        ));
    }
    ensure_identity(backend, &git.path, &root, status.generation).await?;
    ensure_no_index_lock(&root)?;
    let (program, args) = commit_command(&git.path, &root, message);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        internal_request_id(),
        program,
        args,
        Some(status.generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(classify_commit(&root, &scheduled.output).with_generation(scheduled.generation));
    }
    let _ = backend.store.save_draft(&repo_key(&root), "");
    let head = settle_read!(backend, &root, scheduled.generation, |current| {
        let (head_program, head_args) = head_command(&git.path, &root);
        run_git(
            backend,
            &repo_key(&root),
            JobKind::Read,
            internal_request_id(),
            head_program,
            head_args,
            Some(current),
        )
        .await
    })?;
    if head.output.exit_code != 0 {
        return Err(git_failure(
            "commit_unverified",
            &head.output,
            "提交命令已返回，但无法确认新的提交。请刷新后查看历史，不要重复提交。",
        )
        .with_generation(head.generation));
    }
    let oid = String::from_utf8_lossy(&head.output.stdout)
        .trim()
        .to_string();
    let snapshot = settle_read!(backend, &root, head.generation, |current| read_status(
        backend,
        &root,
        current,
        internal_request_id()
    )
    .await)?;
    let branch = snapshot
        .branch
        .name
        .clone()
        .unwrap_or_else(|| "当前 HEAD".to_string());
    let summary = format!(
        "已在 {branch} 创建本地提交，包含 {} 个文件，没有推送。",
        files.len()
    );
    Ok(CommitResult {
        oid,
        generation: snapshot.generation,
        branch,
        summary,
        files,
        pushed: false,
        snapshot,
    })
}

/// 差异是否按二进制处理：解析出二进制、无法解码，或 numstat 两侧都是 `-`。
pub(crate) fn diff_is_binary(parsed: &crate::git::patch::ParsedDiff, counts: Option<(Option<u64>, Option<u64>)>) -> bool {
    parsed.binary || parsed.undecodable || counts == Some((None, None))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn response_from_diff(
    generation: u64,
    relative: &str,
    staged: bool,
    parsed: &crate::git::patch::ParsedDiff,
    raw: &[u8],
    counts: Option<(Option<u64>, Option<u64>)>,
    sizes: (Option<u64>, Option<u64>),
    offset: u32,
    limit: u32,
) -> Result<DiffResponse, AppError> {
    let binary = diff_is_binary(parsed, counts);
    let additions = counts
        .and_then(|(added, _)| added)
        .unwrap_or(parsed.additions);
    let deletions = counts
        .and_then(|(_, deleted)| deleted)
        .unwrap_or(parsed.deletions);
    let snapshot = snapshot_token(raw, parsed.truncated, relative, staged);
    if binary {
        let summary = if parsed.undecodable {
            "差异无法按文本解码，没有文本预览。".to_string()
        } else {
            crate::git::sizes::binary_summary(sizes.0, sizes.1)
        };
        return Ok(DiffResponse {
            preview: None,
            document: None,
            generation,
            path: relative.to_string(),
            staged,
            binary: true,
            text: None,
            summary,
            additions: 0,
            deletions: 0,
            complete: true,
            truncated: false,
            snapshot,
            hunks: Vec::new(),
            lines: Vec::new(),
            offset: 0,
            total_lines: 0,
            old_size: sizes.0,
            new_size: sizes.1,
        });
    }
    let (lines, hunks, total_lines) = view_lines(parsed, offset, limit);
    let summary = if parsed.hunks.is_empty() && parsed.preamble.contains("rename ") {
        "这是重命名，没有行级文本差异。".to_string()
    } else if parsed.hunks.is_empty() && parsed.preamble.trim().is_empty() {
        "没有文本差异。".to_string()
    } else if parsed.truncated {
        format!(
            "差异超过预览上限，新增约 {additions} 行，删除约 {deletions} 行。截断的代码块不能部分暂存。"
        )
    } else {
        format!("新增 {additions} 行，删除 {deletions} 行。")
    };
    let text = if !parsed.truncated && offset == 0 && raw.len() <= 64 * 1024 {
        Some(String::from_utf8_lossy(raw).into_owned())
    } else {
        None
    };
    Ok(DiffResponse {
        preview: None,
        document: None,
        generation,
        path: relative.to_string(),
        staged,
        binary: false,
        text,
        summary,
        additions,
        deletions,
        complete: !parsed.truncated,
        truncated: parsed.truncated,
        snapshot,
        hunks,
        lines,
        offset: offset.min(total_lines),
        total_lines,
        old_size: None,
        new_size: None,
    })
}

#[allow(clippy::too_many_arguments)]
async fn numstat_counts(
    backend: &crate::git::ops::Backend,
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
    staged: bool,
    untracked: bool,
    generation: u64,
    request_id: u64,
) -> Result<Option<(Option<u64>, Option<u64>)>, AppError> {
    let (program, args) = file_diff_command(git, root, paths, staged, true, untracked);
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
    if fatal_git(&scheduled.output) {
        return Ok(None);
    }
    Ok(parse_numstat(&scheduled.output.stdout))
}

async fn is_untracked(
    backend: &crate::git::ops::Backend,
    git: &Path,
    root: &Path,
    relative: &Path,
    generation: u64,
    request_id: u64,
) -> Result<bool, AppError> {
    let (program, args) = ls_files_command(git, root, relative);
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
    if scheduled.output.exit_code != 0 {
        return Err(git_failure(
            "diff_failed",
            &scheduled.output,
            "无法确认文件是否已跟踪，未修改仓库。",
        ));
    }
    Ok(scheduled.output.stdout.is_empty() && root.join(relative).is_file())
}

async fn untracked_in_guard<R: crate::git::runner::ProcessRunner>(
    guard: &mut WriteGuard<'_, R>,
    git: &Path,
    root: &Path,
    relative: &Path,
) -> Result<bool, AppError> {
    let (program, args) = ls_files_command(git, root, relative);
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
            "diff_failed",
            &output,
            "无法确认文件是否已跟踪，未修改暂存区。",
        ));
    }
    Ok(output.stdout.is_empty() && root.join(relative).is_file())
}

async fn ensure_identity(
    backend: &crate::git::ops::Backend,
    git: &Path,
    root: &Path,
    generation: u64,
) -> Result<(), AppError> {
    for variable in ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"] {
        let (program, args) = identity_command(git, root, variable);
        let scheduled = run_git(
            backend,
            &repo_key(root),
            JobKind::Read,
            internal_request_id(),
            program,
            args,
            Some(generation),
        )
        .await?;
        let detail = command_text(&scheduled.output);
        if scheduled.output.exit_code != 0 || is_identity_error(&detail) {
            return Err(identity_error(&detail));
        }
    }
    Ok(())
}

async fn read_status(
    backend: &crate::git::ops::Backend,
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
    .await?;
    status_from_output(backend, root, &scheduled).await
}

fn validate_paths(paths: &[String]) -> Result<Vec<String>, AppError> {
    if paths.is_empty() {
        return Err(AppError::new(
            "empty_paths",
            "没有选中的文件，未修改暂存区。",
        ));
    }
    if paths.len() > MAX_PATHS {
        return Err(AppError::new(
            "too_many_paths",
            "一次选择的文件过多，未修改暂存区。",
        ));
    }
    let mut clean = Vec::with_capacity(paths.len());
    for path in paths {
        let relative = repo_file(path)?;
        clean.push(relative.to_string_lossy().into_owned());
    }
    Ok(clean)
}

fn repo_file(path: &str) -> Result<PathBuf, AppError> {
    let relative = safe_relative(path)?;
    if relative
        .components()
        .any(|component| component.as_os_str() == ".git")
    {
        return Err(AppError::new(
            "invalid_path",
            "不能把 .git 当作普通文件暂存。",
        ));
    }
    Ok(relative)
}

fn diff_paths(relative: &Path, original: Option<&PathBuf>) -> Vec<PathBuf> {
    let mut paths = vec![relative.to_path_buf()];
    if let Some(original) = original {
        if original != relative {
            paths.push(original.clone());
        }
    }
    paths
}

fn expand_paths(status: &StatusSnapshot, requested: &[String]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for path in requested {
        let mut matched = false;
        for file in &status.files {
            if file.path == *path || file.original_path.as_deref() == Some(path.as_str()) {
                push_unique(&mut paths, PathBuf::from(&file.path));
                if let Some(original) = &file.original_path {
                    push_unique(&mut paths, PathBuf::from(original));
                }
                matched = true;
            }
        }
        if !matched {
            push_unique(&mut paths, PathBuf::from(path));
        }
    }
    paths
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn reject_unmerged(status: &StatusSnapshot, requested: &[String]) -> Result<(), AppError> {
    let blocked = status
        .files
        .iter()
        .any(|file| file.unmerged && path_selected(file, requested));
    if blocked {
        Err(AppError::new(
            "unmerged",
            "冲突文件需要在合并流程里处理，这次没有改动暂存区。",
        ))
    } else {
        Ok(())
    }
}

fn path_selected(file: &FileChange, requested: &[String]) -> bool {
    requested
        .iter()
        .any(|path| path == &file.path || file.original_path.as_deref() == Some(path))
}

fn ensure_no_index_lock(root: &Path) -> Result<(), AppError> {
    let git_dir = root.join(".git");
    if git_dir.is_dir() && git_dir.join("index.lock").exists() {
        return Err(AppError::new(
            "index_lock",
            "索引锁仍在，可能有另一个 Git 进程正在写入。未删除该锁，也没有改动暂存区。",
        ));
    }
    Ok(())
}

fn capture_limit(backend: &crate::git::ops::Backend) -> usize {
    backend.runner.output_limit.min(DIFF_PREVIEW_BYTES)
}

fn finish_error<R: crate::git::runner::ProcessRunner>(
    guard: WriteGuard<'_, R>,
    error: AppError,
) -> AppError {
    let generation = guard.finish();
    if error.generation.is_none() {
        error.with_generation(generation)
    } else {
        error
    }
}

fn fatal_git(output: &ProcessOutput) -> bool {
    if output.stdout_truncated {
        return false;
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    output.exit_code > 1 && stderr.contains("fatal")
}

fn command_text(output: &ProcessOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

fn classify_write(code: &str, output: &ProcessOutput, fallback: &str) -> AppError {
    let detail = command_text(output);
    if is_index_lock(&detail) {
        return AppError::new(
            "index_lock",
            "索引锁仍在，可能有另一个 Git 进程正在写入。未删除该锁，也没有改动暂存区。",
        );
    }
    git_failure(code, output, fallback)
}

fn classify_commit(root: &Path, output: &ProcessOutput) -> AppError {
    let detail = redact_error_text(command_text(output).trim());
    if is_identity_error(&detail) {
        return identity_error(&detail);
    }
    if is_index_lock(&detail) {
        return AppError::new(
            "index_lock",
            "索引锁仍在，提交没有创建。未删除该锁。说明和暂存区都还保留。",
        );
    }
    let hook = detail.to_ascii_lowercase().contains("hook")
        || hook_executable(root, "pre-commit")
        || hook_executable(root, "commit-msg");
    if hook {
        let reason = if detail.is_empty() {
            "提交钩子拒绝了这次提交。".to_string()
        } else {
            format!("提交钩子拒绝了这次提交。{detail}")
        };
        return AppError::new(
            "hook_rejected",
            format!("{reason} 说明和已暂存内容都还保留。"),
        );
    }
    let reason = if detail.is_empty() {
        "提交没有完成。".to_string()
    } else {
        format!("提交没有完成。{detail}")
    };
    AppError::new(
        "commit_failed",
        format!("{reason} 说明和已暂存内容都还保留。"),
    )
}

fn identity_error(detail: &str) -> AppError {
    let detail = redact_error_text(detail.trim());
    let base = "缺少提交身份。请配置 user.name 与 user.email 后再试。说明和已暂存内容都还保留。";
    if detail.is_empty() {
        AppError::new("identity_missing", base)
    } else {
        AppError::new("identity_missing", format!("{base} {detail}"))
    }
}

fn is_identity_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("author identity unknown")
        || lower.contains("committer identity unknown")
        || lower.contains("empty ident")
        || lower.contains("no email was given")
        || lower.contains("unable to auto-detect email")
        || text.contains("作者身份未知")
        || text.contains("提交者身份未知")
        || text.contains("未提供邮件地址")
}

fn is_index_lock(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("index.lock") || lower.contains("another git process")
}

fn hook_executable(root: &Path, name: &str) -> bool {
    let path = root.join(".git").join("hooks").join(name);
    let Ok(meta) = fs::metadata(&path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
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

    fn git_bytes(dir: &Path, args: &[&str]) -> Vec<u8> {
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
        output.stdout
    }

    async fn open_repo(backend: &crate::git::ops::Backend, repo: &Path) -> (String, u64) {
        let opened = crate::git::ops::add_repository(
            backend,
            &repo_key(&canonical_existing(repo).unwrap()),
            1,
        )
        .await
        .unwrap();
        (opened.summary.path, opened.generation)
    }

    #[tokio::test]
    async fn partial_hunk_commit_keeps_the_other_hunk_in_the_worktree() {
        let fixture = crate::test_support::git_fixture("hunk-commit");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let mut lines: Vec<String> = (1..=20).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("demo.txt"), lines.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        lines[3] = "CHANGED A".to_string();
        lines[14] = "CHANGED B".to_string();
        fs::write(repo.join("demo.txt"), lines.join("\n") + "\n").unwrap();
        let bare = fixture.path().join("bare.git");
        git(fixture.path(), &["init", "--bare", "bare.git"]);
        git(
            &repo,
            &["remote", "add", "origin", repo_key(&bare).as_str()],
        );
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        assert!(!diff.binary);
        assert!(diff.text.as_ref().unwrap().contains("+CHANGED A"));
        assert_eq!(diff.hunks.iter().filter(|hunk| hunk.stageable).count(), 2);
        let staged = stage_hunks(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[diff.hunks[0].index],
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap();
        let committed = commit_index(&backend, &path, "only A", staged.generation, 4)
            .await
            .unwrap();
        assert!(!committed.pushed);
        assert_eq!(committed.files, vec!["demo.txt".to_string()]);
        let head = git_bytes(&repo, &["show", "HEAD:demo.txt"]);
        let work = fs::read(repo.join("demo.txt")).unwrap();
        let head_text = String::from_utf8(head).unwrap();
        let work_text = String::from_utf8(work).unwrap();
        assert!(head_text.contains("CHANGED A"));
        assert!(head_text.contains("line 15\n"));
        assert!(!head_text.contains("CHANGED B"));
        assert!(work_text.contains("CHANGED A"));
        assert!(work_text.contains("CHANGED B"));
        assert!(!bare.join("refs").join("heads").join("main").exists());
    }

    #[tokio::test]
    async fn stale_patch_is_rejected_and_refreshed_without_writing() {
        let fixture = crate::test_support::git_fixture("stale-hunk");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("demo.txt"), "one\ntwo\nthree\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        fs::write(repo.join("demo.txt"), "ONE\ntwo\nthree\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        fs::write(repo.join("demo.txt"), "ONE\nTWO\nthree\n").unwrap();
        let error = stage_hunks(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[0],
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "stale_patch");
        assert!(error.generation.is_some());
        let cached = git_bytes(&repo, &["diff", "--cached", "--", "demo.txt"]);
        assert!(cached.is_empty());
        assert_eq!(
            fs::read(repo.join("demo.txt")).unwrap(),
            b"ONE\nTWO\nthree\n"
        );
    }

    #[tokio::test]
    async fn commit_failures_keep_the_draft_and_index() {
        let fixture = crate::test_support::git_fixture("commit-fail");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        fs::write(repo.join("file.txt"), "keep\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        fs::write(repo.join("file.txt"), "changed\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        backend.store.save_draft(&path, "保留的说明").unwrap();
        let empty = commit_index(&backend, &path, "   ", generation, 2)
            .await
            .unwrap_err();
        assert_eq!(empty.code, "empty_message");
        let unstaged = commit_index(&backend, &path, "保留的说明", generation, 3)
            .await
            .unwrap_err();
        assert_eq!(unstaged.code, "empty_index");
        assert_eq!(backend.store.draft(&path), "保留的说明");

        let staged = stage_files(&backend, &path, &["file.txt".to_string()], generation, 4)
            .await
            .unwrap();
        assert!(staged
            .files
            .iter()
            .any(|file| file.path == "file.txt" && file.staged != crate::model::ChangeKind::None));
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\necho hook refused the commit >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).unwrap();
        }
        let rejected = commit_index(&backend, &path, "保留的说明", staged.generation, 6)
            .await
            .unwrap_err();
        assert_eq!(rejected.code, "hook_rejected");
        assert!(rejected.message.contains("hook refused"));
        assert!(rejected.message.contains("保留"));
        assert_eq!(backend.store.draft(&path), "保留的说明");
        let still = git_bytes(&repo, &["diff", "--cached", "--", "file.txt"]);
        assert!(String::from_utf8_lossy(&still).contains("+changed"));

        git(&repo, &["config", "--unset", "user.name"]);
        git(&repo, &["config", "--unset", "user.email"]);
        let anonymous = fixture.backend_with_extra_env(vec![
            (OsString::from("GIT_AUTHOR_NAME"), OsString::from("")),
            (OsString::from("GIT_AUTHOR_EMAIL"), OsString::from("")),
            (OsString::from("GIT_COMMITTER_NAME"), OsString::from("")),
            (OsString::from("GIT_COMMITTER_EMAIL"), OsString::from("")),
        ]);
        let (_anon_path, anon_generation) = open_repo(&anonymous, &repo).await;
        anonymous.store.save_draft(&path, "保留的说明").unwrap();
        let missing = commit_index(&anonymous, &path, "保留的说明", anon_generation, 8)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "identity_missing");
        assert!(missing.message.contains("user.name"));
        assert_eq!(anonymous.store.draft(&path), "保留的说明");
        assert!(String::from_utf8_lossy(&git_bytes(
            &repo,
            &["diff", "--cached", "--", "file.txt"]
        ))
        .contains("+changed"));
    }

    #[tokio::test]
    async fn initial_commit_crlf_newline_and_special_paths() {
        let fixture = crate::test_support::git_fixture("special-commit");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        git(&repo, &["config", "core.autocrlf", "false"]);
        fs::create_dir(repo.join("dir")).unwrap();
        fs::write(repo.join("dir").join("文件 名.txt"), "你好\n").unwrap();
        fs::write(repo.join("weird[name].txt"), "brackets\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let staged = stage_files(
            &backend,
            &path,
            &["dir/文件 名.txt".to_string(), "weird[name].txt".to_string()],
            generation,
            2,
        )
        .await
        .unwrap();
        assert!(staged.branch.unborn);
        let removed = unstage_files(
            &backend,
            &path,
            &["weird[name].txt".to_string()],
            staged.generation,
            3,
        )
        .await
        .unwrap();
        assert!(removed
            .files
            .iter()
            .any(|file| file.path == "weird[name].txt" && file.untracked));
        assert!(removed
            .files
            .iter()
            .any(|file| file.path == "dir/文件 名.txt"
                && file.staged == crate::model::ChangeKind::Added));
        let committed = commit_index(
            &backend,
            &path,
            "初始提交 $(touch should-not-run)",
            removed.generation,
            4,
        )
        .await
        .unwrap();
        assert!(!committed.pushed);
        assert!(!repo.join("should-not-run").exists());
        assert!(!git_bytes(&repo, &["rev-list", "--max-parents=0", "HEAD"]).is_empty());
        let parents = Command::new(crate::test_support::system_git())
            .current_dir(&repo)
            .args(["rev-parse", "--verify", "HEAD^"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(!parents.status.success());

        fs::write(
            repo.join("crlf.txt"),
            b"a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\n",
        )
        .unwrap();
        let added = stage_files(
            &backend,
            &path,
            &["crlf.txt".to_string()],
            committed.generation,
            6,
        )
        .await
        .unwrap();
        let base = commit_index(&backend, &path, "crlf base", added.generation, 7)
            .await
            .unwrap();
        fs::write(
            repo.join("crlf.txt"),
            b"A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nJ\r\n",
        )
        .unwrap();
        let diff = load_diff(
            &backend,
            &path,
            "crlf.txt",
            None,
            false,
            base.generation,
            8,
            0,
            0,
        )
        .await
        .unwrap();
        assert!(diff.hunks.len() >= 2);
        let staged_hunk = stage_hunks(
            &backend,
            &path,
            "crlf.txt",
            None,
            false,
            &[diff.hunks[0].index],
            &diff.snapshot,
            diff.generation,
            9,
        )
        .await
        .unwrap();
        let committed_crlf = commit_index(&backend, &path, "crlf hunk", staged_hunk.generation, 10)
            .await
            .unwrap();
        let blob = git_bytes(&repo, &["show", "HEAD:crlf.txt"]);
        let work = fs::read(repo.join("crlf.txt")).unwrap();
        assert!(blob.windows(3).any(|window| window == b"A\r\n"));
        assert!(!blob.windows(3).any(|window| window == b"J\r\n"));
        assert!(work.windows(3).any(|window| window == b"J\r\n"));
        assert!(!committed_crlf.pushed);

        let nl_base: String = (1..=16)
            .map(|index| format!("n{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(repo.join("n.txt"), nl_base.as_bytes()).unwrap();
        let added_n = stage_files(
            &backend,
            &path,
            &["n.txt".to_string()],
            committed_crlf.generation,
            12,
        )
        .await
        .unwrap();
        let base_n = commit_index(&backend, &path, "nl base", added_n.generation, 13)
            .await
            .unwrap();
        let mut nl_lines: Vec<String> = (1..=16).map(|index| format!("n{index}")).collect();
        nl_lines[0] = "N1".to_string();
        nl_lines[15] = "N16".to_string();
        fs::write(repo.join("n.txt"), nl_lines.join("\n").as_bytes()).unwrap();
        let nl = load_diff(
            &backend,
            &path,
            "n.txt",
            None,
            false,
            base_n.generation,
            14,
            0,
            0,
        )
        .await
        .unwrap();
        assert!(nl
            .text
            .as_ref()
            .unwrap()
            .contains("\\ No newline at end of file"));
        assert!(
            nl.hunks.len() >= 2,
            "hunks {:?}",
            nl.hunks.iter().map(|hunk| &hunk.header).collect::<Vec<_>>()
        );
        let staged_nl = stage_hunks(
            &backend,
            &path,
            "n.txt",
            None,
            false,
            &[nl.hunks[0].index],
            &nl.snapshot,
            nl.generation,
            15,
        )
        .await
        .unwrap();
        let _ = commit_index(&backend, &path, "nl hunk", staged_nl.generation, 16)
            .await
            .unwrap();
        let nl_blob = git_bytes(&repo, &["show", "HEAD:n.txt"]);
        assert!(nl_blob.starts_with(b"N1\n"));
        assert!(nl_blob.ends_with(b"n16"));
        assert!(!nl_blob.ends_with(b"\n"));
        assert!(fs::read(repo.join("n.txt")).unwrap().ends_with(b"N16"));
    }

    #[tokio::test]
    async fn untracked_source_with_nul_can_be_read_as_text() {
        let fixture = crate::test_support::git_fixture("diff-as-text");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("keep.txt"), "keep\n").unwrap();
        git(&repo, &["add", "--", "keep.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        // 源码里混进一个 NUL 字节：Git 按二进制处理，按文本查看仍能逐行读出。
        fs::write(repo.join("files.rs"), b"fn main() {}\nlet raw = b\"abc\x00def\";\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let binary = load_diff(&backend, &path, "files.rs", None, false, generation, 2, 0, 0)
            .await
            .unwrap();
        assert!(binary.binary);
        let text = load_diff_with_context(
            &backend, &path, "files.rs", None, false, binary.generation, 3, 0, 0, 3, true,
        )
        .await
        .unwrap();
        assert!(!text.binary);
        assert_eq!(text.additions, 2);
        assert!(text.lines.iter().any(|line| line.text.contains("abc\u{2400}def")));
        assert!(text.hunks.iter().all(|hunk| !hunk.stageable), "替换过的文本不能拼补丁");
    }

    #[tokio::test]
    async fn binary_changes_report_sizes_instead_of_line_counts() {
        let fixture = crate::test_support::git_fixture("binary-sizes");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("logo.bin"), [0_u8; 100]).unwrap();
        git(&repo, &["add", "--", "logo.bin"]);
        git(&repo, &["commit", "-m", "init"]);
        // 已暂存：100 → 150；随后工作区又改成 400 字节。另有一个新增并暂存的二进制。
        fs::write(repo.join("logo.bin"), [0_u8; 150]).unwrap();
        git(&repo, &["add", "--", "logo.bin"]);
        fs::write(repo.join("logo.bin"), [0_u8; 400]).unwrap();
        fs::write(repo.join("new.bin"), [1_u8, 0, 2]).unwrap();
        git(&repo, &["add", "--", "new.bin"]);
        let (path, generation) = open_repo(&backend, &repo).await;
        let status = read_status(&backend, &repo, generation, 2).await.unwrap();
        let logo = status.files.iter().find(|file| file.path == "logo.bin").unwrap();
        let staged = logo.staged_lines.unwrap();
        assert_eq!((staged.additions, staged.deletions), (None, None));
        assert_eq!((staged.old_size, staged.new_size), (Some(100), Some(150)));
        let unstaged = logo.unstaged_lines.unwrap();
        assert_eq!((unstaged.old_size, unstaged.new_size), (Some(150), Some(400)));
        let added = status.files.iter().find(|file| file.path == "new.bin").unwrap();
        let added = added.staged_lines.unwrap();
        assert_eq!((added.old_size, added.new_size), (None, Some(3)));

        let staged_diff = load_diff(&backend, &path, "logo.bin", None, true, status.generation, 3, 0, 0)
            .await
            .unwrap();
        assert!(staged_diff.binary);
        assert_eq!((staged_diff.old_size, staged_diff.new_size), (Some(100), Some(150)));
        assert_eq!(staged_diff.summary, "二进制文件有变化：100 B → 150 B。");
        let worktree_diff = load_diff(&backend, &path, "logo.bin", None, false, status.generation, 4, 0, 0)
            .await
            .unwrap();
        assert_eq!((worktree_diff.old_size, worktree_diff.new_size), (Some(150), Some(400)));
    }

    #[tokio::test]
    async fn external_index_rename_binary_and_edit_after_stage_are_distinct() {
        let fixture = crate::test_support::git_fixture("status-shapes");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("old.txt"), "same\n").unwrap();
        fs::write(repo.join("note.txt"), "base\n").unwrap();
        git(&repo, &["add", "--", "old.txt", "note.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        git(&repo, &["mv", "old.txt", "new.txt"]);
        fs::write(repo.join("data.bin"), b"a\0b").unwrap();
        git(&repo, &["add", "--", "data.bin"]);
        fs::write(repo.join("note.txt"), "staged\n").unwrap();
        git(&repo, &["add", "--", "note.txt"]);
        fs::write(repo.join("note.txt"), "staged\nunstaged\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let status = read_status(&backend, &repo, generation, 2).await.unwrap();
        let renamed = status
            .files
            .iter()
            .find(|file| file.path == "new.txt")
            .unwrap();
        assert_eq!(renamed.staged, crate::model::ChangeKind::Renamed);
        assert_eq!(renamed.original_path.as_deref(), Some("old.txt"));
        let binary = status
            .files
            .iter()
            .find(|file| file.path == "data.bin")
            .unwrap();
        assert_eq!(binary.staged, crate::model::ChangeKind::Added);
        let note = status
            .files
            .iter()
            .find(|file| file.path == "note.txt")
            .unwrap();
        assert_ne!(note.staged, crate::model::ChangeKind::None);
        assert_ne!(note.unstaged, crate::model::ChangeKind::None);
        let staged_diff = load_diff(
            &backend,
            &path,
            "note.txt",
            None,
            true,
            status.generation,
            3,
            0,
            0,
        )
        .await
        .unwrap();
        let unstaged_diff = load_diff(
            &backend,
            &path,
            "note.txt",
            None,
            false,
            status.generation,
            4,
            0,
            0,
        )
        .await
        .unwrap();
        assert!(staged_diff.text.as_ref().unwrap().contains("+staged"));
        assert!(unstaged_diff.text.as_ref().unwrap().contains("+unstaged"));
        let binary_diff = load_diff(
            &backend,
            &path,
            "data.bin",
            None,
            true,
            status.generation,
            5,
            0,
            0,
        )
        .await
        .unwrap();
        assert!(binary_diff.binary);
        assert!(binary_diff.text.is_none());
        assert!(binary_diff.hunks.is_empty());
        assert!(binary_diff.summary.contains("二进制"));
        let unstaged_rename = unstage_files(
            &backend,
            &path,
            &["new.txt".to_string()],
            status.generation,
            6,
        )
        .await
        .unwrap();
        assert!(unstaged_rename
            .files
            .iter()
            .any(|file| file.path == "old.txt"));
    }

    #[tokio::test]
    async fn truncated_hunk_and_index_lock_do_not_write() {
        let fixture = crate::test_support::git_fixture("truncated-lock");
        let backend = fixture.backend_with_limit(700, Vec::new());
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let original = format!("{}\nsecond\n", "a".repeat(40));
        fs::write(repo.join("wide.txt"), &original).unwrap();
        git(&repo, &["add", "--", "wide.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let changed = format!("{}\n{}", "B".repeat(40), "C".repeat(4000));
        fs::write(repo.join("wide.txt"), &changed).unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "wide.txt", None, false, generation, 2, 0, 400,
        )
        .await
        .unwrap();
        assert!(diff.truncated || !diff.complete);
        assert_eq!((diff.additions, diff.deletions), (2, 2), "truncated previews still use full numstat counts");
        assert!(diff.text.is_none() || diff.truncated);
        let incomplete = diff.hunks.iter().find(|hunk| !hunk.stageable);
        if let Some(hunk) = incomplete {
            let error = stage_hunks(
                &backend,
                &path,
                "wide.txt",
                None,
                false,
                &[hunk.index],
                &diff.snapshot,
                diff.generation,
                3,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "truncated_hunk");
            assert!(git_bytes(&repo, &["diff", "--cached", "--", "wide.txt"]).is_empty());
        } else {
            panic!("expected a truncated hunk, hunks={:?}", diff.hunks);
        }
        fs::write(repo.join(".git").join("index.lock"), b"locked").unwrap();
        let locked = stage_files(
            &backend,
            &path,
            &["wide.txt".to_string()],
            diff.generation,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(locked.code, "index_lock");
        assert_eq!(
            fs::read(repo.join(".git").join("index.lock")).unwrap(),
            b"locked"
        );
        fs::remove_file(repo.join(".git").join("index.lock")).unwrap();
        assert!(git_bytes(&repo, &["diff", "--cached"]).is_empty());
    }

    #[tokio::test]
    async fn dash_and_plus_hunk_can_be_staged_without_the_other_hunk() {
        let fixture = crate::test_support::git_fixture("dash-hunk");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let mut lines: Vec<String> = (1..=20).map(|index| format!("line {index}")).collect();
        lines[1] = "-- dash".to_string();
        lines[14] = "keep".to_string();
        fs::write(repo.join("demo.txt"), lines.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        lines[1] = "++ plus".to_string();
        lines[14] = "CHANGED B".to_string();
        fs::write(repo.join("demo.txt"), lines.join("\n") + "\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        assert!(diff
            .lines
            .iter()
            .any(|line| line.kind == "del" && line.text == "--- dash"));
        assert!(diff
            .lines
            .iter()
            .any(|line| line.kind == "add" && line.text == "+++ plus"));
        assert!(diff.hunks.len() >= 2, "hunks {:?}", diff.hunks);
        assert!(diff
            .hunks
            .iter()
            .all(|hunk| hunk.complete && hunk.stageable));
        let staged = stage_hunks(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[diff.hunks[0].index],
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "hunk with ---/+++ was not stageable: {} {}",
                error.code, error.message
            )
        });
        let committed = commit_index(&backend, &path, "only markers", staged.generation, 4)
            .await
            .unwrap();
        assert!(!committed.pushed);
        let head = String::from_utf8(git_bytes(&repo, &["show", "HEAD:demo.txt"])).unwrap();
        let work = String::from_utf8(fs::read(repo.join("demo.txt")).unwrap()).unwrap();
        assert!(head.contains("++ plus\n"));
        assert!(head.contains("keep\n"));
        assert!(!head.contains("CHANGED B"));
        assert!(work.contains("++ plus\n"));
        assert!(work.contains("CHANGED B\n"));
    }

    /// 与前端同一份行身份：从 canonical diff 的某一行取 hunkIndex/kind/oldNo/newNo。
    fn pick_of(diff: &DiffResponse, kind: &str, text: &str) -> DiffLineSelection {
        let line = diff
            .lines
            .iter()
            .find(|line| line.kind == kind && line.text == text)
            .unwrap_or_else(|| panic!("missing {kind} {text}"));
        DiffLineSelection {
            hunk_index: line.hunk_index.expect("hunk index"),
            kind: kind.to_string(),
            old_no: line.old_no,
            new_no: line.new_no,
        }
    }

    fn index_text(repo: &Path) -> String {
        String::from_utf8(git_bytes(repo, &["show", ":demo.txt"])).unwrap()
    }

    #[tokio::test]
    async fn line_stage_writes_only_the_selected_line() {
        let fixture = crate::test_support::git_fixture("line-stage");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let base: Vec<String> = (1..=20).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("demo.txt"), base.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let mut changed = base.clone();
        changed[2] = "LINE 3".to_string();
        changed[17] = "LINE 18".to_string();
        fs::write(repo.join("demo.txt"), changed.join("\n") + "\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        assert_eq!(diff.hunks.len(), 2, "hunks {:?}", diff.hunks);
        let staged = stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[pick_of(&diff, "add", "+LINE 3")],
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap();
        assert!(staged
            .files
            .iter()
            .any(|file| file.path == "demo.txt" && file.staged != crate::model::ChangeKind::None));
        let cached = String::from_utf8(git_bytes(&repo, &["diff", "--cached", "--", "demo.txt"])).unwrap();
        assert!(cached.contains("+LINE 3"), "{cached}");
        assert!(!cached.contains("-line 3"), "{cached}");
        assert!(!cached.contains("LINE 18"), "{cached}");
        // 未选中的删除行留在索引里：索引是「原 line 3 + 新增 LINE 3」，其余行一个都没动。
        let mut expected = base.clone();
        expected.insert(3, "LINE 3".to_string());
        assert_eq!(index_text(&repo), expected.join("\n") + "\n");
        // 工作区没有被写入，未暂存侧仍然是两处改动。
        assert_eq!(
            String::from_utf8(fs::read(repo.join("demo.txt")).unwrap()).unwrap(),
            changed.join("\n") + "\n"
        );
        let unstaged = String::from_utf8(git_bytes(&repo, &["diff", "--", "demo.txt"])).unwrap();
        assert!(unstaged.contains("-line 3"), "{unstaged}");
        assert!(unstaged.contains("+LINE 18"), "{unstaged}");
    }

    #[tokio::test]
    async fn line_stage_spans_hunks_without_touching_the_other_lines() {
        let fixture = crate::test_support::git_fixture("line-multi-hunk");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let base: Vec<String> = (1..=20).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("demo.txt"), base.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let mut changed = base.clone();
        changed[2] = "LINE 3".to_string();
        changed[17] = "LINE 18".to_string();
        fs::write(repo.join("demo.txt"), changed.join("\n") + "\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        // 跨 hunk：一处只写删除，另一处只写新增。
        let picks = [
            pick_of(&diff, "del", "-line 3"),
            pick_of(&diff, "add", "+LINE 18"),
        ];
        stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &picks,
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap();
        let mut expected: Vec<String> = base.clone();
        expected.remove(2);
        expected.insert(17, "LINE 18".to_string());
        assert_eq!(index_text(&repo), expected.join("\n") + "\n");
        let cached = String::from_utf8(git_bytes(&repo, &["diff", "--cached", "--", "demo.txt"])).unwrap();
        assert!(cached.contains("-line 3"), "{cached}");
        assert!(cached.contains("+LINE 18"), "{cached}");
        assert!(!cached.contains("+LINE 3"), "{cached}");
        assert!(!cached.contains("-line 18"), "{cached}");
    }

    #[tokio::test]
    async fn line_stage_keeps_adjacent_lines_independent() {
        let fixture = crate::test_support::git_fixture("line-adjacent");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let base: Vec<String> = (1..=8).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("demo.txt"), base.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let mut changed = base.clone();
        changed[2] = "LINE 3".to_string();
        changed[3] = "LINE 4".to_string();
        fs::write(repo.join("demo.txt"), changed.join("\n") + "\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        assert_eq!(diff.hunks.len(), 1);
        let picks = [
            pick_of(&diff, "del", "-line 3"),
            pick_of(&diff, "del", "-line 4"),
        ];
        stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &picks,
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap();
        let mut expected = base.clone();
        expected.remove(3);
        expected.remove(2);
        assert_eq!(index_text(&repo), expected.join("\n") + "\n");
        let cached = String::from_utf8(git_bytes(&repo, &["diff", "--cached", "--", "demo.txt"])).unwrap();
        assert!(!cached.contains("LINE 3"), "{cached}");
        assert!(!cached.contains("LINE 4"), "{cached}");
    }

    #[tokio::test]
    async fn line_unstage_reverses_only_the_selected_addition() {
        let fixture = crate::test_support::git_fixture("line-unstage");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let base: Vec<String> = (1..=10).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("demo.txt"), base.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let mut changed = base.clone();
        changed[4] = "NEW 5".to_string();
        fs::write(repo.join("demo.txt"), changed.join("\n") + "\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        let (path, generation) = open_repo(&backend, &repo).await;
        let staged_diff = load_diff(
            &backend, &path, "demo.txt", None, true, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        assert!(staged_diff.staged);
        // 只取消暂存「新增」那一行：索引里只少了 NEW 5，原来被删的 line 5 不会被塞回去。
        stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            true,
            &[pick_of(&staged_diff, "add", "+NEW 5")],
            &staged_diff.snapshot,
            staged_diff.generation,
            3,
        )
        .await
        .unwrap();
        let mut expected = base.clone();
        expected.remove(4);
        assert_eq!(index_text(&repo), expected.join("\n") + "\n");
        let cached = String::from_utf8(git_bytes(&repo, &["diff", "--cached", "--", "demo.txt"])).unwrap();
        assert!(cached.contains("-line 5"), "{cached}");
        assert!(!cached.contains("NEW 5"), "{cached}");
        assert_eq!(
            String::from_utf8(fs::read(repo.join("demo.txt")).unwrap()).unwrap(),
            changed.join("\n") + "\n"
        );
    }

    #[tokio::test]
    async fn line_stage_keeps_crlf_bytes() {
        let fixture = crate::test_support::git_fixture("line-crlf");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        let base: Vec<String> = (1..=8).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("demo.txt"), base.join("\r\n") + "\r\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let mut changed = base.clone();
        changed[4] = "NEW 5".to_string();
        fs::write(repo.join("demo.txt"), changed.join("\r\n") + "\r\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[pick_of(&diff, "add", "+NEW 5")],
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap();
        let index = git_bytes(&repo, &["show", ":demo.txt"]);
        let newlines = index.iter().filter(|byte| **byte == b'\n').count();
        let crlf = index.windows(2).filter(|pair| pair == b"\r\n").count();
        assert_eq!(newlines, 9, "每一行都必须仍是 CRLF: {:?}", String::from_utf8_lossy(&index));
        assert_eq!(crlf, 9, "{:?}", String::from_utf8_lossy(&index));
        let text = String::from_utf8(index).unwrap();
        let mut expected = base.clone();
        expected.insert(5, "NEW 5".to_string());
        assert_eq!(text, expected.join("\r\n") + "\r\n");
    }

    #[tokio::test]
    async fn line_stage_rejects_stale_binary_and_whole_file_changes() {
        let fixture = crate::test_support::git_fixture("line-reject");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        fs::write(repo.join("demo.txt"), "one\ntwo\nthree\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);

        // 过期快照：读取之后文件又变了，一行都不写。
        fs::write(repo.join("demo.txt"), "ONE\ntwo\nthree\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let diff = load_diff(
            &backend, &path, "demo.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        let stale_pick = pick_of(&diff, "add", "+ONE");
        fs::write(repo.join("demo.txt"), "ONE\nTWO\nthree\n").unwrap();
        let error = stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[stale_pick],
            &diff.snapshot,
            diff.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "stale_patch");
        assert!(git_bytes(&repo, &["diff", "--cached"]).is_empty());

        // 索引锁：一个字都不写，锁也不会被删掉。
        fs::write(repo.join(".git").join("index.lock"), b"locked").unwrap();
        let locked = stage_lines(
            &backend,
            &path,
            "demo.txt",
            None,
            false,
            &[pick_of(&diff, "del", "-one")],
            &diff.snapshot,
            diff.generation,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(locked.code, "index_lock");
        assert_eq!(
            fs::read(repo.join(".git").join("index.lock")).unwrap(),
            b"locked"
        );
        fs::remove_file(repo.join(".git").join("index.lock")).unwrap();
        assert!(git_bytes(&repo, &["diff", "--cached"]).is_empty());

        // 新增文件（未跟踪）：文件头语义是整份文件，逐行写入不安全。
        fs::write(repo.join("fresh.txt"), "a\nb\n").unwrap();
        let fresh = load_diff(
            &backend, &path, "fresh.txt", None, false, generation, 5, 0, 0,
        )
        .await
        .unwrap();
        assert!(fresh.lines.iter().any(|line| line.kind == "meta" && line.text.contains("new file mode")));
        let add = fresh
            .lines
            .iter()
            .find(|line| line.kind == "add")
            .expect("added line");
        let whole = DiffLineSelection {
            hunk_index: add.hunk_index.expect("hunk"),
            kind: "add".to_string(),
            old_no: add.old_no,
            new_no: add.new_no,
        };
        let error = stage_lines(
            &backend,
            &path,
            "fresh.txt",
            None,
            false,
            &[whole],
            &fresh.snapshot,
            fresh.generation,
            6,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "line_patch_unsupported");
        assert!(git_bytes(&repo, &["diff", "--cached"]).is_empty());

        // 二进制：没有可逐行写入的内容。
        fs::write(repo.join("data.bin"), b"a\0b\n").unwrap();
        let binary = load_diff(
            &backend, &path, "data.bin", None, false, generation, 7, 0, 0,
        )
        .await
        .unwrap();
        assert!(binary.binary);
        let error = stage_lines(
            &backend,
            &path,
            "data.bin",
            None,
            false,
            &[DiffLineSelection {
                hunk_index: 0,
                kind: "add".to_string(),
                old_no: None,
                new_no: Some(1),
            }],
            &binary.snapshot,
            binary.generation,
            8,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "not_text");
    }

    #[tokio::test]
    async fn line_stage_rejects_no_newline_and_truncated_hunks() {
        let fixture = crate::test_support::git_fixture("line-tail");
        let backend = fixture.backend_with_limit(700, Vec::new());
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Twiglane Test"]);
        git(
            &repo,
            &["config", "user.email", "twiglane-test@example.com"],
        );
        // 末尾没有换行：行尾语义无法逐行表达。
        fs::write(repo.join("tail.txt"), "one\ntwo").unwrap();
        git(&repo, &["add", "--", "tail.txt"]);
        git(&repo, &["commit", "-m", "tail"]);
        fs::write(repo.join("tail.txt"), "one\nTWO").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let tail = load_diff(
            &backend, &path, "tail.txt", None, false, generation, 2, 0, 0,
        )
        .await
        .unwrap();
        assert!(tail.lines.iter().any(|line| line.kind == "nonewline"));
        let add = tail
            .lines
            .iter()
            .find(|line| line.kind == "add")
            .expect("added line");
        let pick = DiffLineSelection {
            hunk_index: add.hunk_index.expect("hunk"),
            kind: "add".to_string(),
            old_no: add.old_no,
            new_no: add.new_no,
        };
        let error = stage_lines(
            &backend,
            &path,
            "tail.txt",
            None,
            false,
            &[pick],
            &tail.snapshot,
            tail.generation,
            3,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "line_patch_no_newline");
        assert!(git_bytes(&repo, &["diff", "--cached"]).is_empty());

        // 截断的差异：不完整的块里没有可靠的坐标。
        let original = format!("{}\nsecond\n", "a".repeat(40));
        fs::write(repo.join("wide.txt"), &original).unwrap();
        git(&repo, &["add", "--", "wide.txt"]);
        git(&repo, &["commit", "-m", "wide"]);
        let changed = format!("{}\n{}", "B".repeat(40), "C".repeat(4000));
        fs::write(repo.join("wide.txt"), &changed).unwrap();
        let wide = load_diff(
            &backend, &path, "wide.txt", None, false, generation, 4, 0, 400,
        )
        .await
        .unwrap();
        assert!(wide.truncated || !wide.complete);
        let incomplete: Vec<u32> = wide
            .hunks
            .iter()
            .filter(|hunk| !hunk.complete)
            .map(|hunk| hunk.index)
            .collect();
        assert!(!incomplete.is_empty(), "hunks {:?}", wide.hunks);
        let line = wide
            .lines
            .iter()
            .find(|line| {
                line.hunk_index.is_some_and(|index| incomplete.contains(&index))
                    && (line.kind == "add" || line.kind == "del")
            })
            .expect("line in the truncated hunk");
        let error = stage_lines(
            &backend,
            &path,
            "wide.txt",
            None,
            false,
            &[DiffLineSelection {
                hunk_index: line.hunk_index.unwrap(),
                kind: line.kind.clone(),
                old_no: line.old_no,
                new_no: line.new_no,
            }],
            &wide.snapshot,
            wide.generation,
            5,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "truncated_hunk");
        assert!(git_bytes(&repo, &["diff", "--cached"]).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn next_user_request_is_not_blocked_by_an_in_flight_diff() {
        let fixture = crate::test_support::git_fixture("request-gap");
        let backend = std::sync::Arc::new(fixture.backend());
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("demo.txt"), "before\n").unwrap();
        git(&repo, &["add", "--", "demo.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        fs::write(repo.join("demo.txt"), "after\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;
        let started = fixture.path().join("diff-started");
        let release = fixture.path().join("diff-release");
        let _release_guard = ReleaseFile(release.clone());
        install_diff_shim(fixture.path(), &started, &release);
        {
            let mut locator = backend
                .git
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            locator.set_resolved(crate::git::locate::ResolvedGit {
                path: fixture.path().join("git-shim"),
                version: "2.50.0".into(),
                major: 2,
                minor: 50,
                below_baseline: false,
            });
        }

        let first = spawn_diff(backend.clone(), path.clone(), generation, 30);
        wait_for_gate(&started, 1).await;
        let second = spawn_diff(backend.clone(), path.clone(), generation, 31);
        let overlapped = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            wait_for_gate(&started, 2),
        )
        .await;
        if overlapped.is_err() {
            if second.is_finished() {
                let error = second.await.unwrap().unwrap_err();
                panic!(
                    "second diff was rejected early: {} {}",
                    error.code, error.message
                );
            }
            panic!("second diff never reached git");
        }
        fs::write(&release, b"go").unwrap();
        let left = first.await.unwrap().unwrap();
        let right = second.await.unwrap().unwrap();
        assert!(left.text.as_ref().unwrap().contains("+after"));
        assert!(right.text.as_ref().unwrap().contains("+after"));

        fs::remove_file(&release).unwrap();
        let third = spawn_diff(backend.clone(), path.clone(), left.generation, 40);
        let held = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            wait_for_gate(&started, 3),
        )
        .await;
        if held.is_err() {
            panic!("diff did not stay in flight for the next user request");
        }
        let staged = stage_files(
            &backend,
            &path,
            &["demo.txt".to_string()],
            left.generation,
            41,
        )
        .await
        .unwrap_or_else(|error| {
            panic!("next request was blocked: {} {}", error.code, error.message)
        });
        assert!(staged
            .files
            .iter()
            .any(|file| file.path == "demo.txt" && file.staged != crate::model::ChangeKind::None));
        fs::write(&release, b"go").unwrap();
        let finished = third.await.unwrap().unwrap_err();
        assert_ne!(finished.code, "duplicate");
        assert_eq!(finished.code, "stale");
    }

    #[cfg(unix)]
    fn spawn_diff(
        backend: std::sync::Arc<crate::git::ops::Backend>,
        path: String,
        generation: u64,
        request_id: u64,
    ) -> tokio::task::JoinHandle<Result<crate::model::DiffResponse, AppError>> {
        tokio::spawn(async move {
            load_diff(
                &backend, &path, "demo.txt", None, false, generation, request_id, 0, 0,
            )
            .await
        })
    }

    #[cfg(unix)]
    async fn wait_for_gate(path: &Path, bytes: u64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            let len = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            if len >= bytes {
                return;
            }
            if std::time::Instant::now() >= deadline {
                panic!("diff gate stayed at {len} bytes, wanted {bytes}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    fn install_diff_shim(root: &Path, started: &Path, release: &Path) {
        let script = root.join("git-shim");
        let body = format!(
            "#!/bin/sh\nreal={real}\nstarted={started}\nrelease={release}\nunified=0\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"--unified=3\" ]; then\n    unified=1\n  fi\ndone\nif [ \"$unified\" -eq 1 ]; then\n  printf x >> \"$started\"\n  while [ ! -f \"$release\" ]; do\n    sleep 0.02\n  done\nfi\nexec \"$real\" \"$@\"\n",
            real = shell_quote(&crate::test_support::system_git()),
            started = shell_quote(started),
            release = shell_quote(release),
        );
        fs::write(&script, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();
    }

    #[cfg(unix)]
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
    }

    #[cfg(unix)]
    struct ReleaseFile(PathBuf);

    #[cfg(unix)]
    impl Drop for ReleaseFile {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, b"go");
        }
    }
}
