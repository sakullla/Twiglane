//! 创建 MR/PR 的中立原生边界。
//!
//! 平台差异留在 provider 适配器，凭据只在系统钥匙串，网页回退只在适配器明确
//! 证明能力不支持时发生。这里不接收前端传入的 owner/repo/API base 作为事实，
//! 也不调用任何 Git 写命令：准备阶段只读当前分支、远程和远程跟踪引用。
//!
//! 关闭开关时所有命令在读钥匙串、探测远程或发平台请求之前就返回。

pub(crate) mod credential;
mod http;
mod provider;
mod remote;
mod web;

#[cfg(test)]
mod tests;

use std::future::Future;

use serde::{Deserialize, Serialize};

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

pub(crate) trait RepositoryReader {
    fn state(&self) -> impl Future<Output = Result<sync::ChangeRequestGitState, AppError>> + Send;
    fn remotes(&self) -> impl Future<Output = Result<Vec<RemoteInfo>, AppError>> + Send;
    fn tracking(
        &self,
        remote: &str,
        branch: &str,
        generation: u64,
    ) -> impl Future<Output = Result<(bool, u64), AppError>> + Send;
}

struct LocalReader<'a> {
    backend: &'a Backend,
    path: &'a str,
    generation: u64,
    request_id: u64,
}

impl RepositoryReader for LocalReader<'_> {
    async fn state(&self) -> Result<sync::ChangeRequestGitState, AppError> {
        sync::change_request_git_state(self.backend, self.path, self.generation, self.request_id).await
    }

    async fn remotes(&self) -> Result<Vec<RemoteInfo>, AppError> {
        sync::change_request_remotes(self.backend, self.path, self.generation, self.request_id).await
    }

    async fn tracking(&self, remote: &str, branch: &str, generation: u64) -> Result<(bool, u64), AppError> {
        sync::remote_tracking_ref_exists(
            self.backend, self.path, remote, branch, generation, internal_request_id(),
        ).await
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExpectedSource {
    pub provider: String,
    pub host: String,
    pub repository: String,
    pub repository_web: String,
    pub source_branch: String,
    pub gitlab_instance: Option<remote::GitLabInstance>,
}

impl ExpectedSource {
    fn check(&self, repository: &Repository, source: Option<&str>) -> Result<(), AppError> {
        if self.provider != repository.provider.key()
            || self.host != repository.host
            || self.repository != repository.full_path()
            || self.repository_web != repository.web_url()
            || self.gitlab_instance != repository.gitlab_instance
            || source.is_some_and(|source| source != self.source_branch)
        {
            return Err(AppError::new(
                "change_request_stale",
                "远程仓库或来源分支已变化，请重新打开创建 MR/PR 的页面。",
            ));
        }
        Ok(())
    }
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    gitlab_instance: Option<remote::GitLabInstance>,
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
    gitlab_instance_url: Option<&str>,
) -> Result<ChangeRequestPrepare, AppError> {
    let http = Http::default_app()?;
    prepare_with(backend, path, remote, generation, request_id, &http, gitlab_instance_url).await
}

pub(crate) async fn prepare_with(
    backend: &Backend,
    path: &str,
    requested: Option<&str>,
    generation: u64,
    request_id: u64,
    http: &Http,
    gitlab_instance_url: Option<&str>,
) -> Result<ChangeRequestPrepare, AppError> {
    ops::require_change_requests(backend)?;
    let git = LocalReader { backend, path, generation, request_id };
    prepare_for(&git, requested, http, gitlab_instance_url).await
}

pub(crate) async fn prepare_for(
    git: &impl RepositoryReader,
    requested: Option<&str>,
    http: &Http,
    gitlab_instance_url: Option<&str>,
) -> Result<ChangeRequestPrepare, AppError> {
    let state = git.state().await?;
    current_branch(&state)?;
    match select_remote(git, &state, requested).await? {
        RemoteSelection::Choice(choices) => Ok(empty_prepare("remoteChoice", choices, state.generation)),
        RemoteSelection::Ready {
            remote,
            source,
            generation,
        } => {
            let url = remote_url(&state.remotes, &remote)?;
            let repo = remote::resolve_repository(http, url, gitlab_instance_url).await?;
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
                gitlab_instance: repo.gitlab_instance,
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
        gitlab_instance: None,
    }
}

// ---------------------------------------------------------------- create

pub async fn create(
    backend: &Backend,
    input: CreateInput,
    generation: u64,
    request_id: u64,
    opener: &dyn WebOpener,
    expected: Option<&ExpectedSource>,
) -> Result<ChangeRequestOutcome, AppError> {
    let http = Http::default_app()?;
    let store = KeyringStore::new();
    match create_with(backend, input, generation, request_id, &http, &store, expected).await? {
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
    expected: Option<&ExpectedSource>,
) -> Result<CreateDecision, AppError> {
    // 门禁在读令牌、探测平台之前：关闭时不读钥匙串、不发平台请求。
    ops::require_change_requests(backend)?;
    let git = LocalReader { backend, path: &input.path, generation, request_id };
    create_for(&git, &input, http, store, expected).await
}

pub(crate) async fn create_for(
    git: &impl RepositoryReader,
    input: &CreateInput,
    http: &Http,
    store: &dyn CredentialStore,
    expected: Option<&ExpectedSource>,
) -> Result<CreateDecision, AppError> {
    let title = validate_title(&input.title)?;
    let target = validate_target(&input.target_branch)?;
    validate_body(&input.body)?;

    let state = git.state().await?;
    current_branch(&state)?;
    let selection = select_remote(git, &state, input.remote.as_deref()).await?;
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

    let url = remote_url(&state.remotes, &remote)?;
    let repo = resolve_expected_repository(http, url, expected).await?;
    if let Some(expected) = expected {
        expected.check(&repo, Some(&source))?;
    }
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
    expected: Option<&ExpectedSource>,
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
        expected,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn token_status_with(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
    http: &Http,
    store: &dyn CredentialStore,
    expected: Option<&ExpectedSource>,
) -> Result<ChangeRequestTokenStatus, AppError> {
    ops::require_change_requests(backend)?;
    let git = LocalReader { backend, path, generation, request_id };
    token_for(&git, remote, TokenAction::Status, http, store, expected).await
}

pub async fn set_token(
    backend: &Backend,
    path: &str,
    remote: &str,
    token: &str,
    generation: u64,
    request_id: u64,
    expected: Option<&ExpectedSource>,
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
        expected,
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
    expected: Option<&ExpectedSource>,
) -> Result<ChangeRequestTokenStatus, AppError> {
    ops::require_change_requests(backend)?;
    let git = LocalReader { backend, path, generation, request_id };
    token_for(&git, remote, TokenAction::Set(token), http, store, expected).await
}

pub async fn delete_token(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
    expected: Option<&ExpectedSource>,
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
        expected,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn delete_token_with(
    backend: &Backend,
    path: &str,
    remote: &str,
    generation: u64,
    request_id: u64,
    http: &Http,
    store: &dyn CredentialStore,
    expected: Option<&ExpectedSource>,
) -> Result<ChangeRequestTokenStatus, AppError> {
    ops::require_change_requests(backend)?;
    let git = LocalReader { backend, path, generation, request_id };
    token_for(&git, remote, TokenAction::Delete, http, store, expected).await
}

pub(crate) enum TokenAction<'a> {
    Status,
    Set(&'a str),
    Delete,
}

pub(crate) async fn token_for(
    git: &impl RepositoryReader,
    remote: &str,
    action: TokenAction<'_>,
    http: &Http,
    store: &dyn CredentialStore,
    expected: Option<&ExpectedSource>,
) -> Result<ChangeRequestTokenStatus, AppError> {
    if let TokenAction::Set(token) = action {
        credential::validate_token_input(token)?;
    }
    let remotes = git.remotes().await?;
    let url = remote_url(&remotes, remote)?;
    let repo = resolve_expected_repository(http, url, expected).await?;
    if let Some(expected) = expected {
        expected.check(&repo, None)?;
    }
    let key = repo.token_key();
    let configured = match action {
        TokenAction::Status => store.load(&key).map_err(|failure| failure.into_error())?.is_some(),
        TokenAction::Set(token) => {
            // 明文 HTTP 上不保存令牌。
            ensure_secure_channel(&repo)?;
            store.save(&key, token).map_err(|failure| failure.into_error())?;
            true
        }
        TokenAction::Delete => {
            store.delete(&key).map_err(|failure| failure.into_error())?;
            false
        }
    };
    Ok(ChangeRequestTokenStatus { configured })
}

async fn resolve_expected_repository(
    http: &Http,
    remote_url: &str,
    expected: Option<&ExpectedSource>,
) -> Result<Repository, AppError> {
    let instance_url = expected.and_then(|source| source.gitlab_instance.as_ref())
        .map(|instance| instance.url.as_str());
    remote::resolve_repository(http, remote_url, instance_url).await
}

// ---------------------------------------------------------------- 选择与校验

async fn select_remote(
    git: &impl RepositoryReader,
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
        let (present, generation) = git.tracking(&remote.name, &source, state.generation).await?;
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
            tracking_if_present(git, state, &remote_name, &branch).await?
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
        let (present, generation) = git.tracking(&remote.name, &local, state.generation).await?;
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

/// 上游远程不在远程列表时返回 None，让调用方退回候选选择。
async fn tracking_if_present(
    git: &impl RepositoryReader,
    state: &sync::ChangeRequestGitState,
    remote: &str,
    branch: &str,
) -> Result<Option<(bool, u64)>, AppError> {
    if !state.remotes.iter().any(|candidate| candidate.name == remote) {
        return Ok(None);
    }
    git.tracking(remote, branch, state.generation).await.map(Some)
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

fn remote_url<'a>(remotes: &'a [RemoteInfo], name: &str) -> Result<&'a str, AppError> {
    let Some(remote) = remotes.iter().find(|remote| remote.name == name) else {
        return Err(AppError::new(
            "change_request_remote_missing",
            "没有这个远程，未创建 MR/PR。",
        ));
    };
    // 创建针对实际推送仓库：优先 push URL。
    Ok(remote.push_url.as_deref().unwrap_or(&remote.fetch_url))
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
