import type { SceneItem } from "../../core/scene.js";
import {
	BOARD_FONT_STACK,
	BOARD_MONO_FONT_STACK,
} from "@cohub/protocol/board-constants";
import type { BoardTaskItem } from "@cohub/protocol";
import { Container, Graphics, Sprite, Text } from "pixi.js";
import { drawAudioWaveform } from "../audio-waveform.js";
import { featuredTaskArtifact } from "../../task.js";
import {
	syncTextResolution,
	textResolutionForZoom,
} from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";
import { fitTextToLines } from "./file-card-renderer.js";

const RADIUS = 4;
const PADDING = 12;
const META_HEIGHT = 28;
export const TASK_CARD_FULL_DETAIL_ZOOM = 0.55;
const PLAY_BADGE_RADIUS = 15;

type TaskParts = {
	root: Container;
	plate: Graphics;
	clip: Graphics;
	previewBg: Graphics;
	preview: Sprite;
	previewMask: Graphics;
	previewArt: Graphics;
	body: Text;
	meta: Text;
	assetKey: string | null;
	visualSig: string;
	textSig: string;
	resolution: number;
};

const partsByContainer = new WeakMap<Container, TaskParts>();

type PreviewKind = "texture" | "waveform" | "text" | "empty";
type StateSurface =
	| "generating"
	| "queued"
	| "failed"
	| "unavailable"
	| "media-loading"
	| "empty"
	| null;

function previewKindFor(
	artifact: ReturnType<typeof featuredTaskArtifact>,
): PreviewKind {
	if (!artifact) return "empty";
	if (artifact.type === "image" || artifact.type === "video") return "texture";
	if (artifact.type === "audio") {
		return artifact.previewUrl ? "texture" : "waveform";
	}
	return artifact.textExcerpt ? "text" : "empty";
}

function stateSurfaceFor(
	item: SceneItem<BoardTaskItem>,
	kind: PreviewKind,
	hasTexture: boolean,
	previewFailed: boolean,
): StateSurface {
	if (kind === "texture" && !hasTexture) {
		if (item.props.snapshot.status === "failed") return "failed";
		return previewFailed ? "unavailable" : "media-loading";
	}
	if (kind !== "empty") return null;
	if (item.props.snapshot.status === "failed") return "failed";
	if (item.props.snapshot.status === "running") return "generating";
	if (item.props.snapshot.status === "pending") return "queued";
	return "empty";
}

function stateLabel(surface: StateSurface): string {
	switch (surface) {
		case "generating":
			return "Generating";
		case "queued":
			return "Queued";
		case "failed":
			return "Failed";
		case "unavailable":
			return "Preview unavailable";
		case "empty":
			return "No preview";
		default:
			return "";
	}
}

function statusColor(item: SceneItem<BoardTaskItem>, context: BoardRenderContext) {
	if (item.props.snapshot.status === "failed") return context.colors.rose.stroke;
	if (item.props.snapshot.status === "running") return context.colors.brand.stroke;
	return context.colors.neutral.stroke;
}

function metadata(item: SceneItem<BoardTaskItem>): string {
	const { artifactCount, artifacts } = item.props.snapshot;
	const extra =
		artifactCount > artifacts.length
			? `${artifacts.length}/${artifactCount}`
			: artifactCount > 1
				? `+${artifactCount - 1}`
				: null;
	return [item.props.snapshot.model, extra].filter(Boolean).join(" · ");
}

export function containTaskPreviewRect(
	width: number,
	height: number,
	imageWidth: number,
	imageHeight: number,
) {
	if (width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0)
		return { x: 0, y: 0, width: 0, height: 0 };
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

function drawPlayBadge(
	graphics: Graphics,
	rect: { x: number; y: number; width: number; height: number },
	context: BoardRenderContext,
) {
	const radius = Math.min(
		PLAY_BADGE_RADIUS,
		Math.max(8, Math.min(rect.width, rect.height) * 0.16),
	);
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	graphics
		.circle(cx, cy, radius)
		.fill({ color: context.palette.bg, alpha: 0.64 });
	const size = radius * 0.72;
	graphics
		.moveTo(cx - size * 0.34, cy - size * 0.56)
		.lineTo(cx + size * 0.62, cy)
		.lineTo(cx - size * 0.34, cy + size * 0.56)
		.closePath()
		.fill({ color: context.palette.text, alpha: 0.94 });
}

function drawStateMark(
	graphics: Graphics,
	surface: StateSurface,
	cx: number,
	cy: number,
	color: number,
) {
	if (surface === "generating" || surface === "media-loading") {
		graphics.circle(cx, cy, 4).fill({ color, alpha: 0.9 });
		graphics.circle(cx - 12, cy + 7, 2.5).fill({ color, alpha: 0.48 });
		graphics.circle(cx + 11, cy + 6, 3).fill({ color, alpha: 0.68 });
		graphics.circle(cx + 3, cy - 12, 2).fill({ color, alpha: 0.36 });
		return;
	}
	if (surface === "queued") {
		graphics
			.circle(cx, cy, 10)
			.stroke({ color, width: 1.5, alpha: 0.62 })
			.circle(cx, cy, 3)
			.fill({ color, alpha: 0.78 });
		return;
	}
	if (surface === "failed") {
		graphics.circle(cx, cy, 11).stroke({ color, width: 1.5, alpha: 0.86 });
		graphics
			.moveTo(cx - 4, cy - 4)
			.lineTo(cx + 4, cy + 4)
			.moveTo(cx + 4, cy - 4)
			.lineTo(cx - 4, cy + 4)
			.stroke({ color, width: 1.5, alpha: 0.94, cap: "round" });
		return;
	}
	if (surface === "unavailable") {
		graphics
			.roundRect(cx - 12, cy - 9, 24, 18, 3)
			.stroke({ color, width: 1.25, alpha: 0.62 })
			.moveTo(cx - 8, cy + 5)
			.lineTo(cx + 8, cy - 5)
			.stroke({ color, width: 1.25, alpha: 0.72, cap: "round" });
	}
}

function drawFailedBadge(
	graphics: Graphics,
	width: number,
	color: number,
	context: BoardRenderContext,
) {
	const cx = Math.max(12, width - 12);
	const cy = 12;
	graphics.circle(cx, cy, 8).fill({ color: context.palette.bg, alpha: 0.72 });
	graphics
		.moveTo(cx - 2.5, cy - 2.5)
		.lineTo(cx + 2.5, cy + 2.5)
		.moveTo(cx + 2.5, cy - 2.5)
		.lineTo(cx - 2.5, cy + 2.5)
		.stroke({ color, width: 1.5, alpha: 0.96, cap: "round" });
}

function sync(
	container: Container,
	item: SceneItem<BoardTaskItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);

	const { width, height } = item.frame;
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const full = context.zoom >= TASK_CARD_FULL_DETAIL_ZOOM;
	const color = statusColor(item, context);
	const key = context.assetKey(item);
	if (key !== parts.assetKey) {
		if (parts.assetKey) context.releaseTexture(parts.assetKey);
		parts.assetKey = key;
		if (key) context.acquireTexture(key);
	}
	const texture = key ? context.getTexture(key) : null;
	const previewFailed = Boolean(key && !texture && context.hasError(key));
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	const kind = previewKindFor(artifact);
	const surface = stateSurfaceFor(
		item,
		kind,
		Boolean(texture),
		previewFailed,
	);
	const frame = {
		x: 1,
		y: 1,
		width: Math.max(1, width - 2),
		height: Math.max(1, height - 2),
	};
	const metaText = artifact ? metadata(item) : "";
	const showMeta = full && Boolean(metaText);
	const failedWithOutput =
		item.props.snapshot.status === "failed" && kind !== "empty";

	syncTextResolution(parts.body, parts, context.zoom);
	syncTextResolution(parts.meta, parts, context.zoom);

	const visualSig = [
		width,
		height,
		selected,
		hovered,
		full,
		color,
		kind,
		surface,
		showMeta,
		failedWithOutput,
		artifact?.type ?? "none",
		artifact?.id ?? "none",
		item.props.taskRunId,
		texture ? `${texture.width}x${texture.height}` : "none",
		context.palette.surface,
		context.palette.hover,
		context.palette.border,
		context.palette.bg,
	].join("|");

	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		parts.plate
			.clear()
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
				alpha: selected ? 0.96 : 0.82,
			});
		parts.clip
			.clear()
			.roundRect(1, 1, frame.width, frame.height, RADIUS - 1)
			.fill({ color: 0xffffff });
		parts.previewBg
			.clear()
			.rect(frame.x, frame.y, frame.width, frame.height)
			.fill({ color: context.palette.hover, alpha: 0.5 });
		parts.previewMask
			.clear()
			.rect(frame.x, frame.y, frame.width, frame.height)
			.fill({ color: 0xffffff });
		parts.previewArt.clear();

		if (kind === "waveform") {
			const bottomInset = showMeta ? META_HEIGHT : 0;
			drawAudioWaveform(
				parts.previewArt,
				item.props.taskRunId,
				{
					x: frame.x + PADDING,
					y: frame.y + PADDING,
					width: Math.max(1, frame.width - PADDING * 2),
					height: Math.max(1, frame.height - PADDING * 2 - bottomInset),
				},
				context.colors.brand.stroke,
			);
		}
		if (
			full &&
			(artifact?.type === "audio" ||
				(artifact?.type === "video" && texture))
		) {
			drawPlayBadge(parts.previewArt, frame, context);
		}
		if (surface) {
			const markY = frame.y + frame.height / 2 - (full && stateLabel(surface) ? 10 : 0);
			drawStateMark(
				parts.previewArt,
				surface,
				frame.x + frame.width / 2,
				markY,
				surface === "failed" ? color : context.colors.neutral.stroke,
			);
		}
		if (showMeta) {
			parts.previewArt
				.rect(frame.x, frame.y + frame.height - META_HEIGHT, frame.width, META_HEIGHT)
				.fill({ color: context.palette.bg, alpha: 0.68 });
		}
		if (failedWithOutput) drawFailedBadge(parts.previewArt, width, color, context);
	}

	parts.preview.visible = kind === "texture" && Boolean(texture);
	if (parts.preview.visible && texture) {
		if (parts.preview.texture !== texture) parts.preview.texture = texture;
		const fitted = containTaskPreviewRect(
			frame.width,
			frame.height,
			texture.width,
			texture.height,
		);
		parts.preview.position.set(frame.x + fitted.x, frame.y + fitted.y);
		parts.preview.width = fitted.width;
		parts.preview.height = fitted.height;
	}

	const bodyText =
		kind === "text" && artifact?.type === "text"
			? artifact.textExcerpt
			: stateLabel(surface);
	const textSig = [
		bodyText,
		metaText,
		kind,
		surface,
		full,
		width,
		height,
		context.palette.text,
		context.palette.muted,
	].join("|");
	if (textSig !== parts.textSig) {
		parts.textSig = textSig;
		parts.body.style.fill =
			surface === "failed" ? color : context.palette.text;
		fitTextToLines(
			parts.body,
			bodyText,
			kind === "text"
				? Math.max(1, Math.floor((height - PADDING * 2 - (showMeta ? META_HEIGHT : 0)) / 16))
				: 1,
			Math.max(24, width - PADDING * 2),
		);
		parts.meta.style.fill = context.palette.text;
		fitTextToLines(parts.meta, metaText, 1, Math.max(24, width - PADDING * 2));
	}

	parts.body.visible = full && Boolean(bodyText);
	parts.meta.visible = showMeta;
	if (kind === "text") {
		parts.body.position.set(PADDING, PADDING);
	} else {
		parts.body.position.set(
			Math.max(PADDING, (width - parts.body.width) / 2),
			height / 2 + 10,
		);
	}
	parts.meta.position.set(PADDING, height - META_HEIGHT + 7);
}

export const taskCardRenderer: BoardCardRenderer = {
	id: "task-card",
	canRender: (item) => item.type === "task",
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const clip = new Graphics();
		const previewBg = new Graphics();
		const preview = new Sprite();
		const previewMask = new Graphics();
		const previewArt = new Graphics();
		const resolution = textResolutionForZoom(context.zoom);
		const body = new Text({
			text: "",
			style: {
				fontFamily: BOARD_FONT_STACK,
				fontSize: 11.5,
				fontWeight: "500",
				wordWrap: true,
				breakWords: true,
			},
			resolution,
			roundPixels: true,
		});
		const meta = new Text({
			text: "",
			style: {
				fontFamily: BOARD_MONO_FONT_STACK,
				fontSize: 10,
				fontWeight: "500",
				wordWrap: true,
				breakWords: true,
			},
			resolution,
			roundPixels: true,
		});

		preview.mask = previewMask;
		root.mask = clip;
		root.addChild(
			plate,
			clip,
			previewBg,
			preview,
			previewMask,
			previewArt,
			body,
			meta,
		);
		partsByContainer.set(root, {
			root,
			plate,
			clip,
			previewBg,
			preview,
			previewMask,
			previewArt,
			body,
			meta,
			assetKey: null,
			visualSig: "",
			textSig: "",
			resolution,
		});
		if (item.type === "task") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "task") sync(container, item, context);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "task") return;
		const active =
			item.props.snapshot.status === "failed" ||
			item.props.snapshot.status === "running" ||
			item.props.snapshot.status === "pending";
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.surface,
			fillAlpha: 0.82,
			...(active
				? { accent: statusColor(item, context), accentAlpha: 0.9 }
				: {}),
		});
	},
	destroy: (container, context) => {
		const parts = partsByContainer.get(container);
		if (parts?.assetKey) context.releaseTexture(parts.assetKey);
		parts?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
