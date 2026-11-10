import {
	type BoardRegion,
	type BoardRegionDirection,
	type BoardRegionStep,
	type BoardSceneItem,
	type BoardViewport,
	boardFrameRegion,
	boardNavigableFrames,
	boardReadingOrder,
	boardRegionStep,
	cameraForRect,
	pointToWorld,
	type Rect,
	rectContainsPoint,
	screenPoint,
	type WorldPoint,
} from "../model/index.js";
import type { EditorContext } from "./context.js";
import { BOARD_INPUT } from "./input.js";

export type BoardFrameView = { readonly id: string; readonly present: boolean };
export type BoardFrameInset = { top?: number; right?: number; bottom?: number; left?: number };
export type BoardFrameGoOptions = { present?: boolean; animate?: boolean };

const FRAME_PADDING = 24;

const area = (rect: Rect) => rect.width * rect.height;

export function createFramesModule(ctx: EditorContext) {
	const { state } = ctx;
	let frames: readonly BoardSceneItem[] = [];
	let regions: readonly BoardRegion[] = [];
	let inset: BoardFrameInset = {};
	let returnTo: BoardViewport | null = null;

	function list(): readonly BoardRegion[] {
		const next = boardNavigableFrames(state.scene);
		if (next.length !== frames.length || next.some((item, index) => item !== frames[index])) {
			frames = next;
			regions = boardReadingOrder(next.map(boardFrameRegion));
		}
		return regions;
	}

	const region = (id: string) => list().find((entry) => entry.id === id) ?? null;

	function view(): BoardFrameView | null {
		const current = state.frameView;
		return current && region(current.id) ? current : null;
	}

	function at(point: WorldPoint): BoardRegion | null {
		let best: BoardRegion | null = null;
		for (const entry of list()) if (rectContainsPoint(entry.rect, point) && (!best || area(entry.rect) < area(best.rect))) best = entry;
		return best;
	}

	function nearest(): BoardRegion | null {
		const { width, height } = state.surfaceSize;
		const center = pointToWorld(screenPoint(width / 2, height / 2), state.camera);
		const inside = at(center);
		if (inside) return inside;
		let best: BoardRegion | null = null;
		let distance = Number.POSITIVE_INFINITY;
		for (const entry of list()) {
			const { x, y, width: w, height: h } = entry.rect;
			const d = Math.hypot(Math.max(x - center.x, 0, center.x - x - w), Math.max(y - center.y, 0, center.y - y - h));
			if (d < distance) {
				best = entry;
				distance = d;
			}
		}
		return best;
	}

	function target(rect: Rect, present: boolean): BoardViewport | null {
		const clear = present ? {} : inset;
		const left = clear.left ?? 0;
		const top = clear.top ?? 0;
		const width = state.surfaceSize.width - left - (clear.right ?? 0);
		const height = state.surfaceSize.height - top - (clear.bottom ?? 0);
		if (width <= 0 || height <= 0) return null;
		const camera = cameraForRect(rect, { width, height }, { padding: present ? 0 : FRAME_PADDING });
		return { ...camera, x: camera.x + left, y: camera.y + top };
	}

	function go(id: string, options: BoardFrameGoOptions = {}): boolean {
		const next = region(id);
		if (!next) return false;
		ctx.camera.takeCameraControl();
		const current = view();
		const present = options.present ?? current?.present ?? false;
		if (!current || (present && !current.present)) returnTo = state.camera;
		if (present && !current?.present) {
			state.selection = [];
			state.editingId = null;
			state.enteredId = null;
			state.hoverId = null;
		}
		const camera = target(next.rect, present);
		state.frameView = { id, present };
		if (camera) ctx.camera.show(camera, options.animate !== false && !present);
		return true;
	}

	function refit(animate: boolean) {
		const current = view();
		const shown = current && region(current.id);
		const camera = shown && target(shown.rect, current.present);
		if (camera) ctx.camera.show(camera, animate);
	}

	function step(direction: BoardRegionStep): boolean {
		const current = view();
		const from = current && region(current.id);
		const next = from ? boardRegionStep(list(), from, direction) : nearest();
		return next ? go(next.id) : false;
	}

	function release(options: { present?: boolean } = {}): boolean {
		if (view()?.present && !options.present) return false;
		if (state.frameView) state.frameView = null;
		returnTo = null;
		return true;
	}

	function exit(options: { restore?: boolean } = {}) {
		const current = view();
		const back = returnTo;
		release({ present: true });
		if (current && back && (options.restore ?? current.present)) ctx.camera.show(back, true);
	}

	function swipe(dx: number, dy: number, vx: number, vy: number) {
		const current = view();
		const from = current && region(current.id);
		if (!from) return;
		const horizontal = Math.abs(dx) >= Math.abs(dy);
		const distance = horizontal ? dx : dy;
		const velocity = horizontal ? vx : vy;
		const span = horizontal ? state.surfaceSize.width : state.surfaceSize.height;
		const flung = Math.abs(velocity) >= BOARD_INPUT.swipeVelocity && Math.sign(velocity) === Math.sign(distance);
		const moves = Math.abs(distance) >= BOARD_INPUT.swipeDistance * span || flung;
		const direction: BoardRegionDirection = horizontal ? (distance < 0 ? "right" : "left") : distance < 0 ? "down" : "up";
		const next = moves ? boardRegionStep(list(), from, direction) : null;
		if (next) go(next.id);
		else refit(true);
	}

	function tap(x: number, pointerType: string) {
		const back = pointerType !== "mouse" && x < state.surfaceSize.width / 3;
		step(back ? "previous" : "next");
	}

	function toggleAt(point: WorldPoint) {
		const current = view();
		const hit = at(point);
		if (current && (!hit || hit.id === current.id)) exit({ restore: true });
		else if (hit) go(hit.id);
	}

	function setInset(next: BoardFrameInset) {
		if (next.top === inset.top && next.right === inset.right && next.bottom === inset.bottom && next.left === inset.left) return;
		inset = next;
		if (view()?.present === false) refit(false);
	}

	return {
		list,
		view,
		neighbor: (id: string, step: BoardRegionStep) => {
			const from = region(id);
			return from ? boardRegionStep(list(), from, step) : null;
		},
		go,
		step,
		refit,
		release,
		exit,
		swipe,
		tap,
		toggleAt,
		setInset,
	};
}

export type FramesModule = ReturnType<typeof createFramesModule>;
