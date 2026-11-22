// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 主窗口验收（T6）：远端仓库在主窗口和本机仓库共用同一套 DTO 与同一批 API 方法。
 * 这里顶替的是两处边界——Tauri 命令（本机）与远端端口（SSH）——然后断言：
 * 打开/刷新/分页差异/暂存/提交都返回同一套 DTO；仓库键隔离两台主机的同名路径；
 * 迟到的响应、断线只读与待确认写入都不会回退到本机 Git。
 */

const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => ({ ok: true })),
);

const port = vi.hoisted(() => ({
  targets: vi.fn(),
  open: vi.fn(),
  cancelOpen: vi.fn(),
  close: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  write: vi.fn(),
  recover: vi.fn(),
  call: vi.fn(),
  events: vi.fn(),
  cancelReads: vi.fn(),
}));

const review = vi.hoisted(() => ({
  begin: vi.fn(),
  accept: vi.fn(),
  end: vi.fn(),
  returnReview: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../src/lib/remote-worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/remote-worktree")>();
  return { ...actual, remoteWorktreePort: port, remoteReviewPort: review };
});

import { api, listenEvent, openRemoteRepository, remoteRepositoryState } from "../src/lib/api";
import {
  REMOTE_READ_OPS,
  REMOTE_TERMINAL_OPS,
  REMOTE_WRITE_OPS,
  type RemoteEventBatch,
  normalizeRemotePath,
  parseRemotePatch,
  parseRemoteRepositoryKey,
  remoteRepositoryKey,
  repositoryEndpoint,
} from "../src/lib/remote-worktree";

const hostA = {
  targetId: "host-a",
  targetRevision: "a".repeat(64),
  name: "构建主机 A",
  host: "build-alias",
  effectiveHost: "builder-a.example",
  user: "dev",
  port: 22,
  authMethod: "key",
  defaultPath: "/srv/repo",
};
const hostB = { ...hostA, targetId: "host-b", targetRevision: "b".repeat(64), name: "构建主机 B" };

const keyA = remoteRepositoryKey(hostA.targetId, "/srv/repo");
const keyB = remoteRepositoryKey(hostB.targetId, "/srv/repo");

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    repo: "repo-a",
    root: "/srv/repo",
    host: "build-a",
    head: "a".repeat(40),
    branch: "feature",
    generation: "g1",
    files: [
      { path: "small.txt", xy: " M" },
      { path: "staged.txt", xy: "M " },
      { path: "new.txt", xy: "??" },
    ],
    ...extra,
  };
}

function opened(sessionId = "session-a", snap: unknown = snapshot(), pendingWrite: unknown = null) {
  return { kind: "open", sessionId, snapshot: snap, pendingWrite };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function page(text: string | Uint8Array, nextCursor: string | null = null) {
  const bytes = typeof text === "string" ? bytesOf(text) : text;
  return { data: btoa(String.fromCharCode(...bytes)), nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function openHost(target = hostA, key = keyA, sessionId = "session-a", snap: unknown = snapshot()) {
  port.open.mockResolvedValueOnce(opened(sessionId, snap));
  return api.openRepository(key, 1);
}

it("closes a late native open result without replacing the newer SSH worktree", async () => {
  const late = deferred<ReturnType<typeof opened>>();
  port.open.mockImplementationOnce(() => late.promise)
    .mockResolvedValueOnce(opened("session-b", snapshot({ repo: "repo-b" })));
  const first = openRemoteRepository({
    kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo",
  });
  const second = await openRemoteRepository({
    kind: "ssh", hostId: hostB.targetId, hostRevision: hostB.targetRevision, path: "/srv/repo",
  });
  expect(second).toMatchObject({ kind: "opened", key: keyB });
  late.resolve(opened("late-a"));
  await expect(first).rejects.toMatchObject({ code: "cancelled" });
  expect(port.close).toHaveBeenCalledWith("late-a");
  expect(remoteRepositoryState(keyA)).toBeNull();
  expect(remoteRepositoryState(keyB)).toMatchObject({ connected: true });
});

it("keeps the current SSH worktree if a new review cannot be accepted", async () => {
  await openHost();
  port.open.mockResolvedValueOnce(opened("session-b", snapshot({ repo: "repo-b" })));
  review.accept.mockRejectedValueOnce({ code: "target_changed", message: "invalid review" });
  await expect(openRemoteRepository({
    kind: "ssh", hostId: hostB.targetId, hostRevision: hostB.targetRevision, path: "/srv/repo",
  }, { reviewId: "review-b" })).rejects.toMatchObject({ code: "target_changed" });
  expect(port.close).toHaveBeenCalledWith("session-b");
  expect(port.close).not.toHaveBeenCalledWith("session-a");
  expect(remoteRepositoryState(keyA)).toMatchObject({ connected: true });
});

it("loads a Cliora task range, exact-HEAD diff and review token over its SSH session", async () => {
  const baseline = "b".repeat(40);
  const head = "a".repeat(40);
  const session = await openRemoteRepository({
    kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo",
  }, { reviewId: "review-a", baseline });
  if (session.kind !== "opened") throw new Error("fixture did not open");
  const generation = session.repository.generation;
  port.call.mockResolvedValueOnce({ review: { baselineOid: baseline } });
  await expect(api.taskReview(keyA, baseline, generation, 1)).rejects.toMatchObject({ code: "remote_protocol" });
  port.call.mockImplementation(async (request) => request.op === "taskReview"
    ? { review: {
      worktree: "/srv/repo", baselineOid: baseline, headOid: head, rangeVersion: "range",
      files: [], commits: [], branch: { name: "feature" },
    } }
    : { token: { baselineOid: baseline, path: "small.txt", token: "proof" } });
  port.diff.mockResolvedValue(page("diff --git a/small.txt b/small.txt\n--- a/small.txt\n+++ b/small.txt\n@@ -1 +1 @@\n-old\n+new\n"));
  await expect(api.taskReview(keyA, baseline, generation, 1)).resolves.toMatchObject({
    worktree: keyA, generation, baselineOid: baseline, headOid: head,
  });
  await api.loadTaskDiff(keyA, baseline, head, "small.txt", generation, 2);
  expect(port.diff).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: "session-a", head, view: "task", path: "small.txt",
  }));
  await expect(api.taskReviewToken(keyA, baseline, head, "small.txt", generation, 3))
    .resolves.toMatchObject({ token: "proof", generation });
  expect(invoke).not.toHaveBeenCalledWith("task_review", expect.anything());
});

beforeEach(() => {
  invoke.mockClear();
  for (const fn of Object.values(port)) fn.mockReset();
  for (const fn of Object.values(review)) fn.mockReset();
  port.targets.mockResolvedValue([hostA, hostB]);
  port.open.mockResolvedValue(opened());
  port.close.mockResolvedValue(undefined);
  port.status.mockResolvedValue(snapshot());
  port.diff.mockResolvedValue(page(""));
  port.write.mockResolvedValue({ state: "unknown", operationId: "x", message: "未准备" });
  port.recover.mockResolvedValue({ state: "unknown", operationId: "x", message: "未准备" });
  review.accept.mockResolvedValue(undefined);
  review.end.mockResolvedValue(undefined);
  review.returnReview.mockResolvedValue(undefined);
});

afterEach(async () => {
  await api.closeRepository().catch(() => undefined);
});

describe("远端仓库在主窗口：同一套 DTO", () => {
  it("打开返回 OpenedRepository，键是主机 + 远端路径，状态翻成 StatusSnapshot", async () => {
    const repository = await openHost();

    expect(port.open).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: hostA.targetId,
        targetRevision: hostA.targetRevision,
        path: "/srv/repo",
        allowInstall: false,
      }),
      expect.any(Function),
    );
    expect(repository.summary).toMatchObject({
      name: "repo",
      path: "ssh://host-a/srv/repo",
      host: "构建主机 A",
      remotePath: "/srv/repo",
    });
    expect(repository.generation).toBeGreaterThan(0);
    const files = repository.snapshot.files;
    expect(files.find((file) => file.path === "small.txt")).toMatchObject({ staged: "none", unstaged: "modified" });
    expect(files.find((file) => file.path === "staged.txt")).toMatchObject({ staged: "modified", unstaged: "none" });
    expect(files.find((file) => file.path === "new.txt")).toMatchObject({ untracked: true });
    expect(repository.snapshot.branch).toMatchObject({ name: "feature", detached: false, headOid: "a".repeat(40) });
    // 远端仓库不经过任何本机 Git 命令。
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Windows 盘符路径从打开到最近记录重开都保留中文、空格和保留字符", async () => {
    const raw = "  c:\\工作 区\\仓库 #50%\\  ";
    const canonical = "C:/工作 区/仓库 #50%";
    const path = normalizeRemotePath(raw);
    if (path === null) throw new Error("应当接受 Windows 绝对路径");
    expect(path).toBe(canonical);
    const snap = snapshot({ root: canonical });
    port.open.mockResolvedValueOnce(opened("session-windows", snap));

    const outcome = await openRemoteRepository({
      kind: "ssh",
      hostId: hostA.targetId,
      hostRevision: hostA.targetRevision,
      path,
    });
    if (outcome.kind !== "opened") throw new Error("应当打开远端工作树");
    const key = "ssh://host-a?path=" + encodeURIComponent(canonical);
    expect(outcome.repository.summary).toMatchObject({ name: "仓库 #50%", path: key, remotePath: canonical });
    expect(repositoryEndpoint(key, hostA.name)).toMatchObject({ kind: "ssh", displayPath: canonical, host: hostA.name });
    expect(port.open.mock.calls[0][0]).toMatchObject({ targetId: hostA.targetId, path: canonical });
    expect(invoke).not.toHaveBeenCalled();

    await api.closeRepository();
    expect(port.close).toHaveBeenCalledWith("session-windows");
    invoke.mockClear();
    port.open.mockResolvedValueOnce(opened("session-windows-reopened", snap));
    const reopened = await api.openRepository(key, 2);
    expect(reopened.summary).toMatchObject({ path: key, remotePath: canonical });
    expect(port.open.mock.calls[1][0]).toMatchObject({ targetId: hostA.targetId, path: canonical });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Windows 盘符根目录可往返，既有 POSIX 仓库键保持独立", () => {
    expect(normalizeRemotePath("z:\\")).toBe("Z:/");
    expect(parseRemoteRepositoryKey(remoteRepositoryKey("host-a", "z:\\"))).toEqual({ hostId: "host-a", path: "Z:/" });
    expect(normalizeRemotePath("C:repo")).toBeNull();
    expect(normalizeRemotePath("C:")).toBeNull();
    expect(normalizeRemotePath("\\\\server\\share")).toBeNull();
    expect(normalizeRemotePath("C:/invalid\0")).toBeNull();
    expect(parseRemoteRepositoryKey("ssh://host-a?path=C%ZZ")).toBeNull();

    const posix = "ssh://host-a/C:/repo";
    expect(remoteRepositoryKey("host-a", "/C:/repo")).toBe(posix);
    expect(remoteRepositoryKey("host-a", "C:/repo")).not.toBe(posix);
    expect(parseRemoteRepositoryKey(posix)).toEqual({ hostId: "host-a", path: "/C:/repo" });
  });

  it("刷新只在远端状态令牌变化时推进数值代次，旧响应不会被当成新代次", async () => {
    const repository = await openHost();
    const first = repository.generation;

    const same = await api.refreshStatus(keyA, first, 2);
    expect(same.generation).toBe(first);

    port.status.mockResolvedValueOnce(snapshot({ generation: "g2", branch: "other" }));
    const next = await api.refreshStatus(keyA, first, 3);
    expect(next.generation).toBeGreaterThan(first);
    expect(next.branch.name).toBe("other");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("分页差异解析成 DiffResponse：块、行号与增删计数都在主窗口这一侧", async () => {
    const repository = await openHost();
    const patch = [
      "diff --git a/small.txt b/small.txt",
      "--- a/small.txt",
      "+++ b/small.txt",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+two!",
      "+three",
      " four",
      "",
    ].join("\n");
    port.diff.mockResolvedValueOnce(page(patch, null));

    const pageOne = await api.loadDiff(keyA, "small.txt", false, repository.generation, 4);
    expect(pageOne.additions).toBe(2);
    expect(pageOne.deletions).toBe(1);
    expect(pageOne.totalLines).toBe(9);
    expect(pageOne.hunks).toHaveLength(1);
    expect(pageOne.hunks[0]).toMatchObject({ index: 0, header: "@@ -1,3 +1,4 @@", startLine: 3 });
    expect(pageOne.lines[3]).toMatchObject({ kind: "hunk", hunkIndex: 0 });
    expect(pageOne.lines[4]).toMatchObject({ kind: "context", text: "one", oldNo: 1, newNo: 1 });
    expect(pageOne.lines[5]).toMatchObject({ kind: "del", text: "two", oldNo: 2 });
    expect(pageOne.lines[6]).toMatchObject({ kind: "add", text: "two!", newNo: 2 });

    // 续页只切已解析结果，不再向远端要一次，块的 startLine 按页偏移重算。
    const pageTwo = await api.loadDiff(keyA, "small.txt", false, repository.generation, 5, null, 6, 10);
    expect(port.diff).toHaveBeenCalledTimes(1);
    expect(pageTwo.offset).toBe(6);
    expect(pageTwo.lines[0]).toMatchObject({ kind: "add", text: "two!" });
    expect(pageTwo.hunks[0].startLine).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("跨页被切开的 UTF-8 字符在整文件读取时重新拼回", async () => {
    const repository = await openHost();
    const text = "@@ -0,0 +1,1 @@\n+首段内容\n";
    const bytes = bytesOf(text);
    port.diff
      .mockResolvedValueOnce(page(bytes.slice(0, 2), "page-2"))
      .mockResolvedValueOnce(page(bytes.slice(2), null));

    const diff = await api.loadDiff(keyA, "small.txt", false, repository.generation, 6);
    const added = diff.lines.filter((line) => line.kind === "add").map((line) => line.text).join("");
    expect(added).toBe("首段内容");
    expect(port.diff.mock.calls[1][0]).toMatchObject({ path: "small.txt", view: "unstaged", cursor: "page-2" });
  });
});

describe("远端仓库在主窗口：写入与仓库键隔离", () => {
  it("暂存与提交复用同一个 StatusSnapshot / CommitResult，且不落回本机 Git", async () => {
    const repository = await openHost();
    const staged = snapshot({ generation: "g2" });
    port.call.mockResolvedValueOnce({ state: "completed", operationId: "op-1", snapshot: staged });

    const afterStage = await api.stageFiles(keyA, ["small.txt", "new.txt"], repository.generation, 7);
    expect(port.call).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-a", op: "stage", fields: { paths: ["small.txt", "new.txt"] }, generation: "g1",
    });
    expect(afterStage.generation).toBeGreaterThan(repository.generation);

    port.status.mockResolvedValue(staged);
    port.write.mockResolvedValueOnce({
      state: "completed",
      operationId: "op-2",
      snapshot: snapshot({ generation: "g3", files: [], head: "b".repeat(40) }),
    });
    const commit = await api.commitChanges(keyA, "远端提交\n\n正文不进入 summary", afterStage.generation, 8);
    expect(port.write.mock.calls[0][0]).toMatchObject({ op: "commit", message: "远端提交\n\n正文不进入 summary" });
    expect(commit).toMatchObject({ oid: "b".repeat(40), branch: "feature", pushed: false, summary: "远端提交" });
    expect(commit.snapshot.files).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the Git snapshot for hunk and line writes, and sends batches as arrays", async () => {
    const repo = await openHost();
    const token = "f".repeat(64);
    port.diff.mockResolvedValueOnce({
      ...page("@@ -1 +1 @@\n-old\n+new\n"),
      snapshot: token, hunksStageable: true, stageableHunks: [0],
    });
    const diff = await api.loadDiff(keyA, "small.txt", false, repo.generation, 1);
    expect(diff.snapshot).toBe(token);
    expect(diff.hunks[0].stageable).toBe(true);
    const success = { state: "completed", operationId: "patch", snapshot: snapshot({ generation: "g2" }) };
    port.call.mockResolvedValue(success);
    const staged = await api.stageHunks(keyA, "small.txt", false, [0], diff.snapshot, repo.generation, 2, "before.txt");
    const lines = [{ hunkIndex: 0, kind: "add", oldNo: null, newNo: 1 }] as const;
    await api.stageLines(keyA, "small.txt", true, [...lines], diff.snapshot, staged.generation, 3);
    await api.unstageFiles(keyA, ["small.txt", "new.txt"], staged.generation, 4);
    expect(port.call.mock.calls.map(([request]) => [request.op, request.fields])).toEqual([
      ["patch", { path: "small.txt", staged: false, hunks: [0], original: "before.txt", snapshot: token }],
      ["patch", { path: "small.txt", staged: true, lines, original: null, snapshot: token }],
      ["unstage", { paths: ["small.txt", "new.txt"] }],
    ]);
    expect(port.write).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("retains the confirmed commit after a rejected push and only pushes after reconnect", async () => {
    const repo = await openHost();
    const head = "c".repeat(40);
    const committed = snapshot({ generation: "g2", head, files: [] });
    const continuation = { head, branch: "feature", commitOperationId: "commit1" };
    port.write.mockResolvedValueOnce({
      state: "completed", operationId: "commit1", snapshot: committed, pushContinuations: [continuation],
    });
    port.call.mockResolvedValueOnce({
      state: "failed", operationId: "push1", code: "push_failed", message: "upstream rejected the push",
    });
    port.status.mockResolvedValue(committed);
    const report = await api.commitAndPush(keyA, "new commit", repo.generation, 1);
    expect(report).toMatchObject({ committed: true, pushed: false, retryPush: true, oid: head });
    expect(port.write).toHaveBeenCalledWith(expect.objectContaining({ op: "commit", pushAfter: true }));

    port.open.mockResolvedValueOnce({ ...opened("session-reopened", committed), pushContinuations: [continuation] });
    const reopened = await api.openRepository(keyA, 2);
    expect(remoteRepositoryState(keyA)?.pushContinuation).toEqual(continuation);
    await expect(api.commitAndPush(keyA, "do not repeat", reopened.generation, 3))
      .rejects.toMatchObject({ code: "push_pending" });
    port.call.mockResolvedValueOnce({
      state: "completed", operationId: "push2", snapshot: committed, pushContinuations: [],
    });
    await api.retryRemotePush(keyA, reopened.generation);
    expect(port.write).toHaveBeenCalledTimes(1);
    expect(port.call.mock.calls.map(([request]) => [request.op, request.fields])).toEqual([
      ["resumePush", { commitOperationId: "commit1" }],
      ["resumePush", { commitOperationId: "commit1" }],
    ]);
    expect(remoteRepositoryState(keyA)?.pushContinuation).toBeNull();
  });

  it("reconciles the original uncertain push after reconnect without repeating either stage", async () => {
    const repo = await openHost();
    const head = "c".repeat(40);
    const committed = snapshot({ generation: "g2", head, files: [] });
    const continuation = { head, branch: "feature", commitOperationId: "commit1" };
    port.write.mockResolvedValueOnce({
      state: "completed", operationId: "commit1", snapshot: committed, pushContinuations: [continuation],
    });
    port.call.mockResolvedValueOnce({ state: "unknown", operationId: "push1", op: "resumePush", message: "连接已断开" });
    const report = await api.commitAndPush(keyA, "new commit", repo.generation, 1);
    expect(report).toMatchObject({ committed: true, pushed: false, oid: head, pushUnconfirmed: true });
    expect(remoteRepositoryState(keyA)?.pending).toBe(true);

    port.open.mockResolvedValueOnce({
      ...opened("session-reopened", committed, { operationId: "push1", op: "resumePush" }),
      pushContinuations: [continuation],
    });
    port.recover.mockResolvedValueOnce({
      state: "completed", operationId: "push1", snapshot: committed, pushContinuations: [],
    });
    await api.openRepository(keyA, 2);
    expect(port.recover).toHaveBeenCalledExactlyOnceWith("session-reopened", "push1");
    expect(port.write).toHaveBeenCalledTimes(1);
    expect(port.call).toHaveBeenCalledTimes(1);
    expect(remoteRepositoryState(keyA)).toMatchObject({ pending: false, pushContinuation: null });
  });

  it("reconciles a lost commit receipt and only pushes the confirmed commit", async () => {
    const repo = await openHost();
    const head = "c".repeat(40);
    const committed = snapshot({ generation: "g2", head, files: [] });
    port.write.mockImplementationOnce(async (request) => ({
      state: "unknown", operationId: request.operationId, op: "commitAndPush", message: "连接已断开",
    }));
    await expect(api.commitAndPush(keyA, "new commit", repo.generation, 1)).rejects.toMatchObject({ code: "write_pending" });
    const pendingWrite = { operationId: port.write.mock.lastCall![0].operationId, op: "commitAndPush" };
    const continuation = { head, branch: "feature", commitOperationId: pendingWrite.operationId };
    expect(port.call).not.toHaveBeenCalled();

    port.open.mockResolvedValueOnce(opened("session-reopened", committed, pendingWrite));
    port.recover.mockResolvedValueOnce({
      state: "completed", operationId: pendingWrite.operationId, snapshot: committed, pushContinuations: [continuation],
    });
    const reopened = await api.openRepository(keyA, 2);
    expect(port.recover).toHaveBeenCalledExactlyOnceWith("session-reopened", pendingWrite.operationId);
    expect(remoteRepositoryState(keyA)).toMatchObject({ pending: false, pushContinuation: continuation });
    port.call.mockResolvedValueOnce({
      state: "completed", operationId: "push1", snapshot: committed, pushContinuations: [],
    });
    await api.retryRemotePush(keyA, reopened.generation);
    expect(port.call.mock.calls.map(([request]) => request.op)).toEqual(["resumePush"]);
    expect(port.write).toHaveBeenCalledTimes(1);
  });

  it("keeps two branch continuations and switches the selected receipt with the actual HEAD", async () => {
    const main = { branch: "feature", head: "a".repeat(40), commitOperationId: "commit-main" };
    const topic = { branch: "topic", head: "b".repeat(40), commitOperationId: "commit-topic" };
    port.open.mockResolvedValueOnce({ ...opened(), pushContinuations: [main, topic] });
    const repo = await api.openRepository(keyA, 1);
    expect(remoteRepositoryState(keyA)?.pushContinuation).toEqual(main);
    port.call.mockResolvedValueOnce({
      state: "failed", operationId: "push1", code: "push_target_changed", message: "原推送目标已变化",
      pushContinuations: [main, topic],
    });
    await expect(api.retryRemotePush(keyA, repo.generation)).rejects.toMatchObject({ code: "push_target_changed" });
    expect(remoteRepositoryState(keyA)?.pushContinuation).toEqual(main);

    const topicSnapshot = snapshot({ branch: topic.branch, head: topic.head, generation: "g2" });
    port.status.mockResolvedValueOnce(topicSnapshot);
    const current = await api.refreshStatus(keyA, repo.generation, 2);
    expect(remoteRepositoryState(keyA)?.pushContinuation).toEqual(topic);
    port.call.mockResolvedValueOnce({
      state: "completed", operationId: "push2", snapshot: topicSnapshot, pushContinuations: [main],
    });
    await api.retryRemotePush(keyA, current.generation);
    expect(remoteRepositoryState(keyA)?.pushContinuation).toBeNull();
    port.status.mockResolvedValueOnce(snapshot({ generation: "g3" }));
    await api.refreshStatus(keyA, current.generation, 3);
    expect(remoteRepositoryState(keyA)?.pushContinuation).toEqual(main);
    expect(port.call.mock.calls.map(([request]) => request.fields)).toEqual([
      { commitOperationId: "commit-main" },
      { commitOperationId: "commit-topic" },
    ]);
    expect(port.write).not.toHaveBeenCalled();
  });

  it("keeps the completed fetch visible when association stops before linking upstream", async () => {
    const repo = await openHost();
    const message = "已获取远程引用，上游关联尚未确认。远程没有对应分支。";
    port.call.mockResolvedValueOnce({
      state: "partial", operationId: "associate", code: "upstream_missing", phase: "fetched", message,
    });
    port.status.mockResolvedValueOnce(snapshot({ generation: "g2" }));
    await expect(api.associateUpstream(keyA, "", repo.generation, 1)).rejects.toMatchObject({
      code: "upstream_missing", message,
    });
    expect(remoteRepositoryState(keyA)).toMatchObject({ pending: false, recoveryNotice: message });
    expect(port.call).toHaveBeenCalledTimes(1);
    expect(port.status).toHaveBeenCalledTimes(1);
  });

  it("reports a completed push even when its upstream still needs to be linked", async () => {
    const repo = await openHost();
    const head = "c".repeat(40);
    const committed = snapshot({ head, generation: "g2" });
    port.write.mockResolvedValueOnce({
      state: "completed", operationId: "commit1", snapshot: committed,
      pushContinuations: [{ head, branch: "feature", commitOperationId: "commit1" }],
    });
    const warning = "原提交已推送，上游跟踪尚未确认。请从分支列表设置。";
    port.call.mockResolvedValueOnce({
      state: "partial", operationId: "push1", code: "push_tracking_unfinished", phase: "pushed",
      message: warning, pushContinuations: [],
    });
    port.status.mockResolvedValueOnce(committed);
    const result = await api.commitAndPush(keyA, "publish", repo.generation, 1);
    expect(result).toMatchObject({ committed: true, pushed: true, retryPush: false, pushError: null, summary: warning });
    expect(remoteRepositoryState(keyA)).toMatchObject({ pushContinuation: null, recoveryNotice: warning });
    await expect(api.retryRemotePush(keyA, result.generation)).rejects.toMatchObject({ code: "push_intent_changed" });
    expect(port.call).toHaveBeenCalledTimes(1);
  });

  it("shows an incomplete push after some remote refs were updated", async () => {
    const repo = await openHost();
    const message = "部分远程引用已更新。Git 拒绝了其他引用。";
    port.call.mockResolvedValueOnce({
      state: "partial", operationId: "push1", code: "push_rejected", phase: "refs_pushed", message,
    });
    port.status.mockResolvedValueOnce(snapshot({ generation: "g2" }));
    await expect(api.pushBranch(keyA, repo.generation, 1)).rejects.toMatchObject({ code: "push_rejected", message });
    expect(remoteRepositoryState(keyA)).toMatchObject({ pending: false, recoveryNotice: message });
    expect(port.call).toHaveBeenCalledTimes(1);
  });

  it("keeps linked-worktree actions on the active SSH host and checks the deletion preview", async () => {
    const repo = await openHost();
    const target = "/srv/other";
    const preview = { target, token: "f".repeat(64), branch: "topic", head: "a".repeat(40) };
    port.call.mockResolvedValueOnce({ repo: "repo-a", preview });
    expect(await api.previewLinkedWorktreeRemoval(keyA, target, repo.generation)).toEqual(preview);
    port.call.mockResolvedValueOnce({
      state: "completed", operationId: "remove", snapshot: snapshot({ generation: "g2" }),
    });
    await api.removeLinkedWorktree(keyA, preview, false, repo.generation);
    expect(port.call.mock.calls[1][0]).toMatchObject({
      sessionId: "session-a", op: "worktreeRemoveTarget", fields: { target, targetToken: preview.token, force: false },
    });
    port.call.mockResolvedValueOnce({ repo: "repo-a", worktrees: { items: [{ path: target, missing: false }] } });
    port.open.mockResolvedValueOnce(opened("sibling", snapshot({ repo: "repo-sibling", root: target })));
    const sibling = await api.openLinkedWorktree(keyA, target);
    expect(sibling.summary.path).toBe(remoteRepositoryKey(hostA.targetId, target));
    expect(port.open.mock.lastCall?.[0]).toMatchObject({ targetId: hostA.targetId, targetRevision: hostA.targetRevision, path: target });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps case-sensitive Windows worktrees distinct during preview and opening", async () => {
    const repo = await openHost();
    const target = "C:/repo/topic";
    const other = "C:/repo/Topic";
    port.call.mockResolvedValueOnce({
      repo: "repo-a", preview: { target: other, token: "f".repeat(64) },
    });
    await expect(api.previewLinkedWorktreeRemoval(keyA, target, repo.generation))
      .rejects.toMatchObject({ code: "remote_protocol" });

    port.call.mockResolvedValueOnce({ repo: "repo-a", worktrees: { items: [
      { path: other, missing: false },
      { path: "c:\\repo\\topic", missing: false },
    ] } });
    port.open.mockResolvedValueOnce(opened("sibling", snapshot({ repo: "repo-sibling", root: target })));
    const sibling = await api.openLinkedWorktree(keyA, target);
    expect(sibling.summary.path).toBe(remoteRepositoryKey(hostA.targetId, target));
    expect(port.open.mock.lastCall?.[0]).toMatchObject({ path: "c:\\repo\\topic" });
  });

  it("rereads a linked-worktree preview when the anchor watcher advances the generation", async () => {
    const repo = await openHost();
    const target = "/srv/other";
    const preview = { target, token: "f".repeat(64), branch: "topic", head: "a".repeat(40) };
    const first = deferred<{ repo: string; preview: typeof preview }>();
    port.call.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ repo: "repo-a", preview });
    const pending = api.previewLinkedWorktreeRemoval(keyA, target, repo.generation);
    port.status.mockResolvedValueOnce(snapshot({ generation: "g2" }));
    await api.refreshStatus(keyA, repo.generation, 2);
    first.resolve({ repo: "repo-a", preview });
    await expect(pending).resolves.toEqual(preview);
    expect(port.call.mock.calls.map(([request]) => [request.op, request.fields])).toEqual([
      ["worktreeRemovalPreview", { target }],
      ["worktreeRemovalPreview", { target }],
    ]);
  });

  it("两台主机的同名工作树路径是不同的仓库,切换后旧会话不再接受写入", async () => {
    await openHost(hostA, keyA, "session-a");
    await openHost(hostB, keyB, "session-b");

    expect(keyA).not.toBe(keyB);
    expect(port.close).toHaveBeenCalledWith("session-a");
    expect(remoteRepositoryState(keyA)).toBeNull();
    expect(remoteRepositoryState(keyB)).toMatchObject({ host: "构建主机 B", path: "/srv/repo" });

    await expect(api.refreshStatus(keyA, 1, 9)).rejects.toMatchObject({ code: "remote_disconnected" });
    await expect(api.stageFiles(keyA, ["small.txt"], 1, 10)).rejects.toMatchObject({ code: "remote_disconnected" });
  });

  it("迟到的差异响应无法写到另一个仓库上", async () => {
    const repository = await openHost(hostA, keyA, "session-a");
    const lateDiff = deferred<{ data: string; nextCursor: string | null }>();
    port.diff.mockReturnValueOnce(lateDiff.promise);

    const pending = api.loadDiff(keyA, "small.txt", false, repository.generation, 11);
    await openHost(hostB, keyB, "session-b");
    lateDiff.resolve(page("+old host\n"));

    await expect(pending).rejects.toMatchObject({ code: "remote_disconnected" });
  });

  it("断线后只读：状态读取失败即停止发送写入，已读内容不被改写", async () => {
    const repository = await openHost();
    port.status.mockRejectedValueOnce({ code: "remote_disconnected", message: "SSH 已断开" });

    await expect(api.refreshStatus(keyA, repository.generation, 12)).rejects.toMatchObject({
      code: "remote_disconnected",
    });
    expect(remoteRepositoryState(keyA)).toMatchObject({ connected: false });

    port.write.mockClear();
    await expect(api.stageFiles(keyA, ["small.txt"], repository.generation, 13)).rejects.toMatchObject({
      code: "remote_disconnected",
    });
    await expect(api.loadDiff(keyA, "small.txt", false, repository.generation, 14)).rejects.toMatchObject({
      code: "remote_disconnected",
    });
    // 断线不会发出写入，也不会改用本机 Git。
    expect(port.write).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("待确认写入在打开时只核对回执，不重发原操作", async () => {
    const pendingWrite = { op: "commit", operationId: "5d751ed7-c132-4ae8-b48f-b801db4db2ba" };
    const recovered = snapshot({ generation: "g9", files: [], head: "c".repeat(40) });
    port.open.mockResolvedValueOnce(opened("session-a", snapshot(), pendingWrite));
    port.recover.mockResolvedValueOnce({ state: "completed", operationId: pendingWrite.operationId, snapshot: recovered });

    const repository = await api.openRepository(keyA, 1);
    expect(port.recover).toHaveBeenCalledWith("session-a", pendingWrite.operationId);
    expect(port.write).not.toHaveBeenCalled();
    expect(remoteRepositoryState(keyA)).toMatchObject({ pending: false });
    expect(repository.snapshot.files).toEqual([]);
    expect(repository.snapshot.branch.headOid).toBe("c".repeat(40));
  });

  it("回执仍未知时保持待确认并禁用写入", async () => {
    const pendingWrite = { op: "stage", operationId: "6d751ed7-c132-4ae8-b48f-b801db4db2ba" };
    port.open.mockResolvedValueOnce(opened("session-a", snapshot(), pendingWrite));
    port.recover.mockResolvedValueOnce({ state: "unknown", operationId: pendingWrite.operationId, message: "远端没有足够证据" });

    const repository = await api.openRepository(keyA, 1);
    expect(remoteRepositoryState(keyA)).toMatchObject({ pending: true });
    await expect(api.stageFiles(keyA, ["small.txt"], repository.generation, 15)).rejects.toMatchObject({
      code: "write_pending",
    });
    expect(port.write).not.toHaveBeenCalled();
  });
});

describe("远端仓库在主窗口：安装确认与审查来源", () => {
  it("安装需要显式确认；未确认不发起传输", async () => {
    port.open.mockResolvedValueOnce({ kind: "install_required", version: "v2", size: 2048, confirmationId: "offer-1" });

    const offer = await openRemoteRepository({
      kind: "ssh",
      hostId: hostA.targetId,
      hostRevision: hostA.targetRevision,
      path: "/srv/repo",
    });
    expect(offer).toMatchObject({ kind: "install_required", version: "v2", size: 2048, confirmationId: "offer-1" });
    expect(port.open.mock.calls[0][0]).toMatchObject({ allowInstall: false });
    expect(port.open.mock.calls[0][0].installConfirmation).toBeUndefined();

    port.open.mockResolvedValueOnce(opened("session-installed"));
    const installed = await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { allowInstall: true, installConfirmation: "offer-1" },
    );
    expect(installed.kind).toBe("opened");
    expect(port.open.mock.calls[1][0]).toMatchObject({ allowInstall: true, installConfirmation: "offer-1" });
  });

  it("打开后接受审查来源，返回结果走远程审查通道而不是本机仓库", async () => {
    port.open.mockResolvedValueOnce(opened("session-review"));
    const outcome = await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-1" },
    );
    expect(outcome.kind).toBe("opened");
    expect(review.accept).toHaveBeenCalledWith("review-1", "session-review");
    expect(remoteRepositoryState(keyA)).toMatchObject({ reviewId: "review-1" });

    await api.remoteReturnReview(keyA);
    expect(review.returnReview).toHaveBeenCalledWith("review-1", "session-review");
    expect(keyA).toBe("ssh://host-a/srv/repo");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("本机路径仍走原生命令：分派只看仓库键，不改本机行为", async () => {
    invoke.mockResolvedValueOnce({ generation: 7, branch: {}, files: [] });
    const snapshotLocal = await api.refreshStatus("C:/work/demo", 7, 16);
    expect(invoke).toHaveBeenLastCalledWith("refresh_status", { path: "C:/work/demo", generation: 7, requestId: 16 });
    expect(snapshotLocal.generation).toBe(7);
    expect(port.status).not.toHaveBeenCalled();
  });
});


describe("远端仓库在主窗口：审查基线、草稿与新建/克隆的边界", () => {
  it("审查来源的基线随打开请求原样发送，没有基线时不带这个字段", async () => {
    const baseline = "d".repeat(40);
    port.open.mockResolvedValueOnce(opened("session-review"));
    const outcome = await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-1", baseline },
    );
    expect(outcome.kind).toBe("opened");
    // 后端按 baseline 相等判定这条打开是不是那条审查：前端必须原样回传。
    expect(port.open.mock.calls[0][0]).toMatchObject({ reviewId: "review-1", baseline });

    port.open.mockResolvedValueOnce(opened("session-plain"));
    await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-2", baseline: null },
    );
    expect(port.open.mock.calls[1][0].baseline).toBeUndefined();
  });

  it("远端草稿只留在会话内存里：切到别处再回来仍是那份，且不写本机草稿库", async () => {
    await openHost(hostA, keyA, "session-a");
    await api.saveDraft(keyA, "远端草稿正文");
    // 本机草稿库只按本机仓库路径保存：远端草稿一次都没有交给本机命令。
    expect(invoke).not.toHaveBeenCalled();

    await openHost(hostB, keyB, "session-b");
    expect(remoteRepositoryState(keyA)).toBeNull();

    const reopened = await openHost(hostA, keyA, "session-a2");
    expect(reopened.draft).toBe("远端草稿正文");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("新建仓库失败时远端会话不连坐结束，成功后才结束", async () => {
    await openHost(hostA, keyA, "session-a");
    // 目录不可用：没有切换发生，当前远端仓库必须原样留着。
    invoke.mockRejectedValueOnce({ code: "path_missing", message: "父目录不存在。" });
    await expect(api.createRepository("C:/work/new", 20)).rejects.toMatchObject({ code: "path_missing" });
    expect(port.close).not.toHaveBeenCalled();
    expect(review.end).not.toHaveBeenCalled();
    expect(remoteRepositoryState(keyA)).toMatchObject({ key: keyA, connected: true });

    // 成功即确认要切换：这时才结束远端会话。
    invoke.mockResolvedValueOnce({});
    await api.createRepository("C:/work/new", 21);
    expect(port.close).toHaveBeenCalledWith("session-a");
    expect(remoteRepositoryState(keyA)).toBeNull();
  });

  it("克隆失败不动当前远端会话，成功也不替外壳决定切换", async () => {
    await openHost(hostA, keyA, "session-a");
    invoke.mockRejectedValueOnce({ code: "auth", message: "认证失败。" });
    await expect(
      api.cloneRepository("https://example.invalid/r.git", "C:/work", "r", 22, null),
    ).rejects.toMatchObject({ code: "auth" });
    // 失败时用户还在原远端仓库：连接与审查来源都保留，Cliora 不会收到提前的 cancelled。
    expect(port.close).not.toHaveBeenCalled();
    expect(review.end).not.toHaveBeenCalled();
    expect(remoteRepositoryState(keyA)).not.toBeNull();

    // 成功后仍可能点「在后台继续」：api 不结束会话，等外壳确认切换时再结束。
    invoke.mockResolvedValueOnce({ path: "C:/work/r", opened: { summary: { name: "r", path: "C:/work/r" } } });
    await api.cloneRepository("https://example.invalid/r.git", "C:/work", "r", 23, null);
    expect(port.close).not.toHaveBeenCalled();
    expect(remoteRepositoryState(keyA)).not.toBeNull();

    await api.closeRemoteRepository(keyA);
    expect(port.close).toHaveBeenCalledWith("session-a");
    expect(remoteRepositoryState(keyA)).toBeNull();
  });

  it("切到本机仓库失败时当前远端会话仍是可用的那个", async () => {
    await openHost(hostA, keyA, "session-a");
    invoke.mockRejectedValueOnce({ code: "path_missing", message: "仓库目录不存在。" });
    await expect(api.openRepository("C:/work/missing", 24)).rejects.toMatchObject({ code: "path_missing" });
    expect(port.close).not.toHaveBeenCalled();
    expect(remoteRepositoryState(keyA)).toMatchObject({ key: keyA, connected: true });

    invoke.mockResolvedValueOnce({ summary: { name: "demo", path: "C:/work/demo" }, generation: 4 });
    await api.openRepository("C:/work/demo", 25);
    expect(port.close).toHaveBeenCalledWith("session-a");
    expect(remoteRepositoryState(keyA)).toBeNull();
  });
});

describe("远端文件与终端", () => {
  it("Windows 文件树和搜索走同一个 SSH 响应代次", async () => {
    const root = "C:/工作区/含 空格";
    const key = remoteRepositoryKey(hostA.targetId, root);
    const repository = await openHost(hostA, key, "session-win", snapshot({ root, repo: root }));
    port.call
      .mockResolvedValueOnce({ repo: root, directory: { path: "", generation: 1, entries: [{ path: "中文.md" }] } })
      .mockResolvedValueOnce({ repo: root, search: { generation: 1, hits: [] } })
      .mockResolvedValueOnce({ repo: root, search: { generation: 1, matches: [] } });
    const { generation } = repository;
    await expect(api.repositoryDirectory(key, "", false, generation, 61)).resolves.toMatchObject({ generation });
    await api.repositoryPathSearch(key, "中文", null, false, 50, generation, 62);
    await api.repositoryContentSearch(key, "标记", { kind: "file", path: "中文.md" }, false, 30, generation, 63);
    expect(port.call.mock.calls.map(([request]) => request)).toEqual([
      { sessionId: "session-win", op: "directory", readId: 61, fields: { relative: "", includeIgnored: false } },
      { sessionId: "session-win", op: "pathSearch", readId: 62, fields: { query: "中文", directory: null, includeIgnored: false, limit: 50 } },
      { sessionId: "session-win", op: "contentSearch", readId: 63, fields: { query: "标记", scope: { kind: "file", path: "中文.md" }, includeIgnored: false, limit: 30 } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("在 Cliora 会话中保持 Markdown 的来源绑定和图片的取消归属", async () => {
    const openedReview = await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "remote-review", baseline: "c".repeat(40) },
    );
    if (openedReview.kind !== "opened") throw new Error("expected review session");
    const { generation } = openedReview.repository;
    const source = { path: "doc.md", revision: "worktree" };
    port.call
      .mockResolvedValueOnce({ repo: "repo-a", document: { generation: 7, source: { ...source, repository: "repo-a" } } })
      .mockResolvedValueOnce({ repo: "repo-a", resource: { kind: "image", generation: 7 } })
      .mockResolvedValueOnce({ repo: "repo-a", image: { kind: "image", generation: 0 } });
    const doc = await api.repositoryDocument(keyA, source, generation, 70);
    expect(doc.source.repository).toBe(keyA);
    await expect(api.documentResource(keyA, { ...doc.source, path: "资产/a.png" }, generation, 71)).resolves.toMatchObject({ generation });
    await expect(api.documentResource(keyA, { ...doc.source, repository: keyB }, generation, 72)).rejects.toMatchObject({ code: "document_repository" });
    await api.documentRemoteImage("https://example.com/a.png", 73, keyA);
    expect(port.call.mock.calls.map(([request]) => request.op)).toEqual(["document", "documentResource", "documentRemoteImage"]);
    expect(port.call.mock.calls[1][0].fields.source.repository).toBe("repo-a");
    expect(invoke).not.toHaveBeenCalled();
    await api.cancelDocumentResources(73);
    expect(port.cancelReads).toHaveBeenCalledWith("session-a", 73);
  });

  it("文件保存保留版本摘要，并把已确认的编辑冲突和预期回执区分开", async () => {
    const { generation } = await openHost();
    port.call
      .mockResolvedValueOnce({ state: "failed", operationId: "first", code: "edit_conflict", message: "文件在编辑期间已变化" })
      .mockResolvedValueOnce({
        state: "completed", operationId: "second", snapshot: snapshot({ generation: "g2" }),
        edit: { path: "小.txt", text: "next\n", digest: "b".repeat(64), generation: 2 },
      });
    await expect(api.repositoryEditSave(keyA, "小.txt", "a".repeat(64), "draft", generation, 81)).rejects.toMatchObject({ code: "edit_conflict" });
    expect(remoteRepositoryState(keyA)?.pending).toBe(false);
    const saved = await api.repositoryEditSave(keyA, "小.txt", "c".repeat(64), "next\n", generation, 82);
    expect(saved).toMatchObject({ text: "next\n", digest: "b".repeat(64) });
    expect(saved.generation).toBeGreaterThan(generation);
    expect(port.call.mock.calls[1][0]).toEqual({
      sessionId: "session-a", op: "editSave", generation: "g1",
      fields: { path: "小.txt", expectedDigest: "c".repeat(64), content: "next\n" },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("远端批量删除保留实际部分失败，重复删除不会切成永久模式", async () => {
    const { generation } = await openHost();
    port.call.mockResolvedValueOnce({
      state: "completed", operationId: "delete", snapshot: snapshot({ generation: "g2" }),
      delete: { deleted: ["one.txt"], skipped: [], failures: [{ path: "two.txt", code: "trash_failed", message: "回收站不可用" }] },
    });
    const result = await api.repositoryDeleteEntries(keyA, ["one.txt", "two.txt"], false, generation, 85);
    expect(result.deleted).toEqual(["one.txt"]);
    expect(result.failures).toMatchObject([{ path: "two.txt", code: "trash_failed" }]);
    expect(port.call).toHaveBeenCalledOnce();
    expect(port.call.mock.calls[0][0].fields.permanent).toBe(false);
  });

  it("终端拼接分片输出并在断线后阻止旧会话落到本机终端", async () => {
    const events = deferred<RemoteEventBatch>();
    const disconnected = deferred<RemoteEventBatch>();
    port.events.mockReturnValueOnce(events.promise).mockReturnValueOnce(disconnected.promise);
    port.open.mockResolvedValue({ ...opened(), events: true });
    const repository = await api.openRepository(keyA, 90);
    const remoteTerminal = { repoPath: "repo-a", sessionId: "terminal-5-1", seq: 0, cwd: "/srv/repo", shell: "/bin/sh", running: true };
    port.call
      .mockResolvedValueOnce({ repo: "repo-a", terminal: remoteTerminal })
      .mockResolvedValueOnce({ repo: "repo-a", accepted: true });
    const term = await api.terminalCreate(repository.summary.path);
    expect(term.sessionId).not.toBe(remoteTerminal.sessionId);
    await api.terminalWrite(term.sessionId, "pwd\r");
    expect(port.call.mock.calls[1][0]).toMatchObject({
      sessionId: "session-a", op: "terminalInput", fields: { sessionId: "terminal-5-1", data: "pwd\r" },
    });
    const output = vi.fn();
    const stop = await listenEvent("terminal-output", output);
    try {
      const event = { repo: "repo-a", event: "terminalOutput", sessionId: "terminal-5-1", seq: 1, parts: 2 };
      events.resolve({
        overflow: false, disconnected: false,
        events: [
          { ...event, repo: "alternate-repo", part: 0, data: "别的仓库" },
          { ...event, part: 0, data: "远端" }, { ...event, part: 1, data: "输出" },
        ],
      });
      await vi.waitFor(() => expect(output).toHaveBeenCalledExactlyOnceWith({ sessionId: term.sessionId, seq: 1, data: "远端输出" }));
      disconnected.resolve({ events: [], overflow: false, disconnected: true });
      await vi.waitFor(() => expect(remoteRepositoryState(keyA)?.connected).toBe(false));
      await expect(api.terminalWrite(term.sessionId, "old")).rejects.toMatchObject({ code: "terminal_closed" });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("事件 IPC 出错时保持仓库连接并允许手动读取", async () => {
    port.events.mockRejectedValueOnce("event command unavailable");
    port.open.mockResolvedValue({ ...opened(), events: true });
    port.call.mockResolvedValueOnce({ repo: "repo-a", directory: { generation: 1, entries: [] } });
    const changed = vi.fn();
    const stop = await listenEvent("repo-changed", changed);
    try {
      const { generation } = await api.openRepository(keyA, 90);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({ path: keyA, generation, degraded: true }));
      expect(remoteRepositoryState(keyA)?.connected).toBe(true);
      await expect(api.repositoryDirectory(keyA, "", false, generation, 91)).resolves.toMatchObject({ entries: [] });
    } finally {
      stop();
    }
  });

  it("初始历史差异使用组件默认分页，显式下一页保留大小", async () => {
    const { generation } = await openHost();
    port.call
      .mockResolvedValueOnce({ repo: "repo-a", diff: {} })
      .mockResolvedValueOnce({ repo: "repo-a", compareFileDiff: {} });
    await api.commitFileDiff(keyA, "a".repeat(40), null, "small.txt", generation, 91);
    await api.compareFileDiff(keyA, "a".repeat(40), "b".repeat(40), "small.txt", generation, 92, 50, 100);
    expect(port.call.mock.calls[0][0].fields).not.toHaveProperty("limit");
    expect(port.call.mock.calls[1][0].fields).toMatchObject({ offset: 50, limit: 100 });
  });
});

describe("远端桥接：op 白名单与块级可暂存标记", () => {
  it("白名单与 Rust 侧的 BRIDGE_READ_OPS / BRIDGE_WRITE_OPS 逐项一致", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src-tauri/src/remote_worktree.rs", import.meta.url), "utf8");
    const declared = (name: string): string[] => {
      const marker = `const ${name}: &[&str] = &[`;
      const start = source.indexOf(marker);
      expect(start, `缺少 ${name}`).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("];", start);
      const block = source.slice(start + marker.length, end);
      return [...block.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
    };
    expect([...REMOTE_READ_OPS]).toEqual(declared("BRIDGE_READ_OPS"));
    expect([...REMOTE_WRITE_OPS]).toEqual(declared("BRIDGE_WRITE_OPS"));
    expect([...REMOTE_TERMINAL_OPS]).toEqual(declared("TERMINAL_OPS"));
    // 有独立命令的 op 不经桥接，避免同一条能力出现两个入口。
    for (const op of ["open", "status", "diff", "write", "recover"]) {
      expect([...REMOTE_READ_OPS, ...REMOTE_WRITE_OPS]).not.toContain(op);
    }
  });

  it("解析器按远端载荷标记填 stageable，缺省时保持不可暂存", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two!",
      "+three",
      "@@ -9,1 +10,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const capable = parseRemotePatch(patch, { hunksStageable: true });
    expect(capable.hunks.map((hunk) => hunk.stageable)).toEqual([true, true]);

    const fallback = parseRemotePatch(patch);
    expect(fallback.hunks.map((hunk) => hunk.stageable)).toEqual([false, false]);
    expect(parseRemotePatch(patch, { hunksStageable: false }).hunks[0].stageable).toBe(false);
  });

  it("二进制差异即使被标成可暂存也不给按块写入", () => {
    const binary = parseRemotePatch(
      ["Binary files a/logo.png and b/logo.png differ", ""].join("\n"),
      { hunksStageable: true },
    );
    expect(binary.binary).toBe(true);
    expect(binary.hunks).toEqual([]);
  });
});

