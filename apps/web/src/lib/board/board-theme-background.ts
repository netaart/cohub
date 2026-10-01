import type { BoardSettings } from "@neta-art/cohub/board";

export type BoardBackgroundLoadState = {
	url: string;
	status: "loading" | "ready" | "error";
};

export type BoardThemeBackground = {
	url: string;
	tileWidth: number | null;
	tileHeight: number | null;
	fit?: "cover" | "contain" | "repeat";
	position?: "center" | "top" | "bottom" | "left" | "right";
	opacity?: number;
};

export function resolveBoardBackground(
	settings: BoardSettings,
	themeBackground: BoardThemeBackground | null,
): BoardThemeBackground | null {
	const declared = settings.background;
	if (declared.kind === "image" && declared.imageUrl) {
		return {
			url: declared.imageUrl,
			tileWidth: null,
			tileHeight: null,
			...(declared.fit ? { fit: declared.fit } : {}),
			...(declared.opacity !== undefined ? { opacity: declared.opacity } : {}),
		};
	}
	if ((declared.kind !== "solid" && declared.kind !== "dots") || declared.color) return null;
	return themeBackground;
}
