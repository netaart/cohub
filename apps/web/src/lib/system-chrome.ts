import { syncHostAppearance } from "$lib/host-bridge";

// Matches light `--bg-primary` (oklch(100% 0 0)). The manifest, the inline
// FOUC script and this fallback must agree so cold start, first paint and the
// root canvas share one color.
export const DEFAULT_PWA_THEME_COLOR = "#FFFFFF";
export const DEFAULT_PWA_BACKGROUND_COLOR = "#FFFFFF";

/**
 * Keep browser chrome and the native host's system bars aligned with the
 * actual shell background, including space-level custom theme.css overrides.
 */
export function syncSystemChromeColor(fallback = DEFAULT_PWA_THEME_COLOR) {
	if (typeof document === "undefined") return;

	const rootColor = getComputedStyle(document.documentElement)
		.getPropertyValue("--bg-primary")
		.trim();
	const color = toSrgbHex(rootColor) ?? fallback;

	for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
		meta.setAttribute("content", color);
	}
	syncHostAppearance(color);
}

let probe: CanvasRenderingContext2D | null | undefined;

function toSrgbHex(value: string): string | null {
	if (!value || !CSS.supports("color", value)) return null;
	probe ??= document
		.createElement("canvas")
		.getContext("2d", { willReadFrequently: true });
	if (!probe) return null;
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = value;
	probe.fillRect(0, 0, 1, 1);
	const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
	return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
