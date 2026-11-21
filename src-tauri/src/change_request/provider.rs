//! 三个平台的创建适配器。平台差异（认证头、路径、字段、结果链接字段）只留在
//! 这里；上层只看到统一的成功链接或统一分类的失败。
//!
//! 成功只接受 201、可解析对象、同一实例的可信 HTTP(S) 链接。能力不支持的证据
//! 只有两种：创建路由直接回“方法不支持/未实现”（405 / 501），或创建路由回 404
//! 之后、同一实例的列表路由也用同一份认证与限界回“不存在/方法不支持/未实现”
//! （404 / 405 / 501）。孤立 404、列表可用、认证、权限、限流、网络失败、超时和
//! 未知响应都不回退。

use serde_json::{json, Value};

use crate::error::AppError;
use crate::redact::redact_error_text;

use super::http::{Http, HttpReply};
use super::remote::{encode_project_path, same_origin, Repository};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    GitHub,
    GitLab,
    Gitea,
}

impl Provider {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
            Provider::Gitea => "gitea",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Provider::GitHub => "GitHub",
            Provider::GitLab => "GitLab",
            Provider::Gitea => "Gitea",
        }
    }

    /// 平台文档给出的认证头：GitHub 用 Bearer，GitLab 用 PRIVATE-TOKEN，
    /// Gitea 用 Authorization: token。令牌从不放进 URL 或命令行。
    fn auth_header(self) -> &'static str {
        match self {
            Provider::GitHub => "authorization",
            Provider::GitLab => "PRIVATE-TOKEN",
            Provider::Gitea => "authorization",
        }
    }

    fn auth_value(self, token: &str) -> String {
        match self {
            Provider::GitHub => format!("Bearer {token}"),
            Provider::GitLab => token.to_string(),
            Provider::Gitea => format!("token {token}"),
        }
    }

    fn repo_meta_url(self, repo: &Repository) -> String {
        match self {
            Provider::GitLab => format!(
                "{}/projects/{}",
                repo.api_base,
                encode_project_path(&repo.full_path())
            ),
            _ => format!("{}/repos/{}/{}", repo.api_base, repo.namespace, repo.name),
        }
    }

    /// 创建与列表是同一条集合路由：POST 创建，GET 列表。把两者绑在一个方法上，
    /// 能力探测才能保证问的是“创建失败的那条路由还在不在”。
    fn collection_url(self, repo: &Repository) -> String {
        match self {
            Provider::GitLab => format!(
                "{}/projects/{}/merge_requests",
                repo.api_base,
                encode_project_path(&repo.full_path())
            ),
            _ => format!(
                "{}/repos/{}/{}/pulls",
                repo.api_base, repo.namespace, repo.name
            ),
        }
    }

    fn create_body(self, source: &str, target: &str, title: &str, body: &str) -> Value {
        match self {
            Provider::GitLab => json!({
                "source_branch": source,
                "target_branch": target,
                "title": title,
                "description": body,
            }),
            _ => json!({
                "head": source,
                "base": target,
                "title": title,
                "body": body,
            }),
        }
    }

    fn parse_repo_meta(self, json: &Value) -> Option<RepositoryMeta> {
        let web_key = match self {
            Provider::GitLab => "web_url",
            _ => "html_url",
        };
        let web_url = json.get(web_key)?.as_str()?.to_string();
        // 平台默认分支不作为创建参数：目标分支是用户确认的字段，这里只需要
        // 可核验的仓库网页地址来做同源校验和网页回退。
        Some(RepositoryMeta { web_url })
    }

    fn parse_created(self, json: &Value) -> Option<String> {
        let key = match self {
            Provider::GitLab => "web_url",
            _ => "html_url",
        };
        json.get(key)?.as_str().map(str::to_string)
    }
}

pub(crate) struct RepositoryMeta {
    pub web_url: String,
}

pub(crate) enum CreateAttempt {
    Created(String),
    Unsupported,
}

fn auth_headers(provider: Provider, token: &str) -> Result<Vec<(&'static str, String)>, AppError> {
    if token.is_empty()
        || token.len() > 4096
        || token
            .chars()
            .any(|value| value.is_control() || !value.is_ascii())
    {
        return Err(AppError::new(
            "change_request_token_missing",
            "该实例的令牌不可用。请在创建对话框里重新配置 Personal Access Token。",
        ));
    }
    Ok(vec![(provider.auth_header(), provider.auth_value(token))])
}

pub(crate) async fn fetch_repository_meta(
    http: &Http,
    repo: &Repository,
    token: &str,
) -> Result<RepositoryMeta, AppError> {
    fetch_repository_meta_inner(http, repo, token)
        .await
        .map_err(|error| scrub(error, token))
}

async fn fetch_repository_meta_inner(
    http: &Http,
    repo: &Repository,
    token: &str,
) -> Result<RepositoryMeta, AppError> {
    let url = repo.provider.repo_meta_url(repo);
    let headers = auth_headers(repo.provider, token)?;
    let reply = http.send("GET", &url, headers, None).await?;
    if reply.status != 200 {
        // 元数据阶段只证明“仓库/权限上下文是否可用”，不能作为能力不支持的证据。
        let failure = classify(&reply, repo.provider);
        return Err(failure.into_error());
    }
    let Some(json) = reply.json() else {
        return Err(unknown_error("平台返回的仓库信息无法解析，未创建 MR/PR。"));
    };
    let Some(meta) = repo.provider.parse_repo_meta(&json) else {
        return Err(unknown_error(
            "平台返回的仓库信息缺少仓库网页地址，未创建 MR/PR。",
        ));
    };
    if !same_origin(&meta.web_url, &repo.web_base) {
        return Err(unknown_error(
            "平台返回的仓库地址与已确认实例不一致，未创建 MR/PR。",
        ));
    }
    Ok(meta)
}

pub(crate) async fn create(
    http: &Http,
    repo: &Repository,
    token: &str,
    source: &str,
    target: &str,
    title: &str,
    body: &str,
) -> Result<CreateAttempt, AppError> {
    create_inner(http, repo, token, source, target, title, body)
        .await
        .map_err(|error| scrub(error, token))
}

#[allow(clippy::too_many_arguments)]
async fn create_inner(
    http: &Http,
    repo: &Repository,
    token: &str,
    source: &str,
    target: &str,
    title: &str,
    body: &str,
) -> Result<CreateAttempt, AppError> {
    let url = repo.provider.collection_url(repo);
    let payload = repo.provider.create_body(source, target, title, body);
    let headers = auth_headers(repo.provider, token)?;
    // 探测要复用同一份认证头，但 POST 只发一次：这里克隆，不重发创建请求。
    let reply = http
        .send("POST", &url, headers.clone(), Some(&payload))
        .await?;
    match reply.status {
        201 => {
            let Some(json) = reply.json() else {
                return Err(unknown_error(
                    "平台返回了 201，但响应无法解析，未当作创建成功。请先在平台核对。",
                ));
            };
            let Some(link) = repo.provider.parse_created(&json) else {
                return Err(unknown_error(
                    "平台返回了 201，但没有可信的结果链接，未当作创建成功。请先在平台核对。",
                ));
            };
            crate::git::document::validate_web_url(&link).map_err(|_| {
                unknown_error("平台返回的结果链接不是可信的 HTTP(S) 地址，未当作创建成功。")
            })?;
            if !same_origin(&link, &repo.web_base) {
                return Err(unknown_error(
                    "平台返回的结果链接与已确认实例不同源，未当作创建成功。",
                ));
            }
            Ok(CreateAttempt::Created(link))
        }
        405 | 501 => Ok(CreateAttempt::Unsupported),
        404 => {
            // 仓库元数据阶段已经用同一次认证确认过仓库可见，此处的 404 可能是
            // 旧实例缺少创建路由，但孤立 404 本身不能证明这件事。再用同一条集合
            // 路由做一次列表探测，只有列表路由也明确缺失才判定能力不支持。
            if list_route_missing(http, &url, headers).await {
                Ok(CreateAttempt::Unsupported)
            } else {
                Err(classify(&reply, repo.provider).into_error())
            }
        }
        _ => Err(classify(&reply, repo.provider).into_error()),
    }
}

/// 创建路由返回 404 后的保守能力探测：对同一实例的同一条集合路由发一次 GET，
/// 沿用创建请求的认证头与同一个限界 HTTP 客户端。
///
/// 只有列表路由本身也明确回“不存在/方法不支持/未实现”（404 / 405 / 501）才算
/// 能力证据。列表可用、认证/权限/限流/未知响应，或探测自身网络失败，都说明
/// 证据不足，保持普通失败、不回退。探测不重发 POST，也不消耗额外重试。
async fn list_route_missing(http: &Http, url: &str, headers: Vec<(&'static str, String)>) -> bool {
    match http.send("GET", url, headers, None).await {
        Ok(reply) => matches!(reply.status, 404 | 405 | 501),
        Err(_) => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    Auth,
    Permission,
    NotFound,
    Conflict,
    Invalid,
    RateLimited,
    Unknown,
}

pub(crate) struct Failure {
    kind: FailureKind,
    status: u16,
    detail: String,
}

impl Failure {
    fn into_error(self) -> AppError {
        match self.kind {
            FailureKind::Auth => AppError::new(
                "change_request_auth",
                "平台拒绝了这组令牌（401）。请确认令牌属于该实例且没有过期。",
            ),
            FailureKind::Permission => AppError::new(
                "change_request_permission",
                "令牌没有在该仓库创建 MR/PR 的权限（403）。请检查令牌的权限范围。",
            ),
            FailureKind::NotFound => AppError::new(
                "change_request_not_found",
                "平台返回仓库不存在或不可见（404）。请确认仓库仍可访问，来源分支已经推送。",
            ),
            FailureKind::Conflict => AppError::new(
                "change_request_conflict",
                "平台报告相同来源与目标的 MR/PR 已存在或状态冲突（409）。请先在平台核对。",
            ),
            FailureKind::Invalid => AppError::new(
                "change_request_invalid",
                format!("平台拒绝了创建参数（422）。{}", self.detail),
            ),
            FailureKind::RateLimited => AppError::new(
                "change_request_rate_limited",
                "平台限流（429）。请稍后再由你手动重试；应用不会自动重试。",
            ),
            FailureKind::Unknown => unknown_error(&format!(
                "平台返回了无法归类的结果（HTTP {}），未创建 MR/PR。{}",
                self.status, self.detail
            )),
        }
    }
}

/// 平台回显是最不可控的文本来源：把本次使用的令牌从可展示消息里彻底抹掉。
fn scrub(error: AppError, token: &str) -> AppError {
    if token.is_empty() || !error.message.contains(token) {
        return error;
    }
    AppError {
        code: error.code,
        message: error.message.replace(token, "[令牌已隐藏]"),
        generation: error.generation,
    }
}

fn unknown_error(message: &str) -> AppError {
    AppError::new("change_request_unknown", redact_error_text(message))
}

fn classify(reply: &HttpReply, provider: Provider) -> Failure {
    let detail = detail_from_body(reply, provider);
    let rate_limited = reply
        .header("x-ratelimit-remaining")
        .is_some_and(|value| value.trim() == "0")
        || reply
            .header("retry-after")
            .is_some_and(|value| !value.trim().is_empty());
    let kind = match reply.status {
        401 => FailureKind::Auth,
        403 if rate_limited => FailureKind::RateLimited,
        403 => FailureKind::Permission,
        // 孤立 404 不是能力证据：仓库或分支可能真的不存在，按普通失败处理。
        404 => FailureKind::NotFound,
        409 => FailureKind::Conflict,
        422 => FailureKind::Invalid,
        429 => FailureKind::RateLimited,
        _ => FailureKind::Unknown,
    };
    Failure {
        kind,
        status: reply.status,
        detail,
    }
}

/// 平台错误里只取一条稳定、短、已脱敏的说明，不展示完整 body。
fn detail_from_body(reply: &HttpReply, _provider: Provider) -> String {
    let Some(json) = reply.json() else {
        return String::new();
    };
    let message = json
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| json.get("error").and_then(|value| value.as_str()));
    let Some(message) = message else {
        return String::new();
    };
    let redacted = redact_error_text(message);
    let truncated = redacted.chars().take(200).collect::<String>();
    format!("平台说明：{truncated}")
}
