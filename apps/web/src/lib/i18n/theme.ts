import { m } from "#lib/paraglide/messages.js";
import type { ThemeMode } from "#lib/theme-registry.ts";
import type { Locale } from "./locale.ts";

export function localizedThemeLabel(theme: ThemeMode, locale: Locale): string {
	const options = { locale };
	switch (theme) {
		case "dark":
			return m.settings_theme_dark({}, options);
		case "light":
			return m.settings_theme_light({}, options);
		case "solarized-dark":
			return m.settings_theme_solarized_dark({}, options);
		case "solarized-light":
			return m.settings_theme_solarized_light({}, options);
		case "neta-studio":
			return m.settings_theme_neta_studio({}, options);
		case "neta-pixel":
			return m.settings_theme_neta_pixel({}, options);
		case "neta-pixel-dark":
			return m.settings_theme_neta_pixel_dark({}, options);
		case "system":
			return m.settings_language_system({}, options);
	}
}

export function localizedThemeDescription(
	theme: ThemeMode,
	locale: Locale,
): string {
	const options = { locale };
	switch (theme) {
		case "dark":
			return m.settings_theme_dark_description({}, options);
		case "light":
			return m.settings_theme_light_description({}, options);
		case "solarized-dark":
			return m.settings_theme_solarized_dark_description({}, options);
		case "solarized-light":
			return m.settings_theme_solarized_light_description({}, options);
		case "neta-studio":
			return m.settings_theme_neta_studio_description({}, options);
		case "neta-pixel":
			return m.settings_theme_neta_pixel_description({}, options);
		case "neta-pixel-dark":
			return m.settings_theme_neta_pixel_dark_description({}, options);
		case "system":
			return m.settings_theme_system_description({}, options);
	}
}
