<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import type { WorkspaceView } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 左栏顶部的视图切换：改动、历史、文件与任务。四个视图各自挂载左栏，这个组件由它们共用，
   * 所以切换时位置、宽度都不动，看上去始终是同一个侧栏。
   *
   * 顺序就是数字快捷键的顺序：改动 1、历史 2、文件 3、任务 4，不按实现先后排列。
   * 任务排在最后：它通常由 cliora 链接带着起点直接进入，不需要用户在切换条里先找它。
   */
  interface Props {
    view: WorkspaceView;
    changeCount?: number;
    /** 设置里关闭文件视图时不显示这一项。 */
    showFiles?: boolean;
    onView: (view: WorkspaceView) => void;
  }

  let { view, changeCount = 0, showFiles = true, onView }: Props = $props();

  const items = [
    { id: "changes", text: "改动", label: "改动", shortcut: "1", icon: "file-diff" },
    { id: "history", text: "历史", label: "提交历史", shortcut: "2", icon: "history" },
    { id: "files", text: "文件", label: "文件", shortcut: "3", icon: "folder-open" },
    { id: "task", text: "任务", label: "任务审阅", shortcut: "4", icon: "layers" },
  ] as const;
  let visible = $derived(items.filter((item) => showFiles || item.id !== "files"));
</script>

<nav class="segmented view-switcher" aria-label="视图">
  {#each visible as item (item.id)}
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