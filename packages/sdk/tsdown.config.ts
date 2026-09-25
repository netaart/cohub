import { defineConfig, type UserConfig } from "tsdown";

const shared = {
  format: "esm",
  // Resolve @cohub/protocol through its built exports. The bundled SDK inlines it,
  // while the unbundled Board build emits private protocol modules under dist.
  tsconfig: "tsconfig.build.json",
  dts: true,
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
    ...shared,
    entry: {
      index: "src/index.ts",
      http: "src/http.ts",
      websocket: "src/websocket.ts",
      "voice-input": "src/voice-input.ts",
      debugger: "src/debugger.ts",
      "space-picker": "src/space-picker.ts",
      media: "src/media.ts",
    },
    clean: true,
    outputOptions: {
      chunkFileNames: "chunks/[name].js",
    },
  },
  {
    ...shared,
    entry: ["src/board/**/*.ts"],
    root: "src",
    unbundle: true,
    clean: false,
  },
]);
