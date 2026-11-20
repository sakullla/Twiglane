/**
 * 差异行 → 两份「文档」：旧侧（上下文 + 删除行）与新侧（上下文 + 新增行）。
 *
 * 分别对两份文档整体分词，再按下标映射回每一行，跨行的字符串、块注释、模板字面量
 * 因此能正确着色（逐行孤立分词会把块注释的后几行当成代码）。
 * 同时把每个代码块里相邻的「删除串 + 新增串」按相似度智能配对，算出行内多段词级改动区间，
 * 并识别仅行尾（CRLF ↔ LF）变化的配对行。
 */

import type { ViewLine } from "../diff";
import { changedRanges } from "./segments";

export interface DiffDocuments {
  oldLines: string[];
  newLines: string[];
  /** 每行在哪份文档、第几行：side 0 = 旧侧，1 = 新侧，-1 = 不是代码行（块头、元信息）。 */
  side: Int8Array;
  at: Int32Array;
  /** 行内改动区间（按行下标，支持同一行多处词级高亮）。 */
  ranges: Map<number, [number, number][]>;
  /** 仅换行符（CRLF / LF / CR）不同的配对行下标，用于在不开启显示空白时也给出清晰提示。 */
  eolChanged: Set<number>;
}

const CODE_KINDS = new Set(["add", "del", "context"]);

/** 差异行文本带一个前缀符号（+、-、空格），代码从第 2 个字符开始；没有前缀时整行都是代码。 */
export function hasSign(text: string): boolean {
  const first = text[0];
  return first === "+" || first === "-" || first === " ";
}

export function codeOf(line: { text: string }): string {
  return hasSign(line.text) ? line.text.slice(1) : line.text;
}

export function signOf(text: string): string {
  return hasSign(text) ? text[0] : " ";
}

/** 快速公共前后缀相似度（0..1），用于小块不对称删增行的保序智能配对。 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) {
    suffix += 1;
  }
  return (prefix + suffix) / longest;
}

export function buildDiffDocuments(lines: ViewLine[]): DiffDocuments {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const side = new Int8Array(lines.length).fill(-1);
  const at = new Int32Array(lines.length).fill(-1);
  const ranges = new Map<number, [number, number][]>();
  const eolChanged = new Set<number>();
  let dels: number[] = [];
  let adds: number[] = [];

  const applyPair = (delIndex: number, addIndex: number) => {
    const delLine = lines[delIndex];
    const addLine = lines[addIndex];
    const before = codeOf(delLine);
    const after = codeOf(addLine);
    if (before === after) {
      if ((delLine.eol ?? "lf") !== (addLine.eol ?? "lf")) {
        eolChanged.add(delIndex);
        eolChanged.add(addIndex);
      }
      return;
    }
    const found = changedRanges(before, after);
    if (!found) return;
    if (found.before.length > 0) ranges.set(delIndex, found.before);
    if (found.after.length > 0) ranges.set(addIndex, found.after);
  };

  const pair = () => {
    if (dels.length === 0 || adds.length === 0) {
      dels = [];
      adds = [];
      return;
    }
    // 等长或较大块走 O(N) 顺序配对；小块不对称删增（如在修改行上方插入了几行）做保序相似度配对。
    if (dels.length === adds.length || dels.length * adds.length > 256) {
      const count = Math.min(dels.length, adds.length);
      for (let index = 0; index < count; index += 1) {
        applyPair(dels[index], adds[index]);
      }
    } else {
      let nextAdd = 0;
      for (let di = 0; di < dels.length && nextAdd < adds.length; di += 1) {
        const delText = codeOf(lines[dels[di]]);
        let bestAi = -1;
        let bestScore = 0.34;
        for (let ai = nextAdd; ai < adds.length; ai += 1) {
          const score = lineSimilarity(delText, codeOf(lines[adds[ai]]));
          if (score > bestScore) {
            bestScore = score;
            bestAi = ai;
            if (score === 1) break;
          }
        }
        if (bestAi >= 0) {
          applyPair(dels[di], adds[bestAi]);
          nextAdd = bestAi + 1;
        }
      }
    }
    dels = [];
    adds = [];
  };

  lines.forEach((line, index) => {
    if (!CODE_KINDS.has(line.kind)) {
      pair();
      return;
    }
    const code = codeOf(line);
    if (line.kind === "del") {
      if (adds.length > 0) pair();
      dels.push(index);
      side[index] = 0;
      at[index] = oldLines.length;
      oldLines.push(code);
    } else if (line.kind === "add") {
      adds.push(index);
      side[index] = 1;
      at[index] = newLines.length;
      newLines.push(code);
    } else {
      pair();
      // 上下文行两侧都有：旧侧文档里也要放进去，保证删除行前后的语法状态连贯；显示取新侧结果。
      oldLines.push(code);
      side[index] = 1;
      at[index] = newLines.length;
      newLines.push(code);
    }
  });
  pair();
  return { oldLines, newLines, side, at, ranges, eolChanged };
}
