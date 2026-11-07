<script lang="ts">
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { bucketByDirectory, filterRows, groupFiles } from "../labels";
  import type { DiffSide, FileChange, FileRow, FileSelection } from "../types";
  import { BUSY_REASON, rangeSelection, rowMark, sameSelection, splitPath, toggleSelection } from "../ui";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";

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
    /** 已标记已审阅的路径；同一路径的 staged / unstaged 两侧共用同一个标记。 */
    reviewed?: ReadonlySet<string>;
    /** 当前改动文件总数（按路径去重）。 */
    reviewTotal?: number;
    /** 仍然有效的已审阅数。 */
    reviewReviewed?: number;
    /** 隐藏已审阅文件：只改变显示，不改冲突/未暂存/已暂存分组数量与提交范围。 */
    hideReviewed?: boolean;
    onHideReviewed?: (next: boolean) => void;
    /** 标记或撤销整文件已审阅：路径作为参数，两侧行等价。 */
    onToggleReview?: (path: string) => void;
    /** 正在确认快照的路径：这一行的按钮显示进行中。 */
    reviewBusy?: string | null;
    /** 上一次标记失败的原因：就地说明，不弹全局错误。 */
    reviewNote?: string | null;
  }

  type SectionSide = DiffSide | "conflicted";
  type Item =
    | { kind: "header"; side: SectionSide; count: number; paths: string[] }
    | { kind: "dir"; side: SectionSide; directory: string; label: string; count: number; paths: string[]; collapsed: boolean }
    | { kind: "row"; row: FileRow };

  // 分组只改呈现，不写入设置，默认仍是列表。
  let directoryMode = $state(false);
  let collapsedDirs = $state<Set<string>>(new Set());

  /** 每行 30px：文件行单行排布（名字在前、目录弱化跟在后面），实际画 28px、上下各留 1px 呼吸；
      分组表头用整行。单行比旧的两行行高几乎多放一倍文件，长列表扫一眼就能看全。 */
  const ROW_HEIGHT = 30;
  const ROW_GAP = 2;

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
    reviewed = new Set<string>(),
    reviewTotal = 0,
    reviewReviewed = 0,
    hideReviewed = false,
    onHideReviewed,
    onToggleReview,
    reviewBusy = null,
    reviewNote = null,
  }: Props = $props();
  let groups = $derived(groupFiles(files));
  let conflictedRows = $derived(filterRows(groups.conflicted, query));
  let unstagedRows = $derived(filterRows(groups.unstaged, query));
  let stagedRows = $derived(filterRows(groups.staged, query));

  /**
   * 分组只由全部行决定：隐藏已审阅只影响显示出来的行，
   * 表头数量与「全部暂存 / 全部取消暂存」的路径范围仍是完整分组。
   */
  function sectionItems(
    rows: FileRow[],
    shown: FileRow[],
    side: SectionSide,
    paths: string[],
  ): Item[] {
    if (rows.length === 0) return [];
    const header: Item = { kind: "header", side, count: rows.length, paths };
    if (!directoryMode) return [header, ...shown.map((row) => ({ kind: "row" as const, row }))];
    const needle = query.trim();
    const items: Item[] = [header];
    for (const bucket of bucketByDirectory(shown)) {
      const key = `${side}:${bucket.directory}`;
      const collapsed = collapsedDirs.has(key) && needle === "";
      items.push({
        kind: "dir",
        side,
        directory: bucket.directory,
        label: bucket.directory || "仓库根目录",
        count: bucket.rows.length,
        paths: bucket.rows.filter((row) => !row.unmerged).map((row) => row.path),
        collapsed,
      });
      if (!collapsed) {
        for (const row of bucket.rows) items.push({ kind: "row", row });
      }
    }
    return items;
  }

  function shownRows(list: FileRow[]): FileRow[] {
    if (!hideReviewed) return list;
    return list.filter((row) => !reviewed.has(row.path));
  }

  let conflictedShown = $derived(shownRows(conflictedRows));
  let unstagedShown = $derived(shownRows(unstagedRows));
  let stagedShown = $derived(shownRows(stagedRows));

  let items = $derived<Item[]>([
    ...sectionItems(conflictedRows, conflictedShown, "conflicted", []),
    ...sectionItems(
      unstagedRows,
      unstagedShown,
      "unstaged",
      unstagedRows.filter((row) => !row.unmerged).map((row) => row.path),
    ),
    ...sectionItems(
      stagedRows,
      stagedShown,
      "staged",
      stagedRows.filter((row) => !row.unmerged).map((row) => row.path),
    ),
  ]);
  let rows = $derived([...conflictedShown, ...unstagedShown, ...stagedShown]);
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

  /* 单选时起点就是选中文件（含外部切换、Esc 退出多选）；多选期间定位焦点不动起点，
     否则 Shift 扩展的范围会跟着上一个/下一个漂移。 */
  $effect(() => {
    if (!multi && selected) anchor = plain(selected);
  });

  /** 外壳把焦点交回列表（退出多选时）。 */
  export function focusList() {
    list?.focus({ preventScroll: true });
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

  function toggleDir(side: SectionSide, directory: string) {
    const key = `${side}:${directory}`;
    const next = new Set(collapsedDirs);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedDirs = next;
  }

  let revealedQuery = "";
  $effect(() => {
    const needle = query.trim();
    const mode = directoryMode;
    const first = rows[0];
    if (!mode || !needle || !first) return;
    const token = `${needle}:${first.path}:${first.side}`;
    if (token === revealedQuery) return;
    revealedQuery = token;
    const next = new Set(collapsedDirs);
    let changed = false;
    for (const row of rows) {
      const key = `${row.side}:${row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ""}`;
      if (next.delete(key)) changed = true;
    }
    if (changed) collapsedDirs = next;
    queueMicrotask(() => reveal(itemIndexOf(first)));
  });

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

  /** 搜索框和列表是同一套选择：回车确认当前或第一条，向下把焦点交进列表。 */
  function onSearchKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      onQuery("");
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    if (rows.length === 0) return;
    event.preventDefault();
    const current = rows.findIndex((row) => sameSelection(selected, row));
    const next = event.key === "Enter" || current < 0
      ? rows[current >= 0 ? current : 0]
      : current < rows.length - 1
        ? rows[current + 1]
        : null;
    if (next) {
      reveal(itemIndexOf(next));
      single(next);
    }
    list?.focus({ preventScroll: true });
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
    if (event.key === "ArrowUp" && !event.shiftKey && current === 0) {
      event.preventDefault();
      document.getElementById("file-search")?.focus();
      return;
    }
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
  <div class="segmented icon-segmented" role="group" aria-label="文件排列">
    <button type="button" aria-pressed={!directoryMode} aria-label="列表" title="平铺列表" onclick={() => (directoryMode = false)}><Icon name="list" size={14} /></button>
    <button type="button" aria-pressed={directoryMode} aria-label="目录" title="按目录分组" onclick={() => (directoryMode = true)}><Icon name="folder" size={14} /></button>
  </div>
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
      onkeydown={onSearchKey}
    />
    {#if query}
      <button type="button" class="field-clear" aria-label="清空筛选" onclick={() => onQuery("")}>
        <Icon name="x" size={12} />
      </button>
    {/if}
  </div>
  {#if onToggleReview || reviewTotal > 0}
    <span
      class="review-count"
      role="status"
      aria-label={`已审阅 ${reviewReviewed} 个，共 ${reviewTotal} 个改动文件`}
      title="已审阅数是本地人工进度，不代表批准、提交或 Cliora 结果"
    >
      <Icon name="check-circle" size={13} />{reviewReviewed}/{reviewTotal}
    </span>
  {/if}
  {#if onHideReviewed}
    <button
      type="button"
      class="btn btn-ghost btn-sm review-hide"
      aria-pressed={hideReviewed}
      aria-label="隐藏已审阅"
      title={hideReviewed ? "重新显示已审阅的文件；分组数量与提交范围不受影响" : "折叠已审阅的文件；只改显示，不改提交范围"}
      onclick={() => onHideReviewed?.(!hideReviewed)}
    >
      <Icon name="eye" size={13} /><span class="file-group-action">已审阅</span>
    </button>
  {/if}
</div>
{#if reviewNote}
  <p class="file-tree-status danger" role="alert">{reviewNote}</p>
{/if}
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
  {:else if rows.length === 0 && hideReviewed}
    <div class="empty">
      <span class="empty-icon ok"><Icon name="check-circle" size={22} /></span>
      <strong>已审阅的文件都隐藏了</strong>
      <p>隐藏只影响显示，分组数量与提交范围没有变化。</p>
      {#if onHideReviewed}
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => onHideReviewed?.(false)}>显示已审阅</button>
      {/if}
    </div>
  {:else if rows.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="search" size={22} /></span>
      <strong>没有匹配的文件</strong>
    </div>
  {:else}
    <div class="virtual-space" style={`height:${items.length * ROW_HEIGHT}px`}>
      {#each visible as item, index (item.kind === "header" ? `h:${item.side}` : item.kind === "dir" ? `d:${item.side}:${item.directory}` : `${item.row.side}:${item.row.path}`)}
        {@const top = (range.start + index) * ROW_HEIGHT}
        {#if item.kind === "header"}
          <!-- 分区之间一条细线：冲突/未暂存/已暂存三段在同一个列表里滚动，靠线而不是靠更多留白分区。
               第一条上面就是搜索框，不画线。 -->
          <div
            class="file-group"
            class:first={range.start + index === 0}
            role="presentation"
            style={`top:${top}px;height:${ROW_HEIGHT}px`}
          >
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
        {:else if item.kind === "dir"}
          <div class="file-dir" role="presentation" style={`top:${top}px;height:${ROW_HEIGHT}px`}>
            <button
              type="button"
              class="dir-name"
              aria-expanded={!item.collapsed}
              onclick={() => toggleDir(item.side, item.directory)}
            >
              <Icon name="chevron-down" size={13} class={item.collapsed ? "" : "flip"} />
              <span>{item.label}</span>
              <span class="count">{item.count}</span>
            </button>
            <span class="spacer"></span>
            {#if item.side === "unstaged" && onStageAll && item.paths.length > 0}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                title={disabled ? BUSY_REASON : undefined}
                aria-label={`暂存 ${item.label}`}
                onclick={(event) => {
                  event.stopPropagation();
                  onStageAll(item.paths);
                }}
              >暂存</button>
            {:else if item.side === "staged" && onUnstageAll && item.paths.length > 0}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                title={disabled ? BUSY_REASON : undefined}
                aria-label={`取消暂存 ${item.label}`}
                onclick={(event) => {
                  event.stopPropagation();
                  onUnstageAll(item.paths);
                }}
              >取消暂存</button>
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
            <LineCounts stat={row.side === "staged" ? row.stagedLines : row.unstagedLines} hideBinary />
            {#if onToggleReview}
              <button
                type="button"
                class="icon-btn sm review-toggle"
                class:on={reviewed.has(row.path)}
                aria-pressed={reviewed.has(row.path)}
                aria-label={reviewed.has(row.path) ? `撤销 ${row.path} 的已审阅标记` : `标记 ${row.path} 已审阅`}
                title={reviewBusy === row.path
                  ? "正在确认整份文件快照……"
                  : reviewed.has(row.path)
                    ? "撤销这个文件的已审阅标记"
                    : "标记整个文件已审阅；内容、暂存状态或删除变化后自动失效"}
                disabled={reviewBusy === row.path}
                onclick={(event) => {
                  event.stopPropagation();
                  onToggleReview?.(row.path);
                }}
              >
                {#if reviewBusy === row.path}
                  <span class="spinner" aria-hidden="true"></span>
                {:else}
                  <Icon name="check" size={13} />
                {/if}
              </button>
            {/if}
            {#if row.unmerged}
              <button
                type="button"
                class="row-action"
                disabled={disabled || !onResolve}
                aria-label="处理"
                title="在分支合并里逐处处理这个文件（空格）"
                onclick={(event) => {
                  event.stopPropagation();
                  onResolve?.(row.path);
                }}
              >
                <Icon name="merge" size={14} />
              </button>
            {:else if row.side === "unstaged"}
              <button
                type="button"
                class="row-action"
                disabled={disabled}
                aria-label="暂存"
                title="暂存（空格）"
                onclick={(event) => {
                  event.stopPropagation();
                  toggle(row);
                }}
              >
                <Icon name="plus" size={14} />
              </button>
            {:else}
              <button
                type="button"
                class="row-action"
                disabled={disabled}
                aria-label="取消暂存"
                title="取消暂存（空格）"
                onclick={(event) => {
                  event.stopPropagation();
                  toggle(row);
                }}
              >
                <Icon name="minus" size={14} />
              </button>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
