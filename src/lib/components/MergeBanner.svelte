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
    /** 进行中的合并、变基或拣选可以中止：提示旁边给一个「中止」，不必先打开合并窗口找按钮。 */
    canAbort?: boolean;
    /** 写入进行中时中止按钮不可用。 */
    abortBlocked?: boolean;
    onOpen: () => void;
    onAbort?: () => void;
  }

  let { conflictCount, mergeInProgress, canAbort = false, abortBlocked = false, onOpen, onAbort }: Props = $props();

  let notice = $derived(mergeNotice(conflictCount, mergeInProgress));
</script>

{#if notice}
  <div class="merge-banner-row">
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
  {#if canAbort && onAbort}
    <button
      type="button"
      class="merge-banner-abort"
      data-merge-abort
      aria-label="中止合并"
      title={abortBlocked ? "先等当前操作结束" : "中止合并：撤销合并中的编辑，回到开始之前（会先确认）"}
      disabled={abortBlocked}
      onclick={onAbort}
    >
      <Icon name="x" size={14} />
      <span>中止</span>
    </button>
  {/if}
  </div>
{/if}
