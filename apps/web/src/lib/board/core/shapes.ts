
import {
	type BoardDrawItem,
	type BoardSceneItem,
	type BoardShapeItem,
	computeDrawBounds,
	degToRad,
	distanceToStroke,
	FULL_CAPABILITIES,
	frameContainsPoint,
	itemBounds,
	rectCenter,
	rectContainsPoint,
	registerShapeDefinition,
	rotatePointAround,
	type SceneItem,
	type ShapeDefinition,
	type WorldPoint,
	worldPoint,
} from "@neta-art/cohub/board";
import { BOARD_DRAW_STROKE_SIZE } from "@cohub/protocol/board-constants";

function frameLocalPoint(item: BoardSceneItem, point: WorldPoint): WorldPoint {
	const center = rectCenter(item.frame);
	const rotated = item.frame.rotation ? rotatePointAround(point, center, -degToRad(item.frame.rotation)) : point;
	return worldPoint(rotated.x - item.frame.x, rotated.y - item.frame.y);
}

const textDefinition: ShapeDefinition = {
	type: "text",
	capabilities: { ...FULL_CAPABILITIES, canEdit: true, aspectLocked: true },
};

const imageDefinition: ShapeDefinition = {
	type: "image",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: true,
		aspectLocked: true,
	},
};

const videoDefinition: ShapeDefinition = {
	type: "video",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
		aspectLocked: true,
	},
};

const audioDefinition: ShapeDefinition = {
	type: "audio",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
	},
};

const fileDefinition: ShapeDefinition = {
	type: "file",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
	},
};

const taskDefinition: ShapeDefinition = {
	type: "task",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
		aspectLocked: true,
	},
};

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

const shapeDefinition: ShapeDefinition = {
	type: "shape",
	capabilities: { ...FULL_CAPABILITIES, canEdit: true },
	hitTest: (item, point) => {
		if (item.type !== "shape" || !frameContainsPoint(item.frame, point)) return false;
		return shapeContainsLocal(item as SceneItem<BoardShapeItem>, frameLocalPoint(item, point));
	},
};

const drawDefinition: ShapeDefinition = {
	type: "draw",
	capabilities: { ...FULL_CAPABILITIES, canResize: true, aspectLocked: true, canEdit: false, canConnect: false, canRotate: true },
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
};

const arrowDefinition: ShapeDefinition = {
	type: "arrow",
	capabilities: { ...FULL_CAPABILITIES, canResize: false, canRotate: false, canEdit: true, canConnect: false, canSnap: false },
};

const effectDefinition: ShapeDefinition = {
	type: "effect",
	capabilities: { ...FULL_CAPABILITIES, canEdit: false, canConnect: false, canSnap: false },
};

const sketchDefinition: ShapeDefinition = {
	type: "sketch",
	capabilities: { ...FULL_CAPABILITIES, canEdit: false },
};

const frameDefinition: ShapeDefinition = {
	type: "frame",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: true,
		canRotate: false,
		canConnect: false,
	},
};

let registered = false;

export function registerBuiltinShapes() {
	if (registered) return;
	registered = true;
	for (const definition of [
		textDefinition,
		imageDefinition,
		videoDefinition,
		audioDefinition,
		fileDefinition,
		taskDefinition,
		shapeDefinition,
		drawDefinition,
		arrowDefinition,
		frameDefinition,
		effectDefinition,
		sketchDefinition,
	])
		registerShapeDefinition(definition);
}

registerBuiltinShapes();
