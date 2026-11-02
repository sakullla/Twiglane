use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::{self, error::TrySendError};

use crate::error::AppError;

pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchMsg {
    Event,
    Error,
}

#[derive(Debug)]
pub struct DebounceClock {
    delay: Duration,
    last_touch: Option<Instant>,
    dirty: bool,
}

impl DebounceClock {
    pub fn new(delay: Duration) -> Self {
        Self {
            delay,
            last_touch: None,
            dirty: false,
        }
    }

    pub fn touch(&mut self, now: Instant) {
        self.dirty = true;
        self.last_touch = Some(now);
    }

    pub fn deadline(&self) -> Option<Instant> {
        if self.dirty {
            self.last_touch.map(|touched| touched + self.delay)
        } else {
            None
        }
    }

    pub fn poll(&mut self, now: Instant) -> bool {
        let Some(deadline) = self.deadline() else {
            return false;
        };
        if now >= deadline {
            self.dirty = false;
            true
        } else {
            false
        }
    }
}

/// Linux 的 notify 订阅了 IN_OPEN：Git 每次只读打开 HEAD、index、目录都会产生 Access 事件，
/// 把它算作变化时，刷新自身就会触发下一轮刷新。只有写后关闭才可能代表内容变了。
fn is_read_access(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Access(access) if *access != AccessKind::Close(AccessMode::Write))
}

/// 事件的全部路径都落在 Git 内部噪声上。没有路径的事件（如队列溢出后的重扫）不算噪声；
/// 改名事件同时带新旧路径，`index.lock` 改名成 `index` 因此仍会触发刷新。
fn is_internal_noise(root: &Path, paths: &[PathBuf]) -> bool {
    !paths.is_empty() && paths.iter().all(|path| is_noise_path(root, path))
}

/// 实测的只读路径里，只有 `.git/objects` 会被反复写：`merge-tree --write-tree` 首次写对象，
/// 之后每次用 utime 刷新已有对象的时间。工作区里的同名路径和 `*.lock` 都不算。
fn is_noise_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut parts = relative.components().map(Component::as_os_str);
    if parts.next() != Some(OsStr::new(".git")) {
        return false;
    }
    match parts.next() {
        // `.git` 目录自身的时间戳变化不说明内容；真正的变化有各自文件的事件。
        None => true,
        Some(name) if name == "objects" || name == "lfs" || name == "FETCH_HEAD" => true,
        Some(_) => path.extension() == Some(OsStr::new("lock")),
    }
}

/// 带重扫标记的事件说明有事件丢失（macOS 上还带路径），不能按路径或类型判断，必须放行。
fn is_ignored(root: &Path, event: &Event) -> bool {
    !event.need_rescan() && (is_read_access(&event.kind) || is_internal_noise(root, &event.paths))
}

struct Session {
    watcher: RecommendedWatcher,
    abort: tokio::task::AbortHandle,
}

pub struct WatchHub {
    session: Mutex<Option<Session>>,
}

impl WatchHub {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    pub fn stop(&self) {
        if let Some(session) = self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            session.abort.abort();
            drop(session.watcher);
        }
    }

    pub fn watch(
        &self,
        path: PathBuf,
        on_quiet: Arc<dyn Fn() + Send + Sync>,
        on_degraded: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), AppError> {
        self.stop();
        if !path.is_dir() {
            return Err(AppError::new("watch_path", "无法监听该目录。"));
        }
        let (tx, mut rx) = mpsc::channel(32);
        let tx_events = tx.clone();
        let root = path.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let message = match &result {
                    Ok(event) if is_ignored(&root, event) => return,
                    Ok(_) => WatchMsg::Event,
                    Err(_) => WatchMsg::Error,
                };
                match tx_events.try_send(message) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        let _ = tx_events.try_send(WatchMsg::Error);
                    }
                    Err(TrySendError::Closed(_)) => {}
                }
            })
            .map_err(|_| AppError::new("watch_unavailable", "文件监听不可用。"))?;
        watcher
            .watch(&path, RecursiveMode::Recursive)
            .map_err(|_| AppError::new("watch_unavailable", "文件监听不可用。"))?;
        let announced = Arc::new(AtomicBool::new(false));
        let degraded = on_degraded;
        let quiet = on_quiet;
        let handle = tokio::spawn(async move {
            let mut clock = DebounceClock::new(WATCH_DEBOUNCE);
            loop {
                if let Some(deadline) = clock.deadline() {
                    let wait = deadline.saturating_duration_since(Instant::now());
                    tokio::select! {
                        message = rx.recv() => {
                            if !handle_message(message, &mut clock, &announced, &degraded) {
                                break;
                            }
                        }
                        _ = tokio::time::sleep(wait) => {
                            if clock.poll(Instant::now()) {
                                quiet();
                            }
                        }
                    }
                } else {
                    let message = rx.recv().await;
                    if !handle_message(message, &mut clock, &announced, &degraded) {
                        break;
                    }
                }
            }
        });
        let abort = handle.abort_handle();
        *self
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Session { watcher, abort });
        Ok(())
    }
}

impl Default for WatchHub {
    fn default() -> Self {
        Self::new()
    }
}

fn handle_message(
    message: Option<WatchMsg>,
    clock: &mut DebounceClock,
    announced: &AtomicBool,
    degraded: &Arc<dyn Fn() + Send + Sync>,
) -> bool {
    match message {
        Some(WatchMsg::Event) => {
            clock.touch(Instant::now());
            true
        }
        Some(WatchMsg::Error) => {
            if !announced.swap(true, Ordering::SeqCst) {
                degraded();
            }
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debounce_waits_for_a_quiet_period() {
        let start = Instant::now();
        let mut clock = DebounceClock::new(WATCH_DEBOUNCE);
        clock.touch(start);
        clock.touch(start + Duration::from_millis(200));
        assert!(!clock.poll(start + Duration::from_millis(499)));
        assert!(clock.poll(start + WATCH_DEBOUNCE + Duration::from_millis(200)));
        assert!(!clock.poll(start + Duration::from_secs(2)));
    }

    fn noise(paths: &[&str]) -> bool {
        let root = Path::new("/repo");
        let paths: Vec<PathBuf> = paths.iter().map(|path| root.join(path)).collect();
        is_internal_noise(root, &paths)
    }

    #[test]
    fn git_internal_writes_are_noise() {
        for path in [
            ".git",
            ".git/objects",
            ".git/objects/ab",
            ".git/objects/ab/cdef",
            ".git/objects/tmp_obj_abc",
            ".git/objects/pack/pack-1.idx",
            ".git/objects/info/commit-graph",
            ".git/lfs/tmp/upload",
            ".git/index.lock",
            ".git/HEAD.lock",
            ".git/packed-refs.lock",
            ".git/gc.pid.lock",
            ".git/refs/heads/main.lock",
            ".git/logs/HEAD.lock",
            ".git/FETCH_HEAD",
        ] {
            assert!(noise(&[path]), "{path}");
        }
        assert!(noise(&[".git/objects/ab/x", ".git/index.lock"]));
    }

    #[test]
    fn repository_state_changes_are_not_noise() {
        for path in [
            ".git/HEAD",
            ".git/index",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/main",
            ".git/packed-refs",
            ".git/MERGE_HEAD",
            ".git/config",
            "src/main.rs",
            "Cargo.lock",
            "objects/data.bin",
            "lfs/file.bin",
            "vendor/.git/objects/ab/cdef",
            ".gitignore",
            ".github/index.lock",
        ] {
            assert!(!noise(&[path]), "{path}");
        }
    }

    #[test]
    fn rename_into_place_and_mixed_batches_still_refresh() {
        assert!(!noise(&[".git/index.lock", ".git/index"]));
        assert!(!noise(&[
            ".git/refs/heads/main.lock",
            ".git/refs/heads/main"
        ]));
        assert!(!noise(&[".git/objects/ab/cdef", "src/main.rs"]));
    }

    #[test]
    fn events_without_paths_or_outside_the_root_are_not_noise() {
        let root = Path::new("/repo");
        assert!(!is_internal_noise(root, &[]));
        assert!(!is_internal_noise(
            root,
            &[PathBuf::from("/other/.git/objects/ab")]
        ));
        assert!(!is_internal_noise(root, &[root.to_path_buf()]));
    }

    #[test]
    fn read_access_is_ignored_but_writes_are_not() {
        use notify::event::{CreateKind, DataChange, MetadataKind, ModifyKind};

        let root = Path::new("/repo");
        let event = |kind: EventKind, path: &str| Event::new(kind).add_path(root.join(path));
        for read in [
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            EventKind::Access(AccessKind::Read),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
        ] {
            assert!(is_ignored(root, &event(read, ".git/HEAD")));
            assert!(is_ignored(root, &event(read, "src/main.rs")));
            assert!(is_ignored(root, &event(read, "")));
        }
        for write in [
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
        ] {
            assert!(!is_ignored(root, &event(write, ".git/HEAD")));
            assert!(!is_ignored(root, &event(write, "src/main.rs")));
            assert!(is_ignored(root, &event(write, ".git/objects/ab/cdef")));
        }
    }

    #[test]
    fn rescan_events_always_refresh() {
        use notify::event::{Flag, ModifyKind};

        let root = Path::new("/repo");
        let rescan = |kind: EventKind, path: &str| {
            Event::new(kind)
                .set_flag(Flag::Rescan)
                .add_path(root.join(path))
        };
        assert!(!is_ignored(
            root,
            &rescan(EventKind::Modify(ModifyKind::Any), ".git/objects/ab/cdef")
        ));
        assert!(!is_ignored(
            root,
            &rescan(EventKind::Other, ".git/index.lock")
        ));
        assert!(!is_ignored(
            root,
            &rescan(EventKind::Access(AccessKind::Read), "src/main.rs")
        ));
        assert!(!is_ignored(
            root,
            &Event::new(EventKind::Other).set_flag(Flag::Rescan)
        ));
    }

    #[tokio::test]
    async fn watcher_stays_quiet_for_object_writes_and_reports_ref_changes() {
        let dir = crate::test_support::TempDir::new("watch-noise");
        let objects = dir.path().join(".git/objects/ab");
        std::fs::create_dir_all(&objects).unwrap();
        std::fs::create_dir_all(dir.path().join(".git/refs/heads")).unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hits_callback = hits.clone();
        let hub = WatchHub::new();
        hub.watch(
            dir.path().to_path_buf(),
            Arc::new(move || {
                hits_callback.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(|| {}),
        )
        .unwrap();
        // 个别平台会补发监听开始前的事件，等它们落定后再取基线。
        tokio::time::sleep(Duration::from_millis(700)).await;
        let baseline = hits.load(Ordering::SeqCst);
        std::fs::write(objects.join("cdef"), b"object").unwrap();
        std::fs::write(dir.path().join(".git/index.lock"), b"lock").unwrap();
        std::fs::remove_file(dir.path().join(".git/index.lock")).unwrap();
        let _ = std::fs::read(objects.join("cdef")).unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            baseline,
            "内部写入不应推进刷新"
        );

        std::fs::write(dir.path().join(".git/refs/heads/main"), b"oid").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while hits.load(Ordering::SeqCst) == baseline && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            hits.load(Ordering::SeqCst) > baseline,
            "引用变化必须触发刷新"
        );
        hub.stop();
    }

    #[tokio::test]
    async fn watcher_coalesces_events_and_stops() {
        let dir = crate::test_support::TempDir::new("watch");
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hits_callback = hits.clone();
        let hub = WatchHub::new();
        hub.watch(
            dir.path().to_path_buf(),
            Arc::new(move || {
                hits_callback.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(|| {}),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        std::fs::write(dir.path().join("a.txt"), b"1").unwrap();
        std::fs::write(dir.path().join("b.txt"), b"2").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while hits.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let after_burst = hits.load(Ordering::SeqCst);
        assert!(after_burst >= 1, "监听没有在去抖后报告外部写入");
        tokio::time::sleep(Duration::from_millis(400)).await;
        let settled = hits.load(Ordering::SeqCst);
        assert!(settled <= 2, "同一批写入触发了过多刷新: {settled}");
        hub.stop();
        let stopped_at = hits.load(Ordering::SeqCst);
        std::fs::write(dir.path().join("c.txt"), b"3").unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(hits.load(Ordering::SeqCst), stopped_at);
    }
}
