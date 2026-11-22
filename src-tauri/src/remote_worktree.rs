pub(crate) mod review;

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
        self.status_for(self.baseline.as_deref()).await
    }

    async fn status_for(&self, baseline: Option<&str>) -> Result<Value> {
        let mut fields = json!({"repo":self.repo});
        if let Some(baseline) = baseline {
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
    source: Option<&review::Source>,
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
    if let Some(source) = source {
        source.check_peer(peer, &peer_identity)?;
    }
    let selected = InstallTarget {
        review_id: request.review_id.clone(),
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
    // 块级暂存必须由远端自己声明：v1 组件没有 `patch`，`capabilities` 缺省即不支持。
    let hunk_stageable = snapshot["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some("patch")));
    if let Some(source) = source {
        source.check_tree(root.unwrap_or_default(), repo.unwrap_or_default())?;
    }
    match (repo, root) {
        (Some(repo), Some(root)) => Ok(Opened::Worktree(
            Box::new(Session {
                review_id: request.review_id.clone(),
                peer_revision: peer.to_owned(),
                agent,
                repo: repo.into(),
                root: root.into(),
                target,
                peer_identity,
                baseline: request.baseline.clone(),
                hunk_stageable,
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
        let join = tokio::spawn(async move {
            let path = connector().await?;
            connect(&path, &request, confirm, source.as_ref(), &on_progress).await
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
        fields.insert("generation".into(), json!(generation));
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
            review_id: None,
            target_id: request.target_id.clone(),
            revision: request.target_revision.clone(),
            peer: "a".repeat(64),
            path: request.path.clone(),
        };
        let result = connect(
            &helper,
            &request,
            Some(confirmed),
            None,
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
            review_id: None,
            peer_revision: "same-peer-revision".into(),
            agent,
            repo: "repo-a".into(),
            target,
            root: "/repo".into(),
            peer_identity: "same-host".into(),
            baseline: None,
            hunk_stageable: false,
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
}
