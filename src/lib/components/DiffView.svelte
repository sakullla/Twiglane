<script lang="ts">
  import { toSideRows, type ViewLine } from "../diff";
  import { visibleRange } from "../layout";
  import type { DiffHunk, DiffResponse, FileSelection } from "../types";

  interface Props {
    selection: FileSelection | null;
    diff: DiffResponse | null;
    error: string | null;
    loading: boolean;
    disabled: boolean;
    onStageHunk: (hunk: DiffHunk) => void;
    onLoadMore: () => void;
  }

  const ROW_HEIGHT = 22;

  let { selection, diff, error, loading, disabled, onStageHunk, onLoadMore }: Props = $props();
  let mode = $state<"unified" | "split">("unified");
  let scrollTop = $state(0);
  let viewport = $state(0);
  let lines = $derived<ViewLine[]>(diff?.lines ?? []);
  let sideRows = $derived(mode === "split" ? toSideRows(lines) : []);
  let total = $derived(mode === "split" ? sideRows.length : lines.length);
  let range = $derived(visibleRange(total, scrollTop, viewport, ROW_HEIGHT));
  let hunkForLine = $derived((index: number) => diff?.hunks.find((hunk) => hunk.startLine === index) ?? null);

  function lineClass(kind: string): string {
    if (kind === "add") return "diff-line add";
    if (kind === "del") return "diff-line del";
    if (kind === "hunk" || kind === "meta" || kind === "nonewline") return "diff-line hunk";
    return "diff-line";
  }
</script>

<section class="diff" aria-label="差异详情">
  <div class="diff-toolbar">
    <div class="row" role="group" aria-label="差异布局">
      <button type="button" class="theme-btn" aria-pressed={mode === "unified"} onclick={() => (mode = "unified")}>统一</button>
      <button type="button" class="theme-btn" aria-pressed={mode === "split"} onclick={() => (mode = "split")}>并排</button>
    </div>
    {#if diff}
      <span class="hint">{diff.summary}</span>
    {/if}
  </div>
  {#if error}
    <div class="empty" role="status">
      <strong>差异没有读取完成</strong>
      <p>{error}</p>
    </div>
  {:else if !selection}
    <div class="empty">
      <strong>未选择文件</strong>
      <p>从中间列表选择一个文件，在这里查看差异。方向键可以移动选择，焦点会保持可见。</p>
    </div>
  {:else if loading && !diff}
    <div class="empty" role="status" aria-busy="true">
      <strong>正在读取差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else if diff?.binary}
    <div class="empty" role="status">
      <strong>二进制文件</strong>
      <p>{selection.path} 有变动，但不能按文本预览，因此这里不显示伪差异。</p>
    </div>
  {:else if !diff || (diff.lines.length === 0 && diff.totalLines === 0)}
    <div class="empty" role="status">
      <strong>没有文本差异</strong>
      <p>{selection.path} 当前这一侧没有可显示的文本差异。</p>
    </div>
  {:else}
    <div
      class="diff-scroll"
      role="region"
      aria-label="差异文本"
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      bind:clientHeight={viewport}
    >
      <div class="virtual-space" style={`height:${total * ROW_HEIGHT}px`}>
        {#if mode === "unified"}
          {#each lines.slice(range.start, range.end) as line, index (`u-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div class={lineClass(line.kind)} style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}>
              <span class="ln">{line.oldNo ?? ""}</span>
              <span class="ln">{line.newNo ?? ""}</span>
              <span class="code">{line.text.length === 0 ? " " : line.text}</span>
              {#if hunkForLine(absolute)}
                {@const hunk = hunkForLine(absolute)}
                {#if hunk}
                  <button
                    type="button"
                    class="ghost compact"
                    disabled={disabled || !hunk.stageable}
                    title={hunk.stageable ? "" : "截断的代码块不能部分暂存"}
                    onclick={() => onStageHunk(hunk)}
                  >
                    {hunk.stageable ? (selection.side === "staged" ? "取消暂存此块" : "暂存此块") : "已截断"}
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        {:else}
          {#each sideRows.slice(range.start, range.end) as row, index (`s-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div class="side-row" class:span={row.span} style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}>
              <span class={`side-cell ${row.left?.kind ?? "empty"}`}>{row.left ? `${row.left.no ?? ""} ${row.left.text}` : ""}</span>
              <span class={`side-cell ${row.right?.kind ?? "empty"}`}>{row.right ? `${row.right.no ?? ""} ${row.right.text}` : ""}</span>
              {#if row.showStage && row.hunkIndex !== null}
                {@const hunk = diff.hunks.find((item) => item.index === row.hunkIndex)}
                {#if hunk}
                  <button
                    type="button"
                    class="ghost compact"
                    disabled={disabled || !hunk.stageable}
                    title={hunk.stageable ? "" : "截断的代码块不能部分暂存"}
                    onclick={() => onStageHunk(hunk)}
                  >
                    {hunk.stageable ? (selection.side === "staged" ? "取消暂存此块" : "暂存此块") : "已截断"}
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
    {#if diff.offset + diff.lines.length < diff.totalLines}
      <div class="row diff-more">
        <p class="hint">已显示 {diff.lines.length} 行，共 {diff.totalLines} 行。长差异按窗口读取，未显示的截断代码块不能部分暂存。</p>
        <button type="button" class="ghost" disabled={disabled || loading} onclick={onLoadMore}>继续加载</button>
      </div>
    {/if}
  {/if}
</section>
