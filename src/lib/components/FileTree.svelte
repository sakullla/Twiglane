<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import { fileTone } from "../file-kind";
  import { FILTER_EXTRA_LIMIT, FILE_ROW_HEIGHT, rowIndex, type ChangeDecorations, type FileSelectionMode, type FileTreeRow, type NameDirection } from "../files.svelte";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { BUSY_REASON } from "../ui";
  import type { FileEntryAction } from "../types";
  import ContextMenu, { isContextKey, pointFor, type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 按需目录树：只渲染后端已读到的直接子项，长列表用固定行高虚拟化。
   * 行本身不发起请求，展开、拆分、选择都由文件视图的状态模块决定，组件只上报动作。
   *
   * 工具条只常驻筛选框。全仓库搜索、只看改动、名称排序、按路径打开、显示忽略、
   * 全部折叠与重新读取都在行的右键菜单里，不另放常驻图标。
   * 单击目录即展开/折叠（同时选中它，供「当前目录」搜索范围使用），单击文件即打开。
   * 行上不渲染选择框；多选仍用 Ctrl/Shift 与高亮，数量按点中的行。
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
    /** 把仓库相对路径插入当前终端（加引号、不回车）；由外壳展开终端并换成完整路径。 */
    onInsertToTerminal?: (paths: string[]) => void;
    /** 把仓库相对路径拼成完整路径（仅供「复制完整路径」文本用，不用于系统打开）。 */
    toAbsolute?: (relative: string) => string;
    /** 一个文件是否在当前改动集：有改动才显示「查看改动」。 */
    hasChange?: (path: string) => boolean;
    /** 查看这个文件的改动：路由到既有的差异视图入口。 */
    onViewDiff?: (path: string) => void;
    /** 当前名称排序方向：不是升序时只在右键菜单标明，行顺序由文件 store 派生。 */
    nameDirection?: NameDirection;
    /** 切换名称升/降序：只改显示顺序，不重读目录。 */
    onNameDirection?: (next: NameDirection) => void;
    /**
     * 结构操作上报：只给出动作与右键目标，组件本身不调 api、不做草稿判断。
     * 新建、复制、移动/重命名与删除的规则都在文件视图与外壳里。
     */
    onEntryAction?: (action: FileEntryAction, row: FileTreeRow) => void;
    /** 多选结构操作：目标只含可操作的文件/目录，嵌套选择已收敛为最外层项目。 */
    onBatchEntry?: (action: "copy" | "move" | "delete", rows: FileTreeRow[]) => void;
    /**
     * 加入忽略规则：`local` 为 true 时只写 .git/info/exclude。
     * 与改动列表的右键菜单同一组入口，写入与状态刷新都由外壳执行。
     */
    onIgnore?: (path: string, local: boolean) => void;
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
    onInsertToTerminal,
    toAbsolute,
    hasChange,
    onViewDiff,
    nameDirection = "asc",
    onNameDirection,
    onEntryAction,
    onBatchEntry,
    onIgnore,
  }: Props = $props();

  /** 缩进宽度：与 components.css 的缩进引导线周期一致。 */
  const INDENT = 14;

  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let menu = $state<ContextMenuRequest | null>(null);

  let range = $derived(visibleRange(rows.length, scrollTop, viewport > 0 ? viewport : 0, FILE_ROW_HEIGHT));
  let visible = $derived(rows.slice(range.start, range.end));
  let hasExpanded = $derived(rows.some((row) => row.expandable && row.expanded));
  let selectedRows = $derived(rows.filter((row) => !row.segment && selectedPaths.has(row.path)));
  let batchRows = $derived(
    selectedRows.filter((row) =>
      !entryBlockedReason(row) && !selectedRows.some((other) => other !== row && other.kind === "directory" && row.path.startsWith(`${other.path}/`)),
    ),
  );
  let batchReason = $derived(disabled ? BUSY_REASON : batchRows.length === 0 ? "所选项目都不支持文件操作" : undefined);

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

  /** 删除只有一个入口：回收站还是永久删除由确认框里的选项决定，树不另设动作或快捷键。 */
  function requestDelete(row: FileTreeRow): void {
    if (disabled) return;
    if (selectedPaths.has(row.path) && selectedRows.length > 1 && onBatchEntry) {
      if (batchRows.length > 0) onBatchEntry("delete", batchRows);
      return;
    }
    if (onEntryAction && !entryBlockedReason(row)) onEntryAction("delete", row);
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
          label: selectedRows.length > 1 ? multiMenuLabel() : `${rows[index].path} 的操作`,
        };
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.key === "Delete" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const current = selectedPath ? rowIndex(rows, selectedPath) : -1;
      if (current >= 0) {
        event.preventDefault();
        requestDelete(rows[current]);
      }
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

  function terminalEntry(paths: string[], deleted = false): ContextMenuEntry[] {
    if (!onInsertToTerminal) return [];
    return [{
      id: "insert-terminal",
      label: paths.length > 1 ? "插入所选路径到终端" : "插入路径到终端",
      icon: "terminal",
      disabledReason: deleted ? "文件已删除，工作区里没有它" : undefined,
      run: () => onInsertToTerminal?.(paths),
    }];
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

  /**
   * 结构操作只对普通文件与目录开放：符号链接、特殊文件、嵌套仓库、读取失败的条目
   * 以及仅改动树里的删除墓碑都不是可操作目标；不可用时在菜单里写明原因，不静默隐藏。
   */
  function entryBlockedReason(row: FileTreeRow): string | null {
    if (row.segment) return "这一行只表示目录层级，不是可操作的项目";
    if (row.deleted) return "文件已从工作区删除，不能在这里操作";
    if (row.kind === "symlink") return "符号链接不参与文件操作";
    if (row.kind === "special") return "特殊文件不参与文件操作";
    if (row.kind === "nestedRepository") return "嵌套仓库不参与文件操作";
    if (row.kind === "error") return "这个条目读取失败，不能在这里操作";
    return null;
  }

  function entryActionEntries(row: FileTreeRow): ContextMenuEntry[] {
    if (!onEntryAction) return [];
    const blocked = disabled ? BUSY_REASON : entryBlockedReason(row);
    const run = (action: FileEntryAction) => () => onEntryAction?.(action, row);
    return [
      { id: "create-file", label: "新建文件", icon: "file", disabledReason: blocked ?? undefined, run: run("createFile") },
      { id: "create-directory", label: "新建目录", icon: "folder-plus", disabledReason: blocked ?? undefined, run: run("createDirectory") },
      { id: "copy-entry", label: "复制到…", icon: "copy", disabledReason: blocked ?? undefined, run: run("copy") },
      { id: "move-entry", label: "移动或重命名", icon: "pencil", disabledReason: blocked ?? undefined, run: run("move") },
      { id: "delete-entry", label: "删除…", icon: "trash", danger: true, shortcut: "Delete", disabledReason: blocked ?? undefined, run: run("delete") },
    ];
  }

  /**
   * 忽略入口：与改动列表同一组两项，按右键目标的路径写规则（目录写入后整棵子树都不再列出）。
   * 已在忽略范围内的条目不重复写规则，删除墓碑也不需要，灰显并在菜单里说明原因。
   */
  function ignoreEntries(row: FileTreeRow): ContextMenuEntry[] {
    if (!onIgnore) return [];
    const blocked = disabled
      ? BUSY_REASON
      : row.segment
        ? "这一行只表示目录层级，不是可操作的项目"
        : row.deleted
          ? "文件已从工作区删除，不需要再写忽略规则"
          : row.ignored
            ? "已经处于忽略状态，不会重复写入规则"
            : undefined;
    return [
      { id: "ignore-git", label: "加入 .gitignore", icon: "eye", disabledReason: blocked, run: () => onIgnore?.(row.path, false) },
      { id: "ignore-local", label: "加入 .git/info/exclude", icon: "eye", disabledReason: blocked, run: () => onIgnore?.(row.path, true) },
    ];
  }

  /** 菜单标题与复制/移动/删除的数量用收敛后的目标，不按未收敛的选中行数。 */
  function multiMenuLabel(): string {
    return `已选 ${batchRows.length} 项的操作`;
  }

  /** 被排除的符号链接、特殊文件、嵌套仓库、读取失败条目和删除墓碑：菜单里写明原因。 */
  function blockedNotes(): ContextMenuEntry[] {
    const blocked = selectedRows.filter((row) => entryBlockedReason(row));
    if (blocked.length === 0) return [];
    const notes: ContextMenuEntry[] = [{ heading: "不参与操作" }];
    for (const row of blocked) {
      notes.push({
        id: `excluded-${row.path}`,
        label: row.path,
        icon: "alert-circle",
        disabledReason: entryBlockedReason(row) ?? undefined,
        run: () => {},
      });
    }
    return notes;
  }

  /**
   * 原先工具条上的树级动作：全仓库搜索、只看改动、名称排序，以及「更多」里的按路径打开、
   * 显示忽略、全部折叠、重新读取。单选和多选菜单都挂在这里，不另做常驻按钮。
   */
  function treeActionEntries(): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [];
    if (onSearch) {
      entries.push({
        id: "content-search",
        label: "全仓库搜索",
        icon: "search",
        run: () => onSearch?.("content"),
      });
    }
    if (onChangedOnly) {
      entries.push({
        id: "changed-only",
        label: "只看有改动的文件",
        icon: "file-diff",
        checked: changedOnly,
        run: () => onChangedOnly?.(!changedOnly),
      });
    }
    if (onNameDirection) {
      entries.push({
        id: "name-sort",
        label: `名称${nameDirection === "asc" ? "升序" : "降序"}`,
        icon: nameDirection === "asc" ? "arrow-up" : "arrow-down",
        checked: nameDirection === "desc",
        run: () => onNameDirection?.(nameDirection === "asc" ? "desc" : "asc"),
      });
    }
    if (onSearch) {
      entries.push({
        id: "quick-open",
        label: "按路径打开",
        icon: "file",
        shortcut: `${MODIFIER_LABEL} P`,
        run: () => onSearch?.("path"),
      });
    }
    const tail: ContextMenuEntry[] = [{
      id: "ignored",
      label: "显示忽略的文件",
      icon: "eye",
      checked: includeIgnored,
      run: () => onIncludeIgnored(!includeIgnored),
    }];
    if (onCollapseAll) {
      tail.push({
        id: "collapse",
        label: "全部折叠",
        icon: "chevron-up",
        disabledReason: hasExpanded ? undefined : "没有展开的目录",
        run: () => onCollapseAll?.(),
      });
    }
    tail.push({
      id: "refresh",
      label: "重新读取目录",
      icon: "refresh",
      disabledReason: loading ? "正在读取目录" : undefined,
      run: onRefresh,
    });
    if (entries.length > 0) entries.push({ separator: true });
    entries.push(...tail);
    return entries;
  }

  function appendTreeActions(entries: ContextMenuEntry[]): ContextMenuEntry[] {
    const extra = treeActionEntries();
    if (extra.length === 0) return entries;
    if (entries.length > 0) entries.push({ separator: true });
    entries.push(...extra);
    return entries;
  }

  function batchMenuEntries(): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [{ heading: `已选 ${batchRows.length} 项` }];
    if (onBatchEntry) {
      const run = (action: "copy" | "move" | "delete") => () => onBatchEntry?.(action, batchRows);
      entries.push({ id: "copy-selected", label: `复制 ${batchRows.length} 项到…`, icon: "copy", disabledReason: batchReason, run: run("copy") });
      entries.push({ id: "move-selected", label: `移动 ${batchRows.length} 项到…`, icon: "pencil", disabledReason: batchReason, run: run("move") });
      entries.push({ id: "delete-selected", label: `删除 ${batchRows.length} 项…`, icon: "trash", danger: true, shortcut: "Delete", disabledReason: batchReason, run: run("delete") });
    }
    const notes = blockedNotes();
    if (notes.length > 0) {
      entries.push({ separator: true });
      entries.push(...notes);
    }
    if (onBatchEntry || notes.length > 0) entries.push({ separator: true });
    if (onReveal) {
      entries.push({ id: "reveal-selected", label: "在系统文件管理器中显示", icon: "folder-open", run: revealSelected });
    }
    entries.push(...terminalEntry(selectedRows.map((row) => row.path)));
    if (onCopyPath) {
      entries.push({ separator: true });
      entries.push({ id: "copy-selected-rel", label: "复制所选相对路径", icon: "copy", run: () => copySelected() });
      entries.push({ id: "copy-selected-abs", label: "复制所选完整路径", icon: "copy", run: () => copySelected(true) });
    }
    entries.push({ separator: true });
    entries.push({ id: "select-all", label: "选择当前列表全部项目", icon: "select-all", shortcut: `${MODIFIER_LABEL} A`, run: onSelectAll });
    entries.push({ id: "clear-selected", label: "取消多选", icon: "x", shortcut: "Esc", run: onClearSelection });
    return appendTreeActions(entries);
  }

  function menuEntries(row: FileTreeRow): ContextMenuEntry[] {
    if (selectedPaths.has(row.path) && selectedRows.length > 1) return batchMenuEntries();
    const entries: ContextMenuEntry[] = [];
    if (row.expandable) {
      // 目录：展开/折叠 → 系统定位该目录 → 路径复制 → 忽略规则。
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
      const directoryActions = entryActionEntries(row);
      if (directoryActions.length > 0) {
        entries.push({ separator: true });
        entries.push(...directoryActions);
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
      const terminal = terminalEntry([row.path]);
      if (terminal.length > 0) {
        if (!onReveal) entries.push({ separator: true });
        entries.push(...terminal);
      }
      const copies = copyEntries(row, "复制目录名");
      if (copies.length > 0) {
        entries.push({ separator: true });
        entries.push(...copies);
      }
      const directoryIgnores = ignoreEntries(row);
      if (directoryIgnores.length > 0) {
        entries.push({ separator: true });
        entries.push(...directoryIgnores);
      }
      return appendTreeActions(entries);
    }

    // 文件：应用内查看（打开 / 有改动时查看改动 / 文件历史） → 系统操作（定位 / 默认程序打开） → 路径复制 → 忽略规则。
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
    const fileActions = entryActionEntries(row);
    if (fileActions.length > 0) {
      entries.push({ separator: true });
      entries.push(...fileActions);
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
    const terminal = terminalEntry([row.path], row.deleted);
    if (terminal.length > 0) {
      if (!onReveal && !onOpenDefault) entries.push({ separator: true });
      entries.push(...terminal);
    }
    const copies = copyEntries(row, "复制文件名");
    if (copies.length > 0) {
      entries.push({ separator: true });
      entries.push(...copies);
    }
    const ignores = ignoreEntries(row);
    if (ignores.length > 0) {
      entries.push({ separator: true });
      entries.push(...ignores);
    }
    return appendTreeActions(entries);
  }

  function openSelectionMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: rect.left,
      y: rect.bottom + 4,
      entries: batchMenuEntries(),
      label: multiMenuLabel(),
    };
  }

  function closeMenu(): void {
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
  /** 过滤说明已经占着树上方时，不再叠一层模式说明。 */
  let showModeNotes = $derived(!(filterNote && !(filterError && rows.length === 0)));
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
</div>

{#if selectedRows.length > 0}
  <div class="file-selection-bar">
    <span role="status"><Icon name="check-circle" size={13} />已选 {selectedRows.length} 项</span>
    <span class="spacer"></span>
    {#if onCopyPath}<button type="button" class="link-btn" onclick={() => copySelected()}>复制路径</button>{/if}
    <button type="button" class="btn btn-secondary btn-sm" aria-haspopup="menu" onclick={openSelectionMenu}>
      批量操作<Icon name="chevron-down" size={11} />
    </button>
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
{/if}
{#if showModeNotes && changedOnly && !query}
  <p class="file-tree-status" role="status">
    <Icon name="file-diff" size={12} /><span>正在只看有改动的文件</span>
    <button type="button" class="link-btn" onclick={() => onChangedOnly?.(false)}>显示全部</button>
  </p>
{/if}
{#if showModeNotes && includeIgnored && !query}
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
          aria-label={row.path}
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
            // 补齐行还没读进当前树。右键若走 onSelect 会立刻定位并清掉过滤，菜单里的树级动作就点不到了。
            // 左键和菜单里的「打开」仍然定位。
            if (!keepMulti && !row.extra) onSelect(row);
            menu = { x: event.clientX, y: event.clientY, entries: menuEntries(row), label: keepMulti ? multiMenuLabel() : `${row.path} 的操作` };
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
