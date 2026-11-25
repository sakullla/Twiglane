/**
 * 审查工作台界面状态（按 reviewId 隔离）：保存、恢复、来源间隔离与关闭清理。
 * 只验内存 store；工作台组件如何使用这些状态由后续 DOM 测试覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginClioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { commentDraft, resetReviewComments, setCommentDraft } from "../src/lib/review-comments.svelte";
import { createReviewActions, type ReviewActionsHost } from "../src/lib/review-actions.svelte";
import {
  defaultWorkbenchState,
  forgetWorkbenchState,
  hasWorkbenchState,
  resetReviewWorkbench,
  saveWorkbenchState,
  workbenchState,
} from "../src/lib/review-workbench.svelte";

vi.mock("../src/lib/api", () => ({
  api: { clioraReviewForget: vi.fn(async () => undefined) },
}));

const A = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
const B = "0f0e0d0c-0b0a-4908-8706-050403020100";

beforeEach(() => {
  resetReviewWorkbench();
  resetReviewComments();
  resetClioraReview();
});

describe("review-workbench state", () => {
  it("没有保存过的来源返回默认状态，且不会因此创建记录", () => {
    expect(workbenchState(A)).toEqual({
      selectedPath: null,
      selectedSet: [],
      readingMode: "single",
      diffMode: "unified",
      filter: "all",
      query: "",
      drawerOpen: false,
      scrollAnchor: null,
      commitsOpen: false,
    });
    expect(hasWorkbenchState(A)).toBe(false);
    expect(defaultWorkbenchState()).toEqual(workbenchState(A));
  });

  it("保存后可以完整恢复全部字段", () => {
    saveWorkbenchState(A, {
      selectedPath: "src/lib/api.ts",
      selectedSet: ["src/lib/api.ts", "src/App.svelte"],
      readingMode: "continuous",
      diffMode: "split",
      filter: "unreviewed",
      query: "api",
      drawerOpen: true,
      scrollAnchor: { path: "src/lib/api.ts", offset: 480, line: 120 },
      commitsOpen: true,
    });
    expect(workbenchState(A)).toEqual({
      selectedPath: "src/lib/api.ts",
      selectedSet: ["src/lib/api.ts", "src/App.svelte"],
      readingMode: "continuous",
      diffMode: "split",
      filter: "unreviewed",
      query: "api",
      drawerOpen: true,
      scrollAnchor: { path: "src/lib/api.ts", offset: 480, line: 120 },
      commitsOpen: true,
    });
    expect(hasWorkbenchState(A)).toBe(true);
  });

  it("合并保存：只改给出的字段，其余保持", () => {
    saveWorkbenchState(A, { selectedPath: "a.ts", readingMode: "continuous" });
    saveWorkbenchState(A, { filter: "commented" });
    const state = workbenchState(A);
    expect(state.selectedPath).toBe("a.ts");
    expect(state.readingMode).toBe("continuous");
    expect(state.filter).toBe("commented");
  });

  it("来源之间互不影响：切换来源各自恢复", () => {
    saveWorkbenchState(A, { selectedPath: "a.ts", diffMode: "split", drawerOpen: true, query: "x" });
    saveWorkbenchState(B, { selectedPath: "b.ts", readingMode: "continuous", filter: "unreviewed" });
    expect(workbenchState(A)).toMatchObject({ selectedPath: "a.ts", diffMode: "split", drawerOpen: true, query: "x", readingMode: "single", filter: "all" });
    expect(workbenchState(B)).toMatchObject({ selectedPath: "b.ts", readingMode: "continuous", filter: "unreviewed", diffMode: "unified", drawerOpen: false, query: "" });
    saveWorkbenchState(B, { selectedPath: "b2.ts" });
    expect(workbenchState(A).selectedPath).toBe("a.ts");
  });

  it("读取与保存都返回副本：外部修改数组或锚点不会写回 store", () => {
    const selectedSet = ["a.ts"];
    const scrollAnchor = { path: "a.ts", offset: 10 };
    const saved = saveWorkbenchState(A, { selectedSet, scrollAnchor });
    selectedSet.push("b.ts");
    scrollAnchor.offset = 99;
    saved.selectedSet.push("c.ts");
    const read = workbenchState(A);
    read.selectedSet.push("d.ts");
    read.scrollAnchor!.offset = 77;
    expect(workbenchState(A).selectedSet).toEqual(["a.ts"]);
    expect(workbenchState(A).scrollAnchor).toEqual({ path: "a.ts", offset: 10 });
  });

  it("关闭来源时只清理该来源", () => {
    saveWorkbenchState(A, { selectedPath: "a.ts" });
    saveWorkbenchState(B, { selectedPath: "b.ts" });
    forgetWorkbenchState(A);
    expect(hasWorkbenchState(A)).toBe(false);
    expect(workbenchState(A)).toEqual(defaultWorkbenchState());
    expect(workbenchState(B).selectedPath).toBe("b.ts");
    forgetWorkbenchState("missing");
    expect(hasWorkbenchState(B)).toBe(true);
  });

  it("空 reviewId 不保存任何状态", () => {
    saveWorkbenchState("", { selectedPath: "a.ts" });
    expect(hasWorkbenchState("")).toBe(false);
  });
});

describe("关闭来源时清理工作台状态", () => {
  function host(): ReviewActionsHost {
    return {
      opened: () => null,
      taskScope: () => null,
      taskTarget: () => null,
      commentScope: () => null,
      commentScopeOutdated: () => false,
      nextId: () => 1,
      notice: vi.fn(),
      showError: vi.fn(),
      setReviewNote: vi.fn(),
      setTaskReviewNote: vi.fn(),
      confirmEditorLeave: async () => true,
      refresh: async () => true,
      switchBlocked: () => false,
      openRecent: async () => undefined,
      openTaskReview: vi.fn(),
      closeTask: vi.fn(),
      closeReviewManager: vi.fn(),
      clearSourcesNotice: vi.fn(),
    };
  }

  it("单个关闭只清理该来源的界面状态与草稿", async () => {
    beginClioraReview({ reviewId: A, sessionId: "s-a", worktreePath: "/work/a", baseline: null });
    beginClioraReview({ reviewId: B, sessionId: "s-b", worktreePath: "/work/b", baseline: null }, false);
    saveWorkbenchState(A, { selectedPath: "a.ts" });
    saveWorkbenchState(B, { selectedPath: "b.ts" });
    setCommentDraft(A, { body: "草稿 A" });
    const actions = createReviewActions(host());
    await actions.closeClioraReview(A);
    expect(hasWorkbenchState(A)).toBe(false);
    expect(commentDraft(A)).toBeNull();
    expect(workbenchState(B).selectedPath).toBe("b.ts");
  });

  it("全部关闭清理每个来源的界面状态", async () => {
    beginClioraReview({ reviewId: A, sessionId: "s-a", worktreePath: "/work/a", baseline: null });
    beginClioraReview({ reviewId: B, sessionId: "s-b", worktreePath: "/work/b", baseline: null }, false);
    saveWorkbenchState(A, { selectedPath: "a.ts" });
    saveWorkbenchState(B, { selectedPath: "b.ts" });
    const actions = createReviewActions(host());
    await actions.closeAllClioraReviews();
    expect(hasWorkbenchState(A)).toBe(false);
    expect(hasWorkbenchState(B)).toBe(false);
  });
});
