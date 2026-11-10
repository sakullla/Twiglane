<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { api, pickDirectory } from "../api";
  import { normalizeError } from "../errors";
  import type { HttpCredential, OpenedRepository, RemoteInfo, StatusSnapshot } from "../types";
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
    /** 克隆成功：外壳可以先问完（例如处理未保存的编辑草稿）再决定打开还是只通知，窗口等它结束才收起。 */
    onOpened: (repo: OpenedRepository) => void | Promise<void>;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenHistory: (query: string) => void;
    /** 分支分组。缺省开启。 */
    branchGroups?: boolean;
    /** 从被占用的分支打开另一个工作区。 */
    onOpenWorktree?: (repo: OpenedRepository) => void;
    /** 打开其他工作区之前的外壳关卡，返回 false 时不切换。 */
    beforeOpenWorktree?: (path: string) => Promise<boolean>;
    nextId: () => number;
    /** 读到或改动了远程列表：外壳据此更新同步菜单里的「推送到其他远程」。 */
    onRemotes?: (path: string, names: string[]) => void;
    /** 把当前分支推送到指定远程（不改上游）；有多个远程时在列表里提供入口。 */
    onPushTo?: (remote: string) => void;
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
    branchGroups = true,
    onOpenWorktree,
    beforeOpenWorktree,
    nextId,
    onRemotes,
    onPushTo,
  }: Props = $props();

  let cloneUrl = $state("");
  let cloneParent = $state("");
  let cloneName = $state("");
  /**
   * HTTP(S) 克隆被要求登录：就地展开用户名和密码（或访问令牌），用这组凭据重试。
   * 只对出错时的那个地址生效；改了地址就回到普通克隆。密码只留在内存里，关窗或成功后清掉。
   */
  let authPrompt = $state<{ url: string; message: string; retried: boolean } | null>(null);
  let authUser = $state("");
  let authPassword = $state("");
  let authRemember = $state(true);
  let authActive = $derived(authPrompt !== null && authPrompt.url === cloneUrl.trim());
  let authMissing = $derived(authActive && (!authUser.trim() || !authPassword));
  /** 克隆失败留在窗口里的原因：目标已有内容、目录名无效、Git 不可用等都在这里说明。 */
  let cloneError = $state<{ code: string; message: string } | null>(null);

  $effect(() => {
    if (mode !== "clone") {
      authPassword = "";
      cloneError = null;
    }
  });

  function isHttpUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }
  let remotes = $state<RemoteInfo[]>([]);
  let remoteName = $state("origin");
  let remoteUrl = $state("");
  let remoteNameInput = $state<HTMLInputElement | null>(null);
  let localBusy = $state(false);
  /** 克隆在途：后端不能取消，收起窗口后在后台继续。它占着写锁，但不碰当前仓库。 */
  let cloning = $state(false);
  /** 保存远程在途：结果未定，远程窗口不能关闭。读取远程时仍可关闭。 */
  let remoteWriting = $state(false);
  /** 后台克隆期间的远程读取：不走 run，否则结束时 onBusy(null) 会把克隆占着的写锁清掉。 */
  let quietReading = $state(false);
  /**
   * 远程列表的读取结果：只有真正读完才写入，写锁期间跳过的那次不算。
   * ok 为假时不再自动重读（失败也会释放锁，否则会循环），由「重试」清空。
   * generation 过期不算失败：readRemotes 内部跟上后重读一次，只有重读也失败才记 ok 为假。
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
    if (loaded?.key === opened.summary.path || quietReading || (blocked && !cloning)) return;
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

  async function runClone<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    cloning = true;
    try {
      return await run("clone", action);
    } finally {
      cloning = false;
    }
  }

  async function runRemoteWrite<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    remoteWriting = true;
    try {
      return await run("remote", action);
    } finally {
      remoteWriting = false;
    }
  }

  async function readWhileCloning<T>(action: () => Promise<T>): Promise<T | undefined> {
    quietReading = true;
    try {
      return await action();
    } catch (error) {
      onFailure(normalizeError(error));
      return undefined;
    } finally {
      quietReading = false;
    }
  }

  async function chooseParent() {
    const path = await pickDirectory("选择克隆的父目录");
    if (path) {
      cloneParent = path;
      cloneError = null;
    }
  }

  /** 克隆失败时的下一步：原因已经在错误里，这里只补用户现在能做什么。 */
  function cloneNextStep(code: string): string {
    switch (code) {
      case "clone_destination":
        return "下一步：换一个目录名，或选择其他父目录后重试；已有文件不会被覆盖。";
      case "clone_name":
        return "下一步：修改目录名，不能为空、不能包含 / 或 \\，也不能以 - 开头。";
      case "invalid_path":
      case "path_missing":
      case "not_directory":
      case "path_unreadable":
      case "permission":
        return "下一步：检查父目录是否仍然存在、是可读文件夹，必要时重新选择父目录。";
      case "git_missing":
        return "下一步：在「设置 → 运行环境」重新检测，或选择可用的 Git 后重试。";
      case "auth":
        return "下一步：检查 SSH agent 或凭据是否可用；需要登录的 HTTP(S) 地址重新打开克隆窗口后可输入用户名和密码。";
      default:
        return "下一步：核对远程地址、父目录和目录名后重试；失败不会覆盖已有文件。";
    }
  }

  async function startClone() {
    const url = cloneUrl.trim();
    if (!url || !cloneParent) {
      onNotice("请填写远程地址，并选择一个已存在的父目录。");
      return;
    }
    cloneError = null;
    const credential: HttpCredential | null = authActive
      ? { username: authUser.trim(), password: authPassword, remember: authRemember }
      : null;
    const result = await runClone(async () => {
      try {
        return await api.cloneRepository(url, cloneParent, cloneName.trim(), nextId(), credential);
      } catch (error) {
        const failure = normalizeError(error);
        // 窗口还开着、是 HTTP(S) 地址：不弹通知，就地引导输入凭据；收起窗口后照常走失败通知。
        if (failure.code === "auth" && isHttpUrl(url) && mode === "clone") {
          authPrompt = {
            url,
            retried: credential !== null,
            message: credential
              ? failure.message
              : "这个地址需要登录。输入用户名和密码（或访问令牌）后重新克隆。",
          };
          authPassword = "";
          return undefined;
        }
        // 窗口还开着：原因和下一步就留在当前入口，不额外弹一条容易错过的通知。
        if (mode === "clone") {
          cloneError = { code: failure.code, message: failure.message };
          return undefined;
        }
        // 收到后台继续：通知是唯一还能看到的入口，把下一步一并带上。
        throw { ...failure, message: `${failure.message} ${cloneNextStep(failure.code)}` };
      }
    });
    if (!result) return;
    cloneError = null;
    authPrompt = null;
    authPassword = "";
    // 打开还是只通知由外壳决定：看用户是否已经收起窗口。
    await onOpened(result.opened);
    if (result.credentialNote) onNotice(result.credentialNote);
    // 收起后再次打开的可能是别的对话框，只关自己。
    if (mode === "clone") onClose();
  }

  /** 过期时用后端给的 generation 重读一次；成功后由 onSnapshot 让外壳跟上，再过期就按失败处理。 */
  async function readRemotes(path: string, generation: number) {
    try {
      return await api.remoteState(path, generation, nextId());
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      return api.remoteState(path, failure.generation, nextId());
    }
  }

  async function loadRemotes() {
    const current = opened;
    if (!current) return;
    const key = current.summary.path;
    const settle = (ok: boolean) => {
      if (mode === "remote") loaded = { key, ok };
    };
    const read = async () => {
      try {
        const state = await readRemotes(key, current.generation);
        settle(true);
        return state;
      } catch (error) {
        settle(false);
        throw error;
      }
    };
    const result = await (cloning ? readWhileCloning(read) : run("remote", read));
    if (!result || opened?.summary.path !== key) return;
    remotes = result.remotes;
    onRemotes?.(key, result.remotes.map((remote) => remote.name));
    onSnapshot(result.snapshot);
    if (!remoteName && result.remotes[0]) remoteName = result.remotes[0].name;
  }

  /** 重试会把按钮换成加载态：先把焦点放到常驻输入框，否则焦点掉到 body，Esc 就到不了 Modal。 */
  function retryLoad() {
    remoteNameInput?.focus();
    loaded = null;
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
    const result = await runRemoteWrite(() =>
      exists
        ? api.setRemoteUrl(current.summary.path, name, url, current.generation, nextId())
        : api.addRemote(current.summary.path, name, url, current.generation, nextId()),
    );
    if (!result) return;
    remotes = result.remotes;
    onRemotes?.(current.summary.path, result.remotes.map((remote) => remote.name));
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
          oninput={() => (cloneError = null)}
          placeholder="https://…、git@… 或本机绝对路径"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="form-group">
        <label class="label" for="clone-parent">父目录</label>
        <div class="row" style="flex-wrap: nowrap">
          <input id="clone-parent" class="input" readonly value={cloneParent} placeholder="选择一个已存在的目录" />
          <button type="button" class="btn btn-secondary" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={chooseParent}>
            <Icon name="folder-open" size={14} />选择目录
          </button>
        </div>
      </div>
      <div class="form-group">
        <label class="label" for="clone-name">目录名</label>
        <input id="clone-name" class="input" bind:value={cloneName} oninput={() => (cloneError = null)} placeholder="可留空，从地址推断" autocomplete="off" spellcheck="false" />
      </div>
      {#if authActive && authPrompt}
        <div class="clone-auth" data-clone-auth>
          <div class={`callout ${authPrompt.retried ? "error" : "warn"}`} role="alert">
            <Icon name="user" size={15} />
            <span>{authPrompt.message}</span>
          </div>
          <div class="form-group">
            <label class="label" for="clone-user">用户名</label>
            <!-- svelte-ignore a11y_autofocus -->
            <input id="clone-user" class="input" bind:value={authUser} autocomplete="username" spellcheck="false" autofocus={!authUser} />
          </div>
          <div class="form-group">
            <label class="label" for="clone-password">密码或访问令牌</label>
            <!-- svelte-ignore a11y_autofocus -->
            <input
              id="clone-password"
              class="input"
              type="password"
              bind:value={authPassword}
              autocomplete="current-password"
              autofocus={Boolean(authUser)}
              onkeydown={(event) => {
                if (event.key === "Enter" && !event.isComposing && !blocked && !authMissing && cloneParent) {
                  event.preventDefault();
                  void startClone();
                }
              }}
            />
          </div>
          <label class="confirm-option">
            <input type="checkbox" class="checkbox" bind:checked={authRemember} title={blocked ? BUSY_REASON : undefined} disabled={blocked} />
            <span>克隆成功后保存到系统凭据助手<small>之后拉取、推送不再询问；没有配置凭据助手时不会保存，并会提示</small></span>
          </label>
          <p class="hint">凭据只作为这次克隆的认证头发给该主机，不写进地址、Git 配置或 Twiglane 的数据。启用了双重验证的平台请使用访问令牌。</p>
        </div>
      {:else}
        <div class="callout info">
          <Icon name="info" size={15} />
          <span>HTTP(S) 地址需要登录时会在这里提示输入用户名和密码；SSH 地址使用 SSH agent。不要把令牌写进地址。</span>
        </div>
      {/if}
      {#if cloneError}
        <div class="callout error" role="alert" data-clone-error>
          <Icon name="alert-circle" size={15} />
          <div class="callout-body">
            <span>{cloneError.message}</span>
            <small data-clone-next>{cloneNextStep(cloneError.code)}</small>
          </div>
        </div>
      {/if}
      {#if cloning}
        <p class="hint" role="status" data-clone-running>克隆无法中途取消。留在这里，完成后自动打开仓库；点“在后台继续”后不会打断手上的工作，完成时只通知，可从仓库弹层打开。失败时通知里说明原因。</p>
      {/if}
    </div>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>{cloning ? "在后台继续" : "取消"}</button>
      <button type="button" class="btn btn-primary" title={blocked ? BUSY_REASON : !cloneUrl.trim() ? "先填写远程地址" : !cloneParent ? "先选择父目录" : authMissing ? "先填写用户名和密码" : undefined} disabled={blocked || !cloneUrl.trim() || !cloneParent || authMissing} onclick={startClone}>
        {#if cloning}<span class="spinner"></span>{:else}<Icon name="download" size={14} />{/if}
        {authActive ? "登录并克隆" : "开始克隆"}
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
    locked={remoteWriting}
    {onClose}
  >
    <div class="list-box">
      {#if remotesFailed}
        <div class="list-empty">
          没有读到远程配置。
          <button type="button" class="btn btn-secondary btn-sm" title={blocked && !cloning ? BUSY_REASON : undefined} disabled={blocked && !cloning} onclick={retryLoad}>重试</button>
        </div>
      {:else if !remotesReady}
        <div class="list-empty" data-remote-loading><span class="spinner"></span> 正在读取远程</div>
      {:else if remotes.length === 0}
        <div class="list-empty">还没有远程。在下面添加一个。</div>
      {:else}
        {@const upstreamRemote = opened?.snapshot.branch.upstream?.split("/")[0] ?? null}
        {@const branchName = opened?.snapshot.branch.detached ? null : (opened?.snapshot.branch.name ?? null)}
        {#each remotes as remote (remote.name)}
          <div class="list-row remote-row" class:editing={remote.name === remoteName.trim()}>
            <Icon name="cloud" />
            <div class="lr-main">
              <span class="lr-title">
                <span>{remote.name}</span>
                {#if remote.name === upstreamRemote}<span class="chip current" title={`当前分支跟踪 ${opened?.snapshot.branch.upstream}，「推送」默认推到这里`}>当前上游</span>{/if}
              </span>
              <span class="lr-sub mono" title={remote.fetchUrl}>{remote.fetchUrl}</span>
              {#if remote.pushUrl}
                <span class="lr-sub mono" title={remote.pushUrl}>推送地址 {remote.pushUrl}</span>
              {/if}
            </div>
            {#if onPushTo && branchName && remotes.length > 1 && remote.name !== upstreamRemote}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                title={blocked ? BUSY_REASON : `把 ${branchName} 推送到 ${remote.name}/${branchName}，不改变上游，不强推`}
                disabled={blocked}
                onclick={() => onPushTo?.(remote.name)}
              ><Icon name="arrow-up" size={13} />推送到此远程</button>
            {/if}
            <button type="button" class="btn btn-ghost btn-sm" title={blocked ? BUSY_REASON : `修改 ${remote.name} 的地址`} disabled={blocked} onclick={() => editRemote(remote)}>
              <Icon name="pencil" size={13} />修改
            </button>
          </div>
        {/each}
      {/if}
    </div>
    <div class="row" style="flex-wrap: nowrap; align-items: flex-end">
      <div class="form-group" style="width: 160px; flex: none">
        <label class="label" for="remote-name">名称</label>
        <input id="remote-name" class="input" bind:this={remoteNameInput} bind:value={remoteName} autocomplete="off" spellcheck="false" />
      </div>
      <div class="form-group" style="flex: 1">
        <label class="label" for="remote-url">地址</label>
        <input id="remote-url" class="input code" bind:value={remoteUrl} placeholder="不包含令牌的 HTTPS、SSH 或本机路径" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <p class="hint">名称已存在时会更新地址，否则新增远程。</p>
    {#snippet footer()}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" title={remoteWriting ? BUSY_REASON : undefined} disabled={remoteWriting} onclick={onClose}>关闭</button>
      <button type="button" class="btn btn-primary" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={saveRemote}>
        <Icon name="check" size={14} />保存远程
      </button>
    {/snippet}
  </Modal>
{:else if mode === "branch" && opened}
  <BranchDialog {opened} {disabled} {branchGroups} {onClose} {onBusy} {onSnapshot} {onFailure} {onNotice} {onOpenHistory} onOpened={onOpenWorktree} beforeOpen={beforeOpenWorktree} {nextId} />
{/if}
