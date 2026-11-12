<script lang="ts">
  import { tick, untrack } from "svelte";
  import { parseMarkdown } from "../markdown/client";
  import { decodeAnchor } from "../markdown/links";
  import type { MarkdownCallbacks, MarkdownDocument, MarkdownPosition } from "../markdown/types";
  import MarkdownNodes from "./MarkdownNodes.svelte";
  import Icon from "./Icon.svelte";
  import "../../styles/markdown.css";

  interface Props extends MarkdownCallbacks {
    text: string;
    /** 包含仓库、revision、路径及内容版本；更换身份使在途读取失效。 */
    documentKey: string;
    active?: boolean;
    anchor?: string | null;
    navigationSerial?: number;
    /** 仅在文档/导航序号变化及重新激活时恢复，不追踪滚动回调后的回写。 */
    scrollTop?: number;
    onPosition?: (position: MarkdownPosition) => void;
    onSource?: () => void;
    onError?: (message: string | null) => void;
    /** 目录是否展开；宿主把切换放进自己的工具条时双向绑定。 */
    outlineOpen?: boolean;
    /**
     * 是否在正文上方画自己的阅读工具行（目录切换）。宿主已有工具条时传 false，
     * 由宿主根据 onHeadings 上报的标题数决定是否给出目录入口，避免多叠一行。
     */
    showTools?: boolean;
    onHeadings?: (count: number) => void;
  }

  let {
    text,
    documentKey,
    active = true,
    anchor = null,
    navigationSerial = 0,
    scrollTop = 0,
    onPosition,
    onLink,
    onLoadImage,
    onSource,
    onError,
    outlineOpen = $bindable(false),
    showTools = true,
    onHeadings,
  }: Props = $props();
  const prefix = $props.id();
  const BATCH = 48;
  let document = $state.raw<MarkdownDocument | null>(null);
  let parsedKey = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let note = $state("");
  let headingCount = $derived(document?.headings.length ?? 0);
  $effect(() => {
    const count = headingCount;
    untrack(() => onHeadings?.(count));
  });
  /* 卸载（切到源码、换成状态页）时标题数归零，宿主工具条上的目录入口随之消失。 */
  $effect(() => () => untrack(() => onHeadings?.(0)));
  /* 没有标题的文档没有目录可开：别让一个空的侧栏留在那里。 */
  $effect(() => {
    if (document && headingCount === 0 && outlineOpen) outlineOpen = false;
  });
  let rendered = $state(BATCH);
  let currentAnchor = $state<string | null>(null);
  let scroller = $state<HTMLDivElement | null>(null);
  let serial = 0;
  let navigation = 0;
  let restoring = false;
  let anchorTop: number | null = null;
  let previousText: string | null = null;
  let previousKey = "";
  let restoredDocument: MarkdownDocument | null = null;
  let restoredNavigation = -1;
  let previouslyActive = false;

  $effect(() => {
    const source = text;
    const key = documentKey;
    const enabled = active;
    return untrack(() => {
      if (enabled && previousText === source && previousKey === key && document) return;
      const request = ++serial;
      navigation += 1;
      restoring = false;
      if (!enabled) { loading = false; return; }
      document = null;
      parsedKey = "";
      loading = true;
      error = null;
      note = "";
      currentAnchor = null;
      rendered = BATCH;
      onError?.(null);
      const cancel = parseMarkdown(source, (result) => {
        if (request !== serial || key !== documentKey || !active) return;
        loading = false;
        if (result.ok) {
          document = result.document;
          parsedKey = key;
          previousText = source;
          previousKey = key;
        } else {
          error = result.message;
          onError?.(result.message);
        }
      });
      return cancel;
    });
  });

  function publish() {
    if (!restoring && active && parsedKey === documentKey && scroller) onPosition?.({ scrollTop: scroller.scrollTop, anchor: currentAnchor });
  }

  function scrolled() {
    if (scroller && anchorTop !== null && Math.abs(scroller.scrollTop - anchorTop) > 1) currentAnchor = null;
    publish();
  }

  async function showThrough(block: number, operation: number): Promise<boolean> {
    while (document && rendered <= block) {
      if (operation !== navigation || !active || parsedKey !== documentKey) return false;
      rendered = Math.min(document.blocks.length, rendered + BATCH);
      await tick();
      // 大目录定位也分批挂载，让取消和切换能被处理。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return operation === navigation && active && parsedKey === documentKey;
  }

  async function locate(value: string, operation: number, focus: boolean): Promise<boolean> {
    const id = decodeAnchor(value);
    if (id === "") {
      if (scroller) scroller.scrollTop = 0;
      currentAnchor = null;
      anchorTop = 0;
      note = "";
      return true;
    }
    // 文档尚未解析完时不判定“缺失”：交给解析完成后的 anchor 定位，别把等待显示成错误。
    if (!document || parsedKey !== documentKey) return false;
    const target = id === null ? undefined : document.headings.find((heading) => heading.id === id);
    if (!target) { note = "文档中没有找到这个标题位置。"; return false; }
    if (!await showThrough(target.block, operation)) return false;
    await tick();
    const heading = Array.from(scroller?.querySelectorAll<HTMLElement>("[data-markdown-anchor]") ?? [])
      .find((element) => element.dataset.markdownAnchor === id);
    if (!heading || !scroller || operation !== navigation) return false;
    scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20;
    currentAnchor = target.id;
    anchorTop = scroller.scrollTop;
    note = "";
    if (focus) heading.focus({ preventScroll: true });
    return true;
  }

  /** 外部导航使用此方法或 anchor + navigationSerial；返回 false 表示缺失或文档尚未就绪。 */
  export async function scrollToAnchor(value: string): Promise<boolean> {
    const operation = ++navigation;
    restoring = false;
    const found = await locate(value, operation, true);
    if (operation === navigation) publish();
    return found;
  }

  export function position(): MarkdownPosition {
    return { scrollTop: scroller?.scrollTop ?? 0, anchor: currentAnchor };
  }

  $effect(() => {
    const parsed = document;
    const key = documentKey;
    const enabled = active;
    const navigationId = navigationSerial;
    void parsedKey;
    if (!enabled) { previouslyActive = false; return; }
    if (!parsed || parsedKey !== key) return;
    untrack(() => {
      if (previouslyActive && restoredDocument === parsed && restoredNavigation === navigationId) return;
      previouslyActive = true;
      restoredDocument = parsed;
      restoredNavigation = navigationId;
      const operation = ++navigation;
      const targetAnchor = anchor;
      const targetTop = Math.max(0, scrollTop);
      restoring = true;
      void (async () => {
        await tick();
        if (operation !== navigation || !scroller) return;
        if (targetAnchor !== null) {
          await locate(targetAnchor, operation, false);
        } else {
          while (scroller && document && rendered < document.blocks.length && scroller.scrollHeight - scroller.clientHeight < targetTop) {
            if (!await showThrough(rendered, operation)) return;
          }
          if (operation === navigation && scroller) {
            scroller.scrollTop = targetTop;
            currentAnchor = null;
            anchorTop = null;
          }
        }
      })().finally(() => { if (operation === navigation) restoring = false; });
    });
  });

  async function follow(href: string) {
    note = "";
    if (href.startsWith("#")) { await scrollToAnchor(href); return; }
    if (!onLink) { note = "当前阅读入口不支持跳转此链接。"; return; }
    const key = documentKey;
    try { await onLink(href); }
    catch (failure) { if (key === documentKey) note = failure instanceof Error ? failure.message : "链接无法打开。"; }
  }

  async function more() {
    if (!document) return;
    rendered = Math.min(document.blocks.length, rendered + BATCH);
    await tick();
  }

  function continueWhenVisible(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (active && entries.some((entry) => entry.isIntersecting)) void more();
    }, { root: scroller, rootMargin: "400px" });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<section class="markdown-preview" aria-label="Markdown 预览" aria-busy={loading} inert={!active}>
  {#if loading}
    <div class="md-empty" role="status"><span class="spinner" aria-hidden="true"></span><span>正在排版文档…</span></div>
  {:else if error}
    <div class="md-empty" role="alert"><Icon name="alert-circle" size={24} /><p>{error}</p>{#if onSource}<button type="button" class="btn btn-secondary" onclick={onSource}>查看源码</button>{/if}</div>
  {:else if document}
    {#if showTools && document.headings.length > 0}
      <!-- 只有带标题的文档才有目录可看；没有标题时不占一整行。 -->
      <div class="md-reading-tools">
        <button type="button" class="md-small-button" aria-expanded={outlineOpen} aria-controls={`${prefix}-outline`} title={`${document.headings.length} 个标题`} onclick={() => (outlineOpen = !outlineOpen)}><Icon name="list" size={14} />{outlineOpen ? "收起目录" : "目录"}</button>
      </div>
    {/if}
    {#if note}<div class="md-message" role="status">{note}</div>{/if}
    <div class="md-reading-layout" class:with-outline={outlineOpen}>
      {#if outlineOpen}
        <nav class="md-outline" id={`${prefix}-outline`} aria-label="文档目录">
          {#each document.headings as heading}
            <button type="button" style:padding-left={`${12 + (heading.depth - 1) * 12}px`} aria-current={currentAnchor === heading.id ? "location" : undefined} title={heading.text} onclick={() => scrollToAnchor(heading.id)}>{heading.text || "未命名标题"}</button>
          {/each}
        </nav>
      {/if}
      <!-- 正文区本身是键盘可达的滚动区域：长文可用方向键/PageUp/Down 阅读。 -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="md-scroll" role="region" aria-label="文档正文" tabindex="0" data-select-scope bind:this={scroller} onscroll={scrolled}>
        {#if document.blocks.length === 0 && !document.frontmatter}
          <div class="md-empty"><p>这是一个空文档。</p>{#if onSource}<button type="button" class="md-small-button" onclick={onSource}>查看源码</button>{/if}</div>
        {:else}
          <article class="md-body" id={`${prefix}-document`}>
            {#if document.frontmatter}
              {@const meta = document.frontmatter}
              <!-- 文件头属性：键值表，不再被当成分隔线 + 段落 + 标题排进正文。 -->
              <details class="md-frontmatter" open>
                <summary><Icon name="chevron-right" size={12} /><span>文件头属性</span><span class="md-frontmatter-count">{meta.fields.length}</span></summary>
                {#each meta.comments as comment}
                  <p class="md-frontmatter-note">{comment}</p>
                {/each}
                {#if meta.fields.length > 0}
                  <dl>
                    {#each meta.fields as field}
                      <div class="md-frontmatter-row">
                        <dt>{field.key}</dt>
                        <dd class:block={field.block}>{#if field.value === ""}<span class="md-frontmatter-empty">空</span>{:else}{field.value}{/if}</dd>
                      </div>
                    {/each}
                  </dl>
                {/if}
              </details>
            {/if}
            {#each document.blocks.slice(0, rendered) as block, index (`${documentKey}:${index}`)}
              <div class="md-block"><MarkdownNodes nodes={[block]} {documentKey} {active} {prefix} onLink={follow} {onLoadImage} /></div>
            {/each}
            {#if rendered < document.blocks.length}
              {#key rendered}<div class="md-continue" use:continueWhenVisible><button type="button" class="md-small-button" onclick={more}>继续阅读</button><span class="md-note">后续段落按需显示</span></div>{/key}
            {/if}
          </article>
        {/if}
      </div>
    </div>
  {/if}
</section>
