<script lang="ts">
import type { Snippet } from "svelte";
import {
	type CohubDragResource,
	setCohubResourceDragData,
} from "$lib/drag/cohub-resource-drag";
import {
	type PointerDragItem,
	pointerDrag,
	pointerDragSource,
} from "$lib/drag/pointer-drag.svelte";

type Props = {
	title: string;
	subtitle?: string;
	active?: boolean;
	disabled?: boolean;
	dimmed?: boolean;
	drag?: {
		resource: CohubDragResource;
		item: PointerDragItem;
		touch: boolean;
	} | null;
	leading: Snippet;
	trailing?: Snippet;
	onOpen: () => void;
};

const {
	title,
	subtitle,
	active = false,
	disabled = false,
	dimmed = false,
	drag = null,
	leading,
	trailing,
	onOpen,
}: Props = $props();

const dragging = $derived(
	Boolean(drag) && pointerDrag.payload?.items[0] === drag?.item,
);
</script>

<div
	class="side-panel-row group"
	class:active
	class:dragging
	class:opacity-60={disabled || dimmed}
	role="listitem"
	draggable={Boolean(drag) && !disabled}
	ondragstart={(event) => {
		if (!drag || disabled) return event.preventDefault();
		setCohubResourceDragData(event.dataTransfer, {
			version: 1,
			resources: [drag.resource],
			origin: { kind: "side-panel" },
		});
	}}
	use:pointerDragSource={{
		enabled: Boolean(drag?.touch) && !disabled,
		getPayload: () =>
			drag ? { origin: "side-panel", items: [drag.item] } : null,
	}}
>
	<button
		type="button"
		class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 text-left disabled:cursor-default"
		aria-current={active ? "true" : undefined}
		{title}
		{disabled}
		onclick={onOpen}
	>
		{@render leading()}
		<span class="min-w-0 flex-1">
			<span class="block truncate text-[12px] leading-4 {active ? 'font-medium text-text-primary' : 'text-text-secondary'}">{title}</span>
			{#if subtitle}
				<span class="block truncate font-mono text-[10px] leading-3 text-text-placeholder">{subtitle}</span>
			{/if}
		</span>
	</button>
	{#if trailing}
		<div class="flex shrink-0 items-center pr-0.5">{@render trailing()}</div>
	{/if}
</div>

<style>
	.side-panel-row {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 2px;
		padding-right: 4px;
		border-radius: var(--sidebar-item-radius, 6px);
		transition: background-color 100ms ease;
	}

	.side-panel-row:hover,
	.side-panel-row.dragging {
		background: var(--sidebar-item-hover-bg, var(--bg-hover));
	}

	.side-panel-row.active {
		background: var(--sidebar-item-active-bg, var(--bg-active));
	}
</style>
