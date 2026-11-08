<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { createQuietActivity } from "../quiet-activity";
  import { MODIFIER_LABEL } from "../brand";
  import { hunkCaption, hunkJump, hunkRowIndexes, lineSelectionScope, splitColumnsFit, toSideRows, visibleDiffLines, whitespaceOnlyHunks, type HunkNavReport, type ViewLine, type WhitespaceFilter } from "../diff";
  import { diffPrefs, setHideWhitespaceOnly, toggleHideWhitespaceOnly, toggleShowWhitespace } from "../diff-prefs.svelte";
  import type { IconName } from "../icons";
  import { trackCodeScroll } from "../codeScroll.svelte";
  import { codeContentSize, codeRuler, rulerPadding, scrollByRows, visibleRange } from "../layout";
  import type { DiffHunk, DiffLineSelection, DiffResponse, FileSelection } from "../types";
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
  import Popover from "./Popover.svelte";

  interface Props {
    onGeneration?: (generation: number) => void;
    selection: FileSelection | null;
    diff: DiffResponse | null;
    error: string | null;
    loading: boolean;
    disabled: boolean;
    readOnly?: boolean;
    onStageHunk: (hunk: DiffHunk) => void;
    /**
     * 逐行暂存 / 取消暂存。传了它才出现「选行」模式；历史、审查与多文件块不传，
     * 那些位置只保留文件级与块级入口。
     */
    onStageLines?: (lines: DiffLineSelection[]) => void;
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
    onStageLines,
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
  let selectionKey = $derived(selection ? `${selection.side}:${selection.path}` : "");
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
  let whitespaceFilter = $derived<WhitespaceFilter>(
    diffPrefs.hideWhitespaceOnly && canFilterWhitespace ? whitespaceOnlyHunks(shown.lines) : EMPTY_FILTER,
  );
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
    const origin = view.origin[index];
    return origin === undefined ? null : (currentDiff?.hunks.find((hunk) => hunk.startLine === origin) ?? null);
  });
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
  let documents = $derived(buildDiffDocuments(lines));
  const oldSyntax = createHighlight(() => ({ lang: language, lines: documents.oldLines }));
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

  /** 行选为什么不能用：文件级、视图级的原因都要明说，不能只是把按钮灰着。 */
  let pickBlocker = $derived.by<string | null>(() => {
    if (!currentDiff) return "还没有读到差异";
    if (readOnly) return "历史与审查视图是只读的，不会写入暂存区";
    if (conflicted) return "冲突文件要在三栏合并里处理";
    if (currentDiff.binary) return "二进制文件不能按行暂存";
    if (currentDiff.preview) return "图片预览没有可选的代码行";
    if (fullFile) return "完整文件视图不能按行暂存，先切回「只看改动部分」";
    if (currentDiff.truncated) return "差异被截断，按行写入会落到错误的位置";
    if (currentDiff.lines.some((line) => line.kind === "meta" && PICK_HEADER.test(line.text))) {
      return "文件本身新增、删除、改名或权限变化，不能逐行暂存";
    }
    if (!currentDiff.hunks.some((hunk) => hunk.complete)) return "没有可逐行暂存的完整代码块";
    return null;
  });
  let canPickLines = $derived(Boolean(onStageLines && currentDiff && pickBlocker === null));
  /** 只有完整代码块里的行能写：截断块的坐标不可靠。 */
  let pickableHunks = $derived(
    new Set((currentDiff?.hunks ?? []).filter((hunk) => hunk.complete).map((hunk) => hunk.index)),
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

  function pickRowSide(cell: { index?: number } | null): void {
    const line = pickLineOf(cell);
    if (line) toggleLine(line);
  }

  type PickableLine = { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null };

  function isPicked(line: PickableLine): boolean {
    const key = pickKey(line);
    return picked.some((item) => pickKey(item) === key);
  }

  function pickLabel(line: PickableLine): string {
    const no = line.kind === "del" ? line.oldNo : line.newNo;
    const what = line.kind === "del" ? "删除" : "新增";
    return (isPicked(line) ? "取消选择" : "选择") + what + "第 " + (no ?? "?") + " 行";
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

  /** 进入或退出选行模式都清空选择，避免看不见的选择被写入。 */
  function setPickMode(next: boolean): void {
    if (next && !canPickLines) return;
    if (pickMode === next) return;
    pickMode = next;
    picked = [];
  }

  function commitPickedLines(): void {
    if (!onStageLines || picked.length === 0 || disabled) return;
    onStageLines(picked.slice());
  }

  /**
   * 行选清理入口：换文件、generation、布局、完整文件、空白显示或过滤之后，之前选中的行可能
   * 已经不在屏幕上，必须清掉，否则不可见的行会被写进暂存。
   */
  function clearLineSelection(): void {
    if (picked.length > 0) picked = [];
    if (pickMode) pickMode = false;
  }

  let lineScope = $derived(
    lineSelectionScope({
      path: selection?.path ?? "",
      side: selection?.side ?? "unstaged",
      generation: currentDiff?.generation ?? null,
      mode: renderMode,
      fullFile,
      hideWhitespaceOnly: diffPrefs.hideWhitespaceOnly,
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
  /* 行选进行中优先保住选择与写入的可达性：中间宽度再让出显示偏好这一档；完整宽度放得下，不搬动。 */
  let showDisplayPrefsInline = $derived(
    tier !== "narrow" && canFilterWhitespace && !(tier === "compact" && pickMode),
  );
  let showOverflow = $derived(tier !== "full");
  /* 文件工具里语言标签很窄，任何一档都留在工具条上；历史与完整文件在完整档才直接露出。 */
  let inlineLanguage = $derived(Boolean(currentDiff && !currentDiff.binary && selection));
  let inlineFileHistory = $derived(tier === "full" && Boolean(onFileHistory && selection));
  let inlineFullFile = $derived(tier === "full" && Boolean(onFullFile && selection));
  let hasInlineFileTools = $derived(inlineLanguage || inlineFileHistory || inlineFullFile);

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
    run: () => void;
  }

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
    if (canFilterWhitespace && !showDisplayPrefsInline) {
      tools.push(
        {
          id: "show-whitespace",
          label: "显示空白字符",
          icon: "eye",
          selected: diffPrefs.showWhitespace,
          pressed: diffPrefs.showWhitespace,
          state: diffPrefs.showWhitespace ? "已开启" : "已关闭",
          run: toggleShowWhitespace,
        },
        {
          id: "hide-whitespace",
          label: "忽略纯空白改动",
          icon: "filter",
          selected: diffPrefs.hideWhitespaceOnly,
          pressed: diffPrefs.hideWhitespaceOnly,
          state: diffPrefs.hideWhitespaceOnly ? "已开启" : "已关闭",
          note: whitespaceFilter.hunks.size > 0 ? `已隐藏 ${whitespaceFilter.hunks.size} 处只改了空白的改动` : undefined,
          run: toggleHideWhitespaceOnly,
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
    if (tier === "narrow" && pickMode) {
      tools.push({
        id: "clear-picks",
        label: "清除选中的行",
        icon: "x",
        state: picked.length > 0 ? `已选 ${picked.length} 行` : undefined,
        reason: picked.length === 0 ? "还没有选中任何行" : undefined,
        run: () => (picked = []),
      });
    }
    return tools;
  });
  let visibleTools = $derived.by(() => {
    const needle = moreQuery.trim().toLowerCase();
    if (!needle) return overflowTools;
    return overflowTools.filter((tool) =>
      [tool.label, tool.state, tool.note, tool.reason].some((part) => part?.toLowerCase().includes(needle)),
    );
  });
  let pressedToolCount = $derived(overflowTools.filter((tool) => tool.pressed).length);
  let moreLabel = $derived(
    pressedToolCount > 0 ? `更多差异工具（${pressedToolCount} 项已开启）` : "更多差异工具",
  );
  /** 工具条内容变化（含选中行数、过滤状态）后重新量一次；宽度没变时 ResizeObserver 不会回调。 */
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
    ].join("|"),
  );

  $effect(() => {
    toolbarSignature;
    const node = toolbar;
    if (!node) return;
    const read = () => {
      const width = node.clientWidth;
      if (width !== toolbarWidth) {
        toolbarWidth = width;
        escalated = 0;
      }
      // 估算阈值之外的字体或缩放差异由实际溢出兜底；最多升到 narrow，避免来回抖动。
      if (width > 0 && tier !== "narrow" && node.scrollWidth > width + 1) escalated += 1;
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
    const first = overflowTools.findIndex((tool) => !tool.reason);
    moreActive = first >= 0 ? first : 0;
    moreOpen = true;
  }

  function closeMore(refocus = true): void {
    moreOpen = false;
    if (refocus) moreAnchor?.focus({ preventScroll: true });
  }

  function runTool(tool: DiffTool | undefined): void {
    if (!tool || tool.reason) return;
    closeMore(true);
    tool.run();
  }

  /** 窗口放宽到溢出入口消失时，别把打开状态带到下一次变窄。 */
  $effect(() => {
    if (!showOverflow && moreOpen) moreOpen = false;
  });

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
       段与段之间一条装饰竖线，扫视顺序与操作顺序一致（先认出文件，再选动作，最后是布局）。
       窄窗口只把低频项收进末尾的溢出入口，本行三段的主操作不搬家。 -->
  <div class="diff-toolbar" bind:this={toolbar}>
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
          <!-- 侧别在窄工具条里让位给路径；完整上下文仍在提示里可读。 -->
          <span class="diff-path" title={selection.side === "staged" ? `${selection.path}（已暂存）` : `${selection.path}（未暂存）`}>
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
      {#if refreshVisible && currentDiff}<span class="spinner muted" aria-hidden="true" title="正在刷新差异"></span>{/if}
    </div>
    {#if hasInlineFileTools}
      <div class="diff-toolbar-group">
        {#if inlineLanguage && selection}
          <LanguagePicker path={selection.path} />
        {/if}
        {#if inlineFileHistory && selection}
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
        {#if inlineFullFile && selection}
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
    {#if onToggleReview && selection}
      <div class="diff-toolbar-group">
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
          title={pickBlocker ?? (pickMode ? "退出按行选择，保留文件与块级入口" : "按行选择新增或删除行，再单独暂存")}
          disabled={!canPickLines && !pickMode}
          onclick={() => setPickMode(!pickMode)}
        >
          <Icon name="check" size={13} /><span class="diff-hist-label">选行</span>
        </button>
        {#if pickMode}
          <span class="badge" data-line-count aria-label={"已选择 " + picked.length + " 行"}>{picked.length} 行</span>
          {#if tier !== "narrow"}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label="清除选中的行"
              title={picked.length === 0 ? "还没有选中任何行" : "清空当前的行选择"}
              disabled={picked.length === 0}
              onclick={() => (picked = [])}
            >清除</button>
          {/if}
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            aria-label={selection?.side === "staged" ? "取消暂存选中行" : "暂存选中行"}
            title={disabled ? BUSY_REASON : picked.length === 0 ? "先在差异里选中新增或删除行" : undefined}
            disabled={disabled || picked.length === 0}
            onclick={commitPickedLines}
          >{selection?.side === "staged" ? "取消暂存选中行" : "暂存选中行"}</button>
        {/if}
      </div>
    {/if}
    {#if showLayoutInline || showDisplayPrefsInline}
      <div class="diff-toolbar-group">
        {#if showLayoutInline}
          <div class="segmented" role="group" aria-label="差异布局">
            <button type="button" aria-pressed={preferred === "unified"} title="统一视图" onclick={() => (ownMode = "unified")}><Icon name="rows" size={12} />统一</button>
            <button type="button" aria-pressed={preferred === "split"} title="并排视图" onclick={() => (ownMode = "split")}><Icon name="split" size={12} />并排</button>
          </div>
        {/if}
        <!-- 只有真正的文本差异才有可标记的空白：二进制、图片预览、冲突专用视图和截断内容上不出现这两个开关。 -->
        {#if showDisplayPrefsInline && canFilterWhitespace}
          <!-- 两个开关都只影响显示：代码文本、复制内容和暂存补丁仍用原始差异。 -->
          <button
            type="button"
            class="btn btn-ghost btn-sm diff-ws-btn"
            aria-pressed={diffPrefs.showWhitespace}
            aria-label="显示空白字符"
            title={diffPrefs.showWhitespace ? "不再标出空格与制表符" : "把空格和制表符标出来；复制与暂存仍是原文"}
            onclick={toggleShowWhitespace}
          >
            <Icon name="eye" size={13} /><span class="diff-hist-label">空白</span>
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm diff-ws-btn"
            aria-pressed={diffPrefs.hideWhitespaceOnly}
            aria-label="忽略纯空白改动"
            title={diffPrefs.hideWhitespaceOnly ? "重新显示只改了空白的改动块" : "隐藏只改了空白字符的改动块；混合改动仍然完整显示"}
            onclick={toggleHideWhitespaceOnly}
          >
            <Icon name="filter" size={13} /><span class="diff-hist-label">略过空白</span>
          </button>
          {#if whitespaceFilter.hunks.size > 0}
            <span
              class="diff-ws-note"
              role="status"
              data-diff-trimmed
              title={whitespaceFilter.lines + " 行只改了空白，按当前设置没有显示；点「略过空白」可以恢复"}
            >已隐藏 {whitespaceFilter.hunks.size} 处</span>
          {/if}
        {/if}
      </div>
    {/if}
    {#if showOverflow}
      <!-- 溢出入口（R2）：与直接入口共用同一份 diffPrefs / fullFile / renderMode 状态，
           生效状态写在条目右侧，禁用原因就地说明；关闭后焦点回到触发按钮。 -->
      <div class="diff-toolbar-group diff-overflow">
        <button
          type="button"
          class="icon-btn sm diff-more-btn"
          aria-label={moreLabel}
          aria-haspopup="listbox"
          aria-expanded={moreOpen}
          title={moreLabel}
          bind:this={moreAnchor}
          onclick={() => (moreOpen ? closeMore() : openMore())}
        >
          <Icon name="more" size={15} />
          {#if pressedToolCount > 0}<span class="diff-more-dot" aria-hidden="true"></span>{/if}
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
                    {#if tool.selected}<Icon name="check" size={13} />{/if}
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
      <p>{whitespaceFilter.hunks.size} 个改动块只改了空白字符，按「略过纯空白改动」没有显示。</p>
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => setHideWhitespaceOnly(false)}>显示空白改动</button>
    </div>
  {:else if !currentDiff || (currentDiff.lines.length === 0 && currentDiff.totalLines === 0)}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="file" size={24} /></span>
      <strong>没有文本差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else}
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
                <span class="code"><span class="code-in" data-sign={sign(line.text)} data-len={codeOf(line).length}>{#if segs.length === 1 && !segs[0].k && !segs[0].m && !segs[0].ws}{segs[0].t}{:else}{#each segs as seg, i (i)}<span class={seg.k} class:wd={seg.m} class:ws-space={seg.ws === "space"} class:ws-tab={seg.ws === "tab"}>{seg.t}</span>{/each}{/if}</span></span>
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
                  onclick={() => toggleLine(line)}
                >
                  <Icon name={isPicked(line) ? "check" : line.kind === "del" ? "minus" : "plus"} size={11} />
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
                {#if row.left}<span class="ln">{row.left.no ?? ""}</span>{#if row.left.index !== undefined && !row.span}<span class="code"><span class="code-in" data-sign={sign(row.left.text)} data-len={codeOf(row.left).length}>{#each segmentsAt(row.left.index) as seg, i (i)}{#if !seg.k && !seg.m && !seg.ws}{seg.t}{:else}<span class={seg.k} class:wd={seg.m} class:ws-space={seg.ws === "space"} class:ws-tab={seg.ws === "tab"}>{seg.t}</span>{/if}{/each}</span></span>{:else}<span class="code"><span class="code-in" data-len={row.left.text.length}>{row.left.text}</span></span>{/if}{/if}
              </span>
              <span class={`side-cell side-r ${row.right?.kind ?? "blank"}`}>
                {#if row.right}<span class="ln">{row.right.no ?? ""}</span>{#if row.right.index !== undefined && !row.span}<span class="code"><span class="code-in" data-sign={sign(row.right.text)} data-len={codeOf(row.right).length}>{#each segmentsAt(row.right.index) as seg, i (i)}{#if !seg.k && !seg.m && !seg.ws}{seg.t}{:else}<span class={seg.k} class:wd={seg.m} class:ws-space={seg.ws === "space"} class:ws-tab={seg.ws === "tab"}>{seg.t}</span>{/if}{/each}</span></span>{:else}<span class="code"><span class="code-in" data-len={row.right.text.length}>{row.right.text}</span></span>{/if}{/if}
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
              {#if canPick(pickLineOf(row.left)) || canPick(pickLineOf(row.right))}
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
                      onclick={() => pickRowSide(row.left)}
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
                      onclick={() => pickRowSide(row.right)}
                    >
                      <Icon name={isPicked(pickLineOf(row.right)!) ? "check" : "plus"} size={11} />
                    </button>
                  {/if}
                </span>
              {/if}
            </div>
          {/each}
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
