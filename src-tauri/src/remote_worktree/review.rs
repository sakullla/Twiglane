//! The remote review protocol has its own authority and never enters a local Git path.
use super::{
    connector, list, probe_identity, query, AppError, Managed, OpenRequest, Result, Session,
};
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Runtime};

const MAX_URL: usize = 8192;

fn invalid() -> AppError {
    AppError::new("malformed_request", "Cliora 远端审查链接无效。")
}

fn expired() -> AppError {
    AppError::new(
        "source_expired",
        "远端审查来源已失效，请从原 Cliora 会话重新发起。",
    )
}

fn mismatch() -> AppError {
    AppError::new(
        "target_changed",
        "SSH 主机、远端工作树或审查会话与原来源不符。",
    )
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn oid(value: &str) -> bool {
    hex(value, 40) || hex(value, 64)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub(super) review_id: String,
    session_id: String,
    target_id: String,
    target_revision: String,
    peer_revision: String,
    peer_identity: String,
    worktree_identity: String,
    worktree_path: String,
    baseline: Option<String>,
    /// 可选的一次性同步会话引用：只有引用，没有配置或密码。
    host_sync: Option<String>,
}

/// `hostSync` 只是本次跳转附带的同步会话引用：每次跳转都会换一个新的。
/// 它不参与来源同一性判定，否则同一个 reviewId 重发一次跳转就会被误判成
/// `target_changed`。其余字段仍然逐字段严格比较。
impl PartialEq for Source {
    fn eq(&self, other: &Self) -> bool {
        self.review_id == other.review_id
            && self.session_id == other.session_id
            && self.target_id == other.target_id
            && self.target_revision == other.target_revision
            && self.peer_revision == other.peer_revision
            && self.peer_identity == other.peer_identity
            && self.worktree_identity == other.worktree_identity
            && self.worktree_path == other.worktree_path
            && self.baseline == other.baseline
    }
}

impl Eq for Source {}

impl Source {
    fn parse(raw: &str) -> Result<Self> {
        if raw.len() > MAX_URL
            || !raw.starts_with("twiglane://remote-review?")
            || raw.contains('#')
            || raw.bytes().any(|c| c.is_ascii_whitespace())
            || raw
                .split_once('?')
                .is_none_or(|(_, q)| q.split('&').any(|field| !field.contains('=')))
            || raw.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        // Url::query_pairs implements form decoding, including +. Reject lossy
        // percent or UTF-8 repairs before using its decoded values as identities.
        let mut decoded = Vec::with_capacity(raw.len());
        let mut bytes = raw.bytes();
        while let Some(byte) = bytes.next() {
            if byte == b'%' {
                let mut digit = || {
                    bytes
                        .next()
                        .and_then(|c| (c as char).to_digit(16))
                        .ok_or_else(invalid)
                };
                decoded.push((digit()? * 16 + digit()?) as u8);
            } else {
                decoded.push(byte);
            }
        }
        if std::str::from_utf8(&decoded)
            .map_err(|_| invalid())?
            .chars()
            .any(char::is_control)
        {
            return Err(invalid());
        }
        let url = Url::parse(raw).map_err(|_| invalid())?;
        let mut values = HashMap::new();
        for (key, value) in url.query_pairs() {
            if value.is_empty()
                || values
                    .insert(key.into_owned(), value.into_owned())
                    .is_some()
            {
                return Err(invalid());
            }
        }
        let mut required = |key| values.remove(key).ok_or_else(invalid);
        if required("v")? != "1" {
            return Err(AppError::new(
                "unsupported_version",
                "远端审查协议版本不兼容。",
            ));
        }
        let result = Self {
            review_id: required("reviewId")?,
            session_id: required("sessionId")?,
            target_id: required("targetId")?,
            target_revision: required("targetRevision")?,
            peer_revision: required("peerRevision")?,
            peer_identity: required("peerIdentity")?,
            worktree_identity: required("worktreeIdentity")?,
            worktree_path: required("worktreePath")?,
            baseline: values.remove("baseline"),
            host_sync: values.remove("hostSync"),
        };
        if !values.is_empty()
            || !super::uuid(&result.review_id)
            || !super::uuid(&result.session_id)
            || !hex(&result.target_revision, 64)
            || !hex(&result.peer_revision, 64)
            || !hex(&result.peer_identity, 64)
            || !hex(&result.worktree_identity, 64)
            || !super::valid_path(&result.worktree_path, true)
            || (result.worktree_path != "/"
                && result.worktree_path[1..]
                    .split('/')
                    .any(|p| matches!(p, "" | "." | "..")))
            || result.baseline.as_deref().is_some_and(|v| !oid(v))
            || result.host_sync.as_deref().is_some_and(|v| !hex(v, 64))
        {
            return Err(invalid());
        }
        Ok(result)
    }

    pub(super) fn check_request(&self, r: &OpenRequest) -> Result<()> {
        if self.target_id == r.target_id
            && self.target_revision == r.target_revision
            && self.worktree_path == r.path
            && self.baseline == r.baseline
            && r.review_id.as_ref() == Some(&self.review_id)
        {
            Ok(())
        } else {
            Err(mismatch())
        }
    }
    pub(super) fn check_peer(&self, revision: &str, identity: &str) -> Result<()> {
        if self.peer_revision == revision && self.peer_identity == identity {
            Ok(())
        } else {
            Err(mismatch())
        }
    }
    pub(super) fn check_tree(&self, root: &str, repo: &str) -> Result<()> {
        if self.worktree_path == root && self.worktree_identity == repo {
            Ok(())
        } else {
            Err(mismatch())
        }
    }
    fn check_session(&self, session: &Session) -> Result<()> {
        self.check_tree(&session.root, &session.repo)?;
        self.check_peer(&session.peer_revision, &session.peer_identity)?;
        if self.target_id == session.target.target_id
            && self.target_revision == session.target.target_revision
            && self.baseline == session.baseline
            && session.review_id.as_ref() == Some(&self.review_id)
        {
            Ok(())
        } else {
            Err(mismatch())
        }
    }
    fn event(&self, event: &str) -> Url {
        let mut url = Url::parse("cliora://remote-review").expect("static remote review URL");
        url.query_pairs_mut()
            .append_pair("v", "1")
            .append_pair("event", event)
            .append_pair("reviewId", &self.review_id)
            .append_pair("sessionId", &self.session_id);
        url
    }
}

#[derive(Default)]
pub(super) struct Book {
    entries: HashMap<String, Entry>,
}

struct Entry {
    source: Source,
    // None during installation/connection. A reconnect replaces the local session ID.
    binding: Option<(String, String)>,
    ended: bool,
    committed: Option<String>,
    revision: u64,
}

impl Book {
    fn prepare(&mut self, source: &Source) -> Result<bool> {
        if let Some(entry) = self.entries.get(&source.review_id) {
            return if &entry.source == source {
                Ok(false)
            } else {
                Err(mismatch())
            };
        }
        if self.entries.len() >= 256 {
            return Err(AppError::new(
                "source_capacity",
                "远端审查来源记录已满，请重启 Twiglane。",
            ));
        }
        self.entries.insert(
            source.review_id.clone(),
            Entry {
                source: source.clone(),
                binding: None,
                ended: false,
                committed: None,
                revision: 0,
            },
        );
        Ok(true)
    }
    fn entry(&mut self, id: &str) -> Result<&mut Entry> {
        self.entries
            .get_mut(id)
            .filter(|e| !e.ended)
            .ok_or_else(expired)
    }
    pub(super) fn source(&mut self, id: &str) -> Result<Source> {
        Ok(self.entry(id)?.source.clone())
    }

    fn accept(&mut self, id: &str, session_id: &str, session: &Session) -> Result<Option<Url>> {
        let entry = self.entry(id)?;
        entry.source.check_session(session)?;
        if entry
            .binding
            .as_ref()
            .is_some_and(|(_, repo)| repo != &session.repo)
        {
            return Err(mismatch());
        }
        let first = entry.binding.is_none();
        entry.binding = Some((session_id.into(), session.repo.clone()));
        Ok(first.then(|| entry.source.event("accepted")))
    }
    fn bound(&mut self, id: &str, session_id: &str, session: &Session) -> Result<&mut Entry> {
        let entry = self.entry(id)?;
        entry.source.check_session(session)?;
        if !entry
            .binding
            .as_ref()
            .is_some_and(|(current, repo)| current == session_id && repo == &session.repo)
        {
            return Err(mismatch());
        }
        Ok(entry)
    }
    pub(super) fn check_bound(&mut self, id: &str, sid: &str, session: &Session) -> Result<()> {
        self.bound(id, sid, session).map(|_| ())
    }
    pub(super) fn record_commit(&mut self, id: &str, session: &Session, head: &str) {
        if let Ok(entry) = self.entry(id) {
            if oid(head)
                && entry.source.check_session(session).is_ok()
                && entry
                    .binding
                    .as_ref()
                    .is_some_and(|(_, repo)| repo == &session.repo)
            {
                entry.committed = Some(head.to_owned());
            }
        }
    }
    fn end(&mut self, id: &str, reason: &str) -> Result<Option<Url>> {
        let Some(entry) = self.entries.get_mut(id) else {
            return Err(expired());
        };
        if entry.ended {
            return Ok(None);
        }
        entry.ended = true;
        if entry.binding.is_some() {
            return Ok(None);
        }
        let mut url = entry.source.event("rejected");
        let safe = match reason {
            "busy" | "target_changed" | "invalid_path" | "not_a_worktree" | "cancelled"
            | "invalid_baseline" => reason,
            _ => "open_failed",
        };
        url.query_pairs_mut().append_pair("reason", safe);
        Ok(Some(url))
    }
}

#[tauri::command]
pub async fn remote_review_begin<R: Runtime>(
    app: AppHandle<R>,
    state: Managed<'_>,
    url: String,
) -> Result<Option<Source>> {
    let source = Source::parse(&url)?;
    if !state.reviews.lock().unwrap().prepare(&source)? {
        return Ok(None);
    }
    let opening = source.event("opening");
    if let Err(error) = crate::cliora::notify_checked_cliora(&app, opening.as_str()) {
        state
            .reviews
            .lock()
            .unwrap()
            .entries
            .remove(&source.review_id);
        return Err(error);
    }
    Ok(Some(source))
}

#[tauri::command]
pub async fn remote_review_accept<R: Runtime>(
    app: AppHandle<R>,
    state: Managed<'_>,
    review_id: String,
    session_id: String,
) -> Result<()> {
    let session = state.session(&session_id)?;
    let event = state
        .reviews
        .lock()
        .unwrap()
        .accept(&review_id, &session_id, &session)?;
    if let Some(url) = event {
        crate::cliora::notify_checked_cliora(&app, url.as_str())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_review_end<R: Runtime>(
    app: AppHandle<R>,
    state: Managed<'_>,
    review_id: String,
    reason: String,
) -> Result<()> {
    let event = state.reviews.lock().unwrap().end(&review_id, &reason)?;
    if let Some(url) = event {
        crate::cliora::notify_checked_cliora(&app, url.as_str())?;
    }
    Ok(())
}

fn returned(
    source: &Source,
    revision: u64,
    committed: Option<&str>,
    snapshot: &Value,
) -> Result<Url> {
    source.check_tree(
        snapshot["root"].as_str().unwrap_or_default(),
        snapshot["repo"].as_str().unwrap_or_default(),
    )?;
    let files = snapshot["files"].as_array().ok_or_else(mismatch)?;
    let observed = match snapshot.get("head") {
        Some(Value::Null) => None,
        Some(Value::String(head)) if oid(head) => Some(head.as_str()),
        _ => return Err(mismatch()),
    };
    // A later external checkout cannot become this source's commit. Cliora
    // compares the recorded commit with its own fresh HEAD and flags drift.
    if committed.is_some_and(|head| !oid(head)) {
        return Err(mismatch());
    }
    let mut url = source.event("returned");
    url.query_pairs_mut()
        .append_pair("resultRevision", &revision.to_string())
        .append_pair(
            "outcome",
            if committed.is_some() {
                "committed"
            } else {
                "reviewed"
            },
        )
        .append_pair(
            "worktreeState",
            if files.is_empty() { "clean" } else { "dirty" },
        );
    if let Some(head) = committed.or(observed) {
        url.query_pairs_mut().append_pair("headOid", head);
    }
    Ok(url)
}

#[tauri::command]
pub async fn remote_review_return<R: Runtime>(
    app: AppHandle<R>,
    state: Managed<'_>,
    review_id: String,
    session_id: String,
) -> Result<()> {
    let session = state.session(&session_id)?;
    let check_pending = || {
        let _guard = state.mutations.lock().unwrap();
        if super::read_pending(&session.journal(&state.data), &session.repo)?.is_some() {
            return Err(AppError::new(
                "write_pending",
                "请先核对远端操作结果，再返回 Cliora。",
            ));
        }
        Ok(())
    };
    check_pending()?;
    let (source, revision, committed) = {
        let mut book = state.reviews.lock().unwrap();
        let entry = book.bound(&review_id, &session_id, &session)?;
        entry.revision = entry.revision.checked_add(1).ok_or_else(expired)?;
        (
            entry.source.clone(),
            entry.revision,
            entry.committed.clone(),
        )
    };
    let helper = connector().await?;
    let target = list(&helper)
        .await?
        .into_iter()
        .find(|t| {
            t.target_id == source.target_id
                && t.target_revision == source.target_revision
                && t.unavailable_reason.is_none()
        })
        .ok_or_else(mismatch)?;
    let observed = query(&helper, "probe", Some(&target)).await?;
    source.check_peer(
        probe_identity(&observed["peerRevision"])?,
        probe_identity(&observed["peerIdentity"])?,
    )?;
    let snapshot = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        session.status_for(None),
    )
    .await
    .map_err(|_| AppError::new("remote_timeout", "等待远端工作树复核超时，请重试。"))??;
    let url = returned(&source, revision, committed.as_deref(), &snapshot)?;
    state.session(&session_id)?;
    check_pending()?;
    {
        let mut book = state.reviews.lock().unwrap();
        let entry = book.bound(&review_id, &session_id, &session)?;
        if entry.revision != revision || entry.committed != committed {
            return Err(expired());
        }
    }
    crate::cliora::open_checked_cliora(&app, url.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn shared_remote_review_request_and_return_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/reviews/remote-protocol-v1.json"
        ))
        .unwrap();
        for case in fixtures["requests"].as_array().unwrap() {
            let result = Source::parse(case["url"].as_str().unwrap());
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let source = Source::parse(fixtures["requests"][0]["url"].as_str().unwrap()).unwrap();
        assert_eq!(source.worktree_path, "/srv/任务 + Git");
        let commit = "e".repeat(40);
        let snapshot = json!({
            "root":source.worktree_path,"repo":source.worktree_identity,"head":commit,
            "files":[{"path":"changed","xy":" M"}]
        });
        let actual = returned(&source, 1, Some(&commit), &snapshot).unwrap();
        let expected = Url::parse(fixtures["events"][3]["url"].as_str().unwrap()).unwrap();
        assert_eq!(actual.host_str(), expected.host_str());
        assert_eq!(
            actual
                .query_pairs()
                .collect::<std::collections::BTreeMap<_, _>>(),
            expected
                .query_pairs()
                .collect::<std::collections::BTreeMap<_, _>>()
        );
    }

    fn source_link() -> String {
        let mut u = Url::parse("twiglane://remote-review").unwrap();
        u.query_pairs_mut()
            .append_pair("v", "1")
            .append_pair("reviewId", &Uuid::new_v4().to_string())
            .append_pair("sessionId", &Uuid::new_v4().to_string())
            .append_pair("targetId", "host-a")
            .append_pair("targetRevision", &"a".repeat(64))
            .append_pair("peerRevision", &"b".repeat(64))
            .append_pair("peerIdentity", &"c".repeat(64))
            .append_pair("worktreeIdentity", &"f".repeat(64))
            .append_pair("worktreePath", "/srv/工作 树+one")
            .append_pair("baseline", &"d".repeat(40));
        u.to_string()
    }

    #[test]
    fn parses_only_the_exact_remote_link_contract() {
        let valid = source_link();
        let source = Source::parse(&valid).unwrap();
        assert_eq!(source.worktree_path, "/srv/工作 树+one");
        assert_eq!(source.event("opening").host_str(), Some("remote-review"));
        for bad in [
            valid.replace("twiglane:", "cliora:"),
            valid.replace("remote-review?", "review?"),
            valid.replace("remote-review?", "nobody@remote-review?"),
            format!("{valid}&peerIdentity={}", "d".repeat(64)),
            format!("{valid}&target=other"),
            format!("{valid}#"),
            format!("{valid}&"),
            valid.replace("v=1", "v=2"),
            valid.replace("targetId=host-a", "targetId=%FF"),
            valid.replace("targetId=host-a", "targetId=%ZZ"),
            valid.replace("targetId=host-a", "targetId=h%00"),
            valid.replace("worktreePath=%2F", "worktreePath="),
            valid.replace("worktreePath=%2F", "worktreePath=%2F..%2F"),
            valid.replace("peerRevision=", "wrong="),
            valid.replace("worktreeIdentity=", "wrong="),
            valid.replace("worktreeIdentity=", "worktreeIdentity=z"),
            valid.replace("baseline=", "baseline=z"),
            format!("{valid}&extra={}", "a".repeat(MAX_URL)),
        ] {
            assert!(Source::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn sync_session_reference_is_optional_and_carries_no_secrets() {
        let valid = source_link();
        let plain = Source::parse(&valid).unwrap();
        assert_eq!(plain.host_sync, None, "旧链接不带同步引用仍然有效");
        let reference = "a".repeat(64);
        let source = Source::parse(&format!("{valid}&hostSync={reference}")).unwrap();
        assert_eq!(source.host_sync.as_deref(), Some(reference.as_str()));
        // 前端只从 begin 的回执里读这个引用（camelCase），没有别的入口。
        let payload = serde_json::to_value(&source).unwrap();
        assert_eq!(payload["hostSync"], reference.as_str());
        for bad in [
            format!("{valid}&hostSync={}", "A".repeat(64)),
            format!("{valid}&hostSync={}", "a".repeat(63)),
            format!("{valid}&hostSync={}", "a".repeat(65)),
            format!("{valid}&hostSync="),
            format!("{valid}&hostSync=password%3Dhunter2"),
            format!("{valid}&hostSync={reference}&hostSync={}", "b".repeat(64)),
        ] {
            assert!(Source::parse(&bad).is_err(), "{bad}");
        }
        // 返回事件只回审查事实：同步引用不外溢到返回链接，也没有配置或密码。
        let event = source.event("opening").to_string();
        assert!(!event.contains("hostSync"));
        assert!(!event.contains("hunter2"));
    }

    #[test]
    fn a_new_host_sync_reference_is_not_a_source_change() {
        let valid = source_link();
        let first = Source::parse(&format!("{valid}&hostSync={}", "a".repeat(64))).unwrap();
        let mut book = Book::default();
        assert!(book.prepare(&first).unwrap());
        // 同一个 reviewId 换一次新的同步会话引用：来源没变，不能判成 target_changed。
        let second = Source::parse(&format!("{valid}&hostSync={}", "b".repeat(64))).unwrap();
        assert_eq!(first, second);
        assert_ne!(first.host_sync, second.host_sync);
        assert!(!book.prepare(&second).unwrap(), "同一来源不重复建账");
        assert_eq!(book.source(&first.review_id).unwrap().host_sync, first.host_sync);
        // 其余字段变化仍然算来源不符。
        let mut other = second.clone();
        other.target_revision = "e".repeat(64);
        assert_ne!(first, other);
        assert!(book.prepare(&other).is_err());
    }

    #[test]
    fn replay_does_not_reopen_an_ended_source_or_accept_another_host() {
        let source = Source::parse(&source_link()).unwrap();
        let mut book = Book::default();
        assert!(book.prepare(&source).unwrap());
        assert!(!book.prepare(&source).unwrap());
        let mut other = source.clone();
        other.target_id = "host-b".into();
        assert!(book.prepare(&other).is_err());
        let rejected = book
            .end(&source.review_id, "sensitive explanation")
            .unwrap()
            .unwrap();
        assert!(rejected.as_str().contains("reason=open_failed"));
        assert!(!book.prepare(&source).unwrap());
        assert!(book.source(&source.review_id).is_err());
        assert!(source
            .check_tree("/srv/other", &source.worktree_identity)
            .is_err());
        assert!(source
            .check_peer(&"a".repeat(64), &source.peer_identity)
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_open_checks_peer_before_agent_start_and_canonical_root_afterwards() {
        use super::super::{connect, AGENT};
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::{symlink, PermissionsExt};
        use tauri::ipc::Channel;

        let folder = tempfile::tempdir().unwrap();
        let repo = folder.path().join("real");
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success());
        let alias = folder.path().join("alias");
        symlink(&repo, &alias).unwrap();
        let mut source = Source::parse(&source_link()).unwrap();
        source.worktree_path = alias.to_str().unwrap().into();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
        };
        assert!(git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "base"
        ])
        .status
        .success());
        source.baseline = Some(
            String::from_utf8(git(&["rev-parse", "HEAD"]).stdout)
                .unwrap()
                .trim()
                .into(),
        );
        let executable =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../remote-agent/agent");
        let agent = crate::remote_worktree_transport::AgentTransport::spawn(
            &mut tokio::process::Command::new(executable),
        )
        .unwrap();
        let original = agent.rpc("open", json!({"path":repo})).await.unwrap();
        source.worktree_identity = original["repo"].as_str().unwrap().into();
        agent.close().await;
        let mut request = OpenRequest {
            request_id: Uuid::new_v4().to_string(),
            target_id: source.target_id.clone(),
            target_revision: source.target_revision.clone(),
            path: source.worktree_path.clone(),
            baseline: source.baseline.clone(),
            allow_install: false,
            install_confirmation: None,
            review_id: Some(source.review_id.clone()),
        };
        source.check_request(&request).unwrap();
        let mut other = request.clone();
        other.target_id = "host-b".into();
        assert!(source.check_request(&other).is_err());
        let catalog = json!({"protocol":1, "targets":[{"targetId":"host-a","name":"A","host":"host-a","user":"test","port":22,
                            "authMethod":"key","targetRevision":source.target_revision}]});
        std::fs::write(folder.path().join("list.json"), catalog.to_string()).unwrap();
        let helper = folder.path().join("helper");
        std::fs::write(
            &helper,
            r#"#!/bin/sh
cd -- "$(dirname "$0")" || exit 1
case "$2" in
list|probe) cat "$2.json" ;;
connect) touch started; exec ./agent --stdio ;;
*) exit 1 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(folder.path().join("agent"), AGENT).unwrap();
        std::fs::set_permissions(
            folder.path().join("agent"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let mut probe = json!({"system":"Linux","pythonVersion":"3.11","peerRevision":source.peer_revision,
            "peerIdentity":"e".repeat(64),"agentSha256":format!("{:x}",Sha256::digest(AGENT)),"agentSignature":"fixture"});
        for (expected_peer, agent_started) in [
            ("e".repeat(64), false),
            (source.peer_identity.clone(), true),
        ] {
            probe["peerIdentity"] = json!(expected_peer);
            std::fs::write(folder.path().join("probe.json"), probe.to_string()).unwrap();
            let result = connect(
                &helper,
                &request,
                None,
                Some(&source),
                &Channel::new(|_| Ok(())),
            )
            .await;
            assert_eq!(result.err().unwrap().code, "target_changed");
            assert_eq!(folder.path().join("started").exists(), agent_started);
        }
        source.worktree_path = original["root"].as_str().unwrap().into();
        request.path = source.worktree_path.clone();
        // Same authenticated peer, same canonical path and same reachable commit,
        // but a replacement checkout has a different agent Worktree.key.
        source.worktree_identity = "0".repeat(64);
        let replaced = connect(
            &helper,
            &request,
            None,
            Some(&source),
            &Channel::new(|_| Ok(())),
        )
        .await;
        assert_eq!(replaced.err().unwrap().code, "target_changed");
        source.worktree_identity = original["repo"].as_str().unwrap().into();
        let opened = connect(
            &helper,
            &request,
            None,
            Some(&source),
            &Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        assert!(matches!(opened, super::super::Opened::Worktree(_, _)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_the_original_native_commit_receipt_can_be_returned() {
        use super::super::{
            finish_write, save_pending, Pending, RemoteWorktrees, Target, WriteKind,
        };
        use crate::remote_worktree_transport::AgentTransport;
        use std::process::Command as Git;
        let mut source = Source::parse(&source_link()).unwrap();
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();
        let git = |args: &[&str]| {
            let output = Git::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.invalid"]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        source.worktree_path = repo.to_str().unwrap().into();
        source.baseline = Some(git(&["rev-parse", "HEAD"]));
        std::fs::write(repo.join("a"), "one\n").unwrap();
        git(&["add", "--", "a"]);
        let mut command = tokio::process::Command::new(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../remote-agent/agent"),
        );
        command.env("XDG_STATE_HOME", root.path().join("state"));
        let agent = AgentTransport::spawn(&mut command).unwrap();
        let snapshot = agent
            .rpc(
                "open",
                json!({"path":source.worktree_path,"baseline":source.baseline}),
            )
            .await
            .unwrap();
        let target: Target = serde_json::from_value(
            json!({"name":"A","host":"A","user":"dev","port":22,"authMethod":"key",
            "targetId":source.target_id,"targetRevision":source.target_revision}),
        )
        .unwrap();
        source.worktree_identity = snapshot["repo"].as_str().unwrap().into();
        let session = Session {
            agent,
            repo: snapshot["repo"].as_str().unwrap().into(),
            target,
            peer_identity: source.peer_identity.clone(),
            peer_revision: source.peer_revision.clone(),
            root: source.worktree_path.clone(),
            baseline: source.baseline.clone(),
            review_id: Some(source.review_id.clone()),
        };
        let state = RemoteWorktrees::new(root.path().join("journal"));
        let mut other = source.clone();
        other.review_id = Uuid::new_v4().to_string();
        other.session_id = Uuid::new_v4().to_string();
        {
            let mut book = state.reviews.lock().unwrap();
            book.prepare(&source).unwrap();
            book.prepare(&other).unwrap();
            assert!(book.accept(&other.review_id, "local-a", &session).is_err());
            assert!(book
                .accept(&source.review_id, "local-a", &session)
                .unwrap()
                .is_some());
            assert!(book.bound(&source.review_id, "local-b", &session).is_err());
        }
        let reviewed = returned(&source, 1, None, &snapshot).unwrap();
        assert!(reviewed.as_str().contains("outcome=reviewed"));
        assert!(reviewed.as_str().contains("worktreeState=dirty"));
        let operation = Uuid::new_v4().to_string();
        let pending = Pending {
            review_id: Some(source.review_id.clone()),
            operation_id: operation.clone(),
            op: WriteKind::Commit,
            repo: session.repo.clone(),
        };
        let journal = session.journal(&state.data);
        save_pending(&journal, &pending).unwrap();
        let proof=session.agent.rpc("commit",json!({"repo":session.repo,"operationId":operation,"generation":snapshot["generation"],"message":"recorded"})).await;
        let result = finish_write(&state, &session, &journal, &pending, proof)
            .await
            .unwrap();
        assert_eq!(result["state"], "completed");
        let observed = session.status().await.unwrap();
        let head = git(&["rev-parse", "HEAD"]);
        {
            let mut book = state.reviews.lock().unwrap();
            let e = book.bound(&source.review_id, "local-a", &session).unwrap();
            assert_eq!(e.committed.as_deref(), Some(head.as_str()));
            let url = returned(&source, 2, e.committed.as_deref(), &observed).unwrap();
            assert!(url.as_str().contains("outcome=committed"));
            assert!(url.as_str().contains("worktreeState=clean"));
            assert!(url.as_str().contains(&format!("headOid={head}")));
            let drifted = returned(&source, 3, e.committed.as_deref(), &snapshot).unwrap();
            assert!(drifted.as_str().contains(&format!("headOid={head}")));
            assert!(!drifted
                .as_str()
                .contains(source.baseline.as_deref().unwrap()));
            book.record_commit(&other.review_id, &session, &head);
            assert!(book.entry(&other.review_id).unwrap().committed.is_none());
            assert!(book.end(&source.review_id, "cancelled").unwrap().is_none());
            assert!(book.bound(&source.review_id, "local-a", &session).is_err());
        }
        session.agent.close().await;
    }
}
