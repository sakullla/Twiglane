<script module lang="ts">
  import type { IconName } from "../icons";

  export interface SelectMenuOption {
    value: string;
    label: string;
    /** 第二行的弱化说明（数量、路径、来源等）。 */
    detail?: string;
    /** 左侧图标；给了 badge 时改画字母徽章。 */
    icon?: IconName;
    /** 字母徽章（项目名首字）与它的色相；同一项目在各处颜色一致。 */
    badge?: string;
    hue?: number;
    /** 右侧的小标签，例如「共享」「当前」。 */
    tag?: string;
    disabledReason?: string;
  }

  export interface SelectMenuAction {
    id: string;
    label: string;
    icon?: IconName;
    disabledReason?: string | null;
    run: () => void;
  }
</script>

<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 项目与来源用的下拉框：替代原生 select。原生菜单在 macOS 上是系统蓝条、不能放说明与动作，
   * 这里与仓库/分支弹层同一套外壳（Popover）：选项可带徽章和第二行说明，底部放「管理」类动作，
   * 选项多时出现搜索框。触发按钮与分支下拉同样是带 aria-haspopup 的按钮，当前值写在 data-value 与提示里。
   */
  interface Props {
    /** 触发按钮的可访问名称。 */
    label: string;
    value: string;
    options: SelectMenuOption[];
    actions?: SelectMenuAction[];
    placeholder?: string;
    disabled?: boolean;
    disabledReason?: string;
    /** field：表单里的整行；chip：标题栏、横条里的紧凑标签。 */
    variant?: "field" | "chip";
    /** 触发按钮左侧固定图标（不随选中项变化）。 */
    icon?: IconName;
    /** 触发按钮上的文字；缺省为选中项的名称。 */
    text?: string;
    /** 在触发按钮上点一个提示点（例如名单有问题）。 */
    dot?: boolean;
    /** 放在标题栏交互槽位时标上 data-titlebar-control：既走内收焦点环，也不参与窗口拖拽。 */
    titlebarControl?: boolean;
    title?: string;
    width?: number;
    searchPlaceholder?: string;
    class?: string;
    onChange: (value: string) => void;
    /** 触发按钮内容的完全自定义（替换图标与文字，箭头仍由组件画）。 */
    trigger?: Snippet;
  }

  let {
    label,
    value,
    options,
    actions = [],
    placeholder = "请选择",
    disabled = false,
    disabledReason,
    variant = "field",
    icon,
    text,
    dot = false,
    titlebarControl = false,
    title,
    width = 360,
    searchPlaceholder = "搜索",
    class: className = "",
    onChange,
    trigger: triggerContent,
  }: Props = $props();

  const SEARCH_FROM = 8;

  let open = $state(false);
  let query = $state("");
  let active = $state(0);
  let button = $state<HTMLButtonElement | null>(null);

  let selected = $derived(options.find((option) => option.value === value) ?? null);
  let searchable = $derived(options.length >= SEARCH_FROM);
  let shown = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((option) => [option.label, option.detail, option.tag].some((part) => part?.toLocaleLowerCase().includes(needle)));
  });

  function show() {
    if (disabled) return;
    query = "";
    const at = options.findIndex((option) => option.value === value);
    active = Math.max(0, at);
    open = true;
  }

  function hide(refocus = true) {
    open = false;
    if (refocus) button?.focus({ preventScroll: true });
  }

  function choose(option: SelectMenuOption | undefined) {
    if (!option || option.disabledReason) return;
    hide();
    if (option.value !== value) onChange(option.value);
  }

  function run(action: SelectMenuAction) {
    if (action.disabledReason) return;
    hide(false);
    action.run();
  }

  // 搜索词变化时当前项回到第一个匹配，不停在已经被筛掉的位置上。
  $effect(() => {
    void query;
    untrack(() => {
      if (active >= shown.length) active = Math.max(0, shown.length - 1);
      if (query) active = 0;
    });
  });
</script>

{#snippet actionFoot()}
  {#each actions as action (action.id)}
    <button type="button" class="menu-item select-menu-action" disabled={Boolean(action.disabledReason)} title={action.disabledReason ?? action.label} onclick={() => run(action)}>
      {#if action.icon}<Icon name={action.icon} size={14} />{/if}
      <span>{action.label}</span>
    </button>
  {/each}
{/snippet}

<div class={`select-menu is-${variant} ${className}`}>
  <button
    type="button"
    class="select-menu-trigger"
    data-titlebar-control={titlebarControl ? "" : undefined}
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    data-value={value}
    title={disabled ? disabledReason : (title ?? (selected ? [selected.label, selected.detail].filter(Boolean).join(" · ") : undefined))}
    {disabled}
    bind:this={button}
    onclick={() => (open ? hide() : show())}
    onkeydown={(event) => {
      if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        show();
      }
    }}
  >
    {#if triggerContent}
      {@render triggerContent()}
    {:else}
      {#if icon}
        <Icon name={icon} size={variant === "chip" ? 14 : 15} />
      {:else if selected?.badge}
        <span class="select-menu-badge sm" style={"--hue:" + (selected.hue ?? 238)} aria-hidden="true">{selected.badge}</span>
      {:else if selected?.icon}
        <Icon name={selected.icon} size={variant === "chip" ? 14 : 15} />
      {/if}
      <span class="select-menu-text" class:empty={!selected && !text}>{text ?? selected?.label ?? placeholder}</span>
      {#if variant === "field" && selected?.tag}<span class="select-menu-tag">{selected.tag}</span>{/if}
    {/if}
    {#if dot}<span class="select-menu-dot" aria-hidden="true"></span>{/if}
    <Icon name="chevron-down" size={12} class={open ? "flip select-menu-caret" : "select-menu-caret"} />
  </button>

  {#if open && button}
    <Popover
      anchor={button}
      {label}
      {searchable}
      placeholder={searchPlaceholder}
      bind:query
      bind:active
      count={shown.length}
      {width}
      matchAnchor={variant === "field"}
      onChoose={(index) => choose(shown[index])}
      onClose={(refocus) => hide(refocus)}
      foot={actions.length ? actionFoot : undefined}
    >
      {#snippet list(listId)}
        {#each shown as option, index (option.value)}
          <div
            id={listId + "-" + index}
            class="select-menu-option"
            class:active={index === active}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabledReason ? "true" : undefined}
            data-index={index}
            data-value={option.value}
            title={option.disabledReason ?? option.detail ?? option.label}
            tabindex="-1"
            onmousemove={() => (active = index)}
            onclick={() => choose(option)}
            onkeydown={() => {}}
          >
            {#if option.badge}
              <span class="select-menu-badge" style={"--hue:" + (option.hue ?? 238)} aria-hidden="true">{option.badge}</span>
            {:else if option.icon}
              <span class="select-menu-icon" aria-hidden="true"><Icon name={option.icon} size={14} /></span>
            {/if}
            <span class="select-menu-copy">
              <span class="select-menu-label">{option.label}</span>
              {#if option.disabledReason}
                <span class="select-menu-detail">{option.disabledReason}</span>
              {:else if option.detail}
                <span class="select-menu-detail">{option.detail}</span>
              {/if}
            </span>
            {#if option.tag}<span class="select-menu-tag">{option.tag}</span>{/if}
            <span class="select-menu-check" aria-hidden="true">{#if option.value === value}<Icon name="check" size={14} />{/if}</span>
          </div>
        {:else}
          <p class="branch-popover-empty">没有匹配的选项</p>
        {/each}
      {/snippet}
    </Popover>
  {/if}
</div>
