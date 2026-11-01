<script lang="ts">
  import { api } from "../api";
  import { filterBranches } from "../branches";
  import { normalizeError } from "../errors";
  import type { BranchRecord, BranchState, OpenedRepository, StatusSnapshot } from "../types";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import TagManager from "./TagManager.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    onClose: () => void;
    onBusy: (name: string | null) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenHistory?: (query: string) => void;
    nextId: () => number;
  }

  let { opened, disabled, onClose, onBusy, onSnapshot, onFailure, onNotice, onOpenHistory, nextId }: Props = $props();

  let branches = $state<BranchRecord[]>([]);
  let branchQuery = $state("");
  let branchName = $state("");
  let branchScope = $state<"local" | "remote" | "tags">("local");
  let localBusy = $state(false);
  let errorText = $state<string | null>(null);
  let failureCode = $state<string | null>(null);
  let loadedKey = "";
  let confirmDelete = $state<
    | { kind: "local"; name: string; body: string }
    | { kind: "remote"; remote: string; name: string; body: string }
    | null
  >(null);

  let blocked = $derived(disabled || localBusy);
  let localCount = $derived(branches.filter((branch) => !branch.remote).length);
  let remoteCount = $derived(branches.filter((branch) => branch.remote).length);
  let visibleBranches = $derived(
    filterBranches(
      branches.filter((branch) => (branchScope === "local" ? !branch.remote : branch.remote)),
      branchQuery,
    ),
  );
  let current = $derived(opened.snapshot.branch);

  $effect(() => {
    const key = opened.summary.path;
    if (key === loadedKey) return;
    loadedKey = key;
    confirmDelete = null;
    void loadBranches();
  });

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    localBusy = true;
    errorText = null;
    failureCode = null;
    onBusy("branch");
    try {
      return await action();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      failureCode = failure.code;
      onFailure(failure);
      return undefined;
    } finally {
      localBusy = false;
      onBusy(null);
    }
  }

  function applyBranches(result: BranchState) {
    branches = result.branches;
    onSnapshot(result.snapshot);
  }

  async function loadBranches() {
    const path = opened.summary.path;
    const result = await run(() => api.branchState(path, opened.generation, nextId()));
    if (!result || opened.summary.path !== path) return;
    applyBranches(result);
  }

  async function createNamedBranch() {
    const currentRepo = opened;
    const name = branchName.trim();
    if (!name) return;
    const result = await run(() => api.createBranch(currentRepo.summary.path, name, currentRepo.generation, nextId()));
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    applyBranches(result);
    branchName = "";
    branchScope = "local";
    onNotice(`已创建分支 ${name}，当前分支没有切换。`);
  }

  async function switchTo(name: string) {
    const currentRepo = opened;
    const result = await run(() => api.switchBranch(currentRepo.summary.path, name, currentRepo.generation, nextId()));
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    applyBranches(result);
    onNotice(`已切换到 ${result.snapshot.branch.name ?? name}`);
    onClose();
  }

  function askDelete(branch: BranchRecord) {
    if (branch.remote) {
      const slash = branch.name.indexOf("/");
      if (slash <= 0) return;
      confirmDelete = {
        kind: "remote",
        remote: branch.name.slice(0, slash),
        name: branch.name.slice(slash + 1),
        body: `将从远程删除 ${branch.name}。这不会强行推送，但远程上的该分支会被移除。取消则不会执行。`,
      };
      return;
    }
    confirmDelete = {
      kind: "local",
      name: branch.name,
      body: "将删除这个本地分支。如果它还有未合入当前分支的提交，需要再次确认。取消则不会执行。",
    };
  }

  async function confirmRemoval() {
    const currentRepo = opened;
    const target = confirmDelete;
    if (!target || blocked) return;
    if (target.kind === "remote") {
      confirmDelete = null;
      const result = await run(() =>
        api.deleteRemoteBranch(currentRepo.summary.path, target.remote, target.name, true, currentRepo.generation, nextId()),
      );
      if (!result) return;
      applyBranches(result);
      onNotice(`已删除远程分支 ${target.remote}/${target.name}`);
      return;
    }
    const result = await run(() =>
      api.deleteBranch(currentRepo.summary.path, target.name, false, currentRepo.generation, nextId()),
    );
    if (result) {
      confirmDelete = null;
      applyBranches(result);
      onNotice(`已删除本地分支 ${target.name}`);
      return;
    }
    if (failureCode === "branch_unmerged") {
      confirmDelete = {
        kind: "local",
        name: target.name,
        body: "该分支含有尚未合入当前分支的提交。确认后才会删除，删除后这些提交不能由这里自动恢复。",
      };
    } else {
      confirmDelete = null;
    }
  }

  async function confirmUnmerged() {
    const currentRepo = opened;
    const target = confirmDelete;
    if (!target || target.kind !== "local") return;
    confirmDelete = null;
    const result = await run(() =>
      api.deleteBranch(currentRepo.summary.path, target.name, true, currentRepo.generation, nextId()),
    );
    if (!result) return;
    applyBranches(result);
    onNotice(`已删除未合入的本地分支 ${target.name}`);
  }
</script>

<Modal
  title="分支与标签"
  titleId="repo-dialog-title"
  icon="branch"
  size="xl"
  description="管理开发分支和版本标签。切换分支成功后自动返回工作区。"
  {onClose}
>
  <div class="branch-current">
    <span class="branch-current-icon"><Icon name="branch" size={22} /></span>
    <div class="branch-current-copy">
      <span>当前分支</span>
      <strong>{current.name ?? "游离 HEAD"}</strong>
      <small>{current.upstream ? `跟踪 ${current.upstream}` : "尚未关联上游分支"}</small>
    </div>
    {#if current.upstream}
      <div class="branch-current-sync">
        <span title="待推送提交"><Icon name="arrow-up" size={13} />{current.ahead ?? 0}</span>
        <span title="待拉取提交"><Icon name="arrow-down" size={13} />{current.behind ?? 0}</span>
      </div>
    {/if}
    <span class="branch-current-badge"><span class="local-dot"></span>正在使用</span>
  </div>

  <div class="branch-manager-tools">
    <div class="segmented" role="group" aria-label="分支类型">
      <button type="button" aria-pressed={branchScope === "local"} onclick={() => (branchScope = "local")}>
        <Icon name="branch" size={12} />本地 <span class="count">{localCount}</span>
      </button>
      <button type="button" aria-pressed={branchScope === "remote"} onclick={() => (branchScope = "remote")}>
        <Icon name="cloud" size={12} />远程 <span class="count">{remoteCount}</span>
      </button>
      <button type="button" aria-pressed={branchScope === "tags"} onclick={() => (branchScope = "tags")}>
        <Icon name="tag" size={12} />标签
      </button>
    </div>
    {#if branchScope !== "tags"}
      <div class="field branch-search">
        <Icon name="search" size={14} />
        <label class="sr-only" for="branch-search">搜索分支</label>
        <input id="branch-search" data-autofocus bind:value={branchQuery} placeholder={`搜索${branchScope === "local" ? "本地" : "远程"}分支`} autocomplete="off" spellcheck="false" />
        {#if branchQuery}
          <button type="button" class="field-clear" aria-label="清空分支搜索" onclick={() => (branchQuery = "")}><Icon name="x" size={12} /></button>
        {/if}
      </div>
    {/if}
  </div>

  {#if branchScope !== "tags"}
  <div class="list-box branch-list" aria-label={branchScope === "local" ? "本地分支" : "远程分支"}>
    <div class="list-section">
      <span>{branchScope === "local" ? "本地分支" : "远程分支"}</span>
      <span class="spacer"></span>
      <span>{visibleBranches.length} 个结果</span>
    </div>
    {#if visibleBranches.length === 0}
      <div class="empty compact branch-empty">
        <span class="empty-icon"><Icon name="search" size={20} /></span>
        <strong>没有匹配的分支</strong>
        <p>换一个关键词，或清空搜索后再试。</p>
      </div>
    {:else}
      {#each visibleBranches as branch (branch.name)}
        <div
          class="list-row branch-row"
          class:current={branch.current}
          role="button"
          tabindex={branch.current ? -1 : 0}
          aria-label={branch.current ? `当前分支 ${branch.name}` : `切换到 ${branch.name}`}
          aria-disabled={branch.current || blocked}
          title={branch.current ? "当前正在使用的分支" : `点击切换到 ${branch.name}`}
          onclick={() => {
            if (!branch.current) void switchTo(branch.name);
          }}
          onkeydown={(event) => {
            if (!branch.current && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              void switchTo(branch.name);
            }
          }}
        >
          <span class="branch-row-icon"><Icon name={branch.current ? "check-circle" : branch.remote ? "cloud" : "branch"} size={16} /></span>
          <div class="lr-main">
            <span class="lr-title">
              <span title={branch.name}>{branch.name}</span>
              {#if branch.current}<span class="chip current">当前</span>{/if}
              {#if branch.worktree && !branch.current}<span class="chip">其他工作区</span>{/if}
            </span>
            <span class="lr-sub">
              {#if branch.upstream}上游 {branch.upstream}{:else if branch.worktree}工作区 {branch.worktree}{:else if branch.remote}远程跟踪分支{:else}仅存在于本地{/if}
            </span>
          </div>
          {#if !branch.current}
            <span class="lr-actions">
              <button
                type="button"
                class="icon-btn sm danger"
                aria-label={branch.remote ? `删除远程 ${branch.name}` : `删除 ${branch.name}`}
                title={branch.remote ? "删除远程分支" : "删除本地分支"}
                disabled={blocked}
                onclick={(event) => {
                  event.stopPropagation();
                  askDelete(branch);
                }}
                onkeydown={(event) => event.stopPropagation()}
              >
                <Icon name="trash" size={13} />
              </button>
            </span>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  {#if confirmDelete}
    <div class="callout warn" role="alert">
      <Icon name="alert" size={15} />
      <div class="callout-body">
        <p>{confirmDelete.body}</p>
        <div class="row">
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => (confirmDelete = null)}>取消</button>
          {#if confirmDelete.kind === "local" && confirmDelete.body.includes("尚未合入")}
            <button type="button" class="btn btn-danger btn-sm" disabled={blocked} onclick={confirmUnmerged}>确认删除未合入分支</button>
          {:else}
            <button type="button" class="btn btn-danger btn-sm" disabled={blocked} onclick={confirmRemoval}>确认删除</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  {#if errorText}
    <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
  {/if}

  <div class="branch-create">
    <span class="branch-create-icon"><Icon name="plus" size={17} /></span>
    <div class="branch-create-copy">
      <label class="label" for="branch-name">从当前状态创建新分支</label>
      <div class="row">
        <input
          id="branch-name"
          class="input"
          bind:value={branchName}
          placeholder="例如 feature/login"
          autocomplete="off"
          spellcheck="false"
          disabled={blocked}
          onkeydown={(event) => {
            if (event.key === "Enter" && branchName.trim()) {
              event.preventDefault();
              void createNamedBranch();
            }
          }}
        />
        <button type="button" class="btn btn-primary" disabled={blocked || branchName.trim().length === 0} onclick={createNamedBranch}>
          <Icon name="plus" size={14} />创建分支
        </button>
      </div>
      <p class="hint">基于当前提交创建，不会自动切换。</p>
    </div>
  </div>
  {:else}
    <TagManager
      {opened}
      disabled={blocked}
      {onBusy}
      {onSnapshot}
      {onFailure}
      {onNotice}
      onOpenHistory={(query) => {
        onClose();
        onOpenHistory?.(query);
      }}
      {nextId}
    />
  {/if}
  {#snippet footer()}
    <span class="hint"><Icon name="check-circle" size={12} />{branchScope === "tags" ? "标签可直接定位到目标提交" : "切换成功后自动关闭"}</span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
