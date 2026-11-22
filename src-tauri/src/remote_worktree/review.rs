//! The remote review protocol has its own authority and never enters a local Git path.
use super::{
    command, connector, connector_capability, list, probe_identity, query, query_command,
    AppError, Managed, OpenRequest, Result, Session,
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

/// 结果阶段回退或重复：reviewed → committed → merged 只能严格递增。
fn conflict() -> AppError {
    AppError::new(
        "conflict",
        "审查结果的阶段必须严格递增（reviewed → committed → merged），本次没有返回给 Cliora。",
    )
}

/// 返回给 Cliora 的结果阶段。顺序本身就是约束：`Ord` 用来判定「必须严格递增」。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Outcome {
    Reviewed,
    Committed,
    Merged,
}

impl Outcome {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "reviewed" => Ok(Self::Reviewed),
            "committed" => Ok(Self::Committed),
            "merged" => Ok(Self::Merged),
            _ => Err(AppError::new(
                "invalid_outcome",
                "审查结果只能是 reviewed、committed 或 merged。",
            )),
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Reviewed => "reviewed",
            Self::Committed => "committed",
            Self::Merged => "merged",
        }
    }
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
    pub(super) fn parse(raw: &str) -> Result<Self> {
        if raw.len() > MAX_URL
            || !(raw.starts_with("twiglane://remote-review?") || raw.starts_with("twiglane://remote-review/?"))
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
    pub(super) fn worktree_identity(&self) -> &str {
        &self.worktree_identity
    }

    fn check_session(&self, session: &Session) -> Result<()> {
        self.check_tree(&session.root, session.worktree_identity.as_deref().unwrap_or(&session.repo))?;
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
    merged: Option<String>,
    /// 最近一次返回给 Cliora 的阶段；下一次必须更靠后，不能回退也不能重复。
    outcome: Option<Outcome>,
    revision: u64,
    /// 已经有一次返回正在复核/送达：期间不放行第二条，避免同一阶段送达两次。
    /// 阶段本身只有在送达成功之后才推进，见 return_review。
    delivering: bool,
    pending_delivery: Option<Delivery>,
}

#[derive(Clone)]
struct Delivery {
    stage: Outcome,
    revision: u64,
    url: Url,
}

impl Entry {
    fn head_for(&self, stage: Outcome) -> Option<&str> {
        match stage {
            Outcome::Reviewed => None,
            Outcome::Committed => self.committed.as_deref(),
            Outcome::Merged => self.merged.as_deref(),
        }
    }

    fn latest(&self) -> Outcome {
        if self.merged.is_some() {
            Outcome::Merged
        } else if self.committed.is_some() {
            Outcome::Committed
        } else {
            Outcome::Reviewed
        }
    }
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
                merged: None,
                outcome: None,
                revision: 0,
                delivering: false,
                pending_delivery: None,
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
    pub(super) fn latest(&mut self, id: &str) -> Option<Outcome> {
        self.entry(id).ok().map(|entry| entry.latest())
    }

    pub(super) fn record_result(&mut self, id: &str, session: &Session, outcome: Outcome, head: &str) -> Option<Outcome> {
        if let Ok(entry) = self.entry(id) {
            if oid(head)
                && entry.source.check_session(session).is_ok()
                && entry
                    .binding
                    .as_ref()
                    .is_some_and(|(_, repo)| repo == &session.repo)
            {
                match outcome {
                    Outcome::Committed => entry.committed = Some(head.to_owned()),
                    Outcome::Merged => entry.merged = Some(head.to_owned()),
                    Outcome::Reviewed => return None,
                }
                return Some(entry.latest());
            }
        }
        None
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

/// `outcome` 由调用方按本次实际进展给出，并在这里核对证据：只有 `reviewed` 可以不
/// 带已记录的提交，`committed`/`merged` 都必须能报出那个提交。
fn returned(
    source: &Source,
    revision: u64,
    outcome: Outcome,
    committed: Option<&str>,
    snapshot: &Value,
) -> Result<Url> {
    source.check_tree(
        snapshot["root"].as_str().unwrap_or_default(),
        snapshot["worktreeIdentity"].as_str().or_else(|| snapshot["repo"].as_str()).unwrap_or_default(),
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
    if outcome != Outcome::Reviewed && committed.is_none() {
        return Err(conflict());
    }
    let mut url = source.event("returned");
    url.query_pairs_mut()
        .append_pair("resultRevision", &revision.to_string())
        .append_pair("outcome", outcome.name())
        .append_pair(
            "worktreeState",
            if files.is_empty() { "clean" } else { "dirty" },
        );
    if let Some(head) = committed.or(observed) {
        url.query_pairs_mut().append_pair("headOid", head);
    }
    Ok(url)
}

/// 下一次返回的阶段必须严格晚于上一次：同阶段重复或不带记录的回退都按 `conflict` 拒绝。
fn next_outcome(previous: Option<Outcome>, requested: Outcome) -> Result<Outcome> {
    if previous.is_some_and(|previous| requested <= previous) {
        return Err(conflict());
    }
    Ok(requested)
}

struct DeliveryGuard<'a> {
    state: &'a super::RemoteWorktrees,
    review_id: &'a str,
}

impl Drop for DeliveryGuard<'_> {
    fn drop(&mut self) {
        if let Some(entry) = self.state.reviews.lock().unwrap().entries.get_mut(self.review_id) {
            entry.delivering = false;
        }
    }
}

async fn receipt(helper: &std::path::Path, source: &Source, revision: u64) -> Result<bool> {
    let mut cmd = command(helper, "review-receipt", None);
    cmd.args([&source.review_id, &source.session_id, &revision.to_string()]);
    query_command(cmd).await?["stored"].as_bool().ok_or_else(|| {
        AppError::new("remote_protocol", "Cliora 返回的审查确认格式无效。")
    })
}

/// 同一 revision 在结果待确认时只重送原载荷，只有 Cliora 落库才推进阶段。
async fn return_review<F>(
    state: &super::RemoteWorktrees,
    review_id: &str,
    session_id: &str,
    requested: Outcome,
    deliver: F,
) -> Result<Outcome>
where
    F: FnOnce(&Url) -> Result<()>,
{
    let session = state.session(session_id)?;
    let check_pending = || {
        let _guard = state.mutations.lock().unwrap();
        if super::read_pending(&session.journal(&state.data), &session.repo)?.is_some() {
            return Err(AppError::new("write_pending", "请先核对远端操作结果，再返回 Cliora。"));
        }
        Ok(())
    };
    check_pending()?;
    let (source, stage, revision, head, previous) = {
        let mut book = state.reviews.lock().unwrap();
        let entry = book.bound(review_id, session_id, &session)?;
        if entry.delivering {
            return Err(AppError::new("remote_busy", "这个审查结果正在返回 Cliora，请稍后重试。"));
        }
        let previous = entry.pending_delivery.clone();
        let (stage, revision) = if let Some(pending) = &previous {
            (pending.stage, pending.revision)
        } else {
            (next_outcome(entry.outcome, requested)?, entry.revision.checked_add(1).ok_or_else(expired)?)
        };
        let head = entry.head_for(stage).map(str::to_owned);
        if previous.is_none() && stage != Outcome::Reviewed && head.is_none() {
            return Err(conflict());
        }
        entry.delivering = true;
        (entry.source.clone(), stage, revision, head, previous)
    };
    let _delivery = DeliveryGuard { state, review_id };
    let helper = connector().await?;
    connector_capability(&helper, "reviewReceipt").await?;
    let already_stored = receipt(&helper, &source, revision).await?;
    if already_stored && previous.is_none() {
        // A restarted Twiglane process must not mistake the receipt for an
        // earlier use of this source and revision for a new delivery.
        return Err(expired());
    }
    if !already_stored {
        let target = list(&helper).await?.into_iter()
            .find(|target| {
                target.target_id == source.target_id && target.target_revision == source.target_revision
                    && target.unavailable_reason.is_none()
            })
            .ok_or_else(mismatch)?;
        let observed = query(&helper, "probe-v2", Some(&target)).await?;
        source.check_peer(
            probe_identity(&observed["peerRevision"])?,
            probe_identity(&observed["peerIdentity"])?,
        )?;
        let url = if let Some(pending) = previous {
            pending.url
        } else {
            let snapshot = tokio::time::timeout(std::time::Duration::from_secs(120), session.status_for(None))
                .await
                .map_err(|_| AppError::new("remote_timeout", "等待远端工作树复核超时，请重试。"))??;
            returned(&source, revision, stage, head.as_deref(), &snapshot)?
        };
        state.session(session_id)?;
        check_pending()?;
        {
            let mut book = state.reviews.lock().unwrap();
            let entry = book.bound(review_id, session_id, &session)?;
            if entry.pending_delivery.is_none() && entry.head_for(stage) != head.as_deref() {
                return Err(expired());
            }
            entry.pending_delivery = Some(Delivery { stage, revision, url: url.clone() });
        }
        deliver(&url)?;
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                if receipt(&helper, &source, revision).await? {
                    return Ok::<(), AppError>(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
            }
        }).await.map_err(|_| AppError::new(
            "review_delivery_unconfirmed",
            "Cliora 尚未确认收到这条审查结果。可以重试，重试会核对并沿用本次结果。",
        ))??;
    }

    let mut book = state.reviews.lock().unwrap();
    if let Some(entry) = book.entries.get_mut(review_id) {
        entry.pending_delivery = None;
        entry.revision = revision;
        entry.outcome = Some(stage);
    }
    Ok(stage)
}

#[tauri::command]
pub async fn remote_review_return<R: Runtime>(
    app: AppHandle<R>,
    state: Managed<'_>,
    review_id: String,
    session_id: String,
    outcome: Option<String>,
) -> Result<&'static str> {
    let requested = outcome.as_deref().map(Outcome::parse).transpose()?.unwrap_or(Outcome::Reviewed);
    return_review(state.inner(), &review_id, &session_id, requested, |url| {
        crate::cliora::open_checked_cliora(&app, url.as_str())
    })
    .await
    .map(Outcome::name)
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
        let actual = returned(&source, 1, Outcome::Committed, Some(&commit), &snapshot).unwrap();
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

    #[test]
    fn a_normalized_windows_review_link_keeps_the_original_source_binding() {
        let raw = source_link().replace("remote-review?", "remote-review/?");
        let mut url = Url::parse(&raw).unwrap();
        let pairs = url.query_pairs().into_owned().collect::<Vec<_>>();
        url.query_pairs_mut().clear().extend_pairs(pairs.into_iter().map(|(name, value)| {
            let path = if name == "worktreePath" { "C:/项目 with spaces/repo".into() } else { value };
            (name, path)
        }));
        let source = Source::parse(url.as_str()).unwrap();
        assert_eq!(source.worktree_path, "C:/项目 with spaces/repo");
        assert!(source.check_peer(&source.peer_revision, &source.peer_identity).is_ok());
        assert!(source.check_tree(&source.worktree_path, &source.worktree_identity).is_ok());
        assert!(source.check_tree("C:/different/repo", &source.worktree_identity).is_err());
        assert!(source.check_tree(&source.worktree_path, &"0".repeat(64)).is_err());
        for invalid in ["C:relative", "C:/../repo", "C:/repo//child", "C:\\repo"] {
            assert!(!super::super::valid_path(invalid, true), "{invalid}");
        }
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
            worktree_identity: None,
            baseline: source.baseline.clone(),
            review_id: Some(source.review_id.clone()),
            hunk_stageable: false,
            // 这条测试只走 v1 内嵌组件：没有 v2 写入令牌，也没有 v2 私有目录。
            agent_version: "v1".into(),
            state_token: std::sync::Mutex::default(),
            _session_dir: None,
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
        let reviewed = returned(&source, 1, Outcome::Reviewed, None, &snapshot).unwrap();
        assert!(reviewed.as_str().contains("outcome=reviewed"));
        assert!(reviewed.as_str().contains("worktreeState=dirty"));
        let operation = Uuid::new_v4().to_string();
        let pending = Pending {
            review_id: Some(source.review_id.clone()),
            operation_id: operation.clone(),
            op: WriteKind::Commit.name().to_owned(),
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
            let url = returned(
                &source,
                2,
                Outcome::Committed,
                e.committed.as_deref(),
                &observed,
            )
            .unwrap();
            assert!(url.as_str().contains("outcome=committed"));
            assert!(url.as_str().contains("worktreeState=clean"));
            assert!(url.as_str().contains(&format!("headOid={head}")));
            // 已记录的提交仍是 headOid：这里只是复核工作树状态，不改变结果阶段。
            let drifted = returned(
                &source,
                3,
                Outcome::Committed,
                e.committed.as_deref(),
                &snapshot,
            )
            .unwrap();
            assert!(drifted.as_str().contains(&format!("headOid={head}")));
            assert!(!drifted
                .as_str()
                .contains(source.baseline.as_deref().unwrap()));
            book.record_result(&other.review_id, &session, Outcome::Committed, &head);
            assert!(book.entry(&other.review_id).unwrap().committed.is_none());
            assert!(book.end(&source.review_id, "cancelled").unwrap().is_none());
            assert!(book.bound(&source.review_id, "local-a", &session).is_err());
        }
        session.agent.close().await;
    }

    /// reviewed → committed → merged 只能严格递增：同阶段重复与回退都是 conflict，
    /// 而 committed/merged 都必须带着这次审查记录的提交。
    #[test]
    fn returned_outcomes_only_advance_and_merged_carries_the_recorded_commit() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/reviews/remote-protocol-v1.json"
        ))
        .unwrap();
        let source = Source::parse(fixtures["requests"][0]["url"].as_str().unwrap()).unwrap();
        let commit = "e".repeat(40);
        let snapshot = json!({
            "root": source.worktree_path, "repo": source.worktree_identity,
            "head": commit, "files": []
        });

        assert_eq!(
            next_outcome(None, Outcome::Reviewed).unwrap(),
            Outcome::Reviewed
        );
        assert_eq!(
            next_outcome(Some(Outcome::Reviewed), Outcome::Committed).unwrap(),
            Outcome::Committed
        );
        assert_eq!(
            next_outcome(Some(Outcome::Committed), Outcome::Merged).unwrap(),
            Outcome::Merged
        );
        for (previous, requested) in [
            (Some(Outcome::Committed), Outcome::Reviewed),
            (Some(Outcome::Reviewed), Outcome::Reviewed),
            (Some(Outcome::Merged), Outcome::Committed),
        ] {
            assert_eq!(
                next_outcome(previous, requested).unwrap_err().code,
                "conflict",
                "{previous:?} -> {requested:?}"
            );
        }
        assert_eq!(Outcome::parse("merged").unwrap(), Outcome::Merged);
        assert_eq!(Outcome::parse("done").unwrap_err().code, "invalid_outcome");

        let merged = returned(&source, 3, Outcome::Merged, Some(&commit), &snapshot).unwrap();
        assert!(merged.as_str().contains("outcome=merged"));
        assert!(merged.as_str().contains("resultRevision=3"));
        assert!(merged.as_str().contains(&format!("headOid={commit}")));
        assert!(merged.as_str().contains("worktreeState=clean"));
        // 没有记录的提交时不能声称已经提交或合并。
        for outcome in [Outcome::Committed, Outcome::Merged] {
            assert_eq!(
                returned(&source, 1, outcome, None, &snapshot).unwrap_err().code,
                "conflict"
            );
        }
    }

    /// 阶段推进必须发生在 Cliora 真正收到结果之后。
    ///
    /// 旧实现拿到锁就写 outcome/revision，随后 connector/list/probe/status/送达任一步失败
    /// 都会让阶段已经前进：同一阶段重试命中 next_outcome 的 conflict，返回动作永久卡死，
    /// 而 Cliora 从未收到结果。这里对 reviewed → committed → merged 三段各做一次
    /// 「复核失败 / 送达失败 → 状态不动 → 同一阶段重试成功」。
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stage_is_recorded_only_after_cliora_receives_the_result() {
        use super::super::{RemoteWorktrees, Session, Target};
        use crate::remote_worktree_transport::AgentTransport;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command as Git;
        use std::sync::Arc;

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

        let mut command = tokio::process::Command::new(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../remote-agent/agent"),
        );
        command.env("XDG_STATE_HOME", root.path().join("state"));
        let agent = AgentTransport::spawn(&mut command).unwrap();
        let mut source = Source::parse(&source_link()).unwrap();
        // 链接里的基线是占位值：open 会核对它在这个工作树里可达，必须换成真实提交。
        source.baseline = Some(git(&["rev-parse", "HEAD"]));
        source.worktree_path = repo.to_str().unwrap().into();
        let opened = agent
            .rpc(
                "open",
                json!({"path": source.worktree_path, "baseline": source.baseline}),
            )
            .await
            .unwrap();
        source.worktree_identity = opened["repo"].as_str().unwrap().into();
        let target: Target = serde_json::from_value(json!({
            "name": "A", "host": "A", "user": "dev", "port": 22, "authMethod": "key",
            "targetId": source.target_id, "targetRevision": source.target_revision,
        }))
        .unwrap();
        let session = Arc::new(Session {
            agent,
            repo: opened["repo"].as_str().unwrap().into(),
            target,
            peer_identity: source.peer_identity.clone(),
            peer_revision: source.peer_revision.clone(),
            root: source.worktree_path.clone(),
            worktree_identity: None,
            baseline: source.baseline.clone(),
            review_id: Some(source.review_id.clone()),
            hunk_stageable: false,
            agent_version: "v1".into(),
            state_token: std::sync::Mutex::default(),
            _session_dir: None,
        });
        let state = RemoteWorktrees::new(root.path().join("journal"));
        let session_id = "local-a".to_string();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), Arc::clone(&session));
        {
            let mut book = state.reviews.lock().unwrap();
            book.prepare(&source).unwrap();
            book.accept(&source.review_id, &session_id, &session)
                .unwrap();
        }

        // 假连接器：源码跳转和落库确认独立，只有后者可推进阶段。
        let helper = root.path().join("helper");
        std::fs::write(
            &helper,
            "#!/bin/sh\ncd -- \"$(dirname \"$0\")\" || exit 1\ncase \"$2\" in\nversion|list|probe-v2|review-receipt) cat \"$2.json\" ;;\n*) exit 1 ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let catalog = json!({"protocol":1,"targets":[{
            "targetId":source.target_id,"name":"A","host":"A","user":"dev",
            "port":22,"authMethod":"key","targetRevision":source.target_revision}]});
        std::fs::write(root.path().join("list.json"), catalog.to_string()).unwrap();
        std::fs::write(root.path().join("version.json"), r#"{"protocol":1,"capabilities":["reviewReceipt"]}"#).unwrap();
        let good = json!({"system":"Linux","pythonVersion":"3.11",
            "peerRevision":source.peer_revision,"peerIdentity":source.peer_identity});
        let broken = json!({"system":"Linux","pythonVersion":"3.11",
            "peerRevision":source.peer_revision,
            "peerIdentity":"e".repeat(64)});
        let write_probe = |value: &Value| {
            std::fs::write(root.path().join("probe-v2.json"), value.to_string()).unwrap();
        };
        let write_receipt = |stored: bool| {
            std::fs::write(root.path().join("review-receipt.json"), json!({"stored":stored}).to_string()).unwrap();
        };
        write_probe(&good);
        // connector() 只认这一个环境变量；本用例独占它，结束时清掉。
        std::env::set_var("TWIGLANE_CLIORA_CONNECTOR", &helper);

        let observed = |state: &RemoteWorktrees| {
            let book = state.reviews.lock().unwrap();
            let entry = book.entries.get(&source.review_id).unwrap();
            (entry.outcome, entry.revision, entry.delivering)
        };
        let mut delivered = 0usize;
        let mut last: Option<String> = None;
        for (stage, need_commit) in [
            (Outcome::Reviewed, false),
            (Outcome::Committed, true),
            (Outcome::Merged, true),
        ] {
            write_receipt(false);
            // committed/merged 都必须有这次审查记录的提交，否则连尝试都只是声称进展。
            if need_commit {
                git(&["commit", "--allow-empty", "-qm", stage.name()]);
                let head = git(&["rev-parse", "HEAD"]);
                state
                    .reviews
                    .lock()
                    .unwrap()
                    .record_result(&source.review_id, &session, stage, &head);
            }
            let before = observed(&state);
            // 1) 复核在送达之前失败：阶段与修订号原地不动，占位也释放，Cliora 没收到任何东西。
            write_probe(&broken);
            let failed = return_review(&state, &source.review_id, &session_id, stage, |url| {
                delivered += 1;
                last = Some(url.to_string());
                Ok(())
            })
            .await;
            assert_eq!(failed.unwrap_err().code, "target_changed", "{stage:?}");
            assert_eq!(observed(&state), before, "{stage:?} 阶段在送达前就前进了");
            assert_eq!(delivered, before.1 as usize, "{stage:?} 未就绪就送达了");

            // 2) 送达本身失败：同样不推进，同一阶段仍可原样重试。
            write_probe(&good);
            let refused = return_review(
                &state,
                &source.review_id,
                &session_id,
                stage,
                |_url: &Url| Err(AppError::new("cliora_unavailable", "Cliora 没有接受返回结果。")),
            )
            .await;
            assert_eq!(refused.unwrap_err().code, "cliora_unavailable", "{stage:?}");
            assert_eq!(observed(&state), before, "{stage:?} 送达失败却前进了阶段");

            // 3) 同一阶段重试：复核通过且送达成功之后才推进一格。
            return_review(&state, &source.review_id, &session_id, stage, |url| {
                delivered += 1;
                last = Some(url.to_string());
                assert_eq!(observed(&state).1, before.1);
                write_receipt(true);
                Ok(())
            })
            .await
            .unwrap();
            let after = observed(&state);
            assert_eq!(after.0, Some(stage));
            assert_eq!(after.1, before.1 + 1, "{stage:?} 送达后只前进一格");
            assert!(!after.2, "{stage:?} 送达结束后占位必须释放");
            assert_eq!(delivered, after.1 as usize);
            let url = last.clone().unwrap();
            assert!(url.contains(&format!("outcome={}", stage.name())), "{url}");
            assert!(url.contains(&format!("resultRevision={}", after.1)), "{url}");
        }
        // 三段都送达之后语义没有放宽：重复同一阶段仍然是 conflict。
        assert_eq!(
            return_review(&state, &source.review_id, &session_id, Outcome::Merged, |_| Ok(()))
                .await
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(observed(&state).0, Some(Outcome::Merged));
        assert_eq!(observed(&state).1, 3);
        std::env::remove_var("TWIGLANE_CLIORA_CONNECTOR");
    }
}
