<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api";
  import { filterBranches } from "../branches";
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
    onClose: (refocus?: boolean) => void;
  }

  let { anchor, opened, blockedReason, nextId, onBusy, onGeneration, onSnapshot, onFailure, onNotice, onCommand, onClose }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName }[] = [
    { id: "task.branch", label: "新建分支", icon: "plus" },
    { id: "task.merge", label: "合并到当前分支", icon: "merge" },
    { id: "task.branch", label: "管理分支与标签", icon: "tag" },
  ];
  const VISIBLE_LIMIT = 200;

  let branches = $state.raw<BranchRecord[]>([]);
  let loading = $state(true);
  let query = $state("");
  let active = $state(0);
  let errorText = $state<string | null>(null);

  let currentName = $derived(opened.snapshot.branch.name);
  let matched = $derived(
    filterBranches(
      branches
        .filter((branch) => !(branch.remote && branch.name.endsWith("/HEAD")))
        // 本地在前、当前分支最前；数量截断时留下的也是这些。
        .sort((a, b) => Number(a.remote) - Number(b.remote) || Number(isCurrent(b)) - Number(isCurrent(a))),
      query,
    ),
  );
  let localCount = $derived(matched.filter((branch) => !branch.remote).length);

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
        if (opened.summary.path === path) branches = result?.branches ?? [];
      })
      .catch((error) => {
        if (opened.summary.path === path) errorText = normalizeError(error).message;
      })
      .finally(() => {
        loading = false;
      });
  });

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
      onClose();
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
    {#each matched as branch, index (`${branch.remote}:${branch.name}`)}
      {@const reason = reasonFor(branch)}
      {#if index === 0 && !branch.remote}<div class="branch-popover-group">本地分支</div>{/if}
      {#if branch.remote && index === localCount}<div class="branch-popover-group">远程分支</div>{/if}
      <div
        id={`${listId}-${index}`}
        class="branch-option switcher-option"
        class:active={index === active}
        role="option"
        aria-selected={isCurrent(branch)}
        aria-disabled={reason ? "true" : undefined}
        data-index={index}
        title={reason ?? branch.name}
        tabindex="-1"
        onmousemove={() => (active = index)}
        onclick={() => void choose(branch)}
        onkeydown={() => {}}
      >
        <Icon name={branch.remote ? "cloud" : "branch"} size={13} class="switcher-icon" />
        <span class="branch-option-name">{branch.name}</span>
        {#if reason}<span class="switcher-reason">{reason}</span>{/if}
        {#if isCurrent(branch)}<span class="branch-picker-tag">当前</span>{/if}
      </div>
    {/each}
    {#if matched.length >= VISIBLE_LIMIT}
      <p class="branch-popover-empty">只显示前 {VISIBLE_LIMIT} 个，输入关键词缩小范围。</p>
    {/if}
  {/snippet}
  {#snippet foot()}
    {#each ACTIONS as action (action.label)}
      <button type="button" class="menu-item" onclick={() => onCommand(action.id)}>
        <Icon name={action.icon} size={14} />
        <span>{action.label}</span>
      </button>
    {/each}
  {/snippet}
</Popover>
