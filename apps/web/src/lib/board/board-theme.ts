import type { BoardShapeColors } from "@neta-art/cohub/board";
import {
	type BoardRenderPalette,
	type BoardRenderStyle,
	type BoardThemeBackdrop,
	boardRenderTheme,
	resolveBoardRenderStyle,
} from "@neta-art/cohub/board/render";
import {
	IDENTITY_TONE_COUNT,
	identityToken,
	identityTone,
} from "#lib/avatar-identity.ts";
import {
	type BoardThemeTokenSource,
	readBoardThemeBackdrop,
	readBoardThemeColors,
	readBoardThemeStyle,
} from "#lib/board/board-theme-tokens.ts";
import { readCssColorNumber } from "#lib/board/css-color.ts";
import { getResolvedTheme, type ResolvedTheme } from "#lib/theme.svelte.ts";

/**
 * The complete theme context used by a browser board. `colorScheme` is only a
 * fallback hint; the resolved palette and shape colors carry the actual theme.
 */
export type BoardThemeSnapshot = {
	id: ResolvedTheme;
	key: string;
	colorScheme: "dark" | "light";
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	style: BoardRenderStyle;
	identity: readonly number[];
	backdrop?: BoardThemeBackdrop;
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

function documentUrl(value: string): string | null {
	try {
		return new URL(value, document.baseURI).href;
	} catch {
		return null;
	}
}

const BACKDROP_TOKENS = [
	"--board-backdrop-pattern",
	"--board-backdrop-pattern-color",
	"--board-backdrop-pattern-pitch",
	"--board-backdrop-pattern-size",
	"--board-backdrop-image",
	"--board-backdrop-image-width",
	"--board-backdrop-image-height",
];

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
		...BACKDROP_TOKENS.map((name) => cssToken(host, name)),
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
		backdrop: readBoardThemeBackdrop(source, palette.bg, documentUrl),
	};
}
