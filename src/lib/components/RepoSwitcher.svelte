<script module lang="ts">
  import type { RepoHead, WorktreeItem } from "../types";

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
  import { onMount, tick, untrack } from "svelte";
  import { api } from "../api";
  import {
    WORKTREE_FILTERS,
    authoritativeMains,
    baseName,
    buildWorktreeGroups,
    filterWorktreeGroups,
    flattenWorktreeGroups,
    headOfRow,
    normalizeRepoPath,
    pruneWorktreeItems,
    remoteText,
    repeatedNames,
    rowMatchesFilter,
    rowOffsets,
    rowWindow,
    selectableWorktreeRows,
    statusTimeText,
    timeLabel,
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
    repos: RecentRepo[];
    currentPath: string | null;
    /** 不能切换仓库时的原因；只影响其他仓库，当前仓库不需要切换。 */
    blockedReason: string | null;
    /** 打开、克隆、新建不可用的原因。 */
    actionReason: string | null;
    /** 当前会话已有的跨 worktree 审阅进度；没有记录的工作区不虚构完成度。 */
    reviews?: WorktreeReviewSummary[];
    onSelect: (path: string) => void;
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
    repos,
    currentPath,
    blockedReason,
    actionReason,
    reviews = [],
    onSelect,
    onForget,
    onCopyPath,
    onRemoveWorktree,
    onContextMenu,
    onCommand,
    onClose,
  }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName }[] = [
    { id: "repo.add", label: "打开本地仓库", icon: "folder-open" },
    { id: "repo.clone", label: "克隆远程仓库", icon: "download" },
    { id: "repo.create", label: "新建仓库", icon: "folder-plus" },
  ];

  const WIDTH = 520;
  /** 单行工作区的高度、分组头高度与每多一行的增量，只是实测之前的估算。 */
  const ROW = 64;
  const GROUP_ROW = 30;
  const EXTRA_LINE = 16;
  /** 弹层一行完整路径大约放得下的字符数。 */
  const PATH_CHARS = 70;
  const OVERSCAN = 6;
  const FALLBACK_VIEWPORT = 480;

  let query = $state("");
  let filter = $state<WorktreeFilter>("all");
  let active = $state(0);
  /** 键盘当前项的稳定身份：列表异步变化时按路径找回，不跟着数字下标漂移。 */
  let activeKey: string | null = null;
  /** 读到的 HEAD 与总览版本：Map 本身不是响应式的，换号让行重新取值。 */
  let headsVersion = $state(0);
  let itemsVersion = $state(0);
  let statusLoading = $state(false);
  let statusError = $state<string | null>(null);
  let statusCheckedAt = $state<number | null>(null);
  /** 谁最后发起的请求谁写结果：旧响应不覆盖新列表。 */
  let overviewSerial = 0;
  let requestSeq = 0;

  function nextRequestId(): number {
    requestSeq = (requestSeq % 1_000_000) + 1;
    return requestSeq;
  }

  function itemMap(): Map<string, WorktreeItem> {
    void itemsVersion;
    return new Map(knownItems);
  }

  function headMap(): Map<string, RepoHead> {
    void headsVersion;
    return new Map(knownHeads);
  }

  /** 最近一次成功刷新确认过的路径；还没成功过时为 null（不把缓存说成过期）。 */
  function confirmedSet(): Set<string> | null {
    void itemsVersion;
    return confirmedItems.size === 0 ? null : new Set(confirmedItems);
  }

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

  let groups = $derived(
    buildWorktreeGroups(
      repos,
      headMap(),
      pruneWorktreeItems(repos, itemMap()),
      currentPath,
      reviewedTotals,
      confirmedSet(),
    ),
  );
  let filtered = $derived(filterWorktreeGroups(groups, query, filter));
  let flat = $derived(flattenWorktreeGroups(filtered));
  let selectable = $derived(selectableWorktreeRows(flat));
  let badgeLetters = $derived(repoBadgeLetters(selectable.map((row) => row.name)));
  /** 同名仓库只能靠路径区分，这些行显示完整路径而不是截断（R6）。 */
  let sameNames = $derived(
    repeatedNames(selectable.map((row) => ({ name: row.name, path: row.path, openedAtMs: 0 }))),
  );

  onMount(() => {
    const paths = repos.map((repo) => repo.path);
    if (paths.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const heads = await api.repoHeads(paths);
        if (!alive) return;
        const answered = new Set((heads ?? []).map((head) => normalizeRepoPath(head.path)));
        // 这次没读到的仓库不能继续用上次的 HEAD：缓存只解释「读到过什么」，不是事实来源。
        for (const path of paths) {
          const key = normalizeRepoPath(path);
          if (!answered.has(key)) knownHeads.delete(key);
        }
        for (const head of heads ?? []) knownHeads.set(normalizeRepoPath(head.path), head);
        headsVersion += 1;
      } catch {
        // 读不到分支只是少一条提示，不影响切换。
      }
    })();
    void loadOverview(paths);
    return () => {
      alive = false;
    };
  });

  /**
   * 逐项状态：单独请求，慢或失败都不影响搜索与切换。
   * 失败时保留上次结果并说明「读取失败」，行上的时间仍然是被保留结果自己的时间。
   */
  async function loadOverview(paths: string[]) {
    const serial = ++overviewSerial;
    statusLoading = true;
    statusError = null;
    try {
      const overview = await api.worktreeOverview(paths, nextRequestId());
      if (serial !== overviewSerial) return;
      const items = overview.items ?? [];
      const answered = new Set(items.map((item) => normalizeRepoPath(item.path)));
      // 本次没有结果的最近项不再沿用旧状态；枚举出来的工作区（不在请求里）保留自己的结果。
      for (const path of paths) {
        const key = normalizeRepoPath(path);
        if (!answered.has(key)) knownItems.delete(key);
      }
      // 权威枚举过的主仓库以这次结果为准：缓存里已经不在枚举中的附属工作区就是被删掉的，
      // 不能继续显示旧分支/旧 dirty/旧时间，更不能还能打开或删除。
      const authoritative = authoritativeMains(items);
      for (const [key, cached] of [...knownItems]) {
        if (answered.has(key)) continue;
        const main = cached.mainPath ? normalizeRepoPath(cached.mainPath) : null;
        if (main !== null && authoritative.has(main)) knownItems.delete(key);
      }
      for (const item of items) knownItems.set(normalizeRepoPath(item.path), item);
      // 未确认的缓存项留在原处，但只算过期结果。
      for (const key of [...confirmedItems]) if (!answered.has(key)) confirmedItems.delete(key);
      for (const key of answered) confirmedItems.add(key);
      itemsVersion += 1;
      statusCheckedAt = overview.checkedAtMs ?? Date.now();
    } catch (error) {
      if (serial !== overviewSerial) return;
      statusError = errorText(error);
    } finally {
      if (serial === overviewSerial) statusLoading = false;
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
  function countFor(id: WorktreeFilter): number {
    let total = 0;
    for (const group of groups) for (const row of group.rows) if (rowMatchesFilter(row, id)) total += 1;
    return total;
  }

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

  let space = $state<HTMLElement | null>(null);
  let list: HTMLElement | null = null;
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** 实测行高；原因文字整体出现或消失时行高都变，换一份重新量。 */
  let measured = $state.raw(new Map<string, number>());
  let measuredFor: string | null | undefined;
  /** 方向键刚移动当前项：行高修正后还要把它留在视口里。 */
  let following = false;
  /** 整体重排时钉住的行：视口顶部那一行，和视口顶在行内的偏移。 */
  let pinned: { key: string; within: number } | null = null;

  function estimate(row: WorktreeListRow): number {
    if (row.kind === "group") return GROUP_ROW;
    const pathLines = sameNames.has(row.row.name) ? Math.floor(row.row.path.length / PATH_CHARS) : 0;
    // 原因文字挤掉一整行时先按估算撑高，渲染出来再按实测修正。
    return ROW + pathLines * EXTRA_LINE + (reasonFor(row.row) ? EXTRA_LINE : 0);
  }

  function heightOf(row: WorktreeListRow): number {
    return measured.get(row.key) ?? estimate(row);
  }

  let offsets = $derived(rowOffsets(flat.map(heightOf)));
  let range = $derived(rowWindow(offsets, scrollTop, viewport > 0 ? viewport : FALLBACK_VIEWPORT, OVERSCAN));
  let rendered = $derived.by(() => {
    const rows: { row: WorktreeListRow; index: number }[] = [];
    for (let index = range.start; index < range.end; index += 1) rows.push({ row: flat[index], index });
    // 键盘当前项必须留在 DOM：aria-activedescendant 与 scrollIntoView 都要有落点。
    const current = selectable[active];
    if (current && !rows.some((entry) => entry.row.kind === "item" && entry.row.row.path === current.path)) {
      const at = flat.findIndex((entry) => entry.kind === "item" && entry.row.path === current.path);
      if (at >= 0) rows.push({ row: flat[at], index: at });
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
    const key = filter + " " + query;
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

  /* 阻塞出现或解除时几乎每行都变高或变矮，先趁 DOM 还是旧布局记下视口顶部的行，重排后恢复。 */
  $effect.pre(() => {
    if (blockedReason === measuredFor) return;
    measuredFor = blockedReason;
    untrack(() => {
      pinned = list ? findPinned(list) : null;
      measured = new Map();
    });
  });

  function findPinned(host: HTMLElement): { key: string; within: number } | null {
    let found: { key: string; within: number } | null = null;
    let best = -Infinity;
    for (const node of space?.querySelectorAll<HTMLElement>("[data-repo-row]") ?? []) {
      const top = parseFloat(node.style.top);
      const row = flat[Number(node.dataset.repoRow)];
      if (!row || top > host.scrollTop || top <= best) continue;
      best = top;
      found = { key: row.key, within: host.scrollTop - top };
    }
    return found;
  }

  function restorePinned(host: HTMLElement) {
    if (!pinned) return;
    const { key, within } = pinned;
    const index = flat.findIndex((row) => row.key === key);
    if (index < 0) {
      pinned = null;
      return;
    }
    host.scrollTop = offsets[index] + Math.min(within, Math.max(0, heightOf(flat[index]) - 1));
    scrollTop = host.scrollTop;
  }

  /** 滚动容器是 Popover 的列表区，这里挂在内容轨道上跟着它走。 */
  function trackList(node: HTMLElement) {
    const host = node.parentElement as HTMLElement;
    const read = () => {
      scrollTop = host.scrollTop;
      viewport = host.clientHeight;
    };
    space = node;
    list = host;
    read();
    host.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(host);
    return {
      destroy() {
        host.removeEventListener("scroll", read);
        observer?.disconnect();
        space = null;
        list = null;
      },
    };
  }

  /** 视口上方的行变高时同步推开滚动位置，看着的内容不跳。 */
  function measureRows(node: HTMLElement) {
    let next: Map<string, number> | null = null;
    let shift = 0;
    for (const element of node.querySelectorAll<HTMLElement>("[data-repo-row]")) {
      const height = element.offsetHeight;
      const index = Number(element.dataset.repoRow);
      const row = flat[index];
      if (!row || height <= 0) continue;
      const known = heightOf(row);
      if (height === known) continue;
      next ??= new Map(measured);
      next.set(row.key, height);
      if (offsets[index] + known <= scrollTop) shift += height - known;
    }
    if (!next) {
      if (list) restorePinned(list);
      pinned = null;
      following = false;
      return;
    }
    measured = next;
    // 钉住期间位置由锚点决定；下一轮测量可能先于这里结束钉住，所以在这里就定下不再推开。
    const push = pinned ? 0 : shift;
    void tick().then(() => {
      if (list && pinned) restorePinned(list);
      else if (push !== 0 && list) {
        list.scrollTop += push;
        scrollTop = list.scrollTop;
      }
      if (following) {
        // 方向键刚移动：行高修正后把当前项留在视口里。
        const at = flat.findIndex((row) => row.kind === "item" && row.index === active);
        node.querySelector<HTMLElement>('[data-repo-row="' + at + '"]')?.scrollIntoView?.({ block: "nearest" });
      }
    });
  }

  $effect(() => {
    void rendered;
    const node = space;
    if (node) untrack(() => measureRows(node));
  });

  function reasonFor(row: WorktreeRow): string | null {
    return row.current ? null : blockedReason;
  }

  function choose(row: WorktreeRow | undefined) {
    if (!row || reasonFor(row)) return;
    if (row.current) onClose();
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

  function emptyText(): string {
    if (repos.length === 0) return "还没有最近仓库，从下面打开或克隆一个。";
    if (query.trim() || filter !== "all") return "没有符合当前搜索与筛选的工作区，换个关键词或筛选条件试试。";
    return "没有可显示的工作区。";
  }
</script>

<Popover
  {anchor}
  label="切换仓库"
  width={WIDTH}
  placeholder="搜索仓库名称、路径、分支或 worktree"
  bind:query
  bind:active={
    () => active,
    (index) => {
      setActive(index);
      following = true;
    }
  }
  count={selectable.length}
  onChoose={(index) => choose(selectable[index])}
  onItemContextMenu={(index, point) => {
    const row = selectable[index];
    if (row) onContextMenu(asRepo(row), point, contextHead(row));
  }}
  {onClose}
>
  {#snippet list(listId)}
    {#if repos.length === 0}
      <p class="branch-popover-empty">还没有最近仓库，从下面打开或克隆一个。</p>
    {:else}
      <div class="switcher-filters" role="group" aria-label="筛选工作区">
        {#each WORKTREE_FILTERS as option (option.id)}
          <button
            type="button"
            class="switcher-filter"
            aria-pressed={filter === option.id}
            data-worktree-filter={option.id}
            title={option.id === "all" ? "全部工作区" : "只看" + option.label + "的工作区"}
            onclick={() => setFilter(option.id)}
          >
            <span>{option.label}</span>
            {#if option.id !== "all"}<span class="switcher-filter-count">{countFor(option.id)}</span>{/if}
          </button>
        {/each}
      </div>
      {#if statusLoading}
        <p class="switcher-status" role="status" data-worktree-status="loading">正在读取各工作区的状态；搜索和切换不用等它。</p>
      {:else if statusError}
        <p class="switcher-status danger" role="status" data-worktree-status="failed">
          状态读取失败：{statusError}{#if statusCheckedAt !== null}（下面是上次读到的结果，时间见各行）{/if}
        </p>
      {:else if statusCheckedAt !== null}
        <p class="switcher-status" role="status" data-worktree-status="ready">状态读取于 {timeLabel(statusCheckedAt)}；总览不会自动 fetch 远程。</p>
      {/if}
      {#if selectable.length === 0}
        <p class="branch-popover-empty" data-worktree-empty>{emptyText()}</p>
      {/if}
      {#if flat.length > 0}
        <div class="switcher-space" role="presentation" style={"height:" + offsets[flat.length] + "px"} use:trackList>
          {#each rendered as { row, index } (row.key)}
            {#if row.kind === "group"}
              <div class="switcher-row switcher-group-row" role="presentation" data-group-row={row.group.key} data-repo-row={index} style={"top:" + offsets[index] + "px"}>
                <span class="switcher-group-name"><Icon name="layers" size={11} />{row.group.name}</span>
                <span class="switcher-group-path"><bdi>{row.group.mainPath ?? "归属未知"}</bdi></span>
                <span class="switcher-group-count">{row.group.rows.length} 个工作区</span>
              </div>
            {:else}
              {@const view = row.row}
              {@const viewIndex = row.index}
              {@const reason = reasonFor(view)}
              {@const badge = badgeLetters[viewIndex] ?? ""}
              <div class="switcher-row" role="presentation" data-repo-row={index} style={"top:" + offsets[index] + "px"}>
                <div
                  id={listId + "-" + viewIndex}
                  class="branch-option switcher-option"
                  class:active={viewIndex === active}
                  role="option"
                  aria-selected={view.current}
                  aria-setsize={selectable.length}
                  aria-posinset={viewIndex + 1}
                  aria-disabled={reason ? "true" : undefined}
                  data-index={viewIndex}
                  data-worktree-path={view.path}
                  title={reason ?? view.path}
                  tabindex="-1"
                  onmousemove={() => {
                    following = false;
                    setActive(viewIndex);
                  }}
                  onclick={() => choose(view)}
                  oncontextmenu={(event) => {
                    event.preventDefault();
                    following = false;
                    setActive(viewIndex);
                    onContextMenu(asRepo(view), { x: event.clientX, y: event.clientY }, contextHead(view));
                  }}
                  onkeydown={() => {}}
                >
                  <span class="repo-badge" style={"--hue:" + hueOf(view.path)} aria-hidden="true">{badge}</span>
                  <span class="repo-text">
                    <span class="repo-line">
                      <span class="repo-name">{#each nameParts(view.name, query) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                      {#if view.missing}
                        <span class="repo-head missing" title="目录已不存在或不再是 Git 仓库">目录不存在</span>
                      {:else if view.branch}
                        <span class="repo-head" title={"当前检出的分支：" + view.branch}><Icon name="branch" size={11} /><span class="repo-head-name">{#each nameParts(view.branch, query) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span></span>
                      {:else if view.detached}
                        <span class="repo-head detached" title={"游离 HEAD：" + view.detached}><Icon name="commit" size={11} /><span class="repo-head-name">{view.detached}</span></span>
                      {/if}
                      {#if view.linked && !view.missing}
                        <span class="repo-worktree" title={view.mainPath ? "附属工作区（git worktree），主仓库：" + view.mainPath : "附属工作区（git worktree），主仓库未知"}>
                          <Icon name="layers" size={11} />worktree{#if view.mainPath}<span class="repo-worktree-main">· {baseName(view.mainPath)}</span>{/if}
                        </span>
                      {/if}
                      {#if view.locked}
                        <span class="repo-locked" title="已用 git worktree lock 锁定，删除会被拒绝">已锁定</span>
                      {/if}
                    </span>
                    <span class={sameNames.has(view.name) ? "repo-path-full" : "repo-path"}><bdi>{view.path}</bdi></span>
                    <span class="repo-status" data-worktree-state={view.state}>
                      {#if view.state === "missing"}
                        <span class="repo-state danger">状态未知·目录缺失</span>
                      {:else if view.state === "unknown"}
                        <span class="repo-state muted">状态未知</span>
                      {:else if view.dirty}
                        <span class="repo-state warn">有改动 {view.changed ?? 0}</span>
                        {#if (view.conflicted ?? 0) > 0}<span class="repo-state danger">冲突 {view.conflicted}</span>{/if}
                      {:else}
                        <span class="repo-state ok">干净</span>
                      {/if}
                      {#if (view.ahead ?? 0) > 0}<span class="repo-state">待推送 {view.ahead}</span>{/if}
                      {#if (view.behind ?? 0) > 0}<span class="repo-state">待拉取 {view.behind}</span>{/if}
                      {#if view.upstream}<span class="repo-state muted" title={"本地 upstream：" + view.upstream}>{view.upstream}</span>{/if}
                      <span class="repo-state" class:muted={!view.liveRemoteChecked} data-worktree-remote={view.liveRemoteChecked ? "live" : view.remoteCheckedAtMs !== null ? "stale" : "none"}>{remoteText(view)}</span>
                      {#if view.reviewed > 0}<span class="repo-state accent">已审阅 {view.reviewed}</span>{/if}
                      <span class="repo-state muted">{statusTimeText(view)}</span>
                      {#if view.stale}
                        <span
                          class="repo-state muted"
                          title="这次刷新没有确认到这一项，显示的是更早读取的结果"
                          data-worktree-stale={view.path}>可能已过期</span>
                      {/if}
                      {#if view.note}<span class="repo-state muted repo-state-note" title={view.note}>{view.note}</span>{/if}
                    </span>
                    {#if reason}<span class="switcher-reason">{reason}</span>{/if}
                  </span>
                  {#if view.current}<span class="switcher-current" aria-hidden="true"><Icon name="check" size={12} class="switcher-check" />当前</span>{/if}
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
      {#each ACTIONS as action (action.id)}
        <button type="button" class="menu-item switcher-foot-action" disabled={actionReason !== null} title={actionReason ?? action.label} onclick={() => onCommand(action.id)}>
          <Icon name={action.icon} size={14} />
          <span>{action.label}</span>
        </button>
      {/each}
    </div>
    <p class="switcher-hint" aria-hidden="true">
      <span><span class="key">↑</span><span class="key">↓</span>选择</span>
      <span><span class="key">Enter</span>打开</span>
      <span>可搜名称、路径、分支与主仓库</span>
      <span>右键更多操作</span>
    </p>
  {/snippet}
</Popover>