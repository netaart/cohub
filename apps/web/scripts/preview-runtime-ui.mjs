#!/usr/bin/env node
// Isolated component preview: only fixture data, never a real account or API.
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const web = fileURLToPath(new URL("../", import.meta.url));
const route = join(web, "src/routes/__runtime-preview");
await mkdir(route); // Refuse to overwrite an existing route.
let child;
async function cleanup() { await rm(route, { recursive: true, force: true }); }
try {
  await copyFile(join(web, "src/tests/fixtures/runtime-preview.svelte"), join(route, "+page.svelte"));
  await writeFile(join(route, "+page.ts"), "export const ssr = false;\n");
  child = spawn("pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", "4175", "--strictPort"], {
    cwd: web, stdio: "inherit",
    env: { ...process.env, PUBLIC_API_ORIGIN: "http://127.0.0.1:9", PUBLIC_GATEWAY_ORIGIN: "ws://127.0.0.1:9" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
} finally { await cleanup(); }
