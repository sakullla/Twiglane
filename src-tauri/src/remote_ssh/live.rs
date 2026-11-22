//! 真实主机上的「桌面 SSH 传输路径」：环境变量门控，默认跳过。
//!
//! 与 `tests.rs` 里的替身路径不同，这里所有连接都走生产代码：
//! `Context::build`（`ssh -G` 冻结配置 + 私有 known_hosts 副本 + BatchMode）、
//! `transport::probe`、`remote_ssh_install_agent` 的分块上传，以及 `open_session` 的
//! v2 会话握手。没有设置门控环境变量时用例直接跳过并打印原因，`cargo test` 默认全绿。
//!
//! 门控变量：
//! - `TWIGLANE_REAL_SSH_TARGET`：`user@host[:port]`（`[::1]:22` 形式也接受），设置后才会连。
//! - `TWIGLANE_REAL_SSH_REPO`：远端已有的 git 仓库绝对路径，用于 `open`/`status`/`history`；
//!   缺失时只跑到装载与握手，随后跳过会话部分并说明。
//! - `TWIGLANE_AGENT_V2_DIR`：本机 v2 产物目录（含 `manifest.json`），缺省用
//!   `src-tauri/agent-v2`；远端已装好兼容组件时不需要它。
//! - `TWIGLANE_REAL_SSH_IDENTITY`：可选，密钥认证用的私钥绝对路径（缺省交给 ssh 自己选）。

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;

const TARGET_ENV: &str = "TWIGLANE_REAL_SSH_TARGET";
const REPO_ENV: &str = "TWIGLANE_REAL_SSH_REPO";
const ARTIFACT_ENV: &str = "TWIGLANE_AGENT_V2_DIR";
const IDENTITY_ENV: &str = "TWIGLANE_REAL_SSH_IDENTITY";
/// 真实主机的每一步都允许慢一些，但绝不无限等待。
const STEP_TIMEOUT: Duration = Duration::from_secs(180);

/// 门控未设置时的唯一出口：打印原因后正常返回，不制造失败。
fn skipped(reason: &str) {
    println!("[live-ssh] 跳过：{reason}");
}

struct Endpoint {
    user: String,
    host: String,
    port: u16,
}

/// 解析 `user@host[:port]`。只接受能映射到 `SshTarget` 的形式，其余明确报错。
fn endpoint(raw: &str) -> std::result::Result<Endpoint, String> {
    let raw = raw.trim();
    let (user, rest) = match raw.rsplit_once('@') {
        Some((user, rest)) => (user.trim(), rest.trim()),
        None => return Err("必须是 user@host[:port]".into()),
    };
    if user.is_empty() || rest.is_empty() {
        return Err("必须是 user@host[:port]".into());
    }
    let (host, port) = if let Some(stripped) = rest.strip_prefix('[') {
        let (host, tail) = stripped
            .split_once(']')
            .ok_or_else(|| "IPv6 地址缺少右方括号".to_string())?;
        let port = match tail.strip_prefix(':') {
            Some(port) => port,
            None if tail.is_empty() => "22",
            None => return Err("IPv6 地址后只能是 :port".into()),
        };
        (host.to_string(), port)
    } else {
        match rest.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host.to_string(), port),
            _ => (rest.to_string(), "22"),
        }
    };
    let port: u16 = port
        .trim()
        .parse()
        .map_err(|_| format!("端口不是有效数字：{port}"))?;
    if host.is_empty() || port == 0 {
        return Err("主机或端口无效".into());
    }
    Ok(Endpoint {
        user: user.to_string(),
        host,
        port,
    })
}

async fn step<T>(what: &str, future: impl std::future::Future<Output = Result<T>>) -> T {
    match tokio::time::timeout(STEP_TIMEOUT, future).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => panic!(
            "[live-ssh] {what} 失败：{} / {}",
            error.code, error.message
        ),
        Err(_) => panic!("[live-ssh] {what} 超时（{}s）", STEP_TIMEOUT.as_secs()),
    }
}

fn text<'a>(value: &'a Value, path: &str) -> &'a str {
    value
        .get(path)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

#[tokio::test]
async fn real_host_transport_path_opens_session_and_reads_history() {
    let Ok(raw) = env::var(TARGET_ENV) else {
        skipped(&format!("未设置 {TARGET_ENV}（形如 user@host:22）"));
        return;
    };
    let endpoint = match endpoint(&raw) {
        Ok(endpoint) => endpoint,
        Err(reason) => {
            panic!("[live-ssh] {TARGET_ENV}={raw} 无法解析：{reason}");
        }
    };

    let dir = crate::test_support::TempDir::new("ssh-live");
    let store = AppStore::open(dir.path().join("state.json"));
    store.set_remote_ssh_enabled(true).unwrap();
    let target = store
        .save_remote_ssh_target(SshTarget {
            id: "live-host".into(),
            display_name: "真实主机".into(),
            host: endpoint.host.clone(),
            port: endpoint.port,
            user: endpoint.user.clone(),
            auth_method: "key".into(),
            identity_file: env::var(IDENTITY_ENV)
                .ok()
                .filter(|value| !value.trim().is_empty()),
            ssh_config: None,
            default_path: None,
            enabled: true,
            shared_host_id: None,
            revision: 0,
        })
        .unwrap();
    let artifacts = env::var_os(ARTIFACT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("agent-v2"));
    // 生产路径用 PATH 上的 ssh；这里只是显式把可执行文件名交给同一套构造代码。
    let ssh = RemoteSsh::with_exec(artifacts.clone(), PathBuf::from("ssh"), Vec::new());
    let context = Context::new(&store, &ssh);

    // 1) 冻结配置 + 探测：peerRevision/peerIdentity 只有走 Context::build 才会有。
    let probe = step("探测远端", probe_target(&context, &target)).await;
    println!(
        "[live-ssh] 探测：host={} system={} architecture={} git={:?}",
        probe.effective_host, probe.system, probe.architecture, probe.git
    );
    println!(
        "[live-ssh] 配置修订={} 对端修订={} 对端身份={}",
        probe.config_revision, probe.peer_revision, probe.peer_identity
    );
    println!(
        "[live-ssh] 已装组件：installed={} digest={:?} version={:?} compatible={} probe={}",
        probe.agent_installed,
        probe.agent_digest,
        probe.agent_version,
        probe.agent_compatible,
        probe.agent_probe.is_some()
    );
    assert!(
        crate::remote_ssh::platform(&probe.system, &probe.architecture).is_some(),
        "远端 {} / {} 不受支持",
        probe.system,
        probe.architecture
    );

    // 2) 远端没有兼容组件时，走生产的分块上传路径把它装上去。
    let digest = match probe.agent_digest.clone().filter(|_| probe.agent_compatible) {
        Some(digest) => {
            println!("[live-ssh] 复用远端已安装组件：{digest}");
            digest
        }
        None => {
            if let Err(error) = manifest_ready(&artifacts) {
                skipped(&format!(
                    "本机没有可用的 v2 产物清单（{}：{}），远端也没有兼容组件；设置 {ARTIFACT_ENV} 指向含 manifest.json 的目录后重跑",
                    artifacts.display(),
                    error.code
                ));
                return;
            }
            let artifact = select_agent(&artifacts, &probe.system, &probe.architecture)
                .expect("按探测到的 system/architecture 选择产物");
            println!(
                "[live-ssh] 上传产物：version={} sha256={} bytes={}",
                artifact.version,
                artifact.sha256,
                artifact.bytes.len()
            );
            // 进度闭包要求 `Fn + Sync`：只在跨过四分之一时打印，用原子量记住上次字节数。
            let last_sent = std::sync::atomic::AtomicU64::new(0);
            install_artifact(&store, &ssh, &target, &artifact, &|sent, total| {
                let previous = last_sent.load(std::sync::atomic::Ordering::Relaxed);
                if sent == total || sent.saturating_sub(previous) >= total / 4 {
                    last_sent.store(sent, std::sync::atomic::Ordering::Relaxed);
                    println!("[live-ssh] 上传进度 {sent}/{total} 字节");
                }
            })
            .await
            .expect("远端组件安装（分块上传 + 摘要回执）");
            let after = step("安装后重新探测", probe_target(&context, &target)).await;
            assert_eq!(
                after.agent_digest.as_deref(),
                Some(artifact.sha256.as_str()),
                "安装后远端摘要应与上传产物一致"
            );
            assert!(after.agent_compatible, "安装后组件应能自述且与目标平台匹配");
            artifact.sha256
        }
    };

    // 3) 起 v2 会话并握手。
    let session = step("打开 v2 会话", open_session(&store, &ssh, &target, &digest)).await;
    assert_eq!(session.transport.protocol(), 2, "会话协议应为 v2");
    let hello = step("hello", session.transport.rpc("hello", json!({}))).await;
    assert_eq!(hello["protocol"].as_u64(), Some(2), "hello 应报 protocol 2");
    println!(
        "[live-ssh] hello：protocol={} agent={} version={} os={} arch={} capabilities={}",
        hello["protocol"],
        text(&hello, "agent"),
        text(&hello, "version"),
        text(&hello, "os"),
        text(&hello, "arch"),
        hello["capabilities"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0)
    );

    let Ok(repo) = env::var(REPO_ENV) else {
        session.transport.close().await;
        skipped(&format!(
            "未设置 {REPO_ENV}（远端 git 仓库绝对路径），会话已握手但未打开工作树"
        ));
        return;
    };

    // 4) 打开真实仓库：repo 与 stateToken 是后续所有请求的上下文。
    let opened = step(
        "open",
        session.transport.rpc("open", json!({ "path": repo })),
    )
    .await;
    let repo_key = text(&opened, "repo").to_string();
    let token = text(&opened, "stateToken").to_string();
    assert!(!repo_key.is_empty(), "open 应返回 repo");
    assert!(!token.is_empty(), "open 应返回 stateToken");
    let branch = text(&opened["snapshot"]["branch"], "name").to_string();
    println!(
        "[live-ssh] open：repo={} root={} name={} generation={} stateToken={} branch={} files={} watchDegraded={}",
        repo_key,
        text(&opened, "root"),
        text(&opened, "name"),
        opened["generation"],
        token,
        if branch.is_empty() { "-" } else { &branch },
        opened["snapshot"]["files"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0),
        opened["watchDegraded"]
    );

    // 5) status：代次与令牌必须能刷新。
    let status = step(
        "status",
        session.transport.rpc("status", json!({ "repo": repo_key })),
    )
    .await;
    let status_token = text(&status, "stateToken").to_string();
    assert_eq!(status["repo"].as_str(), Some(repo_key.as_str()));
    assert!(!status_token.is_empty(), "status 应返回 stateToken");
    println!(
        "[live-ssh] status：generation={} stateToken={} branch={} files={}",
        status["generation"],
        status_token,
        text(&status["snapshot"]["branch"], "name"),
        status["snapshot"]["files"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0)
    );

    // 6) history：这一页必须真的拿到提交。
    let history = step(
        "history",
        session
            .transport
            .rpc("history", json!({ "repo": repo_key, "offset": 0 })),
    )
    .await;
    let commits = history["page"]["commits"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(!commits.is_empty(), "history.page.commits 不应为空");
    println!(
        "[live-ssh] history：commits={} nextOffset={} 最新={} {}",
        commits.len(),
        history["nextOffset"],
        text(&commits[0], "oid"),
        text(&commits[0], "summary")
    );

    session.transport.close().await;
    println!("[live-ssh] 全部通过：桌面 SSH 传输路径（build → probe → install → session → history）");
}
