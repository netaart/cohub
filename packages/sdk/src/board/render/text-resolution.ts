import type { Text } from "pixi.js";

const MAX_BOARD_RESOLUTION = 3;
const MAX_BOARD_PIXELS = 10_000_000;
const MIN_TEXT_RESOLUTION = 0.125;
const MAX_TEXT_EDGE = 4096;
const TEXT_UPSCALE_TOLERANCE = 1.25;

export function getBoardResolution(
	size?: { width: number; height: number },
	devicePixelRatio = globalThis.devicePixelRatio,
) {
	const density = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
	const pixels = size ? size.width * size.height : 0;
	const budget = pixels > 0 ? Math.max(1, Math.sqrt(MAX_BOARD_PIXELS / pixels)) : MAX_BOARD_RESOLUTION;
	return Math.min(density, MAX_BOARD_RESOLUTION, budget);
}

const ZOOM_BUCKETS = [0.5, 1, 1.5, 2, 3, 4] as const;

export function textZoomBucket(zoom: number): number {
	const clamped = Math.max(0.1, Math.min(4, zoom));
	for (const bucket of ZOOM_BUCKETS) {
		if (clamped <= bucket) return bucket;
	}
	return ZOOM_BUCKETS[ZOOM_BUCKETS.length - 1] ?? 4;
}

/** Exact screen density at rest; reuse or step the raster while moving. */
export function boardTextResolution(target: number, current: number, settled: boolean): number {
	if (!Number.isFinite(target) || target <= 0) return current > 0 ? current : 1;
	if (settled || !(current > 0)) return target;
	if (target <= current * TEXT_UPSCALE_TOLERANCE && target >= current / 2) return current;
	return 2 ** Math.ceil(Math.log2(target));
}

export function syncTextResolution(text: Text, resolution: number) {
	const { width, height } = text.bounds;
	const limit = MAX_TEXT_EDGE / Math.max(1, Math.ceil(width + text.style.padding * 2), Math.ceil(height + text.style.padding * 2));
	const next = Math.min(limit, Math.max(MIN_TEXT_RESOLUTION, resolution));
	if (text.resolution !== next) text.resolution = next;
}
