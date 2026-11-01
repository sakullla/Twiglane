<script module lang="ts">
  import type { ConflictDraft } from "../conflict";

  /**
   * 逐处处理的草稿在模块级保存：关掉合并 modal、切换文件再回来都不会丢。
   * 键是「仓库路径 + 文件路径」，恢复时由 ConflictResolver 校验工作区内容未变，
   * 外部改过文件或已经写入后，旧草稿自动作废。只在内存里，不落盘。
   */
  const conflictDrafts = new Map<string, ConflictDraft>();
  const conflictProgress = new Map<string, { total: number; done: number }>();
  /** 为了合并到别的分支而切换过来时，记住原来所在的分支（按仓库），完成后提供「切回」。 */
  const switchedFromByRepo = new Map<string, string>();
  /** 冲突处理期间填写的合并说明（按仓库），关掉 modal 再回来不丢。 */
  const messageByRepo = new Map<string, string>();

  export function clearConflictDrafts(): void {
    conflictDrafts.clear();
    conflictProgress.clear();
  }

  export function defaultMergeMessage(source: string, target: string, remote: boolean): string {
    if (!source || !target) return "";
    return remote ? `Merge remote-tracking branch '${source}' into ${target}` : `Merge branch '${source}' into ${target}`;
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { shortOid } from "../history";
  import { canCompleteMerge, conflictKindLabel, operationCaption, showMergeAbort } from "../resolve";
  import type {
    BranchRecord,
    ConflictView,
    MergePreview,
    MergeSession,
    OpenedRepository,
    StatusSnapshot,
  } from "../types";
  import { splitPath } from "../ui";
  import ConflictResolver from "./ConflictResolver.svelte";
  import Icon from "./Icon.svelte";
  import MergeSetup, { type MergeMode } from "./MergeSetup.svelte";
  import Modal from "./Modal.svelte";
  import ThreeWayMerge from "./ThreeWayMerge.svelte";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
    /** 预选的来源分支（从分支菜单「合并到当前分支」进入）。 */
    initialSource?: string | null;
    /** 预选的目标分支（从分支菜单「把当前分支合并到此分支」进入）。 */
    initialTarget?: string | null;
    disabled: boolean;
    nextId: () => number;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
    onOpenHistory?: () => void;
    /** 作为任务 modal 的内容时不再自带整页面板外框。 */
    embedded?: boolean;
    /** 提供时在底部操作条放一个「关闭」，与主操作同一行。 */
    onClose?: () => void;
  }

  let {
    opened,
    focusPath = null,
    initialSource = null,
    initialTarget = null,
    disabled,
    nextId,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
    onOpenHistory,
    embedded = false,
    onClose,
  }: Props = $props();

  interface Finished {
    source: string;
    target: string;
    fastForwarded: boolean;
    oid: string | null;
    commits: number;
    switchedFrom: string | null;
  }

  let session = $state<MergeSession | null>(null);
  let branches = $state<BranchRecord[]>([]);
  let source = $state(untrack(() => initialSource ?? ""));
  let target = $state(untrack(() => initialTarget ?? ""));
  let mode = $state<MergeMode>("merge");
  let setupMessage = $state("");
  let messageTouched = $state(false);
  let preview = $state<MergePreview | null>(null);
  let previewing = $state(false);
  let previewError = $state<string | null>(null);
  let previewNonce = $state(0);
  let finished = $state<Finished | null>(null);
  let view = $state<ConflictView | null>(null);
  let resultText = $state("");
  let message = $state(untrack(() => messageByRepo.get(opened.summary.path) ?? ""));
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let aborting = $state(false);
  let abortNote = $state("");
  let abortPaths = $state<string[]>([]);
  let resolvedPaths = $state<string[]>([]);
  let fileFilter = $state("");
  let progressTick = $state(0);
  let loadedKey = "";
  let loadedRepo = "";
  let openedFocus = "";
  let autoOpenedKey = "";
  let previewToken = 0;

  let blocked = $derived(disabled || busy);
  let current = $derived(opened.snapshot.branch.detached || opened.snapshot.branch.unborn ? null : opened.snapshot.branch.name);
  let active = $derived(session?.operation === "merge" || session?.operation === "unmerged");
  let external = $derived(Boolean(session && session.operation !== "none" && !active));
  let conflictTotal = $derived((session?.unresolved ?? 0) + resolvedPaths.length);
  let resolvedPercent = $derived(conflictTotal > 0 ? Math.round((resolvedPaths.length / conflictTotal) * 100) : 0);
  let currentLabel = $derived(session?.target ?? opened.snapshot.branch.name ?? "当前分支");
  let incomingLabel = $derived(session?.source ?? (session?.operation === "unmerged" ? "另一侧" : "来源分支"));
  let filteredConflicts = $derived(
    (session?.conflicts ?? []).filter((entry) => entry.path.toLowerCase().includes(fileFilter.trim().toLowerCase())),
  );
  let sourceRemote = $derived(branches.find((branch) => branch.name === source)?.remote ?? false);
  let readyPreview = $derived(preview && preview.source === source && preview.target === target ? preview : null);
  let switchedFrom = $derived.by(() => {
    void progressTick;
    return switchedFromByRepo.get(opened.summary.path) ?? null;
  });

  function draftKey(path: string): string {
    return `${opened.summary.path}\u0000${path}`;
  }

  function fileProgress(path: string): { total: number; done: number } | null {
    void progressTick;
    return conflictProgress.get(draftKey(path)) ?? null;
  }

  $effect(() => {
    const key = `${opened.summary.path}:${opened.generation}`;
    if (key === loadedKey) return;
    loadedKey = key;
    void loadSession();
  });

  /** 没有预选时的默认方向：用主干更新当前分支（最常见），否则选第一个其他本地分支。 */
  function defaultSource(listed: BranchRecord[], into: string | null): string {
    const local = listed.filter((branch) => !branch.remote && branch.name !== into);
    const base = ["main", "master", "develop", "dev", "trunk"].find((name) => local.some((branch) => branch.name === name));
    return base ?? local[0]?.name ?? listed.find((branch) => branch.name !== into && !branch.name.endsWith("/HEAD"))?.name ?? "";
  }

  async function loadSession() {
    errorText = null;
    if (loadedRepo !== opened.summary.path) {
      loadedRepo = opened.summary.path;
      resolvedPaths = [];
      view = null;
    }
    try {
      const [next, listed] = await Promise.all([
        api.mergeSession(opened.summary.path, opened.generation, nextId()),
        api.branchState(opened.summary.path, opened.generation, nextId()),
      ]);
      if (loadedKey !== `${opened.summary.path}:${opened.generation}` && session) return;
      session = next;
      branches = listed.branches;
      onGeneration(next.generation);
      const here = next.snapshot.branch.detached || next.snapshot.branch.unborn ? null : next.snapshot.branch.name;
      if (!target) target = here ?? listed.branches.find((branch) => !branch.remote)?.name ?? "";
      if (!source) {
        source = initialTarget && here && here !== target ? here : defaultSource(listed.branches, target);
      }
      if (!message && next.operation === "merge") {
        message = next.source && next.target ? defaultMergeMessage(next.source, next.target, next.source.includes("/")) : "合并分支";
      }
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    }
  }

  async function run(action: () => Promise<void>) {
    if (blocked) return;
    busy = true;
    errorText = null;
    try {
      await action();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  // 两端选定后自动做只读检查（防抖），不需要用户再点「检查」。
  $effect(() => {
    const from = source.trim();
    const into = target.trim();
    const state = session;
    void previewNonce;
    if (!state || state.operation !== "none" || finished || !from || !into) return;
    const generation = opened.generation;
    const repo = opened.summary.path;
    const token = ++previewToken;
    previewing = true;
    previewError = null;
    const timer = setTimeout(async () => {
      try {
        const result = await api.mergePreview(repo, from, into === current ? null : into, generation, nextId());
        if (token !== previewToken) return;
        preview = result;
        if (result.generation !== generation) onGeneration(result.generation);
        if (mode === "ff-only" && !result.fastForward) mode = "merge";
      } catch (error) {
        if (token !== previewToken) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined) {
          onGeneration(failure.generation);
          return;
        }
        preview = null;
        previewError = failure.message;
      } finally {
        if (token === previewToken) previewing = false;
      }
    }, 180);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (messageTouched) return;
    setupMessage = defaultMergeMessage(source, target, sourceRemote);
  });

  function setSource(value: string) {
    source = value;
    preview = null;
  }

  function setTarget(value: string) {
    target = value;
    preview = null;
  }

  function swap() {
    if (sourceRemote) return;
    const from = source;
    source = target;
    target = from;
    preview = null;
  }

  function pick(from: string, into: string) {
    source = from;
    target = into;
    preview = null;
  }

  function confirmStart() {
    const checked = readyPreview;
    if (!checked?.canStart) return;
    const repo = opened.summary.path;
    const chosenMode: MergeMode = mode === "ff-only" && checked.fastForward ? "ff-only" : "merge";
    const note = setupMessage.trim() || defaultMergeMessage(checked.source, checked.target, sourceRemote);
    void run(async () => {
      const started = await api.startMerge(
        repo,
        checked.source,
        checked.needsSwitch ? checked.target : null,
        chosenMode,
        checked.generation,
        nextId(),
      );
      if (started.switchedFrom) {
        switchedFromByRepo.set(repo, started.switchedFrom);
        progressTick += 1;
      }
      onSnapshot(started.snapshot);
      resolvedPaths = [];
      view = null;
      preview = null;
      if (started.fastForwarded) {
        session = started;
        finished = {
          source: checked.source,
          target: checked.target,
          fastForwarded: true,
          oid: started.snapshot.branch.headOid,
          commits: checked.incoming,
          switchedFrom: started.switchedFrom ?? null,
        };
        onNotice(`已把 ${checked.target} 快进到 ${checked.source}。`);
        return;
      }
      if (started.operation === "merge" && started.unresolved === 0) {
        const done = await api.completeMerge(repo, note, started.generation, nextId());
        onSnapshot(done.snapshot);
        session = await api.mergeSession(repo, done.generation, nextId());
        finished = {
          source: checked.source,
          target: checked.target,
          fastForwarded: false,
          oid: done.oid,
          commits: checked.incoming,
          switchedFrom: started.switchedFrom ?? null,
        };
        onNotice(done.summary);
        return;
      }
      message = note;
      messageByRepo.set(repo, note);
      session = started;
      onNotice(started.note);
    });
  }

  function switchBack() {
    const back = switchedFrom;
    if (!back) return;
    const repo = opened.summary.path;
    void run(async () => {
      const state = await api.switchBranch(repo, back, opened.generation, nextId());
      switchedFromByRepo.delete(repo);
      progressTick += 1;
      onSnapshot(state.snapshot);
      onNotice(`已切回 ${back}。`);
      if (finished) finished = { ...finished, switchedFrom: null };
    });
  }

  function startOver() {
    finished = null;
    preview = null;
    messageTouched = false;
    source = defaultSource(branches, current);
    target = current ?? target;
  }

  function openConflict(path: string) {
    const state = session;
    if (!state) return;
    if (view?.path === path) return;
    void run(async () => {
      const next = await api.conflictView(opened.summary.path, path, state.generation, nextId());
      view = next;
      resultText = next.result.text ?? "";
      onGeneration(next.generation);
    });
  }

  $effect(() => {
    const path = focusPath;
    const state = session;
    if (!path || !state) return;
    if (state.operation !== "merge" && state.operation !== "unmerged") return;
    const key = `${state.generation}:${path}`;
    if (openedFocus === key) return;
    if (!state.conflicts.some((entry) => entry.path === path)) return;
    openedFocus = key;
    openConflict(path);
  });

  $effect(() => {
    const state = session;
    if (!state || view || busy) return;
    const first = state.conflicts[0];
    if (!first) return;
    const key = `${opened.summary.path}:${state.generation}:${first.path}`;
    if (autoOpenedKey === key) return;
    autoOpenedKey = key;
    openConflict(first.path);
  });

  function applyTextChoice(choice: "ours" | "theirs" | "both") {
    if (!view?.editable) return;
    const ours = view.ours.text ?? "";
    const theirs = view.theirs.text ?? "";
    if (choice === "ours") resultText = ours;
    else if (choice === "theirs") resultText = theirs;
    else {
      const combined = [ours.trimEnd(), theirs.trimEnd()].filter((part) => part.length > 0).join("\n");
      resultText = combined.length > 0 ? `${combined}\n` : "";
    }
  }

  function storeDraft(path: string, draft: ConflictDraft, progress: { total: number; done: number }) {
    const key = draftKey(path);
    conflictDrafts.set(key, draft);
    const previous = conflictProgress.get(key);
    if (previous?.total !== progress.total || previous?.done !== progress.done) {
      conflictProgress.set(key, progress);
      progressTick += 1;
    }
  }

  function resolve(choice: string, content?: string) {
    const state = session;
    const selected = view;
    if (!state || !selected) return;
    const text = choice === "text" ? (content ?? resultText) : null;
    void run(async () => {
      const next = await api.resolveConflict(opened.summary.path, selected.path, choice, text, state.generation, nextId());
      session = next;
      const stillConflicted = next.conflicts.some((entry) => entry.path === selected.path);
      if (!stillConflicted) {
        resolvedPaths = [...new Set([...resolvedPaths, selected.path])];
        conflictDrafts.delete(draftKey(selected.path));
        conflictProgress.delete(draftKey(selected.path));
        progressTick += 1;
      }
      onSnapshot(next.snapshot);
      if (stillConflicted) {
        view = selected;
      } else if (next.conflicts[0]) {
        const nextView = await api.conflictView(opened.summary.path, next.conflicts[0].path, next.generation, nextId());
        view = nextView;
        resultText = nextView.result.text ?? "";
        onGeneration(nextView.generation);
        onNotice(`${selected.path} 已标记为已解决，已打开下一个冲突文件。`);
      } else {
        view = null;
        onNotice(`${selected.path} 已标记为已解决，所有冲突文件均已处理。`);
      }
    });
  }

  function complete() {
    const state = session;
    if (!state || !canCompleteMerge(state.operation, state.unresolved)) return;
    const kept = message;
    const repo = opened.summary.path;
    const from = state.source ?? incomingLabel;
    const into = state.target ?? currentLabel;
    const count = conflictTotal;
    void run(async () => {
      const done = await api.completeMerge(repo, kept, state.generation, nextId());
      message = "";
      messageByRepo.delete(repo);
      resolvedPaths = [];
      onSnapshot(done.snapshot);
      onNotice(done.summary);
      session = await api.mergeSession(repo, done.generation, nextId());
      view = null;
      finished = { source: from, target: into, fastForwarded: false, oid: done.oid, commits: count, switchedFrom: switchedFromByRepo.get(repo) ?? null };
    });
  }

  function askAbort() {
    const state = session;
    if (!state || !showMergeAbort(state.operation, state.canAbort)) return;
    void run(async () => {
      const impact = await api.abortMerge(opened.summary.path, false, state.generation, nextId());
      abortNote = impact.note;
      abortPaths = impact.paths;
      aborting = true;
      onGeneration(impact.generation);
      if (session) session = { ...session, generation: impact.generation };
    });
  }

  function confirmAbort() {
    const state = session;
    if (!state) return;
    const repo = opened.summary.path;
    void run(async () => {
      const impact = await api.abortMerge(repo, true, state.generation, nextId());
      aborting = false;
      resolvedPaths = [];
      messageByRepo.delete(repo);
      message = "";
      for (const path of impact.paths) {
        conflictDrafts.delete(draftKey(path));
        conflictProgress.delete(draftKey(path));
      }
      onSnapshot(impact.snapshot);
      onNotice(impact.note);
      session = await api.mergeSession(repo, impact.generation, nextId());
      view = null;
      preview = null;
    });
  }

  function primaryLabel(checked: MergePreview | null): string {
    if (!checked) return "合并";
    if (!checked.canStart) return "合并";
    if (mode === "ff-only" && checked.fastForward) return `快进 ${checked.target}`;
    if (checked.conflictCheck === "conflicts") return "开始合并并解决冲突";
    return `合并到 ${checked.target}`;
  }
</script>

<section class={`merge-panel ${embedded ? "embedded" : "span-main"}`} aria-label="分支合并" data-panel="merge">
  {#if session && active}
    <div class="mp-head">
      <span class="merge-route" title={`把 ${incomingLabel} 合并到 ${currentLabel}`}>
        <span class="merge-route-branch source"><Icon name="branch" size={12} />{incomingLabel}</span>
        <span class="merge-route-arrow"><Icon name="arrow-right" size={14} /></span>
        <span class="merge-route-branch target"><Icon name="branch" size={12} />{currentLabel}</span>
      </span>
      {#if conflictTotal > 0}
        <span class="mp-progress-text">已解决 <strong>{resolvedPaths.length}</strong> / {conflictTotal} 个文件</span>
      {/if}
      <span class="spacer"></span>
      {#if showMergeAbort(session.operation, session.canAbort)}
        <button type="button" class="btn btn-danger-soft btn-sm" disabled={blocked} onclick={askAbort}><Icon name="x" size={14} />中止合并</button>
      {/if}
    </div>
    {#if session.operation === "unmerged"}
      <div class="mp-note" title={session.note}>
        <Icon name="info" size={13} /><span class="truncate">{session.note}</span>
      </div>
    {/if}
    <div class="mp-body">
      <aside class="conflict-sidebar" aria-label="冲突文件列表">
        <div class="conflict-sidebar-head">
          <span>冲突文件</span>
          {#if session.unresolved > 0}<span class="count danger" title="未解决冲突">{session.unresolved}</span>{/if}
          <span class="spacer"></span>
          {#if conflictTotal > 0}<span class="conflict-sidebar-ratio">{resolvedPaths.length}/{conflictTotal} 已标记</span>{/if}
        </div>
        {#if conflictTotal > 0}
          <div
            class="merge-progress"
            role="progressbar"
            aria-label="冲突处理进度"
            aria-valuemin={0}
            aria-valuemax={conflictTotal}
            aria-valuenow={resolvedPaths.length}
          >
            <span style={`width:${resolvedPercent}%`}></span>
          </div>
        {/if}
        {#if session.conflicts.length > 6}
          <div class="conflict-filter">
            <div class="field sm">
              <Icon name="search" size={13} />
              <input aria-label="筛选冲突文件" placeholder="筛选文件" autocomplete="off" spellcheck="false" bind:value={fileFilter} />
            </div>
          </div>
        {/if}
        <div class="conflict-files">
          {#each filteredConflicts as entry (entry.path)}
            {@const parts = splitPath(entry.path)}
            {@const progress = fileProgress(entry.path)}
            <button
              type="button"
              class="conflict-file"
              aria-label={`${conflictKindLabel(entry.kind)} ${entry.path}`}
              aria-pressed={view?.path === entry.path}
              disabled={blocked}
              title={entry.path}
              onclick={() => openConflict(entry.path)}
            >
              <span class="conflict-file-icon"><Icon name="alert" size={13} /></span>
              <span class="conflict-file-copy">
                <strong>{parts.name}</strong>
                <small>{parts.dir || conflictKindLabel(entry.kind)}</small>
              </span>
              {#if progress && progress.total > 0}
                <span class="conflict-file-progress" class:ok={progress.done === progress.total} title={`已处理 ${progress.done} / ${progress.total} 处`}>
                  {progress.done}/{progress.total}
                </span>
              {/if}
            </button>
          {/each}
          {#if filteredConflicts.length === 0 && session.conflicts.length > 0}
            <p class="hint conflict-empty-note">没有匹配的冲突文件。</p>
          {/if}
          {#each resolvedPaths as path (path)}
            {@const parts = splitPath(path)}
            <div class="conflict-file resolved" title={path}>
              <span class="conflict-file-icon"><Icon name="check-circle" size={13} /></span>
              <span class="conflict-file-copy"><strong>{parts.name}</strong><small>{parts.dir || "已标记"}</small></span>
              <span class="chip current">已标记</span>
            </div>
          {/each}
        </div>
        {#if session.conflicts.length === 0 && resolvedPaths.length === 0}<p class="hint conflict-empty-note">没有待处理的冲突文件。</p>{/if}
      </aside>

      <div class="conflict-editor">
        {#if view}
          <div class="conflict-editor-head">
            <span class="conflict-editor-icon"><Icon name="file-diff" size={15} /></span>
            <div class="conflict-editor-titles">
              <h2 class="truncate mono" title={view.path}>{view.path}</h2>
              <p class="conflict-editor-note truncate" title={view.note}>{view.note}</p>
            </div>
            <span class="chip">{conflictKindLabel(view.kind)}</span>
          </div>
          {#if view.editable}
            {#key `${view.path}:${view.generation}`}
              <ConflictResolver
                {view}
                {currentLabel}
                {incomingLabel}
                draft={conflictDrafts.get(draftKey(view.path)) ?? null}
                disabled={blocked}
                onDraft={(draft, progress) => view && storeDraft(view.path, draft, progress)}
                onResolve={resolve}
              />
            {/key}
          {:else}
            <div class="conflict-sides">
              <ThreeWayMerge
                {view}
                {resultText}
                {currentLabel}
                {incomingLabel}
                disabled={blocked}
                onResult={(value) => (resultText = value)}
                onChoice={applyTextChoice}
                onResolve={resolve}
                onReset={() => (resultText = view?.result.text ?? "")}
              />
            </div>
          {/if}
        {:else}
          <div class="empty conflict-picker-empty">
            <span class={`empty-icon ${session.unresolved === 0 ? "ok" : ""}`}><Icon name={session.unresolved === 0 ? "check-circle" : "file-diff"} size={23} /></span>
            <strong>{session.unresolved === 0 ? "所有冲突都已标记" : "选择一个冲突文件"}</strong>
            <p>{session.unresolved === 0 ? "检查无误后，在下方填写说明并完成合并。完成只在本地提交，不会推送。" : "从左侧选择文件，逐处对照两边的版本，再决定最终结果。"}</p>
          </div>
        {/if}
      </div>
    </div>
  {:else if finished}
    <div class="panel-scroll mp-scroll">
      <div class="merge-done" role="status">
        <span class="merge-done-icon"><Icon name="check" size={28} stroke={2.4} /></span>
        <h2>{finished.fastForwarded ? `已把 ${finished.target} 快进到 ${finished.source}` : `已把 ${finished.source} 合并到 ${finished.target}`}</h2>
        <p>
          {#if finished.fastForwarded}没有创建合并提交，{finished.target} 现在指向 {finished.oid ? shortOid(finished.oid) : "来源的最新提交"}。{:else}已创建合并提交{#if finished.oid}<code>{shortOid(finished.oid)}</code>{/if}。{/if}
          结果只在本地，尚未推送。
        </p>
        <div class="merge-done-actions">
          {#if finished.switchedFrom}
            <button type="button" class="btn btn-secondary" disabled={blocked} onclick={switchBack}><Icon name="arrow-left" size={14} />切回 {finished.switchedFrom}</button>
          {/if}
          {#if onOpenHistory}<button type="button" class="btn btn-secondary" onclick={onOpenHistory}><Icon name="history" size={14} />查看提交历史</button>{/if}
          <button type="button" class="btn btn-ghost" disabled={blocked} onclick={startOver}><Icon name="merge" size={14} />再合并一次</button>
        </div>
      </div>
    </div>
  {:else if external && session}
    <div class="panel-scroll mp-scroll">
      <div class="merge-external">
        <div class="callout warn merge-operation-note"><Icon name="alert" size={15} /><span><strong>{operationCaption(session.operation)}</strong>　{session.note}</span></div>
      </div>
    </div>
  {:else}
    <div class="panel-scroll mp-scroll">
      {#if session?.operation === "none"}
        {#if switchedFrom && switchedFrom !== current}
          <div class="merge-back-hint">
            <Icon name="info" size={14} />
            <span>上次为了合并从 <strong>{switchedFrom}</strong> 切换到了 <strong>{current}</strong>。</span>
            <button type="button" class="btn btn-ghost btn-sm" disabled={blocked} onclick={switchBack}>切回 {switchedFrom}</button>
          </div>
        {/if}
        <MergeSetup
          {branches}
          {current}
          {source}
          {target}
          {mode}
          message={setupMessage}
          {preview}
          {previewing}
          {previewError}
          {blocked}
          onSource={setSource}
          onTarget={setTarget}
          onSwap={swap}
          onPick={pick}
          onMode={(next) => (mode = next)}
          onMessage={(value) => {
            setupMessage = value;
            messageTouched = true;
          }}
          onRecheck={() => (previewNonce += 1)}
          {onOpenStash}
          {onOpenChanges}
        />
      {:else}
        <div class="empty" role="status"><span class="spinner"></span><strong>正在读取合并状态</strong></div>
      {/if}
    </div>
  {/if}

  {#if errorText}
    <div class="callout error mp-error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
  {/if}

  <div class="mp-foot">
    {#if session?.operation === "merge"}
      <label class="sr-only" for="merge-message">合并说明</label>
      <input
        id="merge-message"
        class="input mp-message"
        aria-label="合并说明"
        placeholder="合并说明"
        bind:value={message}
        oninput={() => messageByRepo.set(opened.summary.path, message)}
        disabled={blocked}
      />
      {#if session.unresolved > 0}
        <span class="mp-status warn"><Icon name="alert" size={13} />还有 {session.unresolved} 个未解决冲突，不能完成合并。</span>
      {:else}
        <span class="mp-status ok"><Icon name="check-circle" size={13} />冲突已全部处理，完成只会提交，不会推送。</span>
      {/if}
    {:else if session?.operation === "unmerged"}
      <span class="mp-status"><Icon name="info" size={13} />标记后的文件可以在改动区提交，临时保存记录不会被删除。</span>
      <button type="button" class="btn btn-ghost btn-sm" disabled={blocked} onclick={onOpenStash}>查看临时保存</button>
    {/if}
    <span class="spacer"></span>
    {#if onClose}<button type="button" class="btn btn-secondary" onclick={onClose}>{finished ? "完成" : "关闭"}</button>{/if}
    {#if session?.operation === "merge"}
      <button
        type="button"
        class="btn btn-primary"
        disabled={blocked || !canCompleteMerge(session.operation, session.unresolved) || message.trim() === ""}
        onclick={complete}
      >
        <Icon name="check" size={14} />完成合并
      </button>
    {:else if session?.operation === "none" && !finished}
      <button
        type="button"
        class="btn btn-primary"
        disabled={blocked || !readyPreview?.canStart || previewing || (mode === "merge" && setupMessage.trim() === "")}
        onclick={confirmStart}
      >
        {#if busy}<span class="spinner"></span>{:else}<Icon name="merge" size={14} />{/if}{primaryLabel(readyPreview)}
      </button>
    {/if}
  </div>

  {#if aborting}
    <Modal
      title="中止合并"
      titleId="abort-merge-title"
      icon="alert"
      tone="danger"
      description={abortNote}
      onClose={() => (aborting = false)}
    >
      <p class="hint">中止后这次合并的解决结果（包括这里尚未写入的逐处选择）会被撤销，不能由这里找回。取消则保持当前合并状态。</p>
      {#if abortPaths.length > 0}
        <ul class="scope-list" aria-label="受影响的路径">
          {#each abortPaths as path (path)}<li title={path}>{path}</li>{/each}
        </ul>
      {:else}
        <p>没有需要撤销的合并编辑。</p>
      {/if}
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" onclick={() => (aborting = false)}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-danger" disabled={blocked} onclick={confirmAbort}>确认中止</button>
      {/snippet}
    </Modal>
  {/if}
</section>
