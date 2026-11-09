<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { api } from "../api";
  import { FULL_FILE_CONTEXT, reuseDiffContent, type HunkNavReport } from "../diff";
  import { normalizeError } from "../errors";
  import { formatAuthoredAt, shortOid } from "../history";
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
  } from "../types";
  import { fileNavState, orderedRows, sameSelection, type FileNavState } from "../ui";
  import DiffView from "./DiffView.svelte";
  import FileList from "./FileList.svelte";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";
  import MultiFileDiff from "./MultiFileDiff.svelte";
  import TaskBaselinePicker from "./TaskBaselinePicker.svelte";

  /**
   * 任务审阅主视图：一次任务从明确起点到当前工作区的最终净结果。
   *
   * 它只读：建立范围、浏览文件、看差异都走 task_review / load_task_diff，不切换分支、
   * 不写索引也不碰工作区。写入仍然只发生在现有的改动视图与提交区（T3 才接队列写入）。
   *
   * 状态只有四种，而且互斥：
   * - no-baseline：还没有明确起点，交给选择器，绝不用 HEAD 或默认分支补缺；
   * - reading：正在读取，保留上一份结果但明确标出「读取中」；
   * - ready：完整读取成功，此时才可能出现「空任务」；
   * - failed：读取失败或任务范围失效，撤下结果并给出重新读取/重新选择入口。
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
    /** 进入某个范围内提交：在提交历史里按完整标识查看它。 */
    onCommitHistory?: (oid: string) => void;
    onReadDocument?: (sources: PreviewSources, side: "old" | "new", trigger: HTMLElement | null) => void;
    onFileNav?: (nav: FileNavState | null) => void;
    onHunkNav?: (nav: HunkNavReport | null) => void;
    /** 用户在选择器里选定的起点：由外壳记录，刷新后仍然有效。 */
    onPickBaseline: (baseline: string) => void;
    /** 放弃当前起点，回到选择状态。 */
    onClearBaseline: () => void;
    paneHead?: Snippet;
    paneResizer?: Snippet;
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
    onCommitHistory,
    onReadDocument,
    onFileNav,
    onHunkNav,
    onPickBaseline,
    onClearBaseline,
    paneHead,
    paneResizer,
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
  /** 候选起点重读的触发键：范围失效后重新选择时递增。 */
  let pickerKey = $state(0);

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
  let baselineLabel = $derived(task ? shortOid(task.baselineOid) : request?.baseline ?? "");
  let headLabel = $derived(task ? shortOid(task.headOid) : "");
  let scopeKey = $derived(
    task ? `${task.worktree}|${task.baselineOid}|${task.headOid}|${task.rangeVersion}` : "",
  );

  let nav: FileNavState = $derived.by(() => {
    const items: FileRow[] = multiActive ? selectedRows : rows;
    const index = items.findIndex((row) => sameSelection(row, selected));
    return fileNavState(items, index, goToRow, multiActive ? "选中文件" : "任务文件");
  });

  $effect(() => {
    onFileNav?.(nav);
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
    // 仓库、起点请求与改动快照身份一起决定这一轮：外部变化也重读，旧响应不覆盖新选择。
    const key = `${opened.summary.path}|${request?.nonce ?? 0}|${baseline ?? ""}|${opened.snapshot}`;
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
    const baseline = request?.baseline ?? null;
    pickerKey += 1;
    if (!baseline) {
      void readTask(null);
      return;
    }
    void readTask(baseline);
  }

  function reselect(): void {
    pickerKey += 1;
    onNotice?.("请重新选择这次任务的起点。");
    // 起点由外壳保存：清掉它，任务页才会回到选择状态（刷新后也不会偷偷用回旧起点）。
    onClearBaseline();
  }

  function openCommit(oid: string): void {
    if (onCommitHistory) onCommitHistory(oid);
    else onNotice?.("这里没有提交历史的入口。");
  }
</script>

<div class="changes task-layout">
  <section class="pane files" aria-label="任务范围与文件">
    {@render paneHead?.()}
    <div class="task-context" role="group" aria-label="任务范围">
      <div class="task-context-row">
        <span class="task-kicker">任务起点</span>
        <span class="task-value task-oid" title={task?.baselineRef ?? request?.baseline ?? ""}>{baselineLabel || "未选择"}</span>
        {#if request?.origin === "cliora"}
          <span class="task-tag">来自 cliora 审查链接</span>
        {/if}
      </div>
      {#if task}
        <div class="task-context-row">
          <span class="task-kicker">当前</span>
          <span class="task-value" title={task.branch.headOid ?? ""}>{branchLabel(task.branch)}</span>
          <span class="task-value task-oid">{headLabel}</span>
        </div>
        <div class="task-context-row task-stats">
          <span class="task-kicker">范围内</span>
          <span class="task-value">{task.commitCount} 个提交</span>
          <span class="task-value">{task.filesTotal} 个文件</span>
          <LineCounts stat={{ additions: task.additions, deletions: task.deletions }} />
          {#if task.dirty}
            <span class="task-tag warn">含未提交改动</span>
          {/if}
          {#if task.untrackedFiles > 0}
            <span class="task-value">未跟踪 {task.untrackedFiles} 个</span>
          {/if}
          {#if task.conflicted}
            <span class="task-tag danger">有冲突</span>
          {/if}
        </div>
      {/if}
      {#if reading}
        <div class="task-context-row" role="status"><span class="spinner" aria-hidden="true"></span>正在读取任务范围……</div>
      {/if}
      {#if task?.filesTruncated}
        <p class="task-context-note" role="alert">{task.message}</p>
      {/if}
      {#if task && !task.empty}
        <!-- 任务净差异是只读的：这里说明它和「本次提交的暂存范围」不是同一件事（R4）。 -->
        <p class="task-context-note">任务净差异只读：不会写入暂存区，也不改变提交范围。</p>
      {/if}
    </div>

    {#if phase === "no-baseline"}
      {#if active}
        <!-- 候选只在任务视图真的可见时读取：四个视图同时保活，隐藏的视图不发起仓库读取。 -->
        <TaskBaselinePicker
          {opened}
          nextId={nextId}
          reloadKey={pickerKey}
          onPick={(baseline) => onPickBaseline(baseline)}
          onFailure={() => {}}
        />
      {/if}
    {:else if phase === "failed"}
      <div class="task-failure" role="alert">
        <strong>{invalidRange ? "任务范围已失效" : "读取任务范围失败"}</strong>
        <p>{failure?.message ?? "无法读取这次任务，仓库没有被修改。"}</p>
        <div class="task-failure-actions">
          <button type="button" class="btn btn-secondary btn-sm" onclick={reload}>重新读取</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick={reselect}>重选起点</button>
        </div>
        <p class="task-context-note">这里不会显示上一次的结果：它不是这次任务当前的净差异。</p>
      </div>
    {:else if !task}
      <div class="view-loading"><span class="spinner"></span></div>
    {:else if task}
      {#if task.empty}
        <div class="empty task-empty">
          <span class="empty-icon ok"><Icon name="check-circle" size={24} /></span>
          <strong>这个任务没有净改动</strong>
          <p>{task.message}</p>
        </div>
      {:else}
        <FileList
          variant="task"
          searchId="task-file-search"
          files={files}
          {selected}
          {selectedSet}
          {query}
          disabled={false}
          onQuery={(value) => (query = value)}
          onSelect={select}
          onMultiSelect={selectMany}
          onStage={() => {}}
          onUnstage={() => {}}
        />
        <div class="task-commits" aria-label="范围内提交">
          <div class="task-commits-head">
            <strong>范围内历史</strong>
            <span class="count">{task.commitCount}</span>
            <span class="spacer"></span>
            <span class="task-context-note">起点..HEAD</span>
          </div>
          {#if task.commits.length === 0}
            <p class="task-context-note">起点之后没有提交，改动都在索引或工作区里。</p>
          {:else}
            <ul class="task-commit-list">
              {#each task.commits as commit (commit.oid)}
                <li>
                  <button
                    type="button"
                    class="task-commit"
                    title={`${commit.authorName} · ${formatAuthoredAt(commit.authoredAt)}`}
                    onclick={() => openCommit(commit.oid)}
                  >
                    <span class="oid">{shortOid(commit.oid)}</span>
                    <span class="summary">{commit.summary}</span>
                  </button>
                </li>
              {/each}
            </ul>
            {#if task.commitsTruncated}
              <p class="task-context-note">只列出最近的 {task.commits.length} 个提交，共 {task.commitCount} 个。</p>
            {/if}
          {/if}
        </div>
      {/if}
    {/if}
  </section>
  {@render paneResizer?.()}
  {#if task && rows.length > 0}
    <div class="task-diff">
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
  {:else if task && !task.empty}
    <section class="diff dense task-placeholder" aria-label="任务净差异">
      <p>没有匹配“{query.trim()}”的任务文件。</p>
    </section>
  {:else}
    <section class="diff dense task-placeholder" aria-label="任务净差异">
      <p>选择一个任务文件，查看它从起点到工作区的最终净差异。</p>
    </section>
  {/if}
</div>
