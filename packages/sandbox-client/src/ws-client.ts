import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import type {
  AgentSandboxMessage,
  RpcEventPayload,
  RpcMethod,
  RpcRequestMap,
  SandboxCapabilities,
  SandboxHeartbeat,
} from "@cohub/protocol/sandbox";
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { SpacePortsChangedPayload } from "@cohub/protocol/ports";
import { AGENT_SANDBOX_PROTOCOL_VERSION } from "@cohub/protocol/sandbox";
import { createLogger } from "@cohub/infra/logging";
import {
  SANDBOX_CONNECTION_LOST_MESSAGE,
  SandboxRpcError,
  type SandboxRpcDiagnostics,
} from "./rpc-error.js";

const logger = createLogger({ serviceName: "sandbox-client" });


const ACCEPTED_RPC_DISCONNECT_GRACE_MS = 3_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const LOG_VALUE_LIMIT = 500;

function truncateLogValue(value: string, limit = LOG_VALUE_LIMIT) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function hashString(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function previewStringArray(value: unknown[], limit = 160) {
  let output = "";
  for (const item of value) {
    const part = typeof item === "string" ? item : String(item);
    const separator = output ? " " : "";
    const remaining = limit - output.length - separator.length;
    if (remaining <= 0) break;
    output += separator + (part.length > remaining ? part.slice(0, remaining) : part);
    if (output.length >= limit) break;
  }
  return output;
}

function sanitizeRpcDiagnostics(method: string, params: unknown): SandboxRpcDiagnostics {
  const diagnostics: SandboxRpcDiagnostics = {};
  if (!params || typeof params !== "object") return diagnostics;
  const record = params as Record<string, unknown>;

  if (typeof record.path === "string") diagnostics.path = truncateLogValue(record.path, 240);
  if (typeof record.cwd === "string") diagnostics.cwd = truncateLogValue(record.cwd, 240);
  if (typeof record.glob === "string") diagnostics.glob = truncateLogValue(record.glob, 240);
  if (typeof record.limit === "number") diagnostics.limit = record.limit;
  if (typeof record.maxResults === "number") diagnostics.maxResults = record.maxResults;
  if (typeof record.maxCount === "number") diagnostics.maxCount = record.maxCount;
  if (typeof record.ignoreCase === "boolean") diagnostics.ignoreCase = record.ignoreCase;
  if (typeof record.literal === "boolean") diagnostics.literal = record.literal;
  if (typeof record.context === "number") diagnostics.context = record.context;

  if (typeof record.pattern === "string") {
    diagnostics.patternLength = record.pattern.length;
    diagnostics.patternHash = hashString(record.pattern);
  }
  if (method === "process.start" && typeof record.command === "string") {
    const command = record.command.trim();
    diagnostics.commandLength = command.length;
    diagnostics.commandPreview = truncateLogValue(command, 160);
  }
  if (method === "process.start" && Array.isArray(record.argv)) {
    diagnostics.commandLength = record.argv.length;
    diagnostics.commandPreview = previewStringArray(record.argv, 160);
  }
  if (typeof record.processId === "string") diagnostics.processId = record.processId;
  return diagnostics;
}

function formatDiagnostics(diagnostics: SandboxRpcDiagnostics | undefined) {
  if (!diagnostics) return "";
  const entries = Object.entries(diagnostics).filter(([, value]) => value != null);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

function isRefreshableConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.toLowerCase();
  return [
    "ehostunreach",
    "econnrefused",
    "etimedout",
    "enetunreach",
    "econnreset",
    "socket hang up",
    "websocket closed before attach",
    "closed before attach",
  ].some((pattern) => text.includes(pattern));
}

type PendingOperation = {
  requestId: string;
  method: string;
  diagnostics: SandboxRpcDiagnostics;
  opId?: string;
  accepted: boolean;
  detached?: boolean;
  detachTimer?: ReturnType<typeof setTimeout>;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onEvent?: (event: RpcEventPayload) => void;
};

export type SandboxBroadcast = { sandboxId: string; timestamp: number };

type SandboxStatusHooks = {
  onHeartbeat?: (message: SandboxHeartbeat) => void | Promise<void>;
  onAttached?: (input: { spaceId: string; sandboxId: string; connectionId: string }) => void | Promise<void>;
  onFsChanged?: (payload: SpaceFsChangedPayload, broadcast: SandboxBroadcast) => void | Promise<void>;
  onPortsChanged?: (payload: SpacePortsChangedPayload, broadcast: SandboxBroadcast) => void | Promise<void>;
  onDisconnected?: (input: { spaceId: string; reason?: string }) => void | Promise<void>;
  onConnectionError?: (input: { spaceId: string; error: Error }) => void | Promise<void>;
  onRefreshWsUrl?: (input: { spaceId: string; currentWsUrl: string; error?: Error }) => string | null | Promise<string | null>;
};

type SandboxClientRun = {
  generation: number;
  controller: AbortController;
};

type SandboxConnectionHeaders = Record<string, string> | ((wsUrl: string) => Promise<Record<string, string>>);

type SandboxClientRegistration = {
  spaceId: string;
  wsUrl: string;
  identity: string;
  headers?: SandboxConnectionHeaders;
  started: boolean;
  generation: number;
  activeRun: SandboxClientRun | null;
  connection: SandboxConnection | null;
  resolveWaiters: Array<(connection: SandboxConnection) => void>;
  hooks?: SandboxStatusHooks;
  pendingByRequestId: Map<string, PendingOperation>;
  requestIdByOpId: Map<string, string>;
};

export class SandboxConnection {
  private closed = false;
  private disposed = false;

  constructor(
    readonly spaceId: string,
    readonly sandboxId: string,
    readonly identity: string,
    readonly connectionId: string,
    readonly capabilities: SandboxCapabilities | undefined,
    private readonly socket: WebSocket,
    private readonly registration: SandboxClientRegistration,
  ) {}

  send(message: AgentSandboxMessage) {
    this.socket.send(JSON.stringify(message));
  }

  request<M extends RpcMethod>(
    method: M,
    params: RpcRequestMap[M]["params"],
    options: {
      requestId?: string;
      spaceId: string;
      sandboxId: string;
      onEvent?: (event: RpcEventPayload) => void;
    },
  ): Promise<RpcRequestMap[M]["result"]> {
    const requestId = options.requestId ?? randomUUID();
    logger.debug(`[SandboxWS] rpc:request spaceId=${this.spaceId} identity=${this.identity} method=${method} requestId=${requestId.slice(0, 8)}`);
    const promise = new Promise<RpcRequestMap[M]["result"]>((resolve, reject) => {
      const pending = {
        requestId,
        method,
        diagnostics: sanitizeRpcDiagnostics(method, params),
        accepted: false,
        resolve,
        reject,
        onEvent: options.onEvent,
      };
      this.registration.pendingByRequestId.set(requestId, pending);

      try {
        this.send({
          version: AGENT_SANDBOX_PROTOCOL_VERSION,
          type: "rpc.request",
          requestId,
          spaceId: options.spaceId,
          sandboxId: options.sandboxId,
          sessionId: null,
          toolCallId: null,
          timestamp: Date.now(),
          method,
          params,
        });
      } catch (error) {
        this.clearPending(requestId, pending);
        reject(new SandboxRpcError(SANDBOX_CONNECTION_LOST_MESSAGE, {
          method,
          rpcErrorCode: "IO_ERROR",
          retryable: false,
          transportReason: error instanceof Error ? error.message : String(error),
          diagnostics: pending.diagnostics,
        }));
      }
    });

    // Attach a no-op handler synchronously so Node.js never sees this promise
    // as "unhandled" during the brief window between rejection and the caller's
    // await-microtask picking it up (prevents unhandledRejection crashes on
    // Node.js v22+ where the default is --unhandled-rejections=throw).
    promise.catch(() => {});

    return promise;
  }

  private getPendingForOperationMessage(message: { opId: string; requestId: string }) {
    const mappedRequestId = this.registration.requestIdByOpId.get(message.opId);
    const pending = this.registration.pendingByRequestId.get(mappedRequestId ?? message.requestId) ?? null;
    if (!pending) return { requestId: mappedRequestId ?? message.requestId, pending };

    pending.accepted = true;
    if (!pending.opId) pending.opId = message.opId;
    if (!mappedRequestId) this.registration.requestIdByOpId.set(message.opId, pending.requestId);
    return { requestId: pending.requestId, pending };
  }

  handleMessage(message: AgentSandboxMessage) {
    if (message.type === "rpc.accepted") {
      const pending = this.registration.pendingByRequestId.get(message.requestId);
      if (!pending) return;
      pending.accepted = true;
      pending.opId = message.opId;
      this.registration.requestIdByOpId.set(message.opId, message.requestId);
      logger.debug(`[SandboxWS] rpc:accepted spaceId=${this.spaceId} identity=${this.identity} method=${pending.method} requestId=${message.requestId.slice(0, 8)} opId=${message.opId.slice(0, 8)}`);
      return;
    }

    if (message.type === "rpc.event") {
      const { pending } = this.getPendingForOperationMessage(message);
      pending?.onEvent?.(message.event);
      return;
    }

    if (message.type === "rpc.completed") {
      const { requestId, pending } = this.getPendingForOperationMessage(message);
      if (!pending) return;
      logger.debug(`[SandboxWS] rpc:completed spaceId=${this.spaceId} identity=${this.identity} method=${pending.method} requestId=${requestId.slice(0, 8)} opId=${message.opId.slice(0, 8)}`);
      this.clearPending(requestId, pending, message.opId);
      pending.resolve(message.result as never);
      return;
    }

    if (message.type === "rpc.failed") {
      const { requestId, pending } = this.getPendingForOperationMessage(message);
      if (!pending) return;
      this.clearPending(requestId, pending, message.opId);
      const errorMessage = message.error.code === "IO_ERROR" ? truncateLogValue(message.error.message) : undefined;
      const diagnosticText = formatDiagnostics(pending.diagnostics);
      const errorText = errorMessage ? ` errorMessage=${JSON.stringify(errorMessage)}` : "";
      logger.warn(`[SandboxWS] rpc:failed spaceId=${this.spaceId} identity=${this.identity} method=${pending.method} requestId=${requestId.slice(0, 8)} opId=${message.opId.slice(0, 8)} rpcErrorCode=${message.error.code} retryable=${message.error.retryable ?? false}${errorText}${diagnosticText ? ` ${diagnosticText}` : ""}`);
      pending.reject(new SandboxRpcError(message.error.message, {
        method: pending.method,
        rpcErrorCode: message.error.code,
        retryable: message.error.retryable ?? false,
        ...(message.error.code === "IO_ERROR" ? { transportReason: message.error.message } : {}),
        diagnostics: pending.diagnostics,
      }));
    }
  }

  dispose(error?: Error) {
    if (this.disposed) return;
    this.disposed = true;

    const pendingEntries = [...this.registration.pendingByRequestId.entries()];
    if (pendingEntries.length === 0) return;

    const unaccepted = pendingEntries.filter(([, pending]) => !pending.accepted);
    const accepted = pendingEntries.length - unaccepted.length;
    logger.warn(`[SandboxWS] dispose pending requests spaceId=${this.spaceId} identity=${this.identity} accepted=${accepted} unaccepted=${unaccepted.length} error=${error?.message ?? "connection closed"}`);

    for (const [requestId, pending] of pendingEntries) {
      if (!pending.accepted) {
        this.clearPending(requestId, pending);
        pending.reject(new SandboxRpcError(SANDBOX_CONNECTION_LOST_MESSAGE, {
          method: pending.method,
          rpcErrorCode: "IO_ERROR",
          retryable: false,
          transportReason: error?.message ?? "connection closed",
          diagnostics: pending.diagnostics,
        }));
        continue;
      }

      if (pending.detachTimer) continue;
      pending.detached = true;
      pending.detachTimer = setTimeout(() => {
        const current = this.registration.pendingByRequestId.get(pending.requestId);
        if (current !== pending) return;
        logger.warn(`[SandboxWS] accepted rpc did not complete after disconnect grace spaceId=${this.spaceId} identity=${this.identity} method=${pending.method} requestId=${pending.requestId.slice(0, 8)} opId=${pending.opId?.slice(0, 8) ?? "none"}`);
        this.clearPending(requestId, pending);
        pending.reject(new SandboxRpcError(SANDBOX_CONNECTION_LOST_MESSAGE, {
          method: pending.method,
          rpcErrorCode: "IO_ERROR",
          retryable: false,
          transportReason: error?.message ?? "connection closed",
          diagnostics: pending.diagnostics,
        }));
      }, ACCEPTED_RPC_DISCONNECT_GRACE_MS);
    }
  }

  private clearPending(requestId: string, pending: PendingOperation, opId = pending.opId) {
    if (pending.detachTimer) {
      clearTimeout(pending.detachTimer);
      pending.detachTimer = undefined;
    }
    this.registration.pendingByRequestId.delete(pending.requestId);
    if (requestId !== pending.requestId) {
      this.registration.pendingByRequestId.delete(requestId);
    }
    if (opId) {
      this.registration.requestIdByOpId.delete(opId);
    }
  }

  close(reason = "sandbox connection closed") {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(1000, reason);
    } catch (error) {
      logger.warn(`[SandboxWS] Failed to close socket spaceId=${this.spaceId} identity=${this.identity}`, error);
    }
  }
}

const registrations = new Map<string, SandboxClientRegistration>();

function callHookSafely(
  spaceId: string,
  hookName: "onHeartbeat" | "onAttached" | "onFsChanged" | "onPortsChanged" | "onDisconnected" | "onConnectionError",
  fn: (() => void | Promise<void>) | undefined,
) {
  if (!fn) return;
  void Promise.resolve()
    .then(fn)
    .catch((error) => {
      logger.error(`[SandboxWS] Hook ${hookName} failed for ${spaceId}:`, error);
    });
}

function getOrCreateRegistration(spaceId: string, wsUrl: string, identity: string, headers: SandboxConnectionHeaders | undefined, hooks?: SandboxStatusHooks) {
  const existing = registrations.get(spaceId);
  if (existing) {
    if (existing.wsUrl !== wsUrl) existing.wsUrl = wsUrl;
    if (existing.identity !== identity) existing.identity = identity;
    // Always assign (including undefined) so stale auth headers never leak
    // when an endpoint switches provider (e.g. local relay -> cloud pod).
    existing.headers = headers;
    if (hooks) existing.hooks = hooks;
    return existing;
  }

  const created: SandboxClientRegistration = {
    spaceId,
    wsUrl,
    identity,
    headers,
    started: false,
    generation: 0,
    activeRun: null,
    connection: null,
    resolveWaiters: [],
    hooks,
    pendingByRequestId: new Map(),
    requestIdByOpId: new Map(),
  };
  registrations.set(spaceId, created);
  return created;
}

function setActiveConnection(spaceId: string, connection: SandboxConnection | null) {
  const registration = registrations.get(spaceId);
  if (!registration) return;

  const previous = registration.connection;
  registration.connection = connection;
  if (connection) {
    for (const resolve of registration.resolveWaiters) resolve(connection);
    registration.resolveWaiters = [];
  }
  if (previous && previous !== connection) {
    previous.dispose(new Error("sandbox connection replaced"));
    previous.close("sandbox connection replaced");
  }
}

export async function waitForSandboxConnection(spaceId: string, timeoutMs = 30000): Promise<SandboxConnection> {
  const registration = registrations.get(spaceId);
  if (!registration) {
    throw new Error(`Sandbox client for ${spaceId} has not been started`);
  }
  if (registration.connection) return registration.connection;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      registration.resolveWaiters = registration.resolveWaiters.filter((item) => item !== onResolve);
      reject(new Error(`Timed out waiting for sandbox connection for ${spaceId} after ${timeoutMs}ms`));
    }, timeoutMs);

    const onResolve = (connection: SandboxConnection) => {
      clearTimeout(timeout);
      resolve(connection);
    };

    registration.resolveWaiters.push(onResolve);
  });
}

function isCurrentRun(registration: SandboxClientRegistration, run: SandboxClientRun) {
  return registration.started
    && registration.activeRun === run
    && registration.generation === run.generation
    && !run.controller.signal.aborted;
}

export async function startSandboxWsClient(input: { spaceId: string; wsUrl: string; identity: string; headers?: SandboxConnectionHeaders; hooks?: SandboxStatusHooks }) {
  const spaceId = input.spaceId;
  const wsUrl = input.wsUrl;
  if (typeof input.headers === "function") await input.headers(wsUrl);
  const registration = getOrCreateRegistration(spaceId, wsUrl, input.identity, input.headers, input.hooks);
  if (registration.started) return;

  const run: SandboxClientRun = {
    generation: registration.generation + 1,
    controller: new AbortController(),
  };
  registration.started = true;
  registration.generation = run.generation;
  registration.activeRun = run;

  void runLoop(registration, run)
    .catch((error) => {
      logger.error(`[SandboxWS] Client run failed for ${registration.spaceId}:`, error);
    })
    .finally(() => {
      if (registration.activeRun !== run) return;
      registration.started = false;
      registration.activeRun = null;
    });
}

export function disconnectSandboxWsClient(spaceId: string, reason = "ownership lost") {
  const registration = registrations.get(spaceId);
  if (!registration) return;
  const activeRun = registration.activeRun;
  registration.started = false;
  registration.generation += 1;
  registration.activeRun = null;
  const previous = registration.connection;
  setActiveConnection(spaceId, null);

  if (registration.pendingByRequestId.size > 0) {
    logger.warn(`[SandboxWS] disconnect rejecting ${registration.pendingByRequestId.size} accepted requests spaceId=${spaceId} reason=${reason}`);
  }
  for (const [requestId, pending] of registration.pendingByRequestId) {
    if (pending.detachTimer) {
      clearTimeout(pending.detachTimer);
      pending.detachTimer = undefined;
    }
    pending.reject(new SandboxRpcError(SANDBOX_CONNECTION_LOST_MESSAGE, {
      method: pending.method,
      rpcErrorCode: "IO_ERROR",
      retryable: false,
      transportReason: reason,
      diagnostics: pending.diagnostics,
    }));
    registration.pendingByRequestId.delete(requestId);
    if (pending.opId) {
      registration.requestIdByOpId.delete(pending.opId);
    }
  }

  previous?.close(reason);
  activeRun?.controller.abort();
  logger.info(`[SandboxWS] disconnect spaceId=${spaceId} reason=${reason}`);
  callHookSafely(spaceId, "onDisconnected", () => registration.hooks?.onDisconnected?.({ spaceId, reason }));
}

export function getSandboxClientConnection(spaceId: string) {
  return registrations.get(spaceId)?.connection ?? null;
}

export function hasPendingSandboxRequests(spaceId: string) {
  return (registrations.get(spaceId)?.pendingByRequestId.size ?? 0) > 0;
}

async function runLoop(registration: SandboxClientRegistration, run: SandboxClientRun) {
  let attempt = 0;
  let lastRefreshAt = 0;

  for (;;) {
    if (!isCurrentRun(registration, run)) return;
    try {
      await connectOnce(registration, run);
      if (!isCurrentRun(registration, run)) return;
      attempt = 0;
    } catch (error) {
      if (!isCurrentRun(registration, run)) return;
      logger.error(`[SandboxWS] Client loop failed for ${registration.spaceId}:`, error);
      attempt += 1;
      if (error instanceof Error) {
        callHookSafely(registration.spaceId, "onConnectionError", () => registration.hooks?.onConnectionError?.({
          spaceId: registration.spaceId,
          error,
        }));
      }

      const now = Date.now();
      if (isRefreshableConnectionError(error) && now - lastRefreshAt >= 2_000) {
        lastRefreshAt = now;
        const currentWsUrl = registration.wsUrl;
        const nextWsUrl = await Promise.resolve(registration.hooks?.onRefreshWsUrl?.({
          spaceId: registration.spaceId,
          currentWsUrl,
          error: error instanceof Error ? error : new Error(String(error)),
        })).catch((refreshError) => {
          logger.warn(`[SandboxWS] wsUrl refresh failed spaceId=${registration.spaceId}:`, refreshError);
          return null;
        });
        if (!isCurrentRun(registration, run)) return;
        if (nextWsUrl && nextWsUrl !== currentWsUrl) {
          registration.wsUrl = nextWsUrl;
          attempt = 0;
          logger.warn(`[SandboxWS] refreshed wsUrl spaceId=${registration.spaceId} oldHash=${hashString(currentWsUrl)} newHash=${hashString(nextWsUrl)}`);
        }
      }
    }

    if (!isCurrentRun(registration, run)) return;
    const delayMs = RECONNECT_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RECONNECT_DELAYS_MS.length - 1)];
    try {
      await sleep(delayMs, undefined, { signal: run.controller.signal });
    } catch (error) {
      if (run.controller.signal.aborted) return;
      throw error;
    }
  }
}

async function connectOnce(registration: SandboxClientRegistration, run: SandboxClientRun) {
  const wsUrl = registration.wsUrl;
  const headers = typeof registration.headers === "function" ? await registration.headers(wsUrl) : registration.headers;
  if (!isCurrentRun(registration, run)) return;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(wsUrl, headers ? { headers } : undefined);
    const signal = run.controller.signal;
    let heartbeat: SandboxHeartbeat | null = null;
    let connection: SandboxConnection | null = null;
    let attached = false;
    let settled = false;
    let attachSent = false;
    let onAbort: (() => void) | null = null;
    const attachRequestId = randomUUID();

    const isActiveConnection = () => registrations.get(registration.spaceId)?.connection === connection;
    const cleanupAbortListener = () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      resolve();
    };

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      reject(error);
    };

    const closeSupersededSocket = () => {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "sandbox client superseded");
      }
    };

    onAbort = () => {
      closeSupersededSocket();
      finishResolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    socket.on("open", () => {
      if (!isCurrentRun(registration, run)) {
        closeSupersededSocket();
        finishResolve();
        return;
      }
      logger.info(`[SandboxWS] Connected ${registration.spaceId} to ${registration.wsUrl}`);
    });

    socket.on("message", (data: RawData) => {
      if (!isCurrentRun(registration, run)) {
        closeSupersededSocket();
        finishResolve();
        return;
      }
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const message = JSON.parse(raw) as AgentSandboxMessage;

        if (message.type === "sandbox.heartbeat") {
          if (message.spaceId !== registration.spaceId) {
            socket.close();
            finishReject(new Error(`Sandbox heartbeat spaceId mismatch: expected ${registration.spaceId}, got ${message.spaceId}`));
            return;
          }
          heartbeat = message;
          const setup = message.metadata?.setup;
          if (setup) {
            if (setup.ran) {
              if (setup.exitCode === 0 && !setup.error) {
                logger.debug(`[SandboxWS] setup.sh completed ok spaceId=${registration.spaceId} duration=${setup.duration}`);
              } else {
                logger.warn(`[SandboxWS] setup.sh failed spaceId=${registration.spaceId} exitCode=${setup.exitCode} duration=${setup.duration} error=${setup.error ?? "unknown"}`);
              }
            } else {
              logger.debug(`[SandboxWS] setup.sh not found, skipped spaceId=${registration.spaceId}`);
            }
          }
          callHookSafely(registration.spaceId, "onHeartbeat", () => registration.hooks?.onHeartbeat?.(message));
          if (!attachSent) {
            attachSent = true;
            socket.send(JSON.stringify({
              version: AGENT_SANDBOX_PROTOCOL_VERSION,
              type: "session.attach",
              requestId: attachRequestId,
              spaceId: registration.spaceId,
              sandboxId: message.sandboxId,
              timestamp: Date.now(),
              identity: registration.identity,
            }));
          }
          return;
        }

        if (message.type === "session.attach.ok") {
          if (message.requestId !== attachRequestId) return;
          if (!heartbeat) {
            finishReject(new Error(`Sandbox attach ok received before heartbeat for ${registration.spaceId}`));
            return;
          }
          attached = true;
          const attachedSandboxId = heartbeat.sandboxId;
          connection = new SandboxConnection(registration.spaceId, attachedSandboxId, message.identity, message.connectionId, heartbeat.capabilities, socket, registration);
          setActiveConnection(registration.spaceId, connection);
          callHookSafely(registration.spaceId, "onAttached", () => registration.hooks?.onAttached?.({
            spaceId: registration.spaceId,
            sandboxId: attachedSandboxId,
            connectionId: message.connectionId,
          }));
          const setupSummary = heartbeat.metadata?.setup
            ? heartbeat.metadata.setup.ran
              ? heartbeat.metadata.setup.exitCode === 0 && !heartbeat.metadata.setup.error
                ? `setup=ok(${heartbeat.metadata.setup.duration})`
                : `setup=failed(exitCode=${heartbeat.metadata.setup.exitCode}, duration=${heartbeat.metadata.setup.duration})`
              : "setup=skipped"
            : "setup=unknown";
          logger.info(`[SandboxWS] attached spaceId=${registration.spaceId} identity=${message.identity} connectionId=${message.connectionId.slice(0, 8)} status=${heartbeat.status} ${setupSummary}`);
          return;
        }

        if (message.type === "fs.changed") {
          const { payload } = message;
          callHookSafely(registration.spaceId, "onFsChanged", () => registration.hooks?.onFsChanged?.({
            source: payload.resync && payload.changes.length === 0 ? "sandbox-watch-started" : "sandbox-watch",
            seq: payload.seq,
            resync: payload.resync,
            changes: payload.changes,
          }, { sandboxId: message.sandboxId, timestamp: message.timestamp }));
          return;
        }

        if (message.type === "ports.changed") {
          const { payload } = message;
          callHookSafely(registration.spaceId, "onPortsChanged", () => registration.hooks?.onPortsChanged?.({
            source: payload.resync && payload.ports.length === 0 ? "sandbox-port-watch-started" : "sandbox-port-watch",
            seq: payload.seq,
            resync: payload.resync,
            ports: payload.ports,
          }, { sandboxId: message.sandboxId, timestamp: message.timestamp }));
          return;
        }

        connection?.handleMessage(message);
      } catch (error) {
        logger.error(`[SandboxWS] Failed to handle message for ${registration.spaceId}:`, error);
      }
    });

    socket.on("close", (_code, reason) => {
      connection?.dispose();
      const reasonStr = reason?.toString() || "unknown";
      const isActive = isActiveConnection();
      const isCurrent = isCurrentRun(registration, run);
      if (isActive) {
        setActiveConnection(registration.spaceId, null);
        if (isCurrent) {
          callHookSafely(registration.spaceId, "onDisconnected", () => registration.hooks?.onDisconnected?.({
            spaceId: registration.spaceId,
            reason: reasonStr,
          }));
        }
      }
      if (!attached) {
        if (!isCurrent) {
          finishResolve();
          return;
        }
        logger.warn(`[SandboxWS] closed before attach spaceId=${registration.spaceId} reason=${reasonStr}`);
        finishReject(new Error(`Sandbox websocket closed before attach: ${reasonStr}`));
        return;
      }
      if (isActive) {
        logger.debug(`[SandboxWS] closed spaceId=${registration.spaceId} reason=${reasonStr}`);
      } else {
        logger.debug(`[SandboxWS] stale connection closed spaceId=${registration.spaceId} reason=${reasonStr}`);
      }
      finishResolve();
    });

    socket.on("error", (error: Error) => {
      if (!isCurrentRun(registration, run)) {
        finishResolve();
        return;
      }
      logger.error(`[SandboxWS] Socket error for ${registration.spaceId}:`, error);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      connection?.dispose(normalizedError);
      const isActive = isActiveConnection();
      if (isActive) {
        setActiveConnection(registration.spaceId, null);
        callHookSafely(registration.spaceId, "onConnectionError", () => registration.hooks?.onConnectionError?.({
          spaceId: registration.spaceId,
          error: normalizedError,
        }));
      } else {
        logger.warn(`[SandboxWS] stale connection error ignored spaceId=${registration.spaceId} error=${normalizedError.message}`);
      }
      finishReject(normalizedError);
    });
  });
}
