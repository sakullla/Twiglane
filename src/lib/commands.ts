import { hasCommitSummary } from "./ui";
import type { IconName } from "./icons";
import { MODIFIER_LABEL } from "./brand";
import type { RecentRepo, TaskModal, Theme, WorkspaceView } from "./types";

/**
 * 动作注册表：标题栏、左栏、溢出菜单与命令面板都从这里取同一份 id、名称与可用性判断，
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
  sidebarHidden: boolean;
  writeLocked: boolean;
  /**
   * 仅指「有写操作在飞行中」（暂存、提交、同步等），不含「正在读取仓库」与「差异续读」。
   * 它只影响不可用原因的措辞，不再决定切换仓库是否可用。
   */
  writing: boolean;
  /** 有读取在飞行中（读取仓库或续读差异）：它只锁写动作，不锁切换仓库。 */
  reading: boolean;
  /**
   * 切换仓库会不会被外壳拒绝：等价于「有任意操作在飞行中」（写、克隆，或差异续读）。
   * 它是 openRecent 的执行 guard 与三个入口共用的唯一判定——只读整仓库时它仍为假，
   * 因为那时切换是「取消上一次读取」的文档化路径，外壳会取消旧读取再打开新仓库（R11）。
   */
  switchingBlocked: boolean;
  upstreamMissing: boolean;
  /** 提交范围口径的已暂存文件数，与提交区 paths.length 同源。 */
  stagedCount: number;
  /** 「全部暂存」的精确目标：列表当前可见、未暂存且非冲突的文件路径。 */
  stageTargets: string[];
  /** 「全部取消暂存」的精确目标：列表当前可见、已暂存且非冲突的文件路径。 */
  unstageTargets: string[];
  /** 当前视图的上一个/下一个文件：null 表示这里没有文件可切，原因字段非空表示到头了。 */
  fileNav?: { prevReason: string | null; nextReason: string | null } | null;
  /** 单文件差异里的上一处/下一处改动。null 表示当前视图不是可跳转的单文件差异。 */
  hunkNav?: { prevReason: string | null; nextReason: string | null } | null;
  /** 改动视图正在多选：逐块跳转让位给文件之间的切换。 */
  multiFile?: boolean;
  draft: string;
  theme: Theme;
  recentRepos: RecentRepo[];
  /** 当前打开的仓库路径：命令面板里标出「当前仓库」，切换命令仍可用于重新读取。 */
  currentRepoPath?: string | null;
  /** 改动视图当前选中的文件：「在文件树中显示」以它为目标。 */
  currentFilePath?: string | null;
  /** 设置里是否显示文件视图；缺省为显示。关闭时文件视图的入口都不可用。 */
  filesViewEnabled?: boolean;
  /** 文件视图的本次会话返回/前进：其它视图为 null。 */
  fileHistory?: { backReason: string | null; forwardReason: string | null } | null;
}

export interface CommandSpec {
  id: string;
  group: CommandGroup;
  title: string;
  /** 一行以内的补充说明，标题栏菜单与命令面板共用。 */
  hint: string;
  /**
   * 只参与命令面板过滤、不显示的检索词（例如切换仓库时带上仓库路径）。
   * 面板的过滤串是 title + group + keywords，界面文案仍只看 title 与 hint。
   */
  keywords?: string;
  /**
   * 命令面板选项上的一行弱化补充（不进可访问名称的主体判断）。
   * 只给需要区分的条目：同名仓库带路径，当前仓库带「当前仓库」。
   */
  detail?: string;
  shortcut?: string;
  available: (state: CommandState) => boolean;
  reason?: (state: CommandState) => string;
}

const hasRepo = (state: CommandState) => state.hasRepo;
const hasRepoReason = () => "先打开一个仓库";
/** 文件视图的入口：要有仓库，并且没在设置里关闭文件视图。 */
export const FILES_VIEW_OFF = "文件视图已在设置里关闭";
const filesAvailable = (state: CommandState) => state.hasRepo && state.filesViewEnabled !== false;
const filesReason = (state: CommandState) => (state.hasRepo ? FILES_VIEW_OFF : "先打开一个仓库");
const idle = (state: CommandState) => !state.writeLocked;

/**
 * 忙碌原因：写与读分开说。
 * 以前一律报「正在写入」，可是差异续读、仓库读取期间写动作同样是灰的，
 * 把它们也说成「正在写入」会让 R11 的原因失真。
 */
function busyReason(state: CommandState): string {
  if (state.writing) return "正在写入，稍后再试";
  if (state.reading) return "正在读取，稍后再试";
  return "先等当前操作结束";
}

/** 有仓库 + 空闲才可用的命令：没仓库时说仓库，有仓库说在读还是在写。 */
const repoBusyReason = (state: CommandState) => (state.hasRepo ? busyReason(state) : "先打开一个仓库");

/**
 * 切换仓库的唯一判定（R11）：标题栏仓库弹层与命令面板都读它，
 * 外壳的 openRecent 也用同一个判定提前返回并说明原因，
 * 否则差异续读期间点下去什么都不发生。
 */
export const switchBlocked = (state: CommandState) => state.switchingBlocked;

/** 被拒的原因与外层一致：写操作说写入，差异续读说读取（R11 要求说清为什么）。 */
export const switchBlockedReason = (state: CommandState) => busyReason(state);

/**
 * 提交可用性与提交区按钮同源：暂存区非空且草稿非空（CommitDraft 的 ready 条件）。
 * 面板里因此不会出现「按钮是灰的、面板里却看起来能点」的分叉（R11）。
 */
const canCommit = (state: CommandState) =>
  hasRepo(state) && idle(state) && state.stagedCount > 0 && hasCommitSummary(state.draft);
const commitReason = (state: CommandState) => {
  if (!state.hasRepo) return "先打开一个仓库";
  if (state.writeLocked) return busyReason(state);
  return state.stagedCount === 0 ? "先暂存要提交的文件" : "填写提交说明后即可提交";
};

const NO_FILE_REASON = "先选择一个文件";
/** Alt 在 macOS 键帽上是 ⌥。 */
const ALT_LABEL = MODIFIER_LABEL === "⌘" ? "⌥" : "Alt";
const HUNK_MULTI = "多选时在文件之间切换，回到单个文件后可以逐块跳转";
const HUNK_ABSENT = "当前没有可跳转的改动块";

function hunkSide(state: CommandState, side: "prev" | "next"): { ok: boolean; reason: string } {
  if (!state.hasRepo) return { ok: false, reason: "先打开一个仓库" };
  if (state.multiFile) return { ok: false, reason: HUNK_MULTI };
  const nav = state.hunkNav;
  if (!nav) return { ok: false, reason: HUNK_ABSENT };
  const reason = side === "prev" ? nav.prevReason : nav.nextReason;
  return { ok: reason === null, reason: reason ?? HUNK_ABSENT };
}

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
    /**
     * 文件是第三个保活视图，但在切换条里排在改动与历史之间（改动 / 文件 / 历史）。
     * 数字键仍按原有序列追加：1 改动、2 历史保持不变，文件用 3。
     */
    id: "view.files",
    group: "视图",
    title: "文件",
    hint: "按目录浏览仓库中的文件，只读预览内容",
    shortcut: `${MODIFIER_LABEL} 3`,
    available: filesAvailable,
    reason: filesReason,
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
    id: "file.prev",
    group: "视图",
    title: "上一个文件",
    hint: "按列表顺序切到上一个文件，多选时在选中文件之间切换",
    shortcut: `${ALT_LABEL} ←`,
    available: (state) => hasRepo(state) && Boolean(state.fileNav) && !state.fileNav?.prevReason,
    reason: (state) => (state.hasRepo ? (state.fileNav?.prevReason ?? NO_FILE_REASON) : "先打开一个仓库"),
  },
  {
    id: "file.next",
    group: "视图",
    title: "下一个文件",
    hint: "按列表顺序切到下一个文件，多选时在选中文件之间切换",
    shortcut: `${ALT_LABEL} →`,
    available: (state) => hasRepo(state) && Boolean(state.fileNav) && !state.fileNav?.nextReason,
    reason: (state) => (state.hasRepo ? (state.fileNav?.nextReason ?? NO_FILE_REASON) : "先打开一个仓库"),
  },
  {
    id: "diff.hunk.prev",
    group: "视图",
    title: "上一处改动",
    hint: "滚到当前差异里上一处改动块的开头",
    shortcut: `${ALT_LABEL} ↑`,
    available: (state) => hunkSide(state, "prev").ok,
    reason: (state) => hunkSide(state, "prev").reason,
  },
  {
    id: "diff.hunk.next",
    group: "视图",
    title: "下一处改动",
    hint: "滚到当前差异里下一处改动块的开头",
    shortcut: `${ALT_LABEL} ↓`,
    available: (state) => hunkSide(state, "next").ok,
    reason: (state) => hunkSide(state, "next").reason,
  },
  {
    id: "view.find",
    group: "视图",
    title: "聚焦搜索",
    hint: "把焦点放到当前视图的搜索框",
    shortcut: `${MODIFIER_LABEL} F`,
    available: () => true,
  },
  {
    /** 路径快速打开与全文搜索是两个入口：一个只查路径，一个查工作区文本。 */
    id: "files.quickOpen",
    group: "视图",
    title: "按路径打开文件",
    hint: "输入路径片段，在文件视图里直接打开这个文件",
    shortcut: `${MODIFIER_LABEL} P`,
    available: filesAvailable,
    reason: filesReason,
  },
  {
    id: "files.search",
    group: "视图",
    title: "全仓库搜索",
    hint: "在工作区文本里查找固定字符串，结果按文件分组",
    available: filesAvailable,
    reason: filesReason,
  },
  {
    id: "file.reveal",
    group: "视图",
    title: "在文件树中显示",
    hint: "展开目录并定位到改动列表里选中的文件",
    available: (state) => filesAvailable(state) && Boolean(state.currentFilePath),
    reason: (state) => (filesAvailable(state) ? "先在改动里选择一个文件" : filesReason(state)),
  },
  {
    id: "file.back",
    group: "视图",
    title: "后退",
    hint: "回到本次会话上一个打开的文件",
    shortcut: `${MODIFIER_LABEL} ⇧ ←`,
    available: (state) => Boolean(state.fileHistory) && !state.fileHistory?.backReason,
    reason: (state) => state.fileHistory?.backReason ?? "文件视图里才有打开历史",
  },
  {
    id: "file.forward",
    group: "视图",
    title: "前进",
    hint: "回到本次会话下一个打开的文件",
    shortcut: `${MODIFIER_LABEL} ⇧ →`,
    available: (state) => Boolean(state.fileHistory) && !state.fileHistory?.forwardReason,
    reason: (state) => state.fileHistory?.forwardReason ?? "文件视图里才有打开历史",
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
      if (state.writeLocked) return busyReason(state);
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
      if (state.writeLocked) return busyReason(state);
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
    reason: repoBusyReason,
  },
  {
    id: "sync.pull",
    group: "同步",
    title: "拉取",
    hint: "能快进就快进；分叉时再选择合并或变基",
    available: (state) => hasRepo(state) && idle(state),
    reason: repoBusyReason,
  },
  {
    id: "sync.push",
    group: "同步",
    title: "推送",
    hint: "不强行推送",
    available: (state) => hasRepo(state) && idle(state),
    reason: repoBusyReason,
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
    reason: busyReason,
  },
  {
    id: "repo.clone",
    group: "仓库",
    title: "克隆仓库",
    hint: "克隆到新目录并打开",
    available: idle,
    reason: busyReason,
  },
  {
    id: "repo.create",
    group: "仓库",
    title: "新建仓库",
    hint: "在目录中初始化，确认前不写入",
    available: idle,
    reason: busyReason,
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
    reason: repoBusyReason,
  },
  {
    id: "rail.toggle",
    group: "界面",
    title: "隐藏/显示侧栏",
    hint: "隐藏左栏让主内容铺满，再次执行恢复原宽度",
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
 * 切换仓库：最近仓库每个一条命令，动作与标题栏仓库弹层里的同名条目相同（都走 openRecent）。
 * 这些命令依赖运行时数据，所以由状态推导，不放进静态注册表。
 *
 * 可用性与 openRecent 的执行 guard 同源（switchBlocked）：有任意操作在飞行中时
 * 面板就地说明原因，而不是显示可点、按下却什么都不发生（R11）。
 */
export function repoSwitchCommands(state: CommandState): CommandSpec[] {
  // 命令 id 里带仓库路径，而命令面板用 id 做 keyed each：同一路径只保留一条。
  const seen = new Set<string>();
  const repos = state.recentRepos.filter((repo) => {
    if (seen.has(repo.path)) return false;
    seen.add(repo.path);
    return true;
  });
  // 同名仓库只看标题分不出是哪一个：给它们带上路径；其余仓库保持只显示名称。
  const nameCount = new Map<string, number>();
  for (const repo of repos) nameCount.set(repo.name, (nameCount.get(repo.name) ?? 0) + 1);
  return repos.map((repo) => {
    const isCurrent = state.currentRepoPath === repo.path;
    const parts = [isCurrent ? "当前仓库 · 重新读取" : "", (nameCount.get(repo.name) ?? 0) > 1 ? repo.path : ""].filter(Boolean);
    return {
      id: `${REPO_SWITCH_PREFIX}${repo.path}`,
      group: "仓库" as const,
      title: `切换到 ${repo.name}`,
      hint: repo.path,
      // 面板过滤要认路径：同名仓库靠路径区分，只按名称搜会分不出是哪一个（R11）。
      keywords: repo.path,
      detail: parts.length > 0 ? parts.join(" · ") : undefined,
      available: (current: CommandState) => !switchBlocked(current),
      reason: switchBlockedReason,
    };
  });
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
  /** 只参与过滤、不显示：仓库路径等不能进标题的检索词。 */
  keywords?: string;
  /** 选项上的弱化补充：同名仓库的路径、当前仓库标记。 */
  detail?: string;
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
      keywords: command.keywords,
      detail: command.detail,
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

/** 溢出菜单里每条动作的图标：菜单项要一眼看出是什么，不再统一用箭头。 */
export const OVERFLOW_COMMAND_ICONS: Record<(typeof OVERFLOW_COMMAND_IDS)[number], IconName> = {
  "task.scope": "layers",
  "task.publish": "upload",
  "sync.fetch": "download",
  "sync.pull": "arrow-down",
  "sync.push": "arrow-up",
  "dialog.dependencies": "package",
};
