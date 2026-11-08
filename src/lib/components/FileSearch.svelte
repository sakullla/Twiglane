<script lang="ts">
  import { tick } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import { fileTone, highlightParts, matchSnippet } from "../file-kind";
  import {
    SEARCH_ROW_HEIGHT,
    contentSearchRows,
    pathSearchRows,
    type FilesStore,
  } from "../files.svelte";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { splitPath } from "../ui";
  import Icon from "./Icon.svelte";

  /**
   * 仓库搜索：路径快速打开与全文搜索是两个各自独立的输入，各自带范围与结果；
   * 目录树的过滤框仍在树上。三种操作不共用一个含义模糊的输入框。
   *
   * 结果按固定行高虚拟化；路径结果是扁平列表，全文结果按文件分组。
   * 方向键在可选行之间移动，Enter 打开目标（全文跳到行），Esc 先清空查询再收起面板。
   */
  interface Props {
    store: FilesStore;
    disabled: boolean;
    /** 当前展开的是哪一种搜索：由文件视图显式切换，不靠猜。 */
    mode: "path" | "content";
    onMode: (mode: "path" | "content") => void;
    onClose: () => void;
    /** 统一入口：打开一个路径，并（全文结果时）定位到行。 */
    onOpen: (path: string, line: number | null) => void;
  }

  let { store, disabled: _disabled, mode, onMode, onClose, onOpen }: Props = $props();

  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let active = $state(-1);

  let pathRows = $derived(pathSearchRows(store.pathResult));
  let contentRows = $derived(contentSearchRows(store.contentResult));
  let rows = $derived(mode === "path" ? pathRows.length : contentRows.length);
  let query = $derived(mode === "path" ? store.pathQuery : store.contentQuery);

  /** 可选中的行：分组标题不是目标，方向键跳过它们。 */
  let selectable = $derived(
    mode === "path"
      ? pathRows.map((_row, index) => index)
      : contentRows.flatMap((row, index) => (row.kind === "match" ? [index] : [])),
  );

  let range = $derived(visibleRange(rows, scrollTop, viewport, SEARCH_ROW_HEIGHT));

  function reveal(index: number): void {
    const next = scrollIndexIntoView(index, scrollTop, viewport || (list?.clientHeight ?? 0), SEARCH_ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  /* 面板打开或切换搜索方式时，焦点直接落到当前输入框：点开就能输入，不用再点一次。 */
  $effect(() => {
    const id = mode === "path" ? "file-quick-open" : "file-content-search";
    void tick().then(() => document.getElementById(id)?.focus({ preventScroll: true }));
  });

  /** 结果换了就把高亮收回第一条：旧查询的选中行不能留在新结果上。 */
  let signature = "";
  $effect(() => {
    const key = `${mode}:${store.pathQuery}:${store.contentQuery}:${store.scopeKind}:${store.searchIgnored}:${rows}`;
    if (key === signature) return;
    signature = key;
    active = selectable[0] ?? -1;
    scrollTop = 0;
    if (list) list.scrollTop = 0;
  });

  function open(index: number): void {
    if (index < 0) return;
    if (mode === "path") {
      const row = pathRows[index];
      if (!row) return;
      onOpen(row.path, null);
      return;
    }
    const row = contentRows[index];
    if (!row || row.kind !== "match") return;
    onOpen(row.path, row.line);
  }

  function move(delta: number): void {
    if (selectable.length === 0) return;
    const at = selectable.indexOf(active);
    const next = nextIndex(at, delta > 0 ? "ArrowDown" : "ArrowUp", selectable.length);
    if (next === null) return;
    active = selectable[next];
    reveal(active);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (mode === "path" ? store.pathQuery : store.contentQuery) {
        if (mode === "path") store.setPathQuery("");
        else store.setContentQuery("");
        return;
      }
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open(active);
    }
  }

  function pathStatus(): string {
    if (store.pathError) return store.pathError;
    if (store.pathBusy) return "正在查找路径…";
    const result = store.pathResult;
    if (!result) return "";
    if (result.entries.length === 0) {
      return result.scanned === 0 ? "仓库里没有可以匹配的路径" : "没有匹配的路径";
    }
    return `${result.entries.length} 条路径${result.truncated ? "（已截断，请收窄查询）" : ""}`;
  }

  function contentStatus(): string {
    if (store.contentError) return store.contentError;
    if (store.contentBusy) return "正在搜索工作区文本…";
    const result = store.contentResult;
    if (!result) return "";
    const parts: string[] = [];
    const files = new Set(result.matches.map((match) => match.path)).size;
    parts.push(
      result.matches.length === 0
        ? result.filesScanned === 0 ? "没有可读的文本文件" : "没有匹配"
        : `${result.matches.length} 处匹配 · ${files} 个文件`,
    );
    // 目录范围由结果自己带回：界面显示的路径和结果集必须说的是同一个目录。
    if (result.scope === "directory") parts.push(`范围 ${result.scopePath || "仓库根目录"}`);
    if (store.contentScopeStale) parts.push("选中目录已变化，正在按新目录重查");
    if (result.truncated) parts.push("已截断，请缩小范围");
    if (result.textTruncated) parts.push("片段被截短");
    if (result.skippedFiles > 0) parts.push(`跳过 ${result.skippedFiles} 个文件`);
    return parts.join(" · ");
  }

  let status = $derived(mode === "path" ? pathStatus() : contentStatus());
  let statusDanger = $derived(Boolean(mode === "path" ? store.pathError : store.contentError));
</script>

{#snippet marked(text: string, needle: string)}
  {@const parts = highlightParts(text, needle)}
  {#if parts}{parts.before}<mark>{parts.match}</mark>{parts.after}{:else}{text}{/if}
{/snippet}

<section class="file-search" aria-label="仓库搜索">
  <div class="file-search-head">
    <div class="segmented file-search-tabs" role="group" aria-label="搜索方式">
      <button
        type="button"
        data-search-scope="path"
        aria-pressed={mode === "path"}
        aria-label="按路径打开"
        title={`按仓库相对路径查找文件（${MODIFIER_LABEL} P）；只查路径，不读取文件内容`}
        onclick={() => onMode("path")}
      ><Icon name="file" size={13} /><span>文件名</span></button>
      <button
        type="button"
        data-search-scope="content"
        aria-pressed={mode === "content"}
        aria-label="全仓库文本搜索"
        title="在工作区文本里查找固定字符串；结果是文件内容命中，不是目录树筛选"
        onclick={() => onMode("content")}
      ><Icon name="search" size={13} /><span>全文</span></button>
    </div>
    <span class="spacer"></span>
    <button type="button" class="icon-btn sm" aria-label="关闭搜索" title="回到文件树（Esc）" onclick={onClose}>
      <Icon name="x" size={14} />
    </button>
  </div>

  {#if mode === "path"}
    <div class="field sm">
      <Icon name="search" size={13} />
      <input
        id="file-quick-open"
        data-search-scope="path"
        aria-label="按路径打开文件"
        placeholder="输入文件名或路径片段"
        title="范围：仓库路径（文件名与目录）；只查路径，不读取文件内容，也不筛目录树"
        autocomplete="off"
        spellcheck="false"
        value={store.pathQuery}
        aria-activedescendant={active >= 0 ? `quick-path-${active}` : undefined}
        oninput={(event) => store.setPathQuery((event.currentTarget as HTMLInputElement).value)}
        onkeydown={onKey}
      />
      {#if store.pathBusy}<span class="spinner" aria-hidden="true"></span>{/if}
    </div>
  {:else}
    <div class="field sm">
      <Icon name="search" size={13} />
      <input
        id="file-content-search"
        data-search-scope="content"
        aria-label="全仓库文本搜索"
        placeholder="查找文本"
        title="范围：工作区文本；打开结果会定位到命中行，与目录树筛选、文件内查找不同"
        autocomplete="off"
        spellcheck="false"
        value={store.contentQuery}
        aria-activedescendant={active >= 0 ? `content-hit-${active}` : undefined}
        oninput={(event) => store.setContentQuery((event.currentTarget as HTMLInputElement).value)}
        onkeydown={onKey}
      />
      {#if store.contentBusy}<span class="spinner" aria-hidden="true"></span>{/if}
    </div>
    <div class="file-search-scopes">
      <div class="segmented" role="group" aria-label="搜索范围">
        <button
          type="button"
          aria-pressed={store.scopeKind === "repository"}
          onclick={() => store.setScopeKind("repository")}
        >全仓库</button>
        <button
          type="button"
          aria-pressed={store.scopeKind === "directory"}
          disabled={store.currentDirectory === null}
          title={
            store.currentDirectory === null
              ? "先在文件树里选中一个目录或文件"
              : store.scopeKind === "directory" && store.contentResult?.scope === "directory"
                ? `只在 ${store.contentScopePath || "仓库根目录"} 里搜索`
                : `只在 ${store.currentDirectory || "仓库根目录"} 里搜索`
          }
          onclick={() => store.setScopeKind("directory")}
        >当前目录</button>
        <button
          type="button"
          aria-pressed={store.scopeKind === "changed"}
          title="只搜索当前有未提交改动的文件（按当前仓库状态）"
          onclick={() => store.setScopeKind("changed")}
        >仅改动</button>
      </div>
      <label class="file-search-toggle" title="只影响本次搜索，不会改动忽略规则">
        <input
          type="checkbox"
          checked={store.searchIgnored}
          onchange={(event) => store.setSearchIgnored((event.currentTarget as HTMLInputElement).checked)}
        />
        <span>包含忽略</span>
      </label>
    </div>
  {/if}

  {#if status}
    <p class="file-search-note" class:danger={statusDanger} role="status">{status}</p>
  {/if}

  {#if mode === "path" && pathRows.length > 0}
    <div
      class="file-search-results"
      role="listbox"
      aria-label="路径搜索结果"
      tabindex="-1"
      bind:this={list}
      bind:clientHeight={viewport}
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
    >
      <div class="virtual-space" style={`height:${pathRows.length * SEARCH_ROW_HEIGHT}px`}>
        {#each pathRows.slice(range.start, range.end) as row, offset (row.path)}
          {@const index = range.start + offset}
          {@const parts = splitPath(row.path)}
          <button
            type="button"
            id={`quick-path-${index}`}
            class="file-search-row path"
            class:ignored={row.ignored}
            role="option"
            aria-selected={active === index}
            tabindex="-1"
            style={`top:${index * SEARCH_ROW_HEIGHT}px;height:${SEARCH_ROW_HEIGHT}px`}
            title={row.path}
            aria-label={row.path}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => open(index)}
          >
            <span class={`tree-icon ${row.kind === "directory" ? "ft-dir" : `ft-${fileTone(row.path)}`}`}>
              <Icon name={row.kind === "directory" ? "folder" : "file"} size={14} />
            </span>
            <span class="search-name">{@render marked(parts.name, store.pathQuery)}</span>
            {#if parts.dir}<span class="search-dir">{@render marked(parts.dir, store.pathQuery)}</span>{/if}
            {#if row.ignored}<span class="tree-tag" title="被 .gitignore 忽略">忽略</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  {:else if mode === "content" && contentRows.length > 0}
    <div
      class="file-search-results"
      role="listbox"
      aria-label="全文搜索结果"
      tabindex="-1"
      bind:this={list}
      bind:clientHeight={viewport}
      onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
    >
      <div class="virtual-space" style={`height:${contentRows.length * SEARCH_ROW_HEIGHT}px`}>
        {#each contentRows.slice(range.start, range.end) as row, offset (row.kind === "group" ? `g:${row.path}` : `m:${row.path}:${row.line}:${row.column}:${offset}`)}
          {@const index = range.start + offset}
          {#if row.kind === "group"}
            {@const parts = splitPath(row.path)}
            <div class="file-search-group" style={`top:${index * SEARCH_ROW_HEIGHT}px;height:${SEARCH_ROW_HEIGHT}px`} title={row.path}>
              <span class={`tree-icon ft-${fileTone(row.path)}`}><Icon name="file" size={13} /></span>
              <span class="search-name">{parts.name}</span>
              {#if parts.dir}<span class="search-dir">{parts.dir}</span>{/if}
              <span class="search-count">{row.count}</span>
            </div>
          {:else}
            {@const snippet = matchSnippet(row.text, store.contentQuery, row.column)}
            <button
              type="button"
              id={`content-hit-${index}`}
              class="file-search-row hit"
              role="option"
              aria-selected={active === index}
              tabindex="-1"
              style={`top:${index * SEARCH_ROW_HEIGHT}px;height:${SEARCH_ROW_HEIGHT}px`}
              title={`${row.path}:${row.line}:${row.column}`}
              aria-label={`${row.line}:${row.column} ${row.text.trim()}`}
              onmousedown={(event) => event.preventDefault()}
              onclick={() => open(index)}
            >
              <span class="hit-pos">{row.line}:{row.column}</span>
              <span class="hit-text">{snippet.before}{#if snippet.match}<mark>{snippet.match}</mark>{/if}{snippet.after}</span>
            </button>
          {/if}
        {/each}
      </div>
    </div>
  {:else if !query.trim()}
    <div class="file-search-hint">
      <span class="empty-icon"><Icon name={mode === "path" ? "file" : "search"} size={20} /></span>
      {#if mode === "path"}
        <p>按文件名或路径片段快速打开文件，只查路径、不读内容。</p>
        <p class="file-search-keys"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 返回</p>
      {:else}
        <p>在工作区文本里查找固定字符串，结果按文件分组，打开后直接跳到命中行。</p>
        <p class="file-search-keys"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 跳转 · <kbd>Esc</kbd> 返回</p>
      {/if}
    </div>
  {/if}
</section>
