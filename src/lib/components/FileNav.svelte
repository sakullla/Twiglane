<script lang="ts">
  import { tick } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import type { FileNavState } from "../ui";
  import Icon from "./Icon.svelte";

  let { nav }: { nav: FileNavState } = $props();
  let prev = $state<HTMLButtonElement | null>(null);
  let next = $state<HTMLButtonElement | null>(null);
  const alt = MODIFIER_LABEL === "⌘" ? "⌥" : "Alt";

  /** 走到头时按钮随即禁用，焦点会掉到 body；交给另一个按钮，键盘用户还能接着往回走。 */
  async function run(go: () => void, self: HTMLButtonElement | null, other: HTMLButtonElement | null) {
    go();
    await tick();
    if (self?.disabled && !other?.disabled) other?.focus({ preventScroll: true });
  }
</script>

<div class="file-nav" role="group" aria-label="切换文件">
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
