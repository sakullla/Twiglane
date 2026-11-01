<script lang="ts">
  import type { OpenedRepository, StatusSnapshot } from "../types";
  import Icon from "./Icon.svelte";
  import MergePanel from "./MergePanel.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    opened: OpenedRepository;
    focusPath?: string | null;
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

<!-- 合并内容接近全宽，但仍是 modal 语义：标题、关闭入口与 Esc 都在。 -->
<Modal
  title="分支合并"
  titleId="merge-modal-title"
  icon="merge"
  width="min(1240px, calc(100vw - 96px))"
  task="merge"
  onClose={onClose}
>
  <MergePanel
    {opened}
    {focusPath}
    {disabled}
    {nextId}
    {onSnapshot}
    {onGeneration}
    {onFailure}
    {onNotice}
    {onOpenStash}
    {onOpenChanges}
    embedded
  />
  {#snippet footer()}
    <span class="hint"><Icon name="check-circle" size={12} />存在未解决冲突时完成动作不可用</span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
