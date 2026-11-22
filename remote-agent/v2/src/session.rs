//! 一个进程持有的远端工作树会话。
//!
//! 数值 generation 来自共享调度器的仓库车道，进程内单调；跨进程的状态证明由
//! `RepoState.token` 承担。差异游标另外记住当前选择，新选择会推进 epoch，让仍在生成的
//! 旧页在返回前被判为 `superseded`，而不是覆盖用户刚切到的文件。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::git::ops::RepoState;
use crate::identity::WorktreeIdentity;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffView {
    Staged,
    Unstaged,
    Task,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Selection {
    pub path: String,
    pub original: Option<String>,
    pub view: DiffView,
}

#[derive(Default)]
pub struct DiffTracker {
    epoch: AtomicU64,
    selection: Mutex<Option<Selection>>,
}

#[derive(Clone)]
pub struct Session {
    pub root: PathBuf,
    /// 规范工作树路径，同时是客户端侧仓库键。
    pub key: String,
    /// common Git dir：跨进程写锁和持久回执都放在这里。
    pub git_dir: PathBuf,
    pub identity: WorktreeIdentity,
    pub baseline: Option<String>,
    state: Arc<Mutex<RepoState>>,
    diff: Arc<DiffTracker>,
}

impl Session {
    pub fn new(
        root: PathBuf,
        key: String,
        git_dir: PathBuf,
        state: RepoState,
        identity: WorktreeIdentity,
        baseline: Option<String>,
    ) -> Self {
        Self {
            root,
            key,
            git_dir,
            identity,
            baseline,
            state: Arc::new(Mutex::new(state)),
            diff: Arc::new(DiffTracker::default()),
        }
    }

    pub fn state(&self) -> RepoState {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn token(&self) -> String {
        self.state().token
    }

    pub fn set_state(&self, state: RepoState) {
        *self.state.lock().unwrap_or_else(|error| error.into_inner()) = state;
    }

    /// 记录当前差异选择。新选择（或首页）推进 epoch，续页沿用原 epoch。
    pub fn begin_diff(&self, selection: Selection, restart: bool) -> u64 {
        let mut current = self
            .diff
            .selection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let changed = restart || current.as_ref() != Some(&selection);
        if changed {
            *current = Some(selection);
            return self.diff.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        }
        self.diff.epoch.load(Ordering::SeqCst)
    }

    /// 返回结果前核对选择没有变化。变化时这一页必须丢弃，由客户端改用新请求。
    pub fn check_epoch(&self, epoch: u64) -> Result<(), AppError> {
        if self.diff.epoch.load(Ordering::SeqCst) == epoch {
            Ok(())
        } else {
            Err(AppError::new(
                "superseded",
                "已切换到新的差异选择，这一页的结果被丢弃。",
            ))
        }
    }
}
