import { readFileSync } from "node:fs";

export const CLI_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export function cliCommit(): string | null {
  try {
    return (JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")) as { commit?: string | null }).commit ?? null;
  } catch {
    return null;
  }
}
