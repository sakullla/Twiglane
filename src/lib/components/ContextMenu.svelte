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
    run: () => void;
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
</script>

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";

  /**
   * 右键菜单：跟随指针定位，四条边靠近窗口边缘时都向内收，菜单始终完整留在视口内；方向键 / Home / End 移动，回车执行，
   * Esc、点外面、滚动或窗口失焦时关闭，关闭后把焦点还给唤起它的元素。
   * 不可用的条目不隐藏，而是灰显并在提示里说明原因——动作在哪里、为什么点不动都看得见。
   */
  interface Props {
    request: ContextMenuRequest;
    onClose: () => void;
  }

  let { request, onClose }: Props = $props();

  let menu = $state<HTMLDivElement | null>(null);
  // 初始位置取唤起时的指针坐标；挂载后再按菜单尺寸向内翻转。
  let position = $state(untrack(() => ({ left: request.x, top: request.y })));
  let active = $state(-1);
  const returnFocus = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let items = $derived(request.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => isItem(entry)));

  function enabledIndexes(): number[] {
    return request.entries
      .map((entry, index) => (isItem(entry) && !entry.disabledReason ? index : -1))
      .filter((index) => index >= 0);
  }

  function close(restore = true) {
    onClose();
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function run(entry: ContextMenuItem) {
    if (entry.disabledReason) return;
    close(true);
    entry.run();
  }

  function focusIndex(index: number) {
    active = index;
    void tick().then(() => menu?.querySelector<HTMLElement>(`[data-entry="${index}"]`)?.focus({ preventScroll: true }));
  }

  function move(step: 1 | -1) {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at === -1 ? (step === 1 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length;
    focusIndex(enabled[next]);
  }

  function onKey(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const enabled = enabledIndexes();
      if (enabled.length > 0) focusIndex(event.key === "Home" ? enabled[0] : enabled[enabled.length - 1]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = request.entries[active];
      if (entry && isItem(entry)) run(entry);
    } else if (event.key.length === 1) {
      // 首字匹配：按下条目名称的第一个字符跳过去（同首字时依次循环）。
      const enabled = enabledIndexes();
      const start = Math.max(0, enabled.indexOf(active) + 1);
      const order = [...enabled.slice(start), ...enabled.slice(0, start)];
      const hit = order.find((index) => {
        const entry = request.entries[index];
        return isItem(entry) && entry.label.toLowerCase().startsWith(event.key.toLowerCase());
      });
      if (hit !== undefined) focusIndex(hit);
    }
  }

  onMount(() => {
    const rect = menu?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      // 四条边都要钳制：键盘唤起或指针落在贴边/贴底的行上时，坐标可能越界甚至为负。
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const left = Math.min(Math.max(request.x, margin), maxLeft);
      const top = Math.min(Math.max(request.y, margin), maxTop);
      position = { left, top };
    }
    const enabled = enabledIndexes();
    if (enabled.length > 0) focusIndex(enabled[0]);
    else menu?.focus({ preventScroll: true });

    const outside = (event: MouseEvent) => {
      if (menu && !menu.contains(event.target as Node)) close(false);
    };
    const dismiss = () => close(false);
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("wheel", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="menu context-menu"
  role="menu"
  aria-label={request.label}
  aria-orientation="vertical"
  tabindex="-1"
  style={`left:${position.left}px;top:${position.top}px`}
  bind:this={menu}
  onkeydown={onKey}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each request.entries as entry, index (index)}
    {#if "separator" in entry}
      <div class="menu-sep" role="separator"></div>
    {:else if "heading" in entry}
      <div class="menu-label" role="presentation">{entry.heading}</div>
    {:else}
      <button
        type="button"
        class="menu-item context-item"
        class:danger={entry.danger}
        class:active={index === active}
        role="menuitem"
        tabindex="-1"
        data-entry={index}
        aria-disabled={entry.disabledReason ? "true" : undefined}
        aria-describedby={entry.disabledReason ? `context-reason-${index}` : undefined}
        aria-label={entry.label}
        aria-keyshortcuts={entry.shortcut ? shortcutKeys(entry.shortcut) : undefined}
        title={entry.disabledReason ?? undefined}
        onmousemove={() => {
          if (!entry.disabledReason && active !== index) focusIndex(index);
        }}
        onclick={() => run(entry)}
      >
        {#if entry.icon}<Icon name={entry.icon} size={14} />{:else}<span class="context-icon-gap"></span>{/if}
        <span class="context-copy">
          <span class="context-label">{entry.label}</span>
          {#if entry.disabledReason}<small id={`context-reason-${index}`}>{entry.disabledReason}</small>{/if}
        </span>
        {#if entry.shortcut}<kbd>{entry.shortcut}</kbd>{/if}
      </button>
    {/if}
  {/each}
  {#if items.length === 0}
    <div class="menu-label">没有可用的操作</div>
  {/if}
</div>
