import {
	BOARD_TEXT_FONT_FAMILY,
	BOARD_TEXT_FONT_SIZE,
	BOARD_TEXT_LINE_HEIGHT,
	BOARD_TEXT_MAX_FONT_SIZE,
	BOARD_TEXT_MIN_FONT_SIZE,
} from "@cohub/protocol/board-constants";
import { type BoardTextLayout, layoutBoardText } from "@cohub/protocol";

export { clampBoardFontSize as clampBoardTextFontSize } from "@cohub/protocol";

export const TEXT_FONT_FAMILY = BOARD_TEXT_FONT_FAMILY;
export const TEXT_FONT_SIZE = BOARD_TEXT_FONT_SIZE;
export const TEXT_LINE_HEIGHT = BOARD_TEXT_LINE_HEIGHT;
export const TEXT_MIN_FONT_SIZE = BOARD_TEXT_MIN_FONT_SIZE;
export const TEXT_MAX_FONT_SIZE = BOARD_TEXT_MAX_FONT_SIZE;

export function boardFontFamily(font: string, stacks: { sans: string; serif: string; mono: string }): string {
	if (font === "sans" || font === "serif" || font === "mono") return stacks[font];
	return `"${font.replaceAll('"', "")}", ${stacks.sans}`;
}

export const SHAPE_LABEL_PADDING = 8;

export function layoutShapeLabel(props: { text: string; fontSize: number }, width: number): BoardTextLayout {
	return layoutBoardText({
		text: props.text,
		fontSize: props.fontSize,
		fontWeight: 500,
		font: "sans",
		lineHeight: 1.4,
		width: Math.max(1, width - SHAPE_LABEL_PADDING * 2),
	});
}

export const BOARD_FRAME_LABEL_SIZE = 12;
export const BOARD_FRAME_LABEL_LINE_HEIGHT = 1.25;

export function frameLabelOffset(size: number): { x: number; y: number } {
	return { x: 4, y: -(size + 6) };
}

export function frameLabelHitRect(
	frame: { x: number; y: number; width: number },
	size: number,
): { x: number; y: number; width: number; height: number } {
	const above = size + 10;
	return { x: frame.x, y: frame.y - above, width: Math.max(48, frame.width * 0.5), height: above + 2 };
}

export function boardEditableText(item: { type: string; props: unknown }): string | null {
	const props = item.props as { text?: string; label?: string };
	if (item.type === "text" || item.type === "shape") return props.text ?? "";
	if (item.type === "arrow" || item.type === "frame") return props.label ?? "";
	return null;
}
