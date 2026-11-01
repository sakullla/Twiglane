/**
 * 差异行 → 两份「文档」：旧侧（上下文 + 删除行）与新侧（上下文 + 新增行）。
 *
 * 分别对两份文档整体分词，再按下标映射回每一行，跨行的字符串、块注释、模板字面量
 * 因此能正确着色（逐行孤立分词会把块注释的后几行当成代码）。
 * 同时把每个代码块里相邻的「删除串 + 新增串」按序配对，算出行内真正改动的字符区间。
 */

import type { ViewLine } from "../diff";
import { changedRange } from "./segments";

export interface DiffDocuments {
  oldLines: string[];
  newLines: string[];
  /** 每行在哪份文档、第几行：side 0 = 旧侧，1 = 新侧，-1 = 不是代码行（块头、元信息）。 */
  side: Int8Array;
  at: Int32Array;
  /** 行内改动区间（按行下标）。 */
  ranges: Map<number, [number, number]>;
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

export function buildDiffDocuments(lines: ViewLine[]): DiffDocuments {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const side = new Int8Array(lines.length).fill(-1);
  const at = new Int32Array(lines.length).fill(-1);
  const ranges = new Map<number, [number, number]>();
  let dels: number[] = [];
  let adds: number[] = [];

  const pair = () => {
    const count = Math.min(dels.length, adds.length);
    for (let index = 0; index < count; index += 1) {
      const range = changedRange(codeOf(lines[dels[index]]), codeOf(lines[adds[index]]));
      if (!range) continue;
      ranges.set(dels[index], range.before);
      ranges.set(adds[index], range.after);
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
  return { oldLines, newLines, side, at, ranges };
}
