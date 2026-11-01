<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { formatAuthoredAt, shortOid } from "../history";
  import type { OpenedRepository, StatusSnapshot, TagRecord, TagState } from "../types";
  import Icon from "./Icon.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    onBusy: (name: string | null) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenHistory: (query: string) => void;
    nextId: () => number;
  }

  let { opened, disabled, onBusy, onSnapshot, onFailure, onNotice, onOpenHistory, nextId }: Props = $props();

  let tags = $state<TagRecord[]>([]);
  let query = $state("");
  let name = $state("");
  let target = $state("HEAD");
  let message = $state("");
  let localBusy = $state(false);
  let errorText = $state<string | null>(null);
  let confirmTag = $state<TagRecord | null>(null);
  let copied = $state<string | null>(null);
  /** 标签读取的结果：只有真正读完才写入，写锁期间跳过的那次不算；失败不自动重读。 */
  let loaded = $state<{ key: string; ok: boolean } | null>(null);

  let blocked = $derived(disabled || localBusy);
  let remote = $derived(opened.snapshot.branch.upstream?.split("/")[0] || "origin");
  let visible = $derived(
    tags.filter((tag) => {
      const needle = query.trim().toLowerCase();
      return !needle || tag.name.toLowerCase().includes(needle) || tag.targetOid.toLowerCase().startsWith(needle) || tag.message.toLowerCase().includes(needle);
    }),
  );

  $effect(() => {
    if (loaded?.key === `${opened.summary.path}:${opened.generation}` || blocked) return;
    void loadTags();
  });

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    localBusy = true;
    errorText = null;
    onBusy("tag");
    try {
      return await action();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
      return undefined;
    } finally {
      localBusy = false;
      onBusy(null);
    }
  }

  function apply(result: TagState) {
    tags = result.tags;
    onSnapshot(result.snapshot);
  }

  async function loadTags() {
    const path = opened.summary.path;
    const key = `${path}:${opened.generation}`;
    const result = await run(async () => {
      try {
        const state = await api.tagState(path, opened.generation, nextId());
        loaded = { key, ok: true };
        return state;
      } catch (error) {
        loaded = { key, ok: false };
        throw error;
      }
    });
    if (result && opened.summary.path === path) apply(result);
  }

  async function create() {
    const current = opened;
    const tagName = name.trim();
    const tagTarget = target.trim() || "HEAD";
    const annotated = message.trim().length > 0;
    if (!tagName) return;
    const result = await run(() => api.createTag(current.summary.path, tagName, tagTarget, message.trim(), current.generation, nextId()));
    if (!result || opened.summary.path !== current.summary.path) return;
    apply(result);
    name = "";
    target = "HEAD";
    message = "";
    onNotice(`已创建标签 ${tagName}${annotated ? "（附注标签）" : ""}。`);
  }

  async function push(tag: TagRecord) {
    const current = opened;
    const result = await run(() => api.pushTag(current.summary.path, remote, tag.name, current.generation, nextId()));
    if (!result || opened.summary.path !== current.summary.path) return;
    apply(result);
    onNotice(`标签 ${tag.name} 已推送到 ${remote}，没有强制覆盖。`);
  }

  async function remove() {
    const tag = confirmTag;
    if (!tag) return;
    confirmTag = null;
    const current = opened;
    const result = await run(() => api.deleteTag(current.summary.path, tag.name, true, current.generation, nextId()));
    if (!result || opened.summary.path !== current.summary.path) return;
    apply(result);
    onNotice(`已删除本地标签 ${tag.name}，远程上的同名标签不受影响。`);
  }

  async function copyOid(oid: string) {
    try {
      await navigator.clipboard.writeText(oid);
      copied = oid;
      setTimeout(() => {
        if (copied === oid) copied = null;
      }, 1500);
    } catch {
      copied = null;
    }
  }
</script>

<div class="tag-manager">
  <div class="tag-create">
    <div class="tag-create-head"><span class="ch-icon warn"><Icon name="tag" size={15} /></span><div><strong>创建标签</strong><span>标记当前提交，或输入另一个提交 Hash</span></div></div>
    <div class="tag-create-grid">
      <div class="form-group">
        <label class="label" for="tag-name">标签名称</label>
        <input id="tag-name" class="input" bind:value={name} placeholder="例如 v1.0.0" disabled={blocked} autocomplete="off" spellcheck="false" />
      </div>
      <div class="form-group">
        <label class="label" for="tag-target">目标提交</label>
        <input id="tag-target" class="input code" bind:value={target} placeholder="HEAD 或提交 Hash" disabled={blocked} autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <div class="tag-create-message">
      <input class="input" aria-label="标签附注" bind:value={message} placeholder="可选附注；填写后创建附注标签" disabled={blocked} />
      <button type="button" class="btn btn-primary" disabled={blocked || !name.trim() || !target.trim()} onclick={create}><Icon name="plus" size={14} />创建标签</button>
    </div>
  </div>

  <div class="tag-list-tools">
    <div class="field sm"><Icon name="search" size={14} /><input aria-label="搜索标签" bind:value={query} placeholder="搜索标签、Hash 或附注" autocomplete="off" spellcheck="false" /></div>
    {#if loaded?.ok}<span class="count">{tags.length}</span>{/if}
  </div>

  <div class="list-box tag-list">
    {#if !loaded?.ok}
      <div class="empty compact" data-tag-loading>
        {#if loaded}
          <span class="empty-icon"><Icon name="alert-circle" size={20} /></span>
          <strong>没有读到标签</strong>
          <button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={() => (loaded = null)}>重试</button>
        {:else}
          <span class="empty-icon"><span class="spinner"></span></span>
          <strong>正在读取标签</strong>
        {/if}
      </div>
    {:else if visible.length === 0}
      <div class="empty compact"><span class="empty-icon"><Icon name="tag" size={20} /></span><strong>{tags.length === 0 ? "还没有标签" : "没有匹配的标签"}</strong><p>{tags.length === 0 ? "从上方创建第一个版本标记。" : "试试标签名、目标 Hash 或附注内容。"}</p></div>
    {:else}
      {#each visible as tag (tag.name)}
        <div class="list-row tag-row">
          <span class="tag-row-icon"><Icon name="tag" size={15} /></span>
          <div class="lr-main">
            <span class="lr-title"><span title={tag.name}>{tag.name}</span>{#if tag.message}<span class="chip tag">附注</span>{/if}</span>
            <span class="lr-sub tag-target">
              <code>{shortOid(tag.targetOid)}</code>
              <button type="button" aria-label={`复制标签 ${tag.name} 的目标 Hash`} title="复制完整目标 Hash" onclick={() => copyOid(tag.targetOid)}><Icon name={copied === tag.targetOid ? "check" : "copy"} size={11} /></button>
              <span>·</span><span title={formatAuthoredAt(tag.createdAt)}>{formatAuthoredAt(tag.createdAt)}</span>
            </span>
            {#if tag.message}<span class="lr-desc">{tag.message}</span>{/if}
          </div>
          <span class="lr-actions">
            <button type="button" class="btn btn-ghost btn-sm" disabled={blocked} onclick={() => onOpenHistory(tag.targetOid)}><Icon name="history" size={12} />查看提交</button>
            <button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={() => push(tag)}><Icon name="arrow-up" size={12} />推送</button>
            <button type="button" class="icon-btn sm danger" aria-label={`删除标签 ${tag.name}`} title="删除本地标签" disabled={blocked} onclick={() => (confirmTag = tag)}><Icon name="trash" size={13} /></button>
          </span>
        </div>
      {/each}
    {/if}
  </div>

  {#if confirmTag}
    <div class="callout warn" role="alert">
      <Icon name="alert" size={15} />
      <div class="callout-body">
        <p>删除本地标签 <strong>{confirmTag.name}</strong>？远程上的同名标签不会删除，目标提交也不会删除。</p>
        <div class="row"><button type="button" class="btn btn-secondary btn-sm" onclick={() => (confirmTag = null)}>取消</button><button type="button" class="btn btn-danger btn-sm" disabled={blocked} onclick={remove}>确认删除标签</button></div>
      </div>
    </div>
  {/if}
  {#if errorText}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>{/if}
</div>
