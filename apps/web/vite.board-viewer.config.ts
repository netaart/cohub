import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";
import { variables } from "./src/env.ts";

// The local Board viewer bundled into @neta-art/cohub-cli: the same Board
// panel as the web app, built as a static page served by `cohub boards open`.
const here = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(here, "../../packages/cli/board-viewer");

/** SvelteKit's virtual modules, reduced to what a page without a router or server needs. */
function kitShims(): Plugin {
	const modules: Record<string, () => string> = {
		"$app/env/public": () =>
			Object.entries(variables)
				.map(
					([name, config]) =>
						`export const ${name} = ${name === "PUBLIC_COHUB_ENV" ? '"prod"' : "schema" in config ? "undefined" : '""'};`,
				)
				.join("\n"),
		"$app/env": () =>
			"export const browser = true; export const dev = false; export const building = false; export const version = '';",
		"$app/state": () =>
			"export const page = { get url() { return new URL(location.href); }, params: {}, route: { id: null }, state: {}, data: {}, status: 200, error: null, form: null };\nexport const navigating = { current: null };\nexport const updated = { current: false, check: async () => false };",
		"$app/navigation": () =>
			[
				"export async function goto(url, options = {}) { if (options.shallow) history[options.replace ? 'replaceState' : 'pushState'](options.state ?? {}, '', url); else if (options.replace) location.replace(url); else location.assign(url); }",
				"export async function invalidate() {} export async function refreshAll() {}",
				"export function afterNavigate() {} export function beforeNavigate() {} export function onNavigate() {}",
				"export async function preloadData() {} export async function preloadCode() {} export function disableScrollHandling() {}",
			].join("\n"),
		"$app/paths": () =>
			"export const base = ''; export const assets = ''; export function resolve(path) { return path; } export function asset(path) { return path; }",
	};
	return {
		name: "board-viewer-kit-shims",
		enforce: "pre",
		resolveId: (id) => (id in modules ? `\0${id}` : null),
		load: (id) =>
			id.startsWith("\0") && id.slice(1) in modules
				? modules[id.slice(1)]?.()
				: null,
	};
}

export default defineConfig({
	root: join(here, "src/board-viewer"),
	base: "./",
	define: { __COHUB_BUILD__: JSON.stringify({ release: null, commit: null }) },
	resolve: {
		conditions: ["source", ...defaultClientConditions],
		alias: {
			"#lib/components/app/AppSurface.svelte": join(
				here,
				"src/board-viewer/AppSurfaceStub.svelte",
			),
		},
	},
	build: {
		outDir: out,
		emptyOutDir: true,
		target: ["chrome111", "edge111", "firefox114", "safari16"],
		chunkSizeWarningLimit: 4000,
		reportCompressedSize: false,
	},
	plugins: [
		kitShims(),
		tailwindcss(),
		paraglideVitePlugin({
			project: join(here, "project.inlang"),
			outdir: join(here, "src/lib/paraglide"),
			emitTsDeclarations: true,
			strategy: ["globalVariable", "baseLocale"],
		}),
		svelte({ configFile: false }),
	],
});
