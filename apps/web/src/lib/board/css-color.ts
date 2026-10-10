/**
 * Resolve CSS color values (including Cohub oklch tokens) to Pixi-friendly
 * 0xRRGGBB numbers. Uses a live DOM probe so space theme.css / data-theme
 * overrides are honored without hardcoding hex.
 */

let probe: HTMLElement | null = null;
let colorCanvas: HTMLCanvasElement | null = null;

function getProbe(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	if (probe) return probe;
	probe = document.createElement("span");
	probe.setAttribute("data-cohub-color-probe", "true");
	probe.style.cssText =
		"position:absolute;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;opacity:0;";
	document.documentElement.append(probe);
	return probe;
}

function parseRgbChannel(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.endsWith("%")) {
		const pct = Number.parseFloat(trimmed.slice(0, -1));
		return Number.isFinite(pct)
			? Math.max(0, Math.min(255, Math.round((pct / 100) * 255)))
			: null;
	}
	const n = Number.parseFloat(trimmed);
	return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

/** Parse a normalized sRGB channel from CSS Color 4's `color(srgb ...)`. */
function parseSrgbChannel(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.endsWith("%")) {
		const pct = Number.parseFloat(trimmed.slice(0, -1));
		return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : null;
	}
	const n = Number.parseFloat(trimmed);
	return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/** Parse `rgb()`, `rgba()`, `color(srgb ...)`, `#rgb`, `#rrggbb` into 0xRRGGBB. */
export function parseCssColorToNumber(value: string): number | null {
	const raw = value.trim();
	if (!raw) return null;

	const hex6 = /^#([0-9a-f]{6})$/i.exec(raw);
	if (hex6) return Number.parseInt(hex6[1], 16);

	const hex3 = /^#([0-9a-f]{3})$/i.exec(raw);
	if (hex3) {
		const [r, g, b] = hex3[1].split("");
		return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
	}

	const rgb =
		/^rgba?\(\s*([^\s,/]+)[\s,/]+([^\s,/]+)[\s,/]+([^\s,/]+)(?:[\s,/]+[^\s)]+)?\s*\)$/i.exec(
			raw,
		);
	if (rgb) {
		const r = parseRgbChannel(rgb[1]);
		const g = parseRgbChannel(rgb[2]);
		const b = parseRgbChannel(rgb[3]);
		if (r == null || g == null || b == null) return null;
		return (r << 16) | (g << 8) | b;
	}

	const srgb =
		/^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/[^)]*)?\s*\)$/i.exec(
			raw,
		);
	if (srgb) {
		const r = parseSrgbChannel(srgb[1]);
		const g = parseSrgbChannel(srgb[2]);
		const b = parseSrgbChannel(srgb[3]);
		if (r == null || g == null || b == null) return null;
		return (
			(Math.round(r * 255) << 16) |
			(Math.round(g * 255) << 8) |
			Math.round(b * 255)
		);
	}

	return null;
}

/**
 * Read a CSS custom property from `host` (or documentElement) and convert to
 * 0xRRGGBB. Falls back when the value is empty or unparsable.
 */
export function readCssColorNumber(
	host: Element | null | undefined,
	property: string,
	fallback: number,
): number {
	const el =
		host ?? (typeof document !== "undefined" ? document.documentElement : null);
	if (!el) return fallback;

	const declared = getComputedStyle(el).getPropertyValue(property).trim();
	if (!declared) return fallback;

	// Fast path: already #rrggbb / rgb().
	const direct = parseCssColorToNumber(declared);
	if (direct != null) return direct;

	// First ask CSSOM to resolve custom properties and modern color syntax. Some
	// browsers keep the computed value in `oklch()` / `color-mix()`, so CSSOM
	// alone is not enough for Pixi's numeric color API.
	const node = getProbe();
	if (node) {
		node.style.color = "";
		node.style.color = declared;
		const resolved = getComputedStyle(node).color;
		const cssom = parseCssColorToNumber(resolved);
		if (cssom != null) return cssom;
	}

	// Canvas 2D is the browser's native CSS Color 4 -> sRGB conversion path.
	// Reading one pixel also applies gamut mapping and ignores alpha for Pixi.
	if (typeof document === "undefined") return fallback;
	colorCanvas ??= document.createElement("canvas");
	colorCanvas.width = 1;
	colorCanvas.height = 1;
	const context = colorCanvas.getContext("2d", { willReadFrequently: true });
	if (!context) return fallback;
	context.clearRect(0, 0, 1, 1);
	context.fillStyle = "#010203";
	const before = context.fillStyle;
	context.fillStyle = declared;
	if (context.fillStyle === before) return fallback;
	context.fillRect(0, 0, 1, 1);
	const pixel = context.getImageData(0, 0, 1, 1).data;
	return (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
}

export function hexNumberToCss(value: number): string {
	return `#${value.toString(16).padStart(6, "0")}`;
}
