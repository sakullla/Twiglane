export const MIN_PANEL_WIDTH = 160;
export const MAX_PANEL_WIDTH = 560;
export const FALLBACK_POLL_MS = 5000;
/** 窗口变窄时主内容至少保留的宽度；900 宽窗口下左栏因此收紧到 340。 */
export const MIN_MAIN_WIDTH = 560;
/** 窗口再窄，左栏也不会被自动收到这个宽度以下；用户自己拖得更窄的宽度不受影响。 */
export const PANE_SQUEEZE_FLOOR = 240;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return MIN_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(value)));
}

/** 左栏渲染宽度：只按窗口收紧显示，不改写已保存的宽度（R14）。 */
export function fitPaneWidth(saved: number, windowWidth: number): number {
  return Math.min(saved, Math.max(PANE_SQUEEZE_FLOOR, windowWidth - MIN_MAIN_WIDTH));
}

export function nextIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown" || key === "j") return Math.min(count - 1, current < 0 ? 0 : current + 1);
  if (key === "ArrowUp" || key === "k") return Math.max(0, current < 0 ? 0 : current - 1);
  return null;
}

export function shouldPoll(degraded: boolean, focused: boolean, hasRepo: boolean): boolean {
  return degraded && focused && hasRepo;
}

export function nudgeWidth(current: number, key: string): number | null {
  if (key === "ArrowLeft") return clampWidth(current - 16);
  if (key === "ArrowRight") return clampWidth(current + 16);
  return null;
}

export function scrollIndexIntoView(
  index: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
): number {
  if (!Number.isFinite(index) || index < 0 || rowHeight <= 0) return Math.max(0, scrollTop);
  const top = index * rowHeight;
  if (!(viewport > 0)) return top;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return Math.max(0, bottom - viewport);
  return scrollTop;
}

export function scrollByRows(
  scrollTop: number,
  rowDelta: number,
  rowCount: number,
  viewport: number,
  rowHeight: number,
): number {
  if (rowCount <= 0 || rowHeight <= 0) return 0;
  const max = Math.max(0, rowCount * rowHeight - Math.max(0, viewport));
  const next = scrollTop + rowDelta * rowHeight;
  if (next <= 0) return 0;
  if (next >= max) return max;
  return next;
}

export function visibleRange(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan = 8,
): { start: number; end: number } {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  if (viewport <= 0) return { start: 0, end: Math.min(total, 40) };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(viewport / rowHeight) + overscan * 2;
  return { start, end: Math.min(total, start + count) };
}

/** 代码窗口的 tab 宽度，与 components.css 里滚动容器的 tab-size 一致。 */
export const CODE_TAB_SIZE = 4;
/** 标尺在每个宽度分量上保留的候选行数。 */
export const RULER_LINES = 8;
/** 标尺里每行实际排版的字符上限；超出部分按估算宽度补内边距，不把巨型行再排一遍。 */
export const RULER_SAMPLE_CHARS = 20_000;
/** 补宽上限（列）：不低于后端差异预览的 2 MiB（DIFF_PREVIEW_BYTES），又低于浏览器的布局上限。 */
export const MAX_RULER_CELLS = 2 * 1024 * 1024;
/** 全角字形约等于多少个半角：只用于给行排序，真实宽度由标尺排版和 ic 单位决定。 */
export const WIDE_CH = 5 / 3;

const NON_LATIN = /[^\u0000-\u02ff]/;

function isWideCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

export interface LineWidth {
  /** 半角部分的列数，tab 按制表位展开。 */
  narrow: number;
  /** 全角字符个数。 */
  wide: number;
  /** 其余字符的码元数（表情、组合符、非拉丁文字）：宽度取决于回退字体，单独成一个分量。 */
  other: number;
}

/** 把一行拆成宽度分量。各分量之间的比例由字体决定，这里不折算，避免把估算当真值。 */
export function lineWidth(text: string, tabSize = CODE_TAB_SIZE): LineWidth {
  let narrow = 0;
  let wide = 0;
  let other = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 9) {
      const column = narrow + other + Math.ceil(wide * WIDE_CH);
      narrow += tabSize - (column % tabSize);
    } else if (code < 0x300) narrow += 1;
    else if (isWideCode(code)) wide += 1;
    else other += 1;
  }
  return { narrow, wide, other };
}

export interface RulerLine {
  /** 交给隐藏标尺真实排版的文本。 */
  text: string;
  /** 被截掉部分的半角列数，由标尺用内边距补上。 */
  restCh: number;
  /** 被截掉部分的全角字数，用 ic（当前字体「水」字的宽度）补，不套用固定比例。 */
  restIc: number;
}

/** 标尺内联样式：只有被截断的行才需要补宽。 */
export function rulerPadding(line: RulerLine): string | undefined {
  return line.restCh || line.restIc ? `padding-right:calc(${line.restCh}ch + ${line.restIc}ic)` : undefined;
}

interface RulerEntry extends LineWidth {
  text: string;
  estimate: number;
}

function pushTop(top: RulerEntry[], entry: RulerEntry, value: (item: RulerEntry) => number, keep: number): void {
  const score = value(entry);
  if (score <= 0 || (top.length === keep && score <= value(top[top.length - 1]))) return;
  let at = top.length;
  while (at > 0 && value(top[at - 1]) < score) at -= 1;
  top.splice(at, 0, entry);
  if (top.length > keep) top.pop();
}

const ofNarrow = (item: RulerEntry) => item.narrow;
const ofWide = (item: RulerEntry) => item.wide;
const ofOther = (item: RulerEntry) => item.other;
const ofEstimate = (item: RulerEntry) => item.estimate;

/** 代码行的总规模（行数加字符数）：内容换了但最长的几行没变时，靠它识别。 */
export function codeContentSize(texts: readonly string[]): number {
  let size = texts.length;
  for (const text of texts) size += text.length;
  return size;
}

/**
 * 从全量行里挑候选，交给隐藏标尺按真实字体排版：横向滚动宽度来自浏览器实测。
 *
 * 行宽是各分量的加权和，权重取决于字体，所以不能只按一个估算值取前几名——几十行中文长行
 * 会把真实更宽的 ASCII 行挤出去。这里在每个分量和综合估算上分别取最长，任何比例下最宽的行
 * 基本都在其中；极端的混合行漏掉时，由 codeScroll 在它渲染后按实测宽度撑大标尺兜底。
 * 几万行时拉丁行靠长度上界直接跳过，不逐字符计算。
 */
export function codeRuler(texts: Iterable<string>, keep = RULER_LINES): RulerLine[] {
  const narrow: RulerEntry[] = [];
  const wide: RulerEntry[] = [];
  const other: RulerEntry[] = [];
  const estimate: RulerEntry[] = [];
  for (const text of texts) {
    if (!NON_LATIN.test(text)) {
      const most = text.length * (text.includes("\t") ? CODE_TAB_SIZE : 1);
      if (narrow.length === keep && estimate.length === keep && most <= narrow[keep - 1].narrow && most <= estimate[keep - 1].estimate) continue;
    }
    const width = lineWidth(text);
    const entry = { ...width, text, estimate: width.narrow + width.other + width.wide * WIDE_CH };
    pushTop(narrow, entry, ofNarrow, keep);
    pushTop(wide, entry, ofWide, keep);
    pushTop(other, entry, ofOther, keep);
    pushTop(estimate, entry, ofEstimate, keep);
  }
  const chosen = [...new Set([...estimate, ...narrow, ...wide, ...other])];
  return chosen.map((entry) => {
    if (entry.text.length <= RULER_SAMPLE_CHARS) return { text: entry.text, restCh: 0, restIc: 0 };
    const text = entry.text.slice(0, RULER_SAMPLE_CHARS);
    const sample = lineWidth(text);
    const sampleCh = sample.narrow + sample.other;
    return {
      text,
      restCh: Math.max(0, Math.min(entry.narrow + entry.other, MAX_RULER_CELLS) - sampleCh),
      restIc: Math.max(0, Math.min(entry.wide, MAX_RULER_CELLS) - sample.wide),
    };
  });
}
