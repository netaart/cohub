import type { BoardParticleShape } from "@cohub/protocol";
import { Container, type Particle, type ParticleContainer, Rectangle } from "pixi.js";
import type { WorldPoint } from "../model/geometry.js";
import { createBoardParticleLayer, placeBoardParticle, sizeBoardParticleLayer } from "../render/particles.js";

export type BoardBurst = { at: WorldPoint; shape: BoardParticleShape; colors: readonly number[] };

const LIFE_MS = 1_200;
const SPARKS = 9;
const MAX_BURSTS = 24;
const HERO_SIZE = 30;
const SPARK_SIZE = 11;
const BOUNDS = new Rectangle(-1e9, -1e9, 2e9, 2e9);

type Live = BoardBurst & { start: number; seed: number; reduced: boolean };

function random(seed: number, index: number): number {
	const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
	return x - Math.floor(x);
}

export function createBoardBursts() {
	const container = new Container({ label: "board-bursts" });
	const layers = new Map<BoardParticleShape, ParticleContainer>();
	let live: Live[] = [];
	let seed = 0;

	function layer(shape: BoardParticleShape): ParticleContainer {
		let found = layers.get(shape);
		if (!found) {
			found = container.addChild(createBoardParticleLayer(shape));
			layers.set(shape, found);
		}
		return found;
	}

	return {
		container,
		add(burst: BoardBurst, now: number, reducedMotion: boolean) {
			seed += 1;
			live.push({ ...burst, start: now, seed, reduced: reducedMotion });
			if (live.length > MAX_BURSTS) live = live.slice(-MAX_BURSTS);
		},
		tick(now: number, zoom: number): boolean {
			live = live.filter((burst) => now - burst.start < LIFE_MS);
			const scale = 1 / Math.max(zoom, 1e-4);
			const counts = new Map<BoardParticleShape, number>();
			for (const burst of live) counts.set(burst.shape, (counts.get(burst.shape) ?? 0) + (burst.reduced ? 1 : SPARKS + 1));
			for (const [shape, count] of counts) sizeBoardParticleLayer(layer(shape), count, BOUNDS);
			for (const [shape, entry] of layers) if (!counts.has(shape)) sizeBoardParticleLayer(entry, 0, BOUNDS);
			const used = new Map<BoardParticleShape, number>();
			for (const burst of live) {
				const slots = layer(burst.shape).particleChildren as Particle[];
				let index = used.get(burst.shape) ?? 0;
				const elapsed = Math.max(0, now - burst.start);
				const t = elapsed / LIFE_MS;
				const seconds = elapsed / 1000;
				const fade = 1 - t * t;
				const pop = Math.min(1, t * 6) * (1 + 0.25 * Math.sin(Math.min(1, t * 3) * Math.PI));
				placeBoardParticle(slots[index++] as Particle, {
					x: burst.at.x,
					y: burst.at.y - (burst.reduced ? 0 : 70 * (1 - (1 - t) ** 3)) * scale,
					size: HERO_SIZE * pop * scale,
					rotation: burst.reduced ? 0 : 0.25 * Math.sin(seconds * 8) * (1 - t),
					color: burst.colors[0] ?? 0xffffff,
					alpha: fade,
				});
				if (!burst.reduced) {
					for (let spark = 0; spark < SPARKS; spark += 1) {
						const angle = -Math.PI / 2 + (random(burst.seed, spark) - 0.5) * Math.PI * 1.4;
						const speed = 140 + random(burst.seed, spark + 31) * 160;
						placeBoardParticle(slots[index++] as Particle, {
							x: burst.at.x + Math.cos(angle) * speed * seconds * scale,
							y: burst.at.y + (Math.sin(angle) * speed * seconds + 260 * seconds * seconds) * scale,
							size: SPARK_SIZE * (0.6 + random(burst.seed, spark + 7) * 0.8) * scale,
							rotation: random(burst.seed, spark + 13) * Math.PI * 2 + seconds * 6,
							color: burst.colors[spark % burst.colors.length] ?? 0xffffff,
							alpha: fade * 0.9,
						});
					}
				}
				used.set(burst.shape, index);
			}
			return live.length > 0;
		},
		destroy() {
			container.destroy({ children: true });
			layers.clear();
			live = [];
		},
	};
}
