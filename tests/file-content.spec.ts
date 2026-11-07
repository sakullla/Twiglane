import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFileContent = vi.hoisted(() => vi.fn());
const repositoryContentSearch = vi.hoisted(() => vi.fn());
const filePreview = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ api: { repositoryFileContent, repositoryContentSearch, filePreview } }));
import FileContent from "../src/lib/components/FileContent.svelte";
import { resetSyntaxPrefs } from "../src/lib/syntax/prefs.svelte";
import type { OpenedRepository, RepositoryContentSearch, RepositoryFileContent } from "../src/lib/types";

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
    await fireEvent.click(screen.getByRole("button", { name: "跳到行" }));
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

  it("未知扩展名按纯文本显示，原文仍然可读", async () => {
    repositoryFileContent.mockResolvedValue(text({ path: "Makefile", lines: ["all:", "\tgo build ./..."] }));
    const { container } = render(FileContent, { props: props({ path: "Makefile" }) as never });
    await waitFor(() => expect(container.querySelector('[data-file-line="1"]')).toBeTruthy());
    expect(screen.getByRole("button", { name: /语法高亮语言/ })).toBeTruthy();
    expect(container.querySelector('[data-file-line="1"]')!.textContent).toContain("all:");
  });
});

describe("真实状态与读取边界", () => {
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
