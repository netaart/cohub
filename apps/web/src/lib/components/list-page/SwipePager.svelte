<script lang="ts">
import { type Snippet, untrack } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { POINTER_DRAG_CLICK_SUPPRESS_MS } from "$lib/drag/pointer-drag-core";
import { FLICK_VELOCITY_PX_PER_MS } from "$lib/gestures/axis-lock";

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

const AXIS_LOCK_PX = 10;
const AXIS_RATIO = 1.5;
const FLICK_MIN_PX = 24;
const VELOCITY_WINDOW_MS = 100;
const EDGE_RESISTANCE = 0.3;
const GLIDE_MIN_MS = 140;
const GLIDE_MAX_MS = 240;

type Drag = {
	id: number;
	x: number;
	y: number;
	from: number;
	axis: "x" | "y" | null;
	samples: { t: number; x: number }[];
};

let root = $state<HTMLDivElement | null>(null);
let track = $state<HTMLDivElement | null>(null);
let position = $state(untrack(() => index));
let animation: Animation | null = null;
let drag: Drag | null = null;
let suppressClickUntil = 0;
let alignedKeys = "";

// Pages in view plus one beyond, so a follow-up flick never lands on a blank page.
const start = $derived(Math.max(0, Math.min(index, Math.floor(position)) - 1));
const end = $derived(
	Math.min(keys.length - 1, Math.max(index, Math.ceil(position)) + 1),
);
const visible = $derived(Math.round(position));

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);
const translate = (value: number) => `translate3d(${-value * 100}%, 0, 0)`;

function setPosition(next: number) {
	if (next === position) return;
	position = next;
	onPosition?.(next);
}

function visualPosition() {
	if (!animation || !track || !root?.clientWidth) return position;
	const x = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
	return -x / root.clientWidth;
}

function stop() {
	const current = visualPosition();
	animation?.cancel();
	animation = null;
	setPosition(current);
}

// A caught glide never lands, so rapid flicks commit once.
function glide(target: number, speed = 0, landed?: () => void) {
	const from = visualPosition();
	animation?.cancel();
	animation = null;
	setPosition(target);
	const distance = Math.abs(target - from) * (root?.clientWidth ?? 0);
	if (!track || distance < 1 || prefersReducedMotion.current) {
		landed?.();
		return;
	}
	const duration = clamp(
		(2 * distance) / Math.max(speed, 1),
		GLIDE_MIN_MS,
		GLIDE_MAX_MS,
	);
	const y1 = clamp(((speed * duration) / distance) * 0.25, 0.4, 1);
	const current = track.animate(
		[{ transform: translate(from) }, { transform: translate(target) }],
		{ duration, easing: `cubic-bezier(0.25, ${y1}, 0.3, 1)` },
	);
	current.onfinish = () => {
		if (animation !== current) return;
		animation = null;
		landed?.();
	};
	animation = current;
}

function releaseTarget(drag: Drag, timeStamp: number) {
	const first = drag.samples[0];
	const last = drag.samples.at(-1);
	const fresh = first && last && timeStamp - last.t < VELOCITY_WINDOW_MS / 2;
	const velocity =
		fresh && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
	const moved = (last?.x ?? drag.x) - drag.x;
	const flick =
		Math.abs(velocity) >= FLICK_VELOCITY_PX_PER_MS &&
		Math.abs(moved) >= FLICK_MIN_PX;
	const target = flick
		? velocity < 0
			? Math.floor(position) + 1
			: Math.ceil(position) - 1
		: Math.round(position);
	return {
		target: clamp(target, 0, keys.length - 1),
		speed: Math.abs(velocity),
	};
}

function gestures(node: HTMLElement) {
	const find = (touches: TouchList) =>
		Array.from(touches).find((touch) => touch.identifier === drag?.id);

	const onStart = (event: TouchEvent) => {
		if (drag || locked || event.touches.length > 1) return;
		const touch = event.changedTouches[0];
		if (!touch) return;
		drag = {
			id: touch.identifier,
			x: touch.clientX,
			y: touch.clientY,
			from: position,
			axis: null,
			samples: [],
		};
	};

	const onMove = (event: TouchEvent) => {
		const touch = drag && find(event.touches);
		if (!drag || !touch) return;
		if (locked || event.touches.length > 1) {
			finish(event.timeStamp, false);
			return;
		}
		const dx = touch.clientX - drag.x;
		if (!drag.axis) {
			const dy = touch.clientY - drag.y;
			if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
			if (Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO || !event.cancelable) {
				drag = null;
				return;
			}
			stop();
			drag.axis = "x";
			drag.from = position;
			drag.x = touch.clientX;
		}
		event.preventDefault();
		const max = keys.length - 1;
		let next = drag.from - (touch.clientX - drag.x) / node.clientWidth;
		if (next < 0) next *= EDGE_RESISTANCE;
		else if (next > max) next = max + (next - max) * EDGE_RESISTANCE;
		setPosition(next);
		drag.samples.push({ t: event.timeStamp, x: touch.clientX });
		while (event.timeStamp - drag.samples[0].t > VELOCITY_WINDOW_MS)
			drag.samples.shift();
	};

	const finish = (timeStamp: number, release: boolean) => {
		const current = drag;
		drag = null;
		if (current?.axis !== "x") return;
		suppressClickUntil = timeStamp + POINTER_DRAG_CLICK_SUPPRESS_MS;
		const { target, speed } = release
			? releaseTarget(current, timeStamp)
			: { target: clamp(Math.round(position), 0, keys.length - 1), speed: 0 };
		glide(target, speed, () => {
			if (target !== index) onChange(target);
		});
	};

	const onEnd = (event: TouchEvent) => {
		if (drag && find(event.changedTouches))
			finish(event.timeStamp, event.type === "touchend");
	};

	const onClick = (event: MouseEvent) => {
		if (event.timeStamp > suppressClickUntil) return;
		event.preventDefault();
		event.stopPropagation();
	};

	node.addEventListener("touchstart", onStart, { passive: true });
	node.addEventListener("touchmove", onMove, { passive: false });
	node.addEventListener("touchend", onEnd);
	node.addEventListener("touchcancel", onEnd);
	node.addEventListener("click", onClick, true);
	return () => {
		node.removeEventListener("touchstart", onStart);
		node.removeEventListener("touchmove", onMove);
		node.removeEventListener("touchend", onEnd);
		node.removeEventListener("touchcancel", onEnd);
		node.removeEventListener("click", onClick, true);
		animation?.cancel();
	};
}

$effect(() => {
	const target = index;
	const signature = keys.join("\n");
	if (!enabled) {
		alignedKeys = "";
		return;
	}
	untrack(() => {
		if (drag?.axis !== "x" && target !== position) {
			const near = Math.abs(target - Math.round(position)) === 1;
			if (signature === alignedKeys && near) glide(target);
			else {
				stop();
				setPosition(target);
			}
		}
		alignedKeys = signature;
	});
});
</script>

{#if enabled}
	<div bind:this={root} class="pager min-h-0 flex-1" data-drawer-swipe-ignore {@attach gestures}>
		<div bind:this={track} class="track" style:transform={translate(position)}>
			{#each keys as key, i (key)}
				<div class="pane" inert={i !== visible}>
					{#if i >= start && i <= end}
						{@render page(i, i === index)}
					{/if}
				</div>
			{/each}
		</div>
	</div>
{:else}
	{#key keys[index]}
		<div class="flex min-h-0 flex-1 flex-col">{@render page(index, true)}</div>
	{/key}
{/if}

<style>
	.pager {
		display: flex;
		overflow: hidden;
		touch-action: pan-y pinch-zoom;
	}

	.track {
		display: flex;
		flex: 1;
		min-width: 0;
		will-change: transform;
	}

	.pane {
		display: flex;
		flex: 0 0 100%;
		flex-direction: column;
		min-width: 0;
		contain: content;
	}
</style>
