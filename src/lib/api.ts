import { normalizeError } from "./errors";
import type {
  BranchState,
  BranchListing,
  PreviewSource,
  FilePreview,
  CloneResult,
  CommitBranches,
  CommitDetail,
  CommitPushReport,
  CommitResult,
  DiffResponse,
  FileHistoryPage,
  GitInfo,
  CherryPickOutcome,
  HistoryPage,
  IgnoreOutcome,
  OpenedRepository,
  PanelWidths,
  RecentRepo,
  RepoHead,
  RemoteState,
  RemoteTag,
  SettingsDto,
  AbortImpact,
  ConflictView,
  DiscardResult,
  MergeComplete,
  MergePreview,
  MergeSession,
  StashApplyResult,
  StashSaveResult,
  StashState,
  StatusSnapshot,
  TagState,
  Theme,
  PullIntegration,
  UndoResult,
} from "./types";

/** 历史筛选。缺省字段不传，后端按当前分支、无作者、无日期、无路径处理。 */
export interface HistoryFilters {
  scope?: string;
  author?: string;
  since?: number;
  until?: number;
  path?: string;
  query?: string;
}

function historyFilterPayload(filters: HistoryFilters | undefined, fileHistory: boolean): Record<string, unknown> {
  if (!filters) return {};
  const payload: Record<string, unknown> = {};
  if (filters.scope) payload.scope = filters.scope;
  if (filters.author) payload.author = filters.author;
  if (filters.since != null) payload.since = filters.since;
  if (filters.until != null) payload.until = filters.until;
  if (!fileHistory && filters.path) payload.pathFilter = filters.path;
  if (fileHistory && filters.query) payload.query = filters.query;
  return payload;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  try {
    return await call<T>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function listenEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(name, (event) => handler(event.payload));
}

export async function pickDirectory(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

export async function pickFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

export const api = {
  detectGit: () => invoke<GitInfo>("detect_git"),
  setGitExecutable: (path: string) => invoke<GitInfo>("set_git_executable", { path }),
  clearGitExecutable: () => invoke<GitInfo>("clear_git_executable"),
  getSettings: () => invoke<SettingsDto>("get_settings"),
  addRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("add_repository", { path, requestId }),
  createRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("create_repository", { path, requestId }),
  openRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("open_repository", { path, requestId }),
  closeRepository: () => invoke<void>("close_repository"),
  forgetRecent: (path: string) => invoke<RecentRepo[]>("forget_recent", { path }),
  /** 直接读各仓库 HEAD 文件得到当前检出的分支，不启动 Git。 */
  repoHeads: (paths: string[]) => invoke<RepoHead[]>("repo_heads", { paths }),
  refreshStatus: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("refresh_status", { path, generation, requestId }),
  loadDiff: (
    path: string,
    relative: string,
    staged: boolean,
    generation: number,
    requestId: number,
    original: string | null = null,
    offset = 0,
    limit = 0,
    /** 上下文行数；不传时后端用 3 行。「查看完整文件」传 FULL_FILE_CONTEXT。 */
    context?: number,
  ) =>
    invoke<DiffResponse>("load_diff", {
      path,
      relative,
      original,
      staged,
      generation,
      requestId,
      offset,
      limit,
      ...(context === undefined ? {} : { context }),
    }),
  stageFiles: (path: string, paths: string[], generation: number, requestId: number) =>
    invoke<StatusSnapshot>("stage_files", { path, paths, generation, requestId }),
  unstageFiles: (path: string, paths: string[], generation: number, requestId: number) =>
    invoke<StatusSnapshot>("unstage_files", { path, paths, generation, requestId }),
  stageHunks: (
    path: string,
    relative: string,
    staged: boolean,
    hunks: number[],
    snapshot: string,
    generation: number,
    requestId: number,
    original: string | null = null,
  ) =>
    invoke<StatusSnapshot>("stage_hunks", {
      path,
      relative,
      original,
      staged,
      hunks,
      snapshot,
      generation,
      requestId,
    }),
  commitChanges: (path: string, message: string, generation: number, requestId: number) =>
    invoke<CommitResult>("commit_changes", { path, message, generation, requestId }),
  cloneRepository: (url: string, parent: string, name: string, requestId: number) =>
    invoke<CloneResult>("clone_repository", { url, parent, name, requestId }),
  remoteState: (path: string, generation: number, requestId: number) =>
    invoke<RemoteState>("remote_state", { path, generation, requestId }),
  addRemote: (path: string, name: string, url: string, generation: number, requestId: number) =>
    invoke<RemoteState>("add_remote", { path, name, url, generation, requestId }),
  setRemoteUrl: (path: string, name: string, url: string, generation: number, requestId: number) =>
    invoke<RemoteState>("set_remote_url", { path, name, url, generation, requestId }),
  fetchRemote: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("fetch_remote", { path, generation, requestId }),
  pullFastForward: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("pull_fast_forward", { path, generation, requestId }),
  pushBranch: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("push_branch", { path, generation, requestId }),
  /** 推送当前分支到指定远程的同名分支：不强推，不改上游。 */
  pushToRemote: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("push_to_remote", { path, remote, generation, requestId }),
  /** 停止这个仓库正在进行的远程操作（推送、获取、删除远程分支）。 */
  cancelRemote: (path: string) => invoke<void>("cancel_remote", { path }),
  publishBranch: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("publish_branch", { path, remote, generation, requestId }),
  associateUpstream: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("associate_upstream", { path, remote, generation, requestId }),
  commitAndPush: (path: string, message: string, generation: number, requestId: number) =>
    invoke<CommitPushReport>("commit_and_push", { path, message, generation, requestId }),
  filePreview: (path: string, source: PreviewSource, generation: number, download = false) =>
    invoke<FilePreview>("file_preview", { path, source, generation, download }),
  branchList: (path: string, generation: number, requestId: number) =>
    invoke<BranchListing>("branch_list", { path, generation, requestId }),
  branchState: (path: string, generation: number, requestId: number) =>
    invoke<BranchState>("branch_state", { path, generation, requestId }),
  createBranch: (path: string, name: string, generation: number, requestId: number) =>
    invoke<BranchState>("create_branch", { path, name, generation, requestId }),
  /** 从指定起点（分支名或提交标识）创建分支，checkout 为 true 时创建后立即切换。 */
  createBranchFrom: (
    path: string,
    name: string,
    start: string,
    checkout: boolean,
    generation: number,
    requestId: number,
  ) => invoke<BranchState>("create_branch_from", { path, name, start, checkout, generation, requestId }),
  renameBranch: (path: string, oldName: string, newName: string, generation: number, requestId: number) =>
    invoke<BranchState>("rename_branch", { path, old: oldName, new: newName, generation, requestId }),
  /** 在系统文件管理器里显示仓库内的文件（relative 为空时显示仓库根目录）。 */
  revealPath: (path: string, relative: string) => invoke<void>("reveal_path", { path, relative }),
  /** 用系统默认程序打开仓库内的文件。 */
  openPath: (path: string, relative: string) => invoke<void>("open_path", { path, relative }),
  /** 把一条规则追加到 .gitignore，或只写入本地 info/exclude。local 为 true 时不进入提交。 */
  ignorePath: (path: string, pattern: string, local: boolean, generation: number, requestId: number) =>
    invoke<IgnoreOutcome>("ignore_path", { path, pattern, local, generation, requestId }),
  switchBranch: (path: string, name: string, generation: number, requestId: number) =>
    invoke<BranchState>("switch_branch", { path, name, generation, requestId }),
  /** 远程分支的短名已被占用时，以新名称检出并跟踪它。 */
  trackRemoteAs: (path: string, remoteBranch: string, local: string, generation: number, requestId: number) =>
    invoke<BranchState>("track_remote_as", { path, remoteBranch, local, generation, requestId }),
  deleteBranch: (
    path: string,
    name: string,
    confirmUnmerged: boolean,
    generation: number,
    requestId: number,
  ) =>
    invoke<BranchState>("delete_branch", {
      path,
      name,
      confirmUnmerged,
      generation,
      requestId,
    }),
  deleteRemoteBranch: (
    path: string,
    remote: string,
    name: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ) =>
    invoke<BranchState>("delete_remote_branch", {
      path,
      remote,
      name,
      confirm,
      generation,
      requestId,
    }),
  tagState: (path: string, generation: number, requestId: number) =>
    invoke<TagState>("tag_state", { path, generation, requestId }),
  /** 只读查询远程标签：不校验也不推进 generation，过期响应由调用方丢弃。 */
  tagRemoteState: (path: string, remote: string) => invoke<RemoteTag[]>("tag_remote_state", { path, remote }),
  createTag: (path: string, name: string, target: string, message: string, generation: number, requestId: number) =>
    invoke<TagState>("create_tag", { path, name, target, message, generation, requestId }),
  deleteTag: (path: string, name: string, confirm: boolean, generation: number, requestId: number) =>
    invoke<TagState>("delete_tag", { path, name, confirm, generation, requestId }),
  pushTag: (path: string, remote: string, name: string, generation: number, requestId: number) =>
    invoke<TagState>("push_tag", { path, remote, name, generation, requestId }),
  historyPage: (
    path: string,
    query: string,
    offset: number,
    generation: number,
    requestId: number,
    filters?: HistoryFilters,
  ) =>
    invoke<HistoryPage>("history_page", {
      path,
      query,
      offset,
      generation,
      requestId,
      ...historyFilterPayload(filters, false),
    }),
  commitDetail: (
    path: string,
    oid: string,
    parent: string | null,
    generation: number,
    requestId: number,
  ) => invoke<CommitDetail>("commit_detail", { path, oid, parent, generation, requestId }),
  commitFileDiff: (
    path: string,
    oid: string,
    parent: string | null,
    relative: string,
    generation: number,
    requestId: number,
    offset = 0,
    limit = 0,
  ) =>
    invoke<DiffResponse>("commit_file_diff", {
      path,
      oid,
      parent,
      relative,
      generation,
      requestId,
      offset,
      limit,
    }),
  /** 任意两个提交之间某个文件的差异（合并预览：共同祖先 → 来源顶端）。 */
  compareFileDiff: (
    path: string,
    base: string,
    head: string,
    relative: string,
    generation: number,
    requestId: number,
    offset = 0,
    limit = 0,
  ) => invoke<DiffResponse>("compare_file_diff", { path, base, head, relative, generation, requestId, offset, limit }),
  /** 包含这个提交的本地与远程分支。 */
  commitBranches: (path: string, oid: string, generation: number, requestId: number) =>
    invoke<CommitBranches>("commit_branches", { path, oid, generation, requestId }),
  fileHistory: (
    path: string,
    relative: string,
    offset: number,
    generation: number,
    requestId: number,
    filters?: HistoryFilters,
  ) =>
    invoke<FileHistoryPage>("file_history", {
      path,
      relative,
      offset,
      generation,
      requestId,
      ...historyFilterPayload(filters, true),
    }),
  cherryPickCommits: (path: string, oids: string[], generation: number, requestId: number) =>
    invoke<CherryPickOutcome>("cherry_pick_commits", { path, oids, generation, requestId }),
  checkoutCommit: (path: string, oid: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("checkout_commit", { path, oid, generation, requestId }),
  stashState: (path: string, includeUntracked: boolean, generation: number, requestId: number) =>
    invoke<StashState>("stash_state", { path, includeUntracked, generation, requestId }),
  saveStash: (
    path: string,
    includeUntracked: boolean,
    message: string,
    generation: number,
    requestId: number,
  ) =>
    invoke<StashSaveResult>("save_stash", {
      path,
      includeUntracked,
      message,
      generation,
      requestId,
    }),
  applyStash: (path: string, oid: string, generation: number, requestId: number) =>
    invoke<StashApplyResult>("apply_stash", { path, oid, generation, requestId }),
  deleteStash: (path: string, oid: string, confirm: boolean, generation: number, requestId: number) =>
    invoke<StashState>("delete_stash", { path, oid, confirm, generation, requestId }),
  /** 只读预览：target 为空时合并到当前分支。 */
  mergePreview: (path: string, source: string, target: string | null, generation: number, requestId: number) =>
    invoke<MergePreview>("merge_preview", { path, source, target, generation, requestId }),
  /**
   * target 不是当前分支时，合并会先切换过去。
   * mode 为 merge（创建合并提交）、ff-only（快进）或 rebase（把当前分支接到基底上，不推送）。
   */
  startMerge: (
    path: string,
    source: string,
    target: string | null,
    mode: "merge" | "ff-only" | "rebase",
    generation: number,
    requestId: number,
  ) => invoke<MergeSession>("start_merge", { path, source, target, mode, generation, requestId }),
  mergeSession: (path: string, generation: number, requestId: number) =>
    invoke<MergeSession>("merge_session", { path, generation, requestId }),
  conflictView: (path: string, relative: string, generation: number, requestId: number) =>
    invoke<ConflictView>("conflict_view", { path, relative, generation, requestId }),
  resolveConflict: (
    path: string,
    relative: string,
    choice: string,
    content: string | null,
    generation: number,
    requestId: number,
  ) =>
    invoke<MergeSession>("resolve_conflict", {
      path,
      relative,
      choice,
      content,
      generation,
      requestId,
    }),
  completeMerge: (path: string, message: string, generation: number, requestId: number) =>
    invoke<MergeComplete>("complete_merge", { path, message, generation, requestId }),
  abortMerge: (path: string, confirm: boolean, generation: number, requestId: number) =>
    invoke<AbortImpact>("abort_merge", { path, confirm, generation, requestId }),
  undoCommit: (path: string, expectedHead: string, confirm: boolean, generation: number, requestId: number) =>
    invoke<UndoResult>("undo_commit", { path, expectedHead, confirm, generation, requestId }),
  discardChanges: (path: string, paths: string[], confirm: boolean, generation: number, requestId: number) =>
    invoke<DiscardResult>("discard_changes", { path, paths, confirm, generation, requestId }),
  setTheme: (theme: Theme) => invoke<void>("set_theme", { theme }),
  setPullIntegration: (pullIntegration: PullIntegration) =>
    invoke<void>("set_pull_integration", { pullIntegration }),
  setBranchGroups: (branchGroups: boolean) => invoke<void>("set_branch_groups", { branchGroups }),
  setPanelWidths: (widths: PanelWidths) => invoke<PanelWidths>("set_panel_widths", { widths }),
  saveDraft: (path: string, message: string) => invoke<void>("save_draft", { path, message }),
  cancelReads: () => invoke<void>("cancel_reads"),
  measureProbe: () =>
    invoke<{ enabled: boolean; elapsedMs: number; script: { steps?: unknown[] } | null }>("measure_probe"),
  measureSample: (name: string, detail: Record<string, unknown>) =>
    invoke<void>("measure_sample", { name, detail }),
  measureFinish: () => invoke<void>("measure_finish"),
  measureWait: (ms: number) => invoke<void>("measure_wait", { ms }),
};
