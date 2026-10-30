import { BOARD_INPUT, type BoardEditor, boardDragSlop } from "../editor/index.js";
import { panBy } from "../model/index.js";

const EDGE_GESTURES = new Set(["translating", "resizing", "rotating", "brushing", "creatingBox", "creatingText", "creatingArrow", "draggingArrowHandle"]);
const MAX_STEP_MS = 50;

function edgeSpeed(position: number, start: number, end: number): number {
	const zone = BOARD_INPUT.edgeZone;
	const depth = Math.max(0, zone - (position - start)) - Math.max(0, zone - (end - position));
	const ratio = Math.max(-1, Math.min(1, depth / zone));
	return -Math.sign(ratio) * ratio * ratio * (BOARD_INPUT.edgeSpeed / 1000);
}

export function createBoardAutoPan(host: HTMLElement, editor: BoardEditor) {
	let start: { x: number; y: number; pointerType: string } | null = null;
	let pointer: { x: number; y: number } | null = null;
	let armed = false;
	let frame = 0;
	let last = 0;

	function velocity() {
		if (!pointer || !armed || !EDGE_GESTURES.has(editor.interaction.type)) return null;
		const rect = host.getBoundingClientRect();
		const vx = edgeSpeed(pointer.x, rect.left, rect.right);
		const vy = edgeSpeed(pointer.y, rect.top, rect.bottom);
		return vx || vy ? { vx, vy } : null;
	}

	function tick(now: number) {
		frame = 0;
		const speed = velocity();
		if (!speed) return;
		const dt = Math.min(MAX_STEP_MS, Math.max(0, now - last));
		last = now;
		editor.setCamera(panBy(editor.camera, -speed.vx * dt, -speed.vy * dt));
		frame = requestAnimationFrame(tick);
	}

	function stop() {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		start = pointer = null;
		armed = false;
	}

	return {
		begin(event: PointerEvent) {
			stop();
			start = { x: event.clientX, y: event.clientY, pointerType: event.pointerType };
		},
		move(event: PointerEvent) {
			if (!start) return;
			pointer = { x: event.clientX, y: event.clientY };
			armed ||= Math.hypot(pointer.x - start.x, pointer.y - start.y) > boardDragSlop(start.pointerType);
			if (frame || !velocity()) return;
			last = performance.now();
			frame = requestAnimationFrame(tick);
		},
		stop,
	};
}
