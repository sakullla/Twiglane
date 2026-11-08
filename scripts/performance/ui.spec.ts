import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceFixture } from "./fixtures";
import type { BranchRecord, DiffResponse, FileChange, FileRow, RepositoryDocument } from "../../src/lib/types";
import { toSideRows, type ViewLine } from "../../src/lib/diff";
import { createSelectionResolver } from "../../src/lib/labels";
import { fileNavState } from "../../src/lib/ui";

const api = vi.hoisted(() => ({
  commitFileDiff: vi.fn(), mergeSession: vi.fn(), branchState: vi.fn(),
  historyPage: vi.fn(), conflictView: vi.fn(), commitDetail: vi.fn(), loadDiff: vi.fn(),
  repositoryFileContent: vi.fn(), repositoryContentSearch: vi.fn(), repositoryPathSearch: vi.fn(), repositoryDirectory: vi.fn(),
  repositoryDocument: vi.fn(),
}));
vi.mock("../../src/lib/api", () => ({ api }));

import BranchPicker from "../../src/lib/components/BranchPicker.svelte";
import CommitDiffList from "../../src/lib/components/CommitDiffList.svelte";
import MergePanel from "../../src/lib/components/MergePanel.svelte";
import HistoryPanel from "../../src/lib/components/HistoryPanel.svelte";
import MultiFileDiff from "../../src/lib/components/MultiFileDiff.svelte";
import FileContent from "../../src/lib/components/FileContent.svelte";
import FileSearch from "../../src/lib/components/FileSearch.svelte";
import FileTree from "../../src/lib/components/FileTree.svelte";
import { createFilesStore, flattenTree, makeNode, type FileNode } from "../../src/lib/files.svelte";

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
    await component.rerender({ active: false });
    expect(document.querySelectorAll(".diff [data-line]")).toHaveLength(0);
    await component.rerender({ active: true });
    await waitFor(() => expect(document.querySelectorAll(".diff [data-line]").length).toBeGreaterThan(0));

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

  it("两万文件目录只渲染可见行，长文件按页读取也只画可见行", async () => {
    const entries: FileNode[] = Array.from({ length: 20_000 }, (_, index) => ({
      ...makeNode({ name: "file-" + index + ".ts", path: "src/gen/file-" + index + ".ts", kind: "file", ignored: false, size: 12, error: null }),
    }));
    const rootNode = { ...makeNode({ name: "gen", path: "src/gen", kind: "directory", ignored: false, size: null, error: null }), children: entries, expanded: true };
    const rows = flattenTree([rootNode]);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    try {
      const start = performance.now();
      render(FileTree, {
        props: {
          rows,
          selectedPath: "src/gen/file-19999.ts",
          loading: false,
          failure: null,
          query: "",
          includeIgnored: false,
          disabled: false,
          onQuery: vi.fn(),
          onIncludeIgnored: vi.fn(),
          onToggle: vi.fn(),
          onSelect: vi.fn(),
          onSplit: vi.fn(),
          onRefresh: vi.fn(),
        } as never,
      });
      await tick();
      console.info("20000-row file tree render: " + (performance.now() - start).toFixed(2) + " ms");
      expect(document.querySelectorAll(".file-tree-row").length).toBeLessThan(100);

      const lines = Array.from({ length: 1000 }, (_, index) => "const row" + index + " = compute(" + index + ");");
      api.repositoryFileContent.mockImplementation((_repo: string, path: string, offset: number, _limit: number | undefined, generation: number) =>
        Promise.resolve({
          generation,
          path,
          kind: "text",
          size: 200_000,
          offset,
          lines: offset === 0 ? lines : ["tail-row"],
          nextOffset: offset === 0 ? lines.length : offset + 1,
          hasMore: offset === 0,
          truncated: false,
          message: null,
        }),
      );
      const { container } = render(FileContent, {
        props: {
          active: true,
          opened,
          path: "src/gen/long.ts",
          generation: opened.generation,
          disabled: false,
          nextId: () => 1,
          onGeneration: vi.fn(),
        } as never,
      });
      await waitFor(() => expect(api.repositoryFileContent).toHaveBeenCalledTimes(1));
      await tick();
      expect(container.querySelectorAll("[data-file-line]").length).toBeLessThan(60);
      const more = await screen.findByRole("button", { name: /继续读取后续内容/ });
      await fireEvent.click(more);
      await waitFor(() => expect(api.repositoryFileContent).toHaveBeenLastCalledWith(opened.summary.path, "src/gen/long.ts", 1000, undefined, opened.generation, 1));
    } finally {
      height.mockRestore();
    }
  });
});


describe("Markdown 阅读的规模与旧响应", () => {
  function markdownDoc(path: string, text: string, generation = 4): RepositoryDocument {
    return {
      generation,
      source: { revision: "worktree", path },
      kind: "text",
      size: text.length,
      version: "v1",
      text,
      complete: true,
      offset: 0,
      lines: text.split("\n"),
      nextOffset: 0,
      hasMore: false,
      truncated: false,
      message: null,
    };
  }

  it("长文档按批上屏，DOM 不随段落数一起增长", async () => {
    const text = Array.from({ length: 400 }, (_, index) => `## 标题 ${index}\n\n第 ${index} 段正文。`).join("\n\n");
    api.repositoryDocument.mockResolvedValue(markdownDoc("docs/long.md", text));
    const start = performance.now();
    render(FileContent, {
      props: {
        active: true,
        opened,
        path: "docs/long.md",
        generation: opened.generation,
        disabled: false,
        nextId: () => 1,
        onGeneration: vi.fn(),
      } as never,
    });
    await waitFor(() => expect(document.querySelectorAll(".md-block").length).toBeGreaterThan(0));
    console.info("800-paragraph markdown first paint: " + (performance.now() - start).toFixed(2) + " ms");
    // 首屏只挂一档（48 段），其余由「继续阅读」补齐：段落再多也不会一次排进 DOM。
    expect(document.querySelectorAll(".md-block").length).toBeLessThanOrEqual(48);
    expect(screen.getByRole("button", { name: "继续阅读" })).toBeTruthy();
  });

  it("超出排版预算的文档明确退回源码，不留在永久加载态", async () => {
    // 无 Worker 的宿主只内联解析小文档；这份超出上限，必须给出可读的退路。
    const text = "# 超长文档\n\n" + "正文段落。".repeat(20_000);
    api.repositoryDocument.mockImplementation((_path: string, _source: unknown, generation: number, _id: number, mode: string) =>
      Promise.resolve({ ...markdownDoc("docs/huge.md", text, generation), text: mode === "document" ? text : null }),
    );
    render(FileContent, {
      props: {
        active: true,
        opened,
        path: "docs/huge.md",
        generation: opened.generation,
        disabled: false,
        nextId: () => 1,
        onGeneration: vi.fn(),
      } as never,
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("源码");
    expect(api.repositoryDocument).toHaveBeenLastCalledWith(
      opened.summary.path,
      expect.anything(),
      opened.generation,
      expect.any(Number),
      "document",
    );
    // 源码退路走同一文件的源码视图（FileContent 的分页读取），不是停在预览的失败态。
    api.repositoryFileContent.mockResolvedValue({
      generation: opened.generation,
      path: "docs/huge.md",
      kind: "text",
      size: text.length,
      offset: 0,
      lines: ["# 超长文档"],
      nextOffset: 1,
      hasMore: false,
      truncated: false,
      message: null,
    });
    await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));
    await waitFor(() => expect(api.repositoryFileContent).toHaveBeenCalled());
  });

  it("切换文件后旧文档响应晚到不覆盖新文件", async () => {
    let finishOld: (value: RepositoryDocument) => void = () => {};
    api.repositoryDocument.mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)));
    api.repositoryDocument.mockImplementation((path: string, _source: unknown, generation: number) =>
      Promise.resolve(markdownDoc(path, "# 新文档\n\n新正文", generation)),
    );
    const props = {
      active: true,
      opened,
      path: "docs/old.md",
      generation: opened.generation,
      disabled: false,
      nextId: () => 1,
      onGeneration: vi.fn(),
    };
    const component = render(FileContent, { props: props as never });
    await waitFor(() => expect(api.repositoryDocument).toHaveBeenCalledTimes(1));
    await component.rerender({ ...props, path: "docs/new.md" } as never);
    await waitFor(() => expect(document.body.textContent).toContain("新文档"));
    finishOld(markdownDoc("docs/old.md", "# 旧文档\n\n旧正文"));
    await tick();
    expect(document.body.textContent, "旧响应不得覆盖当前文件").not.toContain("旧文档");
  });
});

describe("文件搜索的规模入口", () => {
  it("两万条路径结果只挂载视口附近的行，远距离定位按偏移读取目标页", async () => {
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
      path: "src/gen/file-" + index + ".ts",
      kind: "file" as const,
      ignored: false,
    }));
    api.repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "file-",
      directory: null,
      includeIgnored: false,
      scanned: entries.length,
      entries,
      truncated: true,
      message: "结果达到上限。",
    });
    api.repositoryDirectory.mockResolvedValue({ generation: 4, path: "", entries: [], errors: [] });
    const store = createFilesStore({
      repo: () => "C:/work/demo",
      generation: () => 4,
      active: () => true,
      nextId: () => 1,
      onGeneration: vi.fn(),
      files: () => [],
    });
    await store.sync("C:/work/demo");
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    try {
      const start = performance.now();
      render(FileSearch, {
        store,
        disabled: false,
        mode: "path",
        onMode: vi.fn(),
        onClose: vi.fn(),
        onOpen: vi.fn(),
      } as never);
      store.setPathQuery("file-");
      await waitFor(() => expect(store.pathResult?.entries.length).toBe(20_000));
      await tick();
      console.info("20000 path results render: " + (performance.now() - start).toFixed(2) + " ms");
      expect(document.querySelectorAll(".file-search-row").length).toBeLessThan(100);
      expect(document.querySelector(".file-search-note")?.textContent).toContain("已截断");
    } finally {
      height.mockRestore();
    }
  });

  it("远距离目标行不在已加载页时按偏移读取，而不是只滚动 DOM", async () => {
    api.repositoryFileContent.mockImplementation(
      (_repo: string, path: string, offset: number, _limit: number | undefined, generation: number) =>
        Promise.resolve({
          generation,
          path,
          kind: "text",
          size: 2_000_000,
          offset,
          lines: ["target-row"],
          nextOffset: offset + 1,
          hasMore: false,
          truncated: false,
          message: null,
        }),
    );
    const { container } = render(FileContent, {
      props: {
        active: true,
        opened,
        path: "src/gen/long.ts",
        line: 17500,
        lineSerial: 1,
        generation: opened.generation,
        disabled: false,
        nextId: () => 1,
        onGeneration: vi.fn(),
      } as never,
    });
    await waitFor(() =>
      expect(api.repositoryFileContent).toHaveBeenLastCalledWith(
        opened.summary.path,
        "src/gen/long.ts",
        17499,
        undefined,
        opened.generation,
        1,
      ),
    );
    await waitFor(() => expect(container.querySelector('[data-file-line="17500"]')).toBeTruthy());
  });
});

