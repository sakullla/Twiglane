<script lang="ts">
  import Icon from "./Icon.svelte";

  /**
   * 状态栏：一行只放结论与计数，刷新入口也在这里（R2 要求刷新离开标题栏后仍可达）。
   */
  interface Props {
    branch: string | null;
    sync: string;
    changeCount?: number;
    conflictCount?: number;
    busy?: boolean;
    refreshing?: boolean;
    degraded?: boolean;
    warning?: string | null;
    onRefresh?: () => void;
  }

  let {
    branch,
    sync,
    changeCount = 0,
    conflictCount = 0,
    busy = false,
    refreshing = false,
    degraded = false,
    warning = null,
    onRefresh,
  }: Props = $props();

  let branchText = $derived(branch ?? "无仓库");
  let dotClass = $derived(degraded || warning ? "stale" : branch === null ? "off" : "");
</script>

<footer class="statusbar" aria-label="状态栏">
  <span class="sb-item" title={branch === null ? "还没有打开仓库" : `当前分支：${branchText}`}>
    <span class={`sb-dot ${dotClass}`} aria-hidden="true"></span>
    <span>{branchText}</span>
  </span>
  <span class="sb-item" title="同步状态">{sync}</span>
  <span class="sb-item" title="改动文件数">改动 {changeCount}</span>
  {#if conflictCount > 0}
    <span class="sb-item sb-warn" title="未解决冲突">冲突 {conflictCount}</span>
  {/if}
  {#if busy}<span class="sb-item sb-busy"><span class="spinner"></span>写入中</span>{/if}
  {#if warning}
    <span class="sb-item sb-warn" title={warning}>{warning}</span>
  {/if}
  <span class="sb-live" aria-hidden="true"></span>
  {#if onRefresh}
    <button
      type="button"
      class="sb-item"
      aria-label="刷新工作区"
      title="重新读取工作区与当前差异"
      disabled={busy}
      onclick={onRefresh}
    >
      {#if refreshing}<span class="spinner"></span>{:else}<Icon name="refresh" size={11} />{/if}
      刷新
    </button>
  {/if}
</footer>
