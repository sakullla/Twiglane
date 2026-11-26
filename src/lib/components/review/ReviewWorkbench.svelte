<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import { api } from "../../api";
  import { FULL_FILE_CONTEXT, reuseDiffContent, type HunkNavReport } from "../../diff";
  import { normalizeError } from "../../errors";
  import { shortOid } from "../../history";
  import { branchLabel, parentDirectory } from "../../labels";
  import { LatestReadQueue } from "../../latest-read";
  import {
    anchorKey,
    anchorLabel,
    clearCommentDraft,
    commentDraft,
    setCommentDraft,
    type ReviewComment,
    type ReviewCommentAnchor,
    type StaleCommentBatch,
  } from "../../review-comments.svelte";
  import ConfirmDialog from "../ConfirmDialog.svelte";
  import InlineCommentEditor from "./InlineCommentEditor.svelte";
  import InlineCommentThread from "./InlineCommentThread.svelte";
  import ReviewCommentsDrawer from "./ReviewCommentsDrawer.svelte";
  import type {
    AppFailure,
    ChangeKind,
    DiffResponse,
    FileChange,
    FileRow,
    FileSelection,
    OpenedRepository,
    PreviewSources,
    TaskFileChange,
    TaskRequest,
    TaskReview,
    TaskSummary,
  } from "../../types";
  import {
    fileNavState,
    appendDiffPage,
    filterQueueRows,
    LAST_UNREVIEWED,
    nextUnreviewedAfter,
    orderedRows,
    QUEUE_FILTER_LABELS,
    reviewLayoutTier,
    reviewQueue,
    sameSelection,
    selectionKey,
    type FileNavState,
    type ReviewQueueState,
  } from "../../ui";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "../ContextMenu.svelte";
  import DiffView from "../DiffView.svelte";
  import FileList from "../FileList.svelte";
  import Icon from "../Icon.svelte";
  import LineCounts from "../LineCounts.svelte";
  import MultiFileDiff from "../MultiFileDiff.svelte";
  import PaneResizer from "../PaneResizer.svelte";
  import { clampWidth } from "../../layout";
  import {
    clearRevocations,
    REVOCATION_LABELS,
    saveWorkbenchExtras,
    saveWorkbenchState,
    workbenchExtras,
    workbenchState,
    type ReviewQueueFilter,
    type ReviewReadingMode,
  } from "../../review-workbench.svelte";
  import ReviewStatePanel, { type ReviewStateAction, type ReviewStateKind } from "./ReviewStatePanel.svelte";
  import ReviewQueueBar from "./ReviewQueueBar.svelte";

  /**
   * 审查队列交给外壳的控制面：命令面板与快捷键（标记并继续、筛选段）和按钮走同一份。
   * visible / total 区分「当前可见」与「任务真实总数」，进度只按 total 与 reviewed 计算。
   */
  export interface ReviewQueueControl {
    filter: ReviewQueueFilter;
    visible: number;
    total: number;
    reviewed: number;
    markNextReason: string | null;
    setFilter: (filter: ReviewQueueFilter) => void;
    markNext: () => void;
  }

  /** 外壳决定的整页状态（没有来源、来源失效、版本不兼容）：优先于任务读取状态显示。 */
  export interface ReviewWorkbenchBlock {
    kind: ReviewStateKind;
    title: string;
    message: string;
    detail?: string | null;
    actions?: ReviewStateAction[];
  }

  /**
   * 审查工作台：cliora 审查链接带来的起点到当前工作区的最终结果（任务净差异）。
   *
   * 它是顶级「审查」视图：左栏是来源卡与任务文件队列，主区是头部、差异与底部完成栏。
   * 四个视图同时保活，切走再回来时来源、选中文件与阅读模式都还在；跨来源切换时按
   * reviewId 保存/恢复界面状态（review-workbench）。
   *
   * 它只读：建立范围、浏览文件、看差异都走 task_review / load_task_diff，不切换分支、
   * 不写索引也不碰工作区。整文件暂存只写真实索引，按块/行暂存转到改动视图。
   *
   * 状态只有四种，而且互斥：
   * - no-baseline：没有任务范围（链接没带起点），不用 HEAD 或默认分支补缺；
   * - reading：正在读取，保留上一份结果但明确标出「读取中」；
   * - ready：完整读取成功，此时才可能出现「空任务」；
   * - failed：读取失败或任务范围失效，撤下结果并给出重新读取入口。
   */
  interface Props {
    opened: OpenedRepository;
    active?: boolean;
    /** 外壳选定的起点请求；没有起点时为 null，任务页停在选择状态。 */
    request: TaskRequest | null;
    nextId: () => number;
    fullFile: boolean;
    onFullFile: (next: boolean) => void;
    onGeneration: (generation: number) => void;
    onNotice?: (message: string) => void;
    onFailure?: (error: unknown) => void;
    onFileHistory?: (path: string) => void;
    /** 逐行追溯：切到文件视图打开这个工作区文件并显示 blame。 */
    onBlameFile?: (path: string) => void;
    onReadDocument?: (sources: PreviewSources, side: "old" | "new", trigger: HTMLElement | null) => void;
    onFileNav?: (nav: FileNavState | null) => void;
    onHunkNav?: (nav: HunkNavReport | null) => void;
    /** 任务范围的已审阅路径：与改动范围各自独立，互不作证。 */
    reviewed?: ReadonlySet<string>;
    reviewBusy?: string | null;
    reviewNote?: string | null;
    hideReviewed?: boolean;
    onToggleReview?: (path: string) => void;
    onHideReviewed?: (next: boolean) => void;
    /** 整文件暂存：写入真实索引，任务净差异本身不被应用。 */
    onStageFile?: (path: string) => void;
    /** 整文件取消暂存：同一路径只有已暂存一侧时按钮与空格走这里。 */
    onUnstageFile?: (path: string) => void;
    /** 多选整文件动作：由外壳一次持有写锁，避免逐文件操作互相抢占。 */
    onStageFiles?: (paths: string[]) => void;
    onUnstageFiles?: (paths: string[]) => void;
    /** 复制一个或多个仓库相对路径，成功与失败反馈由外壳统一处理。 */
    onCopyPaths?: (paths: string[]) => void;
    /**
     * 任务行在真实 Git 状态里的那一侧。任务净差异行本身只有一条结果，
     * 按钮/空格的方向、文案与禁用都必须按真实状态判断，不能一律说「暂存」。
     */
    stageSideFor?: (path: string) => "staged" | "unstaged" | "none";
    /** 写入或读取进行中：任务列表的整文件动作就地禁用并说明繁忙。 */
    writeLocked?: boolean;
    /** 转到同一文件的真实未提交差异：按块/按行暂存只能在那里发生。 */
    onOpenUnstaged?: (path: string) => void;
    /** 回到改动视图的提交区：提交只按真实暂存范围执行。 */
    onOpenChanges?: () => void;
    /**
     * 任务范围解析成功/撤下：外壳据此绑定快照 token 与进度记录。`generation` 是这次读取
     * 被校验过的仓库代次——范围形状不变、内容被改写时只有它前进。
     */
    onSnapshot?: (
      scope: { worktree: string; baselineOid: string; headOid: string; rangeVersion: string; generation: number } | null,
    ) => void;
    /** 当前任务文件：命令面板的标记/暂存动作作用在这里。 */
    onSelection?: (path: string | null) => void;
    /** 未审阅队列状态：与改动视图共用同一套命令与按钮。 */
    onReviewNav?: (nav: ReviewQueueState | null) => void;
    /** 历史顶部「任务净差异」行的摘要：读取状态、文件数与净行数。 */
    onSummary?: (summary: TaskSummary) => void;
    /** 是否显示在历史详情区：选中提交时隐藏但保活，读取与选择都不丢。 */
    visible?: boolean;
    /**
     * 编辑这个任务文件在当前工作区里的版本：净差异本身仍只读，编辑在文件视图里发生，
     * 保存后任务按新的代次重读。删除与冲突文件没有这个入口。
     */
    onEditFile?: (path: string, line: number | null) => void;
    /** 当前任务范围的已存意见：外壳拥有这份状态，任务页只展示、编辑与预览。 */
    comments?: readonly ReviewComment[];
    /** 已挂意见的行身份，交给差异行上的气泡按钮标出。 */
    commentKeys?: ReadonlySet<string>;
    /** 上一条说明（意见已失效或这批已经准备好）：由外壳决定，这里只如实展示。 */
    commentNotice?: string | null;
    /** 当前意见范围的身份键：范围前进（提交、合入、内容改写）后，上一次意见动作的就地反馈随之收起。 */
    commentScopeKey?: string | null;
    onAddComment?: (anchor: ReviewCommentAnchor, body: string) => void;
    onEditComment?: (id: string, body: string) => void;
    onDeleteComment?: (id: string) => void;
    /** 当前来源最近失效的意见批次：抽屉里只读展示，只能复制。 */
    staleComments?: readonly StaleCommentBatch[];
    /** 复制文字（失效意见）：成功与失败的反馈由外壳统一处理。 */
    onCopyText?: (text: string, label: string) => void;
    /** 当前来源的 reviewId：界面状态按它保存与恢复；没有来源时为 null。 */
    workbenchId?: string | null;
    /** 左栏最上方的视图切换（与其他视图共用同一个 paneHead）。 */
    paneHead?: Snippet;
    /** 左栏顶部的来源卡（由外壳渲染，含来源菜单与关闭确认）。 */
    sourceCard?: Snippet;
    /** 主区底部常驻完成栏（送回意见 / 返回 Cliora）。 */
    completion?: Snippet;
    /** 外壳决定的整页状态：没有来源、来源失效、版本不兼容。 */
    block?: ReviewWorkbenchBlock | null;
    /** 无起点状态的两个动作：查看普通历史、返回 Cliora。 */
    onShowHistory?: () => void;
    onReturnToCliora?: () => void;
    /** 「范围内提交 N」：转到历史并按任务范围过滤。 */
    onShowCommits?: () => void;
    /**
     * 「标记并继续」的标记步骤：确认快照并标记，返回是否已标记成功。失败时停在当前文件，
     * 原因由外壳在队列里就地说明。
     */
    onMarkReviewed?: (path: string) => Promise<boolean>;
    /** 审查队列控制面（筛选、标记并继续、可见/总计）：交给外壳的命令与快捷键。 */
    onQueue?: (queue: ReviewQueueControl | null) => void;
  }

  let {
    opened,
    active = true,
    request,
    nextId,
    fullFile,
    onFullFile,
    onGeneration,
    onNotice,
    onFailure,
    onFileHistory,
    onBlameFile,
    onReadDocument,
    onFileNav,
    onHunkNav,
    reviewed = new Set<string>(),
    reviewBusy = null,
    reviewNote = null,
    hideReviewed = false,
    onToggleReview,
    onHideReviewed,
    onStageFile,
    onUnstageFile,
    onStageFiles,
    onUnstageFiles,
    onCopyPaths,
    stageSideFor,
    writeLocked = false,
    onOpenUnstaged,
    onOpenChanges,
    onSnapshot,
    onSelection,
    onReviewNav,
    onSummary,
    visible = true,
    onEditFile,
    comments = [],
    commentKeys = new Set<string>(),
    commentNotice = null,
    commentScopeKey = null,
    onAddComment,
    onEditComment,
    onDeleteComment,
    staleComments = [],
    onCopyText,
    workbenchId = null,
    paneHead,
    sourceCard,
    completion,
    block = null,
    onShowHistory,
    onReturnToCliora,
    onShowCommits,
    onMarkReviewed,
    onQueue,
  }: Props = $props();

  /** 这些错误说明「任务范围不再成立」，要撤下结果而不是把它当成一次普通读取失败。 */
  const RANGE_INVALID = new Set([
    "task_baseline_missing",
    "task_baseline_not_ancestor",
    "task_worktree_missing",
    "task_head_unborn",
    "task_head_changed",
    "task_version_unconfirmed",
    "not_repository",
  ]);

  type Phase = "no-baseline" | "reading" | "ready" | "failed";

  /* 左侧任务文件栏可以拖动调宽（与提交文件栏同一套分隔条）；宽度是本机偏好，存在 localStorage。 */
  const TASK_FILES_WIDTH_KEY = "twiglane.taskFilesWidth";
  const DEFAULT_TASK_FILES_WIDTH = 360;
  /** 工具行里有搜索、审阅进度与导航，再窄就挤不下。 */
  const MIN_TASK_FILES_WIDTH = 220;
  const MIN_TASK_DIFF_WIDTH = 360;

  function readTaskFilesWidth(): number {
    try {
      const stored = Number(globalThis.localStorage?.getItem(TASK_FILES_WIDTH_KEY));
      return stored > 0 ? clampWidth(stored) : DEFAULT_TASK_FILES_WIDTH;
    } catch {
      return DEFAULT_TASK_FILES_WIDTH;
    }
  }

  function saveTaskFilesWidth(): void {
    try {
      globalThis.localStorage?.setItem(TASK_FILES_WIDTH_KEY, String(taskFilesWidth));
    } catch {
      // 本机偏好写不进去时只影响下次打开的初始宽度。
    }
  }

  /** 渲染宽度：容器窄时收紧，给差异区留足宽度，不改写已保存的宽度。 */
  function fitTaskFilesWidth(width: number, total: number): number {
    const wanted = Math.max(MIN_TASK_FILES_WIDTH, width);
    if (total <= 0) return wanted;
    return Math.max(MIN_TASK_FILES_WIDTH, Math.min(wanted, total - MIN_TASK_DIFF_WIDTH));
  }

  /** 工作台自身宽度：栏宽收紧与响应式三档都读它（每个工作台一个观察者，重排时更新）。 */
  function measureWidth(node: HTMLElement) {
    const read = () => {
      taskSplitWidth = node.clientWidth;
    };
    read();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(node);
    return { destroy: () => observer?.disconnect() };
  }

  let taskFilesWidth = $state(readTaskFilesWidth());
  let taskSplitWidth = $state(0);
  let taskFilesShown = $derived(fitTaskFilesWidth(taskFilesWidth, taskSplitWidth));

  let task = $state.raw<TaskReview | null>(null);
  let phase = $state<Phase>("no-baseline");
  let failure = $state<AppFailure | null>(null);
  /** 任务范围失效（而不是一次可重试的读取失败）：重选起点是首要恢复动作。 */
  let invalidRange = $state(false);
  let query = $state("");
  let selected = $state<FileSelection | null>(null);
  let selectedSet = $state.raw<FileSelection[]>([]);
  let diff = $state.raw<DiffResponse | null>(null);
  let diffError = $state<string | null>(null);
  let diffLoading = $state(false);
  let diffToken = 0;
  let readSerial = 0;
  let reading = $state(false);
  let asTextFor = $state<string | null>(null);
  const taskReads = new LatestReadQueue();
  const diffReads = new LatestReadQueue();
  let moreLoading = false;
  let detailActive = $derived(active && visible);

  onDestroy(() => {
    readSerial += 1;
    diffToken += 1;
    taskReads.close();
    diffReads.close();
  });

  function toKind(file: TaskFileChange): ChangeKind {
    switch (file.status) {
      case "added":
        return "added";
      case "deleted":
        return "deleted";
      case "renamed":
        return "renamed";
      case "copied":
        return "copied";
      case "typeChanged":
        return "typeChanged";
      case "unmerged":
        return "unmerged";
      default:
        return "modified";
    }
  }

  /** 任务净结果映射成同一套 FileChange 行模型：列表、导航与差异都复用现有组件。 */
  function toChange(file: TaskFileChange): FileChange {
    return {
      path: file.path,
      originalPath: file.originalPath,
      staged: "none",
      unstaged: toKind(file),
      untracked: file.untracked ?? false,
      unmerged: file.unmerged ?? false,
      rebuilt: file.rebuilt ?? false,
      // 任务只有一条最终结果：行数挂在未暂存一侧，列表才画得出 +/−。
      unstagedLines: {
        additions: file.additions ?? null,
        deletions: file.deletions ?? null,
        oldSize: file.oldSize ?? null,
        newSize: file.newSize ?? null,
      },
    };
  }

  /*
   * 工作台界面状态按来源保存：选中文件、阅读模式、搜索与意见列表开合。切换来源时先保存
   * 上一个来源，再恢复新来源；同一来源内切视图不卸载组件，状态自然保留。
   */
  let readingMode = $state<ReviewReadingMode>("single");
  let restorePath: string | null = null;
  let boundId: string | null = null;
  $effect(() => {
    const id = workbenchId;
    untrack(() => {
      if (id === boundId) return;
      if (boundId) persist(boundId);
      const switched = boundId !== null;
      boundId = id;
      // 换来源时不沿用上一个来源的选中项：新来源只恢复它自己的记录，没有记录时从队列第一个文件开始。
      if (switched) {
        selected = null;
        selectedSet = [];
      }
      const saved = id ? workbenchState(id) : null;
      readingMode = saved?.readingMode ?? "single";
      query = saved?.query ?? "";
      filter = saved?.filter ?? "all";
      queueCollapsed = id ? workbenchExtras(id).queueCollapsed : false;
      queueNote = null;
      commentsOpen = saved?.drawerOpen ?? false;
      restorePath = saved?.selectedPath ?? null;
      // 意见草稿按来源保存在草稿槽里：切换来源不丢，切回来时恢复（编辑中的意见回到它的线程里）。
      const draft = id ? commentDraft(id) : null;
      draftAnchor = draft?.anchor ?? null;
      draftBody = draft?.anchor ? draft.body : "";
      draftEditingId = draft?.anchor ? draft.editingId : null;
      threadAnchor = draft?.anchor && draft.editingId ? draft.anchor : null;
      commentError = null;
      commentFeedback = null;
      replacing = null;
    });
  });

  // 正在写的意见草稿写回当前来源的草稿槽：关闭来源与完成栏据此提示「草稿未保存」。
  // 编辑已有意见时只有改过才算草稿：打开编辑本身不会在关闭、返回时触发确认。
  $effect(() => {
    const anchor = draftAnchor;
    const body = draftBody;
    const editing = draftEditingId;
    const dirty = draftDirty;
    untrack(() => {
      const id = boundId;
      if (!id || workbenchId !== id) return;
      if (anchor && (!editing || dirty)) setCommentDraft(id, { anchor, body, editingId: editing });
      else clearCommentDraft(id);
    });
  });

  function persist(id: string | null = boundId): void {
    if (!id) return;
    saveWorkbenchState(id, {
      selectedPath: selected?.path ?? null,
      selectedSet: selectedSet.map((item) => item.path),
      readingMode,
      query,
      filter,
      drawerOpen: commentsOpen,
      scrollAnchor: selected ? { path: selected.path, offset: 0 } : null,
    });
    saveWorkbenchExtras(id, { queueCollapsed });
  }

  // 选择、模式、搜索或意见列表变化时写回当前来源（只存界面状态，不存进度与意见）。
  $effect(() => {
    void selected;
    void selectedSet;
    void readingMode;
    void query;
    void filter;
    void queueCollapsed;
    void commentsOpen;
    untrack(() => {
      if (boundId && workbenchId === boundId && task) persist(boundId);
    });
  });

  /**
   * 任务文件按「目录 → 文件名」排序：平铺与按目录分组两种排列的先后完全一致，
   * 键盘上下、「上一个/下一个」、标记并继续与连续阅读都按眼前看到的顺序走，不会跳来跳去。
   */
  function compareTaskFiles(left: TaskFileChange, right: TaskFileChange): number {
    const a = parentDirectory(left.path);
    const b = parentDirectory(right.path);
    return a === b ? left.path.localeCompare(right.path) : a.localeCompare(b);
  }
  let files = $derived([...(task?.files ?? [])].sort(compareTaskFiles).map(toChange));
  /** 队列筛选段：全部 / 未审阅 / 有意见。只决定哪些文件可见，不写进度与意见。 */
  let filter = $state<ReviewQueueFilter>("all");
  let queueCollapsed = $state(false);
  /** 「标记并继续」的就地说明（如到达末尾）：换文件或换筛选时收起。 */
  let queueNote = $state<string | null>(null);
  let commentedPaths = $derived(new Set(comments.map((comment) => comment.anchor.path)));
  /** 全部任务行：按路径找行（改名的原路径、编辑入口）不受搜索与筛选影响。 */
  let allRows = $derived(orderedRows(files));
  /*
   * 内容搜索：搜索框切到「内容」后，按任务文件的当前内容查找关键词（只读，不改 Git）。
   * 每个文件单独查（范围精确，不会因整仓结果上限漏掉任务文件），并发有上限；
   * 关键词、任务范围或仓库代次变化时旧结果作废。命中文件里打开差异时自动带入差异内查找。
   */
  let contentMode = $state(false);
  let contentHits = $state.raw<Map<string, number> | null>(null);
  let contentBusy = $state(false);
  let contentNote = $state<string | null>(null);
  let contentSerial = 0;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  let contentKey = "";
  const CONTENT_CONCURRENCY = 6;
  const CONTENT_LIMIT = 500;

  $effect(() => {
    const needle = contentMode ? query.trim() : "";
    const current = task;
    const key = `${needle}\0${scopeKey}\0${opened.generation}`;
    untrack(() => {
      if (key === contentKey) return;
      contentKey = key;
      if (contentTimer) clearTimeout(contentTimer);
      contentTimer = null;
      contentSerial += 1;
      if (!needle || !current) {
        contentHits = null;
        contentBusy = false;
        contentNote = null;
        return;
      }
      const serial = contentSerial;
      contentBusy = true;
      contentTimer = setTimeout(() => void runContentSearch(needle, current, serial), 250);
    });
  });

  onDestroy(() => {
    contentSerial += 1;
    if (contentTimer) clearTimeout(contentTimer);
  });

  async function runContentSearch(needle: string, current: TaskReview, serial: number): Promise<void> {
    const targets = current.files.filter((file) => file.status !== "deleted").map((file) => file.path);
    const hits = new Map<string, number>();
    let failed = 0;
    let truncated = false;
    let cursor = 0;
    const repo = opened.summary.path;
    const generation = opened.generation;
    const worker = async () => {
      while (cursor < targets.length && serial === contentSerial) {
        const path = targets[cursor];
        cursor += 1;
        try {
          const result = await api.repositoryContentSearch(repo, needle, { kind: "file", path }, true, CONTENT_LIMIT, generation, nextId());
          if (result.matches.length > 0) hits.set(path, result.matches.length);
          if (result.truncated) truncated = true;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONTENT_CONCURRENCY, targets.length) }, () => worker()));
    if (serial !== contentSerial) return;
    contentHits = hits;
    contentBusy = false;
    const parts = [`${hits.size} / ${targets.length} 个文件的当前内容包含“${needle}”`];
    if (current.files.length > targets.length) parts.push(`已删除的 ${current.files.length - targets.length} 个文件不参与`);
    if (failed > 0) parts.push(`${failed} 个文件读取失败`);
    if (truncated) parts.push("部分文件命中过多，只计到上限");
    contentNote = parts.join("；") + "。";
  }

  function setContentMode(next: boolean): void {
    contentMode = next;
    queueNote = null;
    document.getElementById("task-file-search")?.focus();
  }

  /** 内容搜索生效中（有关键词且已有结果）：队列只保留命中的文件。 */
  let contentFilter = $derived(contentMode && query.trim() !== "" && contentHits ? contentHits : null);

  /** 当前可见队列：搜索、筛选段与「隐藏已审阅」之后的有序行。连续阅读与未审阅跳转都作用于它。 */
  let queueRows = $derived.by(() => {
    const base = orderedRows(files, contentMode ? "" : query);
    const scoped = contentFilter ? base.filter((row) => contentFilter!.has(row.path)) : base;
    return filterQueueRows(scoped, filter, reviewed, commentedPaths);
  });
  let rows = $derived(hideReviewed ? queueRows.filter((row) => !reviewed.has(row.path)) : queueRows);
  let rowsByPath = $derived(new Map(allRows.map((row) => [row.path, row])));
  let filterPaths = $derived(filter === "all" && !contentFilter ? null : new Set(queueRows.map((row) => row.path)));
  // 内容搜索出结果后，当前文件不在命中里就定位到第一个命中文件：右侧不再停在一个已被筛掉的文件上。
  $effect(() => {
    const hits = contentFilter;
    untrack(() => {
      if (!hits || multiActive) return;
      const first = rows[0];
      if (first && (!selected || !hits.has(selected.path))) goToRow(first);
    });
  });
  /** 内容搜索命中某文件时，打开它的差异就带入同一个关键词（每个文件 + 关键词只带一次）。 */
  let findRequest = $derived(
    contentFilter && selected && contentFilter.has(selected.path)
      ? { query: query.trim(), nonce: `${selected.path}\0${query.trim()}` }
      : null,
  );
  let queueEmpty = $derived.by(() => {
    if (contentFilter) {
      return {
        message: filter !== "all" ? `「${QUEUE_FILTER_LABELS[filter]}」里没有文件包含“${query.trim()}”` : `没有任务文件的内容包含“${query.trim()}”`,
        onClear: clearFilters,
      };
    }
    return filter !== "all" ? { message: `「${QUEUE_FILTER_LABELS[filter]}」筛选下没有文件`, onClear: clearFilters } : null;
  });
  /** 失效撤销的原因：只对仍未重新标记的文件显示。 */
  let revoked = $derived(workbenchId ? workbenchExtras(workbenchId).revoked : {});
  let revokedNotes = $derived(
    new Map(
      Object.entries(revoked)
        .filter(([path]) => !reviewed.has(path) && rowsByPath.has(path))
        .map(([path, item]) => [path, { label: `已撤销 · ${REVOCATION_LABELS[item.kind]}`, reason: item.reason }]),
    ),
  );
  // 重新标记后原因就过时了：清掉，之后再撤销时不会把旧原因翻出来。
  $effect(() => {
    const id = workbenchId;
    const stale = Object.keys(revoked).filter((path) => reviewed.has(path));
    if (id && stale.length > 0) untrack(() => clearRevocations(id, stale));
  });
  let multiActive = $derived(selectedSet.length > 1);
  /** 连续阅读：没有多选时作用于当前可见队列的全部文件。 */
  let continuous = $derived(readingMode === "continuous" && !multiActive);
  let selectedKeys = $derived(new Set(selectedSet.map(selectionKey)));
  let selectedRows = $derived(
    selectedSet.length > 1
      ? rows.filter((row) => selectedKeys.has(selectionKey(row)))
      : selected ? rows.filter((row) => sameSelection(row, selected)) : [],
  );
  let baselineLabel = $derived(task ? shortOid(task.baselineOid) : request ? shortOid(request.baseline) : "");
  let headLabel = $derived(task ? shortOid(task.headOid) : "");
  let scopeKey = $derived(
    task ? `${task.worktree}|${task.baselineOid}|${task.headOid}|${task.rangeVersion}` : "",
  );

  /** 任务范围的进度：文件数来自任务本身，隐藏已审阅不改变它。 */
  let reviewTotal = $derived(files.length);
  let reviewReviewed = $derived(files.filter((file) => reviewed.has(file.path)).length);
  let reviewNav: ReviewQueueState | null = $derived(
    files.length > 0 ? reviewQueue(queueRows, reviewed, selected, goToRow) : null,
  );
  let marking = $state(false);
  let markNextReason = $derived(
    !task || task.empty
      ? "任务范围还没有可审阅的文件"
      : !selected
        ? "先选择一个文件"
        : marking || reviewBusy === selected.path
          ? "正在确认这个文件的快照"
          : !reviewed.has(selected.path) && !onMarkReviewed
            ? "当前不可标记"
            : null,
  );

  function setFilter(next: ReviewQueueFilter): void {
    if (filter === next) return;
    filter = next;
    queueNote = null;
  }

  /** 清除筛选：回到完整队列（全部、无搜索、不隐藏已审阅）；进度与审阅记录不变。 */
  function clearFilters(): void {
    filter = "all";
    query = "";
    queueNote = null;
    if (hideReviewed) onHideReviewed?.(false);
  }

  /**
   * 标记并继续：标记当前文件，再去「当前可见队列」里排在它之后的下一个未审阅文件。
   * 下一站在标记前按可见顺序确定（「未审阅」筛选下当前文件标记后会离开队列）；到末尾就地说明
   * 「已是最后一个未审阅文件」并停留，不回到开头。标记失败或期间换了文件时不跳走。
   */
  async function markAndContinue(): Promise<void> {
    const current = selected;
    if (!current || markNextReason !== null) return;
    const order = rows;
    queueNote = null;
    if (!reviewed.has(current.path)) {
      marking = true;
      let ok = false;
      try {
        ok = (await onMarkReviewed?.(current.path)) ?? false;
      } finally {
        marking = false;
      }
      if (!ok || selected?.path !== current.path) return;
    }
    const next = nextUnreviewedAfter(order, current.path, reviewed);
    if (next && rowOf(next.path)) goToRow(next);
    else queueNote = LAST_UNREVIEWED;
  }

  $effect(() => {
    const visible = rows.length;
    const control: ReviewQueueControl | null = task && !task.empty
      ? {
          filter,
          visible,
          total: reviewTotal,
          reviewed: reviewReviewed,
          markNextReason,
          setFilter,
          markNext: () => void markAndContinue(),
        }
      : null;
    onQueue?.(control);
  });

  onDestroy(() => onQueue?.(null));

  // 换文件后「已是最后一个」不再描述当前位置：收起。
  let notedPath: string | null = null;
  $effect(() => {
    const path = selected?.path ?? null;
    untrack(() => {
      if (path !== notedPath) {
        notedPath = path;
        queueNote = null;
      }
    });
  });

  /* 响应式三档：宽度由工作台自身测量；窄档里文件队列收成可切换的抽屉，主区用满宽度。 */
  let tier = $derived(reviewLayoutTier(taskSplitWidth));
  let narrowQueueOpen = $state(false);
  let queueHidden = $derived(tier === "narrow" ? !narrowQueueOpen : queueCollapsed);

  function toggleQueue(): void {
    if (tier === "narrow") narrowQueueOpen = !narrowQueueOpen;
    else queueCollapsed = !queueCollapsed;
  }
  /** 选中的这条路径是不是「工作区重建」：行数与单文件差异都按重建后的内容给。 */
  let selectedRebuilt = $derived(
    selected ? (rowsByPath.get(selected.path)?.rebuilt ?? false) : false,
  );
  /** 净结果里这条路径仍在工作区（不是删除、也不是未解决冲突）：只有这时才给编辑入口。 */
  let selectedEditable = $derived.by(() => {
    const row = selected ? rowsByPath.get(selected.path) : null;
    return Boolean(row && row.unstaged !== "deleted" && !row.unmerged);
  });

  /** 多文件差异作用的行：多选时是选中文件，连续阅读时是当前可见队列。 */
  let stackRows = $derived(multiActive ? selectedRows : rows);
  let nav: FileNavState = $derived.by(() => {
    const items: FileRow[] = multiActive ? selectedRows : rows;
    const index = items.findIndex((row) => sameSelection(row, selected));
    return fileNavState(items, index, goToRow, multiActive ? "选中文件" : "任务文件");
  });

  $effect(() => {
    onFileNav?.(nav);
  });

  $effect(() => {
    onReviewNav?.(reviewNav);
  });

  $effect(() => {
    onSelection?.(selected?.path ?? null);
  });

  /** 历史顶部那一行只需要一句话的摘要：状态、文件数与净行数，进度由外壳按审阅记录补上。 */
  $effect(() => {
    const current = task;
    onSummary?.({
      state: phase === "failed" ? "failed" : current ? (current.empty ? "empty" : "ready") : request ? "reading" : "none",
      reading,
      files: current?.filesTotal ?? 0,
      additions: current?.additions ?? 0,
      deletions: current?.deletions ?? 0,
      commits: current?.commitCount ?? 0,
      dirty: current?.dirty ?? false,
      baseline: current ? shortOid(current.baselineOid) : request ? shortOid(request.baseline) : "",
    });
  });

  function rowOf(path: string): FileRow | null {
    return rowsByPath.get(path) ?? null;
  }

  function goToRow(row: FileRow): void {
    const item: FileSelection = { path: row.path, side: row.side };
    if (multiActive || continuous) selected = item;
    else select(item);
  }

  /** 把无效路径变成 null：任务刷新后按路径收敛选中，消失的文件不会留在界面上。 */
  function keep(item: FileSelection | null): FileSelection | null {
    if (!item) return null;
    return rowOf(item.path) ? { path: item.path, side: "unstaged" } : null;
  }

  function select(item: FileSelection): void {
    selected = item;
    selectedSet = [];
    // 窄档里文件队列是抽屉：选好文件就让出位置给差异。
    if (tier === "narrow") narrowQueueOpen = false;
    asTextFor = null;
    void loadSelectedDiff();
  }

  function selectMany(set: FileSelection[], focus: FileSelection): void {
    if (set.length < 2) {
      select(set[0] ?? focus);
      return;
    }
    selected = focus;
    selectedSet = set;
    asTextFor = null;
    void loadSelectedDiff();
  }

  function focusBlock(item: FileSelection): void {
    selected = item;
  }

  /*
   * 原位意见：只在这里保存「哪一行、写了什么」。意见不改 Git、不写索引，也不触发 Agent；
   * 只有用户在完成栏点「送回」时外壳才会写交接文件。范围变化后外壳整体失效这批意见，
   * 这里不做任何行号重映射。
   *
   * 差异里同一时刻只展开一处意见行：锚点线程（点已有意见的标记）优先，其次是新意见草稿。
   * 草稿（新增或编辑）只有一份，存在当前来源的草稿槽里：切换文件、视图与来源都不丢。
   * 会把一份写了内容的草稿换掉的动作（在另一行新开草稿、编辑另一条）先确认。
   */
  let commentsOpen = $state(false);
  let draftAnchor = $state<ReviewCommentAnchor | null>(null);
  let draftBody = $state("");
  /** 正在编辑的已有意见；为 null 时草稿是一条新意见。 */
  let draftEditingId = $state<string | null>(null);
  let commentError = $state<string | null>(null);
  /** 展开中的锚点线程。 */
  let threadAnchor = $state<ReviewCommentAnchor | null>(null);
  /** 上一次意见动作的结果（添加、保存、删除、取消）：就地给读屏与视觉一个反馈。 */
  let commentFeedback = $state<string | null>(null);
  // 意见动作反馈只属于它发生时的那批意见：范围前进后那批已失效，「已添加意见」不能继续常驻。
  let feedbackScopeKey: string | null = null;
  $effect(() => {
    const key = commentScopeKey;
    untrack(() => {
      if (key === feedbackScopeKey) return;
      feedbackScopeKey = key;
      commentFeedback = null;
    });
  });
  /** 「在抽屉中定位」的目标卡片。 */
  let drawerFocus = $state<string | null>(null);
  /** 等待确认的「换掉草稿」动作。 */
  let replacing = $state<{ message: string; run: () => void } | null>(null);
  /** 差异是否已把意见行放到锚点处：false 表示读到了差异却找不到锚点行（没读到或被筛选隐藏）。 */
  let inlinePlaced = $state<boolean | null>(null);
  /** 锚点行不在差异里时，在提示条下就地展开的草稿编辑器。 */
  let detachedOpen = $state(false);

  let commenting = $derived(Boolean(onAddComment || onEditComment || onDeleteComment));
  let editingOriginal = $derived(draftEditingId ? (comments.find((comment) => comment.id === draftEditingId)?.body ?? null) : null);
  /**
   * 草稿里有会丢的内容：新意见写了正文，或编辑改过原文。编辑的那条暂时不在当前批次里
   * （切回来源时还没读完，或已经失效）时按「有内容」处理，绝不静默丢掉。
   */
  let draftDirty = $derived(
    draftAnchor !== null &&
      (draftEditingId ? editingOriginal === null || draftBody !== editingOriginal : draftBody.trim() !== ""),
  );
  /** 编辑中的意见已不在当前批次：给出放弃入口，正文仍可在抽屉的失效分区复制。 */
  let editOrphan = $derived(draftEditingId !== null && editingOriginal === null && Boolean(task) && !reading);
  let threadComments = $derived(
    threadAnchor ? comments.filter((comment) => anchorKey(comment.anchor) === anchorKey(threadAnchor!)) : [],
  );
  /** 差异里展开意见行的锚点：线程优先，其次是新意见草稿。 */
  let inlineAnchor = $derived(threadAnchor ?? (draftAnchor && !draftEditingId ? draftAnchor : null));
  let inlineTarget = $derived(
    inlineAnchor
      ? {
          path: inlineAnchor.path,
          hunkIndex: inlineAnchor.hunkIndex,
          kind: inlineAnchor.kind,
          oldNo: inlineAnchor.oldNo,
          newNo: inlineAnchor.newNo,
          block: Boolean(inlineAnchor.range),
        }
      : null,
  );

  // 线程里的意见全被删掉（或整批失效）时收起线程；正在编辑时不收，等当前批次读到再说。
  $effect(() => {
    const empty = threadAnchor !== null && threadComments.length === 0 && draftEditingId === null;
    untrack(() => {
      if (empty) threadAnchor = null;
    });
  });

  function resetDraft(): void {
    draftAnchor = null;
    draftBody = "";
    draftEditingId = null;
    commentError = null;
    detachedOpen = false;
  }

  /** 会换掉写了内容的草稿时先确认；取消则草稿原样保留。 */
  function guardDraft(run: () => void): void {
    if (!draftDirty) {
      run();
      return;
    }
    const where = draftAnchor ? `${draftAnchor.path}（${anchorLabel(draftAnchor)}）` : "另一处";
    replacing = {
      message: draftEditingId
        ? `${where}的意见改了一半还没保存。继续会放弃这次修改，原意见不变。`
        : `${where}有一条写了一半的意见草稿。继续会丢掉这条草稿。`,
      run,
    };
  }

  /** 差异里点行或块的意见标记：已有意见就打开线程，没有才开新草稿。 */
  function beginComment(anchor: ReviewCommentAnchor): void {
    const key = anchorKey(anchor);
    if (comments.some((comment) => anchorKey(comment.anchor) === key)) {
      openThread(anchor);
      return;
    }
    startDraft(anchor);
  }

  function openThread(anchor: ReviewCommentAnchor): void {
    commentError = null;
    if (draftEditingId) {
      // 另一条意见正在编辑：改过就先确认，没改过直接收起。
      guardDraft(() => {
        resetDraft();
        threadAnchor = anchor;
      });
      return;
    }
    // 新意见草稿留在草稿槽里：线程只是暂时盖住它，不会丢。
    threadAnchor = anchor;
  }

  /** 收起线程：正在编辑且改过时先确认；新意见草稿不受影响，会重新显示出来。 */
  function closeThread(): void {
    if (!draftEditingId) {
      threadAnchor = null;
      return;
    }
    guardDraft(() => {
      resetDraft();
      threadAnchor = null;
    });
  }

  function startDraft(anchor: ReviewCommentAnchor): void {
    const same =
      draftAnchor !== null &&
      !draftEditingId &&
      anchorKey(draftAnchor) === anchorKey(anchor) &&
      Boolean(draftAnchor.range) === Boolean(anchor.range);
    if (same) {
      // 同一处的草稿还在：直接回到它，正文不动。
      threadAnchor = null;
      return;
    }
    guardDraft(() => {
      draftAnchor = anchor;
      draftBody = "";
      draftEditingId = null;
      threadAnchor = null;
      commentError = null;
      detachedOpen = false;
    });
  }

  function placeOf(anchor: ReviewCommentAnchor): string {
    return `${anchor.path}（${anchorLabel(anchor)}）`;
  }

  /** 保存草稿：新增走 onAddComment，编辑走 onEditComment。上限与空正文由意见状态层统一校验，
   *  失败消息就地显示在编辑器里，正文不清空。 */
  function saveDraft(): void {
    const anchor = draftAnchor;
    if (!anchor) return;
    const editing = draftEditingId;
    try {
      if (editing) {
        if (!onEditComment) return;
        onEditComment(editing, draftBody);
      } else {
        if (!onAddComment) return;
        onAddComment(anchor, draftBody);
      }
    } catch (error) {
      commentError = error instanceof Error ? error.message : "这条意见没有保存。";
      return;
    }
    commentFeedback = editing ? `已保存对 ${placeOf(anchor)} 意见的修改。` : `已添加意见：${placeOf(anchor)}。只存在本窗口，没有发送。`;
    resetDraft();
  }

  function cancelDraft(): void {
    const anchor = draftAnchor;
    const editing = draftEditingId;
    const had = draftDirty;
    resetDraft();
    if (anchor) commentFeedback = editing ? "已取消编辑，原意见保持不变。" : had ? "已放弃这条意见草稿。" : "已取消。";
  }

  function beginEdit(comment: ReviewComment): void {
    if (draftEditingId === comment.id) return;
    guardDraft(() => {
      draftAnchor = comment.anchor;
      draftBody = comment.body;
      draftEditingId = comment.id;
      threadAnchor = comment.anchor;
      commentError = null;
    });
  }

  /**
   * 抽屉卡片上的「编辑」：同样走唯一的草稿槽（不打开差异里的线程），
   * 关闭来源、切换来源、返回与送回前的草稿确认因此都能看到这次修改。
   */
  function beginDrawerEdit(comment: ReviewComment): void {
    if (draftEditingId === comment.id && threadAnchor === null) return;
    guardDraft(() => {
      draftAnchor = comment.anchor;
      draftBody = comment.body;
      draftEditingId = comment.id;
      threadAnchor = null;
      commentError = null;
    });
  }

  /** 抽屉里的编辑：编辑中的意见在草稿槽里，且没有对应的线程（不在差异里显示）。 */
  let drawerEditing = $derived(draftEditingId !== null && threadAnchor === null);

  /** 收起抽屉：抽屉里改过的意见先确认，取消则抽屉与修改都保留；没改过就直接收起编辑。 */
  function closeDrawer(): void {
    if (!drawerEditing) {
      commentsOpen = false;
      return;
    }
    if (!draftDirty) {
      resetDraft();
      commentsOpen = false;
      return;
    }
    guardDraft(() => {
      resetDraft();
      commentsOpen = false;
    });
  }

  function toggleDrawer(): void {
    if (commentsOpen) closeDrawer();
    else commentsOpen = true;
  }

  function removeComment(comment: ReviewComment): void {
    if (!onDeleteComment) return;
    onDeleteComment(comment.id);
    if (draftEditingId === comment.id) resetDraft();
    commentFeedback = `已删除 ${placeOf(comment.anchor)} 的一条意见。`;
  }

  /** 线程里「在抽屉中定位」：打开抽屉并把这张卡片滚到可见、聚焦。 */
  function locateInDrawer(comment: ReviewComment): void {
    commentsOpen = true;
    drawerFocus = null;
    void Promise.resolve().then(() => (drawerFocus = comment.id));
  }

  /** 抽屉卡片的「定位」：切到意见所在文件并在锚点处展开线程。 */
  function locateInDiff(comment: ReviewComment): void {
    const go = () => {
      const row = rowOf(comment.anchor.path);
      if (row && selected?.path !== row.path) goToRow(row);
      // 中、窄档抽屉覆盖在差异上：让出位置。
      if (tier !== "wide") commentsOpen = false;
      openThread(comment.anchor);
    };
    // 抽屉里有改了一半的意见：先确认再离开，取消则留在抽屉里继续改。
    if (draftEditingId && draftEditingId !== comment.id) {
      guardDraft(() => {
        resetDraft();
        go();
      });
      return;
    }
    if (draftEditingId && !draftDirty) resetDraft();
    go();
  }

  /** 草稿不在眼前（在别的文件，或被线程盖住）：给一条「继续编辑」的入口。 */
  let draftAway = $derived.by(() => {
    const anchor = draftAnchor;
    if (!anchor || draftEditingId || draftBody.trim() === "") return null;
    if (threadAnchor) return anchor;
    const shown = multiActive || continuous ? stackRows.some((row) => row.path === anchor.path) : selected?.path === anchor.path;
    // 文件在眼前，但差异里找不到锚点行（还没读到、被空白筛选隐藏）：编辑器放不进去，同样给入口。
    if (shown && inlinePlaced === false) return anchor;
    return shown ? null : anchor;
  });
  /** 草稿所在文件就在眼前，只是锚点行不在差异里：「继续编辑」改为就地展开编辑器。 */
  let draftDetached = $derived.by(() => {
    const anchor = draftAway;
    if (!anchor || threadAnchor || inlinePlaced !== false) return false;
    return multiActive || continuous ? stackRows.some((row) => row.path === anchor.path) : selected?.path === anchor.path;
  });
  /** 抽屉收起（或被让出）后抽屉里改了一半的意见：给回到抽屉的入口。 */
  let editAway = $derived(drawerEditing && draftDirty && !commentsOpen && !editOrphan ? draftAnchor : null);

  function resumeDraft(): void {
    const anchor = draftAnchor;
    if (!anchor) return;
    if (draftDetached) {
      detachedOpen = !detachedOpen;
      return;
    }
    threadAnchor = null;
    const row = rowOf(anchor.path);
    if (row && selected?.path !== row.path) goToRow(row);
  }

  let fileMenu = $state<ContextMenuRequest | null>(null);
  let headMenu = $state<ContextMenuRequest | null>(null);

  /** 头部「更多」里的低频动作：都会离开审查视图，不和阅读动作挤在同一行。 */
  let headEntries = $derived.by<ContextMenuEntry[]>(() => {
    const entries: ContextMenuEntry[] = [];
    const current = selected;
    if (onOpenUnstaged) {
      entries.push({
        id: "open-unstaged",
        label: "在未提交差异里按块/行暂存",
        icon: "file-diff",
        disabledReason: !current ? "先选择一个文件" : multiActive || continuous ? "回到单文件阅读后再按块/行暂存" : undefined,
        run: () => current && onOpenUnstaged?.(current.path),
      });
    }
    if (onShowCommits && task && task.commitCount > 0) {
      entries.push({ id: "commits", label: `查看范围内提交（${task.commitCount}）`, icon: "history", run: () => onShowCommits?.() });
    }
    if (onOpenChanges) {
      if (entries.length > 0) entries.push({ separator: true });
      entries.push({ id: "changes", label: "回到提交区", icon: "commit", run: () => onOpenChanges?.() });
    }
    return entries;
  });

  function openHeadMenu(event: MouseEvent): void {
    if (headMenu) {
      headMenu = null;
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    headMenu = { x: rect.right - 240, y: rect.bottom + 4, entries: headEntries, label: "更多审查操作" };
  }

  function menuTargets(row: FileRow): FileRow[] {
    return multiActive && selectedKeys.has(selectionKey(row)) ? selectedRows : [row];
  }

  function setReviewed(targets: FileRow[], value: boolean): void {
    if (!onToggleReview) return;
    for (const path of new Set(targets.map((row) => row.path))) {
      if (reviewed.has(path) !== value) onToggleReview(path);
    }
  }

  function stageTargets(targets: FileRow[], side: "staged" | "unstaged"): string[] {
    return [...new Set(targets.filter((row) => !row.unmerged && stageSideFor?.(row.path) === side).map((row) => row.path))];
  }

  function runStage(targets: FileRow[], side: "staged" | "unstaged"): void {
    const paths = stageTargets(targets, side);
    if (paths.length === 0 || writeLocked) return;
    if (side === "unstaged") {
      if (onStageFiles) onStageFiles(paths);
      else for (const path of paths) onStageFile?.(path);
    } else {
      if (onUnstageFiles) onUnstageFiles(paths);
      else for (const path of paths) onUnstageFile?.(path);
    }
  }

  function stageEntries(targets: FileRow[]): ContextMenuEntry[] {
    if (!onStageFile && !onUnstageFile && !onStageFiles && !onUnstageFiles) return [];
    const stageCount = stageTargets(targets, "unstaged").length;
    const unstageCount = stageTargets(targets, "staged").length;
    const busy = writeLocked ? "正在读取或写入，稍后再试" : undefined;
    return [
      {
        id: "stage",
        label: targets.length > 1 ? `暂存 ${stageCount} 个文件到索引` : "暂存到索引",
        icon: "plus",
        disabledReason: busy ?? (stageCount === 0 ? "所选文件没有可暂存的真实改动" : undefined),
        run: () => runStage(targets, "unstaged"),
      },
      {
        id: "unstage",
        label: targets.length > 1 ? `取消暂存 ${unstageCount} 个文件` : "取消暂存",
        icon: "minus",
        disabledReason: busy ?? (unstageCount === 0 ? "所选文件没有已暂存的真实改动" : undefined),
        run: () => runStage(targets, "staged"),
      },
    ];
  }

  function openFileMenu(row: FileRow, point: { x: number; y: number }): void {
    const targets = menuTargets(row);
    const entries: ContextMenuEntry[] = [];
    if (targets.length > 1) {
      entries.push({ heading: `已选 ${targets.length} 个文件` });
      if (onToggleReview) {
        const pending = targets.filter((item) => !reviewed.has(item.path)).length;
        const done = targets.length - pending;
        entries.push({ id: "review", label: `标记 ${pending} 个文件为已审阅`, icon: "check", disabledReason: pending === 0 ? "所选文件都已审阅" : undefined, run: () => setReviewed(targets, true) });
        entries.push({ id: "unreview", label: `撤销 ${done} 个文件的已审阅标记`, icon: "undo", disabledReason: done === 0 ? "所选文件还没有已审阅标记" : undefined, run: () => setReviewed(targets, false) });
      }
      entries.push(...stageEntries(targets));
    } else {
      entries.push({ id: "open", label: "查看净差异", icon: "file-diff", run: () => select({ path: row.path, side: row.side }) });
      if (onToggleReview) {
        const done = reviewed.has(row.path);
        entries.push({ id: "review", label: done ? "撤销已审阅标记" : "标记为已审阅", icon: done ? "undo" : "check", run: () => setReviewed([row], !done) });
      }
      entries.push(...stageEntries([row]));
      if (onFileHistory) entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onFileHistory?.(row.path) });
      if (onBlameFile && row.unstaged !== "deleted") entries.push({ id: "blame", label: "逐行追溯（Blame）", icon: "user", run: () => onBlameFile?.(row.path) });
      if (onEditFile && row.unstaged !== "deleted" && !row.unmerged) {
        entries.push({ id: "edit", label: "编辑工作区文件", icon: "pencil", run: () => onEditFile?.(row.path, null) });
      }
    }
    if (onCopyPaths) {
      entries.push({ separator: true });
      entries.push({ id: "copy", label: targets.length > 1 ? "复制所选相对路径" : "复制相对路径", icon: "copy", run: () => onCopyPaths?.(targets.map((item) => item.path)) });
    }
    if (targets.length > 1) {
      entries.push({ separator: true });
      entries.push({ id: "clear", label: "退出多选", icon: "x", shortcut: "Esc", run: () => selected && select(selected) });
    }
    fileMenu = { ...point, entries, label: targets.length > 1 ? `已选 ${targets.length} 个文件的操作` : `${row.path} 的操作` };
  }

  async function readTask(baseline: string | null): Promise<void> {
    const at = ++readSerial;
    diffToken += 1;
    if (!baseline) {
      task = null;
      phase = "no-baseline";
      failure = null;
      invalidRange = false;
      reading = false;
      diff = null;
      diffError = null;
      selected = null;
      selectedSet = [];
      onSnapshot?.(null);
      return;
    }
    reading = true;
    // 刚拿到起点（来源先于起点请求到达，或从无起点切到有起点）：说「正在读取」，
    // 不让上一刻的「没有任务范围」在读取期间继续冒充结论。失败态保留到新结果出来，避免闪动。
    if (phase === "no-baseline") phase = "reading";
    try {
      let result: TaskReview;
      try {
        result = await taskReads.run(() => {
          if (at !== readSerial) throw { code: "cancelled" };
          return api.taskReview(opened.summary.path, baseline, opened.generation, nextId());
        });
      } catch (error) {
        const normalized = normalizeError(error);
        // 旧代次：收下后端给的新代次重读一次，不把一次过期请求当成任务结论。
        if (normalized.code !== "stale" || normalized.generation === undefined) throw error;
        if (at !== readSerial) return;
        onGeneration(normalized.generation);
        result = await taskReads.run(() => {
          if (at !== readSerial) throw { code: "cancelled" };
          return api.taskReview(
            opened.summary.path,
            baseline,
            Math.max(normalized.generation!, opened.generation),
            nextId(),
          );
        });
      }
      if (at !== readSerial) return;
      task = result;
      phase = "ready";
      failure = null;
      invalidRange = false;
      // 范围身份交给外壳：任务快照 token 与已审阅记录都绑定这份解析结果。
      onSnapshot?.({
        worktree: result.worktree,
        baselineOid: result.baselineOid,
        headOid: result.headOid,
        rangeVersion: result.rangeVersion,
        generation: result.generation,
      });
      // 刷新后按路径保留仍然存在的选择；消失的文件让位给列表第一个。
      const keptFocus = keep(selected);
      const keptSet = selectedSet.flatMap((item) => {
        const next = keep(item);
        return next ? [next] : [];
      });
      selectedSet = keptSet.length > 1 ? keptSet : [];
      // 切回某个来源时优先恢复它上次选中的文件；仍不在任务里时让位给列表第一个。
      const restored = restorePath && rowOf(restorePath) ? { path: restorePath, side: "unstaged" as const } : null;
      restorePath = null;
      selected = restored ?? keptFocus ?? (rows[0] ? { path: rows[0].path, side: rows[0].side } : null);
      void loadSelectedDiff();
    } catch (error) {
      if (at !== readSerial) return;
      const normalized = normalizeError(error);
      // 失败就撤下「当前任务结果」：旧内容不能继续冒充这次任务的净差异。
      task = null;
      phase = "failed";
      failure = normalized;
      invalidRange = RANGE_INVALID.has(normalized.code);
      diff = null;
      diffError = null;
      selected = null;
      selectedSet = [];
      onSnapshot?.(null);
      onFailure?.(error);
    } finally {
      if (at === readSerial) reading = false;
    }
  }

  let readKey = "";
  let wasActive = false;
  $effect(() => {
    const isActive = active;
    const baseline = request?.baseline ?? null;
    // 仓库、起点请求与状态代次一起决定这一轮：外部变化（generation 前进）也重读，
    // 旧响应不覆盖新选择。对象本身不能当键——插值永远是 "[object Object]"。
    const key = `${opened.summary.path}|${request?.nonce ?? 0}|${baseline ?? ""}|${opened.generation}`;
    // 四个视图同时保活：隐藏的任务视图不发起仓库读取，回到任务页时按最新状态重读。
    if (!isActive) {
      wasActive = false;
      readSerial += 1;
      reading = false;
      return;
    }
    if (key === readKey && wasActive) return;
    readKey = key;
    wasActive = true;
    untrack(() => void readTask(baseline));
  });

  $effect(() => {
    void detailActive;
    void fullFile;
    untrack(() => {
      if (!detailActive || !reading) void loadSelectedDiff();
    });
  });

  async function loadSelectedDiff(): Promise<void> {
    const token = ++diffToken;
    // Do not retain the entire task file/commit list in an in-flight preview.
    const current = task ? { worktree: task.worktree, baselineOid: task.baselineOid, headOid: task.headOid } : null;
    const choice = selected;
    if (!detailActive || !current || !choice || multiActive || continuous) {
      diff = null;
      diffError = null;
      diffLoading = false;
      return;
    }
    diffLoading = true;
    diffError = null;
    const row = rowOf(choice.path);
    const asText = asTextFor === choice.path;
    try {
      let result: DiffResponse;
      try {
        result = await diffReads.run(() => {
          if (token !== diffToken) throw { code: "cancelled" };
          return fetchDiff(current, choice.path, row?.originalPath ?? null, 0, 0, asText);
        });
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code !== "stale" || normalized.generation === undefined) throw error;
        if (token !== diffToken) return;
        onGeneration(normalized.generation);
        result = await fetchDiff(current, choice.path, row?.originalPath ?? null, 0, 0, asText);
      }
      if (token !== diffToken) return;
      diff = reuseDiffContent(diff, result);
      diffError = null;
    } catch (error) {
      if (token !== diffToken) return;
      const normalized = normalizeError(error);
      if (RANGE_INVALID.has(normalized.code)) {
        // 范围已经不成立：撤下结果，交回重新读取或重选起点。
        task = null;
        phase = "failed";
        failure = normalized;
        invalidRange = true;
        selected = null;
        selectedSet = [];
        onSnapshot?.(null);
      }
      diff = null;
      diffError = normalized.message;
    } finally {
      if (token === diffToken) diffLoading = false;
    }
  }

  async function fetchDiff(
    current: Pick<TaskReview, "worktree" | "baselineOid" | "headOid">,
    path: string,
    original: string | null,
    offset: number,
    limit: number,
    asText: boolean,
  ): Promise<DiffResponse> {
    return api.loadTaskDiff(
      current.worktree,
      current.baselineOid,
      current.headOid,
      path,
      opened.generation,
      nextId(),
      original,
      offset,
      limit,
      fullFile ? FULL_FILE_CONTEXT : undefined,
      asText,
    );
  }

  /** MultiFileDiff 的读取入口：同一份任务范围、同一套分页与预览语义。 */
  function taskLoader(
    row: FileRow,
    page: { generation: number; requestId: number; offset: number; limit: number; context?: number },
  ): Promise<DiffResponse> {
    const current = task;
    if (!current) return Promise.reject(new Error("任务范围已经失效，请重新读取。"));
    return api.loadTaskDiff(
      current.worktree,
      current.baselineOid,
      current.headOid,
      row.path,
      page.generation,
      page.requestId,
      row.originalPath ?? null,
      page.offset,
      page.limit,
      page.context,
      false,
    );
  }

  async function loadMoreDiff(): Promise<void> {
    const current = task;
    const choice = selected;
    const loaded = diff;
    if (!detailActive || moreLoading || !current || !choice || !loaded) return;
    if (loaded.offset + loaded.lines.length >= loaded.totalLines) return;
    const token = diffToken;
    const asText = asTextFor === choice.path;
    const row = rowOf(choice.path);
    moreLoading = true;
    try {
      const page = await fetchDiff(
        current,
        choice.path,
        row?.originalPath ?? null,
        loaded.offset + loaded.lines.length,
        400,
        asText,
      );
      if (token !== diffToken) return;
      diff = appendDiffPage(loaded, page);
    } catch (error) {
      if (token !== diffToken) return;
      diffError = normalizeError(error).message;
    } finally {
      moreLoading = false;
    }
  }

  function reload(): void {
    void readTask(request?.baseline ?? null);
  }

  function setReadingMode(mode: ReviewReadingMode): void {
    if (readingMode === mode) return;
    readingMode = mode;
    if (mode === "single") void loadSelectedDiff();
  }

  /** 任务读取状态对应的整页状态；ready 且有文件时为 null，交给差异区。 */
  let pageState = $derived.by<ReviewWorkbenchBlock | null>(() => {
    if (block) return block;
    if (phase === "no-baseline") {
      const actions: ReviewStateAction[] = [];
      if (onShowHistory) actions.push({ id: "history", label: "查看普通历史", icon: "history", run: onShowHistory });
      if (onReturnToCliora) actions.push({ id: "return", label: "返回 Cliora", icon: "arrow-left", primary: true, run: onReturnToCliora });
      return {
        kind: "no-baseline",
        title: "没有任务范围",
        message: "Cliora 审查链接没有携带任务起点；这里不会用 HEAD 或默认分支补缺。可以查看普通历史，或返回 Cliora 重新发起。",
        actions,
      };
    }
    if (phase === "failed") {
      return {
        kind: invalidRange ? "range-invalid" : "read-failed",
        title: invalidRange ? "任务范围已失效" : "读取任务范围失败",
        message: failure?.message ?? "无法读取这次任务，仓库没有被修改。",
        detail: failure?.code ? `错误码 ${failure.code}` : null,
        actions: [
          { id: "reload", label: "重新读取", icon: "refresh", primary: true, run: reload },
          ...(invalidRange && onReturnToCliora ? [{ id: "return", label: "返回 Cliora", icon: "arrow-left" as const, run: onReturnToCliora }] : []),
        ],
      };
    }
    if (!task) return { kind: "reading", title: "正在读取任务范围", message: "正在读取起点到当前工作区的最终结果，仓库不会被修改。" };
    if (task.empty) return { kind: "empty", title: "这个任务没有净改动", message: task.message };
    return null;
  });
</script>

<!-- 后台重读不在界面上插提示或转圈：旧结果原地保留到新结果就绪，只用 aria-busy 告诉读屏。 -->
<div class="task-detail review-workbench" aria-label="审查工作台" aria-busy={reading && task ? "true" : undefined} style:display={visible ? null : "none"}>
  <div
    class="task-split review-layout"
    class:queue-hidden={queueHidden}
    data-tier={tier}
    style={`--task-files:${taskFilesShown}px`}
    use:measureWidth
  >
    <aside class="task-files review-side" aria-label="审查来源与任务文件">
      {@render paneHead?.()}
      {@render sourceCard?.()}
      {#if !block && task && !task.empty}
        <div class="review-queue" id="review-queue" aria-label="审查队列">
        <ReviewQueueBar
          {filter}
          visible={rows.length}
          total={reviewTotal}
          reviewed={reviewReviewed}
          commented={commentedPaths.size}
          clearable={filter !== "all" || query.trim() !== "" || hideReviewed}
          onFilter={setFilter}
          onClear={clearFilters}
        />
        <FileList
          variant="task"
          searchId="task-file-search"
          files={files}
          {selected}
          {selectedSet}
          {query}
          disabled={writeLocked}
          onQuery={(value) => (query = value)}
          onSelect={select}
          onMultiSelect={selectMany}
          onContextMenu={openFileMenu}
          onStage={() => {}}
          onUnstage={() => {}}
          {reviewed}
          {reviewTotal}
          {reviewReviewed}
          {hideReviewed}
          {onHideReviewed}
          {onToggleReview}
          {reviewBusy}
          {reviewNote}
          {reviewNav}
          {onStageFile}
          {onUnstageFile}
          {stageSideFor}
          visiblePaths={filterPaths}
          filterEmpty={queueEmpty}
          rowNotes={revokedNotes}
          contentSearch={{ active: contentMode, busy: contentBusy, note: contentMode && query.trim() ? contentNote : null, onToggle: setContentMode }}
          rowHits={contentFilter}
        />
        </div>
      {/if}
    </aside>
    <PaneResizer
      value={taskFilesShown}
      saved={taskFilesWidth}
      label="调整任务文件栏宽度"
      fit={(width) => fitTaskFilesWidth(width, taskSplitWidth)}
      onResize={(width) => (taskFilesWidth = width)}
      onCommit={saveTaskFilesWidth}
    />
    <div class="review-main">
      {#if !block && (task || request)}
        <header class="commit-head task-head review-head">
          <div class="commit-head-main">
            <h2 class="commit-title">任务净差异</h2>
            <div class="commit-byline task-byline" role="group" aria-label="任务范围">
              <span class="task-range" title={task ? `起点 ${task.baselineOid}\nHEAD ${task.headOid}` : (request?.baseline ?? "")}>
                <span class="task-kicker">起点</span>
                <code class="task-oid">{baselineLabel || "未选择"}</code>
                <Icon name="arrow-right" size={12} />
                {#if task}
                  <span class="task-value">{branchLabel(task.branch)}</span>
                  <code class="task-oid">{headLabel}</code>
                  {#if task.dirty}<span class="task-value">+ 未提交改动</span>{/if}
                {:else}
                  <span class="task-value">工作区</span>
                {/if}
              </span>
              {#if task}
                <span class="task-stats">
                  {#if onShowCommits && task.commitCount > 0}
                    <button type="button" class="task-value task-link" title="转到历史，只看起点之后的提交" onclick={onShowCommits}>{task.commitCount} 个提交</button>
                  {:else}
                    <span class="task-value">{task.commitCount} 个提交</span>
                  {/if}
                  <span class="task-value">{task.filesTotal} 个文件</span>
                  <LineCounts stat={{ additions: task.additions, deletions: task.deletions }} />
                </span>
                {#if task.untrackedFiles > 0}<span class="task-tag">未跟踪 {task.untrackedFiles} 个</span>{/if}
                {#if task.conflicted}<span class="task-tag danger">有冲突</span>{/if}
              {/if}
              <span class="read-only-chip" title="任务净差异只读：不会写入暂存区，也不改变提交范围">
                <Icon name="eye" size={12} />只读
              </span>
            </div>
            {#if task?.filesTruncated}
              <p class="task-context-note" role="alert">{task.message}</p>
            {/if}
          </div>
          {#if task}
            <div class="commit-facts review-head-actions">
              {#if !task.empty}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm review-queue-toggle"
                  aria-controls="review-queue"
                  aria-expanded={!queueHidden}
                  aria-label={tier === "narrow" ? (queueHidden ? "打开文件队列" : "关闭文件队列") : queueHidden ? "展开左栏" : "收起左栏"}
                  title={tier === "narrow" ? (queueHidden ? "打开文件队列" : "关闭文件队列") : queueHidden ? "展开左栏" : "收起左栏"}
                  onclick={toggleQueue}
                ><Icon name="sidebar" size={13} /><span>文件 {rows.length}</span></button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm review-mark-next"
                  disabled={markNextReason !== null}
                  title={markNextReason ?? "标记当前文件已审阅，再前往可见队列里下一个未审阅文件（Alt+Shift+M）"}
                  aria-label="标记并继续"
                  aria-keyshortcuts="Alt+Shift+M"
                  onclick={() => void markAndContinue()}
                >
                  {#if marking}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="check" size={13} />{/if}<span>标记并继续</span>
                </button>
                <div class="segmented review-mode" role="group" aria-label="阅读模式">
                  <button
                    type="button"
                    aria-pressed={readingMode === "single"}
                    title="一次看一个文件"
                    onclick={() => setReadingMode("single")}
                  ><Icon name="file" size={12} /><span>单文件</span></button>
                  <button
                    type="button"
                    aria-pressed={readingMode === "continuous"}
                    title="连续阅读当前可见队列的全部文件"
                    onclick={() => setReadingMode("continuous")}
                  ><Icon name="rows" size={12} /><span>连续</span></button>
                </div>
              {/if}
              {#if onAddComment || onEditComment || onDeleteComment}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm review-comments-toggle"
                  aria-expanded={commentsOpen}
                  aria-label={commentsOpen ? "收起意见列表" : "查看意见列表"}
                  title={comments.length > 0 ? `${comments.length} 条意见` : "还没有意见"}
                  onclick={toggleDrawer}
                >
                  <Icon name="list" size={13} /><span>意见</span>{#if comments.length > 0}<span class="count">{comments.length}</span>{/if}
                </button>
              {/if}
              {#if headEntries.length > 0}
                <button
                  type="button"
                  class="icon-btn sm review-more-btn"
                  aria-label="更多审查操作"
                  aria-haspopup="menu"
                  aria-expanded={headMenu !== null}
                  title="更多：按块/行暂存、范围内提交、回到提交区"
                  onclick={openHeadMenu}
                ><Icon name="more" size={15} /></button>
              {/if}
            </div>
          {/if}
        </header>
      {/if}

      {#if !block && queueNote}
        <p class="review-queue-note review-queue-note-main" role="status"><Icon name="info" size={13} /><span>{queueNote}</span></p>
      {/if}

      {#if !block && commentNotice}<p class="task-comment-note review-comment-notice" role="status">{commentNotice}</p>{/if}
      {#if !block && commenting}
        <p class="review-comment-feedback" role="status" aria-live="polite">{#if commentFeedback}<Icon name="check" size={12} /><span>{commentFeedback}</span>{/if}</p>
      {/if}
      {#if !block && draftAway}
        <p class="review-draft-away" role="status">
          <Icon name="pencil" size={13} />
          <span class="truncate">1 条意见草稿未保存：{draftAway.path}（{anchorLabel(draftAway)}）{#if draftDetached}· 这一行当前不在差异里显示{/if}</span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-expanded={draftDetached ? detachedOpen : undefined}
            title={draftDetached ? "锚点行还没读到或被筛选隐藏：在这里继续写" : "回到草稿所在的位置继续写"}
            onclick={resumeDraft}
          >继续编辑</button>
        </p>
        {#if draftDetached && detachedOpen && draftAnchor && !draftEditingId}
          <div class="review-draft-detached">
            <InlineCommentEditor
              anchor={draftAnchor}
              body={draftBody}
              dirty={draftDirty}
              error={commentError}
              onInput={(value) => {
                draftBody = value;
                commentError = null;
              }}
              onSave={saveDraft}
              onCancel={cancelDraft}
            />
          </div>
        {/if}
      {/if}
      {#if !block && editAway}
        <p class="review-draft-away" role="status">
          <Icon name="pencil" size={13} />
          <span class="truncate">1 条意见的修改未保存：{editAway.path}（{anchorLabel(editAway)}）</span>
          <button type="button" class="btn btn-ghost btn-sm" title="打开意见列表继续修改" onclick={() => (commentsOpen = true)}>继续编辑</button>
        </p>
      {/if}
      {#if !block && editOrphan}
        <p class="review-draft-away" role="alert">
          <Icon name="alert" size={13} />
          <span class="truncate">正在编辑的意见已不在当前批次（可能已失效），无法保存；原文可在意见抽屉的「已失效」分区复制。</span>
          <button type="button" class="btn btn-ghost btn-sm" title="丢掉这次修改" onclick={() => { resetDraft(); threadAnchor = null; }}>放弃修改</button>
        </p>
      {/if}

      <div class="review-body" data-drawer={!block && commentsOpen ? "open" : undefined}>
      <div class="review-stage">
        {#if pageState}
          <ReviewStatePanel
            kind={pageState.kind}
            title={pageState.title}
            message={pageState.message}
            detail={pageState.detail ?? null}
            actions={pageState.actions ?? []}
          />
        {:else if task && rows.length > 0}
          <div class="task-diff">
            {#if selectedRebuilt}
              <!-- 工作区重建：起点里有旧版本，工作区里是未跟踪的同名文件。行数只统计重建后的内容，
                   不暗示为纯新增；files 列表与这条单文件差异用的是同一份口径。 -->
              <p class="task-diff-note" role="note">
                这个路径在起点里有旧版本，当前是工作区重建：行数只统计重建后的文件，单文件差异按新增文件显示。
              </p>
            {/if}
            {#if !multiActive && !continuous && diff?.truncated}
              <!-- 截断就如实说截断：不把只读到的一部分当成完整净差异（R7）。 -->
              <p class="task-diff-note" role="alert">{diff.summary || "这条净差异超过预览上限，只读到一部分。"}</p>
            {/if}
            {#if multiActive || continuous}
              <MultiFileDiff
                active={detailActive}
                {opened}
                rows={stackRows}
                countLabel={multiActive ? undefined : `连续阅读 · 可见 ${stackRows.length} 个文件`}
                clearLabel={multiActive ? undefined : "回到单文件"}
                focus={selected}
                {nav}
                disabled={writeLocked}
                readOnly
                loadDiff={taskLoader}
                scopeKey={scopeKey}
                {fullFile}
                fullContext={FULL_FILE_CONTEXT}
                stageCount={0}
                unstageCount={0}
                discardCount={0}
                conflictCount={0}
                {onOpenUnstaged}
                {nextId}
                {reviewed}
                {onToggleReview}
                {stageSideFor}
                {onStageFiles}
                {onUnstageFiles}
                onFocus={focusBlock}
                onStale={onGeneration}
                onStageHunk={() => {}}
                onFullFile={onFullFile}
                onFileHistory={(path) => onFileHistory?.(path)}
                onReadDocument={onReadDocument}
                onStage={() => {}}
                onUnstage={() => {}}
                onDiscard={() => {}}
                comments={commentKeys}
                onCommentLine={beginComment}
                inlineComment={inlineTarget}
                inlinePanel={commentPanel}
                onInlinePlaced={(placed) => (inlinePlaced = placed)}
                onClear={() => {
                  if (multiActive) {
                    if (selected) select(selected);
                  } else {
                    setReadingMode("single");
                  }
                }}
              />
            {:else}
              <DiffView
                readingKey={`${opened.summary.path}:task:${request?.baseline ?? ""}`}
                selection={selected}
                {diff}
                error={diffError}
                loading={diffLoading}
                disabled={false}
                readOnly
                readOnlyLabel="任务净差异"
                reviewed={selected ? reviewed.has(selected.path) : false}
                reviewBusy={selected ? reviewBusy === selected.path : false}
                onToggleReview={selected && onToggleReview ? () => onToggleReview(selected!.path) : undefined}
                onStageHunk={() => {}}
                onLoadMore={() => void loadMoreDiff()}
                onFileHistory={onFileHistory}
                onReadDocument={onReadDocument}
                {fullFile}
                onFullFile={onFullFile}
                comments={commentKeys}
                onCommentLine={beginComment}
                inlineComment={inlineTarget}
                inlinePanel={commentPanel}
                onInlinePlaced={(placed) => (inlinePlaced = placed)}
                asText={asTextFor !== null && asTextFor === selected?.path}
                onViewAsText={(next) => {
                  asTextFor = next && selected ? selected.path : null;
                  void loadSelectedDiff();
                }}
                fileNav={nav}
                fileCount={rows.length}
                {findRequest}
                onBlame={onBlameFile && selectedEditable ? onBlameFile : undefined}
                onRetry={() => void loadSelectedDiff()}
                onHunkNav={onHunkNav}
                onEdit={onEditFile && selected && selectedEditable
                  ? (line) => {
                      // 编辑的是当前工作区文件，不是这份聚合差异；cliora 来源与任务范围保持不变。
                      if (selected) onEditFile?.(selected.path, line);
                    }
                  : undefined}
              />
            {/if}
          </div>
        {:else if task}
          <div class="empty task-placeholder" role="status">
            <span class="empty-icon"><Icon name="search" size={22} /></span>
            {#if query.trim() && contentMode}
              <strong>没有任务文件的内容包含“{query.trim()}”</strong>
            {:else if query.trim()}
              <strong>没有匹配“{query.trim()}”的任务文件</strong>
            {:else}
              <strong>当前筛选下没有文件</strong>
            {/if}
            <button type="button" class="btn btn-ghost btn-sm" onclick={clearFilters}>清除筛选</button>
          </div>
        {/if}
      </div>
      {#if !block && commentsOpen}
        <ReviewCommentsDrawer
          {comments}
          stale={staleComments}
          focusId={drawerFocus}
          onLocate={locateInDiff}
          editingId={drawerEditing ? draftEditingId : null}
          editBody={draftBody}
          editDirty={draftDirty}
          editError={commentError}
          onBeginEdit={onEditComment ? beginDrawerEdit : undefined}
          onEditInput={(value) => {
            draftBody = value;
            commentError = null;
          }}
          onSaveEdit={saveDraft}
          onCancelEdit={cancelDraft}
          onDelete={onDeleteComment ? removeComment : undefined}
          onCopy={onCopyText}
        />
      {/if}

      </div>
      {@render completion?.()}
    </div>
  </div>
</div>

{#snippet commentPanel()}
  {#if threadAnchor}
    <InlineCommentThread
      anchor={threadAnchor}
      comments={threadComments}
      editingId={draftEditingId}
      editBody={draftBody}
      editDirty={draftDirty}
      editError={commentError}
      onBeginEdit={beginEdit}
      onEditInput={(value) => {
        draftBody = value;
        commentError = null;
      }}
      onSaveEdit={saveDraft}
      onCancelEdit={cancelDraft}
      onDelete={removeComment}
      onAddAnother={() => threadAnchor && startDraft(threadAnchor)}
      onLocate={locateInDrawer}
      onClose={closeThread}
    />
  {:else if draftAnchor && !draftEditingId}
    <InlineCommentEditor
      anchor={draftAnchor}
      body={draftBody}
      dirty={draftDirty}
      error={commentError}
      onInput={(value) => {
        draftBody = value;
        commentError = null;
      }}
      onSave={saveDraft}
      onCancel={cancelDraft}
    />
  {/if}
{/snippet}

{#if replacing}
  {@const pending = replacing}
  <ConfirmDialog
    title="放弃未保存的意见草稿？"
    titleId="review-draft-replace-title"
    icon="alert"
    tone="warning"
    message={pending.message}
    notes={[{ tone: "info", text: "取消则草稿原样保留，可以先保存再继续。" }]}
    confirmLabel="放弃草稿并继续"
    cancelLabel="继续编辑草稿"
    focus="cancel"
    onConfirm={() => {
      const run = pending.run;
      replacing = null;
      resetDraft();
      run();
    }}
    onCancel={() => (replacing = null)}
  />
{/if}

{#if fileMenu}
  <ContextMenu request={fileMenu} onClose={() => (fileMenu = null)} />
{/if}

{#if headMenu}
  <ContextMenu request={headMenu} onClose={() => (headMenu = null)} />
{/if}
