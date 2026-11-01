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
