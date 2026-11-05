<script module lang="ts">
  import type { CommitBranches as CommitBranchesResult } from "../types";

  /** 同一仓库、同一提交、同一 generation 的结果直接复用：来回点提交不重复跑 for-each-ref。 */
  const cache = new Map<string, CommitBranchesResult>();
  const MAX_CACHED = 64;

  function remember(key: string, value: CommitBranchesResult) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { api } from "../api";
  import { LatestReadQueue } from "../latest-read";
  import { normalizeError } from "../errors";
  import Icon from "./Icon.svelte";

  /**
   * 「这次提交在哪些分支生效」：列出包含该提交的本地与远程分支，当前检出的分支排在最前并高亮；
   * 当前分支不包含它时明确说出来。只读，按需加载，不阻塞提交详情。
   */
  interface Props {
    active?: boolean;
    repo: string;
    oid: string;
    generation: number;
    nextId: () => number;
    onGeneration: (generation: number) => void;
  }

  let { active = true, repo, oid, generation, nextId, onGeneration }: Props = $props();
  const reads = new LatestReadQueue();
  onDestroy(() => { token++; reads.close(); });

  const COLLAPSED = 6;
  let result = $state.raw<CommitBranchesResult | null>(null);
  let loading = $state(false);
  let errorText = $state<string | null>(null);
  let expanded = $state(false);
  let retry = $state(0);
  let token = 0;

  $effect(() => {
    const mine = ++token;
    if (!active) {
      result = null;
      loading = false;
      return;
    }
    const key = `${repo}\u0000${oid}\u0000${generation}`;
    const target = { repo, oid, generation };
    void retry;
    expanded = false;
    const hit = cache.get(key);
    if (hit) {
      remember(key, hit);
      result = hit;
      loading = false;
      errorText = null;
      return;
    }
    loading = true;
    errorText = null;
    // 切到下一个提交时先留着上一个的结果会误导：立刻清掉。
    if (result?.oid !== oid) result = null;
    const timer = setTimeout(() => void load(target, mine), 120);
    return () => { token++; clearTimeout(timer); };
  });

  async function load(target: { repo: string; oid: string; generation: number }, mine: number) {
    const ask = (at: number) => reads.run(() => {
      if (mine !== token) throw { code: "cancelled" };
      return api.commitBranches(target.repo, target.oid, at, nextId());
    });
    try {
      let next: CommitBranchesResult;
      try {
        next = await ask(target.generation);
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code !== "stale" || failure.generation === undefined) throw failure;
        if (mine !== token) return;
        onGeneration(failure.generation);
        next = await ask(failure.generation);
      }
      if (mine !== token) return;
      remember(`${target.repo}\u0000${target.oid}\u0000${next.generation}`, next);
      result = next;
    } catch (error) {
      if (mine !== token) return;
      errorText = normalizeError(error).message;
    } finally {
      if (mine === token) loading = false;
    }
  }

  let branches = $derived(result?.branches ?? []);
  let current = $derived(result?.current ?? null);
  let onCurrent = $derived(branches.some((branch) => branch.current));
  let localCount = $derived(branches.filter((branch) => !branch.remote).length);
  let remoteCount = $derived(branches.length - localCount);
  let shown = $derived(expanded ? branches : branches.slice(0, COLLAPSED));
  let hidden = $derived((result?.total ?? branches.length) - shown.length);
  let summary = $derived(
    result
      ? `包含此提交的分支：本地 ${localCount} 个，远程 ${remoteCount} 个${result.total > branches.length ? `（只列出前 ${branches.length} 个）` : ""}`
      : "",
  );
</script>

<div class="commit-branches" class:expanded aria-busy={loading} aria-label="所在分支">
  <span class="commit-branches-label" title="包含这次提交（也就是这次改动已经生效）的分支">
    <Icon name="branch" size={12} />所在分支
  </span>
  {#if loading && !result}
    <span class="commit-branches-hint"><span class="spinner"></span>正在查找…</span>
  {:else if errorText}
    <span class="commit-branches-hint error" title={errorText}>无法读取</span>
    <button type="button" class="cb-more" onclick={() => (retry += 1)}>重试</button>
  {:else if result}
    <span class="commit-branches-list" title={summary}>
      {#if current && !onCurrent}
        <span class="cb-chip warn" title={`当前检出的 ${current} 不包含这次提交：改动还没有进入当前分支`}>
          <Icon name="alert" size={11} />不在当前分支 {current}
        </span>
      {/if}
      {#if branches.length === 0}
        <span class="commit-branches-hint">没有分支包含它（可能只在游离提交或已删除的分支上）</span>
      {/if}
      {#each shown as branch (`${branch.remote}:${branch.name}`)}
        <span
          class="cb-chip"
          class:current={branch.current}
          class:remote={branch.remote}
          title={branch.current ? `当前检出的分支 ${branch.name} 已包含这次提交` : branch.remote ? `远程分支 ${branch.name}` : `本地分支 ${branch.name}`}
        >
          {#if branch.current}<Icon name="check" size={11} />{:else if branch.remote}<Icon name="cloud" size={11} />{/if}
          <span class="cb-name">{branch.name}</span>
          {#if branch.current}<span class="cb-tag">当前</span>{/if}
        </span>
      {/each}
      {#if hidden > 0 || expanded}
        <button
          type="button"
          class="cb-more"
          aria-expanded={expanded}
          title={expanded ? "收起" : `再显示 ${hidden} 个分支`}
          onclick={() => (expanded = !expanded)}
        >{expanded ? "收起" : `+${hidden}`}</button>
      {/if}
      {#if loading}<span class="spinner muted"></span>{/if}
    </span>
  {/if}
</div>
