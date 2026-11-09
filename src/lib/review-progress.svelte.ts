/**
 * 审阅进度（R2）：会话内按 canonical worktree 与审阅范围隔离保存 `path -> reviewToken`。
 *
 * 范围有两种身份：
 * - `changes`：当前未提交的改动（HEAD / 索引 / 工作区）；
 * - `task:<baseline oid>`：一次任务从明确起点到工作区的最终净结果。
 *
 * 同一路径在不同范围里是两条独立记录：任务范围里的标记不会替改动范围作证，反之亦然。
 * 切换 worktree 不再销毁其他 worktree 的记录——重新进入时只显示并复验对应范围。
 *
 * 进度不写 state.json，也不参与 Cliora 结果：全部文件标为已审阅仍只是本地人工记录，
 * 返回 Cliora 时照旧按真实 Git 操作给出 reviewed / committed / merged。
 * token 来自后端（`repository_review_token` 或 `task_review_token`），代表标记那一刻的
 * 整文件快照；内容、暂存状态或删除等变化都会让旧 token 不再相同，从而自动失效。
 */
import { sameWorktreePath } from "./cliora-review.svelte";
import type { FileChange } from "./types";

/** 未提交改动这一侧的固定范围身份。 */
export const CHANGES_SCOPE = "changes";

/** 任务范围身份：绑定后端的完整起点提交标识，不同起点不共享进度。 */
export function taskReviewScope(baselineOid: string): string {
  return `task:${baselineOid}`;
}

/** 一条进度记录指向的范围：canonical worktree + 范围身份。 */
export interface ReviewTarget {
  worktree: string;
  scope: string;
}

interface ScopeRecord {
  tokens: Record<string, string>;
}

interface WorktreeRecord {
  path: string;
  scopes: Record<string, ScopeRecord>;
  updatedAtMs: number;
}

export interface ReviewProgressState {
  /** 当前打开的 canonical worktree；null 表示没有打开仓库。 */
  worktree: string | null;
  /** 本次会话所有 worktree 的记录；切换 worktree 不会清掉别人的。 */
  worktrees: Record<string, WorktreeRecord>;
}

const EMPTY: Record<string, string> = Object.freeze({}) as Record<string, string>;

export const reviewProgress = $state<ReviewProgressState>({ worktree: null, worktrees: {} });

/** Windows 上大小写与分隔符都不参与判定：同一个 worktree 只有一条记录。 */
function keyOf(worktree: string): string {
  const known = Object.keys(reviewProgress.worktrees).find((key) => sameWorktreePath(key, worktree));
  return known ?? worktree.trim();
}

function recordOf(target: ReviewTarget): WorktreeRecord | null {
  const key = keyOf(target.worktree);
  return reviewProgress.worktrees[key] ?? null;
}

/** 标记与清理都走这里：只替换受影响的 worktree / 范围，其他记录原样保留。 */
function writeTokens(
  target: ReviewTarget,
  mutate: (current: Record<string, string>) => Record<string, string> | null,
): void {
  const key = keyOf(target.worktree);
  const existing = reviewProgress.worktrees[key];
  const current = existing?.scopes[target.scope]?.tokens ?? EMPTY;
  const next = mutate(current);
  if (next === null) return;
  reviewProgress.worktrees = {
    ...reviewProgress.worktrees,
    [key]: {
      path: existing?.path || target.worktree,
      scopes: { ...(existing?.scopes ?? {}), [target.scope]: { tokens: next } },
      updatedAtMs: Date.now(),
    },
  };
}

/**
 * 切换到某个 worktree。其他 worktree 的进度保留；同一个 worktree 的重新打开也不清空。
 * 返回是否真的换了 worktree（调用方据此知道展示的仓库变了）。
 */
export function beginReviewProgress(worktree: string): boolean {
  const current = reviewProgress.worktree;
  reviewProgress.worktree = worktree;
  const key = keyOf(worktree);
  if (!reviewProgress.worktrees[key]) {
    reviewProgress.worktrees = {
      ...reviewProgress.worktrees,
      [key]: { path: worktree, scopes: {}, updatedAtMs: 0 },
    };
  }
  return current === null || !sameWorktreePath(current, worktree);
}

/** 关闭仓库或测试用：清空全部进度。 */
export function resetReviewProgress(): void {
  reviewProgress.worktree = null;
  reviewProgress.worktrees = {};
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

/** 某个范围的 path -> token 快照；没有记录时返回空表。 */
export function reviewTokens(target: ReviewTarget): Record<string, string> {
  return recordOf(target)?.scopes[target.scope]?.tokens ?? EMPTY;
}

export function reviewTokenOf(target: ReviewTarget, path: string): string | null {
  return reviewTokens(target)[path] ?? null;
}

export function isReviewedIn(target: ReviewTarget, path: string): boolean {
  return typeof reviewTokens(target)[path] === "string";
}

/** 已标记路径的集合：列表、命令与计数共用同一份。 */
export function reviewedPathsIn(target: ReviewTarget): string[] {
  return Object.keys(reviewTokens(target));
}

/** 标记已审阅；只接受后端确认过的 token。 */
export function markReviewedIn(target: ReviewTarget, path: string, token: string): void {
  if (!token) return;
  writeTokens(target, (current) => ({ ...current, [path]: token }));
}

export function unmarkReviewedIn(target: ReviewTarget, path: string): void {
  writeTokens(target, (current) => {
    if (!(path in current)) return null;
    const next = { ...current };
    delete next[path];
    return next;
  });
}

/** 已审阅数与给定路径总数（按路径去重由调用方负责）。 */
export function reviewSummaryIn(target: ReviewTarget, paths: readonly string[]): { total: number; reviewed: number } {
  const tokens = reviewTokens(target);
  let reviewed = 0;
  for (const path of paths) if (typeof tokens[path] === "string") reviewed += 1;
  return { total: paths.length, reviewed };
}

/** 丢弃已经不在范围里的标记；返回被移除的路径。 */
export function pruneReviewProgressIn(target: ReviewTarget, paths: readonly string[]): string[] {
  const alive = new Set(paths);
  const current = reviewTokens(target);
  const removed = Object.keys(current).filter((path) => !alive.has(path));
  if (removed.length === 0) return [];
  writeTokens(target, (tokens) => {
    const next = { ...tokens };
    for (const path of removed) delete next[path];
    return next;
  });
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
export function applyReviewReverificationIn(
  target: ReviewTarget,
  updates: readonly { path: string; token: string | null; reason?: string }[],
): ReviewInvalidation[] {
  const invalidations: ReviewInvalidation[] = [];
  const current = reviewTokens(target);
  const next = { ...current };
  for (const update of updates) {
    const known = next[update.path];
    if (known === undefined) continue;
    if (update.token && update.token === known) continue;
    delete next[update.path];
    invalidations.push({
      path: update.path,
      reason: update.reason ?? (update.token ? "文件内容或改动已变化" : "无法确认文件快照"),
    });
  }
  if (invalidations.length > 0) writeTokens(target, () => next);
  return invalidations;
}

/**
 * 跨 worktree 的会话进度摘要：给 worktree 总览消费。
 * 只报告真实的已审阅条数，不推断总数、完成度或任务状态。
 */
export interface ReviewScopeSummary {
  scope: string;
  reviewed: number;
}

export interface WorktreeReviewSummary {
  path: string;
  scopes: ReviewScopeSummary[];
  reviewedTotal: number;
  updatedAtMs: number;
}

export function worktreeReviewSummary(worktree: string): WorktreeReviewSummary | null {
  const record = recordOf({ worktree, scope: CHANGES_SCOPE });
  if (!record) return null;
  return summarize(record);
}

export function reviewSessionSummary(): WorktreeReviewSummary[] {
  return Object.values(reviewProgress.worktrees)
    .map(summarize)
    .filter((item) => item.scopes.length > 0)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

function summarize(record: WorktreeRecord): WorktreeReviewSummary {
  const scopes = Object.entries(record.scopes)
    .map(([scope, value]) => ({ scope, reviewed: Object.keys(value.tokens).length }))
    .filter((item) => item.reviewed > 0);
  return {
    path: record.path,
    scopes,
    reviewedTotal: scopes.reduce((total, item) => total + item.reviewed, 0),
    updatedAtMs: record.updatedAtMs,
  };
}
