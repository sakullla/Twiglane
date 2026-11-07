/**
 * 审阅进度（R5）：只在当前应用会话内、按 canonical 仓库隔离保存 `path -> reviewToken`。
 *
 * 进度不写 state.json，也不参与 Cliora 结果：全部文件标为已审阅仍只是本地人工记录，
 * 返回 Cliora 时照旧按真实 Git 操作给出 reviewed / committed / merged。
 * token 来自后端 `repository_review_token`，代表标记那一刻的整文件快照；内容、暂存状态
 * 或删除等变化都会让旧 token 不再相同，从而自动失效。
 */
import { sameWorktreePath } from "./cliora-review.svelte";
import type { FileChange } from "./types";

export interface ReviewProgressState {
  /** 当前进度所属的 canonical 仓库路径；null 表示没有打开仓库。 */
  repoPath: string | null;
  /** 仓库相对路径 -> 标记时的整文件快照 token。 */
  tokens: Record<string, string>;
}

export const reviewProgress = $state<ReviewProgressState>({ repoPath: null, tokens: {} });

/**
 * 切换仓库时清空进度；同一个 worktree 的重新打开保留。
 * 返回是否真的清空了旧进度。
 */
export function beginReviewProgress(repoPath: string): boolean {
  const current = reviewProgress.repoPath;
  if (current && sameWorktreePath(current, repoPath)) {
    reviewProgress.repoPath = repoPath;
    return false;
  }
  const cleared = Object.keys(reviewProgress.tokens).length > 0;
  reviewProgress.repoPath = repoPath;
  reviewProgress.tokens = {};
  return cleared;
}

/** 关闭仓库或测试用：清空全部进度。 */
export function resetReviewProgress(): void {
  reviewProgress.repoPath = null;
  reviewProgress.tokens = {};
}

/** 当前改动路径去重后的列表：同一路径的 staged / unstaged 两侧只算一个文件。 */
export function reviewPaths(files: readonly FileChange[]): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const file of files) {
    if (known.has(file.path)) continue;
    known.add(file.path);
    seen.push(file.path);
  }
  return seen;
}

export function reviewTokenOf(path: string): string | null {
  return reviewProgress.tokens[path] ?? null;
}

export function isReviewed(path: string): boolean {
  return typeof reviewProgress.tokens[path] === "string";
}

/** 标记已审阅；只接受后端确认过的 token。 */
export function markReviewed(path: string, token: string): void {
  if (!token) return;
  reviewProgress.tokens = { ...reviewProgress.tokens, [path]: token };
}

export function unmarkReviewed(path: string): void {
  if (!(path in reviewProgress.tokens)) return;
  const next = { ...reviewProgress.tokens };
  delete next[path];
  reviewProgress.tokens = next;
}

/** 已审阅数与当前改动文件总数（按路径去重）。 */
export function reviewSummary(paths: readonly string[]): { total: number; reviewed: number } {
  let reviewed = 0;
  for (const path of paths) if (isReviewed(path)) reviewed += 1;
  return { total: paths.length, reviewed };
}

/** 丢弃已经不在改动集合里的标记；返回被移除的路径。 */
export function pruneReviewProgress(paths: readonly string[]): string[] {
  const alive = new Set(paths);
  const removed = Object.keys(reviewProgress.tokens).filter((path) => !alive.has(path));
  if (removed.length === 0) return [];
  const next = { ...reviewProgress.tokens };
  for (const path of removed) delete next[path];
  reviewProgress.tokens = next;
  return removed;
}

export interface ReviewInvalidation {
  path: string;
  reason: string;
}

/**
 * 刷新后的重验结果：token 相同保留标记，token 变化、路径消失或无法确认则移除。
 * 只应传入已标记路径的结果，其他文件既不查询也不受影响。
 */
export function applyReviewReverification(
  updates: readonly { path: string; token: string | null; reason?: string }[],
): ReviewInvalidation[] {
  const invalidations: ReviewInvalidation[] = [];
  const next = { ...reviewProgress.tokens };
  for (const update of updates) {
    const current = next[update.path];
    if (current === undefined) continue;
    if (update.token && update.token === current) continue;
    delete next[update.path];
    invalidations.push({
      path: update.path,
      reason: update.reason ?? (update.token ? "文件内容或改动已变化" : "无法确认文件快照"),
    });
  }
  if (invalidations.length > 0) reviewProgress.tokens = next;
  return invalidations;
}
