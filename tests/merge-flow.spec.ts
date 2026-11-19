import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conflictFileMenu, markerFreeText, mergeSteps, pushState, revealLabel } from "../src/lib/merge-flow";
import type { BranchInfo, MergeSession, OpenedRepository } from "../src/lib/types";

const mergeSession = vi.hoisted(() => vi.fn());
const branchState = vi.hoisted(() => vi.fn());
const mergePreview = vi.hoisted(() => vi.fn());
const conflictView = vi.hoisted(() => vi.fn());
const resolveConflict = vi.hoisted(() => vi.fn());
const completeMerge = vi.hoisted(() => vi.fn());
const openPath = vi.hoisted(() => vi.fn());
const revealPath = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: { mergeSession, branchState, mergePreview, conflictView, resolveConflict, completeMerge, openPath, revealPath },
}));

import MergePanel, { clearConflictDrafts } from "../src/lib/components/MergePanel.svelte";

const branch: BranchInfo = {
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
};

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 4,
  snapshot: { generation: 4, branch, files: [] },
  draft: "",
  watchDegraded: false,
};

function session(extra: Partial<MergeSession> = {}): MergeSession {
  return {
    generation: 4,
    operation: "merge",
    canContinue: true,
    canAbort: true,
    source: "feature",
    target: "main",
    headOid: "a".repeat(40),
    conflicts: [],
    unresolved: 0,
    note: "",
    snapshot: opened.snapshot,
    ...extra,
  };
}

const textSide = (text: string) => ({ present: true, binary: false, truncated: false, text, summary: "" });

function viewOf(path: string, result: string) {
  return {
    generation: 4,
    path,
    kind: "text",
    editable: true,
    ours: textSide("ours\n"),
    theirs: textSide("theirs\n"),
    result: textSide(result),
    note: "可以编辑合并结果。",
  };
}

describe("合并步骤", () => {
  it("选择阶段：预检确定没有冲突时把「解决冲突」标为跳过", () => {
    expect(mergeSteps({ operation: "none", finished: false }).map((step) => step.state)).toEqual(["current", "upcoming", "upcoming"]);
    expect(mergeSteps({ operation: "none", finished: false, expectConflicts: false })[1].state).toBe("skipped");
    expect(mergeSteps({ operation: "none", finished: false, expectConflicts: true })[1].state).toBe("upcoming");
  });

  it("进行中停在解决冲突；完成后按是否经历冲突标为完成或跳过", () => {
    expect(mergeSteps({ operation: "merge", finished: false }).map((step) => step.state)).toEqual(["done", "current", "upcoming"]);
    expect(mergeSteps({ operation: "none", finished: true, hadConflicts: true }).map((step) => step.state)).toEqual(["done", "done", "current"]);
    expect(mergeSteps({ operation: "none", finished: true }).map((step) => step.state)).toEqual(["done", "skipped", "current"]);
  });
});

describe("完成页推送状态", () => {
  it("领先上游时可以推送，一致时说明已推送", () => {
    expect(pushState(branch, "main", false)).toMatchObject({ kind: "ahead", canPush: true });
    expect(pushState({ ...branch, ahead: 0 }, "main", false)).toMatchObject({ kind: "pushed", canPush: false });
  });

  it("没有上游、目标不是当前分支或历史已改写时不提供推送", () => {
    expect(pushState({ ...branch, upstream: null }, "main", false)).toMatchObject({ kind: "no-upstream", canPush: false });
    expect(pushState(branch, "release", false)).toMatchObject({ kind: "elsewhere", canPush: false });
    expect(pushState(branch, "main", true)).toMatchObject({ kind: "rewritten", canPush: false });
  });
});

describe("冲突文件右键菜单", () => {
  const handlers = {
    open: vi.fn(),
    takeOurs: vi.fn(),
    takeTheirs: vi.fn(),
    markResolved: vi.fn(),
    openExternal: vi.fn(),
    reveal: vi.fn(),
    copyPath: vi.fn(),
  };
  const ids = (entries: ReturnType<typeof conflictFileMenu>) => entries.map((entry) => ("id" in entry ? entry.id : "|"));

  it("未解决的文件：打开、整份采用一侧、按工作区内容标记，再是查看类操作", () => {
    const entries = conflictFileMenu({ resolved: false, currentLabel: "main", incomingLabel: "feature", revealLabel: "在访达中显示" }, handlers);
    expect(ids(entries)).toEqual(["open", "|", "ours", "theirs", "mark", "|", "external", "reveal", "copy"]);
    const labels = entries.flatMap((entry) => ("label" in entry ? [entry.label] : []));
    expect(labels).toContain("整个文件采用当前（main）");
    expect(labels).toContain("整个文件采用来源（feature）");
  });

  it("已解决的文件只保留查看类操作，开头没有多余分隔线", () => {
    expect(ids(conflictFileMenu({ resolved: true, currentLabel: "main", incomingLabel: "feature" }, handlers))).toEqual(["external", "reveal", "copy"]);
  });

  it("写入进行中：写入类条目灰显并说明原因，查看类条目照常可用", () => {
    const entries = conflictFileMenu({ resolved: false, busyReason: "先等当前操作结束", currentLabel: "main", incomingLabel: "feature" }, handlers);
    const reason = (id: string) => entries.find((entry) => "id" in entry && entry.id === id) as { disabledReason?: string };
    expect(reason("ours").disabledReason).toBe("先等当前操作结束");
    expect(reason("mark").disabledReason).toBe("先等当前操作结束");
    expect(reason("copy").disabledReason).toBeUndefined();
  });

  it("按平台给出文件管理器的叫法；仍有冲突标记的内容不能直接标记", () => {
    expect(revealLabel("MacIntel")).toBe("在访达中显示");
    expect(revealLabel("Win32")).toBe("在文件管理器中显示");
    expect(markerFreeText("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n")).toBe(false);
    expect(markerFreeText("resolved\n")).toBe(true);
    expect(markerFreeText(null)).toBe(false);
  });
});

describe("合并面板：冲突文件右键与完成页", () => {
  beforeEach(() => {
    clearConflictDrafts();
    for (const mock of [mergeSession, branchState, mergePreview, conflictView, resolveConflict, completeMerge, openPath, revealPath]) mock.mockReset();
    branchState.mockResolvedValue({ generation: 4, branches: [], snapshot: opened.snapshot });
    openPath.mockResolvedValue(undefined);
    revealPath.mockResolvedValue(undefined);
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderPanel(extra: Record<string, unknown> = {}) {
    const props = {
      opened,
      disabled: false,
      nextId: () => 9,
      onSnapshot: vi.fn(),
      onGeneration: vi.fn(),
      onFailure: vi.fn(),
      onNotice: vi.fn(),
      onOpenStash: vi.fn(),
      ...extra,
    };
    render(MergePanel, props);
    return props;
  }

  const twoConflicts = () =>
    session({
      unresolved: 2,
      conflicts: [
        { path: "src/a.txt", kind: "text", summary: "文本" },
        { path: "docs/b.md", kind: "text", summary: "文本" },
      ],
    });

  it("右键冲突文件弹出应用自己的菜单，不出现 WebView 原生菜单；整份采用来源后保持当前文件", async () => {
    mergeSession.mockResolvedValue(twoConflicts());
    conflictView.mockImplementation(async (_repo: string, path: string) => viewOf(path, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n"));
    resolveConflict.mockResolvedValue(session({ unresolved: 1, conflicts: [{ path: "src/a.txt", kind: "text", summary: "文本" }] }));
    const props = renderPanel();
    const row = await screen.findByRole("button", { name: "文本冲突 docs/b.md" });
    await vi.waitFor(() => expect(conflictView).toHaveBeenCalledWith("/repo", "src/a.txt", 4, 9));
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByRole("menu", { name: "b.md 的操作" });
    expect(within(menu).getByRole("menuitem", { name: "整个文件采用当前（main）" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "复制路径" })).toBeTruthy();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "整个文件采用来源（feature）" }));
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledWith("/repo", "docs/b.md", "theirs", null, 4, 9));
    await vi.waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("docs/b.md 已标记为已解决。"));
    // 正在处理的文件没有被换掉。
    expect(screen.getByRole("button", { name: "文本冲突 src/a.txt" }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("group", { name: "已解决 docs/b.md" })).toBeTruthy();
  });

  it("按工作区内容标记：仍有冲突标记时不写入并说明原因；没有标记时按文本写入", async () => {
    mergeSession.mockResolvedValue(twoConflicts());
    let bText = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n";
    conflictView.mockImplementation(async (_repo: string, path: string) =>
      viewOf(path, path === "docs/b.md" ? bText : "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n"),
    );
    resolveConflict.mockResolvedValue(session({ unresolved: 1, conflicts: [{ path: "src/a.txt", kind: "text", summary: "文本" }] }));
    const props = renderPanel();
    const row = await screen.findByRole("button", { name: "文本冲突 docs/b.md" });
    await vi.waitFor(() => expect(conflictView).toHaveBeenCalledTimes(1));

    await fireEvent.contextMenu(row);
    await fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "按工作区内容标记为已解决" }));
    await vi.waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("还有冲突标记")));
    expect(resolveConflict).not.toHaveBeenCalled();

    bText = "edited outside\n";
    await fireEvent.contextMenu(row);
    await fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "按工作区内容标记为已解决" }));
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledWith("/repo", "docs/b.md", "text", "edited outside\n", 4, 9));
  });

  it("查看类操作：用默认程序打开、在文件管理器中显示，键盘 Shift+F10 也能唤起", async () => {
    mergeSession.mockResolvedValue(twoConflicts());
    conflictView.mockImplementation(async (_repo: string, path: string) => viewOf(path, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n"));
    renderPanel();
    const row = await screen.findByRole("button", { name: "文本冲突 docs/b.md" });
    await fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "b.md 的操作" });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "用默认程序打开" }));
    expect(openPath).toHaveBeenCalledWith("/repo", "docs/b.md");
    await fireEvent.contextMenu(row);
    const again = await screen.findByRole("menu");
    await fireEvent.click(within(again).getByRole("menuitem", { name: revealLabel() }));
    expect(revealPath).toHaveBeenCalledWith("/repo", "docs/b.md");
  });

  it("完成页只给结论与下一步：合并提交、带入数量、推送状态；领先上游时可直接推送", async () => {
    mergeSession.mockResolvedValueOnce(session());
    mergeSession.mockResolvedValue(session({ operation: "none", canAbort: false, canContinue: false }));
    completeMerge.mockResolvedValue({ operation: "merge", oid: "d".repeat(40), generation: 7, summary: "已完成。", files: ["src/a.txt"], snapshot: opened.snapshot });
    const onPush = vi.fn();
    const onOpenHistory = vi.fn();
    const onClose = vi.fn();
    renderPanel({ onPush, onOpenHistory, onClose });
    await fireEvent.input(await screen.findByRole("textbox", { name: "合并说明" }), { target: { value: "Merge feature" } });
    await fireEvent.click(screen.getByRole("button", { name: "完成合并" }));
    expect(await screen.findByText("已把 feature 合并到 main")).toBeTruthy();
    const facts = screen.getByLabelText("本次合并概览");
    expect(facts.textContent).toContain("ddddddd");
    expect(facts.textContent).toContain("1 个文件");
    expect(facts.textContent).toContain("尚未推送 · 领先 origin/main 1 个提交");
    // 没有差异浏览。
    expect(screen.queryByRole("tab")).toBeNull();
    expect(document.querySelector(".merge-review")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "推送" }));
    expect(onPush).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "查看提交历史" }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("推送后快照与上游一致：完成页改说已推送，不再给推送按钮", async () => {
    mergeSession.mockResolvedValueOnce(session());
    mergeSession.mockResolvedValue(session({ operation: "none", canAbort: false, canContinue: false }));
    completeMerge.mockResolvedValue({ operation: "merge", oid: "d".repeat(40), generation: 7, summary: "已完成。", files: [], snapshot: opened.snapshot });
    const props = { opened, disabled: false, nextId: () => 9, onSnapshot: vi.fn(), onGeneration: vi.fn(), onFailure: vi.fn(), onNotice: vi.fn(), onOpenStash: vi.fn(), onPush: vi.fn() };
    const view = render(MergePanel, props);
    await fireEvent.input(await screen.findByRole("textbox", { name: "合并说明" }), { target: { value: "Merge feature" } });
    await fireEvent.click(screen.getByRole("button", { name: "完成合并" }));
    expect(await screen.findByRole("button", { name: "推送" })).toBeTruthy();
    await view.rerender({ ...props, opened: { ...opened, snapshot: { ...opened.snapshot, branch: { ...branch, ahead: 0 } } } });
    await vi.waitFor(() => expect(screen.getByLabelText("本次合并概览").textContent).toContain("已推送 · 与 origin/main 一致"));
    expect(screen.queryByRole("button", { name: "推送" })).toBeNull();
  });
});
