<script lang="ts">
  import { tick } from "svelte";
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
  let query = $state("");
  let copied = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);
  let filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return needle ? paths.filter((path) => path.toLowerCase().includes(needle)) : paths;
  });

  async function copyPaths() {
    if (paths.length === 0) return;
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
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
    {#if paths.length > 8}
      <div class="field sm">
        <Icon name="search" size={13} />
        <input
          bind:this={searchInput}
          aria-label="筛选提交文件"
          placeholder="筛选文件或路径"
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          onkeydown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              query = "";
            }
          }}
        />
        {#if query}
          <button type="button" class="field-clear" aria-label="清空筛选" onclick={() => { query = ""; void tick().then(() => searchInput?.focus()); }}>
            <Icon name="x" size={12} />
          </button>
        {/if}
      </div>
    {/if}
    <p class="hint">{query.trim() ? `匹配 ${filtered.length} / ${paths.length} 个文件` : `共 ${paths.length} 个文件，可滚动查看全部。`}</p>
    <ul class="scope-list" style="max-height: min(52vh, 420px)" aria-label="本次提交的文件">
      {#each filtered as path (path)}
        <li title={path}>{path}</li>
      {:else}
        <li>没有匹配的文件</li>
      {/each}
    </ul>
  {/if}
  {#snippet footer()}
    {#if paths.length > 0}
      <button type="button" class="btn btn-ghost" onclick={() => void copyPaths()}>
        <Icon name={copied ? "check" : "copy"} size={14} />{copied ? "已复制路径" : "复制路径"}
      </button>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
