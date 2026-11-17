<script lang="ts">
import { ChevronRight } from "lucide-svelte";
import { displaySafeJson } from "$kit/task-run.ts";
import { getLocale } from "../runtime.svelte.ts";
import CopyButton from "./CopyButton.svelte";
import Section from "./Section.svelte";

type Props = {
  label: string;
  value: unknown;
  copyLabel?: string;
  maxStringLength?: number;
  collapsed?: boolean;
  class?: string;
};
let { label, value, copyLabel, maxStringLength, collapsed = false, class: className = "" }: Props = $props();
const locale = $derived(getLocale());
let open = $state(false);
const text = $derived(
  typeof value === "string"
    ? value
    : displaySafeJson(value, { locale, ...(maxStringLength ? { maxStringLength } : {}) }),
);
const raw = $derived(typeof value === "string" ? value : JSON.stringify(value, null, 2));
</script>

{#snippet code()}
  <pre class="max-h-[48vh] overflow-auto overscroll-contain rounded-[7px] bg-bg-elevated/35 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-text-secondary [scrollbar-width:thin] sm:max-h-[520px]">{text ?? "—"}</pre>
{/snippet}
{#snippet copy()}{#if copyLabel && raw}<CopyButton variant="action" value={raw} label={copyLabel} />{/if}{/snippet}

{#if collapsed}
  <details class="group min-w-0 {className}" bind:open>
    <summary class="flex min-h-8 list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
      <span class="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-placeholder transition-colors group-hover:text-text-tertiary">
        <ChevronRight class="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{label}
      </span>
      {#if open}{@render copy()}{/if}
    </summary>
    <div class="mt-2">{@render code()}</div>
  </details>
{:else}
  <Section {label} class={className} actions={copy}>{@render code()}</Section>
{/if}
