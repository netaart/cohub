
import {
	frameContainsPoint,
	itemBounds,
	type Rect,
	type WorldPoint,
} from "../geometry.js";
import type { BoardSceneItem as BoardItem } from "./scene.js";
import {
	resizeModeForCapabilities,
	type ShapeCapabilities,
	type ShapeGeometry,
	type ShapeHandle,
	type ShapeResizeMode,
} from "./shape-types.js";

export type ShapeDefinition = {
	type: string;
	capabilities: ShapeCapabilities;
	getBounds?: (item: BoardItem) => Rect;
	hitTest?: (item: BoardItem, point: WorldPoint) => boolean;
	getHandles?: (item: BoardItem) => ShapeHandle[];
	getGeometry?: (item: BoardItem) => ShapeGeometry;
};

const definitions = new Map<string, ShapeDefinition>();

export function registerShapeDefinition(definition: ShapeDefinition) {
	definitions.set(definition.type, definition);
}

export function getShapeDefinition(type: string): ShapeDefinition | undefined {
	return definitions.get(type);
}

export const unknownShapeDefinition: ShapeDefinition = {
	type: "__unknown__",
	capabilities: {
		canMove: true,
		canResize: true,
		aspectLocked: false,
		canRotate: true,
		canEdit: false,
		canConnect: true,
		canSnap: true,
		canLock: true,
	},
};

export function definitionForItem(item: BoardItem): ShapeDefinition {
	return definitions.get(item.type) ?? unknownShapeDefinition;
}


export function shapeBounds(item: BoardItem): Rect {
	const definition = definitionForItem(item);
	return definition.getBounds?.(item) ?? itemBounds(item.frame);
}

export function shapeHitTest(item: BoardItem, point: WorldPoint): boolean {
	const definition = definitionForItem(item);
	if (definition.hitTest) return definition.hitTest(item, point);
	return frameContainsPoint(item.frame, point);
}

export function shapeHandles(item: BoardItem): ShapeHandle[] {
	const definition = definitionForItem(item);
	return definition.getHandles?.(item) ?? [];
}

export function shapeCapabilities(item: BoardItem): ShapeCapabilities {
	return definitionForItem(item).capabilities;
}

export function shapeResizeMode(item: BoardItem): ShapeResizeMode {
	return resizeModeForCapabilities(shapeCapabilities(item));
}
