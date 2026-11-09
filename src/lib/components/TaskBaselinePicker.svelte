<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { shortOid } from "../history";
  import type { BranchRecord, HistoryCommit, OpenedRepository } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 任务起点选择器：普通仓库没有 cliora 链接时，起点必须由用户明确选定。
   *
   * 这里刻意不预选任何分支或提交：当前分支、默认分支与 HEAD 都可能不是这次任务的
   * 真正起点，猜一个会让「任务范围」变成一句不成立的话（R1）。候选只提供可选项，
   * 点击或手动输入后才交给后端做完整 OID 与 ancestry 校验。
   */
  interface Props {
    opened: OpenedRepository;
    disabled?: boolean;
    nextId: () => number;
    /** 用户确认的起点写法（分支名或提交标识），由外壳交给 task_review 校验。 */
    onPick: (baseline: string) => void;
    onFailure?: (error: unknown) => void;
    /** 候选重读的触发键：外部变化后由外壳递增。 */
    reloadKey?: number;
  }

  let { opened, disabled = false, nextId, onPick, onFailure, reloadKey = 0 }: Props = $props();

  let branches = $state<BranchRecord[]>([]);
  let commits = $state<HistoryCommit[]>([]);
  let manual = $state("");
  let loading = $state(false);
  let note = $state<string | null>(null);
  let serial = 0;

  async function loadCandidates(): Promise<void> {
    const at = ++serial;
    loading = true;
    note = null;
    try {
      const listing = await api.branchList(opened.summary.path, opened.generation, nextId());
      if (at !== serial) return;
      branches = listing.branches.filter((branch) => !branch.remote);
      const page = await api.historyPage(opened.summary.path, "", 0, listing.generation, nextId());
      if (at !== serial) return;
      commits = page.commits.slice(0, 30);
    } catch (error) {
      if (at !== serial) return;
      note = normalizeError(error).message;
      onFailure?.(error);
    } finally {
      if (at === serial) loading = false;
    }
  }

  let loadedKey = "";
  $effect(() => {
    const key = `${opened.summary.path}|${reloadKey}|${opened.generation}`;
    if (key === loadedKey) return;
    loadedKey = key;
    void loadCandidates();
  });

  function submit(): void {
    const value = manual.trim();
    if (!value || disabled) return;
    onPick(value);
  }
</script>

<div class="task-baseline" aria-label="选择任务起点">
  <p class="task-baseline-note" role="note">
    任务起点必须由你明确选择：这里不会用当前 HEAD 或默认分支代替。
  </p>
  <div class="field sm">
    <Icon name="search" size={14} />
    <input
      id="task-baseline-search"
      aria-label="按提交或分支指定任务起点"
      placeholder="输入分支名或提交标识"
      autocomplete="off"
      spellcheck="false"
      value={manual}
      {disabled}
      title={disabled ? "正在读取仓库，稍后再选起点" : "输入分支名或提交标识，回车确认"}
      oninput={(event) => (manual = (event.currentTarget as HTMLInputElement).value)}
      onkeydown={(event) => {
        if (event.isComposing) return;
        if (event.key !== "Enter") return;
        event.preventDefault();
        submit();
      }}
    />
    {#if manual}
      <button type="button" class="field-clear" aria-label="清空起点输入" onclick={() => (manual = "")}>
        <Icon name="x" size={12} />
      </button>
    {/if}
  </div>
  <button
    type="button"
    class="btn btn-secondary btn-sm"
    disabled={disabled || manual.trim() === ""}
    title={disabled
      ? "正在读取仓库，稍后再选起点"
      : manual.trim() === ""
        ? "先输入分支名或提交标识"
        : `以 ${manual.trim()} 为任务起点读取净差异`}
    onclick={submit}
  >
    用这个起点
  </button>

  {#if note}
    <p class="file-tree-status danger" role="alert">读取候选起点失败：{note}</p>
  {/if}
  {#if loading}
    <p class="task-baseline-note" role="status">正在读取分支与最近提交……</p>
  {/if}

  <div class="task-baseline-group">
    <h4>分支</h4>
    {#if branches.length === 0 && !loading}
      <p class="task-baseline-note">没有可用的本地分支。</p>
    {:else}
      <ul class="task-baseline-list">
        {#each branches as branch (branch.name)}
          <li>
            <button
              type="button"
              class="task-baseline-item"
              {disabled}
              title={disabled ? "正在读取仓库，稍后再选起点" : `以分支 ${branch.name} 为任务起点`}
              onclick={() => onPick(branch.name)}
            >
              <Icon name="branch" size={13} />
              <span class="name">{branch.name}</span>
              {#if branch.current}<span class="tag">当前分支</span>{/if}
              {#if branch.worktree}<span class="tag">已在其工作区</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="task-baseline-group">
    <h4>最近提交</h4>
    {#if commits.length === 0 && !loading}
      <p class="task-baseline-note">当前分支还没有可选的提交。</p>
    {:else}
      <ul class="task-baseline-list">
        {#each commits as commit (commit.oid)}
          <li>
            <button
              type="button"
              class="task-baseline-item"
              {disabled}
              title={disabled ? "正在读取仓库，稍后再选起点" : `以提交 ${shortOid(commit.oid)} 为任务起点`}
              onclick={() => onPick(commit.oid)}
            >
              <span class="oid">{shortOid(commit.oid)}</span>
              <span class="name">{commit.summary}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
