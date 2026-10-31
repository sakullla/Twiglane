<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import {
    commitFileLabel,
    formatAuthoredAt,
    HISTORY_SEARCH_DEBOUNCE_MS,
    historyStatus,
    parentCaption,
    preferredCommitFile,
    refLabel,
    shortOid,
  } from "../history";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import type { CommitDetail, DiffHunk, DiffResponse, FileSelection, HistoryPage, OpenedRepository } from "../types";
  import { hueOf, initialOf, relativeTime, splitPath, statusMark } from "../ui";
  import DiffView from "./DiffView.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    opened: OpenedRepository;
    filePath: string | null;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onFilePath: (path: string) => void;
    onClearFile: () => void;
  }

  const ROW_HEIGHT = 62;
  const FILE_ROW_HEIGHT = 30;

  let {
    opened,
    filePath,
    disabled,
    nextId,
    onGeneration,
    onFailure,
    onFilePath,
    onClearFile,
  }: Props = $props();

  let query = $state("");
  let activeQuery = $state("");
  let offset = $state(0);
  let page = $state<HistoryPage | null>(null);
  let listError = $state<string | null>(null);
  let loading = $state(false);
  let selectedOid = $state<string | null>(null);
  let parentChoice = $state<string | null>(null);
  let manualPath = $state<string | null>(null);
  let detail = $state<CommitDetail | null>(null);
  let detailError = $state<string | null>(null);
  let commitDiff = $state<DiffResponse | null>(null);
  let diffError = $state<string | null>(null);
  let diffLoading = $state(false);
  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let fileScroll = $state(0);
  let fileViewport = $state(0);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFile: string | null | undefined = undefined;

  let commits = $derived(page?.commits ?? []);
  let range = $derived(
    visibleRange(commits.length, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let visible = $derived(commits.slice(range.start, range.end));
  let activeFile = $derived(detail ? preferredCommitFile(detail.files, manualPath ?? filePath) : null);
  let fileRange = $derived(
    visibleRange(
      detail?.files.length ?? 0,
      fileScroll,
      fileViewport > 0 ? fileViewport : fileScroll > 0 ? FILE_ROW_HEIGHT : 0,
      FILE_ROW_HEIGHT,
    ),
  );
  let visibleFiles = $derived(detail ? detail.files.slice(fileRange.start, fileRange.end) : []);
  let statusText = $derived(page && commits.length === 0 ? historyStatus(page.state) : null);
  let diffSelection = $derived<FileSelection | null>(
    activeFile ? { path: activeFile.path, side: "unstaged" } : null,
  );

  $effect(() => {
    if (lastFile === undefined) {
      lastFile = filePath;
      return;
    }
    if (lastFile === filePath) return;
    lastFile = filePath;
    offset = 0;
    selectedOid = null;
    parentChoice = null;
    manualPath = null;
  });

  $effect(() => {
    const repo = opened.summary.path;
    const generation = opened.generation;
    const relative = filePath;
    const q = relative ? "" : activeQuery;
    const off = offset;
    let cancelled = false;
    loading = true;
    void (async () => {
      try {
        const result = relative
          ? await api.fileHistory(repo, relative, off, generation, nextId())
          : await api.historyPage(repo, q, off, generation, nextId());
        if (cancelled || opened.summary.path !== repo) return;
        page = {
          generation: result.generation,
          query: "query" in result ? result.query : "",
          offset: result.offset,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
          state: result.state,
          commits: result.commits,
        };
        listError = null;
        const still = result.commits.some((commit) => commit.oid === selectedOid);
        const nextOid = still ? selectedOid : (result.commits[0]?.oid ?? null);
        if (nextOid !== selectedOid) {
          selectedOid = nextOid;
          parentChoice = null;
          manualPath = null;
        }
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        listError = failure.message;
        onFailure(failure);
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const repo = opened.summary.path;
    const generation = opened.generation;
    const oid = selectedOid;
    const parent = parentChoice;
    if (!oid) {
      detail = null;
      commitDiff = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.commitDetail(repo, oid, parent, generation, nextId());
        if (cancelled || opened.summary.path !== repo || selectedOid !== oid) return;
        detail = result;
        detailError = null;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        detail = null;
        detailError = failure.message;
        onFailure(failure);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const repo = opened.summary.path;
    const generation = opened.generation;
    const current = detail;
    const file = activeFile;
    const parent = parentChoice ?? current?.selectedParent ?? null;
    if (!current || !file) {
      commitDiff = null;
      diffLoading = false;
      return;
    }
    const oid = current.commit.oid;
    const relative = file.path;
    let cancelled = false;
    diffLoading = true;
    diffError = null;
    void (async () => {
      try {
        const result = await api.commitFileDiff(repo, oid, parent, relative, generation, nextId(), 0, 0);
        if (cancelled || opened.summary.path !== repo || detail?.commit.oid !== oid || activeFile?.path !== relative) return;
        commitDiff = result;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        commitDiff = null;
        diffError = failure.message;
        onFailure(failure);
      } finally {
        if (!cancelled) diffLoading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function scheduleSearch(value: string) {
    query = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      offset = 0;
      activeQuery = query.trim();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
  }

  function pick(oid: string) {
    if (selectedOid === oid) return;
    selectedOid = oid;
    parentChoice = null;
    manualPath = null;
  }

  function reveal(index: number) {
    const height = viewport > 0 ? viewport : (list?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, scrollTop, height, ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  function onListKey(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = commits.findIndex((commit) => commit.oid === selectedOid);
    const move = nextIndex(current, event.key, commits.length);
    if (move === null) return;
    event.preventDefault();
    reveal(move);
    const commit = commits[move];
    if (commit) pick(commit.oid);
  }

  function pageBack() {
    const size = page?.pageSize || 100;
    offset = Math.max(0, offset - size);
  }

  function pageForward() {
    const size = page?.pageSize || 100;
    if (!page?.hasMore) return;
    offset += size;
  }

  async function loadMoreDiff() {
    const current = commitDiff;
    const file = activeFile;
    const currentDetail = detail;
    if (!current || !file || !currentDetail || disabled) return;
    if (current.offset + current.lines.length >= current.totalLines) return;
    const repo = opened.summary.path;
    const parent = parentChoice ?? currentDetail.selectedParent;
    try {
      const result = await api.commitFileDiff(
        repo,
        currentDetail.commit.oid,
        parent,
        file.path,
        opened.generation,
        nextId(),
        current.offset + current.lines.length,
        400,
      );
      if (opened.summary.path !== repo || activeFile?.path !== file.path) return;
      const base = current.lines.length;
      commitDiff = {
        ...result,
        offset: current.offset,
        lines: [...current.lines, ...result.lines],
        hunks: mergeHunks(current.hunks, result.hunks, base),
        totalLines: result.totalLines,
      };
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== opened.generation) {
        onGeneration(failure.generation);
        return;
      }
      diffError = failure.message;
      onFailure(failure);
    }
  }

  function mergeHunks(current: DiffHunk[], extra: DiffHunk[], base: number): DiffHunk[] {
    const merged = new Map(current.map((hunk) => [hunk.index, hunk]));
    for (const hunk of extra) {
      if (!merged.has(hunk.index)) merged.set(hunk.index, { ...hunk, startLine: hunk.startLine + base });
    }
    return [...merged.values()];
  }

  let copiedOid = $state<string | null>(null);

  async function copyOid(oid: string) {
    try {
      await navigator.clipboard.writeText(oid);
      copiedOid = oid;
      setTimeout(() => {
        if (copiedOid === oid) copiedOid = null;
      }, 1500);
    } catch {
      copiedOid = null;
    }
  }

  function refTone(kind: string, current: boolean): string {
    if (current) return "current";
    if (kind === "remote") return "remote";
    if (kind === "tag") return "tag";
    if (kind === "head") return "head";
    return "branch";
  }

  function fileTitle(file: { path: string; originalPath: string | null }): string {
    return file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  }
</script>

<section class="span-main" aria-label="提交历史" aria-busy={loading}>
  <div class="panel-toolbar">
    {#if filePath}
      <button type="button" class="btn btn-ghost btn-sm" onclick={onClearFile}>
        <Icon name="arrow-left" size={14} />返回全部历史
      </button>
      <span class="chip remote" title={filePath}><Icon name="file" size={12} />文件历史：{filePath}</span>
    {:else}
      <div class="field sm">
        <Icon name="search" size={14} />
        <input
          aria-label="搜索全部历史"
          placeholder="搜索全部历史：说明、作者或提交标识"
          autocomplete="off"
          spellcheck="false"
          value={query}
          oninput={(event) => scheduleSearch((event.currentTarget as HTMLInputElement).value)}
        />
        {#if loading}<span class="spinner"></span>{/if}
      </div>
    {/if}
    <span class="spacer"></span>
    <div class="pager">
      <span class="hint">
        {#if page && commits.length > 0}第 {page.offset + 1}–{page.offset + commits.length} 条{:else}每页 {page?.pageSize ?? 100} 条{/if}
      </span>
      <button type="button" class="icon-btn sm" aria-label="上一页" title="上一页" disabled={offset === 0 || loading} onclick={pageBack}>
        <Icon name="chevron-left" size={15} />
      </button>
      <button type="button" class="icon-btn sm" aria-label="下一页" title="下一页" disabled={!page?.hasMore || loading} onclick={pageForward}>
        <Icon name="chevron-right" size={15} />
      </button>
    </div>
  </div>
  {#if listError}
    <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{listError}</span></div>
  {/if}
  <div class="history-layout">
    <div
      class="history-list"
      role="listbox"
      aria-label={filePath ? "文件历史" : "提交历史"}
      tabindex="0"
      bind:this={list}
      bind:clientHeight={viewport}
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      onkeydown={onListKey}
    >
      {#if loading && !page}
        <div class="empty" role="status"><span class="spinner"></span><strong>正在读取历史</strong></div>
      {:else if statusText}
        <div class="empty" role="status">
          <span class="empty-icon"><Icon name="history" size={22} /></span>
          <strong>{statusText}</strong>
        </div>
      {:else if commits.length === 0}
        <div class="empty" role="status"><strong>这一页没有提交。</strong></div>
      {:else}
        <div class="virtual-space" style={`height:${commits.length * ROW_HEIGHT}px`}>
          {#each visible as commit, index (commit.oid)}
            <button
              type="button"
              class="history-row"
              role="option"
              aria-selected={selectedOid === commit.oid}
              style={`top:${(range.start + index) * ROW_HEIGHT}px;height:${ROW_HEIGHT - 2}px`}
              title={`${commit.summary}\n${commit.authorName} · ${formatAuthoredAt(commit.authoredAt)}\n${commit.oid}`}
              onclick={() => pick(commit.oid)}
            >
              <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
              <span class="hr-main">
                <span class="hr-line">
                  {#each commit.labels as label (`${label.kind}:${label.name}`)}
                    <span class={`chip ${refTone(label.kind, label.current)}`}>{refLabel(label.kind, label.name, label.current)}</span>
                  {/each}
                  <span class="hr-summary">{commit.summary}</span>
                </span>
                <span class="hr-meta">
                  <span class="hr-author">{commit.authorName}</span>
                  <span class="hr-dot"></span>
                  <span>{relativeTime(commit.authoredAt)}</span>
                  <span class="hr-dot"></span>
                  <span class="mono">{shortOid(commit.oid)}</span>
                  {#if commit.parents.length > 1}
                    <span class="hr-dot"></span>
                    <span class="merge-note">{parentCaption(commit.parents)}</span>
                  {/if}
                </span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="history-detail">
      {#if detailError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{detailError}</span></div>
      {/if}
      {#if detail}
        <div class="history-meta">
          <h2 class="commit-title">{detail.commit.summary}</h2>
          <div class="commit-meta">
            <span class="avatar" style={`--hue:${hueOf(detail.commit.authorName)}`} aria-hidden="true">{initialOf(detail.commit.authorName)}</span>
            <strong>{detail.commit.authorName}</strong>
            <span>&lt;{detail.commit.authorEmail}&gt;</span>
            <span class="hr-dot"></span>
            <span title={formatAuthoredAt(detail.commit.authoredAt)}>{formatAuthoredAt(detail.commit.authoredAt)}</span>
          </div>
          <div class="commit-meta">
            <span class="oid-chip" title={detail.commit.oid}>
              {shortOid(detail.commit.oid)}
              <button type="button" aria-label="复制完整提交标识" title={copiedOid === detail.commit.oid ? "已复制" : "复制完整提交标识"} onclick={() => copyOid(detail?.commit.oid ?? "")}>
                <Icon name={copiedOid === detail.commit.oid ? "check" : "copy"} size={12} />
              </button>
            </span>
            <span>{parentCaption(detail.commit.parents, detail.root)}</span>
          </div>
          {#if detail.body.trim()}
            <pre class="commit-body">{detail.body}</pre>
          {/if}
          {#if detail.merge}
            <div class="row">
              <span class="hint">比较对象</span>
              <div class="segmented" role="group" aria-label="选择父提交">
                {#each detail.commit.parents as parent (parent)}
                  <button
                    type="button"
                    aria-pressed={(parentChoice ?? detail.selectedParent) === parent}
                    onclick={() => (parentChoice = parent)}
                  >
                    相对 {shortOid(parent)}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
          {#if detail.files.length === 0}
            <p class="hint">这次提交没有文件变化。</p>
          {:else}
            <div class="section-caption">变更文件 <span class="count">{detail.files.length}</span></div>
            <div
              class="file-list history-files"
              role="listbox"
              aria-label="提交中的文件"
              tabindex="0"
              style={`height:${Math.min(detail.files.length, 6) * FILE_ROW_HEIGHT + 2}px`}
              bind:clientHeight={fileViewport}
              onscroll={(event) => (fileScroll = event.currentTarget.scrollTop)}
            >
              <div class="virtual-space" style={`height:${detail.files.length * FILE_ROW_HEIGHT}px`}>
                {#each visibleFiles as file, index (`${file.status}:${file.path}`)}
                  {@const mark = statusMark(commitFileLabel(file.status))}
                  {@const parts = splitPath(file.path)}
                  <button
                    type="button"
                    class="file-row"
                    role="option"
                    aria-selected={activeFile?.path === file.path}
                    style={`top:${(fileRange.start + index) * FILE_ROW_HEIGHT}px;height:${FILE_ROW_HEIGHT}px`}
                    title={fileTitle(file)}
                    onclick={() => (manualPath = file.path)}
                  >
                    <span class={`st ${mark.tone}`} title={commitFileLabel(file.status)}>{mark.letter}</span>
                    <span class="file-name">
                      <span class="fn">{parts.name}</span>
                      {#if file.originalPath}
                        <span class="fd from" title={`重命名自 ${file.originalPath}`}>← {file.originalPath}</span>
                      {:else if parts.dir}
                        <span class="fd"><bdi>{parts.dir}</bdi></span>
                      {/if}
                    </span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        <DiffView
          selection={diffSelection}
          diff={commitDiff}
          error={diffError}
          loading={diffLoading}
          {disabled}
          readOnly={true}
          onStageHunk={() => {}}
          onLoadMore={loadMoreDiff}
          onFileHistory={onFilePath}
        />
      {:else if !loading}
        <div class="empty" role="status">
          <span class="empty-icon"><Icon name="commit" size={24} /></span>
          <strong>未选择提交</strong>
          <p>选择左侧一条记录后，这里显示其中的文件和差异。查看不会改变当前分支、暂存区或工作区。</p>
        </div>
      {/if}
    </div>
  </div>
</section>
