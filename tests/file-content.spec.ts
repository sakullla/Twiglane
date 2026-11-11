import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const repositoryFileContent = vi.hoisted(() => vi.fn());
const repositoryContentSearch = vi.hoisted(() => vi.fn());
const filePreview = vi.hoisted(() => vi.fn());
const repositoryDocument = vi.hoisted(() => vi.fn());
const documentResource = vi.hoisted(() => vi.fn());
const openDocumentUrl = vi.hoisted(() => vi.fn());
const cancelDocumentResources = vi.hoisted(() => vi.fn(async () => {}));
const repositoryEditSnapshot = vi.hoisted(() => vi.fn());
const repositoryEditSave = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({
  api: {
    repositoryFileContent,
    repositoryEditSnapshot,
    repositoryEditSave,
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
import { createFileEditor } from "../src/lib/file-editor.svelte";
import type {
  OpenedRepository,
  RepositoryContentSearch,
  RepositoryDocument,
  RepositoryEditSnapshot,
  RepositoryFileContent,
} from "../src/lib/types";
import { formatBytes } from "../src/lib/ui";

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
  repositoryEditSnapshot.mockReset();
  repositoryEditSave.mockReset();
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

    // 标题旁提供一键复制路径并给出状态反馈
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const copyBtn = screen.getByRole("button", { name: "复制文件路径" });
    await fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("src/App.ts");
    expect(await screen.findByRole("button", { name: "已复制文件路径" })).toBeTruthy();
  });

  it("Ctrl+A 只选中这个文件的全部已读内容，复制写入整份文本，点一下或 Esc 取消", async () => {
    repositoryFileContent.mockResolvedValue(text());
    const { container } = render(FileContent, { props: props() as never });
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    const code = container.querySelector<HTMLElement>(".file-code")!;
    const selectAll = vi.spyOn(window.getSelection()!, "selectAllChildren");
    code.focus();
    const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    code.dispatchEvent(event);
    await tick();
    // 整个窗口不会被选中：原生全选被拦下，选区由代码区自己画。
    expect(event.defaultPrevented).toBe(true);
    expect(selectAll).not.toHaveBeenCalled();
    expect(code.classList.contains("select-all")).toBe(true);

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await fireEvent.keyDown(code, { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith('import { api } from "./api";\n\nconst value = 1;');

    await fireEvent.keyDown(code, { key: "Escape" });
    expect(code.classList.contains("select-all")).toBe(false);
    await fireEvent.keyDown(code, { key: "a", ctrlKey: true });
    expect(code.classList.contains("select-all")).toBe(true);
    await fireEvent.pointerDown(code);
    expect(code.classList.contains("select-all")).toBe(false);
    selectAll.mockRestore();
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

  it("文件内搜索失败时就地重试，或重读文件后重找", async () => {
    repositoryFileContent.mockResolvedValue(text());
    render(FileContent, { props: props() as never });
    await fireEvent.click(await screen.findByRole("button", { name: "在文件内搜索" }));
    const input = await screen.findByLabelText("文件内搜索关键词");

    repositoryContentSearch.mockRejectedValue({ code: "io", message: "无法在这个文件里搜索。" });
    await fireEvent.input(input, { target: { value: "value" } });
    await waitFor(() => expect(screen.getByText("无法在这个文件里搜索。")).toBeTruthy());
    // 原因旁边就是两个恢复动作：重发同一个关键词，或先重读文件再重找。
    expect(screen.getByRole("button", { name: "重试查找" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新读取文件" })).toBeTruthy();

    repositoryContentSearch.mockResolvedValue({
      generation: 4,
      query: "value",
      scope: "file",
      scopePath: "src/App.ts",
      matches: [{ path: "src/App.ts", line: 3, column: 7, text: "const value = 1;" }],
      filesScanned: 1,
      skipped: [],
      skippedFiles: 0,
      truncated: false,
      textTruncated: false,
      message: null,
    } satisfies RepositoryContentSearch);
    await fireEvent.click(screen.getByRole("button", { name: "重试查找" }));
    expect(await screen.findByText(/1 处匹配/)).toBeTruthy();
    expect(screen.queryByText("无法在这个文件里搜索。")).toBeNull();
    // 失败块随请求撤下又重建，焦点不能掉到 body：键盘用户要能接着在查找框里操作。
    expect(document.activeElement).toBe(screen.getByLabelText("文件内搜索关键词"));

    // 第二个入口：重读文件本身，读完后自动按当前内容重找一次，不停在「只重读不重找」。
    repositoryContentSearch.mockRejectedValueOnce({ code: "io", message: "无法在这个文件里搜索。" });
    await fireEvent.input(input, { target: { value: "value " } });
    await waitFor(() => expect(screen.getByText("无法在这个文件里搜索。")).toBeTruthy());
    const readsBefore = repositoryFileContent.mock.calls.length;
    const searchesBefore = repositoryContentSearch.mock.calls.length;
    await fireEvent.click(screen.getByRole("button", { name: "重新读取文件" }));
    await waitFor(() => expect(repositoryFileContent.mock.calls.length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(repositoryContentSearch.mock.calls.length).toBeGreaterThan(searchesBefore));
    expect(await screen.findByText(/1 处匹配/)).toBeTruthy();
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
    // 预览优先：源码行不占正文。文件名、复制与目录都在文件工具条上，阅读器不再叠一行重复的来源/路径头，
    // 也不再为「N 个标题」单独占一行；大小与只读收进底部状态条。
    expect(container.querySelector("[data-file-line]")).toBeNull();
    expect(container.querySelector(".doc-reader-head")).toBeNull();
    expect(container.querySelector(".md-reading-tools")).toBeNull();
    // 来源与路径用阅读器同一套标识收进底部状态条：不另占一行，但相对链接跳到别的文档后要能看出换成了哪个文件。
    expect(container.querySelector(".file-status .doc-source")?.textContent?.trim()).toBe("工作区");
    expect(container.querySelector(".file-status .doc-path")?.getAttribute("title")).toBe("docs/a.md");
    expect(screen.getAllByRole("button", { name: /复制文件路径|复制文档路径/ })).toHaveLength(1);
    expect(screen.getByTitle("64 字节").textContent).toBe(formatBytes(64));
    expect(screen.getByTitle("查看模式只读，不会改动工作区；切到「编辑」才会修改这个文件")).toBeTruthy();
    const outline = screen.getByRole("button", { name: "文档目录" });
    // 与阅读器自己的目录工具行同一套控件外观，浏览器场景才能靠同一个类找到它。
    expect(outline.classList.contains("md-small-button")).toBe(true);
    expect(outline.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(outline);
    expect(outline.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("navigation", { name: "文档目录" })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }).getAttribute("aria-pressed")).toBe("true");
    // 源码没有目录可看：入口随预览一起退场。
    expect(screen.queryByRole("button", { name: "文档目录" })).toBeNull();
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
    // 分页起点没变时按保存的精确偏移写回，而不是只按行居中。
    await waitFor(() => expect(restored.scrollTop).toBe(220));
    expect(view.container.querySelector('[data-file-line="12"]')).toBeTruthy();
  });

  describe("Markdown 源码位置恢复", () => {
    afterEach(() => vi.restoreAllMocks());

    /**
     * happy-dom 没有布局，clientHeight 恒为 0 时虚拟窗口总是从第一行算起，
     * 「窗口按旧 scrollTop 取行、容器却停在顶部」的错位看不出来。
     * 这里只给源码滚动容器一个真实视口，其它元素仍按 0 处理。
     */
    function mockCodeViewport(height = 400): void {
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("file-code") ? height : 0;
      });
    }

    it("命中行后预览与源码往返仍回到原处，虚拟窗口不错位", async () => {
      const viewport = 400;
      mockCodeViewport(viewport);
      const many = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
      repositoryFileContent.mockResolvedValue(text({ path: "docs/a.md", lines: many, nextOffset: many.length }));
      repositoryDocument.mockResolvedValue(markdownDoc());
      const view = render(FileContent, {
        props: props({ path: "docs/a.md", contentVersion: "v1", line: 40, lineSerial: 1 }) as never,
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }).getAttribute("aria-pressed")).toBe("true"),
      );
      const scroller = view.container.querySelector<HTMLDivElement>(".file-code")!;
      await waitFor(() => expect(scroller.querySelector("[data-file-line]")).toBeTruthy());
      scroller.scrollTop = 400;
      await fireEvent.scroll(scroller);

      // 立刻切到预览再切回源码：源码分支的滚动容器是新挂载的，位置必须写回去。
      await fireEvent.click(screen.getByRole("button", { name: "预览这个 Markdown 文档" }));
      await screen.findByRole("heading", { name: "标题" });
      await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));

      const restored = view.container.querySelector<HTMLDivElement>(".file-code")!;
      await waitFor(() => expect(restored.scrollTop).toBe(400));
      // 虚拟窗口必须按容器当前的 scrollTop 取行：起点在视口上方的预取行内，
      // 末尾仍盖住视口底部，才不会出现顶部空白或行缺失。
      const rows = [...restored.querySelectorAll<HTMLElement>("[data-file-line]")];
      const firstTop = Number.parseFloat(rows[0].style.top);
      const lastTop = Number.parseFloat(rows[rows.length - 1].style.top);
      expect(firstTop).toBeLessThanOrEqual(restored.scrollTop);
      expect(restored.scrollTop - firstTop).toBeLessThanOrEqual(240);
      expect(lastTop + 20).toBeGreaterThanOrEqual(restored.scrollTop + viewport);
    });

    it("命中行的文件切到另一个文件再回来仍恢复源码位置，不回到开头", async () => {
      mockCodeViewport();
      const many = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
      repositoryFileContent.mockImplementation((_repo: string, target: string) =>
        Promise.resolve(
          text({ path: target, lines: target === "docs/a.md" ? many : ["const other = true;"], nextOffset: many.length }),
        ),
      );
      repositoryDocument.mockResolvedValue(markdownDoc());
      const markdownProps = props({ path: "docs/a.md", contentVersion: "v1", line: 40, lineSerial: 1 });
      const view = render(FileContent, { props: markdownProps as never });
      await waitFor(() => expect(view.container.querySelector(".file-code [data-file-line]")).toBeTruthy());
      const scroller = view.container.querySelector<HTMLDivElement>(".file-code")!;
      scroller.scrollTop = 400;
      await fireEvent.scroll(scroller);
      // 等位置写入落地，再切到别的文件。
      await new Promise((resolve) => setTimeout(resolve, 150));

      await view.rerender(props({ path: "src/App.ts", contentVersion: "v2" }) as never);
      await screen.findByText("const other = true;");
      await view.rerender(markdownProps as never);

      const restored = await waitFor(() => {
        const node = view.container.querySelector<HTMLDivElement>(".file-code");
        expect(node).toBeTruthy();
        return node!;
      });
      // 恢复而非回到顶部：保存的行仍在窗口里，第一行不在。
      await waitFor(() => expect(restored.querySelector('[data-file-line="60"]')).toBeTruthy());
      expect(restored.scrollTop).toBeGreaterThan(0);
      expect(restored.querySelector('[data-file-line="1"]')).toBeNull();
    });

    it("滚动后立刻切到另一个 Markdown 文件，旧位置写入不污染新文件的阅读模式", async () => {
      const many = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
      repositoryFileContent.mockImplementation((_repo: string, target: string) =>
        Promise.resolve(
          text({ path: target, lines: target === "docs/a.md" ? many : ["# 标题 B"], nextOffset: many.length }),
        ),
      );
      repositoryDocument.mockImplementation((_repo: string, source: { path: string }) =>
        Promise.resolve(
          markdownDoc({
            text: source.path === "docs/a.md" ? "# 标题 A" : "# 标题 B",
            source: { revision: "worktree", path: source.path, repository: repoPath },
          }),
        ),
      );
      const view = render(FileContent, { props: props({ path: "docs/a.md", contentVersion: "v1" }) as never });
      await screen.findByRole("heading", { name: "标题 A" });

      await fireEvent.click(screen.getByRole("button", { name: "查看这个 Markdown 的源码" }));
      const scroller = view.container.querySelector<HTMLDivElement>(".file-code")!;
      scroller.scrollTop = 400;
      await fireEvent.scroll(scroller);
      // 定时器还没触发就切到另一个 Markdown 文件：这次写入属于上一个文件。
      await view.rerender(props({ path: "docs/b.md", contentVersion: "v1" }) as never);
      expect(await screen.findByRole("heading", { name: "标题 B" })).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 回到 B 时仍按它自己保存的预览模式进入，而不是被旧写入改成源码。
      await view.rerender(props({ path: "docs/a.md", contentVersion: "v1" }) as never);
      await waitFor(() => expect(view.container.querySelector(".file-code [data-file-line]")).toBeTruthy());
      // 排队中的位置按 A 自己的身份落定：切回来仍回到原处，A 的阅读位置没有丢。
      await waitFor(() => expect(view.container.querySelector<HTMLDivElement>(".file-code")!.scrollTop).toBe(400));
      await view.rerender(props({ path: "docs/b.md", contentVersion: "v1" }) as never);
      expect(await screen.findByRole("heading", { name: "标题 B" })).toBeTruthy();
      expect(view.container.querySelector(".file-code")).toBeNull();
    });
  });

/* ------------------------------------------------------------------ *
 * 轻量编辑（T2）：只编辑当前工作区的这一个文件，能不能编辑以后端完整快照为准；
 * 草稿按「仓库 + 路径 + baseDigest」留在内存，外部修改绝不覆盖 dirty 草稿。
 * ------------------------------------------------------------------ */
describe("轻量编辑", () => {
  const DIGEST = "a".repeat(64);
  const NEXT = "b".repeat(64);

  function editSnap(overrides: Partial<RepositoryEditSnapshot> = {}): RepositoryEditSnapshot {
    return {
      generation: 4,
      path: "src/App.ts",
      state: "editable",
      editable: true,
      size: 26,
      digest: DIGEST,
      text: "const a = 1;\nconst b = 2;\n",
      bom: false,
      lineEnding: "lf",
      finalNewline: true,
      message: "",
      ...overrides,
    };
  }

  const editorBox = () => document.querySelector<HTMLTextAreaElement>(".text-editor-input");

  async function enterEdit(extra: Record<string, unknown> = {}) {
    repositoryFileContent.mockResolvedValue(text());
    const editor = createFileEditor();
    const view = render(FileContent, { props: props({ editor, contentVersion: "v1", ...extra }) as never });
    await waitFor(() => expect(view.container.querySelector('[data-file-line="1"]')).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "编辑这个工作区文件" }));
    return { ...view, editor };
  }

  it("工作区文本切到编辑：读取完整快照，原生输入后只保存这一个文件", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    repositoryEditSave.mockResolvedValue(editSnap({ generation: 5, digest: NEXT, text: "const a = 10;\nconst b = 2;\n" }));
    const onEditSaved = vi.fn();
    await enterEdit({ onEditSaved });
    await waitFor(() => expect(editorBox()).toBeTruthy());
    expect(repositoryEditSnapshot).toHaveBeenCalledWith(repoPath, "src/App.ts", 4, expect.any(Number));
    expect(editorBox()!.value).toBe("const a = 1;\nconst b = 2;\n");
    expect(screen.getByText("LF · UTF-8")).toBeTruthy();
    // 编辑模式下只读视图的查找、换行与「只读」状态条都退场，编辑器自带状态。
    expect(screen.queryByRole("button", { name: "在文件内搜索" })).toBeNull();
    expect(document.querySelector(".file-status")).toBeNull();
    const save = screen.getByRole("button", { name: "保存修改到工作区" }) as HTMLButtonElement;
    expect(save.disabled, "没有修改时不能保存").toBe(true);
    expect(save.title).toBe("没有未保存的修改");

    await fireEvent.input(editorBox()!, { target: { value: "const a = 10;\nconst b = 2;\n" } });
    expect(document.querySelector("[data-edit-status]")?.textContent).toContain("有未保存的修改");
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() =>
      expect(repositoryEditSave).toHaveBeenCalledWith(repoPath, "src/App.ts", DIGEST, "const a = 10;\nconst b = 2;\n", 4, expect.any(Number)),
    );
    await waitFor(() => expect(onEditSaved).toHaveBeenCalledWith(expect.objectContaining({ generation: 5, digest: NEXT })));
    await waitFor(() => expect(document.querySelector("[data-edit-status]")?.textContent).toContain("已保存"));
    expect((screen.getByRole("button", { name: "保存修改到工作区" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("后端判为只读的文件说明具体原因，可以回到查看", async () => {
    repositoryEditSnapshot.mockResolvedValue(
      editSnap({
        state: "mixedLineEndings",
        editable: false,
        text: null,
        lineEnding: "mixed",
        message: "文件混用 LF 与 CRLF 行尾，保持只读以免整份改写。",
      }),
    );
    await enterEdit();
    expect(await screen.findByText("文件混用 LF 与 CRLF 行尾，保持只读以免整份改写。")).toBeTruthy();
    expect(editorBox()).toBeNull();
    expect(screen.queryByRole("button", { name: "保存修改到工作区" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "回到查看" }));
    await waitFor(() => expect(document.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(repositoryEditSave).not.toHaveBeenCalled();
  });

  it("删除的文件与非文本内容没有编辑入口", async () => {
    repositoryFileContent.mockResolvedValue(text({ kind: "binary", lines: [], message: "二进制内容不作为文本读取。" }));
    const editor = createFileEditor();
    const { unmount } = render(FileContent, { props: props({ editor }) as never });
    await screen.findByText("二进制内容不作为文本读取。");
    expect(screen.queryByRole("button", { name: "编辑这个工作区文件" })).toBeNull();
    unmount();

    render(FileContent, { props: props({ editor, path: null, missingPath: "src/App.ts" }) as never });
    await screen.findByText("文件已删除");
    expect(screen.queryByRole("button", { name: "编辑这个工作区文件" })).toBeNull();
    expect(repositoryEditSnapshot).not.toHaveBeenCalled();
  });

  it("dirty 草稿不能直接回到查看；外部修改只标冲突，不覆盖草稿，也不能按旧基线保存", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    const { rerender, editor } = await enterEdit();
    await waitFor(() => expect(editorBox()).toBeTruthy());
    await fireEvent.input(editorBox()!, { target: { value: "我的草稿\n" } });
    const view = screen.getByRole("button", { name: "只读查看这个文件" }) as HTMLButtonElement;
    expect(view.disabled).toBe(true);
    expect(view.title).toContain("先保存或放弃修改");

    // 外部把文件改成了另一份内容：版本前进触发按完整摘要复核。
    repositoryEditSnapshot.mockResolvedValue(editSnap({ digest: NEXT, text: "外部内容\n" }));
    await rerender(props({ editor, contentVersion: "v2" }) as never);
    const conflict = await screen.findByText(/文件在编辑期间被外部修改/);
    expect(conflict.closest("[data-edit-conflict]")).toBeTruthy();
    expect(editorBox()!.value, "草稿保留").toBe("我的草稿\n");
    const save = screen.getByRole("button", { name: "保存修改到工作区" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toContain("外部修改");
    expect(repositoryEditSave).not.toHaveBeenCalled();

    // 明确放弃草稿并重新读取，才换到外部内容的新基线。
    await fireEvent.click(screen.getByRole("button", { name: "放弃草稿并重新读取" }));
    await waitFor(() => expect(editorBox()!.value).toBe("外部内容\n"));
    expect(screen.queryByText(/文件在编辑期间被外部修改/)).toBeNull();
  });

  it("干净的编辑会话遇到外部修改直接换到新内容", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    const { rerender, editor } = await enterEdit();
    await waitFor(() => expect(editorBox()).toBeTruthy());
    repositoryEditSnapshot.mockResolvedValue(editSnap({ digest: NEXT, text: "外部内容\n" }));
    await rerender(props({ editor, contentVersion: "v2" }) as never);
    await waitFor(() => expect(editorBox()!.value).toBe("外部内容\n"));
    expect(screen.queryByText(/文件在编辑期间被外部修改/)).toBeNull();
  });

  it("保存冲突与写入失败都保留草稿；写入失败可以就地重试", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    const onEditFailed = vi.fn();
    await enterEdit({ onEditFailed });
    await waitFor(() => expect(editorBox()).toBeTruthy());
    await fireEvent.input(editorBox()!, { target: { value: "草稿 A\n" } });
    repositoryEditSave.mockRejectedValueOnce({ code: "edit_write_failed", message: "文件是只读的，保存未写入任何内容。" });
    await fireEvent.click(screen.getByRole("button", { name: "保存修改到工作区" }));
    expect(await screen.findByText(/保存失败，草稿仍保留：文件是只读的/)).toBeTruthy();
    expect(onEditFailed).toHaveBeenCalledWith("edit_write_failed");
    expect(editorBox()!.value).toBe("草稿 A\n");

    repositoryEditSave.mockRejectedValueOnce({ code: "edit_conflict", message: "文件在编辑期间已被外部修改，保存未写入，未覆盖外部内容。" });
    await fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(await screen.findByText("文件在编辑期间已被外部修改，保存未写入，未覆盖外部内容。")).toBeTruthy();
    expect(editorBox()!.value).toBe("草稿 A\n");
    // 两次都按同一个基线摘要发送；冲突之后不能再按旧基线保存。
    expect(repositoryEditSave.mock.calls.map((call) => call[2])).toEqual([DIGEST, DIGEST]);
    expect((screen.getByRole("button", { name: "保存修改到工作区" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("文本输入与组字不冒泡到工作台；Ctrl S 只保存当前会话", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    repositoryEditSave.mockResolvedValue(editSnap({ generation: 5, digest: NEXT, text: "x\n" }));
    await enterEdit();
    await waitFor(() => expect(editorBox()).toBeTruthy());
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    try {
      const box = editorBox()!;
      await fireEvent.input(box, { target: { value: "x\n" } });
      // 背景的 Git 快捷键（Alt+M 标记、Ctrl Enter 提交、Ctrl F 查找）都不能从文本框里收到按键。
      await fireEvent.keyDown(box, { key: "m", altKey: true });
      await fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
      await fireEvent.keyDown(box, { key: "f", ctrlKey: true });
      // 组字中的按键属于输入法，连保存快捷键也不接。
      await fireEvent.keyDown(box, { key: "s", ctrlKey: true, isComposing: true });
      expect(outer).not.toHaveBeenCalled();
      expect(repositoryEditSave).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("文件内搜索关键词")).toBeNull();

      await fireEvent.keyDown(box, { key: "s", ctrlKey: true });
      await waitFor(() => expect(repositoryEditSave).toHaveBeenCalledTimes(1));
      expect(outer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it("外部编辑请求在路径选中后打开编辑器并定位到行，给出返回差异入口", async () => {
    repositoryFileContent.mockResolvedValue(text());
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    const run = vi.fn();
    const editor = createFileEditor();
    render(FileContent, {
      props: props({
        editor,
        editRequest: { path: "src/App.ts", line: 2, serial: 1 },
        editReturn: { path: "src/App.ts", label: "返回差异", run },
      }) as never,
    });
    await waitFor(() => expect(editorBox()).toBeTruthy());
    await waitFor(() => expect(editorBox()!.selectionStart).toBe("const a = 1;\n".length));
    await fireEvent.click(screen.getByRole("button", { name: "返回差异" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("换文件再回来草稿仍在，回来时按完整摘要复核", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    const { rerender, editor } = await enterEdit();
    await waitFor(() => expect(editorBox()).toBeTruthy());
    await fireEvent.input(editorBox()!, { target: { value: "留着的草稿\n" } });
    repositoryFileContent.mockResolvedValue(text({ path: "src/Other.ts" }));
    await rerender(props({ editor, path: "src/Other.ts", contentVersion: "o1" }) as never);
    await waitFor(() => expect(editorBox()).toBeNull());
    repositoryFileContent.mockResolvedValue(text());
    const calls = repositoryEditSnapshot.mock.calls.length;
    await rerender(props({ editor, path: "src/App.ts", contentVersion: "v1" }) as never);
    await waitFor(() => expect(editorBox()!.value).toBe("留着的草稿\n"));
    await waitFor(() => expect(repositoryEditSnapshot.mock.calls.length).toBeGreaterThan(calls));
    expect(editor.dirty(repoPath).map((session) => session.path)).toEqual(["src/App.ts"]);
  });

  it("编辑器内查找、替换与跳行只改草稿，不触发保存", async () => {
    repositoryEditSnapshot.mockResolvedValue(editSnap());
    await enterEdit();
    await waitFor(() => expect(editorBox()).toBeTruthy());
    const box = editorBox()!;
    await fireEvent.keyDown(box, { key: "f", code: "KeyF", ctrlKey: true });
    const query = (await screen.findByRole("textbox", { name: "在草稿中查找" })) as HTMLInputElement;
    await fireEvent.input(query, { target: { value: "const" } });
    await waitFor(() => expect(document.querySelector("[data-edit-find] .find-count")?.textContent).toBe("1/2"));
    expect(document.querySelectorAll(".text-editor-hit")).toHaveLength(2);
    await fireEvent.keyDown(query, { key: "Enter" });
    expect(document.querySelector("[data-edit-find] .find-count")?.textContent).toBe("2/2");

    await fireEvent.click(screen.getByRole("button", { name: "展开替换" }));
    const replacement = screen.getByRole("textbox", { name: "替换为" }) as HTMLInputElement;
    await fireEvent.input(replacement, { target: { value: "let" } });
    await fireEvent.click(screen.getByRole("button", { name: "全部替换" }));
    await waitFor(() => expect(editorBox()!.value).toBe("let a = 1;\nlet b = 2;\n"));
    expect(document.querySelector("[data-edit-status]")?.textContent).toContain("有未保存的修改");
    expect(repositoryEditSave).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector("[data-edit-find] .find-count")?.textContent).toBe("没有匹配"));

    await fireEvent.keyDown(query, { key: "Escape" });
    expect(document.querySelector("[data-edit-find]")).toBeNull();
    await fireEvent.keyDown(editorBox()!, { key: "g", code: "KeyG", ctrlKey: true });
    const goto = (await screen.findByRole("textbox", { name: "跳到行号" })) as HTMLInputElement;
    await fireEvent.input(goto, { target: { value: "2:5" } });
    await fireEvent.keyDown(goto, { key: "Enter" });
    await waitFor(() => expect(document.querySelector("[data-edit-goto]")).toBeNull());
    expect(editorBox()!.selectionStart).toBe(15);
    expect(document.querySelector("[data-edit-caret]")?.textContent).toContain("行 2，列 5");
  });
});
