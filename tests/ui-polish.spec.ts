import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import BranchSwitcher from "../src/lib/components/BranchSwitcher.svelte";
import CommandPalette from "../src/lib/components/CommandPalette.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";
import FileList from "../src/lib/components/FileList.svelte";
import type { DiffResponse, FileChange, OpenedRepository } from "../src/lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UI/UX 交互与视觉细节", () => {
  it("命令面板高亮命中片段、显示底部提示与匹配计数，并支持 Ctrl+N/Ctrl+P 导航", async () => {
    const runFirst = vi.fn();
    const runSecond = vi.fn();
    render(CommandPalette, {
      props: {
        open: true,
        commands: [
          { id: "a", group: "同步", title: "推送到远程", run: runFirst },
          { id: "b", group: "提交", title: "提交并推送", run: runSecond },
        ],
        onClose: vi.fn(),
      },
    });

    const input = screen.getByRole("combobox", { name: "搜索命令" });
    await fireEvent.input(input, { target: { value: "推送" } });

    const marks = [...document.querySelectorAll(".palette-item mark")].map((node) => node.textContent);
    expect(marks).toEqual(["推送", "推送"]);
    expect(document.querySelector(".palette-foot-count")?.textContent).toBe("共 2 项");

    await fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(input, { key: "p", ctrlKey: true });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("改动文件列表在筛选时高亮文件名与目录、显示匹配数，并支持 / 键聚焦搜索", async () => {
    const files: FileChange[] = [
      {
        path: "src/lib/AppShell.svelte",
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
      {
        path: "docs/readme.md",
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
    ];
    let query = "lib";
    const onQuery = vi.fn((next: string) => {
      query = next;
    });
    render(FileList, {
      props: {
        files,
        selected: { path: "src/lib/AppShell.svelte", side: "unstaged" },
        query,
        disabled: false,
        onQuery,
        onSelect: vi.fn(),
        onStage: vi.fn(),
        onUnstage: vi.fn(),
      },
    });

    expect(document.querySelector(".field-count")?.textContent).toBe("1/2");
    expect(document.querySelector(".file-name mark")?.textContent).toBe("lib");

    const listbox = screen.getByRole("listbox", { name: "改动文件" });
    listbox.focus();
    await fireEvent.keyDown(listbox, { key: "/" });
    expect(document.activeElement?.id).toBe("file-search");
  });

  it("分支弹层搜索无匹配时提供带入搜索词的新建分支入口，并高亮匹配分支名", async () => {
    const opened = {
      generation: 1,
      summary: { name: "twiglane", path: "/repo/twiglane", isWorktree: false },
      snapshot: {
        branch: { name: "main", headOid: "abc1234", detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
        files: [],
        mergeInProgress: false,
      },
    } as unknown as OpenedRepository;

    vi.spyOn(api, "branchList").mockResolvedValue({
      generation: 1,
      defaultBranch: "main",
      mergeBases: ["main"],
      branches: [
        { name: "main", remote: false, current: true, upstream: null, oid: "abc1234", merged: false, worktree: null },
        { name: "feature/ux-polish", remote: false, current: false, upstream: null, oid: "def5678", merged: false, worktree: null },
      ],
    } as never);
    vi.spyOn(api, "branchTracking").mockResolvedValue({ generation: 1, branches: [] } as never);

    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onCreateBranch = vi.fn();
    const onCreateWorktree = vi.fn();

    render(BranchSwitcher, {
      props: {
        anchor,
        opened,
        blockedReason: null,
        nextId: () => 1,
        onBusy: vi.fn(),
        onGeneration: vi.fn(),
        onSnapshot: vi.fn(),
        onFailure: vi.fn(),
        onNotice: vi.fn(),
        onCommand: vi.fn(),
        onCreateBranch,
        onCreateWorktree,
        onClose: vi.fn(),
      },
    });

    const input = await screen.findByPlaceholderText("搜索本地或远程分支");
    await waitFor(() => expect(document.querySelectorAll(".branch-option").length).toBeGreaterThanOrEqual(1));

    await fireEvent.input(input, { target: { value: "ux" } });
    await waitFor(() => expect(document.querySelector(".branch-option-name mark")?.textContent).toBe("ux"));

    await fireEvent.input(input, { target: { value: "feature/new-flow" } });
    const createBtn = await screen.findByRole("button", { name: "以「feature/new-flow」新建分支" });
    await fireEvent.click(createBtn);
    expect(onCreateBranch).toHaveBeenCalledWith(undefined, "feature/new-flow");
    // 同一个名字也可以直接放进新工作区（本机仓库才传这个回调）。
    await fireEvent.click(screen.getByRole("button", { name: "在新工作区新建" }));
    expect(onCreateWorktree).toHaveBeenCalledWith("feature/new-flow");
    anchor.remove();
  });

  it("差异区支持 ] 与 [ 键跳转改动块，并在滚动后为工具栏添加 scrolled 状态", async () => {
    const diff: DiffResponse = {
      generation: 1,
      path: "src/app.ts",
      staged: false,
      binary: false,
      truncated: false,
      text: "",
      summary: "",
      complete: true,
      snapshot: "",
      offset: 0,
      totalLines: 8,
      additions: 2,
      deletions: 0,
      lines: [
        { kind: "hunk", text: "@@ -1,2 +1,3 @@", oldNo: null, newNo: null, hunkIndex: 0 },
        { kind: "context", text: " a", oldNo: 1, newNo: 1, hunkIndex: 0 },
        { kind: "add", text: "+b", oldNo: null, newNo: 2, hunkIndex: 0 },
        { kind: "context", text: " c", oldNo: 2, newNo: 3, hunkIndex: 0 },
        { kind: "hunk", text: "@@ -10,2 +11,3 @@", oldNo: null, newNo: null, hunkIndex: 1 },
        { kind: "context", text: " x", oldNo: 10, newNo: 11, hunkIndex: 1 },
        { kind: "add", text: "+y", oldNo: null, newNo: 12, hunkIndex: 1 },
        { kind: "context", text: " z", oldNo: 11, newNo: 13, hunkIndex: 1 },
      ],
      hunks: [
        { index: 0, header: "@@ -1,2 +1,3 @@", complete: true, stageable: true, startLine: 0, lineCount: 4 },
        { index: 1, header: "@@ -10,2 +11,3 @@", complete: true, stageable: true, startLine: 4, lineCount: 4 },
      ],
    };

    render(DiffView, {
      props: {
        selection: { path: "src/app.ts", side: "unstaged" },
        diff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: vi.fn(),
        onLoadMore: vi.fn(),
      },
    });

    const scroller = document.querySelector<HTMLElement>(".diff-scroll")!;
    const toolbar = document.querySelector<HTMLElement>(".diff-toolbar")!;
    expect(toolbar.classList.contains("scrolled")).toBe(false);

    scroller.focus();
    await fireEvent.keyDown(scroller, { key: "]" });
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(toolbar.classList.contains("scrolled")).toBe(true);

    await fireEvent.keyDown(scroller, { key: "[" });
    expect(scroller.scrollTop).toBe(0);
    expect(toolbar.classList.contains("scrolled")).toBe(false);
  });
});
