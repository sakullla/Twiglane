//! 仅供固定提交间的只读差异复用；工作区与暂存操作始终重新读取 Git。
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::patch::{ParsedDiff, ParsedHunk};
use crate::model::DiffLine;

const MAX_ENTRIES: usize = 8;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(PartialEq, Eq)]
pub(crate) struct DiffCacheKey {
    pub root: PathBuf,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub generation: u64,
    pub output_limit: usize,
    pub as_text: bool,
}

pub(crate) struct CachedDiff {
    pub raw: Vec<u8>,
    pub parsed: ParsedDiff,
}

impl CachedDiff {
    fn bytes(&self) -> usize {
        self.raw.capacity()
            + self.parsed.preamble.capacity()
            + self.parsed.hunks.capacity() * std::mem::size_of::<ParsedHunk>()
            + self
                .parsed
                .hunks
                .iter()
                .map(|hunk| {
                    hunk.raw.capacity()
                        + hunk.header.capacity()
                        + hunk.lines.capacity() * std::mem::size_of::<DiffLine>()
                        + hunk
                            .lines
                            .iter()
                            .map(|line| line.text.capacity() + line.kind.capacity())
                            .sum::<usize>()
                })
                .sum::<usize>()
    }
}

#[derive(Default)]
pub(crate) struct DiffCache(Mutex<VecDeque<(DiffCacheKey, Arc<CachedDiff>, usize)>>);

impl DiffCache {
    pub fn get(&self, key: &DiffCacheKey) -> Option<Arc<CachedDiff>> {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|(old, _, _)| old.root != key.root || old.generation == key.generation);
        let index = entries.iter().position(|(old, _, _)| old == key)?;
        let entry = entries.remove(index)?;
        let value = Arc::clone(&entry.1);
        entries.push_back(entry);
        Some(value)
    }

    pub fn insert(&self, key: DiffCacheKey, value: Arc<CachedDiff>) {
        let bytes = value.bytes()
            + std::mem::size_of::<DiffCacheKey>()
            + key
                .args
                .iter()
                .map(|arg| arg.as_encoded_bytes().len() + std::mem::size_of::<OsString>())
                .sum::<usize>()
            + key.root.as_os_str().len()
            + key.program.as_os_str().len();
        if bytes > MAX_BYTES {
            return;
        }
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|(old, _, _)| {
            old != &key && (old.root != key.root || old.generation == key.generation)
        });
        while entries.len() >= MAX_ENTRIES
            || entries.iter().map(|(_, _, bytes)| bytes).sum::<usize>() + bytes > MAX_BYTES
        {
            entries.pop_front();
        }
        entries.push_back((key, value, bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str, generation: u64) -> DiffCacheKey {
        DiffCacheKey {
            root: "repo".into(),
            program: "git".into(),
            args: vec![name.into()],
            generation,
            output_limit: 1024,
            as_text: false,
        }
    }

    #[test]
    fn cache_is_lru_versioned_and_does_not_retain_oversized_parsed_data() {
        let cache = DiffCache::default();
        let value = Arc::new(CachedDiff {
            raw: Vec::new(),
            parsed: super::super::patch::parse_diff(b"", false).unwrap(),
        });
        cache.insert(key("keep", 1), Arc::clone(&value));
        for i in 0..7 {
            cache.insert(key(&i.to_string(), 1), Arc::clone(&value));
        }
        assert!(Arc::ptr_eq(&cache.get(&key("keep", 1)).unwrap(), &value));
        cache.insert(key("new", 1), Arc::clone(&value));
        assert!(cache.get(&key("0", 1)).is_none());
        assert!(cache.get(&key("keep", 1)).is_some());
        let mut other_repo = key("keep", 1);
        other_repo.root = "other".into();
        assert!(cache.get(&other_repo).is_none());
        assert!(cache.get(&key("keep", 2)).is_none());
        assert!(cache.0.lock().unwrap().is_empty());
        let huge = Arc::new(CachedDiff {
            raw: vec![0; MAX_BYTES + 1],
            parsed: value.parsed.clone(),
        });
        cache.insert(key("huge", 2), Arc::clone(&huge));
        assert!(cache.get(&key("huge", 2)).is_none());
        assert_eq!(Arc::strong_count(&huge), 1);
    }
}
