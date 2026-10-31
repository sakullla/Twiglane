<script lang="ts">
  import { api, pickDirectory } from "../api";
  import { branchLists, filterBranches } from "../branches";
  import { normalizeError } from "../errors";
  import type { BranchRecord, BranchState, OpenedRepository, RemoteInfo, StatusSnapshot } from "../types";

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

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

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

{#if mode}
  <div class="modal-backdrop" role="presentation" onkeydown={onKey}>
    <div class="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="repo-dialog-title">
      {#if mode === "clone"}
        <h2 id="repo-dialog-title">克隆仓库</h2>
        <p>克隆到新目录后会直接打开。目标里已有文件时不会覆盖。认证使用系统凭据助手或 SSH agent，不要把令牌写进地址。</p>
        <label class="hint" for="clone-url">远程地址</label>
        <input id="clone-url" class="text-input" bind:value={cloneUrl} placeholder="https://、git@ 或本机绝对路径" />
        <label class="hint" for="clone-parent">父目录</label>
        <div class="row">
          <input id="clone-parent" class="text-input" readonly value={cloneParent} />
          <button type="button" class="ghost" disabled={blocked} onclick={chooseParent}>选择目录</button>
        </div>
        <label class="hint" for="clone-name">目录名（可留空，从地址推断）</label>
        <input id="clone-name" class="text-input" bind:value={cloneName} />
        <div class="row">
          <span class="spacer"></span>
          <button type="button" class="ghost" onclick={onClose}>取消</button>
          <button type="button" class="primary" disabled={blocked} onclick={startClone}>开始克隆</button>
        </div>
      {:else if mode === "remote"}
        <h2 id="repo-dialog-title">远程</h2>
        <p>这里的名称和地址来自 Git 配置。凭据不会保存，展示时也会隐藏。本地查看和提交不需要登录研发平台。</p>
        {#if remotes.length === 0}
          <p class="hint">还没有远程。</p>
        {:else}
          <div class="branch-list">
            {#each remotes as remote (remote.name)}
              <div class="branch-row">
                <div>
                  <strong>{remote.name}</strong>
                  <div class="repo-path" title={remote.fetchUrl}>{remote.fetchUrl}</div>
                  {#if remote.pushUrl}
                    <div class="repo-path" title={remote.pushUrl}>推送地址 {remote.pushUrl}</div>
                  {/if}
                </div>
                <button type="button" class="ghost compact" disabled={blocked} onclick={() => editRemote(remote)}>修改</button>
              </div>
            {/each}
          </div>
        {/if}
        <label class="hint" for="remote-name">名称</label>
        <input id="remote-name" class="text-input" bind:value={remoteName} />
        <label class="hint" for="remote-url">地址</label>
        <input id="remote-url" class="text-input" bind:value={remoteUrl} placeholder="不包含令牌的 HTTPS、SSH 或本机路径" />
        <div class="row">
          <span class="spacer"></span>
          <button type="button" class="ghost" onclick={onClose}>关闭</button>
          <button type="button" class="primary" disabled={blocked} onclick={saveRemote}>保存远程</button>
        </div>
      {:else}
        <h2 id="repo-dialog-title">分支</h2>
        <p>可以搜索、创建、切换和删除。当前分支、未合入提交和其他工作区正在使用的分支会受到保护。切换若会覆盖修改，会停下来并保留工作区。</p>
        <label class="hint" for="branch-search">搜索分支</label>
        <input id="branch-search" class="text-input" bind:value={branchQuery} placeholder="本地或远程分支名称" />
        <div class="branch-list">
          <p class="section-label">本地</p>
          {#if grouped.local.length === 0}
            <p class="hint">没有匹配的本地分支。</p>
          {/if}
          {#each grouped.local as branch (branch.name)}
            <div class="branch-row">
              <div>
                <strong>{branch.name}{branch.current ? " · 当前" : ""}</strong>
                {#if branch.upstream}<div class="repo-path">上游 {branch.upstream}</div>{/if}
                {#if branch.worktree && !branch.current}<div class="repo-path">工作区 {branch.worktree}</div>{/if}
              </div>
              <span class="row">
                {#if !branch.current}
                  <button type="button" class="ghost compact" disabled={blocked} onclick={() => switchTo(branch.name)}>切换</button>
                  <button type="button" class="danger compact" disabled={blocked} onclick={() => askDelete(branch)}>删除</button>
                {/if}
              </span>
            </div>
          {/each}
          <p class="section-label">远程</p>
          {#if grouped.remote.length === 0}
            <p class="hint">没有匹配的远程分支。</p>
          {/if}
          {#each grouped.remote as branch (`remote:${branch.name}`)}
            <div class="branch-row">
              <strong>{branch.name}</strong>
              <span class="row">
                <button type="button" class="ghost compact" disabled={blocked} onclick={() => switchTo(branch.name)}>切换</button>
                <button type="button" class="danger compact" disabled={blocked} onclick={() => askDelete(branch)}>删除远程</button>
              </span>
            </div>
          {/each}
        </div>
        <label class="hint" for="branch-name">从当前状态创建</label>
        <div class="row">
          <input id="branch-name" class="text-input" bind:value={branchName} placeholder="新的本地分支名称" />
          <button type="button" class="primary" disabled={blocked || branchName.trim().length === 0} onclick={createNamedBranch}>创建</button>
        </div>
        {#if confirmDelete}
          <div class="banner warn" role="alert">
            <p>{confirmDelete.body}</p>
            <div class="row">
              <button type="button" class="ghost" onclick={() => (confirmDelete = null)}>取消</button>
              {#if confirmDelete.kind === "local" && confirmDelete.body.includes("尚未合入")}
                <button type="button" class="danger" disabled={blocked} onclick={confirmUnmerged}>确认删除未合入分支</button>
              {:else}
                <button type="button" class="danger" disabled={blocked} onclick={confirmRemoval}>确认删除</button>
              {/if}
            </div>
          </div>
        {/if}
        <div class="row">
          <span class="spacer"></span>
          <button type="button" class="ghost" onclick={onClose}>关闭</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
