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
    /** 底部终端当前是否展开；入口与命令面板的 terminal.toggle 是同一条命令。 */
    terminalOpen?: boolean;
    /** 当前仓库的终端数量；多于一个时在入口上显示，收起时也知道有几个在跑。 */
    terminalCount?: number;
    onToggleTerminal?: () => void;
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
    terminalOpen = false,
    terminalCount = 0,
    onToggleTerminal,
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
  <!-- 同步结论被裁切时，title 给出完整读法；不再固定成「同步状态」这种没有信息量的提示。 -->
  <span class="sb-item sb-sync" title={hasRepo ? sync : "还没有打开仓库"}>
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
  <!-- 写入/读取是用户等着的结果，放在左侧醒目处；写入结论本身已由弹窗与 toast 播报，这里再播一次只会重复。
       后台重新验证不在这里插一条：它不阻塞任何操作，只在右下角的刷新入口上安静地转（见下）。 -->
  {#if busy}
    <span
      class="sb-item sb-busy"
      role="status" aria-live="polite"
      aria-label={busyLabel}
      title={busyLabel}
    >
      <span class="spinner" aria-hidden="true"></span><span class="sb-text">{busyLabel}</span>
    </span>
  {/if}
  {#if warning}
    <span class="sb-item sb-warn" title={warning}><span class="sb-text">{warning}</span></span>
  {/if}
  <span class="sb-live" aria-hidden="true"></span>
  <!-- 终端入口与命令面板的 terminal.toggle 走同一条命令；无仓库时不可用并说明原因。 -->
  {#if onToggleTerminal}
    <button
      type="button"
      class="sb-item sb-terminal"
      data-terminal-toggle
      aria-label={terminalOpen ? "收起终端" : "展开终端"}
      aria-expanded={terminalOpen}
      title={hasRepo ? (terminalOpen ? `收起底部终端（${MODIFIER_LABEL}+\`）` : `展开底部终端，在仓库根目录运行命令（${MODIFIER_LABEL}+\`）`) : "先打开一个仓库"}
      disabled={!hasRepo}
      onclick={onToggleTerminal}
    >
      <Icon name="terminal" size={12} />
      <span class="sb-text">终端</span>
      {#if hasRepo && terminalCount > 1}
        <span class="sb-count" aria-label={`${terminalCount} 个终端`}>{terminalCount}</span>
      {/if}
    </button>
  {/if}
  <!-- 没有仓库时没有工作区可刷新：按钮不占位，避免起始页出现一个无效动作。
       重新验证（文件监听、窗口聚焦、手动刷新、历史重读）只把这个入口换成进行中：位置固定在右下角，
       宽度按「刷新中」预留，进出都不挤动状态栏的其它内容；旧内容在各自面板里照常可读（R6）。
       它不是实时播报区：监听刷新可能几秒一次，每次都播会淹没真正的结论；进行中状态由按钮的描述可问到。 -->
  {#if hasRepo && onRefresh}
    {@const quietRefresh = refreshing && !busy}
    {@const refreshReason = busy ? "当前操作完成后才能刷新" : refreshing ? "正在重新读取工作区与当前差异" : "重新读取工作区与当前差异"}
    <button
      type="button"
      class="sb-item sb-refresh"
      class:active={quietRefresh}
      aria-label="刷新工作区"
      aria-describedby="statusbar-refresh-reason"
      title={refreshReason}
      disabled={busy || refreshing}
      data-refreshing={quietRefresh ? "true" : undefined}
      onclick={onRefresh}
    >
      {#if quietRefresh}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="refresh" size={11} />{/if}
      <span class="sb-text">{quietRefresh ? "刷新中" : "刷新"}</span>
    </button>
    <!-- 不可聚焦的按钮也要能问到原因：描述节点常驻，随状态改文字，鼠标的 title 只是同内容的一层。 -->
    <span class="sr-only" id="statusbar-refresh-reason">{refreshReason}</span>
  {/if}
</footer>
