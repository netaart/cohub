import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";

// Fails the build when a browser-only package is reachable from the Worker entry.

const BROWSER_ONLY = [
	"three",
	"pixi.js",
	"pdfjs-dist",
	"mermaid",
	"codemirror",
	"@codemirror/*",
];

const appDir = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(appDir, ".svelte-kit/cloudflare/_worker.js");

const isBrowserOnly = (specifier) =>
	BROWSER_ONLY.some((name) =>
		name.endsWith("/*")
			? specifier.startsWith(name.slice(0, -1))
			: specifier === name || specifier.startsWith(`${name}/`),
	);

function specifiers(file, code) {
	const { module, errors } = parseSync(file, code);
	if (errors.length > 0) {
		throw new Error(`Cannot parse ${file}: ${errors[0].message}`);
	}
	const dynamic = module.dynamicImports
		.map(({ moduleRequest }) =>
			code.slice(moduleRequest.start, moduleRequest.end),
		)
		.filter((request) => /^(["'`])[^"'`$]*\1$/.test(request))
		.map((request) => request.slice(1, -1));
	return [
		...module.staticImports.map((item) => item.moduleRequest.value),
		...module.staticExports.flatMap((item) =>
			item.entries.flatMap((entry) => entry.moduleRequest?.value ?? []),
		),
		...dynamic,
	];
}

const seen = new Set([entry]);
const leaks = [];
for (const file of seen) {
	for (const specifier of specifiers(file, await readFile(file, "utf8"))) {
		if (specifier.startsWith(".")) {
			seen.add(resolve(dirname(file), specifier));
		} else if (isBrowserOnly(specifier)) {
			leaks.push(`  ${relative(appDir, file)} → ${specifier}`);
		}
	}
}

if (leaks.length > 0) {
	console.error(
		`Browser-only packages are reachable from the Worker:\n${leaks.join("\n")}\nGate their imports with \`import.meta.env.SSR ? pending() : import("…")\`.`,
	);
	process.exit(1);
}
console.log(`Worker graph is clean (${seen.size} modules).`);
