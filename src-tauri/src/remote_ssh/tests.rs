//! 远程 SSH 的原生回归：总开关、主机簿、快照修订、askpass、探测与安装。
//!
//! 远端用本机 `sh` 替身承接：`ssh -G` 返回固定 profile，其余命令在临时 HOME 下真实
//! 执行，因此临时文件、摘要核对与原子 rename 都是真的跑过一遍，只有网络与远端主机是模拟的。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::*;
use crate::change_request::credential::CredentialFailure;
use crate::state::{Persisted, RemoteSsh as RemoteSshSettings};

/// 钥匙串替身：只在本进程内保存，用来验证命名空间隔离与"只回布尔状态"。
#[derive(Default)]
struct FakeStore {
    entries: Mutex<HashMap<String, String>>,
    fail: bool,
}

impl FakeStore {
    fn with(entries: &[(&str, &str)]) -> Self {
        Self {
            entries: Mutex::new(
                entries
                    .iter()
                    .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                    .collect(),
            ),
            fail: false,
        }
    }
}

impl CredentialStore for FakeStore {
    fn load(&self, key: &str) -> std::result::Result<Option<String>, CredentialFailure> {
        if self.fail {
            return Err(CredentialFailure::Unavailable);
        }
        Ok(self.entries.lock().unwrap().get(key).cloned())
    }

    fn save(&self, key: &str, secret: &str) -> std::result::Result<(), CredentialFailure> {
        if self.fail {
            return Err(CredentialFailure::Unavailable);
        }
        self.entries
            .lock()
            .unwrap()
            .insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> std::result::Result<(), CredentialFailure> {
        if self.fail {
            return Err(CredentialFailure::Unavailable);
        }
        self.entries.lock().unwrap().remove(key);
        Ok(())
    }
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

/// 本机 ssh 替身：有 `-G` 时打印固定 profile，其余把最后一段当远程命令在本机执行。
const STUB: &str = "#!/bin/sh\n\
has_g=0\n\
hop=\"\"\n\
for arg in \"$@\"; do\n\
  [ \"$arg\" = \"-G\" ] && has_g=1\n\
  case \"$arg\" in ssh://*) hop=\"$arg\" ;; esac\n\
done\n\
if [ \"$has_g\" = 1 ]; then\n\
  if [ -n \"$hop\" ] && [ -n \"$STUB_HOP_PROFILE\" ]; then cat \"$STUB_HOP_PROFILE\"; else cat \"$STUB_PROFILE\"; fi\n\
  exit 0\n\
fi\n\
for last; do :; done\n\
printf 'debug1: Server host key: ssh-ed25519 %s\\n' \"$STUB_HOST_KEY\" >&2\n\
exec sh -c \"$last\"\n";

fn target() -> SshTarget {
    SshTarget {
        id: "host-a".into(),
        display_name: "构建机".into(),
        host: "build.example.com".into(),
        port: 2222,
        user: "deploy".into(),
        auth_method: "key".into(),
        identity_file: Some("/home/deploy/.ssh/id_ed25519".into()),
        ssh_config: None,
        default_path: Some("/srv/app".into()),
        enabled: true,
        shared_host_id: None,
        revision: 1,
    }
}

struct Harness {
    dir: crate::test_support::TempDir,
    store: AppStore,
    ssh: RemoteSsh,
    host_home: PathBuf,
}

impl Harness {
    fn new(name: &str) -> Self {
        let dir = crate::test_support::TempDir::new(name);
        let root = dir.path().to_path_buf();
        let known_hosts = root.join("known_hosts");
        fs::write(
            &known_hosts,
            "build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITRUSTED\n",
        )
        .unwrap();
        let profile = root.join("profile");
        fs::write(
            &profile,
            format!(
                "host build.example.com\nhostname 10.9.0.4\nuser deploy\nport 2222\nidentityfile /home/deploy/.ssh/id_ed25519\nuserknownhostsfile {}\nglobalknownhostsfile none\nrevokedhostkeys none\nproxyjump none\nstricthostkeychecking ask\n",
                known_hosts.display()
            ),
        )
        .unwrap();
        let ssh = root.join("ssh");
        write_script(&ssh, STUB);

        let host_home = root.join("remote-home");
        fs::create_dir_all(&host_home).unwrap();
        let artifacts = root.join("agent-v2");
        fs::create_dir_all(&artifacts).unwrap();
        let store = AppStore::open(root.join("state.json"));
        store.set_remote_ssh_enabled(true).unwrap();
        store.save_remote_ssh_target(target()).unwrap();
        Self {
            ssh: RemoteSsh {
                artifacts,
                exec: SshExec {
                    program: ssh,
                    env: vec![
                        ("STUB_PROFILE".into(), profile.display().to_string()),
                        (
                            "STUB_HOST_KEY".into(),
                            "SHA256:stubhostkeyidentity".into(),
                        ),
                        ("HOME".into(), host_home.display().to_string()),
                    ],
                },
                running: Mutex::new(HashMap::new()),
                offers: Mutex::new(HashMap::new()),
            },
            store,
            host_home,
            dir,
        }
    }

    fn context<'a>(&'a self, credentials: &'a FakeStore) -> Context<'a> {
        Context {
            store: &self.store,
            credentials: Box::new(FakeStore::with(
                &credentials
                    .entries
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str()))
                    .collect::<Vec<_>>(),
            )),
            exec: self.ssh.exec.clone(),
            artifacts: self.ssh.artifacts.clone(),
        }
    }

    fn agent_dir(&self) -> PathBuf {
        self.host_home.join(".local/share/twiglane/agent/v2")
    }

    fn known_hosts(&self) -> PathBuf {
        self.dir.path().join("known_hosts")
    }

    fn artifacts(&self) -> &Path {
        &self.ssh.artifacts
    }

    /// 通过替身 ssh 执行一段远端命令，标准输入承载产物字节。
    /// 测试不自己启动 shell：远端命令由"ssh"接管，与生产路径一致。
    fn run_remote(&self, script: &str, stdin_bytes: &[u8]) -> std::process::Output {
        let mut child = std::process::Command::new(&self.ssh.exec.program)
            .arg("--")
            .arg("deploy@build.example.com")
            .arg(script)
            .env("STUB_PROFILE", self.dir.path().join("profile"))
            .env("STUB_HOST_KEY", "SHA256:stubhostkeyidentity")
            .env("HOME", &self.host_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("stub ssh runs");
        {
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(stdin_bytes)
                .unwrap();
        }
        child.wait_with_output().unwrap()
    }
}

fn install_fake_agent(harness: &Harness, body: &str) -> String {
    let dir = harness.agent_dir();
    fs::create_dir_all(&dir).unwrap();
    write_script(&dir.join("twiglane-agent-v2"), body);
    format!(
        "{:x}",
        Sha256::digest(fs::read(dir.join("twiglane-agent-v2")).unwrap())
    )
}

#[tokio::test]
async fn disabled_switch_blocks_every_new_connection() {
    let harness = Harness::new("ssh-disabled");
    let credentials = FakeStore::default();
    let context = harness.context(&credentials);
    assert!(context.resolve_target("host-a").is_ok());

    harness.store.set_remote_ssh_enabled(false).unwrap();
    assert_eq!(
        context.resolve_target("host-a").unwrap_err().code,
        "remote_ssh_disabled"
    );
    // 关闭总开关不删除主机，也不删除密码。
    assert!(harness.store.remote_ssh_target("host-a").is_some());
    assert!(context.credentials.save("host-a", "kept").is_ok());

    // 逐台停用同样阻止连接。
    harness.store.set_remote_ssh_enabled(true).unwrap();
    let mut stopped = target();
    stopped.enabled = false;
    harness.store.save_remote_ssh_target(stopped).unwrap();
    assert_eq!(
        context.resolve_target("host-a").unwrap_err().code,
        "target_unavailable"
    );
}

#[tokio::test]
async fn probe_reports_effective_config_peer_identity_and_agent_state() {
    let harness = Harness::new("ssh-probe");
    let digest = install_fake_agent(
        &harness,
        "#!/bin/sh\nprintf '{\"protocol\":2,\"os\":\"macos\",\"arch\":\"%s\",\"version\":\"0.3.40\"}\\n' \"$(uname -m)\"\n",
    );
    let credentials = FakeStore::default();
    let context = harness.context(&credentials);
    let probe = probe_target(&context, &target()).await.unwrap();

    assert_eq!(probe.target_id, "host-a");
    assert_eq!(probe.display_name, "构建机");
    assert_eq!(probe.effective_host, "10.9.0.4");
    assert_eq!(probe.peer_revision.len(), 64);
    assert_eq!(probe.peer_identity.len(), 64);
    assert_eq!(probe.config_revision.len(), 64);
    assert_eq!(probe.agent_digest.as_deref(), Some(digest.as_str()));
    assert!(probe.agent_installed);
    // 假组件按 uname 报告架构，探测侧归一化后应判定为兼容。
    assert!(probe.agent_compatible, "{probe:?}");
    assert_eq!(probe.agent_version.as_deref(), Some("0.3.40"));
}

#[tokio::test]
async fn trust_file_edits_change_the_peer_revision_but_renaming_does_not() {
    let harness = Harness::new("ssh-trust");
    let credentials = FakeStore::default();
    let context = harness.context(&credentials);
    let first = probe_target(&context, &target()).await.unwrap();

    // 仅改显示名：连接身份不变，探测得到的修订不变。
    let mut renamed = target();
    renamed.display_name = "构建机（改名）".into();
    let renamed = harness.store.save_remote_ssh_target(renamed).unwrap();
    assert_eq!(renamed.revision, 1, "改名不推进配置修订");
    let second = probe_target(&context, &renamed).await.unwrap();
    assert_eq!(first.peer_revision, second.peer_revision);

    // known_hosts 内容变化：必须重新确认，且对端身份不变（仍是同一台主机）。
    fs::write(
        harness.known_hosts(),
        "build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER\n",
    )
    .unwrap();
    let third = probe_target(&context, &renamed).await.unwrap();
    assert_ne!(second.peer_revision, third.peer_revision);
    assert_eq!(
        second.peer_identity, third.peer_identity,
        "对端主机密钥没变，身份不变"
    );
}

#[tokio::test]
async fn missing_host_key_diagnostic_fails_closed() {
    let harness = Harness::new("ssh-nohostkey");
    let ssh = harness.dir.path().join("ssh-nokey");
    write_script(
        &ssh,
        "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = \"-G\" ] && { cat \"$STUB_PROFILE\"; exit 0; }; done\nfor last; do :; done\nexec sh -c \"$last\"\n",
    );
    let context = Context {
        store: &harness.store,
        credentials: Box::new(FakeStore::default()),
        exec: SshExec {
            program: ssh,
            env: vec![
                (
                    "STUB_PROFILE".into(),
                    harness.dir.path().join("profile").display().to_string(),
                ),
                ("HOME".into(), harness.host_home.display().to_string()),
            ],
        },
        artifacts: harness.artifacts().to_path_buf(),
    };
    let error = probe_target(&context, &target()).await.unwrap_err();
    assert_eq!(error.code, "ssh_peer_unverified");
}

#[tokio::test]
async fn install_streams_the_signed_artifact_and_replaces_atomically() {
    let harness = Harness::new("ssh-install");
    let bytes = b"built-agent-bytes".to_vec();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    fs::create_dir_all(harness.artifacts().join("linux-x86_64")).unwrap();
    fs::write(
        harness.artifacts().join("linux-x86_64/twiglane-agent-v2"),
        &bytes,
    )
    .unwrap();
    let manifest = artifact::Manifest {
        format: 1,
        artifacts: vec![artifact::Entry {
            system: "Linux".into(),
            architecture: "x86_64".into(),
            version: "0.3.40".into(),
            file: "linux-x86_64/twiglane-agent-v2".into(),
            sha256: digest.clone(),
            signature: "c2lnbmF0dXJl".into(),
        }],
    };
    fs::write(
        harness.artifacts().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();

    let credentials = FakeStore::default();
    let context = harness.context(&credentials);
    let offer = InstallOffer {
        target_id: "host-a".into(),
        peer_revision: "f".repeat(64),
        digest: digest.clone(),
        version: "0.3.40".into(),
    };
    let sent = Arc::new(Mutex::new(0usize));
    let recorder = Arc::clone(&sent);
    let progress = Channel::new(move |_body| {
        *recorder.lock().unwrap() += 1;
        Ok(())
    });
    upload(&context, &target(), &offer, &progress)
        .await
        .unwrap();

    let installed = harness.agent_dir().join("twiglane-agent-v2");
    assert_eq!(fs::read(&installed).unwrap(), bytes);
    // 没有留下临时文件：rename 是原子的，不是"写一半再补"。
    let mut names: Vec<String> = fs::read_dir(harness.agent_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(names, vec!["twiglane-agent-v2".to_string()]);
    assert!(*sent.lock().unwrap() > 0, "进度至少上报一次");
}

#[tokio::test]
async fn a_mismatched_upload_never_replaces_the_existing_agent() {
    let harness = Harness::new("ssh-install-mismatch");
    let previous = install_fake_agent(&harness, "#!/bin/sh\nexit 0\n");
    assert_eq!(previous.len(), 64);
    let before = fs::read(harness.agent_dir().join("twiglane-agent-v2")).unwrap();

    // 远端脚本收到与预期摘要不同的字节时必须报错且不替换已有组件。
    let digest = format!("{:x}", Sha256::digest(b"expected-bytes"));
    let script = transport::install(&digest).unwrap();
    let output = harness.run_remote(&script, b"tampered-bytes");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("agent_digest_mismatch"),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        fs::read(harness.agent_dir().join("twiglane-agent-v2")).unwrap(),
        before,
        "摘要不符不得替换已有组件"
    );
}

#[tokio::test]
async fn password_auth_needs_a_saved_secret_and_then_uses_askpass_only() {
    let harness = Harness::new("ssh-password");
    let mut password_target = target();
    password_target.auth_method = "password".into();
    password_target.identity_file = None;
    harness
        .store
        .save_remote_ssh_target(password_target.clone())
        .unwrap();

    let empty = FakeStore::default();
    let context = harness.context(&empty);
    let snapshot = context.snapshot(&password_target).await.unwrap();
    let folder = Context::private_dir().unwrap();
    assert_eq!(
        context
            .build(&password_target, &snapshot, folder.path(), "true", false)
            .err()
            .unwrap()
            .code,
        "password_required"
    );

    let saved = FakeStore::with(&[("host-a", "hunter2")]);
    let context = harness.context(&saved);
    let command = context
        .build(&password_target, &snapshot, folder.path(), "true", false)
        .unwrap();
    let env: Vec<(String, String)> = command
        .as_std()
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().to_string(),
                value.unwrap_or_default().to_string_lossy().to_string(),
            )
        })
        .collect();
    assert!(env.iter().any(|(key, _)| key == "SSH_ASKPASS"));
    assert!(env.iter().any(|(key, _)| *key == password::SECRET_ENV));
    // askpass 绑定目标主机：跳板机的密码提示不会被目标主机的密码回答。
    assert!(env
        .iter()
        .any(|(key, value)| *key == password::HOST_ENV && value == "build.example.com"));
    let args: Vec<String> = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();
    assert!(!args.iter().any(|arg| arg == "BatchMode=yes"));
}

#[tokio::test]
async fn key_auth_never_falls_back_to_interactive_prompts() {
    let harness = Harness::new("ssh-key");
    let credentials = FakeStore::default();
    let context = harness.context(&credentials);
    let snapshot = context.snapshot(&target()).await.unwrap();
    let folder = Context::private_dir().unwrap();
    let command = context
        .build(&target(), &snapshot, folder.path(), "true", true)
        .unwrap();
    let args: Vec<String> = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();
    assert_eq!(args[0], "-v");
    assert!(args.iter().any(|arg| arg == "BatchMode=yes"));
    assert!(!command
        .as_std()
        .get_envs()
        .any(|(key, _)| key == "SSH_ASKPASS"));

    // 冻结配置只用私有副本中的信任文件，并强制校验主机密钥。
    let config = fs::read_to_string(folder.path().join("config")).unwrap();
    assert!(config.contains("StrictHostKeyChecking yes"));
    assert!(config.contains("UpdateHostKeys no"));
    assert!(!config.contains(&harness.known_hosts().display().to_string()));
    assert!(config.contains(&folder.path().join("trust-0").display().to_string()));
}

#[test]
fn fresh_and_legacy_state_read_ssh_as_disabled() {
    let dir = crate::test_support::TempDir::new("ssh-defaults");
    let store = AppStore::open(dir.path().join("state.json"));
    assert_eq!(store.snapshot().remote_ssh, RemoteSshSettings::default());
    assert!(!store.snapshot().remote_ssh.enabled);

    let mut value: serde_json::Value = serde_json::to_value(Persisted::default()).unwrap();
    assert!(value.get("remoteSsh").is_some());
    value.as_object_mut().unwrap().remove("remoteSsh");
    fs::write(
        dir.path().join("legacy.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let legacy = AppStore::open(dir.path().join("legacy.json"));
    assert!(legacy.settings_warning().is_none());
    assert!(!legacy.remote_ssh_enabled());
}
