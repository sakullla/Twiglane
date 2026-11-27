//! Classify branch movements using local reflog evidence. The same commit graph
//! can result from a series of local commits or from a single fast-forward.
use super::{confirm_ancestor, is_full_oid, limit_error, resolve_commit, TaskReads};
use crate::error::AppError;
use crate::git::command::{show_current_branch_command, task_scope_command};
use crate::git::ops::{git_failure, Backend};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub(super) struct TaskScope {
    pub diff_base: String,
    pub commits: Vec<String>,
}

struct LocalStep {
    oid: String,
    parent: String,
    merged_parents: Vec<String>,
}

#[derive(Default)]
struct BranchEvents {
    local: HashSet<String>,
    fast_forwards: HashMap<String, String>,
    rebased: bool,
}

fn commit_ids(steps: Vec<LocalStep>) -> impl Iterator<Item = String> {
    steps
        .into_iter()
        .filter(|step| step.merged_parents.is_empty())
        .map(|step| step.oid)
}

struct ScopeReader<'a, 'b> {
    reads: &'a mut TaskReads<'b>,
    git: &'a Path,
    root: &'a Path,
}

impl ScopeReader<'_, '_> {
    async fn read(&mut self, args: &[&str]) -> Result<String, AppError> {
        let command = task_scope_command(self.git, self.root, args);
        let output = self
            .reads
            .step(command, false, None)
            .await
            .map_err(limit_error)?;
        if output.exit_code != 0 {
            return Err(git_failure(
                "task_scope_unconfirmed",
                &output,
                "无法分离本地改动和引入的内容。请核对任务起点与 Git 操作记录。",
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_owned())
    }

    // Apply only the imported delta to the left side of the final diff. In
    // particular, the imported tip may already contain an earlier local commit.
    async fn import(
        &mut self,
        tree: String,
        before: &str,
        after: &str,
    ) -> Result<String, AppError> {
        if before == after {
            return Ok(tree);
        }
        if tree == before {
            return Ok(after.to_owned());
        }
        let result = self
            .read(&[
                "merge-tree",
                "--write-tree",
                "--no-messages",
                &format!("--merge-base={before}"),
                &tree,
                after,
            ])
            .await?;
        if !is_full_oid(&result) {
            return Err(super::version_unconfirmed());
        }
        Ok(result)
    }

    async fn import_side(
        &mut self,
        tree: String,
        first: &str,
        side: &str,
    ) -> Result<String, AppError> {
        let fork = self.read(&["merge-base", first, side]).await?;
        self.import(tree, &fork, side).await
    }

    async fn pending_merge(&mut self, mut tree: String, head: &str) -> Result<String, AppError> {
        let path = self
            .read(&["rev-parse", "--git-path", "MERGE_HEAD"])
            .await?;
        let parents = match tokio::fs::read_to_string(self.root.join(path)).await {
            Ok(parents) => parents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(tree),
            Err(_) => {
                return Err(AppError::new(
                    "task_scope_unconfirmed",
                    "无法读取正在合并的提交。",
                ))
            }
        };
        for side in parents.lines() {
            if !is_full_oid(side) {
                return Err(super::version_unconfirmed());
            }
            tree = self.import_side(tree, head, side).await?;
        }
        Ok(tree)
    }

    async fn local_events(
        &mut self,
        reference: &str,
        baseline: &str,
        replay_target: Option<&str>,
    ) -> Result<BranchEvents, AppError> {
        let mut events = BranchEvents::default();
        let mut fast_forward = None;
        let mut replaying = false;
        let mut skip = 0;
        loop {
            let log = self
                .read(&[
                    "reflog",
                    "show",
                    "--format=%H%x09%gs",
                    "--max-count=128",
                    &format!("--skip={skip}"),
                    reference,
                    "--",
                ])
                .await?;
            if skip == 0 && log.is_empty() && replay_target.is_none() {
                return Err(AppError::new("task_scope_unconfirmed",
                    "缺少当前分支的 Git 操作记录，无法区分本地提交与拉取的提交。可选择当前 HEAD 查看未提交改动。"));
            }
            for entry in log.lines() {
                let Some((oid, subject)) = entry.split_once('\t') else {
                    continue;
                };
                // The next (older) record gives the previous tip even when it
                // lies on the second-parent side of the imported history.
                if let Some(tip) = fast_forward.take() {
                    events
                        .fast_forwards
                        .entry(tip)
                        .or_insert_with(|| oid.to_owned());
                }
                if oid == baseline {
                    return Ok(events);
                }
                let (action, detail) = subject.split_once(": ").unwrap_or((subject, ""));
                if reference == "HEAD" && replay_target.is_none() && action == "checkout" {
                    return Ok(events);
                }
                let integration =
                    action.starts_with("merge ") || action == "pull" || action.starts_with("pull ");
                if integration && detail.starts_with("Fast-forward") {
                    fast_forward = Some(oid.to_owned());
                }
                let replay = (action.starts_with("rebase ") || action.starts_with("pull "))
                    && [
                        " (pick)",
                        " (continue)",
                        " (reword)",
                        " (squash)",
                        " (fixup)",
                    ]
                    .iter()
                    .any(|suffix| action.ends_with(suffix));
                let commit = action == "commit"
                    || action.starts_with("commit (")
                    || action == "cherry-pick"
                    || action == "revert";
                let merge = integration && detail.starts_with("Merge made by ");
                if let Some(target) = replay_target {
                    if action.ends_with(" (finish)") {
                        replaying = detail.strip_prefix("returning to ") == Some(target);
                    } else if action.ends_with(" (start)") || action.ends_with(" (abort)") {
                        replaying = false;
                    }
                }
                if (replay && (replay_target.is_none() || replaying))
                    || (replay_target.is_none() && (commit || merge))
                {
                    events.local.insert(oid.to_owned());
                }
                events.rebased |= action.ends_with(" (finish)");
            }
            let n = log.lines().count();
            if n < 128 {
                return Ok(events);
            }
            skip += n;
        }
    }

    async fn local_steps(
        &mut self,
        base: &str,
        head: &str,
        branch: Option<&str>,
    ) -> Result<Vec<LocalStep>, AppError> {
        if base == head {
            return Ok(Vec::new());
        }
        let reference = branch
            .map(|name| format!("refs/heads/{name}"))
            .unwrap_or_else(|| "HEAD".to_owned());
        let mut events = self.local_events(&reference, base, None).await?;
        if events.rebased && branch.is_some() {
            events.local.extend(
                self.local_events("HEAD", base, Some(&reference))
                    .await?
                    .local,
            );
        }
        if events.local.is_empty() {
            return Ok(Vec::new());
        }
        let graph = self
            .read(&[
                "log",
                "--ancestry-path",
                "--format=%H %P",
                &format!("{base}..{head}"),
                "--",
            ])
            .await?;
        let mut graph: HashMap<_, _> = graph
            .lines()
            .filter_map(|line| line.split_once(' '))
            .collect();
        let mut steps = Vec::new();
        let mut tip = head;
        while let Some(parents) = graph.remove(tip) {
            if let Some(old) = events.fast_forwards.get(tip) {
                tip = old;
                continue;
            }
            let mut parents = parents.split_whitespace();
            let Some(first) = parents.next() else { break };
            if events.local.contains(tip) {
                steps.push(LocalStep {
                    oid: tip.to_owned(),
                    parent: first.to_owned(),
                    merged_parents: parents.map(str::to_owned).collect(),
                });
            }
            tip = first;
        }
        Ok(steps)
    }
}

pub(super) async fn resolve(
    reads: &mut TaskReads<'_>,
    root: &Path,
    git: &Path,
    base: &str,
    head: &str,
    branch: Option<&str>,
) -> Result<TaskScope, AppError> {
    let mut reader = ScopeReader { reads, root, git };
    let steps = reader.local_steps(base, head, branch).await?;
    let mut tree = base.to_owned();
    let mut previous = base;
    for step in steps.iter().rev() {
        let first = &step.parent;
        tree = reader.import(tree, previous, first).await?;
        for side in &step.merged_parents {
            tree = reader.import_side(tree, first, side).await?;
        }
        previous = &step.oid;
    }
    let tree = reader.import(tree, previous, head).await?;
    let diff_base = reader.pending_merge(tree, head).await?;
    let commits = commit_ids(steps).collect();
    Ok(TaskScope { diff_base, commits })
}

pub(in crate::git) async fn history_scope(
    backend: &Backend,
    root: &Path,
    git: &Path,
    base: &str,
    generation: u64,
    request_id: u64,
) -> Result<(String, HashSet<String>, u64), AppError> {
    let mut reads = TaskReads::new(backend, root, generation);
    let branch = reads
        .run(
            request_id,
            show_current_branch_command(git, root),
            false,
            None,
        )
        .await?;
    if branch.exit_code != 0 {
        return Err(git_failure(
            "task_range_failed",
            &branch,
            "无法确定任务分支。",
        ));
    }
    let branch = String::from_utf8_lossy(&branch.stdout);
    let branch = branch.trim();
    let head = resolve_commit(&mut reads, root, git, "HEAD").await?;
    confirm_ancestor(&mut reads, root, git, base, &head).await?;
    let mut reader = ScopeReader {
        reads: &mut reads,
        root,
        git,
    };
    let steps = reader
        .local_steps(base, &head, (!branch.is_empty()).then_some(branch))
        .await?;
    let ids = commit_ids(steps).collect();
    Ok((head, ids, reads.generation))
}
