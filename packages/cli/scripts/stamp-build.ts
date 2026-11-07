import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describeRootCommands, registerCommands } from "../src/command-index.js";
import { createProgram } from "../src/program.js";
import type { BuildInfo } from "../src/version.js";

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

const program = createProgram();
await registerCommands(program);
const info: BuildInfo = { commit: commit(), rootCommands: describeRootCommands(program) };
writeFileSync(new URL("../dist/build.json", import.meta.url), `${JSON.stringify(info)}\n`);
