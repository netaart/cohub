import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { packagePath } from "../package-paths.js";

const ENTRY = packagePath("bin", "cohub.js");

/**
 * Puts this Runtime's own `cohub` last on PATH, so what it runs can always call the CLI while a
 * `cohub` already on PATH (a global install that updates itself) still comes first.
 */
export function appendCliToPath(env: NodeJS.ProcessEnv = process.env, node = process.execPath, entry = ENTRY): string {
  const dir = join(homedir(), ".cache", "cohub", "cli", createHash("sha256").update(`${node}\0${entry}`).digest("hex").slice(0, 12));
  const windows = process.platform === "win32";
  const script = windows
    ? `@"${node}" "${entry}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, windows ? "cohub.cmd" : "cohub");
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, script, { mode: 0o755 });
  renameSync(temporary, file);
  const path = env.PATH?.split(delimiter).filter(Boolean) ?? [];
  if (!path.includes(dir)) env.PATH = [...path, dir].join(delimiter);
  return dir;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
