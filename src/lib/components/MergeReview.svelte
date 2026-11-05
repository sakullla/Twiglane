<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { commitFileLabel, formatAuthoredAt, shortOid } from "../history";
  import { LatestReadQueue } from "../latest-read";
  import type { CommitDetail, CommitFileChange, DiffHunk, DiffResponse, HistoryCommit, MergePreview, OpenedRepository } from "../types";
  import { hueOf, initialOf, relativeTime, splitPath, statusMark } from "../ui";
  import CommitDiffList from "./CommitDiffList.svelte";
  import DiffView from "./DiffView.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 合并前的审阅区：左边是将带入的提交、文件和预计冲突，右边是所选项的明细。
   * 点提交看这次提交的全部改动；点文件看它从共同祖先到来源顶端一共带入了什么。
   * 全部只读：不切换分支，不碰工作区和暂存区。
   */
  interface Props {
    opened: OpenedRepository;
    preview: MergePreview;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
  }

  let { opened, preview, disabled, nextId, onGeneration, onFailure }: Props = $props();

  type Tab = "commits" | "files" | "conflicts";
  type Entry =
    | { kind: "commit"; key: string; commit: HistoryCommit }
    | { kind: "file"; key: string; file: CommitFileChange; conflict: boolean };

  let tab = $state<Tab>("commits");
  let filter = $state("");
  let selectedKey = $state<string | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);

  let conflictSet = $derived(new Set(preview.conflictPaths));
  let commitEntries = $derived<Entry[]>(preview.commits.map((commit) => ({ kind: "commit", key: `c:${commit.oid}`, commit })));
  let fileEntries = $derived<Entry[]>(
    preview.files.map((file) => ({ kind: "file", key: `f:${file.path}`, file, conflict: conflictSet.has(file.path) })),
  );
  /** 预计冲突的路径可能不在已列出的文件里（文件列表有上限）：补成一条修改记录。 */
  let conflictEntries = $derived<Entry[]>(
    preview.conflictPaths.map((path) => ({
      kind: "file",
      key: `f:${path}`,
      file: preview.files.find((file) => file.path === path) ?? { path, originalPath: null, status: "modified" },
      conflict: true,
    })),
  );
  let tabEntries = $derived(tab === "commits" ? commitEntries : tab === "files" ? fileEntries : conflictEntries);
  let entries = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tabEntries;
    return tabEntries.filter((entry) =>
      entry.kind === "commit"
        ? entry.commit.summary.toLowerCase().includes(needle) ||
          entry.commit.oid.startsWith(needle) ||
          entry.commit.authorName.toLowerCase().includes(needle)
        : entry.file.path.toLowerCase().includes(needle),
    );
  });
  let selectedIndex = $derived(entries.findIndex((entry) => entry.key === selectedKey));
  let selected = $derived(selectedIndex >= 0 ? entries[selectedIndex] : null);
  let hiddenCommits = $derived(Math.max(0, preview.incoming - preview.commits.length));
  let hiddenFiles = $derived(Math.max(0, preview.filesTotal - preview.files.length));
  let canCompare = $derived(Boolean(preview.baseOid && preview.sourceOid));

  // 换了比较对象（来源、目标或预检结果）时回到提交页；当前页空了就换到有内容的一页。
  let previewKey = $derived(`${preview.source}\u0000${preview.target}\u0000${preview.sourceOid ?? ""}\u0000${preview.baseOid ?? ""}`);
  let seenPreview = "";
  $effect(() => {
    const key = previewKey;
    untrack(() => {
      if (key === seenPreview) return;
      seenPreview = key;
      filter = "";
      tab = preview.commits.length > 0 ? "commits" : "files";
      selectedKey = null;
    });
  });
  $effect(() => {
    if (tab === "conflicts" && preview.conflictPaths.length === 0) tab = "commits";
  });

  // 选中项被筛掉或换页后落到第一项：右侧总有内容可看，不用再点一次。
  $effect(() => {
    const list = entries;
    untrack(() => {
      if (list.length === 0) return;
      if (!selectedKey || !list.some((entry) => entry.key === selectedKey)) selectedKey = list[0].key;
    });
  });

  function setTab(next: Tab) {
    if (next === tab) return;
    tab = next;
    filter = "";
    selectedKey = null;
    if (listEl) listEl.scrollTop = 0;
  }

  function select(index: number, focusList = false) {
    const entry = entries[index];
    if (!entry) return;
    selectedKey = entry.key;
    void tick().then(() => {
      listEl?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(entry.key)}"]`)?.scrollIntoView?.({ block: "nearest" });
      if (focusList) listEl?.focus({ preventScroll: true });
    });
  }

  function onListKey(event: KeyboardEvent) {
    if (entries.length === 0) return;
    const at = Math.max(0, selectedIndex);
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") next = Math.min(entries.length - 1, at + 1);
    else if (event.key === "ArrowUp" || event.key === "k") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = entries.length - 1;
    else if (event.key === "PageDown") next = Math.min(entries.length - 1, at + 10);
    else if (event.key === "PageUp") next = Math.max(0, at - 10);
    if (next === null) return;
    event.preventDefault();
    select(next);
  }

  function onFilterKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      select(Math.max(0, selectedIndex), true);
    } else if (event.key === "Escape" && filter) {
      event.preventDefault();
      event.stopPropagation();
      filter = "";
    }
  }

  /* ---------- 明细读取：提交详情或单个文件的区间差异。只保留最新一次请求的结果。 ---------- */
  const reads = new LatestReadQueue();
  onDestroy(() => reads.close());
  let token = 0;
  let detail = $state.raw<CommitDetail | null>(null);
  let fileDiff = $state.raw<DiffResponse | null>(null);
  let detailError = $state<string | null>(null);
  let detailLoading = $state(false);
  let bodyOpen = $state(false);
  let retryNonce = $state(0);
  let copied = $state<string | null>(null);

  async function withRetry<T>(ask: (generation: number) => Promise<T>, mine: number): Promise<T | null> {
    try {
      return await reads.run(() => ask(opened.generation));
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined || mine !== token) throw failure;
      onGeneration(failure.generation);
      return reads.run(() => ask(failure.generation!));
    }
  }

  /** 只在所选条目真正换了（或比较对象变了）时重读；筛选、重排不触发。 */
  let detailKey = $derived(selected ? `${previewKey}|${selected.key}|${retryNonce}` : null);

  $effect(() => {
    const key = detailKey;
    const repo = opened.summary.path;
    untrack(() => {
      const entry = selected;
      const mine = ++token;
      bodyOpen = false;
      detailError = null;
      detail = null;
      fileDiff = null;
      if (!key || !entry) {
        detailLoading = false;
        return;
      }
      if (entry.kind === "commit") {
        detailLoading = true;
        void withRetry((generation) => api.commitDetail(repo, entry.commit.oid, null, generation, nextId()), mine)
          .then((result) => {
            if (mine !== token || !result) return;
            detail = result;
            if (result.generation > opened.generation) onGeneration(result.generation);
          })
          .catch((error: unknown) => {
            if (mine !== token) return;
            const failure = normalizeError(error);
            if (failure.code === "cancelled") return;
            detailError = failure.message;
          })
          .finally(() => {
            if (mine === token) detailLoading = false;
          });
        return;
      }
      if (!preview.baseOid || !preview.sourceOid) {
        detailLoading = false;
        return;
      }
      const base = preview.baseOid;
      const head = preview.sourceOid;
      detailLoading = true;
      void withRetry((generation) => api.compareFileDiff(repo, base, head, entry.file.path, generation, nextId()), mine)
        .then((result) => {
          if (mine !== token || !result) return;
          fileDiff = result;
        })
        .catch((error: unknown) => {
          if (mine !== token) return;
          const failure = normalizeError(error);
          if (failure.code === "cancelled") return;
          detailError = failure.message;
        })
        .finally(() => {
          if (mine === token) detailLoading = false;
        });
    });
  });

  let loadingMore = $state(false);
  async function loadMore() {
    const current = fileDiff;
    const base = preview.baseOid;
    const head = preview.sourceOid;
    if (!current || !base || !head || loadingMore || current.offset + current.lines.length >= current.totalLines) return;
    const mine = token;
    loadingMore = true;
    try {
      const result = await api.compareFileDiff(
        opened.summary.path,
        base,
        head,
        current.path,
        opened.generation,
        nextId(),
        current.offset + current.lines.length,
        400,
      );
      if (mine !== token || fileDiff !== current) return;
      const baseLines = current.lines.length;
      const merged = new Map(current.hunks.map((hunk) => [hunk.index, hunk]));
      for (const hunk of result.hunks) if (!merged.has(hunk.index)) merged.set(hunk.index, { ...hunk, startLine: hunk.startLine + baseLines } as DiffHunk);
      fileDiff = { ...result, offset: current.offset, lines: [...current.lines, ...result.lines], hunks: [...merged.values()], totalLines: result.totalLines };
    } catch (error) {
      if (mine === token) onFailure(error);
    } finally {
      loadingMore = false;
    }
  }

  function retry() {
    retryNonce += 1;
  }

  async function copyOid(oid: string) {
    try {
      await navigator.clipboard.writeText(oid);
      copied = oid;
      setTimeout(() => {
        if (copied === oid) copied = null;
      }, 1600);
    } catch {
      onFailure({ code: "clipboard", message: "无法写入剪贴板，请手动复制提交标识。" });
    }
  }

  function bodyRest(value: CommitDetail): string {
    const lines = value.body.replace(/\r\n/g, "\n").split("\n");
    return lines.slice(1).join("\n").trim();
  }
</script>

<section class="merge-review" aria-label="合并内容">
  <aside class="merge-review-side" aria-label="将带入的内容">
    <div class="merge-review-tabs" role="tablist" aria-label="合并内容">
      <button type="button" role="tab" aria-selected={tab === "commits"} disabled={preview.commits.length === 0} title={preview.commits.length === 0 ? "没有需要带入的提交" : undefined} onclick={() => setTab("commits")}>
        <Icon name="commit" size={13} />提交<span class="count">{preview.incoming}</span>
      </button>
      <button type="button" role="tab" aria-selected={tab === "files"} disabled={preview.files.length === 0} title={preview.files.length === 0 ? "没有文件变化" : undefined} onclick={() => setTab("files")}>
        <Icon name="file" size={13} />文件<span class="count">{preview.filesTotal}</span>
      </button>
      {#if preview.conflictPaths.length > 0}
        <button type="button" role="tab" aria-selected={tab === "conflicts"} onclick={() => setTab("conflicts")}>
          <Icon name="alert" size={13} />冲突<span class="count warning">{preview.conflictPaths.length}</span>
        </button>
      {/if}
    </div>
    <div class="merge-review-filter">
      <div class="field sm">
        <Icon name="search" size={13} />
        <input
          aria-label={tab === "commits" ? "筛选提交" : "筛选文件"}
          placeholder={tab === "commits" ? "筛选说明、作者或哈希" : "筛选文件路径"}
          autocomplete="off"
          spellcheck="false"
          bind:this={filterInput}
          bind:value={filter}
          onkeydown={onFilterKey}
        />
        {#if filter}
          <button type="button" class="field-clear" aria-label="清除筛选" onclick={() => { filter = ""; filterInput?.focus(); }}><Icon name="x" size={12} /></button>
        {/if}
      </div>
    </div>
    <div
      class="merge-review-list"
      role="listbox"
      tabindex="0"
      aria-label={tab === "commits" ? "将带入的提交" : tab === "files" ? "将带入的文件" : "预计冲突的文件"}
      aria-activedescendant={selected ? `merge-entry-${selectedIndex}` : undefined}
      bind:this={listEl}
      onkeydown={onListKey}
    >
      {#each entries as entry, index (entry.key)}
        {#if entry.kind === "commit"}
          {@const commit = entry.commit}
          <div
            id={`merge-entry-${index}`}
            class="merge-entry commit"
            role="option"
            aria-selected={entry.key === selectedKey}
            data-entry={entry.key}
            tabindex="-1"
            title={`${commit.summary}\n${commit.authorName} · ${formatAuthoredAt(commit.authoredAt)}\n${commit.oid}`}
            onclick={() => select(index, true)}
            onkeydown={() => {}}
          >
            <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
            <span class="merge-entry-main">
              <span class="merge-entry-title">{commit.summary}</span>
              <span class="merge-entry-meta">
                <span class="truncate">{commit.authorName}</span>
                <span class="dot"></span>
                <span>{relativeTime(commit.authoredAt)}</span>
                {#if commit.parents.length > 1}<span class="merge-entry-tag"><Icon name="merge" size={10} />合并</span>{/if}
              </span>
            </span>
            <code class="merge-entry-oid">{shortOid(commit.oid)}</code>
          </div>
        {:else}
          {@const file = entry.file}
          {@const mark = statusMark(commitFileLabel(file.status))}
          {@const parts = splitPath(file.path)}
          <div
            id={`merge-entry-${index}`}
            class="merge-entry file"
            role="option"
            aria-selected={entry.key === selectedKey}
            data-entry={entry.key}
            tabindex="-1"
            title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
            onclick={() => select(index, true)}
            onkeydown={() => {}}
          >
            <span class={`st ${entry.conflict && tab === "conflicts" ? "st-con" : mark.tone}`}>{entry.conflict && tab === "conflicts" ? "!" : mark.letter}</span>
            <span class="merge-entry-main">
              <span class="merge-entry-title">{parts.name}</span>
              {#if parts.dir}<span class="merge-entry-meta"><bdi class="truncate">{parts.dir}</bdi></span>{/if}
            </span>
            {#if entry.conflict && tab !== "conflicts"}<span class="merge-hot">可能冲突</span>{/if}
          </div>
        {/if}
      {:else}
        <p class="merge-review-empty">{filter ? "没有匹配的条目" : tab === "commits" ? "没有需要带入的提交" : "没有文件变化"}</p>
      {/each}
      {#if !filter && tab === "commits" && hiddenCommits > 0}
        <p class="merge-review-more">还有 {hiddenCommits} 个更早的提交没有列出</p>
      {:else if !filter && tab === "files" && hiddenFiles > 0}
        <p class="merge-review-more">还有 {hiddenFiles} 个文件没有列出</p>
      {/if}
    </div>
    <p class="merge-review-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> 逐条查看</p>
  </aside>

  <div class="merge-review-detail" aria-live="polite" aria-busy={detailLoading}>
    {#if !selected}
      <div class="empty compact"><span class="empty-icon"><Icon name="eye" size={22} /></span><strong>选择左侧的提交或文件查看明细</strong></div>
    {:else if selected.kind === "commit"}
      {@const commit = selected.commit}
      <header class="merge-detail-head">
        <div class="merge-detail-title">
          <h3 title={commit.summary}>{commit.summary}</h3>
          <span class="merge-detail-step">{selectedIndex + 1} / {entries.length}</span>
          <div class="merge-detail-nav" role="group" aria-label="切换提交">
            <button type="button" class="icon-btn sm" aria-label="上一个提交" title="上一个（↑）" disabled={selectedIndex <= 0} onclick={() => select(selectedIndex - 1)}><Icon name="arrow-up" size={13} /></button>
            <button type="button" class="icon-btn sm" aria-label="下一个提交" title="下一个（↓）" disabled={selectedIndex >= entries.length - 1} onclick={() => select(selectedIndex + 1)}><Icon name="arrow-down" size={13} /></button>
          </div>
        </div>
        <div class="merge-detail-byline">
          <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
          <strong>{commit.authorName}</strong>
          <span title={formatAuthoredAt(commit.authoredAt)}>{relativeTime(commit.authoredAt)} · {formatAuthoredAt(commit.authoredAt)}</span>
          {#if commit.parents.length > 1}<span class="merge-entry-tag"><Icon name="merge" size={10} />合并提交</span>{/if}
          <span class="spacer"></span>
          <span class="oid-chip" title={commit.oid}>
            {shortOid(commit.oid)}
            <button type="button" aria-label="复制完整提交标识" title={copied === commit.oid ? "已复制" : "复制完整提交标识"} onclick={() => void copyOid(commit.oid)}>
              <Icon name={copied === commit.oid ? "check" : "copy"} size={12} />
            </button>
          </span>
        </div>
        {#if detail && detail.commit.oid === commit.oid && bodyRest(detail)}
          <div class="merge-detail-body" class:open={bodyOpen}>
            <pre>{bodyRest(detail)}</pre>
            <button type="button" class="btn btn-ghost btn-sm" onclick={() => (bodyOpen = !bodyOpen)}>
              <Icon name="chevron-down" size={12} class={bodyOpen ? "flip" : ""} />{bodyOpen ? "收起说明" : "展开说明"}
            </button>
          </div>
        {/if}
      </header>
      {#if detailError}
        <div class="merge-detail-state">
          <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{detailError}</span></div>
          <button type="button" class="btn btn-secondary btn-sm" onclick={retry}><Icon name="refresh" size={13} />重试</button>
        </div>
      {:else if !detail || detail.commit.oid !== commit.oid}
        <div class="empty compact" role="status"><span class="empty-icon"><span class="spinner"></span></span><strong>正在读取提交内容</strong></div>
      {:else}
        {#key detail.commit.oid}
          <CommitDiffList {opened} {detail} parent={detail.selectedParent} {disabled} {nextId} {onGeneration} {onFailure} />
        {/key}
      {/if}
    {:else}
      {@const file = selected.file}
      {@const parts = splitPath(file.path)}
      {@const mark = statusMark(commitFileLabel(file.status))}
      <header class="merge-detail-head">
        <div class="merge-detail-title">
          <span class={`st ${mark.tone}`} title={commitFileLabel(file.status)}>{mark.letter}</span>
          <h3 class="mono" title={file.path}>{parts.name}</h3>
          {#if parts.dir}<span class="merge-detail-dir truncate" title={parts.dir}>{parts.dir}</span>{/if}
          <span class="spacer"></span>
          <span class="merge-detail-step">{selectedIndex + 1} / {entries.length}</span>
          <div class="merge-detail-nav" role="group" aria-label="切换文件">
            <button type="button" class="icon-btn sm" aria-label="上一个文件" title="上一个（↑）" disabled={selectedIndex <= 0} onclick={() => select(selectedIndex - 1)}><Icon name="arrow-up" size={13} /></button>
            <button type="button" class="icon-btn sm" aria-label="下一个文件" title="下一个（↓）" disabled={selectedIndex >= entries.length - 1} onclick={() => select(selectedIndex + 1)}><Icon name="arrow-down" size={13} /></button>
          </div>
        </div>
        <p class="merge-detail-note">
          {#if file.originalPath}<span class="mono">{file.originalPath} → {file.path}</span>　{/if}
          {#if selected.conflict}
            <span class="merge-hot">可能冲突</span> {preview.target} 也改了这个文件，开始合并后逐处选择保留哪边。
          {:else}
            {preview.source} 自分叉以来对这个文件的全部改动，合并后会进入 {preview.target}。
          {/if}
        </p>
      </header>
      {#if !canCompare}
        <div class="empty compact"><span class="empty-icon"><Icon name="info" size={22} /></span><strong>暂时无法比较这个文件</strong><p>没有读到两个分支的共同祖先，重新检查后再试。</p></div>
      {:else if detailError}
        <div class="merge-detail-state">
          <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{detailError}</span></div>
          <button type="button" class="btn btn-secondary btn-sm" onclick={retry}><Icon name="refresh" size={13} />重试</button>
        </div>
      {:else}
        <div class="merge-detail-diff">
          <DiffView
            {onGeneration}
            selection={{ path: file.path, side: "unstaged" }}
            diff={fileDiff && fileDiff.path === file.path ? fileDiff : null}
            error={null}
            loading={detailLoading || loadingMore}
            {disabled}
            readOnly={true}
            onStageHunk={() => {}}
            onLoadMore={() => void loadMore()}
          />
        </div>
      {/if}
    {/if}
  </div>
</section>
