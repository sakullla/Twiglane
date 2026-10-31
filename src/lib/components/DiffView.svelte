<script lang="ts">
  import { classifyDiffLine, diffLines } from "../diff";
  import type { DiffResponse, FileSelection } from "../types";

  interface Props {
    selection: FileSelection | null;
    diff: DiffResponse | null;
    error: string | null;
    loading: boolean;
  }

  let { selection, diff, error, loading }: Props = $props();
  let lines = $derived(diff?.text ? diffLines(diff.text) : []);
</script>

<section class="diff" aria-label="差异详情">
  {#if error}
    <div class="empty" role="status">
      <strong>差异没有读取完成</strong>
      <p>{error}</p>
    </div>
  {:else if !selection}
    <div class="empty">
      <strong>未选择文件</strong>
      <p>从中间列表选择一个文件，在这里查看差异。方向键可以移动选择，焦点会保持可见。</p>
    </div>
  {:else if loading}
    <div class="empty" role="status" aria-busy="true">
      <strong>正在读取差异</strong>
      <p>{selection.path}</p>
    </div>
  {:else if diff?.binary}
    <div class="empty" role="status">
      <strong>二进制文件</strong>
      <p>{selection.path} 有变动，但不能按文本预览，因此这里不显示伪差异。</p>
    </div>
  {:else if !diff?.text}
    <div class="empty" role="status">
      <strong>没有文本差异</strong>
      <p>{selection.path} 当前这一侧没有可显示的文本差异。</p>
    </div>
  {:else}
    <div class="diff-body" role="textbox" aria-readonly="true" aria-multiline="true" tabindex="0" aria-label="差异文本">{#each lines as line, index (index)}<span class={`diff-line ${classifyDiffLine(line)}`}>{line.length === 0 ? " " : line}</span>{/each}</div>
  {/if}
</section>
