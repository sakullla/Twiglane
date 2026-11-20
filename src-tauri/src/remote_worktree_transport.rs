//! Version 1 JSONL over the stdin/stdout of one owned Cliora helper process.

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use crate::error::AppError;

const MAX_IN_FLIGHT: usize = 16;
const REQUEST_BYTES: usize = 128 * 1024;
const RESPONSE_BYTES: usize = 4 * 1024 * 1024 + 1024;

type Reply = Result<Value, AppError>;
type Waiter = oneshot::Sender<Reply>;

fn disconnected() -> AppError {
    AppError::new(
        "remote_disconnected",
        "远端工作树连接已断开，请重新连接并核对写入结果。",
    )
}

fn protocol_error() -> AppError {
    AppError::new(
        "remote_protocol",
        "远端 agent 返回了无效的协议帧，请重新连接。",
    )
}

fn busy() -> AppError {
    AppError::new("remote_busy", "远端工作树请求已满，请稍后重试。")
}

#[derive(Default)]
struct Pending {
    waiters: HashMap<String, Waiter>,
    failure: Option<AppError>,
}

impl Pending {
    fn close(&mut self, error: AppError) {
        let error = self.failure.get_or_insert(error);
        for (_, waiter) in self.waiters.drain() {
            let _ = waiter.send(Err(error.clone()));
        }
    }
}

/// Share this object using Arc. Each outstanding RPC retains its own reply ID.
pub struct AgentTransport {
    pending: Arc<Mutex<Pending>>,
    outgoing: mpsc::Sender<Vec<u8>>,
    stop: watch::Sender<bool>,
    stopped: watch::Receiver<bool>,
}

impl AgentTransport {
    /// The caller has already selected, authenticated and launched the helper.
    /// It must pipe both stdin and stdout. A piped stderr is drained privately.
    pub fn from_child(child: Child) -> Result<Self, AppError> {
        let mut child = OwnedChild(child);
        let (Some(stdin), Some(stdout)) = (child.0.stdin.take(), child.0.stdout.take()) else {
            // A failed constructor owns the child just as a successful one does.
            tokio::spawn(async move { child.terminate().await });
            return Err(AppError::new(
                "remote_pipes",
                "连接工具缺少标准输入或输出管道。",
            ));
        };
        let (outgoing, requests) = mpsc::channel(MAX_IN_FLIGHT);
        let (stop, mut stopping) = watch::channel(false);
        let (finished, stopped) = watch::channel(false);
        let pending = Arc::new(Mutex::new(Pending::default()));
        let waiting = Arc::clone(&pending);
        let stderr = child.0.stderr.take();
        tokio::spawn(async move {
            let failure = tokio::select! {
                _ = stopping.changed() => disconnected(),
                error = write_requests(stdin, requests) => error,
                error = read_responses(stdout, &waiting) => error,
                _ = async {
                    if let Some(mut pipe) = stderr {
                        let _ = tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await;
                    }
                    std::future::pending::<()>().await;
                } => unreachable!(),
            };
            waiting
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .close(failure);
            child.terminate().await;
            finished.send_replace(true);
        });
        Ok(Self {
            pending,
            outgoing,
            stop,
            stopped,
        })
    }

    /// Fields are an object containing only operation arguments. The transport
    /// owns v/id/op. A successful call unwraps result; agent errors retain code.
    pub async fn rpc(&self, op: &str, fields: Value) -> Reply {
        if !token(op) {
            return Err(AppError::new("remote_request", "远端操作名称无效。"));
        }
        let Value::Object(mut frame) = fields else {
            return Err(AppError::new("remote_request", "远端操作参数必须是对象。"));
        };
        if ["id", "v", "op"].iter().any(|key| frame.contains_key(*key)) {
            return Err(AppError::new(
                "remote_request",
                "远端操作参数包含保留字段。",
            ));
        }
        let id = Uuid::new_v4().simple().to_string();
        frame.insert("id".into(), Value::String(id.clone()));
        frame.insert("v".into(), Value::from(1));
        frame.insert("op".into(), Value::String(op.into()));
        let mut bytes = RequestBuffer(Vec::new());
        serde_json::to_writer(&mut bytes, &frame)
            .map_err(|_| AppError::new("remote_request_size", "远端请求超过 128 KiB。"))?;
        bytes.0.push(b'\n');

        let (reply, response) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(error) = &pending.failure {
                return Err(error.clone());
            }
            if pending.waiters.len() >= MAX_IN_FLIGHT {
                return Err(busy());
            }
            self.outgoing
                .try_send(bytes.0)
                .map_err(|error| match error {
                    mpsc::error::TrySendError::Closed(_) => disconnected(),
                    mpsc::error::TrySendError::Full(_) => busy(),
                })?;
            pending.waiters.insert(id, reply);
        }
        // A cancelled caller leaves its bounded ID until its reply or EOF so a
        // legitimate late response cannot invalidate unrelated requests.
        response.await.unwrap_or_else(|_| Err(disconnected()))
    }

    pub async fn close(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close(disconnected());
        self.stop.send_replace(true);
        let mut stopped = self.stopped.clone();
        let _ = stopped.wait_for(|value| *value).await;
    }
}

impl Drop for AgentTransport {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

struct RequestBuffer(Vec<u8>);

impl Write for RequestBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // The newline counts towards the agent's request limit.
        if bytes.len() >= REQUEST_BYTES - self.0.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request size"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct OwnedChild(Child);

impl OwnedChild {
    async fn terminate(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.0.id() {
            // On Windows Cliora waits for its SSH child instead of exec'ing it.
            // Close both pipes (above), and terminate remaining descendants before
            // dropping the process handle. No shell or caller-supplied PID.
            if let Some(root) = std::env::var_os("SystemRoot") {
                let taskkill = std::path::PathBuf::from(root)
                    .join("System32")
                    .join("taskkill.exe");
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    tokio::process::Command::new(taskkill)
                        .args(["/T", "/F", "/PID", &pid.to_string()])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .kill_on_drop(true)
                        .status(),
                )
                .await;
            }
        }
        // Unix Cliora execs SSH in place, retaining the same PID and pipes.
        let _ = self.0.start_kill();
        let _ = self.0.wait().await;
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Also covers a runtime shutting down while the supervisor is suspended.
        let _ = self.0.start_kill();
    }
}

async fn write_requests(mut stdin: ChildStdin, mut requests: mpsc::Receiver<Vec<u8>>) -> AppError {
    while let Some(frame) = requests.recv().await {
        if stdin.write_all(&frame).await.is_err() {
            break;
        }
    }
    disconnected()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    v: u32,
    id: String,
    ok: bool,
    #[serde(default, deserialize_with = "present")]
    result: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    error: Option<AgentError>,
}

// Distinguish an absent field from an explicitly null error/result on the wire.
fn present<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentError {
    code: String,
    message: String,
}

async fn read_responses(stdout: ChildStdout, pending: &Mutex<Pending>) -> AppError {
    let mut pipe = BufReader::new(stdout);
    let mut frame = Vec::new();
    loop {
        let bytes = match pipe.fill_buf().await {
            Ok([]) if frame.is_empty() => return disconnected(),
            Ok([]) => return protocol_error(),
            Ok(bytes) => bytes,
            Err(_) => return disconnected(),
        };
        let newline = bytes.iter().position(|&byte| byte == b'\n');
        let count = newline.map_or(bytes.len(), |index| index + 1);
        if count > RESPONSE_BYTES - frame.len() {
            return protocol_error();
        }
        frame.extend_from_slice(&bytes[..count]);
        pipe.consume(count);
        if newline.is_none() {
            continue;
        }
        let Ok(response) = serde_json::from_slice::<Response>(&frame) else {
            return protocol_error();
        };
        frame.clear();
        if response.v != 1 || !token(&response.id) {
            return protocol_error();
        }
        let result = match (response.ok, response.result, response.error) {
            (true, Some(result), None) if result.is_object() => Ok(result),
            (false, None, Some(err)) if token(&err.code) => Err(AppError::new(
                err.code,
                crate::redact::redact_error_text(&err.message),
            )),
            _ => return protocol_error(),
        };
        let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(waiter) = pending.waiters.remove(&response.id) else {
            return protocol_error();
        };
        let _ = waiter.send(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Stdio;
    use std::time::Duration;

    fn helper(body: &str) -> (AgentTransport, u32) {
        let prelude = r#"
const input = require('node:readline').createInterface({input:process.stdin});
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const result = (req, obj) => send({v:1,id:req.id,ok:true,result:obj});
input.on('line', line => receive(JSON.parse(line)));
"#;
        let child = tokio::process::Command::new("node")
            .args(["-e", &format!("{prelude}\n{body}")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        (AgentTransport::from_child(child).unwrap(), pid)
    }

    #[tokio::test]
    async fn a_new_request_reaches_the_peer_before_the_old_reply() {
        let (agent, _) = helper(
            r#"
const requests = [];
function receive(req) {
    requests.push(req);
    if (requests.length === 2) {
        for (const r of requests.reverse()) {
            if (r.path === 'old') send({v:1,id:r.id,ok:false,error:{code:'superseded',message:'token=private'}});
            else result(r, {selected:r.path});
        }
    }
}"#,
        );
        let (old, new) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(
                agent.rpc("diff", json!({"path":"old"})),
                agent.rpc("diff", json!({"path":"new"}))
            )
        })
        .await
        .unwrap();
        let error = old.unwrap_err();
        assert_eq!(error.code, "superseded");
        assert!(!error.message.contains("private"));
        assert_eq!(new.unwrap(), json!({"selected":"new"}));
        agent.close().await;
    }

    #[tokio::test]
    async fn eof_wakes_every_unanswered_request() {
        let (agent, _) = helper("let n=0; function receive() { if (++n===2) process.exit(0); }");
        let (a, b) = tokio::join!(agent.rpc("diff", json!({})), agent.rpc("commit", json!({})));
        assert_eq!(a.unwrap_err().code, "remote_disconnected");
        assert_eq!(b.unwrap_err().code, "remote_disconnected");
        agent.close().await;
    }

    #[tokio::test]
    async fn cancelled_rpc_can_receive_a_late_response_on_the_same_session() {
        let (agent, _) = helper(
            r#"
let old;
function receive(req) {
    if (!old) old=req;
    else { result(old, {ignored:true}); result(req, {current:true}); }
}"#,
        );
        let agent = Arc::new(agent);
        let first = tokio::spawn({
            let agent = agent.clone();
            async move { agent.rpc("diff", json!({})).await }
        });
        wait_for_in_flight(&agent, 1).await;
        first.abort();
        assert_eq!(
            agent.rpc("diff", json!({})).await.unwrap(),
            json!({"current":true})
        );
        agent.close().await;
    }

    #[tokio::test]
    async fn malformed_or_oversized_frames_close_the_connection() {
        for body in [
            "send({v:2,id:r.id,ok:true,result:{}})",
            "send({v:1,id:'wrong-id',ok:true,result:{}})",
            "send({v:1,id:r.id,ok:true,result:{},error:null})",
            "send({v:1,id:r.id,ok:true,result:{},error:{code:'bad',message:'bad'}})",
            "process.stdout.write('{', () => process.exit(0))",
            "process.stdout.write('x'.repeat(4*1024*1024+1025))",
        ] {
            let (agent, _) = helper(&format!("function receive(r){{ {body} }}"));
            assert_eq!(
                agent.rpc("hello", json!({})).await.unwrap_err().code,
                "remote_protocol",
                "{body}"
            );
            assert_eq!(
                agent.rpc("status", json!({})).await.unwrap_err().code,
                "remote_protocol"
            );
            agent.close().await;
        }
    }

    #[tokio::test]
    async fn caller_cannot_overwrite_request_identity_or_exceed_the_byte_limit() {
        let (agent, _) =
            helper("function receive(req) {result(req, {op:req.op, value:req.value});}");
        for fields in [
            json!({"id":"x"}),
            json!({"op":"other"}),
            json!({"v":1}),
            json!([]),
        ] {
            assert_eq!(
                agent.rpc("hello", fields).await.unwrap_err().code,
                "remote_request"
            );
        }
        assert_eq!(
            agent
                .rpc("hello", json!({"value":"x".repeat(REQUEST_BYTES)}))
                .await
                .unwrap_err()
                .code,
            "remote_request_size"
        );
        assert_eq!(
            agent.rpc("hello", json!({"value":42})).await.unwrap(),
            json!({"op":"hello","value":42})
        );
        agent.close().await;
    }

    async fn wait_for_in_flight(agent: &AgentTransport, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while agent.pending.lock().unwrap().waiters.len() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn full_session_rejects_extra_work_and_close_wakes_callers() {
        let (agent, pid) = helper("function receive() {}");
        let agent = Arc::new(agent);
        let mut waiting = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            let agent = agent.clone();
            waiting.push(tokio::spawn(
                async move { agent.rpc("diff", json!({})).await },
            ));
        }
        wait_for_in_flight(&agent, MAX_IN_FLIGHT).await;
        assert_eq!(
            agent.rpc("diff", json!({})).await.unwrap_err().code,
            "remote_busy"
        );
        agent.close().await;
        for call in waiting {
            assert_eq!(call.await.unwrap().unwrap_err().code, "remote_disconnected");
        }
        #[cfg(unix)]
        {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }
        #[cfg(not(unix))]
        let _ = pid;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_last_owner_reaps_the_process() {
        let (agent, pid) = helper("function receive(req) {result(req, {});}");
        agent.rpc("hello", json!({})).await.unwrap();
        drop(agent);
        tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid as i32, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}
