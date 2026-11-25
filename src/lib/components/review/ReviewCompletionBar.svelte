<script lang="ts">
  import type { ReviewCompletionAction, ReviewCompletionModel, ReviewCompletionStatusItem } from "../../review-completion";
  import Icon from "../Icon.svelte";

  /**
   * 审查工作台底部常驻完成栏：同一位置提供「送回意见」与「返回 Cliora」，文案全部来自
   * review-completion 纯函数模型。Git 结果与工作区状态分项展示，详情按需展开。
   * 防重入与迟到响应的守卫在 review-actions 里；这里只按模型禁用并说明原因。
   */
  interface Props {
    model: ReviewCompletionModel;
    onFeedback?: () => void;
    onReturn?: () => void;
  }

  let { model, onFeedback, onReturn }: Props = $props();
  let detailsOpen = $state(false);

  function run(action: ReviewCompletionAction): void {
    if (action.disabled) return;
    if (action.id === "feedback") onFeedback?.();
    else onReturn?.();
  }

  const ICON: Record<ReviewCompletionStatusItem["tone"], "info" | "check-circle" | "alert" | "alert-circle"> = {
    neutral: "info",
    info: "info",
    success: "check-circle",
    warn: "alert",
    error: "alert-circle",
  };
</script>

<footer class="review-completion" data-tone={model.tone} aria-label="审查完成">
  <ul class="review-completion-status" aria-label="审查状态">
    {#each model.statusItems as item (item.id)}
      <li class="review-completion-item" data-status={item.id} data-tone={item.tone}>
        <Icon name={ICON[item.tone]} size={12} /><span>{item.label}</span>
      </li>
    {/each}
  </ul>
  <div class="review-completion-actions">
    {#if model.detailItems.length > 0}
      <button
        type="button"
        class="btn btn-ghost btn-sm review-completion-more"
        aria-expanded={detailsOpen}
        aria-controls="review-completion-details"
        onclick={() => (detailsOpen = !detailsOpen)}
      >
        <Icon name={detailsOpen ? "chevron-down" : "chevron-up"} size={12} /><span>详情</span>
      </button>
    {/if}
    {#if model.secondary}
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-completion-action={model.secondary.id}
        disabled={model.secondary.disabled}
        title={model.secondary.reason ?? model.secondary.label}
        onclick={() => model.secondary && run(model.secondary)}
      >{model.secondary.label}</button>
    {/if}
    {#if model.primary}
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-completion-action={model.primary.id}
        disabled={model.primary.disabled}
        title={model.primary.reason ?? model.primary.label}
        onclick={() => model.primary && run(model.primary)}
      >
        <Icon name={model.primary.id === "feedback" ? "sparkle" : "arrow-left"} size={13} /><span>{model.primary.label}</span>
      </button>
    {/if}
  </div>
  {#if detailsOpen}
    <ul id="review-completion-details" class="review-completion-details" aria-label="审查完成详情">
      {#each model.detailItems as item, index (index)}
        <li>{item}</li>
      {/each}
    </ul>
  {/if}
</footer>
