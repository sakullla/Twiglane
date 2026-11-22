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
}));

const review = vi.hoisted(() => ({
  begin: vi.fn(),
  accept: vi.fn(),
  end: vi.fn(),
  returnReview: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../src/lib/remote-worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/remote-worktree")>();
  return { ...actual, remoteWorktreePort: port, remoteReviewPort: review };
});

import { api, openRemoteRepository, remoteRepositoryState } from "../src/lib/api";
import {
  REMOTE_READ_OPS,
  REMOTE_WRITE_OPS,
  parseRemotePatch,
  remoteRepositoryKey,
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
    port.write.mockResolvedValueOnce({ state: "completed", operationId: "op-1", snapshot: staged });

    const afterStage = await api.stageFiles(keyA, ["small.txt"], repository.generation, 7);
    expect(port.write.mock.calls[0][0]).toMatchObject({ op: "stage", path: "small.txt", generation: "g1" });
    expect(afterStage.generation).toBeGreaterThan(repository.generation);

    port.status.mockResolvedValue(staged);
    port.write.mockResolvedValueOnce({
      state: "completed",
      operationId: "op-2",
      snapshot: snapshot({ generation: "g3", files: [], head: "b".repeat(40) }),
    });
    const commit = await api.commitChanges(keyA, "远端提交\n\n正文不进入 summary", afterStage.generation, 8);
    expect(port.write.mock.calls[1][0]).toMatchObject({ op: "commit", message: "远端提交\n\n正文不进入 summary" });
    expect(commit).toMatchObject({ oid: "b".repeat(40), branch: "feature", pushed: false, summary: "远端提交" });
    expect(commit.snapshot.files).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
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

