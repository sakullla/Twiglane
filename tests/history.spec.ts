import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DiffView from "../src/lib/components/DiffView.svelte";
import {
  commitFileLabel,
  historyStatus,
  mergeAbortAvailable,
  parentCaption,
  preferredCommitFile,
  commitBodyRest,
  refLabel,
  refPills,
  shortOid,
  stashPathBadge,
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
    expect(historyStatus("no_match")).toContain("全部历史");
    expect(historyStatus("no_file_history")).toBe("这个文件没有可用历史。");
    expect(historyStatus("ok")).toBeNull();
    expect(historyStatus("empty_repository")).not.toBe(historyStatus("no_match"));
    expect(historyStatus("no_match")).not.toBe(historyStatus("no_file_history"));
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
      await fireEvent.input(screen.getByLabelText("搜索全部历史"), { target: { value: "UNIQUE-NEEDLE" } });
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
    expect(screen.getByText("将保存 file.txt")).toBeTruthy();
    expect(screen.getByText("不保存 new.txt")).toBeTruthy();
    expect(screen.getByText("忽略不保存 ignored.log")).toBeTruthy();
    expect(stashState).toHaveBeenCalledWith("/repo", false, 3, 2);
  });

  it("取消删除不会调用接口，确认后按标识删除", async () => {
    deleteStash.mockResolvedValue({ ...preview, records: [] });
    renderStash();
    await screen.findByRole("button", { name: "删除" });
    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(deleteStash).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
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
    expect(screen.getByRole("button", { name: "确认删除" }).className).toContain("btn-danger");

    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(deleteStash).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /删除临时保存/ })).toBeNull();
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);

    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await screen.findByRole("dialog", { name: /删除临时保存/ });
    await fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
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
      files: [{ path: "notes.txt", originalPath: null, status: "modified" }],
    });
    commitFileDiff.mockResolvedValue(diff);
    render(HistoryPanel, { props: panelProps() });
    await waitFor(() => expect(document.querySelector(".commit-head")).toBeTruthy());
    const pane = document.querySelector<HTMLElement>(".history-layout > .pane")!;
    const detail = document.querySelector<HTMLElement>(".history-layout > .history-detail")!;
    expect(within(pane).getByRole("textbox", { name: "搜索全部历史" })).toBeTruthy();
    expect(within(pane).getByRole("listbox", { name: "提交历史" })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "上一页" })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "下一页" })).toBeTruthy();
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
