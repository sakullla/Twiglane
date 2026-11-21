use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use crate::error::AppError;
use crate::redact::redact_error_text;

pub const REMOTE_CHECK_FRESH_MS: u64 = 10 * 60 * 1000;

// 跨进程写锁由远端 agent v2 使用；桌面库以 cdylib 发布，只有远端消费者用到的入口
// 在这里仍算不可达，按既有约定显式放行（同 ops.rs 的远端入口）。
#[allow(dead_code)]
/// 跨进程写锁文件名。锁放在 Git 目录里，同一 common Git dir 的所有工作区共用一把锁。
pub const REPO_WRITE_LOCK: &str = "twiglane-agent-v2.lock";
/// 锁文件超过这个年龄即视为持有者已经消失：Git 命令自身 120 秒超时，正常写入远小于它。
#[allow(dead_code)]
pub const REPO_WRITE_LOCK_STALE_MS: u64 = 10 * 60 * 1000;
#[allow(dead_code)]
const LOCK_RETRY: Duration = Duration::from_millis(25);

/// 一个 Git 目录的跨进程写入权。
///
/// 进程内的 `ActionGate` 与 `GitScheduler` 只能串行本进程的写入；同一个远端仓库可能被
/// 两个 agent 进程（两个客户端、或重连后的新进程）同时打开，写入前必须再在文件系统上
/// 排他。锁文件用 `create_new` 创建，进程崩溃留下的锁按文件年龄回收。
#[allow(dead_code)]
pub struct RepoWriteLock {
    path: PathBuf,
    _file: File,
}

#[allow(dead_code)]
impl RepoWriteLock {
    /// 在 `git_dir` 下取得写入权；`wait` 内拿不到就返回 `write_locked`，不改动仓库。
    pub fn acquire(git_dir: &Path, wait: Duration) -> Result<Self, AppError> {
        let path = git_dir.join(REPO_WRITE_LOCK);
        let deadline = Instant::now() + wait;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let _ = writeln!(file, "{}\t{}", std::process::id(), now_ms());
                    let _ = file.sync_all();
                    return Ok(Self { path, _file: file });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if reclaim_stale(&path)? {
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(AppError::new(
                            "write_locked",
                            "另一个进程正在写入该仓库，请稍后重试。",
                        ));
                    }
                    std::thread::sleep(LOCK_RETRY);
                }
                Err(error) => {
                    return Err(AppError::new(
                        "write_lock_unavailable",
                        format!(
                            "无法在 Git 目录中创建写入锁，未写入仓库。{}",
                            redact_error_text(&error.to_string())
                        ),
                    ));
                }
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for RepoWriteLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// 锁文件的年龄超过上限即回收。返回 true 表示已经清掉，可以立刻重试创建。
#[allow(dead_code)]
fn reclaim_stale(path: &Path) -> Result<bool, AppError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        // 持有者刚好释放：直接重试创建。
        Err(_) => return Ok(true),
    };
    let age_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age.as_millis() as u64)
        .unwrap_or(0);
    if age_ms <= REPO_WRITE_LOCK_STALE_MS {
        return Ok(false);
    }
    let _ = fs::remove_file(path);
    Ok(true)
}

#[allow(dead_code)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
pub struct ActionGate {
    active: Mutex<HashSet<String>>,
}

pub struct ActionGuard<'a> {
    gate: &'a ActionGate,
    key: String,
}

impl ActionGate {
    pub fn enter(&self, key: impl Into<String>) -> Result<ActionGuard<'_>, AppError> {
        let key = key.into();
        let mut active = lock(&self.active);
        if !active.insert(key.clone()) {
            return Err(AppError::new("duplicate", "该操作正在执行，未重复启动。"));
        }
        drop(active);
        Ok(ActionGuard { gate: self, key })
    }
}

impl Drop for ActionGuard<'_> {
    fn drop(&mut self) {
        lock(&self.gate.active).remove(&self.key);
    }
}

#[derive(Default)]
pub struct RemoteChecks {
    times: Mutex<HashMap<String, u64>>,
}

impl RemoteChecks {
    pub fn note(&self, repo: &str, at: u64) {
        lock(&self.times).insert(repo.to_string(), at);
    }

    pub fn get(&self, repo: &str) -> Option<u64> {
        lock(&self.times).get(repo).copied()
    }
}

pub fn remote_check_is_stale(checked_at: u64, now: u64) -> bool {
    now.saturating_sub(checked_at) > REMOTE_CHECK_FRESH_MS
}

pub fn action_key(group: &str, repo: &str) -> String {
    format!("{group}\0{repo}")
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn repo_write_lock_excludes_a_second_owner_and_releases_on_drop() {
        let dir = crate::test_support::TempDir::new("repo-write-lock");
        let held = RepoWriteLock::acquire(dir.path(), Duration::from_millis(50)).unwrap();
        assert_eq!(held.path(), dir.path().join(REPO_WRITE_LOCK));
        let mut text = String::new();
        File::open(held.path())
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(
            text.split('\t').next().unwrap(),
            std::process::id().to_string()
        );
        let blocked = match RepoWriteLock::acquire(dir.path(), Duration::from_millis(50)) {
            Ok(_) => panic!("同一 Git 目录不应同时有两个写入者"),
            Err(error) => error,
        };
        assert_eq!(blocked.code, "write_locked");
        let path = held.path().to_path_buf();
        drop(held);
        assert!(!path.exists());
        RepoWriteLock::acquire(dir.path(), Duration::from_millis(50)).unwrap();
    }

    #[test]
    fn stale_lock_is_reclaimed_without_waiting_for_the_deadline() {
        let dir = crate::test_support::TempDir::new("repo-write-lock-stale");
        let path = dir.path().join(REPO_WRITE_LOCK);
        fs::write(&path, b"999999\t0\n").unwrap();
        // 把锁文件改老到超过上限，模拟持锁进程已经消失。
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_millis(REPO_WRITE_LOCK_STALE_MS + 1))
            .unwrap();
        let lock = RepoWriteLock::acquire(dir.path(), Duration::from_millis(50)).unwrap();
        assert_ne!(fs::read_to_string(lock.path()).unwrap(), "999999\t0\n");
    }

    #[test]
    fn fresh_window_expires_without_marking_the_same_instant_stale() {
        assert!(!remote_check_is_stale(1_000, 1_000 + REMOTE_CHECK_FRESH_MS));
        assert!(remote_check_is_stale(1_000, 1_001 + REMOTE_CHECK_FRESH_MS));
    }

    #[test]
    fn the_same_action_cannot_enter_twice() {
        let gate = ActionGate::default();
        let held = gate.enter("sync\0/repo").unwrap();
        let duplicate = match gate.enter("sync\0/repo") {
            Ok(_guard) => panic!("重复操作不应该进入"),
            Err(error) => error,
        };
        assert_eq!(duplicate.code, "duplicate");
        drop(held);
        gate.enter("sync\0/repo").unwrap();
    }
}