import type { Graphics } from "pixi.js";
import type { BoardArrowItem } from "@cohub/protocol";
import type { BoardSelectionTransform, BoardTransformControl } from "../editor/index.js";
import {
	type BoardFrame,
	type BoardScene,
	type BoardSceneItem,
	CORNER_RESIZE_HANDLES,
	frameCorners,
	frameHandlePosition,
	frameRayIntersection,
	type Rect,
	type ResizeHandle,
	resolveSceneArrow,
	rotationHandleAnchor,
	rotationHandlePosition,
	type SceneItem,
	type WorldPoint,
} from "../model/index.js";
import {
	type BoardRenderPalette,
	type BoardRenderStyle,
	cardOutlinePoints,
	isBoardCard,
	tracePolyline,
	traceCardOutline,
} from "../render/index.js";

export type BoardOverlayInput = {
	zoom: number;
	pointerType: string;
	palette: BoardRenderPalette;
	style: BoardRenderStyle;
	scene: BoardScene;
	hovered: BoardSceneItem | null;
	selected: readonly BoardSceneItem[];
	march: number;
	marquee: Rect | null;
	transform: BoardSelectionTransform | null;
	controls: boolean;
	hoveredControl: BoardTransformControl | null;
	rotationPointer: WorldPoint | null;
	arrowEndpoints?: readonly WorldPoint[];
	ports?: ReadonlyArray<{ x: number; y: number; radius: number }>;
	hoveredPort?: { x: number; y: number } | null;
	bindTarget?: BoardFrame | null;
	projected?: (id: string) => readonly WorldPoint[] | null;
};

const HOVER_ALPHA = 0.55;
const PEER_ALPHA = 0.6;

export function expandFrame(frame: BoardFrame, by: number): BoardFrame {
	return { ...frame, x: frame.x - by, y: frame.y - by, width: frame.width + by * 2, height: frame.height + by * 2 };
}

function traceFrame(graphics: Graphics, frame: BoardFrame) {
	const corners = frameCorners(frame);
	const first = corners[0];
	if (!first) return graphics;
	graphics.moveTo(first.x, first.y);
	for (const point of corners.slice(1)) graphics.lineTo(point.x, point.y);
	return graphics.closePath();
}

function edgeOf(frame: BoardFrame, handle: ResizeHandle): readonly [WorldPoint, WorldPoint] | null {
	const at = (corner: ResizeHandle) => frameHandlePosition(frame, corner);
	switch (handle) {
		case "n":
			return [at("nw"), at("ne")];
		case "e":
			return [at("ne"), at("se")];
		case "s":
			return [at("sw"), at("se")];
		case "w":
			return [at("nw"), at("sw")];
		default:
			return null;
	}
}

type Line = { color: number; width: number; alpha: number };

function strokeOutline(
	graphics: Graphics,
	frame: BoardFrame,
	card: boolean,
	style: BoardRenderStyle,
	line: Line,
	inv: number,
	dash: number,
	march: number,
) {
	const shape = card ? style : { corner: "round" as const, radius: 0 };
	const rect = { x: -frame.width / 2, y: -frame.height / 2, width: frame.width, height: frame.height };
	const angle = ((frame.rotation || 0) * Math.PI) / 180;
	graphics.save();
	graphics.setTransform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), frame.x + frame.width / 2, frame.y + frame.height / 2);
	if (dash > 0) tracePolyline(graphics, cardOutlinePoints(rect, shape), [dash * inv, dash * inv], false, march * inv);
	else traceCardOutline(graphics, rect, shape);
	graphics.stroke({ ...line, cap: "butt", join: "miter" });
	graphics.restore();
}

function strokePolygon(graphics: Graphics, points: readonly WorldPoint[], line: Line) {
	const first = points[0];
	if (!first) return;
	graphics.moveTo(first.x, first.y);
	for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
	graphics.closePath().stroke({ ...line, join: "round" });
}

function drawHandle(graphics: Graphics, point: WorldPoint, style: BoardRenderStyle, palette: BoardRenderPalette, inv: number, active: boolean) {
	const size = (active ? style.selection.handleSize + 2 : style.selection.handleSize) * inv;
	if (style.selection.handle === "square") graphics.rect(point.x - size / 2, point.y - size / 2, size, size);
	else graphics.circle(point.x, point.y, size / 2);
	graphics.fill({ color: active ? palette.brand : palette.surface, alpha: 1 }).stroke({ color: palette.brand, width: style.selection.width * inv, alignment: 1 });
}

function strokeArrow(graphics: Graphics, item: BoardSceneItem, scene: BoardScene, color: number, inv: number, alpha: number) {
	const arrow = item as SceneItem<BoardArrowItem>;
	const path = resolveSceneArrow(arrow, scene).path;
	const first = path[0];
	if (!first) return;
	graphics.moveTo(first.x, first.y);
	for (const point of path.slice(1)) graphics.lineTo(point.x, point.y);
	graphics.stroke({ color, width: (arrow.style.strokeWidth ?? 2) + 6 * inv, alpha, cap: "round", join: "round" });
}

export function drawBoardOverlay(graphics: Graphics, input: BoardOverlayInput) {
	const { zoom, palette, style, scene, selected, transform, controls, hoveredControl } = input;
	const inv = 1 / Math.max(zoom, 0.0001);
	const brand = palette.brand;
	const outset = style.selection.outset * inv;

	if (input.marquee) {
		const { x, y, width, height } = input.marquee;
		graphics.rect(x, y, width, height).fill({ color: brand, alpha: 0.08 });
		graphics.rect(x, y, width, height).stroke({ color: brand, width: inv, alpha: 0.7 });
	}

	if (input.bindTarget) traceFrame(graphics, input.bindTarget).stroke({ color: brand, width: 2 * inv, alpha: 0.9 });

	for (const port of input.ports ?? []) {
		const hovered = input.hoveredPort && Math.abs(input.hoveredPort.x - port.x) < 0.001 && Math.abs(input.hoveredPort.y - port.y) < 0.001;
		const radius = (hovered ? port.radius * 1.5 : port.radius) * inv;
		if (style.corner === "pixel") graphics.rect(port.x - radius, port.y - radius, radius * 2, radius * 2);
		else graphics.circle(port.x, port.y, radius);
		graphics.fill({ color: palette.surface, alpha: 1 }).stroke({ color: brand, width: 1.5 * inv, alpha: hovered ? 1 : 0.8 });
	}

	const hovered = input.hovered;
	const hoverOutline = hovered ? input.projected?.(hovered.id) : null;
	if (hoverOutline) strokePolygon(graphics, hoverOutline, { color: palette.muted, width: inv * style.selection.width, alpha: HOVER_ALPHA });
	else if (hovered && hovered.type === "arrow") strokeArrow(graphics, hovered, scene, palette.muted, inv, 0.2);
	else if (hovered) strokeOutline(graphics, expandFrame(hovered.frame, outset), isBoardCard(hovered), style, { color: palette.muted, width: inv * style.selection.width, alpha: HOVER_ALPHA }, inv, 0, 0);

	if (selected.length === 0) return;
	const single = selected.length === 1 ? selected[0] : undefined;
	const dash = style.selection.dash;
	const line = { color: brand, width: style.selection.width * inv, alpha: 1 };
	let lifted = false;
	for (const item of selected) {
		const outline = input.projected?.(item.id);
		if (outline) {
			lifted = true;
			strokePolygon(graphics, outline, single ? line : { ...line, alpha: PEER_ALPHA });
		} else if (item.type === "arrow") strokeArrow(graphics, item, scene, brand, inv, 0.3);
		else if (!single) strokeOutline(graphics, expandFrame(item.frame, outset), isBoardCard(item), style, { ...line, alpha: PEER_ALPHA }, inv, 0, 0);
	}
	if (!transform || lifted) return;
	if (single?.type !== "arrow") {
		const card = single ? isBoardCard(single) : false;
		strokeOutline(graphics, expandFrame(transform.frame, outset), card, style, line, inv, dash, input.march);
	}
	if (!controls) return;

	if (input.arrowEndpoints?.length) {
		for (const point of input.arrowEndpoints) drawHandle(graphics, point, style, palette, inv, false);
		return;
	}

	const frame = expandFrame(transform.frame, outset);
	if (hoveredControl?.kind === "resize" && transform.resizeMode === "free") {
		const edge = edgeOf(frame, hoveredControl.handle);
		if (edge) graphics.moveTo(edge[0].x, edge[0].y).lineTo(edge[1].x, edge[1].y).stroke({ color: brand, width: 2.5 * inv, alpha: 1 });
	}

	if (transform.resizeMode !== "none") {
		for (const handle of CORNER_RESIZE_HANDLES) {
			const active = hoveredControl?.kind === "resize" && hoveredControl.handle === handle;
			drawHandle(graphics, frameHandlePosition(frame, handle), style, palette, inv, active);
		}
	}

	if (transform.canRotate && (input.pointerType === "touch" || transform.resizeMode === "none")) {
		const pointer = input.rotationPointer;
		const rotation = pointer ?? rotationHandlePosition(frame, zoom);
		const anchor = pointer ? frameRayIntersection(frame, pointer) : rotationHandleAnchor(frame);
		const active = pointer !== null || hoveredControl?.kind === "rotate";
		graphics.moveTo(anchor.x, anchor.y).lineTo(rotation.x, rotation.y).stroke({ color: brand, width: inv, alpha: 0.8 });
		graphics
			.circle(rotation.x, rotation.y, (active ? 6 : 5) * inv)
			.fill({ color: active ? brand : palette.surface })
			.stroke({ color: brand, width: 1.5 * inv });
	}
}

export const BOARD_PRESENT_BACKDROP = 0x1e1e1e;

export function drawBoardFrameMask(graphics: Graphics, view: Rect, hole: Rect, color = BOARD_PRESENT_BACKDROP) {
	graphics.rect(view.x, view.y, view.width, view.height).fill({ color });
	graphics.rect(hole.x, hole.y, hole.width, hole.height).cut();
}
