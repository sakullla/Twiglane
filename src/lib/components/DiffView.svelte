<script lang="ts">
  import { tick, untrack } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import { hunkCaption, hunkJump, hunkRowIndexes, splitColumnsFit, toSideRows, visibleDiffLines, type HunkNavReport, type ViewLine } from "../diff";
  import { trackCodeScroll } from "../codeScroll.svelte";
  import { codeContentSize, codeRuler, rulerPadding, scrollByRows, visibleRange } from "../layout";
  import type { DiffHunk, DiffResponse, FileSelection } from "../types";
  import { BUSY_REASON, binarySizeText, sizeDelta, splitPath, type FileNavState } from "../ui";
  import { buildDiffDocuments, codeOf, signOf } from "../syntax/diffSyntax";
  import { createHighlight } from "../syntax/highlight.svelte";
  import { effectiveLanguage } from "../syntax/prefs.svelte";
  import { lineSegments } from "../syntax/segments";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import BinaryPreview from "./BinaryPreview.svelte";
  import FileNav from "./FileNav.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";

  interface Props {
    onGeneration?: (generation: number) => void;
    selection: FileSelection | null;
    diff: DiffResponse | null;
    error: string | null;
    loading: boolean;
    disabled: boolean;
    readOnly?: boolean;
    onStageHunk: (hunk: DiffHunk) => void;
    onLoadMore: () => void;
    onFileHistory?: (path: string) => void;
    /** 是否展开为完整文件（整份文件作上下文）；展开时不提供按块暂存。 */
    fullFile?: boolean;
    onFullFile?: (next: boolean) => void;
    /** 上一个/下一个文件；不传时工具栏不显示这组按钮。 */
    fileNav?: FileNavState | null;
    /**
     * 堆叠在多文件视图里：不画工具栏，纵向滚动交给外层 scrollHost（块内不再嵌套纵向滚动），
     * 虚拟窗口按本块在外层视口里的位置算；横向滚动仍是本块独立的。
     */
    embedded?: boolean;
    scrollHost?: HTMLElement | null;
    /** 外层统一决定的布局；不传时用工具栏自己的切换。 */
    layout?: "unified" | "split";
    /** embedded：块重新挂载时恢复的横向位置，以及位置变化的上报。 */
    scrollX?: number;
    onScrollX?: (left: number) => void;
    /** 工作区的改动文件数。为 0 时右侧空状态说「没有改动」，不再让用户去找一个不存在的文件。 */
    fileCount?: number;
    /** 差异读取失败后的重试入口；单文件视图才传，多文件视图按块自己重读。 */
    onRetry?: () => void;
    /**
     * 上报上一处/下一处改动。只给当前可见的单文件差异传；
     * 多文件和嵌入块不传，避免背后那一份把命令面板的可用性盖掉。
     */
    onHunkNav?: (nav: HunkNavReport | null) => void;
  }

  /**
   * 行高 18px：R3 要求 1280×840 下同屏差异至少完全可见 40 行。差异滚动区在该尺寸下实测
   * 738px 高，18px 放下 41 行；16px 能放更多但 12px 代码挤在一起难读，22px 只剩 33 行。
   * 密度由这里和 `components.css` 的 `.diff.dense` 一起决定，两处必须同步。
   */
  const ROW_HEIGHT = 18;

  let {
    onGeneration,
    selection,
    diff,
    error,
    loading,
    disabled,
    readOnly = false,
    onStageHunk,
    onLoadMore,
    onFileHistory,
    fullFile = false,
    onFullFile,
    fileNav = null,
    embedded = false,
    scrollHost = null,
    layout,
    scrollX = 0,
    onScrollX,
    fileCount,
    onRetry,
    onHunkNav,
  }: Props = $props();
  let menu = $state<ContextMenuRequest | null>(null);
  let ownMode = $state<"unified" | "split">("unified");
  /** 用户选的布局。窄到两列重叠时暂时画统一视图，加宽后若仍是并排则恢复。 */
  let preferred = $derived<"unified" | "split">(layout ?? ownMode);
  let paneWidth = $state(0);
  let renderMode = $derived<"unified" | "split">(
    preferred === "split" && !splitColumnsFit(paneWidth, !readOnly) ? "unified" : preferred,
  );
  let cramped = $derived(preferred === "split" && renderMode === "unified");
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** embedded 时外层视口相对本块的位置与高度。 */
  let hostTop = $state(0);
  let hostHeight = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let root = $state<HTMLElement | null>(null);
  /** embedded 的吸底横向滚动条：内宽跟随本块 scrollWidth，与 .diff-scroll 双向同步。 */
  let hbar = $state<HTMLDivElement | null>(null);
  let trackWidth = $state(0);
  let trackView = $state(0);
  let selectionKey = $derived(selection ? `${selection.side}:${selection.path}` : "");
  let currentDiff = $derived(
    selection && diff?.path === selection.path && diff.staged === (selection.side === "staged") ? diff : null,
  );
  /* Git 的文件头（diff --git / index / --- / +++ / new file mode …）对读差异的人是噪音：
     文件路径、状态和增删统计都已经在工具条里。这里只保留代码行与块标题，
     并记下每一行在原始列表里的位置，按块暂存仍按原始下标找块。 */
  let sourceLines = $derived(currentDiff?.lines);
  let shown = $derived(visibleDiffLines(sourceLines ?? []));
  let lines = $derived<ViewLine[]>(shown.lines);
  let metaOnly = $derived(shown.lines.length === 0 && shown.meta.length > 0);
  let sideRows = $derived(renderMode === "split" ? toSideRows(lines) : []);
  let total = $derived(renderMode === "split" ? sideRows.length : lines.length);
  /* 宽度取全量差异的最长行，只随内容变化，不随虚拟窗口或布局切换跳动。 */
  let codeTexts = $derived(lines.filter((line) => line.kind !== "hunk").map((line) => codeOf(line)));
  let ruler = $derived(codeRuler(codeTexts));
  let codeSize = $derived(codeContentSize(codeTexts));
  /* 并排视图两栏各自横向滚动：每栏的滚动行程按本栏最长的一行算，旧侧是上下文 + 删除，新侧是上下文 + 新增。 */
  let split = $derived(renderMode === "split");
  /** 块头在当前布局里的行号。并排时删除和新增挤在同一行，所以不能沿用统一视图的下标。 */
  let hunkIndexes = $derived(
    hunkRowIndexes(split ? sideRows.map((row) => row.left?.kind ?? row.right?.kind) : lines.map((line) => line.kind)),
  );
  let hunkMax = $derived(viewport > 0 ? Math.max(0, total * ROW_HEIGHT - viewport) : Number.POSITIVE_INFINITY);
  let hunkState = $derived(hunkJump(hunkIndexes, scrollTop, ROW_HEIGHT, hunkMax));
  const altLabel = MODIFIER_LABEL === "⌘" ? "⌥" : "Alt";
  let hunkPrev = $state<HTMLButtonElement | null>(null);
  let hunkNext = $state<HTMLButtonElement | null>(null);
  let leftRuler = $derived(split ? codeRuler(lines.filter((line) => line.kind === "context" || line.kind === "del").map((line) => codeOf(line))) : []);
  let rightRuler = $derived(split ? codeRuler(lines.filter((line) => line.kind === "context" || line.kind === "add").map((line) => codeOf(line))) : []);
  let leftBar = $state<HTMLDivElement | null>(null);
  let rightBar = $state<HTMLDivElement | null>(null);
  /** 竖向滚动条占的宽度：两栏滚动条按代码栏对齐，要让出这一段。 */
  let gutter = $state(0);
  /** 哪一栏放不下：都放得下时不画滚动条那一行。 */
  let overflow = $state({ left: false, right: false });
  let range = $derived(
    embedded
      ? visibleRange(total, hostTop, hostHeight, ROW_HEIGHT)
      : visibleRange(total, scrollTop, viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );
  let hunkForLine = $derived((index: number) => {
    const origin = shown.origin[index];
    return origin === undefined ? null : (currentDiff?.hunks.find((hunk) => hunk.startLine === origin) ?? null);
  });
  let parts = $derived(selection ? splitPath(selection.path) : null);
  let showStats = $derived(Boolean(currentDiff));
  /** 中间那一段：只有真的有文件动作时才画，免得空段留下一条竖线和一段多余间距。 */
  let hasFileTools = $derived(
    Boolean(selection && (onFileHistory || onFullFile || (currentDiff && !currentDiff.binary))),
  );

  $effect(() => {
    const node = root;
    if (!node) return;
    const read = () => {
      paneWidth = node.clientWidth;
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  });

  /* 语法高亮：旧侧（上下文 + 删除）与新侧（上下文 + 新增）各自整体分词，再按行映射回来；
     行内改动区间在配对的删除/新增行之间计算。结果逐块到达，未到的行先按纯文本显示。 */
  let language = $derived(currentDiff && !currentDiff.binary ? effectiveLanguage(currentDiff.path) : null);
  let documents = $derived(buildDiffDocuments(lines));
  const oldSyntax = createHighlight(() => ({ lang: language, lines: documents.oldLines }));
  const newSyntax = createHighlight(() => ({ lang: language, lines: documents.newLines }));

  function segmentsAt(index: number) {
    const line = lines[index];
    if (!line) return [];
    const code = codeOf(line);
    const side = documents.side[index];
    const tokens = side === 0 ? oldSyntax.at(documents.at[index]) : side === 1 ? newSyntax.at(documents.at[index]) : undefined;
    return lineSegments(code, tokens, documents.ranges.get(index) ?? null);
  }

  const sign = signOf;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时静默：菜单项本身不承担报错。
    }
  }

  function hunkOf(index: number): DiffHunk | null {
    const line = lines[index];
    if (!line || line.hunkIndex === null || !currentDiff) return null;
    return currentDiff.hunks.find((hunk) => hunk.index === line.hunkIndex) ?? null;
  }

  /** 右键菜单：复制、展开完整文件、文件历史与按块暂存；命中的行由 data-line 决定。 */
  function openMenu(event: MouseEvent | KeyboardEvent, point: { x: number; y: number }) {
    if (!selection) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
    const index = target ? Number(target.dataset.line) : -1;
    const line = index >= 0 ? lines[index] : undefined;
    const picked = typeof window !== "undefined" ? (window.getSelection()?.toString() ?? "") : "";
    const hunk = index >= 0 ? hunkOf(index) : null;
    const entries: ContextMenuEntry[] = [
      {
        id: "copy-selection",
        label: "复制选中内容",
        icon: "copy",
        disabledReason: picked ? undefined : "先在差异里选中文字",
        run: () => void copy(picked),
      },
      {
        id: "copy-line",
        label: "复制此行代码",
        icon: "copy",
        disabledReason: line && CODE_KINDS.has(line.kind) ? undefined : "这里不是代码行",
        run: () => line && void copy(codeOf(line)),
      },
      { id: "copy-path", label: "复制文件路径", icon: "copy", run: () => void copy(selection.path) },
    ];
    if (onFullFile) {
      entries.push(
        { separator: true },
        {
          id: "full-file",
          label: fullFile ? "只看改动部分" : "查看完整文件",
          icon: "rows",
          run: () => onFullFile?.(!fullFile),
        },
      );
    }
    if (onFileHistory) {
      entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onFileHistory?.(selection.path) });
    }
    if (!readOnly) {
      const reason = fullFile
        ? "完整文件视图不能按块暂存，先切回「只看改动部分」"
        : !hunk
          ? "在某个代码块上右键才能按块操作"
          : !hunk.stageable
            ? "截断的代码块不能部分暂存"
            : disabled
              ? "正在读取或写入，稍后再试"
              : undefined;
      entries.push(
        { separator: true },
        {
          id: "stage-hunk",
          label: selection.side === "staged" ? "取消暂存此块" : "暂存此块",
          icon: selection.side === "staged" ? "minus" : "plus",
          disabledReason: reason,
          run: () => hunk && onStageHunk(hunk),
        },
      );
    }
    menu = { x: point.x, y: point.y, entries, label: "差异操作" };
  }

  const CODE_KINDS = new Set(["add", "del", "context"]);

  $effect(() => {
    selectionKey;
    applyScroll(0);
    // 只跟文件切换和容器换新：embedded 的位置由下面恢复，这里不能归零。
    if (scroller && !untrack(() => embedded)) scroller.scrollLeft = 0;
  });

  /* 块重新挂载时恢复横向位置：标尺的实测兜底要等下一帧，所以宽度变化时继续尝试，
     两帧后放手；恢复完成前不上报，否则半途的位置会盖掉记下的值。 */
  let restoring: number | null = untrack(() => (embedded && scrollX > 0 ? scrollX : null));

  $effect(() => {
    const node = scroller;
    if (!embedded || !node) return;
    const measure = () => {
      trackWidth = node.scrollWidth;
      trackView = node.clientWidth;
      if (restoring === null) return;
      node.scrollLeft = restoring;
      if (node.scrollLeft === restoring) restoring = null;
    };
    measure();
    const frame = requestAnimationFrame(() => {
      measure();
      restoring = null;
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  });

  $effect(() => {
    const node = scroller;
    const bar = hbar;
    if (!node) return;
    const fromCode = () => {
      if (bar && bar.scrollLeft !== node.scrollLeft) bar.scrollLeft = node.scrollLeft;
      if (restoring === null) onScrollX?.(node.scrollLeft);
    };
    const fromBar = () => {
      if (bar && node.scrollLeft !== bar.scrollLeft) node.scrollLeft = bar.scrollLeft;
    };
    fromCode();
    node.addEventListener("scroll", fromCode, { passive: true });
    bar?.addEventListener("scroll", fromBar, { passive: true });
    return () => {
      node.removeEventListener("scroll", fromCode);
      bar?.removeEventListener("scroll", fromBar);
    };
  });

  /* 并排视图：两栏的横向位置写在滚动容器上（--code-xl / --code-xr），两条滚动条各管一栏。 */
  function setSideX(side: "l" | "r", left: number) {
    scroller?.style.setProperty(`--code-x${side}`, `${left}px`);
  }

  $effect(() => {
    const node = scroller;
    const bars = [leftBar, rightBar];
    if (!split || !node) return;
    const measure = () => {
      gutter = Math.max(0, node.offsetWidth - node.clientWidth);
      const next = { left: (leftBar?.scrollWidth ?? 0) > (leftBar?.clientWidth ?? 0) + 1, right: (rightBar?.scrollWidth ?? 0) > (rightBar?.clientWidth ?? 0) + 1 };
      if (next.left !== overflow.left || next.right !== overflow.right) overflow = next;
      setSideX("l", leftBar?.scrollLeft ?? 0);
      setSideX("r", rightBar?.scrollLeft ?? 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    for (const bar of bars) {
      if (!bar) continue;
      observer?.observe(bar);
      if (bar.firstElementChild) observer?.observe(bar.firstElementChild);
    }
    return () => observer?.disconnect();
  });

  /* 换文件时两栏都回到行首。 */
  $effect(() => {
    selectionKey;
    split;
    untrack(() => {
      for (const bar of [leftBar, rightBar]) if (bar) bar.scrollLeft = 0;
      setSideX("l", 0);
      setSideX("r", 0);
    });
  });

  /** 触控板横向滑动或 Shift+滚轮：指针在哪一栏就滚哪一栏，纵向滚动照常交给浏览器。 */
  function onSplitWheel(event: WheelEvent) {
    if (!split || !scroller) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (delta === 0) return;
    const rect = scroller.getBoundingClientRect();
    const bar = event.clientX < rect.left + scroller.clientWidth / 2 ? leftBar : rightBar;
    if (!bar) return;
    event.preventDefault();
    bar.scrollLeft += delta;
  }

  // Svelte 把 onwheel 挂成 passive，preventDefault 不生效；这里手动挂非 passive 的监听。
  $effect(() => {
    const node = scroller;
    if (!node) return;
    node.addEventListener("wheel", onSplitWheel, { passive: false });
    return () => node.removeEventListener("wheel", onSplitWheel);
  });

  $effect(() => {
    const host = scrollHost;
    const node = scroller;
    if (!embedded || !host || !node) return;
    const sync = () => {
      const outer = host.getBoundingClientRect();
      hostTop = Math.max(0, outer.top - node.getBoundingClientRect().top);
      hostHeight = outer.height;
    };
    sync();
    host.addEventListener("scroll", sync, { passive: true });
    // 上方的块变高时本块被推走，但外层并没有滚动，所以连内容列表一起观察。
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(host);
    if (host.firstElementChild) observer?.observe(host.firstElementChild);
    return () => {
      host.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  });

  /* 切换文件时差异区会先换成读取状态，滚动容器被卸载，焦点会掉到 body，
     Alt+←/→ 连按和方向键滚动都断了。先把焦点寄放在外框上，新内容出来再还回去。 */
  let refocus = false;

  $effect.pre(() => {
    selectionKey;
    // 只跟文件切换：滚动容器换新时不能重跑，否则刚还回去的焦点又被收走。
    untrack(() => {
      if (embedded || !scroller || document.activeElement !== scroller) return;
      refocus = true;
      root?.focus({ preventScroll: true });
    });
  });

  $effect(() => {
    if (!scroller || !refocus) return;
    refocus = false;
    scroller.focus({ preventScroll: true });
  });

  /* 行钉在视口里（.code-stage），代码文字按 --code-x 平移，并排两栏因此天然联动。 */
  trackCodeScroll(
    () => scroller,
    () => ruler,
    () => [selectionKey, renderMode, range.start, range.end],
    () => codeSize,
  );

  function applyScroll(next: number) {
    scrollTop = next;
    if (scroller) scroller.scrollTop = next;
  }

  /** 按下时再算一次：滚动可能刚发生，不能用上报那一刻的行号。 */
  function jump(direction: -1 | 1) {
    const state = hunkJump(hunkIndexes, scrollTop, ROW_HEIGHT, hunkMax);
    const row = direction < 0 ? state.prevRow : state.nextRow;
    if (row === null) return;
    const max = viewport > 0 ? Math.max(0, total * ROW_HEIGHT - viewport) : Number.POSITIVE_INFINITY;
    applyScroll(Math.min(row * ROW_HEIGHT, max));
  }

  /** 走到头时焦点交给另一侧，键盘用户还能接着往回跳。 */
  async function runHunk(direction: -1 | 1, self: HTMLButtonElement | null, other: HTMLButtonElement | null) {
    jump(direction);
    await tick();
    if (self?.disabled && !other?.disabled) other?.focus({ preventScroll: true });
  }

  /**
   * 只在可用性变化时上报。滚动会改 hunkState，但原因经常不变；
   * 每次滚动都写外层状态会让整个窗口跟着重绘。
   */
  let hunkPublished = "";
  $effect(() => {
    const report = onHunkNav;
    if (!report) return;
    const key = `${hunkState.prevReason ?? ""}\0${hunkState.nextReason ?? ""}`;
    if (key === hunkPublished) return;
    hunkPublished = key;
    report({ prevReason: hunkState.prevReason, nextReason: hunkState.nextReason, jump });
  });
  $effect(() => {
    const report = onHunkNav;
    return () => report?.(null);
  });

  function onDiffKey(event: KeyboardEvent) {
    if (embedded || event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const height = viewport > 0 ? viewport : (scroller?.clientHeight ?? 0);
    if (event.key === "Home") {
      event.preventDefault();
      applyScroll(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      applyScroll(scrollByRows(0, total, total, height, ROW_HEIGHT));
      return;
    }
    const page = Math.max(1, height > 0 ? Math.floor(height / ROW_HEIGHT) : 1);
    const delta =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? page : event.key === "PageUp" ? -page : null;
    if (delta === null) return;
    event.preventDefault();
    applyScroll(scrollByRows(scrollTop, delta, total, height, ROW_HEIGHT));
  }

  function lineClass(kind: string): string {
    if (kind === "add") return "diff-line add";
    if (kind === "del") return "diff-line del";
    if (kind === "hunk" || kind === "meta" || kind === "nonewline") return "diff-line hunk";
    return "diff-line";
  }

  function hunkLabel(hunk: DiffHunk): string {
    if (!hunk.stageable) return "已截断";
    return selection?.side === "staged" ? "取消暂存" : "暂存此块";
  }
</script>

<section class="diff dense" class:embedded aria-label="差异详情" tabindex="-1" bind:this={root} title={cramped ? "窗口太窄，暂时使用统一视图" : undefined}>
  {#if !embedded}
  <!-- 工具条分三段：文件位置/身份 → 能对这个文件做什么 → 怎么显示。同段靠在一起，
       段与段之间一条装饰竖线，扫视顺序与操作顺序一致（先认出文件，再选动作，最后是布局）。 -->
  <div class="diff-toolbar">
    <div class="diff-toolbar-group context">
      {#if fileNav}<FileNav nav={fileNav} />{/if}
      {#if hunkState.total > 0}
        <div class="file-nav" role="group" aria-label="切换改动块">
          <button
            type="button"
            class="icon-btn sm"
            aria-label="上一处改动"
            title={hunkState.prevReason ?? `上一处改动（${altLabel} ↑）`}
            disabled={hunkState.prevReason !== null}
            bind:this={hunkPrev}
            onclick={() => runHunk(-1, hunkPrev, hunkNext)}
          >
            <Icon name="chevron-up" size={15} />
          </button>
          <button
            type="button"
            class="icon-btn sm"
            aria-label="下一处改动"
            title={hunkState.nextReason ?? `下一处改动（${altLabel} ↓）`}
            disabled={hunkState.nextReason !== null}
            bind:this={hunkNext}
            onclick={() => runHunk(1, hunkNext, hunkPrev)}
          >
            <Icon name="chevron-down" size={15} />
          </button>
          {#if hunkState.current >= 0}<span class="file-nav-pos">{hunkState.current + 1}/{hunkState.total}</span>{/if}
        </div>
      {/if}
      <div class="diff-file">
        {#if selection && parts}
          <Icon name="file-diff" size={15} />
          <span class="diff-path" title={selection.path}>
            <bdi>{#if parts.dir}<span class="dir">{parts.dir}/</span>{/if}<strong>{parts.name}</strong></bdi>
          </span>
          {#if !readOnly}
            <span class="diff-side" class:staged={selection.side === "staged"}>
              {selection.side === "staged" ? "已暂存" : "未暂存"}
            </span>
          {/if}
          {#if showStats && currentDiff}
            <LineCounts
              stat={currentDiff.binary
                ? { additions: null, deletions: null, oldSize: currentDiff.oldSize, newSize: currentDiff.newSize }
                : { additions: currentDiff.additions, deletions: currentDiff.deletions }}
            />
          {/if}
          {#if cramped}
            <span class="diff-summary" title="窗口太窄，暂时使用统一视图">窗口太窄，暂时使用统一视图</span>
          {/if}
        {:else}
          <span class="hint">差异</span>
        {/if}
      </div>
      {#if loading && currentDiff}<span class="spinner muted" aria-hidden="true"></span>{/if}
    </div>
    {#if hasFileTools}
      <div class="diff-toolbar-group">
        {#if currentDiff && !currentDiff.binary && selection}
          <LanguagePicker path={selection.path} />
        {/if}
        {#if onFileHistory && selection}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="此文件历史"
            title="查看这个文件的提交历史"
            onclick={() => onFileHistory?.(selection.path)}
          >
            <Icon name="history" size={14} /><span class="diff-hist-label">此文件历史</span>
          </button>
        {/if}
        {#if onFullFile && selection}
          <button
            type="button"
            class="btn btn-ghost btn-sm diff-full-toggle"
            aria-pressed={fullFile}
            title={fullFile ? "只显示改动附近的内容" : "把整份文件都显示出来（改动仍高亮）"}
            onclick={() => onFullFile?.(!fullFile)}
          >
            <Icon name="rows" size={13} /><span class="diff-hist-label">{fullFile ? "完整文件" : "只看改动"}</span>
          </button>
        {/if}
      </div>
    {/if}
    <div class="diff-toolbar-group">
      <div class="segmented" role="group" aria-label="差异布局">
        <button type="button" aria-pressed={preferred === "unified"} title="统一视图" onclick={() => (ownMode = "unified")}><Icon name="rows" size={12} />统一</button>
        <button type="button" aria-pressed={preferred === "split"} title="并排视图" onclick={() => (ownMode = "split")}><Icon name="split" size={12} />并排</button>
      </div>
    </div>
  </div>
  {/if}
  {#if error}
    <div class="empty" role="status">
      <span class="empty-icon err"><Icon name="alert-circle" size={24} /></span>
      <strong>差异没有读取完成</strong>
      <p>{error}</p>
      {#if onRetry}
        <!-- R5：失败就地可恢复。走和选择文件同一条读取路径（token/generation 不变），不绕过防护。 -->
        <button type="button" class="btn btn-secondary btn-sm" onclick={onRetry}>重新读取</button>
      {/if}
    </div>
  {:else if !selection}
    <div class="empty">
      <span class="empty-icon"><Icon name="file-diff" size={24} /></span>
      <strong>{fileCount === 0 ? "工作区没有未提交的改动" : "选择一个文件查看差异"}</strong>
      {#if fileCount === 0}<p>左栏为空时右侧没有可看的内容，可以刷新或切到历史。</p>{/if}
    </div>
  {:else if loading && !currentDiff}
    <div class="empty" role="status" aria-busy="true">
      <span class="empty-icon"><span class="spinner"></span></span>
      <strong>正在读取差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else if currentDiff?.preview}
    <BinaryPreview sources={currentDiff.preview} generation={currentDiff.generation} {disabled} {onGeneration} />
  {:else if currentDiff?.binary}
    {@const size = binarySizeText(currentDiff.oldSize, currentDiff.newSize)}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>二进制文件有变动</strong>
      {#if size}<p class="binary-size">{size.text}{#if currentDiff.oldSize != null && currentDiff.newSize != null}<span class="binary-delta">{sizeDelta(currentDiff.oldSize, currentDiff.newSize)}</span>{/if}</p>{/if}
      <p>{selection.path}</p>
    </div>
  {:else if metaOnly}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>只有文件属性变化</strong>
      <p>{shown.meta.join("；")}</p>
    </div>
  {:else if !currentDiff || (currentDiff.lines.length === 0 && currentDiff.totalLines === 0)}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>没有文本差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else}
    <div
      class="diff-scroll"
      class:split-x={split}
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      tabindex="0"
      aria-label="差异文本"
      bind:this={scroller}
      onkeydown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(event, { x: rect.left + 40, y: rect.top + 40 });
          return;
        }
        onDiffKey(event);
      }}
      oncontextmenu={(event) => {
        event.preventDefault();
        openMenu(event, { x: event.clientX, y: event.clientY });
      }}
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      bind:clientHeight={viewport}
    >
      <div class="virtual-space" style={`height:${total * ROW_HEIGHT}px`}>
        {#if !split}
          <div class="code-ruler" aria-hidden="true">{#each ruler as line, i (i)}<span data-text={line.text} style={rulerPadding(line)}></span>{/each}</div>
        {/if}
        <div class="code-stage">
        {#if renderMode === "unified"}
          {#each lines.slice(range.start, range.end) as line, index (`u-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div class={lineClass(line.kind)} data-diff-row="" data-line={absolute} style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}>
              <span class="ln">{line.oldNo ?? ""}</span>
              <span class="ln">{line.newNo ?? ""}</span>
              {#if line.kind === "add" || line.kind === "del" || line.kind === "context"}
                {@const segs = segmentsAt(absolute)}
                <span class="code"><span class="code-in" data-sign={sign(line.text)} data-len={codeOf(line).length}>{#if segs.length === 1 && !segs[0].k && !segs[0].m}{segs[0].t}{:else}{#each segs as seg, i (i)}<span class={seg.k} class:wd={seg.m}>{seg.t}</span>{/each}{/if}</span></span>
              {:else if line.kind === "hunk"}
                {@const caption = hunkCaption(line.text)}
                <span class="code hunk-caption"><span class="hunk-at">{caption.at}</span>{#if caption.context}<span class="hunk-context" title={caption.context}>{caption.context}</span>{/if}</span>
              {:else}
                <span class="code"><span class="code-in" data-len={line.text.length || 1}>{line.text.length === 0 ? " " : line.text}</span></span>
              {/if}
              {#if !readOnly && !fullFile && hunkForLine(absolute)}
                {@const hunk = hunkForLine(absolute)}
                {#if hunk}
                  <button
                    type="button"
                    class={`btn btn-sm hunk-btn ${hunk.stageable ? "btn-secondary" : "btn-ghost"}`}
                    disabled={disabled || !hunk.stageable}
                    title={hunk.stageable ? "" : "截断的代码块不能部分暂存"}
                    onclick={() => onStageHunk(hunk)}
                  >{hunkLabel(hunk)}</button>
                {/if}
              {/if}
            </div>
          {/each}
        {:else}
          {#each sideRows.slice(range.start, range.end) as row, index (`s-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div
              class="side-row"
              class:span={row.span}
              data-diff-row=""
              data-line={row.right?.index ?? row.left?.index ?? undefined}
              style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
            >
              <!-- 占位格用 blank 而不是 empty：.empty 是全局空状态（flex + 32px 内边距），会把单元格撑到 64px，相邻行文字叠在一起。 -->
              {#if row.span && row.left?.kind === "hunk"}
                {@const caption = hunkCaption(row.left.text)}
                <span class="side-cell hunk side-hunk"><span class="ln"></span><span class="code hunk-caption"><span class="hunk-at">{caption.at}</span>{#if caption.context}<span class="hunk-context" title={caption.context}>{caption.context}</span>{/if}</span></span>
              {:else}
              <span class={`side-cell side-l ${row.left?.kind ?? "blank"}`}>
                {#if row.left}<span class="ln">{row.left.no ?? ""}</span>{#if row.left.index !== undefined && !row.span}<span class="code"><span class="code-in" data-sign={sign(row.left.text)} data-len={codeOf(row.left).length}>{#each segmentsAt(row.left.index) as seg, i (i)}{#if !seg.k && !seg.m}{seg.t}{:else}<span class={seg.k} class:wd={seg.m}>{seg.t}</span>{/if}{/each}</span></span>{:else}<span class="code"><span class="code-in" data-len={row.left.text.length}>{row.left.text}</span></span>{/if}{/if}
              </span>
              <span class={`side-cell side-r ${row.right?.kind ?? "blank"}`}>
                {#if row.right}<span class="ln">{row.right.no ?? ""}</span>{#if row.right.index !== undefined && !row.span}<span class="code"><span class="code-in" data-sign={sign(row.right.text)} data-len={codeOf(row.right).length}>{#each segmentsAt(row.right.index) as seg, i (i)}{#if !seg.k && !seg.m}{seg.t}{:else}<span class={seg.k} class:wd={seg.m}>{seg.t}</span>{/if}{/each}</span></span>{:else}<span class="code"><span class="code-in" data-len={row.right.text.length}>{row.right.text}</span></span>{/if}{/if}
              </span>
              {/if}
              {#if !readOnly && !fullFile && row.showStage && row.hunkIndex !== null}
                {@const hunk = currentDiff.hunks.find((item) => item.index === row.hunkIndex)}
                {#if hunk}
                  <button
                    type="button"
                    class={`btn btn-sm hunk-btn ${hunk.stageable ? "btn-secondary" : "btn-ghost"}`}
                    disabled={disabled || !hunk.stageable}
                    title={hunk.stageable ? "" : "截断的代码块不能部分暂存"}
                    onclick={() => onStageHunk(hunk)}
                  >{hunkLabel(hunk)}</button>
                {/if}
              {/if}
            </div>
          {/each}
        {/if}
        </div>
      </div>
    </div>
    {#if split}
      <!-- 两栏各一条横向滚动条，按代码栏（行号之后）对齐；内容是本栏的隐藏标尺，宽度由浏览器实测。 -->
      <div class="split-hbars" class:collapsed={!overflow.left && !overflow.right} style={`padding-right:${gutter}px`} aria-hidden="true">
        <div class="split-hbar-cell">
          <div class="split-hbar" tabindex="-1" bind:this={leftBar} onscroll={(event) => setSideX("l", event.currentTarget.scrollLeft)}>
            <div class="split-ruler">{#each leftRuler as line, i (i)}<span data-text={line.text} style={rulerPadding(line)}></span>{/each}</div>
          </div>
        </div>
        <div class="split-hbar-cell">
          <div class="split-hbar" tabindex="-1" bind:this={rightBar} onscroll={(event) => setSideX("r", event.currentTarget.scrollLeft)}>
            <div class="split-ruler">{#each rightRuler as line, i (i)}<span data-text={line.text} style={rulerPadding(line)}></span>{/each}</div>
          </div>
        </div>
      </div>
    {/if}
    {#if embedded && !split && trackWidth > trackView}
      <div class="diff-hbar" aria-hidden="true" tabindex="-1" bind:this={hbar}><div style={`width:${trackWidth}px`}></div></div>
    {/if}
    {#if currentDiff.offset + currentDiff.lines.length < currentDiff.totalLines}
      <div class="diff-more">
        <p class="hint">已显示 {currentDiff.lines.length} / {currentDiff.totalLines} 行。</p>
        <button type="button" class="btn btn-secondary btn-sm" title={disabled || loading ? BUSY_REASON : undefined} disabled={disabled || loading} onclick={onLoadMore}>继续加载</button>
      </div>
    {/if}
  {/if}
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}
</section>
