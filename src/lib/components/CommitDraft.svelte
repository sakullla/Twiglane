<script lang="ts">
  interface Props {
    branch: string;
    value: string;
    disabled: boolean;
    onInput: (value: string) => void;
    onBlur: () => void;
  }
  let { branch, value, disabled, onInput, onBlur }: Props = $props();
</script>

<section class="commit" aria-label="提交说明">
  <strong>提交到 {branch}</strong>
  <textarea
    aria-label="提交说明草稿"
    placeholder="写下这次改动的说明"
    {value}
    {disabled}
    oninput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
    onblur={onBlur}
  ></textarea>
  <p class="hint">说明按仓库保存在本机应用数据中。不会自动提交或推送，也不会保存凭据。</p>
</section>
