<script lang="ts">
  import type { Snippet } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import { summaryLength } from "../ui";
  import Icon from "./Icon.svelte";

  /**
   * 提交区（R5）：整块高度不超过 200px，正文只留一行以内的说明。
   * 变更范围改成「计数按钮」打开提交范围 modal，低频动作（撤销提交、放弃修改）
   * 收进右上角的溢出菜单，不再直接占位。
   */
  interface Props {
    branch: string;
    scope: string;
    paths: string[];
    value: string;
    disabled: boolean;
    busy?: string | null;
    /**
     * 上一次提交失败的原因（R5）：缺身份、钩子拒绝、索引锁或过期都走这里。
     * 与右下角通知条同源，但提交区里必须也留一份可见文本，通知条不能是唯一渠道。
     */
    error?: string | null;
    onInput: (value: string) => void;
    onBlur: () => void;
    onCommit: () => void;
    onCommitPush?: () => void;
    /** 打开「本次提交范围」modal。 */
    onScope?: () => void;
    /** 溢出菜单内容：撤销提交与放弃修改由外壳注入。 */
    overflow?: Snippet;
  }

  let { branch, scope, paths, value, disabled, busy = null, error = null, onInput, onBlur, onCommit, onCommitPush, onScope, overflow }: Props =
    $props();

  let firstLine = $derived(summaryLength(value));
  let moreOpen = $state(false);
  let moreAnchor = $state<HTMLDivElement | null>(null);
  let ready = $derived(value.trim().length > 0 && paths.length > 0 && !disabled);
  let blocker = $derived(
    paths.length === 0 ? "先暂存要提交的文件" : value.trim().length === 0 ? "填写提交说明后即可提交" : "",
  );

  $effect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (moreAnchor && !moreAnchor.contains(event.target as Node)) moreOpen = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") moreOpen = false;
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });
</script>

<section class="composer compact" aria-label="本地提交">
  <div class="composer-head">
    <span class="composer-head-icon"><Icon name="commit" size={15} /></span>
    <div class="composer-heading">
      <span>创建提交</span>
      <strong title={`目标是 ${branch}`}>{scope}</strong>
    </div>
    <span class="spacer"></span>
    {#if onScope}
      <button
        type="button"
        class="btn btn-ghost btn-sm composer-scope"
        aria-label={`本次提交范围：${paths.length} 个已暂存文件`}
        title="查看本次提交范围"
        onclick={onScope}
      >
        <Icon name="layers" size={13} /><span class="count">{paths.length}</span>
      </button>
    {/if}
    {#if overflow}
      <div class="menu-anchor" bind:this={moreAnchor}>
        <button
          type="button"
          class="icon-btn sm composer-more"
          aria-label="更多提交操作"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title="更多：撤销提交与放弃修改"
          onclick={() => (moreOpen = !moreOpen)}
        >
          <Icon name="more" size={15} />
        </button>
        {#if moreOpen}
          <div class="menu composer-more-menu" role="menu" aria-label="更多提交操作">
            {@render overflow()}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  <div class="composer-box">
    <textarea
      aria-label="提交说明草稿"
      placeholder={"提交说明：第一行写摘要"}
      {value}
      disabled={disabled}
      oninput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
      onblur={onBlur}
    ></textarea>
    <div class="composer-meta">
      <span class:over={firstLine > 72} title="摘要建议不超过 72 个字符">摘要 {firstLine}/72</span>
      <span class="spacer"></span>
      {#if blocker}
        <!-- R5：主按钮不可用时就地给出可见的一行原因，不只挂在 title 上。
             与「草稿自动保存」二选一，并用 .truncate 保持单行：
             窄文件列表（最小 160px）里折行会把提交区顶过 R5 的 200px 上限。 -->
        <span class="hint truncate" data-commit-blocker title={blocker}>{blocker}</span>
      {:else if error}
        <!-- R5：提交失败（缺身份 / 钩子拒绝 / 索引锁 / 过期）同样在这块就地说明。
             优先级低于 blocker：按钮又变成灰的时候，「为什么点不动」比上次为什么失败更要紧。
             完整原因留在 title 里，可见文本用 .truncate 保住单行与 200px 上限。 -->
        <span class="hint truncate composer-error" data-commit-error title={error}>{error}</span>
      {:else}
        <span title="输入停止后自动保存为草稿">草稿自动保存</span>
      {/if}
    </div>
  </div>
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
</section>
