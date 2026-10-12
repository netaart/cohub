import { BOARD_SHAPE_GEOMETRIES, type BoardShapeGeometry } from "@cohub/protocol";

export type ShapeKind = Exclude<BoardShapeGeometry, "path">;
export const SHAPE_KINDS = BOARD_SHAPE_GEOMETRIES.filter((kind): kind is ShapeKind => kind !== "path");

export function isShapeKind(value: unknown): value is ShapeKind {
	return typeof value === "string" && (SHAPE_KINDS as readonly string[]).includes(value);
}
