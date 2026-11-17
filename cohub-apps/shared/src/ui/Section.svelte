<script lang="ts">
import type { Snippet } from "svelte";
import type { LucideIcon } from "./icon.ts";

type Props = {
  label: string;
  icon?: LucideIcon;
  hint?: string;
  actions?: Snippet;
  class?: string;
  children: Snippet;
};
let { label, icon: Icon, hint, actions, class: className = "", children }: Props = $props();
</script>

<section class="min-w-0 space-y-2 {className}">
  <div class="flex min-h-8 items-center justify-between gap-3">
    <div class="min-w-0">
      <h2 class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-placeholder">
        {#if Icon}<Icon class="h-3.5 w-3.5 shrink-0" />{/if}{label}
      </h2>
      {#if hint}<p class="mt-0.5 truncate text-[12px] text-text-tertiary">{hint}</p>{/if}
    </div>
    {#if actions}<div class="flex shrink-0 items-center gap-1">{@render actions()}</div>{/if}
  </div>
  {@render children()}
</section>
