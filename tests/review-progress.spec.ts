/**
 * 审阅进度（R2）：会话内按 canonical worktree 与范围隔离的 path -> token 记录。
 *
 * 这里盯纯状态语义：部分暂存的路径只算一个文件、标记与撤销、只重验已标记路径、
 * 其他文件不受影响、其他 worktree 与范围互不覆盖、跨 worktree 摘要只含真实已审阅数。
 * 界面入口在 app-shell、changes 与 task-review 的用例里验证。
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as progress from "../src/lib/review-progress.svelte";
import {
  CHANGES_SCOPE,
  applyReviewReverificationIn,
  beginReviewProgress,
  isReviewedIn,
  markReviewedIn,
  pruneReviewProgressIn,
  resetReviewProgress,
  reviewPaths,
  reviewProgress,
  reviewSessionSummary,
  reviewSummaryIn,
  reviewTokens,
  taskReviewScope,
  unmarkReviewedIn,
  worktreeReviewSummary,
  type ReviewTarget,
} from "../src/lib/review-progress.svelte";
import type { FileChange } from "../src/lib/types";

function change(path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"], extra: Partial<FileChange> = {}): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false, ...extra };
}

/** 部分暂存：同一路径在 staged 与 unstaged 两侧各一条记录。 */
const partial: FileChange[] = [
  change("src/app.ts", "modified", "modified"),
  change("src/app.ts", "modified", "modified"),
  change("README.md", "none", "modified"),
];

const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);
const changes = (worktree: string): ReviewTarget => ({ worktree, scope: CHANGES_SCOPE });
const task = (worktree: string, baseline: string): ReviewTarget => ({
  worktree,
  scope: taskReviewScope(baseline),
});

beforeEach(() => {
  resetReviewProgress();
});

describe("审阅进度的路径与计数", () => {
  it("部分暂存的同一路径只算一个改动文件", () => {
    expect(reviewPaths(partial)).toEqual(["src/app.ts", "README.md"]);
    expect(reviewSummaryIn(changes("C:/work/demo"), reviewPaths(partial))).toEqual({ total: 2, reviewed: 0 });
  });

  it("标记与撤销同步改变已审阅数量", () => {
    beginReviewProgress("C:/work/demo");
    markReviewedIn(changes("C:/work/demo"), "src/app.ts", "token-a");
    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(true);
    expect(reviewSummaryIn(changes("C:/work/demo"), reviewPaths(partial))).toEqual({ total: 2, reviewed: 1 });

    unmarkReviewedIn(changes("C:/work/demo"), "src/app.ts");
    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(false);
    expect(reviewSummaryIn(changes("C:/work/demo"), reviewPaths(partial))).toEqual({ total: 2, reviewed: 0 });
  });

  it("空的 token 不会变成标记", () => {
    beginReviewProgress("C:/work/demo");
    markReviewedIn(changes("C:/work/demo"), "src/app.ts", "");
    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(false);
  });
});

describe("刷新后的重验", () => {
  it("token 相同保留，变化或无法确认的取消，其他标记不受影响", () => {
    const target = changes("C:/work/demo");
    beginReviewProgress("C:/work/demo");
    markReviewedIn(target, "src/app.ts", "token-a");
    markReviewedIn(target, "README.md", "token-b");
    markReviewedIn(target, "docs/gone.md", "token-c");

    const invalidations = applyReviewReverificationIn(target, [
      { path: "src/app.ts", token: "token-a" },
      { path: "README.md", token: "token-b2", reason: "内容已变化" },
      { path: "docs/gone.md", token: null, reason: "文件已删除" },
    ]);

    expect(isReviewedIn(target, "src/app.ts")).toBe(true);
    expect(isReviewedIn(target, "README.md")).toBe(false);
    expect(isReviewedIn(target, "docs/gone.md")).toBe(false);
    expect(invalidations.map((item) => item.path)).toEqual(["README.md", "docs/gone.md"]);
    expect(invalidations[0].reason).toBe("内容已变化");
  });

  it("只处理已标记路径：未标记路径的结果不会凭空创建标记", () => {
    const target = changes("C:/work/demo");
    beginReviewProgress("C:/work/demo");
    applyReviewReverificationIn(target, [{ path: "src/other.ts", token: "token-x" }]);
    expect(isReviewedIn(target, "src/other.ts")).toBe(false);
    expect(Object.keys(reviewTokens(target))).toEqual([]);
  });

  it("改动集合里消失的路径被清理，返回被移除的路径", () => {
    const target = changes("C:/work/demo");
    beginReviewProgress("C:/work/demo");
    markReviewedIn(target, "src/app.ts", "token-a");
    markReviewedIn(target, "docs/gone.md", "token-c");
    expect(pruneReviewProgressIn(target, ["src/app.ts", "README.md"])).toEqual(["docs/gone.md"]);
    expect(isReviewedIn(target, "src/app.ts")).toBe(true);
  });
});

describe("worktree 与范围隔离", () => {
  it("切换 worktree 保留其他 worktree 的记录，同一个 worktree 的重新打开也不清空", () => {
    beginReviewProgress("C:/work/demo");
    markReviewedIn(changes("C:/work/demo"), "src/app.ts", "token-a");

    expect(beginReviewProgress("C:/Work/Demo/")).toBe(false);
    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(true);

    expect(beginReviewProgress("C:/work/other")).toBe(true);
    // 别的 worktree 的进度还在：重新进入只显示对应范围，不销毁记录。
    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(true);
    expect(isReviewedIn(changes("C:/work/other"), "src/app.ts")).toBe(false);
  });

  it("同一 worktree 的改动与任务范围各自独立，不同起点也不共享标记", () => {
    beginReviewProgress("C:/work/demo");
    markReviewedIn(changes("C:/work/demo"), "src/app.ts", "changes-token");
    markReviewedIn(task("C:/work/demo", BASE_A), "src/app.ts", "task-a-token");

    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(true);
    expect(isReviewedIn(task("C:/work/demo", BASE_A), "src/app.ts")).toBe(true);
    expect(isReviewedIn(task("C:/work/demo", BASE_B), "src/app.ts")).toBe(false);

    unmarkReviewedIn(changes("C:/work/demo"), "src/app.ts");
    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(false);
    // 撤销改动范围的标记不会动任务范围的记录。
    expect(isReviewedIn(task("C:/work/demo", BASE_A), "src/app.ts")).toBe(true);
  });

  it("同一路径的变化只撤销受影响范围，其他范围与 worktree 保持", () => {
    beginReviewProgress("C:/work/demo");
    markReviewedIn(changes("C:/work/demo"), "src/app.ts", "changes-token");
    markReviewedIn(task("C:/work/demo", BASE_A), "src/app.ts", "task-token");
    applyReviewReverificationIn(changes("C:/work/demo"), [{ path: "src/app.ts", token: "changes-token-2" }]);

    expect(isReviewedIn(changes("C:/work/demo"), "src/app.ts")).toBe(false);
    expect(isReviewedIn(task("C:/work/demo", BASE_A), "src/app.ts")).toBe(true);
  });
});

describe("跨 worktree 摘要", () => {
  it("只报告真实的已审阅条数，按范围分开，不含未记录项", () => {
    beginReviewProgress("C:/work/demo");
    markReviewedIn(changes("C:/work/demo"), "src/app.ts", "token-a");
    markReviewedIn(task("C:/work/demo", BASE_A), "src/app.ts", "task-token");
    markReviewedIn(task("C:/work/demo", BASE_A), "README.md", "task-token-2");
    beginReviewProgress("C:/work/other");

    const summary = reviewSessionSummary();
    expect(summary.map((item) => item.path).sort()).toEqual(["C:/work/demo"]);
    const demo = summary[0];
    expect(demo.reviewedTotal).toBe(3);
    expect(demo.scopes).toEqual([
      { scope: CHANGES_SCOPE, reviewed: 1 },
      { scope: taskReviewScope(BASE_A), reviewed: 2 },
    ]);
    expect(worktreeReviewSummary("C:/work/other")).toEqual({
      path: "C:/work/other",
      scopes: [],
      reviewedTotal: 0,
      updatedAtMs: 0,
    });
    expect(worktreeReviewSummary("C:/work/missing")).toBeNull();
  });
});

describe("R8-R10 边界", () => {
  it("审阅进度模块只有内存状态，没有写入、保存或批准入口", () => {
    const exported = Object.keys(progress).sort();
    expect(exported).toEqual([
      "CHANGES_SCOPE",
      "applyReviewReverificationIn",
      "beginReviewProgress",
      "isReviewedIn",
      "markReviewedIn",
      "pruneReviewProgressIn",
      "resetReviewProgress",
      "reviewPaths",
      "reviewProgress",
      "reviewSessionSummary",
      "reviewSummaryIn",
      "reviewTokenOf",
      "reviewTokens",
      "reviewedPathsIn",
      "taskReviewScope",
      "unmarkReviewedIn",
      "worktreeReviewSummary",
    ]);
  });

  it("状态里没有持久化或批准字段", () => {
    expect(Object.keys(reviewProgress).sort()).toEqual(["worktree", "worktrees"]);
  });
});
