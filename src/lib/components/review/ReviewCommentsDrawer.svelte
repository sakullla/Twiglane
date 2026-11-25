<script lang="ts">
  import { tick } from "svelte";
  import {
    anchorLabel,
    commentCopyText,
    sentCommentBody,
    type ReviewComment,
    type StaleCommentBatch,
  } from "../../review-comments.svelte";
  import Icon from "../Icon.svelte";
  import InlineCommentEditor from "./InlineCommentEditor.svelte";

  /**
   * 意见抽屉：当前批次按文件分组的结构化卡片（定位 / 编辑 / 删除 / 预览送回内容），
   * 下面是「已失效」分区——按批次说明原因，原正文、路径与行号只读展示，只能复制；
   * 失效意见不进入新批次、不重新定位，差异里也不再标出。
   */
  interface Props {
    comments: readonly ReviewComment[];
    stale?: readonly StaleCommentBatch[];
    /** 「在抽屉中定位」的目标：变化时滚到这张卡片并高亮。 */
    focusId?: string | null;
    /** 定位：在差异里打开这条意见所在行的线程。 */
    onLocate?: (comment: ReviewComment) => void;
    /**
     * 编辑不在抽屉里自存：正在编辑的意见、正文与错误都来自工作台唯一的草稿槽，
     * 收起抽屉、切换来源与关闭来源前的草稿确认因此能看到抽屉里的修改。
     */
    editingId?: string | null;
    editBody?: string;
    editDirty?: boolean;
    editError?: string | null;
    onBeginEdit?: (comment: ReviewComment) => void;
    onEditInput?: (value: string) => void;
    onSaveEdit?: () => void;
    onCancelEdit?: () => void;
    onDelete?: (comment: ReviewComment) => void;
    onCopy?: (text: string, label: string) => void;
  }

  let {
    comments,
    stale = [],
    focusId = null,
    onLocate,
    editingId = null,
    editBody = "",
    editDirty = false,
    editError = null,
    onBeginEdit,
    onEditInput,
    onSaveEdit,
    onCancelEdit,
    onDelete,
    onCopy,
  }: Props = $props();

  let host = $state<HTMLElement | null>(null);

  /** 按文件分组：组的顺序是文件第一次出现的顺序，组内按添加顺序。 */
  let groups = $derived.by(() => {
    const byPath = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const list = byPath.get(comment.anchor.path);
      if (list) list.push(comment);
      else byPath.set(comment.anchor.path, [comment]);
    }
    return [...byPath.entries()].map(([path, items]) => ({ path, items }));
  });
  let staleCount = $derived(stale.reduce((sum, batch) => sum + batch.comments.length, 0));

  $effect(() => {
    const id = focusId;
    const node = host;
    if (!id || !node) return;
    void tick().then(() => {
      const card = [...node.querySelectorAll<HTMLElement>("[data-comment-id]")].find((item) => item.dataset.commentId === id);
      card?.scrollIntoView?.({ block: "nearest" });
      card?.focus({ preventScroll: true });
    });
  });

  function copy(text: string, label: string): void {
    if (onCopy) {
      onCopy(text, label);
      return;
    }
    void navigator.clipboard?.writeText(text).catch(() => {});
  }

  function batchText(batch: StaleCommentBatch): string {
    return batch.comments.map(commentCopyText).join("\n\n");
  }
</script>

<div class="task-comments-panel review-drawer review-comments-drawer" aria-label="意见列表" bind:this={host}>
  <header class="review-drawer-head">
    <strong>意见</strong>
    <span class="review-drawer-count">{comments.length} 条 · {groups.length} 个文件</span>
  </header>
  {#if comments.length === 0}
    <p class="task-comment-note">还没有意见。点块标题上的「评论此块」一次说一整块，或用行尾气泡说某一行。</p>
  {:else}
    {#each groups as group (group.path)}
      <section class="review-comment-group" aria-label={`${group.path} 的意见`}>
        <h3 class="review-comment-group-head"><Icon name="file" size={12} /><span class="truncate" title={group.path}>{group.path}</span><span class="count">{group.items.length}</span></h3>
        {#each group.items as comment (comment.id)}
          <article
            class="task-comment review-comment-card"
            class:focused={focusId === comment.id}
            data-comment-id={comment.id}
            tabindex="-1"
          >
            <div class="task-comment-head">
              <span class="inline-comment-line">{anchorLabel(comment.anchor)}</span>
            </div>
            {#if comment.anchor.quote}<p class="task-comment-quote">{comment.anchor.quote}</p>{/if}
            {#if editingId === comment.id}
              <InlineCommentEditor
                anchor={comment.anchor}
                mode="edit"
                body={editBody}
                dirty={editDirty}
                error={editError}
                label={comment.anchor.path + " 的意见正文"}
                showQuote={false}
                onInput={(value) => onEditInput?.(value)}
                onSave={() => onSaveEdit?.()}
                onCancel={() => onCancelEdit?.()}
              />
            {:else}
              <p class="task-comment-body">{comment.body}</p>
              <div class="task-comment-actions">
                {#if onLocate}
                  <button type="button" class="btn btn-ghost btn-sm" title="在差异里打开这条意见所在的行" onclick={() => onLocate?.(comment)}>定位</button>
                {/if}
                {#if onBeginEdit}
                  <button type="button" class="btn btn-ghost btn-sm" title="修改这条意见" onclick={() => onBeginEdit?.(comment)}>编辑</button>
                {/if}
                {#if onDelete}
                  <button type="button" class="btn btn-ghost btn-sm" title="从这批意见里删掉" onclick={() => onDelete?.(comment)}>删除</button>
                {/if}
              </div>
              <details class="review-comment-sent">
                <summary>预览送回内容</summary>
                <div class="review-comment-sent-body">{sentCommentBody(comment)}</div>
              </details>
            {/if}
          </article>
        {/each}
      </section>
    {/each}
  {/if}

  {#if staleCount > 0}
    <section class="review-comment-stale" aria-label="已失效的意见">
      <h3 class="review-comment-group-head"><Icon name="alert" size={12} /><span>已失效 {staleCount} 条</span></h3>
      <p class="task-comment-note">这些意见只读：不会进入新批次，也不会重新定位到新行号。可以复制后按当前内容重写。</p>
      {#each stale as batch, index (index)}
        <div class="review-stale-batch" data-stale-batch={index}>
          <p class="review-stale-reason"><Icon name="info" size={12} /><span>{batch.reason}</span></p>
          <button type="button" class="btn btn-ghost btn-sm" title="复制这批失效意见的路径、行号与原正文" onclick={() => copy(batchText(batch), `${batch.comments.length} 条失效意见`)}><Icon name="copy" size={12} /><span>复制全部</span></button>
          {#each batch.comments as comment (comment.id)}
            <article class="task-comment review-comment-card stale" data-stale-comment-id={comment.id}>
              <div class="task-comment-head">
                <span class="task-comment-path">{comment.anchor.path}</span>
                <span>{anchorLabel(comment.anchor)}</span>
                <span class="review-stale-tag">已失效</span>
              </div>
              {#if comment.anchor.quote}<p class="task-comment-quote">{comment.anchor.quote}</p>{/if}
              <p class="task-comment-body">{comment.body}</p>
              <div class="task-comment-actions">
                <button type="button" class="btn btn-ghost btn-sm" title="复制路径、行号与原正文" onclick={() => copy(commentCopyText(comment), "失效意见")}><Icon name="copy" size={12} /><span>复制</span></button>
              </div>
            </article>
          {/each}
        </div>
      {/each}
    </section>
  {/if}
</div>
