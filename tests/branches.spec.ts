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

function completed(snap: unknown, result: Record<string, unknown> = {}) {
  return {
    state: "completed",
    operationId: "op-1",
    snapshot: snap,
    head: (snap as { head?: string }).head ?? null,
    ...result,
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

  it("临时保存：从已核对回执读取标识和具体结果", async () => {
    const repository = await openHost();
    const oid = "b".repeat(40);
    const after = snapshot({ generation: "g2", files: [] });
    port.call.mockResolvedValueOnce(completed(after, {
      stash: {
        oid,
        note: "已保存",
        state: {
          generation: 13,
          preview: { trackedCount: 0, untrackedCount: 0, ignoredCount: 0, trackedPaths: [], untrackedPaths: [], ignoredPaths: [], includeUntracked: true, canSave: false, summary: "" },
          records: [{ oid, message: "远端临时保存", committedAt: 1 }],
          snapshot: {},
        },
      },
    }));

    const result = await api.saveStash(keyA, true, "远端临时保存", repository.generation, 35);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "stashSave", fields: { includeUntracked: true, message: "远端临时保存" } });
    expect(port.call).toHaveBeenCalledTimes(1);
    expect(result.oid).toBe(oid);
    expect(result.state.records).toHaveLength(1);
    expect(result.state.snapshot.files).toEqual([]);
  });

  it("开始与完成合并使用远端回执携带的会话和提交结果", async () => {
    const repository = await openHost();
    const merged = snapshot({ generation: "g2", head: "c".repeat(40) });
    port.call.mockResolvedValueOnce(completed(merged, {
      merge: {
        generation: 13, operation: "rebase", canContinue: true, canAbort: true, source: "feature",
        target: "main", headOid: "c".repeat(40), conflicts: [{ path: "a.txt", kind: "content", summary: "" }],
        unresolved: 1, note: "", snapshot: {},
      },
    }));

    const session = await api.startMerge(keyA, "feature", null, "rebase", repository.generation, 36);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "mergeStart", fields: { source: "feature", target: null, mode: "rebase" } });
    expect(session.unresolved).toBe(1);
    expect(session.generation).toBe(repository.generation + 1);

    const oid = "d".repeat(40);
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g3", head: oid }), {
      merge: { generation: 14, operation: "rebase", oid, summary: "变基完成", files: ["a.txt"], snapshot: {} },
    }));
    const done = await api.completeMerge(keyA, "变基完成", session.generation, 37, "rebase");
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "mergeComplete", fields: { message: "变基完成" } });
    expect(port.call).toHaveBeenCalledTimes(2);
    expect(done).toMatchObject({ operation: "rebase", oid, summary: "变基完成", files: ["a.txt"] });
  });

  it("撤销合并的预览从远端读取影响，无确认时没有写入", async () => {
    const repository = await openHost();
    port.call.mockResolvedValueOnce({
      repo: "repo-a",
      merge: { generation: 13, wrote: false, paths: ["a.txt"], stashOids: [], note: "", snapshot: {} },
    });

    const preview = await api.abortMerge(keyA, false, repository.generation, 38);
    expect(preview.wrote).toBe(false);
    expect(preview.paths).toEqual(["a.txt"]);
    expect(port.call).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-a", op: "mergeAbortPreview", fields: {} });
  });

  it("拒绝绕过远端工作区预览的删除与迟到代次的写入", async () => {
    const repository = await openHost();
    const removeFailure = await api.removeWorktree(keyA, false, 39).then(
      () => null,
      (thrown: { code?: string; message?: string }) => thrown,
    );
    expect(removeFailure?.code).toBe("remote_unsupported");
    expect(removeFailure?.message).toContain("所属 SSH 仓库核对这棵工作区的删除预览");
    await expect(api.renameBranch(keyA, "a", "b", repository.generation + 99, 40)).rejects.toMatchObject({ code: "stale" });
    expect(port.call).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(port.write).not.toHaveBeenCalled();
  });

  it("放弃改动：远端只读预览，确认后只发送一次写入并返回路径处理结果", async () => {
    const repository = await openHost();
    const files = [{
      path: "small.txt", originalPath: null, staged: "none", unstaged: "modified",
      untracked: false, impact: "恢复到索引", recovery: "工作区改动将丢失",
    }];
    const result = { generation: 13, wrote: false, files, boundary: "仅影响所选文件", snapshot: repository.snapshot };
    port.call.mockResolvedValueOnce({ repo: "repo-a", discard: result });
    const preview = await api.discardChanges(keyA, ["small.txt"], false, repository.generation, 39);
    expect(preview.wrote).toBe(false);
    expect(preview.files.map((file) => file.path)).toEqual(["small.txt"]);
    expect(preview.snapshot.files.map((file) => file.path)).toContain("small.txt");
    expect(port.call).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-a", op: "discardPreview", fields: { paths: ["small.txt"] } });

    const after = snapshot({ generation: "g2", files: [{ path: "staged.txt", xy: "M " }] });
    port.call.mockResolvedValueOnce(completed(after, { discard: { ...result, wrote: true } }));
    const done = await api.discardChanges(keyA, ["small.txt"], true, repository.generation, 40);
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "discard", fields: { paths: ["small.txt"], confirm: true } });
    expect(port.call).toHaveBeenCalledTimes(2);
    expect(done.wrote).toBe(true);
    expect(done.files.map((file) => file.path)).toEqual(["small.txt"]);
    expect(done.snapshot.files.map((file) => file.path)).toEqual(["staged.txt"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("拣选提交从远端已核对回执取得新 HEAD 和实际创建数", async () => {
    const repository = await openHost();
    const headOid = "b".repeat(40);
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2", head: headOid, files: [] }), {
      cherryPick: { generation: 13, created: 1, headOid, conflicted: false, skipped: [], note: "已拣选", snapshot: {} },
    }));

    const result = await api.cherryPickCommits(keyA, ["a".repeat(40)], repository.generation, 41);
    expect(port.call.mock.calls[0][0]).toMatchObject({ op: "cherryPick", fields: { oids: ["a".repeat(40)] } });
    expect(port.call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ headOid, conflicted: false, created: 1, skipped: [], note: "已拣选" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("还原提交：预览与确认使用不同的远端操作并返回目标与实际创建数", async () => {
    const repository = await openHost();
    const oid = "c".repeat(40);
    const head = "a".repeat(40);
    const targets = [{ oid, summary: "远端提交", authorName: "dev", authoredAt: 7 }];
    const result = {
      generation: 13, code: "ok", wrote: false, eligible: true, headOid: head, targets,
      created: 0, conflicted: false, note: "", snapshot: repository.snapshot,
    };
    port.call.mockResolvedValueOnce({ repo: "repo-a", revert: result });
    const preview = await api.revertCommits(keyA, [oid], head, false, repository.generation, 42);
    expect(preview).toMatchObject({ wrote: false, eligible: true, targets });
    expect(port.call).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-a", op: "revertPreview", fields: { oids: [oid], expectedHead: head, confirm: false },
    });

    const nextHead = "d".repeat(40);
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2", head: nextHead }), {
      revert: { ...result, wrote: true, headOid: nextHead, created: 1 },
    }));
    const done = await api.revertCommits(keyA, [oid], head, true, repository.generation, 43);
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "revert", fields: { oids: [oid], expectedHead: head, confirm: true } });
    expect(port.call).toHaveBeenCalledTimes(2);
    expect(done).toMatchObject({ wrote: true, headOid: nextHead, created: 1, targets });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("撤销最近提交：使用已核实的 HEAD 预览，经确认后发送一次写入", async () => {
    const repository = await openHost();
    const head = "a".repeat(40);
    const parentOid = "b".repeat(40);
    const result = {
      generation: 13, code: "ok", wrote: false, eligible: true, headOid: head,
      parentOid, summary: "要撤销的提交", reason: "", snapshot: repository.snapshot,
    };
    port.call.mockResolvedValueOnce({ repo: "repo-a", undo: result });
    const preview = await api.undoCommit(keyA, head, false, repository.generation, 44);
    expect(preview).toMatchObject({ wrote: false, eligible: true, summary: "要撤销的提交" });
    expect(port.call).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-a", op: "undoCommitPreview", fields: { expectedHead: head, confirm: false },
    });

    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2", head: parentOid }), {
      undo: { ...result, wrote: true, headOid: parentOid },
    }));
    const done = await api.undoCommit(keyA, head, true, repository.generation, 45);
    expect(port.call.mock.calls[1][0]).toMatchObject({ op: "undoCommit", fields: { expectedHead: head, confirm: true } });
    expect(done).toMatchObject({ wrote: true, headOid: parentOid, parentOid });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("修订最近提交：把远端预览的暂存令牌和原 HEAD 带回确认", async () => {
    const repository = await openHost();
    const head = "a".repeat(40);
    const stagedToken = "7".repeat(64);
    const result = {
      generation: 13, code: "ok", wrote: false, eligible: true, headOid: head,
      parentOid: "b".repeat(40), summary: "原说明", message: "原说明\n\n正文",
      files: [{ path: "a.txt", originalPath: null, status: "M" }],
      stagedPaths: ["staged.txt"], stagedToken, note: "", snapshot: repository.snapshot,
    };
    port.call.mockResolvedValueOnce({ repo: "repo-a", amend: result });
    const preview = await api.amendCommit(keyA, head, null, true, null, false, repository.generation, 46);
    expect(port.call).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-a", op: "amendCommitPreview",
      fields: { expectedHead: head, message: null, includeStaged: true, stagedToken: null, confirm: false },
    });
    expect(preview).toMatchObject({ wrote: false, eligible: true, stagedToken, message: result.message });

    const nextHead = "f".repeat(40);
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2", head: nextHead }), {
      amend: { ...result, wrote: true, headOid: nextHead, summary: "新说明", message: "新说明" },
    }));
    const done = await api.amendCommit(keyA, head, "新说明", true, preview.stagedToken, true, repository.generation, 47);
    expect(port.call.mock.calls[1][0]).toMatchObject({
      op: "amendCommit",
      fields: { expectedHead: head, message: "新说明", includeStaged: true, stagedToken, confirm: true },
    });
    expect(done).toMatchObject({ wrote: true, headOid: nextHead, summary: "新说明" });
    expect(port.call).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
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

  it("远端已接通的提交范围、发布、上游和提交并推送不再受旧命令拦截", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    expect(source).not.toContain("REMOTE_BLOCKED_COMMANDS");
    for (const id of ["task.scope", "task.publish", "sync.upstream", "commit.push"]) {
      expect(source).toContain('case "' + id + '"');
    }
  });

  it("远端差异只有带真实快照和块证明才能进入局部暂存", async () => {
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
    const legacy = await api.loadDiff(keyA, "small.txt", false, repository.generation, 43);
    expect(legacy.hunks.map((hunk) => hunk.stageable)).toEqual([false]);
    expect(legacy.hunksStageableReason).toContain("没有为这份差异提供可核对的局部暂存快照");

    port.diff.mockResolvedValueOnce({ ...diffPage(patch), hunksStageable: false, hunksStageableReason: "任务差异是只读视图，不能暂存。" });
    const plain = await api.loadDiff(keyA, "small.txt", true, repository.generation, 44);
    expect(plain.hunks[0].stageable).toBe(false);
    expect(plain.hunksStageableReason).toBe("任务差异是只读视图，不能暂存。");

    const token = "6".repeat(64);
    port.diff.mockResolvedValueOnce({
      ...diffPage(patch.replaceAll("small.txt", "current.txt")), hunksStageable: true,
      snapshot: token, stageableHunks: [0],
    });
    const capable = await api.loadDiff(keyA, "current.txt", false, repository.generation, 45);
    expect(capable.hunks.map((hunk) => hunk.stageable)).toEqual([true]);
    expect(capable.snapshot).toBe(token);
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2" })));
    await api.stageHunks(keyA, "current.txt", false, [0], capable.snapshot, repository.generation, 46);
    expect(port.call.mock.calls[0][0]).toMatchObject({
      op: "patch", generation: "g1",
      fields: { path: "current.txt", staged: false, snapshot: token, hunks: [0], original: null },
    });
    expect(port.call).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
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

    // 同一阶段再点一次：这次会话自己已经送过 reviewed，后端按冲突拒绝即重复，
    // 映射成「已经送回」，不抛给用户。
    review.returnReview.mockRejectedValueOnce({ code: "conflict", message: "阶段必须严格递增" });
    const again = await api.remoteReturnReview(keyA);
    expect(again.state).toBe("duplicate");
    expect(again.state === "duplicate" ? again.message : "").toContain("没有重复发送");
  });

  it("冲突不是重复时原样暴露后端原因，不伪装成「已经送回」", async () => {
    port.open.mockResolvedValueOnce(opened("session-review"));
    await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-4" },
    );

    // 这次会话一次都没有成功送回：冲突不可能是重复，只能是阶段回退或缺少记录提交。
    review.returnReview.mockRejectedValueOnce({
      code: "conflict",
      message: "审查结果的阶段必须严格递增（reviewed → committed → merged），本次没有返回给 Cliora。",
    });
    const rejected = api.remoteReturnReview(keyA);
    await expect(rejected).rejects.toMatchObject({ code: "conflict" });
    await expect(rejected).rejects.toThrow(/本次没有返回给 Cliora/);
  });

  it("远端合入没有登记提交：只按 reviewed 送回，并提示无法作为 merged", async () => {
    port.open.mockResolvedValueOnce(opened("session-review"));
    const target = await openRemoteRepository(
      { kind: "ssh", hostId: hostA.targetId, hostRevision: hostA.targetRevision, path: "/srv/repo" },
      { reviewId: "review-3" },
    );
    expect(target.kind).toBe("opened");
    if (target.kind !== "opened") return;

    const oid = "f".repeat(40);
    port.call.mockResolvedValueOnce(completed(snapshot({ generation: "g2", head: oid }), {
      merge: { generation: 13, operation: "merge", oid, summary: "合并分支 feature", files: ["a.txt"], snapshot: {} },
    }));

    const done = await api.completeMerge(keyA, "合并分支 feature", target.repository.generation, 46, "merge");
    expect(done.operation).toBe("merge");
    // 只有远端审查账本确认了阶段，界面才能声明已合入。
    expect(port.call.mock.calls.map((call) => call[0].op)).toEqual(["mergeComplete"]);

    const sent = await api.remoteReturnReview(keyA);
    expect(review.returnReview).toHaveBeenLastCalledWith("review-3", "session-review");
    expect(sent).toMatchObject({ state: "sent", outcome: "reviewed" });
    expect(sent.state === "sent" ? sent.message : "").toContain("远端合入未记录提交，无法作为 merged 送回 Cliora");
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
