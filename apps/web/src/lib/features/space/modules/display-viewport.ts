import type { Rect } from "./display-input.ts";

export type DisplayView = { scale: number; x: number; y: number };

export type ViewGeometry = {
	content: Rect;
	frame: Rect;
	sourceWidth: number;
};

export const FIT_VIEW: DisplayView = { scale: 1, x: 0, y: 0 };

const MIN_MAX_SCALE = 4;
const MAX_SCALE = 12;
const PIXELS_PER_SOURCE_PIXEL = 2;
const READABLE_FIELD = 36;
const REVEAL_MARGIN = 16;

export function maxScale({ content, sourceWidth }: ViewGeometry): number {
	if (content.width <= 0 || sourceWidth <= 0) return MIN_MAX_SCALE;
	const sharp = (sourceWidth * PIXELS_PER_SOURCE_PIXEL) / content.width;
	return Math.min(MAX_SCALE, Math.max(MIN_MAX_SCALE, sharp));
}

function clampScale(scale: number, geometry: ViewGeometry) {
	return Math.min(maxScale(geometry), Math.max(1, scale));
}

function clampOffset(
	offset: number,
	scale: number,
	start: number,
	extent: number,
	frameStart: number,
	frameExtent: number,
) {
	const size = extent * scale;
	const origin = start * scale;
	if (size <= frameExtent)
		return frameStart + (frameExtent - size) / 2 - origin;
	const least = frameStart + frameExtent - size - origin;
	return Math.min(frameStart - origin, Math.max(least, offset));
}

export function clampView(
	view: DisplayView,
	geometry: ViewGeometry,
): DisplayView {
	const scale = clampScale(view.scale, geometry);
	const { content, frame } = geometry;
	return {
		scale,
		x: clampOffset(
			view.x,
			scale,
			content.left,
			content.width,
			frame.left,
			frame.width,
		),
		y: clampOffset(
			view.y,
			scale,
			content.top,
			content.height,
			frame.top,
			frame.height,
		),
	};
}

export function isFit(view: DisplayView): boolean {
	return view.scale <= 1.001;
}

export function zoomAt(
	view: DisplayView,
	factor: number,
	x: number,
	y: number,
	geometry: ViewGeometry,
): DisplayView {
	const scale = clampScale(view.scale * factor, geometry);
	const ratio = scale / view.scale;
	return clampView(
		{ scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio },
		geometry,
	);
}

export function panBy(
	view: DisplayView,
	dx: number,
	dy: number,
	geometry: ViewGeometry,
): { view: DisplayView; rest: { dx: number; dy: number } } {
	const next = clampView({ ...view, x: view.x + dx, y: view.y + dy }, geometry);
	return {
		view: next,
		rest: { dx: dx - (next.x - view.x), dy: dy - (next.y - view.y) },
	};
}

function shiftInto(start: number, end: number, min: number, max: number) {
	if (end - start > max - min || start < min) return min - start;
	if (end > max) return max - end;
	return 0;
}

export function reveal(
	view: DisplayView,
	bounds: readonly [number, number, number, number],
	geometry: ViewGeometry,
	zoom = true,
): DisplayView {
	const { content, frame } = geometry;
	const left = content.left + bounds[0] * content.width;
	const top = content.top + bounds[1] * content.height;
	const width = bounds[2] * content.width;
	const height = bounds[3] * content.height;
	let scale = view.scale;
	if (zoom && height > 0 && height * scale < READABLE_FIELD) {
		const fits =
			width > 0
				? (frame.width - 2 * REVEAL_MARGIN) / width
				: Number.POSITIVE_INFINITY;
		scale = Math.max(scale, Math.min(READABLE_FIELD / height, fits));
	}
	scale = clampScale(scale, geometry);
	const cx = left + width / 2;
	const cy = top + height / 2;
	let x = cx * view.scale + view.x - cx * scale;
	let y = cy * view.scale + view.y - cy * scale;
	x += shiftInto(
		left * scale + x,
		(left + width) * scale + x,
		frame.left + REVEAL_MARGIN,
		frame.left + frame.width - REVEAL_MARGIN,
	);
	y += shiftInto(
		top * scale + y,
		(top + height) * scale + y,
		frame.top + REVEAL_MARGIN,
		frame.top + frame.height - REVEAL_MARGIN,
	);
	return clampView({ scale, x, y }, geometry);
}
