import {
	type BoardDrawInputSample,
	type BoardViewport,
	pointToWorld,
	screenPoint,
} from "../model/index.js";
import type { BoardPointerEvent } from "../editor/index.js";

function pressureOf(event: PointerEvent): number {
	return event.pointerType === "pen" && event.pressure > 0
		? event.pressure
		: 0.5;
}

function screenOf(event: PointerEvent, rect: DOMRect) {
	return screenPoint(event.clientX - rect.left, event.clientY - rect.top);
}

export function toBoardPointerEvent(
	event: PointerEvent,
	rect: DOMRect,
	camera: BoardViewport,
	coalesce = false,
): BoardPointerEvent {
	const screen = screenOf(event, rect);
	const coalesced = coalesce ? event.getCoalescedEvents?.() : undefined;
	const samples: BoardDrawInputSample[] | undefined =
		coalesced && coalesced.length > 1
			? coalesced.map((sample) => ({
					world: pointToWorld(screenOf(sample, rect), camera),
					pressure: pressureOf(sample),
				}))
			: undefined;
	return {
		pointerId: event.pointerId,
		screen,
		world: pointToWorld(screen, camera),
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		altKey: event.altKey,
		button: event.button,
		buttons: event.buttons,
		pointerType: event.pointerType,
		cancelled:
			event.type === "pointercancel" || event.type === "lostpointercapture",
		pressure: pressureOf(event),
		...(samples ? { samples } : {}),
	};
}
