import { spawn } from "node:child_process";
import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { opendir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { DEVICE_RUNTIME_REFUSALS, DEVICE_RUNTIME_STOP_REFUSALS, DeviceDisplayStatus, DeviceFolderListing, DeviceRuntime, DeviceRuntimeInstance } from "@neta-art/cohub/host-bridge";
import { EXPECTED_IDENTITY_ENV } from "../runtime/launch.js";
import { controlRuntimeInstance, requestRuntimeInstance, runtimeInstanceDirectory, runtimeInstancesRoot, stopRuntimeInstance, UNCONFIRMED_WORK, watchRuntimeInstance } from "../runtime/instance.js";
import { readRuntimePreferences, writeRuntimePreferences } from "../runtime/preferences.js";
import type { RuntimeSummary } from "../runtime/presentation.js";
import { readRuntimeSpaceBindings, runtimeSpaceBindingsPath } from "../runtime/space-binding.js";
import { forgetHostRuntime, hostRuntimes, rememberHostRuntime } from "./runtimes.js";
import type { HostEmit } from "./serve.js";

const MAX_INSTANCES = 256;
const MAX_FOLDERS = 10_000;
const MAX_VOLUMES = 16;

const DISPLAY_CONTROL_MS = 15_000;
const SHARED_SCREEN = "auto";
const NO_SCREEN = "";

type Refusal = (typeof DEVICE_RUNTIME_REFUSALS)[number];
type StopRefusal = (typeof DEVICE_RUNTIME_STOP_REFUSALS)[number];
type Transient = Pick<DeviceRuntimeInstance, "root" | "state" | "error">;

export type DeviceRuntimeHostOptions = {
  cli: string;
  env: () => Promise<NodeJS.ProcessEnv>;
  account: () => string | null;
};

const isRunningState = (state: DeviceRuntimeInstance["state"] | undefined) => state === "connecting" || state === "ready";
const isRunning = (instance: DeviceRuntimeInstance | undefined): instance is DeviceRuntimeInstance => isRunningState(instance?.state);
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function deviceState(status: RuntimeSummary | null): DeviceRuntimeInstance["state"] {
  if (!status || status.state === "stopping") return "stopped";
  if (status.state === "ready") return "ready";
  return status.state === "attention" ? "error" : "connecting";
}

const isDenied = (error: unknown) => ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

function launchFailure(message: string): string {
  if (/non-elevated/.test(message)) return "elevated";
  if (/EPERM|EACCES|permission denied|operation not permitted/i.test(message)) return "folder_denied";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Download of \S+ (failed|timed out)/.test(message)) return "offline";
  return "failed";
}

function hasWindowsShell(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COHUB_BASH) return true;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")];
  const directories = (env.PATH ?? env.Path ?? "").split(";").filter((entry) => /[\\/]git[\\/]/i.test(entry));
  return [...roots.flatMap((root) => root ? [join(root, "Git", "bin", "bash.exe")] : []), ...directories.map((entry) => join(entry, "bash.exe")), ...directories.map((entry) => join(dirname(entry), "bin", "bash.exe"))].some((path) => existsSync(path));
}

function displayPath(path: string, home = homedir()) {
  if (process.platform === "win32") return path;
  const inside = relative(home, path);
  if (!inside) return "~";
  return inside.startsWith("..") || inside.startsWith(sep) ? path : `~/${inside}`;
}

async function isDirectory(path: string) {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

async function volumes(): Promise<DeviceFolderListing["volumes"]> {
  const home = homedir();
  const homeVolume = { path: home, label: basename(home) || home };
  if (process.platform === "win32") {
    const drives = await Promise.all([..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map(async (letter) => {
      const path = `${letter}:\\`;
      return await isDirectory(path) ? { path, label: `${letter}:` } : null;
    }));
    return [homeVolume, ...drives.filter((drive) => drive !== null)].slice(0, MAX_VOLUMES);
  }
  if (process.platform === "darwin") {
    const mounted = await readdir("/Volumes").catch(() => []);
    const resolved = await Promise.all(mounted.map(async (name) => {
      const path = await realpath(join("/Volumes", name)).catch(() => null);
      return path ? { path, label: name } : null;
    }));
    return [homeVolume, ...resolved.filter((volume) => volume !== null)].slice(0, MAX_VOLUMES);
  }
  return [homeVolume, { path: "/", label: "/" }];
}

export class DeviceRuntimeHost {
  #watchers: FSWatcher[] = [];
  #subscriptions = new Map<string, AbortController>();
  #debounce: NodeJS.Timeout | undefined;
  #published = "";
  #restoring: Promise<void> = Promise.resolve();
  #unwatchable = new Set<string>();
  #transient = new Map<string, Transient>();
  #screen: DeviceDisplayStatus = { sharedWith: null, control: false, error: null };
  #publishedScreen = "";
  #shared = new Set<string>();
  #screenWork: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly emit: HostEmit,
    private readonly options: DeviceRuntimeHostOptions,
  ) {}

  watch() {
    this.#watch();
    void this.restore();
  }

  close() {
    clearTimeout(this.#debounce);
    for (const watcher of this.#watchers) watcher.close();
    for (const subscription of this.#subscriptions.values()) subscription.abort();
  }

  #watch() {
    const bindings = runtimeSpaceBindingsPath();
    const instances = runtimeInstancesRoot();
    mkdirSync(dirname(bindings), { recursive: true, mode: 0o700 });
    mkdirSync(instances, { recursive: true, mode: 0o700 });
    const watchers = [
      watch(dirname(bindings), (_event, name) => { if (!name || name === basename(bindings)) this.changed(); }),
      watch(instances, { recursive: true }, () => this.changed()),
    ];
    this.#watchers = watchers;
    const rewatch = () => {
      if (this.#watchers !== watchers) return;
      this.#watchers = [];
      for (const watcher of watchers) watcher.close();
      setTimeout(() => { this.#watch(); this.changed(); }, 1_000).unref();
    };
    for (const watcher of watchers) watcher.on("error", rewatch);
  }

  changed() {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.#publish().catch(() => undefined), 100);
  }

  async list(): Promise<DeviceRuntime> {
    const key = this.options.account();
    if (!key) return { instances: [] };
    const bindings = (await readRuntimeSpaceBindings().catch(() => ({ bindings: [] }))).bindings;
    const roots = new Map<string, string>();
    for (const binding of bindings) {
      if (binding.key !== key) continue;
      roots.delete(binding.spaceId);
      roots.set(binding.spaceId, binding.root);
    }
    for (const [spaceId, { root }] of this.#transient) if (!roots.has(spaceId)) roots.set(spaceId, root);
    let screen: DeviceDisplayStatus = { sharedWith: null, control: false, error: null };
    const shared = new Set<string>();
    const hasShell = process.platform !== "win32" || hasWindowsShell();
    const instances = await Promise.all([...roots].slice(-MAX_INSTANCES).map(async ([spaceId, root]): Promise<DeviceRuntimeInstance> => {
      const directory = runtimeInstanceDirectory(key, spaceId);
      const transient = this.#transient.get(spaceId);
      try {
        const status = await requestRuntimeInstance(directory);
        if (!status && transient) return { spaceId, ...transient, label: displayPath(transient.root) };
        if (status) this.#subscribe(directory, status.pid);
        if (status?.display) {
          const needs = status.displayNeeds ?? [];
          if (status.displayOnRequest) shared.add(spaceId);
          screen = { sharedWith: spaceId, control: !needs.includes("accessibility"), error: needs.includes("screenRecording") ? "screen_recording" : null };
        }
        const path = status?.root ?? root;
        const state = deviceState(status);
        return { spaceId, root: path, label: displayPath(path), state, error: status?.state === "attention" ? "attention" : isRunningState(state) && !hasShell ? "no_shell" : null };
      } catch {
        return { spaceId, root, label: displayPath(root), state: "error", error: "unreachable" };
      }
    }));
    this.#screen = screen;
    this.#shared = shared;
    return { instances };
  }

  async browse(path?: string): Promise<DeviceFolderListing> {
    const target = await realpath(path ?? homedir());
    if (!await isDirectory(target)) throw new Error("Not a folder");
    const entries = await readdir(target, { withFileTypes: true });
    const folders = (await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return null;
      const folder = join(target, entry.name);
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(folder));
      return directory ? { name: entry.name, path: folder } : null;
    })))
      .filter((folder) => folder !== null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, MAX_FOLDERS);
    const key = this.options.account();
    const bindings = key ? (await readRuntimeSpaceBindings().catch(() => ({ bindings: [] }))).bindings : [];
    const parent = dirname(target);
    return {
      path: target,
      label: displayPath(target),
      parent: parent === target ? null : parent,
      spaceId: bindings.filter((binding) => binding.key === key && samePath(binding.root, target)).at(-1)?.spaceId ?? null,
      folders,
      volumes: await volumes(),
    };
  }

  async connect(spaceId: string, root: string): Promise<DeviceRuntime & { refused: Refusal | null }> {
    const key = this.options.account();
    if (!key) throw new Error("Sign in first");
    const folder = await realpath(root).catch(() => null);
    const current = await this.list();
    if (!folder || !await isDirectory(folder)) return { ...current, refused: "folder_unavailable" };
    const serving = current.instances.find((instance) => instance.spaceId === spaceId);
    if (isRunning(serving)) return { ...current, refused: samePath(serving.root, folder) ? null : "space_in_use" };
    if (current.instances.some((instance) => isRunning(instance) && samePath(instance.root, folder))) return { ...current, refused: "folder_in_use" };
    const denied = await opendir(folder).then((directory) => directory.close().then(() => false), isDenied);
    if (denied) return { ...current, refused: "folder_denied" };
    this.#transient.set(spaceId, { root: folder, state: "connecting", error: null });
    void this.#publish().catch(() => undefined);
    try {
      await this.#launch(key, spaceId, folder);
      await rememberHostRuntime({ key, spaceId, root: folder });
      this.#transient.delete(spaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not connect ${folder}: ${message}\n`);
      this.#transient.set(spaceId, { root: folder, state: "error", error: launchFailure(message) });
    }
    return { ...await this.#publish(), refused: null };
  }

  async disconnect(spaceId: string, force = false): Promise<DeviceRuntime & { refused: StopRefusal | null }> {
    const key = this.options.account();
    if (!key) throw new Error("Sign in first");
    this.#transient.delete(spaceId);
    try {
      await stopRuntimeInstance(runtimeInstanceDirectory(key, spaceId), force);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(UNCONFIRMED_WORK)) return { ...await this.list(), refused: "unconfirmed_work" };
      throw error;
    }
    await forgetHostRuntime(key, spaceId);
    return { ...await this.#publish(), refused: null };
  }

  async stopAccount(): Promise<void> {
    const key = this.options.account();
    if (!key) return;
    const { instances } = await this.list();
    await Promise.allSettled(instances.filter(isRunning).map((instance) => stopRuntimeInstance(runtimeInstanceDirectory(key, instance.spaceId), true)));
    this.accountChanged();
  }

  accountChanged() {
    this.#transient.clear();
  }

  async displayStatus(): Promise<DeviceDisplayStatus> {
    await this.list();
    return this.#screen;
  }

  #serialScreen<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#screenWork.then(work);
    this.#screenWork = run.catch(() => undefined);
    return run;
  }

  share(spaceId: string): Promise<DeviceDisplayStatus> {
    return this.#serialScreen(async () => {
      const key = this.options.account();
      if (!key) throw new Error("Sign in first");
      const { instances } = await this.list();
      if (!isRunning(instances.find((instance) => instance.spaceId === spaceId))) throw new Error("This device does not serve that Space");
      const previous = this.#screen.sharedWith;
      if (previous && previous !== spaceId) await this.#setScreen(key, previous, NO_SCREEN);
      await this.#setScreen(key, spaceId, SHARED_SCREEN);
      await this.#publish();
      return this.#screen;
    });
  }

  stopSharing(): Promise<DeviceDisplayStatus> {
    return this.#serialScreen(async () => {
      const key = this.options.account();
      if (!key) throw new Error("Sign in first");
      await this.list();
      if (this.#screen.sharedWith) await this.#setScreen(key, this.#screen.sharedWith, NO_SCREEN);
      await this.#publish();
      return this.#screen;
    });
  }

  stopOwnSharing(): Promise<void> {
    return this.#serialScreen(async () => {
      const key = this.options.account();
      if (!key) return;
      await this.list();
      const results = await Promise.allSettled([...this.#shared].map((spaceId) => this.#setScreen(key, spaceId, NO_SCREEN)));
      for (const result of results) if (result.status === "rejected") process.stderr.write(`Could not stop sharing the screen: ${String(result.reason)}\n`);
    });
  }

  async keepAwake(enabled?: boolean): Promise<boolean> {
    if (enabled === undefined) return (await readRuntimePreferences()).keepAwake;
    await writeRuntimePreferences({ keepAwake: enabled });
    const key = this.options.account();
    if (key) {
      const { instances } = await this.list();
      await Promise.allSettled(instances.filter(isRunning).map((instance) => controlRuntimeInstance(runtimeInstanceDirectory(key, instance.spaceId), "keepAwake")));
    }
    return enabled;
  }

  async #setScreen(key: string, spaceId: string, spec: string) {
    await controlRuntimeInstance(runtimeInstanceDirectory(key, spaceId), "display", { spec }, DISPLAY_CONTROL_MS);
  }

  restore(): Promise<void> {
    this.#restoring = this.#restoring.then(async () => {
      const key = this.options.account();
      if (!key) return;
      // A failed read skips this restore; nothing is forgotten.
      const { bindings } = await readRuntimeSpaceBindings();
      for (const item of await hostRuntimes(key)) {
        const bound = bindings.filter((binding) => binding.key === key && binding.spaceId === item.spaceId).at(-1);
        if (!bound || !samePath(bound.root, item.root)) { await forgetHostRuntime(key, item.spaceId); continue; }
        const running = await requestRuntimeInstance(runtimeInstanceDirectory(key, item.spaceId)).catch(() => true);
        if (running || !await isDirectory(item.root)) continue;
        await this.#launch(key, item.spaceId, item.root).catch((error: unknown) => {
          process.stderr.write(`Could not reconnect ${item.root}: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
    }).catch((error: unknown) => {
      process.stderr.write(`Could not restore connected folders: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => this.changed());
    return this.#restoring;
  }

  async #publish(): Promise<DeviceRuntime> {
    const runtime = await this.list();
    const serialized = JSON.stringify(runtime);
    if (serialized !== this.#published) {
      this.#published = serialized;
      this.emit("runtime.changed", runtime);
    }
    const screen = JSON.stringify(this.#screen);
    if (screen !== this.#publishedScreen) {
      this.#publishedScreen = screen;
      this.emit("display.changed", this.#screen);
    }
    return runtime;
  }

  #subscribe(directory: string, pid: number) {
    const instance = `${directory}:${pid}`;
    if (this.#subscriptions.has(directory) || this.#unwatchable.has(instance)) return;
    const controller = new AbortController();
    this.#subscriptions.set(directory, controller);
    void watchRuntimeInstance(directory, () => this.changed(), controller.signal).then((streamed) => {
      if (!streamed) this.#unwatchable.add(instance);
    }, () => undefined).finally(() => {
      if (this.#subscriptions.get(directory) === controller) this.#subscriptions.delete(directory);
      if (!controller.signal.aborted) this.changed();
    });
  }

  async #launch(key: string, spaceId: string, root: string) {
    const env = await this.options.env();
    if (this.options.account() !== key) throw new Error("The signed-in account changed");
    const child = spawn(process.execPath, [this.options.cli, "runtime", "up", root, "--space", spaceId, "--detach", "--yes", "--no-display", "--json"], {
      env: { ...env, [EXPECTED_IDENTITY_ENV]: key }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
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
}
