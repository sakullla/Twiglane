<script lang="ts">
  import { tick } from "svelte";
  import { bucketBranches, groupIsOpen } from "../branches";
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
    /** 设置里的「按斜杠分组分支」：开启时按第一个 / 收成可展开的目录，关闭时平铺。缺省开启。 */
    branchGroups?: boolean;
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
    branchGroups = true,
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

  type Row =
    | { kind: "heading"; key: string; text: string }
    | { kind: "group"; key: string; prefix: string; open: boolean; count: number }
    | { kind: "option"; key: string; option: Option; index: number };
  const HEIGHTS = { heading: 28, group: 28, option: 34 } as const;

  /** 分组的手动展开/收起；每次打开弹层清空，回到「含当前或已选分支的组展开」。 */
  let groupOverrides = $state<Record<string, boolean>>({});
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

  /**
   * 列表行：分区标题、分组（按设置）与分支。键盘只在看得见的分支之间移动，
   * 所以 visibleOptions 与 rows 分开记：visibleOptions[i] 画在 rows[rowOf[i]]。
   * 搜索时一律平铺，匹配项不会藏在收起的组里。
   */
  let view = $derived.by(() => {
    const grouping = branchGroups !== false && query.trim() === "";
    const rows: Row[] = [];
    const visibleOptions: Option[] = [];
    const rowOf: number[] = [];
    const pushOption = (option: Option, scope: string) => {
      rowOf.push(rows.length);
      rows.push({ kind: "option", key: `${scope}:${option.name}`, option, index: visibleOptions.length });
      visibleOptions.push(option);
    };
    const pushSection = (section: Option[], text: string, scope: string) => {
      if (section.length === 0) return;
      rows.push({ kind: "heading", key: `heading:${scope}`, text });
      if (!grouping) {
        for (const option of section) pushOption(option, scope);
        return;
      }
      const byName = new Map(section.map((option) => [option.name, option]));
      const records = section.map((option) => ({ name: option.name, remote: option.remote, current: option.current }) as BranchRecord);
      const buckets = bucketBranches(records);
      for (const record of buckets.top) pushOption(byName.get(record.name)!, scope);
      for (const group of buckets.groups) {
        const key = `${scope}:${group.prefix}`;
        const open = Object.hasOwn(groupOverrides, key)
          ? groupOverrides[key] === true
          : groupIsOpen(group.branches, current, {}, key) || group.branches.some((branch) => branch.name === value);
        rows.push({ kind: "group", key: `group:${key}`, prefix: group.prefix, open, count: group.branches.length });
        if (open) for (const record of group.branches) pushOption(byName.get(record.name)!, scope);
      }
    };
    pushSection(options.filter((option) => !option.remote), "本地分支", "local");
    pushSection(options.filter((option) => option.remote), "远程分支", "remote");
    return { rows, visibleOptions, rowOf };
  });
  let visibleOptions = $derived(view.visibleOptions);
  let tops = $derived(blockTops(view.rows.map((row) => HEIGHTS[row.kind]), 0));
  let span = $derived(blockWindow(tops, scrollTop, viewport || Math.max(140, place.maxHeight - 60), 136));
  let shown = $derived(view.rows.slice(span.start, span.end));

  function toggleGroup(row: Extract<Row, { kind: "group" }>) {
    const key = row.key.slice("group:".length);
    groupOverrides = { ...groupOverrides, [key]: !row.open };
    const focus = visibleOptions[active]?.name;
    void tick().then(() => {
      // 收起的组里如果有键盘当前项，落到组之后第一个可见分支，回车不会选中看不见的东西。
      const next = focus ? visibleOptions.findIndex((option) => option.name === focus) : -1;
      active = next >= 0 ? next : Math.min(active, Math.max(0, visibleOptions.length - 1));
    });
  }


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
    groupOverrides = {};
    open = true;
    const index = visibleOptions.findIndex((option) => option.name === value);
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
    const row = view.rowOf[active];
    if (!host || row === undefined) return;
    const height = viewport || Math.max(140, place.maxHeight - 60);
    const top = tops[row];
    const bottom = tops[row + 1];
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
      if (visibleOptions.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + visibleOptions.length) % visibleOptions.length;
      reveal();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(visibleOptions[active]);
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
          aria-activedescendant={visibleOptions[active] ? `${listId}-${active}` : undefined}
          autocomplete="off"
          spellcheck="false"
          onkeydown={onKey}
        />
      </div>
      <div class="branch-popover-list" id={listId} role="listbox" aria-label={label} bind:this={listEl} bind:clientHeight={viewport} onscroll={() => (scrollTop = listEl?.scrollTop ?? 0)}>
        {#if options.length === 0}
          <p class="branch-popover-empty">没有匹配的分支</p>
        {/if}
        <div style={`height:${tops[view.rows.length]}px;position:relative`}>
        {#each shown as row, offset (row.key)}
          {@const top = tops[span.start + offset]}
          {#if row.kind === "heading"}
            <div class="branch-popover-group" style={`position:absolute;top:${top}px;left:0;right:0;height:28px`}>{row.text}</div>
          {:else if row.kind === "group"}
            <button
              type="button"
              class="branch-group"
              data-branch-group={row.prefix}
              style={`position:absolute;top:${top}px;left:0;right:0;height:28px`}
              aria-expanded={row.open}
              aria-label={`${row.open ? "收起" : "展开"}分组 ${row.prefix}`}
              tabindex="-1"
              onmousedown={(event) => event.preventDefault()}
              onclick={() => toggleGroup(row)}
            >
              <Icon name={row.open ? "chevron-down" : "chevron-right"} size={12} />
              <span>{row.prefix}</span>
              <span class="count">{row.count}</span>
            </button>
          {:else}
            {@const option = row.option}
            {@const index = row.index}
            <div
              id={`${listId}-${index}`}
              class="branch-option"
              style={`position:absolute;top:${top}px;left:0;right:0;height:34px`}
              aria-posinset={index + 1}
              aria-setsize={visibleOptions.length}
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
          {/if}
        {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
