//! 远端命令：一条 POSIX sh 命令串，不拼接任何用户输入（只有校验过的十六进制摘要）。
//!
//! 不用 `sh -s` + 脚本管道，因为安装要从标准输入读产物；把脚本写成单条命令串后，
//! 标准输入可以专用于产物字节，远端 shell 也只解析一次。

use crate::error::AppError;

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
                "无法识别远端系统与架构（uname 未返回预期结果）。",
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
        let Some(rest) = line.split_once("Server host key: ") else {
            continue;
        };
        let key = rest.1.trim();
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
}
