import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicRuntimeJson } from "../archive-store.js";
import type { Harness } from "./adapters.js";

/** Private state of one Space's Runtime on this machine. */
export const runtimeStateRoot = (spaceId: string, base = join(homedir(), ".local", "state", "cohub", "runtime")) => join(base, spaceId);

/** What the user agreed to for native sessions in the bound directory. */
export type NativeConfig = {
  version: 2;
  identity: string;
  spaceId: string;
  root: string;
  harnesses: Harness[];
  enabledAt: string;
  codexShared: boolean;
};

export const nativeConfigPath = (stateRoot: string) => join(stateRoot, "native", "config.json");

export async function readNativeConfig(stateRoot: string, identity: string): Promise<NativeConfig | null> {
  try {
    const config = JSON.parse(await readFile(nativeConfigPath(stateRoot), "utf8")) as NativeConfig;
    if (config.version !== 2 || !Array.isArray(config.harnesses) || typeof config.enabledAt !== "string") throw new Error("Invalid native sync configuration");
    // Another account's consent never applies.
    return config.identity === identity ? config : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeNativeConfig(stateRoot: string, config: NativeConfig): Promise<void> {
  await atomicRuntimeJson(nativeConfigPath(stateRoot), config);
}
