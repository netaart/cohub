<script lang="ts">
import { drawCropOverlay, drawStroke } from "../mark/draw.ts";
import type { MarkSession } from "../mark/session.svelte.ts";

type Props = {
	session: MarkSession;
	onApplyCrop?: () => void;
};

let { session, onApplyCrop }: Props = $props();

let shellEl: HTMLDivElement | null = $state(null);
let canvasEl: HTMLCanvasElement | null = $state(null);
let drawing = $state(false);

$effect(() => {
	const canvas = canvasEl;
	if (!canvas) return;
	const width = session.frame.width;
	const height = session.frame.height;
	const bitmap = session.frame.bitmap;
	const strokes = session.allStrokes;
	const crop = session.getCropRect();
	const tool = session.tool;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);

	canvas.width = Math.max(1, Math.round(width * dpr));
	canvas.height = Math.max(1, Math.round(height * dpr));
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);
	ctx.drawImage(bitmap, 0, 0, width, height);
	for (const stroke of strokes) drawStroke(ctx, stroke);
	if (tool === "crop") drawCropOverlay(ctx, width, height, crop);
});

function shellRect(): DOMRect | null {
	return shellEl?.getBoundingClientRect() ?? null;
}

function onPointerDown(event: PointerEvent) {
	if (event.button !== 0) return;
	const rect = shellRect();
	if (!rect || !canvasEl) return;
	drawing = true;
	canvasEl.setPointerCapture(event.pointerId);
	const point = session.pointerToFrame(event.clientX, event.clientY, rect);
	session.beginStroke(point);
	event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
	if (!drawing) return;
	const rect = shellRect();
	if (!rect) return;
	const point = session.pointerToFrame(event.clientX, event.clientY, rect);
	session.moveStroke(point);
	event.preventDefault();
}

function onPointerUp(event: PointerEvent) {
	if (!drawing) return;
	drawing = false;
	try {
		canvasEl?.releasePointerCapture(event.pointerId);
	} catch {
		// ignore
	}
	session.endStroke();
}

function onDblClick(event: MouseEvent) {
	if (session.tool !== "crop" || !session.getCropRect()) return;
	event.preventDefault();
	onApplyCrop?.();
}
</script>

<div
	bind:this={shellEl}
	class="mark-frame"
	style={`aspect-ratio: ${session.frame.width} / ${session.frame.height}; --fw: ${session.frame.width}; --fh: ${session.frame.height};`}
>
	<canvas
		bind:this={canvasEl}
		class="mark-canvas"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		ondblclick={onDblClick}
		aria-label="Mark surface"
	></canvas>
</div>

<style>
	.mark-frame {
		position: relative;
		width: min(100%, calc(100cqh * var(--fw) / var(--fh)));
		max-width: 100%;
		max-height: 100%;
		overflow: hidden;
		border-radius: 6px;
		background: var(--bg-primary);
		box-shadow: 0 0 0 1px var(--border-subtle);
		touch-action: none;
		user-select: none;
	}
	.mark-canvas {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: var(--fw) / var(--fh);
		cursor: crosshair;
		touch-action: none;
	}
</style>
