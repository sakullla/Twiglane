pub(crate) mod review;
#[cfg(test)]
mod live;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::error::AppError;
use crate::remote_ssh::{self, AgentArtifact, RemoteSsh};
use crate::remote_worktree_transport::{AgentTransport, ScopedChild};
use crate::state::AppStore;

const FLAG: &str = "--twiglane-remote-v1";
static AGENT: &[u8] = include_bytes!("../../remote-agent/agent");
const SIGNATURE: Option<&str> = option_env!("TWIGLANE_REMOTE_AGENT_SIGNATURE");
/// 内嵌 v1 组件在界面上的版本标签；v2 一律用清单里的真实版本。
const V1_VERSION: &str = "v1";
/// v2 差异一页的解析行数：分页只切远端行窗口，前端看到的仍是拼接后的完整 unified 文本。
const V2_DIFF_PAGE_LINES: u64 = 2000;

type Result<T> = std::result::Result<T, AppError>;
type Managed<'a> = State<'a, Arc<RemoteWorktrees>>;

pub(crate) struct RemoteWorktrees {
    data: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    openings: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    installs: Mutex<HashMap<String, InstallTarget>>,
    mutations: Mutex<()>,
    reviews: Mutex<review::Book>,
}

impl RemoteWorktrees {
    pub(crate) fn new(data: PathBuf) -> Self {
        Self {
            data,
            sessions: Mutex::default(),
            openings: Mutex::default(),
            installs: Mutex::default(),
            mutations: Mutex::default(),
            reviews: Mutex::default(),
        }
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("remote_disconnected", "远端工作树连接已断开，请重连。"))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    target_id: String,
    target_revision: String,
    name: String,
    host: String,
    user: String,
    port: u16,
    auth_method: String,
    default_path: Option<String>,
    effective_host: Option<String>,
    unavailable_reason: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    request_id: String,
    target_id: String,
    target_revision: String,
    path: String,
    baseline: Option<String>,
    allow_install: bool,
    install_confirmation: Option<String>,
    review_id: Option<String>,
}

/// 这一次打开用的是哪个远端组件。审查基线只有 v1 支持，因此它同时决定回退条件。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AgentKind {
    V1,
    V2,
}


#[derive(Clone, PartialEq, Eq)]
struct InstallTarget {
    provider: AgentKind,
    review_id: Option<String>,
    target_id: String,
    revision: String,
    peer: String,
    path: String,
    /// 待安装组件的版本与字节数：界面上的「安装 vX」与进度总量都取这里，不再写死 v1。
    version: String,
    size: u64,
}

enum Opened {
    Worktree(Box<Session>, Value),
    NeedsInstall(InstallTarget),
}

/// 远端组件来源：优先本机已发行的 v2 产物，否则回退内嵌的 v1。
enum Provider {
    V2 { dir: PathBuf },
    /// 回退原因只用于测试断言与排查：它说明为什么这台机器用不上 v2 产物。
    V1Embedded {
        #[allow(dead_code)]
        reason: String,
    },
}

/// 选出本机可用的 v2 产物目录：显式目录（`TWIGLANE_AGENT_V2_DIR`）→ 资源目录/agent-v2。
///
/// 只判断「本机有没有一份可读的清单」；远端架构是否在清单里要等探测之后才知道，
/// 由 [`select_v2_artifact`] 决定，缺失时同样回退内嵌 v1 并给出原因。
fn select_provider(v2_dir: Option<PathBuf>, resources: Option<PathBuf>) -> Provider {
    let mut reason = String::from("本机没有远端组件 v2 产物（发行包不含 agent-v2 清单）");
    for dir in [v2_dir, resources].into_iter().flatten() {
        match remote_ssh::manifest_ready(&dir) {
            Ok(()) => return Provider::V2 { dir },
            Err(error) => reason = error.message,
        }
    }
    Provider::V1Embedded { reason }
}


/// 一次打开可用的本机 v2 会话入口：自有主机簿、自有 SSH 规则与产物目录。
pub(crate) struct V2Access<'a> {
    pub(crate) store: &'a AppStore,
    pub(crate) ssh: &'a RemoteSsh,
    /// 开发/测试显式指定的产物目录；发行构建缺省用资源目录里的 `agent-v2`。
    pub(crate) v2_dir: Option<PathBuf>,
}

impl<'a> V2Access<'a> {
    /// 生产入口：产物目录只来自环境变量（开发联调）或发行包资源目录。
    pub(crate) fn new(store: &'a AppStore, ssh: &'a RemoteSsh) -> Self {
        Self {
            store,
            ssh,
            v2_dir: std::env::var_os("TWIGLANE_AGENT_V2_DIR").map(PathBuf::from),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    sent_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    review_id: Option<String>,
    operation_id: String,
    /// 远端 op 名：既覆盖 `stage`/`unstage`/`commit`，也覆盖桥接命令转发的写入 op。
    /// 旧记录里存的就是 `stage` 这类小写名，改成字符串后仍能读回。
    op: String,
    repo: String,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum WriteKind {
    Stage,
    Unstage,
    Commit,
}

impl WriteKind {
    fn name(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Unstage => "unstage",
            Self::Commit => "commit",
        }
    }
}

struct Session {
    review_id: Option<String>,
    peer_revision: String,
    agent: AgentTransport,
    repo: String,
    target: Target,
    root: String,
    peer_identity: String,
    baseline: Option<String>,
    /// 远端组件是否声明了按块/按行写入（agent v2 的 `patch`）。只由 `open` 返回的
    /// capabilities 决定：没有声明就一律按整文件暂存处理，不假设远端能力。
    hunk_stageable: bool,
    /// 实际使用的组件版本（v1 为 `v1`，v2 为清单/握手给出的版本）。
    agent_version: String,
    /// v2 写入令牌：open/status/diff 都会刷新，写入必须带最新值。v1 会话始终为空。
    state_token: Mutex<Option<String>>,
    /// v2 会话的私有目录（冻结配置、known_hosts 副本与一次性 askpass）必须活到会话结束。
    /// 只作为生命周期守卫持有，代码不读取它。
    _session_dir: Option<tempfile::TempDir>,
}

impl Session {
    /// 记录远端刷新出来的写入令牌。v1 的响应里没有这个字段，因此保持为空。
    fn remember_state(&self, value: &Value) {
        if let Some(token) = value.get("stateToken").and_then(Value::as_str) {
            let mut slot = self.state_token.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(token.to_string());
        }
    }

    fn state_token(&self) -> Option<String> {
        self.state_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn protocol(&self) -> u32 {
        self.agent.protocol()
    }

    /// 写入/读取请求的版本上下文。v1 用字符串 `generation`；v2 只认数字 generation
    /// 与最新的 `stateToken`，绝不把字符串 generation 发过去。
    fn with_generation(&self, fields: &mut Value, generation: Option<&str>) -> bool {
        if self.protocol() == 2 {
            let Some(token) = self.state_token() else {
                return false;
            };
            fields["stateToken"] = json!(token);
            if let Some(generation) = generation.and_then(|value| value.parse::<u64>().ok()) {
                fields["generation"] = json!(generation);
            }
        } else if let Some(generation) = generation {
            fields["generation"] = json!(generation);
        }
        true
    }
    fn journal(&self, base: &Path) -> PathBuf {
        let key = json!([
            self.target.target_id,
            self.peer_identity,
            self.target.user,
            self.root
        ]);
        base.join(format!(
            "{:x}.json",
            Sha256::digest(key.to_string().as_bytes())
        ))
    }

    async fn status(&self) -> Result<Value> {
        self.status_for(self.baseline.as_deref()).await
    }

    async fn status_for(&self, baseline: Option<&str>) -> Result<Value> {
        let mut fields = json!({"repo":self.repo});
        if let Some(baseline) = baseline {
            fields["baseline"] = json!(baseline);
        }
        let result = self.agent.rpc("status", fields).await?;
        self.remember_state(&result);
        // v2 把状态放在 `snapshot` 里；拍平成 v1 视图后，前端与写入核对都用同一份形状。
        let result = if self.protocol() == 2 {
            flatten_v2(&result)?
        } else {
            result
        };
        if result.get("repo").and_then(Value::as_str) == Some(&self.repo) {
            return Ok(result);
        }
        Err(AppError::new("target_changed", "远端工作树身份已变化。"))
    }
}

/// 把 v2 的结构化状态拍平成 v1 视图。
///
/// 前端只认一份形状：`repo/root/host/generation/head/branch/files`。v2 把状态放在
/// `snapshot`（`StatusSnapshot`）里，代次是数字；这里统一成前端已经在用的字符串代次，
/// 界面不需要知道背后是哪个组件。
fn flatten_v2(result: &Value) -> Result<Value> {
    let snapshot = result
        .get("snapshot")
        .filter(|value| value.is_object())
        .ok_or_else(|| AppError::new("remote_protocol", "远端返回的工作树状态无效。"))?;
    let generation = snapshot
        .get("generation")
        .and_then(Value::as_u64)
        .or_else(|| result["generation"].as_u64())
        .ok_or_else(|| AppError::new("remote_protocol", "远端返回的工作树代次无效。"))?;
    let branch = &snapshot["branch"];
    let mut files = Vec::new();
    for file in snapshot["files"].as_array().into_iter().flatten() {
        let Some(path) = file["path"].as_str().filter(|path| !path.is_empty()) else {
            return Err(AppError::new("remote_protocol", "远端返回的改动列表无效。"));
        };
        files.push(json!({"path":path,"xy":change_xy(file)}));
    }
    let mut view = json!({
        "repo": result["repo"],
        "host": result["host"],
        "generation": generation.to_string(),
        "head": branch["headOid"],
        "branch": branch["name"],
        "files": files,
    });
    for key in ["root", "name"] {
        if let Some(value) = result.get(key) {
            view[key] = value.clone();
        }
    }
    Ok(view)
}

/// v2 的 `FileChange` 翻成 v1 的两位状态码：界面按这个码决定新增/修改/未跟踪/冲突。
fn change_xy(file: &Value) -> String {
    if file["untracked"].as_bool() == Some(true) {
        return "??".into();
    }
    if file["unmerged"].as_bool() == Some(true) {
        return "UU".into();
    }
    let mark = |value: &Value| match value.as_str().unwrap_or_default() {
        "added" => 'A',
        "deleted" => 'D',
        "renamed" => 'R',
        "copied" => 'C',
        "modified" => 'M',
        "typeChanged" => 'T',
        "unmerged" => 'U',
        _ => ' ',
    };
    let mut xy = String::with_capacity(2);
    xy.push(mark(&file["staged"]));
    xy.push(mark(&file["unstaged"]));
    xy
}

/// 把 v2 的结构化差异渲染回 unified 文本：前端解析器、分页与块标记都不用改。
fn render_v2_diff(diff: &Value) -> String {
    if diff["binary"].as_bool() == Some(true) {
        let path = diff["path"].as_str().unwrap_or_default();
        return format!("Binary files a/{path} and b/{path} differ\n");
    }
    let mut text = String::new();
    for line in diff["lines"].as_array().into_iter().flatten() {
        text.push_str(line["text"].as_str().unwrap_or_default());
        match line["eol"].as_str() {
            // 行尾类型由远端标注：CRLF 与单独 CR 都还原成 CRLF，显示与解析口径一致。
            Some("crlf" | "cr") => text.push_str("\r\n"),
            _ => text.push('\n'),
        }
    }
    text
}

const V2_CURSOR_PREFIX: &str = "v2:";

/// v2 差异的分页游标：只记录下一页的行偏移，远端自己的 cursor 不暴露给前端。
fn v2_cursor(offset: u64) -> String {
    format!("{V2_CURSOR_PREFIX}{offset}")
}

fn invalid_diff_cursor() -> AppError {
    AppError::new("remote_request", "远端差异游标无效，请重新打开这个文件。")
}

/// 游标里的下一页偏移。本地游标直接写着偏移；对端游标是不透明令牌，它内部也记着
/// 下一页偏移，这里只读那一个字段，绑定关系（仓库、状态令牌、选择）仍由对端自己校验。
fn v2_cursor_offset(cursor: &str) -> Result<u64> {
    if let Some(value) = cursor.strip_prefix(V2_CURSOR_PREFIX) {
        return value.parse::<u64>().map_err(|_| invalid_diff_cursor());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|body| body.get("offset").and_then(Value::as_u64))
        .ok_or_else(invalid_diff_cursor)
}

/// 一页 v2 差异的分页结果：渲染好的文本与下一页游标。
///
/// 对端的 `DiffResponse` 走 camelCase，总行数只出现在 `totalLines` 上；读错键会让
/// 「还有下一页」恒假，于是超过一页的差异只能取回首页，界面还把首页当成完整差异。
/// 对端给了 `nextCursor` 就原样透传（它绑定了仓库状态令牌与选择），只有对端没给
/// 时才用本地行偏移推算，保证末页游标仍然为 null。
fn v2_diff_page(diff: &Value, peer_next: Option<&str>, offset: u64) -> (String, Option<String>) {
    let text = render_v2_diff(diff);
    let lines = diff["lines"].as_array().map_or(0, |lines| lines.len() as u64);
    let consumed = offset.saturating_add(lines);
    let total = diff["totalLines"].as_u64().unwrap_or(consumed);
    let next = match peer_next.filter(|cursor| !cursor.is_empty()) {
        Some(cursor) => Some(cursor.to_string()),
        None => (consumed < total).then(|| v2_cursor(consumed)),
    };
    (text, next)
}

fn remote_error(code: &str) -> AppError {
    // agent v2 的错误码与本地分类不同名：把它们翻成同一套面向用户的分类，既不把
    // 「仓库状态已变」说成 SSH 失败，也不把「组件不支持」折叠成连接问题。
    match code {
        "unsupported_operation" | "unsupported_capability" => {
            return AppError::new(
                "remote_unsupported",
                "当前远端组件不支持这项操作，请更新远端组件后重试。",
            )
        }
        "state_mismatch" => {
            return AppError::new("stale_state", "远端工作树已有变化，请刷新后重试。")
        }
        "operation_conflict" => {
            return AppError::new(
                "remote_request",
                "这个操作标识已经用于另一个请求，本次没有再次写入。",
            )
        }
        "operation_pending" => {
            return AppError::new(
                "write_pending",
                "此前的远端操作结果仍未确认，请先核对再重试。",
            )
        }
        "invalid_operation" | "invalid_patch" | "verify_failed" => {
            return AppError::new(
                "remote_request",
                "远端拒绝了这次请求，工作树没有按此请求改动。",
            )
        }
        "message_too_large" | "request_too_large" => {
            return AppError::new(
                "remote_request_size",
                "操作内容超出单次请求大小，请缩短后重试。",
            )
        }
        _ => {}
    }
    let message = match code {
        "remote_disabled" => "请先在 Cliora 中启用 SSH 主机。",
        "database_unavailable" => "无法读取 Cliora 的主机配置。",
        "target_unavailable" | "target_changed" => "SSH 主机配置已变化，请重新选择主机。",
        "password_required" => "请先在 Cliora 中为该主机保存 SSH 密码。",
        "invalid_artifact" | "development_artifact_unavailable" => {
            "远端组件的版本或验证信息不匹配。"
        }
        "agent_digest_mismatch" => "远端组件不完整或已经更换，请重新安装。",
        "unsafe_install_directory" | "unsafe_agent" | "agent_io" => {
            "无法在该 SSH 账号的个人目录安全安装远端组件。"
        }
        "stale_state" => "远端工作树已有变化，请刷新后重试。",
        "remote_busy" => "远端请求仍在处理，本次操作尚未发送，可以重试。",
        "remote_request_size" => "操作内容超出单次请求大小，请缩短提交说明后重试。",
        "remote_not_sent" => "远端连接已关闭，本次操作尚未发送，请重连后重试。",
        "remote_request" => "远端操作参数无效，本次操作尚未发送。",
        "invalid_selection" | "selection_expands" => "远端文件状态已变化或选择范围不完整。",
        "index_locked" => "远端 Git 正在写入暂存区，请等待后刷新。",
        "nothing_staged" => "远端暂存区没有可提交的内容。",
        "unmerged" | "git_operation_active" => "远端存在进行中的 Git 操作或冲突，请先处理。",
        "hook_failed" => "远端的 Git hook 拒绝了此次提交。",
        _ => {
            return AppError::new(
                "ssh_failed",
                "SSH 连接未完成。请检查主机、认证和已信任的主机密钥。",
            )
        }
    };
    AppError::new(code, message)
}

fn connector_marker(path: &Path) -> bool {
    use std::io::Read;
    const MARKER: &[u8] = b"cliora-twiglane-connector-v1";
    const CHUNK: usize = 64 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut bytes = vec![0; CHUNK + MARKER.len()];
    let mut prefix = 0;
    loop {
        let Ok(count) = file.read(&mut bytes[prefix..]) else {
            return false;
        };
        if count == 0 {
            return false;
        }
        let size = prefix + count;
        if bytes[..size]
            .windows(MARKER.len())
            .any(|window| window == MARKER)
        {
            return true;
        }
        prefix = (MARKER.len() - 1).min(size);
        bytes.copy_within(size - prefix..size, 0);
    }
}

async fn connector() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TWIGLANE_CLIORA_CONNECTOR").map(PathBuf::from) {
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
    }

    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let path = "Cliora.app/Contents/MacOS/cliora";
        candidates.push(Path::new("/Applications").join(path));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications").join(path));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_local_dir() {
            candidates.push(local.join("Cliora").join("cliora.exe"));
            candidates.push(local.join("Programs").join("Cliora").join("cliora.exe"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("Cliora")
                    .join("cliora.exe"),
            );
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push(PathBuf::from("/usr/bin/cliora"));
        candidates.push(PathBuf::from("/usr/local/bin/cliora"));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin/cliora"));
        }
    }
    tokio::task::spawn_blocking(move || {
        candidates
            .into_iter()
            .find(|path| path.is_file() && connector_marker(path))
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(|| {
        AppError::new(
            "cliora_unavailable",
            "请安装支持 Twiglane 远端连接的 Cliora。",
        )
    })
}

fn command(path: &Path, action: &str, target: Option<&Target>) -> Command {
    let mut cmd = Command::new(path);
    cmd.args([FLAG, action]).kill_on_drop(true);
    if let Some(target) = target {
        cmd.args([target.target_id.as_str(), target.target_revision.as_str()]);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

fn output_error(stderr: &[u8]) -> AppError {
    for line in stderr.rsplit(|&byte| byte == b'\n') {
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            if let Some(code) = value.get("error").and_then(Value::as_str) {
                return remote_error(code);
            }
        }
        if line.windows(20).any(|part| part == b"Permission denied (p") {
            return AppError::new("ssh_auth_failed", "SSH 认证失败，请检查主机的密钥或密码。");
        }
    }
    remote_error("ssh_failed")
}

async fn bounded_output<A: tokio::io::AsyncRead + Unpin>(pipe: A, limit: u64) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    pipe.take(limit + 1)
        .read_to_end(&mut data)
        .await
        .map_err(|_| remote_error("ssh_failed"))?;
    if data.len() > limit as usize {
        return Err(AppError::new("remote_protocol", "连接工具的响应超过限制。"));
    }
    Ok(data)
}

async fn query(path: &Path, action: &str, target: Option<&Target>) -> Result<Value> {
    let mut cmd = command(path, action, target);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ScopedChild::spawn(&mut cmd).map_err(|_| remote_error("ssh_failed"))?;
    let stdout = child.take_stdout().unwrap();
    let stderr = child.take_stderr().unwrap();
    let (stdout, stderr, status) = tokio::time::timeout(Duration::from_secs(120), async {
        let wait = async { child.wait().await.map_err(|_| remote_error("ssh_failed")) };
        tokio::try_join!(
            bounded_output(stdout, 4 * 1024 * 1024),
            bounded_output(stderr, 64 * 1024),
            wait
        )
    })
    .await
    .map_err(|_| AppError::new("remote_timeout", "等待 SSH 响应超时。"))??;
    if !status.success() {
        return Err(output_error(&stderr));
    }
    serde_json::from_slice(&stdout).map_err(|_| {
        AppError::new(
            "cliora_incompatible",
            "需要安装支持 Twiglane 远端连接的 Cliora 版本。",
        )
    })
}

async fn list(path: &Path) -> Result<Vec<Target>> {
    let value = query(path, "list", None).await?;
    if value.get("protocol").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::new(
            "cliora_incompatible",
            "需要更新 Cliora 连接工具。",
        ));
    }
    let mut targets: Vec<Target> = serde_json::from_value(value["targets"].clone())
        .map_err(|_| AppError::new("remote_protocol", "Cliora 返回的主机列表格式无效。"))?;
    for unavailable in value["unavailable"].as_array().into_iter().flatten() {
        if let (Some(id), Some(name)) = (
            unavailable["targetId"].as_str(),
            unavailable["name"].as_str(),
        ) {
            targets.push(Target {
                target_id: id.into(),
                name: name.into(),
                target_revision: String::new(),
                host: String::new(),
                user: String::new(),
                port: 0,
                auth_method: String::new(),
                default_path: None,
                effective_host: None,
                unavailable_reason: Some(
                    "SSH 配置或主机信任信息无法读取，请在 Cliora 检查。".into(),
                ),
            });
        }
    }
    Ok(targets)
}

fn publish(
    channel: &Channel<Progress>,
    phase: &'static str,
    sent: Option<u64>,
    total: Option<u64>,
) {
    let _ = channel.send(Progress {
        phase,
        sent_bytes: sent,
        total_bytes: total,
    });
}

fn source_signature() -> Option<&'static str> {
    SIGNATURE
        .filter(|value| !value.is_empty())
        .or(if cfg!(debug_assertions) {
            Some("development")
        } else {
            None
        })
}

async fn upload(
    path: &Path,
    target: &Target,
    digest: &str,
    signature: &str,
    progress: &Channel<Progress>,
) -> Result<()> {
    publish(progress, "installing", Some(0), Some(AGENT.len() as u64));
    let mut cmd = command(path, "install", Some(target));
    cmd.args([digest, signature])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ScopedChild::spawn(&mut cmd).map_err(|_| remote_error("ssh_failed"))?;
    let mut stdin = child.take_stdin().unwrap();
    let stdout = child.take_stdout().unwrap();
    let stderr = child.take_stderr().unwrap();
    // Own the pipe so completing the write delivers EOF to the installer.
    let write = async move {
        stdin
            .write_all(AGENT)
            .await
            .map_err(|_| remote_error("ssh_failed"))
    };
    let progress_output = async {
        let stdout = stdout.take(128 * 1024);
        let mut lines = BufReader::new(stdout).lines();
        let mut installed = false;
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|_| remote_error("ssh_failed"))?
        {
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| AppError::new("remote_protocol", "远端安装回执格式无效。"))?;
            if let Some(received) = value["receivedBytes"].as_u64() {
                if received <= AGENT.len() as u64 {
                    publish(
                        progress,
                        "installing",
                        Some(received),
                        Some(AGENT.len() as u64),
                    );
                }
            } else if value["installed"].as_bool() == Some(true) {
                installed = value["agentSha256"].as_str() == Some(digest);
            }
        }
        Ok(installed)
    };
    let (write_result, installed, stderr, status) = tokio::join!(
        write,
        progress_output,
        bounded_output(stderr, 64 * 1024),
        child.wait()
    );
    let status = status.map_err(|_| remote_error("ssh_failed"))?;
    if !status.success() {
        return Err(output_error(&stderr?));
    }
    write_result?;
    if installed? {
        return Ok(());
    }
    Err(AppError::new(
        "remote_protocol",
        "远端安装尚未产生可核实的回执。",
    ))
}

fn start(path: &Path, target: &Target, digest: &str, signature: &str) -> Result<AgentTransport> {
    let mut cmd = command(path, "connect", Some(target));
    cmd.args([digest, signature]);
    AgentTransport::spawn(&mut cmd)
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn valid_path(value: &str, absolute: bool) -> bool {
    (value.starts_with('/') == absolute)
        && !value.is_empty()
        && !value.contains('\0')
        && value.len() <= 4096
}

fn probe_identity(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| {
            AppError::new(
                "cliora_incompatible",
                "请更新 Cliora，以核对实际 SSH 主机身份。",
            )
        })
}

/// 本机有 v2 产物却握不上手：这是明确的协议不匹配，既不回退 v1，也不伪造安装提示。
fn protocol_mismatch() -> AppError {
    AppError::new(
        "remote_protocol_mismatch",
        "远端组件与本次会话的协议版本不一致，已停止打开；请更新或重新安装远端组件。",
    )
}

/// 一次 v2 打开计划：本机主机簿里的目标、远端已安装摘要与选中的产物。
struct V2Plan {
    host: crate::state::SshTarget,
    installed: Option<String>,
    artifact: AgentArtifact,
}

/// 决定这次打开能不能走 v2。返回 `Ok(None)` 表示「本机不具备 v2 条件」，由内嵌 v1 接手：
/// 主机不在自有主机簿（或总开关关闭）、自有 SSH 连不上、本机没有该远端架构的产物。
/// 一旦确认要用本机 v2 组件，后面的失败都是明确错误，不再回退、也不伪造安装提示。
async fn plan_v2(access: &V2Access<'_>, dir: &Path, target_id: &str) -> Result<Option<V2Plan>> {
    let Some(host) = remote_ssh::shared_target(access.store, target_id) else {
        return Ok(None);
    };
    // 自有 SSH 连不上不等于 v2 组件有问题：这条主机可能还能经 Cliora 走 v1。
    let Ok(probe) = remote_ssh::probe_agent(access.store, access.ssh, &host).await else {
        return Ok(None);
    };
    // 远端自述的平台必须与探测到的 uname 一致，否则装的是另一台机器的组件。
    if let Some(agent) = &probe.agent {
        let declared = remote_ssh::platform(
            agent["os"].as_str().unwrap_or_default(),
            agent["arch"].as_str().unwrap_or_default(),
        );
        let probed = remote_ssh::platform(&probe.system, &probe.architecture);
        if declared.is_none() || declared != probed {
            return Err(AppError::new(
                "remote_protocol_mismatch",
                "远端已安装的组件不是这台主机的平台，请先重新安装远端组件。",
            ));
        }
    }
    // 本机没有这个远端架构的产物：回退内嵌 v1，并且一个字节都没有上传。
    let Ok(artifact) = remote_ssh::select_agent(dir, &probe.system, &probe.architecture) else {
        return Ok(None);
    };
    Ok(Some(V2Plan {
        host,
        installed: probe.digest,
        artifact,
    }))
}

async fn connect(
    path: &Path,
    request: &OpenRequest,
    confirm: Option<InstallTarget>,
    source: Option<&review::Source>,
    progress: &Channel<Progress>,
    v2: Option<&V2Access<'_>>,
) -> Result<Opened> {
    publish(progress, "connecting", None, None);
    let target = list(path)
        .await?
        .into_iter()
        .find(|target| target.target_id == request.target_id)
        .ok_or_else(|| remote_error("target_unavailable"))?;
    if let Some(reason) = &target.unavailable_reason {
        return Err(AppError::new("target_unavailable", reason));
    }
    if target.target_revision != request.target_revision {
        return Err(remote_error("target_changed"));
    }
    let probe = query(path, "probe", Some(&target)).await?;
    if !matches!(probe["system"].as_str(), Some("Linux" | "Darwin")) {
        return Err(AppError::new(
            "remote_unsupported",
            "远端需要 Linux 或 macOS 与系统 Git。",
        ));
    }
    // Python 只是 v1 组件（Python 脚本）的要求：v2 是原生组件，不该被它拦住。
    let python_ready = probe["pythonVersion"]
        .as_str()
        .and_then(|version| {
            let mut parts = version.split('.');
            Some((
                parts.next()?.parse::<u32>().ok()?,
                parts.next()?.parse::<u32>().ok()?,
            ))
        })
        .is_some_and(|version| version >= (3, 8));
    let peer = probe_identity(&probe["peerRevision"])?;
    let peer_identity = probe_identity(&probe["peerIdentity"])?.to_owned();
    if let Some(source) = source {
        source.check_peer(peer, &peer_identity)?;
    }
    // 组件来源：本机有 v2 产物且会话不需要基线时优先 v2；审查与任务基线只有 v1 支持。
    let forced_v1 = request.review_id.is_some() || request.baseline.is_some();
    let mut plan = None;
    if let Some(access) = v2 {
        if !forced_v1 {
            if let Provider::V2 { dir } =
                select_provider(access.v2_dir.clone(), Some(access.ssh.artifacts()))
            {
                plan = plan_v2(access, &dir, &target.target_id).await?;
            }
        }
    }
    let kind = if plan.is_some() {
        AgentKind::V2
    } else {
        AgentKind::V1
    };
    // 安装提示里的版本与字节数按实际 provider 取，不再写死 v1。
    let (version, size) = match &plan {
        Some(plan) => (plan.artifact.version.clone(), plan.artifact.bytes.len() as u64),
        None => (V1_VERSION.to_string(), AGENT.len() as u64),
    };
    let selected = InstallTarget {
        provider: kind,
        review_id: request.review_id.clone(),
        target_id: target.target_id.clone(),
        revision: target.target_revision.clone(),
        peer: peer.to_owned(),
        path: request.path.clone(),
        version: version.clone(),
        size,
    };
    if request.allow_install && confirm.as_ref() != Some(&selected) {
        return Err(AppError::new(
            "target_changed",
            "安装目标已变化，请重新打开并确认。",
        ));
    }
    let mut bound_target = target.clone();
    bound_target.target_revision = selected.peer.clone();
    let mut agent: Option<AgentTransport> = None;
    let mut session_dir: Option<tempfile::TempDir> = None;
    // 实际组件版本：v2 取握手自述，v1 固定为内嵌组件标签。
    let agent_version: String;
    if let Some(plan) = &plan {
        let access = v2.expect("v2 计划只能来自 v2 会话入口");
        if plan.installed.as_deref() != Some(plan.artifact.sha256.as_str()) {
            if !request.allow_install {
                return Ok(Opened::NeedsInstall(selected));
            }
            // 用户已确认这一次安装：按摘要上传，远端核对后才原子替换。
            tokio::time::timeout(
                Duration::from_secs(600),
                remote_ssh::install_artifact(
                    access.store,
                    access.ssh,
                    &plan.host,
                    &plan.artifact,
                    &|sent, total| {
                        let _ = progress.send(Progress {
                            phase: "installing",
                            sent_bytes: Some(sent),
                            total_bytes: Some(total),
                        });
                    },
                ),
            )
            .await
            .map_err(|_| AppError::new("remote_timeout", "远端组件传输超时，可以重试。"))??;
        }
        let session =
            remote_ssh::open_session(access.store, access.ssh, &plan.host, &plan.artifact.sha256)
                .await?;
        let hello = tokio::time::timeout(
            Duration::from_secs(120),
            session.transport.rpc("hello", json!({})),
        )
        .await
        .map_err(|_| AppError::new("remote_timeout", "等待远端组件握手超时。"))?;
        // 本机有 v2 产物却握不上手：明确报协议不匹配，不改走 v1、也不伪造安装提示。
        let hello = hello.map_err(|_| protocol_mismatch())?;
        if hello["protocol"].as_u64() != Some(2) {
            session.transport.close().await;
            return Err(protocol_mismatch());
        }
        agent_version = hello["version"]
            .as_str()
            .filter(|version| !version.is_empty())
            .unwrap_or(&plan.artifact.version)
            .to_string();
        agent = Some(session.transport);
        session_dir = Some(session.folder);
    } else {
        if !python_ready {
            return Err(AppError::new(
                "remote_unsupported",
                "这个远端需要用 Python 3.8 及以上运行内嵌组件，请升级远端 Python 或更新远端组件。",
            ));
        }
        let expected = format!("{:x}", Sha256::digest(AGENT));
        let installed = probe["agentSha256"]
            .as_str()
            .zip(probe["agentSignature"].as_str());
        if let Some((digest, signature)) = installed {
            let compatible =
                signature != "development" || (cfg!(debug_assertions) && digest == expected);
            if compatible {
                let existing = start(path, &bound_target, digest, signature)?;
                let hello = tokio::time::timeout(
                    Duration::from_secs(120),
                    existing.rpc("hello", json!({})),
                )
                .await
                .map_err(|_| AppError::new("remote_timeout", "等待远端组件握手超时。"))?;
                if hello
                    .as_ref()
                    .is_ok_and(|value| value["protocol"].as_u64() == Some(1))
                {
                    agent = Some(existing);
                }
            }
        }
        if agent.is_none() {
            let signature = source_signature().ok_or_else(|| {
                AppError::new(
                    "agent_signature_missing",
                    "当前 Twiglane 构建缺少远端组件的发布证明。",
                )
            })?;
            if !request.allow_install {
                return Ok(Opened::NeedsInstall(selected));
            }
            tokio::time::timeout(
                Duration::from_secs(600),
                upload(path, &bound_target, &expected, signature, progress),
            )
            .await
            .map_err(|_| AppError::new("remote_timeout", "远端组件传输超时，可以重试。"))??;
            agent = Some(start(path, &bound_target, &expected, signature)?);
        }
        agent_version = V1_VERSION.to_string();
    }
    let agent = agent.unwrap();
    let protocol = agent.protocol();
    publish(progress, "opening", None, None);
    let mut fields = json!({"path":request.path});
    if let Some(baseline) = &request.baseline {
        fields["baseline"] = json!(baseline);
    }
    let snapshot = tokio::time::timeout(Duration::from_secs(120), agent.rpc("open", fields))
        .await
        .map_err(|_| AppError::new("remote_timeout", "等待远端仓库状态超时。"))??;
    let repo = snapshot["repo"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let root = snapshot["root"]
        .as_str()
        .filter(|value| valid_path(value, true))
        .map(str::to_string);
    // 块级暂存必须由远端自己声明：v1 组件没有 `patch`，`capabilities` 缺省即不支持。
    let hunk_stageable = snapshot["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some("patch")));
    if let Some(source) = source {
        source.check_tree(root.as_deref().unwrap_or_default(), repo.as_deref().unwrap_or_default())?;
    }
    let (Some(repo), Some(root)) = (repo, root) else {
        return Err(AppError::new(
            "remote_protocol",
            "远端返回的工作树标识无效。",
        ));
    };
    let session = Session {
        review_id: request.review_id.clone(),
        peer_revision: peer.to_owned(),
        agent,
        repo,
        root,
        target,
        peer_identity,
        baseline: request.baseline.clone(),
        hunk_stageable,
        agent_version,
        state_token: Mutex::new(None),
        _session_dir: session_dir,
    };
    // 写入令牌随每次 open/status/diff 刷新；v1 的响应里没有这个字段。
    session.remember_state(&snapshot);
    let view = if protocol == 2 {
        flatten_v2(&snapshot)?
    } else {
        snapshot
    };
    Ok(Opened::Worktree(Box::new(session), view))
}

fn read_pending(path: &Path, repo: &str) -> Result<Option<Pending>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let pending: Pending = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::new("remote_journal", "远端操作记录无法读取。"))?;
            if pending.repo != repo {
                return Err(AppError::new(
                    "target_changed",
                    "远端目录有来自另一工作树的待确认操作。",
                ));
            }
            Ok(Some(pending))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(AppError::new(
            "remote_journal",
            "无法读取本机保存的远端操作记录。",
        )),
    }
}

fn save_pending(path: &Path, pending: &Pending) -> Result<()> {
    let bytes = serde_json::to_vec(pending)
        .map_err(|_| AppError::new("remote_journal", "无法编码操作记录。"))?;
    crate::atomic::atomic_write(path, &bytes)
        .map_err(|_| AppError::new("remote_journal", "无法持久保存操作记录。"))
}

#[tauri::command]
pub async fn remote_worktree_targets() -> Result<Vec<Target>> {
    list(&connector().await?).await
}

#[tauri::command]
pub async fn remote_worktree_open(
    state: Managed<'_>,
    // 本机 v2 组件要经自有主机簿与自有 SSH 规则拉起，因此这条命令拿得到这两份状态；
    // 前端契约不变（State 参数由 Tauri 注入，不进入 invoke 参数）。
    backend: State<'_, Arc<crate::git::ops::Backend>>,
    ssh: State<'_, Arc<RemoteSsh>>,
    request: OpenRequest,
    on_progress: Channel<Progress>,
) -> Result<Value> {
    if !uuid(&request.request_id) || !valid_path(&request.path, true) {
        return Err(AppError::new("invalid_path", "请选择有效的远端绝对目录。"));
    }
    let source = request
        .review_id
        .as_deref()
        .map(|id| state.reviews.lock().unwrap().source(id))
        .transpose()?;
    if let Some(source) = &source {
        source.check_request(&request)?;
    }
    let review_id = request.review_id.clone();
    let key = request.request_id.clone();
    let confirm = if request.allow_install {
        request
            .install_confirmation
            .as_deref()
            .and_then(|id| state.installs.lock().unwrap().remove(id))
    } else {
        None
    };
    let join = {
        let mut openings = state.openings.lock().unwrap();
        if openings.contains_key(&key) || openings.len() >= 4 {
            return Err(AppError::new("remote_busy", "其他远端连接仍在进行。"));
        }
        // 状态句柄不能跨线程：先把 Arc 复制进任务，再在任务里借出。
        let backend = Arc::clone(backend.inner());
        let ssh = Arc::clone(ssh.inner());
        let join = tokio::spawn(async move {
            let path = connector().await?;
            let access = V2Access::new(&backend.store, &ssh);
            connect(
                &path,
                &request,
                confirm,
                source.as_ref(),
                &on_progress,
                Some(&access),
            )
            .await
        });
        openings.insert(key.clone(), join.abort_handle());
        join
    };
    let response = join.await;
    let mut openings = state.openings.lock().unwrap();
    if openings.remove(&key).is_none() {
        return Err(AppError::new("remote_cancelled", "远端打开操作已取消。"));
    }
    let response =
        response.map_err(|_| AppError::new("remote_cancelled", "远端打开操作已取消。"))??;
    // A cancelled/rejected review cannot leave an orphan session or a usable
    // install offer if its asynchronous connection completes afterwards.
    if let Some(id) = review_id {
        state.reviews.lock().unwrap().source(&id)?;
    }
    let (session, snapshot) = match response {
        Opened::Worktree(session, snapshot) => (session, snapshot),
        Opened::NeedsInstall(offer) => {
            let mut installs = state.installs.lock().unwrap();
            // The UI carries only one offer. Keep a small bounded set for resumed requests.
            if installs.len() >= 16 {
                installs.clear();
            }
            let id = Uuid::new_v4().to_string();
            // 版本与字节数按实际 provider 取：本机有 v2 产物时不再谎称要装 v1。
            let version = offer.version.clone();
            let size = offer.size;
            installs.insert(id.clone(), offer);
            return Ok(json!({
                "kind":"install_required",
                "version":version,
                "size":size,
                "confirmationId":id,
            }));
        }
    };
    let pending = {
        let _guard = state.mutations.lock().unwrap();
        read_pending(&session.journal(&state.data), &session.repo)?
    };
    // 打开的仓库带着实际组件身份：界面与排查都不用猜是 v1 还是 v2。
    let protocol = session.protocol();
    let agent_version = session.agent_version.clone();
    let session_id = Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::from(session));
    Ok(json!({
        "kind":"open",
        "sessionId":session_id,
        "snapshot":snapshot,
        "pendingWrite":pending,
        "protocol":protocol,
        "agentVersion":agent_version,
    }))
}

#[tauri::command]
pub fn remote_worktree_cancel_open(state: Managed<'_>, request_id: String) {
    if let Some(abort) = state.openings.lock().unwrap().remove(&request_id) {
        abort.abort();
    }
}

#[tauri::command]
pub async fn remote_worktree_close(state: Managed<'_>, session_id: String) -> Result<()> {
    let session = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(session) = session {
        session.agent.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_worktree_status(state: Managed<'_>, session_id: String) -> Result<Value> {
    state.session(&session_id)?.status().await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    session_id: String,
    generation: String,
    path: String,
    view: String,
    cursor: Option<String>,
}

/// 差异载荷里的块级可暂存标记：只由远端声明的能力和视图决定，界面不自行推断。
///
/// `task` 是只读视图（审查基线），即使远端支持按块写入也不能暂存。
fn annotate_diff(session: &Session, view: &str, mut result: Value) -> Value {
    let stageable = session.hunk_stageable && view != "task";
    let reason = if stageable {
        None
    } else if view == "task" {
        Some("任务差异是只读视图，不能暂存。")
    } else {
        Some("当前远端组件只支持整文件暂存，请更新远端组件后重试。")
    };
    if let Value::Object(map) = &mut result {
        map.insert("hunksStageable".into(), json!(stageable));
        map.insert("hunksStageableReason".into(), json!(reason));
    }
    result
}

async fn diff_call(state: &RemoteWorktrees, request: DiffRequest) -> Result<Value> {
    let session = state.session(&request.session_id)?;
    if !valid_path(&request.path, false)
        || !matches!(request.view.as_str(), "staged" | "unstaged" | "task")
    {
        return Err(AppError::new(
            "invalid_selection",
            "请选择远端工作树内的改动文件。",
        ));
    }
    if session.protocol() == 2 {
        return diff_v2(&session, &request).await;
    }
    let mut fields = json!({
        "repo": session.repo, "generation": request.generation, "path": request.path, "view": request.view,
    });
    if request.view == "task" {
        let baseline = session
            .baseline
            .as_deref()
            .ok_or_else(|| AppError::new("invalid_baseline", "这次审查没有可用的任务起点。"))?;
        fields["baseline"] = json!(baseline);
    }
    if let Some(cursor) = request.cursor {
        fields["cursor"] = json!(cursor);
    }
    let result = session.agent.rpc("diff", fields).await?;
    Ok(annotate_diff(&session, &request.view, result))
}

/// v2 的差异：远端给的是结构化 `DiffResponse`，这里渲染回前端已经在解析的 unified 文本，
/// 分页、块索引与块标记都沿用同一条路径。任务视图（基线）只有 v1 支持，不会走到这里。
async fn diff_v2(session: &Session, request: &DiffRequest) -> Result<Value> {
    let cursor = request.cursor.as_deref();
    let offset = cursor.map(v2_cursor_offset).transpose()?.unwrap_or(0);
    let mut fields = json!({
        "repo": session.repo,
        "path": request.path,
        "view": request.view,
        "offset": offset,
        "limit": V2_DIFF_PAGE_LINES,
    });
    // 对端游标绑定了仓库状态令牌与选择：原样回传让它重新校验，状态已变就明确报错，
    // 而不是拿一个偏移静默读出另一段内容。本地偏移游标没有可校验的令牌，只发偏移。
    if let Some(cursor) = cursor.filter(|cursor| !cursor.starts_with(V2_CURSOR_PREFIX)) {
        fields["cursor"] = json!(cursor);
    }
    let result = session.agent.rpc("diff", fields).await?;
    session.remember_state(&result);
    let diff = result.get("diff").cloned().unwrap_or_else(|| json!({}));
    let (text, next) = v2_diff_page(
        &diff,
        result.get("nextCursor").and_then(Value::as_str),
        offset,
    );
    let page = json!({
        "data": base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
        "nextCursor": next,
    });
    Ok(annotate_diff(session, &request.view, page))
}

#[tauri::command]
pub async fn remote_worktree_diff(state: Managed<'_>, request: DiffRequest) -> Result<Value> {
    diff_call(&state, request).await
}

/* ------------------------------------------------------------------ *
 * 通用桥接：一条远端命令覆盖 agent v2 的其余 Git 能力
 *
 * 白名单与 agent v2 的 CAPABILITIES 同名，分成只读与写入两组：
 * - 只读 op 直通，不写待确认记录；
 * - 写入 op 复用 journal + finish_write，先记待确认，只有明确未生效才清记录，
 *   没有可核对的回执一律 unknown。
 * 未列入白名单的 op 返回 remote_unsupported；参数里出现程序、命令、shell、
 * 工作目录或环境变量一律 invalid_request —— 桥接不引入任何任意执行面。
 * ------------------------------------------------------------------ */

/// 只读 op：与 agent v2 的只读入口同名，直接转发 `fields`。
const BRIDGE_READ_OPS: &[&str] = &[
    "history",
    "fileHistory",
    "commitDetail",
    "commitDiff",
    "compare",
    "commitBranches",
    "compareFileDiff",
    "branchList",
    "branchState",
    "branchTracking",
    "tagState",
    "tagRemoteState",
    "remoteState",
    "stashState",
    "mergePreview",
    "mergeSession",
    "conflictView",
    "worktrees",
];

/// 写入 op：每类写入自成一类回执，因此 op 名原样进入 journal，不作为「同类」合并。
const BRIDGE_WRITE_OPS: &[&str] = &[
    "branchCreate",
    "branchSwitch",
    "branchRename",
    "branchDelete",
    "branchTrack",
    "branchUpdate",
    "branchPublish",
    "tagCreate",
    "tagDelete",
    "tagPush",
    "remoteAdd",
    "remoteSetUrl",
    "fetch",
    "pull",
    "push",
    "pushToRemote",
    "publishBranch",
    "stashSave",
    "stashApply",
    "stashDelete",
    "mergeStart",
    "mergeComplete",
    "mergeAbort",
    "resolveConflict",
    "cherryPick",
    "revert",
    "undoCommit",
    "checkoutCommit",
    "amendCommit",
    "discard",
    "worktreeRemove",
];

/// 桥接参数里永远不允许出现的字段：普通 Git RPC 也照样拒绝这些名字。
const BRIDGE_FORBIDDEN_FIELDS: &[&str] = &[
    "program", "command", "shell", "cwd", "env", "args", "id", "v", "op",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeKind {
    Read,
    Write,
}

fn bridge_kind(op: &str) -> Result<BridgeKind> {
    if BRIDGE_READ_OPS.contains(&op) {
        Ok(BridgeKind::Read)
    } else if BRIDGE_WRITE_OPS.contains(&op) {
        Ok(BridgeKind::Write)
    } else {
        Err(AppError::new(
            "remote_unsupported",
            "这项远端操作还没有接通，没有在本机回退执行。",
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRequest {
    session_id: String,
    op: String,
    #[serde(default)]
    fields: Value,
    generation: Option<String>,
}

/// 组装转发字段：仓库键由会话决定，调用方给的 `repo` 一律被覆盖；
/// 出现禁用字段则整条拒绝，不做「静默忽略」。只读时不带 `operationId`。
fn bridge_fields(session: &Session, request: &CallRequest) -> Result<Value> {
    let mut fields = match request.fields.clone() {
        Value::Object(fields) => fields,
        Value::Null => serde_json::Map::new(),
        _ => {
            return Err(AppError::new(
                "invalid_request",
                "远端操作参数必须是对象。",
            ))
        }
    };
    if BRIDGE_FORBIDDEN_FIELDS
        .iter()
        .any(|name| fields.contains_key(*name))
    {
        return Err(AppError::new(
            "invalid_request",
            "远端操作参数包含不允许的字段（程序、命令、shell、工作目录或环境变量）。",
        ));
    }
    fields.insert("repo".into(), json!(session.repo));
    if let Some(generation) = &request.generation {
        if session.protocol() == 2 {
            // v2 的 generation 只能是数字：解析不了就不发，绝不把字符串 generation 送到远端。
            if let Ok(value) = generation.parse::<u64>() {
                fields.insert("generation".into(), json!(value));
            }
        } else {
            fields.insert("generation".into(), json!(generation));
        }
    }
    Ok(Value::Object(fields))
}

async fn bridge_call(state: &RemoteWorktrees, request: CallRequest) -> Result<Value> {
    let session = state.session(&request.session_id)?;
    let kind = bridge_kind(&request.op)?;
    let fields = bridge_fields(&session, &request)?;
    if let Some(id) = &session.review_id {
        state
            .reviews
            .lock()
            .unwrap()
            .check_bound(id, &request.session_id, &session)?;
    }
    if kind == BridgeKind::Read {
        return session.agent.rpc(&request.op, fields).await;
    }
    let operation_id = Uuid::new_v4().to_string();
    let mut fields = fields;
    fields["operationId"] = json!(operation_id);
    // v2 写入要带最新的状态令牌；没有令牌就不发，免得远端把它当成过期请求。
    if !session.with_generation(&mut fields, None) {
        return Err(AppError::new(
            "stale_state",
            "远端状态令牌缺失，请刷新后重试。",
        ));
    }
    let pending = Pending {
        review_id: session.review_id.clone(),
        operation_id,
        op: request.op,
        repo: session.repo.clone(),
    };
    let journal = session.journal(&state.data);
    {
        let _guard = state.mutations.lock().unwrap();
        // 已有待确认记录时不再发第二条写入：结果未知的写入只能先核对。
        if read_pending(&journal, &session.repo)?.is_some() {
            return Ok(unknown(&pending.operation_id));
        }
        save_pending(&journal, &pending)?;
    }
    let response = session.agent.rpc(&pending.op, fields).await;
    finish_write(state, &session, &journal, &pending, response).await
}

#[tauri::command]
pub async fn remote_worktree_call(state: Managed<'_>, request: CallRequest) -> Result<Value> {
    bridge_call(&state, request).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    session_id: String,
    generation: String,
    operation_id: String,
    op: WriteKind,
    path: Option<String>,
    message: Option<String>,
}

fn unknown(operation_id: &str) -> Value {
    json!({"state":"unknown","operationId":operation_id,"message":"远端操作结果待确认，请重新连接并核对。"})
}

fn definitive_error(code: &str) -> bool {
    matches!(
        code,
        "remote_busy"
            | "remote_not_sent"
            | "remote_request"
            | "remote_request_size"
            | "bad_request"
            | "invalid_path"
            | "invalid_selection"
            | "selection_expands"
            | "stale_state"
            | "index_locked"
            | "nothing_staged"
            | "unmerged"
            | "git_operation_active"
            | "hook_failed"
            | "empty_message"
            // 远端组件明确说「没有这个操作」或在执行前拒绝：请求没有生效，不算结果未知。
            // 这里同时收 v1/v2 的原始码与翻译后的码，避免先在 remote_error 里翻过一遍而漏判。
            | "remote_unsupported"
            | "unsupported_operation"
            | "unsupported_capability"
            | "state_mismatch"
            | "operation_conflict"
            | "invalid_operation"
            | "invalid_patch"
    )
}

/// 一次写入的回执证据：v1 组件把 `operationId`/`state` 放在响应顶层，
/// v2 组件把它放在 `receipt` 里。两种形态都要能核对，不能只看一种就当成功。
struct WriteProof<'a> {
    operation_id: &'a str,
    state: &'a str,
    head: Option<&'a str>,
    branch: Option<&'a str>,
    reason: Option<&'a str>,
}

fn write_proof(response: &Value) -> Option<WriteProof<'_>> {
    if let (Some(operation_id), Some(state)) = (
        response["operationId"].as_str(),
        response["state"].as_str(),
    ) {
        return Some(WriteProof {
            operation_id,
            state,
            head: response["head"].as_str(),
            branch: response["branch"].as_str(),
            reason: response["reason"].as_str(),
        });
    }
    let receipt = response.get("receipt")?;
    Some(WriteProof {
        operation_id: receipt["operationId"].as_str()?,
        state: receipt["state"].as_str()?,
        head: receipt["head"].as_str(),
        branch: receipt["branch"].as_str(),
        reason: receipt["reason"].as_str(),
    })
}

async fn finish_write(
    state: &RemoteWorktrees,
    session: &Session,
    journal: &Path,
    pending: &Pending,
    response: Result<Value>,
) -> Result<Value> {
    let proven_commit = pending.op == "commit"
        && response
            .as_ref()
            .is_ok_and(|r| r["op"] == "commit" || r["receipt"]["op"] == "commit");
    let completed = match response {
        Ok(response) => {
            let Some(proof) = write_proof(&response).filter(|proof| {
                proof.operation_id == pending.operation_id
                    && response["repo"].as_str().is_none_or(|repo| repo == session.repo)
            }) else {
                return Ok(unknown(&pending.operation_id));
            };
            match proof.state {
                "completed" => {
                    let Ok(snapshot) = session.status().await else {
                        return Ok(unknown(&pending.operation_id));
                    };
                    if snapshot["head"].as_str() != proof.head
                        || snapshot["branch"].as_str() != proof.branch
                    {
                        return Ok(unknown(&pending.operation_id));
                    }
                    json!({"state":"completed","operationId":pending.operation_id,"snapshot":snapshot,"head":snapshot["head"]})
                }
                "failed" => {
                    let error = remote_error(proof.reason.unwrap_or("ssh_failed"));
                    json!({"state":"failed","operationId":pending.operation_id,"message":error.message})
                }
                _ => return Ok(unknown(&pending.operation_id)),
            }
        }
        Err(error) if definitive_error(&error.code) => {
            json!({"state":"failed","operationId":pending.operation_id,"message":remote_error(&error.code).message})
        }
        _ => return Ok(unknown(&pending.operation_id)),
    };
    let _guard = state.mutations.lock().unwrap();
    if read_pending(journal, &session.repo)?
        .is_some_and(|value| value.operation_id == pending.operation_id)
        && std::fs::remove_file(journal).is_err()
    {
        return Ok(unknown(&pending.operation_id));
    }
    if proven_commit && completed["state"] == "completed" {
        if let (Some(id), Some(head)) = (&pending.review_id, completed["head"].as_str()) {
            state
                .reviews
                .lock()
                .unwrap()
                .record_commit(id, session, head);
        }
    }
    Ok(completed)
}

#[tauri::command]
pub async fn remote_worktree_write(state: Managed<'_>, request: WriteRequest) -> Result<Value> {
    let session = state.session(&request.session_id)?;
    let fail = |message: &str| json!({"state":"failed","operationId":request.operation_id,"message":message});
    if !uuid(&request.operation_id) {
        return Ok(fail("远端操作标识无效。"));
    }
    let mut fields = json!({"repo":session.repo,"operationId":request.operation_id});
    // v1 用字符串 generation；v2 只带最新 stateToken（必要时把 generation 转成数字）。
    if !session.with_generation(&mut fields, Some(&request.generation)) {
        return Ok(fail("远端状态令牌缺失，请刷新后重试。"));
    }
    match request.op {
        WriteKind::Stage | WriteKind::Unstage => {
            let Some(path) = request
                .path
                .as_deref()
                .filter(|path| valid_path(path, false))
            else {
                return Ok(fail("请选择远端工作树内的改动文件。"));
            };
            fields["paths"] = json!([path]);
        }
        WriteKind::Commit => {
            let Some(message) = request.message.as_deref().filter(|text| {
                !text.trim().is_empty() && !text.contains('\0') && text.len() <= 32768
            }) else {
                return Ok(fail("请输入有效的提交说明。"));
            };
            fields["message"] = json!(message);
        }
    }
    let journal = session.journal(&state.data);
    if let Some(id) = &session.review_id {
        state
            .reviews
            .lock()
            .unwrap()
            .check_bound(id, &request.session_id, &session)?;
    }
    let pending = Pending {
        review_id: session.review_id.clone(),
        operation_id: request.operation_id,
        op: request.op.name().to_owned(),
        repo: session.repo.clone(),
    };
    {
        let _guard = state.mutations.lock().unwrap();
        if read_pending(&journal, &session.repo)?.is_some() {
            return Ok(unknown(&pending.operation_id));
        }
        save_pending(&journal, &pending)?;
    }
    let response = session.agent.rpc(request.op.name(), fields).await;
    finish_write(&state, &session, &journal, &pending, response).await
}

#[tauri::command]
pub async fn remote_worktree_recover(
    state: Managed<'_>,
    session_id: String,
    operation_id: String,
) -> Result<Value> {
    let session = state.session(&session_id)?;
    if let Some(id) = &session.review_id {
        state
            .reviews
            .lock()
            .unwrap()
            .check_bound(id, &session_id, &session)?;
    }
    let journal = session.journal(&state.data);
    let pending = {
        let _guard = state.mutations.lock().unwrap();
        read_pending(&journal, &session.repo)?.filter(|record| record.operation_id == operation_id)
    };
    let Some(pending) = pending else {
        return Ok(unknown(&operation_id));
    };
    let response = session
        .agent
        .rpc(
            "receipt",
            json!({"repo":session.repo,"operationId":operation_id}),
        )
        .await;
    finish_write(&state, &session, &journal, &pending, response).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_probe_reads_the_installed_binary_without_running_it() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("cliora");
        std::fs::write(&executable, b"legacy desktop").unwrap();
        assert!(!connector_marker(&executable));

        let mut supported = vec![b'x'; 64 * 1024 - 3];
        supported.extend_from_slice(b"cliora-twiglane-connector-v1");
        std::fs::write(&executable, supported).unwrap();
        assert!(connector_marker(&executable));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn upload_delivers_eof_before_waiting_for_install_receipt() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("cliora");
        std::fs::write(
            &helper,
            r#"#!/bin/sh
cat > "$(dirname "$0")/received" || exit 1
printf '{"installed":true,"agentSha256":"%s"}\n' "$5"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let target = serde_json::from_value(json!({
            "targetId": "host-a", "targetRevision": "peer", "name": "A",
            "host": "test.invalid", "port": 22, "user": "test", "authMethod": "key",
        }))
        .unwrap();
        let digest = format!("{:x}", Sha256::digest(AGENT));
        tokio::time::timeout(
            Duration::from_secs(5),
            upload(
                &helper,
                &target,
                &digest,
                "development",
                &Channel::new(|_| Ok(())),
            ),
        )
        .await
        .expect("installer did not receive EOF")
        .unwrap();
        assert_eq!(std::fs::read(dir.path().join("received")).unwrap(), AGENT);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn stale_install_confirmation_stops_before_any_upload() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("cliora");
        let current_peer = "b".repeat(64);
        let target = json!({
            "targetId": "host-a", "targetRevision": "catalog-a", "name": "A",
            "host": "test.invalid", "port": 22, "user": "test", "authMethod": "key",
        });
        let catalog = json!({"protocol": 1, "targets": [target]});
        let probe = json!({"system": "Linux", "pythonVersion": "3.13.5", "peerRevision": current_peer, "peerIdentity": "c".repeat(64)});
        std::fs::write(
            &helper,
            format!(
                r#"#!/bin/sh
case "$2" in
list) printf '%s\n' '{catalog}' ;;
probe) printf '%s\n' '{probe}' ;;
*) touch -- "$(dirname "$0")/upload-dispatched"; exit 1 ;;
esac
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();

        let request = OpenRequest {
            request_id: Uuid::new_v4().to_string(),
            target_id: "host-a".into(),
            target_revision: "catalog-a".into(),
            path: "/repo".into(),
            baseline: None,
            allow_install: true,
            install_confirmation: Some(Uuid::new_v4().to_string()),
            review_id: None,
        };
        let confirmed = InstallTarget {
            provider: AgentKind::V1,
            review_id: None,
            target_id: request.target_id.clone(),
            revision: request.target_revision.clone(),
            peer: "a".repeat(64),
            path: request.path.clone(),
            version: V1_VERSION.into(),
            size: AGENT.len() as u64,
        };
        let result = connect(
            &helper,
            &request,
            Some(confirmed),
            None,
            &Channel::new(|_| Ok(())),
            None,
        )
        .await;
        assert_eq!(
            result.err().expect("stale peer must fail").code,
            "target_changed"
        );
        assert!(!dir.path().join("upload-dispatched").exists());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn an_unsent_oversized_commit_does_not_leave_an_uncertain_write() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWorktrees::new(dir.path().to_path_buf());
        let mut child = Command::new("/bin/cat");
        let agent = AgentTransport::spawn(&mut child).unwrap();
        let target = serde_json::from_value(json!({
            "targetId": "host-a", "targetRevision": "original-catalog", "name": "A",
            "host": "test.invalid", "port": 22, "user": "test", "authMethod": "key",
        }))
        .unwrap();
        let mut session = Session {
            review_id: None,
            peer_revision: "same-peer-revision".into(),
            agent,
            repo: "repo-a".into(),
            target,
            root: "/repo".into(),
            peer_identity: "same-host".into(),
            baseline: None,
            hunk_stageable: false,
            agent_version: V1_VERSION.into(),
            state_token: Mutex::new(None),
            _session_dir: None,
        };
        let journal = session.journal(dir.path());
        session.target.target_revision = "edited-catalog".into();
        assert_eq!(journal, session.journal(dir.path()));
        session.peer_identity = "replacement-host".into();
        assert_ne!(journal, session.journal(dir.path()));
        session.peer_identity = "same-host".into();

        let pending = Pending {
            review_id: None,
            operation_id: Uuid::new_v4().to_string(),
            op: WriteKind::Commit.name().to_owned(),
            repo: session.repo.clone(),
        };
        save_pending(&journal, &pending).unwrap();
        let response = session
            .agent
            .rpc("commit", json!({"message": "\u{0001}".repeat(24_000)}))
            .await;
        assert_eq!(response.as_ref().unwrap_err().code, "remote_request_size");
        let result = finish_write(&state, &session, &journal, &pending, response)
            .await
            .unwrap();
        assert_eq!(result["state"], "failed");
        assert!(!journal.exists());
        assert!(definitive_error("remote_busy"));
        assert!(!definitive_error("remote_disconnected"));
        session.agent.close().await;
        let rejected = session.agent.rpc("commit", json!({})).await.unwrap_err();
        assert_eq!(rejected.code, "remote_not_sent");
        assert!(definitive_error(&rejected.code));
    }

    /* ---------------- 通用桥接：白名单、待确认语义与块级标记 ---------------- */

    const FAKE_AGENT: &str = r#"
const fs = require("node:fs");
const input = require("node:readline").createInterface({input:process.stdin});
const log = process.env.FAKE_LOG;
const mode = process.env.FAKE_MODE || "complete";
const head = "a".repeat(40);
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
input.on("line", line => {
    const req = JSON.parse(line);
    fs.appendFileSync(log, req.op + "\n");
    if (req.op === "status") {
        return send({v:1, id:req.id, ok:true, result:{repo:req.repo, head, branch:"main", files:[]}});
    }
    if (mode === "silent") {
        return send({v:1, id:req.id, ok:true, result:{}});
    }
    if (mode === "unsupported") {
        return send({v:1, id:req.id, ok:false,
            error:{code:"unsupported_operation", message:"Unknown operation"}});
    }
    send({v:1, id:req.id, ok:true, result:{repo:req.repo, operationId:req.operationId, op:req.op,
        state:"completed", head, branch:"main"}});
});
"#;

    /// 一个只会回固定帧的假远端组件：用来确认「桥接有没有真的发出去」以及
    /// 「没有可核对回执时不谎称完成」。
    fn fake_agent(dir: &Path, mode: &str) -> AgentTransport {
        let mut command = Command::new("node");
        command
            .args(["-e", FAKE_AGENT])
            .env("FAKE_LOG", dir.join("requests.log"))
            .env("FAKE_MODE", mode)
            .kill_on_drop(true);
        AgentTransport::spawn(&mut command).unwrap()
    }

    fn test_session(agent: AgentTransport) -> Session {
        let target = serde_json::from_value(json!({
            "targetId": "host-a", "targetRevision": "peer", "name": "A",
            "host": "test.invalid", "port": 22, "user": "test", "authMethod": "key",
        }))
        .unwrap();
        Session {
            review_id: None,
            peer_revision: "peer-revision".into(),
            agent,
            repo: "repo-a".into(),
            target,
            root: "/repo".into(),
            peer_identity: "a".repeat(64),
            baseline: None,
            hunk_stageable: false,
            agent_version: V1_VERSION.into(),
            state_token: Mutex::new(None),
            _session_dir: None,
        }
    }

    fn requests(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("requests.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn bridged_calls_only_accept_the_whitelisted_git_ops() {
        assert!(matches!(bridge_kind("history"), Ok(BridgeKind::Read)));
        assert!(matches!(
            bridge_kind("mergeSession"),
            Ok(BridgeKind::Read)
        ));
        assert!(matches!(bridge_kind("fetch"), Ok(BridgeKind::Write)));
        assert!(matches!(bridge_kind("worktreeRemove"), Ok(BridgeKind::Write)));
        for op in ["stage", "commit", "open", "targets", "receipt"] {
            assert_eq!(
                bridge_kind(op).unwrap_err().code,
                "remote_unsupported",
                "{op} 有自己的命令，不经过桥接"
            );
        }
        for op in ["program", "command", "shell", "cwd", "env", "node"] {
            assert!(bridge_kind(op).is_err(), "{op} 必须被白名单拒绝");
        }
        for op in BRIDGE_READ_OPS.iter().chain(BRIDGE_WRITE_OPS.iter()) {
            assert!(bridge_kind(op).is_ok(), "{op}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bridged_fields_never_carry_programs_shells_directories_or_environment() {
        let dir = tempfile::tempdir().unwrap();
        let session = test_session(fake_agent(dir.path(), "complete"));
        for forbidden in ["program", "command", "shell", "cwd", "env", "args", "op"] {
            let mut fields = serde_json::Map::new();
            fields.insert("remote".into(), json!("origin"));
            fields.insert(forbidden.into(), json!("x"));
            let request = CallRequest {
                session_id: "session-a".into(),
                op: "fetch".into(),
                fields: Value::Object(fields),
                generation: None,
            };
            assert_eq!(
                bridge_fields(&session, &request).unwrap_err().code,
                "invalid_request",
                "{forbidden}"
            );
        }
        // 仓库键由会话决定，调用方给的值被覆盖；generation 原样带上。
        let request = CallRequest {
            session_id: "session-a".into(),
            op: "history".into(),
            fields: json!({"repo":"other/repo","offset":40}),
            generation: Some("7".into()),
        };
        let fields = bridge_fields(&session, &request).unwrap();
        assert_eq!(fields["repo"], json!("repo-a"));
        assert_eq!(fields["generation"], json!("7"));
        assert_eq!(fields["offset"], json!(40));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn a_bridged_write_without_a_receipt_is_unknown_and_is_never_sent_twice() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWorktrees::new(dir.path().join("state"));
        let session = test_session(fake_agent(dir.path(), "silent"));
        let journal = session.journal(&state.data);
        state
            .sessions
            .lock()
            .unwrap()
            .insert("session-a".into(), Arc::new(session));

        let first = bridge_call(
            &state,
            CallRequest {
                session_id: "session-a".into(),
                op: "fetch".into(),
                fields: json!({"remote":"origin"}),
                generation: Some("7".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(first["state"], "unknown");
        assert!(journal.exists(), "没有回执时必须留下待确认记录");
        assert_eq!(requests(dir.path()), vec!["fetch".to_string()]);

        // 待确认期间再请求一次：只回 unknown，不重发同一条写入。
        let second = bridge_call(
            &state,
            CallRequest {
                session_id: "session-a".into(),
                op: "pull".into(),
                fields: json!({}),
                generation: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(second["state"], "unknown");
        assert_eq!(requests(dir.path()), vec!["fetch".to_string()]);
        state.session("session-a").unwrap().agent.close().await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn a_bridged_write_completes_only_with_a_matching_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWorktrees::new(dir.path().join("state"));
        let session = test_session(fake_agent(dir.path(), "complete"));
        let journal = session.journal(&state.data);
        state
            .sessions
            .lock()
            .unwrap()
            .insert("session-a".into(), Arc::new(session));

        let result = bridge_call(
            &state,
            CallRequest {
                session_id: "session-a".into(),
                op: "branchCreate".into(),
                fields: json!({"name":"feature"}),
                generation: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "completed");
        assert_eq!(result["head"], json!("a".repeat(40)));
        assert!(!journal.exists(), "确认完成后必须清掉待确认记录");
        assert_eq!(
            requests(dir.path()),
            vec!["branchCreate".to_string(), "status".to_string()]
        );
        state.session("session-a").unwrap().agent.close().await;
    }

    /// 现在发行的 v1 组件没有这些 op：明确拒绝要按「未生效」收尾并清掉待确认记录，
    /// 而不是留下一条永远核对不掉的写入。
    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn an_op_the_remote_component_lacks_fails_without_leaving_a_pending_write() {
        let dir = tempfile::tempdir().unwrap();
        let state = RemoteWorktrees::new(dir.path().join("state"));
        let session = test_session(fake_agent(dir.path(), "unsupported"));
        let journal = session.journal(&state.data);
        state
            .sessions
            .lock()
            .unwrap()
            .insert("session-a".into(), Arc::new(session));

        let result = bridge_call(
            &state,
            CallRequest {
                session_id: "session-a".into(),
                op: "fetch".into(),
                fields: json!({}),
                generation: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "failed");
        assert!(result["message"]
            .as_str()
            .is_some_and(|message| message.contains("不支持")));
        assert!(!journal.exists(), "明确未生效的写入不能留下待确认记录");
        assert_eq!(requests(dir.path()), vec!["fetch".to_string()]);
        state.session("session-a").unwrap().agent.close().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn diff_payload_says_whether_hunks_can_be_staged() {
        let dir = tempfile::tempdir().unwrap();
        let mut session = test_session(fake_agent(dir.path(), "complete"));
        let patch = json!({"data":"eA==","nextCursor":null});
        let plain = annotate_diff(&session, "unstaged", patch.clone());
        assert_eq!(plain["hunksStageable"], json!(false));
        assert!(plain["hunksStageableReason"].as_str().is_some());

        session.hunk_stageable = true;
        let capable = annotate_diff(&session, "unstaged", patch.clone());
        assert_eq!(capable["hunksStageable"], json!(true));
        assert!(capable["hunksStageableReason"].is_null());
        // 任务差异是只读视图：远端支持按块写入也不能暂存。
        let task = annotate_diff(&session, "task", patch);
        assert_eq!(task["hunksStageable"], json!(false));
        assert!(task["hunksStageableReason"].as_str().is_some());
    }

    /* ---------------- v2 差异分页：总行数是 camelCase，游标优先用对端 ------------- */

    /// 按 offset/limit 分页回 v2 差异帧的假远端组件：总行数、游标形态都由环境变量决定。
    const FAKE_V2_DIFF: &str = r#"
const fs = require("node:fs");
const input = require("node:readline").createInterface({input:process.stdin});
const total = Number(process.env.FAKE_V2_TOTAL || "0");
const fixed = process.env.FAKE_V2_CURSOR || "";
const omit = process.env.FAKE_V2_OMIT === "1";
const log = process.env.FAKE_LOG;
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
input.on("line", line => {
    const req = JSON.parse(line);
    const offset = Number(req.offset || 0);
    const limit = Number(req.limit || 0);
    const take = Math.max(0, Math.min(limit, total - offset));
    const lines = [];
    for (let at = 0; at < take; at += 1) lines.push({text: "line " + (offset + at), eol: "lf"});
    fs.appendFileSync(log, JSON.stringify({offset: offset, cursor: req.cursor || null}) + "\n");
    const consumed = offset + take;
    const next = consumed < total
        ? (fixed || Buffer.from(JSON.stringify({offset: consumed})).toString("base64url"))
        : null;
    const result = {stateToken: "tok-1", diff: {path: req.path, offset: offset, totalLines: total, lines: lines, binary: false}};
    if (!omit) result.nextCursor = next;
    send({v:2, id:req.id, ok:true, result: result});
});
"#;

    fn fake_v2_diff_agent(dir: &Path, total: u64, cursor: &str, omit: bool) -> AgentTransport {
        let mut command = Command::new("node");
        command
            .args(["-e", FAKE_V2_DIFF])
            .env("FAKE_LOG", dir.join("diff.log"))
            .env("FAKE_V2_TOTAL", total.to_string())
            .env("FAKE_V2_CURSOR", cursor)
            .env("FAKE_V2_OMIT", if omit { "1" } else { "0" })
            .kill_on_drop(true);
        AgentTransport::spawn_v2(&mut command).unwrap()
    }

    fn diff_request(cursor: Option<&str>) -> DiffRequest {
        DiffRequest {
            session_id: "session-a".into(),
            generation: "1".into(),
            path: "a.txt".into(),
            view: "unstaged".into(),
            cursor: cursor.map(str::to_string),
        }
    }

    fn page_lines(page: &Value) -> Vec<String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(page["data"].as_str().unwrap())
            .unwrap();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn diff_requests(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("diff.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// 超过一页的 v2 差异必须能连续翻到最后一页：首页游标非空，末页为 null，
    /// 拼接后的文本既不缺行也不重复。回归点是总行数键：读成 snake_case 时这里只剩一页。
    #[tokio::test(flavor = "current_thread")]
    async fn v2_diff_pages_through_every_line_until_the_peer_says_done() {
        let dir = tempfile::tempdir().unwrap();
        let total = V2_DIFF_PAGE_LINES + 100;
        let session = test_session(fake_v2_diff_agent(dir.path(), total, "", false));
        let mut rendered: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0u32;
        loop {
            let page = diff_v2(&session, &diff_request(cursor.as_deref()))
                .await
                .unwrap();
            pages += 1;
            assert!(pages <= 4, "分页没有收敛：第 {pages} 页之后还要下一页");
            rendered.extend(page_lines(&page));
            match page["nextCursor"].as_str() {
                Some(next) => cursor = Some(next.to_string()),
                None => break,
            }
        }
        assert_eq!(pages, 2, "每页 {V2_DIFF_PAGE_LINES} 行、共 {total} 行应当正好两页");
        assert_eq!(rendered.len() as u64, total);
        let last = format!("line {}", total - 1);
        assert_eq!(rendered.first().map(String::as_str), Some("line 0"));
        assert_eq!(rendered.last().map(String::as_str), Some(last.as_str()));
        session.agent.close().await;
    }

    /// 对端给了 nextCursor 就原样透传，不换成自己的 `v2:` 偏移；下一页请求把对端游标
    /// 和一个按它解出的偏移一起发回去，让对端继续校验绑定关系。
    #[tokio::test(flavor = "current_thread")]
    async fn v2_diff_passes_the_peer_cursor_through_instead_of_deriving_one() {
        let dir = tempfile::tempdir().unwrap();
        let total = V2_DIFF_PAGE_LINES + 100;
        // 对端游标是不透明令牌：形状由对端决定，里面记着下一页偏移。
        let peer_cursor = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            json!({"offset": V2_DIFF_PAGE_LINES, "token": "tok-1"})
                .to_string()
                .as_bytes(),
        );
        let session = test_session(fake_v2_diff_agent(dir.path(), total, &peer_cursor, false));
        let first = diff_v2(&session, &diff_request(None)).await.unwrap();
        assert_eq!(first["nextCursor"], json!(peer_cursor.clone()));
        assert_ne!(first["nextCursor"], json!(v2_cursor(V2_DIFF_PAGE_LINES)));

        let second = diff_v2(&session, &diff_request(Some(&peer_cursor)))
            .await
            .unwrap();
        assert!(
            second["nextCursor"].is_null(),
            "末页必须为 null：前端据此停止翻页且不标记截断"
        );
        let tail = page_lines(&second);
        assert_eq!(tail.len() as u64, total - V2_DIFF_PAGE_LINES);
        assert_eq!(tail.first().map(String::as_str), Some("line 2000"));

        let requests = diff_requests(dir.path());
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["offset"], json!(0));
        assert_eq!(requests[1]["offset"], json!(V2_DIFF_PAGE_LINES));
        assert_eq!(requests[1]["cursor"], json!(peer_cursor));
        session.agent.close().await;
    }

    /// 对端没给 nextCursor 时才用本地行偏移推算；本地游标里没有可回传的令牌。
    #[tokio::test(flavor = "current_thread")]
    async fn v2_diff_derives_a_local_cursor_only_when_the_peer_omits_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let total = V2_DIFF_PAGE_LINES + 100;
        let session = test_session(fake_v2_diff_agent(dir.path(), total, "", true));
        let first = diff_v2(&session, &diff_request(None)).await.unwrap();
        assert_eq!(first["nextCursor"], json!(v2_cursor(V2_DIFF_PAGE_LINES)));

        let second = diff_v2(&session, &diff_request(first["nextCursor"].as_str()))
            .await
            .unwrap();
        assert!(second["nextCursor"].is_null());
        assert_eq!(page_lines(&second).len() as u64, total - V2_DIFF_PAGE_LINES);

        let requests = diff_requests(dir.path());
        assert_eq!(requests[1]["offset"], json!(V2_DIFF_PAGE_LINES));
        assert!(
            requests[1]["cursor"].is_null(),
            "本地偏移游标没有可回传的令牌"
        );
        session.agent.close().await;
    }

    /* ---------------- 远端会话优先 v2 组件，不可用才回退内嵌 v1 ---------------- */

    /// 本机有没有 v2 产物：有清单才算，没有就回退内嵌 v1 并说明原因。
    #[cfg(unix)]
    #[test]
    fn provider_prefers_local_v2_artifacts_and_explains_the_fallback() {
        assert!(
            matches!(select_provider(None, None), Provider::V1Embedded { reason } if !reason.is_empty())
        );
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            select_provider(Some(dir.path().join("missing")), None),
            Provider::V1Embedded { .. }
        ));

        // 有清单与产物：V2，且按远端平台选出的摘要/版本与清单一致。
        let artifacts = dir.path().join("agent-v2");
        let digest = fixture::write_artifacts(&artifacts, fixture::agent_bytes(&dir.path().join("fixture")), "9.9.9");
        match select_provider(Some(artifacts.clone()), None) {
            Provider::V2 { dir } => {
                assert_eq!(dir, artifacts);
                let picked = remote_ssh::select_agent(
                    &dir,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                )
                .unwrap();
                assert_eq!(picked.sha256, digest);
                assert_eq!(picked.version, "9.9.9");
                assert!(!picked.signature.is_empty(), "清单里的发布签名要跟着产物走");
            }
            Provider::V1Embedded { .. } => panic!("有 v2 产物时必须选 v2"),
        }

        // 清单在，但没有目标平台的产物：选不出产物，调用方据此回退内嵌 v1（不上传任何字节）。
        let other = if std::env::consts::ARCH == "aarch64" {
            "x86_64"
        } else {
            "aarch64"
        };
        assert_eq!(
            remote_ssh::select_agent(&artifacts, std::env::consts::OS, other)
            .unwrap_err()
            .code,
            "agent_artifact_unavailable"
        );
    }

    /// 测试夹具：假 ssh、假 v2 组件、假 Cliora 连接工具与本机 v2 产物。
    #[cfg(unix)]
    mod fixture {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        pub(super) fn write_executable(path: &Path, body: impl AsRef<[u8]>) {
            std::fs::write(path, body).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        /// v2 组件替身：`--probe` 只回自述，其余交给 node 实现（行为由 `behaviour` 决定）。
        pub(super) fn agent_bytes(root: &Path) -> Vec<u8> {
            agent_with(root, "ok")
        }

        pub(super) fn agent_with(root: &Path, behaviour: &str) -> Vec<u8> {
            std::fs::create_dir_all(root).unwrap();
            let js = root.join("v2-agent.js");
            std::fs::write(&js, AGENT_JS.replace("__BEHAVIOUR__", behaviour)).unwrap();
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--probe\" ]; then printf '{{\"protocol\":2,\"os\":\"{os}\",\"arch\":\"{arch}\",\"version\":\"9.9.9\"}}\n'; exit 0; fi\nexec node \"{js}\"\n",
                os = std::env::consts::OS,
                arch = std::env::consts::ARCH,
                js = js.display(),
            )
            .into_bytes()
        }

        /// 按当前平台写一份清单与同名产物，返回产物摘要。
        pub(super) fn write_artifacts(artifacts: &Path, agent: Vec<u8>, version: &str) -> String {
            std::fs::create_dir_all(artifacts.join("host")).unwrap();
            write_executable(&artifacts.join("host/twiglane-agent-v2"), &agent);
            let digest = format!("{:x}", Sha256::digest(&agent));
            std::fs::write(
                artifacts.join("manifest.json"),
                json!({
                    "format": 1,
                    "artifacts": [{
                        "system": std::env::consts::OS,
                        "architecture": std::env::consts::ARCH,
                        "version": version,
                        "file": "host/twiglane-agent-v2",
                        "sha256": digest,
                        "signature": "c2lnbmF0dXJl",
                    }],
                })
                .to_string(),
            )
            .unwrap();
            digest
        }

        /// 假 ssh：`-G` 打印固定 profile，其余把最后一段参数在本机执行。
        pub(super) const SSH_STUB: &str = r#"#!/bin/sh
has_g=0
for arg in "$@"; do [ "$arg" = "-G" ] && has_g=1; done
if [ "$has_g" = 1 ]; then cat "$STUB_PROFILE"; exit 0; fi
for last; do :; done
printf 'debug1: Server host key: ssh-ed25519 %s\n' "$STUB_HOST_KEY" >&2
exec sh -c "$last"
"#;

        pub(super) const AGENT_JS: &str = r#"
const fs = require("node:fs");
const input = require("node:readline").createInterface({input:process.stdin});
const behaviour = "__BEHAVIOUR__";
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const ok = (req, result) => send({v:2, id:req.id, ok:true, result});
const snapshot = {
    generation: 3,
    branch: {name:"main", detached:false, unborn:false, headOid:"a".repeat(40)},
    files: [{path:"a.txt", originalPath:null, staged:"modified", unstaged:"none", untracked:false, unmerged:false}],
};
input.on("line", line => {
    const req = JSON.parse(line);
    fs.appendFileSync(process.env.TWIGLANE_TEST_V2_LOG, req.op + "\n");
    if (behaviour === "v1") return send({v:1, id:req.id, ok:true, result:{protocol:1}});
    if (behaviour === "unsupported") return send({v:2, id:req.id, ok:false, error:{code:"unsupported_protocol", message:"only v2"}});
    if (req.op === "hello") return ok(req, {protocol:2, version:"9.9.9", capabilities:["patch"]});
    if (req.op === "open") return ok(req, {protocol:2, agent:"twiglane-agent-v2", repo:"/repo", root:"/repo", name:"repo", host:"build", generation:3, stateToken:"tok-1", snapshot, draft:"", abbrevLength:7, watchDegraded:false, events:"notification", capabilities:["patch"]});
    if (req.op === "status") return ok(req, {repo:"/repo", generation:3, stateToken:"tok-2", snapshot});
    ok(req, {});
});
"#;

        /// 一台可用的自有 SSH 主机：替身 ssh 在本机执行远端命令，HOME 下放已安装的 v2 组件。
        pub(super) struct SshSide {
            pub(super) dir: tempfile::TempDir,
            pub(super) artifacts: PathBuf,
            pub(super) store: AppStore,
            pub(super) ssh: RemoteSsh,
            pub(super) log: PathBuf,
        }

        /// `install` 决定远端是否已装好与产物字节完全一致的组件。
        pub(super) fn ssh_side(behaviour: &str, install: bool) -> SshSide {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let home = root.join("remote-home");
            std::fs::create_dir_all(&home).unwrap();
            let log = root.join("v2-requests.log");
            std::fs::write(&log, b"").unwrap();
            let agent = agent_with(&root.join("fixture"), behaviour);
            let artifacts = root.join("agent-v2");
            write_artifacts(&artifacts, agent.clone(), "9.9.9");
            if install {
                let installed = home.join(".local/share/twiglane/agent/v2");
                std::fs::create_dir_all(&installed).unwrap();
                write_executable(&installed.join("twiglane-agent-v2"), &agent);
            }
            let known_hosts = root.join("known_hosts");
            std::fs::write(&known_hosts, "build.example.com ssh-ed25519 AAAATRUSTED\n").unwrap();
            let profile = root.join("profile");
            std::fs::write(
                &profile,
                format!(
                    "host build.example.com\nhostname 10.9.0.4\nuser deploy\nport 2222\nidentityfile /home/deploy/.ssh/id_ed25519\nuserknownhostsfile {}\nglobalknownhostsfile none\nrevokedhostkeys none\nproxyjump none\nstricthostkeychecking ask\n",
                    known_hosts.display()
                ),
            )
            .unwrap();
            let program = root.join("ssh");
            write_executable(&program, SSH_STUB);
            let store = AppStore::open(root.join("state.json"));
            store.set_remote_ssh_enabled(true).unwrap();
            store
                .save_remote_ssh_target(crate::state::SshTarget {
                    id: "host-a".into(),
                    display_name: "构建机".into(),
                    host: "build.example.com".into(),
                    port: 2222,
                    user: "deploy".into(),
                    auth_method: "key".into(),
                    identity_file: Some("/home/deploy/.ssh/id_ed25519".into()),
                    ssh_config: None,
                    default_path: Some("/repo".into()),
                    enabled: true,
                    shared_host_id: Some("host-a".into()),
                    revision: 1,
                })
                .unwrap();
            let ssh = RemoteSsh::with_exec(
                artifacts.clone(),
                program,
                vec![
                    ("STUB_PROFILE".into(), profile.display().to_string()),
                    ("STUB_HOST_KEY".into(), "SHA256:stubhostkeyidentity".into()),
                    ("HOME".into(), home.display().to_string()),
                    ("TWIGLANE_TEST_V2_LOG".into(), log.display().to_string()),
                ],
            );
            SshSide {
                dir,
                artifacts,
                store,
                ssh,
                log,
            }
        }

        /// Cliora 连接工具替身。`v1_agent` 给出时，connect 会跑真正的 v1 组件；
        /// 否则任何 install/connect 都留痕并失败。
        pub(super) fn connector(
            root: &Path,
            probe: Value,
            v1_agent: Option<&Path>,
            repo: &Path,
        ) -> PathBuf {
            let catalog = json!({"protocol":1,"targets":[{
                "targetId":"host-a","name":"构建机","host":"build.example.com","user":"deploy",
                "port":2222,"authMethod":"key","targetRevision":"catalog-a","defaultPath":"/repo"
            }]});
            std::fs::write(root.join("list.json"), catalog.to_string()).unwrap();
            std::fs::write(root.join("probe.json"), probe.to_string()).unwrap();
            let script = match v1_agent {
                Some(agent) => format!(
                    "#!/bin/sh\ncd -- \"$(dirname \"$0\")\" || exit 1\ncase \"$2\" in\nlist|probe) cat \"$2.json\" ;;\nconnect) touch v1-connect; exec \"{}\" --stdio ;;\n*) touch v1-upload; exit 1 ;;\nesac\n",
                    agent.display()
                ),
                None => "#!/bin/sh\ncd -- \"$(dirname \"$0\")\" || exit 1\ncase \"$2\" in\nlist|probe) cat \"$2.json\" ;;\n*) touch v1-upload; exit 1 ;;\nesac\n".to_string(),
            };
            let _ = repo;
            let path = root.join("cliora");
            write_executable(&path, script);
            path
        }

        /// 真正的内嵌 v1 组件：回退路径必须能真的打开仓库。
        pub(super) fn v1_agent(root: &Path) -> PathBuf {
            let path = root.join("v1-agent");
            write_executable(&path, AGENT);
            path
        }

        /// 一个真实的空 Git 仓库：v1 组件的 open 需要真仓库。
        pub(super) fn repository(root: &Path) -> PathBuf {
            let path = root.join("repo");
            std::fs::create_dir_all(&path).unwrap();
            assert!(std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&path)
                .status()
                .unwrap()
                .success());
            path
        }

        /// 探测结果：v1 侧已装好与本机内嵌字节一致的组件。
        pub(super) fn probe_with_v1_agent(peer: &str) -> Value {
            json!({
                "system":"Linux","pythonVersion":"3.13.5",
                "peerRevision": peer,
                "peerIdentity": "c".repeat(64),
                "agentSha256": format!("{:x}", Sha256::digest(AGENT)),
                "agentSignature": "fixture",
            })
        }

        /// 探测结果：只有远端系统信息，没有任何已装组件。
        pub(super) fn probe_without_agent(peer: &str) -> Value {
            json!({
                "system":"Linux","pythonVersion":"3.13.5",
                "peerRevision": peer,
                "peerIdentity": "c".repeat(64),
            })
        }

        pub(super) fn request(path: &Path, review: bool) -> OpenRequest {
            OpenRequest {
                request_id: Uuid::new_v4().to_string(),
                target_id: "host-a".into(),
                target_revision: "catalog-a".into(),
                path: path.to_string_lossy().into_owned(),
                baseline: None,
                allow_install: false,
                install_confirmation: None,
                review_id: review.then(|| Uuid::new_v4().to_string()),
            }
        }

        pub(super) fn progress() -> Channel<Progress> {
            Channel::new(|_| Ok(()))
        }

        pub(super) fn opened(result: Opened) -> (Box<Session>, Value) {
            match result {
                Opened::Worktree(session, snapshot) => (session, snapshot),
                Opened::NeedsInstall(_) => panic!("这次打开不该要求安装"),
            }
        }

        pub(super) fn log(path: &Path) -> Vec<String> {
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    /// 本机没有 v2 产物：照旧走内嵌 v1，且不发生任何 v2 会话。
    #[cfg(unix)]
    #[tokio::test]
    async fn without_local_v2_artifacts_the_session_falls_back_to_embedded_v1() {
        use fixture::*;
        let side = ssh_side("ok", false);
        let root = side.dir.path();
        let repo = repository(root);
        let empty = root.join("no-v2-here");
        std::fs::create_dir_all(&empty).unwrap();
        // 本机没有 v2 产物：资源目录里也没有清单，产物目录也不存在。
        std::fs::remove_dir_all(&side.artifacts).unwrap();
        let catalog = connector(root, probe_with_v1_agent(&"b".repeat(64)), Some(&v1_agent(root)), &repo);
        let access = V2Access {
            store: &side.store,
            ssh: &side.ssh,
            v2_dir: Some(empty.clone()),
        };
        // 产物目录里没有清单：select_provider 回退内嵌 v1。
        assert!(matches!(
            select_provider(Some(empty), Some(side.artifacts.clone())),
            Provider::V1Embedded { .. }
        ));
        let (session, snapshot) = opened(
            connect(
                &catalog,
                &request(&repo, false),
                None,
                None,
                &progress(),
                Some(&access),
            )
            .await
            .unwrap(),
        );
        assert_eq!(session.protocol(), 1);
        assert_eq!(session.agent_version, V1_VERSION);
        // 远端返回的是规范化后的真实路径（macOS 上 /var 会被解析成 /private/var）。
        let canonical = std::fs::canonicalize(&repo).unwrap();
        assert_eq!(snapshot["root"].as_str(), Some(canonical.to_string_lossy().as_ref()));
        assert!(
            !root.join("v1-upload").exists(),
            "复用已安装的 v1 组件时不该再上传"
        );
        assert!(log(&side.log).is_empty(), "v2 会话不该被拉起");
        session.agent.close().await;
    }

    /// 有 v2 产物且远端已装好：用 v2 打开，内嵌 v1 一次都没有上传或连接。
    #[cfg(unix)]
    #[tokio::test]
    async fn a_ready_v2_component_opens_the_session_without_the_embedded_agent() {
        use fixture::*;
        let side = ssh_side("ok", true);
        let root = side.dir.path();
        let catalog = connector(root, probe_without_agent(&"b".repeat(64)), None, root);
        let access = V2Access {
            store: &side.store,
            ssh: &side.ssh,
            v2_dir: Some(side.artifacts.clone()),
        };
        let (session, snapshot) = opened(
            connect(
                &catalog,
                &request(Path::new("/repo"), false),
                None,
                None,
                &progress(),
                Some(&access),
            )
            .await
            .unwrap(),
        );
        assert_eq!(session.protocol(), 2);
        assert_eq!(session.agent_version, "9.9.9");
        // 快照被拍平成前端已经在用的形状：repo/root/generation/head/branch/files。
        assert_eq!(snapshot["repo"], json!("/repo"));
        assert_eq!(snapshot["branch"], json!("main"));
        assert_eq!(snapshot["generation"], json!("3"));
        assert_eq!(snapshot["files"], json!([{"path":"a.txt","xy":"M "}]));
        assert_eq!(session.repo, "/repo");
        assert_eq!(session.state_token().as_deref(), Some("tok-1"));
        assert_eq!(log(&side.log), vec!["hello".to_string(), "open".to_string()]);
        assert!(!root.join("v1-upload").exists(), "内嵌 v1 不该被上传");
        assert!(!root.join("v1-connect").exists(), "内嵌 v1 不该被拉起");
        session.agent.close().await;
    }

    /// 本机有 v2 产物却握不上手：明确报协议不匹配，不静默改走 v1。
    #[cfg(unix)]
    #[tokio::test]
    async fn a_v2_handshake_mismatch_is_reported_instead_of_falling_back() {
        use fixture::*;
        for behaviour in ["v1", "unsupported"] {
            let side = ssh_side(behaviour, true);
            let root = side.dir.path();
            let catalog = connector(root, probe_without_agent(&"b".repeat(64)), Some(&v1_agent(root)), root);
            let access = V2Access {
                store: &side.store,
                ssh: &side.ssh,
                v2_dir: Some(side.artifacts.clone()),
            };
            let error = connect(
                &catalog,
                &request(Path::new("/repo"), false),
                None,
                None,
                &progress(),
                Some(&access),
            )
            .await
            .err()
            .expect("协议不一致必须报错");
            assert_eq!(error.code, "remote_protocol_mismatch", "{behaviour}");
            assert!(log(&side.log).contains(&"hello".to_string()), "{behaviour}");
            assert!(!root.join("v1-connect").exists(), "握手失败不能改走 v1：{behaviour}");
            assert!(!root.join("v1-upload").exists(), "握手失败不能上传 v1：{behaviour}");
        }
    }

    /// 清单在但本机没有这台远端架构的产物：回退内嵌 v1，且一个字节都没有上传。
    #[cfg(unix)]
    #[tokio::test]
    async fn a_missing_target_architecture_falls_back_before_any_upload() {
        use fixture::*;
        let side = ssh_side("ok", false);
        let root = side.dir.path();
        let repo = repository(root);
        // 故意只登记另一个架构：探测到的平台在清单里找不到。
        let other = if std::env::consts::ARCH == "aarch64" { "x86_64" } else { "aarch64" };
        std::fs::write(
            side.artifacts.join("manifest.json"),
            json!({"format":1,"artifacts":[{
                "system": std::env::consts::OS, "architecture": other, "version":"9.9.9",
                "file":"host/twiglane-agent-v2", "sha256":"a".repeat(64), "signature":"c2ln",
            }]})
            .to_string(),
        )
        .unwrap();
        let catalog = connector(root, probe_with_v1_agent(&"b".repeat(64)), Some(&v1_agent(root)), &repo);
        let access = V2Access {
            store: &side.store,
            ssh: &side.ssh,
            v2_dir: Some(side.artifacts.clone()),
        };
        let (session, _) = opened(
            connect(
                &catalog,
                &request(&repo, false),
                None,
                None,
                &progress(),
                Some(&access),
            )
            .await
            .unwrap(),
        );
        assert_eq!(session.protocol(), 1);
        assert!(!root.join("v1-upload").exists(), "没有匹配产物时不得开始上传");
        assert!(log(&side.log).is_empty(), "v2 会话不该被拉起");
        session.agent.close().await;
    }

    /// 审查会话（reviewId/基线）只有 v1 支持：即使 v2 可用也必须走 v1。
    #[cfg(unix)]
    #[tokio::test]
    async fn a_review_session_stays_on_v1_even_when_v2_is_available() {
        use fixture::*;
        let side = ssh_side("ok", true);
        let root = side.dir.path();
        let repo = repository(root);
        let catalog = connector(root, probe_with_v1_agent(&"b".repeat(64)), Some(&v1_agent(root)), &repo);
        let access = V2Access {
            store: &side.store,
            ssh: &side.ssh,
            v2_dir: Some(side.artifacts.clone()),
        };
        let (session, _) = opened(
            connect(
                &catalog,
                &request(&repo, true),
                None,
                None,
                &progress(),
                Some(&access),
            )
            .await
            .unwrap(),
        );
        assert_eq!(session.protocol(), 1);
        assert!(session.review_id.is_some());
        assert!(log(&side.log).is_empty(), "审查会话不该碰 v2 组件");
        session.agent.close().await;
    }
}
