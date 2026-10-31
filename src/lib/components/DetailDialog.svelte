<script lang="ts">
  interface Props {
    title: string;
    value: string;
    body?: string;
    confirmLabel?: string;
    onClose: () => void;
    onConfirm?: () => void;
  }
  let { title, value, body = "", confirmLabel = "", onClose, onConfirm }: Props = $props();
  let copyMessage = $state("");

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      copyMessage = "已复制完整内容。";
    } catch {
      copyMessage = "无法写入剪贴板，请手动选择下面的文本。";
    }
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }
</script>

<div class="modal-backdrop" role="presentation" onkeydown={onKey}>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="detail-title">
    <h2 id="detail-title">{title}</h2>
    {#if body}<p>{body}</p>{/if}
    <textarea class="full-value" readonly aria-label={title}>{value}</textarea>
    {#if copyMessage}<p class="hint" role="status">{copyMessage}</p>{/if}
    <div class="row">
      <button type="button" class="ghost" onclick={copyValue}>复制</button>
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={onClose}>取消</button>
      {#if onConfirm}
        <button type="button" class="primary" onclick={onConfirm}>{confirmLabel}</button>
      {/if}
    </div>
  </div>
</div>
