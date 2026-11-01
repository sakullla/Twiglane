<script lang="ts">
  import type { OpenedRepository, StatusSnapshot } from "../types";
  import MergePanel from "./MergePanel.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
    initialSource?: string | null;
    disabled: boolean;
    nextId: () => number;
    onClose: () => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
  }

  let {
    opened,
    focusPath = null,
    initialSource = null,
    disabled,
    nextId,
    onClose,
    onSnapshot,
    onGeneration,
    onFailure,
    onNotice,
    onOpenStash,
    onOpenChanges,
  }: Props = $props();
</script>

<!-- 合并内容接近全屏，但仍是 modal 语义：标题、关闭入口与 Esc 都在。
     完成合并与关闭放在面板底部同一行，不再额外占一条 modal 底栏，把高度留给冲突内容。 -->
<Modal
  title="分支合并"
  titleId="merge-modal-title"
  icon="merge"
  width="min(1480px, calc(100vw - 32px))"
  fill
  task="merge"
  onClose={onClose}
>
  <MergePanel
    {opened}
    {focusPath}
    {initialSource}
    {disabled}
    {nextId}
    {onSnapshot}
    {onGeneration}
    {onFailure}
    {onNotice}
    {onOpenStash}
    {onOpenChanges}
    {onClose}
    embedded
  />
</Modal>
