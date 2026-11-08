import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownPreview from "../src/lib/components/MarkdownPreview.svelte";
import { parseMarkdownDocument } from "../src/lib/markdown/parser";
import type { MarkdownImageResult } from "../src/lib/markdown/types";

/** 可手动投递结果的 Worker 替身：用来验证切换/隐藏时旧解析被终止且迟到结果不渲染。 */
class ControlledWorker {
  static created: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { ControlledWorker.created.push(this); }
}

const cancelHighlight = vi.hoisted(() => vi.fn());
const highlightLines = vi.hoisted(() => vi.fn(() => cancelHighlight));
vi.mock("../src/lib/syntax/client", () => ({ highlightLines }));

beforeEach(() => {
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("IntersectionObserver", undefined);
  highlightLines.mockClear();
  cancelHighlight.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Markdown 阅读", () => {
  it("显示排版、只读任务和表格，不把 HTML 或链接转换成可执行 DOM", async () => {
    const onLink = vi.fn();
    const { container } = render(MarkdownPreview, { text: "# 说明\n\n<script>globalThis.bad=1</script>\n\n[危险](javascript:alert(1))\n\n[外部](https://example.com)\n\n- [x] 已检查\n\n|名称|值|\n|---|---|\n|a|b|", documentKey: "a", onLink });
    await screen.findByRole("heading", { name: "说明" });
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>globalThis.bad=1</script>");
    expect(container.querySelector("[href^='javascript']")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(onLink).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: "外部" });
    expect(link.getAttribute("href")).toMatch(/^#.+-document$/);
    await fireEvent.click(link);
    expect(onLink).toHaveBeenCalledWith("https://example.com");
  });

  it("目录和文内中文锚点使用同一定位，缺失锚点反馈且保持正文", async () => {
    const onPosition = vi.fn();
    render(MarkdownPreview, { text: "# 中文\n\n## 中文\n\n[跳转](#%E4%B8%AD%E6%96%87-1) [缺失](#missing)", documentKey: "a", onPosition });
    await screen.findByRole("heading", { level: 2, name: "中文" });
    await fireEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByRole("navigation", { name: "文档目录" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("link", { name: "跳转" }));
    await waitFor(() => expect(onPosition).toHaveBeenCalledWith(expect.objectContaining({ anchor: "中文-1" })));
    expect(document.activeElement?.getAttribute("data-markdown-anchor")).toBe("中文-1");
    await fireEvent.click(screen.getByRole("link", { name: "缺失" }));
    await screen.findByText("文档中没有找到这个标题位置。");
    expect(screen.getByRole("heading", { level: 1, name: "中文" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    expect(screen.queryByRole("navigation", { name: "文档目录" })).toBeNull();
  });

  it("复制实际代码，高亮仅在活动阅读时订阅并在隐藏时取消", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const props = { text: "```ts\nconst 中文 = '<tag>';\n```", documentKey: "a" };
    const view = render(MarkdownPreview, props);
    await screen.findByRole("button", { name: "复制代码" });
    await fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).toHaveBeenCalledWith("const 中文 = '<tag>';");
    await screen.findByRole("button", { name: "代码已复制" });
    await waitFor(() => expect(highlightLines).toHaveBeenCalled());
    await view.rerender({ ...props, active: false });
    expect(cancelHighlight).toHaveBeenCalled();
  });

  it("远程图片不自动加载，本地图片经回调读取；回调返回外部 URL 不进入 img", async () => {
    const onLoadImage = vi.fn(async (href: string): Promise<MarkdownImageResult> => ({ dataUrl: href.startsWith("https") ? "https://evil.invalid/a.png" : "data:image/png;base64,YWJj" }));
    const { container } = render(MarkdownPreview, { text: "![本地图](img/a.png)\n\n![远程图](https://example.com/a.png)", documentKey: "a", onLoadImage });
    await screen.findByText("远程图片尚未加载");
    await waitFor(() => expect(onLoadImage).toHaveBeenCalledTimes(1));
    expect(onLoadImage.mock.calls[0][0]).toBe("img/a.png");
    expect(container.querySelector('img[src^="https"]')).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "加载图片" }));
    await screen.findByText("图片不可用或格式不受支持。");
    expect(onLoadImage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img[src^="https"]')).toBeNull();
  });

  it("换文档与隐藏取消旧图片请求，旧结果不能覆盖当前文档", async () => {
    let complete!: (result: MarkdownImageResult) => void;
    const signals: AbortSignal[] = [];
    const onLoadImage = vi.fn((_href: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<MarkdownImageResult>((resolve) => { complete = resolve; });
    });
    const view = render(MarkdownPreview, { text: "![old](old.png)", documentKey: "old", onLoadImage });
    await waitFor(() => expect(onLoadImage).toHaveBeenCalledTimes(1));
    await view.rerender({ text: "# 新文档", documentKey: "new", onLoadImage });
    await screen.findByRole("heading", { name: "新文档" });
    expect(signals[0].aborted).toBe(true);
    complete({ dataUrl: "data:image/png;base64,YWJj" });
    await Promise.resolve();
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("隐藏时取消已显式触发的远程图片，再激活不会静默重试远程加载", async () => {
    const signals: AbortSignal[] = [];
    const onLoadImage = vi.fn((_href: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<MarkdownImageResult>(() => {});
    });
    const props = { text: "![远程](https://example.com/a.png)", documentKey: "a", onLoadImage };
    const view = render(MarkdownPreview, props);
    await screen.findByRole("button", { name: "加载图片" });
    await fireEvent.click(screen.getByRole("button", { name: "加载图片" }));
    expect(onLoadImage).toHaveBeenCalledTimes(1);
    await view.rerender({ ...props, active: false });
    expect(signals[0].aborted).toBe(true);
    await view.rerender({ ...props, active: true });
    expect(onLoadImage).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "加载图片" });
  });

  it("图片错误保持可恢复状态，普通位置回写不重复读取失败图片", async () => {
    const onLoadImage = vi.fn(async (): Promise<MarkdownImageResult> => ({ dataUrl: null, message: "图片不存在" }));
    const props = { text: "![本地](missing.png)", documentKey: "a", onLoadImage };
    const view = render(MarkdownPreview, props);
    await screen.findByText("图片不存在");
    await view.rerender({ ...props, scrollTop: 10 });
    expect(onLoadImage).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "重试图片" }));
    await waitFor(() => expect(onLoadImage).toHaveBeenCalledTimes(2));
  });

  it("外部导航序号恢复位置，位置回写不拉回用户滚动", async () => {
    const onPosition = vi.fn();
    const props = { text: "# 位置\n\n正文", documentKey: "a", scrollTop: 75, onPosition };
    const view = render(MarkdownPreview, props);
    await screen.findByRole("heading", { name: "位置" });
    const scroll = view.container.querySelector<HTMLDivElement>(".md-scroll")!;
    await waitFor(() => expect(scroll.scrollTop).toBe(75));
    scroll.scrollTop = 120;
    await fireEvent.scroll(scroll);
    await view.rerender({ ...props, scrollTop: 10 });
    expect(scroll.scrollTop).toBe(120);
    await view.rerender({ ...props, scrollTop: 10, navigationSerial: 1 });
    await waitFor(() => expect(scroll.scrollTop).toBe(10));
    expect(onPosition).toHaveBeenCalledWith({ scrollTop: 120, anchor: null });
  });

  it("新文档的显式锚点优先于旧位置，并报告缺失锚点", async () => {
    const view = render(MarkdownPreview, { text: "# 旧文", documentKey: "old", scrollTop: 90 });
    await screen.findByRole("heading", { name: "旧文" });
    await view.rerender({ text: "# 新文\n\n## 目标", documentKey: "new", scrollTop: 90, anchor: "目标", navigationSerial: 1 });
    await screen.findByRole("heading", { name: "目标" });
    await waitFor(() => expect(view.component.position().anchor).toBe("目标"));
    expect(await view.component.scrollToAnchor("missing")).toBe(false);
    expect(screen.getByText("文档中没有找到这个标题位置。")).toBeTruthy();
  });

  it("长文分批挂载，目录定位可读取尚未挂载的标题", async () => {
    const text = Array.from({ length: 130 }, (_, i) => `## 标题 ${i}`).join("\n\n");
    const view = render(MarkdownPreview, { text, documentKey: "long" });
    await screen.findByRole("heading", { name: "标题 0" });
    expect(screen.queryByRole("heading", { name: "标题 129" })).toBeNull();
    await view.component.scrollToAnchor("标题-129");
    expect(screen.getByRole("heading", { name: "标题 129" })).toBeTruthy();
  });

  it("超过预算给出明确错误与源码操作，空文件有独立空状态", async () => {
    const onSource = vi.fn();
    const onError = vi.fn();
    const view = render(MarkdownPreview, { text: "> ".repeat(50) + "deep", documentKey: "deep", onSource, onError });
    await screen.findByRole("alert");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("源码"));
    await fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(onSource).toHaveBeenCalledTimes(1);
    await view.rerender({ text: "", documentKey: "empty", onSource, onError });
    await screen.findByText("这是一个空文档。");
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("嵌套列表、引用、删除线与四级标题按结构显示，相对链接交给回调", async () => {
    const onLink = vi.fn();
    const { container } = render(MarkdownPreview, {
      text: "> 引用里的 **重点** 与 ~~删除~~\n\n3. 第三步\n   - 嵌套项\n   - [ ] 待办\n\n#### 四级标题\n\n[相对](docs/说明.md)",
      documentKey: "structure",
      onLink,
    });
    await screen.findByRole("heading", { level: 4, name: "四级标题" });
    const quote = container.querySelector("blockquote")!;
    expect(quote.querySelector("strong")?.textContent).toBe("重点");
    expect(quote.querySelector("del")?.textContent).toBe("删除");
    const lists = Array.from(container.querySelectorAll("ol, ul"));
    expect(lists.map((list) => list.tagName)).toEqual(["OL", "UL"]);
    const [outer, nested] = lists as [HTMLOListElement, HTMLUListElement];
    expect(outer.getAttribute("start")).toBe("3");
    expect(Array.from(outer.children).filter((child) => child.tagName === "LI")).toHaveLength(1);
    expect(Array.from(nested.children).filter((child) => child.tagName === "LI")).toHaveLength(2);
    expect(nested.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    await fireEvent.click(screen.getByRole("link", { name: "相对" }));
    expect(onLink).toHaveBeenCalledWith("docs/说明.md");
  });

  it("宽表格和长代码各有可聚焦的滚动区域，目录开关可键盘到达并展开", async () => {
    const { container } = render(MarkdownPreview, {
      text: "# 标题\n\n| 名称 | 值 |\n| --- | --- |\n| a | b |\n\n```ts\nconst x = 1;\n```",
      documentKey: "scroll",
    });
    await screen.findByRole("heading", { name: "标题" });
    const scroller = container.querySelector(".md-scroll")!;
    const reading = screen.getByRole("region", { name: "文档正文" });
    expect(reading).toBe(scroller);
    expect(reading.getAttribute("tabindex")).toBe("0");
    const table = screen.getByRole("region", { name: "文档表格" });
    expect(table.getAttribute("tabindex")).toBe("0");
    expect(table.closest(".md-scroll")).toBe(scroller);
    expect(table.querySelector("table")).toBeTruthy();
    const code = screen.getByRole("region", { name: "代码块" });
    expect(code.getAttribute("tabindex")).toBe("0");
    expect(code.closest(".md-scroll")).toBe(scroller);
    const toggle = screen.getByRole("button", { name: "目录" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const outline = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(outline).toBeTruthy();
    for (const item of Array.from(outline!.querySelectorAll("button"))) expect(item.tabIndex).toBe(0);
  });

  it("预览没有编辑或保存入口，任务项只读点击不改变文档", async () => {
    const { container } = render(MarkdownPreview, { text: "- [ ] 待办\n- [x] 完成", documentKey: "readonly" });
    await screen.findByRole("checkbox", { name: "未完成任务（只读）" });
    expect(container.querySelector("textarea, [contenteditable], [contenteditable='true']")).toBeNull();
    expect(container.querySelector("button[type='submit']")).toBeNull();
    expect(container.querySelectorAll("input:not([disabled])")).toHaveLength(0);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    await fireEvent.click(boxes[0]);
    expect(boxes[0].checked).toBe(false);
    expect(container.textContent).toContain("待办");
  });

  it("切换文档先终止旧解析，迟到结果不能覆盖新文档", async () => {
    ControlledWorker.created = [];
    vi.stubGlobal("Worker", ControlledWorker);
    const view = render(MarkdownPreview, { text: "# 旧文", documentKey: "old" });
    await waitFor(() => expect(ControlledWorker.created).toHaveLength(1));
    const old = ControlledWorker.created[0];
    await view.rerender({ text: "# 新文", documentKey: "new" });
    await waitFor(() => expect(ControlledWorker.created).toHaveLength(2));
    expect(old.terminate).toHaveBeenCalled();
    old.onmessage?.({ data: parseMarkdownDocument("# 旧文") } as MessageEvent);
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "旧文" })).toBeNull();
    ControlledWorker.created[1].onmessage?.({ data: parseMarkdownDocument("# 新文") } as MessageEvent);
    expect(await screen.findByRole("heading", { name: "新文" })).toBeTruthy();
  });

  it("隐藏阅读区时终止在途解析，迟到结果不渲染", async () => {
    ControlledWorker.created = [];
    vi.stubGlobal("Worker", ControlledWorker);
    const props = { text: "# 隐藏", documentKey: "hidden" };
    const view = render(MarkdownPreview, props);
    await waitFor(() => expect(ControlledWorker.created).toHaveLength(1));
    const worker = ControlledWorker.created[0];
    await view.rerender({ ...props, active: false });
    expect(worker.terminate).toHaveBeenCalled();
    worker.onmessage?.({ data: parseMarkdownDocument("# 隐藏") } as MessageEvent);
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "隐藏" })).toBeNull();
  });

  it("解析完成前调用定位不误报缺失，解析完成后同一锚点可到达", async () => {
    ControlledWorker.created = [];
    vi.stubGlobal("Worker", ControlledWorker);
    const view = render(MarkdownPreview, { text: "## 目标", documentKey: "pending" });
    await waitFor(() => expect(ControlledWorker.created).toHaveLength(1));
    expect(await view.component.scrollToAnchor("目标")).toBe(false);
    expect(screen.queryByText("文档中没有找到这个标题位置。")).toBeNull();
    ControlledWorker.created[0].onmessage?.({ data: parseMarkdownDocument("## 目标") } as MessageEvent);
    await screen.findByRole("heading", { name: "目标" });
    expect(await view.component.scrollToAnchor("目标")).toBe(true);
    expect(view.component.position().anchor).toBe("目标");
  });
});
