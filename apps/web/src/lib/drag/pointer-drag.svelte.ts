/**
 * Touch/pen drag controller: long-press a source, drag it onto a drop zone.
 *
 * Mouse keeps native HTML5 drag and drop (it works, and integrates with the
 * OS). This layer exists only for pointer types that never fire drag events,
 * and mirrors the same drop semantics so both paths land in the same place.
 *
 * Hit testing goes through `elementsFromPoint` against a zone registry rather
 * than cached rects, so it automatically respects transforms (a retracted
 * drawer) and stacking without any bookkeeping.
 */

import { untrack } from "svelte";
import { haptic } from "$lib/haptics";
import {
	autoscrollStep,
	describePointerDragPayload,
	hasLeftRetractSurface,
	isPointerDragPointerType,
	isWithinActivateTolerance,
	POINTER_DRAG_ACTIVATE_MS,
	POINTER_DRAG_CLICK_SUPPRESS_MS,
	POINTER_DRAG_SETTLE_MS,
	type PointerDragIntent,
	type PointerDragPayload,
	type PointerDropZone,
	pickDropZone,
} from "./pointer-drag-core";

export {
	POINTER_DRAG_SETTLE_MS,
	type PointerDragItem,
	type PointerDragPayload,
	type PointerDropZone,
} from "./pointer-drag-core";

/** Marks the surface that retracts once the pointer drags out of it. */
export const POINTER_DRAG_SURFACE_ATTR = "data-pointer-drag-surface";
/** Marks a scroll container that should autoscroll during a drag. */
export const POINTER_DRAG_AUTOSCROLL_ATTR = "data-pointer-drag-autoscroll";

const zones = new Map<Element, PointerDropZone>();

/**
 * Deadline until which a click on a drag source is swallowed.
 *
 * A touch release always synthesises a click, and after a drag that click must
 * not also activate the row. A deadline (rather than a per-source flag) means
 * the suppression cannot outlive the gesture: a drag released over the board
 * never produces a click on the source at all, and a flag left set there would
 * later swallow a genuine mouse or keyboard click on a hybrid device.
 */
let suppressClickUntil = 0;

function shouldSuppressClick() {
	return Date.now() < suppressClickUntil;
}

function prefersReducedMotion() {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
	);
}

class PointerDragState {
	/** A drag is live and tracking the pointer. */
	active = $state(false);
	payload = $state<PointerDragPayload | null>(null);
	x = $state(0);
	y = $state(0);
	/** Intent resolved from the zone under the pointer, or null over nothing. */
	intent = $state<PointerDragIntent | null>(null);
	/** Element of the claiming zone, so it can render a hover state. */
	targetElement = $state<Element | null>(null);
	/** The source surface has been dragged out of and should slide away. */
	retracted = $state(false);
	/** Ghost is animating back to the source after a drop over nothing. */
	settling = $state(false);
	settleFrom = $state<{ x: number; y: number } | null>(null);
	settleTo = $state<{ x: number; y: number } | null>(null);
	/** Bumped on every committed drop, for consumers that react to success. */
	commitVersion = $state(0);
	/** Whether the committed drop landed outside the retracted source surface. */
	committedOutsideSurface = $state(false);
	/** Screen-reader announcement for pickup / drop. */
	announcement = $state("");

	get label() {
		return this.payload ? describePointerDragPayload(this.payload) : "";
	}

	get itemCount() {
		return this.payload?.items.length ?? 0;
	}

	/** True when the given element is the current drop target. */
	isTarget(element: Element | null | undefined) {
		return Boolean(element && this.targetElement === element);
	}
}

export const pointerDrag = new PointerDragState();

export type PointerDragSourceOptions = {
	/** Built at activation so the payload always reflects current props. */
	getPayload: () => PointerDragPayload | null;
	enabled?: boolean;
};

type ActiveDrag = {
	pointerId: number;
	node: HTMLElement;
	payload: PointerDragPayload;
	/**
	 * Rect of the retract surface, captured at activation.
	 *
	 * Deliberately not re-measured: once the surface slides away its own rect is
	 * offscreen, so re-measuring would latch it retracted forever. The frozen rect
	 * keeps the boundary where the user last saw it, so dragging back returns it.
	 */
	surfaceRect: { left: number; right: number } | null;
	/** Last known pointer position, so the target can be re-resolved any time. */
	lastX: number;
	lastY: number;
	autoscrollFrame: number;
	autoscrollTarget: HTMLElement | null;
	autoscrollStepPx: number;
	retractFrame: number;
};

let current: ActiveDrag | null = null;

function collectZonesAt(clientX: number, clientY: number) {
	if (zones.size === 0) return [];
	const stack = document.elementsFromPoint(clientX, clientY);
	const matches: Array<{ element: Element; zone: PointerDropZone }> = [];
	for (const element of stack) {
		const zone = zones.get(element);
		if (zone) matches.push({ element, zone });
	}
	return matches;
}

function resolveTargetAt(clientX: number, clientY: number) {
	if (!current) return;
	current.lastX = clientX;
	current.lastY = clientY;
	const picked = pickDropZone(
		collectZonesAt(clientX, clientY),
		current.payload,
	);
	const nextElement = picked?.candidate.element ?? null;
	// Tick only when the target actually changes, so the haptic marks a
	// boundary crossing rather than buzzing continuously.
	if (nextElement !== pointerDrag.targetElement && nextElement) haptic("tick");
	pointerDrag.targetElement = nextElement;
	pointerDrag.intent = picked?.intent ?? null;
}

/**
 * Re-run the hit test at the last known pointer position.
 *
 * The pointer is not the only thing that moves during a drag: autoscroll slides
 * rows under a stationary finger, and retracting the source surface uncovers
 * whatever is behind it. Both change what a release would land on, so anything
 * that shifts the page re-resolves through here instead of trusting the target
 * cached by the last `pointermove`.
 */
function refreshTarget() {
	if (!current) return;
	resolveTargetAt(current.lastX, current.lastY);
}

function findAutoscrollTarget(clientX: number, clientY: number) {
	const stack = document.elementsFromPoint(clientX, clientY);
	for (const element of stack) {
		if (
			element instanceof HTMLElement &&
			element.hasAttribute(POINTER_DRAG_AUTOSCROLL_ATTR)
		)
			return element;
	}
	return null;
}

function runAutoscroll() {
	if (!current) return;
	const target = current.autoscrollTarget;
	const step = current.autoscrollStepPx;
	if (!target || step === 0) {
		current.autoscrollFrame = 0;
		return;
	}
	const before = target.scrollTop;
	target.scrollTop += step;
	// Rows just moved under a finger that never moved, so the target the release
	// would use is stale. Skip the work when the list is already at its end.
	if (target.scrollTop !== before) refreshTarget();
	current.autoscrollFrame = requestAnimationFrame(runAutoscroll);
}

function updateAutoscroll(clientX: number, clientY: number) {
	if (!current) return;
	const target = findAutoscrollTarget(clientX, clientY);
	current.autoscrollTarget = target;
	current.autoscrollStepPx = target
		? autoscrollStep(clientY, target.getBoundingClientRect())
		: 0;
	if (current.autoscrollStepPx !== 0 && current.autoscrollFrame === 0) {
		current.autoscrollFrame = requestAnimationFrame(runAutoscroll);
	}
}

function stopAutoscroll() {
	if (!current) return;
	if (current.autoscrollFrame) cancelAnimationFrame(current.autoscrollFrame);
	current.autoscrollFrame = 0;
	current.autoscrollTarget = null;
	current.autoscrollStepPx = 0;
}

/**
 * Re-resolve once the retract has actually reached the DOM.
 *
 * Retracting only sets reactive state here; the drawer's `pointer-events: none`
 * lands after Svelte flushes, so hit testing in the same tick still sees the
 * drawer covering the board. One frame later it does not.
 */
function scheduleRetractRefresh() {
	if (!current || current.retractFrame) return;
	current.retractFrame = requestAnimationFrame(() => {
		if (!current) return;
		current.retractFrame = 0;
		refreshTarget();
	});
}

/** Block the browser's own scrolling / text selection while dragging. */
function onDocumentTouchMove(event: TouchEvent) {
	if (!current) return;
	if (event.cancelable) event.preventDefault();
}

function onContextMenu(event: Event) {
	if (current) event.preventDefault();
}

/**
 * A second pointer landing mid-drag is a pinch/zoom, not a drop.
 *
 * Swallowed rather than passed through: letting it reach the board would start a
 * pan or a stroke with the second finger, so the gesture is cancelled and the
 * ghost flies back instead of leaving a stray edit behind.
 */
function onDocumentPointerDownCapture(event: PointerEvent) {
	if (!current || event.pointerId === current.pointerId) return;
	event.stopPropagation();
	if (event.cancelable) event.preventDefault();
	finishDrag(false);
}

function onWindowPointerMove(event: PointerEvent) {
	if (!current || event.pointerId !== current.pointerId) return;
	pointerDrag.x = event.clientX;
	pointerDrag.y = event.clientY;
	resolveTargetAt(event.clientX, event.clientY);
	updateAutoscroll(event.clientX, event.clientY);

	const surfaceRect = current.surfaceRect;
	if (surfaceRect) {
		const shouldRetract = hasLeftRetractSurface(event.clientX, surfaceRect);
		if (shouldRetract !== pointerDrag.retracted) {
			pointerDrag.retracted = shouldRetract;
			// The uncovered surface is not hit-testable until the drawer's style has
			// flushed, so this waits a frame. Release re-resolves too, which covers a
			// drag that retracts and lifts without another move in between.
			scheduleRetractRefresh();
		}
	}
}

/**
 * Fly the ghost back to where the drag started, so a released-over-nothing drag
 * visibly returns instead of vanishing. Returns false when it did not animate,
 * so the caller can clear the payload immediately.
 */
function settleGhostBack(sourceRect: DOMRect | null) {
	if (prefersReducedMotion()) return false;
	const from = { x: pointerDrag.x, y: pointerDrag.y };
	const to = sourceRect
		? {
				x: sourceRect.left + Math.min(sourceRect.width, 120) / 2,
				y: sourceRect.top + sourceRect.height / 2,
			}
		: from;
	pointerDrag.settleFrom = from;
	pointerDrag.settleTo = to;
	pointerDrag.settling = true;
	window.setTimeout(() => {
		pointerDrag.settling = false;
		pointerDrag.settleFrom = null;
		pointerDrag.settleTo = null;
		pointerDrag.payload = null;
	}, POINTER_DRAG_SETTLE_MS);
	return true;
}

function finishDrag(
	commit: boolean,
	point?: { clientX: number; clientY: number },
) {
	if (!current) return;
	const drag = current;
	const zone = pointerDrag.targetElement
		? zones.get(pointerDrag.targetElement)
		: null;
	const intent = pointerDrag.intent;
	const retracted = pointerDrag.retracted;
	// Measured before teardown: the ghost fly-back needs the source's live rect.
	const sourceRect = drag.node.getBoundingClientRect();

	stopAutoscroll();
	if (drag.retractFrame) cancelAnimationFrame(drag.retractFrame);
	window.removeEventListener("pointermove", onWindowPointerMove);
	window.removeEventListener("pointerup", onWindowPointerUp);
	window.removeEventListener("pointercancel", onWindowPointerCancel);
	document.removeEventListener("touchmove", onDocumentTouchMove);
	document.removeEventListener("contextmenu", onContextMenu, true);
	document.removeEventListener(
		"pointerdown",
		onDocumentPointerDownCapture,
		true,
	);
	document.body.classList.remove("pointer-dragging");
	current = null;

	// A click always follows a touch release; suppress it for a beat so the row
	// under the finger does not also activate. Time-boxed rather than a flag
	// cleared on the next click, which would linger when the release happened
	// somewhere else entirely (a board drop) and later swallow a real mouse click.
	suppressClickUntil = Date.now() + POINTER_DRAG_CLICK_SUPPRESS_MS;

	pointerDrag.active = false;
	pointerDrag.targetElement = null;
	pointerDrag.intent = null;
	pointerDrag.retracted = false;

	const committed = Boolean(commit && zone && intent && point);
	if (committed && zone && point) {
		haptic("confirm");
		zone.drop(drag.payload, point);
		pointerDrag.announcement = `${describePointerDragPayload(drag.payload)} — ${intent?.label ?? "dropped"}`;
		pointerDrag.committedOutsideSurface = retracted;
		pointerDrag.commitVersion += 1;
		pointerDrag.payload = null;
		return;
	}

	pointerDrag.announcement = "Drag cancelled";
	if (!settleGhostBack(sourceRect)) pointerDrag.payload = null;
}

function onWindowPointerUp(event: PointerEvent) {
	if (!current || event.pointerId !== current.pointerId) return;
	// Resolve at the release position rather than trusting the target cached by
	// the last move: autoscroll or a retract may have changed what is under the
	// finger since. By now every pending style change has flushed.
	resolveTargetAt(event.clientX, event.clientY);
	finishDrag(true, { clientX: event.clientX, clientY: event.clientY });
}

function onWindowPointerCancel(event: PointerEvent) {
	if (!current || event.pointerId !== current.pointerId) return;
	finishDrag(false);
}

/**
 * Svelte action: make a node a long-press drag source for touch and pen.
 *
 * The press must stay within a small slop for the activation delay, so a flick
 * scrolls the list as usual and only a deliberate hold starts a drag.
 */
export function pointerDragSource(
	node: HTMLElement,
	options: PointerDragSourceOptions,
) {
	let opts = options;
	let armTimer = 0;
	let armPointerId: number | null = null;
	let armX = 0;
	let armY = 0;

	function disarm() {
		if (armTimer) window.clearTimeout(armTimer);
		armTimer = 0;
		armPointerId = null;
	}

	function activate() {
		armTimer = 0;
		if (armPointerId === null) return;
		const payload = untrack(() => opts.getPayload());
		if (!payload || payload.items.length === 0) {
			armPointerId = null;
			return;
		}
		const surface = node.closest<HTMLElement>(`[${POINTER_DRAG_SURFACE_ATTR}]`);
		const surfaceBox = surface?.getBoundingClientRect();
		current = {
			pointerId: armPointerId,
			node,
			payload,
			surfaceRect: surfaceBox
				? { left: surfaceBox.left, right: surfaceBox.right }
				: null,
			lastX: armX,
			lastY: armY,
			autoscrollFrame: 0,
			autoscrollTarget: null,
			autoscrollStepPx: 0,
			retractFrame: 0,
		};
		armPointerId = null;

		pointerDrag.payload = payload;
		pointerDrag.x = armX;
		pointerDrag.y = armY;
		pointerDrag.active = true;
		pointerDrag.settling = false;
		pointerDrag.retracted = false;
		pointerDrag.announcement = `Picked up ${describePointerDragPayload(payload)}`;
		haptic("longPress");
		document.body.classList.add("pointer-dragging");
		// Events live on the window rather than a captured node: the source row can
		// slide away with its drawer mid-drag, and the window sees every move
		// regardless of what the pointer is over.
		window.addEventListener("pointermove", onWindowPointerMove);
		window.addEventListener("pointerup", onWindowPointerUp);
		window.addEventListener("pointercancel", onWindowPointerCancel);
		// Non-passive: this is what actually stops the list from scrolling.
		document.addEventListener("touchmove", onDocumentTouchMove, {
			passive: false,
		});
		document.addEventListener("contextmenu", onContextMenu, true);
		// Capture phase: a second finger must be intercepted before it reaches the
		// board's own pointer handling.
		document.addEventListener(
			"pointerdown",
			onDocumentPointerDownCapture,
			true,
		);
		resolveTargetAt(armX, armY);
	}

	function onPointerDown(event: PointerEvent) {
		if (opts.enabled === false) return;
		if (!isPointerDragPointerType(event.pointerType)) return;
		// Already dragging, or a second finger arriving while armed: neither should
		// start a competing gesture. An active drag is cancelled by the document
		// capture handler, which sees every extra pointer, not just those on a row.
		if (current || armPointerId !== null) {
			disarm();
			return;
		}
		armPointerId = event.pointerId;
		armX = event.clientX;
		armY = event.clientY;
		armTimer = window.setTimeout(activate, POINTER_DRAG_ACTIVATE_MS);
	}

	function onPointerMove(event: PointerEvent) {
		if (armPointerId !== event.pointerId) return;
		if (!isWithinActivateTolerance(event.clientX - armX, event.clientY - armY))
			disarm();
	}

	function onPointerEnd(event: PointerEvent) {
		if (armPointerId === event.pointerId) disarm();
	}

	function onClickCapture(event: MouseEvent) {
		if (!shouldSuppressClick()) return;
		event.preventDefault();
		event.stopPropagation();
	}

	node.addEventListener("pointerdown", onPointerDown, { passive: true });
	node.addEventListener("pointermove", onPointerMove, { passive: true });
	node.addEventListener("pointerup", onPointerEnd, { passive: true });
	node.addEventListener("pointercancel", onPointerEnd, { passive: true });
	node.addEventListener("click", onClickCapture, true);

	return {
		update(next: PointerDragSourceOptions) {
			opts = next;
		},
		destroy() {
			disarm();
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("pointermove", onPointerMove);
			node.removeEventListener("pointerup", onPointerEnd);
			node.removeEventListener("pointercancel", onPointerEnd);
			node.removeEventListener("click", onClickCapture, true);
			if (current?.node === node) finishDrag(false);
		},
	};
}

/** Svelte action: register a node as a pointer-drag drop zone. */
export function pointerDropZone(node: HTMLElement, zone: PointerDropZone) {
	zones.set(node, zone);
	return {
		update(next: PointerDropZone) {
			zones.set(node, next);
		},
		destroy() {
			zones.delete(node);
			if (pointerDrag.targetElement === node) {
				pointerDrag.targetElement = null;
				pointerDrag.intent = null;
			}
		},
	};
}
