import type { BoardShapeColors } from "../model/palette.js";
import { BOARD_THEME_DATA, type BoardThemeId } from "../model/themes.js";
import type { BoardRenderPalette } from "./renderers/board-renderer-registry.js";
import { type BoardRenderStyle, resolveBoardRenderStyle } from "./style.js";

export type BoardRenderTheme = {
	colorScheme: "dark" | "light";
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	style: BoardRenderStyle;
};

/** A built-in Cohub theme as the app draws it; spread it into export or sampler options. */
export function boardRenderTheme(id: BoardThemeId): BoardRenderTheme {
	const { colorScheme, palette, colors, style } = BOARD_THEME_DATA[id];
	return {
		colorScheme,
		palette: { ...palette },
		colors: Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, { ...value }])) as BoardShapeColors,
		style: resolveBoardRenderStyle(colorScheme, style),
	};
}
