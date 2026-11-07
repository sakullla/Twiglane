/**
 * 审阅进度（R5）：当前会话内按仓库隔离的 path -> token 记录。
 *
 * 这里盯纯状态语义：部分暂存的路径只算一个文件、标记与撤销、刷新后只重验已标记路径、
 * 其他文件不受影响、切换仓库清空。界面入口在 app-shell 与 files-tree 的用例里验证。
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as progress from "../src/lib/review-progress.svelte";
import {
  applyReviewReverification,
  beginReviewProgress,
  isReviewed,
  markReviewed,
  pruneReviewProgress,
  resetReviewProgress,
  reviewPaths,
  reviewProgress,
  reviewSummary,
  unmarkReviewed,
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

beforeEach(() => {
  resetReviewProgress();
});

describe("审阅进度的路径与计数", () => {
  it("部分暂存的同一路径只算一个改动文件", () => {
    expect(reviewPaths(partial)).toEqual(["src/app.ts", "README.md"]);
    expect(reviewSummary(reviewPaths(partial))).toEqual({ total: 2, reviewed: 0 });
  });

  it("标记与撤销同步改变已审阅数量", () => {
    beginReviewProgress("C:/work/demo");
    markReviewed("src/app.ts", "token-a");
    expect(isReviewed("src/app.ts")).toBe(true);
    expect(reviewSummary(reviewPaths(partial))).toEqual({ total: 2, reviewed: 1 });

    unmarkReviewed("src/app.ts");
    expect(isReviewed("src/app.ts")).toBe(false);
    expect(reviewSummary(reviewPaths(partial))).toEqual({ total: 2, reviewed: 0 });
  });

  it("空的 token 不会变成标记", () => {
    beginReviewProgress("C:/work/demo");
    markReviewed("src/app.ts", "");
    expect(isReviewed("src/app.ts")).toBe(false);
  });
});

describe("刷新后的重验", () => {
  it("token 相同保留，变化或无法确认的取消，其他标记不受影响", () => {
    beginReviewProgress("C:/work/demo");
    markReviewed("src/app.ts", "token-a");
    markReviewed("README.md", "token-b");
    markReviewed("docs/gone.md", "token-c");

    const invalidations = applyReviewReverification([
      { path: "src/app.ts", token: "token-a" },
      { path: "README.md", token: "token-b2", reason: "内容已变化" },
      { path: "docs/gone.md", token: null, reason: "文件已删除" },
    ]);

    expect(isReviewed("src/app.ts")).toBe(true);
    expect(isReviewed("README.md")).toBe(false);
    expect(isReviewed("docs/gone.md")).toBe(false);
    expect(invalidations.map((item) => item.path)).toEqual(["README.md", "docs/gone.md"]);
    expect(invalidations[0].reason).toBe("内容已变化");
  });

  it("只处理已标记路径：未标记路径的结果不会凭空创建标记", () => {
    beginReviewProgress("C:/work/demo");
    applyReviewReverification([{ path: "src/other.ts", token: "token-x" }]);
    expect(isReviewed("src/other.ts")).toBe(false);
    expect(Object.keys(reviewProgress.tokens)).toEqual([]);
  });

  it("改动集合里消失的路径被清理，返回被移除的路径", () => {
    beginReviewProgress("C:/work/demo");
    markReviewed("src/app.ts", "token-a");
    markReviewed("docs/gone.md", "token-c");
    expect(pruneReviewProgress(["src/app.ts", "README.md"])).toEqual(["docs/gone.md"]);
    expect(isReviewed("src/app.ts")).toBe(true);
  });
});

describe("仓库隔离", () => {
  it("切换仓库清空进度，同一 worktree 的重新打开保留", () => {
    beginReviewProgress("C:/work/demo");
    markReviewed("src/app.ts", "token-a");

    expect(beginReviewProgress("C:/Work/Demo/")).toBe(false);
    expect(isReviewed("src/app.ts")).toBe(true);

    expect(beginReviewProgress("C:/work/other")).toBe(true);
    expect(isReviewed("src/app.ts")).toBe(false);
  });
});

describe("R8-R10 边界", () => {
  it("审阅进度模块只有内存状态，没有写入、保存或批准入口", () => {
    const exported = Object.keys(progress).sort();
    expect(exported).toEqual([
      "applyReviewReverification",
      "beginReviewProgress",
      "isReviewed",
      "markReviewed",
      "pruneReviewProgress",
      "resetReviewProgress",
      "reviewPaths",
      "reviewProgress",
      "reviewSummary",
      "reviewTokenOf",
      "unmarkReviewed",
    ]);
  });
});
