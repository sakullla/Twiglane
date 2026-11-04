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
    /** 关闭按钮的文字：从别的 modal 跳过来时写明会回到哪里，例如「返回分支与标签」。 */
    closeLabel?: string;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
    onOpenHistory?: () => void;
    /** 设置里的分支分组，传给来源与目标两个分支选择器。 */
    branchGroups?: boolean;
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
    closeLabel,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
    onOpenHistory,
    branchGroups = true,
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
    {branchGroups}
    {onClose}
    {closeLabel}
    embedded
    {headTarget}
  />
</Modal>
