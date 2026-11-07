import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type UserConfig } from "tsdown";
import { BOARD_EXPORT_FONTS } from "./src/board-fonts.ts";

const require = createRequire(import.meta.url);
const fontPath = (pkg: string, file: string) =>
  join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);

const NATIVE = ["sharp", "@napi-rs/canvas"];

const shared = {
  format: "esm",
  tsconfig: false,
  dts: false,
  clean: true,
  hash: false,
  fixedExtension: false,
  outExtensions: () => ({ js: ".js" }),
} satisfies UserConfig;

export default defineConfig([{
  ...shared,
  entry: { bootstrap: "src/bootstrap.ts", "runtime/worker": "src/runtime/worker.ts" },
  platform: "node",
  target: "node24",
  outputOptions: { chunkFileNames: "chunks/[name].js" },
  copy: BOARD_EXPORT_FONTS.map(({ pkg, file }) => ({ from: fontPath(pkg, file), to: "dist/fonts" })),
  deps: {
    alwaysBundle: (id) => !NATIVE.some((name) => id === name || id.startsWith(`${name}/`)),
    neverBundle: NATIVE,
    onlyImport: NATIVE,
    onlyBundle: false,
  },
}, {
  // Copied into Pi's extension directory, so it must stay one self-contained file.
  ...shared,
  entry: { "runtime/native/pi-extension": "src/runtime/native/pi-extension.ts" },
  platform: "node",
  target: "node24",
  outputOptions: { codeSplitting: false },
}, {
  ...shared,
  entry: { "board-gpu/page": "src/board-gpu/page.ts" },
  platform: "browser",
  target: "chrome120",
  outputOptions: { codeSplitting: false },
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
}]);
