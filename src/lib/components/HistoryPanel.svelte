<script lang="ts">
  import type { Snippet } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import {
    commitFileLabel,
    formatAuthoredAt,
    HISTORY_SEARCH_DEBOUNCE_MS,
    historyStatus,
    parentCaption,
    commitBodyRest,
    preferredCommitFile,
    refPills,
    shortOid,
  } from "../history";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import type {
    CommitDetail,
    DiffHunk,
    DiffResponse,
    FileSelection,
    HistoryCommit,
    HistoryPage,
    OpenedRepository,
    StatusSnapshot,
  } from "../types";
  import { BUSY_REASON, fileNavState, hueOf, initialOf, relativeTime, splitPath, statusMark, type FileNavState } from "../ui";
  import CommitDiffList from "./CommitDiffList.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest, isContextKey, pointFor } from "./ContextMenu.svelte";
  import DiffView from "./DiffView.svelte";
  import FileNav from "./FileNav.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    opened: OpenedRepository;
    filePath: string | null;
    searchQuery?: string;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onFilePath: (path: string) => void;
    onClearFile: () => void;
    /** 从某个提交新建分支后回写最新状态（切换时工作区与分支都会变）。 */
    onSnapshot?: (snapshot: StatusSnapshot) => void;
    onNotice?: (message: string) => void;
    /** 变更文件的上一个/下一个状态：外壳据此响应 file.prev、file.next。 */
    onFileNav?: (nav: FileNavState | null) => void;
    /** 左栏头部（视图切换与合并提示）和右沿拖动条：由外壳提供，与改动视图是同一份。 */
    paneHead?: Snippet;
    paneResizer?: Snippet;
  }

  const ROW_HEIGHT = 60;
  const FILE_ROW_HEIGHT = 44;

  let {
    opened,
    filePath,
    searchQuery = "",
    disabled,
    nextId,
    onGeneration,
    onFailure,
    onFilePath,
    onClearFile,
    onSnapshot,
    onNotice,
    onFileNav,
    paneHead,
    paneResizer,
  }: Props = $props();

  let menu = $state<ContextMenuRequest | null>(null);
  /** 「从此提交新建分支」的输入层。 */
  let branchFrom = $state<{ oid: string; summary: string; name: string; checkout: boolean; busy: boolean; error: string | null } | null>(null);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      onFailure({ code: "clipboard", message: "无法写入剪贴板，请手动复制。" });
    }
  }

  function commitMenu(commit: HistoryCommit, point: { x: number; y: number }) {
    const entries: ContextMenuEntry[] = [
      {
        id: "branch",
        label: "从此提交新建分支…",
        icon: "branch",
        disabledReason: disabled ? "正在读取或写入，稍后再试" : undefined,
        run: () => (branchFrom = { oid: commit.oid, summary: commit.summary, name: "", checkout: true, busy: false, error: null }),
      },
      { separator: true },
      { id: "hash", label: "复制完整 Hash", icon: "copy", run: () => void copyOid(commit.oid) },
      { id: "short", label: `复制短 Hash（${shortOid(commit.oid)}）`, icon: "copy", run: () => void copyText(shortOid(commit.oid)) },
      { id: "summary", label: "复制提交说明", icon: "copy", run: () => void copyText(commit.summary) },
      {
        id: "author",
        label: `复制作者（${commit.authorName}）`,
        icon: "user",
        run: () => void copyText(`${commit.authorName} <${commit.authorEmail}>`),
      },
    ];
    menu = { x: point.x, y: point.y, entries, label: `提交 ${shortOid(commit.oid)} 的操作` };
  }

  async function confirmBranchFrom() {
    const target = branchFrom;
    if (!target || target.busy) return;
    const name = target.name.trim();
    if (!name) return;
    branchFrom = { ...target, busy: true, error: null };
    try {
      const result = await api.createBranchFrom(opened.summary.path, name, target.oid, target.checkout, opened.generation, nextId());
      onGeneration(result.generation);
      onSnapshot?.(result.snapshot);
      onNotice?.(
        target.checkout
          ? `已从 ${shortOid(target.oid)} 创建并切换到 ${name}。`
          : `已从 ${shortOid(target.oid)} 创建分支 ${name}，当前分支没有切换。`,
      );
      branchFrom = null;
    } catch (error) {
      const failure = normalizeError(error);
      onFailure(failure);
      if (branchFrom) branchFrom = { ...target, busy: false, error: failure.message };
    }
  }

  let query = $state("");
  let viewMode = $state<"single" | "multi">("single");
  let activeQuery = $state("");
  let lastSearchSeed = "";
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
  let fileListEl = $state<HTMLDivElement | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFile: string | null | undefined = undefined;

  let commits = $derived(page?.commits ?? []);
  let range = $derived(
    visibleRange(commits.length, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let visible = $derived(commits.slice(range.start, range.end));
  let activeFile = $derived(detail ? preferredCommitFile(detail.files, manualPath ?? filePath) : null);
  let fileFilter = $state("");
  let bodyOpen = $state(false);
  let bodyEl = $state<HTMLElement | null>(null);
  /** 折叠的说明是否真的被截断：只看实际溢出，所以随宽度变化重算，放得下时不给入口。 */
  let bodyClipped = $state(false);
  /** 窄详情里文件列表在差异上方，可以收起，把高度全给差异。宽详情里没有这个开关。 */
  let filesCollapsed = $state(false);
  /** 「全部文件」模式下从左侧点选的文件：右侧滚动到它。 */
  let multiFocus = $state<string | null>(null);
  let filteredFiles = $derived(
    (detail?.files ?? []).filter((file) => {
      const needle = fileFilter.trim().toLowerCase();
      return !needle || file.path.toLowerCase().includes(needle) || (file.originalPath ?? "").toLowerCase().includes(needle);
    }),
  );
  let fileCounts = $derived({
    added: (detail?.files ?? []).filter((file) => file.status === "added").length,
    modified: (detail?.files ?? []).filter((file) => file.status !== "added" && file.status !== "deleted").length,
    deleted: (detail?.files ?? []).filter((file) => file.status === "deleted").length,
  });
  let bodyRest = $derived(detail ? commitBodyRest(detail.body, detail.commit.summary) : "");
  let fileRange = $derived(
    visibleRange(
      filteredFiles.length,
      fileScroll,
      fileViewport > 0 ? fileViewport : fileScroll > 0 ? FILE_ROW_HEIGHT : 0,
      FILE_ROW_HEIGHT,
    ),
  );
  let visibleFiles = $derived(filteredFiles.slice(fileRange.start, fileRange.end));
  /* 按筛选后的列表走，与左侧看到的顺序一致；「全部文件」模式还没点选时算在第一个。 */
  let currentPath = $derived(viewMode === "single" ? activeFile?.path : (multiFocus ?? filteredFiles[0]?.path));
  let fileIndex = $derived(filteredFiles.findIndex((file) => file.path === currentPath));
  let fileNav = $derived(detail ? fileNavState(filteredFiles, fileIndex, (file) => goToFile(file.path)) : null);

  $effect(() => {
    onFileNav?.(fileNav);
    return () => onFileNav?.(null);
  });

  $effect(() => {
    const element = bodyEl;
    void bodyRest;
    const row = element?.parentElement;
    if (!element || !row || bodyOpen) return;
    // 和整行比，不和说明自身比：入口按钮占着宽度时，说明自身窄，变宽后放得下也量不出来。
    const measure = () => {
      bodyClipped = element.scrollWidth > row.clientWidth + 1;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(row);
    return () => observer?.disconnect();
  });

  let statusText = $derived(page && commits.length === 0 ? historyStatus(page.state) : null);
  let diffSelection = $derived<FileSelection | null>(
    activeFile ? { path: activeFile.path, side: "unstaged" } : null,
  );

  $effect(() => {
    const seed = searchQuery;
    if (seed === lastSearchSeed) return;
    lastSearchSeed = seed;
    query = seed;
    activeQuery = seed;
    offset = 0;
    selectedOid = null;
    parentChoice = null;
    manualPath = null;
  });

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
    multiFocus = null;
    fileFilter = "";
    bodyOpen = false;
  }

  function chooseFile(path: string) {
    if (viewMode === "multi") multiFocus = path;
    else manualPath = path;
  }

  /** 单文件与全部文件之间切换时带上当前文件，列表高亮和差异位置都不丢。 */
  function useMode(next: "single" | "multi") {
    if (next === viewMode) return;
    if (next === "multi") multiFocus = activeFile?.path ?? null;
    else if (multiFocus) manualPath = multiFocus;
    viewMode = next;
  }

  function goToFile(path: string) {
    chooseFile(path);
    const index = filteredFiles.findIndex((file) => file.path === path);
    const height = fileViewport > 0 ? fileViewport : (fileListEl?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, fileScroll, height, FILE_ROW_HEIGHT);
    fileScroll = next;
    if (fileListEl) fileListEl.scrollTop = next;
  }

  function reveal(index: number) {
    const height = viewport > 0 ? viewport : (list?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, scrollTop, height, ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  function onListKey(event: KeyboardEvent) {
    const current = commits.findIndex((commit) => commit.oid === selectedOid);
    if (isContextKey(event) && current >= 0) {
      event.preventDefault();
      const row = (event.currentTarget as HTMLElement).querySelector('.history-row[aria-selected="true"]');
      commitMenu(commits[current], row ? pointFor(row) : { x: 160, y: 160 });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
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


  function fileTitle(file: { path: string; originalPath: string | null }): string {
    return file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  }
</script>

<section class="history-view" aria-label="提交历史" aria-busy={loading}>
  <div class="history-layout">
    <aside class="pane history-pane" aria-label="提交列表">
      {@render paneHead?.()}
      <div class="history-tools">
        {#if filePath}
          <button type="button" class="btn btn-ghost btn-sm" onclick={onClearFile}>
            <Icon name="arrow-left" size={14} />返回全部历史
          </button>
          <span class="history-file-scope" title={filePath}><Icon name="file" size={13} /><span class="truncate">{filePath}</span></span>
        {:else}
          <div class="field sm history-search">
            <Icon name="search" size={14} />
            <input
              aria-label="搜索全部历史"
              placeholder="搜索说明、作者或提交 Hash"
              autocomplete="off"
              spellcheck="false"
              value={query}
              oninput={(event) => scheduleSearch((event.currentTarget as HTMLInputElement).value)}
            />
            {#if loading}<span class="spinner"></span>{/if}
          </div>
        {/if}
      </div>
      {#if listError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{listError}</span></div>
      {/if}
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
          <div class="empty" role="status"><span class="empty-icon"><span class="spinner"></span></span><strong>正在读取历史</strong></div>
        {:else if statusText}
          <div class="empty" role="status">
            <span class="empty-icon"><Icon name={page?.state === "no_match" ? "search" : page?.state === "no_file_history" ? "file" : "commit"} size={22} /></span>
            <strong>{statusText}</strong>
          </div>
        {:else if commits.length === 0}
          <div class="empty" role="status"><span class="empty-icon"><Icon name="history" size={22} /></span><strong>这一页没有提交。</strong></div>
        {:else}
          <div class="virtual-space" style={`height:${commits.length * ROW_HEIGHT}px`}>
            {#each visible as commit, index (commit.oid)}
              {@const pills = refPills(commit.labels)}
              <div
                class="history-row"
                role="option"
                aria-selected={selectedOid === commit.oid}
                tabindex="-1"
                style={`top:${(range.start + index) * ROW_HEIGHT}px;height:${ROW_HEIGHT - 4}px`}
                title={`${commit.summary}\n${commit.authorName} · ${formatAuthoredAt(commit.authoredAt)}\n${commit.oid}`}
                onclick={() => pick(commit.oid)}
                oncontextmenu={(event) => {
                  event.preventDefault();
                  pick(commit.oid);
                  commitMenu(commit, { x: event.clientX, y: event.clientY });
                }}
                onkeydown={(event) => {
                  if (isContextKey(event)) {
                    event.preventDefault();
                    commitMenu(commit, pointFor(event.currentTarget));
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    pick(commit.oid);
                  }
                }}
              >
                <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
                <span class="hr-main">
                  <span class="hr-line">
                    <span class="hr-summary">{commit.summary}</span>
                    <code class="hr-hash">{shortOid(commit.oid)}</code>
                  </span>
                  <span class="hr-meta">
                    {#each pills.slice(0, 2) as pill (`${pill.kind}:${pill.name}`)}
                      <span class={`ref-pill ${pill.kind}`} class:current={pill.current} title={pill.label} aria-label={pill.label}>
                        <Icon name={pill.kind === "tag" ? "tag" : pill.kind === "remote" ? "cloud" : "branch"} size={11} />
                        <span>{pill.name}</span>
                        {#if pill.remote}<Icon name="cloud" size={10} />{/if}
                      </span>
                    {/each}
                    {#if pills.length > 2}<span class="ref-more" title={pills.slice(2).map((pill) => pill.label).join("\n")}>+{pills.length - 2}</span>{/if}
                    <span class="hr-author">{commit.authorName}</span>
                    <span class="hr-dot"></span>
                    <span class="hr-time">{relativeTime(commit.authoredAt)}</span>
                    {#if commit.parents.length > 1}
                      <span class="hr-merge" title={parentCaption(commit.parents)}><Icon name="merge" size={11} />合并</span>
                    {/if}
                  </span>
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
      <div class="pager history-pager">
        <span class="pager-range">
          {#if page && commits.length > 0}{page.offset + 1}–{page.offset + commits.length}{:else}—{/if}
        </span>
        <span class="spacer"></span>
        <button type="button" class="icon-btn sm" aria-label="上一页" title="上一页" disabled={offset === 0 || loading} onclick={pageBack}>
          <Icon name="chevron-left" size={15} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="下一页" title="下一页" disabled={!page?.hasMore || loading} onclick={pageForward}>
          <Icon name="chevron-right" size={15} />
        </button>
      </div>
    </aside>
    {@render paneResizer?.()}
    <div class="history-detail">
      {#if detailError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{detailError}</span></div>
      {/if}
      {#if detail}
        {@const pills = refPills(detail.commit.labels)}
        <header class="commit-head">
          <div class="commit-head-main">
            <h2 class="commit-title">{detail.commit.summary}</h2>
            {#if bodyRest}
              <div class="commit-body-row" class:open={bodyOpen}>
                <pre class="commit-body" class:clamped={!bodyOpen} bind:this={bodyEl}>{bodyRest}</pre>
                {#if bodyOpen || bodyClipped}
                  <button type="button" class="btn btn-ghost btn-sm commit-body-toggle" onclick={() => (bodyOpen = !bodyOpen)}>
                    <Icon name="chevron-down" size={12} class={bodyOpen ? "flip" : ""} />{bodyOpen ? "收起说明" : "展开完整说明"}
                  </button>
                {/if}
              </div>
            {/if}
            <div class="commit-byline">
              <span class="avatar" style={`--hue:${hueOf(detail.commit.authorName)}`} aria-hidden="true">{initialOf(detail.commit.authorName)}</span>
              <strong>{detail.commit.authorName}</strong>
              <span class="commit-email">{detail.commit.authorEmail}</span>
              <span title={formatAuthoredAt(detail.commit.authoredAt)}>{relativeTime(detail.commit.authoredAt)} · {formatAuthoredAt(detail.commit.authoredAt)}</span>
              <span class="commit-parents">{parentCaption(detail.commit.parents, detail.root)}</span>
              {#each pills as pill (`${pill.kind}:${pill.name}`)}
                <span class={`ref-pill ${pill.kind}`} class:current={pill.current} title={pill.label} aria-label={pill.label}>
                  <Icon name={pill.kind === "tag" ? "tag" : pill.kind === "remote" ? "cloud" : "branch"} size={11} />
                  <span>{pill.name}</span>
                  {#if pill.remote}<Icon name="cloud" size={10} />{/if}
                </span>
              {/each}
            </div>
          </div>
          <div class="commit-facts">
            {#if viewMode === "multi" && fileNav}<FileNav nav={fileNav} />{/if}
            <div class="segmented history-view-mode" role="group" aria-label="历史差异模式">
              <button type="button" aria-pressed={viewMode === "single"} title="一次看一个文件" onclick={() => useMode("single")}><Icon name="file" size={12} />单文件</button>
              <button type="button" aria-pressed={viewMode === "multi"} title="连续查看整次提交的全部文件" onclick={() => useMode("multi")}><Icon name="layers" size={12} />全部文件</button>
            </div>
            <span class="oid-chip" title={detail.commit.oid}>
              <Icon name="commit" size={12} />
              {shortOid(detail.commit.oid)}
              <button type="button" aria-label="复制完整提交标识" title={copiedOid === detail.commit.oid ? "已复制" : "复制完整提交标识"} onclick={() => copyOid(detail?.commit.oid ?? "")}>
                <Icon name={copiedOid === detail.commit.oid ? "check" : "copy"} size={12} />
              </button>
            </span>
          </div>
          {#if detail.merge}
            <div class="commit-compare">
              <span>比较对象</span>
              <div class="segmented" role="group" aria-label="选择父提交">
                {#each detail.commit.parents as parent, index (parent)}
                  <button
                    type="button"
                    aria-pressed={(parentChoice ?? detail.selectedParent) === parent}
                    title={index === 0 ? "相对合并前的主线：看这次合并带进来了什么" : "相对被合并的分支：看合并时主线这边有什么不同"}
                    onclick={() => (parentChoice = parent)}
                  >
                    {index === 0 ? "主线" : `第 ${index + 1} 个父提交`} · {shortOid(parent)}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </header>
        <div class="commit-split">
          <aside class="commit-files" class:collapsed={filesCollapsed} aria-label="提交中的文件">
            <div class="commit-files-head">
              <span>变更文件</span>
              <span class="count">{detail.files.length}</span>
              <button
                type="button"
                class="icon-btn sm commit-files-toggle"
                aria-expanded={!filesCollapsed}
                aria-label={filesCollapsed ? "展开变更文件" : "收起变更文件"}
                title={filesCollapsed ? "展开变更文件" : "收起变更文件"}
                onclick={() => (filesCollapsed = !filesCollapsed)}
              >
                <Icon name="chevron-down" size={13} class={filesCollapsed ? "" : "flip"} />
              </button>
              <span class="spacer"></span>
              {#if fileCounts.added > 0}<span class="file-tally add" title="新增">+{fileCounts.added}</span>{/if}
              {#if fileCounts.modified > 0}<span class="file-tally mod" title="修改">~{fileCounts.modified}</span>{/if}
              {#if fileCounts.deleted > 0}<span class="file-tally del" title="删除">−{fileCounts.deleted}</span>{/if}
            </div>
            {#if detail.files.length > 8}
              <div class="commit-files-filter">
                <div class="field sm">
                  <Icon name="search" size={13} />
                  <input aria-label="筛选提交中的文件" placeholder="筛选文件" autocomplete="off" spellcheck="false" bind:value={fileFilter} />
                </div>
              </div>
            {/if}
            {#if detail.files.length === 0}
              <p class="commit-files-empty">这次提交没有文件变化。</p>
            {:else if filteredFiles.length === 0}
              <p class="commit-files-empty">没有匹配的文件。</p>
            {:else}
              <div
                class="file-list history-files"
                role="listbox"
                aria-label="提交中的文件列表"
                tabindex="0"
                bind:this={fileListEl}
                bind:clientHeight={fileViewport}
                onscroll={(event) => (fileScroll = event.currentTarget.scrollTop)}
              >
                <div class="virtual-space" style={`height:${filteredFiles.length * FILE_ROW_HEIGHT}px`}>
                  {#each visibleFiles as file, index (`${file.status}:${file.path}`)}
                    {@const mark = statusMark(commitFileLabel(file.status))}
                    {@const parts = splitPath(file.path)}
                    <button
                      type="button"
                      class="file-row"
                      role="option"
                      aria-selected={currentPath === file.path}
                      style={`top:${(fileRange.start + index) * FILE_ROW_HEIGHT + 2}px;height:${FILE_ROW_HEIGHT - 4}px`}
                      title={fileTitle(file)}
                      onclick={() => chooseFile(file.path)}
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
          </aside>
          <div class="commit-diff">
            {#if viewMode === "multi"}
              <CommitDiffList
                {opened}
                {detail}
                parent={parentChoice ?? detail.selectedParent}
                focusPath={multiFocus}
                onFocusPath={goToFile}
                {disabled}
                {nextId}
                {onGeneration}
                onFailure={onFailure}
                onFileHistory={onFilePath}
              />
            {:else}
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
                {fileNav}
              />
            {/if}
          </div>
        </div>
      {:else if !loading}
        <div class="empty" role="status">
          <span class="empty-icon"><Icon name="commit" size={24} /></span>
          <strong>未选择提交</strong>
          <p>选择左侧一条记录查看文件和差异。</p>
        </div>
      {/if}
    </div>
  </div>
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}

  {#if branchFrom}
    <Modal
      title="从此提交新建分支"
      titleId="branch-from-commit-title"
      icon="branch"
      size="sm"
      description={`起点：${shortOid(branchFrom.oid)} ${branchFrom.summary}`}
      locked={branchFrom.busy}
      onClose={() => (branchFrom = null)}
    >
      <label class="label" for="branch-from-name">分支名称</label>
      <input
        id="branch-from-name"
        class="input"
        data-autofocus
        placeholder="例如 hotfix/login"
        autocomplete="off"
        spellcheck="false"
        bind:value={branchFrom.name}
        title={branchFrom.busy ? BUSY_REASON : undefined}
        disabled={branchFrom.busy}
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void confirmBranchFrom();
          }
        }}
      />
      <label class="switch">
        <input type="checkbox" bind:checked={branchFrom.checkout} title={branchFrom.busy ? BUSY_REASON : undefined} disabled={branchFrom.busy} />
        <span>创建后切换过去</span>
      </label>
      <p class="hint">
        {branchFrom.checkout
          ? "切换沿用分支切换的保护：会覆盖未提交修改时停下，分支已创建但不切换。"
          : "只创建分支，当前分支和工作区都不变。"}
      </p>
      {#if branchFrom.error}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{branchFrom.error}</span></div>{/if}
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" title={branchFrom?.busy ? "写入完成后才能取消" : undefined} disabled={branchFrom?.busy} onclick={() => (branchFrom = null)}>取消</button>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn btn-primary"
          title={branchFrom?.busy ? BUSY_REASON : !branchFrom?.name.trim() ? "先填写分支名称" : undefined}
          disabled={branchFrom?.busy || !branchFrom?.name.trim()}
          onclick={confirmBranchFrom}
        >
          {#if branchFrom?.busy}<span class="spinner"></span>{:else}<Icon name="plus" size={14} />{/if}
          {branchFrom?.checkout ? "创建并切换" : "创建分支"}
        </button>
      {/snippet}
    </Modal>
  {/if}
</section>
