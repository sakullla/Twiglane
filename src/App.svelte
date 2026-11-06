<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api, listenEvent, pickDirectory, pickFile } from "./lib/api";
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
  import { finishDiffAttempt, reuseDiffContent, type HunkNavReport } from "./lib/diff";
  import { DraftBuffer } from "./lib/draft";
  import { normalizeError } from "./lib/errors";
  import { clampWidth, FALLBACK_POLL_MS, fitPaneWidth, shouldPoll } from "./lib/layout";
  import { branchLabel, commitScope, createSelectionResolver, dependencyNote, filterRows, groupFiles, retainSelection, selectionAfterEdit, syncLabel } from "./lib/labels";
  import { startDesktopMeasure } from "./lib/measure";
  import { updateState, watchUpdateAvailable } from "./lib/update.svelte";
  import { isTextEntry, shortcutCommand } from "./lib/shortcuts";
  import type {
    AppFailure,
    DiffHunk,
    DiffResponse,
    FileRow,
    FileSelection,
    GitInfo,
    OpenedRepository,
    PanelWidths,
    RecentRepo,
    RepoChanged,
    StatusSnapshot,
    PullIntegration,
    TaskModal,
    Theme,
    WorkspaceView,
  } from "./lib/types";
  import {
    batchSummary,
    batchTargets,
    fileNavState,
    hasCommitSummary,
    orderedRows,
    rowsInSelection,
    sameSelection,
    type FileNavState,
  } from "./lib/ui";
  import BranchDialog from "./lib/components/BranchDialog.svelte";
  import type { MergeMode } from "./lib/components/MergeSetup.svelte";
  import BranchSwitcher from "./lib/components/BranchSwitcher.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./lib/components/ContextMenu.svelte";
  import { openModalCount } from "./lib/components/Modal.svelte";
  import CommitDraft from "./lib/components/CommitDraft.svelte";
  import DetailDialog from "./lib/components/DetailDialog.svelte";
  import DiffView from "./lib/components/DiffView.svelte";
  import FileList from "./lib/components/FileList.svelte";
  import Icon from "./lib/components/Icon.svelte";
  import MergeBanner from "./lib/components/MergeBanner.svelte";
  import MergeModal from "./lib/components/MergeModal.svelte";
  import MultiFileDiff from "./lib/components/MultiFileDiff.svelte";
  import PaneResizer from "./lib/components/PaneResizer.svelte";
  import PublishModal from "./lib/components/PublishModal.svelte";
  import RecoveryActions from "./lib/components/RecoveryActions.svelte";
  import RepoDialogs from "./lib/components/RepoDialogs.svelte";
  import RepoSwitcher from "./lib/components/RepoSwitcher.svelte";
  import ScopeModal from "./lib/components/ScopeModal.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import StashModal from "./lib/components/StashModal.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import TitleBar from "./lib/components/TitleBar.svelte";
  import ViewSwitcher from "./lib/components/ViewSwitcher.svelte";
  import Welcome from "./lib/components/Welcome.svelte";

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
  /** 批量写入里单个文件遇到 stale 的重试上限，与后端 settle_read 一致。 */
  const BATCH_STALE_RETRIES = 6;
  /** 这次按键发生时是否有弹层打开：在捕获阶段记下，弹层自己处理 Esc 关闭后这里不会误判。 */
  let layerAtKey = false;
  /** 批量写入进行中：期间的刷新要跟着文件换分组，不能把正在移动的条目当成消失。 */
  let batchRunning = false;
  /** 历史视图的上一个/下一个状态，由 HistoryPanel 上报。 */
  let historyNav = $state.raw<FileNavState | null>(null);
  let diff = $state.raw<DiffResponse | null>(null);
  let diffError = $state<string | null>(null);
  let diffLoading = $state(false);
  let pending = $state<string | null>(null);
  let reading = $state(false);
  let readSerial = 0;
  let readPhase: "idle" | "reading" | "settled" = "idle";
  let dependencyOpen = $state(false);
  let historyPanel = $state<Promise<typeof import("./lib/components/HistoryPanel.svelte")> | null>(null);
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
  let phaseNote = $state<string | null>(null);
  let degraded = $state(false);
  let windowFocused = $state(true);
  let requestSerial = 1;
  let diffToken = 0;
  let fileQuery = $state("");
  let workspaceView = $state<WorkspaceView>("changes");
  let conflictFocus = $state<string | null>(null);
  /** 从分支菜单「合并到当前分支」进入时预选的来源分支。 */
  let mergeSource = $state<string | null>(null);
  let mergeTarget = $state<string | null>(null);
  /** 分叉拉取用设置里的预选；从其他分支变基时固定为 rebase。普通合并不预选。 */
  let mergeMode = $state<MergeMode | null>(null);
  let historyPath = $state<string | null>(null);
  let historyQuery = $state("");
  let taskModal = $state<TaskModal | null>(null);
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
  let recovery = $state<{ discard: (paths?: string[]) => Promise<void> } | null>(null);
  /** 差异是否展开为完整文件（记在本机）：开启时按整份文件加上下文读取，暂存代码块暂不可用。 */
  const FULL_FILE_CONTEXT = 1_000_000;
  let diffFullFile = $state(readFullFilePreference());
  let mergeInProgress = $state(false);
  let mergeProbeSerial = 0;
  let remoteName = $state<string | null>(null);
  /** 仓库配置的全部远程名（同步菜单用）。 */
  let remoteNames = $state<string[]>([]);
  /** remoteNames 属于哪个仓库：同一仓库只读一次，远程弹窗读到或改动时直接更新。 */
  let remoteNamesFor: string | null = null;
  let syncCancelling = $state(false);
  /** 会访问远程、可以取消的同步动作。 */
  const REMOTE_PENDING = new Set(["fetch", "pull", "push", "publish", "associate"]);
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
  let changeCount = $derived(opened?.snapshot.files.length ?? 0);
  let conflictCount = $derived(opened?.snapshot.files.filter((file) => file.unmerged).length ?? 0);
  let upstreamMissing = $derived(opened ? !opened.snapshot.branch.upstream : false);
  let syncPending = $derived<"fetch" | "pull" | "push" | null>(
    pending === "fetch" || pending === "pull" || pending === "push" ? pending : null,
  );
  let remoteState = $derived(
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
  let activeNav = $derived(workspaceView === "history" ? historyNav : changesNav);
  /** 两份差异都可能挂着：只采用当前视图那一份，多选时单文件差异已经卸掉。 */
  let changesHunk = $state<HunkNavReport | null>(null);
  let historyHunk = $state<HunkNavReport | null>(null);
  let activeHunk = $derived<HunkNavReport | null>(workspaceView === "history" ? historyHunk : multiActive ? null : changesHunk);
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

  /* 命令注册表的唯一状态输入：标题栏、左栏、溢出菜单与命令面板都读这一份。 */
  let commandState = $derived<CommandState>({
    hasRepo: opened !== null,
    workspaceView,
    taskModal,
    sidebarHidden,
    writeLocked,
    // 只把写动作算作「正在写入」：pending 也承载差异续读（"diff"），
    // 把它算成写入会让读取期间的不可用原因失真（R11）。
    writing: pending !== null && pending !== "diff",
    reading: reading || pending === "diff",
    // 与 openRecent 的执行 guard 同源：任何 pending（含差异续读）都不切换仓库（R11）。
    switchingBlocked: pending !== null,
    upstreamMissing,
    stagedCount: scope.paths.length,
    stageTargets,
    unstageTargets,
    fileNav: activeNav,
    hunkNav: activeHunk ? { prevReason: activeHunk.prevReason, nextReason: activeHunk.nextReason } : null,
    multiFile: multiActive,
    draft,
    theme,
    recentRepos: recent,
    currentRepoPath: opened?.summary.path ?? null,
  });
  let paletteCommands = $derived(
    paletteItems(commandState).map((item) => ({
      id: item.id,
      group: item.group,
      title: item.title,
      shortcut: item.shortcut,
      keywords: item.keywords,
      detail: item.detail,
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
      const target = workspaceView === "history"
        ? document.getElementById("history-search")
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

  function showError(error: unknown) {
    const failure = error as AppFailure;
    const normalized = failure?.message ? failure : normalizeError(error);
    banner = normalized.message;
    live = normalized.message;
  }

  function applyTheme(next: Theme) {
    theme = next;
    // 首帧与测量钩子都要立即拿到解析结果，因此这里同步写一次；$effect 继续承担系统变化。
    if (typeof document !== "undefined") document.documentElement.dataset.theme = resolveTheme(next, systemDark);
  }

  /** 命令执行的唯一入口：四个入口都调它，结果因此一致（R11）。 */
  function runCommand(id: string) {
    switch (id) {
      case "view.changes":
        showChanges();
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
      case "diff.hunk.prev":
        activeHunk?.jump(-1);
        return;
      case "diff.hunk.next":
        activeHunk?.jump(1);
        return;
      case "view.find":
        focusFinder();
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

  function toggleSwitcher(kind: "repo" | "branch", anchor: HTMLElement) {
    if (switcher?.kind === kind) closeSwitcher();
    else switcher = { kind, anchor };
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

  /** 七个任务入口共用单槽：任一时刻只有一个任务 modal。 */
  function openTask(task: TaskModal) {
    if (task !== "settings" && !opened) return;
    if (task !== "merge") {
      mergeSource = null;
      mergeTarget = null;
      mergeMode = null;
    }
    closeSwitcher();
    cloneOpen = false;
    // 面板在批内卸载：先在它关闭前定下关闭弹窗时该回到哪，再交给 Modal。
    taskReturnFocus = paletteOpen ? paletteReturnFocus() : null;
    paletteOpen = false;
    branchCreateIntent = false;
    branchCreateBase = "";
    taskReturn = null;
    taskModal = task;
    if (task === "merge") void probeMerge();
    if (task === "publish") void loadRemoteName();
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
    if (taskModal || cloneOpen) return;
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
      return;
    }
    try {
      const session = await api.mergeSession(current.summary.path, current.generation, nextId());
      if (serial !== mergeProbeSerial || opened?.summary.path !== current.summary.path) return;
      mergeInProgress = session.operation === "merge" || session.canAbort;
    } catch (error) {
      if (serial !== mergeProbeSerial || opened?.summary.path !== current.summary.path) return;
      // stale 只说明这次探测用了旧 generation，不代表合并结束，提示不能因此消失。
      if (normalizeError(error).code !== "stale") mergeInProgress = false;
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
    repositoryEpoch += 1;
    if (draftTimer) clearTimeout(draftTimer);
    drafts.load(next.summary.path, next.draft);
    draft = next.draft;
    opened = next;
    selectedSet = [];
    degraded = next.watchDegraded;
    const groups = groupFiles(next.snapshot.files);
    const first = groups.unstaged[0] ?? groups.staged[0] ?? groups.conflicted[0];
    selected = retainSelection(next.snapshot.files, selected) ?? (first ? { path: first.path, side: first.side } : null);
    diff = null;
    diffError = null;
    commitError = null;
    pushRetry = false;
    phaseNote = null;
    workspaceView = "changes";
    historyPath = null;
    historyQuery = "";
    taskModal = null;
    paletteOpen = false;
    cloneOpen = false;
    closeSwitcher(false);
    conflictFocus = null;
    remoteName = null;
    remoteNames = [];
    remoteNamesFor = null;
    mergeInProgress = false;
    recent = [
      { name: next.summary.name, path: next.summary.path, openedAtMs: Date.now() },
      ...recent.filter((repo) => repo.path !== next.summary.path),
    ];
    live = `已打开 ${next.summary.name}`;
    void probeMerge();
    void loadSelectedDiff();
    if (closingClone) closeRepoDialogs();
  }

  /**
   * 克隆窗口还开着时用户在等结果，完成后照常打开。点过“在后台继续”就不再打断：
   * 不切换仓库、不关任何窗口，只加入最近仓库并通知。
   */
  function cloneFinished(next: OpenedRepository) {
    banner = null;
    const { name, path } = next.summary;
    if (cloneOpen) {
      rememberOpened(next);
      notice(`已克隆并打开 ${name}`);
      return;
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

  function refresh(): Promise<boolean> {
    if (!opened) return Promise.resolve(false);
    if (refreshTask?.epoch === repositoryEpoch) {
      refreshTask.again = true;
      return refreshTask.promise;
    }
    const task = { epoch: repositoryEpoch, again: false, promise: Promise.resolve(false) };
    refreshTask = task;
    task.promise = (async () => {
      let ok = false;
      do {
        task.again = false;
        ok = await refreshOnce(task.epoch);
      } while (task.again && task.epoch === repositoryEpoch && opened);
      return ok;
    })().finally(() => {
      if (refreshTask === task) refreshTask = null;
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
          )),
      );
      if (outcome.state === "discarded") return;
      if (outcome.state === "failed") {
        const failure = normalizeError(outcome.error);
        if (failure.code === "stale" && failure.generation !== undefined && opened?.summary.path === current.summary.path) {
          opened = { ...opened, generation: failure.generation };
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
    opened = { ...opened, generation };
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

  function useView(view: WorkspaceView) {
    workspaceView = view;
    if (view === "history") {
      diffToken += 1;
      diffLoading = false;
      diff = null;
      historyPanel ??= import("./lib/components/HistoryPanel.svelte");
    } else {
      void loadSelectedDiff();
    }
  }

  function showHistory() {
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
    opened = { ...opened, snapshot, generation: snapshot.generation };
    settleSelection(createSelectionResolver(snapshot.files, true));
    void loadSelectedDiff();
  }

  function mergeSnapshot(snapshot: StatusSnapshot) {
    applySnapshot(snapshot);
    void probeMerge();
  }

  /** 写操作的失败出口：通知条统一在这里落，调用方还能拿到归一化后的失败去就地说明。 */
  function handleMutationError(error: unknown): AppFailure {
    const failure = normalizeError(error);
    if (failure.generation !== undefined && opened && failure.generation !== opened.generation) {
      opened = { ...opened, generation: failure.generation };
      if (failure.code === "stale" || failure.code === "stale_patch") void refresh();
    }
    showError(failure);
    return failure;
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
      live = result.summary;
      void probeMerge();
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        // R5：失败原因要留在提交区里（缺身份、钩子拒绝、索引锁、过期各自可辨），
        // 草稿与仍然有效的暂存都不动，通知条只是第二条渠道。
        commitError = handleMutationError(error).message;
      }
    } finally {
      pending = null;
    }
  }

  async function commitAndPush() {
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
      phaseNote = result.summary;
      banner = result.pushed ? null : result.pushError;
      live = result.summary;
      void probeMerge();
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        // 这里失败的是「先完成本地提交」那一段（推送失败走 pushError，不抛）。
        // 两条提交路径因此给出同一份就地原因，而不是只有「提交到本地」这一条。
        commitError = handleMutationError(error).message;
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
      phaseNote = "推送已完成。没有再次创建提交。";
      banner = null;
      live = phaseNote;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) {
        pushRetry = true;
        handleMutationError(error);
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
      if (name === "push" || name === "publish") pushRetry = false;
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
        handleMutationError(failure);
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
    if (taskModal || cloneOpen || dependencyOpen || confirmPath || paletteOpen) {
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
      if ((await flushDraft(drafts.path)) === false) return;
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

  async function openRecent(path: string) {
    if (switchBlocked(commandState)) {
      // R11：仓库弹层与命令面板已按同一条判定禁用，但快捷入口和测量钩子仍会走到这里，
      // 所以不能静默返回——把同一个原因说出来，各入口的结论才一致。
      notice(switchBlockedReason(commandState));
      return;
    }
    const serial = ++readSerial;
    reading = true;
    readPhase = "idle";
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
    try {
      recent = await api.forgetRecent(path);
      if (opened?.summary.path === path) {
        await api.closeRepository();
        repositoryEpoch += 1;
        opened = null;
        selected = null;
        selectedSet = [];
        diff = null;
        draft = "";
        degraded = false;
        workspaceView = "changes";
        historyPath = null;
        taskModal = null;
        cloneOpen = false;
        paletteOpen = false;
        mergeInProgress = false;
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

  function repoContextMenu(repo: RecentRepo, point: { x: number; y: number }) {
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
      { separator: true },
      { id: "forget", label: "从最近列表移除", icon: "x", danger: true, run: () => void forget(repo.path) },
    ];
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

  /** 键盘层：把按键翻成命令 id，再走与四个入口相同的 runCommand。 */
  function onWindowKeydown(event: KeyboardEvent) {
    if (paletteOpen) return;
    if (taskModal !== null || cloneOpen || dependencyOpen || confirmPath !== null) return;
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
    const yieldsToLayer = id.startsWith("file.") || id.startsWith("diff.hunk.") || id === "view.find";
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
    live = `已提交 ${result.oid.slice(0, 7)}`;
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
    live = `已完成合并 ${done.oid.slice(0, 7)}`;
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
    const keyListener = (event: KeyboardEvent) => onWindowKeydown(event);
    const layerListener = () => {
      layerAtKey = anyLayerOpen();
    };
    window.addEventListener("keydown", layerListener, true);
    window.addEventListener("keydown", keyListener);
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
  />

  {#if switcher?.kind === "repo"}
    <RepoSwitcher
      anchor={switcher.anchor}
      repos={recent}
      currentPath={opened?.summary.path ?? null}
      blockedReason={switchBlocked(commandState) ? switchBlockedReason(commandState) : null}
      actionReason={writeLocked ? switchBlockedReason(commandState) : null}
      onSelect={(path) => {
        closeSwitcher();
        void openRecent(path);
      }}
      onForget={forget}
      onCopyPath={copyPath}
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
      onClose={closeSwitcher}
    />
  {/if}

  {#if reading}
    <div class="progress-line" aria-hidden="true"></div>
    <div class="infobar info" role="status">
      <span class="spinner"></span>
      <span class="infobar-text">正在读取仓库，可以切换仓库或使用键盘。取消只停止这次读取，不会写入仓库。</span>
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
          <ViewSwitcher view={workspaceView} {changeCount} onView={(view) => runCommand(`view.${view}`)} />
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
        <MergeBanner {conflictCount} {mergeInProgress} onOpen={() => runCommand("task.merge")} />
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
                />
                <CommitDraft
                  branch={branchText}
                  scope={scope.label}
                  paths={scope.paths}
                  value={draft}
                  disabled={writeLocked}
                  busy={pending}
                  error={commitError}
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
                      <button
                        type="button"
                        class="menu-item"
                        role="menuitem"
                        disabled={!commandAvailable(command, commandState)}
                        title={commandReason(command, commandState) || command.hint}
                        onclick={() => runCommand(command.id)}
                      >
                        <Icon name={OVERFLOW_COMMAND_ICONS[command.id as keyof typeof OVERFLOW_COMMAND_ICONS] ?? "chevron-right"} />
                        <span>{command.title}<small>{command.hint}</small></span>
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
                  onLoadMore={loadMoreDiff}
                  onFileHistory={openFileHistory}
                  fullFile={diffFullFile}
                  onFullFile={setFullFile}
                  fileNav={changesNav}
                  fileCount={opened.snapshot.files.length}
                  onRetry={() => void loadSelectedDiff()}
                  onHunkNav={reportChangesHunk}
                />
              {/if}
            </div>
          </div>
          <div
            class="workbench-view"
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
                  onClearFile={() => (historyPath = null)}
                  onSnapshot={mergeSnapshot}
                  onNotice={notice}
                  onFileNav={(nav) => (historyNav = nav)}
                  onHunkNav={reportHistoryHunk}
                  {branchGroups}
                  {paneHead}
                  {paneResizer}
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

  <StatusBar
    hasRepo={opened !== null}
    sync={syncText}
    busy={writeLocked}
    busyLabel={commandState.writing ? "写入中" : "读取中"}
    refreshing={pending !== null || reading}
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
  />
</div>

<CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => (paletteOpen = false)} />

{#if contextMenu}
  <ContextMenu request={contextMenu} onClose={() => (contextMenu = null)} />
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

{#if opened && taskModal === "stash"}
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
    onPullIntegration={(next) => void changePullIntegration(next)}
    onBranchGroups={(next) => void changeBranchGroups(next)}
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
