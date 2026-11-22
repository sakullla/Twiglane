//! 固定的 POSIX sh 和 Windows PowerShell 远端命令。标准输入专用于产物或协议字节。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Shell {
    Posix,
    Windows,
}

pub(crate) const READY: &[u8] = b"twiglane-ready\n";
pub(crate) const CONTINUE: &[u8] = b"T\n";

const WINDOWS_COMMON: &str = include_str!("windows-agent.ps1");
const WINDOWS_PROBE: &str = include_str!("windows-probe.ps1");
const WINDOWS_INSTALL: &str = include_str!("windows-install.ps1");
const WINDOWS_CONNECT: &str = include_str!("windows-connect.ps1");
const WINDOWS_GATE: &str = r#"
    [Console]::Write("twiglane-ready`n")
    $gate = [Console]::OpenStandardInput()
    if ($gate.ReadByte() -ne 84 -or $gate.ReadByte() -ne 10) { exit 7 }
"#;
const POSIX_GATE: &str =
    "printf 'twiglane-ready\\n'; IFS= read -r gate && [ \"$gate\" = T ] || exit 7; ";

fn windows_command(script: &str, digest: Option<&str>, gated: bool) -> String {
    let mut command = String::new();
    if let Some(digest) = digest {
        command.push_str("$digest='");
        command.push_str(digest);
        command.push_str("'\n");
    }
    let gate = if gated { WINDOWS_GATE } else { "" };
    for line in gate
        .lines()
        .chain(WINDOWS_COMMON.lines())
        .chain(script.lines())
    {
        let line = line.trim();
        if !line.is_empty() && !line.starts_with('#') {
            command.push_str(line);
            command.push('\n');
        }
    }
    let encoded = STANDARD.encode(
        command
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}

impl Shell {
    pub(crate) fn probe(self) -> String {
        match self {
            Self::Posix => probe(),
            Self::Windows => windows_command(WINDOWS_PROBE, None, false),
        }
    }

    pub(crate) fn install(self, digest: &str, gated: bool) -> Result<String, AppError> {
        match self {
            Self::Posix => install(digest).map(|cmd| {
                if gated { format!("{POSIX_GATE}{cmd}") } else { cmd }
            }),
            Self::Windows => Ok(windows_command(WINDOWS_INSTALL, Some(checked_hex(digest)?), gated)),
        }
    }

    pub(crate) fn connect(self, digest: &str, gated: bool) -> Result<String, AppError> {
        match self {
            Self::Posix => connect(digest).map(|cmd| {
                if gated { format!("{POSIX_GATE}{cmd}") } else { cmd }
            }),
            Self::Windows => Ok(windows_command(WINDOWS_CONNECT, Some(checked_hex(digest)?), gated)),
        }
    }
}

fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn checked_hex(value: &str) -> Result<&str, AppError> {
    if hex(value) {
        return Ok(value);
    }
    Err(AppError::new(
        "agent_digest_mismatch",
        "远端组件的摘要格式无效，未安装。",
    ))
}

/// 探测目标系统/架构、Git、已安装组件与组件自述。只读：不创建目录，不写文件。
pub(crate) fn probe() -> String {
    [
        "d=\"$HOME/.local/share/twiglane/agent/v2\"",
        "printf 'system=%s\\n' \"$(uname -s 2>/dev/null)\"",
        "printf 'architecture=%s\\n' \"$(uname -m 2>/dev/null)\"",
        "printf 'git=%s\\n' \"$(git --version 2>/dev/null | head -n 1)\"",
        "if [ -f \"$d/twiglane-agent-v2\" ]; then :",
        "printf 'agent=present\\n'",
        "if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum \"$d/twiglane-agent-v2\" | cut -d\" \" -f1); else got=$(shasum -a 256 \"$d/twiglane-agent-v2\" | cut -d\" \" -f1); fi",
        "printf 'digest=%s\\n' \"$got\"",
        "printf 'probe=%s\\n' \"$(\"$d/twiglane-agent-v2\" --probe 2>/dev/null | head -c 65536 | tr '\\n' ' ')\"",
        "else printf 'agent=missing\\n'; fi",
    ]
    .join("; ")
}

/// 安装：写临时文件、核对摘要、原子 rename。摘要不符或上传不完整时保留原组件。
pub(crate) fn install(digest: &str) -> Result<String, AppError> {
    let digest = checked_hex(digest)?;
    Ok([
        "set -e".to_string(),
        "d=\"$HOME/.local/share/twiglane/agent/v2\"".to_string(),
        "umask 077".to_string(),
        "mkdir -p \"$d\"".to_string(),
        "p=$(ls -ld \"$d\" | cut -c1-10)".to_string(),
        "if [ \"$(printf %s \"$p\" | cut -c9)\" = w ] || [ \"$(printf %s \"$p\" | cut -c6)\" = w ]; then printf '{\"error\":\"unsafe_install_directory\"}\\n'; exit 3; fi".to_string(),
        "t=\"$d/.incoming.$$\"".to_string(),
        "trap 'rm -f \"$t\"' EXIT HUP INT TERM".to_string(),
        "cat > \"$t\"".to_string(),
        "chmod 700 \"$t\"".to_string(),
        "if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum \"$t\" | cut -d\" \" -f1); else got=$(shasum -a 256 \"$t\" | cut -d\" \" -f1); fi".to_string(),
        format!("if [ \"$got\" != \"{digest}\" ]; then printf '{{\"error\":\"agent_digest_mismatch\"}}\\n'; exit 4; fi"),
        "mv -f \"$t\" \"$d/twiglane-agent-v2\"".to_string(),
        "trap - EXIT HUP INT TERM".to_string(),
        "printf '{\"installed\":true,\"agentSha256\":\"%s\"}\\n' \"$got\"".to_string(),
    ]
    .join("; "))
}

/// 会话：核对已安装文件摘要后再 exec，标准输入输出此后专属于 agent 协议。
/// 远端仓库会话（`remote_ssh::open_session`）与这里共用同一条命令串，不另写一份。
pub(crate) fn connect(digest: &str) -> Result<String, AppError> {
    let digest = checked_hex(digest)?;
    Ok([
        "set -e".to_string(),
        "d=\"$HOME/.local/share/twiglane/agent/v2\"".to_string(),
        "f=\"$d/twiglane-agent-v2\"".to_string(),
        "if [ ! -x \"$f\" ]; then printf '{\"error\":\"agent_missing\"}\\n' >&2; exit 5; fi".to_string(),
        "if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum \"$f\" | cut -d\" \" -f1); else got=$(shasum -a 256 \"$f\" | cut -d\" \" -f1); fi".to_string(),
        format!("if [ \"$got\" != \"{digest}\" ]; then printf '{{\"error\":\"agent_digest_mismatch\"}}\\n' >&2; exit 6; fi"),
        "exec \"$f\" --stdio".to_string(),
    ]
    .join("; "))
}

/// 一次探测的机器可读结果。
#[derive(Debug, Default, Clone)]
pub(crate) struct ProbeFields {
    pub(crate) system: String,
    pub(crate) architecture: String,
    pub(crate) git: Option<String>,
    pub(crate) digest: Option<String>,
    pub(crate) agent: Option<serde_json::Value>,
}

impl ProbeFields {
    pub(crate) fn parse(stdout: &str) -> Result<Self, AppError> {
        let mut fields = ProbeFields::default();
        for line in stdout.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key {
                "system" => fields.system = value.trim().to_string(),
                "architecture" => fields.architecture = value.trim().to_string(),
                "git" => fields.git = Some(value.trim().to_string()),
                "digest" if hex(value.trim()) => fields.digest = Some(value.trim().to_string()),
                "probe" if !value.trim().is_empty() => {
                    fields.agent = serde_json::from_str(value.trim()).ok()
                }
                _ => {}
            }
        }
        if fields.system.is_empty() || fields.architecture.is_empty() {
            return Err(AppError::new(
                "remote_unsupported",
                "无法识别远端系统与架构（探测命令未返回预期结果）。",
            ));
        }
        Ok(fields)
    }
}

/// 从 `ssh -v` 的诊断输出里取实际对端主机密钥。OpenSSH 仍按冻结的 known_hosts 校验，
/// 这里只记录它实际使用了哪把密钥，用于绑定持久身份。
pub(crate) fn host_keys(stderr: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("debug1: Server host key: ") else {
            continue;
        };
        let key = rest.trim();
        if !key.is_empty() && !keys.iter().any(|seen| seen == key) {
            keys.push(key.to_string());
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_commands_reject_anything_but_a_lowercase_digest() {
        assert_eq!(
            install(&"A".repeat(64)).unwrap_err().code,
            "agent_digest_mismatch"
        );
        assert_eq!(install("abc").unwrap_err().code, "agent_digest_mismatch");
        assert!(install(&"a".repeat(64)).is_ok());
        assert!(connect(&"0".repeat(64)).is_ok());
    }

    #[test]
    fn probe_is_read_only_and_never_creates_directories() {
        let script = probe();
        assert!(!script.contains("mkdir"));
        assert!(script.contains("agent/v2"));
    }

    #[test]
    fn parses_probe_fields_and_host_keys() {
        let fields = ProbeFields::parse(
            "system=Linux\narchitecture=x86_64\ngit=git version 2.45.0\nagent=present\ndigest=abc\nprobe={\"protocol\":2}\n",
        )
        .unwrap();
        assert_eq!(fields.system, "Linux");
        assert_eq!(fields.architecture, "x86_64");
        assert_eq!(fields.git.as_deref(), Some("git version 2.45.0"));
        assert!(fields.digest.is_none(), "非法摘要不能当成已安装组件");
        assert_eq!(fields.agent.unwrap()["protocol"], 2);

        let keys = host_keys(
            "debug1: Server host key: ssh-ed25519 SHA256:aaa\n\
             debug1: Server host key: ssh-ed25519 SHA256:aaa\n\
             debug1: Server host key: rsa-sha2-256 SHA256:bbb\n",
        );
        assert_eq!(keys.len(), 2);
        assert!(crate::remote_ssh::config::Snapshot::peer_identity(&keys).is_some());
    }

    #[test]
    fn missing_uname_output_is_not_guessed() {
        assert_eq!(
            ProbeFields::parse("git=git version 2").unwrap_err().code,
            "remote_unsupported"
        );
    }

    #[test]
    fn windows_commands_fit_the_default_cmd_shell_and_validate_digest_arguments() {
        let digest = "a".repeat(64);
        assert!(Shell::Windows.install("not a digest", true).is_err());
        assert!(Shell::Windows.connect("not a digest", true).is_err());
        for command in [
            Shell::Windows.probe(),
            Shell::Windows.install(&digest, true).unwrap(),
            Shell::Windows.connect(&digest, true).unwrap(),
        ] {
            // cmd.exe 的总限制为 8191 字符，还需留出 OpenSSH 的 shell 参数。
            assert!(command.len() < 8150, "command length: {}", command.len());
            assert!(command.is_ascii());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_default_shell_installs_exact_bytes_and_preserves_the_old_digest() {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        let directory = tempfile::Builder::new()
            .prefix("Twiglane remote 组件 ")
            .tempdir_in(std::env::var_os("LOCALAPPDATA").unwrap())
            .unwrap();
        let run = |command: &str, input: &[u8]| {
            let mut child = Command::new("cmd.exe")
                .args(["/D", "/C"])
                .raw_arg(command)
                .env("LOCALAPPDATA", directory.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(input).unwrap();
            child.wait_with_output().unwrap()
        };
        let output = run(&Shell::Windows.probe(), b"");
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            ProbeFields::parse(&String::from_utf8(output.stdout).unwrap())
                .unwrap()
                .system,
            "Windows"
        );
        let agent_dir = directory.path().join("Twiglane/agent/v2");
        assert!(!agent_dir.exists(), "探测不能创建安装目录");

        let mut bytes = (0..=u8::MAX).cycle().take(201_537).collect::<Vec<_>>();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let install = Shell::Windows.install(&digest, true).unwrap();
        let output = run(&install, &[CONTINUE, bytes.as_slice()].concat());
        assert!(output.status.success(), "{output:?}");
        assert!(output.stdout.starts_with(READY), "{output:?}");
        let old = agent_dir.join(format!("twiglane-agent-v2-{digest}.exe"));
        let pointer = agent_dir.join("current.sha256");
        assert_eq!(std::fs::read(&old).unwrap(), bytes);
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), digest);

        let output = run(&install, b"T\nshort upload");
        assert!(!output.status.success(), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("agent_digest_mismatch"));
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), digest);
        assert_eq!(std::fs::read(&old).unwrap(), bytes);

        bytes.push(42);
        let next = format!("{:x}", Sha256::digest(&bytes));
        let install = Shell::Windows.install(&next, true).unwrap();
        let output = run(&install, &[CONTINUE, bytes.as_slice()].concat());
        assert!(output.status.success(), "{output:?}");
        assert!(old.is_file(), "升级为不同摘要时不改写旧组件");
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), next);
        assert_eq!(
            std::fs::read(agent_dir.join(format!("twiglane-agent-v2-{next}.exe"))).unwrap(),
            bytes
        );
        assert_eq!(agent_dir.read_dir().unwrap().count(), 3);
    }
}
