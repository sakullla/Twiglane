<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { formatAuthoredAt, shortOid, stashPathBadge } from "../history";
  import type { OpenedRepository, StashApplyResult, StashRecord, StashState, StatusSnapshot } from "../types";
  import { BUSY_REASON, relativeTime, splitPath } from "../ui";
  import { isContextKey } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenChanges: (path: string) => void;
    /** 作为任务 modal 的内容时不再自带整页面板外框与滚动容器。 */
    embedded?: boolean;
    /** 保存范围里的文件右键（或菜单键 / Shift+F10）。 */
    onFileContextMenu?: (path: string, kind: "tracked" | "untracked" | "ignored", point: { x: number; y: number }) => void;
  }

  let {
    opened,
    disabled,
    nextId,
    onGeneration,
    onSnapshot,
    onFailure,
    onNotice,
    onOpenChanges,
    embedded = false,
    onFileContextMenu,
  }: Props = $props();

  let includeUntracked = $state(false);
  let message = $state("");
  let stash = $state<StashState | null>(null);
  let applied = $state<StashApplyResult | null>(null);
  let errorText = $state<string | null>(null);
  let busy = $state(false);
  let confirmRecord = $state<StashRecord | null>(null);

  let preview = $derived(stash?.preview ?? null);

  type ScopeKind = "tracked" | "untracked" | "ignored";
  /**
   * 保存范围按三类分开列：已跟踪（一定保存）、未跟踪（看开关）、忽略（从不保存）。
   * 几千个文件时不能把路径全铺成标签：默认只给数量，文件清单收起，展开后按类切换、可筛选，
   * 列表在固定高度里滚动。后端每类最多给 200 个路径，超出时就地说明列出了多少。
   */
  let scopes = $derived.by(() => {
    if (!preview) return [];
    const list: { id: ScopeKind; label: string; tone: string; count: number; paths: string[] }[] = [
      { id: "tracked", label: "已跟踪改动", tone: "save", count: preview.trackedCount, paths: preview.trackedPaths },
      {
        id: "untracked",
        label: includeUntracked ? "未跟踪文件" : "未跟踪文件（不保存）",
        tone: includeUntracked ? "save" : "skip",
        count: preview.untrackedCount,
        paths: preview.untrackedPaths,
      },
      { id: "ignored", label: "忽略文件（不保存）", tone: "ignore", count: preview.ignoredCount, paths: preview.ignoredPaths },
    ];
    return list.filter((scope) => scope.count > 0);
  });
  let totalPaths = $derived(scopes.reduce((sum, scope) => sum + scope.count, 0));
  /** 文件清单展开状态：没手动切换时，文件少（不超过 8 个）才默认展开。 */
  let filesOpenChoice = $state<boolean | null>(null);
  let filesOpen = $derived(filesOpenChoice ?? totalPaths <= 8);
  let scopeChoice = $state<ScopeKind>("tracked");
  let activeScope = $derived(scopes.find((scope) => scope.id === scopeChoice) ?? scopes[0] ?? null);
  let fileQuery = $state("");
  /** 主按钮写明这次会收起多少个文件：几千个时一眼就知道不是只保存了列出来的那些。 */
  let saveLabel = $derived(
    preview?.canSave ? `临时保存 ${preview.trackedCount + (includeUntracked ? preview.untrackedCount : 0)} 个文件` : "临时保存",
  );
  /** 键盘游标：清单是一个可聚焦的列表，↑/↓ 移动，菜单键或 Shift+F10 打开这一行的操作。 */
  let activeFile = $state(0);
  let fileListEl = $state<HTMLUListElement | null>(null);

  function fileMenu(path: string, point: { x: number; y: number }) {
    if (!activeScope || !onFileContextMenu) return;
    onFileContextMenu(path, activeScope.id, point);
  }

  function onFileKey(event: KeyboardEvent) {
    if (shownPaths.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      activeFile = Math.min(shownPaths.length - 1, Math.max(0, activeFile + step));
      fileListEl?.querySelector<HTMLElement>(`[data-index="${activeFile}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (isContextKey(event)) {
      event.preventDefault();
      const row = fileListEl?.querySelector<HTMLElement>(`[data-index="${activeFile}"]`);
      const rect = row?.getBoundingClientRect();
      fileMenu(shownPaths[activeFile], rect ? { x: rect.left + 24, y: rect.bottom - 4 } : { x: 160, y: 160 });
    }
  }

  let shownPaths = $derived.by(() => {
    if (!activeScope) return [];
    const needle = fileQuery.trim().toLowerCase();
    return needle ? activeScope.paths.filter((path) => path.toLowerCase().includes(needle)) : activeScope.paths;
  });

  $effect(() => {
    const repo = opened.summary.path;
    const generation = opened.generation;
    const include = includeUntracked;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.stashState(repo, include, generation, nextId());
        if (cancelled || opened.summary.path !== repo) return;
        stash = result;
        errorText = null;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        errorText = failure.message;
        onFailure(failure);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  async function callWithStale<T>(run: (generation: number) => Promise<T>, generation: number): Promise<T> {
    try {
      return await run(generation);
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
        return await run(failure.generation);
      }
      throw error;
    }
  }

  /** 写操作失败后按最新状态重读列表：失败提示之外，界面要反映仓库里真实存在的记录。 */
  async function reloadAfterFailure(repo: string) {
    try {
      const fresh = await api.stashState(repo, includeUntracked, opened.generation, nextId());
      if (opened.summary.path === repo) stash = fresh;
    } catch {
      // 重读失败不覆盖原有错误提示。
    }
  }

  async function withBusy(action: () => Promise<void>) {
    if (busy || disabled) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
  }

  function save() {
    const current = stash;
    if (!current?.preview.canSave) return;
    const repo = opened.summary.path;
    const generation = opened.generation;
    const include = includeUntracked;
    const note = message;
    void withBusy(async () => {
      try {
        const result = await callWithStale(
          (gen) => api.saveStash(repo, include, note, gen, nextId()),
          generation,
        );
        if (opened.summary.path !== repo) return;
        stash = result.state;
        applied = null;
        errorText = null;
        onSnapshot(result.state.snapshot);
        onNotice(result.note);
      } catch (error) {
        const failure = normalizeError(error);
        errorText = failure.message;
        onFailure(failure);
        await reloadAfterFailure(repo);
      }
    });
  }

  function restore(oid: string) {
    const repo = opened.summary.path;
    const generation = opened.generation;
    void withBusy(async () => {
      try {
        const result = await callWithStale((gen) => api.applyStash(repo, oid, gen, nextId()), generation);
        if (opened.summary.path !== repo) return;
        applied = result;
        errorText = null;
        onSnapshot(result.snapshot);
        onNotice(result.note);
        stash = await api.stashState(repo, includeUntracked, result.generation, nextId());
      } catch (error) {
        const failure = normalizeError(error);
        errorText = failure.message;
        onFailure(failure);
        await reloadAfterFailure(repo);
      }
    });
  }

  function askDelete(record: StashRecord) {
    confirmRecord = record;
  }

  function cancelDelete() {
    confirmRecord = null;
  }

  function confirmDelete() {
    const record = confirmRecord;
    if (!record) return;
    confirmRecord = null;
    const repo = opened.summary.path;
    const generation = opened.generation;
    void withBusy(async () => {
      try {
        const result = await callWithStale(
          (gen) => api.deleteStash(repo, record.oid, true, gen, nextId()),
          generation,
        );
        if (opened.summary.path !== repo) return;
        stash = result;
        errorText = null;
        onSnapshot(result.snapshot);
        onNotice(`已删除临时保存 ${shortOid(record.oid)}。`);
      } catch (error) {
        const failure = normalizeError(error);
        errorText = failure.message;
        onFailure(failure);
        await reloadAfterFailure(repo);
      }
    });
  }
</script>

<section class={embedded ? "" : "span-main"} aria-label="临时保存" data-panel="stash">
  <div class="panel-scroll stash-body">
    <div class="panel-inner stash-inner">
      <section class="stash-section" aria-labelledby="stash-new-title">
        <div class="stash-section-head">
          <h2 id="stash-new-title">保存当前改动</h2>
          <span class="spacer"></span>
          <label class="switch">
            <input
              type="checkbox"
              checked={includeUntracked}
              title={busy || disabled ? BUSY_REASON : undefined}
              disabled={busy || disabled}
              onchange={(event) => (includeUntracked = (event.currentTarget as HTMLInputElement).checked)}
            />
            包含未跟踪文件
          </label>
        </div>
        <p class="stash-summary">{preview?.summary ?? "正在确认将保存的范围。"}</p>

        {#if preview && scopes.length > 0}
          <div class="stash-scope">
            <button
              type="button"
              class="stash-scope-toggle"
              aria-expanded={filesOpen}
              aria-controls="stash-files"
              onclick={() => (filesOpenChoice = !filesOpen)}
            >
              <Icon name="chevron-right" size={13} class={filesOpen ? "rot90" : ""} />
              <span>{filesOpen ? "收起文件清单" : "查看文件清单"}</span>
            </button>
            {#if filesOpen && activeScope}
              <div class="stash-files" id="stash-files">
                <div class="stash-files-tools">
                  {#if scopes.length > 1}
                    <div class="segmented" role="tablist" aria-label="保存范围分类">
                      {#each scopes as scope (scope.id)}
                        <button type="button" role="tab" aria-selected={activeScope.id === scope.id} onclick={() => (scopeChoice = scope.id)}>
                          {scope.label}<span class="count">{scope.count}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if activeScope.paths.length > 8}
                    <div class="field sm stash-files-filter">
                      <Icon name="search" size={13} />
                      <input aria-label="筛选保存范围里的文件" placeholder="筛选文件" autocomplete="off" spellcheck="false" bind:value={fileQuery} />
                      {#if fileQuery}
                        <button type="button" class="field-clear" aria-label="清空筛选" onclick={() => (fileQuery = "")}><Icon name="x" size={12} /></button>
                      {/if}
                    </div>
                  {/if}
                </div>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
                <ul
                  class="stash-file-list"
                  aria-label="保存范围"
                  tabindex="0"
                  bind:this={fileListEl}
                  onkeydown={onFileKey}
                  onfocus={() => (activeFile = Math.min(activeFile, Math.max(0, shownPaths.length - 1)))}
                >
                  {#each shownPaths as path, index (path)}
                    {@const parts = splitPath(path)}
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <li
                      class="stash-file"
                      class:active={index === activeFile}
                      data-index={index}
                      title={onFileContextMenu ? `${path}\n右键查看操作` : path}
                      oncontextmenu={(event) => {
                        if (!onFileContextMenu) return;
                        event.preventDefault();
                        activeFile = index;
                        fileMenu(path, { x: event.clientX, y: event.clientY });
                      }}
                      onmousedown={() => (activeFile = index)}
                    >
                      <span class="sr-only">{stashPathBadge(activeScope.id, includeUntracked)} {path}</span>
                      <span class="stash-file-name" aria-hidden="true">{parts.name}</span>
                      {#if parts.dir}<span class="stash-file-dir" aria-hidden="true"><bdi>{parts.dir}</bdi></span>{/if}
                    </li>
                  {/each}
                  {#if shownPaths.length === 0}
                    <li class="stash-file-empty">没有匹配的文件{activeScope.count > activeScope.paths.length ? "（只在已列出的文件里筛选）" : ""}。</li>
                  {/if}
                </ul>
                {#if activeScope.count > activeScope.paths.length}
                  <p class="hint stash-files-more">共 {activeScope.count} 个，只列出前 {activeScope.paths.length} 个；数量以上面的说明为准，保存时全部处理。</p>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <div class="stash-save-row">
          <input
            class="input"
            aria-label="临时保存说明"
            placeholder="可选说明，例如：先放一放的实验"
            value={message}
            title={busy || disabled ? BUSY_REASON : undefined}
            disabled={busy || disabled}
            oninput={(event) => (message = (event.currentTarget as HTMLInputElement).value)}
            onkeydown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
          <button type="button" class="btn btn-primary" title={disabled || busy ? BUSY_REASON : !preview?.canSave ? "没有可保存的改动" : undefined} disabled={disabled || busy || !preview?.canSave} onclick={save}>
            {#if busy}<span class="spinner"></span>{:else}<Icon name="archive" size={14} />{/if}
            {saveLabel}
          </button>
        </div>
      </section>

      {#if errorText}
        <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
      {/if}
      {#if applied}
        <div class={`callout ${applied.conflicted ? "warn" : "ok"}`} role="status">
          <Icon name={applied.conflicted ? "alert" : "check-circle"} size={15} />
          <div class="callout-body">
            <p>{applied.note}</p>
            {#if applied.kept}<p>记录 {shortOid(applied.oid)} 仍保留。</p>{/if}
            {#if applied.conflicted}
              <div class="row">
                {#each applied.conflictPaths as path (path)}
                  <button type="button" class="btn btn-secondary btn-sm" onclick={() => onOpenChanges(path)}>查看冲突 {path}</button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <section class="stash-section" aria-labelledby="stash-records-title">
        <div class="stash-section-head">
          <h2 id="stash-records-title">已有记录</h2>
          {#if stash}<span class="count">{stash.records.length}</span>{/if}
        </div>
        {#if stash && stash.records.length === 0}
          <p class="stash-records-empty">还没有临时保存记录。没有可保存的内容时不会创建记录。</p>
        {/if}
        <div class="stash-list">
          {#each stash?.records ?? [] as record (record.oid)}
            <div class="stash-record">
              <span class="sr-icon"><Icon name="archive" size={14} /></span>
              <div class="sr-main">
                <strong class:untitled={!record.message}>{record.message || "未填写说明"}</strong>
                <span class="hint" title={`${record.oid}\n${formatAuthoredAt(record.committedAt)}`}>
                  <span class="mono">{shortOid(record.oid)}</span> · {relativeTime(record.committedAt)}
                </span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" title={disabled || busy ? BUSY_REASON : "恢复到工作区，原记录仍保留"} disabled={disabled || busy} onclick={() => restore(record.oid)}>恢复</button>
              <button type="button" class="btn btn-danger-soft btn-sm" title={disabled || busy ? BUSY_REASON : undefined} disabled={disabled || busy} onclick={() => askDelete(record)}>删除</button>
            </div>
          {/each}
        </div>
      </section>
    </div>
  </div>
  {#if confirmRecord}
    <Modal
      title="删除临时保存"
      titleId="stash-delete-title"
      icon="trash"
      tone="danger"
      size="sm"
      description="删除后 Git 不再保留这条记录，本应用不能恢复。取消不会删除，工作区也不会改变。"
      onClose={cancelDelete}
    >
      <ul class="scope-list" aria-label="受影响的临时保存记录">
        <li title={confirmRecord.oid}>
          {shortOid(confirmRecord.oid)} · {confirmRecord.message || "未填写说明"} · {formatAuthoredAt(confirmRecord.committedAt)}
        </li>
      </ul>
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" onclick={cancelDelete}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-danger" onclick={confirmDelete}>确认删除</button>
      {/snippet}
    </Modal>
  {/if}
</section>
