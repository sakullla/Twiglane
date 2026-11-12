<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import { fileTone } from "../file-kind";
  import { FILTER_EXTRA_LIMIT, FILE_ROW_HEIGHT, rowIndex, type ChangeDecorations, type FileSelectionMode, type FileTreeRow } from "../files.svelte";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { BUSY_REASON } from "../ui";
  import ContextMenu, { isContextKey, pointFor, type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 按需目录树：只渲染后端已读到的直接子项，长列表用固定行高虚拟化。
   * 行本身不发起请求，展开、拆分、选择都由文件视图的状态模块决定，组件只上报动作。
   *
   * 工具条只常驻三件事：筛选、全仓库搜索、只看改动；按路径打开、显示忽略、全部折叠与重新读取收进「更多」。
   * 单击目录即展开/折叠（同时选中它，供「当前目录」搜索范围使用），单击文件即打开。
   */
  interface Props {
    rows: FileTreeRow[];
    selectedPath: string | null;
    loading: boolean;
    failure: string | null;
    query: string;
    includeIgnored: boolean;
    /** 仅看有改动的文件：行来自 StatusSnapshot，删除的文件是墓碑。 */
    changedOnly?: boolean;
    /** 当前 StatusSnapshot 的文件与祖先目录装饰：只影响显示，不改暂存与提交范围。 */
    decorations?: ChangeDecorations;
    /** 树过滤的全仓库补齐失败原因：失败时不能说「没有更多匹配」。 */
    filterError?: string | null;
    /** 补齐结果被后端截断：匹配没有显示全。 */
    filterTruncated?: boolean;
    /** 全仓库补齐还在飞行中：这时的空结果不是「没有匹配」。 */
    filterBusy?: boolean;
    /** 补齐行被截到显示上限：还有匹配没列出来。 */
    filterLimited?: boolean;
    /** 有写入或读取在飞行中：只锁树里的动作，不阻止选择。 */
    disabled: boolean;
    onQuery: (value: string) => void;
    onIncludeIgnored: (next: boolean) => void;
    onChangedOnly?: (next: boolean) => void;
    /** 打开按路径搜索或全仓库文本搜索：两种搜索各有自己的输入。 */
    onSearch?: (mode: "path" | "content") => void;
    /** 定位一个树过滤补齐出来的路径（它不在当前已加载的树里）。 */
    onLocate?: (path: string) => void;
    /** 补齐失败后的就地重试：同一个过滤词重发一次全仓库补齐。 */
    onRetryFilter?: () => void;
    selectedPaths: ReadonlySet<string>;
    onToggle: (row: FileTreeRow) => void;
    onSelect: (row: FileTreeRow, mode?: FileSelectionMode) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
    onSplit: (row: FileTreeRow) => void;
    onHistory?: (path: string) => void;
    onRefresh: () => void;
    /** 全部折叠：只改展开状态，不丢已读子项。 */
    onCollapseAll?: () => void;
    /**
     * 系统文件管理器中定位：文件选中、目录直接打开。经 App 的 reveal_path 后端，
     * 组件内不拼路径、不碰 api——保持与全应用一致的仓库边界与错误提示。
     */
    onReveal?: (path: string) => void;
    /** 用系统默认程序打开文件：已删除文件不可用（在菜单内灰显说明）。 */
    onOpenDefault?: (path: string) => void;
    /** 复制一段文本到剪贴板：由 App 的 copyText 给出成功提示与失败可见错误，不再静默吞错。 */
    onCopyPath?: (text: string, what: string) => void;
    /** 把仓库相对路径拼成完整路径（仅供「复制完整路径」文本用，不用于系统打开）。 */
    toAbsolute?: (relative: string) => string;
    /** 一个文件是否在当前改动集：有改动才显示「查看改动」。 */
    hasChange?: (path: string) => boolean;
    /** 查看这个文件的改动：路由到既有的差异视图入口。 */
    onViewDiff?: (path: string) => void;
  }

  let {
    rows,
    selectedPath,
    loading,
    failure,
    query,
    includeIgnored,
    changedOnly = false,
    decorations = { files: {}, dirs: {} },
    filterError = null,
    filterTruncated = false,
    filterBusy = false,
    filterLimited = false,
    disabled,
    onQuery,
    onIncludeIgnored,
    onChangedOnly,
    onSearch,
    onLocate,
    onRetryFilter,
    selectedPaths,
    onToggle,
    onSelect,
    onSelectAll,
    onClearSelection,
    onSplit,
    onHistory,
    onRefresh,
    onCollapseAll,
    onReveal,
    onOpenDefault,
    onCopyPath,
    toAbsolute,
    hasChange,
    onViewDiff,
  }: Props = $props();

  /** 缩进宽度：与 components.css 的缩进引导线周期一致。 */
  const INDENT = 14;

  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let menu = $state<ContextMenuRequest | null>(null);
  let moreButton = $state<HTMLButtonElement | null>(null);
  /** 「更多」菜单是否由更多按钮唤起：按钮据此显示展开态，再点一次即收起。 */
  let moreOpen = $state(false);
  let moreClosedAt = 0;

  let range = $derived(visibleRange(rows.length, scrollTop, viewport > 0 ? viewport : 0, FILE_ROW_HEIGHT));
  let visible = $derived(rows.slice(range.start, range.end));
  let hasExpanded = $derived(rows.some((row) => row.expandable && row.expanded));
  let selectedRows = $derived(rows.filter((row) => !row.segment && selectedPaths.has(row.path)));

  function isSelected(row: FileTreeRow): boolean {
    return selectedPaths.size > 0 ? selectedPaths.has(row.path) : row.path === selectedPath;
  }

  function reveal(index: number) {
    const next = scrollIndexIntoView(index, scrollTop, viewport > 0 ? viewport : (list?.clientHeight ?? 0), FILE_ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  /** 外部选择变化（例如刷新后保留的选中文件）滚动到可见位置。 */
  let revealedFor = "";
  $effect(() => {
    const path = selectedPath;
    if (!path || path === revealedFor) return;
    const index = rowIndex(rows, path);
    if (index < 0) return;
    revealedFor = path;
    reveal(index);
  });

  function focusList() {
    list?.focus({ preventScroll: true });
  }

  /** 外部（上一个/下一个文件、导航）定位到某个路径：滚动到可见并聚焦列表。 */
  export function revealRow(path: string): void {
    const index = rowIndex(rows, path);
    if (index < 0) return;
    revealedFor = path;
    reveal(index);
    focusList();
  }

  function open(row: FileTreeRow) {
    if (!row.expandable) {
      onSelect(row);
      return;
    }
    if (disabled) return;
    onToggle(row);
  }

  /** 普通点击保持单选与目录展开；Ctrl/⌘、Shift 只调整选择集合，不顺手折叠目录。 */
  function activate(row: FileTreeRow, mode: FileSelectionMode = "single") {
    if (row.extra) {
      onLocate?.(row.path);
      return;
    }
    if (mode === "single") onSelect(row);
    else onSelect(row, mode);
    if (mode === "single" && row.expandable && !disabled) onToggle(row);
  }

  function expand(row: FileTreeRow) {
    if (disabled || !row.expandable) return;
    if (!row.expanded) onToggle(row);
  }

  function collapse(row: FileTreeRow) {
    if (disabled || !row.expandable) return;
    if (row.expanded) onToggle(row);
  }

  function parentOf(row: FileTreeRow): number {
    for (let index = rowIndex(rows, row.path) - 1; index >= 0; index -= 1) {
      if (rows[index].depth < row.depth) return index;
    }
    return -1;
  }

  function onKey(event: KeyboardEvent) {
    if (isContextKey(event)) {
      const index = selectedPath ? rowIndex(rows, selectedPath) : -1;
      if (index >= 0) {
        event.preventDefault();
        const element = list?.querySelector<HTMLElement>(".file-tree-row.active");
        menu = {
          ...(element ? pointFor(element) : { x: 120, y: 120 }),
          entries: menuEntries(rows[index]),
          label: selectedRows.length > 1 ? `已选 ${selectedRows.length} 项的操作` : `${rows[index].path} 的操作`,
        };
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.key === "Escape" && selectedPaths.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      onClearSelection();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = selectedPath ? rowIndex(rows, selectedPath) : -1;
    const row = current >= 0 ? rows[current] : null;
    if (event.key === "ArrowRight" && row) {
      event.preventDefault();
      expand(row);
      return;
    }
    if (event.key === "ArrowLeft" && row) {
      event.preventDefault();
      if (row.expanded) collapse(row);
      else {
        const parent = parentOf(row);
        if (parent >= 0) {
          reveal(parent);
          onSelect(rows[parent]);
        }
      }
      return;
    }
    if (event.key === "Enter" && row) {
      event.preventDefault();
      open(row);
      return;
    }
    if (event.key === " " && row) {
      event.preventDefault();
      if (disabled) return;
      onToggle(row);
      return;
    }
    const move = nextIndex(current, event.key, rows.length);
    if (move === null) return;
    event.preventDefault();
    const target = rows[move];
    if (!target || target.segment) return;
    reveal(move);
    if (event.shiftKey) onSelect(target, "range");
    else onSelect(target);
  }

  /** 系统定位文案按平台切换：与全应用菜单一致（文案是显示，不是动作，仍由 App 执行 reveal）。 */
  const revealLabel = typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac")
    ? "在访达中显示"
    : "在资源管理器中显示";

  /** 路径复制三件套：相对路径、完整路径、名称（目录名或文件名）；都经 App 的 copyText 反馈。 */
  function copyEntries(row: FileTreeRow, nameLabel: string): ContextMenuEntry[] {
    if (!onCopyPath) return [];
    const name = row.path.split("/").pop() ?? row.path;
    return [
      { id: "copy-rel", label: "复制相对路径", icon: "copy", run: () => onCopyPath?.(row.path, "相对路径") },
      {
        id: "copy-abs",
        label: "复制完整路径",
        icon: "copy",
        run: () => onCopyPath?.(toAbsolute ? toAbsolute(row.path) : row.path, "完整路径"),
      },
      { id: "copy-name", label: nameLabel, icon: "copy", run: () => onCopyPath?.(name, nameLabel.replace("复制", "")) },
    ];
  }

  function copySelected(absolute = false): void {
    if (!onCopyPath || selectedRows.length === 0) return;
    const paths = selectedRows.map((row) => absolute && toAbsolute ? toAbsolute(row.path) : row.path);
    onCopyPath(paths.join("\n"), `${selectedRows.length} 个${absolute ? "完整" : "相对"}路径`);
  }

  function revealSelected(): void {
    if (!onReveal) return;
    for (const row of selectedRows) onReveal(row.path);
  }

  function batchMenuEntries(): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [{ heading: `已选 ${selectedRows.length} 项` }];
    if (onReveal) {
      entries.push({ id: "reveal-selected", label: "在系统文件管理器中显示所选项目", icon: "folder-open", run: revealSelected });
    }
    if (onCopyPath) {
      entries.push({ separator: true });
      entries.push({ id: "copy-selected-rel", label: "复制所选相对路径", icon: "copy", run: () => copySelected() });
      entries.push({ id: "copy-selected-abs", label: "复制所选完整路径", icon: "copy", run: () => copySelected(true) });
    }
    entries.push({ separator: true });
    entries.push({ id: "clear-selected", label: "取消多选", icon: "x", shortcut: "Esc", run: onClearSelection });
    return entries;
  }

  function menuEntries(row: FileTreeRow): ContextMenuEntry[] {
    if (selectedPaths.has(row.path) && selectedRows.length > 1) return batchMenuEntries();
    const entries: ContextMenuEntry[] = [];
    if (row.expandable) {
      // 目录：展开/折叠 → 系统定位该目录 → 路径复制。
      entries.push({
        id: "toggle",
        label: row.expanded ? "折叠" : "展开",
        icon: row.expanded ? "chevron-down" : "chevron-right",
        disabledReason: disabled ? BUSY_REASON : undefined,
        run: () => onToggle(row),
      });
      if (row.splittable) {
        entries.push({ id: "split", label: "拆成逐级目录", icon: "list", run: () => onSplit(row) });
      }
      if (onReveal) {
        entries.push({ separator: true });
        entries.push({
          id: "reveal",
          label: "在系统文件管理器中打开该目录",
          icon: "folder-open",
          run: () => onReveal?.(row.path),
        });
      }
      const copies = copyEntries(row, "复制目录名");
      if (copies.length > 0) {
        entries.push({ separator: true });
        entries.push(...copies);
      }
      return entries;
    }

    // 文件：应用内查看（打开 / 有改动时查看改动 / 文件历史） → 系统操作（定位 / 默认程序打开） → 路径复制。
    entries.push({ id: "open", label: "打开", icon: "file", run: () => onSelect(row) });
    if (onViewDiff && hasChange?.(row.path)) {
      entries.push({ id: "diff", label: "查看改动", icon: "file-diff", run: () => onViewDiff?.(row.path) });
    }
    if (onHistory) {
      entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onHistory?.(row.path) });
    }
    if (row.splittable) {
      entries.push({ id: "split", label: "拆成逐级目录", icon: "list", run: () => onSplit(row) });
    }
    if (onReveal || onOpenDefault) {
      entries.push({ separator: true });
      if (onReveal) {
        entries.push({ id: "reveal", label: revealLabel, icon: "folder-open", run: () => onReveal?.(row.path) });
      }
      if (onOpenDefault) {
        entries.push({
          id: "open-default",
          label: "用默认程序打开",
          icon: "file",
          disabledReason: row.deleted ? "文件已删除，工作区里没有它" : undefined,
          run: () => onOpenDefault?.(row.path),
        });
      }
    }
    const copies = copyEntries(row, "复制文件名");
    if (copies.length > 0) {
      entries.push({ separator: true });
      entries.push(...copies);
    }
    return entries;
  }

  function moreEntries(): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [];
    if (onSearch) {
      entries.push({
        id: "quick-open",
        label: "按路径打开",
        icon: "file",
        shortcut: `${MODIFIER_LABEL} P`,
        run: () => onSearch?.("path"),
      });
      entries.push({ separator: true });
    }
    entries.push({
      id: "ignored",
      label: "显示忽略的文件",
      icon: "eye",
      checked: includeIgnored,
      run: () => onIncludeIgnored(!includeIgnored),
    });
    if (onCollapseAll) {
      entries.push({
        id: "collapse",
        label: "全部折叠",
        icon: "chevron-up",
        disabledReason: hasExpanded ? undefined : "没有展开的目录",
        run: () => onCollapseAll?.(),
      });
    }
    entries.push({
      id: "refresh",
      label: "重新读取目录",
      icon: "refresh",
      disabledReason: loading ? "正在读取目录" : undefined,
      run: onRefresh,
    });
    return entries;
  }

  function toggleMore(): void {
    // 菜单在按下时已因「点到外面」关闭：同一次点击不再把它打开。
    if (moreOpen || performance.now() - moreClosedAt < 250) return;
    const rect = moreButton?.getBoundingClientRect();
    moreOpen = true;
    menu = {
      x: rect ? rect.right - 232 : 120,
      y: rect ? rect.bottom + 4 : 120,
      entries: moreEntries(),
      label: "文件树选项",
    };
  }

  function closeMenu(): void {
    if (moreOpen) moreClosedAt = performance.now();
    moreOpen = false;
    menu = null;
  }

  function rowIcon(row: FileTreeRow): "folder" | "folder-open" | "file" | "link" | "alert-circle" | "package" {
    if (row.kind === "symlink") return "link";
    if (row.kind === "special" || row.kind === "error") return "alert-circle";
    if (row.kind === "nestedRepository") return "package";
    if (row.expandable || row.segment) return row.expanded ? "folder-open" : "folder";
    return "file";
  }

  /** 这一行的 Git 装饰：文件用自身状态，目录用其后代改动的聚合。 */
  function rowStatus(row: FileTreeRow): { letter: string; tone: string; label: string; count?: number } | null {
    if (row.expandable) return decorations.dirs[row.path] ?? null;
    return decorations.files[row.path] ?? null;
  }

  function rowHint(row: FileTreeRow): string {
    if (row.error) return row.error;
    if (row.failure) return row.failure;
    if (row.kind === "symlink") return "符号链接：不跟随读取";
    if (row.kind === "special") return "特殊文件：不作为文本读取";
    if (row.kind === "nestedRepository") return "嵌套仓库：不递归读取";
    if (row.kind === "error") return "这个条目读取失败";
    return row.path;
  }

  /** 补齐的状态说明：只在结果可能不完整或范围特殊时出现，正常过滤不打扰。 */
  let filterNote = $derived.by((): { text: string; danger: boolean } | null => {
    if (!query) return null;
    if (filterError) return { text: `全仓库补齐失败：${filterError}只显示已展开范围内的匹配。`, danger: true };
    if (filterBusy) return { text: "正在全仓库补齐匹配……", danger: false };
    if (filterTruncated) return { text: "全仓库匹配过多，补齐结果不完整（后端已截断）。", danger: false };
    if (filterLimited) return { text: `全仓库补齐只显示前 ${FILTER_EXTRA_LIMIT} 条，还有匹配没有列出。`, danger: false };
    if (changedOnly) return { text: "仅在改动文件里匹配；改动树不需要全仓库补齐。", danger: false };
    return null;
  });
</script>

<div class="file-tools">
  <div class="field sm file-filter">
    <Icon name="filter" size={13} />
    <input
      id="files-search"
      data-search-scope="tree"
      aria-label="过滤文件树"
      placeholder={changedOnly ? "筛选改动文件" : "筛选文件"}
      title="只在已读取的目录树里按路径筛选，不读文件内容；全仓库正文查找在右侧搜索里"
      autocomplete="off"
      spellcheck="false"
      value={query}
      oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
      onkeydown={(event) => {
        if (event.key === "Escape" && query) {
          event.preventDefault();
          onQuery("");
          return;
        }
        if (event.key === "ArrowDown" && rows.length > 0) {
          event.preventDefault();
          focusList();
        }
      }}
    />
    {#if query}
      <button type="button" class="field-clear" aria-label="清空过滤" onclick={() => onQuery("")}>
        <Icon name="x" size={12} />
      </button>
    {/if}
  </div>
  <div class="file-tools-actions">
    {#if onSearch}
      <button
        type="button"
        class="icon-btn sm"
        aria-label="全仓库搜索"
        title="全仓库搜索：在工作区文本里查找固定字符串"
        onclick={() => onSearch?.("content")}
      >
        <Icon name="search" size={14} />
      </button>
    {/if}
    {#if onChangedOnly}
      <button
        type="button"
        class="icon-btn sm"
        aria-pressed={changedOnly}
        aria-label="只看有改动的文件"
        title={changedOnly ? "显示完整仓库树" : "只看有改动的文件"}
        onclick={() => onChangedOnly?.(!changedOnly)}
      >
        <Icon name="file-diff" size={14} />
      </button>
    {/if}
    <button
      type="button"
      class="icon-btn sm"
      aria-label="更多文件树选项"
      aria-haspopup="menu"
      aria-expanded={moreOpen}
      title="更多：按路径打开、显示忽略的文件、全部折叠、重新读取"
      bind:this={moreButton}
      onclick={toggleMore}
    >
      <Icon name="more" size={14} />
      {#if includeIgnored}<span class="tool-dot" aria-hidden="true"></span>{/if}
    </button>
  </div>
</div>

{#if selectedRows.length > 0}
  <div class="file-selection-bar">
    <span role="status"><Icon name="check" size={12} />已选 {selectedRows.length} 项</span>
    <span class="spacer"></span>
    {#if onCopyPath}<button type="button" class="link-btn" onclick={() => copySelected()}>复制路径</button>{/if}
    {#if onReveal}<button type="button" class="link-btn" onclick={revealSelected}>系统定位</button>{/if}
    <button type="button" class="icon-btn sm" aria-label="取消多选" title="取消多选（Esc）" onclick={onClearSelection}><Icon name="x" size={12} /></button>
  </div>
{/if}

{#if filterNote && !(filterError && rows.length === 0)}
  <p class="file-tree-status" class:danger={filterNote.danger} role={filterNote.danger ? "alert" : "status"}>
    <span>{filterNote.text}</span>
    {#if filterNote.danger && onRetryFilter}
      <button
        type="button"
        class="link-btn"
        data-search-retry="tree"
        title="用同一个过滤词重跑一次全仓库补齐"
        disabled={filterBusy}
        onclick={onRetryFilter}
      >重试补齐</button>
    {/if}
  </p>
{:else if includeIgnored && !query}
  <p class="file-tree-status" role="status">
    <Icon name="eye" size={12} /><span>正在显示被忽略的文件</span>
    <button type="button" class="link-btn" onclick={() => onIncludeIgnored(false)}>隐藏</button>
  </p>
{/if}

<div
  class="file-tree"
  role="tree"
  aria-label="仓库文件"
  aria-multiselectable="true"
  aria-busy={loading}
  tabindex="0"
  bind:this={list}
  onkeydown={onKey}
  onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
  bind:clientHeight={viewport}
>
  {#if rows.length === 0}
    {#if failure}
      <div class="empty compact" role="alert">
        <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
        <strong>无法读取这个目录</strong>
        <p>{failure}</p>
        <button type="button" class="btn btn-secondary btn-sm" onclick={onRefresh}>重新读取</button>
      </div>
    {:else if loading}
      <div class="file-tree-skeleton" role="status" aria-label="正在读取目录">
        {#each [62, 48, 70, 40, 56, 66] as width, index (index)}
          <span style={`width:${width}%`}></span>
        {/each}
      </div>
    {:else if query}
      {#if filterError}
        <div class="empty compact" role="alert">
          <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
          <strong>全仓库补齐失败</strong>
          <p>{filterError}已展开的目录里也没有匹配——这不代表仓库里没有匹配的路径。</p>
          {#if onRetryFilter}
            <button type="button" class="btn btn-secondary btn-sm" data-search-retry="tree" onclick={onRetryFilter}>重试补齐</button>
          {/if}
        </div>
      {:else if filterBusy}
        <div class="empty compact" role="status" aria-busy="true">
          <span class="spinner"></span>
          <p>正在全仓库补齐匹配</p>
        </div>
      {:else if filterTruncated || filterLimited}
        <div class="empty compact">
          <span class="empty-icon"><Icon name="search" size={22} /></span>
          <strong>结果不完整</strong>
          <p>
            全仓库补齐{filterTruncated ? "已被后端截断" : `只列出了前 ${FILTER_EXTRA_LIMIT} 条`}，没有可显示的匹配行；
            收窄过滤条件可以看出准确结果。
          </p>
        </div>
      {:else if changedOnly}
        <div class="empty compact">
          <span class="empty-icon"><Icon name="filter" size={22} /></span>
          <strong>改动列表里没有匹配的路径</strong>
          <p>仅改动模式只在当前有改动的文件里匹配；关掉它才是全仓库范围。</p>
        </div>
      {:else}
        <div class="empty compact">
          <span class="empty-icon"><Icon name="filter" size={22} /></span>
          <strong>没有匹配的路径</strong>
          <p>已展开的目录与全仓库补齐都没有找到匹配。</p>
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onQuery("")}>清空筛选</button>
        </div>
      {/if}
    {:else if changedOnly}
      <div class="empty compact">
        <span class="empty-icon ok"><Icon name="check" size={22} /></span>
        <strong>当前没有改动的文件</strong>
        <p>工作区是干净的。</p>
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => onChangedOnly?.(false)}>浏览完整仓库</button>
      </div>
    {:else if includeIgnored}
      <div class="empty compact">
        <span class="empty-icon"><Icon name="folder" size={22} /></span>
        <strong>这个仓库里没有可显示的文件</strong>
        <p>被忽略的文件已经一起显示，仍然没有可读条目。</p>
      </div>
    {:else}
      <div class="empty compact">
        <span class="empty-icon"><Icon name="folder" size={22} /></span>
        <strong>这里没有可显示的文件</strong>
        <p>可能是空仓库，也可能只剩被 .gitignore 忽略的文件——它们默认不列出。</p>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          disabled={disabled}
          title={disabled ? BUSY_REASON : "只影响本次浏览，不会改动忽略规则"}
          onclick={() => onIncludeIgnored(true)}
        >
          显示忽略文件
        </button>
      </div>
    {/if}
  {:else}
    <div class="virtual-space" style={`height:${rows.length * FILE_ROW_HEIGHT}px`}>
      {#each visible as row, index (row.path)}
        {@const top = (range.start + index) * FILE_ROW_HEIGHT}
        {@const status = rowStatus(row)}
        {@const isFile = !row.expandable && !row.segment && row.kind === "file"}
        <div
          class="file-tree-row"
          class:segment={row.segment}
          class:ignored={row.ignored}
          class:deleted={row.deleted}
          class:active={row.path === selectedPath}
          class:selected={selectedPaths.has(row.path)}
          data-tone={status?.tone}
          role="treeitem"
          aria-selected={isSelected(row)}
          aria-level={row.depth + 1}
          aria-expanded={row.expandable ? row.expanded : undefined}
          tabindex="-1"
          style={`top:${top}px;height:${FILE_ROW_HEIGHT}px`}
          title={rowHint(row)}
          onclick={(event) => {
            const mode = event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single";
            activate(row, mode);
            focusList();
          }}
          onkeydown={(event) => {
            // 行不进入 Tab 序（焦点在树上），这里只满足可聚焦行件的键盘语义，避免与树的键盘重复处理。
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              open(row);
            }
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            const keepMulti = selectedPaths.has(row.path) && selectedRows.length > 1;
            if (!keepMulti) onSelect(row);
            moreOpen = false;
            menu = { x: event.clientX, y: event.clientY, entries: menuEntries(row), label: keepMulti ? `已选 ${selectedRows.length} 项的操作` : `${row.path} 的操作` };
          }}
        >
          {#if row.depth > 0}<span class="tree-indent" style={`width:${row.depth * INDENT}px`} aria-hidden="true"></span>{/if}
          {#if row.expandable}
            <button
              type="button"
              class="tree-chevron"
              class:open={row.expanded}
              aria-label={row.expanded ? `折叠 ${row.label}` : `展开 ${row.label}`}
              tabindex="-1"
              onclick={(event) => {
                event.stopPropagation();
                onToggle(row);
              }}
            >
              <Icon name="chevron-right" size={12} />
            </button>
          {:else}
            <span class="tree-chevron" aria-hidden="true"></span>
          {/if}
          <span class={`tree-icon ${isFile ? `ft-${fileTone(row.path)}` : row.expandable || row.segment ? "ft-dir" : "ft-plain"}`}>
            <Icon name={rowIcon(row)} size={14} />
          </span>
          <span class="tree-name">{row.label}</span>
          {#if row.splittable}
            <button
              type="button"
              class="tree-split"
              aria-label={`把 ${row.label} 拆成逐级目录`}
              title="拆成逐级目录，恢复按层展开"
              tabindex="-1"
              onclick={(event) => {
                event.stopPropagation();
                onSplit(row);
              }}
            >
              <Icon name="list" size={12} />
            </button>
          {/if}
          <span class="tree-trail">
            {#if row.loading && row.node.children === null}<span class="spinner muted" aria-hidden="true" title="正在读取目录"></span>{/if}
            {#if row.deleted}<span class="tree-tag danger" title="工作区里没有这个文件，只能看改动或历史">已删除</span>{/if}
            {#if row.extra}<span class="tree-tag" title="匹配路径还没展开：点开时逐级读取">全仓库</span>{/if}
            {#if row.ignored}<span class="tree-tag" title="被 .gitignore 忽略">忽略</span>{/if}
            {#if row.error}<span class="tree-note danger">{row.error}</span>{/if}
            {#if row.failure}<span class="tree-note danger" title={row.failure}>读取失败</span>{/if}
            {#if row.empty}<span class="tree-note">空目录</span>{/if}
            {#if status && row.expandable}
              <span
                class={`tree-dot ${status.tone}`}
                title={`${status.label} · 目录下 ${status.count ?? 0} 个改动文件`}
                aria-label={`${status.label}，目录下 ${status.count ?? 0} 个改动文件`}
              ></span>
            {:else if status}
              <span class={`st ${status.tone}`} title={status.label} aria-label={status.label}>{status.letter}</span>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu request={menu} onClose={closeMenu} />
{/if}
