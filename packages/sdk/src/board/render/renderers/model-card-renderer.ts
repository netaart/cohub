import type { BoardFileItem } from "@cohub/protocol";
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { fileMetaLine, fileStem } from "../../model/file-preview.js";
import { isBoardModelItem } from "../../model/media.js";
import type { SceneItem } from "../../model/scene.js";
import { type CardTag, createCardTag, syncCardTag, traceCube, zoomCardTag } from "../card-tag.js";
import { cardElevation, containRect, drawCardSurface } from "../surface.js";
import { boardCardDetailed } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";
import { drawModelKey } from "./media-key.js";

type ModelParts = {
	root: Container;
	plate: Graphics;
	sprite: Sprite;
	chrome: Graphics;
	tag: CardTag;
	sig: string;
};

const partsByContainer = new WeakMap<Container, ModelParts>();
const INSET_RATIO = 0.06;
const KEY_RADIUS = 14;
const KEY_MARGIN = 10;

export function modelKeyCenter(width: number, height: number) {
	const radius = Math.max(8, Math.min(KEY_RADIUS, Math.min(width, height) * 0.12));
	const margin = Math.min(KEY_MARGIN, radius * 0.7);
	return { x: width - margin - radius, y: height - margin - radius, radius };
}

function sync(container: Container, item: SceneItem<BoardFileItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const { src, snapshot } = item.props;
	const meta = fileMetaLine(src, snapshot?.size);
	const title = snapshot?.title || fileStem(src);
	syncCardTag(parts.tag, { glyph: "model", text: `${title} · ${meta}`, width }, context);

	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const failed = Boolean(key && !texture && context.hasError(key));
	const detailed = boardCardDetailed(context.zoom);
	const elevation = cardElevation(context, item.id);
	const sig = [
		key ?? "",
		texture?.uid ?? "none",
		failed,
		width,
		height,
		elevation,
		detailed,
		context.themeKey,
	].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	drawCardSurface(parts.plate.clear(), { x: 0, y: 0, width, height }, context.style, {
		fill: context.palette.surface,
		border: context.palette.border,
		borderAlpha: 0.85,
		elevation,
	});

	if (texture && parts.sprite.texture !== texture) parts.sprite.texture = texture;
	parts.sprite.visible = Boolean(texture);
	if (texture) {
		const inset = Math.min(width, height) * INSET_RATIO;
		const fitted = containRect(width - inset * 2, height - inset * 2, texture.width, texture.height);
		parts.sprite.position.set(inset + fitted.x, inset + fitted.y);
		parts.sprite.width = fitted.width;
		parts.sprite.height = fitted.height;
	} else {
		const radius = Math.max(6, Math.min(28, Math.min(width, height) * 0.14));
		traceCube(parts.plate, width / 2, height / 2, radius).stroke({
			color: context.palette.muted,
			width: 1.5,
			alpha: failed ? 0.35 : 0.6,
			join: "round",
			cap: "round",
		});
	}

	parts.chrome.clear();
	if (detailed) {
		const center = modelKeyCenter(width, height);
		drawModelKey(parts.chrome, center.x, center.y, center.radius, context);
	}
}

export const modelCardRenderer: BoardCardRenderer = {
	id: "model-card",
	canRender: (item) => isBoardModelItem(item),
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const sprite = new Sprite(Texture.EMPTY);
		const chrome = new Graphics();
		const tag = createCardTag();
		root.addChild(plate, sprite, chrome, tag.root);
		partsByContainer.set(root, { root, plate, sprite, chrome, tag, sig: "" });
		if (item.type === "file") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "file") sync(container, item, context);
	},
	resolution: (container, item, context) => {
		if (item.type === "file") sync(container, item, context);
	},
	zoom: (container, zoom) => {
		const tag = partsByContainer.get(container)?.tag;
		if (tag) zoomCardTag(tag, zoom);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.surface,
			fillAlpha: 0.96,
			accent: context.palette.legendary,
			accentAlpha: 0.45,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
