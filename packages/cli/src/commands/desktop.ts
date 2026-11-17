import { readFileSync } from "node:fs";
import {
  HttpError,
  type CohubHttpClient,
  type DesktopCommandRecord,
  type DesktopCall,
  type DesktopSurface,
  parseAppRef,
  resolveOpenSurface,
  DESKTOP_COMMAND_ACCEPT_TIMEOUT_MS,
  DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS,
  DESKTOP_COMMAND_MAX_TIMEOUT_MS,
  DESKTOP_COMMAND_OPEN_TIMEOUT_MS,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok } from "../output.js";
import { explicitSpace, failSpaceTarget, resolveBoundSpace, resolveSpaceRef } from "../space.js";
import { getAppByRef } from "../app-ref.js";

export { resolveOpenSurface };

const FILE_SCHEME = "file://";
const APP_SCHEME = "app://";
const LEGACY_WORK_SCHEME = "work://";

type OpenTarget =
  | { kind: "file"; path: string }
  | {
      kind: "app";
      appId: string;
      label: string;
      launch: { search?: string; hash?: string };
      /** Surface the App asked for at publish time, when it declared one. */
      surface?: DesktopSurface;
    };

/** Never falls back to Home, so a plain target stays eligible for App resolution. */
export async function resolveOptionalSpaceId(
  command: Command,
  options: { cwd?: string; bindingsPath?: string } = {},
): Promise<string | undefined> {
  const explicit = explicitSpace(command);
  if (explicit) return resolveSpaceRef(explicit).catch(failSpaceTarget);
  return (await resolveBoundSpace(options)) ?? undefined;
}

function parseFilePath(value: string): string {
  const path = value.slice(FILE_SCHEME.length).trim();
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "..") ||
    path.includes("\\")
  ) {
    return error("Invalid file path", "Use a relative Space path after file://.");
  }
  return path;
}

function hasFileScheme(value: string): boolean {
  return value.toLowerCase().startsWith(FILE_SCHEME);
}

function hasAppScheme(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.startsWith(APP_SCHEME) || lowered.startsWith(LEGACY_WORK_SCHEME);
}

type OpenOptions = {
  call?: string;
  data?: string;
  input?: string;
  client?: string;
  commandId?: string;
  timeoutMs?: string;
  noWait?: boolean;
  json?: boolean;
  /** Surface role for app targets (`window` | `overlay`). */
  as?: string;
};

function readCallInput(opts: OpenOptions): unknown {
  if (opts.data !== undefined && opts.input !== undefined) {
    return error("Conflicting input", "Use either --data or --input, not both.");
  }
  const raw =
    opts.data !== undefined
      ? opts.data
      : opts.input !== undefined
        ? opts.input === "-"
          ? readFileSync(0, "utf-8")
          : readFileSync(opts.input, "utf-8")
        : undefined;
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return error("Invalid input", "Call input must be valid JSON.");
  }
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > DESKTOP_COMMAND_MAX_TIMEOUT_MS) {
    return error(
      "Invalid timeout",
      `--timeout-ms must be between 1 and ${DESKTOP_COMMAND_MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return parsed;
}

async function resolveAppTarget(client: CohubHttpClient, ref: string): Promise<OpenTarget> {
  const normalized = hasAppScheme(ref) ? ref.replace(/^[a-zA-Z]+:\/\//, "") : ref;
  const parsed = parseAppRef(normalized);
  const detail = await getAppByRef(client, normalized);
  const declared = detail.app.meta?.presentation?.surface;
  return {
    kind: "app",
    appId: detail.app.id,
    label: detail.app.slug,
    launch: {
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.hash ? { hash: parsed.hash } : {}),
    },
    ...(declared === "overlay" || declared === "window" ? { surface: declared } : {}),
  };
}

async function resolveOpenTarget(
  client: CohubHttpClient,
  command: Command,
  value: string,
): Promise<OpenTarget> {
  if (hasFileScheme(value)) return { kind: "file", path: parseFilePath(value) };
  if (hasAppScheme(value)) return resolveAppTarget(client, value);

  const spaceId = await resolveOptionalSpaceId(command);
  if (spaceId) {
    try {
      await client.space(spaceId).files.read(value);
      return { kind: "file", path: value };
    } catch (cause: unknown) {
      if (!(cause instanceof HttpError) || cause.status !== 404) throw cause;
    }
  }
  return resolveAppTarget(client, value);
}

function reportDispatch(record: DesktopCommandRecord): void {
  if (record.status !== "pending") {
    reportOutcome(record, Boolean(record.command.call));
    return;
  }
  ok(`Desktop command dispatched (${record.commandId})`);
}

function reportOutcome(record: DesktopCommandRecord, called: boolean): void {
  if (record.status === "applied") {
    ok(called ? "App window shown and method called" : "Window shown");
    if (record.result !== undefined) {
      console.log(typeof record.result === "string" ? record.result : JSON.stringify(record.result, null, 2));
    }
    return;
  }
  error(
    `Desktop command ${record.status}`,
    record.error?.message ?? "The Cohub desktop did not apply this command.",
  );
}

async function openWindow(target: string, opts: OpenOptions, command: Command): Promise<void> {
  const callInput = opts.call ? readCallInput(opts) : undefined;
  if (!opts.call && (opts.data !== undefined || opts.input !== undefined)) {
    return error("Missing --call", "--data and --input only apply together with --call.");
  }
  if (opts.noWait && opts.timeoutMs !== undefined) {
    return error("Conflicting wait options", "Use either --no-wait or --timeout-ms, not both.");
  }
  if (opts.as !== undefined && opts.as !== "window" && opts.as !== "overlay") {
    return error("Invalid surface", "--as must be one of: window, overlay.");
  }
  const timeoutMs = parseTimeout(opts.timeoutMs);
  const client = createClient();
  try {
    const resolved = await resolveOpenTarget(client, command, target);
    if (resolved.kind === "file" && opts.call) {
      return error("Unsupported option", "--call only applies to app targets.");
    }
    if (resolved.kind === "file" && opts.as) {
      return error("Unsupported option", "--as only applies to app targets.");
    }
    const call: DesktopCall | undefined = opts.call
      ? { method: opts.call, ...(callInput === undefined ? {} : { input: callInput }) }
      : undefined;

    const input = {
      command: {
        type: "desktop.open" as const,
        target:
          resolved.kind === "file"
            ? resolved
            : {
                kind: "app" as const,
                appId: resolved.appId,
                label: resolved.label,
                ...(resolved.launch.search || resolved.launch.hash ? { launch: resolved.launch } : {}),
                ...(resolveOpenSurface(opts.as, resolved.surface) ? { surface: "overlay" as const } : {}),
              },
        ...(call ? { call } : {}),
      },
      ...(opts.client ? { targetClientId: opts.client } : {}),
      ...(opts.commandId ? { commandId: opts.commandId } : {}),
    };
    const record = opts.noWait
      ? (await client.desktop.create(input)).command
      : await client.desktop.run(input, { timeoutMs });

    if (jsonRequested(opts)) return outJson(record);
    if (opts.noWait) return reportDispatch(record);
    reportOutcome(record, Boolean(call));
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AppRefParseError") return error(e.message);
    handleHttp(e);
  }
}

const OPEN_HELP = `
Commands reach only the desktop that originated the current chat, resolved
from request provenance. Nothing else can be targeted.

Examples:
  cohub desktop open <app-or-file>
  cohub desktop open file://src/main.ts
  cohub desktop open app://alice/studio/launch
  cohub desktop open alice/studio/launch
  cohub desktop open https://cohub.live/alice/studio/w/launch?view=timeline
  cohub desktop open <app-id> --as overlay
  cohub desktop open <app-id> --call selection.get
  cohub desktop open <app-id> --call board.focus --data '{"nodeId":"n1"}'
`;

const OPEN_NOTES = `
Notes:
  - Use file:// and app:// to make the target explicit; the legacy work://
    scheme is still accepted.
  - A plain target checks the explicit Space or current directory Runtime binding for a file before resolving an app; it does not fall back to Home.
  - Opening a window is idempotent; repeating it re-activates the same tab.
  - A desktop that does not respond within ${DESKTOP_COMMAND_ACCEPT_TIMEOUT_MS / 1_000} seconds (closed, asleep, or
    offline) fails fast with no_active_client instead of waiting out the timeout.
  - --as picks the surface: window (a preview tab) or overlay (a transparent
    layer above the workspace). Without it, an App published with
    <meta name="cohub:surface" content="overlay"> opens as an overlay.
  - --call waits for the app to announce readiness, then invokes the method.
  - Which methods exist is up to the app author.
`;

function registerOpen(parent: Command, deprecated: boolean): void {
  const open = parent
    .command(deprecated ? "preview <app-or-file>" : "open <app-or-file>")
    .description(deprecated ? "Deprecated: use `cohub desktop open`" : "Open a file or app window on the Cohub desktop, optionally calling an app method")
    .option("--call <method>", "Method the app registered via client.app.surface.handle()")
    .option("--data <json>", "Inline JSON input for --call")
    .option("-i, --input <file>", "JSON input file for --call; use - for stdin")
    .option("--client <clientId>", "Target a specific desktop instance of your account")
    .option("--command-id <id>", "Stable id so retries never dispatch twice")
    .option("--no-wait", "Dispatch the command and exit without waiting for a result")
    .option("--as <surface>", "Surface role for app targets: window (default) or overlay")
    .option(
      "--timeout-ms <ms>",
      `How long to wait for the desktop (default: ${DESKTOP_COMMAND_OPEN_TIMEOUT_MS}, or ${DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS} with --call; max: ${DESKTOP_COMMAND_MAX_TIMEOUT_MS})`,
    )
    .option("--json", "Output as JSON")
    .action(async (target: string, opts: OpenOptions, thisCommand: Command) => {
      if (deprecated) {
        ok("Deprecated: `cohub ui preview` is now `cohub desktop open`.");
      }
      await openWindow(target, opts, thisCommand);
    });
  open.addHelpText("after", deprecated ? OPEN_NOTES : OPEN_HELP + OPEN_NOTES);
}

export function registerDesktop(program: Command): void {
  const desktop = program
    .command("desktop")
    .description("Drive the Cohub desktop that started this chat");

  registerOpen(desktop, false);
}

export function registerLegacyUi(program: Command): void {
  const ui = program
    .command("ui", { hidden: true })
    .description("Deprecated: use `cohub desktop open`")
    .addHelpText("after", OPEN_HELP);
  registerOpen(ui, true);
}
