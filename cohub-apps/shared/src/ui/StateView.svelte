<script lang="ts">
import type { Snippet } from "svelte";
import type { LucideIcon } from "./icon.ts";

type Props = {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: Snippet;
};
let { icon: Icon, title, description, action }: Props = $props();
</script>

<div class="flex min-h-[40vh] animate-fade-in flex-col items-center justify-center gap-3 px-6 py-12 text-center">
  <span class="flex h-10 w-10 items-center justify-center rounded-full bg-bg-elevated/50 text-text-tertiary"><Icon class="h-4.5 w-4.5" /></span>
  <div class="max-w-sm space-y-1">
    <p class="text-[13px] font-medium text-text-primary">{title}</p>
    {#if description}<p class="text-[12px] leading-5 text-text-tertiary">{description}</p>{/if}
  </div>
  {#if action}<div class="mt-1 flex flex-wrap justify-center gap-2">{@render action()}</div>{/if}
</div>
