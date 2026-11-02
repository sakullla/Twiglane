/**
 * 整文件三栏的行级比较：结果栏每一行来自哪一侧，以及三栏滚动时的对应关系。
 *
 * 只读文本、只产出标记，绝不改写文本和行尾。比较时忽略行尾（CRLF 与 LF 算同一行），
 * 因为 textarea 读回来的值总是 LF，否则一个 CRLF 文件整份都会被标成手动编辑。
 *
 * 对齐用 patience 思路：先去掉首尾相同的行，再以两边都只出现一次的行作锚点切段，
 * 小段用 LCS 补齐。工作量有预算，重复行极多的文件也不会退化；预算用完后未对齐的行
 * 退回按「这一行在哪一侧出现过」判断，标记仍然可信，只是不再逐行精确。
 */

/** 超过任一上限时关闭标记，滚动退回按比例联动。 */
export const MARK_LINE_LIMIT = 100_000;
export const MARK_CHAR_LIMIT = 8 * 1024 * 1024;

export type MarkKind = "same" | "ours" | "theirs" | "manual" | "marker";

/** kinds 数组里的取值：same 为 0，新建的 Uint8Array 天然是「两侧相同」。 */
const KIND_CODES: readonly MarkKind[] = ["same", "ours", "theirs", "manual", "marker"];
const SAME = 0;
const OURS = 1;
const THEIRS = 2;
const MANUAL = 3;
const MARKER = 4;

/** 连续同类的行，[from, to) 是结果栏的行下标。两侧相同的行不产生区段。 */
export interface MarkRun {
  kind: Exclude<MarkKind, "same">;
  from: number;
  to: number;
}

/** 结果栏行号与一侧行号的单调对应点，含首尾哨兵，两列等长。 */
export interface LineAnchors {
  result: number[];
  side: number[];
}

export interface ThreeWayMarks {
  lines: number;
  kinds: Uint8Array;
  runs: MarkRun[];
  ours: LineAnchors;
  theirs: LineAnchors;
}

const LCS_CELL_LIMIT = 250_000;
const LCS_TOTAL_LIMIT = 40_000_000;

/** 按行切开并去掉行尾；末尾换行不算新的一行。 */
export function splitMarkLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.charCodeAt(line.length - 1) === 13) lines[index] = line.slice(0, -1);
  }
  return lines;
}

function countLines(text: string): number {
  let count = text.length > 0 && !text.endsWith("\n") ? 1 : 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

/** 三份文本里任一份超过上限时不做标记。 */
export function exceedsMarkLimit(...texts: string[]): boolean {
  return texts.some((text) => text.length > MARK_CHAR_LIMIT || countLines(text) > MARK_LINE_LIMIT);
}

function isConflictMarker(line: string): boolean {
  return /^(?:<{7}|\|{7}|={7}|>{7})(?:\s|$)/.test(line);
}

/** 区间内两边都只出现一次的行，取最长递增子序列作为切分锚点（patience）。 */
function uniqueAnchors(a: Int32Array, al: number, ah: number, b: Int32Array, bl: number, bh: number): [number, number][] {
  const inA = new Map<number, number>();
  for (let index = al; index < ah; index += 1) inA.set(a[index], inA.has(a[index]) ? -1 : index);
  const inB = new Map<number, number>();
  for (let index = bl; index < bh; index += 1) if (inA.has(b[index])) inB.set(b[index], inB.has(b[index]) ? -1 : index);

  const candidates: [number, number][] = [];
  for (let index = al; index < ah; index += 1) {
    const at = inA.get(a[index]);
    const other = inB.get(a[index]);
    if (at === index && other !== undefined && other >= 0) candidates.push([index, other]);
  }

  const tails: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  candidates.forEach(([, other], index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]][1] < other) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[index] = tails[lo - 1];
    tails[lo] = index;
  });

  const anchors: [number, number][] = [];
  for (let at = tails.length > 0 ? tails[tails.length - 1] : -1; at !== -1; at = previous[at]) anchors.push(candidates[at]);
  return anchors.reverse();
}

function lcs(a: Int32Array, al: number, ah: number, b: Int32Array, bl: number, bh: number, match: Int32Array): void {
  const rows = ah - al;
  const cols = bh - bl;
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row * width + col] =
        a[al + row] === b[bl + col]
          ? table[(row + 1) * width + col + 1] + 1
          : Math.max(table[(row + 1) * width + col], table[row * width + col + 1]);
    }
  }
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (a[al + row] === b[bl + col]) {
      match[al + row] = bl + col;
      row += 1;
      col += 1;
    } else if (table[(row + 1) * width + col] >= table[row * width + col + 1]) {
      row += 1;
    } else {
      col += 1;
    }
  }
}

/** 返回 a 每一行对应的 b 行下标，未对齐为 -1；对应关系严格单调。 */
function alignLines(a: Int32Array, b: Int32Array): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  let budget = (a.length + b.length) * 24 + 4096;
  let cells = LCS_TOTAL_LIMIT;
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    let [al, ah, bl, bh] = stack.pop() as [number, number, number, number];
    while (al < ah && bl < bh && a[al] === b[bl]) match[al++] = bl++;
    while (al < ah && bl < bh && a[ah - 1] === b[bh - 1]) match[--ah] = --bh;
    if (al === ah || bl === bh) continue;
    const size = (ah - al) * (bh - bl);
    if (size <= LCS_CELL_LIMIT && size <= cells) {
      cells -= size;
      lcs(a, al, ah, b, bl, bh, match);
      continue;
    }
    if (budget <= 0) continue;
    budget -= ah - al + (bh - bl);
    let fromA = al;
    let fromB = bl;
    for (const [atA, atB] of uniqueAnchors(a, al, ah, b, bl, bh)) {
      match[atA] = atB;
      if (atA > fromA && atB > fromB) stack.push([fromA, atA, fromB, atB]);
      fromA = atA + 1;
      fromB = atB + 1;
    }
    // 没有任何锚点时整段留空：下面按行内容判断来源，滚动按首尾哨兵插值。
    if (fromA > al && ah > fromA && bh > fromB) stack.push([fromA, ah, fromB, bh]);
  }
  return match;
}

/** 只留每段连续对应的首尾，几万行的文件也只有几对点。 */
function anchorsOf(match: Int32Array, sideLines: number): LineAnchors {
  const result = [0];
  const side = [0];
  const push = (r: number, s: number) => {
    if (result[result.length - 1] === r && side[side.length - 1] === s) return;
    result.push(r);
    side.push(s);
  };
  let index = 0;
  while (index < match.length) {
    if (match[index] < 0) {
      index += 1;
      continue;
    }
    const start = index;
    while (index + 1 < match.length && match[index + 1] === match[index] + 1) index += 1;
    push(start, match[start]);
    push(index + 1, match[index] + 1);
    index += 1;
  }
  push(match.length, sideLines);
  return { result, side };
}

/**
 * 计算结果栏的来源标记。行的判定顺序：
 * 同时对齐到两侧是两侧相同，只对齐到一侧就是那一侧；都没对齐时看内容在哪一侧出现过
 * （被挪动的行仍算来源），哪边都没有的才是手动编辑。冲突标记行单独成类，它不是用户写的内容。
 */
export function computeMarks(resultText: string, oursText: string, theirsText: string): ThreeWayMarks {
  const result = splitMarkLines(resultText);
  const ours = splitMarkLines(oursText);
  const theirs = splitMarkLines(theirsText);

  const ids = new Map<string, number>();
  const intern = (lines: string[]) => {
    const out = new Int32Array(lines.length);
    for (let index = 0; index < lines.length; index += 1) {
      let id = ids.get(lines[index]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[index], id);
      }
      out[index] = id;
    }
    return out;
  };
  const resultIds = intern(result);
  const oursIds = intern(ours);
  const theirsIds = intern(theirs);
  const seen = new Uint8Array(ids.size);
  for (const id of oursIds) seen[id] |= 1;
  for (const id of theirsIds) seen[id] |= 2;

  const toOurs = alignLines(resultIds, oursIds);
  const toTheirs = alignLines(resultIds, theirsIds);

  const kinds = new Uint8Array(result.length);
  const runs: MarkRun[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const inOurs = toOurs[index] >= 0;
    const inTheirs = toTheirs[index] >= 0;
    let code: number;
    if (inOurs || inTheirs) {
      code = inOurs && inTheirs ? SAME : inOurs ? OURS : THEIRS;
    } else {
      const found = seen[resultIds[index]];
      if (found === 3) code = SAME;
      else if (found === 1) code = OURS;
      else if (found === 2) code = THEIRS;
      else code = isConflictMarker(result[index]) ? MARKER : MANUAL;
    }
    kinds[index] = code;
    if (code === SAME) continue;
    const kind = KIND_CODES[code] as MarkRun["kind"];
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && last.to === index) last.to = index + 1;
    else runs.push({ kind, from: index, to: index + 1 });
  }

  return {
    lines: result.length,
    kinds,
    runs,
    ours: anchorsOf(toOurs, ours.length),
    theirs: anchorsOf(toTheirs, theirs.length),
  };
}

export function markKindAt(marks: ThreeWayMarks, line: number): MarkKind {
  return KIND_CODES[marks.kinds[line] ?? SAME];
}

/** 取与 [first, last] 行有交集的区段，滚动时只画视口附近。 */
export function runsInRange(runs: readonly MarkRun[], first: number, last: number): MarkRun[] {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].to <= first) lo = mid + 1;
    else hi = mid;
  }
  const out: MarkRun[] = [];
  for (let index = lo; index < runs.length && runs[index].from <= last; index += 1) out.push(runs[index]);
  return out;
}

/** 在单调对应点上按行号（可带小数）插值；from 与 to 等长。 */
export function mapLine(from: readonly number[], to: readonly number[], line: number): number {
  const end = from.length - 1;
  if (end < 0) return 0;
  if (line <= from[0]) return to[0];
  if (line >= from[end]) return to[end];
  let lo = 0;
  let hi = end;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (from[mid] <= line) lo = mid;
    else hi = mid;
  }
  const span = from[hi] - from[lo];
  return span === 0 ? to[hi] : to[lo] + ((to[hi] - to[lo]) * (line - from[lo])) / span;
}
