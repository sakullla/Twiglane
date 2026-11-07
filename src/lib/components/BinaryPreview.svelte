<script lang="ts">
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
    downloading: boolean;
    version: number;
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
    result: null, error: null, loading: false, downloading: false, version,
    width: null, height: null, query: "", scroll: 0, viewport: 0,
  });
  let mode = $state<Mode>("new");
  let panes = $state<Record<Side, Pane>>({ old: emptyPane(0), new: emptyPane(0) });
  let retries = $state<Record<Side, number>>({ old: 0, new: 0 });
  let zoom = $state(false);
  let serials: Record<Side, number> = { old: 0, new: 0 };
  let previousKey = "";
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

  function loadSide(side: Side, source: PreviewSources[Side], current: number) {
    const token = ++serials[side];
    const controller = new AbortController();
    const pane = panes[side];
    pane.result = null;
    pane.error = null;
    pane.loading = !!source;
    pane.downloading = false;
    pane.version = current;
    pane.width = null;
    pane.height = null;
    pane.query = "";
    pane.scroll = 0;
    if (!source) return () => { serials[side]++; controller.abort(); };
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
      if (serials[side] === token) pane.error = normalizeError(failure).message;
    }).finally(() => {
      if (serials[side] === token) pane.loading = false;
    });
    return () => { serials[side]++; controller.abort(); };
  }

  // retries 只用于让“重试”按钮重新发起读取，值本身不参与请求参数。
  // 直接把 loadSide 的 cleanup 交还给 effect：依赖变化重跑和组件卸载都会执行 serial++/abort，
  // 否则被取代或已卸载的读取会一直占着 previewReads 的两个槽位。
  $effect(() => {
    void retries.old;
    return loadSide("old", sources.old, generation);
  });
  $effect(() => {
    void retries.new;
    return loadSide("new", sources.new, generation);
  });
  $effect(() => {
    const key = JSON.stringify([sources.repository, sources.old, sources.new, generation]);
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
    panes[side].error = "图片损坏或当前系统不支持此图片格式。";
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
            {#if pane.result.lfsOid}<span class="badge" title={pane.result.lfsOid}>Git LFS</span>{/if}
          </div>
        {/if}
        {#if pane.error}
          <p class="preview-message" role="alert">{pane.error} <button type="button" class="btn btn-sm" title={pane.downloading ? "正在下载" : "重新读取预览"} disabled={pane.downloading} onclick={() => retries[side]++}>重试</button></p>
        {/if}
        {#if pane.loading}
          <p class="preview-message" role="status"><span class="spinner"></span> 正在读取预览</p>
        {:else if pane.result?.kind === "image" && pane.result.dataUrl && !pane.error}
          <div class="image-preview" class:original={zoom}>
            <img src={pane.result.dataUrl} alt={sideLabel(side) + "：" + source?.path} onload={(event) => imageLoaded(side, event)} onerror={() => imageError(side)} />
          </div>
        {:else if pane.result?.kind === "archive"}
          <div class="preview-toolbar"><Icon name="folder" size={14} /><span>压缩包目录 · {pane.result.entries.length}{pane.result.truncated ? "+" : ""} 项</span><div class="field sm archive-search"><Icon name="search" size={13} /><input aria-label={"筛选" + sideLabel(side) + "压缩包文件"} placeholder="筛选文件路径" bind:value={pane.query} oninput={() => { pane.scroll = 0; if (pane.listHost) pane.listHost.scrollTop = 0; }} /></div></div>
          <div class="archive-list" role="list" aria-label={sideLabel(side) + "压缩包文件"} bind:this={pane.listHost} bind:clientHeight={pane.viewport} onscroll={(event) => (pane.scroll = event.currentTarget.scrollTop)}>
            <div style={"height:" + range.start * 30 + "px"} aria-hidden="true"></div>
            {#each filtered.slice(range.start, range.end) as entry, i (range.start + i + ":" + entry.name)}
              <div class="archive-entry" role="listitem" title={entry.name}><Icon name={entry.directory ? "folder" : "file"} size={14} /><span>{entry.name}</span><small>{entry.directory ? "目录" : formatBytes(entry.size)}</small></div>
            {/each}
            <div style={"height:" + (filtered.length - range.end) * 30 + "px"} aria-hidden="true"></div>
            {#if !filtered.length}<p class="preview-message">没有匹配的文件</p>{/if}
          </div>
          {#if pane.result.message}<p class="preview-message">{pane.result.message}</p>{/if}
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
  .preview-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .preview-pane + .preview-pane { border-left: 1px solid var(--border); }
  .preview-toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-shrink: 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .preview-note { margin: 0; padding: 8px 14px; flex-shrink: 0; color: var(--fg-muted); font-size: 12px; border-bottom: 1px solid var(--border); }
  .pane-heading { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .pane-heading span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); }
  .pane-meta { display: flex; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--border); color: var(--fg-muted); font-size: 12px; }
  .archive-search { min-width: 100px; max-width: 220px; margin-left: auto; flex: 1; }
  .preview-message { padding: 24px; text-align: center; color: var(--fg-muted); }
  .image-preview { flex: 1; min-height: 120px; overflow: auto; padding: 20px; text-align: center; background: repeating-conic-gradient(var(--surface-3) 0% 25%, var(--surface) 0% 50%) 0 / 20px 20px; }
  .image-preview img { max-width: 100%; max-height: 60vh; object-fit: contain; }
  .image-preview.original img { max-width: none; max-height: none; }
  .archive-list { flex: 1; min-height: 120px; overflow: auto; }
  .archive-entry { display: flex; gap: 8px; align-items: center; height: 30px; padding: 0 14px; font-size: 12px; }
  .archive-entry span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive-entry small { flex-shrink: 0; color: var(--fg-muted); }
  @media (max-width: 700px) { .preview-panes.comparing { grid-template-columns: minmax(0, 1fr); overflow: auto; } .preview-pane { min-height: 280px; } .preview-pane + .preview-pane { border-left: 0; border-top: 1px solid var(--border); } }
</style>