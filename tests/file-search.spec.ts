import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryDirectory = vi.hoisted(() => vi.fn());
const repositoryFileContent = vi.hoisted(() => vi.fn());
const repositoryPathSearch = vi.hoisted(() => vi.fn());
const repositoryContentSearch = vi.hoisted(() => vi.fn());
const filePreview = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({
  api: { repositoryDirectory, repositoryFileContent, repositoryPathSearch, repositoryContentSearch, filePreview },
}));

import RepositoryFiles from "../src/lib/components/RepositoryFiles.svelte";
import FileContent from "../src/lib/components/FileContent.svelte";
import FileTree from "../src/lib/components/FileTree.svelte";
import {
  contentSearchRows,
  extraRow,
  flattenTree,
  groupContentMatches,
  makeNode,
  SEARCH_ROW_HEIGHT,
} from "../src/lib/files.svelte";
import type {
  OpenedRepository,
  RepositoryContentSearch,
  RepositoryDirectory,
  RepositoryDirectoryEntry,
} from "../src/lib/types";

const repoPath = "C:/work/demo";

function opened(path = repoPath, generation = 4): OpenedRepository {
  return {
    summary: { name: "demo", path },
    generation,
    snapshot: {
      generation,
      branch: {
        name: "main",
        detached: false,
        unborn: false,
        headOid: "a".repeat(40),
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        liveRemoteChecked: true,
        remoteCheckedAtMs: 1,
        remoteCheckStale: false,
      },
      files: [],
    },
    draft: "",
    watchDegraded: false,
  };
}

function entry(path: string, kind: RepositoryDirectoryEntry["kind"] = "file"): RepositoryDirectoryEntry {
  return { name: path.split("/").pop() ?? path, path, kind, ignored: false, size: kind === "file" ? 8 : null, error: null };
}

function dir(relative: string, entries: RepositoryDirectoryEntry[], generation = 4): RepositoryDirectory {
  return { generation, path: relative, entries, errors: [] };
}

/** 三层目录：src/components/Button.svelte 只有逐级读目录才看得见。 */
function treeDirs() {
  repositoryDirectory.mockImplementation((_repo: string, relative: string, _ignored: boolean, generation: number) => {
    if (relative === "") return Promise.resolve(dir("", [entry("src", "directory"), entry("README.md")], generation));
    if (relative === "src") {
      return Promise.resolve(
        dir("src", [entry("src/components", "directory"), entry("src/a.ts"), entry("src/b.ts")], generation),
      );
    }
    if (relative === "src/components") {
      return Promise.resolve(dir("src/components", [entry("src/components/Button.svelte")], generation));
    }
    return Promise.resolve(dir(relative, [], generation));
  });
}

function contentSearch(overrides: Partial<RepositoryContentSearch> = {}): RepositoryContentSearch {
  return {
    generation: 4,
    query: "panel",
    scope: "repository",
    scopePath: null,
    matches: [],
    filesScanned: 1,
    skipped: [],
    skippedFiles: 0,
    truncated: false,
    textTruncated: false,
    message: null,
    ...overrides,
  };
}

function viewProps(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    opened: opened(),
    disabled: false,
    nextId: () => 1,
    paneWidth: 280,
    windowWidth: 1280,
    onResize: vi.fn(),
    onResizeCommit: vi.fn(),
    onGeneration: vi.fn(),
    onFileHistory: vi.fn(),
    onOpenDiff: vi.fn(),
    onNav: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  repositoryDirectory.mockReset();
  repositoryFileContent.mockReset();
  repositoryPathSearch.mockReset();
  repositoryContentSearch.mockReset();
  filePreview.mockReset();
});

describe("搜索结果的形状", () => {
  it("全文匹配按文件分组，行与列保持后端给出的 1 起算值", () => {
    const groups = groupContentMatches([
      { path: "src/a.ts", line: 2, column: 3, text: "const panel = 1;" },
      { path: "src/a.ts", line: 9, column: 1, text: "panel" },
      { path: "src/b.ts", line: 40, column: 5, text: "x panel" },
    ]);
    expect(groups.map((group) => [group.path, group.matches.length])).toEqual([
      ["src/a.ts", 2],
      ["src/b.ts", 1],
    ]);
    const rows = contentSearchRows(contentSearch({ matches: groups.flatMap((group) => group.matches) }));
    expect(rows.filter((row) => row.kind === "group").map((row) => row.kind === "group" && row.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    const hit = rows.find((row) => row.kind === "match" && row.line === 40);
    expect(hit).toMatchObject({ kind: "match", path: "src/b.ts", line: 40, column: 5 });
    expect(SEARCH_ROW_HEIGHT).toBeGreaterThan(0);
  });

  it("树过滤补齐出来的路径是独立的一行，带全仓库标记", () => {
    const row = extraRow({ path: "src/components/Button.svelte", kind: "file", ignored: false });
    expect(row.extra).toBe(true);
    expect(row.label).toBe("src/components/Button.svelte");
    expect(flattenTree([makeNode({ name: "x", path: "x", kind: "file", ignored: false, size: 1, error: null })])).toHaveLength(1);
  });
});

describe("路径快速打开", () => {
  it("按路径查到文件后逐级读取祖先目录，并打开这个文件", async () => {
    treeDirs();
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "Button",
      directory: null,
      includeIgnored: false,
      scanned: 4,
      entries: [{ path: "src/components/Button.svelte", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });
    repositoryFileContent.mockResolvedValue({
      generation: 4,
      path: "src/components/Button.svelte",
      kind: "text",
      size: 10,
      offset: 0,
      lines: ["button"],
      nextOffset: 1,
      hasMore: false,
      truncated: false,
      message: null,
    });

    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());

    // 按路径打开收在文件树的「更多」里（也可以用 ⌘/Ctrl P）。
    await fireEvent.click(screen.getByRole("button", { name: "更多文件树选项" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "按路径打开" }));
    const input = screen.getByRole("textbox", { name: "按路径打开文件" });
    await fireEvent.input(input, { target: { value: "Button" } });
    await waitFor(() => expect(repositoryPathSearch).toHaveBeenCalled());
    expect(repositoryPathSearch.mock.calls[0].slice(0, 4)).toEqual([repoPath, "Button", null, false]);

    const option = await screen.findByRole("option", { name: /Button\.svelte/ });
    await fireEvent.click(option);

    await waitFor(() =>
      expect(repositoryDirectory.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining(["", "src", "src/components"])),
    );
    await waitFor(() =>
      expect(repositoryFileContent).toHaveBeenCalledWith(
        repoPath,
        "src/components/Button.svelte",
        0,
        undefined,
        4,
        expect.any(Number),
      ),
    );
    // 打开后回到目录树，选中这一行。
    expect(await screen.findByRole("treeitem", { name: /Button\.svelte/ })).toBeTruthy();
  });

  it("旧查询的结果不覆盖新查询，切换仓库后也不留旧路径", async () => {
    treeDirs();
    let finishOld!: (value: unknown) => void;
    repositoryPathSearch.mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)));
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "app",
      directory: null,
      includeIgnored: false,
      scanned: 2,
      entries: [{ path: "src/app.ts", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });

    const view = render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole("button", { name: "更多文件树选项" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "按路径打开" }));
    const input = screen.getByRole("textbox", { name: "按路径打开文件" });
    await fireEvent.input(input, { target: { value: "old" } });
    await fireEvent.input(input, { target: { value: "app" } });
    expect(await screen.findByRole("option", { name: /app\.ts/ })).toBeTruthy();

    // 旧查询这时才回来：它的路径不能出现在结果里。
    finishOld({
      generation: 4,
      query: "old",
      directory: null,
      includeIgnored: false,
      scanned: 1,
      entries: [{ path: "docs/old.md", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });
    await waitFor(() => expect(screen.queryByRole("option", { name: /old\.md/ })).toBeNull());

    repositoryDirectory.mockResolvedValue(dir("", [entry("other.ts")], 9));
    repositoryPathSearch.mockResolvedValue({
      generation: 9,
      query: "app",
      directory: null,
      includeIgnored: false,
      scanned: 1,
      entries: [{ path: "other.ts", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });
    await view.rerender(viewProps({ opened: opened("C:/work/other", 9) }) as never);
    // 切仓库即清空旧结果与查询：旧仓库的路径不会出现在新仓库的搜索里。
    await waitFor(() => expect(screen.queryByRole("option", { name: /app\.ts/ })).toBeNull());
    const fresh = (await screen.findByRole("textbox", { name: "按路径打开文件" })) as HTMLInputElement;
    expect(fresh.value).toBe("");
    await fireEvent.input(fresh, { target: { value: "app" } });
    await waitFor(() =>
      expect(repositoryPathSearch).toHaveBeenLastCalledWith("C:/work/other", "app", null, false, 200, 9, expect.any(Number)),
    );
    expect(await screen.findByRole("option", { name: /other\.ts/ })).toBeTruthy();
  });
});

describe("全仓库文本搜索", () => {
  it("结果按文件分组，方向键加 Enter 打开未加载的远距离目标行", async () => {
    treeDirs();
    repositoryContentSearch.mockResolvedValue(
      contentSearch({
        matches: [
          { path: "src/a.ts", line: 2, column: 3, text: "const panel = 1;" },
          { path: "src/a.ts", line: 9, column: 1, text: "panel" },
          { path: "src/b.ts", line: 40, column: 5, text: "x panel" },
        ],
      }),
    );
    repositoryFileContent.mockImplementation((_repo: string, path: string, offset: number, _limit: number | undefined, generation: number) =>
      Promise.resolve({
        generation,
        path,
        kind: "text",
        size: 200,
        offset,
        lines: ["row"],
        nextOffset: offset + 1,
        hasMore: false,
        truncated: false,
        message: null,
      }),
    );

    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    const input = screen.getByRole("textbox", { name: "全仓库文本搜索" });
    await fireEvent.input(input, { target: { value: "panel" } });

    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalled());
    expect(repositoryContentSearch.mock.calls[0][2]).toEqual({ kind: "repository" });
    expect(await screen.findByText("3 处匹配", { exact: false })).toBeTruthy();
    const firstGroup = document.querySelector('.file-search-group[title="src/a.ts"]')!;
    expect(firstGroup.querySelector(".search-count")?.textContent).toBe("2 处");
    expect(firstGroup.querySelector(".search-count")?.getAttribute("aria-label")).toBe("2 处匹配");
    const hits = screen.getAllByRole("option").filter((item) => item.className.includes("hit"));
    expect(hits).toHaveLength(3);
    expect(hits[0].textContent).toContain("2:3");
    expect(hits[0].querySelector(".hit-column")?.textContent).toBe(":3");
    expect(hits[2].textContent).toContain("x panel");
    // 命中部分单独加亮。
    expect(hits[2].querySelector("mark")?.textContent).toBe("panel");

    // 方向键在可选行之间移动，Enter 打开第三条（src/b.ts 第 40 行）。
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(repositoryFileContent).toHaveBeenCalledWith(repoPath, "src/b.ts", 39, undefined, 4, expect.any(Number)),
    );
  });

  it("范围、忽略开关、截断、跳过与局部错误分别可辨", async () => {
    treeDirs();
    repositoryContentSearch.mockResolvedValue(contentSearch());
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    const input = screen.getByRole("textbox", { name: "全仓库文本搜索" });
    await fireEvent.input(input, { target: { value: "panel" } });
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalled());
    expect(await screen.findByText("没有匹配")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "仅改动" }));
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenLastCalledWith(repoPath, "panel", { kind: "changed" }, false, 200, 4, expect.any(Number)));

    await fireEvent.click(screen.getByRole("checkbox", { name: /包含忽略/ }));
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenLastCalledWith(repoPath, "panel", { kind: "changed" }, true, 200, 4, expect.any(Number)));

    repositoryContentSearch.mockResolvedValue(
      contentSearch({ matches: [{ path: "src/a.ts", line: 3, column: 1, text: "panel" }], truncated: true, skippedFiles: 3, textTruncated: true, message: "结果达到上限。" }),
    );
    await fireEvent.input(input, { target: { value: "panel " } });
    await waitFor(() => expect(screen.getByText(/已截断/)).toBeTruthy());
    expect(screen.getByText(/跳过 3 个文件/)).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.querySelector(".file-search-note-main")?.textContent).toBe("1 处匹配 · 1 个文件");
    expect(
      [...status.querySelectorAll(".file-search-note-meta > span")].map((item) => item.textContent),
    ).toEqual(["已截断，请缩小范围", "片段被截短", "跳过 3 个文件"]);

    repositoryContentSearch.mockRejectedValue({ code: "io", message: "无法读取 src/b.ts。" });
    await fireEvent.input(input, { target: { value: "pane" } });
    await waitFor(() => expect(screen.getByText("无法读取 src/b.ts。")).toBeTruthy());
    expect(screen.queryByRole("option", { name: /panel/ })).toBeNull();
  });

  it("当前目录范围只在选中目录时可用，并把该目录交给后端", async () => {
    treeDirs();
    repositoryContentSearch.mockResolvedValue(contentSearch());
    render(RepositoryFiles, { props: viewProps() as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    const input = screen.getByRole("textbox", { name: "全仓库文本搜索" });

    // 还没选中任何东西：当前目录不可用，并给出原因。
    const directoryScope = screen.getByRole("button", { name: "当前目录" }) as HTMLButtonElement;
    expect(directoryScope.disabled).toBe(true);
    expect(directoryScope.title).toContain("先在文件树里选中");

    await fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    const freshTree = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(within(freshTree).getByRole("treeitem", { name: /src/ }));
    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "全仓库文本搜索" }), { target: { value: "panel" } });
    await fireEvent.click(screen.getByRole("button", { name: "当前目录" }));
    await waitFor(() =>
      expect(repositoryContentSearch).toHaveBeenLastCalledWith(repoPath, "panel", { kind: "directory", path: "src" }, false, 200, 4, expect.any(Number)),
    );
    expect(input).toBeTruthy();
  });
});

describe("四处查找各自说明范围", () => {
  it("目录树筛选只说路径、全仓库搜索说工作区文本，读法不混用", async () => {
    treeDirs();
    repositoryContentSearch.mockResolvedValue(contentSearch());
    render(RepositoryFiles, { props: viewProps() as never });

    const filter = await screen.findByRole("textbox", { name: "过滤文件树" });
    expect(filter.getAttribute("data-search-scope")).toBe("tree");
    expect(filter.getAttribute("title")).toContain("不读文件内容");

    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    const content = screen.getByRole("textbox", { name: "全仓库文本搜索" });
    expect(content.getAttribute("data-search-scope")).toBe("content");
    expect(content.getAttribute("title")).toContain("工作区文本");
    expect(content.getAttribute("data-search-scope")).not.toBe(filter.getAttribute("data-search-scope"));

    await fireEvent.click(screen.getByRole("button", { name: "按路径打开" }));
    const path = screen.getByRole("textbox", { name: "按路径打开文件" });
    expect(path.getAttribute("data-search-scope")).toBe("path");
    expect(path.getAttribute("title")).toContain("只查路径");
    expect(path.getAttribute("title")).toContain("不读取文件内容");
    // 同一个面板里换的是范围不同的两个输入，不是同一个输入换措辞。
    expect(screen.queryByRole("textbox", { name: "全仓库文本搜索" })).toBeNull();
  });
});

describe("目录树全局过滤", () => {
  it("已展开部分本地过滤，未展开的匹配由路径搜索补齐并可定位", async () => {
    treeDirs();
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "Button",
      directory: null,
      includeIgnored: false,
      scanned: 4,
      entries: [{ path: "src/components/Button.svelte", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });
    repositoryFileContent.mockResolvedValue({
      generation: 4,
      path: "src/components/Button.svelte",
      kind: "text",
      size: 10,
      offset: 0,
      lines: ["button"],
      nextOffset: 1,
      hasMore: false,
      truncated: false,
      message: null,
    });

    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "Button" } });

    const extra = await screen.findByRole("treeitem", { name: /Button\.svelte/ });
    expect(extra.textContent).toContain("全仓库");
    expect(extra.getAttribute("title")).toBe("src/components/Button.svelte");

    await fireEvent.click(extra);
    await waitFor(() =>
      expect(repositoryFileContent).toHaveBeenCalledWith(
        repoPath,
        "src/components/Button.svelte",
        0,
        undefined,
        4,
        expect.any(Number),
      ),
    );
    // 定位后过滤被清空，目标所在分支已经展开。
    expect(await screen.findByRole("treeitem", { name: /src/ })).toBeTruthy();
  });
});

describe("目录树全局过滤的状态", () => {
  function pathEntries(count: number) {
    return Array.from({ length: count }, (_item, index) => ({
      path: `vendor/generated/part-${String(index).padStart(2, "0")}.ts`,
      kind: "file" as const,
      ignored: false,
    }));
  }

  it("补齐被截断时说结果不完整，不显示「没有匹配的路径」", async () => {
    treeDirs();
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "part",
      directory: null,
      includeIgnored: false,
      scanned: 400,
      entries: pathEntries(70),
      truncated: true,
      message: "路径结果达到上限。",
    });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "part" } });

    await waitFor(() => expect(screen.getByText(/补齐结果不完整/)).toBeTruthy());
    expect(screen.queryByText("没有匹配的路径")).toBeNull();
    expect(screen.queryByText(/补齐也没有找到更多路径/)).toBeNull();
  });

  it("补齐超过显示上限时说明只列了前 60 条，行数也确实有上限", async () => {
    treeDirs();
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "part",
      directory: null,
      includeIgnored: false,
      scanned: 400,
      entries: pathEntries(70),
      truncated: false,
      message: null,
    });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "part" } });

    await waitFor(() => expect(screen.getByText(/只显示前 60 条/)).toBeTruthy());
    // 行数受虚拟化窗口影响，但绝不会超过上限。
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(60);
    expect(screen.queryByText("没有匹配的路径")).toBeNull();
  });

  it("补齐失败时显示失败原因，不把失败说成没有匹配", async () => {
    treeDirs();
    repositoryPathSearch.mockRejectedValue({ code: "io", message: "无法遍历 src 目录。" });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "nothing-here" } });

    await waitFor(() => expect(screen.getAllByText(/全仓库补齐失败/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/无法遍历 src 目录。/).length).toBeGreaterThan(0);
    expect(screen.queryByText("没有匹配的路径")).toBeNull();
    expect(screen.queryByText(/补齐也没有找到更多路径/)).toBeNull();
  });

  it("补齐失败时就地重试同一个过滤词，不用改词或重开视图", async () => {
    treeDirs();
    repositoryPathSearch.mockRejectedValue({ code: "io", message: "无法遍历 src 目录。" });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "part" } });
    await waitFor(() => expect(screen.getAllByText(/全仓库补齐失败/).length).toBeGreaterThan(0));

    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "part",
      directory: null,
      includeIgnored: false,
      scanned: 3,
      entries: pathEntries(2),
      truncated: false,
      message: null,
    });
    const calls = repositoryPathSearch.mock.calls.length;
    await fireEvent.click(screen.getAllByRole("button", { name: "重试补齐" })[0]);
    // 同一个过滤词原样重发：不是让用户先改词，也不是靠换视图触发。
    await waitFor(() => expect(repositoryPathSearch).toHaveBeenLastCalledWith(repoPath, "part", null, false, 200, 4, expect.any(Number)));
    expect(repositoryPathSearch.mock.calls.length).toBeGreaterThan(calls);
    await waitFor(() => expect(screen.queryByText(/全仓库补齐失败/)).toBeNull());
  });

  it("选中目录变化后按新目录重查，结果范围与界面一致", async () => {
    treeDirs();
    repositoryContentSearch.mockResolvedValue(contentSearch());
    render(RepositoryFiles, { props: viewProps() as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(within(treeEl).getByRole("treeitem", { name: /src/ }));
    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "全仓库文本搜索" }), { target: { value: "panel" } });
    await fireEvent.click(screen.getByRole("button", { name: "当前目录" }));
    await waitFor(() =>
      expect(repositoryContentSearch).toHaveBeenLastCalledWith(
        repoPath,
        "panel",
        { kind: "directory", path: "src" },
        false,
        200,
        4,
        expect.any(Number),
      ),
    );
    // 结果里带回的范围就是界面显示的那一个。
    repositoryContentSearch.mockResolvedValue({
      ...contentSearch(),
      scope: "directory",
      scopePath: "src",
      matches: [{ path: "src/a.ts", line: 1, column: 1, text: "panel" }],
    });
    await fireEvent.input(screen.getByRole("textbox", { name: "全仓库文本搜索" }), { target: { value: "panel " } });
    await waitFor(() => expect(screen.getByText(/范围 src/)).toBeTruthy());

    // 关掉面板、改选更深一层的目录：目录范围必须跟着改，不能留着旧目录的结果。
    await fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    const freshTree = await screen.findByRole("tree", { name: "仓库文件" });
    // 先前单击 src 时已经展开了它（单击目录即展开）：这里直接选更深一层。
    expect(within(freshTree).getByRole("button", { name: "折叠 src" })).toBeTruthy();
    const nested = await within(screen.getByRole("tree", { name: "仓库文件" })).findByRole("treeitem", { name: /components/ });
    await fireEvent.click(nested);
    await waitFor(() =>
      expect(repositoryContentSearch).toHaveBeenLastCalledWith(
        repoPath,
        "panel",
        { kind: "directory", path: "src/components" },
        false,
        200,
        4,
        expect.any(Number),
      ),
    );
  });
});

/**
 * 失败状态不能只有一句原因：R2 要求「失败时给出可执行的恢复方式」，R6 要求
 * 需要用户处理的错误在相关位置能找到恢复入口，所以恢复动作必须和原因在同一处。
 */
describe("查找失败到就地恢复的路径（R2/R6）", () => {
  function alertContaining(needle: string): HTMLElement | undefined {
    return screen.getAllByRole("alert").find((node) => (node.textContent ?? "").includes(needle));
  }

  it("全文搜索失败时原因旁就能重发同一个查询", async () => {
    treeDirs();
    repositoryContentSearch.mockRejectedValue({ code: "io", message: "无法读取 src/b.ts。" });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "全仓库文本搜索" }), { target: { value: "panel" } });
    await waitFor(() => expect(alertContaining("无法读取 src/b.ts。")).toBeTruthy());
    const alert = alertContaining("无法读取 src/b.ts。")!;
    // 恢复入口与原因在同一个失败块里：不需要先关闭搜索再去别处找。
    expect(within(alert).getByRole("button", { name: "重试搜索" })).toBeTruthy();

    repositoryContentSearch.mockResolvedValue(
      contentSearch({ matches: [{ path: "src/a.ts", line: 2, column: 1, text: "panel" }] }),
    );
    await fireEvent.click(within(alert).getByRole("button", { name: "重试搜索" }));
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("option", { name: /panel/ })).toBeTruthy();
    expect(screen.queryByText("无法读取 src/b.ts。")).toBeNull();
  });

  it("全文搜索失败时可重新读取目录，读完后自动重跑这次搜索", async () => {
    treeDirs();
    repositoryContentSearch.mockRejectedValue({ code: "io", message: "搜索时有一个目录读取失败。" });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "全仓库文本搜索" }), { target: { value: "panel" } });
    await waitFor(() => expect(alertContaining("搜索时有一个目录读取失败。")).toBeTruthy());
    const alert = alertContaining("搜索时有一个目录读取失败。")!;

    const readsBefore = repositoryDirectory.mock.calls.length;
    repositoryContentSearch.mockResolvedValue(
      contentSearch({ matches: [{ path: "src/a.ts", line: 2, column: 1, text: "panel" }] }),
    );
    await fireEvent.click(within(alert).getByRole("button", { name: "重新读取目录" }));
    await waitFor(() => expect(repositoryDirectory.mock.calls.length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("option", { name: /panel/ })).toBeTruthy();
  });

  /**
   * 失败块会随请求开始被撤下再重建：恢复动作点完焦点若掉到 body，键盘用户每次重试
   * 都要从页面开头重新 Tab。R2 要求只用键盘也能连续操作，所以焦点必须留在搜索区。
   */
  it("点恢复动作后焦点留在搜索框，不掉到 body", async () => {
    treeDirs();
    repositoryContentSearch.mockRejectedValue({ code: "io", message: "搜索时有一个目录读取失败。" });
    render(RepositoryFiles, { props: viewProps() as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "全仓库搜索" }));
    const input = screen.getByRole("textbox", { name: "全仓库文本搜索" });
    await fireEvent.input(input, { target: { value: "panel" } });
    await waitFor(() => expect(alertContaining("搜索时有一个目录读取失败。")).toBeTruthy());

    const alert = alertContaining("搜索时有一个目录读取失败。")!;
    await fireEvent.click(within(alert).getByRole("button", { name: "重试搜索" }));
    await waitFor(() => expect(document.activeElement).toBe(input));

    repositoryContentSearch.mockRejectedValue({ code: "io", message: "搜索时有一个目录读取失败。" });
    await fireEvent.input(input, { target: { value: "panel " } });
    await waitFor(() => expect(alertContaining("搜索时有一个目录读取失败。")).toBeTruthy());
    const again = alertContaining("搜索时有一个目录读取失败。")!;
    await fireEvent.click(within(again).getByRole("button", { name: "重新读取目录" }));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});

describe("文件内搜索的代次边界", () => {
  it("显示匹配后代次前进：撤下结果与旧行号，不跳到新内容的错误位置", async () => {
    repositoryFileContent.mockImplementation((_repo: string, path: string, offset: number, _limit: number | undefined, generation: number) =>
      Promise.resolve({
        generation,
        path,
        kind: "text",
        size: 40,
        offset,
        lines: ["alpha", "beta panel", "gamma"],
        nextOffset: 3,
        hasMore: false,
        truncated: false,
        message: null,
      }),
    );
    repositoryContentSearch.mockResolvedValue(
      contentSearch({ scope: "file", scopePath: "src/a.ts", matches: [{ path: "src/a.ts", line: 2, column: 6, text: "beta panel" }] }),
    );

    const view = render(FileContent, {
      props: {
        active: true,
        opened: opened(),
        path: "src/a.ts",
        generation: 4,
        disabled: false,
        nextId: () => 1,
        onGeneration: vi.fn(),
      } as never,
    });
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "在文件内搜索" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "文件内搜索关键词" }), { target: { value: "panel" } });
    expect(await screen.findByRole("option", { name: /beta panel/ })).toBeTruthy();

    // 代次前进：旧匹配的行号不再可信，结果与高亮都要消失。
    await view.rerender({
      active: true,
      opened: opened(repoPath, 5),
      path: "src/a.ts",
      generation: 5,
      disabled: false,
      nextId: () => 1,
      onGeneration: vi.fn(),
    } as never);
    await waitFor(() => expect(screen.queryByRole("option", { name: /beta panel/ })).toBeNull());
    expect(document.querySelector(".file-line.hit")).toBeNull();
  });
});
