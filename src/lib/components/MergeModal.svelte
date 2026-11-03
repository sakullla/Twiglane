<script lang="ts">
  import type { OpenedRepository, StatusSnapshot } from "../types";
  import MergePanel from "./MergePanel.svelte";
  import type { MergeMode } from "./MergeSetup.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
    initialSource?: string | null;
    initialTarget?: string | null;
    initialMode?: MergeMode | null;
    disabled: boolean;
    nextId: () => number;
    onClose: () => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
    onOpenHistory?: () => void;
  }

  let {
    opened,
    focusPath = null,
    initialSource = null,
    initialTarget = null,
    initialMode = null,
    disabled,
    nextId,
    onClose,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
    onOpenHistory,
  }: Props = $props();

  /** 路由与中止的落点：在标题行里排在标题之后，宽度不依赖标题长度。 */
  let headTarget = $state<HTMLElement | null>(null);
</script>

<!-- 合并内容接近全屏，但仍是 modal 语义：标题、关闭入口与 Esc 都在。
     主操作与关闭放在面板底部同一行，不再额外占一条 modal 底栏，把高度留给预览与冲突内容。 -->
<Modal
  title="合并分支"
  titleId="merge-modal-title"
  icon="merge"
  width="min(1480px, calc(100vw - 32px))"
  fill
  task="merge"
  onClose={onClose}
>
  {#snippet headExtra()}
    <div class="mp-head-slot" bind:this={headTarget}></div>
  {/snippet}
  <MergePanel
    {opened}
    {focusPath}
    {initialSource}
    {initialTarget}
    {initialMode}
    {disabled}
    {nextId}
    {onSnapshot}
    {onGeneration}
    {onFailure}
    {onNotice}
    {onOpenStash}
    {onOpenChanges}
    {onOpenHistory}
    {onClose}
    embedded
    {headTarget}
  />
</Modal>
