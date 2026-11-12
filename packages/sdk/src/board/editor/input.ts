/** Every threshold that turns raw input into a click, drag, hold or camera move. */
export const BOARD_INPUT = {
	dragSlop: { mouse: 4, touch: 12, pen: 8 },
	tapMs: 300,
	longPressMs: 450,
	doubleTapMs: 300,
	doubleTapSlop: 24,
	multiTapMs: 250,
	touchHitSlop: 8,
	wheelGapMs: 150,
	pinchSettleMs: 250,
	wheelEaseMs: 120,
	flingSampleMs: 80,
	flingDecay: 0.95,
	flingStop: 0.02,
	flingCatch: 0.1,
	swipeDistance: 0.2,
	swipeVelocity: 0.4,
	edgeZone: 32,
	edgeSpeed: 900,
	ghostClickMs: 700,
} as const;

export function boardDragSlop(pointerType: string): number {
	return pointerType === "mouse" ? BOARD_INPUT.dragSlop.mouse : pointerType === "pen" ? BOARD_INPUT.dragSlop.pen : BOARD_INPUT.dragSlop.touch;
}

export function isTouchLikePointer(pointerType: string): boolean {
	return pointerType === "touch" || pointerType === "pen";
}
