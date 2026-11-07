import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRACE_ENV = "COHUB_STARTUP_TRACE";

if (process.env[TRACE_ENV]) {
  const files = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) files.add(fileURLToPath(url));
      return nextLoad(url, context);
    },
  });
  process.on("exit", () => {
    const bytes = [...files].reduce((sum, file) => sum + statSync(file).size, 0);
    writeFileSync(process.env[TRACE_ENV], JSON.stringify({ files: files.size, bytes }));
  });
} else {
  const root = new URL("../", import.meta.url);
  const budgetUrl = new URL("startup-budget.json", root);
  const bin = fileURLToPath(new URL("bin/cohub.js", root));
  const TOLERANCE = 1.05;
  const RUNS = 5;
  const COMMANDS = ["--version", "--help", "me --help", "spaces --help", "boards --help", "runtime --help"];

  const run = (args, env = {}) => {
    const started = performance.now();
    execFileSync(process.execPath, args, {
      stdio: "ignore",
      env: { ...process.env, COHUB_CLI_AUTO_UPDATE: "0", ...env },
    });
    return performance.now() - started;
  };

  const trace = (command) => {
    const out = join(tmpdir(), `cohub-startup-${process.pid}.json`);
    run(["--import", import.meta.url, bin, ...command.split(" ")], { [TRACE_ENV]: out });
    const result = JSON.parse(readFileSync(out, "utf8"));
    rmSync(out);
    return result;
  };

  const median = (command) => {
    run([bin, ...command.split(" ")]);
    const times = Array.from({ length: RUNS }, () => run([bin, ...command.split(" ")])).sort((a, b) => a - b);
    return times[RUNS >> 1];
  };

  const update = process.argv.includes("--update");
  const budget = update ? {} : JSON.parse(readFileSync(budgetUrl, "utf8"));
  const results = {};
  let failed = false;

  for (const command of COMMANDS) {
    const { files, bytes } = trace(command);
    results[command] = bytes;
    const limit = budget[command];
    const over = limit !== undefined && bytes > limit * TOLERANCE;
    failed ||= over;
    const kb = `${(bytes / 1024).toFixed(0)} KB`.padStart(8);
    const note = over ? `  over budget ${(limit / 1024).toFixed(0)} KB` : "";
    console.log(`${command.padEnd(16)} ${kb} ${String(files).padStart(3)} files ${median(command).toFixed(0).padStart(5)} ms${note}`);
  }

  if (update) {
    writeFileSync(budgetUrl, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Updated ${fileURLToPath(budgetUrl)}`);
  } else if (failed) {
    console.error(`Startup JavaScript exceeds the budget by more than ${Math.round((TOLERANCE - 1) * 100)}%. Run \`pnpm startup --update\` if intended.`);
    process.exit(1);
  }
}
