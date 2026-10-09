import type { TaskRunDetailResponse } from "@neta-art/cohub";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, spinner } from "../output.js";
import { resolveSpaceTarget } from "../space.js";

type RunCliOptions = {
  spaceId: string;
  json: boolean;
  async: boolean;
  command: string;
};

type RunCommandResult = {
  exitCode: number | null;
  termination?: {
    reason: "exited" | "timed_out" | "aborted";
    exitCode: number | null;
    timeoutSecs?: number;
    message?: string;
    outputTruncated?: boolean;
  };
  durationMs: number;
  output: string;
  truncated: boolean;
};

const DEFAULT_WAIT_TIMEOUT_MS = (6 * 60 * 60 + 60) * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1500;

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellJoin(values: string[]): string {
  return values.map((value) => shellQuote(value)).join(" ");
}

function topLevelRunIndex(argv: string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") return -1;
    if (token === "-s" || token === "--space") {
      index += 1;
      continue;
    }
    if (token.startsWith("--space=") || token === "--json") continue;
    if (token.startsWith("-")) continue;
    return token === "run" ? index : -1;
  }
  return -1;
}

function parseSpaceId(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-s" || token === "--space") {
      const value = tokens[index + 1];
      if (!value) return error("Missing space", `${token} requires a value`);
      return value.trim() || undefined;
    }
    if (token.startsWith("--space=")) return token.slice("--space=".length).trim() || undefined;
  }
  return undefined;
}

export async function parseRunCliOptions(
  argv: string[],
  spaceOptions: { cwd?: string; bindingsPath?: string } = {},
): Promise<RunCliOptions> {
  const runIndex = topLevelRunIndex(argv);
  if (runIndex < 0) return error("Invalid invocation", "Use `cohub run [options] <command>`");

  const beforeRun = argv.slice(0, runIndex);
  const afterRun = argv.slice(runIndex + 1);

  const explicitSpaceId = parseSpaceId(beforeRun) ?? process.env.COHUB_SPACE_ID?.trim() ?? "";
  let json = beforeRun.includes("--json");
  let async = false;
  let commandOption: string | null = null;
  let positionalTokens: string[] = [];

  for (let index = 0; index < afterRun.length; index += 1) {
    const token = afterRun[index] ?? "";

    if (token === "-h" || token === "--help") {
      printRunHelp();
      process.exit(0);
    }

    if (token === "--async") {
      async = true;
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "-c" || token === "--command") {
      const value = afterRun[index + 1];
      if (!value) return error("Missing command", `${token} requires a value`);
      if (commandOption !== null || positionalTokens.length > 0) {
        return error("Conflicting command input", "Use either --command or positional command tokens, not both.");
      }
      commandOption = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--command=")) {
      if (commandOption !== null || positionalTokens.length > 0) {
        return error("Conflicting command input", "Use either --command or positional command tokens, not both.");
      }
      commandOption = token.slice("--command=".length);
      continue;
    }

    if (token === "--") {
      if (commandOption !== null) {
        return error("Conflicting command input", "Use either --command or positional command tokens, not both.");
      }
      positionalTokens = afterRun.slice(index + 1);
      break;
    }

    if (commandOption !== null) {
      return error("Conflicting command input", "Use either --command or positional command tokens, not both.");
    }

    positionalTokens = afterRun.slice(index);
    break;
  }

  const command = commandOption?.trim() || shellJoin(positionalTokens).trim();
  if (!command) {
    return error("No command", "Pass --command <shell command>, or use `--` followed by the command.");
  }

  const spaceId = await resolveSpaceTarget(explicitSpaceId, spaceOptions);
  return { spaceId, json, async, command };
}

export function printRunHelp(): void {
  process.stdout.write(`
Usage:
  cohub [-s <space>] run [options] -- <shell command>
  cohub [-s <space>] run --command <shell command>

Options:
  -c, --command <command>  Shell command to execute in the space workspace
      --async              Queue the command and return immediately
      --json               Output as JSON
  -h, --help               Show this help

Examples:
  cohub -s <spaceId> run --command "git status"
  cohub -s <spaceId> run --async --command "pnpm test"
  cohub -s <spaceId> run -- git status -sb

Notes:
  - Without -s or COHUB_SPACE_ID, the command uses the current directory Runtime binding; it never falls back to Home.
  - Use --command for commands that contain leading flags, or use -- before the shell command.
  - The command runs in /workspace.
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseRunResult(detail: TaskRunDetailResponse): RunCommandResult {
  const result = asRecord(detail.run.result);
  const terminationRecord = asRecord(result?.termination);
  return {
    exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
    termination: terminationRecord && (terminationRecord.reason === "exited" || terminationRecord.reason === "timed_out" || terminationRecord.reason === "aborted")
      ? {
          reason: terminationRecord.reason,
          exitCode: typeof terminationRecord.exitCode === "number" ? terminationRecord.exitCode : null,
          ...(typeof terminationRecord.timeoutSecs === "number" ? { timeoutSecs: terminationRecord.timeoutSecs } : {}),
          ...(typeof terminationRecord.message === "string" ? { message: terminationRecord.message } : {}),
          ...(typeof terminationRecord.outputTruncated === "boolean" ? { outputTruncated: terminationRecord.outputTruncated } : {}),
        }
      : undefined,
    durationMs: typeof result?.durationMs === "number" ? result.durationMs : 0,
    output: typeof result?.output === "string" ? result.output : "",
    truncated: Boolean(result?.truncated) || Boolean(result?.outputTruncated) || Boolean(terminationRecord?.outputTruncated),
  };
}

function writeOutput(output: string): void {
  if (!output) return;
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

async function waitForRunCompletion(taskRunId: string, showSpinner: boolean): Promise<TaskRunDetailResponse> {
  const client = createClient();
  const startedAt = Date.now();
  const spin = showSpinner ? spinner() : null;
  if (spin) spin.start(`Waiting for command task ${taskRunId}`);

  while (true) {
    const detail = await client.tasks.get(taskRunId);
    if (detail.run.status === "completed" || detail.run.status === "failed") {
      if (spin) spin.stop(`Finished in ${formatElapsed(Date.now() - startedAt)}`);
      return detail;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > DEFAULT_WAIT_TIMEOUT_MS) {
      if (spin) spin.stop(`Timed out after ${formatElapsed(DEFAULT_WAIT_TIMEOUT_MS)}`);
      return error("Timed out waiting for run command", `taskRunId: ${taskRunId}`);
    }

    if (spin) spin.update(`Running... ${formatElapsed(elapsedMs)}`);
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
}

async function handleRunCli(argv: string[]): Promise<void> {
  const opts = await parseRunCliOptions(argv);
  const client = createClient();

  try {
    const { taskRunId } = await client.space(opts.spaceId).runCommand({ command: opts.command });

    if (opts.async) {
      if (opts.json) return outJson({ taskRunId });
      process.stderr.write(`  Command queued — taskRunId: ${taskRunId}\n`);
      return;
    }

    const detail = await waitForRunCompletion(taskRunId, !opts.json);
    if (detail.run.status === "failed") {
      const message = detail.run.errorMessage?.trim() || `Command task failed: ${taskRunId}`;
      return error(message);
    }

    const result = parseRunResult(detail);
    if (opts.json) {
      return outJson({ taskRunId, run: detail.run, progress: detail.progress, ...result });
    }

    writeOutput(result.output);
    process.exitCode = result.exitCode ?? 0;
    process.stderr.write(
      `  Command finished — taskRunId: ${taskRunId}, exitCode: ${result.exitCode ?? "unknown"}, duration: ${formatElapsed(result.durationMs)}${result.truncated ? ", output truncated" : ""}\n`,
    );
  } catch (e: unknown) {
    handleHttp(e);
  }
}

export async function maybeHandleRunCommand(argv: string[]): Promise<boolean> {
  if (topLevelRunIndex(argv) < 0) return false;
  await handleRunCli(argv);
  return true;
}
