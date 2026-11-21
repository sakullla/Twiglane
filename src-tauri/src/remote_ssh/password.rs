//! 只回答绑定目标的密码/口令提示的 askpass 助手。
//!
//! OpenSSH 在没有终端时才调用 `SSH_ASKPASS`（`-T` 已关闭终端分配）。
//! 这里生成的脚本只做一件事：提示既出现 password/passphrase、又出现目标主机名时
//! 输出保存在私有目录的秘密，其余提示（尤其是主机密钥 `(yes/no)` 与 `fingerprint`、
//! 以及 ProxyJump 跳板机的 `user@jump` 密码提示）一律退出 1，因此 Twiglane 既不会
//! 替用户接受一台新主机的密钥，也不会把目标主机的密码交给跳板机。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 秘密文件的路径通过环境变量传给脚本，不写进任何命令行参数。
pub(crate) const SECRET_ENV: &str = "TWIGLANE_SSH_ASKPASS_SECRET";

/// 目标主机名也经环境变量传入：只有提示里出现它（或 `user@host`）才作答。
pub(crate) const HOST_ENV: &str = "TWIGLANE_SSH_ASKPASS_HOST";

const SCRIPT: &str = r#"#!/bin/sh
prompt=$1
host=$TWIGLANE_SSH_ASKPASS_HOST
# 没有绑定目标主机就不作答，任何提示都不该拿到这个秘密。
[ -n "$host" ] || exit 1
case "$prompt" in
  *[Pp]assword*|*passphrase*|*Passphrase*) ;;
  *) exit 1 ;;
esac
# 只有目标主机（含 user@host 形式）的提示才作答。ProxyJump 跳板机的提示
# （例如 deploy@jump.example.com's password:）里没有目标主机名，一律拒绝。
case "$prompt" in
  *"$host"*) ;;
  *) exit 1 ;;
esac
case "$prompt" in
  *authenticity*|*fingerprint*|*"yes/no"*|*"continue connecting"*) exit 1 ;;
esac
exec cat "$TWIGLANE_SSH_ASKPASS_SECRET"
"#;

pub(crate) struct Askpass {
    pub(crate) script: PathBuf,
    pub(crate) secret: PathBuf,
}

fn unavailable() -> AppError {
    AppError::new(
        "ssh_askpass_unavailable",
        "当前平台无法为 SSH 提供密码提示助手，请改用密钥或 ssh-agent 认证。",
    )
}

/// 在本次连接的私有目录里写入脚本与秘密文件：脚本 0700、秘密 0600，随目录一起删除。
pub(crate) fn install(dir: &Path, password: &str) -> Result<Askpass, AppError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let script = dir.join("askpass.sh");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&script)
            .map_err(|_| unavailable())?;
        file.write_all(SCRIPT.as_bytes())
            .map_err(|_| unavailable())?;
        drop(file);
        let secret = dir.join("askpass-secret");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&secret)
            .map_err(|_| unavailable())?;
        file.write_all(password.as_bytes())
            .map_err(|_| unavailable())?;
        // 提示的答案通常要换行；文件末尾补一个换行不影响密码内容。
        file.write_all(b"\n").map_err(|_| unavailable())?;
        drop(file);
        Ok(Askpass { script, secret })
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, password);
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(script: &Path, prompt: &str, secret: &Path, host: &str) -> std::process::Output {
        std::process::Command::new("/bin/sh")
            .arg(script)
            .arg(prompt)
            .env(SECRET_ENV, secret)
            .env(HOST_ENV, host)
            .output()
            .expect("askpass script runs")
    }

    #[test]
    fn answers_only_prompts_naming_the_bound_host() {
        let dir = tempfile::tempdir().unwrap();
        let askpass = install(dir.path(), "s3cret").unwrap();
        let host = "build.example.com";

        // 目标主机（user@host 形式也含主机名）的密码提示才作答。
        for prompt in [
            format!("deploy@{host}'s password: "),
            format!("{host}'s password: "),
        ] {
            let answered = answer(&askpass.script, &prompt, &askpass.secret, host);
            assert!(answered.status.success(), "{prompt}");
            assert_eq!(String::from_utf8_lossy(&answered.stdout), "s3cret\n");
        }

        // 跳板机（ProxyJump）的提示里没有目标主机，不得用目标主机的密码作答。
        for prompt in [
            "deploy@jump.example.com's password: ",
            "root@10.0.0.1's password: ",
        ] {
            let refused = answer(&askpass.script, prompt, &askpass.secret, host);
            assert_eq!(refused.status.code(), Some(1), "{prompt}");
            assert!(refused.stdout.is_empty(), "{prompt}");
        }

        // 没有绑定主机名时不作答，哪怕提示本身是目标主机的密码提示。
        let unbound = answer(
            &askpass.script,
            &format!("deploy@{host}'s password: "),
            &askpass.secret,
            "",
        );
        assert_eq!(unbound.status.code(), Some(1));
        assert!(unbound.stdout.is_empty());

        // 主机密钥问题绝不代答，否则等于替用户信任新主机。
        for prompt in [
            format!("The authenticity of host '{host} (10.0.0.1)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "),
            format!("Are you sure you want to continue connecting to {host} (yes/no)? "),
        ] {
            let refused = answer(&askpass.script, &prompt, &askpass.secret, host);
            assert_eq!(refused.status.code(), Some(1), "{prompt}");
            assert!(refused.stdout.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn secret_file_is_private_and_removed_with_the_directory() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("session");
        fs::create_dir(&inner).unwrap();
        let askpass = install(&inner, "hunter2").unwrap();
        let mode = fs::metadata(&askpass.secret).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let mode = fs::metadata(&askpass.script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        drop(dir);
        assert!(!inner.exists());
    }
}
