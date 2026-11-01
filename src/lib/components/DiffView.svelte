<script lang="ts">
  import { toSideRows, type ViewLine } from "../diff";
  import { scrollByRows, visibleRange } from "../layout";
  import type { DiffHunk, DiffResponse, FileSelection } from "../types";
  import { splitPath } from "../ui";
  import { buildDiffDocuments, codeOf, signOf } from "../syntax/diffSyntax";
  import { createHighlight } from "../syntax/highlight.svelte";
  import { effectiveLanguage } from "../syntax/prefs.svelte";
  import { lineSegments } from "../syntax/segments";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";
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
    /** 是否展开为完整文件（整份文件作上下文）；展开时不提供按块暂存。 */
    fullFile?: boolean;
    onFullFile?: (next: boolean) => void;
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
    fullFile = false,
    onFullFile,
  }: Props = $props();
  let menu = $state<ContextMenuRequest | null>(null);
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

  /* 语法高亮：旧侧（上下文 + 删除）与新侧（上下文 + 新增）各自整体分词，再按行映射回来；
     行内改动区间在配对的删除/新增行之间计算。结果逐块到达，未到的行先按纯文本显示。 */
  let language = $derived(currentDiff && !currentDiff.binary ? effectiveLanguage(currentDiff.path) : null);
  let documents = $derived(buildDiffDocuments(lines));
  const oldSyntax = createHighlight(() => ({ lang: language, lines: documents.oldLines }));
  const newSyntax = createHighlight(() => ({ lang: language, lines: documents.newLines }));

  function segmentsAt(index: number) {
    const line = lines[index];
    if (!line) return [];
    const code = codeOf(line);
    const side = documents.side[index];
    const tokens = side === 0 ? oldSyntax.at(documents.at[index]) : side === 1 ? newSyntax.at(documents.at[index]) : undefined;
    return lineSegments(code, tokens, documents.ranges.get(index) ?? null);
  }

  const sign = signOf;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时静默：菜单项本身不承担报错。
    }
  }

  function hunkOf(index: number): DiffHunk | null {
    const line = lines[index];
    if (!line || line.hunkIndex === null || !currentDiff) return null;
    return currentDiff.hunks.find((hunk) => hunk.index === line.hunkIndex) ?? null;
  }

  /** 右键菜单：复制、展开完整文件、文件历史与按块暂存；命中的行由 data-line 决定。 */
  function openMenu(event: MouseEvent | KeyboardEvent, point: { x: number; y: number }) {
    if (!selection) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
    const index = target ? Number(target.dataset.line) : -1;
    const line = index >= 0 ? lines[index] : undefined;
    const picked = typeof window !== "undefined" ? (window.getSelection()?.toString() ?? "") : "";
    const hunk = index >= 0 ? hunkOf(index) : null;
    const entries: ContextMenuEntry[] = [
      {
        id: "copy-selection",
        label: "复制选中内容",
        icon: "copy",
        disabledReason: picked ? undefined : "先在差异里选中文字",
        run: () => void copy(picked),
      },
      {
        id: "copy-line",
        label: "复制此行代码",
        icon: "copy",
        disabledReason: line && CODE_KINDS.has(line.kind) ? undefined : "这里不是代码行",
        run: () => line && void copy(codeOf(line)),
      },
      { id: "copy-path", label: "复制文件路径", icon: "copy", run: () => void copy(selection.path) },
    ];
    if (onFullFile) {
      entries.push(
        { separator: true },
        {
          id: "full-file",
          label: fullFile ? "只看改动部分" : "查看完整文件",
          icon: "rows",
          run: () => onFullFile?.(!fullFile),
        },
      );
    }
    if (onFileHistory) {
      entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onFileHistory?.(selection.path) });
    }
    if (!readOnly) {
      const reason = fullFile
        ? "完整文件视图不能按块暂存，先切回「只看改动部分」"
        : !hunk
          ? "在某个代码块上右键才能按块操作"
          : !hunk.stageable
            ? "截断的代码块不能部分暂存"
            : disabled
              ? "正在读取或写入，稍后再试"
              : undefined;
      entries.push(
        { separator: true },
        {
          id: "stage-hunk",
          label: selection.side === "staged" ? "取消暂存此块" : "暂存此块",
          icon: selection.side === "staged" ? "minus" : "plus",
          disabledReason: reason,
          run: () => hunk && onStageHunk(hunk),
        },
      );
    }
    menu = { x: point.x, y: point.y, entries, label: "差异操作" };
  }

  const CODE_KINDS = new Set(["add", "del", "context"]);

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
    {#if currentDiff && !currentDiff.binary && selection}
      <LanguagePicker path={selection.path} />
    {/if}
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
    {#if onFullFile && selection}
      <button
        type="button"
        class="btn btn-ghost btn-sm diff-full-toggle"
        aria-pressed={fullFile}
        title={fullFile ? "只显示改动附近的内容" : "把整份文件都显示出来（改动仍高亮）"}
        onclick={() => onFullFile?.(!fullFile)}
      >
        <Icon name="rows" size={13} /><span class="diff-hist-label">{fullFile ? "完整文件" : "只看改动"}</span>
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
      onkeydown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(event, { x: rect.left + 40, y: rect.top + 40 });
          return;
        }
        onDiffKey(event);
      }}
      oncontextmenu={(event) => {
        event.preventDefault();
        openMenu(event, { x: event.clientX, y: event.clientY });
      }}
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      bind:clientHeight={viewport}
    >
      <div class="virtual-space" style={`height:${total * ROW_HEIGHT}px`}>
        {#if mode === "unified"}
          {#each lines.slice(range.start, range.end) as line, index (`u-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div class={lineClass(line.kind)} data-diff-row="" data-line={absolute} style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}>
              <span class="ln">{line.oldNo ?? ""}</span>
              <span class="ln">{line.newNo ?? ""}</span>
              {#if line.kind === "add" || line.kind === "del" || line.kind === "context"}
                {@const segs = segmentsAt(absolute)}
                <span class="code" data-sign={sign(line.text)}>{#if segs.length === 1 && !segs[0].k && !segs[0].m}{segs[0].t}{:else}{#each segs as seg, i (i)}<span class={seg.k} class:wd={seg.m}>{seg.t}</span>{/each}{/if}</span>
              {:else}
                <span class="code">{line.text.length === 0 ? " " : line.text}</span>
              {/if}
              {#if !readOnly && !fullFile && hunkForLine(absolute)}
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
            <div
              class="side-row"
              class:span={row.span}
              data-diff-row=""
              data-line={row.right?.index ?? row.left?.index ?? undefined}
              style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
            >
              <!-- 占位格用 blank 而不是 empty：.empty 是全局空状态（flex + 32px 内边距），会把单元格撑到 64px，相邻行文字叠在一起。 -->
              <span class={`side-cell ${row.left?.kind ?? "blank"}`}>
                {#if row.left}<span class="ln">{row.left.no ?? ""}</span>{#if row.left.index !== undefined && !row.span}<span class="code" data-sign={sign(row.left.text)}>{#each segmentsAt(row.left.index) as seg, i (i)}{#if !seg.k && !seg.m}{seg.t}{:else}<span class={seg.k} class:wd={seg.m}>{seg.t}</span>{/if}{/each}</span>{:else}<span class="code">{row.left.text}</span>{/if}{/if}
              </span>
              <span class={`side-cell ${row.right?.kind ?? "blank"}`}>
                {#if row.right}<span class="ln">{row.right.no ?? ""}</span>{#if row.right.index !== undefined && !row.span}<span class="code" data-sign={sign(row.right.text)}>{#each segmentsAt(row.right.index) as seg, i (i)}{#if !seg.k && !seg.m}{seg.t}{:else}<span class={seg.k} class:wd={seg.m}>{seg.t}</span>{/if}{/each}</span>{:else}<span class="code">{row.right.text}</span>{/if}{/if}
              </span>
              {#if !readOnly && !fullFile && row.showStage && row.hunkIndex !== null}
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
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}
</section>
