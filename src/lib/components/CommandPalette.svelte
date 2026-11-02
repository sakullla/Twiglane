<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import Icon from "./Icon.svelte";

  /**
   * 命令面板：动作由调用方的注册表提供（同一份数据也驱动标题栏、rail 与溢出菜单）。
   * 支持上下移动与回车执行；不可用动作就地显示原因；Esc 关闭并把焦点还给触发元素。
   * 键位挂在卡片上而非搜索框上：Tab 把焦点送进选项之后，Esc/方向键/回车仍然可用。
   */
  interface PaletteCommand {
    id: string;
    group: string;
    title: string;
    shortcut?: string;
    /** 只参与过滤、不显示：例如切换仓库时带上的仓库路径，让同名仓库也能按路径筛出。 */
    keywords?: string;
    enabled?: boolean;
    reason?: string;
    run: () => void;
  }

  interface Props {
    open: boolean;
    commands: PaletteCommand[];
    onClose: () => void;
    placeholder?: string;
  }

  let { open, commands, onClose, placeholder = "输入命令名称，或直接选择" }: Props = $props();

  let query = $state("");
  let active = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let card = $state<HTMLDivElement | null>(null);
  let previous: HTMLElement | null = null;

  /** 面板内可 Tab 的元素：搜索框 + 当前选中项（选项用游标式 tabindex 只留一个入口）。 */
  const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * 过滤串 = 标题 + 分组 + 可选的关键词。
   * 关键词只参与匹配、不进 DOM 文案：切换仓库的路径因此可搜，但选项上仍只显示仓库名。
   */
  let filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((item) =>
      `${item.title} ${item.group} ${item.keywords ?? ""}`.toLowerCase().includes(needle),
    );
  });

  let groups = $derived.by(() => {
    const order: string[] = [];
    const bucket = new Map<string, PaletteCommand[]>();
    for (const item of filtered) {
      if (!bucket.has(item.group)) {
        bucket.set(item.group, []);
        order.push(item.group);
      }
      bucket.get(item.group)?.push(item);
    }
    return order.map((name) => ({ name, items: bucket.get(name) ?? [] }));
  });

  $effect(() => {
    if (open) {
      query = "";
      active = 0;
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inputEl?.focus();
    } else if (previous) {
      const target = previous;
      previous = null;
      target.focus?.();
    }
  });

  function enabled(item: PaletteCommand): boolean {
    return item.enabled !== false;
  }

  function positionOf(item: PaletteCommand): number {
    return filtered.indexOf(item);
  }

  function runCommand(item: PaletteCommand) {
    if (!enabled(item)) return;
    item.run();
    onClose();
  }

  /** 选项在 DOM 里的展开顺序与 filtered 一致（分组按首次出现排序，组内保持原序）。 */
  function optionAt(index: number): HTMLElement | null {
    return card?.querySelectorAll<HTMLElement>(".palette-item")[index] ?? null;
  }

  function move(step: number) {
    if (filtered.length === 0) return;
    active = (active + step + filtered.length) % filtered.length;
    // 焦点已经落在某个选项上时，方向键要把焦点一起带走：
    // 否则高亮（aria-selected）跑到下一项、键盘焦点仍留在上一项，回车执行的和看到的不一致。
    const current = document.activeElement;
    if (current instanceof HTMLElement && current.classList.contains("palette-item")) optionAt(active)?.focus();
  }

  /** Tab / Shift+Tab 只在面板内首尾环绕，绝不回落到背后的主界面。 */
  function trapFocus(step: number) {
    if (!card) return;
    const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index === -1 ? items[0] : items[(index + step + items.length) % items.length];
    next?.focus();
  }

  /**
   * 键位统一挂在卡片上，靠冒泡覆盖面板内所有焦点位置。
   * 搜索框与选项都是卡片的后代，所以焦点落在选项上时 Esc/方向键/回车同样生效；
   * 只挂在搜索框上会让「Tab 进选项」之后的这几个键全部失效。
   * Space 不在这里：搜索框里的空格是输入内容，空格执行只留在选项自己那一支。
   */
  function onCardKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      // 面板自己吃掉 Esc：既关掉自己，也不让文档级快捷键（T5 键盘层）再关一次别的层
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      trapFocus(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[active];
      if (item) runCommand(item);
    }
  }

  function onBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }
</script>

{#if open}
  <div class="modal-backdrop palette-backdrop" role="presentation" onmousedown={onBackdrop}>
    <div
      class="modal-card palette-card"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      tabindex="-1"
      bind:this={card}
      onkeydown={onCardKeydown}
    >
      <div class="palette-search">
        <label class="sr-only" for="palette-input">搜索命令</label>
        <div class="field">
          <Icon name="search" size={14} />
          <input
            id="palette-input"
            bind:this={inputEl}
            bind:value={query}
            oninput={() => (active = 0)}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            autocomplete="off"
            spellcheck="false"
            {placeholder}
          />
          <kbd>{MODIFIER_LABEL} K</kbd>
        </div>
      </div>
      <div class="modal-body palette-body" id="palette-list" role="listbox" aria-label="命令">
        {#if filtered.length === 0}
          <p class="palette-empty">没有匹配的命令</p>
        {:else}
          {#each groups as group (group.name)}
            <div class="palette-group" role="group" aria-label={group.name}>
              <div class="palette-group-title">{group.name}</div>
              {#each group.items as item (item.id)}
                <div
                  class="menu-item palette-item"
                  class:active={filtered[active] === item}
                  role="option"
                  tabindex={filtered[active] === item ? 0 : -1}
                  aria-selected={filtered[active] === item}
                  aria-disabled={!enabled(item)}
                  onmouseenter={() => (active = positionOf(item))}
                  onclick={() => runCommand(item)}
                  onkeydown={(event) => {
                    // 只剩空格在选项本地处理（搜索框里的空格必须留给输入）；
                    // Esc / 方向键 / 回车统一由卡片上的 onCardKeydown 承担
                    if (event.key === " ") {
                      event.preventDefault();
                      runCommand(item);
                    }
                  }}
                >
                  <span>{item.title}</span>
                  <span class="spacer"></span>
                  {#if !enabled(item)}<small class="palette-reason">{item.reason ?? "当前不可用"}</small>{/if}
                  {#if item.shortcut}<kbd>{item.shortcut}</kbd>{/if}
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
