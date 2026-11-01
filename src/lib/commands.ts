import { MODIFIER_LABEL } from "./brand";
import type { RecentRepo, TaskModal, Theme, WorkspaceView } from "./types";

/**
 * 动作注册表：标题栏、rail、溢出菜单与命令面板都从这里取同一份 id、名称与可用性判断，
 * 四处只是同一条命令的不同入口，因此结果不会分叉（R11）。
 *
 * 本文件保持纯函数：它只描述「有哪些命令、什么时候可用」，
 * 真正执行由外壳的 runCommand(id) 决定。
 *
 * 排列约束：同一 group 的命令必须连续。命令面板按「组首次出现」的次序展开 DOM，
 * 组在注册表里交错排列会让 DOM 序与过滤序分叉（面板的方向键按后者移动），
 * 于是高亮与键盘焦点会指向不同条目。
 */
export type CommandGroup = "视图" | "提交" | "同步" | "任务" | "仓库" | "外观" | "界面";

export interface CommandState {
  hasRepo: boolean;
  workspaceView: WorkspaceView;
  taskModal: TaskModal | null;
  navCollapsed: boolean;
  writeLocked: boolean;
  /** 仅指「有写操作在飞行中」：读取期间仍允许切换仓库，写操作期间不允许。 */
  writing: boolean;
  upstreamMissing: boolean;
  /** 提交范围口径的已暂存文件数，与提交区 paths.length 同源。 */
  stagedCount: number;
  /** 「全部暂存」的精确目标：列表当前可见、未暂存且非冲突的文件路径。 */
  stageTargets: string[];
  /** 「全部取消暂存」的精确目标：列表当前可见、已暂存且非冲突的文件路径。 */
  unstageTargets: string[];
  draft: string;
  theme: Theme;
  recentRepos: RecentRepo[];
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
const idleReason = () => "正在写入，稍后再试";

/**
 * 提交可用性与提交区按钮同源：暂存区非空且草稿非空（CommitDraft 的 ready 条件）。
 * 面板里因此不会出现「按钮是灰的、面板里却看起来能点」的分叉（R11）。
 */
const canCommit = (state: CommandState) =>
  hasRepo(state) && idle(state) && state.stagedCount > 0 && state.draft.trim().length > 0;
const commitReason = (state: CommandState) => {
  if (!state.hasRepo) return "先打开一个仓库";
  if (state.writeLocked) return "正在写入，稍后再试";
  return state.stagedCount === 0 ? "先暂存要提交的文件" : "填写提交说明后即可提交";
};

/** 视图与提交：主工作台的两个视图、提交范围、全部暂存/全部取消暂存与两种提交。 */
const VIEW_COMMANDS: CommandSpec[] = [
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
];

const COMMIT_COMMANDS: CommandSpec[] = [
  {
    id: "task.scope",
    group: "提交",
    title: "本次提交范围",
    hint: "查看将要提交的全部路径",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "stage.all",
    group: "提交",
    title: "全部暂存",
    hint: "暂存列表中所有未暂存文件",
    available: (state) => hasRepo(state) && idle(state) && state.stageTargets.length > 0,
    reason: (state) => {
      if (!state.hasRepo) return "先打开一个仓库";
      if (state.writeLocked) return "正在写入，稍后再试";
      return "没有可暂存的改动";
    },
  },
  {
    id: "unstage.all",
    group: "提交",
    title: "全部取消暂存",
    hint: "把已暂存文件移回未暂存",
    available: (state) => hasRepo(state) && idle(state) && state.unstageTargets.length > 0,
    reason: (state) => {
      if (!state.hasRepo) return "先打开一个仓库";
      if (state.writeLocked) return "正在写入，稍后再试";
      return "暂存区是空的";
    },
  },
  {
    id: "commit.local",
    group: "提交",
    title: "提交到本地",
    hint: "只创建本地提交，不推送",
    shortcut: `${MODIFIER_LABEL} ↵`,
    available: canCommit,
    reason: commitReason,
  },
  {
    id: "commit.push",
    group: "提交",
    title: "提交并推送",
    hint: "提交后再单独推送",
    available: canCommit,
    reason: commitReason,
  },
];

const SYNC_COMMANDS: CommandSpec[] = [
  {
    id: "task.publish",
    group: "同步",
    title: "发布分支",
    hint: "推送一次并建立上游关联",
    available: (state) => state.hasRepo && state.upstreamMissing,
    reason: () => "当前分支已有上游",
  },
  {
    id: "sync.fetch",
    group: "同步",
    title: "获取更新",
    hint: "只下载远程信息，不改文件",
    available: (state) => hasRepo(state) && idle(state),
    reason: idleReason,
  },
  {
    id: "sync.pull",
    group: "同步",
    title: "拉取",
    hint: "快进拉取，不自动合并分叉",
    available: (state) => hasRepo(state) && idle(state),
    reason: idleReason,
  },
  {
    id: "sync.push",
    group: "同步",
    title: "推送",
    hint: "不强行推送",
    available: (state) => hasRepo(state) && idle(state),
    reason: idleReason,
  },
];

const TASK_COMMANDS: CommandSpec[] = [
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
    id: "task.settings",
    group: "任务",
    title: "设置",
    hint: "外观与运行环境",
    available: () => true,
  },
];

const REPO_COMMANDS: CommandSpec[] = [
  {
    id: "repo.add",
    group: "仓库",
    title: "添加仓库",
    hint: "打开一个本地仓库",
    available: idle,
    reason: idleReason,
  },
  {
    id: "repo.clone",
    group: "仓库",
    title: "克隆仓库",
    hint: "克隆到新目录并打开",
    available: idle,
    reason: idleReason,
  },
  {
    id: "repo.create",
    group: "仓库",
    title: "新建仓库",
    hint: "在目录中初始化，确认前不写入",
    available: idle,
    reason: idleReason,
  },
  {
    id: "repo.copyPath",
    group: "仓库",
    title: "复制路径",
    hint: "复制当前仓库的完整路径",
    available: hasRepo,
    reason: hasRepoReason,
  },
];

const THEME_COMMANDS: CommandSpec[] = [
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
];

const SHELL_COMMANDS: CommandSpec[] = [
  {
    id: "view.refresh",
    group: "界面",
    title: "刷新工作区",
    hint: "重新读取状态与当前差异",
    shortcut: `${MODIFIER_LABEL} R`,
    available: (state) => hasRepo(state) && idle(state),
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
    id: "dialog.dependencies",
    group: "界面",
    title: "运行依赖",
    hint: "Git 与 WebView2 的安装说明",
    available: () => true,
  },
];

/** 静态部分：标题栏、溢出菜单与键盘层按 id 查的就是这一份。 */
export const COMMANDS: CommandSpec[] = [
  ...VIEW_COMMANDS,
  ...COMMIT_COMMANDS,
  ...SYNC_COMMANDS,
  ...TASK_COMMANDS,
  ...REPO_COMMANDS,
  ...THEME_COMMANDS,
  ...SHELL_COMMANDS,
];

/** 仓库切换类命令的 id 前缀，后面直接接仓库路径。 */
export const REPO_SWITCH_PREFIX = "repo.switch:";

/**
 * 切换仓库：最近仓库每个一条命令，动作与标题栏仓库菜单里的同名条目相同（都走 openRecent）。
 * 这些命令依赖运行时数据，所以由状态推导，不放进静态注册表。
 *
 * 可用性只看「有没有写操作在飞行中」：读取期间按界面提示仍允许切换仓库，
 * 但写操作期间 openRecent 会直接返回，面板在这里必须说清原因而不是静默失败（R11）。
 */
export function repoSwitchCommands(state: CommandState): CommandSpec[] {
  // 命令 id 里带仓库路径，而命令面板用 id 做 keyed each：同一路径只保留一条。
  const seen = new Set<string>();
  const repos = state.recentRepos.filter((repo) => {
    if (seen.has(repo.path)) return false;
    seen.add(repo.path);
    return true;
  });
  return repos.map((repo) => ({
    id: `${REPO_SWITCH_PREFIX}${repo.path}`,
    group: "仓库" as const,
    title: `切换到 ${repo.name}`,
    hint: repo.path,
    available: (current: CommandState) => !current.writing,
    reason: idleReason,
  }));
}

/** 仓库组在静态表里的结束位置：动态仓库切换命令插在这里，保持同组连续。 */
const REPO_BLOCK_END = COMMANDS.reduce(
  (end, command, index) => (command.group === "仓库" ? index + 1 : end),
  0,
);

/** 某一时刻完整的命令集：静态表 + 按状态推导的仓库切换命令。 */
export function allCommands(state: CommandState): CommandSpec[] {
  return [
    ...COMMANDS.slice(0, REPO_BLOCK_END),
    ...repoSwitchCommands(state),
    ...COMMANDS.slice(REPO_BLOCK_END),
  ];
}

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
  return allCommands(state).map((command) => {
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
