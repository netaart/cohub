export const AXIS_LOCK_DISTANCE_PX = 8;
export const AXIS_LOCK_RATIO = 1.25;
export const FLICK_VELOCITY_PX_PER_MS = 0.35;

export type GestureAxis = "horizontal" | "vertical" | null;

export function resolveGestureAxis(options: {
	absDx: number;
	absDy: number;
}): GestureAxis {
	const { absDx, absDy } = options;
	if (absDx < AXIS_LOCK_DISTANCE_PX && absDy < AXIS_LOCK_DISTANCE_PX)
		return null;
	if (absDx > absDy * AXIS_LOCK_RATIO) return "horizontal";
	if (absDy > absDx * AXIS_LOCK_RATIO) return "vertical";
	return null;
}
