import { BOARD_MAX_PITCH } from "@cohub/protocol/board-constants";
import { type BoardViewport, pointToWorld, type Rect, type ScreenPoint, screenPoint, unionRects, visibleWorldRect, type WorldPoint, worldPoint } from "./geometry.js";

/**
 * The Board's one camera, in board units with z up off the Board. Like a map, the eye looks at the
 * middle of the view from 1.5 view heights away (a 36.87° vertical field of view), so perspective
 * reads the same on every screen and zoom. `pitch` tips it from straight down toward the horizon
 * and `bearing` turns it clockwise, both about the middle of the view, which keeps its zoom: the
 * viewport's `x`, `y` and `zoom` mean what they mean for a level camera.
 */
export const BOARD_DEPTH_EYE_HEIGHTS = 1.5;
const NEAREST = 0.86;

export type BoardVec3 = readonly [number, number, number];
export type BoardViewSize = { width: number; height: number };
export type BoardView = BoardViewport & BoardViewSize;

export type BoardProjection = {
	readonly width: number;
	readonly height: number;
	readonly zoom: number;
	readonly pitch: number;
	readonly bearing: number;
	readonly center: WorldPoint;
	readonly distance: number;
	readonly focal: number;
	readonly eye: BoardVec3;
	readonly right: BoardVec3;
	readonly up: BoardVec3;
	readonly forward: BoardVec3;
	depth(x: number, y: number, z: number): number;
	project(x: number, y: number, z?: number): ScreenPoint;
	scale(x: number, y: number, z?: number): number;
	ray(screen: { x: number; y: number }): { origin: BoardVec3; direction: BoardVec3 };
	ground(screen: { x: number; y: number }): WorldPoint;
};

const DEG = Math.PI / 180;

export function boardViewPitch(camera: BoardViewport): number {
	const pitch = camera.pitch ?? 0;
	return Number.isFinite(pitch) ? Math.min(BOARD_MAX_PITCH, Math.max(0, pitch)) : 0;
}

export function boardViewBearing(camera: BoardViewport): number {
	const bearing = camera.bearing ?? 0;
	if (!Number.isFinite(bearing)) return 0;
	const turned = ((bearing % 360) + 540) % 360 - 180;
	return Math.abs(turned) < 1e-9 ? 0 : turned;
}

export function isBoardViewLevel(camera: BoardViewport): boolean {
	return boardViewPitch(camera) === 0 && boardViewBearing(camera) === 0;
}

export function isBoardViewPitched(camera: BoardViewport): boolean {
	return boardViewPitch(camera) > 0;
}

export function boardViewCenter(camera: BoardViewport, size: BoardViewSize): WorldPoint {
	return pointToWorld(screenPoint(size.width / 2, size.height / 2), camera);
}

export function boardProjection(camera: BoardViewport, size: BoardViewSize): BoardProjection {
	const width = Math.max(1, size.width);
	const height = Math.max(1, size.height);
	const zoom = Math.max(camera.zoom, 1e-9);
	const pitch = boardViewPitch(camera);
	const bearing = boardViewBearing(camera);
	const center = boardViewCenter(camera, { width, height });
	const focal = height * BOARD_DEPTH_EYE_HEIGHTS;
	const distance = focal / zoom;
	const [sp, cp] = [Math.sin(pitch * DEG), Math.cos(pitch * DEG)];
	const [sb, cb] = [Math.sin(bearing * DEG), Math.cos(bearing * DEG)];
	const ahead: BoardVec3 = [sb, -cb, 0];
	const right: BoardVec3 = [cb, sb, 0];
	const up: BoardVec3 = [ahead[0] * cp, ahead[1] * cp, sp];
	const forward: BoardVec3 = [ahead[0] * sp, ahead[1] * sp, -cp];
	const eye: BoardVec3 = [center.x - forward[0] * distance, center.y - forward[1] * distance, -forward[2] * distance];
	const nearest = distance * (1 - NEAREST);
	const ray = (screen: { x: number; y: number }) => {
		const sx = (screen.x - width / 2) / focal;
		const sy = (height / 2 - screen.y) / focal;
		const direction: BoardVec3 = [forward[0] + right[0] * sx + up[0] * sy, forward[1] + right[1] * sx + up[1] * sy, forward[2] + up[2] * sy];
		return { origin: eye, direction };
	};
	const depth = (x: number, y: number, z: number) =>
		Math.max((x - eye[0]) * forward[0] + (y - eye[1]) * forward[1] + (z - eye[2]) * forward[2], nearest);
	return {
		width,
		height,
		zoom,
		pitch,
		bearing,
		center,
		distance,
		focal,
		eye,
		right,
		up,
		forward,
		depth,
		project(x, y, z = 0) {
			const dx = x - eye[0];
			const dy = y - eye[1];
			const dz = z - eye[2];
			const k = focal / depth(x, y, z);
			return screenPoint(width / 2 + (dx * right[0] + dy * right[1]) * k, height / 2 - (dx * up[0] + dy * up[1] + dz * up[2]) * k);
		},
		scale(x, y, z = 0) {
			return focal / depth(x, y, z);
		},
		ray,
		ground(screen) {
			const { direction } = ray(screen);
			const t = eye[2] / Math.max(-direction[2], 1e-6);
			return worldPoint(eye[0] + direction[0] * t, eye[1] + direction[1] * t);
		},
	};
}

export function boardViewToWorld(camera: BoardViewport, size: BoardViewSize, screen: ScreenPoint): WorldPoint {
	return isBoardViewLevel(camera) ? pointToWorld(screen, camera) : boardProjection(camera, size).ground(screen);
}

export function boardViewRect(camera: BoardViewport, size: BoardViewSize): Rect {
	const flat = visibleWorldRect(camera, size.width, size.height);
	if (isBoardViewLevel(camera)) return flat;
	const projection = boardProjection(camera, size);
	const corners = [screenPoint(0, 0), screenPoint(size.width, 0), screenPoint(size.width, size.height), screenPoint(0, size.height)].map((corner) => projection.ground(corner));
	const xs = corners.map((point) => point.x);
	const ys = corners.map((point) => point.y);
	const seen = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
	return unionRects([seen, flat]) ?? flat;
}

export function placeBoardView(camera: BoardViewport, size: BoardViewSize, screen: ScreenPoint, world: { x: number; y: number }, zoom = camera.zoom): BoardViewport {
	const angles = boardViewAngles(camera);
	if (!angles) return { x: screen.x - world.x * zoom, y: screen.y - world.y * zoom, zoom };
	const at = { x: size.width / 2, y: size.height / 2, zoom, ...angles };
	const offset = boardProjection(at, size).ground(screen);
	const centerX = world.x - offset.x;
	const centerY = world.y - offset.y;
	return { ...at, x: size.width / 2 - centerX * zoom, y: size.height / 2 - centerY * zoom };
}

export function panBoardView(camera: BoardViewport, size: BoardViewSize, from: ScreenPoint, to: ScreenPoint): BoardViewport {
	if (isBoardViewLevel(camera)) return { ...camera, x: camera.x + to.x - from.x, y: camera.y + to.y - from.y };
	return placeBoardView(camera, size, to, boardViewToWorld(camera, size, from));
}

export function zoomBoardView(camera: BoardViewport, size: BoardViewSize, anchor: ScreenPoint, zoom: number): BoardViewport {
	return placeBoardView(camera, size, anchor, boardViewToWorld(camera, size, anchor), zoom);
}

export function boardViewAngles(camera: BoardViewport): { pitch?: number; bearing?: number } | null {
	const pitch = boardViewPitch(camera);
	const bearing = camera.bearing ?? 0;
	if (pitch === 0 && boardViewBearing(camera) === 0) return null;
	return { ...(pitch ? { pitch } : {}), ...(bearing ? { bearing } : {}) };
}

export function levelBoardView(camera: BoardViewport): BoardViewport {
	return { x: camera.x, y: camera.y, zoom: camera.zoom };
}

export function boardViewCssTransform(camera: BoardViewport, size: BoardViewSize): string {
	if (isBoardViewLevel(camera)) return `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;
	const { eye, right, up, forward, focal, width, height } = boardProjection(camera, size);
	const row = (k: (axis: 0 | 1 | 2) => number) => [k(0), k(1), k(2), -(k(0) * eye[0] + k(1) * eye[1] + k(2) * eye[2])];
	const x = row((axis) => (width / 2) * forward[axis] + focal * right[axis]);
	const y = row((axis) => (height / 2) * forward[axis] - focal * up[axis]);
	const w = row((axis) => forward[axis]);
	const scale = 1 / (w[3] as number) || 1;
	const columns = [0, 1, 2, 3].flatMap((column) => [x[column] as number, y[column] as number, column === 2 ? 1 : 0, w[column] as number].map((value) => value * scale));
	return `matrix3d(${columns.map((value) => +value.toPrecision(12)).join(",")})`;
}

export type BoardGroundBand = {
	readonly matrix: readonly [number, number, number, number, number, number];
	readonly width: number;
	readonly height: number;
	readonly corners: readonly [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
};

const BAND_RATIO = 1.5;
const MAX_BANDS = 4;

export function boardGroundBands(projection: BoardProjection, options: { density: number; maxPixels: number; maxEdge: number }): BoardGroundBand[] {
	const { width, height, center, right } = projection;
	const down: BoardVec3 = [-right[1], right[0], 0];
	const along = (y: number) => {
		const point = projection.ground({ x: width / 2, y });
		return (point.x - center.x) * down[0] + (point.y - center.y) * down[1];
	};
	const at = (t: number) => [center.x + down[0] * t, center.y + down[1] * t] as const;
	const across = (t: number) => {
		const [x, y] = at(t);
		return projection.scale(x, y, 0);
	};
	const lengthwise = (t: number) => {
		const step = projection.distance * 1e-4;
		const [x0, y0] = at(t);
		const [x1, y1] = at(t + step);
		return Math.abs(projection.project(x1, y1).y - projection.project(x0, y0).y) / step;
	};
	const far = along(0);
	const near = along(height);
	const ratio = Math.max(1, across(near) / across(far));
	const count = Math.min(MAX_BANDS, Math.max(1, Math.ceil(Math.log(ratio) / Math.log(BAND_RATIO) - 1e-9)));
	const edges = [far];
	for (let index = 1; index < count; index++) {
		const wanted = across(far) * ratio ** (index / count);
		let [lo, hi] = [far, near];
		for (let step = 0; step < 48; step++) {
			const mid = (lo + hi) / 2;
			if (across(mid) < wanted) lo = mid;
			else hi = mid;
		}
		edges.push((lo + hi) / 2);
	}
	edges.push(near);
	const plans = edges.slice(0, -1).map((t0, index) => {
		const t1 = edges[index + 1] as number;
		const su = across(t1) * options.density;
		const sv = lengthwise(t1) * options.density;
		const pad = 2 / Math.min(su, sv);
		const reach = (width / 2 / across(t0)) + pad;
		return { t0: index === 0 ? t0 - pad : t0, t1: index === count - 1 ? t1 + pad : t1, reach, su, sv };
	});
	const pixels = plans.reduce((sum, plan) => sum + plan.reach * 2 * plan.su * (plan.t1 - plan.t0) * plan.sv, 0);
	const shrink = Math.min(1, Math.sqrt(options.maxPixels / Math.max(pixels, 1)));
	return plans.map(({ t0, t1, reach, su: wideScale, sv: deepScale }) => {
		const su = Math.min(wideScale * shrink, options.maxEdge / (reach * 2));
		const sv = Math.min(deepScale * shrink, options.maxEdge / (t1 - t0));
		const bandWidth = Math.max(1, Math.ceil(reach * 2 * su));
		const bandHeight = Math.max(1, Math.ceil((t1 - t0) * sv));
		const ku = bandWidth / (reach * 2);
		const kv = bandHeight / (t1 - t0);
		const s0 = -reach;
		const corner = (s: number, t: number) => worldPoint(center.x + right[0] * s + down[0] * t, center.y + right[1] * s + down[1] * t);
		const originS = center.x * right[0] + center.y * right[1];
		const originT = center.x * down[0] + center.y * down[1];
		return {
			matrix: [ku * right[0], kv * down[0], ku * right[1], kv * down[1], -ku * (originS + s0), -kv * (originT + t0)] as const,
			width: bandWidth,
			height: bandHeight,
			corners: [corner(s0, t0), corner(-s0, t0), corner(-s0, t1), corner(s0, t1)] as const,
		};
	});
}
