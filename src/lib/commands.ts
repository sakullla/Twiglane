import { MODIFIER_LABEL } from "./brand";
import type { TaskModal, Theme, WorkspaceView } from "./types";

/**
 * 动作注册表：标题栏、rail、溢出菜单与命令面板都从这里取同一份 id、名称与可用性判断，
 * 四处只是同一条命令的不同入口，因此结果不会分叉（R11）。
 *
 * 本文件保持纯函数：它只描述「有哪些命令、什么时候可用」，
 * 真正执行由外壳的 runCommand(id) 决定。
 */
export type CommandGroup = "视图" | "任务" | "提交" | "同步" | "仓库" | "外观" | "界面";

export interface CommandState {
  hasRepo: boolean;
  workspaceView: WorkspaceView;
  taskModal: TaskModal | null;
  navCollapsed: boolean;
  writeLocked: boolean;
  upstreamMissing: boolean;
  stagedCount: number;
  draft: string;
  theme: Theme;
}

export interface CommandSpec {
  id: string;
  group: CommandGroup;
  title: string;
  /** 一行以内的补充说明，标题栏菜单、rail 提示与命令面板共用。 */
  hint: string;
  shortcut?: string;
  available: (state: CommandState) => boolean;
  reason?: (state: CommandState) => string;
}

const hasRepo = (state: CommandState) => state.hasRepo;
const hasRepoReason = () => "先打开一个仓库";
const idle = (state: CommandState) => !state.writeLocked;

export const COMMANDS: CommandSpec[] = [
  {
    id: "view.changes",
    group: "视图",
    title: "改动",
    hint: "同屏看文件列表与差异",
    shortcut: `${MODIFIER_LABEL} 1`,
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "view.history",
    group: "视图",
    title: "提交历史",
    hint: "浏览提交，不改动工作区",
    shortcut: `${MODIFIER_LABEL} 2`,
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "task.stash",
    group: "任务",
    title: "临时保存",
    hint: "收起未完成的工作",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "task.merge",
    group: "任务",
    title: "分支合并",
    hint: "预览影响并处理冲突",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "task.branch",
    group: "任务",
    title: "分支与标签",
    hint: "切换、创建、删除与标签同层",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "task.remote",
    group: "任务",
    title: "远程",
    hint: "查看与修改远程地址",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "task.scope",
    group: "提交",
    title: "本次提交范围",
    hint: "查看将要提交的全部路径",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "task.publish",
    group: "同步",
    title: "发布分支",
    hint: "推送一次并建立上游关联",
    available: (state) => state.hasRepo && state.upstreamMissing,
    reason: () => "当前分支已有上游",
  },
  {
    id: "task.settings",
    group: "任务",
    title: "设置",
    hint: "外观与运行环境",
    available: () => true,
  },
  {
    id: "commit.local",
    group: "提交",
    title: "提交到本地",
    hint: "只创建本地提交，不推送",
    shortcut: `${MODIFIER_LABEL} ↵`,
    available: (state) => hasRepo(state) && idle(state),
    reason: (state) => (!state.hasRepo ? "先打开一个仓库" : "正在写入，稍后再试"),
  },
  {
    id: "commit.push",
    group: "提交",
    title: "提交并推送",
    hint: "提交后再单独推送",
    available: (state) => hasRepo(state) && idle(state),
    reason: (state) => (!state.hasRepo ? "先打开一个仓库" : "正在写入，稍后再试"),
  },
  {
    id: "sync.fetch",
    group: "同步",
    title: "获取更新",
    hint: "只下载远程信息，不改文件",
    available: (state) => hasRepo(state) && idle(state),
    reason: () => "正在写入，稍后再试",
  },
  {
    id: "sync.pull",
    group: "同步",
    title: "拉取",
    hint: "快进拉取，不自动合并分叉",
    available: (state) => hasRepo(state) && idle(state),
    reason: () => "正在写入，稍后再试",
  },
  {
    id: "sync.push",
    group: "同步",
    title: "推送",
    hint: "不强行推送",
    available: (state) => hasRepo(state) && idle(state),
    reason: () => "正在写入，稍后再试",
  },
  {
    id: "view.refresh",
    group: "界面",
    title: "刷新工作区",
    hint: "重新读取状态与当前差异",
    shortcut: `${MODIFIER_LABEL} R`,
    available: (state) => hasRepo(state) && !state.writeLocked,
    reason: (state) => (state.hasRepo ? "正在写入，稍后再试" : "先打开一个仓库"),
  },
  {
    id: "rail.toggle",
    group: "界面",
    title: "折叠侧栏",
    hint: "折叠为仅图标形态",
    shortcut: `${MODIFIER_LABEL} B`,
    available: () => true,
  },
  {
    id: "palette.open",
    group: "界面",
    title: "命令面板",
    hint: "搜索并执行任一动作",
    shortcut: `${MODIFIER_LABEL} K`,
    available: () => true,
  },
  {
    id: "repo.add",
    group: "仓库",
    title: "添加仓库",
    hint: "打开一个本地仓库",
    available: (state) => !state.writeLocked,
    reason: () => "正在写入，稍后再试",
  },
  {
    id: "repo.clone",
    group: "仓库",
    title: "克隆仓库",
    hint: "克隆到新目录并打开",
    available: (state) => !state.writeLocked,
    reason: () => "正在写入，稍后再试",
  },
  {
    id: "repo.create",
    group: "仓库",
    title: "新建仓库",
    hint: "在目录中初始化，确认前不写入",
    available: (state) => !state.writeLocked,
    reason: () => "正在写入，稍后再试",
  },
  {
    id: "theme.light",
    group: "外观",
    title: "浅色外观",
    hint: "固定使用浅色",
    available: (state) => state.theme !== "light",
    reason: () => "已经是浅色",
  },
  {
    id: "theme.dark",
    group: "外观",
    title: "深色外观",
    hint: "固定使用深色",
    available: (state) => state.theme !== "dark",
    reason: () => "已经是深色",
  },
  {
    id: "theme.system",
    group: "外观",
    title: "跟随系统外观",
    hint: "按系统的浅深设置切换",
    available: (state) => state.theme !== "system",
    reason: () => "已经跟随系统",
  },
  {
    id: "dialog.dependencies",
    group: "界面",
    title: "运行依赖",
    hint: "Git 与 WebView2 的安装说明",
    available: () => true,
  },
];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

export function commandById(id: string): CommandSpec | undefined {
  return BY_ID.get(id);
}

export function commandAvailable(command: CommandSpec, state: CommandState): boolean {
  return command.available(state);
}

export function commandReason(command: CommandSpec, state: CommandState): string {
  if (commandAvailable(command, state)) return "";
  return command.reason?.(state) ?? "当前不可用";
}

/** 命令面板条目：与其它入口同源，只是多了「为什么不可用」的就地说明。 */
export interface PaletteItem {
  id: string;
  group: string;
  title: string;
  shortcut?: string;
  enabled: boolean;
  reason?: string;
}

export function paletteItems(state: CommandState): PaletteItem[] {
  return COMMANDS.map((command) => {
    const enabled = commandAvailable(command, state);
    return {
      id: command.id,
      group: command.group,
      title: command.title,
      shortcut: command.shortcut,
      enabled,
      reason: enabled ? undefined : commandReason(command, state),
    };
  });
}

/** 改动视图的溢出菜单：低频动作集中在这里，不占首屏。 */
export const OVERFLOW_COMMAND_IDS = [
  "task.scope",
  "task.publish",
  "sync.fetch",
  "sync.pull",
  "sync.push",
  "dialog.dependencies",
] as const;
