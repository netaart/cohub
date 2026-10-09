
import type { BoardDash } from "@cohub/protocol";
import type { Graphics } from "pixi.js";
import type { WorldPoint } from "../geometry.js";
import { worldPoint } from "../geometry.js";

const HEAD_SPREAD = Math.PI / 6;

export function dashPattern(dash: BoardDash | undefined, width: number): [number, number] | null {
	if (dash === "dashed") return [Math.max(6, width * 4), Math.max(4, width * 3)];
	if (dash === "dotted") return [Math.max(0.5, width * 0.01), Math.max(3, width * 2)];
	return null;
}

export function trimPolyline(path: readonly WorldPoint[], trim: number | undefined): readonly WorldPoint[] {
	if (trim === undefined || trim >= 1 || path.length < 2) return path;
	if (trim <= 0) return [];
	let total = 0;
	for (let index = 1; index < path.length; index += 1) {
		const a = path[index - 1] as WorldPoint;
		const b = path[index] as WorldPoint;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	let remaining = total * trim;
	const out: WorldPoint[] = [path[0] as WorldPoint];
	for (let index = 1; index < path.length; index += 1) {
		const a = path[index - 1] as WorldPoint;
		const b = path[index] as WorldPoint;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length >= remaining) {
			const t = length > 0 ? remaining / length : 0;
			out.push(worldPoint(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
			return out;
		}
		out.push(b);
		remaining -= length;
	}
	return out;
}

export function tracePolyline(graphics: Graphics, path: readonly WorldPoint[], pattern: [number, number] | null, closed = false) {
	const points = closed && path.length > 2 ? [...path, path[0] as WorldPoint] : path;
	if (points.length < 2) return;
	if (!pattern) {
		const first = points[0] as WorldPoint;
		graphics.moveTo(first.x, first.y);
		for (let index = 1; index < points.length; index += 1) {
			const point = points[index] as WorldPoint;
			graphics.lineTo(point.x, point.y);
		}
		if (closed) graphics.closePath();
		return;
	}
	const [dash, gap] = pattern;
	let penDown = true;
	let fresh = true;
	let remaining = dash;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as WorldPoint;
		const b = points[index] as WorldPoint;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy);
		let travelled = 0;
		while (length - travelled > 1e-4) {
			const step = Math.min(length - travelled, remaining);
			if (penDown) {
				const t0 = travelled / length;
				const t1 = (travelled + step) / length;
				if (fresh) graphics.moveTo(a.x + dx * t0, a.y + dy * t0);
				fresh = false;
				graphics.lineTo(a.x + dx * t1, a.y + dy * t1);
			}
			travelled += step;
			remaining -= step;
			if (remaining <= 1e-4) {
				penDown = !penDown;
				fresh = penDown;
				remaining = penDown ? dash : gap;
			}
		}
	}
}

export function traceArrowhead(graphics: Graphics, tip: WorldPoint, angle: number, size: number) {
	graphics
		.moveTo(tip.x - size * Math.cos(angle - HEAD_SPREAD), tip.y - size * Math.sin(angle - HEAD_SPREAD))
		.lineTo(tip.x, tip.y)
		.lineTo(tip.x - size * Math.cos(angle + HEAD_SPREAD), tip.y - size * Math.sin(angle + HEAD_SPREAD));
}

export function endAngle(path: readonly WorldPoint[], atStart: boolean): number | null {
	if (path.length < 2) return null;
	const tip = (atStart ? path[0] : path[path.length - 1]) as WorldPoint;
	for (let offset = 1; offset < path.length; offset += 1) {
		const other = (atStart ? path[offset] : path[path.length - 1 - offset]) as WorldPoint;
		if (Math.hypot(tip.x - other.x, tip.y - other.y) > 1e-3) return Math.atan2(tip.y - other.y, tip.x - other.x);
	}
	return null;
}
