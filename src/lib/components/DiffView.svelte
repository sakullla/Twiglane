<script lang="ts">
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import { createQuietActivity } from "../quiet-activity";
  import { MODIFIER_LABEL } from "../brand";
  import { HUNK_LAST, analyzeDiffSpecials, changeRunIndexes, filterDiffHunks, hunkCaption, hunkJump, hunkRowIndexes, lineSelectionScope, splitColumnsFit, toSideRows, visibleDiffLines, type HunkNavReport, type ViewLine, type WhitespaceFilter } from "../diff";
  import { clearDiffFilterRules, diffPrefs, hasActiveDiffFilters, setWhitespaceMode, toggleHideWhitespaceOnly, toggleIgnoreBlankLines, toggleIgnoreCase, toggleIgnoreEol, toggleShowWhitespace } from "../diff-prefs.svelte";
  import type { IconName } from "../icons";
  import { rememberScroll } from "../checkout-context";
  import { trackCodeScroll } from "../codeScroll.svelte";
  import { codeContentSize, codeRuler, rulerPadding, scrollByRows, visibleRange } from "../layout";
  import type { DiffHunk, DiffLineSelection, DiffResponse, FileSelection, PreviewSources } from "../types";
  import { BUSY_REASON, binarySizeText, sizeDelta, splitPath, type FileNavState } from "../ui";
  import { buildDiffDocuments, codeOf, signOf } from "../syntax/diffSyntax";
  import { createHighlight } from "../syntax/highlight.svelte";
  import { effectiveLanguage } from "../syntax/prefs.svelte";
  import { lineSegments } from "../syntax/segments";
  import { commentLineKey } from "../review-comments.svelte";
  import { findSeed, selectedText } from "../find-seed";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import BinaryPreview from "./BinaryPreview.svelte";
  import FileNav from "./FileNav.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";
  import { openModalCount } from "./Modal.svelte";
  import Popover from "./Popover.svelte";

  interface Props {
    readingKey?: string;
    onGeneration?: (generation: number) => void;
    selection: FileSelection | null;
    diff: DiffResponse | null;
    error: string | null;
    loading: boolean;
    disabled: boolean;
    readOnly?: boolean;
    /**
     * 只读差异的身份标签（例如「任务净差异」）。给了它就不再按改动侧别显示「未暂存」，
     * 标题与正文都说明这是哪个只读范围的结果。
     */
    readOnlyLabel?: string;
    onStageHunk: (hunk: DiffHunk) => void;
    /**
     * 逐行暂存 / 取消暂存。传了它才出现「选行」模式；历史、审查与多文件块不传，
     * 那些位置只保留文件级与块级入口。
     */
    onStageLines?: (lines: DiffLineSelection[]) => void;
    /**
     * 本差异能不能按块/按行暂存，以及不能时的真实原因（远端没有 patch 写入时由调用方从
     * `DiffResponse.hunksStageableReason` 传进来）。缺省表示没有远端层面的限制，不能暂存
     * 仍按块自身的截断状态说明。行选与右键菜单都只用这句话，不自己编理由。
     */
    hunksStageableReason?: string | null;
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
    /**
     * 选中的是未解决的冲突文件。Git 给的是三方合并差异，这里不硬画成普通差异（会是空白），
     * 而是说明原因并给出处理入口。
     */
    conflicted?: boolean;
    onResolve?: () => void;
    /** 当前文件的整文件快照已标记为已审阅（本地进度，不代表批准）。 */
    reviewed?: boolean;
    /** 正在确认这个文件的快照。 */
    reviewBusy?: boolean;
    /** 标记或撤销整个文件的已审阅状态；不传时不显示入口。 */
    onToggleReview?: () => void;
    /** 当前差异是按文本强制读出的（Git 原本判成二进制）。 */
    asText?: boolean;
    /** Git 判成二进制、又没有图片预览时，提供「按文本查看」；不传时不显示。 */
    onViewAsText?: (next: boolean) => void;
    /**
     * 打开只读文档阅读窗口。只有差异本身带 `document` 来源（Markdown 差异）时才出现入口；
     * 前后版本按真实来源与重命名路径传递，缺失的一侧由阅读窗口自己说明。
     */
    onReadDocument?: (sources: PreviewSources, side: "old" | "new", trigger: HTMLElement | null) => void;
    /**
     * 当前任务范围里已挂意见的行身份（路径 + 块号 + 行类型 + 行号）。
     * 只用来在行上标出「这里已经有意见」，不参与读取或写入。
     */
    comments?: ReadonlySet<string>;
    /**
     * 给某一行添加意见：只有任务审阅的只读差异传入。意见只保存在当前来源的运行期内存里，
     * 不改 Git、不写索引，也不触发任何 Agent 操作。
     */
    onCommentLine?: (anchor: {
      path: string;
      hunkIndex: number;
      kind: "add" | "del" | "context";
      oldNo: number | null;
      newNo: number | null;
      quote: string;
      /** 整块意见：这块在新侧（删除块看旧侧）覆盖的行号区间。 */
      range?: { from: number; to: number };
    }) => void;
    /**
     * 原位意见行的位置：行意见在锚点行之后，整块意见在块标题之后。只有路径与当前文件相同、
     * 且锚点行已经读到时才插入；统一视图跨整行，并排视图跨两栏。内容由 inlinePanel 提供。
     */
    inlineComment?: {
      path: string;
      hunkIndex: number;
      kind: "add" | "del" | "context";
      oldNo: number | null;
      newNo: number | null;
      block: boolean;
    } | null;
    inlinePanel?: Snippet;
    /**
     * 意见行是否放进了差异：true 已插入；false 差异已读到但找不到锚点行（还没读到、被筛选隐藏）；
     * null 未知（读取中、没有目标或本视图卸载）。调用方据此在找不到时给出「继续编辑」的入口。
     */
    onInlinePlaced?: (placed: boolean | null) => void;
    /**
     * 在文件视图里编辑当前工作区这一侧的文件（带上当前位置附近的新侧行号）。
     * 只在新侧就是工作区文件时由调用方传入；历史、旧侧、删除与多文件聚合不传。
     * 差异本身仍然只读，保存只在文件视图的编辑器里发生。
     */
    onEdit?: (line: number | null) => void;
    /**
     * 外部请求打开差异内查找并带入关键词（如审查队列的内容搜索）：nonce 变化时生效一次，
     * 不抢焦点，用户仍可在文件列表里继续用键盘切换。
     */
    findRequest?: { query: string; nonce: number | string } | null;
    /** 逐行追溯这个文件的工作区版本（右键菜单入口）；删除的文件不传。 */
    onBlame?: (path: string) => void;
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
    readingKey = "",
    diff,
    error,
    loading,
    disabled,
    readOnly = false,
    readOnlyLabel,
    onStageHunk,
    onStageLines,
    hunksStageableReason = null,
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
    conflicted = false,
    onResolve,
    reviewed = false,
    reviewBusy = false,
    onToggleReview,
    asText = false,
    onViewAsText,
    onReadDocument,
    onEdit,
    comments,
    onCommentLine,
    inlineComment = null,
    inlinePanel,
    onInlinePlaced,
    findRequest = null,
    onBlame,
  }: Props = $props();
  let menu = $state<ContextMenuRequest | null>(null);
  /**
   * 已有内容上的后台重读（文件监听触发的刷新）：多数几百毫秒内结束，直接画出在途状态会让
   * 工具条里的加载环一闪一闪，还会挤动后面的按钮。只有重读明显变慢时才安静地显示，出现后至少停留一会儿。
   */
  let refreshVisible = $state(false);
  const refreshActivity = createQuietActivity((visible) => (refreshVisible = visible), { showDelay: 700, minVisible: 700 });
  onDestroy(() => refreshActivity.reset());
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
  let selectionKey = $derived(selection ? `${readingKey || diff?.preview?.repository || ""}:${selection.side}:${selection.path}` : "");
  let currentDiff = $derived(
    selection && diff?.path === selection.path && diff.staged === (selection.side === "staged") ? diff : null,
  );
  $effect(() => {
    refreshActivity.set(Boolean(loading && currentDiff));
  });
  /* Git 的文件头（diff --git / index / --- / +++ / new file mode …）对读差异的人是噪音：
     文件路径、状态和增删统计都已经在工具条里。这里只保留代码行与块标题，
     并记下每一行在原始列表里的位置，按块暂存仍按原始下标找块。 */
  let sourceLines = $derived(currentDiff?.lines);
  let shown = $derived(visibleDiffLines(sourceLines ?? []));
  /* 纯空白过滤只是读的时候少画几块：判定按 canonical hunk.index 做，原始行、块号、
     snapshot 与暂存补丁都不动。二进制、图片预览、冲突专用视图和截断内容看不到整块，
     判定会错，因此这些情况一律不启用。 */
  const EMPTY_FILTER: WhitespaceFilter = { hunks: new Set<number>(), lines: 0 };
  let canFilterWhitespace = $derived(
    Boolean(
      currentDiff && !currentDiff.binary && !currentDiff.preview && !conflicted &&
        !currentDiff.truncated && currentDiff.lines.length > 0,
    ),
  );
  let activeFilterRules = $derived(hasActiveDiffFilters(diffPrefs));
  let whitespaceFilter = $derived<WhitespaceFilter>(
    activeFilterRules && canFilterWhitespace
      ? filterDiffHunks(shown.lines, {
          whitespaceMode: diffPrefs.whitespaceMode,
          ignoreBlankLines: diffPrefs.ignoreBlankLines,
          ignoreCase: diffPrefs.ignoreCase,
        })
      : EMPTY_FILTER,
  );
  let specials = $derived(
    canFilterWhitespace ? analyzeDiffSpecials(shown.lines) : { eolLabel: null, eolOnlyHunks: 0, bomChanged: false },
  );
  let activeFilterSummary = $derived.by(() => {
    const parts: string[] = [];
    if (diffPrefs.whitespaceMode === "eol") parts.push("忽略换行符差异");
    else if (diffPrefs.whitespaceMode === "trailing") parts.push("忽略行尾空白");
    else if (diffPrefs.whitespaceMode === "change") parts.push("忽略空白数量变化");
    else if (diffPrefs.whitespaceMode === "all") parts.push("忽略纯空白改动");
    if (diffPrefs.ignoreBlankLines) parts.push("忽略纯空行");
    if (diffPrefs.ignoreCase) parts.push("忽略大小写");
    return parts.join("、") || "当前过滤条件";
  });
  /* 过滤后仍然保持 origin 与行一一对应：右键按块操作还要按原始下标找块。 */
  let view = $derived.by(() => {
    if (whitespaceFilter.hunks.size === 0) return { lines: shown.lines as ViewLine[], origin: shown.origin };
    const kept: ViewLine[] = [];
    const origin: number[] = [];
    shown.lines.forEach((line, index) => {
      const hunk = line.hunkIndex;
      if (hunk !== null && whitespaceFilter.hunks.has(hunk)) return;
      kept.push(line);
      origin.push(shown.origin[index]);
    });
    return { lines: kept, origin };
  });
  let lines = $derived<ViewLine[]>(view.lines);
  /** 所有代码块都被过滤掉：不能报成「没有文本差异」。 */
  let filteredAll = $derived(whitespaceFilter.hunks.size > 0 && lines.length === 0);
  let metaOnly = $derived(shown.lines.length === 0 && shown.meta.length > 0);
  let sideRows = $derived(renderMode === "split" ? toSideRows(lines) : []);
  let total = $derived(renderMode === "split" ? sideRows.length : lines.length);
  /**
   * 原位意见行：插在第 inlineIndex 行（当前布局的行号）之后，其后的行整体下移 inlineGap。
   * 虚拟窗口仍按固定行高计算：滚动位置先扣掉意见行的高度再换算成行号。
   * 高度按实测取值，测不到（刚挂载或测试环境）时按估计值占位。
   */
  const INLINE_ESTIMATE = 200;
  let inlineHeight = $state(0);
  let inlineIndex = $derived.by<number | null>(() => {
    const target = inlineComment;
    if (!target || !inlinePanel || !selection || target.path !== selection.path) return null;
    const key = commentLineKey(target.path, target);
    const matches = (line: ViewLine | null | undefined): boolean =>
      Boolean(line && line.hunkIndex !== null && commentLineKey(target.path, line) === key);
    const isHeader = (index: number | undefined): boolean =>
      index !== undefined && lines[index]?.kind === "hunk" && headerHunk(index) === target.hunkIndex;
    if (renderMode === "split") {
      if (target.block) {
        const at = sideRows.findIndex((row) => row.span && isHeader(row.left?.index));
        if (at >= 0) return at;
      }
      const at = sideRows.findIndex((row) => !row.span && (matches(pickLineOf(row.left)) || matches(pickLineOf(row.right))));
      return at >= 0 ? at : null;
    }
    if (target.block) {
      const at = lines.findIndex((_line, index) => isHeader(index));
      if (at >= 0) return at;
    }
    const at = lines.findIndex((line) => matches(line));
    return at >= 0 ? at : null;
  });
  let inlineGap = $derived(inlineIndex === null ? 0 : inlineHeight > 0 ? inlineHeight : INLINE_ESTIMATE);

  /** 第 index 行的纵向位置：意见行之后的行让出它的高度。 */
  function rowTop(index: number): number {
    return index * ROW_HEIGHT + (inlineIndex !== null && index > inlineIndex ? inlineGap : 0);
  }

  /** 滚动位置换算回「只有代码行」的坐标，虚拟窗口据此取行。 */
  function rowSpace(y: number): number {
    if (inlineIndex === null) return y;
    const edge = (inlineIndex + 1) * ROW_HEIGHT;
    return y <= edge ? y : Math.max(edge, y - inlineGap);
  }

  /** 最大滚动位置（像素坐标）：代码行加上意见行的高度。 */
  function maxScrollFor(height: number): number {
    return Math.max(0, total * ROW_HEIGHT + inlineGap - Math.max(0, height));
  }

  /** 按行滚动：意见行打开时上限加上它的高度，键盘仍能到达最后一行。 */
  function scrollRowsBy(delta: number, height: number): number {
    if (total <= 0) return 0;
    if (inlineGap === 0) return scrollByRows(scrollTop, delta, total, height, ROW_HEIGHT);
    const next = scrollTop + delta * ROW_HEIGHT;
    const max = maxScrollFor(height);
    return next <= 0 ? 0 : next >= max ? max : next;
  }

  // 意见行放置结果：差异读到后找不到锚点行时报告 false，读取中或没有目标时为未知。
  $effect(() => {
    const report = onInlinePlaced;
    if (!report) return;
    const target = inlineComment;
    const placed: boolean | null =
      !target || !inlinePanel || !selection || target.path !== selection.path || !currentDiff
        ? null
        : inlineIndex !== null
          ? true
          : loading
            ? null
            : false;
    untrack(() => report(placed));
    return () => untrack(() => report(null));
  });
  /* 宽度取全量差异的最长行，只随内容变化，不随虚拟窗口或布局切换跳动。 */
  let codeTexts = $derived(lines.filter((line) => line.kind !== "hunk").map((line) => codeOf(line)));
  let ruler = $derived(codeRuler(codeTexts));
  let codeSize = $derived(codeContentSize(codeTexts));
  /* 并排视图两栏各自横向滚动：每栏的滚动行程按本栏最长的一行算，旧侧是上下文 + 删除，新侧是上下文 + 新增。 */
  let split = $derived(renderMode === "split");
  /** 块头在当前布局里的行号。并排时删除和新增挤在同一行，所以不能沿用统一视图的下标。 */
  /**
   * 完整文件只有一个块，按块跳只会回到开头：这时改按连续的改动段落跳，段落前留几行上下文。
   * 平时仍按块头跳，块标题就是落点。
   */
  const RUN_LEAD = 3;
  let hunkIndexes = $derived(
    fullFile
      ? changeRunIndexes(
          split
            ? sideRows.map((row) => row.left?.kind === "del" || row.right?.kind === "add")
            : lines.map((line) => line.kind === "add" || line.kind === "del"),
          RUN_LEAD,
        )
      : hunkRowIndexes(split ? sideRows.map((row) => row.left?.kind ?? row.right?.kind) : lines.map((line) => line.kind)),
  );
  /** 块导航用「只有代码行」的坐标：意见行的高度从滚动位置与上限里扣掉。 */
  let hunkMax = $derived(viewport > 0 ? rowSpace(maxScrollFor(viewport)) : Number.POSITIVE_INFINITY);
  let contentTop = $derived(rowSpace(scrollTop));
  /** 完整文件按页读取：后面还有没读到的行时，「下一处」先续读再跳，不能停在已读部分的末尾。 */
  let moreToRead = $derived(
    Boolean(fullFile && currentDiff && currentDiff.offset + currentDiff.lines.length < currentDiff.totalLines),
  );
  let hunkState = $derived.by(() => {
    const state = hunkJump(hunkIndexes, contentTop, ROW_HEIGHT, hunkMax);
    if (moreToRead && state.nextRow === null && (state.nextReason === HUNK_LAST || state.total === 0)) {
      return { ...state, nextReason: loading ? "正在读取后续内容" : null };
    }
    return state;
  });
  /** 续读之后要接着跳到下一处：等新的行到了再算落点。 */
  let pendingNext = $state(false);
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(pendingTimer));
  const altLabel = MODIFIER_LABEL === "⌘" ? "⌥" : "Alt";
  let hunkPrev = $state<HTMLButtonElement | null>(null);
  let hunkNext = $state<HTMLButtonElement | null>(null);
  let documents = $derived(buildDiffDocuments(lines));
  let leftRuler = $derived(split ? codeRuler(documents.oldLines) : []);
  let rightRuler = $derived(split ? codeRuler(documents.newLines) : []);
  let leftBar = $state<HTMLDivElement | null>(null);
  let rightBar = $state<HTMLDivElement | null>(null);
  /** 竖向滚动条占的宽度：两栏滚动条按代码栏对齐，要让出这一段。 */
  let gutter = $state(0);
  /** 哪一栏放不下：都放得下时不画滚动条那一行。 */
  let overflow = $state({ left: false, right: false });
  let range = $derived(
    embedded
      ? visibleRange(total, rowSpace(hostTop), hostHeight, ROW_HEIGHT)
      : visibleRange(total, rowSpace(scrollTop), viewport > 0 ? viewport : scrollTop > 0 ? ROW_HEIGHT : 0, ROW_HEIGHT),
  );

  /* 意见行刚出现（或换了位置）时，若锚点行与编辑器不同屏，把锚点行滚到视口上部三分之一处。 */
  let inlineSeen = "";
  $effect(() => {
    const at = inlineIndex;
    const path = selection?.path ?? "";
    untrack(() => {
      const key = at === null ? "" : `${path}:${renderMode}:${at}`;
      if (key === inlineSeen) return;
      inlineSeen = key;
      if (at === null || embedded || viewport <= 0) return;
      const top = rowTop(at);
      if (top >= scrollTop && top + ROW_HEIGHT + inlineGap <= scrollTop + viewport) return;
      applyScroll(Math.max(0, top - Math.floor(viewport / 3)));
    });
  });
  let hunksByStart = $derived(new Map(currentDiff?.hunks.map((hunk) => [hunk.startLine, hunk])));
  function hunkForLine(index: number) {
    const origin = view.origin[index];
    return origin === undefined ? null : (hunksByStart.get(origin) ?? null);
  }
  let parts = $derived(selection ? splitPath(selection.path) : null);
  let showStats = $derived(Boolean(currentDiff));

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
  /* 显示空白：只在有文本差异时把空格、制表符画出来；代码文本本身不变。 */
  let markWhitespace = $derived(diffPrefs.showWhitespace && Boolean(currentDiff && !currentDiff.binary));
  let hasDeletions = $derived(lines.some((line) => line.kind === "del"));
  const oldSyntax = createHighlight(() => ({ lang: hasDeletions ? language : null, lines: documents.oldLines }));
  const newSyntax = createHighlight(() => ({ lang: language, lines: documents.newLines }));

  function segmentsAt(index: number) {
    const line = lines[index];
    if (!line) return [];
    const code = codeOf(line);
    const side = documents.side[index];
    const tokens = side === 0 ? oldSyntax.at(documents.at[index]) : side === 1 ? newSyntax.at(documents.at[index]) : undefined;
    return lineSegments(code, tokens, documents.ranges.get(index) ?? null, markWhitespace);
  }

  const sign = signOf;

  /**
   * 行选（T4）：只保存行身份（hunkIndex + kind + oldNo + newNo），统一与并排视图共用同一份，
   * 换文件、generation、布局、完整文件、空白显示或过滤之后旧选择会失效。上下文、块标题、
   * meta 与「没有换行」标记永远不会进入选择集合。
   */
  let pickMode = $state(false);
  let picked = $state<DiffLineSelection[]>([]);
  /** 文件头里会改变文件本身的语义：新增、删除、改名、拷贝、权限或类型变化，逐行写入不安全。 */
  const PICK_HEADER = /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|similarity index)/;

  function pickKey(line: { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null }): string {
    return [line.hunkIndex ?? "-", line.kind, line.oldNo ?? "", line.newNo ?? ""].join(":");
  }

  /**
   * 这份差异为什么不能按块/按行暂存：远端没有 patch 写入时由 API 层带一句话下来，那是能力
   * 限制，不是块被截断。块级按钮、行选入口与右键菜单必须共用这一句，别编一个与事实无关的理由。
   */
  let stageBlocked = $derived(hunksStageableReason ?? currentDiff?.hunksStageableReason ?? null);

  /** 行选为什么不能用：文件级、视图级的原因都要明说，不能只是把按钮灰着。 */
  let pickBlocker = $derived.by<string | null>(() => {
    if (!currentDiff) return "还没有读到差异";
    if (readOnly) return `${readOnlyLabel ?? "历史与审查视图"}只读，不会写入暂存区`;
    if (conflicted) return "冲突文件要在三栏合并里处理";
    if (currentDiff.binary) return "二进制文件不能按行暂存";
    if (currentDiff.preview) return "图片预览没有可选的代码行";
    // 远端层面不支持时，切视图、换文件都无用：先给真实原因，别把人引到别的入口上。
    if (stageBlocked) return stageBlocked;
    if (fullFile) return "完整文件视图不能按行暂存，先切回「只看改动部分」";
    if (currentDiff.truncated) return "差异被截断，按行写入会落到错误的位置";
    if (currentDiff.lines.some((line) => line.kind === "meta" && PICK_HEADER.test(line.text))) {
      return "文件本身新增、删除、改名或权限变化，不能逐行暂存";
    }
    if (!currentDiff.hunks.some((hunk) => hunk.stageable)) return "没有可逐行暂存的完整代码块";
    return null;
  });
  let canPickLines = $derived(Boolean(onStageLines && currentDiff && pickBlocker === null));
  /** 只有完整代码块里的行能写：截断块的坐标不可靠；远端不给 stageable 的块也一律不算。 */
  let pickableHunks = $derived(
    new Set((currentDiff?.hunks ?? []).filter((hunk) => hunk.complete && hunk.stageable).map((hunk) => hunk.index)),
  );

  function canPick(line: { kind: string; hunkIndex: number | null } | null | undefined): boolean {
    if (!pickMode || !canPickLines || !line) return false;
    if (line.kind !== "add" && line.kind !== "del") return false;
    return line.hunkIndex !== null && pickableHunks.has(line.hunkIndex);
  }

  /** 并排视图的单元格指回 lines 里的原始行：两栏共用同一份行身份，不另造一套坐标。 */
  function pickLineOf(cell: { index?: number } | null): ViewLine | null {
    if (!cell || cell.index === undefined) return null;
    return lines[cell.index] ?? null;
  }

  function pickRowSide(cell: { index?: number } | null, shiftKey = false): void {
    if (!cell || cell.index === undefined) return;
    toggleLineAt(cell.index, shiftKey);
  }

  type PickableLine = { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null };

  /** 连选锚点：记录最近一次单点/连选落在 lines 里的下标，以及那一次是「选入」还是「取消」。 */
  let pickAnchorIndex = $state<number | null>(null);
  let pickAnchorSelecting = $state(true);

  let pickedKeys = $derived(new Set(picked.map(pickKey)));

  function isPicked(line: PickableLine): boolean {
    return pickedKeys.has(pickKey(line));
  }

  function pickLabel(line: PickableLine): string {
    const no = line.kind === "del" ? line.oldNo : line.newNo;
    const what = line.kind === "del" ? "删除" : "新增";
    return (isPicked(line) ? "取消选择" : "选择") + what + "第 " + (no ?? "?") + " 行";
  }

  /**
   * 行意见：与行选共用同一份行身份，但完全不依赖暂存权限——只读的任务净差异也能加意见。
   * 只有带块号的代码行可挂意见；块标题、meta 与「没有换行」标记都不接受。
   */
  let commentPath = $derived(selection?.path ?? "");

  function commentKeyOf(line: { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null }): string {
    return commentLineKey(commentPath, line);
  }

  function hasComment(line: { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null }): boolean {
    return Boolean(comments?.size && comments.has(commentKeyOf(line)));
  }

  function canComment(line: { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null } | null | undefined): boolean {
    if (!onCommentLine || !line || line.hunkIndex === null) return false;
    return line.kind === "add" || line.kind === "del" || line.kind === "context";
  }

  function commentLabel(line: { kind: string; oldNo: number | null; newNo: number | null }): string {
    const no = line.kind === "del" ? line.oldNo : line.newNo;
    const what = line.kind === "del" ? "删除" : line.kind === "add" ? "新增" : "第";
    return "给" + what + "第 " + (no ?? "?") + " 行加一条意见";
  }

  function commentAt(line: ViewLine): void {
    if (!canComment(line) || !onCommentLine) return;
    onCommentLine({
      path: commentPath,
      hunkIndex: line.hunkIndex as number,
      kind: line.kind as "add" | "del" | "context",
      oldNo: line.oldNo,
      newNo: line.newNo,
      quote: codeOf(line).slice(0, 200),
    });
  }

  /**
   * 整块意见：一次说清一整块改动，不必逐行点。协议仍是单行锚点，所以落在这块第一条
   * 改动行上（新增优先，纯删除块用删除行），并带上这块覆盖的行号区间给界面与正文用。
   */
  function hunkCommentTarget(hunkIndex: number): { anchor: ViewLine; from: number; to: number; changed: ViewLine[] } | null {
    const own = lines.filter((line) => line.hunkIndex === hunkIndex && canComment(line));
    const changed = own.filter((line) => line.kind === "add" || line.kind === "del");
    const anchor = changed.find((line) => line.kind === "add") ?? changed[0];
    if (!anchor) return null;
    const side = anchor.kind === "add" ? "newNo" : "oldNo";
    const numbers = changed.map((line) => line[side]).filter((no): no is number => typeof no === "number");
    if (numbers.length === 0) return null;
    return { anchor, from: Math.min(...numbers), to: Math.max(...numbers), changed };
  }

  /** 块标题行自己没有块号时，取紧随其后的第一条代码行的块号。 */
  function headerHunk(index: number): number | null {
    const own = lines[index]?.hunkIndex;
    if (own !== null && own !== undefined) return own;
    const next = lines[index + 1]?.hunkIndex;
    return next === null || next === undefined ? null : next;
  }

  function hunkCommented(hunkIndex: number): boolean {
    return Boolean(comments?.size) && lines.some((line) => line.hunkIndex === hunkIndex && canComment(line) && hasComment(line));
  }

  function commentHunk(hunkIndex: number): void {
    const target = hunkCommentTarget(hunkIndex);
    if (!target || !onCommentLine) return;
    onCommentLine({
      path: commentPath,
      hunkIndex,
      kind: target.anchor.kind as "add" | "del",
      oldNo: target.anchor.oldNo,
      newNo: target.anchor.newNo,
      quote: target.changed.map((line) => codeOf(line)).join("\n").slice(0, 200),
      range: { from: target.from, to: target.to },
    });
  }

  function commentCell(cell: { index?: number } | null): void {
    const line = pickLineOf(cell);
    if (line) commentAt(line);
  }

  function toggleLine(line: PickableLine): void {
    if (!canPick(line)) return;
    const key = pickKey(line);
    if (picked.some((item) => pickKey(item) === key)) {
      picked = picked.filter((item) => pickKey(item) !== key);
      return;
    }
    picked = [...picked, { hunkIndex: line.hunkIndex as number, kind: line.kind as "add" | "del", oldNo: line.oldNo, newNo: line.newNo }];
  }

  function toggleLineAt(index: number, shiftKey = false): void {
    const line = lines[index];
    if (!line || !canPick(line)) return;
    if (shiftKey && pickAnchorIndex !== null && pickAnchorIndex !== index) {
      const from = Math.min(pickAnchorIndex, index);
      const to = Math.max(pickAnchorIndex, index);
      const rangeLines: Array<ViewLine & { hunkIndex: number; kind: "add" | "del" }> = [];
      for (let cursor = from; cursor <= to; cursor += 1) {
        const candidate = lines[cursor];
        if (candidate && canPick(candidate)) {
          rangeLines.push(candidate as ViewLine & { hunkIndex: number; kind: "add" | "del" });
        }
      }
      if (rangeLines.length > 0) {
        if (pickAnchorSelecting) {
          const existing = new Set(picked.map(pickKey));
          const additions = rangeLines
            .filter((item) => !existing.has(pickKey(item)))
            .map((item) => ({ hunkIndex: item.hunkIndex, kind: item.kind, oldNo: item.oldNo, newNo: item.newNo }));
          if (additions.length > 0) picked = [...picked, ...additions];
        } else {
          const removeKeys = new Set(rangeLines.map(pickKey));
          picked = picked.filter((item) => !removeKeys.has(pickKey(item)));
        }
        pickAnchorIndex = index;
        return;
      }
    }
    const wasPicked = isPicked(line);
    toggleLine(line);
    pickAnchorSelecting = !wasPicked;
    pickAnchorIndex = index;
  }

  /** 进入或退出选行模式都清空选择，避免看不见的选择被写入。 */
  function setPickMode(next: boolean): void {
    if (next && !canPickLines) return;
    if (pickMode === next) return;
    pickMode = next;
    picked = [];
    pickAnchorIndex = null;
    pickAnchorSelecting = true;
  }

  function canHandlePickEscape(event: KeyboardEvent): boolean {
    if (event.key !== "Escape" || !pickMode || event.isComposing || event.defaultPrevented) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (openModalCount() > 0) return false;
    if (document.querySelector(".menu, .popover, .review-source-pop, [role='menu']")) return false;
    return true;
  }

  $effect(() => {
    if (!pickMode) return;
    const onWindowEscape = (event: KeyboardEvent) => {
      if (!canHandlePickEscape(event)) return;
      if (root?.closest('[aria-hidden="true"]')) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      event.stopPropagation();
      setPickMode(false);
    };
    window.addEventListener("keydown", onWindowEscape);
    return () => window.removeEventListener("keydown", onWindowEscape);
  });

  function commitPickedLines(): void {
    // stageBlocked 也挡一次：按钮已禁用，但键盘/程序触发不该绕过去发一条注定被拒的写。
    if (!onStageLines || picked.length === 0 || disabled || stageBlocked) return;
    onStageLines(picked.slice());
  }

  /**
   * 行选清理入口：换文件、generation、布局、完整文件、空白显示或过滤之后，之前选中的行可能
   * 已经不在屏幕上，必须清掉，否则不可见的行会被写进暂存。
   */
  function clearLineSelection(): void {
    if (picked.length > 0) picked = [];
    if (pickMode) pickMode = false;
    pickAnchorIndex = null;
    pickAnchorSelecting = true;
  }

  let lineScope = $derived(
    lineSelectionScope({
      path: selection?.path ?? "",
      side: selection?.side ?? "unstaged",
      generation: currentDiff?.generation ?? null,
      mode: renderMode,
      fullFile,
      hideWhitespaceOnly: diffPrefs.hideWhitespaceOnly,
      filterKey: `${diffPrefs.whitespaceMode}:${diffPrefs.ignoreBlankLines ? 1 : 0}:${diffPrefs.ignoreCase ? 1 : 0}`,
    }),
  );

  /** 行选失效的全部触发条件：lineSelectionScope（文件、侧别、generation、布局、完整文件、过滤）
      之外，再算上「显示空白」偏好，两者任何一个变了都清空选择。 */
  let pickScope = $derived(
    lineScope + "|" + (currentDiff?.snapshot ?? "-") + (diffPrefs.showWhitespace ? "|ws" : "|plain"),
  );

  $effect(() => {
    // 读一次 key：上下文变了才清，没变不重复清。
    pickScope;
    untrack(clearLineSelection);
  });

  /* ------------------------------------------------------------------ *
   * 工具条随差异面板宽度收敛（R2）。
   * 当前文件、文件/改动块导航与主写入动作始终留在原位；空间不足时，低频文件工具与
   * 查看偏好收进同一个溢出入口。溢出项和直接入口读同一份状态，因此生效值、禁用原因
   * 与执行结果只有一套事实来源；宽度未知（首帧或测试环境）时按完整工具条渲染。
   * ------------------------------------------------------------------ */
  type ToolTier = "full" | "compact" | "narrow";
  /** 面板宽到这里为止时全部工具直接可见；再窄就依次收敛一档。 */
  const FULL_MIN = 1160;
  const COMPACT_MIN = 860;
  let toolbar = $state<HTMLDivElement | null>(null);
  let toolbarWidth = $state(0);
  /** 实际渲染后仍溢出时追加收敛的档数：0 按宽度，1 至少 compact，2 至少 narrow。 */
  let escalated = $state(0);
  let moreOpen = $state(false);
  let moreQuery = $state("");
  let moreActive = $state(0);
  let moreAnchor = $state<HTMLButtonElement | null>(null);
  let baseTier = $derived<ToolTier>(
    toolbarWidth <= 0 ? "full" : toolbarWidth >= FULL_MIN ? "full" : toolbarWidth >= COMPACT_MIN ? "compact" : "narrow",
  );
  let tier = $derived<ToolTier>(
    escalated === 0 ? baseTier : escalated === 1 ? (baseTier === "full" ? "compact" : "narrow") : "narrow",
  );
  let showLayoutInline = $derived(tier !== "narrow");
  /* 语言、显示偏好、文件历史与完整文件是低频动作：任何宽度都收进「更多差异工具」，
     主行只留文件路径、增删统计、上下文动作与布局切换；生效状态仍在溢出按钮的
     计数与「已隐藏 N 处」「完整文件」提示里，不会跟着藏起来。 */
  let showOverflow = $derived(Boolean(selection));
  /* Markdown 差异才有文档来源：前后版本的正文都在对应版本里读，不从这份 diff 拼。 */
  let documentSides = $derived(onReadDocument ? currentDiff?.document ?? null : null);
  /* 默认看这个差异的「后」侧：改动对比里它就是当前工作区/暂存区/这次提交的正文。 */
  let documentSide = $derived<"old" | "new">(documentSides?.new ? "new" : "old");
  let documentLabel = $derived(
    documentSides?.new ? "按版本阅读这个文档的正文（改动后）" : "按版本阅读这个文档的正文（改动前）",
  );
  function readDocument(trigger: HTMLElement | null): void {
    const sources = documentSides;
    if (!sources || !onReadDocument) return;
    onReadDocument(sources, documentSide, trigger);
  }
  /** 进入编辑时定位的行：视口里第一条带新侧行号的行，没有就从文件开头。 */
  function editLineHint(): number | null {
    const start = Math.max(0, Math.floor(rowSpace(scrollTop) / ROW_HEIGHT));
    for (let index = start; index < lines.length; index += 1) {
      const no = lines[index]?.newNo;
      if (typeof no === "number" && no > 0) return no;
    }
    return null;
  }

  /* 语言收进溢出菜单顶部的常驻行；「阅读文档」是上下文主动作，只在最窄档进菜单。 */
  let showLanguageInMenu = $derived(Boolean(currentDiff && !currentDiff.binary && selection));
  let inlineReadDocument = $derived(tier !== "narrow" && Boolean(documentSides && selection));

  interface DiffTool {
    id: string;
    label: string;
    icon: IconName;
    /** 当前生效状态文字（已开启 / 当前 / 已选 N 行）。 */
    state?: string;
    /** 是否处于选中态：驱动 aria-selected 与勾选。 */
    selected?: boolean;
    /** 会影响视图的偏好是否生效：只用于溢出触发按钮上的计数。 */
    pressed?: boolean;
    /** 不可用原因；有值时条目仍可见，但不执行。 */
    reason?: string;
    /** 补充说明（例如已隐藏几处），不阻止执行。 */
    note?: string;
    /** 执行后菜单保持打开：比对规则常连着改几项，进出二级页也不该关菜单。 */
    keepOpen?: boolean;
    /** 打开二级页的入口：右侧画箭头而不是勾。 */
    submenu?: boolean;
    run: () => void;
  }

  /** 溢出菜单的二级页：各类「忽略」比对规则收在这里，一级菜单只留一个入口。 */
  let moreView = $state<"root" | "rules">("root");
  let ruleTools = $derived.by<DiffTool[]>(() => {
    if (!canFilterWhitespace) return [];
    const rule = (id: string, label: string, on: boolean, run: () => void, note?: string): DiffTool => ({
      id, label, icon: "filter", selected: on, pressed: on, state: on ? "已开启" : undefined, keepOpen: true, note, run,
    });
    return [
      rule("ignore-eol", "忽略换行符差异（CRLF ↔ LF）", diffPrefs.whitespaceMode === "eol", toggleIgnoreEol,
        specials.eolOnlyHunks > 0 ? `检测到 ${specials.eolOnlyHunks} 处仅换行符不同的改动` : undefined),
      rule("ignore-trailing-ws", "忽略行尾空白", diffPrefs.whitespaceMode === "trailing",
        () => setWhitespaceMode(diffPrefs.whitespaceMode === "trailing" ? "none" : "trailing")),
      rule("ignore-ws-change", "忽略空白数量变化", diffPrefs.whitespaceMode === "change",
        () => setWhitespaceMode(diffPrefs.whitespaceMode === "change" ? "none" : "change")),
      rule("hide-whitespace", "忽略纯空白改动", diffPrefs.hideWhitespaceOnly, toggleHideWhitespaceOnly,
        whitespaceFilter.hunks.size > 0 && diffPrefs.hideWhitespaceOnly ? `已隐藏 ${whitespaceFilter.hunks.size} 处只改了空白的改动` : undefined),
      rule("ignore-blank-lines", "忽略纯空行改动", diffPrefs.ignoreBlankLines, toggleIgnoreBlankLines),
      rule("ignore-case", "忽略大小写差异", diffPrefs.ignoreCase, toggleIgnoreCase),
    ];
  });
  let activeRuleCount = $derived(ruleTools.filter((tool) => tool.pressed).length);
  /** 二级页的条目：返回、规则，以及有规则生效时的一键恢复。 */
  let ruleViewTools = $derived.by<DiffTool[]>(() => [
    { id: "rules-back", label: "返回", icon: "chevron-left", keepOpen: true, run: () => { moreView = "root"; moreActive = 0; } },
    ...ruleTools,
    ...(activeRuleCount > 0
      ? [{ id: "rules-reset", label: "恢复默认比对", icon: "x" as IconName, keepOpen: true, run: clearDiffFilterRules }]
      : []),
  ]);

  let overflowTools = $derived.by<DiffTool[]>(() => {
    const tools: DiffTool[] = [];
    if (tier === "narrow") {
      tools.push(
        {
          id: "layout-unified",
          label: "统一视图",
          icon: "rows",
          selected: preferred === "unified",
          state: preferred === "unified" ? "当前" : undefined,
          run: () => (ownMode = "unified"),
        },
        {
          id: "layout-split",
          label: "并排视图",
          icon: "split",
          selected: preferred === "split",
          state: preferred === "split" ? "当前" : undefined,
          run: () => (ownMode = "split"),
        },
      );
    }
    if (canFilterWhitespace) {
      tools.push(
        {
          id: "show-whitespace",
          label: "显示空白字符",
          icon: "eye",
          selected: diffPrefs.showWhitespace,
          pressed: diffPrefs.showWhitespace,
          state: diffPrefs.showWhitespace ? "已开启" : undefined,
          note: "空格、制表符、CRLF/LF 与不可见字符",
          run: toggleShowWhitespace,
        },
        {
          id: "compare-rules",
          label: "比对规则",
          icon: "filter",
          pressed: activeRuleCount > 0,
          state: activeRuleCount > 0 ? `已开启 ${activeRuleCount} 项` : "默认",
          note: activeRuleCount > 0 ? activeFilterSummary : "换行符、空白、空行与大小写",
          submenu: true,
          keepOpen: true,
          run: () => { moreView = "rules"; moreActive = 0; },
        },
      );
    }
    if (onFullFile && selection) {
      tools.push({
        id: "full-file",
        label: fullFile ? "只看改动部分" : "查看完整文件",
        icon: "rows",
        selected: fullFile,
        pressed: fullFile,
        state: fullFile ? "已开启" : undefined,
        run: () => onFullFile?.(!fullFile),
      });
    }
    if (onFileHistory && selection) {
      tools.push({ id: "file-history", label: "此文件历史", icon: "history", run: () => onFileHistory?.(selection.path) });
    }
    if (selection) {
      tools.push({
        id: "copy-path",
        label: copiedPath ? "已复制文件路径" : "复制文件路径",
        icon: copiedPath ? "check" : "copy",
        state: copiedPath ? "已复制" : undefined,
        run: () => void copy(selection.path, true),
      });
    }
    if (documentSides && selection && !inlineReadDocument) {
      tools.push({
        id: "read-document",
        label: "阅读文档",
        icon: "eye",
        note: documentSides.new && documentSides.old ? "改动前 / 改动后两个版本" : documentSides.new ? "改动后的版本" : "改动前的版本",
        run: () => readDocument(moreAnchor),
      });
    }
    const allPickable = lines.filter((line): line is ViewLine & { hunkIndex: number; kind: "add" | "del" } => canPick(line));
    const allPicked = allPickable.length > 0 && picked.length === allPickable.length;
    if (tier === "narrow" && pickMode) {
      tools.push(
        {
          id: "select-all-picks",
          label: "全选可选行",
          icon: "check",
          reason: allPicked ? "已经选中全部可选行" : allPickable.length === 0 ? "没有可选中的行" : undefined,
          run: () => {
            picked = allPickable.map((line) => ({ hunkIndex: line.hunkIndex, kind: line.kind, oldNo: line.oldNo, newNo: line.newNo }));
          },
        },
        {
          id: "clear-picks",
          label: "清除选中的行",
          icon: "x",
          state: picked.length > 0 ? `已选 ${picked.length} 行` : undefined,
          reason: picked.length === 0 ? "还没有选中任何行" : undefined,
          run: () => (picked = []),
        },
      );
    }
    return tools;
  });
  let visibleTools = $derived.by(() => {
    const needle = moreQuery.trim().toLowerCase();
    // 搜索跨两级：输入「忽略」直接列出规则本身，不必先进二级页。
    if (needle) {
      return [...overflowTools.filter((tool) => !tool.submenu), ...ruleTools].filter((tool) =>
        [tool.label, tool.state, tool.note, tool.reason].some((part) => part?.toLowerCase().includes(needle)),
      );
    }
    return moreView === "rules" ? ruleViewTools : overflowTools;
  });
  let pressedToolCount = $derived(
    overflowTools.filter((tool) => tool.pressed && !tool.submenu).length + activeRuleCount,
  );
  let moreLabel = $derived(
    pressedToolCount > 0 ? `更多差异工具（${pressedToolCount} 项已开启）` : "更多差异工具",
  );
  /**
   * 工具条内容变化（含选中行数、过滤状态）后重新量一次；宽度没变时 ResizeObserver 不会回调。
   * 「阅读文档」只在 Markdown 差异上有：从文本差异切到同宽度的 Markdown 差异会多一个按钮，
   * 不重测就不会收敛，`.diff-toolbar` 的 flex-wrap 会多折一行而不是收进溢出菜单（R2）。
   */
  let toolbarSignature = $derived(
    [
      tier,
      pickMode,
      picked.length,
      canFilterWhitespace,
      Boolean(onFullFile),
      Boolean(onFileHistory),
      refreshVisible,
      fullFile,
      inlineReadDocument,
      Boolean(documentSides),
      onToggleReview ? (reviewed ? "reviewed" : "review") : "",
      onEdit ? "edit" : "",
      currentDiff ? `${currentDiff.additions ?? ""}:${currentDiff.deletions ?? ""}` : "",
    ].join("|"),
  );
  /** 换文件后文件名长度变了：从完整档重新量，短名字不必继续收着工具。 */
  let measuredPath = "";

  /**
   * 工具条是否太挤：整条换了行，或者文件名本身已经被截断。上下文段的基础宽度是 0，
   * 工具多时它会被压到只剩复制按钮和徽标——文件名看不见，工具条就没有主语了。
   * 这时把低频工具再收一档，而不是让文件名消失。
   */
  function toolbarCrowded(node: HTMLElement): boolean {
    if (node.scrollWidth > node.clientWidth + 1) return true;
    const groups = node.children;
    if (groups.length > 1) {
      const top = (groups[0] as HTMLElement).offsetTop;
      for (const group of groups) if ((group as HTMLElement).offsetTop > top + 8) return true;
    }
    const name = node.querySelector<HTMLElement>(".diff-path strong");
    if (!name || typeof document === "undefined" || typeof document.createRange !== "function") return false;
    // scrollWidth 会取整：差零点几像素也会画出省略号，所以按文字实际排版宽度比。
    const range = document.createRange();
    range.selectNodeContents(name);
    const natural = range.getBoundingClientRect().width;
    const shown = name.getBoundingClientRect().width;
    return natural > 0 && natural > shown + 0.01;
  }

  $effect(() => {
    toolbarSignature;
    const node = toolbar;
    if (!node) return;
    const path = selection?.path ?? "";
    const read = () => {
      const width = node.clientWidth;
      if (width !== toolbarWidth || path !== measuredPath) {
        toolbarWidth = width;
        measuredPath = path;
        if (escalated !== 0) {
          // 先回到按宽度估算的档位，等它渲染后由下一轮再量，不拿旧档位的布局做判断。
          escalated = 0;
          return;
        }
      }
      // 估算阈值之外的字体、缩放或长文件名由实际排版兜底；最多升到 narrow，避免来回抖动。
      if (width > 0 && tier !== "narrow" && toolbarCrowded(node)) escalated += 1;
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  });

  /** 搜索词变化时回到第一项；过滤让条目变少时当前项不越界。 */
  let seenToolQuery = "";
  $effect(() => {
    const query = moreQuery;
    untrack(() => {
      if (query === seenToolQuery) return;
      seenToolQuery = query;
      moreActive = 0;
    });
  });
  $effect(() => {
    const count = visibleTools.length;
    if (moreActive > Math.max(0, count - 1)) moreActive = Math.max(0, count - 1);
  });

  function openMore(): void {
    if (!moreAnchor) return;
    moreQuery = "";
    seenToolQuery = "";
    moreView = "root";
    const first = overflowTools.findIndex((tool) => !tool.reason);
    moreActive = first >= 0 ? first : 0;
    moreOpen = true;
  }

  function closeMore(refocus = true): void {
    moreOpen = false;
    moreView = "root";
    if (refocus) moreAnchor?.focus({ preventScroll: true });
  }

  function runTool(tool: DiffTool | undefined): void {
    if (!tool || tool.reason) return;
    if (tool.keepOpen) {
      tool.run();
      return;
    }
    closeMore(true);
    tool.run();
  }

  /** 窗口放宽到溢出入口消失时，别把打开状态带到下一次变窄。 */
  $effect(() => {
    if (!showOverflow && moreOpen) moreOpen = false;
  });

  let copiedPath = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copyTimer));

  async function copy(text: string, isPath = false) {
    try {
      await navigator.clipboard.writeText(text);
      if (isPath) {
        copiedPath = true;
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => (copiedPath = false), 1500);
      }
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
      { id: "copy-path", label: "复制文件路径", icon: "copy", run: () => void copy(selection.path, true) },
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
    if (onBlame) {
      entries.push({ id: "blame", label: "逐行追溯（Blame）", icon: "user", run: () => onBlame?.(selection.path) });
    }
    if (!readOnly) {
      const reason = fullFile
        ? "完整文件视图不能按块暂存，先切回「只看改动部分」"
        : !hunk
          ? "在某个代码块上右键才能按块操作"
          : !hunk.stageable
            ? stageBlocked ?? "截断的代码块不能部分暂存"
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
    copiedPath = false;
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

  /**
   * 视野外的行内改动：长行只改了行尾（或横向滚过了头），可见部分的删除/新增两行看起来一模一样。
   * 量的是已渲染行里的 .wd 标记与本行代码窗口（.code 的内容盒）的相对位置，所以中文全角、
   * 制表符、语法分段和并排两栏的各自偏移都按浏览器实际排版算；一行只要还有一处改动看得见就不算。
   * 结果只用来显示一个右下角的小入口，点一下把最上面那处改动横向滚进视野；不改任何差异内容。
   */
  interface HiddenChange {
    count: number;
    direction: "left" | "right";
    side: "u" | "l" | "r";
    delta: number;
  }
  let hiddenChange = $state<HiddenChange | null>(null);
  let hiddenFrame = 0;
  /** 改动标记左侧留出的余量：滚过去后前面还能看到几个字的上下文。 */
  const REVEAL_CONTEXT_PX = 48;

  function scanHiddenChanges(): HiddenChange | null {
    const node = scroller;
    if (!node || embedded) return null;
    const view = node.getBoundingClientRect();
    if (view.width <= 0 || view.height <= 0) return null;
    const cells = new Map<Element, { visible: boolean; first: DOMRect | null; padLeft: number; box: DOMRect }>();
    for (const mark of node.querySelectorAll<HTMLElement>(".code-in .wd")) {
      const code = mark.closest<HTMLElement>(".code");
      if (!code) continue;
      const rect = mark.getBoundingClientRect();
      if (rect.width <= 0 || rect.bottom <= view.top || rect.top >= view.bottom) continue;
      let cell = cells.get(code);
      if (!cell) {
        const style = getComputedStyle(code);
        cell = { visible: false, first: null, padLeft: Number.parseFloat(style.paddingLeft) || 0, box: code.getBoundingClientRect() };
        cells.set(code, cell);
      }
      if (cell.visible) continue;
      const left = cell.box.left + cell.padLeft;
      const right = Math.min(cell.box.right, view.right);
      if (rect.right > left + 1 && rect.left < right - 1) {
        cell.visible = true;
        continue;
      }
      if (!cell.first || rect.left < cell.first.left) cell.first = rect;
    }
    let found: HiddenChange | null = null;
    let topmost = Number.POSITIVE_INFINITY;
    let count = 0;
    for (const [code, cell] of cells) {
      if (cell.visible || !cell.first) continue;
      count += 1;
      if (cell.first.top >= topmost) continue;
      topmost = cell.first.top;
      const side = code.closest(".side-l") ? "l" : code.closest(".side-r") ? "r" : "u";
      const delta = cell.first.left - (cell.box.left + cell.padLeft) - REVEAL_CONTEXT_PX;
      found = { count: 0, side, delta, direction: delta > 0 ? "right" : "left" };
    }
    return found ? { ...found, count } : null;
  }

  function queueHiddenScan() {
    if (typeof requestAnimationFrame === "undefined") return;
    if (hiddenFrame) return;
    hiddenFrame = requestAnimationFrame(() => {
      hiddenFrame = 0;
      const next = scanHiddenChanges();
      const same = next === hiddenChange || (next && hiddenChange && next.count === hiddenChange.count
        && next.direction === hiddenChange.direction && next.side === hiddenChange.side && next.delta === hiddenChange.delta);
      if (!same) hiddenChange = next;
    });
  }

  $effect(() => {
    void [selectionKey, renderMode, range.start, range.end, lines, paneWidth, markWhitespace];
    const node = scroller;
    const bars = [leftBar, rightBar].filter((bar): bar is HTMLDivElement => bar !== null);
    if (!node || embedded) {
      hiddenChange = null;
      return;
    }
    queueHiddenScan();
    node.addEventListener("scroll", queueHiddenScan, { passive: true });
    for (const bar of bars) bar.addEventListener("scroll", queueHiddenScan, { passive: true });
    return () => {
      node.removeEventListener("scroll", queueHiddenScan);
      for (const bar of bars) bar.removeEventListener("scroll", queueHiddenScan);
      if (hiddenFrame && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(hiddenFrame);
      hiddenFrame = 0;
    };
  });

  function revealHiddenChange() {
    const target = hiddenChange;
    if (!target) return;
    const bar = target.side === "l" ? leftBar : target.side === "r" ? rightBar : scroller;
    if (!bar) return;
    bar.scrollLeft = Math.max(0, bar.scrollLeft + target.delta);
    if (target.side !== "u") setSideX(target.side, bar.scrollLeft);
    queueHiddenScan();
  }

  function applyScroll(next: number) {
    scrollTop = next;
    if (scroller) scroller.scrollTop = next;
  }

  /* ---------- 差异内查找（⌘/Ctrl+F） ----------
     差异是虚拟滚动的，浏览器自带查找看不到没渲染的行：这里按已读到的行文本查找，
     命中行整体标出、当前一处加强；支持 CSS Highlight API 时再把可见行里的命中文字标出来。
     只读不写：不影响行选、意见与暂存。 */
  let findOpen = $state(false);
  let findQuery = $state("");
  let findCase = $state(false);
  let findCursor = $state(-1);
  let findInput = $state<HTMLInputElement | null>(null);
  function findable(index: number | undefined): string | null {
    if (index === undefined) return null;
    const line = lines[index];
    if (!line || (line.kind !== "add" && line.kind !== "del" && line.kind !== "context")) return null;
    return codeOf(line);
  }
  /** 命中的行：当前布局下的行号（统一视图是 lines 下标，并排视图是 sideRows 下标）。 */
  let findRows = $derived.by<number[]>(() => {
    if (!findOpen || !findQuery) return [];
    const needle = findCase ? findQuery : findQuery.toLowerCase();
    const hit = (index: number | undefined) => {
      const text = findable(index);
      return text !== null && (findCase ? text : text.toLowerCase()).includes(needle);
    };
    const out: number[] = [];
    if (renderMode === "split") {
      sideRows.forEach((row, at) => {
        if (!row.span && (hit(row.left?.index) || hit(row.right?.index))) out.push(at);
      });
    } else {
      for (let at = 0; at < lines.length; at += 1) if (hit(at)) out.push(at);
    }
    return out;
  });
  let findSet = $derived(new Set(findRows));
  let findCurrentRow = $derived(findCursor >= 0 ? (findRows[findCursor] ?? null) : null);

  function lastIndexWhere<T>(items: readonly T[], test: (item: T) => boolean): number {
    for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index])) return index;
    return -1;
  }

  function openFind(seed: string | null = null, focus = true) {
    const picked = seed ?? findSeed(selectedText(root));
    if (picked) findQuery = picked;
    findOpen = true;
    if (focus) {
      void tick().then(() => {
        findInput?.focus();
        findInput?.select();
      });
    }
  }

  function closeFind() {
    findOpen = false;
    findCursor = -1;
    scroller?.focus({ preventScroll: true });
  }

  function revealFind(at: number) {
    const row = findRows[at];
    if (row === undefined) return;
    findCursor = at;
    const height = viewport > 0 ? viewport : (scroller?.clientHeight ?? 0);
    const top = rowTop(row);
    if (top < scrollTop || top + ROW_HEIGHT > scrollTop + height) {
      applyScroll(Math.max(0, top - Math.floor(height / 3)));
    }
  }

  function stepFind(direction: 1 | -1) {
    const count = findRows.length;
    if (count === 0) return;
    let next: number;
    if (findCursor < 0) {
      // 第一次从当前阅读位置往下（或往上）找，而不是抽回文件开头。
      if (direction > 0) next = findRows.findIndex((row) => rowTop(row) >= scrollTop);
      else next = lastIndexWhere(findRows, (row) => rowTop(row) <= scrollTop);
      if (next < 0) next = direction > 0 ? 0 : count - 1;
    } else {
      next = (findCursor + direction + count) % count;
    }
    revealFind(next);
  }

  // 关键词、大小写、布局或文件变化：从当前位置重新定位到下一处。
  let findKey = "";
  $effect(() => {
    const key = `${selectionKey}\0${findOpen}\0${findQuery}\0${findCase}\0${renderMode}\0${lines.length > 0}`;
    untrack(() => {
      if (key === findKey) return;
      findKey = key;
      findCursor = -1;
      if (findOpen && findQuery && findRows.length > 0) stepFind(1);
    });
  });

  let findNonce: number | string | null = null;
  $effect(() => {
    const request = findRequest;
    untrack(() => {
      if (!request || request.nonce === findNonce) return;
      findNonce = request.nonce;
      if (request.query.trim()) openFind(request.query, false);
    });
  });

  /* 可见行里的命中文字：用 CSS Custom Highlight，不改 DOM，也不打断语法高亮的分段。 */
  const HIGHLIGHT_NAME = "diff-find";
  const HIGHLIGHT_CURRENT = "diff-find-current";
  function highlightsApi(): { set: (name: string, value: unknown) => void; delete: (name: string) => void } | null {
    const css = (globalThis as { CSS?: { highlights?: unknown } }).CSS;
    const registry = css?.highlights as { set: (name: string, value: unknown) => void; delete: (name: string) => void } | undefined;
    const ctor = (globalThis as { Highlight?: unknown }).Highlight;
    return registry && typeof ctor === "function" ? registry : null;
  }
  $effect(() => {
    const registry = highlightsApi();
    if (!registry) return;
    const needle = findOpen ? findQuery : "";
    const sensitive = findCase;
    void range.start;
    void range.end;
    void findCurrentRow;
    void renderMode;
    void scroller;
    const frame = requestAnimationFrame(() => {
      const host = scroller;
      if (!host || !needle) {
        registry.delete(HIGHLIGHT_NAME);
        registry.delete(HIGHLIGHT_CURRENT);
        return;
      }
      const HighlightCtor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
      const all: Range[] = [];
      const current: Range[] = [];
      const query = sensitive ? needle : needle.toLowerCase();
      for (const code of host.querySelectorAll<HTMLElement>(".code-in")) {
        const row = code.closest<HTMLElement>("[data-diff-row]");
        const isCurrent = row?.classList.contains("find-current") ?? false;
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let text = "";
        const nodes: { node: Text; start: number }[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          nodes.push({ node: node as Text, start: text.length });
          text += (node as Text).data;
        }
        const haystack = sensitive ? text : text.toLowerCase();
        let at = haystack.indexOf(query);
        while (at >= 0 && query.length > 0) {
          const end = at + query.length;
          const startNode = nodes[lastIndexWhere(nodes, (item) => item.start <= at)];
          const endNode = nodes[lastIndexWhere(nodes, (item) => item.start < end)];
          if (startNode && endNode) {
            const r = document.createRange();
            r.setStart(startNode.node, at - startNode.start);
            r.setEnd(endNode.node, end - endNode.start);
            (isCurrent ? current : all).push(r);
          }
          at = haystack.indexOf(query, end);
        }
      }
      registry.set(HIGHLIGHT_NAME, new HighlightCtor(...all));
      registry.set(HIGHLIGHT_CURRENT, new HighlightCtor(...current));
    });
    return () => cancelAnimationFrame(frame);
  });
  onDestroy(() => {
    const registry = highlightsApi();
    registry?.delete(HIGHLIGHT_NAME);
    registry?.delete(HIGHLIGHT_CURRENT);
  });

  function onSectionKey(event: KeyboardEvent) {
    if (embedded) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "f" && event.code !== "KeyF") return;
    if (!currentDiff || currentDiff.binary || currentDiff.preview) return;
    const target = event.target as HTMLElement | null;
    // 意见编辑器等文本控件里不拦：那里的 ⌘F 属于控件本身。
    if (target && target !== findInput && target.closest("textarea, [contenteditable='true']")) return;
    event.preventDefault();
    event.stopPropagation();
    openFind();
  }

  /** 按下时再算一次：滚动可能刚发生，不能用上报那一刻的行号。 */
  function jump(direction: -1 | 1) {
    const state = hunkJump(hunkIndexes, rowSpace(scrollTop), ROW_HEIGHT, hunkMax);
    const row = direction < 0 ? state.prevRow : state.nextRow;
    if (row === null) {
      if (direction > 0 && moreToRead && !loading && !pendingNext) {
        pendingNext = true;
        // 续读失败时不会有新行到达：过一会儿放开，按钮还能再按。
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => (pendingNext = false), 15_000);
        onLoadMore();
      }
      return;
    }
    const max = viewport > 0 ? maxScrollFor(viewport) : Number.POSITIVE_INFINITY;
    applyScroll(Math.min(rowTop(row), max));
  }

  /** 续读到了新的行（或读取结束）后，接着完成那一次「下一处」；仍没有就再读下一页。 */
  let pendingLength = -1;
  $effect(() => {
    const length = currentDiff?.lines.length ?? -1;
    const busy = loading;
    untrack(() => {
      if (!pendingNext) {
        pendingLength = length;
        return;
      }
      if (busy || length === pendingLength) return;
      pendingLength = length;
      pendingNext = false;
      void tick().then(() => jump(1));
    });
  });
  $effect(() => {
    void selectionKey;
    void fullFile;
    pendingNext = false;
  });

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

  function onDiffClick(event: MouseEvent): void {
    if (!pickMode || !(event.target instanceof Element) || event.target.closest("button")) return;
    const target = event.target.closest<HTMLElement>("[data-line]");
    const index = Number(target?.dataset.line);
    if (Number.isInteger(index)) toggleLineAt(index, event.shiftKey);
  }

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
      applyScroll(total > 0 ? maxScrollFor(height) : 0);
      return;
    }
    if ((event.key === "]" || event.key === "[") && !event.shiftKey && (hunkState.total > 0 || moreToRead)) {
      event.preventDefault();
      jump(event.key === "]" ? 1 : -1);
      return;
    }
    const page = Math.max(1, height > 0 ? Math.floor(height / ROW_HEIGHT) : 1);
    const delta =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? page : event.key === "PageUp" ? -page : null;
    if (event.key === "j" || event.key === "k") {
      if (delta === null) {
        event.preventDefault();
        applyScroll(scrollRowsBy(event.key === "j" ? 1 : -1, height));
        return;
      }
    }
    if (delta === null) return;
    event.preventDefault();
    applyScroll(scrollRowsBy(delta, height));
  }

  function lineClass(kind: string): string {
    if (kind === "add") return "diff-line add";
    if (kind === "del") return "diff-line del";
    if (kind === "hunk" || kind === "meta" || kind === "nonewline") return "diff-line hunk";
    return "diff-line";
  }

  /** 块不可暂存的原因与行选共用同一句 stageBlocked：本地差异没这句话时按截断说明。 */
  function hunkLabel(hunk: DiffHunk): string {
    if (!hunk.stageable) return stageBlocked ? "不可暂存" : "已截断";
    return selection?.side === "staged" ? "取消暂存" : "暂存此块";
  }

  function hunkStageTitle(hunk: DiffHunk): string {
    if (hunk.stageable) return "";
    return stageBlocked ?? "截断的代码块不能部分暂存";
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="diff dense" class:embedded aria-label="差异详情" tabindex="-1" bind:this={root} title={cramped ? "窗口太窄，暂时使用统一视图" : undefined} onkeydown={onSectionKey}>
  {#if !embedded}
  <!-- 工具条分三段：文件位置/身份 → 能对这个文件做什么 → 怎么显示。同段靠在一起，
       段与段之间一条装饰竖线，扫视顺序与操作顺序一致（先认出文件，再选动作，最后是布局）。
       窄窗口只把低频项收进末尾的溢出入口，本行三段的主操作不搬家。 -->
  <div class="diff-toolbar" class:scrolled={scrollTop > 0} bind:this={toolbar}>
    <div class="diff-toolbar-group context">
      {#if fileNav}<FileNav nav={fileNav} />{/if}
      {#if hunkState.total > 0 || moreToRead}
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
          {#if hunkState.current >= 0}<span class="file-nav-pos" title={moreToRead ? "后面还有没读到的内容，按「下一处」会继续读取" : `当前文件的第 ${hunkState.current + 1} 处改动，共 ${hunkState.total} 处`}>{hunkState.current + 1}/{hunkState.total}{moreToRead ? "+" : ""}</span>{/if}
        </div>
      {/if}
      <div class="diff-file">
        {#if selection && parts}
          <!-- 文件名是这一段的主角：目录先省略，文件名最后才截断；完整路径在提示里。 -->
          <span class="diff-path" title={readOnly && readOnlyLabel ? `${selection.path}（${readOnlyLabel}）` : selection.side === "staged" ? `${selection.path}（已暂存）` : `${selection.path}（未暂存）`}>
            <bdi>{#if parts.dir}<span class="dir">{parts.dir}/</span>{/if}<strong>{parts.name}</strong></bdi>
          </span>
          {#if !embedded}
            <button
              type="button"
              class="icon-btn sm file-copy-btn"
              data-copied={copiedPath ? "true" : undefined}
              aria-label={copiedPath ? "已复制文件路径" : "复制文件路径"}
              title={copiedPath ? "已复制路径" : `复制相对路径：${selection.path}`}
              onclick={() => void copy(selection.path, true)}
            >
              <Icon name={copiedPath ? "check" : "copy"} size={12} />
            </button>
          {/if}
          <!-- 未暂存是改动视图的默认侧，不再单独标出；只有已暂存会把按块动作变成「取消暂存」，
               这时才需要提醒。 -->
          {#if readOnly && readOnlyLabel}
            <span class="diff-side task">{readOnlyLabel}</span>
          {:else if !readOnly && selection.side === "staged"}
            <span class="diff-side staged">已暂存</span>
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
      {#if refreshVisible && currentDiff}<span class="spinner muted" aria-hidden="true" title="正在刷新差异"></span>{/if}
    </div>
    {#if (onToggleReview || onEdit || inlineReadDocument) && selection}
      <div class="diff-toolbar-group">
        {#if inlineReadDocument}
          <!-- 文件身份之后的第一个阅读动作：按版本读正文，和差异视图本身互不影响。 -->
          <button
            type="button"
            class="btn btn-ghost btn-sm doc-read-btn"
            aria-label="阅读文档"
            title={documentLabel}
            onclick={(event) => readDocument(event.currentTarget as HTMLElement)}
          >
            <Icon name="eye" size={13} /><span class="diff-hist-label">阅读文档</span>
          </button>
        {/if}
        {#if onEdit}
          <!-- 只编辑当前工作区这一侧：转到文件视图的编辑器，差异本身不提供保存。 -->
          <button
            type="button"
            class="btn btn-ghost btn-sm diff-edit-btn"
            aria-label="编辑工作区文件"
            title="在文件视图里编辑当前工作区的这个文件；保存只写入工作区，不暂存、不提交"
            onclick={() => onEdit?.(editLineHint())}
          >
            <Icon name="pencil" size={13} /><span class="diff-hist-label">编辑</span>
          </button>
        {/if}
        {#if onToggleReview}
        <button
          type="button"
          class="btn btn-ghost btn-sm review-toggle"
          class:on={reviewed}
          aria-pressed={reviewed}
          aria-label={reviewed ? "撤销当前文件的已审阅标记" : "标记当前文件已审阅"}
          title={reviewBusy
            ? "正在确认整份文件快照……"
            : reviewed
              ? "撤销这个文件的已审阅标记"
              : "标记整个文件已审阅；内容、暂存状态或删除变化后自动失效"}
          disabled={reviewBusy}
          onclick={() => onToggleReview?.()}
        >
          {#if reviewBusy}
            <span class="spinner" aria-hidden="true"></span>
          {:else}
            <Icon name="check-circle" size={13} />
          {/if}
          <span class="diff-hist-label">{reviewed ? "已审阅" : "标记已审阅"}</span>
        </button>
        {/if}
      </div>
    {/if}
    {#if onStageLines && currentDiff && !readOnly}
      <!-- 行选（T4）：只在能安全逐行写入的 canonical 差异里出现；不能用时把原因写在 title 上。
           数量、清除与写入入口都在同一个分组里，和块级按钮一样受 disabled 保护。
           窄工具条把「清除」收进溢出，写入入口与已选行数始终留在原位。 -->
      <div class="diff-toolbar-group diff-pick-bar">
        <button
          type="button"
          class="btn btn-ghost btn-sm diff-ws-btn diff-pick-btn"
          aria-pressed={pickMode}
          aria-label="选择行"
          title={pickBlocker ?? (pickMode ? "点击已选行可取消，Shift+点击可连选区间，按 Esc 或再次点「选行」退出" : "开启后点击新增或删除行（Shift+点击连选区间），再单独暂存")}
          disabled={!canPickLines && !pickMode}
          onclick={() => setPickMode(!pickMode)}
        >
          <Icon name="list-checks" size={13} /><span class="diff-hist-label">选行</span>
        </button>
        {#if pickMode}
          <span class="chip" data-line-count aria-label={"已选择 " + picked.length + " 行"}>{picked.length} 行</span>
          {#if tier !== "narrow" && currentDiff.hunks.some((hunk) => hunk.complete)}
            {@const allPickable = lines.filter((line): line is ViewLine & { hunkIndex: number; kind: "add" | "del" } => canPick(line))}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label="全选可选行"
              title={allPickable.length === 0 ? "没有可选中的行" : picked.length === allPickable.length ? "已经选中全部可选行" : "选中当前差异里全部可逐行暂存的新增与删除行"}
              disabled={allPickable.length === 0 || picked.length === allPickable.length}
              onclick={() => {
                picked = allPickable.map((line) => ({ hunkIndex: line.hunkIndex, kind: line.kind, oldNo: line.oldNo, newNo: line.newNo }));
                pickAnchorIndex = null;
                pickAnchorSelecting = true;
              }}
            >全选</button>
          {/if}
          {#if tier !== "narrow"}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label="清除选中的行"
              title={picked.length === 0 ? "还没有选中任何行" : "清空当前的行选择"}
              disabled={picked.length === 0}
              onclick={() => {
                picked = [];
                pickAnchorIndex = null;
                pickAnchorSelecting = true;
              }}
            >清除</button>
          {/if}
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            aria-label={selection?.side === "staged" ? "取消暂存选中行" : "暂存选中行"}
            title={stageBlocked ?? (disabled ? BUSY_REASON : picked.length === 0 ? "先在差异里选中新增或删除行" : undefined)}
            disabled={disabled || Boolean(stageBlocked) || picked.length === 0}
            onclick={commitPickedLines}
          >{selection?.side === "staged" ? "取消暂存选中行" : "暂存选中行"}</button>
        {/if}
      </div>
    {/if}
    {#if showLayoutInline}
      <div class="diff-toolbar-group">
        <div class="segmented" role="group" aria-label="差异布局">
          <button type="button" aria-pressed={preferred === "unified"} title="统一视图" onclick={() => (ownMode = "unified")}><Icon name="rows" size={12} />统一</button>
          <button type="button" aria-pressed={preferred === "split"} title="并排视图" onclick={() => (ownMode = "split")}><Icon name="split" size={12} />并排</button>
        </div>
      </div>
    {/if}
    {#if showOverflow}
      <!-- 溢出入口：低频工具与显示偏好常驻这里，与主行动作共用同一份 diffPrefs / fullFile /
           renderMode 状态，生效状态写在条目右侧，禁用原因就地说明；关闭后焦点回到触发按钮。 -->
      <div class="diff-toolbar-group diff-overflow">
        {#if specials.eolLabel}
          <button
            type="button"
            class="diff-eol-pill"
            data-diff-eol
            aria-pressed={diffPrefs.whitespaceMode === "eol"}
            title={specials.eolOnlyHunks > 0
              ? `换行符变化：${specials.eolLabel}（${specials.eolOnlyHunks} 处仅换行符不同，点击可切换忽略换行符差异）`
              : `换行符变化：${specials.eolLabel}`}
            onclick={toggleIgnoreEol}
          >{specials.eolLabel}</button>
        {/if}
        {#if specials.bomChanged}
          <span class="diff-eol-pill bom" data-diff-bom title="文件头 UTF-8 BOM 标记（U+FEFF）发生变化">BOM</span>
        {/if}
        {#if fullFile && onFullFile && selection}
          <!-- 「查看完整文件」收进溢出，但生效期间主行留一个一眼可见的恢复入口。 -->
          <button
            type="button"
            class="diff-ws-note diff-ws-note-btn"
            data-diff-full
            title="当前显示整份文件，改动仍高亮；点击恢复只看改动部分"
            onclick={() => onFullFile?.(false)}
          >完整文件</button>
        {/if}
        {#if whitespaceFilter.hunks.size > 0}
          <!-- 开关收进了溢出，但「有改动没显示」这件事不能跟着藏起来。 -->
          <button
            type="button"
            class="diff-ws-note diff-ws-note-btn"
            data-diff-trimmed
            title={`${whitespaceFilter.lines} 行按「${activeFilterSummary}」规则已隐藏；点击显示全部差异`}
            onclick={clearDiffFilterRules}
          >已隐藏 {whitespaceFilter.hunks.size} 处</button>
        {:else if activeFilterRules && canFilterWhitespace}
          <button
            type="button"
            class="diff-rule-pill"
            data-diff-rule-active
            title={`当前生效比对规则：${activeFilterSummary}；点击清除过滤规则`}
            onclick={clearDiffFilterRules}
          ><Icon name="filter" size={11} /><span>{activeFilterSummary}</span><Icon name="x" size={10} /></button>
        {/if}
        {#if currentDiff && !currentDiff.binary && !currentDiff.preview && currentDiff.lines.length > 0}
          <button
            type="button"
            class="icon-btn sm diff-find-btn"
            aria-pressed={findOpen}
            aria-label="在差异中查找"
            title={`在差异中查找（${MODIFIER_LABEL} F）`}
            onclick={() => (findOpen ? closeFind() : openFind())}
          >
            <Icon name="search" size={14} />
          </button>
        {/if}
        <button
          type="button"
          class="icon-btn sm diff-more-btn"
          data-active={pressedToolCount > 0 ? "true" : undefined}
          aria-label={moreLabel}
          aria-haspopup="listbox"
          aria-expanded={moreOpen}
          title={moreLabel}
          bind:this={moreAnchor}
          onclick={() => (moreOpen ? closeMore() : openMore())}
        >
          <Icon name="more" size={15} />
        </button>
        {#if moreOpen && moreAnchor}
          <Popover
            anchor={moreAnchor}
            label="差异工具"
            placeholder="搜索差异工具…"
            searchLabel="搜索差异工具"
            width={320}
            bind:query={moreQuery}
            bind:active={moreActive}
            count={visibleTools.length}
            onChoose={(index) => runTool(visibleTools[index])}
            onClose={closeMore}
          >
            {#snippet notice()}
              {#if selection && showLanguageInMenu}
                <!-- 语法高亮语言是低频偏好：作为菜单常驻行放在搜索框下，不占主工具条。
                     它自带弹层，展开时点按不冒泡到本菜单的外部关闭。 -->
                <div class="diff-tool-language">
                  <LanguagePicker path={selection.path} />
                </div>
              {/if}
            {/snippet}
            {#snippet list(listId)}
              {#if visibleTools.length === 0}
                <p class="diff-tool-empty">没有匹配的差异工具</p>
              {:else}
                {#each visibleTools as tool, index (tool.id)}
                  <button
                    type="button"
                    class="diff-tool-option"
                    class:active={index === moreActive}
                    role="option"
                    id={`${listId}-${index}`}
                    data-index={index}
                    tabindex="-1"
                    aria-selected={tool.selected ? "true" : "false"}
                    aria-disabled={tool.reason ? "true" : undefined}
                    title={tool.reason ?? tool.note}
                    onmousemove={() => (moreActive = index)}
                    onclick={() => runTool(tool)}
                  >
                    <Icon name={tool.icon} size={14} />
                    <span class="diff-tool-copy">
                      <span class="diff-tool-name">{tool.label}</span>
                      {#if tool.reason}<small class="diff-tool-reason">{tool.reason}</small>{:else if tool.note}<small>{tool.note}</small>{/if}
                    </span>
                    {#if tool.state}<span class="diff-tool-state">{tool.state}</span>{/if}
                    {#if tool.submenu}<Icon name="chevron-right" size={13} />{:else if tool.selected}<Icon name="check" size={13} />{/if}
                  </button>
                {/each}
              {/if}
            {/snippet}
          </Popover>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
  {#if conflicted && selection && !embedded}
    <div class="empty" role="status" data-diff-conflict>
      <span class="empty-icon warn"><Icon name="merge" size={24} /></span>
      <strong>这个文件有未解决的冲突</strong>
      <p>两边都改了同一处内容，需要在三栏合并里选择保留哪一边，处理完再暂存提交。</p>
      {#if onResolve}
        <button type="button" class="btn btn-primary btn-sm" onclick={onResolve}><Icon name="merge" size={13} />去处理冲突</button>
      {/if}
    </div>
  {:else if error}
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
      {#if onViewAsText}
        <!-- Git 只要在开头看到 NUL 字节就按二进制处理；源码里混进一个也会这样。按文本读出来仍可查看。 -->
        <button type="button" class="btn btn-secondary btn-sm" title="让 Git 按文本输出差异；不可显示的字符用 ␀ 或 � 代替，只读" onclick={() => onViewAsText?.(true)}>
          <Icon name="code" size={13} />按文本查看
        </button>
      {/if}
    </div>
  {:else if metaOnly}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>只有文件属性变化</strong>
      <p>{shown.meta.join("；")}</p>
    </div>
  {:else if filteredAll}
    <div class="empty" role="status" data-diff-filtered>
      <span class="empty-icon"><Icon name="filter" size={24} /></span>
      <strong>差异已被当前过滤条件隐藏</strong>
      <p>{whitespaceFilter.hunks.size} 个改动块按「{activeFilterSummary}」没有显示。</p>
      <button type="button" class="btn btn-secondary btn-sm" onclick={clearDiffFilterRules}>
        {diffPrefs.hideWhitespaceOnly && !diffPrefs.ignoreBlankLines && !diffPrefs.ignoreCase ? "显示空白改动" : "显示全部差异"}
      </button>
    </div>
  {:else if !currentDiff || (currentDiff.lines.length === 0 && currentDiff.totalLines === 0)}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>没有文本差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else}
    {#if findOpen && !embedded}
      <div class="file-findbar diff-findbar" role="search" aria-label="在差异中查找">
        <div class="field sm">
          <Icon name="search" size={13} />
          <input
            bind:this={findInput}
            aria-label="差异内查找关键词"
            placeholder="在差异中查找"
            title="只在当前文件已读到的差异行里查找（含上下文）"
            autocomplete="off"
            spellcheck="false"
            bind:value={findQuery}
            onkeydown={(event) => {
              if (event.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              } else if (event.key === "Enter") {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {#if findQuery}
            <span class="find-count" class:none={findRows.length === 0} role="status">
              {findRows.length === 0 ? "没有匹配" : `${findCursor >= 0 ? `${findCursor + 1}/` : ""}${findRows.length} 行`}
            </span>
          {/if}
        </div>
        <button
          type="button"
          class="icon-btn sm diff-find-case"
          aria-pressed={findCase}
          aria-label="区分大小写"
          title="区分大小写"
          onclick={() => (findCase = !findCase)}
        >Aa</button>
        <button type="button" class="icon-btn sm" aria-label="上一处匹配" title="上一处（Shift Enter）" disabled={findRows.length === 0} onclick={() => stepFind(-1)}>
          <Icon name="chevron-up" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="下一处匹配" title="下一处（Enter）" disabled={findRows.length === 0} onclick={() => stepFind(1)}>
          <Icon name="chevron-down" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="关闭差异内查找" title="关闭（Esc）" onclick={closeFind}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {#if moreToRead && findQuery}
        <p class="diff-find-note">只在已读到的 {currentDiff.lines.length} / {currentDiff.totalLines} 行里查找；继续加载后会包含更多内容。</p>
      {/if}
    {/if}
    {#if asText && onViewAsText}
      <div class="infobar info" role="status" data-diff-as-text>
        <Icon name="info" size={14} />
        <span class="infobar-text">Git 把这个文件当作二进制，这里按文本显示：不可显示的字符用 ␀ 或 � 代替，不能按块或按行暂存。</span>
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => onViewAsText?.(false)}>恢复</button>
      </div>
    {/if}
    <div
      class="diff-scroll"
      class:split-x={split}
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      tabindex="0"
      aria-label="差异文本"
      bind:this={scroller}
      use:rememberScroll={readingKey ? selectionKey : null}
      onclick={onDiffClick}
      onkeydown={(event) => {
        if (event.key === "Escape" && pickMode && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          setPickMode(false);
          return;
        }
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
      <div class="virtual-space" style={`height:${total * ROW_HEIGHT + inlineGap}px`}>
        {#if !split}
          <div class="code-ruler" aria-hidden="true">{#each ruler as line, i (i)}<span data-text={line.text} style={rulerPadding(line)}></span>{/each}</div>
        {/if}
        <div class="code-stage">
        {#if renderMode === "unified"}
          {#each lines.slice(range.start, range.end) as line, index (`u-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div
              class={lineClass(line.kind)}
              class:pickable={canPick(line)}
              class:picked={canPick(line) && isPicked(line)}
              class:find-hit={findSet.has(absolute)}
              class:find-current={findCurrentRow === absolute}
              data-diff-row=""
              data-line={absolute}
              style={`top:${rowTop(absolute)}px;height:${ROW_HEIGHT}px`}
              title={canPick(line) ? pickLabel(line) : undefined}
            >
              <span class="ln">{line.oldNo ?? ""}</span>
              <span class="ln">{line.newNo ?? ""}</span>
              {#if line.kind === "add" || line.kind === "del" || line.kind === "context"}
                {@const segs = segmentsAt(absolute)}
                {@const showEol = markWhitespace || documents.eolChanged.has(absolute)}
                <span class="code"><span class="code-in" data-sign={sign(line.text)} data-len={codeOf(line).length}>{#if segs.length === 1 && !segs[0].k && !segs[0].m && !segs[0].ws}{segs[0].t}{:else}{#each segs as seg, i (i)}<span class={seg.k} class:wd={seg.m} class:ws-space={seg.ws === "space"} class:ws-tab={seg.ws === "tab"} class:ws-special={seg.ws === "special"} data-ws-label={seg.wsLabel}>{seg.t}</span>{/each}{/if}{#if showEol}<span class="ws-eol" class:eol-changed={documents.eolChanged.has(absolute)} data-eol={line.eol ?? "lf"} aria-hidden="true"></span>{/if}</span></span>
              {:else if line.kind === "hunk"}
                {@const caption = hunkCaption(line.text)}
                {@const headHunk = onCommentLine ? headerHunk(absolute) : null}
                <span class="code hunk-caption"><span class="hunk-at">{caption.at}</span>{#if caption.context}<span class="hunk-context" title={caption.context}>{caption.context}</span>{/if}</span>
                {#if headHunk !== null && hunkCommentTarget(headHunk)}
                  <button
                    type="button"
                    class="btn btn-sm hunk-btn hunk-comment"
                    class:commented={hunkCommented(headHunk)}
                    data-hunk-comment={headHunk}
                    title="给这一整块改动写一条意见"
                    onclick={() => commentHunk(headHunk)}
                  ><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg><span>评论此块</span></button>
                {/if}
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
                    title={hunkStageTitle(hunk)}
                    onclick={() => onStageHunk(hunk)}
                  >{hunkLabel(hunk)}</button>
                {/if}
              {/if}
              {#if canPick(line)}
                <!-- 行选：加删行各自一枚，落在与「暂存此块」同一列，不挤动代码列。 -->
                <button
                  type="button"
                  class="btn btn-sm hunk-btn line-pick"
                  class:btn-secondary={isPicked(line)}
                  class:btn-ghost={!isPicked(line)}
                  aria-pressed={isPicked(line)}
                  aria-label={pickLabel(line)}
                  title={pickLabel(line)}
                  data-line-pick={absolute}
                  onclick={(event) => toggleLineAt(absolute, event.shiftKey)}
                >
                  <Icon name={isPicked(line) ? "check" : line.kind === "del" ? "minus" : "plus"} size={11} />
                </button>
              {/if}
              {#if canComment(line)}
                <!-- 行意见：只读的任务净差异也能加，不改 Git，也不占用暂存入口。 -->
                <button
                  type="button"
                  class="btn btn-sm hunk-btn line-comment"
                  class:commented={hasComment(line)}
                  aria-pressed={hasComment(line)}
                  aria-label={commentLabel(line)}
                  title={hasComment(line) ? commentLabel(line) + "（这一行已有意见）" : commentLabel(line)}
                  data-comment-line={absolute}
                  onclick={() => commentAt(line)}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </button>
              {/if}
            </div>
          {/each}
        {:else}
          {#each sideRows.slice(range.start, range.end) as row, index (`s-${range.start + index}`)}
            {@const absolute = range.start + index}
            <div
              class="side-row"
              class:span={row.span}
              class:find-hit={findSet.has(absolute)}
              class:find-current={findCurrentRow === absolute}
              data-diff-row=""
              data-line={row.right?.index ?? row.left?.index ?? undefined}
              style={`top:${rowTop(absolute)}px;height:${ROW_HEIGHT}px`}
            >
              <!-- 占位格用 blank 而不是 empty：.empty 是全局空状态（flex + 32px 内边距），会把单元格撑到 64px，相邻行文字叠在一起。 -->
              {#if row.span && row.left?.kind === "hunk"}
                {@const caption = hunkCaption(row.left.text)}
                {@const sideHunk = onCommentLine && row.left.index !== undefined ? headerHunk(row.left.index) : null}
                <span class="side-cell hunk side-hunk"><span class="ln"></span><span class="code hunk-caption"><span class="hunk-at">{caption.at}</span>{#if caption.context}<span class="hunk-context" title={caption.context}>{caption.context}</span>{/if}</span></span>
                {#if sideHunk !== null && hunkCommentTarget(sideHunk)}
                  <button
                    type="button"
                    class="btn btn-sm hunk-btn hunk-comment"
                    class:commented={hunkCommented(sideHunk)}
                    data-hunk-comment={sideHunk}
                    title="给这一整块改动写一条意见"
                    onclick={() => commentHunk(sideHunk)}
                  ><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg><span>评论此块</span></button>
                {/if}
              {:else}
              <span
                class={`side-cell side-l ${row.left?.kind ?? "blank"}`}
                class:pickable={canPick(pickLineOf(row.left))}
                class:picked={canPick(pickLineOf(row.left)) && isPicked(pickLineOf(row.left)!)}
                title={canPick(pickLineOf(row.left)) ? pickLabel(pickLineOf(row.left)!) : undefined}
                data-line={row.left?.index}
              >
                {#if row.left}<span class="ln">{row.left.no ?? ""}</span>{#if row.left.index !== undefined && !row.span}{@const leftLine = lines[row.left.index]}{@const showLeftEol = markWhitespace || documents.eolChanged.has(row.left.index)}<span class="code"><span class="code-in" data-sign={sign(row.left.text)} data-len={codeOf(row.left).length}>{#each segmentsAt(row.left.index) as seg, i (i)}{#if !seg.k && !seg.m && !seg.ws}{seg.t}{:else}<span class={seg.k} class:wd={seg.m} class:ws-space={seg.ws === "space"} class:ws-tab={seg.ws === "tab"} class:ws-special={seg.ws === "special"} data-ws-label={seg.wsLabel}>{seg.t}</span>{/if}{/each}{#if showLeftEol && leftLine}<span class="ws-eol" class:eol-changed={documents.eolChanged.has(row.left.index)} data-eol={leftLine.eol ?? "lf"} aria-hidden="true"></span>{/if}</span></span>{:else}<span class="code"><span class="code-in" data-len={row.left.text.length}>{row.left.text}</span></span>{/if}{/if}
              </span>
              <span
                class={`side-cell side-r ${row.right?.kind ?? "blank"}`}
                class:pickable={canPick(pickLineOf(row.right))}
                class:picked={canPick(pickLineOf(row.right)) && isPicked(pickLineOf(row.right)!)}
                title={canPick(pickLineOf(row.right)) ? pickLabel(pickLineOf(row.right)!) : undefined}
                data-line={row.right?.index}
              >
                {#if row.right}<span class="ln">{row.right.no ?? ""}</span>{#if row.right.index !== undefined && !row.span}{@const rightLine = lines[row.right.index]}{@const showRightEol = markWhitespace || documents.eolChanged.has(row.right.index)}<span class="code"><span class="code-in" data-sign={sign(row.right.text)} data-len={codeOf(row.right).length}>{#each segmentsAt(row.right.index) as seg, i (i)}{#if !seg.k && !seg.m && !seg.ws}{seg.t}{:else}<span class={seg.k} class:wd={seg.m} class:ws-space={seg.ws === "space"} class:ws-tab={seg.ws === "tab"} class:ws-special={seg.ws === "special"} data-ws-label={seg.wsLabel}>{seg.t}</span>{/if}{/each}{#if showRightEol && rightLine}<span class="ws-eol" class:eol-changed={documents.eolChanged.has(row.right.index)} data-eol={rightLine.eol ?? "lf"} aria-hidden="true"></span>{/if}</span></span>{:else}<span class="code"><span class="code-in" data-len={row.right.text.length}>{row.right.text}</span></span>{/if}{/if}
              </span>
              {/if}
              {#if !readOnly && !fullFile && row.showStage && row.hunkIndex !== null}
                {@const hunk = currentDiff.hunks.find((item) => item.index === row.hunkIndex)}
                {#if hunk}
                  <button
                    type="button"
                    class={`btn btn-sm hunk-btn ${hunk.stageable ? "btn-secondary" : "btn-ghost"}`}
                    disabled={disabled || !hunk.stageable}
                    title={hunkStageTitle(hunk)}
                    onclick={() => onStageHunk(hunk)}
                  >{hunkLabel(hunk)}</button>
                {/if}
              {/if}
              {#if canPick(pickLineOf(row.left)) || canPick(pickLineOf(row.right)) || canComment(pickLineOf(row.left)) || canComment(pickLineOf(row.right))}
                <!-- 并排视图：左右两侧各自独立选择，身份与统一视图完全一致。 -->
                <span class="side-picks">
                  {#if canPick(pickLineOf(row.left))}
                    <button
                      type="button"
                      class="btn btn-sm hunk-btn line-pick"
                      class:btn-secondary={isPicked(pickLineOf(row.left)!)}
                      class:btn-ghost={!isPicked(pickLineOf(row.left)!)}
                      aria-pressed={isPicked(pickLineOf(row.left)!)}
                      aria-label={pickLabel(pickLineOf(row.left)!)}
                      title={pickLabel(pickLineOf(row.left)!)}
                      data-line-pick={row.left?.index}
                      onclick={(event) => pickRowSide(row.left, event.shiftKey)}
                    >
                      <Icon name={isPicked(pickLineOf(row.left)!) ? "check" : "minus"} size={11} />
                    </button>
                  {/if}
                  {#if canPick(pickLineOf(row.right))}
                    <button
                      type="button"
                      class="btn btn-sm hunk-btn line-pick"
                      class:btn-secondary={isPicked(pickLineOf(row.right)!)}
                      class:btn-ghost={!isPicked(pickLineOf(row.right)!)}
                      aria-pressed={isPicked(pickLineOf(row.right)!)}
                      aria-label={pickLabel(pickLineOf(row.right)!)}
                      title={pickLabel(pickLineOf(row.right)!)}
                      data-line-pick={row.right?.index}
                      onclick={(event) => pickRowSide(row.right, event.shiftKey)}
                    >
                      <Icon name={isPicked(pickLineOf(row.right)!) ? "check" : "plus"} size={11} />
                    </button>
                  {/if}
                  {#if canComment(pickLineOf(row.left))}
                    <button
                      type="button"
                      class="btn btn-sm hunk-btn line-comment"
                      class:commented={hasComment(pickLineOf(row.left)!)}
                      aria-pressed={hasComment(pickLineOf(row.left)!)}
                      aria-label={commentLabel(pickLineOf(row.left)!)}
                      title={commentLabel(pickLineOf(row.left)!)}
                      data-comment-line={row.left?.index}
                      onclick={() => commentCell(row.left)}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    </button>
                  {/if}
                  {#if canComment(pickLineOf(row.right))}
                    <button
                      type="button"
                      class="btn btn-sm hunk-btn line-comment"
                      class:commented={hasComment(pickLineOf(row.right)!)}
                      aria-pressed={hasComment(pickLineOf(row.right)!)}
                      aria-label={commentLabel(pickLineOf(row.right)!)}
                      title={commentLabel(pickLineOf(row.right)!)}
                      data-comment-line={row.right?.index}
                      onclick={() => commentCell(row.right)}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    </button>
                  {/if}
                </span>
              {/if}
            </div>
          {/each}
        {/if}
        {#if inlineIndex !== null && inlinePanel}
          <!-- 原位意见行：紧跟锚点行（或块标题）之后，统一视图跨整行、并排视图跨两栏。
               它不是差异文本：键盘、点击与右键都不冒泡到差异滚动区的快捷键与行选。 -->
          <div
            class="diff-inline-comment"
            class:split
            data-inline-after={inlineIndex}
            style={`top:${(inlineIndex + 1) * ROW_HEIGHT}px`}
            role="presentation"
            bind:offsetHeight={inlineHeight}
            onkeydown={(event) => event.stopPropagation()}
            onclick={(event) => event.stopPropagation()}
            oncontextmenu={(event) => event.stopPropagation()}
          >
            {@render inlinePanel()}
          </div>
        {/if}
        </div>
      </div>
      {#if hiddenChange}
        <!-- 0 高的粘性锚点钉在视口右下角，入口浮在代码上方，不占行、不挤动任何内容。 -->
        <div class="hidden-change-anchor">
          <button
            type="button"
            class="hidden-change"
            data-hidden-change={hiddenChange.direction}
            title={`有 ${hiddenChange.count} 行的改动在${hiddenChange.direction === "right" ? "右" : "左"}侧视野外，点击横向滚动到最上面那处`}
            onclick={revealHiddenChange}
          >
            {#if hiddenChange.direction === "left"}<Icon name="arrow-left" size={12} />{/if}
            <span>{hiddenChange.count} 行改动在{hiddenChange.direction === "right" ? "右" : "左"}侧</span>
            {#if hiddenChange.direction === "right"}<Icon name="arrow-right" size={12} />{/if}
          </button>
        </div>
      {/if}
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
