//! 真实主机上的「命令层」门控测试：直接调用 #[tauri::command] 函数，默认跳过。
//!
//! 与 remote_ssh/live.rs（传输层）和 remote_worktree::tests（会话内部函数）不同，这里调用的是
//! IPC 命令本身：remote_worktree_targets / open / status / diff / write / recover / close。
//! 命令参数里的 State 由 tauri::test::mock_builder 托管的三份状态注入
//! （Arc<RemoteWorktrees>、Arc<Backend>、Arc<RemoteSsh>），与 lib.rs 的 run() 里
//! app.manage(...) 的三份状态类型一致；Channel<Progress> 用 Channel::new(|_| Ok(())) 构造，
//! 不需要 webview。
//!
//! 复用的路径是「Cliora 连接器 → 内嵌 v1 组件」：
//!
//! 1. remote_worktree_open 内部先 connector() 定位连接器，再 list/probe/install/connect。
//! 2. 连接器的目标来自 Cliora 自己的存储，不是本机主机簿：发行版 Cliora 只读安装库，
//!    只有开发构建才认 CLIORA_TWIGLANE_TEST_DB（见 cliora/src-tauri/src/remote/twiglane.rs）。
//!    因此本用例要求 TWIGLANE_CLIORA_CONNECTOR 指向 Cliora 的开发构建，并在临时目录里合成
//!    一份最小 Cliora 库（app_settings + remote_targets 两张表，字段与
//!    scripts/remote-worktree/verify-live.py 验证过的结构一致），把真实主机写进去。
//!    这一步不接触用户自己的 Cliora 库。
//! 3. 本机 src-tauri/agent-v2 为空目录 → select_provider 回退内嵌 v1，用例断言 protocol: 1。
//!
//! 门控变量（未设置时打印原因并 return，cargo test 默认全绿）：
//!
//! - TWIGLANE_REAL_SSH_TARGET：user@host[:port]。
//! - TWIGLANE_REAL_SSH_REPO：远端已有 git 仓库的绝对路径。
//! - TWIGLANE_CLIORA_CONNECTOR：Cliora 开发构建的可执行文件绝对路径。
//! - TWIGLANE_REAL_SSH_IDENTITY：可选，写进合成目标库的私钥路径（缺省交给 ssh 自己选）。
//!
//! 前置改动（用例自己造）：用本机 ssh 给远端仓库第一个已跟踪文件追加一行，用来产生
//! unstaged 差异；结束后 reset + checkout 复原。这一段不属于命令层覆盖范围，只负责准备变更
//! （桥接白名单里没有「写文件」这类 op）。

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::ipc::Channel;
use tauri::Manager;
use uuid::Uuid;

use super::*;

const TARGET_ENV: &str = "TWIGLANE_REAL_SSH_TARGET";
const REPO_ENV: &str = "TWIGLANE_REAL_SSH_REPO";
const IDENTITY_ENV: &str = "TWIGLANE_REAL_SSH_IDENTITY";
const CONNECTOR_ENV: &str = "TWIGLANE_CLIORA_CONNECTOR";
const TEST_DB_ENV: &str = "CLIORA_TWIGLANE_TEST_DB";
/// 真实主机的每一步都允许慢一些（首次还要上传 33 KB 的内嵌组件），但绝不无限等待。
const STEP_TIMEOUT: Duration = Duration::from_secs(300);

fn skipped(reason: &str) {
    println!("[live-command] 跳过：{reason}");
}

struct Endpoint {
    user: String,
    host: String,
    port: u16,
}

/// 解析 user@host[:port]；只接受能落到 ssh 参数里的形式。
fn endpoint(raw: &str) -> std::result::Result<Endpoint, String> {
    let raw = raw.trim();
    let (user, rest) = match raw.rsplit_once('@') {
        Some((user, rest)) => (user.trim(), rest.trim()),
        None => return Err("必须是 user@host[:port]".into()),
    };
    if user.is_empty() || rest.is_empty() {
        return Err("必须是 user@host[:port]".into());
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => (host.to_string(), port),
        _ => (rest.to_string(), "22"),
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
        Ok(Err(error)) => panic!("[live-command] {what} 失败：{} / {}", error.code, error.message),
        Err(_) => panic!("[live-command] {what} 超时（{}s）", STEP_TIMEOUT.as_secs()),
    }
}

/// 把一段远端 shell 片段包成单引号形式：内部单引号按 POSIX 规则拆成 '"'"' 拼接，
/// 因此既能包路径，也能包再套一层的命令。
fn shell_quote(raw: &str) -> std::result::Result<String, String> {
    Ok(format!("'{}'", raw.replace('\'', "'\\''")))
}

/// 本机 ssh 直连远端：只用于准备/复原夹具，不冒充被测路径。
fn ssh(
    endpoint: &Endpoint,
    identity: Option<&str>,
    script: &str,
) -> std::result::Result<String, String> {
    let mut command = StdCommand::new("ssh");
    command
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=15",
            "-p",
            &endpoint.port.to_string(),
            "-l",
            &endpoint.user,
        ])
        .arg("--")
        .arg(&endpoint.host);
    if let Some(identity) = identity {
        command.args(["-i", identity]);
    }
    let output = command
        .arg(script)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 ssh：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ssh 执行失败（exit={:?}）：{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 合成一份最小 Cliora 库：开发构建读 CLIORA_TWIGLANE_TEST_DB 指定的这一份，于是 list 里
/// 就会出现真实主机这一条目标，用户自己的安装库不被触碰。
fn write_cliora_db(
    db: &Path,
    endpoint: &Endpoint,
    repo: &str,
    identity: Option<&str>,
) -> std::result::Result<(), String> {
    let literal = |value: Option<&str>| match value {
        Some(value) => format!("'{}'", value.replace('\'', "''")),
        None => "NULL".to_string(),
    };
    let preferences = json!({
        "managed_tools": [],
        "theme": "light",
        "schema_version": 1,
        "remote_ssh_enabled": true,
    });
    let sql = format!(
        "CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);\
         CREATE TABLE remote_targets(id,name,host,port,user_name,auth_method,identity_file,\
         ssh_config,default_path,enabled,created_at,updated_at);\
         INSERT INTO app_settings VALUES('preferences',{});\
         INSERT INTO remote_targets VALUES('live-command-target','真实主机','{}',{},'{}','key',{},\
         NULL,{},1,1,1);",
        literal(Some(&preferences.to_string())),
        endpoint.host,
        endpoint.port,
        endpoint.user,
        literal(identity),
        literal(Some(repo)),
    );
    let output = StdCommand::new("sqlite3")
        .arg(db)
        .arg(&sql)
        .output()
        .map_err(|error| format!("无法启动 sqlite3（合成 Cliora 目标库需要 sqlite3）：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "sqlite3 写入失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[tokio::test]
async fn real_host_command_layer_opens_reads_diffs_and_writes() {
    let Ok(raw) = env::var(TARGET_ENV) else {
        skipped(&format!("未设置 {TARGET_ENV}（形如 user@host:22）"));
        return;
    };
    let endpoint = match endpoint(&raw) {
        Ok(endpoint) => endpoint,
        Err(reason) => panic!("[live-command] {TARGET_ENV}={raw} 无法解析：{reason}"),
    };
    let Ok(repo) = env::var(REPO_ENV) else {
        skipped(&format!("未设置 {REPO_ENV}（远端 git 仓库绝对路径）"));
        return;
    };
    let identity = env::var(IDENTITY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let Some(connector) = env::var_os(CONNECTOR_ENV).map(PathBuf::from) else {
        skipped(&format!(
            "未设置 {CONNECTOR_ENV}（需指向 Cliora 的开发构建：只有开发构建认 {TEST_DB_ENV}，\
             发行版只读安装库，无法注入真实主机目标）"
        ));
        return;
    };
    assert!(
        connector.is_file(),
        "[live-command] {CONNECTOR_ENV}={} 不是文件",
        connector.display()
    );
    let repo_quoted = match shell_quote(&repo) {
        Ok(value) => value,
        Err(reason) => panic!("[live-command] {reason}"),
    };

    // 远端必须是 git 仓库；首个已跟踪文件用作一次真实改动。
    let top = match ssh(
        &endpoint,
        identity.as_deref(),
        &format!("git -C {repo_quoted} rev-parse --show-toplevel"),
    ) {
        Ok(top) => top,
        Err(reason) => {
            skipped(&format!("远端 {repo} 不是可读的 git 仓库：{reason}"));
            return;
        }
    };
    println!("[live-command] 远端仓库：{top}");
    let file = match ssh(
        &endpoint,
        identity.as_deref(),
        &format!(
            "sh -c {}",
            shell_quote(&format!("git -C {repo_quoted} ls-files | head -n 1")).unwrap()
        ),
    ) {
        Ok(file) if !file.is_empty() => file,
        other => panic!("[live-command] 无法从远端仓库取出已跟踪文件：{other:?}"),
    };
    let marker = format!("twiglane command layer probe {}", Uuid::new_v4());
    let prepare = format!(
        "sh -c {}",
        shell_quote(&format!(
            "printf '\\n%s\\n' {} >> {repo_quoted}/{}",
            shell_quote(&marker).unwrap(),
            shell_quote(&file).unwrap()
        ))
        .unwrap()
    );
    if let Err(reason) = ssh(&endpoint, identity.as_deref(), &prepare) {
        panic!("[live-command] 无法在远端制造未暂存改动：{reason}");
    }
    println!("[live-command] 夹具改动：{file} 追加一行（{marker}）");

    // Cliora 目标库：只有开发构建才读它。
    let dir = crate::test_support::TempDir::new("remote-command-layer");
    let db = dir.path().join("cliora.db");
    if let Err(reason) = write_cliora_db(&db, &endpoint, &repo, identity.as_deref()) {
        skipped(&reason);
        return;
    }
    // 连接器按子进程继承这些变量；整个过程只有本用例在改它们。
    env::set_var(TEST_DB_ENV, &db);
    env::set_var("CLIORA_SSH_PROXY", "off");
    env::set_var(CONNECTOR_ENV, &connector);

    // 1) 命令层：目标列表（这条命令不带 State，直接调）。
    let targets = step("远端目标列表", remote_worktree_targets()).await;
    let target = targets
        .iter()
        .find(|target| target.host == endpoint.host && target.user == endpoint.user)
        .unwrap_or_else(|| {
            panic!(
                "[live-command] 合成的 Cliora 目标库里没有 {}@{}：{:?}",
                endpoint.user,
                endpoint.host,
                targets
                    .iter()
                    .map(|target| (target.host.clone(), target.user.clone()))
                    .collect::<Vec<_>>()
            )
        });
    let target_id = target.target_id.clone();
    let target_revision = target.target_revision.clone();
    println!(
        "[live-command] 目标：{} {} host={} user={}",
        target_id, target_revision, target.host, target.user
    );

    // 2) 命令参数里的三份 State：与 run() 里 app.manage(...) 的类型一一对应。
    let fixture = crate::test_support::git_fixture("remote-command-layer-backend");
    let backend = Arc::new(fixture.backend());
    // 空目录 → 没有 agent-v2 清单 → select_provider 回退内嵌 v1。
    let artifacts = dir.path().join("agent-v2");
    std::fs::create_dir_all(&artifacts).unwrap();
    let ssh_state = Arc::new(RemoteSsh::with_exec(artifacts, PathBuf::from("ssh"), Vec::new()));
    let worktrees = Arc::new(RemoteWorktrees::new(dir.path().join("remote-worktrees")));
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&worktrees))
        .manage(Arc::clone(&backend))
        .manage(Arc::clone(&ssh_state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");

    // 3) open：第一次不带安装确认；远端没有兼容组件时按回执再确认一次。
    let request = OpenRequest {
        request_id: Uuid::new_v4().to_string(),
        target_id: target_id.clone(),
        target_revision: target_revision.clone(),
        path: repo.clone(),
        baseline: None,
        allow_install: false,
        install_confirmation: None,
        review_id: None,
    };
    let opened = step(
        "打开远端工作树",
        remote_worktree_open(
            app.state(),
            app.state(),
            app.state(),
            request,
            Channel::new(|_| Ok(())),
        ),
    )
    .await;
    let opened = if opened["kind"] == "install_required" {
        println!(
            "[live-command] 远端没有兼容的内嵌组件：version={} size={}，按确认回执重试",
            opened["version"], opened["size"]
        );
        let confirmation = opened["confirmationId"]
            .as_str()
            .expect("安装提示必须带 confirmationId")
            .to_string();
        step(
            "确认安装并重新打开",
            remote_worktree_open(
                app.state(),
                app.state(),
                app.state(),
                OpenRequest {
                    request_id: Uuid::new_v4().to_string(),
                    target_id: target_id.clone(),
                    target_revision: target_revision.clone(),
                    path: repo.clone(),
                    baseline: None,
                    allow_install: true,
                    install_confirmation: Some(confirmation),
                    review_id: None,
                },
                Channel::new(|_| Ok(())),
            ),
        )
        .await
    } else {
        opened
    };
    assert_eq!(opened["kind"], "open", "{opened}");
    assert_eq!(
        opened["protocol"].as_u64(),
        Some(1),
        "本机没有 v2 产物，这条路径应是内嵌 v1：{opened}"
    );
    assert_eq!(opened["agentVersion"].as_str(), Some(V1_VERSION));
    let session_id = opened["sessionId"]
        .as_str()
        .expect("open 应返回 sessionId")
        .to_string();
    let snapshot = &opened["snapshot"];
    let repo_key = snapshot["repo"]
        .as_str()
        .filter(|value| !value.is_empty())
        .expect("snapshot 应带 repo 标识")
        .to_string();
    let head = snapshot["head"].as_str().unwrap_or_default().to_string();
    assert_eq!(head.len(), 40, "snapshot.head 应是完整提交号：{snapshot}");
    assert!(!snapshot["generation"]
        .as_str()
        .unwrap_or_default()
        .is_empty());
    println!(
        "[live-command] open：session={session_id} repo={repo_key} head={head} branch={} files={}",
        snapshot["branch"],
        snapshot["files"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0)
    );

    // 4) status：代次能刷新，改动列表里有刚追加的那一行。
    let status = step(
        "状态",
        remote_worktree_status(app.state(), session_id.clone()),
    )
    .await;
    assert_eq!(status["repo"].as_str(), Some(repo_key.as_str()));
    let generation = status["generation"]
        .as_str()
        .filter(|value| !value.is_empty())
        .expect("status 应返回 generation")
        .to_string();
    let unstaged = status["files"]
        .as_array()
        .expect("status.files 应是数组")
        .iter()
        .find(|entry| entry["path"].as_str() == Some(file.as_str()))
        .unwrap_or_else(|| panic!("改动列表里没有 {file}：{status}"));
    assert_eq!(
        unstaged["xy"].as_str(),
        Some(" M"),
        "刚追加一行、尚未暂存：{status}"
    );
    println!(
        "[live-command] status：generation={generation} {file} xy={}",
        unstaged["xy"]
    );

    // 5) diff（unstaged）：返回的 unified 文本里必须有刚追加的那一行。
    let diff = step(
        "未暂存差异",
        remote_worktree_diff(
            app.state(),
            DiffRequest {
                session_id: session_id.clone(),
                generation: generation.clone(),
                path: file.clone(),
                view: "unstaged".into(),
                cursor: None,
            },
        ),
    )
    .await;
    let encoded = diff["data"].as_str().expect("diff.data 应是 base64 文本");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("diff.data 应是合法 base64");
    let unified = String::from_utf8_lossy(&bytes).to_string();
    assert!(
        unified.contains(&marker),
        "差异里应包含夹具追加的那一行：{unified}"
    );
    assert!(unified.contains("@@"), "差异应是 unified 格式：{unified}");
    // v1 组件没有 patch 能力：块级暂存必须如实标为不支持。
    assert_eq!(diff["hunksStageable"], json!(false), "{diff}");
    assert!(diff["hunksStageableReason"].as_str().is_some(), "{diff}");
    println!(
        "[live-command] diff：{} 字节 unified，hunksStageable={}",
        unified.len(),
        diff["hunksStageable"]
    );

    // 6) 写操作：暂存同一个文件，回执必须 completed，且再次 status 确实变了。
    let operation_id = Uuid::new_v4().to_string();
    let written = step(
        "暂存文件",
        remote_worktree_write(
            app.state(),
            WriteRequest {
                session_id: session_id.clone(),
                generation: generation.clone(),
                operation_id: operation_id.clone(),
                op: WriteKind::Stage,
                path: Some(file.clone()),
                message: None,
            },
        ),
    )
    .await;
    assert_eq!(written["state"], "completed", "暂存回执未完成：{written}");
    assert_eq!(written["operationId"].as_str(), Some(operation_id.as_str()));
    let after = step(
        "暂存后状态",
        remote_worktree_status(app.state(), session_id.clone()),
    )
    .await;
    let staged = after["files"]
        .as_array()
        .expect("status.files 应是数组")
        .iter()
        .find(|entry| entry["path"].as_str() == Some(file.as_str()))
        .unwrap_or_else(|| panic!("暂存后改动列表里没有 {file}：{after}"));
    assert_eq!(
        staged["xy"].as_str(),
        Some("M "),
        "暂存后状态码应变成已暂存：{after}"
    );
    println!(
        "[live-command] stage：operationId={} state={} 之后 {file} xy={}",
        written["operationId"], written["state"], staged["xy"]
    );

    // 7) recover：没有待确认记录的操作应如实返回 unknown，而不是谎称完成。
    let recovered = step(
        "回执核对",
        remote_worktree_recover(app.state(), session_id.clone(), Uuid::new_v4().to_string()),
    )
    .await;
    assert_eq!(recovered["state"], "unknown", "{recovered}");
    println!("[live-command] recover：{}", recovered["state"]);

    // 8) close：会话被移除后同一条 status 必须明确报断连。
    step(
        "关闭会话",
        remote_worktree_close(app.state(), session_id.clone()),
    )
    .await;
    let closed = remote_worktree_status(app.state(), session_id.clone()).await;
    assert_eq!(
        closed.as_ref().err().map(|error| error.code.as_str()),
        Some("remote_disconnected"),
        "关闭后不应还能读到状态：{closed:?}"
    );

    // 9) 复原远端夹具：撤销暂存与那一次追加。
    let restore = format!(
        "sh -c {}",
        shell_quote(&format!(
            "git -C {repo_quoted} reset -q && git -C {repo_quoted} checkout -q -- {}",
            shell_quote(&file).unwrap()
        ))
        .unwrap()
    );
    if let Err(reason) = ssh(&endpoint, identity.as_deref(), &restore) {
        println!("[live-command] 警告：无法复原远端夹具：{reason}");
    }
    env::remove_var(TEST_DB_ENV);
    println!("[live-command] 全部通过：命令层 targets → open → status → diff → write → recover → close");
}
