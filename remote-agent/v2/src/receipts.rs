//! 远端持久写入回执。
//!
//! 回执写在 common Git dir 下的 `twiglane-agent-v2/receipts/`：与仓库身份绑定，同一仓库的
//! 多个工作区、多个 agent 进程都能读到同一份记录；不写进桌面设置，也不覆盖 v1 的
//! `XDG_STATE_HOME` 记录。每条回执先落 `registered` 再执行写入，成功后改成 `completed`；
//! 写入前失败记 `failed`。进程在两步之间崩溃时，回执停在 `registered`，重连后按
//! 「结果待确认」处理，不能重发。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub const RECEIPT_DIR: &str = "twiglane-agent-v2";
pub const REGISTERED: &str = "registered";
pub const COMPLETED: &str = "completed";
pub const FAILED: &str = "failed";
/// 结果未知：远程写入被取消、超时或网络中断，远端可能已经收到请求。
/// 这类回执既不能当失败重发，也不能当完成，客户端只能按「待核对」处理。
pub const PENDING: &str = "pending";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub operation_id: String,
    pub repo: String,
    pub op: String,
    /// 请求字段的规范摘要：同一个操作 ID 只能匹配同一个请求。
    pub request_digest: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub generation: u64,
    pub at_ms: u64,
}

impl Receipt {
    pub fn registered(
        operation_id: &str,
        repo: &str,
        op: &str,
        request_digest: &str,
        before_head: Option<String>,
        generation: u64,
    ) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            repo: repo.to_string(),
            op: op.to_string(),
            request_digest: request_digest.to_string(),
            state: REGISTERED.to_string(),
            reason: None,
            before_head,
            head: None,
            branch: None,
            generation,
            at_ms: now_ms(),
        }
    }
}

pub struct ReceiptStore {
    dir: PathBuf,
}

impl ReceiptStore {
    pub fn new(git_dir: &Path) -> Self {
        Self {
            dir: git_dir.join(RECEIPT_DIR).join("receipts"),
        }
    }

    /// 读取一条回执。
    ///
    /// 三种结果必须分开：没有任何记录（Ok(None)，可以开始新写入）、读到完整记录、以及
    /// 「文件存在但读不出来」（Err）。最后一种说明磁盘上已经有该操作 ID 的痕迹，但内容
    /// 不可核对；它既不能当成没写过而重新执行，也不能当成已完成，调用方只能按「结果
    /// 待确认」处理，并拒绝同一 operationId 的再次写入。
    pub fn read(&self, operation_id: &str) -> Result<Option<Receipt>, AppError> {
        let path = self.dir.join(format!("{operation_id}.json"));
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AppError::new(
                    "receipt_unreadable",
                    format!("回执文件无法读取，结果未确认，不会重复写入。{error}"),
                ))
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(receipt) => Ok(Some(receipt)),
            Err(_) => Err(AppError::new(
                "receipt_unreadable",
                "回执文件存在但无法解析，结果未确认，不会重复写入。",
            )),
        }
    }

    /// 原子替换：先写临时文件并 fsync，再 rename，最后 fsync 目录。任何一步失败都报错，
    /// 由调用方决定是否继续写入。
    pub fn write(&self, receipt: &Receipt) -> Result<(), AppError> {
        fs::create_dir_all(&self.dir).map_err(|error| {
            AppError::new(
                "receipt_unavailable",
                format!("无法创建回执目录，未写入仓库。{error}"),
            )
        })?;
        let target = self.dir.join(format!("{}.json", receipt.operation_id));
        let temporary = self
            .dir
            .join(format!("{}.json.{}.tmp", receipt.operation_id, std::process::id()));
        let bytes = serde_json::to_vec(receipt)
            .map_err(|_| AppError::new("receipt_unavailable", "回执无法序列化，未写入仓库。"))?;
        let mut file = File::create(&temporary).map_err(|error| {
            AppError::new(
                "receipt_unavailable",
                format!("无法写入回执，未写入仓库。{error}"),
            )
        })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                let _ = fs::remove_file(&temporary);
                AppError::new(
                    "receipt_unavailable",
                    format!("无法持久化回执，未写入仓库。{error}"),
                )
            })?;
        drop(file);
        fs::rename(&temporary, &target).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            AppError::new(
                "receipt_unavailable",
                format!("无法替换回执，未写入仓库。{error}"),
            )
        })?;
        // 目录项本身也要落盘，否则断电后 rename 可能丢失。Windows 不允许打开目录，忽略即可。
        let _ = File::open(&self.dir).and_then(|dir| dir.sync_all());
        Ok(())
    }

    pub fn fail(
        &self,
        mut receipt: Receipt,
        reason: impl Into<String>,
    ) -> Result<Receipt, AppError> {
        receipt.state = FAILED.to_string();
        receipt.reason = Some(reason.into());
        receipt.at_ms = now_ms();
        self.write(&receipt)?;
        Ok(receipt)
    }

    /// 结果未确认：记录真实原因，但不声称失败——远端可能已经执行过。
    pub fn pending(
        &self,
        mut receipt: Receipt,
        reason: impl Into<String>,
    ) -> Result<Receipt, AppError> {
        receipt.state = PENDING.to_string();
        receipt.reason = Some(reason.into());
        receipt.at_ms = now_ms();
        self.write(&receipt)?;
        Ok(receipt)
    }

    pub fn complete(
        &self,
        mut receipt: Receipt,
        head: Option<String>,
        branch: Option<String>,
        generation: u64,
    ) -> Result<Receipt, AppError> {
        receipt.state = COMPLETED.to_string();
        receipt.head = head;
        receipt.branch = branch;
        receipt.generation = generation;
        receipt.at_ms = now_ms();
        self.write(&receipt)?;
        Ok(receipt)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
