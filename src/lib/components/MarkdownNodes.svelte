<script lang="ts">
  import type { MarkdownCallbacks, MarkdownNode } from "../markdown/types";
  import { markdownLinkKind } from "../markdown/links";
  import MarkdownNodes from "./MarkdownNodes.svelte";
  import MarkdownCode from "./MarkdownCode.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";

  let { nodes, documentKey, active = true, prefix, onLink, onLoadImage }: MarkdownCallbacks & {
    nodes: MarkdownNode[];
    documentKey: string;
    prefix: string;
    active?: boolean;
  } = $props();
</script>

{#snippet children(content: MarkdownNode[])}
  <MarkdownNodes nodes={content} {documentKey} {active} {prefix} {onLink} {onLoadImage} />
{/snippet}

{#each nodes as node}
  {#if node.kind === "text"}{node.text}
  {:else if node.kind === "raw"}<span class="md-raw">{node.text}</span>
  {:else if node.kind === "codespan"}<code>{node.text}</code>
  {:else if node.kind === "paragraph"}<p>{@render children(node.children)}</p>
  {:else if node.kind === "strong"}<strong>{@render children(node.children)}</strong>
  {:else if node.kind === "em"}<em>{@render children(node.children)}</em>
  {:else if node.kind === "del"}<del>{@render children(node.children)}</del>
  {:else if node.kind === "blockquote"}<blockquote>{@render children(node.children)}</blockquote>
  {:else if node.kind === "heading"}
    <svelte:element this={`h${node.depth}`} id={`${prefix}-${node.id}`} data-markdown-anchor={node.id} tabindex="-1">{@render children(node.children)}</svelte:element>
  {:else if node.kind === "br"}<br />
  {:else if node.kind === "hr"}<hr />
  {:else if node.kind === "code"}<MarkdownCode text={node.text} language={node.language} {active} />
  {:else if node.kind === "link"}
    {#if markdownLinkKind(node.href) === "blocked"}
      <span class="md-blocked-link" title="不支持此链接地址">{@render children(node.children)}<span class="md-link-reason">（不支持的链接）</span></span>
    {:else}
      <a href={`#${prefix}-document`} title={node.title ?? node.href} onclick={(event) => { event.preventDefault(); if (active) void onLink?.(node.href); }}>{@render children(node.children)}</a>
    {/if}
  {:else if node.kind === "image"}
    <MarkdownImage href={node.href} alt={node.text} title={node.title} {documentKey} {active} {onLoadImage} />
  {:else if node.kind === "list"}
    <svelte:element this={node.ordered ? "ol" : "ul"} start={node.ordered ? node.start : undefined}>
      {#each node.items as item}
        <li class:md-task={item.task}>
          {#if item.task}<input type="checkbox" disabled checked={item.checked} aria-label={item.checked ? "已完成任务（只读）" : "未完成任务（只读）"} />{/if}
          {@render children(item.children)}
        </li>
      {/each}
    </svelte:element>
  {:else if node.kind === "table"}
    <!-- 可聚焦的滚动区域使键盘用户能读到宽表格右侧；内容本身仍是语义化 table。 -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="md-table-scroll" tabindex="0" role="region" aria-label="文档表格">
      <table>
        <thead><tr>{#each node.header as cell, index}<th style:text-align={node.align[index] ?? "left"}>{@render children(cell)}</th>{/each}</tr></thead>
        <tbody>{#each node.rows as row}<tr>{#each row as cell, index}<td style:text-align={node.align[index] ?? "left"}>{@render children(cell)}</td>{/each}</tr>{/each}</tbody>
      </table>
    </div>
  {/if}
{/each}
