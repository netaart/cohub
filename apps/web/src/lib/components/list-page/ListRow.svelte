<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAnchorAttributes } from "svelte/elements";
import {
	LIST_ROW_HEIGHT,
	type ListRowDensity,
} from "$lib/components/list-page/list-row";

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
	class="list-row group/row relative flex shrink-0 items-center gap-[var(--list-row-gap)] overflow-hidden rounded-[var(--list-row-radius)] px-[var(--list-row-pad-x)] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35 {stateClass} {className}"
	style:height={`${LIST_ROW_HEIGHT[density]}px`}
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
		--list-avatar-size: 36px;
		--list-title-size: 14px;
		--list-title-leading: 18px;
		--list-subtitle-size: 12px;
		--list-subtitle-leading: 16px;
		--list-meta-size: 11px;
	}

	.list-row[data-density="comfortable"] {
		--list-avatar-size: 48px;
		--list-title-size: 16px;
		--list-title-leading: 22px;
		--list-subtitle-size: 14px;
		--list-subtitle-leading: 20px;
		--list-meta-size: 12px;
	}

	.list-row-leading {
		width: var(--list-avatar-size);
	}
</style>
