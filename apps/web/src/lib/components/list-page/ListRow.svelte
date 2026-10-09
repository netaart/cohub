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

const height = $derived(
	density === "dense" ? undefined : `${LIST_ROW_HEIGHT[density]}px`,
);
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
	style:height={height}
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
		--list-title-color: var(--color-text-primary);
		--list-title-weight: 500;
		--list-subtitle-color: var(--color-text-tertiary);
		--list-meta-color: var(--color-text-placeholder);
	}

	.list-row[data-density="comfortable"] {
		--list-avatar-size: 48px;
		--list-title-size: 16px;
		--list-title-leading: 22px;
		--list-subtitle-size: 14px;
		--list-subtitle-leading: 20px;
		--list-meta-size: 12px;
		--list-subtitle-color: color-mix(
			in oklab,
			var(--color-text-tertiary) 60%,
			var(--color-text-placeholder)
		);
	}

	.list-row[data-density="dense"] {
		--list-title-size: 13px;
		--list-title-leading: 16px;
		--list-subtitle-size: 10px;
		--list-subtitle-leading: 14px;
		--list-meta-size: 9.5px;
		--list-title-color: var(--color-text-tertiary);
		--list-title-weight: 400;
		--list-subtitle-color: var(--color-text-placeholder);
		--list-meta-color: color-mix(
			in oklab,
			var(--color-text-placeholder) 70%,
			transparent
		);
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
</style>
