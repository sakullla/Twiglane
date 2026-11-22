// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 远端桥接（T7）：历史、分支、同步、stash、合并都经 op 白名单走同一个远端端口。
 * 这里顶替两处边界——Tauri 命令（本机）与远端端口（SSH）——断言每条远端入口都只发
 * 一次白名单 op、按会话代次组合 DTO，并且绝不回退到本机 Git。
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
import { remoteRepositoryKey } from "../src/lib/remote-worktree";

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

function completed(snap: unknown) {
  return {
    state: "completed",
    operationId: "op-1",
    snapshot: snap,
    head: (snap as { head?: string }).head ?? null,
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function diffPage(text: string | Uint8Array, nextCursor: string | null = null) {
  const bytes = typeof text === "string" ? bytesOf(text) : text;
  return { data: btoa(String.fromCharCode(...bytes)), nextCursor };
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
  port.diff.mockResolvedValue(diffPage(""));
  port.write.mockResolvedValue({ state: "unknown", operationId: "x", message: "未准备" });
  port.recover.mockResolvedValue({ state: "unknown", operationId: "x", message: "未准备" });
  port.call.mockResolvedValue({});
  review.accept.mockResolvedValue(undefined);
  review.end.mockResolvedValue(undefined);
  review.returnReview.mockResolvedValue(undefined);
});

afterEach(async () => {
  await api.closeRepository().catch(() => undefined);
});

describe("远端桥接：历史、分支、同步、stash、合并都走 op 白名单", () => {
  it("历史分页返回桌面的 HistoryPage，筛选按 v2 的 pathFilter 转发", async () => {
    const repository = await openHost();
    port.call.mockResolvedValueOnce({
      repo: "repo-a",
      generation: 12,
      page: {
        generation: 12,
        query: "",
        offset: 40,
        pageSize: 40,
        hasMore: true,
        state: "ok",
        commits: [{ oid: "a".repeat(40), parents: [], summary: "远端提交", authorName: "dev", authorEmail: "d@e", authoredAt: 1, labels: [] }],
        scope: "current",
        branches: ["feature"],
        head: "a".repeat(40),
      },
      nextOffset: 80,
    });

    const page = await api.historyPage(keyA, "", 40, repository.generation, 30, { path: "src/a.ts" });
    // 只读入口不带 generation：v2 的只读字段表里没有它，多带一个字段会让请求判成无效。
    expect(port.call).toHaveBeenCalledWith({
      sessionId: "session-a",
      op: "history",
      fields: { query: "", offset: 40, pathFilter: "src/a.ts" },
    });
    // 代次换成本会话的数值代次：界面按它比较新旧响应。
    expect(page.generation).toBe(repository.generation);
    expect(page.commits[0]).toMatchObject({ oid: "a".repeat(40), summary: "远端提交" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("文件历史把路径放在 path 字段，分页信息原样返回", async () => {
    const repository = await openHost();
    port.call.mockResolvedValueOnce({
      repo: "repo-a",
      page: {
        generation: 12,
        path: "small.txt",
        offset: 0,
        pageSize: 40,
        hasMore: false,
        state: "ok",
        commits: [],
        scope: "current",
        branches: ["feature"],
        head: "a".repeat(40),
      },
    });

    const page = await api.fileHistory(keyA, "small.txt", 0, repository.generation, 31);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "fileHistory", fields: { path: "small.txt", offset: 0 } });
    expect(page.path).toBe("small.txt");
    expect(page.generation).toBe(repository.generation);
  });

  it("分支写入先发 branchSwitch，再读一次 branchState 组成同一个 BranchState", async () => {
    const repository = await openHost();
    const switched = snapshot({ generation: "g2", branch: "main" });
    port.call
      .mockResolvedValueOnce(completed(switched))
      .mockResolvedValueOnce({
        repo: "repo-a",
        branchState: {
          generation: 13,
          branches: [
            { name: "main", remote: false, current: true, upstream: null, worktree: null },
            { name: "feature", remote: false, current: false, upstream: null, worktree: null },
          ],
          snapshot: {},
        },
      });

    const state = await api.switchBranch(keyA, "main", repository.generation, 32);
    // 写入带会话令牌：v2 由原生桥接换成最新 stateToken，v1 就是这条字符串代次。
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "branchSwitch", fields: { name: "main" }, generation: "g1" });
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "branchState" });
    expect(state.generation).toBe(repository.generation + 1);
    expect(state.branches.map((branch) => branch.name)).toEqual(["main", "feature"]);
    expect(state.snapshot.branch.name).toBe("main");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("同步 op 只回状态：fetch 与 push 都返回 StatusSnapshot 且推进代次", async () => {
    const repository = await openHost();
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2", branch: "main" })));

    const fetched = await api.fetchRemote(keyA, repository.generation, 33);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "fetch" });
    expect(fetched.branch.name).toBe("main");
    expect(fetched.generation).toBe(repository.generation + 1);

    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g3", branch: "main" })));
    const pushed = await api.pushToRemote(keyA, "origin", fetched.generation, 34);
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "pushToRemote", fields: { remote: "origin" } });
    expect(pushed.generation).toBe(fetched.generation + 1);
  });

  it("临时保存：写入后重新读一次列表，标识取自读回的最新记录", async () => {
    const repository = await openHost();
    port.call
      .mockResolvedValueOnce(completed(snapshot({ generation: "g2", files: [] })))
      .mockResolvedValueOnce({
        repo: "repo-a",
        stash: {
          generation: 13,
          preview: { trackedCount: 0, untrackedCount: 0, ignoredCount: 0, trackedPaths: [], untrackedPaths: [], ignoredPaths: [], includeUntracked: true, canSave: false, summary: "" },
          records: [{ oid: "b".repeat(40), message: "远端临时保存", committedAt: 1 }],
          snapshot: {},
        },
      });

    const result = await api.saveStash(keyA, true, "远端临时保存", repository.generation, 35);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "stashSave", fields: { includeUntracked: true, message: "远端临时保存" } });
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "stashState", fields: { includeUntracked: true } });
    expect(result.oid).toBe("b".repeat(40));
    expect(result.state.records).toHaveLength(1);
  });

  it("合并：开始合并先写再读会话，完成时用新 HEAD 的提交组成 MergeComplete", async () => {
    const repository = await openHost();
    const merged = snapshot({ generation: "g2", head: "c".repeat(40) });
    port.call
      .mockResolvedValueOnce(completed(merged))
      .mockResolvedValueOnce({
        repo: "repo-a",
        merge: { generation: 13, operation: "merge", canContinue: true, canAbort: true, source: "feature", target: "main", headOid: "c".repeat(40), conflicts: [{ path: "a.txt", kind: "content", summary: "" }], unresolved: 1, note: "", snapshot: {} },
      });

    const session = await api.startMerge(keyA, "feature", null, "ff-only", repository.generation, 36);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "mergeStart", fields: { source: "feature", target: null, mode: "merge" } });
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "mergeSession" });
    expect(session.unresolved).toBe(1);
    expect(session.generation).toBe(repository.generation + 1);

    port.call
      .mockResolvedValueOnce({ repo: "repo-a", merge: { generation: 14, operation: "merge", canContinue: false, canAbort: false, source: "feature", target: "main", headOid: "d".repeat(40), conflicts: [], unresolved: 0, note: "", snapshot: {} } })
      .mockResolvedValueOnce(completed(snapshot({ generation: "g3", head: "d".repeat(40) })))
      .mockResolvedValueOnce({
        repo: "repo-a",
        commit: {
          generation: 14,
          commit: { oid: "d".repeat(40), parents: ["c".repeat(40)], summary: "合并分支 feature", authorName: "dev", authorEmail: "d@e", authoredAt: 1, labels: [] },
          body: "",
          root: false,
          merge: true,
          selectedParent: "c".repeat(40),
          files: [{ path: "a.txt", originalPath: null, status: "M" }],
        },
      });

    const done = await api.completeMerge(keyA, "合并分支 feature", session.generation, 37, "merge");
    expect(port.call.mock.calls[3][0]).toMatchObject({ op: "mergeComplete", fields: { message: "合并分支 feature" } });
    expect(done).toMatchObject({ operation: "merge", oid: "d".repeat(40), summary: "合并分支 feature", files: ["a.txt"] });
  });

  it("撤销合并的预览不发送写入，取消后远端一次写都没有收到", async () => {
    const repository = await openHost();
    port.call.mockResolvedValueOnce({
      repo: "repo-a",
      merge: { generation: 13, operation: "merge", canContinue: true, canAbort: true, source: "feature", target: "main", headOid: "c".repeat(40), conflicts: [{ path: "a.txt", kind: "content", summary: "" }], unresolved: 1, note: "", snapshot: {} },
    });

    const preview = await api.abortMerge(keyA, false, repository.generation, 38);
    expect(preview.wrote).toBe(false);
    expect(preview.paths).toEqual(["a.txt"]);
    expect(port.call.mock.calls.map((call) => call[0].op)).toEqual(["mergeSession"]);
  });

  it("未接通的白名单外方法仍返回 remote_unsupported，且不发任何远端请求", async () => {
    const repository = await openHost();
    await expect(api.discardChanges(keyA, ["small.txt"], true, repository.generation, 39)).rejects.toMatchObject({
      code: "remote_unsupported",
    });
    await expect(api.renameBranch(keyA, "a", "b", repository.generation + 99, 40)).rejects.toMatchObject({ code: "stale" });
    expect(port.call).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(port.write).not.toHaveBeenCalled();
  });

  it("待确认写入期间第二次写入不再发送，重试只核对不重发", async () => {
    const repository = await openHost();
    port.call.mockResolvedValueOnce({ state: "unknown", operationId: "op-9", message: "远端没有回执" });
    await expect(api.fetchRemote(keyA, repository.generation, 41)).rejects.toMatchObject({ code: "write_pending" });
    expect(port.call).toHaveBeenCalledTimes(1);

    await expect(api.fetchRemote(keyA, repository.generation, 42)).rejects.toMatchObject({ code: "write_pending" });
    expect(port.call).toHaveBeenCalledTimes(1);
    expect(port.write).not.toHaveBeenCalled();
  });

  it("命令面板的远端黑名单与桥接实际接通范围一致", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    const start = source.indexOf("const REMOTE_BLOCKED_COMMANDS = new Set([");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("]);", start);
    const blocked = new Set([...source.slice(start, end).matchAll(/"([a-z]+\.?[a-zA-Z.]+)"/g)].map((match) => match[1]));

    // 已接通：历史、分支标签、同步、stash、合并与提交范围内核对，不再被挡住。
    for (const id of [
      "view.history",
      "task.stash",
      "task.merge",
      "task.abortMerge",
      "task.branch",
      "task.remote",
      "sync.fetch",
      "sync.pull",
      "sync.push",
      "branch.switch",
      "branch.create",
    ]) {
      expect(blocked.has(id), id + " 已接通却被挡住").toBe(false);
    }
    // 仍然依赖本机能力或缺少桥接 op 的入口继续挡住。
    for (const id of ["view.files", "files.search", "task.scope", "sync.upstream", "commit.push", "terminal.new"]) {
      expect(blocked.has(id), id + " 没有接通却放开了").toBe(true);
    }
  });

  it("远端 diff 的 hunksStageable 传到解析器：块级按钮只按远端标记亮起", async () => {
    const repository = await openHost();
    const patch = [
      "diff --git a/small.txt b/small.txt",
      "--- a/small.txt",
      "+++ b/small.txt",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+one!",
      "",
    ].join("\n");

    port.diff.mockResolvedValueOnce({ ...diffPage(patch), hunksStageable: true });
    const capable = await api.loadDiff(keyA, "small.txt", false, repository.generation, 43);
    expect(capable.hunks[0].stageable).toBe(true);

    port.diff.mockResolvedValueOnce({ ...diffPage(patch), hunksStageable: false, hunksStageableReason: "只支持整文件暂存" });
    const plain = await api.loadDiff(keyA, "small.txt", true, repository.generation, 44);
    expect(plain.hunks[0].stageable).toBe(false);
  });
});

describe("远端审查：阶段声明与重复点击", () => {
  it("返回结果按会话里真正做成的阶段声明，重复阶段按幂等刷新处理", async () => {
    port.open.mockResolvedValueOnce(opened("session-review"));
    await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-1" },
    );

    const sent = await api.remoteReturnReview(keyA);
    // reviewed 是端口与后端的缺省阶段：这里不带 outcome，旧调用方的协议保持不动。
    expect(review.returnReview).toHaveBeenLastCalledWith("review-1", "session-review");
    expect(sent).toMatchObject({ state: "sent", outcome: "reviewed" });
    expect(review.returnReview.mock.calls.at(-1)).toHaveLength(2);

    // 同一阶段再点一次：后端按严格递增拒绝，这里映射成「已经送回」，不抛给用户。
    review.returnReview.mockRejectedValueOnce({ code: "conflict", message: "阶段必须严格递增" });
    const again = await api.remoteReturnReview(keyA);
    expect(again.state).toBe("duplicate");
    expect(again.state === "duplicate" ? again.message : "").toContain("没有重复发送");
  });

  it("远端提交成功后返回的是 committed，不是 reviewed", async () => {
    port.open.mockResolvedValueOnce(opened("session-review"));
    const target = await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-2" },
    );
    expect(target.kind).toBe("opened");
    if (target.kind !== "opened") return;
    port.write.mockResolvedValueOnce({
      state: "completed",
      operationId: "op-commit",
      snapshot: snapshot({ generation: "g2", files: [], head: "e".repeat(40) }),
    });
    await api.commitChanges(keyA, "远端提交", target.repository.generation, 45);

    const sent = await api.remoteReturnReview(keyA);
    expect(review.returnReview).toHaveBeenLastCalledWith("review-2", "session-review", "committed");
    expect(sent).toMatchObject({ state: "sent", outcome: "committed" });
  });
});
