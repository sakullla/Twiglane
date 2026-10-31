<script lang="ts">
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { filterRows, groupFiles, rowLabel } from "../labels";
  import type { FileChange, FileRow, FileSelection } from "../types";

  interface Props {
    files: FileChange[];
    selected: FileSelection | null;
    query: string;
    disabled: boolean;
    onQuery: (value: string) => void;
    onSelect: (selection: FileSelection) => void;
    onStage: (path: string) => void;
    onUnstage: (path: string) => void;
  }

  const ROW_HEIGHT = 40;

  let { files, selected, query, disabled, onQuery, onSelect, onStage, onUnstage }: Props = $props();
  let groups = $derived(groupFiles(files));
  let rows = $derived(filterRows([...groups.unstaged, ...groups.staged], query));
  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let range = $derived(
    visibleRange(rows.length, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let visible = $derived(rows.slice(range.start, range.end));

  function reveal(index: number) {
    const height = viewport > 0 ? viewport : (list?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, scrollTop, height, ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  function onKey(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = rows.findIndex((row) => row.path === selected?.path && row.side === selected.side);
    const move = nextIndex(current, event.key, rows.length);
    if (move === null) return;
    event.preventDefault();
    reveal(move);
    const row = rows[move];
    if (row) onSelect({ path: row.path, side: row.side });
  }

  function badgeClass(row: FileRow): string {
    const label = rowLabel(row);
    if (label === "新增" || label === "未跟踪") return "badge add";
    if (label === "删除") return "badge del";
    if (label === "冲突") return "badge warn";
    return "badge";
  }

  function displayPath(row: FileRow): string {
    return row.originalPath ? `${row.originalPath} → ${row.path}` : row.path;
  }
</script>

<div class="file-tools">
  <input
    id="file-search"
    class="search"
    aria-label="搜索改动文件"
    placeholder="按路径或名称搜索"
    value={query}
    oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
  />
  {#if groups.unstaged.length + groups.staged.length > 0}
    <div class="section-label">未暂存 {groups.unstaged.length} · 已暂存 {groups.staged.length}</div>
  {/if}
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
  {#if groups.unstaged.length + groups.staged.length === 0}
    <div class="empty">
      <strong>工作区干净</strong>
      <p>没有需要查看的本地改动。可以在编辑器中修改文件，回到这里会在聚焦或外部更新后刷新。</p>
    </div>
  {:else if rows.length === 0}
    <div class="empty">
      <strong>没有匹配的文件</strong>
      <p>当前搜索没有对应的改动。清空搜索后，原来的选择还会在。</p>
    </div>
  {:else}
    <div class="virtual-space" style={`height:${rows.length * ROW_HEIGHT}px`}>
      {#each visible as row, index (`${row.side}:${row.path}`)}
        <div
          class="file-row"
          role="option"
          style={`top:${(range.start + index) * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
          aria-selected={selected?.path === row.path && selected.side === row.side}
          tabindex="-1"
          onclick={() => onSelect({ path: row.path, side: row.side })}
          onkeydown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect({ path: row.path, side: row.side });
            }
          }}
        >
          <span class={badgeClass(row)}>{rowLabel(row)}</span>
          <span class="file-path" title={displayPath(row)}>{displayPath(row)}</span>
          {#if row.side === "unstaged"}
            <button type="button" class="ghost compact" disabled={disabled} onclick={(event) => { event.stopPropagation(); onStage(row.path); }}>暂存</button>
          {:else}
            <button type="button" class="ghost compact" disabled={disabled} onclick={(event) => { event.stopPropagation(); onUnstage(row.path); }}>取消暂存</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
