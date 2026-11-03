<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api";
  import { bucketBranches, filterBranches, groupIsOpen, isDefaultBranch } from "../branches";
  import { normalizeError } from "../errors";
  import type { IconName } from "../icons";
  import type { BranchRecord, BranchState, OpenedRepository, StatusSnapshot } from "../types";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 标题栏分支弹层：搜索本地和远程分支并直接切换，底部进入新建、合并与管理。
   * 切换与 BranchDialog 走同一个 api.switchBranch 和同一套写锁；失败时不应用任何快照，
   * 原因留在弹层里，工作区保持原样。
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
    /** 「新建分支」：打开分支 modal 并直接展开新建表单。 */
    onCreateBranch: () => void;
    /** 设置里的分支分组。缺省开启。 */
    branchGroups?: boolean;
    /** 打开其他工作区成功后交给外壳切换当前仓库。 */
    onOpened?: (repo: OpenedRepository) => void;
    onClose: (refocus?: boolean) => void;
  }

  let { anchor, opened, blockedReason, nextId, onBusy, onGeneration, onSnapshot, onFailure, onNotice, onCommand, onCreateBranch, branchGroups = true, onOpened, onClose }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName; create?: boolean }[] = [
    { id: "task.branch", label: "新建分支", icon: "plus", create: true },
    { id: "task.merge", label: "合并到当前分支", icon: "merge" },
    { id: "task.branch", label: "管理分支与标签", icon: "tag" },
  ];
  const VISIBLE_LIMIT = 200;

  let branches = $state.raw<BranchRecord[]>([]);
  let defaultBranch = $state<string | null>(null);
  let groupOverrides = $state<Record<string, boolean>>({});
  let loading = $state(true);
  let query = $state("");
  let active = $state(0);
  let errorText = $state<string | null>(null);
  let openingWorktree = $state(false);
  /** 切换在途时弹层可能已被收起，甚至换成了别的弹层；那时不能再替它们关闭。 */
  let mounted = true;

  let currentName = $derived(opened.snapshot.branch.name);
  let filtered = $derived(
    filterBranches(
      branches
        .filter((branch) => !(branch.remote && branch.name.endsWith("/HEAD")))
        // 本地在前、当前分支最前；数量截断时留下的也是这些。
        .sort((a, b) => Number(a.remote) - Number(b.remote) || Number(isCurrent(b)) - Number(isCurrent(a))),
      query,
    ),
  );

  interface SwitchLabel { kind: "label"; key: string; text: string }
  interface SwitchGroup { kind: "group"; key: string; scope: string; prefix: string; open: boolean; count: number }
  interface SwitchBranch { kind: "branch"; key: string; branch: BranchRecord; index: number }
  type SwitchRow = SwitchLabel | SwitchGroup | SwitchBranch;

  let view = $derived.by(() => {
    const grouping = branchGroups !== false && query.trim() === "";
    const options: BranchRecord[] = [];
    const rows: SwitchRow[] = [];
    const pushSection = (sectionBranches: BranchRecord[], label: string, scope: string) => {
      if (sectionBranches.length === 0) return;
      rows.push({ kind: "label", key: `label:${scope}`, text: label });
      const buckets = grouping ? bucketBranches(sectionBranches) : { top: sectionBranches, groups: [] };
      const pushBranch = (branch: BranchRecord) => {
        const index = options.length;
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
    return { options, rows };
  });
  let matched = $derived(view.options);
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
  async function readBranches(): Promise<BranchState> {
    const path = opened.summary.path;
    try {
      return await api.branchState(path, opened.generation, nextId());
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      onGeneration(failure.generation);
      return api.branchState(path, failure.generation, nextId());
    }
  }

  onMount(() => {
    const path = opened.summary.path;
    void readBranches()
      .then((result) => {
        if (opened.summary.path === path) {
        branches = result?.branches ?? [];
        defaultBranch = result?.defaultBranch ?? null;
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

  async function choose(branch: BranchRecord | undefined) {
    if (!branch || reasonFor(branch)) return;
    if (isCurrent(branch)) {
      onClose();
      return;
    }
    const repo = opened;
    errorText = null;
    onBusy("branch");
    try {
      const result = await api.switchBranch(repo.summary.path, branch.name, repo.generation, nextId());
      if (opened.summary.path !== repo.summary.path) return;
      onSnapshot(result.snapshot);
      onNotice(`已切换到 ${result.snapshot.branch.name ?? branch.name}`);
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
  {onClose}
>
  {#snippet notice()}
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
    {:else if matched.length === 0}
      <p class="branch-popover-empty">没有匹配的分支</p>
    {/if}
    {#each view.rows as row (row.key)}
      {#if row.kind === "label"}
        <div class="branch-popover-group">{row.text}</div>
      {:else if row.kind === "group"}
        <button
          type="button"
          class="branch-group"
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
        {@const reason = reasonFor(branch)}
        <div
          id={`${listId}-${row.index}`}
          class="branch-option switcher-option"
          class:active={row.index === active}
          role="option"
          aria-selected={isCurrent(branch)}
          aria-disabled={reason ? "true" : undefined}
          data-index={row.index}
          title={reason ?? branch.name}
          tabindex="-1"
          onmousemove={() => (active = row.index)}
          onclick={() => void choose(branch)}
          onkeydown={() => {}}
        >
          <Icon name={branch.remote ? "cloud" : "branch"} size={13} class="switcher-icon" />
          <span class="branch-option-name">{branch.name}</span>
          {#if isDefaultBranch(branch, defaultBranch)}<span class="branch-picker-tag default-branch" data-default-branch>默认</span>{/if}
          {#if reason}<span class="switcher-reason">{reason}</span>{/if}
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
            >打开此工作区</button>
          {/if}
          {#if isCurrent(branch)}<span class="branch-picker-tag">当前</span>{/if}
        </div>
      {/if}
    {/each}
    {#if matched.length >= VISIBLE_LIMIT}
      <p class="branch-popover-empty">只显示前 {VISIBLE_LIMIT} 个，输入关键词缩小范围。</p>
    {/if}
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
