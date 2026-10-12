export const CUSTOM_THEME_CHANGED_EVENT = "cohub:custom-theme-changed";

export type CustomThemeChangedDetail = { spaceId: string | null };

export function notifyCustomThemeChanged(spaceId: string | null) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<CustomThemeChangedDetail>(CUSTOM_THEME_CHANGED_EVENT, {
			detail: { spaceId },
		}),
	);
}
