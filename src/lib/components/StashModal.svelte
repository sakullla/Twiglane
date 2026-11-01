<script lang="ts">
  import type { OpenedRepository, StatusSnapshot } from "../types";
  import Modal from "./Modal.svelte";
  import StashPanel from "./StashPanel.svelte";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    nextId: () => number;
    onClose: () => void;
    onGeneration: (generation: number) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenChanges: (path: string) => void;
  }

  let { opened, disabled, nextId, onClose, onGeneration, onSnapshot, onFailure, onNotice, onOpenChanges }: Props =
    $props();
</script>

<Modal
  title="临时保存"
  titleId="stash-modal-title"
  icon="archive"
  size="lg"
  task="stash"
  onClose={onClose}
>
  <StashPanel
    {opened}
    {disabled}
    {nextId}
    {onGeneration}
    {onSnapshot}
    {onFailure}
    {onNotice}
    {onOpenChanges}
    embedded
  />
  {#snippet footer()}
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
