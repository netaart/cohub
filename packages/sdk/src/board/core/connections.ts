/**
 * Connection geometry — pure resolution of a relation into a drawable path.
 *
 * A `BoardConnection` stores no coordinates: it names two nodes, how it attaches
 * to each, and how the line should travel. Everything spatial is derived here from
 * the live node frames, which is what makes a connection incapable of going stale.
 * No PixiJS, no DOM, no editor state — so the editor, the far-LOD batch, the
 * headless exporter and the tests all resolve a connection the same way.
 *
 * The `auto` anchor is the interesting part: rather than storing a side, it picks
 * one per resolve from the relative position of the two frames, so a connection
 * keeps its shortest sensible route through any layout change. A stored side is
 * honoured exactly, because a user who pinned one is stating intent that geometry
 * must not override.
 */

import {
	degToRad,
	frameRect,
	type Rect,
	rectCenter,
	rotatePointAround,
	type WorldPoint,
	worldPoint,
} from "../geometry.js";
import type {
	BoardConnection,
	BoardConnectionAnchor,
	BoardConnectionSide,
} from "@cohub/protocol/board-connection";
import type { BoardFrame } from "@cohub/protocol/board-document";

export type FrameLookup = (id: string) => BoardFrame | undefined;

/**
 * Gap between a node's edge and the line's endpoint, in world units.
 *
 * A connection that touches the border reads as part of the node; a small gap
 * makes the relation legible as its own object and keeps an arrowhead from being
 * swallowed by the card it points at.
 */
export const CONNECTION_ENDPOINT_GAP = 4;

/** Perpendicular fraction of the span used for an `orthogonal` elbow. */
const ORTHOGONAL_SNAP = 0.5;

export type ResolvedConnectionEndpoint = {
	point: WorldPoint;
	/** Outward normal at the attachment, used to aim arrowheads and elbows. */
	normal: WorldPoint;
	side: BoardConnectionSide;
};

export type ResolvedConnection = {
	source: ResolvedConnectionEndpoint;
	target: ResolvedConnectionEndpoint;
	/** Sampled world-space path, always at least two points. */
	path: WorldPoint[];
	/** Midpoint of the path, for labels and the drag handle. */
	mid: WorldPoint;
};

const SIDE_NORMALS: Record<BoardConnectionSide, { x: number; y: number }> = {
	top: { x: 0, y: -1 },
	right: { x: 1, y: 0 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
};

/** Normalized position of a point on a frame side, as (nx, ny). */
function sideAnchorPoint(side: BoardConnectionSide, offset: number): { nx: number; ny: number } {
	switch (side) {
		case "top":
			return { nx: offset, ny: 0 };
		case "bottom":
			return { nx: offset, ny: 1 };
		case "left":
			return { nx: 0, ny: offset };
		default:
			return { nx: 1, ny: offset };
	}
}

/** Denormalize a (nx, ny) anchor to a world point on a possibly rotated frame. */
export function anchorToWorld(frame: BoardFrame, nx: number, ny: number): WorldPoint {
	const unrotated = worldPoint(frame.x + nx * frame.width, frame.y + ny * frame.height);
	if (!frame.rotation) return unrotated;
	return rotatePointAround(unrotated, rectCenter(frameRect(frame)), degToRad(frame.rotation));
}

/** Normalize a world point into a (nx, ny) anchor on a frame, clamped to it. */
export function worldToAnchor(
	frame: BoardFrame,
	point: WorldPoint,
): { nx: number; ny: number } {
	const local = frame.rotation
		? rotatePointAround(point, rectCenter(frameRect(frame)), -degToRad(frame.rotation))
		: point;
	return {
		nx: clamp01((local.x - frame.x) / Math.max(frame.width, 0.0001)),
		ny: clamp01((local.y - frame.y) / Math.max(frame.height, 0.0001)),
	};
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Choose the side an `auto` anchor should use.
 *
 * The dominant axis of the center-to-center vector wins, weighted by the frame's
 * own proportions so a wide card prefers its long edges. Comparing raw dx/dy
 * instead would make a wide node attach to its short side for most angles, which
 * is the classic "line leaves from the corner" artifact.
 */
export function autoConnectionSide(from: BoardFrame, to: BoardFrame): BoardConnectionSide {
	const a = rectCenter(frameRect(from));
	const b = rectCenter(frameRect(to));
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	// Scale each axis by the half-extent it would have to cross, so the choice is
	// "which edge does the ray actually exit through" rather than "which delta is
	// numerically larger".
	const scaledX = Math.abs(dx) / Math.max(from.width / 2, 0.0001);
	const scaledY = Math.abs(dy) / Math.max(from.height / 2, 0.0001);
	if (scaledX >= scaledY) return dx >= 0 ? "right" : "left";
	return dy >= 0 ? "bottom" : "top";
}

/**
 * World point of an anchor on a frame, ignoring the gap and the facing node.
 *
 * For a live drag the other end is the pointer, not a node, so `auto` has no
 * frame to face: it resolves to the node's centre, which is the only honest
 * answer while the relation has nowhere to point yet.
 */
export function anchorPointOnFrame(
	anchor: BoardConnectionAnchor,
	frame: BoardFrame,
): WorldPoint {
	if (anchor.kind === "fixed") return anchorToWorld(frame, anchor.nx, anchor.ny);
	if (anchor.kind === "side") {
		const point = sideAnchorPoint(anchor.side, anchor.offset);
		return anchorToWorld(frame, point.nx, point.ny);
	}
	return anchorToWorld(frame, 0.5, 0.5);
}

/** Resolve one endpoint of a connection against its node frame. */
function resolveEndpoint(
	anchor: BoardConnectionAnchor,
	frame: BoardFrame,
	otherFrame: BoardFrame,
	gap: number,
): ResolvedConnectionEndpoint {
	let side: BoardConnectionSide;
	let nx: number;
	let ny: number;

	if (anchor.kind === "fixed") {
		nx = anchor.nx;
		ny = anchor.ny;
		// A fixed anchor still needs a normal for arrowheads, so derive the side it
		// sits closest to.
		side = nearestSide(nx, ny);
	} else if (anchor.kind === "side") {
		side = anchor.side;
		const point = sideAnchorPoint(side, anchor.offset);
		nx = point.nx;
		ny = point.ny;
	} else {
		side = autoConnectionSide(frame, otherFrame);
		const point = sideAnchorPoint(side, 0.5);
		nx = point.nx;
		ny = point.ny;
	}

	const base = anchorToWorld(frame, nx, ny);
	// The normal follows the frame's rotation, so a rotated node's connection still
	// leaves perpendicular to the edge it is attached to.
	const local = SIDE_NORMALS[side];
	const normal = frame.rotation
		? rotateVector(local, degToRad(frame.rotation))
		: worldPoint(local.x, local.y);
	return {
		point: worldPoint(base.x + normal.x * gap, base.y + normal.y * gap),
		normal,
		side,
	};
}

function rotateVector(vector: { x: number; y: number }, angleRad: number): WorldPoint {
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	return worldPoint(vector.x * cos - vector.y * sin, vector.x * sin + vector.y * cos);
}

function nearestSide(nx: number, ny: number): BoardConnectionSide {
	const distances: Array<[BoardConnectionSide, number]> = [
		["left", nx],
		["right", 1 - nx],
		["top", ny],
		["bottom", 1 - ny],
	];
	distances.sort((a, b) => a[1] - b[1]);
	return distances[0]?.[0] ?? "right";
}

/**
 * A self-loop's path: a lobe leaving and re-entering the same node.
 *
 * Handled separately because every straight/curve formula degenerates when both
 * endpoints coincide, and a self-relation is meaningful enough (a node that
 * depends on itself, a retry edge) that dropping it would lose real data.
 */
function selfLoopPath(frame: BoardFrame, gap: number): WorldPoint[] {
	const rect = frameRect(frame);
	const size = Math.max(Math.min(rect.width, rect.height) * 0.45, 24);
	const right = rect.x + rect.width + gap;
	const top = rect.y - gap;
	const midY = rect.y + rect.height * 0.3;
	const midX = rect.x + rect.width * 0.7;
	// A rounded rectangular lobe off the top-right corner, sampled as a polyline so
	// it shares the rest of the pipeline (hit testing, bounds, far LOD).
	return [
		worldPoint(midX, top),
		worldPoint(midX, top - size),
		worldPoint(right + size, top - size),
		worldPoint(right + size, midY),
		worldPoint(right, midY),
	];
}

function quadraticPoint(
	start: WorldPoint,
	control: WorldPoint,
	end: WorldPoint,
	t: number,
): WorldPoint {
	const mt = 1 - t;
	return worldPoint(
		mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
		mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
	);
}

/** Sample a quadratic curve into a polyline. */
function sampleQuadratic(
	start: WorldPoint,
	control: WorldPoint,
	end: WorldPoint,
	segments: number,
): WorldPoint[] {
	const out: WorldPoint[] = [];
	for (let index = 0; index <= segments; index += 1) {
		out.push(quadraticPoint(start, control, end, index / segments));
	}
	return out;
}

/**
 * Build an orthogonal elbow between two endpoints, leaving each along its normal.
 *
 * The turn happens on the axis each endpoint exits by, so the line never starts
 * parallel to the edge it is attached to (which would read as touching the node
 * rather than leaving it).
 */
function orthogonalPath(
	source: ResolvedConnectionEndpoint,
	target: ResolvedConnectionEndpoint,
): WorldPoint[] {
	const horizontalStart = Math.abs(source.normal.x) > Math.abs(source.normal.y);
	const horizontalEnd = Math.abs(target.normal.x) > Math.abs(target.normal.y);
	const a = source.point;
	const b = target.point;

	if (horizontalStart && horizontalEnd) {
		const midX = a.x + (b.x - a.x) * ORTHOGONAL_SNAP;
		return [a, worldPoint(midX, a.y), worldPoint(midX, b.y), b];
	}
	if (!horizontalStart && !horizontalEnd) {
		const midY = a.y + (b.y - a.y) * ORTHOGONAL_SNAP;
		return [a, worldPoint(a.x, midY), worldPoint(b.x, midY), b];
	}
	// Mixed orientation: one turn is enough, placed so both ends leave correctly.
	return horizontalStart
		? [a, worldPoint(b.x, a.y), b]
		: [a, worldPoint(a.x, b.y), b];
}

/** Curve samples per connection. Enough to read as smooth at typical zoom. */
const CURVE_SEGMENTS = 20;

/**
 * Resolve a connection into world-space geometry, or null if either node is gone.
 *
 * A null result means "not drawable right now", never "delete this": the caller
 * may be looking at a viewport-culled read where an endpoint simply was not
 * fetched.
 */
export function resolveConnection(
	connection: BoardConnection,
	getFrame: FrameLookup,
	options: { gap?: number } = {},
): ResolvedConnection | null {
	const sourceFrame = getFrame(connection.source.itemId);
	const targetFrame = getFrame(connection.target.itemId);
	if (!sourceFrame || !targetFrame) return null;
	const gap = options.gap ?? CONNECTION_ENDPOINT_GAP;

	if (connection.source.itemId === connection.target.itemId) {
		const path = selfLoopPath(sourceFrame, gap);
		const first = path[0] as WorldPoint;
		const last = path[path.length - 1] as WorldPoint;
		return {
			source: { point: first, normal: worldPoint(0, -1), side: "top" },
			target: { point: last, normal: worldPoint(1, 0), side: "right" },
			path,
			mid: path[Math.floor(path.length / 2)] ?? first,
		};
	}

	const source = resolveEndpoint(connection.source.anchor, sourceFrame, targetFrame, gap);
	const target = resolveEndpoint(connection.target.anchor, targetFrame, sourceFrame, gap);
	const waypoints = connection.routing.waypoints;

	let path: WorldPoint[];
	if (waypoints.length > 0) {
		// Hand-routed: the user's points are the path. They are honoured verbatim
		// rather than smoothed, because a dragged waypoint is a stated position.
		path = [
			source.point,
			...waypoints.map((point) => worldPoint(point.x, point.y)),
			target.point,
		];
	} else if (connection.routing.kind === "orthogonal") {
		path = orthogonalPath(source, target);
	} else if (connection.routing.kind === "straight" && !connection.routing.bend) {
		path = [source.point, target.point];
	} else {
		path = sampleQuadratic(
			source.point,
			curveControl(source, target, connection.routing.bend),
			target.point,
			CURVE_SEGMENTS,
		);
	}

	return {
		source,
		target,
		path,
		mid: pathMidpoint(path),
	};
}

/**
 * Control point for a curved connection.
 *
 * With no explicit bend the bow is derived from the endpoint normals, so the line
 * leaves each node perpendicular to its edge and reads as attached rather than
 * merely adjacent. An explicit bend is a user-set bow and takes over entirely.
 */
function curveControl(
	source: ResolvedConnectionEndpoint,
	target: ResolvedConnectionEndpoint,
	bend: number,
): WorldPoint {
	const mid = worldPoint(
		(source.point.x + target.point.x) / 2,
		(source.point.y + target.point.y) / 2,
	);
	const dx = target.point.x - source.point.x;
	const dy = target.point.y - source.point.y;
	const length = Math.hypot(dx, dy) || 1;

	if (bend) {
		const offset = bend * length;
		return worldPoint(mid.x + (-dy / length) * offset, mid.y + (dx / length) * offset);
	}

	// Default bow: push the control point out along the average of both normals,
	// scaled by distance so short and long connections curve proportionally.
	const nx = (source.normal.x + target.normal.x) / 2;
	const ny = (source.normal.y + target.normal.y) / 2;
	const magnitude = Math.hypot(nx, ny);
	if (magnitude < 0.0001) return mid;
	const strength = Math.min(length * 0.18, 96);
	return worldPoint(
		mid.x + (nx / magnitude) * strength,
		mid.y + (ny / magnitude) * strength,
	);
}

/** Midpoint by arc length, so a label sits visually centered on the line. */
export function pathMidpoint(path: WorldPoint[]): WorldPoint {
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

/** World bounds of a resolved connection, padded for its stroke. */
export function connectionBounds(resolved: ResolvedConnection, strokeSize: number): Rect {
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
	const pad = Math.max(8, strokeSize * 2);
	return {
		x: minX - pad,
		y: minY - pad,
		width: Math.max(1, maxX - minX + pad * 2),
		height: Math.max(1, maxY - minY + pad * 2),
	};
}

export type ConnectionGeometry = {
	connection: BoardConnection;
	resolved: ResolvedConnection;
	bounds: Rect;
};

/**
 * Resolved geometry reused until the connection or an endpoint frame changes
 * identity, so unchanged relations keep returning the same object.
 */
export type ConnectionGeometryCache = {
	get: (connection: BoardConnection, getFrame: FrameLookup) => ConnectionGeometry | null;
	peek: (connectionId: string) => ConnectionGeometry | null;
	retain: (connections: readonly BoardConnection[]) => void;
	clear: () => void;
};

export function createConnectionGeometryCache(): ConnectionGeometryCache {
	const entries = new Map<
		string,
		{ source: BoardFrame; target: BoardFrame; geometry: ConnectionGeometry }
	>();
	return {
		get(connection, getFrame) {
			const source = getFrame(connection.source.itemId);
			const target = getFrame(connection.target.itemId);
			if (!source || !target) {
				entries.delete(connection.id);
				return null;
			}
			const entry = entries.get(connection.id);
			if (
				entry &&
				entry.geometry.connection === connection &&
				entry.source === source &&
				entry.target === target
			)
				return entry.geometry;
			const resolved = resolveConnection(connection, getFrame);
			if (!resolved) {
				entries.delete(connection.id);
				return null;
			}
			const geometry = {
				connection,
				resolved,
				bounds: connectionBounds(resolved, connection.style.size),
			};
			entries.set(connection.id, { source, target, geometry });
			return geometry;
		},
		peek: (connectionId) => entries.get(connectionId)?.geometry ?? null,
		retain(connections) {
			if (entries.size === 0) return;
			const live = new Set(connections.map((connection) => connection.id));
			for (const id of entries.keys()) if (!live.has(id)) entries.delete(id);
		},
		clear: () => entries.clear(),
	};
}

/** Distance from a world point to a resolved connection's path. */
export function distanceToConnection(
	resolved: ResolvedConnection,
	point: WorldPoint,
): number {
	let min = Number.POSITIVE_INFINITY;
	for (let index = 0; index < resolved.path.length - 1; index += 1) {
		const from = resolved.path[index];
		const to = resolved.path[index + 1];
		if (!from || !to) continue;
		const distance = segmentDistance(point, from, to);
		if (distance < min) min = distance;
	}
	return min;
}

function segmentDistance(p: WorldPoint, a: WorldPoint, b: WorldPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Hit test a connection with a zoom-independent screen-space tolerance. */
export function connectionHitTest(
	resolved: ResolvedConnection,
	point: WorldPoint,
	strokeSize: number,
): boolean {
	return distanceToConnection(resolved, point) <= connectionHitRadius(strokeSize);
}

export function connectionHitRadius(strokeSize: number): number {
	return Math.max(8, strokeSize * 2.5);
}

/** Whether the connection draws an arrowhead at its source / target. */
export function connectionArrowheads(connection: BoardConnection): {
	atSource: boolean;
	atTarget: boolean;
} {
	switch (connection.direction) {
		case "forward":
			return { atSource: false, atTarget: true };
		case "backward":
			return { atSource: true, atTarget: false };
		case "both":
			return { atSource: true, atTarget: true };
		default:
			return { atSource: false, atTarget: false };
	}
}

/**
 * Index of connections by the nodes they touch.
 *
 * Built once per document revision and consulted per gesture frame: moving a node
 * must cost its own degree, not a scan of every connection on the board. Without
 * this, dragging one node in a densely connected board is O(connections) per
 * frame, which is exactly the cost that shows up as drag lag.
 */
export type ConnectionIndex = {
	/** Connection ids touching a node (either endpoint). */
	byNode: (nodeId: string) => readonly string[];
	get: (connectionId: string) => BoardConnection | undefined;
	readonly all: readonly BoardConnection[];
};

const NO_CONNECTIONS: readonly string[] = [];

export function createConnectionIndex(
	connections: readonly BoardConnection[],
): ConnectionIndex {
	const byNode = new Map<string, string[]>();
	const byId = new Map<string, BoardConnection>();
	for (const connection of connections) {
		byId.set(connection.id, connection);
		for (const nodeId of new Set([connection.source.itemId, connection.target.itemId])) {
			const list = byNode.get(nodeId);
			if (list) list.push(connection.id);
			else byNode.set(nodeId, [connection.id]);
		}
	}
	return {
		byNode: (nodeId) => byNode.get(nodeId) ?? NO_CONNECTIONS,
		get: (connectionId) => byId.get(connectionId),
		all: connections,
	};
}
