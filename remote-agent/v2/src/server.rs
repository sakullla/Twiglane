//! v2 服务循环：有界 JSONL 请求分派、多路响应、取消与选择抢占、写入回执。
//!
//! 所有仓库语义都调用共享的 Rust 实现（git::ops、git::changes、git::patch）：本模块只负责
//! 协议、会话身份、跨进程写锁和回执，不重新实现 Git 行为。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Semaphore};

use crate::error::AppError;
use crate::events::{self, ChangeFeed};
use crate::git::changes;
use crate::git::command::common_dir_command;
use crate::git::document::{self, DocumentSource};
use crate::git::files::{self, DeleteMode, RepositoryCreateEntryKind};
use crate::git::gate::RepoWriteLock;
use crate::git::heads;
use crate::git::history::{self, HistoryRequest};
use crate::git::ops::{self, Backend, RepoState};
use crate::git::resolve;
use crate::git::runner::RealRunner;
use crate::git::schedule::{internal_request_id, JobKind};
use crate::git::sync;
use crate::git::tags;
use crate::git::task;
use crate::git::worktree as worktree_ops;
use crate::identity::{git_path, worktree_changed, WorktreeIdentity};
use crate::model::{DiffLineSelection, RepositorySearchScope, TaskReview};
use crate::protocol::{self, Request, CAPABILITIES, MAX_IN_FLIGHT, MAX_REQUEST_BYTES, PROTOCOL};
use crate::pty::{self, FrameEvents};
use crate::receipts::{Receipt, ReceiptStore, COMPLETED, FAILED};
use crate::session::{DiffView, Selection, Session};
use crate::shutdown::Shutdown;
use crate::state::AppStore;
use crate::terminal::{TerminalManager, TerminalProfile, TerminalSnapshot};

const AGENT_NAME: &str = "twiglane-agent/2";
const MAX_FIELD: usize = 4096;
const MAX_DIFF_CURSOR_BYTES: usize = 256;
const MAX_PATHS: usize = 500;
const DEFAULT_DIFF_LINES: u32 = 200;
const MAX_DIFF_LINES: u32 = 2000;
const MAX_CONTEXT: u32 = 1_000_000;
const WRITE_LOCK_WAIT: Duration = Duration::from_secs(10);
const MESSAGE_LIMIT: usize = 1024 * 1024;
/// 附着时回放的尾部预算：完整回放可能有 2 MiB，进 JSON 后还会被转义放大。
const MAX_ATTACH_TAIL: usize = 512 * 1024;
/// 单条附着响应的上限：给 JSON 转义与其它字段留出余量。
const ATTACH_FRAME_LIMIT: usize = protocol::MAX_RESPONSE_BYTES - 512 * 1024;

/// 普通 Git RPC 与终端 op 都拒绝的字段：任何 op 都不执行任意程序，终端只接受 PTY 输入。
const EXEC_FIELDS: &[&str] = &[
    "program", "command", "args", "argv", "shell", "cwd", "env", "environment",
];

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
    journal_identity: OnceLock<Result<String, AppError>>,
    session: Mutex<Option<Session>>,
    cancels: Mutex<HashMap<String, InFlight>>,
    slots: Arc<Semaphore>,
    out: mpsc::Sender<Vec<u8>>,
    /// 当前仓库的变化事件源；打开新仓库时替换。
    changes: Mutex<Option<Arc<ChangeFeed>>>,
    /// 远端 PTY 会话：与仓库 RPC 物理分离，只有显式的终端 op 会碰它。
    terminal: Arc<TerminalManager>,
    /// 终端会话 → 仓库键，事件帧据此带上 `repo`。
    terminal_repos: Arc<Mutex<HashMap<String, String>>>,
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
    // 文件与目录写入（T3）：与 Git 写入同一套锁、令牌与回执顺序。
    EditSave,
    CreateEntry,
    CopyEntry,
    MoveEntry,
    DeleteEntries,
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
    WriteOp::EditSave,
    WriteOp::CreateEntry,
    WriteOp::CopyEntry,
    WriteOp::MoveEntry,
    WriteOp::DeleteEntries,
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
            Self::EditSave => "editSave",
            Self::CreateEntry => "createEntry",
            Self::CopyEntry => "copyEntry",
            Self::MoveEntry => "moveEntry",
            Self::DeleteEntries => "deleteEntries",
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

    // 终端事件走同一条写出通道：会话、重放与背压都由共享实现负责，这里只把事件写成帧。
    let terminal_repos = Arc::new(Mutex::new(HashMap::new()));
    let terminal = Arc::new(TerminalManager::new(Arc::new(FrameEvents::new(
        out.clone(),
        Arc::clone(&terminal_repos),
    ))));
    let context = Arc::new(Context {
        backend: Arc::new(build_backend()),
        journal_identity: OnceLock::new(),
        session: Mutex::new(None),
        cancels: Mutex::new(HashMap::new()),
        slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
        out,
        changes: Mutex::new(None),
        terminal,
        terminal_repos,
    });

    let (lines, mut incoming) = mpsc::unbounded_channel::<Line>();
    std::thread::spawn(move || read_lines(lines));

    while let Some(line) = incoming.recv().await {
        match line {
            Line::Frame(bytes) => context.handle_line(&bytes),
            // 超限行在读取侧就被丢弃，这里只补一条与解析侧完全一致的拒绝。
            Line::TooLarge => context.reject_too_large(),
        }
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

/// 读取侧交给处理循环的一行：正常帧，或「这一行超过 `MAX_REQUEST_BYTES`」的围栏命中。
enum Line {
    Frame(Vec<u8>),
    TooLarge,
}

/// 单次读取的块大小：比上限小得多，超限的行因此不会被整行缓冲。
const READ_CHUNK: usize = 64 * 1024;

/// 按块读标准输入并切行：任何时刻内存里最多只有一条上限内的行。
///
/// 单帧上限是 8 MiB，但客户端可以送来任意大的行。旧实现用 `read_until` 把整行读进
/// 无界 `Vec` 才判断上限，等于把内存交给对端；这里改成边读边算长度，越过上限就立刻
/// 丢弃该行剩余字节并交一条 `TooLarge`，下一个换行处恢复切行，通道本身不会再变大。
fn read_lines(sender: mpsc::UnboundedSender<Line>) {
    use std::io::Read;
    let stdin = std::io::stdin();
    let mut handle = stdin.lock();
    let mut line: Vec<u8> = Vec::new();
    // 已判定超限、正在丢弃剩余字节：到下一个换行为止都不再累积。
    let mut discarding = false;
    let mut chunk = [0u8; READ_CHUNK];
    loop {
        let read = match handle.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut start = 0;
        while start < read {
            let rest = &chunk[start..read];
            let newline = rest.iter().position(|byte| *byte == b'\n');
            match newline {
                Some(index) => {
                    if !discarding {
                        push_bounded(&mut line, &rest[..index], &mut discarding, &sender);
                    }
                    discarding = false;
                    if !deliver(&sender, std::mem::take(&mut line)) {
                        return;
                    }
                    start += index + 1;
                }
                None => {
                    if !discarding {
                        push_bounded(&mut line, rest, &mut discarding, &sender);
                    }
                    start = read;
                }
            }
        }
    }
    // 标准输入结束时残留的最后一帧按同样规则处理：`read_until` 原本也接受无结尾换行的帧。
    if !discarding {
        let _ = deliver(&sender, line);
    }
}

/// 交出一帧；通道已关闭时返回 false（读线程没有继续的意义）。空行直接跳过。
fn deliver(sender: &mpsc::UnboundedSender<Line>, line: Vec<u8>) -> bool {
    line.is_empty() || sender.send(Line::Frame(line)).is_ok()
}

/// 追加一段字节并在越过上限时立即收手：清空缓冲、发一条 `TooLarge`、转入丢弃状态。
fn push_bounded(
    line: &mut Vec<u8>,
    bytes: &[u8],
    discarding: &mut bool,
    sender: &mpsc::UnboundedSender<Line>,
) {
    if line.len().saturating_add(bytes.len()) > MAX_REQUEST_BYTES {
        line.clear();
        *discarding = true;
        let _ = sender.send(Line::TooLarge);
        return;
    }
    line.extend_from_slice(bytes);
    while line.last().is_some_and(|byte| *byte == b'\r') {
        line.pop();
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
    fn journal_identity(&self) -> Result<&str, AppError> {
        self.journal_identity
            .get_or_init(crate::journal_identity::load)
            .as_deref()
            .map_err(Clone::clone)
    }

    /// 读取侧围栏命中：与解析侧超限拒绝同一份 `code` 与文案，且不执行任何东西。
    fn reject_too_large(&self) {
        let rejection = protocol::too_large_rejection();
        self.respond(protocol::err_frame(&rejection.id, &rejection.error));
    }

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
        // 普通 Git RPC 没有「执行程序」这一维：仓库操作只经共享 Git 实现执行。任何请求带上
        // program/command/shell/cwd/env 都必须被拒绝；显式终端会话也不例外——它接受的是
        // PTY 输入（data），不是要执行的程序名或参数。
        if let Some(key) = request
            .fields
            .keys()
            .find(|key| EXEC_FIELDS.contains(&key.as_str()))
        {
            return Err(AppError::new(
                "invalid_request",
                format!(
                    "{} 不接受字段 {key}：任何 op 都不执行任意程序。",
                    safe_op(&request.op)
                ),
            ));
        }
        match request.op.as_str() {
            "hello" => self.hello(&request.fields),
            "open" => self.open(&request.fields, cancel).await,
            "status" => self.status(&request.fields, cancel).await,
            "diff" => self.diff(&request.fields, cancel).await,
            "taskReview" => self.task_review(&request.fields, cancel).await,
            "taskReviewToken" => self.task_review_token(&request.fields, cancel).await,
            "reviewIdentity" => self.review_identity(&request.fields, cancel).await,
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
            // 文件树、正文与资源、文档来源、搜索与内容版本（T3）。
            "directory" => self.directory(&request.fields, cancel).await,
            "fileContent" => self.file_content(&request.fields, cancel).await,
            "filePreview" => self.file_preview(&request.fields, cancel).await,
            "document" => self.document(&request.fields, cancel).await,
            "documentResource" => self.document_resource(&request.fields, cancel).await,
            "documentRemoteImage" => self.document_remote_image(&request.fields, cancel).await,
            "pathSearch" => self.path_search(&request.fields, cancel).await,
            "contentSearch" => self.content_search(&request.fields, cancel).await,
            "reviewToken" => self.review_token(&request.fields, cancel).await,
            "editSnapshot" => self.edit_snapshot(&request.fields, cancel).await,
            // 变化事件游标：通知、聚焦与显式刷新都走同一个入口。
            "events" => self.events(&request.fields),
            // 远端 PTY 会话（与仓库 RPC 分离）。
            "terminalProfiles" => self.terminal_profiles(&request.fields),
            "terminalList" => self.terminal_list(&request.fields),
            "terminalCreate" => self.terminal_create(&request.fields).await,
            "terminalAttach" => self.terminal_attach(&request.fields),
            "terminalInput" => self.terminal_input(&request.fields),
            "terminalResize" => self.terminal_resize(&request.fields),
            "terminalRestart" => self.terminal_restart(&request.fields).await,
            "terminalClose" => self.terminal_close(&request.fields).await,
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
            "journalIdentity": self.journal_identity()?,
            "generation": "numeric",
            "stateToken": "opaque",
        }))
    }

    async fn open(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let journal_identity = self.journal_identity()?;
        let baseline = baseline_field(fields)?.map(str::to_owned);
        let expected_identity = optional_string_field(fields, "worktreeIdentity")?;
        let path = string_field(fields, "path")?;
        check_cancel(cancel)?;
        let opened = ops::open_repository(&self.backend, &path, internal_request_id()).await?;
        let root = PathBuf::from(&opened.summary.path);
        let state: RepoState =
            ops::state_token(&self.backend, &root, internal_request_id()).await?;
        let git_dir = self.common_dir(&root).await?;
        let identity = WorktreeIdentity::read(&self.backend, &root).await?;
        if expected_identity
            .as_ref()
            .is_some_and(|expected| expected != &identity.digest)
        {
            return Err(worktree_changed());
        }
        let session = Session::new(
            root,
            opened.summary.path.clone(),
            git_dir,
            state.clone(),
            identity,
            baseline,
        )?;
        let review = self.bound_task_review(&session, opened.generation).await?;
        check_cancel(cancel)?;
        // 变化事件源与仓库同生命周期：watch 不可用时如实降级，不启动任何轮询。
        let feed = ChangeFeed::start(
            &session.key,
            &session.root,
            &session.git_dir,
            self.out.clone(),
        );
        let degraded = feed.degraded();
        *self
            .changes
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(feed);
        *self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(session.clone());
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
            // 远端变化事件经有序通知帧推送；watch 不可用时为 true，只剩显式刷新。
            "watchDegraded": degraded,
            "events": "notification",
            "capabilities": CAPABILITIES,
            "journalIdentity": journal_identity,
            "worktreeIdentity": session.identity.digest,
            "worktreePath": session.identity.path,
            "baseline": session.baseline,
            "reviewFiles": review_file_paths(review.as_ref()),
            "reviewFilesTruncated": review.is_some_and(|review| review.files_truncated),
        }))
    }
    async fn status(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        check_bound_baseline(&session, fields)?;
        let generation = match optional_u64_field(fields, "generation")? {
            Some(generation) => generation,
            None => self.backend.scheduler.current_generation(&session.key),
        };
        check_cancel(cancel)?;
        let snapshot = ops::refresh_status(
            &self.backend,
            &session.key,
            generation,
            internal_request_id(),
        )
        .await?;
        let state: RepoState =
            ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
        // A branch switch or rewrite can invalidate the review range while
        // leaving the worktree usable for ordinary repository operations.
        let (review, review_error) =
            match self.bound_task_review(&session, snapshot.generation).await {
                Ok(review) => (review, None),
                Err(error) => (None, Some(error)),
            };
        session.set_state(state.clone());
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": snapshot.generation,
            "stateToken": state.token,
            "snapshot": snapshot,
            "worktreeIdentity": session.identity.digest,
            "worktreePath": session.identity.path,
            "baseline": session.baseline,
            "reviewFiles": review_file_paths(review.as_ref()),
            "reviewFilesTruncated": review.is_some_and(|review| review.files_truncated),
            "reviewError": review_error,
        }))
    }

    async fn check_identity(&self, session: &Session) -> Result<(), AppError> {
        let identity = WorktreeIdentity::read(&self.backend, &session.root).await?;
        if identity.digest != session.identity.digest || identity.path != session.identity.path {
            return Err(worktree_changed());
        }
        // A linked worktree can keep its own Git directory while its
        // commondir points to another store for refs, objects and writes.
        let common_dir = self.common_dir(&session.root).await?;
        session.git_dir_identity.check(&common_dir)
    }

    async fn review_identity(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "worktreeIdentity": session.identity.digest,
            "worktreePath": session.identity.path,
        }))
    }

    async fn bound_task_review(
        &self,
        session: &Session,
        generation: u64,
    ) -> Result<Option<TaskReview>, AppError> {
        let Some(baseline) = session.baseline.as_deref() else {
            return Ok(None);
        };
        let review = task::task_review(
            &self.backend,
            &session.key,
            baseline,
            generation,
            internal_request_id(),
        )
        .await?;
        // The shared local reader also accepts refs and peels tags. A remote
        // review source must identify the commit itself.
        if review.baseline_oid != baseline {
            return Err(invalid_baseline());
        }
        Ok(Some(review))
    }

    async fn task_review(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        check_bound_baseline(&session, fields)?;
        check_cancel(cancel)?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        let review = self
            .bound_task_review(&session, generation)
            .await?
            .ok_or_else(invalid_baseline)?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "generation": review.generation, "review": review }))
    }

    async fn task_review_token(&self, fields: &Map<String, Value>, cancel: &AtomicBool) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        check_bound_baseline(&session, fields)?;
        let baseline = session.baseline.as_deref().ok_or_else(invalid_baseline)?;
        let head = string_field(fields, "head")?;
        let path = string_field(fields, "path")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let token = task::task_review_token(
            &self.backend, &session.key, baseline, &head, &path, generation, internal_request_id(),
        ).await?;
        check_cancel(cancel)?;
        Ok(json!({ "repo": session.key, "token": token }))
    }

    async fn diff(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let path = string_field(fields, "path")?;
        let mut original = optional_string_field(fields, "original")?;
        let view = match string_field(fields, "view")?.as_str() {
            "staged" => DiffView::Staged,
            "unstaged" => DiffView::Unstaged,
            "task" => DiffView::Task,
            _ => {
                return Err(AppError::new(
                    "invalid_view",
                    "差异视图只能是 staged、unstaged 或 task。",
                ))
            }
        };
        let offset = u32::try_from(optional_u64_field(fields, "offset")?.unwrap_or(0))
            .map_err(|_| AppError::new("invalid_request", "差异偏移超出范围。"))?;
        let limit = optional_u64_field(fields, "limit")?
            .map(|limit| limit.clamp(1, u64::from(MAX_DIFF_LINES)) as u32)
            .unwrap_or(DEFAULT_DIFF_LINES);
        let context = optional_u64_field(fields, "context")?
            .map(|context| context.min(u64::from(MAX_CONTEXT)) as u32)
            .unwrap_or(3);
        let as_text = bool_field(fields, "asText");
        let selection = Selection {
            path: path.clone(),
            original: original.clone(),
            view,
        };
        let epoch = session.begin_diff(selection.clone(), offset == 0);
        let cursor = optional_string_field(fields, "cursor")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let task_range = if view == DiffView::Task {
            check_bound_baseline(&session, fields)?;
            let baseline = session.baseline.as_deref().ok_or_else(invalid_baseline)?;
            let state =
                ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
            if optional_string_field(fields, "head")?
                .as_deref()
                .is_some_and(|expected| Some(expected) != state.head.as_deref())
            {
                return Err(cursor_expired());
            }
            Some((baseline, state))
        } else {
            None
        };
        if task_range.is_some() && original.is_none() {
            if let Some(review) = self.bound_task_review(&session, generation).await? {
                original = review
                    .files
                    .into_iter()
                    .find(|file| file.path == path)
                    .and_then(|file| file.original_path);
            }
        }
        let token = task_range
            .as_ref()
            .map_or_else(|| session.token(), |(_, state)| state.token.clone());
        let query = DiffQuery {
            repo: session.key.clone(),
            identity: session.identity.digest.clone(),
            baseline: session.baseline.clone(),
            token,
            selection,
            limit,
            offset,
            context,
            as_text,
        };
        if let Some(cursor) = cursor {
            Cursor::decode(&cursor)?.check(&query)?;
        }
        let staged = view == DiffView::Staged;
        let diff = if let Some((baseline, state)) = task_range {
            let head = state.head.as_deref().ok_or_else(invalid_baseline)?;
            let mut diff = task::load_task_diff(
                &self.backend,
                &session.key,
                baseline,
                head,
                &path,
                original.as_deref(),
                generation,
                internal_request_id(),
                offset,
                limit,
                context,
                as_text,
            )
            .await?;
            let after =
                ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
            if state.token != after.token {
                return Err(cursor_expired());
            }
            for hunk in &mut diff.hunks {
                hunk.stageable = false;
            }
            // A diff is read-only. Return its observed token without replacing a
            // newer token obtained by a concurrent status or write.
            diff
        } else {
            changes::load_diff_with_context(
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
            .await?
        };
        session.check_epoch(epoch)?;
        check_cancel(cancel)?;
        let consumed = diff.offset + diff.lines.len() as u32;
        let token = query.token.clone();
        let next = (consumed < diff.total_lines).then(|| {
            Cursor::for_query(&DiffQuery {
                offset: consumed,
                ..query
            })
            .encode()
        });
        Ok(json!({
            "repo": session.key,
            "path": diff.path,
            "staged": staged,
            "view": view,
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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
        let session = self.repo_session(fields).await?;
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

    /// 文件树：一层目录 + 被跳过条目的原因，与桌面同名 DTO。`relative` 留空表示仓库根。
    async fn directory(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let relative = optional_text_field(fields, "relative")?.unwrap_or_default();
        let include_ignored = bool_field(fields, "includeIgnored");
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let listing = files::repository_directory(
            &self.backend,
            &session.key,
            &relative,
            include_ignored,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": listing.generation,
            "directory": listing,
        }))
    }

    /// 文件正文：只读当前文件、只读当前页；分页游标由共享实现给出。
    async fn file_content(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let relative = string_field(fields, "relative")?;
        let offset = optional_u64_field(fields, "offset")?.unwrap_or(0);
        let limit = optional_u64_field(fields, "limit")?
            .map(|limit| limit.clamp(1, MAX_DIFF_LINES as u64) as usize);
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let content = files::repository_file_content(
            &self.backend,
            &session.key,
            &relative,
            offset,
            limit,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": content.generation,
            "content": content,
        }))
    }

    /// 资源预览（图片、压缩包、LFS 指针）：与桌面共用同一份大小、类型与下载边界。
    async fn file_preview(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let source: crate::git::preview::PreviewSource = deserialize_field(fields, "source")?;
        let download = bool_field(fields, "download");
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let preview = crate::git::preview::file_preview(
            &self.backend,
            &session.key,
            &source,
            generation,
            download,
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": preview.generation,
            "preview": preview,
        }))
    }

    /// Markdown 文档：`mode=document` 排版、`mode=source` 分页源码；版本不一致按 stale 拒绝。
    async fn document(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let mut source: DocumentSource = deserialize_field(fields, "source")?;
        // 来源绑定到当前打开的仓库：另一棵工作树的 source 不能被当成本仓库的文件。
        if source.repository.is_none() {
            source.repository = Some(session.key.clone());
        }
        let mode = optional_text_field(fields, "mode")?.unwrap_or_else(|| "document".to_string());
        let offset = optional_u64_field(fields, "offset")?.unwrap_or(0);
        let limit = optional_u64_field(fields, "limit")?.map(|limit| limit as usize);
        let expected = optional_text_field(fields, "expectedVersion")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let document = document::repository_document(
            &self.backend,
            &session.key,
            &source,
            generation,
            internal_request_id(),
            &mode,
            offset,
            limit,
            expected.as_deref(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": document.generation,
            "document": document,
        }))
    }

    /// 文档内嵌资源：图片、字体等，仍走同一份资源预览 DTO 与大小上限。
    async fn document_resource(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let mut source: DocumentSource = deserialize_field(fields, "source")?;
        if source.repository.is_none() {
            source.repository = Some(session.key.clone());
        }
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let resource = document::document_resource(
            &self.backend,
            &session.key,
            &source,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": resource.generation,
            "resource": resource,
        }))
    }

    /// 远端外链图片：抓取发生在远端（远端自己的网络与信任边界），不经过桌面代理。
    async fn document_remote_image(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let url = string_field(fields, "url")?;
        // 只接受明确的 http(s) 外链：validate_web_url 同时拒绝其它协议与本机路径。
        document::validate_web_url(&url)?;
        check_cancel(cancel)?;
        let image =
            document::document_remote_image(&self.backend, &url, internal_request_id()).await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "image": image,
        }))
    }

    /// 路径搜索：只按当前查询和当前目录读取，结果条数有上限并显式标记截断。
    async fn path_search(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let query = optional_text_field(fields, "query")?.unwrap_or_default();
        let directory = optional_text_field(fields, "directory")?;
        let include_ignored = bool_field(fields, "includeIgnored");
        let limit = optional_u64_field(fields, "limit")?.map(|limit| limit as usize);
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let search = files::repository_path_search(
            &self.backend,
            &session.key,
            &query,
            directory.as_deref(),
            include_ignored,
            limit,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": search.generation,
            "search": search,
        }))
    }

    /// 全文搜索：范围是封闭类型，跳过原因与本地一致（二进制、非 UTF-8、超限、符号链接）。
    async fn content_search(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let query = optional_text_field(fields, "query")?.unwrap_or_default();
        let scope: RepositorySearchScope = deserialize_field(fields, "scope")?;
        let include_ignored = bool_field(fields, "includeIgnored");
        let limit = optional_u64_field(fields, "limit")?.map(|limit| limit as usize);
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let search = files::repository_content_search(
            &self.backend,
            &session.key,
            &query,
            scope,
            include_ignored,
            limit,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": search.generation,
            "search": search,
        }))
    }

    /// 单条路径的审阅令牌：内容版本与暂存状态一起回来，前端据此判断能否标记已审阅。
    async fn review_token(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let relative = string_field(fields, "relative")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let token = files::repository_review_token(
            &self.backend,
            &session.key,
            &relative,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": token.generation,
            "token": token,
        }))
    }

    /// 编辑基线：`digest` 是保存时要回传的预期内容版本。
    async fn edit_snapshot(
        &self,
        fields: &Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let relative = string_field(fields, "relative")?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        check_cancel(cancel)?;
        let snapshot = files::repository_edit_snapshot(
            &self.backend,
            &session.key,
            &relative,
            generation,
            internal_request_id(),
        )
        .await?;
        check_cancel(cancel)?;
        Ok(json!({
            "repo": session.key,
            "generation": snapshot.generation,
            "edit": snapshot,
        }))
    }

    /// 变化事件游标。客户端只在收到通知、聚焦窗口或显式刷新时调用它；agent 不轮询仓库。
    fn events(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let after = optional_u64_field(fields, "after")?.unwrap_or(0);
        let feed = self
            .changes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok_or_else(|| AppError::new("no_repository", "还没有打开远端工作树，请先 open。"))?;
        if feed.key() != session.key {
            return Err(AppError::new(
                "unknown_repo",
                "请求指向的仓库不是当前打开的工作树。",
            ));
        }
        let reply = events::cursor(&feed, after);
        Ok(json!({
            "repo": session.key,
            "seq": reply.seq,
            "watchDegraded": reply.degraded,
            "resync": reply.resync,
            "events": reply.events,
        }))
    }

    /// 远端可用的终端类型。前端只能按 id 选择，不能传程序名或参数。
    fn terminal_profiles(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let profiles: Vec<TerminalProfile> = self.terminal.profiles();
        Ok(json!({ "repo": session.key, "profiles": profiles }))
    }

    /// 当前仓库的终端会话（含已退出但保留输出的会话）；不带输出，附着时再取。
    fn terminal_list(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let sessions = self.terminal.list(&session.key)?;
        Ok(json!({ "repo": session.key, "sessions": sessions }))
    }

    /// 新建终端会话：在远端仓库根解析登录 shell，客户端不能指定程序与本机路径。
    async fn terminal_create(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let profile = optional_text_field(fields, "profile")?;
        let manager = Arc::clone(&self.terminal);
        let path = session.key.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            manager.create(&path, profile.as_deref(), None)
        })
        .await
        .map_err(|_| AppError::new("terminal_start", "终端启动被中断，未创建会话。"))??;
        if let Err(error) = self.remember_terminal(&snapshot, &session.key) {
            // 归属校验失败说明这个 shell 不能留在远端：已建会话必须就地回收，
            // 否则会出现一个没有仓库能认领、却能继续写文件的孤儿进程。
            let manager = Arc::clone(&self.terminal);
            let orphan = snapshot.session_id.clone();
            let _ = tokio::task::spawn_blocking(move || manager.close(&orphan)).await;
            return Err(error);
        }
        Ok(json!({ "repo": session.key, "terminal": snapshot }))
    }

    /// 附着：返回完整重放与它覆盖到的序号。重放超过单帧上限时只回尾部并标记截短。
    fn terminal_attach(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let id = string_field(fields, "sessionId")?;
        let snapshot = self.terminal.attach(&id)?;
        self.check_terminal_repo(&snapshot, &session.key)?;
        fit_attach(&session.key, &snapshot)
    }

    /// 输入：只有显式创建的终端会话接受 PTY 输入。
    fn terminal_input(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let id = string_field(fields, "sessionId")?;
        let data = raw_text_field(fields, "data")?;
        // 只要归属：`attach` 会复制最多 2 MiB 的重放缓冲，写输入不该为它付代价。
        self.check_terminal_owner(&self.terminal.repo_of(&id)?, &session.key)?;
        self.terminal.write(&id, &data)?;
        Ok(json!({ "repo": session.key, "sessionId": id, "accepted": true }))
    }

    /// resize：行列数由共享实现校验上限，越界即拒绝而不是静默截断。
    fn terminal_resize(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let id = string_field(fields, "sessionId")?;
        let rows = optional_u64_field(fields, "rows")?.unwrap_or(0);
        let cols = optional_u64_field(fields, "cols")?.unwrap_or(0);
        let rows =
            u16::try_from(rows).map_err(|_| AppError::new("terminal_size", "终端行数超出范围。"))?;
        let cols =
            u16::try_from(cols).map_err(|_| AppError::new("terminal_size", "终端列数超出范围。"))?;
        self.check_terminal_owner(&self.terminal.repo_of(&id)?, &session.key)?;
        self.terminal.resize(&id, rows, cols)?;
        Ok(json!({
            "repo": session.key,
            "sessionId": id,
            "rows": rows,
            "cols": cols,
        }))
    }

    /// 重启：只对已退出的会话生效，仍在运行时拒绝，避免替换正在跑的命令。
    async fn terminal_restart(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.repo_session(fields).await?;
        let id = string_field(fields, "sessionId")?;
        self.check_terminal_owner(&self.terminal.repo_of(&id)?, &session.key)?;
        let manager = Arc::clone(&self.terminal);
        let snapshot = tokio::task::spawn_blocking(move || manager.restart(&id))
            .await
            .map_err(|_| AppError::new("terminal_start", "终端重启被中断。"))??;
        self.remember_terminal(&snapshot, &session.key)?;
        fit_attach(&session.key, &snapshot)
    }

    /// 关闭：先终止 shell 及其子进程，确认结束后才移除会话；重复关闭是幂等的。
    async fn terminal_close(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        // An orphaned session must remain closable after its worktree disappears.
        let session = self.session_by_key(fields)?;
        let id = string_field(fields, "sessionId")?;
        // 关闭也是跨仓库可达的破坏性操作：先确认会话属于当前打开的工作树。
        // 会话已不存在时按幂等处理（重复关闭仍然是 `closed: true`），不在这里报未知。
        if let Ok(owner) = self.terminal.repo_of(&id) {
            self.check_terminal_owner(&owner, &session.key)?;
        }
        let manager = Arc::clone(&self.terminal);
        let target = id.clone();
        let closed = tokio::task::spawn_blocking(move || manager.close(&target))
            .await
            .map_err(|_| AppError::new("terminal_stop", "终端关闭被中断。"))?;
        self.terminal_repos
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);
        closed?;
        Ok(json!({ "repo": session.key, "sessionId": id, "closed": true }))
    }

    /// 记录会话所属仓库：事件帧据此带上 `repo`，跨仓库的会话 id 不会串台。
    fn remember_terminal(&self, snapshot: &TerminalSnapshot, key: &str) -> Result<(), AppError> {
        if snapshot.repo_path != key {
            return Err(AppError::new(
                "unknown_repo",
                "终端会话不属于当前打开的工作树。",
            ));
        }
        self.terminal_repos
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(snapshot.session_id.clone(), key.to_string());
        Ok(())
    }

    /// 会话所属仓库必须与请求的 `repo` 一致：终端不会跨仓库找会话。
    fn check_terminal_repo(&self, snapshot: &TerminalSnapshot, key: &str) -> Result<(), AppError> {
        self.check_terminal_owner(&snapshot.repo_path, key)
    }

    /// 归属校验的本体：只比较仓库键，不需要重放缓冲。
    fn check_terminal_owner(&self, repo_key: &str, key: &str) -> Result<(), AppError> {
        if repo_key == key {
            Ok(())
        } else {
            Err(AppError::new(
                "unknown_repo",
                "终端会话不属于当前打开的工作树。",
            ))
        }
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
        session.git_dir_identity.check(&session.git_dir)?;
        // 跨进程写锁：同一 common Git dir 在任一时刻只有一个 agent 在写。
        let lock = {
            let git_dir = session.git_dir.clone();
            tokio::task::spawn_blocking(move || RepoWriteLock::acquire(&git_dir, WRITE_LOCK_WAIT))
                .await
                .map_err(|_| {
                    AppError::new("write_lock_unavailable", "写入锁已中断，未写入仓库。")
                })??
        };
        self.check_identity(&session).await?;
        session.git_dir_identity.check(&session.git_dir)?;
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

        let mut receipt = Receipt::registered(
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
        receipt.review_outcome = state.as_ref().and_then(|state| {
            let head = state.head.as_deref()?;
            match op {
                WriteOp::Commit if value["oid"].as_str() == Some(head) => Some("committed"),
                WriteOp::MergeStart
                    if (value["fastForwarded"].as_bool() == Some(true) || value["rebased"].as_bool() == Some(true))
                        && receipt.before_head.as_deref() != Some(head) => Some("merged"),
                WriteOp::MergeComplete if value["oid"].as_str() == Some(head) => match value["operation"].as_str() {
                    Some("merge" | "rebase") => Some("merged"),
                    Some("cherry-pick" | "revert") => Some("committed"),
                    _ => None,
                },
                _ => None,
            }.map(str::to_string)
        });
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
            // 文件保存：预期内容版本（digest）就是这次写入的状态前提，写前写后都要核实。
            WriteOp::EditSave => {
                let relative = string_field(fields, "path")?;
                let expected = string_field(fields, "expectedDigest")?;
                let content = raw_text_field(fields, "content")?;
                let snapshot = files::repository_edit_save(
                    backend,
                    path,
                    &relative,
                    &expected,
                    &content,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("edit".to_string(), to_value(snapshot)?))
            }
            WriteOp::CreateEntry => {
                let relative = string_field(fields, "path")?;
                let kind: RepositoryCreateEntryKind = deserialize_field(fields, "kind")?;
                let snapshot = files::repository_create_entry(
                    backend,
                    path,
                    &relative,
                    kind,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::CopyEntry => {
                let source = string_field(fields, "source")?;
                let target = string_field(fields, "target")?;
                let snapshot = files::repository_copy_entry(
                    backend,
                    path,
                    &source,
                    &target,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            WriteOp::MoveEntry => {
                let source = string_field(fields, "source")?;
                let target = string_field(fields, "target")?;
                let snapshot = files::repository_move_entry(
                    backend,
                    path,
                    &source,
                    &target,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("snapshot".to_string(), to_value(snapshot)?))
            }
            // 删除：permanent 缺省为假，即进系统回收站；绝不隐式切换成不可恢复的删除。
            WriteOp::DeleteEntries => {
                let relatives = string_list_field(fields, "relatives")?;
                let mode = if bool_field(fields, "permanent") {
                    DeleteMode::Permanent
                } else {
                    DeleteMode::Trash
                };
                let result = files::repository_delete_entries(
                    backend,
                    path,
                    &relatives,
                    mode,
                    generation,
                    request_id,
                )
                .await?;
                Ok(("delete".to_string(), to_value(result)?))
            }
        }
    }

    fn receipt(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session_by_key(fields)?;
        // worktreeRemove can delete the root while its common Git directory
        // still holds the operation's receipt.
        session.git_dir_identity.check(&session.git_dir)?;
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

    async fn repo_session(&self, fields: &Map<String, Value>) -> Result<Session, AppError> {
        let session = self.session(fields)?;
        self.check_identity(&session).await?;
        Ok(session)
    }

    fn session(&self, fields: &Map<String, Value>) -> Result<Session, AppError> {
        let session = self.session_by_key(fields)?;
        session.identity.check_root(&session.root)?;
        Ok(session)
    }

    fn session_by_key(&self, fields: &Map<String, Value>) -> Result<Session, AppError> {
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
        if output.output.exit_code != 0 || output.output.stdout_truncated {
            return Err(AppError::new(
                "not_repository",
                "无法定位 Git 目录，未打开仓库。",
            ));
        }
        let path = git_path(&output.output.stdout)?;
        Ok(if path.is_absolute() { path.to_path_buf() } else { root.join(path) })
    }
}
/// 一次性差异游标：绑定仓库、状态令牌、查询与下一页偏移。
#[derive(Serialize)]
struct DiffQuery {
    repo: String,
    identity: String,
    baseline: Option<String>,
    token: String,
    selection: Selection,
    limit: u32,
    offset: u32,
    context: u32,
    as_text: bool,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Cursor {
    offset: u32,
    query_digest: String,
}

impl Cursor {
    fn for_query(query: &DiffQuery) -> Self {
        use sha2::{Digest, Sha256};
        // Keep the entire query binding independent of path length. The
        // desktop can still read the next offset from the cursor.
        let bytes = serde_json::to_vec(query).expect("a diff query is always serializable");
        Self {
            offset: query.offset,
            query_digest: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    fn encode(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("a diff cursor is always serializable");
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decode(raw: &str) -> Result<Self, AppError> {
        if raw.len() > MAX_DIFF_CURSOR_BYTES {
            return Err(cursor_expired());
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw.as_bytes())
            .map_err(|_| cursor_expired())?;
        serde_json::from_slice(&bytes).map_err(|_| cursor_expired())
    }

    fn check(&self, query: &DiffQuery) -> Result<(), AppError> {
        if self == &Self::for_query(query) {
            Ok(())
        } else {
            Err(cursor_expired())
        }
    }
}

fn invalid_baseline() -> AppError {
    AppError::new(
        "invalid_baseline",
        "任务起点必须是当前工作树的完整提交标识。",
    )
}

fn baseline_field(fields: &Map<String, Value>) -> Result<Option<&str>, AppError> {
    match fields.get("baseline") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if matches!(value.len(), 40 | 64)
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')) =>
        {
            Ok(Some(value))
        }
        Some(_) => Err(invalid_baseline()),
    }
}

fn check_bound_baseline(session: &Session, fields: &Map<String, Value>) -> Result<(), AppError> {
    if baseline_field(fields)?.is_some_and(|baseline| Some(baseline) != session.baseline.as_deref())
    {
        return Err(invalid_baseline());
    }
    Ok(())
}

fn review_file_paths(review: Option<&TaskReview>) -> Option<Vec<&str>> {
    review.map(|review| {
        let mut paths: Vec<_> = review.files.iter().map(|file| file.path.as_str()).collect();
        paths.sort_unstable();
        paths
    })
}

fn cursor_expired() -> AppError {
    AppError::new(
        "cursor_expired",
        "差异游标绑定的仓库、状态或选择已经变化，请重新读取第一页。",
    )
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

/// 反序列化一个结构字段（预览来源、搜索范围、新建类型）；形状不对就明确拒绝。
fn deserialize_field<T: serde::de::DeserializeOwned>(
    fields: &Map<String, Value>,
    key: &str,
) -> Result<T, AppError> {
    let value = field(fields, key)
        .ok_or_else(|| AppError::new("invalid_request", format!("缺少字段 {key}。")))?;
    serde_json::from_value(value.clone())
        .map_err(|_| AppError::new("invalid_request", format!("字段 {key} 的形状无效。")))
}

/// 正文类字段：允许空串与超长文本（文件内容、终端输入），只受单帧上限约束。
/// 路径类字段仍然走带长度与 NUL 检查的 `string_field`。
fn raw_text_field(fields: &Map<String, Value>, key: &str) -> Result<String, AppError> {
    match field(fields, key) {
        None => Ok(String::new()),
        Some(value) => value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AppError::new("invalid_request", format!("字段 {key} 必须是字符串。"))),
    }
}

/// 附着响应有界：先按尾部预算裁剪重放，仍超出单帧上限就继续减半，绝不发出半截 JSON。
fn fit_attach(key: &str, snapshot: &TerminalSnapshot) -> Result<Value, AppError> {
    let mut budget = MAX_ATTACH_TAIL;
    loop {
        let (output, truncated) = pty::fit_tail(&snapshot.output, budget);
        let mut value = to_value(snapshot.clone())?;
        if let Value::Object(map) = &mut value {
            map.insert("output".into(), Value::String(output));
            map.insert("replayTruncated".into(), Value::Bool(truncated));
        }
        let body = json!({ "repo": key, "terminal": value });
        let size = serde_json::to_vec(&body)
            .map(|bytes| bytes.len())
            .unwrap_or(usize::MAX);
        if size <= ATTACH_FRAME_LIMIT || budget == 0 {
            return Ok(body);
        }
        budget /= 2;
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
