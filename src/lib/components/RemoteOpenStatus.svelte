<script lang="ts">
  let { label, started }: { label: string; started: number } = $props();
  let elapsed = $state(0);

  $effect(() => {
    const start = started;
    elapsed = 0;
    const timer = window.setInterval(() => {
      elapsed = Math.floor((performance.now() - start) / 1000);
    }, 1000);
    return () => window.clearInterval(timer);
  });
</script>

<span role="status">{label}</span>
{#if elapsed > 0}<span role="timer"> · 已等待 {elapsed} 秒</span>{/if}
