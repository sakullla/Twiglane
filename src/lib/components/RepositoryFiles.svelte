<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { changeDecorations, createFilesStore, isDeletedChange, isDirectoryKind, type FileSelectionMode, type FileTreeRow } from "../files.svelte";
  import type { DiffSide, OpenedRepository, RepositoryEditSnapshot } from "../types";
  import { fileNavState, type FileNavState } from "../ui";
  import FileContent from "./FileContent.svelte";
  import FileSearch from "./FileSearch.svelte";
  import FileTree from "./FileTree.svelte";
  import PaneResizer from "./PaneResizer.svelte";

  /**
   * 文件主视图：左侧按需目录树（或搜索面板），右侧内容（默认只读查看，工作区文本可切到轻量编辑）。三个视图同时保活，
   * 隐藏时停止新读取，重新激活按当前代次重验；切换仓库清空全部树、搜索与选择。
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
    /** 从文件进入它的 staged / unstaged 改动：切换视图由外壳负责。 */
    onOpenDiff?: (path: string, side: DiffSide) => void;
    /** 在系统文件管理器中定位：经 App 的 reveal_path 后端（守仓库边界、无 shell）。 */
    onReveal?: (path: string) => void;
    /** 用系统默认程序打开文件：经 App 的 open_path 后端，已删除文件由菜单灰显拦下。 */
    onOpenDefault?: (path: string) => void;
    /** 复制文本到剪贴板：由 App 的 copyText 给出成功提示与失败可见错误。 */
    onCopyPath?: (text: string, what: string) => void;
    /** 文件树「插入路径到终端」：外壳负责展开终端并换成完整路径。 */
    onInsertToTerminal?: (paths: string[]) => void;
    /** 仓库相对路径拼成完整路径（仅用于「复制完整路径」文本）。 */
    toAbsolute?: (relative: string) => string;
    onNav: (nav: FileNavState | null) => void;
    /** 三个视图共用的左栏头部（视图切换 + 临时保存），保持位置与宽度一致。 */
    paneHead?: Snippet;
    /** 从差异进入编辑的请求：文件定位完成后由内容区打开编辑会话。 */
    editRequest?: { path: string; line: number | null; serial: number } | null;
    /** 编辑器里的「返回差异」入口，只在同一路径上显示。 */
    editReturn?: { path: string; label: string; run: () => void } | null;
    onEditSaved?: (snapshot: RepositoryEditSnapshot) => void;
    onEditFailed?: (code: string) => void;
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
    onOpenDiff,
    onReveal,
    onOpenDefault,
    onCopyPath,
    onInsertToTerminal,
    toAbsolute,
    onNav,
    paneHead,
    editRequest = null,
    editReturn = null,
    onEditSaved,
    onEditFailed,
  }: Props = $props();

  const store = createFilesStore({
    repo: () => opened.summary.path,
    generation: () => opened.generation,
    active: () => active,
    // 用闭包取当前 prop：视图组件重建时不会把旧的回调闭进 store。
    nextId: () => nextId(),
    onGeneration: (generation) => onGeneration(generation),
    files: () => opened.snapshot.files,
  });

  /* 仓库身份变化：清空树、选择、搜索与打开历史；隐藏时不读。 */
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

  /** 当前展开的是哪一种搜索；none 时显示目录树。 */
  let searchMode = $state<"none" | "path" | "content">("none");

  /** 外部（改动列表、命令）定位一个路径：展开必要祖先、选中并按需跳到行。 */
  export function reveal(path: string, line: number | null = null): Promise<boolean> {
    return store.locate(path, line);
  }

  /** 聚焦某一种搜索的输入框；面板没展开时先展开它。 */
  export async function focusSearch(mode: "path" | "content"): Promise<void> {
    searchMode = mode;
    // 面板要等这一轮渲染挂上 DOM，焦点才能落在它自己的输入框上。
    await tick();
    const id = mode === "path" ? "file-quick-open" : "file-content-search";
    document.getElementById(id)?.focus();
  }

  function openSearch(mode: "path" | "content"): void {
    searchMode = mode;
  }

  /** 清空过滤再打开目标：过滤状态下的定位会看不见目标所在的分支。 */
  async function openTarget(path: string, line: number | null): Promise<void> {
    searchMode = "none";
    await store.locate(path, line);
  }

  /* 文件树与仅改动树共用同一份 Git 装饰：文件自身状态 + 祖先目录聚合，只影响显示。 */
  let decorations = $derived(changeDecorations(opened.snapshot.files));

  let deletedPaths = $derived(
    new Set(opened.snapshot.files.filter((file) => isDeletedChange(file)).map((file) => file.path)),
  );

  let fileRows = $derived(store.rows.filter((row) => !row.segment && !isDirectoryKind(row.kind)));

  let nav = $derived.by((): FileNavState | null => {
    const rows = fileRows;
    const selectedPath = store.selectedPath;
    const index = selectedPath ? rows.findIndex((row) => row.path === selectedPath) : -1;
    if (rows.length === 0) return null;
    return {
      ...fileNavState(
        rows,
        index,
        (row: FileTreeRow) => {
          store.select(row.path);
          filesTree?.revealRow?.(row.path);
        },
        "文件",
      ),
      history: {
        backReason: store.backReason,
        forwardReason: store.forwardReason,
        onBack: () => store.back(),
        onForward: () => store.forward(),
        recent: store.recent,
        onOpen: (path: string, line: number | null) => void openTarget(path, line),
      },
    };
  });

  $effect(() => {
    const value = nav;
    untrack(() => onNav(value));
  });

  let filesTree = $state<{ revealRow?: (path: string) => void } | null>(null);

  /* 选中路径的类型按路径解析，不要求这一行仍在可见行里：折叠父目录或过滤只改变树的显示，
     正在阅读的文件不该因此被清空。 */
  let selectedEntry = $derived(store.selectedPath ? store.resolve(store.selectedPath) : null);
  /* 删除的文件不读取当前内容：只提供改动与历史（旧版本）。 */
  let missingPath = $derived(
    store.selectedPath && deletedPaths.has(store.selectedPath) ? store.selectedPath : null,
  );
  /* 目录与嵌套仓库只选中，不打开内容；符号链接与特殊文件仍让内容区显示真实状态。 */
  let openPath = $derived(
    selectedEntry && !isDirectoryKind(selectedEntry.kind) && selectedEntry.kind !== "nestedRepository" && !selectedEntry.segment && !missingPath
      ? selectedEntry.path
      : null,
  );
  let lineTarget = $derived(store.lineTarget);
  let line = $derived(lineTarget && lineTarget.path === openPath ? lineTarget.line : null);

  /* 树过滤的全局补齐由状态模块算：已加载节点本地过滤，未展开的匹配补在下面并带上限。
     仅改动模式下没有补齐行，改动树本身就已经包含全部改动路径。 */
  let treeRows = $derived(store.treeRows);
  let filterLimited = $derived(store.filterLimited);

  function selectRow(row: FileTreeRow, mode: FileSelectionMode = "single"): void {
    if (row.segment) return;
    if (row.extra) {
      void store.locate(row.path, null);
      return;
    }
    store.selectWith(row.path, mode);
  }

  function toggleRow(row: FileTreeRow): void {
    void store.toggle(row.node);
  }

  function splitRow(row: FileTreeRow): void {
    row.node.split = true;
  }

  function refresh(): void {
    void store.revalidate(true);
  }

  /** 文件是否在当前改动集：文件装饰存在即有改动（删除墓碑也算），决定是否显示「查看改动」。 */
  function hasChange(path: string): boolean {
    return Boolean(decorations.files[path]);
  }

  /** 查看文件改动：按快照判断该走未暂存还是已暂存一侧，复用外壳既有的差异入口。 */
  function viewDiff(path: string): void {
    if (!onOpenDiff) return;
    const file = opened.snapshot.files.find((entry) => entry.path === path);
    const side: DiffSide = file && file.untracked === false && file.unstaged === "none" ? "staged" : "unstaged";
    onOpenDiff(path, side);
  }
</script>

<div class="changes files-view">
  <section class="pane files-pane" aria-label="仓库文件">
    {#if paneHead}{@render paneHead()}{/if}
    {#if searchMode === "none"}
      <FileTree
        bind:this={filesTree}
        rows={treeRows}
        selectedPath={store.selectedPath}
        selectedPaths={store.selectedPaths}
        loading={store.loading}
        failure={store.failure}
        query={store.query}
        includeIgnored={store.includeIgnored}
        changedOnly={store.changedOnly}
        {decorations}
        filterError={store.filterError}
        filterTruncated={store.filterTruncated}
        filterBusy={store.filterBusy}
        filterLimited={filterLimited}
        {disabled}
        onQuery={(value) => store.setQuery(value)}
        onIncludeIgnored={(next) => store.setIncludeIgnored(next)}
        onChangedOnly={(next) => store.setChangedOnly(next)}
        onSearch={openSearch}
        onLocate={(path) => void store.locate(path, null)}
        onRetryFilter={() => store.retryFilter()}
        onToggle={toggleRow}
        onSelect={selectRow}
        onSelectAll={store.selectAll}
        onClearSelection={store.clearMultiSelection}
        onSplit={splitRow}
        onHistory={onFileHistory}
        onRefresh={refresh}
        onCollapseAll={() => store.collapseAll()}
        {onReveal}
        {onOpenDefault}
        {onCopyPath}
        {onInsertToTerminal}
        {toAbsolute}
        {hasChange}
        onViewDiff={viewDiff}
      />
    {:else}
      <FileSearch
        {store}
        {disabled}
        mode={searchMode}
        onMode={openSearch}
        onClose={() => (searchMode = "none")}
        onOpen={(path, hitLine) => void openTarget(path, hitLine)}
      />
    {/if}
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
    missingPath={missingPath}
    {line}
    lineSerial={lineTarget?.serial ?? 0}
    {nav}
    generation={opened.generation}
    contentVersion={store.selectedVersion}
    reloadKey={store.revision}
    {nextId}
    {onGeneration}
    onFileHistory={onFileHistory}
    onOpenDiff={onOpenDiff}
    onRevealPath={(path) => store.locate(path, null)}
    includeIgnored={store.includeIgnored}
    {editRequest}
    {editReturn}
    {onEditSaved}
    {onEditFailed}
  />
</div>
