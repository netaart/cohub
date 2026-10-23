import {
	BOARD_COLORS,
	type BoardShapeColors,
	boardColorCssVar,
} from "@neta-art/cohub/board";
import type {
	BoardRenderPalette,
	BoardRenderStyleInput,
} from "@neta-art/cohub/board/render";

export type BoardThemeTokenSource = {
	token(name: string): string;
	color(name: string, backdrop?: number): number | null;
};

export type BoardThemeColors = {
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
};

export function readBoardThemeColors(
	source: BoardThemeTokenSource,
	fallback?: BoardThemeColors,
): BoardThemeColors {
	const color = (name: string, value?: number, backdrop?: number) => {
		const resolved = source.color(name, backdrop) ?? value;
		if (resolved === undefined) throw new Error(`${name} is not a color`);
		return resolved;
	};
	const base = fallback?.palette;
	const bg = color("--board-bg", base?.bg);
	const palette: BoardRenderPalette = {
		bg,
		surface: color("--board-card", base?.surface, bg),
		hover: color("--bg-hover", base?.hover, bg),
		border: color("--border-subtle", base?.border, bg),
		brand: color("--board-selection-accent", base?.brand),
		text: color("--text-primary", base?.text, bg),
		muted: color("--text-tertiary", base?.muted, bg),
		rare: color("--info-400", base?.rare),
		epic: color("--info-500", base?.epic),
		legendary: color("--warning-400", base?.legendary),
	};
	const colors = {} as BoardShapeColors;
	for (const { id } of BOARD_COLORS) {
		const entry = fallback?.colors[id];
		colors[id] = {
			stroke: color(boardColorCssVar(id, "stroke"), entry?.stroke),
			fill: color(boardColorCssVar(id, "fill"), entry?.fill),
			label: color(boardColorCssVar(id, "label"), entry?.label),
		};
	}
	return { palette, colors };
}

export function readBoardThemeStyle(
	source: BoardThemeTokenSource,
): BoardRenderStyleInput {
	const number = (name: string) => {
		const value = Number.parseFloat(source.token(name));
		return Number.isFinite(value) ? value : undefined;
	};
	const choice = <T extends string>(name: string, values: readonly T[]) => {
		const value = source.token(name);
		return (values as readonly string[]).includes(value)
			? (value as T)
			: undefined;
	};
	const shadow = defined({
		color: source.color("--board-card-shadow-color") ?? undefined,
		alpha: number("--board-card-shadow-opacity"),
		blur: number("--board-card-shadow-blur"),
		y: number("--board-card-shadow-y"),
	});
	const selection = defined({
		width: number("--board-selection-width"),
		outset: number("--board-selection-outset"),
		dash: number("--board-selection-dash"),
		handle: choice("--board-selection-handle", ["circle", "square"]),
		handleSize: number("--board-selection-handle-size"),
	});
	return defined({
		corner: choice("--board-card-corner", ["round", "pixel"]),
		radius: number("--board-card-radius"),
		shadow: Object.keys(shadow).length ? shadow : undefined,
		selection: Object.keys(selection).length ? selection : undefined,
		media: choice("--board-media", ["plain", "framed"]),
		progress: choice("--board-progress", ["shimmer", "mosaic"]),
		icons: choice("--board-icons", ["line", "pixel"]),
		motion: choice("--board-motion", ["smooth", "stepped"]),
		font: source.token("--board-font").replace(/\s+/g, " ") || undefined,
		frameLabelSize: number("--board-frame-label-size"),
	});
}

function defined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}
