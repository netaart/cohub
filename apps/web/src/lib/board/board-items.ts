
import {
	type BoardFileSnapshotFacts,
	type BoardItem,
	type BoardMediaSnapshot,
	type BoardTaskSnapshot,
	DEFAULT_BOARD_TOOL_STYLES,
	featuredTaskArtifact,
	filePreviewKind,
	fileStem,
	layoutBoardText,
	parseBoardItem,
	pointsRect,
	type ShapeKind,
} from "@neta-art/cohub/board";
import { BOARD_DRAW_STROKE_SIZE } from "@cohub/protocol/board-constants";
import { createBoardItemId } from "$lib/board/board-id";
import { getResourceTitle, inferMediaKind } from "$lib/board/board-media";

export type BoardItemEntry = { id: string; item: BoardItem };

const DEFAULT_MEDIA_SIZE = { width: 320, height: 200 };
const DEFAULT_TASK_SIZE = { width: 300, height: 188 };
const DEFAULT_TASK_MEDIA_SIZE = { width: 320, height: 180 };
const DEFAULT_VIDEO_SIZE = { width: 320, height: 180 };
const DEFAULT_AUDIO_SIZE = { width: 320, height: 112 };
const DEFAULT_FILE_SIZE = { width: 260, height: 132 };
const DEFAULT_FILE_COVER_SIZE = { width: 260, height: 208 };
const DEFAULT_SHAPE_SIZE = { width: 200, height: 140 };
const DEFAULT_FRAME_SIZE = { width: 480, height: 320 };
export const DUPLICATE_OFFSET = 24;

function item(value: Record<string, unknown>): BoardItem {
	const parsed = parseBoardItem(value);
	if (!parsed.ok) throw new Error(`Invalid Board item: ${parsed.diagnostics[0]?.path}: ${parsed.diagnostics[0]?.message}`);
	return parsed.item;
}

function centered(x: number, y: number, size: { width: number; height: number }) {
	return { position: { x: x - size.width / 2, y: y - size.height / 2 }, size: { ...size } };
}

export function mediaFrameSize(
	naturalWidth?: number | null,
	naturalHeight?: number | null,
	maxEdge = 480,
	fallback = DEFAULT_MEDIA_SIZE,
): { width: number; height: number } {
	if (!naturalWidth || !naturalHeight || !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) {
		return { ...fallback };
	}
	const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
	return { width: Math.max(24, naturalWidth * scale), height: Math.max(24, naturalHeight * scale) };
}

function cleanSnapshot(snapshot: BoardMediaSnapshot): BoardMediaSnapshot {
	return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined)) as BoardMediaSnapshot;
}

export function createFileNodeForPath(
	path: string,
	x: number,
	y: number,
	snapshot: BoardMediaSnapshot & BoardFileSnapshotFacts = {},
	id = createBoardItemId(),
): BoardItemEntry {
	const kind = inferMediaKind(path, snapshot.mimeType);
	const title = snapshot.title ?? (kind === "file" || kind === "text" ? fileStem(path) : getResourceTitle(path));
	if (kind === "image" || kind === "video") {
		const size = mediaFrameSize(snapshot.naturalWidth, snapshot.naturalHeight, 480, kind === "video" ? DEFAULT_VIDEO_SIZE : DEFAULT_MEDIA_SIZE);
		const mimeType = snapshot.mimeType ?? (kind === "video" ? "video/*" : undefined);
		return { id, item: item({ type: kind, ...centered(x, y, size), props: { src: path, snapshot: cleanSnapshot({ ...snapshot, title, mimeType }) } }) };
	}
	if (kind === "audio") {
		return { id, item: item({ type: "audio", ...centered(x, y, DEFAULT_AUDIO_SIZE), props: { src: path, snapshot: cleanSnapshot({ ...snapshot, title, mimeType: snapshot.mimeType ?? "audio/*" }) } }) };
	}
	const size = filePreviewKind(snapshot) === "cover" ? DEFAULT_FILE_COVER_SIZE : DEFAULT_FILE_SIZE;
	return { id, item: item({ type: "file", ...centered(x, y, size), props: { src: path, snapshot: cleanSnapshot({ ...snapshot, title }) } }) };
}

export function createTaskBoardItem(
	taskRunId: string,
	snapshot: BoardTaskSnapshot,
	x: number,
	y: number,
	metadata?: Record<string, unknown>,
	id = createBoardItemId(),
): BoardItemEntry {
	const artifact = featuredTaskArtifact(snapshot.artifacts);
	const visual = artifact?.type === "image" || artifact?.type === "video" ? artifact : null;
	const size = visual
		? mediaFrameSize(visual.naturalWidth, visual.naturalHeight, 480, DEFAULT_TASK_MEDIA_SIZE)
		: artifact?.type === "audio"
			? DEFAULT_TASK_MEDIA_SIZE
			: DEFAULT_TASK_SIZE;
	return { id, item: item({ type: "task", ...centered(x, y, size), ...(metadata ? { metadata } : {}), props: { taskRunId, snapshot } }) };
}

export function createTextBoardItem(text: string, x: number, y: number, color: string = DEFAULT_BOARD_TOOL_STYLES.text.color, id = createBoardItemId()): BoardItemEntry {
	return { id, item: item({ type: "text", position: { x, y }, ...(color === "neutral" ? {} : { style: { fill: color } }), props: { text } }) };
}

export function createShapeBoardItem(
	geometry: ShapeKind,
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.shape.color,
	id = createBoardItemId(),
	box?: { x: number; y: number; width: number; height: number },
): BoardItemEntry {
	const placement = box ? { position: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } } : centered(x, y, DEFAULT_SHAPE_SIZE);
	return { id, item: item({ type: "shape", ...placement, style: { stroke: color }, props: { geometry } }) };
}

export function createFrameBoardItem(
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.frame.color,
	label = "Frame",
	id = createBoardItemId(),
	box?: { x: number; y: number; width: number; height: number },
): BoardItemEntry {
	const placement = box ? { position: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } } : centered(x, y, DEFAULT_FRAME_SIZE);
	return { id, item: item({ type: "frame", ...placement, ...(color === "neutral" ? {} : { style: { stroke: color } }), props: { label } }) };
}

export type BoardAppMetadata = {
	appId: string;
	ref: string;
	url: string;
	name: string;
	icon?: string;
};

export function createAppBoardItem(app: BoardAppMetadata, x: number, y: number, id = createBoardItemId()): BoardItemEntry {
	const frame = createFrameBoardItem(x, y, "brand", app.name, id);
	return { id, item: { ...frame.item, metadata: { cohubApp: app } } };
}

export function createDrawBoardItem(
	worldPoints: Array<{ x: number; y: number; p: number }>,
	color: string,
	size: number = BOARD_DRAW_STROKE_SIZE,
	id = createBoardItemId(),
): BoardItemEntry {
	const origin = pointsRect(worldPoints);
	const points = worldPoints.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y, p: point.p }));
	return { id, item: item({ type: "draw", position: { x: origin.x, y: origin.y }, style: { stroke: color, strokeWidth: size }, props: { points } }) };
}

export function createArrowBoardItem(
	start: { x: number; y: number },
	end: { x: number; y: number } | { item: string },
	color: string,
	id = createBoardItemId(),
	size: number = DEFAULT_BOARD_TOOL_STYLES.arrow.size,
	startEnd?: { item: string; anchor?: unknown },
): BoardItemEntry {
	const local = (point: { x: number; y: number }) => ({ x: point.x - start.x, y: point.y - start.y });
	return {
		id,
		item: item({
			type: "arrow",
			position: { x: start.x, y: start.y },
			style: { stroke: color, strokeWidth: size },
			props: {
				start: startEnd ?? { x: 0, y: 0 },
				end: "item" in end ? end : local(end),
			},
		}),
	};
}

export function titleForBoardItem(value: BoardItem): string {
	switch (value.type) {
		case "text":
			return value.props.text.split("\n")[0] || "Text";
		case "shape":
			return value.props.text.split("\n")[0] || value.props.geometry;
		case "draw":
			return "Drawing";
		case "arrow":
			return value.props.label || "Arrow";
		case "frame":
			return value.props.label || "Frame";
		case "image":
		case "video":
		case "audio":
			return value.props.snapshot?.title ?? getResourceTitle(value.props.src);
		case "file":
			return value.props.snapshot?.title ?? fileStem(value.props.src);
		case "task":
			return value.props.snapshot.title;
		case "effect":
			return value.props.kind;
		case "sketch":
			return value.props.src.split("/").pop() ?? "Sketch";
		default:
			return value.type;
	}
}

export function subtitleForBoardItem(value: BoardItem): string {
	switch (value.type) {
		case "shape":
			return value.props.geometry;
		case "draw":
			return "Drawing";
		case "text":
		case "arrow":
		case "frame":
		case "image":
		case "video":
		case "audio":
		case "file":
		case "task":
		case "effect":
		case "sketch":
			return value.type[0]?.toUpperCase() + value.type.slice(1);
		default:
			return value.type;
	}
}

export function textDraftSize(text: string, fontSize: number) {
	return layoutBoardText({ text, fontSize, fontWeight: 500, font: "sans", lineHeight: 4 / 3 });
}
