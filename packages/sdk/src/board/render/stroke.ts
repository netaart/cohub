
import type { BoardDash, BoardShapeItem } from "@cohub/protocol";
import type { Graphics } from "pixi.js";
import type { WorldPoint } from "../model/geometry.js";
import { worldPoint } from "../model/geometry.js";

const HEAD_SPREAD = Math.PI / 6;
export const DEFAULT_ROUNDED_RADIUS = 8;

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

export function tracePolyline(graphics: Graphics, path: readonly WorldPoint[], pattern: [number, number] | null, closed = false, offset = 0) {
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
	const phase = Math.max(0, offset) % (dash + gap);
	let penDown = phase < dash;
	let fresh = penDown;
	let remaining = penDown ? dash - phase : dash + gap - phase;
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

export function roundRectPoints(width: number, height: number, radius: number): WorldPoint[] {
	const r = Math.min(radius, width / 2, height / 2);
	if (r <= 0) return [worldPoint(0, 0), worldPoint(width, 0), worldPoint(width, height), worldPoint(0, height), worldPoint(0, 0)];
	const corner = (cx: number, cy: number, from: number) =>
		Array.from({ length: 9 }, (_, index) => {
			const angle = from + (index / 8) * (Math.PI / 2);
			return worldPoint(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
		});
	return [
		...corner(width - r, r, -Math.PI / 2),
		...corner(width - r, height - r, 0),
		...corner(r, height - r, Math.PI / 2),
		...corner(r, r, Math.PI),
		worldPoint(width - r, 0),
	];
}

export function shapeOutlinePoints(geometry: BoardShapeItem["props"]["geometry"], width: number, height: number, radius: number): WorldPoint[] {
	const p = (x: number, y: number) => worldPoint(x, y);
	switch (geometry) {
		case "ellipse": {
			const segments = 64;
			return Array.from({ length: segments + 1 }, (_, index) => {
				const angle = -Math.PI / 2 + (index / segments) * Math.PI * 2;
				return p(width / 2 + (Math.cos(angle) * width) / 2, height / 2 + (Math.sin(angle) * height) / 2);
			});
		}
		case "diamond":
			return [p(width / 2, 0), p(width, height / 2), p(width / 2, height), p(0, height / 2), p(width / 2, 0)];
		case "triangle":
			return [p(width / 2, 0), p(width, height), p(0, height), p(width / 2, 0)];
		default:
			return roundRectPoints(width, height, radius);
	}
}
