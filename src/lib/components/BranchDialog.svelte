<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { tick, untrack } from "svelte";
  import { api } from "../api";
  import { filterBranches } from "../branches";
  import { normalizeError } from "../errors";
  import type { BranchRecord, BranchState, OpenedRepository, StatusSnapshot } from "../types";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest, isContextKey, pointFor } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import TagManager from "./TagManager.svelte";

  type BranchTab = "local" | "remote" | "tags";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    onClose: () => void;
    onBusy: (name: string | null) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenHistory?: (query: string) => void;
    /** 把某个分支合并到当前分支：关闭本 modal，打开分支合并并预选来源。 */
    onMergeBranch?: (name: string) => void;
    /** 把当前分支合并到某个本地分支：打开分支合并并预选目标。 */
    onMergeInto?: (name: string) => void;
    /** 打开意图：入口本身就是「新建分支」时，打开即展开表单并聚焦名称，不必再点一次。 */
    startCreating?: boolean;
    nextId: () => number;
  }

  let {
    opened,
    disabled,
    onClose,
    onBusy,
    onSnapshot,
    onFailure,
    onNotice,
    onOpenHistory,
    onMergeBranch,
    onMergeInto,
    startCreating = false,
    nextId,
  }: Props = $props();

  let branches = $state<BranchRecord[]>([]);
  let branchQuery = $state("");
  /** 新建表单按需展开，展开时替换搜索和列表（R10：不和列表同时铺开）。 */
  let creating = $state(untrack(() => startCreating));
  let branchName = $state("");
  /** 新分支的起点：空串表示当前分支（或游离 HEAD 的当前提交）。 */
  let createBase = $state("");
  let createCheckout = $state(true);
  let renaming = $state<{ name: string; value: string } | null>(null);
  let menu = $state<ContextMenuRequest | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let createToggle = $state<HTMLButtonElement | null>(null);
  let listBox = $state<HTMLDivElement | null>(null);
  let confirmBox = $state<HTMLDivElement | null>(null);
  let confirmCancel = $state<HTMLButtonElement | null>(null);
  let renameInput = $state<HTMLInputElement | null>(null);
  /** 写入在途：取消按钮禁用、Esc 不收起，结果未定时不能让界面看起来已经放弃。 */
  let writing = $state(false);
  /** 标签分区的写入在途：结果未定时同样不能切走或关闭。 */
  let tagWriting = $state(false);
  /** 确认区打开前的焦点和列表滚动位置，收起时原样还回去。 */
  let promptOrigin: { focus: HTMLElement | null; scrollTop: number } | null = null;
  let tab = $state<BranchTab>("local");
  let localBusy = $state(false);
  let errorText = $state<string | null>(null);
  /**
   * 最近一次失败的 code。删除本地分支后是否给出「强删」引导必须看它：
   * 只有 Git 明确回报 branch_unmerged 才说明是「未合入」，
   * 认证、网络、权限等失败不能把用户带向更危险的动作。
   */
  let lastFailureCode = $state<string | null>(null);
  /**
   * 列表读取的结果：只有真正读完才写入，写锁期间跳过的那次不算。
   * ok 为假时不再自动重读（失败也会释放锁，否则会循环），由「重试」清空。
   * generation 过期不算失败：readBranches 内部跟上后重读一次，只有重读也失败才记 ok 为假。
   */
  let loaded = $state<{ key: string; ok: boolean } | null>(null);
  let confirmDelete = $state<
    | { kind: "local"; name: string; body: string; force: boolean }
    | { kind: "remote"; remote: string; name: string; body: string; force: false }
    | null
  >(null);

  const TABS: { id: BranchTab; label: string; icon: "branch" | "cloud" | "tag" }[] = [
    { id: "local", label: "本地分支", icon: "branch" },
    { id: "remote", label: "远程分支", icon: "cloud" },
    { id: "tags", label: "标签", icon: "tag" },
  ];

  let blocked = $derived(disabled || localBusy);
  let writeInFlight = $derived(writing || tagWriting);
  let deleteLabel = $derived(
    confirmDelete?.kind === "remote"
      ? `远程分支 ${confirmDelete.remote}/${confirmDelete.name}`
      : `本地分支 ${confirmDelete?.name ?? ""}`,
  );
  /** 确认区和重命名区替换搜索与列表，不用算高度，也不必滚动就能看全说明和按钮。 */
  let prompting = $derived(confirmDelete !== null || renaming !== null);
  let localCount = $derived(branches.filter((branch) => !branch.remote).length);
  let remoteCount = $derived(branches.filter((branch) => branch.remote).length);
  let listScope = $derived(tab === "remote" ? "remote" : "local");
  let visibleBranches = $derived(
    filterBranches(
      branches.filter((branch) => (listScope === "local" ? !branch.remote : branch.remote)),
      branchQuery,
    ),
  );
  let current = $derived(opened.snapshot.branch);
  let listReady = $derived(loaded?.key === opened.summary.path && loaded.ok);
  let listFailed = $derived(loaded?.key === opened.summary.path && !loaded.ok);

  $effect(() => {
    if (loaded?.key === opened.summary.path || blocked) return;
    confirmDelete = null;
    void loadBranches();
  });

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    localBusy = true;
    errorText = null;
    lastFailureCode = null;
    onBusy("branch");
    try {
      return await action();
    } catch (error) {
      const failure = normalizeError(error);
      lastFailureCode = failure.code;
      errorText = failure.message;
      onFailure(failure);
      return undefined;
    } finally {
      localBusy = false;
      onBusy(null);
    }
  }

  /** 被拦下的重复动作不能碰 writing：它属于正在途中的那次写入，复位会让取消重新可用。 */
  async function write<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    writing = true;
    try {
      return await run(action);
    } finally {
      writing = false;
    }
  }

  function rememberOrigin() {
    promptOrigin = {
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      scrollTop: listBox?.scrollTop ?? 0,
    };
  }

  /** 列表显示回来后还原滚动，焦点回到触发按钮；它已不存在（行被删、被改名）时落在搜索框。 */
  async function restoreOrigin() {
    const origin = promptOrigin;
    promptOrigin = null;
    await tick();
    if (listBox && origin) listBox.scrollTop = origin.scrollTop;
    const target = origin?.focus;
    if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true });
    else searchInput?.focus();
  }

  function cancelPrompt() {
    if (writing) return;
    confirmDelete = null;
    renaming = null;
    void restoreOrigin();
  }

  function onPromptKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelPrompt();
  }

  function applyBranches(result: BranchState) {
    branches = result.branches;
    onSnapshot(result.snapshot);
  }

  /** 过期时用后端给的 generation 重读一次；成功后由 onSnapshot 让外壳跟上，再过期就按失败处理。 */
  async function readBranches(path: string): Promise<BranchState> {
    try {
      return await api.branchState(path, opened.generation, nextId());
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      return api.branchState(path, failure.generation, nextId());
    }
  }

  async function loadBranches() {
    const path = opened.summary.path;
    const result = await run(async () => {
      try {
        const state = await readBranches(path);
        loaded = { key: path, ok: true };
        return state;
      } catch (error) {
        loaded = { key: path, ok: false };
        throw error;
      }
    });
    if (!result || opened.summary.path !== path) return;
    applyBranches(result);
  }

  /** 重试会把按钮换成加载态：先把焦点放到常驻的搜索框，否则焦点掉到 body，Esc 就到不了 Modal。 */
  function retryLoad() {
    searchInput?.focus();
    loaded = null;
  }

  /** 起点的实际值：选了分支就用分支名；默认用当前分支，游离 HEAD 时用当前提交。 */
  function startPoint(): string {
    return createBase || current.name || current.headOid || "HEAD";
  }

  async function createNamedBranch() {
    const currentRepo = opened;
    const name = branchName.trim();
    if (!name) return;
    const start = startPoint();
    const checkout = createCheckout;
    // 提交按钮在途时会被禁用，先把焦点放回一直可用的名称框。
    nameInput?.focus();
    const result = await write(() =>
      api.createBranchFrom(currentRepo.summary.path, name, start, checkout, currentRepo.generation, nextId()),
    );
    if (opened.summary.path !== currentRepo.summary.path) return;
    // 失败时表单和焦点都留着，让用户直接改名重试。
    if (!result) return;
    applyBranches(result);
    void closeCreate();
    if (checkout) {
      onNotice(`已从 ${start} 创建并切换到 ${name}。`);
      onClose();
    } else {
      onNotice(`已从 ${start} 创建分支 ${name}，当前分支没有切换。`);
    }
  }

  /** 新分支总是本地分支：在远程分区点新建也落到本地分区，高亮和内容一致。 */
  async function openCreate(base = "") {
    tab = "local";
    creating = true;
    createBase = base;
    await tick();
    nameInput?.focus();
  }

  function resetCreate() {
    creating = false;
    branchName = "";
    createBase = "";
  }

  /** 创建或取消后收起并清空；表单节点随之消失，焦点交还给「新建分支」按钮。 */
  async function closeCreate() {
    resetCreate();
    await tick();
    createToggle?.focus();
  }

  function createFrom(branch: BranchRecord) {
    menu = null;
    // 起点下拉不列当前分支本身，它由空值代表。
    void openCreate(branch.current ? "" : branch.name);
  }

  async function askRename(branch: BranchRecord) {
    rememberOrigin();
    renaming = { name: branch.name, value: branch.name };
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  async function confirmRename() {
    const target = renaming;
    const currentRepo = opened;
    if (!target || blocked) return;
    const next = target.value.trim();
    if (!next || next === target.name) {
      cancelPrompt();
      return;
    }
    const result = await write(() =>
      api.renameBranch(currentRepo.summary.path, target.name, next, currentRepo.generation, nextId()),
    );
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    renaming = null;
    void restoreOrigin();
    applyBranches(result);
    onNotice(`已把分支 ${target.name} 重命名为 ${next}。远程上的同名分支不受影响。`);
  }

  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      onNotice(`已复制分支名 ${name}`);
    } catch {
      onFailure({ code: "clipboard", message: "无法写入剪贴板，请手动复制分支名。" });
    }
  }

  /** 分支行的操作菜单：右键、菜单键或行尾的「⋯」都打开这一份。 */
  function branchMenu(branch: BranchRecord, point: { x: number; y: number }) {
    const busy = blocked ? "正在读取或写入，稍后再试" : undefined;
    const currentReason = branch.current ? "这就是当前分支" : undefined;
    const elsewhere = branch.worktree && !branch.current ? `正被其他工作区使用：${branch.worktree}` : undefined;
    const entries: ContextMenuEntry[] = [
      {
        id: "switch",
        label: branch.remote ? "检出为本地分支并切换" : "切换到此分支",
        icon: "check-circle",
        disabledReason: currentReason ?? elsewhere ?? busy,
        run: () => void switchTo(branch.name),
      },
      {
        id: "create",
        label: "从此分支新建分支…",
        icon: "plus",
        disabledReason: busy,
        run: () => createFrom(branch),
      },
    ];
    if (onMergeBranch) {
      entries.push({
        id: "merge",
        label: `合并到当前分支（${current.name ?? "HEAD"}）…`,
        icon: "merge",
        disabledReason: currentReason ?? busy,
        run: () => onMergeBranch?.(branch.name),
      });
    }
    if (onMergeInto && !branch.remote && current.name) {
      entries.push({
        id: "merge-into",
        label: `把 ${current.name} 合并到此分支…`,
        icon: "merge",
        disabledReason: currentReason ?? elsewhere ?? busy,
        run: () => onMergeInto?.(branch.name),
      });
    }
    entries.push({ separator: true });
    if (!branch.remote) {
      entries.push({ id: "rename", label: "重命名…", icon: "pencil", disabledReason: elsewhere ?? busy, run: () => void askRename(branch) });
    }
    entries.push({ id: "copy", label: "复制分支名", icon: "copy", run: () => void copyName(branch.name) });
    entries.push({ separator: true });
    entries.push({
      id: "delete",
      label: branch.remote ? "从远程删除…" : "删除…",
      icon: "trash",
      danger: true,
      disabledReason: branch.current ? "不能删除当前分支，先切换到其他分支" : (elsewhere ?? busy),
      run: () => void askDelete(branch),
    });
    menu = { x: point.x, y: point.y, entries, label: `${branch.name} 的操作` };
  }

  async function switchTo(name: string) {
    const currentRepo = opened;
    const result = await write(() => api.switchBranch(currentRepo.summary.path, name, currentRepo.generation, nextId()));
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    applyBranches(result);
    onNotice(`已切换到 ${result.snapshot.branch.name ?? name}`);
    onClose();
  }

  async function askDelete(branch: BranchRecord) {
    let prompt: typeof confirmDelete;
    if (branch.remote) {
      const slash = branch.name.indexOf("/");
      if (slash <= 0) return;
      prompt = {
        kind: "remote",
        remote: branch.name.slice(0, slash),
        name: branch.name.slice(slash + 1),
        body: `将从远程删除 ${branch.name}。这不会强行推送，但远程上的该分支会被移除。取消则不会执行。`,
        force: false,
      };
    } else {
      prompt = {
        kind: "local",
        name: branch.name,
        body: "将删除这个本地分支。如果它还有未合入当前分支的提交，需要再次确认。取消则不会执行。",
        force: false,
      };
    }
    rememberOrigin();
    confirmDelete = prompt;
    await tick();
    // 默认落在安全的取消上，破坏性操作必须多走一步。
    confirmCancel?.focus();
  }

  async function confirmRemoval() {
    const currentRepo = opened;
    const target = confirmDelete;
    if (!target || blocked) return;
    // 确认按钮在途时会被禁用，先把焦点放到确认区容器，Esc 才还到得了键盘处理。
    confirmBox?.focus();
    const result = await write(() =>
      target.kind === "remote"
        ? api.deleteRemoteBranch(currentRepo.summary.path, target.remote, target.name, true, currentRepo.generation, nextId())
        : api.deleteBranch(currentRepo.summary.path, target.name, target.force, currentRepo.generation, nextId()),
    );
    // 只有「未合入」这一种失败才升级为强删确认；其它失败按普通错误处理并收起确认层。
    if (!result && target.kind === "local" && !target.force && lastFailureCode === "branch_unmerged") {
      confirmDelete = {
        kind: "local",
        name: target.name,
        body: "该分支含有尚未合入当前分支的提交。确认后才会删除，删除后这些提交不能由这里自动恢复。",
        force: true,
      };
      await tick();
      confirmCancel?.focus();
      return;
    }
    confirmDelete = null;
    void restoreOrigin();
    if (!result) return;
    applyBranches(result);
    onNotice(target.kind === "remote" ? `已删除远程分支 ${target.remote}/${target.name}` : `已删除本地分支 ${target.name}`);
  }

  /** 切分区统一放弃当前的表单和确认区，切回时不残留；写入在途时结果未定，先不让切。 */
  function selectTab(next: BranchTab) {
    if (next === tab || writeInFlight) return;
    resetCreate();
    confirmDelete = null;
    renaming = null;
    promptOrigin = null;
    tab = next;
  }

  /** 行内按钮的 Enter/空格只属于按钮本身，不能冒泡成切换分支；Esc 等其它键照常上浮到 Modal。 */
  function keepRowKeys(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }

  function focusTab(key: string) {
    const order = TABS.map((entry) => entry.id);
    const index = order.indexOf(tab);
    const next = key === "ArrowRight" ? (index + 1) % order.length : (index - 1 + order.length) % order.length;
    selectTab(order[next]);
    document.getElementById(`branch-tab-${tab}`)?.focus();
  }
</script>

<Modal
  title="分支与标签"
  titleId="repo-dialog-title"
  icon="branch"
  size="xl"
  task="branch"
  locked={writeInFlight}
  {onClose}
>
  <div class="branch-status" data-branch-status>
    <Icon name="branch" size={13} />
    <span>当前分支</span>
    <strong title={current.name ?? "游离 HEAD"}>{current.name ?? "游离 HEAD"}</strong>
    <span class="branch-status-upstream" title={current.upstream ?? undefined}>{current.upstream ? `跟踪 ${current.upstream}` : "尚未关联上游分支"}</span>
    {#if current.upstream}
      <span class="branch-status-sync" title={`待推送 ${current.ahead ?? 0} 个提交`}><Icon name="arrow-up" size={12} />{current.ahead ?? 0}</span>
      <span class="branch-status-sync" title={`待拉取 ${current.behind ?? 0} 个提交`}><Icon name="arrow-down" size={12} />{current.behind ?? 0}</span>
    {/if}
  </div>

  <div class="segmented" role="tablist" aria-label="分支与标签分区">
    {#each TABS as entry (entry.id)}
      <button
        type="button"
        role="tab"
        id={`branch-tab-${entry.id}`}
        aria-selected={tab === entry.id}
        aria-disabled={writeInFlight && tab !== entry.id ? "true" : undefined}
        title={writeInFlight && tab !== entry.id ? "写入完成后才能切换分区" : undefined}
        aria-controls="branch-tab-panel"
        tabindex={tab === entry.id ? 0 : -1}
        onclick={() => selectTab(entry.id)}
        onkeydown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          focusTab(event.key);
        }}
      >
        <Icon name={entry.icon} size={12} />{entry.label}
        {#if entry.id === "local" && listReady}<span class="count">{localCount}</span>{/if}
        {#if entry.id === "remote" && listReady}<span class="count">{remoteCount}</span>{/if}
      </button>
    {/each}
  </div>

  <div id="branch-tab-panel" class="branch-panel" role="tabpanel" aria-labelledby={`branch-tab-${tab}`} data-branch-panel={tab}>
    {#if tab === "tags"}
      <TagManager
        bind:writing={tagWriting}
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
    {:else if creating}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <form
        id="branch-create-form"
        class="branch-create"
        data-branch-create
        onsubmit={(event) => {
          event.preventDefault();
          void createNamedBranch();
        }}
        onkeydown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (!writing) void closeCreate();
        }}
      >
        <label class="label" for="branch-name">新建分支</label>
        <!-- 不随 blocked 禁用：打开时列表正在读取，禁用会把刚给的焦点弄丢；提交本身由 run 拦住。 -->
        <input
          id="branch-name"
          class="input"
          data-autofocus
          readonly={writing}
          bind:this={nameInput}
          bind:value={branchName}
          placeholder="例如 feature/login"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="branch-create-options">
          <label class="branch-base">
            <span>起点</span>
            <select class="select" aria-label="新分支的起点" bind:value={createBase} title={blocked ? BUSY_REASON : undefined} disabled={blocked}>
              <option value="">当前分支（{current.name ?? "游离 HEAD"}）</option>
              {#each branches.filter((branch) => !branch.current) as branch (branch.name)}
                <option value={branch.name}>{branch.remote ? `远程 ${branch.name}` : branch.name}</option>
              {/each}
            </select>
          </label>
          <label class="switch branch-checkout">
            <input type="checkbox" bind:checked={createCheckout} title={blocked ? BUSY_REASON : undefined} disabled={blocked} />
            <span>创建后切换过去</span>
          </label>
        </div>
        <p class="hint">{createCheckout ? "切换沿用分支切换的保护：会覆盖未提交修改时停下，工作区保持原样。" : "只创建分支，当前分支和工作区都不变。"}</p>
        <div class="create-form-actions">
          <button type="button" class="btn btn-secondary" title={writing ? BUSY_REASON : undefined} disabled={writing} onclick={closeCreate}>取消</button>
          <button type="submit" class="btn btn-primary" title={blocked ? BUSY_REASON : branchName.trim().length === 0 ? "先填写分支名称" : undefined} disabled={blocked || branchName.trim().length === 0}>
            <Icon name="plus" size={14} />{createCheckout ? "创建并切换" : "创建分支"}
          </button>
        </div>
      </form>
    {:else}
      <div class="branch-manager-tools" hidden={prompting}>
        <div class="field branch-search">
          <Icon name="search" size={14} />
          <label class="sr-only" for="branch-search">搜索分支</label>
          <input
            id="branch-search"
            data-autofocus
            bind:this={searchInput}
            bind:value={branchQuery}
            placeholder={`搜索${listScope === "local" ? "本地" : "远程"}分支`}
            autocomplete="off"
            spellcheck="false"
          />
          {#if branchQuery}
            <button type="button" class="field-clear" aria-label="清空分支搜索" onclick={() => (branchQuery = "")}><Icon name="x" size={12} /></button>
          {/if}
        </div>
        <button
          type="button"
          class="btn btn-secondary"
          aria-expanded="false"
          aria-controls="branch-create-form"
          bind:this={createToggle}
          onclick={() => openCreate()}
        >
          <Icon name="plus" size={14} />新建分支
        </button>
      </div>

      <div class="list-box branch-list" aria-label={listScope === "local" ? "本地分支" : "远程分支"} bind:this={listBox} hidden={prompting}>
        <div class="list-section">
          <span>{listScope === "local" ? "本地分支" : "远程分支"}</span>
          <span class="spacer"></span>
          {#if listReady}<span>{visibleBranches.length} 个结果</span>{/if}
        </div>
        {#if listFailed}
          <div class="empty compact branch-empty">
            <span class="empty-icon"><Icon name="alert-circle" size={20} /></span>
            <strong>没有读到分支列表</strong>
            <button type="button" class="btn btn-secondary btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={retryLoad}>重试</button>
          </div>
        {:else if !listReady}
          <div class="empty compact branch-empty" data-branch-loading>
            <span class="empty-icon"><span class="spinner"></span></span>
            <strong>正在读取分支</strong>
          </div>
        {:else if visibleBranches.length === 0}
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
              tabindex="0"
              aria-label={branch.current ? `当前分支 ${branch.name}` : `切换到 ${branch.name}`}
              aria-disabled={branch.current || blocked}
              title={branch.current ? "当前正在使用的分支" : `点击切换到 ${branch.name}`}
              onclick={() => {
                if (!branch.current) void switchTo(branch.name);
              }}
              oncontextmenu={(event) => {
                event.preventDefault();
                branchMenu(branch, { x: event.clientX, y: event.clientY });
              }}
              onkeydown={(event) => {
                if (isContextKey(event)) {
                  event.preventDefault();
                  branchMenu(branch, pointFor(event.currentTarget));
                  return;
                }
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
              <span class="lr-actions">
                <button
                  type="button"
                  class="icon-btn sm"
                  aria-label={`${branch.name} 的更多操作`}
                  aria-haspopup="menu"
                  title="更多操作：新建、合并、重命名、复制、删除"
                  onclick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    branchMenu(branch, { x: rect.right - 232, y: rect.bottom + 4 });
                  }}
                  onkeydown={keepRowKeys}
                >
                  <Icon name="more" size={14} />
                </button>
                {#if !branch.current}
                  <button
                    type="button"
                    class="icon-btn sm danger"
                    aria-label={branch.remote ? `删除远程 ${branch.name}` : `删除 ${branch.name}`}
                    title={branch.remote ? "删除远程分支" : "删除本地分支"}
                    disabled={blocked}
                    onclick={(event) => {
                      event.stopPropagation();
                      void askDelete(branch);
                    }}
                    onkeydown={keepRowKeys}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                {/if}
              </span>
            </div>
          {/each}
        {/if}
      </div>

      {#if renaming}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="callout branch-rename" data-branch-rename onkeydown={onPromptKey}>
          <Icon name="pencil" size={15} />
          <div class="callout-body">
            <label class="label" for="branch-rename">重命名本地分支 {renaming.name}</label>
            <div class="row">
              <input
                id="branch-rename"
                class="input"
                bind:this={renameInput}
                bind:value={renaming.value}
                autocomplete="off"
                spellcheck="false"
                readonly={writing}
                onkeydown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void confirmRename();
                  }
                }}
              />
              <button type="button" class="btn btn-secondary btn-sm" title={writing ? BUSY_REASON : undefined} disabled={writing} onclick={cancelPrompt}>取消</button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                title={blocked ? BUSY_REASON : renaming.value.trim().length === 0 || renaming.value.trim() === renaming.name ? "先填写新的分支名称" : undefined}
                disabled={blocked || renaming.value.trim().length === 0 || renaming.value.trim() === renaming.name}
                onclick={() => {
                  renameInput?.focus();
                  void confirmRename();
                }}
              >确认重命名</button>
            </div>
            <p class="hint">只改本地分支名；已关联的上游配置随之保留，远程上的同名分支不会改动。</p>
          </div>
        </div>
      {/if}

      {#if confirmDelete}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="callout warn" role="alert" tabindex="-1" data-modal-impact="branch-delete" bind:this={confirmBox} onkeydown={onPromptKey}>
          <Icon name="alert" size={15} />
          <div class="callout-body">
            <p>{confirmDelete.body}</p>
            <ul class="scope-list">
              <li title={deleteLabel}>{deleteLabel}</li>
            </ul>
            <div class="row">
              <button type="button" class="btn btn-secondary btn-sm" title={writing ? BUSY_REASON : undefined} disabled={writing} bind:this={confirmCancel} onclick={cancelPrompt}>取消</button>
              {#if confirmDelete.kind === "local" && confirmDelete.force}
                <button type="button" class="btn btn-danger btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={confirmRemoval}>确认删除未合入分支</button>
              {:else}
                <button type="button" class="btn btn-danger btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={confirmRemoval}>确认删除</button>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    {/if}
    {#if errorText}
      <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
    {/if}
  </div>
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}
  {#snippet footer()}
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" disabled={writeInFlight} title={writeInFlight ? "写入完成后才能关闭" : undefined} onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
