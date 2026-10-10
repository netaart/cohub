import { BOARD_ARROW_STROKE_SIZE, BOARD_DRAW_STROKE_SIZE, clampBoardStrokeSize } from "@cohub/protocol/board-constants";
import { type BoardColorId, isBoardColorId } from "./palette.js";
import { isShapeKind, type ShapeKind } from "./shape-types.js";

export { BOARD_STROKE_MAX_SIZE, BOARD_STROKE_MIN_SIZE, clampBoardStrokeSize } from "@cohub/protocol/board-constants";

export type BoardToolStyleMap = {
	text: { color: BoardColorId };
	shape: { color: BoardColorId; geometry: ShapeKind };
	draw: { color: BoardColorId; size: number };
	arrow: { color: BoardColorId; size: number };
	frame: { color: BoardColorId };
};

export type BoardStyledToolId = keyof BoardToolStyleMap;
export type BoardToolStylePatch = {
	[K in BoardStyledToolId]?: Partial<BoardToolStyleMap[K]>;
};

export const DEFAULT_BOARD_TOOL_STYLES = {
	text: { color: "neutral" },
	shape: { color: "brand", geometry: "rectangle" },
	draw: { color: "brand", size: BOARD_DRAW_STROKE_SIZE },
	arrow: { color: "brand", size: BOARD_ARROW_STROKE_SIZE },
	frame: { color: "neutral" },
} as const satisfies BoardToolStyleMap;

function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function colorOr(value: unknown, fallback: BoardColorId): BoardColorId {
	return isBoardColorId(value) ? value : fallback;
}

export function createBoardToolStyles(patch: BoardToolStylePatch = {}): BoardToolStyleMap {
	const defaults = DEFAULT_BOARD_TOOL_STYLES;
	return {
		text: { color: colorOr(patch.text?.color, defaults.text.color) },
		shape: {
			color: colorOr(patch.shape?.color, defaults.shape.color),
			geometry: isShapeKind(patch.shape?.geometry) ? patch.shape.geometry : defaults.shape.geometry,
		},
		draw: {
			color: colorOr(patch.draw?.color, defaults.draw.color),
			size: clampBoardStrokeSize(finiteOr(patch.draw?.size, defaults.draw.size)),
		},
		arrow: {
			color: colorOr(patch.arrow?.color, defaults.arrow.color),
			size: clampBoardStrokeSize(finiteOr(patch.arrow?.size, defaults.arrow.size)),
		},
		frame: { color: colorOr(patch.frame?.color, defaults.frame.color) },
	};
}
