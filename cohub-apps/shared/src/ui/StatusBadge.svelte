<script lang="ts">
import type { Tone } from "../status.ts";

type Props = { tone: Tone; label?: string; live?: boolean; class?: string };
let { tone, label, live = false, class: className = "" }: Props = $props();

const dot: Record<Tone, string> = {
  success: "bg-status-running",
  error: "bg-status-error",
  info: "bg-info",
  warning: "bg-warning",
  brand: "bg-brand",
  muted: "bg-text-placeholder",
};
const text: Record<Tone, string> = {
  success: "text-status-running",
  error: "text-status-error",
  info: "text-info",
  warning: "text-warning",
  brand: "text-brand",
  muted: "text-text-tertiary",
};
</script>

<span class="inline-flex items-center gap-1.5 text-[11px] font-medium {text[tone]} {className}">
  <span class="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
    {#if live}<span class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 {dot[tone]}"></span>{/if}
    <span class="relative inline-flex h-1.5 w-1.5 rounded-full {dot[tone]}"></span>
  </span>
  {#if label}<span class="truncate">{label}</span>{/if}
</span>
