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
    <img src="/brand-icon.png" alt="" width="256" height="256" />
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
