import { BOARD_COLOR_TOKENS, type BoardColor, type BoardColorToken } from "@cohub/protocol";
import { BOARD_THEME_DATA } from "./themes.js";

export type BoardColorId = BoardColorToken;

export type BoardColorValue = {
	stroke: number;
	fill: number;
	label: number;
};

export type BoardColorEntry = {
	id: BoardColorId;
	label: string;
	dark: BoardColorValue;
	light: BoardColorValue;
};

const COLOR_LABELS: Record<BoardColorId, string> = {
	brand: "Brand",
	neutral: "Neutral",
	black: "Black",
	white: "White",
	blue: "Blue",
	green: "Green",
	amber: "Amber",
	violet: "Violet",
	rose: "Rose",
};

/** Swatches with the colors of the default dark and light themes. */
export const BOARD_COLORS: readonly BoardColorEntry[] = BOARD_COLOR_TOKENS.map((id) => ({
	id,
	label: COLOR_LABELS[id],
	dark: { ...BOARD_THEME_DATA.dark.colors[id] },
	light: { ...BOARD_THEME_DATA.light.colors[id] },
}));

export const DEFAULT_BOARD_COLOR: BoardColorId = "brand";

const COLOR_INDEX: ReadonlyMap<BoardColorId, BoardColorEntry> = new Map(
	BOARD_COLORS.map((entry) => [entry.id, entry]),
);

export function isBoardColorId(value: unknown): value is BoardColorId {
	return typeof value === "string" && COLOR_INDEX.has(value as BoardColorId);
}

export function boardColorCssVar(
	id: BoardColorId,
	part: keyof BoardColorValue,
): string {
	return `--board-color-${id}-${part}`;
}

export function resolveBoardColor(
	id: unknown,
	mode: "dark" | "light",
): BoardColorValue {
	const entry =
		(isBoardColorId(id) ? COLOR_INDEX.get(id) : undefined) ??
		COLOR_INDEX.get(DEFAULT_BOARD_COLOR);
	return (entry as BoardColorEntry)[mode];
}

export type BoardShapeColors = Record<BoardColorId, BoardColorValue>;

export function buildFallbackShapeColors(
	mode: "dark" | "light",
): BoardShapeColors {
	const out = {} as BoardShapeColors;
	for (const entry of BOARD_COLORS) {
		out[entry.id] = entry[mode];
	}
	return out;
}

export function pickBoardColor(
	colors: BoardShapeColors | null | undefined,
	id: unknown,
	mode: "dark" | "light" = "dark",
): BoardColorValue {
	if (colors && isBoardColorId(id) && colors[id]) return colors[id];
	if (colors) return colors[DEFAULT_BOARD_COLOR];
	return resolveBoardColor(id, mode);
}

export function resolveItemColor(
	color: BoardColor | undefined,
	fallback: BoardColorId,
	colors: BoardShapeColors | null | undefined,
	mode: "dark" | "light",
	parseCss: (value: string) => number | null,
	part: keyof BoardColorValue = "stroke",
): number {
	const value = typeof color === "object" && color ? color[mode] : color;
	if (value === undefined) return pickBoardColor(colors, fallback, mode)[part];
	const token = value.trim().toLowerCase();
	if (isBoardColorId(token)) return pickBoardColor(colors, token, mode)[part];
	return parseCss(value) ?? pickBoardColor(colors, fallback, mode)[part];
}
