<script lang="ts">
import { type Snippet, untrack } from "svelte";
import { prefersReducedMotion } from "svelte/motion";

const {
	keys,
	index,
	enabled = true,
	locked = false,
	onChange,
	onPosition,
	page,
}: {
	keys: readonly string[];
	index: number;
	enabled?: boolean;
	locked?: boolean;
	onChange: (index: number) => void;
	onPosition?: (position: number) => void;
	page: Snippet<[index: number, active: boolean]>;
} = $props();

// Safari lacks `scrollend`, so quiet scrolling settles too.
const SETTLE_QUIET_MS = 120;
const SNAP_TOLERANCE_PX = 2;

let track = $state<HTMLDivElement | null>(null);
let width = $state(0);
let position = $state(untrack(() => index));
let touching = false;
let frame = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let alignedKeys = "";

// Pages in view plus one beyond, so a follow-up flick never lands on a blank page.
const start = $derived(Math.max(0, Math.min(index, Math.floor(position)) - 1));
const end = $derived(
	Math.min(keys.length - 1, Math.max(index, Math.ceil(position)) + 1),
);
const visible = $derived(Math.round(position));

function setPosition(next: number) {
	if (next === position) return;
	position = next;
	onPosition?.(next);
}

function align(el: HTMLDivElement, target: number, jump: boolean) {
	const pageWidth = el.clientWidth;
	if (pageWidth === 0) return false;
	const left = target * pageWidth;
	if (Math.abs(el.scrollLeft - left) <= SNAP_TOLERANCE_PX) {
		setPosition(target);
		return true;
	}
	if (touching) return true;
	const from = Math.round(el.scrollLeft / pageWidth);
	const glide =
		!jump && Math.abs(target - from) === 1 && !prefersReducedMotion.current;
	const behavior = glide ? "smooth" : "instant";
	el.scrollTo({ left, behavior });
	if (behavior === "instant") setPosition(target);
	return true;
}

function settle() {
	const el = track;
	if (!el || touching || el.clientWidth === 0) return;
	const page = Math.round(el.scrollLeft / el.clientWidth);
	if (Math.abs(el.scrollLeft - page * el.clientWidth) > SNAP_TOLERANCE_PX)
		return;
	const next = Math.min(Math.max(page, 0), keys.length - 1);
	setPosition(next);
	if (next !== index) onChange(next);
}

function scheduleSettle() {
	clearTimeout(settleTimer);
	settleTimer = setTimeout(settle, SETTLE_QUIET_MS);
}

function onScroll() {
	scheduleSettle();
	if (frame) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		if (track?.clientWidth) setPosition(track.scrollLeft / track.clientWidth);
	});
}

// A held finger is never "settled", even when the track sits still.
function trackTouches(node: HTMLElement) {
	const start = () => {
		touching = true;
	};
	const end = (event: TouchEvent) => {
		touching = event.touches.length > 0;
		if (!touching) scheduleSettle();
	};
	node.addEventListener("touchstart", start, { passive: true });
	node.addEventListener("touchend", end, { passive: true });
	node.addEventListener("touchcancel", end, { passive: true });
	return () => {
		node.removeEventListener("touchstart", start);
		node.removeEventListener("touchend", end);
		node.removeEventListener("touchcancel", end);
	};
}

$effect(() => {
	const el = track;
	const target = index;
	const signature = keys.join("\n");
	width;
	if (!el || !enabled) return;
	if (untrack(() => align(el, target, signature !== alignedKeys)))
		alignedKeys = signature;
});

$effect(() => () => {
	cancelAnimationFrame(frame);
	clearTimeout(settleTimer);
});
</script>

{#if enabled}
	<div
		bind:this={track}
		bind:clientWidth={width}
		class="pager min-h-0 flex-1"
		class:locked
		data-drawer-swipe-ignore
		onscroll={onScroll}
		onscrollend={settle}
		{@attach trackTouches}
	>
		{#each keys as key, i (key)}
			<div class="pane" inert={i !== visible}>
				{#if i >= start && i <= end}
					{@render page(i, i === index)}
				{/if}
			</div>
		{/each}
	</div>
{:else}
	{#key keys[index]}
		<div class="flex min-h-0 flex-1 flex-col">{@render page(index, true)}</div>
	{/key}
{/if}

<style>
	.pager {
		display: flex;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scroll-snap-type: x mandatory;
		scrollbar-width: none;
	}

	.pager::-webkit-scrollbar {
		display: none;
	}

	.pager.locked {
		overflow-x: hidden;
	}

	.pane {
		display: flex;
		flex: 0 0 100%;
		flex-direction: column;
		min-width: 0;
		contain: content;
		scroll-snap-align: start;
		scroll-snap-stop: always;
	}
</style>
