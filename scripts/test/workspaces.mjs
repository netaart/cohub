import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";

const input = process.argv.slice(2).filter((argument) => argument !== "--");
let reporter = "dot";
for (let index = 0; index < input.length; index += 1) {
  const argument = input[index];
  if (argument === "--test-reporter") {
    reporter = input[index + 1] ?? reporter;
    index += 1;
  } else if (argument.startsWith("--test-reporter=")) {
    reporter = argument.slice("--test-reporter=".length);
  }
}

const configuredConcurrency = Number.parseInt(
  process.env.COHUB_TEST_WORKSPACE_CONCURRENCY ?? "",
  10,
);
const workspaceConcurrency =
  Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : availableParallelism();
const pnpmArguments = [
  "--reporter=append-only",
  "-r",
  "--no-sort",
  `--workspace-concurrency=${workspaceConcurrency}`,
  "--if-present",
  "test",
];
if (input.length > 0) pnpmArguments.push("--", ...input);

// pnpm 12 ships a native executable, so `npm_execpath` can no longer be run
// through `node`; spawn the `pnpm` on PATH instead (works on pnpm 10–12).
const startedAt = performance.now();
const child = spawn("pnpm", pnpmArguments, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));

// `close` (not `exit`) is what guarantees the piped stdio has been fully
// drained, so a parallel run cannot lose a workspace's trailing summary.
const exitCode = await new Promise((resolve) => {
  child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  child.once("error", (error) => {
    stderr.push(Buffer.from(`${error.stack ?? error.message}\n`));
    resolve(1);
  });
});

const output = Buffer.concat(stdout).toString("utf8");
const errors = Buffer.concat(stderr).toString("utf8");
const duration = ((performance.now() - startedAt) / 1000).toFixed(1);

if (exitCode !== 0 || reporter !== "dot") {
  process.stdout.write(output);
  process.stderr.write(errors);
} else {
  const lines = output.split("\n");
  const summaryPattern = / test: .+ ok (\d+) tests \d+\.\d+s$/;
  const summaries = lines.flatMap((line) => {
    const match = line.match(summaryPattern);
    return match ? [Number(match[1])] : [];
  });
  const passedWorkspaces = summaries.length;
  const passedTests = summaries.reduce((total, count) => total + count, 0);
  const unexpectedOutput = lines
    .filter(
      (line) =>
        line &&
        !line.startsWith("Scope: ") &&
        !line.includes(" test$ ") &&
        !line.endsWith(" test: Done") &&
        !summaryPattern.test(line),
    )
    .join("\n");
  if (unexpectedOutput) process.stdout.write(`${unexpectedOutput}\n`);
  if (errors) process.stderr.write(errors);
  process.stdout.write(
    `${passedTests} tests across ${passedWorkspaces} workspaces passed in ${duration}s\n`,
  );
}

process.exitCode = exitCode;
