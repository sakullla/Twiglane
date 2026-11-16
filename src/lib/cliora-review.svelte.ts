/** In-memory review sources, keyed by reviewId. Navigation changes only the active selection.
 * Results belong to the source selected when a successful Git operation began; restart expires them.
 * File saves and local review marks never create committed/merged outcomes.
 */
import { checkoutKey } from "./workspaces";
import type { ClioraOutcome, ClioraReturnSent, ClioraWorktreeState } from "./types";

export type { ClioraOutcome, ClioraWorktreeState } from "./types";

/** 一次审查来源。字段原样来自已校验的 v2/v3 链接。 */
export interface ClioraReviewSource {
  protocolVersion: 2 | 3;
  workspaceId: string | null;
  repositoryId: string | null;
  workspaceName: string | null;
  reviewId: string;
  sessionId: string;
  /** 已由后端校验并 canonicalize 的目标工作树根目录。 */
  worktreePath: string;
  /** 发起时该工作树的 HEAD；读不到时为 null。 */
  baseline: string | null;
}

/** 已完成的 Git 操作结果（待 cliora 用真实 HEAD 复核）。 */
export interface ClioraReviewResult {
  outcome: "committed" | "merged";
  headOid: string;
  recordedAt: number;
}

export interface ClioraSourceSnapshot {
  source: ClioraReviewSource;
  result: ClioraReviewResult | null;
  lastReturn: { revision: number; declaration: { reviewId: string; sessionId: string; outcome: ClioraOutcome; headOid: string | null; worktreeState: ClioraWorktreeState; meta: [string, string][] } } | null;
}

export const MAX_REVIEW_SOURCES = 8;
let mutationEpoch = 0;
export function clioraSourceEpoch(): number { return mutationEpoch; }
const store = $state({
  entries: {} as Record<string, ClioraSourceSnapshot>,
  activeReviewId: null as string | null,
  currentPath: null as string | null,
  selections: {} as Record<string, string>,
});

export const clioraReview = {
  get lastReturn(): ClioraSourceSnapshot["lastReturn"] { return store.activeReviewId ? store.entries[store.activeReviewId]?.lastReturn ?? null : null; },
  get sources(): ClioraReviewSource[] { return Object.values(store.entries).map((entry) => entry.source); },
  get source(): ClioraReviewSource | null { return store.activeReviewId ? store.entries[store.activeReviewId]?.source ?? null : null; },
  get result(): ClioraReviewResult | null { return store.activeReviewId ? store.entries[store.activeReviewId]?.result ?? null : null; },
};

/** Reuse project checkout semantics: POSIX case and literal backslashes are significant. */
export function sameWorktreePath(a: string, b: string): boolean {
  return checkoutKey(a) === checkoutKey(b);
}

/** The link itself explicitly selects its source. Existing IDs never reset a result or baseline. */
export function beginClioraReview(input: Pick<ClioraReviewSource, "reviewId" | "sessionId" | "worktreePath" | "baseline"> & Partial<ClioraReviewSource>): void {
  const source: ClioraReviewSource = { ...input, protocolVersion: input.protocolVersion ?? 2, workspaceId: input.workspaceId ?? null, repositoryId: input.repositoryId ?? null, workspaceName: input.workspaceName ?? null };
  const known = store.entries[source.reviewId];
  if (known && (known.source.sessionId !== source.sessionId || !sameWorktreePath(known.source.worktreePath, source.worktreePath))) {
    throw new Error("审查标识已绑定其它来源，请从 Cliora 重新发起。");
  }
  if (!known && clioraReview.sources.length >= MAX_REVIEW_SOURCES) throw new Error("审查来源已满，请明确关闭一个来源后重新发起。");
  if (!known) { store.entries = { ...store.entries, [source.reviewId]: { source, result: null, lastReturn: null } }; mutationEpoch += 1; }
  store.currentPath = source.worktreePath;
  selectClioraSource(source.reviewId);
}

/** Hydrate only the current native process. Full process restart returns no sources. */
export function hydrateClioraReviews(snapshots: ClioraSourceSnapshot[], expectedEpoch = mutationEpoch): boolean {
  if (expectedEpoch !== mutationEpoch) return false;
  if (snapshots.length > MAX_REVIEW_SOURCES) throw new Error("原生审查来源超出上限，请重新启动并从 Cliora 重新发起。");
  store.entries = Object.fromEntries(snapshots.map((entry) => [entry.source.reviewId, { source: { ...entry.source }, result: entry.result ? { ...entry.result } : null, lastReturn: entry.lastReturn }]));
  mutationEpoch += 1;
  if (store.currentPath) forgetClioraSourceUnless(store.currentPath);
  else store.activeReviewId = null;
  return true;
}

/** Navigation changes only the active display; every other source and result stays in memory. */
export function forgetClioraSourceUnless(path: string): void {
  store.currentPath = path;
  const matches = clioraReview.sources.filter((source) => sameWorktreePath(source.worktreePath, path));
  const selected = store.selections[checkoutKey(path)];
  store.activeReviewId = Object.hasOwn(store.selections, checkoutKey(path))
    ? matches.some((source) => source.reviewId === selected) ? selected : null
    : matches.length === 1 ? matches[0].reviewId : null;
}

export function selectClioraSource(reviewId: string | null): boolean {
  const source = reviewId ? store.entries[reviewId]?.source : null;
  if (source && (!store.currentPath || !sameWorktreePath(store.currentPath, source.worktreePath))) return false;
  store.activeReviewId = source?.reviewId ?? null;
  if (store.currentPath) store.selections = { ...store.selections, [checkoutKey(store.currentPath)]: source?.reviewId ?? "" };
  return true;
}

/** Called only after native release succeeds; never removes repository drafts or files. */
export function forgetClioraReview(reviewId: string): void {
  const entries = { ...store.entries };
  delete entries[reviewId];
  store.entries = entries;
  mutationEpoch += 1;
  if (store.activeReviewId === reviewId) store.activeReviewId = null;
  // Do not implicitly select another source on this same checkout.
}

export function captureClioraReview(path: string): string | null {
  return clioraSourceMatches(path) ? clioraReview.source!.reviewId : null;
}

/**
 * 来源携带的任务起点：只有已校验的完整提交才有值。
 *
 * 任务范围必须由起点明确建立，因此缺失时返回 null，由任务页要求用户自己选择，
 * 绝不在这里退回当前 HEAD 或默认分支。
 */
export function clioraBaseline(): string | null {
  const baseline = clioraReview.source?.baseline?.trim() ?? "";
  return baseline === "" ? null : baseline;
}

/** 来源是否就是这条路径的工作树。 */
export function clioraSourceMatches(path: string): boolean {
  return clioraReview.source !== null && sameWorktreePath(clioraReview.source.worktreePath, path);
}

/** 只有来源匹配时才记录提交结果；没有来源的独立仓库不显示任何 cliora 结果。 */
export function recordClioraCommit(path: string, oid: string, reviewId = captureClioraReview(path)): void {
  recordClioraOutcome(path, "committed", oid, reviewId);
}

/** 只有来源匹配时才记录合入结果（快进、变基完成，或合并提交完成）。 */
export function recordClioraMerge(path: string, oid: string, reviewId = captureClioraReview(path)): void {
  recordClioraOutcome(path, "merged", oid, reviewId);
}

function recordClioraOutcome(path: string, outcome: "committed" | "merged", oid: string, reviewId: string | null): void {
  if (!reviewId || !oid) return;
  const entry = store.entries[reviewId];
  if (!entry || !sameWorktreePath(entry.source.worktreePath, path)) return;
  store.entries = { ...store.entries, [reviewId]: { ...entry, result: { outcome, headOid: oid, recordedAt: Date.now() } } };
  mutationEpoch += 1;
}

/** 返回 cliora 时的 Git 结果声明：没有成功的提交或合入就是 reviewed，绝不推断成功。 */
export function clioraReturnOutcome(): { outcome: ClioraOutcome; headOid: string | null } {
  const result = clioraReview.result;
  if (!result) return { outcome: "reviewed", headOid: null };
  return { outcome: result.outcome, headOid: result.headOid };
}

const WORKTREE_STATES: readonly ClioraWorktreeState[] = ["clean", "dirty", "unknown"];

/**
 * 返回 cliora 后的提示。Git outcome 与工作区状态分开说：
 * - 工作区状态以后端实际发送的为准（后端按来源工作树读取真实 Git 状态）；
 * - 后端没有给出结果时（例如浏览器预览），只用返回前刚刷新到的来源工作树快照说明，
 *   localUncommitted 为 null 表示没读到，如实说没读到，绝不当作干净或“只浏览”。
 */
export function clioraReturnNotice(
  outcome: ClioraOutcome,
  sent: ClioraReturnSent | null | undefined,
  localUncommitted: number | null,
): string {
  const git = outcome !== "reviewed" ? "提交或合入结果以待复核声明发送" : "本次没有提交或合入";
  const fromBackend = sent && WORKTREE_STATES.includes(sent.worktreeState) ? sent : null;
  const count = fromBackend
    ? fromBackend.uncommitted
    : localUncommitted !== null && Number.isFinite(localUncommitted) && localUncommitted >= 0
      ? localUncommitted
      : null;
  const state: ClioraWorktreeState = fromBackend
    ? fromBackend.worktreeState
    : count === null
      ? "unknown"
      : count > 0
        ? "dirty"
        : "clean";
  const worktree =
    state === "dirty"
      ? count !== null && count > 0
        ? `工作区还有 ${count} 个未提交的改动`
        : "工作区还有未提交的改动"
      : state === "clean"
        ? "工作区没有未提交的改动"
        : fromBackend
          ? "这次没有读到工作区状态，已按未知发送"
          : "这次没有读到工作区状态";
  return `已返回 cliora：${git}，${worktree}。`;
}

/** 测试用：清空来源与结果。 */
export function resetClioraReview(): void {
  mutationEpoch += 1;
  store.entries = {};
  store.activeReviewId = null;
  store.currentPath = null;
  store.selections = {};
}
/** 链接来源：冷启动（应用启动时带来的链接）或运行中。 */
export type ClioraLinkStyle = "cold" | "hot";

interface DeepLinkApi {
  getCurrent: () => Promise<string[] | null>;
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
}

/**
 * 订阅 v2 审查 deep link：冷启动取 \`getCurrent()\`，运行中订阅 \`onOpenUrl\`。
 *
 * 只把原始 URL 交给调用方，协议解析在 Rust 侧完成（\`cliora_review_request\`），前端不
 * 复制一份校验。浏览器预览与单元测试没有 Tauri 运行时，动态导入或调用会失败，失败即
 * 视为“没有链接来源”，不影响独立仓库的既有流程。返回退订函数；非原生环境返回空退订。
 */
export async function watchClioraReviewLinks(
  handler: (url: string, style: ClioraLinkStyle) => void,
): Promise<() => void> {
  let stop: (() => void) | null = null;
  try {
    const { getCurrent, onOpenUrl } = (await import(
      "@tauri-apps/plugin-deep-link"
    )) as unknown as DeepLinkApi;
    stop = await onOpenUrl((urls) => {
      for (const url of urls) handler(url, "hot");
    });
    const initial = await getCurrent();
    for (const url of initial ?? []) handler(url, "cold");
  } catch {
    stop?.();
    return () => {};
  }
  return () => stop?.();
}
