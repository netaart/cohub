import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown";
import { BOARD_EXPORT_FONTS } from "./src/board-fonts.ts";

const require = createRequire(import.meta.url);
const fontPath = (pkg: string, file: string) =>
  join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);

/** Runs after `tsc`: bundles the Board renderer and PixiJS so neither is installed at runtime. */
export default defineConfig({
  entry: { "board-kernel": "src/board-kernel.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  tsconfig: false,
  dts: false,
  clean: false,
  hash: false,
  fixedExtension: false,
  outExtensions: () => ({ js: ".js" }),
  outputOptions: { chunkFileNames: "board-kernel/[name].js" },
  copy: BOARD_EXPORT_FONTS.map(({ pkg, file }) => ({ from: fontPath(pkg, file), to: "dist/fonts" })),
  deps: {
    alwaysBundle: [/^@neta-art\/cohub\/board/, /^pixi\.js/],
    neverBundle: ["@napi-rs/canvas"],
    onlyBundle: false,
  },
});
