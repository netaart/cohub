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
	text,
	showLabel = false,
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
	text?: string;
	showLabel?: boolean;
	ref?: HTMLElement | null;
} = $props();

const className = $derived(
	`relative flex h-10 shrink-0 items-center justify-center rounded-[8px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:pointer-events-none disabled:opacity-50 lg:h-7 lg:rounded-[6px] ${text ? "max-w-40 gap-1.5 px-2.5 lg:px-2" : showLabel ? "w-10 sm:w-auto sm:gap-1.5 sm:px-2.5" : "w-10 lg:w-7"} ${
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
	<Icon class="h-5 w-5 shrink-0 lg:h-4 lg:w-4" strokeWidth={1.9} />
	{#if showLabel}<span class="hidden whitespace-nowrap text-[12px] sm:inline">{label}</span>{/if}
	{#if text}<span class="min-w-0 truncate text-[13px] lg:text-[12px]">{text}</span>{/if}
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
