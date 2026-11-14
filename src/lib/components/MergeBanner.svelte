<script module lang="ts">
  /** 还原不能借用“合并”的文案；其他操作保持既有横幅措辞。 */
  function revertOperation(operation: string): boolean {
    return operation === "revert";
  }

  /** 合并/还原提示的文案：左栏横幅和状态栏共用。没有进行中的操作也没有冲突时返回 null。 */
  export function mergeNotice(
    conflictCount: number,
    mergeInProgress: boolean,
    operation = "merge",
    canContinue = true,
  ): { text: string; label: string } | null {
    if (!mergeInProgress && conflictCount === 0) return null;
    if (revertOperation(operation)) {
      if (conflictCount === 0 && !canContinue) {
        const text = "还原停在后续目标，可以中止";
        return { text, label: `${mergeInProgress ? "还原进行中，" : ""}${text}，打开还原` };
      }
      const text = conflictCount > 0 ? `${conflictCount} 个还原冲突待处理` : "可以继续还原";
      return { text, label: `${mergeInProgress ? "还原进行中，" : ""}${text}，打开还原` };
    }
    const text = conflictCount > 0 ? `${conflictCount} 个冲突待处理` : "可以完成合并";
    return { text, label: `${mergeInProgress ? "合并进行中，" : ""}${text}，打开分支合并` };
  }
</script>

<script lang="ts">
  import Icon from "./Icon.svelte";

  /**
   * 左栏顶部的合并/还原提示。mergeInProgress 与 conflictCount 分开判断：
   * 冲突全部解决后计数归零，但操作还没完成，提示必须留着（R7）。
   * operation 决定还原文案：不把还原显示成“合并进行中”。
   */
  interface Props {
    conflictCount: number;
    mergeInProgress: boolean;
    /** 进行中的操作：merge / rebase / cherry-pick / revert / none。 */
    operation?: string;
    /** 当前会话能否继续：还原停在后续目标时为 false，只能中止。 */
    canContinue?: boolean;
    /** 进行中的合并、变基、拣选或还原可以中止：提示旁边给一个「中止」，不必先打开面板找按钮。 */
    canAbort?: boolean;
    /** 写入进行中时中止按钮不可用。 */
    abortBlocked?: boolean;
    onOpen: () => void;
    onAbort?: () => void;
  }

  let {
    conflictCount,
    mergeInProgress,
    operation = "merge",
    canContinue = true,
    canAbort = false,
    abortBlocked = false,
    onOpen,
    onAbort,
  }: Props = $props();

  let revert = $derived(revertOperation(operation));
  let notice = $derived(mergeNotice(conflictCount, mergeInProgress, operation, canContinue));
</script>

{#if notice}
  <div class="merge-banner-row">
  <button
    type="button"
    class="merge-banner"
    data-merge-banner
    aria-label={notice.label}
    title={revert ? "打开还原继续处理" : "打开分支合并继续处理"}
    onclick={onOpen}
  >
    <Icon name={revert ? "undo" : "merge"} size={14} />
    <span class="truncate">{notice.text}</span>
    <Icon name="chevron-right" size={14} />
  </button>
  {#if canAbort && onAbort}
    <button
      type="button"
      class="merge-banner-abort"
      data-merge-abort
      aria-label={revert ? "中止还原" : "中止合并"}
      title={abortBlocked
        ? "先等当前操作结束"
        : revert
          ? "中止还原：撤销还原中的编辑并回到开始之前（会先确认）"
          : "中止合并：撤销合并中的编辑，回到开始之前（会先确认）"}
      disabled={abortBlocked}
      onclick={onAbort}
    >
      <Icon name="x" size={14} />
      <span>中止</span>
    </button>
  {/if}
  </div>
{/if}
