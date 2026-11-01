/**
 * 冲突标记解析与逐处合并（纯函数，不碰 DOM，也不调用后端）。
 *
 * 数据来源是工作区里那份带冲突标记的文件（ConflictView.result.text）：它就是 Git 合并后
 * 留下的结果，已经包含 Git 自动合并好的部分；只有被 `<<<<<<<` / `=======` / `>>>>>>>`
 * 包住的区域才需要人来决定。`|||||||` 段（merge.conflictStyle=diff3/zdiff3）会被识别为
 * 共同祖先。
 *
 * 设计约束：
 * - 逐行保留原始行尾（LF/CRLF 混用也不改动未处理的行），不选任何一处时 compose 必须
 *   与原文逐字节一致；
 * - 几万行的文件只做 O(n) 的切分；行对齐只在单个冲突块内做，且有上限；
 * - 标记残缺（未闭合、嵌套）时不猜，返回 malformed，由界面回退到整文件编辑。
 */

export type ConflictChoice = "ours" | "theirs" | "ours-theirs" | "theirs-ours" | "base" | "none" | "custom";

export interface ConflictResolution {
  choice: ConflictChoice;
  /** choice === "custom" 时的结果行（不含行尾）。 */
  lines?: string[];
}

export interface ConflictHunk {
  index: number;
  /** 各侧原始行（含行尾），不含标记行。 */
  ours: string[];
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  baseLabel: string;
  theirsLabel: string;
  /** 整块原文（含标记行与行尾），未处理时原样写回。 */
  raw: string[];
  /** 起始标记在原文中的行号（0 起）。 */
  startLine: number;
}

export type ConflictSegment =
  | { kind: "common"; lines: string[]; start: number }
  | { kind: "conflict"; hunk: ConflictHunk };

export interface ParsedConflictFile {
  eol: "\n" | "\r\n";
  segments: ConflictSegment[];
  hunks: ConflictHunk[];
  totalLines: number;
  /** 标记残缺（未闭合或嵌套）：不能逐处处理，只能整文件编辑。 */
  malformed: boolean;
}

export type ConflictResolutions = Record<number, ConflictResolution>;

const MARKER = 7;

/** 按行切分并保留每行自己的行尾。末尾没有换行的最后一行同样保留。 */
export function splitRawLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** 去掉行尾（\n 或 \r\n）。 */
export function stripEol(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

function markerLabel(line: string, char: string): string | null {
  const text = stripEol(line);
  if (text.length < MARKER) return null;
  for (let index = 0; index < MARKER; index += 1) if (text[index] !== char) return null;
  if (text.length === MARKER) return "";
  // 第 8 个字符必须是空白：`<<<<<<<<` 这类更长的串不是本层标记（嵌套冲突或正文）。
  if (text[MARKER] !== " " && text[MARKER] !== "\t") return null;
  return text.slice(MARKER + 1).trim();
}

function isSeparator(line: string): boolean {
  const text = stripEol(line);
  return text === "=======" || (text.startsWith("======= ") && text.length > MARKER);
}

function dominantEol(lines: string[]): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (const line of lines) {
    if (line.endsWith("\r\n")) crlf += 1;
    else if (line.endsWith("\n")) lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function parseConflictText(text: string): ParsedConflictFile {
  const lines = splitRawLines(text);
  const eol = dominantEol(lines);
  const segments: ConflictSegment[] = [];
  const hunks: ConflictHunk[] = [];
  let common: string[] = [];
  let commonStart = 0;
  let index = 0;
  const malformed = (): ParsedConflictFile => ({
    eol,
    segments: [{ kind: "common", lines, start: 0 }],
    hunks: [],
    totalLines: lines.length,
    malformed: true,
  });

  while (index < lines.length) {
    const open = markerLabel(lines[index], "<");
    if (open === null) {
      if (common.length === 0) commonStart = index;
      common.push(lines[index]);
      index += 1;
      continue;
    }
    const startLine = index;
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let baseLabel = "";
    let section: "ours" | "base" | "theirs" = "ours";
    let theirsLabel: string | null = null;
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (markerLabel(line, "<") !== null) return malformed();
      if (section !== "theirs") {
        const baseMark = markerLabel(line, "|");
        if (baseMark !== null && section === "ours") {
          section = "base";
          base = [];
          baseLabel = baseMark;
          index += 1;
          continue;
        }
        if (isSeparator(line)) {
          section = "theirs";
          index += 1;
          continue;
        }
      } else {
        const close = markerLabel(line, ">");
        if (close !== null) {
          theirsLabel = close;
          index += 1;
          break;
        }
      }
      if (section === "ours") ours.push(line);
      else if (section === "base") base?.push(line);
      else theirs.push(line);
      index += 1;
    }
    if (theirsLabel === null) return malformed();
    if (common.length > 0) {
      segments.push({ kind: "common", lines: common, start: commonStart });
      common = [];
    }
    const hunk: ConflictHunk = {
      index: hunks.length,
      ours,
      base,
      theirs,
      oursLabel: open,
      baseLabel,
      theirsLabel,
      raw: lines.slice(startLine, index),
      startLine,
    };
    hunks.push(hunk);
    segments.push({ kind: "conflict", hunk });
  }
  if (common.length > 0) segments.push({ kind: "common", lines: common, start: commonStart });
  return { eol, segments, hunks, totalLines: lines.length, malformed: false };
}

/** 把可能缺行尾的最后一行补上行尾，避免两段拼接时粘成一行。 */
function terminated(lines: string[], eol: string): string[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1];
  if (last.endsWith("\n")) return lines;
  return [...lines.slice(0, -1), `${last}${eol}`];
}

/** 一处冲突在给定选择下的原始结果行（含行尾）。 */
export function resolvedRawLines(hunk: ConflictHunk, resolution: ConflictResolution, eol: "\n" | "\r\n"): string[] {
  switch (resolution.choice) {
    case "ours":
      return hunk.ours;
    case "theirs":
      return hunk.theirs;
    case "base":
      return hunk.base ?? [];
    case "none":
      return [];
    case "ours-theirs":
      return [...terminated(hunk.ours, eol), ...hunk.theirs];
    case "theirs-ours":
      return [...terminated(hunk.theirs, eol), ...hunk.ours];
    case "custom":
      return (resolution.lines ?? []).map((line) => `${line}${eol}`);
  }
}

/** 一处冲突在给定选择下的显示行（不含行尾）。 */
export function resolvedLines(hunk: ConflictHunk, resolution: ConflictResolution): string[] {
  if (resolution.choice === "custom") return resolution.lines ?? [];
  return resolvedRawLines(hunk, resolution, "\n").map(stripEol);
}

/** 组合最终文本：未处理的冲突原样保留标记。不做任何选择时与原文逐字节一致。 */
export function composeConflictText(parsed: ParsedConflictFile, resolutions: ConflictResolutions): string {
  const out: string[] = [];
  for (const segment of parsed.segments) {
    if (segment.kind === "common") {
      out.push(...segment.lines);
      continue;
    }
    const resolution = resolutions[segment.hunk.index];
    out.push(...(resolution ? resolvedRawLines(segment.hunk, resolution, parsed.eol) : segment.hunk.raw));
  }
  return out.join("");
}

export function unresolvedCount(parsed: ParsedConflictFile, resolutions: ConflictResolutions): number {
  return parsed.hunks.filter((hunk) => !resolutions[hunk.index]).length;
}

/** 文本里是否还残留本层冲突标记（起始或结束标记任一即算）。 */
export function hasConflictMarkers(text: string): boolean {
  for (const line of splitRawLines(text)) {
    if (markerLabel(line, "<") !== null || markerLabel(line, ">") !== null) return true;
  }
  return false;
}

function joined(lines: string[]): string {
  return lines.map(stripEol).join("\n");
}

function squashed(lines: string[]): string {
  return joined(lines).replace(/\s+/g, "");
}

export type HunkHint = "identical" | "ours-unchanged" | "theirs-unchanged" | "whitespace" | null;

/**
 * 简单冲突的判定（参照 JetBrains「解决简单冲突」）：两侧完全相同、或有共同祖先且一侧
 * 没有改动时，结论是确定的；仅空白不同只给提示，不自动处理——缩进对某些语言有语义。
 */
export function hunkHint(hunk: ConflictHunk): HunkHint {
  const ours = joined(hunk.ours);
  const theirs = joined(hunk.theirs);
  if (ours === theirs) return "identical";
  if (hunk.base) {
    const base = joined(hunk.base);
    if (ours === base) return "ours-unchanged";
    if (theirs === base) return "theirs-unchanged";
  }
  if (squashed(hunk.ours) === squashed(hunk.theirs)) return "whitespace";
  return null;
}

/** 可确定自动处理的选择；不确定时返回 null。 */
export function simpleResolution(hunk: ConflictHunk): ConflictResolution | null {
  switch (hunkHint(hunk)) {
    case "identical":
      return { choice: "ours" };
    case "ours-unchanged":
      return { choice: "theirs" };
    case "theirs-unchanged":
      return { choice: "ours" };
    default:
      return null;
  }
}

export interface AlignedRow {
  ours: number | null;
  theirs: number | null;
  same: boolean;
}

/** 单块内 LCS 对齐的上限：超过时按行号成对排列，保证几千行的冲突块也不卡。 */
const ALIGN_LIMIT = 90_000;

/** 在一处冲突内把当前与来源两侧按行对齐，相同行并排、不同行成对。 */
export function alignHunk(ours: string[], theirs: string[]): AlignedRow[] {
  const a = ours.map(stripEol);
  const b = theirs.map(stripEol);
  const rows: AlignedRow[] = [];
  const pair = (fromA: number, toA: number, fromB: number, toB: number) => {
    const span = Math.max(toA - fromA, toB - fromB);
    for (let offset = 0; offset < span; offset += 1) {
      const i = fromA + offset < toA ? fromA + offset : null;
      const j = fromB + offset < toB ? fromB + offset : null;
      rows.push({ ours: i, theirs: j, same: false });
    }
  };
  if (a.length * b.length > ALIGN_LIMIT || a.length === 0 || b.length === 0) {
    const span = Math.max(a.length, b.length);
    for (let offset = 0; offset < span; offset += 1) {
      const i = offset < a.length ? offset : null;
      const j = offset < b.length ? offset : null;
      rows.push({ ours: i, theirs: j, same: i !== null && j !== null && a[i] === b[j] });
    }
    return rows;
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let pendingA = 0;
  let pendingB = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pair(pendingA, i, pendingB, j);
      rows.push({ ours: i, theirs: j, same: true });
      i += 1;
      j += 1;
      pendingA = i;
      pendingB = j;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  pair(pendingA, a.length, pendingB, b.length);
  return rows;
}

/** 行内差异：公共前后缀之外的中段，用于在成对的两行里高亮真正不同的字符。 */
export function inlineRange(a: string, b: string): { a: [number, number]; b: [number, number] } | null {
  if (a === b) return null;
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return { a: [prefix, a.length - suffix], b: [prefix, b.length - suffix] };
}

export function choiceLabel(choice: ConflictChoice): string {
  switch (choice) {
    case "ours":
      return "采用当前";
    case "theirs":
      return "采用来源";
    case "ours-theirs":
      return "当前在前，保留两者";
    case "theirs-ours":
      return "来源在前，保留两者";
    case "base":
      return "采用共同祖先";
    case "none":
      return "两侧都不保留";
    case "custom":
      return "手动编辑";
  }
}

export function hintLabel(hint: HunkHint): string {
  switch (hint) {
    case "identical":
      return "两侧相同";
    case "ours-unchanged":
      return "当前未改动";
    case "theirs-unchanged":
      return "来源未改动";
    case "whitespace":
      return "仅空白不同";
    default:
      return "";
  }
}

/** 每个文件的处理进度草稿：切换文件再回来时恢复（仅当工作区内容未变时）。 */
export interface ConflictDraft {
  /** 打开时读到的原始结果（用于校验草稿是否仍然适用）。 */
  original: string;
  /** 逐处处理所基于的文本；整文件编辑后会替换为编辑后的文本。 */
  base: string;
  resolutions: ConflictResolutions;
  /** 整文件编辑中的文本；null 表示不在整文件模式。 */
  whole: string | null;
}
