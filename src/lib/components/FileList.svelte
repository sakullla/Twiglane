<script lang="ts">
  import { nextIndex } from "../layout";
  import { groupFiles, rowLabel } from "../labels";
  import type { FileChange, FileRow, FileSelection } from "../types";

  interface Props {
    files: FileChange[];
    selected: FileSelection | null;
    onSelect: (selection: FileSelection) => void;
  }

  let { files, selected, onSelect }: Props = $props();
  let groups = $derived(groupFiles(files));
  let rows = $derived([...groups.unstaged, ...groups.staged]);

  function onKey(event: KeyboardEvent) {
    const move = nextIndex(
      rows.findIndex((row) => row.path === selected?.path && row.side === selected.side),
      event.key,
      rows.length,
    );
    if (move === null) return;
    event.preventDefault();
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
</script>

<div class="file-list" role="listbox" aria-label="改动文件" tabindex="0" onkeydown={onKey}>
  {#if rows.length === 0}
    <div class="empty">
      <strong>工作区干净</strong>
      <p>没有需要查看的本地改动。可以在编辑器中修改文件，回到这里会在聚焦或外部更新后刷新。</p>
    </div>
  {:else}
    {#if groups.unstaged.length > 0}
      <div class="section-label">未暂存 {groups.unstaged.length}</div>
      {#each groups.unstaged as row (`unstaged:${row.path}`)}
        <button
          type="button"
          class="file-row"
          role="option"
          aria-selected={selected?.path === row.path && selected.side === "unstaged"}
          onclick={() => onSelect({ path: row.path, side: "unstaged" })}
        >
          <span class={badgeClass(row)}>{rowLabel(row)}</span>
          <span class="file-path" title={row.path}>{row.originalPath ? `${row.originalPath} → ${row.path}` : row.path}</span>
        </button>
      {/each}
    {/if}
    {#if groups.staged.length > 0}
      <div class="section-label">已暂存 {groups.staged.length}</div>
      {#each groups.staged as row (`staged:${row.path}`)}
        <button
          type="button"
          class="file-row"
          role="option"
          aria-selected={selected?.path === row.path && selected.side === "staged"}
          onclick={() => onSelect({ path: row.path, side: "staged" })}
        >
          <span class={badgeClass(row)}>{rowLabel(row)}</span>
          <span class="file-path" title={row.path}>{row.originalPath ? `${row.originalPath} → ${row.path}` : row.path}</span>
        </button>
      {/each}
    {/if}
  {/if}
</div>
