import {
	APP_APPEARANCE_TOKENS,
	type AppAppearance,
} from "@cohub/protocol/app-runtime";
import { SPACE_STYLE_CHANGED_EVENT } from "$lib/space-style";
import { getResolvedTheme } from "$lib/theme.svelte";
import { isDarkTheme } from "$lib/theme-registry";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
	// A Space's custom theme overrides tokens without changing the theme id.
	window.addEventListener(SPACE_STYLE_CHANGED_EVENT, bump);
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
		const value = style.getPropertyValue(`--${token}`).trim();
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
