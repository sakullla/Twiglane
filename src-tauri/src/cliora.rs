//! cliora 审查集成协议（v1）：\`twiglane://review\` 入站请求与 \`cliora://review\` 出站事件。
//!
//! 合同来源是 cliora 仓库的 \`docs/integrations/twiglane-review-v1.md\`。这里只做纯字符串
//! 解析/生成与固定 scheme 唤起：不打开仓库、不读 Git、不写任何状态，因此系统 deep link
//! 这种不可信输入在任何 Git 写入之前就会被拒绝。
//!
//! 长度、控制字符、重复/未知参数、ID/OID 格式都在这里挡掉；路径只做语法校验
//! （绝对路径、长度、\`~\` 前缀），是否是真正的工作树根由 \`open_repository\` 在
//! 打开时判定——它要求目录下存在 \`.git\`，所以子目录不会回退成父仓库。

use crate::error::AppError;

/// cliora 用来唤起 Twiglane 的 scheme。
pub const SCHEME: &str = "twiglane";
/// Twiglane 回送事件给 cliora 的 scheme。
pub const INBOUND_SCHEME: &str = "cliora";
/// 两个方向的固定 host。
pub const HOST: &str = "review";
/// 协议主版本。
pub const VERSION: &str = "1";
/// 整个 URL 的上限（UTF-8 字节）。
pub const MAX_URL_LEN: usize = 2048;
/// 解码后 worktreePath 的上限（字符）。
pub const MAX_PATH_LEN: usize = 1000;

/// 稳定错误码：既是拒绝回执里的 \`reason\`，也是前端本地错误的 code。
pub const UNSUPPORTED_VERSION: &str = "unsupported_version";
pub const MALFORMED_REQUEST: &str = "malformed_request";
pub const INVALID_PATH: &str = "invalid_path";
pub const INVALID_RECEIPT: &str = "invalid_receipt";

/// 已校验的 v1 审查请求。字段原样来自链接，不含任何凭据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRequest {
    pub review_id: String,
    pub session_id: String,
    pub worktree_path: String,
    pub baseline: Option<String>,
}

/// 回送 cliora 的结果声明。带 head_oid 的只是待复核声明，成功与否由 cliora 复核。
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
}

/// 允许出现在 rejected 回执 reason 里的错误码。
const REASONS: [&str; 5] = [
    UNSUPPORTED_VERSION,
    MALFORMED_REQUEST,
    INVALID_PATH,
    "not_a_worktree",
    "open_failed",
];

/// 解析并校验 \`twiglane://review?v=1&...\`。错误码直接是拒绝回执的 reason。
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
            "只支持 v1 审查链接，请升级 Twiglane 或 cliora。",
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

/// 生成 \`accepted\` 回执。
pub fn accepted_url(review_id: &str, session_id: &str) -> Result<String, AppError> {
    build_event("accepted", review_id, session_id, &[])
}

/// 生成 \`rejected\` 回执。reason 只接受协议里的稳定错误码。
pub fn rejected_url(review_id: &str, session_id: &str, reason: &str) -> Result<String, AppError> {
    if !is_id(review_id) || !is_id(session_id) {
        return Err(invalid_receipt("回执缺少可用的 reviewId 或 sessionId"));
    }
    if !REASONS.contains(&reason) {
        return Err(invalid_receipt("回执的 reason 不在协议错误码里"));
    }
    let url = format!(
        "{INBOUND_SCHEME}://{HOST}?v={VERSION}&event=rejected&reviewId={}&sessionId={}&reason={}",
        encode(review_id),
        encode(session_id),
        encode(reason),
    );
    check_len(url)
}

/// 生成 \`returned\` 事件。committed/merged 必须带完整 headOid，reviewed 不能带。
pub fn returned_url(
    review_id: &str,
    session_id: &str,
    outcome: Outcome,
    head_oid: Option<&str>,
) -> Result<String, AppError> {
    if !is_id(review_id) || !is_id(session_id) {
        return Err(invalid_receipt("返回事件缺少可用的 reviewId 或 sessionId"));
    }
    let head = match (outcome, head_oid) {
        (Outcome::Reviewed, None) => None,
        (Outcome::Reviewed, Some(_)) => {
            return Err(invalid_receipt("只浏览的结果不能声明提交标识"));
        }
        (_, Some(oid)) if is_oid(oid) => Some(oid),
        _ => return Err(invalid_receipt("提交或合入的结果必须带完整提交标识")),
    };
    let mut extras = vec![("outcome", outcome.as_str())];
    if let Some(oid) = head {
        extras.push(("headOid", oid));
    }
    build_event("returned", review_id, session_id, &extras)
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

/// 解析查询串：重复或未知参数、空参数名、坏百分号编码、非 UTF-8 都失败。
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
        let key = decode(raw_key)?;
        if key.is_empty() {
            return Err(malformed("查询串里有空参数名"));
        }
        if !matches!(key.as_str(), "v" | "reviewId" | "sessionId" | "worktreePath" | "baseline") {
            return Err(malformed("链接含协议之外的参数"));
        }
        if params.iter().any(|(name, _)| name == &key) {
            return Err(malformed("链接里同一个参数出现了多次"));
        }
        params.push((key, decode(raw_value)?));
    }
    Ok(params)
}

/// 百分号解码：\`+\` 按字面加号处理，坏的 \`%\` 序列与非 UTF-8 都失败。
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
/// 入站（Twiglane → cliora）URL 的完整校验：固定 scheme/host、v1、事件字段组合。
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
            "回执不是 v1 协议，未打开任何应用。",
        ));
    }
    let review_id = required(&params, "reviewId")?;
    let session_id = required(&params, "sessionId")?;
    if !is_id(review_id) || !is_id(session_id) {
        return Err(invalid_receipt("回执里的标识不合法"));
    }
    match required(&params, "event")? {
        "accepted" => {
            reject_extras(&params, &[])?;
            Ok(())
        }
        "rejected" => {
            reject_extras(&params, &["reason"])?;
            match required(&params, "reason")? {
                reason if REASONS.contains(&reason) => Ok(()),
                _ => Err(invalid_receipt("回执的 reason 不在协议错误码里")),
            }
        }
        "returned" => {
            reject_extras(&params, &["outcome", "headOid"])?;
            let outcome = required(&params, "outcome")?;
            let head = field(&params, "headOid");
            match (outcome, head) {
                ("reviewed", None) => Ok(()),
                ("committed" | "merged", Some(oid)) if is_oid(oid) => Ok(()),
                _ => Err(invalid_receipt("返回事件的结果与提交标识不匹配")),
            }
        }
        _ => Err(invalid_receipt("回执的 event 不是协议里的取值")),
    }
}

/// 打开 cliora 的固定 scheme。只允许本模块校验过的 \`cliora://review\`。
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
    for pair in query.split('&') {
        let (raw_key, raw_value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => return Err(malformed("回执里有空参数")),
        };
        let key = decode(raw_key)?;
        if key.is_empty() {
            return Err(malformed("回执里有空参数名"));
        }
        if !matches!(
            key.as_str(),
            "v" | "event" | "reviewId" | "sessionId" | "reason" | "outcome" | "headOid"
        ) {
            return Err(malformed("回执含协议之外的参数"));
        }
        if params.iter().any(|(name, _)| name == &key) {
            return Err(malformed("回执里同一个参数出现了多次"));
        }
        params.push((key, decode(raw_value)?));
    }
    Ok(params)
}

fn field<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// 事件不允许出现它自身之外的参数（例如 accepted 带 outcome）。
fn reject_extras(params: &[(String, String)], allowed: &[&str]) -> Result<(), AppError> {
    let stray = params.iter().any(|(name, _)| {
        !matches!(name.as_str(), "v" | "event" | "reviewId" | "sessionId")
            && !allowed.contains(&name.as_str())
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
            ("v", "1".to_string()),
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
    fn rejects_other_versions() {
        let mut fields = good_fields();
        fields[0] = ("v", "2".to_string());
        assert_eq!(code_of(&url_of(&fields)), UNSUPPORTED_VERSION);

        let mut missing = good_fields();
        missing.retain(|(key, _)| *key != "v");
        assert_eq!(code_of(&url_of(&missing)), UNSUPPORTED_VERSION);
    }

    #[test]
    fn rejects_foreign_scheme_host_and_fragment() {
        let path = encode(&temp_worktree());
        let tail = format!("v=1&reviewId={REVIEW}&sessionId={SESSION}&worktreePath={path}");
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
    fn rejects_duplicate_and_unknown_params() {
        let mut duplicated = good_fields();
        duplicated.push(("sessionId", SESSION.to_string()));
        assert_eq!(code_of(&url_of(&duplicated)), MALFORMED_REQUEST);

        let mut unknown = good_fields();
        unknown.push(("foo", "1".to_string()));
        assert_eq!(code_of(&url_of(&unknown)), MALFORMED_REQUEST);
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
        assert_eq!(parse_review_url(&format!("twiglane://review?v=1&reviewId={REVIEW}&sessionId={SESSION}&worktreePath=%ZZ")).unwrap_err().code, MALFORMED_REQUEST);
    }

    #[test]
    fn builds_events_that_satisfy_the_inbound_rules() {
        let accepted = accepted_url(REVIEW, SESSION).expect("accepted");
        validate_inbound(&accepted).expect("accepted 合法");
        assert!(accepted.starts_with("cliora://review?v=1&event=accepted"));

        let rejected = rejected_url(REVIEW, SESSION, "not_a_worktree").expect("rejected");
        validate_inbound(&rejected).expect("rejected 合法");

        let reviewed = returned_url(REVIEW, SESSION, Outcome::Reviewed, None).expect("reviewed");
        validate_inbound(&reviewed).expect("reviewed 合法");

        for outcome in [Outcome::Committed, Outcome::Merged] {
            let returned = returned_url(REVIEW, SESSION, outcome, Some(OID)).expect("带 oid");
            validate_inbound(&returned).expect("committed/merged 合法");
            assert!(returned.contains(&format!("headOid={OID}")));
        }
    }

    #[test]
    fn refuses_incomplete_results() {
        assert_eq!(
            returned_url(REVIEW, SESSION, Outcome::Committed, None)
                .expect_err("缺 oid")
                .code,
            INVALID_RECEIPT
        );
        assert_eq!(
            returned_url(REVIEW, SESSION, Outcome::Reviewed, Some(OID))
                .expect_err("只浏览不该带 oid")
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
        let returned = returned_url(REVIEW, SESSION, Outcome::Reviewed, None).expect("reviewed");
        let slashed_returned = returned.replacen("cliora://review?", "cliora://review/?", 1);
        validate_inbound(&slashed_returned).expect("带尾斜杠的 returned");
    }

    #[test]
    fn inbound_validation_rejects_mismatched_event_fields() {
        for url in [
            format!("cliora://review?v=1&event=accepted&reviewId={REVIEW}&sessionId={SESSION}&outcome=merged"),
            format!("cliora://review?v=1&event=returned&reviewId={REVIEW}&sessionId={SESSION}&outcome=committed"),
            format!("cliora://review?v=1&event=returned&reviewId={REVIEW}&sessionId={SESSION}&outcome=reviewed&headOid={OID}"),
            format!("cliora://review?v=1&event=rejected&reviewId={REVIEW}&sessionId={SESSION}"),
            format!("cliora://review?v=1&event=rejected&reviewId={REVIEW}&sessionId={SESSION}&reason=boom"),
            format!("cliora://review?v=1&event=unknown&reviewId={REVIEW}&sessionId={SESSION}"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW}&sessionId={SESSION}"),
            format!("twiglane://review?v=1&event=accepted&reviewId={REVIEW}&sessionId={SESSION}"),
        ] {
            assert!(validate_inbound(&url).is_err(), "{url}");
        }
    }
}
