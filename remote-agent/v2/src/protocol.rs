//! v2 协议边界：有界 JSON Lines、请求标识、版本握手与响应帧。
//!
//! 与 v1 的差别只在于版本号和能力面，帧的约束保持一致：一条请求一行、UTF-8、请求最多
//! 128 KiB、单条响应最多 4 MiB、同一通道最多 16 个在途请求。响应可以乱序返回，客户端按
//! `id` 匹配，因此取消与选择抢占不需要独占整条通道。

use serde_json::{Map, Value};

use crate::error::AppError;

pub const PROTOCOL: u32 = 2;
pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_IN_FLIGHT: usize = 16;
const MAX_TOKEN: usize = 80;

/// 能力面：客户端据此判断能否操作某类仓库行为，缺项即不支持，不回退本机 Git。
pub const CAPABILITIES: &[&str] = &[
    // 基础（T1）
    "open",
    "status",
    "diff",
    "stage",
    "unstage",
    "patch",
    "commit",
    "receipt",
    "cancel",
    // 历史、比较与文件历史（T2）
    "history",
    "fileHistory",
    "commitDetail",
    "commitDiff",
    "compare",
    // 提交与任意两点之间的单文件差异（桌面主窗口已在用，v2 必须同名可用）
    "commitBranches",
    "compareFileDiff",
    // 分支、标签、同步（T2）
    "branchList",
    "branchState",
    "branchTracking",
    "fetchBranches",
    "deleteRemoteBranch",
    "setUpstream",
    "associateUpstream",
    "tagRemoteState",
    "branchCreate",
    "branchSwitch",
    "branchRename",
    "branchDelete",
    "branchTrack",
    "branchUpdate",
    "branchPublish",
    "tagState",
    "tagCreate",
    "tagDelete",
    "tagPush",
    "remoteState",
    "remoteAdd",
    "remoteSetUrl",
    "fetch",
    "pull",
    "push",
    "pushToRemote",
    "publishBranch",
    // stash、合并/变基/拣选/回退、修订撤销、worktree（T2）
    "stashState",
    "stashSave",
    "stashApply",
    "stashDelete",
    "mergePreview",
    "mergeSession",
    "mergeStart",
    "mergeComplete",
    "mergeAbort",
    "conflictView",
    "resolveConflict",
    "cherryPick",
    "revert",
    "undoCommit",
    "checkoutCommit",
    "amendCommit",
    "discard",
    "worktrees",
    "worktreeRemove",
];

pub struct Request {
    pub id: String,
    pub op: String,
    pub fields: Map<String, Value>,
}

/// 请求本身不合法时仍要回答，因此连可用的 `id` 一起带回。
pub struct Rejection {
    pub id: String,
    pub error: AppError,
}

impl Rejection {
    fn new(id: impl Into<String>, code: &str, message: &str) -> Self {
        Self {
            id: id.into(),
            error: AppError::new(code, message),
        }
    }
}

/// 帧标识：1–80 个 ASCII 字母、数字、下划线或连字符。
pub fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn parse_request(line: &[u8]) -> Result<Request, Rejection> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err(Rejection::new(
            "0",
            "request_too_large",
            "请求超过 128 KiB，未执行。",
        ));
    }
    let value: Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(_) => {
            return Err(Rejection::new(
                "0",
                "invalid_json",
                "请求不是合法的 JSON 行，未执行。",
            ))
        }
    };
    let Value::Object(mut fields) = value else {
        return Err(Rejection::new("0", "invalid_request", "请求必须是对象。"));
    };
    let id = match fields.remove("id") {
        Some(Value::String(id)) if token(&id) => id,
        _ => return Err(Rejection::new("0", "invalid_request", "请求标识无效。")),
    };
    match fields.remove("v") {
        Some(Value::Number(number)) if number.as_u64() == Some(PROTOCOL as u64) => {}
        Some(_) => {
            return Err(Rejection::new(
                id,
                "unsupported_protocol",
                "只接受 v2 协议请求。",
            ))
        }
        None => {
            return Err(Rejection::new(
                id,
                "invalid_request",
                "请求缺少协议版本。",
            ))
        }
    }
    let op = match fields.remove("op") {
        Some(Value::String(op)) if token(&op) => op,
        _ => {
            return Err(Rejection::new(
                id,
                "invalid_request",
                "请求缺少可识别的操作。",
            ))
        }
    };
    Ok(Request { id, op, fields })
}

pub fn ok_frame(id: &str, result: Value) -> Vec<u8> {
    let frame = serde_json::json!({ "v": PROTOCOL, "id": id, "ok": true, "result": result });
    bounded(id, frame)
}

pub fn err_frame(id: &str, error: &AppError) -> Vec<u8> {
    let frame = serde_json::json!({ "v": PROTOCOL, "id": id, "ok": false, "error": error });
    bounded(id, frame)
}

/// 结果超出单帧上限时换成明确的错误，绝不发送半截 JSON。
fn bounded(id: &str, frame: Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&frame).unwrap_or_default();
    if bytes.len() > MAX_RESPONSE_BYTES {
        let error = AppError::new(
            "result_too_large",
            "响应超过 4 MiB，请减少每页数量或缩小请求范围。",
        );
        bytes = serde_json::to_vec(&serde_json::json!({
            "v": PROTOCOL,
            "id": id,
            "ok": false,
            "error": error,
        }))
        .unwrap_or_default();
    }
    bytes
}
