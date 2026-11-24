//! 远程地址到可信平台上下文的解析与发现。
//!
//! 这里不接收前端传入的 owner/repo/API base：仓库坐标从当前远程地址推导，
//! 自托管实例默认靠平台元数据或同 host 的登录页标记确认。SSH / scp-like 地址
//! 只提供 Git host 与仓库路径。Web 部署地址不同时，可以显式指定 GitLab 实例，
//! 平台写入前仍须用该实例的项目 API 核对仓库。

use std::net::IpAddr;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

use super::http::Http;
use super::provider::Provider;
use super::web::encode_component;

/// 已确认的仓库上下文。api_base 与 web_base 都来自同一个已确认实例。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repository {
    pub provider: Provider,
    pub api_base: String,
    pub web_base: String,
    pub namespace: String,
    pub name: String,
    pub host: String,
    pub loopback: bool,
    pub gitlab_instance: Option<GitLabInstance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLabInstance {
    pub url: String,
    remote_fingerprint: String,
}

impl Repository {
    pub(crate) fn full_path(&self) -> String {
        format!("{}/{}", self.namespace, self.name)
    }

    pub(crate) fn web_url(&self) -> String {
        format!("{}/{}", self.web_base, self.full_path())
    }

    /// 钥匙串条目的用户名：provider 与规范化 API base 一起，避免同 host
    /// 不同 API 路径或不同平台互相覆盖。
    pub(crate) fn token_key(&self) -> String {
        format!("{}|{}", self.provider.key(), self.api_base)
    }
}

/// 远程地址解析结果：候选实例基址 + 每个基址下剩余的仓库路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteLocation {
    pub host: String,
    pub repo_path: String,
    pub candidates: Vec<(String, String)>,
}

pub(crate) fn parse_remote_location(raw: &str) -> Result<RemoteLocation, AppError> {
    let text = raw.trim();
    if text.is_empty() || text.len() > 4096 || text.chars().any(char::is_control) {
        return Err(invalid_remote_url());
    }
    let lower = text.to_ascii_lowercase();
    // 只有明确支持的远程 scheme 才继续；file://、git+ssh:// 之类不映射到平台。
    if let Some(index) = lower.find("://") {
        if !matches!(&lower[..index], "http" | "https" | "ssh" | "git") {
            return Err(invalid_remote_url());
        }
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let parsed = Url::parse(text).map_err(|_| invalid_remote_url())?;
        let host = parsed.host_str().ok_or_else(invalid_remote_url)?.to_string();
        let base = match parsed.port() {
            Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
            None => format!("{}://{}", parsed.scheme(), host),
        };
        let repo_path = normalize_repo_path(parsed.path())?;
        return Ok(build_location(host, base, repo_path));
    }
    if lower.starts_with("ssh://") || lower.starts_with("git://") {
        let parsed = Url::parse(text).map_err(|_| invalid_remote_url())?;
        let host = parsed.host_str().ok_or_else(invalid_remote_url)?.to_string();
        let repo_path = normalize_repo_path(parsed.path())?;
        // SSH 端口不是 web 端口：web 基址只取 host，走 HTTPS 默认端口。
        return Ok(build_location(host.clone(), format!("https://{host}"), repo_path));
    }
    // scp-like: [user@]host:path
    let (left, right) = text.split_once(':').ok_or_else(invalid_remote_url)?;
    if left.contains('/') || left.contains('\\') {
        return Err(invalid_remote_url());
    }
    let host = match left.split_once('@') {
        Some((user, host)) if !user.is_empty() && !host.is_empty() => host,
        Some(_) => return Err(invalid_remote_url()),
        None => left,
    };
    if host.is_empty() || host.contains('@') {
        return Err(invalid_remote_url());
    }
    let repo_path = normalize_repo_path(right)?;
    Ok(build_location(
        host.to_string(),
        format!("https://{host}"),
        repo_path,
    ))
}

fn build_location(host: String, base: String, repo_path: String) -> RemoteLocation {
    let candidates = candidate_bases(&base, &repo_path);
    RemoteLocation {
        host,
        repo_path,
        candidates,
    }
}

/// 自托管实例可能装在子路径下（例如 https://host/gitlab/group/repo）。
/// 先试 origin 本身，再试最多两层路径前缀；不跨 host、不做无界猜测。
fn candidate_bases(base: &str, repo_path: &str) -> Vec<(String, String)> {
    let segments = repo_path.split('/').collect::<Vec<_>>();
    let mut out = vec![(base.to_string(), repo_path.to_string())];
    let extra = segments.len().saturating_sub(2).min(2);
    for index in 1..=extra {
        out.push((
            format!("{}/{}", base, segments[..index].join("/")),
            segments[index..].join("/"),
        ));
    }
    out
}

fn normalize_repo_path(path: &str) -> Result<String, AppError> {
    let trimmed = path.trim_matches('/');
    let stripped = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let stripped = stripped.trim_end_matches('/');
    if stripped.is_empty() {
        return Err(invalid_remote_url());
    }
    let segments = stripped.split('/').collect::<Vec<_>>();
    if segments.len() < 2 {
        return Err(invalid_remote_url());
    }
    for segment in &segments {
        if segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.chars().any(|value| {
                value.is_whitespace()
                    || value.is_control()
                    || matches!(value, ':' | '?' | '#' | '%' | '\\')
            })
        {
            return Err(invalid_remote_url());
        }
    }
    Ok(segments.join("/"))
}

fn invalid_remote_url() -> AppError {
    AppError::new(
        "change_request_remote_url",
        "远程地址无法解析出可信的平台实例与仓库路径，未发起平台请求。",
    )
}

pub(crate) fn host_is_loopback(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

pub(crate) fn same_origin(left: &str, right: &str) -> bool {
    match (Url::parse(left), Url::parse(right)) {
        (Ok(left), Ok(right)) => {
            left.scheme() == right.scheme()
                && left.host_str() == right.host_str()
                && left.port_or_known_default() == right.port_or_known_default()
        }
        _ => false,
    }
}

/// 公共云端的固定实例。识别只看 host，但 API 与 web base 使用官方 https 地址。
pub(crate) struct PublicInstance {
    pub provider: Provider,
    pub web: &'static str,
    pub api: &'static str,
}

pub(crate) fn public_instance(host: &str) -> Option<PublicInstance> {
    match host.to_ascii_lowercase().as_str() {
        "github.com" => Some(PublicInstance {
            provider: Provider::GitHub,
            web: "https://github.com",
            api: "https://api.github.com",
        }),
        "gitlab.com" => Some(PublicInstance {
            provider: Provider::GitLab,
            web: "https://gitlab.com",
            api: "https://gitlab.com/api/v4",
        }),
        "gitea.com" => Some(PublicInstance {
            provider: Provider::Gitea,
            web: "https://gitea.com",
            api: "https://gitea.com/api/v1",
        }),
        _ => None,
    }
}

/// 仓库坐标：GitHub/Gitea 只接受 owner/repo，GitLab 允许嵌套组。
pub(crate) fn repo_coordinates(
    provider: Provider,
    repo_path: &str,
) -> Result<(String, String), AppError> {
    let segments = repo_path.split('/').collect::<Vec<_>>();
    let name = segments.last().copied().unwrap_or_default().to_string();
    let namespace = segments[..segments.len() - 1].join("/");
    let valid = match provider {
        Provider::GitHub | Provider::Gitea => segments.len() == 2,
        Provider::GitLab => segments.len() >= 2,
    };
    if !valid || namespace.is_empty() || name.is_empty() {
        return Err(AppError::new(
            "change_request_remote_url",
            "远程地址里的仓库路径与该平台的形式不一致，未发起平台请求。",
        ));
    }
    Ok((namespace, name))
}

/// 解析远程地址为已确认的仓库上下文。公共云端不需要网络；
/// 自托管必须由平台元数据确认，确认不了就不创建、不打开网页。
pub(crate) async fn resolve_repository(
    http: &Http,
    remote_url: &str,
    gitlab_instance_url: Option<&str>,
) -> Result<Repository, AppError> {
    let location = parse_remote_location(remote_url)?;
    if let Some(instance_url) = gitlab_instance_url {
        return manual_gitlab(remote_url, &location, instance_url);
    }
    if let Some(public) = public_instance(&location.host) {
        let (namespace, name) = repo_coordinates(public.provider, &location.repo_path)?;
        return Ok(Repository {
            provider: public.provider,
            api_base: public.api.to_string(),
            web_base: public.web.to_string(),
            namespace,
            name,
            host: location.host,
            loopback: false,
            gitlab_instance: None,
        });
    }
    let loopback = host_is_loopback(&location.host);
    let mut responded = false;
    let deadline = tokio::time::Instant::now() + http.timeout;
    for (base, repo_path) in &location.candidates {
        match tokio::time::timeout_at(deadline, probe_instance(http, base, &mut responded, deadline)).await {
            Ok(Some((provider, api_base))) => {
                let (namespace, name) = repo_coordinates(provider, repo_path)?;
                return Ok(Repository {
                    provider,
                    api_base,
                    web_base: base.clone(),
                    namespace,
                    name,
                    host: location.host.clone(),
                    loopback,
                    gitlab_instance: None,
                });
            }
            Ok(None) => {}
            Err(_) => break,
        }
    }
    if responded {
        Err(AppError::new(
            "change_request_platform_unknown",
            "无法确认该远程所在的平台实例，未创建 MR/PR，也未打开网页。请确认远程地址指向 GitHub、GitLab 或 Gitea 实例。",
        ))
    } else {
        Err(AppError::new(
            "change_request_network",
            "桌面端无法连接远程对应的 Web 实例。请确认网络、HTTPS 地址和证书。",
        ))
    }
}

fn manual_gitlab(
    remote_url: &str,
    location: &RemoteLocation,
    instance_url: &str,
) -> Result<Repository, AppError> {
    let invalid = || AppError::new(
        "change_request_gitlab_instance",
        "请输入 GitLab 实例的 HTTP 或 HTTPS 地址，可包含端口和部署子路径。请去掉用户名、查询参数与片段。",
    );
    let instance_url = instance_url.trim();
    if instance_url.len() > 4096 || instance_url.chars().any(char::is_control) {
        return Err(invalid());
    }
    let instance = Url::parse(instance_url).map_err(|_| invalid())?;
    let host = instance.host_str().ok_or_else(invalid)?.to_string();
    let loopback = host_is_loopback(&host);
    // 自建实例允许明文 HTTP：地址由用户亲手填写，等于明确同意在这条通道上使用令牌（内网 GitLab 常见）。
    if !matches!(instance.scheme(), "https" | "http")
        || !instance.username().is_empty()
        || instance.password().is_some()
        || instance.query().is_some()
        || instance.fragment().is_some()
    {
        return Err(invalid());
    }
    let prefix = instance.path().trim_end_matches('/');
    if !prefix.is_empty() && prefix[1..].split('/').any(|segment| {
        segment.is_empty() || !segment.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
        })
    }) {
        return Err(invalid());
    }

    let remote = remote_url.trim().contains("://")
        .then(|| Url::parse(remote_url.trim()).ok())
        .flatten();
    let git_origin = match remote.as_ref() {
        Some(url) => {
            let scheme = url.scheme();
            let host = &location.host;
            match url.port() {
                Some(port) => format!("{scheme}://{host}:{port}"),
                None => format!("{scheme}://{host}"),
            }
        }
        None => format!("ssh://{}", location.host),
    };
    // Web clones on this instance include its deployment prefix. SSH paths are
    // project coordinates, even if the web instance lives under a subdirectory.
    let repo_path = if !prefix.is_empty() && same_origin(&git_origin, instance.as_str()) {
        location.repo_path.strip_prefix(&format!("{}/", &prefix[1..])).unwrap_or(&location.repo_path)
    } else {
        &location.repo_path
    };
    let (namespace, name) = repo_coordinates(Provider::GitLab, repo_path)?;
    let web_base = format!("{}{prefix}", instance.origin().ascii_serialization());
    let git_remote = format!("{git_origin}/{}", location.repo_path);
    let gitlab_instance = GitLabInstance {
        url: web_base.clone(),
        remote_fingerprint: format!("{:x}", Sha256::digest(git_remote.as_bytes())),
    };
    Ok(Repository {
        provider: Provider::GitLab,
        api_base: format!("{web_base}/api/v4"),
        web_base,
        namespace,
        name,
        host,
        loopback,
        gitlab_instance: Some(gitlab_instance),
    })
}

/// 在候选实例基址上依次尝试：GitHub Enterprise 元数据、Gitea 版本、
/// GitLab API 版本、GitLab 登录页标记。任何 HTTP 响应都算“实例可达”，
/// 只有全部候选都没有响应时才算网络失败。
async fn probe_instance(http: &Http, base: &str, responded: &mut bool, deadline: tokio::time::Instant) -> Option<(Provider, String)> {
    let github_meta = format!("{base}/api/v3/meta");
    if let Ok(reply) = http.probe(&github_meta, deadline).await {
        *responded = true;
        if reply.status == 200 && looks_like_github_meta(&reply) {
            return Some((Provider::GitHub, format!("{base}/api/v3")));
        }
    }

    let gitea_version = format!("{base}/api/v1/version");
    if let Ok(reply) = http.probe(&gitea_version, deadline).await {
        *responded = true;
        if reply.status == 200 && looks_like_gitea_version(&reply) {
            return Some((Provider::Gitea, format!("{base}/api/v1")));
        }
    }

    let gitlab_version = format!("{base}/api/v4/version");
    if let Ok(reply) = http.probe(&gitlab_version, deadline).await {
        *responded = true;
        if reply.status == 200 {
            if let Some(json) = reply.json() {
                if json.get("version").is_some() && json.get("revision").is_some() {
                    return Some((Provider::GitLab, format!("{base}/api/v4")));
                }
            }
        }
    }

    // GitLab 的版本接口需要认证；未配置令牌时用同实例登录页的官方标记确认实例，
    // 这只能证明“这是 GitLab 页面”，具体版本与创建能力仍由创建路由判定。
    let sign_in = format!("{base}/users/sign_in");
    if let Ok(mut reply) = http.probe(&sign_in, deadline).await {
        *responded = true;
        if reply.status == 200 {
            reply.body.make_ascii_lowercase();
            let has_marker = |marker: &str| {
                reply.body.utf8_chunks().any(|chunk| chunk.valid().contains(marker))
            };
            if has_marker("og:site_name") && has_marker("gitlab") {
                return Some((Provider::GitLab, format!("{base}/api/v4")));
            }
        }
    }

    None
}

fn looks_like_github_meta(reply: &super::http::HttpReply) -> bool {
    let Some(json) = reply.json() else { return false };
    ["installed_version", "verifiable_password_authentication", "ssh_key_fingerprints"]
        .iter()
        .any(|key| json.get(*key).is_some())
}

fn looks_like_gitea_version(reply: &super::http::HttpReply) -> bool {
    let Some(json) = reply.json() else { return false };
    json.get("version")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.is_empty())
}

/// GitLab 的 API 路径要百分号编码整条项目路径（含斜杠）。
pub(crate) fn encode_project_path(full_path: &str) -> String {
    encode_component(full_path)
}
