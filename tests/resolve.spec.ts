import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canCompleteMerge,
  conflictKindLabel,
  discardActionLabel,
  discardBoundary,
  operationCaption,
  showMergeAbort,
  undoActionLabel,
} from "../src/lib/resolve";
import type { MergeSession, OpenedRepository } from "../src/lib/types";

const mergeSession = vi.hoisted(() => vi.fn());
const branchState = vi.hoisted(() => vi.fn());
const mergePreview = vi.hoisted(() => vi.fn());
const startMerge = vi.hoisted(() => vi.fn());
const conflictView = vi.hoisted(() => vi.fn());
const resolveConflict = vi.hoisted(() => vi.fn());
const completeMerge = vi.hoisted(() => vi.fn());
const abortMerge = vi.hoisted(() => vi.fn());
const undoCommit = vi.hoisted(() => vi.fn());
const discardChanges = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: {
    mergeSession,
    branchState,
    mergePreview,
    startMerge,
    conflictView,
    resolveConflict,
    completeMerge,
    abortMerge,
    undoCommit,
    discardChanges,
  },
}));

import MergePanel from "../src/lib/components/MergePanel.svelte";
import RecoveryActions from "../src/lib/components/RecoveryActions.svelte";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 4,
  snapshot: {
    generation: 4,
    branch: {
      name: "main",
      detached: false,
      unborn: false,
      headOid: "a".repeat(40),
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      liveRemoteChecked: true,
      remoteCheckedAtMs: 1,
      remoteCheckStale: false,
    },
    files: [
      {
        path: "keep.txt",
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
      {
        path: "drop.txt",
        originalPath: null,
        staged: "modified",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
    ],
  },
  draft: "",
  watchDegraded: false,
};

function session(extra: Partial<MergeSession> = {}): MergeSession {
  return {
    generation: 4,
    operation: "none",
    canContinue: false,
    canAbort: false,
    source: null,
    target: "main",
    headOid: "a".repeat(40),
    conflicts: [],
    unresolved: 0,
    note: "当前没有进行中的合并。",
    snapshot: opened.snapshot,
    ...extra,
  };
}

describe("合并与恢复文案", () => {
  it("区分合并、外部状态、撤销和放弃", () => {
    expect(operationCaption("merge")).toBe("正在进行分支合并");
    expect(operationCaption("rebase")).toContain("rebase");
    expect(operationCaption("cherry-pick")).toContain("cherry-pick");
    expect(operationCaption("unmerged")).toContain("不是分支合并");
    expect(operationCaption("none")).toContain("没有进行中的合并");
    expect(conflictKindLabel("binary")).toBe("二进制冲突");
    expect(conflictKindLabel("modify_delete")).toBe("修改/删除冲突");
    expect(canCompleteMerge("merge", 1)).toBe(false);
    expect(canCompleteMerge("merge", 0)).toBe(true);
    expect(canCompleteMerge("cherry-pick", 0)).toBe(false);
    expect(showMergeAbort("rebase", true)).toBe(false);
    expect(showMergeAbort("merge", true)).toBe(true);
    expect(undoActionLabel()).toContain("撤销最近提交");
    expect(undoActionLabel()).not.toBe(discardActionLabel());
    expect(discardActionLabel()).toContain("放弃");
    expect(discardBoundary()).toContain("取消不写入");
  });
});

describe("合并面板", () => {
  beforeEach(() => {
    mergeSession.mockReset();
    branchState.mockReset();
    mergePreview.mockReset();
    startMerge.mockReset();
    conflictView.mockReset();
    branchState.mockResolvedValue({ generation: 4, branches: [], snapshot: opened.snapshot });
  });

  it("外部 rebase 不提供完成或中止", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "rebase",
        note: "检测到 rebase 进行中。这里不会继续、跳过或中止 rebase。",
      }),
    );
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
    });
    expect(await screen.findByText(/不会继续、跳过或中止 rebase/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "中止合并" })).toBeNull();
    expect(screen.queryByRole("button", { name: "完成合并" })).toBeNull();
  });

  it("未解决冲突时不能完成合并", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "merge",
        canAbort: true,
        unresolved: 1,
        conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
        note: "还有 1 个未解决冲突，不能完成。",
      }),
    );
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
    });
    const complete = await screen.findByRole("button", { name: "完成合并" });
    expect(complete.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/不能完成合并/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "中止合并" })).toBeTruthy();
  });

  it("脏工作区先列出路径，确认前不开始合并", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue({
      generation: 4,
      branches: [
        { name: "main", remote: false, current: true, upstream: null, worktree: null },
        { name: "feature", remote: false, current: false, upstream: null, worktree: null },
      ],
      snapshot: opened.snapshot,
    });
    mergePreview.mockResolvedValue({
      generation: 4,
      source: "feature",
      target: "main",
      headOid: "a".repeat(40),
      dirty: true,
      localPaths: ["keep.txt"],
      canStart: false,
      operation: "none",
      note: "工作区有 4 处未提交改动，下面只展示 1 条，还有 3 条未展示。合并前请先提交或临时保存。未开始合并。",
    });
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
    });
    await screen.findByRole("button", { name: "预览合并" });
    await fireEvent.click(screen.getByRole("button", { name: "预览合并" }));
    expect(await screen.findByText(/来源 feature，目标 main/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "本地改动" }).textContent).toContain("keep.txt");
    expect(screen.getByText(/还有 3 条未展示/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认开始合并" })).toBeNull();
    expect(startMerge).not.toHaveBeenCalled();
  });

  it("干净工作区写明没有改动，确认后才开始合并", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue({
      generation: 4,
      branches: [
        { name: "main", remote: false, current: true, upstream: null, worktree: null },
        { name: "feature", remote: false, current: false, upstream: null, worktree: null },
      ],
      snapshot: opened.snapshot,
    });
    mergePreview.mockResolvedValue({
      generation: 5,
      source: "feature",
      target: "main",
      headOid: "a".repeat(40),
      dirty: false,
      localPaths: [],
      canStart: true,
      operation: "none",
      note: "将把 feature 合并到 main。当前没有未提交改动。",
    });
    startMerge.mockResolvedValue(session({ operation: "merge", note: "正在合并 feature。" }));
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
    });
    await screen.findByRole("button", { name: "预览合并" });
    await fireEvent.click(screen.getByRole("button", { name: "预览合并" }));
    expect(await screen.findByText("当前没有未提交改动。")).toBeTruthy();
    expect(screen.getByText(/来源 feature，目标 main/)).toBeTruthy();
    expect(startMerge).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "确认开始合并" }));
    expect(startMerge).toHaveBeenCalledWith("/repo", "feature", 5, 1);
  });

  it("未合并文件可以逐项处理，但不能中止合并", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "unmerged",
        canAbort: false,
        unresolved: 1,
        conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
        note: "这不是合并，不能中止合并。",
      }),
    );
    conflictView.mockResolvedValue({
      generation: 4,
      path: "file.txt",
      kind: "text",
      editable: true,
      ours: { present: true, binary: false, truncated: false, text: "ours\n", summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: "theirs\n", summary: "另一侧" },
      result: { present: true, binary: false, truncated: false, text: "both\n", summary: "结果" },
      note: "可以编辑合并结果。",
    });
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
    });
    expect(await screen.findByRole("button", { name: "文本冲突 file.txt" })).toBeTruthy();
    expect(screen.getAllByText(/不能中止/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "中止合并" })).toBeNull();
    expect(screen.queryByRole("button", { name: "完成合并" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "文本冲突 file.txt" }));
    expect(await screen.findByRole("button", { name: "标记编辑结果" })).toBeTruthy();
    expect(conflictView).toHaveBeenCalledWith("/repo", "file.txt", 4, 1);
  });
});

describe("放弃与撤销", () => {
  beforeEach(() => {
    discardChanges.mockReset();
    undoCommit.mockReset();
  });

  it("取消放弃不写入，确认只提交所选文件", async () => {
    discardChanges.mockResolvedValue({
      generation: 4,
      wrote: false,
      boundary: "确认只影响所选文件。取消不写入，未选择的文件保持原内容。",
      snapshot: opened.snapshot,
      files: [
        {
          path: "drop.txt",
          originalPath: "from.txt",
          staged: "renamed",
          unstaged: "none",
          untracked: false,
          impact: "这是重命名：from.txt → drop.txt。确认后原路径和新路径都会回到当前提交。",
          recovery: "放弃后 Git 不保留这份未提交内容，本应用不能撤销这次放弃。",
        },
        {
          path: "keep.txt",
          originalPath: null,
          staged: "none",
          unstaged: "modified",
          untracked: false,
          impact: "未暂存的修改会回到当前提交。",
          recovery: "放弃后 Git 不保留这份未提交内容，本应用不能撤销这次放弃。",
        },
      ],
    });
    render(RecoveryActions, {
      opened,
      disabled: false,
      nextId: () => 2,
      onSnapshot: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onMerge: () => {},
    });
    await fireEvent.click(screen.getByRole("button", { name: discardActionLabel() }));
    expect(await screen.findByText(/取消不写入/)).toBeTruthy();
    expect(screen.getByText("from.txt → drop.txt")).toBeTruthy();
    expect(screen.getByText(/原路径和新路径都会回到当前提交/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(discardChanges).toHaveBeenCalledTimes(1);
    expect(discardChanges).toHaveBeenCalledWith("/repo", ["keep.txt", "drop.txt"], false, 4, 2);
    await fireEvent.click(screen.getByRole("button", { name: discardActionLabel() }));
    await screen.findByText(/取消不写入/);
    await fireEvent.click(screen.getByRole("button", { name: "确认放弃所选" }));
    expect(discardChanges).toHaveBeenLastCalledWith("/repo", ["keep.txt"], true, 4, 2);
  });

  it("不能撤销时说明原因且不写入", async () => {
    undoCommit.mockResolvedValue({
      generation: 4,
      code: "undo_pushed",
      eligible: false,
      wrote: false,
      headOid: "a".repeat(40),
      parentOid: "b".repeat(40),
      summary: "已经推送",
      reason: "这个提交已经出现在该远程的分支上，未改写共享历史。",
      snapshot: opened.snapshot,
    });
    render(RecoveryActions, {
      opened,
      disabled: false,
      nextId: () => 3,
      onSnapshot: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onMerge: () => {},
    });
    await fireEvent.click(screen.getByRole("button", { name: undoActionLabel() }));
    expect(await screen.findByText(/未改写共享历史/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认撤销提交" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(undoCommit).toHaveBeenCalledTimes(1);
    expect(undoCommit).toHaveBeenCalledWith("/repo", "a".repeat(40), false, 4, 3);
  });
});
