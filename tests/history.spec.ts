import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DiffView from "../src/lib/components/DiffView.svelte";
import {
  commitFileLabel,
  commitLineTotalLabel,
  commitLineTotals,
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
const undoCommit = vi.hoisted(() => vi.fn());
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
    undoCommit,
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

describe("提交行数合计", () => {
  it("只累计有完整行数的文本文件，二进制与缺失统计记为未计入", () => {
    const totals = commitLineTotals([
      { additions: 2, deletions: 1 },
      { additions: 3, deletions: 0 },
      { additions: null, deletions: null, binary: true },
      { additions: 4, deletions: null },
      { additions: null, deletions: null },
    ]);
    expect(totals).toMatchObject({ additions: 5, deletions: 1, counted: 2, skipped: 3 });
    const label = commitLineTotalLabel(totals!);
    expect(label).toContain("这次提交新增 5 行，删除 1 行");
    expect(label).toContain("3 个文件未计入合计");
    expect(commitLineTotalLabel(totals!, "所选提交合计")).toContain("所选提交合计新增 5 行");
    const incomplete = commitLineTotalLabel(totals!, "所选提交合计", 1);
    expect(incomplete).toContain("1 个提交的详情未读取，合计不完整");
  });

  it("全部文件都不可统计时不给合计，不伪造 +0 −0", () => {
    expect(commitLineTotals([])).toBeNull();
    expect(commitLineTotals([{ additions: null, deletions: null, binary: true }])).toBeNull();
    expect(commitLineTotals([{ additions: 1, deletions: null }])).toBeNull();
    expect(commitLineTotals([{ additions: 0, deletions: 0 }])).toMatchObject({ counted: 1, skipped: 0 });
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

  it("历史右键撤销只针对 HEAD，先预览再确认且保留改动", async () => {
    const head = commit(0, { oid: opened.snapshot.branch.headOid! });
    historyPage.mockResolvedValue({ generation: 3, commits: [head, commit(1)], hasMore: false, offset: 0, pageSize: 100, state: "ok" });
    undoCommit.mockResolvedValueOnce({ generation: 3, eligible: true, headOid: head.oid, summary: head.summary, reason: "尚未推送", snapshot: opened.snapshot });
    undoCommit.mockResolvedValueOnce({ generation: 4, eligible: true, reason: "改动保留在暂存区", snapshot: { ...opened.snapshot, generation: 4 } });
    const onSnapshot = vi.fn();
    render(HistoryPanel, { ...panelProps(), onSnapshot });
    await fireEvent.contextMenu(await screen.findByRole("option", { name: /commit-1/ }));
    expect(screen.getByRole("menuitem", { name: "撤销最近提交并保留改动" }).getAttribute("aria-disabled")).toBe("true");
    await fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await fireEvent.contextMenu(screen.getByRole("option", { name: /commit-0/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "撤销最近提交并保留改动" }));
    await screen.findByRole("button", { name: "确认撤销提交" });
    expect(undoCommit).toHaveBeenCalledWith("/repo", head.oid, false, 3, 1);
    expect(onSnapshot).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "确认撤销提交" }));
    await waitFor(() => expect(undoCommit).toHaveBeenCalledWith("/repo", head.oid, true, 3, 1));
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ generation: 4 }));
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

  it("刷新（generation 变化但浏览条件不变）不把历史列表拉回顶部（R3）", async () => {
    const commits = Array.from({ length: 100 }, (_, index) => commit(index));
    historyPage.mockResolvedValue({
      generation: 3,
      query: "",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "ok",
      commits,
    });
    const view = render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    const list = document.querySelector<HTMLElement>(".history-list")!;
    expect(list).toBeTruthy();
    // 给出视口高度并滚到列表中部，模拟用户已经向下浏览。
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 520 });
    list.scrollTop = 1300;
    await fireEvent.scroll(list);
    expect(list.scrollTop).toBe(1300);

    // 刷新：同一仓库、同样的搜索/筛选，只有 generation 从 3 变成 4（refreshStatus 后 App 会 bump）。
    historyPage.mockResolvedValue({
      generation: 4,
      query: "",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "ok",
      commits,
    });
    await view.rerender({ ...panelProps(), opened: { ...opened, generation: 4, snapshot: { ...opened.snapshot, generation: 4 } } });
    await waitFor(() => expect(historyPage).toHaveBeenCalledWith("/repo", "", 0, 4, 1));
    await tick();

    // 同一个列表节点，滚动位置保留，没有被刷新拉回顶部。
    expect(document.querySelector(".history-list")).toBe(list);
    expect(list.scrollTop).toBe(1300);
  });

  it("切换搜索条件时历史列表回到顶部（与刷新区分）", async () => {
    vi.useFakeTimers();
    try {
      const commits = Array.from({ length: 100 }, (_, index) => commit(index));
      historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits });
      render(HistoryPanel, { props: panelProps() });
      await vi.runAllTimersAsync();
      const list = document.querySelector<HTMLElement>(".history-list")!;
      Object.defineProperty(list, "clientHeight", { configurable: true, value: 520 });
      list.scrollTop = 1300;
      await fireEvent.scroll(list);
      expect(list.scrollTop).toBe(1300);

      // 真正改变浏览条件（搜索关键词）后应回到顶部。
      historyPage.mockResolvedValue({ generation: 3, query: "needle", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits });
      await fireEvent.input(screen.getByLabelText("搜索说明或提交哈希"), { target: { value: "needle" } });
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
      expect(historyPage).toHaveBeenCalledWith("/repo", "needle", 0, 3, 1);
      expect(list.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
    expect(names()).toEqual(["当前分支（main）", "未推送的提交", "全部分支", "main"]);
    expect(groups()).toEqual(["feature", "fix"]);
    await fireEvent.click(screen.getByRole("button", { name: "展开分组 feature" }));
    expect(names()).toEqual(["当前分支（main）", "未推送的提交", "全部分支", "main", "feature/a", "feature/b"]);
    await fireEvent.keyDown(screen.getByLabelText("搜索历史范围"), { key: "Escape" });

    await view.rerender({ ...panelProps(), branchGroups: false });
    await fireEvent.click(trigger());
    expect(groups()).toEqual([]);
    expect(names()).toEqual(["当前分支（main）", "未推送的提交", "全部分支", "main", "feature/a", "feature/b", "fix/x"]);
    historyPage.mockClear();
    await fireEvent.click(screen.getByRole("option", { name: "fix/x" }));
    expect(trigger().dataset.value).toBe("fix/x");
    await waitFor(() => expect(historyPage).toHaveBeenCalled());
    expect(JSON.stringify(historyPage.mock.calls.at(-1))).toContain("fix/x");
  });

  it("范围可选「未推送的提交」：按 unpushed 读取，没有结果时说明都已推送", async () => {
    historyPage.mockResolvedValue({
      generation: 3,
      query: "",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "ok",
      commits: [commit(0)],
      scope: "current",
      branches: ["main"],
      head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    const trigger = () => screen.getByRole("button", { name: "历史范围" });
    await waitFor(() => expect(trigger().textContent).toContain("当前分支（main）"));
    historyPage.mockClear();
    historyPage.mockResolvedValue({
      generation: 3,
      query: "",
      offset: 0,
      pageSize: 100,
      hasMore: false,
      state: "no_match",
      commits: [],
      scope: "unpushed",
      branches: ["main"],
      head: "main",
    });
    await fireEvent.click(trigger());
    await fireEvent.click(screen.getByRole("option", { name: "未推送的提交" }));
    expect(trigger().dataset.value).toBe("unpushed");
    await waitFor(() => expect(historyPage).toHaveBeenCalled());
    expect(JSON.stringify(historyPage.mock.calls.at(-1))).toContain("unpushed");
    expect(await screen.findByText("当前分支没有未推送的提交。")).toBeTruthy();
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

  it("分页按钮把「已在最新」写成可见文案，不只在 title 里", async () => {
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
    const newest = screen.getByRole<HTMLButtonElement>("button", { name: "已在最新" });
    // 禁用按钮不进 Tab，所以原因必须是可见文案；title 只作补充。
    expect(newest.textContent?.trim()).toBe("已在最新");
    expect(newest.disabled, "已经在最新一条提交").toBe(true);
    expect(newest.title).toBe("已经在最新一条提交");
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
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
    // 状态写进可见文案：不是可执行的「回到最新」，而是「已在最新」，禁用原因不用悬停就能读到。
    const atNewest = () => screen.getByRole<HTMLButtonElement>("button", { name: "已在最新" });
    const backToNewest = () => screen.getByRole<HTMLButtonElement>("button", { name: "回到最新" });
    expect(screen.queryByRole("button", { name: "回到最新" }), "已经在最新时不摆出可执行的动作").toBeNull();
    expect(atNewest().disabled, "已经在顶部时没有可做的事").toBe(true);
    expect(atNewest().textContent?.trim()).toBe("已在最新");
    expect(atNewest().title).toBe("已经在最新一条提交");

    list.scrollTop = 320;
    await fireEvent.scroll(list);
    expect(backToNewest().disabled, "离开顶部后可以回到最新").toBe(false);
    expect(backToNewest().textContent?.trim()).toBe("回到最新");

    await view.rerender({ ...panelProps(), active: false });
    await view.rerender({ ...panelProps(), active: true });
    await waitFor(() => expect(historyPage).toHaveBeenCalledTimes(2));
    // 等实际状态，而不是等调用次数：读取队列把结果应用回容器需要一次渲染。
    await waitFor(() => expect(list.scrollTop, "切走再切回同一个浏览位置不回到顶部").toBe(320));
    expect(backToNewest().disabled, "回到浏览位置后按钮仍是可执行的「回到最新」").toBe(false);

    // generation 变了（暂存、外部写入、刷新）但浏览条件没变：这是同一批浏览，刷新不该把列表拉回顶部（R3）。
    const bumped = { ...opened, generation: 4, snapshot: { ...opened.snapshot, generation: 4 } };
    await view.rerender({ ...panelProps(), opened: bumped, active: true });
    await waitFor(() => expect(historyPage).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(list.scrollTop, "generation 变化（刷新）不回到顶部").toBe(320));

    list.scrollTop = 160;
    await fireEvent.scroll(list);
    await waitFor(() => expect(list.scrollTop).toBe(160));
    await view.rerender({ ...panelProps("notes.txt"), opened: bumped, active: true });
    await waitFor(() => expect(fileHistory).toHaveBeenCalledWith("/repo", "notes.txt", 0, 4, 1));
    await waitFor(() => expect(list.scrollTop, "换了读取条件回到顶部").toBe(0));
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

  it("搜索框向下和回车进入提交列表，第一条向上回到搜索框", async () => {
    const rows = [commit(0), commit(1)];
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: rows[0], body: "", root: false, merge: false, selectedParent: "parent", files: [],
    });
    render(HistoryPanel, { props: panelProps() });
    const search = await screen.findByRole("textbox", { name: "搜索说明或提交哈希" });
    const list = screen.getByRole("listbox", { name: "提交历史" });
    await screen.findByRole("option", { name: /commit-0/ });
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");

    search.focus();
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /commit-1/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(list);

    await fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");
    await fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(search, { key: "Enter" });
    expect(document.activeElement).toBe(list);
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");

    await fireEvent.input(search, { target: { value: "fix" } });
    expect(search).toHaveProperty("value", "fix");
    await fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveProperty("value", "");
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
    // 禁用项把原因写在条目里，整条 textContent 不再是名称；顺序按 .context-label 读。
    expect(screen.getAllByRole("menuitem").map((item) => item.querySelector(".context-label")?.textContent)).toEqual([
      "拣选到当前分支",
      "检出此提交",
      "撤销最近提交并保留改动",
      "从此提交新建分支",
      "复制提交哈希",
    ]);
    // 原因本身仍然可见，并且和条目通过 aria-describedby 关联。
    const disabled = screen.getByRole("menuitem", { name: "撤销最近提交并保留改动" });
    const reason = disabled.querySelector(".context-copy small");
    expect(reason?.textContent).toBe("只能撤销当前分支的最近一次提交");
    expect(disabled.getAttribute("aria-describedby")).toBe(reason?.id);
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
    expect(screen.getAllByRole("menuitem").map((item) => item.querySelector(".context-label")?.textContent)).toEqual([
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

  it("单提交标题合计只统计文本文件，并说明未计入的文件", async () => {
    const only = commit(0);
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only],
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: only, body: "", root: false, merge: false, selectedParent: only.parents[0],
      files: [
        { path: "a.txt", originalPath: null, status: "modified", additions: 3, deletions: 1 },
        { path: "b.txt", originalPath: null, status: "added", additions: 2, deletions: 0 },
        { path: "logo.png", originalPath: null, status: "modified", binary: true, additions: null, deletions: null },
        { path: "missing.txt", originalPath: null, status: "modified", additions: null, deletions: null },
      ],
    });
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(document.querySelector(".commit-files-head .commit-line-total")).toBeTruthy());
    const total = document.querySelector<HTMLElement>(".commit-files-head .commit-line-total")!;
    expect(total.textContent?.replace(/\s+/g, "")).toBe("+5−1");
    expect(total.getAttribute("aria-label")).toBe("这次提交新增 5 行，删除 1 行；另有 2 个文件未计入合计（二进制或没有行数统计）");
  });

  it("单提交全部文件都不可统计时不显示合计", async () => {
    const only = commit(0);
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only],
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: only, body: "", root: false, merge: false, selectedParent: only.parents[0],
      files: [
        { path: "logo.png", originalPath: null, status: "modified", binary: true },
        { path: "size.txt", originalPath: null, status: "modified", additions: null, deletions: null },
      ],
    });
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());
    expect(document.querySelector(".commit-line-total"), "全部不可统计时不留 +0 −0").toBeNull();
  });

  it("多提交标题合计按逐文件累计口径计算，滚动只改渲染行、选择变化同步更新", async () => {
    const rows = [commit(0), commit(1), commit(2)];
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    const filesByOid: Record<string, unknown[]> = {
      [rows[0].oid]: [
        { path: "src/a.txt", originalPath: null, status: "modified", additions: 2, deletions: 1 },
        { path: "b.txt", originalPath: null, status: "added", additions: 1, deletions: 0 },
      ],
      [rows[1].oid]: [
        { path: "src/a.txt", originalPath: null, status: "modified", additions: 3, deletions: 2 },
        { path: "logo.png", originalPath: null, status: "modified", binary: true },
      ],
      [rows[2].oid]: [
        { path: "missing.txt", originalPath: null, status: "modified", additions: null, deletions: null },
      ],
    };
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3,
      commit: rows.find((item) => item.oid === oid),
      body: "",
      root: false,
      merge: false,
      selectedParent: "parent",
      files: filesByOid[oid] ?? [],
    }));
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await fireEvent.click(screen.getByRole("option", { name: /commit-2/ }), { shiftKey: true });
    expect(await screen.findByText("已选择 3 个提交")).toBeTruthy();
    const total = () => document.querySelector<HTMLElement>(".commit-files-head .commit-line-total");
    await waitFor(() => expect(total()).toBeTruthy());
    expect(total()!.textContent?.replace(/\s+/g, "")).toBe("+6−3");
    expect(total()!.getAttribute("aria-label")).toBe(
      "所选提交合计新增 6 行，删除 3 行；另有 2 个文件未计入合计（二进制或没有行数统计）",
    );

    // 滚到虚拟窗口之外（没有可见行）时，合计仍取完整并集，不随渲染范围收缩。
    const files = await screen.findByRole("listbox", { name: "提交中的文件列表" });
    Object.defineProperty(files, "clientHeight", { configurable: true, value: 30 });
    files.scrollTop = 900;
    await fireEvent.scroll(files);
    expect(document.querySelectorAll(".history-union-files .file-row").length).toBe(0);
    expect(total()!.textContent?.replace(/\s+/g, "")).toBe("+6−3");

    await fireEvent.click(screen.getByRole("button", { name: /退出多选/ }));
    await waitFor(() => expect(total()?.getAttribute("aria-label")).toContain("这次提交新增 3 行，删除 1 行"));
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("多选读取期间显示加载，不把空并集当没有文件变化；部分失败标注合计不完整", async () => {
    const rows = [commit(0), commit(1), commit(2)];
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledTimes(1));
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
    commitDetail.mockImplementation((_repo: string, oid: string) => new Promise((resolve, reject) => {
      pending.set(oid, { resolve, reject });
    }));

    await fireEvent.click(screen.getByRole("option", { name: /commit-2/ }), { shiftKey: true });
    expect(await screen.findByText("已选择 3 个提交")).toBeTruthy();
    expect(await screen.findByText("正在读取提交中的文件")).toBeTruthy();
    expect(screen.getByText("正在读取所选提交的详情")).toBeTruthy();
    expect(screen.queryByText("这些提交没有文件变化。"), "读取期间不是终态空结果").toBeNull();
    expect(document.querySelector(".commit-line-total"), "读取期间不显示不完整合计").toBeNull();
    expect(document.querySelector(".commit-files-head .count"), "读取期间不摆出 0 个文件").toBeNull();

    const detailOf = (index: number, path: string, additions: number, deletions: number) => ({
      generation: 3, commit: rows[index], body: "", root: false, merge: false, selectedParent: "parent",
      files: [{ path, originalPath: null, status: "modified", additions, deletions }],
    });
    pending.get(rows[0].oid)!.resolve(detailOf(0, "a.txt", 2, 1));
    pending.get(rows[1].oid)!.reject({ code: "detail_failed", message: "提交详情读取失败。" });
    await waitFor(() => expect(pending.has(rows[2].oid)).toBe(true));
    pending.get(rows[2].oid)!.resolve(detailOf(2, "b.txt", 1, 0));

    await waitFor(() => expect(screen.queryByText("正在读取提交中的文件")).toBeNull());
    expect(screen.queryByText("这些提交没有文件变化。")).toBeNull();
    expect(await screen.findByText(/提交详情读取失败。/)).toBeTruthy();
    expect(screen.getByText(/未读取的提交没有计入文件范围和合计/)).toBeTruthy();
    const total = () => document.querySelector<HTMLElement>(".commit-files-head .commit-line-total");
    await waitFor(() => expect(total()).toBeTruthy());
    expect(total()!.textContent?.replace(/\s+/g, "")).toBe("+3−1");
    expect(total()!.getAttribute("aria-label")).toContain("1 个提交的详情未读取，合计不完整");
    expect([...document.querySelectorAll(".history-union-files .file-row")].map((node) => node.textContent))
      .toEqual([expect.stringContaining("a.txt"), expect.stringContaining("b.txt")]);
  });

  it("多选详情全部读取失败时不冒充没有文件变化", async () => {
    const rows = [commit(0), commit(1)];
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows,
      scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledTimes(1));
    const pending = new Map<string, { reject: (reason?: unknown) => void }>();
    commitDetail.mockImplementation((_repo: string, oid: string) => new Promise((_resolve, reject) => {
      pending.set(oid, { reject });
    }));

    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }), { shiftKey: true });
    expect(await screen.findByText("已选择 2 个提交")).toBeTruthy();
    await waitFor(() => expect(pending.size).toBe(2));
    for (const item of pending.values()) item.reject({ code: "detail_failed", message: "读取失败。" });

    expect(await screen.findByText("有提交详情没读取成功，无法确认文件范围。")).toBeTruthy();
    expect(screen.queryByText("这些提交没有文件变化。")).toBeNull();
    expect(document.querySelector(".commit-line-total")).toBeNull();
    expect(screen.getByText(/读取失败。/)).toBeTruthy();
  });

  it("多选边读边显示首份文件和差异，补齐详情不会重复读取已有差异", async () => {
    const rows = [commit(0), commit(1), commit(2)];
    commitFileDiff.mockResolvedValue({ ...diff, path: "demo.txt" });
    historyPage.mockResolvedValue({ generation: 3, commits: rows, offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledOnce());
    const pending = new Map<string, (value: unknown) => void>();
    commitDetail.mockImplementation((_repo, oid) => new Promise((resolve) => pending.set(oid, resolve)));
    await fireEvent.click(screen.getByRole("option", { name: /commit-2/ }), { shiftKey: true });
    await waitFor(() => expect(pending.size).toBe(2));
    const detailOf = (index: number) => ({
      generation: 3, commit: rows[index], body: "", root: false, merge: false, selectedParent: "parent",
      files: [{ path: "demo.txt", originalPath: null, status: "modified", additions: 2, deletions: 1 }],
    });
    pending.get(rows[1].oid)!(detailOf(1));
    await screen.findByRole("listbox", { name: "提交中的文件列表" });
    await waitFor(() => expect(document.querySelector(".union-block [data-diff-row]")).toBeTruthy());
    expect(screen.getByText("已读取 1/3 个提交")).toBeTruthy();
    expect(document.querySelector(".commit-line-total")).toBeNull();
    expect(commitFileDiff.mock.calls.filter((call) => call[1] === rows[1].oid)).toHaveLength(1);
    await waitFor(() => expect(pending.size).toBe(3));
    const earlier = detailOf(0);
    earlier.files.unshift({ ...earlier.files[0], path: "aaa.txt" });
    pending.get(rows[0].oid)!(earlier);
    pending.get(rows[2].oid)!(detailOf(2));
    await waitFor(() => expect(document.querySelectorAll(".union-block")).toHaveLength(3));
    expect(commitFileDiff.mock.calls.filter((call) => call[1] === rows[1].oid)).toHaveLength(1);
    expect(commitFileDiff.mock.calls.every((call) => call[3] === "demo.txt")).toBe(true);
  });

  it("切换仓库时不拿旧选择向新仓库查询提交", async () => {
    historyPage.mockResolvedValue({ generation: 3, commits: [commit(0)], offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    const onFailure = vi.fn();
    const view = render(HistoryPanel, { props: { ...panelProps(), onFailure } });
    await screen.findByRole("option", { name: /commit-0/ });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledOnce());
    let finish!: (value: unknown) => void;
    historyPage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    commitDetail.mockClear();
    await view.rerender({ ...panelProps(), onFailure, opened: { ...opened, summary: { name: "other", path: "/other" } } });
    expect(commitDetail).not.toHaveBeenCalled();
    finish({ generation: 3, commits: [commit(8)], offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    await waitFor(() => expect(commitDetail).toHaveBeenCalledWith("/other", commit(8).oid, null, 3, 1));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("首次读取历史时只显示加载状态，不先报未选择或空历史", async () => {
    let finish: (value: unknown) => void = () => {};
    historyPage.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByText("正在读取历史")).toBeTruthy();
    expect(screen.queryByText("未选择提交")).toBeNull();
    expect(screen.queryByText("这一页没有提交。")).toBeNull();
    expect(screen.queryByText("历史没有读取成功。")).toBeNull();

    finish({ generation: 3, commits: [commit(0)], offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("正在读取历史")).toBeNull());
  });

  it("重新读取时保留旧提交并安静上报进行中，不在面板里插横条，完成后换成新结果", async () => {
    const first = commit(0);
    historyPage.mockResolvedValueOnce({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [first],
      scope: "current", branches: ["main"], head: "main",
    });
    let finish: (value: unknown) => void = () => {};
    const onActivity = vi.fn();
    const view = render(HistoryPanel, { props: { ...panelProps(), onActivity } });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    // 首次读取有自己的空状态，不算后台活动。
    await waitFor(() => expect(onActivity).toHaveBeenLastCalledWith(false));
    const infobars = () => document.querySelectorAll(".history-view .infobar").length;
    const before = infobars();

    historyPage.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const bumped = { ...opened, generation: 4, snapshot: { ...opened.snapshot, generation: 4 } };
    await view.rerender({ ...panelProps(), onActivity, opened: bumped });
    await waitFor(() => expect(onActivity).toHaveBeenLastCalledWith(true));
    // 刷新不在列表上方插横条，列表和详情不会被上下挤动。
    expect(infobars()).toBe(before);
    expect(screen.queryByText(/正在重新读取历史/)).toBeNull();
    expect(screen.getByRole("option", { name: /commit-0/ }), "旧提交在等待期间仍可读").toBeTruthy();

    finish({ generation: 4, commits: [commit(1)], offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    expect(await screen.findByRole("option", { name: /commit-1/ })).toBeTruthy();
    await waitFor(() => expect(onActivity).toHaveBeenLastCalledWith(false));
  });

  it("重新读取失败保留旧提交并说明原因，重新读取可恢复", async () => {
    historyPage.mockResolvedValueOnce({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [commit(0)],
      scope: "current", branches: ["main"], head: "main",
    });
    historyPage.mockRejectedValueOnce({ code: "history_failed", message: "读取历史失败。" });
    const view = render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();

    const bumped = { ...opened, generation: 4, snapshot: { ...opened.snapshot, generation: 4 } };
    await view.rerender({ ...panelProps(), opened: bumped });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("读取历史失败。")).toBeTruthy();
    expect(screen.getByRole("option", { name: /commit-0/ }), "失败不清空仍可用于判断的旧内容").toBeTruthy();

    historyPage.mockResolvedValueOnce({
      generation: 4, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [commit(1)],
      scope: "current", branches: ["main"], head: "main",
    });
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByRole("option", { name: /commit-1/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("读取历史失败。")).toBeNull());
  });

  it("详情读取失败不冒充未选择，并可原地重试", async () => {
    const only = commit(0);
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only],
      scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockRejectedValueOnce({ code: "detail_failed", message: "提交详情读取失败。" });
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByText("提交详情读取失败。")).toBeTruthy();
    expect(screen.queryByText("未选择提交"), "失败不是未选择").toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());
    expect(screen.queryByText("提交详情读取失败。")).toBeNull();
  });

  it("首次读取失败与空结果区分，并提供重试", async () => {
    historyPage.mockRejectedValue({ code: "history_failed", message: "读取历史失败。" });
    render(HistoryPanel, { props: panelProps() });
    expect(await screen.findByText("历史没有读取成功。")).toBeTruthy();
    expect(screen.getByText("读取历史失败。")).toBeTruthy();
    expect(screen.queryByText("这一页没有提交。")).toBeNull();
    expect(screen.queryByText("未选择提交")).toBeNull();
    historyPage.mockResolvedValueOnce({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [commit(0)],
      scope: "current", branches: ["main"], head: "main",
    });
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("历史没有读取成功。")).toBeNull();
  });

  it("无效日期归为筛选条件问题，不提供必然失败的重试", async () => {
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [commit(0)], scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    await fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));
    await fireEvent.input(screen.getByLabelText("开始日期"), { target: { value: "2024-01-03" } });
    await fireEvent.input(screen.getByLabelText("结束日期"), { target: { value: "2024-01-02" } });

    expect(await screen.findByText("筛选条件无效，未读取历史。")).toBeTruthy();
    expect(screen.getByText("开始日期晚于结束日期，未读取历史，仓库没有改动。")).toBeTruthy();
    expect(screen.queryByText("历史没有读取成功。"), "本地校验不是读取失败").toBeNull();
    expect(screen.queryByRole("button", { name: "重新读取" }), "条件没变时重试是死路").toBeNull();
    expect(screen.queryByRole("option", { name: /commit-0/ })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "清除筛选条件" }));
    await waitFor(() => expect(screen.queryByText("筛选条件无效，未读取历史。")).toBeNull());
    expect(await screen.findByRole("option", { name: /commit-0/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /commit-0/ }).getAttribute("aria-selected")).toBe("true");
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
    expect(within(pane).getByRole("button", { name: "已在最新" })).toBeTruthy();
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

  it("提交差异可以查看完整文件：切换交给外壳，开启后按整份文件重新读取", async () => {
    const only = commit(0);
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({
      generation: 3,
      commit: only,
      body: "",
      root: false,
      merge: false,
      selectedParent: only.parents[0],
      files: [{ path: "notes.txt", originalPath: null, status: "modified", additions: 2, deletions: 0 }],
    });
    commitFileDiff.mockResolvedValue(diff);
    const onFullFile = vi.fn();
    const view = render(HistoryPanel, { props: { ...panelProps(), fullFile: false, onFullFile } });
    await waitFor(() => expect(commitFileDiff).toHaveBeenCalled());
    expect(commitFileDiff.mock.calls.at(-1)?.length, "默认读取不追加上下文参数").toBe(8);
    // 宽工具条直接给入口，窄时收进「更多差异工具」；两处共用同一个切换。
    const inline = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".diff-toolbar .diff-full-toggle");
      if (button) return button;
      throw new Error("没有完整文件入口");
    });
    await fireEvent.click(inline);
    expect(onFullFile).toHaveBeenCalledWith(true);
    commitFileDiff.mockClear();
    await view.rerender({ ...panelProps(), fullFile: true, onFullFile });
    await waitFor(() => expect(commitFileDiff).toHaveBeenCalled());
    expect(commitFileDiff.mock.calls.at(-1)?.[8]).toBe(1_000_000);
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

describe("历史拓扑面板", () => {
  const headOid = opened.snapshot.branch.headOid!;
  const midOid = commit(1).oid;
  const rootOid = commit(2).oid;

  function rowOf(oid: string): HTMLElement {
    return document.getElementById("history-commit-" + oid) as HTMLElement;
  }
  function labelOf(oid: string): string {
    return document.getElementById("history-graph-" + oid)?.textContent ?? "";
  }
  /** 拓扑画在行外的绘图层里，按提交 Hash 找到本行那一段。 */
  function graphOf(oid: string): HTMLElement {
    return document.querySelector(`.hr-graph[data-graph-oid="${oid}"]`) as HTMLElement;
  }
  function pathsOf(oid: string): string[] {
    return [...graphOf(oid).querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
  }
  function detailCalls(oid: string): number {
    return commitDetail.mock.calls.filter((call) => call[1] === oid).length;
  }

  beforeEach(() => {
    historyPage.mockReset();
    commitDetail.mockReset();
    commitFileDiff.mockReset();
    fileHistory.mockReset();
    globalThis.localStorage?.removeItem("twiglane.historyGraph");
    commitDetail.mockResolvedValue({
      generation: 3,
      commit: commit(0),
      body: "",
      root: false,
      merge: false,
      selectedParent: null,
      files: [],
    });
    commitFileDiff.mockResolvedValue(diff);
  });

  it("线性历史每行只有自己的片段，绘图段占满行槽并与上下段首尾相接", async () => {
    const head = commit(0, { oid: headOid, parents: [midOid] });
    const mid = commit(1, { parents: [rootOid] });
    const root = commit(2, { parents: [] });
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [head, mid, root], scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    expect(document.querySelectorAll(".hr-graph").length).toBe(3);
    expect(pathsOf(headOid)).toHaveLength(1);
    expect(pathsOf(midOid)).toHaveLength(1);
    expect(pathsOf(rootOid)).toHaveLength(1);

    // 几何：绘图段不在行里（行有圆角裁切），而是与行槽等高（50px 行 + 2px 行距 = 52px），
    // 顶边对齐行槽顶边，节点落在行中线；上一段的底边就是下一段的顶边，线不会在行与行之间断开。
    const svg = graphOf(headOid).querySelector("svg")!;
    const height = Number(svg.getAttribute("height"));
    const row = rowOf(headOid);
    const rowTop = Number.parseFloat(row.style.top);
    const rowHeight = Number.parseFloat(row.style.height);
    expect(rowHeight).toBe(50);
    expect(height).toBe(rowHeight + 2);
    expect(Number.parseFloat(graphOf(headOid).style.top)).toBe(rowTop - 1);
    expect(Number.parseFloat(graphOf(midOid).style.top)).toBe(Number.parseFloat(graphOf(headOid).style.top) + height);
    expect(rowTop - 1 + height / 2).toBe(rowTop + rowHeight / 2);
    expect(row.querySelector(".hr-graph"), "行内只留等宽占位").toBeNull();
    expect(row.querySelector(".hr-graph-slot")).toBeTruthy();
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${svg.getAttribute("width")} ${height}`);
    const node = graphOf(headOid).querySelector(".node")!;
    expect(node.getAttribute("cy")).toBe(String(height / 2));
    expect(node.classList.contains("head")).toBe(true);
    expect(document.querySelectorAll(".hr-graph .node.head").length).toBe(1);
    // 同一 lane：上一行的下半段到底边结束，下一行从顶边开始，坐标在行边界上相接。
    expect(pathsOf(headOid)[0]).toBe(`M 7 ${height / 2} L 7 ${height}`);
    expect(pathsOf(midOid)[0]).toBe(`M 7 0 L 7 ${height}`);
    expect(pathsOf(rootOid)[0]).toBe(`M 7 0 L 7 ${height / 2}`);

    // 所有行宽度一致，提交说明不会逐行左右跳。
    const widths = [...document.querySelectorAll<HTMLElement>(".hr-graph")].map(
      (item) => item.style.getPropertyValue("--graph-width"),
    );
    expect(new Set(widths).size).toBe(1);
  });

  it("父提交说明走 aria-describedby，读屏名称仍以提交说明开头", async () => {
    const head = commit(0, { oid: headOid, parents: [midOid] });
    const mid = commit(1, { parents: [] });
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [head, mid], scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    expect(rowOf(headOid).getAttribute("aria-describedby")).toBe("history-graph-" + headOid);
    expect(labelOf(headOid)).toBe(`父提交 ${midOid}。`);
    // 完整父 Hash 只在说明里，不再挤进名称主体。
    expect(rowOf(headOid).textContent).not.toContain(midOid);
    expect(screen.getByRole("option", { name: /^commit-0/ })).toBe(rowOf(headOid));
    expect(labelOf(midOid)).toBe("根提交：没有父提交。");
    expect(document.querySelectorAll("[id^=\"history-graph-\"]").length).toBe(2);
  });

  it("结果外父提交写明真实 Hash，不连到后面的无关提交", async () => {
    const tip = commit(0, { oid: headOid, parents: ["ffffffffffffffffffffffffffffffffffffffff"] });
    const other = commit(1, { parents: [] });
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [tip, other], scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    expect(labelOf(headOid)).toContain("ffffffffffffffffffffffffffffffffffffffff");
    expect(labelOf(headOid)).toContain("不在当前结果中");
    // 终止标记只在本行：第二行不出现这条 lane 的连线，也不出现节点以外的线。
    expect(pathsOf(other.oid)).toHaveLength(0);
    expect(graphOf(other.oid).querySelector(".node")).toBeTruthy();
  });

  it("分叉的两个提交接到同一个父提交，各自只画行内斜线", async () => {
    const baseOid = commit(5).oid;
    const left = commit(0, { oid: headOid, parents: [baseOid] });
    const right = commit(1, { parents: [baseOid] });
    const base = commit(2, { oid: baseOid, parents: [] });
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [left, right, base], scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-1/ });
    // 第二行：父提交那条竖线继续穿过，外加一条从自己 lane 下来的斜线。
    expect(pathsOf(right.oid)).toEqual([
      "M 7 0 L 7 52",
      "M 19 26 L 7 52",
    ]);
    expect(pathsOf(baseOid)).toEqual(["M 7 0 L 7 26"]);
    expect(labelOf(right.oid)).toBe(`父提交 ${baseOid}。`);
  });

  it("追加页后页边界重新配对，先把上一页的父提交标成结果外", async () => {
    historyPage
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 0, pageSize: 2, hasMore: true, state: "ok",
        commits: [commit(0, { oid: headOid, parents: [midOid] }), commit(1, { parents: [rootOid] })],
        scope: "current", branches: ["main"], head: "main",
      })
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 2, pageSize: 2, hasMore: false, state: "ok",
        commits: [commit(2, { parents: [] })],
        scope: "current", branches: ["main"], head: "main",
      });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    expect(labelOf(midOid)).toContain("不在当前结果中");
    const list = screen.getByRole("listbox", { name: "提交历史" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 120 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 400 });
    list.scrollTop = 300;
    await fireEvent.scroll(list);
    await screen.findByRole("option", { name: /commit-2/ });
    // 追加后同一条 lane 继续：父提交不再是结果外，也不再新起一条 lane。
    expect(labelOf(midOid)).toBe(`父提交 ${rootOid}。`);
    expect(pathsOf(midOid)).toEqual(["M 7 0 L 7 52"]);
    expect(pathsOf(rootOid)).toEqual(["M 7 0 L 7 26"]);
  });

  it("搜索或筛选换掉结果集时按新结果重建拓扑", async () => {
    historyPage
      .mockResolvedValueOnce({
        generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
        commits: [commit(0, { oid: headOid, parents: [midOid] }), commit(1, { parents: [rootOid] }), commit(2, { parents: [] })],
        scope: "current", branches: ["main"], head: "main",
      })
      .mockResolvedValueOnce({
        generation: 3, query: "commit-0", offset: 0, pageSize: 100, hasMore: false, state: "ok",
        commits: [commit(0, { oid: headOid, parents: [midOid] }), commit(2, { parents: [] })],
        scope: "current", branches: ["main"], head: "main",
      });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    expect(pathsOf(rootOid)).toEqual(["M 7 0 L 7 26"]);
    await fireEvent.input(screen.getByLabelText("搜索说明或提交哈希"), { target: { value: "commit-0" } });
    await waitFor(() => expect(historyPage).toHaveBeenLastCalledWith("/repo", "commit-0", 0, 3, 1));
    await waitFor(() => expect(document.querySelectorAll(".hr-graph").length).toBe(2));
    // 被搜索过滤掉的父提交变成结果外，后面的行也重新从 lane 0 开始。
    expect(labelOf(headOid)).toContain("不在当前结果中");
    expect(pathsOf(rootOid)).toHaveLength(0);
    expect(document.querySelectorAll("[id^=\"history-graph-\"]").length).toBe(2);
  });

  it("lane 超出紧凑宽度时丢弃越界线段，不让两条源线叠成一条", async () => {
    const parents = Array.from({ length: 7 }, (_, index) => `p${index}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    const merge = commit(0, { oid: headOid, parents });
    const rest = [...parents].reverse().map((oid, index) => commit(index + 1, { oid, parents: [] }));
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [merge, ...rest], scope: "current", branches: ["main"], head: "main",
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-0/ });
    const graphNode = graphOf(headOid);
    expect(graphNode.classList.contains("overflow")).toBe(true);
    expect(graphNode.querySelector(".hr-graph-more")?.textContent).toBe("+1");
    expect(labelOf(headOid)).toContain("另有 1 条分支线未画出");
    for (const oid of parents) expect(labelOf(headOid)).toContain(oid);
    // 只画 6 条 lane：一条竖线加五条分叉，第 7 条整条丢弃，坐标不越出绘图盒。
    const drawn = pathsOf(headOid);
    expect(drawn).toHaveLength(6);
    expect(new Set(drawn).size).toBe(6);
    const width = Number(graphNode.querySelector("svg")!.getAttribute("width"));
    const coordinates = drawn.flatMap((data) => data.slice(1).split(/[^0-9.]+/).filter(Boolean).map(Number));
    expect(Math.max(...coordinates)).toBeLessThanOrEqual(width - 2);
  });

  it("收起拓扑不影响选择、滚动和详情，展开后恢复同样的连线", async () => {
    const head = commit(0, { oid: headOid, parents: [midOid] });
    const mid = commit(1, { parents: [] });
    historyPage.mockResolvedValue({
      generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok",
      commits: [head, mid], scope: "current", branches: ["main"], head: "main",
    });
    commitDetail.mockResolvedValue({
      generation: 3, commit: commit(1), body: "", root: false, merge: false, selectedParent: null, files: [],
    });
    render(HistoryPanel, { props: panelProps() });
    await screen.findByRole("option", { name: /commit-1/ });
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }));
    const list = screen.getByRole("listbox", { name: "提交历史" });
    list.scrollTop = 40;
    await fireEvent.scroll(list);
    const before = pathsOf(headOid);
    expect(before).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "收起提交拓扑" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "展开提交拓扑" }).getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll(".hr-graph").length).toBe(0);
    // 收起时连父提交说明一起收起，行上不再挂着指不到的 describedby。
    expect(document.getElementById("history-graph-" + headOid)).toBeNull();
    expect(rowOf(headOid).hasAttribute("aria-describedby")).toBe(false);
    expect(rowOf(midOid).getAttribute("aria-selected")).toBe("true");
    expect(list.scrollTop).toBe(40);
    expect(detailCalls(midOid)).toBeGreaterThan(0);
    expect(globalThis.localStorage?.getItem("twiglane.historyGraph")).toBe("0");
    await fireEvent.click(screen.getByRole("button", { name: "展开提交拓扑" }));
    expect(pathsOf(headOid)).toEqual(before);
    expect(rowOf(headOid).getAttribute("aria-describedby")).toBe("history-graph-" + headOid);
    expect(rowOf(midOid).getAttribute("aria-selected")).toBe("true");
  });
});


/* ------------------------------------------------------------------ *
 * R5：提交里的文档阅读入口与引用收起。
 * 单文件、全部文件、多提交对照三种差异都要能按真实来源读正文；
 * 引用收起只在引用多时出现，切换提交后仍是用户选的状态。
 * ------------------------------------------------------------------ */
describe("提交里的文档阅读与引用收起（R5）", () => {
  const mdPath = "docs/readme.md";
  const mdSides = {
    repository: "/repo",
    old: { revision: "parent0", path: mdPath },
    new: { revision: "abcdef0000abcdef0000abcdef0000abcdef0000abcd", path: mdPath },
  };

  function mdCommit(index = 0) {
    return commit(index, { oid: mdSides.new.revision });
  }

  it("单文件提交差异给出阅读入口，交给阅读窗口的是这次提交的正文来源", async () => {
    const only = mdCommit();
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({
      generation: 3, commit: only, body: "", root: false, merge: false, selectedParent: only.parents[0],
      files: [{ path: mdPath, originalPath: null, status: "modified", additions: 2, deletions: 1 }],
    });
    commitFileDiff.mockResolvedValue({ ...diff, path: mdPath, document: mdSides });
    const onReadDocument = vi.fn();
    render(HistoryPanel, { props: { ...panelProps(), onReadDocument } });
    const entry = await screen.findByRole("button", { name: "阅读文档" });
    await fireEvent.click(entry);
    expect(onReadDocument).toHaveBeenCalledWith(mdSides, "new", entry);
  });

  it("全部文件模式下每个 Markdown 文件块有入口，其它文件没有", async () => {
    const only = mdCommit();
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [only] });
    commitDetail.mockResolvedValue({
      generation: 3, commit: only, body: "", root: false, merge: false, selectedParent: only.parents[0],
      files: [
        { path: mdPath, originalPath: null, status: "modified", additions: 2, deletions: 1 },
        { path: "notes.txt", originalPath: null, status: "modified", additions: 1, deletions: 0 },
      ],
    });
    commitFileDiff.mockImplementation(async (_repo, _oid, _parent, path: string) =>
      path === mdPath ? { ...diff, path, document: mdSides } : { ...diff, path });
    const onReadDocument = vi.fn();
    render(HistoryPanel, { props: { ...panelProps(), onReadDocument } });
    await screen.findByRole("option", { name: /commit-0/ });
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: /全部文件/ }));
    const entry = await screen.findByRole("button", { name: `阅读 ${mdPath} 的文档` });
    expect(screen.queryByRole("button", { name: "阅读 notes.txt 的文档" })).toBeNull();
    await fireEvent.click(entry);
    expect(onReadDocument).toHaveBeenCalledWith(mdSides, "new", entry);
  });

  it("多提交对照的每个提交块也从自己的差异取来源", async () => {
    const rows = [mdCommit(0), commit(1)];
    historyPage.mockResolvedValue({ generation: 3, commits: rows, offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3, commit: rows.find((row) => row.oid === oid) ?? rows[0], body: "", root: false, merge: false,
      selectedParent: "parent", files: [{ path: mdPath, originalPath: null, status: "modified", additions: 1, deletions: 1 }],
    }));
    commitFileDiff.mockResolvedValue({ ...diff, path: mdPath, document: mdSides });
    const onReadDocument = vi.fn();
    render(HistoryPanel, { props: { ...panelProps(), onReadDocument } });
    await screen.findByRole("option", { name: /commit-0/ });
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }), { shiftKey: true });
    // 多提交对照先选中一个文件路径，每个提交块才有这个文件的差异可读。
    const files = await screen.findByRole("listbox", { name: "提交中的文件列表" });
    await waitFor(() => expect(within(files).getAllByRole("option").length).toBeGreaterThan(0));
    await fireEvent.click(within(files).getAllByRole("option")[0]);
    // 每个提交块各有一个入口，来源取自该提交自己的差异。
    const entries = await screen.findAllByRole("button", { name: `阅读 ${mdPath} 在这一提交的文档` });
    expect(entries).toHaveLength(2);
    await fireEvent.click(entries[0]);
    expect(onReadDocument).toHaveBeenCalledWith(mdSides, "new", entries[0]);
    expect(onReadDocument.mock.calls[0][0].repository).toBe("/repo");
  });

  it("引用多时可收起并只留计数，切换提交后仍是收起状态", async () => {
    const labels = [
      { name: "main", kind: "branch" as const, current: true },
      { name: "origin/main", kind: "remote" as const, current: false },
      { name: "v1.0", kind: "tag" as const, current: false },
    ];
    const rows = [commit(0, { labels }), commit(1, { labels })];
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows });
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3, commit: rows.find((row) => row.oid === oid) ?? rows[0], body: "", root: false, merge: false,
      selectedParent: "parent", files: [{ path: "notes.txt", originalPath: null, status: "modified", additions: 1, deletions: 0 }],
    }));
    commitFileDiff.mockResolvedValue({ ...diff, path: "notes.txt" });
    render(HistoryPanel, { props: panelProps() });
    const toggle = await screen.findByRole("button", { name: "收起提交引用" });
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBeGreaterThan(1);
    await fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /展开提交引用/ }).textContent).toContain("引用 2");
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBe(0);

    // 换一个提交：收起状态跟过来，不会突然又把引用铺开。
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }));
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());
    expect(screen.getByRole("button", { name: /展开提交引用/ }).textContent).toContain("引用 2");
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBe(0);
    await fireEvent.click(screen.getByRole("button", { name: /展开提交引用/ }));
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBeGreaterThan(1);
  });

  it("收起引用后切到单引用提交，那个引用仍然可见，回到多引用提交仍可再展开", async () => {
    const many = [
      { name: "main", kind: "branch" as const, current: true },
      { name: "origin/main", kind: "remote" as const, current: false },
      { name: "v1.0", kind: "tag" as const, current: false },
    ];
    // 只有 1 个引用：最常见的就是「当前分支或单个 tag 指向该提交」。
    const single = [{ name: "v2.0", kind: "tag" as const, current: false }];
    const rows = [commit(0, { labels: many }), commit(1, { labels: single })];
    historyPage.mockResolvedValue({ generation: 3, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: rows });
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 3, commit: rows.find((row) => row.oid === oid) ?? rows[0], body: "", root: false, merge: false,
      selectedParent: "parent", files: [{ path: "notes.txt", originalPath: null, status: "modified", additions: 1, deletions: 0 }],
    }));
    commitFileDiff.mockResolvedValue({ ...diff, path: "notes.txt" });
    render(HistoryPanel, { props: panelProps() });
    await fireEvent.click(await screen.findByRole("button", { name: "收起提交引用" }));
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBe(0);

    // 单引用提交上收起状态不生效：标签照常显示，公开信息不会因为上一条提交的选择而消失。
    await fireEvent.click(screen.getByRole("option", { name: /commit-1/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "commit-1" })).toBeTruthy());
    const pills = document.querySelectorAll<HTMLElement>(".commit-byline .ref-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain("v2.0");
    // 单引用没有可收起的内容，因此不渲染开关；也没有「藏起来却点不出来」的状态。
    expect(screen.queryByRole("button", { name: /提交引用/ })).toBeNull();

    // 回到多引用提交：用户之前的收起状态仍在，开关能把引用重新展开。
    await fireEvent.click(screen.getByRole("option", { name: /commit-0/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "commit-0" })).toBeTruthy());
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBe(0);
    await fireEvent.click(screen.getByRole("button", { name: /展开提交引用/ }));
    expect(document.querySelectorAll(".commit-byline .ref-pill").length).toBeGreaterThan(1);
  });
});
