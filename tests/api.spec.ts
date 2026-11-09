import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 返回类型放宽成 unknown：新增的 cliora 用例会按真实命令的返回值准备一次性响应。
const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => ({ ok: true })),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
}));

import { api } from "../src/lib/api";
import { beginClioraReview, clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";

describe("Tauri 命令参数", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it("worktree 总览只传最近路径与请求号，不触发任何写入或 fetch", async () => {
    const paths = ["C:/work/app", "C:/work/app-feature"];
    await api.worktreeOverview(paths, 77);
    expect(invoke).toHaveBeenLastCalledWith("worktree_overview", { paths, requestId: 77 });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("文档读取保留来源快照、分页版本与逐请求资源取消", async () => {
    const source = { revision: "index", path: "docs/中文 guide.md", snapshot: "a".repeat(64) };
    await api.repositoryDocument("/repo", source, 8, 501);
    expect(invoke).toHaveBeenLastCalledWith("repository_document", {
      path: "/repo", source, generation: 8, requestId: 501,
      mode: "document", offset: 0, limit: undefined, expectedVersion: null,
    });
    await api.repositoryDocument("/repo", source, 8, 502, "source", 400, 100, "blob-version");
    expect(invoke).toHaveBeenLastCalledWith("repository_document", {
      path: "/repo", source, generation: 8, requestId: 502,
      mode: "source", offset: 400, limit: 100, expectedVersion: "blob-version",
    });
    await api.documentResource("/repo", source, 8, 503);
    expect(invoke).toHaveBeenLastCalledWith("document_resource", { path: "/repo", source, generation: 8, requestId: 503 });
    await api.openDocumentUrl("https://example.com/doc#标题");
    expect(invoke).toHaveBeenLastCalledWith("open_document_url", { url: "https://example.com/doc#标题" });
    await api.documentRemoteImage("https://example.com/image.png", 504);
    expect(invoke).toHaveBeenLastCalledWith("document_remote_image", { url: "https://example.com/image.png", requestId: 504 });
    await api.cancelDocumentResources(504);
    expect(invoke).toHaveBeenLastCalledWith("cancel_document_resources", { requestId: 504 });
  });

  it("文档来源绑定仓库根，越仓来源必须报错而不是静默改读", async () => {
    const source = { revision: "index", path: "docs/a.md", snapshot: "a".repeat(64), repository: "C:/repo/one" };
    await api.repositoryDocument("C:/repo/one", source, 3, 601);
    expect(invoke).toHaveBeenLastCalledWith("repository_document", {
      path: "C:/repo/one", source, generation: 3, requestId: 601,
      mode: "document", offset: 0, limit: undefined, expectedVersion: null,
    });
    // 切仓后旧来源 + 新仓库根：后端返回 document_repository，前端不得吞掉错误再读别处。
    invoke.mockRejectedValueOnce({
      code: "document_repository",
      message: "该文档来源属于另一个仓库，未读取当前仓库中的同名文件。",
    });
    await expect(api.repositoryDocument("C:/repo/two", source, 3, 602)).rejects.toMatchObject({
      code: "document_repository",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    // 后端会把仓库根写回来源；后续分页与资源读取原样复用该来源时参数不变。
    const rebound = { ...source, repository: "C:/repo/two" };
    await api.repositoryDocument("C:/repo/two", rebound, 3, 603, "source", 20, 5, "blob-tip");
    expect(invoke).toHaveBeenLastCalledWith("repository_document", {
      path: "C:/repo/two", source: rebound, generation: 3, requestId: 603,
      mode: "source", offset: 20, limit: 5, expectedVersion: "blob-tip",
    });
    await api.documentResource("C:/repo/two", rebound, 3, 604);
    expect(invoke).toHaveBeenLastCalledWith("document_resource", {
      path: "C:/repo/two", source: rebound, generation: 3, requestId: 604,
    });
  });

  it("仓库操作使用 requestId，匹配 command 的 camelCase", async () => {
    await api.addRepository("/repo", 4);
    await api.createRepository("/repo", 5);
    await api.openRepository("/repo", 6);
    await api.refreshStatus("/repo", 8, 7);
    await api.loadDiff("/repo", "a b.txt", false, 8, 9);
    await api.cloneRepository("https://example.com/app.git", "/parent", "app", 10);
    await api.fetchRemote("/repo", 8, 11);
    await api.commitAndPush("/repo", "note", 8, 12);
    await api.deleteBranch("/repo", "topic", false, 8, 13);

    expect(invoke).toHaveBeenNthCalledWith(1, "add_repository", { path: "/repo", requestId: 4 });
    expect(invoke).toHaveBeenNthCalledWith(2, "create_repository", { path: "/repo", requestId: 5 });
    expect(invoke).toHaveBeenNthCalledWith(3, "open_repository", { path: "/repo", requestId: 6 });
    expect(invoke).toHaveBeenNthCalledWith(4, "refresh_status", {
      path: "/repo",
      generation: 8,
      requestId: 7,
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "load_diff", {
      path: "/repo",
      relative: "a b.txt",
      original: null,
      staged: false,
      generation: 8,
      requestId: 9,
      offset: 0,
      limit: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(6, "clone_repository", {
      url: "https://example.com/app.git",
      parent: "/parent",
      name: "app",
      credential: null,
      requestId: 10,
    });
    expect(invoke).toHaveBeenNthCalledWith(7, "fetch_remote", {
      path: "/repo",
      generation: 8,
      requestId: 11,
    });
    expect(invoke).toHaveBeenNthCalledWith(8, "commit_and_push", {
      path: "/repo",
      message: "note",
      generation: 8,
      requestId: 12,
    });
    expect(invoke).toHaveBeenNthCalledWith(9, "delete_branch", {
      path: "/repo",
      name: "topic",
      confirmUnmerged: false,
      generation: 8,
      requestId: 13,
    });
    for (const call of invoke.mock.calls) {
      expect(call[1]).not.toHaveProperty("request_id");
    }
  });

  it("右键菜单与分支管理新增的命令按 camelCase 传参，Rust 侧参数名一致", async () => {
    await api.loadDiff("/repo", "a.ts", true, 8, 40, null, 0, 0, 1_000_000);
    await api.createBranchFrom("/repo", "hotfix", "main", true, 8, 41);
    await api.renameBranch("/repo", "old", "new", 8, 42);
    await api.revealPath("/repo", "src/a.ts");
    await api.openPath("/repo", "src/a.ts");
    await api.ignorePath("/repo", "*.log", false, 8, 43);

    expect(invoke).toHaveBeenNthCalledWith(1, "load_diff", {
      path: "/repo",
      relative: "a.ts",
      original: null,
      staged: true,
      generation: 8,
      requestId: 40,
      offset: 0,
      limit: 0,
      context: 1_000_000,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "create_branch_from", {
      path: "/repo",
      name: "hotfix",
      start: "main",
      checkout: true,
      generation: 8,
      requestId: 41,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rename_branch", { path: "/repo", old: "old", new: "new", generation: 8, requestId: 42 });
    expect(invoke).toHaveBeenNthCalledWith(4, "reveal_path", { path: "/repo", relative: "src/a.ts" });
    expect(invoke).toHaveBeenNthCalledWith(5, "open_path", { path: "/repo", relative: "src/a.ts" });
    expect(invoke).toHaveBeenNthCalledWith(6, "ignore_path", {
      path: "/repo",
      pattern: "*.log",
      local: false,
      generation: 8,
      requestId: 43,
    });
  });

  it("目录与文本页命令按 camelCase 传参，和 Rust 侧参数名一致", async () => {
    await api.repositoryDirectory("/repo", "src/lib", true, 8, 60);
    await api.repositoryFileContent("/repo", "src/main.ts", 500, 200, 8, 61);

    expect(invoke).toHaveBeenNthCalledWith(1, "repository_directory", {
      path: "/repo",
      relative: "src/lib",
      includeIgnored: true,
      generation: 8,
      requestId: 60,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "repository_file_content", {
      path: "/repo",
      relative: "src/main.ts",
      offset: 500,
      limit: 200,
      generation: 8,
      requestId: 61,
    });
  });

  it("路径与内容搜索命令按 camelCase 传参，scope 用 kind 判别", async () => {
    await api.repositoryPathSearch("/repo", "main", "src", true, 50, 8, 70);
    await api.repositoryContentSearch(
      "/repo",
      "needle",
      { kind: "directory", path: "src/lib" },
      false,
      undefined,
      8,
      71,
    );
    await api.repositoryContentSearch("/repo", "needle", { kind: "changed" }, false, 20, 8, 72);

    expect(invoke).toHaveBeenNthCalledWith(1, "repository_path_search", {
      path: "/repo",
      query: "main",
      directory: "src",
      includeIgnored: true,
      limit: 50,
      generation: 8,
      requestId: 70,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "repository_content_search", {
      path: "/repo",
      query: "needle",
      scope: { kind: "directory", path: "src/lib" },
      includeIgnored: false,
      limit: undefined,
      generation: 8,
      requestId: 71,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "repository_content_search", {
      path: "/repo",
      query: "needle",
      scope: { kind: "changed" },
      includeIgnored: false,
      limit: 20,
      generation: 8,
      requestId: 72,
    });
  });

  it("远程标签查询不带 generation：它不受本地状态校验", async () => {
    await api.tagRemoteState("/repo", "origin");
    expect(invoke).toHaveBeenCalledWith("tag_remote_state", { path: "/repo", remote: "origin" });
  });

  it("历史和临时保存使用 requestId", async () => {
    await api.historyPage("/repo", "needle", 100, 8, 20);
    await api.commitDetail("/repo", "abc123", null, 8, 21);
    await api.commitFileDiff("/repo", "abc123", "def456", "old/name.txt", 8, 22, 0, 0);
    await api.fileHistory("/repo", "old/name.txt", 0, 8, 23);
    await api.stashState("/repo", false, 8, 24);
    await api.saveStash("/repo", true, "wip", 8, 25);
    await api.applyStash("/repo", "abc123", 8, 26);
    await api.deleteStash("/repo", "abc123", true, 8, 27);
    await api.mergePreview("/repo", "feature", "main", 8, 28);
    await api.startMerge("/repo", "feature", "main", "ff-only", 8, 29);
    await api.mergeSession("/repo", 8, 30);
    await api.conflictView("/repo", "my file.txt", 8, 31);
    await api.resolveConflict("/repo", "my file.txt", "text", "final\n", 8, 32);
    await api.completeMerge("/repo", "合并", 8, 33);
    await api.abortMerge("/repo", false, 8, 34);
    await api.undoCommit("/repo", "abc123", false, 8, 35);
    await api.discardChanges("/repo", ["my file.txt"], false, 8, 36);

    expect(invoke).toHaveBeenNthCalledWith(1, "history_page", {
      path: "/repo",
      query: "needle",
      offset: 100,
      generation: 8,
      requestId: 20,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "commit_detail", {
      path: "/repo",
      oid: "abc123",
      parent: null,
      generation: 8,
      requestId: 21,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "commit_file_diff", {
      path: "/repo",
      oid: "abc123",
      parent: "def456",
      relative: "old/name.txt",
      generation: 8,
      requestId: 22,
      offset: 0,
      limit: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "file_history", {
      path: "/repo",
      relative: "old/name.txt",
      offset: 0,
      generation: 8,
      requestId: 23,
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "stash_state", {
      path: "/repo",
      includeUntracked: false,
      generation: 8,
      requestId: 24,
    });
    expect(invoke).toHaveBeenNthCalledWith(6, "save_stash", {
      path: "/repo",
      includeUntracked: true,
      message: "wip",
      generation: 8,
      requestId: 25,
    });
    expect(invoke).toHaveBeenNthCalledWith(7, "apply_stash", {
      path: "/repo",
      oid: "abc123",
      generation: 8,
      requestId: 26,
    });
    expect(invoke).toHaveBeenNthCalledWith(8, "delete_stash", {
      path: "/repo",
      oid: "abc123",
      confirm: true,
      generation: 8,
      requestId: 27,
    });
    expect(invoke).toHaveBeenNthCalledWith(9, "merge_preview", {
      path: "/repo",
      source: "feature",
      target: "main",
      generation: 8,
      requestId: 28,
    });
    expect(invoke).toHaveBeenNthCalledWith(10, "start_merge", {
      path: "/repo",
      source: "feature",
      target: "main",
      mode: "ff-only",
      generation: 8,
      requestId: 29,
    });
    expect(invoke).toHaveBeenNthCalledWith(11, "merge_session", {
      path: "/repo",
      generation: 8,
      requestId: 30,
    });
    expect(invoke).toHaveBeenNthCalledWith(12, "conflict_view", {
      path: "/repo",
      relative: "my file.txt",
      generation: 8,
      requestId: 31,
    });
    expect(invoke).toHaveBeenNthCalledWith(13, "resolve_conflict", {
      path: "/repo",
      relative: "my file.txt",
      choice: "text",
      content: "final\n",
      generation: 8,
      requestId: 32,
    });
    expect(invoke).toHaveBeenNthCalledWith(14, "complete_merge", {
      path: "/repo",
      message: "合并",
      generation: 8,
      requestId: 33,
    });
    expect(invoke).toHaveBeenNthCalledWith(15, "abort_merge", {
      path: "/repo",
      confirm: false,
      generation: 8,
      requestId: 34,
    });
    expect(invoke).toHaveBeenNthCalledWith(16, "undo_commit", {
      path: "/repo",
      expectedHead: "abc123",
      confirm: false,
      generation: 8,
      requestId: 35,
    });
    expect(invoke).toHaveBeenNthCalledWith(17, "discard_changes", {
      path: "/repo",
      paths: ["my file.txt"],
      confirm: false,
      generation: 8,
      requestId: 36,
    });
    for (const call of invoke.mock.calls) {
      expect(call[1]).not.toHaveProperty("request_id");
    }
  });

  it("历史筛选、拣选和检出使用 camelCase，空筛选不额外传字段", async () => {
    await api.historyPage("/repo", "needle", 0, 8, 50, {
      scope: "all",
      author: "Ada",
      since: 10,
      until: 20,
      path: "docs",
    });
    await api.fileHistory("/repo", "docs/a.txt", 0, 8, 51, { author: "Ada", query: "fix" });
    await api.cherryPickCommits("/repo", ["aaa", "bbb"], 8, 52);
    await api.checkoutCommit("/repo", "abc", 8, 53);
    expect(invoke).toHaveBeenNthCalledWith(1, "history_page", {
      path: "/repo",
      query: "needle",
      offset: 0,
      generation: 8,
      requestId: 50,
      scope: "all",
      author: "Ada",
      since: 10,
      until: 20,
      pathFilter: "docs",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "file_history", {
      path: "/repo",
      relative: "docs/a.txt",
      offset: 0,
      generation: 8,
      requestId: 51,
      author: "Ada",
      query: "fix",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "cherry_pick_commits", {
      path: "/repo",
      oids: ["aaa", "bbb"],
      generation: 8,
      requestId: 52,
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "checkout_commit", {
      path: "/repo",
      oid: "abc",
      generation: 8,
      requestId: 53,
    });
  });
});
describe("任务审阅命令", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it("任务读取、单文件净差异与快照 token 都按 camelCase 传参", async () => {
    const baseline = "a".repeat(40);
    const head = "b".repeat(40);
    await api.taskReview("/repo", baseline, 8, 80);
    await api.loadTaskDiff("/repo", baseline, head, "src/a.ts", 8, 81);
    await api.loadTaskDiff("/repo", baseline, head, "new name.ts", 8, 82, null, 400, 200, 1_000_000, true);
    await api.taskReviewToken("/repo", baseline, head, "src/a.ts", 8, 83);

    expect(invoke).toHaveBeenNthCalledWith(1, "task_review", {
      path: "/repo",
      baseline,
      generation: 8,
      requestId: 80,
    });
    // 单文件读取必须带完整起点与 HEAD：旧响应无法贴到新范围上。
    expect(invoke).toHaveBeenNthCalledWith(2, "load_task_diff", {
      path: "/repo",
      baseline,
      head,
      relative: "src/a.ts",
      original: null,
      generation: 8,
      requestId: 81,
      offset: 0,
      limit: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "load_task_diff", {
      path: "/repo",
      baseline,
      head,
      relative: "new name.ts",
      original: null,
      generation: 8,
      requestId: 82,
      offset: 400,
      limit: 200,
      context: 1_000_000,
      asText: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "task_review_token", {
      path: "/repo",
      baseline,
      head,
      relative: "src/a.ts",
      generation: 8,
      requestId: 83,
    });
    for (const call of invoke.mock.calls) expect(call[1]).not.toHaveProperty("request_id");
  });

  it("读取失败与空任务分开：错误原样抛出，空任务只来自完整成功响应", async () => {
    invoke.mockRejectedValueOnce({ code: "task_baseline_not_ancestor", message: "起点不是祖先。" });
    await expect(api.taskReview("/repo", "deadbeef", 8, 90)).rejects.toMatchObject({
      code: "task_baseline_not_ancestor",
    });
    invoke.mockResolvedValueOnce({
      generation: 9,
      worktree: "/repo",
      baselineRef: "main~2",
      baselineOid: "a".repeat(40),
      headOid: "b".repeat(40),
      branch: { name: "main", detached: false },
      commits: [],
      commitCount: 0,
      commitsTruncated: false,
      files: [],
      filesTotal: 0,
      filesTruncated: false,
      additions: 0,
      deletions: 0,
      dirty: false,
      untrackedFiles: 0,
      conflicted: false,
      empty: true,
      rangeVersion: "v",
      message: "读取成功：起点之后没有提交，也没有未提交改动。",
    });
    const task = await api.taskReview("/repo", "main~2", 9, 91);
    expect(task.empty).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("task_review", {
      path: "/repo",
      baseline: "main~2",
      generation: 9,
      requestId: 91,
    });
  });
});

describe("逐行暂存命令", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it("行身份与参数都用 camelCase，和 Rust 侧 stage_lines 一致", async () => {
    const lines = [
      { hunkIndex: 0, kind: "add" as const, oldNo: null, newNo: 3 },
      { hunkIndex: 1, kind: "del" as const, oldNo: 9, newNo: null },
    ];
    await api.stageLines("/repo", "src/a.ts", false, lines, "snap", 8, 50, "old a.ts");
    expect(invoke).toHaveBeenCalledWith("stage_lines", {
      path: "/repo",
      relative: "src/a.ts",
      original: "old a.ts",
      staged: false,
      lines,
      snapshot: "snap",
      generation: 8,
      requestId: 50,
    });
    await api.stageLines("/repo", "src/a.ts", true, lines, "snap", 8, 51);
    expect(invoke).toHaveBeenLastCalledWith("stage_lines", {
      path: "/repo",
      relative: "src/a.ts",
      original: null,
      staged: true,
      lines,
      snapshot: "snap",
      generation: 8,
      requestId: 51,
    });
    for (const call of invoke.mock.calls) expect(call[1]).not.toHaveProperty("request_id");
  });
});
describe("cliora 审查接线", () => {
  const REVIEW = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
  const SESSION = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
  const OID = "b".repeat(40);

  beforeEach(() => {
    invoke.mockClear();
    resetClioraReview();
    beginClioraReview({ reviewId: REVIEW, sessionId: SESSION, worktreePath: "/repo", baseline: null });
  });

  afterEach(() => resetClioraReview());

  it("链接解析、回执与返回事件按 camelCase 传参", async () => {
    await api.clioraReviewRequest("twiglane://review?v=1");
    await api.clioraReviewReceipt(REVIEW, SESSION, true);
    await api.clioraReviewReceipt(REVIEW, SESSION, false, "not_a_worktree");
    await api.clioraReviewReturn(REVIEW, SESSION, "committed", OID);

    expect(invoke).toHaveBeenNthCalledWith(1, "cliora_review_request", { url: "twiglane://review?v=1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "cliora_review_receipt", {
      reviewId: REVIEW,
      sessionId: SESSION,
      accepted: true,
      reason: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "cliora_review_receipt", {
      reviewId: REVIEW,
      sessionId: SESSION,
      accepted: false,
      reason: "not_a_worktree",
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "cliora_review_return", {
      reviewId: REVIEW,
      sessionId: SESSION,
      outcome: "committed",
      headOid: OID,
    });
    for (const call of invoke.mock.calls) {
      expect(call[1]).not.toHaveProperty("request_id");
    }
  });

  it("提交成功记录结果，失败和推送失败阶段都不声称成功", async () => {
    invoke.mockResolvedValueOnce({ oid: OID, generation: 5, branch: "main", summary: "s", files: [], pushed: false, snapshot: {} });
    await api.commitChanges("/repo", "note", 4, 1);
    expect(clioraReview.result).toMatchObject({ outcome: "committed", headOid: OID });

    resetClioraReview();
    beginClioraReview({ reviewId: REVIEW, sessionId: SESSION, worktreePath: "/repo", baseline: null });
    invoke.mockRejectedValueOnce({ code: "commit_failed", message: "提交失败。" });
    await expect(api.commitChanges("/repo", "note", 4, 2)).rejects.toMatchObject({ code: "commit_failed" });
    expect(clioraReview.result).toBeNull();

    // 推送失败：提交阶段已成功，仍然记录提交，但不额外声明推送。
    invoke.mockResolvedValueOnce({
      committed: true,
      pushed: false,
      retryPush: true,
      oid: OID,
      branch: "main",
      summary: "s",
      pushError: "网络中断",
      generation: 5,
      snapshot: {},
    });
    await api.commitAndPush("/repo", "note", 4, 3);
    expect(clioraReview.result).toMatchObject({ outcome: "committed", headOid: OID });

    // 没提交成功的报告不记录。
    resetClioraReview();
    beginClioraReview({ reviewId: REVIEW, sessionId: SESSION, worktreePath: "/repo", baseline: null });
    invoke.mockResolvedValueOnce({
      committed: false,
      pushed: false,
      retryPush: false,
      oid: "",
      branch: "main",
      summary: "s",
      pushError: "凭据无效",
      generation: 5,
      snapshot: {},
    });
    await api.commitAndPush("/repo", "note", 4, 4);
    expect(clioraReview.result).toBeNull();
  });

  it("只有快进、变基或合并提交完成才记录合入", async () => {
    const session = (extra: Record<string, unknown> = {}) => ({
      generation: 5,
      operation: "merge",
      canContinue: false,
      canAbort: true,
      source: "feature",
      target: "main",
      headOid: OID,
      conflicts: [],
      unresolved: 0,
      note: "",
      snapshot: {},
      ...extra,
    });

    invoke.mockResolvedValueOnce(session({ operation: "none", fastForwarded: true, canAbort: false }));
    await api.startMerge("/repo", "feature", null, "ff-only", 4, 1);
    expect(clioraReview.result).toMatchObject({ outcome: "merged", headOid: OID });

    resetClioraReview();
    beginClioraReview({ reviewId: REVIEW, sessionId: SESSION, worktreePath: "/repo", baseline: null });
    invoke.mockResolvedValueOnce(session({ rebased: true }));
    await api.startMerge("/repo", "feature", null, "rebase", 4, 2);
    expect(clioraReview.result).toMatchObject({ outcome: "merged", headOid: OID });

    // 停在冲突里不是合入完成。
    resetClioraReview();
    beginClioraReview({ reviewId: REVIEW, sessionId: SESSION, worktreePath: "/repo", baseline: null });
    invoke.mockResolvedValueOnce(session({ unresolved: 2 }));
    await api.startMerge("/repo", "feature", null, "merge", 4, 3);
    expect(clioraReview.result).toBeNull();

    invoke.mockResolvedValueOnce({ oid: OID, generation: 6, summary: "合并", files: [], snapshot: {} });
    await api.completeMerge("/repo", "合并", 5, 4);
    expect(clioraReview.result).toMatchObject({ outcome: "merged", headOid: OID });
  });

  it("没有 cliora 来源时独立仓库不记录任何结果", async () => {
    resetClioraReview();
    invoke.mockResolvedValue({ oid: OID, generation: 5, branch: "main", summary: "s", files: [], pushed: false, snapshot: {} });
    await api.commitChanges("/repo", "note", 4, 1);
    expect(clioraReview.result).toBeNull();
    expect(clioraReview.source).toBeNull();
  });
});