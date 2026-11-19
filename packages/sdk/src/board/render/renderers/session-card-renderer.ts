import { BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import { APP_SESSION_SOURCES, type BoardSessionItem, resolveSessionSourceKey, SESSION_SOURCE_NAMES } from "@cohub/protocol";
import { Container, Graphics, Text } from "pixi.js";
import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import { type CardTag, createCardTag, formatBoardDuration, syncCardTag, zoomCardTag } from "../card-tag.js";
import { boardCardDetailed } from "../lod.js";
import { cardElevation, drawCardSurface, traceCardOutline } from "../surface.js";
import { fitTextToLines, fitTextToWidth } from "../text-fit.js";
import { syncTextResolution } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
	BoardSessionLive,
	BoardSessionStatus,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

const PAD_X = 14;
const PAD_Y = 12;
const TITLE_SIZE = 14;
const TITLE_LINE = 19;
const STATUS_SIZE = 11.5;
const STATUS_LINE = 16;
const EXCERPT_SIZE = 12;
const EXCERPT_LINE = 18;
const EXCERPT_MAX_LINES = 6;
const MODEL_SIZE = 10;
const MODEL_LINE = 14;
const GAP = 6;
const DOT = 4;
const DOT_GAP = 1.5;
const UNREAD = 6;
const RING = 8;
const UNAVAILABLE_ALPHA = 0.55;
const SECOND = 1000;
const WAVE_FRAME_MS = 150;
const PIP_SCREEN = 6;

type SessionView = BoardSessionLive & { unavailable: boolean };

type Wave = { period: number; dots: Graphics[] } | null;

type SessionParts = {
	root: Container;
	plate: Graphics;
	content: Container;
	clip: Graphics;
	mark: Graphics;
	dots: Graphics[];
	unread: Graphics;
	title: Text;
	status: Text;
	excerpt: Text;
	model: Text;
	tag: CardTag;
	visualSig: string;
	textSig: string;
	motion: { wave: Wave; frame: number; startedAt: number | null; label: string; elapsed: string; width: number };
};

const partsByContainer = new WeakMap<Container, SessionParts>();

const pad = (value: number) => String(value).padStart(2, "0");

function compactTime(value: string | undefined): string {
	const date = value ? new Date(value) : null;
	if (!date || Number.isNaN(date.getTime())) return "";
	const now = new Date();
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (date.toDateString() === now.toDateString()) return time;
	const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day}`;
}

function sourceName(source: string | undefined): string {
	const key = resolveSessionSourceKey(source);
	return APP_SESSION_SOURCES.has(key) ? "" : SESSION_SOURCE_NAMES[key];
}

function snapshotView(item: SceneItem<BoardSessionItem>, context: BoardRenderContext, unavailable: boolean): SessionView {
	const { snapshot } = item.props;
	const status: BoardSessionStatus = snapshot.issue ?? "idle";
	const excerpt = (status === "failed" ? snapshot.errorExcerpt : undefined) ?? snapshot.excerpt ?? null;
	const meta = unavailable
		? context.labels.sessionUnavailable
		: [sourceName(snapshot.source), compactTime(snapshot.activityAt)].filter(Boolean).join(" · ");
	return {
		title: snapshot.title || excerpt || context.labels.sessionUntitled,
		excerpt: snapshot.title ? excerpt : null,
		meta,
		status: unavailable ? "idle" : status,
		label: unavailable ? "" : status === "failed" ? context.labels.failed : status === "lost" ? context.labels.sessionLost : "",
		startedAt: null,
		model: null,
		unread: false,
		unavailable,
	};
}

function viewOf(item: SceneItem<BoardSessionItem>, context: BoardRenderContext): SessionView {
	const live = context.session?.(item.props.sessionId) ?? null;
	if (live === "unavailable") return snapshotView(item, context, true);
	return live ? { ...live, unavailable: false } : snapshotView(item, context, false);
}

function statusColor(status: BoardSessionStatus, context: BoardRenderContext): number {
	if (status === "running") return context.palette.activity;
	if (status === "failed") return context.palette.error;
	if (status === "lost") return context.palette.warning;
	return context.palette.muted;
}

function waveFor(status: BoardSessionStatus, context: BoardRenderContext): number | null {
	if (context.reducedMotion) return null;
	if (status === "running") return 1200;
	return status === "stopping" ? 2400 : null;
}

const RESTING_ALPHA = [1, 0.6, 0.32] as const;

function waveAlpha(index: number, clock: number, period: number): number {
	const phase = (((clock - index * 150) % period) + period) % period / period;
	return 0.32 + 0.68 * Math.max(0, Math.sin(phase * Math.PI * 2));
}

function drawDot(graphics: Graphics, x: number, y: number, size: number, color: number, pixel: boolean) {
	graphics.clear();
	if (pixel) graphics.rect(x, y, size, size);
	else graphics.circle(x + size / 2, y + size / 2, size / 2);
	graphics.fill({ color });
}

function advance(parts: SessionParts, clock: number): number | null {
	const { motion } = parts;
	let next: number | null = null;
	if (motion.wave) {
		const frame = Math.floor(clock / WAVE_FRAME_MS);
		if (frame !== motion.frame) {
			motion.frame = frame;
			const at = frame * WAVE_FRAME_MS;
			motion.wave.dots.forEach((dot, index) => {
				dot.alpha = waveAlpha(index, at, (motion.wave as NonNullable<Wave>).period);
			});
		}
		next = WAVE_FRAME_MS - (clock % WAVE_FRAME_MS);
	}
	if (motion.startedAt !== null) {
		const elapsedMs = Date.now() - motion.startedAt;
		const elapsed = formatBoardDuration(elapsedMs);
		if (elapsed !== motion.elapsed) {
			motion.elapsed = elapsed;
			fitTextToWidth(parts.status, `${motion.label} · ${elapsed}`, motion.width);
		}
		const untilNextSecond = SECOND - (Math.max(0, elapsedMs) % SECOND);
		next = next === null ? untilNextSecond : Math.min(next, untilNextSecond);
	}
	return next;
}

function linesInRoom(room: number, lineHeight: number, max: number): number {
	return room < lineHeight * 0.85 ? 0 : Math.max(0, Math.min(max, Math.floor((room + 0.5) / lineHeight)));
}

function sync(container: Container, item: SceneItem<BoardSessionItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const view = viewOf(item, context);
	const full = boardCardDetailed(context.zoom);
	const elevation = cardElevation(context, item.id);
	const pixel = context.style.corner === "pixel";
	const color = statusColor(view.status, context);
	const showStatus = view.status !== "idle";
	const ring = view.status === "failed" || view.status === "lost";
	const counting = full && view.status === "running" && view.startedAt !== null;
	const elapsed = counting ? formatBoardDuration(Date.now() - (view.startedAt as number)) : "";
	const innerWidth = Math.max(1, width - PAD_X * 2);
	syncCardTag(parts.tag, { glyph: "session", text: view.meta, width }, context);
	const pip = full ? 0 : Math.round(Math.min(Math.max(PIP_SCREEN / context.zoom, DOT), Math.min(width, height) * 0.2));

	const textSig = [
		view.title,
		view.excerpt,
		view.label,
		counting,
		view.model,
		view.unread,
		showStatus,
		full,
		pip,
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
		for (const text of [parts.title, parts.status, parts.excerpt]) text.style.fontFamily = context.style.font;
		const statusLeft = PAD_X + (ring ? RING : DOT * 3 + DOT_GAP * 2) + GAP;
		let cursor = PAD_Y;

		parts.title.style.fill = context.palette.text;
		const titleRoom = innerWidth - (full ? (view.unread ? UNREAD + GAP : 0) : showStatus ? pip + GAP : 0);
		fitTextToWidth(parts.title, view.title, Math.max(1, titleRoom));
		parts.title.position.set(PAD_X, cursor);
		cursor += TITLE_LINE;

		parts.status.visible = showStatus && full;
		if (showStatus) {
			cursor += 4;
			parts.status.style.fill = color;
			fitTextToWidth(parts.status, counting ? `${view.label} · ${elapsed}` : view.label, Math.max(1, width - statusLeft - PAD_X));
			parts.status.position.set(statusLeft, cursor);
			cursor += STATUS_LINE;
		}

		const showModel = full && Boolean(view.model);
		parts.model.visible = showModel;
		if (showModel) {
			parts.model.style.fill = context.palette.muted;
			fitTextToWidth(parts.model, view.model as string, innerWidth);
			parts.model.position.set(width - PAD_X - parts.model.width, height - PAD_Y - MODEL_LINE + 2);
		}

		const bottom = height - PAD_Y - (showModel ? MODEL_LINE + GAP : 0);
		const lines = full && view.excerpt ? linesInRoom(bottom - cursor - GAP, EXCERPT_LINE, EXCERPT_MAX_LINES) : 0;
		parts.excerpt.visible = lines > 0;
		if (lines > 0) {
			parts.excerpt.style.fill = context.palette.muted;
			fitTextToLines(parts.excerpt, view.excerpt as string, lines, innerWidth);
			parts.excerpt.position.set(PAD_X, cursor + GAP);
		}
	}
	for (const text of [parts.title, parts.status, parts.excerpt, parts.model]) syncTextResolution(text, context.textResolution);

	const visualSig = [
		width,
		height,
		pip,
		elevation,
		view.status,
		view.unread,
		view.unavailable,
		full,
		pixel,
		color,
		parts.title.width,
		context.palette.activity,
		context.palette.surface,
		context.themeKey,
	].join("|");
	if (visualSig !== parts.visualSig) {
		parts.visualSig = visualSig;
		const rect = { x: 0, y: 0, width, height };
		drawCardSurface(parts.plate.clear(), rect, context.style, {
			fill: context.palette.surface,
			border: context.palette.border,
			borderAlpha: 0.85,
			elevation,
		});
		traceCardOutline(parts.clip.clear(), rect, context.style, -1).fill({ color: 0xffffff });
		parts.content.alpha = view.unavailable ? UNAVAILABLE_ALPHA : 1;

		const markY = PAD_Y + TITLE_LINE + 4 + STATUS_LINE / 2;
		parts.mark.clear();
		parts.mark.alpha = view.status === "queued" ? 0.7 : 1;
		for (const dot of parts.dots) dot.visible = false;
		if (showStatus && !full) {
			drawDot(parts.mark, width - PAD_X - pip, PAD_Y, pip, color, pixel);
		} else if (showStatus && ring) {
			if (pixel) parts.mark.rect(PAD_X, markY - RING / 2, RING, RING);
			else parts.mark.circle(PAD_X + RING / 2, markY, RING / 2 - 0.75);
			parts.mark.stroke({ color, width: 1.5, alignment: pixel ? 1 : 0.5 });
		} else if (showStatus) {
			parts.dots.forEach((dot, index) => {
				drawDot(dot, PAD_X + index * (DOT + DOT_GAP), markY - DOT / 2, DOT, color, pixel);
				dot.alpha = (view.status === "queued" ? 0.7 : 1) * (RESTING_ALPHA[index] ?? 1);
				dot.visible = true;
			});
		}
		parts.unread.visible = full && view.unread && !view.unavailable;
		if (parts.unread.visible) {
			drawDot(parts.unread, PAD_X + parts.title.width + GAP, PAD_Y + (TITLE_LINE - UNREAD) / 2, UNREAD, context.palette.activity, pixel);
		}
	}

	const wave = full && showStatus && !ring ? waveFor(view.status, context) : null;
	parts.motion.wave = wave ? { period: wave, dots: parts.dots } : null;
	if (!wave) parts.motion.frame = -1;
	parts.motion.startedAt = counting ? view.startedAt : null;
	parts.motion.label = view.label;
	parts.motion.elapsed = elapsed;
	parts.motion.width = Math.max(1, width - (PAD_X + DOT * 3 + DOT_GAP * 2 + GAP) - PAD_X);
}

function isSession(item: BoardSceneItem): item is SceneItem<BoardSessionItem> {
	return item.type === "session";
}

export const sessionCardRenderer: BoardCardRenderer = {
	id: "session-card",
	canRender: isSession,
	create: (item, context) => {
		const root = new Container();
		const plate = new Graphics();
		const clip = new Graphics();
		const content = new Container();
		const mark = new Graphics();
		const dots = [new Graphics(), new Graphics(), new Graphics()];
		const unread = new Graphics();
		const text = (fontFamily: string, fontSize: number, fontWeight: "400" | "500" | "600", lineHeight: number) =>
			new Text({ text: "", style: { fontFamily, fontSize, fontWeight, lineHeight }, resolution: context.textResolution, roundPixels: true });
		const title = text(context.style.font, TITLE_SIZE, "600", TITLE_LINE);
		const status = text(context.style.font, STATUS_SIZE, "500", STATUS_LINE);
		const excerpt = text(context.style.font, EXCERPT_SIZE, "400", EXCERPT_LINE);
		const model = text(BOARD_MONO_FONT_STACK, MODEL_SIZE, "500", MODEL_LINE);
		content.mask = clip;
		content.addChild(mark, ...dots, unread, title, status, excerpt, model);
		const tag = createCardTag();
		root.addChild(plate, content, clip, tag.root);
		partsByContainer.set(root, {
			root,
			plate,
			content,
			clip,
			mark,
			dots,
			unread,
			title,
			status,
			excerpt,
			model,
			tag,
			visualSig: "",
			textSig: "",
			motion: { wave: null, frame: -1, startedAt: null, label: "", elapsed: "", width: 0 },
		});
		if (isSession(item)) sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (isSession(item)) sync(container, item, context);
	},
	resolution: (container, item, context) => {
		if (isSession(item)) sync(container, item, context);
	},
	tick: (container, clock) => {
		const parts = partsByContainer.get(container);
		return parts ? advance(parts, clock) : null;
	},
	zoom: (container, zoom) => {
		const tag = partsByContainer.get(container)?.tag;
		if (tag) zoomCardTag(tag, zoom);
	},
	renderFar: (graphics, item, context) => {
		if (!isSession(item)) return;
		const { status, unavailable } = viewOf(item, context);
		const active = !unavailable && (status === "running" || status === "failed" || status === "lost");
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.surface,
			fillAlpha: unavailable ? 0.6 : 0.96,
			...(active ? { accent: statusColor(status, context), accentAlpha: 0.9 } : {}),
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
