<script lang="ts">
  import type { LineStat } from "../types";
  import { binarySizeText } from "../ui";

  /**
   * hideBinary：文件清单的行里不显示二进制标记。行里只为文本给增删行数，
   * 二进制的前后大小留给差异工具条和二进制说明，不在长列表里占位。
   */
  let { stat, hideBinary = false }: { stat?: LineStat | null; hideBinary?: boolean } = $props();
  let binary = $derived(Boolean(stat) && (stat?.additions == null || stat?.deletions == null));
  /** 二进制没有行数：显示改动前后的文件大小，读不到大小时才退回「二进制」。 */
  let size = $derived(binary && stat ? binarySizeText(stat.oldSize, stat.newSize) : null);
</script>

{#if stat}
  {#if binary}
    {#if hideBinary}
      <!-- 文件清单行：二进制不占位。 -->
    {:else if size}
      <span class="diff-stats binary" aria-label={size.label} title={size.label}>{size.text}</span>
    {:else}
      <span class="diff-stats binary" title="二进制文件，没有行数">二进制</span>
    {/if}
  {:else}
    <span class="diff-stats" aria-label={`新增 ${stat.additions} 行，删除 ${stat.deletions} 行`}>
      <span class="plus">+{stat.additions}</span>
      <span class="minus">−{stat.deletions}</span>
    </span>
  {/if}
{/if}
