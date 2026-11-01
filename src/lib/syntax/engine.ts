/**
 * 语法分词引擎：Shiki core + 纯 JS 正则引擎（无 WASM、无 eval，符合 CSP 的 script-src 'self'），
 * 主题用 CSS 变量主题——颜色在 tokens.css 里随浅/深色切换，这里只输出「这是什么」。
 *
 * 同一份代码既跑在 Web Worker 里（正式路径），也能在主线程兜底（测试环境、无 Worker 时）。
 */

import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

/** 一个语法片段：t 为文本，k 为类名（如 "tk-keyword tk-i"），空串表示默认前景色。 */
export interface SyntaxToken {
  t: string;
  k: string;
}

export type SyntaxLine = SyntaxToken[];

const THEME = "twiglane";
const PREFIX = "--syn-";
/** 单行超过这个长度就不分词（压缩后的单行 JS/JSON 会把正则引擎拖得很慢），按纯文本显示。 */
export const MAX_LINE_LENGTH = 2000;

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<boolean>>();

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: PREFIX, variableDefaults: {}, fontStyle: true })],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

/** 按需加载语法；加载失败（语法缺失、正则不兼容）时返回 false，调用方按纯文本显示。 */
export function ensureLanguage(lang: string): Promise<boolean> {
  let pending = loaded.get(lang);
  if (!pending) {
    pending = (async () => {
      const entry = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[lang];
      if (!entry) return false;
      try {
        const instance = await core();
        await instance.loadLanguage(entry as never);
        return true;
      } catch {
        return false;
      }
    })();
    loaded.set(lang, pending);
  }
  return pending;
}

const CLASS_CACHE = new Map<string, string>();

function classOf(token: ThemedToken): string {
  const color = token.color ?? "";
  const style = token.fontStyle ?? 0;
  const key = `${color}|${style}`;
  let cls = CLASS_CACHE.get(key);
  if (cls === undefined) {
    const match = color.match(/var\(--syn-(?:token-)?([a-z-]+)\)/);
    const name = match && match[1] !== "foreground" ? `tk-${match[1]}` : "";
    const parts = [name];
    if (style & 1) parts.push("tk-i");
    if (style & 2) parts.push("tk-b");
    if (style & 4) parts.push("tk-u");
    cls = parts.filter(Boolean).join(" ");
    CLASS_CACHE.set(key, cls);
  }
  return cls;
}

/** 合并相邻同类片段，减少 DOM 节点。 */
function compact(line: ThemedToken[]): SyntaxLine {
  const out: SyntaxLine = [];
  for (const token of line) {
    const k = classOf(token);
    const last = out[out.length - 1];
    if (last && last.k === k) last.t += token.content;
    else out.push({ t: token.content, k });
  }
  return out;
}

/**
 * 分块分词：每块 chunkLines 行，块与块之间延续语法状态（多行字符串、块注释不会断），
 * 每完成一块回调一次，调用方可以先显示已完成的部分。cancelled() 返回 true 时立即停止。
 */
export async function tokenizeInChunks(
  lang: string,
  lines: string[],
  onChunk: (start: number, tokens: SyntaxLine[]) => void,
  options: { chunkLines?: number; cancelled?: () => boolean; yieldBetween?: () => Promise<void> } = {},
): Promise<boolean> {
  if (!(await ensureLanguage(lang))) return false;
  const instance = await core();
  const size = options.chunkLines ?? 400;
  let state: ReturnType<HighlighterCore["getLastGrammarState"]> | undefined;
  for (let start = 0; start < lines.length; start += size) {
    if (options.cancelled?.()) return false;
    const slice = lines.slice(start, start + size);
    const long = slice.map((line) => line.length > MAX_LINE_LENGTH);
    // 超长行以空行占位参与分词，保证行号对齐，显示时再换回纯文本。
    const code = slice.map((line, index) => (long[index] ? "" : line)).join("\n");
    let tokens: ThemedToken[][];
    try {
      const result = instance.codeToTokens(code, { lang, theme: THEME, grammarState: state });
      tokens = result.tokens;
      state = instance.getLastGrammarState(tokens);
    } catch {
      return false;
    }
    const chunk = slice.map((line, index) => (long[index] ? [{ t: line, k: "" }] : compact(tokens[index] ?? [])));
    onChunk(start, chunk);
    if (options.yieldBetween) await options.yieldBetween();
  }
  return true;
}
