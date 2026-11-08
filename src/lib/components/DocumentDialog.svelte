<script lang="ts">
  import { untrack } from "svelte";
  import {
    createDocumentSession,
    type DocumentMode,
    type DocumentSession,
  } from "../document-session.svelte";
  import type { DocumentSource } from "../types";
  import { documentSourceLabel } from "../ui";
  import DocumentReader from "./DocumentReader.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  type Side = "old" | "new";

  /**
   * 只读阅读窗口：接受明确的来源（工作区 / 暂存区 / 父提交 / 某个固定提交），
   * 显示该版本正文与源码，相对链接留在同一版本里。
   *
   * 差异与历史消费者只传两侧真实来源：缺失的一侧不提供入口，也不用另一版本冒充。
   * 两侧都存在时可以在这个窗口里切换「改动前 / 改动后」，位置仍按各自版本分别保存。
   */
  interface Props {
    repository: string;
    old: DocumentSource | null;
    new: DocumentSource | null;
    /** 打开时先看哪一侧；该侧不存在时自动退到存在的一侧。 */
    side?: Side;
    generation: number;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    /** 跨窗口共享的阅读会话；不传时关闭即丢弃位置。 */
    session?: DocumentSession | null;
    /** 关闭后焦点回到打开它的控件。 */
    returnFocus?: HTMLElement | null;
    abbrevLength?: number;
    onClose: () => void;
  }

  let {
    repository,
    old,
    new: next,
    side = "new",
    generation,
    nextId,
    onGeneration,
    session = null,
    returnFocus = null,
    abbrevLength = 0,
    onClose,
  }: Props = $props();

  const ownSession = createDocumentSession({ repository: () => repository });
  const reading = $derived<DocumentSession>(session ?? ownSession);
  const titleId = $props.id();

  const both = $derived(Boolean(old) && Boolean(next));

  function sourceOf(which: Side): DocumentSource | null {
    return which === "old" ? old : next;
  }

  /** 首帧就落到真实存在的一侧：删掉的文件只剩改动前版本，新增的文件只剩改动后版本。 */
  // svelte-ignore state_referenced_locally
  let chosen = $state<Side>(side === "old" ? (old ? "old" : "new") : next ? "new" : "old");
  let active = $derived<DocumentSource | null>(sourceOf(chosen));
  let label = $derived(active ? documentSourceLabel(active, abbrevLength) : "");
  let sideName = $derived(chosen === "old" ? "改动前" : "改动后");

  // 同一个窗口换来源时按新身份恢复阅读模式，不沿用上一份的。
  let lastKey = "";
  let mode = $state<DocumentMode>("preview");
  $effect(() => {
    const current = active;
    if (!current) return;
    const key = JSON.stringify([current.revision, current.path, current.repository ?? ""]);
    if (key === lastKey) return;
    lastKey = key;
    untrack(() => {
      mode = reading.recall(current)?.reading.mode ?? "preview";
    });
  });

  function setMode(nextMode: DocumentMode): void {
    mode = nextMode;
    if (active) reading.remember(active, { mode: nextMode });
  }

  function choose(which: Side): void {
    if (which === chosen || !sourceOf(which)) return;
    chosen = which;
  }
</script>

<Modal title="阅读文档" {titleId} icon="file" size="xl" fill task="document" {returnFocus} {onClose}>
  {#snippet headExtra()}
    {#if both}
      <div class="segmented doc-dialog-side" role="group" aria-label="文档版本">
        <button
          type="button"
          aria-pressed={chosen === "old"}
          title={`改动前：${documentSourceLabel(old!, abbrevLength)}`}
          onclick={() => choose("old")}
        >改动前</button>
        <button
          type="button"
          aria-pressed={chosen === "new"}
          title={`改动后：${documentSourceLabel(next!, abbrevLength)}`}
          onclick={() => choose("new")}
        >改动后</button>
      </div>
    {/if}
    {#if active}
      <span class="doc-dialog-source" title={`来源：${label}`}>{sideName} · {label}</span>
    {/if}
    <div class="segmented doc-dialog-mode" role="group" aria-label="文档显示方式">
      <button type="button" aria-pressed={mode === "preview"} aria-label="阅读排版预览" title="排版预览（只读）" onclick={() => setMode("preview")}>预览</button>
      <button type="button" aria-pressed={mode === "source"} aria-label="阅读文档源码" title="这个版本的源码" onclick={() => setMode("source")}>源码</button>
    </div>
  {/snippet}
  <div class="document-dialog">
    {#if active}
      {#if !both}
        <!-- 只剩一侧时说明另一侧为什么不在，而不是让用户以为可以切换。 -->
        <p class="doc-notice" role="status">
          {#if old}
            这个文件在改动后已经不存在，只保留改动前的版本。
          {:else}
            这个文件是新出现的，改动前没有可阅读的版本。
          {/if}
        </p>
      {/if}
      <DocumentReader
        active
        {repository}
        source={active}
        {generation}
        {nextId}
        {onGeneration}
        session={reading}
        {mode}
        onMode={setMode}
        {abbrevLength}
      />
    {:else}
      <div class="doc-state" role="status">
        <span class="empty-icon"><Icon name="file" size={22} /></span>
        <strong>这个文件没有可阅读的版本</strong>
        <p>两侧都不存在，可能是路径已经变化。</p>
      </div>
    {/if}
  </div>
  {#snippet footer()}
    <span class="doc-dialog-note"><Icon name="eye" size={12} />只读阅读：不会修改文件、索引或提交范围</span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
