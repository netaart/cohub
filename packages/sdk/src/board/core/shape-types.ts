
import type { Rect, WorldPoint } from "../geometry.js";
import { BOARD_SHAPE_GEOMETRIES, type BoardFrame, type BoardShapeGeometry } from "@cohub/protocol";


export type ShapeGeometry = {
	bounds: Rect;
	containsWorldPoint?: (frame: BoardFrame, point: WorldPoint) => boolean;
};


export type ShapeHandleId = string;

export type ShapeHandle = {
	id: ShapeHandleId;
	x: number;
	y: number;
	radius?: number;
};

export type HandleDragResult = {
	frame?: BoardFrame;
	props?: Record<string, unknown>;
};


export type ShapeCapabilities = {
	canMove: boolean;
	canResize: boolean;
	aspectLocked: boolean;
	canRotate: boolean;
	canEdit: boolean;
	canConnect: boolean;
	canSnap: boolean;
	canLock: boolean;
};

export type ShapeResizeMode = "none" | "uniform" | "free";

export function resizeModeForCapabilities(
	capabilities: ShapeCapabilities,
): ShapeResizeMode {
	if (!capabilities.canResize) return "none";
	return capabilities.aspectLocked ? "uniform" : "free";
}

export const FULL_CAPABILITIES: ShapeCapabilities = {
	canMove: true,
	canResize: true,
	aspectLocked: false,
	canRotate: true,
	canEdit: false,
	canConnect: true,
	canSnap: true,
	canLock: true,
};


export type ShapeKind = Exclude<BoardShapeGeometry, "path">;
export const SHAPE_KINDS = BOARD_SHAPE_GEOMETRIES.filter((kind): kind is ShapeKind => kind !== "path");

export function isShapeKind(value: unknown): value is ShapeKind {
	return typeof value === "string" && (SHAPE_KINDS as readonly string[]).includes(value);
}
