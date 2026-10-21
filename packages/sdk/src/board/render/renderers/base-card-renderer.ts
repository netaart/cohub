import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import { type Container, Text } from "pixi.js";
import type { BoardFrame } from "@cohub/protocol";

export function createLabel(text: string, style: Record<string, unknown>, resolution: number) {
	return new Text({ resolution, roundPixels: true, text, style: { fontFamily: BOARD_FONT_STACK, ...style } });
}

export function positionShell(root: Container, item: { frame: BoardFrame }) {
	const { x, y, width, height, rotation } = item.frame;
	root.pivot.set(width / 2, height / 2);
	root.x = x + width / 2;
	root.y = y + height / 2;
	root.rotation = ((rotation || 0) * Math.PI) / 180;
}
