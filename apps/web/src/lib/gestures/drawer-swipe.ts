import {
	FLICK_VELOCITY_PX_PER_MS,
	type GestureAxis,
	resolveGestureAxis,
} from "$lib/gestures/axis-lock";
import { DESKTOP_SHELL_MIN_WIDTH_PX } from "$lib/layout/breakpoints";

export const MOBILE_DRAWER_WIDTH_PX = 280;
export const MOBILE_DRAWER_MAX_WIDTH_VW = 85;
export const MOBILE_DRAWER_OPEN_THRESHOLD_RATIO = 0.26;
export const MOBILE_DRAWER_CLOSE_THRESHOLD_RATIO = 0.74;
export const MOBILE_DRAWER_FLICK_VELOCITY_PX_PER_MS = FLICK_VELOCITY_PX_PER_MS;
export const EDGE_ZONE_RATIO = 1 / 3;

const INTERACTIVE_SELECTORS = [
	"input",
	"textarea",
	"select",
	"button",
	"a",
	"label",
	"summary",
	"[contenteditable='true']",
	"[data-drawer-swipe-ignore]",
].join(", ");

const OPEN_DRAWER_GESTURE_BLOCKING_SELECTORS = [
	"input",
	"textarea",
	"select",
	"[contenteditable='true']",
	"[data-drawer-swipe-ignore]",
].join(", ");

/**
 * Check if the touch target is inside an interactive element.
 */
export function isTouchOnInteractive(target: EventTarget | null): boolean {
	const element = target instanceof Element ? target : null;
	if (!element) return false;
	return !!element.closest(INTERACTIVE_SELECTORS);
}

/**
 * Check whether an opened drawer should avoid taking over this touch target.
 * Closing gestures may start from buttons/links, but not from text-editing or
 * explicitly ignored regions.
 */
export function isTouchOnGestureBlockingElementWhenOpen(
	target: EventTarget | null,
): boolean {
	const element = target instanceof Element ? target : null;
	if (!element) return false;
	return !!element.closest(OPEN_DRAWER_GESTURE_BLOCKING_SELECTORS);
}

export type DrawerGesturePhase =
	| "idle"
	| "tracking"
	| "dragging-open"
	| "dragging-close"
	| "settling";

export type DrawerGestureDirection = GestureAxis;

export function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

export function getDrawerOpenRatio(offsetPx: number) {
	return clamp(offsetPx / MOBILE_DRAWER_WIDTH_PX, 0, 1);
}

export function shouldStartDrawerGesture(options: {
	isOpen: boolean;
	target: EventTarget | null;
	viewportWidth: number;
	touchStartX: number;
	otherDrawerOpen: boolean;
}) {
	const { isOpen, target, viewportWidth, touchStartX, otherDrawerOpen } =
		options;
	if (viewportWidth >= DESKTOP_SHELL_MIN_WIDTH_PX) return false;
	if (otherDrawerOpen) return false;
	if (isOpen) {
		return !isTouchOnGestureBlockingElementWhenOpen(target);
	}
	if (isTouchOnInteractive(target)) return false;

	// When closed, only allow from the left edge zone (leftmost 2/5 of screen)
	const edgeZoneEnd = viewportWidth * EDGE_ZONE_RATIO;
	if (touchStartX > edgeZoneEnd) return false;

	return true;
}

export const resolveDrawerGestureDirection = resolveGestureAxis;

export function getDrawerOffsetFromDrag(options: {
	isOpen: boolean;
	deltaX: number;
}) {
	const { isOpen, deltaX } = options;
	if (isOpen) {
		return clamp(MOBILE_DRAWER_WIDTH_PX + deltaX, 0, MOBILE_DRAWER_WIDTH_PX);
	}
	return clamp(deltaX, 0, MOBILE_DRAWER_WIDTH_PX);
}

export function shouldOpenDrawer(options: {
	offsetPx: number;
	velocityX: number;
}) {
	const { offsetPx, velocityX } = options;
	const ratio = getDrawerOpenRatio(offsetPx);
	return (
		velocityX >= MOBILE_DRAWER_FLICK_VELOCITY_PX_PER_MS ||
		ratio >= MOBILE_DRAWER_OPEN_THRESHOLD_RATIO
	);
}

export function shouldKeepDrawerOpen(options: {
	offsetPx: number;
	velocityX: number;
}) {
	const { offsetPx, velocityX } = options;
	const ratio = getDrawerOpenRatio(offsetPx);
	return (
		velocityX > -MOBILE_DRAWER_FLICK_VELOCITY_PX_PER_MS &&
		ratio > 1 - MOBILE_DRAWER_CLOSE_THRESHOLD_RATIO
	);
}

// ─── Right drawer helpers (mirrored from left) ───

/**
 * Calculate drag offset for a right-side drawer.
 * Natural right-drawer behavior:
 *   - Open  → swipe RIGHT (towards edge) to close
 *   - Closed → swipe LEFT to open
 */
export function getRightDrawerOffsetFromDrag(options: {
	isOpen: boolean;
	deltaX: number;
}) {
	const { isOpen, deltaX } = options;
	if (isOpen) {
		// Drawer is open, swipe RIGHT (positive deltaX) reduces offset → closes
		return clamp(MOBILE_DRAWER_WIDTH_PX - deltaX, 0, MOBILE_DRAWER_WIDTH_PX);
	}
	// Drawer is closed, swipe LEFT (negative deltaX) increases offset → opens
	return clamp(-deltaX, 0, MOBILE_DRAWER_WIDTH_PX);
}

/**
 * Decide whether to open a right drawer based on drag offset and velocity.
 * For right drawers, negative velocityX means swiping left → open.
 */
export function shouldOpenRightDrawer(options: {
	offsetPx: number;
	velocityX: number;
}) {
	const { offsetPx, velocityX } = options;
	const ratio = getDrawerOpenRatio(offsetPx);
	return (
		velocityX <= -MOBILE_DRAWER_FLICK_VELOCITY_PX_PER_MS ||
		ratio >= MOBILE_DRAWER_OPEN_THRESHOLD_RATIO
	);
}

/**
 * Decide whether to keep a right drawer open after drag ends.
 * For right drawers, positive velocityX means swiping right (towards edge) → close.
 */
export function shouldKeepRightDrawerOpen(options: {
	offsetPx: number;
	velocityX: number;
}) {
	const { offsetPx, velocityX } = options;
	const ratio = getDrawerOpenRatio(offsetPx);
	return (
		velocityX < MOBILE_DRAWER_FLICK_VELOCITY_PX_PER_MS &&
		ratio > 1 - MOBILE_DRAWER_CLOSE_THRESHOLD_RATIO
	);
}

/**
 * Decide whether a right-drawer gesture should start.
 * When closed: only from the right edge region (rightmost 2/5 of screen).
 * When open: anywhere (to allow swipe-to-close).
 * Disabled when left sidebar is open.
 */
export function shouldStartRightDrawerGesture(options: {
	isOpen: boolean;
	target: EventTarget | null;
	viewportWidth: number;
	touchStartX: number;
	otherDrawerOpen: boolean;
}) {
	const { isOpen, target, viewportWidth, touchStartX, otherDrawerOpen } =
		options;
	if (viewportWidth >= DESKTOP_SHELL_MIN_WIDTH_PX) return false;
	if (otherDrawerOpen) return false;
	if (isOpen) {
		return !isTouchOnGestureBlockingElementWhenOpen(target);
	}
	if (isTouchOnInteractive(target)) return false;

	// When closed, only allow from the right edge zone (rightmost 2/5)
	const edgeZoneStart = viewportWidth * (1 - EDGE_ZONE_RATIO);
	if (touchStartX < edgeZoneStart) return false;

	return true;
}
