<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { commitFileLabel } from "../history";
  import type { CommitDetail, DiffHunk, DiffResponse, FileSelection, OpenedRepository } from "../types";
  import { blockTops, blockWindow, splitPath, statusMark } from "../ui";
  import DiffView from "./DiffView.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    opened: OpenedRepository;
    active?: boolean;
    detail: CommitDetail;
    parent: string | null;
    /** 从左侧文件列表点选的文件：展开并滚动到它。 */
    focusPath?: string | null;
    /** 用户滚动到另一个文件：左侧列表跟过去，下一次切换从这里继续。 */
    onFocusPath?: (path: string) => void;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onFileHistory: (path: string) => void;
  }

  let { opened, active = true, detail, parent, focusPath = null, onFocusPath, disabled, nextId, onGeneration, onFailure, onFileHistory }: Props = $props();
  const MAX_CONCURRENT = 2;
  const MAX_CACHED = 24;
  const HEAD_HEIGHT = 42;
  const DIFF_HEIGHT = 420;
  const GAP = 11;
  let scroller = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  let spying = false;
  let followed: string | null = null;
  let expandedPaths = $state.raw<string[]>([]);
  let expandedSet = $derived(new Set(expandedPaths));
  let fileDiffs = $state.raw<Record<string, DiffResponse>>({});
  let fileErrors = $state<Record<string, string | null>>({});
  let fileLoading = $state<Record<string, boolean>>({});
  let loadedKey = $state("");
  const requested = new Set<string>();
  const cached: string[] = [];
  let running = 0;
  let destroyed = false;
  let tops = $derived(blockTops(detail.files.map((file) => HEAD_HEIGHT + (expandedSet.has(file.path) ? DIFF_HEIGHT : 0)), GAP));
  let span = $derived(blockWindow(tops, scrollTop, viewport || 600, 500));
  let shown = $derived(detail.files.slice(span.start, span.end));
  let loadedCount = $derived(Object.keys(fileDiffs).filter((path) => expandedSet.has(path)).length);

  $effect(() => {
    if (!active) return;
    const key = `${opened.summary.path}:${detail.commit.oid}:${parent ?? ""}:${opened.generation}`;
    if (key === loadedKey) return;
    loadedKey = key;
    requested.clear();
    cached.length = 0;
    expandedPaths = detail.files.map((file) => file.path);
    fileDiffs = {};
    fileErrors = {};
    fileLoading = {};
  });

  function follow() {
    const host = scroller;
    if (!spying || !host) return;
    const top = host.getBoundingClientRect().top + 1;
    let path: string | null = null;
    for (const node of host.querySelectorAll<HTMLElement>("[data-path]")) {
      if (node.getBoundingClientRect().top > top) break;
      path = node.dataset.path ?? null;
    }
    if (!path || path === focusPath) return;
    followed = path;
    onFocusPath?.(path);
  }

  // 定位先移动虚拟窗口，再等待 DOM 更新；折叠和滚动上报不会重新展开。
  $effect(() => {
    const path = focusPath;
    untrack(() => {
      const host = scroller;
      const reported = path === followed;
      followed = null;
      if (!path || !host || reported) return;
      const index = detail.files.findIndex((file) => file.path === path);
      if (index < 0) return;
      spying = false;
      if (!expandedSet.has(path)) expandedPaths = [...expandedPaths, path];
      scrollTop = tops[index];
      host.scrollTop = scrollTop;
      void tick().then(() => {
        if (destroyed) return;
        const target = [...host.querySelectorAll<HTMLElement>("[data-path]")].find((node) => node.dataset.path === path);
        target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      });
    });
  });

  function pump() {
    if (destroyed || !active || !loadedKey) return;
    const base = loadedKey;
    for (const file of shown) {
      if (running >= MAX_CONCURRENT) return;
      if (!expandedSet.has(file.path) || requested.has(file.path)) continue;
      requested.add(file.path);
      void loadDiff(file.path, base);
    }
  }

  $effect(() => {
    void active;
    void loadedKey;
    void shown;
    void expandedSet;
    untrack(pump);
  });

  async function loadDiff(path: string, base: string) {
    const generation = opened.generation;
    running += 1;
    fileLoading[path] = true;
    fileErrors[path] = null;
    try {
      const result = await api.commitFileDiff(opened.summary.path, detail.commit.oid, parent, path, generation, nextId(), 0, 0);
      if (destroyed || loadedKey !== base) return;
      fileDiffs = { ...fileDiffs, [path]: result };
      cached.push(path);
      // 只保留最近查看的差异，避免滚完几万个文件后全部留在内存里。
      while (cached.length > MAX_CACHED) {
        const oldest = cached.shift()!;
        const { [oldest]: removed, ...rest } = fileDiffs;
        fileDiffs = rest;
        requested.delete(oldest);
        delete fileErrors[oldest];
        delete fileLoading[oldest];
      }
      if (result.generation !== generation) onGeneration(result.generation);
    } catch (error) {
      if (destroyed || loadedKey !== base) return;
      const failure = normalizeError(error);
      fileErrors[path] = failure.message;
      onFailure(failure);
    } finally {
      running -= 1;
      if (!destroyed && loadedKey === base) fileLoading[path] = false;
      pump();
    }
  }

  onDestroy(() => { destroyed = true; });

  function toggle(path: string) {
    expandedPaths = expandedSet.has(path) ? expandedPaths.filter((item) => item !== path) : [...expandedPaths, path];
  }

  function selection(path: string): FileSelection {
    return { path, side: "unstaged" };
  }

  async function loadMore(path: string) {
    const current = fileDiffs[path];
    if (!current || fileLoading[path] || disabled || current.offset + current.lines.length >= current.totalLines) return;
    const base = loadedKey;
    const generation = opened.generation;
    fileLoading[path] = true;
    try {
      const result = await api.commitFileDiff(
        opened.summary.path,
        detail.commit.oid,
        parent,
        path,
        generation,
        nextId(),
        current.offset + current.lines.length,
        400,
      );
      if (destroyed || loadedKey !== base) return;
      const baseLines = current.lines.length;
      fileDiffs = { ...fileDiffs, [path]: {
        ...result,
        offset: current.offset,
        lines: [...current.lines, ...result.lines],
        hunks: mergeHunks(current.hunks, result.hunks, baseLines),
        totalLines: result.totalLines,
      } };
    } catch (error) {
      if (destroyed || loadedKey !== base) return;
      const failure = normalizeError(error);
      fileErrors[path] = failure.message;
      onFailure(failure);
    } finally {
      if (!destroyed && loadedKey === base) fileLoading[path] = false;
    }
  }

  function mergeHunks(current: DiffHunk[], extra: DiffHunk[], base: number): DiffHunk[] {
    const merged = new Map(current.map((hunk) => [hunk.index, hunk]));
    for (const hunk of extra) {
      if (!merged.has(hunk.index)) merged.set(hunk.index, { ...hunk, startLine: hunk.startLine + base });
    }
    return [...merged.values()];
  }
</script>

<section class="history-multi" aria-label="多文件差异">
  <div class="history-multi-head">
    <div><strong>全部文件</strong><span>已展开 {expandedPaths.length} / {detail.files.length} 个，已加载 {loadedCount} 个</span></div>
    <div class="row">
      <button type="button" class="btn btn-ghost btn-sm" title={expandedPaths.length === detail.files.length ? "已经全部展开" : undefined} disabled={expandedPaths.length === detail.files.length} onclick={() => (expandedPaths = detail.files.map((file) => file.path))}><Icon name="plus" size={12} />展开全部</button>
      <button type="button" class="btn btn-ghost btn-sm" title={expandedPaths.length === 0 ? "已经全部收起" : undefined} disabled={expandedPaths.length === 0} onclick={() => (expandedPaths = [])}><Icon name="minus" size={12} />全部收起</button>
    </div>
  </div>
  <div
    class="history-multi-scroll"
    role="presentation"
    bind:this={scroller}
    bind:clientHeight={viewport}
    onscroll={() => { scrollTop = scroller?.scrollTop ?? 0; follow(); }}
    onwheel={() => (spying = true)}
    onpointerdown={() => (spying = true)}
    onkeydown={() => (spying = true)}
  >
    {#if detail.files.length === 0}
      <div class="empty"><span class="empty-icon"><Icon name="file" size={22} /></span><strong>这次提交没有文件变化</strong></div>
    {:else if expandedPaths.length === 0}
      <div class="empty compact multi-collapsed-empty"><span class="empty-icon"><Icon name="layers" size={22} /></span><strong>所有文件已收起</strong><p>点击“展开全部”连续查看整次提交，或从下方选择单个文件。</p></div>
    {/if}
    <div class="history-multi-list" style={`padding-top:${span.before}px;padding-bottom:${span.after}px`}>
      {#each shown as file (file.path)}
        {@const expanded = expandedSet.has(file.path)}
        {@const mark = statusMark(commitFileLabel(file.status))}
        {@const parts = splitPath(file.path)}
        <article class="multi-file" style={`height:${HEAD_HEIGHT + (expanded ? DIFF_HEIGHT : 0)}px;flex:none`} class:expanded data-path={file.path} class:focused={focusPath === file.path}>
          <div class="multi-file-head" style="height:40px;min-height:40px">
            <button type="button" class="multi-file-toggle" aria-label={`${expanded ? "收起" : "展开"} ${file.path}`} aria-expanded={expanded} onclick={() => toggle(file.path)}>
              <span class={`st ${mark.tone}`}>{mark.letter}</span>
              <span class="multi-file-name"><strong>{parts.name}</strong>{#if parts.dir}<small>{parts.dir}</small>{/if}</span>
              <span class="chip">{commitFileLabel(file.status)}</span>
              <Icon name="chevron-down" size={13} class={expanded ? "flip" : ""} />
            </button>
            <button type="button" class="icon-btn sm" aria-label={`查看 ${file.path} 的文件历史`} title="查看此文件历史" onclick={() => onFileHistory(file.path)}><Icon name="history" size={13} /></button>
          </div>
          {#if expanded}
            <div class="multi-file-diff">
              <DiffView
                selection={selection(file.path)}
                diff={fileDiffs[file.path] ?? null}
                error={fileErrors[file.path] ?? null}
                loading={fileLoading[file.path] ?? false}
                {disabled}
                readOnly={true}
                onStageHunk={() => {}}
                onLoadMore={() => loadMore(file.path)}
                onFileHistory={onFileHistory}
              />
            </div>
          {/if}
        </article>
      {/each}
    </div>
  </div>
</section>
