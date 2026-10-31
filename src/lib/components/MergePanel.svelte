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
    MergePreview,
    MergeSession,
    OpenedRepository,
    StatusSnapshot,
  } from "../types";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

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
  let pendingPreview = $state<MergePreview | null>(null);
  let loadedKey = "";
  let openedFocus = "";

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
      pendingPreview = preview;
      onGeneration(preview.generation);
      if (session) session = { ...session, generation: preview.generation };
    });
  }

  function confirmStart() {
    const preview = pendingPreview;
    if (!preview?.canStart) return;
    void run(async () => {
      const started = await api.startMerge(
        opened.summary.path,
        preview.source,
        preview.generation,
        nextId(),
      );
      pendingPreview = null;
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
    <span class="panel-title">
      <Icon name="merge" size={16} />
      <strong>{operationCaption(session?.operation ?? "none")}</strong>
    </span>
    {#if session && session.unresolved > 0}
      <span class="count danger" title="未解决冲突">{session.unresolved}</span>
    {/if}
    <span class="spacer"></span>
    {#if session && showMergeAbort(session.operation, session.canAbort)}
      <button type="button" class="btn btn-danger-soft btn-sm" disabled={blocked} onclick={askAbort}>
        <Icon name="x" size={14} />中止合并
      </button>
    {/if}
  </div>
  <div class="panel-scroll stash-body">
    <div class="panel-inner">
      <div class={`callout ${session && session.operation !== "none" ? "warn" : "info"}`}>
        <Icon name={session && session.operation !== "none" ? "alert" : "info"} size={15} />
        <span>{session?.note ?? "正在读取合并状态。"}</span>
      </div>

      {#if session?.operation === "none"}
        <div class="card">
          <div class="card-head">
            <span class="ch-icon purple"><Icon name="merge" size={15} /></span>
            <h2>合并到当前分支</h2>
          </div>
          <div class="card-body">
            <div class="merge-flow">
              <div class="form-group">
                <label class="label" for="merge-source">来源分支</label>
                <select
                  id="merge-source"
                  class="select"
                  aria-label="来源分支"
                  bind:value={source}
                  disabled={blocked}
                  onchange={() => (pendingPreview = null)}
                >
                  {#each choices as branch (branch.name)}
                    <option value={branch.name}>{branch.remote ? `远程 ${branch.name}` : branch.name}</option>
                  {/each}
                </select>
              </div>
              <span class="arrow"><Icon name="chevron-right" size={18} /></span>
              <div class="form-group" style="flex: none">
                <span class="label">目标（当前分支）</span>
                <span class="merge-target" title={opened.snapshot.branch.name ?? "当前分支"}>
                  <Icon name="branch" size={14} /><span>{opened.snapshot.branch.name ?? "当前分支"}</span>
                </span>
              </div>
            </div>
            <p class="hint">目标是当前分支 {opened.snapshot.branch.name ?? "当前分支"}。确认前不会开始合并。</p>
            {#if pendingPreview}
              <div class={`callout ${pendingPreview.canStart ? "ok" : "warn"}`} aria-label="合并预览">
                <Icon name={pendingPreview.canStart ? "check-circle" : "alert"} size={15} />
                <div class="callout-body">
                  <p>来源 {pendingPreview.source}，目标 {pendingPreview.target}。</p>
                  {#if pendingPreview.localPaths.length === 0}
                    <p>当前没有未提交改动。</p>
                  {:else}
                    <ul class="scope-list" aria-label="本地改动">
                      {#each pendingPreview.localPaths as path (path)}
                        <li title={path}>{path}</li>
                      {/each}
                    </ul>
                  {/if}
                  <p>{pendingPreview.note}</p>
                </div>
              </div>
            {/if}
          </div>
          <div class="card-foot">
            <button type="button" class="btn btn-ghost" disabled={blocked} onclick={onOpenStash}>
              <Icon name="archive" size={14} />去临时保存
            </button>
            <span class="spacer"></span>
            <button type="button" class="btn btn-secondary" disabled={blocked || source.trim() === ""} onclick={previewMerge}>
              <Icon name="eye" size={14} />预览合并
            </button>
            {#if pendingPreview?.canStart}
              <button type="button" class="btn btn-primary" disabled={blocked} onclick={confirmStart}>
                <Icon name="merge" size={14} />确认开始合并
              </button>
            {/if}
          </div>
        </div>
      {:else if session?.operation === "merge" || session?.operation === "unmerged"}
        <div class="card">
          <div class="card-head">
            <span class="ch-icon danger"><Icon name="alert" size={15} /></span>
            <h2>冲突文件</h2>
            <span class="count">{session.conflicts.length}</span>
            <span class="spacer"></span>
            {#if session.operation === "merge"}
              <span class="hint">来源 {session.source ?? "另一分支"} → 目标 {session.target ?? "当前分支"}</span>
            {/if}
          </div>
          <div class="card-body">
            {#if session.operation === "merge"}
              <p class="hint">来源 {session.source ?? "另一分支"}，目标 {session.target ?? "当前分支"}。未解决时不能完成。</p>
            {:else}
              <p class="hint">这些未合并文件可以逐个编辑、选择一侧或处理修改/删除。这不是分支合并，不能中止，也不会调用中止合并。</p>
            {/if}
            {#if session.conflicts.length > 0}
              <div class="conflict-files" aria-label="冲突文件">
                {#each session.conflicts as entry (entry.path)}
                  <button
                    type="button"
                    class="conflict-file"
                    aria-pressed={view?.path === entry.path}
                    disabled={blocked}
                    onclick={() => openConflict(entry.path)}
                  >{conflictKindLabel(entry.kind)} {entry.path}</button>
                {/each}
              </div>
            {:else}
              <p class="hint">所有冲突都已标记。</p>
            {/if}
          </div>
        </div>

        {#if view}
          <div class="card">
            <div class="card-head">
              <span class="ch-icon warn"><Icon name="file-diff" size={15} /></span>
              <h2 class="truncate mono" title={view.path}>{view.path}</h2>
              <span class="chip">{conflictKindLabel(view.kind)}</span>
            </div>
            <div class="card-body">
              <p>{view.note}</p>
              <div class="conflict-grid">
                <div class="conflict-pane ours">
                  <div class="conflict-pane-head"><span class="dot"></span>本地版本</div>
                  <pre>{view.ours.text ?? view.ours.summary}</pre>
                </div>
                <div class="conflict-pane theirs">
                  <div class="conflict-pane-head"><span class="dot"></span>另一分支版本</div>
                  <pre>{view.theirs.text ?? view.theirs.summary}</pre>
                </div>
                <div class="conflict-pane result">
                  <div class="conflict-pane-head"><span class="dot"></span>合并结果{#if view.editable}<span class="spacer"></span><Icon name="pencil" size={12} />{/if}</div>
                  {#if view.editable}
                    <textarea aria-label="合并结果" bind:value={resultText} disabled={blocked} spellcheck="false"></textarea>
                  {:else}
                    <pre>{view.result.text ?? view.result.summary}</pre>
                  {/if}
                </div>
              </div>
            </div>
            <div class="card-foot">
              {#if view.ours.present && view.kind !== "delete_modify"}
                <button type="button" class="btn btn-secondary" disabled={blocked} onclick={() => resolve("ours")}>保留本地版本</button>
              {/if}
              {#if view.theirs.present && view.kind !== "modify_delete"}
                <button type="button" class="btn btn-secondary" disabled={blocked} onclick={() => resolve("theirs")}>采用另一分支版本</button>
              {/if}
              {#if view.kind === "modify_delete" || view.kind === "delete_modify" || view.kind === "both_deleted"}
                <button type="button" class="btn btn-danger-soft" disabled={blocked} onclick={() => resolve("delete")}>接受删除</button>
              {/if}
              <span class="spacer"></span>
              {#if view.editable}
                <button type="button" class="btn btn-primary" disabled={blocked} onclick={() => resolve("text")}>
                  <Icon name="check" size={14} />标记编辑结果
                </button>
              {/if}
            </div>
          </div>
        {/if}

        {#if session.operation === "merge"}
          <div class="card">
            <div class="card-head">
              <span class="ch-icon"><Icon name="commit" size={15} /></span>
              <h2>完成合并</h2>
            </div>
            <div class="card-body">
              <div class="form-group">
                <label class="label" for="merge-message">合并说明</label>
                <textarea id="merge-message" class="textarea" aria-label="合并说明" bind:value={message} disabled={blocked}></textarea>
              </div>
              <p class="hint">完成只会提交已经标记的合并结果，不会推送。失败时说明和已标记内容都会保留。</p>
              {#if session.unresolved > 0}
                <div class="callout warn"><Icon name="alert" size={15} /><span>还有 {session.unresolved} 个未解决冲突，不能完成合并。</span></div>
              {/if}
            </div>
            <div class="card-foot">
              <span class="spacer"></span>
              <button
                type="button"
                class="btn btn-primary"
                disabled={blocked || !canCompleteMerge(session.operation, session.unresolved) || message.trim() === ""}
                onclick={complete}
              >完成合并</button>
            </div>
          </div>
        {:else}
          <div class="callout">
            <Icon name="info" size={15} />
            <div class="callout-body">
              <span>标记后的文件可以在改动区提交。临时保存记录不会被删除。</span>
              <div><button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={onOpenStash}>查看临时保存</button></div>
            </div>
          </div>
        {/if}
      {/if}
      {#if errorText}
        <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
      {/if}
    </div>
  </div>
  {#if aborting}
    <Modal title="中止合并" titleId="abort-merge-title" icon="alert" tone="danger" description={abortNote} onClose={() => (aborting = false)}>
      {#if abortPaths.length > 0}
        <ul class="scope-list">
          {#each abortPaths as path (path)}
            <li title={path}>{path}</li>
          {/each}
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
