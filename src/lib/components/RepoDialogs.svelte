<script lang="ts">
  import { api, pickDirectory } from "../api";
  import { branchLists, filterBranches } from "../branches";
  import { normalizeError } from "../errors";
  import type { BranchRecord, BranchState, OpenedRepository, RemoteInfo, StatusSnapshot } from "../types";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    mode: "clone" | "remote" | "branch" | null;
    opened: OpenedRepository | null;
    disabled: boolean;
    onClose: () => void;
    onBusy: (name: string | null) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onOpened: (repo: OpenedRepository) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    nextId: () => number;
  }

  let {
    mode,
    opened,
    disabled,
    onClose,
    onBusy,
    onSnapshot,
    onOpened,
    onFailure,
    onNotice,
    nextId,
  }: Props = $props();

  let cloneUrl = $state("");
  let cloneParent = $state("");
  let cloneName = $state("");
  let remotes = $state<RemoteInfo[]>([]);
  let remoteName = $state("origin");
  let remoteUrl = $state("");
  let branches = $state<BranchRecord[]>([]);
  let branchQuery = $state("");
  let branchName = $state("");
  let localBusy = $state(false);
  let confirmDelete = $state<
    | { kind: "local"; name: string; body: string }
    | { kind: "remote"; remote: string; name: string; body: string }
    | null
  >(null);
  let loadedKey = "";

  let blocked = $derived(disabled || localBusy);
  let visibleBranches = $derived(filterBranches(branches, branchQuery));
  let grouped = $derived(branchLists(visibleBranches));

  $effect(() => {
    const key = `${mode}:${opened?.summary.path ?? ""}`;
    if (key === loadedKey) return;
    loadedKey = key;
    confirmDelete = null;
    if (mode === "remote" && opened) void loadRemotes();
    if (mode === "branch" && opened) void loadBranches();
  });

  async function run<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    localBusy = true;
    onBusy(name);
    try {
      return await action();
    } catch (error) {
      onFailure(error);
      return undefined;
    } finally {
      localBusy = false;
      onBusy(null);
    }
  }

  async function chooseParent() {
    const path = await pickDirectory("选择克隆的父目录");
    if (path) cloneParent = path;
  }

  async function startClone() {
    const url = cloneUrl.trim();
    if (!url || !cloneParent) {
      onNotice("请填写远程地址，并选择一个已存在的父目录。");
      return;
    }
    const result = await run("clone", () => api.cloneRepository(url, cloneParent, cloneName.trim(), nextId()));
    if (!result) return;
    onNotice(`已克隆并打开 ${result.opened.summary.name}`);
    onOpened(result.opened);
    onClose();
  }

  async function loadRemotes() {
    const current = opened;
    if (!current) return;
    const result = await run("remote", () => api.remoteState(current.summary.path, current.generation, nextId()));
    if (!result || opened?.summary.path !== current.summary.path) return;
    remotes = result.remotes;
    onSnapshot(result.snapshot);
    if (!remoteName && result.remotes[0]) remoteName = result.remotes[0].name;
  }

  function editRemote(remote: RemoteInfo) {
    remoteName = remote.name;
    remoteUrl = remote.fetchUrl.includes("[redacted]") ? "" : remote.fetchUrl;
  }

  async function saveRemote() {
    const current = opened;
    const name = remoteName.trim();
    const url = remoteUrl.trim();
    if (!current || !name || !url) {
      onNotice("请填写远程名称和地址。不要把令牌写进地址。");
      return;
    }
    const exists = remotes.some((remote) => remote.name === name);
    const result = await run("remote", () =>
      exists
        ? api.setRemoteUrl(current.summary.path, name, url, current.generation, nextId())
        : api.addRemote(current.summary.path, name, url, current.generation, nextId()),
    );
    if (!result) return;
    remotes = result.remotes;
    onSnapshot(result.snapshot);
    onNotice(exists ? `已更新远程 ${name}` : `已添加远程 ${name}`);
  }

  async function loadBranches() {
    const current = opened;
    if (!current) return;
    const result = await run("branch", () => api.branchState(current.summary.path, current.generation, nextId()));
    if (!result || opened?.summary.path !== current.summary.path) return;
    applyBranches(result);
  }

  function applyBranches(result: BranchState) {
    branches = result.branches;
    onSnapshot(result.snapshot);
  }

  async function createNamedBranch() {
    const current = opened;
    const name = branchName.trim();
    if (!current || !name) return;
    const result = await run("branch", () => api.createBranch(current.summary.path, name, current.generation, nextId()));
    if (!result) return;
    applyBranches(result);
    branchName = "";
    onNotice(`已创建分支 ${name}，当前分支没有切换。`);
  }

  async function switchTo(name: string) {
    const current = opened;
    if (!current) return;
    const result = await run("branch", () => api.switchBranch(current.summary.path, name, current.generation, nextId()));
    if (!result) return;
    applyBranches(result);
    onNotice(`已切换到 ${result.snapshot.branch.name ?? name}`);
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
    const current = opened;
    const target = confirmDelete;
    if (!current || !target || blocked) return;
    if (target.kind === "remote") {
      confirmDelete = null;
      const result = await run("branch", () =>
        api.deleteRemoteBranch(current.summary.path, target.remote, target.name, true, current.generation, nextId()),
      );
      if (!result) return;
      applyBranches(result);
      onNotice(`已删除远程分支 ${target.remote}/${target.name}`);
      return;
    }
    localBusy = true;
    onBusy("branch");
    try {
      const result = await api.deleteBranch(current.summary.path, target.name, false, current.generation, nextId());
      confirmDelete = null;
      applyBranches(result);
      onNotice(`已删除本地分支 ${target.name}`);
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "branch_unmerged") {
        confirmDelete = {
          kind: "local",
          name: target.name,
          body: "该分支含有尚未合入当前分支的提交。确认后才会删除，删除后这些提交不能由这里自动恢复。",
        };
      } else {
        confirmDelete = null;
      }
      onFailure(error);
    } finally {
      localBusy = false;
      onBusy(null);
    }
  }

  async function confirmUnmerged() {
    const current = opened;
    const target = confirmDelete;
    if (!current || !target || target.kind !== "local") return;
    confirmDelete = null;
    const result = await run("branch", () =>
      api.deleteBranch(current.summary.path, target.name, true, current.generation, nextId()),
    );
    if (!result) return;
    applyBranches(result);
    onNotice(`已删除未合入的本地分支 ${target.name}`);
  }
</script>

{#if mode === "clone"}
  <Modal
    title="克隆仓库"
    titleId="repo-dialog-title"
    icon="download"
    description="克隆到新目录后会直接打开。目标里已有文件时不会覆盖。"
    {onClose}
  >
    <div class="form-grid">
      <div class="form-group">
        <label class="label" for="clone-url">远程地址</label>
        <input
          id="clone-url"
          class="input code"
          data-autofocus
          bind:value={cloneUrl}
          placeholder="https://…、git@… 或本机绝对路径"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="form-group">
        <label class="label" for="clone-parent">父目录</label>
        <div class="row" style="flex-wrap: nowrap">
          <input id="clone-parent" class="input" readonly value={cloneParent} placeholder="选择一个已存在的目录" />
          <button type="button" class="btn btn-secondary" disabled={blocked} onclick={chooseParent}>
            <Icon name="folder-open" size={14} />选择目录
          </button>
        </div>
      </div>
      <div class="form-group">
        <label class="label" for="clone-name">目录名</label>
        <input id="clone-name" class="input" bind:value={cloneName} placeholder="可留空，从地址推断" autocomplete="off" spellcheck="false" />
      </div>
      <div class="callout info">
        <Icon name="info" size={15} />
        <span>认证使用系统凭据助手或 SSH agent，不要把令牌写进地址。需要交互输入时会停止，而不是一直等待。</span>
      </div>
    </div>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>取消</button>
      <button type="button" class="btn btn-primary" disabled={blocked || !cloneUrl.trim() || !cloneParent} onclick={startClone}>
        {#if localBusy}<span class="spinner"></span>{:else}<Icon name="download" size={14} />{/if}
        开始克隆
      </button>
    {/snippet}
  </Modal>
{:else if mode === "remote"}
  <Modal
    title="远程"
    titleId="repo-dialog-title"
    icon="globe"
    size="lg"
    description="名称和地址来自 Git 配置。凭据不会保存，展示时也会隐藏。"
    {onClose}
  >
    <div class="list-box">
      {#if remotes.length === 0}
        <div class="list-empty">还没有远程。在下面添加一个。</div>
      {:else}
        {#each remotes as remote (remote.name)}
          <div class="list-row">
            <Icon name="cloud" />
            <div class="lr-main">
              <span class="lr-title"><span>{remote.name}</span></span>
              <span class="lr-sub mono" title={remote.fetchUrl}>{remote.fetchUrl}</span>
              {#if remote.pushUrl}
                <span class="lr-sub mono" title={remote.pushUrl}>推送地址 {remote.pushUrl}</span>
              {/if}
            </div>
            <button type="button" class="btn btn-ghost btn-sm" disabled={blocked} onclick={() => editRemote(remote)}>
              <Icon name="pencil" size={13} />修改
            </button>
          </div>
        {/each}
      {/if}
    </div>
    <div class="row" style="flex-wrap: nowrap; align-items: flex-end">
      <div class="form-group" style="width: 160px; flex: none">
        <label class="label" for="remote-name">名称</label>
        <input id="remote-name" class="input" bind:value={remoteName} autocomplete="off" spellcheck="false" />
      </div>
      <div class="form-group" style="flex: 1">
        <label class="label" for="remote-url">地址</label>
        <input id="remote-url" class="input code" bind:value={remoteUrl} placeholder="不包含令牌的 HTTPS、SSH 或本机路径" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <p class="hint">本地查看和提交不需要登录研发平台。名称已存在时会更新地址，否则新增远程。</p>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
      <button type="button" class="btn btn-primary" disabled={blocked} onclick={saveRemote}>
        <Icon name="check" size={14} />保存远程
      </button>
    {/snippet}
  </Modal>
{:else if mode === "branch"}
  <Modal
    title="分支"
    titleId="repo-dialog-title"
    icon="branch"
    size="lg"
    description="当前分支、未合入提交和其他工作区正在使用的分支会受到保护。切换若会覆盖修改，会停下来并保留工作区。"
    {onClose}
  >
    <div class="row" style="flex-wrap: nowrap">
      <div class="field" style="flex: 1">
        <Icon name="search" size={14} />
        <label class="sr-only" for="branch-search">搜索分支</label>
        <input id="branch-search" data-autofocus bind:value={branchQuery} placeholder="搜索本地或远程分支" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <div class="list-box" style="max-height: 340px">
      <div class="list-section">本地 <span class="count">{grouped.local.length}</span></div>
      {#if grouped.local.length === 0}
        <div class="list-empty">没有匹配的本地分支。</div>
      {/if}
      {#each grouped.local as branch (branch.name)}
        <div class="list-row" class:current={branch.current}>
          <Icon name={branch.current ? "check-circle" : "branch"} />
          <div class="lr-main">
            <span class="lr-title">
              <span title={branch.name}>{branch.name}</span>
              {#if branch.current}<span class="chip current">当前</span>{/if}
            </span>
            {#if branch.upstream || (branch.worktree && !branch.current)}
              <span class="lr-sub">
                {#if branch.upstream}上游 {branch.upstream}{/if}
                {#if branch.worktree && !branch.current}{branch.upstream ? " · " : ""}工作区 {branch.worktree}{/if}
              </span>
            {/if}
          </div>
          {#if !branch.current}
            <span class="lr-actions">
              <button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={() => switchTo(branch.name)}>切换</button>
              <button type="button" class="icon-btn sm danger" aria-label={`删除 ${branch.name}`} title="删除" disabled={blocked} onclick={() => askDelete(branch)}>
                <Icon name="trash" size={13} />
              </button>
            </span>
          {/if}
        </div>
      {/each}
      <div class="list-section">远程 <span class="count">{grouped.remote.length}</span></div>
      {#if grouped.remote.length === 0}
        <div class="list-empty">没有匹配的远程分支。</div>
      {/if}
      {#each grouped.remote as branch (`remote:${branch.name}`)}
        <div class="list-row">
          <Icon name="cloud" />
          <div class="lr-main">
            <span class="lr-title"><span title={branch.name}>{branch.name}</span></span>
          </div>
          <span class="lr-actions">
            <button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={() => switchTo(branch.name)}>切换</button>
            <button type="button" class="icon-btn sm danger" aria-label={`删除远程 ${branch.name}`} title="删除远程分支" disabled={blocked} onclick={() => askDelete(branch)}>
              <Icon name="trash" size={13} />
            </button>
          </span>
        </div>
      {/each}
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
    <div class="form-group">
      <label class="label" for="branch-name">从当前状态创建新分支</label>
      <div class="row" style="flex-wrap: nowrap">
        <input
          id="branch-name"
          class="input"
          bind:value={branchName}
          placeholder="例如 feature/login"
          autocomplete="off"
          spellcheck="false"
          onkeydown={(event) => {
            if (event.key === "Enter" && branchName.trim()) {
              event.preventDefault();
              void createNamedBranch();
            }
          }}
        />
        <button type="button" class="btn btn-primary" disabled={blocked || branchName.trim().length === 0} onclick={createNamedBranch}>
          <Icon name="plus" size={14} />创建
        </button>
      </div>
      <p class="hint" style="margin-top: 6px">创建后不会自动切换到新分支。</p>
    </div>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
    {/snippet}
  </Modal>
{/if}
