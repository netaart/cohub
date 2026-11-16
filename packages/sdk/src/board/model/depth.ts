import { type BoardDepth, type BoardFrame, type BoardItem, type BoardVec2, framePoint, isBoardDepthActive, resolveBoardDepth } from "@cohub/protocol";
import { isBoardModelItem } from "./media.js";
import type { BoardScene, BoardSceneItem } from "./scene.js";

/**
 * Board depth follows a map's camera: the eye looks straight down at the middle of the view from
 * 1.5 view heights away (a 36.87° vertical field of view), so perspective feels the same on every
 * screen and at every zoom, while heights grow with zoom like the rest of the Board.
 */
export const BOARD_DEPTH_EYE_HEIGHTS = 1.5;
const NEAREST = 0.86;
const HEIGHT_SOFTNESS = 0.62;

export type BoardDepthView = { x: number; y: number; zoom: number; width: number; height: number };

export type BoardDepthEye = { x: number; y: number; distance: number };

export function boardDepthEye(view: BoardDepthView): BoardDepthEye {
	return { x: view.width / 2, y: view.height / 2, distance: Math.max(1, view.height) * BOARD_DEPTH_EYE_HEIGHTS };
}

export function projectBoardDepth(eye: BoardDepthEye, x: number, y: number, z: number): BoardVec2 {
	const scale = eye.distance / Math.max(eye.distance - z, eye.distance * (1 - NEAREST));
	return { x: eye.x + (x - eye.x) * scale, y: eye.y + (y - eye.y) * scale };
}

const RESTING = resolveBoardDepth({}) as BoardDepth;

export function isBoardModelObject(item: BoardItem | null | undefined): boolean {
	return item?.type === "file" && item.props.model?.display === "object" && isBoardModelItem(item);
}

export function boardDepthOf(item: BoardItem): BoardDepth | null {
	const depth = resolveBoardDepth(item.depth);
	if (isBoardDepthActive(depth)) return depth;
	return isBoardModelObject(item) ? (depth ?? RESTING) : null;
}

export function isBoardDepthLifted(scene: Pick<BoardScene, "get">, id: string): boolean {
	const root = boardDepthRootOf(scene, id);
	const item = root ? scene.get(root) : undefined;
	return isBoardDepthActive(resolveBoardDepth(item?.depth));
}

export function boardDepthRoots(scene: Pick<BoardScene, "items" | "get">): BoardSceneItem[] {
	const roots: BoardSceneItem[] = [];
	for (const item of scene.items) if (boardDepthOf(item) && boardDepthRootOf(scene, item.id) === item.id) roots.push(item);
	return roots;
}

export function boardDepthRootOf(scene: Pick<BoardScene, "get">, id: string): string | null {
	let root: string | null = null;
	let cursor: string | undefined = id;
	for (let guard = 0; cursor && guard < 64; guard++) {
		const item = scene.get(cursor);
		if (!item) break;
		if (boardDepthOf(item)) root = cursor;
		cursor = item.parent;
	}
	return root;
}

export function boardDepthSegments(depth: BoardDepth): number {
	if (depth.bend.kind === "none" || depth.bend.amount === 0) return 1;
	return depth.bend.kind === "wave" ? 32 : 40;
}

export type BoardDepthSurface = {
	readonly segments: number;
	readonly positions: Float32Array;
	readonly flat: Float32Array;
	readonly tones: Float32Array;
	readonly basis: readonly [readonly number[], readonly number[], readonly number[]];
	readonly scale: number;
	readonly eye: BoardDepthEye;
	readonly frame: BoardFrame;
};

export type BoardDepthPlacement = { frame: BoardFrame; origin: BoardVec2; depth: BoardDepth };

const LIGHT = normalize([-0.42, -0.55, 0.72]);

function normalize([x, y, z]: readonly number[]): [number, number, number] {
	const length = Math.hypot(x as number, y as number, z as number) || 1;
	return [(x as number) / length, (y as number) / length, (z as number) / length];
}

function softHeight(height: number, distance: number): number {
	const limit = distance * HEIGHT_SOFTNESS;
	return height > 0 ? limit * Math.tanh(height / limit) : Math.max(height, -distance * 4);
}

export function bendBoardDepth(out: Float32Array, segments: number, width: number, height: number, origin: BoardVec2, depth: BoardDepth) {
	const side = segments + 1;
	const { kind, amount, phase } = depth.bend;
	const bends = kind !== "none" && kind !== "custom" && amount !== 0;
	const reach = Math.max(width, height) / 2;
	const turn = Math.min(Math.max(amount, 0), 1);
	const curlRadius = Math.max(width * 0.08 * (1 - 0.5 * turn), 1);
	const curlSkew = width * 0.16 * Math.sin(Math.PI * turn);
	for (let row = 0, i = 0; row < side; row++) {
		const v = row / segments;
		for (let col = 0; col < side; col++, i += 3) {
			const u = col / segments;
			let x = u * width;
			let y = v * height;
			let z = 0;
			if (bends && kind === "wave") {
				const swing = u * amount * width * 0.09;
				z = swing * Math.sin(u * Math.PI * 2.4 - phase + v * 0.8);
				y += swing * 0.25 * Math.sin(u * Math.PI * 3 - phase * 1.3);
				x -= u * Math.abs(amount) * width * 0.03;
			} else if (bends && kind === "cloth") {
				const nx = (x - origin.x * width) / reach;
				const ny = (y - origin.y * height) / reach;
				const r = Math.hypot(nx, ny);
				const angle = Math.atan2(ny, nx);
				const drape = amount * reach * 0.35 * r * r;
				const flutter = amount * reach * (0.2 * r * r * Math.sin(angle * 4 - r * 3 + phase) + 0.06 * r * Math.sin(angle * 7 + phase * 1.7));
				const pull = 1 - 0.16 * amount * r * r;
				x = origin.x * width + nx * reach * pull;
				y = origin.y * height + ny * reach * pull;
				z = flutter - drape;
			} else if (bends && kind === "curl") {
				const edge = width * (1 - turn) + (v - 0.5) * curlSkew;
				if (x > edge) {
					const arc = (x - edge) / curlRadius;
					if (arc < Math.PI) {
						z = curlRadius * (1 - Math.cos(arc));
						x = edge + curlRadius * Math.sin(arc);
					} else {
						z = curlRadius * 2;
						x = edge - (x - edge - Math.PI * curlRadius);
					}
				}
			}
			out[i] = x - origin.x * width;
			out[i + 1] = y - origin.y * height;
			out[i + 2] = z;
		}
	}
}

export function boardDepthSurface(placement: BoardDepthPlacement, view: BoardDepthView, previous?: BoardDepthSurface | null): BoardDepthSurface {
	const { frame, origin, depth } = placement;
	const segments = boardDepthSegments(depth);
	const count = (segments + 1) ** 2;
	const reuse = previous && previous.segments === segments;
	const positions = reuse ? (previous.positions as Float32Array) : new Float32Array(count * 3);
	const flat = reuse ? (previous.flat as Float32Array) : new Float32Array(count * 3);
	const tones = reuse ? (previous.tones as Float32Array) : new Float32Array(count);
	const eye = boardDepthEye(view);
	const zoom = view.zoom;
	const deg = Math.PI / 180;
	const [cs, ss] = [Math.cos(depth.spin * deg), Math.sin(depth.spin * deg)];
	const [cx, sx] = [Math.cos(depth.tilt.x * deg), Math.sin(depth.tilt.x * deg)];
	const [cy, sy] = [Math.cos(depth.tilt.y * deg), Math.sin(depth.tilt.y * deg)];
	const [cr, sr] = [Math.cos(frame.rotation * deg), Math.sin(frame.rotation * deg)];
	const transform = (x: number, y: number, z: number): [number, number, number] => {
		const x1 = x * cs - y * ss;
		const y1 = x * ss + y * cs;
		const y2 = y1 * cx - z * sx;
		const z2 = y1 * sx + z * cx;
		const x3 = x1 * cy + z2 * sy;
		const z3 = -x1 * sy + z2 * cy;
		return [x3 * cr - y2 * sr, x3 * sr + y2 * cr, z3];
	};
	const basis = [transform(zoom, 0, 0), transform(0, zoom, 0), transform(0, 0, zoom)] as const;
	const pivot = framePoint(frame, origin.x, origin.y);
	const px = pivot.x * zoom + view.x;
	const py = pivot.y * zoom + view.y;
	const lift = softHeight(depth.lift * zoom, eye.distance);
	const ceiling = eye.distance * NEAREST;

	const local = new Float32Array(count * 3);
	bendBoardDepth(local, segments, frame.width, frame.height, origin, depth);
	const place = (target: Float32Array, source: Float32Array, i: number) => {
		const [x, y, z] = transform(source[i] as number, source[i + 1] as number, source[i + 2] as number);
		target[i] = px + x * zoom;
		target[i + 1] = py + y * zoom;
		target[i + 2] = Math.min(lift + z * zoom, ceiling);
	};
	for (let i = 0; i < local.length; i += 3) place(positions, local, i);
	if (depth.bend.kind === "custom") {
		const side = segments + 1;
		for (let row = 0, i = 0; row < side; row++)
			for (let col = 0; col < side; col++, i += 3) {
				local[i] = (col / segments - origin.x) * frame.width;
				local[i + 1] = (row / segments - origin.y) * frame.height;
				local[i + 2] = 0;
			}
		for (let i = 0; i < local.length; i += 3) place(flat, local, i);
	} else flat.set(positions);
	shade(positions, tones, segments, eye, depth.shade);
	return { segments, positions, flat, tones, basis, scale: eye.distance / Math.max(eye.distance - lift, eye.distance * (1 - NEAREST)), eye, frame };
}

function shade(positions: Float32Array, tones: Float32Array, segments: number, eye: BoardDepthEye, strength: number) {
	const side = segments + 1;
	const at = (col: number, row: number, axis: number) =>
		positions[(Math.min(Math.max(row, 0), segments) * side + Math.min(Math.max(col, 0), segments)) * 3 + axis] as number;
	for (let row = 0, v = 0; row < side; row++) {
		for (let col = 0; col < side; col++, v++) {
			const ax = at(col + 1, row, 0) - at(col - 1, row, 0);
			const ay = at(col + 1, row, 1) - at(col - 1, row, 1);
			const az = at(col + 1, row, 2) - at(col - 1, row, 2);
			const bx = at(col, row + 1, 0) - at(col, row - 1, 0);
			const by = at(col, row + 1, 1) - at(col, row - 1, 1);
			const bz = at(col, row + 1, 2) - at(col, row - 1, 2);
			let n = normalize([ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]);
			const index = v * 3;
			const toEye = [eye.x - (positions[index] as number), eye.y - (positions[index + 1] as number), eye.distance - (positions[index + 2] as number)];
			if (n[0] * (toEye[0] as number) + n[1] * (toEye[1] as number) + n[2] * (toEye[2] as number) < 0) n = [-n[0], -n[1], -n[2]];
			const light = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
			tones[v] = Math.min(1.2, Math.max(0.35, 1 + strength * 1.1 * (light - LIGHT[2])));
		}
	}
}

export function boardDepthPoint(surface: BoardDepthSurface, u: number, v: number): [number, number, number] {
	const { segments, positions } = surface;
	const fu = Math.min(Math.max(u, 0), 1) * segments;
	const fv = Math.min(Math.max(v, 0), 1) * segments;
	const col = Math.min(Math.floor(fu), segments - 1);
	const row = Math.min(Math.floor(fv), segments - 1);
	const tu = fu - col;
	const tv = fv - row;
	const side = segments + 1;
	const corner = (c: number, r: number, axis: number) => positions[(r * side + c) * 3 + axis] as number;
	const mix = (axis: number) =>
		(corner(col, row, axis) * (1 - tu) + corner(col + 1, row, axis) * tu) * (1 - tv) +
		(corner(col, row + 1, axis) * (1 - tu) + corner(col + 1, row + 1, axis) * tu) * tv;
	return [mix(0), mix(1), mix(2)];
}

export function boardDepthScreenPoint(surface: BoardDepthSurface, u: number, v: number): BoardVec2 {
	const [x, y, z] = boardDepthPoint(surface, u, v);
	return projectBoardDepth(surface.eye, x, y, z);
}

export type BoardDepthHit = { u: number; v: number; distance: number; back: boolean };

const screenBounds = new WeakMap<BoardDepthSurface, { x0: number; y0: number; x1: number; y1: number }>();

function boundsOnScreen(surface: BoardDepthSurface) {
	let bounds = screenBounds.get(surface);
	if (!bounds) {
		bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
		const { positions, eye } = surface;
		for (let i = 0; i < positions.length; i += 3) {
			const point = projectBoardDepth(eye, positions[i] as number, positions[i + 1] as number, positions[i + 2] as number);
			bounds.x0 = Math.min(bounds.x0, point.x);
			bounds.y0 = Math.min(bounds.y0, point.y);
			bounds.x1 = Math.max(bounds.x1, point.x);
			bounds.y1 = Math.max(bounds.y1, point.y);
		}
		screenBounds.set(surface, bounds);
	}
	return bounds;
}

export function hitBoardDepthSurface(surface: BoardDepthSurface, screen: BoardVec2): BoardDepthHit | null {
	const bounds = boundsOnScreen(surface);
	if (screen.x < bounds.x0 || screen.x > bounds.x1 || screen.y < bounds.y0 || screen.y > bounds.y1) return null;
	const { segments, eye, positions: p } = surface;
	const side = segments + 1;
	const [ox, oy, oz] = [eye.x, eye.y, eye.distance];
	const [rx, ry, rz] = [screen.x - eye.x, screen.y - eye.y, -eye.distance];
	let best: BoardDepthHit | null = null;
	const triangle = (a: number, b: number, c: number, u0: number, v0: number, u1: number, v1: number, u2: number, v2: number) => {
		const ax = p[a * 3] as number, ay = p[a * 3 + 1] as number, az = p[a * 3 + 2] as number;
		const e1x = (p[b * 3] as number) - ax, e1y = (p[b * 3 + 1] as number) - ay, e1z = (p[b * 3 + 2] as number) - az;
		const e2x = (p[c * 3] as number) - ax, e2y = (p[c * 3 + 1] as number) - ay, e2z = (p[c * 3 + 2] as number) - az;
		const hx = ry * e2z - rz * e2y, hy = rz * e2x - rx * e2z, hz = rx * e2y - ry * e2x;
		const det = e1x * hx + e1y * hy + e1z * hz;
		if (Math.abs(det) < 1e-9) return;
		const inv = 1 / det;
		const sx = ox - ax, sy = oy - ay, sz = oz - az;
		const b1 = inv * (sx * hx + sy * hy + sz * hz);
		if (b1 < -1e-6 || b1 > 1 + 1e-6) return;
		const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
		const b2 = inv * (rx * qx + ry * qy + rz * qz);
		if (b2 < -1e-6 || b1 + b2 > 1 + 1e-6) return;
		const t = inv * (e2x * qx + e2y * qy + e2z * qz);
		if (t <= 0 || (best && t >= best.distance)) return;
		const b0 = 1 - b1 - b2;
		best = { u: b0 * u0 + b1 * u1 + b2 * u2, v: b0 * v0 + b1 * v1 + b2 * v2, distance: t, back: det < 0 };
	};
	for (let row = 0; row < segments; row++) {
		const v0 = row / segments;
		const v1 = (row + 1) / segments;
		for (let col = 0; col < segments; col++) {
			const a = row * side + col;
			const u0 = col / segments;
			const u1 = (col + 1) / segments;
			triangle(a, a + 1, a + side, u0, v0, u1, v0, u0, v1);
			triangle(a + 1, a + side + 1, a + side, u1, v0, u1, v1, u0, v1);
		}
	}
	return best;
}

export function boardDepthOutline(surface: BoardDepthSurface, box = { x: 0, y: 0, width: 1, height: 1 }): BoardVec2[] {
	const steps = surface.segments > 1 ? 12 : 1;
	const points: BoardVec2[] = [];
	const edge = (u0: number, v0: number, u1: number, v1: number) => {
		for (let step = 0; step < steps; step++) {
			const t = step / steps;
			points.push(boardDepthScreenPoint(surface, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t));
		}
	};
	const { x, y, width, height } = box;
	edge(x, y, x + width, y);
	edge(x + width, y, x + width, y + height);
	edge(x + width, y + height, x, y + height);
	edge(x, y + height, x, y);
	return points;
}

export function boardDepthFraction(frame: BoardFrame, point: BoardVec2): BoardVec2 {
	const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
	const angle = (-frame.rotation * Math.PI) / 180;
	const dx = point.x - center.x;
	const dy = point.y - center.y;
	const x = dx * Math.cos(angle) - dy * Math.sin(angle);
	const y = dx * Math.sin(angle) + dy * Math.cos(angle);
	return { x: x / Math.max(frame.width, 1e-6) + 0.5, y: y / Math.max(frame.height, 1e-6) + 0.5 };
}

export function boardDepthFlatPoint(frame: BoardFrame, u: number, v: number): BoardVec2 {
	return framePoint(frame, u, v);
}

export type BoardDepthShadow = { corners: [BoardVec2, BoardVec2, BoardVec2, BoardVec2]; height: number; blur: number; alpha: number };

export function boardDepthShadow(surface: BoardDepthSurface, view: BoardDepthView, strength: number): BoardDepthShadow | null {
	if (strength <= 0) return null;
	const zoom = Math.max(view.zoom, 1e-6);
	let height = 0;
	const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([u, v]) => {
		const [x, y, z] = boardDepthPoint(surface, u, v);
		const above = Math.max(z, 0);
		height = Math.max(height, above);
		return { x: (x + above * 0.18 - view.x) / zoom, y: (y + above * 0.32 - view.y) / zoom };
	}) as [BoardVec2, BoardVec2, BoardVec2, BoardVec2];
	let mean = 0;
	for (let i = 2; i < surface.positions.length; i += 3) mean += Math.max(surface.positions[i] as number, 0);
	mean /= surface.positions.length / 3;
	if (height < 0.5) return null;
	const rise = Math.min(1, mean / 24);
	const fade = 1 - Math.min(0.55, mean / surface.eye.distance);
	return { corners, height: mean / zoom, blur: (6 + mean * 0.35) / zoom, alpha: strength * 0.32 * rise * fade };
}

export function boardDocumentUsesDepth(document: { items: Readonly<Record<string, { depth?: unknown; props?: unknown }>>; animations: Readonly<Record<string, { tracks: Readonly<Record<string, { property: string }>> }>> }): boolean {
	for (const item of Object.values(document.items)) {
		if (item.depth) return true;
		const model = (item.props as { model?: { display?: string } } | undefined)?.model;
		if (model?.display === "object") return true;
	}
	for (const animation of Object.values(document.animations))
		for (const track of Object.values(animation.tracks)) if (track.property.startsWith("depth.") || track.property === "depth") return true;
	return false;
}

export function boardDepthItemOutline(scene: Pick<BoardScene, "get">, id: string, view: BoardDepthView): BoardVec2[] | null {
	const root = boardDepthRootOf(scene, id);
	const item = scene.get(id);
	const rootItem = root ? scene.get(root) : undefined;
	const depth = rootItem && boardDepthOf(rootItem);
	if (!item || !rootItem || !depth) return null;
	const surface = boardDepthSurface({ frame: rootItem.frame, origin: rootItem.origin, depth }, view);
	const zoom = Math.max(view.zoom, 1e-6);
	const toWorld = (point: BoardVec2) => ({ x: (point.x - view.x) / zoom, y: (point.y - view.y) / zoom });
	if (id === root) return boardDepthOutline(surface).map(toWorld);
	const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([u, v]) => boardDepthFraction(rootItem.frame, framePoint(item.frame, u, v)));
	const steps = surface.segments > 1 ? 10 : 1;
	const outline: BoardVec2[] = [];
	corners.forEach((a, edge) => {
		const b = corners[(edge + 1) % 4] as BoardVec2;
		for (let step = 0; step < steps; step++) {
			const t = step / steps;
			outline.push(toWorld(boardDepthScreenPoint(surface, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)));
		}
	});
	return outline;
}

export function boardDepthContactShadow(frame: BoardFrame, depth: BoardDepth, size: { width: number; height: number; thickness: number }): BoardDepthShadow | null {
	if (depth.shadow <= 0) return null;
	const rise = Math.max(depth.lift, 0) + size.thickness * 0.3;
	const u = Math.min(0.5, (size.width / Math.max(frame.width, 1e-6)) * 0.42);
	const v = Math.min(0.5, (size.height / Math.max(frame.height, 1e-6)) * 0.42);
	const corners = ([[0.5 - u, 0.5 - v * 0.6], [0.5 + u, 0.5 - v * 0.6], [0.5 + u, 0.5 + v], [0.5 - u, 0.5 + v]] as const).map(([x, y]) => {
		const point = framePoint(frame, x, y);
		return { x: point.x + rise * 0.1, y: point.y + rise * 0.16 };
	}) as [BoardVec2, BoardVec2, BoardVec2, BoardVec2];
	const lifted = Math.max(depth.lift, 0) / Math.max(size.thickness, 1);
	return { corners, height: rise, blur: Math.min(size.width, size.height) * 0.22 + rise * 0.2, alpha: depth.shadow * 0.3 * Math.max(0.25, 1 - lifted * 0.5) };
}
