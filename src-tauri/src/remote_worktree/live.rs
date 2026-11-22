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
    let ssh = RemoteSsh::with_exec(resources.into(), PathBuf::from("ssh"), Vec::new());
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
    let review = session.agent.rpc("taskReview", json!({"repo":session.repo,"baseline":baseline})).await.unwrap();
    assert_eq!(review["review"]["baselineOid"], baseline);
    assert!(session.status().await.unwrap()["reviewFiles"].is_array());
    println!("Cliora v2 route reopened the same authenticated worktree with a checked task baseline");
    session.agent.close().await;
}
