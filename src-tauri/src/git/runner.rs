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
    if let Some(bytes) = request.stdin {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| RunnerError::Io("缺少 stdin".into()))?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| RunnerError::Io(error.to_string()))?;
    }
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
    let sleep = tokio::time::sleep(request.timeout);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            result = &mut stdout_read, if stdout_buf.is_none() => {
                let (buf, truncated) = result?;
                if truncated {
                    stdout_truncated = true;
                    let _ = child.kill().await;
                }
                stdout_buf = Some(buf);
            }
            result = &mut stderr_read, if stderr_buf.is_none() => {
                stderr_buf = Some(result?.0);
            }
            result = child.wait(), if status.is_none() => {
                status = Some(result.map_err(|error| RunnerError::Io(error.to_string()))?);
            }
            _ = &mut sleep => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(RunnerError::Timeout);
            }
            _ = request.shutdown.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(RunnerError::Cancelled);
            }
            _ = async {
                match &request.cancel {
                    Some(cancel) => cancel.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(RunnerError::Cancelled);
            }
        }
        if stdout_buf.is_some() && stderr_buf.is_some() && status.is_some() {
            break;
        }
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
