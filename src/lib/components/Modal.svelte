<script module lang="ts">
  /**
   * 单槽 modal 约定的共享登记表。
   *
   * 约定：任一时刻只有一个任务 modal 处于打开状态（由持有 TaskModal 槽位的容器保证，
   * 本任务只提供七个入口的载体）。这里记录当前打开的层，使最上层 modal 独占背景
   * inert 与初始焦点；下层（例如任务 modal 之上的破坏性确认对话框）不会重复接管背景。
   */
  let nextLayerId = 1;
  const openLayers: number[] = [];

  export function claimModalLayer(): number {
    const id = nextLayerId++;
    openLayers.push(id);
    return id;
  }

  export function releaseModalLayer(id: number): void {
    const index = openLayers.indexOf(id);
    if (index >= 0) openLayers.splice(index, 1);
  }

  export function topModalLayer(): number | null {
    return openLayers.length > 0 ? openLayers[openLayers.length - 1] : null;
  }

  /** 当前打开的 modal 层数：任务 modal 打开期间应为 1，关闭后回到 0。 */
  export function openModalCount(): number {
    return openLayers.length;
  }
</script>

<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "../icons";

  interface Props {
    title: string;
    titleId: string;
    icon?: IconName;
    tone?: "default" | "danger" | "warning";
    size?: "sm" | "md" | "lg" | "xl";
    /** 覆盖默认档宽，用于接近全宽的合并 modal。 */
    width?: string;
    /** 任务 modal 标识（stash / merge / branch / remote / settings / scope / publish）。 */
    task?: string;
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
    width = "",
    task,
    description = "",
    onClose,
    children,
    footer,
  }: Props = $props();

  let card = $state<HTMLDivElement | null>(null);
  let backdrop = $state<HTMLDivElement | null>(null);

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const layer = claimModalLayer();
  let previous: HTMLElement | null = null;
  let releaseBackground: (() => void) | null = null;

  interface BackgroundRecord {
    el: HTMLElement;
    inert: string | null;
    hidden: string | null;
  }

  /**
   * 固定定位的覆盖层（toast 等）画在 modal 之上，禁用它们会让可见提示变得不可点、也不可读，
   * 因此不参与 inert。其他 modal 的背板仍是背景，要继续被禁用。
   */
  function staysInteractive(el: HTMLElement): boolean {
    if (el.hasAttribute("data-modal-backdrop")) return false;
    return window.getComputedStyle(el).position === "fixed";
  }

  /** 把 modal 以外的所有兄弟节点标为 inert，关闭时原样还原。 */
  function inertBackground(host: HTMLElement): () => void {
    const records: BackgroundRecord[] = [];
    let node: HTMLElement | null = host;
    while (node && node !== document.body) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || !(sibling instanceof HTMLElement) || staysInteractive(sibling)) continue;
        records.push({
          el: sibling,
          inert: sibling.getAttribute("inert"),
          hidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
      node = parent;
    }
    return () => {
      for (const record of records) {
        if (record.inert === null) record.el.removeAttribute("inert");
        else record.el.setAttribute("inert", record.inert);
        if (record.hidden === null) record.el.removeAttribute("aria-hidden");
        else record.el.setAttribute("aria-hidden", record.hidden);
      }
      records.length = 0;
    };
  }

  function dropBackground(): void {
    releaseBackground?.();
    releaseBackground = null;
  }

  /** 关闭 modal：先解除背景 inert，再交回触发元素的焦点，最后通知宿主收槽位。 */
  function close(): void {
    const target = previous;
    dropBackground();
    onClose();
    if (target?.isConnected) target.focus();
  }

  onMount(() => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (backdrop && topModalLayer() === layer) releaseBackground = inertBackground(backdrop);
    const body = card?.querySelector<HTMLElement>(".modal-body");
    const first =
      body?.querySelector<HTMLElement>("[data-autofocus]") ??
      body?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card)?.focus();
    return () => {
      dropBackground();
      releaseModalLayer(layer);
      if (previous?.isConnected) previous.focus();
      previous = null;
    };
  });

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
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
    if (event.target === event.currentTarget) close();
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  data-modal-backdrop=""
  bind:this={backdrop}
  onkeydown={onKey}
  onmousedown={onBackdrop}
>
  <div
    class={`modal-card modal-${size} tone-${tone}`}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    data-task-modal={task}
    data-modal-tone={tone}
    style={width ? `width:${width}` : undefined}
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
      <button type="button" class="icon-btn" aria-label="关闭对话框" title="关闭（Esc）" onclick={close}>
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
