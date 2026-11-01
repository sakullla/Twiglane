<script lang="ts">
  import { onMount } from "svelte";
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
  import { finishDiffAttempt } from "./lib/diff";
  import { DraftBuffer } from "./lib/draft";
  import { normalizeError } from "./lib/errors";
  import { clampWidth, FALLBACK_POLL_MS, fitPaneWidth, shouldPoll } from "./lib/layout";
  import { branchLabel, commitScope, dependencyNote, filterRows, groupFiles, retainSelection, selectionAfterEdit, syncLabel } from "./lib/labels";
  import { startDesktopMeasure } from "./lib/measure";
  import { shortcutCommand } from "./lib/shortcuts";
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
    TaskModal,
    Theme,
    WorkspaceView,
  } from "./lib/types";
  import { hasCommitSummary } from "./lib/ui";
  import BranchDialog from "./lib/components/BranchDialog.svelte";
  import BranchSwitcher from "./lib/components/BranchSwitcher.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./lib/components/ContextMenu.svelte";
  import CommitDraft from "./lib/components/CommitDraft.svelte";
  import DetailDialog from "./lib/components/DetailDialog.svelte";
  import DiffView from "./lib/components/DiffView.svelte";
  import FileList from "./lib/components/FileList.svelte";
  import Icon from "./lib/components/Icon.svelte";
  import MergeBanner from "./lib/components/MergeBanner.svelte";
  import MergeModal from "./lib/components/MergeModal.svelte";
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
  let repositoryEpoch = 0;
  let refreshTask: { epoch: number; again: boolean; promise: Promise<boolean> } | null = null;
  let draggingRepository = $state(false);
  let draft = $state("");
  /**
   * R5：上一次提交失败的原因。它只在提交区就地显示（CommitDraft 的 data-commit-error），
   * 与右下角通知条并行而不是替代——通知条会自己消失，提交区这份留到下次尝试或说明改动为止。
   */
  let commitError = $state<string | null>(null);
  let selected = $state<FileSelection | null>(null);
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
  /** 设置 modal 打开时要定位的分区；由 Git 诊断入口置为 runtime，其余入口为空。 */
  let settingsSection = $state<"appearance" | "runtime" | null>(null);
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
  let historyPath = $state<string | null>(null);
  let historyQuery = $state("");
  let taskModal = $state<TaskModal | null>(null);
  let paletteOpen = $state(false);
  /** 当前打开的右键菜单（文件列表、最近仓库）；任务 modal 里的右键菜单由各自组件承载。 */
  let contextMenu = $state<ContextMenuRequest | null>(null);
  let recovery = $state<{ discard: (paths?: string[]) => Promise<void> } | null>(null);
  /** 差异是否展开为完整文件（记在本机）：开启时按整份文件加上下文读取，暂存代码块暂不可用。 */
  const FULL_FILE_CONTEXT = 1_000_000;
  let diffFullFile = $state(readFullFilePreference());
  let mergeInProgress = $state(false);
  let mergeProbeSerial = 0;
  let remoteName = $state<string | null>(null);
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
    draft,
    theme,
    recentRepos: recent,
  });
  let paletteCommands = $derived(
    paletteItems(commandState).map((item) => ({
      id: item.id,
      group: item.group,
      title: item.title,
      shortcut: item.shortcut,
      keywords: item.keywords,
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
        sidebarHidden = !sidebarHidden;
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

  /** 七个任务入口共用单槽：任一时刻只有一个任务 modal。 */
  function openTask(task: TaskModal) {
    if (task !== "settings" && !opened) return;
    closeSwitcher();
    cloneOpen = false;
    paletteOpen = false;
    taskModal = task;
    if (task === "merge") void probeMerge();
    if (task === "publish") void loadRemoteName();
  }

  /** 设置 modal：默认落在外观首屏，Git 诊断入口另行指定运行环境分区（R10）。 */
  function openSettings(section: "appearance" | "runtime" | null = null) {
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

  function closeTask() {
    const closed = taskModal;
    taskModal = null;
    settingsSection = null;
    if (closed === "merge") {
      conflictFocus = null;
      mergeSource = null;
      mergeTarget = null;
      void probeMerge();
    }
  }

  function openClone() {
    if (writeLocked) return;
    taskModal = null;
    paletteOpen = false;
    cloneOpen = true;
  }

  function openPalette() {
    if (taskModal || cloneOpen) return;
    closeSwitcher();
    paletteOpen = true;
  }

  async function loadSettings() {
    try {
      const settings = await api.getSettings();
      applyTheme(settings.theme);
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
    } catch {
      if (serial === mergeProbeSerial && opened?.summary.path === current.summary.path) mergeInProgress = false;
    }
  }

  function rememberOpened(next: OpenedRepository) {
    repositoryEpoch += 1;
    if (draftTimer) clearTimeout(draftTimer);
    drafts.load(next.summary.path, next.draft);
    draft = next.draft;
    opened = next;
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
    mergeInProgress = false;
    recent = [
      { name: next.summary.name, path: next.summary.path, openedAtMs: Date.now() },
      ...recent.filter((repo) => repo.path !== next.summary.path),
    ];
    live = `已打开 ${next.summary.name}`;
    void probeMerge();
    void loadSelectedDiff();
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
      selected = retainSelection(snapshot.files, selected);
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
    if (!current || !choice) {
      diff = null;
      diffError = null;
      diffLoading = false;
      return;
    }
    diffLoading = true;
    diffError = null;
    const file = current.snapshot.files.find((item) => item.path === choice.path);
    try {
      const outcome = await finishDiffAttempt(
        { token, repo: current.summary.path, path: choice.path, side: choice.side },
        () => ({
          token: diffToken,
          repo: opened?.summary.path ?? null,
          path: selected?.path ?? null,
          side: selected?.side ?? null,
        }),
        () =>
          api.loadDiff(
            current.summary.path,
            choice.path,
            choice.side === "staged",
            current.generation,
            nextId(),
            file?.originalPath ?? null,
            0,
            0,
            diffFullFile ? FULL_FILE_CONTEXT : undefined,
          ),
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
      diff = outcome.value;
      diffError = null;
    } finally {
      if (token === diffToken && opened?.summary.path === current.summary.path) diffLoading = false;
    }
  }

  function selectFile(selection: FileSelection) {
    selected = selection;
    void loadSelectedDiff();
  }

  function adoptGeneration(generation: number) {
    if (!opened || opened.generation === generation) return;
    opened = { ...opened, generation };
  }

  function showChanges() {
    workspaceView = "changes";
    historyPath = null;
  }

  function useView(view: WorkspaceView) {
    workspaceView = view;
    if (view === "history") historyPanel ??= import("./lib/components/HistoryPanel.svelte");
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
    const previous = selected;
    opened = { ...opened, snapshot, generation: snapshot.generation };
    selected = selectionAfterEdit(snapshot.files, previous);
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

  async function stageHunk(hunk: DiffHunk) {
    const current = opened;
    const choice = selected;
    const currentDiff = diff;
    if (!current || !choice || !currentDiff || pending || reading || !hunk.stageable) return;
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

  async function runSync(name: string, action: (path: string, generation: number) => Promise<StatusSnapshot>) {
    const current = opened;
    if (!current || pending || reading) return;
    pending = name;
    live =
      name === "fetch"
        ? "正在检查远程"
        : name === "pull"
          ? "正在快进拉取"
          : name === "publish"
            ? "正在发布分支"
            : name === "associate"
              ? "正在关联上游，不会推送"
              : "正在推送";
    try {
      const snapshot = await action(current.summary.path, current.generation);
      if (opened?.summary.path !== current.summary.path) return;
      applySnapshot(snapshot);
      banner = null;
      if (name === "push" || name === "publish") pushRetry = false;
      phaseNote =
        name === "fetch"
          ? "远程检查已完成，工作区文件没有因为检查而改变。"
          : name === "pull"
            ? "快进拉取已完成，文件和同步状态已刷新。"
            : name === "publish"
              ? "分支已发布并关联上游。"
              : name === "associate"
                ? "已关联上游。这一步没有推送。"
                : "推送已完成，没有强行推送。";
      live = phaseNote;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
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

  /** .gitignore 规则：按文件（锚定到仓库根）、按扩展名、按所在目录三种。 */
  function ignoreRules(relative: string): { label: string; pattern: string }[] {
    const rules = [{ label: `忽略此文件（/${relative}）`, pattern: `/${relative}` }];
    const name = relative.split("/").pop() ?? relative;
    const dot = name.lastIndexOf(".");
    if (dot > 0) rules.push({ label: `忽略所有 ${name.slice(dot)} 文件`, pattern: `*${name.slice(dot)}` });
    const slash = relative.lastIndexOf("/");
    if (slash > 0) rules.push({ label: `忽略目录 ${relative.slice(0, slash)}/`, pattern: `/${relative.slice(0, slash)}/` });
    return rules;
  }

  async function ignore(pattern: string) {
    const current = opened;
    if (!current || pending || reading) return;
    pending = "ignore";
    try {
      const snapshot = await api.ignorePath(current.summary.path, pattern, current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      applySnapshot(snapshot);
      notice(`已把 ${pattern} 加入 .gitignore。已被跟踪的文件不受影响，需要先从索引移除。`);
    } catch (error) {
      handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  function fileContextMenu(row: FileRow, point: { x: number; y: number }) {
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
    if (row.untracked) {
      entries.push({ separator: true }, { heading: "加入 .gitignore" });
      for (const rule of ignoreRules(row.path)) {
        entries.push({ id: `ignore:${rule.pattern}`, label: rule.label, icon: "eye", disabledReason: busy, run: () => void ignore(rule.pattern) });
      }
    }
    contextMenu = { x: point.x, y: point.y, entries, label: `${row.path} 的操作` };
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

  /** 键盘层：把按键翻成命令 id，再走与四个入口相同的 runCommand。 */
  function onWindowKeydown(event: KeyboardEvent) {
    if (paletteOpen) return;
    if (taskModal !== null || cloneOpen || dependencyOpen || confirmPath !== null) return;
    const id = shortcutCommand(event);
    if (!id) return;
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
    const keyListener = (event: KeyboardEvent) => onWindowKeydown(event);
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
        openPalette();
      });
      stopCommit = await listenEvent("menu-commit", () => {
        void commitLocal();
      });
      stopRepo = await listenEvent<RepoChanged>("repo-changed", (event) => {
        if (!opened || event.path !== opened.summary.path) return;
        opened = { ...opened, generation: event.generation };
        degraded = degraded || event.degraded;
        void refresh();
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
    {theme}
    disabled={writeLocked}
    onBrand={() => runCommand("palette.open")}
    openSwitcher={switcher?.kind ?? null}
    onRepo={(anchor) => toggleSwitcher("repo", anchor)}
    onBranch={(anchor) => toggleSwitcher("branch", anchor)}
    onFetch={() => runCommand("sync.fetch")}
    onPull={() => runCommand("sync.pull")}
    onPush={() => runCommand("sync.push")}
    onRemote={() => runCommand("task.remote")}
    onTheme={(next) => runCommand(`theme.${next}`)}
    onSettings={() => runCommand("task.settings")}
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
      {nextId}
      onBusy={(name) => (pending = name)}
      onGeneration={adoptGeneration}
      onSnapshot={applySnapshot}
      onFailure={handleMutationError}
      onNotice={notice}
      onCommand={runFromSwitcher}
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
  {#if gitDiagnostic && !gitDismissed}
    <!-- R10：一句结论 + 一个可关闭入口；安装说明留在设置/运行依赖里，不堆在首屏（R12）。 -->
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
  {:else if git?.belowBaseline}
    <div class="infobar warn" role="status">
      <Icon name="alert" size={15} />
      <span class="infobar-text">{git.message}</span>
    </div>
  {/if}

  <div class="workspace" data-sidebar={sidebarHidden ? "hidden" : "visible"} style={`--files:${paneWidth}px`}>
    <main class="content">
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
          label="调整侧栏宽度"
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
                  files={opened.snapshot.files}
                  {selected}
                  query={fileQuery}
                  disabled={writeLocked}
                  onQuery={(value) => (fileQuery = value)}
                  onSelect={selectFile}
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
                  {#snippet overflow()}
                    <div class="menu-label" role="presentation">撤销与恢复</div>
                    {#if opened}
                      <RecoveryActions
                        opened={opened}
                        variant="menu"
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
              <DiffView
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
              />
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
                  {opened}
                  filePath={historyPath}
                  searchQuery={historyQuery}
                  disabled={writeLocked}
                  {nextId}
                  onGeneration={adoptGeneration}
                  onFailure={handleMutationError}
                  onFilePath={openFileHistory}
                  onClearFile={() => (historyPath = null)}
                  onSnapshot={applySnapshot}
                  onNotice={notice}
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
          diagnostic={gitDiagnostic}
          onDiagnose={gitDiagnostic ? openGitDiagnostics : undefined}
          onAdd={() => runCommand("repo.add")}
          onClone={() => runCommand("repo.clone")}
          onCreate={() => runCommand("repo.create")}
          onOpen={openRecent}
        />
      {/if}
    </main>
  </div>

  <StatusBar
    hasRepo={opened !== null}
    sync={syncText}
    busy={writeLocked}
    refreshing={pending !== null || reading}
    {degraded}
    warning={warning}
    onRefresh={() => runCommand("view.refresh")}
    {sidebarHidden}
    onToggleSidebar={() => runCommand("rail.toggle")}
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
    disabled={writeLocked}
    {nextId}
    onClose={closeTask}
    onGeneration={adoptGeneration}
    onSnapshot={mergeSnapshot}
    onFailure={handleMutationError}
    onNotice={notice}
    onOpenChanges={openConflict}
  />
{:else if opened && taskModal === "merge"}
  <MergeModal
    {opened}
    focusPath={conflictFocus}
    initialSource={mergeSource}
    initialTarget={mergeTarget}
    disabled={writeLocked}
    {nextId}
    onClose={closeTask}
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
    onMergeBranch={(name) => {
      closeTask();
      mergeSource = name;
      mergeTarget = null;
      openTask("merge");
    }}
    onMergeInto={(name) => {
      const from = opened?.snapshot.branch.name ?? null;
      closeTask();
      mergeSource = from;
      mergeTarget = name;
      openTask("merge");
    }}
    {nextId}
  />
{:else if taskModal === "settings"}
  <SettingsModal
    {theme}
    {git}
    disabled={writeLocked}
    section={settingsSection}
    onClose={closeTask}
    onTheme={(next) => runCommand(`theme.${next}`)}
    onRedetect={redetectGit}
    onChooseGit={chooseGit}
    onClearGit={clearGit}
  />
{:else if opened && taskModal === "scope"}
  <ScopeModal scopeLabel={scope.label} paths={scope.paths} onClose={closeTask} />
{:else if opened && taskModal === "publish"}
  <PublishModal
    branch={branchText}
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
  onClose={() => {
    cloneOpen = false;
    if (taskModal === "remote") taskModal = null;
  }}
  onBusy={(name) => (pending = name)}
  onSnapshot={applySnapshot}
  onOpened={(repo) => {
    banner = null;
    rememberOpened(repo);
  }}
  onFailure={handleMutationError}
  onNotice={notice}
  onOpenHistory={openCommitSearch}
  {nextId}
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
