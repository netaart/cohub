<script lang="ts">
import type { Snippet } from "svelte";
import { labelClass } from "./classes.ts";

type Props = { id: string; label: string; hint?: string; error?: string | null; optional?: string; children: Snippet; class?: string };
let { id, label, hint, error, optional, children, class: className = "" }: Props = $props();
</script>

<div class="space-y-1.5 {className}">
  <label class={labelClass} for={id}>{label}{#if optional}<span class="ml-1 font-normal normal-case tracking-normal text-text-placeholder">{optional}</span>{/if}</label>
  {@render children()}
  {#if error}<p class="text-[11px] leading-5 text-error-soft" id="{id}-error">{error}</p>{:else if hint}<p class="text-[11px] leading-5 text-text-placeholder" id="{id}-hint">{hint}</p>{/if}
</div>
