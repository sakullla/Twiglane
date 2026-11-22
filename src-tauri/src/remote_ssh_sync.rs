//! 双向跳转的一次性本机同步会话（host-sync v1，R4/R7）。
//!
//! 两个应用各有一个 headless helper（本进程的 "--host-sync-v1" 入口），只在用户
//! 显式发起双向跳转时为**当前一台主机**创建短时、单用途的同步会话：
//!
//! - deep link 只带 sessionRef（32 字节十六进制），不带配置、不带密码。
//! - check 只回答规范非秘密配置指纹与一次性挑战的密码相等证明；接收方用自己本机
//!   保存的密码算出同一证明再比较，因此明文密码永不进入 check。
//! - 只有配置不同、密码缺失或不同才 fetch；密码只经本次私有 stdin/stdout 管道返回
//!   并立即写入接收方凭据库，私钥始终只传路径。
//! - 会话绑定 hostId、begin 时的配置指纹与修订，TTL 120 秒，settle 后立即失效；
//!   check/fetch 次数都有上限，不能当作长期读取主机簿或密码的能力。
//! - 同步不发起任何 SSH 连接，因此不受总开关与逐台启停影响；enabled 也不进指纹，
//!   启用与信任确认始终由接收方在跳转流程里显式完成。
//! - 除当前记录及关联元数据外，同步不会创建、更新或删除其他主机。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::change_request::CredentialStore;
use crate::error::AppError;
use crate::git::ops::Backend;
use crate::state::{AppStore, SshTarget};

/// helper 入口参数；版本身份写在参数上，两个应用共用同一个协议名。
pub(crate) const FLAG: &str = "--host-sync-v1";
const PROTOCOL: u64 = 1;
const KIND: &str = "host-sync-v1";
/// 会话有效期。超时后 helper 直接删除会话文件，任何调用都只会拿到 session_expired。
const TTL_SECONDS: u64 = 120;
/// 一次会话允许的读取次数：check 幂等可重放，fetch 允许一次部分失败后的重试。
const MAX_CHECKS: u32 = 8;
const MAX_FETCHES: u32 = 2;
/// 会话目录上限：超出时先清理过期会话，仍超限则拒绝新建。
const MAX_SESSIONS: usize = 16;
const MAX_FIELD: usize = 4096;
/// stdin 上的一行参数上限：只放标识与一次性挑战，远小于会话文件。
const MAX_REQUEST_LINE: usize = 8192;
/// 一次性确认票据的有效期。用户确认的是「这一次跳转」，不是长期读取权。
const CONFIRM_TTL_SECONDS: u64 = 120;

type Result<T> = std::result::Result<T, AppError>;

fn error(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}

fn invalid() -> AppError {
    error(
        "host_sync_request",
        "同步请求无效，本次没有读取或写入任何主机。",
    )
}

fn expired() -> AppError {
    error(
        "session_expired",
        "同步会话已失效（一次性或已超时）。请从来源应用重新发起跳转。",
    )
}

/// 非秘密的同步配置。enabled 不属于同步内容：启用由接收方自己决定。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostConfig {
    pub display_name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
}

impl HostConfig {
    fn of(target: &SshTarget) -> Self {
        Self {
            display_name: target.display_name.clone(),
            host: target.host.clone(),
            port: target.port,
            user: target.user.clone(),
            auth_method: target.auth_method.clone(),
            identity_file: target.identity_file.clone(),
            ssh_config: target.ssh_config.clone(),
            default_path: target.default_path.clone(),
        }
    }

    /// 规范指纹：字段顺序固定，None 与空串可区分。enabled 与修订不在其中。
    fn fingerprint(&self) -> String {
        let canonical = format!(
            "host-sync-config-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.display_name,
            self.host,
            self.port,
            self.user,
            self.auth_method,
            self.identity_file.as_deref().unwrap_or("-none"),
            self.ssh_config.as_deref().unwrap_or("-none"),
            self.default_path.as_deref().unwrap_or("-none"),
        );
        let mut digest = Sha256::new();
        digest.update(canonical.as_bytes());
        format!("{:x}", digest.finalize())
    }

    fn valid(&self) -> bool {
        !self.display_name.trim().is_empty()
            && self.display_name.len() <= 64
            && !self.display_name.chars().any(char::is_control)
            && !self.host.trim().is_empty()
            && !self.user.trim().is_empty()
            && self.port > 0
            && matches!(self.auth_method.as_str(), "key" | "password" | "agent")
            && [&self.identity_file, &self.ssh_config, &self.default_path]
                .into_iter()
                .flatten()
                .map(String::as_str)
                .all(|path| !path.is_empty() && path.len() <= MAX_FIELD)
    }
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// HMAC-SHA256。只用工作区已有的 sha2，避免为同步新增依赖。
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    let mut output = [0u8; 32];
    output.copy_from_slice(&outer.finalize());
    output
}

/// 密码相等证明：双方用同一会话引用、同一次挑战和各自的密码算出同一摘要。
/// 证明里不含密码本身，接收方只在本地比较，明文密码不进入 check。
pub(crate) fn proof(password: &str, session_ref: &str, challenge: &str) -> String {
    let message = format!("twiglane-host-sync-v1\n{session_ref}\n{challenge}");
    let digest = hmac_sha256(password.as_bytes(), message.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random_hex() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// 数据目录：与桌面应用同一路径规则，因此 helper 在桌面退出后仍读到同一份设置。
fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("TWIGLANE_HOST_SYNC_DATA_DIR") {
        let dir = PathBuf::from(dir);
        if dir.is_absolute() {
            return Ok(dir);
        }
        return Err(invalid());
    }
    dirs::data_dir()
        .map(|dir| dir.join("app.twiglane.desktop"))
        .ok_or_else(|| error("host_sync_unavailable", "无法定位本机数据目录。"))
}

fn sessions_dir(data: &Path) -> PathBuf {
    data.join("host-sync")
}

fn confirmation_required() -> AppError {
    error(
        "sync_confirmation_required",
        "取回密码需要用户在桌面端确认这一次跳转，本次没有读取或输出任何密码。",
    )
}

/// 一次性确认票据目录：`${XDG_STATE_HOME:-~/.local/state}/twiglane/host-sync`。
/// 票据是「用户刚刚确认过这一次跳转」的事实，与会话状态分开存放。
fn confirmation_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("TWIGLANE_HOST_SYNC_CONFIRM_DIR") {
        let dir = PathBuf::from(dir);
        if dir.is_absolute() {
            return Ok(dir);
        }
        return Err(invalid());
    }
    if let Some(state) = std::env::var_os("XDG_STATE_HOME") {
        let state = PathBuf::from(state);
        if state.is_absolute() {
            return Ok(state.join("twiglane").join("host-sync"));
        }
        return Err(invalid());
    }
    dirs::home_dir()
        .map(|home| {
            home.join(".local")
                .join("state")
                .join("twiglane")
                .join("host-sync")
        })
        .ok_or_else(|| error("host_sync_unavailable", "无法定位本机状态目录。"))
}

/// 一次用户确认的凭据：只绑本机主机身份、关联 id 与 120 秒有效期，不含任何密码。
/// 桌面 UI 在用户确认跳转时写入，helper 只校验并立即消费。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirmation {
    protocol: u64,
    host_id: String,
    #[serde(default)]
    shared_host_id: Option<String>,
    created_at: u64,
    expires_at: u64,
}

fn prepare_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| error("host_sync_unavailable", "无法创建同步会话目录。"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| error("host_sync_unavailable", "无法写入同步会话。"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| error("host_sync_unavailable", "无法写入同步会话。"))
}

/// 一个同步会话。只保存非秘密事实：主机 id、begin 时的配置、关联 id 与计数。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    protocol: u64,
    session_ref: String,
    host_id: String,
    host_config: HostConfig,
    config_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_host_id: Option<String>,
    created_at: u64,
    expires_at: u64,
    checks: u32,
    fetches: u32,
}

impl Session {
    fn alive(&self, reference: &str) -> bool {
        self.protocol == PROTOCOL && self.session_ref == reference && now() < self.expires_at
    }
}

/// 来源侧：读本机主机簿与钥匙串，回答 check/fetch，并负责会话生命周期。
struct Source<'a> {
    store: &'a AppStore,
    secrets: &'a dyn CredentialStore,
    dir: PathBuf,
    /// 票据目录缺省按 XDG 状态目录解析；测试显式指定，避免读写真实用户目录。
    confirm: Option<PathBuf>,
}

impl<'a> Source<'a> {
    fn new(store: &'a AppStore, secrets: &'a dyn CredentialStore, dir: PathBuf) -> Self {
        Self {
            store,
            secrets,
            dir,
            confirm: None,
        }
    }

    /// 只用于测试指定票据目录；T6 接线时桌面侧写票据可复用同一解析规则。
    #[cfg_attr(not(test), allow(dead_code))]
    fn with_confirm_dir(mut self, dir: PathBuf) -> Self {
        self.confirm = Some(dir);
        self
    }

    fn path(&self, reference: &str) -> PathBuf {
        self.dir.join(format!("{reference}.json"))
    }

    fn prune(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let session = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Session>(&raw).ok());
            if session.is_none_or(|session| now() >= session.expires_at) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    fn session_count(&self) -> usize {
        fs::read_dir(&self.dir)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0)
    }

    fn load(&self, reference: &str) -> Result<Session> {
        if !hex64(reference) {
            return Err(invalid());
        }
        let path = self.path(reference);
        let raw = fs::read_to_string(&path).map_err(|_| expired())?;
        let session: Session = serde_json::from_str(&raw).map_err(|_| expired())?;
        if !session.alive(reference) {
            let _ = fs::remove_file(&path);
            return Err(expired());
        }
        Ok(session)
    }

    fn confirm_path(&self, reference: &str) -> Result<PathBuf> {
        let dir = match &self.confirm {
            Some(dir) => dir.clone(),
            None => confirmation_dir()?,
        };
        Ok(dir.join(format!("{reference}.confirm")))
    }

    /// 校验并消费一次性确认票据。校验失败时不读密码、也不输出明文；
    /// 校验通过后先删票据再读密码，票据不能被重放。
    fn consume_confirmation(&self, session: &Session) -> Result<()> {
        let path = self.confirm_path(&session.session_ref)?;
        let load = || -> Result<Confirmation> {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&path)
                    .map_err(|_| confirmation_required())?
                    .permissions()
                    .mode();
                // 票据必须是私有的：别人能写能读的票据等于没有确认。
                if mode & 0o777 != 0o600 {
                    return Err(confirmation_required());
                }
            }
            let raw = fs::read_to_string(&path).map_err(|_| confirmation_required())?;
            serde_json::from_str::<Confirmation>(&raw).map_err(|_| confirmation_required())
        };
        let loaded = load();
        if loaded.is_err() {
            // 不识别的票据同样删掉：它不能被重放，也没有留在磁盘上的理由。
            let _ = fs::remove_file(&path);
        }
        let ticket = loaded?;
        let valid = ticket.protocol == PROTOCOL
            && ticket.host_id == session.host_id
            && ticket.shared_host_id == session.shared_host_id
            && ticket.created_at <= now()
            && ticket.expires_at > now()
            && ticket
                .expires_at
                .saturating_sub(ticket.created_at)
                <= CONFIRM_TTL_SECONDS;
        // 无论是否通过都先删除：票据只对一次取回有效，也不该留在磁盘上。
        let _ = fs::remove_file(&path);
        if !valid {
            return Err(confirmation_required());
        }
        Ok(())
    }

    fn store_session(&self, session: &Session) -> Result<()> {
        prepare_dir(&self.dir)?;
        let raw = serde_json::to_vec(session).map_err(|_| invalid())?;
        write_private(&self.path(&session.session_ref), &raw)
    }

    /// 会话创建时冻结当前主机；随后主机被改动（指纹或修订不同）就作废，
    /// 避免把过期配置当成当前事实写进另一个应用。
    fn current(&self, session: &Session) -> Result<SshTarget> {
        let target = self
            .store
            .remote_ssh_target(&session.host_id)
            .ok_or_else(|| {
                error(
                    "target_unavailable",
                    "这台主机已不在本机主机簿中，本次同步没有继续。",
                )
            })?;
        if target.revision != session.config_revision
            || HostConfig::of(&target).fingerprint() != session.host_config.fingerprint()
        {
            let _ = fs::remove_file(self.path(&session.session_ref));
            return Err(error(
                "session_stale",
                "来源主机在本次同步期间被修改，会话已作废。请重新发起跳转。",
            ));
        }
        Ok(target)
    }

    /// 新建会话。sharedHostId 缺省时补一个并写回本机记录：关联身份不随每次跳转改变，
    /// 仅改关联元数据不推进配置修订。
    fn begin(&self, host_id: &str) -> Result<Value> {
        if host_id.trim().is_empty() || host_id.len() > 64 {
            return Err(invalid());
        }
        let mut target = self.store.remote_ssh_target(host_id).ok_or_else(|| {
            error("target_unavailable", "主机簿里没有这台主机，未创建同步会话。")
        })?;
        if target.shared_host_id.is_none() {
            let mut updated = target.clone();
            updated.shared_host_id = Some(Uuid::new_v4().to_string());
            target = self.store.save_remote_ssh_target(updated)?;
        }
        self.prune();
        prepare_dir(&self.dir)?;
        if self.session_count() >= MAX_SESSIONS {
            return Err(error(
                "host_sync_busy",
                "同时在进行的同步会话过多，请稍后重试。",
            ));
        }
        let created = now();
        let session = Session {
            protocol: PROTOCOL,
            session_ref: random_hex(),
            host_id: target.id.clone(),
            host_config: HostConfig::of(&target),
            config_revision: target.revision,
            shared_host_id: target.shared_host_id.clone(),
            created_at: created,
            expires_at: created + TTL_SECONDS,
            checks: 0,
            fetches: 0,
        };
        self.store_session(&session)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "source",
            "sessionRef": session.session_ref,
            "hostId": session.host_id,
            "sharedHostId": session.shared_host_id,
            "configFingerprint": session.host_config.fingerprint(),
            "configRevision": session.config_revision,
            "expiresAt": session.expires_at,
            "ttlSeconds": TTL_SECONDS,
        }))
    }

    /// check 只回事实：指纹、修订、关联 id、密码状态与一次性挑战的相等证明。
    fn check(&self, reference: &str, challenge: &str) -> Result<Value> {
        if !hex64(challenge) {
            return Err(invalid());
        }
        let mut session = self.load(reference)?;
        if session.checks >= MAX_CHECKS {
            let _ = fs::remove_file(self.path(reference));
            return Err(expired());
        }
        self.current(&session)?;
        let secret = self.secrets.load(&session.host_id);
        let (state, proof_value) = match secret {
            Ok(Some(password)) if !password.is_empty() => {
                ("available", Some(proof(&password, reference, challenge)))
            }
            Ok(_) => ("absent", None),
            // 读不到秘密必须报 unavailable：不能按「一致」跳过，也不能当成「没有密码」。
            Err(_) => ("unavailable", None),
        };
        session.checks += 1;
        self.store_session(&session)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "source",
            "hostId": session.host_id,
            "sharedHostId": session.shared_host_id,
            "configFingerprint": session.host_config.fingerprint(),
            "configRevision": session.config_revision,
            "password": { "state": state, "proof": proof_value },
            "expiresAt": session.expires_at,
        }))
    }

    /// fetch 只按接收方真正缺的部分取回；密码只在明确要求时出现在本次私有管道里。
    fn fetch(&self, reference: &str, challenge: &str, scope: &str) -> Result<Value> {
        if !hex64(challenge) || !matches!(scope, "config" | "password" | "all") {
            return Err(invalid());
        }
        let mut session = self.load(reference)?;
        if session.fetches >= MAX_FETCHES {
            let _ = fs::remove_file(self.path(reference));
            return Err(expired());
        }
        self.current(&session)?;
        let want_config = matches!(scope, "config" | "all");
        let want_password = matches!(scope, "password" | "all");
        // 明文密码只在用户为本次会话写过一次性确认票据时才离开本进程；
        // 没有票据就报 sync_confirmation_required，绝不回退成「直接给」。
        if want_password {
            self.consume_confirmation(&session)?;
        }
        let (password, password_state) = if want_password {
            match self.secrets.load(&session.host_id) {
                Ok(Some(secret)) if !secret.is_empty() => (Some(secret), "available"),
                Ok(_) => (None, "absent"),
                Err(_) => (None, "unavailable"),
            }
        } else {
            (None, "not_requested")
        };
        session.fetches += 1;
        self.store_session(&session)?;
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "source",
            "hostId": session.host_id,
            "sharedHostId": session.shared_host_id,
            "configRevision": session.config_revision,
            "configFingerprint": session.host_config.fingerprint(),
            "config": want_config.then(|| session.host_config.clone()),
            "password": password,
            "passwordState": password_state,
        }))
    }

    /// 结算即销毁：会话不能作为后续读取主机簿或密码的入口。
    fn settle(&self, reference: &str) -> Result<Value> {
        if !hex64(reference) {
            return Err(invalid());
        }
        let _ = self.load(reference)?;
        fs::remove_file(self.path(reference)).map_err(|_| expired())?;
        Ok(json!({ "protocol": PROTOCOL, "kind": KIND, "settled": true }))
    }
}

/// 一次 check 的对端事实。
#[derive(Clone, Debug)]
struct PeerCheck {
    fingerprint: String,
    revision: u64,
    shared_host_id: Option<String>,
    password_state: String,
    password_proof: Option<String>,
}

#[derive(Clone, Debug)]
struct PeerFetch {
    config: Option<HostConfig>,
    password: Option<String>,
    password_state: String,
}

/// 对端 helper 的调用面。真实实现是子进程；测试用固定回放替代。
trait Peer {
    fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck>;
    fn fetch(&self, reference: &str, challenge: &str, scope: &str) -> Result<PeerFetch>;
    fn settle(&self, reference: &str) -> Result<()>;
}

/// 通过私有 stdin/stdout 管道驱动来源应用的 headless helper。
struct HelperPeer {
    program: PathBuf,
}

fn first_json_line(bytes: &[u8]) -> Result<Value> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| invalid())?;
    serde_json::from_str(text.lines().next().unwrap_or_default()).map_err(|_| {
        error(
            "host_sync_protocol",
            "来源应用返回了无法解析的同步回执。",
        )
    })
}

impl HelperPeer {
    /// 动作名走 argv，参数只走 stdin 的一行 JSON：会话引用不会被 ps 或进程审计看到。
    fn call(&self, action: &str, params: Value) -> Result<Value> {
        let unavailable = || {
            error(
                "host_sync_unavailable",
                "无法启动来源应用的同步 helper。请确认来源应用已正确安装。",
            )
        };
        let mut child = Command::new(&self.program)
            .arg(FLAG)
            .arg(action)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| unavailable())?;
        {
            let mut stdin = child.stdin.take().ok_or_else(unavailable)?;
            let line = format!("{params}\n");
            let written = stdin.write_all(line.as_bytes());
            // 显式关掉管道再等子进程：对端提前退出时也不会留下僵尸进程。
            drop(stdin);
            if written.is_err() {
                let _ = child.wait();
                return Err(unavailable());
            }
        }
        let output = child.wait_with_output().map_err(|_| unavailable())?;
        if !output.status.success() {
            // 对端只回错误码：不把诊断文本（可能含主机信息）带进本机界面。
            let code = first_json_line(&output.stderr)
                .ok()
                .and_then(|value| value["error"].as_str().map(str::to_string))
                .unwrap_or_else(|| "host_sync_failed".to_string());
            return Err(match code.as_str() {
                "session_expired" | "session_stale" => expired(),
                "target_unavailable" => error(
                    "target_unavailable",
                    "来源应用里这台主机已不可用，本次同步没有继续。",
                ),
                "host_sync_busy" => error("host_sync_busy", "来源应用正忙，请稍后重试。"),
                _ => error("host_sync_failed", "来源应用没有完成本次同步请求。"),
            });
        }
        first_json_line(&output.stdout)
    }
}

impl Peer for HelperPeer {
    fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck> {
        let value = self.call(
            "check",
            json!({ "sessionRef": reference, "challenge": challenge }),
        )?;
        Ok(PeerCheck {
            fingerprint: value["configFingerprint"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            revision: value["configRevision"].as_u64().unwrap_or_default(),
            shared_host_id: value["sharedHostId"].as_str().map(str::to_string),
            password_state: value["password"]["state"]
                .as_str()
                .unwrap_or("unavailable")
                .to_string(),
            password_proof: value["password"]["proof"].as_str().map(str::to_string),
        })
    }

    fn fetch(&self, reference: &str, challenge: &str, scope: &str) -> Result<PeerFetch> {
        let value = self.call(
            "fetch",
            json!({ "sessionRef": reference, "challenge": challenge, "scope": scope }),
        )?;
        let config = value
            .get("config")
            .filter(|config| !config.is_null())
            .map(|config| serde_json::from_value::<HostConfig>(config.clone()))
            .transpose()
            .map_err(|_| invalid())?;
        Ok(PeerFetch {
            config,
            password: value["password"].as_str().map(str::to_string),
            password_state: value["passwordState"]
                .as_str()
                .unwrap_or("absent")
                .to_string(),
        })
    }

    fn settle(&self, reference: &str) -> Result<()> {
        self.call("settle", json!({ "sessionRef": reference }))
            .map(|_| ())
    }
}

/// 一次接收操作的单项回执：配置与密码各自独立，部分失败也能如实交代。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    kind: &'static str,
    state: &'static str,
}

/// 接收方对密码的最终判断。unknown 绝不等于一致。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PasswordState {
    Equal,
    Differs,
    Absent,
    Unknown,
}

impl PasswordState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Equal => "equal",
            Self::Differs => "differs",
            Self::Absent => "absent",
            Self::Unknown => "unknown",
        }
    }
}

fn compare_password(
    local: std::result::Result<Option<String>, crate::change_request::credential::CredentialFailure>,
    checked: &PeerCheck,
    reference: &str,
    challenge: &str,
) -> PasswordState {
    let Ok(local) = local else {
        return PasswordState::Unknown;
    };
    let local = local.filter(|value| !value.is_empty());
    match (local, checked.password_state.as_str()) {
        (_, "unavailable") => PasswordState::Unknown,
        (None, "available") | (Some(_), "absent") => PasswordState::Differs,
        (None, "absent") | (None, _) => PasswordState::Absent,
        (Some(password), "available") => match checked.password_proof.as_deref() {
            Some(remote) if remote == proof(&password, reference, challenge) => PasswordState::Equal,
            Some(_) => PasswordState::Differs,
            None => PasswordState::Unknown,
        },
        _ => PasswordState::Unknown,
    }
}

/// 接收侧：把来源主机与本地记录对齐后按需写入，并给出可核实的回执。
struct Receiver<'a> {
    store: &'a AppStore,
    secrets: &'a dyn CredentialStore,
}

impl<'a> Receiver<'a> {
    fn new(store: &'a AppStore, secrets: &'a dyn CredentialStore) -> Self {
        Self { store, secrets }
    }

    /// 显式解决未关联冲突：只有用户选定后才按 sharedHostId 绑定，覆盖前先核对是否已属于别人。
    fn link(&self, target_id: &str, shared: &str) -> Result<SshTarget> {
        let target = self
            .store
            .remote_ssh_target(target_id)
            .ok_or_else(|| error("target_unavailable", "要关联的本机主机已不存在。"))?;
        if target
            .shared_host_id
            .as_deref()
            .is_some_and(|current| current != shared)
        {
            return Err(error(
                "association_conflict",
                "该主机已关联到另一个共享标识，未覆盖。",
            ));
        }
        let mut updated = target;
        updated.shared_host_id = Some(shared.to_string());
        self.store.save_remote_ssh_target(updated)
    }

    /// 接收一次跳转：check → 决定是否 fetch → 分别回执配置与密码 → 结算会话。
    /// resolve_to 为空表示按 sharedHostId 自动对齐；有未关联候选时返回 association_required。
    fn receive(&self, peer: &dyn Peer, reference: &str, resolve_to: Option<&str>) -> Result<Value> {
        if !hex64(reference) {
            return Err(invalid());
        }
        let challenge = random_hex();
        let checked = peer.check(reference, &challenge)?;
        if !hex64(&checked.fingerprint) || checked.revision == 0 {
            return Err(error(
                "host_sync_protocol",
                "来源应用的同步回执缺少配置指纹或修订。",
            ));
        }
        let targets = self.store.remote_ssh_targets();
        let shared = checked.shared_host_id.clone();
        let local: Option<SshTarget> = match (&shared, resolve_to) {
            (Some(shared_id), Some(chosen)) => Some(self.link(chosen, shared_id)?),
            (Some(shared_id), None) => {
                let matched = targets
                    .iter()
                    .find(|item| item.shared_host_id.as_deref() == Some(shared_id.as_str()))
                    .cloned();
                match matched {
                    Some(target) => Some(target),
                    None => {
                        // 按同地址找本机记录：已属于另一个共享标识的记录说明两端是
                        // 两条不同身份的历史记录，不能因此再复制一份；未关联的同地址
                        // 候选则必须由用户显式解决。两种情况都不按名称或地址自动合并。
                        let source_host = self.pending_host(peer, reference, &challenge)?;
                        let same_address: Vec<&SshTarget> = targets
                            .iter()
                            .filter(|item| item.host.eq_ignore_ascii_case(&source_host))
                            .collect();
                        let conflicts: Vec<Value> = same_address
                            .iter()
                            .filter(|item| item.shared_host_id.is_some())
                            .map(|item| {
                                json!({
                                    "hostId": item.id,
                                    "displayName": item.display_name,
                                    "host": item.host,
                                    "sharedHostId": item.shared_host_id,
                                })
                            })
                            .collect();
                        if !conflicts.is_empty() {
                            return Ok(json!({
                                "protocol": PROTOCOL,
                                "kind": KIND,
                                "role": "receiver",
                                "result": "association_conflict",
                                "sharedHostId": shared_id,
                                "conflicts": conflicts,
                                "receipts": Vec::<Value>::new(),
                                "sessionClosed": false,
                            }));
                        }
                        let candidates: Vec<Value> = same_address
                            .iter()
                            .map(|item| {
                                json!({
                                    "hostId": item.id,
                                    "displayName": item.display_name,
                                    "host": item.host,
                                    "port": item.port,
                                    "user": item.user,
                                })
                            })
                            .collect();
                        if candidates.is_empty() {
                            None
                        } else {
                            return Ok(json!({
                                "protocol": PROTOCOL,
                                "kind": KIND,
                                "role": "receiver",
                                "result": "association_required",
                                "sharedHostId": shared_id,
                                "candidates": candidates,
                                "receipts": Vec::<Value>::new(),
                                "sessionClosed": false,
                            }));
                        }
                    }
                }
            }
            _ => {
                // 来源没有关联标识（更早的来源应用）：只能由用户显式指定本机记录。
                return Ok(json!({
                    "protocol": PROTOCOL,
                    "kind": KIND,
                    "role": "receiver",
                    "result": "association_required",
                    "sharedHostId": Value::Null,
                    "candidates": targets
                        .iter()
                        .filter(|item| item.shared_host_id.is_none())
                        .map(|item| json!({ "hostId": item.id, "displayName": item.display_name }))
                        .collect::<Vec<_>>(),
                    "receipts": Vec::<Value>::new(),
                    "sessionClosed": false,
                }));
            }
        };

        let local_fingerprint = local.as_ref().map(|target| HostConfig::of(target).fingerprint());
        let config_equal = local_fingerprint.as_deref() == Some(checked.fingerprint.as_str());
        let password = compare_password(
            match &local {
                Some(target) => self.secrets.load(&target.id),
                None => Ok(None),
            },
            &checked,
            reference,
            &challenge,
        );
        // 完全一致：不取回配置或秘密、不写记录、不推进修订。
        if config_equal && matches!(password, PasswordState::Equal | PasswordState::Absent) {
            peer.settle(reference)?;
            return Ok(json!({
                "protocol": PROTOCOL,
                "kind": KIND,
                "role": "receiver",
                "result": "consistent",
                "hostId": local.as_ref().map(|target| target.id.clone()),
                "sharedHostId": shared,
                "password": password.as_str(),
                "receipts": [
                    { "kind": "config", "state": "unchanged" },
                    { "kind": "password", "state": "unchanged" },
                ],
                "revision": local.as_ref().map(|target| target.revision),
                "sessionClosed": true,
            }));
        }

        let need_config = !config_equal;
        let need_password = checked.password_state == "available"
            && matches!(password, PasswordState::Differs | PasswordState::Unknown | PasswordState::Absent);
        let scope = match (need_config, need_password) {
            (true, true) => "all",
            (true, false) => "config",
            (false, true) => "password",
            (false, false) => "config",
        };
        let fetched = peer.fetch(reference, &challenge, scope)?;

        // 写入前重新核对双方修订：核对之后发生的接收方修改形成冲突，不静默覆盖。
        // 这一步必须在**任何**写入之前：密码同样会改写记录，不能绕过这次核对。
        let mut receipts: Vec<Receipt> = Vec::new();
        let mut host_id = local.as_ref().map(|target| target.id.clone());
        let mut revision = local.as_ref().map(|target| target.revision);
        let mut config_state = "unchanged";
        if let Some(current) = local
            .as_ref()
            .and_then(|target| self.store.remote_ssh_target(&target.id))
        {
            if Some(current.revision) != local.as_ref().map(|target| target.revision) {
                return Ok(json!({
                    "protocol": PROTOCOL,
                    "kind": KIND,
                    "role": "receiver",
                    "result": "conflict",
                    "hostId": current.id,
                    "sharedHostId": shared,
                    "password": password.as_str(),
                    "receipts": [ Receipt {
                        kind: if need_config { "config" } else { "password" },
                        state: "conflict",
                    } ],
                    "sessionClosed": false,
                }));
            }
        }
        if need_config {
            let Some(config) = fetched.config.clone() else {
                return Err(error(
                    "host_sync_protocol",
                    "来源应用没有返回需要的配置，本次没有写入。",
                ));
            };
            if !config.valid() {
                return Err(error(
                    "host_sync_protocol",
                    "来源应用的配置不合法，本次没有写入。",
                ));
            }
            let target = match &local {
                Some(current) => SshTarget {
                    id: current.id.clone(),
                    display_name: config.display_name.clone(),
                    host: config.host.clone(),
                    port: config.port,
                    user: config.user.clone(),
                    auth_method: config.auth_method.clone(),
                    identity_file: config.identity_file.clone(),
                    ssh_config: config.ssh_config.clone(),
                    default_path: config.default_path.clone(),
                    // 启用不由同步开启：接收方在跳转流程里显式确认。
                    enabled: current.enabled,
                    shared_host_id: shared.clone(),
                    revision: 0,
                },
                None => SshTarget {
                    id: Uuid::new_v4().to_string(),
                    display_name: config.display_name.clone(),
                    host: config.host.clone(),
                    port: config.port,
                    user: config.user.clone(),
                    auth_method: config.auth_method.clone(),
                    identity_file: config.identity_file.clone(),
                    ssh_config: config.ssh_config.clone(),
                    default_path: config.default_path.clone(),
                    enabled: false,
                    shared_host_id: shared.clone(),
                    revision: 0,
                },
            };
            let saved = self.store.save_remote_ssh_target(target)?;
            host_id = Some(saved.id.clone());
            revision = Some(saved.revision);
            config_state = "saved";
        }
        receipts.push(Receipt {
            kind: "config",
            state: config_state,
        });

        // 密码单独回执：失败时保留原密码（不删除、不改写），并标记配置已保存、密码待同步。
        let mut password_state = password;
        if need_password {
            match fetched.password_state.as_str() {
                "available" => match fetched.password.as_deref() {
                    Some(secret) if !secret.is_empty() => {
                        let id = host_id.clone().unwrap_or_default();
                        match self.secrets.save(&id, secret) {
                            Ok(()) => {
                                password_state = PasswordState::Equal;
                                receipts.push(Receipt {
                                    kind: "password",
                                    state: "saved",
                                });
                            }
                            Err(_) => {
                                receipts.push(Receipt {
                                    kind: "password",
                                    state: "failed",
                                });
                            }
                        }
                    }
                    _ => {
                        password_state = PasswordState::Unknown;
                        receipts.push(Receipt {
                            kind: "password",
                            state: "unavailable",
                        });
                    }
                },
                "absent" => {
                    password_state = PasswordState::Absent;
                    receipts.push(Receipt {
                        kind: "password",
                        state: "absent",
                    });
                }
                _ => {
                    password_state = PasswordState::Unknown;
                    receipts.push(Receipt {
                        kind: "password",
                        state: "unavailable",
                    });
                }
            }
        } else {
            receipts.push(Receipt {
                kind: "password",
                state: "unchanged",
            });
        }

        let partial = receipts.iter().any(|receipt| receipt.state == "failed");
        let wrote = receipts.iter().any(|receipt| receipt.state == "saved");
        // 什么都没写且密码状态未知时不能报成功：unknown 必须如实返回，交给用户重试。
        let result = if partial {
            "partial"
        } else if wrote {
            "applied"
        } else if password_state == PasswordState::Unknown {
            "unknown"
        } else {
            "unchanged"
        };
        // 只有真正结算（一致、已应用或不含未知）才销毁会话；partial/unknown 保留原上下文可重试。
        let settled = matches!(result, "applied" | "consistent") && peer.settle(reference).is_ok();
        Ok(json!({
            "protocol": PROTOCOL,
            "kind": KIND,
            "role": "receiver",
            "result": result,
            "hostId": host_id,
            "sharedHostId": shared,
            "password": password_state.as_str(),
            "receipts": receipts,
            "revision": revision,
            "sessionClosed": settled,
        }))
    }

    /// 只有需要判断「是否有未关联候选」时才取一次配置；其余路径不额外取回配置。
    fn pending_host(&self, peer: &dyn Peer, reference: &str, challenge: &str) -> Result<String> {
        let fetched = peer.fetch(reference, challenge, "config")?;
        fetched
            .config
            .map(|config| config.host)
            .ok_or_else(|| error("host_sync_protocol", "来源应用没有返回主机配置。"))
    }
}

/// helper 一次调用的参数。动作名之外的参数都不经 argv，只从 stdin 读。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Params {
    Begin {
        host_id: String,
    },
    Check {
        session_ref: String,
        challenge: String,
    },
    Fetch {
        session_ref: String,
        challenge: String,
        scope: String,
    },
    Settle {
        session_ref: String,
    },
    Receive {
        session_ref: String,
        resolve_to: Option<String>,
    },
}

/// 从 stdin 读一行参数。读不到（EOF）或超长都按无效请求处理。
fn request_line() -> Result<String> {
    use std::io::BufRead;
    let mut line = String::new();
    let read = std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|_| invalid())?;
    if read == 0 || line.len() > MAX_REQUEST_LINE {
        return Err(invalid());
    }
    Ok(line)
}

/// argv 只允许动作名（receive 另加对端程序路径）。
/// 会话引用或主机标识出现在 argv 里一律拒绝，避免被 ps 与进程审计观测。
fn verify_argv(rest: &[String], allowed: usize) -> Result<()> {
    if rest.len() != allowed {
        return Err(error(
            "host_sync_argv_rejected",
            "同步参数必须经 stdin 的 JSON 传入，argv 不接受会话引用或主机标识。",
        ));
    }
    Ok(())
}

/// 一行 JSON 参数：字段名固定，多余或缺失字段都拒绝。
fn json_params(action: &str, line: &str) -> Result<Params> {
    let value: Value = serde_json::from_str(line).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    let allowed: &[&str] = match action {
        "begin" => &["hostId"],
        "check" => &["sessionRef", "challenge"],
        "fetch" => &["sessionRef", "challenge", "scope"],
        "settle" => &["sessionRef"],
        "receive" => &["sessionRef", "resolveTo"],
        _ => return Err(invalid()),
    };
    if object
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(invalid)
    };
    Ok(match action {
        "begin" => Params::Begin {
            host_id: text("hostId")?,
        },
        "check" => Params::Check {
            session_ref: text("sessionRef")?,
            challenge: text("challenge")?,
        },
        "fetch" => Params::Fetch {
            session_ref: text("sessionRef")?,
            challenge: text("challenge")?,
            scope: text("scope")?,
        },
        "settle" => Params::Settle {
            session_ref: text("sessionRef")?,
        },
        _ => Params::Receive {
            session_ref: text("sessionRef")?,
            resolve_to: match object.get("resolveTo") {
                None | Some(Value::Null) => None,
                Some(Value::String(chosen)) => Some(chosen.clone()),
                Some(_) => return Err(invalid()),
            },
        },
    })
}

/// 解析 stdin 上的一行参数：首选一行 JSON，也接受同样的定位纯文本字段。
fn parse_params(action: &str, line: &str) -> Result<Params> {
    let line = line.trim();
    if line.is_empty() || line.len() > MAX_REQUEST_LINE {
        return Err(invalid());
    }
    if line.starts_with('{') {
        return json_params(action, line);
    }
    let fields: Vec<&str> = line.split_whitespace().collect();
    let expected = match action {
        "begin" | "settle" | "receive" => 1,
        "check" => 2,
        "fetch" => 3,
        _ => return Err(invalid()),
    };
    if fields.len() != expected {
        return Err(invalid());
    }
    Ok(match action {
        "begin" => Params::Begin {
            host_id: fields[0].to_string(),
        },
        "check" => Params::Check {
            session_ref: fields[0].to_string(),
            challenge: fields[1].to_string(),
        },
        "fetch" => Params::Fetch {
            session_ref: fields[0].to_string(),
            challenge: fields[1].to_string(),
            scope: fields[2].to_string(),
        },
        "settle" => Params::Settle {
            session_ref: fields[0].to_string(),
        },
        _ => Params::Receive {
            session_ref: fields[0].to_string(),
            resolve_to: None,
        },
    })
}

/// helper 的一次调用：动作名在 argv，参数从 stdin 读，结果一行 JSON 打到 stdout。
pub(crate) fn run(args: &[String]) -> Result<()> {
    let action = args.first().cloned().ok_or_else(invalid)?;
    let rest = &args[1..];
    let store_path = data_dir()?.join("state.json");
    let store = AppStore::open(store_path);
    let secrets = crate::change_request::KeyringStore::remote_ssh();
    let dir = sessions_dir(&data_dir()?);
    let source = Source::new(&store, &secrets, dir);
    let value = match action.as_str() {
        "version" => {
            verify_argv(rest, 0)?;
            json!({
                "protocol": PROTOCOL,
                "kind": KIND,
                "app": "twiglane",
                "capabilities": ["begin", "check", "fetch", "settle", "receive"],
                "ttlSeconds": TTL_SECONDS,
                "confirmation": { "required": "password", "ttlSeconds": CONFIRM_TTL_SECONDS },
            })
        }
        "begin" => {
            verify_argv(rest, 0)?;
            let Params::Begin { host_id } = parse_params("begin", &request_line()?)? else {
                return Err(invalid());
            };
            source.begin(&host_id)?
        }
        "check" => {
            verify_argv(rest, 0)?;
            let Params::Check {
                session_ref,
                challenge,
            } = parse_params("check", &request_line()?)?
            else {
                return Err(invalid());
            };
            source.check(&session_ref, &challenge)?
        }
        "settle" => {
            verify_argv(rest, 0)?;
            let Params::Settle { session_ref } = parse_params("settle", &request_line()?)? else {
                return Err(invalid());
            };
            source.settle(&session_ref)?
        }
        "fetch" => {
            verify_argv(rest, 0)?;
            let Params::Fetch {
                session_ref,
                challenge,
                scope,
            } = parse_params("fetch", &request_line()?)?
            else {
                return Err(invalid());
            };
            source.fetch(&session_ref, &challenge, &scope)?
        }
        "receive" => {
            verify_argv(rest, 1)?;
            let program = PathBuf::from(&rest[0]);
            if !program.is_file() {
                return Err(error(
                    "host_sync_unavailable",
                    "找不到来源应用的同步 helper。",
                ));
            }
            let Params::Receive {
                session_ref,
                resolve_to,
            } = parse_params("receive", &request_line()?)?
            else {
                return Err(invalid());
            };
            let receiver = Receiver::new(&store, &secrets);
            receiver.receive(&HelperPeer { program }, &session_ref, resolve_to.as_deref())?
        }
        _ => return Err(invalid()),
    };
    // 只写一行结构化结果：日志与 URL 里不出现配置或秘密。
    println!("{value}");
    Ok(())
}

/// 在桌面前置流程里分流：以协议参数启动时只当 helper，不初始化 Tauri。
pub(crate) fn helper_entry() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) {
        return false;
    }
    let args: Vec<String> = args.collect();
    if let Err(failure) = run(&args) {
        eprintln!("{}", json!({ "error": failure.code }));
        std::process::exit(2);
    }
    true
}

/// 应用内状态：会话目录由应用数据目录决定，桌面与 helper 指向同一处。
///
/// 应用内 IPC 接收接线延后到 T6：本版本只跑 helper 入口，桌面侧命令与状态暂未被
/// 调用；接线后删掉这些 allow(dead_code)。
#[allow(dead_code)]
pub(crate) struct HostSync {
    dir: PathBuf,
}

impl HostSync {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
}

/// T6 接线时由 `remote_host_sync_begin` 使用；本版本没有 IPC 命令调用它，
/// T6 登记命令与 ACL 后删掉 `allow(dead_code)`。
#[allow(dead_code)]
fn secrets() -> crate::change_request::KeyringStore {
    crate::change_request::KeyringStore::remote_ssh()
}

/// 发起跳转时创建会话：只把 sessionRef 交出去，配置与密码留在本机。
/// T6 才注册到 invoke handler，本版本没有登记命令与 ACL。
#[allow(dead_code)]
#[tauri::command(rename_all = "camelCase")]
pub async fn remote_host_sync_begin(
    backend: tauri::State<'_, std::sync::Arc<Backend>>,
    state: tauri::State<'_, std::sync::Arc<HostSync>>,
    target_id: String,
) -> Result<Value> {
    let store = &backend.store;
    let keyring = secrets();
    let source = Source::new(store, &keyring, state.dir.clone());
    source.begin(&target_id)
}

/// 接收跳转：按 sessionRef 调用来源应用 helper，必要时按需取回并分别回执。
/// T6 才注册到 invoke handler，本版本没有登记命令与 ACL。
#[allow(dead_code)]
#[tauri::command(rename_all = "camelCase")]
pub async fn remote_host_sync_receive(
    backend: tauri::State<'_, std::sync::Arc<Backend>>,
    session_ref: String,
    resolve_to: Option<String>,
) -> Result<Value> {
    let store = &backend.store;
    let program = cliora_helper()?;
    let keyring = secrets();
    let receiver = Receiver::new(store, &keyring);
    receiver.receive(
        &HelperPeer { program },
        &session_ref,
        resolve_to.as_deref(),
    )
}

/// Cliora 的 helper 位置。与 remote_worktree 的定位规则一致，但这里只在同步时使用，
/// 因此独立实现，避免让同步依赖远端仓库的连接器状态机。
/// T6 接线时由 `remote_host_sync_receive` 使用；本版本没有 IPC 命令调用它，
/// T6 登记命令与 ACL 后删掉 `allow(dead_code)`。
#[allow(dead_code)]
fn cliora_helper() -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("TWIGLANE_CLIORA_CONNECTOR") {
        candidates.push(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = "Cliora.app/Contents/MacOS/cliora";
        candidates.push(Path::new("/Applications").join(bundle));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications").join(bundle));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_local_dir() {
            candidates.push(local.join("Cliora").join("cliora.exe"));
            candidates.push(local.join("Programs").join("Cliora").join("cliora.exe"));
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
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            error(
                "cliora_unavailable",
                "找不到 Cliora 的同步 helper，请安装或在设置里指定。",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change_request::credential::CredentialFailure;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeSecrets {
        entries: Mutex<HashMap<String, String>>,
        fail_load: bool,
        fail_save: bool,
    }

    impl FakeSecrets {
        fn with_password(id: &str, password: &str) -> Self {
            let mut entries = HashMap::new();
            entries.insert(id.to_string(), password.to_string());
            Self {
                entries: Mutex::new(entries),
                ..Self::default()
            }
        }

        fn password(&self, id: &str) -> Option<String> {
            self.entries.lock().unwrap().get(id).cloned()
        }
    }

    impl CredentialStore for FakeSecrets {
        fn load(&self, key: &str) -> std::result::Result<Option<String>, CredentialFailure> {
            if self.fail_load {
                return Err(CredentialFailure::Unavailable);
            }
            Ok(self.password(key))
        }

        fn save(&self, key: &str, secret: &str) -> std::result::Result<(), CredentialFailure> {
            if self.fail_save {
                return Err(CredentialFailure::Unavailable);
            }
            self.entries
                .lock()
                .unwrap()
                .insert(key.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, key: &str) -> std::result::Result<(), CredentialFailure> {
            self.entries.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn host(id: &str, name: &str, address: &str) -> SshTarget {
        SshTarget {
            id: id.to_string(),
            display_name: name.to_string(),
            host: address.to_string(),
            port: 22,
            user: "deploy".to_string(),
            auth_method: "password".to_string(),
            identity_file: None,
            ssh_config: None,
            default_path: Some("/srv/app".to_string()),
            enabled: true,
            shared_host_id: None,
            revision: 0,
        }
    }

    fn fixture(id: &str, address: &str) -> (tempfile::TempDir, AppStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(dir.path().join("state.json"));
        store.set_remote_ssh_enabled(true).unwrap();
        store.save_remote_ssh_target(host(id, "prod", address)).unwrap();
        (dir, store)
    }

    struct FakePeer {
        reference: String,
        config: HostConfig,
        shared: Option<String>,
        revision: u64,
        password: Option<String>,
        password_state: &'static str,
        before_fetch: Option<Box<dyn Fn() + Send + Sync>>,
        settled: Mutex<u32>,
    }

    impl FakePeer {
        fn new(reference: &str, config: HostConfig) -> Self {
            Self {
                reference: reference.to_string(),
                config,
                shared: Some("shared-1".to_string()),
                revision: 3,
                password: None,
                password_state: "absent",
                before_fetch: None,
                settled: Mutex::new(0),
            }
        }

        fn with_password(mut self, password: &str) -> Self {
            self.password = Some(password.to_string());
            self.password_state = "available";
            self
        }
    }

    impl Peer for FakePeer {
        fn check(&self, reference: &str, challenge: &str) -> Result<PeerCheck> {
            assert_eq!(reference, self.reference);
            Ok(PeerCheck {
                fingerprint: self.config.fingerprint(),
                revision: self.revision,
                shared_host_id: self.shared.clone(),
                password_state: self.password_state.to_string(),
                password_proof: self
                    .password
                    .as_deref()
                    .map(|password| proof(password, reference, challenge)),
            })
        }

        fn fetch(&self, _reference: &str, _challenge: &str, scope: &str) -> Result<PeerFetch> {
            if let Some(hook) = self.before_fetch.as_ref() {
                hook();
            }
            Ok(PeerFetch {
                config: matches!(scope, "config" | "all").then(|| self.config.clone()),
                password: self
                    .password
                    .clone()
                    .filter(|_| matches!(scope, "password" | "all")),
                password_state: self.password_state.to_string(),
            })
        }

        fn settle(&self, _reference: &str) -> Result<()> {
            *self.settled.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[test]
    fn proof_matches_hmac_sha256_rfc4231_case_two() {
        let digest = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let rendered: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            rendered,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // 相同密码与挑战得到同一证明；换挑战或换密码都必须不同。
        let same = proof("secret", &"a".repeat(64), &"b".repeat(64));
        assert_eq!(same, proof("secret", &"a".repeat(64), &"b".repeat(64)));
        assert_ne!(same, proof("secret", &"a".repeat(64), &"c".repeat(64)));
        assert_ne!(same, proof("other", &"a".repeat(64), &"b".repeat(64)));
        assert_eq!(same.len(), 64);
    }

    #[test]
    fn fingerprint_covers_config_but_not_enabled_or_revision() {
        let base = HostConfig::of(&host("h", "prod", "example.test"));
        let mut renamed = base.clone();
        renamed.display_name = "prod-2".to_string();
        assert_ne!(base.fingerprint(), renamed.fingerprint());
        let mut port = base.clone();
        port.port = 2222;
        assert_ne!(base.fingerprint(), port.fingerprint());
        let mut key = base.clone();
        key.auth_method = "key".to_string();
        assert_ne!(base.fingerprint(), key.fingerprint());
        let with_path = HostConfig {
            identity_file: Some("/Users/me/.ssh/id_ed25519".to_string()),
            ..base.clone()
        };
        assert_ne!(base.fingerprint(), with_path.fingerprint());
        assert_eq!(base.fingerprint().len(), 64);
        // enabled 与修订不在结构里：只改启用不产生配置差异。
        let mut target = host("h", "prod", "example.test");
        let fingerprint = HostConfig::of(&target).fingerprint();
        target.enabled = false;
        assert_eq!(HostConfig::of(&target).fingerprint(), fingerprint);
    }

    #[test]
    fn begin_assigns_a_stable_shared_host_id_and_writes_a_private_session() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let sessions = dir.path().join("host-sync");
        let source = Source::new(&store, &secrets, sessions.clone());
        let value = source.begin("host-a").unwrap();
        let shared = value["sharedHostId"].as_str().unwrap().to_string();
        assert_eq!(value["hostId"], "host-a");
        assert!(hex64(value["sessionRef"].as_str().unwrap()));
        assert_eq!(store.remote_ssh_target("host-a").unwrap().revision, 1, "关联元数据不推进修订");
        // 第二次 begin 沿用同一 sharedHostId，不重掷关联身份。
        let again = source.begin("host-a").unwrap();
        assert_eq!(again["sharedHostId"].as_str().unwrap(), shared);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let entry = fs::read_dir(&sessions)
                .unwrap()
                .flatten()
                .next()
                .unwrap();
            assert_eq!(entry.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        // 会话文件里没有密码。
        for entry in fs::read_dir(&sessions).unwrap().flatten() {
            let raw = fs::read_to_string(entry.path()).unwrap();
            assert!(!raw.contains("hunter2"));
        }
    }

    #[test]
    fn check_returns_the_password_equality_proof_without_the_secret() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let source = Source::new(&store, &secrets, dir.path().join("host-sync"));
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let challenge = random_hex();
        let value = source.check(&reference, &challenge).unwrap();
        assert_eq!(value["password"]["state"], "available");
        assert_eq!(
            value["password"]["proof"].as_str().unwrap(),
            proof("hunter2", &reference, &challenge)
        );
        assert_eq!(value["configFingerprint"].as_str().unwrap().len(), 64);
        let rendered = value.to_string();
        assert!(!rendered.contains("hunter2"), "check 不能回传密码");
        // 另一个挑战得到另一个证明：证明不能跨会话或跨挑战复用。
        let other = source.check(&reference, &random_hex()).unwrap();
        assert_ne!(other["password"]["proof"], value["password"]["proof"]);
    }

    #[test]
    fn unreadable_secret_is_reported_as_unavailable_not_absent() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets {
            fail_load: true,
            ..FakeSecrets::default()
        };
        let source = Source::new(&store, &secrets, dir.path().join("host-sync"));
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let value = source.check(&reference, &random_hex()).unwrap();
        assert_eq!(value["password"]["state"], "unavailable");
        assert!(value["password"]["proof"].is_null(), "读不到秘密就不能给出相等证明");
    }

    #[test]
    fn sessions_are_single_use_and_expire_without_reading_another_host() {
        let (dir, store) = fixture("host-a", "example.test");
        store
            .save_remote_ssh_target(host("host-b", "staging", "other.test"))
            .unwrap();
        let secrets = FakeSecrets::with_password("host-a", "one");
        let sessions = dir.path().join("host-sync");
        let source = Source::new(&store, &secrets, sessions);
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        // 会话只属于 begin 时的那台主机：check 回的主机 id 永远是 host-a。
        let checked = source.check(&reference, &random_hex()).unwrap();
        assert_eq!(checked["hostId"], "host-a");
        source.settle(&reference).unwrap();
        assert_eq!(
            source.check(&reference, &random_hex()).unwrap_err().code,
            "session_expired"
        );
        assert_eq!(
            source.fetch(&reference, &random_hex(), "all").unwrap_err().code,
            "session_expired"
        );
        // 伪造引用、跨主机引用都不能读到别的主机。
        for bad in [
            "f".repeat(64),
            "host-b".to_string(),
            String::new(),
            "A".repeat(64),
        ] {
            assert!(source.check(&bad, &random_hex()).is_err(), "{bad}");
        }
        // 主机在会话期间被改动：会话作废，不拿旧配置对外。
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let mut moved = store.remote_ssh_target("host-a").unwrap();
        moved.host = "moved.test".to_string();
        store.save_remote_ssh_target(moved).unwrap();
        assert_eq!(
            source.check(&reference, &random_hex()).unwrap_err().code,
            "session_stale"
        );
    }

    #[test]
    fn expired_session_file_is_removed_and_rejected() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::default();
        let sessions = dir.path().join("host-sync");
        let source = Source::new(&store, &secrets, sessions.clone());
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let path = sessions.join(format!("{reference}.json"));
        let raw = fs::read_to_string(&path).unwrap();
        let mut session: Session = serde_json::from_str(&raw).unwrap();
        session.expires_at = now().saturating_sub(1);
        fs::write(&path, serde_json::to_vec(&session).unwrap()).unwrap();
        assert_eq!(
            source.check(&reference, &random_hex()).unwrap_err().code,
            "session_expired"
        );
        assert!(!path.exists(), "过期会话文件必须删除");
    }

    #[test]
    fn consistent_host_writes_nothing_and_keeps_the_revision() {
        let (dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let before = fs::read(dir.path().join("state.json")).unwrap();
        let revision = store.remote_ssh_target("host-a").unwrap().revision;
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let peer = FakePeer::new("a".repeat(64).as_str(), HostConfig::of(&target))
            .with_password("hunter2");
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver
            .receive(&peer, &peer.reference, None)
            .unwrap();
        assert_eq!(value["result"], "consistent");
        assert_eq!(value["password"], "equal");
        assert_eq!(value["receipts"][0]["state"], "unchanged");
        assert_eq!(value["receipts"][1]["state"], "unchanged");
        assert_eq!(value["sessionClosed"], true);
        assert_eq!(*peer.settled.lock().unwrap(), 1);
        assert_eq!(fs::read(dir.path().join("state.json")).unwrap(), before, "一致时不重写设置");
        assert_eq!(store.remote_ssh_target("host-a").unwrap().revision, revision);
    }

    #[test]
    fn only_the_differing_password_is_written_when_configuration_matches() {
        let (dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let before = fs::read(dir.path().join("state.json")).unwrap();
        let revision = store.remote_ssh_target("host-a").unwrap().revision;
        let secrets = FakeSecrets::with_password("host-a", "old-password");
        let peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&target)).with_password("new-password");
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "applied");
        assert_eq!(value["password"], "equal");
        assert_eq!(value["receipts"][0]["state"], "unchanged", "配置没变就不重写");
        assert_eq!(value["receipts"][1]["state"], "saved");
        assert_eq!(secrets.password("host-a").as_deref(), Some("new-password"));
        assert_eq!(fs::read(dir.path().join("state.json")).unwrap(), before, "只有密码变了");
        assert_eq!(store.remote_ssh_target("host-a").unwrap().revision, revision);
        assert!(!value.to_string().contains("new-password"), "回执里不能出现密码");
    }

    #[test]
    fn differing_configuration_is_applied_once_and_a_retry_writes_nothing_new() {
        let (_dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let mut remote = HostConfig::of(&target);
        remote.user = "release".to_string();
        remote.default_path = Some("/srv/other".to_string());
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(&"a".repeat(64), remote.clone());
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "applied");
        assert_eq!(value["receipts"][0]["state"], "saved");
        let saved = store.remote_ssh_target("host-a").unwrap();
        assert_eq!(HostConfig::of(&saved), remote);
        assert_eq!(saved.revision, 2, "身份字段变化推进一次修订");
        assert_eq!(saved.shared_host_id.as_deref(), Some("shared-1"));
        assert!(saved.enabled, "同步不改动接收方自己的启用状态");

        // 重试：同一会话时再跑一次 check，所有字段都已一致，不再写任何东西。
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "consistent");
        assert_eq!(value["receipts"][0]["state"], "unchanged");
    }

    #[test]
    fn a_partial_save_keeps_the_old_password_and_reports_two_receipts() {
        let (_dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let mut remote = HostConfig::of(&target);
        remote.display_name = "prod-renamed".to_string();
        let secrets = FakeSecrets {
            fail_save: true,
            ..FakeSecrets::with_password("host-a", "旧密码")
        };
        let peer = FakePeer::new(&"a".repeat(64), remote).with_password("新密码");
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "partial");
        assert_eq!(value["receipts"][0]["state"], "saved");
        assert_eq!(value["receipts"][1]["state"], "failed");
        assert_eq!(value["sessionClosed"], false, "部分失败不销毁会话，可以原上下文重试");
        assert_eq!(*peer.settled.lock().unwrap(), 0);
        assert_eq!(
            secrets.password("host-a").as_deref(),
            Some("旧密码"),
            "密码写入失败时保留原密码"
        );
        assert!(!value.to_string().contains("新密码"));
    }

    #[test]
    fn unreadable_password_never_counts_as_consistent() {
        let (dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let before = fs::read(dir.path().join("state.json")).unwrap();
        let secrets = FakeSecrets {
            fail_load: true,
            ..FakeSecrets::default()
        };
        let mut peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&target));
        peer.password_state = "unavailable";
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_ne!(value["result"], "consistent");
        assert_eq!(value["result"], "unknown");
        assert_eq!(value["password"], "unknown");
        assert_eq!(fs::read(dir.path().join("state.json")).unwrap(), before);
        assert_eq!(*peer.settled.lock().unwrap(), 0);
    }

    #[test]
    fn concurrent_local_edit_becomes_a_conflict_instead_of_being_overwritten() {
        let (_dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let mut remote = HostConfig::of(&target);
        remote.host = "from-source.test".to_string();
        let secrets = FakeSecrets::default();
        let store = Arc::new(store);
        let editing = Arc::clone(&store);
        let mut peer = FakePeer::new(&"a".repeat(64), remote);
        // check 之后、写之前，用户在本机改了同一台主机。
        peer.before_fetch = Some(Box::new(move || {
            let mut changed = editing.remote_ssh_target("host-a").unwrap();
            changed.host = "locally-edited.test".to_string();
            editing.save_remote_ssh_target(changed).unwrap();
        }));
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "conflict");
        assert_eq!(value["receipts"][0]["state"], "conflict");
        assert_eq!(
            store.remote_ssh_target("host-a").unwrap().host,
            "locally-edited.test",
            "冲突时不静默覆盖"
        );
    }

    #[test]
    fn unassociated_candidates_need_an_explicit_choice_and_linking_is_stable() {
        let (_dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&host("x", "prod", "example.test")));
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "association_required");
        assert_eq!(value["candidates"][0]["hostId"], "host-a");
        // 显式选择后只绑定关联，不新建第二条记录，也不按名称自动合并。
        let value = receiver
            .receive(&peer, &peer.reference, Some("host-a"))
            .unwrap();
        assert_eq!(value["result"], "consistent");
        assert_eq!(store.remote_ssh_targets().len(), 1);
        assert_eq!(
            store.remote_ssh_target("host-a").unwrap().shared_host_id.as_deref(),
            Some("shared-1")
        );
    }

    /// 写一张一次性确认票据。桌面 UI 在 T6 接线时按这一格式写入同一目录。
    fn write_ticket(
        dir: &Path,
        reference: &str,
        host_id: &str,
        shared: Option<&str>,
        created: u64,
        expires: u64,
        mode: u32,
    ) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{reference}.confirm"));
        let raw = serde_json::to_vec(&json!({
            "protocol": PROTOCOL,
            "hostId": host_id,
            "sharedHostId": shared,
            "createdAt": created,
            "expiresAt": expires,
        }))
        .unwrap();
        fs::write(&path, raw).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
        path
    }

    fn confirm_source<'a>(
        store: &'a AppStore,
        secrets: &'a dyn CredentialStore,
        dir: &Path,
    ) -> (Source<'a>, PathBuf) {
        let confirm = dir.join("confirm");
        (
            Source::new(store, secrets, dir.join("host-sync")).with_confirm_dir(confirm.clone()),
            confirm,
        )
    }

    #[test]
    fn password_scope_without_a_ticket_returns_confirmation_required_and_no_secret() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let (source, confirm) = confirm_source(&store, &secrets, dir.path());
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        for scope in ["password", "all"] {
            let failure = source.fetch(&reference, &random_hex(), scope).unwrap_err();
            assert_eq!(failure.code, "sync_confirmation_required", "{scope}");
            // 错误里也只有说明，没有密码。
            assert!(!failure.message.contains("hunter2"), "{scope}");
        }
        assert!(!confirm.exists(), "没有票据时不会凭空产生票据");
        // 只取配置不需要票据，也绝不带出密码。
        let value = source.fetch(&reference, &random_hex(), "config").unwrap();
        assert!(value["password"].is_null());
        assert_eq!(value["passwordState"], "not_requested");
        assert!(!value.to_string().contains("hunter2"));
    }

    #[test]
    fn a_valid_ticket_is_consumed_once_and_then_refused() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let (source, confirm) = confirm_source(&store, &secrets, dir.path());
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let shared = store
            .remote_ssh_target("host-a")
            .unwrap()
            .shared_host_id
            .unwrap();
        let created = now();
        let path = write_ticket(
            &confirm,
            &reference,
            "host-a",
            Some(&shared),
            created,
            created + CONFIRM_TTL_SECONDS,
            0o600,
        );
        let challenge = random_hex();
        let value = source.fetch(&reference, &challenge, "password").unwrap();
        assert_eq!(value["password"], "hunter2", "带票据时正常取回密码");
        assert_eq!(value["passwordState"], "available");
        assert!(!path.exists(), "票据用后即删");

        // 同一会话再要一次密码：看不到票据，必须重新确认。
        let again = source
            .fetch(&reference, &random_hex(), "password")
            .unwrap_err();
        assert_eq!(again.code, "sync_confirmation_required");
        assert!(store.remote_ssh_target("host-a").unwrap().shared_host_id.is_some());
    }

    #[test]
    fn tickets_for_another_host_or_window_or_mode_are_refused() {
        let (dir, store) = fixture("host-a", "example.test");
        let secrets = FakeSecrets::with_password("host-a", "hunter2");
        let (source, confirm) = confirm_source(&store, &secrets, dir.path());
        let reference = source.begin("host-a").unwrap()["sessionRef"]
            .as_str()
            .unwrap()
            .to_string();
        let shared = store
            .remote_ssh_target("host-a")
            .unwrap()
            .shared_host_id
            .unwrap();
        let created = now();
        let expired = created.saturating_sub(CONFIRM_TTL_SECONDS * 4);
        let too_long = created.saturating_sub(CONFIRM_TTL_SECONDS * 2);
        let cases: Vec<(&str, PathBuf)> = vec![
            (
                "别的机器",
                write_ticket(
                    &confirm,
                    &reference,
                    "host-b",
                    Some(&shared),
                    created,
                    created + CONFIRM_TTL_SECONDS,
                    0o600,
                ),
            ),
            (
                "别的关联",
                write_ticket(
                    &confirm,
                    &reference,
                    "host-a",
                    Some("shared-other"),
                    created,
                    created + CONFIRM_TTL_SECONDS,
                    0o600,
                ),
            ),
            (
                "已过期",
                write_ticket(
                    &confirm,
                    &reference,
                    "host-a",
                    Some(&shared),
                    expired,
                    expired + CONFIRM_TTL_SECONDS,
                    0o600,
                ),
            ),
            (
                "有效期超过上限",
                write_ticket(
                    &confirm,
                    &reference,
                    "host-a",
                    Some(&shared),
                    too_long,
                    created,
                    0o600,
                ),
            ),
        ];
        for (label, path) in cases {
            let failure = source
                .fetch(&reference, &random_hex(), "password")
                .unwrap_err();
            assert_eq!(failure.code, "sync_confirmation_required", "{label}");
            assert!(!path.exists(), "{label}：不识别的票据不会留在磁盘上");
        }
        // 权限不是 0600 的票据不算确认（POSIX 文件权限才有意义）。
        #[cfg(unix)]
        {
            let path = write_ticket(
                &confirm,
                &reference,
                "host-a",
                Some(&shared),
                created,
                created + CONFIRM_TTL_SECONDS,
                0o644,
            );
            let failure = source
                .fetch(&reference, &random_hex(), "password")
                .unwrap_err();
            assert_eq!(failure.code, "sync_confirmation_required", "权限过宽");
            assert!(!path.exists());
        }
    }

    #[test]
    fn same_address_records_owned_by_another_shared_id_become_a_conflict() {
        let (dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-other".to_string()),
                ..target
            })
            .unwrap();
        let before = fs::read(dir.path().join("state.json")).unwrap();
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(
            &"a".repeat(64),
            HostConfig::of(&host("x", "prod", "example.test")),
        );
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "association_conflict");
        assert_eq!(value["conflicts"][0]["hostId"], "host-a");
        assert_eq!(value["conflicts"][0]["sharedHostId"], "shared-other");
        assert!(value["receipts"].as_array().unwrap().is_empty());
        assert_eq!(value["sessionClosed"], false);
        // 本机记录不变：不新增重复记录，也不改写已有记录的关联。
        assert_eq!(fs::read(dir.path().join("state.json")).unwrap(), before);
        assert_eq!(store.remote_ssh_targets().len(), 1);
        assert_eq!(
            store
                .remote_ssh_target("host-a")
                .unwrap()
                .shared_host_id
                .as_deref(),
            Some("shared-other")
        );
        assert_eq!(*peer.settled.lock().unwrap(), 0);
    }

    #[test]
    fn explicit_link_refuses_a_record_owned_by_another_shared_id() {
        let (_dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-other".to_string()),
                ..target
            })
            .unwrap();
        let before_revision = store.remote_ssh_target("host-a").unwrap().revision;
        let secrets = FakeSecrets::default();
        let peer = FakePeer::new(
            &"a".repeat(64),
            HostConfig::of(&host("x", "prod", "example.test")),
        );
        let receiver = Receiver::new(&store, &secrets);
        let failure = receiver
            .receive(&peer, &peer.reference, Some("host-a"))
            .unwrap_err();
        assert_eq!(failure.code, "association_conflict");
        let after = store.remote_ssh_target("host-a").unwrap();
        assert_eq!(after.shared_host_id.as_deref(), Some("shared-other"));
        assert_eq!(after.revision, before_revision, "冲突时不推进修订");
    }

    #[test]
    fn a_concurrent_local_edit_blocks_a_password_only_write() {
        let (dir, store) = fixture("host-a", "example.test");
        let target = store.remote_ssh_target("host-a").unwrap();
        store
            .save_remote_ssh_target(SshTarget {
                shared_host_id: Some("shared-1".to_string()),
                ..target.clone()
            })
            .unwrap();
        let before = fs::read(dir.path().join("state.json")).unwrap();
        let secrets = FakeSecrets::with_password("host-a", "旧密码");
        let store = Arc::new(store);
        let editing = Arc::clone(&store);
        let mut peer =
            FakePeer::new(&"a".repeat(64), HostConfig::of(&target)).with_password("新密码");
        // check 之后、写之前，用户在本机改了同一台主机：只改密码的那一路也必须停下来。
        peer.before_fetch = Some(Box::new(move || {
            let mut changed = editing.remote_ssh_target("host-a").unwrap();
            changed.host = "locally-edited.test".to_string();
            editing.save_remote_ssh_target(changed).unwrap();
        }));
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "conflict");
        assert_eq!(value["receipts"][0]["kind"], "password");
        assert_eq!(value["receipts"][0]["state"], "conflict");
        assert_eq!(value["sessionClosed"], false);
        assert_eq!(
            secrets.password("host-a").as_deref(),
            Some("旧密码"),
            "冲突时不改写密码"
        );
        assert_eq!(
            store.remote_ssh_target("host-a").unwrap().host,
            "locally-edited.test"
        );
        assert_ne!(
            fs::read(dir.path().join("state.json")).unwrap(),
            before,
            "本机改动仍在，只是同步没有覆盖"
        );
        assert_eq!(*peer.settled.lock().unwrap(), 0);
    }

    #[test]
    fn session_references_must_come_from_stdin_not_argv() {
        let reference = "a".repeat(64);
        let challenge = "b".repeat(64);
        for rest in [
            vec!["host-a".to_string()],
            vec![reference.clone(), challenge.clone()],
            vec![reference.clone(), challenge.clone(), "all".to_string()],
            vec![reference.clone()],
        ] {
            assert_eq!(
                verify_argv(&rest, 0).unwrap_err().code,
                "host_sync_argv_rejected"
            );
        }
        assert!(verify_argv(&[], 0).is_ok());
        assert!(verify_argv(&["/usr/bin/cliora".to_string()], 1).is_ok());

        let line = format!(
            "{{\"sessionRef\":\"{reference}\",\"challenge\":\"{challenge}\",\"scope\":\"all\"}}"
        );
        assert_eq!(
            parse_params("fetch", &line).unwrap(),
            Params::Fetch {
                session_ref: reference.clone(),
                challenge: challenge.clone(),
                scope: "all".to_string(),
            }
        );
        assert_eq!(
            parse_params("begin", "host-a
").unwrap(),
            Params::Begin {
                host_id: "host-a".to_string()
            }
        );
        assert_eq!(
            parse_params("settle", &reference).unwrap(),
            Params::Settle {
                session_ref: reference.clone()
            }
        );
        assert_eq!(
            parse_params(
                "receive",
                &format!("{{\"sessionRef\":\"{reference}\",\"resolveTo\":\"host-a\"}}")
            )
            .unwrap(),
            Params::Receive {
                session_ref: reference.clone(),
                resolve_to: Some("host-a".to_string())
            }
        );
        // 多余字段、缺失字段、越权字段与非 JSON 错行都拒绝。
        for bad in [
            "",
            "{}",
            "{\"sessionRef\":\"x\"}",
            "{\"sessionRef\":\"x\",\"challenge\":\"y\",\"scope\":\"all\",\"hostId\":\"z\"}",
            "{\"sessionRef\":\"x\",\"challenge\":\"y\",\"scope\":\"all\",\"password\":\"hunter2\"}",
        ] {
            assert!(parse_params("fetch", bad).is_err(), "{bad}");
        }
        assert!(parse_params("nope", "x").is_err());
    }

    #[test]
    fn first_time_association_creates_one_disabled_record_with_the_shared_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(dir.path().join("state.json"));
        store.set_remote_ssh_enabled(true).unwrap();
        let secrets = FakeSecrets::with_password("remote-id", "hunter2");
        let peer = FakePeer::new(&"a".repeat(64), HostConfig::of(&host("remote-id", "prod", "example.test")))
            .with_password("hunter2");
        let receiver = Receiver::new(&store, &secrets);
        let value = receiver.receive(&peer, &peer.reference, None).unwrap();
        assert_eq!(value["result"], "applied");
        let targets = store.remote_ssh_targets();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].shared_host_id.as_deref(), Some("shared-1"));
        assert!(!targets[0].enabled, "新记录由接收方显式启用");
        assert_eq!(targets[0].revision, 1);
        assert_eq!(
            secrets.password(&targets[0].id).as_deref(),
            Some("hunter2"),
            "密码写入新记录自己的条目"
        );
        assert!(!value.to_string().contains("hunter2"));
    }
}

