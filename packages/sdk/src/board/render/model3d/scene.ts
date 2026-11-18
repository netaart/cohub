import { DirectionalLight, View3D } from "@pixi/3d";
import { MODEL_LIGHTING, type ModelLighting } from "./lighting.js";
import type { LoadedModel } from "./load.js";
import { createModelShader, type ModelShader } from "./shading.js";
import { MODEL_SHADINGS, MODEL_VIEW_PRESETS, type ModelShading, type ModelView } from "./view.js";

export type ModelScene = {
	readonly view: View3D;
	readonly animated: boolean;
	readonly clips: readonly string[];
	clip: string | null;
	playing: boolean;
	spinning: boolean;
	readonly shadings: readonly ModelShading[];
	shading: ModelShading;
	wireframe: boolean;
	readonly viewpoint: ModelView;
	homeView: ModelView;
	readonly atHome: boolean;
	resize(width: number, height: number, scale?: number, density?: number): void;
	press(pointerId: number, x: number, y: number, pan?: boolean): void;
	move(pointerId: number, x: number, y: number): void;
	release(pointerId: number): void;
	wheel(deltaY: number): void;
	turn(yaw: number, pitch: number): void;
	key(key: string): boolean;
	look(view: ModelView, animate?: boolean): void;
	home(animate?: boolean): void;
	step(deltaMs: number): boolean;
	destroy(): void;
};

export type ModelSceneOptions = {
	reducedMotion?: boolean;
	home?: ModelView;
	changed?: () => void;
	lighting?: ModelLighting;
};

const FOV = 38;
const PADDING = 0.15;
const MAX_PITCH = Math.PI / 2 - 0.05;
const SMOOTHING_MS = 70;
const MAX_EDGE_PX = 2048;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;
const MAX_PAN = 1.5;
const LIGHT_YAW = 0.7;
const LIGHT_PITCH = 0.45;
const SETTLED = 1e-4;
const SPIN_PER_MS = (2 * Math.PI) / 24_000;
const SPIN_IDLE_MS = 1_500;
const KEY_TURN = 15;
const KEY_ZOOM = 240;
const DEG = Math.PI / 180;
const TURN = 2 * Math.PI;

type Vec = [number, number, number];
type Orbit = { yaw: number; pitch: number; distance: number; target: Vec };

const direction = (yaw: number, pitch: number): Vec => [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec): Vec => {
	const length = Math.hypot(...a) || 1;
	return [a[0] / length, a[1] / length, a[2] / length];
};
const add = (a: Vec, b: Vec, scale = 1): Vec => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places || 0;
const clampPitch = (pitch: number) => Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));

function axes(yaw: number, pitch: number) {
	const view = direction(yaw, pitch);
	const right = normalize(cross([0, 1, 0], view));
	return { view, right, up: cross(view, right) };
}

function fitDistance(min: Vec, max: Vec, center: Vec, yaw: number, pitch: number): number {
	const { view, right, up } = axes(yaw, pitch);
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

export function createModelScene(model: LoadedModel, options: ModelSceneOptions = {}): ModelScene {
	const reducedMotion = options.reducedMotion ?? false;
	const changed = () => options.changed?.();
	const lighting = MODEL_LIGHTING[options.lighting ?? "card"];
	const view = new View3D({ environment: lighting.environment, toneMapping: lighting.toneMapping, exposure: lighting.exposure });
	view.eventMode = "none";
	const light = new DirectionalLight({ intensity: lighting.light, color: 0xfff8f0 });
	view.root.addChild(model.root, light);

	const bounds = model.root.getLocalBounds();
	const empty = bounds.isEmpty();
	const min: Vec = empty ? [-0.5, -0.5, -0.5] : [bounds.min.x, bounds.min.y, bounds.min.z];
	const max: Vec = empty ? [0.5, 0.5, 0.5] : [bounds.max.x, bounds.max.y, bounds.max.z];
	const center: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
	const fit = (yaw: number, pitch: number) => fitDistance(min, max, center, yaw, pitch);
	const preset = MODEL_VIEW_PRESETS.home;
	const rest = fit(preset.yaw * DEG, preset.pitch * DEG);
	const farthest = Math.max(rest * MAX_ZOOM, radius * (1 + 1 / (Math.tan((FOV * Math.PI) / 360) * (1 - PADDING))));
	view.camera.near = Math.max(rest / 1000, radius * 0.01);
	view.camera.far = farthest + radius * (2 + MAX_PAN);

	const clampDistance = (distance: number) => Math.max(rest * MIN_ZOOM, Math.min(farthest, distance));
	function clampTarget(target: Vec): Vec {
		const offset = add(target, center, -1);
		return add(center, offset, Math.min(1, (radius * MAX_PAN) / (Math.hypot(...offset) || 1)));
	}
	function orbitOf(next: ModelView): Orbit {
		const yaw = next.yaw * DEG;
		const pitch = clampPitch(next.pitch * DEG);
		const [x, y, z] = next.target ?? [0, 0, 0];
		return {
			yaw,
			pitch,
			distance: clampDistance(fit(yaw, pitch) / Math.max(next.zoom, 1e-3)),
			target: clampTarget(add(center, [x, y, z], radius)),
		};
	}

	let homeView: ModelView = options.home ?? preset;
	let home = orbitOf(homeView);
	const current: Orbit = { ...home, target: [...home.target] };
	const goal: Orbit = { ...home, target: [...home.target] };
	const pointers = new Map<number, { x: number; y: number }>();
	const clips = model.player?.animationLabels ?? [];
	const shadings: readonly ModelShading[] = model.stats.materials > 0 ? MODEL_SHADINGS : ["standard", "normals"];
	let shader: ModelShader | null = null;
	let clip = clips[0] ?? null;
	let screenHeight = 1;
	let fovY = FOV * DEG;
	let panning = false;
	let playing = false;
	let spinning = false;
	let idle = 0;

	function place() {
		const [dx, dy, dz] = direction(current.yaw, current.pitch);
		const [tx, ty, tz] = current.target;
		view.camera.position.set(tx + dx * current.distance, ty + dy * current.distance, tz + dz * current.distance);
		view.camera.lookAt({ x: tx, y: ty, z: tz });
		const [lx, ly, lz] = direction(current.yaw + LIGHT_YAW, Math.min(MAX_PITCH, current.pitch + LIGHT_PITCH));
		light.position.set(center[0] + lx * rest, center[1] + ly * rest, center[2] + lz * rest);
		light.lookAt({ x: center[0], y: center[1], z: center[2] });
	}
	place();

	const near = (a: Orbit, b: Orbit) =>
		Math.abs(a.yaw - b.yaw) < SETTLED &&
		Math.abs(a.pitch - b.pitch) < SETTLED &&
		Math.abs(Math.log(a.distance / b.distance)) < SETTLED &&
		Math.hypot(...add(a.target, b.target, -1)) < SETTLED * radius;
	const settled = () => near(goal, current);

	function snap() {
		Object.assign(current, goal, { target: [...goal.target] });
		place();
	}

	function touched() {
		idle = 0;
		if (reducedMotion) snap();
		changed();
	}

	function pan(dx: number, dy: number) {
		const { right, up } = axes(goal.yaw, goal.pitch);
		const perPixel = (2 * goal.distance * Math.tan(fovY / 2)) / screenHeight;
		goal.target = clampTarget(add(add(goal.target, right, -dx * perPixel), up, dy * perPixel));
	}

	const stateOf = (label: string | null) => (label ? model.player?.getState(label) : undefined);

	const scene: ModelScene = {
		view,
		animated: clips.length > 0,
		clips,
		get clip() {
			return clip;
		},
		set clip(label) {
			if (!label || label === clip || !clips.includes(label)) return;
			stateOf(clip)?.stop();
			clip = label;
			const state = stateOf(label);
			if (playing) state?.gotoAndPlay(0);
			else {
				state?.gotoAndStop(0);
				model.player?.update({ deltaMS: 0 } as Parameters<NonNullable<typeof model.player>["update"]>[0]);
			}
			changed();
		},
		get playing() {
			return playing;
		},
		set playing(value) {
			playing = value && clips.length > 0;
			const state = stateOf(clip);
			if (playing) state?.play();
			else state?.stop();
			changed();
		},
		get spinning() {
			return spinning;
		},
		set spinning(value) {
			spinning = value && !reducedMotion;
			idle = SPIN_IDLE_MS;
			changed();
		},
		shadings,
		get shading() {
			return shader?.shading ?? "standard";
		},
		set shading(mode) {
			if (mode === scene.shading || !shadings.includes(mode)) return;
			shader ??= createModelShader(model, view);
			shader.shading = mode;
			changed();
		},
		get wireframe() {
			return shader?.wireframe ?? false;
		},
		set wireframe(value) {
			if (value === scene.wireframe) return;
			shader ??= createModelShader(model, view);
			shader.wireframe = value;
			changed();
		},
		get viewpoint() {
			const yaw = goal.yaw - Math.round(goal.yaw / TURN) * TURN;
			const target = add(goal.target, center, -1).map((value) => round(value / radius, 3)) as Vec;
			return {
				yaw: round(yaw / DEG, 2),
				pitch: round(goal.pitch / DEG, 2),
				zoom: round(fit(goal.yaw, goal.pitch) / goal.distance, 3),
				...(target.some(Boolean) && { target }),
			};
		},
		get homeView() {
			return homeView;
		},
		set homeView(view) {
			homeView = view;
			home = orbitOf(view);
		},
		get atHome() {
			return settled() && near({ ...current, yaw: current.yaw - Math.round((current.yaw - home.yaw) / TURN) * TURN }, home);
		},
		resize(width, height, scale = 1, density = 1) {
			const fitScale = Math.min(scale, MAX_EDGE_PX / (Math.max(width, height, 1) * density));
			const pixelsWide = Math.max(1, Math.round(width * fitScale));
			const pixelsHigh = Math.max(1, Math.round(height * fitScale));
			view.setSize(pixelsWide, pixelsHigh);
			view.scale.set(width / pixelsWide, height / pixelsHigh);
			fovY = 2 * Math.atan(Math.tan((FOV * Math.PI) / 360) * (height / Math.min(width, height)));
			view.camera.fov = fovY / DEG;
			screenHeight = Math.max(1, height * scale);
		},
		press(pointerId, x, y, panMode = false) {
			pointers.set(pointerId, { x, y });
			if (pointers.size === 1) panning = panMode;
			idle = 0;
		},
		move(pointerId, x, y) {
			const last = pointers.get(pointerId);
			if (!last) return;
			const dx = x - last.x;
			const dy = y - last.y;
			if (pointers.size === 1) {
				if (panning) pan(dx, dy);
				else {
					const speed = (1.6 * Math.PI) / Math.max(screenHeight, 240);
					goal.yaw -= dx * speed;
					goal.pitch = clampPitch(goal.pitch + dy * speed);
				}
			} else {
				const other = [...pointers].find(([id]) => id !== pointerId)?.[1];
				if (other) {
					const before = Math.hypot(last.x - other.x, last.y - other.y);
					const after = Math.hypot(x - other.x, y - other.y);
					if (before > 0 && after > 0) goal.distance = clampDistance(goal.distance * (before / after));
					pan(dx / 2, dy / 2);
				}
			}
			pointers.set(pointerId, { x, y });
			touched();
		},
		release(pointerId) {
			pointers.delete(pointerId);
		},
		wheel(deltaY) {
			goal.distance = clampDistance(goal.distance * Math.exp(deltaY * 0.0015));
			touched();
		},
		turn(yaw, pitch) {
			goal.yaw += yaw * DEG;
			goal.pitch = clampPitch(goal.pitch + pitch * DEG);
			touched();
		},
		key(key) {
			const move: Record<string, () => void> = {
				ArrowLeft: () => scene.turn(KEY_TURN, 0),
				ArrowRight: () => scene.turn(-KEY_TURN, 0),
				ArrowUp: () => scene.turn(0, KEY_TURN),
				ArrowDown: () => scene.turn(0, -KEY_TURN),
				"+": () => scene.wheel(-KEY_ZOOM),
				"=": () => scene.wheel(-KEY_ZOOM),
				"-": () => scene.wheel(KEY_ZOOM),
				"0": () => scene.home(),
				Home: () => scene.home(),
			};
			move[key]?.();
			return key in move;
		},
		look(next, animate = true) {
			const orbit = orbitOf(next);
			orbit.yaw += Math.round((current.yaw - orbit.yaw) / TURN) * TURN;
			Object.assign(goal, orbit);
			idle = 0;
			if (!animate || reducedMotion) snap();
			changed();
		},
		home(animate = true) {
			scene.look(homeView, animate);
		},
		step(deltaMs) {
			const elapsed = Math.max(0, deltaMs);
			idle += elapsed;
			const turning = spinning && pointers.size === 0;
			if (turning && idle >= SPIN_IDLE_MS) goal.yaw += elapsed * SPIN_PER_MS;
			let moving = false;
			if (!settled()) {
				const t = reducedMotion ? 1 : 1 - Math.exp(-elapsed / SMOOTHING_MS);
				current.yaw += (goal.yaw - current.yaw) * t;
				current.pitch += (goal.pitch - current.pitch) * t;
				current.distance *= (goal.distance / current.distance) ** t;
				current.target = add(current.target, add(goal.target, current.target, -1), t);
				if (settled()) {
					goal.yaw -= Math.round(goal.yaw / TURN) * TURN;
					snap();
				} else moving = true;
				place();
			}
			if (playing && model.player) model.player.update({ deltaMS: Math.min(elapsed, 100) } as Parameters<typeof model.player.update>[0]);
			return moving || turning;
		},
		destroy() {
			pointers.clear();
			shader?.destroy();
			view.root.removeChild(model.root);
			view.destroy({ children: true });
		},
	};
	return scene;
}
