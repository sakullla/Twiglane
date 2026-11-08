<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "../api";
  import { MODIFIER_LABEL } from "../brand";
  import { fileTone, matchSnippet } from "../file-kind";
  import { trackCodeScroll } from "../codeScroll.svelte";
  import { normalizeError } from "../errors";
  import { codeContentSize, codeRuler, rulerPadding, visibleRange } from "../layout";
  import { languageName } from "../syntax/languages";
  import { createHighlight } from "../syntax/highlight.svelte";
  import { effectiveLanguage } from "../syntax/prefs.svelte";
  import { lineSegments } from "../syntax/segments";
  import type {
    OpenedRepository,
    RepositoryContentSearch,
    RepositoryFileContent,
    RepositorySearchScope,
  } from "../types";
  import { BUSY_REASON, formatBytes, rowMark, splitPath, type FileNavState } from "../ui";
  import type { DiffSide } from "../types";
  import BinaryPreview from "./BinaryPreview.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import FileNav from "./FileNav.svelte";
  import Icon from "./Icon.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";

  /**
   * 只读文件内容：文本分页按需读取，代码页复用现有的语言推断、语言选择器与分词；
   * 资源文件交给 file_preview（worktree 版本）。这里没有保存、编辑或执行入口。
   */
  interface Props {
    /** 视图可见：隐藏时不发起新读取，重新激活时按当前代次重验。 */
    active: boolean;
    opened: OpenedRepository;
    path: string | null;
    /** 选中但已从工作区删除的文件：不读当前内容，只提供改动与历史。 */
    missingPath?: string | null;
    /** 统一文件定位的目标行与序号：序号变化时读取目标附近页并滚动过去。 */
    line?: number | null;
    lineSerial?: number;
    generation: number;
    /** 目录重验、手动刷新等无代次变化的重读信号。 */
    reloadKey?: number;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFileHistory?: (path: string) => void;
    /** 进入这个文件的 staged / unstaged 改动（由外壳切换视图）。 */
    onOpenDiff?: (path: string, side: DiffSide) => void;
    /** 文件切换条：上一个/下一个、后退/前进与最近打开。 */
    nav?: FileNavState | null;
  }

  let {
    active,
    opened,
    path,
    missingPath = null,
    line = null,
    lineSerial = 0,
    generation,
    reloadKey = 0,
    disabled,
    nextId,
    onGeneration,
    onFileHistory,
    onOpenDiff,
    nav = null,
  }: Props = $props();

  /** 与 components.css 的 .file-line 行高一致：虚拟窗口按它算，行号与代码同高。 */
  const ROW_HEIGHT = 20;
  /** 距离已读末尾不足这么多行时自动续读：滚动到底之前就把下一页接上。 */
  const PREFETCH_ROWS = 40;
  /** 换行模式下不做虚拟化：超过这个行数只提示，不把整份文件排进 DOM。 */
  const WRAP_LIMIT = 2000;

  let content = $state<RepositoryFileContent | null>(null);
  let lines = $state<string[]>([]);
  let pageOffset = $state(0);
  let hasMore = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let wrap = $state(false);
  let view = $state<"source" | "image">("source");
  let hitLine = $state<number | null>(null);
  let copied = $state(false);

  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchResult = $state<RepositoryContentSearch | null>(null);
  let searchError = $state<string | null>(null);
  /** 这份匹配是按哪个代次与重读信号算出来的：任一漂移就必须撤下结果。 */
  let resultGeneration = $state(-1);
  let resultKey = $state(-1);
  let searching = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  let gotoOpen = $state(false);
  let gotoValue = $state("");
  let gotoInput = $state<HTMLInputElement | null>(null);
  /** 当前停在第几处匹配：上一处/下一处按它循环，结果换了就回到 -1。 */
  let matchCursor = $state(-1);
  let menu = $state<ContextMenuRequest | null>(null);
  let moreButton = $state<HTMLButtonElement | null>(null);
  let moreClosedAt = 0;

  let scrollTop = $state(0);
  let viewport = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let searchSerial = 0;

  let parts = $derived(path ? splitPath(path) : null);
  let language = $derived(path ? effectiveLanguage(path) : null);
  let languageLabel = $derived(languageName(language));
  let change = $derived(path ? opened.snapshot.files.find((file) => file.path === path) ?? null : null);
  /** 删除墓碑的改动来源：只用于给「查看改动」判断两侧是否存在。 */
  let deletedChange = $derived(
    missingPath ? opened.snapshot.files.find((file) => file.path === missingPath) ?? null : null,
  );
  let mark = $derived.by(() => {
    if (!change) return null;
    const side = change.unstaged !== "none" || change.untracked ? "unstaged" : "staged";
    return rowMark({ ...change, side });
  });
  /** 这个文件有哪几侧改动：工具条主按钮去未暂存一侧（工作区此刻的样子），另一侧在「更多」里。 */
  let hasUnstaged = $derived(Boolean(change && (change.unstaged !== "none" || change.untracked)));
  let hasStaged = $derived(Boolean(change && change.staged !== "none"));
  let primarySide = $derived<DiffSide | null>(hasUnstaged ? "unstaged" : hasStaged ? "staged" : null);
  let matchCount = $derived(searchResult?.matches.length ?? 0);
  let isSvg = $derived(Boolean(path && path.toLowerCase().endsWith(".svg")));
  let showImage = $derived(view === "image" || content?.kind === "resource");
  let previewSources = $derived(
    path ? { repository: opened.summary.path, old: null, new: { revision: "worktree", path } } : null,
  );

  const syntax = createHighlight(() => ({ lang: language, lines }));
  const codeTexts = $derived(lines);
  const ruler = $derived(codeRuler(codeTexts));
  const codeSize = $derived(codeContentSize(codeTexts));
  let range = $derived(visibleRange(lines.length, scrollTop, viewport, ROW_HEIGHT));
  let canWrap = $derived(lines.length <= WRAP_LIMIT);

  trackCodeScroll(
    () => (wrap ? null : scroller),
    () => ruler,
    () => range,
    () => codeSize,
  );

  function segmentsAt(index: number) {
    const text = lines[index] ?? "";
    return lineSegments(text, syntax.at(index), null, false);
  }

  function resetContent(): void {
    matchCursor = -1;
    content = null;
    lines = [];
    pageOffset = 0;
    hasMore = false;
    error = null;
    hitLine = null;
    searchResult = null;
    searchError = null;
    searchQuery = "";
    searchOpen = false;
    wrap = false;
    view = "source";
    scrollTop = 0;
    if (scroller) scroller.scrollTop = 0;
  }

  let serial = 0;

  async function read(target: string, offset: number, append: boolean, generationAtStart: number, attempt = 0): Promise<void> {
    const repoPath = opened.summary.path;
    const token = ++serial;
    if (append) loadingMore = true;
    else {
      loading = true;
      // 代次或路径变化后立刻撤下旧内容：旧内容不能继续被当作当前文件。
      content = null;
      lines = [];
      error = null;
    }
    try {
      const page = await api.repositoryFileContent(repoPath, target, offset, undefined, generationAtStart, nextId());
      if (token !== serial || path !== target || opened.summary.path !== repoPath) return;
      if (page.generation > generationAtStart) onGeneration(page.generation);
      if (page.generation < opened.generation && attempt === 0) {
        void read(target, offset, append, page.generation, attempt + 1);
        return;
      }
      content = page;
      if (page.kind === "text") {
        lines = append ? [...lines, ...page.lines] : page.lines;
        pageOffset = append ? pageOffset : offset;
        hasMore = page.hasMore;
        if (!append) {
          scrollTop = 0;
          if (scroller) scroller.scrollTop = 0;
        }
      } else {
        lines = [];
        hasMore = false;
        pageOffset = 0;
      }
    } catch (failure) {
      if (token !== serial || path !== target || opened.summary.path !== repoPath) return;
      const normalized = normalizeError(failure);
      if (normalized.code === "stale" && normalized.generation !== undefined && attempt === 0) {
        onGeneration(normalized.generation);
        void read(target, offset, append, normalized.generation, attempt + 1);
        return;
      }
      if (!append) {
        content = null;
        lines = [];
      }
      error = normalized.message || "无法读取这个文件。";
    } finally {
      if (token === serial) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  /**
   * 只在路径、代次或重读信号变化时读取；隐藏期间不发起新请求。
   * 同一代次的隐藏再显示不算变化：已读内容与滚动位置都属于这次会话，重读会把它们冲掉。
   */
  let lastRead = "";
  $effect(() => {
    const target = path;
    const generationNow = generation;
    const key = reloadKey;
    const visible = active;
    untrack(() => {
      if (!target) {
        lastRead = "";
        resetContent();
        return;
      }
      if (!visible) return;
      const signature = `${target}:${generationNow}:${key}`;
      if (signature === lastRead && content?.path === target) return;
      lastRead = signature;
      void read(target, 0, false, generationNow);
    });
  });

  /* 路径变化时清空上一份内容与搜索，避免把上一个文件的结果当成当前文件的。 */
  let lastPath: string | null = null;
  $effect(() => {
    const target = path;
    if (target === lastPath) return;
    lastPath = target;
    untrack(() => {
      // 换文件即取消旧搜索：迟到的匹配属于上一个文件，不能显示、也不能跳行。
      searchSerial += 1;
      searching = false;
      resetContent();
    });
  });

  /*
   * 代次或重读信号前进：文件内容可能已经换过，旧命中的行号不再可信。
   * 这里必须把结果显示一起撤下——只收起行号、留着旧匹配列表，
   * 会让使用者按旧行号跳到新内容的错误位置。
   */
  $effect(() => {
    const gen = generation;
    const key = reloadKey;
    if (searchResult === null) return;
    if (resultGeneration >= gen && resultKey === key) return;
    untrack(() => {
      searchSerial += 1;
      searching = false;
      searchResult = null;
      searchError = null;
      hitLine = null;
    });
  });

  /** 统一文件定位的目标行：序号变化即按偏移读取并滚过去，不改动其它状态。 */
  let lastLineSerial = 0;
  $effect(() => {
    const serial = lineSerial;
    const target = line;
    if (serial === lastLineSerial) return;
    lastLineSerial = serial;
    untrack(() => {
      if (target === null || target <= 0 || !path) return;
      void jumpTo(target);
    });
  });

  async function loadMore(): Promise<void> {
    if (!path || !hasMore || loading || loadingMore) return;
    await read(path, pageOffset + lines.length, true, generation);
  }

  /** 滚到接近已读末尾时自动续读下一页；续读失败仍留着底部按钮可以手动重试。 */
  function onCodeScroll(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    scrollTop = target.scrollTop;
    if (!hasMore || loading || loadingMore || error || viewport <= 0) return;
    if (scrollTop + viewport >= (lines.length - PREFETCH_ROWS) * ROW_HEIGHT) void loadMore();
  }

  /** 跳到指定行：目标不在已加载页时按偏移重新读取，而不是只滚动 DOM。 */
  async function jumpTo(line: number): Promise<void> {
    if (!path) return;
    const target = Math.max(1, Math.trunc(line));
    if (target - 1 >= pageOffset && target - 1 < pageOffset + lines.length) {
      hitLine = target;
      revealLine(target);
      return;
    }
    hitLine = target;
    await read(path, target - 1, false, generation);
    // 读取完成后滚动到命中行。
    queueMicrotask(() => revealLine(target));
  }

  function revealLine(line: number): void {
    if (wrap) {
      document.querySelector<HTMLElement>(`[data-file-line="${line}"]`)?.scrollIntoView({ block: "center" });
      return;
    }
    const index = line - 1 - pageOffset;
    if (index < 0) return;
    const next = Math.max(0, index * ROW_HEIGHT - (viewport || 400) / 2);
    scrollTop = next;
    if (scroller) scroller.scrollTop = next;
  }

  function submitGoto(): void {
    const value = Number.parseInt(gotoValue.trim(), 10);
    if (!Number.isFinite(value) || value < 1) return;
    gotoOpen = false;
    gotoValue = "";
    void jumpTo(value);
  }

  async function openGoto(): Promise<void> {
    gotoOpen = true;
    await tick();
    gotoInput?.focus();
    gotoInput?.select();
  }

  /** 在匹配之间循环：delta=1 下一处，-1 上一处；还没停在任何一处时从头或尾开始。 */
  function stepMatch(delta: 1 | -1): void {
    const matches = searchResult?.matches ?? [];
    if (matches.length === 0) return;
    const next = matchCursor < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : (matchCursor + delta + matches.length) % matches.length;
    pickMatch(next);
  }

  function pickMatch(index: number): void {
    const match = searchResult?.matches[index];
    if (!match) return;
    matchCursor = index;
    void jumpTo(match.line);
    // 匹配列表跟着滚到当前那一条，键盘走动时也看得见位置。
    void tick().then(() =>
      document.querySelector<HTMLElement>(`[data-match-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" }),
    );
  }

  /**
   * 文件内搜索：发起时记下路径、代次与 serial，结果只有在三者都仍是当前值时才写入。
   * 换文件就递增 searchSerial 取消旧搜索；否则旧文件的匹配会按错误行号跳到当前文件。
   */
  async function runSearch(): Promise<void> {
    const query = searchQuery.trim();
    if (!path || !query) {
      searchResult = null;
      searchError = null;
      return;
    }
    const token = ++searchSerial;
    const repoPath = opened.summary.path;
    const targetPath = path;
    const targetGeneration = generation;
    const scope: RepositorySearchScope = { kind: "file", path: targetPath };
    searching = true;
    searchError = null;
    try {
      const result = await api.repositoryContentSearch(repoPath, query, scope, false, 200, targetGeneration, nextId());
      if (token !== searchSerial) return;
      if (path !== targetPath || opened.summary.path !== repoPath) return;
      // 代次前进说明文件内容已经换过：旧行号不再可信，撤下结果等下一次搜索。
      if (targetGeneration !== generation || result.generation < targetGeneration) {
        searchResult = null;
        return;
      }
      if (result.generation > generation) onGeneration(result.generation);
      resultGeneration = result.generation;
      resultKey = reloadKey;
      searchResult = result;
      matchCursor = -1;
    } catch (failure) {
      if (token !== searchSerial) return;
      if (path !== targetPath || opened.summary.path !== repoPath) return;
      const normalized = normalizeError(failure);
      searchResult = null;
      searchError = normalized.message || "无法在这个文件里搜索。";
    } finally {
      if (token === searchSerial) searching = false;
    }
  }

  function openSearch(): void {
    searchOpen = true;
    gotoOpen = false;
    queueMicrotask(() => {
      searchInput?.focus();
      searchInput?.select();
    });
  }

  function closeSearch(): void {
    searchOpen = false;
    searchQuery = "";
    searchResult = null;
    searchError = null;
    matchCursor = -1;
    hitLine = null;
    // 只有焦点本来就在搜索框里（键盘关闭）才交还给代码区；鼠标点关闭不抢焦点。
    if (searchInput && document.activeElement === searchInput) scroller?.focus({ preventScroll: true });
  }

  /**
   * 内容区自己的快捷键：焦点在内容区时 ⌘/Ctrl F 是文件内搜索、⌘/Ctrl G 是跳行。
   * 在这里拦下并停止冒泡，全局的 ⌘/Ctrl F（聚焦文件树筛选）只在内容区之外生效。
   */
  function onContentKey(event: KeyboardEvent): void {
    if (content?.kind !== "text") return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    } else if (key === "g") {
      event.preventDefault();
      event.stopPropagation();
      searchOpen = false;
      void openGoto();
    }
  }

  function moreEntries(): ContextMenuEntry[] {
    if (!path) return [];
    const target = path;
    const entries: ContextMenuEntry[] = [];
    if (content?.kind === "text") {
      entries.push({ id: "goto", label: "跳到行", icon: "arrow-right", shortcut: `${MODIFIER_LABEL} G`, run: () => void openGoto() });
    }
    if (onOpenDiff && hasUnstaged && hasStaged) {
      entries.push({ id: "staged", label: "查看已暂存的改动", icon: "file-diff", run: () => onOpenDiff?.(target, "staged") });
    }
    if (onFileHistory) {
      entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onFileHistory?.(target) });
    }
    if (entries.length > 0) entries.push({ separator: true });
    entries.push({ id: "copy", label: "复制路径", icon: "copy", run: () => void copyPath() });
    return entries;
  }

  function toggleMore(): void {
    if (menu || performance.now() - moreClosedAt < 250) return;
    const rect = moreButton?.getBoundingClientRect();
    menu = {
      x: rect ? rect.right - 232 : 120,
      y: rect ? rect.bottom + 4 : 120,
      entries: moreEntries(),
      label: "更多文件操作",
    };
  }

  function closeMenu(): void {
    moreClosedAt = performance.now();
    menu = null;
  }

  /** 最近打开（按路径去重，最新的在前）：空状态里直接给出回去的入口。 */
  let recentFiles = $derived.by(() => {
    const visits = nav?.history?.recent ?? [];
    const seen = new Set<string>();
    const out: { path: string; line: number | null }[] = [];
    for (let index = visits.length - 1; index >= 0 && out.length < 6; index -= 1) {
      const visit = visits[index];
      if (seen.has(visit.path)) continue;
      seen.add(visit.path);
      out.push(visit);
    }
    return out;
  });

  async function copyPath(): Promise<void> {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function stateTitle(): string {
    if (content?.kind === "binary") return "二进制文件";
    if (content?.kind === "invalidUtf8") return "不是有效的 UTF-8 文本";
    if (content?.kind === "special") return "特殊文件";
    if (content?.kind === "missing") return "文件不存在";
    return "无法读取文件";
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="file-content" onkeydown={onContentKey}>
  {#if path && parts}
    <header class="diff-toolbar file-head">
      {#if nav}<FileNav {nav} steps={false} />{/if}
      <div class="file-title" title={path}>
        <span class={`tree-icon ft-${fileTone(path)}`}><Icon name="file" size={15} /></span>
        <span class="breadcrumb">
          {#each (parts.dir ? parts.dir.split("/") : []) as segment, index (index)}
            <span class="crumb">{segment}</span><span class="crumb-sep" aria-hidden="true">/</span>
          {/each}
          <strong class="crumb-name">{parts.name}</strong>
        </span>
        {#if mark}
          <span class={`st ${mark.tone}`} title={mark.label} aria-label={`Git 状态：${mark.label}`}>{mark.letter}</span>
        {/if}
      </div>
      <div class="file-actions">
        {#if isSvg && content?.kind === "text"}
          <div class="segmented file-view-mode" role="group" aria-label="SVG 显示方式">
            <button
              type="button"
              aria-pressed={!showImage}
              aria-label="查看这个 SVG 的源码"
              title="源码文本"
              onclick={() => (view = "source")}
            >源码</button>
            <button
              type="button"
              aria-pressed={showImage}
              aria-label="预览这个 SVG 的图片"
              title="按图片预览"
              onclick={() => (view = "image")}
            >预览</button>
          </div>
        {/if}
        {#if onOpenDiff && primarySide}
          <button
            type="button"
            class="btn btn-ghost btn-sm file-diff-btn"
            aria-label={primarySide === "unstaged" ? "查看未暂存的改动" : "查看已暂存的改动"}
            title={primarySide === "unstaged" ? "回到改动视图，定位到这个文件未暂存的一侧" : "回到改动视图，定位到这个文件已暂存的一侧"}
            onclick={() => onOpenDiff?.(path, primarySide!)}
          ><Icon name="file-diff" size={13} /><span>查看改动</span></button>
        {/if}
        {#if content?.kind === "text" && !showImage}
          <button
            type="button"
            class="icon-btn sm"
            aria-pressed={searchOpen}
            aria-label="在文件内搜索"
            title={`在文件内搜索（${MODIFIER_LABEL} F）`}
            onclick={() => (searchOpen ? closeSearch() : openSearch())}
          ><Icon name="search" size={14} /></button>
          <button
            type="button"
            class="icon-btn sm"
            aria-pressed={wrap}
            aria-label="自动换行"
            title={canWrap ? (wrap ? "关闭自动换行" : "自动换行") : `超过 ${WRAP_LIMIT} 行时不自动换行，避免整份文件排进 DOM`}
            disabled={!canWrap && !wrap}
            onclick={() => (wrap = !wrap)}
          ><Icon name="rows" size={14} /></button>
        {/if}
        <button
          type="button"
          class="icon-btn sm"
          aria-label="更多文件操作"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          title="更多：跳到行、文件历史、复制路径"
          bind:this={moreButton}
          onclick={toggleMore}
        ><Icon name="more" size={15} /></button>
      </div>
    </header>

    {#if searchOpen && content?.kind === "text"}
      <div class="file-findbar">
        <div class="field sm">
          <Icon name="search" size={13} />
          <input
            bind:this={searchInput}
            aria-label="文件内搜索关键词"
            placeholder="在文件中查找"
            autocomplete="off"
            spellcheck="false"
            bind:value={searchQuery}
            oninput={() => void runSearch()}
            onkeydown={(event) => {
              if (event.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {#if searching}<span class="spinner" aria-hidden="true"></span>{/if}
          {#if searchResult}
            <span class="find-count" class:none={matchCount === 0} role="status">
              {matchCount === 0 ? "没有匹配" : `${matchCursor >= 0 ? `${matchCursor + 1}/` : ""}${matchCount} 处匹配`}
            </span>
            {#if searchResult.truncated}<span class="file-tag" title={searchResult.message ?? "结果被截断"}>已截断</span>{/if}
          {/if}
        </div>
        <button type="button" class="icon-btn sm" aria-label="上一处匹配" title="上一处（Shift Enter）" disabled={matchCount === 0} onclick={() => stepMatch(-1)}>
          <Icon name="chevron-up" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="下一处匹配" title="下一处（Enter）" disabled={matchCount === 0} onclick={() => stepMatch(1)}>
          <Icon name="chevron-down" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="关闭文件内搜索" title="关闭（Esc）" onclick={closeSearch}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {#if searchError}
        <p class="file-note danger" role="alert">{searchError}</p>
      {/if}
      {#if searchResult && searchResult.matches.length > 0}
        <div class="file-search-results" role="listbox" aria-label="文件内匹配">
          {#each searchResult.matches as match, index (index)}
            {@const snippet = matchSnippet(match.text, searchQuery, match.column, 48)}
            <button
              type="button"
              class="file-search-hit"
              role="option"
              aria-selected={matchCursor === index}
              data-match-index={index}
              aria-label={`第 ${match.line} 行 ${match.text.trim()}`}
              onclick={() => pickMatch(index)}
            >
              <span class="hit-line">{match.line}</span>
              <span class="hit-text" title={match.text}>{snippet.before}{#if snippet.match}<mark>{snippet.match}</mark>{/if}{snippet.after}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    {#if gotoOpen && content?.kind === "text"}
      <div class="file-findbar">
        <div class="field sm file-goto">
          <Icon name="arrow-right" size={13} />
          <input
            bind:this={gotoInput}
            aria-label="跳到行号"
            placeholder="输入行号，回车跳转"
            inputmode="numeric"
            autocomplete="off"
            bind:value={gotoValue}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitGoto();
              } else if (event.key === "Escape") {
                event.preventDefault();
                gotoOpen = false;
                scroller?.focus({ preventScroll: true });
              }
            }}
          />
        </div>
        <button type="button" class="btn btn-secondary btn-sm" title={gotoValue.trim() ? undefined : "先输入行号"} disabled={!gotoValue.trim()} onclick={submitGoto}>跳转</button>
        <button type="button" class="icon-btn sm" aria-label="关闭跳行" title="关闭（Esc）" onclick={() => (gotoOpen = false)}>
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    {#if error}
      <div class="file-state" role="alert">
        <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
        <strong>{stateTitle()}</strong>
        <p>{error}</p>
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => void read(path, 0, false, generation)}>重新读取</button>
      </div>
    {:else if loading}
      <div class="file-skeleton" role="status" aria-label="正在读取文件">
        {#each [38, 64, 52, 0, 71, 45, 58, 30] as width, index (index)}
          <span class="sk-line"><span class="sk-ln"></span>{#if width}<span class="sk-code" style={`width:${width}%`}></span>{/if}</span>
        {/each}
      </div>
    {:else if showImage && previewSources}
      <BinaryPreview
        sources={previewSources}
        generation={content?.generation ?? generation}
        {disabled}
        onGeneration={onGeneration}
      />
    {:else if content && content.kind !== "text"}
      <div class="file-state" role="status">
        <span class="empty-icon"><Icon name={content.kind === "missing" ? "alert-circle" : "file"} size={22} /></span>
        <strong>{stateTitle()}</strong>
        <p>{content.message ?? "这个文件没有可显示的文本内容。"}</p>
      </div>
    {:else if content}
      {#if content.truncated && content.message}
        <p class="file-note" role="status">{content.message}</p>
      {/if}
      {#if pageOffset > 0}
        <div class="file-note" role="status">
          <Icon name="info" size={13} />
          <span>正在显示第 {pageOffset + 1} 行起的内容</span>
          <button type="button" class="link-btn" onclick={() => void read(path, 0, false, generation)}>回到开头</button>
        </div>
      {/if}
      {#if wrap}
        <div class="file-code-wrap" role="textbox" aria-readonly="true" aria-multiline="true" aria-label={`${parts.name} 内容`} tabindex="0">
          {#each lines as line, index (index)}
            {@const no = pageOffset + index + 1}
            <div class="file-wrap-line" class:hit={hitLine === no} data-file-line={no}>
              <span class="ln" aria-hidden="true">{no}</span>
              <span class="code">{#each segmentsAt(index) as seg, i (i)}{#if !seg.k}{seg.t}{:else}<span class={seg.k}>{seg.t}</span>{/if}{/each}</span>
            </div>
          {/each}
        </div>
      {:else}
        <div
          class="diff-scroll file-code"
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          aria-label={`${parts.name} 内容`}
          tabindex="0"
          bind:this={scroller}
          onscroll={onCodeScroll}
          bind:clientHeight={viewport}
        >
          <div class="virtual-space" style={`height:${lines.length * ROW_HEIGHT}px`}>
            <div class="code-ruler" aria-hidden="true">{#each ruler as line, i (i)}<span data-text={line.text} style={rulerPadding(line)}></span>{/each}</div>
            <div class="code-stage">
              {#each lines.slice(range.start, range.end) as line, index (`${pageOffset}-${range.start + index}`)}
                {@const absolute = range.start + index}
                {@const no = pageOffset + absolute + 1}
                <div
                  class="diff-line file-line"
                  class:hit={hitLine === no}
                  data-file-line={no}
                  style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
                >
                  <span class="ln" aria-hidden="true">{no}</span>
                  <span class="code"><span class="code-in" data-len={line.length || 1}>{#each segmentsAt(absolute) as seg, i (i)}{#if !seg.k}{seg.t}{:else}<span class={seg.k}>{seg.t}</span>{/if}{/each}</span></span>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}
      {#if hasMore}
        <div class="file-more">
          {#if loadingMore}<span class="spinner" aria-hidden="true"></span>{/if}
          <button type="button" class="link-btn" title={loadingMore ? "正在读取下一页" : "继续读取后面的内容"} disabled={loadingMore} onclick={() => void loadMore()}>
            {loadingMore ? "正在读取…" : `继续读取后续内容（已显示 ${lines.length} 行）`}
          </button>
        </div>
      {/if}
    {:else}
      <div class="file-state"><strong>选择左侧的一个文件</strong><p>文件内容只读显示，不会改动工作区。</p></div>
    {/if}

    {#if content && !error && !loading}
      <footer class="file-status" aria-label="文件信息">
        <span class="file-status-item" class:changed={Boolean(mark)}>
          {#if copied}
            <Icon name="check" size={12} />已复制路径
          {:else if mark}
            <span class={`tree-dot ${mark.tone}`} aria-hidden="true"></span>{mark.label}{hasStaged && hasUnstaged ? " · 部分已暂存" : hasStaged ? " · 已暂存" : ""}
          {:else}
            无本地改动
          {/if}
        </span>
        {#if content.kind === "text"}
          <span class="file-status-item">
            {#if pageOffset > 0 || hasMore}
              第 {pageOffset + 1}–{pageOffset + lines.length} 行{hasMore ? " · 还有更多" : ""}
            {:else}
              {lines.length} 行
            {/if}
          </span>
        {/if}
        <span class="spacer"></span>
        {#if content.kind === "text"}
          <LanguagePicker path={path} />
        {:else}
          <span class="lang-chip off" title="这类文件不按代码着色"><Icon name="code" size={12} /><span>{languageLabel}</span></span>
        {/if}
        {#if content.size != null}<span class="file-status-item" title={`${content.size} 字节`}>{formatBytes(content.size)}</span>{/if}
        <span class="file-status-item" title="文件视图只读，不会改动工作区"><Icon name="eye" size={12} />只读</span>
      </footer>
    {/if}
  {:else if missingPath}
    <div class="file-state" role="status">
      <span class="empty-icon err"><Icon name="trash" size={22} /></span>
      <strong>文件已删除</strong>
      <p><code>{missingPath}</code> 已不在工作区里，可以从改动或历史查看旧版本。</p>
      <div class="file-state-actions">
        {#if onOpenDiff && deletedChange && deletedChange.unstaged !== "none"}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onOpenDiff?.(missingPath, "unstaged")}>
            查看未暂存的改动
          </button>
        {/if}
        {#if onOpenDiff && deletedChange && deletedChange.staged !== "none"}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onOpenDiff?.(missingPath, "staged")}>
            查看已暂存的改动
          </button>
        {/if}
        {#if onFileHistory}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onFileHistory?.(missingPath)}>
            查看文件历史
          </button>
        {/if}
      </div>
    </div>
  {:else}
    <div class="file-welcome">
      <span class="empty-icon"><Icon name="folder-open" size={22} /></span>
      <strong>选择一个文件开始浏览</strong>
      <p>在左侧目录树中点选文件，或直接按路径打开。</p>
      <ul class="file-welcome-keys">
        <li><span>按路径打开</span><kbd>{MODIFIER_LABEL} P</kbd></li>
        <li><span>筛选文件树</span><kbd>{MODIFIER_LABEL} F</kbd></li>
        <li><span>后退 / 前进</span><kbd>{MODIFIER_LABEL} ⇧ ← →</kbd></li>
      </ul>
      {#if recentFiles.length > 0 && nav?.history}
        <section class="file-recent" aria-label="最近打开">
          <h3>最近打开</h3>
          {#each recentFiles as visit (visit.path)}
            {@const recentParts = splitPath(visit.path)}
            <button type="button" class="file-recent-item" title={visit.path} onclick={() => nav?.history?.onOpen(visit.path, visit.line)}>
              <span class={`tree-icon ft-${fileTone(visit.path)}`}><Icon name="file" size={14} /></span>
              <span class="search-name">{recentParts.name}</span>
              {#if recentParts.dir}<span class="search-dir">{recentParts.dir}</span>{/if}
            </button>
          {/each}
        </section>
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu request={menu} onClose={closeMenu} />
{/if}
