export type Theme = "light" | "dark";

export type ChangeKind =
  | "none"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "unmerged"
  | "unknown";

export interface RecentRepo {
  name: string;
  path: string;
  openedAtMs: number;
}

export interface GitInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  overridden: boolean;
  belowBaseline: boolean;
  message: string;
}

export interface RepoSummary {
  name: string;
  path: string;
}

export interface FileChange {
  path: string;
  originalPath: string | null;
  staged: ChangeKind;
  unstaged: ChangeKind;
  untracked: boolean;
  unmerged: boolean;
}

export interface BranchInfo {
  name: string | null;
  detached: boolean;
  unborn: boolean;
  headOid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  liveRemoteChecked: boolean;
  remoteCheckedAtMs: number | null;
  remoteCheckStale: boolean;
}

export interface StatusSnapshot {
  generation: number;
  branch: BranchInfo;
  files: FileChange[];
}

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta" | "nonewline" | string;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  hunkIndex: number | null;
}

export interface DiffHunk {
  index: number;
  header: string;
  complete: boolean;
  stageable: boolean;
  startLine: number;
  lineCount: number;
}

export interface DiffResponse {
  generation: number;
  path: string;
  staged: boolean;
  binary: boolean;
  text: string | null;
  summary: string;
  additions: number;
  deletions: number;
  complete: boolean;
  truncated: boolean;
  snapshot: string;
  hunks: DiffHunk[];
  lines: DiffLine[];
  offset: number;
  totalLines: number;
}

export interface CommitResult {
  oid: string;
  generation: number;
  branch: string;
  summary: string;
  files: string[];
  pushed: boolean;
  snapshot: StatusSnapshot;
}

export interface OpenedRepository {
  summary: RepoSummary;
  generation: number;
  snapshot: StatusSnapshot;
  draft: string;
  watchDegraded: boolean;
}

export interface PanelWidths {
  sidebar: number;
  files: number;
}

export interface SettingsDto {
  theme: Theme;
  panelWidths: PanelWidths;
  git: GitInfo;
  recent: RecentRepo[];
  settingsWarning: string | null;
}

export interface RepoChanged {
  path: string;
  generation: number;
  degraded: boolean;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string | null;
}

export interface RemoteState {
  generation: number;
  remotes: RemoteInfo[];
  snapshot: StatusSnapshot;
}

export interface BranchRecord {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  worktree: string | null;
}

export interface BranchState {
  generation: number;
  branches: BranchRecord[];
  snapshot: StatusSnapshot;
}

export interface CloneResult {
  path: string;
  opened: OpenedRepository;
}

export interface CommitPushReport {
  committed: boolean;
  pushed: boolean;
  retryPush: boolean;
  oid: string;
  branch: string;
  summary: string;
  pushError: string | null;
  generation: number;
  snapshot: StatusSnapshot;
}

export interface AppFailure {
  code: string;
  message: string;
  generation?: number;
}

export type DiffSide = "staged" | "unstaged";

export interface FileSelection {
  path: string;
  side: DiffSide;
}

export interface FileRow extends FileChange {
  side: DiffSide;
}

export interface HistoryLabel {
  name: string;
  kind: string;
  current: boolean;
}

export interface HistoryCommit {
  oid: string;
  parents: string[];
  summary: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  labels: HistoryLabel[];
}

export interface HistoryPage {
  generation: number;
  query: string;
  offset: number;
  pageSize: number;
  hasMore: boolean;
  state: string;
  commits: HistoryCommit[];
}

export interface CommitFileChange {
  path: string;
  originalPath: string | null;
  status: string;
}

export interface CommitDetail {
  generation: number;
  commit: HistoryCommit;
  body: string;
  root: boolean;
  merge: boolean;
  selectedParent: string | null;
  files: CommitFileChange[];
}

export interface FileHistoryPage {
  generation: number;
  path: string;
  offset: number;
  pageSize: number;
  hasMore: boolean;
  state: string;
  commits: HistoryCommit[];
}

export interface StashPreview {
  trackedCount: number;
  untrackedCount: number;
  ignoredCount: number;
  trackedPaths: string[];
  untrackedPaths: string[];
  ignoredPaths: string[];
  includeUntracked: boolean;
  canSave: boolean;
  summary: string;
}

export interface StashRecord {
  oid: string;
  message: string;
  committedAt: number;
}

export interface StashState {
  generation: number;
  preview: StashPreview;
  records: StashRecord[];
  snapshot: StatusSnapshot;
}

export interface StashSaveResult {
  oid: string;
  note: string;
  state: StashState;
}

export interface StashApplyResult {
  generation: number;
  oid: string;
  kept: boolean;
  operation: string;
  conflicted: boolean;
  conflictPaths: string[];
  canAbortMerge: boolean;
  note: string;
  snapshot: StatusSnapshot;
}

export interface MergePreview {
  generation: number;
  source: string;
  target: string;
  headOid: string | null;
  dirty: boolean;
  localPaths: string[];
  canStart: boolean;
  operation: string;
  note: string;
}

export interface ConflictEntry {
  path: string;
  kind: string;
  summary: string;
}

export interface MergeSession {
  generation: number;
  operation: string;
  canContinue: boolean;
  canAbort: boolean;
  source: string | null;
  target: string | null;
  headOid: string | null;
  conflicts: ConflictEntry[];
  unresolved: number;
  note: string;
  snapshot: StatusSnapshot;
}

export interface ConflictSide {
  present: boolean;
  binary: boolean;
  truncated: boolean;
  text: string | null;
  summary: string;
}

export interface ConflictView {
  generation: number;
  path: string;
  kind: string;
  editable: boolean;
  ours: ConflictSide;
  theirs: ConflictSide;
  result: ConflictSide;
  note: string;
}

export interface MergeComplete {
  oid: string;
  generation: number;
  summary: string;
  files: string[];
  snapshot: StatusSnapshot;
}

export interface AbortImpact {
  generation: number;
  wrote: boolean;
  paths: string[];
  stashOids: string[];
  note: string;
  snapshot: StatusSnapshot;
}

export interface UndoResult {
  generation: number;
  code: string;
  eligible: boolean;
  wrote: boolean;
  headOid: string;
  parentOid: string | null;
  summary: string;
  reason: string;
  snapshot: StatusSnapshot;
}

export interface DiscardFilePlan {
  path: string;
  originalPath: string | null;
  staged: ChangeKind;
  unstaged: ChangeKind;
  untracked: boolean;
  impact: string;
  recovery: string;
}

export interface DiscardResult {
  generation: number;
  wrote: boolean;
  files: DiscardFilePlan[];
  boundary: string;
  snapshot: StatusSnapshot;
}
