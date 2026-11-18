import { type BaseMaterial3D, Container3D, DirectionalLight, FlatMaterial, Geometry3D, Mesh3D, type Model3D, type View3D } from "@pixi/3d";
import { type BoardDepth, type BoardFrame, type BoardModelView, type BoardVec2, framePoint } from "@cohub/protocol";
import { BufferImageSource, Texture } from "pixi.js";
import { boardDepthHeight, boardDepthTurn } from "../../model/depth.js";
import type { BoardModelPlayback } from "../../model/model-clips.js";
import type { BoardProjection, BoardVec3 } from "../../model/view-camera.js";
import { MODEL_LIGHTING } from "../model3d/lighting.js";
import type { LoadedModel } from "../model3d/load.js";
import { createModelPlayback, type ModelPlayback } from "../model3d/playback.js";
import { MODEL_VIEW_PRESETS } from "../model3d/view.js";
import { BOARD_DEPTH_GHOST } from "./ghosts.js";
import { apply, axisRotation, fromScene, type Mat3, multiply, quaternion, toScene, transpose, type Vec3 } from "./math.js";

export type BoardDepthObject = {
	id: string;
	model: LoadedModel | null;
	cover: Texture | null;
	shimmer: boolean;
	frame: BoardFrame;
	origin: BoardVec2;
	depth: BoardDepth;
	view: BoardModelView | undefined;
	playback: BoardModelPlayback;
	opacity: number;
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

const FADE_MS = 200;
const DEG = Math.PI / 180;
const SHIMMER_MS = 1_600;
const COLUMNS = 16;

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

type Body = { holder: Container3D; min: Vec3; max: Vec3 };
type Faded = { parts: Array<{ mesh: Mesh3D; material: BaseMaterial3D }>; copies: Map<BaseMaterial3D, BaseMaterial3D> };
type Solid = Body & { model: LoadedModel; playback: ModelPlayback | null; nodes: Map<string, (() => Vec3) | null>; since: number | null; faded: Faded | null };
type Ghost = Body & { mesh: Mesh3D; material: FlatMaterial; cover: Texture | null; shimmer: boolean };
type Entry = { solid: Solid | null; ghost: Ghost | null };

function place(body: Body, object: BoardDepthObject, view: BoardModelView, projection: BoardProjection): BoardDepthObjectPlacement {
	const { frame, origin, depth } = object;
	const { min, max } = body;
	const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
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
	const at = (local: readonly number[]): Vec3 => {
		const turned = apply(basis, local);
		return [anchor.x + turned[0], anchor.y + turned[1], height + turned[2]];
	};
	const whole = multiply(basis, rotation);
	const hull: BoardVec3[] = [];
	for (let corner = 0; corner < 8; corner++) {
		const point = apply(rotation, [(corner & 1 ? max[0] : min[0]) - center[0], (corner & 2 ? max[1] : min[1]) - center[1], (corner & 4 ? max[2] : min[2]) - center[2]]);
		hull.push(at([point[0] * fit + offset[0], point[1] * fit + offset[1], point[2] * fit + offset[2]]));
	}
	const scene: Mat3 = [whole[0], [-whole[1][0], -whole[1][1], -whole[1][2]], whole[2]];
	const [qx, qy, qz, qw] = quaternion(scene);
	const base = at(offset);
	const shift = apply(scene, center).map((value) => value * fit);
	const [x, y, z] = toScene(projection, base[0], base[1], base[2]);
	body.holder.quaternion.set(qx, qy, qz, qw);
	body.holder.scale.set(fit, fit, fit);
	body.holder.position.set(x - (shift[0] as number), y - (shift[1] as number), z - (shift[2] as number));
	return { size, hull };
}

function fade(solid: Solid, alpha: number) {
	if (alpha >= 1) {
		if (!solid.faded) return;
		for (const { mesh, material } of solid.faded.parts) mesh.material = material;
		for (const copy of solid.faded.copies.values()) copy.destroy();
		solid.faded = null;
		return;
	}
	if (!solid.faded) {
		const faded: Faded = { parts: [], copies: new Map() };
		solid.model.root.traverse((node) => {
			if (!(node instanceof Mesh3D)) return;
			const material = node.material;
			let copy = faded.copies.get(material);
			if (!copy) {
				copy = material.clone({ alphaMode: "blend" });
				copy.state.depthMask = true;
				faded.copies.set(material, copy);
			}
			faded.parts.push({ mesh: node, material });
			node.material = copy;
		});
		solid.faded = faded;
	}
	for (const [material, copy] of solid.faded.copies) copy.alpha = material.alpha * alpha;
}

function unitPlane(): Geometry3D {
	const side = COLUMNS + 1;
	const positions = new Float32Array(side * 2 * 3);
	const uvs = new Float32Array(side * 2 * 2);
	const indices = new Uint16Array(COLUMNS * 6);
	for (let row = 0, v = 0; row < 2; row++)
		for (let col = 0; col < side; col++, v++) {
			positions.set([col / COLUMNS - 0.5, 0.5 - row, 0], v * 3);
			uvs.set([col / COLUMNS, row], v * 2);
		}
	for (let col = 0; col < COLUMNS; col++) indices.set([col, col + side, col + 1, col + 1, col + side, col + side + 1], col * 6);
	return new Geometry3D({ positions, colors: new Float32Array(side * 2 * 4).fill(1), uvs, indices, dynamic: true });
}

function silhouette(): Texture {
	const size = 64;
	const radius = 14;
	const soft = 4;
	const data = new Uint8Array(size * size * 4);
	const half = size / 2 - 1 - radius;
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const qx = Math.abs(x + 0.5 - size / 2) - half;
			const qy = Math.abs(y + 0.5 - size / 2) - half;
			const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
			const alpha = Math.round(255 * Math.min(Math.max(-outside / soft, 0), 1));
			data.fill(alpha, (y * size + x) * 4, (y * size + x) * 4 + 4);
		}
	return new Texture({ source: new BufferImageSource({ resource: data, width: size, height: size, alphaMode: "premultiplied-alpha" }) });
}

export function createBoardDepthObjects(view3d: View3D, light: readonly [number, number, number]): BoardDepthObjects {
	const entries = new Map<string, Entry>();
	let sun: DirectionalLight | null = null;
	let current: BoardProjection | null = null;
	let plain: Geometry3D | null = null;
	let shimmering: Geometry3D | null = null;
	let blank: Texture | null = null;
	let swept = -1;

	function lights() {
		if (sun) return;
		sun = new DirectionalLight({ intensity: MODEL_LIGHTING.object.light, color: 0xfff8f0 });
		sun.position.set(light[0] * 1000, light[1] * 1000, light[2] * 1000);
		sun.lookAt({ x: 0, y: 0, z: 0 });
		view3d.root.addChild(sun);
	}

	function holder(child: Container3D): Container3D {
		const holder = new Container3D();
		holder.addChild(child);
		view3d.root.addChild(holder);
		return holder;
	}

	function releaseSolid(entry: Entry) {
		const solid = entry.solid;
		if (!solid) return;
		entry.solid = null;
		fade(solid, 1);
		solid.holder.removeChild(solid.model.root);
		solid.holder.removeFromParent();
		solid.holder.destroy();
	}

	function releaseGhost(entry: Entry) {
		const ghost = entry.ghost;
		if (!ghost) return;
		entry.ghost = null;
		ghost.holder.removeFromParent();
		ghost.holder.destroy({ children: true });
		ghost.material.destroy();
	}

	function release(id: string) {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		releaseSolid(entry);
		releaseGhost(entry);
	}

	function solidOf(model: LoadedModel, since: number | null): Solid {
		const bounds = model.root.getLocalBounds();
		const empty = bounds.isEmpty();
		return {
			holder: holder(model.root),
			model,
			playback: model.player ? createModelPlayback(model.player) : null,
			min: empty ? [-0.5, -0.5, -0.5] : [bounds.min.x, bounds.min.y, bounds.min.z],
			max: empty ? [0.5, 0.5, 0.5] : [bounds.max.x, bounds.max.y, bounds.max.z],
			nodes: new Map(),
			since,
			faded: null,
		};
	}

	function blankTexture(): Texture {
		blank ??= silhouette();
		return blank;
	}

	function plane(shimmer: boolean): Geometry3D {
		if (shimmer) {
			shimmering ??= unitPlane();
			return shimmering;
		}
		plain ??= unitPlane();
		return plain;
	}

	function ghostOf(entry: Entry, object: BoardDepthObject): Ghost {
		const shimmer = object.shimmer && !object.cover;
		if (entry.ghost && entry.ghost.cover !== object.cover) releaseGhost(entry);
		let ghost = entry.ghost;
		if (!ghost) {
			const material = new FlatMaterial({
				baseColorTexture: object.cover ?? blankTexture(),
				baseColor: object.cover ? 0xffffff : BOARD_DEPTH_GHOST.tint,
				vertexColors: true,
				alphaMode: "blend",
				doubleSided: true,
				fog: false,
			});
			const mesh = new Mesh3D({ geometry: plane(shimmer), material, castShadow: false, receiveShadow: false });
			ghost = { holder: holder(mesh), mesh, material, cover: object.cover, shimmer, min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] };
			entry.ghost = ghost;
		} else if (ghost.shimmer !== shimmer) {
			ghost.shimmer = shimmer;
			ghost.mesh.geometry = plane(shimmer);
		}
		const aspect = object.cover ? object.cover.width / Math.max(object.cover.height, 1) : object.frame.width / Math.max(object.frame.height, 1e-6);
		ghost.mesh.scale.set(aspect, 1, 1);
		ghost.min[0] = -aspect / 2;
		ghost.max[0] = aspect / 2;
		return ghost;
	}

	function sweep(now: number) {
		const colors = shimmering?.attributes.aColor?.buffer;
		const phase = Math.floor(now / 33);
		if (!colors || phase === swept) return;
		swept = phase;
		const data = colors.data as Float32Array;
		const at = ((now % SHIMMER_MS) / SHIMMER_MS) * 1.8 - 0.4;
		for (let v = 0; v < data.length / 4; v++) {
			const u = (v % (COLUMNS + 1)) / COLUMNS;
			const tone = 0.82 + 0.3 * Math.exp(-(((u - at) / 0.18) ** 2));
			data[v * 4] = data[v * 4 + 1] = data[v * 4 + 2] = tone;
		}
		colors.update();
	}

	return {
		get empty() {
			return entries.size === 0;
		},
		sync(projection, objects, now) {
			current = projection;
			const wanted = new Set(objects.map((object) => object.id));
			for (const id of [...entries.keys()]) if (!wanted.has(id)) release(id);
			const placements = new Map<string, BoardDepthObjectPlacement>();
			let moving = false;
			if (objects.length) lights();
			for (const object of objects) {
				let entry = entries.get(object.id);
				if (!entry) {
					entry = { solid: null, ghost: null };
					entries.set(object.id, entry);
				}
				if (entry.solid && entry.solid.model !== object.model) releaseSolid(entry);
				if (object.model && !entry.solid) entry.solid = solidOf(object.model, entry.ghost ? now : null);
				const solid = entry.solid;
				const shown = !solid ? 0 : solid.since === null ? 1 : Math.min(1, Math.max(0, (now - solid.since) / FADE_MS));
				let placement: BoardDepthObjectPlacement | null = null;
				if (solid) {
					placement = place(solid, object, object.view ?? MODEL_VIEW_PRESETS.home, projection);
					fade(solid, object.opacity * shown);
					if (solid.playback?.pose(object.playback, now)) moving = true;
				}
				if (shown < 1) {
					const ghost = ghostOf(entry, object);
					const placed = place(ghost, object, MODEL_VIEW_PRESETS.front, projection);
					placement ??= placed;
					ghost.material.alpha = object.opacity * (1 - shown) * (object.cover ? 1 : BOARD_DEPTH_GHOST.alpha);
					if (ghost.shimmer) {
						sweep(now);
						moving = true;
					}
					if (solid) moving = true;
				} else releaseGhost(entry);
				placements.set(object.id, placement as BoardDepthObjectPlacement);
			}
			return { placements, moving };
		},
		node(id, name) {
			const solid = entries.get(id)?.solid;
			if (!solid || !current) return null;
			let node = solid.nodes.get(name);
			if (node === undefined) {
				node = findNode(solid.model.root, name);
				solid.nodes.set(name, node);
			}
			const at = node?.();
			return at ? fromScene(current, at[0], at[1], at[2]) : null;
		},
		destroy() {
			for (const id of [...entries.keys()]) release(id);
			sun?.destroy();
			sun = null;
			plain?.destroy(true);
			shimmering?.destroy(true);
			blank?.destroy(true);
			plain = shimmering = blank = null;
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
