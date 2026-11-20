use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::error::AppError;
use crate::remote_worktree_transport::{AgentTransport, ScopedChild};

const FLAG: &str = "--twiglane-remote-v1";
static AGENT: &[u8] = include_bytes!("../../remote-agent/agent");
const SIGNATURE: Option<&str> = option_env!("TWIGLANE_REMOTE_AGENT_SIGNATURE");

type Result<T> = std::result::Result<T, AppError>;
type Managed<'a> = State<'a, Arc<RemoteWorktrees>>;

pub(crate) struct RemoteWorktrees {
    data: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    openings: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    installs: Mutex<HashMap<String, InstallTarget>>,
    mutations: Mutex<()>,
}

impl RemoteWorktrees {
    pub(crate) fn new(data: PathBuf) -> Self {
        Self {
            data,
            sessions: Mutex::default(),
            openings: Mutex::default(),
            installs: Mutex::default(),
            mutations: Mutex::default(),
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
}

#[derive(Clone, PartialEq, Eq)]
struct InstallTarget {
    target_id: String,
    revision: String,
    peer: String,
    path: String,
}

enum Opened {
    Worktree(Box<Session>, Value),
    NeedsInstall(InstallTarget),
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
    operation_id: String,
    op: WriteKind,
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
    agent: AgentTransport,
    repo: String,
    target: Target,
    root: String,
    peer_identity: String,
    baseline: Option<String>,
}

impl Session {
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
        let mut fields = json!({"repo":self.repo});
        if let Some(baseline) = &self.baseline {
            fields["baseline"] = json!(baseline);
        }
        let result = self.agent.rpc("status", fields).await?;
        if result.get("repo").and_then(Value::as_str) == Some(&self.repo) {
            return Ok(result);
        }
        Err(AppError::new("target_changed", "远端工作树身份已变化。"))
    }
}

fn remote_error(code: &str) -> AppError {
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

fn publish(channel: &Channel<Progress>, phase: &'static str, sent: Option<u64>) {
    let _ = channel.send(Progress {
        phase,
        sent_bytes: sent,
        total_bytes: sent.map(|_| AGENT.len() as u64),
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
    publish(progress, "installing", Some(0));
    let mut cmd = command(path, "install", Some(target));
    cmd.args([digest, signature])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ScopedChild::spawn(&mut cmd).map_err(|_| remote_error("ssh_failed"))?;
    let mut stdin = child.take_stdin().unwrap();
    let stdout = child.take_stdout().unwrap();
    let stderr = child.take_stderr().unwrap();
    let write = async {
        stdin
            .write_all(AGENT)
            .await
            .map_err(|_| remote_error("ssh_failed"))?;
        stdin
            .shutdown()
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
                    publish(progress, "installing", Some(received));
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

async fn connect(
    path: &Path,
    request: &OpenRequest,
    confirm: Option<InstallTarget>,
    progress: &Channel<Progress>,
) -> Result<Opened> {
    publish(progress, "connecting", None);
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
    if !matches!(probe["system"].as_str(), Some("Linux" | "Darwin"))
        || !probe["pythonVersion"]
            .as_str()
            .and_then(|version| {
                let mut parts = version.split('.');
                Some((
                    parts.next()?.parse::<u32>().ok()?,
                    parts.next()?.parse::<u32>().ok()?,
                ))
            })
            .is_some_and(|version| version >= (3, 8))
    {
        return Err(AppError::new(
            "remote_unsupported",
            "远端需要 Linux 或 macOS、Python 3.8 及以上与系统 Git。",
        ));
    }
    let peer = probe_identity(&probe["peerRevision"])?;
    let peer_identity = probe_identity(&probe["peerIdentity"])?.to_owned();
    let selected = InstallTarget {
        target_id: target.target_id.clone(),
        revision: target.target_revision.clone(),
        peer: peer.to_owned(),
        path: request.path.clone(),
    };
    if request.allow_install && confirm.as_ref() != Some(&selected) {
        return Err(AppError::new(
            "target_changed",
            "安装目标已变化，请重新打开并确认。",
        ));
    }
    let mut bound_target = target.clone();
    bound_target.target_revision = selected.peer.clone();
    let expected = format!("{:x}", Sha256::digest(AGENT));
    let installed = probe["agentSha256"]
        .as_str()
        .zip(probe["agentSignature"].as_str());
    let mut agent = None;
    if let Some((digest, signature)) = installed {
        let compatible =
            signature != "development" || (cfg!(debug_assertions) && digest == expected);
        if compatible {
            let existing = start(path, &bound_target, digest, signature)?;
            let hello =
                tokio::time::timeout(Duration::from_secs(120), existing.rpc("hello", json!({})))
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
    let agent = agent.unwrap();
    publish(progress, "opening", None);
    let mut fields = json!({"path":request.path});
    if let Some(baseline) = &request.baseline {
        fields["baseline"] = json!(baseline);
    }
    let snapshot = tokio::time::timeout(Duration::from_secs(120), agent.rpc("open", fields))
        .await
        .map_err(|_| AppError::new("remote_timeout", "等待远端仓库状态超时。"))??;
    let repo = snapshot["repo"].as_str().filter(|value| !value.is_empty());
    let root = snapshot["root"]
        .as_str()
        .filter(|value| valid_path(value, true));
    match (repo, root) {
        (Some(repo), Some(root)) => Ok(Opened::Worktree(
            Box::new(Session {
                agent,
                repo: repo.into(),
                root: root.into(),
                target,
                peer_identity,
                baseline: request.baseline.clone(),
            }),
            snapshot,
        )),
        _ => Err(AppError::new(
            "remote_protocol",
            "远端返回的工作树标识无效。",
        )),
    }
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
    request: OpenRequest,
    on_progress: Channel<Progress>,
) -> Result<Value> {
    if !uuid(&request.request_id) || !valid_path(&request.path, true) {
        return Err(AppError::new("invalid_path", "请选择有效的远端绝对目录。"));
    }
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
        let join = tokio::spawn(async move {
            let path = connector().await?;
            connect(&path, &request, confirm, &on_progress).await
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
    let (session, snapshot) = match response {
        Opened::Worktree(session, snapshot) => (session, snapshot),
        Opened::NeedsInstall(offer) => {
            let mut installs = state.installs.lock().unwrap();
            // The UI carries only one offer. Keep a small bounded set for resumed requests.
            if installs.len() >= 16 {
                installs.clear();
            }
            let id = Uuid::new_v4().to_string();
            installs.insert(id.clone(), offer);
            return Ok(
                json!({"kind":"install_required","version":"v1","size":AGENT.len(),"confirmationId":id}),
            );
        }
    };
    let pending = {
        let _guard = state.mutations.lock().unwrap();
        read_pending(&session.journal(&state.data), &session.repo)?
    };
    let session_id = Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::from(session));
    Ok(json!({"kind":"open","sessionId":session_id,"snapshot":snapshot,"pendingWrite":pending}))
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

#[tauri::command]
pub async fn remote_worktree_diff(state: Managed<'_>, request: DiffRequest) -> Result<Value> {
    let session = state.session(&request.session_id)?;
    if !valid_path(&request.path, false)
        || !matches!(request.view.as_str(), "staged" | "unstaged" | "task")
    {
        return Err(AppError::new(
            "invalid_selection",
            "请选择远端工作树内的改动文件。",
        ));
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
    session.agent.rpc("diff", fields).await
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
    )
}

async fn finish_write(
    state: &RemoteWorktrees,
    session: &Session,
    journal: &Path,
    pending: &Pending,
    response: Result<Value>,
) -> Result<Value> {
    let completed = match response {
        Ok(response)
            if response["repo"].as_str() == Some(&session.repo)
                && response["operationId"].as_str() == Some(&pending.operation_id) =>
        {
            match response["state"].as_str() {
                Some("completed") => {
                    let Ok(snapshot) = session.status().await else {
                        return Ok(unknown(&pending.operation_id));
                    };
                    if snapshot["head"] != response["head"]
                        || snapshot["branch"] != response["branch"]
                    {
                        return Ok(unknown(&pending.operation_id));
                    }
                    json!({"state":"completed","operationId":pending.operation_id,"snapshot":snapshot,"head":response["head"]})
                }
                Some("failed") => {
                    let error = remote_error(response["reason"].as_str().unwrap_or("ssh_failed"));
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
    Ok(completed)
}

#[tauri::command]
pub async fn remote_worktree_write(state: Managed<'_>, request: WriteRequest) -> Result<Value> {
    let session = state.session(&request.session_id)?;
    let fail = |message: &str| json!({"state":"failed","operationId":request.operation_id,"message":message});
    if !uuid(&request.operation_id) {
        return Ok(fail("远端操作标识无效。"));
    }
    let mut fields = json!({
        "repo":session.repo,"generation":request.generation,"operationId":request.operation_id,
    });
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
    let pending = Pending {
        operation_id: request.operation_id,
        op: request.op,
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
        };
        let confirmed = InstallTarget {
            target_id: request.target_id.clone(),
            revision: request.target_revision.clone(),
            peer: "a".repeat(64),
            path: request.path.clone(),
        };
        let result = connect(
            &helper,
            &request,
            Some(confirmed),
            &Channel::new(|_| Ok(())),
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
            agent,
            repo: "repo-a".into(),
            target,
            root: "/repo".into(),
            peer_identity: "same-host".into(),
            baseline: None,
        };
        let journal = session.journal(dir.path());
        session.target.target_revision = "edited-catalog".into();
        assert_eq!(journal, session.journal(dir.path()));
        session.peer_identity = "replacement-host".into();
        assert_ne!(journal, session.journal(dir.path()));
        session.peer_identity = "same-host".into();

        let pending = Pending {
            operation_id: Uuid::new_v4().to_string(),
            op: WriteKind::Commit,
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
}
