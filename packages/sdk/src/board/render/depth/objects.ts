import { Container3D, DirectionalLight, Mesh3D, type Model3D, type View3D } from "@pixi/3d";
import { type BoardDepth, type BoardFrame, type BoardModelView, type BoardVec2, framePoint } from "@cohub/protocol";
import { boardDepthHeight, boardDepthTurn } from "../../model/depth.js";
import type { BoardModelPlayback } from "../../model/model-clips.js";
import type { BoardProjection, BoardVec3 } from "../../model/view-camera.js";
import type { LoadedModel } from "../model3d/load.js";
import { createModelPlayback, type ModelPlayback } from "../model3d/playback.js";
import { MODEL_VIEW_PRESETS } from "../model3d/view.js";
import { apply, axisRotation, fromScene, type Mat3, multiply, quaternion, toScene, transpose, type Vec3 } from "./math.js";

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

export type BoardDepthObjectPlacement = {
	readonly size: BoardDepthObjectSize;
	readonly hull: readonly BoardVec3[];
};

export type BoardDepthObjects = {
	readonly empty: boolean;
	sync(projection: BoardProjection, objects: readonly BoardDepthObject[], now: number): { placements: ReadonlyMap<string, BoardDepthObjectPlacement>; moving: boolean };
	node(id: string, name: string): BoardVec3 | null;
	destroy(): void;
};

const DEG = Math.PI / 180;

function upright(yaw: number): Mat3 {
	const [s, c] = [Math.sin(yaw * DEG), Math.cos(yaw * DEG)];
	return [
		[c, 0, -s],
		[s, 0, c],
		[0, 1, 0],
	];
}

function lean(view: BoardModelView, tip: number, axis: readonly number[]): Mat3 {
	return multiply(axisRotation(axis, tip * DEG), upright(view.yaw));
}

export function createBoardDepthObjects(view3d: View3D, light: readonly [number, number, number]): BoardDepthObjects {
	type Entry = { holder: Container3D; model: LoadedModel; playback: ModelPlayback | null; min: Vec3; max: Vec3; nodes: Map<string, (() => Vec3) | null> };
	const holders = new Map<string, Entry>();
	let sun: DirectionalLight | null = null;
	let current: BoardProjection | null = null;

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

	function entryFor(object: BoardDepthObject): Entry {
		let entry = holders.get(object.id);
		if (entry) return entry;
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
			nodes: new Map(),
		};
		holders.set(object.id, entry);
		return entry;
	}

	function extents(rotation: Mat3, min: Vec3, max: Vec3, center: Vec3): { lo: Vec3; hi: Vec3 } {
		const lo: Vec3 = [Infinity, Infinity, Infinity];
		const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
		for (let corner = 0; corner < 8; corner++) {
			const point = apply(rotation, [(corner & 1 ? max[0] : min[0]) - center[0], (corner & 2 ? max[1] : min[1]) - center[1], (corner & 4 ? max[2] : min[2]) - center[2]]);
			for (let axis = 0; axis < 3; axis++) {
				lo[axis] = Math.min(lo[axis] as number, point[axis] as number);
				hi[axis] = Math.max(hi[axis] as number, point[axis] as number);
			}
		}
		return { lo, hi };
	}

	return {
		get empty() {
			return holders.size === 0;
		},
		sync(projection, objects, now) {
			current = projection;
			const wanted = new Map(objects.map((object) => [object.id, object.model]));
			for (const [id, entry] of [...holders]) if (wanted.get(id) !== entry.model) release(id);
			const placements = new Map<string, BoardDepthObjectPlacement>();
			let moving = false;
			if (objects.length) lights();
			for (const object of objects) {
				const entry = entryFor(object);
				const { frame, origin, depth } = object;
				const { min, max } = entry;
				const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
				const view = object.view ?? MODEL_VIEW_PRESETS.home;
				const resting = extents(lean(view, 90 - view.pitch, [1, 0, 0]), min, max, center);
				const fit = Math.min(frame.width / Math.max(resting.hi[0] - resting.lo[0], 1e-6), frame.height / Math.max(resting.hi[1] - resting.lo[1], 1e-6)) * (view.zoom ?? 1);
				const size = { width: fit * (resting.hi[0] - resting.lo[0]), height: fit * (resting.hi[1] - resting.lo[1]), thickness: fit * (resting.hi[2] - resting.lo[2]) };
				const turn = boardDepthTurn(depth, frame.rotation);
				const basis: Mat3 = transpose([turn(1, 0, 0), turn(0, 1, 0), turn(0, 0, 1)]);
				const axis = apply(transpose(basis), projection.right);
				const tip = Math.max(0, 90 - view.pitch - projection.pitch);
				const rotation = lean(view, tip, axis);
				const { lo, hi } = extents(rotation, min, max, center);
				const offset: Vec3 = [
					(0.5 - origin.x) * frame.width - (fit * (lo[0] + hi[0])) / 2,
					(0.5 - origin.y) * frame.height - (fit * (lo[1] + hi[1])) / 2,
					-fit * lo[2],
				];
				const anchor = framePoint(frame, origin.x, origin.y);
				const height = boardDepthHeight(depth.lift, projection);
				const place = (local: readonly number[]): Vec3 => {
					const turned = apply(basis, local);
					return [anchor.x + turned[0], anchor.y + turned[1], height + turned[2]];
				};
				const whole = multiply(basis, rotation);
				const hull: BoardVec3[] = [];
				for (let corner = 0; corner < 8; corner++) {
					const point = apply(rotation, [(corner & 1 ? max[0] : min[0]) - center[0], (corner & 2 ? max[1] : min[1]) - center[1], (corner & 4 ? max[2] : min[2]) - center[2]]);
					hull.push(place([point[0] * fit + offset[0], point[1] * fit + offset[1], point[2] * fit + offset[2]]));
				}
				placements.set(object.id, { size, hull });
				const scene: Mat3 = [whole[0], [-whole[1][0], -whole[1][1], -whole[1][2]], whole[2]];
				const [qx, qy, qz, qw] = quaternion(scene);
				const base = place(offset);
				const shift = apply(scene, center).map((value) => value * fit);
				const [x, y, z] = toScene(projection, base[0], base[1], base[2]);
				entry.holder.quaternion.set(qx, qy, qz, qw);
				entry.holder.scale.set(fit, fit, fit);
				entry.holder.position.set(x - (shift[0] as number), y - (shift[1] as number), z - (shift[2] as number));
				if (entry.playback?.pose(object.playback, now)) moving = true;
			}
			return { placements, moving };
		},
		node(id, name) {
			const entry = holders.get(id);
			if (!entry || !current) return null;
			let node = entry.nodes.get(name);
			if (node === undefined) {
				node = findNode(entry.model.root, name);
				entry.nodes.set(name, node);
			}
			const at = node?.();
			return at ? fromScene(current, at[0], at[1], at[2]) : null;
		},
		destroy() {
			for (const id of [...holders.keys()]) release(id);
			sun?.destroy();
			sun = null;
		},
	};
}



function findNode(root: Container3D, name: string): (() => Vec3) | null {
	const built = root.getChildByLabel(name, true);
	if (built) return () => {
		const at = built.getGlobalPosition();
		return [at.x, at.y, at.z];
	};
	for (const skeleton of (root as Model3D).skeletons ?? []) {
		const joint = skeleton.joints.indexOf(skeleton.indexOf(name));
		if (joint < 0) continue;
		let mesh: Mesh3D | null = null;
		root.traverse((node) => {
			if (!mesh && node instanceof Mesh3D && node.skeleton === skeleton) mesh = node;
		});
		const skin = mesh as Mesh3D | null;
		if (!skin) continue;
		const m = skeleton.inverseBindMatrices.subarray(joint * 16, joint * 16 + 16);
		const bound = solve([[m[0] as number, m[4] as number, m[8] as number], [m[1] as number, m[5] as number, m[9] as number], [m[2] as number, m[6] as number, m[10] as number]], [-(m[12] as number), -(m[13] as number), -(m[14] as number)]);
		return () => {
			skeleton.updateWorld();
			const w = skeleton.worldMatrix.subarray(joint * 12, joint * 12 + 12);
			const local = [0, 1, 2].map((row) => (w[row * 4] as number) * bound[0] + (w[row * 4 + 1] as number) * bound[1] + (w[row * 4 + 2] as number) * bound[2] + (w[row * 4 + 3] as number));
			const e = skin.getGlobalTransform().elements;
			return [0, 1, 2].map((row) => (e[row] as number) * (local[0] as number) + (e[row + 4] as number) * (local[1] as number) + (e[row + 8] as number) * (local[2] as number) + (e[row + 12] as number)) as Vec3;
		};
	}
	return null;
}

function solve(m: Mat3, b: Vec3): Vec3 {
	const [[a, b1, c], [d, e, f], [g, h, i]] = m;
	const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g) || 1;
	const inverse: Mat3 = [
		[(e * i - f * h) / det, (c * h - b1 * i) / det, (b1 * f - c * e) / det],
		[(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
		[(d * h - e * g) / det, (b1 * g - a * h) / det, (a * e - b1 * d) / det],
	];
	return apply(inverse, b);
}
