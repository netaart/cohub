import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  runtimeCommandSchema,
  runtimeReadySchema,
  runtimeNativeStopSchema,
  type RuntimeNativeStop,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeExecutionEvent,
  type LocalHarness,
  type NativeRuntimeEvent,
} from "@neta-art/cohub";
import { describeError } from "../network-error.js";
import { executeTurn, type Executor, type HarnessResult } from "./native/execution.js";
import { ContextRequiredError } from "./native/results.js";
import { SizeLimitError } from "./native/transcript.js";
import { ProcessCleanupUncertainError } from "./process-group.js";
import {
  serializeDiagnosticError,
  type RuntimeDiagnosticContext,
  type RuntimeDiagnostics,
} from "./diagnostics.js";

type Execution = {
  controller: AbortController;
  promise: Promise<void>;
  sessionId: string;
  turnId: string;
  harness: LocalHarness;
  requestId?: string | null;
  traceContext?: RuntimeDiagnosticContext["traceContext"];
  result?: HarnessResult;
  /** Started on a transport that has since closed; it keeps running and replays on a later one. */
  detached?: boolean;
  /** Only replays a saved result for its connection; it does no local work and ends with that connection. */
  recovery?: boolean;
};

export type RuntimeConnectionOptions = {
  spaceId: string;
  cwd: string;
  url: string;
  capabilities: RuntimeCapabilities;
  token: (forceRefresh?: boolean) => Promise<string>;
  signal: AbortSignal;
  executor: Executor;
  onReady: () => void;
  onDisconnected?: () => void;
  runtimeId?: string;
  diagnostics?: RuntimeDiagnostics;
  leaseConflictTimeoutMs?: number;
  onNativeChannel?: (send: (event: NativeRuntimeEvent) => Promise<unknown>) => void;
  /** The web asked to stop a Turn; one running in a native client is stopped there. */
  onNativeStop?: (stop: RuntimeNativeStop) => void;
};

export async function serveRuntime(options: RuntimeConnectionOptions) {
  const runtimeId = options.runtimeId ?? options.diagnostics?.runtimeId ?? randomUUID();
  let backoff = 500;
  let attempt = 0;
  let conflictSince: number | null = null;
  // Executions outlive a single transport so a dropped socket reconnects immediately
  // instead of waiting for in-flight turns to finish.
  const executions = new Map<string, Execution>();
  const seen = new Set<string>();
  const announce: Announce = { current: null };
  const uploads = new AbortController();
  const uploadSignal = AbortSignal.any([options.signal, uploads.signal]);
  const log = (
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
    context?: RuntimeDiagnosticContext,
  ) => options.diagnostics?.log(level, event, data, context);
  const flush = () => options.executor.archives.flush(uploadSignal).catch((error) => {
    if (!uploadSignal.aborted) {
      log("warn", "archive.flush_failed", { error: serializeDiagnosticError(error) });
      // The diagnostic sink handles terminal presentation and throttling.
    }
  });
  const timer = setInterval(() => {
    void flush();
  }, 10_000);
  void flush();
  log("info", "runtime.started", {
    runtimeId,
    workspace: options.cwd,
    harnesses: options.capabilities.harnesses,
  });

  try {
    while (!options.signal.aborted) {
      attempt += 1;
      let readyAt = 0;
      const connectStartedAt = Date.now();
      let outcome: ConnectOutcome;
      try {
        outcome = await connect({
          ...options,
          runtimeId,
          attempt,
          executions,
          seen,
          announce,
          onReady: () => {
            readyAt = Date.now();
            conflictSince = null;
            options.onReady();
            void flush();
          },
        });
      } catch (error) {
        if (options.signal.aborted) return;
        log("warn", "runtime.connection_failed", { error: serializeDiagnosticError(error) });
        outcome = { kind: "retry" };
      }
      options.onDisconnected?.();
      if (options.signal.aborted) return;
      if (outcome.kind === "fatal") throw new Error(`Runtime connection rejected (${[outcome.code, outcome.reason].filter(Boolean).join(" ")}); ${outcome.code === 4403 ? "check Space permissions" : "upgrade the CLI"}`);
      if (readyAt && Date.now() - readyAt >= 60_000) { backoff = 500; attempt = 0; }
      if (outcome.kind === "conflict") {
        conflictSince ??= Date.now();
        if (Date.now() - conflictSince >= (options.leaseConflictTimeoutMs ?? 90_000)) {
          throw new Error("Space is already connected to another Runtime");
        }
      }
      log("debug", "runtime.reconnect_scheduled", {
        attempt: attempt || 1,
        delayMs: backoff,
        outcome: outcome.kind,
        connectedMs: Date.now() - connectStartedAt,
        readyMs: readyAt ? Date.now() - readyAt : null,
        activeExecutions: executions.size,
      });
      await delay(backoff / 2 + Math.random() * backoff / 2, undefined, { signal: options.signal }).catch(() => undefined);
      backoff = Math.min(30_000, backoff * 2);
    }
  } finally {
    for (const execution of executions.values()) execution.controller.abort();
    await Promise.allSettled([...executions.values()].map((entry) => entry.promise));
    clearInterval(timer);
    uploads.abort();
    await flush();
    log("info", "runtime.stopped", { runtimeId });
  }
}

type ConnectOptions = RuntimeConnectionOptions & {
  runtimeId: string;
  attempt: number;
  executions: Map<string, Execution>;
  seen: Set<string>;
  /** Reports a detached execution's saved result on whichever connection is ready when it settles. */
  announce: Announce;
};

type PendingExecution = { sessionId: string; turnId: string; harness: LocalHarness };
type Announce = { current: ((execution: PendingExecution) => void) | null };

function frameIdentity(frame: unknown) {
  const value = frame as { type?: unknown; requestId?: unknown; event?: { type?: unknown; sessionId?: unknown; turnId?: unknown; input?: { harness?: unknown; nativeSessionId?: unknown; turns?: Array<{ turnId?: unknown }>; sessionId?: unknown; turnId?: unknown } } };
  const event = value?.event;
  const pick = (input: unknown) => typeof input === "string" ? input : undefined;
  return {
    frameType: pick(value?.type),
    requestId: pick(value?.requestId),
    eventType: pick(event?.type),
    sessionId: pick(event?.sessionId) ?? pick(event?.input?.sessionId),
    turnId: pick(event?.turnId) ?? pick(event?.input?.turnId),
    harness: pick(event?.input?.harness),
    nativeSessionId: pick(event?.input?.nativeSessionId),
    turnCount: Array.isArray(event?.input?.turns) ? event.input.turns.length : undefined,
    turnIds: Array.isArray(event?.input?.turns) ? event.input.turns.slice(0, 10).map((turn) => pick(turn?.turnId)).filter(Boolean) : undefined,
  };
}

type ConnectOutcome =
  | { kind: "retry" }
  | { kind: "fatal"; code: number; reason: string }
  | { kind: "conflict" };

function executionContext(
  connectionId: string | null,
  input: {
    sessionId: string;
    turnId: string;
    harness: LocalHarness;
    requestId?: string | null;
    traceContext?: RuntimeDiagnosticContext["traceContext"];
  },
): RuntimeDiagnosticContext {
  return {
    connectionId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    harness: input.harness,
    requestId: input.traceContext?.requestId ?? input.requestId ?? null,
    traceContext: input.traceContext,
  };
}

async function connect(options: ConnectOptions): Promise<ConnectOutcome> {
  const log = (
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
    context?: RuntimeDiagnosticContext,
  ) => options.diagnostics?.log(level, event, data, context);
  const connectedAt = Date.now();
  log("debug", "runtime.websocket.connecting", {
    attempt: options.attempt,
    url: options.url,
  });

  let currentToken: string;
  try {
    currentToken = await options.token();
  } catch (error) {
    log("warn", error instanceof Error && error.name === "AuthRequiredError" ? "runtime.auth_required" : "runtime.auth_token_failed", { error: serializeDiagnosticError(error) });
    throw error;
  }

  const runtimeUrl = new URL(options.url);
  runtimeUrl.searchParams.set("runtimeId", options.runtimeId);
  const socket = new WebSocket(runtimeUrl.toString());
  const active = options.executions;
  const seen = options.seen;
  const disconnected = new AbortController();
  const contexts = new Map<string, (context: RuntimeContext) => void>();
  let lastHeartbeat = Date.now();
  let openedAt = 0;
  let readyAt = 0;
  let connectionId: string | null = null;
  let fatal = false;
  let fatalCode = 0;
  let fatalReason = "";
  let conflict = false;
  let unauthorized = false;
  let readyTimer: ReturnType<typeof setTimeout>;
  const nativePending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nativeChannelReady = false;

  const send = (frame: unknown) => {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > RUNTIME_MAX_FRAME_BYTES) {
      log("warn", "runtime.frame_send_unavailable", {
        readyState: socket.readyState,
        bufferedBytes: socket.bufferedAmount,
      }, { connectionId });
      throw new Error("Runtime connection unavailable");
    }
    const data = JSON.stringify(frame);
    const bytes = Buffer.byteLength(data);
    if (bytes > RUNTIME_MAX_FRAME_BYTES) {
      const identity = frameIdentity(frame);
      const execution = identity.requestId ? active.get(identity.requestId) : undefined;
      log("error", "runtime.frame_too_large", { bytes, maxBytes: RUNTIME_MAX_FRAME_BYTES, ...identity }, execution ? executionContext(connectionId, execution) : { connectionId });
      throw new SizeLimitError("Runtime frame exceeds transfer limit");
    }
    socket.send(data);
  };
  const closeTransport = () => socket.close();
  const shutdown = () => {
    for (const execution of active.values()) execution.controller.abort();
    closeTransport();
  };
  const sendNative = (event: NativeRuntimeEvent) => new Promise<unknown>((resolve, reject) => {
    if (!nativeChannelReady || !connectionId) { reject(new Error("Runtime native channel is unavailable")); return; }
    const requestId = randomUUID();
    // An ingest batch writes each of its Turns durably; everything else answers from memory or one row.
    const timer = setTimeout(() => { nativePending.delete(requestId); reject(new Error("Native Runtime event timed out")); }, event.type === "ingest" ? 120_000 : 30_000);
    nativePending.set(requestId, { resolve, reject, timer });
    try { send({ type: "runtime.native", requestId, event }); }
    catch (error) { clearTimeout(timer); nativePending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
  });
  options.signal.addEventListener("abort", shutdown, { once: true });

  const heartbeat = setInterval(() => {
    const heartbeatAgeMs = Date.now() - lastHeartbeat;
    if (heartbeatAgeMs > 30_000) {
      log("error", "runtime.heartbeat_timeout", {
        ageMs: heartbeatAgeMs,
        activeExecutions: active.size,
        readyState: socket.readyState,
        bufferedBytes: socket.bufferedAmount,
      }, { connectionId });
      closeTransport();
      // A half-open TCP path may never deliver the close event; stop waiting so reconnect can start.
      if (heartbeatAgeMs > 45_000) handleClose({ code: 1006, reason: "Runtime heartbeat timed out", wasClean: false }, true);
    } else if (connectionId) {
      try {
        send({ type: "runtime.heartbeat" });
      } catch (error) {
        log("warn", "runtime.heartbeat_send_failed", {
          error: serializeDiagnosticError(error),
        }, { connectionId });
        closeTransport();
      }
      void options.token().then((next) => {
        if (next !== currentToken) {
          try {
            send({ type: "runtime.auth", token: next });
            currentToken = next;
            log("debug", "runtime.auth_refreshed", undefined, { connectionId });
          } catch (error) {
            log("warn", "runtime.auth_refresh_send_failed", {
              error: serializeDiagnosticError(error),
            }, { connectionId });
            closeTransport();
          }
        }
      }).catch((error) => {
        log("warn", "runtime.auth_refresh_failed", { error: serializeDiagnosticError(error) }, { connectionId });
        closeTransport();
      });
    }
  }, 10_000);

  const announceHere = (execution: PendingExecution) => {
    try {
      send({ type: "runtime.recovery", executions: [execution] });
      log("info", "runtime.detached_result_announced", undefined, executionContext(connectionId, execution));
    } catch {
      // The next ready connection reports every pending receipt.
    }
  };
  /** Replays a saved result, or answers explicitly that none is available; never leaves the server waiting. */
  const replaySaved = async (requestId: string, input: PendingExecution & { spaceId: string }, context: RuntimeDiagnosticContext, executionRequestId?: string) => {
    let saved: Awaited<ReturnType<typeof options.executor.results.recover>> = null;
    try { saved = await options.executor.results.recover(input, executionRequestId); }
    catch (error) { log("error", "runtime.recovery_failed", { error: serializeDiagnosticError(error) }, context); }
    if (saved) for (const event of saved.events) send({ type: "runtime.event", requestId, event });
    else send({ type: "runtime.event", requestId, event: { type: "turn.error", uncertain: true, message: "Result unavailable; files retained" } });
  };
  let closeHandled = false;
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const handleClose = (event: { code: number; reason: string; wasClean: boolean }, forced = false) => {
    if (closeHandled) return;
    closeHandled = true;
    unauthorized = event.code === 4401;
    fatal = [4400, 4403].includes(event.code);
    if (fatal) { fatalCode = event.code; fatalReason = event.reason; }
    conflict = event.code === 4409;
    disconnected.abort();
    const now = Date.now();
    log(options.signal.aborted ? "debug" : fatal || conflict ? "error" : "warn", fatal ? "runtime.websocket.rejected" : "runtime.websocket.closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      forced,
      durationMs: now - connectedAt,
      openMs: openedAt ? now - openedAt : null,
      readyMs: readyAt ? now - readyAt : null,
      lastInboundAgeMs: now - lastHeartbeat,
      bufferedBytes: socket.bufferedAmount,
      activeExecutions: active.size,
      fatal,
      conflict,
    }, { connectionId });
    nativeChannelReady = false;
    for (const pending of nativePending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Runtime native channel disconnected")); }
    nativePending.clear();
    options.onDisconnected?.();
    const executionMustStop = options.signal.aborted || fatal || conflict;
    if (options.announce.current === announceHere) options.announce.current = null;
    for (const [requestId, execution] of active) {
      if (executionMustStop) {
        log("error", "runtime.execution_transport_invalidated", { code: event.code, reason: event.reason }, executionContext(connectionId, execution));
        execution.controller.abort();
      } else if (execution.recovery) {
        // The server re-asks on the next connection; a stale waiter must not hold a slot or its request id.
        execution.controller.abort();
      } else if (!execution.detached) {
        execution.detached = true;
        log("warn", "runtime.execution_transport_detached", { code: event.code, reason: event.reason }, executionContext(connectionId, execution));
        // The server may have stopped asking by the time this finishes; a saved result is announced again.
        void execution.promise.finally(() => {
          if (!execution.result || active.get(requestId) !== execution) return;
          options.announce.current?.({ sessionId: execution.sessionId, turnId: execution.turnId, harness: execution.harness });
        });
      }
    }
    resolveClosed();
  };
  socket.addEventListener("close", (event) => handleClose(event), { once: true });

  socket.addEventListener("error", (event) => {
    const detail = event as Event & { error?: unknown; message?: unknown };
    log("warn", "runtime.websocket.error", {
      type: event.type,
      message: typeof detail.message === "string" && detail.message ? detail.message : undefined,
      readyState: socket.readyState,
      opened: openedAt > 0,
      ready: readyAt > 0,
      lastInboundAgeMs: Date.now() - lastHeartbeat,
      error: serializeDiagnosticError(detail.error ?? new Error("WebSocket error")),
    }, { connectionId });
    socket.close();
  });
  socket.addEventListener("open", () => {
    openedAt = Date.now();
    try {
      log("info", "runtime.websocket.open", {
        attempt: options.attempt,
        durationMs: Date.now() - connectedAt,
      });
      send({
        type: "runtime.hello",
        version: RUNTIME_PROTOCOL_VERSION,
        spaceId: options.spaceId,
        token: currentToken,
        capabilities: options.capabilities,
      });
    } catch (error) {
      log("error", "runtime.hello_failed", { error: serializeDiagnosticError(error) });
      closeTransport();
    }
  });
  socket.addEventListener("message", (event) => {
    void (async () => {
      let raw: { type?: string };
      try {
        raw = JSON.parse(String(event.data)) as { type?: string };
      } catch (error) {
        log("error", "runtime.protocol.invalid_json", { error: serializeDiagnosticError(error) }, { connectionId });
        throw error;
      }
      // Any inbound frame proves the transport is live; heartbeat frames are one case.
      lastHeartbeat = Date.now();


      if (raw.type === "runtime.ready") {
        const frame = runtimeReadySchema.parse(raw);
        if (connectionId === frame.connectionId) return;
        if (connectionId) throw new Error("Runtime connection identity changed");
        connectionId = frame.connectionId;
        readyAt = Date.now();
        clearTimeout(readyTimer);
        log("info", "runtime.ready", {
          connectionId,
          durationMs: readyAt - connectedAt,
          detachedExecutions: [...active.values()].filter((entry) => entry.detached).length,
        }, { connectionId });
        nativeChannelReady = true;
        options.onNativeChannel?.(sendNative);
        options.onReady();
        options.announce.current = announceHere;
        let recoveryBatch = 0;
        for await (const executions of options.executor.results.pendingBatches()) {
          recoveryBatch += 1;
          log("info", "runtime.recovery_batch_sent", {
            batch: recoveryBatch,
            count: executions.length,
          }, { connectionId });
          send({ type: "runtime.recovery", executions });
        }
        return;
      }
      if (!connectionId) throw new Error("Runtime handshake is incomplete");
      if (raw.type === "runtime.heartbeat") {
        return;
      }
      if (raw.type === "runtime.native.stop") {
        const stop = runtimeNativeStopSchema.safeParse(raw);
        if (!stop.success) { log("warn", "runtime.protocol.invalid_native_stop", { error: stop.error.message }, { connectionId }); return; }
        if (stop.data.spaceId === options.spaceId) options.onNativeStop?.(stop.data);
        return;
      }
      if (raw.type === "runtime.native.result") {
        const result = raw as { requestId?: string; result?: unknown; error?: string };
        const pending = result.requestId ? nativePending.get(result.requestId) : null;
        if (!pending) return;
        clearTimeout(pending.timer); nativePending.delete(result.requestId ?? "");
        if (result.error) pending.reject(new Error(result.error)); else pending.resolve(result.result);
        return;
      }

      const frame = runtimeCommandSchema.parse(raw);
      if (frame.type === "session.context") {
        log("debug", "runtime.context_received", {
          messageCount: frame.context.messages.length,
        }, { connectionId });
        contexts.get(frame.requestId)?.(frame.context);
        contexts.delete(frame.requestId);
        return;
      }
      if (frame.type === "turn.abort") {
        log("info", "runtime.turn_abort_received", undefined, { connectionId, requestId: frame.requestId });
        active.get(frame.requestId)?.controller.abort();
        return;
      }
      if (frame.type === "turn.ack") {
        const execution = active.get(frame.requestId);
        if (!execution) return;
        const context = executionContext(connectionId, execution);
        try {
          await execution.promise;
          if (!execution.result) throw new Error("Runtime result is not available");
          await options.executor.results.acknowledge(execution.sessionId, frame.turnId);
        } catch (error) {
          log("error", "runtime.turn_ack_failed", {
            revision: frame.revision,
            error: serializeDiagnosticError(error),
          }, context);
          // Keep the receipt; the next reconciliation can retry acknowledgement.
          active.delete(frame.requestId);
          send({ type: "runtime.event", requestId: frame.requestId, event: { type: "turn.error", message: "Local acknowledgement failed; result retained" } });
          return;
        }
        log("info", "runtime.turn_acknowledged", { revision: frame.revision }, context);
        active.delete(frame.requestId);
        send({ type: "runtime.event", requestId: frame.requestId, event: { type: "turn.acknowledged" } });
        return;
      }
      if (frame.type === "turn.recover") {
        const identity = frame.execution;
        if (identity.spaceId !== options.spaceId) throw new Error("Invalid Runtime target");
        const context = executionContext(connectionId, {
          ...identity,
          requestId: frame.traceContext?.requestId,
          traceContext: frame.traceContext,
        });
        log("info", "runtime.recovery_requested", undefined, context);
        const previous = active.get(frame.requestId);
        if (previous) {
          if (previous.sessionId !== identity.sessionId || previous.turnId !== identity.turnId || previous.harness !== identity.harness) throw new Error("Runtime recovery identity changed");
          await previous.promise;
          await replaySaved(frame.requestId, identity, context);
          return;
        }
        const running = [...active].find(([, entry]) => entry.turnId === identity.turnId && entry.sessionId === identity.sessionId && entry.harness === identity.harness);
        const recovery: Execution = {
          ...identity,
          requestId: frame.traceContext?.requestId,
          traceContext: frame.traceContext,
          controller: new AbortController(),
          promise: Promise.resolve(),
          recovery: true,
        };
        active.set(frame.requestId, recovery);
        recovery.promise = (async () => {
          try {
            if (running) {
              // A detached execution was not superseded by this host; wait for its result instead of discarding it.
              if (running[1].detached) {
                log("info", "runtime.recovery_waiting_detached", { runningRequestId: running[0] }, context);
                // A recovery the server gave up on must not hold an execution slot until the Turn ends.
                const stopped = recovery.controller.signal;
                await Promise.race([running[1].promise, new Promise<void>((resolve) => stopped.addEventListener("abort", () => resolve(), { once: true }))]);
                stopped.throwIfAborted();
              } else {
                running[1].controller.abort();
                await running[1].promise;
              }
              if (active.get(running[0]) === running[1]) active.delete(running[0]);
            }
            const saved = await options.executor.results.recover(identity);
            recovery.controller.signal.throwIfAborted();
            const last = saved?.events.at(-1);
            if (!saved || last?.type !== "turn.end") throw new Error("No confirmed result");
            recovery.result = { session: saved.session, event: last };
            for (const event of saved.events) send({ type: "runtime.event", requestId: frame.requestId, event });
          } catch (error) {
            if (!recovery.controller.signal.aborted) {
              log("error", "runtime.recovery_failed", { error: serializeDiagnosticError(error) }, context);
              // Original files and receipts remain available for reconciliation.
              try {
                send({ type: "runtime.event", requestId: frame.requestId, event: { type: "turn.error", uncertain: true, message: "Result unavailable; files retained" } });
              } catch {
                // The next connection can read the same result.
              }
            }
            if (active.get(frame.requestId) === recovery) active.delete(frame.requestId);
          }
        })();
        return;
      }

      if (frame.input.spaceId !== options.spaceId || !options.capabilities.harnesses.includes(frame.input.harness)) throw new Error("Invalid Runtime target");
      const context = executionContext(connectionId, frame.input);
      log("info", "runtime.turn_received", {
        requestId: frame.requestId,
        resumeOnly: frame.resumeOnly === true,
      }, context);
      const previous = active.get(frame.requestId);
      if (previous) {
        if (previous.sessionId !== frame.input.sessionId || previous.turnId !== frame.input.turnId || previous.harness !== frame.input.harness) throw new Error("Runtime execution identity changed");
        log("info", "runtime.execution_resumed", { detached: previous.detached === true, settled: Boolean(previous.result) }, executionContext(connectionId, frame.input));
        await previous.promise;
        await replaySaved(frame.requestId, frame.input, context, frame.requestId);
        return;
      }
      const requestContext = async (executionSignal: AbortSignal) => {
        const signal = AbortSignal.any([executionSignal, disconnected.signal]);
        signal.throwIfAborted();
        const pendingTurnIds = await options.executor.results.pendingTurnIds(frame.input.sessionId);
        log("debug", "runtime.context_requested", { pendingTurnCount: pendingTurnIds.length }, context);
        return new Promise<RuntimeContext>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timeout);
            contexts.delete(frame.requestId);
            signal.removeEventListener("abort", abort);
            reject(new Error("Runtime context request aborted"));
          };
          const timeout = setTimeout(abort, 60_000);
          signal.addEventListener("abort", abort, { once: true });
          contexts.set(frame.requestId, (nextContext) => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            resolve(nextContext);
          });
          try {
            send({ type: "runtime.event", requestId: frame.requestId, event: { type: "context.required", pendingTurnIds } });
          } catch {
            abort();
          }
          if (signal.aborted) abort();
        });
      };
      if ([...active.values()].some((entry) => entry.sessionId === frame.input.sessionId) && !frame.input.context.complete) frame.input.context = await requestContext(options.signal);
      const repeated = seen.has(frame.requestId);
      for (const [requestId, entry] of active) {
        if (entry.sessionId !== frame.input.sessionId) continue;
        const resolved = frame.input.context.resolvedTurnIds?.includes(entry.turnId);
        const settled = entry.result && frame.input.context.settledTurnIds?.includes(entry.turnId);
        if (!resolved && !settled) continue;
        entry.controller.abort();
        await entry.promise;
        active.delete(requestId);
      }
      if ([...active.values()].some((entry) => entry.sessionId === frame.input.sessionId) || active.size >= 8) {
        log("warn", "runtime.turn_rejected_busy", { activeExecutions: active.size }, context);
        send({ type: "runtime.event", requestId: frame.requestId, event: { type: "turn.error", message: "Local Runtime is busy" } });
        return;
      }
      seen.add(frame.requestId);
      if (seen.size > 4096) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }
      const controller = new AbortController();
      const execution: Execution = {
        controller,
        sessionId: frame.input.sessionId,
        turnId: frame.input.turnId,
        harness: frame.input.harness,
        requestId: frame.input.requestId,
        traceContext: frame.input.traceContext,
        promise: Promise.resolve(),
      };
      active.set(frame.requestId, execution);
      const durableEvents: RuntimeExecutionEvent[] = [];
      const emit = (value: RuntimeExecutionEvent) => {
        if (value.type === "message.commit") durableEvents.push(value);
        // Streaming is best-effort. A detached transport must not cancel local model or tool work;
        // durable commits and the final result are replayed after reconnect.
        if (disconnected.signal.aborted || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > RUNTIME_MAX_FRAME_BYTES) return;
        try {
          send({ type: "runtime.event", requestId: frame.requestId, event: value });
        } catch (error) {
          if (!disconnected.signal.aborted && socket.readyState === WebSocket.OPEN) throw error;
        }
      };
      execution.promise = (async () => {
        try {
          const saved = await options.executor.results.recover(frame.input, frame.requestId);
          if (saved) {
            const last = saved.events.at(-1);
            if (last?.type !== "turn.end") throw new Error("Incomplete saved Runtime result");
            execution.result = { session: saved.session, event: last };
            for (const event of saved.events) emit(event);
            return;
          }
          if (frame.resumeOnly || repeated) {
            emit({ type: "turn.error", message: "Execution outcome is unknown; native files retained, no replay", uncertain: true });
            active.delete(frame.requestId);
            return;
          }
          const run = () => executeTurn(options.executor, frame.input, emit, controller.signal, frame.requestId, context);
          // Preparation can request context, then fall back once from native archive to DB.
          // These retries precede started(), so they never replay model or tool work.
          for (let retry = 0; ; retry += 1) {
            try {
              execution.result = await run();
              break;
            } catch (error) {
              if (!(error instanceof ContextRequiredError) || retry >= 2) throw error;
              frame.input.context = await requestContext(controller.signal);
            }
          }
          await options.executor.results.record(execution.result.session, frame.input, frame.requestId, [...durableEvents, execution.result.event], execution.result.uncertainCleanup);
          if (execution.result.uncertainCleanup) {
            log("warn", "runtime.turn_cleanup_pending", { cleanup: execution.result.uncertainCleanup.error }, context);
          }
          emit(execution.result.event);
        } catch (error) {
          log("error", "runtime.turn_failed", {
            uncertain: Boolean(execution.result) || frame.resumeOnly === true || error instanceof ProcessCleanupUncertainError,
            error: serializeDiagnosticError(error),
          }, context);
          try {
            emit({ type: "turn.error", message: describeError(error), uncertain: !!execution.result || frame.resumeOnly === true || error instanceof ProcessCleanupUncertainError });
          } catch {
            // Native files remain for recovery.
          }
          active.delete(frame.requestId);
        }
      })();
    })().catch((error) => {
      log("error", "runtime.protocol_error", { error: serializeDiagnosticError(error) }, { connectionId });
      closeTransport();
    });
  });

  readyTimer = setTimeout(() => {
    log("error", "runtime.handshake_timeout", { timeoutMs: 15_000 }, { connectionId });
    socket.close(4408, "Runtime handshake timed out");
  }, 15_000);
  if (options.signal.aborted) shutdown();
  try {
    await closed;
  } finally {
    clearTimeout(readyTimer);
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", shutdown);
  }
  if (unauthorized && !options.signal.aborted) await options.token(true);
  return fatal ? { kind: "fatal", code: fatalCode, reason: fatalReason } : conflict ? { kind: "conflict" } : { kind: "retry" };
}
