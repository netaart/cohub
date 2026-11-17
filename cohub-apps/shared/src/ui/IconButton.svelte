<script lang="ts">
import type { LucideIcon } from "./icon.ts";

type Props = {
  icon: LucideIcon;
  label: string;
  href?: string;
  spinning?: boolean;
  disabled?: boolean;
  class?: string;
  onclick?: () => void;
};

let {
  icon: Icon,
  label,
  href,
  spinning = false,
  disabled = false,
  class: className = "",
  onclick,
}: Props = $props();

const classes = $derived(
  `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-10 pointer-coarse:w-10 ${className}`,
);
</script>

{#if href}
  <a {href} class={classes} title={label} aria-label={label} target="_blank" rel="noopener noreferrer"><Icon class="h-3.5 w-3.5" /></a>
{:else}
  <button type="button" class={classes} title={label} aria-label={label} disabled={disabled} aria-busy={spinning || undefined} {onclick}><Icon class="h-3.5 w-3.5 {spinning ? 'animate-spin' : ''}" /></button>
{/if}
