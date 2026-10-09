/**
 * Lets an agent drive the Cohub desktop that originated the app. Routing comes
 * from request provenance, never a caller-supplied target, so a command only
 * reaches the actor's own instances.
 *
 * The canonical command is `desktop.open`. The legacy `preview.show` shape is
 * accepted on input and normalized, so older clients keep working, but commands
 * are always stored and dispatched in the canonical form.
 */

import type { RequestSource } from "./provenance.js";
import { isUuid } from "./identifiers.js";
import {
  NAVIGATION_LAUNCH_MAX_LENGTH,
  NAVIGATION_METHOD_MAX_LENGTH,
  NAVIGATION_ERROR_CODE_MAX_LENGTH,
  NAVIGATION_ERROR_MESSAGE_MAX_LENGTH,
  type NavigationCall,
  type NavigationLaunch,
} from "./navigation.js";

export const DESKTOP_COMMAND_VERSION = 1;

/** Persisted and broadcast, so every field is capped; MAX_BYTES bounds the whole. */
export const DESKTOP_COMMAND_PAYLOAD_MAX_BYTES = 32 * 1024;
export const DESKTOP_COMMAND_MAX_BYTES = 40 * 1024;
export const DESKTOP_COMMAND_LABEL_MAX_LENGTH = 200;
export const DESKTOP_COMMAND_LAUNCH_MAX_LENGTH = NAVIGATION_LAUNCH_MAX_LENGTH;
export const DESKTOP_COMMAND_PATH_MAX_LENGTH = 2_048;
/** Becomes part of a Redis key. */
export const DESKTOP_COMMAND_ID_MAX_LENGTH = 64;
export const DESKTOP_COMMAND_ERROR_CODE_MAX_LENGTH = NAVIGATION_ERROR_CODE_MAX_LENGTH;
export const DESKTOP_COMMAND_ERROR_MESSAGE_MAX_LENGTH = NAVIGATION_ERROR_MESSAGE_MAX_LENGTH;

/** A command nobody accepts within this window settles as `no_active_client`. */
export const DESKTOP_COMMAND_ACCEPT_TIMEOUT_MS = 10_000;
export const DESKTOP_COMMAND_OPEN_TIMEOUT_MS = 30_000;
export const DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
export const DESKTOP_COMMAND_MAX_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
export const DESKTOP_COMMAND_SETTLEMENT_GRACE_SECONDS = 10 * 60;
/** Keeps pending commands reportable for the full wait window plus settlement grace. */
export const DESKTOP_COMMAND_PENDING_TTL_SECONDS =
  DESKTOP_COMMAND_MAX_TIMEOUT_MS / 1_000 + DESKTOP_COMMAND_SETTLEMENT_GRACE_SECONDS;
export const DESKTOP_COMMAND_TERMINAL_TTL_SECONDS = 30 * 60;

export type DesktopCommandStatus =
  | "pending"
  | "applied"
  | "no_active_client"
  | "desktop_host_unavailable"
  | "rejected"
  | "unsupported"
  | "timeout";

export const DESKTOP_COMMAND_TERMINAL_STATUSES: readonly DesktopCommandStatus[] = [
  "applied",
  "no_active_client",
  "desktop_host_unavailable",
  "rejected",
  "unsupported",
  "timeout",
];

export const isTerminalDesktopCommandStatus = (status: DesktopCommandStatus): boolean =>
  DESKTOP_COMMAND_TERMINAL_STATUSES.includes(status);

/**
 * How the App surface should be presented on the desktop.
 *
 * - `window`  (default) — opens as a preview tab in the workspace panel.
 * - `overlay` — renders in a transparent, chrome-free layer above the
 *   workspace.  The App controls its own geometry via `configure.request`
 *   and input hit-testing via `inputRegion`.  Stays below system UI.
 */
export type DesktopSurface = "window" | "overlay";

/**
 * The surface a desktop open should use: an explicit request wins, then
 * whatever the App declared at publish time. `window` is the implicit
 * default and yields `undefined` so the command stays compact.
 */
export function resolveOpenSurface(
  requested: unknown,
  declared: unknown,
): DesktopSurface | undefined {
  return (requested ?? declared) === "overlay" ? "overlay" : undefined;
}

export type DesktopAppTarget = {
  kind: "app";
  appId: string;
  label?: string;
  launch?: NavigationLaunch;
  /** Requested surface role.  Defaults to `"window"` when absent. */
  surface?: DesktopSurface;
};

export type DesktopFileTarget = {
  kind: "file";
  path: string;
};

export type DesktopTarget = DesktopAppTarget | DesktopFileTarget;

export type DesktopCall = NavigationCall;

export type DesktopOpenCommand = {
  type: "desktop.open";
  target: DesktopTarget;
  call?: DesktopCall;
};

export type DesktopCommand = DesktopOpenCommand;

export type DesktopCommandError = {
  code: string;
  message: string;
};

export type DesktopCommandRecord = {
  version: typeof DESKTOP_COMMAND_VERSION;
  commandId: string;
  status: DesktopCommandStatus;
  command: DesktopCommand;
  actorUserId: string;
  targetClientId: string;
  source: RequestSource | null;
  result?: unknown;
  error?: DesktopCommandError | null;
  createdAt: string;
  acceptedAt?: string | null;
  settledAt?: string | null;
};

export const DESKTOP_UNREACHABLE_ERROR: DesktopCommandError = {
  code: "no_active_client",
  message: "The Cohub desktop that started this chat did not respond. It may be closed, asleep, or offline.",
};

export const defaultDesktopCommandTimeoutMs = (command: DesktopCommand): number =>
  command.call ? DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS : DESKTOP_COMMAND_OPEN_TIMEOUT_MS;

export const isDesktopCommandAcceptOverdue = (
  record: DesktopCommandRecord,
  now = Date.now(),
): boolean =>
  record.status === "pending" &&
  !record.acceptedAt &&
  Date.parse(record.createdAt) + DESKTOP_COMMAND_ACCEPT_TIMEOUT_MS <= now;

export type DesktopCommandDispatchedPayload = {
  commandId: string;
  targetClientId: string;
  command: DesktopCommand;
  source: RequestSource | null;
};

const METHOD_RE = new RegExp(`^[A-Za-z][A-Za-z0-9_.:-]{0,${NAVIGATION_METHOD_MAX_LENGTH - 1}}$`);

export const isDesktopCallMethod = (value: unknown): value is string =>
  typeof value === "string" && METHOD_RE.test(value);

const DESKTOP_COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const parseDesktopCommandId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DESKTOP_COMMAND_ID_RE.test(trimmed) ? trimmed : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const parseLaunch = (value: unknown): DesktopAppTarget["launch"] | undefined => {
  if (!isRecord(value)) return undefined;
  const search = asTrimmed(value.search);
  const hash = asTrimmed(value.hash);
  if (!search && !hash) return undefined;
  return {
    ...(search ? { search: search.startsWith("?") ? search : `?${search}` } : {}),
    ...(hash ? { hash: hash.startsWith("#") ? hash : `#${hash}` } : {}),
  };
};

export const measureDesktopCommandPayload = (value: unknown): number | null => {
  if (value === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return null;
  }
};

export const parseDesktopCommandError = (
  value: unknown,
  fallbackCode: string,
): DesktopCommandError | null => {
  if (!isRecord(value)) return null;
  const code = asTrimmed(value.code) ?? fallbackCode;
  const message = asTrimmed(value.message) ?? "Desktop command failed";
  return {
    code: code.slice(0, DESKTOP_COMMAND_ERROR_CODE_MAX_LENGTH),
    message: message.slice(0, DESKTOP_COMMAND_ERROR_MESSAGE_MAX_LENGTH),
  };
};

export type ParsedDesktopCommand =
  | { command: DesktopCommand; error: null }
  | { command: null; error: string };

/**
 * Parse a desktop command from untrusted input.
 *
 * Accepts both the canonical `desktop.open` shape (`target` / `call`) and the
 * legacy `preview.show` shape (`preview` / `request`); the result is always
 * canonical so every later stage handles a single form.
 */
export const parseDesktopCommand = (input: unknown): ParsedDesktopCommand => {
  if (!isRecord(input)) return { command: null, error: "command must be an object" };

  const legacy = input.type === "preview.show";
  if (input.type !== "desktop.open" && !legacy) {
    return { command: null, error: "command.type must be one of: desktop.open" };
  }

  const target = isRecord(input.target) ? input.target : isRecord(input.preview) ? input.preview : null;
  if (!target) return { command: null, error: "command.target is required" };

  const kind = target.kind === "app" || (legacy && target.kind === "work") ? "app" : target.kind === "file" ? "file" : null;
  if (!kind) return { command: null, error: "command.target.kind must be one of: app, file" };

  if (kind === "file") {
    const path = asTrimmed(target.path);
    if (!path) return { command: null, error: "command.target.path is required" };
    if (
      path.length > DESKTOP_COMMAND_PATH_MAX_LENGTH ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "..")
    ) {
      return { command: null, error: "command.target.path must be a relative Space file path" };
    }
    if (input.call !== undefined && input.call !== null) {
      return { command: null, error: "command.call is only supported for app targets" };
    }
    if (legacy && input.request !== undefined && input.request !== null) {
      return { command: null, error: "command.call is only supported for app targets" };
    }
    return { command: { type: "desktop.open", target: { kind: "file", path } }, error: null };
  }

  const appId = asTrimmed(target.appId ?? target.workId);
  if (!appId) return { command: null, error: "command.target.appId is required" };
  if (!isUuid(appId)) {
    return { command: null, error: "command.target.appId must be an App id" };
  }
  const label = asTrimmed(target.label);
  if (label && label.length > DESKTOP_COMMAND_LABEL_MAX_LENGTH) {
    return {
      command: null,
      error: `command.target.label exceeds ${DESKTOP_COMMAND_LABEL_MAX_LENGTH} characters`,
    };
  }
  const launch = parseLaunch(target.launch);
  if (launch) {
    for (const [field, value] of [
      ["search", launch.search],
      ["hash", launch.hash],
    ] as const) {
      if (value && value.length > DESKTOP_COMMAND_LAUNCH_MAX_LENGTH) {
        return {
          command: null,
          error: `command.target.launch.${field} exceeds ${DESKTOP_COMMAND_LAUNCH_MAX_LENGTH} characters`,
        };
      }
    }
  }

  const callSource = input.call !== undefined ? input.call : input.request;
  let call: DesktopCall | undefined;
  if (callSource !== undefined && callSource !== null) {
    if (!isRecord(callSource)) {
      return { command: null, error: "command.call must be an object" };
    }
    const method = asTrimmed(callSource.method);
    if (!method) return { command: null, error: "command.call.method is required" };
    if (!isDesktopCallMethod(method)) {
      return { command: null, error: "command.call.method has an unsupported format" };
    }
    const size = measureDesktopCommandPayload(callSource.input);
    if (size === null) {
      return { command: null, error: "command.call.input must be JSON-serializable" };
    }
    if (size > DESKTOP_COMMAND_PAYLOAD_MAX_BYTES) {
      return {
        command: null,
        error: `command.call.input exceeds ${DESKTOP_COMMAND_PAYLOAD_MAX_BYTES} bytes`,
      };
    }
    call = {
      method,
      ...(callSource.input === undefined ? {} : { input: callSource.input }),
    };
  }

  // `window` is the default and stays implicit; unknown values from newer
  // clients are dropped rather than rejected so older desktops keep working.
  const surface: DesktopSurface | undefined = target.surface === "overlay" ? "overlay" : undefined;

  const command: DesktopCommand = {
    type: "desktop.open",
    target: {
      kind: "app",
      appId,
      ...(label ? { label } : {}),
      ...(launch ? { launch } : {}),
      ...(surface ? { surface } : {}),
    },
    ...(call ? { call } : {}),
  };

  const totalSize = measureDesktopCommandPayload(command);
  if (totalSize === null) return { command: null, error: "command must be JSON-serializable" };
  if (totalSize > DESKTOP_COMMAND_MAX_BYTES) {
    return { command: null, error: `command exceeds ${DESKTOP_COMMAND_MAX_BYTES} bytes` };
  }

  return { command, error: null };
};
