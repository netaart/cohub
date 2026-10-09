export type ImageGestureState = {
	zoom: number;
	panX: number;
	panY: number;
};

export type ImageGestureOptions = {
	getState: () => ImageGestureState;
	setState: (state: ImageGestureState) => void;
	minZoom?: number;
	maxZoom?: number;
	onDraggingChange?: (dragging: boolean) => void;
};

export const IMAGE_MIN_ZOOM = 0.25;
export const IMAGE_MAX_ZOOM = 4;
export const IMAGE_ZOOM_STEP = 0.25;

export function clampImageZoom(value: number) {
	return Math.min(IMAGE_MAX_ZOOM, Math.max(IMAGE_MIN_ZOOM, value));
}

type Point = { clientX: number; clientY: number };

type ActivePointer = Point & { pointerId: number };

type GestureLayout = {
	left: number;
	top: number;
	width: number;
	height: number;
	stageWidth: number;
	stageHeight: number;
	imageWidth: number;
	imageHeight: number;
};

export function imageTransform(state: ImageGestureState) {
	return `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.zoom})`;
}

function distance(a: Point, b: Point) {
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpoint(a: Point, b: Point): Point {
	return {
		clientX: (a.clientX + b.clientX) / 2,
		clientY: (a.clientY + b.clientY) / 2,
	};
}

/**
 * Shared image gesture state machine. The host owns state so it can keep
 * preview state local or persist it with the active file tab.
 */
export function createImageGestureHandlers(options: ImageGestureOptions) {
	const minZoom = options.minZoom ?? IMAGE_MIN_ZOOM;
	const maxZoom = options.maxZoom ?? IMAGE_MAX_ZOOM;
	const pointers = new Map<number, ActivePointer>();
	let pinchStart: {
		distance: number;
		zoom: number;
		panX: number;
		panY: number;
		center: Point;
	} | null = null;
	let panStart: {
		pointerId: number;
		clientX: number;
		clientY: number;
		panX: number;
		panY: number;
	} | null = null;
	let gestureState: ImageGestureState | null = null;
	let activeImage: HTMLImageElement | null = null;
	let gestureLayout: GestureLayout | null = null;

	function clampZoom(value: number) {
		return Math.min(maxZoom, Math.max(minZoom, value));
	}

	function readLayout(
		stage: HTMLElement,
		image: HTMLImageElement | null = activeImage,
	): GestureLayout | null {
		if (!image) return null;
		const rect = stage.getBoundingClientRect();
		return {
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
			stageWidth: stage.clientWidth,
			stageHeight: stage.clientHeight,
			imageWidth: image.offsetWidth,
			imageHeight: image.offsetHeight,
		};
	}

	function clampPan(
		panX: number,
		panY: number,
		layout: GestureLayout | null,
		zoom: number,
	) {
		if (!layout) return { panX, panY };
		const maxX = Math.max(
			0,
			(layout.imageWidth * zoom - layout.stageWidth) / 2,
		);
		const maxY = Math.max(
			0,
			(layout.imageHeight * zoom - layout.stageHeight) / 2,
		);
		return {
			panX: Math.min(maxX, Math.max(-maxX, panX)),
			panY: Math.min(maxY, Math.max(-maxY, panY)),
		};
	}

	function renderVisual(state: ImageGestureState) {
		if (!activeImage) return;
		activeImage.style.transform = imageTransform(state);
	}

	let dragging = false;
	function setDragging(value: boolean) {
		if (dragging === value) return;
		dragging = value;
		if (activeImage) activeImage.style.transition = value ? "none" : "";
		options.onDraggingChange?.(value);
	}

	function clearPointer(pointerId: number, currentTarget: EventTarget | null) {
		pointers.delete(pointerId);
		const target = currentTarget as HTMLElement | null;
		if (target?.hasPointerCapture(pointerId))
			target.releasePointerCapture(pointerId);
	}

	function end() {
		const state = gestureState;
		if (state) options.setState(state);
		if (activeImage) {
			if (state) activeImage.style.transform = imageTransform(state);
			activeImage.style.removeProperty("transition");
		}
		gestureState = null;
		activeImage = null;
		gestureLayout = null;
		pinchStart = null;
		panStart = null;
		setDragging(false);
	}

	function onPointerDown(event: PointerEvent) {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const stage = event.currentTarget as HTMLElement;
		const target = event.target as HTMLElement | null;
		if (target && target !== stage && target.tagName !== "IMG") return;
		activeImage ??= stage.querySelector<HTMLImageElement>("img");
		gestureLayout ??= readLayout(stage);

		stage.setPointerCapture(event.pointerId);
		pointers.set(event.pointerId, {
			pointerId: event.pointerId,
			clientX: event.clientX,
			clientY: event.clientY,
		});

		if (pointers.size === 1) gestureState = options.getState();

		if (pointers.size === 2) {
			if (event.cancelable) event.preventDefault();
			const [first, second] = [...pointers.values()];
			if (!first || !second) return;
			const state = gestureState ?? options.getState();
			gestureState = state;
			pinchStart = {
				distance: Math.max(1, distance(first, second)),
				zoom: state.zoom,
				panX: state.panX,
				panY: state.panY,
				center: midpoint(first, second),
			};
			panStart = null;
			// Keep the transform transition-free for the whole pinch gesture.
			setDragging(true);
			return;
		}

		const state = gestureState ?? options.getState();
		gestureState = state;
		if (state.zoom > 1) {
			event.preventDefault();
			panStart = {
				pointerId: event.pointerId,
				clientX: event.clientX,
				clientY: event.clientY,
				panX: state.panX,
				panY: state.panY,
			};
			setDragging(true);
		}
	}

	function onPointerMove(event: PointerEvent) {
		const active = pointers.get(event.pointerId);
		if (!active) return;
		active.clientX = event.clientX;
		active.clientY = event.clientY;

		const stage = event.currentTarget as HTMLElement;
		const state = gestureState ?? options.getState();
		gestureState = state;

		if (pointers.size >= 2 && pinchStart) {
			const [first, second] = [...pointers.values()];
			if (!first || !second) return;
			event.preventDefault();
			const nextZoom = clampZoom(
				pinchStart.zoom * (distance(first, second) / pinchStart.distance),
			);
			const focus = midpoint(first, second);
			const layout = gestureLayout ?? readLayout(stage);
			gestureLayout = layout;
			if (!layout) return;
			const centerX = layout.left + layout.width / 2;
			const centerY = layout.top + layout.height / 2;
			const imagePointX =
				(pinchStart.center.clientX - centerX - pinchStart.panX) /
				pinchStart.zoom;
			const imagePointY =
				(pinchStart.center.clientY - centerY - pinchStart.panY) /
				pinchStart.zoom;
			const nextPan =
				nextZoom <= 1
					? { panX: 0, panY: 0 }
					: clampPan(
							focus.clientX - centerX - imagePointX * nextZoom,
							focus.clientY - centerY - imagePointY * nextZoom,
							layout,
							nextZoom,
						);
			gestureState = { zoom: nextZoom, ...nextPan };
			renderVisual(gestureState);
			return;
		}

		if (!panStart || panStart.pointerId !== event.pointerId || state.zoom <= 1)
			return;
		event.preventDefault();
		gestureState = {
			zoom: state.zoom,
			...clampPan(
				panStart.panX + event.clientX - panStart.clientX,
				panStart.panY + event.clientY - panStart.clientY,
				gestureLayout,
				state.zoom,
			),
		};
		renderVisual(gestureState);
	}

	function onPointerUp(event: PointerEvent) {
		clearPointer(event.pointerId, event.currentTarget);
		if (pointers.size === 1 && (gestureState ?? options.getState()).zoom > 1) {
			const remaining = [...pointers.values()][0];
			if (remaining) {
				const state = gestureState ?? options.getState();
				gestureState = state;
				panStart = {
					pointerId: remaining.pointerId,
					clientX: remaining.clientX,
					clientY: remaining.clientY,
					panX: state.panX,
					panY: state.panY,
				};
				setDragging(true);
				pinchStart = null;
				return;
			}
		}
		if (pointers.size === 0) end();
	}

	function reset() {
		pointers.clear();
		gestureState = null;
		if (activeImage) {
			const state = options.getState();
			activeImage.style.transform = imageTransform(state);
			activeImage.style.removeProperty("transition");
		}
		activeImage = null;
		gestureLayout = null;
		pinchStart = null;
		panStart = null;
		setDragging(false);
	}

	return {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel: onPointerUp,
		reset,
	};
}
