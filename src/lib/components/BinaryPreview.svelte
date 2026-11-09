<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { previewReads } from "../preview-reads";
  import { normalizeError } from "../errors";
  import type { FilePreview, PreviewSources } from "../types";
  import { formatBytes } from "../ui";
  import { visibleRange } from "../layout";
  import Icon from "./Icon.svelte";

  type Side = "old" | "new";
  type Mode = Side | "compare";
  type Pane = {
    result: FilePreview | null;
    error: string | null;
    loading: boolean;
    /** 同一版本的后台重读：旧图片留在原处，只在不改布局的位置提示正在刷新。 */
    refreshing: boolean;
    downloading: boolean;
    version: number;
    /** 这一侧内容身份（仓库 + 版本 + 路径）：身份不变的重读才保留已显示的图片。 */
    identity: string;
    /** 已生效的重试序号：重试即便落在同一个代次也要真的重读一次。 */
    retry: number;
    width: number | null;
    height: number | null;
    query: string;
    scroll: number;
    viewport: number;
    listHost?: HTMLDivElement;
  };

  let { sources, generation, disabled, onGeneration }: {
    sources: PreviewSources; generation: number; disabled: boolean;
    onGeneration?: (generation: number) => void;
  } = $props();
  const emptyPane = (version: number): Pane => ({
    result: null, error: null, loading: false, refreshing: false, downloading: false, version,
    identity: "", retry: 0, width: null, height: null, query: "", scroll: 0, viewport: 0,
  });
  let mode = $state<Mode>("new");
  let panes = $state<Record<Side, Pane>>({ old: emptyPane(0), new: emptyPane(0) });
  let retries = $state<Record<Side, number>>({ old: 0, new: 0 });
  let zoom = $state(false);
  let serials: Record<Side, number> = { old: 0, new: 0 };
  let previousKey = "";

  /** 一侧的内容身份：仓库 + 版本 + 路径三样都不同才是「换了内容」。 */
  function sideIdentity(side: Side): string {
    const source = sources[side];
    return source ? `${sources.repository}\u0000${source.revision}\u0000${source.path}` : "";
  }
  let visibleSides = $derived<Side[]>(mode === "compare" ? ["old", "new"] : [mode]);
  let comparing = $derived(mode === "compare" && !!sources.old && !!sources.new);
  /**
   * 单当前文件语境：只有工作区版本（文件视图的资源页就是这种）。
   * 这时版本选择与「没有改动前版本」都没有意义，隐藏它们，标签改成「当前文件」。
   */
  let single = $derived(!sources.old && !!sources.new);
  /** 视图（标题、列表与图片替代文本）用的版本名称。 */
  function sideLabel(side: Side): string {
    return single ? "当前文件" : side === "old" ? "改动前" : "改动后";
  }

  /**
   * 读取一侧：身份变了才清空已显示内容；同一身份的后台重读保留上一份结果，
   * 新数据到达后原地替换，因此刷新、窗口缩放和视图切换都不会先塌陷再排回来。
   */
  function loadSide(side: Side, source: PreviewSources[Side], current: number, retry: number) {
    const token = ++serials[side];
    const controller = new AbortController();
    const pane = panes[side];
    const identity = sideIdentity(side);
    // 这里的读只用来判断「要不要重读」：不能被当成 effect 依赖，
    // 否则图片解码失败这类与本侧内容无关的状态变化都会反过来再发一次请求。
    const before = untrack(() => ({ result: pane.result, identity: pane.identity, retry: pane.retry }));
    // 已经有这个代次的结果、也没有新的重试：不再发一次多余的请求。
    // 采纳新代次后宿主会把 generation 提上来，这一步避免「读 → 提版本 → 再读」的往复。
    if (source && before.result && before.identity === identity && before.result.generation === current && before.retry === retry) {
      return () => { serials[side]++; controller.abort(); };
    }
    const keeping = before.result !== null && before.identity === identity;
    pane.retry = retry;
    if (keeping) {
      // 旧图片继续显示：只标记正在刷新，尺寸、滚动与缩放都不动。
      pane.refreshing = true;
      pane.loading = false;
      pane.error = null;
      pane.downloading = false;
      pane.identity = identity;
      pane.version = current;
    } else {
      pane.result = null;
      pane.error = null;
      pane.loading = !!source;
      pane.refreshing = false;
      pane.downloading = false;
      pane.version = current;
      pane.identity = identity;
      pane.width = null;
      pane.height = null;
      pane.query = "";
      pane.scroll = 0;
    }
    if (!source) {
      pane.refreshing = false;
      return () => { serials[side]++; controller.abort(); };
    }
    void previewReads.run(async () => {
      // 读取一被作废（切换版本或卸载）就让 task 立刻落地，把 previewReads 的槽位让给新选择，
      // 而不是等已经没人要的后端响应返回；否则两个在途读取会把新读取一直挡在队列里。
      // 取消信号只在 task 真正开始后创建：排队期间被 abort 时 task 不执行，也就不会留下无人接管的 rejection。
      if (controller.signal.aborted) throw { code: "cancelled", message: "预览已切换。" };
      let detach = () => {};
      const abandoned = new Promise<never>((_, reject) => {
        const cancel = () => reject({ code: "cancelled", message: "预览已切换。" });
        controller.signal.addEventListener("abort", cancel, { once: true });
        detach = () => controller.signal.removeEventListener("abort", cancel);
      });
      try {
        const read = (async () => {
          try {
            return await api.filePreview(sources.repository, source, current);
          } catch (failure) {
            const normalized = normalizeError(failure);
            if (normalized.code !== "stale" || normalized.generation === undefined || controller.signal.aborted) throw failure;
            return api.filePreview(sources.repository, source, normalized.generation);
          }
        })();
        return await Promise.race([read, abandoned]);
      } finally {
        detach();
      }
    }, controller.signal).then((value) => {
      if (serials[side] !== token) return;
      pane.result = value;
      pane.version = value.generation;
      if (value.generation !== current) onGeneration?.(value.generation);
      // Deleted files open on their previous version automatically.
      if (value.kind === "missing" && side === "new" && sources.old) mode = "old";
    }).catch((failure) => {
      if (serials[side] !== token) return;
      const message = normalizeError(failure).message;
      // 后台重读失败时保留上一份可读内容，并明确它已经不是刚验证过的结果。
      pane.error = keeping ? `刷新没有完成：${message} 仍在显示上一次读取的内容。` : message;
    }).finally(() => {
      if (serials[side] !== token) return;
      pane.loading = false;
      pane.refreshing = false;
    });
    return () => { serials[side]++; controller.abort(); };
  }

  // retries 只用于让“重试”按钮重新发起读取，值本身不参与请求参数。
  // 直接把 loadSide 的 cleanup 交还给 effect：依赖变化重跑和组件卸载都会执行 serial++/abort，
  // 否则被取代或已卸载的读取会一直占着 previewReads 的两个槽位。
  $effect(() => {
    const retry = retries.old;
    return loadSide("old", sources.old, generation, retry);
  });
  $effect(() => {
    const retry = retries.new;
    return loadSide("new", sources.new, generation, retry);
  });
  // 只有「换了一份内容」才重置缩放与比较方式；后台刷新与代次变化保持用户当前的选择，
  // 否则并排/统一视图、原始大小会在刷新时被悄悄改回去，看起来像尺寸在跳动。
  $effect(() => {
    const key = JSON.stringify([sources.repository, sources.old, sources.new]);
    if (key !== previousKey) {
      previousKey = key;
      zoom = false;
      mode = sources.old && sources.new ? "compare" : sources.old ? "old" : "new";
      // 单当前文件只有一侧，不给版本切换留下可点的入口。
    }
  });

  async function download(side: Side) {
    const source = sources[side];
    const pane = panes[side];
    if (!source || pane.downloading || disabled || !pane.result?.canDownload) return;
    const token = serials[side];
    pane.downloading = true;
    pane.error = null;
    try {
      const value = await api.filePreview(sources.repository, source, pane.version, true);
      if (token !== serials[side]) return;
      pane.version = value.generation;
      pane.result = value;
      pane.width = null;
      pane.height = null;
      onGeneration?.(value.generation);
    } catch (failure) {
      if (token !== serials[side]) return;
      const normalized = normalizeError(failure);
      pane.error = normalized.message;
      if (normalized.generation !== undefined) {
        pane.version = normalized.generation;
        onGeneration?.(normalized.generation);
      }
    } finally {
      if (token === serials[side]) pane.downloading = false;
    }
  }

  function entries(pane: Pane) {
    return (pane.result?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(pane.query.trim().toLowerCase()));
  }

  function imageLoaded(side: Side, event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    panes[side].width = image.naturalWidth;
    panes[side].height = image.naturalHeight;
  }

  function imageError(side: Side) {
    // 解码失败就不再保留这张图：留着会是一个永远画不出来的空框。
    panes[side].error = "图片损坏或当前系统不支持此图片格式。";
    panes[side].result = null;
    panes[side].width = null;
    panes[side].height = null;
  }

  function keyboard(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement)?.matches("input, textarea, select")) return;
    const next: Record<string, Mode | undefined> = { "1": sources.old ? "old" : undefined, "2": sources.new ? "new" : undefined, "3": sources.old && sources.new ? "compare" : undefined };
    if (event.key in next) {
      const value = next[event.key];
      if (value) { mode = value; event.preventDefault(); }
    } else if (event.key === "0" && visibleSides.some((side) => panes[side].result?.kind === "image")) {
      zoom = !zoom;
      event.preventDefault();
    }
  }
</script>

<!-- 这里只监听 1/2/3/0 冒泡来切换比较方式与缩放，容器本身不是可交互控件。 -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<section class="binary-preview" aria-label="文件内容预览" tabindex="0" onkeydown={keyboard}>
  <div class="preview-toolbar">
    {#if !single}
      <div class="segmented" role="group" aria-label="预览版本">
        <button type="button" aria-pressed={mode === "old"} title={!sources.old ? "此版本不存在" : "仅预览改动前（1）"} disabled={!sources.old} onclick={() => (mode = "old")}>改动前</button>
        <button type="button" aria-pressed={mode === "new"} title={!sources.new ? "此版本不存在" : "仅预览改动后（2）"} disabled={!sources.new} onclick={() => (mode = "new")}>改动后</button>
        {#if sources.old && sources.new}
          <button type="button" aria-pressed={mode === "compare"} title="并排比较（3）" onclick={() => (mode = "compare")}>并排比较</button>
        {/if}
      </div>
    {:else}
      <span class="preview-current" title={sources.new?.path ?? ""}>当前文件</span>
    {/if}
    <span class="spacer"></span>
    {#if visibleSides.some((side) => panes[side].result?.kind === "image")}
      <button type="button" class="btn btn-ghost btn-sm" aria-pressed={zoom} title="切换所有图片缩放（0）" onclick={() => (zoom = !zoom)}>{zoom ? "适应窗口" : "原始大小"}</button>
    {/if}
  </div>
  {#if (!sources.old || !sources.new) && !single}
    <!-- 单版本视图要说清另一侧为什么不在，不能只靠按钮上的 disabled title。 -->
    <p class="preview-note">
      {#if !sources.old && !sources.new}
        没有可预览的版本
      {:else if !sources.old}
        没有改动前版本，无法并排比较
      {:else}
        没有改动后版本，无法并排比较
      {/if}
    </p>
  {/if}
  <div class="preview-panes" class:comparing>
    {#each visibleSides as side (side)}
      {@const pane = panes[side]}
      {@const source = sources[side]}
      {@const filtered = entries(pane)}
      {@const range = visibleRange(filtered.length, pane.scroll, pane.viewport || 400, 30)}
      <section class="preview-pane" aria-label={`${sideLabel(side)}预览`}>
        {#if comparing}
          <header class="pane-heading"><strong>{sideLabel(side)}</strong><span title={source?.path}>{source?.path ?? "此版本不存在"}</span></header>
        {/if}
        {#if pane.result?.size != null || pane.result?.lfsOid}
          <div class="pane-meta">
            {#if pane.result.size != null}<span>{formatBytes(pane.result.size)}</span>{/if}
            {#if pane.width != null && pane.height != null}<span>{pane.width} × {pane.height}</span>{/if}
            {#if pane.result.lfsOid}<span class="chip" title={pane.result.lfsOid}>Git LFS</span>{/if}
          </div>
        {/if}
        {#if pane.error}
          <p class="preview-message" role="alert">{pane.error} <button type="button" class="btn btn-sm" title={pane.downloading ? "正在下载" : "重新读取预览"} disabled={pane.downloading} onclick={() => retries[side]++}>重试</button></p>
        {/if}
        {#if pane.refreshing}
          <!-- 后台刷新：图片留在原位，状态挂在不占布局的位置，内容区尺寸不变。 -->
          <p class="preview-message inline" role="status"><span class="spinner"></span> 正在刷新这个版本…</p>
        {/if}
        {#if pane.result?.kind === "image" && pane.result.dataUrl}
          <!-- 已解码图片一直挂在原处：刷新、缩放与视图切换只改尺寸，不卸载再重排。 -->
          <div class="image-preview" class:original={zoom} data-side={side}>
            <img src={pane.result.dataUrl} alt={sideLabel(side) + "：" + source?.path} onload={(event) => imageLoaded(side, event)} onerror={() => imageError(side)} />
          </div>
        {:else if pane.result?.kind === "archive"}
          <div class="preview-toolbar"><Icon name="folder" size={14} /><span>压缩包目录 · {pane.result.entries.length}{pane.result.truncated ? "+" : ""} 项</span><div class="field sm archive-search"><Icon name="search" size={13} /><input aria-label={"筛选" + sideLabel(side) + "压缩包文件"} placeholder="筛选文件路径" bind:value={pane.query} oninput={() => { pane.scroll = 0; if (pane.listHost) pane.listHost.scrollTop = 0; }} onkeydown={(event) => { if (event.key === "Escape" && pane.query) { event.preventDefault(); event.stopPropagation(); pane.query = ""; pane.scroll = 0; if (pane.listHost) pane.listHost.scrollTop = 0; } }} />{#if pane.query}<button type="button" class="field-clear" aria-label="清空压缩包筛选" onclick={() => { pane.query = ""; pane.scroll = 0; if (pane.listHost) pane.listHost.scrollTop = 0; }}><Icon name="x" size={12} /></button>{/if}</div></div>
          <div class="archive-list" role="list" aria-label={sideLabel(side) + "压缩包文件"} bind:this={pane.listHost} bind:clientHeight={pane.viewport} onscroll={(event) => (pane.scroll = event.currentTarget.scrollTop)}>
            <div style={"height:" + range.start * 30 + "px"} aria-hidden="true"></div>
            {#each filtered.slice(range.start, range.end) as entry, i (range.start + i + ":" + entry.name)}
              <div class="archive-entry" role="listitem" title={entry.name}><Icon name={entry.directory ? "folder" : "file"} size={14} /><span>{entry.name}</span><small>{entry.directory ? "目录" : formatBytes(entry.size)}</small></div>
            {/each}
            <div style={"height:" + (filtered.length - range.end) * 30 + "px"} aria-hidden="true"></div>
            {#if !filtered.length}<p class="preview-message">没有匹配的文件</p>{/if}
          </div>
          {#if pane.result.message}<p class="preview-message">{pane.result.message}</p>{/if}
        {:else if pane.loading || pane.refreshing}
          <!-- 首帧占位与图片区同形同高：读完换成图片时不改变内容区尺寸，不是空框闪一下再撑开。 -->
          <div class="image-preview placeholder" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <p>{pane.refreshing ? "正在刷新这个版本…" : "正在读取预览"}</p>
          </div>
        {:else if !pane.error}
          <div class="preview-message" role="status">
            <Icon name="file" size={28} />
            <p>{pane.result?.message ?? "此版本中没有文件。"}</p>
            {#if pane.result?.canDownload}<button type="button" class="btn btn-primary" title={disabled || pane.downloading ? "正在读取或写入，请稍后" : "下载当前文件到本地 LFS 缓存"} disabled={disabled || pane.downloading} onclick={() => void download(side)}>{pane.downloading ? "正在下载 LFS 内容…" : "下载 LFS 内容并预览"}</button>{/if}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</section>

<style>
  .binary-preview { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; outline-offset: -2px; }
  .preview-panes { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; }
  .preview-panes.comparing { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .preview-pane { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .preview-pane + .preview-pane { border-left: 1px solid var(--border); }
  .preview-toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-shrink: 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .preview-note { margin: 0; padding: 8px 14px; flex-shrink: 0; color: var(--fg-muted); font-size: 12px; border-bottom: 1px solid var(--border); }
  .pane-heading { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .pane-heading span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); }
  .pane-meta { display: flex; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--border); color: var(--fg-muted); font-size: 12px; }
  .archive-search { min-width: 100px; max-width: 220px; margin-left: auto; flex: 1; }
  .preview-message { padding: 24px; text-align: center; color: var(--fg-muted); }
  /* 读取/刷新状态浮在内容之上：出现与消失都不改变内容区尺寸。 */
  .preview-message.inline { position: absolute; top: 8px; right: 10px; z-index: 2; display: flex; align-items: center; gap: 6px; margin: 0; padding: 3px 9px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); font-size: var(--text-xs); }
  .image-preview { flex: 1; min-height: 120px; overflow: auto; padding: 20px; text-align: center; background: repeating-conic-gradient(var(--surface-3) 0% 25%, var(--surface) 0% 50%) 0 / 20px 20px; }
  .image-preview.placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; font-size: var(--text-xs); color: var(--fg-muted); }
  .image-preview.placeholder p { margin: 0; }
  .image-preview img { max-width: 100%; max-height: 60vh; object-fit: contain; }
  .image-preview.original img { max-width: none; max-height: none; }
  .archive-list { flex: 1; min-height: 120px; overflow: auto; }
  .archive-entry { display: flex; gap: 8px; align-items: center; height: 30px; padding: 0 14px; font-size: 12px; }
  .archive-entry span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive-entry small { flex-shrink: 0; color: var(--fg-muted); }
  @media (max-width: 700px) { .preview-panes.comparing { grid-template-columns: minmax(0, 1fr); overflow: auto; } .preview-pane { min-height: 280px; } .preview-pane + .preview-pane { border-left: 0; border-top: 1px solid var(--border); } }
</style>