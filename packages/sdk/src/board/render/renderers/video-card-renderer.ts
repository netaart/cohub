import { getMediaResourceTitle } from "../../model/media.js";
import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import type { BoardVideoItem } from "@cohub/protocol";
import { Container, Graphics } from "pixi.js";
import { createCardTag, formatBoardDuration, syncCardTag, type CardTag, zoomCardTag } from "../card-tag.js";
import { cardElevation, containRect, drawCardSurface, fillCardPicture } from "../surface.js";
import { boardCardDetailed } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";
import { drawMediaPlayKey } from "./media-key.js";

type VideoParts = {
	root: Container;
	plate: Graphics;
	picture: Graphics;
	chrome: Graphics;
	tag: CardTag;
	sig: string;
};

const partsByContainer = new WeakMap<Container, VideoParts>();
const FILM_RAIL = 10;
const FILM_HOLE = 4;

function videoTitle(item: SceneItem<BoardVideoItem>) {
	return item.props.snapshot?.title ?? getMediaResourceTitle(item.props.src);
}

function sync(container: Container, item: SceneItem<BoardVideoItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const title = videoTitle(item);
	const durationMs = item.props.snapshot?.durationMs;
	const duration = durationMs ? formatBoardDuration(durationMs) : "";
	syncCardTag(parts.tag, { glyph: "video", text: duration ? `${title} · ${duration}` : title, width }, context);

	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const elevation = cardElevation(context, item.id);
	const sig = [
		key ?? "",
		texture?.uid ?? "none",
		width,
		height,
		elevation,
		boardCardDetailed(context.zoom),
		context.themeKey,
	].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	const framed = context.style.media === "framed";
	const rect = { x: 0, y: 0, width, height };
	const rail = framed ? Math.min(FILM_RAIL, height / 6) : 0;
	const screen = { x: framed ? rail * 0.6 : 0, y: rail, width: width - (framed ? rail * 1.2 : 0), height: height - rail * 2 };

	drawCardSurface(parts.plate.clear(), rect, context.style, {
		fill: framed ? context.palette.text : context.palette.surface,
		border: framed ? null : context.palette.border,
		borderAlpha: 0.85,
		elevation,
	});
	if (framed) drawFilmRails(parts.plate, width, height, rail, context.palette.bg);

	parts.picture.clear();
	if (texture) {
		const fitted = containRect(screen.width, screen.height, texture.width, texture.height);
		const picture = { ...fitted, x: screen.x + fitted.x, y: screen.y + fitted.y };
		fillCardPicture(parts.picture, texture, picture, framed ? { corner: "round", radius: 1 } : context.style);
	}

	parts.chrome.clear();
	const detailed = boardCardDetailed(context.zoom);
	if (detailed) drawMediaPlayKey(parts.chrome, screen.x + screen.width / 2, screen.y + screen.height / 2, Math.min(18, Math.min(screen.width, screen.height) * 0.16), context);
}

function drawFilmRails(graphics: Graphics, width: number, height: number, rail: number, hole: number) {
	const size = Math.min(FILM_HOLE, rail * 0.45);
	const step = size * 2.5;
	const count = Math.max(1, Math.floor((width - step) / step));
	const start = (width - (count - 1) * step - size) / 2;
	for (let index = 0; index < count; index += 1) {
		const x = start + index * step;
		graphics.rect(x, (rail - size) / 2, size, size).rect(x, height - rail + (rail - size) / 2, size, size);
	}
	graphics.fill({ color: hole, alpha: 0.9 });
}

export const videoCardRenderer: BoardCardRenderer = {
	id: "video-card",
	canRender: (item) => item.type === "video",
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const picture = new Graphics();
		const chrome = new Graphics();
		const tag = createCardTag();
		root.addChild(plate, picture, chrome, tag.root);
		partsByContainer.set(root, { root, plate, picture, chrome, tag, sig: "" });
		if (item.type === "video") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "video") sync(container, item, context);
	},
	resolution: (container, item, context) => {
		if (item.type === "video") sync(container, item, context);
	},
	zoom: (container, zoom) => {
		const tag = partsByContainer.get(container)?.tag;
		if (tag) zoomCardTag(tag, zoom);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.surface,
			fillAlpha: 0.96,
			accent: context.palette.brand,
			accentAlpha: 0.75,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};

export function isVideoItem(item: BoardSceneItem): item is SceneItem<BoardVideoItem> {
	return item.type === "video";
}
