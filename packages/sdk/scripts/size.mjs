import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const budgetUrl = new URL("size-budget.json", root);
const TOLERANCE = 1.05;

const { publishConfig } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const entries = Object.entries(publishConfig.exports).map(([name, { import: file }]) => [name, file]);

const measure = async (file) => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(file, root))],
    bundle: true,
    minify: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["pixi.js", "@napi-rs/canvas", "node:*"],
    logLevel: "error",
  });
  const code = outputFiles[0].contents;
  return { min: code.byteLength, gzip: gzipSync(code, { level: 9 }).byteLength };
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`.padStart(10);
const budget = process.argv.includes("--update") ? {} : JSON.parse(readFileSync(budgetUrl, "utf8"));
const results = {};
let failed = false;

for (const [name, file] of entries) {
  const size = await measure(file);
  results[name] = size.gzip;
  const limit = budget[name];
  const over = limit !== undefined && size.gzip > limit * TOLERANCE;
  failed ||= over;
  const note = limit === undefined ? "" : over ? `  over budget ${kb(limit).trim()}` : "";
  console.log(`${name.padEnd(22)} min ${kb(size.min)}  gzip ${kb(size.gzip)}${note}`);
}

if (process.argv.includes("--update")) {
  writeFileSync(budgetUrl, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Updated ${fileURLToPath(budgetUrl)}`);
} else if (failed) {
  console.error(`Bundle size exceeds the budget by more than ${Math.round((TOLERANCE - 1) * 100)}%. Run \`pnpm size --update\` if intended.`);
  process.exit(1);
}
