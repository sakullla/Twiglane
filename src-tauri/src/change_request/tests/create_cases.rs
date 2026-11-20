//! 三平台创建请求、201 结果、失败分类、超时、响应上限与保守回退。

use crate::error::AppError;

use super::*;

struct Harness {
    fixture: crate::test_support::GitFixture,
    backend: Backend,
    dir: std::path::PathBuf,
    base: String,
    server: JoinHandle<(Vec<Recorded>, usize)>,
    http: Http,
    store: Arc<FakeStore>,
}

#[allow(clippy::too_many_arguments)]
fn harness(
    label: &str,
    provider_key: &str,
    api_suffix: &str,
    discovery: Vec<Reply>,
    tail: impl FnOnce(&str) -> Vec<Reply>,
    token: Option<&str>,
    body_limit: usize,
    timeout_ms: u64,
) -> Harness {
    let (listener, base) = bind_server();
    let mut replies = discovery;
    replies.extend(tail(&base));
    let server = serve_on(listener, replies);
    let fixture = crate::test_support::git_fixture(label);
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", format!("{base}/acme/app.git"))],
            tracked: true,
            upstream: None,
        },
    );
    let key = format!("{provider_key}|{base}/{api_suffix}");
    let store = match token {
        Some(secret) => FakeStore::with_token(&key, secret),
        None => Arc::new(FakeStore::default()),
    };
    Harness {
        fixture,
        backend,
        dir,
        base,
        server,
        http: http_with(body_limit, timeout_ms),
        store,
    }
}

impl Harness {
    fn path(&self) -> String {
        repo_key(&self.dir)
    }

    async fn create(
        &self,
        title: &str,
        target: &str,
        body: &str,
    ) -> Result<CreateDecision, AppError> {
        let input = CreateInput {
            path: self.path(),
            remote: Some("origin".to_string()),
            target_branch: target.to_string(),
            title: title.to_string(),
            body: body.to_string(),
        };
        create_with(&self.backend, input, 0, 1, &self.http, self.store.as_ref()).await
    }

    fn finish(self) -> (Vec<Recorded>, usize) {
        drop(self.fixture);
        self.server.join().unwrap()
    }
}

fn created(decision: CreateDecision) -> ChangeRequestOutcome {
    match decision {
        CreateDecision::Created(outcome) => outcome,
        CreateDecision::Fallback(_) => panic!("预期创建成功，实际得到网页回退"),
    }
}

fn fallback(decision: CreateDecision) -> FallbackPending {
    match decision {
        CreateDecision::Fallback(pending) => pending,
        CreateDecision::Created(outcome) => {
            panic!("预期网页回退，实际创建成功：{}", outcome.url)
        }
    }
}

#[tokio::test]
async fn github_enterprise_create_sends_bearer_and_accepts_201_link() {
    const TOKEN: &str = "gh-token-1234567890";
    let probe = harness(
        "cr-github-create",
        "github",
        "api/v3",
        github_enterprise_discovery(),
        |base| {
            vec![
                reply(200, &filled("{\"html_url\":\"{base}/acme/app\",\"default_branch\":\"main\"}", base)),
                reply(201, &filled(GITHUB_CREATED, base)),
            ]
        },
        Some(TOKEN),
        512 * 1024,
        2000,
    );
    let base = probe.base.clone();
    let outcome = created(probe.create("标题", "main", "描述").await.unwrap());
    assert_eq!(outcome.status, "created");
    assert_eq!(outcome.url, format!("{base}/acme/app/pull/7"));
    assert_eq!(outcome.provider, "github");
    assert_eq!(outcome.repository, "acme/app");
    assert_eq!(outcome.source_branch, "feature");
    assert_eq!(outcome.target_branch, "main");
    assert!(!outcome.web_prefilled);

    let (requests, extra) = probe.finish();
    assert_eq!(extra, 0, "创建不得自动重试");
    assert_eq!(requests.len(), 3);
    // 发现探测不带认证头。
    assert_eq!(requests[0].path, "/api/v3/meta");
    assert!(requests[0].header("authorization").is_none());
    assert_eq!(requests[1].path, "/api/v3/repos/acme/app");
    assert_eq!(requests[1].header("authorization"), Some(&format!("Bearer {TOKEN}")[..]));
    assert_eq!(requests[2].method, "POST");
    assert_eq!(requests[2].path, "/api/v3/repos/acme/app/pulls");
    let body = requests[2].json();
    assert_eq!(body["head"], "feature");
    assert_eq!(body["base"], "main");
    assert_eq!(body["title"], "标题");
    assert_eq!(body["body"], "描述");
    assert!(requests
        .iter()
        .all(|request| !request.path.contains(TOKEN)));
}

#[tokio::test]
async fn gitlab_create_sends_private_token_and_accepts_201_link() {
    const TOKEN: &str = "glpat-abcdefghijklmnopqrst";
    let probe = harness(
        "cr-gitlab-create",
        "gitlab",
        "api/v4",
        gitlab_discovery(),
        |base| {
            vec![
                reply(200, &filled(GITLAB_META, base)),
                reply(201, &filled(GITLAB_CREATED, base)),
            ]
        },
        Some(TOKEN),
        512 * 1024,
        2000,
    );
    let base = probe.base.clone();
    let outcome = created(probe.create("标题", "main", "描述").await.unwrap());
    assert_eq!(outcome.status, "created");
    assert_eq!(outcome.url, format!("{base}/acme/app/-/merge_requests/7"));
    assert_eq!(outcome.provider, "gitlab");

    let (requests, extra) = probe.finish();
    assert_eq!(extra, 0);
    assert_eq!(requests.len(), 6);
    assert_eq!(requests[0].path, "/api/v3/meta");
    assert_eq!(requests[1].path, "/api/v1/version");
    assert_eq!(requests[2].path, "/api/v4/version");
    assert_eq!(requests[3].path, "/users/sign_in");
    assert_eq!(requests[4].path, "/api/v4/projects/acme%2Fapp");
    assert_eq!(requests[4].header("PRIVATE-TOKEN"), Some(TOKEN));
    assert!(requests[4].header("authorization").is_none());
    assert_eq!(requests[5].method, "POST");
    assert_eq!(requests[5].path, "/api/v4/projects/acme%2Fapp/merge_requests");
    assert_eq!(requests[5].header("PRIVATE-TOKEN"), Some(TOKEN));
    let body = requests[5].json();
    assert_eq!(body["source_branch"], "feature");
    assert_eq!(body["target_branch"], "main");
    assert_eq!(body["title"], "标题");
    assert_eq!(body["description"], "描述");
}

#[tokio::test]
async fn gitea_create_sends_token_header_and_accepts_201_link() {
    const TOKEN: &str = "gitea-token-1234567890";
    let probe = harness(
        "cr-gitea-create",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |base| {
            vec![
                reply(200, &filled(GITEA_META, base)),
                reply(201, &filled(GITEA_CREATED, base)),
            ]
        },
        Some(TOKEN),
        512 * 1024,
        2000,
    );
    let base = probe.base.clone();
    let outcome = created(probe.create("标题", "main", "").await.unwrap());
    assert_eq!(outcome.url, format!("{base}/acme/app/pulls/7"));

    let (requests, extra) = probe.finish();
    assert_eq!(extra, 0);
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[2].path, "/api/v1/repos/acme/app");
    assert_eq!(requests[2].header("authorization"), Some(&format!("token {TOKEN}")[..]));
    assert_eq!(requests[3].path, "/api/v1/repos/acme/app/pulls");
    assert_eq!(requests[3].json()["body"], "");
}

#[tokio::test]
async fn ordinary_failures_are_classified_and_never_fall_back() {
    for (status, expected) in [
        (401, "change_request_auth"),
        (403, "change_request_permission"),
        // 孤立 404 是普通失败：不当作“不支持”，也不打开网页。
        (404, "change_request_not_found"),
        (409, "change_request_conflict"),
        (422, "change_request_invalid"),
        (429, "change_request_rate_limited"),
        (500, "change_request_unknown"),
        (302, "change_request_unknown"),
        (200, "change_request_unknown"),
    ] {
        let probe = harness(
            "cr-failure",
            "gitea",
            "api/v1",
            gitea_discovery(),
            |base| {
                vec![
                    reply(200, &filled(GITEA_META, base)),
                    reply(status, "{\"message\":\"boom\"}"),
                ]
            },
            Some("gitea-token-1234567890"),
            512 * 1024,
            2000,
        );
        let error = match probe.create("标题", "main", "").await {
            Ok(decision) => panic!(
                "HTTP {status} 不应产生创建或回退结果：{}",
                match decision {
                    CreateDecision::Created(outcome) => outcome.url,
                    CreateDecision::Fallback(pending) => pending.url,
                }
            ),
            Err(error) => error,
        };
        assert_eq!(error.code, expected, "HTTP {status}: {}", error.message);
        let (requests, _) = probe.finish();
        assert_eq!(requests.len(), 4, "HTTP {status} 只发一次创建请求");
    }
}

#[tokio::test]
async fn repository_meta_failure_is_ordinary_and_never_falls_back() {
    let probe = harness(
        "cr-meta-failure",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |_| vec![reply(404, "{\"message\":\"Not Found\"}")],
        Some("gitea-token-1234567890"),
        512 * 1024,
        2000,
    );
    let error = match probe.create("标题", "main", "").await {
        Ok(_) => panic!("仓库不可见时不得当作成功"),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_not_found");
    let (requests, extra) = probe.finish();
    assert_eq!(requests.len(), 3);
    assert_eq!(extra, 0);
}

#[tokio::test]
async fn only_method_not_allowed_or_not_implemented_opens_the_web_fallback() {
    for status in [405, 501] {
        let probe = harness(
            "cr-unsupported",
            "gitea",
            "api/v1",
            gitea_discovery(),
            |base| {
                vec![
                    reply(200, &filled(GITEA_META, base)),
                    reply(status, "{\"message\":\"unsupported\"}"),
                ]
            },
            Some("gitea-token-1234567890"),
            512 * 1024,
            2000,
        );
        let base = probe.base.clone();
        let pending = fallback(probe.create("标题", "main", "描述").await.unwrap());
        assert_eq!(
            pending.url,
            format!(
                "{base}/acme/app/compare/main...feature?expand=1&title=%E6%A0%87%E9%A2%98&body=%E6%8F%8F%E8%BF%B0"
            )
        );
        assert!(pending.web_prefilled);
        assert_eq!(pending.repository, "acme/app");
        let (requests, extra) = probe.finish();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[3].method, "POST");
        assert_eq!(extra, 0);
    }
}

#[tokio::test]
async fn post_timeout_after_send_reports_unknown_result() {
    let probe = harness(
        "cr-timeout",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |base| {
            vec![
                reply(200, &filled(GITEA_META, base)),
                reply(201, "{}").slow(400),
            ]
        },
        Some("gitea-token-1234567890"),
        512 * 1024,
        150,
    );
    let error = match probe.create("标题", "main", "").await {
        Ok(decision) => panic!("超时不能算成功：{:?}", match decision {
            CreateDecision::Created(outcome) => outcome.url,
            CreateDecision::Fallback(pending) => pending.url,
        }),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_unknown");
    assert!(error.message.contains("结果未知"), "{}", error.message);
    probe.finish();
}

#[tokio::test]
async fn oversized_response_is_stopped_before_parsing() {
    let probe = harness(
        "cr-oversized",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |base| {
            vec![reply(
                200,
                &format!(
                    "{{\"html_url\":\"{base}/acme/app\",\"pad\":\"{}\"}}",
                    "x".repeat(400)
                ),
            )]
        },
        Some("gitea-token-1234567890"),
        128,
        2000,
    );
    let error = match probe.create("标题", "main", "").await {
        Ok(_) => panic!("超过读取上限的响应不得当作仓库信息"),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_unknown");
    assert!(error.message.contains("上限"), "{}", error.message);
    let (requests, _) = probe.finish();
    assert_eq!(requests.len(), 3);
}

#[tokio::test]
async fn platform_error_text_is_redacted_before_reaching_the_user() {
    const TOKEN: &str = "gitea-token-1234567890";
    let probe = harness(
        "cr-redacted",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |base| {
            vec![
                reply(200, &filled(GITEA_META, base)),
                // 恶意或健谈的服务把令牌回显在错误里，界面文本也不能带出来。
                reply(
                    422,
                    "{\"message\":\"invalid token gitea-token-1234567890\"}",
                ),
            ]
        },
        Some(TOKEN),
        512 * 1024,
        2000,
    );
    let error = match probe.create("标题", "main", "").await {
        Ok(_) => panic!("422 不能当作成功"),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_invalid");
    assert!(!error.message.contains(TOKEN), "{}", error.message);
    assert!(!error.message.contains("Authorization"), "{}", error.message);
    probe.finish();
}

#[tokio::test]
async fn missing_token_or_broken_store_never_opens_web() {
    let missing = harness(
        "cr-missing-token",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |_| Vec::new(),
        None,
        512 * 1024,
        2000,
    );
    let error = match missing.create("标题", "main", "").await {
        Ok(_) => panic!("没有令牌不能创建"),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_token_missing");
    assert!(error.message.contains("配置"), "{}", error.message);
    let (requests, extra) = missing.finish();
    assert_eq!(requests.len(), 2, "缺少令牌时只做了平台发现");
    assert!(requests.iter().all(|request| request.method == "GET"));
    assert_eq!(extra, 0);

    let mut broken = harness(
        "cr-store-broken",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |_| Vec::new(),
        Some("gitea-token-1234567890"),
        512 * 1024,
        2000,
    );
    broken.store = FakeStore::failing();
    let error = match broken.create("标题", "main", "").await {
        Ok(_) => panic!("钥匙串失败不能创建"),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_credential_store");
    assert!(!error.message.contains("gitea-token"));
    broken.finish();
}
