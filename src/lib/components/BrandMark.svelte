<script lang="ts">
  import { BRAND } from "../brand";

  interface Props {
    compact?: boolean;
  }
  let { compact = false }: Props = $props();
</script>

<div class="brand">
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 27V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    <path d="M16 18c0-5 6-6 6.5-11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    <circle cx="16" cy="27" r="2" fill="currentColor" />
    <circle cx="16" cy="14" r="2" fill="currentColor" />
    <circle cx="22.5" cy="7" r="2" fill="currentColor" />
  </svg>
  <div>
    <strong>{BRAND.name}</strong>
    {#if !compact}
      <span>{BRAND.full}</span>
    {/if}
  </div>
</div>
