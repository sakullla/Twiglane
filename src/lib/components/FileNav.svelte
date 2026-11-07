<script lang="ts">
  import { tick } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import type { FileNavState } from "../ui";
  import Icon from "./Icon.svelte";

  /**
   * 文件切换条：上一个/下一个文件沿用列表顺序与统一命令状态；
   * 文件视图另外提供后退/前进（按本次会话的路径 + 行）与最近打开。
   * 这里的按钮和 file.prev / file.next / file.back / file.forward 读同一份状态，
   * 所以禁用原因不会在按钮与命令面板之间分叉。
   */
  let { nav }: { nav: FileNavState } = $props();
  let prev = $state<HTMLButtonElement | null>(null);
  let next = $state<HTMLButtonElement | null>(null);
  let recentOpen = $state(false);
  let recentButton = $state<HTMLButtonElement | null>(null);
  const alt = MODIFIER_LABEL === "⌘" ? "⌥" : "Alt";

  /** 走到头时按钮随即禁用，焦点会掉到 body；交给另一个按钮，键盘用户还能接着往回走。 */
  async function run(go: () => void, self: HTMLButtonElement | null, other: HTMLButtonElement | null) {
    go();
    await tick();
    if (self?.disabled && !other?.disabled) other?.focus({ preventScroll: true });
  }

  function openRecent(): void {
    recentOpen = true;
  }

  function closeRecent(refocus = false): void {
    recentOpen = false;
    if (refocus) recentButton?.focus({ preventScroll: true });
  }

  function pick(path: string, line: number | null): void {
    closeRecent(true);
    nav.history?.onOpen(path, line);
  }
</script>

<div class="file-nav" role="group" aria-label="切换文件">
  {#if nav.history}
    <button
      type="button"
      class="icon-btn sm"
      aria-label="后退"
      title={nav.history.backReason ?? `回到上一个打开的文件（${MODIFIER_LABEL} ⇧ ←）`}
      disabled={nav.history.backReason !== null}
      onclick={nav.history.onBack}
    >
      <Icon name="arrow-left" size={15} />
    </button>
    <button
      type="button"
      class="icon-btn sm"
      aria-label="前进"
      title={nav.history.forwardReason ?? `回到下一个打开的文件（${MODIFIER_LABEL} ⇧ →）`}
      disabled={nav.history.forwardReason !== null}
      onclick={nav.history.onForward}
    >
      <Icon name="arrow-right" size={15} />
    </button>
    <button
      type="button"
      class="icon-btn sm"
      aria-label="最近打开"
      aria-haspopup="menu"
      aria-expanded={recentOpen}
      title="最近打开的文件"
      bind:this={recentButton}
      onclick={() => (recentOpen ? closeRecent(true) : openRecent())}
    >
      <Icon name="history" size={15} />
    </button>
    {#if recentOpen}
      <div class="file-nav-recent" role="menu" aria-label="最近打开的文件">
        {#if nav.history.recent.length === 0}
          <p class="file-nav-empty">本次会话还没有打开过文件。</p>
        {:else}
          {#each [...nav.history.recent].reverse().slice(0, 12) as visit (visit.path + visit.line)}
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              title={visit.line ? `${visit.path}:${visit.line}` : visit.path}
              onclick={() => pick(visit.path, visit.line)}
            >
              <Icon name="file" size={13} />
              <span>{visit.path}{#if visit.line}<small>第 {visit.line} 行</small>{/if}</span>
            </button>
          {/each}
        {/if}
        <button type="button" class="menu-item" role="menuitem" onclick={() => closeRecent(true)}>
          <Icon name="x" size={13} /><span>收起</span>
        </button>
      </div>
    {/if}
  {/if}
  <button
    type="button"
    class="icon-btn sm"
    aria-label="上一个文件"
    title={nav.prevReason ?? `上一个文件（${alt} ←）`}
    disabled={nav.prevReason !== null}
    bind:this={prev}
    onclick={() => run(nav.onPrev, prev, next)}
  >
    <Icon name="chevron-left" size={15} />
  </button>
  <button
    type="button"
    class="icon-btn sm"
    aria-label="下一个文件"
    title={nav.nextReason ?? `下一个文件（${alt} →）`}
    disabled={nav.nextReason !== null}
    bind:this={next}
    onclick={() => run(nav.onNext, next, prev)}
  >
    <Icon name="chevron-right" size={15} />
  </button>
  {#if nav.index >= 0}
    <span
      class="file-nav-pos"
      aria-live="polite"
      aria-label={`第 ${nav.index + 1} / ${nav.total} 个文件`}
    >{nav.index + 1}/{nav.total}</span>
  {/if}
</div>
