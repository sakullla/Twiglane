<script module lang="ts">
  import type { IconName } from "../../icons";

  /** 整页状态：每种都说明原因，并给出可以直接执行的动作。 */
  export type ReviewStateKind =
    | "no-source"
    | "no-baseline"
    | "range-invalid"
    | "read-failed"
    | "source-expired"
    | "version-incompatible"
    | "reading"
    | "empty";

  export interface ReviewStateAction {
    id: string;
    label: string;
    icon?: IconName;
    primary?: boolean;
    disabledReason?: string | null;
    run: () => void;
  }
</script>

<script lang="ts">
  import Icon from "../Icon.svelte";

  /**
   * 审查工作台的整页状态面板：无起点、范围失效、读取失败、来源失效、版本不兼容、
   * 没有来源、读取中与空任务。占满差异区同一个网格单元，切换时不引起布局跳动。
   */
  interface Props {
    kind: ReviewStateKind;
    title: string;
    message: string;
    /** 稳定错误码与原始诊断：折叠在详情里，不放在主文案中。 */
    detail?: string | null;
    actions?: ReviewStateAction[];
  }

  let { kind, title, message, detail = null, actions = [] }: Props = $props();

  const ICONS: Record<ReviewStateKind, IconName> = {
    "no-source": "sparkle",
    "no-baseline": "layers",
    "range-invalid": "alert-circle",
    "read-failed": "alert-circle",
    "source-expired": "alert",
    "version-incompatible": "alert",
    reading: "history",
    empty: "check-circle",
  };
  let error = $derived(kind === "range-invalid" || kind === "read-failed");
  let warn = $derived(kind === "source-expired" || kind === "version-incompatible");
</script>

<div
  class="review-state"
  data-review-state={kind}
  role={error ? "alert" : "status"}
  aria-busy={kind === "reading" ? "true" : undefined}
>
  <span class="empty-icon" class:err={error} class:warn class:ok={kind === "empty"}>
    {#if kind === "reading"}<span class="spinner"></span>{:else}<Icon name={ICONS[kind]} size={22} />{/if}
  </span>
  <strong class="review-state-title">{title}</strong>
  <p class="review-state-message">{message}</p>
  {#if actions.length > 0}
    <div class="review-state-actions">
      {#each actions as action (action.id)}
        <button
          type="button"
          class={`btn btn-sm ${action.primary ? "btn-primary" : "btn-secondary"}`}
          data-review-state-action={action.id}
          disabled={Boolean(action.disabledReason)}
          title={action.disabledReason ?? action.label}
          onclick={action.run}
        >
          {#if action.icon}<Icon name={action.icon} size={13} />{/if}<span>{action.label}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if detail}
    <details class="review-state-detail">
      <summary>详情</summary>
      <p>{detail}</p>
    </details>
  {/if}
</div>
