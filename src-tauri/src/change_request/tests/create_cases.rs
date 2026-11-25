//! 三平台创建请求、201 结果、失败分类、超时、响应上限与保守回退。

use crate::error::AppError;

use super::*;

const TOKEN: &str = "gitea-token-1234567890";

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
    let server = serve_on(listener, replies);
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
        create_with(&self.backend, input, 0, 1, &self.http, self.store.as_ref(), None).await
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
async fn changes_to_prepared_source_are_rejected_before_token_access() {
    for changed_branch in [true, false] {
        let probe = harness(
            "cr-stale-source", "gitea", "api/v1", gitea_discovery(),
            |_| vec![], Some(TOKEN), 1024 * 1024, 1500,
        );
        let path = probe.path();
        let git = LocalReader { backend: &probe.backend, path: &path, generation: 0, request_id: 1 };
        let input = CreateInput {
            path: path.clone(), remote: Some("origin".into()), target_branch: "main".into(),
            title: "Deploy feature".into(), body: String::new(),
        };
        let expected = ExpectedSource {
            provider: "gitea".into(),
            host: probe.base.trim_start_matches("http://").into(),
            repository: "acme/app".into(),
            repository_web: if changed_branch { format!("{}/acme/app", probe.base) }
                else { "http://127.0.0.1:1/acme/app".into() },
            source_branch: if changed_branch { "old-feature" } else { "feature" }.into(),
            gitlab_instance: None,
        };
        let error = create_for(&git, &input, &probe.http, probe.store.as_ref(), Some(&expected))
            .await.expect_err("stale source");
        assert_eq!(error.code, "change_request_stale");
        assert_eq!(probe.store.loads(), 0);
        let (requests, extra) = probe.finish();
        assert_eq!(requests.len(), 2);
        assert_eq!(extra, 0);
        assert!(requests.iter().all(|request| request.method == "GET" && request.header("Authorization").is_none()));
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
async fn manual_gitlab_uses_web_port_and_prefix_for_an_ssh_remote() {
    let (listener, origin) = bind_server();
    let instance = format!("{origin}/tools/forge/gitlab");
    let web_url = format!("{instance}/team/sub/app");
    let mr_url = format!("{web_url}/-/merge_requests/7");
    let fixture = crate::test_support::git_fixture("cr-gitlab-manual");
    let backend = fixture.backend();
    enable(&backend);
    let clone_url = "ssh://git@ssh-alias.example.invalid:2222/team/sub/app.git";
    let dir = seed_repo(&fixture, RepoOptions {
        branch: "feature",
        remotes: vec![("origin", clone_url.into())],
        tracked: true,
        upstream: None,
    });
    let path = repo_key(&dir);
    let http = http_with(512 * 1024, 1500);
    let prepared = prepare_with(&backend, &path, None, 0, 1, &http, Some(&instance)).await.unwrap();
    assert_eq!(prepared.repository, "team/sub/app");
    assert_eq!(prepared.repository_web, web_url);
    let expected = ExpectedSource {
        provider: prepared.provider,
        host: prepared.host,
        repository: prepared.repository,
        repository_web: prepared.repository_web,
        source_branch: prepared.source_branch,
        gitlab_instance: prepared.gitlab_instance,
    };
    let store = FakeStore::default();
    set_token_with(&backend, &path, "origin", TOKEN, 0, 2, &http, &store, Some(&expected)).await.unwrap();
    assert_eq!(store.stored(&format!("gitlab|{instance}/api/v4")).as_deref(), Some(TOKEN));

    git(&dir, &["remote", "set-url", "origin", "ssh://git@different-alias.example.invalid:2222/team/sub/app.git"]);
    let error = token_status_with(&backend, &path, "origin", 0, 3, &http, &store, Some(&expected)).await.unwrap_err();
    assert_eq!(error.code, "change_request_stale");
    assert_eq!(store.loads(), 0);
    git(&dir, &["remote", "set-url", "origin", clone_url]);

    let server = serve_on(listener, vec![
        reply(200, &serde_json::json!({ "web_url": format!("{instance}/other/app") }).to_string()),
        reply(200, &serde_json::json!({ "web_url": web_url }).to_string()),
        reply(201, &serde_json::json!({ "web_url": mr_url }).to_string()),
    ]);

    let input = || CreateInput {
        path: path.clone(),
        remote: Some("origin".into()),
        target_branch: "main".into(),
        title: "Change from SSH worktree".into(),
        body: String::new(),
    };
    let error = create_with(&backend, input(), 0, 4, &http, &store, Some(&expected)).await.unwrap_err();
    assert_eq!(error.code, "change_request_gitlab_project");
    let outcome = created(create_with(&backend, input(), 0, 5, &http, &store, Some(&expected)).await.unwrap());
    assert_eq!(outcome.url, mr_url);

    let (requests, extra) = server.join().unwrap();
    assert_eq!(extra, 0);
    assert_eq!(requests.iter().map(|request| request.method.as_str()).collect::<Vec<_>>(), ["GET", "GET", "POST"]);
    assert_eq!(requests[0].path, "/tools/forge/gitlab/api/v4/projects/team%2Fsub%2Fapp");
    assert_eq!(requests[2].path, "/tools/forge/gitlab/api/v4/projects/team%2Fsub%2Fapp/merge_requests");
    assert!(requests.iter().all(|request| request.header("PRIVATE-TOKEN") == Some(TOKEN)));
    assert_eq!(requests[2].json()["source_branch"], "feature");
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
    const TOKEN: &str = "gitea-token-1234567890";
    for (status, expected) in [
        (401, "change_request_auth"),
        (403, "change_request_permission"),
        // 创建 404 但列表路由可用（探测 200）：仍是普通失败，不打开网页。
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
                let mut replies = vec![
                    reply(200, &filled(GITEA_META, base)),
                    reply(status, "{\"message\":\"boom\"}"),
                ];
                if status == 404 {
                    // 创建 404 之后一定会做一次列表探测：列表本身可用，说明
                    // 路由存在，因此仍是普通失败，不构成能力不支持的证据。
                    replies.push(reply(200, "[]"));
                }
                replies
            },
            Some(TOKEN),
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
        let (requests, extra) = probe.finish();
        let expected_requests = if status == 404 { 5 } else { 4 };
        assert_eq!(
            requests.len(),
            expected_requests,
            "HTTP {status} 只发一次创建请求"
        );
        assert_eq!(extra, 0, "HTTP {status} 不得自动重试");
        assert_eq!(
            requests.iter().filter(|request| request.method == "POST").count(),
            1,
            "HTTP {status} 只允许一次 POST"
        );
        if status == 404 {
            // 探测是同一集合路由的 GET，且沿用同一份认证。
            assert_eq!(requests[4].method, "GET");
            assert_eq!(requests[4].path, "/api/v1/repos/acme/app/pulls");
            assert_eq!(
                requests[4].header("authorization"),
                Some(&format!("token {TOKEN}")[..])
            );
        }
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
async fn create_404_with_missing_list_route_falls_back() {
    // 旧实例缺少创建路由时会回 404；同一条集合路由的 GET 也缺失才算能力证据。
    for status in [404, 405, 501] {
        let probe = harness(
            "cr-route-missing",
            "gitea",
            "api/v1",
            gitea_discovery(),
            |base| {
                vec![
                    reply(200, &filled(GITEA_META, base)),
                    reply(404, "{\"message\":\"Not Found\"}"),
                    reply(status, "{\"message\":\"unsupported\"}"),
                ]
            },
            Some(TOKEN),
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
        let (requests, extra) = probe.finish();
        assert_eq!(extra, 0, "探测不能带来重试");
        assert_eq!(requests.len(), 5, "探测只多一次 GET");
        assert_eq!(
            requests.iter().filter(|request| request.method == "POST").count(),
            1,
            "POST 只发一次，不因探测重发创建请求"
        );
        assert_eq!(requests[4].method, "GET");
        assert_eq!(requests[4].path, "/api/v1/repos/acme/app/pulls");
        assert_eq!(
            requests[4].header("authorization"),
            Some(&format!("token {TOKEN}")[..])
        );
    }
}

#[tokio::test]
async fn create_404_with_usable_or_unclear_list_route_never_falls_back() {
    // 列表路由可用、认证/权限/限流/未知响应都不能证明创建路由缺失。
    for status in [200, 401, 403, 429, 500] {
        let probe = harness(
            "cr-route-present",
            "gitea",
            "api/v1",
            gitea_discovery(),
            |base| {
                vec![
                    reply(200, &filled(GITEA_META, base)),
                    reply(404, "{\"message\":\"Not Found\"}"),
                    reply(status, "[]"),
                ]
            },
            Some(TOKEN),
            512 * 1024,
            2000,
        );
        let error = match probe.create("标题", "main", "描述").await {
            Ok(decision) => panic!(
                "列表路由 HTTP {status} 不构成能力证据：{}",
                match decision {
                    CreateDecision::Created(outcome) => outcome.url,
                    CreateDecision::Fallback(pending) => pending.url,
                }
            ),
            Err(error) => error,
        };
        assert_eq!(error.code, "change_request_not_found", "HTTP {status}");
        let (requests, extra) = probe.finish();
        assert_eq!(extra, 0, "HTTP {status} 不得自动重试");
        assert_eq!(requests.len(), 5, "HTTP {status} 只多一次探测 GET");
        assert_eq!(
            requests.iter().filter(|request| request.method == "POST").count(),
            1,
            "HTTP {status} 只允许一次 POST"
        );
    }
}

#[tokio::test]
async fn route_probe_network_failure_never_falls_back() {
    // 探测本身中断时没有能力证据：保持普通失败，也不报告结果未知。
    let probe = harness(
        "cr-route-network",
        "gitea",
        "api/v1",
        gitea_discovery(),
        |base| {
            vec![
                reply(200, &filled(GITEA_META, base)),
                reply(404, "{\"message\":\"Not Found\"}"),
                reply(200, "[]").slow(400),
            ]
        },
        Some(TOKEN),
        512 * 1024,
        150,
    );
    let error = match probe.create("标题", "main", "描述").await {
        Ok(decision) => panic!(
            "探测超时不能回退：{}",
            match decision {
                CreateDecision::Created(outcome) => outcome.url,
                CreateDecision::Fallback(pending) => pending.url,
            }
        ),
        Err(error) => error,
    };
    assert_eq!(error.code, "change_request_not_found");
    let (requests, extra) = probe.finish();
    assert_eq!(extra, 0);
    assert_eq!(
        requests.iter().filter(|request| request.method == "POST").count(),
        1,
        "探测失败也不能重发 POST"
    );
}

#[tokio::test]
async fn route_probe_asks_each_provider_list_route_with_the_same_auth() {
    struct Case {
        label: &'static str,
        provider: &'static str,
        api: &'static str,
        discovery: fn() -> Vec<Reply>,
        meta: &'static str,
        list_path: &'static str,
        auth_name: &'static str,
        auth_value: &'static str,
    }
    let cases = [
        Case {
            label: "cr-probe-github",
            provider: "github",
            api: "api/v3",
            discovery: github_enterprise_discovery,
            meta: "{\"html_url\":\"{base}/acme/app\",\"default_branch\":\"main\"}",
            list_path: "/api/v3/repos/acme/app/pulls",
            auth_name: "authorization",
            auth_value: "Bearer gitea-token-1234567890",
        },
        Case {
            label: "cr-probe-gitlab",
            provider: "gitlab",
            api: "api/v4",
            discovery: gitlab_discovery,
            meta: GITLAB_META,
            list_path: "/api/v4/projects/acme%2Fapp/merge_requests",
            auth_name: "PRIVATE-TOKEN",
            auth_value: "gitea-token-1234567890",
        },
        Case {
            label: "cr-probe-gitea",
            provider: "gitea",
            api: "api/v1",
            discovery: gitea_discovery,
            meta: GITEA_META,
            list_path: "/api/v1/repos/acme/app/pulls",
            auth_name: "authorization",
            auth_value: "token gitea-token-1234567890",
        },
    ];
    for case in cases {
        let reply_meta = case.meta;
        let probe = harness(
            case.label,
            case.provider,
            case.api,
            (case.discovery)(),
            |base| {
                vec![
                    reply(200, &filled(reply_meta, base)),
                    reply(404, "{\"message\":\"Not Found\"}"),
                    reply(404, "{\"message\":\"Not Found\"}"),
                ]
            },
            Some(TOKEN),
            512 * 1024,
            2000,
        );
        let base = probe.base.clone();
        let pending = fallback(probe.create("标题", "main", "描述").await.unwrap());
        assert!(
            pending.url.starts_with(&format!("{base}/acme/app")),
            "{} 回退到该实例的创建网页：{}",
            case.label,
            pending.url
        );
        let (requests, extra) = probe.finish();
        assert_eq!(extra, 0, "{} 不得自动重试", case.label);
        let posts = requests
            .iter()
            .filter(|request| request.method == "POST")
            .collect::<Vec<_>>();
        assert_eq!(posts.len(), 1, "{} 只允许一次 POST", case.label);
        // 探测与创建指向同一条集合路由。
        assert_eq!(posts[0].path, case.list_path, "{}", case.label);
        let probed = requests.last().unwrap();
        assert_eq!(probed.method, "GET", "{}", case.label);
        assert_eq!(probed.path, case.list_path, "{}", case.label);
        assert_eq!(
            probed.header(case.auth_name),
            Some(case.auth_value),
            "{} 探测沿用同一份认证",
            case.label
        );
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

#[tokio::test]
async fn remembered_gitlab_instance_is_reused_by_remote_host() {
    let fixture = crate::test_support::git_fixture("cr-gitlab-remembered");
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(&fixture, RepoOptions {
        branch: "feature",
        remotes: vec![("origin", "ssh://git@Git.Remembered.invalid:2222/team/app.git".into())],
        tracked: true,
        upstream: None,
    });
    let path = repo_key(&dir);
    let http = http_with(512 * 1024, 300);
    let instance = "http://gitlab.remembered.invalid:8080/gitlab";
    backend.store.save_gitlab_instance("git.remembered.invalid", instance).unwrap();

    // 没有手填地址：按远程主机（不区分大小写）沿用记住的实例，不再探测网络。
    let prepared = prepare_with(&backend, &path, None, 0, 1, &http, None).await.unwrap();
    assert!(prepared.instance_saved);
    assert_eq!(prepared.remote_host, "git.remembered.invalid");
    assert_eq!(prepared.gitlab_instance_url(), Some(instance));
    assert_eq!(prepared.repository, "team/app");

    // 本次手填的地址优先于记住的配置，也不标成「已记住」。
    let other = "https://other.remembered.invalid";
    let manual = prepare_with(&backend, &path, None, 0, 2, &http, Some(other)).await.unwrap();
    assert!(!manual.instance_saved);
    assert_eq!(manual.gitlab_instance_url(), Some(other));

    // 删除后不再沿用。
    backend.store.delete_gitlab_instance("git.remembered.invalid").unwrap();
    assert!(backend.store.gitlab_instance_for("git.remembered.invalid").is_none());
}

#[tokio::test]
async fn draft_lists_commits_between_remote_tracking_refs() {
    let fixture = crate::test_support::git_fixture("cr-draft");
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(&fixture, RepoOptions {
        branch: "feature",
        remotes: vec![("origin", "https://github.com/acme/app.git".into())],
        tracked: false,
        upstream: None,
    });
    git(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(dir.join("file.txt"), "one\n").unwrap();
    git(&dir, &["commit", "-am", "feat: 第一步", "-m", "正文说明"]);
    std::fs::write(dir.join("file.txt"), "two\n").unwrap();
    git(&dir, &["commit", "-am", "fix: 第二步"]);
    git(&dir, &["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    let path = repo_key(&dir);

    let listed = super::super::draft(&backend, &path, "origin", "feature", "main", 0, 1).await.unwrap();
    assert!(!listed.truncated);
    assert_eq!(listed.commits.len(), 2);
    assert_eq!(listed.commits[0].subject, "fix: 第二步");
    assert_eq!(listed.commits[1].subject, "feat: 第一步");
    assert_eq!(listed.commits[1].body, "正文说明");

    // 目标没有跟踪引用时返回空列表而不是报错。
    let missing = super::super::draft(&backend, &path, "origin", "feature", "develop", 0, 2).await.unwrap();
    assert!(missing.commits.is_empty());

    // 选项样式的分支名直接拒绝，不进入 git 参数。
    assert!(super::super::draft(&backend, &path, "origin", "-x", "main", 0, 3).await.is_err());
}
