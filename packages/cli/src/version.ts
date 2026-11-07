import { readFileSync } from "node:fs";
import type { RootCommandLine } from "./command-index.js";
import { packagePath } from "./package-paths.js";

export const CLI_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(packagePath("package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export type BuildInfo = { commit?: string | null; rootCommands?: RootCommandLine[] };

export function buildInfo(): BuildInfo {
  try {
    return JSON.parse(readFileSync(packagePath("dist", "build.json"), "utf8")) as BuildInfo;
  } catch {
    return {};
  }
}

export function cliCommit(): string | null {
  return buildInfo().commit ?? null;
}
