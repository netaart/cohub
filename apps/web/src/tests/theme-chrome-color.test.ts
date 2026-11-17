import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_PWA_THEME_COLOR } from "#lib/system-chrome.ts";
import { RESOLVED_THEMES, THEME_COLOR } from "#lib/theme-registry.ts";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(`${webRoot}/${path}`, "utf8");

/** Resolve `--bg-primary` of a theme sheet to its sRGB hex (follows one `var()` hop). */
function readThemeBgPrimary(theme: string): string {
	const css = read(`src/styles/themes/${theme}.css`);
	const declaration = (name: string) =>
		css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
	let value = declaration("--bg-primary");
	assert.ok(value, `${theme}: --bg-primary not found`);
	const ref = value.match(/^var\((--[\w-]+)\)$/)?.[1];
	if (ref) {
		value = declaration(ref);
		assert.ok(value, `${theme}: ${ref} not found`);
	}
	return cssColorToHex(value);
}

function cssColorToHex(value: string): string {
	if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
	const oklch = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
	assert.ok(oklch, `unsupported color syntax: ${value}`);
	return oklchToHex(Number(oklch[1]) / 100, Number(oklch[2]), Number(oklch[3]));
}

/** OKLCH → sRGB per CSS Color 4 (matches browser theme-color parsing). */
function oklchToHex(L: number, C: number, hDeg: number): string {
	const h = (hDeg * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	const channel = (x: number) => {
		const clamped = Math.min(1, Math.max(0, x));
		const gamma =
			clamped <= 0.0031308
				? 12.92 * clamped
				: 1.055 * clamped ** (1 / 2.4) - 0.055;
		return Math.round(gamma * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${linear.map(channel).join("")}`.toUpperCase();
}

test("theme registry colors equal each theme's --bg-primary", () => {
	for (const theme of RESOLVED_THEMES) {
		assert.equal(
			THEME_COLOR[theme].toUpperCase(),
			readThemeBgPrimary(theme),
			theme,
		);
	}
});

/**
 * The inline FOUC script in app.html cannot import the registry, so it
 * carries a copy of the theme colors. Keep both in lockstep.
 */
test("app.html inline theme colors mirror the theme registry", () => {
	const html = read("src/app.html");
	const block = html.match(/var themeColors = \{([\s\S]*?)\};/)?.[1];
	assert.ok(block, "themeColors block missing from app.html");

	const inline = new Map<string, string>();
	for (const [, key, value] of block.matchAll(
		/'?([a-z-]+)'?:\s*'(#[0-9A-Fa-f]{6})'/g,
	)) {
		inline.set(key, value.toUpperCase());
	}

	for (const theme of RESOLVED_THEMES) {
		assert.equal(inline.get(theme), THEME_COLOR[theme].toUpperCase(), theme);
	}
	assert.equal(inline.size, RESOLVED_THEMES.length);
});

test("static theme-color fallbacks match the light theme", () => {
	const light = THEME_COLOR.light.toUpperCase();
	assert.equal(DEFAULT_PWA_THEME_COLOR.toUpperCase(), light);

	const html = read("src/app.html");
	const metaColor = html.match(
		/<meta name="theme-color" content="(#[0-9A-Fa-f]{6})"/,
	)?.[1];
	assert.equal(metaColor?.toUpperCase(), light);

	const vite = read("vite.config.ts");
	assert.equal(vite.match(/theme_color: "(#[0-9A-Fa-f]{6})"/)?.[1], light);
	assert.equal(vite.match(/background_color: "(#[0-9A-Fa-f]{6})"/)?.[1], light);
});
