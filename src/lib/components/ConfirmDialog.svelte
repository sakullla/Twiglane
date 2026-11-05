<script module lang="ts">
  import type { IconName } from "../icons";

  /** 这次操作会碰到的对象：分支、标签、临时保存记录、文件……每个一行，名字等宽显示。 */
  export interface ConfirmTarget {
    icon: IconName;
    name: string;
    detail?: string;
    /** 名字后面的小标记，例如「已合入主干」。 */
    tag?: string;
    tagTone?: "ok" | "info";
  }

  /** 后果说明：ok 是让人放心的（不会丢提交），warn 是不可逆的，info 是补充。 */
  export interface ConfirmNote {
    tone: "ok" | "info" | "warn";
    text: string;
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { visibleRange } from "../layout";
  import { BUSY_REASON } from "../ui";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  /**
   * 删除、中止、放弃这类需要确认的操作共用的对话框，版式固定：
   * 一句话说清要做什么 → 受影响的对象 → 后果（能不能找回、会不会影响别人）→ 右下角「取消 / 具体动作」。
   * 危险操作默认把焦点放在「取消」上，回车不会误删；写入进行中锁住关闭，按钮上转圈。
   * 失败时由调用方决定是留在对话框里显示 error，还是收起后在原处说明。
   */
  interface Props {
    title: string;
    titleId: string;
    icon?: IconName;
    tone?: "danger" | "warning" | "default";
    size?: "sm" | "md" | "lg";
    /** 标题下方的一句话。 */
    message?: string;
    targets?: ConfirmTarget[];
    /** 受影响对象清单的可访问名称。 */
    targetsLabel?: string;
    notes?: ConfirmNote[];
    confirmLabel: string;
    confirmIcon?: IconName;
    cancelLabel?: string;
    /** 确认按钮不可用的原因（例如还没选文件）；为空表示可用。 */
    confirmBlocked?: string | null;
    /** 写入进行中：按钮转圈，取消、Esc 和右上角关闭都不生效。 */
    busy?: boolean;
    error?: string | null;
    /** 初始焦点：危险操作默认落在取消上；表单类内容可以交给正文里的 data-autofocus。 */
    focus?: "cancel" | "confirm" | "body";
    /** 内容变了（例如升级成强删确认）时把焦点重新放回初始位置。 */
    focusKey?: unknown;
    /** 测试与样式钩子：写在正文容器的 data-modal-impact 上。 */
    impact?: string;
    onConfirm: () => void;
    onCancel: () => void;
    /**
     * 写入进行中也允许取消（远程操作卡在网络或凭据上时）：提供时「取消」、Esc 和右上角关闭
     * 在 busy 时调用它，而不是被锁住。调用方负责真正停下操作并在结束后收起对话框。
     */
    onAbort?: () => void;
    /** 已请求取消、正在等待操作停下。 */
    aborting?: boolean;
    children?: Snippet;
  }

  let {
    title,
    titleId,
    icon = "trash",
    tone = "danger",
    size = "sm",
    message = "",
    targets = [],
    targetsLabel = "受影响的对象",
    notes = [],
    confirmLabel,
    confirmIcon,
    cancelLabel = "取消",
    confirmBlocked = null,
    busy = false,
    error = null,
    focus,
    focusKey,
    impact,
    onConfirm,
    onCancel,
    onAbort,
    aborting = false,
    children,
  }: Props = $props();

  let abortable = $derived(busy && Boolean(onAbort));

  function dismiss() {
    if (busy) {
      if (onAbort && !aborting) onAbort();
      return;
    }
    onCancel();
  }

  let cancelButton = $state<HTMLButtonElement | null>(null);
  let confirmButton = $state<HTMLButtonElement | null>(null);
  let initialFocus = $derived(focus ?? (tone === "danger" ? "cancel" : "confirm"));

  const NOTE_ICON: Record<ConfirmNote["tone"], IconName> = { ok: "check-circle", info: "info", warn: "alert" };

  /*
   * 受影响的对象可能有几千个（中止一次大合并、放弃整个工作区）：清单按视口只渲染附近的行，
   * 行高固定（带说明两行、不带一行），上下用占位撑出滚动高度，屏幕阅读器靠 aria-setsize 知道总数。
   */
  let listScroll = $state(0);
  let listViewport = $state(0);
  let rowHeight = $derived(targets.some((target) => target.detail) ? 46 : 32);
  let range = $derived(visibleRange(targets.length, listScroll, listViewport, rowHeight));
  let shownTargets = $derived(targets.slice(range.start, range.end));

  function placeFocus() {
    if (initialFocus === "cancel") cancelButton?.focus();
    else if (initialFocus === "confirm" && confirmButton && !confirmButton.disabled) confirmButton.focus();
  }

  // Modal 先把焦点放到正文第一个可聚焦元素；这里在它之后按约定改到取消或确认上。
  onMount(placeFocus);

  let seenKey: unknown = untrack(() => focusKey);
  $effect(() => {
    const key = focusKey;
    if (key === seenKey) return;
    seenKey = key;
    void tick().then(placeFocus);
  });

  function confirm() {
    if (busy || confirmBlocked) return;
    onConfirm();
  }
</script>

<Modal {title} {titleId} {icon} tone={tone === "default" ? "default" : tone} {size} locked={busy && !abortable} onClose={dismiss}>
  <div class="confirm-body" data-modal-impact={impact}>
    {#if message}<p class="confirm-message">{message}</p>{/if}
    {#if targets.length > 0}
      {#if targets.length > 3}<div class="confirm-targets-caption">{targetsLabel}<span class="count">{targets.length}</span></div>{/if}
      <ul
        class="confirm-targets"
        aria-label={targetsLabel}
        style={`--confirm-row:${rowHeight}px`}
        bind:clientHeight={listViewport}
        onscroll={(event) => {
          listScroll = event.currentTarget.scrollTop;
          listViewport = event.currentTarget.clientHeight;
        }}
      >
        {#if range.start > 0}<li class="confirm-spacer" aria-hidden="true" style={`height:${range.start * rowHeight}px`}></li>{/if}
        {#each shownTargets as target, offset (`${range.start + offset}:${target.name}`)}
          <li title={target.detail ? `${target.name}\n${target.detail}` : target.name} aria-setsize={targets.length} aria-posinset={range.start + offset + 1}>
            <span class="confirm-target-icon"><Icon name={target.icon} size={14} /></span>
            <span class="confirm-target-main">
              <span class="confirm-target-name">{target.name}</span>
              {#if target.detail}<span class="confirm-target-detail">{target.detail}</span>{/if}
            </span>
            {#if target.tag}<span class={`confirm-target-tag ${target.tagTone ?? "info"}`}>{target.tag}</span>{/if}
          </li>
        {/each}
        {#if range.end < targets.length}<li class="confirm-spacer" aria-hidden="true" style={`height:${(targets.length - range.end) * rowHeight}px`}></li>{/if}
      </ul>
    {/if}
    {@render children?.()}
    {#if notes.length > 0}
      <ul class="confirm-notes">
        {#each notes as note, index (index)}
          <li class={note.tone}><Icon name={NOTE_ICON[note.tone]} size={14} /><span>{note.text}</span></li>
        {/each}
      </ul>
    {/if}
    {#if error}
      <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{error}</span></div>
    {/if}
  </div>
  {#snippet footer()}
    {#if abortable}
      <span class="confirm-progress" role="status">
        {#if aborting}正在停止，等待 Git 退出…{:else}正在执行，可以随时取消{/if}
      </span>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="btn btn-secondary"
      title={busy ? (abortable ? (aborting ? "正在停止" : "停止这次操作") : "写入完成后才能取消") : undefined}
      disabled={busy && (!abortable || aborting)}
      bind:this={cancelButton}
      onclick={dismiss}
    >{#if aborting}<span class="spinner"></span>正在取消{:else}{cancelLabel}{/if}</button>
    <button
      type="button"
      class={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
      title={busy ? BUSY_REASON : (confirmBlocked ?? undefined)}
      disabled={busy || Boolean(confirmBlocked)}
      aria-busy={busy}
      bind:this={confirmButton}
      onclick={confirm}
    >
      {#if busy}<span class="spinner"></span>{:else if confirmIcon}<Icon name={confirmIcon} size={14} />{/if}{confirmLabel}
    </button>
  {/snippet}
</Modal>
