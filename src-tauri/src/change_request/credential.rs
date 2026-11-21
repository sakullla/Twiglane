//! 按实例隔离的 Personal Access Token 存取。
//!
//! 令牌只进系统钥匙串：keyring 的 v1 能力在 macOS 用 Keychain Services、
//! Windows 用 Credential Manager、*nix 用 Secret Service。用户名由 provider 与
//! 规范化 API base 组成，因此同一 host 的不同 API 路径或不同平台互不覆盖。
//! 状态查询只返回布尔值，永不返回令牌；读不到条目不等于钥匙串故障。

use crate::error::AppError;

/// 钥匙串服务名。固定命名空间，不与 Git 凭据助手或其它应用混用。
pub const KEYRING_SERVICE: &str = "twiglane.change-request";

/// 远程 SSH 密码的独立命名空间。SSH 密码不复用 MR/PR 令牌条目，
/// 因此删除令牌不会断开已保存的 SSH 主机，反之亦然。
pub const REMOTE_SSH_SERVICE: &str = "twiglane.remote-ssh";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialFailure {
    /// store 初始化、解锁或读写失败。调用方据此提示，不转而打开网页。
    Unavailable,
}

impl CredentialFailure {
    pub fn into_error(self) -> AppError {
        AppError::new(
            "change_request_credential_store",
            "系统钥匙串不可用，未读取或保存令牌，也没有打开网页。请检查系统凭据设施后重试。",
        )
    }
}

/// 令牌存取边界。测试用 fake 覆盖条目隔离、缺失和读写失败；
/// 真实实现是系统钥匙串，跨平台可用性由实机验证，不用 fake 代替结论。
pub trait CredentialStore: Send + Sync {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialFailure>;
    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialFailure>;
    fn delete(&self, key: &str) -> Result<(), CredentialFailure>;
}

/// keyring v1 的系统钥匙串实现。条目不存在时返回 Ok(None)，
/// 只有真正的 store 失败才返回 Unavailable。`service` 固定为编译期常量，
/// 调用方不能把任意命名空间传进来。
pub struct KeyringStore {
    service: &'static str,
}

impl KeyringStore {
    /// MR / PR 令牌条目。
    pub fn new() -> Self {
        Self {
            service: KEYRING_SERVICE,
        }
    }

    /// 远程 SSH 密码条目，与令牌命名空间互不可见。
    pub fn remote_ssh() -> Self {
        Self {
            service: REMOTE_SSH_SERVICE,
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, CredentialFailure> {
        keyring::Entry::new(self.service, key).map_err(|_| CredentialFailure::Unavailable)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialFailure> {
        let entry = self.entry(key)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialFailure::Unavailable),
        }
    }

    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialFailure> {
        self.entry(key)?
            .set_password(secret)
            .map_err(|_| CredentialFailure::Unavailable)
    }

    fn delete(&self, key: &str) -> Result<(), CredentialFailure> {
        let entry = self.entry(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialFailure::Unavailable),
        }
    }
}

/// SSH 密码在进入钥匙串前的形态校验：只拒绝空值、控制字符与超长输入。
/// 不做 trim，也不校验字符集——密码就是用户输入的原样字节。
pub(crate) fn validate_ssh_password(password: &str) -> Result<(), AppError> {
    if password.is_empty()
        || password.len() > 4096
        || password.contains('\0')
        || password.chars().any(|value| value.is_control() && value != '\t')
    {
        return Err(AppError::new(
            "ssh_password_invalid",
            "SSH 密码不能为空、不能包含控制字符，且长度不超过 4096。未保存任何内容。",
        ));
    }
    Ok(())
}

/// 用户输入的令牌在进入钥匙串前的形态校验。不做 trim，避免悄悄改动令牌；
/// 只拒绝空值和不可能出现在认证头里的字符。
pub(crate) fn validate_token_input(token: &str) -> Result<(), AppError> {
    if token.is_empty()
        || token.len() > 4096
        || token
            .chars()
            .any(|value| value.is_control() || value.is_whitespace() || !value.is_ascii())
    {
        return Err(AppError::new(
            "change_request_token_invalid",
            "令牌不能为空、不能包含空白或非 ASCII 字符，且长度不超过 4096。未保存任何内容。",
        ));
    }
    Ok(())
}
