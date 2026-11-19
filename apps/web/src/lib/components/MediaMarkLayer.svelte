<script lang="ts">
import type { ViewportMediaMark } from "@cohub/protocol";
import { X } from "lucide-svelte";
import type { MediaMarkRect } from "#lib/media/media-ask.svelte.ts";

const {
	marks,
	active,
	removeLabel,
	onadd,
	onremove,
}: {
	marks: readonly ViewportMediaMark[];
	active: boolean;
	removeLabel: (n: number) => string;
	onadd: (rect: MediaMarkRect) => void;
	onremove: (n: number) => void;
} = $props();

const MIN_FRACTION = 0.02;

let layerEl = $state<HTMLDivElement | null>(null);
let origin: { x: number; y: number; pointerId: number } | null = null;
let draft = $state<MediaMarkRect | null>(null);

function toFraction(event: PointerEvent) {
	const rect = layerEl?.getBoundingClientRect();
	if (!rect?.width || !rect.height) return null;
	const clamp = (value: number) => Math.min(1, Math.max(0, value));
	return {
		x: clamp((event.clientX - rect.left) / rect.width),
		y: clamp((event.clientY - rect.top) / rect.height),
	};
}

function onPointerDown(event: PointerEvent) {
	if (!active || !event.isPrimary || event.button !== 0) return;
	const point = toFraction(event);
	if (!point) return;
	event.preventDefault();
	event.stopPropagation();
	layerEl?.setPointerCapture(event.pointerId);
	origin = { ...point, pointerId: event.pointerId };
	draft = { ...point, width: 0, height: 0 };
}

function onPointerMove(event: PointerEvent) {
	if (!origin || event.pointerId !== origin.pointerId) return;
	const point = toFraction(event);
	if (!point) return;
	draft = {
		x: Math.min(origin.x, point.x),
		y: Math.min(origin.y, point.y),
		width: Math.abs(point.x - origin.x),
		height: Math.abs(point.y - origin.y),
	};
}

function onPointerUp(event: PointerEvent) {
	if (!origin || event.pointerId !== origin.pointerId) return;
	const rect = draft;
	origin = null;
	draft = null;
	if (rect && rect.width >= MIN_FRACTION && rect.height >= MIN_FRACTION)
		onadd(rect);
}

function onPointerCancel() {
	origin = null;
	draft = null;
}

function box(rect: MediaMarkRect) {
	return `left: ${rect.x * 100}%; top: ${rect.y * 100}%; width: ${rect.width * 100}%; height: ${rect.height * 100}%;`;
}
</script>

<div
	bind:this={layerEl}
	class="layer absolute inset-0"
	class:drawing={active}
	data-lightbox-content
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerCancel}
	role="presentation"
>
	{#each marks as mark (mark.n)}
		<div class="mark" style={box(mark)}>
			{#if active}
				<button
					type="button"
					class="badge group"
					title={removeLabel(mark.n)}
					aria-label={removeLabel(mark.n)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => onremove(mark.n)}
				>
					<span class="group-hover:hidden">{mark.n}</span>
					<X class="hidden h-3 w-3 group-hover:block" />
				</button>
			{:else}
				<span class="badge">{mark.n}</span>
			{/if}
		</div>
	{/each}
	{#if draft}
		<div class="mark draft" style={box(draft)}></div>
	{/if}
</div>

<style>
	.layer {
		pointer-events: none;
		touch-action: none;
	}

	.layer.drawing {
		pointer-events: auto;
		cursor: crosshair;
	}

	.mark {
		position: absolute;
		border: 2px solid var(--brand);
		border-radius: 3px;
		background: color-mix(in srgb, var(--brand) 10%, transparent);
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.18);
	}

	.mark.draft {
		border-style: dashed;
	}

	.badge {
		position: absolute;
		top: -11px;
		right: -11px;
		display: inline-flex;
		min-width: 22px;
		height: 22px;
		align-items: center;
		justify-content: center;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
		pointer-events: auto;
	}

	span.badge {
		pointer-events: none;
	}

	button.badge {
		cursor: pointer;
	}

	@media (pointer: coarse) {
		button.badge::after {
			content: "";
			position: absolute;
			inset: -11px;
		}
	}
</style>
