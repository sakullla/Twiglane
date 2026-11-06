<script module lang="ts">
  /** 说明框高度（px）：可拖动提交区上沿调整，记在本机，重启后保持。 */
  export const MESSAGE_HEIGHT_DEFAULT = 112;
  export const MESSAGE_HEIGHT_MIN = 56;
  export const MESSAGE_HEIGHT_MAX = 520;
  /** 静止且没有内容时说明框只占一行，把高度让给文件列表（R4）。 */
  export const MESSAGE_HEIGHT_COMPACT = 36;
  const STORAGE_KEY = "twiglane.commitMessageHeight";

  export function clampMessageHeight(value: number, max = MESSAGE_HEIGHT_MAX): number {
    const upper = Math.max(MESSAGE_HEIGHT_MIN, Math.min(MESSAGE_HEIGHT_MAX, max));
    return Math.round(Math.min(upper, Math.max(MESSAGE_HEIGHT_MIN, value)));
  }

  function readStoredHeight(): number {
    try {
      const raw = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
      return Number.isFinite(raw) && raw > 0 ? clampMessageHeight(raw) : MESSAGE_HEIGHT_DEFAULT;
    } catch {
      return MESSAGE_HEIGHT_DEFAULT;
    }
  }

  function storeHeight(value: number): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, String(value));
    } catch {
      // 存储不可用时只在本次会话里生效。
    }
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import { BUSY_REASON, hasCommitSummary, summaryLength } from "../ui";
  import Icon from "./Icon.svelte";

  /**
   * 提交区：目标分支与范围两枚标签 → 一个说明框（第一行是摘要）→ 一行状态 → 主次两个按钮。
   * 说明框静止时只占一行，聚焦或有内容时展开到记住的高度。
   *
   * 提交区上沿是一条可拖动的分隔线：向上拖把说明框拉高、向下拖还给文件列表，
   * 键盘聚焦后用 ↑/↓ 调整、Home/End 到最小/最大，双击恢复默认高度。
   * 不能提交时就地一行原因；暂存区空着而工作区有改动时顺手给出「全部暂存」。
   * 低频动作（处理冲突、撤销提交、放弃修改、同步与发布）收进右上角的「更多」菜单。
   */
  interface Props {
    branch: string;
    scope: string;
    paths: string[];
    value: string;
    disabled: boolean;
    busy?: string | null;
    /**
     * 上一次提交失败的原因（R5）：缺身份、钩子拒绝、索引锁或过期都走这里。
     * 与右下角通知条同源，但提交区里必须也留一份可见文本，通知条不能是唯一渠道。
     */
    error?: string | null;
    /**
     * 本地提交已经完成、但后续推送失败时的原因（R6）。提交区把两个阶段分开说明，
     * 并提供一个只重试推送的入口；重试不会再次创建本地提交。
     */
    pushError?: string | null;
    /** 只重试推送；由外壳复用同一条推送路径，不重跑本地提交。 */
    onRetryPush?: () => void;
    /** 可以一键暂存的文件数（未暂存且非冲突）。暂存区为空时提供「全部暂存」。 */
    stageableCount?: number;
    onStageAll?: () => void;
    onInput: (value: string) => void;
    onBlur: () => void;
    onCommit: () => void;
    onCommitPush?: () => void;
    /** 打开「本次提交范围」modal。 */
    onScope?: () => void;
    /** 溢出菜单内容：由外壳注入，参数用来收起菜单并把焦点还给「更多」按钮。 */
    overflow?: Snippet<[() => void]>;
  }

  let {
    branch,
    scope,
    paths,
    value,
    disabled,
    busy = null,
    error = null,
    pushError = null,
    onRetryPush,
    stageableCount = 0,
    onStageAll,
    onInput,
    onBlur,
    onCommit,
    onCommitPush,
    onScope,
    overflow,
  }: Props = $props();

  const SUMMARY_SOFT = 50;
  const SUMMARY_HARD = 72;
  const KEY_STEP = 16;
  /** 按下后移动不到这个距离算点击，手抖不改写记住的高度。 */
  const DRAG_SLOP = 3;
  const FILE_LIST_RESERVE = 300;

  let summaryChars = $derived(summaryLength(value));
  let moreOpen = $state(false);
  let moreAnchor = $state<HTMLDivElement | null>(null);
  let moreButton = $state<HTMLButtonElement | null>(null);
  let section = $state<HTMLElement | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let menuStyle = $state("");
  let height = $state(readStoredHeight());
  /** 拖动中的显示高度：从按下时看到的高度起算，所以收起态开始拖也不会跳变。 */
  let dragHeight = $state<number | null>(null);
  let dragging = $derived(dragHeight !== null);
  /** 用户正在写说明或调高度。只由说明框和分隔线打开，点提交区里的按钮不改变布局，否则按钮会在按下时移位。 */
  let active = $state(false);
  let shownHeight = $derived(dragHeight ?? (active || value.length > 0 ? height : MESSAGE_HEIGHT_COMPACT));
  let committing = $derived(busy === "commit" || busy === "commit-push");
  let retryingPush = $derived(busy === "push");
  let ready = $derived(hasCommitSummary(value) && paths.length > 0 && !disabled);
  let blocker = $derived(
    paths.length === 0 ? "先暂存要提交的文件" : !hasCommitSummary(value) ? "填写提交说明后即可提交" : "",
  );
  let counterTone = $derived(summaryChars > SUMMARY_HARD ? "over" : summaryChars > SUMMARY_SOFT ? "near" : "");

  $effect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (moreAnchor && !moreAnchor.contains(event.target as Node)) moreOpen = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") moreOpen = false;
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  /** 按提交区外的位置或焦点离开时才收起，提交区内的点击不会让布局中途变化。 */
  $effect(() => {
    if (!active) return;
    const leave = (event: Event) => {
      if (section && !section.contains(event.target as Node)) active = false;
    };
    window.addEventListener("pointerdown", leave);
    window.addEventListener("focusin", leave);
    return () => {
      window.removeEventListener("pointerdown", leave);
      window.removeEventListener("focusin", leave);
    };
  });

  /**
   * 菜单固定定位到按钮上方：文件列表面板是 overflow:hidden，绝对定位的菜单会被裁掉
   * （最窄 160px 时只剩一条缝）。向上展开、右对齐按钮，并按可用高度限制菜单高度。
   */
  function toggleMore() {
    if (moreOpen) {
      moreOpen = false;
      return;
    }
    const rect = moreButton?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      const right = Math.max(8, window.innerWidth - rect.right);
      const bottom = Math.max(8, window.innerHeight - rect.top + 6);
      const room = Math.max(160, rect.top - 16);
      menuStyle = `position:fixed;top:auto;left:auto;right:${right}px;bottom:${bottom}px;max-height:${room}px`;
    }
    moreOpen = true;
  }

  async function closeMore() {
    moreOpen = false;
    await tick();
    moreButton?.focus();
  }

  /**
   * 说明框最多能长到多高：给上方留 FILE_LIST_RESERVE（标题、搜索框与至少四五行文件），
   * 窗口很矮时也不会把文件列表挤没。
   */
  function maxHeight(): number {
    const panel = section?.parentElement;
    if (!panel || !section || panel.clientHeight === 0) return MESSAGE_HEIGHT_MAX;
    // 两个值都从 DOM 读：状态刚切换、DOM 还没更新时，用状态相减会把提交区其余部分算错。
    const chrome = section.offsetHeight - (textarea?.offsetHeight || shownHeight);
    return panel.clientHeight - chrome - FILE_LIST_RESERVE;
  }

  function setHeight(next: number, persist = true) {
    height = clampMessageHeight(next, maxHeight());
    if (persist) storeHeight(height);
  }

  /**
   * 放不下时只在显示上收紧，不改写用户记住的偏好。可用空间不只随窗口变：栏宽改变会让
   * 按钮堆叠、提交区变高，隐藏后再显示左栏也不触发 resize，所以提交区和父面板都要观察。
   */
  $effect(() => {
    if (!section || typeof window === "undefined") return;
    const panel = section.parentElement;
    const fit = () => {
      // 隐藏的左栏宽度为 0，此时量出来的高度没有意义，等它显示回来再算。
      if (dragging || panel?.clientWidth === 0) return;
      height = clampMessageHeight(readStoredHeight(), maxHeight());
    };
    fit();
    window.addEventListener("resize", fit);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(section);
    if (panel) observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", fit);
      observer?.disconnect();
    };
  });

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    const startHeight = shownHeight;
    const wasActive = active;
    const fromCompact = startHeight < MESSAGE_HEIGHT_MIN;
    let moved = false;
    active = true;
    dragHeight = startHeight;
    handle.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => {
      const delta = startY - next.clientY;
      if (!moved && Math.abs(delta) < DRAG_SLOP) return;
      moved = true;
      const upper = clampMessageHeight(MESSAGE_HEIGHT_MAX, maxHeight());
      const lower = fromCompact ? MESSAGE_HEIGHT_COMPACT : MESSAGE_HEIGHT_MIN;
      dragHeight = Math.round(Math.min(upper, Math.max(lower, startHeight + delta)));
    };
    const up = () => {
      const final = dragHeight ?? startHeight;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      // 净变化为 0，或收起态没拖到最小高度：按点击处理，布局和记住的高度都不变。
      const committed = final !== startHeight && !(fromCompact && final < MESSAGE_HEIGHT_MIN);
      if (committed) setHeight(final);
      else active = wasActive;
      dragHeight = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  /** 收起态双击也要看得到结果，所以先展开再恢复默认高度。 */
  function resetHeight() {
    active = true;
    setHeight(MESSAGE_HEIGHT_DEFAULT);
  }

  function resizeKey(event: KeyboardEvent) {
    const steps: Record<string, number> = { ArrowUp: KEY_STEP, ArrowDown: -KEY_STEP, PageUp: KEY_STEP * 4, PageDown: -KEY_STEP * 4 };
    if (event.key in steps) {
      event.preventDefault();
      setHeight(height + steps[event.key]);
    } else if (event.key === "Home") {
      event.preventDefault();
      setHeight(MESSAGE_HEIGHT_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setHeight(MESSAGE_HEIGHT_MAX);
    }
  }
</script>

<section
  class="composer compact"
  aria-label="本地提交"
  class:busy={committing}
  class:resizing={dragging}
  bind:this={section}
>
  <!-- 上沿分隔线：整条都是拖动命中区（上下各延伸几像素），不只是那 1px。
       可聚焦、带取值的 separator 是 WAI-ARIA 的 window splitter 模式，本身就是可交互控件。 -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="composer-resizer"
    role="separator"
    tabindex="0"
    aria-orientation="horizontal"
    aria-label="调整提交说明高度"
    aria-valuemin={MESSAGE_HEIGHT_MIN}
    aria-valuemax={MESSAGE_HEIGHT_MAX}
    aria-valuenow={height}
    title="拖动调整高度，双击恢复默认"
    onpointerdown={startResize}
    onkeydown={resizeKey}
    onfocus={() => (active = true)}
    ondblclick={resetHeight}
  ></div>
  <span class="sr-only">{scope}</span>
  <div class="composer-head">
    <span class="composer-branch" title={`提交到 ${branch}`}>
      <Icon name="branch" size={12} /><span class="truncate">{branch}</span>
    </span>
    {#if onScope}
      <button
        type="button"
        class="composer-scope"
        class:empty-scope={paths.length === 0}
        aria-label={`本次提交范围：${paths.length} 个已暂存文件`}
        title="查看本次提交范围"
        onclick={onScope}
      >
        <Icon name="layers" size={12} />
        <span>{paths.length > 0 ? `${paths.length} 个文件` : "暂存区为空"}</span>
      </button>
    {/if}
    <span class="spacer"></span>
    {#if overflow}
      <div class="menu-anchor" bind:this={moreAnchor}>
        <button
          type="button"
          class="icon-btn sm composer-more"
          aria-label="更多提交操作"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title="更多：处理冲突、撤销提交、放弃修改与同步"
          bind:this={moreButton}
          onclick={toggleMore}
        >
          <Icon name="more" size={15} />
        </button>
        {#if moreOpen}
          <div class="menu composer-more-menu" role="menu" aria-label="更多提交操作" style={menuStyle}>
            {@render overflow(closeMore)}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="composer-box">
    <textarea
      name="commit-message"
      aria-label="提交说明草稿"
      placeholder="提交说明（第一行是摘要）"
      spellcheck="false"
      bind:this={textarea}
      style={`height:${shownHeight}px`}
      {value}
      title={disabled ? BUSY_REASON : undefined}
      disabled={disabled}
      onfocus={() => (active = true)}
      oninput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
      onblur={onBlur}
    ></textarea>
  </div>

  <div class="composer-meta" class:warn={paths.length === 0}>
    {#if blocker}
      <!-- R5：主按钮不可用时就地给出可见的一行原因，不只挂在 title 上；.truncate 保持单行。 -->
      <Icon name="info" size={12} />
      <span class="truncate" data-commit-blocker title={blocker}>{blocker}</span>
    {:else if error}
      <!-- R5：提交失败（缺身份 / 钩子拒绝 / 索引锁 / 过期）同样在这块就地说明。
           优先级低于 blocker：按钮又变成灰的时候，「为什么点不动」更要紧。 -->
      <Icon name="alert-circle" size={12} />
      <span class="truncate composer-error" data-commit-error title={error}>{error}</span>
    {:else}
      <Icon name="check-circle" size={12} />
      <span class="truncate composer-ready" title="说明会自动保存为草稿">可以提交 · 草稿自动保存</span>
    {/if}
    <!-- 摘要字数与「全部暂存」互不挤占：两者是不同的问题（写多长 / 暂存了没有），
         任何一个都不该因为另一个出现而消失。 -->
    {#if summaryChars > 0}
      <span
        class={`composer-count ${counterTone}`}
        title={`第一行是摘要：建议不超过 ${SUMMARY_SOFT} 个字符，最多 ${SUMMARY_HARD} 个`}
        aria-label={`摘要 ${summaryChars} 个字符`}
      >摘要 {summaryChars}/{SUMMARY_HARD}</span>
    {/if}
    {#if paths.length === 0 && stageableCount > 0 && onStageAll}
      <button type="button" class="composer-inline-action" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={onStageAll}>
        全部暂存 {stageableCount}
      </button>
    {/if}
  </div>

  {#if pushError}
    <!-- 两个阶段分开说明：本地提交已完成，失败只在推送；重试入口只推送，不会再次提交（R6）。 -->
    <div class="composer-meta" data-push-error>
      <Icon name="alert-circle" size={12} />
      <span class="truncate composer-error" role="status" title={pushError}>{pushError}</span>
      {#if onRetryPush}
        <button
          type="button"
          class="composer-inline-action"
          title={disabled || retryingPush ? BUSY_REASON : "只重试推送，不会再次创建本地提交"}
          disabled={disabled || retryingPush}
          onclick={onRetryPush}
        >
          {#if retryingPush}<span class="spinner" aria-hidden="true"></span>{/if}
          {retryingPush ? "正在重试推送…" : "重试推送"}
        </button>
      {/if}
    </div>
  {/if}

  <div class="composer-actions">
    <button
      type="button"
      class="btn btn-primary composer-commit"
      aria-label="提交到本地"
      title={blocker || `提交到本地，不会推送（${MODIFIER_LABEL}+Enter）`}
      disabled={!ready}
      onclick={onCommit}
    >
      {#if busy === "commit"}<span class="spinner"></span>{:else}<Icon name="check" size={15} />{/if}
      <span class="composer-commit-label">{busy === "commit" ? "正在提交…" : "提交到本地"}</span>
      <kbd aria-hidden="true">{MODIFIER_LABEL} ↵</kbd>
    </button>
    <button
      type="button"
      class="btn btn-secondary composer-push"
      aria-label="提交并推送"
      title={blocker || "先创建本地提交，再单独推送；推送失败不会重复提交"}
      disabled={!ready || !onCommitPush}
      onclick={() => onCommitPush?.()}
    >
      {#if busy === "commit-push"}<span class="spinner"></span>{:else}<Icon name="upload" size={15} />{/if}
      <span class="composer-push-label">提交并推送</span>
    </button>
  </div>
</section>
