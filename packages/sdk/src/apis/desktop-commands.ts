import type { HttpTransport } from "../transport.js";
import {
  defaultDesktopCommandTimeoutMs,
  isTerminalDesktopCommandStatus,
  DESKTOP_COMMAND_MAX_TIMEOUT_MS,
  type DesktopCommand,
  type DesktopCommandError,
  type DesktopCommandRecord,
  type DesktopCommandStatus,
} from "@cohub/protocol/desktop-command";

export type {
  DesktopCommand,
  DesktopCommandError,
  DesktopCommandRecord,
  DesktopCommandStatus,
  DesktopAppTarget,
  DesktopCall,
  DesktopFileTarget,
  DesktopOpenCommand,
  DesktopSurface,
  DesktopTarget,
} from "@cohub/protocol/desktop-command";

// ── Legacy aliases (the `preview.show` wire shape) ────────────────────────────

/** @deprecated Use `DesktopCommand`. */
export type UiCommand = DesktopCommand;
/** @deprecated Use `DesktopCommandError`. */
export type UiCommandError = DesktopCommandError;
/** @deprecated Use `DesktopCommandRecord`. */
export type UiCommandRecord = DesktopCommandRecord;
/** @deprecated Use `DesktopCommandStatus`. */
export type UiCommandStatus = DesktopCommandStatus;

export type CreateDesktopCommandInput = {
  command: DesktopCommand;
  commandId?: string;
  targetClientId?: string;
};

export type WaitForDesktopCommandOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

/** @deprecated Use `CreateDesktopCommandInput`. */
export type CreateUiCommandInput = CreateDesktopCommandInput;
/** @deprecated Use `WaitForDesktopCommandOptions`. */
export type WaitForUiCommandOptions = WaitForDesktopCommandOptions;

const DEFAULT_POLL_INTERVAL_MS = 300;

const assertTimeoutMs = (timeoutMs: number | undefined): void => {
  if (timeoutMs === undefined) return;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DESKTOP_COMMAND_MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs must be between 1 and ${DESKTOP_COMMAND_MAX_TIMEOUT_MS} milliseconds`,
    );
  }
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class DesktopCommandsApi {
  constructor(private readonly transport: HttpTransport) {}

  create(input: CreateDesktopCommandInput) {
    // The `/api/desktop/commands` path is frozen for existing SDK consumers; the
    // server accepts both the canonical `desktop.open` command and the legacy
    // `preview.show` shape.
    return this.transport.request<{ command: DesktopCommandRecord }>("/api/desktop/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  get(commandId: string) {
    return this.transport.request<{ command: DesktopCommandRecord }>(
      `/api/desktop/commands/${encodeURIComponent(commandId)}`,
    );
  }

  /** The target desktop accepts before running; `accepted: false` means drop it. */
  accept(commandId: string) {
    return this.transport.request<{ accepted: boolean; command: DesktopCommandRecord }>(
      `/api/desktop/commands/${encodeURIComponent(commandId)}/accept`,
      { method: "POST" },
    );
  }

  reportResult(
    commandId: string,
    input: { status: DesktopCommandStatus; result?: unknown; error?: DesktopCommandError | null },
  ) {
    return this.transport.request<{ command: DesktopCommandRecord }>(
      `/api/desktop/commands/${encodeURIComponent(commandId)}/result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  async run(
    input: CreateDesktopCommandInput,
    options: WaitForDesktopCommandOptions = {},
  ): Promise<DesktopCommandRecord> {
    assertTimeoutMs(options.timeoutMs);
    const { command } = await this.create(input);
    if (isTerminalDesktopCommandStatus(command.status)) return command;
    return this.wait(command.commandId, options);
  }

  async wait(
    commandId: string,
    options: WaitForDesktopCommandOptions = {},
  ): Promise<DesktopCommandRecord> {
    assertTimeoutMs(options.timeoutMs);
    const startedAt = Date.now();
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    let latest = (await this.get(commandId)).command;
    const deadline = startedAt + (options.timeoutMs ?? defaultDesktopCommandTimeoutMs(latest.command));

    while (!isTerminalDesktopCommandStatus(latest.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining), options.signal);
      latest = (await this.get(commandId)).command;
    }
    if (isTerminalDesktopCommandStatus(latest.status)) return latest;

    return {
      ...latest,
      status: "timeout",
      error: {
        code: "timeout",
        message: "No Cohub desktop reported a result before the timeout.",
      },
      settledAt: new Date().toISOString(),
    };
  }
}

/** @deprecated Use `DesktopCommandsApi`. */
export class UiCommandsApi extends DesktopCommandsApi {}
