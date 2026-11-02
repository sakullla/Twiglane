<script lang="ts">
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    title: string;
    value: string;
    body?: string;
    confirmLabel?: string;
    confirmDisabled?: boolean;
    icon?: IconName;
    prose?: boolean;
    editable?: boolean;
    onInput?: (value: string) => void;
    onClose: () => void;
    onConfirm?: () => void;
  }
  let { title, value, body = "", confirmLabel = "", confirmDisabled = false, icon = "info", prose = false, editable = false, onInput, onClose, onConfirm }: Props = $props();
  let copied = $state<"" | "ok" | "fail">("");

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      copied = "ok";
    } catch {
      copied = "fail";
    }
  }
</script>

<Modal {title} titleId="detail-title" {icon} description={body} size={prose ? "lg" : "md"} {onClose}>
  <textarea
    class="full-value"
    class:prose
    class:editable
    readonly={!editable}
    aria-label={title}
    rows={prose ? 12 : 3}
    oninput={(event) => {
      if (editable) onInput?.((event.currentTarget as HTMLTextAreaElement).value);
    }}
  >{value}</textarea>
  {#if copied === "ok"}
    <p class="hint" role="status">已复制完整内容。</p>
  {:else if copied === "fail"}
    <p class="hint" role="status">无法写入剪贴板，请手动选择上面的文本。</p>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={copyValue}>
      <Icon name={copied === "ok" ? "check" : "copy"} size={14} />复制
    </button>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>{onConfirm ? "取消" : "关闭"}</button>
    {#if onConfirm}
      <button type="button" class="btn btn-primary" title={confirmDisabled ? "先填写内容" : undefined} disabled={confirmDisabled} onclick={onConfirm}>{confirmLabel}</button>
    {/if}
  {/snippet}
</Modal>
