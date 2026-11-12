<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { api, listenEvent, pickDirectory, pickFile, type ClioraReviewRequest } from "./lib/api";
  import {
    commandAvailable,
    commandById,
    commandReason,
    OVERFLOW_COMMAND_ICONS,
    OVERFLOW_COMMAND_IDS,
    paletteItems,
    REPO_SWITCH_PREFIX,
    switchBlocked,
    switchBlockedReason,
    type CommandState,
  } from "./lib/commands";
  import { LatestReadQueue } from "./lib/latest-read";
  import { createDocumentSession } from "./lib/document-session.svelte";
  import { shortOid } from "./lib/history";
  import { FULL_FILE_CONTEXT, finishDiffAttempt, reuseDiffContent, type HunkNavReport } from "./lib/diff";
  import { DraftBuffer } from "./lib/draft";
  import {
    beginClioraReview,
    clioraBaseline,
    clioraReview,
    clioraReturnNotice,
    clioraReturnOutcome,
    clioraSourceMatches,
    forgetClioraSourceUnless,
    watchClioraReviewLinks,
  } from "./lib/cliora-review.svelte";
  import { fileEditor, type EditContext } from "./lib/file-editor.svelte";
  import { normalizeError } from "./lib/errors";
  import { showMergeAbort } from "./lib/resolve";
  import { clampWidth, FALLBACK_POLL_MS, fitPaneWidth, shouldPoll } from "./lib/layout";
  import {
    CHANGES_SCOPE,
    applyReviewReverificationIn,
    beginReviewProgress,
    isReviewedIn,
    markReviewedIn,
    pruneReviewProgressIn,
    reviewPaths,
    reviewSessionSummary,
    reviewSummaryIn,
    reviewTokens,
    taskReviewScope,
    unmarkReviewedIn,
    type ReviewTarget,
  } from "./lib/review-progress.svelte";
  import { branchLabel, commitScope, createSelectionResolver, dependencyNote, fileStageSide, filterRows, groupFiles, hasSide, retainSelection, selectionAfterEdit, syncLabel } from "./lib/labels";
  import { startDesktopMeasure } from "./lib/measure";
  import { updateState, watchUpdateAvailable } from "./lib/update.svelte";
  import { isTextEntry, shortcutCommand } from "./lib/shortcuts";
  import type {
    AppFailure,
    DiffHunk,
    DiffSide,
    DiffLineSelection,
    DiffResponse,
    FileRow,
    FileSelection,
    GitInfo,
    OpenedRepository,
    PanelWidths,
    PreviewSources,
    RecentRepo,
    RepoChanged,
    RepoHead,
    StatusSnapshot,
    PullIntegration,
    RepositoryEditSnapshot,
    TaskModal,
    TaskRequest,
    TaskSummary,
    TerminalActivity,
    TerminalCloseRequested,
    Theme,
    WorkspaceView,
  } from "./lib/types";
  import {
    batchSummary,
    batchTargets,
    fileNavState,
    hasCommitSummary,
    orderedRows,
    reviewQueue,
    rowsInSelection,
    sameSelection,
    type FileNavState,
    type ReviewQueueState,
  } from "./lib/ui";
  import BranchDialog from "./lib/components/BranchDialog.svelte";
  import type { MergeMode } from "./lib/components/MergeSetup.svelte";
  import BranchSwitcher from "./lib/components/BranchSwitcher.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ConfirmDialog from "./lib/components/ConfirmDialog.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./lib/components/ContextMenu.svelte";
  import Modal, { openModalCount } from "./lib/components/Modal.svelte";
  import CommitDraft from "./lib/components/CommitDraft.svelte";
  import DetailDialog from "./lib/components/DetailDialog.svelte";
  import DiffView from "./lib/components/DiffView.svelte";
  import DocumentDialog from "./lib/components/DocumentDialog.svelte";
  import FileList from "./lib/components/FileList.svelte";
  import Icon from "./lib/components/Icon.svelte";
  import MergeBanner from "./lib/components/MergeBanner.svelte";
  import MergeModal from "./lib/components/MergeModal.svelte";
  import MultiFileDiff from "./lib/components/MultiFileDiff.svelte";
  import PaneResizer from "./lib/components/PaneResizer.svelte";
  import PublishModal from "./lib/components/PublishModal.svelte";
  import RepositoryFiles from "./lib/components/RepositoryFiles.svelte";
  import RecoveryActions from "./lib/components/RecoveryActions.svelte";
  import RepoDialogs from "./lib/components/RepoDialogs.svelte";
  import { scopedSelectAll } from "./lib/select-scope";
  import RepoSwitcher from "./lib/components/RepoSwitcher.svelte";
  import ScopeModal from "./lib/components/ScopeModal.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import StashModal from "./lib/components/StashModal.svelte";
  import TaskReview from "./lib/components/TaskReview.svelte";
  import TerminalPanel, { TERMINAL_CLOSE_REQUESTED_EVENT } from "./lib/components/TerminalPanel.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import TitleBar from "./lib/components/TitleBar.svelte";
  import ViewSwitcher from "./lib/components/ViewSwitcher.svelte";
  import Welcome from "./lib/components/Welcome.svelte";
  import { createQuietActivity } from "./lib/quiet-activity";
  import { setAbbrevLength } from "./lib/abbrev.svelte";

  /* 外观：三态选择 + 系统解析。documentElement 上只写 light / dark，
     "system" 由 matchMedia 解析，并跟随系统变化（R14/T2 的 Theme 收口在这里）。 */
  const selectedReads = new LatestReadQueue();
  onDestroy(() => selectedReads.close());
  const DARK_QUERY = "(prefers-color-scheme: dark)";

  function systemPrefersDark(): boolean {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia(DARK_QUERY).matches;
  }

  function resolveTheme(choice: Theme, systemDark: boolean): "light" | "dark" {
    if (choice === "system") return systemDark ? "dark" : "light";
    return choice;
  }

  let systemDark = $state(systemPrefersDark());
  let theme = $state<Theme>("dark");
  let pullIntegration = $state<PullIntegration>("merge");
  let branchGroups = $state(true);
  /** 设置里的「显示文件视图」：关闭后左栏只有改动与历史，文件视图不挂载。 */
  let filesViewEnabled = $state(true);
  let resolvedTheme = $derived(resolveTheme(theme, systemDark));

  $effect(() => {
    if (typeof document !== "undefined") document.documentElement.dataset.theme = resolvedTheme;
  });

  let widths = $state<PanelWidths>({ sidebar: 256, files: 360 });
  let recent = $state<RecentRepo[]>([]);
  let git = $state<GitInfo | null>(null);
  /** 关闭了常驻的 Git 诊断通知条；起始页的空状态入口不受影响（R13 仍要能诊断）。 */
  let gitDismissed = $state(false);
  let warning = $state<string | null>(null);
  let banner = $state<string | null>(null);
  let live = $state("正在准备 Twiglane");
  let opened = $state.raw<OpenedRepository | null>(null);
  let badgeNames = $derived.by(() => {
    const names = recent.map((item) => item.name);
    const current = opened?.summary.name;
    if (current !== undefined && !names.includes(current)) names.push(current);
    return names;
  });
  let repositoryEpoch = 0;
  let refreshTask: { epoch: number; again: boolean; promise: Promise<boolean> } | null = null;
  /**
   * 状态栏右下角的「刷新中」：工作区重新验证与历史面板的后台重读合并成一条安静的指示。
   * 与写入、首次读取分开；很快结束的不闪，出现后至少停留一小段，连续的监听刷新不会让它一闪一闪。
   */
  let refreshActive = $state(false);
  let refreshSerial = 0;
  let workspaceRefreshing = false;
  let historyRefreshing = false;
  const refreshIndicator = createQuietActivity((visible) => (refreshActive = visible));
  onDestroy(() => refreshIndicator.reset());

  function syncRefreshIndicator() {
    refreshIndicator.set(workspaceRefreshing || historyRefreshing);
  }

  function reportHistoryActivity(active: boolean) {
    historyRefreshing = active;
    syncRefreshIndicator();
  }
  let draggingRepository = $state(false);
  let draft = $state("");
  /**
   * R5：上一次提交失败的原因。它只在提交区就地显示（CommitDraft 的 data-commit-error），
   * 与右下角通知条并行而不是替代——通知条会自己消失，提交区这份留到下次尝试或说明改动为止。
   */
  let commitError = $state<string | null>(null);
  /** 焦点文件：单选时就是选中文件，多选时是当前定位到的文件块。 */
  let selected = $state<FileSelection | null>(null);
  /** 多选集合：不足两项时为空，主内容区走单文件差异（R19）。 */
  let selectedSet = $state.raw<FileSelection[]>([]);
  let fileList = $state<ReturnType<typeof FileList> | null>(null);
  /** 文件视图的对外入口：展开祖先定位路径、聚焦两种搜索。 */
  let filesView = $state<{
    reveal: (path: string, line?: number | null) => Promise<boolean>;
    focusSearch: (mode: "path" | "content") => Promise<void>;
  } | null>(null);
  /** 批量写入里单个文件遇到 stale 的重试上限，与后端 settle_read 一致。 */
  const BATCH_STALE_RETRIES = 6;
  /** 这次按键发生时是否有弹层打开：在捕获阶段记下，弹层自己处理 Esc 关闭后这里不会误判。 */
  let layerAtKey = false;
  /** 批量写入进行中：期间的刷新要跟着文件换分组，不能把正在移动的条目当成消失。 */
  let batchRunning = false;
  /** 历史视图的上一个/下一个状态，由 HistoryPanel 上报。 */
  let historyNav = $state.raw<FileNavState | null>(null);
  /** 文件视图自己的上一个/下一个文件：目录树里可见的文件行顺序。 */
  let filesNav = $state.raw<FileNavState | null>(null);
  let diff = $state.raw<DiffResponse | null>(null);
  let diffError = $state<string | null>(null);
  let diffLoading = $state(false);
  let pending = $state<string | null>(null);
  let reading = $state(false);
  let readSerial = 0;
  let readPhase: "idle" | "reading" | "settled" = "idle";
  let dependencyOpen = $state(false);
  let historyPanel = $state<Promise<typeof import("./lib/components/HistoryPanel.svelte")> | null>(null);
  /**
   * 轻量编辑：从差异或任务净差异进入文件视图编辑的请求，以及编辑器里「返回差异」要回到哪里。
   * 草稿本身在 fileEditor 里，按「仓库 + 路径 + baseDigest」保留，只在内存中。
   */
  let editRequest = $state<{ path: string; line: number | null; serial: number } | null>(null);
  let editOrigin = $state<{ path: string; view: "changes" | "task"; side: DiffSide } | null>(null);
  let editSerial = 0;
  /** 换仓库或返回来源前的「保存 / 放弃 / 取消」；一次只有一个。 */
  let editLeave = $state<{
    purpose: string;
    paths: string[];
    busy: boolean;
    error: string | null;
    resolve: (proceed: boolean) => void;
  } | null>(null);
  let writeLocked = $derived(pending !== null || reading);
  /** 左栏只由用户隐藏（⌘/Ctrl+B）：窗口变窄不会自动隐藏文件列表，只收紧渲染宽度（R14）。 */
  const FALLBACK_WINDOW_WIDTH = 1280;
  let windowWidth = $state(currentWindowWidth());
  let sidebarHidden = $state(false);
  let paneWidth = $derived(fitPaneWidth(widths.files, windowWidth));
  /** 设置 modal 打开时要定位的分区；由 Git 诊断入口置为 runtime、更新入口置为 update，其余入口为空。 */
  let settingsSection = $state<"appearance" | "runtime" | "update" | null>(null);
  /** 当前打开的标题栏弹层；anchor 是触发按钮，关闭后焦点回到这里。 */
  let switcher = $state.raw<{ kind: "repo" | "branch"; anchor: HTMLElement } | null>(null);
  let confirmPath = $state<string | null>(null);
  let cloneOpen = $state(false);
  let pushRetry = $state(false);
  /** 本地提交成功后推送失败的原因：提交区把两个阶段分开显示，并提供只重试推送的入口。 */
  let pushFailure = $state<string | null>(null);
  let phaseNote = $state<string | null>(null);
  let degraded = $state(false);
  let windowFocused = $state(true);
  let requestSerial = 1;
  let diffToken = 0;
  let fileQuery = $state("");
  let workspaceView = $state<WorkspaceView>("changes");
  /** 底部终端展开状态只在内存里；切换视图不改变它，切换仓库时面板重新附着该仓库的会话。 */
  let terminalOpen = $state(false);
  /**
   * 原生关窗被活动终端拦下后的确认层。取消保留进程，确认先等待 terminateTerminals 成功，
   * 再请求关闭窗口；失败时对话框与真实错误都留着。
   */
  let terminalClose = $state<{ sessions: TerminalActivity[]; busy: boolean; error: string | null } | null>(null);
  let conflictFocus = $state<string | null>(null);
  /** 从分支菜单「合并到当前分支」进入时预选的来源分支。 */
  let mergeSource = $state<string | null>(null);
  let mergeTarget = $state<string | null>(null);
  /** 分叉拉取用设置里的预选；从其他分支变基时固定为 rebase。普通合并不预选。 */
  let mergeMode = $state<MergeMode | null>(null);
  let historyPath = $state<string | null>(null);
  let historyQuery = $state("");
  /**
   * 任务视图的起点请求。null 表示还没有明确起点：任务页停在选择状态，
   * 不会退回当前 HEAD、默认分支或上一次用过的起点（R1）。
   */
  let taskRequest = $state.raw<TaskRequest | null>(null);
  /** 历史详情区正在显示「任务净差异」：审阅、整文件暂存等命令此时作用在任务范围上。 */
  let taskFocus = $state(false);
  /** 任务净差异的摘要：历史顶部那一行显示它。 */
  let taskSummary = $state.raw<TaskSummary | null>(null);
  let taskRequestNonce = 0;
  /** 任务视图自己的文件导航与差异块导航，与改动、历史各留一份。 */
  let taskNav = $state.raw<FileNavState | null>(null);
  let taskHunk = $state<HunkNavReport | null>(null);
  let taskModal = $state<TaskModal | null>(null);
  /**
   * 只读文档阅读窗口的请求。
   *
   * 它和任务弹窗共用同一个单槽：任一时刻只有一个任务级 modal，打开阅读窗口会收起任务弹窗，
   * 打开任务弹窗也会收起阅读窗口；底下的差异/历史视图不卸载，选择与位置因此保持原样。
   * trigger 是打开它的控件（差异工具条按钮、块标题按钮或溢出入口），关闭后焦点回到那里。
   */
  let documentRequest = $state<{ sources: PreviewSources; side: "old" | "new"; trigger: HTMLElement | null } | null>(null);
  /**
   * 任务级 modal 层是否占着单槽：任务弹窗与只读阅读窗口二选一。
   *
   * 阅读窗口和七个任务弹窗一样由 Modal 占层并把背景设为 inert，所以外壳也要把它当成一层：
   * 键盘、命令分发与写入入口都用这一份判定，不逐个列举 documentRequest（漏一处就会让
   * Ctrl+Enter 真的提交、Alt+箭头改掉底下的差异选择）。
   */
  let taskLayerOpen = $derived(taskModal !== null || documentRequest !== null);
  /** 阅读位置按「仓库 + 版本 + 路径」保存在这里，关闭再打开仍能接着读。 */
  const documentSession = createDocumentSession({ repository: () => opened?.summary.path ?? null });
  /** 从哪个任务 modal 跳过来的：例如从「分支与标签」打开合并，关闭合并时回到那里。 */
  let taskReturn = $state<TaskModal | null>(null);
  /** 本次打开分支 modal 是为了新建：直接展开表单。每次 openTask 都先清空。 */
  let branchCreateIntent = $state(false);
  /** 从分支弹层右键「从此分支新建」带来的起点；空串表示当前分支。 */
  let branchCreateBase = $state("");
  let paletteOpen = $state(false);
  /**
   * 命令面板打开前的有效焦点。
   *
   * 面板里执行任务命令时，面板与任务弹窗在同一批更新里换位：弹窗挂载那刻面板的搜索框已经
   * 卸载，Modal 自己抓不到真正的触发点，关闭后焦点就落到 body。所以这里先记下打开面板前
   * 的控件，再由 Modal 的 returnFocus 用它收尾。
   */
  let paletteFocusOrigin: HTMLElement | null = null;
  /** 当前任务弹窗关闭后的焦点去处；为空表示按 Modal 原有语义（打开瞬间的 activeElement）。 */
  let taskReturnFocus = $state<HTMLElement | null>(null);
  /**
   * 克隆弹窗关闭后的焦点去处。
   *
   * 克隆不占任务槽位（在后台继续时窗口收起、写入仍在跑），所以和任务弹窗分开记；
   * 远程弹窗本来就走 openTask，用 taskReturnFocus 就够了。
   */
  let repoReturnFocus = $state<HTMLElement | null>(null);
  /** 当前打开的右键菜单（文件列表、最近仓库）；任务 modal 里的右键菜单由各自组件承载。 */
  let contextMenu = $state<ContextMenuRequest | null>(null);
  /**
   * 删除附属工作区的确认：第一次不带 force；Git 因未提交改动拒绝时升级成强制删除确认，
   * 用户再点一次才丢弃改动。当前打开的工作区不在这里删（入口直接禁用）。
   */
  let worktreeRemoval = $state<{ repo: RecentRepo; head: RepoHead; force: boolean; busy: boolean; error: string | null } | null>(null);
  let recovery = $state<{ discard: (paths?: string[]) => Promise<void> } | null>(null);
  /**
   * 差异是否展开为完整文件（记在本机）：开启时按整份文件加上下文读取，暂存代码块暂不可用。
   * 改动与历史提交共用这一个偏好。
   */
  let diffFullFile = $state(readFullFilePreference());
  /** 按文本查看的那个文件（侧别:路径）。只对当前选中的文件生效，换文件后自动回到默认读取。 */
  let diffAsText = $state<string | null>(null);
  function asTextKey(choice: { side: string; path: string } | null): string | null {
    return choice ? `${choice.side}:${choice.path}` : null;
  }
  function setDiffAsText(next: boolean) {
    diffAsText = next ? asTextKey(selected) : null;
    void loadSelectedDiff();
  }
  let mergeInProgress = $state(false);
  /** 进行中的合并、变基或拣选可以中止：左栏提示和命令面板据此给出「中止」。 */
  let mergeAbortable = $state(false);
  /** 从主界面「中止合并」打开分支合并：面板读到会话后直接弹出中止确认。 */
  let mergeAbortIntent = $state(false);
  let mergeProbeSerial = 0;
  let remoteName = $state<string | null>(null);
  /** 仓库配置的全部远程名（同步菜单用）。 */
  let remoteNames = $state<string[]>([]);
  /** remoteNames 属于哪个仓库：同一仓库只读一次，远程弹窗读到或改动时直接更新。 */
  let remoteNamesFor: string | null = null;
  let syncCancelling = $state(false);
  /** 会访问远程、可以取消的同步动作。 */
  const REMOTE_PENDING = new Set(["fetch", "pull", "push", "publish", "associate"]);
  /**
   * 同步失败的阶段与重试范围。远程未知不能与成功共用一句话；
   * 推送失败时本地提交已经落地，重试只重试推送。
   */
  const SYNC_FAILURE: Record<string, { stage: string; next: string }> = {
    fetch: { stage: "获取更新", next: "本地文件和当前分支都没有变化；可以重试获取更新。" },
    pull: { stage: "快进拉取", next: "当前分支没有前进，工作区保持原样；可以重试拉取。" },
    push: { stage: "推送", next: "本地提交已保留；重试只推送，不会再次提交。" },
    publish: { stage: "发布分支", next: "本地提交已保留；重试只推送，不会再次提交。" },
    associate: { stage: "关联上游", next: "这次没有推送；可以重试关联。" },
  };
  const drafts = new DraftBuffer();
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  /** 窗口宽度：只读来源，resize 时更新，左栏渲染宽度由它收紧。 */
  function currentWindowWidth(): number {
    if (typeof window === "undefined") return FALLBACK_WINDOW_WIDTH;
    return window.innerWidth || FALLBACK_WINDOW_WIDTH;
  }

  /** Git 不可用时的诊断结论：一句，长安装说明只在设置/运行依赖里展开（R12、R13）。 */
  let gitDiagnostic = $derived(git !== null && !git.available ? git.message || "Git 不可用" : null);

  let branchText = $derived(opened ? branchLabel(opened.snapshot.branch) : "未打开仓库");
  let syncText = $derived(opened ? syncLabel(opened.snapshot.branch) : "未检查远程");
  let scope = $derived(opened ? commitScope(branchText, opened.snapshot.files) : { label: "", paths: [] as string[] });
  let ahead = $derived(opened?.snapshot.branch.ahead ?? 0);
  let behind = $derived(opened?.snapshot.branch.behind ?? 0);
  /*
   * 审阅进度（R2）：会话内本地人工记录，按 canonical worktree 与范围隔离，不写 state.json，
   * 也不参与提交范围与 Cliora 结果。「改动」与「任务」各自保留自己的标记、隐藏与提示。
   */
  let hideReviewed = $state(false);
  let taskHideReviewed = $state(false);
  let reviewBusy = $state<string | null>(null);
  let reviewNote = $state<string | null>(null);
  let taskReviewNote = $state<string | null>(null);
  let reviewSerial = 0;
  let taskReviewSerial = 0;
  /** 任务页报告的已解析范围：只有后端校验过的起点与 HEAD 才能作为任务快照 token 的依据。 */
  let taskScope = $state.raw<{ worktree: string; baselineOid: string; headOid: string } | null>(null);
  let taskSelectedPath = $state<string | null>(null);
  let taskReviewNav = $state.raw<ReviewQueueState | null>(null);
  let changesTarget = $derived<ReviewTarget | null>(
    opened ? { worktree: opened.summary.path, scope: CHANGES_SCOPE } : null,
  );
  let taskTarget = $derived<ReviewTarget | null>(
    taskScope ? { worktree: taskScope.worktree, scope: taskReviewScope(taskScope.baselineOid) } : null,
  );
  let reviewedSet = $derived(new Set(changesTarget ? Object.keys(reviewTokens(changesTarget)) : []));
  let taskReviewedSet = $derived(new Set(taskTarget ? Object.keys(reviewTokens(taskTarget)) : []));
  let reviewCounts = $derived(
    reviewSummaryIn(changesTarget ?? { worktree: "", scope: CHANGES_SCOPE }, opened ? reviewPaths(opened.snapshot.files) : []),
  );
  /** 任务净差异是否就是当前审阅对象：只在历史视图里选中顶部那一行时成立。 */
  let inTask = $derived(workspaceView === "history" && taskFocus && taskRequest !== null);
  let activeReviewedSet = $derived(inTask ? taskReviewedSet : reviewedSet);
  /** 命令与按钮作用的文件：任务视图用任务页自己的选择，改动视图用改动列表的选择。 */
  let activeSelectedPath = $derived(inTask ? taskSelectedPath : (selected?.path ?? null));
  let changesReviewNav = $derived.by<ReviewQueueState | null>(() => {
    if (!opened) return null;
    return reviewQueue(orderedRows(opened.snapshot.files, fileQuery), reviewedSet, selected, goToFile);
  });
  let activeReviewNav = $derived(
    inTask ? taskReviewNav : workspaceView === "changes" ? changesReviewNav : null,
  );

  let changeCount = $derived(opened?.snapshot.files.length ?? 0);
  let conflictCount = $derived(opened?.snapshot.files.filter((file) => file.unmerged).length ?? 0);
  let upstreamMissing = $derived(opened ? !opened.snapshot.branch.upstream : false);
  let syncPending = $derived<"fetch" | "pull" | "push" | null>(
    pending === "fetch" || pending === "pull" || pending === "push" ? pending : null,
  );
  let remoteState = $derived<"live" | "stale" | "off">(
    !opened
      ? "off"
      : opened.snapshot.branch.liveRemoteChecked
        ? "live"
        : opened.snapshot.branch.remoteCheckStale
          ? "stale"
          : "off",
  );

  /* 「全部暂存 / 全部取消暂存」的目标路径：与 FileList 分组头用的是同一套 groupFiles + filterRows，
     所以命令面板与分组头按钮作用在同一批文件上（冲突文件两边都排除）。 */
  let fileGroups = $derived(groupFiles(opened?.snapshot.files ?? []));
  let stageTargets = $derived(
    filterRows(fileGroups.unstaged, fileQuery)
      .filter((row) => !row.unmerged)
      .map((row) => row.path),
  );
  let unstageTargets = $derived(
    filterRows(fileGroups.staged, fileQuery)
      .filter((row) => !row.unmerged)
      .map((row) => row.path),
  );

  /* 上一个/下一个文件：单选走当前列表（含筛选）的顺序，跨分组；多选只在选中文件之间走（R20）。 */
  let multiActive = $derived(selectedSet.length > 1);
  let selectedRows = $derived(rowsInSelection(orderedRows(opened?.snapshot.files ?? []), selectedSet));
  let batch = $derived(batchTargets(selectedRows));
  let changesNav = $derived.by(() => {
    const items = multiActive ? selectedRows : orderedRows(opened?.snapshot.files ?? [], fileQuery);
    const index = items.findIndex((row) => sameSelection(row, selected));
    return fileNavState(items, index, goToFile, multiActive ? "选中文件" : "文件");
  });
  /* 四个视图各有自己的文件顺序：改动列表、文件树、提交内的文件、任务净改动。 */
  let activeNav = $derived(
    workspaceView === "changes"
      ? changesNav
      : workspaceView === "files"
        ? filesNav
        : inTask
          ? taskNav
          : historyNav,
  );
  /** 两份差异都可能挂着：只采用当前视图那一份，多选时单文件差异已经卸掉。 */
  let changesHunk = $state<HunkNavReport | null>(null);
  let historyHunk = $state<HunkNavReport | null>(null);
  let activeHunk = $derived<HunkNavReport | null>(
    workspaceView === "changes"
      ? multiActive
        ? null
        : changesHunk
      : inTask
        ? taskHunk
        : workspaceView === "history"
          ? historyHunk
          : null,
  );
  /** 回调身份必须稳定：内联函数每次渲染都是新的，差异视图会在上报和清空之间打转。 */
  function assignHunk(current: HunkNavReport | null, nav: HunkNavReport | null): HunkNavReport | null {
    if (nav === null) return current === null ? current : null;
    if (current && current.prevReason === nav.prevReason && current.nextReason === nav.nextReason) return current;
    return nav;
  }
  function reportChangesHunk(nav: HunkNavReport | null) {
    changesHunk = assignHunk(changesHunk, nav);
  }
  function reportHistoryHunk(nav: HunkNavReport | null) {
    historyHunk = assignHunk(historyHunk, nav);
  }
  function reportTaskHunk(nav: HunkNavReport | null) {
    taskHunk = assignHunk(taskHunk, nav);
  }

  /**
   * 当前文件在真实 Git 状态里属于哪一侧：整文件暂存/取消暂存都以它为唯一依据。
   * 任务净差异来自提交时（真实状态里没有未提交改动）这里是 none，命令就地说明原因。
   */
  let activeFileStage = $derived.by<{ path: string | null; side: "staged" | "unstaged" | "none"; otherSide: boolean }>(() => {
    // 只有改动与任务视图把选择作用在真实 Git 状态上；文件/历史视图没有可写的这一侧。
    const path = workspaceView === "changes" || inTask ? activeSelectedPath : null;
    const file = path ? opened?.snapshot.files.find((item) => item.path === path) : undefined;
    // 改动视图按用户选中的那一侧判定：同一路径同时有已暂存与未暂存时，选中已暂存就必须能取消暂存。
    // 任务行的侧别只是净结果（不等于真实索引状态），所以任务视图只按真实文件状态判定。
    const chosen = workspaceView === "changes" ? (selected?.side ?? null) : null;
    const side = path ? fileStageSide(file, chosen) : "none";
    // 同一路径另一侧是否也有改动：命令面板的禁用原因据此指向用户选中的那一侧。
    const otherSide = file != null && side !== "none" && hasSide(file, side === "staged" ? "unstaged" : "staged");
    return { path: path ?? null, side, otherSide };
  });

  /* 命令注册表的唯一状态输入：标题栏、左栏、溢出菜单与命令面板都读这一份。 */
  let commandState = $derived<CommandState>({
    hasRepo: opened !== null,
    workspaceView: inTask ? "task" : workspaceView,
    taskModal,
    sidebarHidden,
    // 任务级 modal 层占着单槽时写动作同样不可用：命令可用性与执行 guard 读同一份判定，
    // 否则面板/菜单里的「可用」会在阅读窗口下面成为一句不成立的话（R11）。
    writeLocked: writeLocked || documentRequest !== null,
    // 只把写动作算作「正在写入」：pending 也承载差异续读（"diff"），
    // 把它算成写入会让读取期间的不可用原因失真（R11）。
    writing: pending !== null && pending !== "diff",
    reading: reading || pending === "diff",
    // 与 openRecent 的执行 guard 同源：任何 pending（含差异续读）都不切换仓库（R11）。
    switchingBlocked: pending !== null,
    upstreamMissing,
    upstreamEditable: opened ? Boolean(opened.snapshot.branch.name) && !opened.snapshot.branch.detached && !opened.snapshot.branch.unborn : false,
    mergeAbortable,
    stagedCount: scope.paths.length,
    stageTargets,
    unstageTargets,
    fileNav: activeNav,
    review: activeReviewNav
      ? {
          prevReason: activeReviewNav.prevReason,
          nextReason: activeReviewNav.nextReason,
          toggleReason: activeSelectedPath ? (reviewBusy === activeSelectedPath ? "正在确认这个文件的快照" : null) : "先选择一个文件",
          reviewed: activeSelectedPath ? activeReviewedSet.has(activeSelectedPath) : false,
          hideReason: null,
          hidden: inTask ? taskHideReviewed : hideReviewed,
          remaining: activeReviewNav.remaining,
          total: activeReviewNav.total,
          scope: inTask ? "task" : "changes",
        }
      : null,
    fileStage: { path: activeFileStage.path, side: activeFileStage.side, reason: null, otherSide: activeFileStage.otherSide },
    hunkNav: activeHunk ? { prevReason: activeHunk.prevReason, nextReason: activeHunk.nextReason } : null,
    multiFile: multiActive,
    // 文件树定位以改动视图的选中文件为目标：没有选中就没有可定位的文件。
    currentFilePath: selected?.path ?? null,
    filesViewEnabled,
    fileHistory: filesNav?.history
      ? { backReason: filesNav.history.backReason, forwardReason: filesNav.history.forwardReason }
      : null,
    draft,
    theme,
    recentRepos: recent,
    currentRepoPath: opened?.summary.path ?? null,
  });
  /** 状态栏只给一句正在进行的动作：本地读取、远程网络与写入不共用「加载中」这种笼统说法（R6）。 */
  let pendingLabel = $derived.by(() => {
    switch (pending) {
      case "fetch":
        return "正在检查远程";
      case "pull":
        return "正在拉取";
      case "push":
        return "正在推送";
      case "publish":
        return "正在发布";
      case "associate":
        return "正在关联上游";
      case "add":
      case "open":
        return "正在读取仓库";
      case "clone":
        return "正在克隆";
      default:
        return commandState.writing ? "写入中" : "读取中";
    }
  });
  let paletteCommands = $derived(
    paletteItems(commandState).map((item) => ({
      id: item.id,
      group: item.group,
      title: item.title,
      shortcut: item.shortcut,
      keywords: item.keywords,
      detail: item.detail,
      hint: item.hint,
      enabled: item.enabled,
      reason: item.reason,
      run: () => runCommand(item.id),
    })),
  );
  /**
   * 运行环境正常（Git 可用且版本不低于基线）时，「运行依赖」说明对用户没有行动价值，
   * 不在提交区菜单里占位；仍可从命令面板与设置 → 运行环境查看。缺失或过低时它才回到菜单里。
   */
  let runtimeHealthy = $derived(git !== null && git.available && !git.belowBaseline);
  let overflowCommands = $derived(
    OVERFLOW_COMMAND_IDS.filter((id) => !(id === "dialog.dependencies" && runtimeHealthy))
      .map((id) => commandById(id))
      .filter((command): command is NonNullable<typeof command> => Boolean(command)),
  );

  $effect(() => {
    const note = phaseNote;
    if (!note || pushRetry) return;
    const timer = setTimeout(() => {
      if (phaseNote === note) phaseNote = null;
    }, 6000);
    return () => clearTimeout(timer);
  });

  /** Git 恢复可用后重新武装诊断入口：下次缺失时它还要再出现一次。 */
  $effect(() => {
    if (git?.available) gitDismissed = false;
  });

  function nextId(): number {
    requestSerial += 1;
    return requestSerial;
  }

  /**
   * 把焦点放进当前视图的搜索框。命令面板关闭时会把焦点还给打开前的控件，
   * 所以从面板执行时要等这一轮收尾后再聚焦。
   */
  function focusFinder() {
    const pick = () => {
      if (workspaceView === "files" && !document.getElementById("files-search")) {
        // 搜索面板正开着（目录树不在 DOM 里）：焦点交给当前那种搜索的输入框。
        void filesView?.focusSearch("content");
        return;
      }
      const target = inTask
        ? document.getElementById("task-file-search")
        : workspaceView === "history"
          ? document.getElementById("history-search")
          : workspaceView === "files"
            ? document.getElementById("files-search")
            : opened
              ? document.getElementById("file-search")
              : document.getElementById("welcome-search") ?? document.querySelector<HTMLElement>(".welcome-actions button");
      target?.focus();
    };
    if (paletteOpen) setTimeout(pick, 0);
    else pick();
  }

  function notice(message: string) {
    phaseNote = message;
    live = message;
    banner = null;
  }

  /**
   * 任务读取失败：任务页已经就地给出原因与恢复入口，这里只把同一句原因交给读屏器，
   * 不再额外弹一条通知条——同一件事不该在两处各说一遍。
   */
  function announceTaskFailure(error: unknown) {
    live = normalizeError(error).message;
  }

  function showError(error: unknown) {
    const failure = error as AppFailure;
    const normalized = failure?.message ? failure : normalizeError(error);
    // 失败结论与上一次的成功提示不能同时挂着：error toast 出现时把旧成功 toast 收起。
    phaseNote = null;
    banner = normalized.message;
    live = normalized.message;
  }

  /**
   * 写操作失败的就地说明：保留归一化后的 code/generation，消息里补上失败阶段与重试范围。
   * 阶段文字只描述本次动作，不把本地已完成的结果说成回退。
   */
  function describeFailure(failure: AppFailure, stage?: string, next?: string): string {
    if (!stage) return failure.message;
    return `${stage}失败：${failure.message}${next ? ` ${next}` : ""}`;
  }

  function applyTheme(next: Theme) {
    theme = next;
    // 首帧与测量钩子都要立即拿到解析结果，因此这里同步写一次；$effect 继续承担系统变化。
    if (typeof document !== "undefined") document.documentElement.dataset.theme = resolveTheme(next, systemDark);
  }

  /**
   * 会写 Git 的命令 id：任务级 modal 层（任务弹窗或只读阅读窗口）占着单槽时不执行。
   * 只列真正写入的；查看、导航与主题命令仍可在弹窗自己的界面里用。
   */
  const WRITE_COMMANDS = new Set([
    "commit.local",
    "commit.push",
    "stage.all",
    "unstage.all",
    "stage.file",
    "unstage.file",
    "sync.fetch",
    "sync.pull",
    "sync.push",
  ]);

  /** 命令执行的唯一入口：四个入口都调它，结果因此一致（R11）。 */
  function runCommand(id: string) {
    // 任务级 modal 层（任务弹窗或只读阅读窗口）占着单槽时，写入类命令不落到背景：
    // 键盘与 inert 已经挡住主要入口，这里兜住原生菜单与程序化调用（R3/R6）。
    if (taskLayerOpen && WRITE_COMMANDS.has(id)) return;
    switch (id) {
      case "view.changes":
        showChanges();
        return;
      case "view.files":
        showFiles();
        return;
      case "view.history":
        showHistory();
        return;
      case "file.prev":
        activeNav?.onPrev();
        return;
      case "file.next":
        activeNav?.onNext();
        return;
      case "review.prev":
        activeReviewNav?.onPrev();
        return;
      case "review.next":
        activeReviewNav?.onNext();
        return;
      case "review.toggle":
        if (activeSelectedPath) void toggleReviewed(activeSelectedPath);
        return;
      case "review.hide":
        if (inTask) taskHideReviewed = !taskHideReviewed;
        else hideReviewed = !hideReviewed;
        return;
      case "stage.file":
        if (activeSelectedPath) void stagePath(activeSelectedPath);
        return;
      case "unstage.file":
        if (activeSelectedPath) void unstagePath(activeSelectedPath);
        return;
      case "diff.hunk.prev":
        activeHunk?.jump(-1);
        return;
      case "diff.hunk.next":
        activeHunk?.jump(1);
        return;
      case "view.find":
        focusFinder();
        return;
      case "files.quickOpen":
        void openFilesSearch("path");
        return;
      case "files.search":
        void openFilesSearch("content");
        return;
      case "file.reveal":
        if (selected) void revealInFiles(selected.path);
        return;
      case "file.back":
        filesNav?.history?.onBack();
        return;
      case "file.forward":
        filesNav?.history?.onForward();
        return;
      case "view.refresh":
        void refresh();
        return;
      case "stage.all":
        void stagePaths(commandState.stageTargets);
        return;
      case "unstage.all":
        void unstagePaths(commandState.unstageTargets);
        return;
      case "repo.copyPath":
        void copyPath(opened?.summary.path ?? "");
        return;
      case "task.stash":
      case "task.merge":
      case "task.branch":
      case "task.remote":
      case "task.scope":
      case "task.publish":
        openTask(id.slice(5) as TaskModal);
        return;
      case "branch.switch":
        openBranchSwitcher();
        return;
      case "branch.create":
        openTask("branch");
        if (taskModal === "branch") branchCreateIntent = true;
        return;
      case "task.abortMerge":
        abortMergeFromShell();
        return;
      case "sync.upstream":
        openTask("branch");
        return;
      case "task.settings":
        // 常规入口落在设置首屏；只有 Git 诊断入口才指定运行环境分区。
        openSettings();
        return;
      case "commit.local":
        void commitLocal();
        return;
      case "commit.push":
        void commitAndPush();
        return;
      case "sync.fetch":
        void runSync("fetch", (path, generation) => api.fetchRemote(path, generation, nextId()));
        return;
      case "sync.pull":
        void runSync("pull", (path, generation) => api.pullFastForward(path, generation, nextId()));
        return;
      case "sync.push":
        void runSync("push", (path, generation) => api.pushBranch(path, generation, nextId()));
        return;
      case "rail.toggle":
        // 没有仓库时没有左栏可隐藏，这里记下状态会让下次打开仓库时看不到左栏。
        if (opened) sidebarHidden = !sidebarHidden;
        return;
      case "terminal.toggle":
        // 没有仓库时命令不可用；这里也守住程序化入口，不展开一个没有工作目录的终端。
        if (opened) terminalOpen = !terminalOpen;
        return;
      case "palette.open":
        openPalette();
        return;
      case "repo.add":
        void addRepo();
        return;
      case "repo.clone":
        openClone();
        return;
      case "repo.create":
        void chooseCreate();
        return;
      case "theme.light":
      case "theme.dark":
      case "theme.system":
        void changeTheme(id.slice(6) as Theme);
        return;
      case "dialog.dependencies":
        dependencyOpen = true;
        return;
      default:
        // 切换仓库的命令 id 带仓库路径，与标题栏仓库菜单里的条目共用 openRecent。
        if (id.startsWith(REPO_SWITCH_PREFIX)) void openRecent(id.slice(REPO_SWITCH_PREFIX.length));
        return;
    }
  }

  /**
   * 原生关窗确认：取消不调用终止；确认先等待全部终端及其子进程结束，再请求窗口关闭。
   * 任一阶段失败都保留对话框与真实错误，不把未结束的进程说成已经关闭。
   */
  async function confirmTerminalClose() {
    const current = terminalClose;
    if (!current || current.busy) return;
    terminalClose = { ...current, busy: true, error: null };
    try {
      await api.terminateTerminals();
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
      terminalClose = null;
    } catch (error) {
      terminalClose = {
        sessions: current.sessions,
        busy: false,
        error: normalizeError(error).message,
      };
    }
  }

  function terminalRepoName(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  function toggleSwitcher(kind: "repo" | "branch", anchor: HTMLElement) {
    if (switcher?.kind === kind) closeSwitcher();
    else switcher = { kind, anchor };
  }

  /**
   * 命令面板里的「切换分支」：和点标题栏的分支按钮是同一个弹层，锚点也是那枚按钮。
   * 面板关闭时会把焦点还给打开前的控件，所以等这一轮更新落定再打开弹层，搜索框才留得住焦点。
   * 没有可用的分支按钮（例如还读不到当前分支）时退到「分支与标签」。
   */
  function openBranchSwitcher() {
    if (!opened) return;
    void tick().then(() => {
      const anchor = document.querySelector<HTMLButtonElement>(".titlebar .branch-pill:not(:disabled)");
      if (!anchor) {
        openTask("branch");
        return;
      }
      if (switcher?.kind !== "branch") switcher = { kind: "branch", anchor };
    });
  }

  function closeSwitcher(refocus = true) {
    const anchor = switcher?.anchor;
    switcher = null;
    if (refocus) anchor?.focus({ preventScroll: true });
  }

  /** 弹层里的入口：先把焦点还给触发按钮，随后打开的 modal 关闭时才回得来。 */
  function runFromSwitcher(id: string) {
    closeSwitcher();
    runCommand(id);
  }

  /** 分支弹层的「新建分支」：和其它入口走同一个命令，只多带一个打开意图。 */
  function runBranchCreate(base?: string) {
    runFromSwitcher("task.branch");
    if (taskModal === "branch") {
      branchCreateIntent = true;
      branchCreateBase = base ?? "";
    }
  }

  /** 把某个分支合并到当前分支：打开分支合并并预选来源。分支弹层和分支管理共用。 */
  function mergeBranchIntoCurrent(name: string) {
    mergeSource = name;
    mergeTarget = null;
    mergeMode = null;
    openTask("merge");
  }

  /** 把当前分支合并到某个本地分支：打开分支合并并预选目标。 */
  function mergeCurrentInto(name: string) {
    mergeSource = opened?.snapshot.branch.name ?? null;
    mergeTarget = name;
    mergeMode = null;
    openTask("merge");
  }

  /** 把当前分支变基到所点分支：所点分支是基底，当前分支会被改写。 */
  function rebaseCurrentOnto(name: string) {
    mergeSource = name;
    mergeTarget = opened?.snapshot.branch.name ?? null;
    mergeMode = "rebase";
    openTask("merge");
  }

  /** 主界面的「中止合并」：打开分支合并，由面板读到当前会话后弹出同一份中止确认。 */
  function abortMergeFromShell() {
    if (!opened) return;
    openTask("merge");
    if (taskModal === "merge") mergeAbortIntent = true;
  }

  /** 七个任务入口共用单槽：任一时刻只有一个任务 modal。 */
  function openTask(task: TaskModal) {
    if (task !== "settings" && !opened) return;
    mergeAbortIntent = false;
    if (task !== "merge") {
      mergeSource = null;
      mergeTarget = null;
      mergeMode = null;
    }
    // 单槽：从差异/历史进任务弹窗时先收起阅读窗口，两层任务弹窗不并存。
    // 阅读窗口的触发控件就是这次弹窗的来处：它自己的 Modal 会随单槽一起卸载，
    // 所以先把焦点归还目标定下来，关掉任务弹窗后回到「阅读文档」，而不是落到 body。
    const fromDocument = documentRequest?.trigger ?? null;
    documentRequest = null;
    closeSwitcher();
    cloneOpen = false;
    // 面板在批内卸载：先在它关闭前定下关闭弹窗时该回到哪，再交给 Modal。
    taskReturnFocus = paletteOpen ? paletteReturnFocus() : fromDocument;
    paletteOpen = false;
    branchCreateIntent = false;
    branchCreateBase = "";
    taskReturn = null;
    taskModal = task;
    if (task === "merge") void probeMerge();
    if (task === "publish") void loadRemoteName();
  }

  /**
   * 从差异或历史的「阅读文档」入口打开只读阅读窗口。
   * 来源是消费者给的真实前后版本（工作区 / 暂存区 / 父提交 / 提交），阅读窗口自己决定先看哪一侧。
   */
  function openDocument(sources: PreviewSources, side: "old" | "new", trigger: HTMLElement | null) {
    if (!opened) return;
    if (!sources.old && !sources.new) return;
    // 同一个单槽：阅读窗口打开时不再留着任务弹窗，避免两层任务 modal 叠在一起。
    taskModal = null;
    taskReturn = null;
    closeSwitcher();
    paletteOpen = false;
    documentRequest = { sources, side, trigger };
  }

  function closeDocument() {
    documentRequest = null;
  }

  /** 设置 modal：默认落在外观首屏，Git 诊断/更新入口另行指定分区（R10、R1）。 */
  function openSettings(section: "appearance" | "runtime" | "update" | null = null) {
    settingsSection = section;
    openTask("settings");
  }

  /** R10/R13 的诊断入口：可关闭，动作直接进入设置里的运行环境分区。 */
  function openGitDiagnostics() {
    openSettings("runtime");
  }

  /** 发布目标取仓库实际配置的第一个远程，而不是写死 origin。 */
  async function loadRemoteName() {
    const current = opened;
    if (!current) return;
    try {
      const result = await api.remoteState(current.summary.path, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      remoteName = result.remotes[0]?.name ?? null;
    } catch {
      if (opened?.summary.path === current.summary.path) remoteName = null;
    }
  }

  /** back：用户自己关闭（关闭按钮、右上角、Esc）时回到来源 modal；跳去别的视图时不回。 */
  function closeTask(back = false) {
    const closed = taskModal;
    const origin = back === true ? taskReturn : null;
    taskReturn = null;
    taskModal = null;
    settingsSection = null;
    if (closed === "merge") {
      conflictFocus = null;
      mergeAbortIntent = false;
      mergeSource = null;
      mergeTarget = null;
      mergeMode = null;
      void probeMerge();
    }
    if (origin && origin !== closed) openTask(origin);
  }

  /** 从「分支与标签」进入合并：关闭合并时回到分支与标签，而不是直接回到工作区。 */
  function mergeFromBranches(start: () => void) {
    closeTask();
    start();
    taskReturn = "branch";
  }

  function openClone() {
    if (writeLocked) return;
    // 从命令面板执行时，面板与弹窗在同一批更新里换位：先定下关闭后该回到的控件，再关面板。
    repoReturnFocus = paletteOpen ? paletteReturnFocus() : null;
    taskModal = null;
    paletteOpen = false;
    cloneOpen = true;
  }

  function openPalette() {
    // 任何 modal（含放弃/撤销确认层）打开时都不能从快捷键再叠一层；阅读窗口也算一层。
    if (taskLayerOpen || cloneOpen || openModalCount() > 0) return;
    closeSwitcher();
    paletteFocusOrigin = focusableOrigin();
    paletteOpen = true;
  }

  /** 能把焦点交回的元素：有焦点、仍在文档里，且不是 body（body 没有位置，读屏会从头再来）。 */
  function focusableOrigin(): HTMLElement | null {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body && active.isConnected ? active : null;
  }

  /**
   * 命令面板打开后焦点去处：优先回到打开面板前的控件；面板是刚进界面按 ⌘K 打开的
   * （那时焦点还在 body）才落到主内容区这个明确后备，而不是任由焦点留在 body。
   */
  function paletteReturnFocus(): HTMLElement | null {
    const origin = paletteFocusOrigin;
    if (origin?.isConnected) return origin;
    const main = document.querySelector<HTMLElement>("[data-app-main]");
    return main instanceof HTMLElement ? main : null;
  }

  /**
   * 等 Modal 卸完再交回焦点。
   *
   * RepoDialogs 的 Modal 在 onDestroy 里会把焦点还给「打开瞬间的 activeElement」；从命令面板
   * 打开时那已经是卸载中的搜索框，于是焦点落到 body。这里先让 Svelte 完成这一批更新与销毁，
   * 再把焦点交给真正该回的控件（都不在时退回主内容区）。
   */
  function restoreRepoFocus(target: HTMLElement) {
    const apply = () => {
      const next = target.isConnected ? target : document.querySelector<HTMLElement>("[data-app-main]");
      if (next instanceof HTMLElement) next.focus({ preventScroll: true });
    };
    // 定时器而不是 requestAnimationFrame：窗口收起到后台时 rAF 不排帧，焦点会一直留在 body。
    queueMicrotask(() => setTimeout(apply, 0));
  }

  /**
   * RepoDialogs 的关闭收尾：远程与克隆共用，先把回来的目标定下来再关。
   *
   * 目标在清空之前取，且两个槽位一起看：克隆成功自动关窗时 `rememberOpened()` 已经先把
   * `cloneOpen` 置假，只看 `cloneOpen` 会取到远程槽位里的 `null`，焦点就落回 body。
   */
  function closeRepoDialogs() {
    const target = repoReturnFocus ?? taskReturnFocus;
    cloneOpen = false;
    if (taskModal === "remote") taskModal = null;
    repoReturnFocus = null;
    taskReturnFocus = null;
    if (target) restoreRepoFocus(target);
  }

  async function loadSettings() {
    try {
      const settings = await api.getSettings();
      applyTheme(settings.theme);
      pullIntegration = settings.pullIntegration === "rebase" ? "rebase" : "merge";
      branchGroups = settings.branchGroups !== false;
      filesViewEnabled = settings.filesView !== false;
      if (!filesViewEnabled && workspaceView === "files") showChanges();
      widths = {
        sidebar: clampWidth(settings.panelWidths.sidebar),
        files: clampWidth(settings.panelWidths.files),
      };
      recent = settings.recent;
      git = settings.git;
      warning = settings.settingsWarning;
      live = settings.git.available ? "已准备就绪" : settings.git.message;
    } catch (error) {
      showError(error);
    }
  }

  /** 左栏合并提示的唯一来源。序号防止较早发出的探测晚到时盖掉新结果。 */
  async function probeMerge() {
    const serial = ++mergeProbeSerial;
    const current = opened;
    if (!current) {
      mergeInProgress = false;
      mergeAbortable = false;
      return;
    }
    try {
      const session = await api.mergeSession(current.summary.path, current.generation, nextId());
      if (serial !== mergeProbeSerial || opened?.summary.path !== current.summary.path) return;
      mergeInProgress = session.operation === "merge" || session.canAbort;
      mergeAbortable = showMergeAbort(session.operation, session.canAbort);
    } catch (error) {
      if (serial !== mergeProbeSerial || opened?.summary.path !== current.summary.path) return;
      // stale 只说明这次探测用了旧 generation，不代表合并结束，提示不能因此消失。
      if (normalizeError(error).code !== "stale") {
        mergeInProgress = false;
        mergeAbortable = false;
      }
    }
  }

  function rememberOpened(next: OpenedRepository) {
    /**
     * 克隆成功时窗口还开着，用户在看结果：外壳在这里就把窗口关掉。
     *
     * 这条路径不走 RepoDialogs 的 onClose——`startClone()` 回到自己那行时 `mode` 已经是
     * null（`cloneOpen` 被下面置假），`if (mode === "clone") onClose()` 不再成立。
     * 所以先记下「窗口还开着」，等状态改完再由同一个关闭收尾交回焦点，否则焦点留在 body。
     */
    const closingClone = cloneOpen;
    // 独立打开别的仓库会清掉 cliora 来源展示；同一 worktree 的重新打开保留来源。
    forgetClioraSourceUnless(next.summary.path);
    // 编辑会话按仓库归属：别的仓库里干净的会话结束。用户发起的换仓库入口都先过草稿关卡；
    // 关卡之外仍残留的未保存草稿（例如测量钩子直接克隆打开）也不丢，回到那个仓库后仍可保存或放弃。
    const keptDrafts = fileEditor.retainRepository(next.summary.path);
    if (opened?.summary.path !== next.summary.path) {
      editOrigin = null;
      editRequest = null;
    }
    repositoryEpoch += 1;
    if (draftTimer) clearTimeout(draftTimer);
    drafts.load(next.summary.path, next.draft);
    draft = next.draft;
    opened = next;
    setAbbrevLength(next.abbrevLength);
    // 换仓库清空审阅进度；同一个 worktree 重新打开保留。进度只在本会话内有效。
    beginReviewProgress(next.summary.path);
    reviewNote = null;
    selectedSet = [];
    degraded = next.watchDegraded;
    const groups = groupFiles(next.snapshot.files);
    const first = groups.unstaged[0] ?? groups.staged[0] ?? groups.conflicted[0];
    selected = retainSelection(next.snapshot.files, selected) ?? (first ? { path: first.path, side: first.side } : null);
    diff = null;
    diffError = null;
    commitError = null;
    pushRetry = false;
    pushFailure = null;
    stopRefreshIndicator();
    phaseNote = null;
    workspaceView = "changes";
    historyPath = null;
    historyQuery = "";
    filesNav = null;
    // 换仓库清掉任务起点、导航与已解析范围：旧仓库的起点对新仓库不成立。
    taskRequest = null;
    taskRequestNonce += 1;
    taskSummary = null;
    taskNav = null;
    taskHunk = null;
    taskScope = null;
    taskSelectedPath = null;
    taskReviewNav = null;
    taskReviewNote = null;
    taskModal = null;
    paletteOpen = false;
    cloneOpen = false;
    closeSwitcher(false);
    conflictFocus = null;
    remoteName = null;
    remoteNames = [];
    remoteNamesFor = null;
    mergeInProgress = false;
    mergeAbortable = false;
    recent = [
      { name: next.summary.name, path: next.summary.path, openedAtMs: Date.now() },
      ...recent.filter((repo) => repo.path !== next.summary.path),
    ];
    live = `已打开 ${next.summary.name}`;
    void probeMerge();
    void loadSelectedDiff();
    void reverifyReviewed();
    if (closingClone) closeRepoDialogs();
    if (keptDrafts.length > 0) {
      notice(`另有 ${keptDrafts.length} 个文件的未保存草稿留在原仓库，回到那个仓库后可以保存或放弃。`);
    }
  }

  /**
   * 克隆窗口还开着时用户在等结果，完成后照常打开。点过“在后台继续”就不再打断：
   * 不切换仓库、不关任何窗口，只加入最近仓库并通知。
   */
  async function cloneFinished(next: OpenedRepository) {
    banner = null;
    const { name, path } = next.summary;
    if (cloneOpen) {
      // 窗口还开着就会切到新仓库：当前仓库的未保存草稿先保存、放弃或取消。
      // 取消只是不切换：克隆已经完成，按「在后台继续」的收尾记入最近仓库并把监听接回当前仓库。
      const proceed = await confirmEditorLeave("打开克隆好的仓库");
      if (proceed && cloneOpen) {
        rememberOpened(next);
        notice(`已克隆并打开 ${name}`);
        return;
      }
      if (!proceed) {
        recent = [{ name, path, openedAtMs: Date.now() }, ...recent.filter((repo) => repo.path !== path)];
        notice(`克隆完成：${name}。未保存的编辑草稿已保留，没有切换仓库；可以从标题栏的仓库弹层打开。`);
        if (opened) void rewatchCurrent(opened.summary.path);
        return;
      }
    }
    recent = [{ name, path, openedAtMs: Date.now() }, ...recent.filter((repo) => repo.path !== path)];
    notice(`克隆完成：${name}。可以从标题栏的仓库弹层打开。`);
    if (opened) void rewatchCurrent(opened.summary.path);
  }

  /**
   * 克隆命令结束时后端总会启动新仓库的监听，而监听只有一路，当前仓库因此被顶掉。
   * 重新打开只为把监听接回来，返回的快照不用：等待期间可能已有写入，直接应用会回退。
   * 空窗内的外部改动由 refresh 补上，它自带 epoch、generation 保护和合并探测。
   */
  async function rewatchCurrent(path: string) {
    try {
      let current: OpenedRepository;
      try {
        current = await api.openRepository(path, nextId());
      } catch (error) {
        if (normalizeError(error).code !== "stale") throw error;
        current = await api.openRepository(path, nextId());
      }
      if (opened?.summary.path !== path) {
        // 等待期间切了仓库：这次打开可能抢走了新仓库的监听，再接一次。
        if (opened) void rewatchCurrent(opened.summary.path);
        return;
      }
      degraded = current.watchDegraded;
      void refresh();
    } catch {
      if (opened?.summary.path === path) degraded = true;
    }
  }

  function stopRefreshIndicator() {
    workspaceRefreshing = false;
    historyRefreshing = false;
    refreshIndicator.reset();
  }

  function refresh(): Promise<boolean> {
    if (!opened) return Promise.resolve(false);
    if (refreshTask?.epoch === repositoryEpoch) {
      refreshTask.again = true;
      return refreshTask.promise;
    }
    const serial = ++refreshSerial;
    const task = { epoch: repositoryEpoch, again: false, promise: Promise.resolve(false) };
    refreshTask = task;
    workspaceRefreshing = true;
    syncRefreshIndicator();
    task.promise = (async () => {
      let ok = false;
      do {
        task.again = false;
        ok = await refreshOnce(task.epoch);
      } while (task.again && task.epoch === repositoryEpoch && opened);
      return ok;
    })().finally(() => {
      if (refreshTask === task) refreshTask = null;
      // 仓库切换后可能已经开始了新一轮刷新：旧一轮收尾不能把新一轮的进行中状态提前关掉。
      if (refreshSerial === serial) {
        workspaceRefreshing = false;
        syncRefreshIndicator();
      }
    });
    return task.promise;
  }

  async function refreshOnce(epoch: number): Promise<boolean> {
    const current = opened;
    if (!current) return false;
    try {
      let generation = current.generation;
      let snapshot;
      try {
        snapshot = await api.refreshStatus(current.summary.path, generation, nextId());
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code !== "stale" || failure.generation === undefined) throw failure;
        generation = failure.generation;
        snapshot = await api.refreshStatus(current.summary.path, generation, nextId());
      }
      if (epoch !== repositoryEpoch || opened?.summary.path !== current.summary.path) return false;
      if (snapshot.generation < opened.generation) {
        // 更新事件已经排队时会再读一次；旧响应本身不触发无限重试。
        return false;
      }
      opened = { ...opened, snapshot, generation: snapshot.generation };
      settleSelection(createSelectionResolver(snapshot.files, batchRunning));
      // 外部完成或开始合并时只有刷新能发现，提示不能停在旧状态。
      void probeMerge();
      await loadSelectedDiff();
      void reverifyReviewed();
      return true;
    } catch (error) {
      if (epoch === repositoryEpoch && opened?.summary.path === current.summary.path) showError(error);
      return false;
    }
  }

  async function loadSelectedDiff() {
    const token = ++diffToken;
    const current = opened;
    const choice = selected;
    if (workspaceView !== "changes") {
      diffLoading = false;
      return;
    }
    // 多选时差异由 MultiFileDiff 逐块读取；序号已经递增，单文件的在途响应随之作废。
    if (!current || !choice || multiActive) {
      diff = null;
      diffError = null;
      diffLoading = false;
      return;
    }
    diffLoading = true;
    diffError = null;
    const file = current.snapshot.files.find((item) => item.path === choice.path);
    const context = diffFullFile ? FULL_FILE_CONTEXT : undefined;
    const textArgs: [] | [boolean] = diffAsText !== null && diffAsText === asTextKey(choice) ? [true] : [];
    try {
      const outcome = await finishDiffAttempt(
        { token, repo: current.summary.path, path: choice.path, side: choice.side },
        () => ({
          token: diffToken,
          repo: opened?.summary.path ?? null,
          path: selected?.path ?? null,
          side: selected?.side ?? null,
        }),
        () => selectedReads.run(() =>
          api.loadDiff(
            current.summary.path,
            choice.path,
            choice.side === "staged",
            current.generation,
            nextId(),
            file?.originalPath ?? null,
            0,
            0,
            context,
            ...textArgs,
          )),
      );
      if (outcome.state === "discarded") return;
      if (outcome.state === "failed") {
        const failure = normalizeError(outcome.error);
        if (failure.code === "stale" && failure.generation !== undefined && opened?.summary.path === current.summary.path) {
          opened = { ...opened, generation: Math.max(opened.generation, failure.generation) };
          void refresh();
          return;
        }
        diffError = failure.message;
        diff = null;
        return;
      }
      diff = reuseDiffContent(diff, outcome.value);
      diffError = null;
    } finally {
      if (token === diffToken && opened?.summary.path === current.summary.path) diffLoading = false;
    }
  }

  function selectFile(selection: FileSelection) {
    selected = selection;
    selectedSet = [];
    void loadSelectedDiff();
  }

  /** 文件列表的多选结果；不足两个文件时就是单选。 */
  function selectMany(set: FileSelection[], focus: FileSelection) {
    if (set.length < 2) {
      selectFile(set[0] ?? focus);
      return;
    }
    selected = focus;
    selectedSet = set;
    live = `已选中 ${set.length} 个文件`;
    void loadSelectedDiff();
  }

  /** 上一个/下一个文件：列表选中和滚动同步，焦点留在原处。 */
  function goToFile(row: FileRow) {
    const item = { path: row.path, side: row.side };
    if (multiActive) selected = item;
    else selectFile(item);
    fileList?.revealRow(item);
    live = row.path;
  }

  /** 多文件视图滚到另一块：只移动焦点文件和列表，不重新定位差异。 */
  function focusBlock(item: FileSelection) {
    selected = item;
    fileList?.revealRow(item);
  }

  /* 退出多选时多文件视图随即卸载，焦点在里面就会掉到 body：提前交回文件列表。 */
  $effect.pre(() => {
    if (multiActive) return;
    if (document.activeElement?.closest?.(".multi-stack")) fileList?.focusList();
  });

  /** 文件集合变化后收敛选中：按 path+side 保留，减到一个就回到单选。 */
  function settleSelection(resolve: (item: FileSelection) => FileSelection | null) {
    const focus = selected ? resolve(selected) : null;
    const seen = new Set<string>();
    const set = selectedSet.flatMap((item) => {
      const kept = resolve(item);
      if (!kept || seen.has(`${kept.side}:${kept.path}`)) return [];
      seen.add(`${kept.side}:${kept.path}`);
      return [kept];
    });
    selected = focus ?? set[0] ?? null;
    selectedSet = set.length > 1 ? set : [];
    if (set.length > 1 && !set.some((item) => sameSelection(item, selected))) selected = set[0];
  }

  /** 多文件视图读到旧 generation：与单文件读取同样处理，收下新值并刷新。 */
  function adoptStaleDiff(generation: number) {
    if (!opened) return;
    opened = { ...opened, generation: Math.max(opened.generation, generation) };
    void refresh();
  }

  function adoptGeneration(generation: number) {
    if (!opened || opened.generation >= generation) return;
    opened = { ...opened, generation };
  }

  function showChanges() {
    useView("changes");
    historyPath = null;
  }

  /** 文件视图：只切换视图，不改动工作区、也不重新读取改动差异。 */
  function showFiles() {
    if (!filesViewEnabled) return;
    useView("files");
    historyPath = null;
  }

  /** 从改动进入文件树：展开必要的祖先、选中并滚到这一行（不读文件内容）。 */
  async function revealInFiles(path: string, line: number | null = null) {
    showFiles();
    // 等文件视图真的成为可见视图再定位：隐藏的视图不发起读取。
    await tick();
    await filesView?.reveal(path, line);
  }

  /** 文件到改动：切回改动视图并定位到这个文件的对应一侧。 */
  function openFileDiff(path: string, side: DiffSide) {
    showChanges();
    selectFile({ path, side });
  }

  /**
   * 从差异（改动或任务净差异）进入编辑：只切到文件视图并定位这个工作区文件，
   * 由内容区读取完整快照。cliora 来源、任务范围与审阅进度都不动。
   */
  async function editInFiles(path: string, line: number | null, view: "changes" | "task", side: DiffSide = "unstaged") {
    if (!filesViewEnabled) {
      notice("文件视图已在设置里关闭，打开后才能编辑工作区文件。");
      return;
    }
    editOrigin = { path, view, side };
    showFiles();
    await tick();
    const revealed = await filesView?.reveal(path, null);
    if (revealed === false) {
      // 文件树里定位不到（例如刚被删除或移动）：不把人放在什么都没选中的文件视图里，回到原来的差异并说明。
      if (editOrigin?.path === path) editOrigin = null;
      if (view === "task") useView("history");
      else showChanges();
      notice(`没能在文件树里定位 ${path}，没有进入编辑。文件可能已被删除或移动，刷新后再试。`);
      return;
    }
    editRequest = { path, line, serial: ++editSerial };
  }

  /** 编辑器里的「返回差异」：这个文件还有未保存修改时先问保存、放弃或取消。 */
  async function returnFromEdit() {
    const origin = editOrigin;
    const current = opened;
    if (!origin || !current) return;
    if (!(await confirmEditorLeave("返回差异", [origin.path]))) return;
    if (opened?.summary.path !== current.summary.path) return;
    editOrigin = null;
    // 已经保存或放弃：干净的会话结束，下次打开这个文件仍是只读查看。
    if (fileEditor.dirty(current.summary.path).every((session) => session.path !== origin.path)) {
      fileEditor.close(current.summary.path, origin.path);
    }
    if (origin.view === "task") {
      useView("history");
      return;
    }
    const file = current.snapshot.files.find((item) => item.path === origin.path);
    if (!file) {
      // 保存后这个文件可能已经没有改动：回到改动视图即可，不硬选一个不存在的差异。
      showChanges();
      return;
    }
    const side: DiffSide = file.untracked || file.unstaged !== "none" ? "unstaged" : "staged";
    openFileDiff(origin.path, side);
  }

  /**
   * 改动差异里可以进入编辑的路径：只有未暂存一侧（新侧就是工作区文件），且不是删除或未解决冲突；
   * 已暂存一侧的新侧是索引，多选是聚合视图，都没有这个入口。
   */
  let changesEditPath = $derived.by(() => {
    if (!filesViewEnabled || !opened || !selected || multiActive || selected.side !== "unstaged") return null;
    const path = selected.path;
    const file = opened.snapshot.files.find((item) => item.path === path);
    if (!file || file.unmerged || file.unstaged === "deleted") return null;
    return path;
  });

  let editReturn = $derived(
    editOrigin
      ? {
          path: editOrigin.path,
          label: editOrigin.view === "task" ? "返回任务差异" : "返回差异",
          run: () => void returnFromEdit(),
        }
      : null,
  );

  function editContext(): EditContext {
    return { generation: opened?.generation ?? 0, nextId, onGeneration: adoptGeneration };
  }

  /**
   * 保存成功：只改了这一个工作区文件。按新代次刷新状态与当前差异，并重验两种范围的已审阅标记：
   * 内容变了的文件旧 token 不再作证。不暂存、不提交，也不改变 cliora 结果。
   */
  function handleEditSaved(snapshot: RepositoryEditSnapshot) {
    adoptGeneration(snapshot.generation);
    live = `已保存 ${snapshot.path}：只写入工作区，没有暂存或提交。`;
    void refresh();
    void reverifyTaskReviewed();
  }

  /** 保存失败（含冲突）：草稿留在编辑器里，这里只按真实状态重读。 */
  function handleEditFailed(_code: string) {
    void refresh();
  }

  /**
   * 换仓库或返回来源前的关卡：当前仓库（或指定文件）有未保存草稿时，必须选择保存、放弃或取消。
   * 没有草稿直接放行；已经有一个关卡在等回答时，新的请求按取消处理。
   */
  function confirmEditorLeave(purpose: string, paths: string[] | null = null): Promise<boolean> {
    const repo = opened?.summary.path;
    if (!repo) return Promise.resolve(true);
    const dirty = fileEditor
      .dirty(repo)
      .filter((session) => !paths || paths.includes(session.path))
      .map((session) => session.path);
    if (dirty.length === 0) return Promise.resolve(true);
    if (editLeave) return Promise.resolve(false);
    return new Promise((resolve) => {
      editLeave = { purpose, paths: dirty, busy: false, error: null, resolve };
    });
  }

  /** 当前仓库是否还有没处理的未保存草稿。 */
  function hasLeaveDrafts(): boolean {
    const repo = opened?.summary.path;
    return repo ? fileEditor.dirty(repo).length > 0 : false;
  }

  /** 分支对话框「打开此工作区」：确认框叠在对话框上，取消后对话框与仓库都保持原样。 */
  function worktreeLeaveGate(path: string): Promise<boolean> {
    if (opened && samePath(opened.summary.path, path)) return Promise.resolve(true);
    return confirmEditorLeave("打开另一个工作区");
  }

  /**
   * 分支弹层「打开此工作区」：弹层挡不住叠在上面的确认框（点确认框就算点在外面，弹层会收起），
   * 所以有草稿时先收起弹层，交给切换仓库同一条带关卡的打开路径；没有草稿照常由弹层自己打开。
   */
  function switcherWorktreeGate(path: string): Promise<boolean> {
    if (!hasLeaveDrafts() || (opened && samePath(opened.summary.path, path))) return Promise.resolve(true);
    closeSwitcher();
    void tick().then(() => openRecent(path));
    return Promise.resolve(false);
  }

  function settleEditLeave(proceed: boolean) {
    const pending = editLeave;
    if (!pending || pending.busy) return;
    editLeave = null;
    pending.resolve(proceed);
  }

  /** 逐个保存；任何一个失败（含冲突）就停在对话框里说明，草稿不丢，可以放弃或取消。 */
  async function saveEditLeave() {
    const pending = editLeave;
    const repo = opened?.summary.path;
    if (!pending || pending.busy || !repo) return;
    pending.busy = true;
    pending.error = null;
    for (const path of pending.paths) {
      if (!fileEditor.dirty(repo).some((session) => session.path === path)) continue;
      const outcome = await fileEditor.save(repo, path, editContext());
      if (!outcome.ok) {
        pending.busy = false;
        pending.error = `${path} 没有保存：${outcome.message || "保存失败"}。草稿仍保留。`;
        handleEditFailed(outcome.code);
        return;
      }
      handleEditSaved(outcome.snapshot);
    }
    // 继续之前等状态按保存后的真实快照落定：随后的动作（例如返回 cliora 时统计未提交改动）
    // 不能还用保存之前的快照。
    await refresh().catch(() => false);
    pending.busy = false;
    settleEditLeave(true);
  }

  /** 明确放弃：只丢掉这几个文件的内存草稿，工作区文件保持读取时的样子。 */
  function discardEditLeave() {
    const pending = editLeave;
    const repo = opened?.summary.path;
    if (!pending || pending.busy || !repo) return;
    for (const path of pending.paths) fileEditor.close(repo, path);
    settleEditLeave(true);
  }

  /**
   * 任务净差异的按块/按行入口：聚合补丁含已提交内容，不能直接应用；
   * 这里转到同一文件的真实未提交差异，部分暂存仍走写锁内重读与过期保护。
   */
  function openUnstagedDiff(path: string): void {
    const file = opened?.snapshot.files.find((item) => item.path === path);
    if (!file || file.unmerged) {
      notice("这个文件当前没有可部分暂存的未提交差异：任务净差异不能直接做块/行补丁。");
      return;
    }
    const side: DiffSide = file.untracked || file.unstaged !== "none" ? "unstaged" : "staged";
    showChanges();
    selectFile({ path, side });
    notice(
      side === "unstaged"
        ? "已切到真实未提交差异：按块/行暂存仍会重读并拒绝过期补丁。"
        : "这个文件当前只有已暂存内容：按块操作会取消暂存对应块，不会改动任务范围。",
    );
  }

  /**
   * 任务行在真实 Git 状态里的那一侧：任务净差异只有一条结果，方向必须问真实 snapshot，
   * 列表按钮、空格与命令面板读的都是这一份判定，界面声明的动作与写入方向才不会相反。
   */
  function taskFileStage(path: string): "staged" | "unstaged" | "none" {
    return fileStageSide(opened?.snapshot.files.find((item) => item.path === path) ?? null);
  }

  /** 在真实状态下把这个任务文件整文件暂存；任务净差异本身不被写入。 */
  function stageTaskFile(path: string): void {
    if (taskFileStage(path) !== "unstaged") {
      notice("这个文件没有可暂存的真实改动：任务净差异来自提交，不能在这里写入索引。");
      return;
    }
    void stagePath(path);
  }

  /** 同一路径的真实状态只有已暂存一侧时，整文件动作是取消暂存。 */
  function unstageTaskFile(path: string): void {
    if (taskFileStage(path) !== "staged") {
      notice("这个文件没有已暂存的真实改动，无法取消暂存。");
      return;
    }
    void unstagePath(path);
  }

  /** 打开文件视图里的某一种搜索（路径 / 全文），并把焦点交给它自己的输入框。 */
  async function openFilesSearch(mode: "path" | "content") {
    showFiles();
    await tick();
    await filesView?.focusSearch(mode);
  }

  /**
   * 切视图后把焦点从离开的视图救回来（R4）：三个视图同时保活，离开的那个会被设成 inert，
   * 浏览器会把 inert 子树里的焦点弹出去——键盘按 ⌘1/2/3 或点视图切换按钮时，焦点原本就在
   * 离开视图的 paneHead 上，不接住就会掉到页面根部（document.body）。接住的落点是新激活视图里
   * 同一个「当前视图」切换按钮：视觉顺序没变，键盘流继续停在视图切换上；兜底退到可编程聚焦的主内容区。
   */
  function focusActiveViewSwitch(): boolean {
    const active = document.activeElement as HTMLElement | null;
    // 焦点已经落在新激活视图里的可聚焦元素：浏览器或组件已自行安置，不覆盖。
    if (active && active !== document.body && active.closest('.workbench-view[data-active="true"]')) return true;
    const target =
      document.querySelector<HTMLElement>(
        `.workbench-view[data-active="true"] nav[aria-label="视图"] [aria-current="page"]`,
      ) ?? document.querySelector<HTMLElement>("[data-app-main]");
    target?.focus();
    return target !== null && target !== undefined;
  }

  async function keepViewFocus(previous: WorkspaceView) {
    if (previous === workspaceView) return;
    const before = document.activeElement as HTMLElement | null;
    const leaving = before?.closest<HTMLElement>(`.workbench-view[data-view-scope="${previous}"]`);
    // 焦点不在离开的视图里（例如停在标题栏或弹层触发点），说明不会被 inert 弹出，不去抢它。
    if (!leaving) return;
    await tick();
    focusActiveViewSwitch();
    // 历史视图首次进入会异步加载面板并重挂 paneHead，接住的那个按钮可能被替换导致焦点再次掉到
    // body；再等一帧用同一判据补接一次，稳态后不再改动已经落在当前视图里的焦点。
    await tick();
    focusActiveViewSwitch();
  }

  function useView(view: WorkspaceView) {
    const previous = workspaceView;
    workspaceView = view;
    void keepViewFocus(previous);
    if (view === "history") {
      diffToken += 1;
      diffLoading = false;
      diff = null;
      historyPanel ??= import("./lib/components/HistoryPanel.svelte");
      return;
    }
    if (view === "files") {
      // 文件视图不画改动差异：在途响应作废，回到改动视图时再按当前选择重读。
      diffToken += 1;
      diffLoading = false;
      return;
    }
    void loadSelectedDiff();
  }

  /**
   * 普通进入历史（导航、命令、快捷键）保留上一次有效筛选与阅读位置：
   * 从文件历史或提交搜索进入时才换成新的显式条件。
   */
  function showHistory() {
    useView("history");
  }

  /**
   * cliora 审查链接带着起点进来：历史按「起点..HEAD」过滤，并选中顶部「任务净差异」。
   * 链接没有起点时不建立任务范围（不拿 HEAD 或默认分支补），只打开普通历史并说明原因。
   */
  function openTaskReview(baseline: string | null) {
    const value = baseline?.trim() ?? "";
    taskRequestNonce += 1;
    taskRequest = value === "" ? null : { baseline: value, origin: "cliora", nonce: taskRequestNonce };
    if (!taskRequest) {
      taskSummary = null;
      notice("cliora 审查链接没有携带起点，已打开普通提交历史。");
    }
    historyPath = null;
    historyQuery = "";
    useView("history");
  }

  function openFileHistory(path: string) {
    historyPath = path;
    historyQuery = "";
    useView("history");
  }

  function openCommitSearch(query: string) {
    historyPath = null;
    historyQuery = query;
    useView("history");
  }

  function openConflict(path: string) {
    conflictFocus = path;
    openTask("merge");
  }

  function applySnapshot(snapshot: StatusSnapshot) {
    if (!opened) return;
    // 迟到的旧快照不能把 generation 退回去，也不能覆盖较新的文件与选中状态。
    if (snapshot.generation < opened.generation) return;
    opened = { ...opened, snapshot, generation: snapshot.generation };
    settleSelection(createSelectionResolver(snapshot.files, true));
    void loadSelectedDiff();
    void reverifyReviewed();
  }

  /**
   * 刷新后只重验已标记的路径：token 相同保留，内容或状态变化、文件消失、
   * 无法确认时取消对应标记，其他文件不受影响。没有标记时不发任何请求。
   * 改动范围只重验改动快照；任务范围由任务页读取后再重验，两条范围互不作证。
   */
  async function reverifyReviewed(): Promise<void> {
    const current = opened;
    if (!current) return;
    const target: ReviewTarget = { worktree: current.summary.path, scope: CHANGES_SCOPE };
    const marked = Object.keys(reviewTokens(target));
    if (marked.length === 0) return;
    const alive = reviewPaths(current.snapshot.files);
    const dropped = pruneReviewProgressIn(target, alive);
    if (dropped.length > 0) {
      reviewNote = `${dropped.length} 个文件已不在改动列表里，已撤销对应的已审阅标记。`;
    }
    const aliveSet = new Set(alive);
    const targets = marked.filter((path) => aliveSet.has(path));
    if (targets.length === 0) return;
    const serial = ++reviewSerial;
    const repo = current.summary.path;
    const results: { path: string; token: string | null; reason?: string }[] = [];
    for (const path of targets) {
      try {
        const result = await api.repositoryReviewToken(repo, path, current.generation, nextId());
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
      if (serial !== reviewSerial || opened?.summary.path !== repo) return;
    }
    const invalidations = applyReviewReverificationIn(target, results);
    if (invalidations.length > 0) {
      reviewNote = `${invalidations.length} 个文件的快照已变化，已撤销对应的已审阅标记。`;
    }
  }

  /**
   * 任务页每次成功读取后报告它解析出的范围。任务快照 token 绑定这个范围，
   * 所以范围一变，进度立刻按新身份显示，旧标记不会被当成这次任务的结果。
   */
  function adoptTaskScope(scope: { worktree: string; baselineOid: string; headOid: string } | null): void {
    taskScope = scope;
    taskSelectedPath = scope ? taskSelectedPath : null;
    if (scope) void reverifyTaskReviewed();
    else taskReviewNav = null;
  }

  /**
   * 任务范围的重验：只重验已标记路径，token 相同保留；内容、暂存、未跟踪、冲突或
   * 删除状态变化只撤销受影响的那条，其他进度、草稿与真实暂存都不动。
   */
  async function reverifyTaskReviewed(): Promise<void> {
    const scope = taskScope;
    const target = taskTarget;
    if (!scope || !target) return;
    const marked = Object.keys(reviewTokens(target));
    if (marked.length === 0) return;
    const serial = ++taskReviewSerial;
    const results: { path: string; token: string | null; reason?: string }[] = [];
    for (const path of marked) {
      try {
        const result = await api.taskReviewToken(
          scope.worktree,
          scope.baselineOid,
          scope.headOid,
          path,
          opened?.generation ?? 0,
          nextId(),
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
      if (
        serial !== taskReviewSerial ||
        taskScope?.worktree !== scope.worktree ||
        taskScope?.baselineOid !== scope.baselineOid ||
        taskScope?.headOid !== scope.headOid
      ) {
        return;
      }
    }
    const invalidations = applyReviewReverificationIn(target, results);
    if (invalidations.length > 0) {
      taskReviewNote = `${invalidations.length} 个文件的快照已变化，已撤销对应的已审阅标记。`;
    }
  }

  /** 当前视图的审阅范围：任务视图用任务页解析出的范围，改动视图固定为当前未提交改动。 */
  function activeReviewTarget(): ReviewTarget | null {
    if (inTask) return taskTarget;
    return changesTarget;
  }

  /**
   * 标记 / 撤销整文件已审阅：只读确认快照，不暂存、不提交、不写 state.json。
   * 任务范围用 task_review_token（绑定 worktree、起点与这条路径的最终净内容），
   * 改动范围沿用 repository_review_token。
   */
  async function toggleReviewed(path: string): Promise<void> {
    const current = opened;
    const target = activeReviewTarget();
    if (!current || !target) return;
    const scope = target.scope === CHANGES_SCOPE ? null : taskScope;
    const note = (message: string | null) => {
      if (scope) taskReviewNote = message;
      else reviewNote = message;
    };
    if (isReviewedIn(target, path)) {
      unmarkReviewedIn(target, path);
      note(null);
      return;
    }
    if (target.scope !== CHANGES_SCOPE && !scope) return;
    reviewBusy = path;
    note(null);
    try {
      const result = scope
        ? await api.taskReviewToken(scope.worktree, scope.baselineOid, scope.headOid, path, current.generation, nextId())
        : await api.repositoryReviewToken(current.summary.path, path, current.generation, nextId());
      // 确认期间换了范围或仓库：这次结果不属于当前范围，不能拿来标记。
      const after = activeReviewTarget();
      if (!after || after.worktree !== target.worktree || after.scope !== target.scope) return;
      if (opened?.summary.path !== current.summary.path) return;
      if (result.state !== "current" || !result.token) {
        note(result.message);
        return;
      }
      markReviewedIn(target, path, result.token);
    } catch (error) {
      note(`无法标记已审阅：${normalizeError(error).message}`);
    } finally {
      if (reviewBusy === path) reviewBusy = null;
    }
  }

  function mergeSnapshot(snapshot: StatusSnapshot) {
    applySnapshot(snapshot);
    void probeMerge();
  }

  /** 写操作的失败出口：通知条统一在这里落，调用方还能拿到归一化后的失败去就地说明。 */
  function handleMutationError(error: unknown, stage?: string, next?: string): AppFailure {
    const failure = normalizeError(error);
    if (failure.generation !== undefined && opened && failure.generation > opened.generation) {
      opened = { ...opened, generation: failure.generation };
    }
    if ((failure.code === "stale" || failure.code === "stale_patch") && opened) void refresh();
    const described: AppFailure = { ...failure, message: describeFailure(failure, stage, next) };
    showError(described);
    return described;
  }

  async function stagePath(relative: string) {
    await stagePaths([relative]);
  }

  async function stagePaths(paths: string[]) {
    const current = opened;
    if (!current || pending || reading || paths.length === 0) return;
    pending = "stage";
    live = "正在暂存文件";
    try {
      const snapshot = await api.stageFiles(current.summary.path, paths, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      banner = null;
      applySnapshot(snapshot);
      live = paths.length === 1 ? `已暂存 ${paths[0]}` : `已暂存 ${paths.length} 个文件`;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  async function unstagePath(relative: string) {
    await unstagePaths([relative]);
  }

  async function unstagePaths(paths: string[]) {
    const current = opened;
    if (!current || pending || reading || paths.length === 0) return;
    pending = "unstage";
    live = "正在取消暂存";
    try {
      const snapshot = await api.unstageFiles(current.summary.path, paths, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      banner = null;
      applySnapshot(snapshot);
      live = paths.length === 1 ? `已取消暂存 ${paths[0]}` : `已取消暂存 ${paths.length} 个文件`;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  /**
   * 多选批量暂存或取消暂存：沿用单文件 api 逐个串行，全程占着写锁。一个文件失败不影响其它文件。
   * stale 表示这次什么都没写（见 src-tauri/src/git/mod.rs），而且常常是批量自己引发的：
   * git add 写 .git/index，监视器防抖后推高 generation。所以收下新 generation 重试当前文件，
   * 与后端 settle_read 同样最多 6 次；还不行才说明仓库在持续变化，停下来，其余算未处理。
   */
  async function runBatch(kind: "stage" | "unstage", paths: string[]) {
    const current = opened;
    if (!current || pending || reading || paths.length === 0) return;
    const verb = kind === "stage" ? "暂存" : "取消暂存";
    const failed: { path: string; message: string }[] = [];
    let latest: StatusSnapshot | null = null;
    let lastFailure: unknown = null;
    let done = 0;
    let skipped = 0;
    pending = kind;
    batchRunning = true;
    try {
      for (const [index, path] of paths.entries()) {
        if (opened?.summary.path !== current.summary.path) return;
        live = `正在${verb} ${index + 1}/${paths.length}`;
        let retries = 0;
        let halted = false;
        while (true) {
          try {
            const call = kind === "stage" ? api.stageFiles : api.unstageFiles;
            const snapshot: StatusSnapshot = await call(current.summary.path, [path], opened.generation, nextId());
            latest = snapshot;
            if (opened?.summary.path !== current.summary.path) return;
            // 响应在路上时监视器可能已经推高 generation，不能退回去，否则下一个文件必然 stale。
            opened = { ...opened, snapshot, generation: Math.max(opened.generation, snapshot.generation) };
            settleSelection(createSelectionResolver(snapshot.files, true));
            done += 1;
          } catch (error) {
            if (opened?.summary.path !== current.summary.path) return;
            const failure = normalizeError(error);
            const stale = failure.code === "stale" && failure.generation !== undefined;
            if (stale && retries < BATCH_STALE_RETRIES) {
              retries += 1;
              opened = { ...opened, generation: Math.max(opened.generation, failure.generation ?? 0) };
              continue;
            }
            lastFailure = failure;
            failed.push({ path, message: stale ? `仓库状态持续变化，重试 ${retries} 次后停止` : failure.message });
            if (failure.code === "stale" || failure.code === "stale_patch") {
              skipped = paths.length - index - 1;
              halted = true;
            }
          }
          break;
        }
        if (halted) break;
      }
      if (opened?.summary.path !== current.summary.path) return;
      if (latest) applySnapshot({ ...latest, generation: Math.max(opened.generation, latest.generation) });
      const summary = batchSummary(verb, done, failed, skipped);
      if (lastFailure) {
        handleMutationError(lastFailure);
        banner = summary;
      } else {
        banner = null;
      }
      live = summary;
    } finally {
      batchRunning = false;
      pending = null;
    }
  }

  async function stageHunk(hunk: DiffHunk) {
    if (selected && diff) await stageHunkOf(selected, diff, hunk);
  }

  /** 按块暂存：单文件取当前差异，多文件视图传入所在文件块的差异。 */
  async function stageHunkOf(choice: FileSelection, currentDiff: DiffResponse, hunk: DiffHunk) {
    const current = opened;
    if (!current || pending || reading || !hunk.stageable) return;
    pending = "hunk";
    live = choice.side === "staged" ? "正在取消暂存代码块" : "正在暂存代码块";
    try {
      const file = current.snapshot.files.find((item) => item.path === choice.path);
      const snapshot = await api.stageHunks(
        current.summary.path,
        choice.path,
        choice.side === "staged",
        [hunk.index],
        currentDiff.snapshot,
        current.generation,
        nextId(),
        file?.originalPath ?? null,
      );
      if (opened?.summary.path !== current.summary.path) return;
      banner = null;
      applySnapshot(snapshot);
      live = choice.side === "staged" ? "已取消暂存所选代码块" : "已暂存所选代码块";
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  /**
   * 逐行暂存 / 取消暂存：与按块走同一条写锁与 snapshot 校验，只是补丁由后端按行身份构造。
   * 失败时只说明原因并刷新可见状态，不扩大暂存范围，也不清掉提交说明草稿。
   */
  async function stageLinesOf(choice: FileSelection, currentDiff: DiffResponse, lines: DiffLineSelection[]) {
    const current = opened;
    if (!current || pending || reading || lines.length === 0) return;
    pending = "line";
    live = choice.side === "staged" ? "正在取消暂存选中的行" : "正在暂存选中的行";
    try {
      const file = current.snapshot.files.find((item) => item.path === choice.path);
      const snapshot = await api.stageLines(
        current.summary.path,
        choice.path,
        choice.side === "staged",
        lines,
        currentDiff.snapshot,
        current.generation,
        nextId(),
        file?.originalPath ?? null,
      );
      if (opened?.summary.path !== current.summary.path) return;
      banner = null;
      applySnapshot(snapshot);
      live = choice.side === "staged" ? "已取消暂存选中的行" : "已暂存选中的行";
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  async function loadMoreDiff() {
    const current = opened;
    const choice = selected;
    const currentDiff = diff;
    if (!current || !choice || !currentDiff || pending || reading) return;
    if (currentDiff.offset + currentDiff.lines.length >= currentDiff.totalLines) return;
    pending = "diff";
    try {
      const file = current.snapshot.files.find((item) => item.path === choice.path);
      const result = await api.loadDiff(
        current.summary.path,
        choice.path,
        choice.side === "staged",
        current.generation,
        nextId(),
        file?.originalPath ?? null,
        currentDiff.offset + currentDiff.lines.length,
        400,
        diffFullFile ? FULL_FILE_CONTEXT : undefined,
        ...(diffAsText !== null && diffAsText === asTextKey(choice) ? [true] : []),
      );
      if (opened?.summary.path !== current.summary.path) return;
      if (selected?.path !== choice.path || selected.side !== choice.side) return;
      const base = currentDiff.lines.length;
      diff = {
        ...result,
        offset: currentDiff.offset,
        lines: [...currentDiff.lines, ...result.lines],
        hunks: mergeHunks(currentDiff.hunks, result.hunks, base),
        totalLines: result.totalLines,
      };
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  function mergeHunks(current: DiffHunk[], extra: DiffHunk[], base: number): DiffHunk[] {
    const merged = new Map(current.map((hunk) => [hunk.index, hunk]));
    for (const hunk of extra) {
      if (!merged.has(hunk.index)) {
        merged.set(hunk.index, { ...hunk, startLine: hunk.startLine + base });
      }
    }
    return [...merged.values()];
  }

  async function commitLocal() {
    // 写入入口自己也认这一层：原生菜单「提交」不经键盘层，阅读窗口写着只读，
    // 就不能让一次菜单点击在它底下创建提交（R3/R6）。
    if (taskLayerOpen) return;
    const current = opened;
    if (!current || pending || reading) return;
    const message = draft;
    if (!hasCommitSummary(message)) {
      banner = "请先填写提交摘要。";
      live = banner;
      return;
    }
    if (commitScope(branchText, current.snapshot.files).paths.length === 0) {
      banner = "暂存区是空的，没有可以提交的内容。";
      live = banner;
      return;
    }
    pending = "commit";
    live = "正在创建本地提交";
    // 新一次尝试开始：上一次失败的原因不再代表当前状态。
    commitError = null;
    pushFailure = null;
    pushRetry = false;
    try {
      await flushDraft(current.summary.path);
      const result = await api.commitChanges(current.summary.path, message, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      if (result.pushed) {
        banner = "本地提交不应触发推送，请刷新后确认远程没有变化。";
        live = banner;
      }
      draft = "";
      drafts.load(current.summary.path, "");
      opened = { ...opened, snapshot: result.snapshot, generation: result.generation, draft: "" };
      selected = selectionAfterEdit(result.snapshot.files, selected);
      selectedSet = [];
      banner = result.pushed ? banner : null;
      // 成功要看得见：提交后暂存区清空、说明框收起，界面上只剩「领先」数字悄悄加一。
      // 与「提交并推送」一样用通知条报出提交了什么，几秒后自动收起。
      if (!result.pushed) phaseNote = result.summary;
      live = result.summary;
      void probeMerge();
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        // R5：失败原因要留在提交区里（缺身份、钩子拒绝、索引锁、过期各自可辨），
        // 草稿与仍然有效的暂存都不动，通知条只是第二条渠道。
        commitError = handleMutationError(
          error,
          "本地提交",
          "草稿和已暂存内容都已保留，可以修改后重试。",
        ).message;
      }
    } finally {
      pending = null;
    }
  }

  async function commitAndPush() {
    // 与「提交到本地」同一条界面层边界：任务弹窗或阅读窗口占层期间不落到背景（R3/R6）。
    if (taskLayerOpen) return;
    const current = opened;
    if (!current || pending || reading) return;
    const message = draft;
    if (!hasCommitSummary(message)) {
      banner = "请先填写提交摘要。";
      live = banner;
      return;
    }
    if (commitScope(branchText, current.snapshot.files).paths.length === 0) {
      banner = "暂存区是空的，没有可以提交的内容。";
      live = banner;
      return;
    }
    pending = "commit-push";
    phaseNote = "正在创建本地提交";
    live = phaseNote;
    // 与「提交到本地」同源：新一次尝试开始就清掉上一次的行内原因。
    commitError = null;
    pushFailure = null;
    try {
      await flushDraft(current.summary.path);
      const result = await api.commitAndPush(current.summary.path, message, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      draft = "";
      drafts.load(current.summary.path, "");
      opened = { ...opened, snapshot: result.snapshot, generation: result.generation, draft: "" };
      selected = selectionAfterEdit(result.snapshot.files, selected);
      selectedSet = [];
      pushRetry = result.retryPush;
      if (result.pushed) {
        pushFailure = null;
        phaseNote = result.summary;
        banner = null;
        live = result.summary;
      } else {
        // 本地提交已经落地，失败只在推送：两个阶段分开说明，重试入口只推送（R6）。
        pushFailure = describeFailure(
          { code: "push_failed", message: result.pushError ?? "推送没有完成。" },
          "推送",
          `本地提交 ${shortOid(result.oid)} 已完成，重试只推送，不会再次提交。`,
        );
        phaseNote = null;
        banner = pushFailure;
        live = pushFailure;
      }
      void probeMerge();
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        // 这里失败的是「先完成本地提交」那一段（推送失败走 pushError，不抛）。
        // 两条提交路径因此给出同一份就地原因，而不是只有「提交到本地」这一条。
        commitError = handleMutationError(
          error,
          "本地提交",
          "推送还没有开始；草稿和已暂存内容都已保留，可以重试。",
        ).message;
      }
    } finally {
      pending = null;
    }
  }

  async function retryPush() {
    const current = opened;
    if (!current || pending || reading) return;
    pending = "push";
    phaseNote = "正在重试推送，不会再次提交";
    live = phaseNote;
    try {
      const snapshot = current.snapshot.branch.upstream
        ? await api.pushBranch(current.summary.path, current.generation, nextId())
        : await api.publishBranch(current.summary.path, "", current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      applySnapshot(snapshot);
      pushRetry = false;
      pushFailure = null;
      phaseNote = "推送已完成。没有再次创建提交。";
      banner = null;
      live = phaseNote;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        pushRetry = true;
        pushFailure = handleMutationError(
          error,
          "推送",
          "本地提交已保留；可以继续重试推送，不会再次提交。",
        ).message;
        banner = pushFailure;
      }
    } finally {
      pending = null;
    }
  }

  async function runSync(
    name: string,
    action: (path: string, generation: number) => Promise<StatusSnapshot>,
    labels?: { live: string; done: string },
  ) {
    const current = opened;
    if (!current || pending || reading) return;
    pending = name;
    syncCancelling = false;
    live = labels?.live ?? (
      name === "fetch"
        ? "正在检查远程"
        : name === "pull"
          ? "正在快进拉取"
          : name === "publish"
            ? "正在发布分支"
            : name === "associate"
              ? "正在关联上游，不会推送"
                : "正在推送");
    try {
      const snapshot = await action(current.summary.path, current.generation);
      if (opened?.summary.path !== current.summary.path) return;
      applySnapshot(snapshot);
      banner = null;
      if (name === "push" || name === "publish") {
        pushRetry = false;
        pushFailure = null;
      }
      phaseNote = labels?.done ?? (
        name === "fetch"
          ? "远程检查已完成，工作区文件没有因为检查而改变。"
          : name === "pull"
            ? "快进拉取已完成，文件和同步状态已刷新。"
            : name === "publish"
              ? "分支已发布并关联上游。"
              : name === "associate"
                ? "已关联上游。这一步没有推送。"
                : "推送已完成，没有强行推送。");
      live = phaseNote;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        if (name === "pull" && openDivergedPull(current, error)) return;
        const failure = normalizeError(error);
        if (failure.code === "cancelled" && syncCancelling) {
          if (failure.generation !== undefined) adoptGeneration(failure.generation);
          notice(failure.message);
          void refresh();
          return;
        }
        const context = SYNC_FAILURE[name];
        handleMutationError(failure, context?.stage, context?.next);
      }
    } finally {
      pending = null;
      syncCancelling = false;
    }
  }

  /** 远程操作卡在网络或凭据上时由用户停下：只停这个仓库的远程命令，结果按刷新后的实际状态显示。 */
  function cancelSync() {
    const current = opened;
    if (!current || !pending || !REMOTE_PENDING.has(pending) || syncCancelling) return;
    syncCancelling = true;
    live = "正在取消远程操作";
    void api.cancelRemote(current.summary.path).catch((error: unknown) => {
      syncCancelling = false;
      showError(error);
    });
  }

  /** 同步菜单打开时读一次远程列表：有多个远程时提供「推送到其他远程」。 */
  async function loadRemoteNames() {
    const current = opened;
    // 写入或读取进行中不额外发读取：菜单此时也不可操作，锁释放后再打开会读到最新列表。
    if (!current || pending || reading || remoteNamesFor === current.summary.path) return;
    try {
      const result = await api.remoteState(current.summary.path, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      remoteNames = result.remotes.map((remote) => remote.name);
      remoteNamesFor = current.summary.path;
    } catch {
      // 读不到远程不影响常规推送；菜单只是不显示额外的远程。
    }
  }

  /** 推送到指定远程的同名分支；不改上游。 */
  function pushTo(remote: string) {
    void runSync("push", (path, generation) => api.pushToRemote(path, remote, generation, nextId()), {
      live: `正在推送到 ${remote}`,
      done: `已推送到 ${remote}，没有强行推送，上游保持不变。`,
    });
  }

  /** 依次推送到全部远程：先推上游（没有上游时发布到默认远程），再推其他远程；任一失败即停下并说明。 */
  function pushToAll() {
    const names = [...remoteNames];
    const upstreamRemote = opened?.snapshot.branch.upstream?.split("/")[0] ?? null;
    const others = names.filter((name) => name !== upstreamRemote);
    void runSync(
      "push",
      async (path, generation) => {
        let snapshot = upstreamRemote
          ? await api.pushBranch(path, generation, nextId())
          : await api.pushToRemote(path, others.shift() ?? names[0], generation, nextId());
        for (const remote of others) {
          live = `正在推送到 ${remote}`;
          snapshot = await api.pushToRemote(path, remote, snapshot.generation, nextId());
        }
        return snapshot;
      },
      { live: `正在推送到全部 ${names.length} 个远程`, done: `已推送到 ${names.join("、")}，没有强行推送。` },
    );
  }

  /** 分叉时不把快进失败当成终点：打开现有合并界面选择方式，当前分支先不动。 */
  function openDivergedPull(current: OpenedRepository, error: unknown): boolean {
    const failure = normalizeError(error);
    const branch = current.snapshot.branch;
    if (failure.code !== "diverged" || branch.detached || branch.unborn || !branch.name || !branch.upstream) return false;
    if (failure.generation !== undefined) adoptGeneration(failure.generation);
    mergeSource = branch.upstream;
    mergeTarget = branch.name;
    mergeMode = pullIntegration;
    banner = null;
    phaseNote = "本地和上游都有新提交，当前分支还没有移动。请选择合并或变基。";
    live = phaseNote;
    openTask("merge");
    return true;
  }

  async function addRepo() {
    await addExistingRepository();
  }

  async function dropRepository(paths: string[]) {
    draggingRepository = false;
    if (writeLocked) {
      notice(switchBlockedReason(commandState));
      return;
    }
    if (taskModal || cloneOpen || dependencyOpen || confirmPath || paletteOpen || openModalCount() > 0) {
      notice("请先关闭当前对话框，再拖入仓库文件夹。");
      return;
    }
    if (paths.length !== 1) {
      notice("请一次拖入一个仓库文件夹。");
      return;
    }
    await addExistingRepository(paths[0]);
  }

  async function addExistingRepository(droppedPath?: string) {
    if (pending || reading) return;
    pending = "add";
    live = droppedPath ? "正在读取仓库状态" : "正在选择目录";
    try {
      const path = droppedPath ?? await pickDirectory("添加已有仓库");
      if (!path) return;
      if (!(await confirmEditorLeave("打开另一个仓库"))) return;
      if ((await flushDraft(drafts.path)) === false) return;
      live = "正在读取仓库状态";
      // 和切换最近仓库同一条路径：先停掉当前仓库还在排队的只读请求（历史分页、文件树、
      // 大小统计……）。读取并发有上限，不停掉的话新仓库的状态读取要排在它们后面，打开会很慢。
      await api.cancelReads().catch(() => undefined);
      const openedRepo = await api.addRepository(path, nextId());
      banner = null;
      rememberOpened(openedRepo);
    } catch (error) {
      showError(error);
    } finally {
      pending = null;
    }
  }

  async function chooseCreate() {
    if (pending || reading) return;
    if (!(await confirmEditorLeave("新建并打开仓库"))) return;
    const path = await pickDirectory("选择要新建仓库的目录");
    if (!path) return;
    confirmPath = path;
  }

  async function confirmCreate() {
    const path = confirmPath;
    if (!path || pending || reading) return;
    confirmPath = null;
    pending = "create";
    live = "正在初始化仓库";
    try {
      const openedRepo = await api.createRepository(path, nextId());
      banner = null;
      rememberOpened(openedRepo);
    } catch (error) {
      showError(error);
    } finally {
      pending = null;
    }
  }

  /** 审查链接的到达序号：后到的新链接优先，旧的打开结果不再抢来源。 */
  let clioraLinkSerial = 0;

  /**
   * 本实例已处理过的 reviewId。冷启动的 getCurrent 与运行中的 onOpenUrl 可能对同一条
   * 链接各派发一次，协议要求同一 reviewId 只处理一次。Set 是组件实例变量，不跨实例保留。
   */
  const handledReviews = new Set<string>();

  /**
   * 打开失败时回执里的稳定错误码。只做码的映射：不回传原始 Git 文本，未知错误统一
   * open_failed，避免把内部细节带进链接。
   */
  function clioraRejectReason(code: string): string {
    if (code === "not_repository" || code === "not_worktree") return "not_a_worktree";
    // 协议里 invalid_path 覆盖“相对、越界或无法 canonicalize”，所以路径不存在与
    // 无法解析也归到这一类，而不是笼统的 open_failed。
    if (code === "invalid_path" || code === "not_directory" || code === "path_missing" || code === "path_unreadable") {
      return "invalid_path";
    }
    if (code === "unsupported_version" || code === "malformed_request") return code;
    return "open_failed";
  }

  /** 回送拒绝。回执自身失败只写 live，不再抛出：本地错误才是用户要看的原因。 */
  async function rejectCliora(request: ClioraReviewRequest, reason: string) {
    try {
      await api.clioraReviewReceipt(request.reviewId, request.sessionId, false, reason);
    } catch (error) {
      live = normalizeError(error).message + "（" + reason + "）";
    }
  }

  /**
   * 处理 v2 审查链接（冷启动与运行中都走这里）。
   *
   * 解析在 Rust 侧完成；这里只按解析出的 worktreePath 调既有 openRepository：打开的是
   * 链接指定的那个工作树，子目录/父仓库都不会被替代，失败也不回退主检出。成功后建立
   * 来源上下文并回送 accepted，失败回送 rejected 并显示本地错误。整个过程不写 Git。
   */
  async function handleClioraLink(url: string) {
    const serial = ++clioraLinkSerial;
    let request: ClioraReviewRequest;
    try {
      request = await api.clioraReviewRequest(url);
    } catch (error) {
      // 解析失败时没有可信的 reviewId/sessionId，不能伪造回执，只能在本地说明。
      live = "cliora 审查链接无效，未打开任何仓库，仓库没有改动。";
      showError(error);
      return;
    }
    if (serial !== clioraLinkSerial) return;
    // 同一条链接被冷启动与热启动各派发一次时，第二次在打开之前就结束：不重复打开、不重复回执。
    if (handledReviews.has(request.reviewId)) return;
    handledReviews.add(request.reviewId);
    if (openModalCount() > 0 || switchBlocked(commandState)) {
      await rejectCliora(request, "open_failed");
      notice("请先关闭当前对话框并等待操作完成，再从 cliora 重新发起审查。");
      return;
    }
    // 链接要打开另一个工作区：当前仓库的未保存草稿先保存、放弃或取消；取消就拒绝这条链接。
    if (opened && !samePath(opened.summary.path, request.worktreePath)) {
      const proceed = await confirmEditorLeave("按 cliora 审查链接打开另一个工作区");
      if (!proceed || serial !== clioraLinkSerial) {
        await rejectCliora(request, "open_failed");
        if (!proceed) notice("已保留未保存的编辑草稿，没有打开 cliora 审查链接。");
        return;
      }
    }
    try {
      await api.cancelReads();
      if (serial !== clioraLinkSerial) return;
      const openedRepo = await api.openRepository(request.worktreePath, nextId());
      if (serial !== clioraLinkSerial) return;
      rememberOpened(openedRepo);
      beginClioraReview({
        reviewId: request.reviewId,
        sessionId: request.sessionId,
        worktreePath: openedRepo.summary.path,
        baseline: request.baseline,
      });
      // 链接自带已校验起点：历史按任务范围过滤并选中「任务净差异」。没有起点时只打开普通历史，
      // 不用当前 HEAD 或默认分支补一个（R1）。
      openTaskReview(clioraBaseline());
      live = "已按 cliora 审查链接打开 " + openedRepo.summary.name;
      await api.clioraReviewReceipt(request.reviewId, request.sessionId, true, null);
    } catch (error) {
      const failure = normalizeError(error);
      const reason = clioraRejectReason(failure.code);
      await rejectCliora(request, reason);
      // 这条链接已经被更晚的链接取代：回执仍按它自己的 reviewId 回送，但不再改写界面
      // 提示，免得旧链接的失败盖住新链接刚打开的结果。
      if (serial !== clioraLinkSerial) return;
      if (failure.code === "cancelled") {
        live = "已取消读取，没有写入仓库。";
        return;
      }
      showError(error);
    }
  }

  /**
   * 返回发起这次审查的 cliora 会话：只回送最新结果，不执行任何 Git 写入，也不关闭仓库、
   * 不清空草稿。没有来源时按钮不显示，这里再挡一次。
   */
  async function returnToCliora() {
    const source = clioraReview.source;
    if (!source) return;
    // 返回来源前未保存的草稿必须有结论：保存只写工作区，不会变成提交或合入结果。
    if (!(await confirmEditorLeave("返回 cliora"))) return;
    if (clioraReview.source?.reviewId !== source.reviewId) return;
    const { outcome, headOid } = clioraReturnOutcome();
    // 工作区声明由后端按来源工作树读取真实 Git 状态填写，前端不声明。这里刷新一次只为
    // 后端没给出结果时提示仍按真实快照说明；当前仓库已不是来源工作树就当作没读到。
    const fresh = await refresh().catch(() => false);
    if (clioraReview.source?.reviewId !== source.reviewId) return;
    const current = opened;
    const localUncommitted =
      fresh && current && clioraSourceMatches(current.summary.path) ? current.snapshot.files.length : null;
    try {
      const sent = await api.clioraReviewReturn(source.reviewId, source.sessionId, outcome, headOid);
      // 普通保存不制造提交或合入结果；工作区还有未提交修改时如实说出来，不再说「只做了浏览」。
      notice(clioraReturnNotice(outcome, sent, localUncommitted));
    } catch (error) {
      showError(error);
    }
  }

  /** 两个仓库路径是否指向同一处：只抹平分隔符与尾部斜杠，Windows 下不区分大小写。 */
  function samePath(a: string, b: string): boolean {
    const norm = (value: string) => {
      const flat = value.replace(/\\/g, "/").replace(/\/+$/, "");
      return /^[a-z]:\//i.test(flat) ? flat.toLowerCase() : flat;
    };
    return norm(a) === norm(b);
  }

  async function openRecent(path: string) {
    // 任何确认层/任务弹窗打开时都不切换仓库：旧确认层不能留在新仓库上继续生效。
    if (openModalCount() > 0) {
      notice("请先关闭当前对话框，再切换仓库。");
      return;
    }
    // 切到另一个仓库前，当前仓库的未保存编辑草稿必须保存、放弃或取消。
    if (opened && !samePath(opened.summary.path, path) && !(await confirmEditorLeave("切换仓库"))) return;
    if (switchBlocked(commandState)) {
      // R11：仓库弹层与命令面板已按同一条判定禁用，但快捷入口和测量钩子仍会走到这里，
      // 所以不能静默返回——把同一个原因说出来，各入口的结论才一致。
      notice(switchBlockedReason(commandState));
      return;
    }
    const serial = ++readSerial;
    reading = true;
    readPhase = "idle";
    stopRefreshIndicator();
    live = "正在读取仓库状态";
    try {
      await api.cancelReads();
      if (serial !== readSerial) return;
      readPhase = "reading";
      const openedRepo = await api.openRepository(path, nextId());
      if (serial !== readSerial) return;
      banner = null;
      rememberOpened(openedRepo);
      live = `已打开 ${openedRepo.summary.name}`;
    } catch (error) {
      if (serial !== readSerial) return;
      const failure = normalizeError(error);
      if (failure.code === "cancelled") {
        live = "已取消读取，没有写入仓库。";
        return;
      }
      showError(error);
    } finally {
      if (serial === readSerial) {
        reading = false;
        readPhase = "settled";
      }
    }
  }

  async function cancelReading() {
    if (!reading) return;
    readSerial += 1;
    reading = false;
    live = "已取消读取，没有写入仓库。";
    try {
      await api.cancelReads();
    } catch (error) {
      showError(error);
    }
  }

  async function forget(path: string) {
    if (opened?.summary.path === path && !(await confirmEditorLeave("关闭并移除这个仓库"))) return;
    try {
      recent = await api.forgetRecent(path);
      if (opened?.summary.path === path) {
        await api.closeRepository();
        repositoryEpoch += 1;
        fileEditor.retainRepository("");
        editOrigin = null;
        editRequest = null;
        opened = null;
        selected = null;
        selectedSet = [];
        diff = null;
        draft = "";
        commitError = null;
        pushFailure = null;
        pushRetry = false;
        stopRefreshIndicator();
        degraded = false;
        workspaceView = "changes";
        historyPath = null;
        filesNav = null;
        taskRequest = null;
        taskSummary = null;
        taskNav = null;
        taskHunk = null;
        taskScope = null;
        taskSelectedPath = null;
        taskReviewNav = null;
        taskReviewNote = null;
        taskModal = null;
        cloneOpen = false;
        paletteOpen = false;
        mergeInProgress = false;
        mergeAbortable = false;
      }
    } catch (error) {
      showError(error);
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      notice("已复制仓库完整路径。");
    } catch {
      showError(new Error("无法写入剪贴板，请手动复制仓库路径。"));
    }
  }

  function readFullFilePreference(): boolean {
    try {
      return globalThis.localStorage?.getItem("twiglane.diffFullFile") === "1";
    } catch {
      return false;
    }
  }

  function setFullFile(next: boolean) {
    diffFullFile = next;
    try {
      globalThis.localStorage?.setItem("twiglane.diffFullFile", next ? "1" : "0");
    } catch {
      // 存储不可用时只在本次会话里生效。
    }
    void loadSelectedDiff();
  }

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      notice(`已复制${what}。`);
    } catch {
      showError(new Error(`无法写入剪贴板，请手动复制${what}。`));
    }
  }

  function absolutePath(relative: string): string {
    const root = opened?.summary.path ?? "";
    const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    // 仓库路径是 Windows 风格（只含反斜杠）时用反斜杠拼接，否则用斜杠；去掉末尾多余的分隔符。
    return `${root.replace(/[\\/]+$/, "")}${separator}${relative.split("/").join(separator)}`;
  }

  async function revealInFolder(relative: string) {
    const current = opened;
    if (!current) return;
    try {
      await api.revealPath(current.summary.path, relative);
    } catch (error) {
      showError(normalizeError(error));
    }
  }

  async function openWithDefault(relative: string) {
    const current = opened;
    if (!current) return;
    try {
      await api.openPath(current.summary.path, relative);
    } catch (error) {
      showError(normalizeError(error));
    }
  }

  async function ignore(relative: string, local: boolean) {
    const current = opened;
    if (!current || pending || reading) return;
    pending = "ignore";
    try {
      const outcome = await api.ignorePath(current.summary.path, `/${relative}`, local, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      applySnapshot(outcome.snapshot);
      notice(outcome.note);
    } catch (error) {
      handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  /** 右键已选文件：动作作用于全部选中，冲突文件排除并说明，放弃仍先列出全部影响（R19）。 */
  function batchContextMenu(point: { x: number; y: number }) {
    const busy = writeLocked ? switchBlockedReason(commandState) : undefined;
    const { stage, unstage, discard, conflicts } = batch;
    const entries: ContextMenuEntry[] = [{ heading: `已选 ${selectedRows.length} 个文件` }];
    if (stage.length > 0) entries.push({ id: "stage", label: `暂存 ${stage.length} 个文件`, icon: "plus", shortcut: "空格", disabledReason: busy, run: () => void runBatch("stage", stage) });
    if (unstage.length > 0) entries.push({ id: "unstage", label: `取消暂存 ${unstage.length} 个文件`, icon: "minus", disabledReason: busy, run: () => void runBatch("unstage", unstage) });
    if (discard.length > 0) entries.push({ id: "discard", label: `放弃 ${discard.length} 个文件的更改…`, icon: "trash", danger: true, disabledReason: busy, run: () => void recovery?.discard(discard) });
    if (conflicts > 0) entries.push({ heading: `已排除 ${conflicts} 个冲突文件，请到分支合并里处理` });
    entries.push({ separator: true });
    entries.push({ id: "copy-rel", label: "复制相对路径", icon: "copy", run: () => void copyText(selectedRows.map((item) => item.path).join("\n"), "相对路径") });
    contextMenu = { x: point.x, y: point.y, entries, label: `${selectedRows.length} 个文件的操作` };
  }

  function fileContextMenu(row: FileRow, point: { x: number; y: number }) {
    if (multiActive && selectedRows.some((item) => sameSelection(item, row))) {
      batchContextMenu(point);
      return;
    }
    const busy = writeLocked ? switchBlockedReason(commandState) : undefined;
    const deleted = row.side === "unstaged" ? row.unstaged === "deleted" : row.staged === "deleted";
    const entries: ContextMenuEntry[] = [];
    if (row.unmerged) {
      entries.push({ id: "resolve", label: "处理冲突…", icon: "merge", run: () => openConflict(row.path) });
    } else if (row.side === "unstaged") {
      entries.push({ id: "stage", label: "暂存", icon: "plus", shortcut: "空格", disabledReason: busy, run: () => void stagePath(row.path) });
    } else {
      entries.push({ id: "unstage", label: "取消暂存", icon: "minus", shortcut: "空格", disabledReason: busy, run: () => void unstagePath(row.path) });
    }
    if (!row.unmerged) {
      entries.push({
        id: "discard",
        label: row.untracked ? "删除未跟踪文件…" : "放弃更改…",
        icon: "trash",
        danger: true,
        disabledReason: busy,
        run: () => void recovery?.discard([row.path]),
      });
    }
    entries.push({ separator: true });
    entries.push({
      id: "full",
      label: diffFullFile ? "只看改动部分" : "查看完整文件",
      icon: "rows",
      run: () => {
        if (selected?.path !== row.path || selected.side !== row.side) selectFile({ path: row.path, side: row.side });
        setFullFile(!diffFullFile);
      },
    });
    entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => openFileHistory(row.path) });
    if (filesViewEnabled) {
      entries.push({
        id: "files",
        label: "在文件树中显示",
        icon: "folder",
        run: () => void revealInFiles(row.path),
      });
    }
    entries.push({ separator: true });
    entries.push({
      id: "reveal",
      label: navigator.platform?.toLowerCase().includes("mac") ? "在访达中显示" : "在资源管理器中显示",
      icon: "folder-open",
      run: () => void revealInFolder(row.path),
    });
    entries.push({
      id: "open",
      label: "用默认程序打开",
      icon: "file",
      disabledReason: deleted ? "文件已删除，工作区里没有它" : undefined,
      run: () => void openWithDefault(row.path),
    });
    entries.push({ separator: true });
    entries.push({ id: "copy-rel", label: "复制相对路径", icon: "copy", run: () => void copyText(row.path, "相对路径") });
    entries.push({ id: "copy-abs", label: "复制完整路径", icon: "copy", run: () => void copyText(absolutePath(row.path), "完整路径") });
    entries.push({ id: "copy-name", label: "复制文件名", icon: "copy", run: () => void copyText(row.path.split("/").pop() ?? row.path, "文件名") });
    entries.push({ separator: true });
    entries.push({
      id: "ignore-git",
      label: "加入 .gitignore",
      icon: "eye",
      disabledReason: busy,
      run: () => void ignore(row.path, false),
    });
    entries.push({
      id: "ignore-local",
      label: "加入 .git/info/exclude",
      icon: "eye",
      disabledReason: busy,
      run: () => void ignore(row.path, true),
    });
    contextMenu = { x: point.x, y: point.y, entries, label: `${row.path} 的操作` };
  }

  /**
   * 临时保存清单里的文件：查看改动、定位、复制；未跟踪文件还能直接加入忽略，
   * 写入后临时保存的范围随状态刷新，这些文件就从「未跟踪」移到「忽略」。
   * 已跟踪文件不提供忽略：规则对已跟踪的文件不起作用，放在这里只会误导。
   */
  function stashFileMenu(path: string, kind: "tracked" | "untracked" | "ignored", point: { x: number; y: number }) {
    const busy = writeLocked ? switchBlockedReason(commandState) : undefined;
    const row = opened?.snapshot.files.find((file) => file.path === path) ?? null;
    const deleted = row ? row.unstaged === "deleted" || (row.unstaged === "none" && row.staged === "deleted") : false;
    const name = path.split("/").pop() ?? path;
    const entries: ContextMenuEntry[] = [];
    if (row && kind !== "ignored") {
      entries.push({
        id: "changes",
        label: "查看改动",
        icon: "file-diff",
        run: () => {
          closeTask();
          showChanges();
          selectFile({ path, side: row.untracked || row.unstaged !== "none" ? "unstaged" : "staged" });
        },
      });
      if (kind === "tracked") {
        entries.push({
          id: "history",
          label: "查看文件历史",
          icon: "history",
          run: () => {
            closeTask();
            openFileHistory(path);
          },
        });
      }
      entries.push({ separator: true });
    }
    entries.push({
      id: "reveal",
      label: navigator.platform?.toLowerCase().includes("mac") ? "在访达中显示" : "在资源管理器中显示",
      icon: "folder-open",
      run: () => void revealInFolder(path),
    });
    entries.push({
      id: "open",
      label: "用默认程序打开",
      icon: "file",
      disabledReason: deleted ? "文件已删除，工作区里没有它" : undefined,
      run: () => void openWithDefault(path),
    });
    entries.push({ separator: true });
    entries.push({ id: "copy-rel", label: "复制相对路径", icon: "copy", run: () => void copyText(path, "相对路径") });
    entries.push({ id: "copy-abs", label: "复制完整路径", icon: "copy", run: () => void copyText(absolutePath(path), "完整路径") });
    entries.push({ id: "copy-name", label: "复制文件名", icon: "copy", run: () => void copyText(name, "文件名") });
    if (kind === "untracked") {
      // 与改动列表的右键菜单同一组忽略入口：按这个文件写规则，写入后随状态刷新移到「忽略」。
      entries.push({ separator: true });
      entries.push({ id: "ignore-git", label: "加入 .gitignore", icon: "eye", disabledReason: busy, run: () => void ignore(path, false) });
      entries.push({ id: "ignore-local", label: "加入 .git/info/exclude", icon: "eye", disabledReason: busy, run: () => void ignore(path, true) });
    }
    contextMenu = { x: point.x, y: point.y, entries, label: `${path} 的操作` };
  }

  function askRemoveWorktree(repo: RecentRepo, head: RepoHead) {
    if (repo.path === opened?.summary.path) return;
    closeSwitcher();
    worktreeRemoval = { repo, head, force: false, busy: false, error: null };
  }

  async function confirmRemoveWorktree() {
    const pending = worktreeRemoval;
    if (!pending || pending.busy) return;
    worktreeRemoval = { ...pending, busy: true, error: null };
    try {
      recent = await api.removeWorktree(pending.repo.path, pending.force, nextId());
      worktreeRemoval = null;
      notice(`已删除工作区 ${pending.repo.name}，分支${pending.head.branch ? ` ${pending.head.branch} ` : ""}和提交都保留在主仓库。`);
    } catch (error) {
      const failure = normalizeError(error);
      if (worktreeRemoval?.repo.path !== pending.repo.path) return;
      if (failure.code === "worktree_dirty" && !pending.force) {
        worktreeRemoval = { ...pending, force: true, busy: false, error: null };
      } else {
        worktreeRemoval = { ...pending, busy: false, error: failure.message };
      }
    }
  }

  function repoContextMenu(repo: RecentRepo, point: { x: number; y: number }, head: RepoHead | null = null) {
    const current = repo.path === opened?.summary.path;
    const entries: ContextMenuEntry[] = [
      {
        id: "open",
        label: current ? "当前仓库" : "打开",
        icon: "folder-open",
        disabledReason: current ? "已经是当前仓库" : switchBlocked(commandState) ? switchBlockedReason(commandState) : undefined,
        run: () => {
          closeSwitcher();
          void openRecent(repo.path);
        },
      },
      {
        id: "reveal",
        label: navigator.platform?.toLowerCase().includes("mac") ? "在访达中显示" : "在资源管理器中显示",
        icon: "folder",
        run: async () => {
          try {
            await api.revealPath(repo.path, "");
          } catch (error) {
            showError(normalizeError(error));
          }
        },
      },
      { id: "copy", label: "复制完整路径", icon: "copy", run: () => void copyPath(repo.path) },
    ];
    // 「从列表移除」只对最近列表里的仓库有意义：总览也会列出枚举出来的附属工作区。
    if (recent.some((item) => item.path === repo.path)) {
      entries.push({ separator: true });
      entries.push({ id: "forget", label: "从最近列表移除", icon: "x", danger: true, run: () => void forget(repo.path) });
    }
    if (head?.worktree && !head.missing) {
      entries.push({
        id: "remove-worktree",
        label: "删除工作区…",
        icon: "trash",
        danger: true,
        disabledReason: current ? "当前打开的工作区不能删除，先切到其他仓库" : undefined,
        run: () => askRemoveWorktree(repo, head),
      });
    }
    contextMenu = { x: point.x, y: point.y, entries, label: `${repo.name} 的操作` };
  }

  function scheduleDraftSave() {
    if (draftTimer) clearTimeout(draftTimer);
    const path = drafts.path;
    draftTimer = setTimeout(() => {
      void flushDraft(path);
    }, 400);
  }

  async function flushDraft(path: string | null) {
    if (!path) return;
    const message = drafts.takePending(path);
    if (message === null) return;
    try {
      await api.saveDraft(path, message);
    } catch (error) {
      if (drafts.peek(path) === null) drafts.edit(message);
      showError(error);
      return false;
    }
  }

  function onDraftInput(value: string) {
    draft = value;
    // 说明一改，上一次失败的原因就不再对应现在这条说明；重试前先收起来。
    commitError = null;
    drafts.edit(value);
    scheduleDraftSave();
  }

  async function chooseGit() {
    const path = await pickFile("选择 Git 可执行文件");
    if (!path) return;
    try {
      git = await api.setGitExecutable(path);
      banner = null;
      live = git.message;
    } catch (error) {
      showError(error);
    }
  }

  async function redetectGit() {
    try {
      git = await api.detectGit();
      live = git.message;
    } catch (error) {
      showError(error);
    }
  }

  async function clearGit() {
    try {
      git = await api.clearGitExecutable();
      live = git.message;
    } catch (error) {
      showError(error);
    }
  }

  async function changeTheme(next: Theme) {
    applyTheme(next);
    try {
      await api.setTheme(next);
    } catch (error) {
      showError(error);
    }
  }

  async function changePullIntegration(next: PullIntegration) {
    pullIntegration = next;
    try {
      await api.setPullIntegration(next);
    } catch (error) {
      showError(error);
    }
  }

  async function changeFilesView(next: boolean) {
    filesViewEnabled = next;
    // 正在看文件时关掉：回到改动视图，不留一个看不见的当前视图。
    if (!next && workspaceView === "files") showChanges();
    try {
      await api.setFilesView(next);
    } catch (error) {
      showError(error);
    }
  }

  async function changeBranchGroups(next: boolean) {
    branchGroups = next;
    try {
      await api.setBranchGroups(next);
    } catch (error) {
      showError(error);
    }
  }

  async function persistWidths() {
    try {
      widths = await api.setPanelWidths({
        sidebar: clampWidth(widths.sidebar),
        files: clampWidth(widths.files),
      });
    } catch (error) {
      showError(error);
    }
  }

  /**
   * 任意一层打开着：任务 modal、确认层、标题栏弹层、更多菜单、同步菜单、右键菜单都算。
   * 这些层的状态分散在各组件里，所以看 modal 计数和 DOM，不逐个枚举。
   */
  function anyLayerOpen(): boolean {
    return openModalCount() > 0 || document.querySelector(".menu, .popover, [role='menu']") !== null;
  }

  /** 菜单事件没有按键目标，只看当前焦点是不是文本框。 */
  function textFocused(): boolean {
    return isTextEntry(document.activeElement);
  }

  /**
   * 当前视图的主列表：没有仓库时是最近仓库的第一行，改动视图是文件列表，
   * 历史是提交列表，文件视图是目录树。都已经在 Tab 序列里，这里只是给方向键一个入口。
   */
  function primaryList(): HTMLElement | null {
    const view = document.querySelector<HTMLElement>('.workbench-view[data-active="true"]') ?? document;
    if (!opened) return document.querySelector<HTMLElement>(".welcome-recent > button");
    if (workspaceView === "history") return view.querySelector<HTMLElement>(".history-list");
    if (workspaceView === "files") return view.querySelector<HTMLElement>('[role="tree"]');
    return view.querySelector<HTMLElement>('.file-list[role="listbox"]');
  }

  /**
   * 焦点不在任何控件上时（刚打开仓库、用 ⌘/Ctrl+数字切了视图、点过空白处），↑/↓ 直接进入主列表：
   * 不必先按几次 Tab 才能用键盘浏览。列表拿到焦点后把同一次按键转交给它，第一下就能移动选择。
   * 已经有焦点的控件、文本框和任何弹层都不受影响。
   */
  function enterPrimaryList(event: KeyboardEvent): boolean {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return false;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== document.documentElement) return false;
    if (layerAtKey) return false;
    const list = primaryList();
    if (!list) return false;
    event.preventDefault();
    list.focus({ preventScroll: true });
    // 最近仓库的行本身就是目标：聚焦第一行即可；列表容器则需要这次按键来移动选择。
    if (opened) list.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true, cancelable: true }));
    return true;
  }

  /** 键盘层：把按键翻成命令 id，再走与四个入口相同的 runCommand。 */
  function onWindowKeydown(event: KeyboardEvent) {
    if (paletteOpen) return;
    // 任务级 modal 层占着单槽（任务弹窗或只读阅读窗口）时按键全部让位：
    // 阅读窗口同样由 Modal 占层并让背景 inert，外壳键盘不能落到 inert 底下（R3/R6）。
    if (taskLayerOpen || cloneOpen || dependencyOpen || confirmPath !== null) return;
    if (enterPrimaryList(event)) return;
    if (event.key === "Escape") {
      // 上面还有弹层时 Esc 只关那一层；输入框里的 Esc 归输入框。
      if (multiActive && workspaceView === "changes" && selected && !layerAtKey && !event.defaultPrevented && !isTextEntry(event.target)) {
        selectFile(selected);
      }
      return;
    }
    const id = shortcutCommand(event);
    if (!id) return;
    // 只看这次按键的目标。文本框里的组合键留给光标；文件切换、改动块和聚焦搜索在弹层打开时也让路。
    const editing = isTextEntry(event.target);
    const yieldsToLayer = id.startsWith("file.") || id.startsWith("files.") || id.startsWith("diff.hunk.") || id.startsWith("review.") || id === "view.find";
    if (yieldsToLayer && (layerAtKey || editing)) return;
    if (editing) return;
    event.preventDefault();
    const command = commandById(id);
    if (!command) return;
    if (!commandAvailable(command, commandState)) {
      const reason = commandReason(command, commandState);
      if (reason) notice(reason);
      return;
    }
    runCommand(id);
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function nextPaint(): Promise<{ elapsed: number; painted: boolean }> {
    const started = performance.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (painted: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ elapsed: performance.now() - started, painted });
      };
      const timer = setTimeout(() => finish(false), 48);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish(true);
      });
    });
  }

  async function waitForDiff(path: string) {
    const started = performance.now();
    while (performance.now() - started < 30000) {
      if (diff && diff.path === path && !diffLoading) return diff;
      if (diffError && !diffLoading) throw new Error(diffError);
      await sleep(16);
    }
    throw new Error("差异未在时限内显示");
  }

  async function refreshTimes(count: number) {
    const samples: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      if ((await refresh()) !== true) throw new Error("仓库状态刷新失败");
      await nextPaint();
      samples.push(performance.now() - started);
    }
    return samples;
  }

  async function diffCycle(paths: string[], count: number) {
    const cached: number[] = [];
    const uncached: number[] = [];
    const truncated: boolean[] = [];
    const samplesMs: number[] = [];
    const seen = new Set<string>();
    if (paths.length === 0 || count <= 0) return { cached, uncached, truncated, samplesMs };
    for (let index = 0; index < count; index += 1) {
      const path = paths[index % paths.length];
      const started = performance.now();
      selectFile({ path, side: "unstaged" });
      const result = await waitForDiff(path);
      const elapsed = performance.now() - started;
      samplesMs.push(elapsed);
      truncated.push(result.truncated || result.summary.includes("预览上限"));
      if (seen.has(path)) cached.push(elapsed);
      else {
        seen.add(path);
        uncached.push(elapsed);
      }
    }
    return { cached, uncached, truncated, samplesMs };
  }

  async function scrollFrames(frames: number) {
    const list = document.querySelector<HTMLElement>(".file-list");
    if (!list) return { samples: [], painted: false };
    const samples: number[] = [];
    let painted = true;
    list.scrollTop = 0;
    for (let index = 0; index < frames; index += 1) {
      list.scrollTop += 48;
      const frame = await nextPaint();
      painted &&= frame.painted;
      if (index > 0) samples.push(frame.elapsed);
    }
    return { samples, painted };
  }

  function selectionKey() {
    return selected ? `${selected.side}:${selected.path}` : "";
  }

  function paletteInput(): HTMLElement | null {
    const input = document.getElementById("palette-input");
    return input instanceof HTMLElement ? input : null;
  }

  async function feedbackSamples(count: number, plan?: { cloneUrl?: string; cloneParent?: string }) {
    const samples: number[] = [];
    const operations: string[] = [];
    let painted = true;
    let started = true;
    const cloneUrl = plan?.cloneUrl ?? "";
    const cloneParent = plan?.cloneParent ?? "";
    for (let index = 0; index < count; index += 1) {
      const kind = (["clone", "sync", "commit"] as const)[index % 3];
      const expected = kind === "clone" ? "正在克隆" : kind === "sync" ? "正在检查远程" : "正在创建本地提交";
      const startedAt = performance.now();
      const task =
        kind === "clone"
          ? cloneUrl && cloneParent
            ? cloneRepo(cloneUrl, cloneParent, `feedback-${index}`)
            : Promise.reject(new Error("没有克隆目标"))
          : kind === "sync"
            ? runSync("fetch", (path, generation) => api.fetchRemote(path, generation, nextId()))
            : commitMeasured(`测量反馈 ${index}`);
      const guarded = Promise.resolve(task).then(
        () => undefined,
        () => undefined,
      );
      const saw = live === expected;
      const frame = await nextPaint();
      painted &&= frame.painted && saw;
      if (!saw) started = false;
      samples.push(performance.now() - startedAt);
      operations.push(kind);
      await guarded;
    }
    return { samples, painted, operations, started };
  }

  async function keyboardAndTheme() {
    const themes: string[] = [];
    await changeTheme("light");
    themes.push(document.documentElement.dataset.theme ?? "");
    await changeTheme("dark");
    themes.push(document.documentElement.dataset.theme ?? "");
    // ⌘K 现在打开命令面板：焦点落在面板搜索框，Esc 之后回到主界面。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
    const shortcutFocused = Boolean(paletteInput()) && document.activeElement === paletteInput();
    paletteOpen = false;
    const list = document.querySelector<HTMLElement>(".file-list");
    const before = selectionKey();
    list?.focus();
    list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const moved = selectionKey();
    list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const after = selectionKey();
    const selectionChanged = moved.length > 0 && after.length > 0 && moved !== before && after !== moved;
    return {
      theme: themes,
      shortcutFocused,
      selectionChanged,
      selectionBefore: before,
      selectionMoved: moved,
      selectionAfter: after,
      keyboard: shortcutFocused && selectionChanged,
    };
  }

  async function waitUntilRepositoryRead(opening: Promise<unknown>) {
    const started = performance.now();
    while (performance.now() - started < 15000) {
      if (readPhase === "reading") return true;
      if (readPhase === "settled") return false;
      await sleep(5);
    }
    await opening.catch(() => undefined);
    return false;
  }

  async function cancelDuringOpen(slowRepo: string, nextRepo: string) {
    const normalizePath = (value: string) => value.replace(/\/+$/, "").replace(/^\/private/, "");
    const opening = openRecent(slowRepo);
    const sawRead = await waitUntilRepositoryRead(opening);
    let keyboard = false;
    if (sawRead && readPhase === "reading") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
      keyboard = Boolean(paletteInput()) && document.activeElement === paletteInput() && readPhase === "reading";
      paletteOpen = false;
      const cancelButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("取消读取"));
      if (cancelButton instanceof HTMLButtonElement && !cancelButton.disabled && readPhase === "reading") cancelButton.click();
      else await cancelReading();
    }
    await opening;
    const cancelled =
      sawRead &&
      live.includes("已取消读取") &&
      normalizePath(opened?.summary.path ?? "") !== normalizePath(slowRepo);
    const openingSlow = openRecent(slowRepo);
    const sawReadAgain = await waitUntilRepositoryRead(openingSlow);
    let switchedDuringRead = false;
    if (sawReadAgain && readPhase === "reading") {
      switchedDuringRead = true;
      await openRecent(nextRepo);
    }
    await openingSlow;
    const switched =
      switchedDuringRead && Boolean(opened && normalizePath(opened.summary.path) === normalizePath(nextRepo));
    return {
      cancelled,
      switched,
      keyboard,
      readStarted: sawRead && sawReadAgain,
    };
  }

  async function cloneRepo(url: string, parent: string, name: string) {
    pending = "clone";
    live = "正在克隆";
    try {
      const result = await api.cloneRepository(url, parent, name, nextId());
      banner = null;
      rememberOpened(result.opened);
      live = `已克隆 ${result.path}`;
      return result.path;
    } finally {
      pending = null;
    }
  }

  async function stageFirstMeasured() {
    const current = opened;
    if (!current) throw new Error("没有打开的仓库");
    const file = current.snapshot.files.find((item) => item.unstaged !== "none" || item.untracked);
    if (!file) throw new Error("没有可暂存的改动");
    selectFile({ path: file.path, side: "unstaged" });
    const currentDiff = await waitForDiff(file.path);
    const hunk = currentDiff.hunks.find((item) => item.stageable);
    if (!hunk) throw new Error("没有可暂存的完整代码块");
    await stageHunk(hunk);
    return { path: file.path, hunks: currentDiff.hunks.length };
  }

  async function commitMeasured(message: string) {
    const current = opened;
    if (!current) throw new Error("没有打开的仓库");
    onDraftInput(message);
    live = "正在创建本地提交";
    const result = await api.commitChanges(current.summary.path, message, current.generation, nextId());
    if (opened?.summary.path !== current.summary.path) return;
    draft = "";
    applySnapshot(result.snapshot);
    live = `已提交 ${shortOid(result.oid)}`;
  }

  async function pushMeasured() {
    const current = opened;
    if (!current) throw new Error("没有打开的仓库");
    live = "正在推送";
    const snapshot = await api.pushBranch(current.summary.path, current.generation, nextId());
    if (opened?.summary.path !== current.summary.path) return;
    applySnapshot(snapshot);
    live = "推送已完成，没有强行推送。";
  }

  async function mergeMeasured(source: string, content: string) {
    const current = opened;
    if (!current) throw new Error("没有打开的仓库");
    live = "正在合并";
    const session = await api.startMerge(current.summary.path, source, null, "merge", current.generation, nextId());
    applySnapshot(session.snapshot);
    openTask("merge");
    const conflict = session.conflicts[0];
    if (!conflict) throw new Error("没有出现冲突");
    await api.conflictView(current.summary.path, conflict.path, session.generation, nextId());
    const resolved = await api.resolveConflict(
      current.summary.path,
      conflict.path,
      "text",
      content,
      session.generation,
      nextId(),
    );
    const done = await api.completeMerge(current.summary.path, "合并分支", resolved.generation, nextId());
    applySnapshot(done.snapshot);
    live = `已完成合并 ${shortOid(done.oid)}`;
    return done.oid;
  }

  onMount(() => {
    let disposed = false;
    const stopDrag: (() => void)[] = [];
    const registerDrag = async <T,>(name: string, handler: (payload: T) => void) => {
      const stop = await listenEvent<T>(name, (payload) => {
        if (!disposed) handler(payload);
      });
      if (disposed) stop();
      else stopDrag.push(stop);
    };
    void Promise.all([
      registerDrag("tauri://drag-enter", () => { draggingRepository = true; }),
      registerDrag("tauri://drag-leave", () => { draggingRepository = false; }),
      registerDrag<{ paths: string[] }>("tauri://drag-drop", (event) => {
        void dropRepository(event.paths);
      }),
    ]).catch((error) => { if (!disposed) showError(error); });
    let stopFocus = () => {};
    let stopBlur = () => {};
    let stopRepo = () => {};
    let stopCommit = () => {};
    let stopSearch = () => {};
    let stopMedia = () => {};
    let stopUpdate = () => {};
    let stopClioraLink = () => {};
    let stopTerminalClose = () => {};
    const keyListener = (event: KeyboardEvent) => onWindowKeydown(event);
    const layerListener = () => {
      layerAtKey = anyLayerOpen();
    };
    window.addEventListener("keydown", layerListener, true);
    window.addEventListener("keydown", keyListener);
    // ⌘/Ctrl A 收窄到焦点所在的阅读区域，不再把整个窗口的界面文字一起选中。
    window.addEventListener("keydown", scopedSelectAll);
    // 窗口宽度决定左栏的渲染上限（fitPaneWidth）。
    const onResize = () => {
      windowWidth = currentWindowWidth();
    };
    window.addEventListener("resize", onResize);
    if (typeof window.matchMedia === "function") {
      const media = window.matchMedia(DARK_QUERY);
      const onChange = (event: MediaQueryListEvent) => {
        systemDark = event.matches;
      };
      media.addEventListener("change", onChange);
      stopMedia = () => media.removeEventListener("change", onChange);
    }
    void (async () => {
      stopFocus = await listenEvent("window-focused", () => {
        windowFocused = true;
        void refresh();
      });
      stopBlur = await listenEvent("window-blurred", () => {
        windowFocused = false;
      });
      stopSearch = await listenEvent("menu-search", () => {
        if (textFocused()) return;
        openPalette();
      });
      stopCommit = await listenEvent("menu-commit", () => {
        if (textFocused()) return;
        void commitLocal();
      });
      stopRepo = await listenEvent<RepoChanged>("repo-changed", (event) => {
        if (!opened || event.path !== opened.summary.path) return;
        opened = { ...opened, generation: event.generation };
        degraded = degraded || event.degraded;
        void refresh();
      });
      // 启动自动检查发现新版本时后端 emit twiglane:update-available；非原生环境内部不注册。
      // 一次性提醒只挂在事件路径（手动检查写 offer 不经过这里），同版本重复到达也不会再打扰（T3）。
      stopUpdate = await watchUpdateAvailable((offer) => {
        notice(`发现新版本 ${offer.version}，可从状态栏入口或设置安装。`);
      });
      // v2 审查链接：冷启动先于运行中派发，App 侧用到达序号丢弃迟到的旧链接。
      stopClioraLink = await watchClioraReviewLinks((url) => {
        void handleClioraLink(url);
      });
      // 后端只以真实活动进程判断是否需要确认；没有活动会话时不会发这个事件。
      stopTerminalClose = await listenEvent<TerminalCloseRequested>(TERMINAL_CLOSE_REQUESTED_EVENT, (payload) => {
        if (!payload || payload.sessions.length === 0) return;
        // 已有确认层时只更新会话列表：重复的原生关窗请求不能重置进行中的 busy，
        // 也不能清掉上一次终止失败的真实错误。
        terminalClose = terminalClose
          ? { ...terminalClose, sessions: payload.sessions }
          : { sessions: payload.sessions, busy: false, error: null };
      });
    })();
    const poll = window.setInterval(() => {
      if (shouldPoll(degraded, windowFocused, opened !== null)) void refresh();
    }, FALLBACK_POLL_MS);
    void loadSettings().then(() =>
      startDesktopMeasure({
        openRepo: openRecent,
        cloneRepo,
        stageFirstHunk: stageFirstMeasured,
        commit: commitMeasured,
        push: pushMeasured,
        merge: mergeMeasured,
        refreshTimes,
        diffCycle,
        scrollFrames,
        feedbackSamples,
        keyboardAndTheme,
        cancelDuringOpen,
        sleep,
        getOpened: () =>
          opened
            ? {
                path: opened.summary.path,
                head: opened.snapshot.branch.headOid,
                changes: opened.snapshot.files.length,
                generation: opened.generation,
              }
            : null,
      }),
    );
    return () => {
      disposed = true;
      stopDrag.forEach((stop) => stop());
      window.removeEventListener("keydown", layerListener, true);
      window.removeEventListener("keydown", keyListener);
      window.removeEventListener("keydown", scopedSelectAll);
      window.removeEventListener("resize", onResize);
      window.clearInterval(poll);
      if (draftTimer) clearTimeout(draftTimer);
      stopFocus();
      stopBlur();
      stopRepo();
      stopCommit();
      stopSearch();
      stopMedia();
      stopUpdate();
      stopClioraLink();
      stopTerminalClose();
    };
  });
</script>

<div class="sr-only" aria-live="polite">{live}</div>
<div class="shell">
  {#if draggingRepository}
    <div class="repository-drop-hint" role="status">
      <Icon name="folder-open" size={32} />
      <strong>松开以打开仓库文件夹</strong>
      <span>一次拖入一个文件夹</span>
    </div>
  {/if}
  <TitleBar
    repo={opened?.summary ?? null}
    branch={opened ? branchText : null}
    {upstreamMissing}
    {ahead}
    {behind}
    remoteState={remoteState}
    remoteCheckedAtMs={opened?.snapshot.branch.remoteCheckedAtMs ?? null}
    pending={syncPending}
    remoteBusy={pending !== null && REMOTE_PENDING.has(pending)}
    {theme}
    disabled={writeLocked}
    onBrand={() => runCommand("palette.open")}
    openSwitcher={switcher?.kind ?? null}
    onRepo={(anchor) => toggleSwitcher("repo", anchor)}
    onBranch={(anchor) => toggleSwitcher("branch", anchor)}
    onFetch={() => runCommand("sync.fetch")}
    onPull={() => runCommand("sync.pull")}
    onPush={() => runCommand("sync.push")}
    remotes={remoteNames}
    upstream={opened?.snapshot.branch.upstream ?? null}
    cancelling={syncCancelling}
    onSyncOpen={() => void loadRemoteNames()}
    onPushTo={pushTo}
    onPushAll={pushToAll}
    onCancelSync={cancelSync}
    onRemote={() => runCommand("task.remote")}
    onTheme={(next) => runCommand(`theme.${next}`)}
    onSettings={() => runCommand("task.settings")}
    repoNames={badgeNames}
    cliora={clioraReview.source
      ? {
          reviewId: clioraReview.source.reviewId,
          outcome: clioraReturnOutcome().outcome,
          headOid: clioraReview.result?.headOid ?? null,
        }
      : null}
    onClioraReturn={returnToCliora}
  />

  {#if switcher?.kind === "repo"}
    <RepoSwitcher
      anchor={switcher.anchor}
      repos={recent}
      currentPath={opened?.summary.path ?? null}
      blockedReason={switchBlocked(commandState) ? switchBlockedReason(commandState) : null}
      actionReason={writeLocked ? switchBlockedReason(commandState) : null}
      reviews={reviewSessionSummary()}
      onSelect={(path) => {
        closeSwitcher();
        void openRecent(path);
      }}
      onForget={forget}
      onCopyPath={copyPath}
      onRemoveWorktree={askRemoveWorktree}
      onContextMenu={repoContextMenu}
      onCommand={runFromSwitcher}
      onClose={closeSwitcher}
    />
  {:else if switcher?.kind === "branch" && opened}
    <BranchSwitcher
      anchor={switcher.anchor}
      {opened}
      blockedReason={writeLocked ? switchBlockedReason(commandState) : null}
      {branchGroups}
      {nextId}
      onBusy={(name) => (pending = name)}
      onGeneration={adoptGeneration}
      onSnapshot={applySnapshot}
      onFailure={handleMutationError}
      onNotice={notice}
      onCommand={runFromSwitcher}
      onCreateBranch={runBranchCreate}
      onMergeBranch={(name) => {
        closeSwitcher();
        mergeBranchIntoCurrent(name);
      }}
      onMergeInto={(name) => {
        closeSwitcher();
        mergeCurrentInto(name);
      }}
      onRebaseBranch={(name) => {
        closeSwitcher();
        rebaseCurrentOnto(name);
      }}
      onOpened={rememberOpened}
      beforeOpen={switcherWorktreeGate}
      onClose={closeSwitcher}
    />
  {/if}

  {#if reading}
    <div class="progress-line" aria-hidden="true"></div>
    <div class="infobar info" role="status">
      <span class="spinner"></span>
      <span class="infobar-text">正在读取仓库…</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick={cancelReading}>取消读取</button>
    </div>
  {/if}
  {#if gitDiagnostic && !gitDismissed && opened}
    <!-- R10：一句结论 + 一个可关闭入口；安装说明留在设置/运行依赖里，不堆在首屏（R12）。
         起始页有自己的诊断入口，这里不再重复同一句话。 -->
    <div class="infobar error" role="status">
      <Icon name="alert-circle" size={16} />
      <span class="infobar-text">{gitDiagnostic}</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick={openGitDiagnostics}>运行环境诊断</button>
      <button
        type="button"
        class="icon-btn sm"
        aria-label="关闭 Git 诊断入口"
        title="关闭这条通知；设置里的运行环境仍可随时查看"
        onclick={() => (gitDismissed = true)}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  {:else if git?.available && git.belowBaseline}
    <div class="infobar warn" role="status">
      <Icon name="alert" size={15} />
      <span class="infobar-text">{git.message}</span>
    </div>
  {/if}

  <div class="workspace" data-sidebar={sidebarHidden ? "hidden" : "visible"} style={`--files:${paneWidth}px`}>
    <!-- 命令面板从 body 打开时，弹窗关闭后的焦点落到这里：主内容区本身可编程聚焦（不进 Tab 序），
         比回到 body 更接近用户离开的地方。 -->
    <main class="content" data-app-main tabindex="-1">
      {#snippet paneHead()}
        <div class="pane-head">
          <ViewSwitcher view={workspaceView} {changeCount} showFiles={filesViewEnabled} taskActive={taskRequest !== null && workspaceView !== "history"} onView={(view) => runCommand(`view.${view}`)} />
          <span class="spacer"></span>
          <button
            type="button"
            class="icon-btn sm"
            aria-label="临时保存"
            title="临时保存：收起未完成的工作"
            onclick={() => runCommand("task.stash")}
          >
            <Icon name="archive" size={15} />
          </button>
        </div>
        <MergeBanner {conflictCount} {mergeInProgress} canAbort={mergeAbortable} abortBlocked={writeLocked} onOpen={() => runCommand("task.merge")} onAbort={() => runCommand("task.abortMerge")} />
      {/snippet}
      {#snippet taskDetailView(visible: boolean)}
  {#if opened}
    <TaskReview
      {opened}
      active={workspaceView === "history"}
      {visible}
      request={taskRequest}
      {nextId}
      fullFile={diffFullFile}
      onFullFile={setFullFile}
      onGeneration={adoptGeneration}
      onNotice={notice}
      onFailure={announceTaskFailure}
      onFileHistory={openFileHistory}
      onReadDocument={openDocument}
      onFileNav={(nav) => (taskNav = nav)}
      onHunkNav={reportTaskHunk}
      reviewed={taskReviewedSet}
      {reviewBusy}
      reviewNote={taskReviewNote}
      hideReviewed={taskHideReviewed}
      onToggleReview={(path) => void toggleReviewed(path)}
      onHideReviewed={(next) => (taskHideReviewed = next)}
      onStageFile={stageTaskFile}
      onUnstageFile={unstageTaskFile}
      stageSideFor={taskFileStage}
      writeLocked={writeLocked}
      onOpenUnstaged={openUnstagedDiff}
      onOpenChanges={showChanges}
      onSnapshot={adoptTaskScope}
      onSelection={(path) => (taskSelectedPath = path)}
      onReviewNav={(nav) => (taskReviewNav = nav)}
      onSummary={(summary) => (taskSummary = summary)}
      onEditFile={filesViewEnabled ? (path, line) => void editInFiles(path, line, "task") : undefined}
    />
  {/if}
{/snippet}

{#snippet paneResizer()}
        <PaneResizer
          value={paneWidth}
          saved={widths.files}
          label="调整侧栏宽度"
          fit={(width) => fitPaneWidth(width, windowWidth)}
          onResize={(width) => (widths = { ...widths, files: width })}
          onCommit={persistWidths}
        />
      {/snippet}
      {#if opened}
        <div class="workbench-views">
          <div
            class="workbench-view"
            data-view-scope="changes"
            data-active={workspaceView === "changes"}
            aria-hidden={workspaceView !== "changes"}
            inert={workspaceView !== "changes"}
          >
            <div class="changes">
              <section class="pane files" aria-label="改动与提交">
                {@render paneHead()}
                <FileList
                  bind:this={fileList}
                  files={opened.snapshot.files}
                  {selected}
                  {selectedSet}
                  query={fileQuery}
                  disabled={writeLocked}
                  onQuery={(value) => (fileQuery = value)}
                  onSelect={selectFile}
                  onMultiSelect={selectMany}
                  onBatch={(side) => void runBatch(side === "staged" ? "unstage" : "stage", side === "staged" ? batch.unstage : batch.stage)}
                  onStage={stagePath}
                  onUnstage={unstagePath}
                  onStageAll={stagePaths}
                  onUnstageAll={unstagePaths}
                  onResolve={(path) => (path ? openConflict(path) : runCommand("task.merge"))}
                  onContextMenu={fileContextMenu}
                  reviewed={reviewedSet}
                  reviewTotal={reviewCounts.total}
                  reviewReviewed={reviewCounts.reviewed}
                  {hideReviewed}
                  onHideReviewed={(next) => (hideReviewed = next)}
                  onToggleReview={(path) => void toggleReviewed(path)}
                  {reviewBusy}
                  {reviewNote}
                  reviewNav={changesReviewNav}
                />
                <CommitDraft
                  branch={branchText}
                  scope={scope.label}
                  paths={scope.paths}
                  value={draft}
                  disabled={writeLocked}
                  busy={pending}
                  error={commitError}
                  pushError={pushFailure}
                  onRetryPush={retryPush}
                  stageableCount={stageTargets.length}
                  onStageAll={() => runCommand("stage.all")}
                  onInput={onDraftInput}
                  onBlur={() => void flushDraft(drafts.path)}
                  onCommit={commitLocal}
                  onCommitPush={commitAndPush}
                  onScope={() => runCommand("task.scope")}
                >
                  {#snippet overflow(closeMore: () => void)}
                    <div class="menu-label" role="presentation">撤销与恢复</div>
                    {#if opened}
                      <RecoveryActions
                        opened={opened}
                        variant="menu"
                        onSettled={closeMore}
                        disabled={writeLocked}
                        {nextId}
                        onSnapshot={applySnapshot}
                        onFailure={handleMutationError}
                        onNotice={notice}
                        onMerge={() => runCommand("task.merge")}
                      />
                    {/if}
                    <div class="menu-sep"></div>
                    <div class="menu-label" role="presentation">分支与同步</div>
                    {#each overflowCommands as command (command.id)}
                      {@const blocked = commandAvailable(command, commandState) ? null : commandReason(command, commandState)}
                      <button
                        type="button"
                        class="menu-item"
                        role="menuitem"
                        disabled={blocked !== null}
                        title={blocked ?? command.hint}
                        aria-describedby={blocked ? `overflow-reason-${command.id}` : undefined}
                        onclick={() => runCommand(command.id)}
                      >
                        <Icon name={OVERFLOW_COMMAND_ICONS[command.id as keyof typeof OVERFLOW_COMMAND_ICONS] ?? "chevron-right"} />
                        <!-- 禁用原因就地显示，不只放在悬停提示里：键盘与触屏都看不到 title。 -->
                        <span>{command.title}<small id={blocked ? `overflow-reason-${command.id}` : undefined}>{blocked ?? command.hint}</small></span>
                      </button>
                    {/each}
                  {/snippet}
                </CommitDraft>
              </section>
              {@render paneResizer()}
              {#if multiActive}
                <MultiFileDiff
                  active={workspaceView === "changes"}
                  {opened}
                  rows={selectedRows}
                  focus={selected}
                  nav={changesNav}
                  disabled={writeLocked}
                  fullFile={diffFullFile}
                  fullContext={FULL_FILE_CONTEXT}
                  stageCount={batch.stage.length}
                  unstageCount={batch.unstage.length}
                  discardCount={batch.discard.length}
                  conflictCount={batch.conflicts}
                  {nextId}
                  onFocus={focusBlock}
                  onStale={adoptStaleDiff}
                  onStageHunk={stageHunkOf}
                  onFullFile={setFullFile}
                  onFileHistory={openFileHistory}
                  onReadDocument={openDocument}
                  onStage={() => void runBatch("stage", batch.stage)}
                  onUnstage={() => void runBatch("unstage", batch.unstage)}
                  onDiscard={() => void recovery?.discard(batch.discard)}
                  onClear={() => selected && selectFile(selected)}
                />
              {:else}
                <DiffView onGeneration={adoptGeneration}
                  selection={selected}
                  {diff}
                  error={diffError}
                  loading={diffLoading}
                  disabled={writeLocked}
                  onStageHunk={stageHunk}
                  onStageLines={(lines) => {
                    if (selected && diff) void stageLinesOf(selected, diff, lines);
                  }}
                  onLoadMore={loadMoreDiff}
                  onFileHistory={openFileHistory}
                  onReadDocument={openDocument}
                  fullFile={diffFullFile}
                  onFullFile={setFullFile}
                  asText={diffAsText !== null && diffAsText === asTextKey(selected)}
                  onViewAsText={setDiffAsText}
                  fileNav={changesNav}
                  fileCount={opened.snapshot.files.length}
                  onRetry={() => void loadSelectedDiff()}
                  onHunkNav={reportChangesHunk}
                  conflicted={selected ? (opened.snapshot.files.find((file) => file.path === selected?.path)?.unmerged ?? false) : false}
                  onResolve={() => {
                    if (selected) openConflict(selected.path);
                  }}
                  reviewed={selected ? reviewedSet.has(selected.path) : false}
                  reviewBusy={selected ? reviewBusy === selected.path : false}
                  onToggleReview={selected ? () => void toggleReviewed(selected!.path) : undefined}
                  onEdit={changesEditPath
                    ? (line) => {
                        if (changesEditPath) void editInFiles(changesEditPath, line, "changes", "unstaged");
                      }
                    : undefined}
                />
              {/if}
            </div>
          </div>
          {#if filesViewEnabled}
          <div
            class="workbench-view"
            data-view-scope="files"
            data-active={workspaceView === "files"}
            aria-hidden={workspaceView !== "files"}
            inert={workspaceView !== "files"}
          >
            <RepositoryFiles
              bind:this={filesView}
              active={workspaceView === "files"}
              {opened}
              disabled={writeLocked}
              {nextId}
              {paneWidth}
              {windowWidth}
              onResize={(width) => (widths = { ...widths, files: width })}
              onResizeCommit={persistWidths}
              onGeneration={adoptGeneration}
              onFileHistory={openFileHistory}
              onOpenDiff={(path, side) => openFileDiff(path, side)}
              onReveal={(path) => void revealInFolder(path)}
              onOpenDefault={(path) => void openWithDefault(path)}
              onCopyPath={(text, what) => void copyText(text, what)}
              toAbsolute={absolutePath}
              onNav={(nav) => (filesNav = nav)}
              {paneHead}
              {editRequest}
              {editReturn}
              onEditSaved={handleEditSaved}
              onEditFailed={handleEditFailed}
            />
          </div>
          {/if}
          <div
            class="workbench-view"
            data-view-scope="history"
            data-active={workspaceView === "history"}
            aria-hidden={workspaceView !== "history"}
            inert={workspaceView !== "history"}
          >
            {#if historyPanel}
              {#await historyPanel}
                <div class="history-layout">
                  <aside class="pane">{@render paneHead()}</aside>
                  {@render paneResizer()}
                  <div class="view-loading"><span class="spinner"></span></div>
                </div>
              {:then module}
                <module.default
                  active={workspaceView === "history"}
                  {opened}
                  filePath={historyPath}
                  searchQuery={historyQuery}
                  disabled={writeLocked}
                  {nextId}
                  onGeneration={adoptGeneration}
                  onFailure={handleMutationError}
                  onFilePath={openFileHistory}
                  onReadDocument={openDocument}
                  onClearFile={() => (historyPath = null)}
                  onSnapshot={mergeSnapshot}
                  onNotice={notice}
                  onFileNav={(nav) => (historyNav = nav)}
                  onHunkNav={reportHistoryHunk}
                  onActivity={reportHistoryActivity}
                  fullFile={diffFullFile}
                  onFullFile={setFullFile}
                  {branchGroups}
                  {paneHead}
                  {paneResizer}
                  taskRange={taskRequest ? { baseline: taskRequest.baseline, nonce: taskRequest.nonce } : null}
                  taskSummary={taskSummary ? { ...taskSummary, reviewed: taskReviewNav ? taskReviewNav.total - taskReviewNav.remaining : 0 } : null}
                  taskDetail={taskDetailView}
                  onTaskFocus={(focused) => (taskFocus = focused)}
                />
              {/await}
            {/if}
          </div>
        </div>
      {:else}
        <Welcome
          {recent}
          disabled={writeLocked}
          disabledReason={writeLocked ? switchBlockedReason(commandState) : ""}
          diagnostic={gitDiagnostic}
          onDiagnose={gitDiagnostic ? openGitDiagnostics : undefined}
          onAdd={() => runCommand("repo.add")}
          onClone={() => runCommand("repo.clone")}
          onCreate={() => runCommand("repo.create")}
          onOpen={openRecent}
          onContextMenu={repoContextMenu}
        />
      {/if}
    </main>
  </div>

  {#if opened}
    <!-- 终端在三个工作台视图之外：切换视图不重挂；切换仓库时 path 变化，面板附着该仓库的会话。 -->
    <TerminalPanel
      path={opened.summary.path}
      open={terminalOpen}
      theme={resolvedTheme}
      onClose={() => (terminalOpen = false)}
    />
  {/if}

  <StatusBar
    hasRepo={opened !== null}
    sync={syncText}
    busy={writeLocked}
    busyLabel={pendingLabel}
    refreshing={refreshActive}
    {degraded}
    warning={warning}
    onRefresh={() => runCommand("view.refresh")}
    {sidebarHidden}
    onToggleSidebar={() => runCommand("rail.toggle")}
    {conflictCount}
    {mergeInProgress}
    onOpenMerge={() => runCommand("task.merge")}
    updateVersion={updateState.offer?.version ?? null}
    onOpenUpdate={() => openSettings("update")}
    {terminalOpen}
    onToggleTerminal={() => runCommand("terminal.toggle")}
  />
</div>

<CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => (paletteOpen = false)} />

{#if contextMenu}
  <ContextMenu request={contextMenu} onClose={() => (contextMenu = null)} />
{/if}

{#if editLeave}
  <!-- 未保存草稿的关卡：三个选择都明确写出后果；打开时焦点停在对话框本身，回车不会误丢或误存草稿。 -->
  <Modal
    title="有未保存的编辑"
    titleId="edit-leave-title"
    icon="pencil"
    tone="warning"
    size="sm"
    description={`${editLeave.purpose}之前，先处理这些文件里还没保存的修改。`}
    locked={editLeave.busy}
    onClose={() => settleEditLeave(false)}
  >
    <div class="confirm-body" data-modal-impact="edit-leave">
      <ul class="confirm-targets" aria-label="未保存的文件">
        {#each editLeave.paths as path (path)}
          <li title={path}>
            <span class="confirm-target-icon"><Icon name="file" size={14} /></span>
            <span class="confirm-target-main"><span class="confirm-target-name">{path}</span></span>
          </li>
        {/each}
      </ul>
      <ul class="confirm-notes">
        <li class="info"><Icon name="info" size={14} /><span>保存只写入工作区文件，不暂存、不提交；文件在编辑期间被外部修改时不会覆盖。</span></li>
        <li class="warn"><Icon name="alert" size={14} /><span>放弃会丢掉这些内存草稿，工作区文件保持原样。</span></li>
      </ul>
      {#if editLeave.error}
        <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{editLeave.error}</span></div>
      {/if}
    </div>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" title={editLeave?.busy ? "正在保存，完成后才能取消" : "保留草稿，不继续这次操作"} disabled={editLeave?.busy} onclick={() => settleEditLeave(false)}>取消</button>
      <button type="button" class="btn btn-secondary btn-danger-soft" title={editLeave?.busy ? "正在保存" : "丢掉这些内存草稿后继续，工作区文件保持原样"} disabled={editLeave?.busy} onclick={discardEditLeave}>放弃修改</button>
      <button type="button" class="btn btn-primary" title={editLeave?.busy ? "正在保存" : "逐个保存到工作区后继续；任何一个失败都会停下说明"} aria-busy={editLeave?.busy} disabled={editLeave?.busy} onclick={() => void saveEditLeave()}>
        {#if editLeave?.busy}<span class="spinner"></span>{/if}保存
      </button>
    {/snippet}
  </Modal>
{/if}

{#if terminalClose}
  <!-- 原生关窗被活动终端拦下：取消不改进程；确认先等待终止成功再关闭，失败留在这一层。 -->
  <ConfirmDialog
    title="结束终端并关闭应用"
    titleId="terminal-close-title"
    icon="code"
    tone="danger"
    message="还有正在运行的终端命令。关闭窗口前会先结束这些终端及其子进程。"
    targets={terminalClose.sessions.map((session) => ({
      icon: "code" as const,
      name: terminalRepoName(session.repoPath),
      detail: session.repoPath,
      tag: "运行中",
      tagTone: "info" as const,
    }))}
    targetsLabel="运行中的终端会话"
    notes={[
      { tone: "warn" as const, text: "确认后会结束这些 shell 及其子进程，终端里未完成的进度会丢失。" },
      { tone: "info" as const, text: "取消会保持应用与这些命令继续运行。" },
    ]}
    confirmLabel="结束终端并关闭"
    confirmIcon="x"
    busy={terminalClose.busy}
    error={terminalClose.error}
    impact="terminal-close"
    onConfirm={() => void confirmTerminalClose()}
    onCancel={() => (terminalClose = null)}
  />
{/if}

{#if worktreeRemoval}
  {@const removal = worktreeRemoval}
  <ConfirmDialog
    title={removal.force ? "强制删除工作区" : "删除工作区"}
    titleId="worktree-remove-title"
    message={removal.force
      ? "这个工作区里有未提交的改动或未跟踪文件。强制删除会把它们一起删掉。"
      : "删除这个 worktree 的目录，并从最近列表移除？"}
    targets={[{
      icon: "folder",
      name: removal.repo.name,
      detail: removal.repo.path,
      tag: removal.head.branch ?? removal.head.detached ?? undefined,
      tagTone: "info",
    }]}
    targetsLabel="要删除的工作区"
    notes={[
      ...(removal.force ? [{ tone: "warn" as const, text: "未提交的改动和未跟踪文件会被永久删除，本应用不能恢复。" }] : []),
      { tone: "ok" as const, text: `分支${removal.head.branch ? ` ${removal.head.branch}` : ""}和已有提交都保留在主仓库里，可以随时重新检出。` },
      ...(removal.head.mainPath ? [{ tone: "info" as const, text: `由主仓库执行 git worktree remove：${removal.head.mainPath}` }] : []),
    ]}
    confirmLabel={removal.force ? "强制删除" : "删除工作区"}
    confirmIcon="trash"
    busy={removal.busy}
    error={removal.error}
    focusKey={removal.force}
    impact="worktree-remove"
    onConfirm={() => void confirmRemoveWorktree()}
    onCancel={() => (worktreeRemoval = null)}
  />
{/if}

{#if opened}
  <!-- 右键「放弃更改…」的确认层：与溢出菜单同一套影响清单与确认流程，只是入口不同。 -->
  <RecoveryActions
    bind:this={recovery}
    variant="headless"
    {opened}
    disabled={writeLocked}
    {nextId}
    onSnapshot={applySnapshot}
    onFailure={handleMutationError}
    onNotice={notice}
    onMerge={() => runCommand("task.merge")}
  />
{/if}

{#if opened && documentRequest}
  <DocumentDialog
    repository={opened.summary.path}
    old={documentRequest.sources.old}
    new={documentRequest.sources.new}
    side={documentRequest.side}
    generation={opened.generation}
    {nextId}
    onGeneration={adoptGeneration}
    session={documentSession}
    returnFocus={documentRequest.trigger}
    abbrevLength={opened.abbrevLength ?? 0}
    onClose={closeDocument}
  />
{:else if opened && taskModal === "stash"}
  <StashModal
    {opened}
    returnFocus={taskReturnFocus}
    disabled={writeLocked}
    {nextId}
    onClose={closeTask}
    onGeneration={adoptGeneration}
    onSnapshot={mergeSnapshot}
    onFailure={handleMutationError}
    onNotice={notice}
    onOpenChanges={openConflict}
    onFileContextMenu={stashFileMenu}
  />
{:else if opened && taskModal === "merge"}
  <MergeModal
    {opened}
    returnFocus={taskReturnFocus}
    focusPath={conflictFocus}
    initialSource={mergeSource}
    initialTarget={mergeTarget}
    initialMode={mergeMode}
    initialAbort={mergeAbortIntent}
    {branchGroups}
    disabled={writeLocked}
    {nextId}
    onClose={() => closeTask(true)}
    closeLabel={taskReturn === "branch" ? "返回分支与标签" : undefined}
    onSnapshot={mergeSnapshot}
    onGeneration={adoptGeneration}
    onFailure={handleMutationError}
    onNotice={notice}
    onOpenStash={() => runCommand("task.stash")}
    onOpenChanges={() => {
      closeTask();
      showChanges();
    }}
    onOpenHistory={() => {
      closeTask();
      showHistory();
    }}
  />
{:else if opened && taskModal === "branch"}
  <BranchDialog
    {opened}
    returnFocus={taskReturnFocus}
    disabled={writeLocked}
    onClose={closeTask}
    onBusy={(name) => (pending = name)}
    onSnapshot={applySnapshot}
    onFailure={handleMutationError}
    onNotice={notice}
    onOpenHistory={(next) => {
      closeTask();
      openCommitSearch(next);
    }}
    onMergeBranch={(name) => mergeFromBranches(() => mergeBranchIntoCurrent(name))}
    onMergeInto={(name) => mergeFromBranches(() => mergeCurrentInto(name))}
    onRebaseBranch={(name) => mergeFromBranches(() => rebaseCurrentOnto(name))}
    startCreating={branchCreateIntent}
    startBase={branchCreateBase}
    backgroundClone={pending === "clone"}
    {branchGroups}
    blockedReason={writeLocked ? switchBlockedReason(commandState) : null}
    onOpened={rememberOpened}
    beforeOpen={worktreeLeaveGate}
    onRecent={(list) => (recent = list)}
    {nextId}
  />
{:else if taskModal === "settings"}
  <SettingsModal
    {theme}
    {git}
    returnFocus={taskReturnFocus}
    disabled={writeLocked}
    section={settingsSection}
    onClose={closeTask}
    onTheme={(next) => runCommand(`theme.${next}`)}
    {pullIntegration}
    {branchGroups}
    filesView={filesViewEnabled}
    onPullIntegration={(next) => void changePullIntegration(next)}
    onBranchGroups={(next) => void changeBranchGroups(next)}
    onFilesView={(next) => void changeFilesView(next)}
    onRedetect={redetectGit}
    onChooseGit={chooseGit}
    onClearGit={clearGit}
  />
{:else if opened && taskModal === "scope"}
  <ScopeModal
    scopeLabel={scope.label}
    paths={scope.paths}
    returnFocus={taskReturnFocus}
    onClose={closeTask}
  />
{:else if opened && taskModal === "publish"}
  <PublishModal
    branch={branchText}
    returnFocus={taskReturnFocus}
    upstream={opened.snapshot.branch.upstream}
    remote={remoteName ?? "origin"}
    {ahead}
    disabled={writeLocked}
    busy={pending}
    onClose={closeTask}
    onPublish={() => {
      closeTask();
      runSync("publish", (path, generation) => api.publishBranch(path, "", generation, nextId()));
    }}
    onAssociate={() => {
      closeTask();
      runSync("associate", (path, generation) => api.associateUpstream(path, "", generation, nextId()));
    }}
  />
{/if}

<RepoDialogs
  mode={cloneOpen ? "clone" : taskModal === "remote" ? "remote" : null}
  {opened}
  disabled={writeLocked}
  onClose={closeRepoDialogs}
  onBusy={(name) => (pending = name)}
  onSnapshot={applySnapshot}
  onOpened={cloneFinished}
  onFailure={handleMutationError}
  onNotice={notice}
  onOpenHistory={openCommitSearch}
  {branchGroups}
  onOpenWorktree={rememberOpened}
  beforeOpenWorktree={worktreeLeaveGate}
  {nextId}
  onPushTo={pushTo}
  onRemotes={(path, names) => {
    if (opened?.summary.path !== path) return;
    remoteNames = names;
    remoteNamesFor = path;
  }}
/>

{#if dependencyOpen}
  <DetailDialog
    title="运行依赖"
    icon="package"
    prose
    value={dependencyNote(navigator.platform ?? "")}
    body="这些说明只描述安装和缺失时的行为，不表示已经在所有系统上完成验收。"
    onClose={() => (dependencyOpen = false)}
  />
{/if}
{#if confirmPath}
  <DetailDialog
    title="新建仓库"
    icon="folder-plus"
    value={confirmPath}
    body="可以直接编辑仓库目录。已有文件不会被覆盖或删除，取消则不会做任何修改。"
    confirmLabel="初始化仓库"
    confirmDisabled={confirmPath.trim().length === 0}
    editable
    onInput={(value) => (confirmPath = value)}
    onClose={() => (confirmPath = null)}
    onConfirm={confirmCreate}
  />
{/if}

<div class="toasts">
  {#if banner}
    <div class="toast error" role="alert">
      <span class="toast-icon"><Icon name="alert-circle" size={16} /></span>
      <span class="toast-text">{banner}</span>
      <button type="button" class="icon-btn sm" aria-label="关闭提示" onclick={() => (banner = null)}><Icon name="x" size={14} /></button>
    </div>
  {/if}
  {#if phaseNote}
    <div class="toast ok" role="status">
      <span class="toast-icon"><Icon name="check-circle" size={16} /></span>
      <span class="toast-text">{phaseNote}</span>
      <button type="button" class="icon-btn sm" aria-label="关闭提示" onclick={() => (phaseNote = null)}><Icon name="x" size={14} /></button>
    </div>
  {/if}
  {#if warning}
    <div class="toast warn" role="status">
      <span class="toast-icon"><Icon name="alert" size={16} /></span>
      <span class="toast-text">{warning}</span>
      <button type="button" class="icon-btn sm" aria-label="关闭提示" onclick={() => (warning = null)}><Icon name="x" size={14} /></button>
    </div>
  {/if}
</div>
