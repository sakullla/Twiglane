<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    /** 当前分支名，用于展示将发布的对象。 */
    branch: string;
    /** 已记录的上游；为空表示这次发布会建立上游关联。 */
    upstream: string | null;
    /** 将推送到的远程名，例如 origin。 */
    remote: string;
    /** 领先提交数，仅用于说明将推送的内容。 */
    ahead?: number;
    disabled: boolean;
    busy?: string | null;
    onClose: () => void;
    onPublish: () => void;
    /** 只建立上游关联，不推送。 */
    onAssociate?: () => void;
    /** 关闭后焦点去处（命令面板打开时由外壳传入）。 */
    returnFocus?: HTMLElement | null;
  }

  let {
    branch,
    upstream,
    remote,
    ahead = 0,
    disabled,
    busy = null,
    returnFocus = null,
    onClose,
    onPublish,
    onAssociate,
  }: Props = $props();

  let working = $derived(busy === "publish" || busy === "associate");
  let blocked = $derived(disabled || working);
</script>

<Modal
  title="发布分支"
  titleId="publish-modal-title"
  icon="upload"
  size="md"
  task="publish"
  description="发布只推送当前分支一次并建立上游关联，不会强行推送。"
  {returnFocus}
  onClose={onClose}
>
  <ul class="scope-list" style="max-height: none" aria-label="发布对象">
    <li title={branch}>当前分支 · {branch}</li>
    <li title={remote}>目标远程 · {remote}</li>
    <li title={upstream ?? remote}>{upstream ? `上游 · ${upstream}` : `上游 · 发布后在 ${remote} 建立关联`}</li>
    <li>待推送提交 · {ahead}</li>
  </ul>
  <div class="callout info">
    <Icon name="info" size={15} />
    <span>推送使用系统凭据助手或 SSH agent，不保存凭据；远程已存在同名分支时不会覆盖。</span>
  </div>
  {#snippet footer()}
    <!-- 右侧动作顺序与其它任务弹窗一致：「次要动作 → 取消 → 主操作」；
         左侧样式与详情弹窗不完全相同（详情在 spacer 前还放了一个复制按钮），这里只对齐右侧顺序。 -->
    <span class="spacer"></span>
    {#if onAssociate}
      <button type="button" class="btn btn-ghost" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => onAssociate?.()}>
        <Icon name="link" size={14} />只关联上游
      </button>
    {/if}
    <button type="button" class="btn btn-secondary" onclick={onClose}>取消</button>
    <button type="button" class="btn btn-primary" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => onPublish()}>
      {#if busy === "publish"}<span class="spinner"></span>{:else}<Icon name="upload" size={14} />{/if}
      发布分支
    </button>
  {/snippet}
</Modal>
