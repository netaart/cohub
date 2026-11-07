#!/usr/bin/env node
import { enableEnvProxy, envProxyExecArgv } from "./env-proxy.js";
import { relaunchCli } from "./launcher.js";
import { runCliSelfUpdate, SELF_UPDATE_WORKER_ENV, startCliSelfUpdate } from "./self-update.js";

const argv = process.argv.slice(2);
const entrypoint = process.argv[1];
const isVersionRequest = argv.some((arg) => arg === "-v" || arg === "--version");

if (process.env[SELF_UPDATE_WORKER_ENV] === "1") {
  // Self-update is best effort and must never affect the foreground command.
  await runCliSelfUpdate().catch(() => undefined);
  process.exit(0);
}

if (!isVersionRequest && !enableEnvProxy() && entrypoint) {
  process.exit(await relaunchCli(entrypoint, argv, {
    execArgv: [...envProxyExecArgv, ...process.execArgv],
  }));
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.exit(0);
});

if (argv[0] === "host" && argv[1] === "serve" && argv.length === 2) {
  const { serveHost } = await import("./host/serve.js");
  await serveHost();
  process.exit(0);
}

if (!isVersionRequest && entrypoint) process.once("exit", () => startCliSelfUpdate(entrypoint));

await import("./index.js");
