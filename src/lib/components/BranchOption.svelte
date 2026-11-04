<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  /**
   * 分支下拉里的一行：标题栏分支弹层和表单里的分支下拉框（BranchPicker）共用，
   * 图标、名称、默认 / 当前标记、不可选说明和选中勾的排布只在这里写一次。
   * 键盘当前项与 aria-activedescendant 由外层的 Popover 管，这里只负责呈现和鼠标。
   */
  interface Props {
    /** 条目 id：`${listId}-${index}`，供 aria-activedescendant 指向。 */
    id: string;
    index: number;
    setsize: number;
    name: string;
    /** 名称之外的显示文字（例如「当前分支（main）」）；缺省显示 name。 */
    text?: string;
    remote?: boolean;
    /** 非分支条目（例如「全部分支」）用自己的图标，名称不用等宽字体。 */
    icon?: IconName;
    active: boolean;
    selected: boolean;
    current?: boolean;
    isDefault?: boolean;
    /** 主干分支（本地默认分支及其远程对应分支）：图标换成星标。 */
    main?: boolean;
    /** 已合入主干：名字后面一枚小勾徽章，说明放在提示里。 */
    merged?: boolean;
    /** 已合入徽章的提示文字。 */
    mergedTitle?: string;
    /** 不可选的原因：整行灰显，原因放在提示里。 */
    reason?: string | null;
    /** 行尾的短说明，例如「已选」「其他工作区」。 */
    note?: string | null;
    /** 显示在行尾的勾；缺省跟随 selected。传 false 时不留勾的位置（标题栏弹层用「当前」标记表达）。 */
    check?: boolean;
    style?: string;
    onHover: () => void;
    onChoose: () => void;
    onContextMenu?: (point: { x: number; y: number }) => void;
    trailing?: Snippet;
  }

  let {
    id,
    index,
    setsize,
    name,
    text,
    remote = false,
    icon,
    active,
    selected,
    current = false,
    isDefault = false,
    main = false,
    merged = false,
    mergedTitle = "已合入主干，删除不会丢失提交",
    reason = null,
    note = null,
    check,
    style,
    onHover,
    onChoose,
    onContextMenu,
    trailing,
  }: Props = $props();
</script>

<div
  {id}
  class="branch-option"
  class:active
  class:special={Boolean(icon)}
  role="option"
  aria-selected={selected}
  aria-setsize={setsize}
  aria-posinset={index + 1}
  aria-disabled={reason ? "true" : undefined}
  data-index={index}
  title={reason ?? text ?? name}
  tabindex="-1"
  {style}
  onmousemove={onHover}
  onclick={onChoose}
  oncontextmenu={(event) => {
    if (!onContextMenu) return;
    event.preventDefault();
    onHover();
    onContextMenu({ x: event.clientX, y: event.clientY });
  }}
  onkeydown={() => {}}
>
  <span class={`branch-option-icon ${remote ? "remote" : ""}`} class:main={main && !icon} title={main && !icon ? "主干分支" : undefined}>
    <Icon name={icon ?? (main ? "star" : remote ? "cloud" : "branch")} size={14} />
  </span>
  <span class="branch-option-label">
    <span class="branch-option-name">{text ?? name}</span>
    {#if merged}<span class="merged-badge" data-merged-branch role="img" aria-label="已合入主干" title={mergedTitle}><Icon name="check" size={10} /></span>{/if}
  </span>
  {#if isDefault}<span class="branch-picker-tag default-branch" data-default-branch>默认</span>{/if}
  {#if current}<span class="branch-picker-tag">当前</span>{/if}
  {#if note}<span class="branch-option-note">{note}</span>{/if}
  {@render trailing?.()}
  {#if check !== false}
    <span class="branch-option-check" aria-hidden="true">{#if check ?? selected}<Icon name="check" size={14} />{/if}</span>
  {/if}
</div>
