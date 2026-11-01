<script module lang="ts">
  import type { ConflictDraft } from "../conflict";

  /**
   * 逐处处理的草稿在模块级保存：关掉合并 modal、切换文件再回来都不会丢。
   * 键是「仓库路径 + 文件路径」，恢复时由 ConflictResolver 校验工作区内容未变，
   * 外部改过文件或已经写入后，旧草稿自动作废。只在内存里，不落盘。
   */
  const conflictDrafts = new Map<string, ConflictDraft>();
  const conflictProgress = new Map<string, { total: number; done: number }>();

  export function clearConflictDrafts(): void {
    conflictDrafts.clear();
    conflictProgress.clear();
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
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
  import MergeSetup from "./MergeSetup.svelte";
  import Modal from "./Modal.svelte";
  import ThreeWayMerge from "./ThreeWayMerge.svelte";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
    /** 预选的来源分支（从分支菜单「合并到当前分支」进入）。 */
    initialSource?: string | null;
    disabled: boolean;
    nextId: () => number;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
    /** 作为任务 modal 的内容时不再自带整页面板外框。 */
    embedded?: boolean;
    /** 提供时在底部操作条放一个「关闭」，与完成合并同一行，不再单独占一条 modal 底栏。 */
    onClose?: () => void;
  }

  let {
    opened,
    focusPath = null,
    initialSource = null,
    disabled,
    nextId,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
    embedded = false,
    onClose,
  }: Props = $props();

  let session = $state<MergeSession | null>(null);
  let branches = $state<BranchRecord[]>([]);
  let source = $state(untrack(() => initialSource ?? ""));
  let view = $state<ConflictView | null>(null);
  let resultText = $state("");
  let message = $state("合并分支");
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let aborting = $state(false);
  let abortNote = $state("");
  let abortPaths = $state<string[]>([]);
  let pendingPreview = $state<MergePreview | null>(null);
  let resolvedPaths = $state<string[]>([]);
  let fileFilter = $state("");
  let progressTick = $state(0);
  let loadedKey = "";
  let loadedRepo = "";
  let openedFocus = "";
  let autoOpenedKey = "";

  let blocked = $derived(disabled || busy);
  let active = $derived(session?.operation === "merge" || session?.operation === "unmerged");
  let activeStep = $derived(session?.operation === "none" ? 0 : session?.unresolved === 0 ? 2 : 1);
  let conflictTotal = $derived((session?.unresolved ?? 0) + resolvedPaths.length);
  let resolvedPercent = $derived(conflictTotal > 0 ? Math.round((resolvedPaths.length / conflictTotal) * 100) : 0);
  let currentLabel = $derived(session?.target ?? opened.snapshot.branch.name ?? "当前分支");
  let incomingLabel = $derived(session?.source ?? (session?.operation === "unmerged" ? "另一侧" : "来源分支"));
  let filteredConflicts = $derived(
    (session?.conflicts ?? []).filter((entry) => entry.path.toLowerCase().includes(fileFilter.trim().toLowerCase())),
  );

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
      if (!source) {
        source =
          listed.branches.find((branch) => !branch.current && !branch.remote)?.name ??
          listed.branches.find((branch) => !branch.current)?.name ??
          "";
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

  function previewMerge() {
    const current = session;
    const branch = source.trim();
    if (!current || !branch) return;
    void run(async () => {
      const preview = await api.mergePreview(opened.summary.path, branch, current.generation, nextId());
      pendingPreview = preview;
      onGeneration(preview.generation);
      if (session) session = { ...session, generation: preview.generation };
    });
  }

  function confirmStart() {
    const preview = pendingPreview;
    if (!preview?.canStart) return;
    void run(async () => {
      const started = await api.startMerge(opened.summary.path, preview.source, preview.generation, nextId());
      pendingPreview = null;
      session = started;
      resolvedPaths = [];
      onSnapshot(started.snapshot);
      onNotice(started.note);
      view = null;
    });
  }

  function openConflict(path: string) {
    const current = session;
    if (!current) return;
    if (view?.path === path) return;
    void run(async () => {
      const next = await api.conflictView(opened.summary.path, path, current.generation, nextId());
      view = next;
      resultText = next.result.text ?? "";
      onGeneration(next.generation);
    });
  }

  $effect(() => {
    const path = focusPath;
    const current = session;
    if (!path || !current) return;
    if (current.operation !== "merge" && current.operation !== "unmerged") return;
    const key = `${current.generation}:${path}`;
    if (openedFocus === key) return;
    if (!current.conflicts.some((entry) => entry.path === path)) return;
    openedFocus = key;
    openConflict(path);
  });

  $effect(() => {
    const current = session;
    if (!current || view || busy) return;
    const first = current.conflicts[0];
    if (!first) return;
    const key = `${opened.summary.path}:${current.generation}:${first.path}`;
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
    const current = session;
    const selected = view;
    if (!current || !selected) return;
    const text = choice === "text" ? (content ?? resultText) : null;
    void run(async () => {
      const next = await api.resolveConflict(opened.summary.path, selected.path, choice, text, current.generation, nextId());
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
    const current = session;
    if (!current || !canCompleteMerge(current.operation, current.unresolved)) return;
    const kept = message;
    void run(async () => {
      const done = await api.completeMerge(opened.summary.path, kept, current.generation, nextId());
      message = "合并分支";
      resolvedPaths = [];
      onSnapshot(done.snapshot);
      onNotice(done.summary);
      session = await api.mergeSession(opened.summary.path, done.generation, nextId());
      view = null;
    });
  }

  function askAbort() {
    const current = session;
    if (!current || !showMergeAbort(current.operation, current.canAbort)) return;
    void run(async () => {
      const impact = await api.abortMerge(opened.summary.path, false, current.generation, nextId());
      abortNote = impact.note;
      abortPaths = impact.paths;
      aborting = true;
      onGeneration(impact.generation);
      if (session) session = { ...session, generation: impact.generation };
    });
  }

  function confirmAbort() {
    const current = session;
    if (!current) return;
    void run(async () => {
      const impact = await api.abortMerge(opened.summary.path, true, current.generation, nextId());
      aborting = false;
      resolvedPaths = [];
      for (const path of impact.paths) {
        conflictDrafts.delete(draftKey(path));
        conflictProgress.delete(draftKey(path));
      }
      onSnapshot(impact.snapshot);
      onNotice(impact.note);
      session = await api.mergeSession(opened.summary.path, impact.generation, nextId());
      view = null;
    });
  }

  const STEPS = ["选择与预览", "解决冲突", "完成合并"];
</script>

<section class={`merge-panel ${embedded ? "embedded" : "span-main"}`} aria-label="分支合并" data-panel="merge">
  <div class="mp-head">
    <span class="panel-title"><Icon name="merge" size={16} /><strong>{operationCaption(session?.operation ?? "none")}</strong></span>
    {#if session && active && (session.source || session.target)}
      <span class="merge-route" title={`把 ${incomingLabel} 合并到 ${currentLabel}`}>
        <span class="merge-route-branch source"><Icon name="branch" size={12} />{incomingLabel}</span>
        <Icon name="arrow-right" size={13} />
        <span class="merge-route-branch target"><Icon name="branch" size={12} />{currentLabel}</span>
      </span>
    {/if}
    <span class="spacer"></span>
    {#if !session || session.operation === "none" || active}
      <ol class="merge-steps" aria-label="合并进度">
        {#each STEPS as label, index (label)}
          <li class="merge-step" class:active={activeStep === index} class:done={activeStep > index}>
            <span class="merge-step-index">{#if activeStep > index}<Icon name="check" size={10} />{:else}{index + 1}{/if}</span>
            <span>{index === 2 && session?.operation === "unmerged" ? "提交改动" : label}</span>
          </li>
        {/each}
      </ol>
    {/if}
    {#if session && showMergeAbort(session.operation, session.canAbort)}
      <button type="button" class="btn btn-danger-soft btn-sm" disabled={blocked} onclick={askAbort}><Icon name="x" size={14} />中止合并</button>
    {/if}
  </div>

  {#if session && active}
    <div class="mp-note" title={session.note}>
      <Icon name="info" size={13} /><span class="truncate">{session.note}</span>
    </div>
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
            <p>{session.unresolved === 0 ? "已标记的内容会保留。检查最终状态后，再继续完成当前操作。" : "从左侧选择文件，逐处对照当前与来源，再决定最终结果。"}</p>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="panel-scroll mp-scroll">
      <div class="panel-inner merge-panel-inner">
        <div class={`callout merge-operation-note ${session && session.operation !== "none" ? "warn" : "info"}`}>
          <Icon name={session && session.operation !== "none" ? "alert" : "info"} size={15} />
          <span>{session?.note ?? "正在读取合并状态。"}</span>
        </div>
        {#if session?.operation === "none"}
          <MergeSetup
            {opened}
            {branches}
            {source}
            preview={pendingPreview}
            blocked={blocked}
            onSource={(value) => {
              source = value;
              pendingPreview = null;
            }}
            onPreview={previewMerge}
            onStart={confirmStart}
            {onOpenStash}
            {onOpenChanges}
          />
        {/if}
      </div>
    </div>
  {/if}

  {#if errorText}
    <div class="callout error mp-error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
  {/if}

  {#if (session && active) || onClose}
    <div class="mp-foot">
      {#if session?.operation === "merge"}
        <label class="sr-only" for="merge-message">合并说明</label>
        <textarea
          id="merge-message"
          class="textarea mp-message"
          aria-label="合并说明"
          rows="1"
          placeholder="合并说明"
          bind:value={message}
          disabled={blocked}
        ></textarea>
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
      {#if onClose}<button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>{/if}
      {#if session?.operation === "merge"}
        <button
          type="button"
          class="btn btn-primary"
          disabled={blocked || !canCompleteMerge(session.operation, session.unresolved) || message.trim() === ""}
          onclick={complete}
        >
          <Icon name="check" size={14} />完成合并
        </button>
      {/if}
    </div>
  {/if}

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
