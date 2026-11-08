use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::shutdown::Shutdown;

pub const MAX_GIT_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerError {
    Spawn(String),
    Io(String),
    Timeout,
    OutputLimit,
    Cancelled,
}

pub struct RunRequest {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub extra_env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    pub timeout: Duration,
    pub output_limit: usize,
    pub shutdown: Arc<Shutdown>,
    pub cancel: Option<Arc<Shutdown>>,
    pub stdin: Option<Vec<u8>>,
    /// When set, stdout stops at `output_limit` and the process is killed instead of failing.
    pub truncate_stdout: bool,
}

pub trait ProcessRunner: Send + Sync {
    fn run(
        &self,
        request: RunRequest,
    ) -> impl std::future::Future<Output = Result<ProcessOutput, RunnerError>> + Send;
}

#[derive(Clone)]
pub struct RealRunner {
    pub timeout: Duration,
    pub output_limit: usize,
    pub extra_env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
}

impl Default for RealRunner {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_GIT_TIMEOUT,
            output_limit: MAX_GIT_OUTPUT_BYTES,
            extra_env: Vec::new(),
        }
    }
}

impl RealRunner {
    pub fn base_request(
        &self,
        program: PathBuf,
        args: Vec<std::ffi::OsString>,
        shutdown: Arc<Shutdown>,
    ) -> RunRequest {
        RunRequest {
            program,
            args,
            extra_env: self.extra_env.clone(),
            timeout: self.timeout,
            output_limit: self.output_limit,
            shutdown,
            cancel: None,
            stdin: None,
            truncate_stdout: false,
        }
    }
}

impl ProcessRunner for RealRunner {
    async fn run(&self, request: RunRequest) -> Result<ProcessOutput, RunnerError> {
        run_process(request).await
    }
}

pub const SSH_BATCH_COMMAND: &str = "ssh -o BatchMode=yes";

fn apply_noninteractive(
    command: &mut Command,
    extra_env: &[(std::ffi::OsString, std::ffi::OsString)],
) {
    let overridden = |name: &str| extra_env.iter().any(|(key, _)| key == name);
    command.env("GIT_TERMINAL_PROMPT", "0");
    if !overridden("GCM_INTERACTIVE") {
        command.env("GCM_INTERACTIVE", "Never");
    }
    let ssh_overridden = overridden("GIT_SSH_COMMAND") || overridden("GIT_SSH");
    let ssh_inherited =
        std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some();
    if !ssh_overridden && !ssh_inherited {
        command.env("GIT_SSH_COMMAND", SSH_BATCH_COMMAND);
    }
}

pub async fn run_process(request: RunRequest) -> Result<ProcessOutput, RunnerError> {
    if request.shutdown.is_cancelled() {
        return Err(RunnerError::Cancelled);
    }
    let mut command = Command::new(&request.program);
    // Git runs behind the desktop UI. Piped output alone does not prevent
    // Windows from creating a console for every status/diff/refresh process.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
        .args(&request.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if request.stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    for (key, value) in &request.extra_env {
        command.env(key, value);
    }
    apply_noninteractive(&mut command, &request.extra_env);
    let mut child = command
        .spawn()
        .map_err(|error| RunnerError::Spawn(error.to_string()))?;
    // batch-check 一边读对象名一边输出结果。输入和输出必须同时推进，
    // 否则两边的管道填满后互相等待，且 stdin 写入也绕过了超时和取消。
    let stdin = child.stdin.take();
    let mut stdin_write = Some(Box::pin(async move {
        if let Some(bytes) = request.stdin {
            let mut stdin = stdin.ok_or_else(|| RunnerError::Io("缺少 stdin".into()))?;
            stdin
                .write_all(&bytes)
                .await
                .map_err(|error| RunnerError::Io(error.to_string()))?;
        }
        Ok::<(), RunnerError>(())
    }));
    let mut stdin_result = None;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RunnerError::Io("缺少 stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| RunnerError::Io("缺少 stderr".into()))?;
    let mut stdout_read = Box::pin(read_capped(
        stdout,
        request.output_limit,
        request.truncate_stdout,
    ));
    let mut stderr_read = Box::pin(read_capped(stderr, request.output_limit, false));
    let mut stdout_buf = None;
    let mut stderr_buf = None;
    let mut stdout_truncated = false;
    let mut status = None;
    let mut stop: Option<RunnerError> = None;
    let sleep = tokio::time::sleep(request.timeout);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            result = async {
                match stdin_write.as_mut() {
                    Some(write) => write.await,
                    None => std::future::pending().await,
                }
            }, if stdin_result.is_none() => {
                stdin_result = Some(result);
            }
            result = &mut stdout_read, if stdout_buf.is_none() => {
                let (buf, truncated) = result?;
                stdout_truncated = truncated;
                stdout_buf = Some(buf);
            }
            result = &mut stderr_read, if stderr_buf.is_none() => {
                stderr_buf = Some(result?.0);
            }
            result = child.wait(), if status.is_none() => {
                status = Some(result.map_err(|error| RunnerError::Io(error.to_string()))?);
            }
            _ = &mut sleep => {
                stop = Some(RunnerError::Timeout);
            }
            _ = request.shutdown.cancelled() => {
                stop = Some(RunnerError::Cancelled);
            }
            _ = async {
                match &request.cancel {
                    Some(cancel) => cancel.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                stop = Some(RunnerError::Cancelled);
            }
        }
        if let Some(error) = stop.take() {
            // 先丢掉写端，Windows 上写满的管道不会因为子进程退出而结束这次写入。
            drop(stdin_write.take());
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
        if stdout_truncated && stdin_write.take().is_some() {
            if stdin_result.is_none() {
                stdin_result = Some(Ok(()));
            }
            let _ = child.kill().await;
        }
        if stdout_buf.is_some()
            && stderr_buf.is_some()
            && status.is_some()
            && stdin_result.is_some()
        {
            break;
        }
    }
    // 主动截断输出时杀进程，可能同时中断 stdin；这不应把成功的预览变成 I/O 错误。
    if !stdout_truncated {
        stdin_result.expect("stdin checked")?;
    }
    let status = status.expect("status checked");
    Ok(ProcessOutput {
        exit_code: status.code().unwrap_or(-1),
        stdout: stdout_buf.unwrap_or_default(),
        stderr: stderr_buf.unwrap_or_default(),
        stdout_truncated,
    })
}

async fn read_capped<R>(
    mut reader: R,
    limit: usize,
    truncate: bool,
) -> Result<(Vec<u8>, bool), RunnerError>
where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| RunnerError::Io(error.to_string()))?;
        if read == 0 {
            return Ok((buf, false));
        }
        if buf.len().saturating_add(read) > limit {
            if !truncate {
                return Err(RunnerError::OutputLimit);
            }
            let room = limit.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..room]);
            return Ok((buf, true));
        }
        buf.extend_from_slice(&chunk[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn python() -> Option<PathBuf> {
        std::env::var_os("PYTHON").map(PathBuf::from).or_else(|| {
            ["python3", "python"].iter().find_map(|name| {
                std::env::var_os("PATH").and_then(|path| {
                    std::env::split_paths(&path).find_map(|dir| {
                        let candidate = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
                        candidate.is_file().then_some(candidate)
                    })
                })
            })
        })
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn background_process_has_no_console_window_and_preserves_output() {
        let program = python().expect("需要 Python 来验证 Windows 后台进程");
        // CREATE_NO_WINDOW retains a private console (and its code page), so
        // inspect its window and membership rather than GetConsoleCP(). This
        // also detects accidental inheritance of a headless test terminal.
        let probe = format!(
            "import ctypes, sys; k=ctypes.windll.kernel32; pids=(ctypes.c_ulong*256)(); k.GetConsoleProcessList(pids, 256); print(int(bool(k.GetConsoleWindow())), int({} in pids)); print('diagnostic', file=sys.stderr); sys.exit(7)",
            std::process::id(),
        );
        let request = RealRunner::default().base_request(
            program,
            vec!["-c".into(), probe.into()],
            Arc::new(Shutdown::new()),
        );
        let output = run_process(request).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0 0");
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "diagnostic");
        assert_eq!(output.exit_code, 7);
    }

    #[tokio::test]
    async fn stdin_and_output_are_drained_together() {
        let program = python().expect("需要 Python 来验证双向管道");
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        let mut request = RealRunner::default().base_request(
            program,
            vec!["-c".into(), "import sys\nwhile True:\n data = sys.stdin.buffer.read1(8192)\n if not data: break\n sys.stdout.buffer.write(data)\n sys.stdout.buffer.flush()\n sys.stderr.buffer.write(data)\n sys.stderr.buffer.flush()".into()],
            Arc::new(Shutdown::new()),
        );
        request.stdin = Some(bytes.clone());
        // 挂起保护：正常回显一瞬间就结束；真卡死才会耗到上限。放宽到 15s 吸收 CI（尤其 Windows）
        // 进程启动与 2MB 管道的抖动，又远低于子进程里的 sleep，死锁仍会被判失败。
        let result = tokio::time::timeout(Duration::from_secs(15), run_process(request)).await;
        let output = result.expect("stdin 写入和输出读取互相阻塞").unwrap();
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, bytes);
        assert_eq!(output.stderr, bytes);
    }

    #[tokio::test]
    async fn timeout_covers_a_child_that_never_reads_stdin() {
        let program = python().expect("需要 Python 来验证 stdin 超时");
        let mut request = RealRunner::default().base_request(
            program,
            vec!["-c".into(), "import time; time.sleep(30)".into()],
            Arc::new(Shutdown::new()),
        );
        request.stdin = Some(vec![b'x'; 2 * 1024 * 1024]);
        request.timeout = Duration::from_millis(100);
        // 挂起保护：超时生效应在 100ms 量级返回；子进程 sleep(30) 只在超时失效时才会撑满。
        // 15s 远高于 CI 启动抖动、远低于 30s，超时被破坏仍能判失败。
        let result = tokio::time::timeout(Duration::from_secs(15), run_process(request)).await;
        assert_eq!(
            result.expect("stdin 写入也必须受超时保护"),
            Err(RunnerError::Timeout)
        );
    }

    #[tokio::test]
    async fn cancelling_and_truncating_also_work_during_stdin_write() {
        let program = python().expect("需要 Python 来验证 stdin 期间的取消和截断");
        let cancel = Arc::new(Shutdown::new());
        let signal = cancel.clone();
        let mut request = RealRunner::default().base_request(
            program.clone(),
            vec!["-c".into(), "import time; time.sleep(30)".into()],
            Arc::new(Shutdown::new()),
        );
        request.stdin = Some(vec![b'x'; 2 * 1024 * 1024]);
        request.cancel = Some(cancel);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            signal.cancel();
        });
        // 挂起保护：取消在 80ms 后触发，正常应随即返回；取消失效会拖到子进程 sleep(30)。
        // 15s 吸收 CI 抖动且远低于 30s，取消被破坏仍判失败。
        let result = tokio::time::timeout(Duration::from_secs(15), run_process(request)).await;
        assert_eq!(result.unwrap(), Err(RunnerError::Cancelled));

        let mut request = RealRunner::default().base_request(
            program,
            vec!["-c".into(), "import sys, time; sys.stdout.buffer.write(b'x'*2000000); sys.stdout.buffer.flush(); time.sleep(30)".into()],
            Arc::new(Shutdown::new()),
        );
        request.stdin = Some(vec![b'x'; 2 * 1024 * 1024]);
        request.output_limit = 1024;
        request.truncate_stdout = true;
        // 挂起保护：截断命中上限后应立即收尾；截断失效会读完 2MB 再卡在 sleep(30)。
        // 15s 吸收 CI 抖动且远低于 30s，截断被破坏仍判失败。
        let result = tokio::time::timeout(Duration::from_secs(15), run_process(request)).await;
        let output = result.unwrap().unwrap();
        assert!(output.stdout_truncated);
        assert_eq!(output.stdout.len(), 1024);
    }

    #[tokio::test]
    async fn output_limit_stops_a_flood_of_bytes() {
        let Some(program) = python() else {
            panic!("需要 Python 来验证输出上限");
        };
        let shutdown = Arc::new(Shutdown::new());
        let started = Instant::now();
        let error = run_process(RunRequest {
            program,
            args: vec![
                "-c".into(),
                "import sys; sys.stdout.buffer.write(b'a'*2000000)".into(),
            ],
            extra_env: Vec::new(),
            timeout: Duration::from_secs(10),
            output_limit: 1024,
            shutdown,
            cancel: None,
            stdin: None,
            truncate_stdout: false,
        })
        .await
        .unwrap_err();
        assert_eq!(error, RunnerError::OutputLimit);
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[tokio::test]
    async fn shutdown_kills_a_sleeping_process() {
        let Some(program) = python() else {
            panic!("需要 Python 来验证关闭时停止子进程");
        };
        let shutdown = Arc::new(Shutdown::new());
        let cancel = shutdown.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancel.cancel();
        });
        let started = Instant::now();
        let error = run_process(RunRequest {
            program,
            args: vec!["-c".into(), "import time; time.sleep(30)".into()],
            extra_env: Vec::new(),
            timeout: Duration::from_secs(10),
            output_limit: 1024,
            shutdown,
            cancel: None,
            stdin: None,
            truncate_stdout: false,
        })
        .await
        .unwrap_err();
        assert_eq!(error, RunnerError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
