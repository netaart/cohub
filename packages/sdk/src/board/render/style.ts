import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import { BOARD_FRAME_LABEL_SIZE } from "../model/text-metrics.js";

export type BoardRenderStyle = {
	corner: "round" | "pixel";
	radius: number;
	shadow: BoardShadowStyle | null;
	selection: BoardSelectionStyle;
	media: "plain" | "framed";
	progress: "shimmer" | "mosaic";
	icons: "line" | "pixel";
	motion: "smooth" | "stepped";
	font: string;
	frameLabelSize: number;
};

export type BoardShadowStyle = {
	color: number;
	alpha: number;
	blur: number;
	y: number;
};

export type BoardSelectionStyle = {
	width: number;
	outset: number;
	dash: number;
	handle: "circle" | "square";
	handleSize: number;
};

const BASE: Omit<BoardRenderStyle, "shadow"> = {
	corner: "round",
	radius: 6,
	selection: { width: 1.5, outset: 3, dash: 0, handle: "square", handleSize: 8 },
	media: "plain",
	progress: "shimmer",
	icons: "line",
	motion: "smooth",
	font: BOARD_FONT_STACK,
	frameLabelSize: BOARD_FRAME_LABEL_SIZE,
};

const SHADOW: Record<"dark" | "light", BoardShadowStyle> = {
	light: { color: 0x161718, alpha: 0.06, blur: 12, y: 2 },
	dark: { color: 0x000000, alpha: 0.24, blur: 12, y: 2 },
};

export function defaultBoardRenderStyle(mode: "dark" | "light"): BoardRenderStyle {
	return { ...BASE, selection: { ...BASE.selection }, shadow: { ...SHADOW[mode] } };
}

/** Theme overrides of the default style; a shadow without positive alpha is none. */
export type BoardRenderStyleInput = Partial<Omit<BoardRenderStyle, "shadow" | "selection">> & {
	shadow?: Partial<BoardShadowStyle> | null;
	selection?: Partial<BoardSelectionStyle>;
};

export function resolveBoardRenderStyle(
	mode: "dark" | "light",
	style?: BoardRenderStyleInput,
): BoardRenderStyle {
	const base = defaultBoardRenderStyle(mode);
	if (!style) return base;
	const shadow = style.shadow === null ? null : { ...SHADOW[mode], ...style.shadow };
	return {
		...base,
		...style,
		selection: { ...base.selection, ...style.selection },
		shadow: shadow && shadow.alpha > 0 ? shadow : null,
	};
}
