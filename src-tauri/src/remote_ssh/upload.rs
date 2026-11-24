use std::{future::Future, time::Duration};

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

use super::{ssh_failed, timed_out, Result};

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(600);

/// 同时排空子进程的回执和诊断，发送完所有字节并关闭管道后才开始计回执时限。
pub(crate) async fn transfer(
    mut stdin: impl AsyncWrite + Unpin,
    bytes: &[u8],
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    receipt: impl Future<Output = Result<()>>,
) -> Result<()> {
    let send = async move {
        let mut sent = 0;
        progress(0, bytes.len() as u64);
        while sent < bytes.len() {
            let end = (sent + 64 * 1024).min(bytes.len());
            // 一次 write 可以只送出部分字节，每次实际推进都重启无进度计时。
            let count = timeout(IDLE_TIMEOUT, stdin.write(&bytes[sent..end]))
                .await
                .map_err(|_| timed_out("组件上传进度"))?
                .map_err(|_| ssh_failed())?;
            if count == 0 {
                return Err(ssh_failed());
            }
            sent += count;
            progress(sent as u64, bytes.len() as u64);
        }
        timeout(IDLE_TIMEOUT, stdin.shutdown())
            .await
            .map_err(|_| timed_out("组件上传结束"))?
            .map_err(|_| ssh_failed())
    };
    tokio::pin!(send, receipt);
    tokio::select! {
        result = &mut receipt => {
            result?;
            send.await
        }
        written = &mut send => {
            if matches!(&written, Err(error) if error.code == "remote_timeout") {
                return written;
            }
            // 子进程可能因认证或摘要错误提前关掉管道，优先保留它的明确诊断。
            timeout(RECEIPT_TIMEOUT, receipt)
                .await
                .map_err(|_| timed_out("安装回执"))??;
            written
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{duplex, AsyncReadExt};
    use tokio::time::{sleep, Instant};

    #[tokio::test(start_paused = true)]
    async fn slow_writes_outlast_the_idle_limit_and_close_stdin_for_the_receipt() {
        let (stdin, mut remote) = duplex(1);
        let start = Instant::now();
        let progress = Mutex::new(Vec::new());
        let receipt = async {
            for expected in b"slow" {
                sleep(IDLE_TIMEOUT / 2).await;
                assert_eq!(remote.read_u8().await.unwrap(), *expected);
            }
            assert_eq!(remote.read(&mut [0]).await.unwrap(), 0);
            Ok(())
        };
        transfer(
            stdin,
            b"slow",
            &|sent, total| {
                progress.lock().unwrap().push((sent, total));
            },
            receipt,
        )
        .await
        .unwrap();
        assert!(start.elapsed() > IDLE_TIMEOUT);
        assert_eq!(
            *progress.lock().unwrap(),
            [(0, 4), (1, 4), (2, 4), (3, 4), (4, 4)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_upload_drops_the_pipe_at_the_idle_deadline() {
        let (stdin, mut remote) = duplex(1);
        let error = transfer(stdin, b"ab", &|_, _| {}, std::future::pending())
            .await
            .unwrap_err();
        assert_eq!(error.code, "remote_timeout");
        assert!(error.message.contains("上传进度"));
        assert_eq!(remote.read_u8().await.unwrap(), b'a');
        assert_eq!(remote.read(&mut [0]).await.unwrap(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_receipt_times_out_after_a_successful_send() {
        let (stdin, _remote) = duplex(1);
        let error = transfer(stdin, b"a", &|_, _| {}, std::future::pending())
            .await
            .unwrap_err();
        assert_eq!(error.code, "remote_timeout");
        assert!(error.message.contains("安装回执"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_pipe_preserves_the_installers_diagnostic() {
        let (stdin, remote) = duplex(1);
        drop(remote);
        let receipt = async {
            sleep(Duration::from_secs(1)).await;
            Err(super::super::ssh_error("agent_digest_mismatch", Some(4)))
        };
        let error = transfer(stdin, b"a", &|_, _| {}, receipt)
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_digest_mismatch");
    }
}
