import type { BoardColor, BoardColorToken } from "@cohub/protocol";

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

const LABEL_DARK = 0xf4f4f4;
const LABEL_LIGHT = 0x18181b;

export const BOARD_COLORS: readonly BoardColorEntry[] = [
	{
		id: "brand",
		label: "Brand",
		dark: { stroke: 0xff5a1f, fill: 0xff5a1f, label: LABEL_DARK },
		light: { stroke: 0xe8450e, fill: 0xe8450e, label: LABEL_LIGHT },
	},
	{
		id: "neutral",
		label: "Neutral",
		dark: { stroke: 0x9aa0a6, fill: 0x9aa0a6, label: LABEL_DARK },
		light: { stroke: 0x5f6368, fill: 0x5f6368, label: LABEL_LIGHT },
	},
	{
		id: "black",
		label: "Black",
		dark: { stroke: 0x000000, fill: 0x000000, label: LABEL_DARK },
		light: { stroke: 0x000000, fill: 0x000000, label: LABEL_LIGHT },
	},
	{
		id: "white",
		label: "White",
		dark: { stroke: 0xffffff, fill: 0xffffff, label: LABEL_DARK },
		light: { stroke: 0xffffff, fill: 0xffffff, label: LABEL_LIGHT },
	},
	{
		id: "blue",
		label: "Blue",
		dark: { stroke: 0x38bdf8, fill: 0x38bdf8, label: LABEL_DARK },
		light: { stroke: 0x2563eb, fill: 0x2563eb, label: LABEL_LIGHT },
	},
	{
		id: "green",
		label: "Green",
		dark: { stroke: 0x34d399, fill: 0x34d399, label: LABEL_DARK },
		light: { stroke: 0x16a34a, fill: 0x16a34a, label: LABEL_LIGHT },
	},
	{
		id: "amber",
		label: "Amber",
		dark: { stroke: 0xf59e0b, fill: 0xf59e0b, label: LABEL_DARK },
		light: { stroke: 0xd97706, fill: 0xd97706, label: LABEL_LIGHT },
	},
	{
		id: "violet",
		label: "Violet",
		dark: { stroke: 0xa78bfa, fill: 0xa78bfa, label: LABEL_DARK },
		light: { stroke: 0x7c3aed, fill: 0x7c3aed, label: LABEL_LIGHT },
	},
	{
		id: "rose",
		label: "Rose",
		dark: { stroke: 0xfb7185, fill: 0xfb7185, label: LABEL_DARK },
		light: { stroke: 0xe11d48, fill: 0xe11d48, label: LABEL_LIGHT },
	},
] as const;

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
