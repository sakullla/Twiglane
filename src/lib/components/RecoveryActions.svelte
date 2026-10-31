<script lang="ts">
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { changeLabel } from "../labels";
  import { discardActionLabel, discardBoundary, undoActionLabel } from "../resolve";
  import type { DiscardFilePlan, OpenedRepository, StatusSnapshot, UndoResult } from "../types";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onMerge: () => void;
  }

  let { opened, disabled, nextId, onSnapshot, onFailure, onNotice, onMerge }: Props = $props();

  let mode = $state<"discard" | "undo" | null>(null);
  let plans = $state<DiscardFilePlan[]>([]);
  let checked = $state<string[]>([]);
  let boundary = $state(discardBoundary());
  let undo = $state<UndoResult | null>(null);
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let blocked = $derived(disabled || busy);
  let conflicted = $derived(opened.snapshot.files.some((file) => file.unmerged));

  function changedPaths(): string[] {
    return opened.snapshot.files.filter((file) => !file.unmerged).map((file) => file.path);
  }

  async function openDiscard() {
    const paths = changedPaths();
    if (paths.length === 0) {
      errorText = "没有可放弃的本地改动。";
      return;
    }
    busy = true;
    errorText = null;
    try {
      const preview = await api.discardChanges(opened.summary.path, paths, false, opened.generation, nextId());
      plans = preview.files;
      boundary = preview.boundary;
      checked = paths.slice(0, 1);
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

<div class="row recovery-row">
  {#if conflicted}
    <button type="button" class="ghost compact" disabled={blocked} onclick={onMerge}>处理冲突</button>
  {/if}
  <button type="button" class="ghost compact" disabled={blocked} onclick={openUndo}>{undoActionLabel()}</button>
  <button type="button" class="danger compact" disabled={blocked || changedPaths().length === 0} onclick={openDiscard}>{discardActionLabel()}</button>
</div>
{#if errorText && mode === null}
  <p class="hint">{errorText}</p>
{/if}
{#if mode === "discard"}
  <div class="modal-backdrop" role="presentation">
    <div class="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="discard-title">
      <h2 id="discard-title">放弃文件修改</h2>
      <p>这不是撤销提交。{boundary}</p>
      <div class="branch-list">
        {#each plans as plan (plan.path)}
          <label class="branch-row">
            <span>
              <input
                type="checkbox"
                checked={checked.includes(plan.path)}
                onchange={(event) => toggle(plan.path, (event.currentTarget as HTMLInputElement).checked)}
              />
              <strong title={planTitle(plan)}>{planTitle(plan)}</strong>
              <span class="hint">{sideText(plan)}</span>
              <span class="hint">{plan.impact} {plan.recovery}</span>
            </span>
          </label>
        {/each}
      </div>
      {#if errorText}<div class="banner" role="alert">{errorText}</div>{/if}
      <div class="row">
        <button type="button" class="ghost" onclick={cancelDiscard}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="danger" disabled={blocked || checked.length === 0} onclick={confirmDiscard}>确认放弃所选</button>
      </div>
    </div>
  </div>
{/if}
{#if mode === "undo" && undo}
  <div class="modal-backdrop" role="presentation">
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="undo-title">
      <h2 id="undo-title">撤销最近提交并保留改动</h2>
      <p>{undo.summary || "最近一次提交"} · {undo.headOid.slice(0, 7)}</p>
      <p>{undo.reason}</p>
      <p class="hint">这不会放弃文件内容。已推送、合并提交、首个提交、脏暂存区、进行中的操作，或无法确认传播范围时都不会写入。</p>
      {#if errorText}<div class="banner" role="alert">{errorText}</div>{/if}
      <div class="row">
        <button type="button" class="ghost" onclick={cancelUndo}>取消</button>
        <span class="spacer"></span>
        <button type="button" class="primary" disabled={blocked || !undo.eligible} onclick={confirmUndo}>确认撤销提交</button>
      </div>
    </div>
  </div>
{/if}
