export type BoardToolId =
	| "select"
	| "hand"
	| "text"
	| "shape"
	| "draw"
	| "arrow"
	| "frame";

export const BOARD_HAND_TAP_SLOP = 8;

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
