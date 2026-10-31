use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
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
        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let message = if result.is_ok() {
                    WatchMsg::Event
                } else {
                    WatchMsg::Error
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
