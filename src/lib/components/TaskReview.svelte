<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { api } from "../api";
  import { FULL_FILE_CONTEXT, reuseDiffContent, type HunkNavReport } from "../diff";
  import { normalizeError } from "../errors";
  import { shortOid } from "../history";
  import { branchLabel } from "../labels";
  import { LatestReadQueue } from "../latest-read";
  import { anchorLabel, previewComments, type ReviewComment, type ReviewCommentAnchor } from "../review-comments.svelte";
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
  } from "../types";
  import {
    fileNavState,
    appendDiffPage,
    orderedRows,
    reviewQueue,
    sameSelection,
    selectionKey,
    type FileNavState,
    type ReviewQueueState,
  } from "../ui";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import DiffView from "./DiffView.svelte";
  import FileList from "./FileList.svelte";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";
  import MultiFileDiff from "./MultiFileDiff.svelte";
  import PaneResizer from "./PaneResizer.svelte";
  import { clampWidth } from "../layout";

  /**
   * 任务净差异：cliora 审查链接带来的起点到当前工作区的最终结果。
   *
   * 它不是独立视图，而是历史详情区里的一块：历史按「起点..HEAD」过滤后，顶部「任务净差异」
   * 行选中时显示它；选中某个提交时它隐藏但保活，回来时阅读位置不丢。
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
    onAddComment?: (anchor: ReviewCommentAnchor, body: string) => void;
    onEditComment?: (id: string, body: string) => void;
    onDeleteComment?: (id: string) => void;
    /** 显式准备送回原任务：只有这个动作会写交接文件并打开深链。 */
    onPrepareFeedback?: () => void;
    feedbackPreparing?: boolean;
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
    onAddComment,
    onEditComment,
    onDeleteComment,
    onPrepareFeedback,
    feedbackPreparing = false,
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

  let files = $derived((task?.files ?? []).map(toChange));
  let rows = $derived(orderedRows(files, query));
  let rowsByPath = $derived(new Map(rows.map((row) => [row.path, row])));
  let multiActive = $derived(selectedSet.length > 1);
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
    files.length > 0 ? reviewQueue(rows, reviewed, selected, goToRow) : null,
  );
  /** 选中的这条路径是不是「工作区重建」：行数与单文件差异都按重建后的内容给。 */
  let selectedRebuilt = $derived(
    selected ? (rowsByPath.get(selected.path)?.rebuilt ?? false) : false,
  );
  /** 净结果里这条路径仍在工作区（不是删除、也不是未解决冲突）：只有这时才给编辑入口。 */
  let selectedEditable = $derived.by(() => {
    const row = selected ? rowsByPath.get(selected.path) : null;
    return Boolean(row && row.unstaged !== "deleted" && !row.unmerged);
  });

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
    if (multiActive) selected = item;
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
   * 行意见：只在这里保存「哪一行、写了什么」。意见不改 Git、不写索引，也不触发 Agent；
   * 只有用户点「准备送回原任务」时外壳才会写交接文件。范围变化后外壳整体失效这批意见，
   * 这里不做任何行号重映射。
   */
  let commentsOpen = $state(false);
  let draftAnchor = $state<ReviewCommentAnchor | null>(null);
  let draftBody = $state("");
  let editingId = $state<string | null>(null);
  let editBody = $state("");
  let commentError = $state<string | null>(null);

  let canPrepare = $derived(comments.length > 0 && !feedbackPreparing && Boolean(onPrepareFeedback));

  function beginComment(anchor: ReviewCommentAnchor): void {
    draftAnchor = anchor;
    draftBody = "";
    editingId = null;
    commentError = null;
  }

  function cancelDraft(): void {
    draftAnchor = null;
    draftBody = "";
  }

  /** 新增一条意见：上限与空正文由意见状态层统一校验，失败消息原样给用户看。 */
  function saveDraft(): void {
    const anchor = draftAnchor;
    if (!anchor || !onAddComment) return;
    try {
      onAddComment(anchor, draftBody);
    } catch (error) {
      commentError = error instanceof Error ? error.message : "这条意见没有保存。";
      return;
    }
    commentError = null;
    cancelDraft();
  }

  function beginEdit(comment: ReviewComment): void {
    editingId = comment.id;
    editBody = comment.body;
    draftAnchor = null;
    commentError = null;
  }

  function saveEdit(): void {
    const id = editingId;
    if (!id || !onEditComment) return;
    try {
      onEditComment(id, editBody);
    } catch (error) {
      commentError = error instanceof Error ? error.message : "这条意见没有保存。";
      return;
    }
    commentError = null;
    editingId = null;
    editBody = "";
  }

  function cancelEdit(): void {
    editingId = null;
    editBody = "";
    commentError = null;
  }

  function removeComment(id: string): void {
    onDeleteComment?.(id);
    if (editingId === id) cancelEdit();
  }

  let fileMenu = $state<ContextMenuRequest | null>(null);

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
      selected = keptFocus ?? (rows[0] ? { path: rows[0].path, side: rows[0].side } : null);
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
    if (!detailActive || !current || !choice || multiActive) {
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
</script>

<!-- 后台重读不在界面上插提示或转圈：旧结果原地保留到新结果就绪，只用 aria-busy 告诉读屏。 -->
<div class="task-detail" aria-label="任务净差异" aria-busy={reading && task ? "true" : undefined} style:display={visible ? null : "none"}>
  <header class="commit-head task-head">
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
            <span class="task-value">{task.commitCount} 个提交</span>
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
    {#if task && onOpenChanges}
      <div class="commit-facts">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          aria-label="回到改动视图提交"
          title="提交只按真实暂存范围执行；任务净差异不会自动进入提交"
          onclick={onOpenChanges}
        >
          <Icon name="commit" size={13} /><span>回到提交区</span>
        </button>
      </div>
    {/if}
  </header>

  {#if onPrepareFeedback}
    <!-- 意见是任务级的下一步：一行计数 + 两个动作，展开后才显示可编辑列表与整批预览。 -->
    <div class="task-comments" role="group" aria-label="审阅意见">
      <span class="task-comments-count">{comments.length > 0 ? comments.length + " 条意见" : "还没有意见"}</span>
      <span class="task-comments-route" title="意见只存在这个窗口。送回后由 cliora 让你确认，才会写进发起审查的那个 CLI 会话；不会自动执行，也不改代码。">
        {comments.length > 0 ? "送回后在 cliora 确认，再写进原会话" : "点块标题的「评论此块」或行尾气泡写意见，写完一起送回原会话"}
      </span>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        aria-expanded={commentsOpen}
        aria-label={commentsOpen ? "收起意见列表" : "查看意见列表"}
        onclick={() => (commentsOpen = !commentsOpen)}
      >
        <Icon name="list" size={13} /><span>{commentsOpen ? "收起意见" : "查看意见"}</span>
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        disabled={!canPrepare}
        aria-label="准备把这批意见送回原任务"
        title={comments.length === 0
          ? "先在差异行上写一条意见"
          : "写一个私有的交接文件，并打开 cliora 深链；这里不会自动发送或修改代码"}
        onclick={() => onPrepareFeedback?.()}
      >
        <Icon name="sparkle" size={13} /><span>{feedbackPreparing ? "正在准备…" : "准备送回原任务"}</span>
      </button>
      {#if commentNotice}<span class="task-comment-note" role="status">{commentNotice}</span>{/if}
    </div>
  {/if}

  {#if draftAnchor}
    <form
      class="task-comment-composer"
      aria-label={draftAnchor.range ? "给这一块添加意见" : "给这一行添加意见"}
      onsubmit={(event) => {
        event.preventDefault();
        saveDraft();
      }}
    >
      <div class="task-comment-head">
        <span class="task-comment-path">{draftAnchor.path}</span>
        <span>{anchorLabel(draftAnchor)}</span>
      </div>
      {#if draftAnchor.quote}<p class="task-comment-quote">{draftAnchor.quote}</p>{/if}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="textarea"
        rows={3}
        autofocus
        bind:value={draftBody}
        aria-label="意见正文"
        placeholder={draftAnchor.range ? "这一块要怎么改？说清楚就够了。" : "这一行要改成什么样？说清楚就够了。"}
        onkeydown={(event) => {
          if (event.isComposing) return;
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (draftBody.trim() !== "") saveDraft();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelDraft();
          }
        }}
      ></textarea>
      <div class="task-comment-actions">
        <button
          type="submit"
          class="btn btn-primary btn-sm"
          disabled={draftBody.trim() === ""}
          title={draftBody.trim() === "" ? "先写一句要怎么改" : "加到这批意见（Ctrl+Enter）"}
        >添加意见</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={cancelDraft}>取消</button>
        <span class="task-comment-note">Ctrl+Enter 添加 · Esc 取消 · 只存在本窗口，不会自动发送</span>
      </div>
    </form>
  {/if}

  {#if commentsOpen}
    <div class="task-comments-panel" aria-label="意见列表">
      {#if comments.length === 0}
        <p class="task-comment-note">还没有意见。点块标题上的「评论此块」一次说一整块，或用行尾气泡说某一行。</p>
      {:else}
        {#each comments as comment (comment.id)}
          <article class="task-comment" data-comment-id={comment.id}>
            <div class="task-comment-head">
              <span class="task-comment-path">{comment.anchor.path}</span>
              <span>{anchorLabel(comment.anchor)}</span>
            </div>
            {#if comment.anchor.quote}<p class="task-comment-quote">{comment.anchor.quote}</p>{/if}
            {#if editingId === comment.id}
              <textarea
                class="textarea"
                rows={3}
                bind:value={editBody}
                aria-label={comment.anchor.path + " 的意见正文"}
              ></textarea>
              <div class="task-comment-actions">
                <button type="button" class="btn btn-primary btn-sm" onclick={saveEdit}>保存意见</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick={cancelEdit}>取消</button>
              </div>
            {:else}
              <p class="task-comment-body">{comment.body}</p>
              <div class="task-comment-actions">
                <button type="button" class="btn btn-ghost btn-sm" onclick={() => beginEdit(comment)}>编辑</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick={() => removeComment(comment.id)}>删除</button>
              </div>
            {/if}
          </article>
        {/each}
        <pre class="task-comment-preview" aria-label="整批意见预览">{previewComments(comments)}</pre>
      {/if}
      {#if commentError}<p class="task-comment-note" role="alert">{commentError}</p>{/if}
    </div>
  {/if}

  {#if phase === "failed"}
    <div class="empty task-failure" role="alert">
      <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
      <strong>{invalidRange ? "任务范围已失效" : "读取任务范围失败"}</strong>
      <p>{failure?.message ?? "无法读取这次任务，仓库没有被修改。"}</p>
      <button type="button" class="btn btn-secondary btn-sm" onclick={reload}>重新读取</button>
    </div>
  {:else if phase === "no-baseline"}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="layers" size={22} /></span>
      <strong>没有任务范围</strong>
      <p>cliora 审查链接没有携带起点。</p>
    </div>
  {:else if !task}
    <div class="empty" role="status" aria-busy="true">
      <span class="empty-icon"><span class="spinner"></span></span>
      <strong>正在读取任务范围</strong>
    </div>
  {:else if task.empty}
    <div class="empty task-empty">
      <span class="empty-icon ok"><Icon name="check-circle" size={24} /></span>
      <strong>这个任务没有净改动</strong>
      <p>{task.message}</p>
    </div>
  {:else}
    <div class="task-split" style={`--task-files:${taskFilesShown}px`} bind:clientWidth={taskSplitWidth}>
      <aside class="task-files" aria-label="任务文件">
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
        />
      </aside>
      <PaneResizer
        value={taskFilesShown}
        saved={taskFilesWidth}
        label="调整任务文件栏宽度"
        fit={(width) => fitTaskFilesWidth(width, taskSplitWidth)}
        onResize={(width) => (taskFilesWidth = width)}
        onCommit={saveTaskFilesWidth}
      />
      {#if rows.length > 0}
        <div class="task-diff">
          {#if selected && onOpenUnstaged && !multiActive}
            <!-- 聚合净差异不能直接应用：按块/行暂存要回到同一文件的真实未提交差异。 -->
            <div class="task-diff-actions">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                aria-label={`在未提交差异里按块/行暂存 ${selected.path}`}
                title="任务净差异同时含已提交内容，不能直接做块/行补丁；转到这个文件的真实未提交差异再按块/行暂存"
                onclick={() => selected && onOpenUnstaged?.(selected.path)}
              >
                <Icon name="file-diff" size={13} /><span>在未提交差异里按块/行暂存</span>
              </button>
            </div>
          {/if}
          {#if selectedRebuilt}
            <!-- 工作区重建：起点里有旧版本，工作区里是未跟踪的同名文件。行数只统计重建后的内容，
                 不暗示为纯新增；files 列表与这条单文件差异用的是同一份口径。 -->
            <p class="task-diff-note" role="note">
              这个路径在起点里有旧版本，当前是工作区重建：行数只统计重建后的文件，单文件差异按新增文件显示。
            </p>
          {/if}
          {#if !multiActive && diff?.truncated}
            <!-- 截断就如实说截断：不把只读到的一部分当成完整净差异（R7）。 -->
            <p class="task-diff-note" role="alert">{diff.summary || "这条净差异超过预览上限，只读到一部分。"}</p>
          {/if}
          {#if multiActive}
            <MultiFileDiff
              active={detailActive}
              {opened}
              rows={selectedRows}
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
              onClear={() => selected && select(selected)}
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
              asText={asTextFor !== null && asTextFor === selected?.path}
              onViewAsText={(next) => {
                asTextFor = next && selected ? selected.path : null;
                void loadSelectedDiff();
              }}
              fileNav={nav}
              fileCount={rows.length}
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
      {:else}
        <div class="empty task-placeholder" role="status">
          <span class="empty-icon"><Icon name="search" size={22} /></span>
          <strong>没有匹配“{query.trim()}”的任务文件</strong>
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => (query = "")}>清除筛选</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if fileMenu}
  <ContextMenu request={fileMenu} onClose={() => (fileMenu = null)} />
{/if}
