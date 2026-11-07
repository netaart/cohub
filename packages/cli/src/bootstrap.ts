#!/usr/bin/env node
import { enableEnvProxy, envProxyExecArgv } from "./env-proxy.js";
import { relaunchCli } from "./launcher.js";
import { runCliSelfUpdate, SELF_UPDATE_WORKER_ENV, startCliSelfUpdate } from "./self-update.js";

const argv = process.argv.slice(2);
const entrypoint = process.argv[1];
const isVersionRequest = argv.some((arg) => arg === "-v" || arg === "--version");

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.exit(0);
});

if (argv.length === 1 && isVersionRequest) {
  const { CLI_VERSION } = await import("./version.js");
  await new Promise((resolve) => process.stdout.write(`${CLI_VERSION}\n`, resolve));
  process.exit(0);
}

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

if (argv[0] === "host" && argv[1] === "serve" && argv.length === 2) {
  const { serveHost } = await import("./host/serve.js");
  await serveHost();
  process.exit(0);
}

if (!isVersionRequest && entrypoint) process.once("exit", () => startCliSelfUpdate(entrypoint));

await import("./index.js");
