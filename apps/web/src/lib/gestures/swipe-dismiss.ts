/**
 * Horizontal swipe-to-dismiss for transient surfaces (toasts, notifications).
 *
 * Pure helpers keep the decision logic testable; `swipeDismiss` wires them to
 * pointer events and drives the transform directly for a 1:1 finger feel.
 */

import { EASE_OUT } from "$lib/motion";

export const SWIPE_DISMISS_DIRECTION_LOCK_PX = 8;
export const SWIPE_DISMISS_DIRECTION_RATIO = 1.2;
export const SWIPE_DISMISS_DISTANCE_RATIO = 0.32;
export const SWIPE_DISMISS_MIN_DISTANCE_PX = 56;
export const SWIPE_DISMISS_FLICK_VELOCITY_PX_PER_MS = 0.4;
/** Extra travel past the edge so the card is fully offscreen before removal. */
export const SWIPE_DISMISS_EXIT_PADDING_PX = 32;

export type SwipeAxis = "horizontal" | "vertical" | null;

/** Resolve the intended axis once the finger has moved far enough. */
export function resolveSwipeAxis(absDx: number, absDy: number): SwipeAxis {
	if (
		absDx < SWIPE_DISMISS_DIRECTION_LOCK_PX &&
		absDy < SWIPE_DISMISS_DIRECTION_LOCK_PX
	) {
		return null;
	}
	if (absDx > absDy * SWIPE_DISMISS_DIRECTION_RATIO) return "horizontal";
	if (absDy > absDx * SWIPE_DISMISS_DIRECTION_RATIO) return "vertical";
	return null;
}

/** Opacity falls off with travel so the card visibly fades as it leaves. */
export function swipeDismissOpacity(deltaX: number, width: number) {
	if (width <= 0) return 1;
	const progress = Math.min(Math.abs(deltaX) / width, 1);
	return Math.max(1 - progress * 0.85, 0.15);
}

export function shouldDismissOnSwipe(options: {
	deltaX: number;
	velocityX: number;
	width: number;
}) {
	const { deltaX, velocityX, width } = options;
	const distance = Math.abs(deltaX);
	if (distance < SWIPE_DISMISS_DIRECTION_LOCK_PX) return false;
	const threshold = Math.max(
		width * SWIPE_DISMISS_DISTANCE_RATIO,
		SWIPE_DISMISS_MIN_DISTANCE_PX,
	);
	if (distance >= threshold) return true;
	// A quick flick counts even when travel is short, as long as it agrees
	// with the drag direction.
	return (
		Math.abs(velocityX) >= SWIPE_DISMISS_FLICK_VELOCITY_PX_PER_MS &&
		Math.sign(velocityX) === Math.sign(deltaX)
	);
}

export type SwipeDismissOptions = {
	/** Called once the swipe crosses the dismiss threshold and animates out. */
	onDismiss: () => void;
	/** Disable the gesture (e.g. desktop widths). */
	enabled?: boolean;
	/** Exit/settle animation duration in ms. */
	durationMs?: number;
	/** Fired when a finger lands, useful to pause auto-dismiss timers. */
	onGestureStart?: () => void;
	/** Fired when the gesture releases without dismissing. */
	onGestureEnd?: () => void;
};

/**
 * Svelte action: drag a node sideways with the finger, release to dismiss.
 * Touch-only — pointer/mouse drags stay out of the way of clicks and text
 * selection. Vertical intent releases the gesture so page scrolling wins.
 */
export function swipeDismiss(node: HTMLElement, options: SwipeDismissOptions) {
	let opts = options;
	let touchId: number | null = null;
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastTime = 0;
	let velocityX = 0;
	let axis: SwipeAxis = null;
	let dragging = false;
	let swallowClick = false;

	const duration = () => opts.durationMs ?? 180;
	const settleTransition = () =>
		`transform ${duration()}ms ${EASE_OUT}, opacity ${duration()}ms ${EASE_OUT}`;

	function setTransform(deltaX: number) {
		node.style.transform = `translate3d(${deltaX}px, 0, 0)`;
		node.style.opacity = String(
			swipeDismissOpacity(deltaX, node.offsetWidth || 1),
		);
	}

	function clearTransform() {
		node.style.transform = "";
		node.style.opacity = "";
		node.style.transition = "";
	}

	function reset() {
		touchId = null;
		axis = null;
		dragging = false;
		velocityX = 0;
		node.style.willChange = "";
	}

	function settleBack() {
		// Force a style flush so the pending `transition: none` from the drag
		// doesn't swallow the settle animation.
		void node.offsetWidth;
		node.style.transition = settleTransition();
		setTransform(0);
		window.setTimeout(clearTransform, duration());
	}

	function animateOut(deltaX: number) {
		const width = node.offsetWidth || window.innerWidth;
		const target =
			(deltaX < 0 ? -1 : 1) * (width + SWIPE_DISMISS_EXIT_PADDING_PX);
		void node.offsetWidth;
		node.style.transition = settleTransition();
		node.style.transform = `translate3d(${target}px, 0, 0)`;
		node.style.opacity = "0";
		window.setTimeout(() => opts.onDismiss(), duration());
	}

	function findTouch(list: TouchList) {
		if (touchId === null) return null;
		for (const touch of Array.from(list)) {
			if (touch.identifier === touchId) return touch;
		}
		return null;
	}

	function onTouchStart(event: TouchEvent) {
		if (opts.enabled === false || touchId !== null) return;
		const touch = event.changedTouches[0];
		if (!touch) return;
		touchId = touch.identifier;
		startX = touch.clientX;
		startY = touch.clientY;
		lastX = touch.clientX;
		lastTime = event.timeStamp;
		axis = null;
		dragging = false;
		swallowClick = false;
		// Kill any CSS transition so the drag tracks the finger exactly.
		node.style.transition = "none";
		node.style.willChange = "transform, opacity";
		opts.onGestureStart?.();
	}

	function onTouchMove(event: TouchEvent) {
		const touch = findTouch(event.touches);
		if (!touch) return;
		const deltaX = touch.clientX - startX;
		const deltaY = touch.clientY - startY;

		if (axis === null) {
			axis = resolveSwipeAxis(Math.abs(deltaX), Math.abs(deltaY));
			if (axis === null) return;
			if (axis === "vertical") {
				reset();
				clearTransform();
				opts.onGestureEnd?.();
				return;
			}
		}

		const elapsed = Math.max(event.timeStamp - lastTime, 1);
		velocityX = (touch.clientX - lastX) / elapsed;
		lastX = touch.clientX;
		lastTime = event.timeStamp;

		dragging = true;
		swallowClick = true;
		setTransform(deltaX);
		// Keep the shell drawer gesture and browser scroll out of this drag.
		event.stopPropagation();
		if (event.cancelable) event.preventDefault();
	}

	function finish(event: TouchEvent) {
		const touch = findTouch(event.changedTouches);
		if (!touch) return;
		const deltaX = touch.clientX - startX;
		const wasDragging = dragging;
		reset();
		if (!wasDragging) {
			clearTransform();
			opts.onGestureEnd?.();
			return;
		}
		if (
			shouldDismissOnSwipe({ deltaX, velocityX, width: node.offsetWidth || 1 })
		) {
			animateOut(deltaX);
			return;
		}
		settleBack();
		opts.onGestureEnd?.();
	}

	function onClickCapture(event: MouseEvent) {
		if (!swallowClick) return;
		swallowClick = false;
		event.preventDefault();
		event.stopPropagation();
	}

	node.addEventListener("touchstart", onTouchStart, { passive: true });
	node.addEventListener("touchmove", onTouchMove, { passive: false });
	node.addEventListener("touchend", finish, { passive: true });
	node.addEventListener("touchcancel", finish, { passive: true });
	node.addEventListener("click", onClickCapture, true);

	return {
		update(next: SwipeDismissOptions) {
			opts = next;
		},
		destroy() {
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("touchend", finish);
			node.removeEventListener("touchcancel", finish);
			node.removeEventListener("click", onClickCapture, true);
		},
	};
}
