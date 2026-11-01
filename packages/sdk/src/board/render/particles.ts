import type { BoardParticleShape } from "@cohub/protocol";
import { DOMAdapter, ImageSource, Particle, ParticleContainer, type Rectangle, Texture } from "pixi.js";

const EDGE = 64;
const textures = new Map<BoardParticleShape, Texture>();

function trace(context: CanvasRenderingContext2D, shape: BoardParticleShape) {
	const c = EDGE / 2;
	context.beginPath();
	if (shape === "circle") context.arc(c, c, c - 1, 0, Math.PI * 2);
	else if (shape === "square") context.rect(EDGE * 0.12, EDGE * 0.12, EDGE * 0.76, EDGE * 0.76);
	else if (shape === "spark") context.ellipse(c, c, c - 1, EDGE * 0.12, 0, 0, Math.PI * 2);
	else if (shape === "star") {
		for (let index = 0; index < 10; index += 1) {
			const radius = index % 2 ? c * 0.42 : c - 1;
			const angle = (index * Math.PI) / 5 - Math.PI / 2;
			context.lineTo(c + Math.cos(angle) * radius, c + Math.sin(angle) * radius);
		}
	} else {
		context.moveTo(c, EDGE * 0.9);
		context.bezierCurveTo(EDGE * 0.02, EDGE * 0.5, EDGE * 0.18, EDGE * 0.04, c, EDGE * 0.3);
		context.bezierCurveTo(EDGE * 0.82, EDGE * 0.04, EDGE * 0.98, EDGE * 0.5, c, EDGE * 0.9);
	}
	context.closePath();
}

export function boardParticleTexture(shape: BoardParticleShape): Texture {
	let texture = textures.get(shape);
	if (texture && !texture.destroyed) return texture;
	const canvas = DOMAdapter.get().createCanvas(EDGE, EDGE);
	const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	context.fillStyle = "#fff";
	trace(context, shape);
	context.fill();
	texture = new Texture({ source: new ImageSource({ resource: canvas as unknown as HTMLCanvasElement }) });
	textures.set(shape, texture);
	return texture;
}

export function createBoardParticleLayer(shape: BoardParticleShape): ParticleContainer {
	return new ParticleContainer({
		texture: boardParticleTexture(shape),
		dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: false },
	});
}

export function sizeBoardParticleLayer(layer: ParticleContainer, count: number, bounds: Rectangle) {
	const children = layer.particleChildren as Particle[];
	if (children.length !== count) {
		const texture = layer.texture;
		while (children.length < count) children.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5, alpha: 0 }));
		children.length = count;
		layer.update();
	}
	layer.boundsArea = bounds;
}

export type BoardParticleState = { x: number; y: number; size: number; rotation: number; color: number; alpha: number };

export function placeBoardParticle(particle: Particle, state: BoardParticleState) {
	const scale = state.size / EDGE;
	particle.x = state.x;
	particle.y = state.y;
	particle.scaleX = scale;
	particle.scaleY = scale;
	particle.rotation = state.rotation;
	particle.tint = state.color;
	particle.alpha = state.alpha;
}

export function hideBoardParticle(particle: Particle) {
	particle.alpha = 0;
}
