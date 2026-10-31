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
    /// True only after a successful remote check that is still inside the fresh window.
    pub live_remote_checked: bool,
    #[serde(default)]
    pub remote_checked_at_ms: Option<u64>,
    #[serde(default)]
    pub remote_check_stale: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub generation: u64,
    pub remotes: Vec<RemoteInfo>,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchRecord {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    pub generation: u64,
    pub branches: Vec<BranchRecord>,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    pub opened: OpenedRepository,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitPushReport {
    pub committed: bool,
    pub pushed: bool,
    pub retry_push: bool,
    pub oid: String,
    pub branch: String,
    pub summary: String,
    pub push_error: Option<String>,
    pub generation: u64,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLabel {
    pub name: String,
    pub kind: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: i64,
    pub labels: Vec<HistoryLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub generation: u64,
    pub query: String,
    pub offset: u32,
    pub page_size: u32,
    pub has_more: bool,
    /// `ok`, `empty_repository`, or `no_match`.
    pub state: String,
    pub commits: Vec<HistoryCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub generation: u64,
    pub commit: HistoryCommit,
    pub body: String,
    pub root: bool,
    pub merge: bool,
    /// Parent used for the file list. `None` compares the first commit with the empty tree.
    pub selected_parent: Option<String>,
    pub files: Vec<CommitFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    pub generation: u64,
    pub path: String,
    pub offset: u32,
    pub page_size: u32,
    pub has_more: bool,
    /// `ok`, `empty_repository`, or `no_file_history`.
    pub state: String,
    pub commits: Vec<HistoryCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashPreview {
    pub tracked_count: u32,
    pub untracked_count: u32,
    pub ignored_count: u32,
    pub tracked_paths: Vec<String>,
    pub untracked_paths: Vec<String>,
    pub ignored_paths: Vec<String>,
    pub include_untracked: bool,
    pub can_save: bool,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashRecord {
    pub oid: String,
    pub message: String,
    pub committed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashState {
    pub generation: u64,
    pub preview: StashPreview,
    pub records: Vec<StashRecord>,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashSaveResult {
    pub oid: String,
    pub note: String,
    pub state: StashState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyResult {
    pub generation: u64,
    pub oid: String,
    pub kept: bool,
    /// Always `stash`. Callers must not present this as a branch merge.
    pub operation: String,
    pub conflicted: bool,
    pub conflict_paths: Vec<String>,
    /// Stash apply never creates a merge that can be aborted.
    pub can_abort_merge: bool,
    pub note: String,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub generation: u64,
    pub source: String,
    pub target: String,
    pub head_oid: Option<String>,
    pub dirty: bool,
    pub local_paths: Vec<String>,
    pub can_start: bool,
    pub operation: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub path: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeSession {
    pub generation: u64,
    pub operation: String,
    pub can_continue: bool,
    pub can_abort: bool,
    pub source: Option<String>,
    pub target: Option<String>,
    pub head_oid: Option<String>,
    pub conflicts: Vec<ConflictEntry>,
    pub unresolved: u32,
    pub note: String,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub present: bool,
    pub binary: bool,
    pub truncated: bool,
    pub text: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub generation: u64,
    pub path: String,
    pub kind: String,
    pub editable: bool,
    pub ours: ConflictSide,
    pub theirs: ConflictSide,
    pub result: ConflictSide,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeComplete {
    pub oid: String,
    pub generation: u64,
    pub summary: String,
    pub files: Vec<String>,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AbortImpact {
    pub generation: u64,
    pub wrote: bool,
    pub paths: Vec<String>,
    pub stash_oids: Vec<String>,
    pub note: String,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub generation: u64,
    pub code: String,
    pub eligible: bool,
    pub wrote: bool,
    pub head_oid: String,
    pub parent_oid: Option<String>,
    pub summary: String,
    pub reason: String,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscardFilePlan {
    pub path: String,
    /// Set for a rename so the confirmation list names both sides.
    pub original_path: Option<String>,
    pub staged: ChangeKind,
    pub unstaged: ChangeKind,
    pub untracked: bool,
    pub impact: String,
    pub recovery: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscardResult {
    pub generation: u64,
    pub wrote: bool,
    pub files: Vec<DiscardFilePlan>,
    pub boundary: String,
    pub snapshot: StatusSnapshot,
}
