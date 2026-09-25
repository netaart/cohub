<script lang="ts">
import { Minus, Plus } from "lucide-svelte";
import {
	clampImageZoom,
	createImageGestureHandlers,
	IMAGE_MAX_ZOOM,
	IMAGE_MIN_ZOOM,
	IMAGE_ZOOM_STEP,
	type ImageGestureState,
	imageTransform,
} from "$lib/gestures/image-gesture";

let {
	src,
	alt = "",
	zoom = $bindable(1),
	panX = $bindable(0),
	panY = $bindable(0),
	dragging = $bindable(false),
	showControls = false,
	class: className = "",
	onerror,
}: {
	src: string;
	alt?: string;
	zoom?: number;
	panX?: number;
	panY?: number;
	dragging?: boolean;
	showControls?: boolean;
	class?: string;
	/** The image failed to load; hosts may swap `src` for a fallback. */
	onerror?: () => void;
} = $props();

/** Discrete mouse-wheel notch; trackpad pinch / scroll zoom continuously. */
const WHEEL_STEP = 0.12;
const PINCH_INTENSITY = 0.018;
const SCROLL_INTENSITY = 0.0035;
let stage = $state<HTMLDivElement | null>(null);
let image = $state<HTMLImageElement | null>(null);

function setView(state: ImageGestureState) {
	zoom = state.zoom;
	panX = state.panX;
	panY = state.panY;
}

const gesture = createImageGestureHandlers({
	getState: () => ({ zoom, panX, panY }),
	setState: setView,
	onDraggingChange: (value) => (dragging = value),
});

function reset() {
	gesture.reset();
	setView({ zoom: 1, panX: 0, panY: 0 });
}

function zoomBy(delta: number) {
	setView({ zoom: clampImageZoom(zoom + delta), panX: 0, panY: 0 });
}

function onWheel(event: WheelEvent) {
	event.preventDefault();
	event.stopPropagation();
	let delta = event.deltaY;
	if (event.deltaMode === 1) delta *= 16;
	if (event.deltaMode === 2) delta *= 80;
	if (!delta) return;
	const factor =
		event.ctrlKey || event.metaKey ? PINCH_INTENSITY : SCROLL_INTENSITY;
	if (!event.ctrlKey && !event.metaKey && Math.abs(delta) >= 40) {
		zoomBy(delta < 0 ? WHEEL_STEP : -WHEEL_STEP);
		return;
	}
	setView({
		zoom: clampImageZoom(zoom * Math.exp(-delta * factor)),
		panX,
		panY,
	});
}

const cursor = $derived(dragging ? "grabbing" : zoom > 1 ? "grab" : "zoom-in");

$effect(() => {
	if (!image || !stage) return;
	image.style.transform = imageTransform({ zoom, panX, panY });
});
</script>

<div
	bind:this={stage}
	class="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden touch-none overscroll-none {className}"
	data-drawer-swipe-ignore
	role="group"
	aria-label={alt || "Image preview"}
	style:touch-action="none"
	style:cursor={cursor}
	onpointerdown={gesture.onPointerDown}
	onpointermove={gesture.onPointerMove}
	onpointerup={gesture.onPointerUp}
	onpointercancel={gesture.onPointerCancel}
	onwheel={onWheel}
	ondblclick={reset}
>
	<img
		bind:this={image}
		src={src}
		alt={alt}
		draggable="false"
		{onerror}
		style={`transform: ${imageTransform({ zoom, panX, panY })}; ${dragging ? "" : "transition: transform 150ms ease;"}`}
		class="max-h-full max-w-full select-none will-change-transform"
	/>
	{#if showControls}
		<div class="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-overlay-control px-1.5 py-1 shadow-sm">
			<button
				type="button"
				class="flex h-8 w-8 items-center justify-center rounded-full text-overlay-control-text transition-colors hover:bg-overlay-control-hover disabled:opacity-40"
				onclick={() => zoomBy(-IMAGE_ZOOM_STEP)}
				disabled={zoom <= IMAGE_MIN_ZOOM}
				aria-label="Zoom out"
				title="Zoom out"
			>
				<Minus class="h-4 w-4" />
			</button>
			<button
				type="button"
				class="min-w-11 rounded-full px-1 text-center text-[12px] tabular-nums text-overlay-control-text transition-colors hover:bg-overlay-control-hover"
				onclick={reset}
				aria-label={`Zoom ${Math.round(zoom * 100)} percent. Click to reset`}
				title="Reset zoom"
			>
				{Math.round(zoom * 100)}%
			</button>
			<button
				type="button"
				class="flex h-8 w-8 items-center justify-center rounded-full text-overlay-control-text transition-colors hover:bg-overlay-control-hover disabled:opacity-40"
				onclick={() => zoomBy(IMAGE_ZOOM_STEP)}
				disabled={zoom >= IMAGE_MAX_ZOOM}
				aria-label="Zoom in"
				title="Zoom in"
			>
				<Plus class="h-4 w-4" />
			</button>
		</div>
	{/if}
</div>
