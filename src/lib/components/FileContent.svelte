<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
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
  import { BUSY_REASON, formatBytes, rowMark, splitPath } from "../ui";
  import BinaryPreview from "./BinaryPreview.svelte";
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
    generation: number;
    /** 目录重验、手动刷新等无代次变化的重读信号。 */
    reloadKey?: number;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFileHistory?: (path: string) => void;
  }

  let {
    active,
    opened,
    path,
    generation,
    reloadKey = 0,
    disabled,
    nextId,
    onGeneration,
    onFileHistory,
  }: Props = $props();

  /** 与 .diff.dense 的行高一致：虚拟窗口按它算，行号与代码同高。 */
  const ROW_HEIGHT = 18;
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
  let searching = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  let gotoOpen = $state(false);
  let gotoValue = $state("");

  let scrollTop = $state(0);
  let viewport = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let searchSerial = 0;

  let parts = $derived(path ? splitPath(path) : null);
  let language = $derived(path ? effectiveLanguage(path) : null);
  let languageLabel = $derived(languageName(language));
  let change = $derived(path ? opened.snapshot.files.find((file) => file.path === path) ?? null : null);
  let mark = $derived.by(() => {
    if (!change) return null;
    const side = change.unstaged !== "none" || change.untracked ? "unstaged" : "staged";
    return rowMark({ ...change, side });
  });
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

  /* 只在（可见、路径、代次、重读信号）变化时读取：隐藏期间不发起新请求。 */
  $effect(() => {
    const target = path;
    const generationNow = generation;
    const key = reloadKey;
    const visible = active;
    untrack(() => {
      if (!target) {
        resetContent();
        return;
      }
      if (!visible) return;
      if (key >= 0) void read(target, 0, false, generationNow);
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

  async function loadMore(): Promise<void> {
    if (!path || !hasMore || loading || loadingMore) return;
    await read(path, pageOffset + lines.length, true, generation);
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
      searchResult = result;
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
    queueMicrotask(() => searchInput?.focus());
  }

  function closeSearch(): void {
    searchOpen = false;
    searchQuery = "";
    searchResult = null;
    searchError = null;
  }

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

<div class="file-content">
  {#if path && parts}
    <div class="diff-toolbar file-toolbar">
      <div class="diff-file">
        <Icon name="file" size={15} />
        <span class="breadcrumb" title={path}>
          {#each (parts.dir ? parts.dir.split("/") : []) as segment, index (index)}
            <span class="crumb">{segment}</span><span class="crumb-sep" aria-hidden="true">/</span>
          {/each}
          <strong class="crumb-name">{parts.name}</strong>
        </span>
        {#if mark}
          <span class={`st ${mark.tone}`} title={mark.label} aria-label={`Git 状态：${mark.label}`}>{mark.letter}</span>
        {/if}
      </div>
      <div class="diff-toolbar-group">
        {#if content?.kind === "text"}
          <LanguagePicker path={path} />
        {:else}
          <span class="lang-chip off" title="这类文件不按代码着色"><Icon name="code" size={12} /><span>{languageLabel}</span></span>
        {/if}
        {#if content?.size != null}<span class="file-size" title={`${content.size} 字节`}>{formatBytes(content.size)}</span>{/if}
      </div>
      <div class="diff-toolbar-group">
        {#if isSvg && !showImage}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="预览这个 SVG 的图片"
            title="按图片预览；源码仍可切回来"
            onclick={() => (view = "image")}
          ><Icon name="eye" size={13} /><span class="diff-hist-label">图片</span></button>
        {:else if isSvg && showImage}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="查看这个 SVG 的源码"
            title="回到源码文本"
            onclick={() => (view = "source")}
          ><Icon name="code" size={13} /><span class="diff-hist-label">源码</span></button>
        {/if}
        {#if content?.kind === "text"}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-pressed={wrap}
            aria-label="自动换行"
            title={canWrap ? (wrap ? "关闭自动换行，恢复横向滚动" : "长行折行显示") : `超过 ${WRAP_LIMIT} 行时不自动换行，避免整份文件排进 DOM`}
            disabled={!canWrap && !wrap}
            onclick={() => (wrap = !wrap)}
          ><Icon name="rows" size={13} /><span class="diff-hist-label">换行</span></button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-pressed={searchOpen}
            aria-label="在文件内搜索"
            title="在整个文件里查找固定字符串，未加载的部分也会搜到"
            onclick={() => (searchOpen ? closeSearch() : openSearch())}
          ><Icon name="search" size={13} /><span class="diff-hist-label">搜索</span></button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-pressed={gotoOpen}
            aria-label="跳到行"
            title="输入行号并跳到那一行"
            onclick={() => (gotoOpen = !gotoOpen)}
          ><Icon name="list" size={13} /><span class="diff-hist-label">跳行</span></button>
        {/if}
        {#if onFileHistory}
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="此文件历史"
            title="查看这个文件的提交历史"
            onclick={() => onFileHistory?.(path)}
          ><Icon name="history" size={13} /><span class="diff-hist-label">历史</span></button>
        {/if}
        <button
          type="button"
          class="icon-btn sm"
          aria-label="复制文件路径"
          title={copied ? "已复制" : "复制这个文件的仓库相对路径"}
          onclick={() => void copyPath()}
        ><Icon name={copied ? "check" : "copy"} size={14} /></button>
      </div>
    </div>

    {#if searchOpen}
      <div class="file-searchbar">
        <div class="field sm">
          <Icon name="search" size={13} />
          <input
            bind:this={searchInput}
            aria-label="文件内搜索关键词"
            placeholder="在这个文件里查找…"
            autocomplete="off"
            spellcheck="false"
            bind:value={searchQuery}
            oninput={() => void runSearch()}
            onkeydown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter" && searchResult?.matches[0]) {
                event.preventDefault();
                void jumpTo(searchResult.matches[0].line);
              }
            }}
          />
        </div>
        {#if searching}<span class="spinner muted" aria-hidden="true"></span>{/if}
        {#if searchResult}
          <span class="file-search-note" role="status">
            {searchResult.matches.length === 0 ? "没有匹配" : `${searchResult.matches.length} 处匹配`}
            {#if searchResult.truncated}<span class="file-tag" title={searchResult.message ?? "结果被截断"}>已截断</span>{/if}
          </span>
        {:else if searchError}
          <span class="file-search-note danger">{searchError}</span>
        {/if}
      </div>
      {#if searchResult && searchResult.matches.length > 0}
        <div class="file-search-results" role="listbox" aria-label="文件内匹配">
          {#each searchResult.matches as match, index (index)}
            <button
              type="button"
              class="file-search-hit"
              role="option"
              aria-selected={hitLine === match.line}
              onclick={() => void jumpTo(match.line)}
            >
              <span class="hit-line">{match.line}</span>
              <span class="hit-text" title={match.text}>{match.text.trim() || " "}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    {#if gotoOpen}
      <div class="file-searchbar">
        <div class="field sm">
          <Icon name="arrow-right" size={13} />
          <input
            aria-label="跳到行号"
            placeholder="行号"
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
              }
            }}
          />
        </div>
        <button type="button" class="btn btn-secondary btn-sm" title={gotoValue.trim() ? undefined : "先输入行号"} disabled={!gotoValue.trim()} onclick={submitGoto}>跳转</button>
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
      <div class="file-state" role="status"><span class="spinner"></span><p>正在读取文件</p></div>
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
          正在显示第 {pageOffset + 1} 行起的内容
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => void read(path, 0, false, generation)}>回到开头</button>
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
          onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
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
          <button type="button" class="btn btn-secondary btn-sm" title={loadingMore ? "正在读取下一页" : "继续读取后面的内容"} disabled={loadingMore} onclick={() => void loadMore()}>
            {loadingMore ? "正在读取…" : `继续读取后续内容（已显示 ${lines.length} 行）`}
          </button>
          {#if content.nextOffset > pageOffset}<span class="file-more-note">下一页从第 {content.nextOffset + 1} 行开始</span>{/if}
        </div>
      {/if}
    {:else}
      <div class="file-state"><strong>选择左侧的一个文件</strong><p>文件内容只读显示，不会改动工作区。</p></div>
    {/if}
  {:else}
    <div class="file-state">
      <span class="empty-icon"><Icon name="folder-open" size={22} /></span>
      <strong>选择一个文件</strong>
      <p>从左侧目录树打开文件；目录按需读取，切换仓库会清空这里的选择。</p>
    </div>
  {/if}
</div>
