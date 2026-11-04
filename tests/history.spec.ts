import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DiffView from "../src/lib/components/DiffView.svelte";
import {
  commitFileLabel,
  commitSelectionRange,
  historyConditions,
  historyDayBound,
  historyStatus,
  mergeAbortAvailable,
  parentCaption,
  preferredCommitFile,
  commitBodyRest,
  refLabel,
  refPills,
  shortOid,
  shouldAppendHistory,
  stashPathBadge,
  toggleCommitSelection,
} from "../src/lib/history";
import type { DiffResponse, FileSelection, HistoryCommit, OpenedRepository, StashState } from "../src/lib/types";

const historyPage = vi.hoisted(() => vi.fn());
const commitDetail = vi.hoisted(() => vi.fn());
const commitFileDiff = vi.hoisted(() => vi.fn());
const fileHistory = vi.hoisted(() => vi.fn());
const stashState = vi.hoisted(() => vi.fn());
const saveStash = vi.hoisted(() => vi.fn());
const applyStash = vi.hoisted(() => vi.fn());
const deleteStash = vi.hoisted(() => vi.fn());
const cherryPickCommits = vi.hoisted(() => vi.fn());
const checkoutCommit = vi.hoisted(() => vi.fn());
const revealPath = vi.hoisted(() => vi.fn());
const createBranchFrom = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: {
    historyPage,
    commitDetail,
    commitFileDiff,
    fileHistory,
    stashState,
    saveStash,
    applyStash,
    deleteStash,
    cherryPickCommits,
    checkoutCommit,
    revealPath,
    createBranchFrom,
  },
}));

import HistoryPanel from "../src/lib/components/HistoryPanel.svelte";
import StashModal from "../src/lib/components/StashModal.svelte";
import StashPanel from "../src/lib/components/StashPanel.svelte";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 3,
  snapshot: {
    generation: 3,
    branch: {
      name: "main",
      detached: false,
      unborn: false,
      headOid: "abc",
      upstream: null,
      ahead: null,
      behind: null,
      liveRemoteChecked: false,
      remoteCheckedAtMs: null,
      remoteCheckStale: false,
    },
    files: [],
  },
  draft: "",
  watchDegraded: false,
};

function commit(index: number, extra: Partial<HistoryCommit> = {}): HistoryCommit {
  return {
    oid: `abcdef${index.toString(16).padStart(4, "0")}abcdef${index.toString(16).padStart(4, "0")}abcdef${index.toString(16).padStart(4, "0")}abcd`,
    parents: [`parent${index}`],
    summary: `commit-${index}`,
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authoredAt: 1_700_000_000 + index,
    labels: [],
    ...extra,
  };
}

const diff: DiffResponse = {
  generation: 3,
  path: "notes.txt",
  staged: false,
  binary: false,
  text: null,
  summary: "修改",
  additions: 1,
  deletions: 0,
  complete: true,
  truncated: false,
  snapshot: "snap",
  offset: 0,
  totalLines: 1,
  hunks: [],
  lines: [{ kind: "add", text: "+edited", oldNo: null, newNo: 1, hunkIndex: null }],
};

function panelProps(filePath: string | null = null) {
  return {
    opened,
    filePath,
    disabled: false,
    nextId: () => 1,
    onGeneration: () => {},
    onFailure: () => {},
    onFilePath: () => {},
    onClearFile: () => {},
  };
}

describe("历史文案", () => {
  it("区分空仓库、无匹配和无文件历史", () => {
    expect(historyStatus("empty_repository")).toBe("这个仓库还没有任何提交。");
    expect(historyStatus("empty_branch")).toBe("当前分支还没有提交。范围是当前分支。");
    expect(historyStatus("no_match")).toBe("没有符合条件的提交。");
    expect(historyStatus("no_match")).not.toContain("作者");
    expect(historyStatus("no_file_history")).toBe("这个文件没有可用历史。");
    expect(historyStatus("ok")).toBeNull();
    expect(historyStatus("empty_repository")).not.toBe(historyStatus("no_match"));
    expect(historyStatus("no_match")).not.toBe(historyStatus("no_file_history"));
  });

  it("生效条件按交集书写，日期含当天，接近底部才追加", () => {
    const text = historyConditions({
      scope: "current",
      head: "main",
      author: "Ada",
      since: "2024-01-02",
      until: "2024-01-03",
      path: "docs",
      query: "needle",
    });
    expect(text).toContain("范围：当前分支 main");
    expect(text).toContain("作者：Ada");
    expect(text).toContain("路径：docs");
    expect(text).toContain("说明或哈希：needle");
    expect(text).toContain("含起止当天");
    expect(text).toContain("仓库没有被修改");
    const start = historyDayBound("2024-01-02", false);
    const end = historyDayBound("2024-01-02", true);
    expect(start).not.toBeNull();
    expect(end! - start!).toBe(86_399);
    expect(new Date(start! * 1000).getHours()).toBe(0);
    expect(new Date(end! * 1000).getDate()).toBe(2);
    expect(historyDayBound("2024-02-31", false)).toBeNull();
    expect(commitSelectionRange(["a", "b", "c"], "a", "c")).toEqual(["a", "b", "c"]);
    expect(toggleCommitSelection(["a"], "a")).toEqual(["a"]);
    expect(toggleCommitSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(shouldAppendHistory(0, 0, 1000, true, false)).toBe(false);
    expect(shouldAppendHistory(800, 200, 1000, true, false)).toBe(true);
    expect(shouldAppendHistory(800, 200, 1000, false, false)).toBe(false);
  });

  it("说明父提交、引用、重命名后的路径和保存范围", () => {
    expect(parentCaption([])).toContain("空树");
    expect(parentCaption(["aaaaaaaa"])).toBe("父提交 aaaaaaa");
    expect(parentCaption(["aaaaaaaa", "bbbbbbbb"])).toContain("合并提交");
    expect(refLabel("branch", "feature", true)).toBe("分支 feature · 当前");
    expect(refLabel("tag", "v1", false)).toBe("标签 v1");
    expect(commitFileLabel("deleted")).toBe("删除");
    const renamed = preferredCommitFile(
      [{ path: "new.txt", originalPath: "old.txt" }],
      "old.txt",
    );
    expect(renamed?.path).toBe("new.txt");
    expect(stashPathBadge("tracked", false)).toBe("将保存");
    expect(stashPathBadge("untracked", false)).toBe("不保存");
    expect(stashPathBadge("untracked", true)).toBe("会一并保存");
    expect(stashPathBadge("ignored", true)).toBe("忽略不保存");
    expect(mergeAbortAvailable(false)).toBe(false);
  });

  it("引用胶囊把本地分支与同名远程合并，当前分支排最前", () => {
    const pills = refPills([
      { name: "origin/main", kind: "remote", current: false },
      { name: "v1.0", kind: "tag", current: false },
      { name: "main", kind: "branch", current: false },
      { name: "feature", kind: "branch", current: true },
      { name: "origin/HEAD", kind: "remote", current: false },
      { name: "origin/other", kind: "remote", current: false },
    ]);
    expect(pills.map((pill) => `${pill.kind}:${pill.name}`)).toEqual([
      "branch:feature",
      "branch:main",
      "tag:v1.0",
      "remote:origin/other",
    ]);
    expect(pills[1].remote).toBe("origin");
    expect(pills[1].label).toContain("origin/main");
  });

  it("详情只显示标题之后的正文", () => {
    expect(commitBodyRest("修复登录\n\n- 第一条\n- 第二条\n", "修复登录")).toBe("- 第一条\n- 第二条");
    expect(commitBodyRest("1\n", "1")).toBe("");
    expect(commitBodyRest("别的说明", "标题")).toBe("别的说明");
  });
});

describe("历史面板", () => {
  beforeEach(() => {
    historyPage.mockReset();
    commitDetail.mockReset();
    commitFileDiff.mockReset();
    fileHistory.mockReset();
    commitDetail.mockResolvedValue({
      generation: 3,
      commit: commit(0),
      body: "",
      root: false,
      merge: false,
      selectedParent: "parent0",
      files: [],
    });
    commitFileDiff.mockResolvedValue(diff);
  });

  it("长列表只渲染可见提交，并显示父提交和分支", async () => {
    const first = commit(0, {
      parents: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      labels: [{ name: "feature", kind: "branch", current: true }],
    });
    historyPage.mockResolvedValue({
      generation: 3,
      query: "",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "ok",
      commits: [first, ...Array.from({ length: 99 }, (_, index) => commit(index + 1))],
    });
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    // 合并提交在行内用紫色「合并」标记，完整父提交说明放在悬停提示里。
    expect(screen.getAllByTitle(/合并提交，父提交 aaaaaaa、bbbbbbb/).length).toBeGreaterThan(0);
    // 引用胶囊的可访问名称保留完整含义（种类、名称、是否当前）。
    expect(screen.getAllByLabelText("分支 feature · 当前").length).toBeGreaterThan(0);
    // 行内只显示短 Hash，复制等操作收进右键菜单，不再每行一个复制按钮。
    expect(screen.getAllByText(shortOid(first.oid)).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: /复制提交 .*完整 Hash/ })).toHaveLength(0);
    expect(screen.queryByRole("option", { name: /commit-99/ })).toBeNull();
    expect(historyPage).toHaveBeenCalledWith("/repo", "", 0, 3, 1);
  });

  it("搜索在停顿后把关键词交给全部历史，而不是立刻过滤", async () => {
    vi.useFakeTimers();
    try {
      historyPage.mockResolvedValue({
        generation: 3,
        query: "",
        offset: 0,
        pageSize: 100,
        hasMore: false,
        state: "no_match",
        commits: [],
      });
      render(HistoryPanel, { props: panelProps() });
      await vi.runAllTimersAsync();
      historyPage.mockClear();
      await fireEvent.input(screen.getByLabelText("搜索说明或提交哈希"), { target: { value: "UNIQUE-NEEDLE" } });
      await vi.advanceTimersByTimeAsync(299);
      expect(historyPage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(historyPage).toHaveBeenCalledWith("/repo", "UNIQUE-NEEDLE", 0, 3, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("空仓库、无搜索结果、文件无历史的空状态文案和图标都不同", async () => {
    const seen = new Map<string, string>();
    for (const [state, path] of [["empty_repository", null], ["no_match", null], ["no_file_history", "notes.txt"]] as const) {
      const page = { generation: 3, query: "", path, offset: 0, pageSize: 100, hasMore: false, state, commits: [] };
      historyPage.mockResolvedValue(page);
      fileHistory.mockResolvedValue(page);
      const view = render(HistoryPanel, { props: panelProps(path ?? undefined) });
      const text = await screen.findByText(historyStatus(state)!);
      const icon = text.closest(".empty")!.querySelector(".empty-icon svg")!.innerHTML;
      seen.set(text.textContent!, icon);
      view.unmount();
    }
    expect(seen.size).toBe(3);
    expect(new Set(seen.values()).size).toBe(3);
  });

  it("文件历史使用文件接口，并区分没有历史", async () => {
    fileHistory.mockResolvedValue({
      generation: 3,
      path: "notes.txt",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "no_file_history",
      commits: [],
    });
    render(HistoryPanel, { props: panelProps("notes.txt") });
    expect(await screen.findByText("这个文件没有可用历史。")).toBeTruthy();
    expect(document.querySelector(".history-list .empty-icon"), "空状态图标与其它两种不同").toBeTruthy();
    expect(fileHistory).toHaveBeenCalledWith("/repo", "notes.txt", 0, 3, 1);
    expect(historyPage).not.toHaveBeenCalled();
  });

  it("范围下拉框按设置分组：开启时按前缀成组，关闭时平铺；选中分支后按它读取", async () => {
    historyPage.mockResolvedValue({
      generation: 3,
      query: "",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "ok",
      commits: [commit(0)],
      scope: "current",
      branches: ["main", "feature/a", "feature/b", "fix/x"],
      head: "main",
    });
    const view = render(HistoryPanel, { props: { ...panelProps(), branchGroups: true } });
    const trigger = () => screen.getByRole("button", { name: "历史范围" });
    const names = () => [...document.querySelectorAll<HTMLElement>('[role="option"] .branch-option-name')].map((node) => node.textContent);
    const groups = () => [...document.querySelectorAll<HTMLElement>("[data-branch-group]")].map((node) => node.dataset.branchGroup);
    await waitFor(() => expect(trigger().textContent).toContain("当前分支（main）"));
    await fireEvent.click(trigger());
    expect(names()).toEqual(["当前分支（main）", "全部分支", "main"]);
    expect(groups()).toEqual(["feature", "fix"]);
    await fireEvent.click(screen.getByRole("button", { name: "展开分组 feature" }));
    expect(names()).toEqual(["当前分支（main）", "全部分支", "main", "feature/a", "feature/b"]);
    await fireEvent.keyDown(screen.getByLabelText("搜索历史范围"), { key: "Escape" });

    await view.rerender({ ...panelProps(), branchGroups: false });
    await fireEvent.click(trigger());
    expect(groups()).toEqual([]);
    expect(names()).toEqual(["当前分支（main）", "全部分支", "main", "feature/a", "feature/b", "fix/x"]);
    historyPage.mockClear();
    await fireEvent.click(screen.getByRole("option", { name: "fix/x" }));
    expect(trigger().dataset.value).toBe("fix/x");
    await waitFor(() => expect(historyPage).toHaveBeenCalled());
    expect(JSON.stringify(historyPage.mock.calls.at(-1))).toContain("fix/x");
  });

  it("筛选取交集，清除路径时保留作者，当前分支没有提交时写明范围", async () => {
    vi.useFakeTimers();
    try {
      historyPage.mockResolvedValue({
        generation: 3,
        query: "",
        offset: 0,
        pageSize: 100,
        hasMore: false,
        state: "ok",
        commits: [commit(0)],
        scope: "current",
        branches: ["main", "feature"],
        head: "main",
      });
      render(HistoryPanel, { props: panelProps() });
      await vi.runAllTimersAsync();
      historyPage.mockClear();
      // 作者、日期、路径收在「更多筛选」里，默认不占左栏首屏。
      expect(screen.queryByLabelText("作者")).toBeNull();
      const toggle = screen.getByRole("button", { name: "更多筛选" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await fireEvent.input(screen.getByLabelText("作者"), { target: { value: "Ada" } });
      await fireEvent.input(screen.getByLabelText("路径"), { target: { value: "docs" } });
      await fireEvent.input(screen.getByLabelText("搜索说明或提交哈希"), { target: { value: "needle" } });
      await fireEvent.input(screen.getByLabelText("开始日期"), { target: { value: "2024-01-02" } });
      await fireEvent.input(screen.getByLabelText("结束日期"), { target: { value: "2024-01-02" } });
      await vi.advanceTimersByTimeAsync(300);
      const since = historyDayBound("2024-01-02", false);
      const until = historyDayBound("2024-01-02", true);
      expect(historyPage).toHaveBeenCalledWith("/repo", "needle", 0, 3, 1, {
        author: "Ada",
        path: "docs",
        since,
        until,
      });
      // 收起后生效条件仍在，按钮上计数提示还有几项在生效。
      expect(screen.getByRole("button", { name: "更多筛选（已生效 4 项）" })).toBeTruthy();
      historyPage.mockClear();
      await fireEvent.click(screen.getByRole("button", { name: "清除路径" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(historyPage).toHaveBeenCalledWith("/repo", "needle", 0, 3, 1, {
        author: "Ada",
        since,
        until,
      });
      historyPage.mockResolvedValue({
        generation: 3,
        query: "",
        offset: 0,
        pageSize: 100,
        hasMore: false,
        state: "empty_branch",
        commits: [],
        scope: "current",
        branches: [],
        head: "main",
      });
      historyPage.mockClear();
      await fireEvent.click(screen.getByRole("button", { name: "清除作者" }));
      await fireEvent.click(screen.getByRole("button", { name: "清除说明或哈希" }));
      await fireEvent.click(screen.getByRole("button", { name: "清除开始日期" }));
      await fireEvent.click(screen.getByRole("button", { name: "清除结束日期" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await screen.findByText("当前分支还没有提交。范围是当前分支。")).toBeTruthy();
      expect(screen.getByText(/生效条件：范围：当前分支 main/)).toBeTruthy();
      expect(screen.getByText(/仓库没有被修改/)).toBeTruthy();
      expect(historyPage).toHaveBeenCalledWith("/repo", "", 0, 3, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("接近底部追加更早提交，失败时保留已显示的提交", async () => {
    const first = commit(0);
    const older = commit(1);
    historyPage
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 0, pageSize: 100, hasMore: true, state: "ok", commits: [first],
        scope: "current", branches: ["main"], head: "main",
      })
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 1, pageSize: 100, hasMore: false, state: "ok", commits: [older],
        scope: "current", branches: ["main"], head: "main",
      });
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    const detailCalls = commitDetail.mock.calls.length;
    const list = screen.getByRole("listbox", { name: "提交历史" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 120 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 400 });
    list.scrollTop = 300;
    await fireEvent.scroll(list);
    expect(await screen.findByRole("option", { name: /commit-1/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /commit-0/ })).toBeTruthy();
    expect(screen.getByText(/已加载最新 1–2 条/)).toBeTruthy();
    expect(historyPage.mock.calls.at(-1)?.[2]).toBe(1);
    expect(commitDetail.mock.calls.length).toBe(detailCalls);
    await fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(list.scrollTop).toBe(0);
  });

  it("从其他视图切回历史保留滚动位置，读取条件变化才回到顶部", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => commit(index));
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: rows[0], body: "", root: false, merge: false, selectedParent: "parent", files: [],
    });
    fileHistory.mockResolvedValue({ generation: 3, path: "notes.txt", offset: 0, pageSize: 100, hasMore: false, state: "no_file_history", commits: [] });
    const view = render(HistoryPanel, { props: { ...panelProps(), active: true } });
    await screen.findByRole("option", { name: /commit-0/ });
    const list = screen.getByRole("listbox", { name: "提交历史" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 160 });
    const newest = screen.getByRole<HTMLButtonElement>("button", { name: "回到最新" });
    expect(newest.disabled, "已经在顶部时没有可做的事").toBe(true);
    expect(newest.title).toBe("已经在最新一条提交");

    list.scrollTop = 320;
    await fireEvent.scroll(list);
    expect(newest.disabled, "离开顶部后可以回到最新").toBe(false);

    await view.rerender({ ...panelProps(), active: false });
    await view.rerender({ ...panelProps(), active: true });
    await waitFor(() => expect(historyPage).toHaveBeenCalledTimes(2));
    expect(list.scrollTop, "切走再切回同一个浏览位置不回到顶部").toBe(320);

    await view.rerender({ ...panelProps("notes.txt"), active: true });
    await waitFor(() => expect(fileHistory).toHaveBeenCalledWith("/repo", "notes.txt", 0, 3, 1));
    expect(list.scrollTop, "换了读取条件回到顶部").toBe(0);
  });

  it("提交列表用 aria-activedescendant 指出键盘当前项，行带稳定 id", async () => {
    const rows = [commit(0), commit(1)];
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: rows[0], body: "", root: false, merge: false, selectedParent: "parent", files: [],
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    const list = screen.getByRole("listbox", { name: "提交历史" });
    const first = screen.getByRole("option", { name: /commit-0/ });
    const second = screen.getByRole("option", { name: /commit-1/ });
    expect(first.id).toBe("history-commit-" + rows[0].oid);
    expect(list.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(document.getElementById(list.getAttribute("aria-activedescendant") as string)).toBe(first);

    await fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(second.id);
    expect(document.getElementById(second.id), "指向的元素真实存在").toBe(second);
  });

  it("追加失败时保留已加载提交并说明原因", async () => {
    const first = commit(0);
    historyPage
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 0, pageSize: 100, hasMore: true, state: "ok", commits: [first],
        scope: "current", branches: ["main"], head: "main",
      })
      .mockRejectedValueOnce({ code: "history_failed", message: "读取更早提交失败。" });
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    const list = screen.getByRole("listbox", { name: "提交历史" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 120 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 400 });
    list.scrollTop = 300;
    await fireEvent.scroll(list);
    expect(await screen.findByText(/读取更早提交失败。已显示的提交仍保留。/)).toBeTruthy();
    expect(screen.getByRole("option", { name: /commit-0/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /commit-1/ })).toBeNull();
  });

  it("首页已有更早提交时，空的追加不会被当成结束", async () => {
    const first = commit(0);
    historyPage
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 0, pageSize: 100, hasMore: true, state: "ok", commits: [first],
        scope: "current", branches: ["main"], head: "main",
      })
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 1, pageSize: 100, hasMore: false, state: "ok", commits: [],
        scope: "current", branches: ["main"], head: "main",
      });
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    const list = screen.getByRole("listbox", { name: "提交历史" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 120 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 400 });
    list.scrollTop = 300;
    await fireEvent.scroll(list);
    expect(await screen.findByText(/这一页没有读到。已显示的提交仍保留。/)).toBeTruthy();
    expect(screen.getByRole("option", { name: /commit-0/ })).toBeTruthy();
    expect(screen.getByText("已加载最新 1–1 条，还有更早的提交")).toBeTruthy();
    expect(historyPage).toHaveBeenCalledTimes(2);
    await fireEvent.scroll(list);
    expect(historyPage).toHaveBeenCalledTimes(2);
  });

  it("PageDown/PageUp 按一屏移动提交选择，当前行保持可见", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => commit(index));
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: rows[0], body: "", root: false, merge: false, selectedParent: "parent", files: [],
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    const list = screen.getByRole("listbox", { name: "提交历史" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 160 });
    const selectedIndex = () =>
      [...list.querySelectorAll(".history-row")].findIndex((row) => row.getAttribute("aria-selected") === "true");

    await fireEvent.keyDown(list, { key: "PageDown" });
    expect(selectedIndex(), "一屏 160px 约三条，选择随翻页前进").toBe(3);
    expect(list.scrollTop, "当前行滚进视口").toBeGreaterThan(0);

    await fireEvent.keyDown(list, { key: "PageUp" });
    expect(selectedIndex()).toBe(0);
    expect(list.scrollTop).toBe(0);
  });

  it("单条与多条提交的菜单不同，多条显示第一父提交的文件并集", async () => {
    const first = commit(0);
    const second = commit(1);
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [first, second],
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3,
      commit: oid === second.oid ? second : first,
      body: "",
      root: false,
      merge: false,
      selectedParent: "parent",
      files: oid === second.oid
        ? [{ path: "b.txt", originalPath: null, status: "modified", additions: 1, deletions: 0 }, { path: "c.txt", originalPath: null, status: "added", additions: 1, deletions: 0 }]
        : [{ path: "a.txt", originalPath: null, status: "modified", additions: 1, deletions: 0 }, { path: "b.txt", originalPath: null, status: "modified", additions: 2, deletions: 1 }],
    }));
    const onNotice = vi.fn();
    const onSnapshot = vi.fn();
    render(HistoryPanel, { props: { ...panelProps(), onNotice, onSnapshot } });
    const row = await screen.findByRole("option", { name: /commit-0/ });
    await fireEvent.contextMenu(row);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "拣选到当前分支",
      "检出此提交",
      "从此提交新建分支",
      "复制提交哈希",
    ]);
    expect(screen.queryByRole("menuitem", { name: /还原/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /重置/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /复制作者/ })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "检出此提交" }));
    expect(await screen.findByText(/游离 HEAD/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(checkoutCommit).not.toHaveBeenCalled();
    checkoutCommit.mockResolvedValue({ ...opened.snapshot, generation: 4, branch: { ...opened.snapshot.branch, detached: true, name: null } });
    await fireEvent.contextMenu(row);
    await fireEvent.click(screen.getByRole("menuitem", { name: "检出此提交" }));
    await fireEvent.click(screen.getByRole("button", { name: "检出" }));
    await waitFor(() => expect(checkoutCommit).toHaveBeenCalledWith("/repo", first.oid, 3, 1));
    expect(onSnapshot).toHaveBeenCalled();
    cherryPickCommits.mockResolvedValue({
      generation: 5,
      conflicted: false,
      skipped: [],
      note: "已按从旧到新拣选到当前分支。没有推送。",
      snapshot: opened.snapshot,
    });
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }), { shiftKey: true });
    expect(await screen.findByText("已选择 2 个提交")).toBeTruthy();
    // 文件名同时出现在左侧并集清单和右侧差异标题里；这里核对的是并集清单。
    const union = await screen.findByRole("listbox", { name: "提交中的文件列表" });
    expect(await within(union).findByText("a.txt")).toBeTruthy();
    expect(within(union).getByText("b.txt")).toBeTruthy();
    expect(within(union).getByText("c.txt")).toBeTruthy();
    expect(commitDetail).toHaveBeenCalledWith("/repo", first.oid, null, 3, 1);
    expect(commitDetail).toHaveBeenCalledWith("/repo", second.oid, null, 3, 1);
    await fireEvent.contextMenu(screen.getByRole("option", { name: /commit-1/ }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["拣选这些提交", "复制哈希"]);
    await fireEvent.click(screen.getByRole("menuitem", { name: "拣选这些提交" }));
    await waitFor(() => expect(cherryPickCommits).toHaveBeenCalledWith("/repo", [first.oid, second.oid], 3, 1));
    expect(onNotice).toHaveBeenCalledWith("已按从旧到新拣选到当前分支。没有推送。");
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }), { ctrlKey: true });
    expect(screen.queryByText("已选择 2 个提交")).toBeNull();
  });

  it("多选详情限制在途读取，取消选择后不再读取旧批次剩余提交", async () => {
    const commits = Array.from({ length: 8 }, (_, index) => commit(index));
    historyPage.mockResolvedValue({ generation: 3, commits, offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    const view = render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledTimes(1));
    const finish: Array<(value: unknown) => void> = [];
    commitDetail.mockClear();
    commitDetail.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    await fireEvent.click(screen.getByRole("option", { name: /commit-7/ }), { shiftKey: true });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledTimes(2));
    // 隐藏面板也取消尚未开始的读取，不仅丢弃显示结果。
    await view.rerender({ ...panelProps(), active: false });
    for (const resolve of finish) resolve({ generation: 3, commit: commits[0], files: [], body: "", selectedParent: null });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commitDetail).toHaveBeenCalledTimes(2);
    expect(commitFileDiff).not.toHaveBeenCalled();
  });

  it("多选：提交清单点一行只看那个提交，退出多选回到最新的一个；差异按提交堆叠，可切并排", async () => {
    const commits = Array.from({ length: 4 }, (_, index) => commit(index));
    historyPage.mockResolvedValue({ generation: 3, commits, offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3, commit: commits.find((item) => item.oid === oid), body: "", root: false, merge: false, selectedParent: "parent",
      files: [{ path: "src/a.txt", originalPath: null, status: "modified", additions: 2, deletions: 1 }],
    }));
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await fireEvent.click(screen.getByRole("option", { name: /commit-2/ }), { shiftKey: true });
    expect(await screen.findByText("已选择 3 个提交")).toBeTruthy();
    const chosen = screen.getByRole("list", { name: "已选择的提交" });
    expect(within(chosen).getAllByRole("button").map((button) => button.textContent)).toEqual(
      commits.slice(0, 3).map((item) => expect.stringContaining(item.summary)),
    );
    // 右侧按提交堆叠同一个文件的差异：每块一个吸顶标题，块里是嵌入式差异，没有各自的工具条。
    await waitFor(() => expect(document.querySelectorAll(".union-block")).toHaveLength(3));
    expect([...document.querySelectorAll(".union-block-summary")].map((node) => node.textContent)).toEqual(["commit-0", "commit-1", "commit-2"]);
    expect(document.querySelectorAll(".union-block .diff.embedded")).toHaveLength(3);
    expect(document.querySelector(".union-block .diff-toolbar")).toBeNull();
    expect(document.querySelector(".union-diff-head")?.textContent).toContain("3 个提交改动了它");
    const layout = within(document.querySelector(".union-diff-head") as HTMLElement).getByRole("group", { name: "差异布局" });
    await fireEvent.click(within(layout).getByRole("button", { name: /并排/ }));
    expect(within(layout).getByRole("button", { name: /并排/ }).getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(within(chosen).getByRole("button", { name: /commit-1/ }));
    expect(screen.queryByText("已选择 3 个提交")).toBeNull();
    expect(screen.getByRole("option", { name: /commit-1/ }).getAttribute("aria-selected")).toBe("true");

    await fireEvent.click(screen.getByRole("option", { name: /commit-3/ }), { shiftKey: true });
    expect(await screen.findByText("已选择 3 个提交")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /退出多选/ }));
    expect(screen.queryByText("已选择 3 个提交")).toBeNull();
    expect(screen.getByRole("option", { name: /commit-1/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("变更文件栏和差异之间的分隔条可以拖动或用方向键调整，宽度记在本机", async () => {
    globalThis.localStorage?.removeItem("twiglane.commitFilesWidth");
    commitDetail.mockResolvedValue({
      generation: 3, commit: commit(0), body: "", root: false, merge: false, selectedParent: "parent0",
      files: [{ path: "a.txt", originalPath: null, status: "modified" }],
    });
    historyPage.mockResolvedValue({ generation: 3, commits: [commit(0)], offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    render(HistoryPanel, { props: panelProps() });
    const handle = await screen.findByRole("slider", { name: "调整变更文件栏宽度" });
    const split = () => document.querySelector<HTMLElement>(".commit-split")!;
    expect(split().style.getPropertyValue("--commit-files")).toBe("248px");
    await fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(split().style.getPropertyValue("--commit-files")).toBe("264px");
    expect(globalThis.localStorage?.getItem("twiglane.commitFilesWidth")).toBe("264");
    await fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    await fireEvent.pointerUp(handle, { clientX: 200, pointerId: 1 });
    expect(split().style.getPropertyValue("--commit-files")).toBe("164px");
    expect(globalThis.localStorage?.getItem("twiglane.commitFilesWidth")).toBe("164");
    globalThis.localStorage?.removeItem("twiglane.commitFilesWidth");
  });

  it("多选差异切换文件后不继续旧文件的排队请求", async () => {
    const commits = Array.from({ length: 6 }, (_, index) => commit(index));
    historyPage.mockResolvedValue({ generation: 3, commits, offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3, commit: commits.find((item) => item.oid === oid), body: "", root: false, merge: false, selectedParent: "parent",
      files: ["a.txt", "b.txt"].map((path) => ({ path, originalPath: null, status: "modified" })),
    }));
    const view = render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(commitFileDiff).toHaveBeenCalledTimes(1));
    const pending: Array<{ path: string; resolve: (value: DiffResponse) => void }> = [];
    commitFileDiff.mockClear();
    commitFileDiff.mockImplementation((_repo, _oid, _parent, path: string) => new Promise((resolve) => pending.push({ path, resolve })));
    await fireEvent.click(screen.getByRole("option", { name: /commit-5/ }), { shiftKey: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.map((item) => item.path)).toEqual(["a.txt", "a.txt"]);
    await fireEvent.click(screen.getByRole("option", { name: /b\.txt/ }));
    expect(pending).toHaveLength(2);
    pending[0].resolve({ ...diff, path: "a.txt", lines: [{ ...diff.lines[0], text: "+obsolete selection" }] });
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[2].path).toBe("b.txt");
    expect(screen.queryByText("obsolete selection")).toBeNull();
    view.unmount();
    pending[1].resolve(diff);
    pending[2].resolve(diff);
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(3);
  });

  it("提交中的文件行只有历史、复制路径和文件管理器", async () => {
    const only = commit(0);
    const onFailure = vi.fn();
    const onSnapshot = vi.fn();
    const onFilePath = vi.fn();
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({
      generation: 3,
      commit: only,
      body: "",
      root: false,
      merge: false,
      selectedParent: only.parents[0],
      files: [{ path: "notes.txt", originalPath: null, status: "added", additions: 1, deletions: 0 }],
    });
    revealPath.mockRejectedValue({ code: "open_failed", message: "无法打开文件管理器。" });
    render(HistoryPanel, { props: { ...panelProps(), onFailure, onSnapshot, onFilePath } });
    await waitFor(() => expect(document.querySelector(".history-files .file-row")).toBeTruthy());
    const fileRow = document.querySelector<HTMLElement>(".history-files .file-row")!;
    await fireEvent.contextMenu(fileRow);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "查看此文件历史",
      "复制相对路径",
      "在系统文件管理器中显示",
    ]);
    expect(screen.queryByRole("menuitem", { name: /拣选/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /检出/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /哈希/ })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "查看此文件历史" }));
    expect(onFilePath).toHaveBeenCalledWith("notes.txt");
    await fireEvent.contextMenu(fileRow);
    await fireEvent.click(screen.getByRole("menuitem", { name: "在系统文件管理器中显示" }));
    await waitFor(() => expect(revealPath).toHaveBeenCalledWith("/repo", "notes.txt"));
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "open_failed" }));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(checkoutCommit).not.toHaveBeenCalled();
    expect(cherryPickCommits).not.toHaveBeenCalled();
  });
});

describe("临时保存", () => {
  const preview: StashState = {
    generation: 3,
    preview: {
      trackedCount: 1,
      untrackedCount: 1,
      ignoredCount: 1,
      trackedPaths: ["file.txt"],
      untrackedPaths: ["new.txt"],
      ignoredPaths: ["ignored.log"],
      includeUntracked: false,
      canSave: true,
      summary: "将保存已跟踪的暂存和未暂存改动 1 个。未跟踪文件 1 个这次不保存。忽略文件 1 个不会保存。",
    },
    records: [
      {
        oid: "cccccccccccccccccccccccccccccccccccccccc",
        message: "wip",
        committedAt: 1_700_000_000,
      },
    ],
    snapshot: opened.snapshot,
  };

  beforeEach(() => {
    stashState.mockReset();
    saveStash.mockReset();
    applyStash.mockReset();
    deleteStash.mockReset();
    stashState.mockResolvedValue(preview);
  });

  function renderStash() {
    return render(StashPanel, {
      props: {
        opened,
        disabled: false,
        nextId: () => 2,
        onGeneration: () => {},
        onSnapshot: () => {},
        onFailure: () => {},
        onNotice: () => {},
        onOpenChanges: () => {},
      },
    });
  }

  it("保存前声明跟踪、未跟踪和忽略范围", async () => {
    renderStash();
    expect(await screen.findByText(/将保存已跟踪/)).toBeTruthy();
    expect(screen.getByText(/未跟踪文件 1 个这次不保存/)).toBeTruthy();
    expect(screen.getByText(/忽略文件 1 个不会保存/)).toBeTruthy();
    // 文件少时清单默认展开，按类切换：已跟踪、未跟踪（不保存）、忽略。
    expect(screen.getByRole("button", { name: /收起文件清单/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("将保存 file.txt")).toBeTruthy();
    await fireEvent.click(screen.getByRole("tab", { name: /未跟踪文件（不保存）/ }));
    expect(screen.getByText("不保存 new.txt")).toBeTruthy();
    await fireEvent.click(screen.getByRole("tab", { name: /忽略文件/ }));
    expect(screen.getByText("忽略不保存 ignored.log")).toBeTruthy();
    expect(stashState).toHaveBeenCalledWith("/repo", false, 3, 2);
  });

  it("几千个文件时只给数量，清单收起；展开后可筛选并说明只列出了一部分", async () => {
    const trackedPaths = Array.from({ length: 200 }, (_, index) => `src/generated/module-${index}.ts`);
    stashState.mockResolvedValue({
      ...preview,
      preview: {
        ...preview.preview,
        trackedCount: 3200,
        untrackedCount: 0,
        ignoredCount: 0,
        trackedPaths,
        untrackedPaths: [],
        ignoredPaths: [],
        summary: "将保存已跟踪的暂存和未暂存改动 3200 个。",
      },
    });
    renderStash();
    const toggle = await screen.findByRole("button", { name: /查看文件清单/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/将保存已跟踪的暂存和未暂存改动 3200 个/)).toBeTruthy();
    expect(document.querySelectorAll(".stash-file")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /临时保存 3200 个文件/ })).toBeTruthy();

    await fireEvent.click(toggle);
    expect(document.querySelectorAll(".stash-file")).toHaveLength(200);
    expect(screen.getByText(/共 3200 个，只列出前 200 个/)).toBeTruthy();
    await fireEvent.input(screen.getByLabelText("筛选保存范围里的文件"), { target: { value: "module-19" } });
    expect([...document.querySelectorAll(".stash-file")].map((row) => row.getAttribute("title"))).toEqual([
      "src/generated/module-19.ts",
      "src/generated/module-190.ts",
      "src/generated/module-191.ts",
      "src/generated/module-192.ts",
      "src/generated/module-193.ts",
      "src/generated/module-194.ts",
      "src/generated/module-195.ts",
      "src/generated/module-196.ts",
      "src/generated/module-197.ts",
      "src/generated/module-198.ts",
      "src/generated/module-199.ts",
    ]);
  });

  it("取消删除不会调用接口，确认后按标识删除", async () => {
    deleteStash.mockResolvedValue({ ...preview, records: [] });
    renderStash();
    await screen.findByRole("button", { name: "删除" });
    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(deleteStash).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await fireEvent.click(screen.getByRole("button", { name: "删除记录" }));
    expect(deleteStash).toHaveBeenCalledWith("/repo", "cccccccccccccccccccccccccccccccccccccccc", true, 3, 2);
  });

  it("冲突只提供改动入口，不提供中止合并", async () => {
    applyStash.mockResolvedValue({
      generation: 4,
      oid: "cccccccccccccccccccccccccccccccccccccccc",
      kept: true,
      operation: "stash",
      conflicted: true,
      conflictPaths: ["file.txt"],
      canAbortMerge: false,
      note: "恢复发生冲突，原保存记录仍保留。这不是分支合并，没有可中止的合并。",
      snapshot: opened.snapshot,
    });
    renderStash();
    await screen.findByRole("button", { name: "恢复" });
    await fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("button", { name: "查看冲突 file.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "中止合并" })).toBeNull();
    expect(screen.getByText(/没有可中止的合并/)).toBeTruthy();
    expect(applyStash).toHaveBeenCalledWith("/repo", "cccccccccccccccccccccccccccccccccccccccc", 3, 2);
  });
});

describe("临时保存 modal", () => {
  const preview: StashState = {
    generation: 3,
    preview: {
      trackedCount: 1,
      untrackedCount: 0,
      ignoredCount: 0,
      trackedPaths: ["file.txt"],
      untrackedPaths: [],
      ignoredPaths: [],
      includeUntracked: false,
      canSave: true,
      summary: "将保存已跟踪的暂存和未暂存改动 1 个。",
    },
    records: [
      {
        oid: "cccccccccccccccccccccccccccccccccccccccc",
        message: "wip",
        committedAt: 1_700_000_000,
      },
    ],
    snapshot: opened.snapshot,
  };

  beforeEach(() => {
    stashState.mockReset();
    deleteStash.mockReset();
    stashState.mockResolvedValue(preview);
  });

  function renderModal() {
    const onClose = vi.fn();
    render(StashModal, {
      props: {
        opened,
        disabled: false,
        nextId: () => 2,
        onClose,
        onGeneration: () => {},
        onSnapshot: () => {},
        onFailure: () => {},
        onNotice: () => {},
        onOpenChanges: () => {},
      },
    });
    return { onClose };
  }

  it("以单一任务 modal 打开，删除确认列出受影响记录且取消不写入", async () => {
    renderModal();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("stash");
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);

    await fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("dialog", { name: /删除临时保存/ });
    expect(confirm).toBeTruthy();
    // 破坏性确认是叠在任务 modal 之上的确认层，不是第二个任务 modal。
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
    const impact = screen.getByRole("list", { name: "受影响的临时保存记录" }).textContent ?? "";
    expect(impact).toContain("ccccccc");
    expect(impact).toContain("wip");
    expect(screen.getByText(/本应用不能恢复/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除记录" }).className).toContain("btn-danger");

    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(deleteStash).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /删除临时保存/ })).toBeNull();
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);

    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await screen.findByRole("dialog", { name: /删除临时保存/ });
    await fireEvent.click(screen.getByRole("button", { name: "删除记录" }));
    await vi.waitFor(() =>
      expect(deleteStash).toHaveBeenCalledWith("/repo", "cccccccccccccccccccccccccccccccccccccccc", true, 3, 2),
    );
  });

  it("关闭按钮让出任务 modal 槽位", async () => {
    const { onClose } = renderModal();
    await screen.findByRole("dialog");
    await fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("提交详情的上一个、下一个文件（R20）", () => {
  const files = ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, originalPath: null, status: "modified" }));

  beforeEach(() => {
    const only = commit(0);
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({ generation: 3, commit: only, body: "", root: false, merge: false, selectedParent: only.parents[0], files });
    commitFileDiff.mockImplementation(async (_repo: string, _oid: string, _parent: string, path: string) => ({ ...diff, path }));
  });

  const selectedFile = () => document.querySelector('.history-files .file-row[aria-selected="true"] .fn')?.textContent;

  it("切换提交等待新详情时不把旧文件列表重新发给后端", async () => {
    const first = commit(0);
    const second = commit(1);
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [first, second] });
    let finish: (value: unknown) => void = () => {};
    commitDetail.mockResolvedValueOnce({ generation: 3, commit: first, body: "", root: false, merge: false, selectedParent: first.parents[0], files })
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(selectedFile()).toBe("a.ts"));
    await fireEvent.click(screen.getByRole("button", { name: "下一个文件" }));
    await waitFor(() => expect(commitFileDiff.mock.calls.at(-1)?.[3]).toBe("b.ts"));
    commitFileDiff.mockClear();
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }));
    await tick();
    expect(commitFileDiff).not.toHaveBeenCalled();
    finish({ generation: 3, commit: second, body: "", root: false, merge: false, selectedParent: second.parents[0], files: [{ path: "other.ts", originalPath: null, status: "modified" }] });
    await waitFor(() => expect(commitFileDiff.mock.calls.at(-1)?.[3]).toBe("other.ts"));
    expect(commitFileDiff.mock.calls.at(-1)?.[1]).toBe(second.oid);
  });

  it("差异工具栏切换变更文件，列表同步，首尾不可用并说明原因", async () => {
    render(HistoryPanel, { props: panelProps() });
    const next = (await screen.findByRole("button", { name: "下一个文件" })) as HTMLButtonElement;
    const prev = screen.getByRole("button", { name: "上一个文件" }) as HTMLButtonElement;
    await waitFor(() => expect(selectedFile()).toBe("a.ts"));
    expect(prev.disabled).toBe(true);
    expect(prev.title).toBe("已经是第一个文件");

    await fireEvent.click(next);
    await waitFor(() => expect(selectedFile()).toBe("b.ts"));
    await waitFor(() => expect(commitFileDiff.mock.calls.at(-1)?.[3]).toBe("b.ts"));
    await fireEvent.click(next);
    await waitFor(() => expect(next.disabled).toBe(true));
    expect(next.title).toBe("已经是最后一个文件");
    await fireEvent.click(prev);
    await waitFor(() => expect(selectedFile()).toBe("b.ts"));
  });

  it("进入全部文件模式时列表高亮当前行，切回单文件接着看同一个文件", async () => {
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(selectedFile()).toBe("a.ts"));
    await fireEvent.click(screen.getByRole("button", { name: "下一个文件" }));
    await waitFor(() => expect(selectedFile()).toBe("b.ts"));
    await fireEvent.click(screen.getByRole("button", { name: /全部文件/ }));
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("b.ts"));
    expect(selectedFile()).toBe("b.ts");
    await fireEvent.click(document.querySelector<HTMLElement>(".commit-facts [aria-label='下一个文件']")!);
    await waitFor(() => expect(selectedFile()).toBe("c.ts"));
    await fireEvent.click(screen.getByRole("button", { name: /单文件/ }));
    await waitFor(() => expect(commitFileDiff.mock.calls.at(-1)?.[3]).toBe("c.ts"));
    expect(selectedFile()).toBe("c.ts");
  });

  it("全部文件模式下滚动时 multiFocus 跟随，列表高亮移动且不反过来滚动视图", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(selectedFile()).toBe("a.ts"));
    await fireEvent.click(screen.getByRole("button", { name: /全部文件/ }));
    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".history-multi-scroll");
      expect(element?.querySelector('[data-path="b.ts"]')).toBeTruthy();
      return element!;
    });
    await tick();
    const blocks = [...host.querySelectorAll<HTMLElement>("[data-path]")];
    const rectTop = (top: number) => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) });
    let tops = [-500, -10, 400];
    host.getBoundingClientRect = () => rectTop(0);
    blocks.forEach((block, index) => (block.getBoundingClientRect = () => rectTop(tops[index])));

    // 程序定位的滚动不跟踪：用户没动过时不改焦点。
    await fireEvent.scroll(host);
    expect(selectedFile()).toBe("a.ts");

    scrollIntoView.mockClear();
    await fireEvent.wheel(host);
    await fireEvent.scroll(host);
    await waitFor(() => expect(selectedFile()).toBe("b.ts"));
    await tick();
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(scrollIntoView, "滚动上报的焦点不再定位").not.toHaveBeenCalled();

    tops = [-900, -500, -20];
    await fireEvent.scroll(host);
    await waitFor(() => expect(selectedFile()).toBe("c.ts"));
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("从单文件进入全部文件后，折叠不被定位逻辑抢回，下一个文件仍能定位并展开", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const flush = async () => {
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
    };
    const expanded = () => document.querySelectorAll('.history-multi .multi-file-toggle[aria-expanded="true"]').length;
    try {
      render(HistoryPanel, { props: panelProps() });
      await waitFor(() => expect(selectedFile()).toBe("a.ts"));
      await fireEvent.click(screen.getByRole("button", { name: /全部文件/ }));
      await waitFor(() => expect(expanded()).toBe(3));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const located = () => (scrollIntoView.mock.contexts.at(-1) as HTMLElement | undefined)?.dataset.path;
      expect(located(), "进入时定位到当前文件").toBe("a.ts");

      // 全部收起：焦点文件也收得起来。
      await fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
      await flush();
      expect(expanded()).toBe(0);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
      await flush();
      expect(expanded()).toBe(3);

      // 单独折叠焦点文件和其它文件都不改滚动位置。
      const host = document.querySelector<HTMLElement>(".history-multi-scroll")!;
      host.scrollTop = 1063;
      await fireEvent.click(screen.getByRole("button", { name: "收起 a.ts" }));
      await flush();
      await fireEvent.click(screen.getByRole("button", { name: "收起 c.ts" }));
      await flush();
      expect(expanded()).toBe(1);
      expect(host.scrollTop).toBe(1063);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      // 换目标才再定位：下一个文件展开并滚到 b.ts，再下一个展开已收起的 c.ts。
      const next = within(document.querySelector<HTMLElement>(".commit-facts")!).getByRole("button", { name: "下一个文件" });
      await fireEvent.click(next);
      await flush();
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(located()).toBe("b.ts");
      await fireEvent.click(next);
      await flush();
      expect(scrollIntoView).toHaveBeenCalledTimes(3);
      expect(located()).toBe("c.ts");
      expect(screen.getByRole("button", { name: "收起 c.ts" }).getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("button", { name: "展开 a.ts" })).toBeTruthy();
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("把状态上报给外壳，全部文件模式也能切换并定位文件块", async () => {
    const onFileNav = vi.fn();
    render(HistoryPanel, { props: { ...panelProps(), onFileNav } });
    await screen.findByRole("button", { name: "下一个文件" });
    await waitFor(() => expect(onFileNav.mock.calls.at(-1)?.[0]).toMatchObject({ index: 0, total: 3, prevReason: "已经是第一个文件", nextReason: null }));

    await fireEvent.click(screen.getByRole("button", { name: /全部文件/ }));
    await waitFor(() => expect(document.querySelector(".history-multi")).toBeTruthy());
    const nav = within(document.querySelector<HTMLElement>(".commit-facts")!);
    await fireEvent.click(nav.getByRole("button", { name: "下一个文件" }));
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("b.ts"));
    expect(selectedFile()).toBe("b.ts");
    onFileNav.mock.calls.at(-1)?.[0].onNext();
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("c.ts"));
    expect(nav.getByRole("button", { name: "下一个文件" })).toHaveProperty("disabled", true);
  });
});

describe("历史分栏", () => {
  it("搜索、提交列表和分页在左栏，详情、变更文件和差异在主内容，差异模式在详情头部", async () => {
    const only = commit(0);
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({
      generation: 3,
      commit: only,
      body: "",
      root: false,
      merge: false,
      selectedParent: only.parents[0],
      files: [{ path: "notes.txt", originalPath: null, status: "added", additions: 2, deletions: 0 }],
    });
    commitFileDiff.mockResolvedValue(diff);
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());
    const pane = document.querySelector<HTMLElement>(".history-layout > .pane")!;
    const detail = document.querySelector<HTMLElement>(".history-layout > .history-detail")!;
    expect(within(pane).getByRole("textbox", { name: "搜索说明或提交哈希" })).toBeTruthy();
    expect(within(pane).getByRole("listbox", { name: "提交历史" })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "回到最新" })).toBeTruthy();
    expect(within(pane).getByText(/已加载最新 1–1 条/)).toBeTruthy();
    expect(pane.contains(document.querySelector(".commit-head")), "详情不进左栏").toBe(false);
    expect(within(detail).getByRole("group", { name: "历史差异模式" })).toBeTruthy();
    expect(detail.querySelector(".commit-files")).toBeTruthy();
    expect(detail.querySelector(".commit-diff")).toBeTruthy();
    const toggle = within(detail).getByRole("button", { name: "收起变更文件" });
    await fireEvent.click(toggle);
    expect(detail.querySelector(".commit-files.collapsed")).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "展开变更文件" }).getAttribute("aria-expanded")).toBe("false");
    const byline = detail.querySelector<HTMLElement>(".commit-byline")!;
    expect(byline.querySelector(".commit-parents"), "父提交并入作者行，详情头不再堆成一列").toBeTruthy();
    expect(byline.querySelector(".hr-dot"), "折行时不留孤立的分隔点").toBeNull();
    const fileRow = detail.querySelector<HTMLElement>(".history-files .file-row");
    expect(fileRow).toBeTruthy();
    expect(fileRow?.textContent).toContain("+2");
    expect(fileRow?.textContent).toContain("−0");
    expect(within(detail).getByRole("button", { name: "目录" }).getAttribute("aria-pressed")).toBe("false");
    await fireEvent.contextMenu(fileRow!);
    expect(screen.queryByRole("menuitem", { name: "加入 .gitignore" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "加入 .git/info/exclude" })).toBeNull();
  });

  describe("说明按实际溢出决定展开入口", () => {
    let overflow = { scrollWidth: 300, clientWidth: 300 };
    let observed: (() => void)[] = [];

    beforeEach(() => {
      overflow = { scrollWidth: 300, clientWidth: 300 };
      observed = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private callback: () => void) {
            observed.push(callback);
          }
          observe() {}
          disconnect() {
            observed = observed.filter((callback) => callback !== this.callback);
          }
        },
      );
      for (const key of ["scrollWidth", "clientWidth"] as const) {
        vi.spyOn(HTMLElement.prototype, key, "get").mockImplementation(function (this: HTMLElement) {
          if (key === "scrollWidth") return this.matches(".commit-body") ? overflow.scrollWidth : 0;
          return this.matches(".commit-body-row") ? overflow.clientWidth : 0;
        });
      }
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    async function renderBody(body: string) {
      const only = { ...commit(0), summary: "概要" };
      historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
      commitDetail.mockResolvedValue({ generation: 3, commit: only, body, root: false, merge: false, selectedParent: only.parents[0], files: [] });
      render(HistoryPanel, { props: panelProps() });
      await waitFor(() => expect(document.querySelector(".commit-body")).toBeTruthy());
    }

    const entry = () => screen.queryByRole("button", { name: "展开完整说明" });
    const resize = async (scrollWidth: number, clientWidth: number) => {
      overflow = { scrollWidth, clientWidth };
      for (const callback of observed) callback();
      await tick();
    };

    it("两行说明连成一行放得下时不给入口，内容都在可见文本里", async () => {
      await renderBody("概要\n\n第一行\n第二行");
      expect(document.querySelector(".commit-body.clamped")?.textContent).toContain("第二行");
      expect(entry()).toBeNull();
    });

    it("两行说明放不下时给入口", async () => {
      overflow = { scrollWidth: 500, clientWidth: 300 };
      await renderBody("概要\n\n第一行\n第二行");
      expect(entry()).toBeTruthy();
    });

    it("单行说明在窄宽下被截断也给入口，宽窄切换时重算", async () => {
      await renderBody("概要\n\n一行比较长的说明");
      expect(entry()).toBeNull();
      await resize(500, 200);
      expect(entry(), "变窄后截断").toBeTruthy();
      await resize(500, 700);
      expect(entry(), "变宽后放得下，入口按钮占过的宽度不算").toBeNull();
    });

    it("展开后能收起，展开期间不重新测量，收起后按当前宽度重算", async () => {
      overflow = { scrollWidth: 500, clientWidth: 300 };
      await renderBody("概要\n\n一行比较长的说明");
      await fireEvent.click(entry()!);
      expect(document.querySelector(".commit-body.clamped")).toBeNull();
      const collapse = screen.getByRole("button", { name: "收起说明" });
      overflow = { scrollWidth: 300, clientWidth: 300 };
      await fireEvent.click(collapse);
      await tick();
      expect(document.querySelector(".commit-body.clamped")).toBeTruthy();
      expect(entry(), "现在放得下，不留入口").toBeNull();
    });
  });

  it("长说明默认折叠", async () => {
    const only = {
      oid: "c".repeat(40), summary: "概要", authorName: "A", authorEmail: "a@e.com", authoredAt: 1, parents: ["d".repeat(40)], labels: [],
    };
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({
      generation: 3,
      commit: only,
      body: "概要\n\n第一行\n第二行\n第三行",
      root: false,
      merge: false,
      selectedParent: only.parents[0],
      files: [],
    });
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(document.querySelector(".commit-body.clamped")).toBeTruthy());
  });
});

describe("只读差异", () => {
  it("历史差异不提供暂存，并可以进入文件历史", async () => {
    const selection: FileSelection = { path: "notes.txt", side: "unstaged" };
    const readOnlyDiff: DiffResponse = {
      ...diff,
      hunks: [{ index: 0, header: "@@ -1 +1 @@", complete: true, stageable: true, startLine: 0, lineCount: 1 }],
    };
    let openedPath = "";
    render(DiffView, {
      props: {
        selection,
        diff: readOnlyDiff,
        error: null,
        loading: false,
        disabled: false,
        readOnly: true,
        onStageHunk: () => {},
        onLoadMore: () => {},
        onFileHistory: (path: string) => {
          openedPath = path;
        },
      },
    });
    expect(screen.queryByRole("button", { name: "暂存此块" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "此文件历史" }));
    expect(openedPath).toBe("notes.txt");
  });

  it("详情标明历史是只读的，复制完整标识有可读反馈", async () => {
    const only = commit(0);
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only],
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: only, body: "", root: false, merge: false, selectedParent: only.parents[0],
      files: [{ path: "notes.txt", originalPath: null, status: "modified", additions: 1, deletions: 0 }],
    });
    commitFileDiff.mockResolvedValue(diff);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());

    const chip = document.querySelector<HTMLElement>(".commit-byline .read-only-chip")!;
    expect(chip.textContent?.trim()).toBe("只读");
    expect(chip.title, "禁用/只读原因不用悬停也能读到").toContain("不切换分支");

    const live = document.querySelector<HTMLElement>(".commit-facts [aria-live]")!;
    expect(live.textContent, "还没复制时不播报").toBe("");
    await fireEvent.click(screen.getByRole("button", { name: "复制完整提交标识" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(only.oid));
    expect(live.textContent).toBe("已复制提交 " + shortOid(only.oid));
  });

  it("不显示 Git 文件头，块标题换成行号与所在函数，按块暂存仍对准原始块", async () => {
    const selection: FileSelection = { path: "notes.txt", side: "unstaged" };
    const withHeaders: DiffResponse = {
      ...diff,
      totalLines: 7,
      hunks: [{ index: 0, header: "@@ -68,6 +68,7 @@ fn render()", complete: true, stageable: true, startLine: 4, lineCount: 3 }],
      lines: [
        { kind: "meta", text: "diff --git a/notes.txt b/notes.txt", oldNo: null, newNo: null, hunkIndex: null },
        { kind: "meta", text: "index 833f1f8..b476ae7 100644", oldNo: null, newNo: null, hunkIndex: null },
        { kind: "meta", text: "--- a/notes.txt", oldNo: null, newNo: null, hunkIndex: null },
        { kind: "meta", text: "+++ b/notes.txt", oldNo: null, newNo: null, hunkIndex: null },
        { kind: "hunk", text: "@@ -68,6 +68,7 @@ fn render()", oldNo: null, newNo: null, hunkIndex: 0 },
        { kind: "context", text: " keep", oldNo: 68, newNo: 68, hunkIndex: 0 },
        { kind: "add", text: "+added", oldNo: null, newNo: 69, hunkIndex: 0 },
      ],
    };
    const staged: number[] = [];
    const view = render(DiffView, {
      props: {
        selection,
        diff: withHeaders,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: (hunk: { index: number }) => staged.push(hunk.index),
        onLoadMore: () => {},
      },
    });
    const text = view.container.querySelector(".diff-scroll")?.textContent ?? "";
    expect(text).not.toContain("diff --git");
    expect(text).not.toContain("index 833f1f8");
    expect(text).not.toContain("+++ b/notes.txt");
    expect(text).not.toContain("@@");
    expect(text).toContain("第 68–74 行");
    expect(text).toContain("fn render()");
    await fireEvent.click(screen.getByRole("button", { name: "暂存此块" }));
    expect(staged).toEqual([0]);
  });
});
