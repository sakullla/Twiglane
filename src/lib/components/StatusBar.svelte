<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import Icon from "./Icon.svelte";
  import { mergeNotice } from "./MergeBanner.svelte";

  /**
   * 状态栏：只放同步结论、警告、忙碌和刷新。分支名在标题栏、改动数在左栏，这里不重复。
   * 隐藏侧栏的按钮放在这里，因为左栏隐藏后它是唯一还看得见的鼠标入口。
   * 左栏隐藏时合并提示跟着看不见，这里接替它，进行中的合并始终醒目且能一键进入（R7）。
   * 新版本入口也常驻在这里（应用级提示，与是否打开仓库无关），点击进设置的应用更新分区（R1）。
   */
  interface Props {
    hasRepo: boolean;
    sync: string;
    busy?: boolean;
    /** 忙碌时的文字：读取仓库或续读差异时说「读取中」，不把只读操作说成写入（R3）。 */
    busyLabel?: string;
    refreshing?: boolean;
    degraded?: boolean;
    warning?: string | null;
    onRefresh?: () => void;
    sidebarHidden?: boolean;
    onToggleSidebar?: () => void;
    conflictCount?: number;
    mergeInProgress?: boolean;
    onOpenMerge?: () => void;
    /** 发现的新版本号；null 表示没有提示入口。与仓库无关（应用级更新），无仓库时也显示。 */
    updateVersion?: string | null;
    onOpenUpdate?: () => void;
  }

  let {
    hasRepo,
    sync,
    busy = false,
    busyLabel = "写入中",
    refreshing = false,
    degraded = false,
    warning = null,
    onRefresh,
    sidebarHidden = false,
    onToggleSidebar,
    conflictCount = 0,
    mergeInProgress = false,
    onOpenMerge,
    updateVersion = null,
    onOpenUpdate,
  }: Props = $props();

  let dotClass = $derived(degraded || warning ? "stale" : hasRepo ? "" : "off");
  let notice = $derived(hasRepo && sidebarHidden && onOpenMerge ? mergeNotice(conflictCount, mergeInProgress) : null);
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
  <span class="sb-item sb-sync" title={hasRepo ? "同步状态" : "还没有打开仓库"}>
    <span class={`sb-dot ${dotClass}`} aria-hidden="true"></span>
    <span>{hasRepo ? sync : "无仓库"}</span>
  </span>
  {#if updateVersion && onOpenUpdate}
    <!-- 新版本入口循 .sb-merge 常驻按钮惯例：有 offer 就在，点开设置的应用更新分区；offer 清空即消失。 -->
    <button
      type="button"
      class="sb-item sb-update"
      data-update-entry
      aria-label={`新版本 ${updateVersion}，打开应用更新设置`}
      title="打开设置的应用更新分区"
      onclick={onOpenUpdate}
    >
      <Icon name="download" size={12} />
      <span>新版本 {updateVersion}</span>
    </button>
  {/if}
  {#if notice}
    <button
      type="button"
      class="sb-item sb-merge"
      data-merge-status
      aria-label={notice.label}
      title="打开分支合并继续处理"
      onclick={onOpenMerge}
    >
      <Icon name="merge" size={12} />
      <span>{notice.text}</span>
    </button>
  {/if}
  {#if busy}<span class="sb-item sb-busy"><span class="spinner"></span>{busyLabel}</span>{/if}
  {#if warning}
    <span class="sb-item sb-warn" title={warning}>{warning}</span>
  {/if}
  <span class="sb-live" aria-hidden="true"></span>
  <!-- 没有仓库时没有工作区可刷新：按钮不占位，避免起始页出现一个无效动作。 -->
  {#if hasRepo && onRefresh}
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
