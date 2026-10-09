<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";
import {
	getFilterBarPill,
	hasFilterBarPill,
} from "$lib/components/list-page/filter-bar";

let {
	label,
	active = false,
	href,
	onclick,
	kind = "tab",
	tone = "brand",
	title,
	leading,
	trailing,
	ref = $bindable(null),
	...rest
}: {
	label: string;
	active?: boolean;
	href?: string;
	onclick?: (event: MouseEvent) => void;
	kind?: "tab" | "toggle" | "action";
	tone?: "brand" | "neutral";
	title?: string;
	leading?: Snippet;
	trailing?: Snippet;
	ref?: HTMLElement | null;
} & Pick<
	HTMLAttributes<HTMLElement>,
	"id" | "tabindex" | "aria-controls" | "onkeydown"
> = $props();

const barPill = hasFilterBarPill() ? getFilterBarPill() : null;
const onPill = $derived(Boolean(barPill?.()));

const activeClass = $derived(
	tone === "neutral"
		? "bg-bg-hover-strong text-text-primary"
		: onPill
			? "text-brand-muted-fg"
			: "bg-brand-muted text-brand-muted-fg hover:bg-brand-muted-hover",
);

const className = $derived(
	`relative inline-flex h-8 max-w-[200px] shrink-0 select-none items-center gap-1.5 rounded-[7px] px-[var(--list-row-pad-x)] text-[12px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:h-7 lg:rounded-[6px] ${
		active
			? activeClass
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
		{...rest}
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
		{...rest}
		bind:this={ref}
		type="button"
		class={className}
		data-filter-chip
		data-active={active}
		role={kind === "tab" ? "tab" : undefined}
		aria-selected={kind === "tab" ? active : undefined}
		aria-pressed={kind === "toggle" ? active : undefined}
		title={title ?? label}
		{onclick}
	>{@render content()}</button>
{/if}
