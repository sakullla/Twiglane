use serde::{Deserialize, Serialize};

pub const MIN_PANEL_WIDTH: u32 = 160;
pub const MAX_PANEL_WIDTH: u32 = 560;
pub const DEFAULT_SIDEBAR_WIDTH: u32 = 280;
pub const DEFAULT_FILES_WIDTH: u32 = 340;
pub const MAX_RECENT: usize = 30;
pub const MAX_DRAFT_CHARS: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PanelWidths {
    pub sidebar: u32,
    pub files: u32,
}

impl Default for PanelWidths {
    fn default() -> Self {
        Self {
            sidebar: DEFAULT_SIDEBAR_WIDTH,
            files: DEFAULT_FILES_WIDTH,
        }
    }
}

impl PanelWidths {
    pub fn clamped(mut self) -> Self {
        self.sidebar = clamp_width(self.sidebar);
        self.files = clamp_width(self.files);
        self
    }
}

pub fn clamp_width(value: u32) -> u32 {
    value.clamp(MIN_PANEL_WIDTH, MAX_PANEL_WIDTH)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub name: String,
    pub path: String,
    pub opened_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub overridden: bool,
    pub below_baseline: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    None,
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

impl ChangeKind {
    pub fn from_status_char(value: char) -> Self {
        match value {
            '.' => Self::None,
            'A' => Self::Added,
            'M' => Self::Modified,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'T' => Self::TypeChanged,
            'U' => Self::Unmerged,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub staged: ChangeKind,
    pub unstaged: ChangeKind,
    pub untracked: bool,
    pub unmerged: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub head_oid: Option<String>,
    pub upstream: Option<String>,
    /// `branch.ab` counts. Porcelain signs are directions, so both values stay non-negative.
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    /// T1 never contacts the network. Tracking numbers are local records only.
    pub live_remote_checked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub generation: u64,
    pub branch: BranchInfo,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub hunk_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub index: u32,
    pub header: String,
    pub complete: bool,
    pub stageable: bool,
    pub start_line: u32,
    pub line_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub generation: u64,
    pub path: String,
    pub staged: bool,
    pub binary: bool,
    pub text: Option<String>,
    pub summary: String,
    pub additions: u64,
    pub deletions: u64,
    pub complete: bool,
    pub truncated: bool,
    pub snapshot: String,
    pub hunks: Vec<DiffHunk>,
    pub lines: Vec<DiffLine>,
    pub offset: u32,
    pub total_lines: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub oid: String,
    pub generation: u64,
    pub branch: String,
    pub summary: String,
    pub files: Vec<String>,
    /// Local commit never pushes. The flag stays false so the two actions stay distinct.
    pub pushed: bool,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRepository {
    pub summary: RepoSummary,
    pub generation: u64,
    pub snapshot: StatusSnapshot,
    pub draft: String,
    pub watch_degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub theme: Theme,
    pub panel_widths: PanelWidths,
    pub git: GitInfo,
    pub recent: Vec<RecentRepo>,
    pub settings_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanged {
    pub path: String,
    pub generation: u64,
    pub degraded: bool,
}
