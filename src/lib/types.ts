export type Theme = "light" | "dark" | "system";
/** 分叉拉取预选的方式。旧设置没有这项时按合并。 */
export type PullIntegration = "merge" | "rebase";
/** 主视图只有两个：改动与提交历史。临时保存、合并等低频任务进 modal 槽位。 */
export type WorkspaceView = "changes" | "history";
/** 单槽 modal 的七个任务入口（data-task-modal 的取值集合就由它决定）。 */
export type TaskModal = "stash" | "merge" | "branch" | "remote" | "settings" | "scope" | "publish";

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

/** 文本文件的新增与删除行数。两个计数都是 null 时表示二进制，不能显示成 +0 −0。 */
export interface LineStat {
  additions: number | null;
  deletions: number | null;
}

export interface FileChange {
  path: string;
  originalPath: string | null;
  staged: ChangeKind;
  unstaged: ChangeKind;
  untracked: boolean;
  unmerged: boolean;
  /** 已暂存一侧。没有这一侧的变化、或行数尚未读到时缺省。 */
  stagedLines?: LineStat | null;
  /** 未暂存一侧。未跟踪文本文件的新增行数是当前行数。 */
  unstagedLines?: LineStat | null;
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
  /** 旧响应可能缺省；外壳按 merge 处理。 */
  pullIntegration?: PullIntegration;
  /** 旧响应可能缺省；外壳按开启处理。 */
  branchGroups?: boolean;
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
  targetOid?: string | null;
}

export interface BranchState {
  generation: number;
  branches: BranchRecord[];
  snapshot: StatusSnapshot;
}

export interface TagRecord {
  name: string;
  targetOid: string;
  message: string;
  createdAt: number;
}

/** 远程上的标签；oid 已解引用，可直接与 TagRecord.targetOid 比较。 */
export interface RemoteTag {
  name: string;
  oid: string;
}

export interface TagState {
  generation: number;
  tags: TagRecord[];
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
  /** 文本文件的新增与删除行数。未知时缺省，二进制不填计数。 */
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
}

export interface IgnoreOutcome {
  snapshot: StatusSnapshot;
  note: string;
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
  /** 当前所在分支；目标不是它时开始合并会先切换。 */
  current: string | null;
  needsSwitch: boolean;
  /** 来源有、目标没有的提交数（合并会带入）。 */
  incoming: number;
  /** 目标有、来源没有的提交数；为 0 时可以快进。 */
  outgoing: number;
  upToDate: boolean;
  fastForward: boolean;
  commits: HistoryCommit[];
  files: CommitFileChange[];
  filesTotal: number;
  /** clean / conflicts / unknown */
  conflictCheck: string;
  conflictPaths: string[];
  /** dirty / operation / detached / same / remote_target / up_to_date */
  blocker: string | null;
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
  /** 开始前从哪个分支切换过来（目标不是原当前分支时）。 */
  switchedFrom?: string | null;
  /** 以快进方式完成，没有创建合并提交。 */
  fastForwarded?: boolean;
  /** 变基已完成，没有推送。 */
  rebased?: boolean;
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
