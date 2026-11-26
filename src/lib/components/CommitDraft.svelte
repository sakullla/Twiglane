<script module lang="ts">
  /** 说明框高度（px）：可拖动提交区上沿调整，记在本机，重启后保持。 */
  export const MESSAGE_HEIGHT_DEFAULT = 112;
  export const MESSAGE_HEIGHT_MIN = 56;
  export const MESSAGE_HEIGHT_MAX = 520;
  /** 静止且没有内容时说明框只占一行，把高度让给文件列表（R4）。 */
  export const MESSAGE_HEIGHT_COMPACT = 36;
  const STORAGE_KEY = "twiglane.commitMessageHeight";

  export interface RecentCommitMessage {
    oid: string;
    summary: string;
    /** 完整提交说明（含正文）；缺省时退回 summary。 */
    message?: string;
  }

  export const DEFAULT_CONVENTIONAL_PREFIXES = ["feat:", "fix:", "refactor:", "docs:", "chore:"] as const;

  const CONVENTIONAL_PREFIX_RE = /^\s*([a-z][a-z0-9-]{1,15})(?:\([^)]+\))?:\s*/i;

  /** 从近期提交中提取最常用的规范前缀，不足时以默认前缀补齐。 */
  export function extractConventionalPrefixes(messages: readonly RecentCommitMessage[], limit = 5): string[] {
    const counts = new Map<string, number>();
    for (const item of messages) {
      const firstLine = (item.summary || item.message || "").split("\n")[0] ?? "";
      const match = firstLine.match(CONVENTIONAL_PREFIX_RE);
      if (!match) continue;
      const prefix = `${match[1].toLowerCase()}:`;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([prefix]) => prefix);
    const result: string[] = [];
    for (const prefix of [...ranked, ...DEFAULT_CONVENTIONAL_PREFIXES]) {
      if (!result.includes(prefix)) result.push(prefix);
      if (result.length >= limit) break;
    }
    return result;
  }

  /** 在提交说明首行插入或替换规范前缀，保留其余摘要与正文内容。 */
  export function applyConventionalPrefix(current: string, prefix: string): string {
    const newline = current.indexOf("\n");
    const first = newline === -1 ? current : current.slice(0, newline);
    const rest = newline === -1 ? "" : current.slice(newline);
    const nextFirst = CONVENTIONAL_PREFIX_RE.test(first)
      ? first.replace(CONVENTIONAL_PREFIX_RE, `${prefix} `)
      : `${prefix} ${first.trimStart()}`;
    return `${nextFirst}${rest}`;
  }

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
  import { openModalCount } from "./Modal.svelte";

  /**
   * 提交区：范围标签 → 一个说明框（第一行是摘要）→ 一行状态 → 主次两个按钮。
   * 目标分支不再重复画胶囊：顶栏常驻当前分支，提交按钮的说明里同样点名目标。
   * 说明框静止时只占一行，聚焦或有内容时展开到记住的高度。
   *
   * 提交区上沿是一条可拖动的分隔线：向上拖把说明框拉高、向下拖还给文件列表，
   * 键盘聚焦后用 ↑/↓ 调整、Home/End 到最小/最大，双击恢复默认高度。
   * 不能提交时就地一行原因；暂存区空着而工作区有改动时顺手给出「全部暂存」。
   * 低频动作（处理冲突、撤销提交、放弃修改、同步与发布）收进右上角的「更多」菜单。
   */
  interface Props {
    branch: string;
    detached?: boolean;
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
    /** 近期提交说明列表（可选，静态传入或作为默认回退）。 */
    recentMessages?: RecentCommitMessage[];
    /** 按需读取当前仓库最近提交说明（最多取前 10 条）。 */
    onLoadRecentMessages?: () => Promise<RecentCommitMessage[]>;
    /** 当前仓库是否满足修订最近一次提交（本地未推送普通 HEAD）的条件。 */
    canAmend?: boolean;
    /** 触发修订最近提交（Amend）预览与确认流。 */
    onAmend?: () => void;
    /** 溢出菜单内容：由外壳注入，参数用来收起菜单并把焦点还给「更多」按钮。 */
    overflow?: Snippet<[() => void]>;
  }

  let {
    branch,
    detached = false,
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
    recentMessages,
    onLoadRecentMessages,
    canAmend = false,
    onAmend,
    overflow,
  }: Props = $props();

  const SUMMARY_SOFT = 50;
  const SUMMARY_HARD = 72;
  const KEY_STEP = 16;
  /** 按下后移动不到这个距离算点击，手抖不改写记住的高度。 */
  const DRAG_SLOP = 3;
  const FILE_LIST_RESERVE = 300;
  /**
   * 超过这个长度（或带换行）的失败原因单行一定读不全：钩子输出、索引锁路径和
   * 远程错误经常这么长。这类原因默认仍占一行，但提供可键盘操作的展开入口（R3）。
   */
  const ERROR_EXPAND_CHARS = 56;

  let summaryChars = $derived(summaryLength(value));
  let moreOpen = $state(false);
  let moreAnchor = $state<HTMLDivElement | null>(null);
  let moreButton = $state<HTMLButtonElement | null>(null);
  let moreMenu = $state<HTMLDivElement | null>(null);
  let section = $state<HTMLElement | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let menuStyle = $state("");
  let height = $state(readStoredHeight());
  /** 拖动中的显示高度：从按下时看到的高度起算，所以收起态开始拖也不会跳变。 */
  let dragHeight = $state<number | null>(null);
  let dragging = $derived(dragHeight !== null);
  /** 用户正在写说明或调高度。只由说明框和分隔线打开，点提交区里的按钮不改变布局，否则按钮会在按下时移位。 */
  let active = $state(false);
  let expanded = $derived(active || value.length > 0);
  let shownHeight = $derived(dragHeight ?? (expanded ? height : MESSAGE_HEIGHT_COMPACT));
  let historyOpen = $state(false);
  let historyAnchor = $state<HTMLDivElement | null>(null);
  let historyButton = $state<HTMLButtonElement | null>(null);
  let historyStyle = $state("");
  let historyLoading = $state(false);
  let historyError = $state<string | null>(null);
  let loadedRecent = $state<RecentCommitMessage[] | null>(null);
  let pendingRecent = $state<{ summary: string; text: string } | null>(null);
  let historyRequestSeq = 0;
  let recentSource = $derived((loadedRecent ?? recentMessages ?? []).slice(0, 10));
  let hasHistoryEntry = $derived(Boolean(onLoadRecentMessages || (recentMessages && recentMessages.length > 0)));
  let prefixes = $derived(extractConventionalPrefixes(recentSource));
  let committing = $derived(busy === "commit" || busy === "commit-push");
  let retryingPush = $derived(busy === "push");
  let ready = $derived(hasCommitSummary(value) && paths.length > 0 && !disabled);
  let blocker = $derived(
    paths.length === 0 ? "先暂存要提交的文件" : !hasCommitSummary(value) ? "填写提交说明后即可提交" : "",
  );
  let counterTone = $derived(summaryChars > SUMMARY_HARD ? "over" : summaryChars > SUMMARY_SOFT ? "near" : "");
  /**
   * 展开的是哪一条原因（提交失败 / 推送失败）。用原因文本本身做键：新的失败原因到达时
   * 旧展开状态自动失效，不会把上一条错误的展开结果套到这一条上。
   */
  let expandedError = $state<string | null>(null);
  let errorOpen = $derived(error !== null && expandedError !== null && expandedError === error);
  let pushOpen = $derived(pushError !== null && expandedError !== null && expandedError === pushError);
  let errorLong = $derived(error !== null && needsExpansion(error));
  let pushLong = $derived(pushError !== null && needsExpansion(pushError));

  function needsExpansion(text: string): boolean {
    return text.length > ERROR_EXPAND_CHARS || text.includes("\n");
  }

  function toggleError(text: string | null) {
    if (text === null) return;
    expandedError = expandedError === text ? null : text;
  }

  $effect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (openModalCount() > 0 || moreMenu?.querySelector("[data-modal-backdrop]")) return;
      if (moreAnchor && !moreAnchor.contains(event.target as Node)) moreOpen = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || openModalCount() > 0 || moreMenu?.querySelector("[data-modal-backdrop]")) return;
      event.preventDefault();
      void closeMore();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  /** 分支、静态近期列表或加载回调变化时失效旧缓存与在途请求，防止跨仓/跨分支残留。 */
  $effect(() => {
    void branch;
    void recentMessages;
    void onLoadRecentMessages;
    historyRequestSeq += 1;
    loadedRecent = null;
    historyError = null;
    historyLoading = false;
    pendingRecent = null;
  });

  /** 最近提交说明弹层：点击外部收起，Esc 优先取消覆盖确认再收起并归还焦点。 */
  $effect(() => {
    if (!historyOpen) return;
    const close = (event: MouseEvent) => {
      if (openModalCount() > 0) return;
      if (historyAnchor && !historyAnchor.contains(event.target as Node)) {
        historyRequestSeq += 1;
        historyOpen = false;
        historyLoading = false;
        pendingRecent = null;
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || openModalCount() > 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (pendingRecent) {
        pendingRecent = null;
        return;
      }
      void closeHistory(true);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  async function toggleHistory() {
    if (historyOpen) {
      historyRequestSeq += 1;
      historyOpen = false;
      historyLoading = false;
      pendingRecent = null;
      return;
    }
    moreOpen = false;
    pendingRecent = null;
    historyError = null;
    const rect = historyButton?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      const width = Math.min(320, Math.max(200, window.innerWidth - 16));
      const left = Math.round(Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8)));
      const bottom = Math.max(8, Math.round(window.innerHeight - rect.top + 6));
      const room = Math.max(180, Math.min(340, Math.round(rect.top - 16)));
      historyStyle = `position:fixed;top:auto;left:${left}px;right:auto;bottom:${bottom}px;max-height:${room}px`;
    }
    historyOpen = true;
    if (onLoadRecentMessages) {
      const seq = ++historyRequestSeq;
      const loader = onLoadRecentMessages;
      historyLoading = true;
      try {
        const loaded = (await loader()).slice(0, 10);
        if (seq !== historyRequestSeq) return;
        loadedRecent = loaded;
      } catch (caught) {
        if (seq !== historyRequestSeq) return;
        historyError = caught instanceof Error ? caught.message : "读取最近提交说明失败";
      } finally {
        if (seq === historyRequestSeq) historyLoading = false;
      }
    }
  }

  async function closeHistory(restoreFocus = false) {
    historyRequestSeq += 1;
    historyOpen = false;
    historyLoading = false;
    pendingRecent = null;
    if (restoreFocus) {
      await tick();
      historyButton?.focus();
    }
  }

  async function applyDraftText(next: string) {
    onInput(next);
    historyOpen = false;
    pendingRecent = null;
    active = true;
    await tick();
    textarea?.focus();
  }

  function pickRecent(item: RecentCommitMessage) {
    const text = (item.message ?? item.summary).trim();
    if (!text) return;
    if (value.trim() === "" || value.trim() === text) {
      void applyDraftText(text);
      return;
    }
    pendingRecent = { summary: item.summary, text };
  }

  function confirmRecent(mode: "replace" | "append") {
    if (!pendingRecent) return;
    const next =
      mode === "replace"
        ? pendingRecent.text
        : `${value.replace(/\s+$/u, "")}\n\n${pendingRecent.text}`;
    void applyDraftText(next);
  }

  async function insertPrefix(prefix: string) {
    if (disabled) return;
    onInput(applyConventionalPrefix(value, prefix));
    active = true;
    await tick();
    textarea?.focus();
  }

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

  function moreMenuItems(): HTMLButtonElement[] {
    if (!moreMenu) return [];
    return [...moreMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  }

  /**
   * 菜单固定定位到按钮上方：文件列表面板是 overflow:hidden，绝对定位的菜单会被裁掉
   * （最窄 160px 时只剩一条缝）。向上展开、右对齐按钮，并按可用高度限制菜单高度。
   */
  async function toggleMore(focusEdge?: "first" | "last") {
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
    if (focusEdge) {
      await tick();
      const items = moreMenuItems();
      (focusEdge === "last" ? items[items.length - 1] : items[0])?.focus();
    }
  }

  function onMoreMenuKey(event: KeyboardEvent) {
    if (openModalCount() > 0 || moreMenu?.querySelector("[data-modal-backdrop]")) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = moreMenuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") {
      items[0]?.focus();
      return;
    }
    if (event.key === "End") {
      items[items.length - 1]?.focus();
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
    items[next]?.focus();
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
    <!-- 摘要字数放在范围标签这一行的空位里：不再为它常驻一条状态行，开始打字时按钮也不会被顶下去。 -->
    {#if summaryChars > 0}
      <span
        class={`composer-count ${counterTone}`}
        title={`第一行是摘要：建议不超过 ${SUMMARY_SOFT} 个字符，最多 ${SUMMARY_HARD} 个`}
        aria-label={`摘要 ${summaryChars} 个字符`}
      ><span class="composer-count-label">{"摘要 "}</span>{summaryChars}/{SUMMARY_HARD}</span>
    {/if}
    {#if onAmend && canAmend}
      <button
        type="button"
        class="composer-amend"
        disabled={disabled}
        aria-label="修订最近提交"
        title={disabled ? BUSY_REASON : "修订最近一次未推送的本地提交（Amend）"}
        onclick={onAmend}
      >
        <Icon name="pencil" size={12} />
        <span>修订</span>
      </button>
    {/if}
    {#if hasHistoryEntry}
      <div class="menu-anchor composer-history-anchor" bind:this={historyAnchor}>
        <button
          type="button"
          class="icon-btn sm composer-history-btn"
          disabled={disabled}
          aria-label="最近提交说明"
          aria-haspopup="dialog"
          aria-expanded={historyOpen}
          title={disabled ? BUSY_REASON : "参考或填入最近提交说明"}
          bind:this={historyButton}
          onclick={() => void toggleHistory()}
        >
          <Icon name="history" size={14} />
        </button>
        {#if historyOpen}
          <div
            class="menu composer-history-popover"
            role="dialog"
            aria-label="最近提交说明"
            style={historyStyle}
          >
            <div class="composer-history-head">
              <strong>最近提交说明</strong>
              <button
                type="button"
                class="icon-btn sm"
                aria-label="关闭最近提交说明"
                onclick={() => void closeHistory(true)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
            {#if pendingRecent}
              <div class="composer-history-confirm" role="alertdialog" aria-label="确认填入提交说明">
                <p class="composer-history-confirm-title">当前已有提交说明草稿，请选择填入方式：</p>
                <p class="composer-history-confirm-preview">{pendingRecent.summary}</p>
                <div class="composer-history-confirm-actions">
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    onclick={() => confirmRecent("replace")}
                  >替换当前草稿</button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    onclick={() => confirmRecent("append")}
                  >追加到末尾</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onclick={() => (pendingRecent = null)}
                  >取消</button>
                </div>
              </div>
            {:else if historyLoading}
              <p class="composer-history-empty" role="status">
                <span class="spinner" aria-hidden="true"></span>
                <span>正在读取最近提交…</span>
              </p>
            {:else if historyError}
              <p class="composer-history-empty danger" role="alert">{historyError}</p>
            {:else if recentSource.length === 0}
              <p class="composer-history-empty" role="status">暂无可参考的最近提交</p>
            {:else}
              <div class="composer-history-list" role="list">
                {#each recentSource as item (item.oid)}
                  {@const full = (item.message ?? item.summary).trim()}
                  {@const hasBody = full.includes("\n")}
                  <button
                    type="button"
                    class="composer-history-item"
                    title={full}
                    onclick={() => pickRecent(item)}
                  >
                    <span class="composer-history-oid">{item.oid.slice(0, 7)}</span>
                    <span class="composer-history-summary">{item.summary}</span>
                    {#if hasBody}
                      <span class="composer-history-tag" aria-label="含详细说明">含正文</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
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
          onclick={(event) => void toggleMore(event.detail === 0 ? "first" : undefined)}
          onkeydown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!moreOpen) void toggleMore("first");
              else moreMenuItems()[0]?.focus();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              if (!moreOpen) void toggleMore("last");
              else {
                const items = moreMenuItems();
                items[items.length - 1]?.focus();
              }
            }
          }}
        >
          <Icon name="more" size={15} />
        </button>
        {#if moreOpen}
          <div
            class="menu composer-more-menu"
            role="menu"
            tabindex="-1"
            aria-label="更多提交操作"
            style={menuStyle}
            bind:this={moreMenu}
            onkeydown={onMoreMenuKey}
          >
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
      onkeydown={(event) => {
        if (event.isComposing) return;
        if (ready && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onCommit();
          return;
        }
        if (event.key === "Escape" && !value) {
          event.preventDefault();
          event.stopPropagation();
          active = false;
          textarea?.blur();
        }
      }}
    ></textarea>
    {#if expanded}
      <div class="composer-prefixes" role="group" aria-label="快捷规范前缀">
        {#each prefixes as prefix (prefix)}
          <button
            type="button"
            class="composer-prefix-chip"
            disabled={disabled}
            aria-label={`插入前缀 ${prefix}`}
            title={disabled ? BUSY_REASON : `在首行插入或替换为 ${prefix}`}
            onclick={() => void insertPrefix(prefix)}
          >{prefix}</button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- 状态行只在有话要说时出现（没暂存 / 提交失败），平时不占高度。 -->
  {#if paths.length === 0 || error}
  <div class="composer-meta" class:warn={paths.length === 0} class:expanded={errorOpen}>
    {#if paths.length === 0}
      <!-- 只有「没暂存」这种看不出来的原因才就地写一行；说明框空着一眼可见，原因留在按钮提示里。 -->
      <Icon name="info" size={12} />
      <span class="truncate" data-commit-blocker title={blocker}>{blocker}</span>
    {:else if error}
      <!-- R5：提交失败（缺身份 / 钩子拒绝 / 索引锁 / 过期）同样在这块就地说明。
           优先级低于 blocker：按钮又变成灰的时候，「为什么点不动」更要紧。
           R3：长原因默认仍是一行，但给出可见、可键盘访问的展开/收起，不再只有 title 能读全。 -->
      <Icon name="alert-circle" size={12} />
      <span class="composer-error" class:expanded={errorOpen} data-commit-error title={error}>{error}</span>
      {#if errorLong}
        <button
          type="button"
          class="composer-inline-action composer-expand"
          aria-expanded={errorOpen}
          aria-label={errorOpen ? "收起提交失败原因" : "展开完整提交失败原因"}
          title={errorOpen ? "收起失败原因" : "展开完整失败原因（可换行读全）"}
          onclick={() => toggleError(error)}
        >
          {errorOpen ? "收起" : "展开"}
        </button>
      {/if}
    {/if}
    {#if paths.length === 0 && stageableCount > 0 && onStageAll}
      <button type="button" class="composer-inline-action" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={onStageAll}>
        全部暂存 {stageableCount}
      </button>
    {/if}
  </div>
  {/if}

  {#if pushError}
    <!-- 两个阶段分开说明：本地提交已完成，失败只在推送；重试入口只推送，不会再次提交（R6）。
         R3：远程错误常见长文本，这里同样可以展开换行读全。 -->
    <div class="composer-meta" data-push-error class:expanded={pushOpen}>
      <Icon name="alert-circle" size={12} />
      <span class="composer-error" class:expanded={pushOpen} role="status" title={pushError}>{pushError}</span>
      {#if pushLong}
        <button
          type="button"
          class="composer-inline-action composer-expand"
          aria-expanded={pushOpen}
          aria-label={pushOpen ? "收起推送失败原因" : "展开完整推送失败原因"}
          title={pushOpen ? "收起失败原因" : "展开完整失败原因（可换行读全）"}
          onclick={() => toggleError(pushError)}
        >
          {pushOpen ? "收起" : "展开"}
        </button>
      {/if}
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

  {#if detached}
    <div class="composer-meta warn" data-commit-detached role="status">
      <Icon name="info" size={12} />
      <span class="truncate" title="当前处于游离 HEAD，新提交不会推进任何分支；需要保留时请新建分支">游离 HEAD：新提交不归属任何分支，需要保留请新建分支</span>
    </div>
  {/if}

  <div class="composer-actions">
    <button
      type="button"
      class="btn btn-primary composer-commit"
      aria-label="提交到本地"
      title={blocker || `提交到本地分支 ${branch}，不会推送（${MODIFIER_LABEL}+Enter）`}
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

<style>
  .composer-amend {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    height: var(--control-pill);
    padding: 0 var(--space-6);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-xs);
    background: var(--surface);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: var(--transition-interactive);
  }

  .composer-amend:hover:not(:disabled) {
    border-color: var(--control-border-hover);
    background: var(--hover);
    color: var(--fg);
  }

  .composer-amend:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -1px;
  }

  .composer-amend:disabled {
    opacity: var(--opacity-disabled);
    cursor: not-allowed;
  }

  .composer-history-anchor {
    position: relative;
  }

  .composer-history-popover {
    width: min(320px, calc(100vw - 16px));
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    overflow: hidden;
    z-index: var(--z-menu);
  }

  .composer-history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
    color: var(--fg-muted);
  }

  .composer-history-head strong {
    font-weight: var(--weight-semibold);
    color: var(--fg);
  }

  .composer-history-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow-y: auto;
    max-height: 240px;
  }

  .composer-history-item {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    width: 100%;
    padding: var(--space-6) var(--space-8);
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: var(--transition-colors);
  }

  .composer-history-item:hover {
    background: var(--hover);
  }

  .composer-history-item:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }

  .composer-history-oid {
    flex: none;
    font-family: var(--mono);
    font-size: var(--text-xs);
    color: var(--fg-subtle);
  }

  .composer-history-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-history-tag {
    flex: none;
    padding: 0 var(--space-4);
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    color: var(--fg-muted);
    font-size: var(--text-xs);
  }

  .composer-history-empty {
    margin: 0;
    padding: var(--space-12) var(--space-8);
    display: flex;
    align-items: center;
    gap: var(--space-6);
    font-size: var(--text-sm);
    color: var(--fg-muted);
  }

  .composer-history-empty.danger {
    color: var(--danger);
  }

  .composer-history-confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    padding: var(--space-6);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }

  .composer-history-confirm-title {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--fg-muted);
  }

  .composer-history-confirm-preview {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-history-confirm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-6);
  }

  .composer-prefixes {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-top: var(--space-4);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .composer-prefix-chip {
    flex: none;
    height: var(--control-pill);
    padding: 0 var(--space-6);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: var(--transition-interactive);
  }

  .composer-prefix-chip:hover:not(:disabled) {
    border-color: var(--control-border-hover);
    background: var(--accent-softer);
    color: var(--accent-text);
  }

  .composer-prefix-chip:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -1px;
  }

  .composer-prefix-chip:disabled {
    opacity: var(--opacity-disabled);
    cursor: not-allowed;
  }
</style>
