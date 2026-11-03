<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import type { DiffHunk, DiffResponse, FileRow, FileSelection, LineStat, OpenedRepository } from "../types";
  import { appendDiffPage, BUSY_REASON, blockTops, blockWindow, rowMark, selectionKey, splitPath, type FileNavState } from "../ui";
  import DiffView from "./DiffView.svelte";
  import FileNav from "./FileNav.svelte";
  import Icon from "./Icon.svelte";
  import LineCounts from "./LineCounts.svelte";

  interface Props {
    opened: OpenedRepository;
    active?: boolean;
    /** 选中的文件，已按列表顺序排好。 */
    rows: FileRow[];
    /** 焦点文件：变化时定位到对应文件块。 */
    focus: FileSelection | null;
    nav: FileNavState;
    disabled: boolean;
    fullFile: boolean;
    /** 完整文件视图的上下文行数；与单文件读取同一取值。 */
    fullContext: number;
    stageCount: number;
    unstageCount: number;
    discardCount: number;
    /** 选中文件里被批量动作排除的冲突文件数。 */
    conflictCount: number;
    nextId: () => number;
    /** 用户滚动到另一个文件块：焦点跟过去，下一次切换从这里继续。 */
    onFocus: (item: FileSelection) => void;
    onStale: (generation: number) => void;
    onStageHunk: (item: FileSelection, diff: DiffResponse, hunk: DiffHunk) => void;
    onFullFile: (next: boolean) => void;
    onFileHistory: (path: string) => void;
    onStage: () => void;
    onUnstage: () => void;
    onDiscard: () => void;
    /** 退出多选，回到焦点文件的单选。 */
    onClear: () => void;
  }

  /** 同时在途的差异读取数：选 100 个文件也不会一次把读取通道占满。 */
  const MAX_CONCURRENT = 3;
  /** 视口上下各多留一屏左右，滚动时内容已经就绪。 */
  const OVERSCAN = 600;
  const BLOCK_GAP = 8;
  const HEAD_HEIGHT = 40;
  /** 还没渲染过的块按这个高度占位，真实高度由 ResizeObserver 写回。 */
  const ESTIMATED_HEIGHT = 220;

  let {
    opened,
    active = true,
    rows,
    focus,
    nav,
    disabled,
    fullFile,
    fullContext,
    stageCount,
    unstageCount,
    discardCount,
    conflictCount,
    nextId,
    onFocus,
    onStale,
    onStageHunk,
    onFullFile,
    onFileHistory,
    onStage,
    onUnstage,
    onDiscard,
    onClear,
  }: Props = $props();

  let scroller = $state<HTMLDivElement | null>(null);
  /** 每块的横向位置：块滚出渲染窗口后卸载，回来时要接着看刚才的位置。 */
  const scrollXs = new Map<string, number>();
  let scrollTop = $state(0);
  let viewport = $state(0);
  let mode = $state<"unified" | "split">("unified");
  let heights = $state.raw<Record<string, number>>({});
  let collapsed = $state.raw<Set<string>>(new Set());
  let diffs = $state.raw<Record<string, DiffResponse>>({});
  let errors = $state.raw<Record<string, string>>({});

  let keys = $derived(rows.map(selectionKey));
  let heightList = $derived(keys.map((key) => heights[key] ?? (collapsed.has(key) ? HEAD_HEIGHT : ESTIMATED_HEIGHT)));
  let tops = $derived(blockTops(heightList, BLOCK_GAP));
  let span = $derived(blockWindow(tops, scrollTop, viewport, OVERSCAN));
  let shown = $derived(rows.slice(span.start, span.end));
  let allCollapsed = $derived(keys.every((key) => collapsed.has(key)));
  let noneCollapsed = $derived(collapsed.size === 0);

  /**
   * 仓库、状态快照、generation 或读取范围任何一个变了都算新的一轮：这个对象每轮都是新的，
   * 响应回来时和它比身份，旧轮次的结果直接丢弃。已显示的差异留到新结果到达，不闪空白。
   */
  let round = $derived({
    repo: opened.summary.path,
    generation: opened.generation,
    snapshot: opened.snapshot,
    context: fullFile ? fullContext : undefined,
  });
  type Round = typeof round;

  /** 每个文件块已经读到哪一轮（失败也算读过，不自动重试）。 */
  const settled = new Map<string, Round>();
  /** 每个文件块正在读的轮次。 */
  const reading = new Map<string, Round>();
  let running = 0;
  let destroyed = false;

  /** 需要读取的块：视口内的优先，其次是视口上方的余量。 */
  function wanted(): FileRow[] {
    const first = tops.findIndex((top, index) => index < rows.length && top + heightList[index] > scrollTop);
    const start = Math.min(Math.max(first, span.start), span.end);
    return [...rows.slice(start, span.end), ...rows.slice(span.start, start).reverse()].filter((row) => !collapsed.has(selectionKey(row)));
  }

  function pump() {
    if (destroyed || !active) return;
    for (const row of wanted()) {
      if (running >= MAX_CONCURRENT) return;
      const key = selectionKey(row);
      if (settled.get(key) !== round && reading.get(key) !== round) void load(row, key, round);
    }
  }

  function current(key: string, at: Round): boolean {
    return !destroyed && at === round && keys.includes(key);
  }

  async function load(row: FileRow, key: string, at: Round) {
    running += 1;
    reading.set(key, at);
    try {
      const result = await api.loadDiff(at.repo, row.path, row.side === "staged", at.generation, nextId(), row.originalPath ?? null, 0, 0, at.context);
      if (!current(key, at)) return;
      settled.set(key, at);
      diffs = { ...diffs, [key]: result };
      if (errors[key]) {
        const { [key]: _resolved, ...rest } = errors;
        errors = rest;
      }
    } catch (error) {
      if (!current(key, at)) return;
      const failure = normalizeError(error);
      // 这一轮不再重试：过期时外壳刷新后开始新一轮；其它失败只留在这一块，下一轮再试。
      settled.set(key, at);
      if (failure.code === "stale" && failure.generation !== undefined && failure.generation !== at.generation) {
        onStale(failure.generation);
        return;
      }
      errors = { ...errors, [key]: failure.message };
    } finally {
      running -= 1;
      if (reading.get(key) === at) reading.delete(key);
      pump();
    }
  }

  async function loadMore(row: FileRow) {
    const key = selectionKey(row);
    const loaded = diffs[key];
    if (!loaded || disabled || reading.has(key) || loaded.offset + loaded.lines.length >= loaded.totalLines) return;
    const at = round;
    reading.set(key, at);
    try {
      const page = await api.loadDiff(at.repo, row.path, row.side === "staged", at.generation, nextId(), row.originalPath ?? null, loaded.offset + loaded.lines.length, 400, at.context);
      if (current(key, at)) diffs = { ...diffs, [key]: appendDiffPage(loaded, page) };
    } catch (error) {
      if (current(key, at)) errors = { ...errors, [key]: normalizeError(error).message };
    } finally {
      if (reading.get(key) === at) reading.delete(key);
    }
  }

  let wantedKey = $derived(shown.map(selectionKey).join("\n") + `\n${[...collapsed].join("\n")}`);

  $effect(() => {
    void active;
    void round;
    void wantedKey;
    untrack(pump);
  });

  /* 文件离开选中集合时释放它的差异；再次选中重新读取，不留过期内容。 */
  $effect(() => {
    const live = new Set(keys);
    untrack(() => {
      const drop = Object.keys(diffs).filter((key) => !live.has(key));
      for (const key of [...settled.keys()]) if (!live.has(key)) settled.delete(key);
      for (const key of [...scrollXs.keys()]) if (!live.has(key)) scrollXs.delete(key);
      if (drop.length === 0) return;
      diffs = Object.fromEntries(Object.entries(diffs).filter(([key]) => live.has(key)));
      errors = Object.fromEntries(Object.entries(errors).filter(([key]) => live.has(key)));
    });
  });

  /* 高度实测：完全在视口上方的块变高时把滚动位置补回去，眼前的内容不跳。
     滚动锚定不是每个 WebView 都支持，所以样式里关掉它、统一走这里。 */
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);

  function onResize(entries: ResizeObserverEntry[]) {
    const host = scroller;
    if (!host) return;
    const at = host.scrollTop;
    let next = heights;
    let shift = 0;
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset.key ?? "";
      const index = keys.indexOf(key);
      if (index < 0) continue;
      const height = (entry.target as HTMLElement).offsetHeight;
      const before = heightList[index];
      if (height === 0 || height === before) continue;
      if (tops[index] + before <= at) shift += height - before;
      next = { ...next, [key]: height };
    }
    if (next === heights) return;
    heights = next;
    if (pinned) {
      // 定位目标上方的块还在读取、变高：等布局更新后再对齐一次，直到用户自己滚动。
      void tick().then(place);
    } else if (shift !== 0) {
      host.scrollTop = at + shift;
      scrollTop = host.scrollTop;
    }
  }

  /** 把定位目标对齐到视口顶部。 */
  function place() {
    const host = scroller;
    const index = keys.indexOf(pinned ?? "");
    if (!host || index < 0) return;
    host.scrollTop = tops[index];
    scrollTop = host.scrollTop;
  }

  function measured(node: HTMLElement) {
    observer?.observe(node);
    return { destroy: () => observer?.unobserve(node) };
  }

  onDestroy(() => {
    destroyed = true;
    observer?.disconnect();
  });

  /** 最近一次定位或上报的焦点：相同就不再滚动，用户滚动上报的焦点不会反过来拉动视图。 */
  let placed: string | null = null;
  /** 只有用户自己动过滚动才跟踪焦点；程序定位到最后一块时滚不到顶，不能把焦点改回去。 */
  let spying = false;
  /** 最近一次程序定位的目标；用户一动滚动就放开。 */
  let pinned: string | null = null;

  function armSpy() {
    spying = true;
    pinned = null;
  }

  $effect(() => {
    const key = focus ? selectionKey(focus) : null;
    const host = scroller;
    if (!key || !host || key === placed) return;
    placed = key;
    untrack(() => {
      if (collapsed.has(key)) setCollapsed(key, false);
      spying = false;
      pinned = key;
      keepFocus(host);
      place();
    });
  });

  /** 焦点在块里或已经掉到 body 时收到滚动容器上；在列表和工具栏的焦点不动。 */
  function keepFocus(host: HTMLElement) {
    const active = document.activeElement;
    if (active === document.body || (active !== host && host.contains(active))) host.focus({ preventScroll: true });
  }

  /* 焦点所在的块要滑出渲染窗口：先收走，否则随块卸载掉到 body，方向键就滚不动了。 */
  $effect.pre(() => {
    const live = new Set(shown.map(selectionKey));
    untrack(() => {
      const host = scroller;
      const block = document.activeElement?.closest?.<HTMLElement>(".multi-file");
      if (host && block && host.contains(block) && !live.has(block.dataset.key ?? "")) host.focus({ preventScroll: true });
    });
  });

  function follow() {
    if (!spying) return;
    let index = 0;
    while (index < rows.length - 1 && tops[index + 1] <= scrollTop + 1) index += 1;
    const row = rows[index];
    if (!row || selectionKey(row) === placed) return;
    placed = selectionKey(row);
    onFocus({ path: row.path, side: row.side });
  }

  function setCollapsed(key: string, value: boolean) {
    const next = new Set(collapsed);
    if (value) next.add(key);
    else next.delete(key);
    collapsed = next;
  }

  function toggle(key: string) {
    const fold = !collapsed.has(key);
    setCollapsed(key, fold);
    // 收起时标题可能粘在顶上，块的开头已经滚过去了：回到块首，后面的文件才不会一下子跳走。
    const index = keys.indexOf(key);
    if (fold && scroller && index >= 0 && tops[index] < scroller.scrollTop) {
      scroller.scrollTop = tops[index];
      scrollTop = scroller.scrollTop;
    }
  }

  function titleStat(fromRow: LineStat | null | undefined, loaded: DiffResponse | null): LineStat | null {
    if (fromRow) return fromRow;
    if (!loaded) return null;
    if (loaded.binary) return { additions: null, deletions: null };
    return { additions: loaded.additions, deletions: loaded.deletions };
  }

  function excluded(action: string): string {
    return conflictCount > 0 ? `${action}（已排除 ${conflictCount} 个冲突文件）` : action;
  }
</script>

<section class="diff dense multi-stack" aria-label="多文件差异">
  <div class="diff-toolbar">
    <FileNav {nav} />
    <div class="diff-file">
      <Icon name="layers" size={15} />
      <strong class="multi-stack-count">已选 {rows.length} 个文件</strong>
    </div>
    <button type="button" class="btn btn-ghost btn-sm" aria-label={`暂存 ${stageCount} 个文件`} title={disabled ? BUSY_REASON : stageCount === 0 ? "选中的文件里没有可暂存的改动" : excluded("暂存选中文件")} disabled={disabled || stageCount === 0} onclick={onStage}>
      <Icon name="plus" size={13} /><span class="diff-hist-label">暂存</span>
    </button>
    <button type="button" class="btn btn-ghost btn-sm" aria-label={`取消暂存 ${unstageCount} 个文件`} title={disabled ? BUSY_REASON : unstageCount === 0 ? "选中的文件里没有已暂存的改动" : excluded("取消暂存选中文件")} disabled={disabled || unstageCount === 0} onclick={onUnstage}>
      <Icon name="minus" size={13} /><span class="diff-hist-label">取消暂存</span>
    </button>
    <button type="button" class="icon-btn sm danger" aria-label={`放弃 ${discardCount} 个文件的更改`} title={disabled ? BUSY_REASON : discardCount === 0 ? "选中的文件里没有可放弃的改动" : excluded("放弃选中文件的更改，会先列出全部影响")} disabled={disabled || discardCount === 0} onclick={onDiscard}>
      <Icon name="trash" size={14} />
    </button>
    <button type="button" class="icon-btn sm" aria-label="全部收起" title={allCollapsed ? "已经全部收起" : "收起全部文件"} disabled={allCollapsed} onclick={() => (collapsed = new Set(keys))}>
      <Icon name="chevron-down" size={14} class="flip" />
    </button>
    <button type="button" class="icon-btn sm" aria-label="全部展开" title={noneCollapsed ? "已经全部展开" : "展开全部文件"} disabled={noneCollapsed} onclick={() => (collapsed = new Set())}>
      <Icon name="chevron-down" size={14} />
    </button>
    <button type="button" class="btn btn-ghost btn-sm diff-full-toggle" aria-pressed={fullFile} title={fullFile ? "只显示改动附近的内容" : "把整份文件都显示出来（改动仍高亮）"} onclick={() => onFullFile(!fullFile)}>
      <Icon name="rows" size={13} /><span class="diff-hist-label">{fullFile ? "完整文件" : "只看改动"}</span>
    </button>
    <div class="segmented" role="group" aria-label="差异布局">
      <button type="button" aria-pressed={mode === "unified"} title="统一视图" onclick={() => (mode = "unified")}><Icon name="rows" size={12} />统一</button>
      <button type="button" aria-pressed={mode === "split"} title="并排视图" onclick={() => (mode = "split")}><Icon name="split" size={12} />并排</button>
    </div>
    <button type="button" class="icon-btn sm" aria-label="退出多选" title="退出多选，回到当前文件（Esc）" onclick={onClear}>
      <Icon name="x" size={14} />
    </button>
  </div>
  <div
    class="multi-stack-scroll"
    bind:this={scroller}
    bind:clientHeight={viewport}
    role="presentation"
    tabindex="-1"
    onscroll={(event) => {
      scrollTop = event.currentTarget.scrollTop;
      follow();
    }}
    onwheel={armSpy}
    onpointerdown={armSpy}
    onkeydown={armSpy}
  >
    <div class="multi-stack-list" style={`padding-top:${span.before}px;padding-bottom:${span.after}px`}>
      {#each shown as row (selectionKey(row))}
        {@const key = selectionKey(row)}
        {@const expanded = !collapsed.has(key)}
        {@const parts = splitPath(row.path)}
        {@const mark = rowMark(row)}
        {@const loaded = diffs[key] ?? null}
        {@const stat = row.side === "staged" ? row.stagedLines : row.unstagedLines}
        <article class="multi-file" class:expanded class:focused={focus?.path === row.path && focus.side === row.side} data-key={key} data-path={row.path} use:measured>
          <div class="multi-file-head">
            <button type="button" class="multi-file-toggle" aria-label={`${expanded ? "收起" : "展开"} ${row.path}`} aria-expanded={expanded} title={row.path} onclick={() => toggle(key)}>
              <span class={`st ${mark.tone}`}>{mark.letter}</span>
              <span class="multi-file-name"><strong>{parts.name}</strong>{#if parts.dir}<small>{parts.dir}</small>{/if}</span>
              <span class="diff-side" class:staged={row.side === "staged"}>{row.unmerged ? "冲突" : row.side === "staged" ? "已暂存" : "未暂存"}</span>
              <LineCounts stat={titleStat(stat, loaded)} />
              <Icon name="chevron-down" size={13} class={expanded ? "flip" : ""} />
            </button>
            <button type="button" class="icon-btn sm" aria-label={`查看 ${row.path} 的文件历史`} title="查看此文件历史" onclick={() => onFileHistory(row.path)}><Icon name="history" size={13} /></button>
          </div>
          {#if expanded}
            <div class="multi-file-diff">
              <DiffView
                embedded
                scrollHost={scroller}
                layout={mode}
                scrollX={scrollXs.get(key) ?? 0}
                onScrollX={(left) => scrollXs.set(key, left)}
                selection={{ path: row.path, side: row.side }}
                diff={loaded}
                error={errors[key] ?? null}
                loading={!loaded && !errors[key]}
                {disabled}
                {fullFile}
                onFullFile={onFullFile}
                onStageHunk={(hunk) => loaded && onStageHunk({ path: row.path, side: row.side }, loaded, hunk)}
                onLoadMore={() => void loadMore(row)}
                onFileHistory={onFileHistory}
              />
            </div>
          {/if}
        </article>
      {/each}
    </div>
  </div>
</section>
