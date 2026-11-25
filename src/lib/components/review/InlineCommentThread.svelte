<script lang="ts">
  import { anchorLabel, type ReviewComment, type ReviewCommentAnchor } from "../../review-comments.svelte";
  import Icon from "../Icon.svelte";
  import InlineCommentEditor from "./InlineCommentEditor.svelte";

  /**
   * 已有意见的锚点线程：点差异里已挂意见的标记时在同一位置展开，查看这一锚点的全部意见，
   * 可以编辑、删除、到抽屉里定位，或在同一位置再加一条。编辑中的正文由调用方放进草稿槽，
   * 切换文件或来源再回来仍在。
   */
  interface Props {
    anchor: ReviewCommentAnchor;
    comments: readonly ReviewComment[];
    editingId?: string | null;
    editBody?: string;
    editDirty?: boolean;
    editError?: string | null;
    onBeginEdit: (comment: ReviewComment) => void;
    onEditInput: (body: string) => void;
    onSaveEdit: () => void;
    onCancelEdit: () => void;
    onDelete: (comment: ReviewComment) => void;
    onAddAnother: () => void;
    onLocate?: (comment: ReviewComment) => void;
    onClose: () => void;
  }

  let {
    anchor,
    comments,
    editingId = null,
    editBody = "",
    editDirty = false,
    editError = null,
    onBeginEdit,
    onEditInput,
    onSaveEdit,
    onCancelEdit,
    onDelete,
    onAddAnother,
    onLocate,
    onClose,
  }: Props = $props();

  let name = $derived(anchor.range ? "这一块的意见" : "这一行的意见");

  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => {
      if (node.isConnected && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    });
  }
</script>

<!-- Esc 收起线程：键盘事件来自线程里的按钮，在这里统一处理。 -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="inline-comment-thread"
  aria-label={name}
  tabindex="-1"
  use:focusOnMount
  onkeydown={(event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }}
>
  <header class="inline-comment-ref">
    <span class="inline-comment-path">{anchor.path}</span>
    <span class="inline-comment-line">{anchorLabel(anchor)}</span>
    <span class="inline-comment-count">{comments.length} 条意见</span>
    <button type="button" class="icon-btn sm" aria-label="收起意见线程" title="收起（Esc）" onclick={onClose}><Icon name="x" size={13} /></button>
  </header>
  {#if anchor.quote}<p class="inline-comment-quote" aria-label="引用的代码">{anchor.quote}</p>{/if}
  <ol class="inline-comment-list">
    {#each comments as comment (comment.id)}
      <li class="inline-comment-item" data-comment-id={comment.id}>
        {#if editingId === comment.id}
          <InlineCommentEditor
            anchor={comment.anchor}
            mode="edit"
            body={editBody}
            dirty={editDirty}
            error={editError}
            showQuote={false}
            onInput={onEditInput}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
          />
        {:else}
          {#if comment.anchor.range && !anchor.range}<span class="inline-comment-line">{anchorLabel(comment.anchor)}</span>{/if}
          <p class="inline-comment-body">{comment.body}</p>
          <div class="inline-comment-actions">
            <button type="button" class="btn btn-ghost btn-sm" title="就地修改这条意见" onclick={() => onBeginEdit(comment)}><Icon name="pencil" size={12} /><span>编辑</span></button>
            <button type="button" class="btn btn-ghost btn-sm" title="从这批意见里删掉" onclick={() => onDelete(comment)}><Icon name="trash" size={12} /><span>删除</span></button>
            {#if onLocate}
              <button type="button" class="btn btn-ghost btn-sm" title="打开意见抽屉并定位到这条" onclick={() => onLocate?.(comment)}><Icon name="list" size={12} /><span>在抽屉中定位</span></button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
  <div class="inline-comment-actions">
    <button type="button" class="btn btn-secondary btn-sm" title="在同一位置再写一条意见" onclick={onAddAnother}><Icon name="plus" size={12} /><span>添加另一条</span></button>
  </div>
</section>
