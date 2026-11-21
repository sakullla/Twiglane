//! v2 服务循环：有界 JSONL 请求分派、多路响应、取消与选择抢占、写入回执。
//!
//! 所有仓库语义都调用共享的 Rust 实现（git::ops、git::changes、git::patch）：本模块只负责
//! 协议、会话身份、跨进程写锁和回执，不重新实现 Git 行为。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Semaphore};

use crate::error::AppError;
use crate::git::changes;
use crate::git::command::common_dir_command;
use crate::git::gate::RepoWriteLock;
use crate::git::heads;
use crate::git::history::{self, HistoryRequest};
use crate::git::ops::{self, Backend, RepoState};
use crate::git::resolve;
use crate::git::sync;
use crate::git::tags;
use crate::git::worktree as worktree_ops;
use crate::git::runner::RealRunner;
use crate::git::schedule::{internal_request_id, JobKind};
use crate::model::DiffLineSelection;
use crate::protocol::{self, Request, CAPABILITIES, MAX_IN_FLIGHT, PROTOCOL};
use crate::receipts::{Receipt, ReceiptStore, COMPLETED, FAILED};
use crate::session::{Selection, Session};
use crate::shutdown::Shutdown;
use crate::state::AppStore;

const AGENT_NAME: &str = "twiglane-agent/2";
const MAX_FIELD: usize = 4096;
const MAX_PATHS: usize = 500;
const DEFAULT_DIFF_LINES: u32 = 200;
const MAX_DIFF_LINES: u32 = 2000;
const MAX_CONTEXT: u32 = 1_000_000;
const WRITE_LOCK_WAIT: Duration = Duration::from_secs(10);
const MESSAGE_LIMIT: usize = 1024 * 1024;

/// 标准输入关闭后等待在途请求收尾的宽限时间。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// 一条在途请求的可取消句柄。
///
/// 只翻转本进程的标记只能让「还没开始执行」的请求停下来；访问远程的请求还要同时停止共享
/// `git::sync` 调度器里那条远程命令（排队中或运行中的子进程），否则 cancel 对已经在传输中的
/// fetch/pull/push 毫无作用。因此句柄一并记下这次请求是否访问远程。
struct InFlight {
    flag: Arc<AtomicBool>,
    remote: bool,
}

pub struct Context {
    backend: Arc<Backend>,
    session: Mutex<Option<Session>>,
    cancels: Mutex<HashMap<String, InFlight>>,
    slots: Arc<Semaphore>,
    out: mpsc::Sender<Vec<u8>>,
}

/// 会启动远程命令的操作：取消时必须交给共享 sync 层的取消通道，而不能只看本地标记。
/// 读类只有 `tagRemoteState` 走 ls-remote，它的取消同样经由同一条远程通道生效。
fn remote_op(op: &str) -> bool {
    matches!(
        op,
        "fetch"
            | "pull"
            | "push"
            | "pushToRemote"
            | "publishBranch"
            | "fetchBranches"
            | "deleteRemoteBranch"
            | "tagPush"
            | "tagRemoteState"
    )
}

/// 写操作分类：请求摘要、回执与执行分支都以它为准。
///
/// 每个写入都自成一类，而不是共用「有 operationId 就算同类」：合并、变基、拣选、回退、
/// 修订撤销、stash 和 worktree 的 Git 原子边界不同，回执必须能区分是哪一个动作停在半途。
#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteOp {
    Stage,
    Unstage,
    Patch,
    Commit,
    BranchCreate,
    BranchSwitch,
    BranchRename,
    BranchDelete,
    BranchTrack,
    BranchUpdate,
    BranchPublish,
    SetUpstream,
    AssociateUpstream,
    TagCreate,
    TagDelete,
    TagPush,
    RemoteAdd,
    RemoteSetUrl,
    Fetch,
    FetchBranches,
    Pull,
    Push,
    PushToRemote,
    PublishBranch,
    DeleteRemoteBranch,
    StashSave,
    StashApply,
    StashDelete,
    MergeStart,
    MergeComplete,
    MergeAbort,
    ResolveConflict,
    CherryPick,
    Revert,
    UndoCommit,
    CheckoutCommit,
    AmendCommit,
    Discard,
    WorktreeRemove,
}

/// 全部写入操作：`parse` 与 `name` 用同一份清单，避免协议名和执行分支各记一份。
const WRITE_OPS: &[WriteOp] = &[
    WriteOp::Stage,
    WriteOp::Unstage,
    WriteOp::Patch,
    WriteOp::Commit,
    WriteOp::BranchCreate,
    WriteOp::BranchSwitch,
    WriteOp::BranchRename,
    WriteOp::BranchDelete,
    WriteOp::BranchTrack,
    WriteOp::BranchUpdate,
    WriteOp::BranchPublish,
    WriteOp::SetUpstream,
    WriteOp::AssociateUpstream,
    WriteOp::TagCreate,
    WriteOp::TagDelete,
    WriteOp::TagPush,
    WriteOp::RemoteAdd,
    WriteOp::RemoteSetUrl,
    WriteOp::Fetch,
    WriteOp::FetchBranches,
    WriteOp::Pull,
    WriteOp::Push,
    WriteOp::PushToRemote,
    WriteOp::PublishBranch,
    WriteOp::DeleteRemoteBranch,
    WriteOp::StashSave,
    WriteOp::StashApply,
    WriteOp::StashDelete,
    WriteOp::MergeStart,
    WriteOp::MergeComplete,
    WriteOp::MergeAbort,
    WriteOp::ResolveConflict,
    WriteOp::CherryPick,
    WriteOp::Revert,
    WriteOp::UndoCommit,
    WriteOp::CheckoutCommit,
    WriteOp::AmendCommit,
    WriteOp::Discard,
    WriteOp::WorktreeRemove,
];

impl WriteOp {
    fn name(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Unstage => "unstage",
            Self::Patch => "patch",
            Self::Commit => "commit",
            Self::BranchCreate => "branchCreate",
            Self::BranchSwitch => "branchSwitch",
            Self::BranchRename => "branchRename",
            Self::BranchDelete => "branchDelete",
            Self::BranchTrack => "branchTrack",
            Self::BranchUpdate => "branchUpdate",
            Self::BranchPublish => "branchPublish",
            Self::SetUpstream => "setUpstream",
            Self::AssociateUpstream => "associateUpstream",
            Self::TagCreate => "tagCreate",
            Self::TagDelete => "tagDelete",
            Self::TagPush => "tagPush",
            Self::RemoteAdd => "remoteAdd",
            Self::RemoteSetUrl => "remoteSetUrl",
            Self::Fetch => "fetch",
            Self::FetchBranches => "fetchBranches",
            Self::Pull => "pull",
            Self::Push => "push",
            Self::PushToRemote => "pushToRemote",
            Self::PublishBranch => "publishBranch",
            Self::DeleteRemoteBranch => "deleteRemoteBranch",
            Self::StashSave => "stashSave",
            Self::StashApply => "stashApply",
            Self::StashDelete => "stashDelete",
            Self::MergeStart => "mergeStart",
            Self::MergeComplete => "mergeComplete",
            Self::MergeAbort => "mergeAbort",
            Self::ResolveConflict => "resolveConflict",
            Self::CherryPick => "cherryPick",
            Self::Revert => "revert",
            Self::UndoCommit => "undoCommit",
            Self::CheckoutCommit => "checkoutCommit",
            Self::AmendCommit => "amendCommit",
            Self::Discard => "discard",
            Self::WorktreeRemove => "worktreeRemove",
        }
    }

    fn parse(op: &str) -> Option<Self> {
        WRITE_OPS.iter().copied().find(|candidate| candidate.name() == op)
    }
}

/// 写入成功后回执需要的分支名：优先用返回 DTO 里的 snapshot.branch.name。
fn written_branch(value: &Value) -> Option<String> {
    value
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("branch"))
        .and_then(|branch| branch.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
}


pub async fn serve() -> Result<(), AppError> {
    let (out, mut outgoing) = mpsc::channel::<Vec<u8>>(MAX_IN_FLIGHT * 4);
    let writer = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = outgoing.recv().await {
            if stdout.write_all(&frame).await.is_err() {
                break;
            }
            if stdout.write_all(b"\n").await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let context = Arc::new(Context {
        backend: Arc::new(build_backend()),
        session: Mutex::new(None),
        cancels: Mutex::new(HashMap::new()),
        slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
        out,
    });

    let (lines, mut incoming) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || read_lines(lines));

    while let Some(line) = incoming.recv().await {
        context.handle_line(&line);
    }
    // 标准输入关闭：等在途请求收尾再结束，不半途丢弃已登记的写入。
    let _ = tokio::time::timeout(
        DRAIN_TIMEOUT,
        context.slots.acquire_many(MAX_IN_FLIGHT as u32),
    )
    .await;
    drop(context);
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, writer).await;
    Ok(())
}

fn read_lines(sender: mpsc::UnboundedSender<Vec<u8>>) {
    use std::io::BufRead;
    let stdin = std::io::stdin();
    let mut handle = stdin.lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        match handle.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {
                while line
                    .last()
                    .is_some_and(|byte| *byte == b'\n' || *byte == b'\r')
                {
                    line.pop();
                }
                if line.is_empty() {
                    continue;
                }
                if sender.send(line.clone()).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn build_backend() -> Backend {
    let store = AppStore::open(state_dir().join("settings.json"));
    let runner = RealRunner::default();
    Backend::new(store, runner, Arc::new(Shutdown::new()))
}

/// agent 自己的状态目录，与 v1 的安装目录和桌面设置互不影响。
fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("twiglane-agent-v2"))
        .join("twiglane")
        .join("agent")
        .join("v2")
}

pub fn host_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|text| text.trim().to_string())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string())
}
impl Context {
    fn handle_line(self: &Arc<Self>, line: &[u8]) {
        match protocol::parse_request(line) {
            Ok(request) => self.dispatch(request),
            Err(rejection) => self.respond(protocol::err_frame(&rejection.id, &rejection.error)),
        }
    }

    fn dispatch(self: &Arc<Self>, request: Request) {
        if request.op == "cancel" {
            let result = self.cancel(&request.fields);
            self.finish(&request.id, result);
            return;
        }
        let permit = match Arc::clone(&self.slots).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.finish(
                    &request.id,
                    Err(AppError::new("remote_busy", "远端请求已满，请稍后重试。")),
                );
                return;
            }
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                request.id.clone(),
                InFlight {
                    flag: Arc::clone(&cancel),
                    remote: remote_op(&request.op),
                },
            );
        let context = Arc::clone(self);
        tokio::spawn(async move {
            let id = request.id.clone();
            let result = context.run(&request, &cancel).await;
            context
                .cancels
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            context.finish(&id, result);
            drop(permit);
        });
    }

    fn finish(&self, id: &str, result: Result<Value, AppError>) {
        let frame = match result {
            Ok(value) => protocol::ok_frame(id, value),
            Err(error) => protocol::err_frame(id, &error),
        };
        self.respond(frame);
    }

    fn respond(&self, frame: Vec<u8>) {
        if self.out.try_send(frame).is_err() {
            eprintln!("twiglane-agent-v2: 响应通道已满或已关闭");
        }
    }
    async fn run(&self, request: &Request, cancel: &AtomicBool) -> Result<Value, AppError> {
        match request.op.as_str() {
            "hello" => self.hello(&request.fields),
            "open" => self.open(&request.fields, cancel).await,
            "status" => self.status(&request.fields, cancel).await,
            "diff" => self.diff(&request.fields, cancel).await,
            // 历史、比较与文件历史：只按页读取当前选择。
            "history" => self.history(&request.fields, cancel).await,
            "fileHistory" => self.file_history(&request.fields, cancel).await,
            "commitDetail" => self.commit_detail(&request.fields, cancel).await,
            "commitDiff" => self.commit_diff(&request.fields, cancel).await,
            "compare" => self.compare(&request.fields, cancel).await,
            // 分支、标签、同步、stash、合并会话与 worktree 的只读入口。
            "branchList" => self.branches(&request.fields, cancel).await,
            "tagState" => self.tag_state(&request.fields, cancel).await,
            "remoteState" => self.remote_state(&request.fields, cancel).await,
            "stashState" => self.stash_state(&request.fields, cancel).await,
            "mergePreview" => self.merge_preview(&request.fields, cancel).await,
            "mergeSession" => self.merge_session(&request.fields, cancel).await,
            "conflictView" => self.conflict_view(&request.fields, cancel).await,
            "worktrees" => self.worktrees(&request.fields, cancel).await,
            // 主窗口已在调用、v2 必须同名可用的只读入口。
            "branchState" => self.branch_state(&request.fields, cancel).await,
            "branchTracking" => self.branch_tracking(&request.fields, cancel).await,
            "tagRemoteState" => self.tag_remote_state(&request.fields, cancel).await,
            "commitBranches" => self.commit_branches(&request.fields, cancel).await,
            "compareFileDiff" => self.compare_file_diff(&request.fields, cancel).await,
            "receipt" => self.receipt(&request.fields),
            other => match WriteOp::parse(other) {
                Some(op) => self.write(op, &request.fields).await,
                None => Err(AppError::new(
                    "unsupported_op",
                    format!("v2 不支持操作 {}。", safe_op(other)),
                )),
            },
        }
    }

    fn hello(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let client = optional_string_field(fields, "client")?.unwrap_or_default();
        Ok(json!({
            "protocol": PROTOCOL,
            "agent": AGENT_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "host": host_name(),
            "client": client,
            "capabilities": CAPABILITIES,
            "receipts": "git-common-dir",
            "generation": "numeric",
            "stateToken": "opaque",
        }))
    }

    async fn open(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        if fields.contains_key("baseline") {
            return Err(AppError::new(
                "unsupported_baseline",
                "v2 的审阅基线在后续任务接入，本版本不接受 baseline。",
            ));
        }
        let path = string_field(fields, "path")?;
        check_cancel(cancel)?;
        let opened = ops::open_repository(&self.backend, &path, internal_request_id()).await?;
        let root = PathBuf::from(&opened.summary.path);
        let state: RepoState =
            ops::state_token(&self.backend, &root, internal_request_id()).await?;
        let git_dir = self.common_dir(&root).await?;
        let session = Session::new(root, opened.summary.path.clone(), git_dir, state.clone());
        *self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(session);
        check_cancel(cancel)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "agent": AGENT_NAME,
            "repo": opened.summary.path,
            "root": opened.summary.path,
            "name": opened.summary.name,
            "host": host_name(),
            "generation": opened.generation,
            "stateToken": state.token,
            "snapshot": opened.snapshot,
            "draft": opened.draft,
            "abbrevLength": opened.abbrev_length,
            // v2 的远端变化事件在后续任务接入；这里如实报告没有实时通知。
            "watchDegraded": true,
            "capabilities": CAPABILITIES,
        }))
    }
    async fn status(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = match optional_u64_field(fields, "generation")? {
            Some(generation) => generation,
            None => self.backend.scheduler.current_generation(&session.key),
        };
        check_cancel(cancel)?;
        let snapshot =
            ops::refresh_status(&self.backend, &session.key, generation, internal_request_id())
                .await?;
        let state: RepoState =
            ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
        session.set_state(state.clone());
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": snapshot.generation,
            "stateToken": state.token,
            "snapshot": snapshot,
        }))
    }
    async fn diff(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let path = string_field(fields, "path")?;
        let original = optional_string_field(fields, "original")?;
        let staged = match string_field(fields, "view")?.as_str() {
            "staged" => true,
            "unstaged" => false,
            _ => {
                return Err(AppError::new(
                    "invalid_view",
                    "差异视图只能是 staged 或 unstaged。",
                ))
            }
        };
        let offset = optional_u64_field(fields, "offset")?.unwrap_or(0) as u32;
        let limit = optional_u64_field(fields, "limit")?
            .map(|limit| (limit as u32).clamp(1, MAX_DIFF_LINES))
            .unwrap_or(DEFAULT_DIFF_LINES);
        let context = optional_u64_field(fields, "context")?
            .map(|context| (context as u32).min(MAX_CONTEXT))
            .unwrap_or(3);
        let selection = Selection {
            path: path.clone(),
            original: original.clone(),
            staged,
        };
        let epoch = session.begin_diff(selection, offset == 0);
        if let Some(cursor) = optional_string_field(fields, "cursor")? {
            Cursor::decode(&cursor)?.check(
                &session,
                &path,
                original.as_deref(),
                staged,
                limit,
                offset,
            )?;
        }
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let diff = changes::load_diff_with_context(
            &self.backend,
            &session.key,
            &path,
            original.as_deref(),
            staged,
            generation,
            internal_request_id(),
            offset,
            limit,
            context,
            false,
        )
        .await?;
        session.check_epoch(epoch)?;
        check_cancel(cancel)?;
        let consumed = diff.offset + diff.lines.len() as u32;
        let token = session.token();
        let next = (consumed < diff.total_lines).then(|| {
            Cursor(CursorBody {
                repo: session.key.clone(),
                token: token.clone(),
                path: path.clone(),
                original: original.clone(),
                staged,
                limit,
                offset: consumed,
            })
            .encode()
        });
        Ok(json!({
            "repo": session.key,
            "path": diff.path,
            "staged": staged,
            "generation": diff.generation,
            "stateToken": token,
            "nextCursor": next,
            "diff": diff,
        }))
    }
    /// 历史与搜索：按 offset 分页读取当前范围，只返回这一页和是否还有下一页。
    async fn history(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let request = history_request(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let page = history::history_page(
            &self.backend,
            &session.key,
            &request,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        let next = page
            .has_more
            .then(|| page.offset + page.commits.len() as u32);
        Ok(json!({
            "repo": session.key,
            "page": page,
            "nextOffset": next,
            "generation": page.generation,
        }))
    }

    /// 单个文件的历史：同一个分页与过滤条件，只把范围限制在一条路径上。
    async fn file_history(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let relative = string_field(fields, "path")?;
        let request = history_request(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let page = history::file_history(
            &self.backend,
            &session.key,
            &relative,
            &request,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        let next = page
            .has_more
            .then(|| page.offset + page.commits.len() as u32);
        Ok(json!({
            "repo": session.key,
            "path": relative,
            "page": page,
            "nextOffset": next,
            "generation": page.generation,
        }))
    }

    async fn commit_detail(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let oid = string_field(fields, "oid")?;
        let parent = optional_text_field(fields, "parent")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let detail = history::commit_detail(
            &self.backend,
            &session.key,
            &oid,
            parent.as_deref(),
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "commit": detail,
            "generation": detail.generation,
        }))
    }

    /// 某个提交里一个文件的分页差异；limit 与 diff 使用同一默认值和上限。
    async fn commit_diff(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let oid = string_field(fields, "oid")?;
        let parent = optional_text_field(fields, "parent")?;
        let relative = string_field(fields, "path")?;
        let offset = optional_u64_field(fields, "offset")?.unwrap_or(0) as u32;
        let limit = optional_u64_field(fields, "limit")?
            .map(|limit| (limit as u32).clamp(1, MAX_DIFF_LINES))
            .unwrap_or(DEFAULT_DIFF_LINES);
        let context = optional_u64_field(fields, "context")?
            .map(|context| (context as u32).min(MAX_CONTEXT))
            .unwrap_or(3);
        let as_text = bool_field(fields, "asText");
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let diff = history::commit_file_diff(
            &self.backend,
            &session.key,
            &oid,
            parent.as_deref(),
            &relative,
            generation,
            internal_request_id(),
            offset,
            limit,
            context,
            as_text,
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "path": relative,
            "diff": diff,
            "generation": diff.generation,
        }))
    }

    /// 两个提交之间改动的文件清单（base 缺省表示与工作树比较）。
    async fn compare(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let head = string_field(fields, "head")?;
        let base = optional_text_field(fields, "base")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let files = history::compare_files(
            &self.backend,
            &session.key,
            base.as_deref(),
            &head,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "base": base,
            "head": head,
            "compare": files,
        }))
    }

    async fn branches(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let listing = sync::branch_list(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "branches": listing }))
    }

    async fn tag_state(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let state = tags::tag_state(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "tags": state }))
    }

    async fn remote_state(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let state = sync::remote_state(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "remote": state }))
    }

    async fn stash_state(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let include_untracked = field(fields, "includeUntracked")
            .map(|value| value.as_bool().unwrap_or(true))
            .unwrap_or(true);
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let state = history::stash_state(
            &self.backend,
            &session.key,
            include_untracked,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "stash": state }))
    }

    /// 合并预览：只读，供危险操作确认界面显示将要发生的变化。
    async fn merge_preview(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let source = string_field(fields, "source")?;
        let target = optional_text_field(fields, "target")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let preview = resolve::merge_preview(
            &self.backend,
            &session.key,
            &source,
            target.as_deref(),
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "preview": preview }))
    }

    async fn merge_session(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let merge = resolve::merge_session(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "merge": merge }))
    }

    async fn conflict_view(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let relative = string_field(fields, "path")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let view = resolve::conflict_view(
            &self.backend,
            &session.key,
            &relative,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "conflict": view }))
    }

    /// worktree 总览：默认只看当前仓库；显式 paths 时按给定顺序逐项读取。
    async fn worktrees(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let paths = match field(fields, "paths") {
            Some(_) => paths_field(fields)?,
            None => vec![session.key.clone()],
        };
        check_cancel(cancel)?;
        let overview = heads::worktree_overview(&self.backend, &paths, internal_request_id()).await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "worktrees": overview }))
    }

    /// 分支跟踪：领先/落后与 gone 由共享实现读取，客户端不能从 BranchListing 推出来。
    async fn branch_tracking(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let tracking = sync::branch_tracking(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "branchTracking": tracking }))
    }

    /// 分支总览：分支列表与当前状态快照一次返回，等价于桌面端的 `branch_state`。
    async fn branch_state(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let state = sync::branch_state(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "branchState": state }))
    }

    /// 远端标签：ls-remote 的结果，供标签界面对照本地标签。
    async fn tag_remote_state(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let remote = string_field(fields, "remote")?;
        check_cancel(cancel)?;
        let tags = tags::tag_remote_state(&self.backend, &session.key, &remote).await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "remote": remote, "tagRemoteState": tags }))
    }

    /// 含某个提交的所有分支。
    async fn commit_branches(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let oid = string_field(fields, "oid")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let branches = history::commit_branches(
            &self.backend,
            &session.key,
            &oid,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "oid": oid, "commitBranches": branches }))
    }

    /// 任意 base..head 之间一个文件的差异：`commitDiff` 只能到父提交，`compare` 只回文件清单，
    /// 比较视图与合并审阅需要这个入口。base 为空串时按空树比较，与桌面命令层一致。
    async fn compare_file_diff(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let base = optional_text_field(fields, "base")?.unwrap_or_default();
        let head = string_field(fields, "head")?;
        let relative = string_field(fields, "path")?;
        let offset = optional_u64_field(fields, "offset")?.unwrap_or(0) as u32;
        let limit = optional_u64_field(fields, "limit")?
            .map(|limit| (limit as u32).min(MAX_DIFF_LINES))
            .unwrap_or(0);
        let context = optional_u64_field(fields, "context")?
            .map(|context| (context as u32).min(MAX_CONTEXT))
            .unwrap_or(3);
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let diff = history::compare_file_diff(
            &self.backend,
            &session.key,
            &base,
            &head,
            &relative,
            generation,
            internal_request_id(),
            offset,
            limit,
            context,
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "path": relative,
            "base": base,
            "head": head,
            "generation": diff.generation,
            "compareFileDiff": diff,
        }))
    }

    /// 一次写入的完整顺序：跨进程写锁 → 回执查重 → 令牌核对 → 登记 registered →
    /// 执行共享写入 → 取得新状态 → 改为 completed。
    ///
    /// 回执查重与登记都在写锁临界区内完成：两个客户端用同一个 operationId 并发提交时，
    /// 只有拿到锁的一方看到「没有记录」并登记，另一方必然看到 registered/completed。
    /// 回执文件存在但读不出来时直接报 receipt_unreadable，不按「没写过」重新执行。
    async fn write(&self, op: WriteOp, fields: &Map<String, Value>) -> Result<Value, AppError> {
        // worktreeRemove 只接受声明的字段。客户端若按本地命令的习惯多带一个 path 之类的字段，
        // 必须被明确拒绝：静默忽略后按「当前打开的工作树」删除，会删掉另一棵工作区。
        if op == WriteOp::WorktreeRemove {
            reject_undeclared(
                fields,
                &["repo", "operationId", "stateToken", "force"],
                "worktreeRemove",
            )?;
        }
        let session = self.session(fields)?;
        let operation_id = string_field(fields, "operationId")?;
        if !protocol::token(&operation_id) || operation_id.len() < 8 {
            return Err(AppError::new(
                "invalid_operation",
                "操作 ID 无效，未写入仓库。",
            ));
        }
        let request_digest = request_digest(op, fields);
        let expected = string_field(fields, "stateToken")?;
        // 跨进程写锁：同一 common Git dir 在任一时刻只有一个 agent 在写。
        let lock = {
            let git_dir = session.git_dir.clone();
            tokio::task::spawn_blocking(move || RepoWriteLock::acquire(&git_dir, WRITE_LOCK_WAIT))
                .await
                .map_err(|_| {
                    AppError::new("write_lock_unavailable", "写入锁已中断，未写入仓库。")
                })??
        };
        let store = ReceiptStore::new(&session.git_dir);
        if let Some(existing) = store.read(&operation_id)? {
            if existing.request_digest != request_digest || existing.op != op.name() {
                return Err(AppError::new(
                    "operation_conflict",
                    "该操作 ID 已用于另一个请求，未再次写入。",
                ));
            }
            return match existing.state.as_str() {
                // 重放只回原回执：v2 不保存上次的结果 DTO，客户端应按回执里的 head/branch
                // 重新读取一次状态，而不是复用一条没有结果的响应。
                COMPLETED => Ok(json!({
                    "receipt": existing,
                    "replayed": true,
                    "result": Value::Null,
                    "reconcile": "reread",
                })),
                FAILED => Err(AppError::new(
                    existing.reason.clone().unwrap_or_else(|| "failed".to_string()),
                    "该操作此前已明确失败，未再次写入。",
                )),
                _ => Err(AppError::new(
                    "operation_pending",
                    "该操作的结果尚未确认，请先用 receipt 核对。",
                )),
            };
        }
        // 拿到锁之后再核对令牌：排队期间仓库可能已被另一个进程改过。
        let guarded: RepoState =
            ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        if guarded.token != expected {
            let receipt = Receipt::registered(
                &operation_id,
                &session.key,
                op.name(),
                &request_digest,
                guarded.head,
                generation,
            );
            store.fail(receipt, "state_mismatch")?;
            return Err(AppError::new(
                "state_mismatch",
                "仓库状态在读取之后已经变化，未写入。请刷新后重试。",
            ));
        }

        let receipt = Receipt::registered(
            &operation_id,
            &session.key,
            op.name(),
            &request_digest,
            guarded.head,
            generation,
        );
        store.write(&receipt)?;

        let (key, value) = match self.execute(op, fields, &session, generation).await {
            Ok(written) => written,
            Err(error) => {
                if remote_write_unconfirmed(op, &error) {
                    // 取消、超时、网络中断：远端可能已经收到这次请求，按「结果未知」登记，
                    // 客户端据此核对而不是当成失败重发。
                    store.pending(receipt, &error.code)?;
                } else {
                    store.fail(receipt, &error.code)?;
                }
                return Err(error);
            }
        };
        // 写后一次返回新状态：令牌、generation 与具体结果一起回，客户端不需要再补一次 status。
        //
        // 读不到新状态不等于写入失败：worktreeRemove 删掉的正是被读取的那个工作区。
        // 这种情况仍然如实登记为 completed，只是不附令牌，由客户端重新打开仓库。
        let state = ops::state_token(&self.backend, &session.root, internal_request_id())
            .await
            .ok();
        if let Some(state) = state.as_ref() {
            session.set_state(state.clone());
        }
        let generation = self.backend.scheduler.current_generation(&session.key);
        let branch = written_branch(&value);
        let receipt = store.complete(
            receipt,
            state.as_ref().and_then(|state| state.head.clone()),
            branch,
            generation,
        )?;
        let token = state.map(|state| state.token);
        drop(lock);
        let mut body = json!({
            "repo": session.key,
            "generation": generation,
            "receipt": receipt,
        });
        if let Value::Object(map) = &mut body {
            map.insert(key, value);
            if let Some(token) = token {
                map.insert("stateToken".into(), Value::String(token));
            }
        }
        Ok(body)
    }

    /// 执行共享写入。返回 (结果字段名, 结果 DTO)：字段名让响应保持与本地同名，
    /// 客户端不需要为远端另写一套解析。
    async fn execute(
        &self,
        op: WriteOp,
        fields: &Map<String, Value>,
        session: &Session,
        generation: u64,
    ) -> Result<(String, Value), AppError> {
        let backend = &self.backend;
        let path = session.key.as_str();
        let request_id = internal_request_id();
        match op {
            WriteOp::Stage => {
                let paths = paths_field(fields)?;
                let snapshot = changes::stage_files(backend, path, &paths, generation, request_id)
                    .await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::Unstage => {
                let paths = paths_field(fields)?;
                let snapshot = changes::unstage_files(backend, path, &paths, generation, request_id)
                    .await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::Patch => {
                let path_relative = string_field(fields, "path")?;
                let original = optional_text_field(fields, "original")?;
                let staged = bool_field(fields, "staged");
                let snapshot_token = string_field(fields, "snapshot")?;
                let hunks = optional_u32_list(fields, "hunks")?;
                let lines = optional_lines(fields)?;
                let snapshot = match (hunks, lines) {
                    (Some(hunks), None) if !hunks.is_empty() => {
                        changes::stage_hunks(
                            backend,
                            path,
                            &path_relative,
                            original.as_deref(),
                            staged,
                            &hunks,
                            &snapshot_token,
                            generation,
                            request_id,
                        )
                        .await?
                    }
                    (None, Some(lines)) if !lines.is_empty() => {
                        changes::stage_lines(
                            backend,
                            path,
                            &path_relative,
                            original.as_deref(),
                            staged,
                            &lines,
                            &snapshot_token,
                            generation,
                            request_id,
                        )
                        .await?
                    }
                    _ => {
                        return Err(AppError::new(
                            "invalid_patch",
                            "按块或按行写入必须且只能给出一组选择。",
                        ));
                    }
                };
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::Commit => {
                let message = string_field(fields, "message")?;
                if message.len() > MESSAGE_LIMIT {
                    return Err(AppError::new(
                        "message_too_large",
                        "提交说明过长，未创建提交。",
                    ));
                }
                let result =
                    changes::commit_index(backend, path, &message, generation, request_id).await?;
                Ok(("commit".to_string(), to_value(result)?))
            }
            WriteOp::BranchCreate => {
                let name = string_field(fields, "name")?;
                let start = optional_text_field(fields, "start")?.filter(|value| !value.is_empty());
                let checkout = bool_field(fields, "checkout");
                let state = match start {
                    Some(start) => {
                        sync::create_branch_from(
                            backend,
                            path,
                            &name,
                            &start,
                            checkout,
                            generation,
                            request_id,
                        )
                        .await?
                    }
                    None => {
                        sync::create_branch(backend, path, &name, generation, request_id).await?
                    }
                };
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::BranchSwitch => {
                let name = string_field(fields, "name")?;
                let state =
                    sync::switch_branch(backend, path, &name, generation, request_id).await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::BranchRename => {
                let old = string_field(fields, "old")?;
                let new = string_field(fields, "new")?;
                let state =
                    sync::rename_branch(backend, path, &old, &new, generation, request_id).await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::BranchDelete => {
                let name = string_field(fields, "name")?;
                let confirm_unmerged = bool_field(fields, "confirmUnmerged");
                let state = sync::delete_branch(
                    backend,
                    path,
                    &name,
                    confirm_unmerged,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::BranchTrack => {
                let remote_branch = string_field(fields, "remoteBranch")?;
                let local = string_field(fields, "name")?;
                let state = sync::track_remote_as(
                    backend,
                    path,
                    &remote_branch,
                    &local,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::BranchUpdate => {
                let name = string_field(fields, "name")?;
                let state =
                    sync::update_branch(backend, path, &name, generation, request_id).await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::BranchPublish => {
                let name = string_field(fields, "name")?;
                let state =
                    sync::push_local_branch(backend, path, &name, generation, request_id).await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::SetUpstream => {
                let upstream = string_field(fields, "upstream")?;
                let state =
                    sync::set_upstream(backend, path, &upstream, generation, request_id).await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::AssociateUpstream => {
                // 桌面端的「关联上游」会带空远程名，交给共享实现按当前分支决定，这里不拒绝空串。
                let remote = optional_text_field(fields, "remote")?.unwrap_or_default();
                let snapshot =
                    sync::associate_upstream(backend, path, &remote, generation, request_id)
                        .await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::TagCreate => {
                let name = string_field(fields, "name")?;
                let target = string_field(fields, "target")?;
                let message = optional_text_field(fields, "message")?.unwrap_or_default();
                let state = tags::create_tag(
                    backend,
                    path,
                    &name,
                    &target,
                    &message,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("tags".to_string(), to_value(state)?))
            }
            WriteOp::TagDelete => {
                let name = string_field(fields, "name")?;
                let confirm = bool_field(fields, "confirm");
                let state = tags::delete_tag(
                    backend,
                    path,
                    &name,
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("tags".to_string(), to_value(state)?))
            }
            WriteOp::TagPush => {
                let remote = string_field(fields, "remote")?;
                let name = string_field(fields, "name")?;
                let state = tags::push_tag(
                    backend,
                    path,
                    &remote,
                    &name,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("tags".to_string(), to_value(state)?))
            }
            WriteOp::RemoteAdd => {
                let name = string_field(fields, "name")?;
                let url = string_field(fields, "url")?;
                let state = sync::add_remote(
                    backend,
                    path,
                    &name,
                    &url,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("remote".to_string(), to_value(state)?))
            }
            WriteOp::RemoteSetUrl => {
                let name = string_field(fields, "name")?;
                let url = string_field(fields, "url")?;
                let state = sync::set_remote_url(
                    backend,
                    path,
                    &name,
                    &url,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("remote".to_string(), to_value(state)?))
            }
            WriteOp::Fetch => {
                let snapshot =
                    sync::fetch_remote(backend, path, generation, request_id).await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::FetchBranches => {
                let state =
                    sync::fetch_branches(backend, path, generation, request_id).await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::Pull => {
                let snapshot =
                    sync::pull_fast_forward(backend, path, generation, request_id).await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::Push => {
                let snapshot = sync::push_branch(backend, path, generation, request_id).await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::PushToRemote => {
                let remote = string_field(fields, "remote")?;
                let snapshot =
                    sync::push_to_remote(backend, path, &remote, generation, request_id).await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::PublishBranch => {
                let remote = string_field(fields, "remote")?;
                let snapshot =
                    sync::publish_branch(backend, path, &remote, generation, request_id).await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::DeleteRemoteBranch => {
                let remote = string_field(fields, "remote")?;
                let name = string_field(fields, "name")?;
                let confirm = bool_field(fields, "confirm");
                let state = sync::delete_remote_branch(
                    backend,
                    path,
                    &remote,
                    &name,
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("branches".to_string(), to_value(state)?))
            }
            WriteOp::StashSave => {
                let include_untracked = field(fields, "includeUntracked")
                    .map(|value| value.as_bool().unwrap_or(true))
                    .unwrap_or(true);
                let message = optional_text_field(fields, "message")?.unwrap_or_default();
                let result = history::save_stash(
                    backend,
                    path,
                    include_untracked,
                    &message,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("stash".to_string(), to_value(result)?))
            }
            WriteOp::StashApply => {
                let oid = string_field(fields, "oid")?;
                let result =
                    history::apply_stash(backend, path, &oid, generation, request_id).await?;
                Ok(("stash".to_string(), to_value(result)?))
            }
            WriteOp::StashDelete => {
                let oid = string_field(fields, "oid")?;
                let confirm = bool_field(fields, "confirm");
                let state = history::delete_stash(
                    backend,
                    path,
                    &oid,
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("stash".to_string(), to_value(state)?))
            }
            WriteOp::MergeStart => {
                let source = string_field(fields, "source")?;
                let target = optional_text_field(fields, "target")?;
                let mode = optional_text_field(fields, "mode")?;
                let session_state = resolve::start_merge(
                    backend,
                    path,
                    &source,
                    target.as_deref(),
                    mode.as_deref(),
                    generation,
                    request_id,
                )
                .await?;
                Ok(("merge".to_string(), to_value(session_state)?))
            }
            WriteOp::MergeComplete => {
                let message = optional_text_field(fields, "message")?.unwrap_or_default();
                let result = resolve::complete_merge(
                    backend,
                    path,
                    &message,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("merge".to_string(), to_value(result)?))
            }
            WriteOp::MergeAbort => {
                let confirm = bool_field(fields, "confirm");
                let impact =
                    resolve::abort_merge(backend, path, confirm, generation, request_id).await?;
                Ok(("merge".to_string(), to_value(impact)?))
            }
            WriteOp::ResolveConflict => {
                let relative = string_field(fields, "path")?;
                let choice = string_field(fields, "choice")?;
                let content = optional_text_field(fields, "content")?;
                let session_state = resolve::resolve_conflict(
                    backend,
                    path,
                    &relative,
                    &choice,
                    content,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("merge".to_string(), to_value(session_state)?))
            }
            WriteOp::CherryPick => {
                let oids = string_list_field(fields, "oids")?;
                let result = resolve::cherry_pick_commits(
                    backend,
                    path,
                    &oids,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("cherryPick".to_string(), to_value(result)?))
            }
            WriteOp::Revert => {
                let oids = string_list_field(fields, "oids")?;
                let expected_head = string_field(fields, "expectedHead")?;
                let confirm = bool_field(fields, "confirm");
                let result = resolve::revert_commits(
                    backend,
                    path,
                    &oids,
                    &expected_head,
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("revert".to_string(), to_value(result)?))
            }
            WriteOp::UndoCommit => {
                let expected_head = string_field(fields, "expectedHead")?;
                let confirm = bool_field(fields, "confirm");
                let result = resolve::undo_commit(
                    backend,
                    path,
                    &expected_head,
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("undo".to_string(), to_value(result)?))
            }
            WriteOp::CheckoutCommit => {
                let oid = string_field(fields, "oid")?;
                let snapshot =
                    resolve::checkout_commit(backend, path, &oid, generation, request_id).await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::AmendCommit => {
                let expected_head = string_field(fields, "expectedHead")?;
                let message = optional_text_field(fields, "message")?;
                let include_staged = field(fields, "includeStaged")
                    .map(|value| value.as_bool().unwrap_or(true))
                    .unwrap_or(true);
                let staged_token = optional_text_field(fields, "stagedToken")?;
                let confirm = bool_field(fields, "confirm");
                let outcome = resolve::amend_commit(
                    backend,
                    path,
                    &expected_head,
                    message.as_deref(),
                    include_staged,
                    staged_token.as_deref(),
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("amend".to_string(), to_value(outcome)?))
            }
            WriteOp::Discard => {
                let paths = paths_field(fields)?;
                let confirm = bool_field(fields, "confirm");
                let result = resolve::discard_changes(
                    backend,
                    path,
                    &paths,
                    confirm,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("discard".to_string(), to_value(result)?))
            }
            WriteOp::WorktreeRemove => {
                let force = bool_field(fields, "force");
                let recent =
                    worktree_ops::remove_worktree(backend, path, force, request_id).await?;
                Ok(("recent".to_string(), to_value(recent)?))
            }
        }
    }

    fn receipt(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let operation_id = string_field(fields, "operationId")?;
        let store = ReceiptStore::new(&session.git_dir);
        // 回执文件存在但读不出来时不能回答「没有记录」：那会让客户端以为可以重发。
        match store.read(&operation_id)? {
            Some(receipt) if receipt.repo == session.key => Ok(json!({
                "receipt": receipt,
                "operationId": operation_id,
                "repo": session.key,
            })),
            Some(_) => Err(AppError::new(
                "receipt_conflict",
                "该操作 ID 属于另一个仓库，未匹配。",
            )),
            None => Ok(json!({
                "receipt": Value::Null,
                "state": "unknown",
                "reason": "not_recorded",
                "operationId": operation_id,
                "repo": session.key,
            })),
        }
    }

    /// 取消一条在途请求。
    ///
    /// 两条路一起走：本进程标记让尚未进入共享实现的请求立即停下；访问远程的请求还要停掉共享
    /// sync 层那条远程命令（等价于桌面端的 `cancel_remote`）。远程可能已经收到部分请求，因此
    /// 这里的回答只说明「已停止等待」，不表示远端没有变化，结果以刷新后的状态为准。
    fn cancel(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let target = string_field(fields, "targetId")?;
        let entry = self
            .cancels
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&target)
            .map(|entry| (Arc::clone(&entry.flag), entry.remote));
        match entry {
            Some((flag, remote)) => {
                flag.store(true, Ordering::SeqCst);
                let remote_stopped = if remote { self.stop_remote() } else { false };
                Ok(json!({
                    "targetId": target,
                    "cancelled": true,
                    "remoteStopped": remote_stopped,
                }))
            }
            None => Ok(json!({ "targetId": target, "cancelled": false })),
        }
    }

    /// 停止当前仓库正在运行或排队中的远程命令；没有打开仓库时只翻标记。
    fn stop_remote(&self) -> bool {
        let key = self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|session| session.key.clone());
        match key {
            Some(key) => sync::cancel_remote(&self.backend, &key).is_ok(),
            None => false,
        }
    }

    fn session(&self, fields: &Map<String, Value>) -> Result<Session, AppError> {
        let repo = string_field(fields, "repo")?;
        let slot = self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let session = slot
            .clone()
            .ok_or_else(|| AppError::new("no_repository", "还没有打开远端工作树，请先 open。"))?;
        if session.key != repo {
            return Err(AppError::new(
                "unknown_repo",
                "请求指向的仓库不是当前打开的工作树。",
            ));
        }
        Ok(session)
    }

    async fn common_dir(&self, root: &Path) -> Result<PathBuf, AppError> {
        let git = ops::require_git(&self.backend).await?;
        let (program, args) = common_dir_command(&git.path, root);
        let output = ops::run_git(
            &self.backend,
            &ops::repo_key(root),
            JobKind::Read,
            internal_request_id(),
            program,
            args,
            None,
        )
        .await?;
        if output.output.exit_code != 0 {
            return Err(AppError::new(
                "not_repository",
                "无法定位 Git 目录，未打开仓库。",
            ));
        }
        let raw = String::from_utf8_lossy(&output.output.stdout)
            .trim()
            .to_string();
        let path = PathBuf::from(&raw);
        Ok(if path.is_absolute() { path } else { root.join(path) })
    }
}
/// 一次性差异游标：绑定仓库、状态令牌、查询与下一页偏移。
#[derive(Serialize, Deserialize)]
struct CursorBody {
    repo: String,
    token: String,
    path: String,
    original: Option<String>,
    staged: bool,
    limit: u32,
    offset: u32,
}

struct Cursor(CursorBody);

impl Cursor {
    fn encode(&self) -> String {
        let bytes = serde_json::to_vec(&self.0).unwrap_or_default();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decode(raw: &str) -> Result<Self, AppError> {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw.as_bytes())
            .map_err(|_| AppError::new("cursor_expired", "差异游标无效，请重新读取第一页。"))?;
        let body: CursorBody = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::new("cursor_expired", "差异游标无效，请重新读取第一页。"))?;
        Ok(Self(body))
    }

    fn check(
        &self,
        session: &Session,
        path: &str,
        original: Option<&str>,
        staged: bool,
        limit: u32,
        offset: u32,
    ) -> Result<(), AppError> {
        let same = self.0.repo == session.key
            && self.0.path == path
            && self.0.original.as_deref() == original
            && self.0.staged == staged
            && self.0.limit == limit
            && self.0.offset == offset
            && self.0.token == session.token();
        if same {
            Ok(())
        } else {
            Err(AppError::new(
                "cursor_expired",
                "差异游标绑定的仓库、状态或选择已经变化，请重新读取第一页。",
            ))
        }
    }
}

fn request_digest(op: WriteOp, fields: &Map<String, Value>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"twiglane-agent-v2/write\0");
    hasher.update(op.name().as_bytes());
    hasher.update([0]);
    // serde_json 的 Map 默认按 key 排序，同一个请求得到同一个摘要。
    if let Ok(bytes) = serde_json::to_vec(fields) {
        hasher.update(bytes);
    }
    let digest = hasher.finalize();
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// 只接受声明过的字段：多带一个字段说明客户端按本地命令的形状在调用，
/// 静默忽略可能让它以为某个字段生效了（例如 worktreeRemove 带 path）。
fn reject_undeclared(
    fields: &Map<String, Value>,
    allowed: &[&str],
    op: &str,
) -> Result<(), AppError> {
    for key in fields.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(AppError::new(
                "invalid_request",
                format!("{op} 不接受字段 {key}，未写入仓库。"),
            ));
        }
    }
    Ok(())
}

/// 远程写入在取消、超时、网络中断时结果未知：远端可能已经收到请求。
/// 这类错误不能记成 failed，否则客户端会把一次可能成功的写入当成可重发。
fn remote_write_unconfirmed(op: WriteOp, error: &AppError) -> bool {
    matches!(
        op,
        WriteOp::Fetch
            | WriteOp::FetchBranches
            | WriteOp::Pull
            | WriteOp::Push
            | WriteOp::PushToRemote
            | WriteOp::PublishBranch
            | WriteOp::DeleteRemoteBranch
            | WriteOp::TagPush
    ) && matches!(error.code.as_str(), "cancelled" | "timeout" | "network")
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::SeqCst) {
        Err(AppError::new("cancelled", "请求已取消，未继续。"))
    } else {
        Ok(())
    }
}

fn safe_op(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(80)
        .collect()
}
fn paths_field(fields: &Map<String, Value>) -> Result<Vec<String>, AppError> {
    let Some(value) = field(fields, "paths") else {
        return Err(AppError::new("invalid_request", "缺少字段 paths。"));
    };
    let Value::Array(items) = value else {
        return Err(AppError::new("invalid_request", "字段 paths 必须是数组。"));
    };
    if items.is_empty() || items.len() > MAX_PATHS {
        return Err(AppError::new(
            "invalid_request",
            format!("paths 必须是 1–{MAX_PATHS} 个路径。"),
        ));
    }
    let mut paths = Vec::with_capacity(items.len());
    for item in items {
        let text = item
            .as_str()
            .ok_or_else(|| AppError::new("invalid_request", "paths 只能包含字符串。"))?;
        if text.is_empty() || text.len() > MAX_FIELD || text.contains('\0') {
            return Err(AppError::new("invalid_request", "paths 中存在无效路径。"));
        }
        paths.push(text.to_string());
    }
    Ok(paths)
}

fn optional_u32_list(fields: &Map<String, Value>, key: &str) -> Result<Option<Vec<u32>>, AppError> {
    let Some(value) = field(fields, key) else {
        return Ok(None);
    };
    let Value::Array(items) = value else {
        return Err(AppError::new(
            "invalid_request",
            format!("字段 {key} 必须是数组。"),
        ));
    };
    let mut values = Vec::with_capacity(items.len());
    for item in items {
        let number = item.as_u64().ok_or_else(|| {
            AppError::new(
                "invalid_request",
                format!("字段 {key} 只能包含非负整数。"),
            )
        })?;
        values.push(number as u32);
    }
    Ok(Some(values))
}

fn optional_lines(
    fields: &Map<String, Value>,
) -> Result<Option<Vec<DiffLineSelection>>, AppError> {
    let Some(value) = field(fields, "lines") else {
        return Ok(None);
    };
    let lines: Vec<DiffLineSelection> = serde_json::from_value(value.clone())
        .map_err(|_| AppError::new("invalid_request", "字段 lines 不是有效的行选择。"))?;
    Ok(Some(lines))
}
/// 可缺省且允许空串的文本字段：搜索词、提交说明、rebase 基底等都可能被清空。
fn optional_text_field(
    fields: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, AppError> {
    match field(fields, key) {
        None => Ok(None),
        Some(value) => {
            let text = value.as_str().ok_or_else(|| {
                AppError::new(
                    "invalid_request",
                    format!("字段 {key} 必须是字符串。"),
                )
            })?;
            if text.len() > MAX_FIELD || text.contains('\0') {
                return Err(AppError::new(
                    "invalid_request",
                    format!("字段 {key} 过长或包含非法字符。"),
                ));
            }
            Ok(Some(text.to_string()))
        }
    }
}

/// 提交、标签与回退共用的过滤条件；缺省值与桌面命令层保持一致。
fn history_request(fields: &Map<String, Value>) -> Result<HistoryRequest, AppError> {
    Ok(HistoryRequest {
        query: optional_text_field(fields, "query")?.unwrap_or_default(),
        offset: optional_u64_field(fields, "offset")?.unwrap_or(0) as u32,
        scope: optional_text_field(fields, "scope")?.unwrap_or_else(|| "current".to_string()),
        author: optional_text_field(fields, "author")?.unwrap_or_default(),
        since: optional_i64_field(fields, "since")?,
        until: optional_i64_field(fields, "until")?,
        path: optional_text_field(fields, "pathFilter")?.unwrap_or_default(),
    })
}

fn optional_i64_field(fields: &Map<String, Value>, key: &str) -> Result<Option<i64>, AppError> {
    match field(fields, key) {
        None => Ok(None),
        Some(value) => value.as_i64().map(Some).ok_or_else(|| {
            AppError::new(
                "invalid_request",
                format!("字段 {key} 必须是整数。"),
            )
        }),
    }
}

fn string_list_field(fields: &Map<String, Value>, key: &str) -> Result<Vec<String>, AppError> {
    let value = field(fields, key)
        .ok_or_else(|| AppError::new("invalid_request", format!("缺少字段 {key}。")))?;
    let Value::Array(items) = value else {
        return Err(AppError::new(
            "invalid_request",
            format!("字段 {key} 必须是数组。"),
        ));
    };
    let mut values = Vec::with_capacity(items.len());
    for item in items {
        let text = item.as_str().ok_or_else(|| {
            AppError::new(
                "invalid_request",
                format!("字段 {key} 只能包含字符串。"),
            )
        })?;
        if text.is_empty() || text.len() > MAX_FIELD || text.contains('\0') {
            return Err(AppError::new(
                "invalid_request",
                format!("字段 {key} 中存在无效条目。"),
            ));
        }
        values.push(text.to_string());
    }
    Ok(values)
}

fn to_value<T: Serialize>(value: T) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|_| AppError::new("result_unserializable", "写入结果无法序列化。"))
}
fn field<'a>(fields: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    fields.get(key).filter(|value| !value.is_null())
}

fn string_field(fields: &Map<String, Value>, key: &str) -> Result<String, AppError> {
    let value = field(fields, key)
        .ok_or_else(|| AppError::new("invalid_request", format!("缺少字段 {key}。")))?;
    let text = value
        .as_str()
        .ok_or_else(|| AppError::new("invalid_request", format!("字段 {key} 必须是字符串。")))?;
    if text.len() > MAX_FIELD || text.contains('\0') {
        return Err(AppError::new(
            "invalid_request",
            format!("字段 {key} 过长或包含非法字符。"),
        ));
    }
    if text.is_empty() {
        return Err(AppError::new(
            "invalid_request",
            format!("字段 {key} 不能为空。"),
        ));
    }
    Ok(text.to_string())
}

fn optional_string_field(
    fields: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, AppError> {
    match field(fields, key) {
        None => Ok(None),
        Some(_) => string_field(fields, key).map(Some),
    }
}

fn optional_u64_field(fields: &Map<String, Value>, key: &str) -> Result<Option<u64>, AppError> {
    match field(fields, key) {
        None => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            AppError::new(
                "invalid_request",
                format!("字段 {key} 必须是非负整数。"),
            )
        }),
    }
}

fn bool_field(fields: &Map<String, Value>, key: &str) -> bool {
    field(fields, key).and_then(Value::as_bool).unwrap_or(false)
}