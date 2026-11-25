/**
 * 审查相关的处理函数（从 App.svelte 迁出，行为不变）。
 *
 * App 只负责接线：把当前仓库、任务范围、提示与确认等能力以 host 的形式交进来，
 * 这里集中保存意见 CRUD、准备送回、审阅进度重验、来源选择/关闭/返回以及来源菜单的
 * 文案与排序。所有防护（代次、序号、来源核对、写锁）逐条照搬原实现。
 */
import { api } from "./api";
import { normalizeError } from "./errors";
import {
  clioraBaseline,
  clioraReturnNotice,
  clioraReturnOutcome,
  clioraReview,
  clioraSourceEpoch,
  clioraSourceMatches,
  forgetClioraReview,
  hydrateClioraReviews,
  selectClioraSource,
  type ClioraReviewSource,
} from "./cliora-review.svelte";
import {
  addComment as addCommentRecord,
  adoptCommentScope,
  deleteComment as deleteCommentRecord,
  editComment as editCommentRecord,
  feedbackComments,
  forgetComments,
  recordPreparedComments,
  snapshotPreparedComments,
  staleBatches,
  type CommentScope,
  type ReviewCommentAnchor,
} from "./review-comments.svelte";
import {
  CHANGES_SCOPE,
  applyReviewReverificationIn,
  pruneReviewProgressIn,
  reviewPaths,
  reviewTokens,
  type ReviewTarget,
} from "./review-progress.svelte";
import { forgetWorkbenchState } from "./review-workbench.svelte";
import { hueOf } from "./ui";
import { checkoutKey, projectInitial, type Projects } from "./workspaces";
import type { OpenedRepository } from "./types";
import type { SelectMenuOption } from "./components/SelectMenu.svelte";

/**
 * 任务页报告的已解析范围。`generation` 是这次读取被校验过的仓库代次：起点、HEAD 与
 * 未提交状态的形状都没变、只有已修改文件的内容被改写时，rangeVersion 不变而代次前进。
 * 任务快照 token、审阅进度与行意见都以它为身份，旧结论不会挂到已经变化的内容上。
 */
export interface TaskScopeSnapshot {
  worktree: string;
  baselineOid: string;
  headOid: string;
  rangeVersion: string;
  generation: number;
}

/** App 交给审查处理函数的能力：全部是读取当前值的函数，保证 await 之后读到的是最新状态。 */
export interface ReviewActionsHost {
  opened(): OpenedRepository | null;
  taskScope(): TaskScopeSnapshot | null;
  taskTarget(): ReviewTarget | null;
  commentScope(): CommentScope | null;
  commentScopeOutdated(): boolean;
  nextId(): number;
  notice(message: string, tone?: "ok" | "warn"): void;
  showError(error: unknown): void;
  setReviewNote(message: string): void;
  setTaskReviewNote(message: string): void;
  confirmEditorLeave(purpose: string): Promise<boolean>;
  refresh(): Promise<boolean>;
  switchBlocked(): boolean;
  openRecent(path: string): Promise<unknown>;
  openTaskReview(baseline: string | null): void;
  closeTask(): void;
  closeReviewManager(refocus: boolean): void;
  clearSourcesNotice(): void;
}

function samePath(a: string, b: string): boolean {
  return checkoutKey(a) === checkoutKey(b);
}

export class ReviewActions {
  /** 正在准备送回意见：防重入，界面据此禁用按钮。 */
  feedbackPreparing = $state(false);
  /** 最近一次准备送回的结论（成功或失败）；新增/编辑/删除意见或范围清空时收起。 */
  feedbackNotice = $state<string | null>(null);
  private reviewSerial = 0;
  private taskReviewSerial = 0;

  constructor(private readonly host: ReviewActionsHost) {}

  /**
   * 刷新后只重验已标记的路径：token 相同保留，内容或状态变化、文件消失、
   * 无法确认时取消对应标记，其他文件不受影响。没有标记时不发任何请求。
   * 改动范围只重验改动快照；任务范围由任务页读取后再重验，两条范围互不作证。
   */
  async reverifyReviewed(): Promise<void> {
    const host = this.host;
    const current = host.opened();
    if (!current) return;
    const target: ReviewTarget = { worktree: current.summary.path, scope: CHANGES_SCOPE };
    const marked = Object.keys(reviewTokens(target));
    if (marked.length === 0) return;
    const alive = reviewPaths(current.snapshot.files);
    const dropped = pruneReviewProgressIn(target, alive);
    if (dropped.length > 0) {
      host.setReviewNote(`${dropped.length} 个文件已不在改动列表里，已撤销对应的已审阅标记。`);
    }
    const aliveSet = new Set(alive);
    const targets = marked.filter((path) => aliveSet.has(path));
    if (targets.length === 0) return;
    const serial = ++this.reviewSerial;
    const repo = current.summary.path;
    const results: { path: string; token: string | null; reason?: string }[] = [];
    for (const path of targets) {
      try {
        const result = await api.repositoryReviewToken(repo, path, current.generation, host.nextId());
        results.push({
          path,
          token: result.state === "current" ? result.token : null,
          reason: result.message,
        });
      } catch (error) {
        const failure = normalizeError(error);
        // stale 说明已经有新一代：下一次刷新会重验，不在这里重复请求。
        if (failure.code === "stale") return;
        results.push({ path, token: null, reason: `无法确认快照：${failure.message}` });
      }
      if (serial !== this.reviewSerial || host.opened()?.summary.path !== repo) return;
    }
    const invalidations = applyReviewReverificationIn(target, results);
    if (invalidations.length > 0) {
      host.setReviewNote(`${invalidations.length} 个文件的快照已变化，已撤销对应的已审阅标记。`);
    }
  }

  /**
   * 任务范围的重验：只重验已标记路径，token 相同保留；内容、暂存、未跟踪、冲突或
   * 删除状态变化只撤销受影响的那条，其他进度、草稿与真实暂存都不动。
   */
  async reverifyTaskReviewed(): Promise<void> {
    const host = this.host;
    const scope = host.taskScope();
    const target = host.taskTarget();
    if (!scope || !target) return;
    const marked = Object.keys(reviewTokens(target));
    if (marked.length === 0) return;
    const serial = ++this.taskReviewSerial;
    const results: { path: string; token: string | null; reason?: string }[] = [];
    for (const path of marked) {
      try {
        const result = await api.taskReviewToken(
          scope.worktree,
          scope.baselineOid,
          scope.headOid,
          path,
          host.opened()?.generation ?? 0,
          host.nextId(),
        );
        results.push({
          path,
          token: result.state === "current" ? result.token : null,
          reason: result.message,
        });
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code === "stale") return;
        results.push({ path, token: null, reason: `无法确认快照：${failure.message}` });
      }
      const latest = host.taskScope();
      if (
        serial !== this.taskReviewSerial ||
        latest?.worktree !== scope.worktree ||
        latest?.baselineOid !== scope.baselineOid ||
        latest?.headOid !== scope.headOid
      ) {
        return;
      }
    }
    const invalidations = applyReviewReverificationIn(target, results);
    if (invalidations.length > 0) {
      host.setTaskReviewNote(`${invalidations.length} 个文件的快照已变化，已撤销对应的已审阅标记。`);
    }
  }

  /**
   * 任务页报告新范围之后（App 已写入 taskScope）：范围或读取代次变了，上一批意见整体失效，
   * 不猜新行号；范围清空时收起交接结论；有范围就重验已标记路径。
   */
  afterTaskScope(scope: TaskScopeSnapshot | null): void {
    const comment = this.host.commentScope();
    if (scope && comment) adoptCommentScope(comment);
    if (!scope) this.feedbackNotice = null;
    if (scope) void this.reverifyTaskReviewed();
  }

  /** 新增一条行意见：只写当前运行期内存，不改 Git、不发送提示词。 */
  addComment(anchor: ReviewCommentAnchor, body: string): void {
    const scope = this.host.commentScope();
    if (!scope) throw new Error("当前没有任务范围，这条意见没有保存。");
    // 读取代次落后时先别往过期批次里写：那批意见马上会整体失效，写了也会丢。
    if (this.host.commentScopeOutdated()) throw new Error("工作区在这次读取之后又变化了，先重新读取任务再写意见。");
    addCommentRecord(scope, anchor, body);
    this.feedbackNotice = null;
  }

  editComment(id: string, body: string): void {
    const scope = this.host.commentScope();
    if (!scope) throw new Error("当前没有任务范围，这条意见没有保存。");
    if (!editCommentRecord(scope, id, body)) throw new Error("这条意见已经不在当前批次里，请重新读取任务。");
    this.feedbackNotice = null;
  }

  deleteComment(id: string): void {
    const scope = this.host.commentScope();
    if (scope) deleteCommentRecord(scope, id);
    this.feedbackNotice = null;
  }

  /**
   * 显式准备送回原任务：原生校验来源、结果版本、工作树与任务起点，写私有一次性文件并回读
   * 核对后才打开只带标识与 digest 的深链。失败时不唤起 Cliora，意见与原任务都保留。
   */
  async prepareFeedback(): Promise<void> {
    const host = this.host;
    const scope = host.commentScope();
    const source = clioraReview.source;
    if (!scope || !source) {
      host.notice("当前没有可送回的任务来源。", "warn");
      return;
    }
    const comments = feedbackComments(scope);
    // 与送出内容同一时刻取签名：等待原生准备期间新增或改过的意见不算已送回。
    const sentSignature = snapshotPreparedComments(scope);
    if (comments.length === 0) {
      // 失效的批次不会回到当前范围里：这里要如实说「已经失效」，不能让用户以为只是没写。
      const invalidated = staleBatches(source.reviewId).length > 0;
      host.notice(
        invalidated
          ? "上一批意见已经失效，不会送回；请按当前任务内容重新写一批。"
          : "先写一条意见，再准备送回原任务。",
        "warn",
      );
      return;
    }
    // 任务页还没按最新代次重读：这批意见锚的行可能已经变了，绝不把过期批次送出去。
    if (host.commentScopeOutdated()) {
      host.notice("工作区在这次任务读取之后又变化了，先重新读取任务再准备送回；这批意见不会送出。", "warn");
      return;
    }
    if (this.feedbackPreparing) return;
    this.feedbackPreparing = true;
    this.feedbackNotice = null;
    try {
      const prepared = await api.prepareReviewFeedback({
        reviewId: source.reviewId,
        sessionId: source.sessionId,
        // 结果版本以这条来源最近一次 returned 的序号为准；从未返回过就是 0。
        resultRevision: clioraReview.lastReturn?.revision ?? 0,
        worktreePath: scope.worktree,
        rangeVersion: scope.rangeVersion,
        baselineOid: scope.baselineOid,
        headOid: scope.headOid,
        comments,
      });
      // 记下这次成功准备的意见签名：之后新增或改过的意见才算「未送回」。
      recordPreparedComments(scope, sentSignature);
      this.feedbackNotice = "已准备 " + prepared.commentCount + " 条意见（批次 " + prepared.feedbackId.slice(0, 8) + "）。到 Cliora 里确认预览后再发送，这里没有发送任何内容。";
      host.notice(this.feedbackNotice);
    } catch (error) {
      // 失败不打开 cliora：意见、原任务与所有草稿都保留，用户可以重新准备。
      this.feedbackNotice = "这批意见没有准备好，Cliora 没有被唤起。意见仍保留，可以再试一次。";
      host.showError(error);
    } finally {
      this.feedbackPreparing = false;
    }
  }

  /** 从原生重新读取本进程的来源快照；失败时保留现有来源，不凭空制造结果。 */
  async refreshClioraSources(): Promise<void> {
    const epoch = clioraSourceEpoch();
    try {
      const snapshot = await api.clioraReviewSources();
      if (snapshot && Array.isArray(snapshot.sources)) hydrateClioraReviews(snapshot.sources, epoch);
    } catch { /* Keep current sources; a failed refresh cannot invent a new result. */ }
  }

  /**
   * 返回发起这次审查的 cliora 会话：只回送最新结果，不执行任何 Git 写入，也不关闭仓库、
   * 不清空草稿。没有来源时按钮不显示，这里再挡一次。
   */
  async returnToCliora(): Promise<void> {
    const host = this.host;
    const source = clioraReview.source;
    const opened = host.opened();
    if (!source || !opened || !clioraSourceMatches(opened.summary.path)) return;
    // 返回来源前未保存的草稿必须有结论：保存只写工作区，不会变成提交或合入结果。
    if (!(await host.confirmEditorLeave("返回 cliora"))) return;
    if (clioraReview.source?.reviewId !== source.reviewId) return;
    const { outcome, headOid } = clioraReturnOutcome();
    // 工作区声明由后端按来源工作树读取真实 Git 状态填写，前端不声明。这里刷新一次只为
    // 后端没给出结果时提示仍按真实快照说明；当前仓库已不是来源工作树就当作没读到。
    const fresh = await host.refresh().catch(() => false);
    if (clioraReview.source?.reviewId !== source.reviewId) return;
    const current = host.opened();
    const localUncommitted =
      fresh && current && clioraSourceMatches(current.summary.path) ? current.snapshot.files.length : null;
    try {
      const sent = await api.clioraReviewReturn(source.reviewId, source.sessionId, outcome, headOid);
      await this.refreshClioraSources();
      // 普通保存不制造提交或合入结果；工作区还有未提交修改时如实说出来，不再说「只做了浏览」。
      host.notice(clioraReturnNotice(outcome, sent, localUncommitted));
    } catch (error) {
      if (normalizeError(error).code === "source_result_changed") {
        await this.refreshClioraSources();
      }
      host.showError(error);
    }
  }

  async chooseClioraReview(reviewId: string): Promise<void> {
    const host = this.host;
    if (!reviewId) { selectClioraSource(null); host.closeTask(); return; }
    const source = clioraReview.sources.find((item) => item.reviewId === reviewId);
    if (!source || host.switchBlocked()) return;
    let opened = host.opened();
    if (!opened || !samePath(opened.summary.path, source.worktreePath)) await host.openRecent(source.worktreePath);
    opened = host.opened();
    if (!opened || !samePath(opened.summary.path, source.worktreePath)) return;
    if (selectClioraSource(reviewId)) host.openTaskReview(clioraBaseline());
  }

  async closeClioraReview(reviewId = clioraReview.source?.reviewId): Promise<void> {
    const host = this.host;
    const source = clioraReview.sources.find((item) => item.reviewId === reviewId);
    if (!source || host.switchBlocked()) return;
    const wasActive = clioraReview.source?.reviewId === source.reviewId;
    try {
      await api.clioraReviewForget(source.reviewId, source.sessionId);
      forgetClioraReview(source.reviewId);
      forgetComments(source.reviewId);
      forgetWorkbenchState(source.reviewId);
      if (wasActive) host.closeTask();
      host.notice("已关闭此审查来源；仓库、阅读记录和草稿仍保留。需要审查时从 Cliora 重新发起。");
    } catch (error) { host.showError(error); }
  }

  /**
   * 完全关闭 Cliora 审查：关闭全部来源并收起审查栏。仓库、阅读记录和草稿都保留；
   * 某个来源关闭失败时其余照常关闭，失败的原因如实说明。
   */
  async closeAllClioraReviews(): Promise<void> {
    const host = this.host;
    if (host.switchBlocked()) return;
    const sources = [...clioraReview.sources];
    const wasActive = Boolean(clioraReview.source);
    host.closeReviewManager(false);
    let failure: unknown = null;
    for (const source of sources) {
      try {
        await api.clioraReviewForget(source.reviewId, source.sessionId);
        forgetClioraReview(source.reviewId);
        forgetComments(source.reviewId);
        forgetWorkbenchState(source.reviewId);
      } catch (error) {
        failure ??= error;
      }
    }
    host.clearSourcesNotice();
    if (wasActive) host.closeTask();
    if (failure) host.showError(failure);
    else if (sources.length > 0) host.notice("已关闭全部审查来源；仓库、阅读记录和草稿仍保留。需要审查时从 Cliora 重新发起。");
  }
}

export function createReviewActions(host: ReviewActionsHost): ReviewActions {
  return new ReviewActions(host);
}

/* ------------------------------------------------------------------ *
 * 来源菜单的文案与排序（纯函数）
 * ------------------------------------------------------------------ */

export type ClioraSourceRanks = Map<string, { order: number; total: number }>;

/** 审查来源的仓库名：工作区路径最后一段，比整条路径好认。 */
export function clioraRepoName(source: ClioraReviewSource): string {
  return source.worktreePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source.worktreePath;
}

/**
 * 同一会话对同一工作树重复发起时，行文字原本完全一样；这里按到达顺序给出序号，
 * 供「最新 / 较早第 N 次」标签使用。
 */
export function clioraSourceRanks(sources: readonly ClioraReviewSource[]): ClioraSourceRanks {
  const groups = new Map<string, string[]>();
  for (const source of sources) {
    const key = source.sessionId + "\u0000" + checkoutKey(source.worktreePath);
    groups.set(key, [...(groups.get(key) ?? []), source.reviewId]);
  }
  const ranks: ClioraSourceRanks = new Map();
  for (const ids of groups.values()) ids.forEach((id, index) => ranks.set(id, { order: index + 1, total: ids.length }));
  return ranks;
}

export function clioraRepeatLabel(source: ClioraReviewSource, ranks: ClioraSourceRanks): string | null {
  const rank = ranks.get(source.reviewId);
  if (!rank || rank.total < 2) return null;
  return rank.order === rank.total ? "最新发起" : `第 ${rank.order} 次发起`;
}

export function clioraSourceText(source: ClioraReviewSource, ranks: ClioraSourceRanks): string {
  const repeat = clioraRepeatLabel(source, ranks);
  return clioraRepoName(source) + (repeat ? ` · ${repeat}` : "");
}

export function clioraProjectLabel(source: ClioraReviewSource, projects: Projects): string {
  if (!source.workspaceId) return "独立仓库";
  const project = projects.projects.find((item) => item.manifest.workspaceId === source.workspaceId);
  const membership = project && source.repositoryId && project.manifest.repositories.some((repo) => repo.id === source.repositoryId);
  return (source.workspaceName ?? project?.manifest.name ?? source.workspaceId.slice(0, 8)) + (!project ? "（项目未关联）" : !membership ? "（仓库未关联）" : "");
}

/**
 * 来源下拉：仓库名为主，第二行是项目、会话、任务起点与审查号。
 * 同一会话对同一工作树重复发起时标出「最新 / 较早第 N 次」，并给出起点与审查号，
 * 用户能分清要回报哪一次。当前仓库的来源排在前面。
 */
export function clioraSourceOptions(
  sources: readonly ClioraReviewSource[],
  currentPath: string | null,
  projects: Projects,
): SelectMenuOption[] {
  const ranks = clioraSourceRanks(sources);
  const isCurrent = (source: ClioraReviewSource) => currentPath !== null && samePath(source.worktreePath, currentPath);
  return [
    { value: "", label: "不使用审查来源", detail: "独立操作当前仓库，不回报给 Cliora", icon: "x" },
    ...[...sources]
      .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)))
      .map((source) => {
        const repeat = clioraRepeatLabel(source, ranks);
        const parts = [
          clioraProjectLabel(source, projects),
          `会话 ${source.sessionId.slice(0, 8)}`,
          source.baseline ? `起点 ${source.baseline.slice(0, 7)}` : "无起点",
          `审查 ${source.reviewId.slice(0, 8)}`,
        ];
        return {
          value: source.reviewId,
          label: clioraRepoName(source),
          detail: parts.join(" · "),
          badge: projectInitial(clioraRepoName(source)),
          hue: hueOf(source.worktreePath),
          tag: repeat ?? (isCurrent(source) ? "当前仓库" : undefined),
        };
      }),
  ];
}
