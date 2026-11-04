<script lang="ts">
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    /** 提交区的范围说明，例如「提交到 main · 3 个已暂存文件」。 */
    scopeLabel: string;
    /** 本次将提交的路径；重命名以「旧 → 新」形式传入。 */
    paths: string[];
    /** 关闭后焦点去处（命令面板打开时由外壳传入）。 */
    returnFocus?: HTMLElement | null;
    onClose: () => void;
  }

  let { scopeLabel, paths, returnFocus = null, onClose }: Props = $props();
</script>

<Modal
  title="本次提交范围"
  titleId="scope-modal-title"
  icon="file-diff"
  size="md"
  task="scope"
  description={scopeLabel}
  {returnFocus}
  onClose={onClose}
>
  {#if paths.length === 0}
    <div class="empty compact" role="status">
      <span class="empty-icon"><Icon name="layers" size={22} /></span>
      <strong>暂存区是空的</strong>
      <p>先暂存要提交的文件，再查看本次提交范围。</p>
    </div>
  {:else}
    <p class="hint">共 {paths.length} 个文件，可滚动查看全部。</p>
    <ul class="scope-list" style="max-height: min(52vh, 420px)" aria-label="本次提交的文件">
      {#each paths as path (path)}
        <li title={path}>{path}</li>
      {/each}
    </ul>
  {/if}
  {#snippet footer()}
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
