export type Theme = "light" | "dark" | "system";
/** 分叉拉取预选的方式。旧设置没有这项时按合并。 */
export type PullIntegration = "merge" | "rebase";
/**
 * 主视图三个：改动、文件、提交历史。三者同时保活，切换不重挂组件；
 * 临时保存、合并等低频任务进 modal 槽位。
 */
export type WorkspaceView = "task" | "changes" | "files" | "history";
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
  /** 二进制改动前后的字节数：新增时没有 oldSize，删除时没有 newSize，读不到时都缺省。 */
  oldSize?: number | null;
  newSize?: number | null;
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
  /**
   * 任务净结果里这一行是「工作区重建」：起点里本来有这条路径，现在工作区里是未跟踪的同名文件。
   * 行数只统计重建后的文件，不能当作纯新增，界面必须标出这层语义。
   */
  rebuilt?: boolean;
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

/**
 * 选中的差异行身份：hunkIndex + kind + oldNo + newNo。统一与并排视图共用同一份，
 * 上下文行、块标题、meta 与「没有换行」标记不可选。
 */
export interface DiffLineSelection {
  hunkIndex: number;
  kind: "add" | "del";
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  index: number;
  header: string;
  complete: boolean;
  stageable: boolean;
  startLine: number;
  lineCount: number;
}

export interface PreviewSource { revision: string; path: string }
export interface PreviewSources { repository: string; old: PreviewSource | null; new: PreviewSource | null }
/** HEAD is returned as a fixed commit OID. Reuse index snapshot for all linked reads;
 * a changed index rejects the session as stale instead of silently switching versions.
 * `repository` is the root the source was read from: the backend rejects a source whose
 * repository differs from the root passed to `repositoryDocument`/`documentResource`, so a
 * source left over from a previous repository cannot relabel a same-named file in the new one.
 * It stays optional because diff/history sides only carry `revision` + `path`; reads bind it. */
export interface DocumentSource extends PreviewSource { snapshot?: string | null; repository?: string | null }
export interface RepositoryDocument {
  generation: number;
  source: DocumentSource;
  kind: RepositoryFileKind | "tooLarge";
  size: number;
  /** Pass this as expectedVersion for subsequent pages; a mismatch rejects as stale. */
  version: string | null;
  /** Original UTF-8 document, including line endings; only complete=true is renderable. */
  text: string | null;
  complete: boolean;
  offset: number;
  lines: string[];
  nextOffset: number;
  hasMore: boolean;
  truncated: boolean;
  message: string | null;
}
export interface FilePreview {
  generation: number;
  kind: "missing" | "unsupported" | "error" | "image" | "archive" | "lfs";
  size: number | null;
  dataUrl: string | null;
  entries: { name: string; size: number; directory: boolean }[];
  truncated: boolean;
  message: string;
  lfsOid: string | null;
  canDownload: boolean;
}

export type RepositoryEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "special"
  | "nestedRepository"
  | "error";

export interface RepositoryDirectoryEntry {
  name: string;
  path: string;
  kind: RepositoryEntryKind;
  ignored: boolean;
  size: number | null;
  /** 元数据版本；旧后端或无法读取修改时间时为空。 */
  version?: string | null;
  error: string | null;
}

export interface RepositoryDirectory {
  generation: number;
  path: string;
  entries: RepositoryDirectoryEntry[];
  errors: string[];
}

export type RepositoryFileKind =
  | "text"
  | "resource"
  | "binary"
  | "invalidUtf8"
  | "missing"
  | "special";

export interface RepositoryFileContent {
  generation: number;
  path: string;
  kind: RepositoryFileKind;
  size: number;
  version?: string | null;
  offset: number;
  lines: string[];
  nextOffset: number;
  hasMore: boolean;
  truncated: boolean;
  message: string | null;
}

/** 路径搜索的结果类型：文件来自 Git 路径集合，目录由文件祖先派生。 */
export type RepositoryPathKind = "file" | "directory";

export interface RepositoryPathEntry {
  path: string;
  kind: RepositoryPathKind;
  ignored: boolean;
}

export interface RepositoryPathSearch {
  generation: number;
  query: string;
  directory: string | null;
  includeIgnored: boolean;
  /** 参与匹配的路径条数（含派生目录）：用来区分"没有匹配"与"没有枚举到路径"。 */
  scanned: number;
  entries: RepositoryPathEntry[];
  /** 枚举被输出上限截断，或匹配数超过本次 limit。 */
  truncated: boolean;
  message: string | null;
}

/** 内容搜索范围：全仓、某个目录、单个文件，或当前改动的路径集合。 */
export type RepositorySearchScope =
  | { kind: "repository" }
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string }
  | { kind: "changed" };

export type RepositorySkipReason =
  | "binary"
  | "invalidUtf8"
  | "unsupported"
  | "symlink"
  | "special"
  | "nestedRepository"
  | "tooLarge"
  | "missing"
  | "unreadable";

export interface RepositorySearchSkip {
  path: string;
  reason: RepositorySkipReason;
}

export interface RepositoryContentMatch {
  path: string;
  /** 1 起算的行号。 */
  line: number;
  /** 1 起算的列号，按 Unicode 字符计数。 */
  column: number;
  text: string;
}

export interface RepositoryContentSearch {
  generation: number;
  query: string;
  scope: "repository" | "directory" | "file" | "changed";
  scopePath: string | null;
  matches: RepositoryContentMatch[];
  /** 真正读到并完整解码的文件数，不含被跳过的文件。 */
  filesScanned: number;
  /** 被跳过文件的原因明细（有界）；完整数量见 skippedFiles。 */
  skipped: RepositorySearchSkip[];
  skippedFiles: number;
  /** 达到结果数/文件数/读取上限，或路径枚举被截断：不能当作完整结果。 */
  truncated: boolean;
  /** 匹配行的展示文本被截短过；行号与列号仍然准确。 */
  textTruncated: boolean;
  message: string | null;
}

/**
 * 单个改动路径的整文件快照状态。只有 current 带 token：其余状态表示这条路径现在没有改动、
 * 工作区里已经没有它，或内容无法确认，界面不能据此标记已审阅。
 */
export type RepositoryReviewState = "current" | "unchanged" | "missing" | "unconfirmed";

export interface RepositoryReviewToken {
  generation: number;
  path: string;
  state: RepositoryReviewState;
  /** 仅 state 为 current 时有值。 */
  token: string | null;
  staged: ChangeKind;
  unstaged: ChangeKind;
  untracked: boolean;
  unmerged: boolean;
  /** 工作区内容版本（Git 对象 id 或 missing），用来说明 token 依据了哪份内容。 */
  contentVersion: string | null;
  message: string;
}

/**
 * 任务范围内一条路径的最终净状态：起点到工作区的净差异，后端已合并后续提交、暂存、
 * 未暂存改动与未跟踪文件。status 与 CommitFileChange 用同一套名称。
 */
export interface TaskFileChange {
  path: string;
  originalPath: string | null;
  /** added / modified / deleted / renamed / copied / typeChanged / unmerged / unknown */
  status: string;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
  /** 二进制改动前后的字节数：改动前取自起点里的版本，改动后取自工作区。 */
  oldSize?: number | null;
  newSize?: number | null;
  /** 起点里没有这条路径：来自未跟踪文件。 */
  untracked?: boolean;
  unmerged?: boolean;
  /**
   * 起点里有这条路径、但工作区里现在是未跟踪的同名文件（删除后重建）。
   * 行数只统计重建后的内容，界面上标为「工作区重建」而不是纯新增。
   */
  rebuilt?: boolean;
}

/** 一次只读任务读取的结果：只有完整读取成功才返回，空任务用 empty 表示。 */
export interface TaskReview {
  generation: number;
  /** canonical worktree 路径：范围身份的一部分。 */
  worktree: string;
  /** 用户给出的起点写法，只用于显示。 */
  baselineRef: string;
  /** 校验过的完整起点提交标识；后续读取原样带回。 */
  baselineOid: string;
  /** 读取时的 HEAD 完整提交标识；后续读取原样带回。 */
  headOid: string;
  branch: BranchInfo;
  /** 范围内提交的第一页，新的在前。 */
  commits: HistoryCommit[];
  commitCount: number;
  commitsTruncated: boolean;
  files: TaskFileChange[];
  filesTotal: number;
  filesTruncated: boolean;
  additions: number;
  deletions: number;
  /** 索引、工作区或未跟踪文件里还有未提交改动。 */
  dirty: boolean;
  untrackedFiles: number;
  conflicted: boolean;
  /** 起点之后没有任何提交，也没有净改动；读取失败不会走到这里。 */
  empty: boolean;
  /** 范围版本：绑定 worktree、起点、HEAD 与未提交状态的形状。 */
  rangeVersion: string;
  message: string;
}

/**
 * 任务页的起点请求：start 由用户显式选择，cliora 来自已校验的审查链接。
 * 没有 baseline 时不建立任务范围——不会退回当前 HEAD 或默认分支。
 */
export interface TaskRequest {
  baseline: string;
  origin: "cliora" | "manual";
  /** 每次进入任务页递增：同一个起点也要重新读取一次。 */
  nonce: number;
}

/** 单条任务路径的快照确认：只有 current 带 token，其余状态保持未审阅。 */
export interface TaskReviewToken {
  generation: number;
  path: string;
  baselineOid: string;
  state: RepositoryReviewState;
  /** 仅 state 为 current 时有值。 */
  token: string | null;
  status: string;
  untracked: boolean;
  unmerged: boolean;
  /** 起点里这条路径的版本；起点没有它时为 absent。 */
  baselineVersion: string | null;
  /** 工作区内容版本（worktree:<oid> 或 missing）。 */
  contentVersion: string | null;
  /** 这条路径的净差异超过预览上限：只读到一部分，不能标记。 */
  truncated: boolean;
  message: string;
}

export interface DiffResponse {
  preview?: PreviewSources;
  /** Explicit Markdown sides; independent of binary resource preview rendering. */
  document?: PreviewSources;
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
  /** 二进制改动前后的字节数，与 LineStat 同义。 */
  oldSize?: number | null;
  newSize?: number | null;
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
  /** 提交缩写长度（Git 的 core.abbrev / 自动长度）。旧响应可能缺省，按 7 位处理。 */
  abbrevLength?: number;
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
  /** 左栏是否显示「文件」视图；旧响应缺省时按显示处理。 */
  filesView?: boolean;
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
  /** 已完整包含在主干里（本地默认分支和它的远程对应分支都包含），删除不会丢提交。主干自己不标记。 */
  merged?: boolean;
}

export interface BranchListing {
  generation: number;
  branches: BranchRecord[];
  defaultBranch?: string | null;
  mergeBases?: string[];
}

export interface BranchState {
  generation: number;
  branches: BranchRecord[];
  snapshot: StatusSnapshot;
  /** 分支刷新时算好的默认分支。没有符合判定的分支时缺省或为 null。 */
  defaultBranch?: string | null;
  /** 判定 merged 用到的主干分支，例如 ["master", "origin/master"]。 */
  mergeBases?: string[];
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
  /** 用用户名密码克隆时，凭据是否已交给凭据助手保存的说明。 */
  credentialNote?: string | null;
}

/** HTTP(S) 克隆用的一次性凭据；不进入应用数据。 */
export interface HttpCredential {
  username: string;
  password: string;
  /** 克隆成功后交给系统凭据助手保存。 */
  remember: boolean;
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
  /** ok、empty_repository、empty_branch、no_match。 */
  state: string;
  commits: HistoryCommit[];
  /** current、all，或本地分支名。 */
  scope: string;
  branches: string[];
  head: string | null;
}

export interface CommitFileChange {
  path: string;
  originalPath: string | null;
  status: string;
  /** 文本文件的新增与删除行数。未知时缺省，二进制不填计数。 */
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
  /** 二进制改动前后的字节数。 */
  oldSize?: number | null;
  newSize?: number | null;
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
  /** ok、empty_repository、no_file_history、no_match。 */
  state: string;
  commits: HistoryCommit[];
  scope: string;
  branches: string[];
  head: string | null;
}

export interface CherryPickOutcome {
  generation: number;
  conflicted: boolean;
  skipped: string[];
  note: string;
  snapshot: StatusSnapshot;
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
  /** 目标与来源的共同祖先；查看单个文件带入了什么时作为比较起点。 */
  baseOid?: string | null;
  /** 来源分支顶端提交。 */
  sourceOid?: string | null;
}

export interface ContainingBranch {
  name: string;
  remote: boolean;
  current: boolean;
}

/** 包含某个提交的分支：这次提交在哪些分支上生效。 */
export interface CommitBranches {
  generation: number;
  oid: string;
  branches: ContainingBranch[];
  total: number;
  current: string | null;
}

/** 仓库当前检出的分支（直接读 HEAD 文件）。 */
/** worktree 总览的一项：每项自带状态来源与读取时间，缺失与未知分开表达（R3）。 */
export interface WorktreeItem {
  path: string;
  /** 所属主仓库的工作区路径；无法归属时为 null。 */
  mainPath: string | null;
  branch: string | null;
  detached: string | null;
  missing: boolean;
  /** 是 git worktree add 建出来的附属工作区。 */
  linked: boolean;
  locked: boolean;
  /** 这一项来自最近仓库列表；枚举出来的附属工作区可能不在其中。 */
  recent: boolean;
  /** 未提交状态读不到时为 null，界面显示未知而不是「干净」。 */
  dirty: boolean | null;
  changed: number | null;
  staged: number | null;
  unstaged: number | null;
  untracked: number | null;
  conflicted: number | null;
  /** 本地 upstream 及其计数；没有实时核对过远程时只代表本地记录。 */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  liveRemoteChecked: boolean;
  remoteCheckedAtMs: number | null;
  remoteCheckStale: boolean;
  status: "ready" | "unknown" | "missing";
  /** 该项的失败或限制说明；空字符串表示没有。 */
  note: string;
  checkedAtMs: number;
}

export interface WorktreeOverview {
  items: WorktreeItem[];
  checkedAtMs: number;
}

export interface RepoHead {
  path: string;
  branch: string | null;
  detached: string | null;
  missing: boolean;
  /** 是 `git worktree add` 建出来的附属工作区。 */
  worktree: boolean;
  /** 附属工作区所属主仓库的工作目录。 */
  mainPath: string | null;
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
  /** 这一侧的字节数；读取被截断时缺省。 */
  size?: number | null;
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
