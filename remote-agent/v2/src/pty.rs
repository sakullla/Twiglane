//! 远端 PTY 的事件出口：把共享 `terminal` 实现产生的事件变成有界、带序号的协议帧。
//!
//! 会话管理本身来自 `src-tauri/src/terminal.rs`（同一份 PTY、重放缓冲、背压与整树终止），
//! 这里只负责把 `TerminalEvents` 的同步回调写成帧：
//! - 每个事件都带会话的单调 `seq`；跨帧的大块输出按字符边界切片，附带 `part`/`parts`，
//!   客户端先按 `seq` 丢旧帧，再按 `part` 组装。
//! - 写通道用 `blocking_send`：管道或客户端跟不上时读线程停下，PTY 缓冲随之填满，
//!   由内核把背压传回远端 shell，绝不在读线程里静默丢字节。
//! - 事件帧不带请求 `id`，与普通 Git RPC 的请求/响应帧在同一条通道上多路复用。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::protocol;
use crate::terminal::{TerminalEvents, TerminalExitEvent, TerminalOutputEvent};

/// 一帧最多携带多少字节终端输出：切在字符边界上，避免把多字节字符拆成替换字符。
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;

/// 事件出口：会话 id → 仓库键的映射让每一帧都带 `repo`，客户端按仓库隔离缓存与视图。
pub struct FrameEvents {
    out: mpsc::Sender<Vec<u8>>,
    repos: Arc<Mutex<HashMap<String, String>>>,
}

impl FrameEvents {
    pub fn new(out: mpsc::Sender<Vec<u8>>, repos: Arc<Mutex<HashMap<String, String>>>) -> Self {
        Self { out, repos }
    }

    fn repo_of(&self, session_id: &str) -> Option<String> {
        self.repos
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(session_id)
            .cloned()
    }
}

impl TerminalEvents for FrameEvents {
    fn output(&self, event: TerminalOutputEvent) {
        let repo = self.repo_of(&event.session_id);
        for frame in output_frames(repo.as_deref(), &event) {
            let _ = self.out.blocking_send(frame);
        }
    }

    fn exit(&self, event: TerminalExitEvent) {
        let repo = self.repo_of(&event.session_id);
        let mut body = base_body(repo.as_deref(), &event.session_id, event.seq);
        body.insert("exitCode".into(), json!(event.exit_code));
        body.insert("signal".into(), json!(event.signal));
        let _ = self.out.blocking_send(protocol::event_frame("terminalExit", body));
    }
}

fn base_body(repo: Option<&str>, session_id: &str, seq: u64) -> Map<String, Value> {
    let mut body = Map::new();
    if let Some(repo) = repo {
        body.insert("repo".into(), Value::String(repo.to_string()));
    }
    body.insert("sessionId".into(), Value::String(session_id.to_string()));
    body.insert("seq".into(), json!(seq));
    body
}

/// 一条输出事件切成若干帧：序号沿用会话自己的 `seq`，片段序号从 0 开始。
pub fn output_frames(repo: Option<&str>, event: &TerminalOutputEvent) -> Vec<Vec<u8>> {
    let chunks = split(&event.data, MAX_CHUNK_BYTES);
    let parts = chunks.len().max(1);
    let mut frames = Vec::with_capacity(parts);
    if chunks.is_empty() {
        let mut body = base_body(repo, &event.session_id, event.seq);
        body.insert("part".into(), json!(0));
        body.insert("parts".into(), json!(1));
        body.insert("data".into(), Value::String(String::new()));
        frames.push(protocol::event_frame("terminalOutput", body));
        return frames;
    }
    for (index, chunk) in chunks.into_iter().enumerate() {
        let mut body = base_body(repo, &event.session_id, event.seq);
        body.insert("part".into(), json!(index));
        body.insert("parts".into(), json!(parts));
        body.insert("data".into(), Value::String(chunk.to_string()));
        frames.push(protocol::event_frame("terminalOutput", body));
    }
    frames
}

/// 按字节上限切片，但只在字符边界上切；单个字符本身就超限时单独成片（不会丢内容）。
fn split(text: &str, limit: usize) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + limit).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            // 一个字符比上限还大：至少前进一个字符，保证切片收敛。
            end = start
                + text[start..]
                    .chars()
                    .next()
                    .map(char::len_utf8)
                    .unwrap_or(1);
        }
        chunks.push(&text[start..end]);
        start = end;
    }
    chunks
}

/// 附着时的重放：整段回放可能有 2 MiB，进 JSON 后还可能放大，因此按预算保留末尾。
///
/// 返回 (要回放的文本, 是否被截短)。截短时客户端看到 `replayTruncated`，知道这只是一段
/// 尾部输出，而不是完整历史。
pub fn fit_tail(text: &str, budget: usize) -> (String, bool) {
    if text.len() <= budget {
        return (text.to_string(), false);
    }
    let mut start = text.len() - budget;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_string(), true)
}
