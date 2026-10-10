
import type { WorldPoint } from "./geometry.js";
import { type BoardDrawPoint as DrawPoint, drawPointsBounds, drawSampleRadius } from "@cohub/protocol";
import { getStroke } from "perfect-freehand";

export const sampleRadius = drawSampleRadius;

export const computeDrawBounds = drawPointsBounds;

export function simplifyDrawIndices(
	points: DrawPoint[],
	tolerance: number,
): number[] {
	const n = points.length;
	if (n <= 2 || tolerance <= 0) return points.map((_, i) => i);
	const keep = new Array<boolean>(n).fill(false);
	keep[0] = true;
	keep[n - 1] = true;
	const stack: Array<[number, number]> = [[0, n - 1]];
	while (stack.length > 0) {
		const segment = stack.pop();
		if (!segment) break;
		const [start, end] = segment;
		let maxDist = -1;
		let index = -1;
		const a = points[start];
		const b = points[end];
		if (!a || !b) continue;
		for (let i = start + 1; i < end; i += 1) {
			const point = points[i];
			if (!point) continue;
			const d = perpendicularDistance(point, a, b);
			if (d > maxDist) {
				maxDist = d;
				index = i;
			}
		}
		if (maxDist > tolerance && index !== -1) {
			keep[index] = true;
			stack.push([start, index], [index, end]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i += 1) if (keep[i]) out.push(i);
	return out;
}

function perpendicularDistance(
	point: DrawPoint,
	a: DrawPoint,
	b: DrawPoint,
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
	const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
	const projX = a.x + t * dx;
	const projY = a.y + t * dy;
	return Math.hypot(point.x - projX, point.y - projY);
}

export function trimDrawPoints(
	points: readonly DrawPoint[],
	trim: number | undefined,
): readonly DrawPoint[] {
	if (trim === undefined || trim >= 1) return points;
	if (trim <= 0) return [];
	if (points.length < 2) return points;
	let total = 0;
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1] as DrawPoint;
		const b = points[i] as DrawPoint;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	let remaining = total * trim;
	const out: DrawPoint[] = [points[0] as DrawPoint];
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1] as DrawPoint;
		const b = points[i] as DrawPoint;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length >= remaining) {
			const t = length > 0 ? remaining / length : 0;
			out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
			return out;
		}
		out.push(b);
		remaining -= length;
	}
	return out;
}

export function buildStrokeOutline(
	points: DrawPoint[],
	size: number,
): Array<{ x: number; y: number }> {
	const n = points.length;
	if (n === 0) return [];
	const first = points[0];
	if (!first) return [];
	if (n === 1) {
		const r = sampleRadius(size, first.p);
		const p = first;
		const k = r * Math.SQRT1_2;
		return [
			{ x: p.x, y: p.y - r },
			{ x: p.x + k, y: p.y - k },
			{ x: p.x + r, y: p.y },
			{ x: p.x + k, y: p.y + k },
			{ x: p.x, y: p.y + r },
			{ x: p.x - k, y: p.y + k },
			{ x: p.x - r, y: p.y },
			{ x: p.x - k, y: p.y - k },
		];
	}
	return getStroke(
		points.map((point) => [point.x, point.y, point.p]),
		{
			size: Math.max(1, size),
			thinning: 0.5,
			smoothing: 0.5,
			streamline: 0,
			simulatePressure: false,
			last: true,
			start: { cap: true },
			end: { cap: true },
		},
	).map(([x, y]) => ({ x, y }));
}

const RIBBON_CIRCLE_SIDES = 8;

export function isStrokeCorner(
	points: readonly DrawPoint[],
	index: number,
): boolean {
	if (index === 0 || index === points.length - 1) return true;
	const before = points[index - 1];
	const point = points[index];
	const after = points[index + 1];
	if (!before || !point || !after) return false;
	const ax = point.x - before.x;
	const ay = point.y - before.y;
	const bx = after.x - point.x;
	const by = after.y - point.y;
	const aLength = Math.hypot(ax, ay);
	const bLength = Math.hypot(bx, by);
	if (aLength < 1e-6 || bLength < 1e-6) return true;
	return (ax * bx + ay * by) / (aLength * bLength) < 0.92;
}

export type StrokeRibbonGeometry = {
	positions: Float32Array;
	indices: Uint32Array;
	uvs: Float32Array;
	progress: Float32Array;
};

export type StrokeRibbonMesh = {
	positions: Float32Array;
	indices: Uint32Array;
	distances: Float32Array;
	length: number;
};

export type StrokeRibbonBuilder = {
	build(points: readonly DrawPoint[]): StrokeRibbonMesh;
};

const SAMPLE_VERTICES = RIBBON_CIRCLE_SIDES + 1 + 4;
const SAMPLE_TRIANGLES = RIBBON_CIRCLE_SIDES + 2;

function segmentNormal(points: readonly DrawPoint[], index: number): { x: number; y: number } | null {
	const from = points[index];
	const to = points[index + 1];
	if (!from || !to) return null;
	const length = Math.hypot(to.x - from.x, to.y - from.y);
	return length < 1e-6 ? null : { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
}

function edgeOffset(points: readonly DrawPoint[], index: number, own: { x: number; y: number }) {
	if (isStrokeCorner(points, index)) return own;
	const before = segmentNormal(points, index - 1);
	const after = segmentNormal(points, index);
	if (!before || !after) return own;
	const x = before.x + after.x;
	const y = before.y + after.y;
	const length = Math.hypot(x, y);
	if (length < 1e-6) return own;
	const scale = 1 / Math.max(0.5, (x * own.x + y * own.y) / length);
	return { x: (x / length) * scale, y: (y / length) * scale };
}

/** A growing stroke re-emits only its last two samples. */
export function createStrokeRibbonBuilder(size: number): StrokeRibbonBuilder {
	let positions = new Float32Array(SAMPLE_VERTICES * 64 * 2);
	let distances = new Float32Array(SAMPLE_VERTICES * 64);
	let indices = new Uint32Array(SAMPLE_TRIANGLES * 64 * 3);
	let lengths = new Float64Array(64);
	let marks = new Uint32Array(128);
	let source: readonly DrawPoint[] | null = null;
	let built = 0;
	let vertexCount = 0;
	let indexCount = 0;

	function grow<T extends Float32Array | Float64Array | Uint32Array>(buffer: T, needed: number): T {
		if (buffer.length >= needed) return buffer;
		const next = new (buffer.constructor as new (length: number) => T)(Math.max(needed, buffer.length * 2));
		next.set(buffer);
		return next;
	}

	function vertex(x: number, y: number, at: number) {
		positions[vertexCount * 2] = x;
		positions[vertexCount * 2 + 1] = y;
		distances[vertexCount] = at;
		return vertexCount++;
	}

	function triangle(a: number, b: number, c: number) {
		indices[indexCount++] = a;
		indices[indexCount++] = b;
		indices[indexCount++] = c;
	}

	function emit(points: readonly DrawPoint[], index: number) {
		positions = grow(positions, (vertexCount + SAMPLE_VERTICES) * 2);
		distances = grow(distances, vertexCount + SAMPLE_VERTICES);
		indices = grow(indices, indexCount + SAMPLE_TRIANGLES * 3);
		const point = points[index] as DrawPoint;
		const at = lengths[index] ?? 0;
		const radius = sampleRadius(size, point.p);
		if (isStrokeCorner(points, index)) {
			const center = vertex(point.x, point.y, at);
			for (let side = 0; side < RIBBON_CIRCLE_SIDES; side += 1) {
				const angle = (side / RIBBON_CIRCLE_SIDES) * Math.PI * 2;
				vertex(point.x + Math.cos(angle) * radius, point.y + Math.sin(angle) * radius, at);
			}
			for (let side = 0; side < RIBBON_CIRCLE_SIDES; side += 1) {
				triangle(center, center + 1 + side, center + 1 + ((side + 1) % RIBBON_CIRCLE_SIDES));
			}
		}
		const next = points[index + 1];
		const normal = segmentNormal(points, index);
		if (!next || !normal) return;
		const start = edgeOffset(points, index, normal);
		const end = edgeOffset(points, index + 1, normal);
		const nextAt = lengths[index + 1] ?? at;
		const nextRadius = sampleRadius(size, next.p);
		const leftA = vertex(point.x + start.x * radius, point.y + start.y * radius, at);
		const rightA = vertex(point.x - start.x * radius, point.y - start.y * radius, at);
		const leftB = vertex(next.x + end.x * nextRadius, next.y + end.y * nextRadius, nextAt);
		const rightB = vertex(next.x - end.x * nextRadius, next.y - end.y * nextRadius, nextAt);
		triangle(leftA, rightA, leftB);
		triangle(rightA, rightB, leftB);
	}

	return {
		build(points) {
			const count = points.length;
			const from = points === source && count >= built ? Math.max(0, built - 2) : 0;
			source = points;
			built = count;
			lengths = grow(lengths, count);
			marks = grow(marks, count * 2);
			vertexCount = from > 0 ? (marks[from * 2] as number) : 0;
			indexCount = from > 0 ? (marks[from * 2 + 1] as number) : 0;
			for (let index = from; index < count; index += 1) {
				const before = points[index - 1];
				const point = points[index] as DrawPoint;
				lengths[index] = before ? (lengths[index - 1] as number) + Math.hypot(point.x - before.x, point.y - before.y) : 0;
			}
			for (let index = from; index < count; index += 1) {
				marks[index * 2] = vertexCount;
				marks[index * 2 + 1] = indexCount;
				emit(points, index);
			}
			return {
				positions: positions.subarray(0, vertexCount * 2),
				indices: indices.subarray(0, indexCount),
				distances: distances.subarray(0, vertexCount),
				length: count ? (lengths[count - 1] as number) : 0,
			};
		},
	};
}

export function buildStrokeRibbonGeometry(
	points: readonly DrawPoint[],
	size: number,
): StrokeRibbonGeometry {
	const mesh = createStrokeRibbonBuilder(size).build(points);
	const total = Math.max(mesh.length, 1e-6);
	const progress = mesh.distances.map((at) => at / total);
	const uvs = new Float32Array(progress.length * 2);
	for (let index = 0; index < progress.length; index += 1) uvs[index * 2] = progress[index] as number;
	return { positions: mesh.positions.slice(), indices: mesh.indices.slice(), uvs, progress };
}

export function distanceToStroke(
	points: DrawPoint[],
	local: WorldPoint,
): number {
	if (points.length === 0) return Number.POSITIVE_INFINITY;
	const first = points[0];
	if (!first) return Number.POSITIVE_INFINITY;
	if (points.length === 1) return Math.hypot(local.x - first.x, local.y - first.y);
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < points.length - 1; i += 1) {
		const from = points[i];
		const to = points[i + 1];
		if (!from || !to) continue;
		const d = perpendicularDistance({ x: local.x, y: local.y, p: 0 }, from, to);
		if (d < min) min = d;
	}
	return min;
}
