<script lang="ts">
  import { api } from "../api";
  import { createTextDiff } from "../diff";
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
  import DiffView from "./DiffView.svelte";
  import Icon from "./Icon.svelte";
  import MergeSetup from "./MergeSetup.svelte";
  import Modal from "./Modal.svelte";
  import ThreeWayMerge from "./ThreeWayMerge.svelte";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
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
  }

  let {
    opened,
    focusPath = null,
    disabled,
    nextId,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
    embedded = false,
  }: Props = $props();

  let session = $state<MergeSession | null>(null);
  let branches = $state<BranchRecord[]>([]);
  let source = $state("");
  let view = $state<ConflictView | null>(null);
  let resultText = $state("");
  let sourceMode = $state<"diff" | "source">("source");
  let message = $state("合并分支");
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let aborting = $state(false);
  let abortNote = $state("");
  let abortPaths = $state<string[]>([]);
  let pendingPreview = $state<MergePreview | null>(null);
  let resolvedPaths = $state<string[]>([]);
  let loadedKey = "";
  let loadedRepo = "";
  let openedFocus = "";
  let autoOpenedKey = "";

  let blocked = $derived(disabled || busy);
  let activeStep = $derived(session?.operation === "none" ? 0 : session?.unresolved === 0 ? 2 : 1);
  let conflictTotal = $derived((session?.unresolved ?? 0) + resolvedPaths.length);
  let resolvedPercent = $derived(conflictTotal > 0 ? Math.round((resolvedPaths.length / conflictTotal) * 100) : 0);
  let comparisonDiff = $derived(
    view && view.ours.text !== null && view.theirs.text !== null && !view.ours.truncated && !view.theirs.truncated
      ? createTextDiff(view.path, view.theirs.text, view.ours.text, view.generation)
      : null,
  );
  let diffSelection = $derived(view ? { path: view.path, side: "unstaged" as const } : null);

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

  function resolve(choice: string) {
    const current = session;
    const selected = view;
    if (!current || !selected) return;
    void run(async () => {
      const next = await api.resolveConflict(
        opened.summary.path,
        selected.path,
        choice,
        choice === "text" ? resultText : null,
        current.generation,
        nextId(),
      );
      session = next;
      if (!next.conflicts.some((entry) => entry.path === selected.path)) {
        resolvedPaths = [...new Set([...resolvedPaths, selected.path])];
      }
      onSnapshot(next.snapshot);
      if (next.conflicts.some((entry) => entry.path === selected.path)) {
        view = selected;
      } else if (next.conflicts[0]) {
        const nextView = await api.conflictView(opened.summary.path, next.conflicts[0].path, next.generation, nextId());
        view = nextView;
        resultText = nextView.result.text ?? "";
        sourceMode = "source";
        onGeneration(nextView.generation);
        onNotice(`${selected.path} 已标记为已解决，已打开下一个冲突。`);
      } else {
        view = null;
        onNotice(`${selected.path} 已标记为已解决，所有冲突均已处理。`);
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
      onSnapshot(impact.snapshot);
      onNotice(impact.note);
      session = await api.mergeSession(opened.summary.path, impact.generation, nextId());
      view = null;
    });
  }
</script>

<section class={embedded ? "" : "span-main"} aria-label="分支合并" data-panel="merge">
  <div class="panel-toolbar">
    <span class="panel-title"><Icon name="merge" size={16} /><strong>{operationCaption(session?.operation ?? "none")}</strong></span>
    {#if session && session.unresolved > 0}<span class="count danger" title="未解决冲突">{session.unresolved}</span>{/if}
    <span class="spacer"></span>
    {#if session && showMergeAbort(session.operation, session.canAbort)}
      <button type="button" class="btn btn-danger-soft btn-sm" disabled={blocked} onclick={askAbort}><Icon name="x" size={14} />中止合并</button>
    {/if}
  </div>

  {#if !session || session.operation === "none" || session.operation === "merge" || session.operation === "unmerged"}
    <div class="merge-steps" aria-label="合并进度">
      {#each ["选择与预览", "解决冲突", session?.operation === "unmerged" ? "提交改动" : "完成合并"] as label, index (label)}
        <div class="merge-step" class:active={activeStep === index} class:done={activeStep > index}>
          <span class="merge-step-index">{#if activeStep > index}<Icon name="check" size={11} />{:else}{index + 1}{/if}</span>
          <span>{label}</span>
        </div>
        {#if index < 2}<span class="merge-step-line" class:done={activeStep > index}></span>{/if}
      {/each}
    </div>
  {/if}

  <div class="panel-scroll stash-body">
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
      {:else if session?.operation === "merge" || session?.operation === "unmerged"}
        <div class="merge-status-card">
          <div class="merge-route">
            <span class="merge-route-branch source"><Icon name="branch" size={13} />{session.source ?? "未合并改动"}</span>
            <Icon name="chevron-right" size={14} />
            <span class="merge-route-branch target"><Icon name="branch" size={13} />{session.target ?? "当前分支"}</span>
          </div>
          <div class="merge-resolution-count">
            <strong>{session.unresolved}</strong><span>个待处理</span>
            {#if resolvedPaths.length > 0}<span class="resolved-count">已标记 {resolvedPaths.length}</span>{/if}
          </div>
          {#if conflictTotal > 0}
            <div class="merge-progress" role="progressbar" aria-label="冲突处理进度" aria-valuemin={0} aria-valuemax={conflictTotal} aria-valuenow={resolvedPaths.length}>
              <span style={`width:${resolvedPercent}%`}></span>
            </div>
          {/if}
        </div>

        <div class="card merge-resolver-card">
          <div class="merge-resolver-layout">
            <aside class="conflict-sidebar" aria-label="冲突文件列表">
              <div class="conflict-sidebar-head"><span>冲突文件</span><span class="count">{session.conflicts.length}</span></div>
              <div class="conflict-files">
                {#each session.conflicts as entry (entry.path)}
                  {@const parts = splitPath(entry.path)}
                  <button
                    type="button"
                    class="conflict-file"
                    aria-label={`${conflictKindLabel(entry.kind)} ${entry.path}`}
                    aria-pressed={view?.path === entry.path}
                    disabled={blocked}
                    onclick={() => openConflict(entry.path)}
                  >
                    <span class="conflict-file-icon"><Icon name="alert" size={13} /></span>
                    <span class="conflict-file-copy"><strong>{parts.name}</strong><small>{parts.dir || conflictKindLabel(entry.kind)}</small></span>
                    <Icon name="chevron-right" size={12} />
                  </button>
                {/each}
                {#each resolvedPaths as path (path)}
                  {@const parts = splitPath(path)}
                  <div class="conflict-file resolved">
                    <span class="conflict-file-icon"><Icon name="check-circle" size={13} /></span>
                    <span class="conflict-file-copy"><strong>{parts.name}</strong><small>{parts.dir || "已标记"}</small></span>
                    <span class="chip current">已标记</span>
                  </div>
                {/each}
              </div>
              {#if session.conflicts.length === 0 && resolvedPaths.length === 0}<p class="hint conflict-empty-note">所有冲突都已标记。</p>{/if}
              <div class="conflict-sidebar-foot"><Icon name="info" size={12} />逐个检查并标记，已标记文件会保留。</div>
            </aside>

            <div class="conflict-editor">
              {#if view}
                <div class="conflict-editor-head">
                  <div><span class="section-kicker">正在解决</span><h2 class="truncate mono" title={view.path}>{view.path}</h2></div>
                  <span class="chip">{conflictKindLabel(view.kind)}</span>
                </div>
                <div class="conflict-editor-subhead">
                  <p class="conflict-editor-note">{view.note}</p>
                  <div class="segmented" role="group" aria-label="冲突查看方式">
                    <button type="button" aria-pressed={sourceMode === "source"} onclick={() => (sourceMode = "source")}><Icon name="split" size={11} />三方合并</button>
                    <button type="button" aria-pressed={sourceMode === "diff"} disabled={!comparisonDiff} onclick={() => (sourceMode = "diff")}><Icon name="file-diff" size={11} />差异对比</button>
                  </div>
                </div>
                {#if sourceMode === "diff" && comparisonDiff}
                  <div class="comparison-diff">
                    <DiffView selection={diffSelection} diff={comparisonDiff} error={null} loading={false} disabled={true} readOnly={true} onStageHunk={() => {}} onLoadMore={() => {}} />
                  </div>
                {:else}
                  <ThreeWayMerge
                    {view}
                    {resultText}
                    disabled={blocked}
                    onResult={(value) => (resultText = value)}
                    onChoice={applyTextChoice}
                    onResolve={resolve}
                    onReset={() => (resultText = view?.result.text ?? "")}
                  />
                {/if}
              {:else}
                <div class="empty conflict-picker-empty">
                  <span class={`empty-icon ${session.unresolved === 0 ? "ok" : ""}`}><Icon name={session.unresolved === 0 ? "check-circle" : "file-diff"} size={23} /></span>
                  <strong>{session.unresolved === 0 ? "所有冲突都已标记" : "选择一个冲突文件"}</strong>
                  <p>{session.unresolved === 0 ? "已标记的内容会保留。检查最终状态后，再继续完成当前操作。" : "从左侧选择文件，对照当前分支与来源分支版本，再编辑最终结果。"}</p>
                </div>
              {/if}
            </div>
          </div>
        </div>

        {#if session.operation === "merge"}
          <div class="card merge-complete-card">
            <div class="merge-complete-copy">
              <span class="ch-icon"><Icon name="commit" size={15} /></span>
              <div><h2>完成合并</h2><p class="hint">完成只会提交已经标记的合并结果，不会推送。</p></div>
            </div>
            <div class="merge-complete-form">
              <label class="sr-only" for="merge-message">合并说明</label>
              <textarea id="merge-message" class="textarea" aria-label="合并说明" bind:value={message} disabled={blocked}></textarea>
              <button type="button" class="btn btn-primary" disabled={blocked || !canCompleteMerge(session.operation, session.unresolved) || message.trim() === ""} onclick={complete}>
                <Icon name="check" size={14} />完成合并
              </button>
            </div>
            {#if session.unresolved > 0}
              <div class="merge-complete-warning"><Icon name="alert" size={13} />还有 {session.unresolved} 个未解决冲突，不能完成合并。</div>
            {:else}
              <div class="merge-complete-ready"><Icon name="check-circle" size={13} />冲突已全部处理，完成前请检查合并说明和结果。</div>
            {/if}
          </div>
        {:else}
          <div class="callout">
            <Icon name="info" size={15} />
            <div class="callout-body"><span>标记后的文件可以在改动区提交。临时保存记录不会被删除。</span><div><button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={onOpenStash}>查看临时保存</button></div></div>
          </div>
        {/if}
      {/if}
      {#if errorText}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>{/if}
    </div>
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
      <p class="hint">中止后这次合并的解决结果会被撤销，不能由这里找回。取消则保持当前合并状态。</p>
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
