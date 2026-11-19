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
   * 位置只在挂载时（首帧前）量一次，之后只随窗口尺寸或包含块动画结束重算：不做固定延时重测，
   * 也不用自身的入场动画参与几何计算，避免「先摆放、动画结束后再跳回去」。
   */
  interface Props {
    /** 触发按钮：定位基准，也是关闭后焦点回去的地方。 */
    anchor: HTMLElement;
    label: string;
    placeholder: string;
    /** 搜索框的可访问名称；缺省同 placeholder。 */
    searchLabel?: string;
    /** 选项很少时不放搜索框：焦点留在弹层本身，方向键与回车照样工作。 */
    searchable?: boolean;
    query: string;
    active: number;
    /** 列表条目数；方向键在 0…count-1 之间循环。 */
    count: number;
    width?: number;
    /** 至少和触发按钮一样宽（表单里的下拉框）。 */
    matchAnchor?: boolean;
    /** 最高多少像素；长列表（仓库切换）可以给得更高，仍收在窗口内。 */
    maxHeight?: number;
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
    searchable = true,
    query = $bindable(),
    active = $bindable(),
    count,
    width = 400,
    matchAnchor = false,
    maxHeight = 480,
    onChoose,
    onItemContextMenu,
    onClose,
    list,
    notice,
    foot,
  }: Props = $props();

  const MARGIN = 8;
  const GAP = 6;
  const MAX_HEIGHT = untrack(() => maxHeight);
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

  /**
   * 贴着触发按钮向下展开，并收在窗口内：900×600 下也要完整可见（R14）。下方太挤而上方更宽时向上展开。
   * 方向在首次显示前就定下来，之后内容增减只改高度，贴着触发按钮的那条边不动。
   */
  function measure() {
    const rect = anchorEl.getBoundingClientRect();
    const fit = Math.min(matchAnchor ? Math.max(width, rect.width) : width, window.innerWidth - MARGIN * 2);
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - fit - MARGIN));
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    // 弹窗里的下拉：带变换的祖先会成为 fixed 的包含块，坐标要扣掉它的原点，否则整体偏移。
    const origin = containingOrigin();
    if (below < 280 && above > below) {
      place = { top: null, bottom: window.innerHeight - rect.top + GAP - origin.bottom, left: left - origin.left, width: fit, maxHeight: Math.min(MAX_HEIGHT, above) };
      return;
    }
    place = { top: rect.bottom + GAP - origin.top, bottom: null, left: left - origin.left, width: fit, maxHeight: Math.min(MAX_HEIGHT, below) };
  }

  /**
   * fixed 定位的包含块原点：视口时为 0；被接管 fixed 的祖先（变换、contain、content-visibility 等）
   * 接管时是那个祖先的左上（以及到视口底的距离）。
   * 只从祖先取，不拿弹层自己的矩形反推：入场变换会让弹层矩形和它的相邻边一起偏移，
   * 「矩形 − 内联 top」减出来的原点就把动画位移算成了包含块偏移——首次摆放偏低，动画结束后
   * 再量一次才回到正确位置，看起来就是打开后向上回跳。位置因此必须先于任何自身变换确定。
   */
  function containingOrigin(): { left: number; top: number; bottom: number } {
    const block = fixedContainingBlock(root);
    if (!block) return { left: 0, top: 0, bottom: 0 };
    const box = block.getBoundingClientRect();
    const style = getComputedStyle(block);
    return {
      left: box.left + px(style.borderLeftWidth),
      top: box.top + px(style.borderTopWidth),
      bottom: window.innerHeight - box.bottom + px(style.borderBottomWidth),
    };
  }

  /**
   * 会接管 fixed 后代的最近祖先：带变换、滤镜、透视、contain、will-change 或 content-visibility 的那一层。
   * contain 只认 layout/paint/strict/content，container-type 不列入：实测 container-type（inline-size/size）
   * 不会成为 fixed 后代的包含块，把它算进来反而会扣掉不该扣的偏移。
   * content-visibility 的 auto/hidden 会带上 layout 与 paint 包含，同样接管 fixed 后代；
   * 枚举漏掉它时弹层会按视口原点摆放，而浏览器按那个祖先定位，整块偏移且没有任何报错。
   */
  function fixedContainingBlock(from: HTMLElement | null): HTMLElement | null {
    for (let node = from?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        moved(style.transform) || moved(style.filter) || moved(style.backdropFilter) || moved(style.perspective)
        || /(^|\s)(paint|layout|strict|content)(\s|$)/.test(style.contain ?? "")
        || /transform|filter|perspective|backdrop-filter/.test(style.willChange ?? "")
        || skippedContent(style.contentVisibility)
      ) return node;
    }
    return null;
  }

  /** content-visibility 只有 visible（默认）不创建包含块；auto/hidden 都带 layout 与 paint 包含。 */
  function skippedContent(value: string | undefined): boolean {
    return value != null && value !== "" && value !== "visible";
  }

  /** 计算值可能是 none 或空（未实现该属性）：只有真正的非空非 none 才创建包含块。 */
  function moved(value: string | undefined): boolean {
    return value != null && value !== "" && value !== "none";
  }

  function px(value: string | undefined): number {
    return parseFloat(value ?? "") || 0;
  }

  /** 方向键与回车作用的元素：有搜索框时是搜索框，没有时是弹层本身。 */
  function keyTarget(): HTMLElement | null {
    return searchable ? search : listEl;
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
    // 在弹层内就把 Esc 消费掉：有搜索词时先清空关键词，空着再按才收起弹层，也不让外层 modal 跟着关闭。
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (searchable && query.length > 0) {
        query = "";
        search?.focus();
        return;
      }
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (!foot) close(true);
      else cycleFocus(event.shiftKey ? -1 : 1);
      return;
    }
    const ctrlMove =
      event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        ? event.key.toLowerCase() === "n"
          ? 1
          : event.key.toLowerCase() === "p"
            ? -1
            : 0
        : 0;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || ctrlMove !== 0) {
      event.preventDefault();
      const step = ctrlMove !== 0 ? ctrlMove : event.key === "ArrowDown" ? 1 : -1;
      if (event.target !== keyTarget()) {
        cycleFocus(step);
      } else if (count > 0) {
        active = (active + step + count) % count;
        reveal();
      }
      return;
    }
    if (event.target !== keyTarget()) return;
    if ((event.key === "PageDown" || event.key === "PageUp") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (count === 0) return;
      event.preventDefault();
      active = event.key === "PageDown" ? Math.min(count - 1, active + 8) : Math.max(0, active - 8);
      reveal();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (searchable || count === 0) return;
      event.preventDefault();
      active = event.key === "Home" ? 0 : count - 1;
      reveal();
      return;
    }
    if (event.key === "Enter" || (!searchable && event.key === " ")) {
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
    if (searchable) search?.focus();
    else listEl?.focus({ preventScroll: true });
    reveal();
    const outside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || root?.contains(target) || anchorEl.contains(target)) return;
      if (target.closest?.(".context-menu")) return;
      close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector(".context-menu")) return;
      event.preventDefault();
      if (searchable && query.length > 0) {
        query = "";
        search?.focus();
        return;
      }
      close(true);
    };
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", measure);
    // 弹窗里的下拉：外层弹窗的进场缩放还在跑时，包含块坐标本身在变，量到的位置会偏。
    // 等那层动画真正结束再量一次，而不是用一个固定延时去猜（延时会在无关动画中途插一脚，制造第二次位移）。
    const settle = settleWhenContainingBlockStopsMoving();
    return () => {
      settle();
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", measure);
    };
  });

  /**
   * 包含块正在播动画（例如外层弹窗的进场）时，动画结束后的坐标才稳定。
   * 没有这种祖先、或浏览器不支持 getAnimations 时什么都不做：位置已经由首次测量定下。
   */
  function settleWhenContainingBlockStopsMoving(): () => void {
    const block = fixedContainingBlock(root);
    if (!block || typeof block.getAnimations !== "function") return () => {};
    let alive = true;
    for (const animation of block.getAnimations()) {
      if (animation.playState !== "running") continue;
      animation.finished.then(() => { if (alive) measure(); }, () => {});
    }
    return () => { alive = false; };
  }
</script>

<div
  class="popover"
  role="dialog"
  aria-label={label}
  tabindex="-1"
  data-side={place.top !== null ? "down" : "up"}
  style={placeStyle}
  bind:this={root}
  onkeydown={onKey}
  onmousedown={keepFocus}
>
  {#if searchable}
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
  {/if}
  {@render notice?.()}
  <div
    class="popover-list"
    id={listId}
    role="listbox"
    aria-label={label}
    tabindex={searchable ? undefined : -1}
    aria-activedescendant={!searchable && count > 0 ? `${listId}-${active}` : undefined}
    bind:this={listEl}
  >
    {@render list(listId)}
  </div>
  {#if foot}
    <div class="popover-foot">
      {@render foot()}
    </div>
  {/if}
</div>
