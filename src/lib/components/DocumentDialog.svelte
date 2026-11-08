<script lang="ts">
  import { untrack } from "svelte";
  import {
    createDocumentSession,
    initialDocumentMode,
    type DocumentMode,
    type DocumentSession,
  } from "../document-session.svelte";
  import type { DocumentSource } from "../types";
  import { documentSourceLabel } from "../ui";
  import DocumentReader from "./DocumentReader.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  /**
   * 只读阅读窗口：接受明确的来源（工作区 / 暂存区 / 某个提交），显示该版本正文与源码，
   * 相对链接留在同一版本里。差异与历史消费者只传来源，不用当前工作区正文冒充历史内容。
   */
  interface Props {
    repository: string;
    source: DocumentSource;
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
    source,
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
  const label = $derived(documentSourceLabel(source, abbrevLength));

  // 初始模式取自这个身份的阅读会话；来源变化时由下面的 effect 重新取。
  // svelte-ignore state_referenced_locally
  let mode = $state<DocumentMode>(reading.recall(source)?.reading.mode ?? "preview");

  // 同一个窗口换来源（例如差异两侧切换）时按新身份恢复模式，不沿用上一份的。
  let lastKey = "";
  $effect(() => {
    const key = JSON.stringify([source.revision, source.path, source.snapshot ?? "", source.repository ?? ""]);
    if (key === lastKey) return;
    lastKey = key;
    untrack(() => {
      mode = reading.recall(source)?.reading.mode ?? "preview";
    });
  });

  function setMode(next: DocumentMode): void {
    mode = next;
    reading.remember(source, { mode: next });
  }
</script>

<Modal title="阅读文档" {titleId} icon="file" size="xl" fill task="document" {returnFocus} {onClose}>
  {#snippet headExtra()}
    <span class="doc-dialog-source" title={`来源：${label}`}>{label}</span>
    <div class="segmented doc-dialog-mode" role="group" aria-label="文档显示方式">
      <button type="button" aria-pressed={mode === "preview"} aria-label="阅读排版预览" title="排版预览（只读）" onclick={() => setMode("preview")}>预览</button>
      <button type="button" aria-pressed={mode === "source"} aria-label="阅读文档源码" title="这个版本的源码" onclick={() => setMode("source")}>源码</button>
    </div>
  {/snippet}
  <div class="document-dialog">
    <DocumentReader
      active
      {repository}
      {source}
      {generation}
      {nextId}
      {onGeneration}
      session={reading}
      {mode}
      onMode={setMode}
      {abbrevLength}
    />
  </div>
  {#snippet footer()}
    <span class="doc-dialog-note"><Icon name="eye" size={12} />只读阅读：不会修改文件、索引或提交范围</span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
