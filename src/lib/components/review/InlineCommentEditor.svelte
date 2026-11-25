<script lang="ts">
  import { MODIFIER_LABEL } from "../../brand";
  import { anchorLabel, commentBodyBytes, MAX_BODY_BYTES, type ReviewCommentAnchor } from "../../review-comments.svelte";
  import Icon from "../Icon.svelte";

  /**
   * 原位意见编辑器：引用摘要 + 文本框 + 保存/取消 + 上限提示。差异内的意见行、意见线程与
   * 抽屉卡片共用它，键盘语义一致：
   * - 输入法组字中（isComposing）Enter 与 Esc 都交给输入法，不保存、不取消；
   * - ⌘/Ctrl+Enter 保存；Esc 取消，有会丢的正文时先就地确认，再按一次 Esc 或点「放弃」才丢。
   * 保存失败（空正文、超过 16 KiB、第 65 条）由调用方把消息传回 error，正文原样保留。
   */
  interface Props {
    anchor: ReviewCommentAnchor;
    mode?: "add" | "edit";
    body: string;
    onInput: (body: string) => void;
    onSave: () => void;
    onCancel: () => void;
    /** 取消会不会丢东西：新增时是有正文，编辑时是改过。 */
    dirty?: boolean;
    error?: string | null;
    /** 文本框可访问名称；默认「意见正文」。 */
    label?: string;
    /** 表单可访问名称；默认按新增/编辑与行/块生成。 */
    formLabel?: string;
    showQuote?: boolean;
    autofocus?: boolean;
  }

  let {
    anchor,
    mode = "add",
    body,
    onInput,
    onSave,
    onCancel,
    dirty = false,
    error = null,
    label = "意见正文",
    formLabel,
    showQuote = true,
    autofocus = true,
  }: Props = $props();

  /** Esc / 取消遇到会丢的正文时先就地确认，不直接清空。 */
  let confirming = $state(false);
  let hint = $state<string | null>(null);
  let bytes = $derived(commentBodyBytes(body));
  let over = $derived(bytes > MAX_BODY_BYTES);
  let showBytes = $derived(bytes > MAX_BODY_BYTES * 0.75);
  let empty = $derived(body.trim() === "");
  let saveKey = MODIFIER_LABEL === "⌘" ? "⌘Enter" : "Ctrl+Enter";
  let name = $derived(
    formLabel ?? (mode === "edit" ? "编辑这条意见" : anchor.range ? "给这一块添加意见" : "给这一行添加意见"),
  );

  function focusOnMount(node: HTMLTextAreaElement) {
    if (!autofocus) return;
    // 不让浏览器把差异滚走：编辑器就在锚点行下方，已经在视口里。
    queueMicrotask(() => {
      if (!node.isConnected) return;
      node.focus({ preventScroll: true });
      const end = node.value.length;
      node.setSelectionRange?.(end, end);
    });
  }

  function save(): void {
    if (empty) {
      hint = "先写一句要怎么改。";
      return;
    }
    hint = null;
    confirming = false;
    onSave();
  }

  function requestCancel(): void {
    if (dirty && !confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    onCancel();
  }

  function onKey(event: KeyboardEvent): void {
    // 输入法组字：Enter 是选词、Esc 是撤销候选，都不是给编辑器的命令。
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestCancel();
    }
  }
</script>

<form
  class="inline-comment-editor"
  data-mode={mode}
  aria-label={name}
  onsubmit={(event) => {
    event.preventDefault();
    save();
  }}
>
  {#if showQuote}
    <div class="inline-comment-ref">
      <span class="inline-comment-path">{anchor.path}</span>
      <span class="inline-comment-line">{anchorLabel(anchor)}</span>
    </div>
    {#if anchor.quote}<p class="inline-comment-quote" aria-label="引用的代码">{anchor.quote}</p>{/if}
  {/if}
  <textarea
    class="textarea"
    rows={3}
    value={body}
    aria-label={label}
    aria-invalid={error || over ? "true" : undefined}
    placeholder={anchor.range ? "这一块要怎么改？说清楚就够了。" : "这一行要改成什么样？说清楚就够了。"}
    use:focusOnMount
    oninput={(event) => {
      hint = null;
      confirming = false;
      onInput(event.currentTarget.value);
    }}
    onkeydown={onKey}
  ></textarea>
  {#if showBytes}
    <p class="inline-comment-limit" data-over={over ? "true" : undefined} aria-live="polite">
      <Icon name={over ? "alert-circle" : "info"} size={12} />
      <span>{over ? "已超过单条 16 KiB 上限，保存会被拒绝，请拆开写" : "接近单条 16 KiB 上限"}（{(bytes / 1024).toFixed(1)} / 16 KiB）</span>
    </p>
  {/if}
  {#if error}
    <p class="inline-comment-error" role="alert"><Icon name="alert-circle" size={12} /><span>{error}</span></p>
  {:else if hint}
    <p class="inline-comment-error" role="alert"><Icon name="info" size={12} /><span>{hint}</span></p>
  {/if}
  {#if confirming}
    <div class="inline-comment-confirm" role="alert">
      <Icon name="alert" size={12} />
      <span>{mode === "edit" ? "放弃这次修改？原意见保持不变。" : "放弃这条草稿？正文不会保存。"}再按 Esc 也会放弃。</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick={requestCancel}>放弃</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => (confirming = false)}>继续编辑</button>
    </div>
  {/if}
  <div class="inline-comment-actions">
    <button
      type="submit"
      class="btn btn-primary btn-sm"
      disabled={empty}
      title={empty ? "先写一句要怎么改" : `${mode === "edit" ? "保存修改" : "加到这批意见"}（${saveKey}）`}
    >{mode === "edit" ? "保存意见" : "添加意见"}</button>
    <button type="button" class="btn btn-ghost btn-sm" onclick={requestCancel}>取消</button>
    <span class="inline-comment-hint">{saveKey} 保存 · Esc 取消 · 只存在本窗口，不会自动发送</span>
  </div>
</form>
