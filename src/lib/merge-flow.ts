/**
 * 合并工作流的纯逻辑：步骤条、完成页的推送状态与冲突文件右键菜单。
 * 只做推导，不读写仓库；组件负责把结果画出来并接上真正的动作。
 */
import type { ContextMenuEntry } from "./components/ContextMenu.svelte";
import { hasConflictMarkers } from "./conflict";
import type { BranchInfo } from "./types";

export type MergeStepId = "choose" | "resolve" | "done";
export type MergeStepState = "done" | "current" | "upcoming" | "skipped";

export interface MergeStep {
  id: MergeStepId;
  label: string;
  state: MergeStepState;
}

export interface MergeStepInput {
  /** 当前会话操作：none / merge / rebase / cherry-pick / revert / unmerged。 */
  operation: string;
  /** 已进入完成页。 */
  finished: boolean;
  /** 完成时是否经历过冲突（有已解决的文件）。 */
  hadConflicts?: boolean;
  /** 合并前预检的结论：true 预计有冲突，false 确定没有，undefined 还不知道。 */
  expectConflicts?: boolean;
}

/**
 * 三步：选择分支 → 解决冲突 → 完成。没有冲突的合并会越过第二步（标为跳过），
 * 用户随时知道自己在哪一步、后面还剩什么。
 */
export function mergeSteps(input: MergeStepInput): MergeStep[] {
  const resolve = "解决冲突";
  if (input.finished) {
    return [
      { id: "choose", label: "选择分支", state: "done" },
      { id: "resolve", label: resolve, state: input.hadConflicts ? "done" : "skipped" },
      { id: "done", label: "完成", state: "current" },
    ];
  }
  if (input.operation !== "none") {
    return [
      { id: "choose", label: "选择分支", state: "done" },
      { id: "resolve", label: resolve, state: "current" },
      { id: "done", label: "完成", state: "upcoming" },
    ];
  }
  return [
    { id: "choose", label: "选择分支", state: "current" },
    { id: "resolve", label: resolve, state: input.expectConflicts === false ? "skipped" : "upcoming" },
    { id: "done", label: "完成", state: "upcoming" },
  ];
}

export type PushStateKind = "pushed" | "ahead" | "no-upstream" | "rewritten" | "elsewhere";

export interface PushState {
  kind: PushStateKind;
  text: string;
  /** 可以直接在完成页推送。 */
  canPush: boolean;
}

/**
 * 完成页的推送状态。只有当前检出的就是合并目标时才能从快照读出领先数；
 * 变基改写了历史，普通推送会被拒绝，这里不提供推送按钮。
 */
export function pushState(branch: BranchInfo, target: string, rewritten: boolean): PushState {
  if (branch.detached || branch.unborn || branch.name !== target) {
    return { kind: "elsewhere", text: `结果在 ${target} 上，切换到它之后再推送`, canPush: false };
  }
  if (rewritten) {
    return { kind: "rewritten", text: "历史已改写，需要强制推送，请在同步菜单里处理", canPush: false };
  }
  if (!branch.upstream) {
    return { kind: "no-upstream", text: "这个分支还没有发布到远程", canPush: false };
  }
  const ahead = branch.ahead ?? 0;
  if (ahead > 0) {
    return { kind: "ahead", text: `尚未推送 · 领先 ${branch.upstream} ${ahead} 个提交`, canPush: true };
  }
  return { kind: "pushed", text: `已推送 · 与 ${branch.upstream} 一致`, canPush: false };
}

export interface ConflictMenuHandlers {
  open?: () => void;
  takeOurs?: () => void;
  takeTheirs?: () => void;
  markResolved?: () => void;
  openExternal?: () => void;
  reveal?: () => void;
  copyPath?: () => void;
}

export interface ConflictMenuInput {
  /** 已标记为已解决的文件只保留查看类操作。 */
  resolved: boolean;
  /** 写入进行中等原因：写入类条目灰显并写明原因。 */
  busyReason?: string | null;
  /** 「当前」与「来源」两侧的分支名。 */
  currentLabel: string;
  incomingLabel: string;
  /** 在文件管理器中显示的平台文案。 */
  revealLabel?: string;
  externalLabel?: string;
}

export function revealLabel(platform = typeof navigator !== "undefined" ? navigator.platform ?? "" : ""): string {
  return platform.toLowerCase().includes("mac") ? "在访达中显示" : "在文件管理器中显示";
}

/**
 * 冲突文件的右键菜单。写入类条目（采用一侧、标记已解决）始终列出，不可用时灰显并写明原因；
 * 查看类条目（打开、在文件管理器中显示、复制路径）不受写入锁影响。
 */
export function conflictFileMenu(input: ConflictMenuInput, handlers: ConflictMenuHandlers): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];
  const busy = input.busyReason ?? undefined;
  if (!input.resolved) {
    if (handlers.open) entries.push({ id: "open", label: "打开并逐处解决", icon: "file-diff", disabledReason: busy, run: handlers.open });
    entries.push({ separator: true });
    if (handlers.takeOurs) {
      entries.push({ id: "ours", label: `整个文件采用当前（${input.currentLabel}）`, icon: "arrow-left", disabledReason: busy, run: handlers.takeOurs });
    }
    if (handlers.takeTheirs) {
      entries.push({ id: "theirs", label: `整个文件采用来源（${input.incomingLabel}）`, icon: "arrow-right", disabledReason: busy, run: handlers.takeTheirs });
    }
    if (handlers.markResolved) {
      entries.push({ id: "mark", label: "按工作区内容标记为已解决", icon: "check-circle", disabledReason: busy, run: handlers.markResolved });
    }
    entries.push({ separator: true });
  }
  if (handlers.openExternal) entries.push({ id: "external", label: input.externalLabel ?? "用默认程序打开", icon: "file", run: handlers.openExternal });
  if (handlers.reveal) entries.push({ id: "reveal", label: input.revealLabel ?? revealLabel(), icon: "folder-open", run: handlers.reveal });
  if (handlers.copyPath) entries.push({ id: "copy", label: "复制路径", icon: "copy", run: handlers.copyPath });
  return tidySeparators(entries);
}

/** 去掉开头、结尾和连续的分隔线：某些条目缺席时菜单里不留空行。 */
function tidySeparators(entries: ContextMenuEntry[]): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  for (const entry of entries) {
    const separator = "separator" in entry;
    if (separator && (out.length === 0 || "separator" in out[out.length - 1])) continue;
    out.push(entry);
  }
  while (out.length > 0 && "separator" in out[out.length - 1]) out.pop();
  return out;
}

/**
 * 「按工作区内容标记」的守卫：结果里还有冲突标记时不写入，避免把 <<<<<<< 当成结论提交。
 */
export function markerFreeText(text: string | null | undefined): text is string {
  return typeof text === "string" && !hasConflictMarkers(text);
}
