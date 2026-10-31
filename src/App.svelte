<script lang="ts">
  import { onMount } from "svelte";
  import { api, listenEvent, pickDirectory, pickFile } from "./lib/api";
  import { BRAND, MODIFIER_LABEL } from "./lib/brand";
  import { finishDiffAttempt } from "./lib/diff";
  import { DraftBuffer } from "./lib/draft";
  import { normalizeError } from "./lib/errors";
  import { clampWidth, FALLBACK_POLL_MS, nudgeWidth, shouldPoll } from "./lib/layout";
  import { branchLabel, commitScope, gitInstallHint, retainSelection, selectionAfterEdit, syncLabel } from "./lib/labels";
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
  } from "./lib/types";
  import CommitDraft from "./lib/components/CommitDraft.svelte";
  import DetailDialog from "./lib/components/DetailDialog.svelte";
  import DiffView from "./lib/components/DiffView.svelte";
  import FileList from "./lib/components/FileList.svelte";
  import RepoSidebar from "./lib/components/RepoSidebar.svelte";

  let theme = $state<Theme>("light");
  let widths = $state<PanelWidths>({ sidebar: 280, files: 340 });
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
  let navCollapsed = $state(false);
  let detail = $state<{ title: string; value: string } | null>(null);
  let confirmPath = $state<string | null>(null);
  let degraded = $state(false);
  let windowFocused = $state(true);
  let requestSerial = 1;
  let diffToken = 0;
  let fileQuery = $state("");
  const drafts = new DraftBuffer();
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  let branchText = $derived(opened ? branchLabel(opened.snapshot.branch) : "未打开仓库");
  let syncText = $derived(opened ? syncLabel(opened.snapshot.branch) : "未检查远程");
  let scope = $derived(opened ? commitScope(branchText, opened.snapshot.files) : { label: "", paths: [] as string[] });

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
    selected = retainSelection(next.snapshot.files, selected);
    diff = null;
    diffError = null;
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

  function applySnapshot(snapshot: StatusSnapshot) {
    if (!opened) return;
    const previous = selected;
    opened = { ...opened, snapshot, generation: snapshot.generation };
    selected = selectionAfterEdit(snapshot.files, previous);
    void loadSelectedDiff();
  }

  function handleMutationError(error: unknown) {
    const failure = normalizeError(error);
    if (
      (failure.code === "stale" || failure.code === "stale_patch") &&
      failure.generation !== undefined &&
      opened
    ) {
      opened = { ...opened, generation: failure.generation };
      void refresh();
    }
    showError(failure);
  }

  async function stagePath(relative: string) {
    const current = opened;
    if (!current || pending) return;
    pending = "stage";
    live = "正在暂存文件";
    try {
      const snapshot = await api.stageFiles(current.summary.path, [relative], current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      banner = null;
      applySnapshot(snapshot);
      live = `已暂存 ${relative}`;
    } catch (error) {
      if (opened?.summary.path === current.summary.path) handleMutationError(error);
    } finally {
      pending = null;
    }
  }

  async function unstagePath(relative: string) {
    const current = opened;
    if (!current || pending) return;
    pending = "unstage";
    live = "正在取消暂存";
    try {
      const snapshot = await api.unstageFiles(current.summary.path, [relative], current.generation, nextId());
      if (opened?.summary.path !== current.summary.path) return;
      banner = null;
      applySnapshot(snapshot);
      live = `已取消暂存 ${relative}`;
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
    if (!current || !choice || !currentDiff || pending || !hunk.stageable) return;
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
    if (!current || !choice || !currentDiff || pending) return;
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
    if (!current || pending) return;
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

  async function addRepo() {
    if (pending) return;
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
    if (pending) return;
    const path = await pickDirectory("选择要新建仓库的目录");
    if (!path) return;
    confirmPath = path;
  }

  async function confirmCreate() {
    const path = confirmPath;
    if (!path || pending) return;
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
    pending = "open";
    live = "正在读取仓库状态";
    try {
      const openedRepo = await api.openRepository(path, nextId());
      banner = null;
      rememberOpened(openedRepo);
    } catch (error) {
      showError(error);
    } finally {
      pending = null;
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
      }
    } catch (error) {
      showError(error);
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
    void loadSettings();
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
    <button type="button" class="ghost" aria-expanded={!navCollapsed} onclick={() => (navCollapsed = !navCollapsed)}>
      {navCollapsed ? "展开导航" : "折叠导航"}
    </button>
    <div class="top-meta">
      <h1>{opened ? opened.summary.name : BRAND.name}</h1>
      <div class="top-path" title={opened?.summary.path ?? ""}>{opened ? opened.summary.path : BRAND.full}</div>
    </div>
    <div class="top-meta">
      <strong>{branchText}</strong>
      <div class="sync">{syncText}</div>
    </div>
    {#if opened}
      <button type="button" class="ghost" onclick={() => (detail = { title: "完整路径", value: opened?.summary.path ?? "" })}>查看完整路径</button>
      <button type="button" class="ghost" onclick={() => (detail = { title: "完整分支", value: branchText })}>查看完整分支</button>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="ghost" onclick={addRepo} disabled={pending !== null}>添加仓库</button>
    <button type="button" class="primary" onclick={chooseCreate} disabled={pending !== null}>新建仓库</button>
  </header>
  {#if banner}<div class="banner" role="alert">{banner}</div>{/if}
  {#if warning}<div class="banner warn" role="status">{warning}</div>{/if}
  {#if git && !git.available}
    <div class="banner" role="status">
      <strong>{git.message}</strong>
      <p>{gitInstallHint(navigator.platform ?? "")}</p>
      <div class="row">
        <button type="button" class="ghost" onclick={redetectGit}>重新检测</button>
        <button type="button" class="ghost" onclick={chooseGit}>选择 Git</button>
        {#if git.overridden}<button type="button" class="ghost" onclick={clearGit}>恢复自动检测</button>{/if}
      </div>
    </div>
  {:else if git?.belowBaseline}
    <div class="banner warn" role="status">{git.message}</div>
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
        onQuery={(value) => (query = value)}
        onSelect={openRecent}
        onForget={forget}
        onShowPath={(path) => (detail = { title: "完整路径", value: path })}
        onTheme={changeTheme}
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
    <section class="files" aria-label="改动与提交">
      {#if opened}
        <FileList
          files={opened.snapshot.files}
          {selected}
          query={fileQuery}
          disabled={pending !== null}
          onQuery={(value) => (fileQuery = value)}
          onSelect={selectFile}
          onStage={stagePath}
          onUnstage={unstagePath}
        />
        <CommitDraft
          branch={branchText}
          scope={scope.label}
          paths={scope.paths}
          value={draft}
          disabled={pending !== null}
          onInput={onDraftInput}
          onBlur={() => void flushDraft(drafts.path)}
          onCommit={commitLocal}
        />
      {:else}
        <div class="empty">
          <strong>打开一个仓库</strong>
          <p>{BRAND.full}。{BRAND.tagline} 添加已有目录只会检查它是不是仓库；新建会先确认，取消不会写入。</p>
          <p class="hint">搜索快捷键是 {MODIFIER_LABEL}+K。</p>
        </div>
      {/if}
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
      disabled={pending !== null}
      onStageHunk={stageHunk}
      onLoadMore={loadMoreDiff}
    />
  </div>
</div>

{#if detail}
  <DetailDialog title={detail.title} value={detail.value} onClose={() => (detail = null)} />
{/if}
{#if confirmPath}
  <DetailDialog
    title="新建仓库"
    value={confirmPath}
    body="将在此目录初始化 Git 仓库。已有文件不会被覆盖或删除。取消则不会做任何修改。"
    confirmLabel="初始化仓库"
    onClose={() => (confirmPath = null)}
    onConfirm={confirmCreate}
  />
{/if}
