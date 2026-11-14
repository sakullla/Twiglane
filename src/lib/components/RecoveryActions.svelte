<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { changeLabel } from "../labels";
  import { commitFileLabel, shortOid } from "../history";
  import { visibleRange } from "../layout";
  import { discardActionLabel, discardBoundary, undoActionLabel, amendActionLabel } from "../resolve";
  import type {
    AmendOutcome,
    DiscardFilePlan,
    HistoryCommit,
    MergeSession,
    OpenedRepository,
    RevertOutcome,
    StatusSnapshot,
    UndoResult,
  } from "../types";
  import Icon from "./Icon.svelte";
  import ConfirmDialog, { type ConfirmNote } from "./ConfirmDialog.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onMerge: () => void;
    /**
     * toolbar：一排图标按钮（默认）；menu：作为「更多提交操作」菜单里的带说明菜单项，
     * 名称与说明都直接可见，不再只靠悬停提示。
     */
    variant?: "toolbar" | "menu" | "headless";
    /** 确认层收起（确认或取消）后调用：菜单入口据此一起收起，不留在原地。 */
    onSettled?: () => void;
  }

  let { opened, disabled, nextId, onSnapshot, onFailure, onNotice, onMerge, variant = "toolbar", onSettled }: Props = $props();

  let mode = $state<"discard" | "undo" | "revert" | "amend" | null>(null);
  let plans = $state<DiscardFilePlan[]>([]);
  let checked = $state<string[]>([]);
  let boundary = $state(discardBoundary());
  let undo = $state<UndoResult | null>(null);
  /** 撤销预览所属仓库：确认写入前必须与当前仓库一致。 */
  let undoRepository = "";
  /** 还原预览：目标顺序与后端返回一致（由新到旧），确认只使用这份预览。 */
  let revert = $state<RevertOutcome | null>(null);
  let revertRepository = "";
  /** 修订预览与用户草稿分开保存：失败或重新预览都不能丢掉已经输入的说明。 */
  let amend = $state<AmendOutcome | null>(null);
  let amendRepository = "";
  let amendDraft = $state("");
  let amendIncludeStaged = $state(false);
  let amendRefreshed = $state(false);
  /** 放弃预览所属仓库与 generation：确认写入只使用这份预览对应的仓库和状态。 */
  let discardRepository = "";
  let discardGeneration = 0;
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let blocked = $derived(disabled || busy);
  let conflicts = $derived(opened.snapshot.files.filter((file) => file.unmerged).length);
  let allChecked = $derived(plans.length > 0 && checked.length === plans.length);
  /** 几千个文件时逐行 includes 会退化成平方级：勾选状态用集合查。 */
  let checkedSet = $derived(new Set(checked));
  /** 放弃清单的固定行高（标题、侧别、说明各一行）与视口窗口。 */
  const PLAN_ROW = 72;
  let planScroll = $state(0);
  let planViewport = $state(0);
  let planRange = $derived(visibleRange(plans.length, planScroll, planViewport, PLAN_ROW));

  /** 修订说明与预览原文都按 trim 比较：后端也会 trim 后再写回。 */
  let amendMessage = $derived(amendDraft.trim());
  let amendUnchanged = $derived(
    Boolean(amend) &&
      amendMessage === (amend?.message.trim() ?? "") &&
      (!amendIncludeStaged || (amend?.stagedPaths.length ?? 0) === 0),
  );
  /** 修订确认按钮不可用的原因；无实际变化必须就地说明，而不是只灰掉按钮。 */
  let amendConfirmBlocked = $derived.by(() => {
    if (!amend) return null;
    if (disabled) return BUSY_REASON;
    if (!amend.eligible) return amend.note;
    if (!amend.headOid) return "没有可修订的最近提交，请重新预览";
    if (!amendMessage) return "先填写修订后的提交说明";
    if (!amend.stagedToken) return "暂存区快照不可用，请重新预览后再确认";
    if (amendUnchanged) return "说明没有变化，也没有纳入非空的暂存改动，不能写入";
    return null;
  });
  /** 提交区菜单入口的不可用原因：没有 HEAD 或游离 HEAD 时不提供可执行修订。 */
  let amendMenuBlocked = $derived(
    blocked
      ? BUSY_REASON
      : opened.snapshot.branch.detached
        ? "请先切换到本地分支"
        : opened.snapshot.branch.unborn || !opened.snapshot.branch.headOid
          ? "当前分支还没有可修订的提交"
          : null,
  );
  let amendNotes = $derived.by((): ConfirmNote[] => {
    if (!amend) return [];
    const notes: ConfirmNote[] = [];
    if (amend.eligible) {
      notes.push({
        tone: "ok",
        text: amendIncludeStaged
          ? "确认后会把当前暂存改动纳入新提交；未暂存和未跟踪内容不会加入。"
          : "确认后只更新说明，原提交树和当前暂存区保持不变。",
      });
      notes.push({
        tone: "info",
        text: "已核对唯一远程的分支、tag 与本地推送记录；确认时会再次核对，离线、已发布、记录无法解析或暂存区变化都会停止。不会推送。",
      });
    } else {
      notes.push({ tone: "warn", text: amend.note });
    }
    return notes;
  });
  const AMEND_FILE_LIMIT = 200;

  let confirming = false;
  $effect(() => {
    if (mode !== null) confirming = true;
    else if (confirming) {
      confirming = false;
      onSettled?.();
    }
  });

  /** 收起并清空放弃确认：清单和仓库绑定一起丢弃，下一次确认必须重新预览。 */
  function resetDiscard() {
    mode = null;
    plans = [];
    checked = [];
    discardRepository = "";
    discardGeneration = 0;
    errorText = null;
  }

  /** 收起并清空撤销确认：旧预览的提交和仓库绑定一起丢弃。 */
  function resetUndo() {
    mode = null;
    undo = null;
    undoRepository = "";
    errorText = null;
  }

  /** 收起并清空还原确认：旧预览的目标清单和仓库绑定一起丢弃。 */
  function resetRevert() {
    mode = null;
    revert = null;
    revertRepository = "";
    errorText = null;
  }

  /** 收起并清空修订确认：预览、仓库绑定和用户草稿一起丢弃。 */
  function resetAmend() {
    mode = null;
    amend = null;
    amendRepository = "";
    amendDraft = "";
    amendIncludeStaged = false;
    amendRefreshed = false;
    errorText = null;
  }

  /**
   * 仓库切换时，确认层里的清单属于旧仓库，必须作废。
   * 写入已经开始时结果仍可能落在原仓库，提示要如实说明，且本组件不再应用它。
   */
  function invalidateStaleConfirmation(path: string) {
    if (mode === "discard" && discardRepository && discardRepository !== path) {
      resetDiscard();
      onNotice(
        busy
          ? "仓库已切换，原仓库的放弃修改仍在处理中；结果不会应用到当前仓库。"
          : "仓库已切换，放弃修改的确认已作废，没有写入任何内容。",
      );
    } else if (mode === "undo" && undoRepository && undoRepository !== path) {
      resetUndo();
      onNotice(
        busy
          ? "仓库已切换，原仓库的撤销提交仍在处理中；结果不会应用到当前仓库。"
          : "仓库已切换，撤销提交的确认已作废，没有写入任何内容。",
      );
    } else if (mode === "revert" && revertRepository && revertRepository !== path) {
      resetRevert();
      onNotice(
        busy
          ? "仓库已切换，原仓库的还原提交仍在处理中；结果不会应用到当前仓库。"
          : "仓库已切换，还原提交的确认已作废，没有写入任何内容。",
      );
    } else if (mode === "amend" && amendRepository && amendRepository !== path) {
      resetAmend();
      onNotice(
        busy
          ? "仓库已切换，原仓库的修订提交仍在处理中；结果不会应用到当前仓库。"
          : "仓库已切换，修订提交的确认已作废，没有写入任何内容。",
      );
    }
  }

  // opened 只会因切换仓库而变化：确认层不在新仓库上继续展示旧仓库的清单（R6、R10）。
  $effect(() => {
    const path = opened.summary.path;
    invalidateStaleConfirmation(path);
  });

  function changedPaths(): string[] {
    return opened.snapshot.files.filter((file) => !file.unmerged).map((file) => file.path);
  }

  /**
   * 放弃修改：先列出影响清单再确认。传入 paths 时只针对这些文件（右键菜单），并默认全部勾选；
   * 不传时列出全部改动、默认只勾第一项（溢出菜单的原有行为）。
   */
  export async function discard(paths?: string[]) {
    await openDiscard(paths);
  }

  async function openDiscard(only?: string[]) {
    // 入口可能在确认层还在收尾时被再次触发：这里挡在读取影响清单之前，避免重复请求和重复写入。
    if (busy || disabled) return;
    const repository = opened.summary.path;
    const generation = opened.generation;
    const changed = changedPaths();
    const paths = only ? only.filter((path) => changed.includes(path)) : changed;
    if (paths.length === 0) {
      errorText = "没有可放弃的本地改动。";
      onFailure({ code: "nothing_to_discard", message: errorText });
      return;
    }
    busy = true;
    errorText = null;
    try {
      const preview = await api.discardChanges(repository, paths, false, generation, nextId());
      // 预览返回时仓库已切换：这是旧仓库的结果，不能在当前界面打开确认层。
      if (opened.summary.path !== repository) return;
      discardRepository = repository;
      discardGeneration = preview.generation;
      plans = preview.files;
      boundary = preview.boundary;
      checked = only ? [...paths] : paths.slice(0, 1);
      mode = "discard";
    } catch (error) {
      if (opened.summary.path !== repository) return;
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  function cancelDiscard() {
    if (busy) return;
    resetDiscard();
  }

  function toggle(path: string, value: boolean) {
    if (value === checkedSet.has(path)) return;
    checked = value ? [...checked, path] : checked.filter((item) => item !== path);
  }

  function toggleAll() {
    checked = allChecked ? [] : plans.map((plan) => plan.path);
  }

  async function confirmDiscard() {
    if (busy || checked.length === 0) return;
    // 确认只对预览所属仓库有效：仓库已切换时绝不能用新路径 + 旧清单写入。
    if (mode !== "discard" || !discardRepository || opened.summary.path !== discardRepository) {
      if (mode === "discard") invalidateStaleConfirmation(opened.summary.path);
      return;
    }
    const repository = discardRepository;
    const generation = discardGeneration;
    const selected = [...checked];
    busy = true;
    errorText = null;
    try {
      const result = await api.discardChanges(
        repository,
        selected,
        true,
        generation,
        nextId(),
      );
      if (opened.summary.path !== repository) {
        resetDiscard();
        return;
      }
      onSnapshot(result.snapshot);
      onNotice(`已放弃 ${result.files.length} 个所选文件的修改，其他文件保持原内容。`);
      resetDiscard();
    } catch (error) {
      if (opened.summary.path !== repository) {
        resetDiscard();
        return;
      }
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  export async function undoLatest(expectedHead?: string) {
    if (blocked) return;
    await openUndo(expectedHead);
  }

  async function openUndo(expectedHead?: string) {
    if (busy || disabled) return;
    const repository = opened.summary.path;
    const generation = opened.generation;
    const head = expectedHead ?? opened.snapshot.branch.headOid;
    if (!head) {
      errorText = "没有可撤销的提交。";
      onFailure({ code: "nothing_to_undo", message: errorText });
      return;
    }
    busy = true;
    errorText = null;
    try {
      const preview = await api.undoCommit(repository, head, false, generation, nextId());
      if (opened.summary.path !== repository) return;
      undoRepository = repository;
      undo = preview;
      mode = "undo";
    } catch (error) {
      if (opened.summary.path !== repository) return;
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  function cancelUndo() {
    if (busy) return;
    resetUndo();
  }

  async function confirmUndo() {
    const current = undo;
    if (busy || !current?.eligible || !undoRepository || undoRepository !== opened.summary.path) {
      if (mode === "undo" && undoRepository !== opened.summary.path) invalidateStaleConfirmation(opened.summary.path);
      return;
    }
    const repository = undoRepository;
    busy = true;
    errorText = null;
    try {
      const result = await api.undoCommit(
        repository,
        current.headOid,
        true,
        current.generation,
        nextId(),
      );
      if (opened.summary.path !== repository) {
        resetUndo();
        return;
      }
      onSnapshot(result.snapshot);
      onNotice(result.reason);
      resetUndo();
    } catch (error) {
      if (opened.summary.path !== repository) {
        resetUndo();
        return;
      }
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  /**
   * 还原提交：先读预览（写锁之外，confirm=false），确认时才创建逆向提交。
   * 传入的 commits 保持历史列表的顺序（由新到旧），预览返回的目标顺序原样展示与回传。
   */
  export async function revertCommits(commits: HistoryCommit[]) {
    if (blocked || commits.length === 0) return;
    await openRevert(commits.map((commit) => commit.oid));
  }

  async function openRevert(oids: string[]) {
    if (busy || disabled || oids.length === 0) return;
    const repository = opened.summary.path;
    const generation = opened.generation;
    const head = opened.snapshot.branch.headOid;
    if (!head) {
      errorText = "当前分支还没有可还原的提交。";
      onFailure({ code: "revert_empty", message: errorText });
      return;
    }
    busy = true;
    errorText = null;
    try {
      const preview = await api.revertCommits(repository, oids, head, false, generation, nextId());
      if (opened.summary.path !== repository) return;
      revertRepository = repository;
      revert = preview;
      mode = "revert";
    } catch (error) {
      if (opened.summary.path !== repository) return;
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  function cancelRevert() {
    if (busy) return;
    resetRevert();
  }

  async function confirmRevert() {
    const current = revert;
    if (
      busy ||
      !current?.eligible ||
      !revertRepository ||
      revertRepository !== opened.summary.path ||
      current.targets.length === 0
    ) {
      if (mode === "revert" && revertRepository !== opened.summary.path) {
        invalidateStaleConfirmation(opened.summary.path);
      }
      return;
    }
    const repository = revertRepository;
    const oids = current.targets.map((target) => target.oid);
    busy = true;
    errorText = null;
    try {
      const result = await api.revertCommits(
        repository,
        oids,
        current.headOid ?? "",
        true,
        current.generation,
        nextId(),
      );
      if (opened.summary.path !== repository) {
        resetRevert();
        return;
      }
      onSnapshot(result.snapshot);
      onNotice(result.note);
      if (result.conflicted) {
        resetRevert();
        // 冲突是正常进度：快照已回写，接着打开现有冲突面板，由用户解决后继续或中止。
        onMerge();
        return;
      }
      resetRevert();
    } catch (error) {
      if (opened.summary.path !== repository) {
        resetRevert();
        return;
      }
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
      await recoverRevertFailure(repository, failure.generation);
    } finally {
      busy = false;
    }
  }

  /**
   * 还原失败可能已经留下部分提交或 sequencer 状态。先刷新快照；检测到仍在进行中的还原时
   * 打开现有冲突面板，让用户明确中止，而不是把有残留的状态显示成“什么都没发生”。
   */
  async function recoverRevertFailure(repository: string, generation?: number) {
    const ask = (value: number) => api.mergeSession(repository, value, nextId());
    try {
      let session: MergeSession;
      try {
        session = await ask(generation ?? opened.generation);
      } catch (error) {
        const stale = normalizeError(error);
        if (stale.code !== "stale" || stale.generation === undefined) throw stale;
        session = await ask(stale.generation);
      }
      if (opened.summary.path !== repository) return;
      onSnapshot(session.snapshot);
      if (session.operation === "revert" && session.canAbort) {
        resetRevert();
        onMerge();
      }
    } catch {
      // 刷新失败不覆盖最初的就地错误：它才是这次写入失败的直接证据。
    }
  }

  /**
   * 修订最近提交：从历史 HEAD 或提交区菜单进入。预览只读取，确认时才改写 HEAD；
   * 传入的 expectedHead 是用户右键的那条提交，必须与当前 HEAD 一致才能预览。
   */
  export async function amendLatest(expectedHead?: string) {
    if (blocked) return;
    await openAmend(expectedHead);
  }

  async function openAmend(expectedHead?: string) {
    if (busy || disabled) return;
    const repository = opened.summary.path;
    const generation = opened.generation;
    const head = expectedHead ?? opened.snapshot.branch.headOid;
    if (opened.snapshot.branch.detached) {
      errorText = "当前不在本地分支上，不能修订最近提交。";
      onFailure({ code: "amend_detached", message: errorText });
      return;
    }
    if (!head) {
      errorText = "当前分支还没有可修订的提交。";
      onFailure({ code: "amend_no_commit", message: errorText });
      return;
    }
    busy = true;
    errorText = null;
    try {
      // 预览不带 message/token：它们只在确认时绑定用户这次选择，预览只负责读原说明与暂存快照。
      const preview = await api.amendCommit(repository, head, null, false, null, false, generation, nextId());
      if (opened.summary.path !== repository) return;
      amendRepository = repository;
      amend = preview;
      amendDraft = preview.message;
      amendIncludeStaged = false;
      amendRefreshed = false;
      mode = "amend";
    } catch (error) {
      if (opened.summary.path !== repository) return;
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  function cancelAmend() {
    if (busy) return;
    resetAmend();
  }

  async function confirmAmend() {
    const current = amend;
    if (busy || !current || !amendRepository || amendRepository !== opened.summary.path) {
      if (mode === "amend" && amendRepository !== opened.summary.path) {
        invalidateStaleConfirmation(opened.summary.path);
      }
      return;
    }
    if (!current.eligible || !current.stagedToken || amendConfirmBlocked) return;
    const repository = amendRepository;
    busy = true;
    errorText = null;
    try {
      const result = await api.amendCommit(
        repository,
        current.headOid ?? "",
        amendDraft,
        amendIncludeStaged,
        current.stagedToken,
        true,
        current.generation,
        nextId(),
      );
      if (opened.summary.path !== repository) {
        resetAmend();
        return;
      }
      if (!result.wrote) {
        errorText = result.note || "修订没有写入，请重新预览后再确认。";
        return;
      }
      onSnapshot(result.snapshot);
      onNotice(result.note || "已修订最近提交。没有推送。");
      resetAmend();
    } catch (error) {
      if (opened.summary.path !== repository) {
        resetAmend();
        return;
      }
      const failure = normalizeError(error);
      // 失败保持弹层打开：预览、说明草稿和勾选状态都还在，用户可以重试或先重新预览。
      errorText =
        failure.code === "amend_stale_index" || failure.code === "amend_head_changed"
          ? `${failure.message} 点「重新预览」刷新后再确认，修订草稿仍在。`
          : failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  /**
   * 重新预览：先读取最新状态拿到当前 HEAD，再重读原说明与暂存令牌；用户已经输入的草稿
   * 与“纳入暂存”选择保留，只刷新预览事实。
   */
  async function rePreviewAmend() {
    if (busy) return;
    const current = amend;
    if (!current || !amendRepository || amendRepository !== opened.summary.path) {
      if (mode === "amend") invalidateStaleConfirmation(opened.summary.path);
      return;
    }
    const repository = amendRepository;
    const draft = amendDraft;
    const include = amendIncludeStaged;
    busy = true;
    errorText = null;
    try {
      const snapshot = await freshSnapshot(repository, current.generation);
      if (opened.summary.path !== repository) return;
      onSnapshot(snapshot);
      const head = snapshot.branch.headOid;
      if (!head) {
        errorText = "当前分支还没有可修订的提交。";
        return;
      }
      const preview = await api.amendCommit(
        repository,
        head,
        null,
        include,
        null,
        false,
        snapshot.generation,
        nextId(),
      );
      if (opened.summary.path !== repository) return;
      amend = preview;
      amendDraft = draft;
      amendIncludeStaged = preview.stagedPaths.length === 0 ? false : include;
      amendRefreshed = true;
    } catch (error) {
      if (opened.summary.path !== repository) return;
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  /** 读取最新快照；generation 过期时沿错误带来的新代次重试一次。 */
  async function freshSnapshot(repository: string, generation: number): Promise<StatusSnapshot> {
    const ask = (value: number) => api.refreshStatus(repository, value, nextId());
    try {
      return await ask(generation);
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      return await ask(failure.generation);
    }
  }

  function sideText(plan: DiscardFilePlan): string {
    if (plan.untracked) return "未跟踪";
    const staged = changeLabel(plan.staged);
    const unstaged = changeLabel(plan.unstaged);
    return `已暂存 ${staged ?? "无"} · 未暂存 ${unstaged ?? "无"}`;
  }

  function planTitle(plan: DiscardFilePlan): string {
    return plan.originalPath ? `${plan.originalPath} → ${plan.path}` : plan.path;
  }
</script>

{#if variant === "headless"}
  <!-- 只承载确认 modal：入口在别处（例如文件右键菜单）通过 discard(paths) 唤起。 -->
{:else if variant === "menu"}
  {#if conflicts > 0}
    <button type="button" class="menu-item warn" role="menuitem" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onMerge}>
      <Icon name="alert" />
      <span>处理冲突<small>{conflicts} 个文件有冲突，到分支合并里逐处处理</small></span>
      <span class="count warning">{conflicts}</span>
    </button>
  {/if}
  <button type="button" class="menu-item" role="menuitem" aria-label={undoActionLabel()} title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => void openUndo()}>
    <Icon name="undo" />
    <span>撤销最近提交<small>仅限未推送的普通提交，文件改动保留</small></span>
  </button>
  <button
    type="button"
    class="menu-item"
    role="menuitem"
    aria-label={amendActionLabel()}
    title={amendMenuBlocked ?? "只改写当前 HEAD；预填完整原说明，可显式纳入暂存改动"}
    disabled={amendMenuBlocked !== null}
    onclick={() => void openAmend()}
  >
    <Icon name="pencil" />
    <span>修订最近提交…<small>仅限未推送的普通 HEAD；默认只改说明，不自动纳入暂存</small></span>
  </button>
  <button
    type="button"
    class="menu-item danger"
    role="menuitem"
    aria-label={discardActionLabel()}
    title={blocked ? BUSY_REASON : changedPaths().length === 0 ? "没有可放弃的本地改动" : undefined}
    disabled={blocked || changedPaths().length === 0}
    onclick={() => openDiscard()}
  >
    <Icon name="trash" />
    <span>放弃文件修改…<small>先列出受影响的文件，确认后才写入</small></span>
  </button>
{:else}
  {#if conflicts > 0}
    <button type="button" class="btn btn-warning-soft btn-sm" disabled={blocked} title="去合并视图逐个处理冲突文件" onclick={onMerge}>
      <Icon name="alert" size={13} />处理冲突
      <span class="count warning">{conflicts}</span>
    </button>
  {/if}
  <button
    type="button"
    class="icon-btn"
    aria-label={undoActionLabel()}
    title={`${undoActionLabel()}（仅限未推送的普通提交）`}
    disabled={blocked}
    onclick={() => void openUndo()}
  >
    <Icon name="undo" />
  </button>
  <button
    type="button"
    class="icon-btn danger"
    aria-label={discardActionLabel()}
    title={`${discardActionLabel()}（会先列出影响，确认后才写入）`}
    disabled={blocked || changedPaths().length === 0}
    onclick={() => openDiscard()}
  >
    <Icon name="trash" />
  </button>
{/if}
{#if errorText && mode === null}
  <p class="sr-only" role="status">{errorText}</p>
{/if}
{#if mode === "discard"}
  <ConfirmDialog
    title="放弃文件修改"
    titleId="discard-title"
    size="lg"
    message={`选择要放弃修改的文件。这不是撤销提交。${boundary}`}
    notes={[
      { tone: "warn", text: "放弃后 Git 不会保留这些未提交内容，这里也不能找回。" },
      { tone: "info", text: "不确定时，可以先去「临时保存」把改动存起来。" },
    ]}
    confirmLabel={checked.length > 0 ? `放弃 ${checked.length} 个文件的修改` : "放弃所选"}
    confirmIcon="trash"
    busy={busy}
    confirmBlocked={checked.length === 0 ? "至少选择一个文件" : disabled ? BUSY_REASON : null}
    error={errorText}
    focus="body"
    onConfirm={() => void confirmDiscard()}
    onCancel={cancelDiscard}
  >
    <div class="list-box confirm-list" role="group" aria-label="要放弃的文件">
      <div class="list-section">
        <span>{checked.length} / {plans.length} 个文件已选择</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" onclick={toggleAll}>{allChecked ? "全不选" : "全选"}</button>
      </div>
      <!-- 放弃整个工作区时可能有几千个文件：只渲染视口附近的行，行高固定，上下用占位撑出滚动高度。 -->
      <div class="confirm-list-scroll" bind:clientHeight={planViewport} onscroll={(event) => {
          planScroll = event.currentTarget.scrollTop;
          planViewport = event.currentTarget.clientHeight;
        }}>
        {#if planRange.start > 0}<div aria-hidden="true" style={`height:${planRange.start * PLAN_ROW}px`}></div>{/if}
        {#each plans.slice(planRange.start, planRange.end) as plan, offset (plan.path)}
          {@const index = planRange.start + offset}
          <label class="list-row" style={`height:${PLAN_ROW}px`}>
            <input
              type="checkbox"
              class="checkbox"
              data-autofocus={index === 0 ? "" : undefined}
              checked={checkedSet.has(plan.path)}
              onchange={(event) => toggle(plan.path, (event.currentTarget as HTMLInputElement).checked)}
            />
            <span class="lr-main">
              <span class="lr-title mono"><span title={planTitle(plan)}>{planTitle(plan)}</span></span>
              <span class="lr-sub">{sideText(plan)}</span>
              <span class="lr-desc" title={`${plan.impact} ${plan.recovery}`}>{plan.impact} {plan.recovery}</span>
            </span>
          </label>
        {/each}
        {#if planRange.end < plans.length}<div aria-hidden="true" style={`height:${(plans.length - planRange.end) * PLAN_ROW}px`}></div>{/if}
      </div>
    </div>
  </ConfirmDialog>
{/if}
{#if mode === "undo" && undo}
  <ConfirmDialog
    title="撤销最近提交并保留改动"
    titleId="undo-title"
    icon="undo"
    tone={undo.eligible ? "danger" : "warning"}
    message="撤销最近一次提交？文件改动会保留在暂存区，不会放弃文件内容。"
    targets={[{ icon: "commit", name: undo.summary || "最近一次提交", detail: shortOid(undo.headOid) }]}
    targetsLabel="要撤销的提交"
    notes={[
      { tone: undo.eligible ? "ok" : "warn", text: undo.reason },
      { tone: "info", text: "已推送、合并提交、首个提交、脏暂存区、进行中的操作，或无法确认传播范围时都不会写入。" },
    ]}
    confirmLabel="确认撤销提交"
    confirmIcon="undo"
    busy={busy}
    confirmBlocked={!undo.eligible ? undo.reason : disabled ? BUSY_REASON : null}
    error={errorText}
    onConfirm={() => void confirmUndo()}
    onCancel={cancelUndo}
  />
{/if}
{#if mode === "revert" && revert}
  <ConfirmDialog
    title="还原提交"
    titleId="revert-title"
    icon="undo"
    tone="warning"
    message="为所选提交按由新到旧创建逆向提交。原提交仍在历史中，不会推送。"
    targets={revert.targets.map((target) => ({
      icon: "commit",
      name: target.summary || "（没有提交说明）",
      detail: shortOid(target.oid),
    }))}
    targetsLabel="要还原的提交（由新到旧）"
    notes={[
      { tone: revert.eligible ? "ok" : "warn", text: revert.note },
      { tone: "info", text: "取消不会写入。还原出现冲突时进入冲突处理：解决后可以继续，也可以中止回到开始前，不能跳过。" },
    ]}
    confirmLabel={revert.targets.length > 1 ? `确认还原 ${revert.targets.length} 个提交` : "确认还原提交"}
    confirmIcon="undo"
    busy={busy}
    confirmBlocked={!revert.eligible ? revert.note : disabled ? BUSY_REASON : null}
    error={errorText}
    focus="cancel"
    onConfirm={() => void confirmRevert()}
    onCancel={cancelRevert}
  />
{/if}
{#if mode === "amend" && amend}
  <ConfirmDialog
    title="修订最近提交"
    titleId="amend-title"
    icon="pencil"
    tone="warning"
    size="lg"
    message="用新的提交替换当前 HEAD。原提交会离开历史，新提交只在本机，不会推送。"
    targets={amend.headOid
      ? [{ icon: "commit", name: amend.summary || "（没有提交说明）", detail: shortOid(amend.headOid) }]
      : []}
    targetsLabel="要修订的最近提交"
    notes={amendNotes}
    confirmLabel="确认修订提交"
    confirmIcon="pencil"
    busy={busy}
    confirmBlocked={amendConfirmBlocked}
    error={errorText}
    focus="body"
    impact="amend"
    onConfirm={() => void confirmAmend()}
    onCancel={cancelAmend}
  >
    <div class="amend-form">
      <label class="amend-label" for="amend-message">提交说明</label>
      <textarea
        id="amend-message"
        class="textarea code amend-message"
        aria-label="修订后的提交说明"
        data-autofocus
        spellcheck="false"
        title={busy ? "写入完成后才能修改修订说明" : undefined}
        disabled={busy}
        value={amendDraft}
        oninput={(event) => (amendDraft = event.currentTarget.value)}
      ></textarea>
      {#if amendRefreshed}
        <p class="hint" role="status">预览已刷新，请再次确认；你的修订草稿仍保留。</p>
      {/if}
      {#if amend.eligible && amendUnchanged}
        <p class="callout info" role="status">说明没有变化，也没有纳入非空的暂存改动；没有可写入的修订内容。</p>
      {/if}
      <div class="amend-scope">
        <div class="list-section amend-section">
          <span>原提交修改的文件</span>
          <span class="spacer"></span>
          <span>{amend.files.length}</span>
        </div>
        {#if amend.files.length === 0}
          <p class="hint">原提交没有文件改动。</p>
        {:else}
          <ul class="list-box amend-files" aria-label="原提交修改的文件">
            {#each amend.files.slice(0, AMEND_FILE_LIMIT) as file (file.path)}
              <li class="list-row">
                <span class="lr-main">
                  <span class="lr-title mono">{file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}</span>
                  <span class="lr-sub">{commitFileLabel(file.status)}</span>
                </span>
              </li>
            {/each}
          </ul>
          {#if amend.files.length > AMEND_FILE_LIMIT}
            <p class="hint">还有 {amend.files.length - AMEND_FILE_LIMIT} 个文件未显示；完整清单见提交详情。</p>
          {/if}
        {/if}
      </div>
      <div class="amend-scope">
        <div class="list-section amend-section">
          <span>当前暂存改动</span>
          <span class="spacer"></span>
          <span>{amend.stagedPaths.length}</span>
        </div>
        {#if amend.stagedPaths.length === 0}
          <p class="hint">当前没有已暂存改动；这次只能修改说明。</p>
        {:else}
          <ul class="list-box amend-files" aria-label="当前暂存改动">
            {#each amend.stagedPaths.slice(0, AMEND_FILE_LIMIT) as path (path)}
              <li class="list-row">
                <span class="lr-main"><span class="lr-title mono">{path}</span></span>
              </li>
            {/each}
          </ul>
          {#if amend.stagedPaths.length > AMEND_FILE_LIMIT}
            <p class="hint">还有 {amend.stagedPaths.length - AMEND_FILE_LIMIT} 个暂存路径未显示。</p>
          {/if}
        {/if}
      </div>
      <label class="confirm-option amend-option">
        <input
          type="checkbox"
          class="checkbox"
          aria-label="纳入当前暂存改动"
          title={busy
            ? "写入完成后才能修改"
            : amend.stagedPaths.length === 0
              ? "当前没有已暂存改动，只能修改说明"
              : undefined}
          disabled={busy || amend.stagedPaths.length === 0}
          checked={amendIncludeStaged}
          onchange={(event) => (amendIncludeStaged = event.currentTarget.checked)}
        />
        <span>
          <strong>纳入当前暂存改动</strong>
          <small>默认不勾选；未暂存和未跟踪文件不会被自动加入。</small>
        </span>
      </label>
      <div class="amend-actions">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          title={busy ? "写入完成后才能重新预览" : "重新读取 HEAD、原说明与暂存快照；保留修订草稿"}
          disabled={busy}
          onclick={() => void rePreviewAmend()}
        >
          <Icon name="refresh" size={13} />重新预览
        </button>
        <span class="spacer"></span>
        <span class="amend-hint">只改写本地历史，不推送。</span>
      </div>
    </div>
  </ConfirmDialog>
{/if}
<style>
  .amend-form { display: flex; flex-direction: column; gap: var(--space-12); min-width: 0; }
  .amend-label { font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--fg-subtle); }
  .amend-message { min-height: 150px; max-height: 320px; font-family: var(--mono); font-size: var(--text-sm); }
  .amend-scope { display: flex; flex-direction: column; min-width: 0; }
  .amend-section { position: static; border: 1px solid var(--border); border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; }
  .amend-files { max-height: 180px; border-radius: 0 0 var(--radius) var(--radius); }
  .amend-files .list-row { min-height: 34px; padding-block: 6px; }
  .amend-option:has(input:checked) {
    background: var(--accent-softer);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .amend-actions { display: flex; align-items: center; gap: var(--space-8); }
  .amend-hint { color: var(--fg-subtle); font-size: var(--text-xs); }
</style>
