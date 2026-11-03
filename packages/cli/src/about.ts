import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { CliAbout } from "@neta-art/cohub/host-bridge";
import { controlRuntimeInstance, runtimeInstanceDirectory } from "./runtime/instance.js";
import { readRuntimeSpaceBindings } from "./runtime/space-binding.js";
import { CLI_VERSION, cliCommit } from "./version.js";

const PROBE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 1_000;
const PROBE_TTL_MS = 5 * 60_000;

type Probe = { key: string; at: number; version: Promise<string | null> };
let probe: Probe | null = null;

export async function describeCli(env: NodeJS.ProcessEnv, identity: string | null): Promise<CliAbout> {
  const [path, runtimes] = await Promise.all([pathCli(env), identity ? runningRuntimes(identity) : []]);
  return { version: CLI_VERSION, commit: cliCommit(), node: process.versions.node, path, runtimes };
}

async function pathCli(env: NodeJS.ProcessEnv): Promise<CliAbout["path"]> {
  const path = await findOnPath("cohub", await searchPath(env), env);
  if (!path) return null;
  // A shim keeps its file across upgrades, so a remembered answer also expires.
  const target = await realpath(path).catch(() => path);
  const key = `${target}\0${await stat(target).then((info) => info.mtimeMs, () => 0)}`;
  if (probe?.key !== key || Date.now() - probe.at > PROBE_TTL_MS) probe = { key, at: Date.now(), version: askVersion(path, env) };
  const current = probe;
  const version = await current.version;
  if (!version && probe === current) probe = null;
  return { path, version };
}

/** A GUI app's own PATH is stale on Windows; the registry holds what a new terminal gets. */
async function searchPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  const own = (env.PATH ?? env.Path ?? "").split(delimiter);
  if (process.platform !== "win32") return own.filter(Boolean);
  const read = (key: string) => new Promise<string>((resolve) => execFile("reg.exe", ["query", key, "/v", "Path"], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (_error, stdout) => {
    resolve(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(stdout ?? "")?.[1]?.trim() ?? "");
  }));
  const [machine, user] = await Promise.all([read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), read("HKCU\\Environment")]);
  const expand = (value: string) => value.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? env[name.toUpperCase()] ?? whole);
  return [...new Set([machine, user].flatMap((value) => expand(value).split(delimiter)).concat(own).filter(Boolean))];
}

async function findOnPath(name: string, directories: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const windows = process.platform === "win32";
  const extensions = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension.toLowerCase());
      if (await access(candidate, windows ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  return null;
}

function askVersion(path: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  // Node refuses to spawn batch files directly; cmd.exe runs them with the path quoted verbatim.
  const [file, args, verbatim] = /\.(cmd|bat)$/i.test(path)
    ? [env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${path}" --version"`], true]
    : [path, ["--version"], false];
  return new Promise((resolve) => execFile(file, args, { env, timeout: PROBE_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: verbatim }, (error, stdout) => {
    resolve(error ? null : /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? null);
  }));
}

async function runningRuntimes(identity: string): Promise<CliAbout["runtimes"]> {
  const { bindings } = await readRuntimeSpaceBindings().catch(() => ({ bindings: [] }));
  const spaces = new Map(bindings.filter((binding) => binding.key === identity).map((binding) => [binding.spaceId, binding.root]));
  const statuses = await Promise.all([...spaces.keys()].slice(-256).map((spaceId) =>
    controlRuntimeInstance(runtimeInstanceDirectory(identity, spaceId), "status", {}, STATUS_TIMEOUT_MS).catch(() => null)));
  return statuses.flatMap((response) => response
    ? [{ spaceId: response.status.spaceId, root: response.status.root, version: response.status.version ?? null }]
    : []);
}
