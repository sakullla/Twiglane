export const MIN_PANEL_WIDTH = 160;
export const MAX_PANEL_WIDTH = 560;
export const FALLBACK_POLL_MS = 5000;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return MIN_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(value)));
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
