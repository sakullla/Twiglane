<script lang="ts">
  import type { ReviewQueueFilter } from "../../review-workbench.svelte";
  import { QUEUE_FILTER_LABELS } from "../../ui";
  import Icon from "../Icon.svelte";

  /**
   * 审查队列的筛选段与计数（R3、R4）。
   *
   * 筛选只决定队列里显示哪些文件：「未审阅」读审阅记录、「有意见」读意见路径，都不写入。
   * 计数分开说「可见 m · 共 n」，进度永远按任务真实总数算；筛选、搜索或隐藏已审阅生效时
   * 给出「清除筛选」，一次恢复完整队列。
   */
  interface Props {
    filter: ReviewQueueFilter;
    /** 搜索、筛选与隐藏之后可见的文件数。 */
    visible: number;
    /** 任务真实文件总数。 */
    total: number;
    reviewed: number;
    /** 有意见的文件数：段上给出数字，便于判断要不要切过去。 */
    commented: number;
    clearable: boolean;
    /** 「标记并继续」的就地说明，例如已到可见队列末尾。 */
    note?: string | null;
    onFilter: (filter: ReviewQueueFilter) => void;
    onClear: () => void;
  }

  let { filter, visible, total, reviewed, commented, clearable, note = null, onFilter, onClear }: Props = $props();

  const FILTERS: ReviewQueueFilter[] = ["all", "unreviewed", "commented"];

  function count(item: ReviewQueueFilter): number {
    if (item === "unreviewed") return Math.max(0, total - reviewed);
    if (item === "commented") return commented;
    return total;
  }
</script>

<div class="review-queue-bar">
  <div class="segmented review-queue-filter" role="group" aria-label="队列筛选">
    {#each FILTERS as item (item)}
      <button
        type="button"
        aria-pressed={filter === item}
        data-queue-filter={item}
        title={item === "all"
          ? "显示全部任务文件"
          : item === "unreviewed"
            ? "只看还没标记已审阅的文件；进度总数不变"
            : "只看已经写了意见的文件；进度总数不变"}
        onclick={() => onFilter(item)}
      >
        <span>{QUEUE_FILTER_LABELS[item]}</span><span class="count">{count(item)}</span>
      </button>
    {/each}
  </div>
  <div class="review-queue-count">
    <span role="status" aria-label={`可见 ${visible} 个，共 ${total} 个任务文件`}>可见 {visible} · 共 {total}</span>
    {#if clearable}
      <button type="button" class="btn btn-ghost btn-sm review-queue-clear" title="回到完整队列：全部文件、无搜索、不隐藏已审阅" onclick={onClear}>
        <Icon name="x" size={12} /><span>清除筛选</span>
      </button>
    {/if}
  </div>
  {#if note}
    <p class="review-queue-note" role="status"><Icon name="info" size={13} /><span>{note}</span></p>
  {/if}
</div>
