import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DiffView from "../src/lib/components/DiffView.svelte";
import {
  commitFileLabel,
  historyStatus,
  mergeAbortAvailable,
  parentCaption,
  preferredCommitFile,
  refLabel,
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
    expect(screen.getByText(/合并提交/)).toBeTruthy();
    expect(screen.getByText("分支 feature · 当前")).toBeTruthy();
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
});
