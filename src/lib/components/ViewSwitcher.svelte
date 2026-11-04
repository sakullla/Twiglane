<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import type { WorkspaceView } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 左栏顶部的视图切换：改动与提交历史。两个视图各自挂载左栏，这个组件由它们共用，
   * 所以切换时位置、宽度都不动，看上去始终是同一个侧栏。
   */
  interface Props {
    view: WorkspaceView;
    changeCount?: number;
    onView: (view: WorkspaceView) => void;
  }

  let { view, changeCount = 0, onView }: Props = $props();

  const items = [
    { id: "changes", text: "改动", label: "改动", shortcut: "1", icon: "file-diff" },
    { id: "history", text: "历史", label: "提交历史", shortcut: "2", icon: "history" },
  ] as const;
</script>

<nav class="segmented view-switcher" aria-label="视图">
  {#each items as item (item.id)}
    {@const count = item.id === "changes" ? changeCount : 0}
    <button
      type="button"
      data-view={item.id}
      aria-current={view === item.id ? "page" : undefined}
      aria-label={count > 0 ? `${item.label} ${count}` : item.label}
      title={`${item.label}（${MODIFIER_LABEL}+${item.shortcut}）`}
      onclick={() => onView(item.id)}
    >
      <Icon name={item.icon} size={14} />
      <span>{item.text}</span>
      {#if count > 0}<span class="count">{count}</span>{/if}
    </button>
  {/each}
</nav>
