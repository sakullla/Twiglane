<script module lang="ts">
  import type { IconName } from "../icons";

  /** 列表顶部的非分支选项，例如「当前分支（main）」「全部分支」。 */
  export interface BranchPickerExtra {
    value: string;
    label: string;
    icon: IconName;
  }
</script>

<script lang="ts">
  import { tick, untrack } from "svelte";
  import { bucketBranches, groupIsOpen, isDefaultBranch } from "../branches";
  import type { BranchRecord } from "../types";
  import { blockTops, blockWindow, BUSY_REASON } from "../ui";
  import BranchOption from "./BranchOption.svelte";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 表单里的分支下拉框：合并的来源 / 目标、新建分支的起点、历史范围都用它，
   * 弹层外壳（Popover）和每一行（BranchOption）与标题栏的分支弹层是同一套。
   * 分支可能有上千个，列表按视口只渲染附近的行；键盘当前项始终留在 DOM 里，
   * Popover 的 scrollIntoView 和 aria-activedescendant 才有落点。
   */
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
    /** 禁用时触发按钮上的说明；缺省为通用的忙碌原因。 */
    disabledReason?: string;
    /** 设置里的「按斜杠分组分支」：开启时按第一个 / 收成可展开的目录，关闭时平铺。缺省开启。 */
    branchGroups?: boolean;
    /** 默认分支：列表里标「默认」。 */
    defaultBranch?: string | null;
    /** 主干分支（本地默认分支及其远程对应分支）：图标换成星标。 */
    mainBranches?: string[];
    /** 列表顶部的非分支选项。 */
    extras?: BranchPickerExtra[];
    /** 什么都没选时触发按钮上的文字。 */
    placeholder?: string;
    /** lg：合并卡片里的大号触发按钮；md：表单行里与输入框同高。 */
    size?: "lg" | "md";
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
    disabledReason = BUSY_REASON,
    branchGroups = true,
    defaultBranch = null,
    mainBranches = [],
    extras = [],
    placeholder = "选择分支",
    size = "lg",
    onChange,
  }: Props = $props();

  interface Option {
    name: string;
    text?: string;
    icon?: IconName;
    remote: boolean;
    current: boolean;
    isDefault: boolean;
    main: boolean;
    merged: boolean;
    reason: string | null;
    note: string | null;
  }

  type Row =
    | { kind: "heading"; key: string; text: string }
    | { kind: "group"; key: string; prefix: string; open: boolean; count: number }
    | { kind: "option"; key: string; option: Option; index: number };
  /** 行高与样式表一致：行是绝对定位的，按这里的高度排版。 */
  const HEIGHTS = { heading: 30, group: 30, option: 36 } as const;
  const OVERSCAN = 180;

  let open = $state(false);
  let query = $state("");
  let active = $state(0);
  let trigger = $state<HTMLButtonElement | null>(null);
  /** 分组的手动展开/收起；每次打开弹层清空，回到「含当前或已选分支的组展开」。 */
  let groupOverrides = $state<Record<string, boolean>>({});
  let scrollTop = $state(0);
  let viewport = $state(0);

  let selected = $derived(branches.find((branch) => branch.name === value) ?? null);
  let mainSet = $derived(new Set(mainBranches.length > 0 ? mainBranches : defaultBranch ? [defaultBranch] : []));
  let selectedExtra = $derived(extras.find((extra) => extra.value === value) ?? null);
  let options = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const rows: Option[] = [];
    for (const branch of branches) {
      if (branch.remote && (localOnly || branch.name.endsWith("/HEAD"))) continue;
      if (needle && !branch.name.toLowerCase().includes(needle)) continue;
      const isCurrent = !branch.remote && branch.name === current;
      let reason: string | null = null;
      let note: string | null = null;
      if (branch.name === exclude) {
        reason = excludeReason;
        note = "已选";
      } else if (localOnly && branch.worktree && !isCurrent) {
        reason = `正被其他工作区使用：${branch.worktree}`;
        note = "其他工作区";
      }
      rows.push({
        name: branch.name,
        remote: branch.remote,
        current: isCurrent,
        isDefault: isDefaultBranch(branch, defaultBranch),
        main: mainSet.has(branch.name),
        merged: branch.merged === true,
        reason,
        note,
      });
    }
    // 当前分支排最前，其余保持 Git 给出的顺序；本地在前、远程在后。
    return rows.sort((a, b) => Number(a.remote) - Number(b.remote) || Number(b.current) - Number(a.current));
  });
  let extraOptions = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return extras
      .filter((extra) => !needle || extra.label.toLowerCase().includes(needle))
      .map((extra): Option => ({ name: extra.value, text: extra.label, icon: extra.icon, remote: false, current: false, isDefault: false, main: false, merged: false, reason: null, note: null }));
  });

  /**
   * 列表行：顶部选项、分区标题、分组（按设置）与分支。键盘只在看得见的选项之间移动，
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
    for (const option of extraOptions) pushOption(option, "extra");
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
        const isOpen = Object.hasOwn(groupOverrides, key)
          ? groupOverrides[key] === true
          : groupIsOpen(group.branches, current, {}, key) || group.branches.some((branch) => branch.name === value);
        rows.push({ kind: "group", key: `group:${key}`, prefix: group.prefix, open: isOpen, count: group.branches.length });
        if (isOpen) for (const record of group.branches) pushOption(byName.get(record.name)!, scope);
      }
    };
    pushSection(options.filter((option) => !option.remote), "本地分支", "local");
    pushSection(options.filter((option) => option.remote), "远程分支", "remote");
    return { rows, visibleOptions, rowOf };
  });
  let visibleOptions = $derived(view.visibleOptions);
  let tops = $derived(blockTops(view.rows.map((row) => HEIGHTS[row.kind]), 0));
  let span = $derived(blockWindow(tops, scrollTop, viewport || 360, OVERSCAN, 24));
  let shown = $derived.by(() => {
    const rows: { row: Row; at: number }[] = [];
    for (let at = span.start; at < span.end; at += 1) rows.push({ row: view.rows[at], at });
    const activeRow = view.rowOf[active];
    if (activeRow !== undefined && (activeRow < span.start || activeRow >= span.end)) rows.push({ row: view.rows[activeRow], at: activeRow });
    return rows;
  });

  /** 关键词变化时回到第一项和顶部。 */
  let seenQuery = "";
  $effect(() => {
    const needle = query;
    untrack(() => {
      if (needle === seenQuery) return;
      seenQuery = needle;
      active = 0;
      scrollTop = 0;
      if (listHost) listHost.scrollTop = 0;
    });
  });

  let listHost: HTMLElement | null = null;

  /** 滚动容器是 Popover 的列表区，这里挂在内容轨道上跟着它走。 */
  function trackList(node: HTMLElement) {
    const host = node.parentElement as HTMLElement;
    const read = () => {
      scrollTop = host.scrollTop;
      viewport = host.clientHeight;
    };
    listHost = host;
    read();
    host.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(host);
    return {
      destroy() {
        host.removeEventListener("scroll", read);
        observer?.disconnect();
        listHost = null;
      },
    };
  }

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

  function show() {
    if (disabled) return;
    query = "";
    seenQuery = "";
    groupOverrides = {};
    scrollTop = 0;
    const index = visibleOptions.findIndex((option) => option.name === value);
    active = index >= 0 ? index : 0;
    open = true;
  }

  function hide(refocus = true) {
    open = false;
    if (refocus) trigger?.focus({ preventScroll: true });
  }

  function choose(option: Option | undefined) {
    if (!option || option.reason) return;
    onChange(option.name);
    hide();
  }
</script>

<div class="branch-picker">
  <button
    type="button"
    class="branch-picker-trigger"
    class:md={size === "md"}
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    data-value={value}
    title={disabled ? disabledReason : (selectedExtra?.label ?? (value || undefined))}
    {disabled}
    bind:this={trigger}
    onclick={() => (open ? hide() : show())}
    onkeydown={(event) => {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
        event.preventDefault();
        show();
      }
    }}
  >
    {#if selectedExtra}
      <span class="branch-picker-icon special"><Icon name={selectedExtra.icon} size={size === "md" ? 13 : 15} /></span>
      <span class="branch-picker-name special">{selectedExtra.label}</span>
    {:else}
      <span class={`branch-picker-icon ${selected?.remote ? "remote" : ""}`} class:main={mainSet.has(value)}><Icon name={mainSet.has(value) ? "star" : selected?.remote ? "cloud" : "branch"} size={size === "md" ? 13 : 15} /></span>
      <span class="branch-picker-name" class:empty={!value}>{value || placeholder}</span>
      {#if value && value === current}<span class="branch-picker-tag">当前</span>{/if}
      {#if selected?.remote}<span class="branch-picker-tag remote">远程</span>{/if}
    {/if}
    <Icon name="chevron-down" size={14} class={open ? "flip" : ""} />
  </button>

  {#if open && trigger}
    <Popover
      anchor={trigger}
      {label}
      placeholder={localOnly ? "搜索本地分支" : "搜索本地或远程分支"}
      searchLabel={`搜索${label}`}
      width={340}
      matchAnchor
      bind:query
      bind:active
      count={visibleOptions.length}
      onChoose={(index) => choose(visibleOptions[index])}
      onClose={(refocus) => hide(refocus)}
    >
      {#snippet list(listId)}
        {#if visibleOptions.length === 0}
          <p class="branch-popover-empty">没有匹配的分支</p>
        {:else}
          <div class="branch-picker-space" role="presentation" style={`height:${tops[view.rows.length]}px`} use:trackList>
            {#each shown as { row, at } (row.key)}
              {@const top = tops[at]}
              {#if row.kind === "heading"}
                <div class="branch-popover-group" style={`top:${top}px`}>{row.text}</div>
              {:else if row.kind === "group"}
                <button
                  type="button"
                  class="branch-group"
                  data-branch-group={row.prefix}
                  style={`top:${top}px`}
                  aria-expanded={row.open}
                  aria-label={`${row.open ? "收起" : "展开"}分组 ${row.prefix}`}
                  tabindex="-1"
                  onclick={() => toggleGroup(row)}
                >
                  <Icon name={row.open ? "chevron-down" : "chevron-right"} size={12} />
                  <span>{row.prefix}</span>
                  <span class="count">{row.count}</span>
                </button>
              {:else}
                {@const option = row.option}
                <BranchOption
                  id={`${listId}-${row.index}`}
                  index={row.index}
                  setsize={visibleOptions.length}
                  name={option.name}
                  text={option.text}
                  icon={option.icon}
                  remote={option.remote}
                  active={row.index === active}
                  selected={option.name === value}
                  current={option.current}
                  isDefault={option.isDefault}
                  main={option.main}
                  merged={option.merged}
                  reason={option.reason}
                  note={option.note}
                  style={`top:${top}px`}
                  onHover={() => (active = row.index)}
                  onChoose={() => choose(option)}
                />
              {/if}
            {/each}
          </div>
        {/if}
      {/snippet}
    </Popover>
  {/if}
</div>
