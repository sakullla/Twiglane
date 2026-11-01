<script lang="ts">
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { filterRows, groupFiles } from "../labels";
  import type { DiffSide, FileChange, FileRow, FileSelection } from "../types";
  import { rowMark, splitPath } from "../ui";
  import Icon from "./Icon.svelte";

  interface Props {
    files: FileChange[];
    selected: FileSelection | null;
    query: string;
    disabled: boolean;
    onQuery: (value: string) => void;
    onSelect: (selection: FileSelection) => void;
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

  const ROW_HEIGHT = 34;

  let {
    files,
    selected,
    query,
    disabled,
    onQuery,
    onSelect,
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

  function isSelected(row: FileRow): boolean {
    return selected?.path === row.path && selected.side === row.side;
  }

  function itemIndexOf(row: FileRow): number {
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
    if (row.side === "unstaged") onStage(row.path);
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
    onSelect({ path: row.path, side: row.side });
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
                title="打开分支合并，逐处处理这些冲突文件"
                onclick={() => onResolve?.(null)}
              >
                <Icon name="merge" size={13} />去处理
              </button>
            {:else if item.side === "unstaged" && onStageAll && item.paths.length > 0}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                title="暂存列表中所有未暂存文件（冲突文件除外）"
                onclick={() => onStageAll?.(item.paths)}
              >
                <Icon name="plus" size={13} />全部暂存
              </button>
            {:else if item.side === "staged" && onUnstageAll && item.paths.length > 0}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={disabled}
                title="把列表中所有已暂存文件移回未暂存"
                onclick={() => onUnstageAll?.(item.paths)}
              >
                <Icon name="minus" size={13} />全部取消暂存
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
            style={`top:${top}px;height:${ROW_HEIGHT}px`}
            aria-selected={isSelected(row)}
            tabindex="-1"
            title={row.originalPath ? `${row.originalPath} → ${row.path}` : row.path}
            onclick={() => onSelect({ path: row.path, side: row.side })}
            ondblclick={() => toggle(row)}
            oncontextmenu={(event) => {
              if (!onContextMenu) return;
              event.preventDefault();
              onSelect({ path: row.path, side: row.side });
              onContextMenu(row, { x: event.clientX, y: event.clientY });
            }}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSelect({ path: row.path, side: row.side });
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
                  onStage(row.path);
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
                  onUnstage(row.path);
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
