import type { BoardDrawPoint as DrawPoint } from "@neta-art/cohub/board";

export type BoardDrawInputSample = {
	world: { x: number; y: number };
	pressure: number;
};

const COORDINATE_SCALE = 100;
const PRESSURE_SCALE = 100;

export function quantizeDrawCoordinate(value: number): number {
	return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

function quantizePressure(value: number): number {
	return (
		Math.round(Math.min(1, Math.max(0, value)) * PRESSURE_SCALE) /
		PRESSURE_SCALE
	);
}

export function appendBoardDrawSamples(
	points: DrawPoint[],
	samples: Iterable<BoardDrawInputSample>,
	zoom: number,
): boolean {
	const minimum = 0.5 / Math.max(zoom, 0.0001);
	let grew = false;
	for (const sample of samples) {
		const x = quantizeDrawCoordinate(sample.world.x);
		const y = quantizeDrawCoordinate(sample.world.y);
		const last = points.at(-1);
		if (last && Math.hypot(x - last.x, y - last.y) < minimum) continue;
		points.push({ x, y, p: quantizePressure(sample.pressure) });
		grew = true;
	}
	return grew;
}
