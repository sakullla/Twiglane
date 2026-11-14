import { hasCommitSummary } from "./ui";
import type { IconName } from "./icons";
import { MODIFIER_LABEL } from "./brand";
import type { CommandView, RecentRepo, TaskModal, Theme } from "./types";

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
  /** 当前视图；历史里选中「任务净差异」时为 task。 */
  workspaceView: CommandView;
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
  /** 当前分支有名字（不是游离 HEAD、也不是还没有提交）：只有这时才能修改上游。 */
  upstreamEditable?: boolean;
  /** 仓库里有可以中止的合并、变基或拣选。 */
  mergeAbortable?: boolean;
  /** 提交范围口径的已暂存文件数，与提交区 paths.length 同源。 */
  stagedCount: number;
  /** 「全部暂存」的精确目标：列表当前可见、未暂存且非冲突的文件路径。 */
  stageTargets: string[];
  /** 「全部取消暂存」的精确目标：列表当前可见、已暂存且非冲突的文件路径。 */
  unstageTargets: string[];
  /** 当前视图的上一个/下一个文件：null 表示这里没有文件可切，原因字段非空表示到头了。 */
  fileNav?: { prevReason: string | null; nextReason: string | null } | null;
  /**
   * 连续审阅队列：任务与改动共用同一套未审阅导航、标记与隐藏状态。
   * 命令面板、工具条按钮与快捷键都读这一份，禁用原因因此不会分叉。
   */
  review?: {
    prevReason: string | null;
    nextReason: string | null;
    /** 标记/撤销为什么不可用：没有选中文件、正在确认快照，或没有审阅范围。 */
    toggleReason: string | null;
    /** 当前文件已审阅与否，决定命令标题是「标记」还是「撤销」。 */
    reviewed: boolean;
    hideReason: string | null;
    hidden: boolean;
    remaining: number;
    total: number;
    scope: "changes" | "task";
  } | null;
  /**
   * 整文件真实写入：改动视图作用于索引，任务净差异里暂存的是这个路径的真实工作区内容。
   * `side` 说明当前选中文件在真实状态里属于哪一侧，`none` 表示没有可写的真实改动。
   */
  /** otherSide：这个路径的另一侧是否也有真实改动，禁用原因据此指向用户选中的那一侧。 */
  fileStage?: { path: string | null; side: "staged" | "unstaged" | "none"; reason: string | null; otherSide?: boolean } | null;
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
/** 只有改动视图与历史里的任务净差异有审阅队列；其它位置说明原因，而不是说「先选文件」。 */
const NO_REVIEW_QUEUE = "当前视图没有审阅队列";
/** 整文件写入不可用的原因：没有选中、正在读写、或这一侧本来就没有可写的真实改动。 */
function fileStageReason(state: CommandState, action: "stage" | "unstage"): string {
  if (!state.hasRepo) return "先打开一个仓库";
  if (state.writeLocked) return busyReason(state);
  if (!state.fileStage?.path) {
    return state.workspaceView === "changes" || state.workspaceView === "task"
      ? NO_FILE_REASON
      : "改动视图或任务净差异里才能写入索引";
  }
  // 同一路径两侧都有改动时，原因必须指向用户选中的那一侧，否则另一侧明明有改动却被说成「没有改动」。
  const { side, otherSide } = state.fileStage;
  if (action === "stage") {
    if (side !== "staged") return "当前文件没有可暂存的真实改动";
    return otherSide ? "选中的是已暂存侧，要暂存请先选未暂存侧" : "当前文件没有可暂存的真实改动";
  }
  if (side !== "unstaged") return "当前文件没有已暂存的改动";
  return otherSide ? "选中的是未暂存侧，要取消暂存请先选已暂存侧" : "当前文件没有已暂存的改动";
}
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
    id: "view.history",
    group: "视图",
    title: "提交历史",
    hint: "浏览提交，不改动工作区",
    shortcut: `${MODIFIER_LABEL} 2`,
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    /** 与左栏切换条同序：改动 1、历史 2、文件 3，面板里不再出现与快捷键错位的顺序。 */
    id: "view.files",
    group: "视图",
    title: "文件",
    hint: "按目录浏览仓库中的文件，只读预览内容",
    shortcut: `${MODIFIER_LABEL} 3`,
    available: filesAvailable,
    reason: filesReason,
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
    id: "review.prev",
    group: "视图",
    title: "上一个未审阅文件",
    hint: "只在未审阅文件之间往回走；到队首停下，不循环",
    shortcut: `${ALT_LABEL} ⇧ ←`,
    available: (state) => hasRepo(state) && Boolean(state.review) && !state.review?.prevReason,
    reason: (state) =>
      state.hasRepo ? (state.review ? (state.review.prevReason ?? NO_FILE_REASON) : NO_REVIEW_QUEUE) : "先打开一个仓库",
  },
  {
    id: "review.next",
    group: "视图",
    title: "下一个未审阅文件",
    hint: "只在未审阅文件之间往前走；到队尾说明没有更多，不循环",
    shortcut: `${ALT_LABEL} ⇧ →`,
    available: (state) => hasRepo(state) && Boolean(state.review) && !state.review?.nextReason,
    reason: (state) =>
      state.hasRepo ? (state.review ? (state.review.nextReason ?? NO_FILE_REASON) : NO_REVIEW_QUEUE) : "先打开一个仓库",
  },
  {
    id: "review.toggle",
    group: "视图",
    title: "标记/撤销已审阅",
    hint: "标记前先确认这个文件的当前完整快照；只改变本地审阅记录，不暂存、不提交",
    shortcut: `${ALT_LABEL} M`,
    available: (state) => hasRepo(state) && Boolean(state.review) && !state.review?.toggleReason,
    reason: (state) =>
      state.hasRepo ? (state.review ? (state.review.toggleReason ?? NO_FILE_REASON) : NO_REVIEW_QUEUE) : "先打开一个仓库",
  },
  {
    id: "review.hide",
    group: "视图",
    title: "隐藏/显示已审阅",
    hint: "只改显示，分组数量、任务范围与提交范围都不变",
    available: (state) => hasRepo(state) && Boolean(state.review) && !state.review?.hideReason,
    reason: (state) =>
      state.hasRepo
        ? state.review
          ? (state.review.hideReason ?? "当前范围没有已审阅文件")
          : NO_REVIEW_QUEUE
        : "先打开一个仓库",
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
    id: "stage.file",
    group: "提交",
    title: "暂存当前文件",
    hint: "按这个文件的真实工作区内容写入索引；任务净差异本身不被暂存",
    available: (state) =>
      hasRepo(state) && idle(state) && state.fileStage?.side === "unstaged" && Boolean(state.fileStage?.path),
    reason: (state) => fileStageReason(state, "stage"),
  },
  {
    id: "unstage.file",
    group: "提交",
    title: "取消暂存当前文件",
    hint: "把这个文件移回未暂存，改动内容保留在工作区",
    available: (state) =>
      hasRepo(state) && idle(state) && state.fileStage?.side === "staged" && Boolean(state.fileStage?.path),
    reason: (state) => fileStageReason(state, "unstage"),
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
  {
    id: "sync.upstream",
    group: "同步",
    title: "修改上游分支",
    hint: "选择任意远程分支作为推送与拉取的上游，可以不同名",
    available: (state) => hasRepo(state) && idle(state) && state.upstreamEditable !== false,
    reason: (state) => (state.hasRepo && !state.writeLocked ? "当前不在有提交的分支上" : repoBusyReason(state)),
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
    id: "task.abortMerge",
    group: "任务",
    title: "中止当前操作",
    hint: "撤销进行中的合并、变基、拣选或还原，回到开始之前",
    available: (state) => hasRepo(state) && idle(state) && state.mergeAbortable === true,
    reason: (state) => {
      if (!state.hasRepo) return "先打开一个仓库";
      if (state.writeLocked) return busyReason(state);
      return "当前没有进行中的合并、变基、拣选或还原";
    },
  },
  {
    id: "branch.switch",
    group: "任务",
    title: "切换分支",
    hint: "搜索本地或远程分支并切换",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    id: "branch.create",
    group: "任务",
    title: "新建分支",
    hint: "从当前分支或指定起点创建",
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
  {
    /** 与状态栏入口同一条命令：终端是工作台底部面板，不是第四个视图。 */
    id: "terminal.toggle",
    group: "界面",
    title: "终端",
    hint: "在仓库根目录展开或收起底部交互终端",
    shortcut: `${MODIFIER_LABEL} \``,
    keywords: "terminal shell console 命令行 构建 测试 运行",
    available: hasRepo,
    reason: hasRepoReason,
  },
  {
    /** 新建一个终端标签页（默认终端类型）；面板收起时同时展开。 */
    id: "terminal.new",
    group: "界面",
    title: "新建终端",
    hint: "在仓库根目录新开一个终端标签页",
    shortcut: `${MODIFIER_LABEL} ⇧ \``,
    keywords: "terminal shell new tab 新终端 标签",
    available: hasRepo,
    reason: hasRepoReason,
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

/**
 * 命令面板的检索别名：Git 的英文叫法与常见的另一种中文说法。只参与匹配，不显示。
 * 空格分开的每一段是一条独立别名（中文别名按整段做不计字序的匹配）。
 * 集中放在一张表里，标题与说明仍然只在各自的命令定义里写一次。
 */
const PALETTE_ALIASES: Record<string, string> = {
  "view.changes": "changes status diff 工作区 未提交",
  "view.history": "history log 日志 提交记录",
  "view.files": "files tree explorer 文件树 目录 浏览",
  "file.prev": "previous file",
  "file.next": "next file",
  "review.prev": "review previous",
  "review.next": "review next",
  "review.toggle": "review reviewed 已读",
  "review.hide": "review reviewed 过滤已审阅",
  "diff.hunk.prev": "hunk previous 上一块 改动块",
  "diff.hunk.next": "hunk next 下一块 改动块",
  "view.find": "find search filter 查找 过滤",
  "files.quickOpen": "open file goto 打开文件 跳转文件",
  "files.search": "grep search 全文搜索 搜索内容",
  "file.reveal": "reveal locate 定位文件",
  "file.back": "back",
  "file.forward": "forward",
  "task.scope": "scope staged 暂存范围",
  "stage.all": "stage add 全部添加",
  "unstage.all": "unstage reset 撤出暂存",
  "stage.file": "stage add 添加文件",
  "unstage.file": "unstage reset 撤出暂存",
  "commit.local": "commit 本地提交",
  "commit.push": "commit push",
  "task.publish": "publish upstream 上游 推送新分支",
  "sync.fetch": "fetch 抓取 下载远程",
  "sync.pull": "pull 更新代码 下拉",
  "sync.push": "push 上传",
  "sync.upstream": "upstream tracking 跟踪分支 设置上游",
  "task.stash": "stash 贮藏 储藏 搁置",
  "task.merge": "merge rebase 合并分支 变基",
  "task.abortMerge": "abort 取消合并 中止合并 中止变基 中止拣选 中止还原 中止当前操作",
  "branch.switch": "checkout switch branch 检出分支",
  "branch.create": "create new branch 创建分支",
  "task.branch": "branch tag 管理分支 删除分支 重命名分支 管理标签 新建标签",
  "task.remote": "remote origin url 远端 远程地址",
  "task.settings": "settings preferences 偏好 首选项 配置 应用更新",
  "repo.add": "open 打开仓库 打开本地仓库",
  "repo.clone": "clone",
  "repo.create": "init 初始化仓库",
  "repo.copyPath": "copy path 仓库路径",
  "theme.light": "theme light 主题 亮色 白天",
  "theme.dark": "theme dark 主题 暗色 夜间",
  "theme.system": "theme system auto 主题 自动",
  "view.refresh": "refresh reload 重新读取",
  "rail.toggle": "sidebar 侧边栏 左栏",
  "palette.open": "command palette",
  "dialog.dependencies": "dependencies environment git 环境 诊断",
};

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
  /** 一行说明，跟在标题后面弱化显示并参与匹配。切换仓库的条目不带：路径已经是它的检索词。 */
  hint?: string;
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
      keywords: command.keywords ?? PALETTE_ALIASES[command.id],
      detail: command.detail,
      hint: command.id.startsWith(REPO_SWITCH_PREFIX) ? undefined : command.hint,
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
