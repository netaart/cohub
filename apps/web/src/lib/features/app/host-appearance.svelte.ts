import {
	APP_APPEARANCE_TOKENS,
	type AppAppearance,
	type AppAppearanceToken,
} from "@cohub/protocol/app-runtime";
import { CUSTOM_THEME_CHANGED_EVENT } from "#lib/custom-theme/events.ts";
import { getResolvedTheme } from "#lib/theme.svelte.ts";
import { isDarkTheme } from "#lib/theme-registry.ts";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Tokens whose host variable differs from `--<token>`; status hues come from the theme scales. */
const TOKEN_SOURCES: Partial<Record<AppAppearanceToken, string>> = {
	success: "--success-500",
	warning: "--warning-500",
	error: "--error-500",
	info: "--info-500",
};

/** Bumped when something outside the theme id restyles the host. */
let revision = $state(0);
let listening = false;
let cached: { key: string; appearance: AppAppearance } | null = null;

function listen() {
	if (listening || typeof window === "undefined") return;
	listening = true;
	const bump = () => {
		revision += 1;
	};
	// Custom themes override tokens without changing the theme id.
	window.addEventListener(CUSTOM_THEME_CHANGED_EVENT, bump);
	window.matchMedia?.(REDUCED_MOTION_QUERY).addEventListener("change", bump);
}

/** Reactive key that changes whenever the appearance Apps see changes. */
export function hostAppearanceKey(): string {
	listen();
	return `${getResolvedTheme()}:${revision}`;
}

/** The theme and resolved public tokens the viewer currently sees. */
export function readHostAppearance(): AppAppearance | undefined {
	if (typeof document === "undefined") return undefined;
	const key = hostAppearanceKey();
	if (cached?.key === key) return cached.appearance;
	const theme = getResolvedTheme();
	const style = getComputedStyle(document.documentElement);
	const tokens: AppAppearance["tokens"] = {};
	for (const token of APP_APPEARANCE_TOKENS) {
		const value = style
			.getPropertyValue(TOKEN_SOURCES[token] ?? `--${token}`)
			.trim();
		if (value) tokens[token] = value;
	}
	const appearance: AppAppearance = {
		colorScheme: isDarkTheme(theme) ? "dark" : "light",
		theme,
		tokens,
		reducedMotion: window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false,
	};
	cached = { key, appearance };
	return appearance;
}
