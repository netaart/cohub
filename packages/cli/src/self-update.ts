import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, homedir, setPriority } from "node:os";
import { join } from "node:path";
import { packagePath } from "./package-paths.js";
import { CLI_VERSION } from "./version.js";

const PACKAGE_NAME = "@neta-art/cohub-cli";
export const SELF_UPDATE_WORKER_ENV = "COHUB_CLI_SELF_UPDATE_WORKER";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const MAX_JITTER_MS = 60_000;
const VIEW_TIMEOUT_MS = 15_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const DIRECTORY = join(homedir(), ".cache", "cohub-cli");
const STATE_PATH = join(DIRECTORY, "self-update.json");
const CLAIM_PATH = join(DIRECTORY, "self-update.lock");
const CLAIM_PID_PATH = join(CLAIM_PATH, "pid");
const CLAIM_PENDING_MS = 60_000;
const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type UpdateState = {
  checkedAt?: string;
  installedVersion?: string;
  latestVersion?: string;
  result?: "current" | "updated" | "failed";
  error?: string;
};

const parsePositiveIntEnv = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getIntervalMs = () => {
  const explicitMs = process.env.COHUB_CLI_UPDATE_INTERVAL_MS;
  if (explicitMs?.trim()) return parsePositiveIntEnv("COHUB_CLI_UPDATE_INTERVAL_MS", DEFAULT_INTERVAL_MS);

  const hours = process.env.COHUB_CLI_UPDATE_INTERVAL_HOURS;
  if (hours?.trim()) {
    const value = Number.parseFloat(hours);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 60 * 60 * 1000);
  }

  return DEFAULT_INTERVAL_MS;
};

const getInstallTimeoutMs = () => parsePositiveIntEnv("COHUB_CLI_UPDATE_TIMEOUT_MS", DEFAULT_INSTALL_TIMEOUT_MS);

const readState = (): UpdateState => {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as UpdateState;
  } catch {
    return {};
  }
};

const writeState = (state: Omit<UpdateState, "checkedAt">) => {
  mkdirSync(DIRECTORY, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ checkedAt: new Date().toISOString(), ...state }, null, 2)}\n`);
};

const readInstalledVersion = (): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(packagePath("package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
};

const parseVersion = (value: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(value.trim());
  if (!match) return null;
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { core, prerelease: Boolean(match[4]) };
};

export function isNewerVersion(candidate: string, installed: string | undefined): boolean {
  const next = parseVersion(candidate);
  if (!next) return false;
  const current = installed === undefined ? null : parseVersion(installed);
  if (!current) return true;
  const [major, minor, patch] = next.core;
  const [installedMajor, installedMinor, installedPatch] = current.core;
  const delta = major - installedMajor || minor - installedMinor || patch - installedPatch;
  return delta === 0 ? current.prerelease && !next.prerelease : delta > 0;
}

const isDue = (): boolean => {
  const state = readState();
  const checkedAt = Date.parse(state.checkedAt ?? "");
  if (!Number.isFinite(checkedAt)) return true;
  const interval = getIntervalMs();
  return Date.now() - checkedAt >= (state.result === "failed" ? Math.min(RETRY_INTERVAL_MS, interval) : interval);
};

const claimHolder = (): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(CLAIM_PID_PATH, "utf-8"), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isAbandoned = () => {
  const age = Date.now() - statSync(CLAIM_PATH).mtimeMs;
  if (age > CLAIM_MAX_AGE_MS) return true;
  const holder = claimHolder();
  return holder === null ? age > CLAIM_PENDING_MS : !isAlive(holder);
};

const claim = (): boolean => {
  try {
    mkdirSync(DIRECTORY, { recursive: true });
    mkdirSync(CLAIM_PATH);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  try {
    if (!isAbandoned()) return false;
    rmSync(CLAIM_PATH, { recursive: true, force: true });
    mkdirSync(CLAIM_PATH);
    return true;
  } catch {
    return false;
  }
};

const release = () => rmSync(CLAIM_PATH, { recursive: true, force: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runNpm = (args: string[], timeoutMs: number, stop: "kill" | "interrupt") => {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("npm", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (stop === "kill") setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString().trim();
      const detail = [stderr, stdout].filter(Boolean).join("\n");
      reject(new Error(`npm ${args.join(" ")} failed${signal ? ` (${signal})` : code !== null ? ` (exit ${code})` : ""}${detail ? `:\n${detail}` : ""}`));
    });
  });
};

export function startCliSelfUpdate(entrypoint: string): void {
  if (process.env.COHUB_CLI_AUTO_UPDATE === "0" || !isDue() || !claim()) return;
  let worker: ChildProcess | undefined;
  try {
    worker = spawn(process.execPath, [entrypoint], {
      detached: true,
      env: { ...process.env, [SELF_UPDATE_WORKER_ENV]: "1" },
      stdio: "ignore",
      windowsHide: true,
    });
    worker.unref();
    if (worker.pid === undefined) throw new Error("The self-update worker did not start");
    writeFileSync(CLAIM_PID_PATH, String(worker.pid));
  } catch {
    worker?.kill();
    release();
  }
}

export async function runCliSelfUpdate(): Promise<void> {
  try {
    try {
      setPriority(constants.priority.PRIORITY_LOW);
    } catch {}
    await sleep(Math.random() * MAX_JITTER_MS);
    let latestVersion: string | undefined;
    try {
      latestVersion = await runNpm(["view", `${PACKAGE_NAME}@latest`, "version"], VIEW_TIMEOUT_MS, "kill");
      if (!isNewerVersion(latestVersion, CLI_VERSION)) {
        writeState({ installedVersion: CLI_VERSION, latestVersion, result: "current" });
        return;
      }
      // Reinstalling briefly removes the `cohub` bin, so only do it for a newer release.
      await runNpm(["install", "-g", `${PACKAGE_NAME}@${latestVersion}`, "--silent"], getInstallTimeoutMs(), "interrupt");
      writeState({ installedVersion: readInstalledVersion(), latestVersion, result: "updated" });
    } catch (error) {
      writeState({
        installedVersion: CLI_VERSION,
        latestVersion,
        result: "failed",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  } finally {
    if (claimHolder() === process.pid) release();
  }
}
