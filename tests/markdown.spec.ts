import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMarkdownDocument, headingSlug, MARKDOWN_FALLBACK_CHARS, MARKDOWN_MAX_BYTES } from "../src/lib/markdown/parser";
import { markdownLinkKind, safeImageDataUrl } from "../src/lib/markdown/links";
import { parseMarkdown, MARKDOWN_PARSE_TIMEOUT_MS } from "../src/lib/markdown/client";
import type { MarkdownParseResult } from "../src/lib/markdown/types";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Markdown 文档解析", () => {
  it("保留中文与重复标题的稳定锚点、实体文本及 GFM 结构", () => {
    const result = parseMarkdownDocument("# 中文标题\n\n## 中文标题\n\n## 中文标题-1\n\nA &amp; B &copy; &#x4e2d; **重要** ~~旧~~\n\n- [x] 完成\n- [ ] 待办\n\n| 名称 | 值 |\n| --- | ---: |\n| key | 1 |\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.headings.map((heading) => heading.id)).toEqual(["中文标题", "中文标题-1", "中文标题-1-1"]);
    const encoded = JSON.stringify(result.document);
    expect(encoded).toContain("A & B © 中 ");
    expect(encoded).toContain('"kind":"del"');
    const list = result.document.blocks.find((node) => node.kind === "list");
    expect(list?.kind === "list" && list.items.map((item) => item.checked)).toEqual([true, false]);
    const table = result.document.blocks.find((node) => node.kind === "table");
    expect(table?.kind === "table" && table.align).toEqual([null, "right"]);
  });

  it("代码和原始 HTML 作为数据保留，HTML 没有可执行节点类型", () => {
    const source = "<script>alert(1)</script>\n\n```unknown\nconst x = '<img onerror=x>';\n```\n\n`&amp;`";
    const result = parseMarkdownDocument(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.blocks[0]).toEqual({ kind: "raw", text: "<script>alert(1)</script>" });
    expect(result.document.blocks).toContainEqual({ kind: "code", language: "unknown", text: "const x = '<img onerror=x>';" });
    expect(JSON.stringify(result.document)).toContain('"kind":"codespan","text":"&amp;"');
  });

  it("空文件有效，未闭合的围栏仍可读", () => {
    expect(parseMarkdownDocument("")).toEqual({ ok: true, document: { blocks: [], headings: [] } });
    const result = parseMarkdownDocument("```js\nconst x = 1;");
    expect(result.ok && result.document.blocks).toEqual([{ kind: "code", language: "js", text: "const x = 1;" }]);
  });

  it("整篇超过字节、结构和单块预算时明确退回源码，不返回片段文档", () => {
    const inputs = ["中".repeat(Math.ceil(MARKDOWN_MAX_BYTES / 3)), "段落\n\n".repeat(7000), "```\n" + "x\n".repeat(1201) + "```", "> ".repeat(50) + "deep"];
    for (const input of inputs) {
      const result = parseMarkdownDocument(input);
      expect(result.ok).toBe(false);
      expect("document" in result).toBe(false);
      if (!result.ok) expect(result.message).toContain("源码");
    }
  });

  it("列表和引用内的标题指向其外层可挂载段落", () => {
    const result = parseMarkdownDocument("text\n\n> ## 引用标题\n\n- item\n  ### 列表标题");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.headings.map((heading) => heading.block)).toEqual([1, 2]);
  });

  it("嵌套列表、引用与有序起始值保留结构", () => {
    const result = parseMarkdownDocument("> 引用里的 **重点** 与 ~~删除~~\n\n3. 第三步\n   - 嵌套项\n   - [ ] 待办\n\n#### 四级标题\n\n[相对](docs/说明.md)");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [quote, list, heading] = result.document.blocks;
    expect(quote.kind).toBe("blockquote");
    expect(JSON.stringify(quote)).toContain('"kind":"strong"');
    expect(JSON.stringify(quote)).toContain('"kind":"del"');
    expect(list.kind).toBe("list");
    if (list.kind !== "list") return;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    const nested = list.items[0].children.find((node) => node.kind === "list");
    expect(nested?.kind).toBe("list");
    if (nested?.kind !== "list") return;
    expect(nested.ordered).toBe(false);
    expect(nested.items.map((item) => item.task)).toEqual([false, true]);
    expect(nested.items[1].checked).toBe(false);
    expect(heading.kind === "heading" && heading.depth).toBe(4);
    const paragraph = result.document.blocks[3];
    expect(paragraph.kind).toBe("paragraph");
    expect(paragraph.kind === "paragraph" && paragraph.children[0]).toEqual({
      kind: "link",
      href: "docs/说明.md",
      title: null,
      children: [{ kind: "text", text: "相对" }],
    });
  });

  it("中文标题锚点保留语义，空白折叠为连字符且空标题有兜底", () => {
    expect(headingSlug("中文 标题")).toBe("中文-标题");
    expect(headingSlug("A & B")).toBe("a--b");
    expect(headingSlug("  ")).toBe("section");
  });
});

describe("Markdown URL 展示边界", () => {
  it.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//example.com/x", "C:\\secret", "https://user:secret@example.com/x", "java\nscript:x", "\u0000bad"])("阻止 %s", (url) => {
    expect(markdownLinkKind(url)).toBe("blocked");
  });

  it("区分仓库相对链接、锚点与显式远程资源", () => {
    expect(markdownLinkKind("../中文 文档.md#标题")).toBe("local");
    expect(markdownLinkKind("#中文标题")).toBe("anchor");
    expect(markdownLinkKind("https://example.com/a.png")).toBe("remote");
  });

  it("只接收受限图片 data URL，不接收资源加载回调里的外部地址或 HTML", () => {
    expect(safeImageDataUrl("https://example.com/a.png")).toBeNull();
    expect(safeImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeImageDataUrl("data:image/svg+xml,<svg onload='x'></svg>")).toBeNull();
    expect(safeImageDataUrl("data:image/png;base64,YWJj")).toBe("data:image/png;base64,YWJj");
  });
});

describe("后台解析生命周期", () => {
  class FakeWorker {
    static all: FakeWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { FakeWorker.all.push(this); }
  }

  it("取消立即终止 Worker，迟到结果不通知消费者", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const receive = vi.fn();
    const cancel = parseMarkdown("old", receive);
    const worker = FakeWorker.all.at(-1)!;
    cancel();
    worker.onmessage?.({ data: parseMarkdownDocument("old") } as MessageEvent);
    expect(worker.terminate).toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });

  it("超时与 Worker 错误结束任务，告知源码退路", () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const receive = vi.fn();
    parseMarkdown("slow", receive);
    const worker = FakeWorker.all.at(-1)!;
    vi.advanceTimersByTime(MARKDOWN_PARSE_TIMEOUT_MS);
    expect(receive).toHaveBeenCalledWith({ ok: false, message: expect.stringContaining("源码") });
    expect(worker.terminate).toHaveBeenCalled();
    worker.onmessage?.({ data: parseMarkdownDocument("late") } as MessageEvent);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("Worker 返回无法识别的结果时结束为可恢复错误，不留在加载态", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const receive = vi.fn();
    parseMarkdown("doc", receive);
    const worker = FakeWorker.all.at(-1)!;
    worker.onmessage?.({ data: null } as MessageEvent);
    expect(receive).toHaveBeenCalledWith({ ok: false, message: expect.stringContaining("源码") });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("没有 Worker 的宿主只回退解析小文档，长文明确退回源码", async () => {
    vi.stubGlobal("Worker", undefined);
    const small = await new Promise<MarkdownParseResult>((resolve) => parseMarkdown("## 回退", resolve));
    expect(small.ok).toBe(true);
    expect(small.ok && small.document.headings.map((heading) => heading.text)).toEqual(["回退"]);
    const long = await new Promise<MarkdownParseResult>((resolve) => parseMarkdown("x".repeat(MARKDOWN_FALLBACK_CHARS + 1), resolve));
    expect(long.ok).toBe(false);
    expect(long.ok === false && long.message).toContain("源码");
  });
});

describe("Markdown 样式跟随主题与内容区滚动", () => {
  const styles = path.resolve(__dirname, "..", "src", "styles");
  const read = (file: string) => readFileSync(path.join(styles, file), "utf8");
  const css = read("markdown.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = read("tokens.css");

  it("颜色只来自主题令牌，可随浅深主题切换", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgba?|hsla?)\(\s*(?!var\()/);
    for (const match of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      expect(tokens, match[1]).toContain(`${match[1]}:`);
    }
  });

  it("宽表格与长代码各自在内容区滚动，外层不横向溢出", () => {
    expect(css).toMatch(/\.markdown-preview \{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.md-scroll \{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.md-table-scroll \{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.md-code pre \{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.md-body \{[^}]*overflow-wrap:\s*anywhere/);
  });
});
