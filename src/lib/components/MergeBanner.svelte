<script lang="ts">
  import Icon from "./Icon.svelte";

  /**
   * 左栏顶部的合并提示。mergeInProgress 与 conflictCount 分开判断：
   * 冲突全部解决后计数归零，但合并还没完成，提示必须留着（R7）。
   */
  interface Props {
    conflictCount: number;
    mergeInProgress: boolean;
    onOpen: () => void;
  }

  let { conflictCount, mergeInProgress, onOpen }: Props = $props();

  let visible = $derived(mergeInProgress || conflictCount > 0);
  let text = $derived(conflictCount > 0 ? `${conflictCount} 个冲突待处理` : "可以完成合并");
</script>

{#if visible}
  <button
    type="button"
    class="merge-banner"
    data-merge-banner
    aria-label={`${mergeInProgress ? "合并进行中，" : ""}${text}，打开分支合并`}
    title="打开分支合并继续处理"
    onclick={onOpen}
  >
    <Icon name="merge" size={14} />
    <span class="truncate">{text}</span>
    <Icon name="chevron-right" size={14} />
  </button>
{/if}
