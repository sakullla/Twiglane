import { recordClioraCommit, recordClioraMerge } from "./cliora-review.svelte";
import { normalizeError } from "./errors";
import type {
  BranchState,
  BranchListing,
  ClioraOutcome,
  ClioraReturnSent,
  DiffLineSelection,
  PreviewSource,
  DocumentSource,
  RepositoryDocument,
  FilePreview,
  CloneResult,
  HttpCredential,
  CommitBranches,
  CommitDetail,
  CompareFiles,
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
  RepositoryContentSearch,
  RepositoryDirectory,
  RepositoryEditSnapshot,
  RepositoryFileContent,
  RepositoryPathSearch,
  RepositoryReviewToken,
  RepositorySearchScope,
  RepoHead,
  WorktreeOverview,
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
  TaskReview,
  TaskReviewToken,
  TerminalActivity,
  TerminalSnapshot,
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

/** 当前应用版本号（tauri.conf.json 的 version）；浏览器/预览环境没有 Tauri 运行时，返回 null。 */
export async function appVersion(): Promise<string | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
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

/**
 * cliora v2 审查链接解析结果。协议校验在 Rust 侧完成，前端只按它打开准确的 worktree。
 * `worktreePath` 是后端校验过的绝对路径，不含任何凭据。
 */
export interface ClioraReviewRequest {
  reviewId: string;
  sessionId: string;
  worktreePath: string;
  baseline: string | null;
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
  /**
   * worktree 总览：从最近仓库解析主仓库、枚举附属工作区，再逐项读取真实状态。
   * 只读、不 fetch；单项失败只影响该项，结果自带 checkedAtMs。
   */
  worktreeOverview: (paths: string[], requestId: number) =>
    invoke<WorktreeOverview>("worktree_overview", { paths, requestId }),
  /** 删除附属工作区（git worktree remove），成功后返回移出该项的最近列表；分支保留。 */
  removeWorktree: (path: string, force: boolean, requestId: number) =>
    invoke<RecentRepo[]>("remove_worktree", { path, force, requestId }),
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
    /** 「按文本查看」：Git 判成二进制的文件也按文本读出，只读、不能按块暂存。 */
    asText?: boolean,
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
      ...(asText ? { asText } : {}),
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
  /** 逐行暂存 / 取消暂存：参数保持 camelCase，与 Rust 侧 stage_lines 一致。 */
  stageLines: (
    path: string,
    relative: string,
    staged: boolean,
    lines: DiffLineSelection[],
    snapshot: string,
    generation: number,
    requestId: number,
    original: string | null = null,
  ) =>
    invoke<StatusSnapshot>("stage_lines", {
      path,
      relative,
      original,
      staged,
      lines,
      snapshot,
      generation,
      requestId,
    }),
  /**
   * 提交成功后记录 cliora 审查结果：只有当前来源就是这条路径的工作树时才记录，
   * 独立仓库与失败、取消都不写结果。记录只是待复核声明，cliora 会重新读取 HEAD。
   */
  commitChanges: async (path: string, message: string, generation: number, requestId: number) => {
    const result = await invoke<CommitResult>("commit_changes", { path, message, generation, requestId });
    recordClioraCommit(path, result.oid);
    return result;
  },
  /**
   * 克隆。HTTP(S) 地址认证失败后可带上用户名和密码（或访问令牌）重试：
   * 后端只把它作为这一次 Git 进程的认证头，remember 为真时成功后交给系统凭据助手保存。
   */
  cloneRepository: (url: string, parent: string, name: string, requestId: number, credential: HttpCredential | null = null) =>
    invoke<CloneResult>("clone_repository", { url, parent, name, credential, requestId }),
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
  /** 把当前分支的上游改成任意远程跟踪分支（可以不同名）。只改配置，不推送。 */
  setUpstream: (path: string, upstream: string, generation: number, requestId: number) =>
    invoke<BranchState>("set_upstream", { path, upstream, generation, requestId }),
  /**
   * 提交并推送：只在 committed 为真时记录提交阶段的结果。推送失败不抹掉已完成的提交，
   * 也不声称推送成功。
   */
  commitAndPush: async (path: string, message: string, generation: number, requestId: number) => {
    const report = await invoke<CommitPushReport>("commit_and_push", { path, message, generation, requestId });
    if (report.committed && report.oid) recordClioraCommit(path, report.oid);
    return report;
  },
  filePreview: (path: string, source: PreviewSource, generation: number, download = false) =>
    invoke<FilePreview>("file_preview", { path, source, generation, download }),
  /** 只读文档正文：`source.repository` 必须与 `path` 指向同一个仓库，否则后端返回
   * `document_repository`，不会把新仓库里的同名文件按旧来源标注版本。首次读取时后端会把
   * 仓库根写回 `source.repository`，后续分页/资源读取应原样复用返回的来源。 */
  repositoryDocument: (
    path: string, source: DocumentSource, generation: number, requestId: number,
    mode: "document" | "source" = "document", offset = 0, limit?: number, expectedVersion: string | null = null,
  ) => invoke<RepositoryDocument>("repository_document", { path, source, generation, requestId, mode, offset, limit, expectedVersion }),
  /** 只读资源：与 `repositoryDocument` 相同的来源仓库校验，越仓来源返回 `document_repository`。 */
  documentResource: (path: string, source: DocumentSource, generation: number, requestId: number) =>
    invoke<FilePreview>("document_resource", { path, source, generation, requestId }),
  openDocumentUrl: (url: string) => invoke<void>("open_document_url", { url }),
  /** Explicit opt-in only; callers own requestId and cancel only their own image.
   * Remote images are not repository versions: the returned FilePreview.generation is
   * always 0, so accept/drop these results by requestId instead of generation. */
  documentRemoteImage: (url: string, requestId: number) => invoke<FilePreview>("document_remote_image", { url, requestId }),
  cancelDocumentResources: (requestId: number) => invoke<void>("cancel_document_resources", { requestId }),
  repositoryDirectory: (
    path: string,
    relative: string,
    includeIgnored: boolean,
    generation: number,
    requestId: number,
  ) =>
    invoke<RepositoryDirectory>("repository_directory", {
      path,
      relative,
      includeIgnored,
      generation,
      requestId,
    }),
  repositoryFileContent: (
    path: string,
    relative: string,
    offset: number,
    limit: number | undefined,
    generation: number,
    requestId: number,
  ) =>
    invoke<RepositoryFileContent>("repository_file_content", {
      path,
      relative,
      offset,
      limit,
      generation,
      requestId,
    }),
  /**
   * 轻量编辑读取：当前工作区普通文件的完整文本快照（内容摘要、BOM、统一行尾）。
   * 不适用时返回只读原因，不改变分页只读合同。
   */
  repositoryEditSnapshot: (path: string, relative: string, generation: number, requestId: number) =>
    invoke<RepositoryEditSnapshot>("repository_edit_snapshot", {
      path,
      relative,
      generation,
      requestId,
    }),
  /**
   * 轻量编辑保存：后端在写锁内复核 expectedDigest 与可编辑能力后原子替换目标文件。
   * 只改这一个工作区文件，不暂存、不提交；摘要不符返回 edit_conflict 且不写入。
   */
  repositoryEditSave: (
    path: string,
    relative: string,
    expectedDigest: string,
    content: string,
    generation: number,
    requestId: number,
  ) =>
    invoke<RepositoryEditSnapshot>("repository_edit_save", {
      path,
      relative,
      expectedDigest,
      content,
      generation,
      requestId,
    }),
  /** 按仓库相对路径查找文件与派生目录；directory 限定目录范围，includeIgnored 只影响本次请求。 */
  repositoryPathSearch: (
    path: string,
    query: string,
    directory: string | null,
    includeIgnored: boolean,
    limit: number | undefined,
    generation: number,
    requestId: number,
  ) =>
    invoke<RepositoryPathSearch>("repository_path_search", {
      path,
      query,
      directory,
      includeIgnored,
      limit,
      generation,
      requestId,
    }),
  /**
   * 单个改动路径的整文件审阅快照：只查这一条路径的状态、索引与内容版本，不做全仓 diff。
   * token 只在内容或状态变化时改变；state 不是 current 时前端保持未审阅。
   */
  repositoryReviewToken: (
    path: string,
    relative: string,
    generation: number,
    requestId: number,
  ) =>
    invoke<RepositoryReviewToken>("repository_review_token", {
      path,
      relative,
      generation,
      requestId,
    }),
  /**
   * 只读任务范围：显式起点经完整 OID 与 ancestry 校验后，返回起点..HEAD、索引、工作区
   * 与未跟踪文件合并后的最终净结果，同时给出范围内提交、HEAD、统计与范围版本。
   * 起点缺失、非祖先、worktree 缺失与读取失败各自是不同的错误，不返回空任务。
   */
  taskReview: (path: string, baseline: string, generation: number, requestId: number) =>
    invoke<TaskReview>("task_review", { path, baseline, generation, requestId }),
  /**
   * 单文件任务净差异：baseline 与 head 必须是任务快照返回的完整 OID，
   * 因此旧响应不会被贴到新仓库、新起点或新 HEAD 上。
   */
  loadTaskDiff: (
    path: string,
    baseline: string,
    head: string,
    relative: string,
    generation: number,
    requestId: number,
    original: string | null = null,
    offset = 0,
    limit = 0,
    /** 上下文行数；不传时后端用 3 行。 */
    context?: number,
    asText?: boolean,
  ) =>
    invoke<DiffResponse>("load_task_diff", {
      path,
      baseline,
      head,
      relative,
      original,
      generation,
      requestId,
      offset,
      limit,
      ...(context === undefined ? {} : { context }),
      ...(asText ? { asText } : {}),
    }),
  /**
   * 单条任务路径的整文件快照确认：token 绑定 worktree、起点与这条路径的最终净内容。
   * 差异被截断或内容无法确认时后端不给 token，前端保持未审阅。
   */
  taskReviewToken: (
    path: string,
    baseline: string,
    head: string,
    relative: string,
    generation: number,
    requestId: number,
  ) =>
    invoke<TaskReviewToken>("task_review_token", {
      path,
      baseline,
      head,
      relative,
      generation,
      requestId,
    }),
  /** 在工作区文本里逐行搜索固定字符串；范围由 scope 决定，changed 使用当前状态路径。 */
  repositoryContentSearch: (
    path: string,
    query: string,
    scope: RepositorySearchScope,
    includeIgnored: boolean,
    limit: number | undefined,
    generation: number,
    requestId: number,
  ) =>
    invoke<RepositoryContentSearch>("repository_content_search", {
      path,
      query,
      scope,
      includeIgnored,
      limit,
      generation,
      requestId,
    }),
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
    /** 上下文行数；不传时后端用 3 行。「查看完整文件」传 FULL_FILE_CONTEXT。 */
    context?: number,
    asText?: boolean,
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
      ...(context === undefined ? {} : { context }),
      ...(asText ? { asText } : {}),
    }),
  /**
   * 任意两个提交之间某个文件的差异（合并预览：共同祖先 → 来源顶端；历史多选：最早所选之前 → 最新所选）。
   * base 为空字符串时与空树比较。
   */
  compareFileDiff: (
    path: string,
    base: string,
    head: string,
    relative: string,
    generation: number,
    requestId: number,
    offset = 0,
    limit = 0,
    context?: number,
  ) =>
    invoke<DiffResponse>("compare_file_diff", {
      path,
      base,
      head,
      relative,
      generation,
      requestId,
      offset,
      limit,
      ...(context === undefined ? {} : { context }),
    }),
  /**
   * 两点之间的净文件清单：历史多选时只看这批提交合起来的最终结果。
   * base 为 null 时与空树比较（最早所选是首个提交）。
   */
  compareFiles: (path: string, base: string | null, head: string, generation: number, requestId: number) =>
    invoke<CompareFiles>("compare_files", { path, base, head, generation, requestId }),
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
  startMerge: async (
    path: string,
    source: string,
    target: string | null,
    mode: "merge" | "ff-only" | "rebase",
    generation: number,
    requestId: number,
  ) => {
    const session = await invoke<MergeSession>("start_merge", { path, source, target, mode, generation, requestId });
    // 只有快进或变基真正完成才算合入；留在冲突状态的结果不记录。
    if ((session.fastForwarded || session.rebased) && session.headOid) {
      recordClioraMerge(path, session.headOid);
    }
    return session;
  },
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
  completeMerge: async (path: string, message: string, generation: number, requestId: number) => {
    const done = await invoke<MergeComplete>("complete_merge", { path, message, generation, requestId });
    recordClioraMerge(path, done.oid);
    return done;
  },
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
  setFilesView: (filesView: boolean) => invoke<void>("set_files_view", { filesView }),
  setPanelWidths: (widths: PanelWidths) => invoke<PanelWidths>("set_panel_widths", { widths }),
  saveDraft: (path: string, message: string) => invoke<void>("save_draft", { path, message }),
  cancelReads: () => invoke<void>("cancel_reads"),
  /**
   * 按仓库打开或附着终端。同一仓库重复调用返回原 sessionId；已退出的会话保持退出状态，
   * 需要 restartTerminal 才会新建 shell。返回值里的 output/seq 用于重放。
   */
  openTerminal: (path: string) => invoke<TerminalSnapshot>("open_terminal", { path }),
  restartTerminal: (path: string) => invoke<TerminalSnapshot>("restart_terminal", { path }),
  /** 只向已有 sessionId 写入输入；终端已退出时后端返回 terminal_closed。 */
  terminalWrite: (sessionId: string, data: string) =>
    invoke<void>("terminal_write", { sessionId, data }),
  terminalResize: (sessionId: string, rows: number, cols: number) =>
    invoke<void>("terminal_resize", { sessionId, rows, cols }),
  /** 结束所有运行中的终端 shell 与后代进程；失败时返回真实错误。 */
  terminateTerminals: () => invoke<TerminalActivity[]>("terminate_terminals"),
  measureProbe: () =>
    invoke<{ enabled: boolean; elapsedMs: number; script: { steps?: unknown[] } | null }>("measure_probe"),
  measureSample: (name: string, detail: Record<string, unknown>) =>
    invoke<void>("measure_sample", { name, detail }),
  measureFinish: () => invoke<void>("measure_finish"),
  measureWait: (ms: number) => invoke<void>("measure_wait", { ms }),
  /** 当前安装方式是否支持应用内安装（仅 Linux 非 AppImage 为 false）。 */
  updateInstallSupported: () => invoke<boolean>("update_install_supported"),
  /** 解析并校验 cliora 的 v2 审查链接；失败时返回协议错误码，不做任何仓库操作。 */
  clioraReviewRequest: (url: string) => invoke<ClioraReviewRequest>("cliora_review_request", { url }),
  /** 回送接收结果。accepted 为假时 reason 必须是协议里的稳定错误码。 */
  clioraReviewReceipt: (
    reviewId: string,
    sessionId: string,
    accepted: boolean,
    reason: string | null = null,
  ) => invoke<void>("cliora_review_receipt", { reviewId, sessionId, accepted, reason }),
  /**
   * 回送 v2 返回事件。committed/merged 必须带完整 headOid；reviewed 不带。
   * worktreeState 由后端按审查来源工作树读取真实 Git 状态填写，结果里告诉前端实际发送的状态。
   * 返回本身不执行任何 Git 写入。
   */
  clioraReviewReturn: (
    reviewId: string,
    sessionId: string,
    outcome: ClioraOutcome,
    headOid: string | null = null,
  ) => invoke<ClioraReturnSent>("cliora_review_return", { reviewId, sessionId, outcome, headOid }),
};
