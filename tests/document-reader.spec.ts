import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryDocument = vi.hoisted(() => vi.fn());
const documentResource = vi.hoisted(() => vi.fn());
const documentRemoteImage = vi.hoisted(() => vi.fn());
const openDocumentUrl = vi.hoisted(() => vi.fn());
const cancelDocumentResources = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/lib/api", () => ({
  api: { repositoryDocument, documentResource, documentRemoteImage, openDocumentUrl, cancelDocumentResources },
}));
const cancelHighlight = vi.hoisted(() => vi.fn());
const highlightLines = vi.hoisted(() => vi.fn(() => cancelHighlight));
vi.mock("../src/lib/syntax/client", () => ({ highlightLines }));

import DocumentDialog from "../src/lib/components/DocumentDialog.svelte";
import DocumentReader from "../src/lib/components/DocumentReader.svelte";
import { createDocumentSession } from "../src/lib/document-session.svelte";
import type { DocumentSource, FilePreview, RepositoryDocument } from "../src/lib/types";

const repoPath = "C:/work/demo";

function doc(overrides: Partial<RepositoryDocument> = {}): RepositoryDocument {
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

function page(overrides: Partial<RepositoryDocument> = {}): RepositoryDocument {
  return doc({ kind: "text", text: null, lines: ["# 标题", "", "正文段落"], nextOffset: 3, hasMore: false, ...overrides });
}

function image(overrides: Partial<FilePreview> = {}): FilePreview {
  return {
    generation: 4,
    kind: "image",
    size: 68,
    dataUrl: "data:image/png;base64,YWJj",
    entries: [],
    truncated: false,
    message: "",
    lfsOid: null,
    canDownload: false,
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    repository: repoPath,
    source: { revision: "worktree", path: "docs/a.md" } satisfies DocumentSource,
    generation: 4,
    nextId: () => 1,
    onGeneration: vi.fn(),
    ...overrides,
  };
}

function session() {
  return createDocumentSession({ repository: () => repoPath });
}

beforeEach(() => {
  repositoryDocument.mockReset();
  documentResource.mockReset();
  documentRemoteImage.mockReset();
  openDocumentUrl.mockReset();
  cancelDocumentResources.mockClear();
  repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document", offset = 0) =>
    Promise.resolve(mode === "source" ? page({ source, offset, nextOffset: offset + 3 }) : doc({ source })),
  );
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("文档阅读：来源与正文", () => {
  it("显示明确的来源版本、路径并渲染正文", async () => {
    const { container } = render(DocumentReader, { props: props() });
    await screen.findByRole("heading", { name: "标题" });
    expect(screen.getByTitle("来源：工作区")).toBeTruthy();
    expect(container.querySelector(".doc-path")?.textContent).toBe("docs/a.md");
    expect(repositoryDocument).toHaveBeenCalledWith(repoPath, { revision: "worktree", path: "docs/a.md" }, 4, 1, "document");
  });

  it("暂存区与固定提交分别显示真实来源，不冒充工作区", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource) => Promise.resolve(doc({ source })));
    const view = render(DocumentReader, { props: props({ source: { revision: "index", path: "docs/a.md" } }) });
    await waitFor(() => expect(screen.getByTitle("来源：暂存区")).toBeTruthy());
    const oid = "a".repeat(40);
    await view.rerender(props({ source: { revision: oid, path: "docs/a.md" } }));
    await waitFor(() => expect(screen.getByTitle(`来源：提交 ${"a".repeat(7)}`)).toBeTruthy());
    await view.rerender(props({ source: { revision: oid, path: "docs/a.md" }, abbrevLength: 10 }));
    await waitFor(() => expect(screen.getByTitle(`来源：提交 ${"a".repeat(10)}`)).toBeTruthy());
  });

  it("读取失败显示原因与重新读取", async () => {
    repositoryDocument.mockRejectedValueOnce({ code: "document_read", message: "无法读取这个版本的正文。" });
    render(DocumentReader, { props: props() });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("无法读取这个版本的正文。")).toBeTruthy();
    repositoryDocument.mockResolvedValueOnce(doc());
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
  });

  it("stale 响应按返回代次重读一次并上报代次", async () => {
    repositoryDocument.mockRejectedValueOnce({ code: "stale", generation: 6, message: "文档或暂存区已变化，请重新读取。" });
    repositoryDocument.mockResolvedValueOnce(doc({ generation: 6 }));
    const onGeneration = vi.fn();
    render(DocumentReader, { props: props({ onGeneration }) });
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
    expect(onGeneration).toHaveBeenCalledWith(6);
    expect(repositoryDocument).toHaveBeenCalledTimes(2);
    expect(repositoryDocument.mock.calls[1][2]).toBe(6);
  });

  it("空文档、二进制、缺失与超限都有明确状态，超限仍可继续读源码", async () => {
    repositoryDocument.mockResolvedValueOnce(doc({ text: "" }));
    const view = render(DocumentReader, { props: props({ mode: "preview" }) });
    expect(await screen.findByText("这是一个空文档。")).toBeTruthy();

    repositoryDocument.mockResolvedValueOnce(doc({ kind: "binary", text: null, message: "二进制文件不能作为 Markdown 阅读。" }));
    await view.rerender(props({ source: { revision: "index", path: "assets/blob.bin" } }));
    expect(await screen.findByText("二进制文件不能作为 Markdown 阅读。")).toBeTruthy();

    repositoryDocument.mockResolvedValueOnce(doc({ kind: "missing", text: null, message: "该版本中没有这个文件。" }));
    await view.rerender(props({ source: { revision: "index", path: "docs/gone.md" } }));
    expect(await screen.findByText("这个版本里没有这个文件")).toBeTruthy();
    expect(screen.getByText("该版本中没有这个文件。")).toBeTruthy();

    const onMode = vi.fn();
    repositoryDocument.mockResolvedValueOnce(doc({ kind: "tooLarge", text: null, truncated: true, message: "文档超过 2 MiB 排版预览上限，请查看源码。" }));
    await view.rerender(props({ source: { revision: "index", path: "docs/long.md" }, onMode }));
    expect(await screen.findByText("文档超过 2 MiB 排版预览上限，请查看源码。")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(onMode).toHaveBeenCalledWith("source");
  });

  it("外部变化换版本时重读，内容版本未变时不因仓库代次变化重读", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, generation: number) =>
      Promise.resolve(doc({ source, generation })),
    );
    const view = render(DocumentReader, { props: props({ contentVersion: "v1" }) });
    await screen.findByRole("heading", { name: "标题" });
    await view.rerender(props({ contentVersion: "v1", generation: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repositoryDocument).toHaveBeenCalledTimes(1);
    await view.rerender(props({ contentVersion: "v2", generation: 9 }));
    await waitFor(() => expect(repositoryDocument).toHaveBeenCalledTimes(2));
    expect(repositoryDocument.mock.calls[1][2]).toBe(9);
  });

  it("隐藏时不读取，迟到的旧文档不覆盖当前文档", async () => {
    let finishOld!: (value: RepositoryDocument) => void;
    repositoryDocument.mockImplementationOnce(() => new Promise<RepositoryDocument>((resolve) => (finishOld = resolve)));
    const view = render(DocumentReader, { props: props() });
    await waitFor(() => expect(repositoryDocument).toHaveBeenCalledTimes(1));
    repositoryDocument.mockResolvedValueOnce(doc({ source: { revision: "worktree", path: "docs/b.md", repository: repoPath }, text: "# 新文档" }));
    await view.rerender(props({ source: { revision: "worktree", path: "docs/b.md" } }));
    expect(await screen.findByRole("heading", { name: "新文档" })).toBeTruthy();
    finishOld(doc({ text: "# 旧文档" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "旧文档" })).toBeNull();

    repositoryDocument.mockClear();
    await view.rerender(props({ source: { revision: "worktree", path: "docs/c.md" }, active: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repositoryDocument).not.toHaveBeenCalled();
  });
});

describe("文档阅读：位置与源码", () => {
  it("从会话恢复预览位置，滚动回写不拉回", async () => {
    const reading = session();
    reading.remember({ revision: "worktree", path: "docs/a.md" }, { mode: "preview", preview: { top: 75, anchor: null }, version: "v1" });
    const view = render(DocumentReader, { props: props({ session: reading }) });
    await screen.findByRole("heading", { name: "标题" });
    const scroller = view.container.querySelector<HTMLDivElement>(".md-scroll")!;
    await waitFor(() => expect(scroller.scrollTop).toBe(75));

    scroller.scrollTop = 120;
    await fireEvent.scroll(scroller);
    expect(reading.recall({ revision: "worktree", path: "docs/a.md" }, "v1")?.reading.preview.top).toBe(120);
    await view.rerender(props({ session: reading }));
    expect(scroller.scrollTop).toBe(120);
  });

  it("源码按页读取并继续，显式行定位优先于保存的位置", async () => {
    const reading = session();
    reading.remember({ revision: "worktree", path: "docs/a.md" }, { mode: "source", source: { line: 120, top: 2200 }, version: "v1" });
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document", offset = 0) => {
      if (mode === "source" && offset === 4) {
        return Promise.resolve(page({ source, offset: 4, lines: ["第五行", "第六行"], nextOffset: 6, hasMore: true }));
      }
      return Promise.resolve(mode === "source" ? page({ source, offset, lines: ["第一行"] }) : doc({ source }));
    });
    const props1 = props({ mode: "source", line: 5, lineSerial: 1, session: reading });
    const view = render(DocumentReader, { props: props1 as never });
    await screen.findByText("第五行");
    expect(repositoryDocument.mock.calls.some((call) => call[4] === "source" && call[5] === 4)).toBe(true);
    expect(view.container.querySelector('[data-doc-line="5"]')?.textContent).toContain("第五行");

    await fireEvent.click(screen.getByRole("button", { name: /继续读取后续源码/ }));
    await waitFor(() => expect(repositoryDocument.mock.calls.some((call) => call[4] === "source" && call[5] === 6)).toBe(true));
  });

  it("恢复源码位置：内容变短时夹到有效范围并说明", async () => {
    const reading = session();
    reading.remember({ revision: "worktree", path: "docs/a.md" }, { mode: "source", source: { line: 80, top: 1600 }, version: "old" });
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document", offset = 0) =>
      Promise.resolve(mode === "source" ? page({ source, offset, lines: ["第一行"], nextOffset: 1, version: "new" }) : doc({ source, version: "new" })),
    );
    const view = render(DocumentReader, { props: props({ mode: "source", session: reading }) });
    expect(await screen.findByText("第一行")).toBeTruthy();
    expect(await screen.findByText(/内容版本已变化|源码位置已调整/)).toBeTruthy();
    expect(view.container.querySelector(".doc-source-scroll")).toBeTruthy();
  });

  it("空源码与特殊类型说明真实状态，不伪造正文", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document") =>
      Promise.resolve(mode === "source"
        ? page({ source, lines: [], nextOffset: 0, kind: "text" })
        : doc({ source })),
    );
    render(DocumentReader, { props: props({ mode: "source" }) });
    expect(await screen.findByText("这个版本的文档是空的")).toBeTruthy();

    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document") =>
      Promise.resolve(mode === "source"
        ? page({ source, lines: [], kind: "invalidUtf8", message: "文件不是有效 UTF-8 文本。" })
        : doc({ source, kind: "invalidUtf8", text: null, message: "文件不是有效 UTF-8 文本。" })),
    );
    render(DocumentReader, { props: props({ source: { revision: "index", path: "docs/bad.md" }, mode: "source" }) });
    expect(await screen.findByText("不是有效的 UTF-8 文本")).toBeTruthy();
  });
});

describe("文档阅读：链接与资源", () => {
  it("相对链接留在同一版本，返回回到原文与位置", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource) =>
      Promise.resolve(doc({
        source,
        text: source.path === "docs/a.md" ? "[说明](guide.md)" : "# 目标文档",
      })),
    );
    const reading = session();
    const view = render(DocumentReader, { props: props({ session: reading }) });
    const link = await screen.findByRole("link", { name: "说明" });
    await fireEvent.click(link);
    await waitFor(() => expect(repositoryDocument).toHaveBeenLastCalledWith(repoPath, expect.objectContaining({ revision: "worktree", path: "docs/guide.md" }), 4, expect.any(Number), "document"));
    expect(await screen.findByRole("heading", { name: "目标文档" })).toBeTruthy();
    const back = screen.getByRole("button", { name: "返回上一个文档" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    await fireEvent.click(back);
    await waitFor(() => expect(repositoryDocument).toHaveBeenLastCalledWith(repoPath, expect.objectContaining({ path: "docs/a.md" }), 4, expect.any(Number), "document"));
    expect(await screen.findByRole("link", { name: "说明" })).toBeTruthy();
    expect(view.container.querySelector(".doc-path")?.textContent).toBe("docs/a.md");
  });

  it("自定义导航交给文件视图：目标不存在时就地说明", async () => {
    repositoryDocument.mockResolvedValue(doc({ text: "[说明](guide.md)" }));
    const onFollow = vi.fn(async () => false);
    render(DocumentReader, { props: props({ onFollow }) });
    await fireEvent.click(await screen.findByRole("link", { name: "说明" }));
    await waitFor(() => expect(onFollow).toHaveBeenCalledWith(expect.objectContaining({ kind: "local", path: "docs/guide.md" })));
    expect(await screen.findByText("这个版本里没有 docs/guide.md。")).toBeTruthy();
    expect(repositoryDocument).toHaveBeenCalledTimes(1);
  });

  it("外部网页只在点击后打开，不在渲染时联网", async () => {
    repositoryDocument.mockResolvedValue(doc({ text: "[外部](https://example.com/doc)" }));
    render(DocumentReader, { props: props() });
    const link = await screen.findByRole("link", { name: "外部" });
    expect(openDocumentUrl).not.toHaveBeenCalled();
    await fireEvent.click(link);
    await waitFor(() => expect(openDocumentUrl).toHaveBeenCalledWith("https://example.com/doc"));
  });

  it("本地图片按同版本路径读取，远程图片只在点击后请求", async () => {
    documentResource.mockResolvedValue(image());
    documentRemoteImage.mockResolvedValue(image());
    repositoryDocument.mockResolvedValue(doc({ text: "![本地](img/a.png)\n\n![远程](https://example.com/a.png)" }));
    render(DocumentReader, { props: props() });
    await waitFor(() => expect(documentResource).toHaveBeenCalled());
    expect(documentResource.mock.calls[0][1]).toMatchObject({ revision: "worktree", path: "docs/img/a.png" });
    expect(await screen.findByAltText("本地")).toBeTruthy();
    expect(documentRemoteImage).not.toHaveBeenCalled();
    await screen.findByText("远程图片尚未加载");
    await fireEvent.click(screen.getByRole("button", { name: "加载图片" }));
    await waitFor(() => expect(documentRemoteImage).toHaveBeenCalledWith("https://example.com/a.png", expect.any(Number)));
  });

  it("资源缺失与危险路径就地说明，不写出图片元素", async () => {
    documentResource.mockResolvedValue(image({ kind: "missing", dataUrl: null, message: "该版本中没有这个资源。" }));
    repositoryDocument.mockResolvedValue(doc({ text: "![缺失](img/gone.png)\n\n![危险](/etc/passwd)\n\n![元数据](.git/config)" }));
    const { container } = render(DocumentReader, { props: props() });
    expect(await screen.findByText("该版本中没有这个资源。")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("不支持此图片地址。")).toBeTruthy();
    expect(screen.getByText("这个版本里没有可读取的图片。")).toBeTruthy();
  });

  it("隐藏时取消在途资源请求", async () => {
    documentResource.mockImplementation(() => new Promise<FilePreview>(() => {}));
    repositoryDocument.mockResolvedValue(doc({ text: "![本地](img/a.png)" }));
    const view = render(DocumentReader, { props: props() });
    await waitFor(() => expect(documentResource).toHaveBeenCalled());
    await view.rerender(props({ active: false }));
    await waitFor(() => expect(cancelDocumentResources).toHaveBeenCalled());
  });
});

  it("非 Markdown 相对目标显示同版本源码，而不是预览", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document", offset = 0) => {
      if (source.path === "docs/config.yaml") {
        return Promise.resolve(mode === "source"
          ? page({ source, offset, lines: ["name: twiglane", "files: 3"], nextOffset: 2, hasMore: false })
          : doc({ source, text: null }));
      }
      return Promise.resolve(doc({ source, text: "[配置](config.yaml)" }));
    });
    const view = render(DocumentReader, { props: props({ mode: "preview", onMode: undefined }) });
    await fireEvent.click(await screen.findByRole("link", { name: "配置" }));
    expect(await screen.findByText("name: twiglane")).toBeTruthy();
    expect(repositoryDocument.mock.calls.some((call) => call[1].path === "docs/config.yaml" && call[4] === "source")).toBe(true);
    expect(view.container.querySelector(".doc-path")?.textContent).toBe("docs/config.yaml");
    expect(view.container.querySelector(".doc-source-scroll")).toBeTruthy();
  });

describe("阅读窗口", () => {
  it("显示来源版本、模式切换与只读说明，关闭交回触发控件", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource, _gen: number, _id: number, mode = "document", offset = 0) =>
      Promise.resolve(mode === "source" ? page({ source, offset }) : doc({ source })),
    );
    const onClose = vi.fn();
    const session = createDocumentSession({ repository: () => repoPath });
    const { container } = render(DocumentDialog, {
      props: {
        repository: repoPath,
        source: { revision: "index", path: "docs/a.md" },
        generation: 4,
        nextId: () => 1,
        onGeneration: vi.fn(),
        session,
        onClose,
      },
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("heading", { name: "阅读文档" })).toBeTruthy();
    expect(screen.getAllByTitle("来源：暂存区").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("只读阅读：不会修改文件、索引或提交范围");
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "阅读文档源码" }));
    await waitFor(() => expect(repositoryDocument.mock.calls.some((call) => call[4] === "source")).toBe(true));
    expect(await screen.findByRole("region", { name: "文档源码" })).toBeTruthy();
    expect(session.recall({ revision: "index", path: "docs/a.md" })?.reading.mode).toBe("source");

    await fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

  it("相对链接指向图片时按同一版本显示资源，不回落工作区", async () => {
    repositoryDocument.mockImplementation((_repo: string, source: DocumentSource) => Promise.resolve(
      source.path === "docs/logo.png"
        ? doc({ source, kind: "resource", text: null, message: "此文件使用只读资源预览。" })
        : doc({ source, text: "[图](logo.png)" }),
    ));
    documentResource.mockResolvedValue(image());
    const view = render(DocumentReader, { props: props() });
    await fireEvent.click(await screen.findByRole("link", { name: "图" }));
    await waitFor(() => expect(documentResource).toHaveBeenCalledWith(repoPath, expect.objectContaining({ revision: "worktree", path: "docs/logo.png" }), 4, expect.any(Number)));
    expect(await screen.findByRole("img", { name: "docs/logo.png（这个版本）" })).toBeTruthy();
    expect(view.container.querySelector(".doc-resource img")).toBeTruthy();
  });
