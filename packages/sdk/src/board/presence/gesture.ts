import {
	BOARD_AWARENESS_MAX_VIEWPORT_ZOOM,
	BOARD_AWARENESS_MIN_VIEWPORT_ZOOM,
	BOARD_AWARENESS_WORLD_COORDINATE_LIMIT,
	BOARD_AWARENESS_WORLD_EXTENT_LIMIT,
	type BoardAwarenessGesture,
	type BoardAwarenessItemPreview,
	type BoardAwarenessStateUpdate,
	type BoardAwarenessViewport,
} from "@cohub/protocol/realtime";
import type { BoardEditor, BoardInteraction } from "../editor/index.js";
import { type BoardFrame, type BoardViewport, selectionBounds } from "../model/index.js";

export const MAX_PREVIEW_NODES = 64;
const VIEWPORT_POSITION_THRESHOLD_PX = 2;
const VIEWPORT_ZOOM_THRESHOLD = 0.005;

export function boardAwarenessViewport(
	camera: BoardViewport,
	surface: { width: number; height: number },
): BoardAwarenessViewport | null {
	const { x, y, zoom } = camera;
	if (
		![x, y, zoom, surface.width, surface.height].every(Number.isFinite) ||
		zoom < BOARD_AWARENESS_MIN_VIEWPORT_ZOOM ||
		zoom > BOARD_AWARENESS_MAX_VIEWPORT_ZOOM ||
		surface.width <= 0 ||
		surface.height <= 0
	)
		return null;
	const viewport = { x: -x / zoom, y: -y / zoom, width: surface.width / zoom, height: surface.height / zoom, zoom };
	if (
		Math.abs(viewport.x) > BOARD_AWARENESS_WORLD_COORDINATE_LIMIT ||
		Math.abs(viewport.y) > BOARD_AWARENESS_WORLD_COORDINATE_LIMIT ||
		viewport.width > BOARD_AWARENESS_WORLD_EXTENT_LIMIT ||
		viewport.height > BOARD_AWARENESS_WORLD_EXTENT_LIMIT
	)
		return null;
	return viewport;
}

export function viewportChanged(current: BoardAwarenessViewport | null, next: BoardAwarenessViewport | null): boolean {
	if (!current || !next) return current !== next;
	const shift =
		Math.hypot(next.x + next.width / 2 - current.x - current.width / 2, next.y + next.height / 2 - current.y - current.height / 2) *
		next.zoom;
	return (
		shift >= VIEWPORT_POSITION_THRESHOLD_PX ||
		Math.abs(next.zoom - current.zoom) / Math.max(current.zoom, next.zoom) >= VIEWPORT_ZOOM_THRESHOLD ||
		Math.abs(next.width * next.zoom - current.width * current.zoom) >= VIEWPORT_POSITION_THRESHOLD_PX ||
		Math.abs(next.height * next.zoom - current.height * current.zoom) >= VIEWPORT_POSITION_THRESHOLD_PX
	);
}

function transformIds(interaction: BoardInteraction): string[] {
	switch (interaction.type) {
		case "translating":
		case "resizing":
		case "rotating":
			return [...interaction.origin.keys()];
		case "draggingArrowHandle":
			return [interaction.arrowId];
		default:
			return [];
	}
}

const TRANSFORM_MODES = { translating: "translate", resizing: "resize", rotating: "rotate", draggingArrowHandle: "arrow" } as const;

export function boardAwarenessGesture(editor: BoardEditor): BoardAwarenessGesture | null {
	const interaction = editor.interaction;
	switch (interaction.type) {
		case "drawing":
			return {
				kind: "draw",
				id: interaction.id,
				itemId: interaction.id,
				color: interaction.color,
				size: interaction.size,
				from: 0,
				points: interaction.points.slice(0, MAX_PREVIEW_NODES),
			};
		case "creatingArrow":
			return {
				kind: "arrow",
				id: interaction.id,
				itemId: interaction.id,
				start: interaction.start,
				current: interaction.current,
				startItemId: interaction.startItemId,
				endItemId: interaction.targetItemId,
				color: interaction.color,
				size: interaction.size,
			};
		case "creatingBox":
			return {
				kind: "box",
				id: interaction.id,
				itemId: interaction.id,
				shape: interaction.kind,
				start: interaction.start,
				current: interaction.current,
				color: interaction.color,
				geometry: interaction.geometry,
			};
		case "translating":
		case "resizing":
		case "rotating":
		case "draggingArrowHandle": {
			const ids = transformIds(interaction);
			const frames: BoardFrame[] = [];
			const items: BoardAwarenessItemPreview[] = [];
			for (const id of ids) {
				const item = editor.itemById(id);
				if (!item) continue;
				frames.push(item.frame);
				if (items.length < MAX_PREVIEW_NODES) items.push({ itemId: id, frame: { ...item.frame } });
			}
			const bounds = selectionBounds(frames);
			return {
				kind: "transform",
				id:
					interaction.type === "draggingArrowHandle"
						? `gesture_${interaction.arrowId}`
						: `gesture_${ids.length}_${ids.slice(0, 3).join("_").slice(0, 100)}`,
				mode: TRANSFORM_MODES[interaction.type],
				items,
				bounds: bounds ? { ...bounds, rotation: 0 } : null,
			};
		}
		default:
			return null;
	}
}

export function sameFrame(a: BoardFrame, b: BoardFrame): boolean {
	return (
		Math.abs(a.x - b.x) < 0.01 &&
		Math.abs(a.y - b.y) < 0.01 &&
		Math.abs(a.width - b.width) < 0.01 &&
		Math.abs(a.height - b.height) < 0.01 &&
		Math.abs(a.rotation - b.rotation) < 0.01
	);
}

export function sameAwarenessState(a: BoardAwarenessStateUpdate | null, b: BoardAwarenessStateUpdate): boolean {
	if (!a) return false;
	const ab = a.selection.bounds;
	const bb = b.selection.bounds;
	return (
		a.client?.formFactor === b.client?.formFactor &&
		a.client?.scripts === b.client?.scripts &&
		a.tool === b.tool &&
		a.editingId === b.editingId &&
		a.cursor?.x === b.cursor?.x &&
		a.cursor?.y === b.cursor?.y &&
		a.cursor?.pointerType === b.cursor?.pointerType &&
		!viewportChanged(a.viewport ?? null, b.viewport ?? null) &&
		a.selection.count === b.selection.count &&
		(ab === bb || (ab !== null && bb !== null && sameFrame(ab, bb))) &&
		a.selection.ids.length === b.selection.ids.length &&
		a.selection.ids.every((id, index) => id === b.selection.ids[index])
	);
}
