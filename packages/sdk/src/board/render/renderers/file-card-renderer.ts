import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import {
	BOARD_FONT_STACK,
	BOARD_MONO_FONT_STACK,
} from "@cohub/protocol/board-constants";
import {
	Container,
	Graphics,
	Sprite,
	Text,
	Texture,
} from "pixi.js";
import { boardCardDetailed, syncTextResolution } from "../text-resolution.js";
import type { BoardFileItem, } from "@cohub/protocol";
import {
	fileCategory,
	fileCategoryAccent,
	fileMetaLine,
	filePreviewKind,
	fileStem,
	fileTypeLabel,
} from "../../model/file-preview.js";
import { type CardTag, createCardTag, syncCardTag, zoomCardTag } from "../card-tag.js";
import type { BoardRenderStyle } from "../style.js";
import { type CardRect, cardElevation, containRect, drawCardSurface, traceCardOutline } from "../surface.js";
import { fitTextToLines } from "../text-fit.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

const PADDING = 10;
const COVER_RATIO = 0.56;
const MIN_BODY_FOR_COVER = PADDING * 2 + 18;
const TITLE_SIZE = 13;
const TITLE_LINE = TITLE_SIZE * 1.35;
const TITLE_MAX_LINES = 2;
const EXCERPT_SIZE = 11;
const EXCERPT_LINE = EXCERPT_SIZE * 1.45;
const EXCERPT_MAX_LINES = 3;
const TYPE_MARK_SIZE = 28;
const GAP = 4;
const STRIPE = 2;


const MAX_DASHES = 40;

type FileParts = {
	root: Container;
	plate: Graphics;
	body: Container;
	clip: Graphics;
	cover: Sprite;
	coverMask: Graphics;
	typeMark: Text;
	tag: CardTag;
	title: Text;
	excerpt: Text;
	visualSig: string;
	textSig: string;
};

const partsByContainer = new WeakMap<Container, FileParts>();

function detailFor(zoom: number): "title" | "full" {
	return boardCardDetailed(zoom) ? "full" : "title";
}

function coverHeight(item: SceneItem<BoardFileItem>, height: number): number {
	if (filePreviewKind(item.props.snapshot) !== "cover") return 0;
	const ideal = Math.round(height * COVER_RATIO);
	return Math.max(0, Math.min(ideal, height - MIN_BODY_FOR_COVER));
}

function linesInRoom(room: number, lineHeight: number, max: number): number {
	if (room < lineHeight * 0.85) return 0;
	return Math.max(0, Math.min(max, Math.floor((room + 0.5) / lineHeight)));
}

function layoutCover(
	sprite: Sprite,
	width: number,
	height: number,
	texture: Texture,
) {
	const rect = containRect(width, height, texture.width, texture.height);
	sprite.position.set(rect.x, rect.y);
	sprite.width = rect.width;
	sprite.height = rect.height;
}

function syncClip(parts: FileParts, rect: CardRect, style: BoardRenderStyle) {
	traceCardOutline(parts.clip.clear(), rect, style).fill({ color: 0xffffff });
}

function sync(
	container: Container,
	item: SceneItem<BoardFileItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	syncContent(parts, item, context);
	for (const text of [parts.title, parts.excerpt, parts.typeMark]) syncTextResolution(text, context.textResolution);
}

function syncContent(parts: FileParts, item: SceneItem<BoardFileItem>, context: BoardRenderContext) {
	positionShell(parts.root, item);

	const { width, height } = item.frame;
	const detail = detailFor(context.zoom);
	const elevation = cardElevation(context, item.id);
	syncCardTag(parts.tag, { glyph: "file", text: fileMetaLine(item.props.src, item.props.snapshot?.size), width }, context);
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const coverFailed = Boolean(key && !texture && context.hasError(key));
	const fileState = context.fileState(item.props.src);
	const band = coverHeight(item, height);
	const kind = filePreviewKind(item.props.snapshot);
	const category = fileCategory(item.props.src, item.props.snapshot?.mimeType);
	const accent = fileCategoryAccent(category, context.palette);

	const visualSig = [
		key ?? "",
		width,
		height,
		detail,
		elevation,
		texture?.uid ?? "none",
		coverFailed,
		fileState,
		kind,
		category,
		context.themeKey,
		accent,
	].join("|");

	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;

		const rect = { x: 0, y: 0, width, height };
		syncClip(parts, rect, context.style);
		drawCardSurface(parts.plate.clear(), rect, context.style, {
			fill: context.palette.surface,
			border: context.palette.border,
			borderAlpha: 0.85,
			elevation,
		});

		if (fileState !== "ok") {
			const dash = Math.max(6, width / MAX_DASHES / 2);
			for (let x = 0; x < width; x += dash * 2) {
				parts.plate.moveTo(x, 0.5).lineTo(Math.min(x + dash, width), 0.5);
			}
			parts.plate.stroke({
				color: context.palette.muted,
				width: 2,
				alpha: fileState === "missing" ? 0.9 : 0.5,
			});
		}

		const showCover = band > 0 && Boolean(texture);
		if (band > 0) {
			parts.plate.rect(1, 1, width - 2, band - 1).fill({
				color: context.palette.hover,
				alpha: coverFailed ? 0.35 : 0.6,
			});
		}
		if (showCover && texture) {
			if (parts.cover.texture !== texture) parts.cover.texture = texture;
			layoutCover(parts.cover, width, band, texture);
			parts.coverMask.clear().rect(0, 0, width, band).fill({ color: 0xffffff });
		}
		parts.cover.visible = showCover;
		parts.coverMask.visible = showCover;

		if (!band) {
			parts.plate
				.rect(1, 1, STRIPE, height - 2)
				.fill({ color: accent, alpha: 0.55 });
		}

		parts.excerpt.visible = detail === "full";
		parts.typeMark.visible = kind === "blank";
	}

	const title = item.props.snapshot?.title || fileStem(item.props.src);
	const excerpt = item.props.snapshot?.excerpt ?? "";
	const mark = fileTypeLabel(item.props.src);
	const innerWidth = Math.max(1, width - PADDING * 2);
	const showTypeMark = kind === "blank";
	const textSig = [
		title,
		excerpt,
		mark,
		detail,
		innerWidth,
		band,
		height,
		kind,
		context.palette.text,
		context.palette.muted,
		context.style.font,
		accent,
	].join("|");
	if (textSig === parts.textSig) return;
	parts.textSig = textSig;
	parts.title.style.fontFamily = context.style.font;
	parts.excerpt.style.fontFamily = context.style.font;

	const top = band > 0 ? band + PADDING * 0.8 : PADDING;
	const contentBottom = height - PADDING;

	let cursor = top;
	if (showTypeMark) {
		const markSize = Math.max(
			18,
			Math.min(TYPE_MARK_SIZE, Math.round(height * 0.22)),
		);
		parts.typeMark.style.fill = accent;
		parts.typeMark.style.fontSize = markSize;
		parts.typeMark.style.lineHeight = markSize * 1.1;
		if (parts.typeMark.text !== mark) parts.typeMark.text = mark;
		parts.typeMark.position.set(PADDING, cursor);
		parts.typeMark.visible = true;
		cursor += parts.typeMark.height + GAP;
	} else {
		parts.typeMark.visible = false;
	}

	const titleRoom = Math.max(0, contentBottom - cursor);
	const titleLines = linesInRoom(titleRoom, TITLE_LINE, TITLE_MAX_LINES);
	parts.title.style.fill = context.palette.text;
	fitTextToLines(parts.title, title, titleLines, innerWidth);
	parts.title.position.set(PADDING, cursor);
	parts.title.visible = titleLines > 0;

	if (detail !== "full") {
		parts.excerpt.visible = false;
		return;
	}

	const excerptTop =
		cursor + (titleLines > 0 ? parts.title.height + GAP : 0);
	const excerptRoom = contentBottom - excerptTop;
	const excerptLines = linesInRoom(excerptRoom, EXCERPT_LINE, EXCERPT_MAX_LINES);
	const showExcerpt = Boolean(excerpt) && excerptLines > 0;
	if (showExcerpt) {
		parts.excerpt.style.fill = context.palette.muted;
		fitTextToLines(parts.excerpt, excerpt, excerptLines, innerWidth);
		parts.excerpt.position.set(PADDING, excerptTop);
	}
	parts.excerpt.visible = showExcerpt;
}

export const fileCardRenderer: BoardCardRenderer = {
	id: "file-card",
	canRender: (item) => item.type === "file",
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const body = new Container();
		const clip = new Graphics();
		const cover = new Sprite(Texture.EMPTY);
		const coverMask = new Graphics();
		cover.mask = coverMask;
		const resolution = context.textResolution;

		const title = new Text({
			text: "",
			style: {
				fill: context.palette.text,
				fontFamily: BOARD_FONT_STACK,
				fontSize: TITLE_SIZE,
				fontWeight: "600",
				wordWrap: true,
				breakWords: true,
				lineHeight: TITLE_LINE,
			},
			resolution,
			roundPixels: true,
		});
		const excerpt = new Text({
			text: "",
			style: {
				fill: context.palette.muted,
				fontFamily: BOARD_FONT_STACK,
				fontSize: EXCERPT_SIZE,
				fontWeight: "400",
				wordWrap: true,
				breakWords: true,
				lineHeight: EXCERPT_LINE,
			},
			resolution,
			roundPixels: true,
		});
		const typeMark = new Text({
			text: "",
			style: {
				fill: context.palette.muted,
				fontFamily: BOARD_MONO_FONT_STACK,
				fontSize: TYPE_MARK_SIZE,
				fontWeight: "700",
				lineHeight: TYPE_MARK_SIZE * 1.1,
			},
			resolution,
			roundPixels: true,
		});
		body.mask = clip;
		body.addChild(cover, coverMask, typeMark, title, excerpt);
		const tag = createCardTag();
		root.addChild(plate, body, clip, tag.root);
		partsByContainer.set(root, {
			tag,
			root,
			plate,
			body,
			clip,
			cover,
			coverMask,
			typeMark,
			title,
			excerpt,
			visualSig: "",
			textSig: "",
		});
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
		const category = fileCategory(
			item.type === "file" ? item.props.src : "",
			item.type === "file" ? item.props.snapshot?.mimeType : undefined,
		);
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.surface,
			fillAlpha: 0.96,
			accent: fileCategoryAccent(category, context.palette),
			accentAlpha: 0.45,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};

export function isFileItem(item: BoardSceneItem): item is SceneItem<BoardFileItem> {
	return item.type === "file";
}
