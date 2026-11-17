<script lang="ts">
import { Check, Copy } from "lucide-svelte";
import { onDestroy } from "svelte";
import { m } from "$messages";
import { getLocale } from "../runtime.svelte.ts";

type Props = {
  value: string;
  label: string;
  text?: string;
  variant?: "id" | "action";
  class?: string;
};

let { value, label, text, variant = "id", class: className = "" }: Props = $props();
const locale = $derived(getLocale());
let copied = $state(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function copy() {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return;
  }
  copied = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (copied = false), 1600);
}
onDestroy(() => {
  if (timer) clearTimeout(timer);
});
</script>

{#if variant === "id"}
  <button type="button" class="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 font-mono text-[11px] text-text-placeholder transition-colors hover:text-text-secondary {className}" title={label} aria-label={label} onclick={copy}>
    <span class="truncate">{text ?? value}</span>
    {#if copied}<Check class="h-3 w-3 shrink-0 text-success-soft" />{:else}<Copy class="h-3 w-3 shrink-0" />{/if}
  </button>
{:else}
  <button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary {className}" title={label} aria-label={label} onclick={copy}>
    {#if copied}<Check class="h-3 w-3 text-success-soft" /><span class="text-success-soft" role="status">{m.copied({}, { locale })}</span>{:else}<Copy class="h-3 w-3" /><span>{text ?? m.copy({}, { locale })}</span>{/if}
  </button>
{/if}
