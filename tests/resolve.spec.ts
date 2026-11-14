import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortActionLabel,
  canCompleteMerge,
  conflictKindLabel,
  continueActionLabel,
  discardActionLabel,
  discardBoundary,
  operationCaption,
  operationVerb,
  showMergeAbort,
  undoActionLabel,
} from "../src/lib/resolve";
import type { GitInfo, MergeSession, OpenedRepository } from "../src/lib/types";

const mergeSession = vi.hoisted(() => vi.fn());
const branchState = vi.hoisted(() => vi.fn());
const mergePreview = vi.hoisted(() => vi.fn());
const historyPage = vi.hoisted(() => vi.fn());
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
    historyPage,
    startMerge,
    conflictView,
    resolveConflict,
    completeMerge,
    abortMerge,
    undoCommit,
    discardChanges,
  },
}));

import MergePanel, { adjacentPendingFile, clearConflictDrafts } from "../src/lib/components/MergePanel.svelte";
import MergeModal from "../src/lib/components/MergeModal.svelte";
import MergeBanner, { mergeNotice } from "../src/lib/components/MergeBanner.svelte";
import PublishModal from "../src/lib/components/PublishModal.svelte";
import RecoveryActions from "../src/lib/components/RecoveryActions.svelte";
import ScopeModal from "../src/lib/components/ScopeModal.svelte";
import SettingsModal from "../src/lib/components/SettingsModal.svelte";

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
    expect(operationCaption("rebase")).toBe("正在变基");
    expect(operationCaption("cherry-pick")).toBe("正在拣选");
    expect(operationCaption("revert")).toBe("正在还原提交");
    expect(operationCaption("unmerged")).toContain("不是分支合并");
    expect(operationCaption("none")).toContain("没有进行中的合并");
    expect(conflictKindLabel("binary")).toBe("二进制冲突");
    expect(conflictKindLabel("modify_delete")).toBe("修改/删除冲突");
    expect(canCompleteMerge("merge", 1)).toBe(false);
    expect(canCompleteMerge("merge", 0)).toBe(true);
    expect(canCompleteMerge("rebase", 0)).toBe(true);
    expect(canCompleteMerge("rebase", 1)).toBe(false);
    expect(canCompleteMerge("cherry-pick", 0)).toBe(true);
    expect(canCompleteMerge("cherry-pick", 1)).toBe(false);
    expect(canCompleteMerge("revert", 0)).toBe(true);
    expect(canCompleteMerge("revert", 1)).toBe(false);
    // sequencer 停在后续目标时不能继续，只能中止。
    expect(canCompleteMerge("revert", 0, false)).toBe(false);
    expect(showMergeAbort("rebase", true)).toBe(true);
    expect(showMergeAbort("cherry-pick", false)).toBe(false);
    expect(showMergeAbort("revert", true)).toBe(true);
    expect(showMergeAbort("unmerged", true)).toBe(false);
    expect(showMergeAbort("merge", true)).toBe(true);
    expect(operationVerb("revert")).toBe("还原");
    expect(continueActionLabel("revert")).toBe("继续还原");
    expect(abortActionLabel("revert")).toBe("中止还原");
    expect(undoActionLabel()).toContain("撤销最近提交");
    expect(undoActionLabel()).not.toBe(discardActionLabel());
    expect(discardActionLabel()).toContain("放弃");
    expect(discardBoundary()).toContain("取消不写入");
  });
});

describe("还原提示", () => {
  it("还原进行中显示还原文案和中止还原，不伪装成分支合并", () => {
    const { container } = render(MergeBanner, {
      props: {
        conflictCount: 2,
        mergeInProgress: true,
        operation: "revert",
        canAbort: true,
        onOpen: vi.fn(),
        onAbort: vi.fn(),
      },
    });
    const banner = container.querySelector<HTMLElement>("[data-merge-banner]")!;
    expect(banner.textContent).toContain("2 个还原冲突待处理");
    expect(banner.getAttribute("aria-label")).toContain("还原进行中");
    expect(banner.getAttribute("title")).toContain("还原");
    expect(banner.textContent).not.toContain("合并");
    const abort = container.querySelector<HTMLElement>("[data-merge-abort]")!;
    expect(abort.getAttribute("aria-label")).toBe("中止还原");
    expect(abort.getAttribute("title")).toContain("中止还原");
    expect(mergeNotice(2, true, "revert")?.label).not.toContain("分支合并");
  });

  it("冲突已解决但仍进行中时提示继续还原；没有操作时与既有合并文案保持一致", () => {
    expect(mergeNotice(0, true, "revert")?.text).toBe("可以继续还原");
    expect(mergeNotice(0, false, "revert")).toBeNull();
    expect(mergeNotice(2, true, "merge")?.text).toBe("2 个冲突待处理");
    expect(mergeNotice(0, true, "merge")?.text).toBe("可以完成合并");
    expect(mergeNotice(2, true, "merge")?.label).toContain("打开分支合并");
    // 还原序列停在后续目标：不能说可以继续，只能中止。
    expect(mergeNotice(0, true, "revert", false)?.text).toBe("还原停在后续目标，可以中止");
    expect(mergeNotice(0, true, "revert", false)?.label).toContain("打开还原");
  });
});

describe("合并面板", () => {
  beforeEach(() => {
    mergeSession.mockReset();
    branchState.mockReset();
    mergePreview.mockReset();
    historyPage.mockReset();
    startMerge.mockReset();
    completeMerge.mockReset();
    conflictView.mockReset();
    abortMerge.mockReset();
    branchState.mockResolvedValue({ generation: 4, branches: [], snapshot: opened.snapshot });
  });

  it("进行中的变基和拣选可以继续或中止，没有跳过", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "rebase",
        canAbort: true,
        canContinue: false,
        unresolved: 1,
        conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
        note: "正在变基（rebase）。还有 1 个未解决冲突，不能完成。不能跳过。",
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
    const continueRebase = await screen.findByRole("button", { name: "继续变基" });
    expect(continueRebase.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(/不能算完成/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/不能跳过/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/当前一侧是基底/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "中止变基" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /跳过/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "完成合并" })).toBeNull();
  });

  it("还原冲突显示继续/中止还原，不出现完成合并或跳过", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "revert",
        canAbort: true,
        canContinue: false,
        unresolved: 1,
        conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
        note: "正在还原（revert）。还有 1 个未解决冲突，不能完成。解决后可以继续，也可以中止。不能跳过。",
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
    const continueRevert = await screen.findByRole("button", { name: "继续还原" });
    expect(continueRevert.hasAttribute("disabled")).toBe(true);
    const foot = document.querySelector<HTMLElement>(".mp-foot")!;
    expect(foot.textContent).toContain("还有 1 个未解决冲突，不能继续还原");
    expect(foot.textContent).not.toContain("停在后续目标");
    await vi.waitFor(() => expect(continueRevert.getAttribute("title")).toContain("还有 1 个未解决冲突"));
    expect(screen.getByRole("button", { name: "中止还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "完成合并" })).toBeNull();
    expect(screen.queryByRole("button", { name: /跳过/ })).toBeNull();
    expect(screen.getAllByText(/正在还原/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/合并进行中/)).toBeNull();
  });

  it("中止还原先确认并说明已创建的提交会被撤销", async () => {
    mergeSession.mockResolvedValueOnce(
      session({
        operation: "revert",
        canAbort: true,
        canContinue: false,
        unresolved: 1,
        conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
        note: "正在还原（revert）。还有 1 个未解决冲突，不能完成。",
      }),
    );
    mergeSession.mockResolvedValue(session());
    abortMerge.mockResolvedValue({
      generation: 8,
      wrote: false,
      paths: ["file.txt"],
      stashOids: [],
      note: "中止会撤销这次还原，并恢复原状态。",
      snapshot: opened.snapshot,
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
    await fireEvent.click(await screen.findByRole("button", { name: "中止还原" }));
    const dialog = await screen.findByRole("dialog", { name: "中止还原" });
    expect(abortMerge).toHaveBeenCalledWith("/repo", false, 4, 1);
    expect(dialog.textContent).toContain("本次还原已创建的提交也会一并撤销");
    expect(dialog.textContent).toContain("仓库回到本次还原开始前的状态");
    await fireEvent.click(within(dialog).getByRole("button", { name: "中止还原" }));
    await vi.waitFor(() => expect(abortMerge).toHaveBeenLastCalledWith("/repo", true, 8, 1));
  });

  it("sequencer 停在后续目标时只能中止，不能把暂停说成可继续", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "revert",
        canAbort: true,
        canContinue: false,
        unresolved: 0,
        conflicts: [],
        note: "还原序列停在后续目标，无法继续应用。可以中止回到本次还原开始前。",
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
    const continueRevert = await screen.findByRole("button", { name: "继续还原" });
    expect(continueRevert.hasAttribute("disabled")).toBe(true);
    expect(continueRevert.getAttribute("title")).toContain("只能中止");
    expect(screen.getByRole("button", { name: "中止还原" })).toBeTruthy();
    expect(screen.getAllByText(/序列停在后续目标/).length).toBeGreaterThan(0);
  });

  it("继续还原完成后显示还原完成页，只提供查看历史", async () => {
    mergeSession.mockResolvedValueOnce(
      session({
        operation: "revert",
        canAbort: true,
        canContinue: true,
        unresolved: 0,
        conflicts: [],
        note: "正在还原（revert）。冲突已全部标记，可以继续。",
      }),
    );
    mergeSession.mockResolvedValue(session());
    completeMerge.mockResolvedValue({
      oid: "d".repeat(40),
      generation: 7,
      summary: "已继续还原，后续目标已处理。没有推送。",
      files: [],
      snapshot: opened.snapshot,
    });
    const onOpenHistory = vi.fn();
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 3,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
      onOpenHistory,
    });
    await fireEvent.click(await screen.findByRole("button", { name: "继续还原" }));
    expect(await screen.findByText("已继续还原")).toBeTruthy();
    expect(completeMerge).toHaveBeenCalledWith("/repo", "", 4, 3, "revert");
    expect(screen.queryByRole("button", { name: "再合并一次" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "查看提交历史" }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/尚未推送/)).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: /跳过/ })).toBeNull();
  });

  const twoBranches = {
    generation: 4,
    branches: [
      { name: "main", remote: false, current: true, upstream: null, worktree: null },
      { name: "feature", remote: false, current: false, upstream: null, worktree: null },
      { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
    ],
    snapshot: opened.snapshot,
  };

  function previewOf(extra: Record<string, unknown> = {}) {
    return {
      generation: 5,
      source: "feature",
      target: "main",
      headOid: "a".repeat(40),
      dirty: false,
      localPaths: [],
      canStart: true,
      operation: "none",
      note: "将把 feature 合并到 main。当前没有未提交改动。",
      current: "main",
      needsSwitch: false,
      incoming: 2,
      outgoing: 1,
      upToDate: false,
      fastForward: false,
      commits: [
        { oid: "c".repeat(40), parents: [], summary: "加上登录页", authorName: "Ada", authorEmail: "a@x", authoredAt: 1, labels: [] },
      ],
      files: [{ path: "src/login.ts", originalPath: null, status: "added" }],
      filesTotal: 1,
      conflictCheck: "clean",
      conflictPaths: [],
      blocker: null,
      ...extra,
    };
  }

  function renderPanel(extra: Record<string, unknown> = {}) {
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
      ...extra,
    });
  }

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function useBranchTips(tips: Record<string, string>) {
    branchState.mockImplementation(async (_repo: string, generation: number) => ({
      ...twoBranches, generation,
      branches: twoBranches.branches.map((branch) => ({ ...branch, targetOid: tips[branch.name] ?? null })),
    }));
  }

  /** 让 session 跟随 generation，并返回能推进 generation 的句柄（相当于 repo-changed 事件）。 */
  function mountForPreview(extra: Record<string, unknown> = {}, tips?: Record<string, string>) {
    mergeSession.mockImplementation(async (_repo: string, generation: number) => session({ generation }));
    branchState.mockResolvedValue(twoBranches);
    if (tips) useBranchTips(tips);
    const onGeneration = vi.fn();
    const props = {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration,
      onFailure: () => {},
      onNotice: () => {},
      onOpenStash: () => {},
      ...extra,
    };
    const view = render(MergePanel, props);
    const bump = (generation: number, snapshot = opened.snapshot) => view.rerender({ opened: { ...opened, generation, snapshot } });
    return { bump, onGeneration };
  }

  function previewBusy(): string | null {
    return document.querySelector(".merge-check")?.getAttribute("aria-busy") ?? null;
  }

  it("generation 连续变化但仓库状态不变时不重新预检，开始合并保持可点", async () => {
    mergePreview.mockResolvedValue(previewOf({ generation: 4 }));
    const { bump } = mountForPreview();
    const start = await screen.findByRole("button", { name: "合并到 main" });
    await vi.waitFor(() => expect(previewBusy()).toBe("false"));
    for (let generation = 5; generation < 12; generation += 1) {
      await bump(generation);
      await settle(30);
      expect(previewBusy()).toBe("false");
      expect(start.hasAttribute("disabled")).toBe(false);
    }
    await settle(240);
    expect(mergePreview).toHaveBeenCalledTimes(1);
    expect(mergeSession.mock.calls.length).toBeGreaterThan(1);
    expect(document.querySelector(".merge-check .spinner")).toBeNull();
  });

  it("预检自身推进 generation 时不形成循环", async () => {
    let bump: (generation: number) => Promise<void> = async () => {};
    // 真实循环：预检写入 .git/objects，监听随后推进 generation，并把新值回传给面板。
    mergePreview.mockImplementation(async (_repo: string, _source: string, _target: string | null, generation: number) => {
      void settle(10).then(() => bump(generation + 1));
      return previewOf({ generation });
    });
    const mounted = mountForPreview();
    bump = mounted.bump;
    await screen.findByRole("button", { name: "合并到 main" });
    await settle(800);
    expect(mergePreview).toHaveBeenCalledTimes(1);
    expect(previewBusy()).toBe("false");
  });

  it("预检遇到过期时用新 generation 重试一次，算同一轮检查", async () => {
    mergePreview
      .mockRejectedValueOnce({ code: "stale", message: "过期", generation: 6 })
      .mockResolvedValueOnce(previewOf({ generation: 6 }));
    const { onGeneration } = mountForPreview();
    await screen.findByRole("button", { name: "合并到 main" });
    expect(mergePreview.mock.calls.map((call) => call[3])).toEqual([4, 6]);
    expect(onGeneration).toHaveBeenCalledWith(6);
    await settle(240);
    expect(mergePreview).toHaveBeenCalledTimes(2);
    expect(previewBusy()).toBe("false");
  });

  it("重试后仍过期时停下并给出重试入口，不自动再来", async () => {
    mergePreview.mockRejectedValue({ code: "stale", message: "过期", generation: 6 });
    mountForPreview();
    expect(await screen.findByText(/仓库正在变化/)).toBeTruthy();
    await settle(240);
    expect(mergePreview).toHaveBeenCalledTimes(2);
    expect(previewBusy()).toBe("false");
    mergePreview.mockReset();
    mergePreview.mockResolvedValue(previewOf({ generation: 6 }));
    await fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "合并到 main" })).toBeTruthy();
  });

  it("外部提交到来源分支后更新结果，检查期间保留旧结果且可以开始", async () => {
    const tips = { main: "a".repeat(40), feature: "b".repeat(40) };
    mergePreview.mockResolvedValueOnce(previewOf({ generation: 4, incoming: 2 }));
    const { bump } = mountForPreview({}, tips);
    const start = await screen.findByRole("button", { name: "合并到 main" });
    expect(historyPage).not.toHaveBeenCalled();
    const incoming = () => screen.getByRole("tab", { name: /^提交/ }).querySelector(".count")?.textContent;
    expect(incoming()).toBe("2");

    let finish: (value: unknown) => void = () => {};
    mergePreview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    tips.feature = "d".repeat(40);
    await bump(5);
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(2));
    expect(previewBusy()).toBe("true");
    expect(incoming()).toBe("2");
    expect(start.hasAttribute("disabled")).toBe(false);

    finish(previewOf({ generation: 5, incoming: 3 }));
    await vi.waitFor(() => expect(incoming()).toBe("3"));
    expect(previewBusy()).toBe("false");
  });

  it("当前分支前进或已跟踪文件变化时重新预检", async () => {
    mergePreview.mockImplementation(async (_repo: string, _source: string, _target: string | null, generation: number) => previewOf({ generation }));
    mergeSession.mockImplementation(async (_repo: string, generation: number) => session({ generation }));
    const { bump } = mountForPreview();
    await screen.findByRole("button", { name: "合并到 main" });

    const moved = { ...opened.snapshot, branch: { ...opened.snapshot.branch, headOid: "e".repeat(40) } };
    mergeSession.mockImplementation(async (_repo: string, generation: number) => session({ generation, snapshot: moved }));
    await bump(5);
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(2));

    const edited = { ...moved, files: [] };
    mergeSession.mockImplementation(async (_repo: string, generation: number) => session({ generation, snapshot: edited }));
    await bump(6);
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(3));

    const untracked = {
      ...edited,
      files: [{ path: "new.txt", originalPath: null, staged: "none" as const, unstaged: "none" as const, untracked: true, unmerged: false }],
    };
    mergeSession.mockImplementation(async (_repo: string, generation: number) => session({ generation, snapshot: untracked }));
    await bump(7);
    await settle(260);
    expect(mergePreview).toHaveBeenCalledTimes(3);
  });

  it("依据未变时用最新 generation 开始，后端的校验仍在", async () => {
    const tips = { main: "a".repeat(40), feature: "b".repeat(40) };
    mergePreview.mockResolvedValue(previewOf({ generation: 4 }));
    startMerge.mockRejectedValue({ code: "stale", message: "仓库状态已变化", generation: 9 });
    const onFailure = vi.fn();
    const { bump } = mountForPreview({ onFailure }, tips);
    const start = await screen.findByRole("button", { name: "合并到 main" });
    await bump(7);
    await vi.waitFor(() => expect(branchState).toHaveBeenCalledTimes(2));
    await tick();
    await fireEvent.click(start);
    await vi.waitFor(() => expect(startMerge).toHaveBeenCalledWith("/repo", "feature", null, "merge", 7, 1));
    // 被 generation 校验拦下后不会写入，并按最新状态重新检查。
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(2));
  });

  it("读不到分支位置时不放宽：沿用预检时的 generation", async () => {
    mergePreview.mockResolvedValue(previewOf({ generation: 4 }));
    startMerge.mockRejectedValue({ code: "stale", message: "仓库状态已变化", generation: 7 });
    const { bump } = mountForPreview();
    const start = await screen.findByRole("button", { name: "合并到 main" });
    await bump(7);
    await settle(30);
    await fireEvent.click(start);
    await vi.waitFor(() => expect(startMerge).toHaveBeenCalledWith("/repo", "feature", null, "merge", 4, 1));
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(2));
  });

  it("脏工作区自动预览后列出已跟踪改动，不开始合并", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockResolvedValue(
      previewOf({
        generation: 4,
        dirty: true,
        localPaths: ["keep.txt"],
        canStart: false,
        blocker: "dirty",
        note: "工作区有 4 处未提交改动，下面只展示 1 条，还有 3 条未展示。合并前请先提交或临时保存。未开始合并。",
      }),
    );
    renderPanel();
    expect(await screen.findByText("先处理本地改动")).toBeTruthy();
    // 默认方向：用主干以外的本地分支更新当前分支；目标是当前分支时不传 target。
    expect(mergePreview).toHaveBeenCalledWith("/repo", "feature", null, 4, 1);
    expect(screen.getByRole("list", { name: "本地改动" }).textContent).toContain("keep.txt");
    expect(screen.getByText(/还有 3 条未展示/)).toBeTruthy();
    expect(screen.getByText(/未跟踪的新文件不会阻止合并/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /合并到 main|合并/ }).hasAttribute("disabled")).toBe(true);
    expect(startMerge).not.toHaveBeenCalled();
  });

  it("无冲突时一次完成：开始合并后直接用填写的说明提交", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockResolvedValue(previewOf());
    startMerge.mockResolvedValue(session({ generation: 6, operation: "merge", canAbort: true, canContinue: true, source: "feature" }));
    completeMerge.mockResolvedValue({ oid: "d".repeat(40), generation: 7, summary: "已完成合并提交，包含 1 个路径。", files: [], snapshot: opened.snapshot });
    renderPanel();
    expect(await screen.findByText("可以合并，没有冲突")).toBeTruthy();
    // 审阅区默认先看文件的最终结果；提交列表在第二页，可逐条点开查看明细。
    expect(screen.getByRole("listbox", { name: "将带入的文件" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("tab", { name: /提交/ }));
    expect(screen.getByRole("listbox", { name: "将带入的提交" }).textContent).toContain("加上登录页");
    // 分叉时只在「创建合并提交」与「变基」里选，快进不作为选项出现。
    expect(screen.getByRole("radio", { name: /创建合并提交/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: /快进/ })).toBeNull();
    // 合并说明默认只显示一行摘要，要改时再展开成输入框。
    expect(screen.queryByRole("textbox", { name: "合并说明" })).toBeNull();
    expect(document.querySelector(".merge-message-preview")?.textContent).toBe("Merge branch 'feature' into main");
    await fireEvent.click(screen.getByRole("button", { name: "编辑合并说明" }));
    const input = screen.getByRole("textbox", { name: "合并说明" }) as HTMLInputElement;
    expect(input.value).toBe("Merge branch 'feature' into main");
    expect(startMerge).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "合并到 main" }));
    await vi.waitFor(() => expect(completeMerge).toHaveBeenCalledWith("/repo", "Merge branch 'feature' into main", 6, 1));
    expect(startMerge).toHaveBeenCalledWith("/repo", "feature", null, "merge", 5, 1);
    expect(await screen.findByText("已把 feature 合并到 main")).toBeTruthy();
  });

  it("变基先确认将改写当前分支，取消不开始", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockResolvedValue(previewOf({ source: "origin/main", target: "main" }));
    renderPanel({ initialMode: "rebase", initialSource: "origin/main", initialTarget: "main" });
    const radio = await screen.findByRole("radio", { name: /变基/ });
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText(/将改写当前分支/).length).toBeGreaterThan(0);
    expect(startMerge).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "变基并改写当前分支" }));
    const confirm = await screen.findByRole("dialog", { name: "确认变基" });
    expect(confirm.textContent).toContain("将改写当前分支");
    await fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(startMerge).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "确认变基" })).toBeNull();
    startMerge.mockResolvedValue(session({ generation: 6, operation: "none", rebased: true, snapshot: opened.snapshot }));
    await fireEvent.click(screen.getByRole("button", { name: "变基并改写当前分支" }));
    await fireEvent.click(within(await screen.findByRole("dialog", { name: "确认变基" })).getByRole("button", { name: "确认变基" }));
    await vi.waitFor(() => expect(startMerge).toHaveBeenCalledWith("/repo", "origin/main", null, "rebase", 5, 1));
    expect(await screen.findByText(/远程不变，没有推送/)).toBeTruthy();
  });

  it("目标不是当前分支时不能开始变基", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockImplementation(async (_repo: string, source: string, target: string | null) =>
      previewOf({ source, target: target ?? "main", needsSwitch: target !== null }),
    );
    renderPanel({ initialMode: "rebase", initialSource: "main", initialTarget: "feature" });
    const start = await screen.findByRole("button", { name: "变基并改写当前分支" });
    await vi.waitFor(() => expect(start.getAttribute("title")).toContain("变基只会改写当前分支"));
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(startMerge).not.toHaveBeenCalled();
  });

  it("继续变基遇到新冲突时重新读取，不算完成", async () => {
    const paused = session({
      generation: 8,
      operation: "rebase",
      canAbort: true,
      canContinue: false,
      unresolved: 1,
      conflicts: [{ path: "b.txt", kind: "text", summary: "文本" }],
      note: "这次继续又遇到冲突，不能算完成。不能跳过。",
    });
    mergeSession.mockResolvedValueOnce(
      session({
        operation: "rebase",
        canAbort: true,
        canContinue: true,
        unresolved: 0,
        source: "main",
        note: "可以继续。不能跳过。",
      }),
    );
    completeMerge.mockRejectedValue({ code: "sequencer_paused", message: "这次继续又遇到冲突，不能算完成。不能跳过。", generation: 8 });
    mergeSession.mockResolvedValueOnce(paused);
    const onFailure = vi.fn();
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot: () => {},
      onGeneration: () => {},
      onFailure,
      onNotice: () => {},
      onOpenStash: () => {},
    });
    await fireEvent.click(await screen.findByRole("button", { name: "继续变基" }));
    await vi.waitFor(() => expect(completeMerge).toHaveBeenCalledWith("/repo", expect.any(String), 4, 1, "rebase"));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "继续变基" })).toBeTruthy();
    expect((await screen.findByRole("button", { name: "继续变基" })).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/远程不变，没有推送/)).toBeNull();
    expect(screen.queryByRole("button", { name: /跳过/ })).toBeNull();
  });

  it("拣选可以继续，不提供跳过", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "cherry-pick",
        canAbort: true,
        canContinue: true,
        unresolved: 0,
        note: "正在拣选（cherry-pick）。可以继续。不能跳过。",
      }),
    );
    completeMerge.mockResolvedValue({ oid: "d".repeat(40), generation: 7, summary: "已继续拣选。没有推送。", files: [], snapshot: opened.snapshot });
    mergeSession.mockResolvedValueOnce(
      session({
        operation: "cherry-pick",
        canAbort: true,
        canContinue: true,
        unresolved: 0,
        note: "正在拣选（cherry-pick）。可以继续。不能跳过。",
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
    expect(screen.queryByRole("button", { name: /跳过/ })).toBeNull();
    await fireEvent.click(await screen.findByRole("button", { name: "继续拣选" }));
    await vi.waitFor(() => expect(completeMerge).toHaveBeenCalled());
    expect(screen.queryByRole("textbox", { name: "合并说明" })).toBeNull();
    expect(screen.getByRole("button", { name: "中止拣选" })).toBeTruthy();
  });

  it("把当前分支合并到另一个分支：目标可选，开始时由后端先切换", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockImplementation(async (_repo: string, source: string, target: string | null) =>
      previewOf({ source, target: target ?? "main", needsSwitch: target !== null, current: "main", outgoing: 0, fastForward: true }),
    );
    startMerge.mockResolvedValue(
      session({ generation: 6, operation: "none", target: "feature", switchedFrom: "main", fastForwarded: true }),
    );
    renderPanel({ initialTarget: "feature" });
    // 从「把当前分支合并到此分支」进入：来源默认是当前分支，目标是所选分支。
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledWith("/repo", "main", "feature", 4, 1));
    expect(await screen.findByText(/开始时会先切换到 feature/)).toBeTruthy();
    // 目标没有自己的新提交：只能快进，方式选择和合并说明都不出现，主按钮直接就是快进。
    expect(await screen.findByText("可以快进，没有冲突")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "合并方式" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.querySelector(".merge-message-preview")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "快进 feature" }));
    await vi.waitFor(() => expect(startMerge).toHaveBeenCalledWith("/repo", "main", "feature", "ff-only", 5, 1));
    expect(await screen.findByText("已把 feature 快进到 main")).toBeTruthy();
    expect(screen.getByRole("button", { name: "切回 main" })).toBeTruthy();
  });

  it("交换方向后重新预览；远程分支作来源时不能交换", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockImplementation(async (_repo: string, source: string, target: string | null) =>
      previewOf({ source, target: target ?? "main", needsSwitch: target !== null }),
    );
    renderPanel({ initialSource: "origin/main" });
    await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledWith("/repo", "origin/main", null, 4, 1));
    expect(screen.getByRole("button", { name: "交换来源和目标" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "来源分支" }));
    const list = screen.getByRole("listbox", { name: "来源分支" });
    await fireEvent.click(within(list).getByText("feature"));
    await vi.waitFor(() => expect(mergePreview).toHaveBeenLastCalledWith("/repo", "feature", null, 4, 1));
    await fireEvent.click(screen.getByRole("button", { name: "交换来源和目标" }));
    await vi.waitFor(() => expect(mergePreview).toHaveBeenLastCalledWith("/repo", "main", "feature", 4, 1));
  });

  it("目标已包含来源时明确提示不需要合并", async () => {
    mergeSession.mockResolvedValue(session());
    branchState.mockResolvedValue(twoBranches);
    mergePreview.mockResolvedValue(
      previewOf({ canStart: false, blocker: "up_to_date", upToDate: true, incoming: 0, commits: [], files: [], filesTotal: 0, note: "main 已经包含 feature 的全部提交，不需要合并。" }),
    );
    renderPanel();
    expect(await screen.findByText("已经是最新，不需要合并")).toBeTruthy();
    expect(screen.getByText(/已经包含 feature 的全部提交/)).toBeTruthy();
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

  it("标记冲突后保留有效快照并允许完成合并", async () => {
    const initial = session({
      operation: "merge",
      canAbort: true,
      unresolved: 1,
      conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
      note: "还有 1 个未解决冲突。",
    });
    const resolved = session({
      generation: 5,
      operation: "merge",
      canContinue: true,
      canAbort: true,
      unresolved: 0,
      conflicts: [],
      note: "冲突已全部标记。",
    });
    mergeSession.mockResolvedValue(initial);
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
    resolveConflict.mockResolvedValue(resolved);
    const onSnapshot = vi.fn();
    const onFailure = vi.fn();
    render(MergePanel, {
      opened,
      disabled: false,
      nextId: () => 1,
      onSnapshot,
      onGeneration: () => {},
      onFailure,
      onNotice: () => {},
      onOpenStash: () => {},
    });
    await fireEvent.click(await screen.findByRole("button", { name: "文本冲突 file.txt" }));
    await fireEvent.click(await screen.findByRole("button", { name: "标记编辑结果" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "完成合并" }).hasAttribute("disabled")).toBe(false));
    expect(resolveConflict).toHaveBeenCalledWith("/repo", "file.txt", "text", "both\n", 4, 1);
    expect(onSnapshot).toHaveBeenCalledWith(resolved.snapshot);
    expect(onFailure).not.toHaveBeenCalled();
    expect(screen.getByText("所有冲突都已标记")).toBeTruthy();
  });

  it("快捷填入只编辑结果，明确标记后才写入", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "merge",
        canAbort: true,
        unresolved: 1,
        conflicts: [{ path: "file.txt", kind: "text", summary: "文本" }],
      }),
    );
    conflictView.mockResolvedValue({
      generation: 4,
      path: "file.txt",
      kind: "text",
      editable: true,
      ours: { present: true, binary: false, truncated: false, text: "ours\n", summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: "theirs\n", summary: "另一侧" },
      result: { present: true, binary: false, truncated: false, text: "ours\n", summary: "结果" },
      note: "可以编辑合并结果。",
    });
    resolveConflict.mockReset();
    resolveConflict.mockResolvedValue(session({ operation: "merge", unresolved: 0, conflicts: [] }));
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
    await fireEvent.click(await screen.findByRole("button", { name: "保留双方" }));
    expect(document.querySelectorAll(".three-way-pane")).toHaveLength(3);
    // 编辑栏不折行：长行靠横向滚动看完，WebKit 只认 wrap="off"。
    expect(document.querySelector(".three-way-pane textarea")?.getAttribute("wrap")).toBe("off");
    expect(screen.getByRole("region", { name: "当前分支版本" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "来源分支版本" })).toBeTruthy();
    expect(resolveConflict).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "合并结果" }) as HTMLTextAreaElement).value).toBe("ours\ntheirs\n");
    await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledWith("/repo", "file.txt", "text", "ours\ntheirs\n", 4, 1));
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
    await fireEvent.click(screen.getByRole("button", { name: /个文件的修改$/ }));
    expect(discardChanges).toHaveBeenLastCalledWith("/repo", ["keep.txt"], true, 4, 2);
  });

  it("几千个文件的放弃清单只渲染视口附近的行，全选后一次提交全部所选", async () => {
    const paths = Array.from({ length: 3000 }, (_, index) => `src/generated/file-${index}.ts`);
    const many = {
      ...opened,
      snapshot: {
        ...opened.snapshot,
        files: paths.map((path) => ({ path, originalPath: null, staged: "none" as const, unstaged: "modified" as const, untracked: false, unmerged: false })),
      },
    };
    discardChanges.mockResolvedValueOnce({
      generation: 4,
      wrote: false,
      boundary: "确认只影响所选文件。",
      snapshot: many.snapshot,
      files: paths.map((path) => ({
        path,
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        impact: "未暂存的修改会回到当前提交。",
        recovery: "放弃后 Git 不保留这份未提交内容。",
      })),
    });
    discardChanges.mockResolvedValueOnce({ generation: 5, wrote: true, boundary: "", snapshot: opened.snapshot, files: paths.map((path) => ({ path })) });
    render(RecoveryActions, {
      opened: many,
      disabled: false,
      nextId: () => 2,
      onSnapshot: () => {},
      onFailure: () => {},
      onNotice: () => {},
      onMerge: () => {},
    });
    await fireEvent.click(screen.getByRole("button", { name: discardActionLabel() }));
    const group = await screen.findByRole("group", { name: "要放弃的文件" });
    expect(group.querySelectorAll("label.list-row").length).toBeLessThan(60);
    expect(group.textContent).toContain("1 / 3000 个文件已选择");
    await fireEvent.click(within(group).getByRole("button", { name: "全选" }));
    expect(group.textContent).toContain("3000 / 3000 个文件已选择");
    await fireEvent.click(screen.getByRole("button", { name: "放弃 3000 个文件的修改" }));
    await vi.waitFor(() => expect(discardChanges).toHaveBeenLastCalledWith("/repo", paths, true, 4, 2));
  });

  it("放弃写入在途时不能取消：Esc、关闭和取消都不生效，结果落地后才收起", async () => {
    discardChanges.mockReset();
    discardChanges.mockResolvedValueOnce({
      generation: 4,
      wrote: false,
      boundary: "取消不写入。",
      files: [{ path: "keep.txt", originalPath: null, staged: "none", unstaged: "modified", untracked: false, impact: "回到当前提交。", recovery: "不能找回。" }],
      snapshot: opened.snapshot,
    });
    let finish: (value: unknown) => void = () => {};
    discardChanges.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
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
    await screen.findByText(/取消不写入/);
    await fireEvent.click(screen.getByRole("button", { name: /个文件的修改$/ }));
    await tick();
    expect(screen.getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "关闭对话框" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog"), "结果未定时不收起").toBeTruthy();

    finish({ generation: 5, wrote: true, boundary: "", files: [], snapshot: opened.snapshot });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

  it("撤销的确认按钮是危险语义并列出受影响提交", async () => {
    undoCommit.mockResolvedValue({
      generation: 4,
      code: "undo_ready",
      eligible: true,
      wrote: false,
      headOid: "a".repeat(40),
      parentOid: "b".repeat(40),
      summary: "修复登录跳转",
      reason: "这个提交还没有推送，可以撤销。",
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
    const confirm = await screen.findByRole("button", { name: "确认撤销提交" });
    expect(confirm.className).toContain("btn-danger");
    expect(screen.getByText("修复登录跳转")).toBeTruthy();
    expect(screen.getByText("aaaaaaa")).toBeTruthy();
    expect(undoCommit).toHaveBeenCalledWith("/repo", "a".repeat(40), false, 4, 3);
  });
});

describe("合并任务 modal", () => {
  beforeEach(() => {
    mergeSession.mockReset();
    branchState.mockReset();
    abortMerge.mockReset();
    branchState.mockResolvedValue({ generation: 4, branches: [], snapshot: opened.snapshot });
  });

  function renderMergeModal() {
    const onClose = vi.fn();
    render(MergeModal, {
      props: {
        opened,
        disabled: false,
        nextId: () => 1,
        onClose,
        onSnapshot: () => {},
        onGeneration: () => {},
        onFailure: () => {},
        onNotice: () => {},
        onOpenStash: () => {},
      },
    });
    return { onClose };
  }

  it("中止后冲突界面完全移除，不和起始界面并存", async () => {
    mergeSession.mockResolvedValueOnce(
      session({ operation: "merge", canAbort: true, unresolved: 1, source: "feature", conflicts: [] }),
    );
    mergeSession.mockResolvedValue(session());
    abortMerge.mockResolvedValue({ generation: 5, wrote: false, paths: [], note: "将恢复。", snapshot: opened.snapshot });
    renderMergeModal();
    await fireEvent.click(await screen.findByRole("button", { name: "中止合并" }));
    expect(document.querySelector(".mp-body")).toBeTruthy();
    await fireEvent.click(await screen.findByRole("button", { name: "中止合并" }));
    await vi.waitFor(() => expect(document.querySelector(".mp-body")).toBeNull());
    expect(document.querySelector(".mp-head"), "标题行里的路由也一起移除").toBeNull();
    expect(document.querySelector(".mp-head-host"), "常驻节点留在落点").toBeTruthy();
  });

  it("还原会话的窗口标题与冲突底部提示显示还原语义", async () => {
    clearConflictDrafts();
    mergeSession.mockResolvedValueOnce(
      session({
        operation: "revert",
        canAbort: true,
        canContinue: true,
        unresolved: 1,
        conflicts: [{ path: "revert.txt", kind: "text", summary: "文本" }],
        note: "正在还原（revert）。还有 1 个未解决冲突。",
      }),
    );
    conflictView.mockResolvedValue({
      generation: 4,
      path: "revert.txt",
      kind: "text",
      editable: true,
      ours: { present: true, binary: false, truncated: false, text: "ours\n", summary: "当前" },
      theirs: { present: true, binary: false, truncated: false, text: "theirs\n", summary: "被还原的提交" },
      result: {
        present: true,
        binary: false,
        truncated: false,
        text: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
        summary: "结果",
      },
      note: "可以编辑还原冲突。",
    });
    renderMergeModal();
    expect(await screen.findByRole("dialog", { name: "还原冲突" })).toBeTruthy();
    await fireEvent.click(await screen.findByRole("button", { name: "采用当前" }));
    expect(await screen.findByText(/标记后可以继续还原/)).toBeTruthy();
    expect(screen.queryByText(/标记后可以完成合并/)).toBeNull();
  });

  it("还原暂停会话的窗口标题显示还原提交", async () => {
    mergeSession.mockResolvedValueOnce(
      session({
        operation: "revert",
        canAbort: true,
        canContinue: false,
        unresolved: 0,
        conflicts: [],
        note: "还原序列停在后续目标，无法继续应用。",
      }),
    );
    renderMergeModal();
    expect(await screen.findByRole("dialog", { name: "还原提交" })).toBeTruthy();
  });

  it("继续还原完成后的窗口标题与面板标签保持还原语义", async () => {
    const live = session({
      operation: "revert",
      canAbort: true,
      canContinue: true,
      unresolved: 0,
      conflicts: [],
      note: "正在还原（revert）。冲突已全部标记，可以继续。",
    });
    mergeSession.mockResolvedValueOnce(live);
    mergeSession.mockResolvedValue(session());
    completeMerge.mockResolvedValue({
      oid: "d".repeat(40),
      generation: 7,
      summary: "已继续还原，后续目标已处理。没有推送。",
      files: [],
      snapshot: opened.snapshot,
    });
    renderMergeModal();
    await fireEvent.click(await screen.findByRole("button", { name: "继续还原" }));
    expect(await screen.findByText("已继续还原")).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: "还原提交" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "合并分支" })).toBeNull();
    expect(document.querySelector('[data-panel="merge"]')?.getAttribute("aria-label")).toBe("还原提交");
  });

  it("完成后冲突界面完全移除，只剩完成页", async () => {
    const live = session({ operation: "merge", canAbort: true, canContinue: true, unresolved: 0, source: "feature", conflicts: [] });
    mergeSession.mockResolvedValueOnce(live);
    mergeSession.mockResolvedValue(session());
    completeMerge.mockResolvedValue({ oid: "d".repeat(40), generation: 7, summary: "已完成。", files: [], snapshot: opened.snapshot });
    renderMergeModal();
    const input = await screen.findByRole("textbox", { name: "合并说明" });
    await fireEvent.input(input, { target: { value: "Merge feature" } });
    await fireEvent.click(screen.getByRole("button", { name: "完成合并" }));
    await vi.waitFor(() => expect(document.querySelector(".merge-done")).toBeTruthy());
    expect(document.querySelector(".mp-body")).toBeNull();
    expect(document.querySelector(".mp-head")).toBeNull();
  });

  it("有未解决冲突时底部只留一句进度和原因，全部解决后才出现合并说明", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "merge",
        canAbort: true,
        unresolved: 1,
        source: "feature",
        conflicts: [{ path: "a.txt", kind: "both_modified", stages: [] } as never],
      }),
    );
    renderMergeModal();
    const foot = await vi.waitFor(() => {
      const node = document.querySelector<HTMLElement>(".mp-foot .mp-status");
      expect(node).toBeTruthy();
      return node!;
    });
    expect(foot.textContent).toContain("已解决 0 / 1 个文件，还有 1 个未解决冲突，不能完成合并");
    expect(document.querySelectorAll(".mp-foot .mp-status")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "合并说明" })).toBeNull();
    expect(document.querySelector(".merge-progress"), "还没有进度时不留空进度槽").toBeNull();
  });

  it("路由和中止并入标题行，排在标题之后；note 收缩不影响路由", async () => {
    mergeSession.mockResolvedValue(
      session({ operation: "merge", canAbort: true, unresolved: 1, conflicts: [], note: "说明" }),
    );
    renderMergeModal();
    const abort = await screen.findByRole("button", { name: "中止合并" });
    const head = document.querySelector<HTMLElement>(".modal-head")!;
    expect(head.contains(abort)).toBe(true);
    expect(head.querySelector(".modal-titles + .mp-head-slot .mp-head .merge-route")).toBeTruthy();
    expect(document.querySelector(".modal-body .mp-head"), "正文里不留第二条工具行").toBeNull();
    expect(document.querySelector("[data-panel='merge']"), "面板仍在正文").toBeTruthy();
  });

  it("以单一任务 modal 打开，未解决冲突时不能完成合并", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "merge",
        canAbort: true,
        unresolved: 1,
        conflicts: [],
        note: "还有 1 个未解决冲突，不能完成。",
      }),
    );
    const { onClose } = renderMergeModal();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("merge");
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
    const complete = await screen.findByRole("button", { name: "完成合并" });
    expect(complete.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/还有 1 个未解决冲突，不能完成合并/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("进度、下一处、标记和完成合并收在同一条底部，文件头并入工具条", async () => {
    mergeSession.mockResolvedValue(
      session({
        operation: "merge",
        canAbort: true,
        unresolved: 1,
        conflicts: [{ path: "src/file.txt", kind: "text", summary: "文本" }],
        note: "还有 1 个未解决冲突，不能完成。",
      }),
    );
    conflictView.mockResolvedValue({
      generation: 4,
      path: "src/file.txt",
      kind: "text",
      editable: true,
      ours: { present: true, binary: false, truncated: false, text: "ours\n", summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: "theirs\n", summary: "另一侧" },
      result: { present: true, binary: false, truncated: false, text: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n", summary: "结果" },
      note: "可以编辑合并结果。",
    });
    renderMergeModal();
    const mark = await screen.findByRole("button", { name: "标记编辑结果" });
    const foot = document.querySelector<HTMLElement>(".mp-foot");
    expect(foot?.contains(mark)).toBe(true);
    expect(within(foot as HTMLElement).getByRole("button", { name: "完成合并" }).hasAttribute("disabled")).toBe(true);
    expect(within(foot as HTMLElement).getByText(/还有 1 个未解决冲突，不能完成合并/)).toBeTruthy();
    expect(within(foot as HTMLElement).getByRole("button", { name: "下一处冲突" })).toBeTruthy();
    expect(within(foot as HTMLElement).getByRole("button", { name: "下一处未处理" })).toBeTruthy();
    expect(within(foot as HTMLElement).getByText(/个文件/)).toBeTruthy();
    expect(document.querySelector(".mp-head .mp-progress-text")).toBeNull();

    const toolbar = document.querySelector<HTMLElement>(".cr-toolbar");
    const title = within(toolbar as HTMLElement).getByRole("heading", { name: "file.txt" });
    expect(title.getAttribute("title")).toContain("src/file.txt");
    expect(title.getAttribute("title")).toContain("可以编辑合并结果。");
    expect(document.querySelector(".conflict-editor-head")).toBeNull();
    expect(document.querySelectorAll(".cr-foot")).toHaveLength(1);
  });

  describe("冲突跨文件跳转", () => {
    const conflict = (name: string) => `<<<<<<< HEAD\n${name} ours\n=======\n${name} theirs\n>>>>>>> main\n`;
    const textView = (path: string, hunks = 1) => ({
      generation: 4,
      path,
      kind: "text",
      editable: true,
      ours: { present: true, binary: false, truncated: false, text: "ours\n", summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: "theirs\n", summary: "另一侧" },
      result: {
        present: true,
        binary: false,
        truncated: false,
        text: Array.from({ length: hunks }, (_, index) => conflict(`${path} ${index}`)).join("mid\n"),
        summary: "结果",
      },
      note: "可以编辑合并结果。",
    });
    const binaryView = (path: string) => ({
      generation: 4,
      path,
      kind: "binary",
      editable: false,
      ours: { present: true, binary: true, truncated: false, text: null, summary: "本地是二进制" },
      theirs: { present: true, binary: true, truncated: false, text: null, summary: "另一侧是二进制" },
      result: { present: true, binary: true, truncated: false, text: null, summary: "结果是二进制" },
      note: "不能按文本合并。",
    });

    function setup(paths: string[], views: Record<string, unknown> = {}) {
      clearConflictDrafts();
      mergeSession.mockResolvedValue(
        session({
          operation: "merge",
          canAbort: true,
          unresolved: paths.length,
          conflicts: paths.map((path) => ({ path, kind: "text", summary: "文本" })),
        }),
      );
      conflictView.mockImplementation(async (_repo: string, path: string) => views[path] ?? textView(path));
      const onNotice = vi.fn();
      render(MergeModal, {
        props: {
          opened,
          disabled: false,
          nextId: () => 1,
          onClose: () => {},
          onSnapshot: () => {},
          onGeneration: () => {},
          onFailure: () => {},
          onNotice,
          onOpenStash: () => {},
        },
      });
      return { onNotice };
    }
    const title = (name: string) => screen.findByRole("heading", { name });
    const label = () => document.querySelector(".mp-foot .cr-nav-label")?.textContent?.replace(/\s+/g, " ").trim();
    const stream = () => screen.getByRole("region", { name: "逐处处理冲突" });
    const next = () => fireEvent.click(screen.getByRole("button", { name: "下一处未处理" }));

    it("文件环上找下一个未处理：跳过已选完的，绕回，没有时返回 null", () => {
      const paths = ["a", "b", "c"];
      const pending = (list: string[]) => (path: string) => list.includes(path);
      expect(adjacentPendingFile(paths, "a", 1, pending(["b", "c"]))).toBe("b");
      expect(adjacentPendingFile(paths, "a", 1, pending(["c"]))).toBe("c");
      expect(adjacentPendingFile(paths, "c", 1, pending(["a"])), "绕回不甩下未处理文件").toBe("a");
      expect(adjacentPendingFile(paths, "a", -1, pending(["b", "c"]))).toBe("c");
      expect(adjacentPendingFile(paths, "b", -1, pending(["a", "c"]))).toBe("a");
      expect(adjacentPendingFile(paths, "a", 1, pending(["a"]))).toBeNull();
      expect(adjacentPendingFile(paths, "gone", 1, pending(["a"]))).toBe("a");
      expect(adjacentPendingFile(paths, "gone", -1, pending(["c"]))).toBe("c");
      expect(adjacentPendingFile([], "a", 1, () => true)).toBeNull();
    });

    it("只有 1 处冲突时，下一处未处理切到下一个文件的首处，焦点在目标冲突上，显示文件序号", async () => {
      setup(["a.txt", "b.txt"], { "b.txt": textView("b.txt", 2) });
      await title("a.txt");
      expect(label()).toBe("文件 1 / 2· 第 1 / 1 处");
      await next();
      await title("b.txt");
      await vi.waitFor(() => expect(document.activeElement).toBe(stream()));
      expect(label()).toBe("文件 2 / 2· 第 1 / 2 处");
    });

    it("上一处跨到上一个文件的末处；F7 与 Alt 键走同一逻辑", async () => {
      setup(["a.txt", "b.txt"], { "a.txt": textView("a.txt", 3) });
      await title("a.txt");
      await fireEvent.keyDown(stream(), { key: "ArrowDown", altKey: true });
      await fireEvent.keyDown(stream(), { key: "F7" });
      expect(label()).toContain("第 3 / 3 处");
      await fireEvent.keyDown(stream(), { key: "F7" });
      await title("b.txt");
      await vi.waitFor(() => expect(document.activeElement).toBe(stream()));
      await fireEvent.keyDown(stream(), { key: "F7", shiftKey: true });
      await title("a.txt");
      await vi.waitFor(() => expect(label()).toContain("第 3 / 3 处"));
    });

    it("跨文件后回来，已选的草稿还在", async () => {
      setup(["a.txt", "b.txt"], { "a.txt": textView("a.txt", 2) });
      await title("a.txt");
      await fireEvent.keyDown(stream(), { key: "2" });
      expect(label()).toContain("第 2 / 2 处");
      await fireEvent.keyDown(stream(), { key: "F7" });
      await title("b.txt");
      await fireEvent.keyDown(stream(), { key: "F7", shiftKey: true });
      await title("a.txt");
      await vi.waitFor(() => expect(document.querySelectorAll('[data-hunk-state="resolved"]')).toHaveLength(1));
      expect(label(), "落在没选的那一处").toContain("第 2 / 2 处");
      expect(screen.getByRole("button", { name: /a\.txt/ }).textContent).toContain("1/2");
    });

    it("选完的文件被跳过，二进制文件不被跳过且按文件停留", async () => {
      setup(["a.txt", "b.txt", "c.png", "d.txt"], { "c.png": binaryView("c.png") });
      await title("a.txt");
      await next();
      await title("b.txt");
      await fireEvent.keyDown(stream(), { key: "1" });
      await next();
      await vi.waitFor(() => expect(document.querySelector(".conflict-editor-head h2")?.textContent).toBe("c.png"));
      await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector(".conflict-editor")));
      expect(label()).toBe("文件 3 / 4");
      await fireEvent.keyDown(document.activeElement as HTMLElement, { key: "F7" });
      await title("d.txt");
      await fireEvent.keyDown(stream(), { key: "F7" });
      await title("a.txt");
      await fireEvent.keyDown(stream(), { key: "F7" });
      await vi.waitFor(() => expect(document.querySelector(".conflict-editor-head h2")?.textContent).toBe("c.png"));
    });

    it("二进制文件的底部按钮可以离开，往回也不跳过未处理文件", async () => {
      setup(["a.txt", "c.png"], { "c.png": binaryView("c.png") });
      await title("a.txt");
      await next();
      await vi.waitFor(() => expect(document.querySelector(".conflict-editor-head h2")?.textContent).toBe("c.png"));
      await fireEvent.click(await screen.findByRole("button", { name: "上一处冲突" }));
      await title("a.txt");
    });

    it("全部选好后不再跳转，提示标记后可以完成合并", async () => {
      const { onNotice } = setup(["a.txt", "b.txt"]);
      await title("a.txt");
      await fireEvent.keyDown(stream(), { key: "1" });
      await next();
      await title("b.txt");
      await fireEvent.keyDown(stream(), { key: "1" });
      expect(screen.queryByRole("button", { name: "下一处未处理" })).toBeNull();
      conflictView.mockClear();
      await fireEvent.keyDown(stream(), { key: "F7" });
      await fireEvent.keyDown(stream(), { key: "F7", shiftKey: true });
      await tick();
      expect(conflictView, "不循环空转").not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenLastCalledWith("全部冲突都已处理，把这 2 个文件标记为已解决后可以完成合并。");
    });

    it("只剩一个不能逐处处理的文件时说明要明确标记", async () => {
      const { onNotice } = setup(["a.txt", "c.png"], { "c.png": binaryView("c.png") });
      await title("a.txt");
      await fireEvent.keyDown(stream(), { key: "1" });
      await next();
      await vi.waitFor(() => expect(document.querySelector(".conflict-editor-head h2")?.textContent).toBe("c.png"));
      expect(screen.queryByRole("button", { name: "下一处未处理" })).toBeNull();
      await fireEvent.click(screen.getByRole("button", { name: "下一处冲突" }));
      expect(onNotice).toHaveBeenLastCalledWith("没有其他未处理的文件。明确标记这个文件后可以完成合并。");
    });

    it("标记后自动到下一个未处理文件，序号算上已解决的", async () => {
      setup(["a.txt", "b.txt"]);
      await title("a.txt");
      resolveConflict.mockResolvedValue(
        session({ operation: "merge", canAbort: true, unresolved: 1, generation: 5, conflicts: [{ path: "b.txt", kind: "text", summary: "文本" }] }),
      );
      await fireEvent.keyDown(stream(), { key: "1" });
      await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
      await title("b.txt");
      await vi.waitFor(() => expect(label()).toBe("文件 2 / 2· 第 1 / 1 处"));
    });

    it("整文件编辑的草稿在切换后保留", async () => {
      setup(["a.txt", "b.txt"]);
      await title("a.txt");
      await fireEvent.click(screen.getByRole("button", { name: /整文件编辑/ }));
      await fireEvent.input(screen.getByRole("textbox", { name: "合并结果" }), { target: { value: "hand written\n" } });
      await next();
      await title("b.txt");
      await fireEvent.keyDown(stream(), { key: "F7" });
      await title("a.txt");
      const area = (await screen.findByRole("textbox", { name: "合并结果" })) as HTMLTextAreaElement;
      expect(area.value).toBe("hand written\n");
      await vi.waitFor(() => expect(document.activeElement).toBe(area));
    });
  });

  it("中止合并列出受影响路径，取消不写入", async () => {
    mergeSession.mockResolvedValue(
      session({ operation: "merge", canAbort: true, canContinue: true, unresolved: 0, conflicts: [], note: "冲突已全部标记。" }),
    );
    abortMerge.mockResolvedValue({
      generation: 4,
      wrote: false,
      paths: ["a.txt", "b.txt"],
      stashOids: [],
      note: "将撤销 2 个文件的合并编辑。取消不会写入。",
      snapshot: opened.snapshot,
    });
    renderMergeModal();
    await fireEvent.click(await screen.findByRole("button", { name: "中止合并" }));
    await screen.findByRole("dialog", { name: "中止合并" });
    const impact = screen.getByRole("list", { name: "受影响的路径" }).textContent ?? "";
    expect(impact).toContain("a.txt");
    expect(impact).toContain("b.txt");
    // 确认层叠在合并任务 modal 之上，任务 modal 仍只有一个。
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "中止合并" }).className).toContain("btn-danger");
    expect(abortMerge).toHaveBeenCalledWith("/repo", false, 4, 1);

    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(abortMerge).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "中止合并" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "中止合并" }));
    await screen.findByRole("list", { name: "受影响的路径" });
    await fireEvent.click(screen.getByRole("button", { name: "中止合并" }));
    await vi.waitFor(() => expect(abortMerge).toHaveBeenCalledWith("/repo", true, 4, 1));
  });
});

describe("任务 modal（设置 / 提交范围 / 发布）", () => {
  const unavailableGit = {
    available: false,
    path: null,
    version: null,
    overridden: false,
    belowBaseline: false,
    message: "没有找到 Git",
  };

  it("设置 modal 同时含外观三态与运行环境诊断", async () => {
    const onTheme = vi.fn();
    const onRedetect = vi.fn();
    render(SettingsModal, {
      props: {
        theme: "dark",
        git: unavailableGit,
        disabled: false,
        onClose: () => {},
        onTheme,
        onRedetect,
        onChooseGit: () => {},
        onClearGit: () => {},
      },
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("settings");
    const appearance = screen.getByRole("group", { name: "外观" });
    const options = within(appearance).getAllByRole("button");
    expect(options.map((option) => option.textContent?.trim())).toEqual(["浅色", "深色", "跟随系统"]);
    expect(options[1].getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(options[2]);
    expect(onTheme).toHaveBeenCalledWith("system");

    const diagnostics = screen.getByRole("list", { name: "Git 诊断" }).textContent ?? "";
    expect(diagnostics).toContain("没有找到 Git");
    expect(screen.getByText("Git 不可用")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(onRedetect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "选择 Git" })).toBeTruthy();
    const note = screen.getByText("WebView2 与安装说明").closest("details") as HTMLDetailsElement;
    expect(note.textContent).toContain("WebView2");
    expect(note.textContent).toContain("Git");
  });

  describe("运行环境说明按需显示（R11）", () => {
    const healthyGit = { available: true, path: "/usr/bin/git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" };
    const oldGit = { ...healthyGit, version: "2.30.0", belowBaseline: true, message: "Git 2.30.0 低于基线 2.48" };
    const open = (git: GitInfo | null) =>
      render(SettingsModal, {
        props: { theme: "dark", git, disabled: false, onClose: () => {}, onTheme: () => {}, onRedetect: () => {}, onChooseGit: () => {}, onClearGit: () => {} },
      });
    const noteOf = (container: HTMLElement) => container.querySelector<HTMLDetailsElement>('[data-settings-section="runtime"] details')!;

    it("Git 正常时说明收起，展开后才可见，状态是语义绿", async () => {
      const { container } = open(healthyGit);
      await screen.findByRole("dialog");
      const note = noteOf(container);
      expect(note.open, "默认收起").toBe(false);
      expect(screen.getByText("Git 可用").className).toContain("ok");
      expect(screen.getByRole("list", { name: "Git 诊断" }).textContent, "诊断列表只有状态").not.toContain("安装");
      expect(container.querySelector("textarea"), "说明不再是常驻文本框").toBeNull();
      note.open = true;
      expect(note.querySelectorAll("p").length).toBeGreaterThan(1);
    });

    it("Git 缺失时默认展开，低于基线时也展开并写明原因", async () => {
      const missing = open(unavailableGit);
      await screen.findByRole("dialog");
      expect(noteOf(missing.container).open, "缺失").toBe(true);
      expect(screen.getByText("Git 不可用").className).toContain("danger");
      missing.unmount();

      const below = open(oldGit);
      await screen.findByRole("dialog");
      expect(noteOf(below.container).open, "低于基线").toBe(true);
      expect(screen.getByRole("list", { name: "Git 诊断" }).textContent).toContain("低于基线 2.48");
      expect(screen.getByText("版本过低").className).toContain("warn");
      below.unmount();
    });

    it("尚未检测时不报不可用，也不展开说明", async () => {
      const { container } = open(null);
      await screen.findByRole("dialog");
      expect(noteOf(container).open).toBe(false);
      expect(screen.queryByText("Git 不可用")).toBeNull();
      expect(screen.getAllByText(/尚未检测/).length).toBeGreaterThan(0);
    });

    it("问题说明和操作排在长说明之前，语法高亮开关保留", async () => {
      const { container } = open(unavailableGit);
      await screen.findByRole("dialog");
      const redetect = screen.getByRole("button", { name: "重新检测" });
      const list = screen.getByRole("list", { name: "Git 诊断" });
      const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(list, redetect), "问题说明在操作之前").toBe(true);
      expect(follows(redetect, noteOf(container)), "操作在长说明之前").toBe(true);
      expect(screen.getByRole("checkbox", { name: /代码语法高亮/ })).toBeTruthy();
    });
  });

  it("传 section=runtime 时把焦点与分区锚点落在运行环境，不传时首屏不变", async () => {
    // 不传 section：与改动前逐字一致——首焦点是外观三态里的第一个按钮。
    const plain = render(SettingsModal, {
      props: {
        theme: "dark",
        git: unavailableGit,
        disabled: false,
        onClose: () => {},
        onTheme: () => {},
        onRedetect: () => {},
        onChooseGit: () => {},
        onClearGit: () => {},
      },
    });
    await screen.findByRole("dialog");
    const appearance = screen.getByRole("group", { name: "外观" });
    expect(within(appearance).getAllByRole("button")[0], "默认入口仍落在外观首屏").toBe(document.activeElement);
    const plainRuntime = plain.container.querySelector<HTMLElement>('[data-settings-section="runtime"]');
    expect(plainRuntime, "运行环境分区要有锚点").toBeTruthy();
    expect(plainRuntime!.hasAttribute("data-autofocus"), "默认入口不抢焦点").toBe(false);
    plain.unmount();

    // 传 section=runtime：Git 诊断入口打开的正是运行环境分区，焦点也落在那里。
    const focused = render(SettingsModal, {
      props: {
        theme: "dark",
        git: unavailableGit,
        disabled: false,
        section: "runtime",
        onClose: () => {},
        onTheme: () => {},
        onRedetect: () => {},
        onChooseGit: () => {},
        onClearGit: () => {},
      },
    });
    await screen.findByRole("dialog");
    const runtime = focused.container.querySelector<HTMLElement>('[data-settings-section="runtime"]');
    expect(runtime?.querySelector("h2")?.textContent).toBe("运行环境");
    expect(runtime!.tabIndex, "分区要能被程序聚焦（不可 Tab 命中）").toBe(-1);
    expect(runtime!.contains(document.activeElement), "焦点落在运行环境分区").toBe(true);
    // 分区内容与按钮行为没有变化
    expect(within(runtime as HTMLElement).getByRole("list", { name: "Git 诊断" }).textContent).toContain("没有找到 Git");
    expect(within(runtime as HTMLElement).getByRole("button", { name: "重新检测" })).toBeTruthy();
  });

  it("提交范围 modal 列出全部路径并显示总数", async () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/dir/file-${index}.ts`);
    render(ScopeModal, { props: { scopeLabel: "提交到 main · 40 个已暂存文件", paths, onClose: () => {} } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("scope");
    expect(screen.getByText(/40 个已暂存文件/)).toBeTruthy();
    expect(screen.getByText(/共 40 个文件/)).toBeTruthy();
    const list = screen.getByRole("list", { name: "本次提交的文件" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(40);
    // 全部路径都在可滚动容器里，而不是被截断成前 50 条之外的空清单。
    expect(list.style.maxHeight).not.toBe("");
    expect(list.textContent).toContain("src/dir/file-39.ts");
  });

  it("暂存区为空时显示空状态而不是空清单", async () => {
    render(ScopeModal, { props: { scopeLabel: "提交到 main · 暂存区是空的", paths: [], onClose: () => {} } });
    expect(await screen.findByText("暂存区是空的")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "本次提交的文件" })).toBeNull();
  });

  it("发布 modal 列出发布对象，确认前不推送", async () => {
    const onPublish = vi.fn();
    const onAssociate = vi.fn();
    render(PublishModal, {
      props: {
        branch: "feature/ui",
        upstream: null,
        remote: "origin",
        ahead: 3,
        disabled: false,
        onClose: () => {},
        onPublish,
        onAssociate,
      },
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("publish");
    const impact = screen.getByRole("list", { name: "发布对象" }).textContent ?? "";
    expect(impact).toContain("feature/ui");
    expect(impact).toContain("origin");
    expect(impact).toContain("待推送提交 · 3");
    expect(onPublish).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "发布分支" }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "只关联上游" }));
    expect(onAssociate).toHaveBeenCalledTimes(1);
  });

  it("发布进行中时发布入口不可用", async () => {
    render(PublishModal, {
      props: {
        branch: "feature/ui",
        upstream: "origin/feature/ui",
        remote: "origin",
        disabled: false,
        busy: "publish",
        onClose: () => {},
        onPublish: () => {},
      },
    });
    const publish = await screen.findByRole("button", { name: "发布分支" });
    expect(publish.hasAttribute("disabled")).toBe(true);
  });
});
