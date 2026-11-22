//! 远端变化事件：带仓库键与单调序号的失效通知。
//!
//! 这里只做「失效」：合并窗口内的一组文件系统变化合成一条事件，携带一个新的单调序号；
//! 客户端拿到后推进对应仓库的 generation，再按当前视图读取需要的数据。事件本身不描述
//! 差异，也不触发任何全量读取，因此重复、乱序、丢失都不会改变仓库状态。
//!
//! 三条边界：
//! - 事件帧不带请求 `id`，与请求/响应帧在同一条通道上多路复用。
//! - watch 不可用时如实降级：不启动任何轮询线程，只有客户端显式刷新（status）才读状态。
//! - 发送队列满时丢弃这一条通知但保留水位：客户端的 `events after=<seq>` 游标查询能重新
//!   对齐，这正是「合并无效通知」，而不是补发全部历史或持续轮询。

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde_json::{json, Map, Value};

use crate::protocol;
// 与桌面后端同一个去抖窗口：本地和远端对「一次写入」的失效延迟是同一份定义。
use crate::watch::{is_ignored, DebounceClock, WATCH_DEBOUNCE};

/// 连续不断的变化也必须上报：攒满这个时间就发出一条，不让通知被无穷的写入饿死。
const MAX_COALESCE_DELAY: Duration = Duration::from_millis(900);
/// 保留多少条最近事件，供 `events after=<seq>` 追赶；更旧的游标直接对齐到水位。
const MAX_RECENT: usize = 32;
/// 一条事件最多列出多少条路径：通知只说明「有变化」，不搬运清单。
const MAX_EVENT_PATHS: usize = 16;
/// 显式关闭 watch 的环境变量名：受限环境与回归测试用它验证降级路径。
pub const DISABLE_ENV: &str = "TWIGLANE_AGENT_DISABLE_WATCH";

#[derive(Clone, Debug)]
struct ChangeEvent {
    seq: u64,
    kind: String,
    paths: Vec<String>,
}

impl ChangeEvent {
    fn to_value(&self) -> Value {
        json!({
            "seq": self.seq,
            "kind": self.kind,
            "paths": self.paths,
        })
    }
}

#[derive(Default)]
struct Pending {
    worktree: bool,
    git: bool,
    paths: Vec<String>,
}

impl Pending {
    fn record(&mut self, in_git: bool, path: &str) {
        if in_git {
            self.git = true;
        } else {
            self.worktree = true;
        }
        if !path.is_empty()
            && self.paths.len() < MAX_EVENT_PATHS
            && !self.paths.iter().any(|known| known == path)
        {
            self.paths.push(path.to_string());
        }
    }

    fn take(&mut self) -> Option<ChangeEvent> {
        if !self.worktree && !self.git {
            return None;
        }
        let kind = match (self.worktree, self.git) {
            (true, true) => "mixed",
            (false, true) => "git",
            _ => "worktree",
        };
        let event = ChangeEvent {
            seq: 0,
            kind: kind.to_string(),
            paths: std::mem::take(&mut self.paths),
        };
        self.worktree = false;
        self.git = false;
        Some(event)
    }
}

/// 一个仓库的变化源。`degraded` 为真时远端无法 watch，此时不产生任何事件。
pub struct ChangeFeed {
    key: String,
    seq: AtomicU64,
    /// 线程真正起来之后才置为假：事件此时才会被推送。
    degraded: AtomicBool,
    recent: Mutex<VecDeque<ChangeEvent>>,
    stop: Mutex<Option<mpsc::Sender<()>>>,
}

impl ChangeFeed {
    /// 为仓库启动事件源。watch 不可用或被显式关闭时返回降级实例：打开仓库仍然成功，
    /// 只是如实告诉客户端「没有实时通知，只有显式刷新」。
    pub fn start(
        key: &str,
        root: &Path,
        git_dir: &Path,
        out: tokio::sync::mpsc::Sender<Vec<u8>>,
    ) -> Arc<Self> {
        let feed = Arc::new(Self {
            key: key.to_string(),
            seq: AtomicU64::new(0),
            degraded: AtomicBool::new(true),
            recent: Mutex::new(VecDeque::new()),
            stop: Mutex::new(None),
        });
        if std::env::var_os(DISABLE_ENV).is_some() {
            return feed;
        }
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(raw_tx) {
            Ok(watcher) => watcher,
            Err(_) => return feed,
        };
        // 工作树与 common Git dir 都要看：索引、HEAD 与 refs 的变化不在工作树里。
        if watcher.watch(root, RecursiveMode::Recursive).is_err()
            || watcher.watch(git_dir, RecursiveMode::Recursive).is_err()
        {
            return feed;
        }
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        *feed.stop.lock().unwrap_or_else(|error| error.into_inner()) = Some(stop_tx);
        let worker = Arc::clone(&feed);
        let git_dir = git_dir.to_path_buf();
        let root = root.to_path_buf();
        let spawned = std::thread::Builder::new()
            .name("twiglane-agent-events".to_string())
            .spawn(move || {
                // watcher 必须活在这条线程里：drop 它等于停止监听。
                let _watcher = watcher;
                let mut pending = Pending::default();
                // 与桌面后端同一份去抖时钟：每次事件推后窗口，窗口内只有一条通知。
                let mut clock = DebounceClock::new(WATCH_DEBOUNCE);
                let mut since: Option<std::time::Instant> = None;
                loop {
                    let wait = clock
                        .deadline()
                        .map(|deadline| deadline.saturating_duration_since(std::time::Instant::now()))
                        .unwrap_or(WATCH_DEBOUNCE);
                    match raw_rx.recv_timeout(wait) {
                        Ok(Ok(event)) if !is_ignored(&root, &event) => {
                            for path in &event.paths {
                                pending.record(path.starts_with(&git_dir), &display(path, &root));
                            }
                            if event.paths.is_empty() {
                                pending.record(false, "");
                            }
                            clock.touch(std::time::Instant::now());
                            since.get_or_insert_with(std::time::Instant::now);
                        }
                        Ok(Ok(_)) => {}
                        Ok(Err(_)) => clock.touch(std::time::Instant::now()),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                    // 安静窗口到期，或持续写入攒满上限：合并成一条通知发出去。
                    let quiet = clock.poll(std::time::Instant::now());
                    let overdue = since.is_some_and(|at| at.elapsed() >= MAX_COALESCE_DELAY);
                    if quiet || overdue {
                        if let Some(event) = pending.take() {
                            worker.publish(event, &out);
                        }
                        since = None;
                    }
                    if stop_rx.try_recv().is_ok() {
                        return;
                    }
                }
            });
        if spawned.is_err() {
            return feed;
        }
        feed.degraded.store(false, Ordering::SeqCst);
        feed
    }

    fn publish(&self, mut event: ChangeEvent, out: &tokio::sync::mpsc::Sender<Vec<u8>>) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        event.seq = seq;
        {
            let mut recent = self.recent.lock().unwrap_or_else(|error| error.into_inner());
            recent.push_back(event.clone());
            while recent.len() > MAX_RECENT {
                recent.pop_front();
            }
        }
        let mut body = Map::new();
        body.insert("repo".into(), Value::String(self.key.clone()));
        body.insert("seq".into(), json!(seq));
        body.insert("kind".into(), Value::String(event.kind));
        body.insert("paths".into(), json!(event.paths));
        // 队列满就丢掉这一条：它是纯失效通知，客户端游标查询会重新对齐。
        let _ = out.try_send(protocol::event_frame("change", body));
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn degraded(&self) -> bool {
        self.degraded.load(Ordering::SeqCst)
    }
}

impl Drop for ChangeFeed {
    fn drop(&mut self) {
        let stop = self
            .stop
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
    }
}

/// 游标查询结果：水位 + 需要整体刷新时的标记 + `after` 之后的失效事件。
pub struct CursorReply {
    pub seq: u64,
    pub degraded: bool,
    pub resync: bool,
    pub events: Vec<Value>,
}

/// `after` 之后的事件。比最老事件还旧的游标只回 `resync`，不补发历史：
/// 失效通知不是变更日志，多刷一次比逐条重放更安全。
///
/// `after` 是客户端给的整数，可能取到 `u64::MAX`：所有算术都用 `saturating_add`，
/// 游标越界只是「没有可补发的事件」，绝不能在这里溢出。游标跑到水位之前（例如
/// agent 重启后客户端还留着旧的一代序号）同样按无效游标处理，回 `resync`。
pub fn cursor(feed: &ChangeFeed, after: u64) -> CursorReply {
    let seq = feed.seq.load(Ordering::SeqCst);
    let recent = feed.recent.lock().unwrap_or_else(|error| error.into_inner());
    let oldest = recent
        .front()
        .map(|event| event.seq)
        .unwrap_or_else(|| seq.saturating_add(1));
    let resync = after.saturating_add(1) < oldest || after > seq;
    CursorReply {
        seq,
        degraded: feed.degraded(),
        resync,
        events: if resync {
            Vec::new()
        } else {
            recent
                .iter()
                .filter(|event| event.seq > after)
                .map(ChangeEvent::to_value)
                .collect()
        },
    }
}

/// 事件里只放仓库相对路径：远端绝对路径会泄露主机布局，也不是客户端需要的信息。
fn display(path: &Path, root: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(relative) => relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/"),
        Err(_) => String::new(),
    }
}
