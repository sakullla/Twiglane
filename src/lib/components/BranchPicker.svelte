<script lang="ts">
  import { tick } from "svelte";
  import type { BranchRecord } from "../types";
  import { blockTops, blockWindow, BUSY_REASON } from "../ui";
  import Icon from "./Icon.svelte";

  interface Props {
    /** 触发按钮的可访问名称，例如「来源分支」。 */
    label: string;
    branches: BranchRecord[];
    value: string;
    /** 当前所在分支（列表里标「当前」）。 */
    current: string | null;
    /** 只允许本地分支（合并目标只能是本地分支）。 */
    localOnly?: boolean;
    /** 不可选的分支（例如另一端已经选中的那个）及原因。 */
    exclude?: string | null;
    excludeReason?: string;
    disabled?: boolean;
    onChange: (name: string) => void;
  }

  let {
    label,
    branches,
    value,
    current,
    localOnly = false,
    exclude = null,
    excludeReason = "另一端已经选了它",
    disabled = false,
    onChange,
  }: Props = $props();

  let open = $state(false);
  let query = $state("");
  let active = $state(0);
  let trigger = $state<HTMLButtonElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let place = $state({ top: 0, left: 0, width: 360, maxHeight: 420 });
  const listId = `branch-picker-${Math.random().toString(36).slice(2, 9)}`;

  interface Option {
    name: string;
    remote: boolean;
    current: boolean;
    worktree: string | null;
    reason: string | null;
  }

  let scrollTop = $state(0);
  let viewport = $state(0);
  let selected = $derived(branches.find((branch) => branch.name === value) ?? null);
  let options = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const rows: Option[] = [];
    for (const branch of branches) {
      if (branch.remote && (localOnly || branch.name.endsWith("/HEAD"))) continue;
      if (needle && !branch.name.toLowerCase().includes(needle)) continue;
      const isCurrent = !branch.remote && branch.name === current;
      let reason: string | null = null;
      if (branch.name === exclude) reason = excludeReason;
      else if (localOnly && branch.worktree && !isCurrent) reason = `正被其他工作区使用：${branch.worktree}`;
      rows.push({ name: branch.name, remote: branch.remote, current: isCurrent, worktree: branch.worktree, reason });
    }
    // 当前分支排最前，其余保持 Git 给出的顺序；本地在前、远程在后。
    return rows.sort((a, b) => Number(a.remote) - Number(b.remote) || Number(b.current) - Number(a.current));
  });
  let localCount = $derived(options.filter((option) => !option.remote).length);
  function hasHeading(index: number): boolean {
    return index === 0 || (index === localCount && localCount < options.length);
  }
  let tops = $derived(blockTops(options.map((_, index) => 34 + (hasHeading(index) ? 28 : 0)), 0));
  let span = $derived(blockWindow(tops, scrollTop, viewport || Math.max(140, place.maxHeight - 60), 136));
  let shown = $derived(options.slice(span.start, span.end));


  function measure() {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 340);
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const useAbove = below < 260 && above > below;
    const maxHeight = Math.max(200, Math.min(440, useAbove ? above : below));
    place = { top: useAbove ? rect.top - maxHeight - 6 : rect.bottom + 6, left: Math.max(12, left), width, maxHeight };
  }

  async function show() {
    if (disabled) return;
    measure();
    query = "";
    open = true;
    const index = options.findIndex((option) => option.name === value);
    active = index >= 0 ? index : 0;
    await tick();
    search?.focus();
    reveal();
  }

  function hide(refocus = true) {
    open = false;
    if (refocus) trigger?.focus();
  }

  function choose(option: Option | undefined) {
    if (!option || option.reason) return;
    onChange(option.name);
    hide();
  }

  function reveal() {
    const host = listEl;
    if (!host || !options[active]) return;
    const height = viewport || Math.max(140, place.maxHeight - 60);
    const top = tops[active];
    const bottom = tops[active + 1];
    if (top < host.scrollTop) host.scrollTop = top;
    else if (bottom > host.scrollTop + height) host.scrollTop = bottom - height;
    scrollTop = host.scrollTop;
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
      return;
    }
    if (event.key === "Tab") {
      hide(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + options.length) % options.length;
      reveal();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(options[active]);
    }
  }

  $effect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (listEl?.parentElement?.contains(target) || trigger?.contains(target))) return;
      hide(false);
    };
    const relayout = () => measure();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("resize", relayout);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("resize", relayout);
    };
  });

  $effect(() => {
    void query;
    active = 0;
    scrollTop = 0;
    if (listEl) listEl.scrollTop = 0;
  });
</script>

<div class="branch-picker">
  <button
    type="button"
    class="branch-picker-trigger"
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? listId : undefined}
    title={disabled ? BUSY_REASON : undefined}
    {disabled}
    bind:this={trigger}
    onclick={() => (open ? hide() : void show())}
    onkeydown={(event) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        void show();
      }
    }}
  >
    <span class={`branch-picker-icon ${selected?.remote ? "remote" : ""}`}><Icon name={selected?.remote ? "cloud" : "branch"} size={15} /></span>
    <span class="branch-picker-name">{value || "选择分支"}</span>
    {#if value && value === current}<span class="branch-picker-tag">当前</span>{/if}
    {#if selected?.remote}<span class="branch-picker-tag remote">远程</span>{/if}
    <Icon name="chevron-down" size={14} class={open ? "flip" : ""} />
  </button>

  {#if open}
    <div
      class="branch-popover"
      style={`top:${place.top}px;left:${place.left}px;width:${place.width}px;max-height:${place.maxHeight}px`}
      role="presentation"
    >
      <div class="branch-popover-search">
        <Icon name="search" size={14} />
        <input
          bind:this={search}
          bind:value={query}
          placeholder={localOnly ? "搜索本地分支" : "搜索本地或远程分支"}
          aria-label={`搜索${label}`}
          aria-controls={listId}
          aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
          autocomplete="off"
          spellcheck="false"
          onkeydown={onKey}
        />
      </div>
      <div class="branch-popover-list" id={listId} role="listbox" aria-label={label} bind:this={listEl} bind:clientHeight={viewport} onscroll={() => (scrollTop = listEl?.scrollTop ?? 0)}>
        {#if options.length === 0}
          <p class="branch-popover-empty">没有匹配的分支</p>
        {/if}
        <div style={`height:${tops[options.length]}px;position:relative`}>
        {#each shown as option, offset (`${option.remote}:${option.name}`)}
          {@const index = span.start + offset}
          <div style={`position:absolute;top:${tops[index]}px;left:0;right:0`}>

          {#if index === 0 && !option.remote}<div class="branch-popover-group" style="height:28px">本地分支</div>{/if}
          {#if option.remote && index === localCount}<div class="branch-popover-group" style="height:28px">远程分支</div>{/if}
          <div
            id={`${listId}-${index}`}
            class="branch-option"
            style="height:34px"
            aria-posinset={index + 1}
            aria-setsize={options.length}
            class:active={index === active}
            role="option"
            aria-selected={option.name === value}
            aria-disabled={option.reason ? "true" : undefined}
            data-index={index}
            title={option.reason ?? option.name}
            tabindex="-1"
            onmousemove={() => (active = index)}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => choose(option)}
            onkeydown={() => {}}
          >
            <span class={`branch-option-icon ${option.remote ? "remote" : ""}`}><Icon name={option.remote ? "cloud" : "branch"} size={13} /></span>
            <span class="branch-option-name">{option.name}</span>
            {#if option.current}<span class="branch-picker-tag">当前</span>{/if}
            {#if option.reason}<span class="branch-option-note">{option.name === exclude ? "已选" : "不可用"}</span>{/if}
            {#if option.name === value}<Icon name="check" size={14} class="branch-option-check" />{/if}
          </div>
          </div>
        {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
