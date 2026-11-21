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
use crate::git::ops::{self, Backend, RepoState};
use crate::git::runner::RealRunner;
use crate::git::schedule::{internal_request_id, JobKind};
use crate::model::{CommitResult, DiffLineSelection, StatusSnapshot};
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

pub struct Context {
    backend: Arc<Backend>,
    session: Mutex<Option<Session>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    slots: Arc<Semaphore>,
    out: mpsc::Sender<Vec<u8>>,
}

/// 写操作分类：请求摘要、回执与执行分支都以它为准。
#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteOp {
    Stage,
    Unstage,
    Patch,
    Commit,
}

impl WriteOp {
    fn name(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Unstage => "unstage",
            Self::Patch => "patch",
            Self::Commit => "commit",
        }
    }
}

enum Written {
    Files(StatusSnapshot),
    Commit(Box<CommitResult>),
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
            .insert(request.id.clone(), Arc::clone(&cancel));
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
            "stage" => self.write(WriteOp::Stage, &request.fields).await,
            "unstage" => self.write(WriteOp::Unstage, &request.fields).await,
            "patch" => self.write(WriteOp::Patch, &request.fields).await,
            "commit" => self.write(WriteOp::Commit, &request.fields).await,
            "receipt" => self.receipt(&request.fields),
            other => Err(AppError::new(
                "unsupported_op",
                format!("v2 不支持操作 {}。", safe_op(other)),
            )),
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
    /// 一次写入的完整顺序：回执查重 → 令牌核对 → 跨进程写锁 → 拿锁后再次核对 →
    /// 登记 registered → 执行共享写入 → 成功后改为 completed。
    async fn write(&self, op: WriteOp, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let operation_id = string_field(fields, "operationId")?;
        if !protocol::token(&operation_id) || operation_id.len() < 8 {
            return Err(AppError::new(
                "invalid_operation",
                "操作 ID 无效，未写入仓库。",
            ));
        }
        let request_digest = request_digest(op, fields);
        let store = ReceiptStore::new(&session.git_dir);
        if let Some(existing) = store.read(&operation_id) {
            if existing.request_digest != request_digest || existing.op != op.name() {
                return Err(AppError::new(
                    "operation_conflict",
                    "该操作 ID 已用于另一个请求，未再次写入。",
                ));
            }
            return match existing.state.as_str() {
                COMPLETED => Ok(json!({ "receipt": existing, "replayed": true })),
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

        let expected = string_field(fields, "stateToken")?;
        let seen: RepoState =
            ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
        let generation = self.backend.scheduler.current_generation(&session.key);
        if seen.token != expected {
            let receipt = Receipt::registered(
                &operation_id,
                &session.key,
                op.name(),
                &request_digest,
                seen.head,
                generation,
            );
            store.fail(receipt, "state_mismatch")?;
            return Err(AppError::new(
                "state_mismatch",
                "仓库状态在读取之后已经变化，未写入。请刷新后重试。",
            ));
        }
        // 跨进程写锁：同一 common Git dir 在任一时刻只有一个 agent 在写。
        let lock = {
            let git_dir = session.git_dir.clone();
            tokio::task::spawn_blocking(move || RepoWriteLock::acquire(&git_dir, WRITE_LOCK_WAIT))
                .await
                .map_err(|_| {
                    AppError::new("write_lock_unavailable", "写入锁已中断，未写入仓库。")
                })??
        };
        // 排队等锁期间仓库可能已被另一个进程改过：拿锁后重新核对令牌。
        let guarded: RepoState =
            ops::state_token(&self.backend, &session.root, internal_request_id()).await?;
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
                "仓库状态在等待写入锁时发生变化，未写入。请刷新后重试。",
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

        let written = match self.execute(op, fields, &session, generation).await {
            Ok(written) => written,
            Err(error) => {
                store.fail(receipt, &error.code)?;
                return Err(error);
            }
        };
        let generation = self.backend.scheduler.current_generation(&session.key);
        let (head, branch, mut body) = match written {
            Written::Files(snapshot) => {
                let state: RepoState =
                    ops::state_token(&self.backend, &session.root, internal_request_id())
                        .await?;
                session.set_state(state.clone());
                (
                    state.head,
                    snapshot.branch.name.clone(),
                    json!({ "snapshot": snapshot, "stateToken": state.token.clone() }),
                )
            }
            Written::Commit(result) => {
                let state: RepoState =
                    ops::state_token(&self.backend, &session.root, internal_request_id())
                        .await?;
                session.set_state(state.clone());
                (
                    Some(result.oid.clone()),
                    Some(result.branch.clone()),
                    json!({ "commit": result, "stateToken": state.token.clone() }),
                )
            }
        };
        let receipt = store.complete(receipt, head, branch, generation)?;
        drop(lock);
        if let Value::Object(map) = &mut body {
            map.insert(
                "receipt".into(),
                serde_json::to_value(&receipt).unwrap_or(Value::Null),
            );
            map.insert("repo".into(), Value::String(session.key.clone()));
            map.insert("generation".into(), Value::from(generation));
        }
        Ok(body)
    }
    async fn execute(
        &self,
        op: WriteOp,
        fields: &Map<String, Value>,
        session: &Session,
        generation: u64,
    ) -> Result<Written, AppError> {
        match op {
            WriteOp::Stage => {
                let paths = paths_field(fields)?;
                let snapshot = changes::stage_files(
                    &self.backend,
                    &session.key,
                    &paths,
                    generation,
                    internal_request_id(),
                )
                .await?;
                Ok(Written::Files(snapshot))
            }
            WriteOp::Unstage => {
                let paths = paths_field(fields)?;
                let snapshot = changes::unstage_files(
                    &self.backend,
                    &session.key,
                    &paths,
                    generation,
                    internal_request_id(),
                )
                .await?;
                Ok(Written::Files(snapshot))
            }
            WriteOp::Patch => {
                let path = string_field(fields, "path")?;
                let original = optional_string_field(fields, "original")?;
                let staged = bool_field(fields, "staged");
                let snapshot_token = string_field(fields, "snapshot")?;
                let hunks = optional_u32_list(fields, "hunks")?;
                let lines = optional_lines(fields)?;
                let snapshot = match (hunks, lines) {
                    (Some(hunks), None) if !hunks.is_empty() => {
                        changes::stage_hunks(
                            &self.backend,
                            &session.key,
                            &path,
                            original.as_deref(),
                            staged,
                            &hunks,
                            &snapshot_token,
                            generation,
                            internal_request_id(),
                        )
                        .await?
                    }
                    (None, Some(lines)) if !lines.is_empty() => {
                        changes::stage_lines(
                            &self.backend,
                            &session.key,
                            &path,
                            original.as_deref(),
                            staged,
                            &lines,
                            &snapshot_token,
                            generation,
                            internal_request_id(),
                        )
                        .await?
                    }
                    _ => {
                        return Err(AppError::new(
                            "invalid_patch",
                            "按块或按行写入必须且只能给出一组选择。",
                        ))
                    }
                };
                Ok(Written::Files(snapshot))
            }
            WriteOp::Commit => {
                let message = string_field(fields, "message")?;
                if message.len() > MESSAGE_LIMIT {
                    return Err(AppError::new(
                        "message_too_large",
                        "提交说明过长，未创建提交。",
                    ));
                }
                let result = changes::commit_index(
                    &self.backend,
                    &session.key,
                    &message,
                    generation,
                    internal_request_id(),
                )
                .await?;
                Ok(Written::Commit(Box::new(result)))
            }
        }
    }
    fn receipt(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let session = self.session(fields)?;
        let operation_id = string_field(fields, "operationId")?;
        let store = ReceiptStore::new(&session.git_dir);
        match store.read(&operation_id) {
            Some(receipt) if receipt.repo == session.key => Ok(json!({ "receipt": receipt })),
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

    fn cancel(&self, fields: &Map<String, Value>) -> Result<Value, AppError> {
        let target = string_field(fields, "targetId")?;
        let flag = self
            .cancels
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&target)
            .cloned();
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(json!({ "targetId": target, "cancelled": true }))
            }
            None => Ok(json!({ "targetId": target, "cancelled": false })),
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
