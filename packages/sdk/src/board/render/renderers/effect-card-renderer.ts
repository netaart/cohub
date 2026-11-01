
import { Container, Graphics, type Particle, type ParticleContainer, Rectangle } from "pixi.js";
import type { BoardEffectItem, BoardParticleShape } from "@cohub/protocol";
import type { SceneItem } from "../../model/scene.js";
import { itemAlpha, itemColor } from "../palette.js";
import { type BoardParticleState, createBoardParticleLayer, hideBoardParticle, placeBoardParticle, sizeBoardParticleLayer } from "../particles.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

export const BOARD_EFFECT_MAX_PARTICLES = 4000;
const TRAIL_SAMPLES = 64;

type EffectParts = {
	root: Container;
	body: Container;
	still: Graphics;
	stillKey: string;
	moving: Graphics;
	particles: ParticleContainer | null;
	shape: BoardParticleShape | null;
	trail: Array<{ x: number; y: number; t: number }>;
};

const partsByContainer = new WeakMap<Container, EffectParts>();

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function random(seed: number, index: number, channel: number): number {
	let x = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77)) >>> 0;
	x ^= x >>> 16;
	x = Math.imul(x, 0x7feb352d);
	x ^= x >>> 15;
	x = Math.imul(x, 0x846ca68b);
	x ^= x >>> 16;
	return (x >>> 0) / 4294967296;
}

type Props = BoardEffectItem["props"];
type Emission = { props: Props; seed: number; colors: number[]; shape: BoardParticleShape };

function velocity(props: Props, seed: number, index: number) {
	const angle = ((props.direction + (random(seed, index, 1) - 0.5) * props.spread) * Math.PI) / 180;
	const speed = props.speed * (0.7 + random(seed, index, 2) * 0.6);
	return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

function particleAt(emission: Emission, seed: number, index: number, age: number, x: number, y: number, size: number, alpha: number): BoardParticleState {
	const { props, colors, shape } = emission;
	const { vx, vy } = velocity(props, seed, index);
	const px = x + vx * age;
	const py = y + vy * age + 0.5 * props.gravity * age * age;
	let rotation = 0;
	if (shape === "spark") rotation = Math.atan2(vy + props.gravity * age, vx);
	else if (shape === "square" || shape === "star") rotation = random(seed, index, 6) * Math.PI * 2 + (random(seed, index, 7) - 0.5) * 4 * Math.PI * age;
	const color = colors[Math.floor(random(seed, index, 8) * colors.length)] ?? 0xffffff;
	return { x: px, y: py, size, rotation, color, alpha };
}

function emitParticles(slots: Particle[], emission: Emission, width: number, height: number, time: number) {
	const { props, seed } = emission;
	const rate = props.rate * props.intensity;
	let used = 0;
	if (rate > 0) {
		const interval = 1000 / rate;
		const newest = Math.floor(time / interval);
		for (let index = Math.max(0, newest - slots.length + 1); index <= newest && used < slots.length; index += 1) {
			const age = (time - index * interval) / 1000;
			if (age < 0 || age * 1000 > props.life) continue;
			const progress = (age * 1000) / props.life;
			const size = props.particleSize * (0.6 + random(seed, index, 5) * 0.8) * (1 - progress * 0.5);
			const state = particleAt(emission, seed, index, age, random(seed, index, 3) * width, random(seed, index, 4) * height, size, (1 - progress) * Math.min(1, props.intensity));
			placeBoardParticle(slots[used++] as Particle, state);
		}
	}
	for (; used < slots.length; used += 1) hideBoardParticle(slots[used] as Particle);
}

function emitImpact(slots: Particle[], ring: Graphics, emission: Emission, width: number, height: number, time: number, color: number) {
	const { props, seed } = emission;
	const cycle = Math.floor(time / props.life);
	const age = (time - cycle * props.life) / 1000;
	const progress = (age * 1000) / props.life;
	const cx = width / 2;
	const cy = height / 2;
	const alpha = (1 - progress) ** 1.5 * Math.min(1, props.intensity);
	const radius = Math.min(width, height) * 0.5 * Math.sqrt(progress);
	ring.circle(cx, cy, radius).stroke({ color, width: Math.max(1, props.particleSize * (1 - progress)), alpha: alpha * 0.8 });
	const burst = hashString(`${seed}:${cycle}`);
	const size = props.particleSize * (1 - progress * 0.6);
	for (let index = 0; index < slots.length; index += 1) {
		placeBoardParticle(slots[index] as Particle, particleAt(emission, burst, index, age, cx, cy, size, alpha));
	}
}

function particleCount(props: Props): number {
	if (props.kind === "impact") return Math.min(BOARD_EFFECT_MAX_PARTICLES, Math.round(props.rate * props.intensity));
	const rate = props.rate * props.intensity;
	return rate > 0 ? Math.min(BOARD_EFFECT_MAX_PARTICLES, Math.ceil(props.life / (1000 / rate)) + 1) : 0;
}

function particleBounds(props: Props, width: number, height: number): Rectangle {
	const seconds = props.life / 1000;
	const reach = props.speed * 1.3 * seconds + 0.5 * Math.abs(props.gravity) * seconds * seconds + props.particleSize * 1.4;
	return new Rectangle(-reach, -reach, width + reach * 2, height + reach * 2);
}

function syncParticles(parts: EffectParts, emission: Emission, width: number, height: number): Particle[] {
	if (!parts.particles || parts.shape !== emission.shape) {
		parts.particles?.destroy();
		parts.particles = parts.body.addChild(createBoardParticleLayer(emission.shape));
		parts.shape = emission.shape;
	}
	sizeBoardParticleLayer(parts.particles, particleCount(emission.props), particleBounds(emission.props, width, height));
	return parts.particles.particleChildren as Particle[];
}

function drawStill(parts: EffectParts, props: Props, width: number, height: number, color: number) {
	const key = `${props.kind}:${width}:${height}:${color}`;
	if (parts.stillKey === key) return;
	parts.stillKey = key;
	const graphics = parts.still.clear();
	if (props.kind === "flash") graphics.rect(0, 0, width, height).fill({ color });
	if (props.kind !== "glow") return;
	const rings = 12;
	for (let ring = rings; ring >= 1; ring -= 1) {
		const fraction = ring / rings;
		graphics.ellipse(width / 2, height / 2, (width / 2) * fraction, (height / 2) * fraction).fill({ color, alpha: ((1 - fraction) * 2) / rings });
	}
}

function stillAlpha(props: Props, time: number): number {
	const intensity = Math.min(1, props.intensity);
	if (props.kind === "flash") return (1 - (time % props.life) / props.life) ** 2 * intensity;
	if (props.kind === "glow") return intensity * (0.75 + 0.25 * Math.sin((time / props.life) * Math.PI * 2));
	return 0;
}

function drawTrail(graphics: Graphics, parts: EffectParts, item: SceneItem<BoardEffectItem>, context: BoardRenderContext, color: number) {
	const target = item.props.follow ? context.scene.get(item.props.follow) : undefined;
	const time = context.time;
	if (!target) {
		parts.trail.length = 0;
		return;
	}
	const angle = item.frame.rotation * Math.PI / 180;
	const localPoint = (frame: typeof target.frame, t: number) => {
		const dx = frame.x + frame.width / 2 - item.frame.x - item.frame.width / 2;
		const dy = frame.y + frame.height / 2 - item.frame.y - item.frame.height / 2;
		const x = dx * Math.cos(angle) + dy * Math.sin(angle);
		return { x: (item.frame.mirrored ? -x : x) + item.frame.width / 2, y: -dx * Math.sin(angle) + dy * Math.cos(angle) + item.frame.height / 2, t };
	};
	const head = localPoint(target.frame, time);
	if (context.frameAt) {
		parts.trail.length = 0;
		const start = Math.max(0, time - item.props.life);
		const step = Math.max(1000 / 30, item.props.life / (TRAIL_SAMPLES - 1));
		for (let t = Math.ceil(start / step) * step; t < time; t += step) {
			const past = context.frameAt(target.id, t);
			if (past) parts.trail.push(localPoint(past, t));
		}
		parts.trail.push(head);
	}
	const last = parts.trail.at(-1);
	if (last && (time < last.t || time - last.t > item.props.life)) parts.trail.length = 0;
	if (!last || Math.hypot(head.x - last.x, head.y - last.y) > 0.5) parts.trail.push(head);
	while (parts.trail.length > TRAIL_SAMPLES || (parts.trail[0] && time - (parts.trail[0] as { t: number }).t > item.props.life)) parts.trail.shift();
	for (let index = 1; index < parts.trail.length; index += 1) {
		const a = parts.trail[index - 1] as { x: number; y: number; t: number };
		const b = parts.trail[index] as { x: number; y: number; t: number };
		const fade = 1 - (time - b.t) / item.props.life;
		graphics
			.moveTo(a.x, a.y)
			.lineTo(b.x, b.y)
			.stroke({ color, width: item.props.particleSize * fade, alpha: fade * Math.min(1, item.props.intensity), cap: "round" });
	}
}

function sync(container: Container, item: SceneItem<BoardEffectItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const { props } = item;
	const paint = item.style.fill ?? item.style.stroke;
	const color = itemColor(context, paint, "brand", "fill");
	const time = Math.max(0, context.time);
	parts.body.alpha = itemAlpha(context, paint);
	parts.moving.clear();
	const emits = props.kind === "particles" || props.kind === "impact";
	if (emits) {
		const emission: Emission = {
			props,
			seed: hashString(props.seed ?? item.id),
			shape: props.shape ?? "circle",
			colors: props.colors?.map((entry) => itemColor(context, entry, "brand", "fill")) ?? [color],
		};
		const slots = syncParticles(parts, emission, width, height);
		if (props.kind === "particles") emitParticles(slots, emission, width, height, time);
		else emitImpact(slots, parts.moving, emission, width, height, time, color);
	} else if (parts.particles) {
		parts.particles.destroy();
		parts.particles = null;
		parts.shape = null;
	}
	if (props.kind === "flash" || props.kind === "glow") drawStill(parts, props, width, height, color);
	parts.still.visible = props.kind === "flash" || props.kind === "glow";
	parts.still.alpha = stillAlpha(props, time);
	if (props.kind === "trail") drawTrail(parts.moving, parts, item, context, color);
}

export const effectCardRenderer: BoardCardRenderer = {
	id: "effect-card",
	canRender: (item) => item.type === "effect",
	animated: true,
	create: (item, context) => {
		const root = new Container();
		const body = root.addChild(new Container());
		const still = body.addChild(new Graphics());
		const moving = body.addChild(new Graphics());
		partsByContainer.set(root, { root, body, still, stillKey: "", moving, particles: null, shape: null, trail: [] });
		if (item.type === "effect") sync(root, item as SceneItem<BoardEffectItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "effect") sync(container, item as SceneItem<BoardEffectItem>, context);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "effect") return;
		drawFarPlate(graphics, item.frame, { fill: itemColor(context, item.style.fill, "brand", "fill"), fillAlpha: 0.08 });
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
