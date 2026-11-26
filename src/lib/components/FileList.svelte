<script lang="ts">
  import { tick } from "svelte";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { matchParts } from "../history";
  import { bucketByDirectory, filterRows, groupFiles } from "../labels";
  import type { DiffSide, FileChange, FileRow, FileSelection } from "../types";
  import {
    ALL_REVIEWED,
    BUSY_REASON,
    NO_REVIEW_FILES,
    batchTargets,
    rangeSelection,
    rowMark,
    rowsInSelection,
    sameSelection,
    splitPath,
    toggleSelection,
    type ReviewQueueState,
  } from "../ui";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";

  type StatusFilter = "all" | "modified" | "added" | "deleted" | "renamed";

  const STATUS_FILTERS: readonly { id: StatusFilter; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "modified", label: "修改" },
    { id: "added", label: "新增与未跟踪" },
    { id: "deleted", label: "删除" },
    { id: "renamed", label: "重命名" },
  ];

  const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
    all: "全部",
    modified: "修改",
    added: "新增与未跟踪",
    deleted: "删除",
    renamed: "重命名",
  };

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
    /** 多选批量操作条：未传时分别回退到 onStageAll/onUnstageAll/onBatch 或剪贴板。 */
    onBatchStage?: (paths: string[]) => void;
    onBatchUnstage?: (paths: string[]) => void;
    onBatchDiscard?: (paths: string[]) => void;
    onBatchCopyPaths?: (paths: string[]) => void;
    onClearMultiSelect?: () => void;
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
    /**
     * 上一/下一未审阅与队尾状态：与 review.prev / review.next 命令读同一份，
     * 因此按钮、命令面板和快捷键不会给出不同结论。
     */
    reviewNav?: ReviewQueueState | null;
    /** 任务队列的整文件真实写入：把这条路径按真实工作区内容暂存到索引。 */
    onStageFile?: (path: string) => void;
    /** 任务队列的反向真实写入：这条路径在真实状态里只有已暂存一侧时取消暂存。 */
    onUnstageFile?: (path: string) => void;
    /**
     * 任务行在真实 Git 状态里的那一侧。任务净差异只有一条结果，行侧别不代表真实索引状态，
     * 所以行内按钮、空格与文案的方向都由这份判定给出，不能一律写成「暂存」。
     */
    stageSideFor?: (path: string) => DiffSide | "none";
    /**
     * 任务队列：同一套虚拟化、目录分组、搜索与键盘导航，但分组表头改称「任务文件」。
     * 任务净差异本身只读；行内与空格唯一的写入是整文件暂存/取消暂存这一条真实动作。
     */
    variant?: "changes" | "task";
    /** 搜索框的 id：改动与任务视图同时保活，id 不能重复。 */
    searchId?: string;
    /**
     * 审查队列的筛选结果（未审阅 / 有意见）：只决定哪些行显示，分组数量、进度与提交范围不变。
     * null 表示不筛选。
     */
    visiblePaths?: ReadonlySet<string> | null;
    /** 筛选后没有可见文件时的说明与「清除筛选」。 */
    filterEmpty?: { message: string; onClear: () => void } | null;
    /** 行内附注（如失效撤销的原因）：文字 + 图标，不只靠颜色。 */
    rowNotes?: ReadonlyMap<string, { label: string; reason: string }>;
    /**
     * 搜索框的内容搜索模式（审查队列）：开启后关键词按文件内容匹配，名称不再参与筛选，
     * 命中范围由调用方经 visiblePaths 给出；busy 时在框内转圈，note 是一句就地说明。
     */
    contentSearch?: {
      active: boolean;
      busy: boolean;
      note: string | null;
      onToggle: (next: boolean) => void;
    } | null;
    /** 内容搜索的每个文件命中行数：行尾标出「N 处」。 */
    rowHits?: ReadonlyMap<string, number> | null;
  }

  type SectionSide = DiffSide | "conflicted";
  type Item =
    | { kind: "header"; side: SectionSide; count: number; paths: string[]; collapsed: boolean }
    | { kind: "dir"; side: SectionSide; directory: string; label: string; count: number; paths: string[]; collapsed: boolean }
    | { kind: "row"; row: FileRow };

  // 分组、分组折叠与变更状态筛选只改呈现，不写入设置。
  let directoryMode = $state(false);
  let collapsedDirs = $state<Set<string>>(new Set());
  let collapsedSections = $state<Set<SectionSide>>(new Set());
  let statusFilter = $state<StatusFilter>("all");
  let statusMenuOpen = $state(false);
  let statusMenuAnchor = $state<HTMLDivElement | null>(null);
  let statusMenuTrigger = $state<HTMLButtonElement | null>(null);
  let statusMenu = $state<HTMLDivElement | null>(null);
  let statusMenuStyle = $state("");

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
    onBatchStage,
    onBatchUnstage,
    onBatchDiscard,
    onBatchCopyPaths,
    onClearMultiSelect,
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
    reviewNav = null,
    onStageFile,
    onUnstageFile,
    stageSideFor,
    variant = "changes",
    searchId = "file-search",
    visiblePaths = null,
    filterEmpty = null,
    rowNotes,
    contentSearch = null,
    rowHits = null,
  }: Props = $props();
  /** 名称筛选用的关键词：内容搜索模式下名称不参与筛选，也不在行上标出命中。 */
  let nameQuery = $derived(contentSearch?.active ? "" : query);
  /** 任务队列的侧别：没有判定函数时退回「未暂存」，改动队列不用这一份。 */
  function taskSide(row: FileRow): DiffSide | "none" {
    return stageSideFor?.(row.path) ?? "unstaged";
  }
  let taskMode = $derived(variant === "task");
  /** 任务行空格/双击没有执行时的就地说明：纯键盘操作不能静默无反应。 */
  let stageNote = $state<string | null>(null);
  /**
   * 审阅辅助条按需展开：主工具行只留搜索、进度胶囊与排列切换；一旦出现审阅进度
   * （标过任意文件）就自动展开一次；「隐藏已审阅」生效期间强制展开，恢复入口必须够得着。
   */
  let reviewToolsOpen = $state(false);
  $effect(() => {
    if (reviewReviewed > 0 || hideReviewed) reviewToolsOpen = true;
  });
  let reviewToolsShown = $derived(reviewToolsOpen);
  let groups = $derived(groupFiles(files));
  let conflictedRows = $derived(filterRows(groups.conflicted, nameQuery));
  let unstagedRows = $derived(filterRows(groups.unstaged, nameQuery));
  let stagedRows = $derived(filterRows(groups.staged, nameQuery));

  function sectionLabel(side: SectionSide): string {
    if (side === "conflicted") return "冲突";
    if (taskMode) return "任务文件";
    return side === "unstaged" ? "未暂存的改动" : "已暂存";
  }

  function matchesStatusFilter(row: FileRow, filter: StatusFilter): boolean {
    if (filter === "all") return true;
    if (row.unmerged) return false;
    if (row.untracked) return filter === "added";
    const kind = row.side === "staged" ? row.staged : row.unstaged;
    switch (filter) {
      case "modified":
        return kind === "modified" || kind === "typeChanged";
      case "added":
        return kind === "added" || kind === "copied";
      case "deleted":
        return kind === "deleted";
      case "renamed":
        return kind === "renamed";
    }
  }

  function toggleSection(side: SectionSide) {
    const next = new Set(collapsedSections);
    if (next.has(side)) next.delete(side);
    else next.add(side);
    collapsedSections = next;
  }

  function statusMenuItems(): HTMLButtonElement[] {
    if (!statusMenu) return [];
    return [...statusMenu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')];
  }

  async function toggleStatusMenu(focusFirst = false) {
    if (statusMenuOpen) {
      statusMenuOpen = false;
      return;
    }
    const rect = statusMenuTrigger?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      const right = Math.max(8, window.innerWidth - rect.right);
      const top = Math.max(8, rect.bottom + 4);
      statusMenuStyle = `position:fixed;top:${top}px;right:${right}px;left:auto`;
    }
    statusMenuOpen = true;
    if (focusFirst) {
      await tick();
      const items = statusMenuItems();
      const current = items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0];
      current?.focus();
    }
  }

  async function closeStatusMenu(restoreFocus = false) {
    statusMenuOpen = false;
    if (restoreFocus) {
      await tick();
      statusMenuTrigger?.focus();
    }
  }

  function selectStatusFilter(next: StatusFilter) {
    statusFilter = next;
    void closeStatusMenu(true);
  }

  function onStatusMenuKey(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void closeStatusMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = statusMenuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") {
      items[0]?.focus();
      return;
    }
    if (event.key === "End") {
      items[items.length - 1]?.focus();
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

  $effect(() => {
    if (!statusMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (statusMenuAnchor && !statusMenuAnchor.contains(event.target as Node)) {
        statusMenuOpen = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeStatusMenu(true);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  /**
   * 分组只由全部行决定：隐藏已审阅与变更状态筛选只影响显示出来的行，
   * 表头数量与「全部暂存 / 全部取消暂存」的路径范围仍是完整分组。
   */
  function sectionItems(
    rows: FileRow[],
    shown: FileRow[],
    side: SectionSide,
    paths: string[],
  ): Item[] {
    if (rows.length === 0) return [];
    const collapsed = collapsedSections.has(side);
    const header: Item = { kind: "header", side, count: rows.length, paths, collapsed };
    if (collapsed) return [header];
    if (!directoryMode) return [header, ...shown.map((row) => ({ kind: "row" as const, row }))];
    const needle = (contentSearch?.active ? query : nameQuery).trim();
    const items: Item[] = [header];
    for (const bucket of bucketByDirectory(shown)) {
      const key = `${side}:${bucket.directory}`;
      const dirCollapsed = collapsedDirs.has(key) && needle === "";
      items.push({
        kind: "dir",
        side,
        directory: bucket.directory,
        label: bucket.directory || "仓库根目录",
        count: bucket.rows.length,
        paths: bucket.rows.filter((row) => !row.unmerged).map((row) => row.path),
        collapsed: dirCollapsed,
      });
      if (!dirCollapsed) {
        for (const row of bucket.rows) items.push({ kind: "row", row });
      }
    }
    return items;
  }

  function shownRows(list: FileRow[]): FileRow[] {
    const filter = visiblePaths;
    if (!hideReviewed && !filter && statusFilter === "all") return list;
    return list.filter(
      (row) =>
        (!hideReviewed || !reviewed.has(row.path)) &&
        (!filter || filter.has(row.path)) &&
        matchesStatusFilter(row, statusFilter),
    );
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
  /** 满足全部筛选条件的行（不受分组折叠影响），用于空状态与匹配计数。 */
  let matchedRows = $derived([...conflictedShown, ...unstagedShown, ...stagedShown]);
  /** 当前展开分组中可键盘导航与框选的行。 */
  let rows = $derived([
    ...(collapsedSections.has("conflicted") ? [] : conflictedShown),
    ...(collapsedSections.has("unstaged") ? [] : unstagedShown),
    ...(collapsedSections.has("staged") ? [] : stagedShown),
  ]);
  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let range = $derived(
    visibleRange(items.length, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let visible = $derived(items.slice(range.start, range.end));
  let total = $derived(groups.conflicted.length + groups.unstaged.length + groups.staged.length);

  let multi = $derived(selectedSet.length > 1);
  let allGroupRows = $derived([...groups.conflicted, ...groups.unstaged, ...groups.staged]);
  let multiRows = $derived(multi ? rowsInSelection(allGroupRows, selectedSet) : []);
  let multiTargets = $derived(batchTargets(multiRows));
  let multiPaths = $derived([...new Set(multiRows.map((row) => row.path))]);

  function exitMultiSelect() {
    if (onClearMultiSelect) {
      onClearMultiSelect();
    } else {
      const target = selected ?? selectedSet[0];
      if (target) single(target);
    }
    list?.focus({ preventScroll: true });
  }

  function runBatchStage() {
    if (disabled || multiTargets.stage.length === 0) return;
    if (onBatchStage) onBatchStage(multiTargets.stage);
    else if (onStageAll) onStageAll(multiTargets.stage);
    else onBatch?.("unstaged");
  }

  function runBatchUnstage() {
    if (disabled || multiTargets.unstage.length === 0) return;
    if (onBatchUnstage) onBatchUnstage(multiTargets.unstage);
    else if (onUnstageAll) onUnstageAll(multiTargets.unstage);
    else onBatch?.("staged");
  }

  function runBatchCopyPaths() {
    if (multiPaths.length === 0) return;
    if (onBatchCopyPaths) {
      onBatchCopyPaths(multiPaths);
    } else {
      void navigator.clipboard?.writeText(multiPaths.join("\n"));
    }
  }
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
    stageNote = null;
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
    const needle = nameQuery.trim();
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
    // 任务净差异本身只读；空格与双击在这里只做整文件暂存/取消暂存这一条真实写入，
    // 方向按真实 Git 状态走，和行内按钮的 aria-label/title 是同一份判定。
    if (taskMode) {
      if (disabled) {
        stageNote = BUSY_REASON;
        return;
      }
      const side = taskSide(row);
      // 真实 Git 状态里两侧都没有改动（任务净差异来自提交）：按钮已禁用，
      // 空格与双击也必须就地说明，不能静默什么都不发生。
      if (side === "none") {
        stageNote = `${row.path} 在真实 Git 状态里没有未提交或已暂存的改动，空格不能把它写进索引。`;
        return;
      }
      stageNote = null;
      if (side === "staged") {
        if (onUnstageFile) onUnstageFile(row.path);
        else onStageFile?.(row.path);
      } else if (side === "unstaged") {
        onStageFile?.(row.path);
      }
      return;
    }
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
    if (event.key === "Escape" && multi && selected) {
      event.preventDefault();
      event.stopPropagation();
      exitMultiSelect();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "/" && !event.shiftKey) {
      event.preventDefault();
      document.getElementById(searchId)?.focus();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "k") && !event.shiftKey && current === 0) {
      event.preventDefault();
      document.getElementById(searchId)?.focus();
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

<!-- 主工具行：全宽自适应搜索 + 紧凑审阅进度胶囊 + 排列切换。
     未审阅跳转与隐藏已审阅收进下方按需展开的审阅辅助条，不再与搜索争夺一行。 -->
<div class="file-tools">
  <div class="field sm">
    <Icon name="search" size={14} />
    <input
      id={searchId}
      aria-label={contentSearch?.active ? "搜索任务文件内容" : taskMode ? "搜索任务文件" : "搜索改动文件"}
      placeholder={contentSearch?.active ? "搜索文件内容" : "搜索文件"}
      autocomplete="off"
      spellcheck="false"
      value={query}
      oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
      onkeydown={onSearchKey}
    />
    {#if contentSearch?.busy}
      <span class="spinner field-spinner" aria-hidden="true"></span>
    {/if}
    {#if query}
      {#if total > 0 && !contentSearch?.busy}
        <span class="field-count" title={`当前匹配 ${matchedRows.length} 条，共 ${total} 条`}>{matchedRows.length}/{total}</span>
      {/if}
      <button type="button" class="field-clear" aria-label="清空筛选" onclick={() => onQuery("")}>
        <Icon name="x" size={12} />
      </button>
    {/if}
    {#if contentSearch}
      <button
        type="button"
        class="field-mode"
        aria-pressed={contentSearch.active}
        aria-label="按文件内容搜索"
        title={contentSearch.active ? "正在按文件内容搜索；点击改回按文件名搜索" : "改为按文件内容搜索（在任务文件的当前内容里找关键词）"}
        onclick={() => contentSearch?.onToggle(!contentSearch.active)}
      ><Icon name="code" size={13} /></button>
    {/if}
  </div>
  <div class="menu-anchor status-filter-anchor" bind:this={statusMenuAnchor}>
    <button
      type="button"
      class="icon-btn sm status-filter-btn"
      data-active={statusFilter !== "all" ? "true" : undefined}
      aria-label="按变更状态筛选"
      aria-haspopup="menu"
      aria-expanded={statusMenuOpen}
      title={statusFilter === "all" ? "按变更状态筛选" : `当前状态筛选：${STATUS_FILTER_LABEL[statusFilter]}（点击切换）`}
      bind:this={statusMenuTrigger}
      onclick={(event) => void toggleStatusMenu(event.detail === 0)}
      onkeydown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          void toggleStatusMenu(true);
        }
      }}
    >
      <Icon name="filter" size={14} />
    </button>
    {#if statusMenuOpen}
      <div
        class="menu status-filter-menu"
        role="menu"
        tabindex="-1"
        aria-label="变更状态筛选"
        style={statusMenuStyle}
        bind:this={statusMenu}
        onkeydown={onStatusMenuKey}
      >
        {#each STATUS_FILTERS as option (option.id)}
          <button
            type="button"
            class="menu-item"
            role="menuitemradio"
            aria-checked={statusFilter === option.id}
            onclick={() => selectStatusFilter(option.id)}
          >
            <span class="status-check" aria-hidden="true">
              {#if statusFilter === option.id}<Icon name="check" size={13} />{/if}
            </span>
            <span>{option.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {#if onToggleReview || reviewTotal > 0}
    {@const ratio = reviewTotal > 0 ? Math.min(1, reviewReviewed / reviewTotal) : 0}
    {@const done = reviewTotal > 0 && reviewReviewed >= reviewTotal}
    <span
      class="review-count"
      class:done
      role="status"
      aria-label={`已审阅 ${reviewReviewed} 个，共 ${reviewTotal} 个${taskMode ? "任务文件" : "改动文件"}`}
      title="已审阅数是本地人工进度，不代表批准、提交或 Cliora 结果"
    >
      {#if done}
        <Icon name="check-circle" size={13} />
      {:else}
        <!-- 进度环：一眼看出还剩多少，比纯数字更容易在连续审阅时感知推进。 -->
        <svg class="review-ring" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6" pathLength="100" />
          {#if ratio > 0}<circle class="review-ring-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray={`${ratio * 100} 100`} />{/if}
        </svg>
      {/if}{reviewReviewed}/{reviewTotal}
    </span>
  {/if}
  {#if reviewNav || onHideReviewed}
    <button
      type="button"
      class="icon-btn sm review-tools-toggle"
      data-active={hideReviewed && !reviewToolsShown ? "true" : undefined}
      aria-expanded={reviewToolsShown}
      aria-label="审阅工具"
      title={reviewToolsShown
        ? "收起审阅工具（未审阅跳转、隐藏已审阅）"
        : hideReviewed
          ? "展开审阅工具（当前已隐藏已审阅文件）"
          : "展开审阅工具：未审阅跳转、隐藏已审阅"}
      onclick={() => (reviewToolsOpen = !reviewToolsOpen)}
    >
      <Icon name="chevron-down" size={14} class={reviewToolsShown ? "flip" : ""} />
    </button>
  {/if}
  <div class="segmented icon-segmented" role="group" aria-label="文件排列">
    <button type="button" aria-pressed={!directoryMode} aria-label="列表" title="平铺列表" onclick={() => (directoryMode = false)}><Icon name="list" size={14} /></button>
    <button type="button" aria-pressed={directoryMode} aria-label="目录" title="按目录分组" onclick={() => (directoryMode = true)}><Icon name="folder" size={14} /></button>
  </div>
</div>
{#if statusFilter !== "all"}
  <div class="status-filter-bar" role="status">
    <span class="status-filter-chip">
      <Icon name="filter" size={12} />
      <span>状态：{STATUS_FILTER_LABEL[statusFilter]}</span>
      <span class="status-filter-count">{matchedRows.length}/{total}</span>
    </span>
    <span class="spacer"></span>
    <button
      type="button"
      class="btn btn-ghost btn-sm status-filter-clear"
      aria-label="清除状态筛选"
      onclick={() => (statusFilter = "all")}
    >
      <Icon name="x" size={12} />
      <span>清除</span>
    </button>
  </div>
{/if}
{#if multi}
  <div class="file-batch-bar" role="region" aria-label="多选批量操作">
    <div class="file-batch-summary">
      <strong>已选中 {selectedSet.length} 项</strong>
      {#if multiTargets.conflicts > 0}
        <span class="file-batch-note" title="冲突文件不参与批量暂存或放弃">含 {multiTargets.conflicts} 个冲突</span>
      {/if}
      <span class="spacer"></span>
      <button
        type="button"
        class="icon-btn sm file-batch-exit"
        aria-label="退出多选"
        title="退出多选（Esc）"
        onclick={exitMultiSelect}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
    <div class="file-batch-actions" role="group" aria-label="批量操作">
      {#if !taskMode && multiTargets.stage.length > 0 && (onBatchStage || onStageAll || onBatch)}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={disabled}
          aria-label="批量暂存"
          title={disabled
            ? BUSY_REASON
            : multiTargets.conflicts > 0
              ? `暂存 ${multiTargets.stage.length} 个未暂存文件（已自动排除 ${multiTargets.conflicts} 个冲突文件）`
              : `暂存选中的 ${multiTargets.stage.length} 个未暂存文件`}
          onclick={runBatchStage}
        >
          <Icon name="plus" size={12} /><span>暂存</span>
        </button>
      {/if}
      {#if !taskMode && multiTargets.unstage.length > 0 && (onBatchUnstage || onUnstageAll || onBatch)}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={disabled}
          aria-label="批量取消暂存"
          title={disabled ? BUSY_REASON : `取消暂存选中的 ${multiTargets.unstage.length} 个已暂存文件`}
          onclick={runBatchUnstage}
        >
          <Icon name="minus" size={12} /><span>取消暂存</span>
        </button>
      {/if}
      {#if !taskMode && onBatchDiscard && multiTargets.discard.length > 0}
        <button
          type="button"
          class="btn btn-ghost btn-sm file-batch-danger"
          disabled={disabled}
          aria-label="批量放弃修改"
          title={disabled
            ? BUSY_REASON
            : multiTargets.conflicts > 0
              ? `放弃 ${multiTargets.discard.length} 个文件的修改（已自动排除 ${multiTargets.conflicts} 个冲突文件）`
              : `放弃选中的 ${multiTargets.discard.length} 个文件的修改`}
          onclick={() => onBatchDiscard?.(multiTargets.discard)}
        >
          <Icon name="undo" size={12} /><span>放弃</span>
        </button>
      {/if}
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        aria-label="复制已选路径"
        title={`复制 ${multiPaths.length} 个文件路径`}
        onclick={runBatchCopyPaths}
      >
        <Icon name="copy" size={12} /><span>复制路径</span>
      </button>
    </div>
  </div>
{/if}
{#if reviewToolsShown}
  <!-- 审阅辅助条：未审阅跳转与隐藏已审阅。按钮与 review.prev/next 命令同源。 -->
  <div class="review-bar" role="group" aria-label="审阅工具">
    {#if reviewNav}
      <!-- 连续审阅：只在未审阅文件之间走，到队尾停下，不回到开头。 -->
      <div class="file-nav" role="group" aria-label="未审阅文件">
        <button
          type="button"
          class="icon-btn sm"
          aria-label="上一个未审阅文件"
          title={reviewNav.prevReason ?? "上一个未审阅文件（Alt+Shift+←）"}
          disabled={reviewNav.prevReason !== null}
          onclick={reviewNav.onPrev}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          class="icon-btn sm"
          aria-label="下一个未审阅文件"
          title={reviewNav.nextReason ?? "下一个未审阅文件（Alt+Shift+→）"}
          disabled={reviewNav.nextReason !== null}
          onclick={reviewNav.onNext}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
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
{/if}
{#if contentSearch?.active && contentSearch.note}
  <p class="file-tree-status" role="status">{contentSearch.note}</p>
{/if}
{#if reviewNote}
  <p class="file-tree-status danger" role="alert">{reviewNote}</p>
{/if}
{#if stageNote}
  <p class="file-tree-status" role="status">{stageNote}</p>
{/if}
{#if reviewNav && reviewNav.total > 0 && reviewNav.remaining === 0 && matchedRows.length > 0 && (!visiblePaths || reviewReviewed >= reviewTotal)}
  <!-- 队尾/全部完成的下一步：隐藏已审阅，或按真实暂存范围提交；都不改任务范围。 -->
  <p class="file-tree-status review-done" role="status">
    <Icon name="check-circle" size={13} />
    <span>{ALL_REVIEWED}</span>
    {#if onHideReviewed && !hideReviewed}
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => onHideReviewed?.(true)}>收起已审阅</button>
    {/if}
  </p>
{:else if reviewNav && reviewNav.total === 0 && query.trim() === "" && !visiblePaths}
  <p class="file-tree-status" role="status"><span>{NO_REVIEW_FILES}。</span></p>
{/if}
<div
  class="file-list"
  role="listbox"
  aria-label={taskMode ? "任务文件" : "改动文件"}
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
  {:else if matchedRows.length === 0 && filterEmpty}
    <!-- 空状态零：审查队列的筛选段没有命中。清除筛选恢复完整队列，进度与记录不变。 -->
    <div class="empty">
      <span class="empty-icon"><Icon name="search" size={22} /></span>
      <strong>{filterEmpty.message}</strong>
      <button type="button" class="btn btn-secondary btn-sm" onclick={filterEmpty.onClear}>清除筛选</button>
    </div>
  {:else if matchedRows.length === 0 && statusFilter !== "all"}
    <!-- 空状态：变更状态筛选（可叠加关键词）没有命中。 -->
    <div class="empty">
      <span class="empty-icon"><Icon name="filter" size={22} /></span>
      <strong>没有符合「{STATUS_FILTER_LABEL[statusFilter]}」的文件</strong>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        onclick={() => {
          statusFilter = "all";
          if (query.trim()) onQuery("");
        }}
      >清除筛选</button>
    </div>
  {:else if matchedRows.length === 0 && hideReviewed}
    <!-- 空状态一：已审阅的文件被隐藏。 -->
    <div class="empty">
      <span class="empty-icon ok"><Icon name="check-circle" size={22} /></span>
      <strong>已审阅的文件都隐藏了</strong>
      {#if onHideReviewed}
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => onHideReviewed?.(false)}>显示已审阅</button>
      {/if}
    </div>
  {:else if matchedRows.length === 0 && query.trim() !== ""}
    <!-- 空状态二：筛选没有结果。下一步是清掉筛选，而不是换一个范围。 -->
    <div class="empty">
      <span class="empty-icon"><Icon name="search" size={22} /></span>
      <strong>没有匹配的文件</strong>
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => onQuery("")}>清除筛选</button>
    </div>
  {:else if matchedRows.length === 0}
    <!-- 空状态三：范围内没有未审阅文件可继续，或本来就没有文件。 -->
    <div class="empty">
      <span class="empty-icon ok"><Icon name="check-circle" size={22} /></span>
      <strong>{reviewNav?.total ? ALL_REVIEWED : NO_REVIEW_FILES}</strong>
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
            class:collapsed={item.collapsed}
            role="presentation"
            style={`top:${top}px;height:${ROW_HEIGHT}px`}
          >
            <button
              type="button"
              class="file-group-toggle"
              aria-expanded={!item.collapsed}
              aria-label={`${sectionLabel(item.side)}（${item.count}）`}
              title={item.collapsed ? `展开${sectionLabel(item.side)}` : `折叠${sectionLabel(item.side)}`}
              onclick={() => toggleSection(item.side)}
            >
              <Icon name={item.collapsed ? "chevron-right" : "chevron-down"} size={13} />
              <span>{sectionLabel(item.side)}</span>
              <span class="count" class:danger={item.side === "conflicted"}>{item.count}</span>
            </button>
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
            {:else if !taskMode && item.side === "unstaged" && onStageAll && item.paths.length > 0}
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
            {#if !taskMode && item.side === "unstaged" && onStageAll && item.paths.length > 0}
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
            {:else if !taskMode && item.side === "staged" && onUnstageAll && item.paths.length > 0}
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
            aria-label={row.path}
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
            {#if onMultiSelect}
              <button
                type="button"
                class="file-check"
                class:checked={multi && isSelected(row)}
                aria-label={multi && isSelected(row) ? `取消选择 ${row.path}` : `选择 ${row.path}`}
                aria-pressed={multi && isSelected(row)}
                tabindex="-1"
                title="选择文件；也可按住 Ctrl 或 Shift 点击行"
                onclick={(event) => {
                  event.stopPropagation();
                  toggleRow(row);
                  list?.focus({ preventScroll: true });
                }}
              ><Icon name="check" size={11} /></button>
            {/if}
            <span class={`st ${mark.tone}`} title={mark.label} aria-label={mark.label}>{mark.letter}</span>
            <span class="file-name">
              <span class="fn">{#if nameQuery.trim()}{#each matchParts(parts.name, nameQuery) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{parts.name}{/if}</span>
              {#if row.originalPath}
                <span class="fd from" title={`重命名自 ${row.originalPath}`}>← {row.originalPath}</span>
              {:else if parts.dir}
                <span class="fd"><bdi>{#if nameQuery.trim()}{#each matchParts(parts.dir, nameQuery) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{parts.dir}{/if}</bdi></span>
              {/if}
            </span>
            {#if rowNotes?.get(row.path)}
              {@const note = rowNotes.get(row.path)!}
              <span class="file-tag revoked" title={note.reason} aria-label={`${note.label}：${note.reason}`}><Icon name="undo" size={11} />{note.label}</span>
            {/if}
            {#if rowHits?.get(row.path)}
              <span class="file-tag hits" title={`当前内容里有 ${rowHits.get(row.path)} 处“${query.trim()}”`}>{rowHits.get(row.path)} 处</span>
            {/if}
            {#if row.rebuilt}
              <span class="file-tag rebuilt" title="起点里有这个路径，工作区里现在是重建后的未跟踪文件；行数只统计重建后的内容，不是纯新增">工作区重建</span>
            {/if}
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
            {#if taskMode}
              <!-- 任务净差异只读；行内唯一写入是整文件暂存/取消暂存，方向按真实 Git 状态。
                   按钮、空格、aria-label 与 title 必须说同一件事，不能宣布与写入相反的动作。 -->
              {#if (onStageFile || onUnstageFile) && !row.unmerged}
                {@const taskStage = taskSide(row)}
                <button
                  type="button"
                  class="row-action"
                  disabled={disabled || taskStage === "none"}
                  aria-label={taskStage === "staged"
                    ? `取消暂存 ${row.path}`
                    : taskStage === "unstaged"
                      ? `暂存 ${row.path} 到索引`
                      : `${row.path} 没有可暂存的真实改动`}
                  title={disabled
                    ? BUSY_REASON
                    : taskStage === "staged"
                      ? "这条路径在索引里只有已暂存内容：取消暂存（空格），任务净差异本身不被改动"
                      : taskStage === "unstaged"
                        ? "把这个文件按真实工作区内容暂存到索引（空格）；任务净差异本身不被暂存"
                        : "任务净差异来自提交：真实工作区与索引里没有可暂存的改动"}
                  onclick={(event) => {
                    event.stopPropagation();
                    if (taskStage === "staged") onUnstageFile?.(row.path);
                    else if (taskStage === "unstaged") onStageFile?.(row.path);
                  }}
                >
                  <Icon name={taskStage === "staged" ? "minus" : "plus"} size={14} />
                </button>
              {/if}
            {:else if row.unmerged}
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

<style>
  .status-filter-anchor {
    position: relative;
    flex: none;
  }

  .status-filter-btn[data-active="true"] {
    color: var(--accent-text);
    background: var(--accent-soft);
  }

  .status-filter-menu {
    min-width: 148px;
    padding: var(--space-4);
    z-index: var(--z-menu);
  }

  .status-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--accent-text);
  }

  .status-filter-bar {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    padding: var(--space-4) var(--space-12);
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-xs);
    color: var(--fg-muted);
  }

  .status-filter-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    color: var(--accent-text);
    font-weight: var(--weight-medium);
    min-width: 0;
  }

  .status-filter-count {
    color: var(--fg-subtle);
    font-variant-numeric: tabular-nums;
  }

  .status-filter-clear {
    height: var(--control-height-xs);
    padding: 0 var(--space-6);
    font-size: var(--text-xs);
  }

  .file-batch-bar {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-6) var(--space-12);
    background: var(--accent-softer);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-xs);
  }

  .file-batch-summary {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    color: var(--fg);
  }

  .file-batch-summary strong {
    font-weight: var(--weight-semibold);
    color: var(--accent-text);
    font-variant-numeric: tabular-nums;
  }

  .file-batch-note {
    color: var(--fg-subtle);
    white-space: nowrap;
  }

  .file-batch-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .file-batch-actions .btn {
    height: var(--control-height-xs);
    padding: 0 var(--space-6);
    font-size: var(--text-xs);
    gap: var(--space-4);
  }

  .file-batch-danger {
    color: var(--danger);
  }

  .file-batch-danger:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger-hover);
  }

  .file-group-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-6);
    min-width: 0;
    padding: var(--space-2) var(--space-4);
    margin-left: calc(var(--space-4) * -1);
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    transition: var(--transition-colors);
  }

  .file-group-toggle:hover {
    background: var(--hover);
    color: var(--fg);
  }

  .file-group-toggle:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
</style>
