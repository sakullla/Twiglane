<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import {
    canCompleteMerge,
    conflictKindLabel,
    operationCaption,
    showMergeAbort,
  } from "../resolve";
  import type {
    BranchRecord,
    ConflictView,
    MergeSession,
    OpenedRepository,
    StatusSnapshot,
  } from "../types";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
  }

  let {
    opened,
    disabled,
    nextId,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
  }: Props = $props();

  let session = $state<MergeSession | null>(null);
  let branches = $state<BranchRecord[]>([]);
  let source = $state("");
  let view = $state<ConflictView | null>(null);
  let resultText = $state("");
  let message = $state("合并分支");
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let aborting = $state(false);
  let abortNote = $state("");
  let abortPaths = $state<string[]>([]);
  let loadedKey = "";

  let blocked = $derived(disabled || busy);
  let choices = $derived(
    branches.filter((branch) => !branch.current && branch.name !== opened.snapshot.branch.name),
  );

  $effect(() => {
    const key = `${opened.summary.path}:${opened.generation}`;
    if (key === loadedKey) return;
    loadedKey = key;
    void loadSession();
  });

  async function loadSession() {
    errorText = null;
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
      onGeneration(preview.generation);
      if (!preview.canStart) {
        errorText = preview.note;
        return;
      }
      const started = await api.startMerge(opened.summary.path, branch, preview.generation, nextId());
      session = started;
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
      onSnapshot(next.snapshot);
      onNotice(`${selected.path} 已按所选方式标记。其他冲突保持不变。`);
      view = next.conflicts.some((entry) => entry.path === selected.path) ? view : null;
    });
  }

  function complete() {
    const current = session;
    if (!current || !canCompleteMerge(current.operation, current.unresolved)) return;
    const kept = message;
    void run(async () => {
      const done = await api.completeMerge(opened.summary.path, kept, current.generation, nextId());
      message = "合并分支";
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
      onSnapshot(impact.snapshot);
      onNotice(impact.note);
      session = await api.mergeSession(opened.summary.path, impact.generation, nextId());
      view = null;
    });
  }
</script>

<section class="span-main" aria-label="分支合并">
  <div class="panel-toolbar">
    <strong>{operationCaption(session?.operation ?? "none")}</strong>
    <span class="spacer"></span>
    {#if session && showMergeAbort(session.operation, session.canAbort)}
      <button type="button" class="danger compact" disabled={blocked} onclick={askAbort}>中止合并</button>
    {/if}
  </div>
  <div class="stash-body">
    <p>{session?.note ?? "正在读取合并状态。"}</p>
    {#if session?.operation === "none"}
      <label>
        来源分支
        <select aria-label="来源分支" bind:value={source} disabled={blocked}>
          {#each choices as branch (branch.name)}
            <option value={branch.name}>{branch.remote ? `远程 ${branch.name}` : branch.name}</option>
          {/each}
        </select>
      </label>
      <p class="hint">目标是当前分支 {opened.snapshot.branch.name ?? "当前分支"}。有本地改动时会先引导临时保存，不会开始合并。</p>
      <div class="row">
        <button type="button" class="primary" disabled={blocked || source.trim() === ""} onclick={previewMerge}>预览并合并</button>
        <button type="button" class="ghost" disabled={blocked} onclick={onOpenStash}>去临时保存</button>
      </div>
    {:else if session?.operation === "merge"}
      <p class="hint">来源 {session.source ?? "另一分支"}，目标 {session.target ?? "当前分支"}。未解决时不能完成。</p>
      <div class="chip-row" aria-label="冲突文件">
        {#each session.conflicts as entry (entry.path)}
          <button type="button" class="ghost compact" disabled={blocked} onclick={() => openConflict(entry.path)}>
            {conflictKindLabel(entry.kind)} {entry.path}
          </button>
        {/each}
      </div>
      {#if view}
        <h2 class="section-label">{conflictKindLabel(view.kind)} · {view.path}</h2>
        <p>{view.note}</p>
        <div class="conflict-grid">
          <div>
            <strong>本地版本</strong>
            <pre class="full-value">{view.ours.text ?? view.ours.summary}</pre>
          </div>
          <div>
            <strong>另一分支版本</strong>
            <pre class="full-value">{view.theirs.text ?? view.theirs.summary}</pre>
          </div>
          <div>
            <strong>合并结果</strong>
            {#if view.editable}
              <textarea aria-label="合并结果" bind:value={resultText} disabled={blocked}></textarea>
            {:else}
              <pre class="full-value">{view.result.text ?? view.result.summary}</pre>
            {/if}
          </div>
        </div>
        <div class="row">
          {#if view.editable}
            <button type="button" class="primary" disabled={blocked} onclick={() => resolve("text")}>标记编辑结果</button>
          {/if}
          {#if view.ours.present && view.kind !== "delete_modify"}
            <button type="button" class="ghost" disabled={blocked} onclick={() => resolve("ours")}>保留本地版本</button>
          {/if}
          {#if view.theirs.present && view.kind !== "modify_delete"}
            <button type="button" class="ghost" disabled={blocked} onclick={() => resolve("theirs")}>采用另一分支版本</button>
          {/if}
          {#if view.kind === "modify_delete" || view.kind === "delete_modify" || view.kind === "both_deleted"}
            <button type="button" class="danger" disabled={blocked} onclick={() => resolve("delete")}>接受删除</button>
          {/if}
        </div>
      {/if}
      <label>
        合并说明
        <textarea aria-label="合并说明" bind:value={message} disabled={blocked}></textarea>
      </label>
      <p class="hint">完成只会提交已经标记的合并结果，不会推送。失败时说明和已标记内容都会保留。</p>
      <button
        type="button"
        class="primary"
        disabled={blocked || !canCompleteMerge(session.operation, session.unresolved) || message.trim() === ""}
        onclick={complete}
      >完成合并</button>
      {#if session.unresolved > 0}
        <p class="hint">还有 {session.unresolved} 个未解决冲突，不能完成合并。</p>
      {/if}
    {:else if session?.operation === "unmerged"}
      <p class="hint">请到改动或临时保存处理这些文件。这里不会把它当成可以中止的分支合并。</p>
      <button type="button" class="ghost" disabled={blocked} onclick={onOpenStash}>查看临时保存</button>
    {/if}
    {#if errorText}
      <div class="banner" role="alert">{errorText}</div>
    {/if}
  </div>
  {#if aborting}
    <div class="modal-backdrop" role="presentation">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="abort-merge-title">
        <h2 id="abort-merge-title">中止合并</h2>
        <p>{abortNote}</p>
        {#if abortPaths.length > 0}
          <ul class="scope-list">
            {#each abortPaths as path (path)}
              <li title={path}>{path}</li>
            {/each}
          </ul>
        {/if}
        <div class="row">
          <button type="button" class="ghost" onclick={() => (aborting = false)}>取消</button>
          <span class="spacer"></span>
          <button type="button" class="danger" disabled={blocked} onclick={confirmAbort}>确认中止</button>
        </div>
      </div>
    </div>
  {/if}
</section>
