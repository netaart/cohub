import { Container3D, DirectionalLight, type View3D } from "@pixi/3d";
import type { BoardDepth, BoardFrame, BoardModelView, BoardVec2 } from "@cohub/protocol";
import { type BoardDepthView, boardDepthPoint, boardDepthSurface } from "../../model/depth.js";
import type { BoardModelPlayback } from "../../model/model-clips.js";
import type { LoadedModel } from "../model3d/load.js";
import { createModelPlayback, type ModelPlayback } from "../model3d/playback.js";
import { MODEL_VIEW_PRESETS } from "../model3d/view.js";

export type BoardDepthObject = {
	id: string;
	model: LoadedModel;
	frame: BoardFrame;
	origin: BoardVec2;
	depth: BoardDepth;
	view: BoardModelView | undefined;
	playback: BoardModelPlayback;
};

export type BoardDepthObjectSize = { width: number; height: number; thickness: number };

export type BoardDepthObjects = {
	readonly empty: boolean;
	sync(view: BoardDepthView, objects: readonly BoardDepthObject[], now: number): { sizes: ReadonlyMap<string, BoardDepthObjectSize>; moving: boolean };
	destroy(): void;
};

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const DEG = Math.PI / 180;

function normalize([x, y, z]: Vec3): Vec3 {
	const length = Math.hypot(x, y, z) || 1;
	return [x / length, y / length, z / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function coverRotation(view: BoardModelView): Mat3 {
	const yaw = view.yaw * DEG;
	const pitch = Math.max(-89.9, Math.min(89.9, view.pitch)) * DEG;
	const toward = normalize([Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)]);
	const right = normalize(cross([0, 1, 0], toward));
	const up = cross(toward, right);
	return [right, [-up[0], -up[1], -up[2]], toward];
}

function apply(m: Mat3, v: Vec3): Vec3 {
	return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
}

function quaternion(m: Mat3): [number, number, number, number] {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const trace = a + e + i;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return [(h - f) * s, (c - g) * s, (d - b) * s, 0.25 / s];
	}
	if (a > e && a > i) {
		const s = 2 * Math.sqrt(1 + a - e - i);
		return [0.25 * s, (b + d) / s, (c + g) / s, (h - f) / s];
	}
	if (e > i) {
		const s = 2 * Math.sqrt(1 + e - a - i);
		return [(b + d) / s, 0.25 * s, (f + h) / s, (c - g) / s];
	}
	const s = 2 * Math.sqrt(1 + i - a - e);
	return [(c + g) / s, (f + h) / s, 0.25 * s, (d - b) / s];
}

export function createBoardDepthObjects(view3d: View3D, light: readonly [number, number, number]): BoardDepthObjects {
	const holders = new Map<string, { holder: Container3D; model: LoadedModel; playback: ModelPlayback | null; min: Vec3; max: Vec3 }>();
	let sun: DirectionalLight | null = null;

	function lights() {
		if (sun) return;
		sun = new DirectionalLight({ intensity: 1.5, color: 0xfff8f0 });
		sun.position.set(light[0] * 1000, light[1] * 1000, light[2] * 1000);
		sun.lookAt({ x: 0, y: 0, z: 0 });
		view3d.root.addChild(sun);
	}

	function release(id: string) {
		const entry = holders.get(id);
		if (!entry) return;
		holders.delete(id);
		entry.holder.removeChild(entry.model.root);
		entry.holder.removeFromParent();
		entry.holder.destroy();
	}

	return {
		get empty() {
			return holders.size === 0;
		},
		sync(view, objects, now) {
			const wanted = new Map(objects.map((object) => [object.id, object.model]));
			for (const [id, entry] of [...holders]) if (wanted.get(id) !== entry.model) release(id);
			const sizes = new Map<string, BoardDepthObjectSize>();
			let moving = false;
			if (objects.length) lights();
			for (const object of objects) {
				let entry = holders.get(object.id);
				if (!entry) {
					const holder = new Container3D();
					holder.addChild(object.model.root);
					view3d.root.addChild(holder);
					const bounds = object.model.root.getLocalBounds();
					const empty = bounds.isEmpty();
					entry = {
						holder,
						model: object.model,
						playback: object.model.player ? createModelPlayback(object.model.player) : null,
						min: empty ? [-0.5, -0.5, -0.5] : [bounds.min.x, bounds.min.y, bounds.min.z],
						max: empty ? [0.5, 0.5, 0.5] : [bounds.max.x, bounds.max.y, bounds.max.z],
					};
					holders.set(object.id, entry);
				}
				const { frame, origin, depth } = object;
				const { min, max } = entry;
				const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
				const cover = coverRotation(object.view ?? MODEL_VIEW_PRESETS.home);
				const lo: Vec3 = [Infinity, Infinity, Infinity];
				const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
				for (let corner = 0; corner < 8; corner++) {
					const point = apply(cover, [(corner & 1 ? max[0] : min[0]) - center[0], (corner & 2 ? max[1] : min[1]) - center[1], (corner & 4 ? max[2] : min[2]) - center[2]]);
					for (let axis = 0; axis < 3; axis++) {
						lo[axis] = Math.min(lo[axis] as number, point[axis] as number);
						hi[axis] = Math.max(hi[axis] as number, point[axis] as number);
					}
				}
				const fit = Math.min(frame.width / Math.max(hi[0] - lo[0], 1e-6), frame.height / Math.max(hi[1] - lo[1], 1e-6)) * (object.view?.zoom ?? 1);
				sizes.set(object.id, { width: fit * (hi[0] - lo[0]), height: fit * (hi[1] - lo[1]), thickness: fit * (hi[2] - lo[2]) });
				const surface = boardDepthSurface({ frame, origin, depth: { ...depth, bend: { ...depth.bend, kind: "none" } } }, view);
				const [bx, by, bz] = surface.basis;
				const pivot = boardDepthPoint(surface, origin.x, origin.y);
				const local: Vec3 = [(0.5 - origin.x) * frame.width, (0.5 - origin.y) * frame.height, -fit * lo[2]];
				const screen = (v: Vec3): Vec3 => [
					(bx[0] as number) * v[0] + (by[0] as number) * v[1] + (bz[0] as number) * v[2],
					(bx[1] as number) * v[0] + (by[1] as number) * v[1] + (bz[1] as number) * v[2],
					(bx[2] as number) * v[0] + (by[2] as number) * v[1] + (bz[2] as number) * v[2],
				];
				const columns = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map((axis) => {
					const [x, y, z] = screen(apply(cover, axis));
					return [x * fit, -y * fit, z * fit] as Vec3;
				});
				const scale = Math.hypot(...(columns[0] as Vec3)) || 1;
				const rows: Mat3 = [0, 1, 2].map((r) => columns.map((column) => (column[r] as number) / scale)) as Mat3;
				const offset = screen(local);
				const origin3: Vec3 = [pivot[0] + offset[0], -(pivot[1] + offset[1]), pivot[2] + offset[2]];
				const shift = apply(rows, center).map((value) => value * scale);
				const [qx, qy, qz, qw] = quaternion(rows);
				entry.holder.quaternion.set(qx, qy, qz, qw);
				entry.holder.scale.set(scale, scale, scale);
				entry.holder.position.set(origin3[0] - (shift[0] as number), origin3[1] - (shift[1] as number), origin3[2] - (shift[2] as number));
				if (entry.playback?.pose(object.playback, now)) moving = true;
			}
			return { sizes, moving };
		},
		destroy() {
			for (const id of [...holders.keys()]) release(id);
			sun?.destroy();
			sun = null;
		},
	};
}
