//! 工作台交互终端：真实 PTY、按仓库单会话与整树终止。
//!
//! 前端只能传入仓库路径、已有 `sessionId`、输入文本和行列数；shell 固定取平台默认值
//! （Unix `$SHELL` 或 `/bin/sh`；Windows 优先 PowerShell 7，其次 Windows PowerShell 5.1，
//! 最后退回 `%COMSPEC%`/`cmd.exe`），不接受程序名或参数。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::error::AppError;
use crate::git::ops::{canonical_existing, repo_key};
use crate::redact::redact_error_text;

pub const OUTPUT_EVENT: &str = "terminal-output";
pub const EXIT_EVENT: &str = "terminal-exit";
pub const CLOSE_REQUESTED_EVENT: &str = "terminal-close-requested";

/// 每个仓库保留的输出上限。只影响内存重放；新输出始终继续推送。
const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
/// 单个写入请求上限，避免一次 IPC 把 PTY 写端长时间占住。
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const MAX_DIMENSION: u16 = 1000;
/// Unix 先 SIGTERM 再 SIGKILL；Windows 由 Job Object 一次终止。
const STOP_GRACE: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// 进程退出后给读线程排空管道的时间；ConPTY 关闭后剩余数据通常立即到达 EOF。
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// 附加/打开终端时返回的快照。`seq` 是快照 `output` 覆盖的最后一个事件序号；
/// 后续事件序号更大，前端据此丢弃旧事件或当前会话之外的事件。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub session_id: String,
    pub repo_path: String,
    pub shell: String,
    pub cwd: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub seq: u64,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub seq: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub seq: u64,
    pub exit_code: i32,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalActivity {
    pub session_id: String,
    pub repo_path: String,
}

/// 关窗确认事件：只列出仍在运行的终端会话，已退出但保留输出的会话不出现。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseRequested {
    pub sessions: Vec<TerminalActivity>,
}

pub trait TerminalEvents: Send + Sync {
    fn output(&self, event: TerminalOutputEvent);
    fn exit(&self, event: TerminalExitEvent);
}

/// 生产事件出口：通过 Tauri 广播给界面。终端会话本身不依赖 Webview 生命周期。
pub struct AppEvents {
    app: tauri::AppHandle,
}

impl AppEvents {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl TerminalEvents for AppEvents {
    fn output(&self, event: TerminalOutputEvent) {
        use tauri::Emitter;
        let _ = self.app.emit(OUTPUT_EVENT, event);
    }

    fn exit(&self, event: TerminalExitEvent) {
        use tauri::Emitter;
        let _ = self.app.emit(EXIT_EVENT, event);
    }
}

pub struct TerminalManager {
    events: Arc<dyn TerminalEvents>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// 串行化打开/重启，避免同一仓库并发创建两个 shell；不覆盖整个运行期。
    open_lock: Mutex<()>,
}

impl TerminalManager {
    pub fn new(events: Arc<dyn TerminalEvents>) -> Self {
        Self {
            events,
            sessions: Mutex::new(HashMap::new()),
            open_lock: Mutex::new(()),
        }
    }

    /// 打开或附着仓库终端。已有会话原样返回（包括已退出但保留输出的会话）。
    pub fn open(&self, path: &str) -> Result<TerminalSnapshot, AppError> {
        let repo = canonical_repo(path)?;
        let _open = lock(&self.open_lock);
        let key = repo_key(&repo);
        if let Some(session) = lock(&self.sessions).get(&key).cloned() {
            return Ok(session.snapshot());
        }
        let (session, reader) = self.spawn(repo, key.clone(), default_shell())?;
        lock(&self.sessions).insert(key, Arc::clone(&session));
        start_workers(Arc::clone(&session), reader);
        Ok(session.snapshot())
    }

    /// 显式重启已退出的会话；仍在运行时拒绝，避免同一仓库出现两个 shell。
    pub fn restart(&self, path: &str) -> Result<TerminalSnapshot, AppError> {
        let repo = canonical_repo(path)?;
        let _open = lock(&self.open_lock);
        let key = repo_key(&repo);
        if let Some(existing) = lock(&self.sessions).get(&key).cloned() {
            if existing.is_running() {
                return Err(AppError::new(
                    "terminal_running",
                    "终端仍在运行，未重复启动新会话。",
                ));
            }
        }
        let (session, reader) = self.spawn(repo, key.clone(), default_shell())?;
        let replaced = lock(&self.sessions).insert(key, Arc::clone(&session));
        drop(replaced);
        start_workers(Arc::clone(&session), reader);
        Ok(session.snapshot())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), AppError> {
        let session = self.find(session_id)?;
        session.write(data)
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), AppError> {
        let session = self.find(session_id)?;
        session.resize(rows, cols)
    }

    /// 终止所有仍在运行的终端（shell 及其后代），等待退出后返回被终止的会话。
    /// 任一失败都会在完成其余会话后返回真实错误，不虚报全部结束。
    pub fn terminate_all(&self) -> Result<Vec<TerminalActivity>, AppError> {
        // 与打开/重启串行：确认关窗期间不能再启动新的 shell。
        let _open = lock(&self.open_lock);
        let running: Vec<Arc<Session>> = lock(&self.sessions)
            .values()
            .filter(|session| session.is_running())
            .cloned()
            .collect();
        let mut stopped = Vec::new();
        let mut failures = Vec::new();
        for session in running {
            match session.terminate() {
                Ok(()) => stopped.push(TerminalActivity {
                    session_id: session.id.clone(),
                    repo_path: session.repo_key.clone(),
                }),
                Err(error) => failures.push(format!("{}: {}", session.repo_key, error.message)),
            }
        }
        if failures.is_empty() {
            Ok(stopped)
        } else {
            Err(AppError::new(
                "terminal_stop",
                format!("部分终端未能终止：{}", failures.join("；")),
            ))
        }
    }

    pub fn active(&self) -> Vec<TerminalActivity> {
        lock(&self.sessions)
            .values()
            .filter(|session| session.is_running())
            .map(|session| TerminalActivity {
                session_id: session.id.clone(),
                repo_path: session.repo_key.clone(),
            })
            .collect()
    }

    #[cfg(test)]
    pub fn has_active(&self) -> bool {
        lock(&self.sessions)
            .values()
            .any(|session| session.is_running())
    }

    /// 应用退出等不可交互终点：尽力结束所有终端，不再要求确认。
    pub fn shutdown(&self) {
        let _ = self.terminate_all();
    }

    fn find(&self, session_id: &str) -> Result<Arc<Session>, AppError> {
        lock(&self.sessions)
            .values()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "terminal_unknown",
                    "终端会话不存在，可能已被重新启动，请重新附着。",
                )
            })
    }

    fn spawn(
        &self,
        repo: PathBuf,
        key: String,
        shell: String,
    ) -> Result<(Arc<Session>, Box<dyn Read + Send>), AppError> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| start_error(&error))?;
        let portable_pty::PtyPair { slave, master } = pair;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&repo);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = match slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => return Err(start_error(&error)),
        };
        // 父进程不保留 slave：否则 shell 退出后 master 读端永远等不到 EOF。
        drop(slave);
        let tree = match ProcessTree::register(child.as_ref()) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(start_error(&error));
            }
        };
        let reader = match master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(start_error(&error));
            }
        };
        let writer = match master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(start_error(&error));
            }
        };
        let id = next_session_id();
        let session = Arc::new(Session {
            id,
            repo_path: repo,
            repo_key: key,
            shell,
            inner: Mutex::new(Inner::default()),
            ended: Condvar::new(),
            handshake: Mutex::new(Handshake::default()),
            handshake_cv: Condvar::new(),
            child: Mutex::new(Some(child)),
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(Some(master)),
            tree,
            events: Arc::clone(&self.events),
        });
        Ok((session, reader))
    }

    #[cfg(test)]
    fn open_with_shell(&self, path: &Path, shell: &str) -> Result<TerminalSnapshot, AppError> {
        let repo = canonical_repo(&path.to_string_lossy())?;
        let _open = lock(&self.open_lock);
        let key = repo_key(&repo);
        let (session, reader) = self.spawn(repo, key.clone(), shell.to_string())?;
        lock(&self.sessions).insert(key, Arc::clone(&session));
        start_workers(Arc::clone(&session), reader);
        Ok(session.snapshot())
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Default)]
struct Inner {
    status: Status,
    replay: String,
    seq: u64,
    /// 跨 read 边界未完成的 UTF-8 字节；避免把多字节字符拆成替换字符。
    pending: Vec<u8>,
}

#[derive(Default)]
enum Status {
    #[default]
    Running,
    Exited {
        code: i32,
        signal: Option<String>,
    },
}

#[derive(Default)]
struct Handshake {
    reader_done: bool,
}

struct Session {
    id: String,
    repo_path: PathBuf,
    repo_key: String,
    shell: String,
    inner: Mutex<Inner>,
    ended: Condvar,
    handshake: Mutex<Handshake>,
    handshake_cv: Condvar,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    tree: ProcessTree,
    events: Arc<dyn TerminalEvents>,
}

impl Session {
    fn is_running(&self) -> bool {
        matches!(lock(&self.inner).status, Status::Running)
    }

    fn snapshot(&self) -> TerminalSnapshot {
        let inner = lock(&self.inner);
        let (running, exit_code, signal) = match &inner.status {
            Status::Running => (true, None, None),
            Status::Exited { code, signal } => (false, Some(*code), signal.clone()),
        };
        TerminalSnapshot {
            session_id: self.id.clone(),
            repo_path: self.repo_key.clone(),
            shell: self.shell.clone(),
            cwd: self.repo_path.to_string_lossy().into_owned(),
            running,
            exit_code,
            signal,
            seq: inner.seq,
            output: inner.replay.clone(),
        }
    }

    fn record_output(&self, chunk: &[u8]) {
        let mut inner = lock(&self.inner);
        if !matches!(inner.status, Status::Running) {
            return;
        }
        let data = decode_utf8(&mut inner.pending, chunk);
        if data.is_empty() {
            return;
        }
        inner.seq += 1;
        let seq = inner.seq;
        push_replay(&mut inner.replay, &data);
        drop(inner);
        self.events.output(TerminalOutputEvent {
            session_id: self.id.clone(),
            seq,
            data,
        });
    }

    fn finish(&self, code: i32, signal: Option<String>) {
        let (tail, exit_seq) = {
            let mut inner = lock(&self.inner);
            if matches!(inner.status, Status::Exited { .. }) {
                return;
            }
            let tail = flush_pending(&mut inner.pending);
            let mut tail_event = None;
            if !tail.is_empty() {
                inner.seq += 1;
                push_replay(&mut inner.replay, &tail);
                tail_event = Some((tail, inner.seq));
            }
            inner.seq += 1;
            let exit_seq = inner.seq;
            inner.status = Status::Exited {
                code,
                signal: signal.clone(),
            };
            self.ended.notify_all();
            (tail_event, exit_seq)
        };
        if let Some((data, seq)) = tail {
            self.events.output(TerminalOutputEvent {
                session_id: self.id.clone(),
                seq,
                data,
            });
        }
        self.events.exit(TerminalExitEvent {
            session_id: self.id.clone(),
            seq: exit_seq,
            exit_code: code,
            signal,
        });
    }

    fn write(&self, data: &str) -> Result<(), AppError> {
        if !self.is_running() {
            return Err(closed_error());
        }
        if data.len() > MAX_WRITE_BYTES {
            return Err(AppError::new(
                "terminal_input",
                "单次输入过长，未写入终端。",
            ));
        }
        let mut writer = lock(&self.writer);
        let Some(writer) = writer.as_mut() else {
            return Err(closed_error());
        };
        writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|error| {
                AppError::new(
                    "terminal_write",
                    format!("无法写入终端：{}", redact_error_text(&error.to_string())),
                )
            })
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), AppError> {
        if rows == 0 || cols == 0 || rows > MAX_DIMENSION || cols > MAX_DIMENSION {
            return Err(AppError::new("terminal_size", "终端行列数无效。"));
        }
        if !self.is_running() {
            return Err(closed_error());
        }
        let master = lock(&self.master);
        let Some(master) = master.as_ref() else {
            return Err(closed_error());
        };
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                AppError::new(
                    "terminal_resize",
                    format!("无法调整终端尺寸：{}", redact_error_text(&error.to_string())),
                )
            })
    }

    fn terminate(&self) -> Result<(), AppError> {
        if !self.is_running() {
            return Ok(());
        }
        // 先固定当前后代集合：shell 退出后它们可能被重新挂到 init，无法再按父子关系查找。
        let descendants = self.tree.descendants();
        if let Err(error) = self.tree.terminate(&descendants) {
            if !self.is_running() {
                return Ok(());
            }
            return Err(stop_error(&error));
        }
        if self.wait_until_stopped(STOP_GRACE) {
            return Ok(());
        }
        if let Err(error) = self.tree.force(&descendants) {
            if !self.is_running() {
                return Ok(());
            }
            return Err(stop_error(&error));
        }
        if self.wait_until_stopped(STOP_TIMEOUT.saturating_sub(STOP_GRACE)) {
            Ok(())
        } else {
            Err(AppError::new(
                "terminal_stop",
                "无法确认终端 shell 及其子进程已退出。",
            ))
        }
    }

    fn wait_until_stopped(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut inner = lock(&self.inner);
        loop {
            if !matches!(inner.status, Status::Running) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (guard, _) = self
                .ended
                .wait_timeout(inner, deadline.saturating_duration_since(now))
                .unwrap_or_else(|error| error.into_inner());
            inner = guard;
        }
    }

    #[cfg(test)]
    fn window_size(&self) -> Option<(u16, u16)> {
        let master = lock(&self.master);
        let master = master.as_ref()?;
        master.get_size().ok().map(|size| (size.rows, size.cols))
    }
}

/// 读线程持续转发输出；等待线程负责真实退出状态，并在进程结束后关闭 PTY，
/// 让 ConPTY 的输出管道尽快到达 EOF（Windows 上退出进程本身不会关闭伪控制台）。
fn start_workers(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let reader_session = Arc::clone(&session);
    let reader_thread = std::thread::Builder::new()
        .name(format!("twiglane-terminal-read-{}", session.id))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => reader_session.record_output(&buffer[..read]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let mut handshake = lock(&reader_session.handshake);
            handshake.reader_done = true;
            reader_session.handshake_cv.notify_all();
        });

    let waiter_session = Arc::clone(&session);
    let waiter_thread = std::thread::Builder::new()
        .name(format!("twiglane-terminal-wait-{}", session.id))
        .spawn(move || {
            let child = lock(&waiter_session.child).take();
            let (code, signal) = match child.map(|mut child| child.wait()) {
                Some(Ok(status)) => (
                    status.exit_code() as i32,
                    status.signal().map(|signal| signal.to_string()),
                ),
                Some(Err(_)) | None => (-1, None),
            };
            // 关闭 master 才会关闭伪控制台；已经读到的输出仍在管道里，读线程会先排空再 EOF。
            let master = lock(&waiter_session.master).take();
            drop(master);
            let mut handshake = lock(&waiter_session.handshake);
            let deadline = Instant::now() + READER_DRAIN_TIMEOUT;
            while !handshake.reader_done {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                handshake = waiter_session
                    .handshake_cv
                    .wait_timeout(handshake, remaining)
                    .unwrap_or_else(|error| error.into_inner())
                    .0;
            }
            drop(handshake);
            waiter_session.finish(code, signal);
        });

    if reader_thread.is_err() || waiter_thread.is_err() {
        cleanup_failed_workers(&session, waiter_thread.is_err());
    }
}

fn cleanup_failed_workers(session: &Session, waiter_failed: bool) {
    let descendants = session.tree.descendants();
    let _ = session.tree.terminate(&descendants);
    let _ = session.tree.force(&descendants);
    drop(lock(&session.master).take());
    {
        let mut handshake = lock(&session.handshake);
        handshake.reader_done = true;
        session.handshake_cv.notify_all();
    }
    if waiter_failed {
        if let Some(mut child) = lock(&session.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    session.finish(-1, None);
}

fn canonical_repo(path: &str) -> Result<PathBuf, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::new("path_missing", "未提供仓库路径，未启动终端。"));
    }
    let root = canonical_existing(Path::new(path))?;
    if !root.is_dir() {
        return Err(AppError::new(
            "not_directory",
            "仓库路径不是目录，未启动终端。",
        ));
    }
    Ok(root)
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        // 优先现成的 PowerShell 7，其次 Windows PowerShell 5.1；都不可用时退回
        // 系统注册的 COMSPEC（通常是 cmd.exe）。候选固定在后端，前端仍不能指定程序。
        for name in ["pwsh.exe", "powershell.exe"] {
            if let Some(found) = find_windows_executable(name) {
                return found;
            }
        }
        std::env::var_os("COMSPEC")
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cmd.exe".to_string())
    }
    #[cfg(unix)]
    {
        std::env::var_os("SHELL")
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

/// 在 Windows 的已知安装位置与 PATH 中查找固定候选 shell，返回可执行文件绝对路径。
#[cfg(windows)]
fn find_windows_executable(name: &str) -> Option<String> {
    let mut candidates = Vec::new();
    match name {
        "pwsh.exe" => {
            if let Some(root) = std::env::var_os("ProgramFiles") {
                candidates.push(PathBuf::from(root).join("PowerShell").join("7").join(name));
            }
        }
        "powershell.exe" => {
            if let Some(root) = std::env::var_os("SystemRoot") {
                candidates.push(
                    PathBuf::from(root)
                        .join("System32")
                        .join("WindowsPowerShell")
                        .join("v1.0")
                        .join(name),
                );
            }
        }
        _ => {}
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

fn next_session_id() -> String {
    format!(
        "terminal-{}-{}",
        std::process::id(),
        SESSION_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

fn closed_error() -> AppError {
    AppError::new("terminal_closed", "终端已退出，无法继续输入。")
}

fn start_error(error: &dyn std::fmt::Display) -> AppError {
    AppError::new(
        "terminal_start",
        format!(
            "无法启动终端 shell：{}",
            redact_error_text(&error.to_string())
        ),
    )
}

fn stop_error(error: &std::io::Error) -> AppError {
    AppError::new(
        "terminal_stop",
        format!(
            "无法终止终端进程树：{}",
            redact_error_text(&error.to_string())
        ),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// 把一段 PTY 字节转换为可安全推送给 xterm 的文本：保留跨块未完成的 UTF-8 序列，
/// 遇到真正非法的字节才输出 U+FFFD。
fn decode_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut decoded = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                decoded.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    decoded.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                }
                match error.error_len() {
                    Some(invalid) => {
                        decoded.push('\u{fffd}');
                        pending.drain(..valid + invalid);
                    }
                    None => {
                        pending.drain(..valid);
                        break;
                    }
                }
            }
        }
    }
    decoded
}

fn flush_pending(pending: &mut Vec<u8>) -> String {
    if pending.is_empty() {
        return String::new();
    }
    let text = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    text
}

fn push_replay(replay: &mut String, text: &str) {
    replay.push_str(text);
    if replay.len() <= MAX_REPLAY_BYTES {
        return;
    }
    let mut cut = replay.len() - MAX_REPLAY_BYTES;
    while cut < replay.len() && !replay.is_char_boundary(cut) {
        cut += 1;
    }
    replay.drain(..cut);
}

enum ProcessTree {
    #[cfg(unix)]
    Group { pid: i32 },
    #[cfg(windows)]
    Job(JobObject),
}

impl ProcessTree {
    fn register(child: &(dyn Child + Send + Sync)) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            let pid = child
                .process_id()
                .ok_or_else(|| std::io::Error::other("终端进程没有可用的进程组标识"))?;
            Ok(Self::Group { pid: pid as i32 })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::RawHandle;
            use windows_sys::Win32::Foundation::HANDLE;
            let raw: RawHandle = child
                .as_raw_handle()
                .ok_or_else(|| std::io::Error::other("终端进程没有可用的句柄"))?;
            let job = JobObject::create()?;
            job.assign(raw as HANDLE)?;
            Ok(Self::Job(job))
        }
    }

    /// 当前 shell 的后代 PID。Unix 的 job control 会让前台命令进入独立进程组，
    /// 只按 shell 进程组发信号会漏掉它们；Windows 由 Job Object 覆盖，无需枚举。
    fn descendants(&self) -> Vec<i32> {
        #[cfg(unix)]
        {
            let Self::Group { pid } = self;
            descendants_of(*pid)
        }
        #[cfg(windows)]
        {
            Vec::new()
        }
    }

    fn terminate(&self, descendants: &[i32]) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            let Self::Group { pid } = self;
            signal_tree(*pid, descendants, libc::SIGTERM)
        }
        #[cfg(windows)]
        {
            let _ = descendants;
            let Self::Job(job) = self;
            job.terminate()
        }
    }

    fn force(&self, descendants: &[i32]) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            let Self::Group { pid } = self;
            signal_tree(*pid, descendants, libc::SIGKILL)
        }
        #[cfg(windows)]
        {
            let _ = descendants;
            let Self::Job(job) = self;
            job.terminate()
        }
    }
}

#[cfg(unix)]
fn signal_tree(pid: i32, descendants: &[i32], signal: i32) -> std::io::Result<()> {
    let mut first_error = signal_group(pid, signal).err();
    for child in descendants {
        if unsafe { libc::kill(*child, signal) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) && first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(unix)]
fn descendants_of(pid: i32) -> Vec<i32> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All);
    let root = Pid::from_u32(pid.max(0) as u32);
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (child, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*child);
        }
    }
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        if let Some(kids) = children.get(&parent) {
            for child in kids {
                found.push(child.as_u32() as i32);
                stack.push(*child);
            }
        }
    }
    found
}

#[cfg(unix)]
fn signal_group(pid: i32, signal: i32) -> std::io::Result<()> {
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(windows)]
struct JobObject(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// SAFETY: Job Object 句柄由内核管理，可在任意线程用于 Assign/Terminate/Close。
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}

#[cfg(windows)]
impl JobObject {
    fn create() -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Self(handle);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign(&self, process: windows_sys::Win32::Foundation::HANDLE) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[derive(Default)]
    struct RecordingEvents {
        outputs: Mutex<Vec<TerminalOutputEvent>>,
        exits: Mutex<Vec<TerminalExitEvent>>,
    }

    impl TerminalEvents for RecordingEvents {
        fn output(&self, event: TerminalOutputEvent) {
            lock(&self.outputs).push(event);
        }

        fn exit(&self, event: TerminalExitEvent) {
            lock(&self.exits).push(event);
        }
    }

    fn manager() -> (Arc<TerminalManager>, Arc<RecordingEvents>) {
        let events = Arc::new(RecordingEvents::default());
        let sink: Arc<dyn TerminalEvents> = events.clone();
        (Arc::new(TerminalManager::new(sink)), events)
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn wait_until(label: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        loop {
            if check() {
                return;
            }
            assert!(Instant::now() < deadline, "等待超时：{label}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_output(manager: &TerminalManager, path: &str, needle: &str) {
        wait_until(needle, Duration::from_secs(15), || {
            manager
                .open(path)
                .map(|snapshot| snapshot.output.contains(needle))
                .unwrap_or(false)
        });
    }

    fn wait_for_exit(manager: &TerminalManager, path: &str) -> TerminalSnapshot {
        wait_until("终端退出", Duration::from_secs(15), || {
            manager
                .open(path)
                .map(|snapshot| !snapshot.running)
                .unwrap_or(false)
        });
        manager.open(path).expect("退出后的快照")
    }

    #[test]
    fn real_pty_round_trips_input_output_and_exit_status() {
        let dir = TempDir::new("terminal-io");
        let (manager, events) = manager();
        let path = path_text(dir.path());

        let opened = manager.open(&path).expect("打开终端");
        assert!(opened.running);
        assert_eq!(opened.cwd, opened.repo_path);
        assert!(!opened.shell.is_empty());
        assert_eq!(opened.output, "");

        manager
            .resize(&opened.session_id, 40, 120)
            .expect("调整终端尺寸");
        let session = lock(&manager.sessions)
            .get(&opened.repo_path)
            .cloned()
            .expect("会话");
        assert_eq!(session.window_size(), Some((40, 120)));

        manager
            .write(&opened.session_id, "echo twiglane-pty-marker\r\n")
            .expect("写入输入");
        wait_for_output(&manager, &path, "twiglane-pty-marker");
        manager
            .write(&opened.session_id, "echo second-line\r\n")
            .expect("再次写入");
        wait_for_output(&manager, &path, "second-line");

        let attached = manager.open(&path).expect("重新附着");
        assert_eq!(
            attached.session_id, opened.session_id,
            "重复打开必须附着原会话"
        );
        assert!(attached.output.contains("twiglane-pty-marker"));
        assert_eq!(manager.active().len(), 1);

        manager
            .write(&opened.session_id, "exit 7\r\n")
            .expect("退出输入");
        let exited = wait_for_exit(&manager, &path);
        assert_eq!(exited.session_id, opened.session_id);
        assert_eq!(exited.exit_code, Some(7));
        assert!(exited.output.contains("twiglane-pty-marker"));
        assert!(!manager.has_active());
        assert!(manager.active().is_empty());

        let outputs = lock(&events.outputs);
        let exits = lock(&events.exits);
        let mut last = 0;
        for event in outputs.iter() {
            assert!(event.seq > last, "输出事件序号必须单调递增");
            last = event.seq;
        }
        let exit = exits.last().expect("退出事件");
        assert_eq!(exit.exit_code, 7);
        assert!(exit.seq > last, "退出事件必须排在最后一段输出之后");
        assert_eq!(exit.session_id, opened.session_id);
    }

    #[test]
    fn different_repositories_keep_independent_sessions() {
        let root = TempDir::new("terminal-repos");
        let alpha = root.path().join("alpha");
        let beta = root.path().join("beta");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&beta).unwrap();
        let (manager, _) = manager();
        let alpha_path = path_text(&alpha);
        let beta_path = path_text(&beta);

        let alpha_session = manager.open(&alpha_path).expect("仓库 A");
        let beta_session = manager.open(&beta_path).expect("仓库 B");
        assert_ne!(alpha_session.session_id, beta_session.session_id);
        assert_eq!(manager.active().len(), 2);

        manager
            .write(&alpha_session.session_id, "echo marker-alpha\r\n")
            .expect("写入 A");
        manager
            .write(&beta_session.session_id, "echo marker-beta\r\n")
            .expect("写入 B");
        wait_for_output(&manager, &alpha_path, "marker-alpha");
        wait_for_output(&manager, &beta_path, "marker-beta");
        let alpha_snapshot = manager.open(&alpha_path).unwrap();
        let beta_snapshot = manager.open(&beta_path).unwrap();
        assert!(alpha_snapshot.output.contains("marker-alpha"));
        assert!(!alpha_snapshot.output.contains("marker-beta"));
        assert!(beta_snapshot.output.contains("marker-beta"));
        assert!(!beta_snapshot.output.contains("marker-alpha"));

        manager
            .write(&alpha_session.session_id, "exit 3\r\n")
            .expect("退出 A");
        let alpha_exited = wait_for_exit(&manager, &alpha_path);
        assert_eq!(alpha_exited.exit_code, Some(3));
        wait_until("B 仍在运行", Duration::from_secs(5), || {
            manager
                .open(&beta_path)
                .map(|snapshot| snapshot.running)
                .unwrap_or(false)
        });
        assert_eq!(manager.active().len(), 1);

        let stopped = manager.terminate_all().expect("终止剩余终端");
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].session_id, beta_session.session_id);
        assert!(!manager.has_active());
        assert!(manager.terminate_all().expect("无活动会话").is_empty());
    }

    #[test]
    fn startup_failure_leaves_no_active_session() {
        let dir = TempDir::new("terminal-fail");
        let (manager, _) = manager();

        let missing = dir.path().join("missing");
        let error = manager.open(&path_text(&missing)).unwrap_err();
        assert_eq!(error.code, "path_unreadable");
        assert!(manager.active().is_empty());

        match manager.open_with_shell(dir.path(), "twiglane-shell-does-not-exist") {
            Err(error) => assert_eq!(error.code, "terminal_start"),
            Ok(_) => {
                // Unix 的 fork/exec 可能异步失败，子进程会立即以非零状态退出。
                let exited = wait_for_exit(&manager, &path_text(dir.path()));
                assert_ne!(exited.exit_code, Some(0));
            }
        }
        assert!(!manager.has_active());
        assert!(manager.active().is_empty());
    }

    #[test]
    fn terminate_kills_the_shell_and_descendants() {
        let dir = TempDir::new("terminal-tree");
        let (manager, _) = manager();
        let path = path_text(dir.path());
        let heartbeat = dir.path().join("heartbeat.txt");
        let opened = manager.open(&path).expect("打开终端");

        let command = if cfg!(windows) {
            "cmd /c \"for /l %i in (1,0,2) do @(echo x>>heartbeat.txt & ping -n 2 127.0.0.1 >nul)\"\r\n"
        } else {
            "sh -c 'while true; do echo x >> heartbeat.txt; sleep 0.2; done' &\r\n"
        };
        manager
            .write(&opened.session_id, command)
            .expect("启动后代进程");
        wait_until("后代进程写入心跳", Duration::from_secs(20), || {
            std::fs::metadata(&heartbeat)
                .map(|metadata| metadata.len() >= 2)
                .unwrap_or(false)
        });

        let stopped = manager.terminate_all().expect("终止整棵进程树");
        assert_eq!(stopped.len(), 1);
        assert!(!manager.has_active());
        let exited = manager.open(&path).expect("终止后的快照");
        assert!(!exited.running);

        // 心跳文件不再增长，说明 shell 之外的后代也已被终止。
        std::thread::sleep(Duration::from_millis(300));
        let settled = std::fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(900));
        let later = std::fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0);
        assert_eq!(later, settled, "终止后仍有后代进程在写心跳");
    }

    #[test]
    fn writes_and_resize_fail_after_exit_but_output_is_retained() {
        let dir = TempDir::new("terminal-closed");
        let (manager, _) = manager();
        let path = path_text(dir.path());
        let opened = manager.open(&path).expect("打开终端");
        manager
            .write(&opened.session_id, "echo retained-output\r\n")
            .expect("写入");
        wait_for_output(&manager, &path, "retained-output");
        manager
            .write(&opened.session_id, "exit 0\r\n")
            .expect("退出");
        let exited = wait_for_exit(&manager, &path);
        assert_eq!(exited.exit_code, Some(0));
        assert!(exited.output.contains("retained-output"));

        let write_error = manager
            .write(&opened.session_id, "echo ignored\r\n")
            .unwrap_err();
        assert_eq!(write_error.code, "terminal_closed");
        let resize_error = manager.resize(&opened.session_id, 30, 90).unwrap_err();
        assert_eq!(resize_error.code, "terminal_closed");
        assert_eq!(
            manager.write("missing-session", "x").unwrap_err().code,
            "terminal_unknown"
        );
        assert!(!manager.has_active());
    }
}
