//! Real SSH smoke for the desktop's direct and Cliora-mediated v2 routes.
//! A supplied SSH profile and Cliora fixture DB identify controlled test
//! targets. Both routes are read-only after any confirmed agent installation.

use super::*;
use std::env;

async fn open(
    helper: Option<&Path>,
    access: &V2Access<'_>,
    mut request: OpenRequest,
    review_source: Option<&review::Source>,
) -> (Box<Session>, Value) {
    let progress = Channel::new(|_| Ok(()));
    let result = connect(helper, &request, None, review_source, &progress, access)
        .await
        .unwrap_or_else(|error| panic!("open {}: {} / {}", request.target_id, error.code, error.message));
    let result = match result {
        Opened::NeedsInstall(offer) => {
            request.allow_install = true;
            connect(helper, &request, Some(offer), review_source, &progress, access)
                .await
                .unwrap_or_else(|error| panic!("install and open: {} / {}", error.code, error.message))
        }
        opened => opened,
    };
    match result {
        Opened::Worktree(session, snapshot) => (session, snapshot),
        Opened::NeedsInstall(_) => panic!("confirmed installation did not open the repository"),
    }
}

async fn platform_evidence(session: &Session) -> Value {
    let hello = session.agent.rpc("hello", json!({})).await.unwrap();
    let (system, architecture) = remote_ssh::platform(
        hello["os"].as_str().unwrap(), hello["arch"].as_str().unwrap(),
    ).expect("reported agent platform");
    json!({"system":system,"architecture":architecture})
}

#[tokio::test]
async fn real_v2_opens_native_and_cliora_task() {
    let Ok(config) = env::var("TWIGLANE_T4_SSH_CONFIG") else {
        println!("Skipped real SSH: TWIGLANE_T4_SSH_CONFIG is unset");
        return;
    };
    let path = env::var("TWIGLANE_T4_SSH_REPO").expect("controlled remote repository");
    let host = env::var("TWIGLANE_T4_SSH_HOST").expect("SSH fixture target alias");
    let user = env::var("TWIGLANE_T4_SSH_USER").expect("SSH fixture user");
    let port = env::var("TWIGLANE_T4_SSH_PORT").expect("SSH fixture port").parse().unwrap();
    let resources = env::var_os("TWIGLANE_AGENT_V2_DIR").expect("signed fixture component directory");
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(dir.path().join("state.json"));
    store.set_remote_ssh_enabled(true).unwrap();
    let peer_helper = env::var("TWIGLANE_T4_PEER_HELPER").unwrap_or_else(|_| {
        let mut path = env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("twiglane");
        if cfg!(windows) {
            path.set_extension("exe");
        }
        path.to_str().expect("built Twiglane desktop executable").into()
    });
    let ssh = RemoteSsh::with_exec(resources.into(), PathBuf::from("ssh"), vec![
        ("TWIGLANE_SSH_TEST_PEER_HELPER".into(), peer_helper),
    ]);
    let access = V2Access::new(&store, &ssh);
    let native = store.save_remote_ssh_target(SshTarget {
        id: "fixture-native".into(),
        display_name: "Direct fixture".into(),
        host,
        user,
        port,
        auth_method: "agent".into(),
        identity_file: None,
        ssh_config: Some(config),
        default_path: Some(path.clone()),
        enabled: true,
        shared_host_id: None,
        revision: 0,
    }).unwrap();
    let request = |target: &Target, review_id, baseline| OpenRequest {
        request_id: Uuid::new_v4().to_string(),
        target_id: target.target_id.clone(),
        target_revision: target.target_revision.clone(),
        path: path.clone(),
        baseline,
        allow_install: false,
        install_confirmation: None,
        review_id,
    };
    let (session, snapshot) = open(None, &access, request(&Target::native(&native), None, None), None).await;
    assert_eq!(session.protocol(), 2);
    assert_eq!(snapshot["root"], path);
    let identity = snapshot["worktreeIdentity"].as_str().unwrap().to_owned();
    let page = session.agent.rpc("history", json!({"repo":session.repo,"limit":10})).await.unwrap();
    let commits = page["page"]["commits"].as_array().unwrap();
    assert!(!commits.is_empty());
    let baseline = commits.last().unwrap()["oid"].as_str().unwrap().to_owned();
    let native_host_identity = session.host_identity.clone();
    let native_journal_identity = session.journal_identity.clone();
    let native_platform = platform_evidence(&session).await;
    let state = RemoteWorktrees::new(dir.path().join("journal"));
    let native_journal = session.journal(&state.data);
    let alternate_pending = Pending {
        review_id: None,
        operation_id: Uuid::new_v4().to_string(),
        op: "commit".into(),
        repo: session.repo.clone(),
        worktree_identity: session.worktree_identity.clone(),
    };
    save_pending(&native_journal, &alternate_pending).unwrap();
    session.agent.close().await;
    println!("Direct v2 route opened the fixture and returned {} historical commits", commits.len());

    let helper = connector().await.expect("configured Cliora fixture connector");
    let targets = list(&helper).await.unwrap();
    let target = targets.iter().find(|target| target.default_path.as_deref() == Some(&path))
        .or_else(|| (targets.len() == 1).then(|| &targets[0]))
        .expect("controlled Cliora fixture target");
    let probe = query(&helper, "probe-v2", Some(target)).await.unwrap();
    let review_id = Uuid::new_v4().to_string();
    let source_session = Uuid::new_v4().to_string();
    let mut url = reqwest::Url::parse("twiglane://remote-review/").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("v", "1"),
        ("reviewId", &review_id),
        ("sessionId", &source_session),
        ("targetId", &target.target_id),
        ("targetRevision", &target.target_revision),
        ("peerRevision", probe["peerRevision"].as_str().unwrap()),
        ("peerIdentity", probe["peerIdentity"].as_str().unwrap()),
        ("worktreeIdentity", &identity),
        ("worktreePath", &path),
        ("baseline", &baseline),
    ]);
    let source = review::Source::parse(url.as_str()).unwrap();
    let request = request(target, Some(review_id), Some(baseline.clone()));
    source.check_request(&request).unwrap();
    let (session, snapshot) = open(Some(&helper), &access, request, Some(&source)).await;
    assert_eq!(session.protocol(), 2);
    assert_eq!(snapshot["worktreeIdentity"], identity);
    assert_eq!(snapshot["baseline"], baseline);
    if env::var_os("TWIGLANE_T4_EXPECT_DISTINCT_HOST_KEYS").is_some() {
        assert_ne!(session.host_identity, native_host_identity, "fixture must negotiate different SSH keys");
    }
    assert_eq!(session.journal_identity, native_journal_identity, "providers reach the same authenticated account");
    assert_eq!(session.journal(&state.data), native_journal);
    assert_eq!(
        find_pending(&state.data, &session).unwrap().unwrap().record.operation_id,
        alternate_pending.operation_id,
    );
    std::fs::remove_file(native_journal).unwrap();
    let cliora_platform = platform_evidence(&session).await;
    let review = session.agent.rpc("taskReview", json!({"repo":session.repo,"baseline":baseline})).await.unwrap();
    assert_eq!(review["review"]["baselineOid"], baseline);
    assert!(session.status().await.unwrap()["reviewFiles"].is_array());
    println!("Cliora v2 route reopened the same authenticated worktree with a checked task baseline");
    session.agent.close().await;

    let legacy_receipt_recovered = if let Ok(legacy_path) = env::var("TWIGLANE_T4_LEGACY_FIXTURE") {
        let legacy: Value = serde_json::from_slice(&std::fs::read(legacy_path).unwrap()).unwrap();
        let mut legacy_request = OpenRequest {
            request_id: Uuid::new_v4().to_string(),
            target_id: Target::native(&native).target_id,
            target_revision: native.revision.to_string(),
            path: legacy["path"].as_str().unwrap().into(),
            baseline: None,
            allow_install: false,
            install_confirmation: None,
            review_id: None,
        };
        let (mut native_session, _) = open(None, &access, legacy_request.clone(), None).await;
        let old_journal = native_session.legacy_journal(
            &state.data, legacy["targetId"].as_str().unwrap(), legacy["peerIdentity"].as_str().unwrap(),
        );
        let mut old_record = Pending {
            review_id: None,
            operation_id: legacy["operationId"].as_str().unwrap().into(),
            op: "stage".into(),
            repo: legacy["repo"].as_str().unwrap().into(),
            worktree_identity: None,
        };
        save_pending(&old_journal, &old_record).unwrap();
        bind_legacy_cliora(&state.data, &mut native_session, &access, &Channel::new(|_| Ok(()))).await;
        let detected = find_pending(&state.data, &native_session).unwrap().unwrap();
        assert_eq!(detected.record.repo, old_record.repo);
        let wrong = recover_pending(&state, &native_session, &old_record.operation_id).await.unwrap();
        assert_eq!(wrong["state"], "unknown");
        assert!(old_journal.is_file());
        old_record.op = legacy["op"].as_str().unwrap().into();
        save_pending(&old_journal, &old_record).unwrap();
        let recovered = recover_pending(&state, &native_session, &old_record.operation_id).await.unwrap();
        assert_eq!(recovered["state"], "completed");
        assert_eq!(recovered["head"], legacy["head"]);
        assert!(!old_journal.exists());
        native_session.agent.close().await;

        legacy_request.target_id = legacy["targetId"].as_str().unwrap().into();
        legacy_request.target_revision = legacy["targetRevision"].as_str().unwrap().into();
        let (cliora_session, _) = open(Some(&helper), &access, legacy_request, None).await;
        save_pending(&old_journal, &old_record).unwrap();
        let recovered = recover_pending(&state, &cliora_session, &old_record.operation_id).await.unwrap();
        assert_eq!(recovered["state"], "completed");
        assert_eq!(recovered["head"], legacy["head"]);
        assert!(!old_journal.exists());
        cliora_session.agent.close().await;
        println!("Legacy v1 commit receipt recovered over both v2 routes, and mismatched operation retained the journal");
        true
    } else {
        false
    };
    println!("Twiglane real SSH evidence: {}", json!({
        "native":native_platform,
        "cliora":cliora_platform,
        "samePeerAndWorktree":true,
        "legacyReceiptRecovered":legacy_receipt_recovered,
    }));
}
