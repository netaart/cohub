import {
	type BoardDrawInputSample,
	elementClientToLocal,
	type ScreenPoint,
	screenPoint,
	type WorldPoint,
} from "../model/index.js";
import type { BoardPointerEvent } from "../editor/index.js";

function pressureOf(event: PointerEvent): number {
	return event.pointerType === "pen" && event.pressure > 0
		? event.pressure
		: 0.5;
}

export function toBoardPointerEvent(
	event: PointerEvent,
	rect: DOMRect | HTMLElement,
	toWorld: (screen: ScreenPoint) => WorldPoint,
	coalesce = false,
): BoardPointerEvent {
	const local = "getBoundingClientRect" in rect
		? elementClientToLocal(rect)
		: (x: number, y: number) => screenPoint(x - rect.left, y - rect.top);
	const screen = local(event.clientX, event.clientY);
	const coalesced = coalesce ? event.getCoalescedEvents?.() : undefined;
	const samples: BoardDrawInputSample[] | undefined =
		coalesced && coalesced.length > 1
			? coalesced.map((sample) => ({
					world: toWorld(local(sample.clientX, sample.clientY)),
					pressure: pressureOf(sample),
				}))
			: undefined;
	return {
		pointerId: event.pointerId,
		screen,
		world: toWorld(screen),
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
