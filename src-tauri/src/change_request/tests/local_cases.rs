//! 纯解析、网页地址与打开失败：不触网、不读写钥匙串。

use std::sync::Mutex;

use crate::error::AppError;

use super::super::provider::Provider;
use super::super::remote::{
    host_is_loopback, parse_remote_location, public_instance, resolve_repository, same_origin,
    Repository,
};
use super::super::web::{fallback_page, WebOpener};
use super::super::{complete_fallback, ensure_secure_channel, FallbackPending};
use super::http_with;

#[test]
fn remote_location_parsing_covers_http_ssh_and_scp_like() {
    let https = parse_remote_location("https://GitHub.com/Acme/App.git").unwrap();
    // URL 解析会把 host 规范成小写；仓库路径大小写保留。
    assert_eq!(https.host, "github.com");
    assert_eq!(https.repo_path, "Acme/App");
    assert_eq!(https.candidates.len(), 1);

    let ported = parse_remote_location("http://127.0.0.1:8080/gitlab/group/sub/app.git").unwrap();
    assert_eq!(ported.host, "127.0.0.1");
    assert_eq!(ported.repo_path, "gitlab/group/sub/app");
    // 自托管子路径：先试 origin，再试最多两层前缀。
    assert_eq!(ported.candidates[0].0, "http://127.0.0.1:8080");
    assert_eq!(ported.candidates[1].0, "http://127.0.0.1:8080/gitlab");
    assert_eq!(ported.candidates[1].1, "group/sub/app");
    assert_eq!(ported.candidates[2].0, "http://127.0.0.1:8080/gitlab/group");
    assert_eq!(ported.candidates[2].1, "sub/app");

    let ssh = parse_remote_location("ssh://git@example.com:2222/group/app.git").unwrap();
    assert_eq!(ssh.host, "example.com");
    assert_eq!(ssh.repo_path, "group/app");
    // SSH 端口不是 web 端口，web 候选只用 host + 默认 HTTPS。
    assert_eq!(ssh.candidates[0].0, "https://example.com");

    let scp = parse_remote_location("git@example.com:group/app.git").unwrap();
    assert_eq!(scp.host, "example.com");
    assert_eq!(scp.repo_path, "group/app");
    assert_eq!(scp.candidates[0].0, "https://example.com");
}

#[test]
fn remote_location_rejects_untrusted_inputs() {
    for input in [
        "",
        "file:///tmp/repo",
        "/tmp/repo",
        "C:\\repo",
        "https://example.com/only-one-segment",
        "https://example.com/a/../b",
        "https://example.com/a/%2e%2e/b",
        "git@example.com:",
        "https://example.com/owner/re po",
    ] {
        let parsed = parse_remote_location(input);
        assert!(parsed.is_err(), "应拒绝 {input:?}");
        if let Err(error) = parsed {
            assert_eq!(error.code, "change_request_remote_url", "{input:?}");
        }
    }
}

#[tokio::test]
async fn public_cloud_hosts_use_official_api_and_web_without_network() {
    // 只给 1ms 超时：公共 host 的解析不应发起任何请求，否则这里会失败。
    let http = http_with(256, 1);
    let github = resolve_repository(&http, "https://github.com/acme/app.git", None)
        .await
        .unwrap();
    assert_eq!(github.provider, Provider::GitHub);
    assert_eq!(github.api_base, "https://api.github.com");
    assert_eq!(github.web_base, "https://github.com");
    assert_eq!(github.full_path(), "acme/app");
    assert_eq!(github.web_url(), "https://github.com/acme/app");
    assert_eq!(github.token_key(), "github|https://api.github.com");

    let gitlab = resolve_repository(&http, "git@gitlab.com:group/sub/app.git", None)
        .await
        .unwrap();
    assert_eq!(gitlab.provider, Provider::GitLab);
    assert_eq!(gitlab.api_base, "https://gitlab.com/api/v4");
    assert_eq!(gitlab.full_path(), "group/sub/app");
    assert_eq!(gitlab.token_key(), "gitlab|https://gitlab.com/api/v4");

    let gitea = resolve_repository(&http, "https://gitea.com/acme/app", None)
        .await
        .unwrap();
    assert_eq!(gitea.provider, Provider::Gitea);
    assert_eq!(gitea.api_base, "https://gitea.com/api/v1");
    assert_eq!(gitea.token_key(), "gitea|https://gitea.com/api/v1");

    // 公共 host 但路径不是 owner/repo：不猜，直接拒绝。
    let error = resolve_repository(&http, "https://github.com/acme", None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_request_remote_url");
    assert!(public_instance("github.com").is_some());
    assert!(public_instance("not-github.example").is_none());
}

#[test]
fn fallback_urls_encode_components_and_degrade_when_too_long() {
    let page = fallback_page(
        Provider::GitHub,
        "https://github.com/acme/app/",
        "feat/x y",
        "ma#in",
        "a&b",
        "line1\nline2",
    )
    .unwrap();
    assert_eq!(
        page.url,
        "https://github.com/acme/app/compare/ma%23in...feat%2Fx%20y?quick_pull=1&title=a%26b&body=line1%0Aline2"
    );
    assert!(page.prefilled);

    let gitea = fallback_page(
        Provider::Gitea,
        "https://gitea.example/acme/app",
        "feat/x y",
        "main",
        "标题",
        "",
    )
    .unwrap();
    assert!(gitea.url.contains("/compare/main...feat%2Fx%20y?expand=1&title="));
    assert!(gitea.prefilled);

    // GitLab 只有来源分支是官方可核验参数，因此不声称目标/标题/描述已预填。
    let gitlab = fallback_page(
        Provider::GitLab,
        "https://gitlab.example/acme/app",
        "feat/x y",
        "main",
        "标题",
        "描述",
    )
    .unwrap();
    assert_eq!(
        gitlab.url,
        "https://gitlab.example/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx%20y"
    );
    assert!(!gitlab.prefilled);

    // 超长时先省略标题与描述，保留新建表单参数。
    let long_title = "标".repeat(4000);
    let degraded = fallback_page(
        Provider::GitHub,
        "https://github.com/acme/app",
        "feature",
        "main",
        &long_title,
        &long_title,
    )
    .unwrap();
    assert!(degraded.url.len() <= 8192);
    assert!(!degraded.url.contains("title="));
    assert!(!degraded.prefilled);

    // 省略后仍超限：报错，不打开截断地址。
    let long_repo = format!("https://github.com/{}", "a".repeat(8180));
    let error = fallback_page(
        Provider::GitHub,
        &long_repo,
        "feature",
        "main",
        "t",
        "b",
    )
    .unwrap_err();
    assert_eq!(error.code, "change_request_fallback_url");
}

#[test]
fn insecure_plain_http_instances_never_receive_tokens() {
    let insecure = Repository {
        provider: Provider::Gitea,
        api_base: "http://git.example.test/api/v1".to_string(),
        web_base: "http://git.example.test".to_string(),
        namespace: "acme".to_string(),
        name: "app".to_string(),
        host: "git.example.test".to_string(),
        loopback: false,
        gitlab_instance: None,
    };
    assert_eq!(
        ensure_secure_channel(&insecure).unwrap_err().code,
        "change_request_insecure"
    );

    // loopback 明文只用于可控测试。
    let loopback = Repository {
        api_base: "http://127.0.0.1:9/api/v1".to_string(),
        web_base: "http://127.0.0.1:9".to_string(),
        loopback: true,
        ..insecure.clone()
    };
    assert!(ensure_secure_channel(&loopback).is_ok());


    let secure = Repository {
        api_base: "https://git.example.test/api/v1".to_string(),
        web_base: "https://git.example.test".to_string(),
        ..insecure
    };
    assert!(ensure_secure_channel(&secure).is_ok());
    assert!(host_is_loopback("localhost"));
    assert!(host_is_loopback("127.0.0.1"));
    assert!(host_is_loopback("[::1]"));
    assert!(!host_is_loopback("git.example.test"));
    assert!(same_origin("https://a.test/x", "https://a.test"));
    assert!(!same_origin("https://a.test/x", "http://a.test"));
}

#[tokio::test]
async fn manual_gitlab_strips_a_same_origin_web_clone_prefix_and_accepts_http_or_https_only() {
    let http = http_with(256, 200);
    let remote = "https://git.example.test:8443/tools/gitlab/team/sub/app.git";
    let repo = resolve_repository(&http, remote, Some("https://git.example.test:8443/tools/gitlab/")).await.unwrap();
    assert_eq!(repo.full_path(), "team/sub/app");
    assert_eq!(repo.api_base, "https://git.example.test:8443/tools/gitlab/api/v4");
    // 内网 GitLab 常用明文 HTTP：手填 http:// 实例地址可以使用。
    let plain = resolve_repository(&http, remote, Some("http://git.example.test/tools/gitlab")).await.unwrap();
    assert_eq!(plain.api_base, "http://git.example.test/tools/gitlab/api/v4");
    assert!(plain.gitlab_instance.is_some());
    // 手填即明确同意：明文实例也可以发送令牌（自动探测到的明文实例仍然拒绝，见上一个用例）。
    assert!(ensure_secure_channel(&plain).is_ok());
    for invalid in [
        "ftp://git.example.test/tools/gitlab",
        "https://user:password@git.example.test/tools/gitlab",
        "https://git.example.test/tools/gitlab?query=secret",
        "https://git.example.test/tools/gitlab#fragment",
    ] {
        assert_eq!(resolve_repository(&http, remote, Some(invalid)).await.unwrap_err().code, "change_request_gitlab_instance");
    }
}

struct FailingOpener;

impl WebOpener for FailingOpener {
    fn open(&self, _url: &str) -> Result<(), AppError> {
        Err(AppError::new("browser_open", "无法打开系统浏览器。"))
    }
}

struct RecordingOpener(Mutex<Vec<String>>);

impl WebOpener for RecordingOpener {
    fn open(&self, url: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().push(url.to_string());
        Ok(())
    }
}

#[test]
fn opener_failure_never_reports_created_or_fallback_success() {
    let pending = || FallbackPending {
        url: "https://github.com/acme/app/compare/main...feature?quick_pull=1".to_string(),
        web_prefilled: true,
        provider: "github".to_string(),
        provider_label: "GitHub".to_string(),
        repository: "acme/app".to_string(),
        source_branch: "feature".to_string(),
        target_branch: "main".to_string(),
    };
    let error = complete_fallback(&FailingOpener, pending()).unwrap_err();
    assert_eq!(error.code, "browser_open");

    let opener = RecordingOpener(Mutex::new(Vec::new()));
    let outcome = complete_fallback(&opener, pending()).unwrap();
    assert_eq!(outcome.status, "fallbackOpened");
    assert_eq!(outcome.url, pending().url);
    assert_eq!(opener.0.lock().unwrap().len(), 1);

    // 无法通过既有网页校验的地址不会被打开。
    let mut invalid = pending();
    invalid.url = "file:///etc/passwd".to_string();
    let error = complete_fallback(&opener, invalid).unwrap_err();
    assert_eq!(error.code, "change_request_fallback_url");
    assert_eq!(opener.0.lock().unwrap().len(), 1);
}
