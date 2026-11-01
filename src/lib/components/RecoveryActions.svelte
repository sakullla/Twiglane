<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { changeLabel } from "../labels";
  import { discardActionLabel, discardBoundary, undoActionLabel } from "../resolve";
  import type { DiscardFilePlan, OpenedRepository, StatusSnapshot, UndoResult } from "../types";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

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
  }

  let { opened, disabled, nextId, onSnapshot, onFailure, onNotice, onMerge, variant = "toolbar" }: Props = $props();

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
    mode = null;
    errorText = null;
  }

  function toggle(path: string, value: boolean) {
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
    <button type="button" class="menu-item warn" role="menuitem" disabled={blocked} onclick={onMerge}>
      <Icon name="alert" />
      <span>处理冲突<small>{conflicts} 个文件有冲突，到分支合并里逐处处理</small></span>
      <span class="count warning">{conflicts}</span>
    </button>
  {/if}
  <button type="button" class="menu-item" role="menuitem" aria-label={undoActionLabel()} disabled={blocked} onclick={openUndo}>
    <Icon name="undo" />
    <span>撤销最近提交<small>仅限未推送的普通提交，文件改动保留</small></span>
  </button>
  <button
    type="button"
    class="menu-item danger"
    role="menuitem"
    aria-label={discardActionLabel()}
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
  <Modal
    title="放弃文件修改"
    titleId="discard-title"
    icon="trash"
    tone="danger"
    size="lg"
    description={`这不是撤销提交。${boundary}`}
    onClose={cancelDiscard}
  >
    <div class="list-box" style="max-height: 360px">
      <div class="list-section">
        <span>{checked.length} / {plans.length} 个文件已选择</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" onclick={toggleAll}>{allChecked ? "全不选" : "全选"}</button>
      </div>
      {#each plans as plan, index (plan.path)}
        <label class="list-row">
          <input
            type="checkbox"
            class="checkbox"
            data-autofocus={index === 0 ? "" : undefined}
            checked={checked.includes(plan.path)}
            onchange={(event) => toggle(plan.path, (event.currentTarget as HTMLInputElement).checked)}
          />
          <span class="lr-main">
            <span class="lr-title mono"><span title={planTitle(plan)}>{planTitle(plan)}</span></span>
            <span class="lr-sub">{sideText(plan)}</span>
            <span class="lr-desc">{plan.impact} {plan.recovery}</span>
          </span>
        </label>
      {/each}
    </div>
    <div class="callout warn">
      <Icon name="alert" size={15} />
      <span>放弃后 Git 不会保留这些未提交内容，这里也不能找回。不确定时，可以先去「临时保存」。</span>
    </div>
    {#if errorText}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>{/if}
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={cancelDiscard}>取消</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-danger" disabled={blocked || checked.length === 0} onclick={confirmDiscard}>
        <Icon name="trash" size={14} />确认放弃所选
      </button>
    {/snippet}
  </Modal>
{/if}
{#if mode === "undo" && undo}
  <Modal
    title="撤销最近提交并保留改动"
    titleId="undo-title"
    icon="undo"
    tone={undo.eligible ? "danger" : "warning"}
    description="这不会放弃文件内容，改动会回到工作区。"
    onClose={cancelUndo}
  >
    <div class="list-box">
      <div class="list-row">
        <Icon name="commit" />
        <span class="lr-main">
          <span class="lr-title"><span>{undo.summary || "最近一次提交"}</span></span>
          <span class="lr-sub mono">{undo.headOid.slice(0, 7)}</span>
        </span>
      </div>
    </div>
    <div class={`callout ${undo.eligible ? "ok" : "warn"}`}>
      <Icon name={undo.eligible ? "check-circle" : "alert"} size={15} />
      <span>{undo.reason}</span>
    </div>
    <p class="hint">已推送、合并提交、首个提交、脏暂存区、进行中的操作，或无法确认传播范围时都不会写入。</p>
    {#if errorText}<div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>{/if}
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={cancelUndo}>取消</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-danger" disabled={blocked || !undo?.eligible} onclick={confirmUndo}>确认撤销提交</button>
    {/snippet}
  </Modal>
{/if}
