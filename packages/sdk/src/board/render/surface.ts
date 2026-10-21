import { type Graphics, Matrix, type Texture } from "pixi.js";
import { type WorldPoint, worldPoint } from "../model/geometry.js";
import { roundRectPoints } from "./stroke.js";
import type { BoardRenderStyle, BoardShadowStyle } from "./style.js";

export const PIXEL_STEP = 2;

const SHADOW_LAYERS = 5;

export type CardRect = { x: number; y: number; width: number; height: number };

export function traceCardOutline(
	graphics: Graphics,
	rect: CardRect,
	style: Pick<BoardRenderStyle, "corner" | "radius">,
	grow = 0,
): Graphics {
	const x = rect.x - grow;
	const y = rect.y - grow;
	const width = Math.max(0, rect.width + grow * 2);
	const height = Math.max(0, rect.height + grow * 2);
	if (style.corner === "pixel") return tracePixelRect(graphics, x, y, width, height, PIXEL_STEP);
	const radius = Math.min(Math.max(0, style.radius + grow), width / 2, height / 2);
	return radius > 0 ? graphics.roundRect(x, y, width, height, radius) : graphics.rect(x, y, width, height);
}

export type CardCrop = { x: number; y: number; w: number; h: number };

export function fillCardPicture(
	graphics: Graphics,
	texture: Texture,
	picture: CardRect,
	style: Pick<BoardRenderStyle, "corner" | "radius">,
	crop?: CardCrop | null,
): Graphics {
	// Pixi moves clamped textures to repeat for fills; mirroring keeps edge texels from wrapping.
	const sampling = texture.source.style;
	if (sampling.addressMode !== "mirror-repeat") {
		sampling.addressMode = "mirror-repeat";
		sampling.update();
	}
	const matrix = crop ? new Matrix(1 / crop.w, 0, 0, 1 / crop.h, -crop.x / crop.w, -crop.y / crop.h) : undefined;
	return traceCardOutline(graphics, picture, style).fill({ texture, textureSpace: "local", ...(matrix ? { matrix } : {}) });
}

export function tracePixelRect(
	graphics: Graphics,
	x: number,
	y: number,
	width: number,
	height: number,
	step: number,
): Graphics {
	const s = Math.min(step, width / 4, height / 4);
	if (s <= 0) return graphics.rect(x, y, width, height);
	return graphics.poly(pixelRectPoints(x, y, width, height, s).flatMap((point) => [point.x, point.y]));
}

function pixelRectPoints(x: number, y: number, width: number, height: number, s: number): WorldPoint[] {
	const r = x + width;
	const b = y + height;
	const p = worldPoint;
	return [
		p(x, y + s * 2), p(x + s, y + s * 2), p(x + s, y + s), p(x + s * 2, y + s), p(x + s * 2, y),
		p(r - s * 2, y), p(r - s * 2, y + s), p(r - s, y + s), p(r - s, y + s * 2), p(r, y + s * 2),
		p(r, b - s * 2), p(r - s, b - s * 2), p(r - s, b - s), p(r - s * 2, b - s), p(r - s * 2, b),
		p(x + s * 2, b), p(x + s * 2, b - s), p(x + s, b - s), p(x + s, b - s * 2), p(x, b - s * 2),
	];
}

export function cardOutlinePoints(
	rect: CardRect,
	style: Pick<BoardRenderStyle, "corner" | "radius">,
	grow = 0,
): WorldPoint[] {
	const x = rect.x - grow;
	const y = rect.y - grow;
	const width = Math.max(0, rect.width + grow * 2);
	const height = Math.max(0, rect.height + grow * 2);
	if (style.corner === "pixel") {
		const s = Math.min(PIXEL_STEP, width / 4, height / 4);
		const points = pixelRectPoints(x, y, width, height, Math.max(0, s));
		return [...points, points[0] as WorldPoint];
	}
	const radius = Math.min(Math.max(0, style.radius + grow), width / 2, height / 2);
	return roundRectPoints(width, height, radius).map((point) => worldPoint(point.x + x, point.y + y));
}

export function drawCardShadow(
	graphics: Graphics,
	rect: CardRect,
	style: Pick<BoardRenderStyle, "corner" | "radius">,
	shadow: BoardShadowStyle | null,
) {
	if (!shadow || shadow.alpha <= 0 || shadow.blur <= 0) return;
	const offset = { ...rect, y: rect.y + shadow.y };
	const reach = (index: number) => (1 - index / SHADOW_LAYERS) ** 2;
	for (let index = SHADOW_LAYERS; index >= 1; index -= 1) {
		const alpha = shadow.alpha * (reach(index - 1) - reach(index));
		traceCardOutline(graphics, offset, style, (shadow.blur * index) / SHADOW_LAYERS).fill({ color: shadow.color, alpha });
		// Cut out covered pixels to avoid overdraw beneath every card.
		traceCardOutline(graphics, rect, style).cut();
	}
}

export type CardSurface = {
	fill: number;
	fillAlpha?: number;
	border?: number | null;
	borderAlpha?: number;
	elevation?: CardElevation;
};

export type CardElevation = 0 | 1 | 2;

export function cardShadow(style: BoardRenderStyle, elevation: CardElevation): BoardShadowStyle | null {
	const shadow = style.shadow;
	if (!shadow || elevation === 0) return null;
	if (elevation === 1) return shadow;
	return { ...shadow, alpha: Math.min(1, shadow.alpha * 1.6), blur: shadow.blur * 1.6, y: shadow.y * 2 + 4 };
}

export function drawCardSurface(
	graphics: Graphics,
	rect: CardRect,
	style: BoardRenderStyle,
	surface: CardSurface,
): Graphics {
	drawCardShadow(graphics, rect, style, cardShadow(style, surface.elevation ?? 0));
	traceCardOutline(graphics, rect, style).fill({ color: surface.fill, alpha: surface.fillAlpha ?? 1 });
	if (surface.border != null) {
		traceCardOutline(graphics, rect, style).stroke({
			color: surface.border,
			width: 1,
			alpha: surface.borderAlpha ?? 1,
			alignment: 1,
		});
	}
	return graphics;
}

export function containRect(width: number, height: number, imageWidth: number, imageHeight: number): CardRect {
	if (width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0) return { x: 0, y: 0, width: 0, height: 0 };
	const scale = Math.min(width / imageWidth, height / imageHeight);
	return {
		x: (width - imageWidth * scale) / 2,
		y: (height - imageHeight * scale) / 2,
		width: imageWidth * scale,
		height: imageHeight * scale,
	};
}

const FREE_FORM_TYPES = new Set(["text", "shape", "draw", "arrow", "frame", "effect", "custom"]);

export function cardElevation(context: { liftedIds: ReadonlySet<string> }, id: string): CardElevation {
	return context.liftedIds.has(id) ? 2 : 1;
}

export function isBoardCard(item: { type: string }): boolean {
	return !FREE_FORM_TYPES.has(item.type);
}
