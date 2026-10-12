import {
	BOARD_TEXT_FONT_FAMILY,
	BOARD_TEXT_FONT_SIZE,
	BOARD_TEXT_LINE_HEIGHT,
	BOARD_TEXT_MAX_FONT_SIZE,
	BOARD_TEXT_MIN_FONT_SIZE,
} from "@cohub/protocol/board-constants";

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
