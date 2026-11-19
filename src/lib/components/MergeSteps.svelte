<script lang="ts">
  import type { MergeStep } from "../merge-flow";
  import Icon from "./Icon.svelte";

  /** 合并步骤条：选择分支 → 解决冲突 → 完成。只展示，不可点；当前步用 aria-current 标出。 */
  interface Props {
    steps: MergeStep[];
  }

  let { steps }: Props = $props();
</script>

<ol class="merge-steps" aria-label="合并步骤">
  {#each steps as step, index (step.id)}
    <li class={`merge-step ${step.state}`} aria-current={step.state === "current" ? "step" : undefined} data-step={step.id}>
      <span class="merge-step-dot" aria-hidden="true">
        {#if step.state === "done"}<Icon name="check" size={11} stroke={2.6} />{:else if step.state === "skipped"}<Icon name="minus" size={11} stroke={2.4} />{:else}{index + 1}{/if}
      </span>
      <span class="merge-step-label">{step.label}{#if step.state === "skipped"}<span class="sr-only">（跳过）</span>{/if}</span>
    </li>
  {/each}
</ol>

<style>
  .merge-steps { display: flex; align-items: center; gap: var(--space-4); margin: 0; padding: 0; list-style: none; flex: none; min-width: 0; }
  .merge-step { display: inline-flex; align-items: center; gap: var(--space-6); color: var(--fg-subtle); font-size: var(--text-xs); font-weight: var(--weight-medium); white-space: nowrap; }
  .merge-step + .merge-step::before { content: ""; width: 18px; height: 1px; margin-right: var(--space-2); background: var(--border-strong); }
  .merge-step-dot { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--surface-3); color: var(--fg-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .merge-step.current { color: var(--fg); }
  .merge-step.current .merge-step-dot { background: var(--accent); color: var(--accent-fg); box-shadow: 0 0 0 3px var(--accent-soft); }
  .merge-step.done { color: var(--fg-muted); }
  .merge-step.done .merge-step-dot { background: var(--success-soft); color: var(--success-text); }
  .merge-step.skipped .merge-step-label { text-decoration: line-through; text-decoration-color: var(--fg-subtle); }
  @media (max-width: 760px) {
    .merge-step:not(.current) .merge-step-label { display: none; }
  }
</style>
