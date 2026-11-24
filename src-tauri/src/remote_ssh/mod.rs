//! Twiglane 自有 SSH 主机簿与直接连接（R3）。
//!
//! 与 v1 经 Cliora 连接器转发的路径并存：这条路径不查找、不调用 Cliora，
//! Cliora 未安装或已退出都能打开远端仓库。规则沿用 Cliora 已实机验证的部分：
//! `ssh -G` 有效配置快照、known_hosts/撤销文件、ProxyJump、实际对端身份与配置修订，
//! 但全部实现都在本进程内，不依赖 Cliora。
//!
//! 三个安全边界：
//! - 总开关缺省关闭；关闭时任何路径都不发起新连接，主机与密码仍保留。
//! - 密码只进 `twiglane.remote-ssh` 系统钥匙串，界面只得到布尔状态。
//! - askpass 只回答绑定目标的密码/口令提示，主机密钥问题一律不代答。

mod artifact;
mod config;
mod password;
mod transport;
pub(crate) mod upload;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

use crate::change_request::credential::validate_ssh_password;
use crate::change_request::{CredentialStore, KeyringStore};
use crate::error::AppError;
use crate::git::ops::Backend;
use crate::remote_worktree_transport::ScopedChild;
use crate::state::{AppStore, SshTarget};

use config::Snapshot;

type Result<T> = std::result::Result<T, AppError>;
type Managed<'a> = State<'a, Arc<RemoteSsh>>;
type BackendState<'a> = State<'a, Arc<Backend>>;

const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
/// 单次命令的诊断输出上限；超限即视为协议异常。
const DIAGNOSTIC_BYTES: u64 = 256 * 1024;
const HOST_KEY_FLAG: &str = "--twiglane-ssh-host-key";
const HOST_KEY_DIR: &str = "TWIGLANE_SSH_HOST_KEY_DIR";

/// OpenSSH invokes this locally while checking the final peer's host key.
/// The callback supplies no trust entries and stores only the digest used by Cliora.
pub fn handle_ssh_host_key_callback() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(HOST_KEY_FLAG)) {
        return;
    }
    let captured = (|| -> Option<()> {
        let phase = args.next()?;
        let key = args.next()?;
        if args.next().is_some() {
            return None;
        }
        if phase == "ORDER" || phase == "ADDRESS" {
            return Some(());
        }
        let key = key.to_str().filter(|key| !key.is_empty() && *key != "NONE")?;
        if phase != "HOSTNAME" {
            return None;
        }
        let folder = PathBuf::from(std::env::var_os(HOST_KEY_DIR)?);
        if folder.parent() != Some(std::env::temp_dir().as_path())
            || !folder.file_name()?.to_str()?.starts_with("twiglane-ssh-")
        {
            return None;
        }
        let mut digest = Sha256::new();
        digest.update(b"cliora-twiglane-host-key-v1\0");
        digest.update(Sha256::digest(key.as_bytes()));
        let identity = format!("{:x}", digest.finalize());
        let path = folder.join("host-identity");
        use std::io::Write;
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => file.write_all(identity.as_bytes()).ok(),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                (std::fs::read_to_string(path).ok()? == identity).then_some(())
            }
            Err(_) => None,
        }
    })();
    std::process::exit(if captured.is_some() { 0 } else { 1 });
}

fn captured_host_identity(folder: &Path) -> Option<String> {
    std::fs::read_to_string(folder.join("host-identity")).ok().filter(|identity| {
        identity.len() == 64 && identity.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn disabled() -> AppError {
    AppError::new(
        "remote_ssh_disabled",
        "远程 SSH 已在设置中关闭。开启总开关后才新建连接；已保存的主机与密码仍保留。",
    )
}

fn target_disabled() -> AppError {
    AppError::new(
        "target_unavailable",
        "该主机已在主机簿中停用。请先在设置中启用它，再连接。",
    )
}

fn target_missing() -> AppError {
    AppError::new("target_unavailable", "主机簿里没有这台主机，请重新选择。")
}

fn changed() -> AppError {
    AppError::new(
        "target_changed",
        "主机的配置、认证或信任信息已变化，需要重新确认后再连接。",
    )
}

fn timed_out(stage: &str) -> AppError {
    AppError::new(
        "remote_timeout",
        format!("等待 SSH {stage}超时。可以重试，或检查网络与主机状态。"),
    )
}

fn ssh_unavailable() -> AppError {
    AppError::new(
        "ssh_unavailable",
        "无法执行 OpenSSH 客户端（ssh）。请确认已安装 OpenSSH 并可从 PATH 调用。",
    )
}

fn ssh_failed() -> AppError {
    AppError::new(
        "ssh_failed",
        "SSH 连接未完成。请检查主机、认证方式和已信任的主机密钥。",
    )
}

fn invalid_request() -> AppError {
    AppError::new("remote_request", "请求参数无效，本次操作尚未发送。")
}

/// 本机 ssh 可执行文件与附加环境。测试用替身覆盖两者；生产一律走 PATH 上的 ssh。
#[derive(Debug, Clone)]
pub(crate) struct SshExec {
    program: PathBuf,
    env: Vec<(String, String)>,
}

impl Default for SshExec {
    fn default() -> Self {
        Self {
            program: PathBuf::from("ssh"),
            env: Vec::new(),
        }
    }
}

impl SshExec {
    /// 给 `ssh -G` 用的阻塞命令。
    pub(crate) fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command
    }

    fn async_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command
    }
}

/// 一次设置/连接操作的上下文：设置存储、密码钥匙串、ssh 可执行文件与产物目录。
struct Context<'a> {
    store: &'a AppStore,
    credentials: Box<dyn CredentialStore + 'a>,
    exec: SshExec,
    artifacts: PathBuf,
}

impl<'a> Context<'a> {
    fn new(store: &'a AppStore, ssh: &RemoteSsh) -> Self {
        Self {
            store,
            credentials: Box::new(KeyringStore::remote_ssh()),
            exec: ssh.exec.clone(),
            artifacts: ssh.artifacts.clone(),
        }
    }

    /// 总开关与逐台启停的唯一起点：关闭时这里就失败，不会走到建连代码。
    fn resolve_target(&self, id: &str) -> Result<SshTarget> {
        if !self.store.remote_ssh_enabled() {
            return Err(disabled());
        }
        let target = self.store.remote_ssh_target(id).ok_or_else(target_missing)?;
        if !target.enabled {
            return Err(target_disabled());
        }
        Ok(target)
    }

    /// `ssh -G` 是本地阻塞调用，放进阻塞线程池，避免占用异步 worker。
    async fn snapshot(&self, target: &SshTarget) -> Result<Snapshot> {
        let exec = self.exec.clone();
        let target = target.clone();
        tokio::task::spawn_blocking(move || Snapshot::resolve(&exec, &target))
            .await
            .map_err(|_| ssh_unavailable())?
    }

    fn password(&self, id: &str) -> Option<String> {
        self.credentials.load(id).ok().flatten()
    }

    fn has_password(&self, id: &str) -> bool {
        self.password(id).is_some_and(|value| !value.is_empty())
    }

    /// 私有会话目录：只给当前用户，连接或安装结束即删除。
    fn private_dir() -> Result<tempfile::TempDir> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("twiglane-ssh-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        builder.tempdir().map_err(|_| {
            AppError::new("ssh_unavailable", "无法创建本次连接使用的私有临时目录。")
        })
    }

    /// 构造一次真实连接的命令：冻结配置 + 信任副本 + 可选的 askpass。
    /// `remote` 只能是本模块的常量脚本；`verbose` 用于探测时读取实际主机密钥。
    fn build(
        &self,
        target: &SshTarget,
        snapshot: &Snapshot,
        folder: &Path,
        remote: &str,
        verbose: bool,
        capture_host_key: bool,
    ) -> Result<Command> {
        #[cfg(not(test))]
        let helper = capture_host_key.then(std::env::current_exe).transpose().map_err(|_| ssh_unavailable())?;
        #[cfg(test)]
        let helper = self.exec.env.iter()
            .find(|(key, _)| capture_host_key && key == "TWIGLANE_SSH_TEST_PEER_HELPER")
            .map(|(_, value)| PathBuf::from(value));
        let mut args = snapshot.args_with_host_key(folder, target, helper.as_deref())?;
        let password = if target.auth_method == "password" {
            match self.password(&target.id) {
                Some(secret) if !secret.is_empty() => Some(secret),
                _ => {
                    return Err(AppError::new(
                        "password_required",
                        "该主机使用密码认证，但本机还没有保存密码。请先在设置中保存密码，或改用密钥/ssh-agent。",
                    ))
                }
            }
        } else {
            None
        };
        let mut command = self.exec.async_command();
        if helper.is_some() {
            command.env(HOST_KEY_DIR, folder);
        }
        let mut prefix: Vec<OsString> = Vec::new();
        if verbose {
            prefix.push(OsString::from("-v"));
        }
        match password {
            Some(secret) => {
                let askpass = password::install(folder, &secret)?;
                command.env("SSH_ASKPASS", &askpass.script);
                command.env("SSH_ASKPASS_REQUIRE", "force");
                command.env(password::SECRET_ENV, &askpass.secret);
                // askpass 只在提示里出现该主机时才作答：跳板机提示拿不到这个秘密。
                command.env(password::HOST_ENV, &target.host);
                // 没有终端时 OpenSSH 才走 askpass；DISPLAY 让它认为有交互可能。
                command.env("DISPLAY", ":0");
            }
            None => {
                // 密钥或 agent 认证：不允许任何交互式回退，缺凭据就直接失败。
                command.env_remove("SSH_ASKPASS_REQUIRE");
                prefix.push(OsString::from("-o"));
                prefix.push(OsString::from("BatchMode=yes"));
            }
        }
        prefix.append(&mut args);
        command.args(prefix);
        command.arg(remote);
        // 取消（abort）时连同本机拥有的 SSH 进程一起终止，不留下仍在跑的连接。
        command.kill_on_drop(true);
        Ok(command)
    }
}

fn stdout_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

/// 探测结果。`peer_revision` 绑定配置修订与实际对端密钥；`peer_identity` 只有对端身份，
/// 信任文件改动会改变前者而不改变后者。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    target_id: String,
    display_name: String,
    effective_host: String,
    config_revision: String,
    peer_revision: String,
    peer_identity: String,
    #[serde(skip)]
    host_identity: Option<String>,
    system: String,
    architecture: String,
    git: Option<String>,
    agent_installed: bool,
    agent_version: Option<String>,
    agent_digest: Option<String>,
    agent_compatible: bool,
    /// 远端组件自述（`--probe` 的 JSON）。只给进程内使用，不进前端契约。
    #[serde(skip)]
    agent_probe: Option<Value>,
    #[serde(skip)]
    shell: transport::Shell,
    hops: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetView {
    id: String,
    display_name: String,
    host: String,
    port: u16,
    user: String,
    auth_method: String,
    identity_file: Option<String>,
    ssh_config: Option<String>,
    default_path: Option<String>,
    enabled: bool,
    shared_host_id: Option<String>,
    revision: u64,
    /// 只有布尔状态：密码本身永远不回传前端。
    has_password: bool,
}

impl TargetView {
    fn of(target: &SshTarget, has_password: bool) -> Self {
        Self {
            id: target.id.clone(),
            display_name: target.display_name.clone(),
            host: target.host.clone(),
            port: target.port,
            user: target.user.clone(),
            auth_method: target.auth_method.clone(),
            identity_file: target.identity_file.clone(),
            ssh_config: target.ssh_config.clone(),
            default_path: target.default_path.clone(),
            enabled: target.enabled,
            shared_host_id: target.shared_host_id.clone(),
            revision: target.revision,
            has_password,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 缺省关闭；关闭时任何路径都不新建连接。
    enabled: bool,
    targets: Vec<TargetView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    phase: &'static str,
    sent_bytes: u64,
    total_bytes: u64,
}

#[derive(Clone)]
struct InstallOffer {
    target_id: String,
    peer_revision: String,
    digest: String,
    version: String,
}

/// 应用管理的远程 SSH 状态：进行中的测试/安装（可取消）与待确认的安装。
pub(crate) struct RemoteSsh {
    artifacts: PathBuf,
    exec: SshExec,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    offers: Mutex<HashMap<String, InstallOffer>>,
}

impl RemoteSsh {
    pub(crate) fn new(artifacts: PathBuf) -> Self {
        Self {
            artifacts,
            exec: SshExec::default(),
            running: Mutex::new(HashMap::new()),
            offers: Mutex::new(HashMap::new()),
        }
    }

    /// 产物目录：开发/测试可显式指定，发行包放在资源目录的 `agent-v2`。
    pub(crate) fn artifacts_for(app: &AppHandle, data: &Path) -> PathBuf {
        if let Some(path) = std::env::var_os("TWIGLANE_AGENT_V2_DIR") {
            return PathBuf::from(path);
        }
        app.path()
            .resource_dir()
            .map(|dir| dir.join("agent-v2"))
            .unwrap_or_else(|_| data.join("agent-v2"))
    }

    fn register(&self, request_id: &str, abort: tokio::task::AbortHandle) -> Result<()> {
        let mut running = self.running.lock().unwrap_or_else(|error| error.into_inner());
        if running.contains_key(request_id) || running.len() >= 4 {
            return Err(AppError::new(
                "remote_busy",
                "其他远程连接操作仍在进行，请稍后再试。",
            ));
        }
        running.insert(request_id.to_string(), abort);
        Ok(())
    }

    fn release(&self, request_id: &str) -> bool {
        self.running
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(request_id)
            .is_some()
    }
}

fn peer_revision(config_revision: &str, host_keys: &[String]) -> Result<(String, String)> {
    let identity = Snapshot::peer_identity(host_keys).ok_or_else(|| {
        AppError::new(
            "ssh_peer_unverified",
            "没有拿到远端实际主机密钥，无法绑定本次连接身份。请重试并检查 SSH 诊断输出。",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(config_revision.as_bytes());
    digest.update([0]);
    digest.update(identity.as_bytes());
    Ok((format!("{:x}", digest.finalize()), identity))
}

async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(pipe: R, limit: u64) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    pipe.take(limit + 1)
        .read_to_end(&mut data)
        .await
        .map_err(|_| ssh_failed())?;
    if data.len() as u64 > limit {
        return Err(AppError::new(
            "remote_protocol",
            "SSH 诊断输出超过限制，已中止本次操作。",
        ));
    }
    Ok(data)
}

/// 把 SSH 失败翻译成可读原因，不把原始诊断文本回传界面（可能含主机名或路径）。
fn ssh_error(stderr: &str, code: Option<i32>) -> AppError {
    if stderr.lines().any(|line| {
        let line = line.to_ascii_lowercase();
        line.contains("knownhostscommand")
            && (line.contains("bad configuration option") || line.contains("unsupported option"))
    }) {
        return AppError::new(
            "ssh_host_key_lookup_unavailable",
            "当前 OpenSSH 不支持核对远端仓库所需的主机密钥，请更新本机 OpenSSH 客户端。",
        );
    }
    if stderr.contains("Host key verification failed") {
        return AppError::new(
            "ssh_host_key_untrusted",
            "该主机的密钥不在本机的 known_hosts 中，或与已信任的记录不同。Twiglane 不会替你接受新的主机密钥，请先在系统 known_hosts 中确认这台主机。",
        );
    }
    if stderr.contains("Permission denied") {
        return AppError::new(
            "ssh_auth_failed",
            "SSH 认证失败。请检查密钥、ssh-agent 或已保存的密码。",
        );
    }
    if stderr.contains("agent_digest_mismatch") {
        return AppError::new(
            "agent_digest_mismatch",
            "远端已安装的组件与预期摘要不一致，请重新安装。",
        );
    }
    if stderr.contains("unsafe_install_directory") {
        return AppError::new(
            "unsafe_install_directory",
            "远端安装目录对其他用户可写，拒绝在其中写入组件。",
        );
    }
    if stderr.contains("agent_missing") {
        return AppError::new(
            "agent_missing",
            "远端还没有安装 Twiglane 远端组件，请先安装。",
        );
    }
    for (reason, message) in [
        (
            "agent_probe_failed",
            "无法读取 Windows 远端组件的安装状态。请检查登录账号的配置和目录权限。",
        ),
        (
            "agent_install_failed",
            "Windows 远端组件安装未完成。请检查登录账号的目录权限和磁盘空间后重试。",
        ),
        (
            "agent_start_failed",
            "无法启动 Windows 远端组件。请检查远端执行权限和已安装的组件。",
        ),
    ] {
        if stderr.lines().any(|line| line.trim() == reason) {
            return AppError::new(reason, message);
        }
    }
    match code {
        Some(code) => AppError::new(
            "ssh_failed",
            format!("SSH 连接未完成（退出码 {code}）。请检查主机、认证与网络。"),
        ),
        None => AppError::new("ssh_failed", "SSH 连接被信号中止，未完成。"),
    }
}

async fn probe_target(context: &Context<'_>, target: &SshTarget) -> Result<Probe> {
    probe_target_with_host_key(context, target, false).await
}

async fn probe_target_with_host_key(
    context: &Context<'_>,
    target: &SshTarget,
    capture_host_key: bool,
) -> Result<Probe> {
    let snapshot = context.snapshot(target).await?;
    // PowerShell 的调用只含 ASCII 参数。在 POSIX shell 中找不到它时再发 POSIX
    // 探测。避免让 Windows 默认的 cmd.exe 解释 Unix 的重定向和管道。
    let mut shell = transport::Shell::Windows;
    let (mut stdout, mut stderr, mut status, mut host_identity) =
        run_probe(context, target, &snapshot, shell, capture_host_key).await?;
    if status.code() == Some(127) {
        shell = transport::Shell::Posix;
        (stdout, stderr, status, host_identity) =
            run_probe(context, target, &snapshot, shell, capture_host_key).await?;
    }
    if !status.success() {
        return Err(ssh_error(&stderr, status.code()));
    }
    let fields = transport::ProbeFields::parse(&stdout)?;
    let (revision, identity) = peer_revision(&snapshot.revision, &transport::host_keys(&stderr))?;
    let agent = fields.agent.as_ref();
    let compatible = agent.is_some_and(|value| {
        value["protocol"].as_u64() == Some(2)
            && artifact::normalize(
                value["os"].as_str().unwrap_or_default(),
                value["arch"].as_str().unwrap_or_default(),
            )
            .is_some_and(|pair| {
                artifact::normalize(&fields.system, &fields.architecture)
                    .is_some_and(|probed| probed == pair)
            })
    });
    Ok(Probe {
        target_id: target.id.clone(),
        display_name: target.display_name.clone(),
        effective_host: snapshot.hostname.clone(),
        config_revision: snapshot.revision.clone(),
        peer_revision: revision,
        peer_identity: identity,
        host_identity,
        system: fields.system,
        architecture: fields.architecture,
        git: fields.git,
        agent_installed: fields.digest.is_some(),
        agent_version: agent
            .and_then(|value| value["version"].as_str())
            .map(str::to_string),
        agent_digest: fields.digest,
        agent_compatible: compatible,
        agent_probe: agent.cloned(),
        shell,
        hops: snapshot
            .hops
            .iter()
            .map(|hop| format!("{}@{}:{}", hop.user, hop.hostname, hop.port))
            .collect(),
    })
}

async fn run_probe(
    context: &Context<'_>,
    target: &SshTarget,
    snapshot: &Snapshot,
    shell: transport::Shell,
    capture_host_key: bool,
) -> Result<(String, String, ExitStatus, Option<String>)> {
    let folder = Context::private_dir()?;
    let mut command = context.build(target, snapshot, folder.path(), &shell.probe(), true, capture_host_key)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ScopedChild::spawn(&mut command).map_err(|_| ssh_unavailable())?;
    let stdout = child.take_stdout().ok_or_else(ssh_failed)?;
    let stderr = child.take_stderr().ok_or_else(ssh_failed)?;
    let joined = async {
        let stdout = read_bounded(stdout, DIAGNOSTIC_BYTES);
        let stderr = read_bounded(stderr, DIAGNOSTIC_BYTES);
        let wait = async { child.wait().await.map_err(|_| ssh_failed()) };
        let (stdout, stderr, status) = tokio::try_join!(stdout, stderr, wait)?;
        Ok::<_, AppError>((stdout, stderr, status))
    };
    let (stdout, stderr, status) = tokio::time::timeout(PROBE_TIMEOUT, joined)
        .await
        .map_err(|_| timed_out("探测"))??;
    Ok((stdout_text(&stdout), stdout_text(&stderr), status, captured_host_identity(folder.path())))
}

/// 同一个 SSH 子进程的登录确认和数据通道。发送继续字节后仍持有这组管道。
pub(crate) struct AgentConnection {
    pub(crate) child: ScopedChild,
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: ChildStdout,
    pub(crate) stderr: ChildStderr,
    pub(crate) folder: tempfile::TempDir,
}

async fn spawn_connection(
    context: &Context<'_>,
    target: &SshTarget,
    remote: &str,
    expected_peer_revision: Option<&str>,
    expected_host_identity: Option<&str>,
) -> Result<AgentConnection> {
    let snapshot = context.snapshot(target).await?;
    let folder = Context::private_dir()?;
    let mut command = context.build(
        target,
        &snapshot,
        folder.path(),
        remote,
        expected_peer_revision.is_some(),
        expected_host_identity.is_some(),
    )?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ScopedChild::spawn(&mut command).map_err(|_| ssh_unavailable())?;
    let mut stdin = child.take_stdin().ok_or_else(ssh_failed)?;
    let mut stdout = child.take_stdout().ok_or_else(ssh_failed)?;
    let mut stderr = child.take_stderr().ok_or_else(ssh_failed)?;
    if let Some(expected) = expected_peer_revision {
        let verify = async {
            let verify_stderr = check_connection_peer(&mut stderr, &snapshot, remote, expected);
            let wait_ready = async {
                let mut ready = [0u8; transport::READY.len()];
                stdout
                    .read_exact(&mut ready)
                    .await
                    .map_err(|_| ssh_failed())?;
                if ready != transport::READY {
                    return Err(AppError::new(
                        "remote_protocol",
                        "远端未返回预期的 SSH 握手。",
                    ));
                }
                Ok(())
            };
            // 身份校验和握手并行排空，以免带跳板的 SSH 诊断阻塞标准输出。
            let (verified, ready) = tokio::join!(verify_stderr, wait_ready);
            verified?;
            ready?;
            if let Some(expected_identity) = expected_host_identity {
                if captured_host_identity(folder.path()).as_deref() != Some(expected_identity) {
                    return Err(changed());
                }
            }
            stdin
                .write_all(transport::CONTINUE)
                .await
                .map_err(|_| ssh_failed())
        };
        tokio::time::timeout(PROBE_TIMEOUT, verify)
            .await
            .map_err(|_| timed_out("身份校验"))??;
    }
    Ok(AgentConnection {
        child,
        stdin,
        stdout,
        stderr,
        folder,
    })
}

async fn check_connection_peer(
    stderr: &mut ChildStderr,
    snapshot: &Snapshot,
    remote: &str,
    expected: &str,
) -> Result<()> {
    // OpenSSH 会转义反斜杠并截断命令日志。匹配固定命令开头未转义的 ASCII。
    let prefix = remote.split('\\').next().unwrap_or_default();
    let sending = format!("debug1: Sending command: {}", &prefix[..prefix.len().min(96)]);
    let mut log = Vec::new();
    let mut start = 0;
    while (log.len() as u64) < DIAGNOSTIC_BYTES {
        let Ok(byte) = stderr.read_u8().await else {
            return Err(ssh_error(&stdout_text(&log), None));
        };
        log.push(byte);
        if byte == b'\n' {
            let line = String::from_utf8_lossy(&log[start..]);
            if line.starts_with(&sending) {
                let keys = transport::host_keys(&stdout_text(&log));
                let (actual, _) = peer_revision(&snapshot.revision, &keys)?;
                return (actual == expected).then_some(()).ok_or_else(changed);
            }
            start = log.len();
        }
    }
    Err(AppError::new("remote_protocol", "SSH 身份校验输出超过限制。"))
}

/// 传输一次安装：产物按摘要从本机清单取，进度经 Channel 回传前端。
async fn upload(
    context: &Context<'_>,
    target: &SshTarget,
    offer: &InstallOffer,
    probe: &Probe,
    progress: &Channel<InstallProgress>,
) -> Result<()> {
    let bytes = offer_bytes(context, &offer.digest)?;
    let command = probe.shell.install(&offer.digest, true)?;
    let connection = spawn_connection(context, target, &command, Some(&offer.peer_revision), None).await?;
    upload_bytes(connection, &offer.digest, &bytes, &|sent, total| {
        let _ = progress.send(InstallProgress {
            phase: "installing",
            sent_bytes: sent,
            total_bytes: total,
        });
    })
    .await
}

/// 完成连接握手后发送产物字节，进度按已写入字节上报。
async fn upload_bytes(
    connection: AgentConnection,
    digest: &str,
    bytes: &[u8],
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<()> {
    let AgentConnection {
        mut child,
        stdin,
        stdout,
        stderr,
        folder: _folder,
    } = connection;
    let receipt = async {
        let read_out = read_bounded(stdout, DIAGNOSTIC_BYTES);
        let read_err = read_bounded(stderr, DIAGNOSTIC_BYTES);
        let wait = async { child.wait().await.map_err(|_| ssh_failed()) };
        let (stdout, stderr, status) = tokio::try_join!(read_out, read_err, wait)?;
        verify_install_receipt(&stdout, &stderr, status, digest)
    };
    upload::transfer(stdin, bytes, progress, receipt).await
}

fn verify_install_receipt(stdout: &[u8], stderr: &[u8], status: ExitStatus, digest: &str) -> Result<()> {
    let stderr = stdout_text(stderr);
    if !status.success() {
        return Err(ssh_error(
            &format!("{stderr}\n{}", stdout_text(stdout)),
            status.code(),
        ));
    }
    let receipt: Value = serde_json::from_slice(stdout).map_err(|_| {
        AppError::new(
            "remote_protocol",
            "远端安装没有返回可核实的回执，请重新安装。",
        )
    })?;
    if receipt["installed"].as_bool() != Some(true)
        || receipt["agentSha256"].as_str() != Some(digest)
    {
        return Err(AppError::new(
            "remote_protocol",
            "远端安装回执与预期摘要不一致，请重新安装。",
        ));
    }
    Ok(())
}

fn offer_bytes(context: &Context<'_>, digest: &str) -> Result<Vec<u8>> {
    if digest.len() != 64 {
        return Err(invalid_request());
    }
    let manifest = artifact::load_manifest(&context.artifacts)?;
    let entry = manifest
        .artifacts
        .iter()
        .find(|entry| entry.sha256.eq_ignore_ascii_case(digest))
        .ok_or_else(|| {
            AppError::new(
                "agent_artifact_unavailable",
                "发行包内没有与该摘要匹配的远端组件，未安装。",
            )
        })?;
    artifact::select(&context.artifacts, &entry.system, &entry.architecture)
        .map(|artifact| artifact.bytes)
}

#[cfg(test)]
mod live;
#[cfg(all(test, unix))]
mod tests;

#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_settings(
    backend: BackendState<'_>,
    state: Managed<'_>,
) -> Result<Settings> {
    let context = Context::new(&backend.store, &state);
    let targets = context.store.remote_ssh_targets();
    let passwords: Vec<bool> = targets
        .iter()
        .map(|target| context.has_password(&target.id))
        .collect();
    Ok(Settings {
        enabled: context.store.remote_ssh_enabled(),
        targets: targets
            .iter()
            .zip(passwords)
            .map(|(target, has_password)| TargetView::of(target, has_password))
            .collect(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_remote_ssh_enabled(backend: BackendState<'_>, enabled: bool) -> Result<()> {
    // 只写开关：不删除主机、不删除密码，也不动进行中的会话。
    backend.store.set_remote_ssh_enabled(enabled)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_save_target(
    backend: BackendState<'_>,
    state: Managed<'_>,
    target: SshTarget,
) -> Result<TargetView> {
    // 界面不提供修订；由存储按连接身份变化推进，避免前端改写修订。
    let mut target = target;
    target.revision = 0;
    let saved = backend.store.save_remote_ssh_target(target)?;
    let context = Context::new(&backend.store, &state);
    Ok(TargetView::of(&saved, context.has_password(&saved.id)))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_delete_target(
    backend: BackendState<'_>,
    state: Managed<'_>,
    target_id: String,
) -> Result<()> {
    let context = Context::new(&backend.store, &state);
    if backend.store.delete_remote_ssh_target(&target_id)? {
        // 主机记录删了，密码条目也不该留下；失败时如实报错，而不是静默忽略。
        context
            .credentials
            .delete(&target_id)
            .map_err(|failure| failure.into_error())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_set_password(
    backend: BackendState<'_>,
    state: Managed<'_>,
    target_id: String,
    password: String,
) -> Result<()> {
    validate_ssh_password(&password)?;
    let context = Context::new(&backend.store, &state);
    if context.store.remote_ssh_target(&target_id).is_none() {
        return Err(target_missing());
    }
    context
        .credentials
        .save(&target_id, &password)
        .map_err(|failure| failure.into_error())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_delete_password(
    backend: BackendState<'_>,
    state: Managed<'_>,
    target_id: String,
) -> Result<()> {
    let context = Context::new(&backend.store, &state);
    context
        .credentials
        .delete(&target_id)
        .map_err(|failure| failure.into_error())
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

/// 可取消的连接测试：探测只读，取消后不会留下任何远端改动。
#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_test(
    state: Managed<'_>,
    backend: BackendState<'_>,
    request_id: String,
    target_id: String,
) -> Result<Probe> {
    if !uuid(&request_id) {
        return Err(invalid_request());
    }
    let ssh = Arc::clone(state.inner());
    let backend = Arc::clone(backend.inner());
    let key = request_id.clone();
    let join = tokio::spawn(async move {
        let context = Context::new(&backend.store, &ssh);
        let target = context.resolve_target(&target_id)?;
        probe_target(&context, &target).await
    });
    state.register(&key, join.abort_handle())?;
    let result = join.await;
    if !state.release(&key) {
        return Err(AppError::new("remote_cancelled", "连接测试已取消。"));
    }
    result.map_err(|_| AppError::new("remote_cancelled", "连接测试已取消。"))?
}

#[tauri::command(rename_all = "camelCase")]
pub fn remote_ssh_cancel(state: Managed<'_>, request_id: String) {
    if let Some(abort) = state
        .running
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&request_id)
    {
        abort.abort();
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    request_id: String,
    target_id: String,
    /// 探测得到的对端修订：信任、路由或认证变化后必须重新确认。
    peer_revision: String,
    /// 第一次调用不带它：只返回待确认的安装信息，不传输任何字节。
    confirmation_id: Option<String>,
}

/// 安装远端组件：先探测目标，再按 system/architecture 选签名产物。
/// 已安装且能握手的组件直接复用（不重复传输）；否则必须显式确认后原子替换。
#[tauri::command(rename_all = "camelCase")]
pub async fn remote_ssh_install_agent(
    state: Managed<'_>,
    backend: BackendState<'_>,
    request: InstallRequest,
    on_progress: Channel<InstallProgress>,
) -> Result<Value> {
    if !uuid(&request.request_id) || request.peer_revision.len() != 64 {
        return Err(invalid_request());
    }
    let ssh = Arc::clone(state.inner());
    let backend = Arc::clone(backend.inner());
    let key = request.request_id.clone();
    let join = tokio::spawn(async move {
        let context = Context::new(&backend.store, &ssh);
        let target = context.resolve_target(&request.target_id)?;
        let probe = probe_target(&context, &target).await?;
        if probe.peer_revision != request.peer_revision {
            return Err(changed());
        }
        let artifact = artifact::select(&context.artifacts, &probe.system, &probe.architecture)?;
        if probe.agent_compatible && probe.agent_digest.as_deref() == Some(&artifact.sha256) {
            // 只有与本机发行包相同且能握手的组件才复用。
            return Ok(json!({
                "kind": "reused",
                "version": probe.agent_version,
                "sha256": probe.agent_digest,
                "system": probe.system,
                "architecture": probe.architecture,
            }));
        }
        let offer = InstallOffer {
            target_id: target.id.clone(),
            peer_revision: probe.peer_revision.clone(),
            digest: artifact.sha256.clone(),
            version: artifact.version.clone(),
        };
        let confirmed = match request.confirmation_id.as_deref() {
            None => None,
            Some(id) => ssh
                .offers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(id),
        };
        let Some(confirmed) = confirmed else {
            if request.confirmation_id.is_some() {
                return Err(changed());
            }
            let id = Uuid::new_v4().to_string();
            {
                let mut offers = ssh
                    .offers
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                // 界面同时只有一个待确认安装；保留一个小集合以容忍重放。
                if offers.len() >= 8 {
                    offers.clear();
                }
                offers.insert(id.clone(), offer.clone());
            }
            return Ok(json!({
                "kind": "install_required",
                "confirmationId": id,
                "version": artifact.version,
                "size": artifact.bytes.len(),
                "sha256": artifact.sha256,
                "system": probe.system,
                "architecture": probe.architecture,
            }));
        };
        if confirmed.target_id != offer.target_id
            || confirmed.peer_revision != offer.peer_revision
            || confirmed.digest != offer.digest
        {
            return Err(changed());
        }
        upload(&context, &target, &confirmed, &probe, &on_progress).await?;
        Ok(json!({
            "kind": "installed",
            "version": confirmed.version,
            "sha256": confirmed.digest,
        }))
    });
    state.register(&key, join.abort_handle())?;
    let result = join.await;
    if !state.release(&key) {
        return Err(AppError::new("remote_cancelled", "远端组件安装已取消。"));
    }
    result.map_err(|_| AppError::new("remote_cancelled", "远端组件安装已取消。"))?
}

/* ------------------------------------------------------------------ *
 * 给远端仓库会话（remote_worktree）用的最小接口
 *
 * v2 组件只能经本模块的 SSH 规则拉起：冻结配置、known_hosts 副本、askpass 与主机密钥
 * 校验都在这里，调用方不复制任何一条。这里只暴露「探测 / 选产物 / 开会话 / 装产物」
 * 四件事，不暴露 Context、快照或凭据存储。
 * ------------------------------------------------------------------ */

/// 本机 v2 产物：清单选出的字节、摘要、发布签名与版本。
#[derive(Clone)]
pub(crate) struct AgentArtifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) sha256: String,
    /// 发布签名随产物一起带出；安装脚本只核对摘要，因此这里不做密码学复核。
    #[allow(dead_code)]
    pub(crate) signature: String,
    /// 对 `twiglane-agent-v2 sha256:<digest>\n` 的发布签名，供连接器复核。
    pub(crate) digest_signature: String,
    pub(crate) version: String,
}

impl std::fmt::Debug for AgentArtifact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不打印产物字节：只看摘要、版本与大小就够判断是哪一份。
        f.debug_struct("AgentArtifact")
            .field("sha256", &self.sha256)
            .field("version", &self.version)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

/// 一次 v2 会话的探测结果：只带调用方需要的字段。
pub(crate) struct AgentProbe {
    pub(crate) effective_host: String,
    pub(crate) system: String,
    pub(crate) architecture: String,
    /// 远端已安装 v2 组件的摘要；没有安装时为 None。
    pub(crate) digest: Option<String>,
    /// 远端组件自述（`--probe` 的 JSON）：协议、os/arch 与版本。
    pub(crate) agent: Option<Value>,
    /// 原探测使用的 SSH 配置和实际对端主机密钥。
    pub(crate) peer_revision: String,
    pub(crate) peer_identity: String,
    pub(crate) host_identity: Option<String>,
    shell: transport::Shell,
}

/// 一条已拉起的 v2 会话：传输 + 本次连接的私有目录。
///
/// 目录里是冻结配置、known_hosts 副本与一次性 askpass 脚本，必须活到会话结束，
/// 因此与传输一起持有，不能在使用后提前释放。
#[cfg(test)]
pub(crate) struct AgentSession {
    pub(crate) transport: crate::remote_worktree_transport::AgentTransport,
    _folder: tempfile::TempDir,
}

/// 只在测试里指定 ssh 可执行文件与环境；生产一律走 PATH 上的 ssh。
#[cfg(test)]
impl RemoteSsh {
    pub(crate) fn with_exec(
        artifacts: PathBuf,
        program: PathBuf,
        env: Vec<(String, String)>,
    ) -> Self {
        Self {
            artifacts,
            exec: SshExec { program, env },
            running: Mutex::new(HashMap::new()),
            offers: Mutex::new(HashMap::new()),
        }
    }
}

impl RemoteSsh {
    /// 本机 v2 产物目录（发行包资源目录或环境变量指定的开发目录）。
    pub(crate) fn artifacts(&self) -> PathBuf {
        self.artifacts.clone()
    }
}

/// 目标平台规范化：远端探测的 system/architecture 与产物命名对齐。
pub(crate) fn platform(system: &str, architecture: &str) -> Option<(String, String)> {
    artifact::normalize(system, architecture)
}

/// 清单是否可读：决定「本机有没有 v2 产物」，读不到就当作没有。
pub(crate) fn manifest_ready(dir: &Path) -> Result<()> {
    artifact::load_manifest(dir).map(|_| ())
}

/// 按远端 system/architecture 选产物；没有匹配项时明确失败，调用方不得开始上传。
pub(crate) fn select_agent(dir: &Path, system: &str, architecture: &str) -> Result<AgentArtifact> {
    let selected = artifact::select(dir, system, architecture)?;
    Ok(AgentArtifact {
        bytes: selected.bytes,
        sha256: selected.sha256,
        signature: selected.signature,
        digest_signature: selected.digest_signature,
        version: selected.version,
    })
}

/// 探测远端：系统/架构、已安装 v2 组件摘要与自述。只读，不写任何文件。
pub(crate) async fn probe_agent(
    store: &AppStore,
    ssh: &RemoteSsh,
    target: &SshTarget,
) -> Result<AgentProbe> {
    let context = Context::new(store, ssh);
    let probe = probe_target_with_host_key(&context, target, true).await?;
    Ok(AgentProbe {
        effective_host: probe.effective_host,
        system: probe.system,
        architecture: probe.architecture,
        digest: probe.agent_digest,
        agent: probe.agent_probe,
        peer_revision: probe.peer_revision,
        peer_identity: probe.peer_identity,
        host_identity: probe.host_identity,
        shell: probe.shell,
    })
}

/// 拉起 v2 会话：命令串先核对远端已安装组件的摘要，标准输入输出此后专属于 agent 协议。
#[cfg(test)]
pub(crate) async fn open_session(
    store: &AppStore,
    ssh: &RemoteSsh,
    target: &SshTarget,
    digest: &str,
) -> Result<AgentSession> {
    let context = Context::new(store, ssh);
    let probe = probe_target(&context, target).await?;
    let snapshot = context.snapshot(target).await?;
    let folder = Context::private_dir()?;
    let mut command = context.build(
        target,
        &snapshot,
        folder.path(),
        &probe.shell.connect(digest, false)?,
        false,
        false,
    )?;
    let transport = crate::remote_worktree_transport::AgentTransport::spawn_v2(&mut command)
        .map_err(|_| ssh_unavailable())?;
    Ok(AgentSession {
        transport,
        _folder: folder,
    })
}

/// 预备通过原探测验证的同一 SSH 连接，供仓库协议接管三条标准管道。
pub(crate) async fn prepare_session(
    store: &AppStore,
    ssh: &RemoteSsh,
    target: &SshTarget,
    digest: &str,
    probe: &AgentProbe,
) -> Result<AgentConnection> {
    let context = Context::new(store, ssh);
    let command = probe.shell.connect(digest, true)?;
    spawn_connection(&context, target, &command, Some(&probe.peer_revision), probe.host_identity.as_deref()).await
}

/// 保留用户确认时的探测，传输产物前验证同一个 SSH 连接。
pub(crate) async fn install_verified_artifact(
    store: &AppStore,
    ssh: &RemoteSsh,
    target: &SshTarget,
    artifact: &AgentArtifact,
    probe: &AgentProbe,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<()> {
    let context = Context::new(store, ssh);
    let command = probe.shell.install(&artifact.sha256, true)?;
    let connection = spawn_connection(&context, target, &command, Some(&probe.peer_revision), probe.host_identity.as_deref()).await?;
    upload_bytes(connection, &artifact.sha256, &artifact.bytes, progress).await
}

/// 安装 v2 产物：上传后由远端脚本核对摘要并原子替换，进度按已写入字节回传。
#[cfg(test)]
pub(crate) async fn install_artifact(
    store: &AppStore,
    ssh: &RemoteSsh,
    target: &SshTarget,
    artifact: &AgentArtifact,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<()> {
    let context = Context::new(store, ssh);
    let probe = probe_target(&context, target).await?;
    let command = probe.shell.install(&artifact.sha256, false)?;
    let connection = spawn_connection(&context, target, &command, None, None).await?;
    upload_bytes(connection, &artifact.sha256, &artifact.bytes, progress).await
}
