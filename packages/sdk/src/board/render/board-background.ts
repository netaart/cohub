import { Container, Graphics, RenderTexture, TilingSprite, type Application } from "pixi.js";
import type { BoardSettings } from "@cohub/protocol";
import type { BoardViewport } from "../model/geometry.js";
import type { BoardRenderPalette } from "./renderers/board-renderer-registry.js";
import { parseBoardCssColor } from "./css-color.js";

export type BoardBackgroundContext = {
	app: Application;
	settings: BoardSettings;
	viewport: BoardViewport;
	colorScheme: "dark" | "light";
	palette: BoardRenderPalette;
	hasImageBackground?: boolean;
};

type GridParts = {
	fill: Graphics;
	sprite: TilingSprite | null;
	textureKey: string;
	lastWidth: number;
	lastHeight: number;
	lastBg: number;
	lastBgAlpha: number;
};

const partsByContainer = new WeakMap<Container, GridParts>();

function wrap(value: number, period: number) {
	return ((value % period) + period) % period;
}

function buildGridTexture(
	context: BoardBackgroundContext,
	size: number,
	color: number,
	opacity: number,
	kind: "dots" | "grid",
): RenderTexture {
	const graphics = new Graphics();
	if (kind === "grid") {
		graphics
			.moveTo(0, 0.5)
			.lineTo(size, 0.5)
			.moveTo(0.5, 0)
			.lineTo(0.5, size)
			.stroke({ color, width: 1, alpha: opacity });
	} else {
		graphics.circle(0.5, 0.5, 0.9).fill({ color, alpha: opacity });
	}
	const target = RenderTexture.create({ width: size, height: size });
	context.app.renderer.render({ container: graphics, target });
	graphics.destroy();
	return target;
}

function sync(parts: GridParts, context: BoardBackgroundContext) {
	const { app, settings, viewport, palette } = context;
	const width = app.screen.width;
	const height = app.screen.height;
	const declared = settings.background.color;
	const cssColor = typeof declared === "object" ? declared[context.colorScheme] : declared;
	const bgColor = cssColor ? (parseBoardCssColor(cssColor) ?? palette.bg) : palette.bg;
	const bgAlpha = context.hasImageBackground ? 0 : 1;

	if (
		parts.lastWidth !== width ||
		parts.lastHeight !== height ||
		parts.lastBg !== bgColor ||
		parts.lastBgAlpha !== bgAlpha
	) {
		parts.fill.clear();
		parts.fill.rect(0, 0, width, height).fill({ color: bgColor, alpha: bgAlpha });
		parts.lastWidth = width;
		parts.lastHeight = height;
		parts.lastBg = bgColor;
		parts.lastBgAlpha = bgAlpha;
	}

	const kind = settings.background.kind === "grid" ? "grid" : "dots";
	const visible = settings.grid?.visible === true;
	const size = Math.max(4, settings.grid?.size ?? 24);
	const opacity = 0.12;
	const key = `${kind}|${size}|${palette.border}|${opacity}`;

	if (!visible) {
		if (parts.sprite) parts.sprite.visible = false;
		return;
	}

	if (parts.textureKey !== key || !parts.sprite) {
		if (parts.sprite) {
			const previousTexture = parts.sprite.texture;
			parts.sprite.destroy();
			previousTexture.destroy(true);
		}
		const texture = buildGridTexture(context, size, palette.border, opacity, kind);
		parts.sprite = new TilingSprite({ texture, width, height });
		parts.textureKey = key;
		parts.fill.parent?.addChild(parts.sprite);
	}

	const sprite = parts.sprite;
	if (!sprite) return;
	sprite.visible = true;
	sprite.width = width;
	sprite.height = height;
	const step = size * viewport.zoom;
	sprite.tileScale.set(viewport.zoom);
	sprite.tilePosition.set(wrap(viewport.x, step), wrap(viewport.y, step));
}

export function createBoardBackground(context: BoardBackgroundContext): Container {
	const container = new Container({ label: "board-background" });
	const fill = new Graphics();
	container.addChild(fill);
	partsByContainer.set(container, {
		fill,
		sprite: null,
		textureKey: "",
		lastWidth: -1,
		lastHeight: -1,
		lastBg: Number.NaN,
		lastBgAlpha: Number.NaN,
	});
	sync(partsByContainer.get(container) as GridParts, context);
	return container;
}

export function updateBoardBackground(
	container: Container,
	context: BoardBackgroundContext,
) {
	const parts = partsByContainer.get(container);
	if (parts) sync(parts, context);
}
