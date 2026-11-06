/**
 * 把一行代码切成可渲染片段：语法片段（类名）与「本行真正改动的字符」区间叠加。
 * 没有语法结果时整行是一个默认片段，区间照样生效——高亮还没回来时，行内改动标记也不缺席。
 */

import type { SyntaxLine } from "./engine";

export interface Segment {
  t: string;
  k: string;
  /** 是否落在行内改动区间里。 */
  m: boolean;
  /**
   * 显示空白时才有的字段：这一段是不可见字符（空格 / 制表符），由视觉层画标记。
   * 文本一字不改，因此可复制内容、语法分词输入和 DiffLine.text 都还是原文。
   */
  ws?: "space" | "tab";
}

/** 连续的空格或制表符各成一段；混在一起时按字符类型分开，标记才能画对。 */
const WHITESPACE_RUN = /[ ]+|\t+/g;

/**
 * 把片段里的连续空白切成独立片段，标上 ws。
 * 只在用户打开「显示空白」时走这条路；默认路径的片断结构与原来完全一致。
 */
function markWhitespace(segment: Segment): Segment[] {
  if (!/[ \t]/.test(segment.t)) return [segment];
  const out: Segment[] = [];
  let offset = 0;
  for (const match of segment.t.matchAll(WHITESPACE_RUN)) {
    const start = match.index;
    if (start > offset) out.push({ ...segment, t: segment.t.slice(offset, start) });
    out.push({ ...segment, t: match[0], ws: match[0][0] === "\t" ? "tab" : "space" });
    offset = start + match[0].length;
  }
  if (offset < segment.t.length) out.push({ ...segment, t: segment.t.slice(offset) });
  return out;
}

/**
 * @param showWhitespace 显示不可见字符时再切一层空白片段；文本本身不变。
 */
export function lineSegments(
  text: string,
  tokens: SyntaxLine | null | undefined,
  range: [number, number] | null = null,
  showWhitespace = false,
): Segment[] {
  const segments = splitSegments(text, tokens, range);
  return showWhitespace ? segments.flatMap(markWhitespace) : segments;
}

function splitSegments(text: string, tokens: SyntaxLine | null | undefined, range: [number, number] | null): Segment[] {
  const source = tokens && tokens.length > 0 && tokens.reduce((sum, token) => sum + token.t.length, 0) === text.length
    ? tokens
    : [{ t: text, k: "" }];
  if (!range || range[0] >= range[1]) return source.map((token) => ({ t: token.t, k: token.k, m: false }));
  const [from, to] = range;
  const out: Segment[] = [];
  let offset = 0;
  for (const token of source) {
    const start = offset;
    const end = offset + token.t.length;
    offset = end;
    const cuts = [start, Math.min(Math.max(from, start), end), Math.min(Math.max(to, start), end), end];
    for (let index = 0; index < 3; index += 1) {
      const a = cuts[index];
      const b = cuts[index + 1];
      if (b <= a) continue;
      out.push({ t: token.t.slice(a - start, b - start), k: token.k, m: index === 1 });
    }
  }
  return out;
}

/**
 * 行内改动区间（公共前后缀之外的中段）。两行几乎完全不同时不标——整行都标亮等于没标。
 */
export function changedRange(before: string, after: string): { before: [number, number]; after: [number, number] } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const shared = prefix + suffix;
  const longest = Math.max(before.length, after.length);
  if (longest === 0 || shared / longest < 0.3) return null;
  return { before: [prefix, before.length - suffix], after: [prefix, after.length - suffix] };
}
