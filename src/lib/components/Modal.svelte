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

  /**
   * 当前打开的 modal 层数（不是「任务槽位」的计数）。
   *
   * 一个任务 modal 打开期间通常是 1，但危险确认层可以叠在它上面（例如放弃修改确认），
   * 此时层数会变成 2。所以「同一时刻只有一个任务 modal」的断言必须数
   * `[data-task-modal]` 节点，不能数这个层数；层数只用来判断最上层由谁接管背景 inert。
   */
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
    /** 占满视口高度：正文不滚动，由内容自己分区滚动（用于合并冲突这类大面板）。 */
    fill?: boolean;
    /** 任务 modal 标识（stash / merge / branch / remote / settings / scope / publish）。 */
    task?: string;
    description?: string;
    /**
     * 写入在途：此刻关闭会让界面看起来已经放弃，结果却还会落地。
     * 为真时 Esc、点背板和右上角关闭都不生效，写入结束后恢复。
     */
    locked?: boolean;
    /**
     * 关闭后焦点去处：调用方在打开前记下的有效触发点。
     *
     * 需要它的场景是「弹窗不是由某个控件直接打开」：例如从命令面板执行任务命令时，
     * 面板与弹窗在同一批更新里换位，onMount 抓到的 activeElement 是随即卸载的搜索框，
     * 交回焦点就落到了 body，只能由调用方把面板打开前的焦点传进来。
     * 不传时仍按原语义退回 onMount 抓到的元素。
     */
    returnFocus?: HTMLElement | null;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
    /** 标题行里的扩展内容，排在标题之后，宽度不依赖标题长度。 */
    headExtra?: Snippet;
  }

  let {
    title,
    titleId,
    icon,
    tone = "default",
    size = "md",
    width = "",
    fill = false,
    task,
    description = "",
    locked = false,
    returnFocus = null,
    onClose,
    children,
    footer,
    headExtra,
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
    if (locked) return;
    const target = previous;
    dropBackground();
    onClose();
    if (target?.isConnected) target.focus();
  }

  onMount(() => {
    // 调用方显式指定且仍在文档里时以它为准；否则退回打开瞬间的 activeElement。
    const explicit = returnFocus instanceof HTMLElement && returnFocus.isConnected ? returnFocus : null;
    previous = explicit ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (backdrop && topModalLayer() === layer) releaseBackground = inertBackground(backdrop);
    const body = card?.querySelector<HTMLElement>(".modal-body");
    const first =
      body?.querySelector<HTMLElement>("[data-autofocus]") ??
      body?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card)?.focus();
    // 监听挂在 document：按钮在途被禁用后焦点会落到 body，绑在背板上的键盘处理就收不到按键了。
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      dropBackground();
      releaseModalLayer(layer);
      if (previous?.isConnected) previous.focus();
      previous = null;
    };
  });

  function focusableItems(): HTMLElement[] {
    if (!card) return [];
    return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
  }

  /**
   * 只有最上层 modal 响应。内层处理过的按键（确认区、浮层、IME 组字）不再上浮到这里：
   * 它们要么 stopPropagation，要么 preventDefault，所以这里先看 defaultPrevented。
   */
  function onKey(event: KeyboardEvent) {
    if (topModalLayer() !== layer || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || !card) return;
    const items = focusableItems();
    const active = document.activeElement;
    // 焦点不在卡片里（落到 body，或停在通知上）：Tab 先把它拉回来，不让它走到背景。
    if (!(active instanceof Node) || !card.contains(active)) {
      event.preventDefault();
      ((event.shiftKey ? items[items.length - 1] : items[0]) ?? card).focus();
      return;
    }
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
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
  onmousedown={onBackdrop}
>
  <div
    class={`modal-card modal-${size} tone-${tone}`}
    class:modal-fill={fill}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={description ? `${titleId}-description` : undefined}
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
        {#if description}<p class="modal-desc" id={`${titleId}-description`}>{description}</p>{/if}
      </div>
      {#if headExtra}{@render headExtra()}{/if}
      <button
        type="button"
        class="icon-btn"
        aria-label="关闭对话框"
        title={locked ? "写入完成后才能关闭" : "关闭（Esc）"}
        disabled={locked}
        onclick={close}
      >
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
