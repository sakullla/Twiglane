import { Lexer, type MarkedToken, type Token } from "marked";
import { decodeHTML } from "entities";
import type { MarkdownDocument, MarkdownHeading, MarkdownNode, MarkdownParseResult } from "./types";

export const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
export const MARKDOWN_FALLBACK_CHARS = 64 * 1024;
export const MARKDOWN_MAX_NODES = 6000;
export const MARKDOWN_MAX_DEPTH = 32;
export const MARKDOWN_MAX_BLOCK_NODES = 1200;
const MAX_CODE_LINES = 1200;
const MAX_BLOCK_CHARS = 256 * 1024;

function plainText(nodes: MarkdownNode[]): string {
  return nodes.map((node) => {
    if ("text" in node) return node.text;
    if ("children" in node) return plainText(node.children);
    return "";
  }).join("");
}

/** 标题锚点保留 Unicode 字母/数字，重复名称使用稳定递增后缀。 */
export function headingSlug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-") || "section";
}

/** 同时用于 Worker 和小文档回退；遇到预算问题整篇拒绝，不产生伪完整预览。 */
export function parseMarkdownDocument(source: string): MarkdownParseResult {
  if (new TextEncoder().encode(source).length > MARKDOWN_MAX_BYTES) {
    return { ok: false, message: "文档超过预览大小限制，请切换到源码阅读。" };
  }
  try {
    const lexer = new Lexer({ gfm: true, breaks: false });
    const tokens = lexer.lex(source);
    const headings: MarkdownHeading[] = [];
    const slugs = new Set<string>();
    let count = 0;
    let block = 0;
    function nodes(input: Token[], depth = 0): MarkdownNode[] {
      if (depth > MARKDOWN_MAX_DEPTH) throw new Error("文档嵌套层级过深，请切换到源码阅读。");
      const output: MarkdownNode[] = [];
      for (const candidate of input) {
        if (++count > MARKDOWN_MAX_NODES) throw new Error("文档结构超过预览预算，请切换到源码阅读。");
        // 不启用自定义 tokenizer；未知类型始终走原文回退，不信任任意结构。
        const token = candidate as MarkedToken;
        const children = () => nodes("tokens" in token ? token.tokens ?? [] : [], depth + 1);
        switch (token.type) {
          case "space": case "def": case "checkbox": break;
          case "escape": output.push({ kind: "text", text: token.text }); break;
          case "text":
            output.push(...(token.tokens ? children() : [{ kind: "text" as const, text: decodeHTML(token.text) }]));
            break;
          case "html": output.push({ kind: "raw", text: token.text }); break;
          case "codespan": output.push({ kind: "codespan", text: token.text }); break;
          case "paragraph": case "strong": case "em": case "del": case "blockquote":
            output.push({ kind: token.type, children: children() }); break;
          case "heading": {
            const content = children();
            const text = plainText(content);
            const base = headingSlug(text);
            let id = base;
            let suffix = 0;
            while (slugs.has(id)) id = `${base}-${++suffix}`;
            slugs.add(id);
            headings.push({ id, text, depth: token.depth, block });
            output.push({ kind: "heading", depth: token.depth, id, children: content });
            break;
          }
          case "br": case "hr": output.push({ kind: token.type }); break;
          case "code":
            if (token.text.length > MAX_BLOCK_CHARS || token.text.split("\n").length > MAX_CODE_LINES) {
              throw new Error("代码块超过预览预算，请切换到源码阅读。");
            }
            output.push({ kind: "code", text: token.text, language: (token.lang ?? "").trim().split(/\s+/)[0] });
            break;
          case "link":
            output.push({ kind: "link", href: token.autolink ? token.href : decodeHTML(token.href), title: token.title ? decodeHTML(token.title) : null, children: children() });
            break;
          case "image":
            output.push({ kind: "image", href: decodeHTML(token.href), title: token.title ? decodeHTML(token.title) : null, text: plainText(children()) || decodeHTML(token.text) });
            break;
          case "list":
            output.push({ kind: "list", ordered: token.ordered, start: Number(token.start) || 1, items: token.items.map((item) => ({ task: item.task, checked: item.checked === true, children: nodes(item.tokens, depth + 1) })) });
            break;
          case "list_item": output.push(...children()); break;
          case "table":
            output.push({ kind: "table", header: token.header.map((cell) => nodes(cell.tokens, depth + 1)), rows: token.rows.map((row) => row.map((cell) => nodes(cell.tokens, depth + 1))), align: token.align });
            break;
          default: output.push({ kind: "raw", text: candidate.raw });
        }
      }
      return output;
    }
    const blocks: MarkdownNode[] = [];
    for (const token of tokens) {
      const before = count;
      block = blocks.length;
      if (token.raw.length > MAX_BLOCK_CHARS) throw new Error("文档段落超过预览预算，请切换到源码阅读。");
      blocks.push(...nodes([token]));
      if (count - before > MARKDOWN_MAX_BLOCK_NODES) throw new Error("文档单段结构过于复杂，请切换到源码阅读。");
    }
    const document: MarkdownDocument = { blocks, headings };
    return { ok: true, document };
  } catch (error) {
    return { ok: false, message: error instanceof Error && /^(文档|代码块)/.test(error.message)
      ? error.message
      : "文档无法完成预览，请切换到源码阅读。" };
  }
}
