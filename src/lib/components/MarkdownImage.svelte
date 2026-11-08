<script lang="ts">
  import { untrack } from "svelte";
  import { markdownLinkKind, safeImageDataUrl } from "../markdown/links";
  import type { MarkdownImageLoader } from "../markdown/types";
  import Icon from "./Icon.svelte";

  let { href, alt, title = null, documentKey, active = true, onLoadImage }: {
    href: string;
    alt: string;
    title?: string | null;
    documentKey: string;
    active?: boolean;
    onLoadImage?: MarkdownImageLoader;
  } = $props();
  let visible = $state(false);
  let dataUrl = $state<string | null>(null);
  let loading = $state(false);
  let error = $state("");
  let controller: AbortController | null = null;
  let serial = 0;
  let attempted = false;
  let identityKey: string | null = null;
  let identityHref = "";
  let kind = $derived(markdownLinkKind(href));

  function observe(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") { visible = true; return; }
    const observer = new IntersectionObserver((entries) => { visible = entries.some((entry) => entry.isIntersecting); }, { rootMargin: "200px" });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  function cancel() {
    serial += 1;
    if (controller) attempted = false;
    controller?.abort();
    controller = null;
    loading = false;
  }

  async function load() {
    if (!active || !onLoadImage || (kind !== "local" && kind !== "remote")) return;
    cancel();
    const request = ++serial;
    const identity = documentKey;
    const target = href;
    const abort = new AbortController();
    controller = abort;
    attempted = true;
    loading = true;
    error = "";
    try {
      const result = await onLoadImage(target, abort.signal);
      if (abort.signal.aborted || request !== serial || identity !== documentKey || target !== href) return;
      dataUrl = safeImageDataUrl(result.dataUrl);
      if (!dataUrl) error = result.message || "图片不可用或格式不受支持。";
    } catch (failure) {
      if (abort.signal.aborted || request !== serial || identity !== documentKey || target !== href) return;
      error = failure instanceof Error ? failure.message : "图片加载失败。";
    } finally {
      if (request === serial) { loading = false; controller = null; }
    }
  }

  $effect(() => {
    const key = documentKey;
    const target = href;
    untrack(() => {
      if (identityKey === key && identityHref === target) return;
      identityKey = key;
      identityHref = target;
      cancel();
      attempted = false;
      dataUrl = null;
      error = "";
    });
  });
  $effect(() => {
    const canRead = active && visible;
    const local = kind === "local";
    void documentKey;
    void href;
    void onLoadImage;
    untrack(() => { if (canRead && local && !dataUrl && !attempted) void load(); });
    return () => untrack(cancel);
  });
</script>

<span class="md-image" use:observe>
  {#if dataUrl}
    <img src={dataUrl} {alt} title={title ?? undefined} loading="lazy" onerror={() => { dataUrl = null; error = "图片无法解码。"; }} />
  {:else}
    <span class="md-image-placeholder">
      <Icon name="file" size={18} />
      <span class="md-image-label">{alt || "图片"}</span>
      <span class="md-image-path">{href}</span>
      {#if kind === "blocked" || kind === "anchor"}
        <span class="md-note">不支持此图片地址。</span>
      {:else if loading}
        <span class="md-note" role="status">正在读取图片…</span>
      {:else}
        {#if error}<span class="md-note" role="status">{error}</span>
        {:else if kind === "remote"}<span class="md-note">远程图片尚未加载</span>
        {:else if !onLoadImage}<span class="md-note">当前阅读入口不支持图片加载。</span>{/if}
        {#if onLoadImage}
          <button type="button" class="md-small-button" disabled={!active} title={active ? undefined : "文档未显示，无法加载图片"} onclick={load}>{error ? "重试图片" : "加载图片"}</button>
        {/if}
      {/if}
    </span>
  {/if}
</span>
