use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore};

use crate::error::AppError;
use crate::git::runner::{ProcessOutput, ProcessRunner, RunRequest, RunnerError};
use crate::shutdown::Shutdown;

pub const MAX_CONCURRENT_READS: usize = 2;

const INTERNAL_REQUEST_BIT: u64 = 1 << 63;
static INTERNAL_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

// Frontend request ids are sequential JSON integers. Internal Git steps stay above this bit
// so an in-flight diff, stage, or commit cannot occupy the next user command.
pub fn internal_request_id() -> u64 {
    let seq = INTERNAL_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    INTERNAL_REQUEST_BIT | (seq & (INTERNAL_REQUEST_BIT - 1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    Read,
    Write,
}

pub struct GitJob {
    pub repo_key: String,
    pub kind: JobKind,
    pub request_id: u64,
    pub generation: u64,
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub stdin: Option<Vec<u8>>,
    pub truncate_stdout: bool,
    pub output_limit: Option<usize>,
}

pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub stdin: Option<Vec<u8>>,
    pub truncate_stdout: bool,
    pub output_limit: Option<usize>,
    pub writes: bool,
}

#[derive(Debug)]
pub struct ScheduledOutput {
    pub output: ProcessOutput,
    pub generation: u64,
}

struct RepoLane {
    write: Arc<Mutex<()>>,
    generation: AtomicU64,
}

pub struct GitScheduler<R> {
    runner: R,
    read_limit: Arc<Semaphore>,
    lanes: StdMutex<HashMap<String, Arc<RepoLane>>>,
    inflight: StdMutex<HashSet<u64>>,
    shutdown: Arc<Shutdown>,
    timeout: Duration,
    output_limit: usize,
    extra_env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    read_cancel: StdMutex<Arc<Shutdown>>,
}

impl<R: ProcessRunner> GitScheduler<R> {
    pub fn new(
        runner: R,
        shutdown: Arc<Shutdown>,
        timeout: Duration,
        output_limit: usize,
        extra_env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    ) -> Self {
        Self {
            runner,
            read_limit: Arc::new(Semaphore::new(MAX_CONCURRENT_READS)),
            lanes: StdMutex::new(HashMap::new()),
            inflight: StdMutex::new(HashSet::new()),
            shutdown,
            timeout,
            output_limit,
            extra_env,
            read_cancel: StdMutex::new(Arc::new(Shutdown::new())),
        }
    }

    pub fn cancel_reads(&self) {
        let mut slot = self
            .read_cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        slot.cancel();
        *slot = Arc::new(Shutdown::new());
    }

    fn read_cancel_token(&self) -> Arc<Shutdown> {
        self.read_cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn current_generation(&self, repo_key: &str) -> u64 {
        self.lane(repo_key).generation.load(Ordering::SeqCst)
    }

    pub fn bump_generation(&self, repo_key: &str) -> u64 {
        self.lane(repo_key)
            .generation
            .fetch_add(1, Ordering::SeqCst)
            + 1
    }

    pub async fn execute(&self, job: GitJob) -> Result<ScheduledOutput, AppError> {
        if self.shutdown.is_cancelled() {
            return Err(AppError::new("cancelled", "操作已取消。"));
        }
        let _request = RequestGuard::enter(&self.inflight, job.request_id)?;
        let lane = self.lane(&job.repo_key);
        let _read_permit;
        let _write_guard;
        match job.kind {
            JobKind::Read => {
                _read_permit = self
                    .read_limit
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| AppError::new("cancelled", "读取调度已关闭。"))?;
            }
            JobKind::Write => {
                _write_guard = lane.write.lock().await;
            }
        }
        let generation = lane.generation.load(Ordering::SeqCst);
        if generation != job.generation {
            return Err(
                AppError::new("stale", "仓库状态已变化，请查看刷新后的结果。")
                    .with_generation(generation),
            );
        }
        if self.shutdown.is_cancelled() {
            return Err(AppError::new("cancelled", "操作已取消。"));
        }
        let cancel = match job.kind {
            JobKind::Read => Some(self.read_cancel_token()),
            JobKind::Write => None,
        };
        let result = self
            .runner
            .run(RunRequest {
                program: job.program,
                args: job.args,
                extra_env: self.extra_env.clone(),
                timeout: self.timeout,
                output_limit: job.output_limit.unwrap_or(self.output_limit),
                shutdown: self.shutdown.clone(),
                cancel,
                stdin: job.stdin,
                truncate_stdout: job.truncate_stdout,
            })
            .await;
        if job.kind == JobKind::Write {
            lane.generation.fetch_add(1, Ordering::SeqCst);
        }
        let output = map_runner(result)?;
        let after = lane.generation.load(Ordering::SeqCst);
        if job.kind == JobKind::Read && after != job.generation {
            return Err(
                AppError::new("stale", "仓库状态已变化，请查看刷新后的结果。")
                    .with_generation(after),
            );
        }
        Ok(ScheduledOutput {
            output,
            generation: after,
        })
    }

    fn lane(&self, repo_key: &str) -> Arc<RepoLane> {
        let mut lanes = self.lanes.lock().unwrap_or_else(|error| error.into_inner());
        lanes
            .entry(repo_key.to_string())
            .or_insert_with(|| {
                Arc::new(RepoLane {
                    write: Arc::new(Mutex::new(())),
                    generation: AtomicU64::new(1),
                })
            })
            .clone()
    }
}

pub struct WriteGuard<'a, R: ProcessRunner> {
    scheduler: &'a GitScheduler<R>,
    lane: Arc<RepoLane>,
    _write: OwnedMutexGuard<()>,
    _request: RequestGuard<'a>,
    wrote: bool,
}

impl<'a, R: ProcessRunner> WriteGuard<'a, R> {
    pub async fn run(&mut self, spec: CommandSpec) -> Result<ProcessOutput, AppError> {
        if self.scheduler.shutdown.is_cancelled() {
            return Err(AppError::new("cancelled", "操作已取消。"));
        }
        if spec.writes {
            self.wrote = true;
        }
        let output = self
            .scheduler
            .runner
            .run(RunRequest {
                program: spec.program,
                args: spec.args,
                extra_env: self.scheduler.extra_env.clone(),
                timeout: self.scheduler.timeout,
                output_limit: spec.output_limit.unwrap_or(self.scheduler.output_limit),
                shutdown: self.scheduler.shutdown.clone(),
                cancel: None,
                stdin: spec.stdin,
                truncate_stdout: spec.truncate_stdout,
            })
            .await;
        map_runner(output)
    }

    /// 标记这次持锁期间写了仓库（例如直接改写 .gitignore 这类非 Git 命令的写入），
    /// 让 generation 照常递增，过期响应仍会被拒绝。
    pub fn mark_written(&mut self) {
        self.wrote = true;
    }

    pub fn finish(mut self) -> u64 {
        if self.wrote {
            self.wrote = false;
            self.lane.generation.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            self.lane.generation.load(Ordering::SeqCst)
        }
    }
}

impl<R: ProcessRunner> Drop for WriteGuard<'_, R> {
    fn drop(&mut self) {
        if self.wrote {
            self.lane.generation.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl<R: ProcessRunner> GitScheduler<R> {
    pub async fn lock_write(
        &self,
        repo_key: &str,
        request_id: u64,
        generation: u64,
    ) -> Result<WriteGuard<'_, R>, AppError> {
        if self.shutdown.is_cancelled() {
            return Err(AppError::new("cancelled", "操作已取消。"));
        }
        let request = RequestGuard::enter(&self.inflight, request_id)?;
        let lane = self.lane(repo_key);
        let write = lane.write.clone().lock_owned().await;
        let current = lane.generation.load(Ordering::SeqCst);
        if current != generation {
            return Err(
                AppError::new("stale", "仓库状态已变化，请查看刷新后的结果。")
                    .with_generation(current),
            );
        }
        Ok(WriteGuard {
            scheduler: self,
            lane,
            _write: write,
            _request: request,
            wrote: false,
        })
    }
}

struct RequestGuard<'a> {
    inflight: &'a StdMutex<HashSet<u64>>,
    id: u64,
}

impl<'a> RequestGuard<'a> {
    fn enter(inflight: &'a StdMutex<HashSet<u64>>, id: u64) -> Result<Self, AppError> {
        let mut guard = inflight.lock().unwrap_or_else(|error| error.into_inner());
        if !guard.insert(id) {
            return Err(AppError::new("duplicate", "该操作正在执行，未重复启动。"));
        }
        drop(guard);
        Ok(Self { inflight, id })
    }
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.inflight.lock() {
            guard.remove(&self.id);
        }
    }
}

fn map_runner(result: Result<ProcessOutput, RunnerError>) -> Result<ProcessOutput, AppError> {
    match result {
        Ok(output) => Ok(output),
        Err(RunnerError::Timeout) => Err(AppError::new("timeout", "操作超时并已停止。")),
        Err(RunnerError::OutputLimit) => Err(AppError::new(
            "output_limit",
            "命令输出超过上限，已停止读取。",
        )),
        Err(RunnerError::Cancelled) => Err(AppError::new("cancelled", "操作已取消。")),
        Err(RunnerError::Spawn(message)) => Err(AppError::new(
            "git_spawn",
            format!(
                "无法启动 Git：{}",
                crate::redact::redact_error_text(&message)
            ),
        )),
        Err(RunnerError::Io(message)) => Err(AppError::new(
            "git_io",
            format!(
                "读取 Git 输出失败：{}",
                crate::redact::redact_error_text(&message)
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex as StdMutex;

    struct GateRunner {
        current: Arc<AtomicUsize>,
        max: Arc<AtomicUsize>,
        delay: Duration,
        started: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Option<Arc<tokio::sync::Notify>>,
    }

    impl ProcessRunner for GateRunner {
        async fn run(&self, _request: RunRequest) -> Result<ProcessOutput, RunnerError> {
            let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
            self.max.fetch_max(now, Ordering::SeqCst);
            if let Some(sender) = self
                .started
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                let _ = sender.send(());
            }
            if let Some(release) = &self.release {
                release.notified().await;
            } else {
                tokio::time::sleep(self.delay).await;
            }
            self.current.fetch_sub(1, Ordering::SeqCst);
            Ok(ProcessOutput {
                exit_code: 0,
                stdout: Vec::new(),
                stderr: Vec::new(),
                stdout_truncated: false,
            })
        }
    }

    fn gated(runner: GateRunner) -> Arc<GitScheduler<GateRunner>> {
        Arc::new(GitScheduler::new(
            runner,
            Arc::new(Shutdown::new()),
            Duration::from_secs(5),
            1024,
            Vec::new(),
        ))
    }

    fn job(repo: &str, kind: JobKind, id: u64, generation: u64) -> GitJob {
        GitJob {
            repo_key: repo.into(),
            kind,
            request_id: id,
            generation,
            program: PathBuf::from("git"),
            args: vec!["status".into()],
            stdin: None,
            truncate_stdout: false,
            output_limit: None,
        }
    }

    #[test]
    fn internal_request_ids_stay_outside_the_user_sequence() {
        let first = internal_request_id();
        let second = internal_request_id();
        assert!(first >= INTERNAL_REQUEST_BIT);
        assert!(second > first);
        for user in [1_u64, 2, 5, 41] {
            assert_ne!(first, user);
            assert_ne!(second, user);
            assert_ne!(first, user.wrapping_add(1));
            assert_ne!(second, user.wrapping_add(1));
        }
    }

    #[tokio::test]
    async fn reads_stop_at_two_concurrent_processes() {
        let current = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let scheduler = gated(GateRunner {
            current,
            max: max.clone(),
            delay: Duration::from_millis(80),
            started: StdMutex::new(None),
            release: None,
        });
        let mut tasks = Vec::new();
        for id in 1..=6 {
            let scheduler = scheduler.clone();
            tasks.push(tokio::spawn(async move {
                scheduler
                    .execute(job("repo", JobKind::Read, id, 1))
                    .await
                    .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(max.load(Ordering::SeqCst), MAX_CONCURRENT_READS);
    }

    #[tokio::test]
    async fn same_repo_writes_are_serial_and_other_repos_can_overlap() {
        let current = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let scheduler = gated(GateRunner {
            current,
            max: max.clone(),
            delay: Duration::from_millis(80),
            started: StdMutex::new(None),
            release: None,
        });
        let first = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move { scheduler.execute(job("same", JobKind::Write, 1, 1)).await })
        };
        let second = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move { scheduler.execute(job("same", JobKind::Write, 2, 1)).await })
        };
        let mut results = [first.await.unwrap(), second.await.unwrap()];
        results.sort_by_key(|result| result.is_err());
        assert!(results[0].is_ok());
        assert_eq!(results[1].as_ref().unwrap_err().code, "stale");
        assert_eq!(max.load(Ordering::SeqCst), 1);

        let current = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let scheduler = gated(GateRunner {
            current,
            max: max.clone(),
            delay: Duration::from_millis(80),
            started: StdMutex::new(None),
            release: None,
        });
        let left = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move {
                scheduler
                    .execute(job("a", JobKind::Write, 3, 1))
                    .await
                    .unwrap();
            })
        };
        let right = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move {
                scheduler
                    .execute(job("b", JobKind::Write, 4, 1))
                    .await
                    .unwrap();
            })
        };
        left.await.unwrap();
        right.await.unwrap();
        assert_eq!(max.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn generation_change_discards_the_read_and_duplicate_ids_do_not_reenter() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let scheduler = gated(GateRunner {
            current: Arc::new(AtomicUsize::new(0)),
            max: Arc::new(AtomicUsize::new(0)),
            delay: Duration::from_secs(5),
            started: StdMutex::new(Some(started_tx)),
            release: Some(release.clone()),
        });
        let running = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move { scheduler.execute(job("repo", JobKind::Read, 7, 1)).await })
        };
        started_rx.await.unwrap();
        let duplicate = scheduler
            .execute(job("repo", JobKind::Read, 7, 1))
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "duplicate");
        let current = scheduler.bump_generation("repo");
        assert_eq!(current, 2);
        release.notify_one();
        let stale = running.await.unwrap().unwrap_err();
        assert_eq!(stale.code, "stale");
        assert_eq!(stale.generation, Some(2));

        release.notify_one();
        scheduler
            .execute(job("repo", JobKind::Read, 7, 2))
            .await
            .unwrap();
    }

    struct RefuseRunner;

    impl ProcessRunner for RefuseRunner {
        async fn run(&self, _request: RunRequest) -> Result<ProcessOutput, RunnerError> {
            panic!("过期请求不应启动 Git");
        }
    }

    #[tokio::test]
    async fn stale_generation_does_not_start_work() {
        let scheduler = Arc::new(GitScheduler::new(
            RefuseRunner,
            Arc::new(Shutdown::new()),
            Duration::from_secs(2),
            1024,
            Vec::new(),
        ));
        assert_eq!(scheduler.bump_generation("repo"), 2);
        let error = scheduler
            .execute(job("repo", JobKind::Read, 1, 1))
            .await
            .unwrap_err();
        assert_eq!(error.code, "stale");
        assert_eq!(error.generation, Some(2));
    }

    struct CancelAwareRunner {
        started: Arc<AtomicUsize>,
    }

    impl ProcessRunner for CancelAwareRunner {
        async fn run(&self, request: RunRequest) -> Result<ProcessOutput, RunnerError> {
            self.started.fetch_add(1, Ordering::SeqCst);
            let Some(cancel) = request.cancel else {
                return Err(RunnerError::Io("read was not cancellable".into()));
            };
            cancel.cancelled().await;
            Err(RunnerError::Cancelled)
        }
    }

    async fn until_started(counter: &AtomicUsize, value: usize) {
        let began = std::time::Instant::now();
        while counter.load(Ordering::SeqCst) < value {
            if began.elapsed() > Duration::from_secs(2) {
                panic!("runner did not start");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn cancel_reads_stops_the_current_read_only() {
        let started = Arc::new(AtomicUsize::new(0));
        let scheduler = Arc::new(GitScheduler::new(
            CancelAwareRunner {
                started: Arc::clone(&started),
            },
            Arc::new(Shutdown::new()),
            Duration::from_secs(5),
            1024,
            Vec::new(),
        ));
        let running = Arc::clone(&scheduler);
        let first = tokio::spawn(async move { running.execute(job("repo", JobKind::Read, 1, 1)).await });
        until_started(&started, 1).await;
        scheduler.cancel_reads();
        assert_eq!(first.await.unwrap().unwrap_err().code, "cancelled");

        let running = Arc::clone(&scheduler);
        let second = tokio::spawn(async move { running.execute(job("repo", JobKind::Read, 2, 1)).await });
        until_started(&started, 2).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!second.is_finished());
        scheduler.cancel_reads();
        assert_eq!(second.await.unwrap().unwrap_err().code, "cancelled");
    }
}
