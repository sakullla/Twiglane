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
    /** 打开后直接弹出中止确认（主界面「中止合并」入口）。 */
    initialAbort?: boolean;
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
    /** 关闭后焦点去处（命令面板打开时由外壳传入）。 */
    returnFocus?: HTMLElement | null;
  }

  let {
    opened,
    focusPath = null,
    initialSource = null,
    initialTarget = null,
    initialMode = null,
    initialAbort = false,
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
    returnFocus = null,
  }: Props = $props();

  /** 路由与中止的落点：在标题行里排在标题之后，宽度不依赖标题长度。 */
  let headTarget = $state<HTMLElement | null>(null);
  /** 面板读到会话后上报真实操作：还原会话的窗口标题不能一直写成“合并分支”。 */
  let sessionOperation = $state("none");
  let sessionUnresolved = $state(0);
  let modalTitle = $derived(
    sessionOperation === "revert"
      ? sessionUnresolved > 0
        ? "还原冲突"
        : "还原提交"
      : "合并分支",
  );
  let modalIcon = $derived<"undo" | "merge">(sessionOperation === "revert" ? "undo" : "merge");
</script>

<!-- 合并内容接近全屏，但仍是 modal 语义：标题、关闭入口与 Esc 都在。
     主操作与关闭放在面板底部同一行，不再额外占一条 modal 底栏，把高度留给预览与冲突内容。 -->
<Modal
  title={modalTitle}
  titleId="merge-modal-title"
  icon={modalIcon}
  width="min(1480px, calc(100vw - 32px))"
  fill
  task="merge"
  {returnFocus}
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
    {initialAbort}
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
    onOperation={(operation, unresolved) => {
      sessionOperation = operation;
      sessionUnresolved = unresolved;
    }}
    {onClose}
    {closeLabel}
    embedded
    {headTarget}
  />
</Modal>
