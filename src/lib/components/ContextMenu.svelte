<script module lang="ts">
  import type { IconName } from "../icons";

  export interface ContextMenuItem {
    id: string;
    label: string;
    icon?: IconName;
    /** 右侧的快捷键提示（只显示，不绑定）。 */
    shortcut?: string;
    /** 不可用时的原因：作为条目提示显示，条目本身不可点。 */
    disabledReason?: string;
    danger?: boolean;
    /** 开关类条目：给出时按 menuitemcheckbox 渲染，右侧显示勾选状态。 */
    checked?: boolean;
    /**
     * 二级菜单：给出时条目本身不执行动作，悬停、回车或 → 展开子菜单，← / Esc 收回。
     * 子菜单只支持一层嵌套之内的普通条目、分隔线与小标题（更深的嵌套同样可用，但不建议）。
     */
    submenu?: ContextMenuEntry[];
    run?: () => void;
  }

  export type ContextMenuEntry = ContextMenuItem | { separator: true } | { heading: string };

  export interface ContextMenuRequest {
    x: number;
    y: number;
    entries: ContextMenuEntry[];
    /** 屏幕阅读器读到的菜单名称。 */
    label: string;
  }

  export function isItem(entry: ContextMenuEntry): entry is ContextMenuItem {
    return "id" in entry;
  }

  /** 键盘唤起（Shift+F10 / 菜单键）时，菜单出现在元素左下角附近。 */
  export function pointFor(element: Element): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(rect.height, 28) };
  }

  export function isContextKey(event: KeyboardEvent): boolean {
    return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
  }

  /** 界面上的快捷键提示是给人看的符号（⌘ ⇧ Z），aria-keyshortcuts 只认键名，这里按位换成标准写法。 */
  const KEY_NAMES: Record<string, string> = {
    "⌘": "Meta", Cmd: "Meta", Command: "Meta", Meta: "Meta",
    "⌃": "Control", Ctrl: "Control", Control: "Control",
    "⇧": "Shift", Shift: "Shift",
    "⌥": "Alt", Alt: "Alt", Option: "Alt",
    "↵": "Enter", Enter: "Enter", Return: "Enter",
    "⌫": "Backspace", Backspace: "Backspace",
    "⎋": "Escape", Esc: "Escape", Escape: "Escape",
    "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown",
    Tab: "Tab", Del: "Delete", Delete: "Delete",
  };

  /** 把「⌘ ⇧ Z」这类提示换成「Meta+Shift+Z」；认不出的单位原样保留，至少不丢顺序。 */
  export function shortcutKeys(shortcut: string): string {
    const parts = shortcut
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part));
    return [...new Set(parts)].join("+");
  }

  /**
   * 最近一次输入是指针还是键盘：右键/点「更多」唤起时不预选第一项、不画焦点环（与系统菜单一致），
   * Shift+F10 / 菜单键唤起时仍聚焦第一项并显示焦点环。只认最近 1 秒内的按下，避免很久以前的点击影响判断。
   */
  let lastPointerDown = -Infinity;
  let lastKeyDown = -Infinity;
  if (typeof window !== "undefined") {
    window.addEventListener("pointerdown", () => (lastPointerDown = performance.now()), { capture: true, passive: true });
    window.addEventListener("keydown", () => (lastKeyDown = performance.now()), { capture: true, passive: true });
  }

  export function openedByPointer(now = typeof performance !== "undefined" ? performance.now() : 0): boolean {
    return lastPointerDown > lastKeyDown && now - lastPointerDown < 1000;
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";

  /**
   * 右键菜单：跟随指针定位，四条边靠近窗口边缘时都向内收，菜单始终完整留在视口内；方向键 / Home / End 移动，回车执行，
   * Esc、点外面、滚动或窗口失焦时关闭，关闭后把焦点还给唤起它的元素。
   * 不可用的条目不隐藏，而是灰显并在提示里说明原因——动作在哪里、为什么点不动都看得见。
   *
   * 二级菜单：带 submenu 的条目悬停片刻、点击、回车或 → 展开，子菜单贴在条目右侧（右侧放不下时翻到左侧）；
   * ← 或 Esc 只收回这一层并把焦点还给父条目。各层按栈管理，任何时候最多一条展开链。
   */
  interface Props {
    request: ContextMenuRequest;
    onClose: () => void;
  }

  let { request, onClose }: Props = $props();

  interface Level {
    entries: ContextMenuEntry[];
    label: string;
    left: number;
    top: number;
    /** 当前项（键盘焦点或指针悬停）。 */
    active: number;
    /** 展开这一层的父条目下标；根层为 -1。 */
    owner: number;
    /** 量过尺寸并钳到视口内之前不显示，避免先闪一下再挪位置。 */
    placed: boolean;
  }

  const MARGIN = 8;
  /** 悬停展开/收起子菜单的延迟：斜着移向子菜单时经过别的条目，不会立刻把它收掉。 */
  const HOVER_DELAY = 150;

  let levels = $state<Level[]>(
    untrack(() => [{ entries: request.entries, label: request.label, left: request.x, top: request.y, active: -1, owner: -1, placed: false }]),
  );
  let panels = $state<(HTMLDivElement | null)[]>([]);
  // 指针操作时当前项只用底色标出；一按键就切回键盘模式，焦点环立刻出现。
  let input = $state<"pointer" | "keyboard">(openedByPointer() ? "pointer" : "keyboard");
  const returnFocus = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  function hasIcons(entries: ContextMenuEntry[]): boolean {
    return entries.some((entry) => isItem(entry) && entry.icon);
  }

  function enabledIndexes(entries: ContextMenuEntry[]): number[] {
    return entries
      .map((entry, index) => (isItem(entry) && !entry.disabledReason ? index : -1))
      .filter((index) => index >= 0);
  }

  /**
   * 相邻几项因同一原因不可用（如「剪切 / 复制」都「没有选中的文本」）时，原因只在这一组的最后一项下写一次，
   * 像一条组脚注；组内各项的 aria-describedby 指向同一段说明——读屏与悬停提示不变，只是画面不再重复。
   */
  function reasonOwner(entries: ContextMenuEntry[], index: number): number {
    const entry = entries[index];
    if (!entry || !isItem(entry) || !entry.disabledReason) return -1;
    let at = index;
    while (at + 1 < entries.length) {
      const next = entries[at + 1];
      if (!isItem(next) || next.disabledReason !== entry.disabledReason) break;
      at += 1;
    }
    return at;
  }

  function clearHover() {
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = null;
  }

  function close(restore = true) {
    clearHover();
    onClose();
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function itemElement(depth: number, index: number): HTMLElement | null {
    return panels[depth]?.querySelector<HTMLElement>(`[data-entry="${index}"]`) ?? null;
  }

  function focusIndex(depth: number, index: number) {
    const level = levels[depth];
    if (!level) return;
    level.active = index;
    void tick().then(() => itemElement(depth, index)?.focus({ preventScroll: true }));
  }

  /** 收起 depth 及更深的各层（depth ≥ 1）。 */
  function closeFrom(depth: number) {
    if (depth < 1 || levels.length <= depth) return;
    levels.splice(depth);
  }

  /** 收回最深一层，把焦点还给展开它的父条目。 */
  function closeLevel(depth: number) {
    const owner = levels[depth]?.owner ?? -1;
    closeFrom(depth);
    if (owner >= 0) {
      input = "keyboard";
      focusIndex(depth - 1, owner);
    }
  }

  async function openSubmenu(depth: number, index: number, focusFirst: boolean) {
    clearHover();
    const entry = levels[depth]?.entries[index];
    if (!entry || !isItem(entry) || !entry.submenu || entry.disabledReason) return;
    if (levels[depth + 1]?.owner !== index) {
      closeFrom(depth + 1);
      const anchor = itemElement(depth, index)?.getBoundingClientRect();
      levels.push({
        entries: entry.submenu,
        label: entry.label,
        left: anchor ? anchor.right + 2 : 0,
        top: anchor ? anchor.top - 5 : 0,
        active: -1,
        owner: index,
        placed: false,
      });
      await tick();
      place(depth + 1);
    }
    if (focusFirst) {
      const enabled = enabledIndexes(entry.submenu);
      if (enabled.length > 0) focusIndex(depth + 1, enabled[0]);
    }
  }

  /** 把一层钳到视口内：子菜单右侧放不下时翻到父菜单左侧。 */
  function place(depth: number) {
    const level = levels[depth];
    const rect = panels[depth]?.getBoundingClientRect();
    if (!level || !rect || typeof window === "undefined") {
      if (level) level.placed = true;
      return;
    }
    const maxLeft = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    let left = level.left;
    if (depth > 0 && left + rect.width > window.innerWidth - MARGIN) {
      const parent = panels[depth - 1]?.getBoundingClientRect();
      if (parent) left = parent.left - rect.width - 2;
    }
    // 四条边都要钳制：键盘唤起或指针落在贴边/贴底的行上时，坐标可能越界甚至为负。
    level.left = Math.min(Math.max(left, MARGIN), maxLeft);
    level.top = Math.min(Math.max(level.top, MARGIN), maxTop);
    level.placed = true;
  }

  function run(depth: number, index: number) {
    const entry = levels[depth]?.entries[index];
    if (!entry || !isItem(entry) || entry.disabledReason) return;
    if (entry.submenu) {
      void openSubmenu(depth, index, input === "keyboard");
      return;
    }
    close(true);
    entry.run?.();
  }

  function move(depth: number, step: 1 | -1) {
    const level = levels[depth];
    const enabled = enabledIndexes(level.entries);
    if (enabled.length === 0) return;
    const at = enabled.indexOf(level.active);
    const next = at === -1 ? (step === 1 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length;
    closeFrom(depth + 1);
    focusIndex(depth, enabled[next]);
  }

  function onKey(event: KeyboardEvent, depth: number) {
    event.stopPropagation();
    input = "keyboard";
    clearHover();
    const level = levels[depth];
    if (!level) return;
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (depth > 0) closeLevel(depth);
      else close(true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (depth > 0) closeLevel(depth);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const entry = level.entries[level.active];
      if (entry && isItem(entry) && entry.submenu) void openSubmenu(depth, level.active, true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(depth, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(depth, -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const enabled = enabledIndexes(level.entries);
      if (enabled.length > 0) {
        closeFrom(depth + 1);
        focusIndex(depth, event.key === "Home" ? enabled[0] : enabled[enabled.length - 1]);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (level.active >= 0) run(depth, level.active);
    } else if (event.key.length === 1) {
      // 首字匹配：按下条目名称的第一个字符跳过去（同首字时依次循环）。
      const enabled = enabledIndexes(level.entries);
      const start = Math.max(0, enabled.indexOf(level.active) + 1);
      const order = [...enabled.slice(start), ...enabled.slice(0, start)];
      const hit = order.find((index) => {
        const entry = level.entries[index];
        return isItem(entry) && entry.label.toLowerCase().startsWith(event.key.toLowerCase());
      });
      if (hit !== undefined) {
        closeFrom(depth + 1);
        focusIndex(depth, hit);
      }
    }
  }

  /** 指针悬停：子菜单条目延迟展开；停到同层别的条目上则延迟收起更深的层。 */
  function hover(depth: number, index: number, entry: ContextMenuItem) {
    input = "pointer";
    const level = levels[depth];
    if (!entry.disabledReason && level.active !== index) focusIndex(depth, index);
    const child = levels[depth + 1];
    if (entry.submenu && !entry.disabledReason) {
      if (child?.owner === index) {
        clearHover();
        return;
      }
      clearHover();
      hoverTimer = setTimeout(() => void openSubmenu(depth, index, false), HOVER_DELAY);
    } else if (child) {
      clearHover();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        closeFrom(depth + 1);
      }, HOVER_DELAY);
    }
  }

  // 菜单开着时又在别处右键：宿主换了 request 而不重建组件，这里收起子菜单、按新坐标重排根层。
  let shownRequest = untrack(() => request);
  $effect.pre(() => {
    const next = request;
    if (next === shownRequest) return;
    shownRequest = next;
    untrack(() => {
      clearHover();
      levels = [{ entries: next.entries, label: next.label, left: next.x, top: next.y, active: -1, owner: -1, placed: false }];
      void tick().then(() => place(0));
    });
  });

  onMount(() => {
    place(0);
    const enabled = enabledIndexes(request.entries);
    if (enabled.length > 0 && input === "keyboard") focusIndex(0, enabled[0]);
    else panels[0]?.focus({ preventScroll: true });

    const outside = (event: MouseEvent) => {
      if (!panels.some((panel) => panel?.contains(event.target as Node))) close(false);
    };
    const dismiss = () => close(false);
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("wheel", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      clearHover();
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  });
</script>

{#each levels as level, depth (depth)}
  {@const icons = hasIcons(level.entries)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="menu context-menu"
    class:context-submenu={depth > 0}
    class:has-icons={icons}
    data-input={input}
    data-depth={depth}
    role="menu"
    aria-label={level.label}
    aria-orientation="vertical"
    tabindex="-1"
    style={`left:${level.left}px;top:${level.top}px${level.placed ? "" : ";visibility:hidden"}`}
    bind:this={panels[depth]}
    onkeydown={(event) => onKey(event, depth)}
    onmouseenter={() => {
      // 指针进入子菜单：取消「收起这一层」的计时，父条目保持高亮。
      if (depth > 0) clearHover();
    }}
    onmouseleave={() => {
      // 指针移出菜单时不再假装「停在某一项上」；展开着子菜单的父条目和键盘导航中的当前项保持不动。
      if (input !== "pointer" || level.active === -1 || levels.length > depth + 1) return;
      level.active = -1;
      panels[depth]?.focus({ preventScroll: true });
    }}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each level.entries as entry, index (index)}
      {#if "separator" in entry}
        <div class="menu-sep" role="separator"></div>
      {:else if "heading" in entry}
        <div class="menu-label" role="presentation">{entry.heading}</div>
      {:else}
        {@const expanded = levels[depth + 1]?.owner === index}
        <button
          type="button"
          class="menu-item context-item"
          class:danger={entry.danger}
          class:active={index === level.active || expanded}
          role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={entry.checked === undefined ? undefined : entry.checked}
          aria-haspopup={entry.submenu ? "menu" : undefined}
          aria-expanded={entry.submenu ? expanded : undefined}
          tabindex="-1"
          data-entry={index}
          aria-disabled={entry.disabledReason ? "true" : undefined}
          aria-describedby={entry.disabledReason ? `context-reason-${depth}-${reasonOwner(level.entries, index)}` : undefined}
          aria-label={entry.label}
          aria-keyshortcuts={entry.shortcut ? shortcutKeys(entry.shortcut) : undefined}
          title={entry.disabledReason ?? undefined}
          onmousemove={() => hover(depth, index, entry)}
          onclick={() => run(depth, index)}
        >
          {#if icons}<span class="context-icon">{#if entry.icon}<Icon name={entry.icon} size={14} />{/if}</span>{/if}
          <span class="context-copy">
            <span class="context-label">{entry.label}</span>
            {#if entry.disabledReason && reasonOwner(level.entries, index) === index}<small id={`context-reason-${depth}-${index}`}>{entry.disabledReason}</small>{/if}
          </span>
          {#if entry.shortcut}<kbd class="context-key">{entry.shortcut}</kbd>{/if}
          {#if entry.checked !== undefined}
            <span class="context-check" class:on={entry.checked} aria-hidden="true"><Icon name="check" size={13} /></span>
          {/if}
          {#if entry.submenu}
            <span class="context-arrow" aria-hidden="true"><Icon name="chevron-right" size={13} /></span>
          {/if}
        </button>
      {/if}
    {/each}
    {#if !level.entries.some((entry) => isItem(entry))}
      <div class="menu-label">没有可用的操作</div>
    {/if}
  </div>
{/each}
