<script module lang="ts">
  import type { ConflictDraft } from "../conflict";

  /**
   * 逐处处理的草稿在模块级保存：关掉合并 modal、切换文件再回来都不会丢。
   * 键是「仓库路径 + 文件路径」，恢复时由 ConflictResolver 校验工作区内容未变，
   * 外部改过文件或已经写入后，旧草稿自动作废。只在内存里，不落盘。
   */
  const conflictDrafts = new Map<string, ConflictDraft>();
  const conflictProgress = new Map<string, { total: number; done: number }>();
  /** 为了合并到别的分支而切换过来时，记住原来所在的分支（按仓库），完成后提供「切回」。 */
  const switchedFromByRepo = new Map<string, string>();
  /** 冲突处理期间填写的合并说明（按仓库），关掉 modal 再回来不丢。 */
  const messageByRepo = new Map<string, string>();

  export function clearConflictDrafts(): void {
    conflictDrafts.clear();
    conflictProgress.clear();
  }

  /**
   * 沿方向在冲突文件环上找下一个有未处理内容的文件。按环走：跳过的文件转一圈还会回来，
   * 不会有未处理的文件被甩在身后；除当前文件外都不需要处理时返回 null。
   */
  export function adjacentPendingFile(
    paths: readonly string[],
    here: string,
    direction: 1 | -1,
    pending: (path: string) => boolean,
  ): string | null {
    const count = paths.length;
    const start = paths.indexOf(here);
    const origin = start === -1 && direction === -1 ? 0 : start;
    for (let step = 1; step <= count; step += 1) {
      const path = paths[(((origin + direction * step) % count) + count) % count];
      if (path !== here && pending(path)) return path;
    }
    return null;
  }

  export function defaultMergeMessage(source: string, target: string, remote: boolean): string {
    if (!source || !target) return "";
    return remote ? `Merge remote-tracking branch '${source}' into ${target}` : `Merge branch '${source}' into ${target}`;
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { portal } from "../portal";
  import { visibleRange, scrollIndexIntoView } from "../layout";
  import { shortOid } from "../history";
  import { canCompleteMerge, conflictKindLabel, operationCaption, showMergeAbort } from "../resolve";
  import type {
    BranchRecord,
    ConflictView,
    MergePreview,
    MergeSession,
    OpenedRepository,
    StatusSnapshot,
  } from "../types";
  import { BUSY_REASON, splitPath } from "../ui";
  import ConflictResolver from "./ConflictResolver.svelte";
  import Icon from "./Icon.svelte";
  import MergeSetup, { type MergeMode } from "./MergeSetup.svelte";
  import Modal from "./Modal.svelte";
  import ThreeWayMerge from "./ThreeWayMerge.svelte";
  import { detectEol, keepBothSides } from "../conflict";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
    /** 预选的来源分支（从分支菜单「合并到当前分支」进入）。 */
    initialSource?: string | null;
    /** 预选的目标分支（从分支菜单「把当前分支合并到此分支」进入）。 */
    initialTarget?: string | null;
    /** 打开时的方式。分叉拉取用设置里的预选；分支菜单「变基」固定为 rebase。 */
    initialMode?: MergeMode | null;
    disabled: boolean;
    nextId: () => number;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
    onOpenHistory?: () => void;
    /** 作为任务 modal 的内容时不再自带整页面板外框。 */
    embedded?: boolean;
    /** 路由与中止的落点：任务 modal 把它们并入标题行，不再多占一条工具行。 */
    headTarget?: HTMLElement | null;
    /** 提供时在底部操作条放一个「关闭」，与主操作同一行。 */
    onClose?: () => void;
    /** 设置里的分支分组，传给合并方向的分支选择器。 */
    branchGroups?: boolean;
  }

  let {
    opened,
    focusPath = null,
    initialSource = null,
    initialTarget = null,
    initialMode = null,
    disabled,
    nextId,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
    onOpenHistory,
    embedded = false,
    headTarget = null,
    onClose,
    branchGroups = true,
  }: Props = $props();

  interface Finished {
    source: string;
    target: string;
    fastForwarded: boolean;
    rebased: boolean;
    oid: string | null;
    commits: number;
    switchedFrom: string | null;
  }

  let session = $state.raw<MergeSession | null>(null);
  let branches = $state<BranchRecord[]>([]);
  let source = $state(untrack(() => initialSource ?? ""));
  let target = $state(untrack(() => initialTarget ?? ""));
  let mode = $state<MergeMode>(untrack(() => initialMode ?? "merge"));
  let confirmingRebase = $state(false);
  let setupMessage = $state("");
  let messageTouched = $state(false);
  let preview = $state<MergePreview | null>(null);
  let previewing = $state(false);
  let previewError = $state<string | null>(null);
  let previewNonce = $state(0);
  /** 分支名到提交 oid。分支列表不带 oid，由历史首页的引用标注得出，不在首页的分支没有记录。 */
  let branchTips = $state<Record<string, string>>({});
  let finished = $state<Finished | null>(null);
  let view = $state<ConflictView | null>(null);
  let resultText = $state("");
  let message = $state(untrack(() => messageByRepo.get(opened.summary.path) ?? ""));
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let aborting = $state(false);
  let abortNote = $state("");
  let abortPaths = $state<string[]>([]);
  let resolvedPaths = $state<string[]>([]);
  let fileFilter = $state("");
  let progressTick = $state(0);
  let loadedKey = "";
  let loadedRepo = "";
  let openedFocus = "";
  let autoOpenedKey = "";
  let previewToken = 0;
  /** 上一次预检成功时的仓库状态；与当前状态相同说明结论仍然成立。 */
  let previewedState = "";
  /** session 与 branchTips 同时读到的 generation；不一致时为 0。 */
  let factsGeneration = 0;
  let footFile = $state<HTMLDivElement | null>(null);

  let blocked = $derived(disabled || busy);
  let current = $derived(opened.snapshot.branch.detached || opened.snapshot.branch.unborn ? null : opened.snapshot.branch.name);
  let active = $derived(
    session?.operation === "merge" ||
      session?.operation === "unmerged" ||
      session?.operation === "rebase" ||
      session?.operation === "cherry-pick",
  );
  /** 合并进行中：头部和底部都收成一条细条，把高度让给冲突内容。 */
  let strip = $derived(Boolean(session && active));
  let external = $derived(Boolean(session && session.operation !== "none" && !active));
  let conflictTotal = $derived((session?.unresolved ?? 0) + resolvedPaths.length);
  let resolvedPercent = $derived(conflictTotal > 0 ? Math.round((resolvedPaths.length / conflictTotal) * 100) : 0);
  let currentLabel = $derived(session?.target ?? opened.snapshot.branch.name ?? "当前分支");
  let incomingLabel = $derived(session?.source ?? (session?.operation === "unmerged" ? "另一侧" : "来源分支"));
  let filteredConflicts = $derived(
    (session?.conflicts ?? []).filter((entry) => entry.path.toLowerCase().includes(fileFilter.trim().toLowerCase())),
  );
  const CONFLICT_ROW_HEIGHT = 60;
  let conflictList = $state<HTMLDivElement | null>(null);
  let conflictScroll = $state(0);
  let conflictViewport = $state(0);
  let conflictRows = $derived([
    ...filteredConflicts.map((entry) => ({ path: entry.path, entry })),
    ...resolvedPaths.map((path) => ({ path, entry: null })),
  ]);
  let conflictRange = $derived(visibleRange(conflictRows.length, conflictScroll, conflictViewport || 480, CONFLICT_ROW_HEIGHT));
  let visibleConflicts = $derived(conflictRows.slice(conflictRange.start, conflictRange.end));
  $effect(() => {
    void fileFilter;
    conflictScroll = 0;
    if (conflictList) conflictList.scrollTop = 0;
  });
  $effect(() => {
    const path = view?.path;
    if (!path || !conflictList) return;
    const index = conflictRows.findIndex((row) => row.path === path);
    untrack(() => {
      conflictScroll = scrollIndexIntoView(index, conflictScroll, conflictViewport || 480, CONFLICT_ROW_HEIGHT);
      if (conflictList) conflictList.scrollTop = conflictScroll;
    });
  });
  let operation = $derived(session?.operation ?? null);
  /** 预检依赖的实际仓库状态。generation 推进但它不变时不重新检查：预检不能触发自己。 */
  let repoState = $derived.by(() => {
    const snapshot = session?.snapshot;
    if (!snapshot) return "";
    const tracked = snapshot.files.filter((file) => !file.untracked).map((file) => `${file.path}:${file.staged}:${file.unstaged}`);
    return JSON.stringify([
      opened.summary.path,
      snapshot.branch.name,
      snapshot.branch.headOid,
      branchTips[source.trim()] ?? null,
      branchTips[target.trim()] ?? null,
      tracked,
    ]);
  });
  let sourceRemote = $derived(branches.find((branch) => branch.name === source)?.remote ?? false);
  let readyPreview = $derived(preview && preview.source === source && preview.target === target ? preview : null);
  let switchedFrom = $derived.by(() => {
    void progressTick;
    return switchedFromByRepo.get(opened.summary.path) ?? null;
  });

  /** 跨文件跳转打开的文件落在哪一处；用户直接点开时为 null。 */
  let entry = $state<"first" | "last" | null>(null);
  /** 跳到不能逐处处理的文件后，焦点交给编辑区，F7 和按钮都还能继续走。 */
  let landOnEditor = $state(false);
  let editorHost = $state<HTMLDivElement | null>(null);
  let conflictPaths = $derived((session?.conflicts ?? []).map((item) => item.path));
  let fileIndex = $derived(resolvedPaths.length + Math.max(0, conflictPaths.indexOf(view?.path ?? "")) + 1);
  let pendingElsewhere = $derived(conflictPaths.filter((path) => path !== view?.path && filePending(path)).length);

  function draftKey(path: string): string {
    return `${opened.summary.path}\u0000${path}`;
  }

  function fileProgress(path: string): { total: number; done: number } | null {
    void progressTick;
    return conflictProgress.get(draftKey(path)) ?? null;
  }

  /** 没打开过、没有逐处结构（二进制、整文件编辑）或还有未选的一处，都算未处理。 */
  function filePending(path: string): boolean {
    const progress = fileProgress(path);
    return !progress || progress.total === 0 || progress.done < progress.total;
  }

  $effect(() => {
    if (!landOnEditor || blocked || !view || view.editable) return;
    landOnEditor = false;
    editorHost?.focus({ preventScroll: true });
  });

  /** 当前文件这个方向走完了：切到下一个有未处理内容的文件；没有时说明还差什么，不空转。 */
  function leaveFile(direction: 1 | -1, stay = false): boolean {
    const state = session;
    const here = view;
    if (!state || !here) return false;
    if (blocked) return true;
    const target = adjacentPendingFile(conflictPaths, here.path, direction, filePending);
    if (target) {
      openConflict(target, direction === 1 ? "first" : "last");
      return true;
    }
    if (stay) return false;
    const left = state.unresolved;
    const finish = state.operation === "rebase" ? "继续变基" : state.operation === "cherry-pick" ? "继续拣选" : "完成合并";
    onNotice(
      filePending(here.path)
        ? `没有其他未处理的文件。明确标记这个文件后可以${finish}。`
        : left > 1
          ? `全部冲突都已处理，把这 ${left} 个文件标记为已解决后可以${finish}。`
          : `全部冲突都已处理，标记这个文件后可以${finish}。`,
    );
    return false;
  }

  function onEditorKey(event: KeyboardEvent) {
    if (!view || view.editable) return;
    const down = (event.altKey && event.key === "ArrowDown") || (event.key === "F7" && !event.shiftKey);
    const up = (event.altKey && event.key === "ArrowUp") || (event.key === "F7" && event.shiftKey);
    if (!down && !up) return;
    if ((event.target as HTMLElement).closest("input")) return;
    event.preventDefault();
    leaveFile(down ? 1 : -1);
  }

  $effect(() => {
    const key = `${opened.summary.path}:${opened.generation}`;
    if (key === loadedKey) return;
    loadedKey = key;
    void loadSession();
  });

  /** 没有预选时的默认方向：用主干更新当前分支（最常见），否则选第一个其他本地分支。 */
  function defaultSource(listed: BranchRecord[], into: string | null): string {
    const local = listed.filter((branch) => !branch.remote && branch.name !== into);
    const base = ["main", "master", "develop", "dev", "trunk"].find((name) => local.some((branch) => branch.name === name));
    return base ?? local[0]?.name ?? listed.find((branch) => branch.name !== into && !branch.name.endsWith("/HEAD"))?.name ?? "";
  }

  async function loadSession() {
    const repo = opened.summary.path;
    const generation = opened.generation;
    const key = `${repo}:${generation}`;
    errorText = null;
    if (loadedRepo !== opened.summary.path) {
      loadedRepo = opened.summary.path;
      resolvedPaths = [];
      view = null;
    }
    try {
      const [next, listed] = await Promise.all([
        api.mergeSession(repo, generation, nextId()),
        api.branchState(repo, generation, nextId()),
      ]);
      if (loadedKey !== key || opened.summary.path !== repo) return;
      session = next;
      branches = listed.branches;
      branchTips = Object.fromEntries(listed.branches.filter((branch) => branch.targetOid).map((branch) => [branch.name, branch.targetOid!]));
      factsGeneration = listed.generation === next.generation ? next.generation : 0;
      onGeneration(next.generation);
      const here = next.snapshot.branch.detached || next.snapshot.branch.unborn ? null : next.snapshot.branch.name;
      if (!target) target = here ?? listed.branches.find((branch) => !branch.remote)?.name ?? "";
      if (!source) {
        source = initialTarget && here && here !== target ? here : defaultSource(listed.branches, target);
      }
      if (!message && next.operation === "merge") {
        message = next.source && next.target ? defaultMergeMessage(next.source, next.target, next.source.includes("/")) : "合并分支";
      }
    } catch (error) {
      if (loadedKey !== key || opened.summary.path !== repo) return;
      const failure = normalizeError(error);
      // 过期只说明这次读取落后了：新 generation 会再读一次，不算失败。
      if (failure.code === "stale" && failure.generation !== undefined) {
        onGeneration(failure.generation);
        return;
      }
      errorText = failure.message;
      onFailure(failure);
    }
  }

  async function run(action: () => Promise<void>) {
    if (blocked) return;
    busy = true;
    errorText = null;
    try {
      await action();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  // 两端选定后自动做只读检查（防抖），不需要用户再点「检查」。
  // 只依赖分支、手动重新检查和 repoState，不读 generation：Git 为预检写入内部对象时，
  // generation 可能被推进，跟着重跑就成了循环。旧结果保留到新结果到达。
  $effect(() => {
    const from = source.trim();
    const into = target.trim();
    const state = repoState;
    void previewNonce;
    const token = ++previewToken;
    if (!state || operation !== "none" || finished || !from || !into) {
      previewing = false;
      return;
    }
    previewing = true;
    previewError = null;
    const timer = setTimeout(() => void runPreview(from, into, state, token), 180);
    return () => clearTimeout(timer);
  });

  async function runPreview(from: string, into: string, state: string, token: number) {
    const repo = opened.summary.path;
    const ask = (generation: number) => api.mergePreview(repo, from, into === current ? null : into, generation, nextId());
    try {
      let result: MergePreview;
      try {
        result = await ask(opened.generation);
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code !== "stale" || failure.generation === undefined) throw failure;
        if (token !== previewToken) return;
        // 同一轮检查换新 generation 重试一次，不重走防抖，界面不多闪一轮。
        onGeneration(failure.generation);
        result = await ask(failure.generation);
      }
      if (token !== previewToken) return;
      preview = result;
      previewedState = state;
      if (result.generation > opened.generation) onGeneration(result.generation);
      if (mode === "ff-only" && !result.fastForward) mode = "merge";
    } catch (error) {
      if (token !== previewToken) return;
      const failure = normalizeError(error);
      if (failure.code === "stale") {
        // 重试后仍然过期：不再自动重来。有旧结果就留着，开始时由 generation 校验拦截。
        if (failure.generation !== undefined) onGeneration(failure.generation);
        if (!readyPreview) previewError = "仓库正在变化，这次没有完成检查。";
        return;
      }
      preview = null;
      previewError = failure.message;
    } finally {
      if (token === previewToken) previewing = false;
    }
  }

  /** 预检结论是否在较新的 generation 上仍然成立：依据没变，且两端分支的位置都确实读到了。 */
  function startGeneration(checked: MergePreview): number {
    const located = (name: string) => name === current || branchTips[name] !== undefined;
    const unchanged = previewedState === repoState && located(checked.source) && located(checked.target);
    return unchanged ? Math.max(checked.generation, factsGeneration) : checked.generation;
  }

  $effect(() => {
    if (messageTouched) return;
    setupMessage = defaultMergeMessage(source, target, sourceRemote);
  });

  function setSource(value: string) {
    source = value;
    preview = null;
  }

  function setTarget(value: string) {
    target = value;
    preview = null;
  }

  function swap() {
    if (sourceRemote) return;
    const from = source;
    source = target;
    target = from;
    preview = null;
  }

  function pick(from: string, into: string) {
    source = from;
    target = into;
    preview = null;
  }

  /**
   * 实际执行的方式。快进不是让用户挑的选项，而是仓库状态的结论：目标上没有来源缺少的提交时
   * 只能快进（合并或变基都没有意义），分叉时快进不可能，只在合并与变基里选。
   */
  let effectiveMode = $derived<MergeMode>(readyPreview?.fastForward ? "ff-only" : mode === "ff-only" ? "merge" : mode);

  function confirmStart() {
    if (!readyPreview?.canStart) return;
    if (effectiveMode === "rebase") {
      if (target !== current) return;
      confirmingRebase = true;
      return;
    }
    void beginIntegration();
  }

  function beginIntegration() {
    const checked = readyPreview;
    if (!checked?.canStart) return;
    const chosenMode: MergeMode = checked.fastForward ? "ff-only" : mode === "rebase" ? "rebase" : "merge";
    if (chosenMode === "rebase" && target !== current) return;
    confirmingRebase = false;
    const repo = opened.summary.path;
    const note = setupMessage.trim() || defaultMergeMessage(checked.source, checked.target, sourceRemote);
    void run(async () => {
      const started = await api
        .startMerge(
          repo,
          checked.source,
          chosenMode === "rebase" ? null : checked.needsSwitch ? checked.target : null,
          chosenMode,
          startGeneration(checked),
          nextId(),
        )
        .catch((error: unknown) => {
          // 写入前被 generation 校验拦下：结论已不可信，按最新状态重新检查。
          if (normalizeError(error).code === "stale") previewNonce += 1;
          throw error;
        });
      if (started.switchedFrom) {
        switchedFromByRepo.set(repo, started.switchedFrom);
        progressTick += 1;
      }
      onSnapshot(started.snapshot);
      resolvedPaths = [];
      view = null;
      preview = null;
      if (started.rebased) {
        session = started;
        finished = {
          source: checked.source,
          target: checked.target,
          fastForwarded: false,
          rebased: true,
          oid: started.snapshot.branch.headOid,
          commits: checked.incoming,
          switchedFrom: null,
        };
        onNotice("已把当前分支上尚未进入基底的提交接到基底顶端。没有推送。");
        return;
      }
      if (started.fastForwarded) {
        session = started;
        finished = {
          source: checked.source,
          target: checked.target,
          fastForwarded: true,
          rebased: false,
          oid: started.snapshot.branch.headOid,
          commits: checked.incoming,
          switchedFrom: started.switchedFrom ?? null,
        };
        onNotice(`已把 ${checked.target} 快进到 ${checked.source}。`);
        return;
      }
      if (started.operation === "merge" && started.unresolved === 0) {
        const done = await api.completeMerge(repo, note, started.generation, nextId());
        onSnapshot(done.snapshot);
        session = await api.mergeSession(repo, done.generation, nextId());
        finished = {
          source: checked.source,
          target: checked.target,
          fastForwarded: false,
          rebased: false,
          oid: done.oid,
          commits: checked.incoming,
          switchedFrom: started.switchedFrom ?? null,
        };
        onNotice(done.summary);
        return;
      }
      message = note;
      messageByRepo.set(repo, note);
      session = started;
      onNotice(started.note);
    });
  }

  function switchBack() {
    const back = switchedFrom;
    if (!back) return;
    const repo = opened.summary.path;
    void run(async () => {
      const state = await api.switchBranch(repo, back, opened.generation, nextId());
      switchedFromByRepo.delete(repo);
      progressTick += 1;
      onSnapshot(state.snapshot);
      onNotice(`已切回 ${back}。`);
      if (finished) finished = { ...finished, switchedFrom: null };
    });
  }

  function startOver() {
    finished = null;
    preview = null;
    messageTouched = false;
    source = defaultSource(branches, current);
    target = current ?? target;
  }

  function openConflict(path: string, landing: "first" | "last" | null = null) {
    const state = session;
    if (!state) return;
    if (view?.path === path) return;
    void run(async () => {
      const next = await api.conflictView(opened.summary.path, path, state.generation, nextId());
      entry = landing;
      landOnEditor = landing !== null;
      view = next;
      resultText = next.result.text ?? "";
      onGeneration(next.generation);
    });
  }

  $effect(() => {
    const path = focusPath;
    const state = session;
    if (!path || !state) return;
    if (state.operation !== "merge" && state.operation !== "unmerged" && state.operation !== "rebase" && state.operation !== "cherry-pick") return;
    const key = `${state.generation}:${path}`;
    if (openedFocus === key) return;
    if (!state.conflicts.some((entry) => entry.path === path)) return;
    openedFocus = key;
    openConflict(path);
  });

  $effect(() => {
    const state = session;
    if (!state || view || busy) return;
    const first = state.conflicts[0];
    if (!first) return;
    const key = `${opened.summary.path}:${state.generation}:${first.path}`;
    if (autoOpenedKey === key) return;
    autoOpenedKey = key;
    openConflict(first.path);
  });

  function applyTextChoice(choice: "ours" | "theirs" | "both") {
    if (!view?.editable) return;
    const ours = view.ours.text ?? "";
    const theirs = view.theirs.text ?? "";
    if (choice === "ours") resultText = ours;
    else if (choice === "theirs") resultText = theirs;
    else resultText = keepBothSides(ours, theirs, detectEol(view.result.text, ours, theirs));
  }

  function storeDraft(path: string, draft: ConflictDraft, progress: { total: number; done: number }) {
    const key = draftKey(path);
    conflictDrafts.set(key, draft);
    const previous = conflictProgress.get(key);
    if (previous?.total !== progress.total || previous?.done !== progress.done) {
      conflictProgress.set(key, progress);
      progressTick += 1;
    }
  }

  function resolve(choice: string, content?: string) {
    const state = session;
    const selected = view;
    if (!state || !selected) return;
    const text = choice === "text" ? (content ?? resultText) : null;
    void run(async () => {
      const next = await api.resolveConflict(opened.summary.path, selected.path, choice, text, state.generation, nextId());
      session = next;
      const stillConflicted = next.conflicts.some((entry) => entry.path === selected.path);
      if (!stillConflicted) {
        resolvedPaths = [...new Set([...resolvedPaths, selected.path])];
        conflictDrafts.delete(draftKey(selected.path));
        conflictProgress.delete(draftKey(selected.path));
        progressTick += 1;
      }
      onSnapshot(next.snapshot);
      if (stillConflicted) {
        view = selected;
      } else if (next.conflicts[0]) {
        const nextView = await api.conflictView(opened.summary.path, next.conflicts[0].path, next.generation, nextId());
        entry = "first";
        landOnEditor = true;
        view = nextView;
        resultText = nextView.result.text ?? "";
        onGeneration(nextView.generation);
        onNotice(`${selected.path} 已标记为已解决，已打开下一个冲突文件。`);
      } else {
        view = null;
        onNotice(`${selected.path} 已标记为已解决，所有冲突文件均已处理。`);
      }
    });
  }

  function complete() {
    const state = session;
    if (!state || !canCompleteMerge(state.operation, state.unresolved)) return;
    const kept = message;
    const repo = opened.summary.path;
    const from = state.source ?? incomingLabel;
    const into = state.target ?? currentLabel;
    const count = conflictTotal;
    const rebasing = state.operation === "rebase";
    void run(async () => {
      try {
        const done = await api.completeMerge(repo, kept, state.generation, nextId());
        message = "";
        messageByRepo.delete(repo);
        resolvedPaths = [];
        onSnapshot(done.snapshot);
        onNotice(done.summary);
        session = await api.mergeSession(repo, done.generation, nextId());
        view = null;
        finished = {
          source: from,
          target: into,
          fastForwarded: false,
          rebased: rebasing,
          oid: done.oid,
          commits: count,
          switchedFrom: switchedFromByRepo.get(repo) ?? null,
        };
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code === "sequencer_paused" || failure.code === "conflicts_open") {
          const generation = failure.generation ?? state.generation;
          if (failure.generation !== undefined) onGeneration(failure.generation);
          session = await api.mergeSession(repo, generation, nextId());
          view = null;
        }
        throw error;
      }
    });
  }

  function abortLabel(operation: string): string {
    if (operation === "rebase") return "中止变基";
    if (operation === "cherry-pick") return "中止拣选";
    return "中止合并";
  }

  function continueLabel(operation: string): string {
    if (operation === "rebase") return "继续变基";
    if (operation === "cherry-pick") return "继续拣选";
    return "完成合并";
  }

  function askAbort() {
    const state = session;
    if (!state || !showMergeAbort(state.operation, state.canAbort)) return;
    void run(async () => {
      const impact = await api.abortMerge(opened.summary.path, false, state.generation, nextId());
      abortNote = impact.note;
      abortPaths = impact.paths;
      aborting = true;
      onGeneration(impact.generation);
      if (session) session = { ...session, generation: impact.generation };
    });
  }

  function confirmAbort() {
    const state = session;
    if (!state) return;
    const repo = opened.summary.path;
    void run(async () => {
      const impact = await api.abortMerge(repo, true, state.generation, nextId());
      aborting = false;
      resolvedPaths = [];
      messageByRepo.delete(repo);
      message = "";
      for (const path of impact.paths) {
        conflictDrafts.delete(draftKey(path));
        conflictProgress.delete(draftKey(path));
      }
      onSnapshot(impact.snapshot);
      onNotice(impact.note);
      session = await api.mergeSession(repo, impact.generation, nextId());
      view = null;
      preview = null;
    });
  }

  function primaryLabel(checked: MergePreview | null): string {
    if (effectiveMode === "rebase") return "变基并改写当前分支";
    if (!checked) return "合并";
    if (!checked.canStart) return "合并";
    if (checked.fastForward) return `快进 ${checked.target}`;
    if (checked.conflictCheck === "conflicts") return "开始合并并解决冲突";
    return `合并到 ${checked.target}`;
  }
</script>

<section class={`merge-panel ${embedded ? "embedded" : "span-main"}`} aria-label="分支合并" data-panel="merge">
  <!-- 搬走的必须是这个常驻节点：Svelte 销毁 {#if} 分支时沿分支首节点的 nextSibling 走，
       分支首尾节点被搬走后遍历中断，后面的节点会残留。 -->
  <div class="mp-head-host" use:portal={headTarget}>
    {#if session && active}
      <div class="mp-head">
        <span class="merge-route" title={`把 ${incomingLabel} 合并到 ${currentLabel}`}>
          <span class="merge-route-branch source"><Icon name="branch" size={12} /><span class="truncate">{incomingLabel}</span></span>
          <span class="merge-route-arrow"><Icon name="arrow-right" size={14} /></span>
          <span class="merge-route-branch target"><Icon name="branch" size={12} /><span class="truncate">{currentLabel}</span></span>
        </span>
        {#if session.operation === "unmerged"}
          <span class="mp-note truncate" title={session.note}>{session.note}</span>
        {:else if session.operation === "rebase"}
          <span class="mp-note truncate" title="变基冲突中，当前一侧是基底，来源一侧是正在改写的提交。">变基冲突中，当前一侧是基底，来源一侧是正在改写的提交。</span>
        {/if}
        <span class="spacer"></span>
        {#if showMergeAbort(session.operation, session.canAbort)}
          <button type="button" class="btn btn-danger-soft btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={askAbort}><Icon name="x" size={14} />{abortLabel(session.operation)}</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if session && active}
    <!-- 只监听 F7、Alt+↑↓ 冒泡：二进制这类文件没有冲突流，导航键在这里接住。 -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="mp-body" onkeydown={onEditorKey}>
      <aside class="conflict-sidebar" aria-label="冲突文件列表">
        <div class="conflict-sidebar-head">
          <span>冲突文件</span>
          {#if session.unresolved > 0}<span class="count danger" title="未解决冲突">{session.unresolved}</span>{/if}
        </div>
        {#if resolvedPaths.length > 0}
          <div
            class="merge-progress"
            role="progressbar"
            aria-label="冲突处理进度"
            aria-valuemin={0}
            aria-valuemax={conflictTotal}
            aria-valuenow={resolvedPaths.length}
          >
            <span style={`width:${resolvedPercent}%`}></span>
          </div>
        {/if}
        {#if session.conflicts.length > 6}
          <div class="conflict-filter">
            <div class="field sm">
              <Icon name="search" size={13} />
              <input aria-label="筛选冲突文件" placeholder="筛选文件" autocomplete="off" spellcheck="false" bind:value={fileFilter} />
            </div>
          </div>
        {/if}
        <div class="conflict-files" bind:this={conflictList} bind:clientHeight={conflictViewport} onscroll={() => (conflictScroll = conflictList?.scrollTop ?? 0)}>
          <div style={`height:${conflictRows.length * CONFLICT_ROW_HEIGHT}px;position:relative`}>
          {#each visibleConflicts as row, offset (row.path)}
            <div style={`position:absolute;top:${(conflictRange.start + offset) * CONFLICT_ROW_HEIGHT}px;left:0;right:0;height:56px`}>
            {#if row.entry}
            {@const entry = row.entry}
            {@const parts = splitPath(entry.path)}
            {@const progress = fileProgress(entry.path)}
            <button
              type="button"
              class="conflict-file"
              style="height:56px"
              aria-label={`${conflictKindLabel(entry.kind)} ${entry.path}`}
              aria-pressed={view?.path === entry.path}
              disabled={blocked}
              title={entry.path}
              onclick={() => openConflict(entry.path)}
            >
              <span class="conflict-file-icon"><Icon name="alert" size={13} /></span>
              <span class="conflict-file-copy">
                <strong>{parts.name}</strong>
                <small>{parts.dir || conflictKindLabel(entry.kind)}</small>
              </span>
              {#if progress && progress.total > 0}
                <span class="conflict-file-progress" class:ok={progress.done === progress.total} title={`已处理 ${progress.done} / ${progress.total} 处`}>
                  {progress.done}/{progress.total}
                </span>
              {/if}
            </button>
            {:else}
              {@const parts = splitPath(row.path)}
              <div class="conflict-file resolved" style="height:56px" title={row.path}>
                <span class="conflict-file-icon"><Icon name="check-circle" size={13} /></span>
                <span class="conflict-file-copy"><strong>{parts.name}</strong><small>{parts.dir || "已标记"}</small></span>
                <span class="chip current">已标记</span>
              </div>
            {/if}
            </div>
          {/each}
          </div>
          {#if filteredConflicts.length === 0 && session.conflicts.length > 0}
            <p class="hint conflict-empty-note">没有匹配的冲突文件。</p>
          {/if}
        </div>
        {#if session.conflicts.length === 0 && resolvedPaths.length === 0}<p class="hint conflict-empty-note">没有待处理的冲突文件。</p>{/if}
      </aside>

      <div class="conflict-editor" tabindex="-1" bind:this={editorHost}>
        {#if view}
          {#if view.editable}
            {#key `${view.path}:${view.generation}`}
              <ConflictResolver
                {view}
                {currentLabel}
                {incomingLabel}
                draft={conflictDrafts.get(draftKey(view.path)) ?? null}
                disabled={blocked}
                onDraft={(draft, progress) => view && storeDraft(view.path, draft, progress)}
                onResolve={resolve}
                footTarget={footFile}
                {entry}
                {fileIndex}
                fileTotal={conflictTotal}
                {pendingElsewhere}
                onExhausted={leaveFile}
              >
                {#snippet lead()}
                  {#if view}
                    <div class="cr-file">
                      <h2 class="truncate mono" title={`${view.path}\n${view.note}`}>{splitPath(view.path).name}</h2>
                      <span class="chip">{conflictKindLabel(view.kind)}</span>
                    </div>
                  {/if}
                {/snippet}
              </ConflictResolver>
            {/key}
          {:else}
            <div class="conflict-editor-head">
              <span class="conflict-editor-icon"><Icon name="file-diff" size={15} /></span>
              <div class="conflict-editor-titles">
                <h2 class="truncate mono" title={view.path}>{view.path}</h2>
                <p class="conflict-editor-note truncate" title={view.note}>{view.note}</p>
              </div>
              <span class="chip">{conflictKindLabel(view.kind)}</span>
            </div>
            <div class="conflict-sides">
              <ThreeWayMerge
                {view}
                {resultText}
                {currentLabel}
                {incomingLabel}
                disabled={blocked}
                onResult={(value) => (resultText = value)}
                onChoice={applyTextChoice}
                onResolve={resolve}
                onReset={() => (resultText = view?.result.text ?? "")}
              />
            </div>
          {/if}
        {:else}
          <div class="empty conflict-picker-empty">
            <span class={`empty-icon ${session.unresolved === 0 ? "ok" : ""}`}><Icon name={session.unresolved === 0 ? "check-circle" : "file-diff"} size={23} /></span>
            <strong>{session.unresolved === 0 ? "所有冲突都已标记" : "选择一个冲突文件"}</strong>
            <p>
              {#if session.unresolved === 0}
                {#if session.operation === "rebase"}
                  检查无误后，在下方继续变基。继续只改写当前分支，不会推送，也不能跳过。
                {:else if session.operation === "cherry-pick"}
                  检查无误后，在下方继续拣选。不会推送，也不能跳过。
                {:else}
                  检查无误后，在下方填写说明并完成合并。完成只在本地提交，不会推送。
                {/if}
              {:else}
                从左侧选择文件，逐处对照两边的版本，再决定最终结果。
                {#if session.operation === "rebase"}变基冲突中，当前一侧是基底，来源一侧是正在改写的提交。{/if}
              {/if}
            </p>
          </div>
        {/if}
      </div>
    </div>
  {:else if finished}
    <div class="panel-scroll mp-scroll">
      <div class="merge-done" role="status">
        <span class="merge-done-icon"><Icon name="check" size={28} stroke={2.4} /></span>
        <h2>{finished.rebased ? `已把 ${finished.target} 接到 ${finished.source} 顶端` : finished.fastForwarded ? `已把 ${finished.target} 快进到 ${finished.source}` : `已把 ${finished.source} 合并到 ${finished.target}`}</h2>
        <p>
          {#if finished.rebased}
            当前分支已被改写。远程不变，没有推送。
          {:else if finished.fastForwarded}没有创建合并提交，{finished.target} 现在指向 {finished.oid ? shortOid(finished.oid) : "来源的最新提交"}。结果只在本地，尚未推送。
          {:else}已创建合并提交{#if finished.oid}<code>{shortOid(finished.oid)}</code>{/if}。结果只在本地，尚未推送。{/if}
        </p>
        <div class="merge-done-actions">
          {#if finished.switchedFrom}
            <button type="button" class="btn btn-secondary" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={switchBack}><Icon name="arrow-left" size={14} />切回 {finished.switchedFrom}</button>
          {/if}
          {#if onOpenHistory}<button type="button" class="btn btn-secondary" onclick={onOpenHistory}><Icon name="history" size={14} />查看提交历史</button>{/if}
          <button type="button" class="btn btn-ghost" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={startOver}><Icon name="merge" size={14} />再合并一次</button>
        </div>
      </div>
    </div>
  {:else if external && session}
    <div class="panel-scroll mp-scroll">
      <div class="merge-external">
        <div class="callout warn merge-operation-note"><Icon name="alert" size={15} /><span><strong>{operationCaption(session.operation)}</strong>　{session.note}</span></div>
      </div>
    </div>
  {:else}
    <div class="panel-scroll mp-scroll">
      {#if session?.operation === "none"}
        {#if switchedFrom && switchedFrom !== current}
          <div class="merge-back-hint">
            <Icon name="info" size={14} />
            <span>上次为了合并从 <strong>{switchedFrom}</strong> 切换到了 <strong>{current}</strong>。</span>
            <button type="button" class="btn btn-ghost btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={switchBack}>切回 {switchedFrom}</button>
          </div>
        {/if}
        <MergeSetup
          {branches}
          {current}
          {source}
          {target}
          {mode}
          message={setupMessage}
          {preview}
          {previewing}
          {previewError}
          {blocked}
          onSource={setSource}
          onTarget={setTarget}
          onSwap={swap}
          onPick={pick}
          onMode={(next) => (mode = next)}
          onMessage={(value) => {
            setupMessage = value;
            messageTouched = true;
          }}
          onRecheck={() => (previewNonce += 1)}
          {onOpenStash}
          {onOpenChanges}
          {branchGroups}
        />
      {:else}
        <div class="empty" role="status"><span class="empty-icon"><span class="spinner"></span></span><strong>正在读取合并状态</strong></div>
      {/if}
    </div>
  {/if}

  {#if errorText}
    <div class="callout error mp-error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
  {/if}

  <div class="mp-foot" class:strip>
    <div class="mp-foot-file" bind:this={footFile}></div>
    {#if session && active && view && !view.editable && conflictTotal > 1}
      <!-- 二进制这类文件按文件停留：没有 ConflictResolver，导航在这里提供，语义相同。 -->
      <div class="cr-nav" role="group" aria-label="冲突导航">
        <button type="button" class="icon-btn sm" aria-label="上一处冲突" title="上一个未处理文件（Alt+↑ / Shift+F7）" disabled={blocked} onclick={() => leaveFile(-1)}>
          <Icon name="arrow-up" size={14} />
        </button>
        <span class="cr-nav-label" aria-live="polite">文件 <strong>{fileIndex}</strong> / {conflictTotal}</span>
        <button type="button" class="icon-btn sm" aria-label="下一处冲突" title="下一个未处理文件（Alt+↓ / F7）" disabled={blocked} onclick={() => leaveFile(1)}>
          <Icon name="arrow-down" size={14} />
        </button>
      </div>
      {#if pendingElsewhere > 0}
        <button type="button" class="btn btn-secondary btn-sm cr-next" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => leaveFile(1)}>
          <Icon name="arrow-down" size={13} />下一处未处理
        </button>
      {/if}
    {/if}
    <!-- 底部只留主操作：还有冲突时一句话说清进度和原因，全部解决后才需要合并说明。 -->
    {#if session?.operation === "merge"}
      {#if session.unresolved > 0}
        {@const reason = `${conflictTotal > 0 ? `已解决 ${resolvedPaths.length} / ${conflictTotal} 个文件，` : ""}还有 ${session.unresolved} 个未解决冲突，不能完成合并。`}
        <span class="mp-status warn" title={reason}><Icon name="alert" size={13} /><span class="truncate">{reason}</span></span>
      {:else}
        {@const reason = "冲突已全部处理，完成只会提交，不会推送。"}
        <label class="sr-only" for="merge-message">合并说明</label>
        <input
          id="merge-message"
          class="input mp-message"
          aria-label="合并说明"
          placeholder="合并说明"
          bind:value={message}
          oninput={() => messageByRepo.set(opened.summary.path, message)}
          title={blocked ? BUSY_REASON : undefined}
          disabled={blocked}
        />
        <span class="mp-status ok" title={reason}><Icon name="check-circle" size={13} /><span class="truncate">{reason}</span></span>
      {/if}
    {:else if session?.operation === "rebase" || session?.operation === "cherry-pick"}
      {#if session.unresolved > 0}
        {@const reason = `还有 ${session.unresolved} 个未解决冲突，不能算完成。不能跳过。`}
        <span class="mp-status warn" title={reason}><Icon name="alert" size={13} /><span class="truncate">{reason}</span></span>
      {:else}
        {@const reason = session.operation === "rebase" ? "冲突已全部处理。继续变基不会推送，也不能跳过。" : "冲突已全部处理。继续拣选不会推送，也不能跳过。"}
        <span class="mp-status ok" title={reason}><Icon name="check-circle" size={13} /><span class="truncate">{reason}</span></span>
      {/if}
    {:else if session?.operation === "unmerged"}
      {@const reason = "标记后的文件可以在改动区提交，临时保存记录不会被删除。"}
      <span class="mp-status" title={reason}><Icon name="info" size={13} /><span class="truncate">{reason}</span></span>
      <button type="button" class="btn btn-ghost btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onOpenStash}>查看临时保存</button>
    {/if}
    <span class="spacer"></span>
    {#if onClose}<button type="button" class={`btn btn-secondary ${strip ? "btn-sm" : ""}`} onclick={onClose}>{finished ? "完成" : "关闭"}</button>{/if}
    {#if session?.operation === "merge" || session?.operation === "rebase" || session?.operation === "cherry-pick"}
      <button
        type="button"
        class="btn btn-primary btn-sm"
        title={blocked
          ? BUSY_REASON
          : !canCompleteMerge(session.operation, session.unresolved)
            ? session.operation === "merge"
              ? `还有 ${session.unresolved} 个未解决冲突，不能完成合并。`
              : "还有未解决冲突，不能算完成。不能跳过。"
            : session.operation === "merge" && message.trim() === ""
              ? "填写合并说明后才能完成"
              : undefined}
        disabled={blocked || !canCompleteMerge(session.operation, session.unresolved) || (session.operation === "merge" && message.trim() === "")}
        onclick={complete}
      >
        <Icon name="check" size={14} />{continueLabel(session.operation)}
      </button>
    {:else if session?.operation === "none" && !finished}
      <button
        type="button"
        class="btn btn-primary"
        title={blocked
          ? BUSY_REASON
          : !readyPreview?.canStart
            ? "先完成上方的合并检查"
            : effectiveMode === "rebase" && target !== current
              ? "变基只会改写当前分支"
              : effectiveMode === "merge" && setupMessage.trim() === ""
                ? "填写合并说明后才能开始"
                : undefined}
        disabled={blocked || !readyPreview?.canStart || (effectiveMode === "rebase" && target !== current) || (effectiveMode === "merge" && setupMessage.trim() === "")}
        onclick={confirmStart}
      >
        {#if busy}<span class="spinner"></span>{:else}<Icon name="merge" size={14} />{/if}{primaryLabel(readyPreview)}
      </button>
    {/if}
  </div>

  {#if aborting}
    <Modal
      title={abortLabel(session?.operation ?? "merge")}
      titleId="abort-merge-title"
      icon="alert"
      tone="danger"
      description={abortNote}
      locked={busy}
      onClose={() => (aborting = false)}
    >
      <p class="hint">中止后这次合并的解决结果（包括这里尚未写入的逐处选择）会被撤销，不能由这里找回。取消则保持当前合并状态。</p>
      {#if abortPaths.length > 0}
        <ul class="scope-list" aria-label="受影响的路径">
          {#each abortPaths as path (path)}<li title={path}>{path}</li>{/each}
        </ul>
      {:else}
        <p>没有需要撤销的合并编辑。</p>
      {/if}
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" title={busy ? BUSY_REASON : undefined} disabled={busy} onclick={() => (aborting = false)}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-danger" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={confirmAbort}>确认中止</button>
      {/snippet}
    </Modal>
  {/if}

  {#if confirmingRebase}
    <Modal
      title="确认变基"
      titleId="confirm-rebase-title"
      icon="alert"
      description="将改写当前分支。取消则不改写，当前分支保持不动。"
      locked={busy}
      onClose={() => (confirmingRebase = false)}
    >
      <p>将改写当前分支。当前分支上尚未进入 {source} 的提交会接到 {source} 顶端。远程不变，也不会推送。</p>
      {#snippet footer()}
        <button type="button" class="btn btn-secondary" title={busy ? BUSY_REASON : undefined} disabled={busy} onclick={() => (confirmingRebase = false)}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={beginIntegration}>确认变基</button>
      {/snippet}
    </Modal>
  {/if}
</section>
