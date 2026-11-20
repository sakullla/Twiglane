//! 创建 MR/PR 的中立原生边界。
//!
//! 平台差异留在 provider 适配器，凭据只在系统钥匙串，网页回退只在适配器明确
//! 证明能力不支持时发生。这里不接收前端传入的 owner/repo/API base 作为事实，
//! 也不调用任何 Git 写命令：准备阶段只读当前分支、远程和远程跟踪引用。
//!
//! 关闭开关时所有命令在读钥匙串、探测远程或发平台请求之前就返回。

mod credential;
mod http;
mod provider;
mod remote;
mod web;

#[cfg(test)]
mod tests;

use serde::Serialize;

use crate::error::AppError;
use crate::git::ops::{self, Backend};
use crate::git::schedule::internal_request_id;
use crate::git::sync;
use crate::model::RemoteInfo;

pub use credential::{CredentialStore, KeyringStore};
pub use http::Http;
pub use web::WebOpener;

use provider::CreateAttempt;
use remote::Repository;

/// 多远程时的候选。选择前不会向任何候选实例发起平台请求。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequestRemoteChoice {
    pub remote: String,
    pub host: String,
    pub repository: String,
    pub provider: Option<String>,
}

/// prepare 结果。status 为 ready 时其余字段可用；为 remoteChoice 时
/// choices 非空，且没有向任何实例发过平台请求。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequestPrepare {
    pub status: String,
    pub choices: Vec<ChangeRequestRemoteChoice>,
    pub provider: String,
    pub provider_label: String,
    pub remote: String,
    pub host: String,
    pub repository: String,
    pub repository_web: String,
    pub source_branch: String,
    pub target_branch: String,
    pub default_branch: Option<String>,
    pub generation: u64,
}

/// 令牌状态只有布尔值，永不返回令牌本身。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequestTokenStatus {
    pub configured: bool,
}

/// 创建结果：created 是平台返回并已验证的链接；fallbackOpened 明确需要在网页继续。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequestOutcome {
    pub status: String,
    pub url: String,
    pub provider: String,
    pub provider_label: String,
    pub repository: String,
    pub source_branch: String,
    pub target_branch: String,
    pub web_prefilled: bool,
}

/// 创建输入。来源分支永远由当前仓库重新推导，不接受前端指定。
pub struct CreateInput {
    pub path: String,
    pub remote: Option<String>,
    pub target_branch: String,
    pub title: String,
    pub body: String,
}

/// 内部决定：直接创建成功，或需要原生打开网页。
#[derive(Debug)]
pub enum CreateDecision {
    Created(ChangeRequestOutcome),
    Fallback(FallbackPending),
}

#[derive(Debug)]
pub struct FallbackPending {
    pub url: String,
    pub web_prefilled: bool,
    pub provider: String,
    pub provider_label: String,
    pub repository: String,
    pub source_branch: String,
    pub target_branch: String,
}

enum RemoteSelection {
    Choice(Vec<ChangeRequestRemoteChoice>),
    Ready {
        remote: String,
        source: String,
        generation: u64,
    },
}

// ---------------------------------------------------------------- prepare

pub async fn prepare(
    backend: &Backend,
    path: &str,
    remote: Option<&str>,
    generation: u64,
    request_id: u64,
) -> Result<ChangeRequestPrepare, AppError> {
    let http = Http::default_app()?;
    prepare_with(backend, path, remote, generation, request_id, &http).await
}

pub(crate) async fn prepare_with(
    backend: &Backend,
    path: &str,
    requested: Option<&str>,
    generation: u64,
    request_id: u64,
    http: &Http,
) -> Result<ChangeRequestPrepare, AppError> {
    ops::require_change_requests(backend)?;
    let state = sync::change_request_git_state(backend, path, generation, request_id).await?;
    current_branch(&state)?;
    match select_remote(backend, path, &state, requested).await? {
        RemoteSelection::Choice(choices) => Ok(empty_prepare("remoteChoice", choices, state.generation)),
        RemoteSelection::Ready {
            remote,
            source,
            generation,
        } => {
            let url = remote_url(&state, &remote)?;
            let repo = remote::resolve_repository(http, &url).await?;
            Ok(ChangeRequestPrepare {
                status: "ready".to_string(),
                choices: Vec::new(),
                provider: repo.provider.key().to_string(),
                provider_label: repo.provider.label().to_string(),
                remote,
                host: repo.host.clone(),
                repository: repo.full_path(),
                repository_web: repo.web_url(),
                source_branch: source,
                // 本地默认分支只作表单预选，不冒充平台事实。
                target_branch: state.default_branch.clone().unwrap_or_default(),
                default_branch: state.default_branch.clone(),
                generation,
            })
        }
    }
}

fn empty_prepare(
    status: &str,
    choices: Vec<ChangeRequestRemoteChoice>,
    generation: u64,
) -> ChangeRequestPrepare {
    ChangeRequestPrepare {
        status: status.to_string(),
        choices,
        provider: String::new(),
        provider_label: String::new(),
        remote: String::new(),
        host: String::new(),
        repository: String::new(),
        repository_web: String::new(),
        source_branch: String::new(),
        target_branch: String::new(),
        default_branch: None,
        generation,
    }
}

// ---------------------------------------------------------------- create

pub async fn create(
    backend: &Backend,
    input: CreateInput,
    generation: u64,
    request_id: u64,
    opener: &dyn WebOpener,
) -> Result<ChangeRequestOutcome, AppError> {
    let http = Http::default_app()?;
    let store = KeyringStore::new();
    match create_with(backend, input, generation, request_id, &http, &store).await? {
        CreateDecision::Created(outcome) => Ok(outcome),
        CreateDecision::Fallback(pending) => complete_fallback(opener, pending),
    }
}

pub(crate) async fn create_with(
    backend: &Backend,
    input: CreateInput,
    generation: u64,
    request_id: u64,
    http: &Http,
    store: &dyn CredentialStore,
) -> Result<CreateDecision, AppError> {
    // 门禁在读令牌、探测平台之前：关闭时不读钥匙串、不发平台请求。
    ops::require_change_requests(backend)?;
    let title = validate_title(&input.title)?;
    let target = validate_target(&input.target_branch)?;
    validate_body(&input.body)?;

    let state =
        sync::change_request_git_state(backend, &input.path, generation, request_id).await?;
    current_branch(&state)?;
    let selection = select_remote(backend, &input.path, &state, input.remote.as_deref()).await?;
    let (remote, source, _generation) = match selection {
        RemoteSelection::Ready {
            remote,
            source,
            generation,
        } => (remote, source, generation),
        RemoteSelection::Choice(choices) => {
            let names = choices
                .iter()
                .map(|choice| choice.remote.clone())
                .collect::<Vec<_>>()
                .join("、");
            return Err(AppError::new(
                "change_request_remote_choice",
                format!("有多个远程，无法确定创建目标（{names}）。请先选择远程。"),
            ));
        }
    };

    let url = remote_url(&state, &remote)?;
    let repo = remote::resolve_repository(http, &url).await?;
    ensure_secure_channel(&repo)?;

    let token = match store.load(&repo.token_key()) {
        Ok(Some(token)) => token,
        Ok(None) => return Err(token_missing(&repo)),
        Err(failure) => return Err(failure.into_error()),
    };
    let meta = provider::fetch_repository_meta(http, &repo, &token).await?;
    let page = provider::create(
        http,
        &repo,
        &token,
        &source,
        &target,
        &title,
        &input.body,
    )
    .await?;
    match page {
        CreateAttempt::Created(link) => Ok(CreateDecision::Created(ChangeRequestOutcome {
            status: "created".to_string(),
            url: link,
            provider: repo.provider.key().to_string(),
            provider_label: repo.provider.label().to_string(),
            repository: repo.full_path(),
            source_branch: source,
            target_branch: target,
            web_prefilled: false,
        })),
        CreateAttempt::Unsupported => {
            let page = web::fallback_page(
                repo.provider,
                &meta.web_url,
                &source,
                &target,
                &title,
                &input.body,
            )?;
            Ok(CreateDecision::Fallback(FallbackPending {
                url: page.url,
                web_prefilled: page.prefilled,
                provider: repo.provider.key().to_string(),
                provider_label: repo.provider.label().to_string(),
                repository: repo.full_path(),
                source_branch: source,
                target_branch: target,
            }))
        }
    }
}

/// 原生打开回退网页。打开失败返回 browser_open，不显示创建或回退成功。
pub fn complete_fallback(
    opener: &dyn WebOpener,
    pending: FallbackPending,
) -> Result<ChangeRequestOutcome, AppError> {
    let page = web::FallbackPage {
        url: pending.url.clone(),
        prefilled: pending.web_prefilled,
    };
    web::open_page(opener, &page)?;
    Ok(ChangeRequestOutcome {
        status: "fallbackOpened".to_string(),
        url: pending.url,
        provider: pending.provider,
        provider_label: pending.provider_label,
        repository: pending.repository,
        source_branch: pending.source_branch,
        target_branch: pending.target_branch,
        web_prefilled: pending.web_prefilled,
    })
}

// ---------------------------------------------------------------- token

pub async fn token_status(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
) -> Result<ChangeRequestTokenStatus, AppError> {
    let http = Http::default_app()?;
    token_status_with(
        backend,
        path,
        remote,
        generation,
        request_id,
        &http,
        &KeyringStore::new(),
    )
    .await
}

pub(crate) async fn token_status_with(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
    http: &Http,
    store: &dyn CredentialStore,
) -> Result<ChangeRequestTokenStatus, AppError> {
    let repo = token_repository(backend, path, remote, generation, request_id, http).await?;
    let configured = store
        .load(&repo.token_key())
        .map_err(|failure| failure.into_error())?
        .is_some();
    Ok(ChangeRequestTokenStatus { configured })
}

pub async fn set_token(
    backend: &Backend,
    path: &str,
    remote: &str,
    token: &str,
    generation: u64,
    request_id: u64,
) -> Result<ChangeRequestTokenStatus, AppError> {
    let http = Http::default_app()?;
    set_token_with(
        backend,
        path,
        remote,
        token,
        generation,
        request_id,
        &http,
        &KeyringStore::new(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_token_with(
    backend: &Backend,
    path: &str,
    remote: &str,
    token: &str,
    generation: u64,
    request_id: u64,
    http: &Http,
    store: &dyn CredentialStore,
) -> Result<ChangeRequestTokenStatus, AppError> {
    ops::require_change_requests(backend)?;
    credential::validate_token_input(token)?;
    let repo = token_repository(backend, path, remote, generation, request_id, http).await?;
    // 明文 HTTP 上不保存令牌：保存后只会在不安全的通道上被发送。
    ensure_secure_channel(&repo)?;
    store
        .save(&repo.token_key(), token)
        .map_err(|failure| failure.into_error())?;
    Ok(ChangeRequestTokenStatus { configured: true })
}

pub async fn delete_token(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
) -> Result<ChangeRequestTokenStatus, AppError> {
    let http = Http::default_app()?;
    delete_token_with(
        backend,
        path,
        remote,
        generation,
        request_id,
        &http,
        &KeyringStore::new(),
    )
    .await
}

pub(crate) async fn delete_token_with(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
    http: &Http,
    store: &dyn CredentialStore,
) -> Result<ChangeRequestTokenStatus, AppError> {
    ops::require_change_requests(backend)?;
    let repo = token_repository(backend, path, remote, generation, request_id, http).await?;
    store
        .delete(&repo.token_key())
        .map_err(|failure| failure.into_error())?;
    Ok(ChangeRequestTokenStatus { configured: false })
}

async fn token_repository(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
    http: &Http,
) -> Result<Repository, AppError> {
    ops::require_change_requests(backend)?;
    let state = sync::change_request_git_state(backend, path, generation, request_id).await?;
    let url = remote_url(&state, remote)?;
    remote::resolve_repository(http, &url).await
}

// ---------------------------------------------------------------- 选择与校验

async fn select_remote(
    backend: &Backend,
    path: &str,
    state: &sync::ChangeRequestGitState,
    requested: Option<&str>,
) -> Result<RemoteSelection, AppError> {
    let local = current_branch(state)?;
    let upstream = upstream_remote(state);
    if let Some(name) = requested {
        let Some(remote) = state.remotes.iter().find(|remote| remote.name == name) else {
            return Err(AppError::new(
                "change_request_remote_missing",
                "没有这个远程，未创建 MR/PR。",
            ));
        };
        let source = match &upstream {
            Some((remote_name, branch)) if remote_name == &remote.name => branch.clone(),
            _ => local,
        };
        let (present, generation) =
            tracking_has(backend, path, state, &remote.name, &source).await?;
        if !present {
            return Err(source_missing(&remote.name, &source));
        }
        return Ok(RemoteSelection::Ready {
            remote: remote.name.clone(),
            source,
            generation,
        });
    }

    if let Some((remote_name, branch)) = upstream {
        // 有上游时只按上游远程解析；上游远程已不在远程列表里，就退回候选选择。
        if let Some((present, generation)) =
            tracking_if_present(backend, path, state, &remote_name, &branch).await?
        {
            if present {
                return Ok(RemoteSelection::Ready {
                    remote: remote_name,
                    source: branch,
                    generation,
                });
            }
            return Err(source_missing(&remote_name, &branch));
        }
    }

    if state.remotes.is_empty() {
        return Err(AppError::new(
            "change_request_no_remote",
            "还没有远程，不能创建 MR/PR。请先添加远程。",
        ));
    }
    if state.remotes.len() == 1 {
        let remote = &state.remotes[0];
        let (present, generation) =
            tracking_has(backend, path, state, &remote.name, &local).await?;
        if !present {
            return Err(source_missing(&remote.name, &local));
        }
        return Ok(RemoteSelection::Ready {
            remote: remote.name.clone(),
            source: local,
            generation,
        });
    }
    // 多个远程又没有上游：由用户选择，不猜，也不向任何实例发平台请求。
    Ok(RemoteSelection::Choice(
        state.remotes.iter().map(choice_for).collect(),
    ))
}

async fn tracking_has(
    backend: &Backend,
    path: &str,
    state: &sync::ChangeRequestGitState,
    remote: &str,
    branch: &str,
) -> Result<(bool, u64), AppError> {
    let (branches, generation) = sync::remote_tracking_branches(
        backend,
        path,
        remote,
        state.generation,
        internal_request_id(),
    )
    .await?;
    Ok((branches.iter().any(|name| name == branch), generation))
}

/// 上游远程不在远程列表时返回 None，让调用方退回候选选择。
async fn tracking_if_present(
    backend: &Backend,
    path: &str,
    state: &sync::ChangeRequestGitState,
    remote: &str,
    branch: &str,
) -> Result<Option<(bool, u64)>, AppError> {
    if !state.remotes.iter().any(|candidate| candidate.name == remote) {
        return Ok(None);
    }
    tracking_has(backend, path, state, remote, branch)
        .await
        .map(Some)
}

fn current_branch(state: &sync::ChangeRequestGitState) -> Result<String, AppError> {
    if state.branch.detached {
        return Err(AppError::new(
            "change_request_branch",
            "当前是 detached HEAD，没有可用的当前分支，未创建 MR/PR。",
        ));
    }
    if state.branch.unborn {
        return Err(AppError::new(
            "change_request_branch",
            "当前分支还没有提交，不能创建 MR/PR。",
        ));
    }
    state.branch.name.clone().ok_or_else(|| {
        AppError::new(
            "change_request_branch",
            "读不到当前分支，未创建 MR/PR。请刷新后重试。",
        )
    })
}

fn upstream_remote(state: &sync::ChangeRequestGitState) -> Option<(String, String)> {
    let upstream = state.branch.upstream.as_deref()?;
    let (name, branch) = upstream.split_once('/')?;
    if name.is_empty() || branch.is_empty() {
        return None;
    }
    state
        .remotes
        .iter()
        .any(|remote| remote.name == name)
        .then(|| (name.to_string(), branch.to_string()))
}

fn remote_url(state: &sync::ChangeRequestGitState, name: &str) -> Result<String, AppError> {
    let Some(remote) = state.remotes.iter().find(|remote| remote.name == name) else {
        return Err(AppError::new(
            "change_request_remote_missing",
            "没有这个远程，未创建 MR/PR。",
        ));
    };
    // 创建针对实际推送仓库：优先 push URL。
    Ok(remote
        .push_url
        .clone()
        .unwrap_or_else(|| remote.fetch_url.clone()))
}

fn choice_for(remote: &RemoteInfo) -> ChangeRequestRemoteChoice {
    let url = remote.push_url.as_deref().unwrap_or(&remote.fetch_url);
    match remote::parse_remote_location(url) {
        Ok(location) => ChangeRequestRemoteChoice {
            remote: remote.name.clone(),
            host: location.host.clone(),
            repository: location.repo_path,
            provider: remote::public_instance(&location.host)
                .map(|public| public.provider.label().to_string()),
        },
        Err(_) => ChangeRequestRemoteChoice {
            remote: remote.name.clone(),
            host: String::new(),
            repository: String::new(),
            provider: None,
        },
    }
}

fn source_missing(remote: &str, branch: &str) -> AppError {
    AppError::new(
        "change_request_source_missing",
        format!("当前来源分支 {branch} 还没有推送到远程 {remote}。请先推送后重试；应用不会自动推送。"),
    )
}

fn token_missing(repo: &Repository) -> AppError {
    AppError::new(
        "change_request_token_missing",
        format!(
            "还没有配置 {} 实例 {} 的 Personal Access Token。请在创建对话框里配置后重试；没有打开网页。",
            repo.provider.label(),
            repo.web_base
        ),
    )
}

fn ensure_secure_channel(repo: &Repository) -> Result<(), AppError> {
    if repo.api_base.starts_with("http://") && !repo.loopback {
        return Err(AppError::new(
            "change_request_insecure",
            "该实例的 API 只能通过明文 HTTP 访问，不会在这条通道上读取或发送令牌，也未创建 MR/PR。请改用 HTTPS 远程地址。",
        ));
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<String, AppError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "change_request_invalid_input",
            "标题不能为空，未创建 MR/PR。",
        ));
    }
    if trimmed.chars().count() > 256 {
        return Err(AppError::new(
            "change_request_invalid_input",
            "标题超过 256 字符，未创建 MR/PR。",
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_target(target: &str) -> Result<String, AppError> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "change_request_invalid_input",
            "目标分支不能为空，未创建 MR/PR。",
        ));
    }
    if trimmed.chars().count() > 255
        || trimmed.starts_with('-')
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
        || trimmed.contains("..")
        || trimmed
            .chars()
            .any(|value| value.is_whitespace() || value.is_control())
    {
        return Err(AppError::new(
            "change_request_invalid_input",
            "目标分支名无效，未创建 MR/PR。",
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_body(body: &str) -> Result<(), AppError> {
    if body.chars().count() > 65536 {
        return Err(AppError::new(
            "change_request_invalid_input",
            "描述超过 65536 字符，未创建 MR/PR。",
        ));
    }
    Ok(())
}
