#!/usr/bin/env node
// Typecheck for apps/web.
//
// - `svelte-kit sync` only runs when the generated `$app/tsconfig` is stale: missing,
//   older than the config files (package.json / vite.config / .env), or older than any
//   file under src/ (route additions/renames/removals regenerate $types).
// - `svelte-check --tsgo --incremental` reuses the svelte2tsx + tsgo caches under
//   .svelte-kit/.svelte-check (gitignored), so steady-state runs are fast.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const webDir = path.resolve(import.meta.dirname, "../apps/web");
const binDir = path.join(webDir, "node_modules", ".bin");
const kitTsconfig = path.join(webDir, "node_modules", "$app", "tsconfig.json");
const CONFIG_FILES = ["package.json", "vite.config.ts", ".env"];

function run(bin, args) {
  const result = spawnSync(path.join(binDir, bin), args, {
    cwd: webDir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    // Killed by a signal (e.g. OOM): status is null and must not be treated as success.
    console.error(`typecheck: ${bin} was terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

function newestMtimeIn(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else {
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

function syncNeeded() {
  if (!fs.existsSync(kitTsconfig)) return true;
  const kitMtime = fs.statSync(kitTsconfig).mtimeMs;
  const configNewer = CONFIG_FILES.some((file) => {
    const p = path.join(webDir, file);
    return fs.existsSync(p) && fs.statSync(p).mtimeMs > kitMtime;
  });
  return configNewer || newestMtimeIn(path.join(webDir, "src")) > kitMtime;
}

let status = 0;
if (syncNeeded()) {
  console.log("typecheck: running svelte-kit sync");
  status = run("svelte-kit", ["sync"]);
  if (status !== 0) process.exit(status);
} else {
  console.log("typecheck: .svelte-kit is up to date, skipping sync");
}

status = run("svelte-check", [
  "--tsgo",
  "--incremental",
  "--tsconfig",
  "./tsconfig.json",
]);
process.exit(status);
