<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { tick, untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { formatAuthoredAt, shortOid } from "../history";
  import type { OpenedRepository, StatusSnapshot, TagRecord, TagState } from "../types";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    onBusy: (name: string | null) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenHistory: (query: string) => void;
    nextId: () => number;
    /** 写入在途：宿主据此不切分区、不关闭，结果未定时界面不能看起来已经放弃。 */
    writing?: boolean;
    /** 写锁来自后台克隆：它不碰当前仓库，读取照常，写入仍被拦住。 */
    backgroundClone?: boolean;
  }

  let {
    opened,
    disabled,
    onBusy,
    onSnapshot,
    onFailure,
    onNotice,
    onOpenHistory,
    nextId,
    writing = $bindable(false),
    backgroundClone = false,
  }: Props = $props();

  let tags = $state<TagRecord[]>([]);
  /** 新建表单按需展开，展开时替换搜索和列表。 */
  let creating = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let createToggle = $state<HTMLButtonElement | null>(null);
  let listBox = $state<HTMLDivElement | null>(null);
  /** 确认区打开前的焦点和列表滚动位置，收起时原样还回去。 */
  let promptOrigin: { focus: HTMLElement | null; scrollTop: number } | null = null;
  let query = $state("");
  let name = $state("");
  let target = $state("HEAD");
  let message = $state("");
  let localBusy = $state(false);
  let errorText = $state<string | null>(null);
  let confirmTag = $state<TagRecord | null>(null);
  let copied = $state<string | null>(null);
  /** 标签读取的结果：只有真正读完才写入，写锁期间跳过的那次不算；失败不自动重读。 */
  let loaded = $state<{ key: string; ok: boolean } | null>(null);
  /** 远程上的标签（名称到解引用后的 oid）；null 表示还不知道或读不到。 */
  let remoteTags = $state<Map<string, string> | null>(null);
  let remoteChecking = $state(false);
  let remoteError = $state<string | null>(null);
  let remoteToken = 0;
  /** 同一仓库同时只有一个 ls-remote。前一次还在途时过一会儿再问，它最多跑 20 秒。 */
  const REMOTE_BUSY_RETRY_MS = 800;

  let blocked = $derived(disabled || localBusy);
  let readBlocked = $derived(localBusy || (disabled && !backgroundClone));
  let remote = $derived(opened.snapshot.branch.upstream?.split("/")[0] || "origin");
  let remoteKey = $derived(`${opened.summary.path}\u0000${remote}`);
  let visible = $derived(
    tags.filter((tag) => {
      const needle = query.trim().toLowerCase();
      return !needle || tag.name.toLowerCase().includes(needle) || tag.targetOid.toLowerCase().startsWith(needle) || tag.message.toLowerCase().includes(needle);
    }),
  );

  $effect(() => {
    if (loaded?.key === `${opened.summary.path}:${opened.generation}` || readBlocked) return;
    void loadTags();
  });

  // ls-remote 走网络，只跟仓库和远程走：打开时一次、推送后一次、手动刷新，不随 generation 重跑。
  $effect(() => {
    void remoteKey;
    untrack(() => {
      remoteTags = null;
      remoteError = null;
      void loadRemoteTags();
    });
    return () => {
      remoteToken += 1;
    };
  });

  async function loadRemoteTags() {
    const key = remoteKey;
    const token = ++remoteToken;
    remoteChecking = true;
    try {
      const listed = await api.tagRemoteState(opened.summary.path, remote);
      if (token !== remoteToken || key !== remoteKey) return;
      remoteTags = new Map(listed.map((tag) => [tag.name, tag.oid]));
      remoteError = null;
      remoteChecking = false;
    } catch (error) {
      if (token !== remoteToken || key !== remoteKey) return;
      const failure = normalizeError(error);
      if (failure.code === "duplicate") {
        // 在途的那次可能早于刚完成的推送，或已被切换分区丢弃：不算失败，保持检查中。
        setTimeout(() => {
          if (token === remoteToken) void loadRemoteTags();
        }, REMOTE_BUSY_RETRY_MS);
        return;
      }
      remoteTags = null;
      remoteError = failure.message;
      remoteChecking = false;
    }
  }

  function remoteStatus(tag: TagRecord): { label: string; tone: string; title: string; canPush: boolean } {
    if (!remoteTags) {
      return remoteChecking
        ? { label: "正在检查远程", tone: "skip", title: `正在读取 ${remote} 上的标签`, canPush: true }
        : { label: "远程状态未知", tone: "ignore", title: remoteError ?? `无法确认 ${remote} 上的标签`, canPush: true };
    }
    const oid = remoteTags.get(tag.name);
    if (oid === undefined) return { label: "未推送", tone: "tag", title: `${remote} 上没有这个标签`, canPush: true };
    if (oid === tag.targetOid) return { label: "已推送", tone: "ok", title: `已在 ${remote} 上`, canPush: false };
    return {
      label: "远程不同",
      tone: "danger",
      title: `${remote} 上的同名标签指向 ${shortOid(oid)}，本地指向 ${shortOid(tag.targetOid)}。这里不提供覆盖，请先核对。`,
      canPush: false,
    };
  }

  /** 列表读取只占本组件的读取状态；只有实际写入才占宿主写锁。 */
  async function run<T>(action: () => Promise<T>, reading = false): Promise<T | undefined> {
    if (reading ? readBlocked : blocked) return undefined;
    const quiet = reading;
    localBusy = true;
    errorText = null;
    if (!quiet) onBusy("tag");
    try {
      return await action();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
      return undefined;
    } finally {
      localBusy = false;
      if (!quiet) onBusy(null);
    }
  }

  /** 被拦下的重复动作不能碰 writing：它属于正在途中的那次写入。 */
  async function write<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    writing = true;
    try {
      return await run(action);
    } finally {
      writing = false;
    }
  }

  function apply(result: TagState) {
    tags = result.tags;
    onSnapshot(result.snapshot);
  }

  async function loadTags() {
    const path = opened.summary.path;
    const key = `${path}:${opened.generation}`;
    const result = await run(async () => {
      try {
        const state = await api.tagState(path, opened.generation, nextId());
        loaded = { key, ok: true };
        return state;
      } catch (error) {
        loaded = { key, ok: false };
        throw error;
      }
    }, true);
    if (result && opened.summary.path === path) apply(result);
  }

  async function create() {
    const current = opened;
    const tagName = name.trim();
    const tagTarget = target.trim() || "HEAD";
    const annotated = message.trim().length > 0;
    if (!tagName || !target.trim()) return;
    // 提交按钮在途时会被禁用，先把焦点放回一直可用的名称框。
    nameInput?.focus();
    const result = await write(() => api.createTag(current.summary.path, tagName, tagTarget, message.trim(), current.generation, nextId()));
    if (opened.summary.path !== current.summary.path) return;
    // 失败时表单和焦点都留着，让用户直接修改后重试。
    if (!result) return;
    apply(result);
    void closeCreate();
    onNotice(`已创建标签 ${tagName}${annotated ? "（附注标签）" : ""}。`);
  }

  async function openCreate() {
    creating = true;
    await tick();
    nameInput?.focus();
  }

  /** 创建或取消后收起并清空；表单节点随之消失，焦点交还给「新建标签」按钮。 */
  async function closeCreate() {
    creating = false;
    name = "";
    target = "HEAD";
    message = "";
    await tick();
    createToggle?.focus();
  }

  /** 重试会把按钮换成加载态：先把焦点放到常驻的搜索框，否则焦点掉到 body，Esc 就到不了 Modal。 */
  function retryLoad() {
    searchInput?.focus();
    loaded = null;
  }

  async function push(tag: TagRecord) {
    const current = opened;
    const result = await write(() => api.pushTag(current.summary.path, remote, tag.name, current.generation, nextId()));
    if (!result || opened.summary.path !== current.summary.path) return;
    apply(result);
    onNotice(`标签 ${tag.name} 已推送到 ${remote}，没有强制覆盖。`);
    if (remoteTags) remoteTags = new Map(remoteTags).set(tag.name, tag.targetOid);
    void loadRemoteTags();
  }

  /** 删除确认用对话框：列表留在原处，关闭后焦点回到触发按钮。 */
  async function askRemove(tag: TagRecord) {
    promptOrigin = {
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      scrollTop: listBox?.scrollTop ?? 0,
    };
    // 确认框默认把焦点放在安全的「取消」上，破坏性操作必须多走一步。
    confirmTag = tag;
  }

  /** 列表显示回来后还原滚动，焦点回到触发按钮；它已不存在时落在搜索框。 */
  async function closeConfirm() {
    const origin = promptOrigin;
    promptOrigin = null;
    confirmTag = null;
    await tick();
    if (listBox && origin) listBox.scrollTop = origin.scrollTop;
    const target = origin?.focus;
    if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true });
    else searchInput?.focus();
  }

  async function remove() {
    const tag = confirmTag;
    if (!tag || blocked) return;
    const current = opened;
    const result = await write(() => api.deleteTag(current.summary.path, tag.name, true, current.generation, nextId()));
    if (opened.summary.path !== current.summary.path) return;
    if (result) apply(result);
    await closeConfirm();
    if (result) onNotice(`已删除本地标签 ${tag.name}，远程上的同名标签不受影响。`);
  }

  async function copyOid(oid: string) {
    try {
      await navigator.clipboard.writeText(oid);
      copied = oid;
      setTimeout(() => {
        if (copied === oid) copied = null;
      }, 1500);
    } catch {
      copied = null;
    }
  }
</script>

<div class="tag-manager">
  {#if creating}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form
      id="tag-create-form"
      class="tag-create"
      data-tag-create
      onsubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      onkeydown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!writing) void closeCreate();
      }}
    >
      <div class="tag-create-grid">
        <div class="form-group">
          <label class="label" for="tag-name">标签名称</label>
          <!-- 不随 blocked 禁用：禁用会把刚给的焦点弄丢；提交本身由 run 拦住。 -->
          <input id="tag-name" class="input" readonly={writing} bind:this={nameInput} bind:value={name} placeholder="例如 v1.0.0" autocomplete="off" spellcheck="false" />
        </div>
        <div class="form-group">
          <label class="label" for="tag-target">目标提交</label>
          <input id="tag-target" class="input code" bind:value={target} placeholder="HEAD 或提交 Hash" title={blocked ? BUSY_REASON : undefined} disabled={blocked} autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <input class="input" aria-label="标签附注" bind:value={message} placeholder="可选附注；填写后创建附注标签" title={blocked ? BUSY_REASON : undefined} disabled={blocked} />
      <p class="hint">标记当前提交，或输入另一个提交 Hash。</p>
      <div class="create-form-actions">
        <button type="button" class="btn btn-secondary" title={writing ? BUSY_REASON : undefined} disabled={writing} onclick={closeCreate}>取消</button>
        <button type="submit" class="btn btn-primary" title={blocked ? BUSY_REASON : !name.trim() || !target.trim() ? "先填写标签名称和目标提交" : undefined} disabled={blocked || !name.trim() || !target.trim()}><Icon name="plus" size={14} />创建标签</button>
      </div>
    </form>
  {:else}
    <div class="tag-list-tools">
      <div class="field"><Icon name="search" size={14} /><input aria-label="搜索标签" bind:this={searchInput} bind:value={query} placeholder="搜索标签、Hash 或附注" autocomplete="off" spellcheck="false" /></div>
      {#if loaded?.ok}<span class="count">{tags.length}</span>{/if}
      <!-- 检查中不禁用：禁用会把焦点弄丢，Esc 就到不了 Modal。 -->
      <button type="button" class="icon-btn" aria-label="刷新远程状态" aria-busy={remoteChecking} title={`重新读取 ${remote} 上的标签`} onclick={() => { if (!remoteChecking) void loadRemoteTags(); }}>
        {#if remoteChecking}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
      </button>
      <button type="button" class="btn btn-secondary" aria-expanded="false" aria-controls="tag-create-form" bind:this={createToggle} onclick={openCreate}><Icon name="plus" size={14} />新建标签</button>
    </div>

    <div class="list-box tag-list" bind:this={listBox}>
      {#if !loaded?.ok}
        <div class="empty compact" data-tag-loading>
          {#if loaded}
            <span class="empty-icon"><Icon name="alert-circle" size={20} /></span>
            <strong>没有读到标签</strong>
            <button type="button" class="btn btn-secondary btn-sm" title={readBlocked ? BUSY_REASON : undefined} disabled={readBlocked} onclick={retryLoad}>重试</button>
          {:else}
            <span class="empty-icon"><span class="spinner"></span></span>
            <strong>正在读取标签</strong>
          {/if}
        </div>
      {:else if visible.length === 0}
        <div class="empty compact"><span class="empty-icon"><Icon name="tag" size={20} /></span><strong>{tags.length === 0 ? "还没有标签" : "没有匹配的标签"}</strong><p>{tags.length === 0 ? "点“新建标签”创建第一个版本标记。" : "试试标签名、目标 Hash 或附注内容。"}</p></div>
      {:else}
        {#each visible as tag (tag.name)}
          {@const status = remoteStatus(tag)}
          <div class="list-row tag-row">
            <span class="tag-row-icon"><Icon name="tag" size={15} /></span>
            <div class="lr-main">
              <span class="lr-title"><span title={tag.name}>{tag.name}</span>{#if tag.message}<span class="chip tag">附注</span>{/if}<span class={`chip ${status.tone}`} data-remote-status title={status.title}>{status.label}</span></span>
              <span class="lr-sub tag-target">
                <code>{shortOid(tag.targetOid)}</code>
                <button type="button" aria-label={`复制标签 ${tag.name} 的目标 Hash`} title="复制完整目标 Hash" onclick={() => copyOid(tag.targetOid)}><Icon name={copied === tag.targetOid ? "check" : "copy"} size={11} class={copied === tag.targetOid ? "tag-copied" : ""} /></button>
                <span>·</span><span title={formatAuthoredAt(tag.createdAt)}>{formatAuthoredAt(tag.createdAt)}</span>
              </span>
              {#if tag.message}<span class="lr-desc">{tag.message}</span>{/if}
            </div>
            <span class="lr-actions">
              <button type="button" class="btn btn-ghost btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => onOpenHistory(tag.targetOid)}><Icon name="history" size={12} />查看提交</button>
              {#if status.canPush}
                <button type="button" class="btn btn-secondary btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => push(tag)}><Icon name="arrow-up" size={12} />推送</button>
              {/if}
              <button type="button" class="icon-btn sm danger" aria-label={`删除标签 ${tag.name}`} title="删除本地标签" disabled={blocked} onclick={() => askRemove(tag)}><Icon name="trash" size={13} /></button>
            </span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if confirmTag}
    <ConfirmDialog
      title="删除本地标签"
      titleId="tag-delete-title"
      message={`删除本地标签 ${confirmTag.name}？`}
      targets={[{ icon: "tag", name: confirmTag.name, detail: `指向 ${shortOid(confirmTag.targetOid)}${confirmTag.message ? ` · ${confirmTag.message}` : ""}` }]}
      targetsLabel="要删除的标签"
      notes={[
        { tone: "ok", text: "目标提交不会删除，之后可以重新打同名标签。" },
        { tone: "info", text: "远程上的同名标签不会删除。" },
      ]}
      confirmLabel="删除标签"
      confirmIcon="trash"
      busy={writing}
      confirmBlocked={blocked && !writing ? BUSY_REASON : null}
      onConfirm={() => void remove()}
      onCancel={() => {
        if (!writing) void closeConfirm();
      }}
    />
  {/if}
  {#if errorText}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>{/if}
</div>
