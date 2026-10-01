import type { BoardDrawPoint as DrawPoint } from "@neta-art/cohub/board";

export type BoardDrawInputSample = {
	pointerId: number;
	world: { x: number; y: number };
	pressure: number;
};

export function appendBoardDrawSample(
	points: DrawPoint[],
	ownerPointerId: number,
	sample: BoardDrawInputSample,
	zoom: number,
): DrawPoint[] {
	if (sample.pointerId !== ownerPointerId) return points;
	const last = points.at(-1);
	if (
		last &&
		Math.hypot(sample.world.x - last.x, sample.world.y - last.y) <
			0.5 / Math.max(zoom, 0.0001)
	)
		return points;
	return [
		...points,
		{ x: sample.world.x, y: sample.world.y, p: sample.pressure },
	];
}
