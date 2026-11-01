<script lang="ts">
  import { onMount } from "svelte";
  import { api, listenEvent, pickDirectory, pickFile } from "./lib/api";
  import { MODIFIER_LABEL } from "./lib/brand";
  import { finishDiffAttempt } from "./lib/diff";
  import { DraftBuffer } from "./lib/draft";
  import { normalizeError } from "./lib/errors";
  import { clampWidth, FALLBACK_POLL_MS, nudgeWidth, shouldPoll } from "./lib/layout";
  import { branchLabel, commitScope, dependencyNote, gitInstallHint, groupFiles, retainSelection, selectionAfterEdit, syncLabel } from "./lib/labels";
  import { startDesktopMeasure } from "./lib/measure";
  import type {
    AppFailure,
    DiffHunk,
    DiffResponse,
    FileSelection,
    GitInfo,
    OpenedRepository,
    PanelWidths,
    RecentRepo,
    RepoChanged,
    StatusSnapshot,
    Theme,
    WorkspaceView,
  } from "./lib/types";
  import { hueOf, initialOf } from "./lib/ui";
  import CommitDraft from "./lib/components/CommitDraft.svelte";
  import Icon from "./lib/components/Icon.svelte";
  import Welcome from "./lib/components/Welcome.svelte";
  import DetailDialog from "./lib/components/DetailDialog.svelte";
  import DiffView from "./lib/components/DiffView.svelte";
  import FileList from "./lib/components/FileList.svelte";
  import RecoveryActions from "./lib/components/RecoveryActions.svelte";
  import RepoDialogs from "./lib/components/RepoDialogs.svelte";
  import RepoSidebar from "./lib/components/RepoSidebar.svelte";

  let theme = $state<Theme>("light");
  let widths = $state<PanelWidths>({ sidebar: 256, files: 360 });
  let recent = $state<RecentRepo[]>([]);
  let query = $state("");
  let git = $state<GitInfo | null>(null);
  let warning = $state<string | null>(null);
  let banner = $state<string | null>(null);
  let live = $state("正在准备 Twiglane");
  let opened = $state<OpenedRepository | null>(null);
  let draft = $state("");
  let selected = $state<FileSelection | null>(null);
  let diff = $state<DiffResponse | null>(null);
  let diffError = $state<string | null>(null);
  let diffLoading = $state(false);
  let pending = $state<string | null>(null);
  let reading = $state(false);
  let readSerial = 0;
  let readPhase: "idle" | "reading" | "settled" = "idle";
  let dependencyOpen = $state(false);
  let historyPanel = $state<Promise<typeof import("./lib/components/HistoryPanel.svelte")> | null>(null);
  let mergePanel = $state<Promise<typeof import("./lib/components/MergePanel.svelte")> | null>(null);
  let stashPanel = $state<Promise<typeof import("./lib/components/StashPanel.svelte")> | null>(null);
  let writeLocked = $derived(pending !== null || reading);
  let navCollapsed = $state(false);
  let repoMenuOpen = $state(false);
  let repoMenuAnchor = $state<HTMLDivElement | null>(null);
  let confirmPath = $state<string | null>(null);
  let dialog = $state<"clone" | "remote" | "branch" | null>(null);
  let pushRetry = $state(false);
  let phaseNote = $state<string | null>(null);
  let degraded = $state(false);
  let windowFocused = $state(true);
  let requestSerial = 1;
  let diffToken = 0;
  let fileQuery = $state("");
  let workspaceView = $state<WorkspaceView>("changes");
  let conflictFocus = $state<string | null>(null);
  let historyPath = $state<string | null>(null);
  let historyQuery = $state("");
  const drafts = new DraftBuffer();
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  let branchText = $derived(opened ? branchLabel(opened.snapshot.branch) : "未打开仓库");
  let syncText = $derived(opened ? syncLabel(opened.snapshot.branch) : "未检查远程");
  let scope = $derived(opened ? commitScope(branchText, opened.snapshot.files) : { label: "", paths: [] as string[] });
  let ahead = $derived(opened?.snapshot.branch.ahead ?? 0);
  let behind = $derived(opened?.snapshot.branch.behind ?? 0);
  let changeCount = $derived(opened?.snapshot.files.length ?? 0);
  let conflictCount = $derived(opened?.snapshot.files.filter((file) => file.unmerged).length ?? 0);
  let remoteState = $derived(
    !opened
      ? "off"
      : opened.snapshot.branch.liveRemoteChecked
        ? "live"
        : opened.snapshot.branch.remoteCheckStale
          ? "stale"
          : "off",
  );
  const VIEWS = [
    { id: "changes", label: "改动", icon: "file-diff" },
    { id: "history", label: "提交历史", icon: "history" },
    { id: "stash", label: "临时保存", icon: "archive" },
    { id: "merge", label: "分支合并", icon: "merge" },
  ] as const;
  const VIEW_DETAILS: Record<WorkspaceView, { title: string; description: string }> = {
    changes: { title: "工作区改动", description: "查看差异、整理暂存，再完成一个清晰的提交。" },
    history: { title: "提交历史", description: "沿着提交记录，理解项目每一次变化。" },
    stash: { title: "临时保存", description: "收起未完成的工作，随时回来继续。" },
    merge: { title: "分支合并", description: "预览合并影响，逐一处理每一处冲突。" },
  };
  let viewInfo = $derived(VIEW_DETAILS[workspaceView]);

  $effect(() => {
    if (!repoMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (repoMenuAnchor && !repoMenuAnchor.contains(event.target as Node)) repoMenuOpen = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") repoMenuOpen = false;
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  $effect(() => {
    const note = phaseNote;
    if (!note || pushRetry) return;
    const timer = setTimeout(() => {
      if (phaseNote === note) phaseNote = null;
    }, 6000);
    return () => clearTimeout(timer);
  });

  function nextId(): number {
    requestSerial += 1;
    return requestSerial;
  }

  function showError(error: unknown) {
    const failure = error as AppFailure;
    const normalized = failure?.message ? failure : normalizeError(error);
    banner = normalized.message;
    live = normalized.message;
  }

  function applyTheme(next: Theme) {
    theme = next;
    document.documentElement.dataset.theme = next;
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

  function rememberOpened(next: OpenedRepository) {
    if (draftTimer) clearTimeout(draftTimer);
    drafts.load(next.summary.path, next.draft);
    draft = next.draft;
    opened = next;
    degraded = next.watchDegraded;
    const groups = groupFiles(next.snapshot.files);
    const first = groups.unstaged[0] ?? groups.staged[0];
    selected = retainSelection(next.snapshot.files, selected) ?? (first ? { path: first.path, side: first.side } : null);
    diff = null;
    diffError = null;
    pushRetry = false;
    phaseNote = null;
    workspaceView = "changes";
    historyPath = null;
    historyQuery = "";
    recent = [
      { name: next.summary.name, path: next.summary.path, openedAtMs: Date.now() },
      ...recent.filter((repo) => repo.path !== next.summary.path),
    ];
    live = `已打开 ${next.summary.name}`;
    void loadSelectedDiff();
  }

  async function refresh() {
    const current = opened;
    if (!current) return;
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
      if (opened?.summary.path !== current.summary.path) return;
      opened = { ...opened, snapshot, generation: snapshot.generation };
      selected = retainSelection(snapshot.files, selected);
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) showError(error);
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
    if (view === "merge") mergePanel ??= import("./lib/components/MergePanel.svelte");
    if (view === "stash") stashPanel ??= import("./lib/components/StashPanel.svelte");
  }

  function showHistory() {
    historyPath = null;
    historyQuery = "";
    useView("history");
  }

  function navigate(view: WorkspaceView) {
    if (view === "changes") showChanges();
    else if (view === "history") showHistory();
    else useView(view);
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
    historyPath = null;
    useView("merge");
  }

  function applySnapshot(snapshot: StatusSnapshot) {
    if (!opened) return;
    const previous = selected;
    opened = { ...opened, snapshot, generation: snapshot.generation };
    selected = selectionAfterEdit(snapshot.files, previous);
    void loadSelectedDiff();
  }

  function handleMutationError(error: unknown) {
    const failure = normalizeError(error);
    if (failure.generation !== undefined && opened && failure.generation !== opened.generation) {
      opened = { ...opened, generation: failure.generation };
      if (failure.code === "stale" || failure.code === "stale_patch") void refresh();
    }
    showError(failure);
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
    if (!message.trim()) {
      banner = "请先填写提交说明。";
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
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  async function commitAndPush() {
    const current = opened;
    if (!current || pending || reading) return;
    const message = draft;
    if (!message.trim()) {
      banner = "请先填写提交说明。";
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
      await loadSelectedDiff();
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
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
    if (pending || reading) return;
    pending = "add";
    live = "正在选择目录";
    try {
      const path = await pickDirectory("添加已有仓库");
      if (!path) return;
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
    if (pending) return;
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
        opened = null;
        selected = null;
        diff = null;
        draft = "";
        degraded = false;
        workspaceView = "changes";
        historyPath = null;
      }
    } catch (error) {
      showError(error);
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      phaseNote = "已复制仓库完整路径。";
      live = phaseNote;
      banner = null;
    } catch {
      showError(new Error("无法写入剪贴板，请手动复制仓库路径。"));
    }
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
    }
  }

  function onDraftInput(value: string) {
    draft = value;
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

  function startResize(event: PointerEvent, which: "sidebar" | "files") {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const startX = event.clientX;
    const start = widths[which];
    target.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      widths = { ...widths, [which]: clampWidth(start + pointer.clientX - startX) };
    };
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      void persistWidths();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  }

  function resizeKey(event: KeyboardEvent, which: "sidebar" | "files") {
    const next = nudgeWidth(widths[which], event.key);
    if (next === null) return;
    event.preventDefault();
    widths = { ...widths, [which]: next };
    void persistWidths();
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
      await refresh();
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
    const search = document.getElementById("repo-search");
    if (document.activeElement === search && search instanceof HTMLElement) search.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
    const shortcutFocused = Boolean(search && document.activeElement === search);
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
    const search = document.getElementById("repo-search");
    const opening = openRecent(slowRepo);
    const sawRead = await waitUntilRepositoryRead(opening);
    let keyboard = false;
    if (sawRead && readPhase === "reading") {
      if (document.activeElement === search && search instanceof HTMLElement) search.blur();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
      keyboard = Boolean(search && document.activeElement === search && readPhase === "reading");
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
    const session = await api.startMerge(current.summary.path, source, current.generation, nextId());
    applySnapshot(session.snapshot);
    useView("merge");
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

  function focusSearch(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      document.getElementById("repo-search")?.focus();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !confirmPath) {
      event.preventDefault();
      void commitLocal();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && /^[1-4]$/.test(event.key) && opened) {
      event.preventDefault();
      const view = VIEWS[Number(event.key) - 1].id;
      if (view === "changes") showChanges();
      else if (view === "history") showHistory();
      else useView(view);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "b" && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      navCollapsed = !navCollapsed;
    }
  }

  onMount(() => {
    let stopFocus = () => {};
    let stopBlur = () => {};
    let stopRepo = () => {};
    let stopCommit = () => {};
    let stopSearch = () => {};
    const keyListener = (event: KeyboardEvent) => focusSearch(event);
    window.addEventListener("keydown", keyListener);
    void (async () => {
      stopFocus = await listenEvent("window-focused", () => {
        windowFocused = true;
        void refresh();
      });
      stopBlur = await listenEvent("window-blurred", () => {
        windowFocused = false;
      });
      stopSearch = await listenEvent("menu-search", () => {
        document.getElementById("repo-search")?.focus();
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
      window.removeEventListener("keydown", keyListener);
      window.clearInterval(poll);
      if (draftTimer) clearTimeout(draftTimer);
      stopFocus();
      stopBlur();
      stopRepo();
      stopCommit();
      stopSearch();
    };
  });
</script>

<div class="sr-only" aria-live="polite">{live}</div>
<div class="shell">
  <header class="topbar">
    <button
      type="button"
      class="icon-btn nav-toggle"
      aria-label={navCollapsed ? "展开导航" : "折叠导航"}
      title={`${navCollapsed ? "展开" : "折叠"}仓库栏（${MODIFIER_LABEL}+B）`}
      aria-expanded={!navCollapsed}
      onclick={() => (navCollapsed = !navCollapsed)}
    >
      <Icon name="sidebar" size={18} />
    </button>
    {#if opened}
      <div class="topbar-context">
        <div class="menu-anchor repo-switch-anchor" bind:this={repoMenuAnchor}>
          <button
            type="button"
            class="repo-switch"
            title={`${opened.summary.path}\n点击切换仓库`}
            aria-haspopup="menu"
            aria-expanded={repoMenuOpen}
            onclick={() => (repoMenuOpen = !repoMenuOpen)}
          >
            <span class="repo-badge" style={`--hue:${hueOf(opened.summary.path)}`} aria-hidden="true">{initialOf(opened.summary.name)}</span>
            <span class="repo-switch-text">
              <strong>{opened.summary.name}</strong>
              <span><bdi>{opened.summary.path}</bdi></span>
            </span>
            <Icon name="chevron-down" size={13} />
          </button>
          {#if repoMenuOpen}
            <div class="menu left repo-switch-menu" role="menu" aria-label="切换仓库">
              <div class="repo-menu-title">选择要打开的仓库</div>
              {#each recent.slice(0, 6) as repo (repo.path)}
                <button
                  type="button"
                  class="menu-item repo-menu-item"
                  role="menuitemradio"
                  aria-checked={repo.path === opened?.summary.path}
                  onclick={() => {
                    repoMenuOpen = false;
                    void openRecent(repo.path);
                  }}
                >
                  <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
                  <span><strong>{repo.name}</strong><small><bdi>{repo.path}</bdi></small></span>
                  {#if repo.path === opened?.summary.path}<Icon name="check" size={14} />{/if}
                </button>
              {/each}
              <div class="menu-sep"></div>
              <button type="button" class="menu-item" role="menuitem" disabled={writeLocked} onclick={() => { repoMenuOpen = false; void addRepo(); }}>
                <Icon name="plus" /><span>添加仓库<small>打开一个本地 Git 仓库</small></span>
              </button>
              <button type="button" class="menu-item" role="menuitem" onclick={() => { repoMenuOpen = false; void copyPath(opened?.summary.path ?? ""); }}>
                <Icon name="copy" /><span>复制当前仓库路径</span>
              </button>
            </div>
          {/if}
        </div>
        <span class="context-separator" aria-hidden="true">/</span>
        <button
          type="button"
          class="branch-pill"
          title={`当前分支：${branchText}\n点击搜索、切换、创建或删除分支`}
          disabled={writeLocked}
          onclick={() => (dialog = "branch")}
        >
          <Icon name="branch" size={15} />
          <span class="truncate">{branchText}</span>
          <Icon name="chevron-down" size={13} />
        </button>
      </div>
    {:else}
      <div class="topbar-empty-title"><span>开始</span><span class="topbar-empty-note">打开一个仓库，继续你的工作</span></div>
    {/if}
    <span class="spacer"></span>
    {#if opened}
      <div class="topbar-actions">
        {#if pushRetry}
          <button type="button" class="btn btn-primary btn-sm" disabled={writeLocked} onclick={retryPush}>
            {#if pending === "push"}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
            重试推送
          </button>
        {/if}
        {#if !opened.snapshot.branch.upstream}
          <button
            type="button"
            class="btn btn-accent-soft btn-sm"
            disabled={writeLocked}
            title="把当前分支推送到远程并建立上游关联"
            onclick={() => runSync("publish", (path, generation) => api.publishBranch(path, "", generation, nextId()))}
          >
            <Icon name="upload" size={14} />发布分支
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm associate-btn"
            disabled={writeLocked}
            title="只建立上游关联，不推送"
            onclick={() => runSync("associate", (path, generation) => api.associateUpstream(path, "", generation, nextId()))}
          >
            <Icon name="link" size={14} />只关联上游
          </button>
        {/if}
        <button type="button" class="icon-btn refresh-workspace" aria-label="刷新工作区" title="重新读取工作区与当前差异" disabled={writeLocked} onclick={() => void refresh()}>
          <Icon name="refresh" size={16} />
        </button>
        <div class="toolbar-group" role="group" aria-label="远程同步">
          <button
            type="button"
            class="tb-btn"
            class:busy={pending === "fetch"}
            disabled={writeLocked}
            title={`获取更新：下载远程分支和提交信息，不修改本地文件\n需要把提交带入当前分支时，再执行“拉取”\n${syncText}`}
            onclick={() => runSync("fetch", (path, generation) => api.fetchRemote(path, generation, nextId()))}
          >
            <Icon name="download" size={14} /><span class="tb-label">获取更新</span>
          </button>
          <button
            type="button"
            class="tb-btn"
            class:busy={pending === "pull"}
            disabled={writeLocked}
            title={behind > 0 ? `快进拉取 ${behind} 个提交` : "快进拉取（不会自动合并分叉）"}
            onclick={() => runSync("pull", (path, generation) => api.pullFastForward(path, generation, nextId()))}
          >
            <Icon name="arrow-down" size={14} /><span class="tb-label">拉取</span>
            {#if behind > 0}<span class="count subtle-count">{behind}</span>{/if}
          </button>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm push-button"
          class:busy={pending === "push"}
          disabled={writeLocked}
          title={ahead > 0 ? `推送 ${ahead} 个本地提交（不会强行推送）` : "推送（不会强行推送）"}
          onclick={() => runSync("push", (path, generation) => api.pushBranch(path, generation, nextId()))}
        >
          {#if pending === "push"}<span class="spinner"></span>{:else}<Icon name="arrow-up" size={14} />{/if}
          <span>推送</span>{#if ahead > 0}<span class="push-count">{ahead}</span>{/if}
        </button>
        <button type="button" class="icon-btn" aria-label="远程" title="管理远程地址" disabled={writeLocked} onclick={() => (dialog = "remote")}>
          <Icon name="globe" size={17} />
        </button>
      </div>
    {/if}
  </header>
  {#if reading}
    <div class="progress-line" aria-hidden="true"></div>
    <div class="infobar info" role="status">
      <span class="spinner"></span>
      <span class="infobar-text">正在读取仓库，可以切换仓库或使用键盘。取消只停止这次读取，不会写入仓库。</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick={cancelReading}>取消读取</button>
    </div>
  {/if}
  {#if git && !git.available}
    <div class="infobar error" role="status">
      <Icon name="alert-circle" size={16} />
      <div class="infobar-text">
        <strong>{git.message}</strong>
        <p>{gitInstallHint(navigator.platform ?? "")}</p>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" onclick={redetectGit}>重新检测</button>
      <button type="button" class="btn btn-secondary btn-sm" onclick={chooseGit}>选择 Git</button>
      {#if git.overridden}<button type="button" class="btn btn-ghost btn-sm" onclick={clearGit}>恢复自动检测</button>{/if}
    </div>
  {:else if git?.belowBaseline}
    <div class="infobar warn" role="status">
      <Icon name="alert" size={15} />
      <span class="infobar-text">{git.message}</span>
    </div>
  {/if}
  <div
    class:nav-collapsed={navCollapsed}
    class="workspace"
    style={`--sidebar:${widths.sidebar}px; --files:${widths.files}px`}
  >
    {#if !navCollapsed}
      <RepoSidebar
        repos={recent}
        {query}
        selectedPath={opened?.summary.path ?? null}
        {theme}
        disabled={writeLocked}
        {workspaceView}
        workspaceEnabled={opened !== null}
        {changeCount}
        {conflictCount}
        onView={navigate}
        onQuery={(value) => (query = value)}
        onSelect={openRecent}
        onForget={forget}
        onShowPath={copyPath}
        onTheme={changeTheme}
        onAdd={addRepo}
        onClone={() => (dialog = "clone")}
        onCreate={chooseCreate}
      />
      <div
        class="resizer"
        role="slider"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="调整仓库列表宽度"
        aria-valuemin={160}
        aria-valuemax={560}
        aria-valuenow={widths.sidebar}
        onpointerdown={(event) => startResize(event, "sidebar")}
        onkeydown={(event) => resizeKey(event, "sidebar")}
      ></div>
    {/if}
    <main class="content">
      {#if opened}
        <div class="view-heading">
          <div class="view-heading-copy">
            <div class="view-title-line">
              <h1>{viewInfo.title}</h1>
              {#if workspaceView === "changes" && changeCount > 0}<span class="count">{changeCount}</span>{/if}
              {#if workspaceView === "merge" && conflictCount > 0}<span class="count danger">{conflictCount}</span>{/if}
            </div>
            <p>{viewInfo.description}</p>
          </div>
          <div class="view-heading-status" title={syncText}>
            <span class={`status-orb ${remoteState}`}></span>
            <span>{remoteState === "live" ? "远程状态已检查" : remoteState === "stale" ? "远程状态待更新" : "本地工作区"}</span>
          </div>
        </div>
        <div class="view-body" class:view-changes={workspaceView === "changes"}>
          {#if workspaceView === "history"}
            {#if historyPanel}
              {#await historyPanel}
                <div class="view-loading"><span class="spinner"></span></div>
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
                />
              {/await}
            {/if}
          {:else if workspaceView === "merge"}
            {#if mergePanel}
              {#await mergePanel}
                <div class="view-loading"><span class="spinner"></span></div>
              {:then module}
                <module.default
                  {opened}
                  focusPath={conflictFocus}
                  disabled={writeLocked}
                  {nextId}
                  onGeneration={adoptGeneration}
                  onSnapshot={applySnapshot}
                  onFailure={handleMutationError}
                  onNotice={(message) => {
                    phaseNote = message;
                    live = message;
                    banner = null;
                  }}
                  onOpenStash={() => useView("stash")}
                  onOpenChanges={showChanges}
                />
              {/await}
            {/if}
          {:else if workspaceView === "stash"}
            {#if stashPanel}
              {#await stashPanel}
                <div class="view-loading"><span class="spinner"></span></div>
              {:then module}
                <module.default
                  {opened}
                  disabled={writeLocked}
                  {nextId}
                  onGeneration={adoptGeneration}
                  onSnapshot={applySnapshot}
                  onFailure={handleMutationError}
                  onNotice={(message) => {
                    phaseNote = message;
                    live = message;
                    banner = null;
                  }}
                  onOpenChanges={openConflict}
                />
              {/await}
            {/if}
          {:else}
            <div class="changes">
              <section class="files" aria-label="改动与提交">
                <div class="pane-head">
                  <span class="pane-title">本地改动</span>
                  <span class="spacer"></span>
                  <RecoveryActions
                    {opened}
                    disabled={writeLocked}
                    {nextId}
                    onSnapshot={applySnapshot}
                    onFailure={handleMutationError}
                    onNotice={(message) => {
                      phaseNote = message;
                      live = message;
                      banner = null;
                    }}
                    onMerge={() => useView("merge")}
                  />
                </div>
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
                />
                <CommitDraft
                  branch={branchText}
                  scope={scope.label}
                  paths={scope.paths}
                  value={draft}
                  disabled={writeLocked}
                  busy={pending}
                  onInput={onDraftInput}
                  onBlur={() => void flushDraft(drafts.path)}
                  onCommit={commitLocal}
                  onCommitPush={commitAndPush}
                />
              </section>
              <div
                class="resizer"
                role="slider"
                tabindex="0"
                aria-orientation="vertical"
                aria-label="调整文件列表宽度"
                aria-valuemin={160}
                aria-valuemax={560}
                aria-valuenow={widths.files}
                onpointerdown={(event) => startResize(event, "files")}
                onkeydown={(event) => resizeKey(event, "files")}
              ></div>
              <DiffView
                selection={selected}
                {diff}
                error={diffError}
                loading={diffLoading}
                disabled={writeLocked}
                onStageHunk={stageHunk}
                onLoadMore={loadMoreDiff}
                onFileHistory={openFileHistory}
              />
            </div>
          {/if}
        </div>
      {:else}
        <Welcome
          {recent}
          disabled={writeLocked}
          onAdd={addRepo}
          onClone={() => (dialog = "clone")}
          onCreate={chooseCreate}
          onOpen={openRecent}
        />
      {/if}
    </main>
  </div>
  <footer class="statusbar">
    <span class="sb-item sb-live" class:sb-busy={pending !== null || reading} title={live}>
      {#if pending !== null || reading}<span class="spinner"></span>{/if}
      {live}
    </span>
    {#if opened}
      {#if degraded}
        <span class="sb-item sb-warn" title="文件监听不可用，窗口在前台时低频重新读取">
          <Icon name="alert" size={12} />低频刷新
        </span>
      {/if}
      <span class="sb-item" title={syncText}>
        <span class={`sb-dot ${remoteState === "live" ? "" : remoteState}`}></span>
        <span class="truncate">{syncText}</span>
      </span>
    {/if}
    {#if git?.available && git.version}
      <span class="sb-item" title={git.path ?? ""}>Git {git.version}</span>
    {/if}
    <button type="button" class="sb-item" onclick={() => (dependencyOpen = true)}>
      <Icon name="package" size={12} />运行依赖
    </button>
  </footer>
</div>

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

<RepoDialogs
  mode={dialog}
  {opened}
  disabled={writeLocked}
  onClose={() => (dialog = null)}
  onBusy={(name) => (pending = name)}
  onSnapshot={applySnapshot}
  onOpened={(repo) => {
    banner = null;
    rememberOpened(repo);
  }}
  onFailure={handleMutationError}
  onNotice={(message) => {
    phaseNote = message;
    live = message;
    banner = null;
  }}
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
