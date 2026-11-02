<script lang="ts">
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { filterRows, groupFiles } from "../labels";
  import type { DiffSide, FileChange, FileRow, FileSelection } from "../types";
  import { rangeSelection, rowMark, sameSelection, splitPath, toggleSelection } from "../ui";
  import Icon from "./Icon.svelte";

  interface Props {
    files: FileChange[];
    /** 焦点文件：单选时就是选中文件，多选时是当前定位到的那一个。 */
    selected: FileSelection | null;
    /** 多选集合；不足两项表示单选。 */
    selectedSet?: FileSelection[];
    query: string;
    disabled: boolean;
    onQuery: (value: string) => void;
    onSelect: (selection: FileSelection) => void;
    /** 多选变化：集合不足两项时外壳按单选处理，focus 是新的焦点文件。 */
    onMultiSelect?: (set: FileSelection[], focus: FileSelection) => void;
    /** 对全部选中文件执行暂存或取消暂存；不传时只作用在这一行。 */
    onBatch?: (side: DiffSide) => void;
    onStage: (path: string) => void;
    onUnstage: (path: string) => void;
    onStageAll?: (paths: string[]) => void;
    onUnstageAll?: (paths: string[]) => void;
    /** 打开某个冲突文件（或不带路径时打开冲突处理）。 */
    onResolve?: (path: string | null) => void;
    /** 右键或 Shift+F10 / 菜单键：在 (x, y) 为这一行打开上下文菜单。 */
    onContextMenu?: (row: FileRow, point: { x: number; y: number }) => void;
  }

  type Item =
    | { kind: "header"; side: DiffSide | "conflicted"; count: number; paths: string[] }
    | { kind: "row"; row: FileRow };

  /** 每行 40px：文件行实际画 36px、上下各留 2px 呼吸；分组表头用整行，文字贴底，与上一组拉开距离。 */
  const ROW_HEIGHT = 40;
  const ROW_GAP = 4;

  let {
    files,
    selected,
    selectedSet = [],
    query,
    disabled,
    onQuery,
    onSelect,
    onMultiSelect,
    onBatch,
    onStage,
    onUnstage,
    onStageAll,
    onUnstageAll,
    onResolve,
    onContextMenu,
  }: Props = $props();
  let groups = $derived(groupFiles(files));
  let conflictedRows = $derived(filterRows(groups.conflicted, query));
  let unstagedRows = $derived(filterRows(groups.unstaged, query));
  let stagedRows = $derived(filterRows(groups.staged, query));
  let items = $derived<Item[]>([
    ...(conflictedRows.length > 0
      ? [
          { kind: "header" as const, side: "conflicted" as const, count: conflictedRows.length, paths: [] },
          ...conflictedRows.map((row) => ({ kind: "row" as const, row })),
        ]
      : []),
    ...(unstagedRows.length > 0
      ? [
          {
            kind: "header" as const,
            side: "unstaged" as const,
            count: unstagedRows.length,
            paths: unstagedRows.filter((row) => !row.unmerged).map((row) => row.path),
          },
          ...unstagedRows.map((row) => ({ kind: "row" as const, row })),
        ]
      : []),
    ...(stagedRows.length > 0
      ? [
          {
            kind: "header" as const,
            side: "staged" as const,
            count: stagedRows.length,
            paths: stagedRows.filter((row) => !row.unmerged).map((row) => row.path),
          },
          ...stagedRows.map((row) => ({ kind: "row" as const, row })),
        ]
      : []),
  ]);
  let rows = $derived([...conflictedRows, ...unstagedRows, ...stagedRows]);
  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let range = $derived(
    visibleRange(items.length, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let visible = $derived(items.slice(range.start, range.end));
  let total = $derived(groups.conflicted.length + groups.unstaged.length + groups.staged.length);

  let multi = $derived(selectedSet.length > 1);
  /** Shift 扩展选择的起点：普通选择时落下，扩展过程中不动。 */
  let anchor: FileSelection | null = null;

  function plain(row: FileSelection): FileSelection {
    return { path: row.path, side: row.side };
  }

  function isFocus(row: FileRow): boolean {
    return sameSelection(selected, row);
  }

  function isSelected(row: FileRow): boolean {
    return multi ? selectedSet.some((item) => sameSelection(item, row)) : isFocus(row);
  }

  /** 普通点击、方向键：回到单选，这一行成为新的扩展起点。 */
  function single(row: FileSelection) {
    anchor = plain(row);
    onSelect(plain(row));
  }

  /**
   * Shift+点击、Shift+↑/↓：从起点到目标的连续范围。键盘要接着往下扩展，焦点跟着目标；
   * 鼠标选完是要从头看，焦点落在范围第一个文件。
   */
  function extendTo(row: FileSelection, follow: boolean) {
    if (!onMultiSelect) return single(row);
    anchor ??= selected ?? plain(row);
    const range = rangeSelection(rows, anchor, row);
    onMultiSelect(range, follow ? plain(row) : (range[0] ?? plain(row)));
  }

  /** ⌘/Ctrl+点击：增减这一行。最后一个文件不能减掉，否则主内容区会什么都不显示。 */
  function toggleRow(row: FileSelection) {
    if (!onMultiSelect) return single(row);
    const base = multi ? selectedSet : selected ? [plain(selected)] : [];
    const next = toggleSelection(base, plain(row));
    if (next.length === 0) return;
    const removed = next.length < base.length;
    anchor = plain(row);
    onMultiSelect(next, removed ? (sameSelection(selected, row) ? next[0] : (selected ?? next[0])) : plain(row));
  }

  function selectAll() {
    if (!onMultiSelect || rows.length === 0) return;
    onMultiSelect(rows.map(plain), selected && rows.some((row) => isFocus(row)) ? selected : plain(rows[0]));
  }

  function clickRow(event: MouseEvent, row: FileRow) {
    if (event.shiftKey) extendTo(row, false);
    else if (event.metaKey || event.ctrlKey) toggleRow(row);
    else single(row);
    // 行是虚拟的，滚出窗口就卸载；焦点放在列表上，键盘操作才不会掉到 body。
    list?.focus({ preventScroll: true });
  }

  /** 从外部切换文件时让列表跟上（上一个/下一个、多选堆叠的滚动定位）。 */
  export function revealRow(row: FileSelection) {
    anchor = plain(row);
    const index = itemIndexOf(row);
    if (index >= 0) reveal(index);
  }

  function itemIndexOf(row: FileSelection): number {
    return items.findIndex((item) => item.kind === "row" && item.row.path === row.path && item.row.side === row.side);
  }

  function reveal(index: number) {
    const height = viewport > 0 ? viewport : (list?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, scrollTop, height, ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  function toggle(row: FileRow) {
    if (disabled) return;
    if (row.unmerged) {
      onResolve?.(row.path);
      return;
    }
    if (multi && onBatch && isSelected(row)) onBatch(row.side);
    else if (row.side === "unstaged") onStage(row.path);
    else onUnstage(row.path);
  }

  function onKey(event: KeyboardEvent) {
    const current = rows.findIndex((row) => row.path === selected?.path && row.side === selected.side);
    if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && current >= 0 && onContextMenu) {
      event.preventDefault();
      const element = list?.querySelector<HTMLElement>('.file-row[aria-selected="true"]');
      const rect = element?.getBoundingClientRect();
      onContextMenu(rows[current], rect ? { x: rect.left + 24, y: rect.bottom - 4 } : { x: 120, y: 120 });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === " " && current >= 0) {
      event.preventDefault();
      toggle(rows[current]);
      return;
    }
    const move = nextIndex(current, event.key, rows.length);
    if (move === null) return;
    event.preventDefault();
    const row = rows[move];
    if (!row) return;
    reveal(itemIndexOf(row));
    if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) extendTo(row, true);
    else single(row);
  }
</script>

<div class="file-tools">
  <div class="field sm">
    <Icon name="search" size={14} />
    <input
      id="file-search"
      aria-label="搜索改动文件"
      placeholder="搜索文件或路径"
      autocomplete="off"
      spellcheck="false"
      value={query}
      oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
      onkeydown={(event) => {
        if (event.key === "Escape" && query) {
          event.preventDefault();
          onQuery("");
        }
      }}
    />
    {#if query}
      <button type="button" class="field-clear" aria-label="清空筛选" onclick={() => onQuery("")}>
        <Icon name="x" size={12} />
      </button>
    {/if}
  </div>
</div>
<div
  class="file-list"
  role="listbox"
  aria-label="改动文件"
  aria-multiselectable={onMultiSelect ? "true" : undefined}
  tabindex="0"
  bind:this={list}
  onkeydown={onKey}
  onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
  bind:clientHeight={viewport}
>
  {#if total === 0}
    <div class="empty">
      <span class="empty-icon ok"><Icon name="check-circle" size={24} /></span>
      <strong>工作区很干净</strong>
    </div>
  {:else if rows.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="search" size={22} /></span>
      <strong>没有匹配的文件</strong>
    </div>
  {:else}
    <div class="virtual-space" style={`height:${items.length * ROW_HEIGHT}px`}>
      {#each visible as item, index (item.kind === "header" ? `h:${item.side}` : `${item.row.side}:${item.row.path}`)}
        {@const top = (range.start + index) * ROW_HEIGHT}
        {#if item.kind === "header"}
          <div class="file-group" role="presentation" style={`top:${top}px;height:${ROW_HEIGHT}px`}>
            <span>{item.side === "conflicted" ? "冲突" : item.side === "unstaged" ? "未暂存的改动" : "已暂存"}</span>
            <span class="count" class:danger={item.side === "conflicted"}>{item.count}</span>
            <span class="spacer"></span>
            {#if item.side === "conflicted" && onResolve}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                aria-label="去处理"
                title="打开分支合并，逐处处理这些冲突文件"
                onclick={() => onResolve?.(null)}
              >
                <Icon name="merge" size={13} /><span class="file-group-action">去处理</span>
              </button>
            {:else if item.side === "unstaged" && onStageAll && item.paths.length > 0}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                aria-label="全部暂存"
                title="暂存列表中所有未暂存文件（冲突文件除外）"
                onclick={() => onStageAll?.(item.paths)}
              >
                <Icon name="plus" size={13} /><span class="file-group-action">全部暂存</span>
              </button>
            {:else if item.side === "staged" && onUnstageAll && item.paths.length > 0}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                aria-label="全部取消暂存"
                title="把列表中所有已暂存文件移回未暂存"
                onclick={() => onUnstageAll?.(item.paths)}
              >
                <Icon name="minus" size={13} /><span class="file-group-action">全部取消暂存</span>
              </button>
            {/if}
          </div>
        {:else}
          {@const row = item.row}
          {@const mark = rowMark(row)}
          {@const parts = splitPath(row.path)}
          <div
            class="file-row"
            role="option"
            style={`top:${top + ROW_GAP / 2}px;height:${ROW_HEIGHT - ROW_GAP}px`}
            aria-selected={isSelected(row)}
            data-member={multi && isSelected(row) && !isFocus(row) ? "" : undefined}
            tabindex="-1"
            title={row.originalPath ? `${row.originalPath} → ${row.path}` : row.path}
            onclick={(event) => clickRow(event, row)}
            ondblclick={(event) => {
              if (!event.shiftKey && !event.ctrlKey && !event.metaKey) toggle(row);
            }}
            oncontextmenu={(event) => {
              if (!onContextMenu) return;
              event.preventDefault();
              // 右键已选文件作用于全部选中，右键别的文件变为单选它。
              if (!(multi && isSelected(row))) single(row);
              onContextMenu(row, { x: event.clientX, y: event.clientY });
            }}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                single(row);
              }
            }}
          >
            <span class={`st ${mark.tone}`} title={mark.label} aria-label={mark.label}>{mark.letter}</span>
            <span class="file-name">
              <span class="fn">{parts.name}</span>
              {#if row.originalPath}
                <span class="fd from" title={`重命名自 ${row.originalPath}`}>← {row.originalPath}</span>
              {:else if parts.dir}
                <span class="fd"><bdi>{parts.dir}</bdi></span>
              {/if}
            </span>
            {#if row.unmerged}
              <button
                type="button"
                class="btn btn-ghost btn-sm row-action"
                disabled={disabled || !onResolve}
                title="在分支合并里逐处处理这个文件（空格）"
                onclick={(event) => {
                  event.stopPropagation();
                  onResolve?.(row.path);
                }}
              >
                <Icon name="merge" size={13} />处理
              </button>
            {:else if row.side === "unstaged"}
              <button
                type="button"
                class="btn btn-ghost btn-sm row-action"
                disabled={disabled}
                title="暂存（空格）"
                onclick={(event) => {
                  event.stopPropagation();
                  toggle(row);
                }}
              >
                <Icon name="plus" size={13} />暂存
              </button>
            {:else}
              <button
                type="button"
                class="btn btn-ghost btn-sm row-action"
                disabled={disabled}
                title="取消暂存（空格）"
                onclick={(event) => {
                  event.stopPropagation();
                  toggle(row);
                }}
              >
                <Icon name="minus" size={13} />取消暂存
              </button>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
