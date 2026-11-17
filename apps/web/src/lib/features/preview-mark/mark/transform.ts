import type { CropRect, Point, Stroke } from "../types.ts";

function offsetPoint(point: Point, dx: number, dy: number): Point {
	return { x: point.x + dx, y: point.y + dy };
}

function offsetStroke(stroke: Stroke, dx: number, dy: number): Stroke {
	if (stroke.tool === "pen") {
		return {
			...stroke,
			points: stroke.points.map((point) => offsetPoint(point, dx, dy)),
		};
	}
	if (stroke.tool === "arrow") {
		return {
			...stroke,
			from: offsetPoint(stroke.from, dx, dy),
			to: offsetPoint(stroke.to, dx, dy),
		};
	}
	return {
		...stroke,
		a: offsetPoint(stroke.a, dx, dy),
		b: offsetPoint(stroke.b, dx, dy),
	};
}

function boundsOf(stroke: Stroke): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	if (stroke.tool === "pen") {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const point of stroke.points) {
			minX = Math.min(minX, point.x);
			minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}
		if (!Number.isFinite(minX)) {
			return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		}
		return { minX, minY, maxX, maxY };
	}
	if (stroke.tool === "arrow") {
		return {
			minX: Math.min(stroke.from.x, stroke.to.x),
			minY: Math.min(stroke.from.y, stroke.to.y),
			maxX: Math.max(stroke.from.x, stroke.to.x),
			maxY: Math.max(stroke.from.y, stroke.to.y),
		};
	}
	return {
		minX: Math.min(stroke.a.x, stroke.b.x),
		minY: Math.min(stroke.a.y, stroke.b.y),
		maxX: Math.max(stroke.a.x, stroke.b.x),
		maxY: Math.max(stroke.a.y, stroke.b.y),
	};
}

function intersectsFrame(
	stroke: Stroke,
	frameWidth: number,
	frameHeight: number,
): boolean {
	const bounds = boundsOf(stroke);
	return !(
		bounds.maxX < 0 ||
		bounds.maxY < 0 ||
		bounds.minX > frameWidth ||
		bounds.minY > frameHeight
	);
}

/** Rebase strokes into crop-local coordinates and drop marks fully outside. */
export function strokesAfterCrop(strokes: Stroke[], crop: CropRect): Stroke[] {
	const dx = -crop.x;
	const dy = -crop.y;
	return strokes
		.map((stroke) => offsetStroke(stroke, dx, dy))
		.filter((stroke) => intersectsFrame(stroke, crop.width, crop.height));
}
