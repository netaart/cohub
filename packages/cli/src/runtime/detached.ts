import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalHarness } from "@neta-art/cohub";
import { packagePath } from "../package-paths.js";
import { isNewerVersion, readInstalledVersion } from "../self-update.js";
import { CLI_VERSION } from "../version.js";
import type { HarnessExecutables } from "./harnesses/index.js";
import { controlRuntimeInstance, requestRuntimeInstance, runtimeInstanceStopped, watchRuntimeInstance } from "./instance.js";
import type { RuntimeSummary } from "./presentation.js";

export const EXPECTED_IDENTITY_ENV = "COHUB_RUNTIME_EXPECTED_IDENTITY";
export const RUNTIME_HANDOFF_ENV = "COHUB_RUNTIME_HANDOFF";

const CHECK_MS = 60_000;
const LAUNCH_MS = 10 * 60_000;

export type UpdateTarget = { version: string; node: string; entry: string; sandboxd?: string };

export async function launchDetachedRuntime(input: { node: string; entry: string; root: string; spaceId: string; identity: string; args: string[]; env: NodeJS.ProcessEnv }) {
  const child = spawn(input.node, [input.entry, "runtime", "up", input.root, "--space", input.spaceId, "--detach", "--yes", "--json", ...input.args], {
    env: { ...input.env, [EXPECTED_IDENTITY_ENV]: input.identity }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code === 0 || code === 2) return;
  const reason = stderr.trim().split("\n").at(-1)?.replace(/^Runtime failed: /, "");
  throw new Error(reason || `Runtime exited (${code})`);
}

export async function requestRuntimeUpdate(directory: string, target: UpdateTarget = { version: CLI_VERSION, node: process.execPath, entry: packagePath("bin", "cohub.js"), sandboxd: process.env.COHUB_SANDBOXD_BIN }) {
  const response = await controlRuntimeInstance(directory, "update", target);
  return { status: response?.status ?? null, started: (response?.result as { started?: unknown } | undefined)?.started === true };
}

export async function awaitRuntimeVersion(directory: string, version: string, timeoutMs = 120_000): Promise<RuntimeSummary | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await requestRuntimeInstance(directory).catch(() => undefined);
    if (status?.version === version && status.state === "ready") return status;
    if (status === null || status && status.version !== version && !status.update && !status.handoff) return null;
    await delay(500);
  }
  return null;
}

export async function successorServes(directory: string, runtimeId: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let served = false;
  while (!deadline.aborted) {
    const settled = new AbortController();
    const streamed = await watchRuntimeInstance(directory, (status) => {
      if (status.runtimeId !== runtimeId || status.state === "ready" || status.state === "stopping") { served = true; settled.abort(); }
    }, AbortSignal.any([deadline, settled.signal]));
    if (served) return true;
    if (!streamed && await requestRuntimeInstance(directory).catch(() => undefined) === null) return runtimeInstanceStopped(directory);
    await delay(100, undefined, { signal: deadline }).catch(() => undefined);
  }
  return true;
}

type UpdaterOptions = {
  spaceId: string; root: string; identity: string; runtimeId: string;
  harnesses: LocalHarness[]; executables: HarnessExecutables;
  auto: boolean;
  skip?: string;
  display: () => string | undefined;
  idle: () => Promise<boolean>;
  pending: (version: string | undefined) => void;
  log: (level: "info" | "warn", event: string, data?: Record<string, unknown>) => void;
};

export function createRuntimeUpdater(options: UpdaterOptions) {
  let target: UpdateTarget | null = null;
  let installed: string | undefined;
  let skip = options.skip;
  type Attempt = UpdateTarget & { display?: string; deferred: boolean; failure: AbortController };
  let launching: Attempt | null = null;
  let failure = new AbortController();
  const settle = (next: UpdateTarget | null) => { target = next; options.pending(next?.version); };
  const launch = (next: UpdateTarget) => {
    const display = options.display();
    const attempt: Attempt = { ...next, display, deferred: false, failure: failure = new AbortController() };
    launching = attempt;
    options.log("info", "runtime.handoff_started", { version: next.version });
    const args = [
      ...options.harnesses.flatMap((harness) => ["--harness", harness]),
      ...Object.entries(options.executables).flatMap(([harness, path]) => path ? [`--${harness}`, path] : []),
      ...display ? ["--display", display] : ["--no-display"],
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, [RUNTIME_HANDOFF_ENV]: options.runtimeId };
    if (next.sandboxd) env.COHUB_SANDBOXD_BIN = next.sandboxd;
    else delete env.COHUB_SANDBOXD_BIN;
    const release = () => { if (launching === attempt) launching = null; };
    void launchDetachedRuntime({ ...next, root: options.root, spaceId: options.spaceId, identity: options.identity, args, env })
      .then(() => { setTimeout(release, LAUNCH_MS).unref(); }, (error: unknown) => {
        release();
        if (attempt.deferred) return;
        skip = next.version;
        if (target === next) settle(null);
        attempt.failure.abort();
        options.log("warn", "runtime.handoff_failed", { version: next.version, error: error instanceof Error ? error.message : String(error) });
      });
  };
  const check = async () => {
    if (options.auto && !target) {
      const version = readInstalledVersion();
      if (version && version !== skip && isNewerVersion(version, CLI_VERSION)) {
        // `npm install -g` replaces files in place; a version read on two checks in a row is settled.
        if (version === installed) {
          settle({ version, node: process.execPath, entry: packagePath("bin", "cohub.js"), sandboxd: process.env.COHUB_SANDBOXD_BIN });
          options.log("info", "runtime.update_pending", { version });
        }
        installed = version;
      }
    }
    if (target && !launching && await options.idle() && !launching) launch(target);
  };
  const timer = setInterval(() => void check().catch(() => undefined), CHECK_MS);
  timer.unref();
  return {
    get launching() { return launching; },
    get failed() { return failure.signal; },
    async request(next: UpdateTarget) {
      if (!isNewerVersion(next.version, CLI_VERSION)) throw new Error(`This Runtime already runs ${CLI_VERSION}`);
      if (skip === next.version) skip = undefined;
      if (!launching) settle(next);
      await check();
      return { started: launching !== null };
    },
    defer() { if (launching) launching.deferred = true; launching = null; },
    close() { clearInterval(timer); },
  };
}
