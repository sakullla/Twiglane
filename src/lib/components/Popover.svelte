<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { isContextKey, pointFor } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 标题栏可搜索弹层的共用外壳：定位、搜索框、方向键、点外面关闭、Esc 与焦点返回。
   * 焦点留在搜索框，列表靠 aria-activedescendant 表达当前项，这样边输入边选不用来回切焦点；
   * 底部动作是普通按钮，Tab 在搜索框与它们之间循环。
   * 右键菜单叠在弹层上时不算「点外面」，它的 Esc 也由菜单自己消费，只关闭菜单这一层。
   * 表单里的下拉框（BranchPicker）也用它：没有底部动作时 Tab 收起弹层，下方放不下时向上展开。
   */
  interface Props {
    /** 触发按钮：定位基准，也是关闭后焦点回去的地方。 */
    anchor: HTMLElement;
    label: string;
    placeholder: string;
    /** 搜索框的可访问名称；缺省同 placeholder。 */
    searchLabel?: string;
    query: string;
    active: number;
    /** 列表条目数；方向键在 0…count-1 之间循环。 */
    count: number;
    width?: number;
    /** 至少和触发按钮一样宽（表单里的下拉框）。 */
    matchAnchor?: boolean;
    onChoose: (index: number) => void;
    onItemContextMenu?: (index: number, point: { x: number; y: number }) => void;
    /** refocus：是否把焦点还给触发按钮。点外面关闭时焦点已经在用户点的地方。 */
    onClose: (refocus: boolean) => void;
    /** 列表内容；参数是 listbox 的 id，条目 id 为 `${id}-${index}`。 */
    list: Snippet<[string]>;
    notice?: Snippet;
    foot?: Snippet;
  }

  let {
    anchor,
    label,
    placeholder,
    searchLabel,
    query = $bindable(),
    active = $bindable(),
    count,
    width = 400,
    matchAnchor = false,
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
  /** 触发按钮在打开期间不会换人；先抓成普通常量，卸载后异步续体不再读父组件的响应式 prop。 */
  const anchorEl = untrack(() => anchor);

  let root = $state<HTMLDivElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  /** 向下展开时 top 有值；向上展开时贴住触发按钮上沿，用 bottom 定位，高度由内容决定。 */
  let place = $state<{ top: number | null; bottom: number | null; left: number; width: number; maxHeight: number }>({
    top: 0,
    bottom: null,
    left: 0,
    width: 0,
    maxHeight: MAX_HEIGHT,
  });
  let placeStyle = $derived(
    `${place.top !== null ? `top:${place.top}px` : `bottom:${place.bottom}px`};left:${place.left}px;width:${place.width}px;max-height:${place.maxHeight}px`,
  );

  /** 贴着触发按钮向下展开，并收在窗口内：900×600 下也要完整可见（R14）。下方太挤而上方更宽时向上展开。 */
  function measure() {
    const rect = anchorEl.getBoundingClientRect();
    const fit = Math.min(matchAnchor ? Math.max(width, rect.width) : width, window.innerWidth - MARGIN * 2);
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - fit - MARGIN));
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    if (below < 280 && above > below) {
      place = { top: null, bottom: window.innerHeight - rect.top + GAP, left, width: fit, maxHeight: Math.min(MAX_HEIGHT, above) };
      return;
    }
    place = { top: rect.bottom + GAP, bottom: null, left, width: fit, maxHeight: Math.min(MAX_HEIGHT, below) };
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
    const next = at === -1 ? (step === 1 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next]?.focus();
  }

  /**
   * 关闭弹层：是否归还焦点由调用方语义决定（点外面关闭时不抢焦点）。
   * 归还时等这次更新落定后再兜底：调用方通常自己聚焦触发按钮；若它没有处理、
   * 焦点已经掉到 body，就由外壳保证回到 anchor——命令面板、菜单和弹窗的
   * 「关闭后焦点返回」因此是同一套保证，而不是每个调用点各写一遍。
   */
  function close(refocus: boolean) {
    onClose(refocus);
    if (!refocus) return;
    void tick().then(() => {
      if (!anchorEl.isConnected) return;
      const focused = document.activeElement;
      if (focused === null || focused === document.body) anchorEl.focus({ preventScroll: true });
    });
  }

  function onKey(event: KeyboardEvent) {
    // 输入法选词时的方向键和回车属于输入法。
    if (event.isComposing) return;
    // 在弹层内就把 Esc 消费掉：弹层开在 modal 里时，只收起弹层，不让 modal 跟着关闭。
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (!foot) close(true);
      else cycleFocus(event.shiftKey ? -1 : 1);
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
      if (!target || root?.contains(target) || anchorEl.contains(target)) return;
      if (target.closest?.(".context-menu")) return;
      close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      close(true);
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
  style={placeStyle}
  bind:this={root}
  onkeydown={onKey}
  onmousedown={keepFocus}
>
  <div class="popover-search">
    <div class="field sm">
      <Icon name="search" size={14} />
      <input
        role="combobox"
        aria-label={searchLabel ?? placeholder}
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
  {#if foot}
    <div class="popover-foot">
      {@render foot()}
    </div>
  {/if}
</div>
