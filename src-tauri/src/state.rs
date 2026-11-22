use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::atomic::atomic_write;
use crate::error::AppError;
use crate::model::{PanelWidths, RecentRepo, Theme, MAX_DRAFT_CHARS, MAX_RECENT};
use crate::redact::reject_secret_draft;

const STATE_VERSION: u32 = 2;

/// 主机簿上限：设置界面不适合无限增长，也限制一次同步的作用范围。
pub const MAX_SSH_TARGETS: usize = 64;

/// 分叉拉取预选的方式。旧设置文件没有这一项时读成合并。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PullIntegration {
    #[default]
    Merge,
    Rebase,
}

fn default_branch_groups() -> bool {
    true
}

/// 「创建 MR / PR」开关的缺省值。新安装、旧设置文件缺字段都读成关闭。
fn default_change_requests() -> bool {
    false
}

fn default_ssh_port() -> u16 {
    22
}

fn default_auth_method() -> String {
    "key".to_string()
}

/// 终端字号的允许范围与缺省值；前端缩放与设置都夹在这个范围里。
pub const TERMINAL_FONT_MIN: u8 = 9;
pub const TERMINAL_FONT_MAX: u8 = 24;
pub const TERMINAL_FONT_DEFAULT: u8 = 13;

fn default_terminal_font() -> u8 {
    TERMINAL_FONT_DEFAULT
}

/// 终端偏好。`profile` 只存终端类型 id，启动时由后端在本机探测结果里重新解析；
/// 旧设置文件没有这一项时读成平台默认与缺省字号。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default = "default_terminal_font")]
    pub font_size: u8,
}

impl Default for TerminalPrefs {
    fn default() -> Self {
        Self {
            profile: None,
            font_size: TERMINAL_FONT_DEFAULT,
        }
    }
}

impl TerminalPrefs {
    pub fn clamped(self) -> Self {
        Self {
            profile: self
                .profile
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty() && id.len() <= 64),
            font_size: self.font_size.clamp(TERMINAL_FONT_MIN, TERMINAL_FONT_MAX),
        }
    }
}

/// Twiglane 自己的 SSH 主机记录（R3）。只保存非秘密配置：
/// 密码在 `twiglane.remote-ssh` 系统钥匙串，`state.json` 里不出现秘密字段。
/// `revision` 是单调配置修订，只有连接身份字段变化才推进；仅改显示名不推进。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub id: String,
    pub display_name: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_host_id: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

impl SshTarget {
    /// 连接身份：这些字段决定连到哪台主机、用哪种认证。显示名与默认目录不在这里。
    fn identity(&self) -> (&str, u16, &str, &str, &Option<String>, &Option<String>, bool) {
        (
            &self.host,
            self.port,
            &self.user,
            &self.auth_method,
            &self.identity_file,
            &self.ssh_config,
            self.enabled,
        )
    }
}

/// 远程 SSH 总开关与主机簿。缺省关闭：没有字段的旧设置文件读成关闭，
/// 关闭时任何连接路径都不得新建 SSH 连接。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSsh {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub targets: Vec<SshTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    pub version: u32,
    pub theme: Theme,
    #[serde(default)]
    pub pull_integration: PullIntegration,
    #[serde(default = "default_branch_groups")]
    pub branch_groups: bool,
    /// 左栏是否显示「文件」视图；旧设置文件缺省为显示。
    #[serde(default = "default_branch_groups")]
    pub files_view: bool,
    /// 「创建 MR / PR」功能开关；默认关闭，旧设置文件缺字段也是关闭。
    #[serde(default = "default_change_requests")]
    pub change_requests_enabled: bool,
    #[serde(default)]
    pub terminal: TerminalPrefs,
    pub panel_widths: PanelWidths,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_executable: Option<String>,
    pub recent: Vec<RecentRepo>,
    pub drafts: BTreeMap<String, String>,
    #[serde(default)]
    pub workspaces: Vec<crate::workspaces::Project>,
    /// 远程 SSH 设置：只存非秘密配置，缺省关闭。
    #[serde(default)]
    pub remote_ssh: RemoteSsh,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            theme: Theme::Dark,
            pull_integration: PullIntegration::Merge,
            branch_groups: true,
            files_view: true,
            change_requests_enabled: false,
            terminal: TerminalPrefs::default(),
            panel_widths: PanelWidths::default(),
            git_executable: None,
            recent: Vec::new(),
            drafts: BTreeMap::new(),
            workspaces: Vec::new(),
            remote_ssh: RemoteSsh::default(),
        }
    }
}

/// 主机记录的文本字段：去掉首尾空白后必须非空、无控制字符、长度有限，
/// 且不能以 `-` 开头（避免被 OpenSSH 当成选项）。
fn ssh_text(value: &str, max: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > max
        || trimmed.chars().any(char::is_control)
        || trimmed.starts_with('-')
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn ssh_host(value: &str) -> Option<String> {
    let host = ssh_text(value, 255)?;
    if host
        .chars()
        .any(|part| part.is_whitespace() || matches!(part, '@' | '/'))
    {
        return None;
    }
    Some(host)
}

fn ssh_path(value: Option<String>, is_absolute: impl Fn(&str) -> bool) -> Option<Option<String>> {
    match value.map(|path| path.trim().to_string()) {
        None => Some(None),
        Some(path) if path.is_empty() => Some(None),
        Some(path)
            if path.len() <= 4096
                && is_absolute(&path)
                && !path.contains('\0')
                && !path.chars().any(char::is_control) =>
        {
            Some(Some(path))
        }
        Some(_) => None,
    }
}

fn invalid_target() -> AppError {
    AppError::new(
        "ssh_target_invalid",
        "主机记录无效：请填写主机、用户名与 1-65535 之间的端口，认证方式只能是密钥、密码或 ssh-agent，路径必须是绝对路径。未保存任何内容。",
    )
}

/// 规范化并校验用户输入的主机记录。秘密字段不在这里，也不接受。
pub fn validate_ssh_target(mut target: SshTarget) -> Result<SshTarget, AppError> {
    if target.id.trim().is_empty() || target.id.len() > 64 || target.id.chars().any(char::is_control)
    {
        return Err(invalid_target());
    }
    target.id = target.id.trim().to_string();
    target.display_name = ssh_text(&target.display_name, 64).ok_or_else(invalid_target)?;
    target.host = ssh_host(&target.host).ok_or_else(invalid_target)?;
    target.user = ssh_host(&target.user).ok_or_else(invalid_target)?;
    if target.port == 0 {
        return Err(invalid_target());
    }
    target.auth_method = target.auth_method.trim().to_ascii_lowercase();
    if !matches!(target.auth_method.as_str(), "key" | "password" | "agent") {
        return Err(invalid_target());
    }
    let local_absolute = |path: &str| Path::new(path).is_absolute();
    target.identity_file = ssh_path(target.identity_file, local_absolute).ok_or_else(invalid_target)?;
    target.ssh_config = ssh_path(target.ssh_config, local_absolute).ok_or_else(invalid_target)?;
    // Remote repositories are on Linux or macOS, regardless of the desktop OS.
    target.default_path = ssh_path(target.default_path, |path| {
        path.starts_with('/') || local_absolute(path)
    })
    .ok_or_else(invalid_target)?;
    // 密钥认证可以不指定文件（由 ssh-agent 或默认身份文件提供）；给了就必须是绝对路径。
    if let Some(id) = &target.shared_host_id {
        target.shared_host_id = Some(ssh_text(id, 128).ok_or_else(invalid_target)?);
    }
    Ok(target)
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
        guard
            .corrupt
            .then(|| "设置文件无法读取，本次使用默认设置，未覆盖原文件。".to_string())
    }

    pub fn snapshot(&self) -> Persisted {
        self.lock().data.clone()
    }

    /// Copy only this host's registered paths and IDs before discovery performs disk I/O.
    pub(crate) fn workspace_locations(&self, host: &str) -> Vec<(String, String)> {
        let state = self.lock();
        let mut locations = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for project in &state.data.workspaces {
            for repo in &project.manifest.repositories {
                for location in &repo.locations {
                    if location.host_id == host && seen.insert(&location.path) {
                        locations.push((location.path.clone(), repo.id.clone()));
                    }
                }
            }
        }
        locations
    }

    pub fn set_theme(&self, theme: Theme) -> Result<(), AppError> {
        self.update(|data| {
            data.theme = theme;
            Ok(())
        })
    }

    pub fn set_pull_integration(&self, pull_integration: PullIntegration) -> Result<(), AppError> {
        self.update(|data| {
            data.pull_integration = pull_integration;
            Ok(())
        })
    }

    pub fn set_branch_groups(&self, branch_groups: bool) -> Result<(), AppError> {
        self.update(|data| {
            data.branch_groups = branch_groups;
            Ok(())
        })
    }

    pub fn set_files_view(&self, files_view: bool) -> Result<(), AppError> {
        self.update(|data| {
            data.files_view = files_view;
            Ok(())
        })
    }

    /// 平台创建命令的原生门禁读这个值，不只依赖前端隐藏入口。
    // T2 接上平台命令前只有本 Task 的测试调用；cdylib 不把仅测试调用算作可达。
    #[allow(dead_code)]
    pub fn change_requests_enabled(&self) -> bool {
        self.lock().data.change_requests_enabled
    }

    /// 只切换开关；关闭不删除任何钥匙串条目（令牌删除由用户显式触发）。
    pub fn set_change_requests_enabled(&self, enabled: bool) -> Result<(), AppError> {
        self.update(|data| {
            data.change_requests_enabled = enabled;
            Ok(())
        })
    }

    /// 远程 SSH 总开关。关闭只阻止新建连接，不删除主机、密码或活动会话。
    pub fn remote_ssh_enabled(&self) -> bool {
        self.lock().data.remote_ssh.enabled
    }

    pub fn set_remote_ssh_enabled(&self, enabled: bool) -> Result<(), AppError> {
        self.update(|data| {
            data.remote_ssh.enabled = enabled;
            Ok(())
        })
    }

    pub fn remote_ssh_targets(&self) -> Vec<SshTarget> {
        self.lock().data.remote_ssh.targets.clone()
    }

    pub fn remote_ssh_target(&self, id: &str) -> Option<SshTarget> {
        self.lock()
            .data
            .remote_ssh
            .targets
            .iter()
            .find(|target| target.id == id)
            .cloned()
    }

    /// 新建或更新一条主机记录。只有连接身份字段变化才推进 `revision`；
    /// 仅改显示名或默认目录时保持原修订，因此不算连接身份变化。
    pub fn save_remote_ssh_target(&self, target: SshTarget) -> Result<SshTarget, AppError> {
        let target = validate_ssh_target(target)?;
        let mut saved = target.clone();
        self.update(|data| {
            let existing = data
                .remote_ssh
                .targets
                .iter()
                .position(|item| item.id == target.id);
            match existing {
                Some(index) => {
                    let previous = &data.remote_ssh.targets[index];
                    let revision = if previous.identity() == target.identity() {
                        previous.revision.max(1)
                    } else {
                        previous.revision.max(1) + 1
                    };
                    let shared = target
                        .shared_host_id
                        .clone()
                        .or_else(|| previous.shared_host_id.clone());
                    saved.revision = revision;
                    saved.shared_host_id = shared;
                    data.remote_ssh.targets[index] = saved.clone();
                }
                None => {
                    if data.remote_ssh.targets.len() >= MAX_SSH_TARGETS {
                        return Err(AppError::new(
                            "ssh_target_limit",
                            "主机簿已满，请先删除不再使用的主机。",
                        ));
                    }
                    saved.revision = 1;
                    data.remote_ssh.targets.push(saved.clone());
                }
            }
            Ok(())
        })?;
        Ok(saved)
    }

    /// 删除一条主机记录；返回是否真的删掉了。密码条目由调用方按同一 id 显式清理。
    pub fn delete_remote_ssh_target(&self, id: &str) -> Result<bool, AppError> {
        let mut removed = false;
        self.update(|data| {
            let before = data.remote_ssh.targets.len();
            data.remote_ssh.targets.retain(|target| target.id != id);
            removed = data.remote_ssh.targets.len() != before;
            Ok(())
        })?;
        Ok(removed)
    }

    pub fn set_terminal_prefs(&self, prefs: TerminalPrefs) -> Result<TerminalPrefs, AppError> {
        let prefs = prefs.clamped();
        let saved = prefs.clone();
        self.update(|data| {
            data.terminal = prefs;
            Ok(())
        })?;
        Ok(saved)
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
                data.recent.truncate(MAX_RECENT);
            }
            Ok(())
        })
    }

    pub fn forget_recent(&self, path: &str) -> Result<Vec<RecentRepo>, AppError> {
        self.update(|data| {
            data.recent.retain(|repo| repo.path != path);
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
            return Err(AppError::new("draft_too_large", "提交说明过长，未保存。"));
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

    pub(crate) fn update(
        &self,
        change: impl FnOnce(&mut Persisted) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mut guard = self.lock();
        if guard.corrupt {
            return Err(AppError::new(
                "settings_corrupt",
                "设置文件已损坏，未覆盖原文件。本次修改不会写入磁盘。",
            ));
        }
        let mut next = guard.data.clone();
        change(&mut next)?;
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|error| AppError::new("settings_encode", format!("无法编码设置：{error}")))?;
        atomic_write(&self.path, &bytes)
            .map_err(|error| AppError::new("settings_write", format!("无法保存设置：{error}")))?;
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
        Ok(mut data) if data.version == 1 => {
            // Backup the exact old bytes before the first v2 write. Failure keeps v1 untouched.
            let backup = path.with_file_name("state.v1.backup.json");
            if !backup.exists() && atomic_write(&backup, &bytes).is_err() {
                return (data, true);
            }
            data.version = STATE_VERSION;
            match serde_json::to_vec_pretty(&data)
                .ok()
                .and_then(|next| atomic_write(path, &next).ok())
            {
                Some(()) => (data, false),
                None => (data, true),
            }
        }
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
        assert_eq!(store.draft("/work/a"), "修正空状态文案");
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
        let value: Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
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
    fn old_file_defaults_pull_to_merge_and_branch_groups_on() {
        let dir = crate::test_support::TempDir::new("state-pull-groups");
        let path = dir.path().join("state.json");
        fs::write(
            &path,
            r#"{"version":1,"theme":"light","panelWidths":{"sidebar":280,"files":340},"recent":[],"drafts":{}}"#,
        )
        .unwrap();
        let store = AppStore::open(path.clone());
        assert!(store.settings_warning().is_none());
        assert_eq!(
            Persisted::default().pull_integration,
            PullIntegration::Merge
        );
        assert!(Persisted::default().branch_groups);
        let snapshot = store.snapshot();
        assert_eq!(snapshot.theme, Theme::Light);
        assert_eq!(snapshot.pull_integration, PullIntegration::Merge);
        assert!(snapshot.branch_groups);
        assert!(snapshot.files_view, "旧设置文件默认显示文件视图");
        let original = fs::read(&path).unwrap();

        store.set_theme(Theme::Dark).unwrap();
        let written: Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(written["pullIntegration"], "merge");
        assert_eq!(written["branchGroups"], true);
        assert_ne!(fs::read(&path).unwrap(), original);

        store.set_pull_integration(PullIntegration::Rebase).unwrap();
        store.set_branch_groups(false).unwrap();
        store.set_files_view(false).unwrap();
        let again = AppStore::open(path);
        assert!(!again.snapshot().files_view);
        assert_eq!(again.snapshot().theme, Theme::Dark);
        assert_eq!(again.snapshot().pull_integration, PullIntegration::Rebase);
        assert!(!again.snapshot().branch_groups);
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(again.path()).unwrap()).unwrap();
        assert_eq!(saved["pullIntegration"], "rebase");
        assert_eq!(saved["branchGroups"], false);
    }

    #[test]
    fn change_requests_default_off_for_new_and_old_state() {
        let dir = crate::test_support::TempDir::new("state-change-requests-default");
        let path = dir.path().join("state.json");
        // 新安装：本地还没有设置文件。
        let fresh = AppStore::open(path.clone());
        assert!(!fresh.snapshot().change_requests_enabled);
        assert!(!fresh.change_requests_enabled());

        // v1 旧文件（字段缺失，需迁移）与 v2 旧文件都读成关闭。
        let mut v1 = serde_json::to_value(Persisted::default()).unwrap();
        v1["version"] = 1.into();
        v1.as_object_mut().unwrap().remove("changeRequestsEnabled");
        fs::write(&path, serde_json::to_vec(&v1).unwrap()).unwrap();
        let old_v1 = AppStore::open(path.clone());
        assert!(old_v1.settings_warning().is_none());
        assert!(!old_v1.snapshot().change_requests_enabled);
        assert!(!old_v1.change_requests_enabled());

        let mut v2 = serde_json::to_value(Persisted::default()).unwrap();
        v2.as_object_mut().unwrap().remove("changeRequestsEnabled");
        fs::write(&path, serde_json::to_vec(&v2).unwrap()).unwrap();
        let old_v2 = AppStore::open(path.clone());
        assert!(!old_v2.snapshot().change_requests_enabled);

        // 写入成功后磁盘上出现显式的 false，不必靠字段缺失推断关闭。
        old_v2.set_theme(Theme::Light).unwrap();
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["changeRequestsEnabled"], false);
    }

    #[test]
    fn change_requests_toggle_survives_restart_and_leaves_other_settings() {
        let dir = crate::test_support::TempDir::new("state-change-requests-restart");
        let path = dir.path().join("state.json");
        let store = AppStore::open(path.clone());
        store.set_branch_groups(false).unwrap();
        store.set_change_requests_enabled(true).unwrap();
        assert!(store.change_requests_enabled());

        // 重启：重新打开同一个文件后保持用户已保存的选择。
        let restarted = AppStore::open(path.clone());
        assert!(restarted.snapshot().change_requests_enabled);
        assert!(!restarted.snapshot().branch_groups);

        // 关闭只是写回 false，不重置其它设置。
        restarted.set_change_requests_enabled(false).unwrap();
        let again = AppStore::open(path.clone());
        assert!(!again.change_requests_enabled());
        assert!(!again.snapshot().branch_groups);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["changeRequestsEnabled"], false);
    }

    #[test]
    fn change_requests_write_failure_keeps_previous_value() {
        let dir = crate::test_support::TempDir::new("state-change-requests-corrupt");
        let path = dir.path().join("state.json");
        fs::write(&path, b"{not-json").unwrap();
        let original = fs::read(&path).unwrap();
        let store = AppStore::open(path.clone());
        assert!(store.settings_warning().is_some());
        let error = store.set_change_requests_enabled(true).unwrap_err();
        assert_eq!(error.code, "settings_corrupt");
        assert!(!store.change_requests_enabled());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn change_requests_disk_error_keeps_previous_value() {
        use std::os::unix::fs::PermissionsExt;

        let dir = crate::test_support::TempDir::new("state-change-requests-disk");
        let path = dir.path().join("state.json");
        let store = AppStore::open(path.clone());
        assert!(!store.change_requests_enabled());
        // 目录不可写时 atomic_write 建不了临时文件，这就是真实的磁盘写入失败。
        let mut locked = fs::metadata(dir.path()).unwrap().permissions();
        locked.set_mode(0o500);
        fs::set_permissions(dir.path(), locked).unwrap();
        let result = store.set_change_requests_enabled(true);
        let mut restore = fs::metadata(dir.path()).unwrap().permissions();
        restore.set_mode(0o700);
        fs::set_permissions(dir.path(), restore).unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "settings_write", "{}", error.message);
        assert!(!store.change_requests_enabled(), "写入失败不得改内存快照");
        assert!(!path.exists(), "失败不得留下新设置文件");
    }

    #[test]
    fn theme_defaults_to_dark_and_keeps_three_states_on_disk() {
        let dir = crate::test_support::TempDir::new("state-theme");
        let store = store_in(dir.path());
        assert_eq!(Persisted::default().theme, Theme::Dark);
        assert_eq!(store.snapshot().theme, Theme::Dark);
        for (theme, wire) in [
            (Theme::Light, "light"),
            (Theme::Dark, "dark"),
            (Theme::System, "system"),
        ] {
            store.set_theme(theme).unwrap();
            let written: Value =
                serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
            assert_eq!(written["theme"], Value::String(wire.into()), "{wire}");
            assert_eq!(store_in(dir.path()).snapshot().theme, theme, "{wire}");
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
        assert_eq!(store.snapshot().theme, Theme::Dark);
    }

    #[test]
    fn recent_cap_and_forget_preserve_checkout_drafts() {
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
        assert!(snapshot.drafts.contains_key("/repo/0"));
        store.forget_recent("/repo/1").unwrap();
        assert_eq!(store_in(dir.path()).draft("/repo/1"), "说明");
        assert_eq!(
            snapshot.drafts.get("/repo/1").map(String::as_str),
            Some("说明")
        );
    }

    #[test]
    fn migrates_v1_with_exact_backup_without_losing_recent_or_drafts() {
        let dir = crate::test_support::TempDir::new("state-v1");
        let path = dir.path().join("state.json");
        let mut old = serde_json::to_value(Persisted::default()).unwrap();
        old["version"] = 1.into();
        old.as_object_mut().unwrap().remove("workspaces");
        old["drafts"] = serde_json::json!({"/missing/old-checkout": "保留旧说明"});
        old["recent"] =
            serde_json::json!([{"name":"demo", "path":"/missing/old-checkout", "openedAtMs":42}]);
        let bytes = serde_json::to_vec(&old).unwrap();
        fs::write(&path, &bytes).unwrap();
        let store = AppStore::open(path.clone());
        assert!(store.settings_warning().is_none());
        assert_eq!(store.snapshot().version, 2);
        assert_eq!(store.snapshot().recent[0].opened_at_ms, 42);
        assert_eq!(store.draft("/missing/old-checkout"), "保留旧说明");
        assert_eq!(
            fs::read(dir.path().join("state.v1.backup.json")).unwrap(),
            bytes
        );
        assert_eq!(
            AppStore::open(path).draft("/missing/old-checkout"),
            "保留旧说明"
        );
    }

    #[test]
    fn unknown_state_version_is_preserved_and_cannot_be_overwritten() {
        let dir = crate::test_support::TempDir::new("state-future");
        let path = dir.path().join("state.json");
        let mut value = serde_json::to_value(Persisted::default()).unwrap();
        value["version"] = 999.into();
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &bytes).unwrap();
        let store = AppStore::open(path.clone());
        assert!(store.set_theme(Theme::Light).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    fn ssh_target(id: &str) -> SshTarget {
        let identity_file = if cfg!(windows) {
            "C:/Users/deploy/.ssh/id_ed25519"
        } else {
            "/home/deploy/.ssh/id_ed25519"
        };
        SshTarget {
            id: id.into(),
            display_name: "构建机".into(),
            host: "build.example.com".into(),
            port: 22,
            user: "deploy".into(),
            auth_method: "key".into(),
            identity_file: Some(identity_file.into()),
            ssh_config: None,
            default_path: Some("/srv/app".into()),
            enabled: true,
            shared_host_id: None,
            revision: 0,
        }
    }

    #[test]
    fn remote_ssh_defaults_off_for_new_and_old_state() {
        let dir = crate::test_support::TempDir::new("state-ssh-default");
        let path = dir.path().join("state.json");
        let fresh = store_in(dir.path());
        assert!(!fresh.remote_ssh_enabled(), "缺省必须关闭");
        assert!(fresh.remote_ssh_targets().is_empty());
        assert!(fresh.settings_warning().is_none());

        // 旧 v2 文件缺少整个字段：仍然关闭，且不是损坏文件。
        let mut old = serde_json::to_value(Persisted::default()).unwrap();
        old.as_object_mut().unwrap().remove("remoteSsh");
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        let loaded = AppStore::open(path.clone());
        assert!(loaded.settings_warning().is_none());
        assert!(!loaded.remote_ssh_enabled());

        // 写入一次别的设置后，磁盘上出现显式的关闭值。
        loaded.set_theme(Theme::Light).unwrap();
        let written: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["remoteSsh"]["enabled"], false);
        assert_eq!(written["remoteSsh"]["targets"], serde_json::json!([]));
    }

    #[test]
    fn remote_ssh_targets_persist_without_any_secret_field() {
        let dir = crate::test_support::TempDir::new("state-ssh-persist");
        let store = store_in(dir.path());
        store.set_remote_ssh_enabled(true).unwrap();
        let saved = store.save_remote_ssh_target(ssh_target("host-a")).unwrap();
        assert_eq!(saved.revision, 1);

        let restarted = store_in(dir.path());
        assert!(restarted.remote_ssh_enabled());
        let targets = restarted.remote_ssh_targets();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].host, "build.example.com");
        assert_eq!(targets[0].auth_method, "key");

        // state.json 只含非秘密配置：没有密码、令牌或口令字段。
        let raw = fs::read_to_string(store.path()).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        for key in object_keys(&value) {
            let lower = key.to_ascii_lowercase();
            assert!(
                !lower.contains("password")
                    && !lower.contains("passphrase")
                    && !lower.contains("secret")
                    && !lower.contains("token"),
                "{key}"
            );
        }
    }

    #[test]
    fn renaming_keeps_revision_but_connection_changes_advance_it() {
        let dir = crate::test_support::TempDir::new("state-ssh-revision");
        let store = store_in(dir.path());
        let first = store.save_remote_ssh_target(ssh_target("host-a")).unwrap();
        assert_eq!(first.revision, 1);

        // 仅显示名与默认目录变化：连接身份不变，修订不动。
        let mut renamed = first.clone();
        renamed.display_name = "构建机（改名）".into();
        renamed.default_path = Some("/srv/app2".into());
        let renamed = store.save_remote_ssh_target(renamed).unwrap();
        assert_eq!(renamed.revision, 1);
        assert_eq!(renamed.display_name, "构建机（改名）");

        // 主机变化：必须推进修订，要求重新确认。
        let mut moved = renamed.clone();
        moved.host = "other.example.com".into();
        let moved = store.save_remote_ssh_target(moved).unwrap();
        assert_eq!(moved.revision, 2);

        // 认证方式变化同样推进。
        let mut password = moved.clone();
        password.auth_method = "password".into();
        password.identity_file = None;
        let password = store.save_remote_ssh_target(password).unwrap();
        assert_eq!(password.revision, 3);
        assert_eq!(store.remote_ssh_targets().len(), 1, "更新不是新增");
    }

    #[test]
    fn invalid_ssh_targets_are_rejected_without_writing() {
        let dir = crate::test_support::TempDir::new("state-ssh-invalid");
        let store = store_in(dir.path());
        let cases: [fn(&mut SshTarget); 6] = [
            |target| target.host = "  ".into(),
            |target| target.user = "-oProxyCommand=evil".into(),
            |target| target.port = 0,
            |target| target.auth_method = "telnet".into(),
            |target| target.identity_file = Some("relative/key".into()),
            |target| target.default_path = Some("relative/repository".into()),
        ];
        for mutate in cases {
            let mut target = ssh_target("host-a");
            mutate(&mut target);
            let error = store.save_remote_ssh_target(target).unwrap_err();
            assert_eq!(error.code, "ssh_target_invalid");
            assert!(store.remote_ssh_targets().is_empty());
        }
        assert!(!store.path().exists(), "失败不得留下设置文件");
    }

    #[test]
    fn deleting_a_target_keeps_other_hosts_and_the_switch() {
        let dir = crate::test_support::TempDir::new("state-ssh-delete");
        let store = store_in(dir.path());
        store.set_remote_ssh_enabled(true).unwrap();
        store.save_remote_ssh_target(ssh_target("host-a")).unwrap();
        store.save_remote_ssh_target(ssh_target("host-b")).unwrap();
        assert!(store.delete_remote_ssh_target("host-a").unwrap());
        assert!(!store.delete_remote_ssh_target("host-a").unwrap());
        let targets = store.remote_ssh_targets();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "host-b");
        assert!(store.remote_ssh_enabled(), "删除主机不改总开关");
        // 关闭总开关也不删除主机记录。
        store.set_remote_ssh_enabled(false).unwrap();
        assert_eq!(store.remote_ssh_targets().len(), 1);
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
