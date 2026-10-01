
import { Container, Graphics } from "pixi.js";
import type { BoardEffectItem } from "@cohub/protocol";
import type { SceneItem } from "../../core/scene.js";
import { itemColor } from "../palette.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

export const BOARD_EFFECT_MAX_PARTICLES = 4000;
const TRAIL_SAMPLES = 64;

type EffectParts = {
	root: Container;
	graphics: Graphics;
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

function velocity(props: Props, seed: number, index: number) {
	const angle = ((props.direction + (random(seed, index, 1) - 0.5) * props.spread) * Math.PI) / 180;
	const speed = props.speed * (0.7 + random(seed, index, 2) * 0.6);
	return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

function drawParticles(graphics: Graphics, props: Props, width: number, height: number, time: number, seed: number, color: number) {
	const rate = props.rate * props.intensity;
	if (rate <= 0) return;
	const life = props.life;
	const interval = 1000 / rate;
	const newest = Math.floor(time / interval);
	const count = Math.min(BOARD_EFFECT_MAX_PARTICLES, Math.ceil(life / interval));
	for (let index = Math.max(0, newest - count + 1); index <= newest; index += 1) {
		const age = (time - index * interval) / 1000;
		if (age < 0 || age * 1000 > life) continue;
		const progress = (age * 1000) / life;
		const { vx, vy } = velocity(props, seed, index);
		const x = random(seed, index, 3) * width + vx * age;
		const y = random(seed, index, 4) * height + vy * age + 0.5 * props.gravity * age * age;
		const size = props.particleSize * (0.6 + random(seed, index, 5) * 0.8) * (1 - progress * 0.5);
		graphics.circle(x, y, size / 2).fill({ color, alpha: (1 - progress) * Math.min(1, props.intensity) });
	}
}

function drawImpact(graphics: Graphics, props: Props, width: number, height: number, time: number, seed: number, color: number) {
	const life = props.life;
	const cycle = Math.floor(time / life);
	const age = (time - cycle * life) / 1000;
	const progress = (age * 1000) / life;
	const count = Math.min(BOARD_EFFECT_MAX_PARTICLES, Math.round(props.rate * props.intensity));
	const cx = width / 2;
	const cy = height / 2;
	const alpha = (1 - progress) ** 1.5 * Math.min(1, props.intensity);
	const radius = Math.min(width, height) * 0.5 * Math.sqrt(progress);
	graphics.circle(cx, cy, radius).stroke({ color, width: Math.max(1, props.particleSize * (1 - progress)), alpha: alpha * 0.8 });
	const burst = hashString(`${seed}:${cycle}`);
	for (let index = 0; index < count; index += 1) {
		const { vx, vy } = velocity({ ...props, spread: props.spread }, burst, index);
		const x = cx + vx * age;
		const y = cy + vy * age + 0.5 * props.gravity * age * age;
		graphics.circle(x, y, (props.particleSize / 2) * (1 - progress * 0.6)).fill({ color, alpha });
	}
}

function drawFlash(graphics: Graphics, props: Props, width: number, height: number, time: number, color: number) {
	const progress = (time % props.life) / props.life;
	const alpha = (1 - progress) ** 2 * Math.min(1, props.intensity);
	if (alpha <= 0.001) return;
	graphics.rect(0, 0, width, height).fill({ color, alpha });
}

function drawGlow(graphics: Graphics, props: Props, width: number, height: number, time: number, color: number) {
	const pulse = 0.75 + 0.25 * Math.sin((time / props.life) * Math.PI * 2);
	const rings = 12;
	const cx = width / 2;
	const cy = height / 2;
	for (let ring = rings; ring >= 1; ring -= 1) {
		const fraction = ring / rings;
		graphics
			.ellipse(cx, cy, (width / 2) * fraction, (height / 2) * fraction)
			.fill({ color, alpha: (Math.min(1, props.intensity) * pulse * (1 - fraction) * 2) / rings });
	}
}

function drawTrail(graphics: Graphics, parts: EffectParts, item: SceneItem<BoardEffectItem>, context: BoardRenderContext, color: number) {
	const target = item.props.follow ? context.scene.get(item.props.follow) : undefined;
	const time = context.time;
	if (!target) {
		parts.trail.length = 0;
		return;
	}
	const head = { x: target.frame.x + target.frame.width / 2 - item.frame.x, y: target.frame.y + target.frame.height / 2 - item.frame.y, t: time };
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
	const color = itemColor(context, item.style.fill ?? item.style.stroke, "brand", "fill");
	const seed = hashString(props.seed ?? item.id);
	const time = Math.max(0, context.time);
	const graphics = parts.graphics;
	graphics.clear();
	switch (props.kind) {
		case "particles":
			drawParticles(graphics, props, width, height, time, seed, color);
			break;
		case "impact":
			drawImpact(graphics, props, width, height, time, seed, color);
			break;
		case "flash":
			drawFlash(graphics, props, width, height, time, color);
			break;
		case "glow":
			drawGlow(graphics, props, width, height, time, color);
			break;
		case "trail":
			drawTrail(graphics, parts, item, context, color);
			break;
	}
	if (context.selectedIds.has(item.id) || context.hoveredId === item.id) {
		graphics.rect(0, 0, width, height).stroke({ color: context.palette.muted, width: 1, alpha: 0.6 });
	}
}

export const effectCardRenderer: BoardCardRenderer = {
	id: "effect-card",
	canRender: (item) => item.type === "effect",
	animated: true,
	create: (item, context) => {
		const root = new Container();
		const graphics = new Graphics();
		root.addChild(graphics);
		partsByContainer.set(root, { root, graphics, trail: [] });
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
