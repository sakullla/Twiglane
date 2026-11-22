//! feedback-v1：Twiglane 把一批行定位的审阅意见安全交给 cliora。
//!
//! 合同来源是 docs/integrations/twiglane-review-feedback-v1.md，双端共享
//! tests/fixtures/reviews/protocol-feedback-v1.json。这里只做三件事：
//!
//! 1. 严格校验批次：来源标识、resultRevision、schema、条目与字节上限、digest；
//! 2. 在专用交接目录里用 create_new 的 0600 临时文件写入、fsync 后 rename 完成，
//!    拒绝符号链接与覆盖（同一 feedbackId 只能准备一次）；
//! 3. 生成只带标识与 digest 的 cliora://review-feedback?v=1 深链。
//!
//! 意见正文、路径与代码只留在文件里，绝不进入 URL 或日志；读取有界（1 MiB），
//! 超限、额外字段与 digest 不符都失败，不打开任何 Agent 操作。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 协议主版本。只有 1 合法；未知版本明确失败，不降级。
pub const VERSION: u8 = 1;
pub const SCHEME: &str = "cliora";
pub const HOST: &str = "review-feedback";
/// 交接目录名：两端都从各自平台的临时根目录派生同名子目录。
pub const DIR_NAME: &str = "cliora-review-feedback";
/// 单批意见条数上限。
pub const MAX_COMMENTS: usize = 64;
/// 单条意见正文的 UTF-8 字节上限。
pub const MAX_BODY_BYTES: usize = 16 * 1024;
/// 整个交接文件（含 schema 开销）的字节上限。
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
/// 深链总长度上限（UTF-8 字节）。
pub const MAX_URL_LEN: usize = 2048;
/// rangeVersion 解码后的字符上限。
pub const MAX_RANGE_VERSION_CHARS: usize = 200;
/// 仓库相对路径的字符上限。
pub const MAX_PATH_CHARS: usize = 500;
/// worktreePath 的字符上限，与 review v3 一致。
pub const MAX_WORKTREE_CHARS: usize = 1000;
/// resultRevision 的上限（JS 安全整数），与 review v3 一致。
pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

pub const INVALID_BATCH: &str = "feedback_invalid";
pub const UNSUPPORTED_VERSION: &str = "feedback_unsupported_version";
pub const BATCH_TOO_LARGE: &str = "feedback_too_large";
pub const DUPLICATE_BATCH: &str = "feedback_duplicate";
pub const DIGEST_MISMATCH: &str = "feedback_digest_mismatch";
pub const WRITE_FAILED: &str = "feedback_write_failed";
pub const INVALID_URL: &str = "feedback_url_invalid";

/// 一条行定位意见：身份来自任务差异里的 hunkIndex + kind + oldNo + newNo，
/// 不猜行号，也不复用任何暂存语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackComment {
    pub id: String,
    /// 仓库相对路径，永远不是绝对路径。
    pub path: String,
    pub hunk_index: u64,
    /// add | del | context。
    pub kind: String,
    pub old_no: Option<u64>,
    pub new_no: Option<u64>,
    pub body: String,
}

/// 一次交接的完整内容。字段顺序就是 digest 的规范顺序，不要重排。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feedback {
    pub v: u8,
    pub feedback_id: String,
    pub review_id: String,
    pub session_id: String,
    pub result_revision: u64,
    pub worktree_path: String,
    pub range_version: String,
    pub baseline_oid: String,
    pub head_oid: String,
    pub comments: Vec<FeedbackComment>,
    /// 覆盖除自身之外全部字段的 SHA-256 小写十六进制。
    pub digest: String,
}

/// digest 的规范输入：与 Feedback 完全同序，只是不含 digest 本身。
/// serde_json 的紧凑输出（无空白、不转义非 ASCII）就是两端共享的规范字节。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestInput<'a> {
    v: u8,
    feedback_id: &'a str,
    review_id: &'a str,
    session_id: &'a str,
    result_revision: u64,
    worktree_path: &'a str,
    range_version: &'a str,
    baseline_oid: &'a str,
    head_oid: &'a str,
    comments: &'a [FeedbackComment],
}

/// 前端请求：feedbackId 与 digest 由原生生成，前端不给。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackRequest {
    pub review_id: String,
    pub session_id: String,
    pub result_revision: u64,
    pub worktree_path: String,
    pub range_version: String,
    pub baseline_oid: String,
    pub head_oid: String,
    pub comments: Vec<FeedbackComment>,
}

/// 准备成功后的返回值：只有标识、digest 与条数，没有正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFeedback {
    pub feedback_id: String,
    pub digest: String,
    pub comment_count: usize,
    pub url: String,
}

/// 交接目录：两端各自平台临时根下的同名子目录（macOS 的 TMPDIR 已按用户隔离，
/// Windows 的 %TEMP% 在当前用户配置里）。
pub fn feedback_dir() -> PathBuf {
    std::env::temp_dir().join(DIR_NAME)
}

fn canonical_bytes(feedback: &Feedback) -> Result<Vec<u8>, AppError> {
    let input = DigestInput {
        v: feedback.v,
        feedback_id: &feedback.feedback_id,
        review_id: &feedback.review_id,
        session_id: &feedback.session_id,
        result_revision: feedback.result_revision,
        worktree_path: &feedback.worktree_path,
        range_version: &feedback.range_version,
        baseline_oid: &feedback.baseline_oid,
        head_oid: &feedback.head_oid,
        comments: &feedback.comments,
    };
    serde_json::to_vec(&input).map_err(|_| invalid("意见批次无法序列化"))
}

#[cfg(test)]
fn digest_of(feedback: &Feedback) -> String {
    format!("{:x}", Sha256::digest(canonical_bytes(feedback).unwrap()))
}

fn invalid(message: &str) -> AppError {
    AppError::new(INVALID_BATCH, format!("{message}，未准备交接。"))
}

fn failed(message: &str) -> AppError {
    AppError::new(WRITE_FAILED, format!("{message}，未打开 cliora。"))
}

/// 批次内容的完整校验。任何一条失败都在写文件与打开深链之前结束。
fn validated_digest(feedback: &Feedback) -> Result<String, AppError> {
    if feedback.v != VERSION {
        return Err(AppError::new(
            UNSUPPORTED_VERSION,
            "这批意见的协议版本不是 feedback-v1，请把两端升级到同一版本。",
        ));
    }
    if !is_id(&feedback.feedback_id) || !is_id(&feedback.review_id) || !is_id(&feedback.session_id) {
        return Err(invalid("批次、审查或会话标识不是合法的 UUID"));
    }
    if feedback.result_revision > MAX_SAFE_REVISION {
        return Err(invalid("结果版本超出可表示范围"));
    }
    if !is_worktree_path(&feedback.worktree_path) {
        return Err(invalid("工作树路径不是合法的绝对路径"));
    }
    if !is_range_version(&feedback.range_version) {
        return Err(invalid("任务范围版本为空或过长"));
    }
    if !is_oid(&feedback.baseline_oid) || !is_oid(&feedback.head_oid) {
        return Err(invalid("任务起点或 HEAD 不是完整的提交标识"));
    }
    if feedback.comments.is_empty() {
        return Err(invalid("这次没有意见内容"));
    }
    if feedback.comments.len() > MAX_COMMENTS {
        return Err(AppError::new(
            BATCH_TOO_LARGE,
            format!("一次最多送回 {MAX_COMMENTS} 条意见，请分批准备。"),
        ));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(feedback.comments.len());
    for comment in &feedback.comments {
        if !is_id(&comment.id) {
            return Err(invalid("意见标识不是合法的 UUID"));
        }
        if seen.contains(&comment.id.as_str()) {
            return Err(invalid("同一批里有重复的意见标识"));
        }
        seen.push(&comment.id);
        if !is_relative_path(&comment.path) {
            return Err(invalid("意见路径必须是仓库相对路径"));
        }
        if !matches!(comment.kind.as_str(), "add" | "del" | "context") {
            return Err(invalid("意见行类型不在 add/del/context 里"));
        }
        if comment.old_no.is_none() && comment.new_no.is_none() {
            return Err(invalid("意见没有行号，无法定位"));
        }
        if comment.body.trim().is_empty() {
            return Err(invalid("意见正文为空"));
        }
        if comment.body.len() > MAX_BODY_BYTES {
            return Err(AppError::new(
                BATCH_TOO_LARGE,
                format!("单条意见正文超过 {MAX_BODY_BYTES} 字节，请拆开。"),
            ));
        }
        if comment
            .body
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
        {
            return Err(invalid("意见正文含不可接受的字符"));
        }
    }
    let bytes = canonical_bytes(feedback)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::new(
            BATCH_TOO_LARGE,
            "这批意见的总体积超过 1 MiB，请分批准备。",
        ));
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// 建立（或核对）专用交接目录：Unix 0700 且属于当前用户，Windows 只接受普通目录。
pub fn ensure_dir(dir: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(failed("意见交接目录不是普通目录"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if meta.permissions().mode() & 0o077 != 0 {
                    return Err(failed("意见交接目录不是仅当前用户可访问（需要 0700）"));
                }
                // SAFETY: geteuid 没有前置条件，只读进程凭证。
                if meta.uid() != unsafe { libc::geteuid() } {
                    return Err(failed("意见交接目录不属于当前用户"));
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(dir).map_err(|_| failed("无法创建意见交接目录"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                    .map_err(|_| failed("无法收紧意见交接目录权限"))?;
            }
            Ok(())
        }
        Err(_) => Err(failed("意见交接目录不可读")),
    }
}

/// 写入一次交接：校验 → create_new 临时文件 → fsync → rename → 回读核对。
/// 目标已存在（含符号链接）一律失败，绝不覆盖另一批意见。
pub fn prepare(dir: &Path, feedback: Feedback) -> Result<Feedback, AppError> {
    let mut feedback = feedback;
    feedback.digest = validated_digest(&feedback)?;
    ensure_dir(dir)?;
    let target = dir.join(format!("{}.json", feedback.feedback_id));
    if fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::new(
            DUPLICATE_BATCH,
            "这批意见已经准备过。要再送回一次，请重新准备一个新批次。",
        ));
    }
    let bytes = serde_json::to_vec_pretty(&feedback).map_err(|_| invalid("意见批次无法序列化"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::new(BATCH_TOO_LARGE, "意见交接文件超过 1 MiB。"));
    }
    let feedback_id = feedback.feedback_id;
    drop(feedback.comments);
    let temp = dir.join(format!(".{feedback_id}.part"));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = create_private(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &target)?;
        Ok(())
    })();
    drop(bytes);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(failed(&format!(
            "无法写入意见交接文件（{}）",
            error.kind()
        )));
    }
    sync_dir(dir);
    // 回读一次：schema、上限与 digest 必须与刚写入的一致，才允许打开深链。
    read_file(dir, &feedback_id)
}

#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<File> {
    // Windows 的 ACL 继承自当前用户的临时目录；这里只保证不覆盖任何已有文件。
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// 有界读取并完整校验一个交接文件：拒绝符号链接、超过 1 MiB、额外字段与 digest 不符。
pub fn read_file(dir: &Path, feedback_id: &str) -> Result<Feedback, AppError> {
    if !is_id(feedback_id) {
        return Err(invalid("批次标识不是合法的 UUID"));
    }
    let path = dir.join(format!("{feedback_id}.json"));
    let meta = fs::symlink_metadata(&path)
        .map_err(|_| invalid("意见交接文件不存在或不可读"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(invalid("意见交接文件不是普通文件"));
    }
    if meta.len() > MAX_FILE_BYTES as u64 {
        return Err(AppError::new(
            BATCH_TOO_LARGE,
            "意见交接文件超过 1 MiB，未读取。",
        ));
    }
    let file = File::open(&path).map_err(|_| invalid("意见交接文件不可读"))?;
    let mut bytes: Vec<u8> = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("意见交接文件读取失败"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::new(
            BATCH_TOO_LARGE,
            "意见交接文件超过 1 MiB，未读取。",
        ));
    }
    let feedback: Feedback = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("意见交接文件的 schema 不符合 feedback-v1"))?;
    drop(bytes);
    if feedback.digest != validated_digest(&feedback)? {
        return Err(AppError::new(
            DIGEST_MISMATCH,
            "意见批次的 digest 与正文不符，未接受。",
        ));
    }
    Ok(feedback)
}

/// 生成深链：只带标识、结果版本与 digest；正文、路径、代码与命令都不在 URL 里。
pub fn feedback_url(feedback: &Feedback) -> Result<String, AppError> {
    if feedback.digest != validated_digest(feedback)? {
        return Err(AppError::new(
            DIGEST_MISMATCH,
            "意见批次的 digest 与正文不符，未生成深链。",
        ));
    }
    let url = format!(
        "{SCHEME}://{HOST}?v={VERSION}&feedbackId={}&reviewId={}&sessionId={}&resultRevision={}&digest={}",
        feedback.feedback_id,
        feedback.review_id,
        feedback.session_id,
        feedback.result_revision,
        feedback.digest
    );
    validate_url(&url)?;
    Ok(url)
}

/// 入站规则（cliora 侧与这里的生成端共用）：固定 scheme/host、六个参数各一次、
/// 值只含未保留字符、总长不超过 2048 字节。
pub fn validate_url(url: &str) -> Result<(), AppError> {
    let bad = |message: &str| AppError::new(INVALID_URL, format!("{message}。"));
    if url.len() > MAX_URL_LEN {
        return Err(bad("意见深链超过长度上限"));
    }
    if url.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err(bad("意见深链含控制字符或未编码空格"));
    }
    let rest = url
        .strip_prefix(&format!("{SCHEME}://"))
        .ok_or_else(|| bad("意见深链不是 cliora:// 协议"))?;
    if rest.contains('#') {
        return Err(bad("意见深链不接受 fragment"));
    }
    let (host, query) = rest
        .split_once('?')
        .ok_or_else(|| bad("意见深链缺少查询参数"))?;
    if host.strip_suffix('/').unwrap_or(host) != HOST {
        return Err(bad("意见深链目标不是 review-feedback"));
    }
    if query.contains('?') {
        return Err(bad("意见深链含未编码问号"));
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut feedback_id = None;
    let mut review_id = None;
    let mut session_id = None;
    let mut revision = None;
    let mut digest = None;
    for pair in query.split('&') {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| bad("意见深链参数缺少等号"))?;
        if !value.bytes().all(is_url_safe) || value.is_empty() {
            return Err(bad("意见深链参数值含协议之外的字符"));
        }
        if seen.contains(&key) {
            return Err(bad("意见深链里同一个参数出现了多次"));
        }
        seen.push(key);
        match key {
            "v" if value == "1" => {}
            "feedbackId" if is_id(value) => feedback_id = Some(value),
            "reviewId" if is_id(value) => review_id = Some(value),
            "sessionId" if is_id(value) => session_id = Some(value),
            "resultRevision" => {
                if !is_revision(value) {
                    return Err(bad("意见深链的结果版本不合法"));
                }
                revision = Some(value);
            }
            "digest" if is_digest(value) => digest = Some(value),
            _ => return Err(bad("意见深链含协议之外的参数")),
        }
    }
    if seen.len() != 6
        || feedback_id.is_none()
        || review_id.is_none()
        || session_id.is_none()
        || revision.is_none()
        || digest.is_none()
    {
        return Err(bad("意见深链缺少必需参数"));
    }
    Ok(())
}

fn is_url_safe(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
}

fn is_revision(value: &str) -> bool {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) || value.is_empty() {
        return false;
    }
    if value.len() > 1 && value.starts_with('0') {
        return false;
    }
    value
        .parse::<u64>()
        .map(|number| number <= MAX_SAFE_REVISION)
        .unwrap_or(false)
}

pub(crate) fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// RFC 4122 连字符形式：8-4-4-4-12，十六进制。
pub(crate) fn is_id(value: &str) -> bool {
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
pub(crate) fn is_oid(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// 工作树路径：绝对路径（POSIX 的 / 开头或 Windows 的盘符形式）、无控制字符、长度有界。
/// 两端可能在不同平台上生成，所以两种绝对写法都接受；接收端仍要自己 canonicalize。
fn is_worktree_path(value: &str) -> bool {
    if value.is_empty()
        || value.chars().count() > MAX_WORKTREE_CHARS
        || value.chars().any(char::is_control)
        || value.starts_with('~')
    {
        return false;
    }
    let bytes = value.as_bytes();
    let posix = value.starts_with('/');
    let windows = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == 0x5c);
    posix || windows
}

fn is_range_version(value: &str) -> bool {
    let count = value.chars().count();
    (1..=MAX_RANGE_VERSION_CHARS).contains(&count) && !value.chars().any(char::is_control)
}

/// 仓库相对路径：非绝对、不用反斜杠、没有 . 或 .. 段、长度有界。
fn is_relative_path(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > MAX_PATH_CHARS {
        return false;
    }
    if value.chars().any(char::is_control) || value.contains('\\') {
        return false;
    }
    if value.starts_with('/') || value.ends_with('/') {
        return false;
    }
    value
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVIEW: &str = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
    const SESSION: &str = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
    const FEEDBACK: &str = "8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1";
    const BASELINE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HEAD: &str = "cccccccccccccccccccccccccccccccccccccccc";

    fn comment(id: &str, body: &str) -> FeedbackComment {
        FeedbackComment {
            id: id.to_string(),
            path: "src/lib/api.ts".to_string(),
            hunk_index: 0,
            kind: "add".to_string(),
            old_no: None,
            new_no: Some(12),
            body: body.to_string(),
        }
    }

    fn batch() -> Feedback {
        Feedback {
            v: VERSION,
            feedback_id: FEEDBACK.to_string(),
            review_id: REVIEW.to_string(),
            session_id: SESSION.to_string(),
            result_revision: 2,
            worktree_path: if cfg!(windows) {
                "C:/work/demo".to_string()
            } else {
                "/work/demo".to_string()
            },
            range_version: "range-7".to_string(),
            baseline_oid: BASELINE.to_string(),
            head_oid: HEAD.to_string(),
            comments: vec![
                comment("11111111-1111-4111-8111-111111111111", "这里要保留旧行为"),
                comment("22222222-2222-4222-8222-222222222222", "补一条失败用例"),
            ],
            digest: String::new(),
        }
    }

    fn signing(mut feedback: Feedback) -> Feedback {
        feedback.digest = digest_of(&feedback);
        feedback
    }

    /// 每次测试一个独立临时根，TempDir 由调用方持有到测试结束。
    fn temp_dir(root: &tempfile::TempDir) -> PathBuf {
        root.path().join(DIR_NAME)
    }

    #[test]
    fn prepare_writes_a_private_verified_file() {
        let root = tempfile::tempdir().expect("temp root");
        let dir = temp_dir(&root);
        let written = prepare(&dir, signing(batch())).expect("写入成功");
        assert_eq!(written.feedback_id, FEEDBACK);
        assert_eq!(written.comments.len(), 2);
        assert_eq!(written.digest, digest_of(&written));
        let path = dir.join(format!("{FEEDBACK}.json"));
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        // 回读与原生校验一致，且文件里没有临时文件残留。
        let read = read_file(&dir, FEEDBACK).expect("回读成功");
        assert_eq!(read, written);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_second_prepare_of_the_same_feedback_id_fails_without_overwriting() {
        let root = tempfile::tempdir().expect("temp root");
        let dir = temp_dir(&root);
        let first = prepare(&dir, signing(batch())).expect("首次写入");
        let mut changed = batch();
        changed.comments = vec![comment("33333333-3333-4333-8333-333333333333", "另一个批次")];
        let error = prepare(&dir, signing(changed)).expect_err("不允许覆盖");
        assert_eq!(error.code, DUPLICATE_BATCH);
        // 原文件保持第一次的内容。
        assert_eq!(read_file(&dir, FEEDBACK).unwrap(), first);
    }

    #[test]
    fn a_symlinked_target_is_rejected() {
        let root = tempfile::tempdir().expect("temp root");
        let dir = temp_dir(&root);
        ensure_dir(&dir).expect("目录");
        let outside = dir.with_extension("outside.json");
        fs::write(&outside, b"{}").expect("外部文件");
        let target = dir.join(format!("{FEEDBACK}.json"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &target).expect("符号链接");
        #[cfg(not(unix))]
        fs::copy(&outside, &target).expect("占位文件");
        let error = prepare(&dir, signing(batch())).expect_err("不接受已有目标");
        assert_eq!(error.code, DUPLICATE_BATCH);
        assert_eq!(read_file(&dir, FEEDBACK).unwrap_err().code, INVALID_BATCH);
    }

    #[test]
    fn a_symlinked_directory_is_rejected() {
        let root = tempfile::tempdir().expect("temp root");
        let real = root.path().join("real");
        fs::create_dir(&real).expect("真实目录");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let link = root.path().join(DIR_NAME);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("目录符号链接");
        #[cfg(not(unix))]
        fs::create_dir(&link).expect("占位目录");
        #[cfg(unix)]
        assert_eq!(ensure_dir(&link).unwrap_err().code, WRITE_FAILED);
        #[cfg(not(unix))]
        ensure_dir(&link).expect("普通目录可用");
    }

    #[test]
    fn oversized_serialized_file_is_not_published() {
        let root = tempfile::tempdir().unwrap();
        let dir = temp_dir(&root);
        let mut feedback = batch();
        feedback.comments = (0..MAX_COMMENTS)
            .map(|index| comment(&format!("33333333-3333-4333-8333-{index:012x}"), "x"))
            .collect();
        let overhead = canonical_bytes(&feedback).unwrap().len() - MAX_COMMENTS;
        let body = "x".repeat((MAX_FILE_BYTES - overhead) / MAX_COMMENTS);
        for comment in &mut feedback.comments {
            comment.body.clone_from(&body);
        }
        assert!(validated_digest(&feedback).is_ok());
        assert_eq!(prepare(&dir, feedback).unwrap_err().code, BATCH_TOO_LARGE);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn comment_limits_are_enforced_before_any_file_is_written() {
        let root = tempfile::tempdir().expect("temp root");
        let dir = temp_dir(&root);
        let mut many = signing(batch());
        many.comments = (0..=MAX_COMMENTS)
            .map(|index| {
                comment(
                    &format!("3333333{}-3333-4333-8333-33333333333{}", index % 10, index % 10),
                    "x",
                )
            })
            .collect();
        assert_eq!(
            prepare(&dir, signing(many)).unwrap_err().code,
            BATCH_TOO_LARGE
        );

        let mut large = signing(batch());
        large.comments = vec![comment(
            "44444444-4444-4444-8444-444444444444",
            &"x".repeat(MAX_BODY_BYTES + 1),
        )];
        assert_eq!(
            prepare(&dir, signing(large)).unwrap_err().code,
            BATCH_TOO_LARGE
        );

        let mut empty = signing(batch());
        empty.comments = Vec::new();
        assert_eq!(prepare(&dir, signing(empty)).unwrap_err().code, INVALID_BATCH);
        assert!(!dir.exists(), "失败时不应该创建目录或文件");
    }

    #[test]
    fn duplicate_comment_ids_and_bad_anchors_are_rejected() {
        let mut duplicated = signing(batch());
        duplicated.comments = vec![
            comment("55555555-5555-4555-8555-555555555555", "一"),
            comment("55555555-5555-4555-8555-555555555555", "二"),
        ];
        assert_eq!(validated_digest(&duplicated).unwrap_err().code, INVALID_BATCH);

        for path in ["/etc/passwd", "../outside", "src\\app.ts", "src/../app.ts", ""] {
            let mut wrong = signing(batch());
            wrong.comments[0].path = path.to_string();
            assert_eq!(validated_digest(&wrong).unwrap_err().code, INVALID_BATCH, "{path}");
        }

        let mut kind = signing(batch());
        kind.comments[0].kind = "meta".to_string();
        assert_eq!(validated_digest(&kind).unwrap_err().code, INVALID_BATCH);

        let mut unanchored = signing(batch());
        unanchored.comments[0].new_no = None;
        assert_eq!(validated_digest(&unanchored).unwrap_err().code, INVALID_BATCH);

        let mut v2 = signing(batch());
        v2.v = 2;
        assert_eq!(validated_digest(&v2).unwrap_err().code, UNSUPPORTED_VERSION);

        let mut revision = signing(batch());
        revision.result_revision = MAX_SAFE_REVISION + 1;
        assert_eq!(validated_digest(&revision).unwrap_err().code, INVALID_BATCH);
    }

    #[test]
    fn url_carries_only_identifiers_and_never_the_body_or_path() {
        let signed = signing(batch());
        let url = feedback_url(&signed).expect("深链");
        validate_url(&url).expect("符合 feedback-v1 入站规则");
        assert!(url.starts_with("cliora://review-feedback?v=1&feedbackId="));
        assert!(url.contains(&format!("&reviewId={REVIEW}")));
        assert!(url.contains("&resultRevision=2"));
        assert!(url.contains(&signed.digest));
        assert!(!url.contains("保留旧行为"));
        assert!(!url.contains("src/lib"));
        assert!(!url.contains(&signed.worktree_path));

        // 任何额外参数、重复参数或坏值都让整个深链无效。
        for hostile in [
            format!("{url}&body=hello"),
            format!("{url}&feedbackId={FEEDBACK}"),
            url.replacen("v=1", "v=2", 1),
            url.replacen("digest=", "digest=%", 1),
            url.replacen("resultRevision=2", "resultRevision=02", 1),
            url.replacen("cliora://review-feedback", "cliora://review", 1),
            format!("{url}#frag"),
        ] {
            assert_eq!(
                validate_url(&hostile).unwrap_err().code,
                INVALID_URL,
                "{hostile}"
            );
        }
        // digest 改一个字符就与正文不符。
        let mut tampered = signed.clone();
        tampered.digest = "0".repeat(64);
        assert_eq!(feedback_url(&tampered).unwrap_err().code, DIGEST_MISMATCH);
    }

    #[test]
    fn schema_rejects_extra_fields_and_oversized_files() {
        let signed = signing(batch());
        let mut value = serde_json::to_value(&signed).unwrap();
        value["extra"] = serde_json::json!(1);
        assert!(serde_json::from_value::<Feedback>(value).is_err());

        let root = tempfile::tempdir().expect("temp root");
        let dir = temp_dir(&root);
        ensure_dir(&dir).expect("目录");
        let path = dir.join(format!("{FEEDBACK}.json"));
        fs::write(&path, vec![b'{'; MAX_FILE_BYTES + 1]).unwrap();
        let error = read_file(&dir, FEEDBACK).expect_err("超限");
        assert_eq!(error.code, BATCH_TOO_LARGE);
    }

    /// 双端共享夹具：valid 必须通过校验、digest 与深链，其余按阶段失败。
    #[test]
    fn shared_fixture_holds_on_this_side() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/reviews/protocol-feedback-v1.json"))
                .expect("fixture json");
        assert_eq!(fixture["schemaVersion"], 1);
        let batches = fixture["batches"].as_array().expect("batches");
        assert!(batches.len() >= 8, "夹具要覆盖失败面");
        for case in batches {
            let name = case["name"].as_str().unwrap();
            let parsed = serde_json::from_value::<Feedback>(case["file"].clone());
            match case["reject"].as_str() {
                None => {
                    let feedback = parsed.expect(name);
                    assert_eq!(feedback.digest, digest_of(&feedback), "{name}: digest");
                    validated_digest(&feedback).expect(name);
                    let url = feedback_url(&feedback).expect(name);
                    validate_url(&url).expect(name);
                    assert!(!url.contains(&feedback.worktree_path), "{name}");
                }
                Some("schema") => assert!(parsed.is_err(), "{name}: 应该 schema 失败"),
                Some("digest") => {
                    let feedback = parsed.expect(name);
                    assert_ne!(feedback.digest, digest_of(&feedback), "{name}");
                    assert_eq!(feedback_url(&feedback).unwrap_err().code, DIGEST_MISMATCH);
                }
                Some("validation") => {
                    let feedback = parsed.expect(name);
                    assert!(validated_digest(&feedback).is_err(), "{name}: 应该校验失败");
                }
                Some(other) => panic!("未知的 reject 阶段 {other}"),
            }
        }
        let urls = fixture["urls"].as_array().expect("urls");
        for case in urls {
            let name = case["name"].as_str().unwrap();
            let url = case["url"].as_str().unwrap();
            let valid = case["valid"].as_bool().unwrap();
            assert_eq!(validate_url(url).is_ok(), valid, "{name}: {url}");
        }
    }
}

