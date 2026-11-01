<script module lang="ts">
  /** 合并提示的文案：左栏横幅和状态栏共用。没有合并也没有冲突时返回 null。 */
  export function mergeNotice(conflictCount: number, mergeInProgress: boolean): { text: string; label: string } | null {
    if (!mergeInProgress && conflictCount === 0) return null;
    const text = conflictCount > 0 ? `${conflictCount} 个冲突待处理` : "可以完成合并";
    return { text, label: `${mergeInProgress ? "合并进行中，" : ""}${text}，打开分支合并` };
  }
</script>

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

  let notice = $derived(mergeNotice(conflictCount, mergeInProgress));
</script>

{#if notice}
  <button
    type="button"
    class="merge-banner"
    data-merge-banner
    aria-label={notice.label}
    title="打开分支合并继续处理"
    onclick={onOpen}
  >
    <Icon name="merge" size={14} />
    <span class="truncate">{notice.text}</span>
    <Icon name="chevron-right" size={14} />
  </button>
{/if}
