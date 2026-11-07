import { defineConfig, type UserConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

const entry = Object.fromEntries(
  Object.values(pkg.exports).map(({ import: source }) => [source.replace(/^\.\/src\/(.+)\.ts$/, "$1"), source]),
);

const shared = {
  entry,
  format: "esm",
  // Resolve @cohub/protocol through its built exports; the SDK inlines it.
  tsconfig: "tsconfig.build.json",
  target: "es2022",
  fixedExtension: false,
  hash: false,
  deps: {
    onlyBundle: false,
  },
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
} satisfies UserConfig;

export default defineConfig([
  {
    // One file per module: entries share instances and consumers tree-shake per module.
    ...shared,
    unbundle: true,
    root: "src",
    dts: false,
    clean: true,
  },
  {
    ...shared,
    dts: { emitDtsOnly: true },
    clean: false,
    // @openrouter/sdk's `declare global` augmentation would otherwise keep every
    // transitively imported OpenRouter declaration file in the output.
    treeshake: {
      moduleSideEffects: [{ test: /[\\/]node_modules[\\/]@openrouter[\\/]sdk[\\/]/, sideEffects: false }],
    },
    outputOptions: {
      chunkFileNames: "chunks/[name].js",
    },
  },
]);
