import type { BoardDrawItem, BoardShapeItem } from "@cohub/protocol";
import { BOARD_DRAW_STROKE_SIZE } from "@cohub/protocol/board-constants";
import { computeDrawBounds, distanceToStroke } from "../draw-geometry.js";
import {
	degToRad,
	frameContainsPoint,
	itemBounds,
	rectCenter,
	rectContainsPoint,
	rotatePointAround,
	type WorldPoint,
	worldPoint,
} from "../geometry.js";
import type { BoardSceneItem, SceneItem } from "../scene.js";
import { type BoardItemDefinition, defineBoardItem } from "./definition.js";

function frameLocalPoint(item: BoardSceneItem, point: WorldPoint): WorldPoint {
	const center = rectCenter(item.frame);
	const rotated = item.frame.rotation ? rotatePointAround(point, center, -degToRad(item.frame.rotation)) : point;
	return worldPoint(rotated.x - item.frame.x, rotated.y - item.frame.y);
}

const textItem = defineBoardItem({ type: "text", capabilities: { canEdit: true, aspectLocked: true } });
const imageItem = defineBoardItem({ type: "image", capabilities: { aspectLocked: true } });
const videoItem = defineBoardItem({ type: "video", capabilities: { canRotate: false, aspectLocked: true } });
const audioItem = defineBoardItem({ type: "audio", capabilities: { canRotate: false } });
const fileItem = defineBoardItem({ type: "file", capabilities: { canRotate: false } });
const taskItem = defineBoardItem({ type: "task", capabilities: { canRotate: false, aspectLocked: true } });
const effectItem = defineBoardItem({ type: "effect", capabilities: { canConnect: false, canSnap: false } });
const sketchItem = defineBoardItem({ type: "sketch" });
const frameItem = defineBoardItem({ type: "frame", capabilities: { canEdit: true, canRotate: false, canConnect: false } });
const arrowItem = defineBoardItem({
	type: "arrow",
	capabilities: { canResize: false, canRotate: false, canEdit: true, canConnect: false, canSnap: false },
});

function shapeContainsLocal(item: SceneItem<BoardShapeItem>, local: WorldPoint): boolean {
	const w = item.frame.width;
	const h = item.frame.height;
	const nx = (local.x / w) * 2 - 1;
	const ny = (local.y / h) * 2 - 1;
	switch (item.props.geometry) {
		case "ellipse":
			return nx * nx + ny * ny <= 1;
		case "diamond":
			return Math.abs(nx) + Math.abs(ny) <= 1;
		case "triangle":
			return ny >= -1 && ny <= 1 && Math.abs(nx) <= (ny + 1) / 2;
		default:
			return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
	}
}

const shapeItem = defineBoardItem({
	type: "shape",
	capabilities: { canEdit: true },
	hitTest: (item, point) => {
		if (item.type !== "shape" || !frameContainsPoint(item.frame, point)) return false;
		return shapeContainsLocal(item as SceneItem<BoardShapeItem>, frameLocalPoint(item, point));
	},
});

const drawItem = defineBoardItem({
	type: "draw",
	capabilities: { aspectLocked: true, canConnect: false },
	hitTest: (item, point) => {
		if (item.type !== "draw" || !rectContainsPoint(itemBounds(item.frame), point, 8)) return false;
		const draw = item as SceneItem<BoardDrawItem>;
		const width = draw.style.strokeWidth ?? BOARD_DRAW_STROKE_SIZE;
		const box = computeDrawBounds(draw.props.points, width);
		const scale = item.frame.width / Math.max(0.0001, box.width);
		const local = frameLocalPoint(item, point);
		const inPoints = worldPoint(box.x + local.x / scale, box.y + local.y / scale);
		return distanceToStroke(draw.props.points, inPoints) <= Math.max(6, width) / Math.min(1, scale);
	},
});

export const builtinBoardItems: readonly BoardItemDefinition[] = [
	frameItem,
	textItem,
	shapeItem,
	drawItem,
	arrowItem,
	imageItem,
	videoItem,
	audioItem,
	fileItem,
	taskItem,
	effectItem,
	sketchItem,
];
