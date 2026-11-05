<script module lang="ts">
  import type { RepoHead } from "../types";

  /** 各仓库当前检出的分支：弹层再次打开时先显示上次读到的，后台再刷新。 */
  const knownHeads = new Map<string, RepoHead>();
</script>

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { api } from "../api";
  import { filterRecent, repeatedNames, rowOffsets, rowWindow } from "../recent";
  import type { IconName } from "../icons";
  import type { RecentRepo } from "../types";
  import { hueOf, repoBadgeLetters } from "../ui";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 标题栏仓库弹层：搜索最近仓库并直接切换，右键或菜单键打开仓库操作，
   * 底部是打开、克隆、新建。切换判定由外壳给出（switchBlocked），这里只负责就地说明原因。
   *
   * 几百个仓库时只渲染视口附近的行。同名仓库的完整路径会折行，行高不固定，所以先按估算排版，
   * 渲染出来后记下实测高度。键盘当前项始终留在 DOM 里，Popover 的 scrollIntoView 和
   * aria-activedescendant 才有落点。
   */
  interface Props {
    anchor: HTMLElement;
    repos: RecentRepo[];
    currentPath: string | null;
    /** 不能切换仓库时的原因；只影响其他仓库，当前仓库不需要切换。 */
    blockedReason: string | null;
    /** 打开、克隆、新建不可用的原因。 */
    actionReason: string | null;
    onSelect: (path: string) => void;
    onForget: (path: string) => void;
    onCopyPath: (path: string) => void;
    onContextMenu: (repo: RecentRepo, point: { x: number; y: number }) => void;
    onCommand: (id: string) => void;
    onClose: (refocus?: boolean) => void;
  }

  let { anchor, repos, currentPath, blockedReason, actionReason, onSelect, onForget, onCopyPath, onContextMenu, onCommand, onClose }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName }[] = [
    { id: "repo.add", label: "打开本地仓库", icon: "folder-open" },
    { id: "repo.clone", label: "克隆远程仓库", icon: "download" },
    { id: "repo.create", label: "新建仓库", icon: "folder-plus" },
  ];

  const WIDTH = 480;
  /** 单行仓库的高度与每多一行的增量，只是实测之前的估算。 */
  const ROW = 49;
  const EXTRA_LINE = 16;
  /** 弹层宽 440 时一行完整路径大约放得下的字符数。 */
  const PATH_CHARS = 64;
  const OVERSCAN = 6;
  const FALLBACK_VIEWPORT = 480;

  let query = $state("");
  let active = $state(0);
  /** 读到的 HEAD 版本号：Map 本身不是响应式的，换号让行重新取值。 */
  let headsVersion = $state(0);

  onMount(() => {
    const paths = repos.map((repo) => repo.path);
    if (paths.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const heads = await api.repoHeads(paths);
        if (!alive) return;
        for (const head of heads ?? []) knownHeads.set(head.path, head);
        headsVersion += 1;
      } catch {
        // 读不到分支只是少一条提示，不影响切换。
      }
    })();
    return () => {
      alive = false;
    };
  });

  function headOf(path: string): RepoHead | null {
    void headsVersion;
    return knownHeads.get(path) ?? null;
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
  let visible = $derived(filterRecent(repos, query));
  let badgeLetters = $derived(repoBadgeLetters(visible.map((repo) => repo.name)));
  /** 同名仓库只能靠路径区分，这些行显示完整路径而不是截断（R6）。 */
  let sameNames = $derived(repeatedNames(repos));

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
  let pinned: { path: string; within: number } | null = null;

  function estimate(repo: RecentRepo): number {
    const pathLines = sameNames.has(repo.name) ? Math.floor(repo.path.length / PATH_CHARS) : 0;
    return ROW + pathLines * EXTRA_LINE + (reasonFor(repo) ? EXTRA_LINE : 0);
  }

  function heightOf(repo: RecentRepo): number {
    return measured.get(repo.path) ?? estimate(repo);
  }

  let offsets = $derived(rowOffsets(visible.map(heightOf)));
  let range = $derived(rowWindow(offsets, scrollTop, viewport > 0 ? viewport : FALLBACK_VIEWPORT, OVERSCAN));
  let rendered = $derived.by(() => {
    const rows: { repo: RecentRepo; index: number }[] = [];
    for (let index = range.start; index < range.end; index += 1) rows.push({ repo: visible[index], index });
    if ((active < range.start || active >= range.end) && visible[active]) rows.push({ repo: visible[active], index: active });
    return rows;
  });

  /**
   * 打开弹层或换关键词后，默认项落在第一个可切过去的仓库上：一次回车就能切换（R6）。
   * 关键词没变而列表变了（从列表移除）时留在原位，不把当前项甩到视口外。
   */
  let seenQuery: string | null = null;
  $effect(() => {
    const rows = visible;
    const needle = query;
    untrack(() => {
      if (needle === seenQuery) {
        active = Math.min(active, Math.max(0, rows.length - 1));
        return;
      }
      seenQuery = needle;
      const first = rows.findIndex((repo) => repo.path !== currentPath);
      active = first >= 0 ? first : 0;
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

  function findPinned(host: HTMLElement): { path: string; within: number } | null {
    let found: { path: string; within: number } | null = null;
    let best = -Infinity;
    for (const row of space?.querySelectorAll<HTMLElement>("[data-repo-row]") ?? []) {
      const top = parseFloat(row.style.top);
      const path = visible[Number(row.dataset.repoRow)]?.path;
      if (path === undefined || top > host.scrollTop || top <= best) continue;
      best = top;
      found = { path, within: host.scrollTop - top };
    }
    return found;
  }

  function restorePinned(host: HTMLElement) {
    if (!pinned) return;
    const { path, within } = pinned;
    const index = visible.findIndex((repo) => repo.path === path);
    if (index < 0) {
      pinned = null;
      return;
    }
    host.scrollTop = offsets[index] + Math.min(within, heightOf(visible[index]) - 1);
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
    for (const row of node.querySelectorAll<HTMLElement>("[data-repo-row]")) {
      const height = row.offsetHeight;
      const index = Number(row.dataset.repoRow);
      const repo = visible[index];
      if (!repo || height <= 0) continue;
      const known = heightOf(repo);
      if (height === known) continue;
      next ??= new Map(measured);
      next.set(repo.path, height);
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
      if (following) node.querySelector<HTMLElement>(`[data-repo-row="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
    });
  }

  $effect(() => {
    void rendered;
    const node = space;
    if (node) untrack(() => measureRows(node));
  });

  function reasonFor(repo: RecentRepo): string | null {
    return repo.path === currentPath ? null : blockedReason;
  }

  function choose(repo: RecentRepo | undefined) {
    if (!repo || reasonFor(repo)) return;
    if (repo.path === currentPath) onClose();
    else onSelect(repo.path);
  }
</script>

<Popover
  {anchor}
  label="切换仓库"
  width={WIDTH}
  placeholder="搜索仓库名称或路径"
  bind:query
  bind:active={
    () => active,
    (index) => {
      active = index;
      following = true;
    }
  }
  count={visible.length}
  onChoose={(index) => choose(visible[index])}
  onItemContextMenu={(index, point) => onContextMenu(visible[index], point)}
  {onClose}
>
  {#snippet list(listId)}
    {#if repos.length === 0}
      <p class="branch-popover-empty">还没有最近仓库，从下面打开或克隆一个。</p>
    {:else if visible.length === 0}
      <p class="branch-popover-empty">没有匹配的仓库，试试名称或路径。</p>
    {/if}
    {#if visible.length > 0}
      <div class="switcher-space" role="presentation" style={`height:${offsets[visible.length]}px`} use:trackList>
      {#each rendered as { repo, index } (repo.path)}
        {@const reason = reasonFor(repo)}
        {@const current = repo.path === currentPath}
        {@const head = headOf(repo.path)}
        <div class="switcher-row" role="presentation" data-repo-row={index} style={`top:${offsets[index]}px`}>
          <div
            id={`${listId}-${index}`}
            class="branch-option switcher-option"
            class:active={index === active}
            role="option"
            aria-selected={current}
            aria-setsize={visible.length}
            aria-posinset={index + 1}
            aria-disabled={reason ? "true" : undefined}
            data-index={index}
            title={reason ?? repo.path}
            tabindex="-1"
            onmousemove={() => {
              following = false;
              active = index;
            }}
            onclick={() => choose(repo)}
            oncontextmenu={(event) => {
              event.preventDefault();
              following = false;
              active = index;
              onContextMenu(repo, { x: event.clientX, y: event.clientY });
            }}
            onkeydown={() => {}}
          >
            <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{badgeLetters[index]}</span>
            <span class="repo-text">
              <span class="repo-line">
                <span class="repo-name">{#each nameParts(repo.name, query) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                {#if head?.missing}
                  <span class="repo-head missing" title="目录已不存在或不再是 Git 仓库">目录不存在</span>
                {:else if head?.branch}
                  <span class="repo-head" title={`当前检出的分支：${head.branch}`}><Icon name="branch" size={11} /><span class="repo-head-name">{head.branch}</span></span>
                {:else if head?.detached}
                  <span class="repo-head detached" title={`游离 HEAD：${head.detached}`}><Icon name="commit" size={11} /><span class="repo-head-name">{head.detached}</span></span>
                {/if}
              </span>
              <span class={sameNames.has(repo.name) ? "repo-path-full" : "repo-path"}><bdi>{repo.path}</bdi></span>
              {#if reason}<span class="switcher-reason">{reason}</span>{/if}
            </span>
            {#if current}<span class="switcher-current" aria-hidden="true"><Icon name="check" size={12} class="switcher-check" />当前</span>{/if}
          </div>
          <span class="switcher-actions">
            <button type="button" class="icon-btn sm" tabindex="-1" aria-label={`复制 ${repo.name} 的完整路径`} title="复制完整路径" onclick={() => onCopyPath(repo.path)}>
              <Icon name="copy" size={13} />
            </button>
            <button type="button" class="icon-btn sm danger" tabindex="-1" aria-label={`从列表移除 ${repo.name}`} title="从列表移除（不删除文件）" onclick={() => onForget(repo.path)}>
              <Icon name="x" size={13} />
            </button>
          </span>
        </div>
      {/each}
      </div>
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
      <span>右键：复制路径、在文件管理器中显示、移出列表</span>
    </p>
  {/snippet}
</Popover>
