import type {
	BoardAssetRef,
	BoardDocument,
	BoardSceneItem,
	WorldPoint,
} from "@neta-art/cohub/board";
import {
	createBoardRegistry,
	defineBoardItem,
	parseBoardDocument,
} from "@neta-art/cohub/board";
import {
	type BoardCardRenderer,
	type BoardRenderContext,
	cardElevation,
	drawCardSurface,
	drawFarPlate,
	farPictureTone,
	fillCardPicture,
	syncTextResolution,
} from "@neta-art/cohub/board/render";
import { Container, Graphics, Text } from "pixi.js";

export const DEV_CARD = "dev.card";
export const LIKE = "like";

export const devRegistry = createBoardRegistry([
	defineBoardItem({
		type: DEV_CARD,
		activation: "tap",
		capabilities: { canRotate: false, aspectLocked: true },
	}),
]);

type DevCardProps = { title?: string; cover?: string; liked?: boolean };

const props = (item: BoardSceneItem) => item.props as DevCardProps;
const COVER = 0.72;
const KEY = 32;

export function devItemAsset(
	item: BoardSceneItem,
): BoardAssetRef | null | undefined {
	if (item.type !== DEV_CARD) return undefined;
	const cover = props(item).cover;
	return cover ? { src: cover, fit: "cover" } : null;
}

function keyRect(width: number) {
	return { x: width - KEY - 8, y: 8, width: KEY, height: KEY };
}

function coverCrop(textureAspect: number, boxAspect: number) {
	const r = boxAspect / textureAspect;
	return r > 1
		? { x: 0, y: (1 - 1 / r) / 2, w: 1, h: 1 / r }
		: { x: (1 - r) / 2, y: 0, w: r, h: 1 };
}

type Parts = { plate: Graphics; title: Text; like: Text };
const partsOf = new WeakMap<Container, Parts>();

function sync(
	container: Container,
	item: BoardSceneItem,
	context: BoardRenderContext,
) {
	const parts = partsOf.get(container);
	if (!parts) return;
	const { x, y, width, height } = item.frame;
	container.position.set(x, y);
	const band = height * COVER;
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	parts.plate.clear();
	drawCardSurface(parts.plate, { x: 0, y: 0, width, height }, context.style, {
		fill: context.palette.surface,
		border: context.palette.border,
		elevation: cardElevation(context, item.id),
	});
	if (texture) {
		const crop = coverCrop(texture.width / texture.height, width / band);
		fillCardPicture(
			parts.plate,
			texture,
			{ x: 0, y: 0, width, height: band },
			context.style,
			crop,
		);
	}
	parts.title.text = props(item).title ?? "";
	parts.title.style.fill = context.palette.text;
	parts.title.style.fontFamily = context.style.font;
	parts.title.style.wordWrapWidth = width - 24;
	parts.title.position.set(12, band + 10);
	const hovered = context.hoveredHit?.itemId === item.id;
	parts.like.text = props(item).liked ? "♥" : "♡";
	parts.like.style.fill =
		hovered || props(item).liked
			? context.palette.brand
			: context.palette.muted;
	const rect = keyRect(width);
	parts.like.position.set(rect.x + rect.width / 2, rect.y + rect.height / 2);
	for (const text of [parts.title, parts.like])
		syncTextResolution(text, context.textResolution);
}

export const devCardRenderer: BoardCardRenderer = {
	id: "dev-card",
	canRender: (item) => item.type === DEV_CARD,
	lod: { kind: "media" },
	create(item, context) {
		const container = new Container();
		const plate = new Graphics();
		const title = new Text({
			text: "",
			style: { fontSize: 18, fontWeight: "600", wordWrap: true },
			roundPixels: true,
		});
		const like = new Text({
			text: "",
			style: { fontSize: 24 },
			anchor: 0.5,
			roundPixels: true,
		});
		container.addChild(plate, title, like);
		partsOf.set(container, { plate, title, like });
		sync(container, item, context);
		return container;
	},
	update: sync,
	resolution(container, _item, context) {
		const parts = partsOf.get(container);
		if (parts)
			for (const text of [parts.title, parts.like])
				syncTextResolution(text, context.textResolution);
	},
	hitAt(item, point: WorldPoint) {
		const rect = keyRect(item.frame.width);
		const x = point.x - item.frame.x - rect.x;
		const y = point.y - item.frame.y - rect.y;
		return x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
			? { action: LIKE }
			: null;
	},
	renderFar(graphics, item, context) {
		drawFarPlate(graphics, item.frame, {
			fill: farPictureTone(item, context) ?? context.palette.surface,
		});
	},
	destroy(container) {
		partsOf.delete(container);
		container.destroy({ children: true });
	},
};

function cover(hue: number): string {
	const canvas = document.createElement("canvas");
	canvas.width = 480;
	canvas.height = 360;
	const context = canvas.getContext("2d");
	if (!context) return "";
	const gradient = context.createLinearGradient(0, 0, 480, 360);
	gradient.addColorStop(0, `hsl(${hue} 70% 62%)`);
	gradient.addColorStop(1, `hsl(${hue + 50} 70% 38%)`);
	context.fillStyle = gradient;
	context.fillRect(0, 0, 480, 360);
	return canvas.toDataURL("image/png");
}

export function devHostDocument(): BoardDocument {
	const cards = ["Harbor", "Lantern", "Orchard", "Comet"].map(
		(title, index) => [
			`card-${index}`,
			{
				type: DEV_CARD,
				position: { x: index * 300, y: 0 },
				size: { width: 260, height: 300 },
				props: { title, cover: cover(index * 70) },
			},
		],
	);
	const parsed = parseBoardDocument({
		board: {},
		items: {
			...Object.fromEntries(cards),
			title: {
				type: "text",
				position: { x: 0, y: -90 },
				props: {
					text: "Tap a card, hold it on touch, or press ♡",
					fontSize: 24,
				},
			},
			unknown: {
				type: "dev.note",
				position: { x: 1200, y: 0 },
				size: { width: 260, height: 180 },
				props: { body: "Only this host knows dev.note" },
				preview: {
					title: "A note from another app",
					excerpt: "Clients without a renderer for dev.note show its preview.",
				},
			},
		},
		animations: {},
	});
	if (!parsed.ok)
		throw new Error(
			parsed.diagnostics.map((entry) => entry.message).join("; "),
		);
	return parsed.document;
}
