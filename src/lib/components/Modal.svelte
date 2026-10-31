<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "../icons";

  interface Props {
    title: string;
    titleId: string;
    icon?: IconName;
    tone?: "default" | "danger" | "warning";
    size?: "sm" | "md" | "lg";
    description?: string;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let {
    title,
    titleId,
    icon,
    tone = "default",
    size = "md",
    description = "",
    onClose,
    children,
    footer,
  }: Props = $props();

  let card = $state<HTMLDivElement | null>(null);

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  onMount(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = card?.querySelector<HTMLElement>(".modal-body");
    const first =
      body?.querySelector<HTMLElement>("[data-autofocus]") ??
      body?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card)?.focus();
    return () => previous?.focus?.();
  });

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !card) return;
    const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<div class="modal-backdrop" role="presentation" onkeydown={onKey} onmousedown={onBackdrop}>
  <div
    class={`modal-card modal-${size} tone-${tone}`}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    bind:this={card}
  >
    <header class="modal-head">
      {#if icon}
        <span class={`modal-icon tone-${tone}`}><Icon name={icon} size={18} /></span>
      {/if}
      <div class="modal-titles">
        <h2 id={titleId}>{title}</h2>
        {#if description}<p class="modal-desc">{description}</p>{/if}
      </div>
      <button type="button" class="icon-btn" aria-label="关闭对话框" title="关闭（Esc）" onclick={onClose}>
        <Icon name="x" />
      </button>
    </header>
    <div class="modal-body">
      {@render children()}
    </div>
    {#if footer}
      <footer class="modal-foot">
        {@render footer()}
      </footer>
    {/if}
  </div>
</div>
