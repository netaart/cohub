<script lang="ts">
import { ChevronDown, LoaderCircle } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	label,
	meta = [],
	keepMetaVisible = false,
	ariaLabel,
	disabled = false,
	expanded,
	loading = false,
	onclick,
}: {
	label: string;
	meta?: string[];
	keepMetaVisible?: boolean;
	ariaLabel?: string;
	disabled?: boolean;
	expanded?: boolean;
	loading?: boolean;
	onclick: () => void;
} = $props();

const locale = $derived(getLocale());
const effectiveAriaLabel = $derived(
	ariaLabel ?? m.composer_model_label({ model: label }, { locale }),
);
</script>

<button
	type="button"
	class="group flex h-7 max-w-[min(100%,17rem)] items-center gap-1 overflow-hidden rounded-full border border-border-subtle px-2 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50"
	{disabled}
	aria-label={effectiveAriaLabel}
	aria-expanded={expanded}
	{onclick}
>
	{#if loading}<LoaderCircle class="h-3 w-3 shrink-0 animate-spin" />{/if}
	<span class="min-w-0 shrink truncate text-text-tertiary transition-colors group-hover:text-text-secondary">
		{label}
	</span>
	{#each meta as item}
		<span class={`flex min-w-0 max-w-[6.5rem] ${keepMetaVisible ? "shrink-0" : "shrink-[3]"} items-baseline gap-0.5 text-[10px] leading-none text-text-placeholder/80 transition-colors group-hover:text-text-placeholder`} aria-hidden="true">
			<span class="shrink-0 opacity-40">·</span>
			<span class="min-w-0 truncate tabular-nums">{item}</span>
		</span>
	{/each}
	<ChevronDown class="h-3 w-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-65" />
</button>
