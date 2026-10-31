import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type RuntimePreferences = { keepAwake: boolean };

const DEFAULTS: RuntimePreferences = { keepAwake: true };

export const runtimePreferencesPath = () => join(homedir(), ".config", "cohub", "runtime-preferences.json");

export async function readRuntimePreferences(path = runtimePreferencesPath()): Promise<RuntimePreferences> {
  const stored: unknown = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
  const keepAwake = (stored as Partial<RuntimePreferences> | null)?.keepAwake;
  return { keepAwake: typeof keepAwake === "boolean" ? keepAwake : DEFAULTS.keepAwake };
}

export async function writeRuntimePreferences(preferences: RuntimePreferences, path = runtimePreferencesPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
