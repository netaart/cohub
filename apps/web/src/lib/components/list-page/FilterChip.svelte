<script lang="ts">
import type { Snippet } from "svelte";

let {
	label,
	active = false,
	href,
	onclick,
	kind = "tab",
	title,
	leading,
	trailing,
	expanded,
	ref = $bindable(null),
}: {
	label: string;
	active?: boolean;
	href?: string;
	onclick?: (event: MouseEvent) => void;
	kind?: "tab" | "toggle" | "menu";
	title?: string;
	leading?: Snippet;
	trailing?: Snippet;
	expanded?: boolean;
	ref?: HTMLElement | null;
} = $props();

const className = $derived(
	`inline-flex h-8 max-w-[200px] shrink-0 select-none items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:h-7 lg:rounded-[6px] lg:px-2 ${
		kind === "menu"
			? "bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary"
			: active
				? "bg-brand-muted text-brand-muted-fg hover:bg-brand-muted-hover"
				: "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
	}`,
);
</script>

{#snippet content()}
	{@render leading?.()}
	<span class="truncate">{label}</span>
	{@render trailing?.()}
{/snippet}

{#if href}
	<a
		bind:this={ref}
		{href}
		class={className}
		data-filter-chip
		data-active={active}
		aria-current={active ? "page" : undefined}
		title={title ?? label}
		{onclick}
	>{@render content()}</a>
{:else}
	<button
		bind:this={ref}
		type="button"
		class={className}
		data-filter-chip
		data-active={active}
		role={kind === "tab" ? "tab" : undefined}
		aria-selected={kind === "tab" ? active : undefined}
		aria-pressed={kind === "toggle" ? active : undefined}
		aria-haspopup={kind === "menu" ? "menu" : undefined}
		aria-expanded={kind === "menu" ? expanded : undefined}
		title={title ?? label}
		{onclick}
	>{@render content()}</button>
{/if}
