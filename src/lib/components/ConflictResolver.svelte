<script module lang="ts">
  export type ResolverMode = "hunks" | "preview" | "whole" | "diff";
</script>

<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { onDestroy, onMount, tick, untrack, type Snippet } from "svelte";
  import {
    alignHunk,
    choiceLabel,
    composeConflictText,
    hasConflictMarkers,
    hintLabel,
    hunkHint,
    inlineRange,
    parseConflictText,
    resolvedLines,
    simpleResolution,
    stripEol,
    unresolvedCount,
    type ConflictChoice,
    type ConflictDraft,
    type ConflictHunk,
    type ConflictResolution,
    type ConflictResolutions,
  } from "../conflict";
  import { createTextDiff } from "../diff";
  import { portal } from "../portal";
  import type { ConflictView } from "../types";
  import { highlightLines, type SyntaxLine } from "../syntax/client";
  import { effectiveLanguage } from "../syntax/prefs.svelte";
  import { lineSegments } from "../syntax/segments";
  import DiffView from "./DiffView.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";
  import Icon from "./Icon.svelte";
  import ThreeWayMerge from "./ThreeWayMerge.svelte";

  /**
   * 逐处处理冲突（单个文本文件）。
   *
   * 以工作区里带冲突标记的文件为准：Git 已自动合并的部分原样保留，只有标记包住的区域
   * 需要决定。每一处都要明确选择（当前 / 来源 / 两者 / 共同祖先 / 手动编辑），全部处理后
   * 才能标记；整文件编辑是兜底。几万行的文件只渲染视口内的行，未冲突的内容默认折叠。
   * 写入只发生在「标记为已解决」，之前的选择都只是本地草稿，可以随时撤销或重置。
   */
  interface Props {
    view: ConflictView;
    currentLabel: string;
    incomingLabel: string;
    draft?: ConflictDraft | null;
    disabled: boolean;
    /** 每次选择变化时回报草稿与进度，宿主据此在文件列表上显示「已处理 x/y」并在切换文件后恢复。 */
    onDraft?: (draft: ConflictDraft, progress: { total: number; done: number }) => void;
    /** choice 为 "text" 时 content 是要写回的完整结果；"ours"/"theirs"/"delete" 由后端取整份版本。 */
    onResolve: (choice: string, content?: string) => void;
    /** 工具条最前面的内容（文件名），由宿主提供，这样文件头和视图切换共用一条。 */
    lead?: Snippet;
    /** 底部进度与标记的落点：宿主把它们和「完成合并」收在同一条；不提供时留在组件底部。 */
    footTarget?: HTMLElement | null;
  }

  let { view, currentLabel, incomingLabel, draft = null, disabled, onDraft, onResolve, lead, footTarget = null }: Props = $props();

  const ROW = 20;
  const HEAD = 36;
  const COLS = 22;
  const FOLD = 28;
  const GAP = 10;
  const CONTEXT = 3;
  const REVEAL = 20;
  const MAX_CH = 600;

  // 初始状态只读一次：同一文件的后续刷新由宿主用 {#key} 重建组件。
  const original = untrack(() => view.result.text ?? "");
  const restored = untrack(() => (draft && draft.original === original ? draft : null));
  let base = $state(restored?.base ?? original);
  let resolutions = $state<ConflictResolutions>(restored ? { ...restored.resolutions } : {});
  let whole = $state<string | null>(restored?.whole ?? null);
  let parsed = $derived(parseConflictText(base));
  let hunkMode = $derived(!parsed.malformed && parsed.hunks.length > 0);
  let mode = $state<ResolverMode>(
    restored?.whole !== null && restored?.whole !== undefined ? "whole" : "hunks",
  );
  let effectiveMode = $derived<ResolverMode>(hunkMode || mode === "diff" ? mode : "whole");
  let current = $state(0);
  let editing = $state<number | null>(null);
  let editText = $state("");
  let showBase = $state(false);
  let armed = $state(false);
  let reveal = $state<Record<number, { head: number; tail: number }>>({});
  let moreOpen = $state(false);
  let moreAnchor = $state<HTMLDivElement | null>(null);
  let keysOpen = $state(false);
  let keysAnchor = $state<HTMLDivElement | null>(null);

  let total = $derived(parsed.hunks.length);
  let remaining = $derived(unresolvedCount(parsed, resolutions));
  let done = $derived(total - remaining);
  let hasBase = $derived(parsed.hunks.some((hunk) => hunk.base !== null));
  let simple = $derived(
    parsed.hunks.filter((hunk) => !resolutions[hunk.index] && simpleResolution(hunk) !== null),
  );
  let wholeText = $derived(whole ?? (hunkMode ? composeConflictText(parsed, resolutions) : base));
  let wholeMarkers = $derived(effectiveMode === "whole" && hasConflictMarkers(wholeText));
  let alignments = $derived(parsed.hunks.map((hunk) => alignHunk(hunk.ours, hunk.theirs)));
  let hints = $derived(parsed.hunks.map((hunk) => hunkHint(hunk)));
  let comparison = $derived(
    effectiveMode === "diff" && view.ours.text !== null && view.theirs.text !== null
      ? createTextDiff(view.path, view.theirs.text, view.ours.text, view.generation)
      : null,
  );

  onMount(() => {
    // 打开文件后直接可用键盘处理：焦点不在输入框里时交给冲突流（1/2/3/4、Alt+↑↓）。
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("input, textarea, select")) return;
    void tick().then(() => scroller?.focus({ preventScroll: true }));
  });

  $effect(() => {
    onDraft?.({ original, base, resolutions, whole }, { total, done: whole === null ? done : 0 });
  });

  /* ---------- 行模型 ---------- */

  type Row =
    | { kind: "fold"; seg: number; hidden: number; from: number; up: boolean; down: boolean }
    | { kind: "ctx"; no: number; text: string; tone?: "res" | "warn"; bk?: string; bi?: number }
    | { kind: "head"; hunk: number }
    | { kind: "cols"; hunk: number }
    | { kind: "pair"; hunk: number; ours: string | null; theirs: string | null; oNo: number | null; tNo: number | null; same: boolean; last: boolean; oi?: number; ti?: number }
    | { kind: "basehead"; hunk: number }
    | { kind: "base"; hunk: number; text: string; no: number; last: boolean; bk?: string; bi?: number }
    | { kind: "res"; hunk: number; text: string; no: number; last: boolean; bk?: string; bi?: number }
    | { kind: "empty"; hunk: number }
    | { kind: "edit"; hunk: number; height: number }
    | { kind: "gap" };

  function rowHeight(row: Row): number {
    switch (row.kind) {
      case "fold":
        return FOLD;
      case "head":
        return HEAD;
      case "cols":
      case "basehead":
        return COLS;
      case "edit":
        return row.height;
      case "gap":
        return GAP;
      default:
        return ROW;
    }
  }

  function editHeight(text: string): number {
    const lines = text.split("\n").length;
    return Math.min(380, Math.max(120, (lines + 1) * ROW + 16)) + 44;
  }

  /**
   * 语法高亮按「块」请求：每段可见的未冲突内容（往前多带至多 LEAD 行，让块注释、多行字符串
   * 的语法状态接得上）、每处冲突的当前 / 来源 / 共同祖先 / 结果各是一块。只请求视口附近用到的块，
   * 几万行的文件也只分词看得见的部分。
   */
  interface Block {
    lines: string[];
    /** 前导行数：分词时带上、显示时丢掉。 */
    lead: number;
  }
  const LEAD = 40;
  let blocks = new Map<string, Block>();

  function registerBlock(key: string, all: string[], from: number, to: number, before: string[] = []): void {
    if (blocks.has(key)) return;
    const start = Math.max(0, from - LEAD);
    // 块前没有足够的同段内容时，借上一段未冲突内容的末尾做前导（冲突两侧才需要上下文）。
    const borrowed = from - start < LEAD ? before.slice(-(LEAD - (from - start))).map(stripEol) : [];
    const lines = [...borrowed, ...all.slice(start, to).map(stripEol)];
    blocks.set(key, { lines, lead: borrowed.length + from - start });
  }

  function buildHunkRows(): Row[] {
    blocks = new Map();
    const rows: Row[] = [];
    let no = 1;
    const segments = parsed.segments;
    let previous: string[] = [];
    segments.forEach((segment, seg) => {
      if (segment.kind === "common") {
        const lines = segment.lines;
        const first = seg === 0;
        const last = seg === segments.length - 1;
        const extra = reveal[seg] ?? { head: 0, tail: 0 };
        const head = first ? 0 : Math.min(lines.length, CONTEXT + extra.head);
        const tail = last ? 0 : Math.min(lines.length - head, CONTEXT + extra.tail);
        const hidden = lines.length - head - tail;
        const push = (from: number, to: number) => {
          if (to <= from) return;
          const bk = `c:${seg}:${from}:${to}`;
          registerBlock(bk, lines, from, to, previous);
          for (let index = from; index < to; index += 1)
            rows.push({ kind: "ctx", no: no + index, text: stripEol(lines[index]), bk, bi: index - from });
        };
        if (hidden <= 2) {
          push(0, lines.length);
        } else {
          push(0, head);
          rows.push({ kind: "fold", seg, hidden, from: no + head, up: !first, down: !last });
          push(lines.length - tail, lines.length);
        }
        no += lines.length;
        previous = lines;
        return;
      }
      const hunk = segment.hunk;
      const resolution = resolutions[hunk.index];
      const leadIn = previous;
      // 冲突之后的未冲突内容以「冲突前内容 + 当前侧」作前导，语法状态接得上。
      previous = [...leadIn.slice(-LEAD), ...hunk.ours];
      rows.push({ kind: "head", hunk: hunk.index });
      if (editing === hunk.index) {
        rows.push({ kind: "edit", hunk: hunk.index, height: editHeight(editText) });
        rows.push({ kind: "gap" });
        no += Math.max(0, editText.split("\n").length);
        return;
      }
      if (resolution) {
        const lines = resolvedLines(hunk, resolution);
        if (lines.length === 0) rows.push({ kind: "empty", hunk: hunk.index });
        const bk = `r:${hunk.index}:${resolution.choice}:${resolution.choice === "custom" ? lines.join("\n") : ""}`;
        registerBlock(bk, lines, 0, lines.length, leadIn);
        lines.forEach((text, index) =>
          rows.push({ kind: "res", hunk: hunk.index, text, no: no + index, last: index === lines.length - 1, bk, bi: index }),
        );
        rows.push({ kind: "gap" });
        no += lines.length;
        return;
      }
      if (showBase && hunk.base) {
        rows.push({ kind: "basehead", hunk: hunk.index });
        const bk = `b:${hunk.index}`;
        registerBlock(bk, hunk.base, 0, hunk.base.length, leadIn);
        hunk.base.forEach((line, index) =>
          rows.push({ kind: "base", hunk: hunk.index, text: stripEol(line), no: index + 1, last: false, bk, bi: index }),
        );
      }
      rows.push({ kind: "cols", hunk: hunk.index });
      registerBlock(`o:${hunk.index}`, hunk.ours, 0, hunk.ours.length, leadIn);
      registerBlock(`t:${hunk.index}`, hunk.theirs, 0, hunk.theirs.length, leadIn);
      const aligned = alignments[hunk.index] ?? [];
      if (aligned.length === 0) {
        rows.push({ kind: "pair", hunk: hunk.index, ours: null, theirs: null, oNo: null, tNo: null, same: false, last: true });
      }
      aligned.forEach((pair, index) =>
        rows.push({
          kind: "pair",
          hunk: hunk.index,
          ours: pair.ours === null ? null : stripEol(hunk.ours[pair.ours]),
          theirs: pair.theirs === null ? null : stripEol(hunk.theirs[pair.theirs]),
          oNo: pair.ours === null ? null : no + pair.ours,
          tNo: pair.theirs === null ? null : no + pair.theirs,
          same: pair.same,
          last: index === aligned.length - 1,
          oi: pair.ours ?? undefined,
          ti: pair.theirs ?? undefined,
        }),
      );
      rows.push({ kind: "gap" });
      no += hunk.ours.length;
    });
    return rows;
  }

  function buildPreviewRows(): Row[] {
    blocks = new Map();
    const rows: Row[] = [];
    let no = 1;
    parsed.segments.forEach((segment, seg) => {
      if (segment.kind === "common") {
        const bk = `p:${seg}`;
        registerBlock(bk, segment.lines, 0, segment.lines.length);
        segment.lines.forEach((line, index) => rows.push({ kind: "ctx", no: no++, text: stripEol(line), bk, bi: index }));
        return;
      }
      const resolution = resolutions[segment.hunk.index];
      const lines = resolution ? resolvedLines(segment.hunk, resolution) : segment.hunk.raw.map(stripEol);
      const bk = resolution ? `pr:${segment.hunk.index}:${lines.join("\n")}` : "";
      if (bk) registerBlock(bk, lines, 0, lines.length);
      lines.forEach((text, index) =>
        rows.push({ kind: "ctx", no: no++, text, tone: resolution ? "res" : "warn", bk: bk || undefined, bi: index }),
      );
    });
    return rows;
  }

  let rows = $derived(effectiveMode === "preview" ? buildPreviewRows() : effectiveMode === "hunks" ? buildHunkRows() : []);
  let offsets = $derived.by(() => {
    const list = new Float64Array(rows.length + 1);
    for (let index = 0; index < rows.length; index += 1) list[index + 1] = list[index] + rowHeight(rows[index]);
    return list;
  });
  let totalHeight = $derived(offsets[rows.length] ?? 0);
  let headIndex = $derived.by(() => {
    const map = new Map<number, number>();
    rows.forEach((row, index) => {
      if (row.kind === "head") map.set(row.hunk, index);
    });
    return map;
  });

  /** 代码区宽度：取所有行的最长显示宽度（CJK 记两格），上限 MAX_CH，保证横向滚动够用。 */
  function displayWidth(text: string): number {
    let width = 0;
    for (let index = 0; index < text.length && width < MAX_CH; index += 1) {
      width += text.charCodeAt(index) > 0x2e80 ? 2 : text.charCodeAt(index) === 9 ? 4 : 1;
    }
    return width;
  }
  let codeCh = $derived.by(() => {
    let max = 40;
    for (const row of rows) {
      if (row.kind === "ctx" || row.kind === "res" || row.kind === "base") max = Math.max(max, displayWidth(row.text));
      else if (row.kind === "pair") max = Math.max(max, displayWidth(row.ours ?? ""), displayWidth(row.theirs ?? ""));
      if (max >= MAX_CH) break;
    }
    return Math.min(max, MAX_CH);
  });

  /* ---------- 虚拟滚动 ---------- */

  let scroller = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewport = $state(0);
  let viewWidth = $state(0);
  let windowHeight = $derived(viewport > 0 ? viewport : 720);

  function firstVisible(top: number): number {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= top) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  let range = $derived.by(() => {
    const start = Math.max(0, firstVisible(scrollTop) - 6);
    let end = start;
    const limit = scrollTop + windowHeight + 240;
    while (end < rows.length && offsets[end] < limit) end += 1;
    return { start, end };
  });
  let visible = $derived(rows.slice(range.start, range.end).map((row, index) => ({ row, index: range.start + index })));

  /* ---------- 语法高亮（按块、只请求视口附近） ---------- */

  let language = $derived(effectiveLanguage(view.path));
  let syntaxVersion = $state(0);
  const syntaxCache = new Map<string, (SyntaxLine | undefined)[]>();
  const syntaxRequests = new Map<string, () => void>();
  let syntaxBasis: unknown = null;

  function dropSyntax() {
    for (const cancel of syntaxRequests.values()) cancel();
    syntaxRequests.clear();
    syntaxCache.clear();
  }

  $effect(() => {
    const lang = language;
    const basis = parsed;
    const keys = new Set<string>();
    for (const { row } of visible) {
      if ((row.kind === "ctx" || row.kind === "base" || row.kind === "res") && row.bk) keys.add(row.bk);
      if (row.kind === "pair") {
        keys.add(`o:${row.hunk}`);
        keys.add(`t:${row.hunk}`);
      }
    }
    untrack(() => {
      // 文本基准变了（整文件编辑后重新解析）：块键不再对应原内容，旧结果全部作废。
      if (basis !== syntaxBasis) {
        syntaxBasis = basis;
        dropSyntax();
        syntaxVersion += 1;
      }
      if (!lang) return;
      for (const key of keys) {
        const id = `${lang}\u0000${key}`;
        if (syntaxCache.has(id)) continue;
        const block = blocks.get(key);
        if (!block) continue;
        const store: (SyntaxLine | undefined)[] = [];
        syntaxCache.set(id, store);
        const cancel = highlightLines(
          lang,
          block.lines,
          (start, chunk) => {
            for (let index = 0; index < chunk.length; index += 1) {
              const at = start + index - block.lead;
              if (at >= 0) store[at] = chunk[index];
            }
            syntaxVersion += 1;
          },
          () => syntaxRequests.delete(id),
        );
        syntaxRequests.set(id, cancel);
      }
    });
  });

  onDestroy(dropSyntax);

  function tokensOf(key: string | undefined, index: number | undefined): SyntaxLine | undefined {
    void syntaxVersion;
    if (!language || !key || index === undefined) return undefined;
    return syntaxCache.get(`${language}\u0000${key}`)?.[index];
  }

  function onScroll(event: Event) {
    const target = event.currentTarget as HTMLDivElement;
    scrollTop = target.scrollTop;
    scrollLeft = target.scrollLeft;
  }

  async function scrollToHunk(index: number, onlyIfHidden = false) {
    await tick();
    const row = headIndex.get(index);
    if (row === undefined || !scroller) return;
    const top = offsets[row];
    if (onlyIfHidden && top >= scrollTop && top + HEAD + ROW * 3 <= scrollTop + windowHeight) return;
    const next = Math.max(0, top - 12);
    scroller.scrollTop = next;
    scrollTop = next;
  }

  /* ---------- 动作 ---------- */

  function hunkAt(index: number): ConflictHunk | undefined {
    return parsed.hunks[index];
  }

  function nextUnresolved(from: number, direction: 1 | -1, state = resolutions): number | null {
    for (let step = 1; step <= total; step += 1) {
      const index = (((from + direction * step) % total) + total) % total;
      if (!state[index]) return index;
    }
    return null;
  }

  function choose(index: number, choice: ConflictChoice) {
    if (disabled) return;
    const hunk = hunkAt(index);
    if (!hunk) return;
    if (choice === "base" && !hunk.base) return;
    const next = { ...resolutions, [index]: { choice } };
    resolutions = next;
    armed = false;
    if (editing === index) editing = null;
    advanceFrom(index, next);
  }

  function advanceFrom(index: number, state: ConflictResolutions) {
    const target = state[index] ? nextUnresolved(index, 1, state) : index;
    current = target ?? index;
    if (target !== null && target !== index) void scrollToHunk(target, true);
  }

  function undo(index: number) {
    if (disabled) return;
    const next = { ...resolutions };
    delete next[index];
    resolutions = next;
    if (editing === index) editing = null;
    current = index;
  }

  function startEdit(index: number) {
    if (disabled) return;
    const hunk = hunkAt(index);
    if (!hunk) return;
    const existing = resolutions[index];
    const lines = existing ? resolvedLines(hunk, existing) : [...hunk.ours, ...hunk.theirs].map(stripEol);
    editText = lines.join("\n");
    editing = index;
    current = index;
    void tick().then(() => {
      const area = scroller?.querySelector<HTMLTextAreaElement>(".cr-edit textarea");
      if (!area) return;
      area.focus();
      area.setSelectionRange(0, 0);
      area.scrollLeft = 0;
      area.scrollTop = 0;
    });
  }

  function commitEdit() {
    if (editing === null) return;
    const index = editing;
    const lines = editText.length === 0 ? [] : editText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const next: ConflictResolutions = { ...resolutions, [index]: { choice: "custom", lines } };
    resolutions = next;
    editing = null;
    armed = false;
    advanceFrom(index, next);
    void tick().then(() => scroller?.focus());
  }

  function cancelEdit() {
    editing = null;
    void tick().then(() => scroller?.focus());
  }

  function applySimple() {
    if (disabled) return;
    const next = { ...resolutions };
    for (const hunk of simple) {
      const resolution = simpleResolution(hunk);
      if (resolution) next[hunk.index] = resolution;
    }
    resolutions = next;
    const target = nextUnresolved(-1, 1, next);
    if (target !== null) {
      current = target;
      void scrollToHunk(target, true);
    }
  }

  function applyRest(choice: "ours" | "theirs") {
    moreOpen = false;
    if (disabled) return;
    const next = { ...resolutions };
    for (const hunk of parsed.hunks) if (!next[hunk.index]) next[hunk.index] = { choice };
    resolutions = next;
  }

  function resetAll() {
    moreOpen = false;
    base = original;
    resolutions = {};
    whole = null;
    editing = null;
    armed = false;
    reveal = {};
    current = 0;
    if (mode === "whole") mode = "hunks";
  }

  function go(direction: 1 | -1) {
    if (total === 0) return;
    const target = nextUnresolved(current, direction) ?? (((current + direction) % total) + total) % total;
    current = target;
    void scrollToHunk(target);
  }

  function goTo(index: number) {
    current = index;
    if (effectiveMode !== "hunks") mode = "hunks";
    void scrollToHunk(index);
  }

  function expand(seg: number, side: "head" | "tail" | "all") {
    const extra = reveal[seg] ?? { head: 0, tail: 0 };
    reveal = {
      ...reveal,
      [seg]:
        side === "all"
          ? { head: 1e9, tail: 1e9 }
          : side === "head"
            ? { ...extra, head: extra.head + REVEAL }
            : { ...extra, tail: extra.tail + REVEAL },
    };
  }

  /** 切换视图：进入整文件编辑时以当前组合结果为起点；离开时把编辑结果作为新的基准重新解析。 */
  function setMode(next: ResolverMode) {
    if (next === effectiveMode) return;
    moreOpen = false;
    armed = false;
    editing = null;
    if (next === "whole" && whole === null) whole = composeConflictText(parsed, resolutions);
    if (effectiveMode === "whole" && next !== "whole" && whole !== null) {
      base = whole;
      resolutions = {};
      whole = null;
      current = 0;
    }
    mode = next;
  }

  function onWholeChoice(choice: "ours" | "theirs" | "both") {
    const ours = view.ours.text ?? "";
    const theirs = view.theirs.text ?? "";
    if (choice === "ours") whole = ours;
    else if (choice === "theirs") whole = theirs;
    else {
      const combined = [ours.trimEnd(), theirs.trimEnd()].filter((part) => part.length > 0).join("\n");
      whole = combined.length > 0 ? `${combined}\n` : "";
    }
    armed = false;
  }

  function markResolved() {
    if (disabled) return;
    if (effectiveMode === "whole" || !hunkMode) {
      const text = wholeText;
      if (hasConflictMarkers(text) && !armed) {
        armed = true;
        return;
      }
      armed = false;
      onResolve("text", text);
      return;
    }
    if (remaining > 0 || editing !== null) return;
    onResolve("text", composeConflictText(parsed, resolutions));
  }

  function onStreamKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("textarea, input")) {
      if (event.key === "Escape" && editing !== null) {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && editing !== null) {
        event.preventDefault();
        commitEdit();
      }
      return;
    }
    if ((event.altKey && event.key === "ArrowDown") || (event.key === "F7" && !event.shiftKey) || event.key === "n") {
      event.preventDefault();
      go(1);
      return;
    }
    if ((event.altKey && event.key === "ArrowUp") || (event.key === "F7" && event.shiftKey) || event.key === "p") {
      event.preventDefault();
      go(-1);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const keyed: Record<string, ConflictChoice> = { "1": "ours", "2": "theirs", "3": "ours-theirs", "4": "theirs-ours", "5": "base" };
    if (keyed[event.key]) {
      event.preventDefault();
      choose(current, keyed[event.key]);
    } else if (event.key === "e" || event.key === "Enter") {
      event.preventDefault();
      startEdit(current);
    } else if (event.key === "u" || event.key === "Backspace") {
      event.preventDefault();
      undo(current);
    }
  }

  /** 浮层的统一收起方式：点外面，或 Esc（只收起浮层，不关闭合并窗口）。 */
  function dismissOutside(anchor: () => HTMLElement | null, close: (byKey: boolean) => void) {
    const pointer = (event: MouseEvent) => {
      const root = anchor();
      if (root && !root.contains(event.target as Node)) close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    window.addEventListener("mousedown", pointer);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", pointer);
      window.removeEventListener("keydown", key, true);
    };
  }

  $effect(() => {
    if (!moreOpen) return;
    return dismissOutside(() => moreAnchor, () => (moreOpen = false));
  });

  $effect(() => {
    if (!keysOpen) return;
    return dismissOutside(() => keysAnchor, (byKey) => {
      keysOpen = false;
      // 帮助是看完就接着按键的：Esc 收起后焦点回到冲突流，键位立即可用。
      if (byKey) scroller?.focus({ preventScroll: true });
    });
  });

  /* ---------- 呈现辅助 ---------- */

  function pairSegments(row: Extract<Row, { kind: "pair" }>, side: "ours" | "theirs") {
    const text = (side === "ours" ? row.ours : row.theirs) ?? "";
    const tokens = side === "ours" ? tokensOf(`o:${row.hunk}`, row.oi) : tokensOf(`t:${row.hunk}`, row.ti);
    if (row.same || row.ours === null || row.theirs === null) return lineSegments(text, tokens);
    const range = inlineRange(row.ours, row.theirs);
    return lineSegments(text, tokens, range ? range[side === "ours" ? "a" : "b"] : null);
  }

  function statusOf(index: number): ConflictResolution | undefined {
    return resolutions[index];
  }

  function markerTop(index: number): string {
    const row = headIndex.get(index);
    if (row === undefined || totalHeight === 0) return "0%";
    return `${(offsets[row] / totalHeight) * 100}%`;
  }

  function isLastRowOfCard(row: Row): boolean {
    return (row.kind === "pair" || row.kind === "res") && row.last;
  }

  function rowHunk(row: Row): number | null {
    return "hunk" in row ? row.hunk : null;
  }

  let markLabel = $derived(
    effectiveMode === "whole" || !hunkMode
      ? armed
        ? "确认：仍然标记为已解决"
        : "标记为已解决"
      : remaining > 0
        ? `还有 ${remaining} 处未处理`
        : editing !== null
          ? "先完成正在编辑的一处"
          : "标记为已解决",
  );
  let markBlocked = $derived(
    disabled || (hunkMode && effectiveMode !== "whole" && (remaining > 0 || editing !== null)),
  );
  let footText = $derived(
    hunkMode && effectiveMode !== "whole" && remaining > 0 ? `已处理 ${done} / ${total} 处` : null,
  );
  let footNote = $derived(
    effectiveMode === "whole" || !hunkMode
      ? wholeMarkers
        ? "结果里仍有冲突标记（<<<<<<< / >>>>>>>），标记前请再检查一遍。"
        : !hunkMode && parsed.malformed
          ? "冲突标记不完整，无法逐处处理；请直接编辑最终结果。"
          : !hunkMode
            ? "文件里没有冲突标记，可以直接编辑最终结果后标记。"
            : "整文件编辑：离开此视图时，编辑结果会成为逐处处理的新起点。"
      : remaining > 0
        ? `已处理 ${done} / ${total} 处。每一处都要明确选择后才能标记。`
        : "全部冲突已处理。标记前可在「结果预览」里通读一遍。",
  );
</script>

<div class="cr" data-conflict-resolver>
  <div class="cr-toolbar">
    {@render lead?.()}
    <div class="segmented" role="group" aria-label="冲突查看方式">
      {#if hunkMode}
        <button type="button" aria-label="逐处处理" title="逐处处理" aria-pressed={effectiveMode === "hunks"} onclick={() => setMode("hunks")}>
          <Icon name="layers" size={13} /><span class="cr-seg-label">逐处处理</span>
        </button>
        <button type="button" aria-label="结果预览" title="结果预览" aria-pressed={effectiveMode === "preview"} onclick={() => setMode("preview")}>
          <Icon name="eye" size={13} /><span class="cr-seg-label">结果预览</span>
        </button>
      {/if}
      <button type="button" aria-label="整文件编辑" title="整文件编辑" aria-pressed={effectiveMode === "whole"} onclick={() => setMode("whole")}>
        <Icon name="split" size={13} /><span class="cr-seg-label">整文件编辑</span>
      </button>
      <button
        type="button"
        aria-label="两侧差异"
        aria-pressed={effectiveMode === "diff"}
        disabled={view.ours.text === null || view.theirs.text === null}
        title="当前与来源两个完整版本的差异"
        onclick={() => setMode("diff")}
      >
        <Icon name="file-diff" size={13} /><span class="cr-seg-label">两侧差异</span>
      </button>
    </div>

    <span class="spacer"></span>

    <LanguagePicker path={view.path} />
    {#if hunkMode && effectiveMode === "hunks" && simple.length > 0}
      <button
        type="button"
        class="btn btn-accent-soft btn-sm cr-simple"
        disabled={disabled}
        aria-label={`处理 ${simple.length} 处简单冲突`}
        title="两侧相同，或有共同祖先且只有一侧改动的冲突，结论是确定的"
        onclick={applySimple}
      >
        <Icon name="check-circle" size={13} /><span class="cr-simple-wide">处理 {simple.length} 处简单冲突</span><span class="cr-simple-narrow" aria-hidden="true">{simple.length} 处简单</span>
      </button>
    {/if}
    {#if hunkMode && effectiveMode === "hunks"}
      <label class="cr-toggle" title={hasBase ? "在每处冲突上方显示共同祖先版本" : "冲突标记里没有共同祖先。可设置 git config merge.conflictStyle zdiff3 后重新合并"}>
        <input type="checkbox" class="checkbox" bind:checked={showBase} title={hasBase ? undefined : "冲突标记里没有共同祖先"} disabled={!hasBase} />
        <span><span class="cr-toggle-wide">共同</span>祖先</span>
      </label>
      <div class="menu-anchor" bind:this={keysAnchor}>
        <button
          type="button"
          class="icon-btn sm"
          aria-label="快捷键"
          aria-haspopup="dialog"
          aria-expanded={keysOpen}
          title="快捷键"
          onclick={() => (keysOpen = !keysOpen)}
        >
          <Icon name="keyboard" size={15} />
        </button>
        {#if keysOpen}
          <div class="menu cr-help" role="dialog" aria-label="冲突处理快捷键">
            <dl class="cr-keys">
              <div><dt><kbd>Alt</kbd><kbd>↑</kbd><i>或</i><kbd>Shift</kbd><kbd>F7</kbd></dt><dd>上一处未处理</dd></div>
              <div><dt><kbd>Alt</kbd><kbd>↓</kbd><i>或</i><kbd>F7</kbd></dt><dd>下一处未处理</dd></div>
              <div><dt><kbd>1</kbd></dt><dd>采用当前</dd></div>
              <div><dt><kbd>2</kbd></dt><dd>采用来源</dd></div>
              <div><dt><kbd>3</kbd></dt><dd>当前 + 来源</dd></div>
              <div><dt><kbd>4</kbd></dt><dd>来源 + 当前</dd></div>
              <div><dt><kbd>5</kbd></dt><dd>采用共同祖先</dd></div>
              <div><dt><kbd>E</kbd></dt><dd>手动编辑</dd></div>
              <div><dt><kbd>U</kbd></dt><dd>撤销这一处</dd></div>
              <div><dt><kbd>Ctrl</kbd><kbd>Enter</kbd></dt><dd>完成编辑</dd></div>
              <div><dt><kbd>Esc</kbd></dt><dd>取消编辑</dd></div>
            </dl>
            <p class="hint">焦点在冲突代码区时生效。</p>
          </div>
        {/if}
      </div>
    {/if}
    <div class="menu-anchor" bind:this={moreAnchor}>
      <button
        type="button"
        class="icon-btn sm"
        aria-label="更多冲突操作"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        title="批量处理、整文件版本与重置"
        onclick={() => (moreOpen = !moreOpen)}
      >
        <Icon name="more" size={15} />
      </button>
      {#if moreOpen}
        <div class="menu cr-menu" role="menu" aria-label="更多冲突操作">
          {#if hunkMode && effectiveMode !== "whole"}
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : remaining === 0 ? "所有冲突都已选择" : undefined} disabled={disabled || remaining === 0} onclick={() => applyRest("ours")}>
              <Icon name="arrow-left" />
              <span>其余 {remaining} 处都采用当前<small>只填入草稿，仍可逐处修改</small></span>
            </button>
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : remaining === 0 ? "所有冲突都已选择" : undefined} disabled={disabled || remaining === 0} onclick={() => applyRest("theirs")}>
              <Icon name="arrow-right" />
              <span>其余 {remaining} 处都采用来源<small>只填入草稿，仍可逐处修改</small></span>
            </button>
            <div class="menu-sep"></div>
          {/if}
          {#if view.ours.present}
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => { moreOpen = false; onResolve("ours"); }}>
              <Icon name="file" />
              <span>整个文件使用当前版本<small>立即写入并标记；来源分支对此文件的改动全部不保留</small></span>
            </button>
          {/if}
          {#if view.theirs.present}
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => { moreOpen = false; onResolve("theirs"); }}>
              <Icon name="file" />
              <span>整个文件使用来源版本<small>立即写入并标记；当前分支对此文件的改动全部不保留</small></span>
            </button>
          {/if}
          <div class="menu-sep"></div>
          <button type="button" class="menu-item" role="menuitem" onclick={resetAll}>
            <Icon name="undo" />
            <span>重置此文件<small>丢弃这里所有未写入的选择与编辑</small></span>
          </button>
        </div>
      {/if}
    </div>
  </div>

  {#if effectiveMode === "hunks" || effectiveMode === "preview"}
    <div class="cr-main">
      <!-- 冲突流是可聚焦的滚动区域：键盘在这里选择当前一处的处理方式（1–5、E、U、Alt+↑↓）。 -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="cr-scroll"
        class:preview={effectiveMode === "preview"}
        role="region"
        aria-label={effectiveMode === "preview" ? "合并结果预览" : "逐处处理冲突"}
        tabindex="0"
        data-autofocus
        bind:this={scroller}
        bind:clientHeight={viewport}
        bind:clientWidth={viewWidth}
        onscroll={onScroll}
        onkeydown={onStreamKey}
        style={`--cr-ch:${codeCh};--cr-x:${-scrollLeft}px`}
      >
        <div class="cr-space" style={`height:${totalHeight}px`}>
          {#each visible as { row, index } (index)}
            {@const top = offsets[index]}
            {@const height = rowHeight(row)}
            {@const hunk = rowHunk(row)}
            {@const pinned = viewWidth > 0 ? `left:${scrollLeft}px;width:${viewWidth}px;` : ""}
            {#if row.kind === "fold"}
              <div class="cr-row cr-fold" style={`top:${top}px;height:${height}px;${pinned}`}>
                {#if row.up}
                  <button type="button" class="icon-btn sm" aria-label="向下展开 20 行" title="展开上方相邻的 20 行" onclick={() => expand(row.seg, "head")}>
                    <Icon name="arrow-down" size={12} />
                  </button>
                {/if}
                <button type="button" class="cr-fold-label" onclick={() => expand(row.seg, "all")}>
                  <Icon name="rows" size={12} />{row.hidden.toLocaleString()} 行未冲突内容 · 第 {row.from.toLocaleString()}–{(row.from + row.hidden - 1).toLocaleString()} 行 · 展开
                </button>
                {#if row.down}
                  <button type="button" class="icon-btn sm" aria-label="向上展开 20 行" title="展开下方相邻的 20 行" onclick={() => expand(row.seg, "tail")}>
                    <Icon name="arrow-up" size={12} />
                  </button>
                {/if}
              </div>
            {:else if row.kind === "ctx"}
              <div class={`cr-row cr-line ${row.tone ?? ""}`} style={`top:${top}px;height:${height}px;${pinned}`}>
                <span class="ln">{row.no}</span><span class="code"><span class="code-in">{#each lineSegments(row.text, tokensOf(row.bk, row.bi)) as seg, i (i)}<span class={seg.k}>{seg.t}</span>{/each}</span></span>
              </div>
            {:else if row.kind === "head"}
              {@const h = parsed.hunks[row.hunk]}
              {@const state = statusOf(row.hunk)}
              {@const hint = hints[row.hunk]}
              <div
                class="cr-row cr-head cr-card"
                class:current={current === row.hunk}
                class:resolved={Boolean(state)}
                style={`top:${top}px;height:${height}px;${pinned}`}
                data-hunk={row.hunk}
              >
                <button type="button" class="cr-head-title" onclick={() => (current = row.hunk)} aria-label={`冲突 ${row.hunk + 1}`}>
                  <span class="cr-dot" class:ok={Boolean(state)}></span>
                  <strong>冲突 {row.hunk + 1}</strong><span class="cr-of">/ {total}</span>
                </button>
                {#if state}
                  <span class="chip current" data-hunk-state="resolved">{choiceLabel(state.choice)}</span>
                {:else if editing === row.hunk}
                  <span class="chip">正在编辑</span>
                {:else}
                  <span class="chip warn" data-hunk-state="pending">未处理</span>
                {/if}
                {#if hint && !state}<span class="chip">{hintLabel(hint)}</span>{/if}
                <span class="spacer"></span>
                {#if editing === row.hunk}
                  <span class="hint">Ctrl+Enter 完成 · Esc 取消</span>
                {:else if state}
                  <button type="button" class="btn btn-ghost btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => startEdit(row.hunk)}><Icon name="pencil" size={13} />编辑</button>
                  <button type="button" class="btn btn-ghost btn-sm" disabled={disabled} title="撤销这一处的选择（U）" onclick={() => undo(row.hunk)}><Icon name="undo" size={13} />撤销</button>
                {:else}
                  <div class="cr-actions" role="group" aria-label={`冲突 ${row.hunk + 1} 的处理方式`}>
                    <button type="button" class="cr-act ours" disabled={disabled} title="只保留当前分支这一侧（1）" onclick={() => choose(row.hunk, "ours")}>采用当前</button>
                    <button type="button" class="cr-act theirs" disabled={disabled} title="只保留来源分支这一侧（2）" onclick={() => choose(row.hunk, "theirs")}>采用来源</button>
                    <button type="button" class="cr-act quiet" disabled={disabled} title="两侧都保留，当前在前（3）；请检查重复代码" onclick={() => choose(row.hunk, "ours-theirs")}>当前 + 来源</button>
                    <button type="button" class="cr-act quiet" disabled={disabled} title="两侧都保留，来源在前（4）" onclick={() => choose(row.hunk, "theirs-ours")}>来源 + 当前</button>
                    {#if h?.base}
                      <button type="button" class="cr-act quiet" disabled={disabled} title="恢复为共同祖先（5）" onclick={() => choose(row.hunk, "base")}>祖先</button>
                    {/if}
                    <button type="button" class="cr-act quiet" disabled={disabled} title="在两侧内容基础上手动编辑（E）" onclick={() => startEdit(row.hunk)}><Icon name="pencil" size={12} />编辑</button>
                  </div>
                {/if}
              </div>
            {:else if row.kind === "cols"}
              <div class="cr-row cr-cols cr-card" class:current={current === hunk} style={`top:${top}px;height:${height}px;${pinned}`}>
                <span class="cr-col ours"><span class="cr-swatch"></span>当前 · {currentLabel}{#if parsed.hunks[row.hunk]?.oursLabel && parsed.hunks[row.hunk].oursLabel !== currentLabel}<small>{parsed.hunks[row.hunk].oursLabel}</small>{/if}</span>
                <span class="cr-col theirs"><span class="cr-swatch"></span>来源 · {incomingLabel}{#if parsed.hunks[row.hunk]?.theirsLabel && parsed.hunks[row.hunk].theirsLabel !== incomingLabel}<small>{parsed.hunks[row.hunk].theirsLabel}</small>{/if}</span>
              </div>
            {:else if row.kind === "pair"}
              {@const o = pairSegments(row, "ours")}
              {@const t = pairSegments(row, "theirs")}
              <div
                class="cr-row cr-pair cr-card"
                class:current={current === hunk}
                class:last={row.last}
                class:same={row.same}
                style={`top:${top}px;height:${height}px;${pinned}`}
              >
                <span class="cr-half ours" class:blank={row.ours === null}>
                  <span class="ln">{row.oNo ?? ""}</span><span class="code"><span class="code-in">{#each o as seg, i (i)}<span class={seg.k} class:mk={seg.m}>{seg.t}</span>{/each}</span></span>
                </span>
                <span class="cr-half theirs" class:blank={row.theirs === null}>
                  <span class="ln">{row.tNo ?? ""}</span><span class="code"><span class="code-in">{#each t as seg, i (i)}<span class={seg.k} class:mk={seg.m}>{seg.t}</span>{/each}</span></span>
                </span>
              </div>
            {:else if row.kind === "basehead"}
              <div class="cr-row cr-cols base cr-card" class:current={current === hunk} style={`top:${top}px;height:${height}px;${pinned}`}>
                <span class="cr-col"><span class="cr-swatch"></span>共同祖先{#if parsed.hunks[row.hunk]?.baseLabel}<small>{parsed.hunks[row.hunk].baseLabel}</small>{/if}</span>
              </div>
            {:else if row.kind === "base"}
              <div class="cr-row cr-line base cr-card" class:current={current === hunk} style={`top:${top}px;height:${height}px;${pinned}`}>
                <span class="ln">{row.no}</span><span class="code"><span class="code-in">{#each lineSegments(row.text, tokensOf(row.bk, row.bi)) as seg, i (i)}<span class={seg.k}>{seg.t}</span>{/each}</span></span>
              </div>
            {:else if row.kind === "res"}
              <div class="cr-row cr-line res cr-card" class:current={current === hunk} class:last={isLastRowOfCard(row)} style={`top:${top}px;height:${height}px;${pinned}`}>
                <span class="ln">{row.no}</span><span class="code"><span class="code-in">{#each lineSegments(row.text, tokensOf(row.bk, row.bi)) as seg, i (i)}<span class={seg.k}>{seg.t}</span>{/each}</span></span>
              </div>
            {:else if row.kind === "empty"}
              <div class="cr-row cr-line res is-empty cr-card last" class:current={current === hunk} style={`top:${top}px;height:${height}px;${pinned}`}>
                <span class="ln"></span><span class="code">此处结果为空（两侧内容都不保留）</span>
              </div>
            {:else if row.kind === "edit"}
              <div class="cr-row cr-edit cr-card last" class:current={current === hunk} style={`top:${top}px;height:${height}px;${pinned}`}>
                <textarea
                  aria-label={`编辑冲突 ${row.hunk + 1} 的结果`}
                  spellcheck="false"
                  bind:value={editText}
                  title={disabled ? BUSY_REASON : undefined}
                  disabled={disabled}
                ></textarea>
                <div class="cr-edit-foot">
                  <button type="button" class="btn btn-ghost btn-sm" onclick={() => (editText = [...(parsed.hunks[row.hunk]?.ours ?? [])].map(stripEol).join("\n"))}>填入当前</button>
                  <button type="button" class="btn btn-ghost btn-sm" onclick={() => (editText = [...(parsed.hunks[row.hunk]?.theirs ?? [])].map(stripEol).join("\n"))}>填入来源</button>
                  <span class="spacer"></span>
                  <button type="button" class="btn btn-secondary btn-sm" onclick={cancelEdit}>取消</button>
                  <button type="button" class="btn btn-primary btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={commitEdit}><Icon name="check" size={13} />完成编辑</button>
                </div>
              </div>
            {/if}
          {/each}
        </div>
      </div>
      {#if effectiveMode === "hunks" && total > 0}
        <div class="cr-ruler" aria-label="冲突位置总览">
          {#each parsed.hunks as hunk (hunk.index)}
            <button
              type="button"
              class="cr-ruler-mark"
              class:ok={Boolean(resolutions[hunk.index])}
              class:current={current === hunk.index}
              style={`top:${markerTop(hunk.index)}`}
              aria-label={`跳到冲突 ${hunk.index + 1}${resolutions[hunk.index] ? "（已处理）" : "（未处理）"}`}
              title={`冲突 ${hunk.index + 1}${resolutions[hunk.index] ? " · 已处理" : " · 未处理"}`}
              onclick={() => goTo(hunk.index)}
            ></button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if effectiveMode === "whole"}
    <div class="cr-whole">
      <ThreeWayMerge
        {view}
        resultText={wholeText}
        {disabled}
        {currentLabel}
        {incomingLabel}
        hideResolve
        onResult={(value) => {
          whole = value;
          armed = false;
        }}
        onChoice={onWholeChoice}
        onResolve={(choice) => (choice === "text" ? markResolved() : onResolve(choice))}
        onReset={() => {
          whole = hunkMode ? composeConflictText(parsed, resolutions) : original;
          armed = false;
        }}
      />
    </div>
  {:else if comparison}
    <div class="cr-diff">
      <DiffView
        selection={{ path: view.path, side: "unstaged" }}
        diff={comparison}
        error={null}
        loading={false}
        disabled={true}
        readOnly={true}
        onStageHunk={() => {}}
        onLoadMore={() => {}}
      />
    </div>
  {/if}

  <div class="cr-foot" use:portal={footTarget}>
    {#if hunkMode && effectiveMode !== "whole" && done > 0}
      <div
        class="cr-progress"
        role="progressbar"
        aria-label="本文件冲突处理进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span style={`width:${total > 0 ? (done / total) * 100 : 0}%`}></span>
      </div>
    {/if}
    <span class="cr-foot-note truncate" class:warn={wholeMarkers || armed} title={footNote}>{footText ?? footNote}</span>
    {#if hunkMode && effectiveMode === "hunks"}
      <div class="cr-nav" role="group" aria-label="冲突导航">
        <button type="button" class="icon-btn sm" aria-label="上一处冲突" title="上一处未处理（Alt+↑ / Shift+F7）" onclick={() => go(-1)}>
          <Icon name="arrow-up" size={14} />
        </button>
        <span class="cr-nav-label" aria-live="polite">第 <strong>{Math.min(current + 1, total)}</strong> / {total} 处</span>
        <button type="button" class="icon-btn sm" aria-label="下一处冲突" title="下一处未处理（Alt+↓ / F7）" onclick={() => go(1)}>
          <Icon name="arrow-down" size={14} />
        </button>
      </div>
      {#if remaining > 0}
        <button type="button" class="btn btn-secondary btn-sm cr-next" onclick={() => go(1)}>
          <Icon name="arrow-down" size={13} />下一处未处理
        </button>
      {/if}
    {/if}
    <button
      type="button"
      class={`btn btn-sm ${armed ? "btn-danger" : "btn-primary"}`}
      aria-label="标记编辑结果"
      title={markBlocked ? markLabel : "把结果写回工作区并标记这个文件为已解决"}
      disabled={markBlocked}
      onclick={markResolved}
    >
      <Icon name="check" size={13} />{markLabel}
    </button>
  </div>
</div>
