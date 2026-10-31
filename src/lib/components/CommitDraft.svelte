<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import { summaryLength } from "../ui";
  import Icon from "./Icon.svelte";

  interface Props {
    branch: string;
    scope: string;
    paths: string[];
    value: string;
    disabled: boolean;
    busy?: string | null;
    onInput: (value: string) => void;
    onBlur: () => void;
    onCommit: () => void;
    onCommitPush?: () => void;
  }
  let { branch, scope, paths, value, disabled, busy = null, onInput, onBlur, onCommit, onCommitPush }: Props = $props();
  let shown = $derived(paths.slice(0, 50));
  let ready = $derived(value.trim().length > 0 && paths.length > 0 && !disabled);
  let firstLine = $derived(summaryLength(value));
  let blocker = $derived(
    paths.length === 0 ? "先暂存要提交的文件" : value.trim().length === 0 ? "填写提交说明后即可提交" : "",
  );
</script>

<section class="composer" aria-label="本地提交">
  <div class="composer-head">
    <Icon name="commit" size={15} />
    <strong title={`目标是 ${branch}`}>{scope}</strong>
  </div>
  <div class="composer-box">
    <textarea
      aria-label="提交说明草稿"
      placeholder={"提交说明：第一行写摘要\n\n空一行后可以补充细节"}
      {value}
      disabled={disabled}
      oninput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
      onblur={onBlur}
    ></textarea>
    <div class="composer-meta">
      <span class:over={firstLine > 72} title="摘要建议不超过 72 个字符">摘要 {firstLine}/72</span>
      <span class="spacer"></span>
      <span>草稿自动保存</span>
    </div>
  </div>
  {#if paths.length === 0}
    <p class="hint">范围：暂存区是空的。</p>
  {:else}
    <details class="scope-details">
      <summary><Icon name="chevron-right" size={13} />查看本次提交的 {paths.length} 个文件</summary>
      <ul class="scope-list">
        {#each shown as path (path)}
          <li title={path}>{path}</li>
        {/each}
      </ul>
      {#if paths.length > shown.length}
        <p class="hint">另有 {paths.length - shown.length} 个已暂存文件。</p>
      {/if}
    </details>
  {/if}
  <div class="composer-actions">
    <button
      type="button"
      class="btn btn-primary"
      aria-label="提交到本地"
      title={blocker || `提交到本地（${MODIFIER_LABEL}+Enter）`}
      disabled={!ready}
      onclick={onCommit}
    >
      {#if busy === "commit"}<span class="spinner"></span>{:else}<Icon name="check" size={15} />{/if}
      提交到本地
      <kbd aria-hidden="true">{MODIFIER_LABEL} ↵</kbd>
    </button>
    <button
      type="button"
      class="btn btn-secondary"
      title={blocker || "先创建本地提交，再单独推送"}
      disabled={!ready || !onCommitPush}
      onclick={() => onCommitPush?.()}
    >
      {#if busy === "commit-push"}<span class="spinner"></span>{:else}<Icon name="arrow-up" size={15} />{/if}
      提交并推送
    </button>
  </div>
  <p class="hint">只创建本地提交，不会推送。「提交并推送」会先提交再单独推送，推送失败可以只重试推送。</p>
</section>
