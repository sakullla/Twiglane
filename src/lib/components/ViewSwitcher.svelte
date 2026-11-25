<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import type { WorkspaceView } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 左栏顶部的视图切换：改动、历史、文件与审查。各视图各自挂载左栏，这个组件由它们共用，
   * 所以切换时位置、宽度都不动，看上去始终是同一个侧栏。
   *
   * 顺序就是数字快捷键的顺序：改动 1、历史 2、文件 3、审查 4，不按实现先后排列。
   * 审查只在存在审查目标（本地已接受来源或远程审查来源）时出现，普通独立仓库不显示。
   */
  interface Props {
    view: WorkspaceView;
    changeCount?: number;
    /** 设置里关闭文件视图时不显示这一项。 */
    showFiles?: boolean;
    /** 有审查目标时显示「审查」项；null 表示没有审查目标。 */
    review?: {
      /** 当前来源的意见数：大于 0 时显示徽标。 */
      comments: number;
      /** 来源状态点：ok 正常，warn 需要注意（来源失效、读取失败等）。 */
      tone: "ok" | "warn";
    } | null;
    onView: (view: WorkspaceView) => void;
  }

  let { view, changeCount = 0, showFiles = true, review = null, onView }: Props = $props();

  const items = [
    { id: "changes", text: "改动", label: "改动", shortcut: "1", icon: "file-diff" },
    { id: "history", text: "历史", label: "提交历史", shortcut: "2", icon: "history" },
    { id: "files", text: "文件", label: "文件", shortcut: "3", icon: "folder-open" },
    { id: "review", text: "审查", label: "审查", shortcut: "4", icon: "sparkle" },
  ] as const;
  let visible = $derived(items.filter((item) => (showFiles || item.id !== "files") && (review !== null || item.id !== "review")));
</script>

<nav class="segmented view-switcher" aria-label="视图">
  {#each visible as item (item.id)}
    {@const count = item.id === "changes" ? changeCount : item.id === "review" ? (review?.comments ?? 0) : 0}
    {@const reviewItem = item.id === "review"}
    {@const warn = reviewItem && review?.tone === "warn"}
    {@const notes = reviewItem ? [count > 0 ? `${count} 条意见` : null, warn ? "需要处理" : null].filter(Boolean) : []}
    <button
      type="button"
      data-view={item.id}
      aria-current={view === item.id ? "page" : undefined}
      aria-label={reviewItem ? (notes.length > 0 ? `${item.label}（${notes.join("，")}）` : item.label) : count > 0 ? `${item.label} ${count}` : item.label}
      title={reviewItem ? `${item.label}（${MODIFIER_LABEL}+${item.shortcut}）：Cliora 审查工作台${warn ? "，来源需要处理" : ""}` : `${item.label}（${MODIFIER_LABEL}+${item.shortcut}）`}
      onclick={() => onView(item.id)}
    >
      <Icon name={item.icon} size={14} />
      <span>{item.text}</span>
      {#if count > 0}<span class="count">{count}</span>{/if}
      {#if reviewItem && review}
        {#if warn}<span class="view-review-dot" data-tone="warn" aria-hidden="true"><Icon name="alert" size={9} /></span>{:else}<span class="view-review-dot" data-tone="ok" aria-hidden="true"></span>{/if}
      {/if}
    </button>
  {/each}
</nav>
