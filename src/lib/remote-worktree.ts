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
  baseline?: string;
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
}

export interface RemoteConnectionProgress {
  phase: "connecting" | "installing" | "opening";
  sentBytes?: number;
  totalBytes?: number;
}

export type RemoteOpenResult =
  | { kind: "open"; sessionId: string; snapshot: RemoteWorktreeSnapshot; pendingWrite: RemotePendingWrite | null }
  | { kind: "install_required"; version: string; size: number; confirmationId?: string };

export type RemoteDiffView = "staged" | "unstaged" | "task";

export interface RemoteDiffRequest {
  sessionId: string;
  generation: string;
  path: string;
  view: RemoteDiffView;
  cursor?: string;
}

export interface RemoteDiffPage {
  data: string;
  nextCursor: string | null;
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

export type RemoteWriteResult =
  | { state: "completed"; operationId: string; snapshot: RemoteWorktreeSnapshot; head?: string | null }
  // Return "failed" only when the outcome is verified and the write had no effect.
  | { state: "failed" | "unknown"; operationId: string; message: string };

export interface RemoteWorktreePort {
  targets: () => Promise<RemoteTarget[]>;
  open: (request: RemoteOpenRequest, progress: (value: RemoteConnectionProgress) => void) => Promise<RemoteOpenResult>;
  cancelOpen: (requestId: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
  status: (sessionId: string) => Promise<RemoteWorktreeSnapshot>;
  diff: (request: RemoteDiffRequest) => Promise<RemoteDiffPage>;
  write: (request: RemoteWriteRequest) => Promise<RemoteWriteResult>;
  recover: (sessionId: string, operationId: string) => Promise<RemoteWriteResult>;
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

export const remoteReviewPort = {
  begin: (url: string) => invoke<RemoteReviewSource | null>("remote_review_begin", { url }),
  accept: (reviewId: string, sessionId: string) => invoke<void>("remote_review_accept", { reviewId, sessionId }),
  end: (reviewId: string, reason: string) => invoke<void>("remote_review_end", { reviewId, reason }),
  returnReview: (reviewId: string, sessionId: string) => invoke<void>("remote_review_return", { reviewId, sessionId }),
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

export type HostSyncPasswordState = "equal" | "differs" | "absent" | "unknown";

export interface HostSyncReceipt {
  kind: "config" | "password";
  state: "unchanged" | "saved" | "failed" | "absent" | "unavailable" | "conflict";
}

export interface HostSyncCandidate {
  hostId: string;
  displayName: string;
  host?: string;
  port?: number;
  user?: string;
}

export interface HostSyncResult {
  protocol: number;
  kind: "host-sync-v1";
  result: "consistent" | "applied" | "partial" | "unknown" | "unchanged" | "association_required" | "conflict";
  hostId: string | null;
  sharedHostId: string | null;
  password: HostSyncPasswordState;
  receipts: HostSyncReceipt[];
  sessionClosed: boolean;
  candidates?: HostSyncCandidate[];
}

/** 把同步回执翻成一句话。只描述状态，不回显任何配置或秘密。 */
export function hostSyncMessage(result: HostSyncResult): string {
  switch (result.result) {
    case "consistent":
      return "这台主机的配置与密码在两端一致，没有取回或改写任何内容。";
    case "applied": {
      const saved = result.receipts.filter((receipt) => receipt.state === "saved").map((receipt) => receipt.kind);
      if (saved.length === 0) return "这台主机已同步，没有需要改写的字段。";
      return `这台主机已同步：${saved.map((kind) => (kind === "config" ? "配置" : "密码")).join("、")}已写入本机。`;
    }
    case "partial":
      return "配置已保存，但密码未能写入系统凭据。原密码仍保留，可在跳转流程里重试。";
    case "conflict":
      return "本机这台主机在同步期间被修改，本次没有覆盖。请重新发起跳转。";
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

