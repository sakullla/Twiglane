<script lang="ts">
  import { toSideRows, type ViewLine } from "../diff";
  import { scrollByRows, visibleRange } from "../layout";
  import type { DiffHunk, DiffResponse, FileSelection } from "../types";
  import { splitPath } from "../ui";
  import Icon from "./Icon.svelte";

  interface Props {
    selection: FileSelection | null;
    diff: DiffResponse | null;
    error: string | null;
    loading: boolean;
    disabled: boolean;
    readOnly?: boolean;
    onStageHunk: (hunk: DiffHunk) => void;
    onLoadMore: () => void;
    onFileHistory?: (path: string) => void;
  }

  /**
   * 行高 16px 是 R3 的硬约束：1280×840 下要让同屏差异至少完全可见 40 行。
   * 22px 的行高在扣掉标题栏、状态栏、差异工具栏与留白后只能放进 30 行左右，
   * 因此密度由这里和 `components.css` 的 `.diff.dense` 一起决定，两处必须同步。
   */
  const ROW_HEIGHT = 16;

  let {
    selection,
    diff,
    error,
    loading,
    disabled,
    readOnly = false,
    onStageHunk,
    onLoadMore,
    onFileHistory,
  }: Props = $props();
  let mode = $state<"unified" | "split">("unified");
  let scrollTop = $state(0);
  let viewport = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let selectionKey = $derived(selection ? `${selection.side}:${selection.path}` : "");
  let currentDiff = $derived(
    selection && diff?.path === selection.path && diff.staged === (selection.side === "staged") ? diff : null,
  );
  let lines = $derived<ViewLine[]>(currentDiff?.lines ?? []);
  let sideRows = $derived(mode === "split" ? toSideRows(lines) : []);
  let total = $derived(mode === "split" ? sideRows.length : lines.length);
  let range = $derived(
    visibleRange(total, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let hunkForLine = $derived((index: number) => currentDiff?.hunks.find((hunk) => hunk.startLine === index) ?? null);
  let parts = $derived(selection ? splitPath(selection.path) : null);
  let showStats = $derived(
    Boolean(currentDiff && !currentDiff.binary && (currentDiff.additions > 0 || currentDiff.deletions > 0)),
  );

  $effect(() => {
    selectionKey;
    applyScroll(0);
  });

  function applyScroll(next: number) {
    scrollTop = next;
    if (scroller) scroller.scrollTop = next;
  }

  function onDiffKey(event: KeyboardEvent) {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const height = viewport > 0 ? viewport : (scroller?.clientHeight ?? 0);
    if (event.key === "Home") {
      event.preventDefault();
      applyScroll(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      applyScroll(scrollByRows(0, total, total, height, ROW_HEIGHT));
      return;
    }
    const page = Math.max(1, height > 0 ? Math.floor(height / ROW_HEIGHT) : 1);
    const delta =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? page : event.key === "PageUp" ? -page : null;
    if (delta === null) return;
    event.preventDefault();
    applyScroll(scrollByRows(scrollTop, delta, total, height, ROW_HEIGHT));
  }

  function lineClass(kind: string): string {
    if (kind === "add") return "diff-line add";
    if (kind === "del") return "diff-line del";
    if (kind === "hunk" || kind === "meta" || kind === "nonewline") return "diff-line hunk";
    return "diff-line";
  }

  function hunkLabel(hunk: DiffHunk): string {
    if (!hunk.stageable) return "已截断";
    return selection?.side === "staged" ? "取消暂存此块" : "暂存此块";
  }
</script>

<section class="diff dense" aria-label="差异详情">
  <div class="diff-toolbar">
    <div class="diff-file">
      {#if selection && parts}
        <Icon name="file-diff" size={15} />
        <span class="diff-path" title={selection.path}>
          <bdi>{#if parts.dir}<span class="dir">{parts.dir}/</span>{/if}<strong>{parts.name}</strong></bdi>
        </span>
        {#if !readOnly}
          <span class="diff-side" class:staged={selection.side === "staged"}>
            {selection.side === "staged" ? "已暂存" : "未暂存"}
          </span>
        {/if}
        {#if showStats && currentDiff}
          <span class="diff-stats" aria-label={`新增 ${currentDiff.additions} 行，删除 ${currentDiff.deletions} 行`}>
            <span class="plus">+{currentDiff.additions}</span>
            <span class="minus">−{currentDiff.deletions}</span>
          </span>
        {/if}
        {#if currentDiff && !showStats}
          <span class="diff-summary" title={currentDiff.summary}>{currentDiff.summary}</span>
        {/if}
      {:else}
        <span class="hint">差异</span>
      {/if}
    </div>
    {#if loading && currentDiff}<span class="spinner muted" aria-hidden="true"></span>{/if}
    {#if onFileHistory && selection}
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        aria-label="此文件历史"
        title="查看这个文件的提交历史"
        onclick={() => onFileHistory?.(selection.path)}
      >
        <Icon name="history" size={14} /><span class="diff-hist-label">此文件历史</span>
      </button>
    {/if}
    <div class="segmented" role="group" aria-label="差异布局">
      <button type="button" aria-pressed={mode === "unified"} title="统一视图" onclick={() => (mode = "unified")}><Icon name="rows" size={12} />统一</button>
      <button type="button" aria-pressed={mode === "split"} title="并排视图" onclick={() => (mode = "split")}><Icon name="split" size={12} />并排</button>
    </div>
  </div>
  {#if error}
    <div class="empty" role="status">
      <span class="empty-icon err"><Icon name="alert-circle" size={24} /></span>
      <strong>差异没有读取完成</strong>
      <p>{error}</p>
    </div>
  {:else if !selection}
    <div class="empty">
      <span class="empty-icon"><Icon name="file-diff" size={24} /></span>
      <strong>选择一个文件查看差异</strong>
    </div>
  {:else if loading && !currentDiff}
    <div class="empty" role="status" aria-busy="true">
      <span class="spinner"></span>
      <strong>正在读取差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else if currentDiff?.binary}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>二进制文件有变动</strong>
      <p>{selection.path}</p>
    </div>
  {:else if !currentDiff || (currentDiff.lines.length === 0 && currentDiff.totalLines === 0)}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>没有文本差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else}
    <div
      class="diff-scroll"
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      tabindex="0"
      aria-label="差异文本"
      bind:this={scroller}
      onkeydown={onDiffKey}
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      bind:clientHeight={viewport}
    >
      <div class="virtual-space" style={`height:${total * ROW_HEIGHT}px`}>
        {#if mode === "unified"}
          {#each lines.slice(range.start, range.end) as line, index (`u-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div class={lineClass(line.kind)} data-diff-row="" style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}>
              <span class="ln">{line.oldNo ?? ""}</span>
              <span class="ln">{line.newNo ?? ""}</span>
              <span class="code">{line.text.length === 0 ? " " : line.text}</span>
              {#if !readOnly && hunkForLine(absolute)}
                {@const hunk = hunkForLine(absolute)}
                {#if hunk}
                  <button
                    type="button"
                    class={`btn btn-sm hunk-btn ${hunk.stageable ? "btn-secondary" : "btn-ghost"}`}
                    disabled={disabled || !hunk.stageable}
                    title={hunk.stageable ? "" : "截断的代码块不能部分暂存"}
                    onclick={() => onStageHunk(hunk)}
                  >{hunkLabel(hunk)}</button>
                {/if}
              {/if}
            </div>
          {/each}
        {:else}
          {#each sideRows.slice(range.start, range.end) as row, index (`s-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div class="side-row" class:span={row.span} data-diff-row="" style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}>
              <span class={`side-cell ${row.left?.kind ?? "empty"}`}>
                {#if row.left}<span class="ln">{row.left.no ?? ""}</span><span class="code">{row.left.text}</span>{/if}
              </span>
              <span class={`side-cell ${row.right?.kind ?? "empty"}`}>
                {#if row.right}<span class="ln">{row.right.no ?? ""}</span><span class="code">{row.right.text}</span>{/if}
              </span>
              {#if !readOnly && row.showStage && row.hunkIndex !== null}
                {@const hunk = currentDiff.hunks.find((item) => item.index === row.hunkIndex)}
                {#if hunk}
                  <button
                    type="button"
                    class={`btn btn-sm hunk-btn ${hunk.stageable ? "btn-secondary" : "btn-ghost"}`}
                    disabled={disabled || !hunk.stageable}
                    title={hunk.stageable ? "" : "截断的代码块不能部分暂存"}
                    onclick={() => onStageHunk(hunk)}
                  >{hunkLabel(hunk)}</button>
                {/if}
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
    {#if currentDiff.offset + currentDiff.lines.length < currentDiff.totalLines}
      <div class="diff-more">
        <p class="hint">已显示 {currentDiff.lines.length} / {currentDiff.totalLines} 行。</p>
        <button type="button" class="btn btn-secondary btn-sm" disabled={disabled || loading} onclick={onLoadMore}>继续加载</button>
      </div>
    {/if}
  {/if}
</section>
