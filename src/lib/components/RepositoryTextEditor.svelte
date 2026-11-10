<script lang="ts">
  import { tick, untrack } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import {
    encodingLabel,
    isDirty,
    saveBlocker,
    type EditSession,
  } from "../file-editor.svelte";
  import { visibleRange } from "../layout";
  import Icon from "./Icon.svelte";
  import { openModalCount } from "./Modal.svelte";

  /**
   * 轻量文本编辑：原生 textarea（浏览器自带撤销/重做、IME 与选择），不引入 IDE 框架，
   * 不提供运行、调试、终端、诊断或命令执行。只编辑当前工作区的这一个文件。
   *
   * - 保存只在用户明确点击或按 ⌘/Ctrl S 时发生，后端按 baseDigest 在写锁内复核；
   * - 外部修改与保存冲突都保留草稿，只给「复制草稿」「放弃草稿并重新读取」两条明确出路；
   * - 文本输入与组字中的按键不冒泡到工作台，背景的 Git 快捷键不会被触发。
   */
  interface Props {
    session: EditSession;
    /** 文件名（无障碍名称与提示用）。 */
    name: string;
    /** 写入或读取进行中：保存就地禁用并说明原因。 */
    writeLocked?: boolean;
    /** 打开时定位的行与序号：序号变化才重新定位。 */
    line?: number | null;
    lineSerial?: number;
    /** 从差异进来时的返回入口。 */
    returnLabel?: string | null;
    onReturn?: () => void;
    onInput: (text: string) => void;
    onSave: () => void;
    onRevert: () => void;
    onReload: () => void;
    /** 不可编辑（只读原因）时回到查看。 */
    onExit: () => void;
  }

  let {
    session,
    name,
    writeLocked = false,
    line = null,
    lineSerial = 0,
    returnLabel = null,
    onReturn,
    onInput,
    onSave,
    onRevert,
    onReload,
    onExit,
  }: Props = $props();

  /** 与 .text-editor-input 的 line-height 一致：行号栏按它虚拟化。 */
  const LINE_HEIGHT = 20;

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  let confirmRevert = $state(false);
  let copied = $state(false);

  let dirty = $derived(isDirty(session));
  let blocker = $derived(saveBlocker(session, writeLocked));
  let lineCount = $derived(countLines(session.draft));
  let numbers = $derived(visibleRange(lineCount, scrollTop, viewport || 400, LINE_HEIGHT));
  let status = $derived.by(() => {
    if (session.saving) return "正在保存…";
    if (session.reloading) return "正在重新读取…";
    if (session.conflict) return "草稿与文件冲突";
    if (dirty) return "有未保存的修改";
    if (session.savedAt) return "已保存";
    return "未修改";
  });

  function countLines(text: string): number {
    let count = 1;
    for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) count += 1;
    return count;
  }

  /* 草稿干净了就收起「确认放弃」，避免下一次误点直接生效。 */
  $effect(() => {
    if (!dirty) confirmRevert = false;
  });

  /** 打开或定位到某一行：光标放到行首并让这一行出现在视口中部。 */
  async function revealLine(target: number): Promise<void> {
    await tick();
    const node = textarea;
    if (!node) return;
    const text = node.value;
    let offset = 0;
    for (let current = 1; current < target; current += 1) {
      const next = text.indexOf("\n", offset);
      if (next < 0) break;
      offset = next + 1;
    }
    node.focus({ preventScroll: true });
    node.setSelectionRange(offset, offset);
    const top = Math.max(0, (target - 1) * LINE_HEIGHT - (node.clientHeight || 400) / 2);
    node.scrollTop = top;
    scrollTop = top;
  }

  let lastSerial = -1;
  let lastPhase = "";
  $effect(() => {
    const serial = lineSerial;
    const target = line;
    const phase = session.phase;
    const id = session.id;
    untrack(() => {
      // 首次可编辑或定位序号变化时才移动光标；输入、保存不会把光标拉回去。
      const key = `${id}:${phase}`;
      if (phase !== "ready") {
        lastPhase = key;
        return;
      }
      if (serial === lastSerial && key === lastPhase) return;
      const fresh = key !== lastPhase;
      lastSerial = serial;
      lastPhase = key;
      if (target && target > 0) void revealLine(target);
      else if (fresh) void tick().then(() => textarea?.focus({ preventScroll: true }));
    });
  });

  function save(): void {
    // 确认层打开时背景不能写入：保存快捷键只作用于当前这一个编辑会话。
    if (openModalCount() > 0 || blocker) return;
    onSave();
  }

  /** 编辑器根节点：⌘/Ctrl S 保存；其余按键在文本框内消化，不交给工作台快捷键。 */
  function onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      // 输入法组字：回车、方向键与数字都属于候选，不能被任何外层快捷键接走。
      event.stopPropagation();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      save();
      return;
    }
    if (event.target === textarea) event.stopPropagation();
  }

  async function copyDraft(): Promise<void> {
    try {
      await navigator.clipboard.writeText(session.draft);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function revert(): void {
    if (!confirmRevert) {
      confirmRevert = true;
      return;
    }
    confirmRevert = false;
    onRevert();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="text-editor" data-edit-phase={session.phase} onkeydown={onKey}>
  {#if session.phase === "loading"}
    <div class="file-state" role="status" aria-busy="true">
      <span class="empty-icon"><span class="spinner"></span></span>
      <strong>正在读取完整内容</strong>
      <p>编辑需要整份文件与内容摘要，读完后才能输入。</p>
    </div>
  {:else if session.phase === "failed"}
    <div class="file-state" role="alert">
      <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
      <strong>无法进入编辑</strong>
      <p>{session.error ?? "无法读取这个文件的完整内容。"}</p>
      <div class="file-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" title={session.reloading ? "正在重新读取" : "按文件当前内容再读一次"} disabled={session.reloading} onclick={onReload}>重新读取</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={onExit}>回到查看</button>
      </div>
    </div>
  {:else if session.phase === "readonly"}
    <div class="file-state" role="status" data-edit-readonly>
      <span class="empty-icon"><Icon name="eye" size={22} /></span>
      <strong>这个文件保持只读</strong>
      <p>{session.error ?? "这个文件不能在这里编辑。"}</p>
      <div class="file-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick={onExit}>回到查看</button>
      </div>
    </div>
  {:else}
    <div class="text-editor-bar" role="toolbar" aria-label="编辑操作">
      <span
        class="text-editor-status"
        class:dirty
        class:conflict={Boolean(session.conflict)}
        role="status"
        data-edit-status
      >
        {#if session.saving || session.reloading}<span class="spinner" aria-hidden="true"></span>{:else}<span class="text-editor-dot" aria-hidden="true"></span>{/if}
        {status}
      </span>
      <span class="text-editor-meta" title="保存时按原文件的行尾与编码写回，不改变其他文件">{encodingLabel(session.snapshot)}</span>
      <span class="spacer"></span>
      {#if returnLabel && onReturn}
        <button type="button" class="btn btn-ghost btn-sm" data-edit-return onclick={onReturn}>
          <Icon name="arrow-left" size={13} /><span>{returnLabel}</span>
        </button>
      {/if}
      {#if dirty}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          class:btn-danger-soft={confirmRevert}
          aria-label={confirmRevert ? "确认放弃全部未保存的修改" : "放弃未保存的修改"}
          title={confirmRevert ? "再点一次：草稿恢复成读取时的内容，不写入文件" : "把草稿恢复成读取时的内容（需要再确认一次）"}
          disabled={session.saving}
          onclick={revert}
          onblur={() => (confirmRevert = false)}
        ><Icon name="undo" size={13} /><span>{confirmRevert ? "确认放弃" : "放弃修改"}</span></button>
      {/if}
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-edit-save
        aria-label="保存修改到工作区"
        aria-keyshortcuts={MODIFIER_LABEL === "⌘" ? "Meta+S" : "Control+S"}
        title={blocker ?? `只写入这个工作区文件，不暂存、不提交（${MODIFIER_LABEL} S）`}
        disabled={blocker !== null}
        onclick={save}
      >
        {#if session.saving}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="check" size={13} />{/if}<span>保存</span>
      </button>
    </div>
    {#if session.conflict}
      <div class="file-note danger text-editor-alert" role="alert" data-edit-conflict>
        <Icon name="alert" size={13} />
        <span>{session.conflict}</span>
        <button type="button" class="link-btn" onclick={() => void copyDraft()}>{copied ? "已复制草稿" : "复制草稿"}</button>
        <button
          type="button"
          class="link-btn"
          title="丢掉这里的草稿，按文件当前内容重新开始编辑"
          disabled={session.reloading}
          onclick={onReload}
        >放弃草稿并重新读取</button>
      </div>
    {:else if session.error}
      <div class="file-note danger text-editor-alert" role="alert" data-edit-error>
        <Icon name="alert-circle" size={13} />
        <span>{session.error}</span>
        <button type="button" class="link-btn" title={blocker ?? "用同一份草稿与基线再保存一次"} disabled={blocker !== null} onclick={save}>重试保存</button>
      </div>
    {/if}
    <div class="text-editor-body">
      <div class="text-editor-gutter" aria-hidden="true">
        <div class="text-editor-numbers" style={`transform:translateY(${numbers.start * LINE_HEIGHT - scrollTop}px)`}>
          {#each { length: numbers.end - numbers.start } as _, index (numbers.start + index)}
            <span>{numbers.start + index + 1}</span>
          {/each}
        </div>
      </div>
      <textarea
        bind:this={textarea}
        class="text-editor-input"
        aria-label={`${name} 编辑内容`}
        aria-multiline="true"
        wrap="off"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        value={session.draft}
        readonly={session.saving || session.reloading}
        bind:clientHeight={viewport}
        oninput={(event) => onInput(event.currentTarget.value)}
        onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      ></textarea>
    </div>
  {/if}
</div>
