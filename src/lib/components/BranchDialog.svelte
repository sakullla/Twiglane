<script lang="ts">
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
    nextId,
  }: Props = $props();

  let branches = $state<BranchRecord[]>([]);
  let branchQuery = $state("");
  let branchName = $state("");
  /** 新分支的起点：空串表示当前分支（或游离 HEAD 的当前提交）。 */
  let createBase = $state("");
  let createCheckout = $state(true);
  let renaming = $state<{ name: string; value: string } | null>(null);
  let menu = $state<ContextMenuRequest | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let tab = $state<BranchTab>("local");
  let localBusy = $state(false);
  let errorText = $state<string | null>(null);
  /**
   * 最近一次失败的 code。删除本地分支后是否给出「强删」引导必须看它：
   * 只有 Git 明确回报 branch_unmerged 才说明是「未合入」，
   * 认证、网络、权限等失败不能把用户带向更危险的动作。
   */
  let lastFailureCode = $state<string | null>(null);
  let loadedKey = "";
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
    const result = await run(() =>
      api.createBranchFrom(currentRepo.summary.path, name, start, checkout, currentRepo.generation, nextId()),
    );
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    applyBranches(result);
    branchName = "";
    createBase = "";
    tab = "local";
    if (checkout) {
      onNotice(`已从 ${start} 创建并切换到 ${name}。`);
      onClose();
    } else {
      onNotice(`已从 ${start} 创建分支 ${name}，当前分支没有切换。`);
    }
  }

  function createFrom(name: string) {
    tab = "local";
    createBase = name;
    menu = null;
    void Promise.resolve().then(() => {
      nameInput?.focus();
      nameInput?.scrollIntoView?.({ block: "nearest" });
    });
  }

  function askRename(branch: BranchRecord) {
    renaming = { name: branch.name, value: branch.name };
    confirmDelete = null;
  }

  async function confirmRename() {
    const target = renaming;
    const currentRepo = opened;
    if (!target) return;
    const next = target.value.trim();
    if (!next || next === target.name) {
      renaming = null;
      return;
    }
    const result = await run(() =>
      api.renameBranch(currentRepo.summary.path, target.name, next, currentRepo.generation, nextId()),
    );
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    renaming = null;
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
        run: () => createFrom(branch.name),
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
    entries.push({ separator: true });
    if (!branch.remote) {
      entries.push({ id: "rename", label: "重命名…", icon: "pencil", disabledReason: elsewhere ?? busy, run: () => askRename(branch) });
    }
    entries.push({ id: "copy", label: "复制分支名", icon: "copy", run: () => void copyName(branch.name) });
    entries.push({ separator: true });
    entries.push({
      id: "delete",
      label: branch.remote ? "从远程删除…" : "删除…",
      icon: "trash",
      danger: true,
      disabledReason: branch.current ? "不能删除当前分支，先切换到其他分支" : (elsewhere ?? busy),
      run: () => askDelete(branch),
    });
    menu = { x: point.x, y: point.y, entries, label: `${branch.name} 的操作` };
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
        force: false,
      };
      return;
    }
    confirmDelete = {
      kind: "local",
      name: branch.name,
      body: "将删除这个本地分支。如果它还有未合入当前分支的提交，需要再次确认。取消则不会执行。",
      force: false,
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
      api.deleteBranch(currentRepo.summary.path, target.name, target.force, currentRepo.generation, nextId()),
    );
    if (result) {
      confirmDelete = null;
      applyBranches(result);
      onNotice(`已删除本地分支 ${target.name}`);
      return;
    }
    // 只有「未合入」这一种失败才升级为强删确认；其它失败按普通错误处理并收起确认层。
    if (!target.force && lastFailureCode === "branch_unmerged") {
      confirmDelete = {
        kind: "local",
        name: target.name,
        body: "该分支含有尚未合入当前分支的提交。确认后才会删除，删除后这些提交不能由这里自动恢复。",
        force: true,
      };
    } else {
      confirmDelete = null;
    }
  }

  function focusTab(key: string) {
    const order = TABS.map((entry) => entry.id);
    const index = order.indexOf(tab);
    const next = key === "ArrowRight" ? (index + 1) % order.length : (index - 1 + order.length) % order.length;
    tab = order[next];
    document.getElementById(`branch-tab-${order[next]}`)?.focus();
  }
</script>

<Modal
  title="分支与标签"
  titleId="repo-dialog-title"
  icon="branch"
  size="xl"
  task="branch"
  description="分支、标签在同一层切换。切换分支成功后自动关闭。"
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

  <div class="segmented" role="tablist" aria-label="分支与标签分区">
    {#each TABS as entry (entry.id)}
      <button
        type="button"
        role="tab"
        id={`branch-tab-${entry.id}`}
        aria-selected={tab === entry.id}
        aria-controls="branch-tab-panel"
        tabindex={tab === entry.id ? 0 : -1}
        onclick={() => (tab = entry.id)}
        onkeydown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          focusTab(event.key);
        }}
      >
        <Icon name={entry.icon} size={12} />{entry.label}
        {#if entry.id === "local"}<span class="count">{localCount}</span>{/if}
        {#if entry.id === "remote"}<span class="count">{remoteCount}</span>{/if}
      </button>
    {/each}
  </div>

  <div id="branch-tab-panel" role="tabpanel" aria-labelledby={`branch-tab-${tab}`} data-branch-panel={tab}>
    {#if tab === "tags"}
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
    {:else}
      <div class="branch-manager-tools">
        <div class="field branch-search">
          <Icon name="search" size={14} />
          <label class="sr-only" for="branch-search">搜索分支</label>
          <input
            id="branch-search"
            data-autofocus
            bind:value={branchQuery}
            placeholder={`搜索${listScope === "local" ? "本地" : "远程"}分支`}
            autocomplete="off"
            spellcheck="false"
          />
          {#if branchQuery}
            <button type="button" class="field-clear" aria-label="清空分支搜索" onclick={() => (branchQuery = "")}><Icon name="x" size={12} /></button>
          {/if}
        </div>
      </div>

      <div class="list-box branch-list" aria-label={listScope === "local" ? "本地分支" : "远程分支"}>
        <div class="list-section">
          <span>{listScope === "local" ? "本地分支" : "远程分支"}</span>
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
                  onkeydown={(event) => event.stopPropagation()}
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
                      askDelete(branch);
                    }}
                    onkeydown={(event) => event.stopPropagation()}
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
        <div class="callout branch-rename" data-branch-rename>
          <Icon name="pencil" size={15} />
          <div class="callout-body">
            <label class="label" for="branch-rename">重命名本地分支 {renaming.name}</label>
            <div class="row">
              <!-- svelte-ignore a11y_autofocus -->
              <input
                id="branch-rename"
                class="input"
                autofocus
                bind:value={renaming.value}
                autocomplete="off"
                spellcheck="false"
                disabled={blocked}
                onkeydown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void confirmRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    renaming = null;
                  }
                }}
              />
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => (renaming = null)}>取消</button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                disabled={blocked || renaming.value.trim().length === 0 || renaming.value.trim() === renaming.name}
                onclick={confirmRename}
              >确认重命名</button>
            </div>
            <p class="hint">只改本地分支名；已关联的上游配置随之保留，远程上的同名分支不会改动。</p>
          </div>
        </div>
      {/if}

      {#if confirmDelete}
        <div class="callout warn" role="alert" data-modal-impact="branch-delete">
          <Icon name="alert" size={15} />
          <div class="callout-body">
            <p>{confirmDelete.body}</p>
            <ul class="scope-list">
              <li>{confirmDelete.kind === "remote" ? `远程分支 ${confirmDelete.remote}/${confirmDelete.name}` : `本地分支 ${confirmDelete.name}`}</li>
            </ul>
            <div class="row">
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => (confirmDelete = null)}>取消</button>
              {#if confirmDelete.kind === "local" && confirmDelete.force}
                <button type="button" class="btn btn-danger btn-sm" disabled={blocked} onclick={confirmRemoval}>确认删除未合入分支</button>
              {:else}
                <button type="button" class="btn btn-danger btn-sm" disabled={blocked} onclick={confirmRemoval}>确认删除</button>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      <div class="branch-create">
        <span class="branch-create-icon"><Icon name="plus" size={17} /></span>
        <div class="branch-create-copy">
          <label class="label" for="branch-name">新建分支</label>
          <div class="row">
            <input
              id="branch-name"
              class="input"
              bind:this={nameInput}
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
              <Icon name="plus" size={14} />{createCheckout ? "创建并切换" : "创建分支"}
            </button>
          </div>
          <div class="branch-create-options">
            <label class="branch-base">
              <span>起点</span>
              <select class="select" aria-label="新分支的起点" bind:value={createBase} disabled={blocked}>
                <option value="">当前分支（{current.name ?? "游离 HEAD"}）</option>
                {#each branches.filter((branch) => !branch.current) as branch (branch.name)}
                  <option value={branch.name}>{branch.remote ? `远程 ${branch.name}` : branch.name}</option>
                {/each}
              </select>
            </label>
            <label class="switch branch-checkout">
              <input type="checkbox" bind:checked={createCheckout} disabled={blocked} />
              <span>创建后切换过去</span>
            </label>
          </div>
          <p class="hint">{createCheckout ? "切换沿用分支切换的保护：会覆盖未提交修改时停下，工作区保持原样。" : "只创建分支，当前分支和工作区都不变。"}</p>
        </div>
      </div>
    {/if}
    {#if errorText}
      <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
    {/if}
  </div>
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}
  {#snippet footer()}
    <span class="hint"><Icon name="check-circle" size={12} />{tab === "tags" ? "标签可直接定位到目标提交" : "切换成功后自动关闭"}</span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
