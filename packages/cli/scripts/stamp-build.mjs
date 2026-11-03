import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

writeFileSync(new URL("../dist/build.json", import.meta.url), `${JSON.stringify({ commit: commit() })}\n`);
