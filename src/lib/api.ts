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
  remoteStatus,
  remoteWorktreePort,
  repositoryBaseName,
  type RemoteConnectionProgress,
  type RemoteDiffDocument,
  type RemoteDiffPage,
  type RemoteDiffView,
  type RemoteOpenRequest,
  type RemoteOpenResult,
  type RemoteProvision,
  type RemoteCallOp,
  type RemotePatch,
  type RemotePendingWrite,
  type RemotePushContinuation,
  type RemoteReviewOutcome,
  type RemoteTarget,
  type RemoteTerminalOp,
  type RemoteWriteOp,
  type RemoteWorktreeSnapshot,
  type RemoteWriteAction,
  type RemoteWriteRequest,
  type RemoteWriteResult,
} from "./remote-worktree";
import { TERMINAL_EXIT_EVENT, TERMINAL_OUTPUT_EVENT } from "./terminal";
import { REMOTE_HUNKS_UNSTAGEABLE_REASON } from "./types";
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
  ReviewFeedbackPrepared,
  ReviewFeedbackRequest,
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
  RemoteRecentRepo,
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
  StoredReviewProgress,
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
  ChangeKind,
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
  const unlisten = await listen<T>(name, (event) => handler(event.payload));
  const dispatch = (event: Event) => handler((event as CustomEvent<T>).detail);
  remoteEvents.addEventListener(name, dispatch);
  return () => {
    remoteEvents.removeEventListener(name, dispatch);
    unlisten();
  };
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

/**
 * 远端差异缓存的一项：解析好的文档，以及这份差异「不能按块暂存」的真实原因。
 *
 * 原因属于整份差异（而不是某一页），随文档一起缓存，翻页与命中缓存都给同一句话。
 */
interface RemoteDiffCacheEntry {
  document: RemoteDiffDocument;
  hunksStageableReason: string | null;
}

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
  baseline: string | null;
  statusRequest: number;
  pending: RemotePendingWrite | null;
  pushContinuations: RemotePushContinuation[];
  recoveryNotice: string | null;
  draft: string;
  reviewProgress?: StoredReviewProgress;
  projectHostId?: string;
  personalWrites: Promise<unknown>;
  /**
   * 这次远端会话里实际做成的 Git 结果阶段：只由已经核对完成的 commit 推进，
   * 返回 Cliora 时按它声明结果（没有提交就是 reviewed）。
   */
  outcome: RemoteReviewOutcome;
  /**
   * 这次会话里改变过 HEAD、却没有被原生审查账本登记的 op（合入、修订、拣选、还原）。
   * 有值时不能声明 committed/merged，返回 Cliora 时必须说明原因。
   */
  unrecordedHeadOp: string | null;
  /** 这次会话已经成功送回 Cliora 的阶段：只有它能让冲突收到 duplicate 的说法。 */
  returnedOutcome: RemoteReviewOutcome | null;
  /**
   * 连接断开后只读：已读内容保留，但写入与新的读取都不再发送，
   * 直到重新打开这个远端仓库。绝不因为断线改用本机 Git。
   */
  disconnected: boolean;
  diffs: Map<string, RemoteDiffCacheEntry>;
  terminals: Set<string>;
}

/** 传输层错误：连接已不可用，界面转入只读。 */
const DISCONNECT_CODES = new Set(["remote_disconnected", "ssh_failed", "remote_timeout", "ssh_auth_failed", "target_changed", "worktree_changed"]);

const remoteSessions = new Map<string, RemoteRepositorySession>();
const remoteHostLabels = new Map<string, string>();
const remoteEvents = new EventTarget();
let remoteGeneration = 1000;
let remoteOpenEpoch = 0;

function checkRemoteResponse(session: RemoteRepositorySession, generation = session.generation): void {
  if (remoteSessions.get(session.key) !== session) {
    throw remoteError("remote_disconnected", "远端仓库已切换，这次读取已丢弃。");
  }
  if (generation !== session.generation) {
    throw remoteError("stale", "远端仓库已有变化，请重新读取。", session.generation);
  }
}

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
    draft: session.draft,
    remoteReviewProgress: session.reviewProgress,
    remoteProjectHostId: session.projectHostId,
    watchDegraded: session.latest.watchDegraded ?? false,
  };
}

async function remoteStatusOf(session: RemoteRepositorySession): Promise<RemoteWorktreeSnapshot> {
  if (session.disconnected) {
    throw remoteError("remote_disconnected", "远端连接已断开，请重新打开这个远端仓库；当前内容只读。");
  }
  const request = ++session.statusRequest;
  const generation = session.generation;
  let snapshot: RemoteWorktreeSnapshot;
  try {
    snapshot = await remoteWorktreePort.status(session.sessionId);
  } catch (error) {
    checkRemoteResponse(session, generation);
    const failure = normalizeError(error);
    if (DISCONNECT_CODES.has(failure.code) && !session.disconnected) {
      session.disconnected = true;
      noteRemoteState();
    }
    session.diffs.clear();
    throw failure;
  }
  checkRemoteResponse(session, generation);
  if (request !== session.statusRequest) {
    throw remoteError("cancelled", "已收到较新的远端状态请求，这次结果已丢弃。");
  }
  if (session.disconnected) {
    session.disconnected = false;
    noteRemoteState();
  }
  if (snapshot.repo !== session.repo) {
    throw remoteError("target_changed", "远端工作树身份已变化，请重新打开这个远端仓库。");
  }
  const changedHead = session.latest.head !== snapshot.head || session.latest.branch !== snapshot.branch;
  advanceRemoteGeneration(session, snapshot);
  if (changedHead) noteRemoteState();
  return snapshot;
}

async function loadRemotePatch(
  session: RemoteRepositorySession,
  path: string,
  view: RemoteDiffView,
  options: Pick<import("./remote-worktree").RemoteDiffRequest, "head" | "original" | "context" | "asText"> = {},
): Promise<RemotePatch & { snapshot: string | null; hunksStageableReason: string | null }> {
  const chunks: Uint8Array[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total = 0;
  let truncated = false;
  const generation = session.generation;
  const version = session.token;
  const stagedHunks = new Set<number>();
  let snapshot: string | null = null;
  let canStage = false;
  let reason: string | null = null;
  while (pages < REMOTE_DIFF_PAGE_LIMIT) {
    let page: RemoteDiffPage;
    try {
      page = await remoteWorktreePort.diff({
        sessionId: session.sessionId,
        generation: version,
        path,
        view,
        ...options,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      const failure = normalizeError(error);
      if (remoteSessions.get(session.key) === session && DISCONNECT_CODES.has(failure.code) && !session.disconnected) {
        session.disconnected = true;
        noteRemoteState();
      }
      throw failure;
    }
    checkRemoteResponse(session, generation);
    const token = typeof page.snapshot === "string" && /^[a-f0-9]{64}$/.test(page.snapshot) ? page.snapshot : null;
    if (pages === 0) {
      reason = page.hunksStageableReason ?? null;
      snapshot = token;
      canStage = page.hunksStageable === true;
    } else if (token !== snapshot) {
      throw remoteError("stale_patch", "远端差异在分页期间发生变化，请重新读取。", generation);
    }
    for (const hunk of page.stageableHunks ?? []) stagedHunks.add(hunk);
    truncated ||= page.truncated === true;
    const bytes = decodeBase64(page.data);
    chunks.push(bytes);
    total += bytes.length;
    pages += 1;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  truncated ||= cursor !== null;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const patch = parseRemotePatch(new TextDecoder().decode(joined), {
    hunksStageable: canStage && snapshot !== null && !truncated,
  });
  for (const hunk of patch.hunks) hunk.stageable &&= stagedHunks.has(hunk.index);
  return {
    ...patch,
    snapshot,
    hunksStageableReason: patch.hunks.some((hunk) => hunk.stageable) ? null : reason ?? REMOTE_HUNKS_UNSTAGEABLE_REASON,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** 兼容未单独返回审查阶段的提交回执。 */
const REVIEW_OUTCOME_BY_OP: Record<string, RemoteReviewOutcome> = {
  commit: "committed",
  commitAndPush: "committed",
};

/** 这些操作可能更新 HEAD，登记的审查阶段以原生回执为准。 */
const UNRECORDED_HEAD_OPS = new Set(["mergeComplete", "amendCommit", "cherryPick", "revert"]);

const REVIEW_OUTCOME_ORDER: RemoteReviewOutcome[] = ["reviewed", "committed", "merged"];

/** 记录这次会话真正做成的阶段；阶段只前进，回退的写入不会把声明降下来。 */
function noteRemoteOutcome(session: RemoteRepositorySession, op: string, recorded?: RemoteReviewOutcome | null): void {
  if (recorded) session.unrecordedHeadOp = null;
  else if (UNRECORDED_HEAD_OPS.has(op) && session.unrecordedHeadOp === null) session.unrecordedHeadOp = op;
  const reached = recorded ?? REVIEW_OUTCOME_BY_OP[op];
  if (!reached) return;
  if (REVIEW_OUTCOME_ORDER.indexOf(reached) > REVIEW_OUTCOME_ORDER.indexOf(session.outcome)) {
    session.outcome = reached;
  }
}

async function settleRemoteWrite(
  session: RemoteRepositorySession,
  result: RemoteWriteResult,
  op: RemotePendingWrite["op"],
): Promise<RemoteWorktreeSnapshot> {
  checkRemoteResponse(session);
  if (result.state === "completed" && result.snapshot.repo !== session.repo) {
    throw remoteError("target_changed", "远端工作树身份已变化，请重新打开这个远端仓库。", session.generation);
  }
  if (result.pushContinuations !== undefined) session.pushContinuations = result.pushContinuations;
  if (result.state === "completed") {
    session.pending = null;
    session.recoveryNotice = null;
    if ((op === "commit" || op === "commitAndPush") && result.draftCleared !== false) session.draft = "";
    noteRemoteOutcome(session, op, result.reviewOutcome);
    session.diffs.clear();
    advanceRemoteGeneration(session, result.snapshot);
    noteRemoteState();
    return result.snapshot;
  }
  if (result.state === "partial") {
    session.pending = null;
    session.recoveryNotice = result.message;
    await remoteStatusOf(session).catch(() => undefined);
    checkRemoteResponse(session);
    noteRemoteState();
    throw remoteError(result.code, result.message, session.generation);
  }
  if (result.state === "failed") {
    // 远端已核实这次写入没有生效：清掉待确认记录，错误如实上报。
    session.pending = null;
    noteRemoteState();
    throw remoteError(result.code ?? "remote_write_failed", result.message || "远端操作失败，工作树没有被改动。", session.generation);
  }
  session.pending = { operationId: result.operationId, op: result.op ?? op };
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
): Promise<Extract<RemoteWriteResult, { state: "completed" }>> {
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
  const op = action.op === "commit" && action.pushAfter ? "commitAndPush" : action.op;
  session.pending = { operationId, op };
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
  await settleRemoteWrite(session, result, op);
  if (result.state !== "completed") throw remoteError("remote_protocol", "远端写入回执格式无效。");
  return result;
}

async function closeRemoteSession(
  session: RemoteRepositorySession,
  reason: string,
  preserveReview = false,
): Promise<void> {
  if (remoteSessions.get(session.key) === session) {
    remoteSessions.delete(session.key);
    noteRemoteState();
  }
  await session.personalWrites.catch(() => undefined);
  try {
    await remoteWorktreePort.close(session.sessionId);
  } catch {
    // 关闭失败不改变本机会话已结束的事实；下次打开会重新建立连接。
  }
  if (session.reviewId && !preserveReview) {
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
  provision?: RemoteProvision;
  replacePendingProvision?: string;
  projectHostId?: string;
  keepBackground?: () => boolean;
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
      credentialNote?: string | null;
      preferencesWarning?: string | null;
    }
  | {
      kind: "background";
      key: string;
      host: string;
      path: string;
      projectHostId?: string;
      credentialNote?: string | null;
      preferencesWarning?: string | null;
    }
  | { kind: "provision_pending"; operationId: string; message: string }
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
  connectionId: string;
  pushContinuation: RemotePushContinuation | null;
  recoveryNotice: string | null;
}

async function openRemote(
  location: Extract<RepositoryLocation, { kind: "ssh" }>,
  options: RemoteOpenOptions = {},
): Promise<RemoteOpenOutcome> {
  const epoch = ++remoteOpenEpoch;
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
        ...(options.provision ? { provision: options.provision } : {}),
        ...(options.replacePendingProvision ? { replacePendingProvision: options.replacePendingProvision } : {}),
        ...(options.projectHostId ? { projectHostId: options.projectHostId } : {}),
      } as RemoteOpenRequest,
      options.onProgress ?? (() => {}),
    );
  } catch (error) {
    throw normalizeError(error);
  }
  if (opened.kind === "provision_pending") {
    if (epoch !== remoteOpenEpoch) throw remoteError("cancelled", "已取消这次远端连接。");
    return opened;
  }
  if (opened.kind === "install_required") {
    if (epoch !== remoteOpenEpoch) throw remoteError("cancelled", "已取消这次远端连接。");
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
  if (options.provision?.kind === "clone" && options.keepBackground?.()) {
    await remoteWorktreePort.close(opened.sessionId).catch(() => undefined);
    return {
      kind: "background",
      key,
      host,
      path: root,
      projectHostId: opened.projectHostId,
      credentialNote: opened.snapshot.credentialNote,
      preferencesWarning: opened.preferencesWarning,
    };
  }
  const keepCurrent = () => {
    if (epoch === remoteOpenEpoch) return;
    void remoteWorktreePort.close(opened.sessionId).catch(() => undefined);
    throw remoteError("cancelled", "已取消这次远端连接。");
  };
  keepCurrent();
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
    baseline: options.baseline ?? null,
    statusRequest: 0,
    pending: opened.pendingWrite ?? null,
    pushContinuations: opened.pushContinuations ?? [],
    recoveryNotice: null,
    draft: opened.preferences?.draft ?? "",
    reviewProgress: opened.preferences?.reviewProgress,
    projectHostId: opened.projectHostId,
    personalWrites: Promise.resolve(),
    outcome: opened.reviewOutcome ?? "reviewed",
    unrecordedHeadOp: null,
    returnedOutcome: null,
    disconnected: false,
    diffs: new Map(),
    terminals: new Set(),
  };
  if (session.reviewId) {
    try {
      await remoteReviewPort.accept(session.reviewId, session.sessionId);
    } catch (error) {
      const bound = [...remoteSessions.values()].some((previous) => previous.reviewId === session.reviewId);
      await closeRemoteSession(session, "open_failed", bound || epoch !== remoteOpenEpoch);
      throw normalizeError(error);
    }
  }
  keepCurrent();
  for (const previous of [...remoteSessions.values()]) {
    await closeRemoteSession(previous, "cancelled", previous.reviewId === options.reviewId);
    keepCurrent();
  }
  remoteSessions.set(key, session);
  noteRemoteState();
  if (opened.events) void readRemoteEvents(session);
  if (session.pending) {
    // 打开时后端已经带回持久记录：只核对回执，不重发写入。
    await recoverRemoteWrite(session).catch(() => undefined);
  }
  keepCurrent();
  return {
    kind: "opened",
    repository: openedRemote(session),
    key,
    host,
    path: root,
    pending: session.pending,
    reviewId: session.reviewId,
    credentialNote: opened.snapshot.credentialNote,
    preferencesWarning: opened.preferencesWarning,
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
    connectionId: session.sessionId,
    pushContinuation: currentPushContinuation(session),
    recoveryNotice: session.recoveryNotice,
  };
}

function recentWithRemote(recent: RecentRepo[], remotes: RemoteRecentRepo[] = []): RecentRepo[] {
  return [
    ...recent,
    ...remotes.map((repo) => ({
      name: repo.name,
      path: remoteRepositoryKey(repo.targetId, repo.path),
      ...(repo.projectHostId ? { projectHostId: repo.projectHostId } : {}),
      host: repo.host,
      remotePath: repo.path,
      openedAtMs: repo.openedAtMs,
    })),
  ].sort((a, b) => b.openedAtMs - a.openedAtMs);
}

async function saveRemotePreference(
  session: RemoteRepositorySession,
  op: "desktopSaveRemoteDraft" | "desktopSaveReviewProgress",
  fields: BridgePayload,
): Promise<void> {
  const write = session.personalWrites.catch(() => undefined).then(() => remoteWorktreePort.call({
    sessionId: session.sessionId, op, fields,
  }));
  session.personalWrites = write;
  await write;
}

async function saveRemoteReviewProgress(path: string, progress: StoredReviewProgress): Promise<void> {
  const session = remoteSession(path);
  await saveRemotePreference(session, "desktopSaveReviewProgress", { progress });
  session.reviewProgress = progress;
}

function currentPushContinuation(session: RemoteRepositorySession): RemotePushContinuation | null {
  return session.pushContinuations.find((intent) =>
    intent.commitOperationId && intent.head === session.latest.head && intent.branch === session.latest.branch,
  ) ?? null;
}

async function retryRemotePush(path: string, generation: number): Promise<{ snapshot: StatusSnapshot; warning: string | null }> {
  const session = remoteBridgeSession(path, generation);
  const commitOperationId = currentPushContinuation(session)?.commitOperationId;
  if (!commitOperationId) {
    throw remoteError("push_intent_changed", "当前分支和提交没有可核对的待推送记录。", generation);
  }
  try {
    const snapshot = await remoteBridgeWrite(session, generation, "resumePush", { commitOperationId });
    return { snapshot: remoteStatus(snapshot, session.generation), warning: null };
  } catch (error) {
    const failure = normalizeError(error);
    if (failure.code !== "push_tracking_unfinished" || failure.message !== session.recoveryNotice) throw error;
    return { snapshot: remoteStatus(session.latest, session.generation), warning: failure.message };
  }
}

/**
 * 一次「返回 Cliora」的结果：sent 是这次真的送出了新阶段，message 是给用户的一句话；
 * duplicate 只表示这次会话自己已经送过同一阶段，本次没有发送任何内容。
 */
export type RemoteReturnOutcome =
  | { state: "sent"; outcome: RemoteReviewOutcome; message: string }
  | { state: "duplicate"; message: string };

/**
 * 返回前给用户的一句话：声明的是哪个阶段，以及为什么没能声明更高的阶段。
 *
 * 合入与修订经桥接执行，原生审查账本里没有对应的合入提交，所以这两类只能在 reviewed
 * 上停留；这里把真实原因说出来，不把「送不上去」写成「已经合入」。
 */
function remoteReturnMessage(session: RemoteRepositorySession): string {
  if (session.outcome === "merged") {
    return "已向原 Cliora 会话返回远端审查结果（merged）。";
  }
  const merged = session.unrecordedHeadOp === "mergeComplete";
  if (session.outcome === "reviewed") {
    if (merged) {
      return "已返回 cliora：远端合入未记录提交，无法作为 merged 送回 Cliora，本次按 reviewed 声明。";
    }
    if (session.unrecordedHeadOp) {
      return "已返回 cliora：远端这次的新提交没有登记进审查记录，无法作为 committed 送回 Cliora，本次按 reviewed 声明。";
    }
    return "已向原 Cliora 会话返回远端审查结果（reviewed）。";
  }
  return merged
    ? "已向原 Cliora 会话返回远端审查结果（committed）；远端这次合入仍未记录提交，没有作为 merged 声明。"
    : "已向原 Cliora 会话返回远端审查结果（committed）。";
}

/** 向原 Cliora 会话返回审查结果：只发送真实 Git 结果，不推进任何本地仓库状态。 */
export async function remoteReturnReview(key: string): Promise<RemoteReturnOutcome> {
  const session = remoteSession(key);
  if (!session.reviewId) throw remoteError("remote_review", "这次打开不是 Cliora 远端审查，没有可返回的来源。");
  if (session.pending) {
    throw remoteError("write_pending", "请先核对远端操作结果，再返回 Cliora。", session.generation);
  }
  const declared = session.outcome;
  let confirmed: RemoteReviewOutcome | void;
  try {
    // 阶段由这次会话里真正被审查账本登记的提交决定。什么都没有就是 reviewed，而这个
    // 阶段沿旧调用方的语义省略 outcome：端口与后端都把它当缺省值处理，协议保持向后兼容。
    if (declared === "reviewed") {
      confirmed = await remoteReviewPort.returnReview(session.reviewId, session.sessionId);
    } else {
      confirmed = await remoteReviewPort.returnReview(session.reviewId, session.sessionId, declared);
    }
  } catch (error) {
    const failure = normalizeError(error);
    // conflict 有两种来源：同一阶段已经送回，或这次声明的证据不足（阶段被别处推进、
    // 审查账本里没有记录提交）。只有前一种能说成「已经送回」——判据是这次会话自己
    // 成功送过不早于它的阶段；其余一律把后端原因原样抛给用户。
    const sent = session.returnedOutcome;
    if (
      failure.code === "conflict" &&
      sent !== null &&
      REVIEW_OUTCOME_ORDER.indexOf(sent) >= REVIEW_OUTCOME_ORDER.indexOf(declared)
    ) {
      return { state: "duplicate", message: "这一阶段已经送回 Cliora，本次没有重复发送。" };
    }
    throw failure;
  }
  checkRemoteResponse(session);
  const outcome = confirmed ?? declared;
  session.returnedOutcome = outcome;
  return { state: "sent", outcome, message: remoteReturnMessage({ ...session, outcome }) };
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
  documentRemoteImage: (url: string, requestId: number, _repository?: string) => invoke<FilePreview>("document_remote_image", { url, requestId }),
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
    // 本机后端总会给出 created；缺省只可能来自远端的原生桥接，那种情况不登记（不知道就不声明）。
    if ((result.created ?? 0) > 0 && result.headOid) recordClioraCommit(path, result.headOid, reviewId);
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
    // 同上：created 缺省表示原生桥接没回传，不能据此登记「已提交」。
    if (result.wrote && (result.created ?? 0) > 0 && result.headOid) {
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
    _prepared?: ChangeRequestPrepare,
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
  changeRequestTokenStatus: (path: string, remote: string, generation: number, requestId: number, _prepared?: ChangeRequestPrepare) =>
    invoke<ChangeRequestTokenStatus>("change_request_token_status", { path, remote, generation, requestId }),
  /** 保存或替换当前实例的令牌：只经 IPC 参数进入原生，随后直接写入系统钥匙串。 */
  setChangeRequestToken: (
    path: string,
    remote: string,
    token: string,
    generation: number,
    requestId: number,
    _prepared?: ChangeRequestPrepare,
  ) =>
    invoke<ChangeRequestTokenStatus>("change_request_set_token", {
      path,
      remote,
      token,
      generation,
      requestId,
    }),
  /** 只删除用户显式点选的当前实例令牌；关闭功能开关不会调用它。 */
  deleteChangeRequestToken: (path: string, remote: string, generation: number, requestId: number, _prepared?: ChangeRequestPrepare) =>
    invoke<ChangeRequestTokenStatus>("change_request_delete_token", { path, remote, generation, requestId }),
  setPanelWidths: (widths: PanelWidths) => invoke<PanelWidths>("set_panel_widths", { widths }),
  saveDraft: (path: string, message: string) => invoke<void>("save_draft", { path, message }),
  cancelReads: () => invoke<void>("cancel_reads"),
  /** 本机可用的终端类型，第一项是平台默认。 */
  terminalProfiles: (_repository?: string) => invoke<TerminalProfile[]>("terminal_profiles"),
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
  /**
   * 准备 feedback-v1 交接：原生核对来源、结果版本、工作树与任务起点，写入私有一次性文件并
   * 回读核对后才打开只带标识与 digest 的深链。失败时不打开 cliora，也不做任何 Agent 操作。
   */
  prepareReviewFeedback: (request: ReviewFeedbackRequest) =>
    invoke<ReviewFeedbackPrepared>("prepare_review_feedback", { request }),
};

/* ------------------------------------------------------------------ *
 * 分派：同一个方法名按仓库键落到本机或远端；远端仓库绝不落回本机 Git。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 远端桥接（B2）：历史、分支标签、同步、stash、合并与 worktree
 *
 * 这些能力全部经 remote_worktree_call 走 op 白名单：未列入白名单的 op 由后端直接拒绝
 * （remote_unsupported），这里既不回退本机 Git，也不假装成功。只读 op 直接返回 agent v2
 * 的同名 DTO；写入 op 只回一次新状态与回执，因此 DTO 由「回执 + 重新读取一次只读 op」组成，
 * 由重新读取得到的字段都在 note 里注明来源，绝不把没读到的证据写成成功。
 * ------------------------------------------------------------------ */

type BridgePayload = Record<string, unknown>;

/** 明确「远端这次什么都没写」的桥接错误：可以放心把结果说成失败，也不需要核对。 */
const BRIDGE_DEFINITIVE_CODES = new Set([
  ...DEFINITIVE_WRITE_CODES,
  "remote_unsupported",
  "invalid_request",
  "unsupported_operation",
  "unsupported_capability",
  "state_mismatch",
  "operation_conflict",
  "invalid_operation",
  "invalid_patch",
  "push_intent_changed",
  "write_locked",
]);

/** 桥接方法共用的前置检查：断线只读、迟到的代次不发送。 */
function remoteBridgeSession(path: string, generation: number): RemoteRepositorySession {
  const session = remoteSession(path);
  if (session.disconnected) {
    throw remoteError("remote_disconnected", "远端连接已断开，这次操作没有发送；请重新打开这个远端仓库。");
  }
  if (generation !== session.generation) {
    throw remoteError("stale", "远端仓库已有变化，请刷新后重试。", session.generation);
  }
  return session;
}

function bridgePayload(value: unknown, op: string): BridgePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw remoteError("remote_protocol", "远端返回的数据无效（" + op + "）。");
  }
  return value as BridgePayload;
}

/** 取结果里的那个 DTO 字段；缺字段说明协议不对，不能当成空结果。 */
function bridgeField<T>(result: BridgePayload, name: string): T {
  const value = result[name];
  if (value === undefined || value === null) {
    throw remoteError("remote_protocol", "远端返回的数据缺少 " + name + " 字段。");
  }
  return value as T;
}

async function remoteFileRead<T extends { generation: number }>(
  session: RemoteRepositorySession,
  op: RemoteCallOp,
  field: string,
  fields: BridgePayload,
  requestId?: number,
): Promise<T> {
  const result = await remoteBridgeRead(session, op, fields, requestId);
  if (result.repo !== session.repo) {
    throw remoteError("remote_protocol", "远端文件响应缺少当前工作树标识。");
  }
  return { ...bridgeField<T>(result, field), generation: session.generation };
}

function remoteDocumentSource(session: RemoteRepositorySession, source: DocumentSource): DocumentSource {
  if (source.repository && source.repository !== session.key) {
    throw remoteError("document_repository", "文档来源属于另一棵工作树。");
  }
  return { ...source, repository: session.repo };
}

const REMOTE_TERMINAL_PREFIX = "ssh-terminal:";
const rawTerminalId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function remoteTerminalId(session: RemoteRepositorySession, id: string): string {
  return `${REMOTE_TERMINAL_PREFIX}${session.sessionId}:${id}`;
}

function terminalRoute(id: string): { session: RemoteRepositorySession; raw: string } | null {
  if (!id.startsWith(REMOTE_TERMINAL_PREFIX)) return null;
  const [connection, raw, ...rest] = id.slice(REMOTE_TERMINAL_PREFIX.length).split(":");
  const session = [...remoteSessions.values()].find((current) => current.sessionId === connection);
  if (!session || session.disconnected || !rawTerminalId(raw) || rest.length || !session.terminals.has(raw)) {
    throw remoteError("terminal_closed", "远端终端已失效；请重新连接仓库后新建终端。");
  }
  return { session, raw };
}

function bindRemoteTerminal(session: RemoteRepositorySession, snapshot: TerminalSnapshot): TerminalSnapshot {
  if (!snapshot || !rawTerminalId(snapshot.sessionId) || snapshot.repoPath !== session.repo) {
    throw remoteError("remote_protocol", "远端终端归属无法核对。");
  }
  session.terminals.add(snapshot.sessionId);
  return { ...snapshot, sessionId: remoteTerminalId(session, snapshot.sessionId), repoPath: session.key };
}

async function remoteTerminalCall(
  session: RemoteRepositorySession,
  op: RemoteTerminalOp,
  fields: BridgePayload = {},
): Promise<BridgePayload> {
  if (session.disconnected) throw remoteError("remote_disconnected", "远端终端连接已断开。请重新打开仓库。");
  try {
    const payload = bridgePayload(await remoteWorktreePort.call({ sessionId: session.sessionId, op, fields }), op);
    checkRemoteResponse(session);
    if (payload.repo !== session.repo) {
      throw remoteError("target_changed", "远端终端不属于已打开的工作树。");
    }
    return payload;
  } catch (error) {
    const failure = normalizeError(error);
    if (DISCONNECT_CODES.has(failure.code) && remoteSessions.get(session.key) === session) {
      session.disconnected = true;
      noteRemoteState();
    }
    throw failure;
  }
}

function publishRemoteEvent(name: string, detail: object): void {
  remoteEvents.dispatchEvent(new CustomEvent(name, { detail }));
}

async function readRemoteEvents(session: RemoteRepositorySession): Promise<void> {
  const chunks = new Map<string, { seq: number; parts: number; chunks: string[] }>();
  let changeSeq = 0;
  const resync = (raw: string) => publishRemoteEvent(TERMINAL_OUTPUT_EVENT, {
    sessionId: remoteTerminalId(session, raw), seq: 0, data: "", replay: true,
  });
  try {
    while (remoteSessions.get(session.key) === session && !session.disconnected) {
      const batch = await remoteWorktreePort.events(session.sessionId);
      if (remoteSessions.get(session.key) !== session || session.disconnected) return;
      let changed = batch.overflow;
      if (batch.overflow) {
        chunks.clear();
        session.terminals.forEach(resync);
      }
      for (const event of batch.events) {
        if (event.repo !== session.repo || typeof event.seq !== "number" || !Number.isSafeInteger(event.seq)) continue;
        const seq = event.seq;
        if (event.event === "change" && seq > changeSeq) {
          changeSeq = seq;
          changed = true;
        }
        const raw = event.sessionId;
        if (!rawTerminalId(raw) || !session.terminals.has(raw)) continue;
        const sessionId = remoteTerminalId(session, raw);
        if (event.event === "terminalExit" && typeof event.exitCode === "number") {
          chunks.delete(raw);
          publishRemoteEvent(TERMINAL_EXIT_EVENT, {
            sessionId, seq, exitCode: event.exitCode,
            signal: typeof event.signal === "string" ? event.signal : null,
          });
        } else if (event.event === "terminalOutput") {
          const { part, parts, data } = event;
          if (typeof part !== "number" || typeof parts !== "number" || typeof data !== "string"
              || !Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 32
              || part < 0 || part >= parts || data.length > 64 * 1024) continue;
          if (part === 0) chunks.set(raw, { seq, parts, chunks: [] });
          const frame = chunks.get(raw);
          if (!frame || frame.seq !== seq || frame.parts !== parts || frame.chunks.length !== part) {
            chunks.delete(raw);
            resync(raw);
            continue;
          }
          frame.chunks.push(data);
          if (frame.chunks.length === parts) {
            chunks.delete(raw);
            publishRemoteEvent(TERMINAL_OUTPUT_EVENT, { sessionId, seq, data: frame.chunks.join("") });
          }
        }
      }
      if (batch.disconnected) {
        session.disconnected = true;
        noteRemoteState();
        return;
      }
      if (changed) {
        session.generation = ++remoteGeneration;
        session.diffs.clear();
        publishRemoteEvent("repo-changed", { path: session.key, generation: session.generation, degraded: false });
      }
    }
  } catch (error) {
    if (remoteSessions.get(session.key) !== session || session.disconnected) return;
    if (DISCONNECT_CODES.has(normalizeError(error).code)) {
      session.disconnected = true;
      noteRemoteState();
      return;
    }
    session.latest = { ...session.latest, watchDegraded: true };
    publishRemoteEvent("repo-changed", { path: session.key, generation: session.generation, degraded: true });
  }
}

/**
 * 只读 op：字段直通，结果原样带回。
 *
 * 不带 generation：代次只用于写入的新旧核对，只读入口按 v2 的字段表也不收它；
 * 多带一个字段会让远端把整条请求判成无效，读不到东西。
 */
async function remoteBridgeRead(
  session: RemoteRepositorySession,
  op: RemoteCallOp,
  fields: BridgePayload = {},
  readId?: number,
): Promise<BridgePayload> {
  const generation = session.generation;
  let result: unknown;
  try {
    result = await remoteWorktreePort.call({
      sessionId: session.sessionId,
      op,
      fields,
      ...(readId === undefined ? {} : { readId }),
    });
  } catch (error) {
    checkRemoteResponse(session, generation);
    const failure = normalizeError(error);
    if (DISCONNECT_CODES.has(failure.code) && !session.disconnected) {
      session.disconnected = true;
      noteRemoteState();
    }
    throw failure;
  }
  checkRemoteResponse(session, generation);
  const payload = bridgePayload(result, op);
  if (payload.repo !== undefined && payload.repo !== session.repo) {
    throw remoteError("target_changed", "远端返回了另一棵工作树的数据。");
  }
  return payload;
}

/**
 * 写入 op：与 write 共用同一套待确认语义。
 *
 * 远端只回「有没有生效」与新状态，具体 DTO 由调用方再读一次；没有回执时按结果未知处理，
 * 记一条待确认把写入关掉（operationId 只有远端有，重新打开时由持久记录带回）。
 */
async function remoteBridgeWrite(
  session: RemoteRepositorySession,
  generation: number,
  op: RemoteWriteOp,
  fields: BridgePayload = {},
): Promise<RemoteWorktreeSnapshot> {
  return (await remoteBridgeWriteResult(session, generation, op, fields)).snapshot;
}

async function remoteBridgeWriteResult(
  session: RemoteRepositorySession,
  generation: number,
  op: RemoteWriteOp,
  fields: BridgePayload,
): Promise<Extract<RemoteWriteResult, { state: "completed" }>> {
  if (session.disconnected) {
    throw remoteError("remote_disconnected", "远端连接已断开，本次写入没有发送。");
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
  session.pending = { operationId: "", op };
  noteRemoteState();
  let result: RemoteWriteResult;
  try {
    // 状态令牌由原生桥接从最近一次 status/diff 刷新里带上；这里给的是同一个数值代次，
    // 后端只在能解析成 u64 时才把它转成数字 generation 发给 v2 远端。
    result = (await remoteWorktreePort.call({
      sessionId: session.sessionId,
      op,
      fields,
      generation: session.token,
    })) as RemoteWriteResult;
  } catch (error) {
    checkRemoteResponse(session);
    const failure = normalizeError(error);
    if (BRIDGE_DEFINITIVE_CODES.has(failure.code)) {
      session.pending = null;
      noteRemoteState();
      throw failure;
    }
    throw remoteError(
      "write_pending",
      failure.message || "远端操作结果待确认，请重新打开这个远端仓库核对。",
      session.generation,
    );
  }
  await settleRemoteWrite(session, result, op);
  if (result.state !== "completed") {
    throw remoteError("remote_protocol", "远端写入回执格式无效。");
  }
  return result;
}

async function remoteGitPreview<T extends { generation: number; snapshot: StatusSnapshot }>(
  session: RemoteRepositorySession,
  op: RemoteCallOp,
  field: string,
  args: BridgePayload,
): Promise<T> {
  const value = bridgeField<T>(await remoteBridgeRead(session, op, args), field);
  const generation = session.generation;
  return { ...value, generation, snapshot: { ...value.snapshot, generation } };
}

async function remoteGitResult<T extends { generation: number; snapshot: StatusSnapshot }>(
  session: RemoteRepositorySession,
  generation: number,
  op: RemoteWriteOp,
  field: string,
  args: BridgePayload,
): Promise<T> {
  const result = await remoteBridgeWriteResult(session, generation, op, args);
  const value = bridgeField<T>(result, field);
  return { ...value, generation: session.generation, snapshot: remoteStatus(result.snapshot, session.generation) };
}

async function remoteDeleteEntries(path: string, relatives: string[], permanent: boolean, generation: number): Promise<BatchDeleteResult> {
  const session = remoteBridgeSession(path, generation);
  const result = await remoteBridgeWriteResult(session, generation, "deleteEntries", { relatives, permanent });
  const deletion = result.delete;
  if (!deletion || !Array.isArray(deletion.deleted) || !Array.isArray(deletion.skipped) || !Array.isArray(deletion.failures)) {
    throw remoteError("remote_protocol", "已核对远端操作，未收到删除明细。请刷新工作树查看结果。");
  }
  return { ...deletion, snapshot: remoteStatus(result.snapshot, session.generation) };
}

/**
 * 写入之后的分支状态：远端回执只有新状态，分支列表要再读一次。
 * 代次换成本会话的数值代次，旧响应比较与其它仓库一致。
 */
async function remoteBranchStateOf(
  session: RemoteRepositorySession,
  snapshot: RemoteWorktreeSnapshot,
): Promise<BranchState> {
  const result = await remoteBridgeRead(session, "branchState");
  const state = bridgeField<BranchState>(result, "branchState");
  return { ...state, generation: session.generation, snapshot: remoteStatus(snapshot, session.generation) };
}

async function remoteTagStateOf(
  session: RemoteRepositorySession,
  snapshot: RemoteWorktreeSnapshot,
): Promise<TagState> {
  const result = await remoteBridgeRead(session, "tagState");
  const state = bridgeField<TagState>(result, "tags");
  return { ...state, generation: session.generation, snapshot: remoteStatus(snapshot, session.generation) };
}

async function remoteRemoteStateOf(
  session: RemoteRepositorySession,
  snapshot: RemoteWorktreeSnapshot,
): Promise<RemoteState> {
  const result = await remoteBridgeRead(session, "remoteState");
  const state = bridgeField<RemoteState>(result, "remote");
  return { ...state, generation: session.generation, snapshot: remoteStatus(snapshot, session.generation) };
}

async function remoteStashStateOf(
  session: RemoteRepositorySession,
  snapshot: RemoteWorktreeSnapshot,
  includeUntracked: boolean,
): Promise<StashState> {
  const result = await remoteBridgeRead(session, "stashState", { includeUntracked });
  const state = bridgeField<StashState>(result, "stash");
  return { ...state, generation: session.generation, snapshot: remoteStatus(snapshot, session.generation) };
}

async function remoteMergeSessionOf(
  session: RemoteRepositorySession,
  snapshot: RemoteWorktreeSnapshot,
): Promise<MergeSession> {
  const result = await remoteBridgeRead(session, "mergeSession");
  const state = bridgeField<MergeSession>(result, "merge");
  return { ...state, generation: session.generation, snapshot: remoteStatus(snapshot, session.generation) };
}


async function remoteStageMany(
  path: string,
  paths: string[],
  generation: number,
  op: "stage" | "unstage",
): Promise<StatusSnapshot> {
  const session = remoteBridgeSession(path, generation);
  const snapshot = paths.length === 0 ? session.latest : await remoteBridgeWrite(session, generation, op, { paths });
  return remoteStatus(snapshot, session.generation);
}

async function closeAllRemoteSessions(): Promise<void> {
  remoteOpenEpoch += 1;
  for (const session of [...remoteSessions.values()]) {
    await closeRemoteSession(session, "cancelled");
  }
}

export async function closeRemoteRepository(key: string): Promise<void> {
  const session = remoteSessions.get(key);
  if (!session) return;
  await closeRemoteSession(session, "cancelled");
}

export interface LinkedWorktreeRemoval {
  target: string;
  token: string;
  branch: string | null;
  head: string | null;
}

function sameRemoteWorktreePath(left: string, right: string): boolean {
  const normalizeDrive = (path: string) => /^[a-z]:[\\/]/i.test(path)
    ? path[0].toUpperCase() + path.slice(1).replace(/\\/g, "/")
    : path;
  return normalizeDrive(left) === normalizeDrive(right);
}

async function linkedWorktreeHeads(anchor: string, paths: string[]): Promise<RepoHead[]> {
  const session = remoteSession(anchor);
  const overview = bridgeField<WorktreeOverview>(await remoteBridgeRead(session, "worktrees"), "worktrees");
  return paths.flatMap((path) => {
    const item = overview.items.find((row) => sameRemoteWorktreePath(row.path, path));
    return item ? [{ path, branch: item.branch, detached: item.detached, missing: item.missing,
      worktree: item.linked, mainPath: item.mainPath }] : [];
  });
}

async function linkedWorktreeOverview(anchor: string): Promise<WorktreeOverview> {
  const session = remoteSession(anchor);
  const overview = bridgeField<WorktreeOverview>(await remoteBridgeRead(session, "worktrees"), "worktrees");
  return { ...overview, items: overview.items.map((item) => ({
    ...item,
    path: remoteRepositoryKey(session.hostId, item.path),
    mainPath: item.mainPath === null ? null : remoteRepositoryKey(session.hostId, item.mainPath),
  })) };
}

async function previewLinkedWorktreeRemoval(anchor: string, target: string, generation: number): Promise<LinkedWorktreeRemoval> {
  const session = remoteBridgeSession(anchor, generation);
  const read = () => remoteBridgeRead(session, "worktreeRemovalPreview", { target });
  let result;
  try {
    result = await read();
  } catch (error) {
    // A watcher refresh can advance the anchor while the peer reads the sibling.
    if (normalizeError(error).code !== "stale") throw error;
    checkRemoteResponse(session);
    result = await read();
  }
  const preview = bridgeField<LinkedWorktreeRemoval>(result, "preview");
  if (!sameRemoteWorktreePath(preview.target, target) || !/^[a-f0-9]{64}$/.test(preview.token)) {
    throw remoteError("remote_protocol", "远端返回了另一棵工作区的删除预览。");
  }
  return preview;
}

async function removeLinkedWorktree(anchor: string, preview: LinkedWorktreeRemoval, force: boolean, generation: number): Promise<StatusSnapshot> {
  const session = remoteBridgeSession(anchor, generation);
  const snapshot = await remoteBridgeWrite(session, generation, "worktreeRemoveTarget", {
    target: preview.target, targetToken: preview.token, force,
  });
  return remoteStatus(snapshot, session.generation);
}

async function openLinkedWorktree(anchor: string, target: string): Promise<OpenedRepository> {
  const session = remoteSession(anchor);
  const overview = bridgeField<WorktreeOverview>(await remoteBridgeRead(session, "worktrees"), "worktrees");
  const worktree = overview.items.find((item) => !item.missing && sameRemoteWorktreePath(item.path, target));
  if (!worktree) throw remoteError("target_changed", "选中的路径已不在远端仓库的工作区列表中。");
  const result = await openRemote(
    { kind: "ssh", hostId: session.hostId, hostRevision: session.hostRevision, path: worktree.path },
    { projectHostId: session.projectHostId },
  );
  if (result.kind !== "opened") throw remoteError("remote_install_required", "请在打开远端仓库时确认升级组件。");
  return result.repository;
}

async function openRemoteProjectRepository(key: string, workspaceHostId: string): Promise<OpenedRepository> {
  const location = parseRemoteRepositoryKey(key);
  if (!location) throw remoteError("invalid_path", "项目里的 SSH 仓库位置无效。");
  const target = (await remoteTargets()).find((host) => host.targetId === location.hostId && !host.unavailableReason);
  if (!target) throw remoteError("target_unavailable", "项目绑定的 SSH 主机不可用。");
  const result = await openRemote(
    { kind: "ssh", hostId: location.hostId, hostRevision: target.targetRevision, path: location.path },
    { projectHostId: workspaceHostId },
  );
  if (result.kind !== "opened") throw remoteError("remote_install_required", "请确认安装或升级 SSH 主机的组件。");
  return result.repository;
}

async function openRemoteFileCopy(path: string, relative: string, generation: number, reveal: boolean) {
  const session = remoteBridgeSession(path, generation);
  await invoke<void>("remote_worktree_file_copy", {
    request: { sessionId: session.sessionId, generation: session.token, relative, reveal },
  });
}

async function remoteProjectCandidates(path: string, selection: { root: string } | { paths: string[] }, requestId: number) {
  const session = remoteSession(path);
  const result = await remoteBridgeRead(session, "projectCandidates", selection, requestId);
  if (result.repo !== session.repo) throw remoteError("remote_protocol", "远端仓库候选属于另一工作区会话。");
  return bridgeField<WorkspaceDiscovery>(result, "discovery");
}

async function cancelRemoteProjectCandidates(path: string, requestId: number) {
  const session = remoteSession(path);
  await remoteWorktreePort.cancelReads(session.sessionId, requestId);
}

const apiExtras = {
  openRemoteFileCopy,
  remoteProjectCandidates,
  cancelRemoteProjectCandidates,
  remoteTargets,
  openRemoteRepository,
  remoteReturnReview,
  remoteRepositoryState,
  saveRemoteReviewProgress,
  retryRemotePush,
  onRemoteStateChange,
  closeRemoteRepository,
  linkedWorktreeHeads,
  linkedWorktreeOverview,
  previewLinkedWorktreeRemoval,
  removeLinkedWorktree,
  openLinkedWorktree,
  openRemoteProjectRepository,
};

function preparedChangeSource(prepared?: ChangeRequestPrepare) {
  if (!prepared || prepared.status !== "ready") {
    throw remoteError("change_request_stale", "请重新打开创建 MR/PR 的页面并核对远程仓库。");
  }
  const { provider, host, repository, repositoryWeb, sourceBranch } = prepared;
  return { provider, host, repository, repositoryWeb, sourceBranch };
}

async function remoteChangeRequest<T>(session: RemoteRepositorySession, fields: BridgePayload): Promise<T> {
  return invoke<T>("remote_change_request", {
    request: { sessionId: session.sessionId, generation: session.token, ...fields },
  });
}

const remoteOverrides: Record<string, unknown> = {
  async getSettings(): Promise<SettingsDto> {
    const settings = await apiBase.getSettings();
    return { ...settings, recent: recentWithRemote(settings.recent, settings.remoteRecent) };
  },
  async ignorePath(path: string, pattern: string, local: boolean, generation: number, requestId: number): Promise<IgnoreOutcome> {
    if (!isRemoteRepositoryKey(path)) return apiBase.ignorePath(path, pattern, local, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeWriteResult(session, generation, "ignorePath", { pattern, local });
    if (typeof result.ignore?.note !== "string") {
      throw remoteError("remote_protocol", "已写入忽略规则，但远端未返回操作说明。");
    }
    return { snapshot: remoteStatus(result.snapshot, session.generation), note: result.ignore.note };
  },

  async prepareChangeRequest(path: string, remote: string | null, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.prepareChangeRequest(path, remote, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const prepared = await remoteChangeRequest<ChangeRequestPrepare>(session, { action: "prepare", remote });
    checkRemoteResponse(session, generation);
    return { ...prepared, generation };
  },

  async createChangeRequest(path: string, remote: string, targetBranch: string, title: string, body: string,
    generation: number, requestId: number, prepared?: ChangeRequestPrepare) {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.createChangeRequest(path, remote, targetBranch, title, body, generation, requestId);
    }
    return remoteChangeRequest<ChangeRequestOutcome>(remoteBridgeSession(path, generation), {
      action: "create", remote, targetBranch, title, body, expected: preparedChangeSource(prepared),
    });
  },

  async changeRequestTokenStatus(path: string, remote: string, generation: number, requestId: number, prepared?: ChangeRequestPrepare) {
    if (!isRemoteRepositoryKey(path)) return apiBase.changeRequestTokenStatus(path, remote, generation, requestId);
    return remoteChangeRequest<ChangeRequestTokenStatus>(remoteBridgeSession(path, generation), {
      action: "token", remote, expected: preparedChangeSource(prepared), credential: { operation: "status" },
    });
  },

  async setChangeRequestToken(path: string, remote: string, token: string, generation: number, requestId: number, prepared?: ChangeRequestPrepare) {
    if (!isRemoteRepositoryKey(path)) return apiBase.setChangeRequestToken(path, remote, token, generation, requestId);
    return remoteChangeRequest<ChangeRequestTokenStatus>(remoteBridgeSession(path, generation), {
      action: "token", remote, expected: preparedChangeSource(prepared), credential: { operation: "set", token },
    });
  },

  async deleteChangeRequestToken(path: string, remote: string, generation: number, requestId: number, prepared?: ChangeRequestPrepare) {
    if (!isRemoteRepositoryKey(path)) return apiBase.deleteChangeRequestToken(path, remote, generation, requestId);
    return remoteChangeRequest<ChangeRequestTokenStatus>(remoteBridgeSession(path, generation), {
      action: "token", remote, expected: preparedChangeSource(prepared), credential: { operation: "delete" },
    });
  },

  async openRepository(path: string, requestId: number): Promise<OpenedRepository> {
    if (!isRemoteRepositoryKey(path)) {
      const repository = await apiBase.openRepository(path, requestId);
      // 确认切到本机仓库之后才结束远端会话：一条连接只服务一个当前仓库，
      // 但打开失败时当前远端仓库必须原样留着，不能替用户把它结束掉。
      await closeAllRemoteSessions();
      return repository;
    }
    const parsed = parseRemoteRepositoryKey(path);
    if (!parsed) throw remoteError("invalid_path", "远端仓库地址无效。");
    const targets = await remoteTargets();
    const target = targets.find((item) => item.targetId === parsed.hostId);
    if (!target) throw remoteError("target_changed", "这台 SSH 主机已不在主机簿里，请重新选择主机。");
    if (target.unavailableReason) throw remoteError("target_unavailable", target.unavailableReason);
    const previous = remoteSessions.get(path);
    const outcome = await openRemote({
      kind: "ssh",
      hostId: target.targetId,
      hostRevision: target.targetRevision,
      path: parsed.path,
    }, previous?.reviewId ? { reviewId: previous.reviewId, baseline: previous.baseline } : {});
    if (outcome.kind !== "opened") {
      throw remoteError(
        "remote_install_required",
        "这台主机还没有可用的 Twiglane 远端组件，请在“打开远端仓库”里确认安装后再打开。",
      );
    }
    return outcome.repository;
  },

  async addRepository(path: string, requestId: number): Promise<OpenedRepository> {
    // 和 openRepository 一样：加成功就是要切换，成功后再结束远端会话；失败不动它。
    const repository = await apiBase.addRepository(path, requestId);
    await closeAllRemoteSessions();
    return repository;
  },

  async refreshStatus(path: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.refreshStatus(path, generation, requestId);
    const session = remoteSession(path);
    const snapshot = await remoteStatusOf(session);
    return remoteStatus(snapshot, session.generation);
  },

  async repositoryDirectory(path: string, relative: string, includeIgnored: boolean, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryDirectory(path, relative, includeIgnored, generation, requestId);
    return remoteFileRead<RepositoryDirectory>(remoteBridgeSession(path, generation), "directory", "directory", { relative, includeIgnored }, requestId);
  },

  async repositoryFileContent(path: string, relative: string, offset: number, limit: number | undefined, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryFileContent(path, relative, offset, limit, generation, requestId);
    return remoteFileRead<RepositoryFileContent>(remoteBridgeSession(path, generation), "fileContent", "content", { relative, offset, limit }, requestId);
  },

  async repositoryPathSearch(path: string, query: string, directory: string | null, includeIgnored: boolean, limit: number | undefined, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryPathSearch(path, query, directory, includeIgnored, limit, generation, requestId);
    return remoteFileRead<RepositoryPathSearch>(remoteBridgeSession(path, generation), "pathSearch", "search", { query, directory, includeIgnored, limit }, requestId);
  },

  async repositoryContentSearch(path: string, query: string, scope: RepositorySearchScope, includeIgnored: boolean, limit: number | undefined, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryContentSearch(path, query, scope, includeIgnored, limit, generation, requestId);
    return remoteFileRead<RepositoryContentSearch>(remoteBridgeSession(path, generation), "contentSearch", "search", { query, scope, includeIgnored, limit }, requestId);
  },

  async filePreview(path: string, source: PreviewSource, generation: number, download = false) {
    if (!isRemoteRepositoryKey(path)) return apiBase.filePreview(path, source, generation, download);
    return remoteFileRead<FilePreview>(remoteBridgeSession(path, generation), "filePreview", "preview", { source, download });
  },

  async repositoryDocument(path: string, source: DocumentSource, generation: number, requestId: number, mode: "document" | "source" = "document", offset = 0, limit?: number, expectedVersion: string | null = null) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryDocument(path, source, generation, requestId, mode, offset, limit, expectedVersion);
    const session = remoteBridgeSession(path, generation);
    const document = await remoteFileRead<RepositoryDocument>(session, "document", "document", {
      source: remoteDocumentSource(session, source), mode, offset, limit, expectedVersion,
    }, requestId);
    if (document.source.repository !== session.repo) {
      throw remoteError("document_repository", "远端文档来源与当前工作树不符。");
    }
    return { ...document, source: { ...document.source, repository: session.key } };
  },

  async documentResource(path: string, source: DocumentSource, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.documentResource(path, source, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteFileRead<FilePreview>(session, "documentResource", "resource", {
      source: remoteDocumentSource(session, source),
    }, requestId);
  },

  async documentRemoteImage(url: string, requestId: number, repository?: string) {
    if (!repository || !isRemoteRepositoryKey(repository)) return apiBase.documentRemoteImage(url, requestId);
    const session = remoteSession(repository);
    if (session.disconnected) throw remoteError("remote_disconnected", "远端仓库已断开，无法读取图片。");
    return bridgeField<FilePreview>(await remoteBridgeRead(session, "documentRemoteImage", { url }, requestId), "image");
  },

  async cancelDocumentResources(requestId: number) {
    await Promise.allSettled([
      apiBase.cancelDocumentResources(requestId),
      ...[...remoteSessions.values()].map((session) => remoteWorktreePort.cancelReads(session.sessionId, requestId)),
    ]);
  },

  async cancelReads() {
    await Promise.all([
      apiBase.cancelReads(),
      ...[...remoteSessions.values()].map((session) => remoteWorktreePort.cancelReads(session.sessionId).catch(() => {})),
    ]);
  },

  async repositoryEditSnapshot(path: string, relative: string, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryEditSnapshot(path, relative, generation, requestId);
    return remoteFileRead<RepositoryEditSnapshot>(remoteBridgeSession(path, generation), "editSnapshot", "edit", { relative }, requestId);
  },

  async repositoryEditSave(path: string, relative: string, expectedDigest: string, content: string, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryEditSave(path, relative, expectedDigest, content, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    let result: Extract<RemoteWriteResult, { state: "completed" }>;
    try {
      result = await remoteBridgeWriteResult(session, generation, "editSave", { path: relative, expectedDigest, content });
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "state_mismatch" && failure.code !== "stale_state") throw error;
      await remoteStatusOf(session);
      throw remoteError("stale", failure.message, session.generation);
    }
    if (!result.edit || result.edit.path !== relative) {
      throw remoteError("remote_protocol", "已确认保存，远端未返回文件版本。请重新读取文件。");
    }
    return { ...result.edit, generation: session.generation };
  },

  async repositoryCreateEntry(path: string, relative: string, kind: "file" | "directory", generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryCreateEntry(path, relative, kind, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteStatus(await remoteBridgeWrite(session, generation, "createEntry", { path: relative, kind }), session.generation);
  },

  async repositoryCopyEntry(path: string, source: string, target: string, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryCopyEntry(path, source, target, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteStatus(await remoteBridgeWrite(session, generation, "copyEntry", { source, target }), session.generation);
  },

  async repositoryMoveEntry(path: string, source: string, target: string, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryMoveEntry(path, source, target, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteStatus(await remoteBridgeWrite(session, generation, "moveEntry", { source, target }), session.generation);
  },

  async repositoryDeleteEntry(path: string, relative: string, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryDeleteEntry(path, relative, generation, requestId);
    const result = await remoteDeleteEntries(path, [relative], false, generation);
    const failed = result.failures[0];
    if (failed) throw remoteError(failed.code, failed.message);
    return result.snapshot;
  },

  async repositoryDeleteEntries(path: string, relatives: string[], permanent: boolean, generation: number, requestId: number) {
    if (!isRemoteRepositoryKey(path)) return apiBase.repositoryDeleteEntries(path, relatives, permanent, generation, requestId);
    return remoteDeleteEntries(path, relatives, permanent, generation);
  },

  async terminalProfiles(path?: string) {
    if (!path || !isRemoteRepositoryKey(path)) return apiBase.terminalProfiles();
    return bridgeField<TerminalProfile[]>(await remoteTerminalCall(remoteSession(path), "terminalProfiles"), "profiles");
  },

  async terminalList(path: string) {
    if (!isRemoteRepositoryKey(path)) return apiBase.terminalList(path);
    const session = remoteSession(path);
    return bridgeField<TerminalSnapshot[]>(await remoteTerminalCall(session, "terminalList"), "sessions")
      .map((snapshot) => bindRemoteTerminal(session, snapshot));
  },

  async terminalCreate(path: string, profile: string | null = null) {
    if (!isRemoteRepositoryKey(path)) return apiBase.terminalCreate(path, profile);
    const session = remoteSession(path);
    return bindRemoteTerminal(session, bridgeField(await remoteTerminalCall(session, "terminalCreate", { profile }), "terminal"));
  },

  async terminalAttach(sessionId: string) {
    const route = terminalRoute(sessionId);
    if (!route) return apiBase.terminalAttach(sessionId);
    return bindRemoteTerminal(route.session, bridgeField(await remoteTerminalCall(route.session, "terminalAttach", { sessionId: route.raw }), "terminal"));
  },

  async terminalRestart(sessionId: string) {
    const route = terminalRoute(sessionId);
    if (!route) return apiBase.terminalRestart(sessionId);
    const data = await remoteTerminalCall(route.session, "terminalRestart", { sessionId: route.raw });
    route.session.terminals.delete(route.raw);
    return bindRemoteTerminal(route.session, bridgeField(data, "terminal"));
  },

  async terminalClose(sessionId: string) {
    const route = terminalRoute(sessionId);
    if (!route) return apiBase.terminalClose(sessionId);
    await remoteTerminalCall(route.session, "terminalClose", { sessionId: route.raw });
    route.session.terminals.delete(route.raw);
  },

  async terminalWrite(sessionId: string, data: string) {
    const route = terminalRoute(sessionId);
    if (!route) return apiBase.terminalWrite(sessionId, data);
    await remoteTerminalCall(route.session, "terminalInput", { sessionId: route.raw, data });
  },

  async terminalResize(sessionId: string, rows: number, cols: number) {
    const route = terminalRoute(sessionId);
    if (!route) return apiBase.terminalResize(sessionId, rows, cols);
    await remoteTerminalCall(route.session, "terminalResize", { sessionId: route.raw, rows, cols });
  },

  async taskReview(path: string, baseline: string, generation: number, requestId: number): Promise<TaskReview> {
    if (!isRemoteRepositoryKey(path)) return apiBase.taskReview(path, baseline, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "taskReview", { baseline });
    const review = bridgeField<TaskReview>(result, "review");
    if (typeof review !== "object" || typeof review.baselineOid !== "string" ||
        typeof review.headOid !== "string" || typeof review.rangeVersion !== "string" ||
        !review.branch || !Array.isArray(review.commits) || !Array.isArray(review.files)) {
      throw remoteError("remote_protocol", "远端任务范围响应格式无效，请重新读取。");
    }
    if (review.baselineOid !== session.baseline || review.baselineOid !== baseline) {
      throw remoteError("invalid_baseline", "这次审查的任务起点已变化。");
    }
    return { ...review, worktree: session.key, generation: session.generation };
  },

  async loadTaskDiff(
    path: string,
    baseline: string,
    head: string,
    relative: string,
    generation: number,
    requestId: number,
    original: string | null = null,
    offset = 0,
    limit = 0,
    context?: number,
    asText?: boolean,
  ): Promise<DiffResponse> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.loadTaskDiff(path, baseline, head, relative, generation, requestId, original, offset, limit, context, asText);
    }
    const session = remoteBridgeSession(path, generation);
    if (baseline !== session.baseline) throw remoteError("invalid_baseline", "这次审查的任务起点已变化。");
    const cacheKey = JSON.stringify(["task", relative, original, head, session.token, context, asText]);
    let entry = session.diffs.get(cacheKey);
    if (!entry) {
      const patch = await loadRemotePatch(session, relative, "task", {
        head,
        ...(original ? { original } : {}),
        ...(context === undefined ? {} : { context }),
        ...(asText === undefined ? {} : { asText }),
      });
      checkRemoteResponse(session, generation);
      entry = {
        document: remoteDiffDocument(patch, generation, relative, false, session.token),
        hunksStageableReason: patch.hunksStageableReason ?? REMOTE_HUNKS_UNSTAGEABLE_REASON,
      };
      if (session.diffs.size >= REMOTE_DIFF_CACHE_LIMIT) session.diffs.clear();
      session.diffs.set(cacheKey, entry);
    }
    return { ...remoteDiffPage(entry.document, offset, limit), hunksStageableReason: entry.hunksStageableReason };
  },

  async taskReviewToken(
    path: string, baseline: string, head: string, relative: string, generation: number, requestId: number,
  ): Promise<TaskReviewToken> {
    if (!isRemoteRepositoryKey(path)) return apiBase.taskReviewToken(path, baseline, head, relative, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    if (baseline !== session.baseline) throw remoteError("invalid_baseline", "这次审查的任务起点已变化。");
    const result = await remoteBridgeRead(session, "taskReviewToken", { baseline, head, path: relative });
    const token = bridgeField<TaskReviewToken>(result, "token");
    return { ...token, generation: session.generation };
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
    const cacheKey = JSON.stringify([view, relative, original, context, asText, session.token]);
    let entry = session.diffs.get(cacheKey);
    if (!entry) {
      const patch = await loadRemotePatch(session, relative, view, {
        ...(original ? { original } : {}),
        ...(context === undefined ? {} : { context }),
        ...(asText === undefined ? {} : { asText }),
      });
      // 等待期间切了仓库：这次响应属于旧连接，直接丢弃而不是贴到新仓库上。
      if (remoteSessions.get(path) !== session) {
        throw remoteError("remote_disconnected", "远端仓库已切换，这次差异读取已丢弃。");
      }
      entry = {
        document: remoteDiffDocument(patch, session.generation, relative, staged, patch.snapshot ?? session.token),
        // 原因跟着文档一起缓存：翻页与命中缓存给出的都是同一句话。
        hunksStageableReason: patch.hunksStageableReason,
      };
      if (session.diffs.size >= REMOTE_DIFF_CACHE_LIMIT) session.diffs.clear();
      session.diffs.set(cacheKey, entry);
    }
    if (entry.document.generation !== generation) {
      throw remoteError("stale", "远端仓库已有变化，请刷新后重试。", session.generation);
    }
    return { ...remoteDiffPage(entry.document, offset, limit), hunksStageableReason: entry.hunksStageableReason };
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
    const { snapshot } = await remoteWrite(session, { op: "commit", message }, generation);
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
    const session = remoteBridgeSession(path, generation);
    const token = bridgeField<RepositoryReviewToken>(
      await remoteBridgeRead(session, "reviewToken", { relative }), "token",
    );
    if (token.path !== relative || (token.state === "current" && !/^[a-f0-9]{64}$/.test(token.token ?? ""))) {
      throw remoteError("remote_protocol", "远端返回的审阅令牌与所选文件不一致。");
    }
    return { ...token, generation: session.generation };
  },

  async saveDraft(path: string, message: string): Promise<void> {
    if (!isRemoteRepositoryKey(path)) return apiBase.saveDraft(path, message);
    // 本机草稿库只按本机仓库规范路径保存；远端仓库的草稿留在会话内存里，
    // 换仓库再回来仍然可用，但不会写进本机 state.json。
    const session = remoteSession(path);
    await saveRemotePreference(session, "desktopSaveRemoteDraft", { message });
    session.draft = message;
  },

  /**
   * 新建仓库一定紧接着切换过去：基础命令成功后（确认要切换）才结束远端会话，
   * 否则失败时界面上那个远端仓库会变成一个永远 cancelled 的壳，Cliora 侧还会收到 cancelled。
   */
  async createRepository(path: string, requestId: number): Promise<OpenedRepository> {
    const repository = await apiBase.createRepository(path, requestId);
    await closeAllRemoteSessions();
    return repository;
  },

  /**
   * 克隆**不**在这里结束远端会话：克隆落盘后是否切换由外壳决定（可以点「在后台继续」），
   * 失败更不会切换。真正的关闭发生在外壳确认切换时（App.svelte 的 cloneFinished / cloneRepo
   * 调 closeRemoteRepository），此前当前远端仓库必须保持可用。
   */
  async cloneRepository(
    url: string,
    parent: string,
    name: string,
    requestId: number,
    credential: HttpCredential | null = null,
  ): Promise<CloneResult> {
    return apiBase.cloneRepository(url, parent, name, requestId, credential);
  },

  async forgetRecent(path: string): Promise<RecentRepo[]> {
    if (!isRemoteRepositoryKey(path)) return apiBase.forgetRecent(path);
    const location = parseRemoteRepositoryKey(path);
    if (!location) throw remoteError("invalid_path", "远端仓库位置无效。");
    await closeRemoteRepository(path);
    const result = await remoteWorktreePort.call({
      sessionId: "", op: "desktopForgetRemoteRecent", fields: { targetId: location.hostId, path: location.path },
    }) as { recent: RecentRepo[]; remoteRecent: RemoteRecentRepo[] };
    return recentWithRemote(result.recent, result.remoteRecent);
  },

  /* ---------------------------------------------------------------- *
   * 远端桥接：历史
   * ---------------------------------------------------------------- */

  async historyPage(
    path: string,
    query: string,
    offset: number,
    generation: number,
    requestId: number,
    filters?: HistoryFilters,
  ): Promise<HistoryPage> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.historyPage(path, query, offset, generation, requestId, filters);
    }
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "history", {
      query,
      offset,
      ...historyFilterPayload(filters, false),
    });
    const page = bridgeField<HistoryPage>(result, "page");
    return { ...page, generation: session.generation };
  },

  async fileHistory(
    path: string,
    relative: string,
    offset: number,
    generation: number,
    requestId: number,
    filters?: HistoryFilters,
  ): Promise<FileHistoryPage> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.fileHistory(path, relative, offset, generation, requestId, filters);
    }
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "fileHistory", {
      path: relative,
      offset,
      ...historyFilterPayload(filters, true),
    });
    const page = bridgeField<FileHistoryPage>(result, "page");
    return { ...page, generation: session.generation };
  },

  async commitDetail(
    path: string,
    oid: string,
    parent: string | null,
    generation: number,
    requestId: number,
  ): Promise<CommitDetail> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.commitDetail(path, oid, parent, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "commitDetail", { oid, parent });
    return { ...bridgeField<CommitDetail>(result, "commit"), generation: session.generation };
  },

  async commitFileDiff(
    path: string,
    oid: string,
    parent: string | null,
    relative: string,
    generation: number,
    requestId: number,
    offset = 0,
    limit = 0,
    context?: number,
    asText?: boolean,
  ): Promise<DiffResponse> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.commitFileDiff(path, oid, parent, relative, generation, requestId, offset, limit, context, asText);
    }
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "commitDiff", {
      oid,
      parent,
      path: relative,
      offset,
      ...(limit > 0 ? { limit } : {}),
      ...(context === undefined ? {} : { context }),
      ...(asText ? { asText } : {}),
    });
    return { ...bridgeField<DiffResponse>(result, "diff"), generation: session.generation };
  },

  async compareFiles(
    path: string,
    base: string | null,
    head: string,
    generation: number,
    requestId: number,
  ): Promise<CompareFiles> {
    if (!isRemoteRepositoryKey(path)) return apiBase.compareFiles(path, base, head, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "compare", { base, head });
    return { ...bridgeField<CompareFiles>(result, "compare"), generation: session.generation };
  },

  async compareFileDiff(
    path: string,
    base: string,
    head: string,
    relative: string,
    generation: number,
    requestId: number,
    offset = 0,
    limit = 0,
    context?: number,
  ): Promise<DiffResponse> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.compareFileDiff(path, base, head, relative, generation, requestId, offset, limit, context);
    }
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "compareFileDiff", {
      base,
      head,
      path: relative,
      offset,
      ...(limit > 0 ? { limit } : {}),
      ...(context === undefined ? {} : { context }),
    });
    return { ...bridgeField<DiffResponse>(result, "compareFileDiff"), generation: session.generation };
  },

  async commitBranches(
    path: string,
    oid: string,
    generation: number,
    requestId: number,
  ): Promise<CommitBranches> {
    if (!isRemoteRepositoryKey(path)) return apiBase.commitBranches(path, oid, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "commitBranches", { oid });
    return { ...bridgeField<CommitBranches>(result, "commitBranches"), generation: session.generation };
  },

  /* ---------------------------------------------------------------- *
   * 远端桥接：分支、标签与远程
   * ---------------------------------------------------------------- */

  async branchList(path: string, generation: number, requestId: number): Promise<BranchListing> {
    if (!isRemoteRepositoryKey(path)) return apiBase.branchList(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "branchList");
    return { ...bridgeField<BranchListing>(result, "branches"), generation: session.generation };
  },

  async branchState(path: string, generation: number, requestId: number): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.branchState(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return await remoteBranchStateOf(session, session.latest);
  },

  async branchTracking(path: string, generation: number, requestId: number): Promise<BranchTracking> {
    if (!isRemoteRepositoryKey(path)) return apiBase.branchTracking(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "branchTracking");
    return { ...bridgeField<BranchTracking>(result, "branchTracking"), generation: session.generation };
  },

  async tagState(path: string, generation: number, requestId: number): Promise<TagState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.tagState(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return await remoteTagStateOf(session, session.latest);
  },

  async tagRemoteState(path: string, remote: string): Promise<RemoteTag[]> {
    if (!isRemoteRepositoryKey(path)) return apiBase.tagRemoteState(path, remote);
    // 只读查询：不校验也不推进代次，过期响应由调用方按仓库键丢弃（与本机一致）。
    const session = remoteSession(path);
    if (session.disconnected) {
      throw remoteError("remote_disconnected", "远端连接已断开，这次远程标签读取没有发送。");
    }
    const result = await remoteBridgeRead(session, "tagRemoteState", { remote });
    return bridgeField<RemoteTag[]>(result, "tagRemoteState");
  },

  async remoteState(path: string, generation: number, requestId: number): Promise<RemoteState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.remoteState(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return await remoteRemoteStateOf(session, session.latest);
  },

  async createBranch(path: string, name: string, generation: number, requestId: number): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.createBranch(path, name, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchCreate", { name });
    return await remoteBranchStateOf(session, snapshot);
  },

  async createBranchFrom(
    path: string,
    name: string,
    start: string,
    checkout: boolean,
    generation: number,
    requestId: number,
  ): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.createBranchFrom(path, name, start, checkout, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchCreate", { name, start, checkout });
    return await remoteBranchStateOf(session, snapshot);
  },

  async switchBranch(path: string, name: string, generation: number, requestId: number): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.switchBranch(path, name, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchSwitch", { name });
    return await remoteBranchStateOf(session, snapshot);
  },

  async renameBranch(
    path: string,
    oldName: string,
    newName: string,
    generation: number,
    requestId: number,
  ): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.renameBranch(path, oldName, newName, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchRename", { old: oldName, new: newName });
    return await remoteBranchStateOf(session, snapshot);
  },

  async deleteBranch(
    path: string,
    name: string,
    confirmUnmerged: boolean,
    generation: number,
    requestId: number,
  ): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.deleteBranch(path, name, confirmUnmerged, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchDelete", { name, confirmUnmerged });
    return await remoteBranchStateOf(session, snapshot);
  },

  async trackRemoteAs(
    path: string,
    remoteBranch: string,
    local: string,
    generation: number,
    requestId: number,
  ): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.trackRemoteAs(path, remoteBranch, local, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchTrack", { remoteBranch, name: local });
    return await remoteBranchStateOf(session, snapshot);
  },

  async updateBranch(path: string, name: string, generation: number, requestId: number): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.updateBranch(path, name, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchUpdate", { name });
    return await remoteBranchStateOf(session, snapshot);
  },

  async pushLocalBranch(path: string, name: string, generation: number, requestId: number): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.pushLocalBranch(path, name, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "branchPublish", { name });
    return await remoteBranchStateOf(session, snapshot);
  },

  async createTag(
    path: string,
    name: string,
    target: string,
    message: string,
    generation: number,
    requestId: number,
  ): Promise<TagState> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.createTag(path, name, target, message, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const fields: BridgePayload = { name, target };
    if (message) fields.message = message;
    const snapshot = await remoteBridgeWrite(session, generation, "tagCreate", fields);
    return await remoteTagStateOf(session, snapshot);
  },

  async deleteTag(
    path: string,
    name: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<TagState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.deleteTag(path, name, confirm, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "tagDelete", { name, confirm });
    return await remoteTagStateOf(session, snapshot);
  },

  async pushTag(
    path: string,
    remote: string,
    name: string,
    generation: number,
    requestId: number,
  ): Promise<TagState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.pushTag(path, remote, name, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "tagPush", { remote, name });
    return await remoteTagStateOf(session, snapshot);
  },

  async addRemote(
    path: string,
    name: string,
    url: string,
    generation: number,
    requestId: number,
  ): Promise<RemoteState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.addRemote(path, name, url, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "remoteAdd", { name, url });
    return await remoteRemoteStateOf(session, snapshot);
  },

  async setRemoteUrl(
    path: string,
    name: string,
    url: string,
    generation: number,
    requestId: number,
  ): Promise<RemoteState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.setRemoteUrl(path, name, url, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "remoteSetUrl", { name, url });
    return await remoteRemoteStateOf(session, snapshot);
  },

  /* ---------------------------------------------------------------- *
   * 远端桥接：同步
   * ---------------------------------------------------------------- */

  async fetchRemote(path: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.fetchRemote(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "fetch");
    return remoteStatus(snapshot, session.generation);
  },

  async pullFastForward(path: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.pullFastForward(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "pull");
    return remoteStatus(snapshot, session.generation);
  },

  async pushBranch(path: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.pushBranch(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "push");
    return remoteStatus(snapshot, session.generation);
  },

  async cancelRemote(path: string): Promise<void> {
    if (!isRemoteRepositoryKey(path)) return apiBase.cancelRemote(path);
    await remoteBridgeRead(remoteSession(path), "cancelRemote");
  },

  async pushToRemote(path: string, remote: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.pushToRemote(path, remote, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "pushToRemote", { remote });
    return remoteStatus(snapshot, session.generation);
  },

  async publishBranch(path: string, remote: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.publishBranch(path, remote, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "publishBranch", { remote });
    return remoteStatus(snapshot, session.generation);
  },

  async setUpstream(
    path: string,
    upstream: string,
    generation: number,
    requestId: number,
  ): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.setUpstream(path, upstream, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteBranchStateOf(session, await remoteBridgeWrite(session, generation, "setUpstream", { upstream }));
  },

  async associateUpstream(path: string, remote: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.associateUpstream(path, remote, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteStatus(await remoteBridgeWrite(session, generation, "associateUpstream", { remote }), session.generation);
  },

  async fetchBranches(path: string, generation: number, requestId: number): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.fetchBranches(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteBranchStateOf(session, await remoteBridgeWrite(session, generation, "fetchBranches"));
  },

  async deleteRemoteBranch(
    path: string,
    remote: string,
    name: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<BranchState> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.deleteRemoteBranch(path, remote, name, confirm, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    return remoteBranchStateOf(session, await remoteBridgeWrite(session, generation, "deleteRemoteBranch", { remote, name, confirm }));
  },

  /* ---------------------------------------------------------------- *
   * 远端桥接：stash
   * ---------------------------------------------------------------- */

  async stashState(
    path: string,
    includeUntracked: boolean,
    generation: number,
    requestId: number,
  ): Promise<StashState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.stashState(path, includeUntracked, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return await remoteStashStateOf(session, session.latest, includeUntracked);
  },

  async saveStash(
    path: string,
    includeUntracked: boolean,
    message: string,
    generation: number,
    requestId: number,
  ): Promise<StashSaveResult> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.saveStash(path, includeUntracked, message, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const fields: BridgePayload = { includeUntracked };
    if (message) fields.message = message;
    const result = await remoteBridgeWriteResult(session, generation, "stashSave", fields);
    const stash = bridgeField<StashSaveResult>(result, "stash");
    return { ...stash, state: {
      ...stash.state, generation: session.generation, snapshot: remoteStatus(result.snapshot, session.generation),
    } };
  },

  async applyStash(path: string, oid: string, generation: number, requestId: number): Promise<StashApplyResult> {
    if (!isRemoteRepositoryKey(path)) return apiBase.applyStash(path, oid, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteGitResult(session, generation, "stashApply", "stash", { oid });
  },

  async deleteStash(
    path: string,
    oid: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<StashState> {
    if (!isRemoteRepositoryKey(path)) return apiBase.deleteStash(path, oid, confirm, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteGitResult(session, generation, "stashDelete", "stash", { oid, confirm });
  },

  /* ---------------------------------------------------------------- *
   * 远端桥接：合并与冲突
   * ---------------------------------------------------------------- */

  async mergePreview(
    path: string,
    source: string,
    target: string | null,
    generation: number,
    requestId: number,
  ): Promise<MergePreview> {
    if (!isRemoteRepositoryKey(path)) return apiBase.mergePreview(path, source, target, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const result = await remoteBridgeRead(session, "mergePreview", { source, target });
    return { ...bridgeField<MergePreview>(result, "preview"), generation: session.generation };
  },

  async mergeSession(path: string, generation: number, requestId: number): Promise<MergeSession> {
    if (!isRemoteRepositoryKey(path)) return apiBase.mergeSession(path, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteMergeSessionOf(session, session.latest);
  },

  async startMerge(
    path: string,
    source: string,
    target: string | null,
    mode: "merge" | "ff-only" | "rebase",
    generation: number,
    requestId: number,
  ): Promise<MergeSession> {
    if (!isRemoteRepositoryKey(path)) return apiBase.startMerge(path, source, target, mode, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteGitResult(session, generation, "mergeStart", "merge", { source, target, mode });
  },

  async completeMerge(
    path: string,
    message: string,
    generation: number,
    requestId: number,
    operation: string | null = null,
  ): Promise<MergeComplete> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.completeMerge(path, message, generation, requestId, operation);
    }
    const session = remoteBridgeSession(path, generation);
    return remoteGitResult(session, generation, "mergeComplete", "merge", { message });
  },

  async abortMerge(path: string, confirm: boolean, generation: number, requestId: number): Promise<AbortImpact> {
    if (!isRemoteRepositoryKey(path)) return apiBase.abortMerge(path, confirm, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return confirm
      ? remoteGitResult(session, generation, "mergeAbort", "merge", { confirm })
      : remoteGitPreview(session, "mergeAbortPreview", "merge", {});
  },

  async resolveConflict(
    path: string,
    relative: string,
    choice: string,
    content: string | null,
    generation: number,
    requestId: number,
  ): Promise<MergeSession> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.resolveConflict(path, relative, choice, content, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    return remoteGitResult(session, generation, "resolveConflict", "merge", {
      path: relative, choice, ...(content !== null ? { content } : {}),
    });
  },

  async conflictView(path: string, relative: string, generation: number, requestId: number): Promise<ConflictView> {
    if (!isRemoteRepositoryKey(path)) return apiBase.conflictView(path, relative, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const view = bridgeField<ConflictView>(await remoteBridgeRead(session, "conflictView", { path: relative }), "conflict");
    return { ...view, generation: session.generation };
  },

  async checkoutCommit(path: string, oid: string, generation: number, requestId: number): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) return apiBase.checkoutCommit(path, oid, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const snapshot = await remoteBridgeWrite(session, generation, "checkoutCommit", { oid });
    return remoteStatus(snapshot, session.generation);
  },

  /* ---------------------------------------------------------------- *
   * 远端桥接：危险写入
   *
   * 这几条都在桥接白名单里，因此按现有写通道执行：预览（confirm=false）一律不发送任何
   * 写入，确认（confirm=true）只发送一次写入，随后按「回执 + 一次只读 op」组成 DTO。
   * v2 回执本身带 cherryPick/revert/amend/discard 的 DTO，是原生桥接的 finish_write 只回
   * {state, operationId, snapshot, head} 把它们丢了。丢掉的字段留空（undefined），不填
   * 0 / [] 冒充真值，并在 note 里说明「原生桥接暂未回传这些结果」。
   * ---------------------------------------------------------------- */

  async discardChanges(
    path: string,
    paths: string[],
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<DiscardResult> {
    if (!isRemoteRepositoryKey(path)) return apiBase.discardChanges(path, paths, confirm, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return confirm
      ? remoteGitResult(session, generation, "discard", "discard", { paths, confirm })
      : remoteGitPreview(session, "discardPreview", "discard", { paths });
  },

  async cherryPickCommits(path: string, oids: string[], generation: number, requestId: number): Promise<CherryPickOutcome> {
    if (!isRemoteRepositoryKey(path)) return apiBase.cherryPickCommits(path, oids, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    return remoteGitResult(session, generation, "cherryPick", "cherryPick", { oids });
  },

  async revertCommits(
    path: string,
    oids: string[],
    expectedHead: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<RevertOutcome> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.revertCommits(path, oids, expectedHead, confirm, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const fields = { oids, expectedHead, confirm };
    return confirm
      ? remoteGitResult(session, generation, "revert", "revert", fields)
      : remoteGitPreview(session, "revertPreview", "revert", fields);
  },

  async undoCommit(
    path: string,
    expectedHead: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<UndoResult> {
    if (!isRemoteRepositoryKey(path)) return apiBase.undoCommit(path, expectedHead, confirm, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    const fields = { expectedHead, confirm };
    return confirm
      ? remoteGitResult(session, generation, "undoCommit", "undo", fields)
      : remoteGitPreview(session, "undoCommitPreview", "undo", fields);
  },

  async amendCommit(
    path: string,
    expectedHead: string,
    message: string | null,
    includeStaged: boolean,
    stagedToken: string | null,
    confirm: boolean,
    generation: number,
    requestId: number,
  ): Promise<AmendOutcome> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.amendCommit(path, expectedHead, message, includeStaged, stagedToken, confirm, generation, requestId);
    }
    const session = remoteBridgeSession(path, generation);
    const fields = { expectedHead, message, includeStaged, stagedToken, confirm };
    return confirm
      ? remoteGitResult(session, generation, "amendCommit", "amend", fields)
      : remoteGitPreview(session, "amendCommitPreview", "amend", fields);
  },

  async removeWorktree(path: string, force: boolean, requestId: number): Promise<RecentRepo[]> {
    if (!isRemoteRepositoryKey(path)) return apiBase.removeWorktree(path, force, requestId);
    throw remoteError("remote_unsupported", "请在所属 SSH 仓库核对这棵工作区的删除预览。");
  },

  async stageHunks(
    path: string,
    relative: string,
    staged: boolean,
    hunks: number[],
    snapshot: string,
    generation: number,
    requestId: number,
    original: string | null = null,
  ): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.stageHunks(path, relative, staged, hunks, snapshot, generation, requestId, original);
    }
    const session = remoteBridgeSession(path, generation);
    return remoteStatus(await remoteBridgeWrite(session, generation, "patch", {
      path: relative, original, staged, snapshot, hunks,
    }), session.generation);
  },

  async stageLines(
    path: string,
    relative: string,
    staged: boolean,
    lines: DiffLineSelection[],
    snapshot: string,
    generation: number,
    requestId: number,
    original: string | null = null,
  ): Promise<StatusSnapshot> {
    if (!isRemoteRepositoryKey(path)) {
      return apiBase.stageLines(path, relative, staged, lines, snapshot, generation, requestId, original);
    }
    const session = remoteBridgeSession(path, generation);
    return remoteStatus(await remoteBridgeWrite(session, generation, "patch", {
      path: relative, original, staged, snapshot, lines,
    }), session.generation);
  },

  async commitAndPush(
    path: string,
    message: string,
    generation: number,
    requestId: number,
  ): Promise<CommitPushReport> {
    if (!isRemoteRepositoryKey(path)) return apiBase.commitAndPush(path, message, generation, requestId);
    const session = remoteBridgeSession(path, generation);
    if (currentPushContinuation(session)) {
      throw remoteError("push_pending", "上一条提交已完成，请使用重试推送。", generation);
    }
    const result = await remoteWrite(session, { op: "commit", message, pushAfter: true }, generation);
    const committed = result.snapshot;
    const oid = committed.head;
    if (!oid) throw remoteError("remote_protocol", "远端提交回执缺少提交身份。", session.generation);
    let pushError: string | null = null;
    let trackingWarning: string | null = null;
    try {
      if (result.pushTargetError) {
        throw remoteError(result.pushTargetError, "提交时无法确定推送目标。请核对远程和分支后单独推送。", session.generation);
      }
      if (currentPushContinuation(session)?.head !== oid) {
        throw remoteError("stale", "当前分支或提交与待推送记录不同，请先切回相应提交。", session.generation);
      }
      trackingWarning = (await retryRemotePush(path, session.generation)).warning;
    } catch (error) {
      checkRemoteResponse(session);
      pushError = normalizeError(error).message;
      if (!session.pending) await remoteStatusOf(session).catch(() => undefined);
      checkRemoteResponse(session);
    }
    const short = oid.slice(0, 7);
    return {
      committed: true, pushed: pushError === null, retryPush: pushError !== null && currentPushContinuation(session) !== null,
      pushUnconfirmed: session.pending !== null,
      oid, branch: committed.branch ?? "", pushError,
      summary: trackingWarning ?? (pushError === null ? `已创建远端提交 ${short}，推送已完成。` : `已创建远端提交 ${short}。`),
      generation: session.generation,
      snapshot: remoteStatus(session.latest, session.generation),
    };
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

