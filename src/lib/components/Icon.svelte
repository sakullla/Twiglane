<script lang="ts">
  import { ICONS, type IconName } from "../icons";

  interface Props {
    name: IconName;
    size?: number;
    stroke?: number;
    class?: string;
  }
  let { name, size = 16, stroke = 1.75, class: extra = "" }: Props = $props();
</script>

<svg
  class={`icon ${extra}`}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each ICONS[name] as d, index (index)}
    <path {d} />
  {/each}
</svg>
