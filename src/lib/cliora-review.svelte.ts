/**
 * cliora 审查来源上下文（内存态，Svelte 5 模块级 $state，先例 update.svelte.ts）。
 *
 * 只有 deep link 成功打开目标 worktree 后才会写入来源；独立打开别的仓库会清除展示。
 * 结果只记录真实成功的 Git 操作（在 api.ts 的成功边界写入），失败、取消、仅有冲突草稿
 * 都不记录。这里不做持久化：应用重启后旧 reviewId 不再有来源，链接按失效处理。
 *
 * v2 的返回把 Git outcome 与工作区状态分开：普通文件保存只让工作区变成 dirty，
 * 绝不制造提交、合入或批准结果。
 */
import type { ClioraOutcome, ClioraReturnSent, ClioraWorktreeState } from "./types";

export type { ClioraOutcome, ClioraWorktreeState } from "./types";

/** 一次审查来源。字段原样来自已校验的 v2 链接。 */
export interface ClioraReviewSource {
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

export const clioraReview = $state({
  source: null as ClioraReviewSource | null,
  result: null as ClioraReviewResult | null,
});

/**
 * 路径比较：Windows 上大小写与分隔符都不参与判定，另外忽略 canonicalize 可能留下的
 * 长路径前缀。仓库路径来自后端，这里只用于“同一个工作树”的判定。
 */
export function sameWorktreePath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return normalize(a) === normalize(b);
}

/** 记录来源；同时清掉上一次的结果，避免旧结果挂在新来源上。 */
export function beginClioraReview(source: ClioraReviewSource): void {
  clioraReview.source = { ...source };
  clioraReview.result = null;
}

/** 独立打开其它仓库时调用：只清展示，不动任何仓库的草稿与工作区。 */
export function forgetClioraSourceUnless(path: string): void {
  if (!clioraReview.source) return;
  if (sameWorktreePath(clioraReview.source.worktreePath, path)) return;
  clioraReview.source = null;
  clioraReview.result = null;
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
export function recordClioraCommit(path: string, oid: string): void {
  recordClioraOutcome(path, "committed", oid);
}

/** 只有来源匹配时才记录合入结果（快进、变基完成，或合并提交完成）。 */
export function recordClioraMerge(path: string, oid: string): void {
  recordClioraOutcome(path, "merged", oid);
}

function recordClioraOutcome(path: string, outcome: "committed" | "merged", oid: string): void {
  if (!clioraSourceMatches(path)) return;
  if (!oid) return;
  clioraReview.result = { outcome, headOid: oid, recordedAt: Date.now() };
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
  clioraReview.source = null;
  clioraReview.result = null;
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
