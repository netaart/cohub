import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createLogger } from "@cohub/infra/logging";
import { isUuid, RUNTIME_MAX_FRAME_BYTES, runtimeClientFrameSchema, runtimeCommandSchema, type RuntimePendingExecution, type RuntimeRegistration, type RuntimeTraceContext } from "@cohub/protocol";

const logger = createLogger({ serviceName: "cohub-gateway" });

const traceMeta = (traceContext?: RuntimeTraceContext) => ({
  ...(traceContext?.requestId ? { runtime_request_id: traceContext.requestId } : {}),
  ...(traceContext?.traceId ? { runtime_trace_id: traceContext.traceId } : {}),
  ...(traceContext?.spanId ? { runtime_span_id: traceContext.spanId } : {}),
  ...(traceContext?.traceparent ? { runtime_traceparent: traceContext.traceparent } : {}),
});

export type RuntimeRelayDependencies = {
  secret: string;
  endpoint: (spaceId: string, connectionId: string) => string;
  authorize: (token: string, spaceId: string) => Promise<{ ok: true; userId: string } | { ok: false; status: number }>;
  claim: (spaceId: string, record: RuntimeRegistration) => Promise<boolean>;
  renew: (spaceId: string, record: RuntimeRegistration) => Promise<boolean>;
  release: (spaceId: string, record: RuntimeRegistration) => Promise<void>;
  heartbeatMs?: number;
  recover?: (spaceId: string, ownerUserId: string, execution: RuntimePendingExecution) => Promise<unknown>;
  nativeEvent?: (spaceId: string, ownerUserId: string, requestId: string, event: import("@cohub/protocol").NativeRuntimeEvent) => Promise<unknown>;
};
export function createRuntimeRecoveryLifecycle(input: { enqueue: (spaceId: string, ownerUserId: string, execution: RuntimePendingExecution) => Promise<unknown>; close: () => Promise<unknown> }) {
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | null = null;
  const recover = (spaceId: string, ownerUserId: string, execution: RuntimePendingExecution) => {
    if (closing) return Promise.resolve();
    const task = input.enqueue(spaceId, ownerUserId, execution).finally(() => pending.delete(task));
    pending.add(task);
    return task;
  };
  const close = () => closing ??= (async () => {
    await Promise.allSettled([...pending]);
    await input.close();
  })();
  return { recover, close };
}

const secretsEqual = (left: unknown, right: string) => typeof left === "string" && right.length > 0 && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function createRuntimeRelay(deps: RuntimeRelayDependencies) {
  const registrations = new Map<string, { socket: WebSocket; record: RuntimeRegistration; peers: Map<string, WebSocket> }>();
  const send = (socket: WebSocket, frame: unknown) => {
    const data = JSON.stringify(frame);
    if (socket.readyState !== socket.OPEN || Buffer.byteLength(data) + socket.bufferedAmount > RUNTIME_MAX_FRAME_BYTES) throw new Error("Runtime backpressure limit exceeded");
    socket.send(data);
  };
  function control(socket: WebSocket, request?: IncomingMessage) {
    let current: { spaceId: string; record: RuntimeRegistration } | null = null;
    const advertisedRuntimeIdValue = new URL(request?.url ?? "/", "http://localhost").searchParams.get("runtimeId")?.trim() || "";
    const advertisedRuntimeId = isUuid(advertisedRuntimeIdValue) ? advertisedRuntimeIdValue : undefined;
    const connectedAt = Date.now();
    logger.debug("runtime.control.connected");
    let token = "";
    let authorizedAt = 0;
    let lastHeartbeat = Date.now();
    let ticking = false;
    let closed = false;
    let queuedBytes = 0;
    let chain = Promise.resolve();
    const deny = (status: number) => socket.close(status === 401 ? 4401 : status >= 500 ? 1011 : 4403, "Runtime authorization failed");
    const handshake = setTimeout(() => socket.close(4408, "Runtime handshake timed out"), 10_000);
    const interval = deps.heartbeatMs ?? 10_000;
    async function tick() {
      if (!current || closed || ticking) return;
      ticking = true;
      try {
        if (Date.now() - lastHeartbeat > interval * 3) {
          logger.warn("runtime.control.heartbeat_timeout", {
            spaceId: current.spaceId,
            runtimeId: current.record.runtimeId,
            connectionId: current.record.connectionId,
            heartbeatAgeMs: Date.now() - lastHeartbeat,
          });
          socket.terminate();
          return;
        }
        if (Date.now() - authorizedAt >= 60_000) {
          const auth = await deps.authorize(token, current.spaceId);
          if (!auth.ok) {
            logger.warn("runtime.control.reauthorization_failed", { spaceId: current.spaceId, status: auth.status, runtimeId: current.record.runtimeId });
            deny(auth.status);
            return;
          }
          if (auth.userId !== current.record.ownerUserId) {
            logger.warn("runtime.control.owner_changed", { spaceId: current.spaceId, runtimeId: current.record.runtimeId });
            deny(403);
            return;
          }
          authorizedAt = Date.now();
        }
        if (!await deps.renew(current.spaceId, current.record)) {
          logger.warn("runtime.control.lease_lost", { spaceId: current.spaceId, runtimeId: current.record.runtimeId });
          socket.close(4409, "Runtime lease lost");
          return;
        }
        send(socket, { type: "runtime.heartbeat" });
      } finally { ticking = false; }
    }
    const heartbeat = setInterval(() => {
      void tick().catch((error) => {
        logger.error("runtime.control.heartbeat_failed", { spaceId: current?.spaceId, runtimeId: current?.record.runtimeId, error });
        socket.close(1011, "Runtime lease unavailable");
      });
    }, interval);
    socket.on("message", (data) => {
      const bytes = Buffer.byteLength(data as Buffer);
      queuedBytes += bytes;
      if (queuedBytes > RUNTIME_MAX_FRAME_BYTES * 2) { socket.terminate(); return; }
      chain = chain.then(async () => {
        if (closed) return;
        const frame = runtimeClientFrameSchema.parse(JSON.parse(data.toString()));
        if (frame.type === "runtime.hello") {
          if (current) throw new Error("Runtime already registered");
          const auth = await deps.authorize(frame.token, frame.spaceId);
          if (!auth.ok) {
            logger.warn("runtime.control.authorization_rejected", { spaceId: frame.spaceId, status: auth.status, runtimeId: advertisedRuntimeId });
            deny(auth.status);
            return;
          }
          if (closed) return;
          const connectionId = randomUUID();
          const record: RuntimeRegistration = { connectionId, runtimeId: advertisedRuntimeId, ownerUserId: auth.userId, capabilities: frame.capabilities, endpoint: deps.endpoint(frame.spaceId, connectionId) };
          if (!await deps.claim(frame.spaceId, record)) {
            logger.warn("runtime.control.registration_conflict", { spaceId: frame.spaceId, runtimeId: advertisedRuntimeId, connectionId });
            socket.close(4409, "Space already has a Runtime");
            return;
          }
          if (closed || socket.readyState !== socket.OPEN) { await deps.release(frame.spaceId, record); return; }
          current = { spaceId: frame.spaceId, record };
          token = frame.token; authorizedAt = Date.now(); lastHeartbeat = Date.now();
          registrations.set(frame.spaceId, { socket, record, peers: new Map() });
          clearTimeout(handshake);
          logger.info("runtime.control.registered", {
            spaceId: frame.spaceId,
            runtimeId: advertisedRuntimeId,
            connectionId,
            harnesses: frame.capabilities.harnesses,
            modelCount: frame.capabilities.models.length,
          });
          send(socket, { type: "runtime.ready", connectionId });
        } else {
          if (!current) throw new Error("Runtime is not registered");
          if (frame.type === "runtime.auth") {
            const auth = await deps.authorize(frame.token, current.spaceId);
            if (!auth.ok) {
              logger.warn("runtime.control.auth_rejected", { spaceId: current.spaceId, runtimeId: current.record.runtimeId, status: auth.status });
              deny(auth.status);
              return;
            }
            if (auth.userId !== current.record.ownerUserId) {
              logger.warn("runtime.control.owner_changed", { spaceId: current.spaceId, runtimeId: current.record.runtimeId });
              deny(403);
              return;
            }
            token = frame.token;
            authorizedAt = Date.now();
            logger.debug("runtime.control.auth_refreshed", { spaceId: current.spaceId, runtimeId: current.record.runtimeId });
          } else if (frame.type === "runtime.heartbeat") lastHeartbeat = Date.now();
          else if (frame.type === "runtime.native") {
            if (!deps.nativeEvent) throw new Error("Native runtime events are unavailable");
            try {
              const result = await deps.nativeEvent(current.spaceId, current.record.ownerUserId, frame.requestId, frame.event);
              send(socket, { type: "runtime.native.result", requestId: frame.requestId, result });
            } catch (error) {
              send(socket, { type: "runtime.native.result", requestId: frame.requestId, error: error instanceof Error ? error.message : String(error) });
            }
          } else if (frame.type === "runtime.recovery") {
            logger.info("runtime.recovery_batch_received", { spaceId: current.spaceId, runtimeId: current.record.runtimeId, count: frame.executions.length });
            for (const execution of frame.executions) {
              const task = deps.recover?.(current.spaceId, current.record.ownerUserId, execution);
              if (task) void task.catch((error) => logger.warn("runtime.recovery_wakeup_failed", { spaceId: current?.spaceId, runtimeId: current?.record.runtimeId, execution, error }));
            }
          } else {
            const peer = registrations.get(current.spaceId)?.peers.get(frame.requestId);
            if (peer) send(peer, frame);
          }
        }
      }).catch((error) => {
        logger.warn("runtime.control.protocol_error", { spaceId: current?.spaceId, runtimeId: current?.record.runtimeId, error });
        socket.close(4400, "Invalid Runtime frame");
      }).finally(() => { queuedBytes -= bytes; });
    });
    socket.on("error", (error) => {
      logger.warn("runtime.control.socket_error", { spaceId: current?.spaceId, runtimeId: current?.record.runtimeId, error });
      socket.terminate();
    });
    socket.once("close", (code, reason) => {
      closed = true; clearTimeout(handshake); clearInterval(heartbeat);
      if (!current) {
        logger.debug("runtime.control.closed", { code, reason: reason.toString(), durationMs: Date.now() - connectedAt });
        return;
      }
      logger.info("runtime.control.closed", {
        spaceId: current.spaceId,
        runtimeId: current.record.runtimeId,
        connectionId: current.record.connectionId,
        durationMs: Date.now() - connectedAt,
        code,
        reason: reason.toString(),
      });
      const registration = registrations.get(current.spaceId);
      if (registration?.socket === socket) {
        registrations.delete(current.spaceId);
        for (const peer of registration.peers.values()) peer.close(1011, "Runtime disconnected");
      }
      void deps.release(current.spaceId, current.record).catch(() => undefined);
    });
  }
  function peer(socket: WebSocket, request: IncomingMessage, spaceId: string) {
    if (!secretsEqual(request.headers["x-worker-secret"], deps.secret)) {
      logger.warn("runtime.peer.unauthorized", { spaceId });
      socket.close(4401, "unauthorized");
      return;
    }
    const registration = registrations.get(spaceId);
    const connection = new URL(request.url ?? "/", "http://localhost").searchParams.get("connection");
    if (!registration || registration.record.connectionId !== connection || registration.socket.readyState !== registration.socket.OPEN) {
      logger.debug("runtime.peer.unavailable", { spaceId, connectionId: connection, runtimeId: registration?.record.runtimeId });
      socket.close(4404, "Runtime unavailable");
      return;
    }
    logger.debug("runtime.peer.connected", { spaceId, connectionId: connection, runtimeId: registration.record.runtimeId });
    let requestId: string | null = null;
    let turnId: string | null = null;
    let startedExecution: RuntimePendingExecution | null = null;
    let acknowledged = false;
    const handshake = setTimeout(() => socket.close(4408, "Runtime request timed out"), 15_000);
    send(socket, { type: "runtime.ready", connectionId: connection });
    socket.on("message", (data) => {
      try {
        const command = runtimeCommandSchema.parse(JSON.parse(data.toString()));
        if (command.type === "turn.start" || command.type === "turn.recover") {
          const execution = command.type === "turn.start" ? command.input : command.execution;
          if (requestId || execution.spaceId !== spaceId || registration.peers.has(command.requestId)) throw new Error("Invalid execution identity");
          if (registration.peers.size >= 8) {
            send(socket, { type: "runtime.event", requestId: command.requestId, event: { type: "turn.error", message: "Local Runtime is busy" } });
            return;
          }
          requestId = command.requestId; turnId = execution.turnId;
          if (command.type === "turn.start") {
            startedExecution = { sessionId: execution.sessionId, turnId: execution.turnId, harness: execution.harness };
            logger.info("runtime.peer.turn_start", {
              spaceId,
              runtimeId: registration.record.runtimeId,
              connectionId: registration.record.connectionId,
              requestId: command.requestId,
              sessionId: execution.sessionId,
              turnId: execution.turnId,
              harness: execution.harness,
              ...traceMeta(command.input.traceContext),
            });
          } else {
            logger.info("runtime.peer.turn_recover", {
              spaceId,
              runtimeId: registration.record.runtimeId,
              connectionId: registration.record.connectionId,
              requestId: command.requestId,
              sessionId: execution.sessionId,
              turnId: execution.turnId,
              harness: execution.harness,
              ...traceMeta(command.traceContext),
            });
          }
          registration.peers.set(requestId, socket); clearTimeout(handshake);
        } else if (!requestId || command.requestId !== requestId) throw new Error("Unknown execution");
        if (command.type === "turn.ack" && command.turnId !== turnId) throw new Error("Ack turn identity mismatch");
        send(registration.socket, command);
        if (command.type === "turn.ack") {
          acknowledged = true;
          logger.info("runtime.peer.turn_ack", { spaceId, runtimeId: registration.record.runtimeId, connectionId: registration.record.connectionId, requestId, turnId });
        }
      } catch (error) {
        logger.warn("runtime.peer.protocol_error", { spaceId, runtimeId: registration.record.runtimeId, connectionId: registration.record.connectionId, requestId, error });
        socket.close(4400, "Invalid Runtime request");
      }
    });
    socket.on("error", (error) => {
      logger.warn("runtime.peer.socket_error", { spaceId, runtimeId: registration.record.runtimeId, connectionId: registration.record.connectionId, requestId, error });
      socket.terminate();
    });
    socket.once("close", (code, reason) => {
      clearTimeout(handshake);
      logger.debug("runtime.peer.closed", { spaceId, runtimeId: registration.record.runtimeId, connectionId: registration.record.connectionId, requestId, turnId, acknowledged, code, reason: reason.toString() });
      if (!requestId) return;
      registration.peers.delete(requestId);
      if (!acknowledged) {
        try { send(registration.socket, { type: "turn.abort", requestId }); } catch { /* Local watchdog aborts on disconnect. */ }
        if (startedExecution) {
          const task = deps.recover?.(spaceId, registration.record.ownerUserId, startedExecution);
          if (task) void task.catch((error) => logger.warn("runtime.recovery_wakeup_failed", { spaceId, runtimeId: registration.record.runtimeId, execution: startedExecution, error }));
        }
      }
    });
  }
  return { control, peer };
}
