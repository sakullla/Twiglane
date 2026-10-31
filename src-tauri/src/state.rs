use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::atomic::atomic_write;
use crate::error::AppError;
use crate::model::{
    PanelWidths, RecentRepo, Theme, MAX_DRAFT_CHARS, MAX_RECENT,
};
use crate::redact::reject_secret_draft;

const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    pub version: u32,
    pub theme: Theme,
    pub panel_widths: PanelWidths,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_executable: Option<String>,
    pub recent: Vec<RecentRepo>,
    pub drafts: BTreeMap<String, String>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            theme: Theme::Light,
            panel_widths: PanelWidths::default(),
            git_executable: None,
            recent: Vec::new(),
            drafts: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
struct StoreInner {
    data: Persisted,
    corrupt: bool,
}

pub struct AppStore {
    path: PathBuf,
    inner: Mutex<StoreInner>,
}

impl AppStore {
    pub fn open(path: PathBuf) -> Self {
        let (data, corrupt) = load_from_disk(&path);
        Self {
            path,
            inner: Mutex::new(StoreInner { data, corrupt }),
        }
    }

    // cdylib 不会把仅测试调用算作可达，避免 dead_code 挡住 clippy。
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn settings_warning(&self) -> Option<String> {
        let guard = self.lock();
        guard.corrupt.then(|| {
            "设置文件无法读取，本次使用默认设置，未覆盖原文件。".to_string()
        })
    }

    pub fn snapshot(&self) -> Persisted {
        self.lock().data.clone()
    }

    pub fn set_theme(&self, theme: Theme) -> Result<(), AppError> {
        self.update(|data| {
            data.theme = theme;
            Ok(())
        })
    }

    pub fn set_panel_widths(&self, widths: PanelWidths) -> Result<(), AppError> {
        let widths = widths.clamped();
        self.update(|data| {
            data.panel_widths = widths;
            Ok(())
        })
    }

    pub fn set_git_executable(&self, path: Option<String>) -> Result<(), AppError> {
        self.update(|data| {
            data.git_executable = path;
            Ok(())
        })
    }

    pub fn touch_recent(&self, name: String, path: String) -> Result<(), AppError> {
        let now = now_ms();
        self.update(|data| {
            data.recent.retain(|repo| repo.path != path);
            data.recent.insert(
                0,
                RecentRepo {
                    name,
                    path: path.clone(),
                    opened_at_ms: now,
                },
            );
            if data.recent.len() > MAX_RECENT {
                let removed: Vec<String> = data
                    .recent
                    .split_off(MAX_RECENT)
                    .into_iter()
                    .map(|repo| repo.path)
                    .collect();
                for path in removed {
                    data.drafts.remove(&path);
                }
            }
            Ok(())
        })
    }

    pub fn forget_recent(&self, path: &str) -> Result<Vec<RecentRepo>, AppError> {
        self.update(|data| {
            data.recent.retain(|repo| repo.path != path);
            data.drafts.remove(path);
            Ok(())
        })?;
        Ok(self.snapshot().recent)
    }

    pub fn draft(&self, path: &str) -> String {
        self.lock()
            .data
            .drafts
            .get(path)
            .cloned()
            .unwrap_or_default()
    }

    pub fn save_draft(&self, path: &str, message: &str) -> Result<(), AppError> {
        if message.chars().count() > MAX_DRAFT_CHARS {
            return Err(AppError::new(
                "draft_too_large",
                "提交说明过长，未保存。",
            ));
        }
        reject_secret_draft(message)?;
        let path = path.to_string();
        let message = message.to_string();
        self.update(|data| {
            if message.is_empty() {
                data.drafts.remove(&path);
            } else {
                data.drafts.insert(path, message);
            }
            Ok(())
        })
    }

    fn update(&self, change: impl FnOnce(&mut Persisted) -> Result<(), AppError>) -> Result<(), AppError> {
        let mut guard = self.lock();
        if guard.corrupt {
            return Err(AppError::new(
                "settings_corrupt",
                "设置文件已损坏，未覆盖原文件。本次修改不会写入磁盘。",
            ));
        }
        let mut next = guard.data.clone();
        change(&mut next)?;
        let bytes = serde_json::to_vec_pretty(&next).map_err(|error| {
            AppError::new("settings_encode", format!("无法编码设置：{error}"))
        })?;
        atomic_write(&self.path, &bytes).map_err(|error| {
            AppError::new("settings_write", format!("无法保存设置：{error}"))
        })?;
        guard.data = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StoreInner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn load_from_disk(path: &Path) -> (Persisted, bool) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Persisted::default(), false);
        }
        Err(_) => return (Persisted::default(), true),
    };
    match serde_json::from_slice::<Persisted>(&bytes) {
        Ok(data) if data.version == STATE_VERSION => (data, false),
        _ => (Persisted::default(), true),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn store_in(dir: &Path) -> AppStore {
        AppStore::open(dir.join("state.json"))
    }

    #[test]
    fn recent_keeps_same_name_different_paths_and_survives_reload() {
        let dir = crate::test_support::TempDir::new("state-recent");
        let store = store_in(dir.path());
        store
            .touch_recent("demo".into(), "/work/a/demo".into())
            .unwrap();
        store
            .touch_recent("demo".into(), "/work/b/demo".into())
            .unwrap();
        let again = store_in(dir.path());
        let recent = again.snapshot().recent;
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].path, "/work/b/demo");
        assert_eq!(recent[1].path, "/work/a/demo");
        assert!(recent.iter().all(|repo| repo.name == "demo"));
    }

    #[test]
    fn drafts_are_per_repo_and_do_not_store_secrets() {
        let dir = crate::test_support::TempDir::new("state-draft");
        let store = store_in(dir.path());
        store.save_draft("/work/a", "修正空状态文案").unwrap();
        store.save_draft("/work/b", "另一份说明").unwrap();
        let secret = "token=ghp_abcdefghijklmnopqrstuvwxyz1234";
        let error = store.save_draft("/work/a", secret).unwrap_err();
        assert_eq!(error.code, "draft_secret");
        let raw = fs::read_to_string(store.path()).unwrap();
        assert!(!raw.contains("ghp_"));
        assert_eq!(store.draft("/work/a"), "修正空状态文案");
        assert_eq!(store.draft("/work/b"), "另一份说明");
        store.forget_recent("/work/a").unwrap();
        assert_eq!(store.draft("/work/a"), "");
    }

    #[test]
    fn persisted_schema_has_no_secret_fields() {
        let dir = crate::test_support::TempDir::new("state-schema");
        let store = store_in(dir.path());
        store.set_theme(Theme::Dark).unwrap();
        store
            .set_panel_widths(PanelWidths {
                sidebar: 10,
                files: 9_999,
            })
            .unwrap();
        let snapshot = store.snapshot();
        assert_eq!(snapshot.panel_widths.sidebar, 160);
        assert_eq!(snapshot.panel_widths.files, 560);
        let value: Value = serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        let keys = object_keys(&value);
        for key in keys {
            let lower = key.to_ascii_lowercase();
            assert!(
                !lower.contains("password")
                    && !lower.contains("token")
                    && !lower.contains("secret")
                    && !lower.contains("credential")
                    && !lower.contains("private"),
                "{key}"
            );
        }
    }

    #[test]
    fn corrupt_file_is_not_overwritten_and_temp_is_ignored() {
        let dir = crate::test_support::TempDir::new("state-corrupt");
        let path = dir.path().join("state.json");
        fs::write(&path, b"{not-json").unwrap();
        let original = fs::read(&path).unwrap();
        fs::write(dir.path().join(".state.json.9.1.tmp"), b"{\"version\":1}").unwrap();
        let store = AppStore::open(path.clone());
        assert!(store.settings_warning().is_some());
        let error = store.set_theme(Theme::Dark).unwrap_err();
        assert_eq!(error.code, "settings_corrupt");
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(store.snapshot().theme, Theme::Light);
    }

    #[test]
    fn recent_cap_drops_oldest_draft() {
        let dir = crate::test_support::TempDir::new("state-cap");
        let store = store_in(dir.path());
        for index in 0..=MAX_RECENT {
            let path = format!("/repo/{index}");
            store
                .touch_recent(format!("repo-{index}"), path.clone())
                .unwrap();
            store.save_draft(&path, "说明").unwrap();
        }
        let snapshot = store.snapshot();
        assert_eq!(snapshot.recent.len(), MAX_RECENT);
        assert!(!snapshot.drafts.contains_key("/repo/0"));
        assert_eq!(snapshot.drafts.get("/repo/1").map(String::as_str), Some("说明"));
    }

    fn object_keys(value: &Value) -> Vec<String> {
        let mut keys = Vec::new();
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    keys.push(key.clone());
                    keys.extend(object_keys(child));
                }
            }
            Value::Array(items) => {
                for item in items {
                    keys.extend(object_keys(item));
                }
            }
            _ => {}
        }
        keys
    }
}
