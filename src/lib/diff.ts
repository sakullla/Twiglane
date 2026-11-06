import type { DiffLine, DiffResponse } from "./types";

/** 刷新仍读取 Git；补丁与分页未变时复用行数组，避免重复排版和语法分词。 */
export function reuseDiffContent(previous: DiffResponse | null | undefined, next: DiffResponse): DiffResponse {
  if (
    previous && next.snapshot && previous.snapshot === next.snapshot &&
    previous.path === next.path && previous.staged === next.staged &&
    !previous.binary && !next.binary && previous.offset === next.offset &&
    previous.totalLines === next.totalLines && previous.lines.length === next.lines.length
  ) {
    return { ...next, lines: previous.lines, hunks: previous.hunks };
  }
  return next;
}

export interface DiffAttempt {
  token: number;
  repo: string;
  path: string;
  side: string;
}

export interface DiffViewTarget {
  token: number;
  repo: string | null;
  path: string | null;
  side: string | null;
}

export function diffResultApplies(attempt: DiffAttempt, current: DiffViewTarget): boolean {
  return (
    attempt.token === current.token &&
    current.repo === attempt.repo &&
    current.path === attempt.path &&
    current.side === attempt.side
  );
}

export async function finishDiffAttempt<T>(
  attempt: DiffAttempt,
  current: () => DiffViewTarget,
  run: () => Promise<T>,
): Promise<{ state: "applied"; value: T } | { state: "discarded" } | { state: "failed"; error: unknown }> {
  try {
    const value = await run();
    if (!diffResultApplies(attempt, current())) return { state: "discarded" };
    return { state: "applied", value };
  } catch (error) {
    if (!diffResultApplies(attempt, current())) return { state: "discarded" };
    return { state: "failed", error };
  }
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export function diffLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export interface SideCell {
  text: string;
  /** 在原始行列表里的下标（语法高亮与行内改动按它取结果）。 */
  index?: number;
  kind: DiffLineKind | "empty";
  no: number | null;
}

export interface SideRow {
  left: SideCell | null;
  right: SideCell | null;
  span: boolean;
  hunkIndex: number | null;
  showStage: boolean;
}

export interface ViewLine {
  kind: string;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  hunkIndex: number | null;
}

/** 并排一行左右各要放下行号。暂存按钮再占一列。宽度还没量到时先按放得下处理。 */
export const SPLIT_LINE_NO = 48;
export const SPLIT_STAGE_RESERVE = 88;

export function splitColumnsFit(width: number, reserveStage: boolean): boolean {
  if (width <= 0) return true;
  return width >= SPLIT_LINE_NO * 2 + (reserveStage ? SPLIT_STAGE_RESERVE : 0);
}

export function toSideRows(lines: ViewLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let pending: SideRow[] = [];
  // 每个待配对位置只访问一次；大段替换不能为每个新增行从头扫描。
  let nextPair = 0;
  // Git 把「\ No newline at end of file」插在没有结尾换行的那一行后面。删除行和随后的新增行之间
  // 也会出现它；若此时把尚未配对的删除行刷出去，左右就会落到不同行。标记挂在前一行对应侧，等这组配对完成再插入。
  const notes = new Map<SideRow, SideRow[]>();
  let anchor: SideRow | null = null;
  let anchorSide: "left" | "right" | "both" = "both";
  const flush = () => {
    for (const row of pending) {
      rows.push(row);
      const attached = notes.get(row);
      if (attached) rows.push(...attached);
    }
    pending = [];
    nextPair = 0;
    notes.clear();
  };
  const spanRow = (line: ViewLine, index: number, kind: DiffLineKind, showStage: boolean): SideRow => ({
    left: { text: line.text, kind, no: line.oldNo, index },
    right: { text: line.text, kind, no: line.newNo, index },
    span: true,
    hunkIndex: line.hunkIndex,
    showStage,
  });
  const remember = (row: SideRow, side: "left" | "right" | "both") => {
    anchor = row;
    anchorSide = side;
  };
  const attachNote = (line: ViewLine, index: number) => {
    const cell = { text: line.text, kind: "meta" as const, no: null, index };
    const note: SideRow = {
      left: anchorSide === "right" ? null : { ...cell, no: line.oldNo },
      right: anchorSide === "left" ? null : { ...cell, no: line.newNo },
      span: anchorSide === "both",
      hunkIndex: line.hunkIndex,
      showStage: false,
    };
    if (anchor && pending.includes(anchor)) {
      const attached = notes.get(anchor);
      if (attached) attached.push(note);
      else notes.set(anchor, [note]);
      return;
    }
    rows.push(note);
  };
  lines.forEach((line, index) => {
    if (line.kind === "nonewline") {
      attachNote(line, index);
      return;
    }
    if (line.kind === "hunk" || line.kind === "meta") {
      flush();
      const row = spanRow(line, index, line.kind, line.kind === "hunk");
      rows.push(row);
      remember(row, "both");
      return;
    }
    if (line.kind === "del") {
      const row: SideRow = {
        left: { text: line.text, kind: "del", no: line.oldNo, index },
        right: null,
        span: false,
        hunkIndex: line.hunkIndex,
        showStage: false,
      };
      pending.push(row);
      remember(row, "left");
      return;
    }
    if (line.kind === "add") {
      while (nextPair < pending.length && pending[nextPair].right !== null) nextPair += 1;
      const slot = pending[nextPair];
      if (slot) {
        slot.right = { text: line.text, kind: "add", no: line.newNo, index };
        nextPair += 1;
        remember(slot, "right");
      } else {
        // 多出来的新增行必须排在已配对的删除/新增行之后：直接推进 rows 会跑到仍在 pending
        // 里的配对行前面，并排视图就会出现「14 在 13 之前」、左栏多一行空白的错位。
        const row: SideRow = {
          left: null,
          right: { text: line.text, kind: "add", no: line.newNo, index },
          span: false,
          hunkIndex: line.hunkIndex,
          showStage: false,
        };
        pending.push(row);
        remember(row, "right");
      }
      return;
    }
    flush();
    const row: SideRow = {
      left: { text: line.text, kind: "context", no: line.oldNo, index },
      right: { text: line.text, kind: "context", no: line.newNo, index },
      span: false,
      hunkIndex: line.hunkIndex,
      showStage: false,
    };
    rows.push(row);
    remember(row, "both");
  });
  flush();
  return rows;
}

interface TextLine {
  kind: "add" | "del" | "context";
  text: string;
}

export function createTextDiff(path: string, before: string, after: string, generation = 0): DiffResponse {
  const oldLines = diffLines(before);
  const newLines = diffLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle: TextLine[] = [];
  if (oldMiddle.length * newMiddle.length <= 500_000) {
    const table = Array.from({ length: oldMiddle.length + 1 }, () => new Uint32Array(newMiddle.length + 1));
    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        table[i][j] = oldMiddle[i] === newMiddle[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMiddle.length && j < newMiddle.length) {
      if (oldMiddle[i] === newMiddle[j]) {
        middle.push({ kind: "context", text: oldMiddle[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        middle.push({ kind: "del", text: oldMiddle[i] });
        i += 1;
      } else {
        middle.push({ kind: "add", text: newMiddle[j] });
        j += 1;
      }
    }
    while (i < oldMiddle.length) {
      middle.push({ kind: "del", text: oldMiddle[i] });
      i += 1;
    }
    while (j < newMiddle.length) {
      middle.push({ kind: "add", text: newMiddle[j] });
      j += 1;
    }
  } else {
    middle.push(...oldMiddle.map((text) => ({ kind: "del" as const, text })));
    middle.push(...newMiddle.map((text) => ({ kind: "add" as const, text })));
  }

  const raw = [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: "context" as const, text })),
  ];
  let oldNo = 0;
  let newNo = 0;
  const numbered: DiffLine[] = raw.map((line) => {
    if (line.kind === "del") {
      oldNo += 1;
      return { kind: "del", text: `-${line.text}`, oldNo, newNo: null, hunkIndex: null };
    }
    if (line.kind === "add") {
      newNo += 1;
      return { kind: "add", text: `+${line.text}`, oldNo: null, newNo, hunkIndex: null };
    }
    oldNo += 1;
    newNo += 1;
    return { kind: "context", text: ` ${line.text}`, oldNo, newNo, hunkIndex: null };
  });

  const changed = numbered.some((line) => line.kind !== "context");
  const lines: DiffLine[] = [];
  if (!changed) {
    lines.push(...numbered);
  } else {
    const included = numbered.map((line, index) => {
      if (line.kind !== "context") return true;
      const beforeChanged = numbered.slice(Math.max(0, index - 3), index).some((line) => line.kind !== "context");
      const afterChanged = numbered.slice(index + 1, index + 4).some((line) => line.kind !== "context");
      return beforeChanged || afterChanged;
    });
    let index = 0;
    while (index < numbered.length) {
      if (!included[index]) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < numbered.length && included[index]) index += 1;
      const group = numbered.slice(start, index);
      const oldStart = group.find((line) => line.oldNo !== null)?.oldNo ?? 1;
      const newStart = group.find((line) => line.newNo !== null)?.newNo ?? 1;
      lines.push({ kind: "hunk", text: `@@ -${oldStart} +${newStart} @@`, oldNo: null, newNo: null, hunkIndex: null });
      lines.push(...group);
    }
  }

  const additions = numbered.filter((line) => line.kind === "add").length;
  const deletions = numbered.filter((line) => line.kind === "del").length;
  return {
    generation,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: `新增 ${additions} 行，删除 ${deletions} 行。`,
    additions,
    deletions,
    complete: true,
    truncated: false,
    snapshot: `text-diff-${generation}`,
    hunks: [],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

/** 去掉 Git 文件头后的可读行，origin 记录每行在原始列表里的下标（按块暂存按原始下标找块）。 */
export interface VisibleDiffLines<T extends { kind: string; text: string }> {
  lines: T[];
  origin: number[];
  /** 被隐藏的元信息里对读者有意义的部分（权限、重命名），只在没有代码行时展示。 */
  meta: string[];
}

export function visibleDiffLines<T extends { kind: string; text: string }>(all: T[]): VisibleDiffLines<T> {
  const lines: T[] = [];
  const origin: number[] = [];
  const meta: string[] = [];
  all.forEach((line, index) => {
    if (line.kind === "meta") {
      const text = line.text;
      if (/^(old mode|new mode|rename from|rename to|similarity index|new file mode|deleted file mode)/.test(text)) meta.push(text);
      return;
    }
    lines.push(line);
    origin.push(index);
  });
  return { lines, origin, meta };
}

/**
 * 纯空白改动块：删除行与新增行去掉空白后序列完全一致。
 *
 * 只做只读判定——据此隐藏整块，不重排、不改行号、不伪造补丁；混合块（序列不完全一致）
 * 一律保留，宁可多显示也不让读者对不上原文件。块身份用 canonical 的 hunk.index。
 */
export interface WhitespaceFilter {
  /** 只改了空白的块 index。 */
  hunks: Set<number>;
  /** 这些块里被一并隐藏的代码行数（新增 + 删除），用于工具条持续状态。 */
  lines: number;
}

/** 差异行文本前的 +/-/空格 是显示符号，不属于比较内容。 */
function contentOf(text: string): string {
  const first = text[0];
  if (first === "+" || first === "-" || first === " ") return text.slice(1);
  return text;
}

function squeeze(text: string): string {
  return contentOf(text).replace(/[ \t\r\n\f\v]+/g, "");
}

export function whitespaceOnlyHunks(
  lines: readonly { kind: string; text: string; hunkIndex: number | null }[],
): WhitespaceFilter {
  const order: number[] = [];
  const dels = new Map<number, string[]>();
  const adds = new Map<number, string[]>();
  for (const line of lines) {
    if (line.hunkIndex === null) continue;
    if (line.kind !== "add" && line.kind !== "del") continue;
    if (!dels.has(line.hunkIndex)) {
      dels.set(line.hunkIndex, []);
      adds.set(line.hunkIndex, []);
      order.push(line.hunkIndex);
    }
    const bucket = line.kind === "del" ? dels : adds;
    bucket.get(line.hunkIndex)?.push(squeeze(line.text));
  }
  const hunks = new Set<number>();
  let count = 0;
  for (const index of order) {
    const left = dels.get(index) ?? [];
    const right = adds.get(index) ?? [];
    if (left.length === 0 || right.length === 0) continue;
    // 序列长度与每一项都要一致：多一行少一行都属于真实改动。
    if (left.length !== right.length) continue;
    if (!left.every((text, at) => text === right[at])) continue;
    hunks.add(index);
    count += left.length + right.length;
  }
  return { hunks, lines: count };
}

/**
 * 会让行选失效的显示上下文：换文件、generation、布局、完整文件或空白过滤之后，
 * 之前选中的行可能已经不在屏幕上，必须清掉，否则不可见的行会被写进暂存。
 */
export interface LineSelectionScope {
  path: string;
  side: string;
  generation: number | null;
  mode: "unified" | "split";
  fullFile: boolean;
  hideWhitespaceOnly: boolean;
}

export function lineSelectionScope(scope: LineSelectionScope): string {
  return [
    scope.path,
    scope.side,
    scope.generation === null ? "-" : String(scope.generation),
    scope.mode,
    scope.fullFile ? "full" : "hunks",
    scope.hideWhitespaceOnly ? "hide-ws" : "all-ws",
  ].join("\u0000");
}

/** 已经贴在块头上的容差（行）。差一两个像素时「上一处」不应来回跳。 */
const HUNK_ALIGN = 0.35;

export const HUNK_NONE = "这里没有可跳转的改动块";
export const HUNK_FIRST = "已经是第一处改动";
export const HUNK_LAST = "已经是最后一处改动";

export interface HunkJump {
  /** 视口顶所在的块序号；还没到第一块时为 -1。 */
  current: number;
  total: number;
  prevReason: string | null;
  nextReason: string | null;
  /** 按下后应滚到的行；null 表示这一侧没有还能滚到的块。 */
  prevRow: number | null;
  nextRow: number | null;
}

/** 外壳与差异视图共用的跳转句柄：原因给命令面板，jump 在按下时再按当前滚动位置算。 */
export interface HunkNavReport {
  prevReason: string | null;
  nextReason: string | null;
  jump: (direction: -1 | 1) => void;
}

/** 视图行序列里每个改动块头的下标。统一视图传行 kind，并排视图传该行左侧（或右侧）单元格的 kind。 */
export function hunkRowIndexes(kinds: readonly (string | null | undefined)[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < kinds.length; index += 1) {
    if (kinds[index] === "hunk") indexes.push(index);
  }
  return indexes;
}

/**
 * 以视口顶为准决定上一处、下一处。
 *
 * 还没贴住当前块头时，「上一处」先回到这块的开头，而不是跳过它。
 * maxScroll 是内容超出视口的部分：再往下滚不动时，后面的块算已经到头，
 * 避免按钮一直可点、滚动位置却不变。还没量到视口高度时传 Infinity。
 */
export function hunkJump(
  indexes: readonly number[],
  scrollTop: number,
  rowHeight: number,
  maxScroll = Number.POSITIVE_INFINITY,
): HunkJump {
  if (indexes.length === 0 || !(rowHeight > 0)) {
    return { current: -1, total: 0, prevReason: HUNK_NONE, nextReason: HUNK_NONE, prevRow: null, nextRow: null };
  }
  const top = scrollTop / rowHeight;
  const limit = Number.isFinite(maxScroll) ? Math.max(0, maxScroll) / rowHeight : Number.POSITIVE_INFINITY;
  const canReach = (row: number) => Math.abs(Math.min(row, limit) - top) > HUNK_ALIGN;
  let current = -1;
  for (let index = 0; index < indexes.length; index += 1) {
    if (indexes[index] <= top + HUNK_ALIGN) current = index;
    else break;
  }
  const aligned = current >= 0 && indexes[current] >= top - HUNK_ALIGN;
  let prevRow: number | null = current < 0 ? null : aligned ? (current > 0 ? indexes[current - 1] : null) : indexes[current];
  let nextRow: number | null = null;
  for (const row of indexes) {
    if (row > top + HUNK_ALIGN) {
      nextRow = row;
      break;
    }
  }
  if (prevRow !== null && !canReach(prevRow)) prevRow = null;
  if (nextRow !== null && !canReach(nextRow)) nextRow = null;
  return {
    current,
    total: indexes.length,
    prevReason: prevRow === null ? HUNK_FIRST : null,
    nextReason: nextRow === null ? HUNK_LAST : null,
    prevRow,
    nextRow,
  };
}

/** 把 `@@ -68,6 +68,7 @@ fn name` 变成人能读的块标题：「第 68 行」+ 所在函数。 */
export function hunkCaption(text: string): { at: string; context: string } {
  const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/.exec(text);
  if (!match) return { at: text, context: "" };
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  // 新侧没有行（整段删除）时按旧侧行号描述。
  const removed = newCount === 0;
  const start = Number(removed ? match[1] : match[3]);
  const count = removed ? (match[2] === undefined ? 1 : Number(match[2])) : newCount;
  const prefix = removed ? "原" : "";
  const first = Math.max(start, 1);
  const at = count <= 1 ? `${prefix}第 ${first} 行` : `${prefix}第 ${first}–${first + count - 1} 行`;
  return { at, context: match[5].trim() };
}
