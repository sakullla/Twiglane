<script lang="ts">
  import { createHighlight } from "../syntax/highlight.svelte";
  import { canonicalLanguage } from "../syntax/languages";
  import { lineSegments } from "../syntax/segments";
  import Icon from "./Icon.svelte";

  let { text, language, active = true }: { text: string; language: string; active?: boolean } = $props();
  let visible = $state(false);
  let copied = $state(false);
  let copyError = $state("");
  let lines = $derived(text.split("\n"));
  const syntax = createHighlight(() => ({ lang: active && visible ? canonicalLanguage(language) : null, lines }));

  function observe(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") {
      visible = true;
      return;
    }
    const observer = new IntersectionObserver((entries) => { visible = entries.some((entry) => entry.isIntersecting); }, { rootMargin: "200px" });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  $effect(() => { void text; copied = false; copyError = ""; });

  async function copy() {
    const content = text;
    try {
      await navigator.clipboard.writeText(content);
      if (content === text) { copied = true; copyError = ""; }
    } catch {
      if (content === text) copyError = "复制失败，可选择代码后复制。";
    }
  }
</script>

<div class="md-code" use:observe>
  <div class="md-code-tools">
    <span>{language || "纯文本"}</span>
    <button type="button" class="md-small-button" onclick={copy} aria-label={copied ? "代码已复制" : "复制代码"}>
      <Icon name={copied ? "check" : "copy"} size={13} />{copied ? "已复制" : "复制"}
    </button>
  </div>
  <!-- 可聚焦的代码滚动区域让键盘用户能查看长行和长代码块，不提供编辑。 -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre tabindex="0" role="region" aria-label="代码块"><code>{#each lines as line, index}{#each lineSegments(line, syntax.at(index)) as segment}<span class={segment.k}>{segment.t}</span>{/each}{index < lines.length - 1 ? "\n" : ""}{/each}</code></pre>
  {#if copyError}<span class="md-note" role="status">{copyError}</span>{/if}
</div>
