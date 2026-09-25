import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isLocalHarness } from "@neta-art/cohub";
import { discoverHarnesses, installedHarnesses } from "./harness.js";
import type { Command } from "commander";
import { requireAccessToken } from "../auth.js";
import { createClient } from "../client.js";
import { currentIdentityKey, explicitSpace } from "../space.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding, resolveRuntimeSpace } from "./space-binding.js";
import { controlRuntimeInstance, requestRuntimeInstance, runtimeInstanceDirectory } from "./instance.js";
import { ensureNativeSync, repairIntegrations } from "./native/attach.js";
import type { RuntimeDiagnostic } from "./diagnostics.js";
import { createDiagnosticConsole, printRuntimeSummary, runtimeWebUrl, type RuntimeSummary } from "./presentation.js";
import { runRuntime, type RuntimeLaunch } from "./supervisor.js";

export type RuntimeUpOptions = { space?: string; new?: boolean; name?: string; harness: string[]; pi?: string; codex?: string; yes?: boolean; json?: boolean; detach?: boolean; verbose?: boolean };
export const resolveLocalSpaceName = (root: string, name?: string) => name?.trim() || basename(root) || "local-space";
export function parseRuntimeHarnesses(values: string[]): ("pi" | "codex")[] {
  const names = values.flatMap((value) => value.split(",")).map((name) => name.trim()).filter(Boolean);
  if (names.some((name) => !isLocalHarness(name))) throw new Error("Harness must be pi or codex");
  return [...new Set(names.length ? names : ["pi"])] as ("pi" | "codex")[];
}

export async function resolveRuntimeTarget(program: Command, target?: string) {
  const spaceId = target?.trim() || explicitSpace(program) || (await getRuntimeSpaceBinding(process.cwd(), currentIdentityKey()))?.spaceId;
  if (!spaceId) throw new Error("No directory binding. Use --space <id> or runtime up");
  return spaceId;
}

export async function startBackgroundRuntime(config: RuntimeLaunch): Promise<RuntimeSummary> {
  return new Promise((resolve, reject) => {
    // Keep the same Node executable and loader (also works from source in tests).
    const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
    const child = fork(workerUrl, [], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const diagnosticConsole = createDiagnosticConsole(config.verbose);
    let last: RuntimeSummary | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      child.removeAllListeners("message");
      // Let already queued IPC messages drain before closing Node's channel.
      setImmediate(() => { if (child.connected) child.disconnect(); child.unref(); });
      if (error) reject(error);
      else if (last) resolve(last);
      else reject(new Error("Runtime did not start"));
    };
    const timeout = setTimeout(() => finish(last ? undefined : new Error("Runtime startup timed out")), 30_000);
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`Runtime exited (${code})`)));
    child.on("message", (message: { type?: string; status?: RuntimeSummary; error?: string; event?: RuntimeDiagnostic }) => {
      if (message.type === "status" && message.status) {
        last = message.status;
        if (last.state === "ready") finish();
      } else if (message.type === "failed") finish(new Error(message.error ?? "Runtime failed"));
      else if (message.type === "diagnostic" && message.event) diagnosticConsole(message.event);
    });
    child.send(config);
  });
}

export async function runtimeUp(program: Command, dir: string | undefined, options: RuntimeUpOptions) {
  const requestedRoot = resolve(dir ?? process.cwd());
  if (!(await stat(requestedRoot)).isDirectory()) throw new Error("Workspace is not a directory");
  const root = await canonicalRuntimeRoot(requestedRoot);
  const requested = options.space?.trim() || explicitSpace(program);
  if (options.new && requested) throw new Error("--new cannot be combined with --space or COHUB_SPACE_ID");
  if (options.name && requested) throw new Error("--name only applies to a new Space");
  const identity = currentIdentityKey();
  if (!identity) { await requireAccessToken(); throw new Error("Cannot identify the signed-in account"); }
  const binding = await getRuntimeSpaceBinding(root, identity);
  const existingId = requested || binding?.spaceId;
  let harnesses = parseRuntimeHarnesses(options.harness);
  if (existingId && !options.new) {
    const existing = await requestRuntimeInstance(runtimeInstanceDirectory(identity, existingId));
    if (existing) {
      if (existing.root !== root || options.harness.length && [...existing.harnesses].sort().join() !== [...harnesses].sort().join() || options.pi || options.codex) {
        throw new Error("Runtime is running with a different configuration. Use down first");
      }
      // `up` is the single idempotent entry: a reused instance adopts its running
      // Harnesses (unless explicitly overridden) and completes native sync setup.
      const native = await ensureNativeSync({ root, spaceId: existing.spaceId, identity, harnesses: options.harness.length ? harnesses : parseRuntimeHarnesses(existing.harnesses), yes: options.yes, executables: { pi: options.pi, codex: options.codex } });
      // The running Runtime applies consent given now without restarting.
      const directory = runtimeInstanceDirectory(identity, existing.spaceId);
      await controlRuntimeInstance(directory, "reload").catch(() => undefined);
      if (native.importHistory) await controlRuntimeInstance(directory, "import", { command: "start" }, 60_000).catch(() => undefined);
      printRuntimeSummary(existing, options.json, true);
      return;
    }
  }
  if (!options.harness.length) harnesses = await installedHarnesses(root, options);
  if (!harnesses.length) throw new Error("Install and sign in to Pi or Codex, or pass --harness");
  let createNew = Boolean(options.new);
  let name = resolveLocalSpaceName(root, options.name);
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error("Use --yes to authorize local execution");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (!requested && binding) {
        process.stderr.write(`\nLinked Space\n  ${runtimeWebUrl(binding.spaceId)}\n`);
        const answer = (await rl.question("Reuse this Space? [Y/n, q to cancel] ")).trim().toLowerCase();
        if (answer === "q") return;
        createNew = answer === "n" || answer === "no";
      } else if (!requested) {
        const answer = (await rl.question("Create a new Space? [Y/n] ")).trim().toLowerCase();
        if (answer && answer !== "y" && answer !== "yes") return;
      }
      if (binding && createNew && !options.name) name = `${name}-${randomUUID().slice(0, 6)}`;
      if (!requested && (!binding || createNew)) name = (await rl.question(`Space name [${name}]: `)).trim() || name;
      process.stderr.write(`\nDirectory  ${root}\n${requested ? `Space  ${runtimeWebUrl(requested)}\n` : ""}`);
      const answer = await rl.question("Collaborators can execute as your OS user, beyond this folder. Allow? [Y/n] ");
      if (/^n(o)?$/i.test(answer.trim())) return;
    } finally { rl.close(); }
  }
  if (options.yes && createNew && binding && !options.name) name = `${name}-${randomUUID().slice(0, 6)}`;
  if (createNew && binding && await requestRuntimeInstance(runtimeInstanceDirectory(identity, binding.spaceId))) {
    throw new Error("Stop the existing Runtime before rebinding this directory");
  }
  await repairIntegrations(options.pi);
  // Fail local preflight before creating remote state; the worker reuses this catalog.
  const capabilities = await discoverHarnesses(harnesses, options, root);
  const client = createClient();
  const { spaceId, source } = await resolveRuntimeSpace({
    root, identityKey: identity, explicitSpaceId: requested,
    newSpace: createNew, expectedSpaceId: binding?.spaceId ?? null,
    createSpace: async () => (await client.spaces.create({ name, config: { sandbox: { provider: "local" } } })).space.id,
    validateSpace: async (id) => {
      const sandbox = (await client.space(id).sandbox.get()).sandbox;
      if (sandbox?.provider !== "local") throw new Error("Space does not have a local Runtime");
    },
  });
  // Consent (or --yes) precedes any user-level integration install; failure never blocks startup.
  const native = await ensureNativeSync({ root, spaceId, identity, harnesses, yes: options.yes, executables: { pi: options.pi, codex: options.codex } });
  const config: RuntimeLaunch = { spaceId, root, identity, harnesses, capabilities, executables: { pi: options.pi, codex: options.codex }, background: Boolean(options.detach), verbose: options.verbose, importHistory: native.importHistory };
  const existing = await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId));
  if (existing) {
    if (existing.root !== root) throw new Error("This Space is running in another directory");
    printRuntimeSummary(existing, options.json, true); return;
  }
  if (options.detach) {
    const summary = await startBackgroundRuntime(config);
    printRuntimeSummary(summary, options.json, source === "binding");
    if (summary.state !== "ready") process.exitCode = 2;
  } else {
    let announced = false;
    await runRuntime(config, (status) => {
      if (!announced && status.state === "ready") { announced = true; printRuntimeSummary(status, options.json, source === "binding"); }
      else if (!announced && status.state === "starting" && !options.json) process.stderr.write(`Connecting\n  ${runtimeWebUrl(spaceId)}\n  Logs  ${status.diagnosticsPath}\n`);
    });
  }
}
