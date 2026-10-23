import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import { Container, Graphics } from "pixi.js";
import type { BoardImageItem } from "@cohub/protocol";
import { type CardCrop, cardElevation, containRect, drawCardSurface, fillCardPicture } from "../surface.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate, farPictureTone } from "./far-plate.js";

type ImageParts = {
	root: Container;
	placeholder: Graphics;
	picture: Graphics;
	sig: string;
	textured: boolean;
	/** When a picture that arrived after its placeholder was shown began fading in. */
	fadeFrom: number | null;
	clearSurface: boolean;
};

const partsByContainer = new WeakMap<Container, ImageParts>();

function cropRect(crop: BoardImageItem["props"]["crop"]): CardCrop | null {
	if (!crop) return null;
	const w = Math.min(crop.w, 1 - crop.x);
	const h = Math.min(crop.h, 1 - crop.y);
	return w > 0 && h > 0 ? { x: crop.x, y: crop.y, w, h } : null;
}

const PRINT_MARGIN = 6;
const FADE_MS = 160;
const FAR_ALPHA = 0.9;

function sync(
	container: Container,
	item: SceneItem<BoardImageItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const failed = Boolean(key && !texture && context.hasError(key));
	const elevation = cardElevation(context, item.id);
	const sig = [
		key ?? "",
		width,
		height,
		texture?.uid ?? "none",
		JSON.stringify(item.props.crop ?? null),
		failed,
		elevation,
		context.themeKey,
	].join("|");
	if (sig === parts.sig) return;
	if (texture && !parts.textured && parts.sig !== "" && !context.reducedMotion) {
		parts.fadeFrom = performance.now();
		parts.picture.alpha = 0;
	} else if (!texture) {
		parts.fadeFrom = null;
		parts.picture.alpha = 1;
	}
	parts.sig = sig;
	parts.textured = Boolean(texture);

	const crop = cropRect(item.props.crop);
	const framed = context.style.media === "framed";
	const margin = framed ? Math.min(PRINT_MARGIN, width / 8, height / 8) : 0;
	const area = { x: margin, y: margin, width: width - margin * 2, height: height - margin * 2 };
	const fitted = texture
		? containRect(area.width, area.height, texture.width * (crop?.w ?? 1), texture.height * (crop?.h ?? 1))
		: { ...area, x: 0, y: 0 };
	const picture = { x: area.x + fitted.x, y: area.y + fitted.y, width: fitted.width, height: fitted.height };
	const card = framed ? { x: picture.x - margin, y: picture.y - margin, width: picture.width + margin * 2, height: picture.height + margin * 2 } : picture;

	parts.picture.clear();
	if (texture) fillCardPicture(parts.picture, texture, picture, framed ? { corner: "round", radius: 0 } : context.style, crop);

	parts.placeholder.clear();
	parts.clearSurface = !framed;
	if (texture && !framed && parts.fadeFrom === null) return;
	drawCardSurface(parts.placeholder, card, context.style, {
		fill: failed || framed ? context.palette.surface : context.palette.hover,
		fillAlpha: failed || framed ? 1 : FAR_ALPHA,
		border: failed ? context.palette.border : null,
		elevation: texture && !framed ? 0 : elevation,
	});
	if (texture) return;
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

export const imageCardRenderer: BoardCardRenderer = {
	id: "image-card",
	canRender: (item) => item.type === "image",
	create: (item, context) => {
		const root = new Container();
		const placeholder = new Graphics();
		const picture = new Graphics();
		root.addChild(placeholder, picture);
		partsByContainer.set(root, { root, placeholder, picture, sig: "", textured: false, fadeFrom: null, clearSurface: false });
		if (item.type === "image") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "image") sync(container, item, context);
	},
	tick: (container, clock) => {
		const parts = partsByContainer.get(container);
		if (parts?.fadeFrom == null) return null;
		const progress = Math.min(1, Math.max(0, (clock - parts.fadeFrom) / FADE_MS));
		parts.picture.alpha = 1 - (1 - progress) ** 3;
		if (progress < 1) return 16;
		parts.fadeFrom = null;
		if (parts.clearSurface) parts.placeholder.clear();
		return null;
	},
	lod: { kind: "media" },
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: farPictureTone(item, context) ?? context.palette.hover,
			fillAlpha: FAR_ALPHA,
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
