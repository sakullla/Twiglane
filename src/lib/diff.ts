import type { DiffLine, DiffResponse } from "./types";
import type { WhitespaceIgnoreMode } from "./diff-prefs.svelte";

/** 「查看完整文件」请求的上下文行数：足够覆盖整份文件，与后端 FULL_FILE_CONTEXT 一致。 */
export const FULL_FILE_CONTEXT = 1_000_000;

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
  eol?: "crlf" | "cr";
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

export const LOCAL_DIFF_LINE_LIMIT = 50_000;
export const LOCAL_DIFF_CHAR_LIMIT = 2 * 1024 * 1024;
const LOCAL_DIFF_LINE_CHARS = 32 * 1024;

/** 只构造预算内的预览行，原始编辑文本始终由调用方保存。 */
function previewDiffLines(text: string): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let start = 0;
  let truncated = false;
  const budgetEnd = Math.min(text.length, LOCAL_DIFF_CHAR_LIMIT);
  const preview = text.slice(0, budgetEnd);
  while (start < budgetEnd && lines.length < LOCAL_DIFF_LINE_LIMIT) {
    const newline = preview.indexOf("\n", start);
    const end = newline < 0 ? budgetEnd : newline;
    const logicalEnd = newline >= 0 && end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    let keptEnd = Math.min(logicalEnd, budgetEnd, start + LOCAL_DIFF_LINE_CHARS);
    if (keptEnd < logicalEnd) truncated = true;
    const last = text.charCodeAt(keptEnd - 1);
    const next = text.charCodeAt(keptEnd);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) keptEnd -= 1;
    lines.push(text.slice(start, keptEnd));
    start = end + 1;
  }
  return { lines, truncated: truncated || budgetEnd < text.length || start < text.length };
}

const MYERS_MAX_D = 1600;

/**
 * Myers O((N+M)D) 文本行比对：在常见编辑下可毫秒级处理上万行且仅占 O(D) 内存；
 * 仅当两份文本几乎完全重写（编辑距离 > MYERS_MAX_D）时才退化为整块删除+新增。
 */
function myersDiffLines(oldMiddle: readonly string[], newMiddle: readonly string[]): TextLine[] {
  const n = oldMiddle.length;
  const m = newMiddle.length;
  if (n === 0) return newMiddle.map((text) => ({ kind: "add", text }));
  if (m === 0) return oldMiddle.map((text) => ({ kind: "del", text }));

  const maxD = Math.min(n + m, MYERS_MAX_D);
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= maxD; d += 1) {
    // 只拷贝当前步活跃区间 [-d..d]，把内存压到 O(D²/2) 且无嵌套对象开销。
    const snapshot = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldMiddle[x] === newMiddle[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      snapshot[k + d] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    trace.push(snapshot);
    if (foundD >= 0) break;
  }

  if (foundD < 0) {
    const fallback: TextLine[] = [];
    for (const text of oldMiddle) fallback.push({ kind: "del", text });
    for (const text of newMiddle) fallback.push({ kind: "add", text });
    return fallback;
  }

  const reversed: TextLine[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const k = x - y;
    const prevD = d - 1;
    let prevK: number;
    if (k === -d || (k !== d && prev[k - 1 + prevD] < prev[k + 1 + prevD])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[prevK + prevD];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ kind: "context", text: oldMiddle[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      reversed.push({ kind: "add", text: newMiddle[y - 1] });
      y -= 1;
    } else {
      reversed.push({ kind: "del", text: oldMiddle[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: "context", text: oldMiddle[x - 1] });
    x -= 1;
    y -= 1;
  }
  reversed.reverse();
  return reversed;
}

export function createTextDiff(path: string, before: string, after: string, generation = 0): DiffResponse {
  const oldPreview = previewDiffLines(before);
  const newPreview = previewDiffLines(after);
  const oldLines = oldPreview.lines;
  const newLines = newPreview.lines;
  const truncated = oldPreview.truncated || newPreview.truncated;
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
  const middle = myersDiffLines(oldMiddle, newMiddle);

  const numbered: DiffLine[] = new Array(prefix + middle.length + suffix);
  let cursor = 0;
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < prefix; i += 1) {
    oldNo += 1;
    newNo += 1;
    numbered[cursor++] = { kind: "context", text: ` ${oldLines[i]}`, oldNo, newNo, hunkIndex: null };
  }
  for (let i = 0; i < middle.length; i += 1) {
    const line = middle[i];
    if (line.kind === "del") {
      oldNo += 1;
      deletions += 1;
      numbered[cursor++] = { kind: "del", text: `-${line.text}`, oldNo, newNo: null, hunkIndex: null };
    } else if (line.kind === "add") {
      newNo += 1;
      additions += 1;
      numbered[cursor++] = { kind: "add", text: `+${line.text}`, oldNo: null, newNo, hunkIndex: null };
    } else {
      oldNo += 1;
      newNo += 1;
      numbered[cursor++] = { kind: "context", text: ` ${line.text}`, oldNo, newNo, hunkIndex: null };
    }
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    oldNo += 1;
    newNo += 1;
    numbered[cursor++] = { kind: "context", text: ` ${oldLines[i]}`, oldNo, newNo, hunkIndex: null };
  }

  const changed = additions > 0 || deletions > 0;
  const lines: DiffLine[] = [];
  if (!changed) {
    for (const line of numbered) lines.push(line);
  } else {
    // O(N) 线性上下文窗口标记，避免逐行 slice 分配临时数组。
    const included = new Uint8Array(numbered.length);
    for (let i = 0; i < numbered.length; i += 1) {
      if (numbered[i].kind === "context") continue;
      const from = Math.max(0, i - 3);
      const to = Math.min(numbered.length - 1, i + 3);
      for (let j = from; j <= to; j += 1) included[j] = 1;
    }
    let index = 0;
    while (index < numbered.length) {
      if (!included[index]) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < numbered.length && included[index]) index += 1;
      let oldStart = 1;
      let newStart = 1;
      for (let j = start; j < index; j += 1) {
        if (numbered[j].oldNo !== null) {
          oldStart = numbered[j].oldNo as number;
          break;
        }
      }
      for (let j = start; j < index; j += 1) {
        if (numbered[j].newNo !== null) {
          newStart = numbered[j].newNo as number;
          break;
        }
      }
      lines.push({ kind: "hunk", text: `@@ -${oldStart} +${newStart} @@`, oldNo: null, newNo: null, hunkIndex: null });
      for (let j = start; j < index; j += 1) lines.push(numbered[j]);
    }
  }

  return {
    generation,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: truncated
      ? `文本超过预览上限，仅显示部分内容：新增约 ${additions} 行，删除约 ${deletions} 行。原始文本未修改。`
      : `新增 ${additions} 行，删除 ${deletions} 行。`,
    additions,
    deletions,
    complete: !truncated,
    truncated,
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

export function whitespaceOnlyHunks(
  lines: readonly { kind: string; text: string; hunkIndex: number | null }[],
): WhitespaceFilter {
  return filterDiffHunks(lines, { whitespaceMode: "all", ignoreBlankLines: false, ignoreCase: false });
}

export interface DiffFilterRules {
  whitespaceMode: WhitespaceIgnoreMode;
  ignoreBlankLines: boolean;
  ignoreCase: boolean;
}

function normalizeForRule(text: string, rules: DiffFilterRules): string {
  let value = contentOf(text);
  switch (rules.whitespaceMode) {
    case "all":
      value = value.replace(/[ \t\r\n\f\v]+/g, "");
      break;
    case "change":
      value = value.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, "");
      break;
    case "trailing":
      value = value.replace(/[ \t]+$/, "");
      break;
    case "eol":
    case "none":
      break;
  }
  if (rules.ignoreCase) value = value.toLowerCase();
  return value;
}

/**
 * 按比对规则做只读块级过滤（支持 CRLF↔LF、行尾空白、空白数量变化、所有空白、纯空行、大小写）。
 * 绝不改写原始行、hunkIndex、snapshot 或暂存补丁；仅隐藏完全满足规则的整块。
 */
export function filterDiffHunks(
  lines: readonly { kind: string; text: string; hunkIndex: number | null; eol?: "crlf" | "cr" }[],
  rules: DiffFilterRules,
): WhitespaceFilter {
  const active = rules.whitespaceMode !== "none" || rules.ignoreBlankLines || rules.ignoreCase;
  if (!active) return { hunks: new Set<number>(), lines: 0 };

  const order: number[] = [];
  const dels = new Map<number, string[]>();
  const adds = new Map<number, string[]>();
  const counts = new Map<number, number>();
  for (const line of lines) {
    if (line.hunkIndex === null) continue;
    if (line.kind !== "add" && line.kind !== "del") continue;
    if (!dels.has(line.hunkIndex)) {
      dels.set(line.hunkIndex, []);
      adds.set(line.hunkIndex, []);
      counts.set(line.hunkIndex, 0);
      order.push(line.hunkIndex);
    }
    counts.set(line.hunkIndex, (counts.get(line.hunkIndex) ?? 0) + 1);
    const body = contentOf(line.text);
    if (rules.ignoreBlankLines && body.trim().length === 0) continue;
    const bucket = line.kind === "del" ? dels : adds;
    let normalized = normalizeForRule(line.text, rules);
    // 未开启忽略换行符/空白时，保留行尾身份，避免仅开启「忽略空行/大小写」时误把 CRLF↔LF 块藏掉。
    if (rules.whitespaceMode === "none") normalized += `\u0000${line.eol ?? "lf"}`;
    bucket.get(line.hunkIndex)?.push(normalized);
  }

  const hunks = new Set<number>();
  let totalHidden = 0;
  for (const index of order) {
    const left = dels.get(index) ?? [];
    const right = adds.get(index) ?? [];
    const rawCount = counts.get(index) ?? 0;
    if (rawCount === 0) continue;
    if (left.length === 0 && right.length === 0) {
      // 仅当开启「忽略纯空行」时，删增全是空行才算可隐藏。
      if (rules.ignoreBlankLines) {
        hunks.add(index);
        totalHidden += rawCount;
      }
      continue;
    }
    if (left.length !== right.length) continue;
    if (!left.every((text, at) => text === right[at])) continue;
    hunks.add(index);
    totalHidden += rawCount;
  }
  return { hunks, lines: totalHidden };
}

/** 差异里的特殊规则诊断：换行符变化（CRLF/LF/CR/混合）、BOM 变化、纯换行符块数。 */
export interface DiffSpecialSummary {
  /** 换行符变化说明，例如「LF → CRLF」「CRLF → LF」「混合换行符」；无变化时为 null。 */
  eolLabel: string | null;
  /** 仅换行符不同的改动块数量。 */
  eolOnlyHunks: number;
  /** 是否存在 UTF-8 BOM（\uFEFF）的增删变化。 */
  bomChanged: boolean;
}

const EOL_LF = 1;
const EOL_CRLF = 2;
const EOL_CR = 4;

function eolName(mask: number): string | null {
  if (mask === 0) return null;
  if (mask === EOL_LF) return "LF";
  if (mask === EOL_CRLF) return "CRLF";
  if (mask === EOL_CR) return "CR";
  return "混合";
}

export function analyzeDiffSpecials(
  lines: readonly { kind: string; text: string; hunkIndex: number | null; eol?: "crlf" | "cr" }[],
): DiffSpecialSummary {
  let oldMask = 0;
  let newMask = 0;
  let oldBom = false;
  let newBom = false;

  for (const line of lines) {
    if (line.kind !== "add" && line.kind !== "del" && line.kind !== "context") continue;
    const bit = line.eol === "crlf" ? EOL_CRLF : line.eol === "cr" ? EOL_CR : EOL_LF;
    const body = contentOf(line.text);
    const hasBom = body.charCodeAt(0) === 0xfeff;
    if (line.kind === "del") {
      oldMask |= bit;
      if (hasBom) oldBom = true;
    } else if (line.kind === "add") {
      newMask |= bit;
      if (hasBom) newBom = true;
    } else {
      oldMask |= bit;
      newMask |= bit;
    }
  }

  let eolLabel: string | null = null;
  const oldName = eolName(oldMask);
  const newName = eolName(newMask);
  if (oldName && newName && oldMask !== newMask) {
    eolLabel = `${oldName} → ${newName}`;
  } else if (newName === "混合") {
    eolLabel = "混合换行符";
  }

  const eolOnly = filterDiffHunks(lines, { whitespaceMode: "eol", ignoreBlankLines: false, ignoreCase: false });
  return {
    eolLabel,
    eolOnlyHunks: eolOnly.hunks.size,
    bomChanged: oldBom !== newBom,
  };
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
  filterKey?: string;
}

export function lineSelectionScope(scope: LineSelectionScope): string {
  return [
    scope.path,
    scope.side,
    scope.generation === null ? "-" : String(scope.generation),
    scope.mode,
    scope.fullFile ? "full" : "hunks",
    scope.hideWhitespaceOnly ? "hide-ws" : "all-ws",
    ...(scope.filterKey ? [scope.filterKey] : []),
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
 * 完整文件视图里整份文件只有一个块，按块跳转只会回到开头。这里改按「连续的新增/删除行」分段：
 * 每段的起点往上留 lead 行上下文作为跳转目标，升序、去重。changed[i] 表示第 i 行是改动行。
 */
export function changeRunIndexes(changed: readonly boolean[], lead = 0): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < changed.length; index += 1) {
    if (!changed[index] || (index > 0 && changed[index - 1])) continue;
    const target = Math.max(0, index - lead);
    if (indexes.length === 0 || target > indexes[indexes.length - 1]) indexes.push(target);
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
