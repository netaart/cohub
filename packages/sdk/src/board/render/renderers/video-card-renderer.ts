import type { BoardSceneItem, SceneItem } from "../../core/scene.js";
import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { BoardVideoItem } from "@cohub/protocol";
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import {
	syncTextResolution,
	syncTextWrapWidth,
	textResolutionForZoom,
} from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type VideoParts = {
	root: Container;
	plate: Graphics;
	sprite: Sprite;
	mask: Graphics;
	chrome: Graphics;
	label: Text;
	sig: string;
	wrapWidth: number;
	resolution: number;
};

const partsByContainer = new WeakMap<Container, VideoParts>();
const RADIUS = 4;

function layoutContain(sprite: Sprite, width: number, height: number) {
	const texture = sprite.texture;
	if (!texture.width || !texture.height) return;
	const scale = Math.min(width / texture.width, height / texture.height);
	sprite.width = texture.width * scale;
	sprite.height = texture.height * scale;
	sprite.x = (width - sprite.width) / 2;
	sprite.y = (height - sprite.height) / 2;
}

function sync(
	container: Container,
	item: SceneItem<BoardVideoItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const resizing = context.resizingIds.has(item.id);
	const title =
		item.props.snapshot?.title ?? item.props.src.split("/").pop() ?? "Video";
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const failed = Boolean(key && !texture && context.hasError(key));

	syncTextResolution(parts.label, parts, context.zoom);
	if (parts.label.text !== title) parts.label.text = title;
	syncTextWrapWidth(parts.label, parts, Math.max(1, width - 16), resizing);
	parts.label.position.set(8, Math.max(8, height - parts.label.height - 8));

	const sig = [
		key ?? "",
		texture ? `${texture.width}x${texture.height}` : "none",
		width,
		height,
		selected,
		hovered,
		failed,
		title,
		parts.label.height,
		context.palette.surface,
		context.palette.brand,
		context.palette.muted,
		context.palette.border,
		context.palette.hover,
		context.palette.text,
	].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	if (texture && parts.sprite.texture !== texture) parts.sprite.texture = texture;
	parts.sprite.visible = Boolean(texture);
	if (texture) layoutContain(parts.sprite, width, height);

	parts.mask
		.clear()
		.roundRect(0, 0, width, height, RADIUS)
		.fill({ color: 0xffffff });
	parts.plate
		.clear()
		.roundRect(0, 0, width, height, RADIUS)
		.fill({ color: context.palette.surface, alpha: 0.96 });

	parts.chrome.clear();
	if (texture) {
		const bandHeight = Math.min(height, parts.label.height + 16);
		parts.chrome
			.rect(0, height - bandHeight, width, bandHeight)
			.fill({ color: context.palette.surface, alpha: 0.78 });
	}

	const cx = width / 2;
	const cy = height / 2;
	const radius = Math.min(22, Math.min(width, height) * 0.18);
	parts.chrome.circle(cx, cy, radius).fill({
		color: selected ? context.palette.brand : context.palette.surface,
		alpha: texture ? 0.88 : 0.96,
	});
	const triangle = radius * 0.55;
	parts.chrome
		.moveTo(cx - triangle * 0.35, cy - triangle * 0.6)
		.lineTo(cx - triangle * 0.35, cy + triangle * 0.6)
		.lineTo(cx + triangle * 0.7, cy)
		.closePath()
		.fill({ color: context.palette.text, alpha: 0.94 });
	parts.chrome.roundRect(0, 0, width, height, RADIUS).stroke({
		color: selected
			? context.palette.brand
			: hovered
				? context.palette.muted
				: context.palette.border,
		width: selected ? 2 : 1,
		alpha: selected ? 0.95 : 0.85,
	});
	parts.label.style.fill = texture
		? context.palette.text
		: context.palette.muted;
}

export const videoCardRenderer: BoardCardRenderer = {
	id: "video-card",
	canRender: (item) => item.type === "video",
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const sprite = new Sprite(Texture.EMPTY);
		const mask = new Graphics();
		const chrome = new Graphics();
		const resolution = textResolutionForZoom(context.zoom);
		const label = new Text({
			text: "",
			style: {
				fill: context.palette.muted,
				fontFamily: BOARD_FONT_STACK,
				fontSize: 12,
				fontWeight: "500",
				wordWrap: true,
			},
			resolution,
			roundPixels: true,
		});
		root.addChild(plate, sprite, mask, chrome, label);
		sprite.mask = mask;
		partsByContainer.set(root, {
			root,
			plate,
			sprite,
			mask,
			chrome,
			label,
			sig: "",
			wrapWidth: 0,
			resolution,
		});
		if (item.type === "video") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "video") sync(container, item, context);
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
