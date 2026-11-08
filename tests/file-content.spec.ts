import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFileContent = vi.hoisted(() => vi.fn());
const repositoryContentSearch = vi.hoisted(() => vi.fn());
const filePreview = vi.hoisted(() => vi.fn());
const repositoryDocument = vi.hoisted(() => vi.fn());
const documentResource = vi.hoisted(() => vi.fn());
const openDocumentUrl = vi.hoisted(() => vi.fn());
const cancelDocumentResources = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/lib/api", () => ({
  api: {
    repositoryFileContent,
    repositoryContentSearch,
    filePreview,
    repositoryDocument,
    documentResource,
    documentRemoteImage: vi.fn(),
    openDocumentUrl,
    cancelDocumentResources,
  },
}));
// 沙箱禁止管道子进程，Vite 无法转换 Worker URL：这里只验证文本与定位，分词不作为被测行为。
const cancelHighlight = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/syntax/client", () => ({ highlightLines: vi.fn(() => cancelHighlight) }));
import FileContent from "../src/lib/components/FileContent.svelte";
import { resetSyntaxPrefs } from "../src/lib/syntax/prefs.svelte";
import type { OpenedRepository, RepositoryContentSearch, RepositoryDocument, RepositoryFileContent } from "../src/lib/types";

const repoPath = "C:/work/demo";

const opened: OpenedRepository = {
  summary: { name: "demo", path: repoPath },
  generation: 4,
  snapshot: {
    generation: 4,
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
    files: [
      { path: "src/App.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
    ],
  },
  draft: "",
  watchDegraded: false,
};

function text(overrides: Partial<RepositoryFileContent> = {}): RepositoryFileContent {
  return {
    generation: 4,
    path: "src/App.ts",
    kind: "text",
    size: 2048,
    offset: 0,
    lines: ["import { api } from \"./api\";", "", "const value = 1;"],
    nextOffset: 3,
    hasMore: false,
    truncated: false,
    message: null,
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    opened,
    path: "src/App.ts",
    generation: 4,
    disabled: false,
    nextId: () => 1,
    onGeneration: vi.fn(),
    onFileHistory: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  repositoryFileContent.mockReset();
  repositoryContentSearch.mockReset();
  filePreview.mockReset();
  repositoryDocument.mockReset();
  documentResource.mockReset();
  openDocumentUrl.mockReset();
  cancelDocumentResources.mockClear();
  resetSyntaxPrefs();
});

describe("代码页", () => {
  it("显示面包屑、Git 状态、语言、大小与行号", async () => {
    repositoryFileContent.mockResolvedValue(text());
    const { container } = render(FileContent, { props: props() as never });
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("App.ts")).toBeTruthy();
    expect(screen.getByTitle("src/App.ts")).toBeTruthy();
    expect(screen.getByLabelText("Git 状态：修改")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: /语法高亮语言/ })).toBeTruthy();
    const first = container.querySelector('[data-file-line="1"]')!;
    expect(first.textContent).toContain("import");
    // 空白行也要占一个行号，不能把空行挤掉。
    expect(container.querySelector('[data-file-line="2"]')).toBeTruthy();
  });

  it("续读从上次结束处继续，并在读完后收起入口", async () => {
    repositoryFileContent.mockResolvedValueOnce(text({ hasMore: true, nextOffset: 3 }));
    const view = render(FileContent, { props: props() as never });
    const more = await screen.findByRole("button", { name: /继续读取后续内容/ });
    repositoryFileContent.mockResolvedValueOnce(text({ offset: 3, lines: ["line-4", "line-5"], nextOffset: 5, hasMore: false }));
    await fireEvent.click(more);
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/App.ts", 3, undefined, 4, 1));
    await waitFor(() => expect(screen.getByText("line-5")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /继续读取后续内容/ })).toBeNull();
    await view.rerender(props() as never);
  });

  it("跳行按偏移重新读取，目标不在已加载页时不只滚动 DOM", async () => {
    repositoryFileContent.mockResolvedValueOnce(text());
    const { container } = render(FileContent, { props: props() as never });
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    repositoryFileContent.mockResolvedValueOnce(text({ offset: 119, lines: ["const target = 1;"], nextOffset: 120 }));
    await fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "跳到行" }));
    const input = await screen.findByLabelText("跳到行号");
    await fireEvent.input(input, { target: { value: "120" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/App.ts", 119, undefined, 4, 1));
    expect(await screen.findByText(/正在显示第 120 行起的内容/)).toBeTruthy();
    expect(container.querySelector('[data-file-line="120"]')).toBeTruthy();
  });

  it("文件内搜索走单文件 scope，可跳到未加载的那一行", async () => {
    repositoryFileContent.mockResolvedValueOnce(text());
    repositoryContentSearch.mockResolvedValue({
      generation: 4,
      query: "needle",
      scope: "file",
      scopePath: "src/App.ts",
      matches: [{ path: "src/App.ts", line: 90, column: 3, text: "  const needle = 1;" }],
      filesScanned: 1,
      skipped: [],
      skippedFiles: 0,
      truncated: false,
      textTruncated: false,
      message: null,
    } satisfies RepositoryContentSearch);
    const view = render(FileContent, { props: props() as never });
    await fireEvent.click(await screen.findByRole("button", { name: "在文件内搜索" }));
    const input = await screen.findByLabelText("文件内搜索关键词");
    await fireEvent.input(input, { target: { value: "needle" } });
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalled());
    expect(repositoryContentSearch.mock.calls[0].slice(0, 4)).toEqual([repoPath, "needle", { kind: "file", path: "src/App.ts" }, false]);

    expect(await screen.findByText(/1 处匹配/)).toBeTruthy();
    repositoryFileContent.mockResolvedValueOnce(text({ offset: 89, lines: ["  const needle = 1;"], nextOffset: 90 }));
    await fireEvent.click(screen.getByRole("option"));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/App.ts", 89, undefined, 4, 1));
    await view.rerender(props() as never);
  });

  it("A 文件搜索未返回就切到 B：旧匹配不显示、也不按旧行号跳行", async () => {
    repositoryFileContent.mockResolvedValue(text());
    let finishSearch!: (value: RepositoryContentSearch) => void;
    repositoryContentSearch.mockImplementationOnce(() => new Promise<RepositoryContentSearch>((resolve) => (finishSearch = resolve)));
    const view = render(FileContent, { props: props() as never });
    await fireEvent.click(await screen.findByRole("button", { name: "在文件内搜索" }));
    const input = await screen.findByLabelText("文件内搜索关键词");
    await fireEvent.input(input, { target: { value: "needle" } });
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalledTimes(1));
    expect(repositoryContentSearch.mock.calls[0][2]).toEqual({ kind: "file", path: "src/App.ts" });

    repositoryFileContent.mockResolvedValue(text({ path: "src/other.ts", lines: ["const other = true;"] }));
    await view.rerender(props({ path: "src/other.ts" }) as never);
    await waitFor(() => expect(screen.getByText("const other = true;")).toBeTruthy());
    repositoryFileContent.mockClear();

    // 旧文件的匹配这时才回来：既不能写进当前文件，也不能成为跳行目标。
    finishSearch({
      generation: 4,
      query: "needle",
      scope: "file",
      scopePath: "src/App.ts",
      matches: [{ path: "src/App.ts", line: 90, column: 3, text: "  const needle = 1;" }],
      filesScanned: 1,
      skipped: [],
      skippedFiles: 0,
      truncated: false,
      textTruncated: false,
      message: null,
    } satisfies RepositoryContentSearch);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await fireEvent.click(await screen.findByRole("button", { name: "在文件内搜索" }));
    expect(screen.queryByText(/处匹配/)).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
    expect(repositoryFileContent.mock.calls.every((call) => call[2] !== 89)).toBe(true);
  });

  it("代次前进后旧代次的搜索响应不再显示", async () => {
    repositoryFileContent.mockResolvedValue(text());
    let finishSearch!: (value: RepositoryContentSearch) => void;
    repositoryContentSearch.mockImplementationOnce(() => new Promise<RepositoryContentSearch>((resolve) => (finishSearch = resolve)));
    const view = render(FileContent, { props: props() as never });
    await fireEvent.click(await screen.findByRole("button", { name: "在文件内搜索" }));
    const input = await screen.findByLabelText("文件内搜索关键词");
    await fireEvent.input(input, { target: { value: "needle" } });
    await waitFor(() => expect(repositoryContentSearch).toHaveBeenCalledTimes(1));

    await view.rerender(props({ generation: 5 }) as never);
    finishSearch({
      generation: 4,
      query: "needle",
      scope: "file",
      scopePath: "src/App.ts",
      matches: [{ path: "src/App.ts", line: 2, column: 3, text: "const needle = 1;" }],
      filesScanned: 1,
      skipped: [],
      skippedFiles: 0,
      truncated: false,
      textTruncated: false,
      message: null,
    } satisfies RepositoryContentSearch);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(/处匹配/)).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("未知扩展名按纯文本显示，原文仍然可读", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "Makefile", lines: ["all:", "\tgo build ./..."] }));
    const { container } = render(FileContent, { props: props({ path: "Makefile" }) as never });
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(screen.getByRole("button", { name: /语法高亮语言/ })).toBeTruthy();
    expect(container.querySelector('[data-file-line="1"]')!.textContent).toContain("all:");
  });
});

describe("真实状态与读取边界", () => {
  it("无关文件的代次变化保留已加载分页、DOM 与阅读位置", async () => {
    repositoryFileContent.mockResolvedValueOnce(text({ hasMore: true }));
    const view = render(FileContent, { props: props({ contentVersion: "unchanged" }) as never });
    const more = await screen.findByRole("button", { name: /继续读取后续内容/ });
    repositoryFileContent.mockResolvedValueOnce(text({ offset: 3, lines: ["last loaded line"], nextOffset: 4 }));
    await fireEvent.click(more);
    await screen.findByText("last loaded line");
    const scroller = view.container.querySelector<HTMLElement>(".file-code")!;
    const row = view.container.querySelector('[data-file-line="1"]');
    scroller.scrollTop = 40;
    await fireEvent.scroll(scroller);
    for (let generation = 5; generation < 9; generation++) {
      await view.rerender(props({ generation, contentVersion: "unchanged" }) as never);
    }
    expect(repositoryFileContent).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-file-line="1"]')).toBe(row);
    expect(scroller.scrollTop).toBe(40);
    expect(screen.getByText("last loaded line")).toBeTruthy();
    expect(screen.queryByLabelText("正在读取文件")).toBeNull();
  });

  it("当前文件版本变化和手动刷新仍读取最新内容", async () => {
    repositoryFileContent.mockResolvedValueOnce(text());
    const view = render(FileContent, { props: props({ contentVersion: "before" }) as never });
    await screen.findByText("const value = 1;");
    repositoryFileContent.mockResolvedValueOnce(text({ lines: ["changed file"] }));
    await view.rerender(props({ contentVersion: "after" }) as never);
    await screen.findByText("changed file");
    repositoryFileContent.mockResolvedValueOnce(text({ lines: ["manual refresh"] }));
    await view.rerender(props({ contentVersion: "after", reloadKey: 1 }) as never);
    await screen.findByText("manual refresh");
    expect(repositoryFileContent).toHaveBeenCalledTimes(3);
  });

  it("续读遇到文件已变时重新读取，不把两份版本拼在一起", async () => {
    repositoryFileContent.mockResolvedValueOnce(text({ version: "old", hasMore: true }));
    render(FileContent, { props: props({ contentVersion: "old" }) as never });
    const more = await screen.findByRole("button", { name: /继续读取后续内容/ });
    repositoryFileContent.mockResolvedValueOnce(text({ version: "new", offset: 3, lines: ["new tail"] }));
    repositoryFileContent.mockResolvedValueOnce(text({ version: "new", lines: ["new complete page"] }));
    await fireEvent.click(more);
    await screen.findByText("new complete page");
    expect(screen.queryByText("const value = 1;")).toBeNull();
    expect(screen.queryByText("new tail")).toBeNull();
    expect(repositoryFileContent.mock.calls.map((call) => call[2])).toEqual([0, 3, 0]);
  });

  it("无关文件变化保留文件内搜索命中，当前文件变化才撤下", async () => {
    repositoryFileContent.mockResolvedValue(text());
    repositoryContentSearch.mockResolvedValue({
      generation: 4, query: "value", scope: "file", scopePath: "src/App.ts",
      matches: [{ path: "src/App.ts", line: 3, column: 7, text: "const value = 1;" }],
      filesScanned: 1, skipped: [], skippedFiles: 0, truncated: false, textTruncated: false, message: null,
    } satisfies RepositoryContentSearch);
    const view = render(FileContent, { props: props({ contentVersion: "before" }) as never });
    await fireEvent.click(await screen.findByRole("button", { name: "在文件内搜索" }));
    await fireEvent.input(await screen.findByLabelText("文件内搜索关键词"), { target: { value: "value" } });
    await screen.findByRole("option");
    await view.rerender(props({ generation: 5, contentVersion: "before" }) as never);
    expect(screen.getByRole("option")).toBeTruthy();
    expect(repositoryContentSearch).toHaveBeenCalledOnce();
    expect(repositoryFileContent).toHaveBeenCalledOnce();
    await view.rerender(props({ generation: 5, contentVersion: "after" }) as never);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("无关代次变化不重复发送仍在途的文件读取", async () => {
    let finish!: (value: RepositoryFileContent) => void;
    repositoryFileContent.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(FileContent, { props: props({ contentVersion: "same" }) as never });
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalledOnce());
    await view.rerender(props({ generation: 5, contentVersion: "same" }) as never);
    expect(repositoryFileContent).toHaveBeenCalledOnce();
    finish(text({ generation: 5 }));
    await screen.findByText("const value = 1;");
  });

  it("没有改动的文件就地说明当前无改动，历史入口仍然可用", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "README.md" }));
    const onFileHistory = vi.fn();
    render(FileContent, { props: props({ path: "README.md", onFileHistory }) as never });
    // 无改动是这个文件的真实状态：在底部状态条就地说明，不另起一条提示占正文。
    await waitFor(() => expect(screen.getByText(/无本地改动/)).toBeTruthy());
    expect(screen.queryByLabelText(/Git 状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: /查看(未|已)暂存的改动/ })).toBeNull();
    // 说明只是状态，不是禁用：历史入口在「更多」里，点了就带上这个路径。
    await fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "查看文件历史" }));
    expect(onFileHistory).toHaveBeenCalledWith("README.md");
  });

  it("二进制、非法编码与缺失文件显示真实类型，不生成伪文本", async () => {
    repositoryFileContent.mockResolvedValueOnce(text());
    const view = render(FileContent, { props: props() as never });
    const { container } = view;
    await waitFor(() => expect(container.querySelector('[data-file-line="3"]')?.textContent).toContain("const value = 1;"));

    repositoryFileContent.mockResolvedValueOnce(text({ kind: "binary", lines: [], message: "二进制内容不作为文本读取。" }));
    await view.rerender(props({ generation: 5 }) as never);
    await waitFor(() => expect(screen.getByText("二进制文件")).toBeTruthy());
    expect(screen.getByText("二进制内容不作为文本读取。")).toBeTruthy();
    expect(container.querySelector("[data-file-line]")).toBeNull();
  });

  it("读取失败清掉旧内容，不把旧内容继续标成当前文件", async () => {
    repositoryFileContent.mockResolvedValueOnce(text());
    const view = render(FileContent, { props: props() as never });
    await waitFor(() => expect(screen.getByText("const value = 1;")).toBeTruthy());
    repositoryFileContent.mockRejectedValueOnce({ code: "path_unreadable", message: "文件已被删除。" });
    await view.rerender(props({ path: "src/App.ts", generation: 5 }) as never);
    expect(await screen.findByText("文件已被删除。")).toBeTruthy();
    expect(screen.queryByText("const value = 1;")).toBeNull();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
  });

  it("隐藏视图不发起读取，激活后按当代次重读", async () => {
    repositoryFileContent.mockResolvedValue(text());
    const view = render(FileContent, { props: props({ active: false }) as never });
    await Promise.resolve();
    expect(repositoryFileContent).not.toHaveBeenCalled();
    await view.rerender(props({ active: true }) as never);
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalledTimes(1));
    expect(repositoryFileContent.mock.calls[0][4]).toBe(4);

    repositoryFileContent.mockClear();
    await view.rerender(props({ active: false }) as never);
    await view.rerender(props({ active: false, generation: 6 }) as never);
    expect(repositoryFileContent).not.toHaveBeenCalled();
    await view.rerender(props({ active: true, generation: 6 }) as never);
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalledTimes(1));
    expect(repositoryFileContent.mock.calls[0][4]).toBe(6);
  });

  it("迟到的旧文件响应不覆盖新的当前文件", async () => {
    let finishOld!: (value: RepositoryFileContent) => void;
    repositoryFileContent.mockImplementationOnce(() => new Promise<RepositoryFileContent>((resolve) => (finishOld = resolve)));
    const view = render(FileContent, { props: props() as never });
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalledTimes(1));
    repositoryFileContent.mockResolvedValueOnce(text({ path: "src/other.ts", lines: ["const other = true;"] }));
    await view.rerender(props({ path: "src/other.ts" }) as never);
    await waitFor(() => expect(screen.getByText("const other = true;")).toBeTruthy());
    finishOld(text({ lines: ["const stale = true;"] }));
    await Promise.resolve();
    expect(screen.queryByText("const stale = true;")).toBeNull();
  });
});

describe("资源文件", () => {
  it("资源文件用 worktree 版本走 file_preview，标签是当前文件", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "assets/logo.png", kind: "resource", lines: [], message: "此文件使用只读资源预览。" }));
    filePreview.mockResolvedValue({
      generation: 4,
      kind: "image",
      size: 1024,
      dataUrl: "data:image/png;base64,logo",
      entries: [],
      truncated: false,
      message: "",
      lfsOid: null,
      canDownload: false,
    });
    render(FileContent, { props: props({ path: "assets/logo.png" }) as never });
    await waitFor(() => expect(filePreview).toHaveBeenCalled());
    expect(filePreview.mock.calls[0][1]).toEqual({ revision: "worktree", path: "assets/logo.png" });
    expect(await screen.findByAltText("当前文件：assets/logo.png")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "预览版本" })).toBeNull();
  });

  it("SVG 先显示源码，可切到图片预览并仍用 file_preview", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "assets/icon.svg", lines: ["<svg>", "  <path d=\"M0 0\" />", "</svg>"] }));
    filePreview.mockResolvedValue({
      generation: 4,
      kind: "image",
      size: 128,
      dataUrl: "data:image/svg+xml;base64,icon",
      entries: [],
      truncated: false,
      message: "",
      lfsOid: null,
      canDownload: false,
    });
    const { container } = render(FileContent, { props: props({ path: "assets/icon.svg" }) as never });
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(container.textContent).toContain("<svg>");
    await fireEvent.click(screen.getByRole("button", { name: "预览这个 SVG 的图片" }));
    await waitFor(() => expect(filePreview).toHaveBeenCalled());
    expect(filePreview.mock.calls[0][1]).toEqual({ revision: "worktree", path: "assets/icon.svg" });
    expect(await screen.findByRole("button", { name: "查看这个 SVG 的源码" })).toBeTruthy();
  });
});

function markdownDoc(overrides: Partial<RepositoryDocument> = {}): RepositoryDocument {
  return {
    generation: 4,
    source: { revision: "worktree", path: "docs/a.md", repository: repoPath },
    kind: "text",
    size: 64,
    version: "v1",
    text: "# 标题\n\n正文段落",
    complete: true,
    offset: 0,
    lines: [],
    nextOffset: 0,
    hasMore: false,
    truncated: false,
    message: null,
    ...overrides,
  };
}

describe("Markdown 阅读接入", () => {
  it("普通打开默认排版预览，可在同一个文件里切回源码", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "docs/a.md", lines: ["# 标题", "", "正文段落"] }));
    repositoryDocument.mockResolvedValue(markdownDoc());
    const { container } = render(FileContent, { props: props({ path: "docs/a.md", contentVersion: "v1" }) as never });

    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
    expect(repositoryDocument).toHaveBeenCalledWith(repoPath, { revision: "worktree", path: "docs/a.md", repository: repoPath }, 4, 1, "document");
    // 预览优先：源码行不占正文，但状态条仍显示来源与只读。
    expect(container.querySelector("[data-file-line]")).toBeNull();
    expect(screen.getByTitle("这篇正文来自这个文件的工作区版本")).toBeTruthy();
    expect(screen.getByTitle("来源：工作区")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }).getAttribute("aria-pressed")).toBe("true");
    expect(repositoryFileContent).toHaveBeenCalledWith(repoPath, "docs/a.md", 0, undefined, 4, expect.any(Number));

    await fireEvent.click(screen.getByRole("button", { name: "预览这个 Markdown 文档" }));
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
  });

  it("搜索命中或跳到行进入源码并按目标行读取，不留在预览", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "docs/a.md", offset: 39, lines: ["第 40 行"], nextOffset: 40 }));
    repositoryDocument.mockResolvedValue(markdownDoc());
    render(FileContent, {
      props: props({ path: "docs/a.md", contentVersion: "v1", line: 40, lineSerial: 1 }) as never,
    });
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "docs/a.md", 39, undefined, 4, expect.any(Number)));
    await waitFor(() => expect(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("heading", { name: "标题" })).toBeNull();
  });

  it("文件内搜索从预览发起时先切到源码", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "docs/a.md", lines: ["# 标题"] }));
    repositoryDocument.mockResolvedValue(markdownDoc());
    render(FileContent, { props: props({ path: "docs/a.md", contentVersion: "v1" }) as never });
    await screen.findByRole("heading", { name: "标题" });
    await fireEvent.click(screen.getByRole("button", { name: "在文件内搜索" }));
    expect(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByLabelText("文件内搜索关键词")).toBeTruthy();
  });

  it("预览与源码位置按文件身份保存：换文件再回来接着读", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "docs/a.md", lines: ["# 标题", "", "正文段落"] }));
    repositoryDocument.mockImplementation((_repo: string, source: { path: string }) => Promise.resolve(markdownDoc({ source: { revision: "worktree", path: source.path, repository: repoPath } })));
    const markdownProps = props({ path: "docs/a.md", contentVersion: "v1" });
    const view = render(FileContent, { props: markdownProps as never });
    await screen.findByRole("heading", { name: "标题" });
    const scroller = view.container.querySelector<HTMLDivElement>(".md-scroll")!;
    scroller.scrollTop = 60;
    await fireEvent.scroll(scroller);

    repositoryFileContent.mockResolvedValue(text({ lines: ["const value = 1;"] }));
    await view.rerender(props({ path: "src/App.ts", contentVersion: "v2" }) as never);
    await screen.findByText("const value = 1;");

    await view.rerender(markdownProps as never);
    await screen.findByRole("heading", { name: "标题" });
    const restored = view.container.querySelector<HTMLDivElement>(".md-scroll")!;
    await waitFor(() => expect(restored.scrollTop).toBe(60));
  });

  it("工作区相对链接同步文件树并带上目标锚点，目标不存在时就地说明", async () => {
    repositoryDocument.mockResolvedValue(markdownDoc({ text: "[说明](guide.md#安装)" }));
    const onRevealPath = vi.fn(async () => true);
    render(FileContent, { props: props({ path: "docs/a.md", contentVersion: "v1", onRevealPath }) as never });
    await fireEvent.click(await screen.findByRole("link", { name: "说明" }));
    await waitFor(() => expect(onRevealPath).toHaveBeenCalledWith("docs/guide.md", null));

    repositoryDocument.mockResolvedValue(markdownDoc({ text: "[缺失](gone.md)", source: { revision: "worktree", path: "docs/b.md", repository: repoPath } }));
    const missing = vi.fn(async () => false);
    const view = render(FileContent, { props: props({ path: "docs/b.md", contentVersion: "v1", onRevealPath: missing }) as never });
    await fireEvent.click(await screen.findByRole("link", { name: "缺失" }));
    expect(await screen.findByText("这个版本里没有 docs/gone.md。")).toBeTruthy();
    expect(view.container.querySelector(".file-content")).toBeTruthy();
  });
});

  it("源码位置按身份保存：切到预览再回到源码仍回到原处", async () => {
    const many = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    repositoryFileContent.mockResolvedValue(text({ path: "docs/a.md", lines: many, nextOffset: 100 }));
    repositoryDocument.mockResolvedValue(markdownDoc());
    const view = render(FileContent, { props: props({ path: "docs/a.md", contentVersion: "v1" }) as never });
    await screen.findByRole("heading", { name: "标题" });

    await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));
    const scroller = view.container.querySelector<HTMLDivElement>(".file-code")!;
    scroller.scrollTop = 220;
    await fireEvent.scroll(scroller);
    // 位置写入按短延迟合并，先等它落地。
    await new Promise((resolve) => setTimeout(resolve, 150));

    await fireEvent.click(screen.getByRole("button", { name: "预览这个 Markdown 文档" }));
    await screen.findByRole("heading", { name: "标题" });
    await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));
    const restored = view.container.querySelector<HTMLDivElement>(".file-code")!;
    await waitFor(() => expect(restored.scrollTop).toBe(20));
    expect(view.container.querySelector('[data-file-line="12"]')).toBeTruthy();
  });
