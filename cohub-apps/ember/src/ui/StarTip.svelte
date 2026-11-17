<script lang="ts">
  import type { StarTip } from "../engine/camp.svelte.ts";
  import type { Messages } from "../i18n.ts";

  let { star, t }: { star: StarTip; t: Messages } = $props();
  let width = $state(0);
  let height = $state(0);
  const left = $derived(Math.max(12, Math.min(innerWidth - width - 12, star.x - width / 2)));
  const below = $derived(star.y - height - 18 < 64);
  const top = $derived(below ? star.y + 22 : star.y - height - 18);
</script>

<div class="star-tip" class:below style:left="{left}px" style:top="{top}px" bind:clientWidth={width} bind:clientHeight={height} role="tooltip">
  {#if star.name}<strong>{star.name}</strong>{/if}
  <p class="quote">“{star.text}”</p>
  <small><span class="who-dot" style:--who={star.color}></span>{t.starBy(star.by)}</small>
</div>
