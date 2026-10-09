<script lang="ts">
/**
 * Ghost that follows the finger during a touch/pen drag.
 *
 * Mounted once per app shell. It is purely presentational — all state comes
 * from the pointer drag controller — and never takes pointer events, so it
 * cannot interfere with the hit testing that resolves the drop target.
 */
import { AppWindow, File as FileIcon, Folder, Layers } from "lucide-svelte";
import {
	POINTER_DRAG_SETTLE_MS,
	pointerDrag,
} from "$lib/drag/pointer-drag.svelte";
import { EASE_OUT } from "$lib/motion.svelte";

/** Offset so the card sits above-right of the fingertip, not under it. */
const OFFSET_X = 14;
const OFFSET_Y = -46;

const visible = $derived(pointerDrag.active || pointerDrag.settling);
const payload = $derived(pointerDrag.payload);
const firstItem = $derived(payload?.items[0] ?? null);
const multiple = $derived(pointerDrag.itemCount > 1);

const position = $derived.by(() => {
	if (pointerDrag.settling && pointerDrag.settleTo) return pointerDrag.settleTo;
	return { x: pointerDrag.x, y: pointerDrag.y };
});

const ghostStyle = $derived.by(() => {
	const transform = `translate3d(${position.x + OFFSET_X}px, ${position.y + OFFSET_Y}px, 0)`;
	if (pointerDrag.settling) {
		return `transform: ${transform} scale(0.82); opacity: 0; transition: transform ${POINTER_DRAG_SETTLE_MS}ms ${EASE_OUT}, opacity ${POINTER_DRAG_SETTLE_MS}ms ease-out;`;
	}
	return `transform: ${transform}; transition: none;`;
});
</script>

<div class="drag-ghost-layer" aria-hidden="true">
	{#if visible && firstItem}
		<div class="ghost" class:ghost--dropping={Boolean(pointerDrag.intent)} style={ghostStyle}>
			<div class="ghost-card">
				<span class="ghost-icon">
					{#if multiple}
						<Layers class="h-3.5 w-3.5" />
					{:else if firstItem.type === "dir"}
						<Folder class="h-3.5 w-3.5" />
					{:else if firstItem.type === "app"}
						{#if firstItem.icon}
							<img src={firstItem.icon} alt="" class="h-3.5 w-3.5 rounded-[3px] object-cover" decoding="async" />
						{:else}
							<AppWindow class="h-3.5 w-3.5" />
						{/if}
					{:else}
						<FileIcon class="h-3.5 w-3.5" />
					{/if}
				</span>
				<span class="ghost-name">{pointerDrag.label}</span>
				{#if multiple}
					<span class="ghost-count">{pointerDrag.itemCount}</span>
				{/if}
			</div>
			<div class="ghost-hint" class:ghost-hint--idle={!pointerDrag.intent}>
				{pointerDrag.intent?.label ?? "Drag onto a board"}
			</div>
		</div>
	{/if}
</div>

<!-- Announce pickup and drop for assistive tech, without stealing focus. -->
<div class="sr-only" aria-live="polite" role="status">{pointerDrag.announcement}</div>

<style>
	.drag-ghost-layer {
		position: fixed;
		inset: 0;
		z-index: var(--z-drag);
		pointer-events: none;
	}

	.ghost {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		will-change: transform;
	}

	.ghost-card {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
		padding: 7px 10px;
		border: 1px solid var(--border-primary);
		border-radius: 8px;
		background: var(--bg-elevated);
		color: var(--text-primary);
		font-size: 12px;
		line-height: 1.2;
		box-shadow: 0 10px 24px
			color-mix(in srgb, var(--overlay-scrim-strong) 26%, transparent);
		/* Slight lift and tilt reads as "held", without becoming decorative. */
		transform: rotate(-1.5deg);
	}

	.ghost--dropping .ghost-card {
		border-color: var(--brand);
		transform: rotate(-1.5deg) scale(1.02);
	}

	.ghost-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-tertiary);
	}

	.ghost--dropping .ghost-icon {
		color: var(--brand);
	}

	.ghost-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ghost-count {
		flex-shrink: 0;
		padding: 1px 5px;
		border-radius: 999px;
		background: var(--bg-hover-strong);
		color: var(--text-secondary);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.ghost-hint {
		margin-left: 4px;
		padding: 3px 7px;
		border-radius: 5px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.01em;
		white-space: nowrap;
	}

	.ghost-hint--idle {
		background: var(--bg-hover-strong);
		color: var(--text-tertiary);
	}

	@media (prefers-reduced-motion: reduce) {
		.ghost-card,
		.ghost--dropping .ghost-card {
			transform: none;
		}
	}
</style>
