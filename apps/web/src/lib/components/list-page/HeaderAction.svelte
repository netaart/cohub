<script lang="ts">
import type { Search } from "lucide-svelte";

let {
	label,
	icon: Icon,
	href,
	onclick,
	tone = "default",
	disabled = false,
	shortcut,
	expanded,
	indicator = false,
	ref = $bindable(null),
}: {
	label: string;
	icon: typeof Search;
	href?: string;
	onclick?: (event: MouseEvent) => void;
	tone?: "default" | "brand";
	disabled?: boolean;
	shortcut?: string;
	expanded?: boolean;
	indicator?: boolean;
	ref?: HTMLElement | null;
} = $props();

const className = $derived(
	`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:pointer-events-none disabled:opacity-50 lg:h-7 lg:w-7 lg:rounded-[6px] ${
		tone === "brand"
			? "text-brand hover:bg-brand-muted"
			: expanded
				? "bg-bg-hover text-text-primary"
				: "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
	}`,
);
const title = $derived(shortcut ? `${label} (${shortcut})` : label);
</script>

{#snippet content()}
	<Icon class="h-5 w-5 lg:h-4 lg:w-4" strokeWidth={1.9} />
	{#if indicator}
		<span class="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand lg:right-[3px] lg:top-[3px]" aria-hidden="true"></span>
	{/if}
{/snippet}

{#if href && !disabled}
	<a bind:this={ref} {href} class={className} aria-label={label} {title} {onclick}>
		{@render content()}
	</a>
{:else}
	<button
		bind:this={ref}
		type="button"
		class={className}
		aria-label={label}
		aria-haspopup={expanded === undefined ? undefined : "menu"}
		aria-expanded={expanded}
		{title}
		{disabled}
		{onclick}
	>
		{@render content()}
	</button>
{/if}
