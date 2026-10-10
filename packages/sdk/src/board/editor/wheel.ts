const WHEEL_ZOOM_INTENSITY = 0.012;
const MAX_WHEEL_ZOOM_FACTOR = 1.35;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 80;

export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
	if (!Number.isFinite(delta)) return 0;
	if (deltaMode === 1) return delta * LINE_DELTA_PX;
	if (deltaMode === 2) return delta * PAGE_DELTA_PX;
	return delta;
}

export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
	const factor = Math.exp(
		-normalizeWheelDelta(deltaY, deltaMode) * WHEEL_ZOOM_INTENSITY,
	);
	return Math.min(
		MAX_WHEEL_ZOOM_FACTOR,
		Math.max(1 / MAX_WHEEL_ZOOM_FACTOR, factor),
	);
}
