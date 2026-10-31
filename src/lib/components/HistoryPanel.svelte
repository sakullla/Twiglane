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
  import DiffView from "./DiffView.svelte";

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

  const ROW_HEIGHT = 84;
  const FILE_ROW_HEIGHT = 36;

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

  function fileTitle(file: { path: string; originalPath: string | null }): string {
    return file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  }
</script>

<section class="span-main" aria-label="提交历史" aria-busy={loading}>
  <div class="panel-toolbar">
    {#if filePath}
      <button type="button" class="ghost compact" onclick={onClearFile}>返回全部历史</button>
      <span class="hint" title={filePath}>文件历史：{filePath}</span>
    {:else}
      <input
        class="search"
        aria-label="搜索全部历史"
        placeholder="说明、作者或提交标识"
        value={query}
        oninput={(event) => scheduleSearch((event.currentTarget as HTMLInputElement).value)}
      />
    {/if}
    <button type="button" class="ghost compact" disabled={offset === 0 || loading} onclick={pageBack}>上一页</button>
    <button type="button" class="ghost compact" disabled={!page?.hasMore || loading} onclick={pageForward}>下一页</button>
    <span class="hint">每页 {page?.pageSize ?? 100} 条{page ? ` · 从 ${page.offset + 1} 起` : ""}</span>
  </div>
  {#if listError}
    <div class="banner" role="alert">{listError}</div>
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
        <div class="empty" role="status"><strong>正在读取历史</strong></div>
      {:else if statusText}
        <div class="empty" role="status"><strong>{statusText}</strong></div>
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
              style={`top:${(range.start + index) * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
              onclick={() => pick(commit.oid)}
            >
              <span class="file-path" title={commit.oid}>{shortOid(commit.oid)} {commit.summary}</span>
              <span class="hint">{commit.authorName} · {formatAuthoredAt(commit.authoredAt)} · {parentCaption(commit.parents)}</span>
              {#if commit.labels.length > 0}
                <span class="chip-row">
                  {#each commit.labels as label (`${label.kind}:${label.name}`)}
                    <span class="chip" class:current={label.current}>{refLabel(label.kind, label.name, label.current)}</span>
                  {/each}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="history-detail">
      {#if detailError}
        <div class="banner" role="alert">{detailError}</div>
      {/if}
      {#if detail}
        <div class="history-meta">
          <strong title={detail.commit.oid}>{shortOid(detail.commit.oid)} {detail.commit.summary}</strong>
          <p class="hint">{detail.commit.authorName} &lt;{detail.commit.authorEmail}&gt; · {formatAuthoredAt(detail.commit.authoredAt)}</p>
          <p>{parentCaption(detail.commit.parents, detail.root)}</p>
          {#if detail.body.trim()}
            <pre class="commit-body">{detail.body}</pre>
          {/if}
          {#if detail.merge}
            <div class="row" role="group" aria-label="选择父提交">
              {#each detail.commit.parents as parent (parent)}
                <button
                  type="button"
                  class="theme-btn"
                  aria-pressed={(parentChoice ?? detail.selectedParent) === parent}
                  onclick={() => (parentChoice = parent)}
                >
                  相对 {shortOid(parent)}
                </button>
              {/each}
            </div>
          {/if}
          {#if detail.files.length === 0}
            <p class="hint">这次提交没有文件变化。</p>
          {:else}
            <div
              class="file-list history-files"
              role="listbox"
              aria-label="提交中的文件"
              tabindex="0"
              bind:clientHeight={fileViewport}
              onscroll={(event) => (fileScroll = event.currentTarget.scrollTop)}
            >
              <div class="virtual-space" style={`height:${detail.files.length * FILE_ROW_HEIGHT}px`}>
                {#each visibleFiles as file, index (`${file.status}:${file.path}`)}
                  <button
                    type="button"
                    class="file-row"
                    role="option"
                    aria-selected={activeFile?.path === file.path}
                    style={`top:${(fileRange.start + index) * FILE_ROW_HEIGHT}px;height:${FILE_ROW_HEIGHT}px`}
                    title={fileTitle(file)}
                    onclick={() => (manualPath = file.path)}
                  >
                    <span class="badge">{commitFileLabel(file.status)}</span>
                    <span class="file-path">{fileTitle(file)}</span>
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
          <strong>未选择提交</strong>
          <p>选择左侧一条记录后，这里显示其中的文件和差异。查看不会改变当前分支、暂存区或工作区。</p>
        </div>
      {/if}
    </div>
  </div>
</section>
