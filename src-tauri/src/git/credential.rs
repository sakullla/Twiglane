//! HTTP(S) 克隆的用户名 / 密码（或访问令牌）认证。
//!
//! 约束：
//! - 凭据只经由环境变量（`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`）
//!   以一次性的 `http.<origin>.extraHeader` 交给这一个 Git 进程：不进命令行参数，不写入仓库配置，
//!   不进最近列表或应用数据，错误信息里也不会出现；
//! - 认证头只对同一个协议 + 主机（含端口）生效，跳转到其他主机时不会带上；
//! - 用户选择「记住」时，克隆成功后用 `git credential approve` 交给用户已配置的凭据助手保存，
//!   之后的拉取、推送照常走凭据助手；没有配置凭据助手时不保存，并如实说明；
//! - 用户名和密码不得含换行或 NUL，避免拼进凭据协议时被解释成额外字段。

use std::ffi::OsString;

use base64::Engine;
use serde::Deserialize;

use crate::error::AppError;

const MAX_FIELD: usize = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpCredential {
    pub username: String,
    pub password: String,
    /// 克隆成功后交给系统凭据助手保存。
    #[serde(default)]
    pub remember: bool,
}

/// `https://host[:port]/…` 的协议与主机；带用户信息或不是 HTTP(S) 时为空。
pub fn http_origin(url: &str) -> Option<(&'static str, String)> {
    let (protocol, rest) = if let Some(rest) = url.strip_prefix("https://") {
        ("https", rest)
    } else {
        ("http", url.strip_prefix("http://")?)
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains('@') || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    Some((protocol, host.to_ascii_lowercase()))
}

pub fn validate_credential(credential: &HttpCredential) -> Result<(), AppError> {
    let bad = |text: &str| {
        text.len() > MAX_FIELD || text.chars().any(|c| c == '\n' || c == '\r' || c == '\0')
    };
    if credential.username.trim().is_empty() || credential.password.is_empty() {
        return Err(AppError::new("credential_invalid", "请填写用户名和密码（或访问令牌）。"));
    }
    if bad(&credential.username) || bad(&credential.password) {
        return Err(AppError::new(
            "credential_invalid",
            "用户名或密码包含换行等不支持的字符，未发起克隆。",
        ));
    }
    Ok(())
}

/// 这一次 Git 进程用的认证环境变量。
pub fn auth_env(url: &str, credential: &HttpCredential) -> Result<Vec<(OsString, OsString)>, AppError> {
    validate_credential(credential)?;
    let (protocol, host) = http_origin(url).ok_or_else(|| {
        AppError::new(
            "credential_scheme",
            "只有 HTTP(S) 地址可以用用户名和密码认证；SSH 地址请使用 SSH agent。",
        )
    })?;
    let token = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", credential.username.trim(), credential.password));
    Ok(vec![
        (OsString::from("GIT_CONFIG_COUNT"), OsString::from("1")),
        (
            OsString::from("GIT_CONFIG_KEY_0"),
            OsString::from(format!("http.{protocol}://{host}/.extraHeader")),
        ),
        (
            OsString::from("GIT_CONFIG_VALUE_0"),
            OsString::from(format!("Authorization: Basic {token}")),
        ),
    ])
}

/// `git credential approve` 的标准输入。
pub fn approve_input(url: &str, credential: &HttpCredential) -> Option<Vec<u8>> {
    let (protocol, host) = http_origin(url)?;
    validate_credential(credential).ok()?;
    Some(
        format!(
            "protocol={protocol}\nhost={host}\nusername={}\npassword={}\n\n",
            credential.username.trim(),
            credential.password
        )
        .into_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential(username: &str, password: &str) -> HttpCredential {
        HttpCredential { username: username.into(), password: password.into(), remember: false }
    }

    #[test]
    fn origin_is_scheme_and_host_only() {
        assert_eq!(http_origin("http://git.Example.com/group/app.git"), Some(("http", "git.example.com".into())));
        assert_eq!(http_origin("https://git.example.com:8443/a.git"), Some(("https", "git.example.com:8443".into())));
        assert_eq!(http_origin("https://user@git.example.com/a.git"), None);
        assert_eq!(http_origin("git@git.example.com:a.git"), None);
        assert_eq!(http_origin("ssh://git.example.com/a.git"), None);
        assert_eq!(http_origin("https:///a.git"), None);
    }

    #[test]
    fn env_scopes_header_to_the_origin_and_never_touches_args() {
        let env = auth_env("https://git.example.com/g/a.git", &credential(" alice ", "p@ss:word")).unwrap();
        assert_eq!(env[0], (OsString::from("GIT_CONFIG_COUNT"), OsString::from("1")));
        assert_eq!(env[1].1, OsString::from("http.https://git.example.com/.extraHeader"));
        let expected = base64::engine::general_purpose::STANDARD.encode("alice:p@ss:word");
        assert_eq!(env[2].1, OsString::from(format!("Authorization: Basic {expected}")));
    }

    #[test]
    fn rejects_empty_multiline_and_non_http() {
        assert_eq!(auth_env("https://h/a", &credential("", "x")).unwrap_err().code, "credential_invalid");
        assert_eq!(auth_env("https://h/a", &credential("a", "")).unwrap_err().code, "credential_invalid");
        assert_eq!(auth_env("https://h/a", &credential("a", "x\nhost=evil")).unwrap_err().code, "credential_invalid");
        assert_eq!(auth_env("git@h:a.git", &credential("a", "x")).unwrap_err().code, "credential_scheme");
        assert!(approve_input("https://h/a", &credential("a\nb", "x")).is_none());
    }

    #[test]
    fn approve_input_is_one_credential_block() {
        let input = String::from_utf8(approve_input("http://h:8080/a.git", &credential("bob", "tok")).unwrap()).unwrap();
        assert_eq!(input, "protocol=http\nhost=h:8080\nusername=bob\npassword=tok\n\n");
    }
}
