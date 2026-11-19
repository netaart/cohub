import type { Attachment } from "svelte/attachments";
import { isClaimedPress } from "#lib/drag/pointer-drag.svelte.ts";
import {
	isPointerDragPointerType,
	isWithinActivateTolerance,
	LONG_PRESS_MS,
	POINTER_DRAG_CLICK_SUPPRESS_MS,
} from "#lib/drag/pointer-drag-core.ts";
import { consumeTouchMoves } from "#lib/gestures/consume-touch.ts";
import { haptic } from "#lib/haptics.ts";
import {
	type ContextMenuSource,
	contextMenu,
	readContextMenu,
} from "./context-menu.svelte.ts";

function isEditable(target: EventTarget | null) {
	return (
		target instanceof Element &&
		target.closest("input, textarea, select, [contenteditable]") !== null
	);
}

export function contextMenuTrigger(
	source: ContextMenuSource,
): Attachment<HTMLElement> {
	return (node) => {
		let timer = 0;
		let pointerId: number | null = null;
		let touch = false;
		let pressing = false;
		let startX = 0;
		let startY = 0;
		let held = false;
		let releaseTouch: (() => void) | null = null;
		let suppressClickUntil = 0;

		node.setAttribute("data-context-menu", "");

		function clearTimer() {
			if (timer) window.clearTimeout(timer);
			timer = 0;
		}

		function fire() {
			timer = 0;
			if (!readContextMenu(source, node)) return;
			held = true;
			haptic("longPress");
			releaseTouch = consumeTouchMoves();
			contextMenu.open({
				target: node,
				source,
				point: { x: startX, y: startY },
			});
		}

		function onPointerDown(event: PointerEvent) {
			touch = isPointerDragPointerType(event.pointerType);
			pressing = touch;
			if (
				!touch ||
				!event.isPrimary ||
				isClaimedPress(event) ||
				isEditable(event.target)
			)
				return;
			clearTimer();
			pointerId = event.pointerId;
			startX = event.clientX;
			startY = event.clientY;
			timer = window.setTimeout(fire, LONG_PRESS_MS);
		}

		function onPointerMove(event: PointerEvent) {
			if (
				timer &&
				event.pointerId === pointerId &&
				!isWithinActivateTolerance(
					event.clientX - startX,
					event.clientY - startY,
				)
			)
				clearTimer();
		}

		function onPointerEnd(event: PointerEvent) {
			if (event.isPrimary) pressing = false;
			if (event.pointerId !== pointerId) return;
			clearTimer();
			pointerId = null;
			if (!held) return;
			held = false;
			releaseTouch?.();
			releaseTouch = null;
			suppressClickUntil = Date.now() + POINTER_DRAG_CLICK_SUPPRESS_MS;
		}

		function onClickCapture(event: MouseEvent) {
			if (Date.now() >= suppressClickUntil) return;
			suppressClickUntil = 0;
			event.preventDefault();
			event.stopPropagation();
		}

		function onContextMenu(event: MouseEvent) {
			if (isEditable(event.target)) return;
			// The platform's own long-press menu (Android); the hold answers it.
			if (event.isTrusted && pressing) {
				event.preventDefault();
				return;
			}
			// Shift + right-click keeps the browser's menu; Shift+F10 is the keyboard's.
			if (event.shiftKey && event.button === 2) return;
			if (!readContextMenu(source, node)) return;
			event.preventDefault();
			event.stopPropagation();
			const fromPoint = event.clientX !== 0 || event.clientY !== 0;
			contextMenu.open({
				target: node,
				source,
				point: fromPoint ? { x: event.clientX, y: event.clientY } : null,
				sheet: touch ? undefined : false,
			});
		}

		node.addEventListener("pointerdown", onPointerDown, { passive: true });
		node.addEventListener("pointermove", onPointerMove, { passive: true });
		node.addEventListener("pointerup", onPointerEnd, { passive: true });
		node.addEventListener("pointercancel", onPointerEnd, { passive: true });
		node.addEventListener("click", onClickCapture, true);
		node.addEventListener("contextmenu", onContextMenu);

		return () => {
			clearTimer();
			releaseTouch?.();
			node.removeAttribute("data-context-menu");
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("pointermove", onPointerMove);
			node.removeEventListener("pointerup", onPointerEnd);
			node.removeEventListener("pointercancel", onPointerEnd);
			node.removeEventListener("click", onClickCapture, true);
			node.removeEventListener("contextmenu", onContextMenu);
			contextMenu.close(node);
		};
	};
}
