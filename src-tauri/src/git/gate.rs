use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::error::AppError;

pub const REMOTE_CHECK_FRESH_MS: u64 = 10 * 60 * 1000;

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
