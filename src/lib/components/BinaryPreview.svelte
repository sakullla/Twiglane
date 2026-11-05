<script lang="ts">
  import { api } from "../api";
  import { previewReads } from "../preview-reads";
  import { normalizeError } from "../errors";
  import type { FilePreview, PreviewSources } from "../types";
  import { formatBytes } from "../ui";
  import { visibleRange } from "../layout";
  import Icon from "./Icon.svelte";

  let { sources, generation, disabled, onGeneration }: {
    sources: PreviewSources; generation: number; disabled: boolean;
    onGeneration?: (generation: number) => void;
  } = $props();
  let side = $state<"old" | "new">("new");
  let result = $state.raw<FilePreview | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let downloading = $state(false);
  let zoom = $state(false);
  let query = $state("");
  let scroll = $state(0);
  let viewport = $state(0);
  let listHost = $state<HTMLDivElement>();
  let retry = $state(0);
  let version = 0;
  let serial = 0;
  let selected = $derived(sources[side]);
  let entries = $derived((result?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())));
  let range = $derived(visibleRange(entries.length, scroll, viewport || 400, 30));

  $effect(() => {
    const source = selected;
    const path = sources.repository;
    const current = generation;
    retry;
    const token = ++serial;
    const controller = new AbortController();
    version = current;
    result = null; error = null; zoom = false; query = ""; scroll = 0;
    loading = !!source;
    if (source) {
      void previewReads.run(async () => {
        try {
          return await api.filePreview(path, source, current);
        } catch (failure) {
          const normalized = normalizeError(failure);
          if (normalized.code !== "stale" || normalized.generation === undefined || controller.signal.aborted) throw failure;
          return api.filePreview(path, source, normalized.generation);
        }
      }, controller.signal).then((value) => {
        if (serial !== token) return;
        result = value;
        version = value.generation;
        if (value.generation !== current) onGeneration?.(value.generation);
        // Deleted files open on their previous version automatically.
        if (value.kind === "missing" && side === "new" && sources.old) side = "old";
      }).catch((failure) => {
        if (serial === token) error = normalizeError(failure).message;
      }).finally(() => { if (serial === token) loading = false; });
    }
    return () => { serial++; controller.abort(); };
  });

  async function download() {
    if (!selected || downloading || disabled || !result?.canDownload) return;
    const token = serial;
    const source = selected;
    const path = sources.repository;
    downloading = true; error = null;
    try {
      const value = await api.filePreview(path, source, version, true);
      if (token !== serial) return;
      version = value.generation;
      result = value;
      onGeneration?.(value.generation);
    } catch (failure) {
      if (token !== serial) return;
      const normalized = normalizeError(failure);
      error = normalized.message;
      if (normalized.generation !== undefined) {
        version = normalized.generation;
        onGeneration?.(normalized.generation);
      }
    } finally { downloading = false; }
  }
</script>

<section class="binary-preview" aria-label="文件内容预览">
  <div class="preview-toolbar">
    <div class="segmented" role="group" aria-label="预览版本">
      <button type="button" aria-pressed={side === "old"} title={downloading ? "正在下载" : !sources.old ? "此版本不存在" : "预览改动前的文件"} disabled={downloading || !sources.old} onclick={() => (side = "old")}>改动前</button>
      <button type="button" aria-pressed={side === "new"} title={downloading ? "正在下载" : !sources.new ? "此版本不存在" : "预览改动后的文件"} disabled={downloading || !sources.new} onclick={() => (side = "new")}>改动后</button>
    </div>
    {#if result?.size != null}<span>{formatBytes(result.size)}</span>{/if}
    {#if result?.lfsOid}<span class="badge" title={result.lfsOid}>Git LFS</span>{/if}
    <span class="spacer"></span>
    {#if result?.kind === "image"}
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => (zoom = !zoom)}>{zoom ? "适应窗口" : "原始大小"}</button>
    {/if}
  </div>
  {#if error}
    <p class="preview-message" role="alert">{error} <button type="button" class="btn btn-sm" title={downloading ? "正在下载" : "重新读取预览"} disabled={downloading} onclick={() => retry++}>重试</button></p>
  {/if}
  {#if loading}
    <p class="preview-message" role="status"><span class="spinner"></span> 正在读取预览</p>
  {:else if result?.kind === "image" && result.dataUrl}
    <div class="image-preview" class:original={zoom}>
      <img src={result.dataUrl} alt={`${side === "old" ? "改动前" : "改动后"}：${selected?.path}`} onerror={() => (error = "图片损坏或当前系统不支持此图片格式。")} />
    </div>
  {:else if result?.kind === "archive"}
    <div class="preview-toolbar"><Icon name="folder" size={14} /><span>压缩包目录 · {result.entries.length}{result.truncated ? "+" : ""} 项</span><div class="field sm archive-search"><Icon name="search" size={13} /><input aria-label="筛选压缩包文件" placeholder="筛选文件路径" bind:value={query} oninput={() => { scroll = 0; if (listHost) listHost.scrollTop = 0; }} /></div></div>
    <div class="archive-list" role="list" aria-label="压缩包文件" bind:this={listHost} bind:clientHeight={viewport} onscroll={(event) => (scroll = event.currentTarget.scrollTop)}>
      <div style={`height:${range.start * 30}px`} aria-hidden="true"></div>
      {#each entries.slice(range.start, range.end) as entry, i (`${range.start + i}:${entry.name}`)}
        <div class="archive-entry" role="listitem" title={entry.name}><Icon name={entry.directory ? "folder" : "file"} size={14} /><span>{entry.name}</span><small>{entry.directory ? "目录" : formatBytes(entry.size)}</small></div>
      {/each}
      <div style={`height:${(entries.length - range.end) * 30}px`} aria-hidden="true"></div>
      {#if !entries.length}<p class="preview-message">没有匹配的文件</p>{/if}
    </div>
    {#if result.message}<p class="preview-message">{result.message}</p>{/if}
  {:else}
    <div class="preview-message" role="status">
      <Icon name="file" size={28} />
      <p>{result?.message ?? "此版本中没有文件。"}</p>
      {#if result?.canDownload}<button type="button" class="btn btn-primary" title={disabled || downloading ? "正在读取或写入，请稍后" : "下载当前文件到本地 LFS 缓存"} disabled={disabled || downloading} onclick={() => void download()}>{downloading ? "正在下载 LFS 内容…" : "下载 LFS 内容并预览"}</button>{/if}
    </div>
  {/if}
</section>

<style>
  .binary-preview { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
  .preview-toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-shrink: 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .archive-search { min-width: 100px; max-width: 220px; margin-left: auto; flex: 1; }
  .preview-message { padding: 24px; text-align: center; color: var(--fg-muted); }
  .image-preview { flex: 1; min-height: 120px; overflow: auto; padding: 20px; text-align: center; background: repeating-conic-gradient(var(--surface-3) 0% 25%, var(--surface) 0% 50%) 0 / 20px 20px; }
  .image-preview img { max-width: 100%; max-height: 60vh; object-fit: contain; }
  .image-preview.original img { max-width: none; max-height: none; }
  .archive-list { flex: 1; min-height: 120px; overflow: auto; }
  .archive-entry { display: flex; gap: 8px; align-items: center; height: 30px; padding: 0 14px; font-size: 12px; }
  .archive-entry span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive-entry small { flex-shrink: 0; color: var(--fg-muted); }
</style>
