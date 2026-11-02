<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { commitFileLabel } from "../history";
  import type { CommitDetail, DiffHunk, DiffResponse, FileSelection, OpenedRepository } from "../types";
  import { splitPath, statusMark } from "../ui";
  import DiffView from "./DiffView.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    opened: OpenedRepository;
    detail: CommitDetail;
    parent: string | null;
    /** 从左侧文件列表点选的文件：展开并滚动到它。 */
    focusPath?: string | null;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onFileHistory: (path: string) => void;
  }

  let { opened, detail, parent, focusPath = null, disabled, nextId, onGeneration, onFailure, onFileHistory }: Props = $props();
  let scroller = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const path = focusPath;
    const host = scroller;
    if (!path || !host) return;
    if (!expandedPaths.includes(path)) expandedPaths = [...expandedPaths, path];
    queueMicrotask(() => {
      const target = [...host.querySelectorAll<HTMLElement>("[data-path]")].find((node) => node.dataset.path === path);
      target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    });
  });

  let expandedPaths = $state<string[]>([]);
  let fileDiffs = $state<Record<string, DiffResponse>>({});
  let fileErrors = $state<Record<string, string | null>>({});
  let fileLoading = $state<Record<string, boolean>>({});
  let loadedKey = "";
  const requested = new Set<string>();

  let loadedCount = $derived(expandedPaths.filter((path) => fileDiffs[path]).length);

  $effect(() => {
    const key = `${opened.summary.path}:${detail.commit.oid}:${parent ?? ""}:${opened.generation}`;
    if (key === loadedKey) return;
    loadedKey = key;
    requested.clear();
    expandedPaths = detail.files.map((file) => file.path);
    fileDiffs = {};
    fileErrors = {};
    fileLoading = {};
  });

  $effect(() => {
    const base = loadedKey;
    if (!base) return;
    for (const path of expandedPaths) {
      const key = `${base}:${path}`;
      if (requested.has(key)) continue;
      requested.add(key);
      void loadDiff(path, base, key);
    }
  });

  async function loadDiff(path: string, base: string, key: string) {
    const generation = opened.generation;
    fileLoading[path] = true;
    fileErrors[path] = null;
    try {
      const result = await api.commitFileDiff(opened.summary.path, detail.commit.oid, parent, path, generation, nextId(), 0, 0);
      if (loadedKey !== base || requested.has(key) === false) return;
      fileDiffs[path] = result;
      if (result.generation !== generation) onGeneration(result.generation);
    } catch (error) {
      if (loadedKey !== base) return;
      const failure = normalizeError(error);
      fileErrors[path] = failure.message;
      onFailure(failure);
    } finally {
      if (loadedKey === base) fileLoading[path] = false;
    }
  }

  function toggle(path: string) {
    expandedPaths = expandedPaths.includes(path) ? expandedPaths.filter((item) => item !== path) : [...expandedPaths, path];
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
      if (loadedKey !== base) return;
      const baseLines = current.lines.length;
      fileDiffs[path] = {
        ...result,
        offset: current.offset,
        lines: [...current.lines, ...result.lines],
        hunks: mergeHunks(current.hunks, result.hunks, baseLines),
        totalLines: result.totalLines,
      };
    } catch (error) {
      const failure = normalizeError(error);
      fileErrors[path] = failure.message;
      onFailure(failure);
    } finally {
      if (loadedKey === base) fileLoading[path] = false;
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
  <div class="history-multi-scroll" bind:this={scroller}>
    {#if detail.files.length === 0}
      <div class="empty"><span class="empty-icon"><Icon name="file" size={22} /></span><strong>这次提交没有文件变化</strong></div>
    {:else if expandedPaths.length === 0}
      <div class="empty compact multi-collapsed-empty"><span class="empty-icon"><Icon name="layers" size={22} /></span><strong>所有文件已收起</strong><p>点击“展开全部”连续查看整次提交，或从下方选择单个文件。</p></div>
    {/if}
    <div class="history-multi-list">
      {#each detail.files as file (file.path)}
        {@const expanded = expandedPaths.includes(file.path)}
        {@const mark = statusMark(commitFileLabel(file.status))}
        {@const parts = splitPath(file.path)}
        <article class="multi-file" class:expanded data-path={file.path} class:focused={focusPath === file.path}>
          <div class="multi-file-head">
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
