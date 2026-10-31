<script lang="ts">
  import { BRAND } from "../brand";

  interface Props {
    compact?: boolean;
    large?: boolean;
  }
  let { compact = false, large = false }: Props = $props();
</script>

<div class="brand" class:lg={large}>
  <span class="brand-logo" aria-hidden="true">
    <svg viewBox="0 0 32 32">
      <path d="M16 26V14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
      <path d="M16 18.5c0-5 6-6 6.5-11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
      <path d="M16 21c0-3.2-4.5-4-5-7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity="0.7" />
      <circle cx="16" cy="26" r="2.4" fill="currentColor" />
      <circle cx="22.5" cy="7" r="2.4" fill="currentColor" />
      <circle cx="11" cy="13" r="2" fill="currentColor" opacity="0.7" />
    </svg>
  </span>
  {#if !large}
    <div class="brand-text">
      <strong>{BRAND.name}</strong>
      {#if !compact}
        <span>{BRAND.zh} · Git 桌面客户端</span>
      {/if}
    </div>
  {/if}
</div>
