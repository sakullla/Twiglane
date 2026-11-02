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
  if (key === "ArrowDown") return Math.min(count - 1, current < 0 ? 0 : current + 1);
  if (key === "ArrowUp") return Math.max(0, current < 0 ? 0 : current - 1);
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
/** 标尺保留的候选行数：估算与真实字形有出入时，真正最长的行仍大概率在其中。 */
export const RULER_LINES = 12;
/** 标尺里每行实际排版的字符上限；超出部分按估算列数补宽，不把巨型行再排一遍。 */
export const RULER_SAMPLE_CHARS = 20_000;
/** 横向滚动宽度上限（列）：约 1400 万像素，低于浏览器约 3300 万像素的布局上限。 */
export const MAX_RULER_CELLS = 2_000_000;

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

/** 行的估算显示列数：全角记两列、tab 走到下一制表位、组合符不占列。只用来给行排序和估算超长行。 */
export function textCells(text: string, tabSize = CODE_TAB_SIZE): number {
  let cells = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 9) cells += tabSize - (cells % tabSize);
    else if (code < 0x300) cells += 1;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：表情和 CJK 扩展区都按全角算，低位不再单独计列。
      cells += 2;
      index += 1;
    } else if (isWideCode(code)) cells += 2;
    else if (code > 0x36f) cells += 1;
  }
  return cells;
}

export interface RulerLine {
  /** 交给隐藏标尺真实排版的文本。 */
  text: string;
  /** 被截掉部分的估算列数，由标尺用内边距补上。 */
  rest: number;
}

/**
 * 从全量行里挑出最长的几行，交给隐藏标尺按真实字体排版：横向滚动宽度来自浏览器实测，
 * 全角字符、回退字体和 tab 都算得准，也不随虚拟窗口变化。
 * 几万行时大多数行靠长度上界直接跳过，不逐字符计算。
 */
export function codeRuler(texts: Iterable<string>, keep = RULER_LINES): RulerLine[] {
  const top: { text: string; cells: number }[] = [];
  for (const text of texts) {
    const most = text.length * (text.includes("\t") ? CODE_TAB_SIZE : 2);
    if (top.length === keep && most <= top[top.length - 1].cells) continue;
    const cells = textCells(text);
    if (top.length === keep && cells <= top[top.length - 1].cells) continue;
    let at = top.length;
    while (at > 0 && top[at - 1].cells < cells) at -= 1;
    top.splice(at, 0, { text, cells });
    if (top.length > keep) top.pop();
  }
  return top.map(({ text, cells }) => {
    if (text.length <= RULER_SAMPLE_CHARS) return { text, rest: 0 };
    const sample = text.slice(0, RULER_SAMPLE_CHARS);
    return { text: sample, rest: Math.max(0, Math.min(cells, MAX_RULER_CELLS) - textCells(sample)) };
  });
}
