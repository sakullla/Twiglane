<script lang="ts">
  import { api, pickDirectory } from "../api";
  import { normalizeError } from "../errors";
  import type { OpenedRepository, RemoteInfo, StatusSnapshot } from "../types";
  import BranchDialog from "./BranchDialog.svelte";
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
    onOpenHistory: (query: string) => void;
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
    onOpenHistory,
    nextId,
  }: Props = $props();

  let cloneUrl = $state("");
  let cloneParent = $state("");
  let cloneName = $state("");
  let remotes = $state<RemoteInfo[]>([]);
  let remoteName = $state("origin");
  let remoteUrl = $state("");
  let localBusy = $state(false);
  /**
   * 远程列表的读取结果：只有真正读完才写入，写锁期间跳过的那次不算。
   * ok 为假时不再自动重读（失败也会释放锁，否则会循环），由「重试」清空。
   */
  let loaded = $state<{ key: string; ok: boolean } | null>(null);

  let blocked = $derived(disabled || localBusy);
  let remotesFailed = $derived(loaded?.key === opened?.summary.path && loaded?.ok === false);
  let remotesReady = $derived(loaded?.key === opened?.summary.path && loaded?.ok === true);

  $effect(() => {
    // 这个组件常驻挂载：每次打开都要重新读。
    if (mode !== "remote" || !opened) {
      loaded = null;
      return;
    }
    if (loaded?.key === opened.summary.path || blocked) return;
    void loadRemotes();
  });

  async function run<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    localBusy = true;
    onBusy(name);
    try {
      return await action();
    } catch (error) {
      onFailure(normalizeError(error));
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
    const key = current.summary.path;
    const settle = (ok: boolean) => {
      if (mode === "remote") loaded = { key, ok };
    };
    const result = await run("remote", async () => {
      try {
        const state = await api.remoteState(key, current.generation, nextId());
        settle(true);
        return state;
      } catch (error) {
        settle(false);
        throw error;
      }
    });
    if (!result || opened?.summary.path !== key) return;
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
    const exists = remotes.some((item) => item.name === name);
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
    task="remote"
    description="名称和地址来自 Git 配置。凭据不会保存，展示时也会隐藏。"
    {onClose}
  >
    <div class="list-box">
      {#if remotesFailed}
        <div class="list-empty">
          没有读到远程配置。
          <button type="button" class="btn btn-secondary btn-sm" disabled={blocked} onclick={() => (loaded = null)}>重试</button>
        </div>
      {:else if !remotesReady}
        <div class="list-empty" data-remote-loading><span class="spinner"></span> 正在读取远程</div>
      {:else if remotes.length === 0}
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
    <p class="hint">名称已存在时会更新地址，否则新增远程。</p>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
      <button type="button" class="btn btn-primary" disabled={blocked} onclick={saveRemote}>
        <Icon name="check" size={14} />保存远程
      </button>
    {/snippet}
  </Modal>
{:else if mode === "branch" && opened}
  <BranchDialog {opened} {disabled} {onClose} {onBusy} {onSnapshot} {onFailure} {onNotice} {onOpenHistory} {nextId} />
{/if}
