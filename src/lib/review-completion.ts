/**
 * 审查完成栏的纯函数模型（R6）。
 *
 * 输入当前来源、意见、交接、Git 结果、工作区与返回状态，输出主次动作、状态分项、
 * 详情与色调。所有文案集中在这里：
 * - 交接只是「已准备、等待 Cliora 确认」，从不声称已发送给 Agent、已执行或修复完成；
 * - Git 结果与工作区状态分开成项，unknown 绝不说成干净；
 * - 阅读进度不等于批准，这里不出现「批准」。
 */

export type ReviewSourceKind = "local" | "remote" | "none";

export type ReviewHandoffState =
  | { state: "idle" }
  | { state: "preparing" }
  | { state: "prepared"; feedbackId: string; commentCount: number }
  | { state: "failed"; message: string };

export type ReviewGitResult =
  | { kind: "none" }
  | { kind: "committed"; oid: string }
  | { kind: "merged"; oid: string };

export type ReviewWorktreeState =
  | { state: "clean" }
  | { state: "dirty"; count: number | null }
  | { state: "unknown" };

export type ReviewReturnState =
  | { state: "idle" }
  | { state: "returning" }
  | { state: "returned"; revision: number }
  | { state: "failed"; message: string };

export interface ReviewCompletionInput {
  source: ReviewSourceKind;
  /** 当前批次里的意见数。 */
  commentCount: number;
  /** 当前批次里还没送回的意见数（省略时视为全部未送回）。 */
  unsentCount?: number;
  draftCount: number;
  /** 已失效、不会送回的意见数。 */
  staleCount: number;
  handoff: ReviewHandoffState;
  gitResult: ReviewGitResult;
  worktree: ReviewWorktreeState;
  returnState: ReviewReturnState;
  writeLocked: boolean;
  writeLockedReason?: string | null;
  /** 当前能否准备送回（例如范围已读取、代次未落后）。 */
  canFeedback: boolean;
  feedbackBlockedReason?: string | null;
}

export type ReviewCompletionTone = "neutral" | "info" | "success" | "warn" | "error";

export interface ReviewCompletionAction {
  id: "feedback" | "return";
  label: string;
  disabled: boolean;
  /** 禁用原因或动作说明（用作 title）。 */
  reason: string | null;
}

export interface ReviewCompletionStatusItem {
  id: "comments" | "drafts" | "stale" | "handoff" | "git" | "worktree" | "return" | "source";
  label: string;
  tone: ReviewCompletionTone;
}

export interface ReviewCompletionModel {
  primary: ReviewCompletionAction | null;
  secondary: ReviewCompletionAction | null;
  statusItems: ReviewCompletionStatusItem[];
  detailItems: string[];
  tone: ReviewCompletionTone;
}

/** 说明行固定保留：交接与返回都需要 Cliora 侧确认/复核。 */
export const COMPLETION_CONFIRM_NOTE = "先在 Cliora 确认";
export const COMPLETION_VERIFY_NOTE = "结果待 Cliora 复核";

const DEFAULT_LOCK_REASON = "当前有操作正在进行，稍后再试。";
const REMOTE_FEEDBACK_REASON = "远程审查来源暂不支持送回意见，可以直接返回 Cliora。";

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function gitItem(result: ReviewGitResult): ReviewCompletionStatusItem {
  if (result.kind === "committed") return { id: "git", label: `已提交 ${shortOid(result.oid)}（待复核）`, tone: "neutral" };
  if (result.kind === "merged") return { id: "git", label: `已合入 ${shortOid(result.oid)}（待复核）`, tone: "neutral" };
  return { id: "git", label: "本次没有提交或合入", tone: "neutral" };
}

function worktreeItem(worktree: ReviewWorktreeState): ReviewCompletionStatusItem {
  if (worktree.state === "clean") return { id: "worktree", label: "工作区没有未提交的改动", tone: "neutral" };
  if (worktree.state === "dirty") {
    const label = worktree.count !== null && worktree.count > 0 ? `工作区还有 ${worktree.count} 个未提交的改动` : "工作区还有未提交的改动";
    return { id: "worktree", label, tone: "warn" };
  }
  return { id: "worktree", label: "没有读到工作区状态（按未知处理）", tone: "warn" };
}

export function reviewCompletion(input: ReviewCompletionInput): ReviewCompletionModel {
  if (input.source === "none") {
    return {
      primary: null,
      secondary: null,
      statusItems: [{ id: "source", label: "没有审查来源", tone: "neutral" }],
      detailItems: ["从 Cliora 发起审查后，这里会显示送回意见与返回入口。"],
      tone: "neutral",
    };
  }

  const comments = Math.max(0, input.commentCount);
  const unsent = Math.min(comments, Math.max(0, input.unsentCount ?? comments));
  const drafts = Math.max(0, input.draftCount);
  const stale = Math.max(0, input.staleCount);
  const preparing = input.handoff.state === "preparing";
  const returning = input.returnState.state === "returning";
  const busy = preparing || returning;
  const remote = input.source === "remote";

  const lockReason = input.writeLocked ? input.writeLockedReason || DEFAULT_LOCK_REASON : null;
  const busyReason = preparing ? "正在准备意见交接，请稍候。" : returning ? "正在返回 Cliora，请稍候。" : null;

  // 送回意见：远程来源不可用；没有意见时不作为动作出现。
  let feedback: ReviewCompletionAction | null = null;
  if (comments > 0) {
    const blocked = remote
      ? REMOTE_FEEDBACK_REASON
      : busyReason ?? lockReason ?? (input.canFeedback ? null : input.feedbackBlockedReason || "当前不能准备送回意见。");
    const label = preparing
      ? "正在准备…"
      : input.handoff.state === "failed"
        ? `重试送回 ${comments} 条意见`
        : unsent === 0
          ? `再次送回 ${comments} 条意见`
          : `送回 ${comments} 条意见`;
    feedback = {
      id: "feedback",
      label,
      disabled: blocked !== null,
      reason: blocked ?? `准备这 ${comments} 条意见并打开 Cliora 预览；${COMPLETION_CONFIRM_NOTE}后才会发送。`,
    };
  }

  const returnBlocked = busyReason ?? lockReason;
  const returnAction: ReviewCompletionAction = {
    id: "return",
    label: returning ? "正在返回…" : input.returnState.state === "failed" ? "重试返回 Cliora" : "返回 Cliora",
    disabled: returnBlocked !== null,
    reason: returnBlocked ?? `把 Git 结果与工作区状态带回 Cliora；${COMPLETION_VERIFY_NOTE}。`,
  };

  // 有尚未送回的意见（且本地来源）时，送回是主动作；否则返回是主动作。
  const feedbackFirst = feedback !== null && !remote && unsent > 0;
  const primary = feedbackFirst ? feedback : returnAction;
  const secondary = feedbackFirst ? returnAction : feedback;

  const statusItems: ReviewCompletionStatusItem[] = [];
  if (comments > 0) {
    statusItems.push({
      id: "comments",
      label: unsent > 0 && unsent < comments ? `${comments} 条意见（${unsent} 条未送回）` : `${comments} 条意见`,
      tone: "neutral",
    });
  } else if (!remote) {
    statusItems.push({ id: "comments", label: "没有待送回的意见", tone: "neutral" });
  }
  if (drafts > 0) statusItems.push({ id: "drafts", label: `${drafts} 条草稿未保存`, tone: "warn" });
  if (stale > 0) statusItems.push({ id: "stale", label: `${stale} 条意见已失效，不会送回`, tone: "warn" });

  if (input.handoff.state === "preparing") {
    statusItems.push({ id: "handoff", label: "正在准备意见交接…", tone: "info" });
  } else if (input.handoff.state === "prepared") {
    statusItems.push({
      id: "handoff",
      label: `已准备 ${input.handoff.commentCount} 条意见，已打开 Cliora 等待确认`,
      tone: "success",
    });
  } else if (input.handoff.state === "failed") {
    statusItems.push({ id: "handoff", label: "意见没有准备好，Cliora 没有被唤起；意见仍保留", tone: "error" });
  }

  statusItems.push(gitItem(input.gitResult));
  statusItems.push(worktreeItem(input.worktree));

  if (input.returnState.state === "returning") {
    statusItems.push({ id: "return", label: "正在返回 Cliora…", tone: "info" });
  } else if (input.returnState.state === "returned") {
    statusItems.push({ id: "return", label: `已返回 Cliora（第 ${input.returnState.revision} 次），${COMPLETION_VERIFY_NOTE}`, tone: "success" });
  } else if (input.returnState.state === "failed") {
    statusItems.push({ id: "return", label: "没有返回 Cliora；意见与草稿仍保留，可以重试", tone: "error" });
  }

  const detailItems: string[] = [COMPLETION_CONFIRM_NOTE, COMPLETION_VERIFY_NOTE];
  if (input.handoff.state === "prepared") detailItems.push(`交接批次 ${input.handoff.feedbackId.slice(0, 8)}，只在 Cliora 预览里确认后才会发送。`);
  if (input.handoff.state === "failed" && input.handoff.message) detailItems.push(`准备失败：${input.handoff.message}`);
  if (input.returnState.state === "failed" && input.returnState.message) detailItems.push(`返回失败：${input.returnState.message}`);
  if (remote) detailItems.push(REMOTE_FEEDBACK_REASON);
  if (input.gitResult.kind !== "none") detailItems.push(`完整提交 ${input.gitResult.oid}`);
  if (lockReason) detailItems.push(lockReason);
  if (!remote && comments > 0 && !input.canFeedback && input.feedbackBlockedReason) detailItems.push(input.feedbackBlockedReason);

  const tone: ReviewCompletionTone =
    input.handoff.state === "failed" || input.returnState.state === "failed"
      ? "error"
      : busy
        ? "info"
        : drafts > 0 || stale > 0
          ? "warn"
          : input.handoff.state === "prepared" || input.returnState.state === "returned"
            ? "success"
            : "neutral";

  return { primary, secondary, statusItems, detailItems, tone };
}

/** 完成栏全部可见文案（测试与审计用）。 */
export function completionTexts(model: ReviewCompletionModel): string[] {
  return [
    model.primary?.label,
    model.primary?.reason,
    model.secondary?.label,
    model.secondary?.reason,
    ...model.statusItems.map((item) => item.label),
    ...model.detailItems,
  ].filter((text): text is string => typeof text === "string" && text !== "");
}
