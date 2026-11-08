import { containedRect, type Rect } from "./display-input";
import {
	clampView,
	type DisplayView,
	FIT_VIEW,
	isFit,
	panBy,
	reveal,
	type ViewGeometry,
	zoomAt,
} from "./display-viewport";

type CameraOptions = {
	surface: () => HTMLElement | null;
	video: () => HTMLVideoElement | null;
	stage: () => HTMLElement | null;
	covered: () => number;
};

function visibleFrame(box: DOMRect, covered: number): Rect {
	const viewport = window.visualViewport;
	const left = Math.max(box.left, viewport?.offsetLeft ?? 0);
	const top = Math.max(box.top, viewport?.offsetTop ?? 0);
	const right = Math.min(
		box.right,
		viewport ? viewport.offsetLeft + viewport.width : window.innerWidth,
	);
	const bottom =
		Math.min(
			box.bottom,
			viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
		) - covered;
	return {
		left: left - box.left,
		top: top - box.top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};
}

export function createDisplayCamera(options: CameraOptions) {
	let view: DisplayView = FIT_VIEW;
	let scale = $state(1);
	let frame = 0;
	let smooth = false;

	function geometry(): { box: DOMRect; geometry: ViewGeometry } | null {
		const surface = options.surface();
		const video = options.video();
		if (!surface || !video?.videoWidth || !video.videoHeight) return null;
		const box = surface.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0) return null;
		return {
			box,
			geometry: {
				content: containedRect(
					{ left: 0, top: 0, width: box.width, height: box.height },
					video.videoWidth,
					video.videoHeight,
				),
				frame: visibleFrame(box, options.covered()),
				sourceWidth: video.videoWidth,
			},
		};
	}

	function render() {
		frame = 0;
		const stage = options.stage();
		if (!stage) return;
		stage.style.transition = smooth ? "" : "none";
		smooth = false;
		const still =
			isFit(view) && Math.abs(view.x) < 0.5 && Math.abs(view.y) < 0.5;
		stage.style.transform = still
			? ""
			: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
	}

	function apply(next: DisplayView, animate = false) {
		view = next;
		scale = next.scale;
		smooth ||= animate;
		frame ||= requestAnimationFrame(render);
	}

	return {
		get scale() {
			return scale;
		},

		zoom(factor: number, clientX: number, clientY: number) {
			const current = geometry();
			if (current)
				apply(
					zoomAt(
						view,
						factor,
						clientX - current.box.left,
						clientY - current.box.top,
						current.geometry,
					),
				);
		},

		pan(dx: number, dy: number): { dx: number; dy: number } {
			const current = geometry();
			if (!current) return { dx, dy };
			const moved = panBy(view, dx, dy, current.geometry);
			apply(moved.view);
			return moved.rest;
		},

		reveal(bounds: readonly [number, number, number, number], zoom: boolean) {
			const current = geometry();
			if (current) apply(reveal(view, bounds, current.geometry, zoom), true);
		},

		follow(x: number, y: number) {
			const current = geometry();
			if (current && !isFit(view))
				apply(reveal(view, [x, y, 0, 0], current.geometry, false));
		},

		fit() {
			const current = geometry();
			apply(current ? clampView(FIT_VIEW, current.geometry) : FIT_VIEW, true);
		},

		refit() {
			const current = geometry();
			if (current) apply(clampView(view, current.geometry));
		},

		reset() {
			apply(FIT_VIEW);
		},

		dispose() {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		},
	};
}

export type DisplayCamera = ReturnType<typeof createDisplayCamera>;
