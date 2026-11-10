<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import type { WorkspaceView } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 左栏顶部的视图切换：改动、历史与文件。三个视图各自挂载左栏，这个组件由它们共用，
   * 所以切换时位置、宽度都不动，看上去始终是同一个侧栏。
   *
   * 顺序就是数字快捷键的顺序：改动 1、历史 2、文件 3，不按实现先后排列。
   * cliora 审查的任务范围不占切换位：它是历史里按起点过滤后的「任务净差异」行。
   */
  interface Props {
    view: WorkspaceView;
    changeCount?: number;
    /** 设置里关闭文件视图时不显示这一项。 */
    showFiles?: boolean;
    /** 历史里有 cliora 任务范围：在历史项上加一个小标记，提醒从这里进入审查。 */
    taskActive?: boolean;
    onView: (view: WorkspaceView) => void;
  }

  let { view, changeCount = 0, showFiles = true, taskActive = false, onView }: Props = $props();

  const items = [
    { id: "changes", text: "改动", label: "改动", shortcut: "1", icon: "file-diff" },
    { id: "history", text: "历史", label: "提交历史", shortcut: "2", icon: "history" },
    { id: "files", text: "文件", label: "文件", shortcut: "3", icon: "folder-open" },
  ] as const;
  let visible = $derived(items.filter((item) => showFiles || item.id !== "files"));
</script>

<nav class="segmented view-switcher" aria-label="视图">
  {#each visible as item (item.id)}
    {@const count = item.id === "changes" ? changeCount : 0}
    {@const task = item.id === "history" && taskActive}
    <button
      type="button"
      data-view={item.id}
      aria-current={view === item.id ? "page" : undefined}
      aria-label={count > 0 ? `${item.label} ${count}` : task ? `${item.label}（含 cliora 任务范围）` : item.label}
      title={task ? `${item.label}（${MODIFIER_LABEL}+${item.shortcut}）：顶部是 cliora 任务净差异` : `${item.label}（${MODIFIER_LABEL}+${item.shortcut}）`}
      onclick={() => onView(item.id)}
    >
      <Icon name={item.icon} size={14} />
      <span>{item.text}</span>
      {#if count > 0}<span class="count">{count}</span>{/if}
      {#if task}<span class="view-task-dot" aria-hidden="true"></span>{/if}
    </button>
  {/each}
</nav>
