import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createLogger } from "@cohub/infra/logging";
import { fileWatcherStatusSchema, parseRuntimeRegistration, runtimeRegistrationKey, runtimeWorkspaceKey } from "@cohub/protocol";
import { publishRuntimeChanged } from "./status.js";
import { gatewayConfig } from "../config.js";
import { redisCommandClient, REALTIME_OUTBOUND_CHANNEL } from "../redis.js";
import { enqueueSpaceHookFromEvent } from "../space-hooks.js";
import { authorizeLocalSandbox, reportLocalSandboxStatus } from "../api-client.js";
import { relayAuthClose } from "../local-sandbox-auth.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

// A local sandbox runner's control connection. One per space (last writer wins;
// a new registration replaces the previous one). The gateway asks it, over this
// socket, to open data channels that get transparently piped to cloud peers.
type RegisteredRunner = {
  spaceId: string;
  runtimeId?: string;
  socket: WebSocket;
  tokenHash: string;
  connectedAt: number;
  connectionId: string;
  receipt: string;
  authorizedAt: number;
  ownerUserId: string;
};

// A cloud peer (agent, worker…) waiting for its data channel to be paired with
// the freshly dialed runner data connection.
type PendingPeer = {
  channelId: string;
  spaceId: string;
  peerSocket: WebSocket;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
  connectionId: string;
  tokenHash: string;
};

const CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;
const DATA_PAIR_TIMEOUT_MS = 15_000;

const runnersBySpace = new Map<string, RegisteredRunner>();
const pendingPeers = new Map<string, PendingPeer>();

const hashToken = (token: string) => createHash("sha256").update(token).digest();

const sameHash = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

const parseBearer = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
};

const getQueryParam = (request: IncomingMessage, key: string): string | null => {
  const url = request.url ? new URL(request.url, "http://localhost") : null;
  return url?.searchParams.get(key)?.trim() || null;
};

const closeSocket = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason);
  } catch {
    // ignore
  }
};

const buildRelayWsEndpoint = (spaceId: string) =>
  `ws://${gatewayConfig.podIp}:${gatewayConfig.port}/internal/sandbox-relay/${spaceId}`;

// Republish a local sandbox watcher event (fs.changed / ports.changed) to space
// subscribers, mirroring the shape the agent produces so web consumers are
// provider-agnostic. In local mode these events arrive on the control channel
// (not data sessions), so this is the sole publish path.
async function publishRelayWatcherEvent(spaceId: string, frameType: string, payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  const seq = typeof record.seq === "number" ? record.seq : undefined;
  const resync = record.resync === true;

  let type: string;
  let eventPayload: Record<string, unknown>;
  if (frameType === "fs.changed") {
    const changes = Array.isArray(record.changes) ? record.changes : [];
    type = "space.fs.changed";
    eventPayload = {
      source: resync && changes.length === 0 ? "sandbox-watch-started" : "sandbox-watch",
      seq,
      resync,
      changes,
    };
  } else if (frameType === "ports.changed") {
    const ports = Array.isArray(record.ports) ? record.ports : [];
    type = "space.ports.changed";
    eventPayload = {
      source: resync && ports.length === 0 ? "sandbox-port-watch-started" : "sandbox-port-watch",
      seq,
      resync,
      ports,
    };
  } else {
    return;
  }

  // Publish realtime for UI and enqueue hooks concurrently.
  const id = randomUUID();
  const timestamp = Date.now();
  const message = JSON.stringify({
    id,
    timestamp,
    domain: "space",
    type,
    spaceId,
    sessionId: null,
    payload: eventPayload,
  });
  await Promise.all([
    redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, message),
    enqueueSpaceHookFromEvent({
      id,
      type,
      timestamp,
      spaceId,
      payload: eventPayload,
    }),
  ]);
}

// ── Control channel (local runner ⇒ gateway) ───────────────────────────────

export async function handleRelayControlConnection(socket: WebSocket, request: IncomingMessage) {
  let token = parseBearer(request) ?? "";
  if (!token) {
    closeSocket(socket, 4401, "unauthorized");
    return;
  }

  let runner: RegisteredRunner | null = null;
  let closed = false;
  let lastMessage = Date.now();
  let chain = Promise.resolve();
  let queuedBytes = 0;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastMessage > 60_000) socket.terminate();
  }, 20_000);
  const renewWorkspace = async (current: RegisteredRunner) => {
    const raw = await redisCommandClient.get(runtimeRegistrationKey(current.spaceId));
    const owner = raw ? parseRuntimeRegistration(raw) : null;
    if (!raw || !owner || owner.runtimeId !== current.runtimeId || owner.ownerUserId !== current.ownerUserId) return false;
    const receipt = JSON.stringify({ runtimeId: current.runtimeId, connectionId: current.connectionId, observedAt: new Date().toISOString() });
    const renewed = await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] and (ARGV[3] == '' or redis.call('GET', KEYS[2]) == ARGV[3]) then redis.call('SET', KEYS[2], ARGV[2], 'EX', 60) return 1 else return 0 end", 2, runtimeRegistrationKey(current.spaceId), runtimeWorkspaceKey(current.spaceId), raw, receipt, current.receipt);
    if (renewed === 1) current.receipt = receipt;
    return renewed === 1;
  };

  const handleMessage = async (data: Buffer) => {
    if (closed) return;
    lastMessage = Date.now();
    if (Buffer.byteLength(data as Buffer) > CONTROL_MAX_MESSAGE_BYTES) {
      closeSocket(socket, 4400, "message too large");
      return;
    }
    let frame: { type?: string; spaceId?: string; runtimeId?: string; payload?: unknown; token?: string };
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (frame.type === "register") {
      if (runner) { closeSocket(socket, 4400, "already registered"); return; }
      const spaceId = typeof frame.spaceId === "string" ? frame.spaceId.trim() : "";
      if (!spaceId) {
        socket.send(JSON.stringify({ type: "error", status: 400, message: "spaceId is required" }));
        closeSocket(socket, 4400, "spaceId is required");
        return;
      }
      const auth = await authorizeLocalSandbox({ authToken: token, spaceId }).catch((error) => {
        logger.error("[Relay] authorize failed", { spaceId, error });
        return { ok: false as const, status: 500, message: "authorization failed" };
      });
      if (!auth.ok) {
        logger.info("[Relay] local sandbox authorization rejected", {
          spaceId,
          status: auth.status,
          message: auth.message,
        });
        socket.send(JSON.stringify({ type: "error", status: auth.status, message: auth.message }));
        const close = relayAuthClose(auth.status);
        closeSocket(socket, close.code, close.reason);
        return;
      }

      if (closed) return;
      const previous = runnersBySpace.get(spaceId);
      const candidate: RegisteredRunner = {
        spaceId,
        ...(typeof frame.runtimeId === "string" && /^[0-9a-f-]{36}$/i.test(frame.runtimeId) ? { runtimeId: frame.runtimeId } : {}),
        socket,
        tokenHash: hashToken(token).toString("base64"),
        connectedAt: Date.now(),
        connectionId: randomUUID(), receipt: "", authorizedAt: Date.now(), ownerUserId: auth.userId,
      };
      if (!await renewWorkspace(candidate)) {
        socket.send(JSON.stringify({ type: "error", status: 409, message: "Runtime lease does not belong to this file bridge" }));
        closeSocket(socket, 4409, "Runtime lease unavailable");
        return;
      }
      if (closed) {
        await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, runtimeWorkspaceKey(spaceId), candidate.receipt);
        return;
      }
      if (previous && previous.socket !== socket) closeSocket(previous.socket, 4409, "replaced by current Runtime");
      runner = candidate;
      runnersBySpace.set(spaceId, runner);
      void publishRuntimeChanged(spaceId).catch(() => undefined);
      socket.send(JSON.stringify({ type: "registered" }));
      logger.info("[Relay] local sandbox registered", { spaceId, runtimeId: runner.runtimeId ?? null });

      await reportLocalSandboxStatus({
        spaceId,
        status: "ready",
        wsEndpoint: buildRelayWsEndpoint(spaceId),
        hostname: gatewayConfig.nodeId,
        gatewayNodeId: gatewayConfig.nodeId,
        runtimeId: runner.runtimeId ?? null,
        connectionId: runner.connectionId,
      }).catch((error) => logger.warn("[Relay] failed to report ready", { spaceId, runtimeId: runner?.runtimeId ?? null, error }));
      return;
    }

    if (frame.type === "auth" && runner && typeof frame.token === "string") {
      const auth = await authorizeLocalSandbox({ authToken: frame.token, spaceId: runner.spaceId });
      if (!auth.ok || auth.userId !== runner.ownerUserId) {
        const status = auth.ok ? 403 : auth.status;
        socket.send(JSON.stringify({ type: "error", status, message: "File bridge authorization rejected" }));
        closeSocket(socket, relayAuthClose(status).code, "authorization rejected");
        return;
      }
      if (closed || runnersBySpace.get(runner.spaceId)?.socket !== socket) return;
      token = frame.token;
      runner.tokenHash = hashToken(token).toString("base64");
      runner.authorizedAt = Date.now();
      socket.send(JSON.stringify({ type: "authenticated" }));
      return;
    }
    if (frame.type === "ping" && runner) {
      if (runnersBySpace.get(runner.spaceId)?.socket !== socket) { closeSocket(socket, 4409, "replaced"); return; }
      if (Date.now() - runner.authorizedAt >= 60_000) {
        const auth = await authorizeLocalSandbox({ authToken: token, spaceId: runner.spaceId });
        if (!auth.ok || auth.userId !== runner.ownerUserId) {
          const status = auth.ok ? 403 : auth.status;
          socket.send(JSON.stringify({ type: "error", status, message: "File bridge authorization expired" }));
          closeSocket(socket, relayAuthClose(status).code, "authorization required");
          return;
        }
        runner.authorizedAt = Date.now();
      }
      if (!await renewWorkspace(runner)) { closeSocket(socket, 4409, "Runtime lease lost"); return; }
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (frame.type === "watcher.status" && runner && runnersBySpace.get(runner.spaceId)?.socket === socket) {
      const value = frame.payload;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const parsed = fileWatcherStatusSchema.safeParse({ ...value, observedAt: new Date().toISOString() });
      if (!parsed.success) return;
      await redisCommandClient.set(`sandbox:watcher:${runner.spaceId}`, JSON.stringify(parsed.data), "EX", 60)
        .catch((error) => logger.warn("[Relay] watcher status unavailable", { error }));
      return;
    }

    if ((frame.type === "fs.changed" || frame.type === "ports.changed") && runner) {
      void publishRelayWatcherEvent(runner.spaceId, frame.type, (frame as { payload?: unknown }).payload).catch((error) =>
        logger.warn("[Relay] failed to publish watcher event", { spaceId: runner?.spaceId, type: frame.type, error }),
      );
      return;
    }
    // "pong" and unknown frames are ignored.
  };
  socket.on("message", (data) => {
    const bytes = Buffer.byteLength(data as Buffer);
    queuedBytes += bytes;
    if (queuedBytes > CONTROL_MAX_MESSAGE_BYTES * 2) { socket.terminate(); return; }
    chain = chain.then(() => handleMessage(data as Buffer)).catch((error) => {
      logger.warn("[Relay] control failed", { error });
      closeSocket(socket, 1011, "relay unavailable");
    }).finally(() => { queuedBytes -= bytes; });
  });

  const cleanup = async () => {
    closed = true;
    clearInterval(heartbeat);
    await chain;
    if (!runner) return;
    const spaceId = runner.spaceId;
    // Only clear if this socket is still the active runner for the space.
    if (runnersBySpace.get(spaceId)?.socket === socket) {
      runnersBySpace.delete(spaceId);
      const released = await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, runtimeWorkspaceKey(spaceId), runner.receipt);
      if (released === 1) await publishRuntimeChanged(spaceId).catch(() => undefined);
      logger.info("[Relay] local sandbox disconnected", { spaceId, runtimeId: runner.runtimeId ?? null });
      await reportLocalSandboxStatus({ spaceId, status: "stopped", runtimeId: runner.runtimeId ?? null, connectionId: runner.connectionId }).catch((error) =>
        logger.warn("[Relay] failed to report stopped", { spaceId, error }),
      );
    }
    runner = null;
  };

  socket.once("close", () => void cleanup().catch((error) => logger.warn("[Relay] cleanup failed", { error })));
  socket.on("error", () => socket.terminate());
}

// ── Agent side (cloud peer ⇒ gateway) ───────────────────────────────────────
// A cloud peer connects to /internal/sandbox-relay/:spaceId. The gateway asks
// the registered runner to dial a fresh data channel, then pipes the two raw.

export function handleRelayPeerConnection(socket: WebSocket, request: IncomingMessage, spaceId: string) {
  // The peer route shares the public port with /ws, so it must be authenticated.
  // Only cloud services holding the shared worker secret may attach.
  const secret = request.headers["x-worker-secret"];
  if (!gatewayConfig.workerSecret || secret !== gatewayConfig.workerSecret) {
    closeSocket(socket, 4401, "unauthorized");
    return;
  }
  const runner = runnersBySpace.get(spaceId);
  if (!runner) {
    closeSocket(socket, 4404, "local sandbox not connected");
    return;
  }

  const channelId = randomUUID();
  const timer = setTimeout(() => {
    if (pendingPeers.delete(channelId)) {
      logger.warn("[Relay] data channel pairing timed out", { spaceId, channelId, runtimeId: runnersBySpace.get(spaceId)?.runtimeId ?? null });
      closeSocket(socket, 4408, "pairing timed out");
    }
  }, DATA_PAIR_TIMEOUT_MS);

  pendingPeers.set(channelId, { channelId, spaceId, peerSocket: socket, createdAt: Date.now(), timer, connectionId: runner.connectionId, tokenHash: runner.tokenHash });
  socket.on("close", () => {
    const pending = pendingPeers.get(channelId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPeers.delete(channelId);
    }
  });

  try {
    runner.socket.send(JSON.stringify({ type: "open", channel: channelId }));
  } catch (error) {
    clearTimeout(timer);
    pendingPeers.delete(channelId);
    logger.warn("[Relay] failed to ask runner to open channel", { spaceId, channelId, runtimeId: runner.runtimeId ?? null, error });
    closeSocket(socket, 4503, "runner unavailable");
  }
}

// ── Data channel (runner dial-out ⇒ gateway) ────────────────────────────────
// The runner dials /sandbox/relay/data?channel=<id>. We pair it with the
// waiting peer and pipe frames transparently in both directions.

export function handleRelayDataConnection(runnerSocket: WebSocket, request: IncomingMessage) {
  const channelId = getQueryParam(request, "channel");
  if (!channelId) {
    closeSocket(runnerSocket, 4400, "channel is required");
    return;
  }
  const pending = pendingPeers.get(channelId);
  if (!pending) {
    closeSocket(runnerSocket, 4404, "unknown or expired channel");
    return;
  }
  // Second factor beyond the unguessable channel id: the data connection must
  // carry the same runner token as the registered control connection for this
  // space, so a leaked channel id alone cannot hijack the pairing.
  const token = parseBearer(request);
  const runner = runnersBySpace.get(pending.spaceId);
  if (!token || !runner || runner.connectionId !== pending.connectionId || ![runner.tokenHash, pending.tokenHash].some((hash) => sameHash(hashToken(token), Buffer.from(hash, "base64")))) {
    logger.warn("[Relay] data channel authorization rejected", { spaceId: pending.spaceId, channelId, runtimeId: runner?.runtimeId ?? null });
    closeSocket(runnerSocket, 4401, "unauthorized data channel");
    return;
  }
  clearTimeout(pending.timer);
  pendingPeers.delete(channelId);
  pipe(pending.spaceId, channelId, pending.peerSocket, runnerSocket, runner.runtimeId);
}

// pipe wires two sockets together with transparent frame forwarding. The
// gateway does not parse the agent-sandbox protocol; it only relays bytes.
function pipe(spaceId: string, channelId: string, peer: WebSocket, runner: WebSocket, runtimeId?: string) {
  logger.info("[Relay] data channel paired", { spaceId, channelId, runtimeId: runtimeId ?? null });

  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState !== to.OPEN) return;
      to.send(data, { binary: isBinary });
    });
  };
  forward(peer, runner);
  forward(runner, peer);

  const teardown = (reason: string) => {
    closeSocket(peer, 1000, reason);
    closeSocket(runner, 1000, reason);
  };
  peer.on("close", () => teardown("peer closed"));
  runner.on("close", () => teardown("runner closed"));
  peer.on("error", () => teardown("peer error"));
  runner.on("error", () => teardown("runner error"));
}
