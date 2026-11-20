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
}

export const remoteReviewPort = {
  begin: (url: string) => invoke<RemoteReviewSource | null>("remote_review_begin", { url }),
  accept: (reviewId: string, sessionId: string) => invoke<void>("remote_review_accept", { reviewId, sessionId }),
  end: (reviewId: string, reason: string) => invoke<void>("remote_review_end", { reviewId, reason }),
  returnReview: (reviewId: string, sessionId: string) => invoke<void>("remote_review_return", { reviewId, sessionId }),
};
