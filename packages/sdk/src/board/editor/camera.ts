import {
	type BoardCameraState,
	type BoardViewport,
	boardZoomFloor,
	cameraForRect,
	cameraForState,
	FIT_PADDING,
	normalizeViewport,
	panBy,
	pointToWorld,
	type Rect,
	type ScreenPoint,
	screenPoint,
	stateForCamera,
	visibleWorldRect,
	type WorldPoint,
	zoomAround,
} from "../model/index.js";
import type { BoardCameraPolicy, EditorContext } from "./context.js";
import { BOARD_INPUT } from "./input.js";

const ZOOM_STEP = 1.28;
const CAMERA_ANIMATION_MS = 240;
const GLIDE_TAU_MS = BOARD_INPUT.wheelEaseMs / 3;
const FRAME_MS = 16;
const MAX_STEP_MS = 64;

export type BoardFocusOptions = {
	fit?: "contain" | "cover";
	padding?: number;
	minZoom?: number;
	maxZoom?: number;
	animate?: boolean;
};

type Motion =
	| { kind: "animate"; from: BoardViewport; to: BoardViewport; started: number }
	| { kind: "glide"; target: BoardViewport; anchor: ScreenPoint; last: number }
	| { kind: "fling"; vx: number; vy: number; last: number };

function easeOutCubic(t: number) {
	return 1 - (1 - t) * (1 - t) * (1 - t);
}

function glideStep(from: BoardViewport, to: BoardViewport, anchor: ScreenPoint, k: number): BoardViewport {
	const zoom = from.zoom * (to.zoom / from.zoom) ** k;
	const a = pointToWorld(anchor, from);
	const b = pointToWorld(anchor, to);
	const x = a.x + (b.x - a.x) * k;
	const y = a.y + (b.y - a.y) * k;
	return { x: anchor.x - x * zoom, y: anchor.y - y * zoom, zoom };
}

function settled(a: BoardViewport, b: BoardViewport) {
	return Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) < 0.1 && Math.abs(a.zoom / b.zoom - 1) < 1e-4;
}

export function createCameraModule(ctx: EditorContext) {
	const { state } = ctx;
	let motion: Motion | null = null;
	let frame = 0;
	let followed: BoardViewport | null = null;
	let floor: { scene: typeof state.scene; width: number; height: number; zoom: number } | null = null;

	function zoomFloor(zoom = state.camera.zoom): number {
		const { scene, surfaceSize } = state;
		if (floor?.scene !== scene || floor.width !== surfaceSize.width || floor.height !== surfaceSize.height)
			floor = { scene, ...surfaceSize, zoom: boardZoomFloor(ctx.query.contentBounds(), surfaceSize) };
		return Math.min(floor.zoom, zoom);
	}

	function move(viewport: BoardViewport) {
		state.camera = normalizeViewport(viewport, state.camera);
		state.hoverPoint = null;
		state.hoverId = null;
		ctx.interaction.follow();
	}

	function setCamera(viewport: BoardViewport) {
		ctx.frames.release({ present: true });
		move(viewport);
	}

	function setCameraPolicy(policy: BoardCameraPolicy) {
		state.cameraPolicy = policy;
	}

	function follow(viewport: BoardViewport | null) {
		followed = viewport;
	}

	function takeCameraControl(): boolean {
		if (state.cameraPolicy !== "follow" || !followed) return false;
		stop();
		move(followed);
		followed = null;
		setCameraPolicy("free");
		return true;
	}

	function step(now: number) {
		frame = 0;
		const current = motion;
		if (!current) return;
		if (current.kind === "animate") {
			const t = Math.min(1, (now - current.started) / CAMERA_ANIMATION_MS);
			const eased = easeOutCubic(t);
			const { from, to } = current;
			if (t >= 1) motion = null;
			move({
				x: from.x + (to.x - from.x) * eased,
				y: from.y + (to.y - from.y) * eased,
				zoom: from.zoom + (to.zoom - from.zoom) * eased,
			});
		} else {
			const dt = Math.min(MAX_STEP_MS, Math.max(0, now - current.last));
			current.last = now;
			if (current.kind === "glide") {
				const next = glideStep(state.camera, current.target, current.anchor, 1 - Math.exp(-dt / GLIDE_TAU_MS));
				const done = settled(next, current.target);
				if (done) motion = null;
				move(done ? current.target : next);
			} else {
				const decay = BOARD_INPUT.flingDecay ** (dt / FRAME_MS);
				current.vx *= decay;
				current.vy *= decay;
				if (Math.hypot(current.vx, current.vy) < BOARD_INPUT.flingStop) motion = null;
				move(panBy(state.camera, current.vx * dt, current.vy * dt));
			}
		}
		if (motion && !frame) frame = requestAnimationFrame(step);
	}

	function start(next: Motion) {
		motion = next;
		if (!frame) frame = requestAnimationFrame(step);
	}

	/** True when it halted a fling still fast enough that a press should only catch it. */
	function stop(): boolean {
		const flinging = motion?.kind === "fling" && Math.hypot(motion.vx, motion.vy) >= BOARD_INPUT.flingCatch;
		motion = null;
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		return flinging;
	}

	function animateCamera(target: BoardViewport) {
		const from = normalizeViewport(state.camera);
		start({ kind: "animate", from, to: normalizeViewport(target, from), started: performance.now() });
	}

	function show(target: BoardViewport, animate: boolean) {
		if (animate) return animateCamera(target);
		stop();
		move(target);
	}

	function glide(target: (base: BoardViewport) => BoardViewport, anchor: ScreenPoint) {
		const base = motion?.kind === "glide" ? motion.target : state.camera;
		const last = motion?.kind === "glide" ? motion.last : performance.now();
		start({ kind: "glide", target: normalizeViewport(target(base), base), anchor, last });
	}

	function surfaceCenter(): ScreenPoint {
		return screenPoint(state.surfaceSize.width / 2, state.surfaceSize.height / 2);
	}

	function viewCenter(): WorldPoint {
		return pointToWorld(surfaceCenter(), state.camera);
	}

	function visibleRect(): Rect | null {
		const { camera, surfaceSize } = state;
		if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return null;
		return {
			x: -camera.x / camera.zoom,
			y: -camera.y / camera.zoom,
			width: surfaceSize.width / camera.zoom,
			height: surfaceSize.height / camera.zoom,
		};
	}

	function zoomAt(point: ScreenPoint, factor: number, animate = false) {
		if (!ctx.frames.release()) return;
		takeCameraControl();
		const target = zoomAround(state.camera, point, state.camera.zoom * factor, zoomFloor());
		if (animate) animateCamera(target);
		else {
			stop();
			move(target);
		}
	}

	function scroll(dx: number, dy: number, smooth = false) {
		if (!ctx.frames.release()) return;
		takeCameraControl();
		if (smooth) return glide((base) => panBy(base, -dx, -dy), motion?.kind === "glide" ? motion.anchor : surfaceCenter());
		stop();
		move(panBy(state.camera, -dx, -dy));
	}

	function zoomBy(point: ScreenPoint, factor: number, smooth = false) {
		if (!ctx.frames.release()) return;
		takeCameraControl();
		if (smooth) return glide((base) => zoomAround(base, point, base.zoom * factor, zoomFloor(base.zoom)), point);
		stop();
		move(zoomAround(state.camera, point, state.camera.zoom * factor, zoomFloor()));
	}

	function fling(vx: number, vy: number) {
		if (Math.hypot(vx, vy) < BOARD_INPUT.flingStop) return;
		start({ kind: "fling", vx, vy, last: performance.now() });
	}

	function focusRect(rect: Rect, focus: BoardFocusOptions = {}) {
		ctx.frames.release({ present: true });
		takeCameraControl();
		const { surfaceSize } = state;
		if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return;
		const target = cameraForRect(rect, surfaceSize, {
			fit: focus.fit ?? "contain",
			padding: focus.padding ?? 32,
			minZoom: focus.minZoom,
			maxZoom: focus.maxZoom,
		});
		if (focus.animate === false) {
			stop();
			move(target);
		} else animateCamera(target);
	}

	function fitView(focus: BoardFocusOptions = {}) {
		ctx.frames.release({ present: true });
		const content = ctx.query.contentBounds();
		if (content && state.surfaceSize.width > 0) focusRect(content, { padding: FIT_PADDING, ...focus });
		else if (focus.animate === false) move({ x: 0, y: 0, zoom: 1 });
		else animateCamera({ x: 0, y: 0, zoom: 1 });
	}

	function cameraState(): BoardCameraState | null {
		const { surfaceSize } = state;
		return surfaceSize.width > 0 && surfaceSize.height > 0 ? stateForCamera(state.camera, surfaceSize) : null;
	}

	function restoreCameraState(view: BoardCameraState | null | undefined): boolean {
		ctx.frames.release({ present: true });
		const { surfaceSize } = state;
		if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return false;
		if (view) {
			const camera = cameraForState(view, surfaceSize);
			if (ctx.query.idsInRect(visibleWorldRect(camera, surfaceSize.width, surfaceSize.height)).length > 0) {
				stop();
				move(camera);
				return true;
			}
		}
		stop();
		fitView({ animate: false, maxZoom: 1 });
		return false;
	}

	function focusItems(ids: Iterable<string>, focus?: BoardFocusOptions) {
		const rect = ctx.query.contentBounds(ids);
		if (rect) focusRect(rect, focus);
	}

	function focusSelection(focus?: BoardFocusOptions) {
		const [only] = state.selection;
		if (state.selection.length === 1 && only && ctx.frames.go(only)) return;
		const rect = ctx.query.contentBounds(state.selection);
		if (rect) focusRect(rect, focus);
		else fitView();
	}

	return {
		setCamera,
		show,
		setCameraPolicy,
		follow,
		takeCameraControl,
		shown: () => followed ?? state.camera,
		following: () => followed !== null && state.cameraPolicy === "follow",
		stop,
		viewCenter,
		visibleRect,
		cameraState,
		restoreCameraState,
		zoomAt,
		zoomFloor,
		zoomIn: () => zoomAt(surfaceCenter(), ZOOM_STEP, true),
		zoomOut: () => zoomAt(surfaceCenter(), 1 / ZOOM_STEP, true),
		resetZoom: () => {
			takeCameraControl();
			zoomAt(surfaceCenter(), 1 / state.camera.zoom, true);
		},
		focusRect,
		fitView,
		focusItems,
		focusNode: (id: string, focus?: BoardFocusOptions) => focusItems([id], focus),
		focusSelection,
		scroll,
		zoomBy,
		fling,
	};
}

export type CameraModule = ReturnType<typeof createCameraModule>;
