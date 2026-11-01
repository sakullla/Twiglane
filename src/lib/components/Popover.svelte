<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import { isContextKey, pointFor } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 标题栏可搜索弹层的共用外壳：定位、搜索框、方向键、点外面关闭、Esc 与焦点返回。
   * 焦点留在搜索框，列表靠 aria-activedescendant 表达当前项，这样边输入边选不用来回切焦点；
   * 底部动作是普通按钮，Tab 在搜索框与它们之间循环。
   * 右键菜单叠在弹层上时不算「点外面」，它的 Esc 也由菜单自己消费，只关闭菜单这一层。
   */
  interface Props {
    /** 触发按钮：定位基准，也是关闭后焦点回去的地方。 */
    anchor: HTMLElement;
    label: string;
    placeholder: string;
    query: string;
    active: number;
    /** 列表条目数；方向键在 0…count-1 之间循环。 */
    count: number;
    width?: number;
    onChoose: (index: number) => void;
    onItemContextMenu?: (index: number, point: { x: number; y: number }) => void;
    /** refocus：是否把焦点还给触发按钮。点外面关闭时焦点已经在用户点的地方。 */
    onClose: (refocus: boolean) => void;
    /** 列表内容；参数是 listbox 的 id，条目 id 为 `${id}-${index}`。 */
    list: Snippet<[string]>;
    notice?: Snippet;
    foot: Snippet;
  }

  let {
    anchor,
    label,
    placeholder,
    query = $bindable(),
    active = $bindable(),
    count,
    width = 400,
    onChoose,
    onItemContextMenu,
    onClose,
    list,
    notice,
    foot,
  }: Props = $props();

  const MARGIN = 8;
  const GAP = 6;
  const MAX_HEIGHT = 480;
  const listId = `popover-${Math.random().toString(36).slice(2, 9)}`;

  let root = $state<HTMLDivElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let place = $state({ top: 0, left: 0, width: 0, maxHeight: MAX_HEIGHT });

  /** 贴着触发按钮向下展开，并收在窗口内：900×600 下也要完整可见（R14）。 */
  function measure() {
    const rect = anchor.getBoundingClientRect();
    const fit = Math.min(width, window.innerWidth - MARGIN * 2);
    const top = rect.bottom + GAP;
    place = {
      top,
      left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - fit - MARGIN)),
      width: fit,
      maxHeight: Math.min(MAX_HEIGHT, window.innerHeight - top - MARGIN),
    };
  }

  function reveal() {
    void tick().then(() => {
      listEl?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
    });
  }

  function tabbable(): HTMLElement[] {
    return [...(root?.querySelectorAll<HTMLElement>('input, button:not(:disabled):not([tabindex="-1"])') ?? [])];
  }

  function cycleFocus(step: 1 | -1) {
    const items = tabbable();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length].focus();
  }

  function onKey(event: KeyboardEvent) {
    // 输入法选词时的方向键和回车属于输入法。
    if (event.isComposing) return;
    if (event.key === "Tab") {
      event.preventDefault();
      cycleFocus(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (event.target !== search) {
        cycleFocus(step);
      } else if (count > 0) {
        active = (active + step + count) % count;
        reveal();
      }
      return;
    }
    if (event.target !== search) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (count > 0) onChoose(active);
    } else if (isContextKey(event) && onItemContextMenu) {
      const row = listEl?.querySelector(`[data-index="${active}"]`);
      if (!row) return;
      event.preventDefault();
      onItemContextMenu(active, pointFor(row));
    }
  }

  /** 点弹层里的条目或空白处时焦点留在搜索框，否则方向键就失效了。 */
  function keepFocus(event: MouseEvent) {
    if (event.target !== search) event.preventDefault();
  }

  onMount(() => {
    measure();
    search?.focus();
    reveal();
    const outside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || root?.contains(target) || anchor.contains(target)) return;
      if (target.closest?.(".context-menu")) return;
      onClose(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      onClose(true);
    };
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", measure);
    };
  });
</script>

<div
  class="popover"
  role="dialog"
  aria-label={label}
  tabindex="-1"
  style={`top:${place.top}px;left:${place.left}px;width:${place.width}px;max-height:${place.maxHeight}px`}
  bind:this={root}
  onkeydown={onKey}
  onmousedown={keepFocus}
>
  <div class="popover-search">
    <div class="field sm">
      <Icon name="search" size={14} />
      <input
        role="combobox"
        aria-label={placeholder}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={count > 0 ? `${listId}-${active}` : undefined}
        {placeholder}
        autocomplete="off"
        spellcheck="false"
        bind:this={search}
        bind:value={query}
      />
      {#if query}
        <button type="button" class="field-clear" tabindex="-1" aria-label="清空搜索" onclick={() => (query = "")}>
          <Icon name="x" size={12} />
        </button>
      {/if}
    </div>
  </div>
  {@render notice?.()}
  <div class="popover-list" id={listId} role="listbox" aria-label={label} bind:this={listEl}>
    {@render list(listId)}
  </div>
  <div class="popover-foot">
    {@render foot()}
  </div>
</div>
