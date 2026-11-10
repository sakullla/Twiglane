<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { FULL_FILE_CONTEXT, reuseDiffContent, type HunkNavReport } from "../diff";
  import { normalizeError } from "../errors";
  import { shortOid } from "../history";
  import { branchLabel } from "../labels";
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
    orderedRows,
    reviewQueue,
    sameSelection,
    type FileNavState,
    type ReviewQueueState,
  } from "../ui";
  import DiffView from "./DiffView.svelte";
  import FileList from "./FileList.svelte";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";
  import MultiFileDiff from "./MultiFileDiff.svelte";

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
    /** 真实暂存范围（仓库相对路径）：与任务范围分开显示。 */
    stagedPaths?: string[];
    /** 任务范围解析成功/撤下：外壳据此绑定快照 token 与进度记录。 */
    onSnapshot?: (scope: { worktree: string; baselineOid: string; headOid: string } | null) => void;
    /** 当前任务文件：命令面板的标记/暂存动作作用在这里。 */
    onSelection?: (path: string | null) => void;
    /** 未审阅队列状态：与改动视图共用同一套命令与按钮。 */
    onReviewNav?: (nav: ReviewQueueState | null) => void;
    /** 历史顶部「任务净差异」行的摘要：读取状态、文件数与净行数。 */
    onSummary?: (summary: TaskSummary) => void;
    /** 是否显示在历史详情区：选中提交时隐藏但保活，读取与选择都不丢。 */
    visible?: boolean;
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
    stageSideFor,
    writeLocked = false,
    onOpenUnstaged,
    onOpenChanges,
    stagedPaths = [],
    onSnapshot,
    onSelection,
    onReviewNav,
    onSummary,
    visible = true,
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
  let multiActive = $derived(selectedSet.length > 1);
  let selectedRows = $derived(
    selectedSet.length > 1
      ? rows.filter((row) => selectedSet.some((item) => sameSelection(item, row)))
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
    selected ? (rows.find((row) => row.path === selected?.path)?.rebuilt ?? false) : false,
  );

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
    return rows.find((row) => row.path === path) ?? null;
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

  async function readTask(baseline: string | null): Promise<void> {
    const at = ++readSerial;
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
        result = await api.taskReview(opened.summary.path, baseline, opened.generation, nextId());
      } catch (error) {
        const normalized = normalizeError(error);
        // 旧代次：收下后端给的新代次重读一次，不把一次过期请求当成任务结论。
        if (normalized.code !== "stale" || normalized.generation === undefined) throw error;
        if (at !== readSerial) return;
        onGeneration(normalized.generation);
        result = await api.taskReview(
          opened.summary.path,
          baseline,
          Math.max(normalized.generation, opened.generation),
          nextId(),
        );
      }
      if (at !== readSerial) return;
      task = result;
      phase = "ready";
      failure = null;
      invalidRange = false;
      // 范围身份交给外壳：任务快照 token 与已审阅记录都绑定这份解析结果。
      onSnapshot?.({ worktree: result.worktree, baselineOid: result.baselineOid, headOid: result.headOid });
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
      return;
    }
    if (key === readKey && wasActive) return;
    readKey = key;
    wasActive = true;
    untrack(() => void readTask(baseline));
  });

  async function loadSelectedDiff(): Promise<void> {
    const token = ++diffToken;
    const current = task;
    const choice = selected;
    if (!current || !choice || multiActive) {
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
        result = await fetchDiff(current, choice.path, row?.originalPath ?? null, 0, 0, asText);
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
    current: TaskReview,
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
    if (!current || !choice || !loaded) return;
    if (loaded.offset + loaded.lines.length >= loaded.totalLines) return;
    const token = diffToken;
    const asText = asTextFor === choice.path;
    const row = rowOf(choice.path);
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
      diff = { ...loaded, lines: [...loaded.lines, ...page.lines], offset: page.offset, totalLines: page.totalLines };
    } catch (error) {
      if (token !== diffToken) return;
      diffError = normalizeError(error).message;
    }
  }

  function reload(): void {
    void readTask(request?.baseline ?? null);
  }
</script>

<div class="task-detail" aria-label="任务净差异" style:display={visible ? null : "none"}>
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
        {#if request?.origin === "cliora"}<span class="task-tag">来自 cliora 审查链接</span>{/if}
        <span class="read-only-chip" title="任务净差异只读：不会写入暂存区，也不改变提交范围">
          <Icon name="eye" size={12} />只读
        </span>
        {#if reading}
          <span class="task-reading" role="status"><span class="spinner" aria-hidden="true"></span>正在读取任务范围……</span>
        {/if}
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

  {#if task && !task.empty}
    <!-- 真实暂存范围与任务范围分开：提交只读这一份，任务文件数不代表提交范围（R4）。 -->
    <div class="task-stage-scope" aria-label="本次提交暂存范围">
      <span class="task-kicker">本次提交</span>
      {#if stagedPaths.length === 0}
        <span class="task-value">暂存区是空的：这次提交不会包含任何任务文件</span>
      {:else}
        <span class="task-value" title={stagedPaths.join("\n")}>{stagedPaths.length} 个已暂存文件</span>
        <span class="task-tag">与任务范围分开</span>
      {/if}
      <span class="task-context-note">提交只读取真实暂存范围，这里的 {reviewTotal} 个任务文件不会自动进入提交。</span>
    </div>
  {/if}

  {#if phase === "failed"}
    <div class="empty task-failure" role="alert">
      <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
      <strong>{invalidRange ? "任务范围已失效" : "读取任务范围失败"}</strong>
      <p>{failure?.message ?? "无法读取这次任务，仓库没有被修改。"}</p>
      <p class="task-context-note">这里不会显示上一次的结果：它不是这次任务当前的净差异。</p>
      <button type="button" class="btn btn-secondary btn-sm" onclick={reload}>重新读取</button>
    </div>
  {:else if phase === "no-baseline"}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="layers" size={22} /></span>
      <strong>没有任务范围</strong>
      <p>cliora 审查链接没有携带起点，这里不会用 HEAD 或默认分支代替。</p>
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
    <div class="task-split">
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
              {active}
              {opened}
              rows={selectedRows}
              focus={selected}
              {nav}
              disabled={false}
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
              onFocus={focusBlock}
              onStale={onGeneration}
              onStageHunk={() => {}}
              onFullFile={onFullFile}
              onFileHistory={(path) => onFileHistory?.(path)}
              onReadDocument={onReadDocument}
              onStage={() => {}}
              onUnstage={() => {}}
              onDiscard={() => {}}
              onClear={() => selected && select(selected)}
            />
          {:else}
            <DiffView
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
              asText={asTextFor !== null && asTextFor === selected?.path}
              onViewAsText={(next) => {
                asTextFor = next && selected ? selected.path : null;
                void loadSelectedDiff();
              }}
              fileNav={nav}
              fileCount={rows.length}
              onRetry={() => void loadSelectedDiff()}
              onHunkNav={onHunkNav}
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
