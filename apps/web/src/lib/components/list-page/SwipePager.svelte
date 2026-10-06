<script lang="ts">
import { type Snippet, untrack } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { POINTER_DRAG_CLICK_SUPPRESS_MS } from "$lib/drag/pointer-drag-core";
import { resolveGestureAxis } from "$lib/gestures/axis-lock";
import {
	addSample,
	glideTiming,
	type PagerGlide,
	type PagerSample,
	releasePage,
} from "$lib/gestures/pager";
import {
	canScrollHorizontally,
	isTextEditingTarget,
} from "$lib/gestures/pager-yield";

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
	onPosition?: (position: number, glide: PagerGlide | null) => void;
	page: Snippet<[index: number, active: boolean]>;
} = $props();

const EDGE_RESISTANCE = 0.3;

type Drag = {
	id: number;
	target: EventTarget | null;
	x: number;
	y: number;
	from: number;
	axis: "x" | null;
	samples: PagerSample[];
	resume: number | null;
	passive: boolean;
	unfollow: AbortController;
};

let root = $state<HTMLDivElement | null>(null);
let track = $state<HTMLDivElement | null>(null);
let position = $state(untrack(() => index));
let trail = $state(untrack(() => index));
let warm = $state<number | null>(null);
let animation: Animation | null = null;
let heading: number | null = null;
let drag: Drag | null = null;
let suppressClickUntil = 0;
let alignedKeys = "";
let warmToken = 0;

const low = $derived(Math.min(index, Math.floor(Math.min(position, trail))));
const high = $derived(Math.max(index, Math.ceil(Math.max(position, trail))));
const mounted = (i: number) =>
	(i >= low && i <= high) || (warm !== null && Math.abs(i - warm) <= 1);

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);
const translate = (value: number) => `translate3d(${-value * 100}%, 0, 0)`;

function setPosition(next: number, glide: PagerGlide | null = null) {
	if (next === position) return;
	position = next;
	onPosition?.(next, glide);
}

function visualPosition() {
	if (!animation || !track || !root?.clientWidth) return position;
	const x = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
	return -x / root.clientWidth;
}

function cancelGlide() {
	animation?.cancel();
	animation = null;
	heading = null;
}

function warmSoon(page: number) {
	const token = ++warmToken;
	requestAnimationFrame(() =>
		setTimeout(() => {
			if (token === warmToken && drag?.axis !== "x") warm = page;
		}),
	);
}

function stop() {
	if (!animation) return;
	const current = visualPosition();
	cancelGlide();
	trail = current;
	setPosition(current);
}

function jump(target: number) {
	cancelGlide();
	trail = target;
	setPosition(target);
	warmSoon(target);
}

function land(target: number) {
	warmSoon(target);
	if (target !== index) onChange(target);
}

// A caught glide never lands, so rapid flicks commit once.
function glide(target: number, speed = 0) {
	const from = visualPosition();
	cancelGlide();
	const distance = Math.abs(target - from) * (root?.clientWidth ?? 0);
	if (!track || distance < 1 || prefersReducedMotion.current) {
		trail = target;
		setPosition(target);
		land(target);
		return;
	}
	const timing = glideTiming(distance, speed);
	trail = from;
	setPosition(target, timing);
	const current = track.animate(
		[{ transform: translate(from) }, { transform: translate(target) }],
		timing,
	);
	current.onfinish = () => {
		if (animation !== current) return;
		animation = null;
		heading = null;
		trail = target;
		land(target);
	};
	animation = current;
	heading = target;
	warmSoon(target);
}

function gestures(node: HTMLElement) {
	const find = (touches: TouchList) =>
		Array.from(touches).find((touch) => touch.identifier === drag?.id);

	// Touch events keep going to a target removed mid-drag, but no longer bubble
	// here, so the target relays them once it has left the pager.
	const follow = (target: EventTarget | null) => {
		const unfollow = new AbortController();
		if (!(target instanceof Node)) return unfollow;
		const relay = (handler: (event: TouchEvent) => void) => (event: Event) => {
			if (!node.contains(target)) handler(event as TouchEvent);
		};
		const options = { passive: false, signal: unfollow.signal };
		target.addEventListener("touchmove", relay(onMove), options);
		target.addEventListener("touchend", relay(onEnd), options);
		target.addEventListener("touchcancel", relay(onEnd), options);
		return unfollow;
	};

	const finish = (timeStamp: number, release: boolean) => {
		const current = drag;
		drag = null;
		if (!current) return;
		current.unfollow.abort();
		if (current.axis !== "x") {
			if (current.resume === null) return;
			suppressClickUntil = timeStamp + POINTER_DRAG_CLICK_SUPPRESS_MS;
			glide(current.resume);
			return;
		}
		suppressClickUntil = timeStamp + POINTER_DRAG_CLICK_SUPPRESS_MS;
		const { target, speed } = release
			? releasePage({
					samples: current.samples,
					originX: current.x,
					releasedAt: timeStamp,
					position,
					count: keys.length,
				})
			: { target: clamp(Math.round(position), 0, keys.length - 1), speed: 0 };
		glide(target, speed);
	};

	const onStart = (event: TouchEvent) => {
		if (locked || event.touches.length > 1) return;
		if (drag) finish(event.timeStamp, false);
		const touch = event.changedTouches[0];
		if (!touch || isTextEditingTarget(event.target)) return;
		const resume = heading;
		stop();
		drag = {
			id: touch.identifier,
			target: event.target,
			x: touch.clientX,
			y: touch.clientY,
			from: position,
			axis: null,
			samples: [],
			resume,
			passive: !event.cancelable,
			unfollow: follow(event.target),
		};
	};

	const onMove = (event: TouchEvent) => {
		const touch = drag && find(event.touches);
		if (!drag || !touch) return;
		if (locked || event.touches.length > 1) {
			finish(event.timeStamp, false);
			return;
		}
		if (!drag.axis) {
			const dx = touch.clientX - drag.x;
			const axis = resolveGestureAxis({
				absDx: Math.abs(dx),
				absDy: Math.abs(touch.clientY - drag.y),
			});
			if (!axis) return;
			// An uncancellable move means a browser scroll owns the touch, unless it
			// only stopped a fling: pan-y still keeps the browser off the x axis.
			if (
				axis === "vertical" ||
				(!event.cancelable && !drag.passive) ||
				canScrollHorizontally(drag.target, node, dx)
			) {
				finish(event.timeStamp, false);
				return;
			}
			stop();
			drag.axis = "x";
			drag.from = position;
			drag.x = touch.clientX;
		}
		if (event.cancelable) event.preventDefault();
		const max = keys.length - 1;
		let next = drag.from - (touch.clientX - drag.x) / node.clientWidth;
		if (next < 0) next *= EDGE_RESISTANCE;
		else if (next > max) next = max + (next - max) * EDGE_RESISTANCE;
		setPosition(next);
		addSample(drag.samples, event.timeStamp, touch.clientX);
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

	untrack(() => {
		onPosition?.(position, null);
		warmSoon(index);
	});
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
		cancelGlide();
		drag?.unfollow.abort();
		drag = null;
		warmToken += 1;
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
			else jump(target);
		}
		alignedKeys = signature;
	});
});
</script>

{#if enabled}
	<div bind:this={root} class="pager min-h-0 flex-1" data-drawer-swipe-ignore {@attach gestures}>
		<div bind:this={track} class="track" style:transform={translate(position)}>
			{#each keys as key, i (key)}
				<div class="pane" inert={i !== index}>
					{#if mounted(i)}
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
		overflow: clip;
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
