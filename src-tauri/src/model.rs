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
    Light,
    #[default]
    Dark,
    /// Follows the system appearance. The frontend resolves it to light or dark.
    System,
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

/// 文本差异的新增与删除行数。两个计数都是 `None` 时表示二进制，不能用 0 冒充。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineStat {
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    /// 二进制改动前后的字节数（改动前不存在或读不到时为空）。文本文件不填。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_size: Option<u64>,
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
    /// 已暂存一侧。没有这一侧的变化时不填。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_lines: Option<LineStat>,
    /// 未暂存一侧。未跟踪文本文件的新增行数是文件当前行数，删除为 0。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unstaged_lines: Option<LineStat>,
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

/// 选中的差异行身份。kind 只允许 add / del；上下文、块标题、meta 与「没有换行」标记
/// 不可选，也不参与逐行补丁。oldNo/newNo 与 DiffLine 完全一致，前后端用同一份身份。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLineSelection {
    pub hunk_index: u32,
    pub kind: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<crate::git::preview::PreviewSources>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<crate::git::preview::PreviewSources>,
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
    /// 二进制改动前后的字节数，与 LineStat 同义。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_size: Option<u64>,
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
    /// 提交缩写长度（Git 的 core.abbrev / 自动长度）。旧数据缺省时按 Git 的最小默认 7 位。
    #[serde(default = "default_abbrev_length")]
    pub abbrev_length: u8,
}

/// Git 自动缩写的下限，也是读不到仓库缩写长度（空仓库、命令失败）时的退路。
pub const DEFAULT_ABBREV_LENGTH: u8 = 7;

fn default_abbrev_length() -> u8 {
    DEFAULT_ABBREV_LENGTH
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
    #[serde(default)]
    pub target_oid: Option<String>,
    /// 已经完整包含在主干里：本地默认分支和它的远程对应分支（两者都存在时都要包含）。
    /// 主干分支自己不标记。用来提示「可以安全删除」，不影响任何写入判断。
    #[serde(default)]
    pub merged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchListing {
    pub generation: u64,
    pub branches: Vec<BranchRecord>,
    pub default_branch: Option<String>,
    pub merge_bases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    pub generation: u64,
    pub branches: Vec<BranchRecord>,
    pub snapshot: StatusSnapshot,
    /// 默认分支：`origin/HEAD` 指向的本地分支；否则依次取存在的 main、master、develop。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    /// 判定 `merged` 用到的主干分支（例如 `master`、`origin/master`）；没有默认分支时为空。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merge_bases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub name: String,
    pub target_oid: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTag {
    pub name: String,
    /// 附注标签是解引用后的提交，可直接与 `TagRecord::target_oid` 比较。
    pub oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagState {
    pub generation: u64,
    pub tags: Vec<TagRecord>,
    pub snapshot: StatusSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    pub opened: OpenedRepository,
    /// 用用户名密码克隆时，凭据是否已交给凭据助手保存的说明；不含凭据本身。
    pub credential_note: Option<String>,
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
    /// `ok`, `empty_repository`, `empty_branch`, or `no_match`.
    pub state: String,
    pub commits: Vec<HistoryCommit>,
    /// `current`、`all`，或本地分支名。
    pub scope: String,
    pub branches: Vec<String>,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    /// 文本文件的新增与删除行数。二进制不填计数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    /// 二进制改动前后的字节数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreOutcome {
    pub snapshot: StatusSnapshot,
    pub note: String,
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

/// 两点之间的净文件清单：`base` 为空表示与空树比较。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareFiles {
    pub generation: u64,
    pub base: Option<String>,
    pub head: String,
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
    /// `ok`, `empty_repository`, `no_file_history`, or `no_match`.
    pub state: String,
    pub commits: Vec<HistoryCommit>,
    pub scope: String,
    pub branches: Vec<String>,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickOutcome {
    pub generation: u64,
    pub conflicted: bool,
    pub skipped: Vec<String>,
    pub note: String,
    pub snapshot: StatusSnapshot,
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
    /// 当前所在分支；目标不是它时会先切换。
    pub current: Option<String>,
    /// 目标不是当前分支：开始前需要先切换过去。
    pub needs_switch: bool,
    /// 来源有、目标没有的提交数（合并会带入）。
    pub incoming: u32,
    /// 目标有、来源没有的提交数；为 0 时可以快进。
    pub outgoing: u32,
    pub up_to_date: bool,
    pub fast_forward: bool,
    pub commits: Vec<HistoryCommit>,
    pub files: Vec<CommitFileChange>,
    pub files_total: u32,
    /// 冲突预测：`clean` / `conflicts` / `unknown`（Git 过旧或无法预测）。
    pub conflict_check: String,
    pub conflict_paths: Vec<String>,
    /// 阻止开始的原因代码：dirty / operation / detached / same / remote_target / up_to_date / worktree。
    pub blocker: Option<String>,
    /// 目标与来源的共同祖先；预览里查看单个文件会带入什么时作为比较起点。
    #[serde(default)]
    pub base_oid: Option<String>,
    /// 来源分支顶端提交。
    #[serde(default)]
    pub source_oid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainingBranch {
    pub name: String,
    pub remote: bool,
    /// 当前检出的分支。
    pub current: bool,
}

/// 包含某个提交的分支：回答「这个提交在哪些分支上生效」。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitBranches {
    pub generation: u64,
    pub oid: String,
    pub branches: Vec<ContainingBranch>,
    /// 截断前的总数。
    pub total: u32,
    /// 当前检出的分支；游离 HEAD 时为空。
    pub current: Option<String>,
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
    /// 开始前从哪个分支切换过来（目标不是原当前分支时）。
    #[serde(default)]
    pub switched_from: Option<String>,
    /// 以快进方式完成，没有创建合并提交。
    #[serde(default)]
    pub fast_forwarded: bool,
    /// 变基已完成：当前分支上尚未进入基底的提交已接到基底顶端。没有推送。
    #[serde(default)]
    pub rebased: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub present: bool,
    pub binary: bool,
    pub truncated: bool,
    pub text: Option<String>,
    pub summary: String,
    /// 这一侧的字节数；读取被截断时为空（只知道超过了预览上限）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryEntryKind {
    File,
    Directory,
    Symlink,
    Special,
    NestedRepository,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: RepositoryEntryKind,
    pub ignored: bool,
    pub size: Option<u64>,
    /// 文件元数据版本；仅用于只读内容刷新，不作为 Git 写入凭据。
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDirectory {
    pub generation: u64,
    pub path: String,
    pub entries: Vec<RepositoryDirectoryEntry>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryFileKind {
    Text,
    Resource,
    Binary,
    InvalidUtf8,
    Missing,
    Special,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFileContent {
    pub generation: u64,
    pub path: String,
    pub kind: RepositoryFileKind,
    pub size: u64,
    pub version: Option<String>,
    pub offset: u64,
    pub lines: Vec<String>,
    pub next_offset: u64,
    pub has_more: bool,
    pub truncated: bool,
    pub message: Option<String>,
}

/// 单个改动路径的整文件快照状态。
///
/// 只有 `Current` 会带 token：其余状态说明这条路径现在没有改动、工作区里已经没有它，
/// 或内容无法确认，界面不能据此标记已审阅。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryReviewState {
    Current,
    Unchanged,
    Missing,
    Unconfirmed,
}

/// 一次 `repository_review_token` 的结果：汇总这一条路径的暂存/未暂存/未跟踪/冲突状态
/// 与它当前的内容版本。token 只随内容或状态变化，由前端在当前会话内保存。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryReviewToken {
    pub generation: u64,
    pub path: String,
    pub state: RepositoryReviewState,
    /// 仅 `Current` 有值；其余状态为 null，前端保持未审阅。
    pub token: Option<String>,
    pub staged: ChangeKind,
    pub unstaged: ChangeKind,
    pub untracked: bool,
    pub unmerged: bool,
    /// 工作区内容版本（Git 对象 id 或 `missing`），用于解释 token 依据了哪一份内容。
    pub content_version: Option<String>,
    pub message: String,
}

/// 任务范围内一条路径的最终净状态：起点到工作区的净差异，由后端合并提交、暂存、
/// 未暂存改动与未跟踪文件后给出。`status` 与提交文件列表用同一套名称。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileChange {
    pub path: String,
    pub original_path: Option<String>,
    /// added / modified / deleted / renamed / copied / typeChanged / unmerged / unknown
    pub status: String,
    /// 文本文件的新增与删除行数。二进制或行数无法确认时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    /// 二进制改动前后的字节数：改动前取自起点里的版本，改动后取自工作区。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_size: Option<u64>,
    /// 起点里没有这条路径：来自未跟踪文件。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untracked: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unmerged: bool,
    /// 起点里有这条路径，工作区里却是未跟踪的同名文件（删除后重建）。行数只统计重建后
    /// 的内容，界面据此标为「工作区重建」，不暗示为纯新增。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rebuilt: bool,
}

/// 一次只读任务读取的结果。只有完整读取成功才返回：空任务用 `empty` 表示，
/// 不用错误或空列表冒充。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskReview {
    pub generation: u64,
    /// canonical worktree 路径：范围身份的一部分，必须就是前端打开的那个目录。
    pub worktree: String,
    /// 用户给出的起点写法（分支名、简称或完整提交），只用于显示。
    pub baseline_ref: String,
    /// 校验过的完整起点提交标识。
    pub baseline_oid: String,
    /// 读取时的 HEAD 完整提交标识。空分支是单独的错误，不会走到这里。
    pub head_oid: String,
    pub branch: BranchInfo,
    /// 范围内提交的第一页，新的在前。
    pub commits: Vec<HistoryCommit>,
    /// 范围内提交总数；`commits` 只是第一页。
    pub commit_count: u64,
    pub commits_truncated: bool,
    pub files: Vec<TaskFileChange>,
    /// 实际合并进来的文件数；达到上限时 `files_truncated` 为真。
    pub files_total: u32,
    pub files_truncated: bool,
    pub additions: u64,
    pub deletions: u64,
    /// 索引、工作区或未跟踪文件里还有未提交改动。
    pub dirty: bool,
    pub untracked_files: u32,
    pub conflicted: bool,
    /// 起点之后没有任何提交，也没有净改动。
    pub empty: bool,
    /// 范围版本：绑定 worktree、起点、HEAD 与当前未提交状态，供后续失效判断。
    pub range_version: String,
    pub message: String,
}

/// 任务范围内单条路径的快照确认。token 绑定 worktree、起点、这条路径的最终净内容
/// 与两侧状态；无法确认或差异被截断时不产生 token。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewToken {
    pub generation: u64,
    pub path: String,
    pub baseline_oid: String,
    pub state: RepositoryReviewState,
    /// 仅 `Current` 有值；其余状态为 null，前端保持未审阅。
    pub token: Option<String>,
    /// 这条路径相对起点的净状态名称（added / modified / deleted / renamed …）。
    pub status: String,
    pub untracked: bool,
    pub unmerged: bool,
    /// 起点里这一条路径的版本；起点没有它时为 `absent`。
    pub baseline_version: Option<String>,
    /// 工作区内容版本（`worktree:<oid>` 或 `missing`）。
    pub content_version: Option<String>,
    /// 这条路径的净差异超过预览上限：只读到一部分，不能确认整份内容。
    pub truncated: bool,
    pub message: String,
}

/// 路径搜索的结果类型：文件来自 Git 路径集合，目录由文件祖先派生。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryPathKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPathEntry {
    pub path: String,
    pub kind: RepositoryPathKind,
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPathSearch {
    pub generation: u64,
    pub query: String,
    pub directory: Option<String>,
    pub include_ignored: bool,
    /// 实际参与匹配的路径条数（含派生目录），用来区分"没有匹配"与"没有枚举到任何路径"。
    pub scanned: u64,
    pub entries: Vec<RepositoryPathEntry>,
    /// 路径枚举被 Git 输出上限或本地条数上限截断，或匹配数超过本次 limit。
    pub truncated: bool,
    pub message: Option<String>,
}

/// 内容搜索范围：全仓、某个目录、单个文件，或当前改动的路径集合。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RepositorySearchScope {
    Repository,
    Directory { path: String },
    File { path: String },
    Changed,
}

impl RepositorySearchScope {
    /// 稳定的小写名称：前端只用它区分显示，不据此改变范围语义。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Repository => "repository",
            Self::Directory { .. } => "directory",
            Self::File { .. } => "file",
            Self::Changed => "changed",
        }
    }
}

/// 单个文件为什么没有参与搜索。每一种都要真实出现，不能用"无匹配"掩盖。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositorySkipReason {
    Binary,
    InvalidUtf8,
    /// 图片、压缩包等走资源预览的类型：它们不是文本，也不生成伪文本匹配。
    Unsupported,
    Symlink,
    Special,
    NestedRepository,
    TooLarge,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySearchSkip {
    pub path: String,
    pub reason: RepositorySkipReason,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContentMatch {
    pub path: String,
    /// 1 起算的行号。
    pub line: u64,
    /// 1 起算的列号，按 Unicode 标量计数，前端可直接据此定位字符。
    pub column: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContentSearch {
    pub generation: u64,
    pub query: String,
    pub scope: String,
    pub scope_path: Option<String>,
    pub matches: Vec<RepositoryContentMatch>,
    /// 真正读到并完整解码的文件数，不含被跳过的文件。
    pub files_scanned: u64,
    /// 被跳过文件的原因明细（有界）；完整数量见 skipped_files。
    pub skipped: Vec<RepositorySearchSkip>,
    pub skipped_files: u64,
    /// 结果达到 limit，或文件数/读取字节数达到上限，或路径枚举本身被截断。
    pub truncated: bool,
    /// 匹配行的展示文本被截短过；行号与列号仍然准确。
    pub text_truncated: bool,
    pub message: Option<String>,
}

/// 轻量编辑一次读取/保存的能力状态。只有 `Editable` 会带完整文本；
/// 其余状态说明这条路径为什么继续保持只读。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryEditState {
    Editable,
    Missing,
    Symlink,
    Special,
    TooLarge,
    Binary,
    InvalidUtf8,
    MixedLineEndings,
    Resource,
}

/// 文件原本的统一行尾。`None` 表示整份内容没有换行；`Mixed` 只出现在只读原因里，
/// 保存不会写出混合行尾。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryLineEnding {
    None,
    Lf,
    Crlf,
    Mixed,
}

/// 一次完整文本编辑读取的快照。
///
/// `digest` 是原始文件字节（含 BOM）的 SHA-256，只随真实内容变化，是保存时的冲突凭据；
/// `text` 去掉 BOM 并把行尾统一为 LF，保存时再按 `lineEnding` 还原。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryEditSnapshot {
    pub generation: u64,
    pub path: String,
    pub state: RepositoryEditState,
    pub editable: bool,
    pub size: u64,
    /// 未完整读取（超限、缺失、非普通文件）时为 null。
    pub digest: Option<String>,
    /// 只有 `editable` 为真时是完整文本；只读状态为 null。
    pub text: Option<String>,
    /// 原始文件带 UTF-8 BOM；保存时原样保留。
    pub bom: bool,
    pub line_ending: RepositoryLineEnding,
    /// 编辑文本自身是否以换行结尾；保存不为它补换行。
    pub final_newline: bool,
    pub message: String,
}
