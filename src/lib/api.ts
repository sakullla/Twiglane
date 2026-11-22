import type { Projects, WorkspacePreview, WorkspaceManifest, WorkspaceCandidate, WorkspaceDiscovery } from "./workspaces";
import { captureClioraReview, recordClioraCommit, recordClioraMerge, type ClioraSourceSnapshot } from "./cliora-review.svelte";
import { normalizeError } from "./errors";
import {
  isRemoteRepositoryKey,
  parseRemotePatch,
  parseRemoteRepositoryKey,
  remoteChanges,
  remoteDiffDocument,
  remoteDiffPage,
  remoteRepositoryKey,
  remoteReviewPort,
  remoteReviewToken,
  remoteStatus,
  remoteWorktreePort,
  repositoryBaseName,
  type RemoteConnectionProgress,
  type RemoteDiffDocument,
  type RemoteDiffPage,
  type RemoteDiffView,
  type RemoteOpenRequest,
  type RemoteOpenResult,
  type RemotePatch,
  type RemotePendingWrite,
  type RemoteTarget,
  type RemoteWorktreeSnapshot,
  type RemoteWriteAction,
  type RemoteWriteRequest,
  type RemoteWriteResult,
} from "./remote-worktree";
import type {
  BatchDeleteResult,
  BranchState,
  ChangeRequestOutcome,
  ChangeRequestPrepare,
  ChangeRequestTokenStatus,
  BranchListing,
  BranchTracking,
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
  RemoteSshSettings,
  SshInstallOutcome,
  SshInstallProgress,
  SshProbe,
  SshTarget,
  SshTargetInput,
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
  TerminalPrefs,
  TerminalProfile,
  TerminalSnapshot,
  Theme,
  PullIntegration,
  UndoResult,
  RevertOutcome,
  AmendOutcome,
  AppFailure,
  RepositoryLocation,
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
  protocolVersion: 2 | 3;
  workspaceId: string | null;
  repositoryId: string | null;
  workspaceName: string | null;
  reviewId: string;
  sessionId: string;
  worktreePath: string;
  baseline: string | null;
}

export async function saveWorkspaceFile(): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ title: "发布项目清单", defaultPath: "project.dev-workspace.json", filters: [{ name: "项目清单", extensions: ["json"] }] });
}
export async function pickDirectories(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ title: "选择项目仓库（可多选）", directory: true, multiple: true });
  return Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
}

/* ------------------------------------------------------------------ *
 * 仓库位置分派（T6）：本机仓库继续走原生命令，SSH 工作树走远端端口。
 * 两条路径在这一个 API 边界返回同一套 DTO，界面不需要第二套页面；
 * 远端仓库的稳定键（ssh://hostId/path）进入这里时绝不落回本机 Git。
 * ------------------------------------------------------------------ */

/** 远端一次完整差异最多续读的页数：超过就明确截断，不做无界循环。 */
const REMOTE_DIFF_PAGE_LIMIT = 64;

/** 有界差异缓存：按状态令牌失效，不随仓库大小无限增长。 */
const REMOTE_DIFF_CACHE_LIMIT = 32;

/** 明确「没有写进去」的远端错误：可以清掉待确认记录，也不需要重发。 */
const DEFINITIVE_WRITE_CODES = new Set([
  "remote_busy",
  "remote_not_sent",
  "remote_request",
  "remote_request_size",
  "bad_request",
  "invalid_path",
  "invalid_selection",
  "selection_expands",
  "stale_state",
  "index_locked",
  "nothing_staged",
  "unmerged",
  "git_operation_active",
  "hook_failed",
  "empty_message",
]);

interface RemoteRepositorySession {
  key: string;
  hostId: string;
  hostRevision: string;
  /** 主机显示名；只用于展示，不参与仓库键。 */
  host: string;
  /** 远端仓库身份（agent 返回的 repo 标识），每次响应都要核对。 */
  repo: string;
  root: string;
  sessionId: string;
  /** 远端状态令牌：状态一变就换新值。 */
  token: string;
  /** 数值代次：主界面对旧响应的比较照旧成立。 */
  generation: number;
  latest: RemoteWorktreeSnapshot;
  reviewId: string | null;
  pending: RemotePendingWrite | null;
  /**
   * 连接断开后只读：已读内容保留，但写入与新的读取都不再发送，
   * 直到重新打开这个远端仓库。绝不因为断线改用本机 Git。
   */
  disconnected: boolean;
  diffs: Map<string, RemoteDiffDocument>;
}

/** 传输层错误：连接已不可用，界面转入只读。 */
const DISCONNECT_CODES = new Set(["remote_disconnected", "ssh_failed", "remote_timeout", "ssh_auth_failed"]);

const remoteSessions = new Map<string, RemoteRepositorySession>();
const remoteHostLabels = new Map<string, string>();
let remoteGeneration = 1000;

/**
 * 远端仓库的提交说明草稿：只留在本次会话内存里，按仓库键分开。
 *
 * 本机草稿库只认本机仓库的规范路径，所以远端的草稿不写 state.json，但也不能丢：
 * 切走再回来（会话已结束重开）时由这里回读，用户看到的还是自己写的那份。
 */
const remoteDrafts = new Map<string, string>();

/**
 * 远端会话状态的订阅者：待确认写入、断线与会话增删都叫醒一次，
 * 外壳据此重新读取 remoteRepositoryState，不必轮询。
 */
const remoteStateListeners = new Set<() => void>();

function noteRemoteState(): void {
  for (const listener of [...remoteStateListeners]) listener();
}

/** 订阅远端会话状态变化，返回取消订阅函数。 */
export function onRemoteStateChange(listener: () => void): () => void {
  remoteStateListeners.add(listener);
  return () => {
    remoteStateListeners.delete(listener);
  };
}

function remoteError(code: string, message: string, generation?: number): AppFailure {
  return generation === undefined ? { code, message } : { code, message, generation };
}

function newOperationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-a" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function remoteSession(key: string): RemoteRepositorySession {
  const session = remoteSessions.get(key);
  if (!session) {
    throw remoteError("remote_disconnected", "远端仓库连接已断开，请重新打开这个远端仓库。");
  }
  return session;
}

async function hostLabel(hostId: string, fallback: string): Promise<string> {
  const known = remoteHostLabels.get(hostId);
  if (known) return known;
  try {
    for (const target of await remoteWorktreePort.targets()) {
      remoteHostLabels.set(target.targetId, target.name);
    }
  } catch {
    // 主机列表读不到时用远端返回的主机标识，不因此拒绝已打开的仓库。
  }
  return remoteHostLabels.get(hostId) ?? fallback;
}

/**
 * 状态令牌变化时才推进数值代次：同一状态重复读取不会让界面把旧响应当成新代次，
 * 状态真的变化时旧响应又一定会被丢弃。
 */
function advanceRemoteGeneration(session: RemoteRepositorySession, snapshot: RemoteWorktreeSnapshot): number {
  if (session.token !== snapshot.generation) {
    session.token = snapshot.generation;
    remoteGeneration += 1;
    session.generation = remoteGeneration;
  }
  session.latest = snapshot;
  return session.generation;
}

function openedRemote(session: RemoteRepositorySession): OpenedRepository {
  return {
    summary: {
      name: repositoryBaseName(session.root),
      path: session.key,
      host: session.host,
      remotePath: session.root,
    },
    generation: session.generation,
    snapshot: remoteStatus(session.latest, session.generation),
    // 远端仓库的提交说明草稿只在本会话内保留：本机 state.json 只服务本机仓库，
    // 但切走再回来要回到用户写下的那份，所以从会话内存里回读。
    draft: remoteDrafts.get(session.key) ?? "",
    // 远端没有本机文件监听，变化由显式刷新与聚焦刷新发现。
    watchDegraded: false,
  };
}

async function remoteStatusOf(session: RemoteRepositorySession): Promise<RemoteWorktreeSnapshot> {
  if (session.disconnected) {
    throw remoteError("remote_disconnected", "远端连接已断开，请重新打开这个远端仓库；当前内容只读。");
  }
  let snapshot: RemoteWorktreeSnapshot;
  try {
    snapshot = await remoteWorktreePort.status(session.sessionId);
  } catch (error) {
    const failure = normalizeError(error);
    if (DISCONNECT_CODES.has(failure.code) && !session.disconnected) {
      session.disconnected = true;
      noteRemoteState();
    }
    session.diffs.clear();
    throw failure;
  }
  if (session.disconnected) {
    session.disconnected = false;
    noteRemoteState();
  }
  if (snapshot.repo !== session.repo) {
    throw remoteError("target_changed", "远端工作树身份已变化，请重新打开这个远端仓库。");
  }
  advanceRemoteGeneration(session, snapshot);
  return snapshot;
}

async function loadRemotePatch(
  session: RemoteRepositorySession,
  path: string,
  view: RemoteDiffView,
): Promise<RemotePatch> {
  const chunks: Uint8Array[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total = 0;
  let truncated = false;
  while (pages < REMOTE_DIFF_PAGE_LIMIT) {
    let page: RemoteDiffPage;
    try {
      page = await remoteWorktreePort.diff({
        sessionId: session.sessionId,
        generation: session.token,
        path,
        view,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      throw normalizeError(error);
    }
    const bytes = decodeBase64(page.data);
    chunks.push(bytes);
    total += bytes.length;
    pages += 1;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  truncated = cursor !== null;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const patch = parseRemotePatch(new TextDecoder().decode(joined));
  return truncated ? { ...patch, truncated: true } : patch;
}

async function settleRemoteWrite(
  session: RemoteRepositorySession,
  result: RemoteWriteResult,
  op: RemotePendingWrite["op"],
): Promise<RemoteWorktreeSnapshot> {
  if (result.state === "completed") {
    session.pending = null;
    noteRemoteState();
    if (result.snapshot.repo !== session.repo) {
      throw remoteError("target_changed", "远端工作树身份已变化，请重新打开这个远端仓库。", session.generation);
    }
    session.diffs.clear();
    advanceRemoteGeneration(session, result.snapshot);
    return result.snapshot;
  }
  if (result.state === "failed") {
    // 远端已核实这次写入没有生效：清掉待确认记录，错误如实上报。
    session.pending = null;
    noteRemoteState();
    throw remoteError("remote_write_failed", result.message || "远端操作失败，工作树没有被改动。", session.generation);
  }
  session.pending = { operationId: result.operationId, op };
  noteRemoteState();
  throw remoteError("write_pending", result.message || "远端操作结果待确认，请重新打开这个远端仓库核对。", session.generation);
}

async function recoverRemoteWrite(session: RemoteRepositorySession): Promise<RemoteWorktreeSnapshot | null> {
  const pending = session.pending;
  if (!pending) return null;
  let result: RemoteWriteResult;
  try {
    // 只查询原操作 ID 的回执，绝不重发写入。
    result = await remoteWorktreePort.recover(session.sessionId, pending.operationId);
  } catch (error) {
    throw normalizeError(error);
  }
  return settleRemoteWrite(session, result, pending.op);
}

async function remoteWrite(
  session: RemoteRepositorySession,
  action: RemoteWriteAction,
  generation: number,
): Promise<RemoteWorktreeSnapshot> {
  if (session.disconnected) {
    throw remoteError("remote_disconnected", "远端连接已断开，本次写入没有发送；请重新打开这个远端仓库。");
  }
  if (generation !== session.generation) {
    throw remoteError("stale", "远端仓库已有变化，请刷新后重试。", session.generation);
  }
  if (session.pending) {
    throw remoteError(
      "write_pending",
      "上一次远端操作的结果还没有核对，请重新打开这个远端仓库核对后再写入。",
      session.generation,
    );
  }
  const operationId = newOperationId();
  session.pending = { operationId, op: action.op };
  noteRemoteState();
  let result: RemoteWriteResult;
  try {
    result = await remoteWorktreePort.write({
      ...action,
      sessionId: session.sessionId,
      generation: session.token,
      operationId,
    } as RemoteWriteRequest);
  } catch (error) {
    const failure = normalizeError(error);
    if (DEFINITIVE_WRITE_CODES.has(failure.code)) {
      session.pending = null;
      noteRemoteState();
      throw failure;
    }
    // 未收到回执：按「结果未知」处理，不重发、不冒充失败，写入保持禁用。
    throw remoteError("write_pending", failure.message, session.generation);
  }
  return settleRemoteWrite(session, result, action.op);
}

async function closeRemoteSession(
  session: RemoteRepositorySession,
  reason: string,
): Promise<void> {
  remoteSessions.delete(session.key);
  noteRemoteState();
  try {
    await remoteWorktreePort.close(session.sessionId);
  } catch {
    // 关闭失败不改变本机会话已结束的事实；下次打开会重新建立连接。
  }
  if (session.reviewId) {
    try {
      await remoteReviewPort.end(session.reviewId, reason);
    } catch {
      // 来源已失效时不再补发回执。
    }
  }
}

export interface RemoteOpenOptions {
  reviewId?: string;
  /** 审查来源带来的任务基线：有基线就必须原样回传，否则后端按 target_changed 拒绝。 */
  baseline?: string | null;
  allowInstall?: boolean;
  installConfirmation?: string | null;
  onProgress?: (value: RemoteConnectionProgress) => void;
}

export type RemoteOpenOutcome =
  | {
      kind: "opened";
      repository: OpenedRepository;
      key: string;
      host: string;
      path: string;
      pending: RemotePendingWrite | null;
      reviewId: string | null;
    }
  | { kind: "install_required"; version: string; size: number; confirmationId: string | null };

/** 远端仓库的当前状态：只给展示层用，不含任何秘密。 */
export interface RemoteRepositoryState {
  key: string;
  host: string;
  path: string;
  /** 有待核对的写入：写入保持禁用，直到重新打开并核对。 */
  pending: boolean;
  reviewId: string | null;
  connected: boolean;
}

async function openRemote(
  location: Extract<RepositoryLocation, { kind: "ssh" }>,
  options: RemoteOpenOptions = {},
): Promise<RemoteOpenOutcome> {
  let opened: RemoteOpenResult;
  try {
    opened = await remoteWorktreePort.open(
      {
        requestId: newOperationId(),
        targetId: location.hostId,
        targetRevision: location.hostRevision,
        path: location.path,
        allowInstall: options.allowInstall ?? false,
        ...(options.installConfirmation ? { installConfirmation: options.installConfirmation } : {}),
        ...(options.reviewId ? { reviewId: options.reviewId } : {}),
        // 基线一起带着走：后端按 baseline 相等判定这次打开是不是那条审查。
        ...(options.baseline ? { baseline: options.baseline } : {}),
      } as RemoteOpenRequest,
      options.onProgress ?? (() => {}),
    );
  } catch (error) {
    throw normalizeError(error);
  }
  if (opened.kind === "install_required") {
    return {
      kind: "install_required",
      version: opened.version,
      size: opened.size,
      confirmationId: opened.confirmationId ?? null,
    };
  }
  const root = opened.snapshot.root;
  const host = await hostLabel(location.hostId, opened.snapshot.host || location.hostId);
  const key = remoteRepositoryKey(location.hostId, root);
  // 主窗口同时只有一个当前仓库：先前打开的远端连接（含同名路径的另一台主机）先结束。
  for (const previous of [...remoteSessions.values()]) {
    await closeRemoteSession(previous, "cancelled");
  }
  const session: RemoteRepositorySession = {
    key,
    hostId: location.hostId,
    hostRevision: location.hostRevision,
    host,
    repo: opened.snapshot.repo,
    root,
    sessionId: opened.sessionId,
    token: opened.snapshot.generation,
    generation: (remoteGeneration += 1),
    latest: opened.snapshot,
    reviewId: options.reviewId ?? null,
    pending: opened.pendingWrite ?? null,
    disconnected: false,
    diffs: new Map(),
  };
  remoteSessions.set(key, session);
  noteRemoteState();
  if (session.reviewId) {
    try {
      await remoteReviewPort.accept(session.reviewId, session.sessionId);
    } catch (error) {
      await closeRemoteSession(session, "open_failed");
      throw normalizeError(error);
    }
  }
  if (session.pending) {
    // 打开时后端已经带回持久记录：只核对回执，不重发写入。
    await recoverRemoteWrite(session).catch(() => undefined);
  }
  return {
    kind: "opened",
    repository: openedRemote(session),
    key,
    host,
    path: root,
    pending: session.pending,
    reviewId: session.reviewId,
  };
}

/** 打开远端仓库：主机、路径与可选审查来源都在这里绑定，安装需要显式确认。 */
export async function openRemoteRepository(
  location: Extract<RepositoryLocation, { kind: "ssh" }>,
  options: RemoteOpenOptions = {},
): Promise<RemoteOpenOutcome> {
  return openRemote(location, options);
}

/** 远端主机列表（只读）：主机簿里的显示名与默认目录，不含秘密。 */
export async function remoteTargets(): Promise<RemoteTarget[]> {
  try {
    return await remoteWorktreePort.targets();
  } catch (error) {
    throw normalizeError(error);
  }
}

export function remoteRepositoryState(key: string): RemoteRepositoryState | null {
  const session = remoteSessions.get(key);
  if (!session) return null;
  return {
    key: session.key,
    host: session.host,
    path: session.root,
    pending: session.pending !== null,
    reviewId: session.reviewId,
    connected: !session.disconnected,
  };
}

/** 向原 Cliora 会话返回审查结果：只发送真实 Git 结果，不推进任何本地仓库状态。 */
export async function remoteReturnReview(key: string): Promise<void> {
  const session = remoteSession(key);
  if (!session.reviewId) throw remoteError("remote_review", "这次打开不是 Cliora 远端审查，没有可返回的来源。");
  if (session.pending) {
    throw remoteError("write_pending", "请先核对远端操作结果，再返回 Cliora。", session.generation);
  }
  try {
    await remoteReviewPort.returnReview(session.reviewId, session.sessionId);
  } catch (error) {
    throw normalizeError(error);
  }
}


const apiBase = {
  workspaceList: () => invoke<Projects>("workspace_list"),
  workspaceCreate: (name: string) => invoke<Projects>("workspace_create", { name }),
  workspacePreview: (path: string) => invoke<WorkspacePreview>("workspace_preview", { path }),
  workspaceAttach: (preview: WorkspacePreview, adopt: boolean) => invoke<Projects>("workspace_attach", { preview, adopt }),
  workspaceUpdate: (manifest: WorkspaceManifest, expectedRevision: number) => invoke<Projects>("workspace_update", { manifest, expectedRevision }),
  workspaceRefresh: (id: string) => invoke<Projects>("workspace_refresh", { id }),
  workspacePublish: (id: string, expectedRevision: number, path: string) => invoke<Projects>("workspace_publish", { id, expectedRevision, path }),
  workspaceFavorite: (id: string, repositoryId: string, enabled: boolean) => invoke<Projects>("workspace_favorite", { id, repositoryId, enabled }),
  workspaceCandidates: (paths: string[], requestId: number) => invoke<WorkspaceCandidate[]>("workspace_candidates", { paths, requestId }),
  workspaceDiscover: (root: string, requestId: number) => invoke<WorkspaceDiscovery>("workspace_discover", { root, requestId }),
  workspaceCancelDiscovery: () => invoke<void>("workspace_cancel_discovery"),
  workspaceDelete: (id: string) => invoke<Projects>("workspace_delete", { id }),
  workspacePreviewLink: (url: string) => invoke<WorkspacePreview>("workspace_preview_link", { url }),
  workspaceOpenInCliora: (path: string, repositoryId: string) => invoke<void>("workspace_open_in_cliora", { path, repositoryId }),
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
    const reviewId = captureClioraReview(path);
    const result = await invoke<CommitResult>("commit_changes", { path, message, generation, requestId, ...(reviewId ? { reviewId } : {}) });
    recordClioraCommit(path, result.oid, reviewId);
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
    const reviewId = captureClioraReview(path);
    const report = await invoke<CommitPushReport>("commit_and_push", { path, message, generation, requestId, ...(reviewId ? { reviewId } : {}) });
    if (report.committed && report.oid) recordClioraCommit(path, report.oid, reviewId);
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
  /**
   * 新建普通文件或空目录：目标必须不存在，只接受仓库相对路径。
   * 只写工作区，不暂存、不提交；成功后返回同一新代次的 StatusSnapshot。
   */
  repositoryCreateEntry: (
    path: string,
    relative: string,
    kind: "file" | "directory",
    generation: number,
    requestId: number,
  ) =>
    invoke<StatusSnapshot>("repository_create_entry", { path, relative, kind, generation, requestId }),
  /** 复制单个普通文件或目录到仓库内的新路径：不覆盖已有目标。 */
  repositoryCopyEntry: (path: string, source: string, target: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("repository_copy_entry", { path, source, target, generation, requestId }),
  /** 移动或重命名普通文件与目录：目标必须不存在，也不能是自身的后代。 */
  repositoryMoveEntry: (path: string, source: string, target: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("repository_move_entry", { path, source, target, generation, requestId }),
  /** 把普通文件或空/非空目录移入系统回收站；失败不降级为永久删除。只有本应用脚本仍用它。 */
  repositoryDeleteEntry: (path: string, relative: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("repository_delete_entry", { path, relative, generation, requestId }),
  /**
   * 文件视图唯一的删除命令（单选与多选共用）：一次请求、一次写锁、一次状态刷新。
   * permanent 必须显式传入——为真才是跳过回收站的永久删除，不会隐式降级。
   */
  repositoryDeleteEntries: (path: string, relatives: string[], permanent: boolean, generation: number, requestId: number) =>
    invoke<BatchDeleteResult>("repository_delete_entries", { path, relatives, permanent, generation, requestId }),
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
  /** 全部本地分支相对上游的领先/落后：只读、不访问远程，一次 for-each-ref。 */
  branchTracking: (path: string, generation: number, requestId: number) =>
    invoke<BranchTracking>("branch_tracking", { path, generation, requestId }),
  /** 不切换分支地快进一个非当前本地分支（git fetch <remote> <src>:<dst>）；分叉时拒绝。 */
  updateBranch: (path: string, name: string, generation: number, requestId: number) =>
    invoke<BranchState>("update_branch", { path, name, generation, requestId }),
  /** 不切换分支地推送一个本地分支；没有上游时发布并建立跟踪。不强推。 */
  pushLocalBranch: (path: string, name: string, generation: number, requestId: number) =>
    invoke<BranchState>("push_local_branch", { path, name, generation, requestId }),
  branchState: (path: string, generation: number, requestId: number) =>
    invoke<BranchState>("branch_state", { path, generation, requestId }),
  fetchBranches: (path: string, generation: number, requestId: number) =>
    invoke<BranchState>("fetch_branches", { path, generation, requestId }),
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
  cherryPickCommits: async (path: string, oids: string[], generation: number, requestId: number) => {
    const reviewId = captureClioraReview(path);
    const result = await invoke<CherryPickOutcome>("cherry_pick_commits", { path, oids, generation, requestId, ...(reviewId ? { reviewId } : {}) });
    if (result.created > 0 && result.headOid) recordClioraCommit(path, result.headOid, reviewId);
    return result;
  },
  /**
   * 还原一组普通提交：先以 confirm=false 预览由新到旧的目标，确认后在本地创建逆向提交，不推送。
   * 只有真正创建了提交才记录 cliora committed；预览、取消、失败和未创建任何提交的冲突都不记录。
   */
  revertCommits: async (
    path: string,
    oids: string[],
    expectedHead: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ) => {
    const reviewId = captureClioraReview(path);
    const result = await invoke<RevertOutcome>("revert_commits", {
      path,
      oids,
      expectedHead,
      confirm,
      generation,
      requestId,
      ...(reviewId ? { reviewId } : {}),
    });
    if (result.wrote && result.created > 0 && result.headOid) {
      recordClioraCommit(path, result.headOid, reviewId);
    }
    return result;
  },
  /**
   * 修订最近提交：先以 confirm=false 预览完整原说明、原提交文件、暂存路径与快照令牌，
   * 确认后在写锁内复核并改写 HEAD。只有实际写入成功才记录 cliora committed；
   * 预览、取消、无实际变化和失败都不记录。
   */
  amendCommit: async (
    path: string,
    expectedHead: string,
    message: string | null,
    includeStaged: boolean,
    stagedToken: string | null,
    confirm: boolean,
    generation: number,
    requestId: number,
  ) => {
    const reviewId = captureClioraReview(path);
    const result = await invoke<AmendOutcome>("amend_commit", {
      path,
      expectedHead,
      message,
      includeStaged,
      stagedToken,
      confirm,
      generation,
      requestId,
      ...(reviewId ? { reviewId } : {}),
    });
    if (result.wrote && result.headOid) {
      recordClioraCommit(path, result.headOid, reviewId);
    }
    return result;
  },
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
    const reviewId = captureClioraReview(path);
    const session = await invoke<MergeSession>("start_merge", { path, source, target, mode, generation, requestId, ...(reviewId ? { reviewId } : {}) });
    // 只有快进或变基真正完成才算合入；留在冲突状态的结果不记录。
    if ((session.fastForwarded || session.rebased) && session.headOid) {
      recordClioraMerge(path, session.headOid, reviewId);
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
  /**
   * Classify the actual operation returned by the native write guard: cherry-pick/revert
   * create commits; completed merge/rebase records an integration. The active UI is not evidence.
   */
  completeMerge: async (
    path: string,
    message: string,
    generation: number,
    requestId: number,
    _operation: string | null = null,
  ) => {
    const reviewId = captureClioraReview(path);
    const done = await invoke<MergeComplete>("complete_merge", { path, message, generation, requestId, ...(reviewId ? { reviewId } : {}) });
    if (done.operation === "revert" || done.operation === "cherry-pick") recordClioraCommit(path, done.oid, reviewId);
    else if (done.operation === "merge" || done.operation === "rebase") recordClioraMerge(path, done.oid, reviewId);
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
  setChangeRequestsEnabled: (changeRequestsEnabled: boolean) =>
    invoke<void>("set_change_requests_enabled", { changeRequestsEnabled }),
  /**
   * 远程 SSH 设置：只读主机簿与总开关。主机记录不含密码，每台只带 hasPassword。
   * 总开关缺省关闭；关闭时任何连接操作都在原生边界被拒。
   */
  remoteSshSettings: () => invoke<RemoteSshSettings>("remote_ssh_settings"),
  /** 只写开关：不删除主机、不删除密码、不等同于断开活动会话。 */
  setRemoteSshEnabled: (enabled: boolean) => invoke<void>("set_remote_ssh_enabled", { enabled }),
  /** 新建或更新一条主机记录；revision 由存储按连接身份变化推进。 */
  saveRemoteSshTarget: (target: SshTargetInput) =>
    invoke<SshTarget>("remote_ssh_save_target", { target }),
  /** 删除主机记录，并清理该主机在 twiglane.remote-ssh 命名空间里的密码。 */
  deleteRemoteSshTarget: (targetId: string) =>
    invoke<void>("remote_ssh_delete_target", { targetId }),
  /** 密码只经这个参数进入原生并立即写入系统钥匙串，不落 state.json。 */
  setRemoteSshPassword: (targetId: string, password: string) =>
    invoke<void>("remote_ssh_set_password", { targetId, password }),
  deleteRemoteSshPassword: (targetId: string) =>
    invoke<void>("remote_ssh_delete_password", { targetId }),
  /** 可取消的连接测试：只读探测，不创建目录、不写远端文件。 */
  testRemoteSsh: (requestId: string, targetId: string) =>
    invoke<SshProbe>("remote_ssh_test", { requestId, targetId }),
  cancelRemoteSsh: (requestId: string) => invoke<void>("remote_ssh_cancel", { requestId }),
  /**
   * 安装远端组件：不带 confirmationId 只返回待确认信息（size/version/sha256），
   * 传输必须由用户显式确认后进行。
   */
  installRemoteSshAgent: async (
    request: {
      requestId: string;
      targetId: string;
      peerRevision: string;
      confirmationId?: string;
    },
    progress: (value: SshInstallProgress) => void,
  ) => {
    const { Channel, invoke: call } = await import("@tauri-apps/api/core");
    const onProgress = new Channel<SshInstallProgress>(progress);
    return call<SshInstallOutcome>("remote_ssh_install_agent", { request, onProgress });
  },
  /**
   * 「创建 MR / PR」的只读准备：远程解析、平台发现与来源分支都由原生从当前仓库重新推导，
   * 前端不传 owner/repo/API base。remote 为空时按上游或唯一远程推断，多远程返回候选。
   */
  prepareChangeRequest: (path: string, remote: string | null, generation: number, requestId: number) =>
    invoke<ChangeRequestPrepare>("change_request_prepare", { path, remote, generation, requestId }),
  /** 显式创建：成功只接受平台返回且原生已验证的链接；普通/未知错误由调用方分类展示。 */
  createChangeRequest: (
    path: string,
    remote: string,
    targetBranch: string,
    title: string,
    body: string,
    generation: number,
    requestId: number,
  ) =>
    invoke<ChangeRequestOutcome>("change_request_create", {
      path,
      remote,
      targetBranch,
      title,
      body,
      generation,
      requestId,
    }),
  /** 当前实例的令牌状态：只有布尔值，不回传令牌。 */
  changeRequestTokenStatus: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<ChangeRequestTokenStatus>("change_request_token_status", { path, remote, generation, requestId }),
  /** 保存或替换当前实例的令牌：只经 IPC 参数进入原生，随后直接写入系统钥匙串。 */
  setChangeRequestToken: (
    path: string,
    remote: string,
    token: string,
    generation: number,
    requestId: number,
  ) =>
    invoke<ChangeRequestTokenStatus>("change_request_set_token", {
      path,
      remote,
      token,
      generation,
      requestId,
    }),
  /** 只删除用户显式点选的当前实例令牌；关闭功能开关不会调用它。 */
  deleteChangeRequestToken: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<ChangeRequestTokenStatus>("change_request_delete_token", { path, remote, generation, requestId }),
  setPanelWidths: (widths: PanelWidths) => invoke<PanelWidths>("set_panel_widths", { widths }),
  saveDraft: (path: string, message: string) => invoke<void>("save_draft", { path, message }),
  cancelReads: () => invoke<void>("cancel_reads"),
  /** 本机可用的终端类型，第一项是平台默认。 */
  terminalProfiles: () => invoke<TerminalProfile[]>("terminal_profiles"),
  /** 仓库现有终端会话（按创建顺序，不带输出）；附着时用 terminalAttach 取输出重放。 */
  terminalList: (path: string) => invoke<TerminalSnapshot[]>("terminal_list", { path }),
  /** 在仓库根目录新建会话；profile 为空时用设置里的默认终端类型。 */
  terminalCreate: (path: string, profile: string | null = null) =>
    invoke<TerminalSnapshot>("terminal_create", { path, profile }),
  /** 附着已有会话：返回完整输出与 seq，用于重放并丢弃旧事件。 */
  terminalAttach: (sessionId: string) => invoke<TerminalSnapshot>("terminal_attach", { sessionId }),
  /** 用同一终端类型重启已退出的会话；运行中返回 terminal_running。 */
  terminalRestart: (sessionId: string) => invoke<TerminalSnapshot>("terminal_restart", { sessionId }),
  /** 关闭会话：运行中先终止 shell 及其子进程，确认结束后才移除。 */
  terminalClose: (sessionId: string) => invoke<void>("terminal_close", { sessionId }),
  setTerminalPrefs: (prefs: TerminalPrefs) => invoke<TerminalPrefs>("set_terminal_prefs", { prefs }),
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
  clioraReviewSources: (resetPending = false) => invoke<{ sources: ClioraSourceSnapshot[]; expiredPending: number }>("cliora_review_sources", { resetPending }),
  clioraReviewForget: (reviewId: string, sessionId: string) => invoke<void>("cliora_review_forget", { reviewId, sessionId }),
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

/* ------------------------------------------------------------------ *
 * 分派：同一个方法名按仓库键落到本机或远端；远端仓库绝不落回本机 Git。
 * ------------------------------------------------------------------ */

async function remoteStageMany(
  path: string,
  paths: string[],
  generation: number,
  op: "stage" | "unstage",
): Promise<StatusSnapshot> {
  const session = remoteSession(path);
  let current = generation;
  let snapshot = session.latest;
  for (const relative of paths) {
    snapshot = await remoteWrite(session, { op, path: relative }, current);
    current = session.generation;
  }
  return remoteStatus(snapshot, session.generation);
}

async function closeAllRemoteSessions(): Promise<void> {
  for (const session of [...remoteSessions.values()]) {
    await closeRemoteSession(session, "cancelled");
  }
}

export async function closeRemoteRepository(key: string): Promise<void> {
  const session = remoteSessions.get(key);
  if (!session) return;
  await closeRemoteSession(session, "cancelled");
}

const apiExtras = {
  remoteTargets,
  openRemoteRepository,
  remoteReturnReview,
  remoteRepositoryState,
  onRemoteStateChange,
  closeRemoteRepository,
};

const remoteOverrides: Record<string, unknown> = {
  async openRepository(path: string, requestId: number): Promise<OpenedRepository> {
    if (!isRemoteRepositoryKey(path)) {
      // 切到本机仓库前先结束远端会话：一条连接只服务一个当前仓库。
      await closeAllRemoteSessions();
      return apiBase.openRepository(path, requestId);
    }
    const parsed = parseRemoteRepositoryKey(path);
    if (!parsed) throw remoteError("invalid_path", "远端仓库地址无效。");
    const targets = await remoteTargets();
    const target = targets.find((item) => item.targetId === parsed.hostId);
    if (!target) throw remoteError("target_changed", "这台 SSH 主机已不在主机簿里，请重新选择主机。");
    if (target.unavailableReason) throw remoteError("target_unavailable", target.unavailableReason);
    const outcome = await openRemote({
      kind: "ssh",
      hostId: target.targetId,
      hostRevision: target.targetRevision,
      path: parsed.path,
    });
    if (outcome.kind === "install_required") {
      throw remoteError(
        "remote_install_required",
        "这台主机还没有可用的 Twiglane 远端组件，请在“打开远端仓库”里确认安装后再打开。",
      );
    }
    return outcome.repository;
  },

  async addRepository(path: string, requestId: number): Promise<OpenedRepository> {
    await closeAllRemoteSessions();
    return apiBase.addRepository(path, requestId);
  },

  async refreshStatus(path: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.refreshStatus(path, generation, requestId);
    const session = remoteSession(path);
    const snapshot = await remoteStatusOf(session);
    return remoteStatus(snapshot, session.generation);
  },

  async loadDiff(
    path: string,
    relative: string,
    staged: boolean,
    generation: number,
    requestId: number,
    original: string | null = null,
    offset = 0,
    limit = 0,
    context?: number,
    asText?: boolean,
  ): Promise<DiffResponse> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.loadDiff(path, relative, staged, generation, requestId, original, offset, limit, context, asText);
    }
    const session = remoteSession(path);
    if (session.disconnected) {
      throw remoteError("remote_disconnected", "远端连接已断开：已读内容保留，新的差异读取不再发送。");
    }
    if (generation !== session.generation) {
      throw remoteError("stale", "远端仓库已有变化，请刷新后重试。", session.generation);
    }
    const view: RemoteDiffView = staged ? "staged" : "unstaged";
    const cacheKey = view + "\u0000" + relative + "\u0000" + session.token;
    let document = session.diffs.get(cacheKey);
    if (!document) {
      const patch = await loadRemotePatch(session, relative, view);
      // 等待期间切了仓库：这次响应属于旧连接，直接丢弃而不是贴到新仓库上。
      if (remoteSessions.get(path) !== session) {
        throw remoteError("remote_disconnected", "远端仓库已切换，这次差异读取已丢弃。");
      }
      document = remoteDiffDocument(patch, session.generation, relative, staged, session.token);
      if (session.diffs.size >= REMOTE_DIFF_CACHE_LIMIT) session.diffs.clear();
      session.diffs.set(cacheKey, document);
    }
    if (document.generation !== generation) {
      throw remoteError("stale", "远端仓库已有变化，请刷新后重试。", session.generation);
    }
    return remoteDiffPage(document, offset, limit);
  },

  async stageFiles(path: string, paths: string[], generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.stageFiles(path, paths, generation, requestId);
    return remoteStageMany(path, paths, generation, "stage");
  },

  async unstageFiles(path: string, paths: string[], generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.unstageFiles(path, paths, generation, requestId);
    return remoteStageMany(path, paths, generation, "unstage");
  },

  async commitChanges(path: string, message: string, generation: number, requestId: number): Promise<CommitResult> {
    if (!isRemoteRepositoryKey(path)) return apiBase.commitChanges(path, message, generation, requestId);
    const session = remoteSession(path);
    const staged = remoteChanges(session.latest.files)
      .filter((file) => file.staged !== "none")
      .map((file) => file.path);
    const snapshot = await remoteWrite(session, { op: "commit", message }, generation);
    return {
      oid: snapshot.head ?? "",
      generation: session.generation,
      branch: snapshot.branch ?? "",
      summary: message.split("\n")[0] ?? "",
      files: staged,
      pushed: false,
      snapshot: remoteStatus(snapshot, session.generation),
    };
  },

  async closeRepository(): Promise<void> {
    await closeAllRemoteSessions();
    return apiBase.closeRepository();
  },

  async repositoryReviewToken(
    path: string,
    relative: string,
    generation: number,
    requestId: number,
  ): Promise<RepositoryReviewToken> {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryReviewToken(path, relative, generation, requestId);
    const session = remoteSession(path);
    if (generation !== session.generation) {
      throw remoteError("stale", "远端仓库已有变化，请刷新后重试。", session.generation);
    }
    const file = remoteChanges(session.latest.files).find((item) => item.path === relative);
    if (!file) {
      return {
        generation,
        path: relative,
        state: "missing",
        token: null,
        staged: "none",
        unstaged: "none",
        untracked: false,
        unmerged: false,
        contentVersion: null,
        message: "这条改动已不在远端工作树里。",
      };
    }
    return {
      generation,
      path: relative,
      state: "current",
      token: remoteReviewToken(session.token, path, relative),
      staged: file.staged,
      unstaged: file.unstaged,
      untracked: file.untracked,
      unmerged: file.unmerged,
      contentVersion: session.token,
      message: "",
    };
  },

  async saveDraft(path: string, message: string): Promise<void> {
    if (!isRemoteRepositoryKey(path)) return apiBase.saveDraft(path, message);
    // 本机草稿库只按本机仓库规范路径保存；远端仓库的草稿留在会话内存里，
    // 换仓库再回来仍然可用，但不会写进本机 state.json。
    remoteDrafts.set(path, message);
  },

  /**
   * 新建与克隆在远端仓库打开时也要先结束远端会话：后端启动新仓库的监听会顶掉现有会话，
   * 若此时还留着远端连接，界面上那个远端仓库会变成一个永远 cancelled 的壳。
   */
  async createRepository(path: string, requestId: number): Promise<OpenedRepository> {
    await closeAllRemoteSessions();
    return apiBase.createRepository(path, requestId);
  },

  async cloneRepository(
    url: string,
    parent: string,
    name: string,
    requestId: number,
    credential: HttpCredential | null = null,
  ): Promise<CloneResult> {
    await closeAllRemoteSessions();
    return apiBase.cloneRepository(url, parent, name, requestId, credential);
  },

  async forgetRecent(path: string): Promise<RecentRepo[]> {
    if (!isRemoteRepositoryKey(path)) return apiBase.forgetRecent(path);
    throw remoteError("remote_unsupported", "远端仓库的最近记录只在本次会话内，移除请从仓库弹层里操作。");
  },
};

/**
 * 同一个 api 对象：未覆盖的方法遇到远端仓库键时明确失败，
 * 不会把 ssh 仓库键当成路径交给本机 Git。
 */
function withRemoteDispatch(base: typeof apiBase): typeof apiBase & typeof apiExtras {
  return new Proxy(base as typeof apiBase & typeof apiExtras, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in apiExtras) {
        return (apiExtras as Record<string, unknown>)[prop];
      }
      if (typeof prop === "string" && prop in remoteOverrides) {
        return remoteOverrides[prop];
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === "string" && isRemoteRepositoryKey(first)) {
          return Promise.reject(
            remoteError("remote_unsupported", "远端仓库暂不支持这个操作（" + prop + "）。"),
          );
        }
        return (value as (...inner: unknown[]) => unknown)(...args);
      };
    },
  });
}

export const api = withRemoteDispatch(apiBase);

