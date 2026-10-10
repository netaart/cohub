<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAnchorAttributes } from "svelte/elements";
import type { ListRowDensity } from "$lib/components/list-page/list-row";

type Props = Omit<HTMLAnchorAttributes, "children" | "class"> & {
	density: ListRowDensity;
	href?: string;
	active?: boolean;
	selected?: boolean;
	class?: string;
	ref?: HTMLElement | null;
	leading?: Snippet;
	children: Snippet;
	trailing?: Snippet;
};

let {
	density,
	href,
	active = false,
	selected = false,
	class: className = "",
	ref = $bindable(null),
	leading,
	children,
	trailing,
	...rest
}: Props = $props();

const stateClass = $derived(
	selected
		? "bg-brand-muted"
		: active
			? "bg-[var(--list-row-active-bg)]"
			: "hover:bg-[var(--list-row-hover-bg)]",
);
</script>

<svelte:element
	this={href ? "a" : "div"}
	bind:this={ref}
	{href}
	data-density={density}
	data-active={active || undefined}
	class="list-row group/row relative flex shrink-0 items-center gap-[var(--list-row-gap)] overflow-hidden rounded-[var(--list-row-radius)] px-[var(--list-row-pad-x)] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35 {stateClass} {className}"
	{...rest}
>
	{#if leading}
		<span class="list-row-leading relative flex h-full shrink-0 items-center justify-center">
			{@render leading()}
		</span>
	{/if}
	{@render children()}
	{@render trailing?.()}
</svelte:element>

<style>
	.list-row {
		height: var(--list-row-height);
	}

	.list-row[data-density="dense"] {
		min-height: 28px;
		padding-block: 6px;
	}

	@media (hover: hover) {
		.list-row[data-density="dense"]:hover {
			--list-title-color: var(--color-text-secondary);
		}
	}

	.list-row[data-density="dense"][data-active] {
		--list-title-color: var(--sidebar-item-active-fg);
		--list-title-weight: 500;
	}

	.list-row-leading {
		width: var(--list-avatar-size);
	}

	/* Avatar box follows the density token. */
	.list-row-leading > :global(.avatar) {
		width: var(--list-avatar-size);
		height: var(--list-avatar-size);
	}
</style>
