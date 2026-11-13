<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import { LatestReadQueue } from "../latest-read";
  import { api, type HistoryFilters } from "../api";
  import { normalizeError } from "../errors";
  import {
    commitFileLabel,
    commitLineStat,
    commitLineTotalLabel,
    commitLineTotals,
    commitSelectionRange,
    formatAuthoredAt,
    hashMatchLength,
    HISTORY_RANGE_PREFIX,
    HISTORY_SEARCH_DEBOUNCE_MS,
    historyAuthorSuggestions,
    historyConditions,
    historyDayBound,
    historyFilterChips,
    historyStatus,
    matchParts,
    parentCaption,
    commitBodyRest,
    preferredCommitFile,
    refPills,
    shortOid,
    shouldAppendHistory,
    toggleCommitSelection,
  } from "../history";
  import type { CommitLineTotals } from "../history";
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
    PreviewSources,
    StatusSnapshot,
    TaskSummary,
  } from "../types";
  import { FULL_FILE_CONTEXT, type HunkNavReport } from "../diff";
  import { createQuietActivity } from "../quiet-activity";
  import {
    buildHistoryGraph,
    clipSegments,
    drawableLanes,
    graphRowLabel,
    visibleNodeLane,
    GRAPH_LANE_WIDTH,
    GRAPH_MAX_LANES,
    type GraphSegment,
  } from "../history-graph";
  import { BUSY_REASON, fileNavState, hueOf, initialOf, relativeTime, splitPath, statusMark, type FileNavState } from "../ui";
  import BranchPicker from "./BranchPicker.svelte";
  import CommitDiffList from "./CommitDiffList.svelte";
  import CommitBranches from "./CommitBranches.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import LineCounts from "./LineCounts.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest, isContextKey, pointFor } from "./ContextMenu.svelte";
  import DiffView from "./DiffView.svelte";
  import FileNav from "./FileNav.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import PaneResizer from "./PaneResizer.svelte";
  import RecoveryActions from "./RecoveryActions.svelte";

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
    /** 单文件差异的上一处/下一处改动。全部文件视图不报，那里没有一条可滚的差异。 */
    onHunkNav?: (nav: HunkNavReport | null) => void;
    /**
     * 后台重新读取（已有内容保留可读）是否在途：历史列表或提交详情在原内容上重读。
     * 差异自己的标题栏已有轻量的进行中标记，不重复上报。
     * 面板里不再插横条（插横条会把列表和详情上下挤动），由外壳在状态栏右下角安静地显示。
     */
    onActivity?: (active: boolean) => void;
    /** 左栏头部（视图切换与合并提示）和右沿拖动条：由外壳提供，与改动视图是同一份。 */
    paneHead?: Snippet;
    paneResizer?: Snippet;
    /** 提交差异是否展开为完整文件；与改动视图共用同一个偏好，不传时不提供切换。 */
    fullFile?: boolean;
    onFullFile?: (next: boolean) => void;
    /** 从提交差异进入只读文档阅读；不传时不显示入口。 */
    onReadDocument?: (sources: PreviewSources, side: "old" | "new", trigger: HTMLElement | null) => void;
    /**
     * cliora 审查带来的任务范围：历史按「起点..HEAD」过滤，列表顶部多一行「任务净差异」。
     * nonce 每次跳转递增：同一个起点再跳一次也回到任务净差异。
     */
    taskRange?: { baseline: string; nonce: number } | null;
    /** 顶部那一行的摘要（含已审阅数），由外壳从任务净差异组件汇总。 */
    taskSummary?: (TaskSummary & { reviewed: number }) | null;
    /** 任务净差异的详情：选中顶部那一行时显示，选中提交时隐藏但保活。 */
    taskDetail?: Snippet<[boolean]>;
    /** 任务净差异是否正在详情区显示：外壳据此把审阅、暂存等命令作用到任务范围。 */
    onTaskFocus?: (focused: boolean) => void;
  }

  const pageReads = new LatestReadQueue();
  const detailReads = new LatestReadQueue();
  const diffReads = new LatestReadQueue();
  const multiFileReads = new LatestReadQueue();
  const multiDiffReads = new LatestReadQueue();
  onDestroy(() => {
    pageReads.close(); detailReads.close(); diffReads.close();
    multiFileReads.close(); multiDiffReads.close();
  });

  /** 提交行两行排布（摘要 / 引用·作者·时间），52px；提交里的文件行与改动列表同为单行 30px。 */
  const ROW_HEIGHT = 52;
  const FILE_ROW_HEIGHT = 30;
  const UNION_ROW_HEIGHT = 30;
  const FILES_WIDTH_KEY = "twiglane.commitFilesWidth";
  /** 范围下拉框里不是分支名的固定项。 */
  const SCOPE_EXTRAS = new Set(["current", "all", "unpushed"]);
  const DEFAULT_FILES_WIDTH = 248;
  const MIN_DIFF_WIDTH = 360;
  /** 拓扑的收起状态：本机偏好，读写失败只用默认值，不阻塞历史。 */
  const GRAPH_KEY = "twiglane.historyGraph";
  /** 紧凑宽度内最多画几条 lane，再多只留溢出标记，不挤压提交说明。 */
  const GRAPH_LANES = GRAPH_MAX_LANES;
  /** 绘图段占满整个行槽（含行与行之间的 2px 行距），上下段因此首尾相接。 */
  const GRAPH_HEIGHT = ROW_HEIGHT;
  /** 线条颜色只按 lane 序号取主题令牌，深浅两套主题都不用字面色。 */
  const LANE_TOKENS = ["--accent", "--info", "--purple", "--success", "--warning", "--danger"];

  function readGraphOn(): boolean {
    try {
      return globalThis.localStorage?.getItem(GRAPH_KEY) !== "0";
    } catch {
      return true;
    }
  }

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
    onHunkNav,
    onActivity,
    paneHead,
    paneResizer,
    branchGroups = true,
    fullFile = false,
    onFullFile,
    onReadDocument,
    taskRange = null,
    taskSummary = null,
    taskDetail,
    onTaskFocus,
  }: Props = $props();
  /** 提交差异读取的上下文：完整文件时整份读出，否则用后端默认的 3 行。只在需要时追加参数。 */
  function contextArgs(full: boolean): [] | [number] {
    return full ? [FULL_FILE_CONTEXT] : [];
  }
  /**
   * 搜索框里的读取标记：文件监听触发的重读通常很快，直接跟着 loading 画会一闪一闪，
   * 只有读取明显变慢时才出现，出现后至少停留一会儿。
   */
  let searchBusy = $state(false);
  const searchActivity = createQuietActivity((visible) => (searchBusy = visible), { showDelay: 500, minVisible: 600 });
  onDestroy(() => searchActivity.reset());
  $effect(() => {
    searchActivity.set(loading);
  });
  /** 按文本查看的提交文件（提交:路径）；换提交或文件后自动回到默认读取。 */
  let commitAsText = $state<string | null>(null);
  /** 读一个提交文件的差异：只在需要时追加上下文与按文本参数，默认调用保持原样。 */
  function readCommitDiff(
    repo: string, oid: string, parent: string | null, relative: string, generation: number,
    offset: number, limit: number, full: boolean, text: boolean,
  ) {
    if (text) return api.commitFileDiff(repo, oid, parent, relative, generation, nextId(), offset, limit, full ? FULL_FILE_CONTEXT : undefined, true);
    return api.commitFileDiff(repo, oid, parent, relative, generation, nextId(), offset, limit, ...contextArgs(full));
  }

  let menu = $state<ContextMenuRequest | null>(null);
  let recovery: RecoveryActions;
  /** 「从此提交新建分支」的输入层。 */
  let branchFrom = $state<{ oid: string; summary: string; name: string; checkout: boolean; busy: boolean; error: string | null } | null>(null);

  /** 右键菜单里的复制：菜单随点击收起，界面上没有别的变化，所以成功也要说一声复制了什么。 */
  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice?.(`已复制${what}`);
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
          { id: "hash", label: "复制哈希", icon: "copy", run: () => void copyText(ordered.join("\n"), ` ${ordered.length} 个提交哈希`) },
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
            id: "undo",
            label: "撤销最近提交并保留改动",
            icon: "undo",
            disabledReason: writeReason() ?? (commit.oid !== opened.snapshot.branch.headOid
              ? "只能撤销当前分支的最近一次提交"
              : opened.snapshot.branch.detached ? "请先切换到本地分支" : undefined),
            run: () => void recovery.undoLatest(commit.oid),
          },
          {
            id: "branch",
            label: "从此提交新建分支",
            icon: "branch",
            disabledReason: writeReason(),
            run: () => (branchFrom = { oid: commit.oid, summary: commit.summary, name: "", checkout: true, busy: false, error: null }),
          },
          { id: "hash", label: "复制提交哈希", icon: "copy", run: () => void copyText(commit.oid, `提交哈希 ${shortOid(commit.oid)}`) },
          { id: "summary", label: "复制提交说明", icon: "copy", run: () => void copyText(commit.summary, "提交说明") },
        ];
    menu = { x: point.x, y: point.y, entries, label: ordered.length > 1 ? `已选 ${ordered.length} 个提交的操作` : `提交 ${shortOid(commit.oid)} 的操作` };
  }

  function fileMenu(relative: string, point: { x: number; y: number }) {
    const entries: ContextMenuEntry[] = [
      { id: "history", label: "查看此文件历史", icon: "history", run: () => onFilePath(relative) },
      { id: "copy", label: "复制相对路径", icon: "copy", run: () => void copyText(relative, `相对路径 ${relative}`) },
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
  let authorOpen = $state(false);
  let authorActive = $state(0);
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
  /** 收起时仍列出已生效的作者、日期、路径：不用展开面板也知道列表被什么条件收窄，并能逐项清除。 */
  let filterChips = $derived(
    historyFilterChips({ author: activeAuthor, path: filePath ? "" : activePath, since: activeSince, until: activeUntil }),
  );
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
  let authorSuggestions = $derived(historyAuthorSuggestions(commits, author));
  let authorListOpen = $derived(authorOpen && authorSuggestions.length > 0);
  let listError = $state<string | null>(null);
  /** 本地筛选条件问题（例如日期无效）：不是读取失败，不给必然失败的重试。 */
  let listProblem = $state<string | null>(null);
  let appendError = $state<string | null>(null);
  let appendStopped = $state(false);
  let loading = $state(false);
  /** 列表读取中（区别于追加分页）：重新读取时保留旧结果并显示进行中状态。 */
  let refreshing = $state(false);
  /** 详情读取中：首次加载与保留旧详情重新读取都据此显示状态，不落成「未选择」。 */
  let detailLoading = $state(false);
  /** 失败后「重新读取」：条件未变时也强制再读一次。 */
  let retryTick = $state(0);
  /** 详情读取失败后的重读：同一条提交也要能原地重试。 */
  let detailRetryTick = $state(0);
  let selectedOids = $state.raw<string[]>([]);
  let anchorOid = $state<string | null>(null);
  let checkoutTarget = $state<HistoryCommit | null>(null);
  let checkoutBusy = $state(false);
  let checkoutError = $state<string | null>(null);
  /**
   * 多选只看最终结果：「最早所选的父提交 → 最新所选」之间的净文件清单与净差异，
   * 不再把每个提交的改动逐个堆叠——中间改了又改回的内容不会出现。
   */
  let multiFiles = $state.raw<CommitFileChange[]>([]);
  let multiError = $state<string | null>(null);
  /** 净文件清单读取中：读完前不把空清单当成「没有文件变化」。 */
  let multiLoading = $state(false);
  /**
   * 多选读取的请求边界：每次重新选择、换仓库、切视图、重读或取消都换一张票。
   * 只有当前票能改加载状态与结果，旧票的迟到结果既不落地也不把转圈留在屏幕上。
   */
  let multiTicket = 0;
  /** 多选清单原地重读入口：条件没变也重新取一遍，不依赖用户改选择。 */
  let multiRetry = $state(0);
  /** 多选差异读取中：只为真正在途的读取显示转圈。 */
  let multiDiffLoading = $state(false);
  /** 多选差异原地重读入口。 */
  let multiDiffRetry = $state(0);
  let multiDiff = $state.raw<DiffResponse | null>(null);
  let multiDiffError = $state<string | null>(null);
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
  /** 拓扑按已加载的全部提交推导：搜索、筛选、范围、文件和 generation 变化都重算，追加页也整体重算。 */
  let graph = $derived(buildHistoryGraph(commits, { headOid: opened.snapshot.branch.headOid }));
  let graphLanes = $derived(drawableLanes(graph.lanes, GRAPH_LANES));
  /** 每行宽度一致（按整份结果的 lane 数），行与行之间的提交说明不会左右跳。 */
  let graphWidth = $derived(graphLanes * GRAPH_LANE_WIDTH + 3);
  let graphOn = $state(readGraphOn());

  /** 已有内容上的重读：首次读取有自己的空状态，不算后台活动。 */
  let backgroundActivity = $derived(
    active && ((refreshing && commits.length > 0) || (detailLoading && detail !== null)),
  );
  $effect(() => {
    const busy = backgroundActivity;
    untrack(() => onActivity?.(busy));
  });
  onDestroy(() => onActivity?.(false));

  function saveGraphOn() {
    try {
      globalThis.localStorage?.setItem(GRAPH_KEY, graphOn ? "1" : "0");
    } catch {
      // 存储不可用时只在本次会话里生效。
    }
  }

  function toggleGraph() {
    graphOn = !graphOn;
    saveGraphOn();
  }

  /** 越界 lane 在绘制前就被 clipSegments 丢掉，这里不再夹取：夹取会把两条线叠成一条。 */
  function laneX(lane: number): number {
    return lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2 + 1;
  }

  /** 每行只画自己的片段：竖线、汇入和分叉都在行内闭合，悬停/选择不改变线条。 */
  function segmentPath(segment: GraphSegment, height: number): string {
    const x0 = laneX(segment.from);
    const x1 = laneX(segment.to);
    const mid = height / 2;
    if (segment.kind === "merge") return `M ${x0} 0 L ${x1} ${mid}`;
    if (segment.kind === "branch") return `M ${x0} ${mid} L ${x1} ${height}`;
    // 结果外父提交：从节点伸出一段短尾就停，不接到下一行，表明还有更早的提交没列出来。
    if (segment.kind === "outside") {
      const end = mid + (height - mid) * 0.6;
      return `M ${x0} ${mid} L ${x0 + (x1 - x0) * 0.6} ${end}`;
    }
    if (segment.span === "top") return `M ${x0} 0 L ${x0} ${mid}`;
    if (segment.span === "bottom") return `M ${x0} ${mid} L ${x0} ${height}`;
    return `M ${x0} 0 L ${x0} ${height}`;
  }

  function laneStyle(color: number): string {
    return `--lane: var(${LANE_TOKENS[Math.abs(color) % LANE_TOKENS.length]})`;
  }

  /** 键盘游标所在的提交：与选中锚点一致，用 aria-activedescendant 指给辅助技术。 */
  let cursorOid = $derived(anchorOid ?? selectedOids[0] ?? null);
  let activeDescendant = $derived(
    cursorOid && visible.some((commit) => commit.oid === cursorOid) ? "history-commit-" + cursorOid : undefined,
  );
  /** 已经在最新提交：此时「回到最新」没有可做的事，禁用并说明原因（R6）。 */
  let atNewest = $derived(commits.length > 0 && scrollTop <= 0);
  /** 「回到最新」只在离开顶部后出现；在最新时没有可做的事，不摆一个灰按钮占位。底栏高度固定，按钮出现不推动列表。 */
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
  /**
   * 引用胶囊是否收起：切换提交不重置，收起状态一直跟着用户的选择。
   * 收起只在多引用时有意义：单引用的提交忽略收起状态，否则「当前分支指向它」这类
   * 唯一标签会被永久藏掉且没有展开入口（开关在单引用时不渲染）。
   */
  let refsCollapsed = $state(false);
  /** 用户是否手动收/展过引用：动过之后不再自动调整，切换提交也不重置。 */
  let refsUserSet = $state(false);
  let detailPills = $derived(detail ? refPills(detail.commit.labels) : []);
  /* 引用超过三个时默认收成「引用 N」计数，把头部高度让给变更文件与差异；两三个引用
     直接铺开，构不成堆叠就不藏。用户手动收/展过一次后完全跟着用户的选择走。 */
  $effect(() => {
    const count = detailPills.length;
    if (!refsUserSet) refsCollapsed = count > 3;
  });
  /** 变更文件栏的宽度：拖动中间的分隔条调整，存在本机偏好里；渲染时给差异区至少留 MIN_DIFF_WIDTH。 */
  let filesWidth = $state(readFilesWidth());
  let splitWidth = $state(0);
  let filesShown = $derived(fitFilesWidth(filesWidth, splitWidth));
  /** 「全部文件」模式下从左侧点选的文件：右侧滚动到它。 */
  let multiFocus = $state<string | null>(null);
  let filteredFiles = $derived(filterRows(detail?.files ?? [], fileFilter));
  let fileBuckets = $derived(directoryMode ? bucketByDirectory(filteredFiles) : []);
  /** 整次提交的增删行数：只加文本文件，二进制和没有统计的文件不计入，全都没有统计时不显示。 */
  let lineTotals = $derived(commitLineTotals(detail?.files ?? []));
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
  /** 多选时的文件导航：在净文件清单里前后移动，和单个提交的文件导航是同一套命令。 */
  let unionNav = $derived(
    selectedOids.length > 1 && multiFiles.length > 0
      ? fileNavState(multiFiles, multiFiles.findIndex((file) => file.path === unionActive?.path), (file) => focusUnion(file.path))
      : null,
  );


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

  /** 除范围以外的筛选条件：「未推送」为空时据此区分「全推送了」和「被筛掉了」。 */
  let hasNarrowing = $derived(Boolean(activeQuery || activeAuthor || activePath || activeSince || activeUntil));
  let statusText = $derived(
    !listError && page && commits.length === 0
      ? activeScope === "unpushed" && page.state === "no_match" && !hasNarrowing
        ? "当前分支没有未推送的提交。"
        : historyStatus(page.state)
      : null,
  );
  let hasActiveFilters = $derived(
    Boolean(activeQuery || activeAuthor || activePath || activeSince || activeUntil || activeScope !== "current"),
  );
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
    if (!SCOPE_EXTRAS.has(scope) && !scope.startsWith(HISTORY_RANGE_PREFIX) && !names.includes(scope)) return [...names, scope];
    return names;
  });
  /** 任务范围在范围下拉框里是一个固定项：离开后还能从这里回来。 */
  let rangeScope = $derived(taskRange ? `${HISTORY_RANGE_PREFIX}${taskRange.baseline}` : null);
  let scopeExtras = $derived([
    ...(rangeScope && taskRange
      ? [{ value: rangeScope, label: `任务范围（${shortOid(taskRange.baseline)}..HEAD）`, icon: "layers" as const }]
      : []),
    { value: "current", label: `当前分支${page?.head ? `（${page.head}）` : ""}`, icon: "branch" as const },
    { value: "unpushed", label: "未推送的提交", icon: "upload" as const },
    { value: "all", label: "全部分支", icon: "layers" as const },
  ]);
  /** 顶部「任务净差异」行只在任务范围生效、且不是单文件历史时出现。 */
  let taskRowShown = $derived(Boolean(rangeScope && activeScope === rangeScope && !filePath && taskDetail));
  /** 任务净差异是否占着详情区：选中了顶部那一行，而不是某个提交。 */
  let taskFocused = $state(false);
  let taskShown = $derived(taskRowShown && taskFocused);
  $effect(() => {
    const shown = active && taskShown;
    untrack(() => onTaskFocus?.(shown));
  });
  onDestroy(() => onTaskFocus?.(false));

  let reportedNav = $derived(taskShown ? null : selectedOids.length > 1 ? unionNav : fileNav);

  $effect(() => {
    onFileNav?.(reportedNav);
    return () => onFileNav?.(null);
  });

  /** 每次 cliora 跳转（nonce 变化）：清掉其它筛选，切到任务范围并选中「任务净差异」。 */
  let seenTaskNonce = 0;
  $effect(() => {
    const range = taskRange;
    untrack(() => {
      if (!range) {
        seenTaskNonce = 0;
        taskFocused = false;
        if (activeScope.startsWith(HISTORY_RANGE_PREFIX)) {
          scope = "current";
          activeScope = "current";
        }
        return;
      }
      if (range.nonce === seenTaskNonce) return;
      seenTaskNonce = range.nonce;
      query = "";
      author = "";
      pathFilter = "";
      sinceDay = "";
      untilDay = "";
      activeQuery = "";
      activeAuthor = "";
      activePath = "";
      activeSince = "";
      activeUntil = "";
      scope = `${HISTORY_RANGE_PREFIX}${range.baseline}`;
      activeScope = scope;
      focusTask();
    });
  });

  /** 选中顶部「任务净差异」：提交选择清空，详情区交给任务净差异。 */
  function focusTask() {
    taskFocused = true;
    selectedOids = [];
    anchorOid = null;
    parentChoice = null;
    manualPath = null;
    multiFocus = null;
  }
  /** 历史范围下拉框的分支行：后端只给本地分支名，这里补成分支记录。 */
  let scopeBranches = $derived(
    scopeNames.map((name): BranchRecord => ({ name, remote: false, current: name === page?.head, upstream: null, worktree: null })),
  );
  let selectedIds = $derived(new Set(selectedOids));
  let selectedCommits = $derived(commits.filter((commit) => selectedIds.has(commit.oid)));
  let unionFiles = $derived(multiFiles);
  /** 净结果的合计：两点之间的净行数，中间改了又改回的行不计入。 */
  let unionLineTotals = $derived(multiLoading ? null : commitLineTotals(unionFiles));
  let unionActive = $derived(unionFiles.find((file) => file.path === multiFocus) ?? unionFiles[0] ?? null);
  let unionScroll = $state(0);
  let unionViewport = $state(0);
  let unionList = $state<HTMLDivElement | null>(null);
  /**
   * 多选的比较两端：最新所选（列表里最上面那个）与最早所选的第一父提交。
   * 所选提交在同一条第一父链上首尾相接时是「连续」的；否则中间未选的提交也计入净结果，界面要说清楚。
   */
  let multiRange = $derived.by(() => {
    if (selectedCommits.length < 2) return null;
    const newest = selectedCommits[0];
    const oldest = selectedCommits[selectedCommits.length - 1];
    let linear = true;
    for (let index = 0; index < selectedCommits.length - 1; index += 1) {
      if (selectedCommits[index].parents[0] !== selectedCommits[index + 1].oid) {
        linear = false;
        break;
      }
    }
    return { head: newest.oid, base: oldest.parents[0] ?? null, linear };
  });
  let multiKey = $derived(multiRange ? `${multiRange.base ?? ""}..${multiRange.head}` : "");
  let unionRange = $derived(visibleRange(
    unionFiles.length, unionScroll, unionViewport > 0 ? unionViewport : unionScroll > 0 ? UNION_ROW_HEIGHT : 0, UNION_ROW_HEIGHT,
  ));
  let visibleUnionFiles = $derived(unionFiles.slice(unionRange.start, unionRange.end));
  $effect(() => {
    void unionFiles;
    unionScroll = 0;
    if (unionList) unionList.scrollTop = 0;
  });

  function onDetailFilesKey(event: KeyboardEvent) {
    if (isContextKey(event) && currentPath) {
      event.preventDefault();
      const row = fileListEl?.querySelector<HTMLElement>('.file-row[aria-selected="true"]');
      fileMenu(currentPath, row ? pointFor(row) : { x: 160, y: 160 });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (filteredFiles.length === 0) return;
    const index = filteredFiles.findIndex((file) => file.path === currentPath);
    const next = nextIndex(index, event.key, filteredFiles.length);
    if (next === null) return;
    event.preventDefault();
    goToFile(filteredFiles[next].path);
    fileListEl?.focus({ preventScroll: true });
  }

  function onUnionKey(event: KeyboardEvent) {
    if (isContextKey(event) && unionActive) {
      event.preventDefault();
      const row = unionList?.querySelector<HTMLElement>('.file-row[aria-selected="true"]');
      fileMenu(unionActive.path, row ? pointFor(row) : { x: 160, y: 160 });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = unionFiles.findIndex((file) => file.path === unionActive?.path);
    const next = nextIndex(index, event.key, unionFiles.length);
    if (next === null) return;
    event.preventDefault();
    focusUnion(unionFiles[next].path);
    unionList?.focus({ preventScroll: true });
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

  let loadedRepo: string | null = null;
  $effect(() => {
    if (!active) return;
    const repo = repoPath;
    // 选择只属于产生它的仓库；先清空，不能等新列表返回后才换掉旧 oid。
    untrack(() => {
      if (loadedRepo === repo) return;
      loadedRepo = repo;
      selectedOids = [];
      commits = [];
      page = null;
      detail = null;
      taskFocused = Boolean(taskRange);
      detailError = null;
      parentChoice = null;
      manualPath = null;
      multiFocus = null;
      anchorOid = null;
    });
    const generation = readGeneration;
    const relative = filePath;
    const q = activeQuery;
    const scopeName = activeScope;
    const problem = dateProblem();
    const filters = historyFilters(Boolean(relative));
    // 回到顶部只看「浏览条件」是否变化（仓库、文件、搜索、范围、筛选、重试）；generation 只是
    // 新鲜度令牌，刷新会改它但不改浏览条件，不能把它算进来，否则每次刷新都把列表拉回顶部（R3）。
    const signature = [repo, relative ?? "", q, scopeName, activeAuthor, activeSince, activeUntil, activePath, retryTick].join("\u0000");
    const previousPage = untrack(() => page);
    const serial = ++loadSerial;
    appendStopped = false;
    appendError = null;
    listProblem = null;
    loading = true;
    refreshing = true;
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
          listProblem = problem;
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
        if (kept.length === 0 && untrack(() => taskFocused && taskRowShown)) {
          // 任务净差异占着详情区：列表换页或刷新不把选择抢回到第一个提交。
          selectedOids = [];
          anchorOid = null;
        } else if (kept.length === 0) {
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
        if (!cancelled && serial === loadSerial) {
          loading = false;
          refreshing = false;
        }
      }
    })();
    return () => {
      cancelled = true;
      if (serial === loadSerial) refreshing = false;
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
    if (!active) {
      detailLoading = false;
      return;
    }
    const repo = repoPath;
    const generation = readGeneration;
    const oid = selectedOid;
    const parent = parentChoice;
    void detailRetryTick;
    if (!oid) {
      detail = null;
      detailError = null;
      commitDiff = null;
      detailLoading = false;
      return;
    }
    let cancelled = false;
    detailError = null;
    detailLoading = true;
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
      } finally {
        if (!cancelled) detailLoading = false;
      }
    })();
    return () => {
      cancelled = true;
      detailLoading = false;
    };
  });

  $effect(() => {
    if (!active) {
      commitDiff = null;
      diffLoading = false;
      return;
    }
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
    const text = commitAsText === `${oid}:${relative}`;
    const full = fullFile;
    let cancelled = false;
    diffLoading = true;
    diffError = null;
    void (async () => {
      try {
        const result = await diffReads.run(() => readCommitDiff(repo, oid, parent, relative, generation, 0, 0, full, text));
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

  /** 净文件清单：两端不变（只是列表刷新）时不重读；两端或代次变化才读。 */
  $effect(() => {
    void multiRetry;
    const key = multiKey;
    const repo = repoPath;
    const generation = readGeneration;
    multiFiles = [];
    multiError = null;
    multiLoading = false;
    if (!active || !key) return;
    const range = untrack(() => multiRange);
    if (!range) return;
    const ticket = ++multiTicket;
    // 只有当前请求边界能改状态：换选择、换仓库、切视图或取消之后，旧票一律作废。
    const owned = () => ticket === multiTicket && opened.summary.path === repo;
    multiLoading = true;
    void (async () => {
      try {
        const result = await multiFileReads.run(() => api.compareFiles(repo, range.base, range.head, generation, nextId()));
        if (!owned()) return;
        multiFiles = result.files;
        // 换了选择但同一个文件仍在净结果里：保持正在读的文件。
        if (!result.files.some((file) => file.path === multiFocus)) multiFocus = result.files[0]?.path ?? null;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (!owned()) return;
        const failure = normalizeError(error);
        if (failure.code === "cancelled") return;
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        // 读取失败不冒充「没有文件变化」：撤下清单，就地给重读入口。
        multiError = failure.message;
      } finally {
        if (owned()) multiLoading = false;
      }
    })();
    return () => {
      multiTicket += 1;
      multiLoading = false;
    };
  });

  /** 所选文件的净差异：同一对两端、同一份完整文件偏好。 */
  let multiDiffSerial = 0;
  $effect(() => {
    void multiDiffRetry;
    const key = multiKey;
    const file = unionActive?.path ?? null;
    const full = fullFile;
    const repo = repoPath;
    const generation = readGeneration;
    multiDiffError = null;
    if (!active || !key || !file || multiLoading) {
      if (!key || !file) multiDiff = null;
      multiDiffLoading = false;
      return;
    }
    const range = untrack(() => multiRange);
    if (!range) return;
    const serial = ++multiDiffSerial;
    let cancelled = false;
    multiDiffLoading = true;
    void (async () => {
      try {
        const result = await multiDiffReads.run(() =>
          api.compareFileDiff(repo, range.base ?? "", range.head, file, generation, nextId(), 0, 0, ...contextArgs(full)),
        );
        if (cancelled || serial !== multiDiffSerial || opened.summary.path !== repo) return;
        multiDiff = result;
        if (result.generation !== generation) onGeneration(result.generation);
      } catch (error) {
        if (cancelled || serial !== multiDiffSerial) return;
        const failure = normalizeError(error);
        if (failure.code === "cancelled") return;
        if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== generation) {
          onGeneration(failure.generation);
          return;
        }
        multiDiff = null;
        multiDiffError = failure.message;
      } finally {
        if (!cancelled && serial === multiDiffSerial) multiDiffLoading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  async function loadMoreMultiDiff() {
    const current = multiDiff;
    const range = multiRange;
    const file = unionActive?.path ?? null;
    if (!current || !range || !file || current.path !== file) return;
    if (current.offset + current.lines.length >= current.totalLines) return;
    const repo = opened.summary.path;
    const serial = multiDiffSerial;
    try {
      const result = await api.compareFileDiff(
        repo, range.base ?? "", range.head, file, opened.generation, nextId(),
        current.offset + current.lines.length, 400, ...contextArgs(fullFile),
      );
      if (serial !== multiDiffSerial || opened.summary.path !== repo) return;
      multiDiff = {
        ...result,
        offset: current.offset,
        lines: [...current.lines, ...result.lines],
        hunks: mergeHunks(current.hunks, result.hunks, current.lines.length),
        totalLines: result.totalLines,
      };
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== opened.generation) {
        onGeneration(failure.generation);
        return;
      }
      multiDiffError = failure.message;
    }
  }

  /** 多选文件列表里选中一个文件，并把它滚进可见区。 */
  function focusUnion(path: string) {
    multiFocus = path;
    const index = unionFiles.findIndex((file) => file.path === path);
    unionScroll = scrollIndexIntoView(index, unionScroll, unionViewport, UNION_ROW_HEIGHT);
    if (unionList) unionList.scrollTop = unionScroll;
  }

  function scheduleText() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      activeQuery = query.trim();
      activeAuthor = author.trim();
      activePath = pathFilter.trim();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
  }

  function chooseAuthor(candidate: (typeof authorSuggestions)[number]): void {
    author = candidate.value;
    activeAuthor = candidate.value;
    authorOpen = false;
    authorActive = 0;
  }

  function onAuthorKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && authorSuggestions.length > 0) {
      event.preventDefault();
      authorOpen = true;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      authorActive = (authorActive + delta + authorSuggestions.length) % authorSuggestions.length;
      return;
    }
    if (event.key === "Enter" && authorListOpen) {
      event.preventDefault();
      event.stopPropagation();
      const candidate = authorSuggestions[authorActive];
      if (candidate) chooseAuthor(candidate);
      return;
    }
    if (event.key === "Escape") {
      if (authorOpen) {
        event.preventDefault();
        event.stopPropagation();
        authorOpen = false;
      } else if (author) {
        event.preventDefault();
        event.stopPropagation();
        clearFilter("author");
      }
      return;
    }
    if (event.key === "Tab") authorOpen = false;
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
    if (kind === "author") {
      author = "";
      authorOpen = false;
      authorActive = 0;
    }
    if (kind === "path") pathFilter = "";
    if (kind === "since") sinceDay = "";
    if (kind === "until") untilDay = "";
    activeQuery = query.trim();
    activeAuthor = author.trim();
    activePath = pathFilter.trim();
    activeSince = sinceDay;
    activeUntil = untilDay;
  }

  /** 只清作者、日期、路径：保留搜索词与范围，「更多筛选」面板里的一键清除。 */
  function clearAdvancedFilters() {
    author = "";
    authorOpen = false;
    authorActive = 0;
    if (!filePath) pathFilter = "";
    sinceDay = "";
    untilDay = "";
    activeAuthor = "";
    activePath = pathFilter.trim();
    activeSince = "";
    activeUntil = "";
  }

  /** 无匹配时一次清掉全部筛选，回到可读的当前范围。 */
  function clearAllFilters() {
    query = "";
    author = "";
    authorOpen = false;
    authorActive = 0;
    pathFilter = "";
    sinceDay = "";
    untilDay = "";
    activeQuery = "";
    activeAuthor = "";
    activePath = "";
    activeSince = "";
    activeUntil = "";
    scope = "current";
    activeScope = "current";
  }

  /** 读取失败后的重试：条件不变时用 retryTick 强制重跑同一次读取，不重复写入。 */
  function retryHistory() {
    if (loading) return;
    retryTick += 1;
  }

  /** 详情读取失败时重读当前选中提交，不改变选择。 */
  function retryDetail() {
    if (detailLoading) return;
    detailRetryTick += 1;
  }

  function singleSelect(oid: string) {
    taskFocused = false;
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
    taskFocused = false;
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

  /** 搜索框和提交列表是同一套选择：回车确认当前或第一条，向下把焦点交进列表。 */
  function onSearchKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      clearFilter("query");
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    if (commits.length === 0) return;
    event.preventDefault();
    const current = commits.findIndex((commit) => commit.oid === (anchorOid ?? selectedOids[0] ?? null));
    const next = event.key === "Enter" || current < 0
      ? commits[current >= 0 ? current : 0]
      : current < commits.length - 1
        ? commits[current + 1]
        : null;
    if (next) {
      reveal(commits.indexOf(next));
      singleSelect(next.oid);
    }
    list?.focus({ preventScroll: true });
  }

  function onListKey(event: KeyboardEvent) {
    const anchor = anchorOid ?? selectedOids[0] ?? null;
    const current = commits.findIndex((commit) => commit.oid === anchor);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (commits.length === 0) return;
      taskFocused = false;
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
    if ((event.key === "ArrowUp" || event.key === "k") && !event.shiftKey && current <= 0 && taskRowShown && !taskFocused) {
      event.preventDefault();
      focusTask();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "k") && !event.shiftKey && (current === 0 || (taskFocused && taskRowShown))) {
      event.preventDefault();
      document.getElementById("history-search")?.focus();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "j") && !event.shiftKey && taskFocused && taskRowShown) {
      event.preventDefault();
      const first = commits[0];
      if (first) {
        reveal(0);
        singleSelect(first.oid);
      }
      return;
    }
    const move = nextIndex(current, event.key, commits.length);
    if (move === null) return;
    event.preventDefault();
    reveal(move);
    const commit = commits[move];
    if (!commit) return;
    if (event.shiftKey) selectedOids = commitSelectionRange(commits.map((item) => item.oid), anchorOid, commit.oid);
    else singleSelect(commit.oid);
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
      const result = await readCommitDiff(
        repo,
        currentDetail.commit.oid,
        parent,
        file.path,
        opened.generation,
        current.offset + current.lines.length,
        400,
        fullFile,
        commitAsText === `${currentDetail.commit.oid}:${file.path}`,
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

{#snippet lineTotal(totals: CommitLineTotals, subject: string, failed = 0)}
  {@const label = commitLineTotalLabel(totals, subject, failed)}
  <span class="diff-stats commit-line-total" title={label} aria-label={label}>
    <span class="plus">+{totals.additions}</span>
    <span class="minus">−{totals.deletions}</span>
  </span>
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
            extras={scopeExtras}
            {branchGroups}
            onChange={setScope}
          />
          <div class="history-search-row">
            <div class="field sm history-search">
              <Icon name="search" size={14} />
              <input
                id="history-search"
                aria-label="搜索说明或提交哈希"
                placeholder="说明或提交哈希"
                title="输入时自动搜索；↓ 进入提交列表，Enter 打开所选提交"
                autocomplete="off"
                spellcheck="false"
                value={query}
                onkeydown={onSearchKey}
                oninput={(event) => {
                  query = event.currentTarget.value;
                  scheduleText();
                }}
              />
              {#if query}
                <button type="button" class="field-clear" aria-label="清除说明或哈希" onclick={() => clearFilter("query")}><Icon name="x" size={12} /></button>
              {/if}
              {#if searchBusy}<span class="spinner"></span>{/if}
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
            <button
              type="button"
              class="icon-btn history-graph-toggle"
              class:active={graphOn}
              aria-pressed={graphOn}
              aria-label={graphOn ? "收起提交拓扑" : "展开提交拓扑"}
              title={graphOn ? "收起提交拓扑" : "展开提交拓扑"}
              onclick={toggleGraph}
            >
              <Icon name="branch" size={15} />
            </button>
          </div>
          {#if moreFilters}
          <div class="history-more-filters" id="history-more-filters">
            <div class="history-filter-field">
              <label for="history-author">作者 <span>姓名或邮箱</span></label>
              <div
                class="history-author-combobox"
                onfocusout={(event) => {
                  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) authorOpen = false;
                }}
              >
                <div class="field sm" class:open={authorListOpen}>
                  <Icon name="user" size={14} />
                  <input
                    id="history-author"
                    role="combobox"
                    aria-label="作者"
                    aria-autocomplete="list"
                    aria-expanded={authorListOpen}
                    aria-controls="history-author-suggestions"
                    aria-activedescendant={authorListOpen ? `history-author-${authorActive}` : undefined}
                    placeholder="输入姓名或邮箱"
                    autocomplete="off"
                    spellcheck="false"
                    value={author}
                    onfocus={() => {
                      authorOpen = true;
                      authorActive = 0;
                    }}
                    onkeydown={onAuthorKey}
                    oninput={(event) => {
                      author = event.currentTarget.value;
                      authorActive = 0;
                      authorOpen = true;
                      scheduleText();
                    }}
                  />
                  {#if author}
                    <button type="button" class="field-clear" aria-label="清除作者" onclick={() => clearFilter("author")}><Icon name="x" size={12} /></button>
                  {/if}
                </div>
                {#if authorListOpen}
                  <div class="history-author-suggestions" id="history-author-suggestions" role="listbox" aria-label="作者建议">
                    {#each authorSuggestions as candidate, index (`${candidate.name}\0${candidate.email}`)}
                      <button
                        type="button"
                        id={`history-author-${index}`}
                        role="option"
                        aria-selected={index === authorActive}
                        onmousedown={(event) => event.preventDefault()}
                        onclick={() => chooseAuthor(candidate)}
                      >
                        <span class="avatar" style={`--hue:${hueOf(candidate.name || candidate.email)}`} aria-hidden="true">{initialOf(candidate.name || candidate.email)}</span>
                        <span class="author-suggestion-text">
                          <strong>{candidate.name || candidate.email}</strong>
                          {#if candidate.name && candidate.email}<span>{candidate.email}</span>{/if}
                        </span>
                      </button>
                    {/each}
                    <p>来自已加载的提交</p>
                  </div>
                {/if}
              </div>
            </div>
            <div class="history-filter-row">
              <label class="history-date-field"><span>开始日期</span><input class="input" type="date" aria-label="开始日期" value={sinceDay} oninput={(event) => setDay("since", event.currentTarget.value)} /></label>
              <label class="history-date-field"><span>结束日期</span><input class="input" type="date" aria-label="结束日期" value={untilDay} oninput={(event) => setDay("until", event.currentTarget.value)} /></label>
            </div>
            <div class="history-filter-field">
              <label for="history-path">路径 <span>仓库相对路径</span></label>
              <div class="field sm">
                <Icon name="folder" size={14} />
                <input
                  id="history-path"
                  aria-label="路径"
                  placeholder="例如 src/lib"
                  autocomplete="off"
                  spellcheck="false"
                  value={filePath ?? pathFilter}
                  disabled={Boolean(filePath)}
                  title={filePath ? "文件历史的路径不能改" : undefined}
                  onkeydown={(event) => {
                    if (!filePath && event.key === "Escape" && pathFilter) {
                      event.preventDefault();
                      event.stopPropagation();
                      clearFilter("path");
                    }
                  }}
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
            {#if advancedCount > 0}
              <div class="history-filter-actions">
                <button type="button" class="btn btn-ghost btn-sm" onclick={clearAdvancedFilters}>
                  <Icon name="x" size={12} />清除作者、日期与路径
                </button>
              </div>
            {/if}
          </div>
          {:else if filterChips.length > 0}
            <ul class="history-filter-chips" aria-label="生效的筛选条件">
              {#each filterChips as chip (chip.kind)}
                <li class="history-filter-chip" title={chip.title}>
                  <Icon name={chip.kind === "author" ? "user" : chip.kind === "path" ? "folder" : "history"} size={11} />
                  <span class="truncate">{chip.label}</span>
                  <button type="button" aria-label={`清除${chip.title}`} onclick={() => clearFilter(chip.kind)}><Icon name="x" size={10} /></button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
      {#if listError && !refreshing && commits.length > 0}
        <div class="infobar error" role="alert">
          <Icon name="alert-circle" size={15} />
          <span class="infobar-text">{listError}</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick={retryHistory}>重新读取</button>
        </div>
        {#if showConditions}<p class="history-conditions">{conditionText}</p>{/if}
      {/if}
      {#if appendError}
        <div class="infobar error" role="alert"><Icon name="alert-circle" size={15} /><span class="infobar-text">{appendError}已显示的提交仍保留。</span></div>
      {/if}
      {#if taskRowShown}
        {@const summary = taskSummary}
        <!-- 任务净差异：起点到工作区的最终结果，排在范围内提交之前；选中它时详情区显示任务审阅。 -->
        <button
          type="button"
          class="history-task-row"
          aria-pressed={taskFocused}
          title="起点到当前工作区的最终结果：已提交与未提交的改动合成一份，只读"
          onclick={() => {
            focusTask();
            list?.focus({ preventScroll: true });
          }}
        >
          <span class="history-task-icon" aria-hidden="true"><Icon name="layers" size={15} /></span>
          <span class="hr-main">
            <span class="hr-line">
              <span class="hr-summary">任务净差异</span>
            </span>
            <span class="hr-meta">
              {#if !summary || summary.state === "reading"}
                <span>正在读取任务范围……</span>
              {:else if summary.state === "failed"}
                <span class="history-task-warn">任务范围读取失败，点开查看原因</span>
              {:else if summary.state === "empty"}
                <span>起点 {summary.baseline} 之后没有净改动</span>
              {:else if summary.state === "none"}
                <span>没有任务范围</span>
              {:else}
                <span>{summary.files} 个文件</span>
                <LineCounts stat={{ additions: summary.additions, deletions: summary.deletions }} />
                <span class="hr-dot"></span>
                <span class:history-task-done={summary.reviewed === summary.files && summary.files > 0}>已审阅 {summary.reviewed}/{summary.files}</span>
                {#if summary.dirty}<span class="hr-dot"></span><span>含未提交</span>{/if}
              {/if}
            </span>
          </span>
        </button>
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
        {#if (loading && !page) || (refreshing && commits.length === 0)}
          <div class="empty" role="status" aria-busy="true"><span class="empty-icon"><span class="spinner"></span></span><strong>{page ? "正在重新读取历史" : "正在读取历史"}</strong></div>
        {:else if listError && !refreshing && commits.length === 0 && listProblem}
          <div class="empty" role="status" data-history-problem>
            <span class="empty-icon warn"><Icon name="filter" size={22} /></span>
            <strong>筛选条件无效，未读取历史。</strong>
            <p>{listProblem}</p>
            {#if showConditions}<p class="history-conditions">{conditionText}</p>{/if}
            <button type="button" class="btn btn-secondary btn-sm" onclick={clearAllFilters}>清除筛选条件</button>
          </div>
        {:else if listError && !refreshing && commits.length === 0}
          <div class="empty" role="status" data-history-error>
            <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
            <strong>历史没有读取成功。</strong>
            <p>{listError}</p>
            {#if showConditions}<p class="history-conditions">{conditionText}</p>{/if}
            <button type="button" class="btn btn-secondary btn-sm" onclick={retryHistory}>重新读取</button>
            {#if hasActiveFilters}<button type="button" class="btn btn-ghost btn-sm" onclick={clearAllFilters}>清除筛选条件</button>{/if}
          </div>
        {:else if statusText}
          <div class="empty" role="status">
            <span class="empty-icon"><Icon name={page?.state === "no_match" ? "search" : page?.state === "no_file_history" ? "file" : page?.state === "empty_branch" ? "branch" : "commit"} size={22} /></span>
            <strong>{statusText}</strong>
            {#if showConditions}<p class="history-conditions">{conditionText}</p>{/if}
            {#if filePath && page?.state === "no_file_history"}
              <button type="button" class="btn btn-secondary btn-sm" onclick={onClearFile}>返回全部历史</button>
            {:else if page?.state === "no_match" && hasActiveFilters}
              <button type="button" class="btn btn-secondary btn-sm" onclick={clearAllFilters}>清除筛选条件</button>
            {/if}
          </div>
        {:else if commits.length === 0}
          <div class="empty" role="status"><span class="empty-icon"><Icon name="history" size={22} /></span><strong>这一页没有提交。</strong></div>
        {:else}
          <div class="virtual-space" style={`height:${commits.length * ROW_HEIGHT}px`}>
            {#if graphOn}
              <!-- 父提交说明放在提交行之外，用 aria-describedby 关联：读屏名称仍以提交说明开头，
                   完整的父 Hash 和结果外原因仍可读到。 -->
              <div class="sr-only">
                {#each visible as commit, index (commit.oid)}
                  {@const described = graph.rows[range.start + index]}
                  {#if described}
                    <span id={`history-graph-${commit.oid}`}>{graphRowLabel(described)}{described.overflow ? ` 另有 ${described.hiddenLanes} 条分支线未画出。` : ""}</span>
                  {/if}
                {/each}
              </div>
            {/if}
            {#each visible as commit, index (commit.oid)}
              {@const pills = refPills(commit.labels)}
              {@const row = graphOn ? graph.rows[range.start + index] : null}
              {@const short = shortOid(commit.oid)}
              {@const hashHit = hashMatchLength(commit.oid, activeQuery, short.length)}
              <div
                id={"history-commit-" + commit.oid}
                class="history-row"
                role="option"
                aria-selected={selectedIds.has(commit.oid)}
                aria-describedby={row ? `history-graph-${commit.oid}` : undefined}
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
                {#if row}
                  <!-- 行内只留等宽占位，拓扑画在行外的绘图层里：行有圆角裁切，线画在行里会在行与行之间断开。 -->
                  <span class="hr-graph-slot" style={`width:${graphWidth}px`} aria-hidden="true"></span>
                {/if}
                <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
                <span class="hr-main">
                  <span class="hr-line">
                    <span class="hr-summary">{#each matchParts(commit.summary, activeQuery) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                    <code class="hr-hash">{#if hashHit > 0}<mark>{short.slice(0, hashHit)}</mark>{short.slice(hashHit)}{:else}{short}{/if}</code>
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
            {#if graphOn}
              <!-- 拓扑绘图层：每段与行槽（ROW_HEIGHT）等高、首尾相接，不受行的裁切和行距影响；
                   不接收指针，悬停、点击与右键仍落在下面的提交行上。 -->
              <div class="hr-graph-layer" aria-hidden="true">
                {#each visible as commit, index (commit.oid)}
                  {@const row = graph.rows[range.start + index]}
                  {#if row}
                    {@const drawn = clipSegments(row.segments, graphLanes)}
                    {@const nodeLane = visibleNodeLane(row, graphLanes)}
                    <span
                      class="hr-graph"
                      class:overflow={row.overflow}
                      data-graph-oid={commit.oid}
                      style={`--graph-width:${graphWidth}px;top:${(range.start + index) * ROW_HEIGHT}px;height:${GRAPH_HEIGHT}px`}
                    >
                      <svg
                        width={graphWidth}
                        height={GRAPH_HEIGHT}
                        viewBox={`0 0 ${graphWidth} ${GRAPH_HEIGHT}`}
                        aria-hidden="true"
                        focusable="false"
                      >
                        {#each drawn as segment, segmentIndex (segmentIndex)}
                          <path class="graph-line" class:outside={segment.kind === "outside"} style={laneStyle(segment.color)} d={segmentPath(segment, GRAPH_HEIGHT)} />
                        {/each}
                        {#if nodeLane !== null}
                          <circle
                            class="node"
                            class:head={row.head}
                            style={laneStyle(row.color)}
                            cx={laneX(nodeLane)}
                            cy={GRAPH_HEIGHT / 2}
                            r={row.head ? 4.5 : 3}
                          />
                        {/if}
                      </svg>
                      {#if row.overflow}
                        <span class="hr-graph-more" title={`还有 ${row.hiddenLanes} 条分支线未画出`}>+{row.hiddenLanes}</span>
                      {/if}
                    </span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <div class="pager history-pager">
        <span class="pager-range">
          {#if commits.length > 0}{commits.length}{page?.hasMore ? "+" : ""} {hasNarrowing ? "条匹配" : "条提交"}{/if}
        </span>
        <span class="spacer"></span>
        {#if commits.length > 0 && hasNarrowing}
          <button type="button" class="btn btn-ghost btn-sm" onclick={clearAllFilters} title="清除搜索词与作者、日期、路径，范围回到当前分支">
            <Icon name="x" size={12} />清除筛选
          </button>
        {/if}
        {#if commits.length > 0 && !atNewest}
          <button type="button" class="btn btn-ghost btn-sm" onclick={backToNewest} title="滚回最新一条提交">
            <Icon name="arrow-up" size={13} />回到最新
          </button>
        {/if}
      </div>
    </aside>
    {@render paneResizer?.()}
    <div class="history-detail">
      {#if taskRange && taskDetail}
        {@render taskDetail(taskShown)}
      {/if}
      {#if taskShown}
        <!-- 任务净差异占着详情区：提交详情与多选结果都不显示。 -->
      {:else}
      {#if detailError}
        <div class="infobar error" role="alert">
          <Icon name="alert-circle" size={15} />
          <span class="infobar-text">{detailError}</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick={retryDetail}>重新读取</button>
        </div>
      {/if}
      {#if selectedOids.length > 1}
        <header class="commit-head union-head">
          <div class="commit-head-main">
            <h2 class="commit-title">已选择 {selectedOids.length} 个提交 · 最终结果</h2>
            {#if multiRange && !multiRange.linear}
              <p class="hint union-hint warn" role="note">
                所选提交不连续：按「最早所选之前 → 最新所选」比较，中间没选中的提交也会计入最终结果。
              </p>
            {:else}
              <p class="hint union-hint">所选提交合在一起后的最终变化。</p>
            {/if}
          </div>
          <div class="commit-facts">
            {#if multiRange}
              <span class="oid-chip" title={`${multiRange.base ?? "空树"} → ${multiRange.head}`}>
                <Icon name="commit" size={12} />
                {multiRange.base ? shortOid(multiRange.base) : "空树"}..{shortOid(multiRange.head)}
              </span>
            {/if}
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
            <div class="commit-files-head">
              <span class="commit-files-title">最终变更</span>
              {#if !multiLoading}<span class="count">{unionFiles.length}</span>{/if}
              {#if unionLineTotals}
                <span class="spacer"></span>
                {@render lineTotal(unionLineTotals, "所选提交合起来")}
              {/if}
            </div>
            {#if multiLoading && unionFiles.length === 0}
              <div class="empty compact" role="status" aria-busy="true">
                <span class="empty-icon"><span class="spinner"></span></span>
                <strong>正在计算最终变更</strong>
              </div>
            {:else if unionFiles.length === 0 && multiError}
              <p class="commit-files-empty" role="alert">最终变更没有读取成功，无法确认文件范围：{multiError}</p>
              <button type="button" class="btn btn-secondary btn-sm commit-files-retry" onclick={() => (multiRetry += 1)}>重新读取</button>
            {:else if unionFiles.length === 0}
              <p class="commit-files-empty">这些提交合起来没有文件变化。</p>
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
                        {#if file.originalPath}
                          <span class="fd from" title={`重命名自 ${file.originalPath}`}>← {file.originalPath}</span>
                        {:else if parts.dir}
                          <span class="fd"><bdi>{parts.dir}</bdi></span>
                        {/if}
                      </span>
                      <LineCounts stat={commitLineStat(file)} hideBinary />
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </aside>
          {@render filesResizer()}
          <div class="commit-diff">
            {#if multiDiffError && !multiDiffLoading}
              <div class="empty compact" role="alert">
                <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
                <strong>这个文件的最终差异没有读取成功</strong>
                <p>{multiDiffError}</p>
                <button type="button" class="btn btn-secondary btn-sm" onclick={() => (multiDiffRetry += 1)}>重新读取差异</button>
              </div>
            {:else}
              <DiffView {onGeneration}
                selection={unionActive ? { path: unionActive.path, side: "unstaged" } : null}
                diff={multiDiff && multiDiff.path === unionActive?.path ? multiDiff : null}
                error={null}
                loading={multiDiffLoading || (multiLoading && unionFiles.length === 0)}
                {disabled}
                readOnly={true}
                readOnlyLabel="所选提交的最终结果"
                onStageHunk={() => {}}
                onLoadMore={loadMoreMultiDiff}
                onFileHistory={onFilePath}
                {fullFile}
                {onFullFile}
                {onReadDocument}
                fileNav={unionNav}
                fileCount={unionFiles.length}
                onRetry={() => (multiDiffRetry += 1)}
                {onHunkNav}
              />
            {/if}
          </div>
        </div>
      {:else if detail}
        {@const pills = detailPills}
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
              {#if pills.length > 1}
                <!-- 引用多时才给收起入口：收起后只留计数，窄窗口把这一行让给差异。 -->
                <button
                  type="button"
                  class="refs-toggle"
                  aria-expanded={!refsCollapsed}
                  aria-label={refsCollapsed ? `展开提交引用（${pills.length}）` : "收起提交引用"}
                  title={refsCollapsed ? `展开 ${pills.length} 个引用` : "收起引用，给差异腾出空间"}
                  onclick={() => {
                    refsCollapsed = !refsCollapsed;
                    refsUserSet = true;
                  }}
                >
                  <Icon name="chevron-down" size={11} class={refsCollapsed ? "" : "flip"} />
                  {refsCollapsed ? `引用 ${pills.length}` : "收起引用"}
                </button>
              {/if}
              <!-- 单引用提交不受收起状态影响：这里没有展开入口，藏起来就再也点不出来了。 -->
              {#if !refsCollapsed || pills.length <= 1}
                {#each pills as pill (`${pill.kind}:${pill.name}`)}
                  <span class={`ref-pill ${pill.kind}`} class:current={pill.current} title={pill.label} aria-label={pill.label}>
                    <Icon name={pill.kind === "tag" ? "tag" : pill.kind === "remote" ? "cloud" : "branch"} size={11} />
                    <span>{pill.name}</span>
                    {#if pill.remote}<Icon name="cloud" size={10} />{/if}
                  </span>
                {/each}
              {/if}
            </div>
            <CommitBranches {active} repo={opened.summary.path} oid={detail.commit.oid} generation={opened.generation} currentBranch={opened.snapshot.branch.name} {nextId} {onGeneration} />
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
                {@render lineTotal(lineTotals, "这次提交")}
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
                  <input
                    aria-label="筛选提交中的文件"
                    placeholder="筛选文件"
                    autocomplete="off"
                    spellcheck="false"
                    bind:value={fileFilter}
                    onkeydown={(event) => {
                      if (event.key === "Escape" && fileFilter) {
                        event.preventDefault();
                        event.stopPropagation();
                        fileFilter = "";
                      } else if ((event.key === "ArrowDown" || event.key === "Enter") && filteredFiles.length > 0) {
                        event.preventDefault();
                        if (!filteredFiles.some((f) => f.path === currentPath)) goToFile(filteredFiles[0].path);
                        fileListEl?.focus({ preventScroll: true });
                      }
                    }}
                  />
                  {#if fileFilter}
                    <button type="button" class="field-clear" aria-label="清除文件筛选" onclick={() => (fileFilter = "")}>
                      <Icon name="x" size={12} />
                    </button>
                  {/if}
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
                onkeydown={onDetailFilesKey}
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
                {fullFile}
                {onFullFile}
                {onReadDocument}
              />
            {:else}
              <DiffView {onGeneration}
                selection={diffSelection}
                diff={commitDiff}
                error={diffError}
                loading={diffLoading}
                {disabled}
                readOnly={true}
                onStageHunk={() => {}}
                onLoadMore={loadMoreDiff}
                onFileHistory={onFilePath}
                {fullFile}
                {onFullFile}
                {onReadDocument}
                asText={Boolean(detail && activeFile && commitAsText === `${detail.commit.oid}:${activeFile.path}`)}
                onViewAsText={(next) => {
                  commitAsText = next && detail && activeFile ? `${detail.commit.oid}:${activeFile.path}` : null;
                }}
                {fileNav}
                {onHunkNav}
              />
            {/if}
          </div>
        </div>
      {:else if detailLoading}
        <div class="empty" role="status" aria-busy="true"><span class="empty-icon"><span class="spinner"></span></span><strong>正在读取提交详情</strong></div>
      {:else if !loading && !detailError && commits.length > 0}
        <div class="empty" role="status">
          <span class="empty-icon"><Icon name="commit" size={24} /></span>
          <strong>未选择提交</strong>
          <p>选择左侧一条记录查看文件和差异；按住 Ctrl 或 Shift 多选，可看几个提交合起来的最终结果。</p>
        </div>
      {:else if !loading && !refreshing && !detailError}
        <!-- 列表是空的（没有匹配、读取失败或分支还没有提交）：原因与恢复入口已经在左侧，
             这里不重复播报，只说明这块区域是做什么的，避免留下一整块没有解释的空白。 -->
        <div class="empty" data-history-detail-empty>
          <span class="empty-icon"><Icon name="commit" size={24} /></span>
          <strong>没有可查看的提交</strong>
          <p>左侧列表里出现提交后，这里显示所选提交的文件和差异。</p>
        </div>
      {/if}
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

<RecoveryActions
  bind:this={recovery}
  {opened} {disabled} {nextId} {onFailure}
  variant="headless"
  onSnapshot={(snapshot) => { onGeneration(snapshot.generation); onSnapshot?.(snapshot); }}
  onNotice={(message) => onNotice?.(message)}
  onMerge={() => {}}
/>
<style>
  /* 拓扑只是一条紧凑的竖条：每行只画自己的竖线、节点和行内斜线，没有全尺寸历史 SVG。
     绘图段不放在行里：行有圆角与溢出裁切（不同 WebView 对 overflow-x: clip 的支持也不一致），
     线画在行里会在行与行之间断开。绘图层与行同处虚拟空间，每段占满 ROW_HEIGHT 的行槽，
     上一段的底边就是下一段的顶边；横向位置对齐行内的等宽占位（行左缩进 + 1px 边框 + 左内边距）。 */
  .hr-graph-slot { flex: none; display: block; height: 1px; }
  .hr-graph-layer { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
  .hr-graph {
    position: absolute;
    left: calc(var(--space-8) * 2 + 1px);
    display: block;
    width: var(--graph-width);
    pointer-events: none;
  }
  .hr-graph > svg { display: block; overflow: visible; }
  .hr-graph .graph-line { fill: none; stroke: var(--lane); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  /* 结果外父提交的短尾：虚线、降低不透明度，和真实连线区分开。 */
  .hr-graph .graph-line.outside { stroke-dasharray: 2 3; opacity: 0.55; }
  .hr-graph .node { fill: var(--surface); stroke: var(--lane); stroke-width: 2; }
  /* HEAD 用实心节点区分当前上下文，和选中底色、引用胶囊互不替代。 */
  .hr-graph .node.head { fill: var(--lane); }
  .hr-graph-more {
    position: absolute;
    right: 0;
    bottom: 3px;
    padding: 0 2px;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    color: var(--fg-muted);
    font-size: 10px;
    line-height: 12px;
  }
  .history-graph-toggle.active { color: var(--accent-text); }
  /* 引用收起入口与胶囊同高，收起后仍能看出有几个引用。 */
  .refs-toggle {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex: none;
    height: 18px;
    padding: 0 var(--space-6);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg-muted);
    font-size: var(--text-xs);
  }
  .refs-toggle:hover { border-color: var(--control-border-hover); background: var(--hover); color: var(--fg); }

  /* 左栏收到很窄时先让出拓扑宽度，把横向空间留给提交说明。 */
  @container history-list (max-width: 260px) {
    .hr-graph, .hr-graph-slot { display: none; }
  }
</style>
