import { DirectionalLight, View3D } from "@pixi/3d";
import type { LoadedModel } from "./load.js";

export type ModelScene = {
	readonly view: View3D;
	readonly animated: boolean;
	playing: boolean;
	readonly atHome: boolean;
	resize(width: number, height: number, scale?: number, density?: number): void;
	press(pointerId: number, x: number, y: number): void;
	move(pointerId: number, x: number, y: number): void;
	release(pointerId: number): void;
	wheel(deltaY: number): void;
	home(animate?: boolean): void;
	step(deltaMs: number): boolean;
	destroy(): void;
};

const FOV = 38;
const PADDING = 0.15;
const MAX_PITCH = Math.PI / 2 - 0.05;
const SMOOTHING_MS = 70;
const MAX_EDGE_PX = 2048;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;
const LIGHT_YAW = 0.7;
const LIGHT_PITCH = 0.45;
const SETTLED = 1e-4;

const HOME = (() => {
	const [x, y, z] = [0.55, 0.38, 1];
	const length = Math.hypot(x, y, z);
	return { yaw: Math.atan2(x, z), pitch: Math.asin(y / length) };
})();

type Vec = [number, number, number];
type Orbit = { yaw: number; pitch: number; distance: number };

const direction = (yaw: number, pitch: number): Vec => [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec): Vec => {
	const length = Math.hypot(...a) || 1;
	return [a[0] / length, a[1] / length, a[2] / length];
};

function homeDistance(min: Vec, max: Vec, center: Vec): number {
	const view = direction(HOME.yaw, HOME.pitch);
	const right = normalize(cross([0, 1, 0], view));
	const up = cross(view, right);
	const tan = Math.tan((FOV * Math.PI) / 360) * (1 - PADDING);
	let distance = 0;
	for (let index = 0; index < 8; index += 1) {
		const corner: Vec = [
			(index & 1 ? max[0] : min[0]) - center[0],
			(index & 2 ? max[1] : min[1]) - center[1],
			(index & 4 ? max[2] : min[2]) - center[2],
		];
		const depth = dot(corner, view);
		distance = Math.max(distance, depth + Math.abs(dot(corner, right)) / tan, depth + Math.abs(dot(corner, up)) / tan);
	}
	return distance || 1;
}

export function createModelScene(model: LoadedModel, options: { reducedMotion?: boolean } = {}): ModelScene {
	const view = new View3D({
		environment: { skyColor: 0xffffff, groundColor: 0x77726c, intensity: 0.85 },
		toneMapping: "aces",
		exposure: 1.1,
	});
	view.eventMode = "none";
	const light = new DirectionalLight({ intensity: 2.6, color: 0xfff8f0 });
	view.root.addChild(model.root, light);

	const bounds = model.root.getLocalBounds();
	const empty = bounds.isEmpty();
	const min: Vec = empty ? [-0.5, -0.5, -0.5] : [bounds.min.x, bounds.min.y, bounds.min.z];
	const max: Vec = empty ? [0.5, 0.5, 0.5] : [bounds.max.x, bounds.max.y, bounds.max.z];
	const center: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
	const rest = homeDistance(min, max, center);
	view.camera.near = Math.max(rest / 1000, radius * 0.01);
	view.camera.far = rest * MAX_ZOOM + radius * 2;

	const current: Orbit = { yaw: HOME.yaw, pitch: HOME.pitch, distance: rest };
	const goal: Orbit = { ...current };
	const pointers = new Map<number, { x: number; y: number }>();
	let screenHeight = 1;
	let playing = false;

	function place() {
		const [dx, dy, dz] = direction(current.yaw, current.pitch);
		view.camera.position.set(center[0] + dx * current.distance, center[1] + dy * current.distance, center[2] + dz * current.distance);
		view.camera.lookAt({ x: center[0], y: center[1], z: center[2] });
		const [lx, ly, lz] = direction(current.yaw + LIGHT_YAW, Math.min(MAX_PITCH, current.pitch + LIGHT_PITCH));
		light.position.set(center[0] + lx * rest, center[1] + ly * rest, center[2] + lz * rest);
		light.lookAt({ x: center[0], y: center[1], z: center[2] });
	}
	place();

	const clampPitch = (pitch: number) => Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
	const clampDistance = (distance: number) => Math.max(rest * MIN_ZOOM, Math.min(rest * MAX_ZOOM, distance));
	const settled = () =>
		Math.abs(goal.yaw - current.yaw) < SETTLED && Math.abs(goal.pitch - current.pitch) < SETTLED && Math.abs(Math.log(goal.distance / current.distance)) < SETTLED;

	function snap() {
		Object.assign(current, goal);
		place();
	}

	const scene: ModelScene = {
		view,
		animated: model.player !== null,
		get playing() {
			return playing;
		},
		set playing(value) {
			playing = value && model.player !== null;
			const label = model.player?.animationLabels[0];
			if (!label) return;
			const state = model.player?.getState(label);
			if (playing) state?.play();
			else state?.stop();
		},
		get atHome() {
			return settled() && Math.abs(current.yaw - HOME.yaw) < SETTLED && Math.abs(current.pitch - HOME.pitch) < SETTLED && Math.abs(current.distance / rest - 1) < SETTLED;
		},
		resize(width, height, scale = 1, density = 1) {
			const fit = Math.min(scale, MAX_EDGE_PX / (Math.max(width, height, 1) * density));
			const pixelsWide = Math.max(1, Math.round(width * fit));
			const pixelsHigh = Math.max(1, Math.round(height * fit));
			view.setSize(pixelsWide, pixelsHigh);
			view.scale.set(width / pixelsWide, height / pixelsHigh);
			view.camera.fov = (2 * Math.atan(Math.tan((FOV * Math.PI) / 360) * (height / Math.min(width, height))) * 180) / Math.PI;
			screenHeight = Math.max(1, height * scale);
		},
		press(pointerId, x, y) {
			pointers.set(pointerId, { x, y });
		},
		move(pointerId, x, y) {
			const last = pointers.get(pointerId);
			if (!last) return;
			if (pointers.size === 1) {
				const speed = (1.6 * Math.PI) / Math.max(screenHeight, 240);
				goal.yaw -= (x - last.x) * speed;
				goal.pitch = clampPitch(goal.pitch + (y - last.y) * speed);
			} else {
				const other = [...pointers].find(([id]) => id !== pointerId)?.[1];
				if (other) {
					const before = Math.hypot(last.x - other.x, last.y - other.y);
					const after = Math.hypot(x - other.x, y - other.y);
					if (before > 0 && after > 0) goal.distance = clampDistance(goal.distance * (before / after));
				}
			}
			pointers.set(pointerId, { x, y });
			if (options.reducedMotion) snap();
		},
		release(pointerId) {
			pointers.delete(pointerId);
		},
		wheel(deltaY) {
			goal.distance = clampDistance(goal.distance * Math.exp(deltaY * 0.0015));
			if (options.reducedMotion) snap();
		},
		home(animate = true) {
			const turns = Math.round((current.yaw - HOME.yaw) / (2 * Math.PI));
			Object.assign(goal, { yaw: HOME.yaw + turns * 2 * Math.PI, pitch: HOME.pitch, distance: rest });
			if (!animate || options.reducedMotion) snap();
		},
		step(deltaMs) {
			let moving = false;
			if (!settled()) {
				const t = options.reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, deltaMs) / SMOOTHING_MS);
				current.yaw += (goal.yaw - current.yaw) * t;
				current.pitch += (goal.pitch - current.pitch) * t;
				current.distance *= (goal.distance / current.distance) ** t;
				if (settled()) {
					const turns = Math.round((goal.yaw - HOME.yaw) / (2 * Math.PI));
					goal.yaw -= turns * 2 * Math.PI;
					Object.assign(current, goal);
				} else moving = true;
				place();
			}
			if (playing && model.player) model.player.update({ deltaMS: Math.min(deltaMs, 100) } as Parameters<typeof model.player.update>[0]);
			return moving;
		},
		destroy() {
			pointers.clear();
			view.root.removeChild(model.root);
			view.destroy({ children: true });
		},
	};
	return scene;
}
