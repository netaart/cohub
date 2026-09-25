/**
 * Resolution hook implementation (loaded off-thread by `register-alias.mjs`).
 *
 * Teaches Node the import forms the web sources rely on Vite for: the SvelteKit
 * `$lib/...` alias, extension-less relative specifiers, and workspace packages
 * imported by name (which resolve to `dist` under Node but must come from source
 * in a source-only test run).
 */

import { existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libRoot = resolvePath(here, "..", "src", "lib");
const packagesRoot = resolvePath(here, "..", "..", "..", "packages");

/**
 * Workspace packages mapped to their sources, longest specifier first so a
 * subpath is never shadowed by the bare package name. Protocol is included
 * because the SDK Board module imports it by name and Node would otherwise resolve
 * it to an unbuilt `dist`.
 */
const PACKAGE_SOURCES = [
	["@neta-art/cohub/space-picker", `${packagesRoot}/sdk/src/space-picker.ts`],
	[
		"@neta-art/cohub/board/headless",
		`${packagesRoot}/sdk/src/board/headless/index.ts`,
	],
	[
		"@neta-art/cohub/board/render",
		`${packagesRoot}/sdk/src/board/render/index.ts`,
	],
	[
		"@neta-art/cohub/board/export",
		`${packagesRoot}/sdk/src/board/export/index.ts`,
	],
	["@neta-art/cohub/board", `${packagesRoot}/sdk/src/board/index.ts`],
	["@neta-art/cohub/app-ref", `${packagesRoot}/sdk/src/app-ref.ts`],
	[
		"@cohub/protocol/public-identifiers",
		`${packagesRoot}/protocol/src/public-identifiers.ts`,
	],
	[
		"@cohub/protocol/board-document",
		`${packagesRoot}/protocol/src/board-document.ts`,
	],
	[
		"@cohub/protocol/board-constants",
		`${packagesRoot}/protocol/src/board-constants.ts`,
	],
	[
		"@cohub/protocol/desktop-command",
		`${packagesRoot}/protocol/src/desktop-command.ts`,
	],
	["@cohub/protocol/task", `${packagesRoot}/protocol/src/task/index.ts`],
	["@cohub/protocol", `${packagesRoot}/protocol/src/index.ts`],
];

/** Candidate suffixes for an extension-less import, in precedence order. */
const SUFFIXES = ["", ".ts", ".js", "/index.ts", "/index.js"];

function isFile(path) {
	return existsSync(path) && statSync(path).isFile();
}

function firstMatch(base) {
	for (const suffix of SUFFIXES) {
		const candidate = `${base}${suffix}`;
		if (isFile(candidate)) return pathToFileURL(candidate).href;
	}
	return null;
}

export function resolve(specifier, context, next) {
	if (specifier.startsWith("$lib/")) {
		const url = firstMatch(
			resolvePath(libRoot, specifier.slice("$lib/".length)),
		);
		if (url) return { url, shortCircuit: true };
	}
	for (const [name, target] of PACKAGE_SOURCES) {
		if (specifier === name && isFile(target)) {
			return { url: pathToFileURL(target).href, shortCircuit: true };
		}
	}
	// Relative import from a source or test file: infer the extension, and map a
	// `.js` specifier onto its TypeScript source. Workspace packages are written
	// with `.js` specifiers that only exist as `.ts` on disk (the compiler rewrites
	// them on build), which plain Node cannot follow.
	if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
		const parentDir = dirname(fileURLToPath(context.parentURL));
		const target = resolvePath(parentDir, specifier);
		const url = firstMatch(target);
		if (url) return { url, shortCircuit: true };
		if (specifier.endsWith(".js")) {
			// Only when the .js genuinely does not exist, so a real build output is
			// never shadowed by its source.
			const asTs = `${target.slice(0, -3)}.ts`;
			if (isFile(asTs))
				return { url: pathToFileURL(asTs).href, shortCircuit: true };
		}
	}
	return next(specifier, context);
}
