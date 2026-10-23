import type { BoardShapeColors } from "@neta-art/cohub/board";
import {
	type BoardRenderPalette,
	type BoardRenderStyle,
	boardRenderTheme,
	resolveBoardRenderStyle,
} from "@neta-art/cohub/board/render";
import {
	IDENTITY_TONE_COUNT,
	identityToken,
	identityTone,
} from "$lib/avatar-identity";
import type { BoardThemeBackground } from "$lib/board/board-theme-background";
import {
	type BoardThemeTokenSource,
	readBoardThemeColors,
	readBoardThemeStyle,
} from "$lib/board/board-theme-tokens";
import { readCssColorNumber } from "$lib/board/css-color";
import { getResolvedTheme, type ResolvedTheme } from "$lib/theme.svelte";

/**
 * The complete theme context used by a browser board. `colorScheme` is only a
 * fallback hint; the resolved palette and shape colors carry the actual theme.
 */
export {
	type BoardBackgroundLoadState,
	type BoardThemeBackground,
	resolveBoardBackground,
} from "$lib/board/board-theme-background";

export type BoardThemeSnapshot = {
	id: ResolvedTheme;
	key: string;
	colorScheme: "dark" | "light";
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	style: BoardRenderStyle;
	identity: readonly number[];
	background: BoardThemeBackground | null;
};

function domTokenSource(
	host: Element | null | undefined,
): BoardThemeTokenSource {
	return {
		token: (name) => cssToken(host, name),
		color: (name, backdrop) => {
			const color = readCssColorNumber(host, name, -1, backdrop);
			return color < 0 ? null : color;
		},
	};
}

function readIdentity(
	host: Element | null | undefined,
	fallback: number,
): number[] {
	return Array.from({ length: IDENTITY_TONE_COUNT }, (_, index) =>
		readCssColorNumber(host, identityToken(index + 1), fallback),
	);
}

export function boardIdentityColor(theme: BoardThemeSnapshot, seed: string) {
	const tone = identityTone(seed);
	return (tone && theme.identity[tone - 1]) ?? theme.palette.muted;
}

function cssToken(host: Element | null | undefined, name: string): string {
	const element =
		host ?? (typeof document !== "undefined" ? document.documentElement : null);
	return element ? getComputedStyle(element).getPropertyValue(name).trim() : "";
}

function cssStringToken(
	host: Element | null | undefined,
	name: string,
): string {
	const value = cssToken(host, name);
	if (!value) return "";
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === "string" ? parsed : "";
		} catch {
			return "";
		}
	}
	return value;
}

function cssPositiveNumberToken(
	host: Element | null | undefined,
	name: string,
): number | null {
	const value = Number.parseFloat(cssToken(host, name));
	return Number.isFinite(value) && value > 0 ? value : null;
}

function readBackground(
	host: Element | null | undefined,
): BoardThemeBackground | null {
	const url = cssStringToken(host, "--board-background-image-url");
	if (!url) return null;
	return {
		url,
		tileWidth: cssPositiveNumberToken(host, "--board-background-tile-width"),
		tileHeight: cssPositiveNumberToken(host, "--board-background-tile-height"),
	};
}

/** Cheap identity read used to avoid resolving all CSS tokens every frame. */
export function boardThemeKey(
	host: Element | null | undefined,
	customThemeVersion = 0,
): string {
	const id = getResolvedTheme();
	return [
		id,
		customThemeVersion,
		cssToken(host, "--board-selection-accent"),
		cssToken(host, "--board-bg"),
		cssToken(host, "--board-background-image-url"),
		cssToken(host, "--board-background-tile-width"),
		cssToken(host, "--board-background-tile-height"),
	].join(":");
}

/** Resolve the full current Web theme into the values Pixi can consume. */
export function resolveBoardTheme(
	host: Element | null | undefined,
	customThemeVersion = 0,
	key = boardThemeKey(host, customThemeVersion),
): BoardThemeSnapshot {
	const id = getResolvedTheme();
	const builtin = boardRenderTheme(id);
	const source = domTokenSource(host);
	const { palette, colors } = readBoardThemeColors(source, builtin);
	return {
		id,
		key,
		colorScheme: builtin.colorScheme,
		palette,
		colors,
		style: resolveBoardRenderStyle(
			builtin.colorScheme,
			readBoardThemeStyle(source),
		),
		identity: readIdentity(host, palette.brand),
		background: readBackground(host),
	};
}
