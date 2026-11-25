<script module lang="ts">
  import { api } from "../api";
  import { isRemoteRepositoryKey } from "../remote-worktree";
  import type { RepoHead, WorktreeItem } from "../types";

  // A close/reopen may overlap the same disk read, including when switching projects.
  // Drop completed requests so the next open observes new local Git state.
  function sharePending<T>(load: (paths: string[]) => Promise<T>) {
    const pending = new Map<string, Promise<T>>();
    return (paths: string[]) => {
      const key = JSON.stringify(paths);
      const existing = pending.get(key);
      if (existing) return existing;
      const request = load(paths).finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    };
  }

  // Matches the native MAX_HEADS per call. Retain at most one batch of warm
  // entries between opens, while the mounted menu can show every returned row.
  const PATH_BATCH = 600;

  function trimWarmCache(cache: Map<string, unknown>) {
    if (cache.size <= PATH_BATCH) return;
    let count = 0;
    for (const key of cache.keys()) {
      if (++count > PATH_BATCH) cache.delete(key);
    }
  }

  let overviewRequestId = 1_000_000_000_000;
  /**
   * 远端仓库的键不是本机路径：HEAD 与 worktree 总览只读本机仓库，
   * 这里先过滤，绝不把 ssh 键交给本机命令。
   */
  function localPaths(paths: string[]): string[] {
    return paths.filter((path) => !isRemoteRepositoryKey(path));
  }
  const requestHeads = sharePending((paths) => {
    const local = localPaths(paths);
    return local.length > 0 ? api.repoHeads(local) : Promise.resolve([]);
  });
  const requestOverview = sharePending((paths) => {
    const local = localPaths(paths);
    return local.length > 0
      ? api.worktreeOverview(local, ++overviewRequestId)
      : Promise.resolve({ items: [], checkedAtMs: Date.now() });
  });

  /**
   * 上次读到的 HEAD 与总览：弹层再次打开时先显示上次结果，后台再刷新。
   * 总览项自带 checkedAtMs，所以复用的永远是带时间的旧结果，而不是「看起来新鲜」的数字。
   */
  const knownHeads = new Map<string, RepoHead>();
  const knownItems = new Map<string, WorktreeItem>();
  /**
   * 最近一次成功总览回答过的路径。留在 knownItems 里却不在这张表里的项，
   * 说明这次刷新没有确认到它，只能当过期结果显示，不能继续冒充当前状态。
   */
  const confirmedItems = new Set<string>();
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack, type Snippet } from "svelte";
  import {
    WORKTREE_FILTERS,
    authoritativeMains,
    baseName,
    buildWorktreeGroups,
    filterWorktreeGroups,
    flattenWorktreeGroups,
    headOfRow,
    normalizeRepoPath,
    pathDivergence,
    pruneWorktreeItems,
    remoteText,
    repeatedNames,
    syncPending,
    rowOffsets,
    rowWindow,
    statusTimeText,
    type WorktreeFilter,
    type WorktreeListRow,
    type WorktreeRow,
  } from "../recent";
  import type { WorktreeReviewSummary } from "../review-progress.svelte";
  import type { IconName } from "../icons";
  import type { RecentRepo } from "../types";
  import { hueOf, repoBadgeLetters } from "../ui";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 标题栏仓库弹层：按主仓库分组列出附属工作区，逐项显示真实 Git 状态，
   * 搜索与筛选可组合，右键或菜单键打开仓库操作，底部是打开、克隆、新建（ADR-4）。
   *
   * 状态读取是独立请求：慢或失败都不挡搜索与切换，只把对应项标成未知并带上读取时间。
   * 几百个工作区时只渲染视口附近的行；分组头是虚拟化行但不是选择项，
   * 键盘当前项始终留在 DOM 里，Popover 的 scrollIntoView 与 aria-activedescendant 才有落点。
   */
  interface Props {
    anchor: HTMLElement;
    projectBar?: Snippet;
    repos: RecentRepo[];
    currentPath: string | null;
    /** 不能切换仓库时的原因；只影响其他仓库，当前仓库不需要切换。 */
    blockedReason: string | null;
    /** 可以切换、但切换会带来附带动作时的说明（例如先停下正在等网络的远程操作）。 */
    switchNote?: string | null;
    /** 打开、克隆、新建不可用的原因。 */
    actionReason: string | null;
    /** 「新建工作区」不可用的原因；当前仓库是远端仓库或没有打开仓库时不显示这个入口。 */
    worktreeReason?: string | null;
    /** 当前会话已有的跨 worktree 审阅进度；没有记录的工作区不虚构完成度。 */
    reviews?: WorktreeReviewSummary[];
    onSelect: (path: string, anchor?: string) => void;
    onForget: (path: string) => void;
    onCopyPath: (path: string) => void;
    /** 删除附属工作区（确认后执行）；只对已识别为 worktree 的行出现。 */
    onRemoveWorktree: (repo: RecentRepo, head: RepoHead) => void;
    onContextMenu: (repo: RecentRepo, point: { x: number; y: number }, head: RepoHead | null) => void;
    onCommand: (id: string) => void;
    onClose: (refocus?: boolean) => void;
  }

  let {
    anchor,
    projectBar,
    repos,
    currentPath,
    blockedReason,
    switchNote = null,
    actionReason,
    worktreeReason = null,
    reviews = [],
    onSelect,
    onForget,
    onCopyPath,
    onRemoveWorktree,
    onContextMenu,
    onCommand,
    onClose,
  }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName; title: string }[] = [
    { id: "repo.add", label: "打开本地仓库", icon: "folder-open", title: "打开本地仓库" },
    { id: "repo.clone", label: "克隆远程仓库", icon: "download", title: "克隆远程仓库" },
    { id: "repo.create", label: "新建仓库", icon: "folder-plus", title: "新建仓库" },
  ];
  const WORKTREE_ACTION = {
    id: "branch.worktree",
    label: "新建工作区",
    icon: "layers" as IconName,
    title: "为当前仓库新建一个工作区：在新目录里检出新分支（git worktree），当前工作区不动",
  };
  /** 新建工作区跟着当前仓库走：只有打开的是本机仓库时才给这个入口。 */
  let footActions = $derived(
    currentPath && !isRemoteRepositoryKey(currentPath)
      ? [...ACTIONS.map((action) => ({ ...action, reason: actionReason })), { ...WORKTREE_ACTION, reason: actionReason ?? worktreeReason }]
      : ACTIONS.map((action) => ({ ...action, reason: actionReason })),
  );

  const WIDTH = 540;
  /** 固定行高：工作区两行（名称 + 路径），分组头一行。 */
  const ROW = 52;
  const GROUP_ROW = 30;
  const OVERSCAN = 8;
  const FALLBACK_VIEWPORT = 480;
  /** 超过这个数量才给搜索加防抖：少量仓库时输入即筛，几百个时合并连续击键。 */
  const DEBOUNCE_FROM = 120;
  const DEBOUNCE_MS = 120;
  const FIRST_HEAD_BATCH = 64;

  let query = $state("");
  /** 真正参与筛选的关键词：仓库多时比输入框晚一拍。 */
  let searchTerm = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const next = query;
    untrack(() => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = null;
      if (next === searchTerm) return;
      if (filterCounts.all < DEBOUNCE_FROM || next === "") {
        searchTerm = next;
        return;
      }
      searchTimer = setTimeout(() => {
        searchTimer = null;
        searchTerm = query;
      }, DEBOUNCE_MS);
    });
  });
  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
  /** 回车时关键词还没落地：立刻用输入框里的词筛一次，并落到第一个可切换的仓库。 */
  function flushSearch(): boolean {
    if (searchTerm === query) return false;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    searchTerm = query;
    return true;
  }
  let filter = $state<WorktreeFilter>("all");
  let active = $state(0);
  /** 键盘当前项的稳定身份：列表异步变化时按路径找回，不跟着数字下标漂移。 */
  let activeKey: string | null = null;
  /** 读到的 HEAD 与总览版本：Map 本身不是响应式的，换号让行重新取值。 */
  let headsVersion = $state(0);
  let itemsVersion = $state(0);
  let statusLoading = $state(false);
  let headsLoading = $state(false);
  let statusError = $state<string | null>(null);
  let statusCheckedAt = $state<number | null>(null);
  let remoteOverview = $state<{ anchor: string; paths: Set<string> } | null>(null);

  let recentKeys = $derived(new Set(repos.map((repo) => normalizeRepoPath(repo.path))));
  let visibleItems = $derived.by(() => {
    void itemsVersion;
    return pruneWorktreeItems(recentKeys, knownItems);
  });

  /** 当前项记成路径：键盘、鼠标和异步落地都走同一份身份。 */
  function setActive(index: number) {
    active = index;
    const row = selectable[index];
    activeKey = row ? normalizeRepoPath(row.path) : null;
  }

  /** 当前会话已审阅条数按规范化路径索引：没有记录就是 0 条，不是完成度。 */
  let reviewedTotals = $derived.by(() => {
    const totals: Record<string, number> = {};
    for (const summary of reviews) totals[normalizeRepoPath(summary.path)] = summary.reviewedTotal;
    return totals;
  });

  let groups = $derived.by(() => {
    void headsVersion;
    void itemsVersion;
    return buildWorktreeGroups(repos, knownHeads, visibleItems, currentPath, reviewedTotals, confirmedItems);
  });
  let filtered = $derived(filterWorktreeGroups(groups, searchTerm, filter));
  let flat = $derived(flattenWorktreeGroups(filtered));
  let itemPositions = $derived.by(() => {
    const positions: number[] = [];
    for (let index = 0; index < flat.length; index += 1) {
      if (flat[index].kind === "item") positions.push(index);
    }
    return positions;
  });
  let selectable = $derived(filtered.flatMap((group) => group.rows));
  let badgeLetters = $derived(repoBadgeLetters(selectable.map((row) => row.name)));
  /** 同名仓库只能靠路径区分，这些行显示完整路径而不是截断（R6）。 */
  let sameNames = $derived(repeatedNames(selectable));
  /* 同名仓库路径里的差异段：整组一起算公共前缀，各行只高亮自己与众不同的那一段。 */
  let divergences = $derived.by(() => {
    const map = new Map<string, { head: string; diverge: string; tail: string }>();
    const byName = new Map<string, string[]>();
    for (const row of selectable) {
      if (!sameNames.has(row.name)) continue;
      const list = byName.get(row.name) ?? [];
      list.push(row.path);
      byName.set(row.name, list);
    }
    for (const paths of byName.values()) {
      for (const [path, parts] of pathDivergence(paths)) map.set(path, parts);
    }
    return map;
  });

  onMount(() => {
    pruneCache();
    if (repos.length === 0) return;
    const snapshot = repos;
    headsLoading = true;
    let alive = true;
    // Release this instance's list even if a shared native read takes a long time.
    let stop!: () => void;
    const closed = new Promise<void>((resolve) => { stop = resolve; });
    void (async () => {
      // First paint gets branch hints early. Bound IPC payloads to the native
      // HEAD limit, and publish at doubling intervals to avoid rebuilding the
      // whole list after every batch in a very large project.
      let publishAt = FIRST_HEAD_BATCH;
      for (let start = 0; alive && start < snapshot.length;) {
        const end = Math.min(start + (start === 0 ? FIRST_HEAD_BATCH : PATH_BATCH), snapshot.length);
        const paths = snapshot.slice(start, end).map((repo) => repo.path);
        try {
          const heads = await Promise.race([requestHeads(paths), closed]);
          if (!alive) return;
          for (const path of paths) knownHeads.delete(normalizeRepoPath(path));
          for (const head of heads ?? []) {
            const key = normalizeRepoPath(head.path);
            if (recentKeys.has(key)) knownHeads.set(key, head);
          }
        } catch {
          // A failed batch leaves its previous hints available.
        }
        if (alive && (end >= publishAt || end === snapshot.length)) {
          headsVersion += 1;
          publishAt = end * 2;
        }
        start = end;
      }
      if (alive) headsLoading = false;
    })();
    void loadOverview(snapshot.slice(0, PATH_BATCH).map((repo) => repo.path), closed, () => alive);
    return () => {
      alive = false;
      stop();
      trimWarmCache(knownHeads);
      trimWarmCache(knownItems);
      for (const key of confirmedItems) if (!knownItems.has(key)) confirmedItems.delete(key);
    };
  });

  // Evict forgotten repositories from the module cache, not just the rendered list.
  function pruneCache() {
    for (const key of knownHeads.keys()) if (!recentKeys.has(key)) knownHeads.delete(key);
    const kept = visibleItems;
    for (const key of knownItems.keys()) if (!kept.has(key)) knownItems.delete(key);
    for (const key of confirmedItems) if (!knownItems.has(key)) confirmedItems.delete(key);
  }

  /**
   * 逐项状态：单独请求，慢或失败都不影响搜索与切换。
   * 失败时保留上次结果并说明「读取失败」，行上的时间仍然是被保留结果自己的时间。
   */
  async function loadOverview(paths: string[], closed: Promise<void>, alive: () => boolean) {
    statusLoading = true;
    statusError = null;
    try {
      const anchor = isRemoteRepositoryKey(currentPath) ? currentPath : null;
      const overviews = await Promise.race([
        Promise.all([requestOverview(paths), anchor ? api.linkedWorktreeOverview(anchor) : null]),
        closed,
      ]);
      if (!overviews || !alive() || (anchor && currentPath !== anchor)) return;
      const [local, remote] = overviews;
      remoteOverview = anchor && remote ? { anchor, paths: new Set(remote.items.map((item) => item.path)) } : null;
      const items = [...(local.items ?? []), ...(remote?.items ?? [])];
      const answered = new Set(items.map((item) => normalizeRepoPath(item.path)));
      // 本次没有结果的最近项不再沿用旧状态；枚举出来的工作区（不在请求里）保留自己的结果。
      for (const path of paths) {
        const key = normalizeRepoPath(path);
        if (!answered.has(key)) knownItems.delete(key);
      }
      // 权威枚举过的主仓库以这次结果为准：缓存里已经不在枚举中的附属工作区就是被删掉的，
      // 不能继续显示旧分支/旧 dirty/旧时间，更不能还能打开或删除。
      const authoritative = authoritativeMains(items);
      for (const [key, cached] of knownItems) {
        if (answered.has(key)) continue;
        const main = cached.mainPath ? normalizeRepoPath(cached.mainPath) : null;
        if (main !== null && authoritative.has(main)) knownItems.delete(key);
      }
      for (const item of items) knownItems.set(normalizeRepoPath(item.path), item);
      // 未确认的缓存项留在原处，但只算过期结果。
      for (const key of confirmedItems) if (!answered.has(key)) confirmedItems.delete(key);
      for (const key of answered) confirmedItems.add(key);
      itemsVersion += 1;
      pruneCache();
      statusCheckedAt = Math.max(local.checkedAtMs ?? 0, remote?.checkedAtMs ?? 0) || Date.now();
    } catch (error) {
      if (!alive()) return;
      statusError = errorText(error);
    } finally {
      if (alive()) statusLoading = false;
    }
  }

  function errorText(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    return "无法读取工作区状态。";
  }

  /** 筛选按钮上的实时条数：按真实状态统计，未知项不混进任何一档。 */
  let filterCounts = $derived.by(() => {
    const counts: Record<WorktreeFilter, number> = { all: 0, worktree: 0, dirty: 0, conflict: 0, sync: 0 };
    for (const group of groups) {
      counts.all += group.rows.length;
      for (const row of group.rows) {
        if (row.linked) counts.worktree++;
        if (row.dirty) counts.dirty++;
        if ((row.conflicted ?? 0) > 0) counts.conflict++;
        if (syncPending(row)) counts.sync++;
      }
    }
    return counts;
  });

  function setFilter(next: WorktreeFilter) {
    filter = next;
  }

  /** 名称里命中关键词的部分加粗，扫一眼就知道为什么匹配。 */
  function nameParts(name: string, needle: string): { text: string; hit: boolean }[] {
    const term = needle.trim().toLocaleLowerCase();
    if (!term) return [{ text: name, hit: false }];
    const at = name.toLocaleLowerCase().indexOf(term);
    if (at < 0) return [{ text: name, hit: false }];
    return [
      { text: name.slice(0, at), hit: false },
      { text: name.slice(at, at + term.length), hit: true },
      { text: name.slice(at + term.length), hit: false },
    ].filter((part) => part.text);
  }

  let list: HTMLElement | null = null;
  let scrollTop = $state(0);
  let viewport = $state(0);

  /** 固定行高：不用逐行实测，几百个工作区滚动时只做加法。 */
  function heightOf(row: WorktreeListRow): number {
    return row.kind === "group" ? GROUP_ROW : ROW;
  }

  let offsets = $derived(rowOffsets(flat.map(heightOf)));
  let range = $derived(rowWindow(offsets, scrollTop, viewport > 0 ? viewport : FALLBACK_VIEWPORT, OVERSCAN));
  let rendered = $derived.by(() => {
    const rows: { row: WorktreeListRow; index: number }[] = [];
    for (let index = range.start; index < range.end; index += 1) rows.push({ row: flat[index], index });
    // 键盘当前项必须留在 DOM：aria-activedescendant 与 scrollIntoView 都要有落点。
    const at = itemPositions[active];
    if (at !== undefined && (at < range.start || at >= range.end)) {
      rows.push({ row: flat[at], index: at });
    }
    return rows;
  });

  /**
   * 打开弹层、换关键词或换筛选后，默认项落在第一个可切过去的仓库上：一次回车就能切换（R6）。
   * 关键词没变而列表变了（从列表移除）时留在原位，不把当前项甩到视口外。
   */
  let seenQuery: string | null = null;
  $effect(() => {
    const rows = selectable;
    const key = filter + " " + searchTerm;
    untrack(() => {
      if (key === seenQuery) {
        // 同一搜索条件下列表异步变了：按路径把当前项找回来，新插入的行不会顶替它。
        const at = activeKey === null ? -1 : rows.findIndex((row) => normalizeRepoPath(row.path) === activeKey);
        if (at >= 0) {
          active = at;
          return;
        }
        setActive(Math.min(active, Math.max(0, rows.length - 1)));
        return;
      }
      seenQuery = key;
      const first = rows.findIndex((row) => !row.current);
      setActive(first >= 0 ? first : 0);
      if (list) list.scrollTop = 0;
      scrollTop = 0;
    });
  });

  /** 滚动容器是 Popover 的列表区，这里挂在内容轨道上跟着它走。 */
  function trackList(node: HTMLElement) {
    const host = node.parentElement as HTMLElement;
    // 浏览器每帧最多派发一次 scroll；这里只记两个数，窗口在同一轮更新里重算一次。
    const read = () => {
      scrollTop = host.scrollTop;
      viewport = host.clientHeight;
    };
    list = host;
    read();
    host.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(host);
    return {
      destroy() {
        host.removeEventListener("scroll", read);
        observer?.disconnect();
        list = null;
      },
    };
  }

  function reasonFor(row: WorktreeRow): string | null {
    return row.current ? null : blockedReason;
  }

  function choose(row: WorktreeRow | undefined) {
    if (!row || reasonFor(row)) return;
    if (row.current) onClose();
    else if (remoteOverview?.paths.has(row.path)) onSelect(row.path, remoteOverview.anchor);
    else onSelect(row.path);
  }

  /** 枚举出来但不在最近列表里的工作区：切换目标就是它的路径。 */
  function asRepo(row: WorktreeRow): RecentRepo {
    return { name: row.name, path: row.path, openedAtMs: row.openedAtMs };
  }

  /** 一点状态都没读到时不给右键菜单伪造 head：菜单据此决定是否显示工作区操作。 */
  function contextHead(row: WorktreeRow): RepoHead | null {
    const head = headOfRow(row);
    return head.branch || head.detached || head.missing || head.worktree ? head : null;
  }

  /** 行上的完整状态句：给读屏和提示用，视觉上只留紧凑徽标。 */
  function statusSentence(row: WorktreeRow): string {
    const parts: string[] = [];
    if (row.state === "missing") parts.push("状态未知·目录缺失");
    else if (row.state === "unknown") parts.push("状态未知");
    else if (row.dirty) {
      parts.push(`有改动 ${row.changed ?? 0}`);
      if ((row.conflicted ?? 0) > 0) parts.push(`冲突 ${row.conflicted}`);
    } else parts.push("干净");
    if ((row.ahead ?? 0) > 0) parts.push(`待推送 ${row.ahead}`);
    if ((row.behind ?? 0) > 0) parts.push(`待拉取 ${row.behind}`);
    if (row.upstream) parts.push(`上游 ${row.upstream}`);
    parts.push(remoteText(row));
    if (row.reviewed > 0) parts.push(`已审阅 ${row.reviewed}`);
    parts.push(statusTimeText(row));
    if (row.stale) parts.push("可能已过期");
    return parts.join("，");
  }

  function emptyText(): string {
    if (repos.length === 0) return "还没有最近仓库，从下面打开或克隆一个。";
    if (headsLoading && searchTerm.trim()) return "正在读取分支，搜索结果会随读取进度更新。";
    if (searchTerm.trim() || filter !== "all") return "没有符合当前搜索与筛选的工作区，换个关键词或筛选条件试试。";
    return "没有可显示的工作区。";
  }
</script>

<Popover
  {anchor}
  label="切换仓库"
  width={WIDTH}
  maxHeight={760}
  placeholder={repos.length > 0 ? `搜索 ${repos.length} 个仓库：名称、路径、分支或 worktree` : "搜索仓库名称、路径、分支或 worktree"}
  searchLabel="搜索仓库名称、路径、分支或 worktree"
  bind:query
  bind:active={() => active, (index) => setActive(index)}
  count={selectable.length}
  onChoose={(index) => {
    if (flushSearch()) {
      const first = selectable.findIndex((row) => !row.current);
      setActive(first >= 0 ? first : 0);
      choose(selectable[active]);
      return;
    }
    choose(selectable[index]);
  }}
  onItemContextMenu={(index, point) => {
    const row = selectable[index];
    if (row) onContextMenu(asRepo(row), point, contextHead(row));
  }}
  {onClose}
>
  {#snippet list(listId)}
    {@render projectBar?.()}
    {#if repos.length === 0}
      <p class="branch-popover-empty">还没有最近仓库，从下面打开或克隆一个。</p>
    {:else}
      <div class="rs-toolbar">
        <div class="switcher-filters rs-filters" role="group" aria-label="筛选工作区">
          {#each WORKTREE_FILTERS as option (option.id)}
            {@const count = filterCounts[option.id]}
            {#if option.id === "all" || count > 0 || filter === option.id}
              <button
                type="button"
                class="switcher-filter"
                aria-pressed={filter === option.id}
                data-worktree-filter={option.id}
                title={option.id === "all" ? "全部工作区" : "只看" + option.label + "的工作区"}
                onmousedown={(event) => event.stopPropagation()}
                onclick={() => setFilter(filter === option.id && option.id !== "all" ? "all" : option.id)}
              >
                <span>{option.label}</span>
                {#if option.id !== "all"}<span class="switcher-filter-count">{count}</span>{/if}
              </button>
            {/if}
          {/each}
        </div>
        {#if statusLoading}
          <span class="rs-status" role="status" data-worktree-status="loading" title="正在读取各工作区的状态；搜索和切换不用等它">
            <span class="spinner"></span><span class="sr-only">正在读取各工作区的状态；搜索和切换不用等它。</span>
          </span>
        {:else if statusError}
          <span class="rs-status danger" role="status" data-worktree-status="failed" title={`状态读取失败：${statusError}${statusCheckedAt !== null ? "（显示的是上次读到的结果）" : ""}`}>
            <Icon name="alert-circle" size={13} /><span class="rs-status-text">读取失败</span><span class="sr-only">：{statusError}{#if statusCheckedAt !== null}（下面是上次读到的结果）{/if}</span>
          </span>
        {/if}
      </div>
      {#if blockedReason}
        <p class="switcher-status warn" role="status" data-switch-blocked>暂时不能切换：{blockedReason}</p>
      {:else if switchNote}
        <p class="switcher-status warn" role="status" data-switch-note>{switchNote}</p>
      {/if}
      {#if selectable.length === 0}
        <p class="branch-popover-empty" data-worktree-empty>{emptyText()}</p>
      {/if}
      {#if flat.length > 0}
        <div class="switcher-space" role="presentation" style={"height:" + offsets[flat.length] + "px"} use:trackList oncontextmenu={(event) => {
          const target = event.target as Element | null;
          if (!target?.closest?.("input")) event.preventDefault();
        }}>
          {#each rendered as { row, index } (row.key)}
            {#if row.kind === "group"}
              <div class="switcher-row rs-group" class:leading={index === 0} role="presentation" data-group-row={row.group.key} data-repo-row={index} style={"top:" + offsets[index] + "px"} title={row.group.mainPath ?? "归属未知"}>
                <Icon name="layers" size={12} />
                <span class="rs-group-name">{row.group.name}</span>
                <span class="rs-group-count">{row.group.rows.length} 个工作区</span>
                <span class="rs-group-line" aria-hidden="true"></span>
                <span class="sr-only">{row.group.mainPath ?? "归属未知"}</span>
              </div>
            {:else}
              {@const view = row.row}
              {@const viewIndex = row.index}
              {@const reason = reasonFor(view)}
              {@const badge = badgeLetters[viewIndex] ?? ""}
              {@const nested = view.linked && row.group.rows.length > 1}
              {@const sentence = statusSentence(view)}
              <div class="switcher-row rs-row" class:nested class:last-nested={nested && row.group.rows[row.group.rows.length - 1] === view} role="presentation" data-repo-row={index} style={"top:" + offsets[index] + "px"}>
                <div
                  id={listId + "-" + viewIndex}
                  class="branch-option switcher-option rs-option"
                  class:active={viewIndex === active}
                  role="option"
                  aria-selected={view.current}
                  aria-setsize={selectable.length}
                  aria-posinset={viewIndex + 1}
                  aria-disabled={reason ? "true" : undefined}
                  data-index={viewIndex}
                  data-worktree-path={view.path}
                  title={reason ?? (view.host ? view.host + " · " + view.displayPath : view.path)}
                  tabindex="-1"
                  onmousemove={() => {
                    if (viewIndex !== active) setActive(viewIndex);
                  }}
                  onclick={() => choose(view)}
                  oncontextmenu={(event) => {
                    event.preventDefault();
                    setActive(viewIndex);
                    onContextMenu(asRepo(view), { x: event.clientX, y: event.clientY }, contextHead(view));
                  }}
                  onkeydown={() => {}}
                >
                  {#if nested}
                    <span class="rs-tree" aria-hidden="true"></span>
                  {:else}
                    <span class="repo-badge rs-badge" style={"--hue:" + hueOf(view.path)} aria-hidden="true">{badge}</span>
                  {/if}
                  <span class="rs-text">
                    <span class="rs-line">
                      <span class="repo-name rs-name">{#each nameParts(view.name, searchTerm) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                      {#if view.missing}
                        <span class="repo-head missing" title="目录已不存在或不再是 Git 仓库">目录不存在</span>
                      {:else if view.branch}
                        <span class="repo-head" title={"当前检出的分支：" + view.branch}><Icon name="branch" size={11} /><span class="repo-head-name">{#each nameParts(view.branch, searchTerm) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span></span>
                      {:else if view.detached}
                        <span class="repo-head detached" title={"游离 HEAD：" + view.detached}><Icon name="commit" size={11} /><span class="repo-head-name">{view.detached}</span></span>
                      {/if}
                      {#if view.linked && !view.missing && !nested}
                        <span class="repo-worktree" title={view.mainPath ? "附属工作区（git worktree），主仓库：" + view.mainPath : "附属工作区（git worktree），主仓库未知"}>
                          <Icon name="layers" size={11} />{#if view.mainPath}<span class="repo-worktree-main">{baseName(view.mainPath)}</span>{:else}worktree{/if}
                        </span>
                      {:else if nested && view.mainPath}
                        <span class="repo-worktree sr-only">worktree · {baseName(view.mainPath)}</span>
                      {/if}
                      {#if view.locked}
                        <span class="rs-icon-badge warn" title="已用 git worktree lock 锁定，删除会被拒绝"><span class="repo-locked">已锁定</span></span>
                      {/if}
                    </span>
                    <span class={sameNames.has(view.name) ? "repo-path-full rs-path" : "repo-path rs-path"}><bdi>{#if view.host}<span class="path-diverge">{view.host}</span> · {view.displayPath}{:else if divergences.get(view.path)?.diverge}{@const parts = divergences.get(view.path)!}{parts.head}<span class="path-diverge">{parts.diverge}</span>{parts.tail}{:else}{view.path}{/if}</bdi></span>
                  </span>
                  <span class="repo-status rs-state" data-worktree-state={view.state} title={sentence}>
                    <span class="sr-only">{sentence}{#if view.note && view.state !== "ready"}；{view.note}{/if}</span>
                    <span class="sr-only" data-worktree-remote={view.liveRemoteChecked ? "live" : view.remoteCheckedAtMs !== null ? "stale" : "none"}></span>
                    {#if view.stale}<span class="rs-chip muted" data-worktree-stale={view.path} aria-hidden="true">过期</span>{/if}
                    {#if view.state === "unknown"}
                      <span class="rs-chip muted" aria-hidden="true">?</span>
                    {:else if view.state === "ready"}
                      {#if (view.conflicted ?? 0) > 0}<span class="rs-chip danger" aria-hidden="true"><Icon name="alert" size={11} />{view.conflicted}</span>{/if}
                      {#if view.dirty}
                        <span class="rs-chip warn" aria-hidden="true"><span class="rs-dot"></span>{view.changed ?? 0}</span>
                      {/if}
                    {/if}
                    {#if (view.behind ?? 0) > 0 || (view.ahead ?? 0) > 0}
                      <span class="rs-chip sync" aria-hidden="true">{#if (view.behind ?? 0) > 0}<span>↓{view.behind}</span>{/if}{#if (view.ahead ?? 0) > 0}<span class="up">↑{view.ahead}</span>{/if}</span>
                    {/if}
                    {#if view.reviewed > 0}<span class="rs-chip accent" aria-hidden="true"><Icon name="eye" size={11} />{view.reviewed}</span>{/if}
                  </span>
                  {#if view.current}<span class="switcher-current rs-current" aria-hidden="true">当前</span>{/if}
                </div>
                <span class="switcher-actions">
                  <button type="button" class="icon-btn sm" tabindex="-1" aria-label={"复制 " + view.name + " 的完整路径"} title="复制完整路径" onclick={() => onCopyPath(view.path)}>
                    <Icon name="copy" size={13} />
                  </button>
                  {#if view.linked && !view.missing}
                    <button
                      type="button"
                      class="icon-btn sm danger"
                      tabindex="-1"
                      aria-label={"删除工作区 " + view.name}
                      title={view.current ? "当前打开的工作区不能删除，先切到其他仓库" : "删除这个 worktree（分支和提交保留）"}
                      disabled={view.current}
                      onclick={() => onRemoveWorktree(asRepo(view), headOfRow(view))}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  {/if}
                  {#if view.recent}
                    <button type="button" class="icon-btn sm danger" tabindex="-1" aria-label={"从列表移除 " + view.name} title="从列表移除（不删除文件）" onclick={() => onForget(view.path)}>
                      <Icon name="x" size={13} />
                    </button>
                  {/if}
                </span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  {/snippet}
  {#snippet foot()}
    <div class="switcher-foot">
      {#each footActions as action (action.id)}
        <button type="button" class="menu-item switcher-foot-action" disabled={action.reason !== null} title={action.reason ?? action.title} onclick={() => onCommand(action.id)}>
          <Icon name={action.icon} size={14} />
          <span>{action.label}</span>
        </button>
      {/each}
    </div>
  {/snippet}
</Popover>

<style>
  .rs-toolbar { display: flex; align-items: center; gap: var(--space-6); margin: 0 var(--space-8) var(--space-6); min-height: 24px; }
  .rs-toolbar > .rs-filters { flex: 1; min-width: 0; margin: 0; }
  .rs-status { display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--fg-subtle); font-size: var(--text-xs); }
  .rs-status.danger { color: var(--danger-text); }
  .rs-status .spinner { width: 12px; height: 12px; }
  /* 分组头：名称 + 数量 + 一根延伸到右侧的发丝线；主仓库路径就在第一行里，这里不再重复。 */
  .rs-group { display: flex; align-items: center; gap: 6px; height: 30px; padding: 10px 12px 0; color: var(--fg-subtle); font-size: var(--text-xs); }
  .rs-group :global(.icon) { flex: none; color: var(--fg-subtle); }
  .rs-group-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); font-weight: var(--weight-semibold); letter-spacing: 0.01em; }
  .rs-group-count { flex: none; padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--fg-subtle); font-size: 10.5px; line-height: 16px; font-variant-numeric: tabular-nums; }
  .rs-group-line { flex: 1 1 auto; min-width: 12px; height: 1px; background: var(--border); }
  .rs-row { height: 52px; }
  :global(.popover) .rs-row .rs-option { position: relative; display: flex; align-items: center; gap: 10px; height: 50px; padding: 0 10px; border-radius: var(--radius); }
  :global(.popover) .rs-row.nested .rs-option { padding-left: 24px; }
  .rs-badge { flex: none; width: 28px !important; height: 28px !important; border-radius: var(--radius-sm); font-size: 12px; }
  .rs-tree { position: relative; flex: none; width: 16px; height: 50px; }
  .rs-tree::before { content: ""; position: absolute; left: 3px; top: -2px; bottom: 50%; width: 10px; border-left: 1.5px solid var(--border-strong); border-bottom: 1.5px solid var(--border-strong); border-bottom-left-radius: 7px; }
  .rs-row.nested:not(.last-nested) .rs-tree::after { content: ""; position: absolute; left: 3px; top: 50%; bottom: -2px; border-left: 1.5px solid var(--border-strong); }
  .rs-text { display: flex; flex-direction: column; justify-content: center; gap: 3px; flex: 1; min-width: 0; }
  .rs-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .rs-name { flex: 0 1 auto; min-width: 3em; font-weight: var(--weight-semibold); }
  .rs-row.nested .rs-name { font-weight: var(--weight-medium); }
  .rs-line :global(.repo-head) { max-width: 55%; }
  .rs-line :global(.repo-worktree) { max-width: 30%; }
  .rs-path { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font: 10.5px/1.3 var(--mono); color: var(--fg-subtle); }
  .rs-path bdi { direction: ltr; unicode-bidi: isolate; }
  .rs-path :global(.path-diverge) { color: var(--fg); font-weight: var(--weight-medium); }
  .rs-state { display: inline-flex; align-items: center; gap: 4px; flex: none; flex-wrap: nowrap; }
  .rs-chip { display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--fg-muted); font: 600 11px/1 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rs-chip.warn { background: var(--warning-soft); color: var(--warning-text); }
  .rs-chip.danger { background: var(--danger-soft); color: var(--danger-text); }
  .rs-chip.accent { background: var(--accent-softer); color: var(--accent-text); }
  .rs-chip.muted { background: transparent; color: var(--fg-subtle); font-family: var(--font); font-weight: var(--weight-normal); }
  .rs-chip.sync { background: var(--info-soft); color: var(--info-text); gap: 5px; }
  .rs-chip.sync .up { color: var(--accent-text); }
  .rs-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .rs-icon-badge { flex: none; }
  .rs-current { flex: none; }
  /* 悬停时右侧的操作按钮盖在状态徽标上，不再挤占名称。 */
  .rs-row :global(.switcher-actions) { right: 6px; }
</style>
