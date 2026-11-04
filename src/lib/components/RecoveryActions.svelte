<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { changeLabel } from "../labels";
  import { visibleRange } from "../layout";
  import { discardActionLabel, discardBoundary, undoActionLabel } from "../resolve";
  import type { DiscardFilePlan, OpenedRepository, StatusSnapshot, UndoResult } from "../types";
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

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

  let mode = $state<"discard" | "undo" | null>(null);
  let plans = $state<DiscardFilePlan[]>([]);
  let checked = $state<string[]>([]);
  let boundary = $state(discardBoundary());
  let undo = $state<UndoResult | null>(null);
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

  let confirming = false;
  $effect(() => {
    if (mode !== null) confirming = true;
    else if (confirming) {
      confirming = false;
      onSettled?.();
    }
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
      const preview = await api.discardChanges(opened.summary.path, paths, false, opened.generation, nextId());
      plans = preview.files;
      boundary = preview.boundary;
      checked = only ? [...paths] : paths.slice(0, 1);
      mode = "discard";
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  function cancelDiscard() {
    if (busy) return;
    mode = null;
    errorText = null;
  }

  function toggle(path: string, value: boolean) {
    if (value === checkedSet.has(path)) return;
    checked = value ? [...checked, path] : checked.filter((item) => item !== path);
  }

  function toggleAll() {
    checked = allChecked ? [] : plans.map((plan) => plan.path);
  }

  async function confirmDiscard() {
    if (checked.length === 0) return;
    const selected = [...checked];
    busy = true;
    errorText = null;
    try {
      const result = await api.discardChanges(
        opened.summary.path,
        selected,
        true,
        opened.generation,
        nextId(),
      );
      mode = null;
      onSnapshot(result.snapshot);
      onNotice(`已放弃 ${result.files.length} 个所选文件的修改，其他文件保持原内容。`);
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  async function openUndo() {
    const head = opened.snapshot.branch.headOid;
    if (!head) {
      errorText = "没有可撤销的提交。";
      onFailure({ code: "nothing_to_undo", message: errorText });
      return;
    }
    busy = true;
    errorText = null;
    try {
      undo = await api.undoCommit(opened.summary.path, head, false, opened.generation, nextId());
      mode = "undo";
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
    }
  }

  function cancelUndo() {
    if (busy) return;
    mode = null;
  }

  async function confirmUndo() {
    const current = undo;
    if (!current?.eligible) return;
    busy = true;
    errorText = null;
    try {
      const result = await api.undoCommit(
        opened.summary.path,
        current.headOid,
        true,
        current.generation,
        nextId(),
      );
      mode = null;
      onSnapshot(result.snapshot);
      onNotice(result.reason);
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      busy = false;
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
  <button type="button" class="menu-item" role="menuitem" aria-label={undoActionLabel()} title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={openUndo}>
    <Icon name="undo" />
    <span>撤销最近提交<small>仅限未推送的普通提交，文件改动保留</small></span>
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
    onclick={openUndo}
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
    message="撤销最近一次提交？改动会回到工作区，不会放弃文件内容。"
    targets={[{ icon: "commit", name: undo.summary || "最近一次提交", detail: undo.headOid.slice(0, 7) }]}
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
