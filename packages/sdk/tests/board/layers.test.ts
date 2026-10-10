import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LAYERS = {
  model: [],
  player: ["model"],
  replica: ["model"],
  editor: ["model"],
  render: ["model"],
  export: ["model", "render"],
  "export/node": ["model", "render", "export"],
  stage: ["model", "player", "render", "editor"],
  client: ["model", "replica"],
} satisfies Record<string, string[]>;
type Layer = keyof typeof LAYERS;

const SHARED_SDK_MODULES = new Set(["types.ts", "generation-blocks.ts", "media.ts"]);
const PACKAGES: Record<string, Layer[]> = {
  "pixi.js": ["render", "export", "export/node", "stage"],
  "@napi-rs/canvas": ["export/node"],
  "perfect-freehand": ["model"],
  zod: ["model", "editor"],
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const board = join(root, "board");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function layerOf(file: string): Layer | null {
  const path = relative(board, file);
  if (path.startsWith("..")) return null;
  if (path.startsWith("export/node/")) return "export/node";
  return path.split("/")[0] as Layer;
}

function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((match) => match[1] as string);
}

test("board layers only import downward", () => {
  const violations: string[] = [];
  for (const file of files(board)) {
    const layer = layerOf(file);
    assert.ok(layer && layer in LAYERS, `${relative(root, file)} is outside a known layer`);
    const allowed = new Set<string>([layer, ...LAYERS[layer]]);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const where = `${relative(root, file)} -> ${specifier}`;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
        const targetLayer = layerOf(target);
        if (targetLayer === null) {
          if (layer !== "client" && !SHARED_SDK_MODULES.has(relative(root, target))) violations.push(where);
        } else if (!allowed.has(targetLayer)) violations.push(where);
        continue;
      }
      if (specifier.startsWith("node:")) {
        if (layer !== "export/node") violations.push(where);
        continue;
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (name === "@cohub/protocol") continue;
      if (!PACKAGES[name as string]?.includes(layer)) violations.push(where);
    }
  }
  assert.deepEqual(violations, []);
});
