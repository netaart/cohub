import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import svelteConfig from "./svelte.config.js";

// The local Board viewer bundled into @neta-art/cohub-cli: the same Board
// panel as the web app, built as a static page served by `cohub boards open`.
const here = fileURLToPath(new URL(".", import.meta.url));
const lib = join(here, "src/lib");
const out = resolve(here, "../../packages/cli/board-viewer");

function publicEnvNames(dir: string, names = new Set<string>()): Set<string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) publicEnvNames(path, names);
		else if (/\.(ts|svelte)$/.test(entry))
			for (const [name] of readFileSync(path, "utf8").matchAll(
				/\bPUBLIC_[A-Z0-9_]+/g,
			))
				names.add(name);
	}
	return names;
}

/** SvelteKit's virtual modules, reduced to what a page without a router or server needs. */
function kitShims(): Plugin {
	const modules: Record<string, () => string> = {
		"$env/static/public": () =>
			[...publicEnvNames(lib)]
				.map(
					(name) =>
						`export const ${name} = ${JSON.stringify(name === "PUBLIC_COHUB_ENV" ? "prod" : "")};`,
				)
				.join("\n"),
		"$app/environment": () =>
			"export const browser = true; export const dev = false; export const building = false; export const version = '';",
		"$app/state": () =>
			"export const page = { get url() { return new URL(location.href); }, params: {}, route: { id: null }, state: {}, data: {}, status: 200, error: null, form: null };\nexport const navigating = { current: null };\nexport const updated = { current: false, check: async () => false };",
		"$app/navigation": () =>
			[
				"export async function goto(url, options = {}) { options.replaceState ? location.replace(url) : location.assign(url); }",
				"export function pushState(url, state) { history.pushState(state, '', url); }",
				"export function replaceState(url, state) { history.replaceState(state, '', url); }",
				"export async function invalidate() {} export async function invalidateAll() {}",
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

const kitAlias = Object.entries(svelteConfig.kit?.alias ?? {}).map(
	([find, replacement]) => ({
		find: find.endsWith("/*")
			? new RegExp(`^${find.slice(0, -2).replace(/[$/.@]/g, "\\$&")}/(.*)$`)
			: new RegExp(`^${find.replace(/[$/.@]/g, "\\$&")}$`),
		replacement: find.endsWith("/*")
			? `${String(replacement).slice(0, -2)}/$1`
			: resolve(here, String(replacement)),
	}),
);

export default defineConfig({
	root: join(here, "src/board-viewer"),
	base: "./",
	define: { __COHUB_BUILD__: JSON.stringify({ release: null, commit: null }) },
	resolve: {
		alias: [
			{
				find: "$lib/components/app/AppSurface.svelte",
				replacement: join(here, "src/board-viewer/AppSurfaceStub.svelte"),
			},
			{ find: /^\$lib(\/.*)?$/, replacement: `${lib}$1` },
			...kitAlias,
		],
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
