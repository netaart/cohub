
import {
	type BoardArrowAnchor,
	type BoardArrowEnd,
	type BoardArrowItem,
	type BoardFrame,
	type BoardLayout,
	type BoardMatrix,
	applyMatrix,
	autoAnchorSide,
	bendControl,
	framePoint,
	isArrowBinding,
	sideAnchor,
} from "@cohub/protocol";
import { BOARD_ARROW_STROKE_SIZE } from "@cohub/protocol/board-constants";
import { type Rect, type WorldPoint, worldPoint } from "../geometry.js";

export const ARROW_BINDING_GAP = 4;
const CURVE_SEGMENTS = 20;
const ORTHOGONAL_SNAP = 0.5;

type Side = "top" | "right" | "bottom" | "left";
const SIDE_NORMALS: Record<Side, WorldPoint> = {
	top: worldPoint(0, -1),
	right: worldPoint(1, 0),
	bottom: worldPoint(0, 1),
	left: worldPoint(-1, 0),
};

export type ResolvedArrowEnd = {
	point: WorldPoint;
	normal: WorldPoint;
	item?: string;
};

export type ResolvedArrow = {
	start: ResolvedArrowEnd;
	end: ResolvedArrowEnd;
	path: WorldPoint[];
	mid: WorldPoint;
};

export type ArrowFrameLookup = (id: string) => BoardFrame | undefined;

function rotate(vector: WorldPoint, degrees: number): WorldPoint {
	if (!degrees) return vector;
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return worldPoint(vector.x * cos - vector.y * sin, vector.x * sin + vector.y * cos);
}

function nearestSide(x: number, y: number): Side {
	const distances: Array<[Side, number]> = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
	distances.sort((a, b) => a[1] - b[1]);
	return distances[0]?.[0] ?? "right";
}

function center(frame: BoardFrame): WorldPoint {
	return worldPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
}

export function resolveAnchor(anchor: BoardArrowAnchor, frame: BoardFrame, toward: WorldPoint, gap = ARROW_BINDING_GAP): { point: WorldPoint; normal: WorldPoint } {
	let side: Side;
	let normalized: { x: number; y: number };
	if (anchor === "auto") {
		side = autoAnchorSide(frame, toward);
		normalized = sideAnchor(side, 0.5);
	} else if ("side" in anchor) {
		side = anchor.side;
		normalized = sideAnchor(side, anchor.offset);
	} else {
		normalized = anchor;
		side = nearestSide(anchor.x, anchor.y);
	}
	const base = framePoint(frame, normalized.x, normalized.y);
	const normal = rotate(SIDE_NORMALS[side], frame.rotation);
	return { point: worldPoint(base.x + normal.x * gap, base.y + normal.y * gap), normal };
}

function toWorld(matrix: BoardMatrix, point: { x: number; y: number }): WorldPoint {
	const mapped = applyMatrix(matrix, point);
	return worldPoint(mapped.x, mapped.y);
}

function resolveEnd(end: BoardArrowEnd, other: BoardArrowEnd, matrix: BoardMatrix, getFrame: ArrowFrameLookup): ResolvedArrowEnd {
	const origin = toWorld(matrix, { x: 0, y: 0 });
	const otherPoint = (() => {
		if (!isArrowBinding(other)) return toWorld(matrix, other);
		const frame = getFrame(other.item);
		return frame ? center(frame) : origin;
	})();
	if (isArrowBinding(end)) {
		const frame = getFrame(end.item);
		if (frame) {
			const resolved = resolveAnchor(end.anchor, frame, otherPoint);
			return { ...resolved, item: end.item };
		}
	}
	const point = isArrowBinding(end) ? origin : toWorld(matrix, end);
	const dx = point.x - otherPoint.x;
	const dy = point.y - otherPoint.y;
	const length = Math.hypot(dx, dy) || 1;
	return { point, normal: worldPoint(dx / length, dy / length) };
}

function quadratic(start: WorldPoint, control: WorldPoint, end: WorldPoint): WorldPoint[] {
	const out: WorldPoint[] = [];
	for (let index = 0; index <= CURVE_SEGMENTS; index += 1) {
		const t = index / CURVE_SEGMENTS;
		const mt = 1 - t;
		out.push(worldPoint(mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x, mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y));
	}
	return out;
}

function orthogonal(start: ResolvedArrowEnd, end: ResolvedArrowEnd): WorldPoint[] {
	const horizontalStart = Math.abs(start.normal.x) > Math.abs(start.normal.y);
	const horizontalEnd = Math.abs(end.normal.x) > Math.abs(end.normal.y);
	const a = start.point;
	const b = end.point;
	if (horizontalStart && horizontalEnd) {
		const midX = a.x + (b.x - a.x) * ORTHOGONAL_SNAP;
		return [a, worldPoint(midX, a.y), worldPoint(midX, b.y), b];
	}
	if (!horizontalStart && !horizontalEnd) {
		const midY = a.y + (b.y - a.y) * ORTHOGONAL_SNAP;
		return [a, worldPoint(a.x, midY), worldPoint(b.x, midY), b];
	}
	return horizontalStart ? [a, worldPoint(b.x, a.y), b] : [a, worldPoint(a.x, b.y), b];
}

function curveControl(start: ResolvedArrowEnd, end: ResolvedArrowEnd, bend: number): WorldPoint {
	if (bend) return bendControl(start.point, end.point, bend) as WorldPoint;
	const mid = worldPoint((start.point.x + end.point.x) / 2, (start.point.y + end.point.y) / 2);
	const normals = [start, end].filter((entry) => entry.item).map((entry) => entry.normal);
	if (!normals.length) return mid;
	const nx = normals.reduce((sum, normal) => sum + normal.x, 0) / normals.length;
	const ny = normals.reduce((sum, normal) => sum + normal.y, 0) / normals.length;
	const magnitude = Math.hypot(nx, ny);
	if (magnitude < 1e-4) return mid;
	const length = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y);
	const strength = Math.min(length * 0.18, 96);
	return worldPoint(mid.x + (nx / magnitude) * strength, mid.y + (ny / magnitude) * strength);
}

function selfLoop(frame: BoardFrame): WorldPoint[] {
	const size = Math.max(Math.min(frame.width, frame.height) * 0.45, 24);
	const right = frame.x + frame.width + ARROW_BINDING_GAP;
	const top = frame.y - ARROW_BINDING_GAP;
	const midY = frame.y + frame.height * 0.3;
	const midX = frame.x + frame.width * 0.7;
	return [worldPoint(midX, top), worldPoint(midX, top - size), worldPoint(right + size, top - size), worldPoint(right + size, midY), worldPoint(right, midY)];
}

export function resolveArrow(item: BoardArrowItem, matrix: BoardMatrix, getFrame: ArrowFrameLookup): ResolvedArrow {
	const { props } = item;
	if (isArrowBinding(props.start) && isArrowBinding(props.end) && props.start.item === props.end.item) {
		const frame = getFrame(props.start.item);
		if (frame) {
			const path = selfLoop(frame);
			const first = path[0] as WorldPoint;
			const last = path[path.length - 1] as WorldPoint;
			return { start: { point: first, normal: worldPoint(0, -1), item: props.start.item }, end: { point: last, normal: worldPoint(1, 0), item: props.end.item }, path, mid: path[2] as WorldPoint };
		}
	}
	const start = resolveEnd(props.start, props.end, matrix, getFrame);
	const end = resolveEnd(props.end, props.start, matrix, getFrame);
	let path: WorldPoint[];
	if (props.waypoints.length) path = [start.point, ...props.waypoints.map((point) => toWorld(matrix, point)), end.point];
	else if (props.route === "orthogonal") path = orthogonal(start, end);
	else if (props.route === "straight" && !props.bend) path = [start.point, end.point];
	else path = quadratic(start.point, curveControl(start, end, props.bend), end.point);
	return { start, end, path, mid: pathMidpoint(path) };
}

export function resolveSceneArrow(item: BoardArrowItem & { id: string }, scene: { layout: BoardLayout; get(id: string): { frame: BoardFrame } | undefined }): ResolvedArrow {
	const getFrame: ArrowFrameLookup = (id) => scene.get(id)?.frame;
	const matrix = scene.layout.matrix(item.id);
	const key = arrowKey(item, matrix, getFrame);
	const cached = resolvedCache.get(item);
	if (cached && cached.key === key) return cached.resolved;
	const resolved = resolveArrow(item, matrix, getFrame);
	resolvedCache.set(item, { key, resolved });
	return resolved;
}

const resolvedCache = new WeakMap<object, { key: string; resolved: ResolvedArrow }>();

function frameKey(frame: BoardFrame | undefined): string {
	return frame ? `${frame.x},${frame.y},${frame.width},${frame.height},${frame.rotation}` : "-";
}

function arrowKey(item: BoardArrowItem, matrix: BoardMatrix, getFrame: ArrowFrameLookup): string {
	const { start, end } = item.props;
	return `${matrix.join(",")}|${isArrowBinding(start) ? frameKey(getFrame(start.item)) : ""}|${isArrowBinding(end) ? frameKey(getFrame(end.item)) : ""}`;
}

export function pathMidpoint(path: readonly WorldPoint[]): WorldPoint {
	if (path.length === 0) return worldPoint(0, 0);
	if (path.length === 1) return path[0] as WorldPoint;
	let total = 0;
	for (let index = 0; index < path.length - 1; index += 1) {
		const from = path[index] as WorldPoint;
		const to = path[index + 1] as WorldPoint;
		total += Math.hypot(to.x - from.x, to.y - from.y);
	}
	let travelled = 0;
	const half = total / 2;
	for (let index = 0; index < path.length - 1; index += 1) {
		const from = path[index] as WorldPoint;
		const to = path[index + 1] as WorldPoint;
		const segment = Math.hypot(to.x - from.x, to.y - from.y);
		if (travelled + segment >= half) {
			const t = segment > 0 ? (half - travelled) / segment : 0;
			return worldPoint(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
		}
		travelled += segment;
	}
	return path[path.length - 1] as WorldPoint;
}

export function pathPointAt(path: readonly WorldPoint[], fraction: number): WorldPoint {
	if (path.length < 2) return path[0] ?? worldPoint(0, 0);
	const lengths: number[] = [];
	let total = 0;
	for (let index = 0; index < path.length - 1; index += 1) {
		const from = path[index] as WorldPoint;
		const to = path[index + 1] as WorldPoint;
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		lengths.push(length);
		total += length;
	}
	let remaining = Math.min(1, Math.max(0, fraction)) * total;
	for (let index = 0; index < lengths.length; index += 1) {
		const length = lengths[index] as number;
		if (remaining <= length) {
			const from = path[index] as WorldPoint;
			const to = path[index + 1] as WorldPoint;
			const t = length > 0 ? remaining / length : 0;
			return worldPoint(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
		}
		remaining -= length;
	}
	return path[path.length - 1] as WorldPoint;
}

export function arrowPathBounds(resolved: ResolvedArrow, strokeWidth = BOARD_ARROW_STROKE_SIZE): Rect {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of resolved.path) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	const pad = Math.max(8, strokeWidth * 2);
	return { x: minX - pad, y: minY - pad, width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2) };
}

function segmentDistance(p: WorldPoint, a: WorldPoint, b: WorldPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToArrow(resolved: ResolvedArrow, point: WorldPoint): number {
	let min = Number.POSITIVE_INFINITY;
	for (let index = 0; index < resolved.path.length - 1; index += 1) {
		const from = resolved.path[index];
		const to = resolved.path[index + 1];
		if (from && to) min = Math.min(min, segmentDistance(point, from, to));
	}
	return min;
}

export function arrowHitRadius(strokeWidth = BOARD_ARROW_STROKE_SIZE): number {
	return Math.max(8, strokeWidth * 2.5);
}
