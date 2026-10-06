import { tick } from "svelte";
import {
	FLICK_VELOCITY_PX_PER_MS,
	type GestureAxis,
	resolveGestureAxis,
} from "$lib/gestures/axis-lock";
import { EASE_IN, EASE_OUT } from "$lib/motion.svelte";

export const SWIPE_PAGER_COMMIT_RATIO = 0.28;
export const SWIPE_PAGER_EDGE_GUARD_PX = 20;
export const SWIPE_PAGER_EDGE_RESISTANCE = 0.25;

const EXIT_MS = 110;
const ENTER_MS = 220;
const SETTLE_MS = 180;
const EXIT_SHIFT_RATIO = 0.3;
const ENTER_SHIFT_RATIO = 0.16;
const DRAG_FADE = 0.35;
const CLICK_SUPPRESS_MS = 400;
const IGNORE_SELECTOR =
	"input, textarea, select, [contenteditable='true'], [data-swipe-pager-ignore]";

export function swipePagerOffset(input: {
	dx: number;
	index: number;
	count: number;
}) {
	const { dx, index, count } = input;
	const blocked = (dx > 0 && index <= 0) || (dx < 0 && index >= count - 1);
	return blocked ? dx * SWIPE_PAGER_EDGE_RESISTANCE : dx;
}

export function resolveSwipePagerTarget(input: {
	dx: number;
	velocityX: number;
	width: number;
	index: number;
	count: number;
}): number | null {
	const { dx, velocityX, width, index, count } = input;
	if (dx === 0 || width <= 0) return null;
	const direction = dx < 0 ? 1 : -1;
	const flick =
		Math.abs(velocityX) >= FLICK_VELOCITY_PX_PER_MS &&
		Math.sign(velocityX) === Math.sign(dx);
	if (!flick && Math.abs(dx) < width * SWIPE_PAGER_COMMIT_RATIO) return null;
	const target = index + direction;
	return target >= 0 && target < count ? target : null;
}

export type SwipePagerOptions = {
	index: number;
	count: number;
	enabled?: boolean;
	onChange: (index: number) => void;
};

export function swipePager(node: HTMLElement, initial: SwipePagerOptions) {
	let options = initial;
	let touchId: number | null = null;
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastTime = 0;
	let velocityX = 0;
	let axis: GestureAxis = null;
	let animating = false;
	let suppressClickUntil = 0;

	const syncTouchAction = () => {
		node.style.touchAction =
			options.enabled === false ? "" : "pan-y pinch-zoom";
	};
	syncTouchAction();

	const reducedMotion = () =>
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	function paint(offset: number) {
		const fade = Math.min(Math.abs(offset) / node.clientWidth, 1) * DRAG_FADE;
		node.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
		node.style.opacity = offset ? String(1 - fade) : "";
	}

	function track(touches: TouchList) {
		for (const touch of Array.from(touches))
			if (touch.identifier === touchId) return touch;
		return null;
	}

	function reset() {
		touchId = null;
		axis = null;
		velocityX = 0;
	}

	function onTouchStart(event: TouchEvent) {
		if (touchId !== null || animating || options.enabled === false) return;
		if (options.count < 2 || event.touches.length > 1) return;
		const touch = event.changedTouches[0];
		if (!touch) return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest(IGNORE_SELECTOR)) return;
		const edge = SWIPE_PAGER_EDGE_GUARD_PX;
		if (touch.clientX < edge || touch.clientX > window.innerWidth - edge)
			return;
		touchId = touch.identifier;
		startX = lastX = touch.clientX;
		startY = touch.clientY;
		lastTime = event.timeStamp;
	}

	function onTouchMove(event: TouchEvent) {
		const touch = track(event.touches);
		if (!touch) return;
		const dx = touch.clientX - startX;
		if (!axis) {
			axis = resolveGestureAxis({
				absDx: Math.abs(dx),
				absDy: Math.abs(touch.clientY - startY),
			});
			if (axis === "vertical") {
				reset();
				return;
			}
			if (!axis) return;
		}
		event.preventDefault();
		const dt = event.timeStamp - lastTime;
		if (dt > 0) velocityX = (touch.clientX - lastX) / dt;
		lastX = touch.clientX;
		lastTime = event.timeStamp;
		if (!reducedMotion()) paint(swipePagerOffset({ dx, ...options }));
	}

	async function onTouchEnd(event: TouchEvent) {
		if (touchId === null || !track(event.changedTouches)) return;
		const locked = axis === "horizontal";
		const dx = lastX - startX;
		const velocity = velocityX;
		reset();
		if (!locked) return;
		suppressClickUntil = event.timeStamp + CLICK_SUPPRESS_MS;
		const target = resolveSwipePagerTarget({
			dx,
			velocityX: velocity,
			width: node.clientWidth,
			...options,
		});
		if (reducedMotion()) {
			if (target !== null) options.onChange(target);
			return;
		}
		const from = {
			transform: node.style.transform || "none",
			opacity: node.style.opacity || "1",
		};
		animating = true;
		try {
			if (target === null) {
				paint(0);
				await node.animate([from, { transform: "none", opacity: 1 }], {
					duration: SETTLE_MS,
					easing: EASE_OUT,
				}).finished;
				return;
			}
			const direction = Math.sign(dx);
			const width = node.clientWidth;
			const exit = `translate3d(${direction * width * EXIT_SHIFT_RATIO}px, 0, 0)`;
			await node.animate([from, { transform: exit, opacity: 0 }], {
				duration: EXIT_MS,
				easing: EASE_IN,
				fill: "forwards",
			}).finished;
			paint(0);
			options.onChange(target);
			await tick();
			for (const animation of node.getAnimations()) animation.cancel();
			const enter = `translate3d(${-direction * width * ENTER_SHIFT_RATIO}px, 0, 0)`;
			await node.animate(
				[
					{ transform: enter, opacity: 0 },
					{ transform: "none", opacity: 1 },
				],
				{ duration: ENTER_MS, easing: EASE_OUT },
			).finished;
		} catch {
		} finally {
			animating = false;
			paint(0);
		}
	}

	function onTouchCancel(event: TouchEvent) {
		if (touchId === null || !track(event.changedTouches)) return;
		reset();
		paint(0);
	}

	function onClickCapture(event: MouseEvent) {
		if (event.timeStamp > suppressClickUntil) return;
		event.preventDefault();
		event.stopPropagation();
	}

	node.addEventListener("touchstart", onTouchStart, { passive: true });
	node.addEventListener("touchmove", onTouchMove, { passive: false });
	node.addEventListener("touchend", onTouchEnd);
	node.addEventListener("touchcancel", onTouchCancel);
	node.addEventListener("click", onClickCapture, true);

	return {
		update(next: SwipePagerOptions) {
			options = next;
			syncTouchAction();
		},
		destroy() {
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("touchend", onTouchEnd);
			node.removeEventListener("touchcancel", onTouchCancel);
			node.removeEventListener("click", onClickCapture, true);
			for (const animation of node.getAnimations()) animation.cancel();
			node.style.touchAction = "";
			paint(0);
		},
	};
}
