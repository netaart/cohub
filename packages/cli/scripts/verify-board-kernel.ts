import { readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { BOARD_EXPORT_FONTS } from "../src/board-fonts.js";

// A `tsc`-only build leaves dist/board-kernel.js importing packages the CLI does not install.
const dist = new URL("../dist/", import.meta.url);
const imported = new Set<string>();
registerHooks({
  resolve(specifier, context, next) {
    if (!/^(\.|\/|node:|file:)/.test(specifier)) imported.add(specifier);
    return next(specifier, context);
  },
});
await import(new URL("board-kernel.js", dist).href);
const external = [...imported].filter((specifier) => specifier !== "@napi-rs/canvas");
if (external.length) throw new Error(`dist/board-kernel.js imports ${external.join(", ")}; run the full build`);

const fonts = new Set(await readdir(new URL("fonts/", dist)));
const missing = BOARD_EXPORT_FONTS.filter(({ file }) => !fonts.has(file));
if (missing.length) throw new Error(`dist/fonts is missing ${missing.map(({ file }) => file).join(", ")}`);
console.log(`Verified the board export bundle and ${fonts.size} fonts`);
