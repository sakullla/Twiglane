<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import { LatestReadQueue } from "../latest-read";
  import { LatestBatchReadQueue } from "../latest-batch-read";
  import { api, type HistoryFilters } from "../api";
  import { normalizeError } from "../errors";
  import {
    commitFileLabel,
    commitLineStat,
    commitSelectionRange,
    formatAuthoredAt,
    HISTORY_SEARCH_DEBOUNCE_MS,
    historyConditions,
    historyDayBound,
    historyStatus,
    parentCaption,
    commitBodyRest,
    preferredCommitFile,
    refPills,
    shortOid,
    shouldAppendHistory,
    toggleCommitSelection,
  } from "../history";
  import { bucketByDirectory, filterRows } from "../labels";
  import { clampWidth, MIN_PANEL_WIDTH, nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import type {
    CommitDetail,
    CommitFileChange,
    DiffHunk,
    DiffResponse,
    FileSelection,
    HistoryCommit,
    BranchRecord,
    OpenedRepository,
    StatusSnapshot,
  } from "../types";
  import { BUSY_REASON, fileNavState, hueOf, initialOf, relativeTime, splitPath, statusMark, type FileNavState } from "../ui";
  import BranchPicker from "./BranchPicker.svelte";
  import CommitDiffList from "./CommitDiffList.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import LineCounts from "./LineCounts.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest, isContextKey, pointFor } from "./ContextMenu.svelte";
  import DiffView from "./DiffView.svelte";
  import FileNav from "./FileNav.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import PaneResizer from "./PaneResizer.svelte";

  interface Props {
    /** 设置里的分支分组：范围下拉框按第一个 / 收成 <optgroup>，关闭时平铺。缺省开启。 */
    branchGroups?: boolean;
    opened: OpenedRepository;
    active?: boolean;
    filePath: string | null;
    searchQuery?: string;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onFilePath: (path: string) => void;
    onClearFile: () => void;
    /** 从某个提交新建分支后回写最新状态（切换时工作区与分支都会变）。 */
    onSnapshot?: (snapshot: StatusSnapshot) => void;
    onNotice?: (message: string) => void;
    /** 变更文件的上一个/下一个状态：外壳据此响应 file.prev、file.next。 */
    onFileNav?: (nav: FileNavState | null) => void;
    /** 左栏头部（视图切换与合并提示）和右沿拖动条：由外壳提供，与改动视图是同一份。 */
    paneHead?: Snippet;
    paneResizer?: Snippet;
  }

  const pageReads = new LatestReadQueue();
  const detailReads = new LatestReadQueue();
  const diffReads = new LatestReadQueue();
  const multiDetailReads = new LatestBatchReadQueue();
  const multiDiffReads = new LatestBatchReadQueue();
  onDestroy(() => {
    pageReads.close(); detailReads.close(); diffReads.close();
    multiDetailReads.close(); multiDiffReads.close();
  });

  /** 提交行两行排布（摘要 / 引用·作者·时间），52px；提交里的文件行与改动列表同为单行 30px。 */
  const ROW_HEIGHT = 52;
  const FILE_ROW_HEIGHT = 30;
  const UNION_ROW_HEIGHT = 30;
  const FILES_WIDTH_KEY = "twiglane.commitFilesWidth";
  const DEFAULT_FILES_WIDTH = 248;
  const MIN_DIFF_WIDTH = 360;

  function readFilesWidth(): number {
    try {
      const stored = Number(globalThis.localStorage?.getItem(FILES_WIDTH_KEY));
      return stored > 0 ? clampWidth(stored) : DEFAULT_FILES_WIDTH;
    } catch {
      return DEFAULT_FILES_WIDTH;
    }
  }

  function saveFilesWidth() {
    try {
      globalThis.localStorage?.setItem(FILES_WIDTH_KEY, String(filesWidth));
    } catch {
      // 本机偏好写不进去时只影响下次打开的初始宽度。
    }
  }

  /** 渲染宽度：容器窄时收紧，不改写已保存的宽度。 */
  function fitFilesWidth(width: number, total: number): number {
    if (total <= 0) return width;
    return Math.max(MIN_PANEL_WIDTH, Math.min(width, total - MIN_DIFF_WIDTH));
  }

  let {
    opened,
    active = true,
    filePath,
    searchQuery = "",
    disabled,
    nextId,
    onGeneration,
    onFailure,
    onFilePath,
    onClearFile,
    onSnapshot,
    onNotice,
    onFileNav,
    paneHead,
    paneResizer,
    branchGroups = true,
  }: Props = $props();

  let menu = $state<ContextMenuRequest | null>(null);
  /** 「从此提交新建分支」的输入层。 */
  let branchFrom = $state<{ oid: string; summary: string; name: string; checkout: boolean; busy: boolean; error: string | null } | null>(null);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      onFailure({ code: "clipboard", message: "无法写入剪贴板，请手动复制。" });
    }
  }

  function writeReason(): string | undefined {
    return disabled ? "正在读取或写入，稍后再试" : undefined;
  }

  function orderedSelection(ids: string[]): string[] {
    const chosen = new Set(ids);
    return commits.filter((commit) => chosen.has(commit.oid)).map((commit) => commit.oid);
  }

  function commitMenu(commit: HistoryCommit, point: { x: number; y: number }) {
    let ids = selectedOids;
    if (!ids.includes(commit.oid)) {
      ids = [commit.oid];
      anchorOid = commit.oid;
      selectedOids = ids;
    }
    const ordered = orderedSelection(ids);
    const entries: ContextMenuEntry[] = ordered.length > 1
      ? [
          {
            id: "pick",
            label: "拣选这些提交",
            icon: "merge",
            disabledReason: writeReason(),
            run: () => void runCherryPick(ordered),
          },
          { id: "hash", label: "复制哈希", icon: "copy", run: () => void copyText(ordered.join("\n")) },
        ]
      : [
          {
            id: "pick",
            label: "拣选到当前分支",
            icon: "merge",
            disabledReason: writeReason(),
            run: () => void runCherryPick([commit.oid]),
          },
          {
            id: "checkout",
            label: "检出此提交",
            icon: "commit",
            disabledReason: writeReason(),
            run: () => {
              checkoutError = null;
              checkoutTarget = commit;
            },
          },
          {
            id: "branch",
            label: "从此提交新建分支",
            icon: "branch",
            disabledReason: writeReason(),
            run: () => (branchFrom = { oid: commit.oid, summary: commit.summary, name: "", checkout: true, busy: false, error: null }),
          },
          { id: "hash", label: "复制提交哈希", icon: "copy", run: () => void copyText(commit.oid) },
        ];
    menu = { x: point.x, y: point.y, entries, label: ordered.length > 1 ? `已选 ${ordered.length} 个提交的操作` : `提交 ${shortOid(commit.oid)} 的操作` };
  }

  function fileMenu(relative: string, point: { x: number; y: number }) {
    const entries: ContextMenuEntry[] = [
      { id: "history", label: "查看此文件历史", icon: "history", run: () => onFilePath(relative) },
      { id: "copy", label: "复制相对路径", icon: "copy", run: () => void copyText(relative) },
      { id: "reveal", label: "在系统文件管理器中显示", icon: "folder", run: () => void revealFile(relative) },
    ];
    menu = { x: point.x, y: point.y, entries, label: `文件 ${relative} 的操作` };
  }

  async function revealFile(relative: string) {
    try {
      await api.revealPath(opened.summary.path, relative);
    } catch (error) {
      onFailure(normalizeError(error));
    }
  }

  async function runCherryPick(oids: string[]) {
    if (disabled || oids.length === 0) return;
    try {
      const result = await api.cherryPickCommits(opened.summary.path, oids, opened.generation, nextId());
      onGeneration(result.generation);
      onSnapshot?.(result.snapshot);
      onNotice?.(result.note);
    } catch (error) {
      onFailure(normalizeError(error));
    }
  }

  async function confirmCheckout() {
    const target = checkoutTarget;
    if (!target || checkoutBusy) return;
    checkoutBusy = true;
    checkoutError = null;
    try {
      const snapshot = await api.checkoutCommit(opened.summary.path, target.oid, opened.generation, nextId());
      onGeneration(snapshot.generation);
      onSnapshot?.(snapshot);
      onNotice?.(`已检出 ${shortOid(target.oid)}，当前处于游离 HEAD。`);
      checkoutTarget = null;
    } catch (error) {
      const failure = normalizeError(error);
      checkoutError = failure.message;
      onFailure(failure);
    } finally {
      checkoutBusy = false;
    }
  }

  async function confirmBranchFrom() {
    const target = branchFrom;
    if (!target || target.busy) return;
    const name = target.name.trim();
    if (!name) return;
    branchFrom = { ...target, busy: true, error: null };
    try {
      const result = await api.createBranchFrom(opened.summary.path, name, target.oid, target.checkout, opened.generation, nextId());
      onGeneration(result.generation);
      onSnapshot?.(result.snapshot);
      onNotice?.(
        target.checkout
          ? `已从 ${shortOid(target.oid)} 创建并切换到 ${name}。`
          : `已从 ${shortOid(target.oid)} 创建分支 ${name}，当前分支没有切换。`,
      );
      branchFrom = null;
    } catch (error) {
      const failure = normalizeError(error);
      onFailure(failure);
      if (branchFrom) branchFrom = { ...target, busy: false, error: failure.message };
    }
  }

  let query = $state("");
  let author = $state("");
  let pathFilter = $state("");
  let sinceDay = $state("");
  let untilDay = $state("");
  /** 作者、日期、路径这几项低频筛选默认收起，左栏首屏留给提交列表；有生效条件时由计数提示。 */
  let moreFilters = $state(false);
  let advancedCount = $derived([author, pathFilter, sinceDay, untilDay].filter((value) => value.trim() !== "").length);
  let scope = $state("current");
  let viewMode = $state<"single" | "multi">("single");
  let activeQuery = $state("");
  let activeAuthor = $state("");
  let activePath = $state("");
  let activeSince = $state("");
  let activeUntil = $state("");
  let activeScope = $state("current");
  let lastSearchSeed = "";
  let page = $state.raw<{
    generation: number;
    state: string;
    hasMore: boolean;
    pageSize: number;
    scope: string;
    branches: string[];
    head: string | null;
  } | null>(null);
  let commits = $state.raw<HistoryCommit[]>([]);
  let listError = $state<string | null>(null);
  let appendError = $state<string | null>(null);
  let appendStopped = $state(false);
  let loading = $state(false);
  let selectedOids = $state.raw<string[]>([]);
  let anchorOid = $state<string | null>(null);
  let checkoutTarget = $state<HistoryCommit | null>(null);
  let checkoutBusy = $state(false);
  let checkoutError = $state<string | null>(null);
  let multiDetails = $state.raw<CommitDetail[]>([]);
  let multiError = $state<string | null>(null);
  let multiDiffs = $state.raw<{ oid: string; summary: string; diff: DiffResponse | null; error: string | null }[]>([]);
  let parentChoice = $state<string | null>(null);
  let manualPath = $state<string | null>(null);
  let detail = $state.raw<CommitDetail | null>(null);
  let detailError = $state<string | null>(null);
  let commitDiff = $state.raw<DiffResponse | null>(null);
  let diffError = $state<string | null>(null);
  let diffLoading = $state(false);
  let scrollTop = $state(0);
  /** 上一次真正读取用的条件：条件没变（只是从改动切回来）时不再把列表拉回顶部。 */
  let lastReadSignature: string | null = null;
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let fileScroll = $state(0);
  let fileViewport = $state(0);
  let fileListEl = $state<HTMLDivElement | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  let repoPath = $derived(opened.summary.path);
  let readGeneration = $derived(opened.generation);
  let selectedOid = $derived(selectedOids.length === 1 ? selectedOids[0] : null);
  let range = $derived(
    visibleRange(commits.length, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let visible = $derived(commits.slice(range.start, range.end));
  /** 键盘游标所在的提交：与选中锚点一致，用 aria-activedescendant 指给辅助技术。 */
  let cursorOid = $derived(anchorOid ?? selectedOids[0] ?? null);
  let activeDescendant = $derived(
    cursorOid && visible.some((commit) => commit.oid === cursorOid) ? "history-commit-" + cursorOid : undefined,
  );
  /** 已经在最新提交：此时「回到最新」没有可做的事，禁用并说明原因（R6）。 */
  let atNewest = $derived(commits.length > 0 && scrollTop <= 0);
  let activeFile = $derived(detail ? preferredCommitFile(detail.files, manualPath ?? filePath) : null);
  let fileFilter = $state("");
  // 分组只改呈现，不写入设置，默认仍是列表。
  let directoryMode = $state(false);
  let collapsedDirs = $state<Set<string>>(new Set());
  let bodyOpen = $state(false);
  let bodyEl = $state<HTMLElement | null>(null);
  /** 折叠的说明是否真的被截断：只看实际溢出，所以随宽度变化重算，放得下时不给入口。 */
  let bodyClipped = $state(false);
  /** 窄详情里文件列表在差异上方，可以收起，把高度全给差异。宽详情里没有这个开关。 */
  let filesCollapsed = $state(false);
  /** 变更文件栏的宽度：拖动中间的分隔条调整，存在本机偏好里；渲染时给差异区至少留 MIN_DIFF_WIDTH。 */
  let filesWidth = $state(readFilesWidth());
  let splitWidth = $state(0);
  let filesShown = $derived(fitFilesWidth(filesWidth, splitWidth));
  /** 「全部文件」模式下从左侧点选的文件：右侧滚动到它。 */
  let multiFocus = $state<string | null>(null);
  let filteredFiles = $derived(filterRows(detail?.files ?? [], fileFilter));
  let fileBuckets = $derived(directoryMode ? bucketByDirectory(filteredFiles) : []);
  /** 整次提交的增删行数：只加文本文件，二进制和没有统计的文件不计入，全都没有统计时不显示。 */
  let lineTotals = $derived.by(() => {
    let additions = 0;
    let deletions = 0;
    let counted = false;
    for (const file of detail?.files ?? []) {
      const stat = commitLineStat(file);
      if (!stat || stat.additions == null || stat.deletions == null) continue;
      additions += stat.additions;
      deletions += stat.deletions;
      counted = true;
    }
    return counted ? { additions, deletions } : null;
  });
  let bodyRest = $derived(detail ? commitBodyRest(detail.body, detail.commit.summary) : "");
  type FileItem =
    | { kind: "dir"; directory: string; label: string; count: number; collapsed: boolean }
    | { kind: "file"; file: (typeof filteredFiles)[number] };
  let fileItems = $derived.by(() => {
    if (!directoryMode) return filteredFiles.map((file) => ({ kind: "file" as const, file }));
    const needle = fileFilter.trim();
    const items: FileItem[] = [];
    for (const bucket of fileBuckets) {
      const collapsed = collapsedDirs.has(bucket.directory) && needle === "";
      items.push({
        kind: "dir",
        directory: bucket.directory,
        label: bucket.directory || "仓库根目录",
        count: bucket.rows.length,
        collapsed,
      });
      if (!collapsed) {
        for (const file of bucket.rows) items.push({ kind: "file", file });
      }
    }
    return items;
  });
  let fileRange = $derived(
    visibleRange(
      fileItems.length,
      fileScroll,
      fileViewport > 0 ? fileViewport : fileScroll > 0 ? FILE_ROW_HEIGHT : 0,
      FILE_ROW_HEIGHT,
    ),
  );
  let visibleFiles = $derived(fileItems.slice(fileRange.start, fileRange.end));
  /* 按筛选后的列表走，与左侧看到的顺序一致；「全部文件」模式还没点选时算在第一个。 */
  let currentPath = $derived(viewMode === "single" ? activeFile?.path : (multiFocus ?? filteredFiles[0]?.path));
  let fileIndex = $derived(filteredFiles.findIndex((file) => file.path === currentPath));
  let fileNav = $derived(detail ? fileNavState(filteredFiles, fileIndex, (file) => goToFile(file.path)) : null);

  $effect(() => {
    onFileNav?.(fileNav);
    return () => onFileNav?.(null);
  });

  $effect(() => {
    const element = bodyEl;
    void bodyRest;
    const row = element?.parentElement;
    if (!element || !row || bodyOpen) return;
    // 和整行比，不和说明自身比：入口按钮占着宽度时，说明自身窄，变宽后放得下也量不出来。
    const measure = () => {
      bodyClipped = element.scrollWidth > row.clientWidth + 1;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(row);
    return () => observer?.disconnect();
  });

  let statusText = $derived(!listError && page && commits.length === 0 ? historyStatus(page.state) : null);
  let showConditions = $derived(
    Boolean(page && commits.length === 0 && (page.state === "no_match" || page.state === "empty_branch" || page.state === "no_file_history" || listError)),
  );
  let conditionText = $derived(historyConditions({
    scope: activeScope,
    head: page?.head ?? null,
    author: activeAuthor,
    since: activeSince,
    until: activeUntil,
    path: filePath ?? activePath,
    query: activeQuery,
  }));
  let scopeNames = $derived.by(() => {
    const names = page?.branches ?? [];
    if (scope !== "current" && scope !== "all" && !names.includes(scope)) return [...names, scope];
    return names;
  });
  /** 历史范围下拉框的分支行：后端只给本地分支名，这里补成分支记录。 */
  let scopeBranches = $derived(
    scopeNames.map((name): BranchRecord => ({ name, remote: false, current: name === page?.head, upstream: null, worktree: null })),
  );
  let selectedIds = $derived(new Set(selectedOids));
  let selectedCommits = $derived(commits.filter((commit) => selectedIds.has(commit.oid)));
  let unionFiles = $derived(unionCommitFiles(multiDetails));
  let unionActive = $derived(unionFiles.find((file) => file.path === multiFocus) ?? unionFiles[0] ?? null);
  let unionScroll = $state(0);
  let unionViewport = $state(0);
  let unionList = $state<HTMLDivElement | null>(null);
  /** 多选差异区：各提交的差异连续堆叠在同一个纵向滚动里，块内只有横向滚动。 */
  let unionHost = $state<HTMLDivElement | null>(null);
  let unionLayout = $state<"unified" | "split">("unified");
  let unionRange = $derived(visibleRange(
    unionFiles.length, unionScroll, unionViewport > 0 ? unionViewport : unionScroll > 0 ? UNION_ROW_HEIGHT : 0, UNION_ROW_HEIGHT,
  ));
  let visibleUnionFiles = $derived(unionFiles.slice(unionRange.start, unionRange.end));
  $effect(() => {
    void unionFiles;
    unionScroll = 0;
    if (unionList) unionList.scrollTop = 0;
  });

  function onUnionKey(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = unionFiles.findIndex((file) => file.path === unionActive?.path);
    const next = nextIndex(index, event.key, unionFiles.length);
    if (next === null) return;
    event.preventDefault();
    multiFocus = unionFiles[next].path;
    unionScroll = scrollIndexIntoView(next, unionScroll, unionViewport, UNION_ROW_HEIGHT);
    if (unionList) {
      unionList.scrollTop = unionScroll;
      unionList.focus({ preventScroll: true });
    }
  }
  let diffSelection = $derived<FileSelection | null>(
    activeFile ? { path: activeFile.path, side: "unstaged" } : null,
  );
  let loadSerial = 0;

  function historyFilters(forFile: boolean): HistoryFilters | undefined {
    const filters: HistoryFilters = {};
    if (activeScope !== "current") filters.scope = activeScope;
    if (activeAuthor) filters.author = activeAuthor;
    const since = activeSince ? historyDayBound(activeSince, false) : null;
    const until = activeUntil ? historyDayBound(activeUntil, true) : null;
    if (since != null) filters.since = since;
    if (until != null) filters.until = until;
    if (!forFile && activePath) filters.path = activePath;
    if (forFile && activeQuery) filters.query = activeQuery;
    return Object.keys(filters).length > 0 ? filters : undefined;
  }

  function dateProblem(): string | null {
    const since = activeSince ? historyDayBound(activeSince, false) : null;
    const until = activeUntil ? historyDayBound(activeUntil, true) : null;
    if ((activeSince && since == null) || (activeUntil && until == null)) return "日期无效，未读取历史，仓库没有改动。";
    if (since != null && until != null && since > until) return "开始日期晚于结束日期，未读取历史，仓库没有改动。";
    return null;
  }

  $effect(() => {
    const seed = searchQuery;
    if (seed === lastSearchSeed) return;
    lastSearchSeed = seed;
    query = seed;
    activeQuery = seed;
  });

  $effect(() => {
    if (!active) return;
    const repo = repoPath;
    const generation = readGeneration;
    const relative = filePath;
    const q = activeQuery;
    const scopeName = activeScope;
    const problem = dateProblem();
    const filters = historyFilters(Boolean(relative));
    const signature = [repo, generation, relative ?? "", q, scopeName, activeAuthor, activeSince, activeUntil, activePath].join("\u0000");
    const previousPage = untrack(() => page);
    const serial = ++loadSerial;
    appendStopped = false;
    appendError = null;
    loading = true;
    let cancelled = false;
    void (async () => {
      try {
        if (problem) {
          if (cancelled || serial !== loadSerial) return;
          commits = [];
          page = {
            generation,
            state: "no_match",
            hasMore: false,
            pageSize: previousPage?.pageSize ?? 100,
            scope: scopeName,
            branches: previousPage?.branches ?? [],
            head: previousPage?.head ?? null,
          };
          listError = problem;
          selectedOids = [];
          anchorOid = null;
          return;
        }
        const result = await pageReads.run(async () => relative
          ? (filters
            ? api.fileHistory(repo, relative, 0, generation, nextId(), filters)
            : api.fileHistory(repo, relative, 0, generation, nextId()))
          : (filters
            ? api.historyPage(repo, q, 0, generation, nextId(), filters)
            : api.historyPage(repo, q, 0, generation, nextId())));
        if (cancelled || serial !== loadSerial || opened.summary.path !== repo) return;
        // 只有读取条件真的变了才回到顶部；从改动切回历史属于同一次浏览，滚动位置保留（R3）。
        if (signature !== lastReadSignature) {
          lastReadSignature = signature;
          scrollTop = 0;
          if (list) list.scrollTop = 0;
        } else if (list && list.scrollTop !== scrollTop) {
          list.scrollTop = scrollTop;
        }
        commits = result.commits;
        page = {
          generation: result.generation,
          state: result.state,
          hasMore: result.hasMore,
          pageSize: result.pageSize,
          scope: result.scope ?? scopeName,
          branches: result.branches ?? [],
          head: result.head ?? null,
        };
        listError = null;
        const ids = new Set(result.commits.map((commit) => commit.oid));
        const previous = selectedOids;
        const kept = previous.filter((oid) => ids.has(oid));
        if (kept.length === 0) {
          selectedOids = result.commits[0] ? [result.commits[0].oid] : [];
          anchorOid = selectedOids[0] ?? null;
          parentChoice = null;
          manualPath = null;
          multiFocus = null;
        } else if (kept.length !== previous.length) {
          selectedOids = kept;
        }
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || serial !== loadSerial || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "cancelled") return;
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        listError = failure.message;
        onFailure(failure);
      } finally {
        if (!cancelled && serial === loadSerial) loading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const height = viewport;
    const more = page?.hasMore;
    const count = commits.length;
    void height;
    void more;
    void count;
    void loading;
    void appendStopped;
    if (!active) return;
    untrack(() => maybeAppend(list));
  });

  $effect(() => {
    if (!active) return;
    const repo = repoPath;
    const generation = readGeneration;
    const oid = selectedOid;
    const parent = parentChoice;
    if (!oid) {
      detail = null;
      commitDiff = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await detailReads.run(() => api.commitDetail(repo, oid, parent, generation, nextId()));
        if (cancelled || opened.summary.path !== repo || selectedOid !== oid) return;
        detail = result;
        detailError = null;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        detail = null;
        detailError = failure.message;
        onFailure(failure);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!active) return;
    const repo = repoPath;
    const generation = readGeneration;
    const current = detail;
    const file = activeFile;
    const parent = parentChoice ?? current?.selectedParent ?? null;
    const detailMatches = current?.commit.oid === selectedOid
      && (parentChoice === null || current?.selectedParent === parentChoice);
    if (!current || !file || !detailMatches || viewMode !== "single") {
      commitDiff = null;
      diffLoading = false;
      return;
    }
    const oid = current.commit.oid;
    const relative = file.path;
    let cancelled = false;
    diffLoading = true;
    diffError = null;
    void (async () => {
      try {
        const result = await diffReads.run(() => api.commitFileDiff(repo, oid, parent, relative, generation, nextId(), 0, 0));
        if (cancelled || opened.summary.path !== repo || detail?.commit.oid !== oid || activeFile?.path !== relative) return;
        commitDiff = result;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || opened.summary.path !== repo) return;
        const failure = normalizeError(error);
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        commitDiff = null;
        diffError = failure.message;
        onFailure(failure);
      } finally {
        if (!cancelled) diffLoading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const ids = selectedOids;
    multiDetails = [];
    multiError = null;
    if (!active || ids.length < 2) return;
    const repo = repoPath;
    const generation = readGeneration;
    let cancelled = false;
    void (async () => {
      const errors: string[] = [];
      try {
        const rows = await multiDetailReads.run(ids, async (oid) => {
          try {
            return await api.commitDetail(repo, oid, null, generation, nextId());
          } catch (error) {
            const failure = normalizeError(error);
            if (failure.code !== "cancelled" && failure.code !== "stale") errors.push(failure.message);
            return null;
          }
        });
        if (cancelled || opened.summary.path !== repo) return;
        multiDetails = rows.filter((row): row is CommitDetail => row !== null);
        multiError = errors[0] ?? null;
      } catch (error) {
        if (!cancelled) multiError = normalizeError(error).message;
      }
    })();
    return () => {
      cancelled = true;
      multiDetailReads.cancel();
    };
  });

  $effect(() => {
    multiDiffs = [];
    if (!active || selectedOids.length < 2) {
      return;
    }
    const file = unionActive?.path ?? null;
    const details = multiDetails;
    const repo = repoPath;
    const generation = readGeneration;
    if (!file) {
      multiDiffs = [];
      return;
    }
    const sources = details.filter((detail) => detail.files.some((item) => item.path === file));
    let cancelled = false;
    void (async () => {
      try {
        const rows = await multiDiffReads.run(sources, async (detail) => {
          try {
            const diff = await api.commitFileDiff(
              repo,
              detail.commit.oid,
              detail.selectedParent,
              file,
              generation,
              nextId(),
              0,
              0,
            );
            return { oid: detail.commit.oid, summary: detail.commit.summary, diff, error: null as string | null };
          } catch (error) {
            return {
              oid: detail.commit.oid,
              summary: detail.commit.summary,
              diff: null,
              error: normalizeError(error).message,
            };
          }
        });
        if (cancelled) return;
        multiDiffs = rows;
      } catch (error) {
        if (!cancelled) multiError = normalizeError(error).message;
      }
    })();
    return () => {
      cancelled = true;
      multiDiffReads.cancel();
    };
  });

  function scheduleText() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      activeQuery = query.trim();
      activeAuthor = author.trim();
      activePath = pathFilter.trim();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
  }

  function setScope(value: string) {
    scope = value;
    activeScope = value;
  }

  function setDay(kind: "since" | "until", value: string) {
    if (kind === "since") {
      sinceDay = value;
      activeSince = value;
    } else {
      untilDay = value;
      activeUntil = value;
    }
  }

  function clearFilter(kind: "query" | "author" | "path" | "since" | "until") {
    if (kind === "query") query = "";
    if (kind === "author") author = "";
    if (kind === "path") pathFilter = "";
    if (kind === "since") sinceDay = "";
    if (kind === "until") untilDay = "";
    activeQuery = query.trim();
    activeAuthor = author.trim();
    activePath = pathFilter.trim();
    activeSince = sinceDay;
    activeUntil = untilDay;
  }

  function singleSelect(oid: string) {
    if (selectedOids.length === 1 && selectedOids[0] === oid) {
      anchorOid = oid;
      return;
    }
    anchorOid = oid;
    selectedOids = [oid];
    parentChoice = null;
    manualPath = null;
    multiFocus = null;
    fileFilter = "";
    bodyOpen = false;
  }

  function clickCommit(event: MouseEvent, oid: string) {
    if (event.shiftKey) {
      selectedOids = commitSelectionRange(commits.map((commit) => commit.oid), anchorOid, oid);
    } else if (event.metaKey || event.ctrlKey) {
      const next = toggleCommitSelection(selectedOids, oid);
      if (next === selectedOids) return;
      anchorOid = oid;
      selectedOids = next;
    } else {
      singleSelect(oid);
    }
    list?.focus({ preventScroll: true });
  }

  function maybeAppend(host: HTMLElement | null) {
    if (!host || !page) return;
    if (shouldAppendHistory(host.scrollTop, host.clientHeight, host.scrollHeight, page.hasMore, loading || appendStopped)) {
      void appendOlder();
    }
  }

  async function appendOlder() {
    if (!page?.hasMore || loading || appendStopped || !active) return;
    const serial = loadSerial;
    const repo = repoPath;
    const generation = readGeneration;
    const relative = filePath;
    const offset = commits.length;
    const filters = historyFilters(Boolean(relative));
    const q = activeQuery;
    loading = true;
    try {
      const result = await (relative
        ? (filters
          ? api.fileHistory(repo, relative, offset, generation, nextId(), filters)
          : api.fileHistory(repo, relative, offset, generation, nextId()))
        : (filters
          ? api.historyPage(repo, q, offset, generation, nextId(), filters)
          : api.historyPage(repo, q, offset, generation, nextId())));
      if (serial !== loadSerial || opened.summary.path !== repo) return;
      const seen = new Set(commits.map((commit) => commit.oid));
      const extra = result.commits.filter((commit) => !seen.has(commit.oid));
      if (extra.length === 0) {
        const message = "还有更早的提交，但这一页没有读到。";
        appendError = message;
        appendStopped = true;
        onFailure({ code: "history_incomplete", message });
      } else {
        commits = [...commits, ...extra];
        page = {
          generation: result.generation,
          state: result.state,
          hasMore: result.hasMore,
          pageSize: result.pageSize,
          scope: result.scope ?? page.scope,
          branches: result.branches ?? page.branches,
          head: result.head ?? page.head,
        };
        appendError = null;
      }
      if (result.generation !== generation) onGeneration(result.generation);
    } catch (error) {
      if (serial !== loadSerial || opened.summary.path !== repo) return;
      const failure = normalizeError(error);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
        onGeneration(failure.generation);
        return;
      }
      appendError = failure.message;
      appendStopped = true;
      onFailure(failure);
    } finally {
      if (serial === loadSerial) loading = false;
    }
  }

  function backToNewest() {
    scrollTop = 0;
    if (list) list.scrollTop = 0;
  }

  function chooseFile(path: string) {
    if (viewMode === "multi") multiFocus = path;
    else manualPath = path;
  }

  /** 单文件与全部文件之间切换时带上当前文件，列表高亮和差异位置都不丢。 */
  function useMode(next: "single" | "multi") {
    if (next === viewMode) return;
    if (next === "multi") multiFocus = activeFile?.path ?? null;
    else if (multiFocus) manualPath = multiFocus;
    viewMode = next;
  }

  function directoryOf(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  function openDirectory(path: string) {
    if (!directoryMode) return;
    const directory = directoryOf(path);
    if (!collapsedDirs.has(directory)) return;
    const next = new Set(collapsedDirs);
    next.delete(directory);
    collapsedDirs = next;
  }

  function goToFile(path: string) {
    chooseFile(path);
    openDirectory(path);
    const index = fileItems.findIndex((item) => item.kind === "file" && item.file.path === path);
    const height = fileViewport > 0 ? fileViewport : (fileListEl?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, fileScroll, height, FILE_ROW_HEIGHT);
    fileScroll = next;
    if (fileListEl) fileListEl.scrollTop = next;
  }

  let revealedFileQuery = "";
  $effect(() => {
    const needle = fileFilter.trim();
    const mode = directoryMode;
    const first = filteredFiles[0]?.path ?? "";
    const token = `${mode}:${needle}:${first}`;
    if (!mode || !needle || !first || token === revealedFileQuery) return;
    revealedFileQuery = token;
    openDirectory(first);
    queueMicrotask(() => goToFile(first));
  });

  function reveal(index: number) {
    const height = viewport > 0 ? viewport : (list?.clientHeight ?? 0);
    const next = scrollIndexIntoView(index, scrollTop, height, ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  function onListKey(event: KeyboardEvent) {
    const anchor = anchorOid ?? selectedOids[0] ?? null;
    const current = commits.findIndex((commit) => commit.oid === anchor);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (commits.length === 0) return;
      selectedOids = commits.map((commit) => commit.oid);
      anchorOid ??= commits[0]?.oid ?? null;
      return;
    }
    if (isContextKey(event) && current >= 0) {
      event.preventDefault();
      const row = (event.currentTarget as HTMLElement).querySelector('.history-row[aria-selected="true"]');
      const commit = commits[current];
      if (commit) commitMenu(commit, row ? pointFor(row) : { x: 160, y: 160 });
      return;
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      // 翻页也移动选择：只滚内容不移动当前项，键盘浏览时看不出自己停在哪一条。
      if (commits.length === 0) return;
      event.preventDefault();
      const height = viewport > 0 ? viewport : (list?.clientHeight ?? ROW_HEIGHT);
      const step = Math.max(1, Math.floor(height / ROW_HEIGHT));
      const from = current >= 0 ? current : 0;
      const next = Math.max(0, Math.min(commits.length - 1, from + (event.key === "PageDown" ? step : -step)));
      reveal(next);
      const target = commits[next];
      if (!target) return;
      if (event.shiftKey) selectedOids = commitSelectionRange(commits.map((commit) => commit.oid), anchorOid, target.oid);
      else singleSelect(target.oid);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const move = nextIndex(current, event.key, commits.length);
    if (move === null) return;
    event.preventDefault();
    reveal(move);
    const commit = commits[move];
    if (!commit) return;
    if (event.shiftKey) selectedOids = commitSelectionRange(commits.map((item) => item.oid), anchorOid, commit.oid);
    else singleSelect(commit.oid);
  }

  function unionCommitFiles(details: CommitDetail[]): CommitFileChange[] {
    const map = new Map<string, CommitFileChange>();
    for (const detail of details) {
      for (const file of detail.files) {
        const existing = map.get(file.path);
        if (!existing) {
          map.set(file.path, { ...file });
          continue;
        }
        if (file.binary || existing.binary) {
          // 多个提交合起来看时，前后大小没有单一的「改动前」，只说是二进制。
          existing.binary = true;
          existing.additions = null;
          existing.deletions = null;
          existing.oldSize = null;
          existing.newSize = null;
        } else if (existing.additions != null && file.additions != null && existing.deletions != null && file.deletions != null) {
          existing.additions += file.additions;
          existing.deletions += file.deletions;
        } else {
          existing.additions = null;
          existing.deletions = null;
        }
        if (existing.status !== file.status) existing.status = "modified";
      }
    }
    return [...map.values()];
  }

  async function loadMoreDiff() {
    const current = commitDiff;
    const file = activeFile;
    const currentDetail = detail;
    if (!current || !file || !currentDetail || disabled) return;
    if (current.offset + current.lines.length >= current.totalLines) return;
    const repo = opened.summary.path;
    const parent = parentChoice ?? currentDetail.selectedParent;
    try {
      const result = await api.commitFileDiff(
        repo,
        currentDetail.commit.oid,
        parent,
        file.path,
        opened.generation,
        nextId(),
        current.offset + current.lines.length,
        400,
      );
      if (opened.summary.path !== repo || activeFile?.path !== file.path) return;
      const base = current.lines.length;
      commitDiff = {
        ...result,
        offset: current.offset,
        lines: [...current.lines, ...result.lines],
        hunks: mergeHunks(current.hunks, result.hunks, base),
        totalLines: result.totalLines,
      };
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== opened.generation) {
        onGeneration(failure.generation);
        return;
      }
      diffError = failure.message;
      onFailure(failure);
    }
  }

  function mergeHunks(current: DiffHunk[], extra: DiffHunk[], base: number): DiffHunk[] {
    const merged = new Map(current.map((hunk) => [hunk.index, hunk]));
    for (const hunk of extra) {
      if (!merged.has(hunk.index)) merged.set(hunk.index, { ...hunk, startLine: hunk.startLine + base });
    }
    return [...merged.values()];
  }

  let copiedOid = $state<string | null>(null);

  async function copyOid(oid: string) {
    try {
      await navigator.clipboard.writeText(oid);
      copiedOid = oid;
      setTimeout(() => {
        if (copiedOid === oid) copiedOid = null;
      }, 1500);
    } catch {
      copiedOid = null;
    }
  }


  function fileTitle(file: { path: string; originalPath: string | null }): string {
    return file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  }
</script>

{#snippet filesResizer()}
  <PaneResizer
    value={filesShown}
    saved={filesWidth}
    label="调整变更文件栏宽度"
    fit={(width) => fitFilesWidth(width, splitWidth)}
    onResize={(width) => (filesWidth = width)}
    onCommit={saveFilesWidth}
  />
{/snippet}

<section class="history-view" aria-label="提交历史" aria-busy={loading}>
  <div class="history-layout">
    <aside class="pane history-pane" aria-label="提交列表">
      {@render paneHead?.()}
      <div class="history-tools">
        {#if filePath}
          <button type="button" class="btn btn-ghost btn-sm" onclick={onClearFile}>
            <Icon name="arrow-left" size={14} />返回全部历史
          </button>
          <span class="history-file-scope" title={filePath}><Icon name="file" size={13} /><span class="truncate">{filePath}</span></span>
        {/if}
        <div class="history-filters">
          <BranchPicker
            label="历史范围"
            size="md"
            localOnly
            branches={scopeBranches}
            value={scope}
            current={page?.head ?? null}
            extras={[
              { value: "current", label: `当前分支${page?.head ? `（${page.head}）` : ""}`, icon: "branch" },
              { value: "all", label: "全部分支", icon: "layers" },
            ]}
            {branchGroups}
            onChange={setScope}
          />
          <div class="history-search-row">
            <div class="field sm history-search">
              <Icon name="search" size={14} />
              <input
                aria-label="搜索说明或提交哈希"
                placeholder="搜索说明或提交哈希"
                autocomplete="off"
                spellcheck="false"
                value={query}
                oninput={(event) => {
                  query = event.currentTarget.value;
                  scheduleText();
                }}
              />
              {#if query}
                <button type="button" class="field-clear" aria-label="清除说明或哈希" onclick={() => clearFilter("query")}><Icon name="x" size={12} /></button>
              {/if}
              {#if loading}<span class="spinner"></span>{/if}
            </div>
            <button
              type="button"
              class="icon-btn history-filter-toggle"
              class:active={advancedCount > 0}
              aria-expanded={moreFilters}
              aria-controls="history-more-filters"
              aria-label={advancedCount > 0 ? `更多筛选（已生效 ${advancedCount} 项）` : "更多筛选"}
              title="按作者、日期或路径筛选"
              onclick={() => (moreFilters = !moreFilters)}
            >
              <Icon name="filter" size={15} />
              {#if advancedCount > 0}<span class="filter-badge" aria-hidden="true">{advancedCount}</span>{/if}
            </button>
          </div>
          {#if moreFilters}
          <div class="history-more-filters" id="history-more-filters">
          <div class="field sm">
            <Icon name="user" size={14} />
            <input
              aria-label="作者"
              placeholder="作者"
              autocomplete="off"
              spellcheck="false"
              value={author}
              oninput={(event) => {
                author = event.currentTarget.value;
                scheduleText();
              }}
            />
            {#if author}
              <button type="button" class="field-clear" aria-label="清除作者" onclick={() => clearFilter("author")}><Icon name="x" size={12} /></button>
            {/if}
          </div>
          <div class="history-filter-row">
            <input class="input" type="date" aria-label="开始日期" value={sinceDay} oninput={(event) => setDay("since", event.currentTarget.value)} />
            <input class="input" type="date" aria-label="结束日期" value={untilDay} oninput={(event) => setDay("until", event.currentTarget.value)} />
          </div>
          {#if sinceDay || untilDay}
            <div class="history-filter-row">
              {#if sinceDay}<button type="button" class="btn btn-ghost btn-sm" onclick={() => clearFilter("since")}>清除开始日期</button>{/if}
              {#if untilDay}<button type="button" class="btn btn-ghost btn-sm" onclick={() => clearFilter("until")}>清除结束日期</button>{/if}
            </div>
          {/if}
          <div class="field sm">
            <Icon name="folder" size={14} />
            <input
              aria-label="路径"
              placeholder="路径"
              autocomplete="off"
              spellcheck="false"
              value={filePath ?? pathFilter}
              disabled={Boolean(filePath)}
              title={filePath ? "文件历史的路径不能改" : undefined}
              oninput={(event) => {
                if (filePath) return;
                pathFilter = event.currentTarget.value;
                scheduleText();
              }}
            />
            {#if !filePath && pathFilter}
              <button type="button" class="field-clear" aria-label="清除路径" onclick={() => clearFilter("path")}><Icon name="x" size={12} /></button>
            {/if}
          </div>
          </div>
          {/if}
        </div>
      </div>
      {#if listError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{listError}</span></div>
        {#if showConditions}<p class="history-conditions">{conditionText}</p>{/if}
      {/if}
      {#if appendError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{appendError}已显示的提交仍保留。</span></div>
      {/if}
      <div
        class="history-list"
        role="listbox"
        aria-label={filePath ? "文件历史" : "提交历史"}
        tabindex="0"
        aria-activedescendant={activeDescendant}
        bind:this={list}
        bind:clientHeight={viewport}
        aria-multiselectable="true"
        onscroll={(event) => {
          scrollTop = event.currentTarget.scrollTop;
          maybeAppend(event.currentTarget);
        }}
        onkeydown={onListKey}
      >
        {#if loading && !page}
          <div class="empty" role="status"><span class="empty-icon"><span class="spinner"></span></span><strong>正在读取历史</strong></div>
        {:else if statusText}
          <div class="empty" role="status">
            <span class="empty-icon"><Icon name={page?.state === "no_match" ? "search" : page?.state === "no_file_history" ? "file" : page?.state === "empty_branch" ? "branch" : "commit"} size={22} /></span>
            <strong>{statusText}</strong>
            {#if showConditions}<p class="history-conditions">{conditionText}</p>{/if}
          </div>
        {:else if commits.length === 0}
          <div class="empty" role="status"><span class="empty-icon"><Icon name="history" size={22} /></span><strong>这一页没有提交。</strong></div>
        {:else}
          <div class="virtual-space" style={`height:${commits.length * ROW_HEIGHT}px`}>
            {#each visible as commit, index (commit.oid)}
              {@const pills = refPills(commit.labels)}
              <div
                id={"history-commit-" + commit.oid}
                class="history-row"
                role="option"
                aria-selected={selectedIds.has(commit.oid)}
                tabindex="-1"
                style={`top:${(range.start + index) * ROW_HEIGHT + 1}px;height:${ROW_HEIGHT - 2}px`}
                title={`${commit.summary}\n${commit.authorName} · ${formatAuthoredAt(commit.authoredAt)}\n${commit.oid}`}
                onclick={(event) => clickCommit(event, commit.oid)}
                oncontextmenu={(event) => {
                  event.preventDefault();
                  commitMenu(commit, { x: event.clientX, y: event.clientY });
                }}
                onkeydown={(event) => {
                  if (isContextKey(event)) {
                    event.preventDefault();
                    commitMenu(commit, pointFor(event.currentTarget));
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    singleSelect(commit.oid);
                  }
                }}
              >
                <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
                <span class="hr-main">
                  <span class="hr-line">
                    <span class="hr-summary">{commit.summary}</span>
                    <code class="hr-hash">{shortOid(commit.oid)}</code>
                  </span>
                  <span class="hr-meta">
                    {#each pills.slice(0, 2) as pill (`${pill.kind}:${pill.name}`)}
                      <span class={`ref-pill ${pill.kind}`} class:current={pill.current} title={pill.label} aria-label={pill.label}>
                        <Icon name={pill.kind === "tag" ? "tag" : pill.kind === "remote" ? "cloud" : "branch"} size={11} />
                        <span>{pill.name}</span>
                        {#if pill.remote}<Icon name="cloud" size={10} />{/if}
                      </span>
                    {/each}
                    {#if pills.length > 2}<span class="ref-more" title={pills.slice(2).map((pill) => pill.label).join("\n")}>+{pills.length - 2}</span>{/if}
                    <span class="hr-author">{commit.authorName}</span>
                    <span class="hr-dot"></span>
                    <span class="hr-time">{relativeTime(commit.authoredAt)}</span>
                    {#if commit.parents.length > 1}
                      <span class="hr-merge" title={parentCaption(commit.parents)}><Icon name="merge" size={11} />合并</span>
                    {/if}
                  </span>
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
      <div class="pager history-pager">
        <span class="pager-range">
          {#if commits.length > 0}已加载最新 1–{commits.length} 条{page?.hasMore ? "，还有更早的提交" : ""}{:else}—{/if}
        </span>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onclick={backToNewest}
          disabled={commits.length === 0 || atNewest}
          title={commits.length === 0 ? "还没有提交" : atNewest ? "已经在最新一条提交" : "滚回最新一条提交"}
        >回到最新</button>
      </div>
    </aside>
    {@render paneResizer?.()}
    <div class="history-detail">
      {#if detailError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{detailError}</span></div>
      {/if}
      {#if multiError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{multiError}</span></div>
      {/if}
      {#if selectedOids.length > 1}
        <header class="commit-head union-head">
          <div class="commit-head-main">
            <h2 class="commit-title">已选择 {selectedOids.length} 个提交</h2>
            <p class="hint">左侧是这些提交改动过的全部文件；右侧按提交依次列出所选文件的差异，各自相对第一父提交。</p>
          </div>
          <div class="commit-facts">
            <button type="button" class="btn btn-secondary btn-sm" title="回到只看最新的一个提交" onclick={() => singleSelect(selectedCommits[0]?.oid ?? selectedOids[0])}>
              <Icon name="x" size={13} />退出多选
            </button>
          </div>
        </header>
        <ul class="union-commits" aria-label="已选择的提交">
          {#each selectedCommits as commit (commit.oid)}
            <li>
              <button type="button" class="union-commit" title={`只看这个提交：${commit.summary}`} onclick={() => singleSelect(commit.oid)}>
                <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
                <span class="union-commit-summary">{commit.summary}</span>
                <span class="union-commit-meta">{commit.authorName} · {relativeTime(commit.authoredAt)}</span>
                <code>{shortOid(commit.oid)}</code>
              </button>
            </li>
          {/each}
        </ul>
        <div class="commit-split" style={`--commit-files:${filesShown}px`} bind:clientWidth={splitWidth}>
          <aside class="commit-files" aria-label="提交中的文件">
            <div class="commit-files-head"><span class="commit-files-title">变更文件</span><span class="count">{unionFiles.length}</span></div>
            {#if unionFiles.length === 0}
              <p class="commit-files-empty">这些提交没有文件变化。</p>
            {:else}
              <div
                class="file-list history-files history-union-files"
                role="listbox"
                aria-label="提交中的文件列表"
                tabindex="0"
                bind:this={unionList}
                bind:clientHeight={unionViewport}
                onscroll={(event) => (unionScroll = event.currentTarget.scrollTop)}
                onkeydown={onUnionKey}
              >
                <div class="virtual-space" style={`height:${unionFiles.length * UNION_ROW_HEIGHT}px`}>
                  {#each visibleUnionFiles as file, index (file.path)}
                    {@const mark = statusMark(commitFileLabel(file.status))}
                    {@const parts = splitPath(file.path)}
                    <button
                      type="button"
                      class="file-row"
                      role="option"
                      aria-selected={unionActive?.path === file.path}
                      aria-posinset={unionRange.start + index + 1}
                      aria-setsize={unionFiles.length}
                      style={`position:absolute;top:${(unionRange.start + index) * UNION_ROW_HEIGHT + 1}px;height:${UNION_ROW_HEIGHT - 2}px;margin:0`}
                      title={fileTitle(file)}
                      onclick={() => {
                        multiFocus = file.path;
                        unionList?.focus({ preventScroll: true });
                      }}
                      oncontextmenu={(event) => {
                        event.preventDefault();
                        fileMenu(file.path, { x: event.clientX, y: event.clientY });
                      }}
                    >
                      <span class={`st ${mark.tone}`} title={commitFileLabel(file.status)}>{mark.letter}</span>
                      <span class="file-name">
                        <span class="fn">{parts.name}</span>
                        {#if parts.dir}<span class="fd"><bdi>{parts.dir}</bdi></span>{/if}
                      </span>
                      <LineCounts stat={commitLineStat(file)} hideBinary />
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </aside>
          {@render filesResizer()}
          <div class="commit-diff union-diff">
            {#if unionActive}
              {@const focused = splitPath(unionActive.path)}
              <div class="union-diff-head">
                <Icon name="file-diff" size={15} />
                <span class="diff-path" title={unionActive.path}>
                  <bdi>{#if focused.dir}<span class="dir">{focused.dir}/</span>{/if}<span class="union-diff-name">{focused.name}</span></bdi>
                </span>
                {#if multiDiffs.length > 0}<span class="union-diff-count">{multiDiffs.length} 个提交改动了它</span>{/if}
                <span class="spacer"></span>
                <button type="button" class="btn btn-ghost btn-sm" aria-label="此文件历史" title="查看这个文件的提交历史" onclick={() => unionActive && onFilePath(unionActive.path)}>
                  <Icon name="history" size={14} /><span class="diff-hist-label">此文件历史</span>
                </button>
                <div class="segmented" role="group" aria-label="差异布局">
                  <button type="button" aria-pressed={unionLayout === "unified"} title="统一视图" onclick={() => (unionLayout = "unified")}><Icon name="rows" size={12} />统一</button>
                  <button type="button" aria-pressed={unionLayout === "split"} title="并排视图" onclick={() => (unionLayout = "split")}><Icon name="split" size={12} />并排</button>
                </div>
              </div>
            {/if}
            <div class="union-scroll" bind:this={unionHost}>
              {#if unionActive && multiDiffs.length === 0}
                <div class="empty compact" role="status" aria-busy="true">
                  <span class="empty-icon"><span class="spinner"></span></span>
                  <strong>正在读取差异</strong>
                </div>
              {/if}
              {#each multiDiffs as item (item.oid)}
                {@const owner = selectedCommits.find((commit) => commit.oid === item.oid)}
                {@const change = multiDetails.find((entry) => entry.commit.oid === item.oid)?.files.find((file) => file.path === unionActive?.path)}
                <section class="union-block">
                  <h3 class="union-block-head">
                    <code class="union-block-oid">{shortOid(item.oid)}</code>
                    <span class="union-block-summary" title={item.summary}>{item.summary}</span>
                    {#if owner}<span class="union-block-meta">{owner.authorName} · {relativeTime(owner.authoredAt)}</span>{/if}
                    {#if change}<LineCounts stat={commitLineStat(change)} hideBinary />{/if}
                  </h3>
                  {#if item.error}
                    <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{item.error}</span></div>
                  {:else}
                    <DiffView
                      embedded
                      scrollHost={unionHost}
                      layout={unionLayout}
                      selection={unionActive ? { path: unionActive.path, side: "unstaged" } : null}
                      diff={item.diff}
                      error={item.error}
                      loading={item.diff === null && item.error === null}
                      {disabled}
                      readOnly={true}
                      onStageHunk={() => {}}
                      onLoadMore={() => {}}
                      onFileHistory={onFilePath}
                    />
                  {/if}
                </section>
              {/each}
            </div>
          </div>
        </div>
      {:else if detail}
        {@const pills = refPills(detail.commit.labels)}
        <header class="commit-head">
          <div class="commit-head-main">
            <h2 class="commit-title">{detail.commit.summary}</h2>
            {#if bodyRest}
              <div class="commit-body-row" class:open={bodyOpen}>
                <pre class="commit-body" class:clamped={!bodyOpen} bind:this={bodyEl}>{bodyRest}</pre>
                {#if bodyOpen || bodyClipped}
                  <button type="button" class="btn btn-ghost btn-sm commit-body-toggle" onclick={() => (bodyOpen = !bodyOpen)}>
                    <Icon name="chevron-down" size={12} class={bodyOpen ? "flip" : ""} />{bodyOpen ? "收起说明" : "展开完整说明"}
                  </button>
                {/if}
              </div>
            {/if}
            <div class="commit-byline">
              <span class="avatar" style={`--hue:${hueOf(detail.commit.authorName)}`} aria-hidden="true">{initialOf(detail.commit.authorName)}</span>
              <strong>{detail.commit.authorName}</strong>
              <span class="commit-email">{detail.commit.authorEmail}</span>
              <span title={formatAuthoredAt(detail.commit.authoredAt)}>{relativeTime(detail.commit.authoredAt)} · {formatAuthoredAt(detail.commit.authoredAt)}</span>
              <span class="commit-parents">{parentCaption(detail.commit.parents, detail.root)}</span>
              <span class="read-only-chip" title="历史浏览是只读的：不切换分支，也不改动暂存区或工作区">
                <Icon name="eye" size={12} />只读
              </span>
              {#each pills as pill (`${pill.kind}:${pill.name}`)}
                <span class={`ref-pill ${pill.kind}`} class:current={pill.current} title={pill.label} aria-label={pill.label}>
                  <Icon name={pill.kind === "tag" ? "tag" : pill.kind === "remote" ? "cloud" : "branch"} size={11} />
                  <span>{pill.name}</span>
                  {#if pill.remote}<Icon name="cloud" size={10} />{/if}
                </span>
              {/each}
            </div>
          </div>
          <div class="commit-facts">
            {#if viewMode === "multi" && fileNav}<FileNav nav={fileNav} />{/if}
            <div class="segmented history-view-mode" role="group" aria-label="历史差异模式">
              <button type="button" aria-pressed={viewMode === "single"} title="一次看一个文件" onclick={() => useMode("single")}><Icon name="file" size={12} />单文件</button>
              <button type="button" aria-pressed={viewMode === "multi"} title="连续查看整次提交的全部文件" onclick={() => useMode("multi")}><Icon name="layers" size={12} />全部文件</button>
            </div>
            <span class="oid-chip" title={detail.commit.oid}>
              <Icon name="commit" size={12} />
              {shortOid(detail.commit.oid)}
              <button type="button" aria-label="复制完整提交标识" title={copiedOid === detail.commit.oid ? "已复制" : "复制完整提交标识"} onclick={() => copyOid(detail?.commit.oid ?? "")}>
                <Icon name={copiedOid === detail.commit.oid ? "check" : "copy"} size={12} />
              </button>
            </span>
            <span class="sr-only" aria-live="polite">{copiedOid ? "已复制提交 " + shortOid(copiedOid) : ""}</span>
          </div>
          {#if detail.merge}
            <div class="commit-compare">
              <span>比较对象</span>
              <div class="segmented" role="group" aria-label="选择父提交">
                {#each detail.commit.parents as parent, index (parent)}
                  <button
                    type="button"
                    aria-pressed={(parentChoice ?? detail.selectedParent) === parent}
                    title={index === 0 ? "相对合并前的主线：看这次合并带进来了什么" : "相对被合并的分支：看合并时主线这边有什么不同"}
                    onclick={() => (parentChoice = parent)}
                  >
                    {index === 0 ? "主线" : `第 ${index + 1} 个父提交`} · {shortOid(parent)}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </header>
        <div class="commit-split" style={`--commit-files:${filesShown}px`} bind:clientWidth={splitWidth}>
          <aside class="commit-files" class:collapsed={filesCollapsed} aria-label="提交中的文件">
            <div class="commit-files-head">
              <span class="commit-files-title">变更文件</span>
              <span class="count">{detail.files.length}</span>
              <span class="spacer"></span>
              {#if lineTotals}
                <span class="diff-stats commit-line-total" title="这次提交共改动的行数" aria-label={`共新增 ${lineTotals.additions} 行，删除 ${lineTotals.deletions} 行`}>
                  <span class="plus">+{lineTotals.additions}</span>
                  <span class="minus">−{lineTotals.deletions}</span>
                </span>
              {/if}
              <div class="segmented icon-segmented" role="group" aria-label="文件排列">
                <button type="button" aria-pressed={!directoryMode} aria-label="列表" title="平铺列表" onclick={() => (directoryMode = false)}><Icon name="list" size={14} /></button>
                <button type="button" aria-pressed={directoryMode} aria-label="目录" title="按目录分组" onclick={() => (directoryMode = true)}><Icon name="folder" size={14} /></button>
              </div>
              <button
                type="button"
                class="icon-btn sm commit-files-toggle"
                aria-expanded={!filesCollapsed}
                aria-label={filesCollapsed ? "展开变更文件" : "收起变更文件"}
                title={filesCollapsed ? "展开变更文件" : "收起变更文件"}
                onclick={() => (filesCollapsed = !filesCollapsed)}
              >
                <Icon name="chevron-down" size={13} class={filesCollapsed ? "" : "flip"} />
              </button>
            </div>
            {#if detail.files.length > 8 || directoryMode}
              <div class="commit-files-filter">
                <div class="field sm">
                  <Icon name="search" size={13} />
                  <input aria-label="筛选提交中的文件" placeholder="筛选文件" autocomplete="off" spellcheck="false" bind:value={fileFilter} />
                </div>
              </div>
            {/if}
            {#if detail.files.length === 0}
              <p class="commit-files-empty">这次提交没有文件变化。</p>
            {:else if filteredFiles.length === 0}
              <p class="commit-files-empty">没有匹配的文件。</p>
            {:else}
              <div
                class="file-list history-files"
                role="listbox"
                aria-label="提交中的文件列表"
                tabindex="0"
                bind:this={fileListEl}
                bind:clientHeight={fileViewport}
                onscroll={(event) => (fileScroll = event.currentTarget.scrollTop)}
              >
                <div class="virtual-space" style={`height:${fileItems.length * FILE_ROW_HEIGHT}px`}>
                  {#each visibleFiles as item, index (item.kind === "dir" ? `d:${item.directory}` : `${item.file.status}:${item.file.path}`)}
                    {#if item.kind === "dir"}
                      <div class="file-dir" role="presentation" style={`top:${(fileRange.start + index) * FILE_ROW_HEIGHT}px;height:${FILE_ROW_HEIGHT}px`}>
                        <button
                          type="button"
                          class="dir-name"
                          aria-expanded={!item.collapsed}
                          onclick={() => {
                            const next = new Set(collapsedDirs);
                            if (next.has(item.directory)) next.delete(item.directory);
                            else next.add(item.directory);
                            collapsedDirs = next;
                          }}
                        >
                          <Icon name="chevron-down" size={13} class={item.collapsed ? "" : "flip"} />
                          <span>{item.label}</span>
                          <span class="count">{item.count}</span>
                        </button>
                      </div>
                    {:else}
                      {@const file = item.file}
                      {@const mark = statusMark(commitFileLabel(file.status))}
                      {@const parts = splitPath(file.path)}
                      <button
                        type="button"
                        class="file-row"
                        role="option"
                        aria-selected={currentPath === file.path}
                        style={`top:${(fileRange.start + index) * FILE_ROW_HEIGHT + 1}px;height:${FILE_ROW_HEIGHT - 2}px`}
                        title={fileTitle(file)}
                        onclick={() => chooseFile(file.path)}
                        oncontextmenu={(event) => {
                          event.preventDefault();
                          fileMenu(file.path, { x: event.clientX, y: event.clientY });
                        }}
                      >
                        <span class={`st ${mark.tone}`} title={commitFileLabel(file.status)}>{mark.letter}</span>
                        <span class="file-name">
                          <span class="fn">{parts.name}</span>
                          {#if file.originalPath}
                            <span class="fd from" title={`重命名自 ${file.originalPath}`}>← {file.originalPath}</span>
                          {:else if parts.dir}
                            <span class="fd"><bdi>{parts.dir}</bdi></span>
                          {/if}
                        </span>
                        <LineCounts stat={commitLineStat(file)} hideBinary />
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}
          </aside>
          {@render filesResizer()}
          <div class="commit-diff">
            {#if viewMode === "multi"}
              <CommitDiffList
                {active}
                {opened}
                {detail}
                parent={parentChoice ?? detail.selectedParent}
                focusPath={multiFocus}
                onFocusPath={goToFile}
                {disabled}
                {nextId}
                {onGeneration}
                onFailure={onFailure}
                onFileHistory={onFilePath}
              />
            {:else}
              <DiffView
                selection={diffSelection}
                diff={commitDiff}
                error={diffError}
                loading={diffLoading}
                {disabled}
                readOnly={true}
                onStageHunk={() => {}}
                onLoadMore={loadMoreDiff}
                onFileHistory={onFilePath}
                {fileNav}
              />
            {/if}
          </div>
        </div>
      {:else if !loading}
        <div class="empty" role="status">
          <span class="empty-icon"><Icon name="commit" size={24} /></span>
          <strong>未选择提交</strong>
          <p>选择左侧一条记录查看文件和差异。</p>
        </div>
      {/if}
    </div>
  </div>
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}

  {#if checkoutTarget}
    <ConfirmDialog
      title="检出此提交"
      titleId="checkout-commit-title"
      icon="commit"
      tone="default"
      message="检出这个提交，进入游离 HEAD？"
      targets={[{ icon: "commit", name: shortOid(checkoutTarget.oid), detail: commits.find((item) => item.oid === checkoutTarget?.oid)?.summary }]}
      targetsLabel="要检出的提交"
      notes={[
        { tone: "info", text: "当前分支不会移动；之后的提交不会带动任何分支。" },
        { tone: "ok", text: "如果未提交的修改会被覆盖，则不会切换，仓库保持原样。" },
      ]}
      confirmLabel="检出"
      confirmIcon="commit"
      busy={checkoutBusy}
      error={checkoutError}
      onConfirm={() => void confirmCheckout()}
      onCancel={() => {
        if (!checkoutBusy) checkoutTarget = null;
      }}
    />
  {/if}

  {#if branchFrom}
    <Modal
      title="从此提交新建分支"
      titleId="branch-from-commit-title"
      icon="branch"
      size="sm"
      description={`起点：${shortOid(branchFrom.oid)} ${branchFrom.summary}`}
      locked={branchFrom.busy}
      onClose={() => (branchFrom = null)}
    >
      <label class="label" for="branch-from-name">分支名称</label>
      <input
        id="branch-from-name"
        class="input"
        data-autofocus
        placeholder="例如 hotfix/login"
        autocomplete="off"
        spellcheck="false"
        bind:value={branchFrom.name}
        title={branchFrom.busy ? BUSY_REASON : undefined}
        disabled={branchFrom.busy}
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void confirmBranchFrom();
          }
        }}
      />
      <label class="switch">
        <input type="checkbox" bind:checked={branchFrom.checkout} title={branchFrom.busy ? BUSY_REASON : undefined} disabled={branchFrom.busy} />
        <span>创建后切换过去</span>
      </label>
      <p class="hint">
        {branchFrom.checkout
          ? "切换沿用分支切换的保护：会覆盖未提交修改时停下，分支已创建但不切换。"
          : "只创建分支，当前分支和工作区都不变。"}
      </p>
      {#if branchFrom.error}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{branchFrom.error}</span></div>{/if}
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" title={branchFrom?.busy ? "写入完成后才能取消" : undefined} disabled={branchFrom?.busy} onclick={() => (branchFrom = null)}>取消</button>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn btn-primary"
          title={branchFrom?.busy ? BUSY_REASON : !branchFrom?.name.trim() ? "先填写分支名称" : undefined}
          disabled={branchFrom?.busy || !branchFrom?.name.trim()}
          onclick={confirmBranchFrom}
        >
          {#if branchFrom?.busy}<span class="spinner"></span>{:else}<Icon name="plus" size={14} />{/if}
          {branchFrom?.checkout ? "创建并切换" : "创建分支"}
        </button>
      {/snippet}
    </Modal>
  {/if}
</section>
