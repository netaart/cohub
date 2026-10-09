import {
	isPointerDragPointerType,
	isWithinActivateTolerance,
	POINTER_DRAG_CLICK_SUPPRESS_MS,
} from "$lib/drag/pointer-drag-core";

export const LONG_PRESS_MS = 450;

export type LongPressOptions = {
	onLongPress: () => void;
	enabled?: boolean;
};

function tick() {
	try {
		navigator.vibrate?.(10);
	} catch {}
}

export function longPress(node: HTMLElement, options: LongPressOptions) {
	let opts = options;
	let timer = 0;
	let pointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let suppressClickUntil = 0;
	let touchPressed = false;

	function cancel() {
		if (timer) window.clearTimeout(timer);
		timer = 0;
		pointerId = null;
	}

	function fire() {
		timer = 0;
		pointerId = null;
		suppressClickUntil = Date.now() + POINTER_DRAG_CLICK_SUPPRESS_MS;
		tick();
		opts.onLongPress();
	}

	function onPointerDown(event: PointerEvent) {
		touchPressed = isPointerDragPointerType(event.pointerType);
		if (opts.enabled === false || !touchPressed || !event.isPrimary) return;
		cancel();
		pointerId = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		timer = window.setTimeout(fire, LONG_PRESS_MS);
	}

	function onPointerMove(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		if (
			!isWithinActivateTolerance(event.clientX - startX, event.clientY - startY)
		)
			cancel();
	}

	function onPointerEnd(event: PointerEvent) {
		if (event.pointerId === pointerId) cancel();
	}

	function onClickCapture(event: MouseEvent) {
		if (Date.now() >= suppressClickUntil) return;
		suppressClickUntil = 0;
		event.preventDefault();
		event.stopPropagation();
	}

	function onContextMenu(event: Event) {
		if (touchPressed && opts.enabled !== false) event.preventDefault();
	}

	node.addEventListener("pointerdown", onPointerDown, { passive: true });
	node.addEventListener("pointermove", onPointerMove, { passive: true });
	node.addEventListener("pointerup", onPointerEnd, { passive: true });
	node.addEventListener("pointercancel", onPointerEnd, { passive: true });
	node.addEventListener("click", onClickCapture, true);
	node.addEventListener("contextmenu", onContextMenu);

	return {
		update(next: LongPressOptions) {
			opts = next;
			if (next.enabled === false) cancel();
		},
		destroy() {
			cancel();
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("pointermove", onPointerMove);
			node.removeEventListener("pointerup", onPointerEnd);
			node.removeEventListener("pointercancel", onPointerEnd);
			node.removeEventListener("click", onClickCapture, true);
			node.removeEventListener("contextmenu", onContextMenu);
		},
	};
}
