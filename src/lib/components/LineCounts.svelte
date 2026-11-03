<script lang="ts">
  import type { LineStat } from "../types";

  let { stat }: { stat?: LineStat | null } = $props();
  let binary = $derived(Boolean(stat) && (stat?.additions == null || stat?.deletions == null));
</script>

{#if stat}
  {#if binary}
    <span class="diff-stats binary">二进制</span>
  {:else}
    <span class="diff-stats" aria-label={`新增 ${stat.additions} 行，删除 ${stat.deletions} 行`}>
      <span class="plus">+{stat.additions}</span>
      <span class="minus">−{stat.deletions}</span>
    </span>
  {/if}
{/if}
