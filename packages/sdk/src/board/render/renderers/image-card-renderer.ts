import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { BoardImageItem, } from "@cohub/protocol";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type ImageParts = {
	root: Container;
	sprite: Sprite;
	placeholder: Graphics;
	sig: string;
};

const partsByContainer = new WeakMap<Container, ImageParts>();
const RADIUS = 2;

function layoutContain(sprite: Sprite, width: number, height: number) {
	const texture = sprite.texture;
	const tw = texture.width;
	const th = texture.height;
	if (!tw || !th) return;
	const scale = Math.min(width / tw, height / th);
	sprite.width = tw * scale;
	sprite.height = th * scale;
	sprite.x = (width - sprite.width) / 2;
	sprite.y = (height - sprite.height) / 2;
}

function sync(
	container: Container,
	item: SceneItem<BoardImageItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const failed = Boolean(key && !texture && context.hasError(key));
	const texId = texture ? `${texture.width}x${texture.height}` : "none";
	const sig = [
		key ?? "",
		width,
		height,
		selected,
		hovered,
		texId,
		failed,
		context.colorScheme,
	].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	if (texture && parts.sprite.texture !== texture) {
		parts.sprite.texture = texture;
	}
	parts.sprite.visible = Boolean(texture);
	if (texture) layoutContain(parts.sprite, width, height);

	parts.placeholder.clear();
	if (!texture) {
		parts.placeholder
			.roundRect(0, 0, width, height, RADIUS)
			.fill({ color: context.palette.surface, alpha: 0.85 })
			.roundRect(0, 0, width, height, RADIUS)
			.stroke({
				color: failed ? context.palette.border : context.palette.hover,
				width: 1,
				alpha: 0.9,
			});
		const cx = width / 2;
		const cy = height / 2;
		if (failed) {
			parts.placeholder
				.moveTo(cx - 10, cy - 10)
				.lineTo(cx + 10, cy + 10)
				.moveTo(cx + 10, cy - 10)
				.lineTo(cx - 10, cy + 10)
				.stroke({ color: context.palette.muted, width: 1.5, alpha: 0.8 });
		} else {
			parts.placeholder
				.circle(cx, cy, 6)
				.stroke({ color: context.palette.muted, width: 1.25, alpha: 0.55 });
		}
	}
	parts.placeholder.visible = !texture;

	if (selected || hovered) {
		const hasPixels = Boolean(texture) && parts.sprite.width > 0;
		const ox = hasPixels ? parts.sprite.x : 0;
		const oy = hasPixels ? parts.sprite.y : 0;
		const ow = hasPixels ? parts.sprite.width : width;
		const oh = hasPixels ? parts.sprite.height : height;
		parts.placeholder.visible = true;
		parts.placeholder.roundRect(ox, oy, ow, oh, RADIUS).stroke({
			color: selected ? context.palette.brand : context.palette.muted,
			width: selected ? 2 : 1,
			alpha: selected ? 0.95 : 0.7,
		});
	}
}

export const imageCardRenderer: BoardCardRenderer = {
	id: "image-card",
	canRender: (item) => item.type === "image",
	create: (item, context) => {
		const root = new Container();
		const sprite = new Sprite(Texture.EMPTY);
		const placeholder = new Graphics();
		const mask = new Graphics();
		const maskBox = () => {
			mask.clear();
			if (item.type === "image") {
				mask
					.roundRect(0, 0, item.frame.width, item.frame.height, RADIUS)
					.fill({ color: 0xffffff });
			}
		};
		maskBox();
		root.addChild(placeholder, sprite, mask);
		sprite.mask = mask;
		partsByContainer.set(root, { root, sprite, placeholder, sig: "" });
		if (item.type === "image") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type !== "image") return;
		const parts = partsByContainer.get(container);
		if (!parts) return;
		const mask = parts.root.children.find(
			(child) => child !== parts.sprite && child !== parts.placeholder,
		) as Graphics | undefined;
		if (mask) {
			mask
				.clear()
				.roundRect(0, 0, item.frame.width, item.frame.height, RADIUS)
				.fill({ color: 0xffffff });
		}
		sync(container, item, context);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.hover,
			fillAlpha: 0.9,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};

export function isImageItem(item: BoardSceneItem): item is SceneItem<BoardImageItem> {
	return item.type === "image";
}
