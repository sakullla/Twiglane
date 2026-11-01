<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import Icon from "./Icon.svelte";

  /**
   * 状态栏：只放同步结论、警告、忙碌和刷新。分支名在标题栏、改动数在左栏，这里不重复。
   * 隐藏侧栏的按钮放在这里，因为左栏隐藏后它是唯一还看得见的鼠标入口。
   */
  interface Props {
    hasRepo: boolean;
    sync: string;
    busy?: boolean;
    refreshing?: boolean;
    degraded?: boolean;
    warning?: string | null;
    onRefresh?: () => void;
    sidebarHidden?: boolean;
    onToggleSidebar?: () => void;
  }

  let {
    hasRepo,
    sync,
    busy = false,
    refreshing = false,
    degraded = false,
    warning = null,
    onRefresh,
    sidebarHidden = false,
    onToggleSidebar,
  }: Props = $props();

  let dotClass = $derived(degraded || warning ? "stale" : hasRepo ? "" : "off");
  let sidebarAction = $derived(sidebarHidden ? "显示侧栏" : "隐藏侧栏");
</script>

<footer class="statusbar" aria-label="状态栏">
  {#if hasRepo && onToggleSidebar}
    <button
      type="button"
      class="sb-item"
      aria-label={sidebarAction}
      aria-expanded={!sidebarHidden}
      title={`${sidebarAction}（${MODIFIER_LABEL}+B）`}
      onclick={onToggleSidebar}
    >
      <Icon name="sidebar" size={12} />
    </button>
  {/if}
  <span class="sb-item" title={hasRepo ? "同步状态" : "还没有打开仓库"}>
    <span class={`sb-dot ${dotClass}`} aria-hidden="true"></span>
    <span>{hasRepo ? sync : "无仓库"}</span>
  </span>
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
