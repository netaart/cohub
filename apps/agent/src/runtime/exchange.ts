import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { RUNTIME_MAX_FRAME_BYTES, runtimeEventSchema, runtimeReadySchema, type RuntimeCommand, type RuntimeExecutionEvent, type RuntimeTurnInput } from "@cohub/protocol";

export class RuntimeExecutionUncertainError extends Error {}
export class RuntimeResultUnavailableError extends RuntimeExecutionUncertainError {}
export type RuntimeExchangeOptions = {
  input: RuntimeTurnInput;
  endpoint: () => Promise<string>;
  headers?: Record<string, string>;
  signal: AbortSignal;
  event: (event: RuntimeExecutionEvent, send: (command: RuntimeCommand) => void, requestId: string) => Promise<void>;
  requestId?: string;
  recovery?: boolean;
  onAcknowledgementError?: (error: unknown) => void;
  handshakeMs?: number;
  heartbeatMs?: number;
  ackMs?: number;
  reconnectMs?: number;
};

/** A reconnect can only observe/replay a known execution, never restart model or tool work. */
export async function exchangeRuntimeTurn(options: RuntimeExchangeOptions): Promise<void> {
  const requestId = options.requestId ?? randomUUID();
  const handshakeMs = options.handshakeMs ?? 15_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const ackMs = options.ackMs ?? 15_000;
  const reconnectMs = options.reconnectMs ?? 60_000;
  let started = false;
  let completed = false;
  let disconnectedAt: number | null = null;
  let finalError: unknown = null;
  for (;;) {
    let acknowledged = false;
    let attachedAt = 0;
    let socket: WebSocket | null = null;
    let chain = Promise.resolve();
    let settled = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      if (!started) options.signal.throwIfAborted();
      const endpoint = await options.endpoint();
      socket = new WebSocket(endpoint, { headers: options.headers, maxPayload: RUNTIME_MAX_FRAME_BYTES, handshakeTimeout: handshakeMs });
      const connection = socket;
      const expectedConnectionId = new URL(endpoint).searchParams.get("connection");
      let ready = false;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve();
        };
        const send = (command: RuntimeCommand) => {
          if (command.type === "turn.ack") completed = true;
          if (settled || connection.readyState !== WebSocket.OPEN) throw new Error("Runtime transport closed");
          const data = JSON.stringify(command);
          if (Buffer.byteLength(data) + connection.bufferedAmount > RUNTIME_MAX_FRAME_BYTES) throw new Error("Runtime transfer limit exceeded");
          connection.send(data);
          if (command.type === "turn.ack") {
            clearTimeout(phaseTimer);
            phaseTimer = setTimeout(() => finish(new Error("Runtime acknowledgement timed out")), ackMs);
          }
        };
        onAbort = () => {
          if (!started) { finish(new Error("Runtime execution cancelled before dispatch")); return; }
          if (connection.readyState === WebSocket.OPEN && !completed) {
            try { send({ type: "turn.abort", requestId }); } catch { /* Reconnect will send cancellation again. */ }
            abortTimer ??= setTimeout(() => finish(new Error("Runtime cancellation acknowledgement timed out")), ackMs);
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        phaseTimer = setTimeout(() => finish(new Error("Runtime handshake timed out")), handshakeMs);
        let alive = true;
        connection.on("pong", () => { alive = true; });
        pingTimer = setInterval(() => {
          if (!alive) { connection.terminate(); return; }
          alive = false;
          if (connection.readyState === WebSocket.OPEN) connection.ping();
        }, heartbeatMs);
        connection.on("message", (data) => {
          chain = chain.then(async () => {
            if (settled) return;
            const frame = JSON.parse(data.toString()) as { type?: string; requestId?: string; event?: unknown };
            if (frame.type === "runtime.ready") {
              const hello = runtimeReadySchema.parse(frame);
              if (hello.connectionId !== expectedConnectionId) throw new Error("Runtime connection identity mismatch");
              if (ready) return;
              ready = true;
              clearTimeout(phaseTimer);
              if (options.recovery) {
                const { spaceId, sessionId, turnId, harness } = options.input;
                send({ type: "turn.recover", requestId, execution: { spaceId, sessionId, turnId, harness }, traceContext: options.input.traceContext });
                phaseTimer = setTimeout(() => finish(new RuntimeExecutionUncertainError("Runtime result is not available yet")), ackMs);
              } else {
                send({ type: "turn.start", requestId, resumeOnly: started, input: options.input });
                attachedAt = Date.now();
              }
              started = true;
              if (options.signal.aborted) onAbort();
              return;
            }
            if (!ready) throw new Error("Runtime handshake is incomplete");
            if (frame.type !== "runtime.event" || frame.requestId !== requestId) throw new Error("Runtime event identity mismatch");
            const event = runtimeEventSchema.parse(frame.event);
            if (event.type === "turn.error") {
              finalError = event.uncertain ? new RuntimeResultUnavailableError(event.message) : new Error(event.message);
              finish(finalError);
              return;
            }
            if (event.type === "turn.acknowledged") {
              if (!completed) throw new Error("Runtime acknowledged an unfinished turn");
              acknowledged = true; finish(); return;
            }
            await options.event(event, send, requestId);
            if (event.type === "turn.end") completed = true;
          }).catch((error) => finish(error));
        });
        connection.once("error", (error) => finish(error));
        connection.once("close", () => { void chain.then(() => finish(new Error("Runtime connection closed"))).catch(finish); });
        if (options.signal.aborted) onAbort();
      });
    } catch (error) {
      if (finalError) {
        if (completed) {
          options.onAcknowledgementError?.(finalError);
          return;
        }
        throw finalError;
      }
      if (!started) throw error;
      // The budget covers one outage: a connection that outlived it ended the previous one.
      if (attachedAt && Date.now() - attachedAt >= reconnectMs) disconnectedAt = null;
      disconnectedAt ??= Date.now();
      if (Date.now() - disconnectedAt >= reconnectMs) {
        if (completed) return; // Durable completion must not be downgraded because an ack was lost.
        throw new RuntimeExecutionUncertainError("Runtime disconnected; original execution is not replayed and requires reconciliation", { cause: error });
      }
    } finally {
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      clearTimeout(phaseTimer); clearTimeout(abortTimer); clearInterval(pingTimer);
      socket?.terminate();
      await chain.catch(() => undefined);
    }
    if (acknowledged) return;
    await delay(Math.min(500, options.reconnectMs ?? 500));
  }
}
