<script lang="ts">
  import { untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { createFilesStore, isDirectoryKind, type FileTreeRow } from "../files.svelte";
  import type { OpenedRepository } from "../types";
  import { fileNavState, type FileNavState } from "../ui";
  import FileContent from "./FileContent.svelte";
  import FileTree from "./FileTree.svelte";
  import PaneResizer from "./PaneResizer.svelte";

  /**
   * 文件主视图：左侧按需目录树，右侧只读内容。三个视图同时保活，
   * 隐藏时停止新读取，重新激活按当前代次重验；切换仓库清空全部树与选择。
   */
  interface Props {
    active: boolean;
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    paneWidth: number;
    windowWidth: number;
    onResize: (width: number) => void;
    onResizeCommit: () => void;
    onGeneration: (generation: number) => void;
    onFileHistory: (path: string) => void;
    onNav: (nav: FileNavState | null) => void;
    /** 三个视图共用的左栏头部（视图切换 + 临时保存），保持位置与宽度一致。 */
    paneHead?: Snippet;
  }

  let {
    active,
    opened,
    disabled,
    nextId,
    paneWidth,
    windowWidth,
    onResize,
    onResizeCommit,
    onGeneration,
    onFileHistory,
    onNav,
    paneHead,
  }: Props = $props();

  const store = createFilesStore({
    repo: () => opened.summary.path,
    generation: () => opened.generation,
    active: () => active,
    // 用闭包取当前 prop：视图组件重建时不会把旧的回调闭进 store。
    nextId: () => nextId(),
    onGeneration: (generation) => onGeneration(generation),
  });

  /* 仓库身份变化：清空树、选择与过滤；隐藏时不读。 */
  $effect(() => {
    const repoPath = opened.summary.path;
    untrack(() => void store.sync(repoPath));
  });

  /* 可见性变化：隐藏只在隐藏瞬间记一次代次快照，隐藏期间的变化留到激活时重验。 */
  $effect(() => {
    const visible = active;
    const generation = opened.generation;
    untrack(() => store.setVisible(visible, generation));
  });

  let fileRows = $derived(store.rows.filter((row) => !row.segment && !isDirectoryKind(row.kind)));

  $effect(() => {
    const rows = fileRows;
    const selectedPath = store.selectedPath;
    const index = selectedPath ? rows.findIndex((row) => row.path === selectedPath) : -1;
    const nav = rows.length === 0
      ? null
      : fileNavState(
          rows,
          index,
          (row: FileTreeRow) => {
            store.select(row.path);
            filesTree?.revealRow?.(row.path);
          },
          "文件",
        );
    untrack(() => onNav(nav));
  });

  let filesTree = $state<{ revealRow?: (path: string) => void } | null>(null);

  let selectedRow = $derived(store.selectedPath ? store.rows.find((row) => row.path === store.selectedPath) ?? null : null);
  /* 目录与嵌套仓库只选中，不打开内容；符号链接与特殊文件仍让内容区显示真实状态。 */
  let openPath = $derived(
    selectedRow && !isDirectoryKind(selectedRow.kind) && selectedRow.kind !== "nestedRepository" && !selectedRow.segment
      ? selectedRow.path
      : null,
  );

  function selectRow(row: FileTreeRow): void {
    if (row.segment) return;
    store.select(row.path);
  }

  function toggleRow(row: FileTreeRow): void {
    void store.toggle(row.node);
  }

  function splitRow(row: FileTreeRow): void {
    row.node.split = true;
  }

  function refresh(): void {
    void store.revalidate();
  }
</script>

<div class="changes files-view">
  <section class="pane files-pane" aria-label="仓库文件树">
    {#if paneHead}{@render paneHead()}{/if}
    <FileTree
      bind:this={filesTree}
      rows={store.rows}
      selectedPath={store.selectedPath}
      loading={store.loading}
      failure={store.failure}
      query={store.query}
      includeIgnored={store.includeIgnored}
      {disabled}
      onQuery={(value) => store.setQuery(value)}
      onIncludeIgnored={(next) => store.setIncludeIgnored(next)}
      onToggle={toggleRow}
      onSelect={selectRow}
      onSplit={splitRow}
      onHistory={onFileHistory}
      onRefresh={refresh}
    />
    <p class="file-tree-note">
      只读浏览：目录按需读取{store.includeIgnored ? "，当前包含被忽略的文件" : ""}。
    </p>
  </section>
  <PaneResizer
    value={paneWidth}
    saved={paneWidth}
    label="调整文件树宽度"
    fit={(width) => Math.min(width, Math.max(240, windowWidth - 560))}
    onResize={onResize}
    onCommit={onResizeCommit}
  />
  <FileContent
    {active}
    {opened}
    {disabled}
    path={openPath}
    generation={opened.generation}
    reloadKey={store.revision}
    {nextId}
    {onGeneration}
    onFileHistory={onFileHistory}
  />
</div>
