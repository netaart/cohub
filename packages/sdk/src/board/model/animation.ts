
import {
	BOARD_CAMERA_TARGET,
	type BoardAnimation,
	type BoardAnimationHeader,
	type BoardColor,
	type BoardDocument,
	type BoardItem,
	type BoardTrack,
	type BoardValueKind,
	type BoardVec2,
	resolveBoardProperty,
} from "@cohub/protocol";


export type BoardEaseFunction = (progress: number) => number;

const linear: BoardEaseFunction = (x) => x;

function cubicBezier(x1: number, y1: number, x2: number, y2: number): BoardEaseFunction {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
	const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
	const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let t = x;
		for (let index = 0; index < 8; index += 1) {
			const error = sampleX(t) - x;
			if (Math.abs(error) < 1e-6) return sampleY(t);
			const slope = slopeX(t);
			if (Math.abs(slope) < 1e-6) break;
			t -= error / slope;
		}
		let low = 0;
		let high = 1;
		t = x;
		for (let index = 0; index < 32; index += 1) {
			const value = sampleX(t);
			if (Math.abs(value - x) < 1e-6) break;
			if (value < x) low = t;
			else high = t;
			t = (low + high) / 2;
		}
		return sampleY(t);
	};
}

function steps(count: number, position: string): BoardEaseFunction {
	const jumps = position === "jump-none" ? count - 1 : position === "jump-both" ? count + 1 : count;
	const start = position === "start" || position === "jump-start" || position === "jump-both";
	return (x) => {
		if (x >= 1) return 1;
		const step = Math.floor(x * count) + (start ? 1 : 0);
		return Math.min(1, Math.max(0, step / Math.max(1, jumps)));
	};
}

const KEYWORD_EASES: Record<string, BoardEaseFunction> = {
	linear,
	ease: cubicBezier(0.25, 0.1, 0.25, 1),
	"ease-in": cubicBezier(0.42, 0, 1, 1),
	"ease-out": cubicBezier(0, 0, 0.58, 1),
	"ease-in-out": cubicBezier(0.42, 0, 0.58, 1),
	"step-start": steps(1, "start"),
	"step-end": steps(1, "end"),
};
const easeCache = new Map<string, BoardEaseFunction>();

export function boardEase(ease: string | undefined): BoardEaseFunction {
	if (!ease) return linear;
	const key = ease.trim();
	const keyword = KEYWORD_EASES[key];
	if (keyword) return keyword;
	const cached = easeCache.get(key);
	if (cached) return cached;
	let fn = linear;
	const bezier = /^cubic-bezier\(([^)]+)\)$/.exec(key);
	const stepped = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(key);
	if (bezier?.[1]) {
		const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = bezier[1].split(",").map(Number);
		fn = cubicBezier(x1, y1, x2, y2);
	} else if (stepped?.[1]) fn = steps(Number(stepped[1]), stepped[2] ?? "end");
	if (easeCache.size > 512) easeCache.clear();
	easeCache.set(key, fn);
	return fn;
}


export function boardAnimationTime(header: Pick<BoardAnimationHeader, "duration" | "delay" | "loop" | "end" | "play">, elapsed: number): number | null {
	const local = Math.max(0, elapsed - header.delay);
	if (header.loop || header.play === "always") return header.duration > 0 ? local % header.duration : 0;
	if (local <= header.duration) return local;
	return header.end === "reset" ? null : header.duration;
}


type Kind = BoardValueKind;

export type CompiledTrack = {
	id: string;
	animationId: string;
	target: string;
	property: string;
	path: readonly string[];
	kind: Kind;
	multiplicative: boolean;
	composite: "replace" | "add";
	spline: boolean;
	step: boolean;
	orient: boolean;
	times: Float64Array;
	values: readonly unknown[];
	eases: readonly BoardEaseFunction[];
	start: number;
};

export type CompiledAnimation = {
	id: string;
	header: BoardAnimationHeader;
	tracks: readonly CompiledTrack[];
	children: readonly CompiledTrack[];
};

export type CompiledBoardAnimations = {
	readonly animations: ReadonlyMap<string, CompiledAnimation>;
	readonly order: readonly string[];
	readonly document: BoardDocument;
};

function compileTrack(animationId: string, id: string, track: BoardTrack, targetType: string): CompiledTrack | null {
	const resolved = resolveBoardProperty(targetType, track.property);
	if (!resolved.ok) return null;
	const { spec } = resolved;
	const times = new Float64Array(track.keyframes.length);
	const values: unknown[] = [];
	const eases: BoardEaseFunction[] = [];
	track.keyframes.forEach((keyframe, index) => {
		times[index] = keyframe.at;
		values.push(keyframe.value);
		eases.push(boardEase(keyframe.ease));
	});
	return {
		id,
		animationId,
		target: track.target,
		property: track.property,
		path: track.property.split("."),
		kind: spec.kind,
		multiplicative: Boolean(spec.multiplicative),
		composite: track.composite,
		spline: track.interpolation === "spline" && spec.kind === "vec2",
		step: track.interpolation === "step" || spec.kind === "discrete",
		orient: Boolean(track.orient) && spec.kind === "vec2" && track.property === "position",
		times,
		values,
		eases,
		start: times[0] ?? 0,
	};
}

export function compileBoardAnimations(document: BoardDocument): CompiledBoardAnimations {
	const animations = new Map<string, CompiledAnimation>();
	for (const [animationId, animation] of Object.entries(document.animations)) {
		animations.set(animationId, compileAnimation(animationId, animation, document));
	}
	const incoming = new Map([...animations.keys()].map((id) => [id, 0]));
	for (const animation of animations.values()) {
		for (const track of animation.children) incoming.set(track.target, (incoming.get(track.target) ?? 0) + 1);
	}
	const order = [...animations.keys()].filter((id) => incoming.get(id) === 0).sort();
	for (let index = 0; index < order.length; index += 1) {
		const animation = animations.get(order[index] as string);
		for (const track of animation?.children ?? []) {
			const count = (incoming.get(track.target) ?? 1) - 1;
			incoming.set(track.target, count);
			if (count === 0) order.push(track.target);
		}
	}
	if (order.length !== animations.size) throw new Error("Animation graph contains a cycle");
	return { animations, document, order };
}

function compileAnimation(animationId: string, animation: BoardAnimation, document: BoardDocument): CompiledAnimation {
	const { tracks, ...header } = animation;
	const compiled: CompiledTrack[] = [];
	const children: CompiledTrack[] = [];
	for (const [id, track] of Object.entries(tracks).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		const targetType = track.target === BOARD_CAMERA_TARGET
			? BOARD_CAMERA_TARGET
			: document.animations[track.target]
				? "animation"
				: document.items[track.target]?.type;
		if (!targetType) continue;
		const entry = compileTrack(animationId, id, track, targetType);
		if (!entry) continue;
		(targetType === "animation" ? children : compiled).push(entry);
	}
	return { id: animationId, header, tracks: compiled, children };
}


function keyframeIndex(times: Float64Array, time: number): number {
	let low = 0;
	let high = times.length - 1;
	if (time < (times[0] as number)) return -1;
	if (time >= (times[high] as number)) return high;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((times[mid] as number) <= time) low = mid;
		else high = mid - 1;
	}
	return low;
}

function isVec(value: unknown): value is BoardVec2 {
	return Boolean(value) && typeof value === "object" && typeof (value as BoardVec2).x === "number" && typeof (value as BoardVec2).y === "number";
}

function toVec(value: unknown): BoardVec2 {
	if (typeof value === "number") return { x: value, y: value };
	return isVec(value) ? value : { x: 0, y: 0 };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const t2 = t * t;
	const t3 = t2 * t;
	return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export type BoardColorResolver = (color: BoardColor) => number | null;

function hex(color: number): string {
	return `#${Math.max(0, Math.min(0xffffff, Math.round(color))).toString(16).padStart(6, "0")}`;
}

function mixColor(a: unknown, b: unknown, t: number, resolve: BoardColorResolver): unknown {
	const from = resolve(a as BoardColor);
	const to = resolve(b as BoardColor);
	if (from === null || to === null) return t < 1 ? a : b;
	const channel = (shift: number) => Math.round(lerp((from >> shift) & 0xff, (to >> shift) & 0xff, t));
	return hex((channel(16) << 16) | (channel(8) << 8) | channel(0));
}

export function parseHexColor(color: BoardColor): number | null {
	if (typeof color !== "string") return null;
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (!match?.[1]) return null;
	const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
	return Number.parseInt(digits, 16);
}

function blend(track: CompiledTrack, index: number, time: number, resolveColor: BoardColorResolver): unknown {
	const { times, values } = track;
	const from = values[index];
	const to = values[index + 1];
	const t0 = times[index] as number;
	const t1 = times[index + 1] as number;
	if (to === undefined || t1 <= t0) return from;
	const progress = (track.eases[index + 1] as BoardEaseFunction)((time - t0) / (t1 - t0));
	if (track.step) return progress >= 1 ? to : from;
	switch (track.kind) {
		case "number":
			return typeof from === "number" && typeof to === "number" ? lerp(from, to, progress) : from;
		case "vec2":
		case "scale": {
			if (track.kind === "scale" && typeof from === "number" && typeof to === "number") return lerp(from, to, progress);
			const a = toVec(from);
			const b = toVec(to);
			if (track.spline) {
				const before = toVec(values[index - 1] ?? from);
				const after = toVec(values[index + 2] ?? to);
				return { x: catmullRom(before.x, a.x, b.x, after.x, progress), y: catmullRom(before.y, a.y, b.y, after.y, progress) };
			}
			return { x: lerp(a.x, b.x, progress), y: lerp(a.y, b.y, progress) };
		}
		case "color":
			return mixColor(from, to, progress, resolveColor);
		default:
			return progress >= 1 ? to : from;
	}
}

export function sampleBoardTrack(track: CompiledTrack, time: number, resolveColor: BoardColorResolver = parseHexColor): unknown {
	const index = keyframeIndex(track.times, time);
	if (index < 0) return track.values[0];
	return blend(track, index, time, resolveColor);
}

function orientation(track: CompiledTrack, time: number, resolveColor: BoardColorResolver): number | null {
	const span = Math.max(1, ((track.times[track.times.length - 1] as number) - track.start) / 1000);
	const a = toVec(sampleBoardTrack(track, Math.max(track.start, time - span), resolveColor));
	const b = toVec(sampleBoardTrack(track, time + span, resolveColor));
	if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return null;
	return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}


export type BoardCameraOverride = {
	focus?: string | { x: number; y: number; width: number; height: number };
	zoom?: number;
	center?: BoardVec2;
	shake?: number;
};

export type BoardEvaluation = {
	items: ReadonlyMap<string, BoardItem>;
	camera: BoardCameraOverride;
	times: ReadonlyMap<string, number>;
};

export type BoardEvaluateOptions = {
	resolveColor?: BoardColorResolver;
};

function readPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const segment of path) {
		if (typeof current === "number" && (segment === "x" || segment === "y")) return current;
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function writePath(value: Record<string, unknown>, path: readonly string[], next: unknown, depth = 0): Record<string, unknown> {
	const key = path[depth] as string;
	if (depth === path.length - 1) return { ...value, [key]: next };
	let child = value[key];
	if (typeof child === "number") child = { x: child, y: child };
	const base = child && typeof child === "object" ? (child as Record<string, unknown>) : {};
	return { ...value, [key]: writePath(base, path, next, depth + 1) };
}

function combine(track: CompiledTrack, base: unknown, value: unknown): unknown {
	if (track.composite !== "add") return value;
	if (track.kind === "number") {
		if (typeof base !== "number" || typeof value !== "number") return value;
		return track.multiplicative ? base * value : base + value;
	}
	if (track.kind === "vec2" || track.kind === "scale") {
		if (track.multiplicative) {
			if (typeof base === "number" && typeof value === "number") return base * value;
			const a = toVec(base ?? 1);
			const b = toVec(value);
			return { x: a.x * b.x, y: a.y * b.y };
		}
		const a = toVec(base);
		const b = toVec(value);
		return { x: a.x + b.x, y: a.y + b.y };
	}
	return value;
}

function outranks(track: CompiledTrack, time: number, other: CompiledTrack, otherTime: number): boolean {
	const elapsed = time - track.start;
	const otherElapsed = otherTime - other.start;
	if (elapsed >= 0 !== otherElapsed >= 0) return elapsed >= 0;
	const distance = Math.abs(elapsed);
	const otherDistance = Math.abs(otherElapsed);
	if (distance !== otherDistance) return distance < otherDistance;
	return track.id > other.id;
}

export function evaluateBoardAnimations(
	compiled: CompiledBoardAnimations,
	times: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
	options: BoardEvaluateOptions = {},
): BoardEvaluation {
	const resolveColor = options.resolveColor ?? parseHexColor;
	const local = new Map<string, number>(times instanceof Map ? times : Object.entries(times));
	for (const id of compiled.order) {
		const animation = compiled.animations.get(id);
		const time = local.get(id);
		if (!animation || time === undefined) continue;
		for (const track of animation.children) {
			const value = sampleBoardTrack(track, time, resolveColor);
			if (typeof value === "number") local.set(track.target, Math.max(0, value));
		}
	}

	type Group = { target: string; path: readonly string[]; winner?: CompiledTrack; winnerTime: number; adds: Array<[CompiledTrack, number]> };
	const groups = new Map<string, Group>();
	for (const [id, time] of local) {
		const animation = compiled.animations.get(id);
		if (!animation) continue;
		for (const track of animation.tracks) {
			const key = `${track.target}\u0000${track.property}`;
			let group = groups.get(key);
			if (!group) {
				group = { target: track.target, path: track.path, winnerTime: 0, adds: [] };
				groups.set(key, group);
			}
			if (track.composite === "add") {
				group.adds.push([track, time]);
				continue;
			}
			if (!group.winner || outranks(track, time, group.winner, group.winnerTime)) {
				group.winner = track;
				group.winnerTime = time;
			}
		}
	}

	const items = new Map<string, BoardItem>();
	const camera: BoardCameraOverride = {};
	const ordered = [...groups.values()].sort((a, b) => a.path.length - b.path.length);
	for (const group of ordered) {
		const isCamera = group.target === BOARD_CAMERA_TARGET;
		const base = isCamera ? undefined : (items.get(group.target) ?? compiled.document.items[group.target]);
		if (!isCamera && !base) continue;
		let value = isCamera ? (camera as Record<string, unknown>)[group.path[0] as string] : readPath(base, group.path);
		let orientTrack: [CompiledTrack, number] | null = null;
		if (group.winner) {
			value = sampleBoardTrack(group.winner, group.winnerTime, resolveColor);
			if (group.winner.orient) orientTrack = [group.winner, group.winnerTime];
		}
		for (const [track, time] of group.adds) {
			value = combine(track, value, sampleBoardTrack(track, time, resolveColor));
			if (track.orient && !orientTrack) orientTrack = [track, time];
		}
		if (isCamera) {
			(camera as Record<string, unknown>)[group.path[0] as string] = value;
			continue;
		}
		let next = writePath(base as unknown as Record<string, unknown>, group.path, value) as unknown as BoardItem;
		if (orientTrack) {
			const angle = orientation(orientTrack[0], orientTrack[1], resolveColor);
			if (angle !== null) next = { ...next, rotation: (base as BoardItem).rotation + angle };
		}
		items.set(group.target, next);
	}
	return { items, camera, times: local };
}

export function applyBoardEvaluation(document: BoardDocument, evaluation: BoardEvaluation): BoardDocument {
	if (evaluation.items.size === 0) return document;
	const items = { ...document.items };
	for (const [id, item] of evaluation.items) items[id] = item;
	return { ...document, items };
}

export function boardDocumentAt(document: BoardDocument, animationId: string | null, time: number, options: BoardEvaluateOptions = {}): { document: BoardDocument; evaluation: BoardEvaluation } {
	const compiled = compileBoardAnimations(document);
	const times = new Map<string, number>();
	for (const [id, animation] of compiled.animations) {
		if (animation.header.play === "always") times.set(id, boardAnimationTime(animation.header, time) ?? 0);
	}
	if (animationId) {
		const animation = compiled.animations.get(animationId);
		if (animation) times.set(animationId, Math.min(Math.max(0, time), animation.header.duration));
	}
	const evaluation = evaluateBoardAnimations(compiled, times, options);
	return { document: applyBoardEvaluation(document, evaluation), evaluation };
}
