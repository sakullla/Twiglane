//! cliora 审查集成协议（v2）：`twiglane://review` 入站请求与 `cliora://review` 出站事件。
//!
//! 合同来源是 cliora 仓库的 `docs/integrations/twiglane-review-v2.md`。这里只做纯字符串
//! 解析/生成、固定 scheme 唤起和内存里的审查来源记录：不打开仓库、不读 Git、不落盘，
//! 因此系统 deep link 这种不可信输入在任何 Git 写入之前就会被拒绝。返回时的工作区状态
//! 由命令层按来源工作树读取真实 Git 状态后交给这里生成链接。
//!
//! 长度、控制字符、重复/未知参数、ID/OID 格式都在这里挡掉；路径只做语法校验
//! （绝对路径、长度、`~` 前缀），是否是真正的工作树根由 `open_repository` 在
//! 打开时判定——它要求目录下存在 `.git`，所以子目录不会回退成父仓库。
//!
//! v2 与 v1 不兼容：两端同步升级，收到其他版本一律 `unsupported_version`，没有回退。

use crate::error::AppError;

/// cliora 用来唤起 Twiglane 的 scheme。
pub const SCHEME: &str = "twiglane";
/// Twiglane 回送事件给 cliora 的 scheme。
pub const INBOUND_SCHEME: &str = "cliora";
/// 两个方向的固定 host。
pub const HOST: &str = "review";
/// 协议主版本。
pub const VERSION: &str = "2";
/// 整个 URL 的上限（UTF-8 字节）。
pub const MAX_URL_LEN: usize = 2048;
/// 解码后 worktreePath 的上限（字符）。
pub const MAX_PATH_LEN: usize = 1000;
/// returned 里 `meta.*` 参数的个数上限。
pub const MAX_META_ENTRIES: usize = 8;
/// 每个 meta 值解码后的字符上限。
pub const MAX_META_VALUE_LEN: usize = 128;
/// 扩展元数据参数名的固定前缀。
const META_PREFIX: &str = "meta.";

/// 稳定错误码：既是拒绝回执里的 `reason`，也是前端本地错误的 code。
pub const UNSUPPORTED_VERSION: &str = "unsupported_version";
pub const MALFORMED_REQUEST: &str = "malformed_request";
pub const INVALID_PATH: &str = "invalid_path";
pub const INVALID_RECEIPT: &str = "invalid_receipt";

/// 已校验的 v2 审查请求。字段原样来自链接，不含任何凭据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRequest {
    pub review_id: String,
    pub session_id: String,
    pub worktree_path: String,
    pub baseline: Option<String>,
}

/// 本次审查期间真实完成的 Git 操作。reviewed 表示没有提交或合入，不再表示“只浏览”。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Reviewed,
    Committed,
    Merged,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Reviewed => "reviewed",
            Outcome::Committed => "committed",
            Outcome::Merged => "merged",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "reviewed" => Some(Outcome::Reviewed),
            "committed" => Some(Outcome::Committed),
            "merged" => Some(Outcome::Merged),
            _ => None,
        }
    }
}

/// 返回时 Twiglane 读到的工作区状态，与 outcome 正交。读不到就是 unknown，不能当作 clean。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeState {
    Clean,
    Dirty,
    Unknown,
}

impl WorktreeState {
    pub fn as_str(self) -> &'static str {
        match self {
            WorktreeState::Clean => "clean",
            WorktreeState::Dirty => "dirty",
            WorktreeState::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "clean" => Some(WorktreeState::Clean),
            "dirty" => Some(WorktreeState::Dirty),
            "unknown" => Some(WorktreeState::Unknown),
            _ => None,
        }
    }
}

/// 由返回时真实 `git status` 读到的未提交文件数得出工作区声明。None 表示没有读到
/// （来源已不在记录里、Git 不可用或读取失败），只能是 unknown，绝不当作 clean。
pub fn worktree_state_of(uncommitted: Option<usize>) -> WorktreeState {
    match uncommitted {
        None => WorktreeState::Unknown,
        Some(0) => WorktreeState::Clean,
        Some(_) => WorktreeState::Dirty,
    }
}

/// 内存里最多记住的已接受审查来源条数。更早的 reviewId 返回时读不到来源，只能声明 unknown。
/// 待定（已解析、尚未接受）的链接另有同样大小的上限，互不挤占。
pub const MAX_REVIEW_SOURCES: usize = 8;

/// 一条已解析链接的来源：reviewId、sessionId 与链接指定的工作树。
#[derive(Debug, Clone)]
struct SourceEntry {
    review_id: String,
    session_id: String,
    worktree_path: String,
}

#[derive(Debug, Default)]
struct SourceBook {
    /// 已解析但前端还没接受的链接。只在 accepted 回执时提升为正式来源。
    pending: std::collections::VecDeque<SourceEntry>,
    /// 已被前端接受（真正打开并建立来源）的审查。返回时只按这里读取工作树。
    accepted: std::collections::VecDeque<SourceEntry>,
}

/// 审查来源 reviewId → 工作树路径，只放在内存里（与前端来源一样不落盘）。
///
/// 解析成功只暂存为待定；前端打开成功回送 accepted 时才成为正式来源，被拒绝、被忽略或
/// 打开失败的链接不会改写或挤掉正式来源。同一 reviewId 先到先得：已有正式来源时，
/// 后来的重复链接不会覆盖它。返回时后端按正式来源读取真实工作区状态，前端不声明。
#[derive(Debug, Default)]
pub struct ReviewSources {
    book: std::sync::Mutex<SourceBook>,
}

impl ReviewSources {
    fn lock(&self) -> std::sync::MutexGuard<'_, SourceBook> {
        self.book.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 暂存一条刚解析成功的链接。该 reviewId 已有正式来源或已有待定记录时不改动（先到先得）。
    pub fn stage(&self, review_id: &str, session_id: &str, worktree_path: &str) {
        let mut book = self.lock();
        if book.accepted.iter().any(|entry| entry.review_id == review_id)
            || book.pending.iter().any(|entry| entry.review_id == review_id)
        {
            return;
        }
        book.pending.push_back(SourceEntry {
            review_id: review_id.to_string(),
            session_id: session_id.to_string(),
            worktree_path: worktree_path.to_string(),
        });
        while book.pending.len() > MAX_REVIEW_SOURCES {
            book.pending.pop_front();
        }
    }

    /// 前端接受了这条链接：把 reviewId 与 sessionId 都对得上的待定记录提升为正式来源。
    /// 已有正式来源时保留原记录，不被覆盖；没有对应待定记录时什么也不做。
    pub fn accept(&self, review_id: &str, session_id: &str) {
        let mut book = self.lock();
        let Some(index) = book
            .pending
            .iter()
            .position(|entry| entry.review_id == review_id && entry.session_id == session_id)
        else {
            return;
        };
        let Some(entry) = book.pending.remove(index) else {
            return;
        };
        if book.accepted.iter().any(|existing| existing.review_id == review_id) {
            return;
        }
        book.accepted.push_back(entry);
        while book.accepted.len() > MAX_REVIEW_SOURCES {
            book.accepted.pop_front();
        }
    }

    /// 前端拒绝了这条链接：丢掉对应的待定记录，正式来源不受影响。
    pub fn reject(&self, review_id: &str, session_id: &str) {
        let mut book = self.lock();
        book.pending
            .retain(|entry| !(entry.review_id == review_id && entry.session_id == session_id));
    }

    /// 这次审查被接受时记下的工作树；没有正式来源时返回 None。
    pub fn worktree_for(&self, review_id: &str) -> Option<String> {
        self.lock()
            .accepted
            .iter()
            .find(|entry| entry.review_id == review_id)
            .map(|entry| entry.worktree_path.clone())
    }
}

/// 一次 returned 事件的结构化内容。带 head_oid 的只是待复核声明，成功与否由 cliora 复核。
///
/// `meta` 是有界的说明性元数据：键为 `namespace.name`（不含 `meta.` 前缀），值是短文本事实。
/// 新增结果维度优先放进核心字段或 meta，而不是继续堆位置参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewReturn {
    pub review_id: String,
    pub session_id: String,
    pub outcome: Outcome,
    pub head_oid: Option<String>,
    pub worktree_state: WorktreeState,
    pub meta: Vec<(String, String)>,
}

/// 允许出现在 rejected 回执 reason 里的错误码。
const REASONS: [&str; 5] = [
    UNSUPPORTED_VERSION,
    MALFORMED_REQUEST,
    INVALID_PATH,
    "not_a_worktree",
    "open_failed",
];

/// 解析并校验 `twiglane://review?v=2&...`。错误码直接是拒绝回执的 reason。
pub fn parse_review_url(url: &str) -> Result<ReviewRequest, AppError> {
    if url.len() > MAX_URL_LEN {
        return Err(malformed("链接超过长度上限"));
    }
    if url.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}' || ch == ' ') {
        return Err(malformed("链接含控制字符或未编码空格"));
    }
    let rest = url
        .strip_prefix(SCHEME)
        .and_then(|tail| tail.strip_prefix("://"))
        .ok_or_else(|| malformed("链接不是 twiglane:// 协议"))?;
    if rest.contains('#') {
        return Err(malformed("链接不接受 fragment"));
    }
    let (host, query) = match rest.split_once('?') {
        Some((host, query)) => (host, query),
        None => return Err(malformed("链接缺少查询参数")),
    };
    if !is_host(host) {
        return Err(malformed("链接目标不是 review"));
    }
    let params = parse_query(query)?;
    let version = params
        .iter()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.as_str());
    if version != Some(VERSION) {
        return Err(AppError::new(
            UNSUPPORTED_VERSION,
            "只支持 v2 审查链接，请把 Twiglane 和 cliora 升级到同一协议版本。",
        ));
    }
    let review_id = required(&params, "reviewId")?;
    if !is_id(review_id) {
        return Err(malformed("reviewId 不是合法的标识"));
    }
    let session_id = required(&params, "sessionId")?;
    if !is_id(session_id) {
        return Err(malformed("sessionId 不是合法的标识"));
    }
    let worktree_path = required(&params, "worktreePath")?;
    if !is_worktree_path(worktree_path) {
        return Err(AppError::new(
            INVALID_PATH,
            "审查链接里的工作树路径不是绝对路径。",
        ));
    }
    let baseline = match params.iter().find(|(key, _)| key == "baseline") {
        Some((_, value)) if is_oid(value) => Some(value.clone()),
        Some(_) => return Err(malformed("baseline 不是完整的提交标识")),
        None => None,
    };
    Ok(ReviewRequest {
        review_id: review_id.to_string(),
        session_id: session_id.to_string(),
        worktree_path: worktree_path.to_string(),
        baseline,
    })
}

/// 生成 `accepted` 回执。
pub fn accepted_url(review_id: &str, session_id: &str) -> Result<String, AppError> {
    build_event("accepted", review_id, session_id, &[])
}

/// 生成 `rejected` 回执。reason 只接受协议里的稳定错误码。
pub fn rejected_url(review_id: &str, session_id: &str, reason: &str) -> Result<String, AppError> {
    if !REASONS.contains(&reason) {
        return Err(invalid_receipt("回执的 reason 不在协议错误码里"));
    }
    build_event("rejected", review_id, session_id, &[("reason", reason)])
}

/// 生成 `returned` 事件。committed/merged 必须带完整 headOid，reviewed 不能带；
/// worktreeState 必填；meta 必须符合有界扩展规则。
pub fn returned_url(result: &ReviewReturn) -> Result<String, AppError> {
    let head = match (result.outcome, result.head_oid.as_deref()) {
        (Outcome::Reviewed, None) => None,
        (Outcome::Reviewed, Some(_)) => {
            return Err(invalid_receipt("没有提交或合入的结果不能声明提交标识"));
        }
        (_, Some(oid)) if is_oid(oid) => Some(oid),
        _ => return Err(invalid_receipt("提交或合入的结果必须带完整提交标识")),
    };
    if result.meta.len() > MAX_META_ENTRIES {
        return Err(invalid_receipt("返回事件的扩展元数据过多"));
    }
    let meta_keys: Vec<String> = result
        .meta
        .iter()
        .map(|(key, _)| format!("{META_PREFIX}{key}"))
        .collect();
    for (index, (key, (_, value))) in meta_keys.iter().zip(result.meta.iter()).enumerate() {
        if !is_meta_key(key) || !is_meta_value(value) {
            return Err(invalid_receipt("返回事件的扩展元数据不符合协议"));
        }
        if meta_keys[..index].contains(key) {
            return Err(invalid_receipt("返回事件的扩展元数据有重复键"));
        }
    }
    let mut extras: Vec<(&str, &str)> = vec![("outcome", result.outcome.as_str())];
    if let Some(oid) = head {
        extras.push(("headOid", oid));
    }
    extras.push(("worktreeState", result.worktree_state.as_str()));
    for (key, (_, value)) in meta_keys.iter().zip(result.meta.iter()) {
        extras.push((key.as_str(), value.as_str()));
    }
    let url = build_event("returned", &result.review_id, &result.session_id, &extras)?;
    // 生成端与接收端用同一套规则：生成出来的链接必须能通过入站校验。
    validate_inbound(&url).map_err(|_| invalid_receipt("返回事件不符合协议"))?;
    Ok(url)
}

fn build_event(
    event: &str,
    review_id: &str,
    session_id: &str,
    extras: &[(&str, &str)],
) -> Result<String, AppError> {
    if !is_id(review_id) || !is_id(session_id) {
        return Err(invalid_receipt("事件缺少可用的 reviewId 或 sessionId"));
    }
    let mut url = format!(
        "{INBOUND_SCHEME}://{HOST}?v={VERSION}&event={event}&reviewId={}&sessionId={}",
        encode(review_id),
        encode(session_id),
    );
    for (key, value) in extras {
        url.push('&');
        // 参数名只含未保留字符（meta 键已校验），原样写出。
        url.push_str(key);
        url.push('=');
        url.push_str(&encode(value));
    }
    check_len(url)
}

fn check_len(url: String) -> Result<String, AppError> {
    if url.len() > MAX_URL_LEN {
        return Err(invalid_receipt("回执链接超过长度上限"));
    }
    Ok(url)
}

fn malformed(message: &str) -> AppError {
    AppError::new(MALFORMED_REQUEST, format!("{message}，未做任何修改。"))
}

fn invalid_receipt(message: &str) -> AppError {
    AppError::new(INVALID_RECEIPT, format!("{message}，未回送任何结果。"))
}

fn required<'a>(params: &'a [(String, String)], key: &str) -> Result<&'a str, AppError> {
    params
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| malformed(&format!("链接缺少 {key}")))
}

/// 参数名必须原样出现：不接受把名字写成百分号编码来绕过白名单。
fn raw_name(raw: &str) -> Result<&str, AppError> {
    if raw.is_empty() {
        return Err(malformed("查询串里有空参数名"));
    }
    if !raw
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(malformed("链接参数名含协议之外的字符"));
    }
    Ok(raw)
}

/// 解析请求查询串：重复或未知参数（含 meta）、空参数名、坏百分号编码、非 UTF-8 都失败。
fn parse_query(query: &str) -> Result<Vec<(String, String)>, AppError> {
    let mut params: Vec<(String, String)> = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            return Err(malformed("查询串里有空参数"));
        }
        let (raw_key, raw_value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        let key = raw_name(raw_key)?;
        if !matches!(key, "v" | "reviewId" | "sessionId" | "worktreePath" | "baseline") {
            return Err(malformed("链接含协议之外的参数"));
        }
        if params.iter().any(|(name, _)| name == key) {
            return Err(malformed("链接里同一个参数出现了多次"));
        }
        params.push((key.to_string(), decode(raw_value)?));
    }
    Ok(params)
}

/// 百分号解码：`+` 按字面加号处理，坏的 `%` 序列与非 UTF-8 都失败。
fn decode(raw: &str) -> Result<String, AppError> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| malformed("链接里的百分号编码不完整"))?;
            let text = std::str::from_utf8(hex).map_err(|_| malformed("链接里的百分号编码不完整"))?;
            let byte =
                u8::from_str_radix(text, 16).map_err(|_| malformed("链接里的百分号编码不合法"))?;
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| malformed("链接里的百分号编码不是合法 UTF-8"))
}

/// 百分号编码：未保留字符原样，其余按 UTF-8 大写十六进制。
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 固定 host：`review`，或系统对无路径 URL 规范化出的 `review/`（恰好一个尾斜杠）。
///
/// Windows 把 `twiglane://review?...` 交给应用时会变成 `twiglane://review/?...`，
/// 两者是同一个 host，两端都必须接受；再多的斜杠或任何路径段都不是本协议。
fn is_host(authority: &str) -> bool {
    authority.strip_suffix('/').unwrap_or(authority) == HOST
}

/// RFC 4122 连字符形式：8-4-4-4-12，十六进制。
fn is_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let dashes = [8, 13, 18, 23];
    bytes.iter().enumerate().all(|(index, byte)| {
        if dashes.contains(&index) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

/// 完整对象 ID：恰好 40 位小写十六进制。
fn is_oid(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// 路径只做语法校验：绝对、不以 ~ 开头、1–1000 字符、无控制字符。
fn is_worktree_path(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > MAX_PATH_LEN {
        return false;
    }
    if value.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}') {
        return false;
    }
    if value.starts_with('~') {
        return false;
    }
    std::path::Path::new(value).is_absolute()
}

/// `meta.<namespace>.<name>`：namespace `[a-z][a-z0-9-]{0,31}`，name `[A-Za-z][A-Za-z0-9_-]{0,31}`。
fn is_meta_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix(META_PREFIX) else {
        return false;
    };
    let mut parts = rest.split('.');
    let (Some(namespace), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let namespace_ok = (1..=32).contains(&namespace.len())
        && namespace.as_bytes()[0].is_ascii_lowercase()
        && namespace
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let name_ok = (1..=32).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphabetic()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    namespace_ok && name_ok
}

/// meta 值：解码后 1–128 字符的单行短文本，不含任何控制字符。
fn is_meta_value(value: &str) -> bool {
    let count = value.chars().count();
    (1..=MAX_META_VALUE_LEN).contains(&count) && !value.chars().any(char::is_control)
}

/// 入站（Twiglane → cliora）URL 的完整校验：固定 scheme/host、v2、事件字段组合与 meta 边界。
///
/// 生成端已经走过一遍校验，这里再验一次是为了让“只打开固定 scheme”成立：
/// 即使调用方传进陌生字符串，也不会被当成任意 URL 交给系统。
pub fn validate_inbound(url: &str) -> Result<(), AppError> {
    if url.len() > MAX_URL_LEN {
        return Err(malformed("回执链接超过长度上限"));
    }
    if url
        .chars()
        .any(|ch| ch <= '\u{1f}' || ch == '\u{7f}' || ch == ' ')
    {
        return Err(malformed("回执链接含控制字符或未编码空格"));
    }
    let rest = url
        .strip_prefix(INBOUND_SCHEME)
        .and_then(|tail| tail.strip_prefix("://"))
        .ok_or_else(|| malformed("回执不是 cliora:// 协议"))?;
    if rest.contains('#') {
        return Err(malformed("回执不接受 fragment"));
    }
    let (host, query) = match rest.split_once('?') {
        Some((host, query)) => (host, query),
        None => return Err(malformed("回执缺少查询参数")),
    };
    if !is_host(host) {
        return Err(malformed("回执目标不是 review"));
    }
    let params = parse_inbound_query(query)?;
    if field(&params, "v") != Some(VERSION) {
        return Err(AppError::new(
            UNSUPPORTED_VERSION,
            "回执不是 v2 协议，未打开任何应用。",
        ));
    }
    let review_id = required(&params, "reviewId")?;
    let session_id = required(&params, "sessionId")?;
    if !is_id(review_id) || !is_id(session_id) {
        return Err(invalid_receipt("回执里的标识不合法"));
    }
    match required(&params, "event")? {
        "accepted" => {
            reject_extras(&params, &[], false)?;
            Ok(())
        }
        "rejected" => {
            reject_extras(&params, &["reason"], false)?;
            match required(&params, "reason")? {
                reason if REASONS.contains(&reason) => Ok(()),
                _ => Err(invalid_receipt("回执的 reason 不在协议错误码里")),
            }
        }
        "returned" => {
            reject_extras(&params, &["outcome", "headOid", "worktreeState"], true)?;
            let outcome = required(&params, "outcome")?;
            let head = field(&params, "headOid");
            match (outcome, head) {
                ("reviewed", None) => {}
                ("committed" | "merged", Some(oid)) if is_oid(oid) => {}
                _ => return Err(invalid_receipt("返回事件的结果与提交标识不匹配")),
            }
            if WorktreeState::parse(required(&params, "worktreeState")?).is_none() {
                return Err(invalid_receipt("返回事件的工作区状态不是协议里的取值"));
            }
            let meta_ok = params
                .iter()
                .filter(|(name, _)| name.starts_with(META_PREFIX))
                .all(|(_, value)| is_meta_value(value));
            if !meta_ok {
                return Err(invalid_receipt("返回事件的扩展元数据不符合协议"));
            }
            Ok(())
        }
        _ => Err(invalid_receipt("回执的 event 不是协议里的取值")),
    }
}

/// 打开 cliora 的固定 scheme。只允许本模块校验过的 `cliora://review`。
pub fn open_in_cliora<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
) -> Result<(), AppError> {
    validate_inbound(url)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::new("cliora_unavailable", format!("无法唤起 cliora：{error}")))
}

/// 后台回送：只把回执交给 cliora，不让它抢走 Twiglane 的前台。
/// macOS 用 `open -g`（参数数组，不经过 shell）在后台打开链接；其他平台照常打开，
/// 随后再把 Twiglane 窗口拉回前台，抵消 cliora 收到链接时的自我聚焦。
pub fn notify_cliora<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
) -> Result<(), AppError> {
    validate_inbound(url)?;
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let status = std::process::Command::new("/usr/bin/open")
            .arg("-g")
            .arg(url)
            .status()
            .map_err(|error| AppError::new("cliora_unavailable", format!("无法唤起 cliora：{error}")))?;
        if !status.success() {
            return Err(AppError::new(
                "cliora_unavailable",
                "无法唤起 cliora：系统没有找到处理 cliora 链接的应用。",
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        open_in_cliora(app, url)?;
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            for delay in [250u64, 750] {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                crate::bring_to_front(&handle);
            }
        });
        Ok(())
    }
}

fn parse_inbound_query(query: &str) -> Result<Vec<(String, String)>, AppError> {
    let mut params: Vec<(String, String)> = Vec::new();
    let mut meta = 0usize;
    for pair in query.split('&') {
        let (raw_key, raw_value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => return Err(malformed("回执里有空参数")),
        };
        let key = raw_name(raw_key)?;
        if key.starts_with(META_PREFIX) {
            if !is_meta_key(key) {
                return Err(malformed("回执的扩展元数据键不符合协议"));
            }
            meta += 1;
            if meta > MAX_META_ENTRIES {
                return Err(malformed("回执的扩展元数据过多"));
            }
        } else if !matches!(
            key,
            "v" | "event"
                | "reviewId"
                | "sessionId"
                | "reason"
                | "outcome"
                | "headOid"
                | "worktreeState"
        ) {
            return Err(malformed("回执含协议之外的参数"));
        }
        if params.iter().any(|(name, _)| name == key) {
            return Err(malformed("回执里同一个参数出现了多次"));
        }
        params.push((key.to_string(), decode(raw_value)?));
    }
    Ok(params)
}

fn field<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// 事件不允许出现它自身之外的参数（例如 accepted 带 outcome 或 meta）。
fn reject_extras(
    params: &[(String, String)],
    allowed: &[&str],
    allow_meta: bool,
) -> Result<(), AppError> {
    let stray = params.iter().any(|(name, _)| {
        !matches!(name.as_str(), "v" | "event" | "reviewId" | "sessionId")
            && !allowed.contains(&name.as_str())
            && !(allow_meta && name.starts_with(META_PREFIX))
    });
    if stray {
        return Err(invalid_receipt("回执带了当前事件不该有的参数"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    const REVIEW: &str = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
    const SESSION: &str = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
    const OID: &str = "4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0";

    fn temp_worktree() -> String {
        std::env::temp_dir()
            .join("cliora 代码 demo")
            .to_string_lossy()
            .into_owned()
    }

    fn encode_review(fields: &[(&str, &str)]) -> String {
        let mut url = String::from("twiglane://review?");
        for (index, (key, value)) in fields.iter().enumerate() {
            if index > 0 {
                url.push('&');
            }
            url.push_str(key);
            url.push('=');
            url.push_str(&encode(value));
        }
        url
    }

    fn good_fields() -> Vec<(&'static str, String)> {
        vec![
            ("v", "2".to_string()),
            ("reviewId", REVIEW.to_string()),
            ("sessionId", SESSION.to_string()),
            ("worktreePath", temp_worktree()),
            ("baseline", OID.to_string()),
        ]
    }

    fn url_of(fields: &[(&str, String)]) -> String {
        let borrowed: Vec<(&str, &str)> =
            fields.iter().map(|(key, value)| (*key, value.as_str())).collect();
        encode_review(&borrowed)
    }

    fn code_of(url: &str) -> String {
        parse_review_url(url).expect_err("应当拒绝").code
    }

    fn returned(
        outcome: Outcome,
        head_oid: Option<&str>,
        worktree_state: WorktreeState,
        meta: &[(&str, &str)],
    ) -> ReviewReturn {
        ReviewReturn {
            review_id: REVIEW.to_string(),
            session_id: SESSION.to_string(),
            outcome,
            head_oid: head_oid.map(str::to_string),
            worktree_state,
            meta: meta
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        }
    }

    fn returned_query(tail: &str) -> String {
        format!("cliora://review?v=2&event=returned&reviewId={REVIEW}&sessionId={SESSION}{tail}")
    }

    #[test]
    fn accepts_spaces_unicode_and_baseline() {
        let request = parse_review_url(&url_of(&good_fields())).expect("有效链接");
        assert_eq!(request.review_id, REVIEW);
        assert_eq!(request.session_id, SESSION);
        assert_eq!(request.worktree_path, temp_worktree());
        assert_eq!(request.baseline.as_deref(), Some(OID));
    }

    #[test]
    fn baseline_is_optional() {
        let mut fields = good_fields();
        fields.retain(|(key, _)| *key != "baseline");
        let request = parse_review_url(&url_of(&fields)).expect("无基线也能打开");
        assert_eq!(request.baseline, None);
    }

    #[test]
    fn rejects_v1_and_other_versions_without_fallback() {
        for version in ["1", "3", "02", ""] {
            let mut fields = good_fields();
            fields[0] = ("v", version.to_string());
            assert_eq!(code_of(&url_of(&fields)), UNSUPPORTED_VERSION, "v={version}");
        }

        let mut missing = good_fields();
        missing.retain(|(key, _)| *key != "v");
        assert_eq!(code_of(&url_of(&missing)), UNSUPPORTED_VERSION);
    }

    #[test]
    fn rejects_foreign_scheme_host_and_fragment() {
        let path = encode(&temp_worktree());
        let tail = format!("v=2&reviewId={REVIEW}&sessionId={SESSION}&worktreePath={path}");
        for url in [
            format!("http://review?{tail}"),
            format!("twiglane://other?{tail}"),
            format!("twiglane://review?{tail}#frag"),
            format!("twiglane://review?{tail}\u{7}"),
            format!("twiglane://review?{tail} tail"),
        ] {
            assert_eq!(code_of(&url), MALFORMED_REQUEST, "{url}");
        }
    }

    #[test]
    fn accepts_only_a_single_trailing_slash_after_the_host() {
        let plain = url_of(&good_fields());
        assert_eq!(plain.matches("twiglane://review?").count(), 1);
        assert_eq!(parse_review_url(&plain).expect("无斜杠形式").review_id, REVIEW);

        // 真实 Windows deep link 把无路径 URL 规范化成 host 后跟一个斜杠。
        let slashed = plain.replacen("twiglane://review?", "twiglane://review/?", 1);
        let request = parse_review_url(&slashed).expect("单个尾斜杠是系统等价规范化");
        assert_eq!(request.review_id, REVIEW);
        assert_eq!(request.session_id, SESSION);
        assert_eq!(request.worktree_path, temp_worktree());

        for hostile in [
            plain.replacen("twiglane://review?", "twiglane://review//?", 1),
            plain.replacen("twiglane://review?", "twiglane://review/review?", 1),
            plain.replacen("twiglane://review?", "twiglane://review/a/b?", 1),
            plain.replacen("twiglane://review?", "twiglane://review/x?", 1),
            plain.replacen("twiglane://review?", "twiglane://review:80?", 1),
            plain.replacen("twiglane://review?", "twiglane://me@review?", 1),
            plain.replacen("twiglane://review", "twiglane://Review", 1),
            plain.replacen("twiglane://review?", "twiglane://review/%2F?", 1),
        ] {
            assert_eq!(code_of(&hostile), MALFORMED_REQUEST, "{hostile}");
        }
    }

    #[test]
    fn rejects_duplicate_unknown_meta_and_encoded_params() {
        let mut duplicated = good_fields();
        duplicated.push(("sessionId", SESSION.to_string()));
        assert_eq!(code_of(&url_of(&duplicated)), MALFORMED_REQUEST);

        let mut unknown = good_fields();
        unknown.push(("foo", "1".to_string()));
        assert_eq!(code_of(&url_of(&unknown)), MALFORMED_REQUEST);

        // 请求不接受扩展元数据：任务身份只由核心字段决定。
        let mut meta = good_fields();
        meta.push(("meta.cliora.note", "x".to_string()));
        assert_eq!(code_of(&url_of(&meta)), MALFORMED_REQUEST);

        // 参数名写成百分号编码也不能绕过白名单或重复检查。
        let encoded = url_of(&good_fields()).replacen("v=2", "%76=2", 1);
        assert_eq!(code_of(&encoded), MALFORMED_REQUEST);
    }

    #[test]
    fn rejects_bad_ids_and_oids() {
        let mut fields = good_fields();
        fields[1] = ("reviewId", "not-a-uuid".to_string());
        assert_eq!(code_of(&url_of(&fields)), MALFORMED_REQUEST);

        let mut short_oid = good_fields();
        short_oid[4] = ("baseline", "4f3c2b1".to_string());
        assert_eq!(code_of(&url_of(&short_oid)), MALFORMED_REQUEST);

        let mut upper = good_fields();
        upper[4] = ("baseline", OID.to_uppercase());
        assert_eq!(code_of(&url_of(&upper)), MALFORMED_REQUEST);
    }

    #[test]
    fn rejects_relative_and_home_paths() {
        // 空值与缺失字段一样按 malformed_request 处理，这里只覆盖"给了但不是绝对路径"。
        for path in ["work/demo", "~/demo"] {
            let mut fields = good_fields();
            fields[3] = ("worktreePath", path.to_string());
            assert_eq!(code_of(&url_of(&fields)), INVALID_PATH, "{path}");
        }
    }

    #[test]
    fn rejects_oversized_input() {
        let mut fields = good_fields();
        fields[3] = ("worktreePath", format!("{}/{}", temp_worktree(), "a".repeat(1200)));
        assert_eq!(code_of(&url_of(&fields)), INVALID_PATH);

        let long = url_of(&good_fields());
        let padded = format!("{long}&pad={}", "a".repeat(MAX_URL_LEN));
        assert_eq!(code_of(&padded), MALFORMED_REQUEST);
    }

    #[test]
    fn decodes_percent_escapes_only() {
        assert_eq!(decode("a%20b").unwrap(), "a b");
        assert_eq!(decode("a+b").unwrap(), "a+b");
        assert_eq!(decode("%E4%BB%A3%E7%A0%81").unwrap(), "代码");
        assert_eq!(parse_review_url(&format!("twiglane://review?v=2&reviewId={REVIEW}&sessionId={SESSION}&worktreePath=%ZZ")).unwrap_err().code, MALFORMED_REQUEST);
    }

    #[test]
    fn builds_events_that_satisfy_the_inbound_rules() {
        let accepted = accepted_url(REVIEW, SESSION).expect("accepted");
        validate_inbound(&accepted).expect("accepted 合法");
        assert!(accepted.starts_with("cliora://review?v=2&event=accepted"));

        let rejected = rejected_url(REVIEW, SESSION, "not_a_worktree").expect("rejected");
        validate_inbound(&rejected).expect("rejected 合法");
        assert!(rejected.starts_with("cliora://review?v=2&event=rejected"));

        for state in [WorktreeState::Clean, WorktreeState::Dirty, WorktreeState::Unknown] {
            let reviewed =
                returned_url(&returned(Outcome::Reviewed, None, state, &[])).expect("reviewed");
            validate_inbound(&reviewed).expect("reviewed 合法");
            assert!(reviewed.contains(&format!("&worktreeState={}", state.as_str())));
            assert!(!reviewed.contains("headOid"));
        }

        // 提交或合入之后仍有其他未提交修改：outcome 与工作区状态正交。
        for outcome in [Outcome::Committed, Outcome::Merged] {
            let url = returned_url(&returned(outcome, Some(OID), WorktreeState::Dirty, &[]))
                .expect("带 oid");
            validate_inbound(&url).expect("committed/merged 合法");
            assert!(url.contains(&format!("headOid={OID}")));
            assert!(url.contains("worktreeState=dirty"));
        }
    }

    #[test]
    fn returned_carries_bounded_meta_without_changing_the_core() {
        let plain = returned_url(&returned(Outcome::Committed, Some(OID), WorktreeState::Clean, &[]))
            .expect("无 meta");
        let with_meta = returned_url(&returned(
            Outcome::Committed,
            Some(OID),
            WorktreeState::Clean,
            &[("twiglane.version", "0.3.3"), ("acme.note", "多 语言 note")],
        ))
        .expect("说明性 meta");
        validate_inbound(&with_meta).expect("带 meta 的 returned 合法");
        assert!(with_meta.starts_with(&plain));
        assert!(with_meta.contains("&meta.twiglane.version=0.3.3"));
        assert!(with_meta.contains("&meta.acme.note=%E5%A4%9A%20"));

        let bad_meta: [(&str, &str); 8] = [
            ("twiglane", "1"),
            ("twiglane.version.extra", "1"),
            (".version", "1"),
            ("Twiglane.version", "1"),
            ("twiglane.ver sion", "1"),
            ("twiglane.version", ""),
            ("twiglane.version", "line\nbreak"),
            ("twiglane.version", &"x".repeat(MAX_META_VALUE_LEN + 1)),
        ];
        for (key, value) in bad_meta {
            assert_eq!(
                returned_url(&returned(Outcome::Reviewed, None, WorktreeState::Clean, &[(key, value)]))
                    .expect_err("坏 meta")
                    .code,
                INVALID_RECEIPT,
                "{key}={value:?}"
            );
        }
        let duplicated = [("twiglane.version", "1"), ("twiglane.version", "2")];
        assert!(returned_url(&returned(Outcome::Reviewed, None, WorktreeState::Clean, &duplicated)).is_err());
        let too_many: Vec<(String, String)> = (0..=MAX_META_ENTRIES)
            .map(|index| (format!("ns.k{index}"), "v".to_string()))
            .collect();
        let borrowed: Vec<(&str, &str)> =
            too_many.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        assert!(returned_url(&returned(Outcome::Reviewed, None, WorktreeState::Clean, &borrowed)).is_err());
    }

    #[test]
    fn refuses_incomplete_results() {
        assert_eq!(
            returned_url(&returned(Outcome::Committed, None, WorktreeState::Clean, &[]))
                .expect_err("缺 oid")
                .code,
            INVALID_RECEIPT
        );
        assert_eq!(
            returned_url(&returned(Outcome::Reviewed, Some(OID), WorktreeState::Dirty, &[]))
                .expect_err("没有提交的结果不该带 oid")
                .code,
            INVALID_RECEIPT
        );
        assert_eq!(
            rejected_url(REVIEW, SESSION, "git exploded")
                .expect_err("非稳定错误码")
                .code,
            INVALID_RECEIPT
        );
        assert_eq!(
            accepted_url("nope", SESSION).expect_err("坏 id").code,
            INVALID_RECEIPT
        );
        assert_eq!(Outcome::parse("edited"), None);
        assert_eq!(WorktreeState::parse("approved"), None);
    }

    #[test]
    fn inbound_events_accept_a_single_trailing_slash_only() {
        let accepted = accepted_url(REVIEW, SESSION).expect("accepted");
        // 生成端继续输出零斜杠形式；接收端两种都认。
        assert!(accepted.starts_with("cliora://review?"));
        validate_inbound(&accepted).expect("无斜杠形式");

        let slashed = accepted.replacen("cliora://review?", "cliora://review/?", 1);
        validate_inbound(&slashed).expect("单个尾斜杠是系统等价规范化");

        for hostile in [
            accepted.replacen("cliora://review?", "cliora://review//?", 1),
            accepted.replacen("cliora://review?", "cliora://review/x?", 1),
            accepted.replacen("cliora://review?", "cliora://review/a/b?", 1),
            accepted.replacen("cliora://review?", "cliora://review/%2F?", 1),
        ] {
            assert!(validate_inbound(&hostile).is_err(), "{hostile}");
        }

        // 带尾斜杠的 returned 同样通过完整事件校验。
        let reviewed = returned_url(&returned(Outcome::Reviewed, None, WorktreeState::Dirty, &[]))
            .expect("reviewed");
        let slashed_returned = reviewed.replacen("cliora://review?", "cliora://review/?", 1);
        validate_inbound(&slashed_returned).expect("带尾斜杠的 returned");
    }

    #[test]
    fn inbound_validation_rejects_mismatched_event_fields() {
        for url in [
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW}&sessionId={SESSION}&outcome=merged"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW}&sessionId={SESSION}&worktreeState=clean"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW}&sessionId={SESSION}&meta.twiglane.version=1"),
            format!("cliora://review?v=2&event=rejected&reviewId={REVIEW}&sessionId={SESSION}&reason=open_failed&meta.twiglane.version=1"),
            returned_query("&outcome=committed&worktreeState=clean"),
            returned_query(&format!("&outcome=reviewed&headOid={OID}&worktreeState=clean")),
            returned_query("&outcome=reviewed"),
            returned_query("&outcome=reviewed&worktreeState=approved"),
            returned_query("&outcome=edited&worktreeState=dirty"),
            returned_query("&outcome=reviewed&worktreeState=clean&reason=open_failed"),
            format!("cliora://review?v=2&event=rejected&reviewId={REVIEW}&sessionId={SESSION}"),
            format!("cliora://review?v=2&event=rejected&reviewId={REVIEW}&sessionId={SESSION}&reason=boom"),
            format!("cliora://review?v=2&event=unknown&reviewId={REVIEW}&sessionId={SESSION}"),
            format!("twiglane://review?v=2&event=accepted&reviewId={REVIEW}&sessionId={SESSION}"),
        ] {
            assert!(validate_inbound(&url).is_err(), "{url}");
        }
    }

    #[test]
    fn inbound_validation_rejects_v1_and_malformed_meta() {
        for url in [
            format!("cliora://review?v=1&event=accepted&reviewId={REVIEW}&sessionId={SESSION}"),
            format!("cliora://review?v=1&event=returned&reviewId={REVIEW}&sessionId={SESSION}&outcome=reviewed"),
            format!("cliora://review?v=3&event=accepted&reviewId={REVIEW}&sessionId={SESSION}"),
        ] {
            assert_eq!(validate_inbound(&url).expect_err("版本不匹配").code, UNSUPPORTED_VERSION, "{url}");
        }
        let long = "x".repeat(MAX_META_VALUE_LEN + 1);
        for tail in [
            "&meta.x=1".to_string(),
            "&meta.x.y.z=1".to_string(),
            "&meta..y=1".to_string(),
            "&meta.X.y=1".to_string(),
            "&meta.x.1y=1".to_string(),
            "&meta.x.y=".to_string(),
            "&meta.x.y=a%0Ab".to_string(),
            format!("&meta.x.y={long}"),
            "&meta%2Ex.y=1".to_string(),
            "&meta.x.y=1&meta.x.y=2".to_string(),
            (0..=MAX_META_ENTRIES).map(|index| format!("&meta.ns.k{index}=v")).collect(),
            "&metadata=1".to_string(),
        ] {
            let url = returned_query(&format!("&outcome=reviewed&worktreeState=clean{tail}"));
            assert!(validate_inbound(&url).is_err(), "{url}");
        }
        // 合法 meta 夹具：未知 namespace 也保留形状校验，核心字段不变。
        validate_inbound(&returned_query(
            "&outcome=reviewed&worktreeState=clean&meta.twiglane.version=0.3.3&meta.acme-tools.build_id=b-1",
        ))
        .expect("合法 meta");
    }

    /// 工作区声明只由真实读取结果决定：读不到就是 unknown，不会被当成 clean。
    #[test]
    fn worktree_state_comes_only_from_a_real_read() {
        assert_eq!(worktree_state_of(None), WorktreeState::Unknown);
        assert_eq!(worktree_state_of(Some(0)), WorktreeState::Clean);
        assert_eq!(worktree_state_of(Some(3)), WorktreeState::Dirty);
    }

    /// 只有被接受的链接才成为来源：解析后暂存，accepted 回执才提升；sessionId 对不上的
    /// 回执不提升。正式来源有上限，超出时先丢最早的，未记录的 reviewId 读不到来源。
    #[test]
    fn review_sources_keep_only_accepted_bounded_mapping() {
        let sources = ReviewSources::default();
        assert_eq!(sources.worktree_for(REVIEW), None);
        sources.stage(REVIEW, SESSION, "C:/work/a");
        assert_eq!(sources.worktree_for(REVIEW), None, "只解析未接受不算来源");
        sources.accept(REVIEW, "other-session");
        assert_eq!(sources.worktree_for(REVIEW), None, "sessionId 对不上不提升");
        sources.accept(REVIEW, SESSION);
        assert_eq!(sources.worktree_for(REVIEW).as_deref(), Some("C:/work/a"));
        for index in 0..MAX_REVIEW_SOURCES {
            let id = format!("review-{index}");
            sources.stage(&id, SESSION, &format!("C:/work/{index}"));
            sources.accept(&id, SESSION);
        }
        assert_eq!(sources.worktree_for(REVIEW), None, "最早的来源被挤出");
        assert_eq!(sources.worktree_for("review-0").as_deref(), Some("C:/work/0"));
        assert_eq!(
            sources.worktree_for(&format!("review-{}", MAX_REVIEW_SOURCES - 1)).as_deref(),
            Some(format!("C:/work/{}", MAX_REVIEW_SOURCES - 1).as_str()),
        );
    }

    /// 已接受的审查不会被同一 reviewId、指向别处的重复链接改写：重复链接只解析、
    /// 即使随后又收到 accepted 回执，返回时读取的仍是最初被接受的工作树。
    #[test]
    fn duplicate_review_id_never_rewrites_the_accepted_source() {
        let sources = ReviewSources::default();
        sources.stage(REVIEW, SESSION, "C:/work/a");
        sources.accept(REVIEW, SESSION);
        sources.stage(REVIEW, SESSION, "C:/elsewhere");
        assert_eq!(sources.worktree_for(REVIEW).as_deref(), Some("C:/work/a"));
        sources.accept(REVIEW, SESSION);
        assert_eq!(sources.worktree_for(REVIEW).as_deref(), Some("C:/work/a"));
        sources.reject(REVIEW, SESSION);
        assert_eq!(sources.worktree_for(REVIEW).as_deref(), Some("C:/work/a"), "拒绝不动正式来源");
    }

    /// 被拒绝、打开失败或被忽略的链接不占正式来源的位置：连续很多条只解析或被拒绝的
    /// 链接之后，当前审查的来源仍在。
    #[test]
    fn rejected_or_ignored_links_never_evict_the_accepted_source() {
        let sources = ReviewSources::default();
        sources.stage(REVIEW, SESSION, "C:/work/a");
        sources.accept(REVIEW, SESSION);
        for index in 0..(MAX_REVIEW_SOURCES * 3) {
            let id = format!("ignored-{index}");
            sources.stage(&id, SESSION, &format!("C:/other/{index}"));
            if index % 2 == 0 {
                sources.reject(&id, SESSION);
            }
        }
        assert_eq!(sources.worktree_for(REVIEW).as_deref(), Some("C:/work/a"));
        assert_eq!(sources.worktree_for("ignored-1"), None, "未接受的链接没有来源");
        // 被拒绝的待定记录已清掉；同一 reviewId 之后重新发起并被接受时按新链接记录。
        sources.stage("ignored-0", SESSION, "C:/work/retry");
        sources.accept("ignored-0", SESSION);
        assert_eq!(sources.worktree_for("ignored-0").as_deref(), Some("C:/work/retry"));
    }
}
