<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { formatAuthoredAt, shortOid, stashPathBadge } from "../history";
  import type { OpenedRepository, StashApplyResult, StashRecord, StashState, StatusSnapshot } from "../types";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenChanges: (path: string) => void;
  }

  let { opened, disabled, nextId, onGeneration, onSnapshot, onFailure, onNotice, onOpenChanges }: Props = $props();

  let includeUntracked = $state(false);
  let message = $state("");
  let stash = $state<StashState | null>(null);
  let applied = $state<StashApplyResult | null>(null);
  let errorText = $state<string | null>(null);
  let busy = $state(false);
  let confirmRecord = $state<StashRecord | null>(null);

  let preview = $derived(stash?.preview ?? null);

  $effect(() => {
    const repo = opened.summary.path;
    const generation = opened.generation;
    const include = includeUntracked;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.stashState(repo, include, generation, nextId());
        if (cancelled || opened.summary.path !== repo) return;
        stash = result;
        errorText = null;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        errorText = failure.message;
        onFailure(failure);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  async function callWithStale<T>(run: (generation: number) => Promise<T>, generation: number): Promise<T> {
    try {
      return await run(generation);
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
        return await run(failure.generation);
      }
      throw error;
    }
  }

  async function withBusy(action: () => Promise<void>) {
    if (busy || disabled) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
  }

  function save() {
    const current = stash;
    if (!current?.preview.canSave) return;
    const repo = opened.summary.path;
    const generation = opened.generation;
    const include = includeUntracked;
    const note = message;
    void withBusy(async () => {
      try {
        const result = await callWithStale(
          (gen) => api.saveStash(repo, include, note, gen, nextId()),
          generation,
        );
        if (opened.summary.path !== repo) return;
        stash = result.state;
        applied = null;
        errorText = null;
        onSnapshot(result.state.snapshot);
        onNotice(result.note);
      } catch (error) {
        const failure = normalizeError(error);
        errorText = failure.message;
        onFailure(failure);
      }
    });
  }

  function restore(oid: string) {
    const repo = opened.summary.path;
    const generation = opened.generation;
    void withBusy(async () => {
      try {
        const result = await callWithStale((gen) => api.applyStash(repo, oid, gen, nextId()), generation);
        if (opened.summary.path !== repo) return;
        applied = result;
        errorText = null;
        onSnapshot(result.snapshot);
        onNotice(result.note);
        stash = await api.stashState(repo, includeUntracked, result.generation, nextId());
      } catch (error) {
        const failure = normalizeError(error);
        errorText = failure.message;
        onFailure(failure);
      }
    });
  }

  function askDelete(record: StashRecord) {
    confirmRecord = record;
  }

  function cancelDelete() {
    confirmRecord = null;
  }

  function confirmDelete() {
    const record = confirmRecord;
    if (!record) return;
    confirmRecord = null;
    const repo = opened.summary.path;
    const generation = opened.generation;
    void withBusy(async () => {
      try {
        const result = await callWithStale(
          (gen) => api.deleteStash(repo, record.oid, true, gen, nextId()),
          generation,
        );
        if (opened.summary.path !== repo) return;
        stash = result;
        errorText = null;
        onSnapshot(result.snapshot);
        onNotice(`已删除临时保存 ${shortOid(record.oid)}。`);
      } catch (error) {
        const failure = normalizeError(error);
        errorText = failure.message;
        onFailure(failure);
      }
    });
  }
</script>

<section class="span-main" aria-label="临时保存">
  <div class="stash-body">
    <p>{preview?.summary ?? "正在确认将保存的范围。"}</p>
    <label class="row">
      <input
        type="checkbox"
        checked={includeUntracked}
        disabled={busy || disabled}
        onchange={(event) => (includeUntracked = (event.currentTarget as HTMLInputElement).checked)}
      />
      包含未跟踪文件
    </label>
    <p class="hint">忽略文件不会保存。未勾选时，未跟踪文件也不进入这次临时保存。</p>
    {#if preview}
      <div class="chip-row" aria-label="保存范围">
        {#each preview.trackedPaths as path (path)}
          <span class="chip" title={path}>{stashPathBadge("tracked", includeUntracked)} {path}</span>
        {/each}
        {#each preview.untrackedPaths as path (path)}
          <span class="chip skip" title={path}>{stashPathBadge("untracked", includeUntracked)} {path}</span>
        {/each}
        {#each preview.ignoredPaths as path (path)}
          <span class="chip ignore" title={path}>{stashPathBadge("ignored", includeUntracked)} {path}</span>
        {/each}
      </div>
      {#if preview.trackedCount > preview.trackedPaths.length || preview.untrackedCount > preview.untrackedPaths.length || preview.ignoredCount > preview.ignoredPaths.length}
        <p class="hint">路径较多，这里只列出一部分。数量以保存前的说明为准。</p>
      {/if}
    {/if}
    <input
      class="text-input"
      aria-label="临时保存说明"
      placeholder="可选说明"
      value={message}
      disabled={busy || disabled}
      oninput={(event) => (message = (event.currentTarget as HTMLInputElement).value)}
    />
    <div class="row">
      <button type="button" class="primary" disabled={disabled || busy || !preview?.canSave} onclick={save}>临时保存</button>
    </div>
    {#if errorText}
      <div class="banner" role="alert">{errorText}</div>
    {/if}
    {#if applied}
      <div class="banner ok" role="status">
        <p>{applied.note}</p>
        {#if applied.kept}<p>记录 {shortOid(applied.oid)} 仍保留。</p>{/if}
        {#if applied.conflicted}
          <div class="row">
            {#each applied.conflictPaths as path (path)}
              <button type="button" class="ghost compact" onclick={() => onOpenChanges(path)}>查看冲突 {path}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <h2 class="section-label">已有记录</h2>
    <p class="hint">恢复会把改动放回工作区并保留记录。删除需要确认，并在执行前再次核验记录身份。</p>
    {#if stash && stash.records.length === 0}
      <div class="empty" role="status">
        <strong>还没有临时保存记录</strong>
        <p>保存前会先说明已跟踪、未跟踪和忽略文件的范围。没有可保存的内容时不会创建记录。</p>
      </div>
    {/if}
    <div class="stash-list">
      {#each stash?.records ?? [] as record (record.oid)}
        <div class="stash-record">
          <div>
            <strong>{record.message || "未填写说明"}</strong>
            <div class="hint" title={record.oid}>{shortOid(record.oid)} · {formatAuthoredAt(record.committedAt)}</div>
          </div>
          <button type="button" class="ghost compact" disabled={disabled || busy} onclick={() => restore(record.oid)}>恢复</button>
          <button type="button" class="danger compact" disabled={disabled || busy} onclick={() => askDelete(record)}>删除</button>
        </div>
      {/each}
    </div>
  </div>
  {#if confirmRecord}
    <div class="modal-backdrop" role="presentation">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="stash-delete-title">
        <h2 id="stash-delete-title">删除临时保存</h2>
        <p>
          将删除 {shortOid(confirmRecord.oid)}。确认时会再次核验这条记录的身份。取消不会删除，工作区也不会改变。
        </p>
        <div class="row">
          <button type="button" class="ghost" onclick={cancelDelete}>取消</button>
          <span class="spacer"></span>
          <button type="button" class="danger" onclick={confirmDelete}>确认删除</button>
        </div>
      </div>
    </div>
  {/if}
</section>
