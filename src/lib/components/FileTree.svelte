<script lang="ts">
  import { FILTER_EXTRA_LIMIT, FILE_ROW_HEIGHT, rowIndex, type FileTreeRow } from "../files.svelte";
  import { nextIndex, scrollIndexIntoView, visibleRange } from "../layout";
  import { BUSY_REASON, formatBytes } from "../ui";
  import ContextMenu, { isContextKey, pointFor, type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 按需目录树：只渲染后端已读到的直接子项，长列表用固定行高虚拟化。
   * 行本身不发起请求，展开、拆分、选择都由文件视图的状态模块决定，组件只上报动作。
   */
  interface Props {
    rows: FileTreeRow[];
    selectedPath: string | null;
    loading: boolean;
    failure: string | null;
    query: string;
    includeIgnored: boolean;
    /** 仅看有改动的文件：行来自 StatusSnapshot，删除的文件是墓碑。 */
    changedOnly?: boolean;
    /** 树过滤的全仓库补齐失败原因：失败时不能说「没有更多匹配」。 */
    filterError?: string | null;
    /** 补齐结果被后端截断：匹配没有显示全。 */
    filterTruncated?: boolean;
    /** 补齐行被截到显示上限：还有匹配没列出来。 */
    filterLimited?: boolean;
    /** 有写入或读取在飞行中：只锁树里的动作，不阻止选择。 */
    disabled: boolean;
    onQuery: (value: string) => void;
    onIncludeIgnored: (next: boolean) => void;
    onChangedOnly?: (next: boolean) => void;
    /** 打开按路径搜索或全仓库文本搜索：两种搜索各有自己的输入。 */
    onSearch?: (mode: "path" | "content") => void;
    /** 定位一个树过滤补齐出来的路径（它不在当前已加载的树里）。 */
    onLocate?: (path: string) => void;
    onToggle: (row: FileTreeRow) => void;
    onSelect: (row: FileTreeRow) => void;
    onSplit: (row: FileTreeRow) => void;
    onHistory?: (path: string) => void;
    onRefresh: () => void;
  }

  let {
    rows,
    selectedPath,
    loading,
    failure,
    query,
    includeIgnored,
    changedOnly = false,
    filterError = null,
    filterTruncated = false,
    filterLimited = false,
    disabled,
    onQuery,
    onIncludeIgnored,
    onChangedOnly,
    onSearch,
    onLocate,
    onToggle,
    onSelect,
    onSplit,
    onHistory,
    onRefresh,
  }: Props = $props();

  let scrollTop = $state(0);
  let viewport = $state(0);
  let list = $state<HTMLDivElement | null>(null);
  let menu = $state<ContextMenuRequest | null>(null);

  let range = $derived(visibleRange(rows.length, scrollTop, viewport > 0 ? viewport : 0, FILE_ROW_HEIGHT));
  let visible = $derived(rows.slice(range.start, range.end));

  function reveal(index: number) {
    const next = scrollIndexIntoView(index, scrollTop, viewport > 0 ? viewport : (list?.clientHeight ?? 0), FILE_ROW_HEIGHT);
    scrollTop = next;
    if (list) list.scrollTop = next;
  }

  /** 外部选择变化（例如刷新后保留的选中文件）滚动到可见位置。 */
  let revealedFor = "";
  $effect(() => {
    const path = selectedPath;
    if (!path || path === revealedFor) return;
    const index = rowIndex(rows, path);
    if (index < 0) return;
    revealedFor = path;
    reveal(index);
  });

  function focusList() {
    list?.focus({ preventScroll: true });
  }

  /** 外部（上一个/下一个文件、导航）定位到某个路径：滚动到可见并聚焦列表。 */
  export function revealRow(path: string): void {
    const index = rowIndex(rows, path);
    if (index < 0) return;
    revealedFor = path;
    reveal(index);
    focusList();
  }

  function open(row: FileTreeRow) {
    if (!row.expandable) {
      onSelect(row);
      return;
    }
    if (disabled) return;
    onToggle(row);
  }

  function expand(row: FileTreeRow) {
    if (disabled || !row.expandable) return;
    if (!row.expanded) onToggle(row);
  }

  function collapse(row: FileTreeRow) {
    if (disabled || !row.expandable) return;
    if (row.expanded) onToggle(row);
  }

  function parentOf(row: FileTreeRow): number {
    for (let index = rowIndex(rows, row.path) - 1; index >= 0; index -= 1) {
      if (rows[index].depth < row.depth) return index;
    }
    return -1;
  }

  function onKey(event: KeyboardEvent) {
    if (isContextKey(event)) {
      const index = selectedPath ? rowIndex(rows, selectedPath) : -1;
      if (index >= 0) {
        event.preventDefault();
        const element = list?.querySelector<HTMLElement>('.file-tree-row[aria-selected="true"]');
        menu = {
          ...(element ? pointFor(element) : { x: 120, y: 120 }),
          entries: menuEntries(rows[index]),
          label: `${rows[index].path} 的操作`,
        };
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = selectedPath ? rowIndex(rows, selectedPath) : -1;
    const row = current >= 0 ? rows[current] : null;
    if (event.key === "ArrowRight" && row) {
      event.preventDefault();
      expand(row);
      return;
    }
    if (event.key === "ArrowLeft" && row) {
      event.preventDefault();
      if (row.expanded) collapse(row);
      else {
        const parent = parentOf(row);
        if (parent >= 0) {
          reveal(parent);
          onSelect(rows[parent]);
        }
      }
      return;
    }
    if (event.key === "Enter" && row) {
      event.preventDefault();
      open(row);
      return;
    }
    if (event.key === " " && row) {
      event.preventDefault();
      if (disabled) return;
      onToggle(row);
      return;
    }
    const move = nextIndex(current, event.key, rows.length);
    if (move === null) return;
    event.preventDefault();
    const target = rows[move];
    if (!target) return;
    reveal(move);
    onSelect(target);
  }

  function menuEntries(row: FileTreeRow): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [];
    if (row.expandable) {
      entries.push({
        id: "toggle",
        label: row.expanded ? "折叠" : "展开",
        icon: row.expanded ? "chevron-down" : "chevron-right",
        disabledReason: disabled ? BUSY_REASON : undefined,
        run: () => onToggle(row),
      });
    } else {
      entries.push({ id: "open", label: "打开", icon: "file", run: () => onSelect(row) });
    }
    if (row.splittable) {
      entries.push({
        id: "split",
        label: "拆成逐级目录",
        icon: "list",
        run: () => onSplit(row),
      });
    }
    entries.push({
      id: "copy",
      label: "复制路径",
      icon: "copy",
      run: () => {
        void navigator.clipboard?.writeText(row.path).catch(() => {});
      },
    });
    if (!row.expandable && onHistory) {
      entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onHistory?.(row.path) });
    }
    return entries;
  }

  function rowIcon(row: FileTreeRow): "folder" | "folder-open" | "file" | "link" | "alert-circle" | "package" {
    if (row.kind === "symlink") return "link";
    if (row.kind === "special" || row.kind === "error") return "alert-circle";
    if (row.kind === "nestedRepository") return "package";
    if (row.expandable) return row.expanded ? "folder-open" : "folder";
    return "file";
  }

  function rowHint(row: FileTreeRow): string {
    if (row.error) return row.error;
    if (row.failure) return row.failure;
    if (row.kind === "symlink") return "符号链接：不跟随读取";
    if (row.kind === "special") return "特殊文件：不作为文本读取";
    if (row.kind === "nestedRepository") return "嵌套仓库：不递归读取";
    if (row.kind === "error") return "这个条目读取失败";
    return row.path;
  }
</script>

<div class="file-tools">
  <div class="field sm">
    <Icon name="search" size={14} />
    <input
      id="files-search"
      aria-label="过滤文件树"
      placeholder="过滤已展开的文件"
      autocomplete="off"
      spellcheck="false"
      value={query}
      oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
      onkeydown={(event) => {
        if (event.key === "Escape" && query) {
          event.preventDefault();
          onQuery("");
          return;
        }
        if (event.key === "ArrowDown" && rows.length > 0) {
          event.preventDefault();
          focusList();
        }
      }}
    />
    {#if query}
      <button type="button" class="field-clear" aria-label="清空过滤" onclick={() => onQuery("")}>
        <Icon name="x" size={12} />
      </button>
    {/if}
  </div>
  {#if onSearch}
    <button
      type="button"
      class="icon-btn sm"
      aria-label="按路径打开"
      title="按仓库相对路径查找文件（只查路径，不读内容）"
      onclick={() => onSearch?.("path")}
    >
      <Icon name="file" size={14} />
    </button>
    <button
      type="button"
      class="icon-btn sm"
      aria-label="全仓库搜索"
      title="在工作区文本里查找固定字符串，结果按文件分组"
      onclick={() => onSearch?.("content")}
    >
      <Icon name="search" size={14} />
    </button>
  {/if}
  {#if onChangedOnly}
    <button
      type="button"
      class="icon-btn sm"
      aria-pressed={changedOnly}
      aria-label="只看有改动的文件"
      title={changedOnly ? "显示完整仓库树" : "只显示当前有未提交改动的文件；删除的文件保留为墓碑"}
      onclick={() => onChangedOnly?.(!changedOnly)}
    >
      <Icon name="file-diff" size={14} />
    </button>
  {/if}
  <button
    type="button"
    class="btn btn-ghost btn-sm"
    aria-pressed={includeIgnored}
    aria-label="显示忽略的文件"
    title={includeIgnored ? "不再显示被 .gitignore 忽略的文件" : "同时显示被忽略的文件；不会改动忽略规则"}
    onclick={() => onIncludeIgnored(!includeIgnored)}
  >
    <Icon name="eye" size={13} /><span class="file-group-action">忽略</span>
  </button>
  <button
    type="button"
    class="icon-btn sm"
    aria-label="重新读取目录"
    title="按当前代次重新读取已展开的目录"
    disabled={loading}
    onclick={onRefresh}
  >
    <Icon name="refresh" size={14} />
  </button>
</div>

{#if query}
  <p class="file-tree-status" class:danger={Boolean(filterError)} role={filterError ? "alert" : "status"}>
    {#if filterError}
      全仓库补齐失败：{filterError}只显示已展开范围内的匹配。
    {:else if filterTruncated}
      全仓库匹配过多，补齐结果不完整（后端已截断）。
    {:else if filterLimited}
      全仓库补齐只显示前 {FILTER_EXTRA_LIMIT} 条，还有匹配没有列出。
    {:else if changedOnly}
      仅在改动文件里匹配；改动树不需要全仓库补齐。
    {:else}
      已展开的目录本地过滤，其余由全仓库补齐。
    {/if}
  </p>
{/if}

<div
  class="file-tree"
  role="tree"
  aria-label="仓库文件"
  aria-busy={loading}
  tabindex="0"
  bind:this={list}
  onkeydown={onKey}
  onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
  bind:clientHeight={viewport}
>
  {#if rows.length === 0}
    {#if failure}
      <div class="empty compact" role="alert">
        <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
        <strong>无法读取这个目录</strong>
        <p>{failure}</p>
      </div>
    {:else if loading}
      <div class="empty compact" role="status"><span class="spinner"></span><p>正在读取目录</p></div>
    {:else if query}
      {#if filterError}
        <div class="empty compact" role="alert">
          <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
          <strong>全仓库补齐失败</strong>
          <p>{filterError}已展开的目录里也没有匹配——这不代表仓库里没有匹配的路径。</p>
        </div>
      {:else if filterTruncated || filterLimited}
        <div class="empty compact">
          <span class="empty-icon"><Icon name="search" size={22} /></span>
          <strong>结果不完整</strong>
          <p>
            全仓库补齐{filterTruncated ? "已被后端截断" : `只列出了前 ${FILTER_EXTRA_LIMIT} 条`}，没有可显示的匹配行；
            收窄过滤条件可以看出准确结果。
          </p>
        </div>
      {:else if changedOnly}
        <div class="empty compact">
          <span class="empty-icon"><Icon name="folder" size={22} /></span>
          <strong>改动列表里没有匹配的路径</strong>
          <p>仅改动模式只在当前有改动的文件里匹配；关掉它才是全仓库范围。</p>
        </div>
      {:else}
        <div class="empty compact">
          <span class="empty-icon"><Icon name="folder" size={22} /></span>
          <strong>没有匹配的路径</strong>
          <p>已展开的目录里没有匹配；全仓库的补齐也没有找到更多路径。</p>
        </div>
      {/if}
    {:else if changedOnly}
      <div class="empty compact">
        <span class="empty-icon"><Icon name="folder" size={22} /></span>
        <strong>当前没有改动的文件</strong>
        <p>关掉「只看有改动的文件」即可浏览完整仓库。</p>
      </div>
    {:else if includeIgnored}
      <div class="empty compact">
        <span class="empty-icon"><Icon name="folder" size={22} /></span>
        <strong>这个仓库里没有可显示的文件</strong>
        <p>被忽略的文件已经一起显示，仍然没有可读条目。</p>
      </div>
    {:else}
      <div class="empty compact">
        <span class="empty-icon"><Icon name="folder" size={22} /></span>
        <strong>这里没有可显示的文件</strong>
        <p>可能是空仓库或空目录，也可能只剩被 .gitignore 忽略的文件——它们默认不列出。</p>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          disabled={disabled}
          title={disabled ? BUSY_REASON : "显示被 .gitignore 忽略的文件；不会改动忽略规则"}
          onclick={() => onIncludeIgnored(true)}
        >
          显示忽略文件
        </button>
        <p class="file-tree-note">只影响本次浏览，不会改动仓库的忽略规则。</p>
      </div>
    {/if}
  {:else}
    <div class="virtual-space" style={`height:${rows.length * FILE_ROW_HEIGHT}px`}>
      {#each visible as row, index (row.path)}
        {@const top = (range.start + index) * FILE_ROW_HEIGHT}
        <div
          class="file-tree-row"
          class:segment={row.segment}
          class:ignored={row.ignored}
          class:active={row.path === selectedPath}
          role="treeitem"
          aria-selected={row.path === selectedPath}
          aria-level={row.depth + 1}
          aria-expanded={row.expandable ? row.expanded : undefined}
          tabindex="-1"
          style={`top:${top}px;height:${FILE_ROW_HEIGHT}px;padding-left:${8 + row.depth * 14}px`}
          title={rowHint(row)}
          onclick={() => {
            if (row.extra) onLocate?.(row.path);
            else onSelect(row);
            focusList();
          }}
          ondblclick={() => open(row)}
          onkeydown={(event) => {
            // 行不进入 Tab 序（焦点在树上），这里只满足可聚焦行件的键盘语义，避免与树的键盘重复处理。
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              open(row);
            }
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            onSelect(row);
            menu = { x: event.clientX, y: event.clientY, entries: menuEntries(row), label: `${row.path} 的操作` };
          }}
        >
          {#if row.expandable}
            <button
              type="button"
              class="tree-chevron"
              aria-label={row.expanded ? `折叠 ${row.label}` : `展开 ${row.label}`}
              tabindex="-1"
              onclick={(event) => {
                event.stopPropagation();
                onToggle(row);
              }}
            >
              <Icon name={row.expanded ? "chevron-down" : "chevron-right"} size={12} />
            </button>
          {:else}
            <span class="tree-chevron" aria-hidden="true"></span>
          {/if}
          <Icon name={rowIcon(row)} size={14} />
          <span class="tree-name">{row.label}</span>
          {#if row.splittable}
            <button
              type="button"
              class="tree-split"
              aria-label={`把 ${row.label} 拆成逐级目录`}
              title="拆成逐级目录，恢复按层展开"
              tabindex="-1"
              onclick={(event) => {
                event.stopPropagation();
                onSplit(row);
              }}
            >
              <Icon name="list" size={12} />
            </button>
          {/if}
          {#if row.deleted}<span class="tree-tag danger" title="工作区里没有这个文件，只能看改动或历史">已删除</span>{/if}
          {#if row.extra}<span class="tree-tag" title="匹配路径还没展开：点开时逐级读取">全仓库</span>{/if}
          {#if row.ignored}<span class="tree-tag" title="被 .gitignore 忽略">忽略</span>{/if}
          {#if row.loading}<span class="spinner muted" aria-hidden="true"></span>{/if}
          {#if row.error}<span class="tree-note danger">{row.error}</span>{/if}
          {#if row.failure}<span class="tree-note danger" title={row.failure}>读取失败</span>{/if}
          {#if row.empty}<span class="tree-note">空目录</span>{/if}
          {#if !row.expandable && row.size !== null}<span class="tree-size">{formatBytes(row.size)}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu request={menu} onClose={() => (menu = null)} />
{/if}
