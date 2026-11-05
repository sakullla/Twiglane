<script lang="ts">
  import { onMount } from "svelte";
  import { blockTops, blockWindow } from "../ui";
  import { api } from "../api";
  import { bucketBranches, filterBranches, groupIsOpen, isDefaultBranch, mainBranchNames, trackNameFor } from "../branches";
  import { normalizeError } from "../errors";
  import type { IconName } from "../icons";
  import type { BranchRecord, BranchListing, OpenedRepository, StatusSnapshot } from "../types";
  import BranchOption from "./BranchOption.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 标题栏分支弹层：搜索本地和远程分支并直接切换，底部进入新建、合并与管理。
   * 切换与 BranchDialog 走同一个 api.switchBranch 和同一套写锁；失败时不应用任何快照，
   * 原因留在弹层里，工作区保持原样。
   * 右键或菜单键打开分支操作（切换、新建、合并、变基、复制），菜单叠在弹层上，Esc 只关菜单。
   */
  interface Props {
    anchor: HTMLElement;
    opened: OpenedRepository;
    /** 切换被禁止的原因（读取或写入中）。 */
    blockedReason: string | null;
    nextId: () => number;
    onBusy: (name: string | null) => void;
    onGeneration: (generation: number) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onCommand: (id: string) => void;
    /** 「新建分支」：打开分支 modal 并直接展开新建表单；base 是预选的起点。 */
    onCreateBranch: (base?: string) => void;
    /** 把所点分支合并到当前分支：打开分支合并并预选来源。 */
    onMergeBranch?: (name: string) => void;
    /** 把当前分支合并到所点本地分支：打开分支合并并预选目标。 */
    onMergeInto?: (name: string) => void;
    /** 把当前分支变基到所点分支。 */
    onRebaseBranch?: (name: string) => void;
    /** 设置里的分支分组。缺省开启。 */
    branchGroups?: boolean;
    /** 打开其他工作区成功后交给外壳切换当前仓库。 */
    onOpened?: (repo: OpenedRepository) => void;
    onClose: (refocus?: boolean) => void;
  }

  let {
    anchor,
    opened,
    blockedReason,
    nextId,
    onBusy,
    onGeneration,
    onSnapshot,
    onFailure,
    onNotice,
    onCommand,
    onCreateBranch,
    onMergeBranch,
    onMergeInto,
    onRebaseBranch,
    branchGroups = true,
    onOpened,
    onClose,
  }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName; create?: boolean }[] = [
    { id: "task.branch", label: "新建分支", icon: "plus", create: true },
    { id: "task.merge", label: "合并到当前分支", icon: "merge" },
    { id: "task.branch", label: "管理分支与标签", icon: "tag" },
  ];
  const HEIGHTS = { label: 30, group: 30, branch: 36 };
  let scrollTop = $state(0);
  let viewport = $state(0);
  let listHost: HTMLElement | null = null;

  let branches = $state.raw<BranchRecord[]>([]);
  let defaultBranch = $state<string | null>(null);
  let mergeBases = $state<string[]>([]);
  let mainNames = $derived(mainBranchNames({ defaultBranch, mergeBases }));
  let groupOverrides = $state<Record<string, boolean>>({});
  let loading = $state(true);
  let query = $state("");
  let active = $state(0);
  let errorText = $state<string | null>(null);
  let openingWorktree = $state(false);
  let menu = $state<ContextMenuRequest | null>(null);
  /** 远程分支的短名被跟踪别处的本地分支占用：给出「切到本地同名分支」或「以新名称检出」两条路。 */
  let mismatch = $state<{ remote: string; local: string; suggested: string } | null>(null);
  /** 切换在途时弹层可能已被收起，甚至换成了别的弹层；那时不能再替它们关闭。 */
  let mounted = true;

  let currentName = $derived(opened.snapshot.branch.name);
  let sorted = $derived(branches
        .filter((branch) => !(branch.remote && branch.name.endsWith("/HEAD")))
        // 本地在前、当前分支最前；数量截断时留下的也是这些。
        .sort((a, b) => Number(a.remote) - Number(b.remote) || Number(isCurrent(b)) - Number(isCurrent(a))));
  let filtered = $derived(filterBranches(sorted, query));

  interface SwitchLabel { kind: "label"; key: string; text: string }
  interface SwitchGroup { kind: "group"; key: string; scope: string; prefix: string; open: boolean; count: number }
  interface SwitchBranch { kind: "branch"; key: string; branch: BranchRecord; index: number }
  type SwitchRow = SwitchLabel | SwitchGroup | SwitchBranch;

  let view = $derived.by(() => {
    const grouping = branchGroups !== false && query.trim() === "";
    const options: BranchRecord[] = [];
    const rows: SwitchRow[] = [];
    const rowOf: number[] = [];
    const pushSection = (sectionBranches: BranchRecord[], label: string, scope: string) => {
      if (sectionBranches.length === 0) return;
      rows.push({ kind: "label", key: `label:${scope}`, text: label });
      const buckets = grouping ? bucketBranches(sectionBranches) : { top: sectionBranches, groups: [] };
      const pushBranch = (branch: BranchRecord) => {
        const index = options.length;
        rowOf.push(rows.length);
        options.push(branch);
        rows.push({ kind: "branch", key: `${scope}:${branch.name}`, branch, index });
      };
      for (const branch of buckets.top) pushBranch(branch);
      for (const group of buckets.groups) {
        const key = `${scope}:${group.prefix}`;
        const open = groupIsOpen(group.branches, currentName, groupOverrides, key);
        rows.push({ kind: "group", key, scope, prefix: group.prefix, open, count: group.branches.length });
        if (open) for (const branch of group.branches) pushBranch(branch);
      }
    };
    pushSection(filtered.filter((branch) => !branch.remote), "本地分支", "local");
    pushSection(filtered.filter((branch) => branch.remote), "远程分支", "remote");
    return { options, rows, rowOf };
  });
  let matched = $derived(view.options);
  let tops = $derived(blockTops(view.rows.map((row) => HEIGHTS[row.kind]), 0));
  let span = $derived(blockWindow(tops, scrollTop, viewport || 360, 180, 24));
  let shown = $derived.by(() => {
    const rows = [];
    for (let at = span.start; at < span.end; at++) rows.push({ row: view.rows[at], at });
    const at = view.rowOf[active];
    if (at !== undefined && (at < span.start || at >= span.end)) rows.push({ row: view.rows[at], at });
    return rows;
  });
  $effect(() => {
    query;
    scrollTop = 0;
    if (listHost) listHost.scrollTop = 0;
  });
  function trackList(node: HTMLElement) {
    const host = node.parentElement!;
    listHost = host;
    const read = () => { scrollTop = host.scrollTop; viewport = host.clientHeight; };
    read();
    host.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(host);
    return { destroy() { host.removeEventListener("scroll", read); observer?.disconnect(); listHost = null; } };
  }
  let layoutKey = "";

  $effect(() => {
    const nextKey = `${opened.summary.path}\0${branchGroups !== false}`;
    if (nextKey === layoutKey) return;
    layoutKey = nextKey;
    groupOverrides = {};
  });

  /** 默认项落在第一个可切过去的分支上：一次回车就能切换（R6）。 */
  $effect(() => {
    const first = matched.findIndex((branch) => !isCurrent(branch) && !elsewhere(branch));
    active = first >= 0 ? first : 0;
  });

  function isCurrent(branch: BranchRecord): boolean {
    return !branch.remote && branch.name === currentName;
  }

  function elsewhere(branch: BranchRecord): string | null {
    return branch.worktree && !isCurrent(branch) ? `正被其他工作区使用：${branch.worktree}` : null;
  }

  function reasonFor(branch: BranchRecord): string | null {
    if (isCurrent(branch)) return null;
    return elsewhere(branch) ?? blockedReason;
  }

  /** 列表是只读取：不占写锁，也不改外壳状态，只有 generation 过期时跟上一次。 */
  async function readBranches(): Promise<BranchListing> {
    const path = opened.summary.path;
    try {
      return await api.branchList(path, opened.generation, nextId());
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      if (!mounted || opened.summary.path !== path) throw failure;
      onGeneration(failure.generation);
      return api.branchList(path, failure.generation, nextId());
    }
  }

  onMount(() => {
    const path = opened.summary.path;
    void readBranches()
      .then((result) => {
        if (mounted && opened.summary.path === path) {
          branches = result?.branches ?? [];
          defaultBranch = result?.defaultBranch ?? null;
          mergeBases = result?.mergeBases ?? [];
        }
      })
      .catch((error) => {
        if (opened.summary.path === path) errorText = normalizeError(error).message;
      })
      .finally(() => {
        loading = false;
      });
    return () => {
      mounted = false;
    };
  });

  function toggleGroup(scope: string, prefix: string) {
    const key = `${scope}:${prefix}`;
    const row = view.rows.find((item) => item.kind === "group" && item.key === key);
    const open = row?.kind === "group" ? row.open : false;
    groupOverrides = { ...groupOverrides, [key]: !open };
  }

  /** 打开占用该分支的工作区。不把那个分支检出到当前工作区。 */
  async function openWorktree(branch: BranchRecord) {
    const path = branch.worktree;
    if (!path || blockedReason || openingWorktree) return;
    const repo = opened;
    errorText = null;
    openingWorktree = true;
    onBusy("open");
    try {
      const next = await api.openRepository(path, nextId());
      if (!mounted || opened.summary.path !== repo.summary.path) return;
      onOpened?.(next);
      onClose();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      openingWorktree = false;
      onBusy(null);
    }
  }

  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      onNotice(`已复制分支名 ${name}`);
    } catch {
      errorText = "无法写入剪贴板，请手动复制分支名。";
    }
  }

  /** 分支行的操作菜单：和分支管理里的右键菜单是同一组动作，重命名与删除留在分支管理里确认。 */
  function openMenu(branch: BranchRecord, point: { x: number; y: number }) {
    const busy = blockedReason ?? (openingWorktree ? "正在打开工作区" : undefined);
    const current = isCurrent(branch);
    const currentReason = current ? "这就是当前分支" : undefined;
    const occupied = elsewhere(branch) ?? undefined;
    const entries: ContextMenuEntry[] = [
      {
        id: "switch",
        label: branch.remote ? "检出为本地分支并切换" : "切换到此分支",
        icon: "check-circle",
        disabledReason: currentReason ?? occupied ?? busy,
        run: () => void choose(branch),
      },
    ];
    if (branch.worktree && !current) {
      entries.push({ id: "open-worktree", label: "打开此工作区", icon: "folder-open", disabledReason: busy, run: () => void openWorktree(branch) });
    }
    entries.push({ separator: true });
    entries.push({
      id: "create",
      label: "从此分支新建分支…",
      icon: "plus",
      disabledReason: busy,
      run: () => onCreateBranch(current ? undefined : branch.name),
    });
    if (onMergeBranch) {
      entries.push({
        id: "merge",
        label: `合并到当前分支（${currentName ?? "HEAD"}）…`,
        icon: "merge",
        disabledReason: currentReason ?? busy,
        run: () => onMergeBranch?.(branch.name),
      });
    }
    if (onMergeInto && !branch.remote && currentName) {
      entries.push({
        id: "merge-into",
        label: `把 ${currentName} 合并到此分支…`,
        icon: "merge",
        disabledReason: currentReason ?? occupied ?? busy,
        run: () => onMergeInto?.(branch.name),
      });
    }
    if (onRebaseBranch && currentName) {
      entries.push({
        id: "rebase",
        label: "把当前分支变基到此分支…",
        icon: "branch",
        disabledReason: currentReason ?? occupied ?? busy,
        run: () => onRebaseBranch?.(branch.name),
      });
    }
    entries.push({ separator: true });
    entries.push({ id: "copy", label: "复制分支名", icon: "copy", run: () => void copyName(branch.name) });
    entries.push({ id: "manage", label: "重命名或删除…", icon: "pencil", run: () => onCommand("task.branch") });
    menu = { x: point.x, y: point.y, entries, label: `${branch.name} 的操作` };
  }

  async function choose(branch: BranchRecord | undefined) {
    if (!branch || reasonFor(branch)) return;
    if (isCurrent(branch)) {
      onClose();
      return;
    }
    const repo = opened;
    errorText = null;
    mismatch = null;
    onBusy("branch");
    try {
      const result = await api.switchBranch(repo.summary.path, branch.name, repo.generation, nextId());
      if (opened.summary.path !== repo.summary.path) return;
      onSnapshot(result.snapshot);
      onNotice(`已切换到 ${result.snapshot.branch.name ?? branch.name}`);
      if (mounted) onClose();
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "branch_upstream_mismatch" && branch.remote) {
        if (failure.generation !== undefined) onGeneration(failure.generation);
        const short = branch.name.slice(branch.name.indexOf("/") + 1);
        mismatch = { remote: branch.name, local: short, suggested: trackNameFor(branch.name, branches) };
        return;
      }
      errorText = failure.message;
      onFailure(failure);
    } finally {
      onBusy(null);
    }
  }

  async function trackAs(remote: string, local: string) {
    const repo = opened;
    errorText = null;
    onBusy("branch");
    try {
      const result = await api.trackRemoteAs(repo.summary.path, remote, local, opened.generation, nextId());
      if (opened.summary.path !== repo.summary.path) return;
      mismatch = null;
      onSnapshot(result.snapshot);
      onNotice(`已检出 ${remote} 为本地分支 ${local} 并切换过去。`);
      if (mounted) onClose();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      onBusy(null);
    }
  }
</script>

<Popover
  {anchor}
  label="切换分支"
  placeholder="搜索本地或远程分支"
  bind:query
  bind:active
  count={matched.length}
  onChoose={(index) => void choose(matched[index])}
  onItemContextMenu={(index, point) => {
    const branch = matched[index];
    if (branch) openMenu(branch, point);
  }}
  {onClose}
>
  {#snippet notice()}
    {#if blockedReason && !errorText}
      <p class="switcher-notice" role="status">
        <Icon name="info" size={14} />
        <span>{blockedReason}</span>
      </p>
    {/if}
    {#if mismatch}
      {@const info = mismatch}
      {@const localRecord = branches.find((item) => !item.remote && item.name === info.local)}
      <div class="switcher-choice" role="alert">
        <p>
          <Icon name="info" size={14} />
          <span>本地已有 <code>{info.local}</code>{#if localRecord?.upstream}（跟踪 <code>{localRecord.upstream}</code>）{/if}，不能直接用这个名字检出 <code>{info.remote}</code>。</span>
        </p>
        <div class="switcher-choice-actions">
          <button type="button" class="btn btn-primary btn-sm" disabled={blockedReason !== null} title={blockedReason ?? `新建本地分支 ${info.suggested} 并跟踪 ${info.remote}`} onclick={() => void trackAs(info.remote, info.suggested)}>
            <Icon name="branch" size={13} />检出为 {info.suggested}
          </button>
          {#if localRecord && !isCurrent(localRecord)}
            <button type="button" class="btn btn-secondary btn-sm" disabled={blockedReason !== null} title={blockedReason ?? `切换到本地分支 ${info.local}`} onclick={() => void choose(localRecord)}>切到本地 {info.local}</button>
          {/if}
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => onCreateBranch(info.remote)}>自定义名称…</button>
        </div>
      </div>
    {/if}
    {#if errorText}
      <p class="switcher-error" role="alert">
        <Icon name="alert-circle" size={14} />
        <span>{errorText}</span>
      </p>
    {/if}
  {/snippet}
  {#snippet list(listId)}
    {#if loading}
      <p class="branch-popover-empty"><span class="spinner"></span> 正在读取分支</p>
    {:else if filtered.length === 0}
      <p class="branch-popover-empty">没有匹配的分支</p>
    {/if}
    <div class="branch-picker-space" role="presentation" style={`height:${tops[view.rows.length]}px`} use:trackList>
    {#each shown as { row, at } (row.key)}
      {#if row.kind === "label"}
        <div class="branch-popover-group" style={`top:${tops[at]}px`}>{row.text}</div>
      {:else if row.kind === "group"}
        <button
          type="button"
          class="branch-group"
          style={`top:${tops[at]}px`}
          data-branch-group={row.prefix}
          aria-expanded={row.open}
          aria-label={`${row.open ? "收起" : "展开"}分组 ${row.prefix}`}
          tabindex="-1"
          onmousedown={(event) => event.stopPropagation()}
          onclick={() => toggleGroup(row.scope, row.prefix)}
        >
          <Icon name={row.open ? "chevron-down" : "chevron-right"} size={12} />
          <span>{row.prefix}</span>
          <span class="count">{row.count}</span>
        </button>
      {:else}
        {@const branch = row.branch}
        <BranchOption
          id={`${listId}-${row.index}`}
          style={`top:${tops[at]}px`}
          index={row.index}
          setsize={matched.length}
          name={branch.name}
          remote={branch.remote}
          active={row.index === active}
          selected={isCurrent(branch)}
          current={isCurrent(branch)}
          isDefault={isDefaultBranch(branch, defaultBranch)}
          main={mainNames.has(branch.name)}
          merged={branch.merged === true}
          mergedTitle={`已合入主干：已完整包含在 ${[...mainNames].join(" 和 ")} 中，删除不会丢失提交`}
          reason={reasonFor(branch)}
          note={branch.worktree && !isCurrent(branch) ? "其他工作区" : null}
          check={false}
          onHover={() => (active = row.index)}
          onChoose={() => void choose(branch)}
          onContextMenu={(point) => openMenu(branch, point)}
        >
          {#snippet trailing()}
            {#if branch.worktree && !isCurrent(branch)}
              <button
                type="button"
                class="btn btn-ghost btn-sm branch-open-worktree"
                data-open-worktree={branch.worktree}
                disabled={blockedReason !== null || openingWorktree}
                title={blockedReason ?? `打开工作区 ${branch.worktree}`}
                onmousedown={(event) => event.stopPropagation()}
                onclick={(event) => {
                  event.stopPropagation();
                  void openWorktree(branch);
                }}
              ><Icon name="folder-open" size={13} />打开此工作区</button>
            {/if}
          {/snippet}
        </BranchOption>
      {/if}
    {/each}
    </div>
  {/snippet}
  {#snippet foot()}
    {#each ACTIONS as action (action.label)}
      <button type="button" class="menu-item" onclick={() => (action.create ? onCreateBranch() : onCommand(action.id))}>
        <Icon name={action.icon} size={14} />
        <span>{action.label}</span>
      </button>
    {/each}
  {/snippet}
</Popover>

{#if menu}
  <ContextMenu request={menu} onClose={() => (menu = null)} />
{/if}
