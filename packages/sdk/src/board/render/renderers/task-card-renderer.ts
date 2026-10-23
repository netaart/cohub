import type { SceneItem } from "../../model/scene.js";
import {
	BOARD_FONT_STACK,
	BOARD_MONO_FONT_STACK,
} from "@cohub/protocol/board-constants";
import { type BoardTaskItem, featuredTaskArtifact } from "@cohub/protocol";
import { Container, FillGradient, Graphics, Sprite, Text } from "pixi.js";
import { drawAudioWaveform } from "../audio-waveform.js";
import { boardCardDetailed } from "../lod.js";
import { syncTextResolution } from "../text-resolution.js";
import { type CardTag, createCardTag, formatBoardDuration, syncCardTag, zoomCardTag } from "../card-tag.js";
import { cardElevation, containRect, drawCardSurface, traceCardOutline } from "../surface.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate, farPictureTone } from "./far-plate.js";
import { fitTextToLines, fitTextToWidth } from "../text-fit.js";

const PADDING = 12;
const META_HEIGHT = 28;
const PLAY_BADGE_RADIUS = 15;
const SHIMMER_PERIOD_MS = 1600;
const SHIMMER_FRAME_MS = 33;
const REVEAL_MS = 180;
const SECOND = 1000;

type TaskStatus = BoardTaskItem["props"]["snapshot"]["status"];

type TaskParts = {
	root: Container;
	plate: Graphics;
	clip: Graphics;
	previewBg: Graphics;
	preview: Sprite;
	previewMask: Graphics;
	shimmer: Graphics;
	previewArt: Graphics;
	badge: Text;
	body: Text;
	detail: Text;
	meta: Text;
	tag: CardTag;
	assetKey: string | null;
	visualSig: string;
	textSig: string;
	motion: {
		itemId: string;
		width: number;
		shimmer: boolean;
		mosaic: { color: number; height: number; step: number } | null;
		startedAt: number | null;
		label: string;
		elapsed: string;
		revealFrom: number | null;
		revealKey: string | null;
	};
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

function liveStatus(
	item: SceneItem<BoardTaskItem>,
	context: BoardRenderContext,
): { status: TaskStatus; startedAt: number | null } {
	const { snapshot } = item.props;
	const live = snapshot.status === "completed" ? null : context.taskRun(item.props.taskRunId);
	const liveStart = Date.parse(live?.startedAt ?? "");
	const working = live?.status === "pending" || live?.status === "running";
	const adopt =
		snapshot.status === "failed"
			? working && liveStart > Date.parse(snapshot.updatedAt ?? "")
			: live?.status === "running" || (live?.status === "pending" && snapshot.status === "pending");
	const status = adopt && live ? live.status : snapshot.status;
	const started = adopt ? liveStart : Date.parse(snapshot.startedAt ?? "");
	return { status, startedAt: Number.isFinite(started) ? started : null };
}

function stateSurfaceFor(
	status: TaskStatus,
	kind: PreviewKind,
	hasTexture: boolean,
	previewFailed: boolean,
): StateSurface {
	if (kind === "texture" && !hasTexture) {
		if (status === "failed") return "failed";
		return previewFailed ? "unavailable" : "media-loading";
	}
	if (kind !== "empty") return null;
	if (status === "failed") return "failed";
	if (status === "running") return "generating";
	if (status === "pending") return "queued";
	return "empty";
}

function stateLabel(surface: StateSurface, context: BoardRenderContext): string {
	switch (surface) {
		case "generating":
			return context.labels.generating;
		case "queued":
			return context.labels.queued;
		case "failed":
			return context.labels.failed;
		case "unavailable":
			return context.labels.previewUnavailable;
		case "empty":
			return context.labels.noPreview;
		default:
			return "";
	}
}

function statusColor(status: TaskStatus, context: BoardRenderContext) {
	if (status === "failed") return context.colors.rose.stroke;
	if (status === "running") return context.colors.brand.stroke;
	return context.colors.neutral.stroke;
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

const shimmerGradients = new Map<number, FillGradient>();

function shimmerGradient(color: number): FillGradient {
	let gradient = shimmerGradients.get(color);
	if (!gradient) {
		const rgb = `${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}`;
		gradient = new FillGradient({
			type: "linear",
			start: { x: 0, y: 0 },
			end: { x: 1, y: 0 },
			textureSpace: "local",
			colorStops: [
				{ offset: 0, color: `rgba(${rgb}, 0)` },
				{ offset: 0.5, color: `rgba(${rgb}, 0.07)` },
				{ offset: 1, color: `rgba(${rgb}, 0)` },
			],
		});
		shimmerGradients.set(color, gradient);
	}
	return gradient;
}

function drawShimmerBand(graphics: Graphics, width: number, height: number, color: number) {
	const band = Math.max(48, width * 0.45);
	graphics.clear().rect(-band, 0, band, height).fill(shimmerGradient(color));
}

const MOSAIC_FRAME_MS = 160;
const MOSAIC_CELL = 8;

function drawMosaic(graphics: Graphics, width: number, height: number, color: number, frame: number) {
	const columns = Math.max(1, Math.floor(width / MOSAIC_CELL));
	const rows = Math.max(1, Math.floor(height / MOSAIC_CELL));
	const left = (width - columns * MOSAIC_CELL) / 2;
	const top = (height - rows * MOSAIC_CELL) / 2;
	graphics.clear();
	for (const [threshold, alpha] of [[0.08, 0.16], [0.02, 0.3]] as const) {
		for (let row = 0; row < rows; row += 1) {
			for (let column = 0; column < columns; column += 1) {
				let hash = Math.imul(column + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b) ^ Math.imul(frame + 1, 0xc2b2ae35);
				hash ^= hash >>> 15;
				hash = Math.imul(hash, 0x2c1b3c6d);
				hash ^= hash >>> 12;
				if ((hash >>> 0) / 0xffffffff < threshold)
					graphics.rect(left + column * MOSAIC_CELL + 1, top + row * MOSAIC_CELL + 1, MOSAIC_CELL - 2, MOSAIC_CELL - 2);
			}
		}
		graphics.fill({ color, alpha });
	}
}

function advance(parts: TaskParts, clock: number): number | null {
	const { motion } = parts;
	let next: number | null = null;
	if (motion.mosaic) {
		const frame = Math.floor(clock / MOSAIC_FRAME_MS);
		if (frame !== motion.mosaic.step) {
			motion.mosaic.step = frame;
			drawMosaic(parts.shimmer, motion.width, motion.mosaic.height, motion.mosaic.color, frame);
		}
		next = MOSAIC_FRAME_MS - (clock % MOSAIC_FRAME_MS);
	} else if (motion.shimmer) {
		const travel = motion.width + parts.shimmer.width;
		parts.shimmer.x = ((clock % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS) * travel;
		next = SHIMMER_FRAME_MS;
	}
	if (motion.startedAt !== null) {
		const elapsedMs = Date.now() - motion.startedAt;
		const elapsed = formatBoardDuration(elapsedMs);
		if (elapsed !== motion.elapsed) {
			motion.elapsed = elapsed;
			fitTextToWidth(parts.body, `${motion.label} · ${elapsed}`, Math.max(24, motion.width - PADDING * 2));
		}
		const untilNextSecond = SECOND - (Math.max(0, elapsedMs) % SECOND);
		next = next === null ? untilNextSecond : Math.min(next, untilNextSecond);
	}
	if (motion.revealFrom !== null) {
		const progress = Math.min(1, (clock - motion.revealFrom) / REVEAL_MS);
		parts.preview.alpha = progress * (2 - progress);
		if (progress >= 1) motion.revealFrom = null;
		else next = 0;
	}
	return next;
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
	const { snapshot } = item.props;
	const { status, startedAt } = liveStatus(item, context);
	const full = boardCardDetailed(context.zoom);
	const elevation = cardElevation(context, item.id);
	syncCardTag(parts.tag, { glyph: "task", text: snapshot.title, width }, context);
	const working = status === "pending" || status === "running";
	const color = statusColor(status, context);
	const key = context.assetKey(item);
	if (key !== parts.assetKey) {
		if (parts.assetKey) context.releaseTexture(parts.assetKey);
		parts.assetKey = key;
		if (key) context.acquireTexture(key, item);
	}
	const texture = key ? context.getTexture(key) : null;
	const previewFailed = Boolean(key && !texture && context.hasError(key));
	const artifact = featuredTaskArtifact(snapshot.artifacts);
	const kind = previewKindFor(artifact);
	const surface = stateSurfaceFor(status, kind, Boolean(texture), previewFailed);
	const frame = {
		x: 1,
		y: 1,
		width: Math.max(1, width - 2),
		height: Math.max(1, height - 2),
	};
	const metaText = artifact || working ? (snapshot.model ?? "") : "";
	const showMeta = full && Boolean(metaText);
	const failedWithOutput = status === "failed" && kind !== "empty";
	const count = artifact && snapshot.artifactCount > 1 ? String(snapshot.artifactCount) : "";
	const showBadge = full && Boolean(count);

	const label = stateLabel(surface, context);
	const counting = full && working && startedAt !== null && surface !== null;
	const elapsed = counting ? formatBoardDuration(Date.now() - (startedAt as number)) : "";
	const detailText = !full || !surface
		? ""
		: status === "failed"
			? (snapshot.errorExcerpt ?? "")
			: working
				? (snapshot.promptExcerpt ?? "")
				: "";
	const textArtifact = kind === "text" && artifact?.type === "text";
	const bodyText = textArtifact ? artifact.textExcerpt : counting ? `${label} · ${elapsed}` : label;


	const textSig = [
		counting ? label : bodyText,
		detailText,
		metaText,
		count,
		kind,
		surface,
		full,
		width,
		height,
		color,
		context.palette.text,
		context.palette.muted,
		context.style.font,
		context.themeKey,
	].join("|");
	if (textSig !== parts.textSig) {
		parts.textSig = textSig;
		parts.body.style.fontFamily = context.style.font;
		parts.detail.style.fontFamily = context.style.font;
		const wrap = Math.max(24, width - PADDING * 2);
		parts.body.style.fill = surface === "failed" ? color : context.palette.text;
		parts.body.anchor.set(textArtifact ? 0 : 0.5, 0);
		fitTextToLines(
			parts.body,
			bodyText,
			textArtifact ? Math.max(1, Math.floor((height - PADDING * 2 - (showMeta ? META_HEIGHT : 0)) / 16)) : 1,
			wrap,
		);
		parts.detail.style.fill = context.palette.muted;
		fitTextToLines(parts.detail, detailText, height - PADDING * 2 > 120 ? 2 : 1, Math.min(wrap, 360));
		parts.meta.style.fill = context.palette.text;
		fitTextToLines(parts.meta, metaText, 1, wrap);
		parts.badge.style.fill = context.palette.text;
		if (parts.badge.text !== count) parts.badge.text = count;
	}
	for (const text of [parts.body, parts.detail, parts.meta, parts.badge]) syncTextResolution(text, context.textResolution);
	const badgeWidth = Math.max(22, parts.badge.width + 12);

	const visualSig = [
		width,
		height,
		full,
		elevation,
		color,
		kind,
		surface,
		showMeta,
		showBadge && badgeWidth,
		failedWithOutput,
		artifact?.type ?? "none",
		artifact?.id ?? "none",
		item.props.taskRunId,
		texture?.uid ?? "none",
		context.themeKey,
	].join("|");

	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		const rect = { x: 0, y: 0, width, height };
		drawCardSurface(parts.plate.clear(), rect, context.style, {
			fill: context.palette.surface,
			border: context.palette.border,
			borderAlpha: 0.82,
			elevation,
		});
		traceCardOutline(parts.clip.clear(), rect, context.style, -1).fill({ color: 0xffffff });
		parts.previewBg
			.clear()
			.rect(frame.x, frame.y, frame.width, frame.height)
			.fill({ color: context.palette.hover, alpha: 0.5 });
		parts.previewMask
			.clear()
			.rect(frame.x, frame.y, frame.width, frame.height)
			.fill({ color: 0xffffff });
		if (context.style.progress === "shimmer") drawShimmerBand(parts.shimmer, frame.width, frame.height, context.palette.text);
		parts.shimmer.position.set(context.style.progress === "shimmer" ? 0 : frame.x, frame.y);
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
			const markY = frame.y + frame.height / 2 - (full && label ? 18 : 0);
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
		if (showBadge) {
			parts.previewArt
				.roundRect(width - badgeWidth - 8, 8, badgeWidth, 20, 10)
				.fill({ color: context.palette.bg, alpha: 0.72 });
		}
		if (failedWithOutput) drawFailedBadge(parts.previewArt, width, color, context);
	}

	const showPreview = kind === "texture" && Boolean(texture);
	const revealKey = showPreview ? `${artifact?.id}:${texture?.uid}` : null;
	const sameCard = parts.motion.itemId === item.id;
	parts.motion.itemId = item.id;
	if (revealKey !== parts.motion.revealKey || !sameCard) {
		const appearing = sameCard && parts.motion.revealKey === null && revealKey !== null;
		parts.motion.revealKey = revealKey;
		parts.motion.revealFrom = appearing && !context.reducedMotion ? performance.now() : null;
		parts.preview.alpha = parts.motion.revealFrom === null ? 1 : 0;
	}
	parts.preview.visible = showPreview;
	if (showPreview && texture) {
		if (parts.preview.texture !== texture) parts.preview.texture = texture;
		const fitted = containRect(
			frame.width,
			frame.height,
			texture.width,
			texture.height,
		);
		parts.preview.position.set(frame.x + fitted.x, frame.y + fitted.y);
		parts.preview.width = fitted.width;
		parts.preview.height = fitted.height;
	}

	parts.body.visible = full && Boolean(bodyText);
	parts.detail.visible = full && Boolean(detailText);
	parts.meta.visible = showMeta;
	parts.badge.visible = showBadge;
	if (textArtifact) parts.body.position.set(PADDING, PADDING);
	else parts.body.position.set(width / 2, height / 2 + 2);
	parts.detail.position.set(width / 2, height / 2 + 2 + parts.body.height + 4);
	parts.meta.position.set(PADDING, height - META_HEIGHT + 7);
	parts.badge.position.set(width - 8 - badgeWidth / 2, 18);

	parts.motion.width = frame.width;
	parts.motion.shimmer = full && working && kind !== "texture" && !context.reducedMotion;
	const mosaic = parts.motion.shimmer && context.style.progress === "mosaic";
	parts.motion.mosaic = mosaic ? { color: context.palette.brand, height: frame.height, step: -1 } : null;
	parts.shimmer.visible = parts.motion.shimmer;
	parts.motion.startedAt = counting ? startedAt : null;
	parts.motion.label = label;
	parts.motion.elapsed = elapsed;
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
		const shimmer = new Graphics();
		const previewArt = new Graphics();
		const text = (fontFamily: string, fontSize: number, fontWeight: "400" | "500") =>
			new Text({
				text: "",
				style: { fontFamily, fontSize, fontWeight },
				resolution: context.textResolution,
				roundPixels: true,
			});
		const body = text(BOARD_FONT_STACK, 11.5, "500");
		const detail = text(BOARD_FONT_STACK, 10.5, "400");
		const meta = text(BOARD_MONO_FONT_STACK, 10, "500");
		const badge = text(BOARD_MONO_FONT_STACK, 10, "500");
		badge.anchor.set(0.5);
		detail.anchor.set(0.5, 0);
		detail.style.align = "center";

		preview.mask = previewMask;
		const content = new Container();
		content.mask = clip;
		content.addChild(previewBg, shimmer, preview, previewMask, previewArt, body, detail, meta, badge);
		const tag = createCardTag();
		root.addChild(plate, content, clip, tag.root);
		partsByContainer.set(root, {
			root,
			tag,
			plate,
			clip,
			previewBg,
			preview,
			previewMask,
			shimmer,
			previewArt,
			badge,
			body,
			detail,
			meta,
			assetKey: null,
			visualSig: "",
			textSig: "",
			motion: {
				itemId: "",
				width: 0,
				shimmer: false,
				mosaic: null,
				startedAt: null,
				label: "",
				elapsed: "",
				revealFrom: null,
				revealKey: null,
			},
		});
		if (item.type === "task") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "task") sync(container, item, context);
	},
	tick: (container, clock) => {
		const parts = partsByContainer.get(container);
		return parts ? advance(parts, clock) : null;
	},
	resolution: (container, item, context) => {
		if (item.type === "task") sync(container, item, context);
	},
	zoom: (container, zoom) => {
		const tag = partsByContainer.get(container)?.tag;
		if (tag) zoomCardTag(tag, zoom);
	},
	renderFar: (graphics, item, context) => {
		if (item.type !== "task") return;
		const { status } = liveStatus(item, context);
		const active = status === "failed" || status === "running" || status === "pending";
		drawFarPlate(graphics, item.frame, {
			fill: farPictureTone(item, context) ?? context.palette.surface,
			fillAlpha: 0.82,
			...(active
				? { accent: statusColor(status, context), accentAlpha: 0.9 }
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
