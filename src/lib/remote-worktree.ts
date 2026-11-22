import type {
  BranchInfo,
  ChangeKind,
  DiffHunk,
  DiffLine,
  DiffResponse,
  FileChange,
  RepositoryEndpoint,
  StatusSnapshot,
} from "./types";

export interface RemoteTarget {
  targetId: string;
  targetRevision: string;
  name: string;
  host: string;
  effectiveHost?: string;
  user: string;
  port: number;
  authMethod: string;
  defaultPath: string | null;
  unavailableReason?: string;
}

export interface RemoteWorktreeLocation {
  targetId: string;
  targetRevision: string;
  path: string;
  /** 任务基线：审查来源带基线时，打开请求必须原样回传，后端才会放行。 */
  baseline?: string | null;
}

export interface RemoteWorktreeSnapshot {
  repo: string;
  root: string;
  host: string;
  head: string | null;
  branch: string | null;
  generation: string;
  files: { path: string; xy: string }[];
  reviewFiles?: string[];
  reviewFilesTruncated?: boolean;
  reviewError?: { code: string; message: string } | null;
  worktreeIdentity?: string;
  watchDegraded?: boolean;
}

export interface RemoteWorkspace {
  sessionId: string;
  target: RemoteTarget;
  snapshot: RemoteWorktreeSnapshot;
  baseline?: string;
}

export interface RemoteOpenRequest extends RemoteWorktreeLocation {
  requestId: string;
  allowInstall: boolean;
  installConfirmation?: string;
  reviewId?: string;
  /** 与审查来源一致的基线；没有来源或来源没有基线时缺省。 */
  baseline?: string | null;
}

export interface RemoteConnectionProgress {
  phase: "connecting" | "installing" | "opening";
  sentBytes?: number;
  totalBytes?: number;
}

export type RemoteOpenResult =
  | { kind: "open"; sessionId: string; snapshot: RemoteWorktreeSnapshot; pendingWrite: RemotePendingWrite | null; reviewOutcome?: RemoteReviewOutcome | null }
  | { kind: "install_required"; version: string; size: number; confirmationId?: string };

export type RemoteDiffView = "staged" | "unstaged" | "task";

export interface RemoteDiffRequest {
  sessionId: string;
  generation: string;
  path: string;
  view: RemoteDiffView;
  cursor?: string;
  original?: string;
  head?: string;
  context?: number;
  asText?: boolean;
}

export interface RemoteDiffPage {
  data: string;
  nextCursor: string | null;
  /**
   * 这份差异里的块能不能按块暂存。由远端命令按会话能力与视图给出，
   * 界面与解析器都不自行推断；缺省（旧载荷）一律按不可暂存处理。
   */
  hunksStageable?: boolean;
  /** 不可暂存时的一句话原因；可暂存时为 null 或缺省。 */
  hunksStageableReason?: string | null;
}

export type RemoteWriteAction =
  | { op: "stage" | "unstage"; path: string }
  | { op: "commit"; message: string };

export interface RemotePendingWrite {
  operationId: string;
  op: RemoteWriteAction["op"];
}

export type RemoteWriteRequest = RemoteWriteAction & {
  sessionId: string;
  generation: string;
  operationId: string;
};

/**
 * 桥接 op 白名单：与 `src-tauri/src/remote_worktree.rs` 的 `BRIDGE_READ_OPS` /
 * `BRIDGE_WRITE_OPS` 逐项一致（有单测比对两处）。未列入的 op 由后端直接拒绝，
 * 前端不得据此回退到本机 Git。
 */
export const REMOTE_READ_OPS = [
  "taskReview",
  "taskReviewToken",
  "history",
  "fileHistory",
  "commitDetail",
  "commitDiff",
  "compare",
  "commitBranches",
  "compareFileDiff",
  "branchList",
  "branchState",
  "branchTracking",
  "tagState",
  "tagRemoteState",
  "remoteState",
  "stashState",
  "mergePreview",
  "mergeSession",
  "conflictView",
  "worktrees",
] as const;

export const REMOTE_WRITE_OPS = [
  "branchCreate",
  "branchSwitch",
  "branchRename",
  "branchDelete",
  "branchTrack",
  "branchUpdate",
  "branchPublish",
  "tagCreate",
  "tagDelete",
  "tagPush",
  "remoteAdd",
  "remoteSetUrl",
  "fetch",
  "pull",
  "push",
  "pushToRemote",
  "publishBranch",
  "stashSave",
  "stashApply",
  "stashDelete",
  "mergeStart",
  "mergeComplete",
  "mergeAbort",
  "resolveConflict",
  "cherryPick",
  "revert",
  "undoCommit",
  "checkoutCommit",
  "amendCommit",
  "discard",
  "worktreeRemove",
] as const;

export type RemoteReadOp = (typeof REMOTE_READ_OPS)[number];
export type RemoteWriteOp = (typeof REMOTE_WRITE_OPS)[number];
export type RemoteCallOp = RemoteReadOp | RemoteWriteOp;

export interface RemoteCallRequest {
  sessionId: string;
  op: RemoteCallOp;
  /** op 自己的字段；仓库键由会话决定，后端会覆盖 repo。 */
  fields?: Record<string, unknown>;
  /** 状态代次；有就随请求带上，由远端核对。 */
  generation?: string;
}

/**
 * 桥接结果：只读 op 原样返回 agent v2 的同名 DTO；写入 op 与 `write` 共用同一套
 * 待确认语义，因而沿用同一个结果类型。
 */
export type RemoteCallResult = RemoteWriteResult | Record<string, unknown>;

export type RemoteWriteResult =
  | { state: "completed"; operationId: string; snapshot: RemoteWorktreeSnapshot; head?: string | null; reviewOutcome?: RemoteReviewOutcome | null }
  // Return "failed" only when the outcome is verified and the write had no effect.
  | { state: "failed" | "unknown"; operationId: string; op?: RemotePendingWrite["op"]; message: string };

export interface RemoteWorktreePort {
  targets: () => Promise<RemoteTarget[]>;
  open: (request: RemoteOpenRequest, progress: (value: RemoteConnectionProgress) => void) => Promise<RemoteOpenResult>;
  cancelOpen: (requestId: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
  status: (sessionId: string) => Promise<RemoteWorktreeSnapshot>;
  diff: (request: RemoteDiffRequest) => Promise<RemoteDiffPage>;
  write: (request: RemoteWriteRequest) => Promise<RemoteWriteResult>;
  recover: (sessionId: string, operationId: string) => Promise<RemoteWriteResult>;
  /** 通用桥接：按 op 白名单调用远端 agent v2 的其余 Git 能力。 */
  call: (request: RemoteCallRequest) => Promise<RemoteCallResult>;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

export const remoteWorktreePort: RemoteWorktreePort = {
  targets: () => invoke("remote_worktree_targets"),
  async open(request, progress) {
    const { Channel, invoke: call } = await import("@tauri-apps/api/core");
    const onProgress = new Channel<RemoteConnectionProgress>(progress);
    return call<RemoteOpenResult>("remote_worktree_open", { request, onProgress });
  },
  cancelOpen: (requestId) => invoke("remote_worktree_cancel_open", { requestId }),
  close: (sessionId) => invoke("remote_worktree_close", { sessionId }),
  status: (sessionId) => invoke("remote_worktree_status", { sessionId }),
  diff: (request) => invoke("remote_worktree_diff", { request }),
  write: (request) => invoke("remote_worktree_write", { request }),
  recover: (sessionId, operationId) => invoke("remote_worktree_recover", { sessionId, operationId }),
  call: (request) => invoke("remote_worktree_call", { request }),
};

export interface RemoteReviewSource {
  reviewId: string;
  sessionId: string;
  targetId: string;
  targetRevision: string;
  peerRevision: string;
  peerIdentity: string;
  worktreeIdentity: string;
  worktreePath: string;
  baseline: string | null;
  /** 跳转附带的一次性同步会话引用；旧链接没有这个字段。 */
  hostSync?: string | null;
}

/** 审查结果阶段：与后端 `Outcome` 同名，缺省为 reviewed（旧调用方的语义）。 */
export type RemoteReviewOutcome = "reviewed" | "committed" | "merged";

export const remoteReviewPort = {
  begin: (url: string) => invoke<RemoteReviewSource | null>("remote_review_begin", { url }),
  accept: (reviewId: string, sessionId: string) => invoke<void>("remote_review_accept", { reviewId, sessionId }),
  end: (reviewId: string, reason: string) => invoke<void>("remote_review_end", { reviewId, reason }),
  /** 结果阶段只能前进（reviewed → committed → merged），回退或重复由后端拒绝。 */
  returnReview: (reviewId: string, sessionId: string, outcome?: RemoteReviewOutcome) =>
    invoke<RemoteReviewOutcome | void>("remote_review_return", { reviewId, sessionId, outcome }),
};

/**
 * 一次跳转附带的当前主机同步会话。只有会话引用会进入 deep link，
 * 配置与密码都留在本机，经 headless helper 的私有管道交换。
 *
 * 本版本没有 host-sync 的应用内 IPC 命令（应用内接收接线延后到 T6）：
 * 这里只保留协议类型与回执文案，前端不 invoke 任何 host-sync 命令。
 */
export interface HostSyncSession {
  protocol: number;
  kind: "host-sync-v1";
  sessionRef: string;
  hostId: string;
  sharedHostId: string | null;
  configFingerprint: string;
  configRevision: number;
  expiresAt: number;
  ttlSeconds: number;
}

export type HostSyncPasswordState =
  | "equal"
  | "differs"
  | "absent"
  | "unknown"
  /** 密码需要用户确认才能取回：既不是相同，也不是不可读，绝不折叠成失败。 */
  | "needs_confirmation";

export interface HostSyncReceipt {
  kind: "config" | "password";
  state: "unchanged" | "applied" | "failed" | "absent" | "unavailable" | "conflict" | "needs_confirmation";
}

export interface HostSyncCandidate {
  hostId: string;
  displayName: string;
  host?: string;
  port?: number;
  user?: string;
}

/** 同地址但已关联到别的共享标识的本机记录：只能由用户手动处理，不再复制一条。 */
export interface HostSyncConflict {
  hostId: string;
  displayName: string;
  host: string;
  sharedHostId: string | null;
}

export interface HostSyncResult {
  protocol: number;
  kind: "host-sync-v1";
  result:
    | "consistent"
    | "applied"
    | "partial"
    | "unknown"
    | "unchanged"
    | "association_required"
    | "association_conflict"
    | "conflict";
  /* 冲突与未关联回执不写任何记录，所以这三项可以缺省。 */
  hostId?: string | null;
  sharedHostId: string | null;
  password?: HostSyncPasswordState;
  revision?: number | null;
  receipts: HostSyncReceipt[];
  sessionClosed: boolean;
  candidates?: HostSyncCandidate[];
  conflicts?: HostSyncConflict[];
}

/** 把同步回执翻成一句话。只描述状态，不回显任何配置或秘密。 */
export function hostSyncMessage(result: HostSyncResult): string {
  switch (result.result) {
    case "consistent":
      return "这台主机的配置与密码在两端一致，没有取回或改写任何内容。";
    case "applied": {
      const saved = result.receipts.filter((receipt) => receipt.state === "applied").map((receipt) => receipt.kind);
      if (saved.length === 0) return "这台主机已同步，没有需要改写的字段。";
      return `这台主机已同步：${saved.map((kind) => (kind === "config" ? "配置" : "密码")).join("、")}已写入本机。`;
    }
    case "partial": {
      // 密码缺确认票据时配置仍然会写好：不能把整次同步说成失败。
      if (result.receipts.some((receipt) => receipt.state === "needs_confirmation")) {
        return "本机配置已按需同步；需要同步密码时请在终端执行 confirm，或在 T6 界面确认后再同步一次。原密码未改动。";
      }
      return "配置已保存，但密码未能写入系统凭据。原密码仍保留，可在跳转流程里重试。";
    }
    case "conflict":
      return "本机这台主机在同步期间被修改或删除，本次没有覆盖、也没有重建记录。请重新发起跳转。";
    case "association_conflict":
      return "本机这条主机记录已关联到另一个共享标识，本次没有写入任何内容。请手动处理这条记录，或改用另一台主机发起跳转。";
    case "association_required": {
      const count = result.candidates?.length ?? 0;
      return count > 0
        ? `本机有 ${count} 条同地址但未关联的主机记录，需要先选定要关联哪一条。`
        : "本机没有可关联的主机记录，需要先显式绑定到一条记录。";
    }
    case "unknown":
      return "本机与来源的密码无法比较（系统凭据不可读），请手动确认这台主机的密码后再连接。";
    default:
      return "这台主机的同步没有产生改动。";
  }
}


/* ------------------------------------------------------------------ *
 * 仓库位置：本机路径与 SSH 工作树共用一套仓库键与 DTO 适配（T6）
 *
 * 主界面只认 OpenedRepository / StatusSnapshot / DiffResponse，远端返回的是
 * 仓库标识、xy 状态与分页的原始 diff，因此在这一层翻成同一套 DTO；界面不感知差异。
 * ------------------------------------------------------------------ */

/** 远端仓库键的固定前缀。hostId 是主机记录 id，不是显示名。 */
export const REMOTE_KEY_SCHEME = "ssh://";
const REMOTE_DRIVE_PATH = "?path=";

function normalizeRemoteDrivePath(path: string): string | null {
  if (!/^[A-Za-z]:[\\/]/.test(path) || path.includes("\0")) return null;
  const tail = path.slice(2).replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return path[0].toUpperCase() + ":/" + tail.slice(1);
}

export function normalizeRemotePath(input: string): string | null {
  const path = input.trim();
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.startsWith("/") ? path.replace(/\/+$/, "") || "/" : normalizeRemoteDrivePath(path);
}

/**
 * 远端仓库的稳定键：hostId + 规范化远端路径。
 * 不含显示名、连接会话或认证信息，进程重启后仍指向同一个仓库。
 */
export function remoteRepositoryKey(hostId: string, path: string): string {
  const drivePath = normalizeRemoteDrivePath(path.trim());
  if (drivePath !== null) {
    // A POSIX key always has a literal slash after the host id.
    return REMOTE_KEY_SCHEME + hostId + REMOTE_DRIVE_PATH + encodeURIComponent(drivePath);
  }
  const root = path.trim().replace(/\/+$/, "") || "/";
  const suffix = root.startsWith("/") ? root : "/" + root;
  return REMOTE_KEY_SCHEME + hostId + suffix;
}

export function isRemoteRepositoryKey(key: string | null | undefined): key is string {
  return typeof key === "string" && key.startsWith(REMOTE_KEY_SCHEME);
}

export function parseRemoteRepositoryKey(key: string): { hostId: string; path: string } | null {
  if (!isRemoteRepositoryKey(key)) return null;
  const rest = key.slice(REMOTE_KEY_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash !== -1) return slash > 0 ? { hostId: rest.slice(0, slash), path: rest.slice(slash) } : null;
  const separator = rest.lastIndexOf(REMOTE_DRIVE_PATH);
  if (separator <= 0) return null;
  try {
    const path = normalizeRemoteDrivePath(decodeURIComponent(rest.slice(separator + REMOTE_DRIVE_PATH.length)));
    return path === null ? null : { hostId: rest.slice(0, separator), path };
  } catch {
    return null;
  }
}

/** 展示身份：内部仓库键与用户路径分开，远端显示真实远端路径与主机。 */
export function repositoryEndpoint(key: string, host: string | null = null): RepositoryEndpoint {
  const parsed = parseRemoteRepositoryKey(key);
  return {
    kind: parsed ? "ssh" : "local",
    key,
    displayPath: parsed?.path ?? key,
    host: parsed ? host : null,
  };
}

/** 路径最后一段：与 recent.baseName 同一条规则，远端路径同样适用。 */
export function repositoryBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function changeKind(mark: string | undefined): ChangeKind {
  switch (mark) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "M":
      return "modified";
    case "T":
      return "typeChanged";
    case "U":
      return "unmerged";
    default:
      return "none";
  }
}

/** 远端 xy 状态翻成主界面用的 FileChange：未跟踪与冲突保持各自的独立标记。 */
export function remoteChanges(files: readonly { path: string; xy: string }[]): FileChange[] {
  return files.map(({ path, xy }) => {
    if (xy === "??") {
      return { path, originalPath: null, staged: "none", unstaged: "added", untracked: true, unmerged: false };
    }
    if (UNMERGED_XY.has(xy)) {
      return {
        path,
        originalPath: null,
        staged: "unmerged",
        unstaged: "unmerged",
        untracked: false,
        unmerged: true,
      };
    }
    return {
      path,
      originalPath: null,
      staged: changeKind(xy[0]),
      unstaged: changeKind(xy[1]),
      untracked: false,
      unmerged: false,
    };
  });
}

/**
 * 远端分支信息：上游与领先/落后不在这条协议里，保持 null（未知），
 * 不把「没读到」写成 0，也不能声称远程状态已核对。
 */
export function remoteBranch(snapshot: RemoteWorktreeSnapshot): BranchInfo {
  const head = snapshot.head ?? null;
  return {
    name: snapshot.branch ?? null,
    detached: head !== null && !snapshot.branch,
    unborn: head === null,
    headOid: head,
    upstream: null,
    ahead: null,
    behind: null,
    liveRemoteChecked: false,
    remoteCheckedAtMs: null,
    remoteCheckStale: false,
  };
}

export function remoteStatus(snapshot: RemoteWorktreeSnapshot, generation: number): StatusSnapshot {
  return { generation, branch: remoteBranch(snapshot), files: remoteChanges(snapshot.files) };
}

export interface RemotePatch {
  binary: boolean;
  /** 续读达到页数上限时明确截断，不当成完整差异。 */
  truncated: boolean;
  lines: DiffLine[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParseRemotePatchOptions {
  /** 远端命令返回的 hunksStageable：块级写入是否由远端支持。 */
  hunksStageable?: boolean;
}

/** 解析远端 unified diff 的完整文本：一次算出行号、块索引与增删计数。 */
export function parseRemotePatch(text: string, patchOptions: ParseRemotePatchOptions = {}): RemotePatch {
  /**
   * 块级可暂存只认远端给的标记：缺省、二进制与非文本差异一律不可暂存，
   * 因此「显示可暂存」永远不会超出远端实际支持的写入范围。
   */
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const lines: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let oldNo = 0;
  let newNo = 0;
  let hunkIndex: number | null = null;
  let binary = false;
  for (const rawLine of raw) {
    const body = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const header = HUNK_HEADER.exec(body);
    if (header) {
      hunkIndex = hunks.length;
      oldNo = Number(header[1] ?? 0);
      newNo = Number(header[3] ?? 0);
      hunks.push({
        index: hunkIndex,
        header: body,
        complete: true,
        stageable: patchOptions.hunksStageable === true && !binary,
        startLine: lines.length,
        lineCount: 1,
      });
      lines.push({ kind: "hunk", text: body, oldNo: null, newNo: null, hunkIndex });
      continue;
    }
    if (hunkIndex === null) {
      if (body.startsWith("Binary files ") && body.endsWith(" differ")) binary = true;
      if (body.length > 0) {
        lines.push({ kind: "meta", text: body, oldNo: null, newNo: null, hunkIndex: null });
      }
      continue;
    }
    const hunk = hunks[hunkIndex];
    if (body.startsWith("-")) {
      lines.push({ kind: "del", text: body.slice(1), oldNo, newNo: null, hunkIndex });
      oldNo += 1;
      deletions += 1;
      hunk.lineCount += 1;
      continue;
    }
    if (body.startsWith("+")) {
      lines.push({ kind: "add", text: body.slice(1), oldNo: null, newNo, hunkIndex });
      newNo += 1;
      additions += 1;
      hunk.lineCount += 1;
      continue;
    }
    if (body.startsWith("\\")) {
      lines.push({ kind: "nonewline", text: body, oldNo: null, newNo: null, hunkIndex });
      hunk.lineCount += 1;
      continue;
    }
    lines.push({
      kind: "context",
      text: body.startsWith(" ") ? body.slice(1) : body,
      oldNo,
      newNo,
      hunkIndex,
    });
    oldNo += 1;
    newNo += 1;
    hunk.lineCount += 1;
  }
  // 二进制差异没有可写入的块：即使载荷标了可暂存，也不能让按钮亮起来。
  if (binary) for (const hunk of hunks) hunk.stageable = false;
  return { binary, truncated: false, lines, hunks, additions, deletions };
}

/** 一份已解析的远端差异：分页只切这份结果，不重新请求远端。 */
export interface RemoteDiffDocument {
  generation: number;
  path: string;
  staged: boolean;
  /** 与远端状态令牌绑定的快照标识，用于丢弃旧响应。 */
  snapshot: string;
  patch: RemotePatch;
  totalLines: number;
}

export function remoteDiffDocument(
  patch: RemotePatch,
  generation: number,
  path: string,
  staged: boolean,
  snapshot: string,
): RemoteDiffDocument {
  return { generation, path, staged, snapshot, patch, totalLines: patch.lines.length };
}

/** 切成主界面请求的那一页：行窗口与块的 startLine 都按页偏移重算。 */
export function remoteDiffPage(document: RemoteDiffDocument, offset: number, limit: number): DiffResponse {
  const patch = document.patch;
  const total = document.totalLines;
  const start = Math.min(Math.max(offset, 0), total);
  const end = limit > 0 ? Math.min(start + limit, total) : total;
  const lines = patch.lines.slice(start, end);
  const hunks = patch.hunks
    .filter((hunk) => hunk.startLine < end && hunk.startLine + hunk.lineCount > start)
    .map((hunk) => {
      const from = Math.max(hunk.startLine, start);
      const to = Math.min(hunk.startLine + hunk.lineCount, end);
      return { ...hunk, startLine: from - start, lineCount: to - from };
    });
  const summary = patch.binary
    ? "二进制文件改动，不能按文本显示。"
    : String(patch.additions) + " 行新增，" + String(patch.deletions) + " 行删除。";
  return {
    generation: document.generation,
    path: document.path,
    staged: document.staged,
    binary: patch.binary,
    text: null,
    summary,
    additions: patch.additions,
    deletions: patch.deletions,
    complete: !patch.truncated,
    truncated: patch.truncated,
    snapshot: document.snapshot,
    hunks,
    lines,
    offset: start,
    totalLines: total,
  };
}

/**
 * 远端审阅 token：绑定仓库键、状态令牌与路径。状态或内容一变 token 就不同，
 * 旧标记随之失效；它只是本地人工记录，不参与 Cliora 结果。
 */
export function remoteReviewToken(snapshot: string, key: string, path: string): string {
  return "remote:" + key + ":" + snapshot + ":" + path;
}

