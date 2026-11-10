import { BOARD_INPUT, type BoardEditor } from "../editor/index.js";
import { elementClientToLocal } from "../model/index.js";

const WHEEL_ZOOM_INTENSITY = 0.012;
const MAX_WHEEL_ZOOM_FACTOR = 1.35;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 80;
const STEP_DELTA_PX = 50;

export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
	if (!Number.isFinite(delta)) return 0;
	if (deltaMode === 1) return delta * LINE_DELTA_PX;
	if (deltaMode === 2) return delta * PAGE_DELTA_PX;
	return delta;
}

export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
	const factor = Math.exp(-normalizeWheelDelta(deltaY, deltaMode) * WHEEL_ZOOM_INTENSITY);
	return Math.min(MAX_WHEEL_ZOOM_FACTOR, Math.max(1 / MAX_WHEEL_ZOOM_FACTOR, factor));
}

export function isWheelStep(event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY">): boolean {
	return event.deltaMode !== 0 || (event.deltaX === 0 && Math.abs(event.deltaY) >= STEP_DELTA_PX);
}

function scrollsWithin(target: EventTarget | null, boundary: Element, dx: number, dy: number): boolean {
	for (let node = target instanceof Element ? target : null; node && node !== boundary; node = node.parentElement) {
		const style = node.ownerDocument.defaultView?.getComputedStyle(node);
		if (!style) continue;
		const canX = /auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
		const canY = /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
		if (canY && ((dy < 0 && node.scrollTop > 0) || (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight))) return true;
		if (canX && ((dx < 0 && node.scrollLeft > 0) || (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth))) return true;
	}
	return false;
}

export function createBoardWheel(host: HTMLElement, editor: BoardEditor, options: { views: Element; active: () => boolean; busy: () => boolean }) {
	let stream: { at: number; step: boolean; ours: boolean } | null = null;
	let zoomedAt = Number.NEGATIVE_INFINITY;
	let gestureScale: number | null = null;
	const local = (x: number, y: number) => elementClientToLocal(host)(x, y);

	function wheel(event: WheelEvent) {
		if (!options.active()) return;
		const now = performance.now();
		let dx = normalizeWheelDelta(event.deltaX, event.deltaMode);
		let dy = normalizeWheelDelta(event.deltaY, event.deltaMode);
		const zoom = event.ctrlKey || event.metaKey;
		if (!stream || now - stream.at > BOARD_INPUT.wheelGapMs) {
			const inView = event.target instanceof Node && options.views.contains(event.target);
			stream = { at: now, step: isWheelStep(event), ours: zoom || !inView || !scrollsWithin(event.target, options.views, dx, dy) };
		}
		stream.at = now;
		if (!stream.ours) return;
		event.preventDefault();
		if (zoom) {
			if (gestureScale !== null) return;
			zoomedAt = now;
			editor.zoomBy(local(event.clientX, event.clientY), wheelZoomFactor(event.deltaY, event.deltaMode), stream.step);
			return;
		}
		if (now - zoomedAt < BOARD_INPUT.pinchSettleMs) return;
		if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
		editor.scroll(dx, dy, stream.step);
	}

	type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

	function gesture(event: Event) {
		if (!options.active()) return;
		event.preventDefault();
		const { type, scale, clientX, clientY } = event as GestureEvent;
		if (type === "gestureend") {
			if (gestureScale !== null) zoomedAt = performance.now();
			gestureScale = null;
			return;
		}
		if (options.busy()) return;
		if (type === "gesturestart" || gestureScale === null) {
			gestureScale = scale || 1;
			return;
		}
		const factor = scale / gestureScale;
		gestureScale = scale;
		if (Number.isFinite(factor) && factor > 0) editor.zoomBy(local(clientX, clientY), factor);
	}

	const listeners: Array<[string, (event: never) => void]> = [
		["wheel", wheel],
		["gesturestart", gesture],
		["gesturechange", gesture],
		["gestureend", gesture],
	];
	for (const [type, listener] of listeners) host.addEventListener(type, listener as EventListener, { passive: false });
	return {
		destroy() {
			for (const [type, listener] of listeners) host.removeEventListener(type, listener as EventListener);
		},
	};
}
