import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, resolve } from "node:path";
import type { Command } from "commander";
import { mimeTypeForPath, readRequestSourceFromEnv, resolveApiBaseUrl, resolveCohubEnvironment } from "@neta-art/cohub";
import { authSource } from "../auth.js";
import { createClient } from "../client.js";
import { collectOption, readPromptContent } from "../command-input.js";
import { describeError } from "../network-error.js";
import { error, json as outJson, jsonRequested, spinner } from "../output.js";
import { readRuntimeDiagnosticEvents } from "../runtime/diagnostics.js";
import { resolveRuntimeTarget } from "../runtime/launch.js";
import { runtimeStateRoot } from "../runtime/native/config.js";
import { explicitSpace } from "../space.js";

// Shared with the web feedback dialog; cfeed enforces attachment limits server-side.
const CFEED_ENDPOINT = "https://cfeed.neta.art/api/v1/feedback";
const CFEED_APP = "cohub";
const RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;
const RUNTIME_LOG_EVENTS = 2_000;
const USER_LOOKUP_TIMEOUT_MS = 3_000;
const SUBMIT_TIMEOUT_MS = 120_000;

type FeedbackOptions = { file: string[]; runtimeLogs?: boolean; json?: boolean };
type FeedbackResult = { id: string; app: string; created_at: number; attachments: Array<{ id: string; filename: string; size: number }> };

async function readAttachment(path: string): Promise<File> {
  const absolute = resolve(path);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) return error(`Cannot attach ${path}`, "Pass a path to an existing file");
  const type = mimeTypeForPath(absolute) ?? "application/octet-stream";
  return new File([await openAsBlob(absolute, { type })], basename(absolute), { type });
}

async function runtimeLogFile(program: Command, now: Date): Promise<File> {
  const spaceId = await resolveRuntimeTarget(program).catch((cause: unknown) =>
    error("Cannot attach Runtime logs", describeError(cause)));
  let events = await readRuntimeDiagnosticEvents(runtimeStateRoot(spaceId), { limit: RUNTIME_LOG_EVENTS });
  let dropped = 0;
  let text = JSON.stringify({ spaceId, dropped, events });
  // Keep the newest events when the log exceeds the budget.
  while (Buffer.byteLength(text) > RUNTIME_LOG_MAX_BYTES && events.length > 0) {
    const count = Math.ceil(events.length / 2);
    events = events.slice(count);
    dropped += count;
    text = JSON.stringify({ spaceId, dropped, events });
  }
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return new File([text], `cohub-runtime-${stamp}.json`, { type: "application/json" });
}

async function currentUserUuid(): Promise<string | null> {
  if (!authSource()) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((done) => { timer = setTimeout(() => done(null), USER_LOOKUP_TIMEOUT_MS); });
  const lookup = createClient().user.getMe().then((user) => user.uuid ?? null, () => null);
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function submitFeedback(content: string, extra: Record<string, unknown>, files: File[]): Promise<FeedbackResult> {
  const body = new FormData();
  body.set("app", CFEED_APP);
  body.set("content", content);
  body.set("extra", JSON.stringify(extra));
  for (const file of files) body.append("files", file, file.name);
  const response = await fetch(CFEED_ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });
  const payload = (await response.json().catch(() => null)) as (FeedbackResult & { error?: { message?: string } }) | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  if (!payload) throw new Error("Feedback service returned an empty response");
  return payload;
}

export function registerFeedback(program: Command): void {
  program
    .command("feedback [message...]")
    .description("Send feedback or a bug report to the Cohub team")
    .option("-f, --file <path>", "Attach a file; repeatable", collectOption, [])
    .option("--runtime-logs", "Attach recent local Runtime diagnostics for the target Space")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
The message comes from arguments or stdin. CLI version, OS, environment, account,
and COHUB_* Space/Chat context are attached automatically; your working directory is not.

Examples:
  $ cohub feedback "runtime up hangs after sign-in"
  $ cohub feedback "Board export is blurry" -f board.png -f export.log
  $ cohub feedback --runtime-logs "Codex chats stopped syncing"
  $ cat report.md | cohub feedback`)
    .action(async (words: string[], opts: FeedbackOptions) => {
      const asJson = jsonRequested(opts);
      const content = await readPromptContent(words);
      const now = new Date();
      const [files, userUuid] = await Promise.all([
        Promise.all([
          ...opts.file.map(readAttachment),
          ...(opts.runtimeLogs ? [runtimeLogFile(program, now)] : []),
        ]),
        currentUserUuid(),
      ]);
      const extra = {
        user_uuid: userUuid,
        cli_version: program.version() ?? null,
        node: process.versions.node,
        os: `${platform()} ${release()}`,
        arch: arch(),
        env: resolveCohubEnvironment(),
        api_base_url: resolveApiBaseUrl(),
        space: explicitSpace(program),
        source: readRequestSourceFromEnv(process.env as Record<string, string | undefined>, { via: "cli" }),
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tty: Boolean(process.stdout.isTTY),
        has_runtime_logs: Boolean(opts.runtimeLogs),
      };

      const sp = asJson ? null : spinner();
      sp?.start("Sending feedback");
      try {
        const result = await submitFeedback(content, extra, files);
        if (asJson) return outJson(result);
        sp?.stop(`Feedback sent · ${result.id}`);
      } catch (cause) {
        if (sp) process.stderr.write("\n");
        error("Couldn't send feedback", describeError(cause));
      }
    });
}
