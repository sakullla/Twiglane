//! 有界行位置索引，只保存行号和字节位置，不保留正文或文件句柄。
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_FILES: usize = 16;
const MAX_POINTS: usize = 64;

#[derive(Default)]
pub(crate) struct TextCursorCache(Mutex<VecDeque<Entry>>);

struct Entry {
    path: PathBuf,
    version: String,
    points: VecDeque<(u64, u64)>,
}

impl TextCursorCache {
    pub fn nearest(&self, path: &Path, version: &str, line: u64) -> (u64, u64) {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|entry| entry.path != path || entry.version == version);
        let Some(index) = entries.iter().position(|entry| entry.path == path) else {
            return (0, 0);
        };
        let entry = entries.remove(index).expect("cursor entry");
        let point = entry
            .points
            .iter()
            .filter(|(row, _)| *row <= line)
            .max_by_key(|(row, _)| *row)
            .copied()
            .unwrap_or((0, 0));
        entries.push_back(entry);
        point
    }

    pub fn remember(&self, path: PathBuf, version: String, points: [(u64, u64); 2]) {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let mut entry = entries
            .iter()
            .position(|entry| entry.path == path)
            .and_then(|index| entries.remove(index))
            .filter(|entry| entry.version == version)
            .unwrap_or_else(|| Entry {
                path,
                version,
                points: VecDeque::new(),
            });
        for point in points {
            entry.points.retain(|(line, _)| *line != point.0);
            entry.points.push_back(point);
            while entry.points.len() > MAX_POINTS {
                entry.points.pop_front();
            }
        }
        entries.push_back(entry);
        while entries.len() > MAX_FILES {
            entries.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_are_versioned_and_bounded_without_retaining_contents() {
        let cache = TextCursorCache::default();
        let path = Path::new("large.txt");
        for line in 0..1000 {
            cache.remember(
                path.into(),
                "v1".into(),
                [(line, line * 20), (line + 1, (line + 1) * 20)],
            );
        }
        assert_eq!(cache.nearest(path, "v1", 999), (999, 19980));
        assert_eq!(cache.nearest(path, "v1", 2), (0, 0));
        assert_eq!(cache.0.lock().unwrap()[0].points.len(), MAX_POINTS);
        assert_eq!(cache.nearest(path, "v2", 999), (0, 0));
        for file in 0..100 {
            cache.remember(
                PathBuf::from(format!("{file}.txt")),
                "v1".into(),
                [(0, 0), (1, 10)],
            );
        }
        assert_eq!(cache.0.lock().unwrap().len(), MAX_FILES);
        assert_eq!(cache.nearest(Path::new("0.txt"), "v1", 1), (0, 0));
    }
}
