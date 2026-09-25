import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Version = readonly [number, number, number];

/** A harness binary's own version, or `null` when it cannot say. */
export async function harnessVersion(binary: string): Promise<Version | null> {
  const { stdout } = await promisify(execFile)(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }).catch(() => ({ stdout: "" }));
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version: Version | null, minimum: Version): boolean {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return (version[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

export const formatVersion = (version: Version | null) => version?.join(".") ?? "(unknown version)";
