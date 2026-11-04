import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceFixture } from "./fixtures";
import type { BranchRecord, DiffResponse, FileChange, FileRow } from "../../src/lib/types";
import { toSideRows, type ViewLine } from "../../src/lib/diff";
import { createSelectionResolver } from "../../src/lib/labels";
import { fileNavState } from "../../src/lib/ui";

const api = vi.hoisted(() => ({
  commitFileDiff: vi.fn(), mergeSession: vi.fn(), branchState: vi.fn(),
  historyPage: vi.fn(), conflictView: vi.fn(), commitDetail: vi.fn(), loadDiff: vi.fn(),
}));
vi.mock("../../src/lib/api", () => ({ api }));

import BranchPicker from "../../src/lib/components/BranchPicker.svelte";
import CommitDiffList from "../../src/lib/components/CommitDiffList.svelte";
import MergePanel from "../../src/lib/components/MergePanel.svelte";
import HistoryPanel from "../../src/lib/components/HistoryPanel.svelte";
import MultiFileDiff from "../../src/lib/components/MultiFileDiff.svelte";

const { opened, detail, diff } = new PerformanceFixture();

beforeEach(() => { Object.values(api).forEach((mock) => mock.mockReset()); });

describe("大仓库的有界读取和渲染", () => {
  it("两万未提交文件刷新选择只扫描一次文件列表", () => {
    let pathReads = 0;
    const files: FileChange[] = Array.from({ length: 20_000 }, (_, index) => ({
      get path() { pathReads += 1; return `file-${index}.txt`; },
      originalPath: null, staged: "modified", unstaged: "none", untracked: false, unmerged: false,
    }));
    const start = performance.now();
    const resolve = createSelectionResolver(files, true);
    const result = Array.from({ length: files.length }, (_, index) => resolve({ path: `file-${index}.txt`, side: "unstaged" }));
    console.info(`20000 working tree selections: ${(performance.now() - start).toFixed(2)} ms`);
    expect(result.every((item) => item?.side === "staged")).toBe(true);
    expect(pathReads).toBe(files.length);
  });

  it("两万未提交文件跳到末尾仍只读取附近差异，隐藏时停止读取并释放内容", async () => {
    const rows: FileRow[] = detail.files.map((file) => ({ ...file, staged: "none", unstaged: "modified", untracked: false, unmerged: false, side: "unstaged" }));
    const pending: Array<{ path: string; resolve: (value: DiffResponse) => void }> = [];
    api.loadDiff.mockImplementation((_repo, path) => new Promise((resolve) => pending.push({ path, resolve })));
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    const component = render(MultiFileDiff, {
      opened, rows, focus: rows[0], nav: fileNavState(rows, 0, vi.fn()), disabled: false, fullFile: false, fullContext: 1_000_000,
      stageCount: rows.length, unstageCount: 0, discardCount: rows.length, conflictCount: 0, nextId: () => 1,
      onFocus: vi.fn(), onStale: vi.fn(), onStageHunk: vi.fn(), onFullFile: vi.fn(), onFileHistory: vi.fn(),
      onStage: vi.fn(), onUnstage: vi.fn(), onDiscard: vi.fn(), onClear: vi.fn(),
    });
    try {
      await waitFor(() => expect(pending).toHaveLength(3));
      await component.rerender({ focus: rows.at(-1)! });
      await waitFor(() => expect(document.querySelector('[data-path="file-19999.txt"]')).toBeTruthy());
      expect(document.querySelectorAll(".multi-file").length).toBeLessThan(10);
      pending[0].resolve(diff);
      await waitFor(() => expect(pending).toHaveLength(4));
      expect(Number(pending[3].path.match(/\d+/)?.[0])).toBeGreaterThan(19995);
      await component.rerender({ active: false });
      pending.slice(1).forEach((item) => item.resolve({ ...diff, path: item.path }));
      await tick();
      expect(pending).toHaveLength(4);
      expect(document.querySelector("[data-diff-row]")).toBeNull();
    } finally {
      component.unmount();
      height.mockRestore();
    }
  });

  it("两万行替换保持配对和行序，无结尾换行标记不占配对槽", () => {
    const count = 20_000;
    const lines: ViewLine[] = [
      ...Array.from({ length: count }, (_, i) => ({ kind: "del", text: `-${i}`, oldNo: i + 1, newNo: null, hunkIndex: 0 })),
      { kind: "nonewline", text: "no newline", oldNo: null, newNo: null, hunkIndex: 0 },
      ...Array.from({ length: count + 1 }, (_, i) => ({ kind: "add", text: `+${i}`, oldNo: null, newNo: i + 1, hunkIndex: 0 })),
    ];
    const start = performance.now();
    const rows = toSideRows(lines);
    console.info(`20000-line replacement pairing: ${(performance.now() - start).toFixed(2)} ms`);
    expect(rows).toHaveLength(count + 2);
    for (let i = 0; i < count; i++) {
      expect([rows[i].left?.no, rows[i].right?.no]).toEqual([i + 1, i + 1]);
    }
    expect(rows[count].left?.text).toBe("no newline");
    expect(rows[count].right).toBeNull();
    expect(rows[count + 1].right?.no).toBe(count + 1);
  });

  it("多提交并集的两万文件只挂载视口附近行，End 可以选到末尾", async () => {
    const commits = [detail.commit, { ...detail.commit, oid: "c".repeat(40), summary: "second" }];
    api.historyPage.mockResolvedValue({ generation: 1, commits, offset: 0, pageSize: 100, hasMore: false, state: "ok" });
    api.commitDetail.mockImplementation(async (_repo, oid) => ({ ...detail, commit: commits.find((item) => item.oid === oid) }));
    api.commitFileDiff.mockResolvedValue(diff);
    render(HistoryPanel, { opened, filePath: null, disabled: false, nextId: () => 1, onGeneration: vi.fn(), onFailure: vi.fn(), onFilePath: vi.fn(), onClearFile: vi.fn() });
    await fireEvent.click(await screen.findByRole("option", { name: /second/ }), { shiftKey: true });
    await waitFor(() => expect(document.querySelector(".history-union-files")).toBeTruthy());
    const list = document.querySelector(".history-union-files")!;
    expect(list.querySelectorAll("[role=option]").length).toBeLessThanOrEqual(40);
    await fireEvent.keyDown(list, { key: "End" });
    await waitFor(() => expect(list.querySelector('[aria-posinset="20000"]')?.getAttribute("aria-selected")).toBe("true"));
    expect(list.querySelectorAll("[role=option]").length).toBeLessThanOrEqual(40);
  });

  it("5000 个分支只挂载视口附近的选项，键盘能直接选到最后一个，搜索覆盖全量", async () => {
    const branches: BranchRecord[] = Array.from({ length: 5000 }, (_, i) => ({ name: `topic-${i}`, remote: false, current: false, upstream: null, worktree: null }));
    const onChange = vi.fn();
    render(BranchPicker, { label: "来源分支", branches, value: "topic-0", current: "main", onChange });
    await fireEvent.click(screen.getByRole("button", { name: "来源分支" }));
    const search = screen.getByRole("combobox", { name: "搜索来源分支" });
    expect(screen.getAllByRole("option").length).toBeLessThan(40);
    await fireEvent.keyDown(search, { key: "ArrowUp" });
    await tick();
    expect(screen.getByRole("option", { name: "topic-4999" })).toBeTruthy();
    await fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("topic-4999");
    await fireEvent.click(screen.getByRole("button", { name: "来源分支" }));
    await fireEvent.input(screen.getByRole("combobox", { name: "搜索来源分支" }), { target: { value: "topic-4999" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("两万文件只请求可见块，最多并发两个，跳到末尾不会排队读取中间文件", async () => {
    const pending: Array<{ path: string; resolve: (value: DiffResponse) => void }> = [];
    api.commitFileDiff.mockImplementation((_repo, _oid, _parent, path) => new Promise((resolve) => pending.push({ path, resolve })));
    const props = { opened, detail, parent: detail.selectedParent, focusPath: "file-0.txt", disabled: false, nextId: () => 1, onGeneration: vi.fn(), onFailure: vi.fn(), onFileHistory: vi.fn() };
    const component = render(CommitDiffList, props);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(document.querySelectorAll(".multi-file").length).toBeLessThan(8);
    await component.rerender({ ...props, focusPath: "file-19999.txt" });
    await tick();
    expect(document.querySelector('[data-path="file-19999.txt"]')).toBeTruthy();
    expect(pending).toHaveLength(2);
    pending[0].resolve(diff);
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(Number(pending[2].path.match(/\d+/)?.[0])).toBeGreaterThan(19995);
    component.unmount();
    pending[1].resolve(diff);
    pending[2].resolve(diff);
    await tick();
    expect(pending).toHaveLength(3);
  });

  it("每文件五千行时 DOM 行数仍有上限，切换提交丢弃在途旧响应", async () => {
    let finish: (value: DiffResponse) => void = () => {};
    api.commitFileDiff.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve))).mockResolvedValue(diff);
    const props = { opened, detail: { ...detail, files: detail.files.slice(0, 1) }, parent: detail.selectedParent, disabled: false, nextId: () => 1, onGeneration: vi.fn(), onFailure: vi.fn(), onFileHistory: vi.fn() };
    const component = render(CommitDiffList, props);
    await waitFor(() => expect(api.commitFileDiff).toHaveBeenCalledTimes(1));
    const newer = { ...props.detail, commit: { ...detail.commit, oid: "c".repeat(40) } };
    await component.rerender({ ...props, detail: newer });
    await waitFor(() => expect(document.querySelectorAll(".diff [data-line]").length).toBeGreaterThan(0));
    expect(document.querySelectorAll(".diff [data-line]").length).toBeLessThan(100);
    finish({ ...diff, lines: [{ ...diff.lines[0], text: "+OLD RESPONSE" }] });
    await tick();
    expect(screen.queryByText("OLD RESPONSE")).toBeNull();
  });

  it("两万冲突文件只渲染可见行，过滤仍能找到末尾文件", async () => {
    api.mergeSession.mockResolvedValue({ generation: 1, operation: "merge", canContinue: false, canAbort: true, source: "topic", target: "main", headOid: "a".repeat(40), unresolved: 20_000, note: "", snapshot: opened.snapshot, conflicts: detail.files.map((file) => ({ path: file.path, kind: "content", summary: "双方修改" })) });
    api.branchState.mockResolvedValue({ generation: 1, branches: [], snapshot: opened.snapshot });
    api.historyPage.mockResolvedValue({ generation: 1, commits: [] });
    api.conflictView.mockImplementation(() => new Promise(() => {}));
    render(MergePanel, { opened, disabled: false, nextId: () => 1, onSnapshot: vi.fn(), onGeneration: vi.fn(), onFailure: vi.fn(), onNotice: vi.fn(), onOpenStash: vi.fn() });
    const search = await screen.findByRole("textbox", { name: "筛选冲突文件" });
    expect(document.querySelectorAll(".conflict-file").length).toBeLessThan(40);
    await fireEvent.input(search, { target: { value: "file-19999.txt" } });
    expect(document.querySelectorAll(".conflict-file")).toHaveLength(1);
    expect(document.querySelector(".conflict-file")?.getAttribute("title")).toBe("file-19999.txt");
  });
});
