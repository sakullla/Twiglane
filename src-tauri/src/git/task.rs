//! 任务审阅的只读聚合：起点提交 → HEAD → 索引 → 工作区（含未跟踪文件）的最终净结果。
//!
//! 任务范围由后端解析并绑定版本：起点必须解析成完整提交、必须是当前 HEAD 的祖先，
//! 后续读取单文件差异时还要带上快照里的 HEAD。所有命令都走仓库调度器，复用请求 id、
//! 代次、取消域与错误脱敏；本模块不写 HEAD、索引或工作区。

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::git::changes::{diff_is_binary, response_from_diff};
use crate::git::command::{
    ancestor_command, file_diff_command, history_log_command,
    ls_files_command, ls_tree_entry_command, path_status_command, read_object_hash_command,
    rev_list_count_command, rev_parse_command, status_command, task_diff_command,
    task_name_status_command,
    task_numstat_command, HistoryLog,
};
use crate::git::files::review_path;
use crate::git::history::{parse_history_records, parse_name_status};
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, status_from_output, validate_input_path,
    Backend,
};
use crate::git::parse::parse_status;
use crate::git::patch::{
    apply_commit_numstat, first_file_diff, numstat_map, parse_diff, parse_diff_as_text,
    parse_numstat, parse_numstat_list, DIFF_PREVIEW_BYTES,
};
use crate::git::runner::ProcessOutput;
use crate::git::schedule::{internal_request_id, GitJob, JobKind, ScheduledOutput};
use crate::model::{
    ChangeKind, CommitFileChange, DiffResponse, FileChange, HistoryCommit, RepositoryReviewState,
    StatusSnapshot, TaskFileChange, TaskReview, TaskReviewToken,
};

/// 范围内提交只返回第一页；完整数量由 rev-list --count 给出。
const MAX_TASK_COMMITS: u32 = 100;
/// 文件队列上限：超过就明确标记截断，不把部分列表当成完整任务。
const MAX_TASK_FILES: usize = 20_000;
const MAX_BASELINE_CHARS: usize = 200;

/// 一次任务读取里顺序执行的只读命令：同一条仓库通道，每一步都跟随最新代次。
struct TaskReads<'a> {
    backend: &'a Backend,
    key: String,
    generation: u64,
}

impl<'a> TaskReads<'a> {
    fn new(backend: &'a Backend, root: &Path, generation: u64) -> Self {
        Self {
            backend,
            key: repo_key(root),
            generation,
        }
    }

    async fn run(
        &mut self,
        request_id: u64,
        command: (PathBuf, Vec<OsString>),
        truncate_stdout: bool,
        output_limit: Option<usize>,
    ) -> Result<ProcessOutput, AppError> {
        let (program, args) = command;
        let scheduled = self
            .backend
            .scheduler
            .execute(GitJob {
                repo_key: self.key.clone(),
                kind: JobKind::Read,
                request_id,
                generation: self.generation,
                program,
                args,
                stdin: None,
                truncate_stdout,
                output_limit,
                env: Vec::new(),
            })
            .await?;
        self.generation = scheduled.generation;
        Ok(scheduled.output)
    }

    /// 任务自己的后续步骤：请求 id 走高半区，不和用户命令抢同一个 id。
    async fn step(
        &mut self,
        command: (PathBuf, Vec<OsString>),
        truncate_stdout: bool,
        output_limit: Option<usize>,
    ) -> Result<ProcessOutput, AppError> {
        self.run(internal_request_id(), command, truncate_stdout, output_limit)
            .await
    }

    fn capture_limit(&self) -> usize {
        self.backend.runner.output_limit.min(DIFF_PREVIEW_BYTES)
    }
}

/// 校验过的任务范围：只有这里产出的完整 OID 才会进入响应和后续读取。
struct TaskRange {
    baseline_ref: String,
    baseline_oid: String,
    head_oid: String,
    snapshot: StatusSnapshot,
}

fn is_full_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn version_unconfirmed() -> AppError {
    AppError::new(
        "task_version_unconfirmed",
        "无法确认起点或 HEAD 的完整提交标识，任务范围没有成立。请重新读取或重新选择起点。",
    )
}

/// 目标 worktree 必须存在：缺失和读取失败是两种状态，都不能当成「空任务」。
fn task_root(path: &str) -> Result<PathBuf, AppError> {
    let candidate = validate_input_path(path)?;
    if !candidate.exists() {
        return Err(AppError::new(
            "task_worktree_missing",
            "目标 worktree 不存在或已被移除，任务范围无法建立。请重新打开工作区。",
        ));
    }
    let root = canonical_existing(&candidate)?;
    if !root.join(".git").exists() {
        return Err(AppError::new(
            "not_repository",
            "该目录不是 Git 仓库，未建立任务范围。",
        ));
    }
    Ok(root)
}

/// 用户给出的起点写法：不接受空串、选项样式的值或多行内容，也绝不替换成 HEAD。
fn baseline_spec(baseline: &str) -> Result<String, AppError> {
    let spec = baseline.trim();
    let unsafe_chars = spec
        .chars()
        .any(|value| value == '\0' || value == '\n' || value == '\r');
    if spec.is_empty() || spec.len() > MAX_BASELINE_CHARS || spec.starts_with('-') || unsafe_chars {
        return Err(AppError::new(
            "task_baseline_missing",
            "请先明确选择任务的起点提交或分支。这里不会用当前 HEAD 或默认分支代替起点。",
        ));
    }
    Ok(spec.to_string())
}

fn display_path(relative: &Path) -> String {
    relative.to_string_lossy().replace('\\', "/")
}

fn net_paths(relative: &Path, original: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![relative.to_path_buf()];
    if let Some(original) = original {
        if original != relative {
            paths.push(original.to_path_buf());
        }
    }
    paths
}

fn limit_error(error: AppError) -> AppError {
    if error.code == "output_limit" {
        AppError::new(
            "task_truncated",
            "任务范围的输出超过读取上限，没有把不完整结果当成完整任务。请缩小起点范围后重试。",
        )
    } else {
        error
    }
}

fn diff_failed(output: &ProcessOutput) -> bool {
    output.exit_code > 1
}

async fn resolve_commit(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    spec: &str,
) -> Result<String, AppError> {
    let revision = format!("{spec}^{{commit}}");
    let output = reads
        .step(rev_parse_command(git, root, &revision), false, None)
        .await?;
    if output.exit_code != 0 {
        return Err(AppError::new(
            "task_baseline_missing",
            "找不到这个起点提交：它可能已被删除、改名，或来自另一个仓库。请重新选择起点。",
        ));
    }
    let oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    if is_full_oid(&oid) {
        Ok(oid)
    } else {
        Err(version_unconfirmed())
    }
}
/// 解析并校验任务范围。
///
/// 顺序固定：先读状态（同时校验 generation 并拿到分支与 HEAD），再解析起点，最后确认
/// 起点是 HEAD 的祖先。任何一步失败都有自己的错误码，不退回「空任务」。
async fn resolve_range(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    baseline: &str,
    expected: Option<(&str, &Path)>,
    request_id: u64,
) -> Result<TaskRange, AppError> {
    let baseline_ref = baseline_spec(baseline)?;
    let command = match expected {
        Some((_, relative)) => path_status_command(git, root, relative),
        None => status_command(git, root),
    };
    let status_output = reads.run(request_id, command, false, None).await?;
    // A file preview/token only needs this path's status and HEAD. Computing
    // numstat and binary sizes for the whole worktree on every click is wasteful.
    let snapshot = if expected.is_some() {
        if status_output.exit_code != 0 {
            return Err(git_failure(
                "task_status",
                &status_output,
                "无法确认这条路径的状态，未修改仓库。",
            ));
        }
        let mut snapshot = parse_status(&status_output.stdout)?;
        snapshot.generation = reads.generation;
        snapshot
    } else {
        status_from_output(
            reads.backend,
            root,
            &ScheduledOutput {
                output: status_output,
                generation: reads.generation,
            },
        )
        .await?
    };
    let baseline_oid = resolve_commit(reads, root, git, &baseline_ref).await?;
    let head_oid = match snapshot.branch.head_oid.as_deref() {
        Some(oid) if is_full_oid(oid) => oid.to_ascii_lowercase(),
        Some(_) => return Err(version_unconfirmed()),
        None => {
            return Err(AppError::new(
                "task_head_unborn",
                "当前分支还没有任何提交，无法建立起点到 HEAD 的任务范围。",
            ))
        }
    };
    if let Some((expected, _)) = expected {
        let expected = expected.trim().to_ascii_lowercase();
        if !is_full_oid(&expected) {
            return Err(version_unconfirmed());
        }
        if expected != head_oid {
            return Err(AppError::new(
                "task_head_changed",
                "当前 HEAD 已经不是这个任务快照的 HEAD，请重新读取任务后再看差异。",
            )
            .with_generation(reads.generation));
        }
    }
    let ancestor = reads
        .step(
            ancestor_command(git, root, &baseline_oid, &head_oid),
            false,
            None,
        )
        .await?;
    if ancestor.exit_code != 0 {
        if ancestor.exit_code == 1 {
            return Err(AppError::new(
                "task_baseline_not_ancestor",
                "所选起点不是当前 HEAD 的祖先：它可能来自别的分支或另一个仓库。请重新选择起点。",
            )
            .with_generation(reads.generation));
        }
        return Err(git_failure(
            "task_range_failed",
            &ancestor,
            "无法确认起点与当前 HEAD 的关系，未修改仓库。",
        ));
    }
    Ok(TaskRange {
        baseline_ref,
        baseline_oid,
        head_oid,
        snapshot,
    })
}

/// 最终净文件队列：起点对工作区的名称/状态 + 增删行数 + 未跟踪文件，按路径去重。
async fn net_files(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    range: &TaskRange,
) -> Result<(Vec<TaskFileChange>, bool), AppError> {
    let status_output = reads
        .step(
            task_name_status_command(git, root, &range.baseline_oid, &[]),
            false,
            None,
        )
        .await
        .map_err(limit_error)?;
    if status_output.exit_code != 0 {
        return Err(git_failure(
            "task_range_failed",
            &status_output,
            "无法读取任务范围内的文件，未修改仓库。",
        ));
    }
    let mut tracked: Vec<CommitFileChange> = parse_name_status(&status_output.stdout)
        .map_err(|_| AppError::new("task_parse", "无法解析任务范围内的文件，未修改仓库。"))?;
    let stats_output = reads
        .step(
            task_numstat_command(git, root, &range.baseline_oid, &[]),
            false,
            None,
        )
        .await
        .map_err(limit_error)?;
    if stats_output.exit_code != 0 {
        return Err(git_failure(
            "task_range_failed",
            &stats_output,
            "无法读取任务范围内的行数，未修改仓库。",
        ));
    }
    apply_commit_numstat(
        &mut tracked,
        &numstat_map(parse_numstat_list(&stats_output.stdout)),
    );
    let unmerged: HashSet<&str> = range
        .snapshot
        .files
        .iter()
        .filter(|file| file.unmerged)
        .map(|file| file.path.as_str())
        .collect();

    // 同一条路径既在起点里、又在工作区里未跟踪：`git diff <baseline>` 只按索引判断，
    // 会把它报成删除，而工作区实际上有重建后的内容。这种情况下必须让工作区内容成为
    // 这条路径的最终净结果，否则文件列表会与未跟踪计数、单文件差异互相矛盾。
    let untracked_paths: HashSet<&str> = range
        .snapshot
        .files
        .iter()
        .filter(|file| file.untracked)
        .map(|file| file.path.as_str())
        .collect();

    // 起点里本来有、只是索引里没有的路径：如果工作区里同名文件现在是未跟踪，说明这是
    // 删除后从工作区重建，而不是一个纯新增文件。行数只能统计重建后的内容，界面必须标出。
    let removed_in_range: HashSet<String> = tracked
        .iter()
        .filter(|file| file.status == "deleted")
        .map(|file| file.path.clone())
        .collect();

    let mut files = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut truncated = false;
    for file in tracked {
        if files.len() >= MAX_TASK_FILES {
            truncated = true;
            break;
        }
        if untracked_paths.contains(file.path.as_str()) {
            // 交给下面的未跟踪分支：条目、状态与行数都按工作区内容给，和
            // untrackedFiles 计数、load_task_diff 的未跟踪读取保持同一份事实。
            continue;
        }
        if !seen.insert(file.path.clone()) {
            continue;
        }
        let conflicted = unmerged.contains(file.path.as_str());
        files.push(TaskFileChange {
            path: file.path,
            original_path: file.original_path,
            status: if conflicted {
                "unmerged".to_string()
            } else {
                file.status
            },
            additions: file.additions,
            deletions: file.deletions,
            binary: file.binary,
            old_size: file.old_size,
            new_size: file.new_size,
            untracked: false,
            unmerged: conflicted,
            rebuilt: false,
        });
    }
    for file in range.snapshot.files.iter().filter(|file| file.untracked) {
        if files.len() >= MAX_TASK_FILES {
            truncated = true;
            break;
        }
        if !seen.insert(file.path.clone()) {
            continue;
        }
        let stat = file.unstaged_lines;
        files.push(TaskFileChange {
            path: file.path.clone(),
            original_path: None,
            status: "added".to_string(),
            additions: stat.and_then(|value| value.additions),
            deletions: stat.and_then(|value| value.deletions),
            binary: stat.is_some_and(|value| value.additions.is_none() && value.deletions.is_none()),
            old_size: None,
            new_size: stat.and_then(|value| value.new_size),
            untracked: true,
            unmerged: false,
            rebuilt: removed_in_range.contains(&file.path),
        });
    }
    apply_binary_sizes(reads, root, git, &range.baseline_oid, &mut files).await;
    Ok((files, truncated))
}

/// 二进制文件补上前后大小：改动前取自起点里的版本，改动后取自工作区。
async fn apply_binary_sizes(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    baseline: &str,
    files: &mut [TaskFileChange],
) {
    use crate::git::sizes::{object_sizes, tree_name, worktree_size};
    let mut names = Vec::new();
    for file in files.iter().filter(|file| file.binary && !file.untracked) {
        names.push(tree_name(
            baseline,
            file.original_path.as_deref().unwrap_or(&file.path),
        ));
    }
    let mut sizes = std::collections::HashMap::new();
    if !names.is_empty() {
        sizes = object_sizes(reads.backend, git, root, reads.generation, &names).await;
    }
    for file in files.iter_mut().filter(|file| file.binary) {
        if !file.untracked {
            let name = tree_name(
                baseline,
                file.original_path.as_deref().unwrap_or(&file.path),
            );
            file.old_size = sizes.get(&name).copied();
        }
        file.new_size = worktree_size(root, &file.path);
    }
}

/// 范围内提交：完整数量用 rev-list --count，列表只取第一页。
async fn range_commits(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    range: &TaskRange,
) -> Result<(Vec<HistoryCommit>, u64, bool), AppError> {
    let revision = format!("{}..{}", range.baseline_oid, range.head_oid);
    let count_output = reads
        .step(rev_list_count_command(git, root, &revision), false, None)
        .await
        .map_err(limit_error)?;
    if count_output.exit_code != 0 {
        return Err(git_failure(
            "task_range_failed",
            &count_output,
            "无法读取任务范围内的提交数量，未修改仓库。",
        ));
    }
    let commit_count = String::from_utf8_lossy(&count_output.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|_| AppError::new("task_parse", "无法解析任务范围内的提交数量，未修改仓库。"))?;
    let log = HistoryLog {
        revision: Some(revision),
        max_count: Some(MAX_TASK_COMMITS.saturating_add(1)),
        ..HistoryLog::default()
    };
    let log_output = reads
        .step(history_log_command(git, root, &log), false, None)
        .await
        .map_err(limit_error)?;
    if log_output.exit_code != 0 {
        return Err(git_failure(
            "task_range_failed",
            &log_output,
            "无法读取任务范围内的提交，未修改仓库。",
        ));
    }
    let mut commits = parse_history_records(&log_output.stdout)
        .map_err(|_| AppError::new("task_parse", "无法解析任务范围内的提交，未修改仓库。"))?;
    let truncated = commits.len() > MAX_TASK_COMMITS as usize;
    commits.truncate(MAX_TASK_COMMITS as usize);
    Ok((commits, commit_count, truncated))
}

/// 范围版本：绑定 worktree、起点、HEAD 与当前未提交状态，供后续失效判断。
fn range_version(
    root: &Path,
    baseline_oid: &str,
    head_oid: &str,
    snapshot: &StatusSnapshot,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(repo_key(root).as_bytes());
    hasher.update([0]);
    hasher.update(baseline_oid.as_bytes());
    hasher.update([0]);
    hasher.update(head_oid.as_bytes());
    hasher.update([0]);
    let mut entries: Vec<String> = snapshot
        .files
        .iter()
        .map(|file| {
            format!(
                "{:?}|{:?}|{}|{}|{}|{:?}",
                file.staged,
                file.unstaged,
                file.untracked,
                file.unmerged,
                file.path,
                file.original_path
            )
        })
        .collect();
    entries.sort();
    for entry in entries {
        hasher.update(entry.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn dirty(file: &FileChange) -> bool {
    file.untracked
        || file.unmerged
        || file.staged != ChangeKind::None
        || file.unstaged != ChangeKind::None
}
/// 读取一个任务的最终净结果。只有完整成功才返回；空任务用 empty 表示。
pub async fn task_review(
    backend: &Backend,
    path: &str,
    baseline: &str,
    generation: u64,
    request_id: u64,
) -> Result<TaskReview, AppError> {
    let root = task_root(path)?;
    let git = require_git(backend).await?.path;
    let mut reads = TaskReads::new(backend, &root, generation);
    let range = resolve_range(&mut reads, &root, &git, baseline, None, request_id).await?;
    let (files, files_truncated) = net_files(&mut reads, &root, &git, &range).await?;
    let (commits, commit_count, commits_truncated) =
        range_commits(&mut reads, &root, &git, &range).await?;
    let additions = files.iter().map(|file| file.additions.unwrap_or(0)).sum();
    let deletions = files.iter().map(|file| file.deletions.unwrap_or(0)).sum();
    let file_count = files.len() as u32;
    let empty = files.is_empty() && commit_count == 0;
    let message = if files_truncated {
        format!(
            "文件数超过 {MAX_TASK_FILES} 条上限，这里只列出前 {MAX_TASK_FILES} 条，不能当作完整任务范围。"
        )
    } else if empty {
        "读取成功：起点之后没有提交，也没有未提交改动。".to_string()
    } else if files.is_empty() {
        format!("读取成功：起点之后有 {commit_count} 个提交，但它们没有改变文件内容。")
    } else {
        format!("读取成功：起点之后 {commit_count} 个提交，最终净改动 {file_count} 个文件。")
    };
    Ok(TaskReview {
        generation: reads.generation,
        worktree: repo_key(&root),
        baseline_ref: range.baseline_ref,
        baseline_oid: range.baseline_oid.clone(),
        head_oid: range.head_oid.clone(),
        branch: range.snapshot.branch.clone(),
        commits,
        commit_count,
        commits_truncated,
        files_total: file_count,
        files,
        files_truncated,
        additions,
        deletions,
        dirty: range.snapshot.files.iter().any(dirty),
        untracked_files: range
            .snapshot
            .files
            .iter()
            .filter(|file| file.untracked)
            .count() as u32,
        conflicted: range.snapshot.files.iter().any(|file| file.unmerged),
        empty,
        range_version: range_version(
            &root,
            &range.baseline_oid,
            &range.head_oid,
            &range.snapshot,
        ),
        message,
    })
}

/// 单条路径的净差异读取：起点对工作区，保留分页、预览、二进制、截断与代次保护。
#[allow(clippy::too_many_arguments)]
pub async fn load_task_diff(
    backend: &Backend,
    path: &str,
    baseline: &str,
    head: &str,
    relative: &str,
    original: Option<&str>,
    generation: u64,
    request_id: u64,
    offset: u32,
    limit: u32,
    context: u32,
    as_text: bool,
) -> Result<DiffResponse, AppError> {
    let root = task_root(path)?;
    let git = require_git(backend).await?.path;
    let mut reads = TaskReads::new(backend, &root, generation);
    let relative_path = review_path(relative)?;
    let range = resolve_range(&mut reads, &root, &git, baseline, Some((head, &relative_path)), request_id).await?;
    let original_path = match original {
        Some(value) if !value.is_empty() => Some(review_path(value)?),
        _ => None,
    };
    let display = display_path(&relative_path);
    let untracked = range.snapshot.files.iter().any(|file| file.path == display && file.untracked);
    let paths = net_paths(&relative_path, original_path.as_deref());
    let (program, args) = task_diff_command(
        &git,
        &root,
        &range.baseline_oid,
        &paths,
        untracked,
        context,
        as_text,
    );
    let output_limit = reads.capture_limit();
    let output = reads
        .run(internal_request_id(), (program, args), true, Some(output_limit))
        .await?;
    if diff_failed(&output) {
        return Err(git_failure(
            "diff_failed",
            &output,
            "无法读取这次任务的差异，未修改仓库。",
        ));
    }
    let raw = first_file_diff(&output.stdout);
    let truncated = output.stdout_truncated || raw.len() != output.stdout.len();
    let parsed = if as_text {
        parse_diff_as_text(raw, truncated)?
    } else {
        parse_diff(raw, truncated)?
    };
    let counts = if parsed.truncated && !as_text {
        path_numstat(
            &mut reads,
            &root,
            &git,
            &range.baseline_oid,
            &paths,
            untracked,
        )
        .await?
    } else {
        None
    };
    let sizes = if diff_is_binary(&parsed, counts) {
        task_sizes(
            &mut reads,
            &root,
            &git,
            &range.baseline_oid,
            &relative_path,
            original_path.as_deref(),
            untracked,
        )
        .await
    } else {
        (None, None)
    };
    let display = display_path(&relative_path);
    let mut response = response_from_diff(
        reads.generation,
        &display,
        false,
        &parsed,
        raw,
        counts,
        sizes,
        offset,
        limit,
    )?;
    let patch = String::from_utf8_lossy(raw);
    let added = untracked
        || patch
            .lines()
            .any(|line| line == "--- /dev/null" || line.starts_with("new file mode "));
    let deleted = !untracked
        && patch
            .lines()
            .any(|line| line == "+++ /dev/null" || line.starts_with("deleted file mode "));
    let old_path = original
        .filter(|value| !value.is_empty())
        .unwrap_or(relative);
    if !as_text && crate::git::preview::wants_preview(relative, raw) {
        response.preview = Some(crate::git::preview::PreviewSources {
            repository: root.to_string_lossy().into_owned(),
            old: (!added).then(|| crate::git::preview::PreviewSource {
                revision: range.baseline_oid.clone(),
                path: old_path.into(),
            }),
            new: (!deleted).then(|| crate::git::preview::PreviewSource {
                revision: "worktree".into(),
                path: relative.into(),
            }),
        });
    }
    let markdown = crate::git::document::is_markdown(relative)
        || original.is_some_and(crate::git::document::is_markdown);
    if markdown {
        response.document = Some(crate::git::preview::PreviewSources {
            repository: root.to_string_lossy().into_owned(),
            old: (!added).then(|| crate::git::preview::PreviewSource {
                revision: range.baseline_oid.clone(),
                path: old_path.into(),
            }),
            new: (!deleted).then(|| crate::git::preview::PreviewSource {
                revision: "worktree".into(),
                path: relative.into(),
            }),
        });
    }
    Ok(response)
}

/// 截断的差异仍要给出完整统计：单独读一次这一条路径的 numstat。
async fn path_numstat(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    baseline: &str,
    paths: &[PathBuf],
    untracked: bool,
) -> Result<Option<(Option<u64>, Option<u64>)>, AppError> {
    let command = if untracked {
        file_diff_command(git, root, paths, false, true, true)
    } else {
        task_numstat_command(git, root, baseline, paths)
    };
    let output = reads.step(command, false, None).await?;
    if diff_failed(&output) {
        return Ok(None);
    }
    Ok(parse_numstat(&output.stdout))
}

/// 二进制改动前后的大小：改动前取自起点里的版本，改动后取自工作区。
async fn task_sizes(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    baseline: &str,
    relative: &Path,
    original: Option<&Path>,
    untracked: bool,
) -> (Option<u64>, Option<u64>) {
    use crate::git::sizes::{object_sizes, tree_name, worktree_size};
    let mut old_size = None;
    if !untracked {
        let name = tree_name(baseline, &display_path(original.unwrap_or(relative)));
        let sizes = object_sizes(
            reads.backend,
            git,
            root,
            reads.generation,
            std::slice::from_ref(&name),
        )
        .await;
        old_size = sizes.get(&name).copied();
    }
    (old_size, worktree_size(root, &display_path(relative)))
}
/// 单条任务路径的快照确认。
///
/// token 绑定 worktree、起点、这条路径的最终净内容与两侧状态：其他路径的改动不会
/// 改变它；这条路径的内容、暂存/未跟踪/冲突状态变化，或起点改动都会换一个新 token。
/// 差异被截断或内容无法确认时不给 token，前端保持未审阅。
pub async fn task_review_token(
    backend: &Backend,
    path: &str,
    baseline: &str,
    head: &str,
    relative: &str,
    generation: u64,
    request_id: u64,
) -> Result<TaskReviewToken, AppError> {
    let root = task_root(path)?;
    let git = require_git(backend).await?.path;
    let mut reads = TaskReads::new(backend, &root, generation);
    let relative_path = review_path(relative)?;
    let range = resolve_range(&mut reads, &root, &git, baseline, Some((head, &relative_path)), request_id).await?;
    let display = display_path(&relative_path);

    let change = range.snapshot.files.iter().find(|file| file.path == display);
    let (staged, unstaged, untracked, unmerged, original_path) = match &change {
        Some(file) => (
            file.staged,
            file.unstaged,
            file.untracked,
            file.unmerged,
            file.original_path.clone(),
        ),
        None => (ChangeKind::None, ChangeKind::None, false, false, None),
    };
    let original_path = original_path
        .and_then(|value| crate::git::ops::safe_relative(&value).ok())
        .filter(|path| !path.as_os_str().is_empty());

    let index_output = reads
        .step(ls_files_command(&git, &root, &relative_path), false, None)
        .await?;
    if index_output.exit_code != 0 {
        return Err(git_failure(
            "task_status",
            &index_output,
            "无法确认这条路径的暂存状态，未修改仓库。",
        ));
    }
    let index_version = String::from_utf8_lossy(&index_output.stdout).into_owned();

    let baseline_output = reads
        .step(
            ls_tree_entry_command(
                &git,
                &root,
                &range.baseline_oid,
                original_path.as_deref().unwrap_or(&relative_path),
            ),
            false,
            None,
        )
        .await?;
    let baseline_version = if baseline_output.exit_code == 0 {
        Some(tree_entry_oid(&baseline_output.stdout))
    } else {
        None
    };

    let paths = net_paths(&relative_path, original_path.as_deref());
    let (program, args) = task_diff_command(
        &git,
        &root,
        &range.baseline_oid,
        &paths,
        untracked,
        3,
        false,
    );
    let output_limit = reads.capture_limit();
    let patch_output = reads
        .run(internal_request_id(), (program, args), true, Some(output_limit))
        .await?;
    if diff_failed(&patch_output) {
        return Err(git_failure(
            "diff_failed",
            &patch_output,
            "无法读取这条路径的任务差异，未修改仓库。",
        ));
    }
    let raw = first_file_diff(&patch_output.stdout);
    let truncated = patch_output.stdout_truncated || raw.len() != patch_output.stdout.len();
    let status = patch_status(&String::from_utf8_lossy(raw), untracked);
    let empty = raw.is_empty();
    let (content_version, content_state) =
        worktree_version(&mut reads, &root, &git, &relative_path).await;

    if truncated {
        return Ok(token_result(
            reads.generation,
            &display,
            &range.baseline_oid,
            RepositoryReviewState::Unconfirmed,
            None,
            status,
            untracked,
            unmerged,
            baseline_version,
            content_version,
            true,
            "这条路径的任务差异超过预览上限，只读到一部分，不能确认完整快照。请按文本打开或缩小范围后重试。",
        ));
    }
    if empty && !untracked {
        return Ok(token_result(
            reads.generation,
            &display,
            &range.baseline_oid,
            RepositoryReviewState::Unchanged,
            None,
            status,
            untracked,
            unmerged,
            baseline_version,
            content_version,
            false,
            "这条路径相对起点没有净变化，不能标记已审阅。",
        ));
    }
    if let Some(reason) = content_state {
        return Ok(token_result(
            reads.generation,
            &display,
            &range.baseline_oid,
            RepositoryReviewState::Unconfirmed,
            None,
            status,
            untracked,
            unmerged,
            baseline_version,
            content_version,
            false,
            &format!("无法确认这条路径的内容，保持未审阅：{reason}"),
        ));
    }

    let mut hasher = Sha256::new();
    hasher.update(repo_key(&root).as_bytes());
    hasher.update([0]);
    hasher.update(range.baseline_oid.as_bytes());
    hasher.update([0]);
    hasher.update(display.as_bytes());
    hasher.update([0]);
    hasher.update(
        format!(
            "{:?}|{:?}|{}|{}|{:?}",
            staged,
            unstaged,
            untracked,
            unmerged,
            original_path.as_deref().map(display_path)
        )
        .as_bytes(),
    );
    hasher.update([0]);
    hasher.update(index_version.as_bytes());
    hasher.update([0]);
    hasher.update(baseline_version.as_deref().unwrap_or("none").as_bytes());
    hasher.update([0]);
    hasher.update(content_version.as_deref().unwrap_or("none").as_bytes());
    hasher.update([0]);
    hasher.update(raw);
    Ok(token_result(
        reads.generation,
        &display,
        &range.baseline_oid,
        RepositoryReviewState::Current,
        Some(format!("{:x}", hasher.finalize())),
        status,
        untracked,
        unmerged,
        baseline_version,
        content_version,
        false,
        "已确认这条路径相对起点的最终净内容。",
    ))
}

/// ls-tree -z 的第一条记录：mode SP type SP oid TAB path。
fn tree_entry_oid(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0 || *byte == b'\t')
        .unwrap_or(bytes.len());
    let record = String::from_utf8_lossy(&bytes[..end]);
    record
        .split(' ')
        .nth(2)
        .map(|oid| oid.trim().to_ascii_lowercase())
        .filter(|oid| is_full_oid(oid))
        .unwrap_or_else(|| "absent".to_string())
}

/// 净差异的状态名称：与提交文件列表同一套写法。
fn patch_status(patch: &str, untracked: bool) -> String {
    if untracked || patch.lines().any(|line| line.starts_with("new file mode ")) {
        return "added".to_string();
    }
    if patch
        .lines()
        .any(|line| line.starts_with("deleted file mode "))
    {
        return "deleted".to_string();
    }
    if patch
        .lines()
        .any(|line| line.starts_with("rename from ") || line.starts_with("similarity index "))
    {
        return "renamed".to_string();
    }
    if patch.is_empty() {
        return "unknown".to_string();
    }
    "modified".to_string()
}

/// 工作区内容版本；第二项是「为什么无法确认」的说明。
async fn worktree_version(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    relative: &Path,
) -> (Option<String>, Option<String>) {
    let target = root.join(relative);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            (None, Some("不跟随符号链接确认内容。".to_string()))
        }
        Ok(meta) if !meta.is_file() => (None, Some("这不是一个普通文件。".to_string())),
        Ok(_) => {
            let output = match reads
                .step(read_object_hash_command(git, root, relative), false, None)
                .await
            {
                Ok(output) => output,
                Err(error) => return (None, Some(error.message)),
            };
            if output.exit_code != 0 {
                let detail =
                    crate::redact::redact_error_text(String::from_utf8_lossy(&output.stderr).trim());
                let reason = if detail.is_empty() {
                    "无法读取当前文件内容。".to_string()
                } else {
                    detail
                };
                return (None, Some(reason));
            }
            let oid = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_ascii_lowercase();
            if is_full_oid(&oid) {
                (Some(format!("worktree:{oid}")), None)
            } else {
                (None, Some("Git 没有返回这个文件的内容版本。".to_string()))
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => (Some("missing".to_string()), None),
        Err(error) => (
            None,
            Some(crate::redact::redact_error_text(&error.to_string())),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn token_result(
    generation: u64,
    path: &str,
    baseline_oid: &str,
    state: RepositoryReviewState,
    token: Option<String>,
    status: String,
    untracked: bool,
    unmerged: bool,
    baseline_version: Option<String>,
    content_version: Option<String>,
    truncated: bool,
    message: &str,
) -> TaskReviewToken {
    TaskReviewToken {
        generation,
        path: path.to_string(),
        baseline_oid: baseline_oid.to_string(),
        state,
        token,
        status,
        untracked,
        unmerged,
        baseline_version,
        content_version,
        truncated,
        message: message.to_string(),
    }
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

    /// 预期会失败的 Git 动作（例如制造合并冲突）：只返回退出码，不 panic。
    fn git_attempt(dir: &Path, args: &[&str]) -> i32 {
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
            .code()
            .unwrap_or(-1)
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

    fn git_stdout(dir: &Path, args: &[&str]) -> String {
        String::from_utf8_lossy(&git_bytes(dir, args))
            .trim()
            .to_string()
    }

    async fn open_repo(backend: &Backend, repo: &Path) -> (String, u64) {
        let opened = crate::git::ops::add_repository(
            backend,
            &repo_key(&canonical_existing(repo).unwrap()),
            1,
        )
        .await
        .unwrap();
        (opened.summary.path, opened.generation)
    }

    fn file<'a>(files: &'a [TaskFileChange], path: &str) -> &'a TaskFileChange {
        files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("missing {path} in {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>()))
    }

    #[tokio::test]
    async fn single_file_reads_do_not_scan_unrelated_worktree_changes() {
        let fixture = crate::test_support::git_fixture("task-path-budget");
        let backend = fixture.backend_with_limit(4096, Vec::new());
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("target.txt"), "before\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        let (path, generation) = open_repo(&backend, &repo).await;
        fs::write(repo.join("target.txt"), "after\n").unwrap();
        for index in 0..1000 {
            fs::write(repo.join(format!("unrelated-{index:04}.txt")), "unrelated\n").unwrap();
        }
        // The old full-worktree status exceeds the capture budget before even
        // reaching this small diff. A path read must remain independent of it.
        assert!(git_bytes(&repo, &["status", "--porcelain=v2", "-z", "--untracked-files=all"]).len() > 4096);
        let diff = load_task_diff(&backend, &path, &head, &head, "target.txt", None, generation, 100, 0, 0, 3, false).await.unwrap();
        assert_eq!((diff.additions, diff.deletions), (1, 1));
        let token = task_review_token(&backend, &path, &head, &head, "target.txt", generation, 101).await.unwrap();
        assert!(token.token.is_some());
    }

    /// 仅提交、提交后再改同一路径、暂存 + 未暂存、删除与未跟踪文件合并成一份净结果。
    #[tokio::test]
    async fn task_review_merges_commits_staged_unstaged_and_untracked() {
        let fixture = crate::test_support::git_fixture("task-review-mixed");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "a1\n").unwrap();
        fs::write(repo.join("gone.txt"), "gone\n").unwrap();
        fs::write(repo.join("same.txt"), "s1\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);

        fs::write(repo.join("a.txt"), "a2\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        git(&repo, &["commit", "-m", "commit a"]);
        fs::write(repo.join("same.txt"), "s2\n").unwrap();
        git(&repo, &["add", "same.txt"]);
        git(&repo, &["commit", "-m", "commit same"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);

        // 同一路径先在提交里改过，工作区里又改：默认结果是从起点到工作区的净变化。
        fs::write(repo.join("a.txt"), "a3\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        fs::write(repo.join("a.txt"), "a4\n").unwrap();
        fs::remove_file(repo.join("gone.txt")).unwrap();
        fs::write(repo.join("new.txt"), "n1\nn2\n").unwrap();

        let before_head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        let before_index = git_bytes(&repo, &["ls-files", "-s"]);
        let before_status = git_bytes(&repo, &["status", "--porcelain=v1", "-z"]);
        let (path, generation) = open_repo(&backend, &repo).await;

        let task = task_review(&backend, &path, &baseline, generation, 2)
            .await
            .unwrap();
        assert_eq!(task.baseline_oid, baseline);
        assert_eq!(task.head_oid, head);
        assert_eq!(task.commit_count, 2);
        assert_eq!(task.commits.len(), 2);
        assert!(!task.commits_truncated);
        assert_eq!(task.files_total, 4);
        assert!(!task.files_truncated);
        assert!(task.dirty);
        assert_eq!(task.untracked_files, 1);
        assert!(!task.conflicted);
        assert!(!task.empty);
        assert!(task.branch.name.as_deref() == Some("main"));

        let a = file(&task.files, "a.txt");
        assert_eq!(a.status, "modified");
        assert!(!a.untracked);
        assert_eq!((a.additions, a.deletions), (Some(1), Some(1)));
        let gone = file(&task.files, "gone.txt");
        assert_eq!(gone.status, "deleted");
        assert_eq!((gone.additions, gone.deletions), (Some(0), Some(1)));
        let same = file(&task.files, "same.txt");
        assert_eq!(same.status, "modified");
        let new = file(&task.files, "new.txt");
        assert!(new.untracked);
        assert!(!new.rebuilt, "起点里没有这条路径时是普通新增");
        assert_eq!(new.status, "added");
        assert_eq!((new.additions, new.deletions), (Some(2), Some(0)));

        // 只读：进入与读取任务前后 HEAD、索引与工作区完全一致。
        assert_eq!(git_stdout(&repo, &["rev-parse", "HEAD"]), before_head);
        assert_eq!(git_bytes(&repo, &["ls-files", "-s"]), before_index);
        assert_eq!(
            git_bytes(&repo, &["status", "--porcelain=v1", "-z"]),
            before_status
        );

        // 范围版本绑定 worktree、起点、HEAD 与未提交状态的形状：重复读取保持稳定，
        // 多出一条未提交路径就必须变化（内容级失效由单文件 token 负责）。
        let again = task_review(&backend, &path, &baseline, task.generation, 3)
            .await
            .unwrap();
        assert_eq!(again.range_version, task.range_version);
        fs::write(repo.join("another.txt"), "x\n").unwrap();
        let changed = task_review(&backend, &path, &baseline, again.generation, 4)
            .await
            .unwrap();
        assert_ne!(changed.range_version, task.range_version);
        assert!(file(&changed.files, "another.txt").untracked);
        assert_eq!(
            file(&changed.files, "new.txt").additions,
            Some(2),
            "未跟踪文件的行数来自工作区内容"
        );
    }

    /// 只有提交、没有未提交改动时，统计仍来自提交本身。
    #[tokio::test]
    async fn task_review_committed_only_has_no_uncommitted_state() {
        let fixture = crate::test_support::git_fixture("task-review-committed");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("one.txt"), "one\n").unwrap();
        fs::write(repo.join("two.txt"), "two\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("one.txt"), "one changed\n").unwrap();
        fs::write(repo.join("two.txt"), "two\nmore\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "change both"]);
        let (path, generation) = open_repo(&backend, &repo).await;

        let task = task_review(&backend, &path, &baseline, generation, 2)
            .await
            .unwrap();
        assert!(!task.dirty);
        assert_eq!(task.untracked_files, 0);
        assert_eq!(task.files_total, 2);
        assert_eq!(task.commit_count, 1);
        assert_eq!(task.additions, 2, "one changed + a new line in two.txt");
        assert_eq!(task.deletions, 1);
        assert!(git_bytes(&repo, &["status", "--porcelain=v1", "-z"]).is_empty());
    }

    /// rename 与删除：新路径带原路径，删除保留在净结果里。
    #[tokio::test]
    async fn task_review_reports_rename_and_delete() {
        let fixture = crate::test_support::git_fixture("task-review-rename");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("old.txt"), "content\nsecond line\nthird line\n").unwrap();
        fs::write(repo.join("doomed.txt"), "bye\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["mv", "old.txt", "new.txt"]);
        git(&repo, &["rm", "-q", "doomed.txt"]);
        git(&repo, &["commit", "-m", "rename and delete"]);
        let (path, generation) = open_repo(&backend, &repo).await;

        let task = task_review(&backend, &path, &baseline, generation, 2)
            .await
            .unwrap();
        assert_eq!(task.files_total, 2);
        let renamed = file(&task.files, "new.txt");
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.original_path.as_deref(), Some("old.txt"));
        let deleted = file(&task.files, "doomed.txt");
        assert_eq!(deleted.status, "deleted");
        assert_eq!(deleted.deletions, Some(1));
        assert!(!task.files.iter().any(|file| file.path == "old.txt"));
    }

    /// 起点就是 HEAD 且没有改动：完整读取成功后的空任务，不是错误。
    #[tokio::test]
    async fn task_review_empty_task_is_not_an_error() {
        let fixture = crate::test_support::git_fixture("task-review-empty");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let (path, generation) = open_repo(&backend, &repo).await;

        let task = task_review(&backend, &path, "HEAD", generation, 2)
            .await
            .unwrap();
        assert!(task.empty);
        assert!(task.files.is_empty());
        assert_eq!(task.commit_count, 0);
        assert!(!task.dirty);
        assert!(task.message.contains("没有提交"));
    }

    /// 起点缺失、非祖先、worktree 缺失与空起点必须是不同错误。
    #[tokio::test]
    async fn task_review_separates_baseline_worktree_and_range_errors() {
        let fixture = crate::test_support::git_fixture("task-review-errors");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        // 另一条分支上的提交不属于当前 HEAD 的历史。
        git(&repo, &["checkout", "-q", "-b", "side"]);
        fs::write(repo.join("side.txt"), "side\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "side"]);
        git(&repo, &["checkout", "-q", "main"]);
        fs::write(repo.join("main.txt"), "main\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "main second"]);
        let (path, generation) = open_repo(&backend, &repo).await;

        let missing = task_review(&backend, &path, "no-such-ref", generation, 2)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "task_baseline_missing");

        let unrelated = task_review(&backend, &path, "side", generation, 3)
            .await
            .unwrap_err();
        assert_eq!(unrelated.code, "task_baseline_not_ancestor");
        assert!(unrelated.generation.is_some());

        let blank = task_review(&backend, &path, "  ", generation, 4)
            .await
            .unwrap_err();
        assert_eq!(blank.code, "task_baseline_missing");

        // 普通目录不是仓库：读取失败与空任务必须分开。
        let plain = fixture.path().join("plain-dir");
        fs::create_dir_all(&plain).unwrap();
        let not_repo = task_review(&backend, plain.to_str().unwrap(), "main", generation, 7)
            .await
            .unwrap_err();
        assert_eq!(not_repo.code, "not_repository");

        let absent = repo.join("removed-worktree");
        let error = task_review(&backend, absent.to_str().unwrap(), "main", generation, 5)
            .await
            .unwrap_err();
        assert_eq!(error.code, "task_worktree_missing");

        // HEAD 还没有提交（孤儿分支）：起点解析得出来，但范围不成立，必须单独报错。
        let unborn = fixture.repo("unborn");
        git(&unborn, &["init", "-b", "main"]);
        fs::write(unborn.join("a.txt"), "a
").unwrap();
        git(&unborn, &["add", "."]);
        git(&unborn, &["commit", "-m", "base"]);
        git(&unborn, &["checkout", "-q", "--orphan", "ghost"]);
        let (unborn_path, unborn_generation) = open_repo(&backend, &unborn).await;
        let error = task_review(
            &backend,
            &unborn_path,
            "main",
            unborn_generation,
            6,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "task_head_unborn");
    }
    /// 单文件任务差异：分页、未跟踪、二进制尺寸、过期 generation 与 HEAD/起点校验。
    #[tokio::test]
    async fn load_task_diff_pages_untracked_and_binary() {
        let fixture = crate::test_support::git_fixture("task-diff-pages");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        let lines: Vec<String> = (1..=120).map(|index| format!("line {index}")).collect();
        fs::write(repo.join("long.txt"), lines.join("\n") + "\n").unwrap();
        fs::write(repo.join("bin.dat"), "plain text\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        let changed: Vec<String> = (1..=120).map(|index| format!("LINE {index}")).collect();
        fs::write(repo.join("long.txt"), changed.join("\n") + "\n").unwrap();
        fs::write(repo.join("bin.dat"), [0_u8, 1, 2, 0, 255, 7]).unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "change"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("fresh.txt"), "one\ntwo\nthree\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;

        let first = load_task_diff(
            &backend, &path, &baseline, &head, "long.txt", None, generation, 2, 0, 40, 3, false,
        )
        .await
        .unwrap();
        assert!(!first.binary);
        assert!(first.total_lines > 40, "total {}", first.total_lines);
        assert_eq!(first.lines.len(), 40);
        assert_eq!(first.offset, 0);
        let second = load_task_diff(
            &backend, &path, &baseline, &head, "long.txt", None, first.generation, 3, 40, 40, 3,
            false,
        )
        .await
        .unwrap();
        assert_eq!(second.offset, 40);
        assert_eq!(second.lines.len(), 40);
        assert_ne!(second.lines.first().map(|line| &line.text), first.lines.first().map(|line| &line.text));

        let fresh = load_task_diff(
            &backend, &path, &baseline, &head, "fresh.txt", None, second.generation, 4, 0, 0, 3,
            false,
        )
        .await
        .unwrap();
        assert!(!fresh.binary);
        assert!(
            fresh.text.as_deref().unwrap_or("").contains("+three"),
            "untracked diff must come from the worktree file"
        );

        let binary = load_task_diff(
            &backend, &path, &baseline, &head, "bin.dat", None, fresh.generation, 5, 0, 0, 3, false,
        )
        .await
        .unwrap();
        assert!(binary.binary);
        assert_eq!((binary.additions, binary.deletions), (0, 0));
        assert_eq!(binary.old_size, Some(11));
        assert_eq!(binary.new_size, Some(6));
        assert!(!binary.complete || !binary.truncated);

        // 旧 generation：整个读取作废，前端据此丢弃迟到的差异。
        let bumped = backend
            .scheduler
            .bump_generation(&repo_key(&canonical_existing(&repo).unwrap()));
        let stale = load_task_diff(
            &backend, &path, &baseline, &head, "long.txt", None, generation, 6, 0, 0, 3, false,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, "stale");
        assert_eq!(stale.generation, Some(bumped));

        // HEAD 已经不是快照里的 HEAD。
        let moved = load_task_diff(
            &backend, &path, &baseline, &baseline, "long.txt", None, bumped, 7, 0, 0, 3, false,
        )
        .await
        .unwrap_err();
        assert_eq!(moved.code, "task_head_changed");

        // 简称不是完整标识：任务读取要求完整 OID，不猜一个。
        let short = load_task_diff(
            &backend, &path, &baseline, "abc", "long.txt", None, bumped, 8, 0, 0, 3, false,
        )
        .await
        .unwrap_err();
        assert_eq!(short.code, "task_version_unconfirmed");

        // 路径必须留在仓库里。
        let unsafe_path = load_task_diff(
            &backend, &path, &baseline, &head, "../outside.txt", None, bumped, 9, 0, 0, 3, false,
        )
        .await
        .unwrap_err();
        assert_eq!(unsafe_path.code, "invalid_path");
    }

    /// 快照 token 绑定 worktree、起点与该路径的净内容：其他路径变化不影响它。
    #[tokio::test]
    async fn task_review_token_binds_range_and_path() {
        let fixture = crate::test_support::git_fixture("task-token-range");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "a1\n").unwrap();
        fs::write(repo.join("other.txt"), "o1\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let base = git_stdout(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("a.txt"), "a2\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        git(&repo, &["commit", "-m", "commit a"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("a.txt"), "a3\n").unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;

        let first = task_review_token(&backend, &path, &base, &head, "a.txt", generation, 2)
            .await
            .unwrap();
        assert_eq!(first.state, RepositoryReviewState::Current);
        assert_eq!(first.status, "modified");
        assert_eq!(first.baseline_oid, base);
        let token = first.token.clone().expect("confirmed token");
        assert!(first.content_version.unwrap().starts_with("worktree:"));
        assert!(!first.truncated);

        // 其他路径的外部修改不改变这条路径的 token。
        fs::write(repo.join("other.txt"), "o2\n").unwrap();
        let unrelated = task_review_token(&backend, &path, &base, &head, "a.txt", generation, 3)
            .await
            .unwrap();
        assert_eq!(unrelated.token, Some(token.clone()));

        // 同一条路径内容变化：新 token。
        fs::write(repo.join("a.txt"), "a4\n").unwrap();
        let content = task_review_token(&backend, &path, &base, &head, "a.txt", generation, 4)
            .await
            .unwrap();
        assert_ne!(content.token, Some(token.clone()));

        // 起点变化：范围身份不同，token 也不同。
        let from_head = task_review_token(&backend, &path, &head, &head, "a.txt", generation, 5)
            .await
            .unwrap();
        assert_eq!(from_head.state, RepositoryReviewState::Current);
        assert_ne!(from_head.token, Some(token.clone()));

        // 回到起点里的内容：相对这个起点没有净变化，不能标记。
        fs::write(repo.join("a.txt"), "a2\n").unwrap();
        let unchanged = task_review_token(&backend, &path, &head, &head, "a.txt", generation, 6)
            .await
            .unwrap();
        assert_eq!(unchanged.state, RepositoryReviewState::Unchanged);
        assert!(unchanged.token.is_none());

        // 只改暂存状态（内容不变）也要换 token：两侧状态参与绑定。
        fs::write(repo.join("a.txt"), "a5\n").unwrap();
        let before_stage = task_review_token(&backend, &path, &head, &head, "a.txt", generation, 7)
            .await
            .unwrap();
        git(&repo, &["add", "a.txt"]);
        let staged = task_review_token(&backend, &path, &head, &head, "a.txt", generation, 8)
            .await
            .unwrap();
        assert_eq!(staged.state, RepositoryReviewState::Current);
        assert_ne!(staged.token, before_stage.token);

        // 另一条路径有自己的 token。
        let other = task_review_token(&backend, &path, &base, &head, "other.txt", generation, 9)
            .await
            .unwrap();
        assert_eq!(other.state, RepositoryReviewState::Current);
        assert_ne!(other.token, Some(token));
    }

    /// 差异被截断时不产生 token；删除是一份可确认的净状态。
    #[tokio::test]
    async fn task_review_token_refuses_truncated_content() {
        let fixture = crate::test_support::git_fixture("task-token-truncated");
        let backend = fixture.backend_with_limit(700, Vec::new());
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("wide.txt"), "start\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        let changed = format!("{}\n{}\n", "B".repeat(40), "C".repeat(4000));
        fs::write(repo.join("wide.txt"), changed).unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "wide"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        let (path, generation) = open_repo(&backend, &repo).await;

        let truncated = task_review_token(&backend, &path, &baseline, &head, "wide.txt", generation, 2)
            .await
            .unwrap();
        assert!(truncated.truncated);
        assert_eq!(truncated.state, RepositoryReviewState::Unconfirmed);
        assert!(truncated.token.is_none());

        // 净删除是完整可确认的状态：内容版本是 missing。
        fs::remove_file(repo.join("wide.txt")).unwrap();
        let deleted = task_review_token(&backend, &path, &baseline, &head, "wide.txt", generation, 3)
            .await
            .unwrap();
        assert!(!deleted.truncated);
        assert_eq!(deleted.status, "deleted");
        assert_eq!(deleted.state, RepositoryReviewState::Current);
        assert_eq!(deleted.content_version.as_deref(), Some("missing"));
        assert!(deleted.token.is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn task_review_token_does_not_confirm_symlinked_content() {
        let fixture = crate::test_support::git_fixture("task-token-symlink");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("target.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("target.txt"), "two\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "change"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        std::os::unix::fs::symlink(repo.join("target.txt"), repo.join("link.txt")).unwrap();
        let (path, generation) = open_repo(&backend, &repo).await;

        let link = task_review_token(&backend, &path, &baseline, &head, "link.txt", generation, 2)
            .await
            .unwrap();
        assert!(link.token.is_none());
        assert!(matches!(
            link.state,
            RepositoryReviewState::Unconfirmed | RepositoryReviewState::Unchanged
        ));
    }

    /// 同一路径先在提交里被删除、又在工作区以未跟踪文件重建：净结果必须给出工作区内容，
    /// 不能因为路径去重把它丢成 deleted。
    #[tokio::test]
    async fn task_review_keeps_untracked_rebuild_of_deleted_path() {
        let fixture = crate::test_support::git_fixture("task-review-rebuilt");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("rebuilt.txt"), "one\ntwo\n").unwrap();
        fs::write(repo.join("stays.txt"), "stays\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["rm", "-q", "rebuilt.txt"]);
        git(&repo, &["commit", "-m", "delete rebuilt"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        // 工作区里又以未跟踪文件重建同名路径。
        fs::write(
            repo.join("rebuilt.txt"),
            "shadow one\nshadow two\nshadow three\n",
        )
        .unwrap();

        let (path, generation) = open_repo(&backend, &repo).await;
        let task = task_review(&backend, &path, &baseline, generation, 2)
            .await
            .unwrap();

        assert_eq!(task.head_oid, head);
        assert_eq!(task.commit_count, 1);
        assert_eq!(task.untracked_files, 1);
        assert_eq!(task.files_total, 1, "{:?}", task.files.iter().map(|file| (&file.path, &file.status, file.untracked)).collect::<Vec<_>>());
        let rebuilt = file(&task.files, "rebuilt.txt");
        assert!(rebuilt.untracked, "工作区未跟踪重建必须留在净结果里");
        // 起点里本来有这条路径：界面必须标出「工作区重建」，不能暗示成纯新增。
        assert!(rebuilt.rebuilt, "删除后重建必须标记 rebuilt");
        assert_eq!(rebuilt.status, "added");
        assert_eq!((rebuilt.additions, rebuilt.deletions), (Some(3), Some(0)));
        // 与 untrackedFiles 计数、单文件差异同一份事实：不能还报成删除。
        assert!(task.files.iter().all(|entry| entry.status != "deleted"));
        assert_eq!((task.additions, task.deletions), (3, 0));

        let diff = load_task_diff(
            &backend,
            &path,
            &baseline,
            &head,
            "rebuilt.txt",
            None,
            task.generation,
            3,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        let text = diff.text.clone().unwrap_or_default();
        assert!(text.contains("+shadow three"), "{text}");
        assert_eq!((diff.additions, diff.deletions), (3, 0));
    }

    /// 任务读取、单文件差异与快照确认都是只读：HEAD、索引、工作区、引用与 stash 不变。
    #[tokio::test]
    async fn task_reads_do_not_write_head_index_or_worktree() {
        let fixture = crate::test_support::git_fixture("task-readonly");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-m", "commit tracked"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        // HEAD 之后再改一次：读取同时覆盖提交、暂存、未暂存与未跟踪。
        fs::write(repo.join("tracked.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        fs::write(
            repo.join("tracked.txt"),
            "one\ntwo\nthree\nfour\nfive\n",
        )
        .unwrap();
        fs::write(repo.join("untracked.txt"), "untracked\n").unwrap();

        let fingerprint = || {
            (
                git_stdout(&repo, &["rev-parse", "HEAD"]),
                git_bytes(&repo, &["ls-files", "-s"]),
                git_bytes(&repo, &["status", "--porcelain=v1", "-z"]),
                git_stdout(&repo, &["for-each-ref", "--format=%(refname) %(objectname)"]),
                git_stdout(&repo, &["stash", "list"]),
                fs::read_to_string(repo.join("tracked.txt")).unwrap(),
                fs::read_to_string(repo.join("untracked.txt")).unwrap(),
            )
        };

        let (path, generation) = open_repo(&backend, &repo).await;
        let before = fingerprint();
        let task = task_review(&backend, &path, &baseline, generation, 2)
            .await
            .unwrap();
        assert_eq!(task.files_total, 2);
        load_task_diff(
            &backend,
            &path,
            &baseline,
            &head,
            "tracked.txt",
            None,
            task.generation,
            3,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        load_task_diff(
            &backend,
            &path,
            &baseline,
            &head,
            "untracked.txt",
            None,
            task.generation,
            4,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        let token = task_review_token(
            &backend,
            &path,
            &baseline,
            &head,
            "tracked.txt",
            task.generation,
            5,
        )
        .await
        .unwrap();
        assert_eq!(token.state, RepositoryReviewState::Current);
        assert!(token.token.is_some());

        assert_eq!(
            fingerprint(),
            before,
            "任务读取、差异读取与快照确认都不能写 HEAD、索引、工作区、引用或 stash"
        );
    }

    /// UU 冲突：净结果标出这条路径的冲突状态，单文件差异仍可读，读取不写仓库。
    #[tokio::test]
    async fn task_review_reports_unmerged_conflict_without_writing() {
        let fixture = crate::test_support::git_fixture("task-review-conflict");
        let backend = fixture.backend();
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("c.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let baseline = git_stdout(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "-q", "-b", "side"]);
        fs::write(repo.join("c.txt"), "side\n").unwrap();
        git(&repo, &["commit", "-q", "-a", "-m", "side"]);
        git(&repo, &["checkout", "-q", "main"]);
        fs::write(repo.join("c.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-q", "-a", "-m", "main"]);
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]);
        assert_eq!(git_attempt(&repo, &["merge", "side"]), 1, "这里要制造 UU 冲突");
        assert_eq!(
            git_stdout(&repo, &["status", "--porcelain=v1", "--", "c.txt"]),
            "UU c.txt"
        );

        let (path, generation) = open_repo(&backend, &repo).await;
        let before = (
            git_stdout(&repo, &["rev-parse", "HEAD"]),
            git_bytes(&repo, &["ls-files", "-s"]),
            git_bytes(&repo, &["status", "--porcelain=v1", "-z"]),
            fs::read_to_string(repo.join("c.txt")).unwrap(),
        );

        let task = task_review(&backend, &path, &baseline, generation, 2)
            .await
            .unwrap();
        assert!(task.conflicted);
        assert!(task.dirty);
        let conflict = file(&task.files, "c.txt");
        assert!(conflict.unmerged);
        assert_eq!(conflict.status, "unmerged");

        let token = task_review_token(
            &backend,
            &path,
            &baseline,
            &head,
            "c.txt",
            task.generation,
            3,
        )
        .await
        .unwrap();
        assert!(token.unmerged);
        assert_ne!(token.state, RepositoryReviewState::Unchanged);

        let diff = load_task_diff(
            &backend,
            &path,
            &baseline,
            &head,
            "c.txt",
            None,
            task.generation,
            4,
            0,
            0,
            3,
            false,
        )
        .await
        .unwrap();
        assert!(
            !diff.text.clone().unwrap_or_default().is_empty(),
            "冲突路径仍要给出真实差异"
        );

        assert_eq!(
            (
                git_stdout(&repo, &["rev-parse", "HEAD"]),
                git_bytes(&repo, &["ls-files", "-s"]),
                git_bytes(&repo, &["status", "--porcelain=v1", "-z"]),
                fs::read_to_string(repo.join("c.txt")).unwrap(),
            ),
            before,
            "读取冲突状态不解决冲突、不改索引与工作区"
        );
    }
}
