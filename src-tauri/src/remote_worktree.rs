pub(crate) mod review;
#[cfg(test)]
mod live;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use uuid::Uuid;

use crate::error::AppError;
use crate::remote_ssh::{self, AgentArtifact, AgentProbe, RemoteSsh};
use crate::remote_worktree_transport::{AgentTransport, ScopedChild};
use crate::state::{AppStore, SshTarget};

const FLAG: &str = "--twiglane-remote-v1";
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

#[derive(Clone, PartialEq, Eq)]
struct InstallTarget {
    review_id: Option<String>,
    target_id: String,
    revision: String,
    peer: String,
    path: String,
    baseline: Option<String>,
    digest: String,
    version: String,
    size: u64,
}

enum Opened {
    Worktree(Box<Session>, Value),
    NeedsInstall(InstallTarget),
}

/// 本机保存的目标与 Cliora 主机簿各自有独立的身份空间。
const NATIVE_TARGET_PREFIX: &str = "native:";

impl Target {
    fn native(target: &crate::state::SshTarget) -> Self {
        Self {
            target_id: format!(
                "{NATIVE_TARGET_PREFIX}{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&target.id)
            ),
            target_revision: target.revision.to_string(),
            name: target.display_name.clone(),
            host: target.host.clone(),
            user: target.user.clone(),
            port: target.port,
            auth_method: target.auth_method.clone(),
            default_path: target.default_path.clone(),
            effective_host: None,
            unavailable_reason: (!target.enabled).then(|| "这台 Twiglane SSH 主机已停用。".into()),
        }
    }
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

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    review_id: Option<String>,
    operation_id: String,
    /// 远端 op 名：既覆盖 `stage`/`unstage`/`commit`，也覆盖桥接命令转发的写入 op。
    /// 旧记录里存的就是 `stage` 这类小写名，改成字符串后仍能读回。
    op: String,
    repo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_identity: Option<String>,
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
    worktree_identity: Option<String>,
    peer_identity: String,
    journal_identity: String,
    host_identity: String,
    legacy_cliora: Vec<LegacyCliora>,
    baseline: Option<String>,
    /// 远端组件是否声明了按块/按行写入（agent v2 的 `patch`）。只由 `open` 返回的
    /// capabilities 决定：没有声明就一律按整文件暂存处理，不假设远端能力。
    hunk_stageable: bool,
    /// 实际使用的组件版本（v1 为 `v1`，v2 为清单/握手给出的版本）。
    agent_version: String,
    /// v2 写入令牌：open/status/diff 都会刷新，写入必须带最新值。v1 会话始终为空。
    state_token: Mutex<SessionState>,
    /// v2 会话的私有目录（冻结配置、known_hosts 副本与一次性 askpass）必须活到会话结束。
    /// 只作为生命周期守卫持有，代码不读取它。
    _session_dir: Option<tempfile::TempDir>,
}

struct LegacyCliora {
    helper: PathBuf,
    target: Target,
    peer_identity: String,
}

#[derive(Default)]
struct SessionState {
    status_request: u64,
    last_state: Option<(u64, String)>,
}

impl Session {
    /// 记录远端刷新出来的写入令牌。v1 的响应里没有这个字段，因此保持为空。
    fn remember_state(&self, value: &Value, status_request: Option<u64>) -> Result<()> {
        let mut state = self.state_token.lock().unwrap_or_else(|e| e.into_inner());
        if status_request.is_some_and(|request| request != state.status_request) {
            return Err(AppError::new("stale_state", "较旧的远端状态响应已丢弃。"));
        }
        if let (Some(generation), Some(token)) = (value["generation"].as_u64(), value["stateToken"].as_str()) {
            if state.last_state.as_ref().is_some_and(|(seen, _)| *seen > generation) {
                return Err(AppError::new("stale_state", "较旧的远端状态响应已丢弃。"));
            }
            state.last_state = Some((generation, token.to_string()));
        }
        Ok(())
    }

    fn protocol(&self) -> u32 {
        self.agent.protocol()
    }

    /// 写入/读取请求的版本上下文。v1 用字符串 `generation`；v2 只认数字 generation
    /// 与最新的 `stateToken`，绝不把字符串 generation 发过去。
    fn with_generation(&self, fields: &mut Value, generation: Option<&str>) -> bool {
        if self.protocol() == 2 {
            let state = self.state_token.lock().unwrap_or_else(|e| e.into_inner());
            let Some((current, token)) = state.last_state.as_ref() else {
                return false;
            };
            if let Some(expected) = generation {
                if expected.parse::<u64>().ok() != Some(*current) {
                    return false;
                }
                fields["generation"] = json!(current);
            }
            fields["stateToken"] = json!(token);
        } else if let Some(generation) = generation {
            fields["generation"] = json!(generation);
        }
        true
    }
    fn journal(&self, base: &Path) -> PathBuf {
        let worktree = self.worktree_identity.as_deref().unwrap_or(&self.repo);
        let key = json!([self.journal_identity, worktree]);
        base.join(format!("journal-{:x}.json", Sha256::digest(key.to_string().as_bytes())))
    }

    fn legacy_worktree_journal(&self, base: &Path, host_identity: &str) -> PathBuf {
        let key = json!([host_identity, self.target.user, self.root]);
        base.join(format!(
            "worktree-{:x}.json",
            Sha256::digest(key.to_string().as_bytes())
        ))
    }

    fn legacy_journal(&self, base: &Path, target_id: &str, peer_identity: &str) -> PathBuf {
        let key = json!([target_id, peer_identity, self.target.user, self.root]);
        base.join(format!("{:x}.json", Sha256::digest(key.to_string().as_bytes())))
    }

    fn journal_paths(&self, base: &Path) -> BTreeSet<PathBuf> {
        let mut paths = BTreeSet::from([
            self.journal(base),
            self.legacy_worktree_journal(base, &self.host_identity),
            self.legacy_journal(base, &self.target.target_id, &self.peer_identity),
        ]);
        for binding in &self.legacy_cliora {
            paths.insert(self.legacy_journal(base, &binding.target.target_id, &binding.peer_identity));
            paths.insert(self.legacy_worktree_journal(base, &binding.peer_identity));
        }
        paths
    }

    fn legacy_pending(&self, pending: &Pending) -> bool {
        self.protocol() == 2 && self.worktree_identity.as_deref() == Some(&pending.repo)
    }

    async fn status(&self) -> Result<Value> {
        self.status_for(self.baseline.as_deref()).await
    }

    async fn status_for(&self, baseline: Option<&str>) -> Result<Value> {
        let status_request = {
            let mut state = self.state_token.lock().unwrap_or_else(|e| e.into_inner());
            state.status_request = state.status_request.wrapping_add(1);
            state.status_request
        };
        let mut fields = json!({"repo":self.repo});
        if let Some(baseline) = baseline {
            fields["baseline"] = json!(baseline);
        }
        let result = self.agent.rpc("status", fields).await?;
        if result["repo"].as_str() != Some(&self.repo)
            || self.worktree_identity.as_ref().is_some_and(|identity| {
                result["worktreeIdentity"].as_str() != Some(identity)
                    || result["worktreePath"].as_str() != Some(&self.root)
            })
        {
            return Err(AppError::new("target_changed", "远端工作树身份已变化。"));
        }
        self.remember_state(&result, Some(status_request))?;
        // v2 把状态放在 `snapshot` 里；拍平成 v1 视图后，前端与写入核对都用同一份形状。
        let result = if self.protocol() == 2 {
            flatten_v2(&result)?
        } else {
            result
        };
        Ok(result)
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
    for key in ["root", "name", "baseline", "worktreeIdentity", "reviewFiles", "reviewFilesTruncated", "reviewError", "watchDegraded"] {
        if let Some(value) = result.get(key) {
            view[key] = value.clone();
        }
    }
    if let Some(path) = result.get("worktreePath") {
        view["root"] = path.clone();
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
        "worktree_changed" => "远端工作树身份已变化，请重新打开。",
        "unsupported_action" | "remote_bootstrap_failed" => "当前 Cliora 连接器无法启动此远端组件，请检查远端环境与版本。",
        "probe_required" | "ssh_peer_unverified" => "远端主机身份未确认，请重新连接后重试。",
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
        "remote_journal" => "无法核对本机保存的远端操作记录。",
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
    let stderr = String::from_utf8_lossy(stderr);
    let codes = stderr.lines().rev().filter_map(|line| {
        serde_json::from_str::<Value>(line).ok()?.get("error")?.as_str().map(str::to_owned)
    });
    let mut wrapper = false;
    for code in codes {
        if code == "remote_bootstrap_failed" {
            wrapper = true;
        } else {
            let error = remote_error(&code);
            if error.code != "ssh_failed" {
                return error;
            }
        }
    }
    if stderr.contains("Host key verification failed")
        || stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        return AppError::new("ssh_host_key_untrusted", "SSH 主机密钥未受信任，请核对本机已信任的记录。");
    }
    if stderr.lines().any(|line| {
        line.split_once("Permission denied (")
            .is_some_and(|(_, detail)| [")", ")."].iter().any(|suffix| detail.trim_end().ends_with(suffix)))
            || line.contains("No more authentication methods to try.")
    }) {
        return AppError::new("ssh_auth_failed", "SSH 认证失败，请检查主机的密钥或密码。");
    }
    remote_error(if wrapper { "remote_bootstrap_failed" } else { "ssh_failed" })
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
    query_command(command(path, action, target)).await
}

async fn query_command(mut cmd: Command) -> Result<Value> {
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

async fn connector_capability(helper: &Path, capability: &str) -> Result<()> {
    let version = query(helper, "version", None).await?;
    if version["protocol"].as_u64() != Some(1)
        || !version["capabilities"].as_array().is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some(capability)))
    {
        return Err(AppError::new(
            "cliora_incompatible",
            "请更新 Cliora，以连接支持完整仓库操作和审查回执的远端组件。",
        ));
    }
    Ok(())
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

fn component_command(
    path: &Path,
    action: &str,
    target_id: &str,
    peer_revision: &str,
    artifact: &AgentArtifact,
) -> Result<Command> {
    if artifact.digest_signature.is_empty() {
        return Err(AppError::new(
            "agent_signature_missing",
            "当前 Twiglane 构建缺少 Cliora 所需的远端组件发布证明，请更新 Twiglane。",
        ));
    }
    let mut cmd = command(path, action, None);
    cmd.args([
        target_id,
        peer_revision,
        &artifact.sha256,
        &artifact.digest_signature,
    ]);
    Ok(cmd)
}

async fn upload(
    mut command: Command,
    artifact: &AgentArtifact,
    progress: &Channel<Progress>,
) -> Result<()> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = ScopedChild::spawn(&mut command).map_err(|_| remote_error("ssh_failed"))?;
    let mut stdin = child.take_stdin().ok_or_else(|| remote_error("ssh_failed"))?;
    let stdout = child.take_stdout().ok_or_else(|| remote_error("ssh_failed"))?;
    let stderr = child.take_stderr().ok_or_else(|| remote_error("ssh_failed"))?;
    let total = artifact.bytes.len() as u64;
    publish(progress, "installing", Some(0), Some(total));
    let write = async move {
        let mut sent = 0;
        for chunk in artifact.bytes.chunks(64 * 1024) {
            stdin.write_all(chunk).await.map_err(|_| remote_error("ssh_failed"))?;
            sent += chunk.len() as u64;
            publish(progress, "installing", Some(sent), Some(total));
        }
        Ok::<_, AppError>(())
    };
    let (written, stdout, stderr, status) = tokio::join!(
        write,
        bounded_output(stdout, 128 * 1024),
        bounded_output(stderr, 64 * 1024),
        child.wait()
    );
    let status = status.map_err(|_| remote_error("ssh_failed"))?;
    if !status.success() {
        return Err(output_error(&stderr?));
    }
    written?;
    let receipt: Value = serde_json::from_slice(&stdout?)
        .map_err(|_| AppError::new("remote_protocol", "远端安装回执格式无效。"))?;
    if receipt["installed"].as_bool() == Some(true)
        && receipt["agentSha256"].as_str() == Some(&artifact.sha256)
    {
        return Ok(());
    }
    Err(AppError::new("remote_protocol", "远端安装尚未产生可核实的回执。"))
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

/// 接收 POSIX 根路径或平台中立的 Windows 盘符路径。Git 相对路径不允许伪装成绝对路径。
fn valid_path(value: &str, absolute: bool) -> bool {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return false;
    }
    let drive = value.as_bytes().get(..3).is_some_and(|bytes| {
        bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\')
    });
    if !absolute {
        return !drive && !value.starts_with('/');
    }
    let tail = if let Some(tail) = value.strip_prefix('/') {
        tail
    } else if drive && value.as_bytes()[2] == b'/' && !value.contains('\\') {
        &value[3..]
    } else {
        return false;
    };
    tail.is_empty() || tail.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn probe_identity(value: &Value) -> Result<&str> {
    value.as_str()
        .filter(|value| {
            value.len() == 64
                && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| AppError::new("cliora_incompatible", "请更新 Cliora，以核对实际 SSH 主机身份。"))
}

fn protocol_mismatch() -> AppError {
    AppError::new(
        "remote_protocol_mismatch",
        "远端组件与本次会话所需的能力不一致，请更新或重新安装远端组件。",
    )
}

enum V2Route {
    Native(Box<(SshTarget, AgentProbe)>),
    Cliora(PathBuf),
}

struct V2Plan {
    route: V2Route,
    target: Target,
    peer_revision: String,
    peer_identity: String,
    host_identity: String,
    installed: Option<String>,
    system: String,
    architecture: String,
    artifact: AgentArtifact,
}

fn select_artifact(access: &V2Access<'_>, system: &str, architecture: &str) -> Result<AgentArtifact> {
    let bundled = access.ssh.artifacts();
    let mut last_error = None;
    for dir in access.v2_dir.as_ref().into_iter().chain(std::iter::once(&bundled)) {
        match remote_ssh::manifest_ready(dir) {
            Ok(()) => return remote_ssh::select_agent(dir, system, architecture),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.expect("one bundled artifact path"))
}

fn check_target(target: &Target, revision: &str) -> Result<()> {
    if let Some(reason) = &target.unavailable_reason {
        return Err(AppError::new("target_unavailable", reason));
    }
    if target.target_revision != revision {
        return Err(remote_error("target_changed"));
    }
    Ok(())
}

async fn plan_v2(
    explicit_helper: Option<&Path>,
    access: &V2Access<'_>,
    request: &OpenRequest,
    source: Option<&review::Source>,
) -> Result<V2Plan> {
    if let Some(encoded) = request.target_id.strip_prefix(NATIVE_TARGET_PREFIX).filter(|_| source.is_none()) {
        let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| remote_error("target_unavailable"))?;
        let host = access.store.remote_ssh_enabled()
            .then(|| access.store.remote_ssh_target(&id))
            .flatten()
            .ok_or_else(|| remote_error("target_unavailable"))?;
        let mut target = Target::native(&host);
        check_target(&target, &request.target_revision)?;
        let probe = remote_ssh::probe_agent(access.store, access.ssh, &host).await?;
        target.effective_host = Some(probe.effective_host.clone());
        let artifact = select_artifact(access, &probe.system, &probe.architecture)?;
        let installed = probe.digest.clone().filter(|_| {
            probe.agent.as_ref().is_some_and(|agent| agent["protocol"].as_u64() == Some(2))
        });
        return Ok(V2Plan {
            target,
            peer_revision: probe.peer_revision.clone(),
            peer_identity: probe.peer_identity.clone(),
            host_identity: probe.host_identity.clone().ok_or_else(|| remote_error("ssh_peer_unverified"))?,
            installed,
            system: probe.system.clone(),
            architecture: probe.architecture.clone(),
            route: V2Route::Native(Box::new((host, probe))),
            artifact,
        });
    }

    let helper = match explicit_helper {
        Some(path) => path.to_path_buf(),
        None => connector().await?,
    };
    connector_capability(&helper, "agentV2").await?;
    let target = list(&helper).await?.into_iter()
        .find(|target| target.target_id == request.target_id)
        .ok_or_else(|| remote_error("target_unavailable"))?;
    check_target(&target, &request.target_revision)?;
    plan_cliora(helper, target, source, access).await
}

async fn plan_cliora(
    helper: PathBuf,
    target: Target,
    source: Option<&review::Source>,
    access: &V2Access<'_>,
) -> Result<V2Plan> {
    let probe = query(&helper, "probe-v2", Some(&target)).await?;
    let peer_revision = probe_identity(&probe["peerRevision"])?.to_owned();
    let peer_identity = probe_identity(&probe["peerIdentity"])?.to_owned();
    if let Some(source) = source {
        source.check_peer(&peer_revision, &peer_identity)?;
    }
    let system = probe["system"].as_str().ok_or_else(protocol_mismatch)?.to_owned();
    let architecture = probe["architecture"].as_str().ok_or_else(protocol_mismatch)?.to_owned();
    let artifact = select_artifact(access, &system, &architecture)?;
    if artifact.digest_signature.is_empty() {
        return Err(AppError::new(
            "agent_signature_missing",
            "当前 Twiglane 构建缺少 Cliora 所需的远端组件发布证明，请更新 Twiglane。",
        ));
    }
    Ok(V2Plan {
        route: V2Route::Cliora(helper),
        target,
        peer_revision,
        host_identity: peer_identity.clone(),
        peer_identity,
        installed: probe["agentSha256"].as_str().map(str::to_owned),
        system,
        architecture,
        artifact,
    })
}

async fn connect(
    explicit_helper: Option<&Path>,
    request: &OpenRequest,
    confirm: Option<InstallTarget>,
    source: Option<&review::Source>,
    progress: &Channel<Progress>,
    access: &V2Access<'_>,
) -> Result<Opened> {
    publish(progress, "connecting", None, None);
    let plan = plan_v2(explicit_helper, access, request, source).await?;
    connect_planned(plan, request, confirm, source, progress, access).await
}

async fn connect_planned(
    plan: V2Plan,
    request: &OpenRequest,
    confirm: Option<InstallTarget>,
    source: Option<&review::Source>,
    progress: &Channel<Progress>,
    access: &V2Access<'_>,
) -> Result<Opened> {
    let selected = InstallTarget {
        review_id: request.review_id.clone(),
        target_id: plan.target.target_id.clone(),
        revision: plan.target.target_revision.clone(),
        peer: plan.peer_revision.clone(),
        path: request.path.clone(),
        baseline: request.baseline.clone(),
        digest: plan.artifact.sha256.clone(),
        version: plan.artifact.version.clone(),
        size: plan.artifact.bytes.len() as u64,
    };
    if request.allow_install && confirm.as_ref() != Some(&selected) {
        return Err(AppError::new("target_changed", "安装目标已变化，请重新打开并确认。"));
    }
    let needs_install = plan.installed.as_deref() != Some(&plan.artifact.sha256);
    if needs_install && !request.allow_install {
        return Ok(Opened::NeedsInstall(selected));
    }
    if needs_install {
        let install = async {
            match &plan.route {
                V2Route::Native(native) => {
                    let (host, probe) = native.as_ref();
                    remote_ssh::install_verified_artifact(
                        access.store, access.ssh, host, &plan.artifact, probe,
                        &|sent, total| publish(progress, "installing", Some(sent), Some(total)),
                    ).await
                }
                V2Route::Cliora(path) => {
                    let command = component_command(path, "install-v2", &plan.target.target_id, &plan.peer_revision, &plan.artifact)?;
                    upload(command, &plan.artifact, progress).await
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(600), install)
            .await
            .map_err(|_| AppError::new("remote_timeout", "远端组件传输超时，可以重试。"))??;
    }
    let (agent, session_dir) = match &plan.route {
        V2Route::Native(native) => {
            let (host, probe) = native.as_ref();
            let connection = remote_ssh::prepare_session(access.store, access.ssh, host, &plan.artifact.sha256, probe).await?;
            let (transport, folder) = AgentTransport::checked_v2(connection);
            (transport, Some(folder))
        }
        V2Route::Cliora(path) => {
            let mut command = component_command(path, "connect-v2", &plan.target.target_id, &plan.peer_revision, &plan.artifact)?;
            (AgentTransport::spawn_connector_v2(&mut command, output_error)?, None)
        }
    };
    let hello = tokio::time::timeout(Duration::from_secs(120), agent.rpc("hello", json!({})))
        .await
        .map_err(|_| AppError::new("remote_timeout", "等待远端组件握手超时。"))??;
    let journal_identity = probe_identity(&hello["journalIdentity"])
        .map_err(|_| protocol_mismatch())?.to_owned();
    let capabilities = hello["capabilities"].as_array().ok_or_else(protocol_mismatch)?;
    if hello["protocol"].as_u64() != Some(2)
        || hello["version"].as_str() != Some(&plan.artifact.version)
        || remote_ssh::platform(
            hello["os"].as_str().unwrap_or_default(),
            hello["arch"].as_str().unwrap_or_default(),
        ) != remote_ssh::platform(&plan.system, &plan.architecture)
        || ["open", "status", "history", "commitDetail", "commitDiff", "diff", "reviewIdentity", "taskReview", "receipt", "journalIdentity"]
            .iter()
            .any(|required| !capabilities.iter().any(|value| value.as_str() == Some(*required)))
    {
        return Err(protocol_mismatch());
    }

    publish(progress, "opening", None, None);
    let mut fields = json!({"path":request.path});
    if let Some(baseline) = &request.baseline {
        fields["baseline"] = json!(baseline);
    }
    if let Some(source) = source {
        fields["worktreeIdentity"] = json!(source.worktree_identity());
    }
    let snapshot = tokio::time::timeout(Duration::from_secs(120), agent.rpc("open", fields))
        .await
        .map_err(|_| AppError::new("remote_timeout", "等待远端仓库状态超时。"))??;
    let repo = snapshot["repo"].as_str().filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .ok_or_else(protocol_mismatch)?.to_owned();
    let root = snapshot["worktreePath"].as_str().filter(|value| valid_path(value, true))
        .ok_or_else(protocol_mismatch)?.to_owned();
    let worktree_identity = probe_identity(&snapshot["worktreeIdentity"]).map_err(|_| protocol_mismatch())?.to_owned();
    if snapshot["journalIdentity"].as_str() != Some(&journal_identity) {
        return Err(AppError::new("target_changed", "远端账号的待确认操作身份已变化，请重新连接。"));
    }
    if snapshot["baseline"].as_str() != request.baseline.as_deref() {
        return Err(AppError::new("invalid_baseline", "远端组件返回的任务起点不一致。"));
    }
    if let Some(source) = source {
        source.check_tree(&root, &worktree_identity)?;
    }
    let hunk_stageable = capabilities.iter().any(|cap| cap.as_str() == Some("patch"));
    let session = Session {
        review_id: request.review_id.clone(),
        peer_revision: plan.peer_revision,
        peer_identity: plan.peer_identity.clone(),
        journal_identity,
        host_identity: plan.host_identity,
        legacy_cliora: match plan.route {
            V2Route::Native(_) => Vec::new(),
            V2Route::Cliora(helper) => vec![LegacyCliora {
                helper,
                target: plan.target.clone(),
                peer_identity: plan.peer_identity,
            }],
        },
        agent,
        repo,
        root,
        worktree_identity: Some(worktree_identity),
        target: plan.target,
        baseline: request.baseline.clone(),
        hunk_stageable,
        agent_version: plan.artifact.version,
        state_token: Mutex::default(),
        _session_dir: session_dir,
    };
    session.remember_state(&snapshot, None)?;
    let view = flatten_v2(&snapshot)?;
    Ok(Opened::Worktree(Box::new(session), view))
}

fn read_pending(path: &Path) -> Result<Option<Pending>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let pending: Pending = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::new("remote_journal", "远端操作记录无法读取。"))?;
            Ok(Some(pending))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(AppError::new(
            "remote_journal",
            "无法读取本机保存的远端操作记录。",
        )),
    }
}

struct PendingFile {
    path: PathBuf,
    record: Pending,
}

/// The caller holds the mutations lock while reading or changing the journal set.
fn find_pending(base: &Path, session: &Session) -> Result<Option<PendingFile>> {
    let mut pending = None;
    for path in session.journal_paths(base) {
        let Some(record) = read_pending(&path)? else {
            continue;
        };
        if pending.is_some() {
            return Err(AppError::new("remote_journal", "该远端目录有多条待确认记录，请保留记录并核对来源。"));
        }
        if (record.repo != session.repo && !session.legacy_pending(&record))
            || record.worktree_identity.as_ref().is_some_and(|id| Some(id) != session.worktree_identity.as_ref())
        {
            return Err(AppError::new("target_changed", "远端目录有来自另一工作树的待确认操作。"));
        }
        pending = Some(PendingFile { path, record });
    }
    Ok(pending)
}

fn may_have_legacy_journal(base: &Path) -> bool {
    std::fs::read_dir(base).is_ok_and(|entries| entries.flatten().any(|entry| {
        let name = entry.file_name();
        name.to_str().and_then(|name| name.strip_suffix(".json")).is_some_and(|name| {
            let hash = name.strip_prefix("worktree-").unwrap_or(name);
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    }))
}

fn same_catalog_endpoint(left: &Target, right: &Target) -> bool {
    let left_host = left.effective_host.as_deref().unwrap_or(&left.host);
    let right_host = right.effective_host.as_deref().unwrap_or(&right.host);
    left.port == right.port && left.user == right.user && left_host.eq_ignore_ascii_case(right_host)
}

/// An exact old filename identifies the original catalog and SSH peer. A
/// separate authenticated, read-only reopen proves that route owns this
/// account and worktree even when it negotiated a different host key.
async fn bind_legacy_cliora(
    base: &Path,
    session: &mut Session,
    access: &V2Access<'_>,
    progress: &Channel<Progress>,
) {
    if !may_have_legacy_journal(base) {
        return;
    }
    let existing_helper = session.legacy_cliora.first().map(|binding| binding.helper.clone());
    let helper = match existing_helper {
        Some(path) => path,
        None => match connector().await {
            Ok(path) => path,
            Err(_) => return,
        },
    };
    let Ok(targets) = list(&helper).await else {
        return;
    };
    for target in targets.into_iter().filter(|target| {
        target.target_id != session.target.target_id
            && target.unavailable_reason.is_none()
            && same_catalog_endpoint(&session.target, target)
    }) {
        let request = OpenRequest {
            request_id: Uuid::new_v4().to_string(),
            target_id: target.target_id.clone(),
            target_revision: target.target_revision.clone(),
            path: session.root.clone(),
            baseline: None,
            allow_install: false,
            install_confirmation: None,
            review_id: None,
        };
        let Ok(plan) = plan_cliora(helper.clone(), target, None, access).await else {
            continue;
        };
        if !session.legacy_journal(base, &plan.target.target_id, &plan.peer_identity).exists()
            && !session.legacy_worktree_journal(base, &plan.host_identity).exists()
        {
            continue;
        }
        let Ok(Opened::Worktree(mut alternate, _)) =
            connect_planned(plan, &request, None, None, progress, access).await
        else {
            continue;
        };
        if alternate.journal_identity == session.journal_identity
            && alternate.worktree_identity == session.worktree_identity
            && alternate.root == session.root
        {
            session.legacy_cliora.append(&mut alternate.legacy_cliora);
        }
        alternate.agent.close().await;
    }
}

fn save_pending(path: &Path, pending: &Pending) -> Result<()> {
    let bytes = serde_json::to_vec(pending)
        .map_err(|_| AppError::new("remote_journal", "无法编码操作记录。"))?;
    crate::atomic::atomic_write(path, &bytes)
        .map_err(|_| AppError::new("remote_journal", "无法持久保存操作记录。"))
}

fn native_targets(store: &AppStore) -> Vec<Target> {
    if !store.remote_ssh_enabled() {
        return Vec::new();
    }
    store.remote_ssh_targets().iter().map(Target::native).collect()
}

#[tauri::command]
pub async fn remote_worktree_targets(backend: State<'_, Arc<crate::git::ops::Backend>>) -> Result<Vec<Target>> {
    let mut native = native_targets(&backend.store);
    let cli_targets = match connector().await {
        Ok(helper) => list(&helper).await,
        Err(error) => Err(error),
    };
    match cli_targets {
        Ok(targets) => native.extend(targets),
        Err(error) if native.is_empty() && !backend.store.remote_ssh_enabled() => return Err(error),
        Err(_) => {}
    }
    Ok(native)
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
        let journal_base = state.data.clone();
        let join = tokio::spawn(async move {
            let access = V2Access::new(&backend.store, &ssh);
            let mut opened = connect(
                None,
                &request,
                confirm,
                source.as_ref(),
                &on_progress,
                &access,
            )
            .await?;
            if let Opened::Worktree(session, _) = &mut opened {
                bind_legacy_cliora(&journal_base, session, &access, &on_progress).await;
            }
            Ok::<_, AppError>(opened)
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
        find_pending(&state.data, &session)?.map(|file| file.record)
    };
    let protocol = session.protocol();
    let agent_version = session.agent_version.clone();
    let review_outcome = session.review_id.as_deref()
        .and_then(|id| state.reviews.lock().unwrap().latest(id))
        .map(review::Outcome::name);
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
        "reviewOutcome":review_outcome,
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
    original: Option<String>,
    head: Option<String>,
    context: Option<u32>,
    as_text: Option<bool>,
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
/// 普通差异与任务净差异共用同一套分页。
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
    if request.view == "task" {
        let baseline = session.baseline.as_deref().ok_or_else(|| {
            AppError::new("invalid_baseline", "这次审查没有可用的任务起点。")
        })?;
        fields["baseline"] = json!(baseline);
        if let Some(head) = &request.head {
            fields["head"] = json!(head);
        }
    }
    if let Some(original) = &request.original {
        fields["original"] = json!(original);
    }
    if let Some(context) = request.context {
        fields["context"] = json!(context);
    }
    if let Some(as_text) = request.as_text {
        fields["asText"] = json!(as_text);
    }
    // 对端游标绑定了仓库状态令牌与选择：原样回传让它重新校验，状态已变就明确报错，
    // 而不是拿一个偏移静默读出另一段内容。本地偏移游标没有可校验的令牌，只发偏移。
    if let Some(cursor) = cursor.filter(|cursor| !cursor.starts_with(V2_CURSOR_PREFIX)) {
        fields["cursor"] = json!(cursor);
    }
    let result = session.agent.rpc("diff", fields).await?;
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
    "taskReview",
    "taskReviewToken",
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
    "program", "command", "shell", "cwd", "env", "args", "id", "v", "op", "generation", "operationId", "stateToken",
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
    if !session.with_generation(&mut fields, request.generation.as_deref()) {
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
        worktree_identity: session.worktree_identity.clone(),
    };
    let journal = session.journal(&state.data);
    {
        let _guard = state.mutations.lock().unwrap();
        // 已有待确认记录时不再发第二条写入：结果未知的写入只能先核对。
        if let Some(existing) = find_pending(&state.data, &session)? {
            return Ok(pending_unknown(&existing.record));
        }
        save_pending(&journal, &pending)?;
    }
    let response = session.agent.rpc(&pending.op, fields).await;
    finish_write(state, &session, &journal, &pending, response, false).await
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

fn pending_unknown(pending: &Pending) -> Value {
    let mut result = unknown(&pending.operation_id);
    result["op"] = json!(pending.op);
    result
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
    op: Option<&'a str>,
    repo: Option<&'a str>,
    review_outcome: Option<&'a str>,
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
            op: response["op"].as_str(),
            repo: response["repo"].as_str(),
            review_outcome: None,
        });
    }
    let receipt = response.get("receipt")?;
    Some(WriteProof {
        operation_id: receipt["operationId"].as_str()?,
        state: receipt["state"].as_str()?,
        head: receipt["head"].as_str(),
        branch: receipt["branch"].as_str(),
        reason: receipt["reason"].as_str(),
        op: receipt["op"].as_str(),
        repo: receipt["repo"].as_str(),
        review_outcome: receipt["reviewOutcome"].as_str(),
    })
}

async fn finish_write(
    state: &RemoteWorktrees,
    session: &Session,
    journal: &Path,
    pending: &Pending,
    response: Result<Value>,
    receipt_lookup: bool,
) -> Result<Value> {
    let mut outcome = None;
    let mut completed = match response {
        Ok(response) => {
            let Some(proof) = write_proof(&response).filter(|proof| {
                proof.operation_id == pending.operation_id
                    && response["repo"].as_str().is_none_or(|repo| repo == pending.repo)
                    && if receipt_lookup || session.protocol() == 2 && session.worktree_identity.is_some() {
                        proof.repo == Some(&pending.repo) && proof.op == Some(&pending.op)
                    } else {
                        proof.repo.is_none_or(|repo| repo == pending.repo)
                            && proof.op.is_none_or(|op| op == pending.op)
                    }
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
                    outcome = match (pending.op.as_str(), proof.op, proof.review_outcome) {
                        ("commit", Some("commit"), Some("committed") | None) => Some(review::Outcome::Committed),
                        ("mergeStart" | "mergeComplete", Some("mergeStart" | "mergeComplete"), Some("merged")) => Some(review::Outcome::Merged),
                        ("mergeComplete", Some("mergeComplete"), Some("committed")) => Some(review::Outcome::Committed),
                        _ => None,
                    };
                    json!({"state":"completed","operationId":pending.operation_id,"snapshot":snapshot,"head":snapshot["head"]})
                }
                "failed" => {
                    let error = remote_error(proof.reason.unwrap_or("ssh_failed"));
                    json!({"state":"failed","operationId":pending.operation_id,"message":error.message})
                }
                _ => return Ok(unknown(&pending.operation_id)),
            }
        }
        Err(error) if !receipt_lookup && definitive_error(&error.code) => {
            json!({"state":"failed","operationId":pending.operation_id,"message":remote_error(&error.code).message})
        }
        _ => return Ok(unknown(&pending.operation_id)),
    };
    let _guard = state.mutations.lock().unwrap();
    let cleared = match find_pending(&state.data, session)? {
        Some(current) if current.path == journal && current.record == *pending => {
            if std::fs::remove_file(journal).is_err() {
                return Ok(pending_unknown(pending));
            }
            true
        }
        Some(current) => return Ok(pending_unknown(&current.record)),
        None => false, // A concurrent recovery already removed the verified record.
    };
    if cleared && completed["state"] == "completed" {
        if let (Some(outcome), Some(id), Some(head)) = (outcome, &pending.review_id, completed["head"].as_str()) {
            let recorded = state
                .reviews
                .lock()
                .unwrap()
                .record_result(id, session, outcome, head);
            completed["reviewOutcome"] = json!(recorded.map(review::Outcome::name));
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
        worktree_identity: session.worktree_identity.clone(),
    };
    {
        let _guard = state.mutations.lock().unwrap();
        if let Some(existing) = find_pending(&state.data, &session)? {
            return Ok(pending_unknown(&existing.record));
        }
        save_pending(&journal, &pending)?;
    }
    let response = session.agent.rpc(request.op.name(), fields).await;
    finish_write(&state, &session, &journal, &pending, response, false).await
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
    recover_pending(&state, &session, &operation_id).await
}

async fn recover_pending(state: &RemoteWorktrees, session: &Session, operation_id: &str) -> Result<Value> {
    let file = {
        let _guard = state.mutations.lock().unwrap();
        find_pending(&state.data, session)?.filter(|file| file.record.operation_id == operation_id)
    };
    let Some(file) = file else {
        return Ok(unknown(operation_id));
    };
    let response = if session.legacy_pending(&file.record) {
        legacy_receipt(&state.data, session, &file).await
    } else {
        session.agent.rpc("receipt", json!({"repo":session.repo,"operationId":operation_id})).await
    };
    finish_write(state, session, &file.path, &file.record, response, true).await
}

/// v1 and v2 store receipts separately. The legacy connection is used only to
/// authenticate the recorded worktree and read its receipt.
async fn legacy_receipt(base: &Path, session: &Session, file: &PendingFile) -> Result<Value> {
    let binding = session.legacy_cliora.iter().find(|binding| {
        session.legacy_journal(base, &binding.target.target_id, &binding.peer_identity) == file.path
    }).ok_or_else(|| remote_error("target_changed"))?;
    let probe = query(&binding.helper, "probe", Some(&binding.target)).await?;
    if probe_identity(&probe["peerIdentity"])? != binding.peer_identity {
        return Err(remote_error("target_changed"));
    }
    let peer_revision = probe_identity(&probe["peerRevision"])?;
    let digest = probe_identity(&probe["agentSha256"])?;
    let signature = probe["agentSignature"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(protocol_mismatch)?;
    let mut cmd = command(&binding.helper, "connect", None);
    cmd.args([binding.target.target_id.as_str(), peer_revision, digest, signature]);
    let agent = AgentTransport::spawn(&mut cmd)?;
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let hello = agent.rpc("hello", json!({})).await?;
        if hello["protocol"].as_u64() != Some(1) || hello["agent"].as_str() != Some("twiglane-agent/1") {
            return Err(protocol_mismatch());
        }
        let opened = agent.rpc("open", json!({"path":session.root})).await?;
        if opened["repo"].as_str() != Some(&file.record.repo) || opened["root"].as_str() != Some(&session.root) {
            return Err(remote_error("target_changed"));
        }
        agent.rpc("receipt", json!({"repo":file.record.repo,"operationId":file.record.operation_id})).await
    }).await;
    agent.close().await;
    result.map_err(|_| AppError::new("remote_timeout", "等待旧版远端操作回执超时。"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_errors_keep_authentication_and_trust_diagnostics() {
        let wrapper = r#"{"error":"remote_bootstrap_failed"}"#;
        for (stderr, expected) in [
            (format!("secret-host: Permission denied (publickey,password).\n{wrapper}"), "ssh_auth_failed"),
            (format!("debug1: No more authentication methods to try.\n{wrapper}"), "ssh_auth_failed"),
            (format!("Host key verification failed.\n{wrapper}"), "ssh_host_key_untrusted"),
            (format!("Permission denied (publickey).\n{{\"error\":\"target_changed\"}}\n{wrapper}"), "target_changed"),
            (format!("touch: Permission denied\n{wrapper}"), "remote_bootstrap_failed"),
        ] {
            let error = output_error(stderr.as_bytes());
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("secret-host"));
        }
    }

    #[tokio::test]
    async fn connector_hello_preserves_authentication_and_protocol_failures() {
        let mut probe = Command::new("node");
        probe.args(["-e", r#"process.stdout.write('{"system":"Linux"}')"#]);
        assert_eq!(query_command(probe).await.unwrap()["system"], "Linux");

        for (stdout, expected) in [("", "ssh_auth_failed"), ("invalid frame\n", "remote_protocol")] {
            let mut command = Command::new("node");
            let stdout = json!(stdout);
            command.args(["-e", &format!(r#"
                process.stdin.once("data", () => {{
                    process.stderr.write(
                        "fixture-private: Permission denied (publickey).\n" +
                        '{{"error":"remote_bootstrap_failed"}}\n',
                        () => process.stdout.write({stdout}, () => process.exit(1)),
                    );
                }});
            "#)]);
            let agent = AgentTransport::spawn_connector_v2(&mut command, output_error).unwrap();
            let error = agent.rpc("hello", json!({})).await.unwrap_err();
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("fixture-private"));
            agent.close().await;
        }
    }

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
        std::fs::write(&helper, r#"#!/bin/sh
cat > "$(dirname "$0")/received" || exit 1
printf '{"installed":true,"agentSha256":"%s"}\n' "$5"
"#).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let bytes = b"fixture\x00binary".to_vec();
        let artifact = AgentArtifact {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
            version: "1.0.0".into(),
            signature: "c2ln".into(),
            digest_signature: "YXR0".into(),
        };
        let command = component_command(&helper, "install-v2", "host-a", &"a".repeat(64), &artifact).unwrap();
        tokio::time::timeout(Duration::from_secs(5), upload(command, &artifact, &Channel::new(|_| Ok(()))))
            .await.expect("installer did not receive EOF").unwrap();
        assert_eq!(std::fs::read(dir.path().join("received")).unwrap(), artifact.bytes);
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
            worktree_identity: None,
            peer_identity: "same-host".into(),
            journal_identity: "same-account".into(),
            host_identity: "same-host".into(),
            legacy_cliora: Vec::new(),
            baseline: None,
            hunk_stageable: false,
            agent_version: "v1".into(),
            state_token: Mutex::default(),
            _session_dir: None,
        };
        let journal = session.journal(dir.path());
        session.target.target_revision = "edited-catalog".into();
        assert_eq!(journal, session.journal(dir.path()));
        session.host_identity = "replacement-host".into();
        assert_eq!(journal, session.journal(dir.path()));
        session.journal_identity = "replacement-account".into();
        assert_ne!(journal, session.journal(dir.path()));
        session.journal_identity = "same-account".into();

        let pending = Pending {
            review_id: None,
            operation_id: Uuid::new_v4().to_string(),
            op: WriteKind::Commit.name().to_owned(),
            repo: session.repo.clone(),
            worktree_identity: None,
        };
        save_pending(&journal, &pending).unwrap();
        let response = session
            .agent
            .rpc("commit", json!({"message": "\u{0001}".repeat(24_000)}))
            .await;
        assert_eq!(response.as_ref().unwrap_err().code, "remote_request_size");
        let result = finish_write(&state, &session, &journal, &pending, response, false)
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
            worktree_identity: None,
            peer_identity: "a".repeat(64),
            journal_identity: "stable-account".into(),
            host_identity: "a".repeat(64),
            legacy_cliora: Vec::new(),
            baseline: None,
            hunk_stageable: false,
            agent_version: "test".into(),
            state_token: Mutex::default(),
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

    #[tokio::test(flavor = "current_thread")]
    async fn a_pending_write_blocks_a_second_provider_without_sending_another_write() {
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

        // The alternative provider has independent catalog and peer guards.
        let mut alternate = test_session(fake_agent(dir.path(), "complete"));
        alternate.target.target_id = "alternate-provider".into();
        alternate.peer_identity = "different-route-peer-key".into();
        alternate.peer_revision = "different-route-peer-revision".into();
        alternate.host_identity = "different-negotiated-key".into();
        assert_eq!(journal, alternate.journal(&state.data));
        state.sessions.lock().unwrap().insert("alternate".into(), Arc::new(alternate));
        let second = bridge_call(
            &state,
            CallRequest {
                session_id: "alternate".into(),
                op: "pull".into(),
                fields: json!({}),
                generation: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(second["state"], "unknown");
        assert_eq!(second["operationId"], first["operationId"]);
        assert_eq!(second["op"], "fetch");
        assert_eq!(requests(dir.path()), vec!["fetch".to_string()]);
        let alternate = state.session("alternate").unwrap();
        let operation_id = first["operationId"].as_str().unwrap();
        let mismatch = recover_pending(&state, &alternate, operation_id).await.unwrap();
        assert_eq!(mismatch["state"], "unknown");
        assert!(journal.exists());
        assert_eq!(requests(dir.path()), vec!["fetch", "receipt"]);
        state.session("session-a").unwrap().agent.close().await;
        alternate.agent.close().await;
    }

    #[tokio::test]
    async fn only_exact_legacy_journals_apply_even_with_the_same_remote_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut session = test_session(fake_agent(dir.path(), "complete"));
        session.worktree_identity = Some("c".repeat(64));
        let record = Pending {
            review_id: None,
            operation_id: Uuid::new_v4().to_string(),
            op: "stage".into(),
            repo: session.repo.clone(),
            worktree_identity: session.worktree_identity.clone(),
        };
        let current = session.journal(dir.path());
        let mut different_host = test_session(fake_agent(dir.path(), "complete"));
        different_host.target.target_id = "other-host".into();
        different_host.host_identity = "other-host-key".into();
        different_host.peer_identity = "other-peer-chain".into();
        different_host.journal_identity = "other-account".into();
        different_host.worktree_identity = session.worktree_identity.clone();
        let foreign = different_host.legacy_journal(dir.path(), &different_host.target.target_id, &different_host.peer_identity);
        let foreign_v2 = different_host.legacy_worktree_journal(dir.path(), &different_host.host_identity);
        save_pending(&foreign, &record).unwrap();
        save_pending(&foreign_v2, &record).unwrap();
        assert!(find_pending(dir.path(), &session).unwrap().is_none());

        let exact = session.legacy_journal(dir.path(), &session.target.target_id, &session.peer_identity);
        save_pending(&exact, &record).unwrap();
        assert_eq!(find_pending(dir.path(), &session).unwrap().unwrap().path, exact);
        save_pending(&current, &record).unwrap();
        assert!(matches!(find_pending(dir.path(), &session), Err(error) if error.code == "remote_journal"));
        assert!(current.is_file() && exact.is_file() && foreign.is_file() && foreign_v2.is_file());
        std::fs::remove_file(exact).unwrap();
        let mut mismatched = record;
        mismatched.worktree_identity = Some("d".repeat(64));
        save_pending(&current, &mismatched).unwrap();
        assert!(matches!(find_pending(dir.path(), &session), Err(error) if error.code == "target_changed"));
        assert!(current.is_file());
        session.agent.close().await;
        different_host.agent.close().await;
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
            original: None,
            head: None,
            context: None,
            as_text: None,
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

    #[cfg(unix)]
    #[tokio::test]
    async fn cliora_v2_checks_capability_and_install_offer_before_writing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let helper = root.join("cliora");
        std::fs::write(&helper, r#"#!/bin/sh
cd -- "$(dirname "$0")" || exit 1
case "$2" in
  version|list|probe-v2) cat "$2.json" ;;
  *) touch wrote; exit 1 ;;
esac
"#).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let target = json!({
            "targetId": "host-a", "targetRevision": "catalog-a", "name": "A",
            "host": "test.invalid", "port": 22, "user": "test", "authMethod": "key",
        });
        let write = |name: &str, value: Value| std::fs::write(root.join(name), value.to_string()).unwrap();
        write("version.json", json!({"protocol":1,"capabilities":[]}));
        write("list.json", json!({"protocol":1,"targets":[target]}));
        let mut probe = json!({
            "system":"Linux","architecture":"x86_64","peerRevision":"b".repeat(64),
            "peerIdentity":"c".repeat(64),
        });
        write("probe-v2.json", probe.clone());
        let store = AppStore::open(root.join("state.json"));
        let ssh = RemoteSsh::with_exec(root.join("artifacts"), root.join("unused"), Vec::new());
        let access = V2Access { store: &store, ssh: &ssh, v2_dir: None };
        let mut request = OpenRequest {
            request_id: Uuid::new_v4().to_string(),
            target_id: "host-a".into(),
            target_revision: "catalog-a".into(),
            path: "/repo".into(),
            baseline: None,
            allow_install: false,
            install_confirmation: None,
            review_id: None,
        };
        let progress = Channel::new(|_| Ok(()));
        let absent = connect(Some(&helper), &request, None, None, &progress, &access).await.err().unwrap();
        assert_eq!(absent.code, "cliora_incompatible");
        write("version.json", json!({"protocol":1,"capabilities":["agentV2"]}));
        let absent = connect(Some(&helper), &request, None, None, &progress, &access).await.err().unwrap();
        assert_eq!(absent.code, "agent_artifact_manifest");
        let artifacts = root.join("artifacts");
        std::fs::create_dir(&artifacts).unwrap();
        std::fs::write(artifacts.join("agent"), b"artifact").unwrap();
        std::fs::write(artifacts.join("manifest.json"), json!({
            "format":1,"artifacts":[{"system":"Linux","architecture":"x86_64","file":"agent",
                "version":"1.0.0","sha256":format!("{:x}",Sha256::digest(b"artifact")),"signature":"c2ln",
                "digestSignature":"YXR0"}],
        }).to_string()).unwrap();
        let Opened::NeedsInstall(offer) = connect(Some(&helper), &request, None, None, &progress, &access).await.unwrap() else {
            panic!("missing remote component requires confirmation");
        };
        request.allow_install = true;
        probe["peerRevision"] = json!("d".repeat(64));
        write("probe-v2.json", probe);
        let stale = connect(Some(&helper), &request, Some(offer), None, &progress, &access).await.err().unwrap();
        assert_eq!(stale.code, "target_changed");
        assert!(!root.join("wrote").exists(), "mismatched configuration must not install or connect");
    }
}
