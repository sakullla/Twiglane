<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { formatAuthoredAt, shortOid, stashPathBadge } from "../history";
  import type { OpenedRepository, StashApplyResult, StashRecord, StashState, StatusSnapshot } from "../types";
  import { relativeTime } from "../ui";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenChanges: (path: string) => void;
    /** 作为任务 modal 的内容时不再自带整页面板外框与滚动容器。 */
    embedded?: boolean;
  }

  let {
    opened,
    disabled,
    nextId,
    onGeneration,
    onSnapshot,
    onFailure,
    onNotice,
    onOpenChanges,
    embedded = false,
  }: Props = $props();

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

  /** 写操作失败后按最新状态重读列表：失败提示之外，界面要反映仓库里真实存在的记录。 */
  async function reloadAfterFailure(repo: string) {
    try {
      const fresh = await api.stashState(repo, includeUntracked, opened.generation, nextId());
      if (opened.summary.path === repo) stash = fresh;
    } catch {
      // 重读失败不覆盖原有错误提示。
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
        await reloadAfterFailure(repo);
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
        await reloadAfterFailure(repo);
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
        await reloadAfterFailure(repo);
      }
    });
  }
</script>

<section class={embedded ? "" : "span-main"} aria-label="临时保存" data-panel="stash">
  <div class="panel-scroll stash-body">
    <div class="panel-inner">
      <div class="card">
        <div class="card-head">
          <span class="ch-icon"><Icon name="archive" size={15} /></span>
          <h2>新建临时保存</h2>
          <span class="spacer"></span>
          <label class="switch">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={busy || disabled}
              onchange={(event) => (includeUntracked = (event.currentTarget as HTMLInputElement).checked)}
            />
            包含未跟踪文件
          </label>
        </div>
        <div class="card-body">
          <p>{preview?.summary ?? "正在确认将保存的范围。"}</p>
          {#if preview}
            <div class="path-chips" aria-label="保存范围">
              {#each preview.trackedPaths as path (path)}
                <span class="chip save" title={path}>{stashPathBadge("tracked", includeUntracked)} {path}</span>
              {/each}
              {#each preview.untrackedPaths as path (path)}
                <span class={`chip ${includeUntracked ? "save" : "skip"}`} title={path}>{stashPathBadge("untracked", includeUntracked)} {path}</span>
              {/each}
              {#each preview.ignoredPaths as path (path)}
                <span class="chip ignore" title={path}>{stashPathBadge("ignored", includeUntracked)} {path}</span>
              {/each}
            </div>
            {#if preview.trackedCount > preview.trackedPaths.length || preview.untrackedCount > preview.untrackedPaths.length || preview.ignoredCount > preview.ignoredPaths.length}
              <p class="hint">路径较多，这里只列出一部分。数量以上面的说明为准。</p>
            {/if}
          {/if}
        </div>
        <div class="card-foot">
          <input
            class="input"
            aria-label="临时保存说明"
            placeholder="可选说明，例如：先放一放的实验"
            value={message}
            disabled={busy || disabled}
            oninput={(event) => (message = (event.currentTarget as HTMLInputElement).value)}
            onkeydown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
          <button type="button" class="btn btn-primary" disabled={disabled || busy || !preview?.canSave} onclick={save}>
            {#if busy}<span class="spinner"></span>{:else}<Icon name="archive" size={14} />{/if}
            临时保存
          </button>
        </div>
      </div>

      {#if errorText}
        <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
      {/if}
      {#if applied}
        <div class={`callout ${applied.conflicted ? "warn" : "ok"}`} role="status">
          <Icon name={applied.conflicted ? "alert" : "check-circle"} size={15} />
          <div class="callout-body">
            <p>{applied.note}</p>
            {#if applied.kept}<p>记录 {shortOid(applied.oid)} 仍保留。</p>{/if}
            {#if applied.conflicted}
              <div class="row">
                {#each applied.conflictPaths as path (path)}
                  <button type="button" class="btn btn-secondary btn-sm" onclick={() => onOpenChanges(path)}>查看冲突 {path}</button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="card">
        <div class="card-head">
          <span class="ch-icon info"><Icon name="layers" size={15} /></span>
          <h2>已有记录</h2>
          {#if stash}<span class="count">{stash.records.length}</span>{/if}
          <span class="spacer"></span>
        </div>
        {#if stash && stash.records.length === 0}
          <div class="empty compact" role="status">
            <span class="empty-icon"><Icon name="archive" size={22} /></span>
            <strong>还没有临时保存记录</strong>
            <p>保存前会先说明已跟踪、未跟踪和忽略文件的范围。没有可保存的内容时不会创建记录。</p>
          </div>
        {/if}
        <div class="stash-list">
          {#each stash?.records ?? [] as record (record.oid)}
            <div class="stash-record">
              <span class="sr-icon"><Icon name="archive" size={15} /></span>
              <div class="sr-main">
                <strong class:untitled={!record.message}>{record.message || "未填写说明"}</strong>
                <span class="hint" title={`${record.oid}\n${formatAuthoredAt(record.committedAt)}`}>
                  <span class="mono">{shortOid(record.oid)}</span> · {relativeTime(record.committedAt)}
                </span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" disabled={disabled || busy} onclick={() => restore(record.oid)}>恢复</button>
              <button type="button" class="btn btn-danger-soft btn-sm" disabled={disabled || busy} onclick={() => askDelete(record)}>删除</button>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
  {#if confirmRecord}
    <Modal
      title="删除临时保存"
      titleId="stash-delete-title"
      icon="trash"
      tone="danger"
      size="sm"
      description="删除后 Git 不再保留这条记录，本应用不能恢复。取消不会删除，工作区也不会改变。"
      onClose={cancelDelete}
    >
      <ul class="scope-list" aria-label="受影响的临时保存记录">
        <li title={confirmRecord.oid}>
          {shortOid(confirmRecord.oid)} · {confirmRecord.message || "未填写说明"} · {formatAuthoredAt(confirmRecord.committedAt)}
        </li>
      </ul>
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" onclick={cancelDelete}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-danger" onclick={confirmDelete}>确认删除</button>
      {/snippet}
    </Modal>
  {/if}
</section>
