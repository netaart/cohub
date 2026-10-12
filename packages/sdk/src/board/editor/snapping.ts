/**
 * Snapping engine — pure geometry for alignment guides.
 *
 * Given the moving selection's bounds and a set of candidate targets (other
 * shapes' bounds, optionally a grid), this finds the nearest edge/center snap on
 * each axis within a threshold and returns both the corrective delta and the
 * guide lines to render. Independent of the editor and renderer so it is trivial
 * to test and reuse (drag, resize, arrow endpoints).
 */

import type { Rect } from "../model/index.js";

export type SnapAxis = "x" | "y";

/** A rendered alignment guide: a segment along one axis at a world position. */
export type SnapGuide = {
	axis: SnapAxis;
	/** World position of the guide line (x for vertical, y for horizontal). */
	at: number;
	/** Extent of the guide segment (the other axis), inclusive. */
	from: number;
	to: number;
};

export type SnapResult = {
	/** Correction to apply to the moving selection (0 when no snap on that axis). */
	dx: number;
	dy: number;
	guides: SnapGuide[];
};

export type SnapOptions = {
	/** World-space snap threshold (typically screenPx / zoom). */
	threshold: number;
	/** Snap to a regular grid of this size (0 disables grid snapping). */
	gridSize?: number;
};

/** The three snap positions (near/center/far) of a bounds rect on one axis. */
function axisPositions(rect: Rect, axis: SnapAxis): number[] {
	const origin = axis === "x" ? rect.x : rect.y;
	const size = axis === "x" ? rect.width : rect.height;
	return [origin, origin + size / 2, origin + size];
}

function axisExtent(rect: Rect, axis: SnapAxis): [number, number] {
	// Extent along the *other* axis, used to draw a guide of sensible length.
	if (axis === "x") return [rect.y, rect.y + rect.height];
	return [rect.x, rect.x + rect.width];
}

/**
 * Compute the snap for a moving selection bounds against candidate target
 * bounds. Each axis is solved independently: the nearest matching edge/center
 * within `threshold` wins. Grid lines are included as targets when enabled.
 */
export function computeSnap(
	moving: Rect,
	targets: Rect[],
	options: SnapOptions,
): SnapResult {
	const { threshold } = options;
	const guides: SnapGuide[] = [];
	let dx = 0;
	let dy = 0;

	for (const axis of ["x", "y"] as const) {
		const movingPositions = axisPositions(moving, axis);
		const candidates: Array<{ at: number; from: number; to: number }> = [];
		for (const target of targets) {
			const [from, to] = axisExtent(target, axis);
			for (const at of axisPositions(target, axis))
				candidates.push({ at, from, to });
		}
		if (options.gridSize && options.gridSize > 0) {
			const [from, to] = axisExtent(moving, axis);
			for (const pos of movingPositions) {
				const grid = Math.round(pos / options.gridSize) * options.gridSize;
				candidates.push({ at: grid, from, to });
			}
		}

		let best: { delta: number; at: number; from: number; to: number } | null =
			null;
		for (const movingPos of movingPositions) {
			for (const candidate of candidates) {
				const delta = candidate.at - movingPos;
				if (Math.abs(delta) > threshold) continue;
				if (!best || Math.abs(delta) < Math.abs(best.delta))
					best = { delta, ...candidate };
			}
		}
		if (!best) continue;
		if (axis === "x") dx = best.delta;
		else dy = best.delta;
		const [movingFrom, movingTo] = axisExtent(moving, axis);
		guides.push({
			axis,
			at: best.at,
			from: Math.min(best.from, movingFrom),
			to: Math.max(best.to, movingTo),
		});
	}

	return { dx, dy, guides };
}
