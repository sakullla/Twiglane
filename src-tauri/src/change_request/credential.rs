//! 按实例隔离的 Personal Access Token 存取。
//!
//! 令牌只进系统钥匙串：keyring 的 v1 能力在 macOS 用 Keychain Services、
//! Windows 用 Credential Manager、*nix 用 Secret Service。用户名由 provider 与
//! 规范化 API base 组成，因此同一 host 的不同 API 路径或不同平台互不覆盖。
//! 状态查询只返回布尔值，永不返回令牌；读不到条目不等于钥匙串故障。

use crate::error::AppError;

/// 钥匙串服务名。固定命名空间，不与 Git 凭据助手或其它应用混用。
pub const KEYRING_SERVICE: &str = "twiglane.change-request";

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
/// 只有真正的 store 失败才返回 Unavailable。
pub struct KeyringStore;

impl KeyringStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(key: &str) -> Result<keyring::Entry, CredentialFailure> {
        keyring::Entry::new(KEYRING_SERVICE, key).map_err(|_| CredentialFailure::Unavailable)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialFailure> {
        let entry = Self::entry(key)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialFailure::Unavailable),
        }
    }

    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialFailure> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| CredentialFailure::Unavailable)
    }

    fn delete(&self, key: &str) -> Result<(), CredentialFailure> {
        let entry = Self::entry(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialFailure::Unavailable),
        }
    }
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
