import {
	type BoardItem,
	type BoardMediaOrigin,
	BoardMediaOriginSchema,
	type BoardMediaSnapshot,
	type BoardTaskArtifact,
	type BoardTaskSnapshot,
	fitBoardMediaSize,
	parseBoardItem,
	pointsRect,
} from "@cohub/protocol";
import { BOARD_DEFAULT_SIZES, BOARD_DRAW_STROKE_SIZE, BOARD_MEDIA_EDGE } from "@cohub/protocol/board-constants";
import { quantizeDrawCoordinate } from "../draw-input.js";
import { filePreviewKind } from "../file-preview.js";
import { type BoardFileSnapshotFacts, fileStem } from "../file-snapshot.js";
import { MIN_ITEM_SIZE } from "../geometry.js";
import { boardModelFormat, getMediaResourceTitle as getResourceTitle, inferBoardMediaKind as inferMediaKind } from "../media.js";
import type { ShapeKind } from "../shape-types.js";
import { featuredTaskArtifact } from "@cohub/protocol";
import { DEFAULT_BOARD_TOOL_STYLES } from "../tool-styles.js";
import { createBoardItemId } from "./id.js";

export type BoardItemEntry = { id: string; item: BoardItem };

const DEFAULT_MODEL_SIZE = { width: 264, height: 264 };
const DEFAULT_FILE_COVER_SIZE = { width: 260, height: 208 };

function item(value: Record<string, unknown>): BoardItem {
	const parsed = parseBoardItem(value);
	if (!parsed.ok)
		throw new Error(
			`Invalid Board item: ${parsed.diagnostics[0]?.path}: ${parsed.diagnostics[0]?.message}`,
		);
	return parsed.item;
}

function centered(
	x: number,
	y: number,
	size: { width: number; height: number },
) {
	return {
		position: { x: x - size.width / 2, y: y - size.height / 2 },
		size: { ...size },
	};
}

export function mediaFrameSize(
	naturalWidth?: number | null,
	naturalHeight?: number | null,
	maxEdge = BOARD_MEDIA_EDGE,
	fallback: { width: number; height: number } = BOARD_DEFAULT_SIZES.image,
): { width: number; height: number } {
	const natural = { width: naturalWidth ?? 0, height: naturalHeight ?? 0 };
	const size = fitBoardMediaSize(natural, Math.min(maxEdge, Math.max(natural.width, natural.height)));
	if (!size) return { ...fallback };
	return { width: Math.max(MIN_ITEM_SIZE, size.width), height: Math.max(MIN_ITEM_SIZE, size.height) };
}

function cleanSnapshot(snapshot: BoardMediaSnapshot): BoardMediaSnapshot {
	return Object.fromEntries(
		Object.entries(snapshot).filter(([, value]) => value !== undefined),
	) as BoardMediaSnapshot;
}

export type BoardMediaItemKind = "image" | "video" | "audio" | "file";

export function createMediaBoardItem(
	path: string,
	x: number,
	y: number,
	snapshot: BoardMediaSnapshot & BoardFileSnapshotFacts = {},
	id = createBoardItemId(),
	mediaKind?: BoardMediaItemKind,
): BoardItemEntry {
	const kind = mediaKind ?? inferMediaKind(path, snapshot.mimeType);
	const title =
		snapshot.title ??
		(kind === "file" || kind === "text"
			? fileStem(path)
			: getResourceTitle(path));
	if (kind === "image" || kind === "video") {
		const size = mediaFrameSize(
			snapshot.naturalWidth,
			snapshot.naturalHeight,
			BOARD_MEDIA_EDGE,
			BOARD_DEFAULT_SIZES[kind],
		);
		const mimeType =
			snapshot.mimeType ?? (kind === "video" ? "video/*" : undefined);
		return {
			id,
			item: item({
				type: kind,
				...centered(x, y, size),
				props: {
					src: path,
					snapshot: cleanSnapshot({ ...snapshot, title, mimeType }),
				},
			}),
		};
	}
	if (kind === "audio") {
		return {
			id,
			item: item({
				type: "audio",
				...centered(x, y, BOARD_DEFAULT_SIZES.audio),
				props: {
					src: path,
					snapshot: cleanSnapshot({
						...snapshot,
						title,
						mimeType: snapshot.mimeType ?? "audio/*",
					}),
				},
			}),
		};
	}
	const size = boardModelFormat(path, snapshot.mimeType)
		? DEFAULT_MODEL_SIZE
		: filePreviewKind(snapshot) === "cover"
			? DEFAULT_FILE_COVER_SIZE
			: BOARD_DEFAULT_SIZES.file;
	return {
		id,
		item: item({
			type: "file",
			...centered(x, y, size),
			props: { src: path, snapshot: cleanSnapshot({ ...snapshot, title }) },
		}),
	};
}

export const createFileNodeForPath = createMediaBoardItem;

export function boardTaskCardSize(snapshot: BoardTaskSnapshot, aspect?: number): { width: number; height: number } {
	const artifact = featuredTaskArtifact(snapshot.artifacts);
	const expected = fitBoardMediaSize({ width: aspect ?? 0, height: 1 }, BOARD_MEDIA_EDGE) ?? { ...BOARD_DEFAULT_SIZES.task };
	return artifact?.type === "image" || artifact?.type === "video"
		? mediaFrameSize(artifact.naturalWidth, artifact.naturalHeight, BOARD_MEDIA_EDGE, expected)
		: expected;
}

export function createTaskBoardItem(
	taskRunId: string,
	snapshot: BoardTaskSnapshot,
	x: number,
	y: number,
	metadata?: Record<string, unknown>,
	id = createBoardItemId(),
	aspect?: number,
): BoardItemEntry {
	const size = boardTaskCardSize(snapshot, aspect);
	return {
		id,
		item: item({
			type: "task",
			...centered(x, y, size),
			...(metadata ? { metadata } : {}),
			props: { taskRunId, snapshot },
		}),
	};
}

export function createTextBoardItem(
	text: string,
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.text.color,
	id = createBoardItemId(),
): BoardItemEntry {
	return {
		id,
		item: item({
			type: "text",
			position: { x, y },
			...(color === "neutral" ? {} : { style: { fill: color } }),
			props: { text },
		}),
	};
}

export function createShapeBoardItem(
	geometry: ShapeKind,
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.shape.color,
	id = createBoardItemId(),
	box?: { x: number; y: number; width: number; height: number },
): BoardItemEntry {
	const placement = box
		? {
				position: { x: box.x, y: box.y },
				size: { width: box.width, height: box.height },
			}
		: centered(x, y, BOARD_DEFAULT_SIZES.shape);
	return {
		id,
		item: item({
			type: "shape",
			...placement,
			style: { stroke: color },
			props: { geometry },
		}),
	};
}

export function createFrameBoardItem(
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.frame.color,
	label = "Frame",
	id = createBoardItemId(),
	box?: { x: number; y: number; width: number; height: number },
): BoardItemEntry {
	const placement = box
		? {
				position: { x: box.x, y: box.y },
				size: { width: box.width, height: box.height },
			}
		: centered(x, y, BOARD_DEFAULT_SIZES.frame);
	return {
		id,
		item: item({
			type: "frame",
			...placement,
			...(color === "neutral" ? {} : { style: { stroke: color } }),
			props: { label },
		}),
	};
}

export type BoardAppMetadata = {
	appId: string;
	ref: string;
	url: string;
	name: string;
	icon?: string;
};

export function createAppBoardItem(
	app: BoardAppMetadata,
	x: number,
	y: number,
	id = createBoardItemId(),
): BoardItemEntry {
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
	const points = worldPoints.map((point) => ({
		x: quantizeDrawCoordinate(point.x - origin.x),
		y: quantizeDrawCoordinate(point.y - origin.y),
		p: point.p,
	}));
	return {
		id,
		item: item({
			type: "draw",
			position: { x: origin.x, y: origin.y },
			style: { stroke: color, strokeWidth: size },
			props: { points },
		}),
	};
}

export function createArrowBoardItem(
	start: { x: number; y: number },
	end: { x: number; y: number } | { item: string },
	color: string,
	id = createBoardItemId(),
	size: number = DEFAULT_BOARD_TOOL_STYLES.arrow.size,
	startEnd?: { item: string; anchor?: unknown },
): BoardItemEntry {
	const local = (point: { x: number; y: number }) => ({
		x: point.x - start.x,
		y: point.y - start.y,
	});
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
		case "custom":
			return value.script.src.split("/").pop() ?? "Custom";
		default:
			return value.type;
	}
}

const RESULT_GAP = 24;
const RESULT_COLUMNS = 4;
const RESULT_TEXT_WIDTH = 320;
const RESULT_MIN_HEIGHT = 120;
const RESULT_MAX_HEIGHT = BOARD_MEDIA_EDGE;

export function boardItemOrigin(item: BoardItem): BoardMediaOrigin | null {
	if (item.type === "image" || item.type === "video" || item.type === "audio") return item.props.origin ?? null;
	if (item.type !== "text") return null;
	const parsed = BoardMediaOriginSchema.safeParse(item.metadata?.origin);
	return parsed.success ? parsed.data : null;
}

export const boardOriginKey = (origin: BoardMediaOrigin) => `${origin.taskRunId}/${origin.artifactId}`;

export function createTaskResultItems(input: {
	taskRunId: string;
	frame: { x: number; y: number; width: number; height: number };
	artifacts: readonly BoardTaskArtifact[];
	existing?: ReadonlySet<string>;
}): BoardItemEntry[] {
	const rowHeight = Math.min(RESULT_MAX_HEIGHT, Math.max(RESULT_MIN_HEIGHT, input.frame.height));
	const left = input.frame.x + input.frame.width + RESULT_GAP * 2;
	const entries: BoardItemEntry[] = [];
	let column = 0;
	let x = left;
	let y = input.frame.y;
	let tallest = 0;
	for (const artifact of input.artifacts) {
		if (input.existing?.has(boardOriginKey({ taskRunId: input.taskRunId, artifactId: artifact.id }))) continue;
		if (column === RESULT_COLUMNS) {
			column = 0;
			x = left;
			y += tallest + RESULT_GAP;
			tallest = 0;
		}
		const entry = taskResultItem(input.taskRunId, artifact, x, y, rowHeight);
		const size = "size" in entry.item && entry.item.size ? entry.item.size : { width: RESULT_TEXT_WIDTH, height: rowHeight };
		entries.push(entry);
		x += size.width + RESULT_GAP;
		tallest = Math.max(tallest, size.height);
		column += 1;
	}
	return entries;
}

function taskResultItem(
	taskRunId: string,
	artifact: BoardTaskArtifact,
	x: number,
	y: number,
	rowHeight: number,
): BoardItemEntry {
	const id = createBoardItemId();
	const origin = { taskRunId, artifactId: artifact.id };
	if (artifact.type === "text") {
		return {
			id,
			item: item({ type: "text", position: { x, y }, metadata: { origin }, props: { text: artifact.textExcerpt, width: RESULT_TEXT_WIDTH } }),
		};
	}
	const snapshot = cleanSnapshot({
		title: artifact.title,
		mimeType: artifact.mimeType,
		...(artifact.type !== "audio" ? { naturalWidth: artifact.naturalWidth, naturalHeight: artifact.naturalHeight } : {}),
		...(artifact.type !== "image" ? { durationMs: artifact.durationMs } : {}),
	});
	if (artifact.type === "audio") {
		return {
			id,
			item: item({ type: "audio", position: { x, y }, size: { ...BOARD_DEFAULT_SIZES.audio }, props: { src: artifact.url, snapshot, origin } }),
		};
	}
	const fallback = BOARD_DEFAULT_SIZES[artifact.type];
	const ratio = artifact.naturalWidth && artifact.naturalHeight
		? artifact.naturalWidth / artifact.naturalHeight
		: fallback.width / fallback.height;
	return {
		id,
		item: item({
			type: artifact.type,
			position: { x, y },
			size: { width: Math.round(rowHeight * ratio), height: rowHeight },
			props: { src: artifact.url, snapshot, origin },
		}),
	};
}
