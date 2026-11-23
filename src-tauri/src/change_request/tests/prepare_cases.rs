//! prepare 的远程选择、来源分支核验、门禁与按实例令牌状态。

use super::*;

fn token_input(dir: &Path) -> CreateInput {
    CreateInput {
        path: repo_key(dir),
        remote: Some("origin".to_string()),
        target_branch: "main".to_string(),
        title: "标题".to_string(),
        body: String::new(),
    }
}

#[tokio::test]
async fn disabled_switch_blocks_every_command_before_credentials_or_network() {
    let fixture = crate::test_support::git_fixture("cr-disabled");
    let backend = fixture.backend();
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            // 不可达地址：如果门禁之后还有平台请求，这里会变成网络错误。
            remotes: vec![("origin", "http://127.0.0.1:1/acme/app.git".to_string())],
            tracked: true,
            upstream: None,
        },
    );
    let store = FakeStore::with_token("gitea|http://127.0.0.1:1/api/v1", "secret-token");
    let http = http_with(256, 200);

    let error = prepare_with(&backend, &repo_key(&dir), None, 0, 1, &http, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_requests_disabled");

    let error = create_with(&backend, token_input(&dir), 0, 2, &http, store.as_ref(), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_requests_disabled");
    assert_eq!(store.loads(), 0, "关闭时不得读钥匙串");

    let error = set_token_with(
        &backend,
        &repo_key(&dir),
        "origin",
        "secret-token",
        0,
        3,
        &http,
        store.as_ref(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "change_requests_disabled");
    assert_eq!(store.saves(), 0);

    let error = token_status_with(
        &backend,
        &repo_key(&dir),
        "origin",
        0,
        4,
        &http,
        store.as_ref(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "change_requests_disabled");
    assert_eq!(store.loads(), 0);

    let error = delete_token_with(
        &backend,
        &repo_key(&dir),
        "origin",
        0,
        5,
        &http,
        store.as_ref(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "change_requests_disabled");
}

#[tokio::test]
async fn ambiguous_remotes_return_choices_before_any_platform_request() {
    let fixture = crate::test_support::git_fixture("cr-choice");
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            // 两个远程都不可达：返回候选就说明没有向任何实例发过请求。
            remotes: vec![
                ("origin", "http://127.0.0.1:1/acme/app.git".to_string()),
                ("backup", "http://127.0.0.1:1/backup/app.git".to_string()),
            ],
            tracked: true,
            upstream: None,
        },
    );
    let http = http_with(256, 200);
    let prepared = prepare_with(&backend, &repo_key(&dir), None, 0, 1, &http, None)
        .await
        .unwrap();
    assert_eq!(prepared.status, "remoteChoice");
    assert_eq!(prepared.choices.len(), 2);
    let mut names = prepared
        .choices
        .iter()
        .map(|choice| choice.remote.clone())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["backup".to_string(), "origin".to_string()]);
    let origin = prepared
        .choices
        .iter()
        .find(|choice| choice.remote == "origin")
        .unwrap();
    assert_eq!(origin.repository, "acme/app");
    assert_eq!(origin.host, "127.0.0.1");
    assert!(prepared
        .choices
        .iter()
        .all(|choice| choice.provider.is_none()));
    assert!(prepared.provider.is_empty());
    assert!(prepared.repository.is_empty());
    assert!(prepared.source_branch.is_empty());
}

#[tokio::test]
async fn upstream_selects_remote_and_source_branch() {
    let fixture = crate::test_support::git_fixture("cr-upstream");
    let backend = fixture.backend();
    enable(&backend);
    let (base, server) = serve(gitea_discovery());
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![
                ("origin", format!("{base}/acme/app.git")),
                ("backup", "http://127.0.0.1:1/backup/app.git".to_string()),
            ],
            tracked: true,
            upstream: Some("origin/feature"),
        },
    );
    let http = http_with(256, 2000);
    let prepared = prepare_with(&backend, &repo_key(&dir), None, 0, 1, &http, None)
        .await
        .unwrap();
    assert_eq!(prepared.status, "ready");
    assert_eq!(prepared.remote, "origin");
    assert_eq!(prepared.source_branch, "feature");
    assert_eq!(prepared.provider, "gitea");
    assert_eq!(prepared.provider_label, "Gitea");
    assert_eq!(prepared.repository, "acme/app");
    assert_eq!(prepared.repository_web, format!("{base}/acme/app"));
    assert_eq!(prepared.target_branch, "main");
    assert_eq!(prepared.default_branch.as_deref(), Some("main"));
    assert!(prepared.choices.is_empty());

    let (requests, extra) = server.join().unwrap();
    assert_eq!(extra, 0, "发现不应重试");
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.method == "GET"));
    assert!(requests
        .iter()
        .all(|request| request.header("authorization").is_none()));
    assert_eq!(requests[0].path, "/api/v3/meta");
    assert_eq!(requests[1].path, "/api/v1/version");
}

#[tokio::test]
async fn source_not_on_remote_is_refused_without_platform_request() {
    let fixture = crate::test_support::git_fixture("cr-source-missing");
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", "http://127.0.0.1:1/acme/app.git".to_string())],
            tracked: false,
            upstream: None,
        },
    );
    let http = http_with(256, 200);
    let error = prepare_with(&backend, &repo_key(&dir), None, 0, 1, &http, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_request_source_missing");
    assert!(error.message.contains("feature"), "{}", error.message);
    assert!(error.message.contains("推送"), "{}", error.message);

    // 显式选择一个不存在的远程：直接拒绝。
    let error = prepare_with(&backend, &repo_key(&dir), Some("ghost"), 0, 2, &http, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_request_remote_missing");
}

#[tokio::test]
async fn ssh_remote_without_instance_confirmation_fails_closed() {
    // scp-like 地址只能提供 host 与 path：必须经 HTTPS 上的同 host 实例确认。
    // 这里没有实例可达，因此只能得到网络/平台未确认错误，不能猜平台或打开网页。
    let fixture = crate::test_support::git_fixture("cr-ssh-unconfirmed");
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", "git@127.0.0.1:acme/app.git".to_string())],
            tracked: true,
            upstream: None,
        },
    );
    let http = http_with(256, 300);
    let error = prepare_with(&backend, &repo_key(&dir), None, 0, 1, &http, None)
        .await
        .unwrap_err();
    assert!(
        matches!(
            error.code.as_str(),
            "change_request_network" | "change_request_platform_unknown"
        ),
        "{}: {}",
        error.code,
        error.message
    );
}

#[tokio::test]
async fn detached_and_unborn_branches_are_refused() {
    let fixture = crate::test_support::git_fixture("cr-branch-guard");
    let backend = fixture.backend();
    enable(&backend);
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", "http://127.0.0.1:1/acme/app.git".to_string())],
            tracked: true,
            upstream: None,
        },
    );
    let http = http_with(256, 200);
    git(&dir, &["checkout", "--detach"]);
    let error = prepare_with(&backend, &repo_key(&dir), None, 0, 1, &http, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_request_branch");
    assert!(error.message.contains("detached"), "{}", error.message);

    let empty = fixture.repo("empty");
    git(&empty, &["init", "-b", "main"]);
    git(
        &empty,
        &["remote", "add", "origin", "http://127.0.0.1:1/acme/app.git"],
    );
    let error = prepare_with(&backend, &repo_key(&empty), None, 0, 2, &http, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_request_branch");
}

#[tokio::test]
async fn token_status_is_isolated_per_instance_and_never_returns_secret() {
    const SECRET: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    let fixture = crate::test_support::git_fixture("cr-token-isolation");
    let backend = fixture.backend();
    enable(&backend);

    let (base_a, server_a) = serve(gitea_discovery());
    let dir_a = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", format!("{base_a}/acme/app.git"))],
            tracked: true,
            upstream: None,
        },
    );
    let (base_b, server_b) = serve(gitea_discovery());
    let dir_b = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", format!("{base_b}/acme/app.git"))],
            tracked: true,
            upstream: None,
        },
    );

    let key_a = format!("gitea|{base_a}/api/v1");
    let store = FakeStore::with_token(&key_a, SECRET);
    let http = http_with(256, 2000);

    let status_a = token_status_with(
        &backend,
        &repo_key(&dir_a),
        "origin",
        0,
        1,
        &http,
        store.as_ref(),
        None,
    )
    .await
    .unwrap();
    assert!(status_a.configured);
    let json = serde_json::to_string(&status_a).unwrap();
    assert_eq!(json, "{\"configured\":true}");
    assert!(!json.contains(SECRET));

    // 另一个实例的条目不共用同一个令牌。
    let status_b = token_status_with(
        &backend,
        &repo_key(&dir_b),
        "origin",
        0,
        2,
        &http,
        store.as_ref(),
        None,
    )
    .await
    .unwrap();
    assert!(!status_b.configured);
    assert_eq!(store.stored(&key_a).as_deref(), Some(SECRET));

    server_a.join().unwrap();
    server_b.join().unwrap();
}

#[tokio::test]
async fn token_save_and_delete_use_the_instance_key() {
    const SECRET: &str = "gitea-token-1234567890";
    let fixture = crate::test_support::git_fixture("cr-token-roundtrip");
    let backend = fixture.backend();
    enable(&backend);
    // set + status + delete 各自做一次发现（2 次请求）。
    let mut replies = gitea_discovery();
    replies.extend(gitea_discovery());
    replies.extend(gitea_discovery());
    let (base, server) = serve(replies);
    let dir = seed_repo(
        &fixture,
        RepoOptions {
            branch: "feature",
            remotes: vec![("origin", format!("{base}/acme/app.git"))],
            tracked: true,
            upstream: None,
        },
    );
    let key = format!("gitea|{base}/api/v1");
    let store = FakeStore::default();
    let http = http_with(256, 2000);
    let path = repo_key(&dir);

    let saved = set_token_with(
        &backend,
        &path,
        "origin",
        SECRET,
        0,
        1,
        &http,
        &store,
        None,
    )
    .await
    .unwrap();
    assert!(saved.configured);
    assert_eq!(store.stored(&key).as_deref(), Some(SECRET));

    // 令牌不会出现在状态返回值里。
    let status = token_status_with(&backend, &path, "origin", 0, 2, &http, &store, None)
        .await
        .unwrap();
    assert!(status.configured);
    assert!(!serde_json::to_string(&status).unwrap().contains(SECRET));

    let deleted = delete_token_with(&backend, &path, "origin", 0, 3, &http, &store, None)
        .await
        .unwrap();
    assert!(!deleted.configured);
    assert!(store.stored(&key).is_none());

    // 含空白的令牌在写钥匙串之前就被拒绝。
    let error = set_token_with(
        &backend,
        &path,
        "origin",
        "bad token",
        0,
        4,
        &http,
        &store,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "change_request_token_invalid");
    assert_eq!(store.saves(), 1);

    server.join().unwrap();
}

#[tokio::test]
async fn discovery_discards_error_pages_and_shares_one_deadline() {
    let http = http_with(64, 1000);
    let (base, server) = serve(vec![
        reply(404, &"x".repeat(4096)),
        reply(200, "{}").slow(1300),
    ]);
    // 已收到 404，因此实例可达。后续探针耗尽总预算后不能再启动任何请求。
    let error = remote::resolve_repository(&http, &format!("{base}/sub/group/repo"), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "change_request_platform_unknown");
    let (requests, extra) = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(extra, 0);
}
