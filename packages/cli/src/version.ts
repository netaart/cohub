import { readFileSync } from "node:fs";
import { packagePath } from "./package-paths.js";

export const CLI_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(packagePath("package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export function cliCommit(): string | null {
  try {
    return (JSON.parse(readFileSync(packagePath("dist", "build.json"), "utf8")) as { commit?: string | null }).commit ?? null;
  } catch {
    return null;
  }
}
