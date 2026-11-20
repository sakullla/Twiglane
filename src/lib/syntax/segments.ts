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
   * 显示空白或特殊不可见字符时才有的字段：由视觉层画标记。
   * 文本一字不改，因此可复制内容、语法分词输入和 DiffLine.text 都还是原文。
   */
  ws?: "space" | "tab" | "special";
  /** 特殊不可见字符（如 BOM、NBSP、ZWSP、双向控制符）的微标签。 */
  wsLabel?: string;
}

/** 连续的空格或制表符、以及常见不可见 Unicode 字符各成一段。 */
const WHITESPACE_AND_SPECIAL = /[ ]+|\t+|[\u00a0\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const HAS_WS_OR_SPECIAL = /[ \t\u00a0\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const SPECIAL_INVISIBLE = /[\u00a0\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

export function specialCharLabel(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code === 0xfeff) return "BOM";
  if (code === 0x00a0) return "NBSP";
  if (code === 0x200b) return "ZWSP";
  if (code === 0x200c) return "ZWNJ";
  if (code === 0x200d) return "ZWJ";
  if (code === 0x2060) return "WJ";
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * 把片段里的连续空白与不可见特殊字符切成独立片段，标上 ws。
 * 文本本身一字不改，可复制内容与原文完全一致。
 */
function markWhitespace(segment: Segment, includeSpaceAndTab: boolean): Segment[] {
  const regex = includeSpaceAndTab ? WHITESPACE_AND_SPECIAL : SPECIAL_INVISIBLE;
  if (includeSpaceAndTab ? !HAS_WS_OR_SPECIAL.test(segment.t) : !SPECIAL_INVISIBLE.test(segment.t)) {
    SPECIAL_INVISIBLE.lastIndex = 0;
    return [segment];
  }
  regex.lastIndex = 0;
  const out: Segment[] = [];
  let offset = 0;
  for (const match of segment.t.matchAll(regex)) {
    const start = match.index;
    if (start > offset) out.push({ ...segment, t: segment.t.slice(offset, start) });
    const value = match[0];
    if (value[0] === " ") out.push({ ...segment, t: value, ws: "space" });
    else if (value[0] === "\t") out.push({ ...segment, t: value, ws: "tab" });
    else out.push({ ...segment, t: value, ws: "special", wsLabel: specialCharLabel(value) });
    offset = start + value.length;
  }
  if (offset < segment.t.length) out.push({ ...segment, t: segment.t.slice(offset) });
  return out;
}

export type IntralineRanges = [number, number] | readonly [number, number][] | null;

function normalizeRanges(range: IntralineRanges): readonly [number, number][] {
  if (!range) return [];
  if (typeof range[0] === "number") {
    const [from, to] = range as [number, number];
    return to > from ? [[from, to]] : [];
  }
  return (range as readonly [number, number][]).filter(([from, to]) => to > from);
}

/**
 * @param showWhitespace 显示不可见字符时再切一层空白片段；特殊不可见字符（BOM/ZWSP/双向符）始终标出。
 */
export function lineSegments(
  text: string,
  tokens: SyntaxLine | null | undefined,
  range: IntralineRanges = null,
  showWhitespace = false,
): Segment[] {
  const segments = splitSegments(text, tokens, normalizeRanges(range));
  if (showWhitespace) return segments.flatMap((seg) => markWhitespace(seg, true));
  // 即使未开启「显示空白」，BOM/零宽/双向控制符也应当可见，避免「看不见的差异」误导审查。
  SPECIAL_INVISIBLE.lastIndex = 0;
  if (!SPECIAL_INVISIBLE.test(text)) return segments;
  SPECIAL_INVISIBLE.lastIndex = 0;
  return segments.flatMap((seg) => markWhitespace(seg, false));
}

function splitSegments(
  text: string,
  tokens: SyntaxLine | null | undefined,
  ranges: readonly [number, number][],
): Segment[] {
  const source = tokens && tokens.length > 0 && tokens.reduce((sum, token) => sum + token.t.length, 0) === text.length
    ? tokens
    : [{ t: text, k: "" }];
  if (ranges.length === 0) return source.map((token) => ({ t: token.t, k: token.k, m: false }));
  const out: Segment[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const token of source) {
    const tokenStart = offset;
    const tokenEnd = offset + token.t.length;
    offset = tokenEnd;
    let cursor = tokenStart;
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= tokenStart) {
      rangeIndex += 1;
    }
    let probe = rangeIndex;
    while (probe < ranges.length && ranges[probe][0] < tokenEnd) {
      const [from, to] = ranges[probe];
      const hitStart = Math.max(cursor, from);
      const hitEnd = Math.min(tokenEnd, to);
      if (hitStart > cursor) {
        out.push({ t: token.t.slice(cursor - tokenStart, hitStart - tokenStart), k: token.k, m: false });
      }
      if (hitEnd > hitStart) {
        out.push({ t: token.t.slice(hitStart - tokenStart, hitEnd - tokenStart), k: token.k, m: true });
      }
      cursor = Math.max(cursor, hitEnd);
      if (to <= tokenEnd) probe += 1;
      else break;
    }
    if (cursor < tokenEnd) {
      out.push({ t: token.t.slice(cursor - tokenStart, tokenEnd - tokenStart), k: token.k, m: false });
    }
    rangeIndex = probe;
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

interface WordToken {
  text: string;
  start: number;
  end: number;
}

const WORD_TOKEN_RE = /[A-Za-z0-9_$]+|[\u4e00-\u9fff]|[\s]+|[^\sA-Za-z0-9_$\u4e00-\u9fff]/g;
const MAX_WORD_DIFF_CHARS = 1024;
const MAX_WORD_DIFF_TOKENS = 120;

function tokenizeRange(text: string, from: number, to: number): WordToken[] {
  const tokens: WordToken[] = [];
  if (to <= from) return tokens;
  const slice = text.slice(from, to);
  WORD_TOKEN_RE.lastIndex = 0;
  for (const match of slice.matchAll(WORD_TOKEN_RE)) {
    const start = from + match.index;
    tokens.push({ text: match[0], start, end: start + match[0].length });
    if (tokens.length > MAX_WORD_DIFF_TOKENS) return tokens;
  }
  return tokens;
}

function pushSpan(list: [number, number][], start: number, end: number): void {
  if (end <= start) return;
  const last = list[list.length - 1];
  if (last && last[1] >= start) last[1] = Math.max(last[1], end);
  else list.push([start, end]);
}

/**
 * 多段词级行内改动区间：在公共前后缀之外的中段上做词级 LCS，精准标出同一行里的多处改动。
 * 对超长压缩行自动退回到单段前后缀比对，保证 O(1) 内存与零卡顿。
 */
export function changedRanges(
  before: string,
  after: string,
): { before: [number, number][]; after: [number, number][] } | null {
  if (before === after) return null;
  const longest = Math.max(before.length, after.length);
  if (longest === 0) return null;

  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const bEnd = before.length - suffix;
  const aEnd = after.length - suffix;

  // 一侧中段为空（纯插入或纯删除）：单段区间即是最优结果。
  if (prefix >= bEnd || prefix >= aEnd) {
    const shared = prefix + suffix;
    if (shared / longest < 0.25) return null;
    return {
      before: bEnd > prefix ? [[prefix, bEnd]] : [],
      after: aEnd > prefix ? [[prefix, aEnd]] : [],
    };
  }

  // 超长中段直接退回单段区间，避免大矩阵开销。
  if (bEnd - prefix > MAX_WORD_DIFF_CHARS || aEnd - prefix > MAX_WORD_DIFF_CHARS) {
    const single = changedRange(before, after);
    return single ? { before: [single.before], after: [single.after] } : null;
  }

  const left = tokenizeRange(before, prefix, bEnd);
  const right = tokenizeRange(after, prefix, aEnd);
  if (left.length > MAX_WORD_DIFF_TOKENS || right.length > MAX_WORD_DIFF_TOKENS) {
    const single = changedRange(before, after);
    return single ? { before: [single.before], after: [single.after] } : null;
  }

  // 单块扁平 Uint16Array DP，避免分配多维数组。
  const m = left.length;
  const n = right.length;
  const stride = n + 1;
  const dp = new Uint16Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    const lt = left[i].text;
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[row + j] = lt === right[j].text
        ? dp[nextRow + j + 1] + 1
        : Math.max(dp[nextRow + j], dp[row + j + 1]);
    }
  }

  const beforeSpans: [number, number][] = [];
  const afterSpans: [number, number][] = [];
  let matchedChars = prefix + suffix;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (left[i].text === right[j].text) {
      matchedChars += left[i].text.length;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      pushSpan(beforeSpans, left[i].start, left[i].end);
      i += 1;
    } else {
      pushSpan(afterSpans, right[j].start, right[j].end);
      j += 1;
    }
  }
  while (i < m) {
    pushSpan(beforeSpans, left[i].start, left[i].end);
    i += 1;
  }
  while (j < n) {
    pushSpan(afterSpans, right[j].start, right[j].end);
    j += 1;
  }

  if (matchedChars / longest < 0.25) return null;
  if (beforeSpans.length === 0 && afterSpans.length === 0) return null;
  return { before: beforeSpans, after: afterSpans };
}
