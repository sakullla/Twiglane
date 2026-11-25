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
  if (!Object.hasOwn(store.states, reviewId)) return;
  const states = { ...store.states };
  delete states[reviewId];
  store.states = states;
}

/** 测试用：清空全部界面状态。 */
export function resetReviewWorkbench(): void {
  store.states = {};
}
