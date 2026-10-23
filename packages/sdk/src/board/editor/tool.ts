export type BoardToolId =
	| "select"
	| "hand"
	| "text"
	| "shape"
	| "draw"
	| "arrow"
	| "frame";

export const BOARD_HAND_TAP_SLOP = 8;
export const BOARD_MOUSE_TAP_SLOP = 4;
export const BOARD_TAP_MAX_MS = 300;

export function boardTapSlop(pointerType: string): number {
	return pointerType === "mouse" ? BOARD_MOUSE_TAP_SLOP : BOARD_HAND_TAP_SLOP;
}

export function defaultBoardTool(isMobile: boolean): BoardToolId {
	return isMobile ? "hand" : "select";
}

export function canTapSelectWithHand(pointerType: string): boolean {
	return pointerType === "touch" || pointerType === "pen";
}

export function isWithinHandTapSlop(dx: number, dy: number): boolean {
	return (
		Number.isFinite(dx) &&
		Number.isFinite(dy) &&
		Math.hypot(dx, dy) <= BOARD_HAND_TAP_SLOP
	);
}

export function isContinuousBoardTool(tool: BoardToolId): boolean {
	return tool === "draw";
}

export function isCreationBoardTool(tool: BoardToolId): boolean {
	return (
		tool === "text" ||
		tool === "shape" ||
		tool === "draw" ||
		tool === "arrow" ||
		tool === "frame"
	);
}
