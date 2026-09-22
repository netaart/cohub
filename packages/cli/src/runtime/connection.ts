import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  runtimeCommandSchema,
  runtimeReadySchema,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeExecutionEvent,
  type NativeRuntimeEvent,
} from "@neta-art/cohub";
import { executeCodex, executePi, type HarnessOptions, type HarnessResult } from "./harness.js";
import { ProcessCleanupUncertainError } from "./process-group.js";
import { ContextRequiredError, type RuntimeSessionStore } from "./session-store.js";
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
  harness: "pi" | "codex";
  requestId?: string | null;
  traceContext?: RuntimeDiagnosticContext["traceContext"];
  result?: HarnessResult;
};

export type RuntimeConnectionOptions = {
  spaceId: string;
  cwd: string;
  url: string;
  capabilities: RuntimeCapabilities;
  harnesses: HarnessOptions;
  token: (forceRefresh?: boolean) => Promise<string>;
  signal: AbortSignal;
  store: RuntimeSessionStore;
  onReady: () => void;
  onDisconnected?: () => void;
  runtimeId?: string;
  diagnostics?: RuntimeDiagnostics;
  leaseConflictTimeoutMs?: number;
  onNativeChannel?: (send: (event: NativeRuntimeEvent) => Promise<unknown>) => void;
};

export async function serveRuntime(options: RuntimeConnectionOptions) {
  const runtimeId = options.runtimeId ?? options.diagnostics?.runtimeId ?? randomUUID();
  let backoff = 500;
  let attempt = 0;
  let conflictSince: number | null = null;
  const uploads = new AbortController();
  const uploadSignal = AbortSignal.any([options.signal, uploads.signal]);
  const log = (
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
    context?: RuntimeDiagnosticContext,
  ) => options.diagnostics?.log(level, event, data, context);
  const flush = () => options.store.flushArchives(uploadSignal).catch((error) => {
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
      let outcome: "retry" | "fatal" | "conflict";
      try {
        outcome = await connect({
          ...options,
          runtimeId,
          attempt,
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
        outcome = "retry";
      }
      options.onDisconnected?.();
      if (options.signal.aborted) return;
      if (outcome === "fatal") throw new Error("Runtime connection rejected / Runtime 连接被拒绝，请检查权限或升级 CLI");
      if (readyAt && Date.now() - readyAt >= 60_000) { backoff = 500; attempt = 0; }
      if (outcome === "conflict") {
        conflictSince ??= Date.now();
        if (Date.now() - conflictSince >= (options.leaseConflictTimeoutMs ?? 90_000)) {
          throw new Error("Space is already connected to another Runtime");
        }
      }
      log("debug", "runtime.reconnect_scheduled", {
        attempt: attempt || 1,
        delayMs: backoff,
        outcome,
      });
      await delay(backoff / 2 + Math.random() * backoff / 2, undefined, { signal: options.signal }).catch(() => undefined);
      backoff = Math.min(30_000, backoff * 2);
    }
  } finally {
    clearInterval(timer);
    uploads.abort();
    await flush();
    log("info", "runtime.stopped", { runtimeId });
  }
}

type ConnectOptions = RuntimeConnectionOptions & {
  runtimeId: string;
  attempt: number;
};

function executionContext(
  connectionId: string | null,
  input: {
    sessionId: string;
    turnId: string;
    harness: "pi" | "codex";
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

async function connect(options: ConnectOptions): Promise<"retry" | "fatal" | "conflict"> {
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
  const active = new Map<string, Execution>();
  const seen = new Set<string>();
  const disconnected = new AbortController();
  const contexts = new Map<string, (context: RuntimeContext) => void>();
  let lastHeartbeat = Date.now();
  let connectionId: string | null = null;
  let fatal = false;
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
      log("error", "runtime.frame_too_large", { bytes, maxBytes: RUNTIME_MAX_FRAME_BYTES }, { connectionId });
      throw new Error("Runtime frame exceeds transfer limit");
    }
    socket.send(data);
  };
  const stop = () => {
    for (const execution of active.values()) execution.controller.abort();
    socket.close();
  };
  const sendNative = (event: NativeRuntimeEvent) => new Promise<unknown>((resolve, reject) => {
    if (!nativeChannelReady || !connectionId) { reject(new Error("Runtime native channel is unavailable")); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => { nativePending.delete(requestId); reject(new Error("Native Runtime event timed out")); }, 30_000);
    nativePending.set(requestId, { resolve, reject, timer });
    try { send({ type: "runtime.native", requestId, event }); }
    catch (error) { clearTimeout(timer); nativePending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
  });
  options.signal.addEventListener("abort", stop, { once: true });

  const heartbeat = setInterval(() => {
    const heartbeatAgeMs = Date.now() - lastHeartbeat;
    if (heartbeatAgeMs > 30_000) {
      log("error", "runtime.heartbeat_timeout", {
        ageMs: heartbeatAgeMs,
        activeExecutions: active.size,
      }, { connectionId });
      for (const execution of active.values()) {
        log("error", "runtime.execution_heartbeat_timeout", {
          ageMs: heartbeatAgeMs,
        }, executionContext(connectionId, execution));
      }
      stop();
    } else if (connectionId) {
      try {
        send({ type: "runtime.heartbeat" });
      } catch (error) {
        log("warn", "runtime.heartbeat_send_failed", {
          error: serializeDiagnosticError(error),
        }, { connectionId });
        stop();
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
            stop();
          }
        }
      }).catch((error) => {
        log("warn", "runtime.auth_refresh_failed", { error: serializeDiagnosticError(error) }, { connectionId });
        stop();
      });
    }
  }, 10_000);

  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", (event) => {
      unauthorized = event.code === 4401;
      fatal = [4400, 4403].includes(event.code);
      conflict = event.code === 4409;
      disconnected.abort();
      log(options.signal.aborted ? "debug" : fatal || conflict ? "error" : "warn", "runtime.websocket.closed", {
        code: event.code,
        reason: event.reason,
        durationMs: Date.now() - connectedAt,
        activeExecutions: active.size,
        fatal,
        conflict,
      }, { connectionId });
      nativeChannelReady = false;
      for (const pending of nativePending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Runtime native channel disconnected")); }
      nativePending.clear();
      options.onDisconnected?.();
      for (const execution of active.values()) {
        log("error", "runtime.execution_transport_lost", {
          code: event.code,
          reason: event.reason,
        }, executionContext(connectionId, execution));
        execution.controller.abort();
      }
      resolve();
    }, { once: true });
  });

  socket.addEventListener("error", (event) => {
    const detail = (event as Event & { error?: unknown }).error;
    log("warn", "runtime.websocket.error", {
      type: event.type,
      error: serializeDiagnosticError(detail ?? new Error("WebSocket error")),
    }, { connectionId });
    socket.close();
  });
  socket.addEventListener("open", () => {
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
      stop();
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

      if (raw.type === "runtime.ready") {
        const frame = runtimeReadySchema.parse(raw);
        if (connectionId === frame.connectionId) return;
        if (connectionId) throw new Error("Runtime connection identity changed");
        connectionId = frame.connectionId;
        clearTimeout(readyTimer);
        log("info", "runtime.ready", {
          connectionId,
          durationMs: Date.now() - connectedAt,
        }, { connectionId });
        nativeChannelReady = true;
        options.onNativeChannel?.(sendNative);
        options.onReady();
        let recoveryBatch = 0;
        for await (const executions of options.store.pendingExecutionBatches()) {
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
        lastHeartbeat = Date.now();
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
          await options.store.acknowledge(execution.result.state, frame.turnId, frame.revision);
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
          const saved = await options.store.recoverResult(identity);
          if (saved) for (const event of saved.events) send({ type: "runtime.event", requestId: frame.requestId, event });
          return;
        }
        const running = [...active].find(([, entry]) => entry.turnId === identity.turnId && entry.sessionId === identity.sessionId && entry.harness === identity.harness);
        const recovery: Execution = {
          ...identity,
          requestId: frame.traceContext?.requestId,
          traceContext: frame.traceContext,
          controller: new AbortController(),
          promise: Promise.resolve(),
        };
        active.set(frame.requestId, recovery);
        recovery.promise = (async () => {
          try {
            if (running) {
              running[1].controller.abort();
              await running[1].promise;
              active.delete(running[0]);
            }
            const saved = await options.store.recoverResult(identity);
            recovery.controller.signal.throwIfAborted();
            const last = saved?.events.at(-1);
            if (!saved || last?.type !== "turn.end") throw new Error("No confirmed result");
            recovery.result = { state: saved.state, event: last };
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
            active.delete(frame.requestId);
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
        await previous.promise;
        const saved = await options.store.recoverResult(frame.input, frame.requestId);
        if (saved) for (const event of saved.events) send({ type: "runtime.event", requestId: frame.requestId, event });
        return;
      }
      const requestContext = async (executionSignal: AbortSignal) => {
        const signal = AbortSignal.any([executionSignal, disconnected.signal]);
        signal.throwIfAborted();
        const pendingTurnIds = await options.store.pendingTurnIds(frame.input.sessionId);
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
        send({ type: "runtime.event", requestId: frame.requestId, event: value });
      };
      execution.promise = (async () => {
        try {
          const saved = await options.store.recoverResult(frame.input, frame.requestId);
          if (saved) {
            const last = saved.events.at(-1);
            if (last?.type !== "turn.end") throw new Error("Incomplete saved Runtime result");
            execution.result = { state: saved.state, event: last };
            for (const event of saved.events) emit(event);
            return;
          }
          if (frame.resumeOnly || repeated) {
            emit({ type: "turn.error", message: "Execution outcome is unknown; native files retained, no replay", uncertain: true });
            active.delete(frame.requestId);
            return;
          }
          const run = () => (frame.input.harness === "pi" ? executePi : executeCodex)(frame.input, options.harnesses, options.cwd, options.store, emit, controller.signal, options.diagnostics, context);
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
          await options.store.recordResult(execution.result.state, frame.requestId, [...durableEvents, execution.result.event]);
          emit(execution.result.event);
        } catch (error) {
          log("error", "runtime.turn_failed", {
            uncertain: Boolean(execution.result) || frame.resumeOnly === true || error instanceof ProcessCleanupUncertainError,
            error: serializeDiagnosticError(error),
          }, context);
          try {
            emit({ type: "turn.error", message: error instanceof Error ? error.message : String(error), uncertain: !!execution.result || frame.resumeOnly === true || error instanceof ProcessCleanupUncertainError });
          } catch {
            // Native files remain for recovery.
          }
          active.delete(frame.requestId);
        }
      })();
    })().catch((error) => {
      log("error", "runtime.protocol_error", { error: serializeDiagnosticError(error) }, { connectionId });
      stop();
    });
  });

  readyTimer = setTimeout(() => {
    log("error", "runtime.handshake_timeout", { timeoutMs: 15_000 }, { connectionId });
    socket.close(4408, "Runtime handshake timed out");
  }, 15_000);
  if (options.signal.aborted) stop();
  try {
    await closed;
    await Promise.allSettled([...active.values()].map((entry) => entry.promise));
  } finally {
    clearTimeout(readyTimer);
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", stop);
  }
  if (unauthorized && !options.signal.aborted) await options.token(true);
  return fatal ? "fatal" : conflict ? "conflict" : "retry";
}
