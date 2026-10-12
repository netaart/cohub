import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import {
	BOARD_FONT_STACK,
	BOARD_MONO_FONT_STACK,
} from "@cohub/protocol/board-constants";
import {
	CanvasTextMetrics,
	Container,
	Graphics,
	Sprite,
	Text,
	Texture,
} from "pixi.js";
import { syncTextResolution } from "../text-resolution.js";
import type { BoardFileItem, } from "@cohub/protocol";
import {
	fileCategory,
	fileCategoryAccent,
	filePreviewKind,
	fileStem,
	fileTypeLabel,
} from "../../model/file-preview.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";


const RADIUS = 4;
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

const LOD_TITLE_ZOOM = 0.35;
const LOD_BODY_ZOOM = 0.6;

const MAX_DASHES = 40;

type FileParts = {
	root: Container;
	plate: Graphics;
	body: Container;
	clip: Graphics;
	cover: Sprite;
	coverMask: Graphics;
	typeMark: Text;
	title: Text;
	excerpt: Text;
	visualSig: string;
	textSig: string;
	titleRes: { resolution: number };
	excerptRes: { resolution: number };
	typeMarkRes: { resolution: number };
};

const partsByContainer = new WeakMap<Container, FileParts>();

function detailFor(zoom: number): "plate" | "title" | "full" {
	if (zoom < LOD_TITLE_ZOOM) return "plate";
	if (zoom < LOD_BODY_ZOOM) return "title";
	return "full";
}

function coverHeight(item: SceneItem<BoardFileItem>, height: number): number {
	if (filePreviewKind(item.props.snapshot) !== "cover") return 0;
	const ideal = Math.round(height * COVER_RATIO);
	return Math.max(0, Math.min(ideal, height - MIN_BODY_FOR_COVER));
}

export function ellipsizeWrappedLines(
	lines: string[],
	maxLines: number,
): string {
	if (maxLines <= 0 || lines.length === 0) return "";
	if (lines.length <= maxLines) return lines.join("\n");
	const kept = lines.slice(0, maxLines);
	const lastIndex = kept.length - 1;
	const last = (kept[lastIndex] ?? "").replace(/\s+$/u, "");
	kept[lastIndex] = last ? `${last}…` : "…";
	return kept.join("\n");
}

export function fitLineWithEllipsis(
	line: string,
	wrapWidth: number,
	measureWidth: (value: string) => number,
): string {
	const trimmed = line.replace(/\s+$/u, "");
	if (!trimmed) return "…";
	const full = `${trimmed}…`;
	if (measureWidth(full) <= wrapWidth) return full;

	let lo = 0;
	let hi = trimmed.length;
	let best = "…";
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const candidate = mid > 0 ? `${trimmed.slice(0, mid)}…` : "…";
		if (measureWidth(candidate) <= wrapWidth) {
			best = candidate;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best;
}

export function fitTextToLines(
	text: Text,
	value: string,
	maxLines: number,
	wrapWidth: number,
): void {
	const width = Math.max(1, wrapWidth);
	text.style.wordWrapWidth = width;
	if (!value || maxLines <= 0) {
		if (text.text !== "") text.text = "";
		return;
	}

	const charCap = Math.max(maxLines * Math.ceil(width), maxLines * 4);
	const sample = value.length > charCap ? value.slice(0, charCap) : value;
	const metrics = CanvasTextMetrics.measureText(sample, text.style);
	const overflowed = metrics.lines.length > maxLines || sample !== value;
	if (!overflowed) {
		if (text.text !== value) text.text = value;
		return;
	}

	const keptCount = Math.min(maxLines, metrics.lines.length);
	const kept = metrics.lines.slice(0, keptCount);
	const lastIndex = kept.length - 1;
	const probe = text.style.clone();
	probe.wordWrap = false;
	kept[lastIndex] = fitLineWithEllipsis(
		kept[lastIndex] ?? "",
		width,
		(candidate) => CanvasTextMetrics.measureText(candidate, probe).width,
	);
	const fitted = kept.join("\n");
	if (text.text !== fitted) text.text = fitted;
}

function linesInRoom(room: number, lineHeight: number, max: number): number {
	if (room < lineHeight * 0.85) return 0;
	return Math.max(0, Math.min(max, Math.floor((room + 0.5) / lineHeight)));
}

export function containCoverRect(
	width: number,
	height: number,
	imageWidth: number,
	imageHeight: number,
): { x: number; y: number; width: number; height: number } {
	if (width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}
	const scale = Math.min(width / imageWidth, height / imageHeight);
	const renderedWidth = imageWidth * scale;
	const renderedHeight = imageHeight * scale;
	return {
		x: (width - renderedWidth) / 2,
		y: (height - renderedHeight) / 2,
		width: renderedWidth,
		height: renderedHeight,
	};
}

function layoutCover(
	sprite: Sprite,
	width: number,
	height: number,
	texture: Texture,
) {
	const rect = containCoverRect(width, height, texture.width, texture.height);
	sprite.position.set(rect.x, rect.y);
	sprite.width = rect.width;
	sprite.height = rect.height;
}

function syncClip(parts: FileParts, width: number, height: number) {
	parts.clip
		.clear()
		.roundRect(0, 0, Math.max(1, width), Math.max(1, height), RADIUS)
		.fill({ color: 0xffffff });
}

function sync(
	container: Container,
	item: SceneItem<BoardFileItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);

	const { width, height } = item.frame;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const detail = detailFor(context.zoom);
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const coverFailed = Boolean(key && !texture && context.hasError(key));
	const fileState = context.fileState(item.props.src);
	const band = coverHeight(item, height);
	const kind = filePreviewKind(item.props.snapshot);
	const category = fileCategory(item.props.src, item.props.snapshot?.mimeType);
	const accent = fileCategoryAccent(category, context.palette);

	syncTextResolution(parts.title, parts.titleRes, context.zoom);
	syncTextResolution(parts.excerpt, parts.excerptRes, context.zoom);
	syncTextResolution(parts.typeMark, parts.typeMarkRes, context.zoom);

	const visualSig = [
		key ?? "",
		width,
		height,
		selected,
		hovered,
		detail,
		texture ? `${texture.width}x${texture.height}` : "none",
		coverFailed,
		fileState,
		kind,
		category,
		context.colorScheme,
		context.palette.surface,
		context.palette.hover,
		accent,
	].join("|");

	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;

		syncClip(parts, width, height);

		parts.plate.clear();
		parts.plate
			.roundRect(0, 0, width, height, RADIUS)
			.fill({ color: context.palette.surface, alpha: 0.98 })
			.roundRect(0, 0, width, height, RADIUS)
			.stroke({
				color: selected
					? context.palette.brand
					: hovered
						? context.palette.muted
						: context.palette.border,
				width: selected ? 2 : 1,
				alpha: selected ? 0.95 : 0.85,
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
			parts.coverMask
				.clear()
				.roundRect(0, 0, width, band, RADIUS)
				.fill({ color: 0xffffff });
			parts.coverMask
				.rect(0, band - RADIUS, width, RADIUS)
				.fill({ color: 0xffffff });
		}
		parts.cover.visible = showCover;
		parts.coverMask.visible = showCover;

		if (!band) {
			parts.plate
				.rect(1, 1, STRIPE, height - 2)
				.fill({ color: accent, alpha: 0.55 });
		}

		parts.title.visible = detail !== "plate";
		parts.excerpt.visible = detail === "full";
		parts.typeMark.visible = kind === "blank" && detail !== "plate";
	}

	if (detail === "plate") {
		parts.typeMark.visible = false;
		return;
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
		accent,
	].join("|");
	if (textSig === parts.textSig) return;
	parts.textSig = textSig;

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
		const resolution = 1;

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
		root.addChild(plate, body, clip);
		partsByContainer.set(root, {
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
			titleRes: { resolution },
			excerptRes: { resolution },
			typeMarkRes: { resolution },
		});
		if (item.type === "file") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "file") sync(container, item, context);
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
