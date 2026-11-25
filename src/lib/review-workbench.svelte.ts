/**
 * 审查工作台的界面状态，按 reviewId（远程来源用其 reviewId）隔离保存。
 *
 * 只存界面状态：选中文件、多选、阅读模式、统一/并排、队列筛选与搜索、意见抽屉、
 * 滚动锚点与「范围内提交」展开。不存审阅进度与意见（各自 store 负责），也不写磁盘；
 * 切换来源时保存/恢复，显式关闭来源时清理。
 */

export type ReviewReadingMode = "single" | "continuous";
export type ReviewDiffMode = "unified" | "split";
export type ReviewQueueFilter = "all" | "unreviewed" | "commented";

/** 恢复阅读位置用的锚点：文件路径 + 该文件内的滚动偏移（像素）或行号。 */
export interface ReviewScrollAnchor {
  path: string;
  offset: number;
  line?: number | null;
}

export interface ReviewWorkbenchState {
  selectedPath: string | null;
  selectedSet: string[];
  readingMode: ReviewReadingMode;
  diffMode: ReviewDiffMode;
  filter: ReviewQueueFilter;
  query: string;
  drawerOpen: boolean;
  scrollAnchor: ReviewScrollAnchor | null;
  commitsOpen: boolean;
}

export function defaultWorkbenchState(): ReviewWorkbenchState {
  return {
    selectedPath: null,
    selectedSet: [],
    readingMode: "single",
    diffMode: "unified",
    filter: "all",
    query: "",
    drawerOpen: false,
    scrollAnchor: null,
    commitsOpen: false,
  };
}

const store = $state({
  states: {} as Record<string, ReviewWorkbenchState>,
});

/** 失效撤销的原因分类：内容变化、路径消失（不再有净改动）、无法确认快照。 */
export type ReviewRevocationKind = "changed" | "missing" | "unconfirmed";

/** 重验时被自动撤销的已审阅标记：只说明原因，不恢复标记，也不影响其他文件。 */
export interface ReviewRevocation {
  kind: ReviewRevocationKind;
  reason: string;
}

export const REVOCATION_LABELS: Record<ReviewRevocationKind, string> = {
  changed: "内容变化",
  missing: "路径消失",
  unconfirmed: "无法确认",
};

/**
 * 工作台布局与队列附注（同样按 reviewId 隔离、关闭来源时清理）：左栏是否收起，以及
 * 按路径记录的失效撤销原因。与上面的界面状态分开存，保持那份状态的形状稳定。
 */
export interface ReviewWorkbenchExtras {
  queueCollapsed: boolean;
  revoked: Record<string, ReviewRevocation>;
}

const extras = $state({
  states: {} as Record<string, ReviewWorkbenchExtras>,
});

export function workbenchExtras(reviewId: string): ReviewWorkbenchExtras {
  const saved = extras.states[reviewId];
  return { queueCollapsed: saved?.queueCollapsed ?? false, revoked: { ...(saved?.revoked ?? {}) } };
}

export function saveWorkbenchExtras(reviewId: string, patch: Partial<ReviewWorkbenchExtras>): void {
  if (!reviewId) return;
  const next = { ...workbenchExtras(reviewId), ...patch };
  extras.states = { ...extras.states, [reviewId]: { queueCollapsed: next.queueCollapsed, revoked: { ...next.revoked } } };
}

/** 记录重验时被自动撤销的文件与原因（只影响这些路径）；同一路径再次失效时以最新原因为准。 */
export function recordRevocations(reviewId: string, items: readonly ({ path: string } & ReviewRevocation)[]): void {
  if (!reviewId || items.length === 0) return;
  const revoked = workbenchExtras(reviewId).revoked;
  for (const item of items) revoked[item.path] = { kind: item.kind, reason: item.reason };
  saveWorkbenchExtras(reviewId, { revoked });
}

/** 某文件重新标记已审阅后清除它的撤销原因：之后再被撤销时不会翻出旧原因。 */
export function clearRevocations(reviewId: string, paths: readonly string[]): void {
  if (!reviewId || !Object.hasOwn(extras.states, reviewId)) return;
  const revoked = workbenchExtras(reviewId).revoked;
  if (!paths.some((path) => Object.hasOwn(revoked, path))) return;
  for (const path of paths) delete revoked[path];
  saveWorkbenchExtras(reviewId, { revoked });
}

function copy(state: ReviewWorkbenchState): ReviewWorkbenchState {
  return {
    ...state,
    selectedSet: [...state.selectedSet],
    scrollAnchor: state.scrollAnchor ? { ...state.scrollAnchor } : null,
  };
}

/** 读取某来源的界面状态；从未保存过时返回默认值（不会因此创建记录）。 */
export function workbenchState(reviewId: string): ReviewWorkbenchState {
  const saved = store.states[reviewId];
  return saved ? copy(saved) : defaultWorkbenchState();
}

export function hasWorkbenchState(reviewId: string): boolean {
  return Object.hasOwn(store.states, reviewId);
}

/** 合并保存某来源的界面状态；只影响该 reviewId，返回保存后的副本。 */
export function saveWorkbenchState(reviewId: string, patch: Partial<ReviewWorkbenchState>): ReviewWorkbenchState {
  if (!reviewId) return defaultWorkbenchState();
  const next = copy({ ...workbenchState(reviewId), ...patch });
  store.states = { ...store.states, [reviewId]: next };
  return copy(next);
}

/** 关闭来源时清理该来源的界面状态。 */
export function forgetWorkbenchState(reviewId: string): void {
  if (Object.hasOwn(extras.states, reviewId)) {
    const rest = { ...extras.states };
    delete rest[reviewId];
    extras.states = rest;
  }
  if (!Object.hasOwn(store.states, reviewId)) return;
  const states = { ...store.states };
  delete states[reviewId];
  store.states = states;
}

/** 测试用：清空全部界面状态。 */
export function resetReviewWorkbench(): void {
  store.states = {};
  extras.states = {};
}
