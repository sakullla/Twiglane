<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";

  interface Props {
    branch: string;
    scope: string;
    paths: string[];
    value: string;
    disabled: boolean;
    onInput: (value: string) => void;
    onBlur: () => void;
    onCommit: () => void;
  }
  let { branch, scope, paths, value, disabled, onInput, onBlur, onCommit }: Props = $props();
  let shown = $derived(paths.slice(0, 8));
  let ready = $derived(value.trim().length > 0 && paths.length > 0 && !disabled);
</script>

<section class="commit" aria-label="本地提交">
  <strong>{scope}</strong>
  <p class="hint">目标是 {branch}。只创建本地提交，不会推送。</p>
  {#if paths.length === 0}
    <p class="hint">范围：暂存区是空的。</p>
  {:else}
    <ul class="scope-list">
      {#each shown as path (path)}
        <li title={path}>{path}</li>
      {/each}
    </ul>
    {#if paths.length > shown.length}
      <p class="hint">另有 {paths.length - shown.length} 个已暂存文件。</p>
    {/if}
  {/if}
  <textarea
    aria-label="提交说明草稿"
    placeholder="写下这次改动的说明"
    {value}
    disabled={disabled}
    oninput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
    onblur={onBlur}
  ></textarea>
  <div class="row">
    <button type="button" class="primary" disabled={!ready} onclick={onCommit}>提交到本地</button>
    <span class="hint">{MODIFIER_LABEL}+Enter</span>
  </div>
  <p class="hint">说明按仓库保存在本机应用数据中。失败时会保留说明和仍然有效的暂存。不会保存凭据，也不会自动推送。</p>
</section>
