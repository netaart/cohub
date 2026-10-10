import {
	type BoardViewport,
	cameraForRect,
	FIT_PADDING,
	normalizeViewport,
	panBy,
	pointToWorld,
	type Rect,
	type ScreenPoint,
	screenPoint,
	type WorldPoint,
	zoomAround,
} from "../model/index.js";
import type { BoardCameraPolicy, EditorContext } from "./context.js";
import { normalizeWheelDelta, wheelZoomFactor } from "./wheel.js";

const ZOOM_STEP = 1.28;
const CAMERA_ANIMATION_MS = 240;

export type BoardFocusOptions = {
	fit?: "contain" | "cover";
	padding?: number;
	minZoom?: number;
	maxZoom?: number;
	animate?: boolean;
};

function easeOutCubic(t: number) {
	return 1 - (1 - t) * (1 - t) * (1 - t);
}

export function createCameraModule(ctx: EditorContext) {
	const { state } = ctx;
	let animation = 0;

	function setCamera(viewport: BoardViewport) {
		state.camera = normalizeViewport(viewport, state.camera);
		state.hoverPoint = null;
		state.hoverId = null;
	}

	function setCameraPolicy(policy: BoardCameraPolicy) {
		if (state.cameraPolicy === policy) return;
		state.cameraPolicy = policy;
		ctx.preferencesChanged();
	}

	function takeCameraControl() {
		setCameraPolicy("free");
	}

	function cancelAnimation() {
		if (animation) cancelAnimationFrame(animation);
		animation = 0;
	}

	function animateCamera(target: BoardViewport) {
		cancelAnimation();
		const from = normalizeViewport(state.camera);
		const to = normalizeViewport(target, from);
		const started = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - started) / CAMERA_ANIMATION_MS);
			const eased = easeOutCubic(t);
			setCamera({
				x: from.x + (to.x - from.x) * eased,
				y: from.y + (to.y - from.y) * eased,
				zoom: from.zoom + (to.zoom - from.zoom) * eased,
			});
			animation = t < 1 ? requestAnimationFrame(step) : 0;
		};
		animation = requestAnimationFrame(step);
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
		const target = zoomAround(state.camera, point, state.camera.zoom * factor);
		if (animate) animateCamera(target);
		else setCamera(target);
	}

	function focusRect(rect: Rect, focus: BoardFocusOptions = {}) {
		const { surfaceSize } = state;
		if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return;
		const target = cameraForRect(rect, surfaceSize, {
			fit: focus.fit ?? "contain",
			padding: focus.padding ?? 32,
			minZoom: focus.minZoom,
			maxZoom: focus.maxZoom,
		});
		if (focus.animate === false) setCamera(target);
		else animateCamera(target);
	}

	function fitView(focus: BoardFocusOptions = {}) {
		const content = ctx.query.contentBounds();
		if (content && state.surfaceSize.width > 0) focusRect(content, { padding: FIT_PADDING, ...focus });
		else if (focus.animate === false) setCamera({ x: 0, y: 0, zoom: 1 });
		else animateCamera({ x: 0, y: 0, zoom: 1 });
	}

	function focusItems(ids: Iterable<string>, focus?: BoardFocusOptions) {
		const rect = ctx.query.contentBounds(ids);
		if (rect) focusRect(rect, focus);
	}

	function focusSelection(focus?: BoardFocusOptions) {
		const rect = ctx.query.contentBounds(state.selection);
		if (rect) focusRect(rect, focus);
		else fitView();
	}

	function wheel(point: ScreenPoint, deltaX: number, deltaY: number, zoomKey: boolean, deltaMode = 0) {
		cancelAnimation();
		const { camera } = state;
		if (zoomKey) {
			setCamera(zoomAround(camera, point, camera.zoom * wheelZoomFactor(deltaY, deltaMode)));
			return;
		}
		setCamera(
			panBy(
				camera,
				-normalizeWheelDelta(deltaX, deltaMode) * 1.15,
				-normalizeWheelDelta(deltaY, deltaMode) * 1.15,
			),
		);
	}

	return {
		setCamera,
		setCameraPolicy,
		takeCameraControl,
		cancelAnimation,
		viewCenter,
		visibleRect,
		zoomAt,
		zoomIn: () => zoomAt(surfaceCenter(), ZOOM_STEP, true),
		zoomOut: () => zoomAt(surfaceCenter(), 1 / ZOOM_STEP, true),
		resetZoom: () => animateCamera({ ...state.camera, zoom: 1 }),
		focusRect,
		fitView,
		focusItems,
		focusNode: (id: string, focus?: BoardFocusOptions) => focusItems([id], focus),
		focusSelection,
		wheel,
	};
}

export type CameraModule = ReturnType<typeof createCameraModule>;
