import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createLogger } from "@cohub/infra/logging";
import { fileWatcherStatusSchema } from "@cohub/protocol";
import { relayAuthClose } from "../local-sandbox-auth.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

// A local sandbox runner's control connection. One per space (last writer wins;
// a new registration replaces the previous one). The gateway asks it, over this
// socket, to open data channels that get transparently piped to cloud peers.
export type RegisteredRunner = {
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

export type SandboxRelayStatusReport = {
  spaceId: string;
  status: "ready" | "stopped";
  wsEndpoint?: string | null;
  hostname?: string | null;
  gatewayNodeId?: string | null;
  runtimeId?: string | null;
  connectionId?: string;
};

export type SandboxRelayDeps = {
  workerSecret: string;
  /** Cluster-internal "host:port" other replicas can dial this pod on. */
  selfEndpoint: string;
  /** Pod-pinned peer endpoint advertised to cloud agents for this space. */
  peerEndpoint: (spaceId: string) => string;
  authorize: (authToken: string, spaceId: string) => Promise<{ ok: true; userId: string } | { ok: false; status: number; message?: string }>;
  renewWorkspace: (runner: RegisteredRunner) => Promise<boolean>;
  releaseWorkspace: (spaceId: string, receipt: string) => Promise<void>;
  reportStatus: (report: SandboxRelayStatusReport) => Promise<void>;
  runtimeChanged: (spaceId: string) => Promise<void>;
  publishWatcherEvent: (spaceId: string, frameType: string, payload: unknown) => Promise<void>;
  storeWatcherStatus: (spaceId: string, status: unknown) => Promise<void>;
  /** Cluster-internal node id, for status reporting. */
  nodeId: string;
  /** Cluster registry routing a runner data dial back to the pod holding the pending peer. */
  publishChannelHint: (channelId: string, endpoint: string) => Promise<void>;
  readChannelHint: (channelId: string) => Promise<string | null>;
  clearChannelHint: (channelId: string) => Promise<void>;
  /** Dials the forward route on the owning replica, carrying the runner's original Authorization. */
  dialForward: (endpoint: string, channelId: string, authorization: string) => Promise<WebSocket>;
};

const CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;
// Beyond the runner's 15s dial timeout, so a slow-but-successful dial can still pair
// instead of finding its peer already retired.
const DATA_PAIR_TIMEOUT_MS = 20_000;
// Hints outlive the pairing window by a small margin and are cleared on success;
// the TTL alone bounds stale entries when a pair never completes.
export const CHANNEL_HINT_TTL_SECONDS = Math.ceil((DATA_PAIR_TIMEOUT_MS + 5_000) / 1000);
export const DATA_FORWARD_DIAL_TIMEOUT_MS = 5_000;

const hashToken = (token: string) => createHash("sha256").update(token).digest();

const sameHash = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

const secretsEqual = (left: unknown, right: string) =>
  typeof left === "string" && right.length > 0 && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

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

// Wires two sockets together with transparent frame forwarding. The gateway
// does not parse the agent-sandbox protocol; it only relays bytes.
function relayFrames(a: WebSocket, b: WebSocket) {
  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState !== to.OPEN) return;
      to.send(data, { binary: isBinary });
    });
  };
  forward(a, b);
  forward(b, a);
  const done = () => {
    closeSocket(a, 1000, "relay closed");
    closeSocket(b, 1000, "relay closed");
  };
  a.on("close", done);
  b.on("close", done);
  a.on("error", done);
  b.on("error", done);
}

export function createSandboxRelay(deps: SandboxRelayDeps) {
  const runnersBySpace = new Map<string, RegisteredRunner>();
  const pendingPeers = new Map<string, PendingPeer>();

  // ── Control channel (local runner ⇒ gateway) ─────────────────────────────

  async function handleControlConnection(socket: WebSocket, request: IncomingMessage) {
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
        const auth = await deps.authorize(token, spaceId).catch((error) => {
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
        if (!await deps.renewWorkspace(candidate)) {
          socket.send(JSON.stringify({ type: "error", status: 409, message: "Runtime lease does not belong to this file bridge" }));
          closeSocket(socket, 4409, "Runtime lease unavailable");
          return;
        }
        if (closed) {
          await deps.releaseWorkspace(spaceId, candidate.receipt);
          return;
        }
        if (previous && previous.socket !== socket) closeSocket(previous.socket, 4409, "replaced by current Runtime");
        runner = candidate;
        runnersBySpace.set(spaceId, runner);
        void deps.runtimeChanged(spaceId).catch(() => undefined);
        socket.send(JSON.stringify({ type: "registered" }));
        logger.info("[Relay] local sandbox registered", { spaceId, runtimeId: runner.runtimeId ?? null });

        await deps.reportStatus({
          spaceId,
          status: "ready",
          wsEndpoint: deps.peerEndpoint(spaceId),
          hostname: deps.nodeId,
          gatewayNodeId: deps.nodeId,
          runtimeId: runner.runtimeId ?? null,
          connectionId: runner.connectionId,
        }).catch((error) => logger.warn("[Relay] failed to report ready", { spaceId, runtimeId: runner?.runtimeId ?? null, error }));
        return;
      }

      if (frame.type === "auth" && runner && typeof frame.token === "string") {
        const auth = await deps.authorize(frame.token, runner.spaceId);
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
          const auth = await deps.authorize(token, runner.spaceId);
          if (!auth.ok || auth.userId !== runner.ownerUserId) {
            const status = auth.ok ? 403 : auth.status;
            socket.send(JSON.stringify({ type: "error", status, message: "File bridge authorization expired" }));
            closeSocket(socket, relayAuthClose(status).code, "authorization required");
            return;
          }
          runner.authorizedAt = Date.now();
        }
        if (!await deps.renewWorkspace(runner)) { closeSocket(socket, 4409, "Runtime lease lost"); return; }
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (frame.type === "watcher.status" && runner && runnersBySpace.get(runner.spaceId)?.socket === socket) {
        const value = frame.payload;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const parsed = fileWatcherStatusSchema.safeParse({ ...value, observedAt: new Date().toISOString() });
        if (!parsed.success) return;
        await deps.storeWatcherStatus(runner.spaceId, parsed.data).catch((error) => logger.warn("[Relay] watcher status unavailable", { error }));
        return;
      }

      if ((frame.type === "fs.changed" || frame.type === "ports.changed") && runner) {
        void deps.publishWatcherEvent(runner.spaceId, frame.type, (frame as { payload?: unknown }).payload).catch((error) =>
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
        await deps.releaseWorkspace(spaceId, runner.receipt);
        logger.info("[Relay] local sandbox disconnected", { spaceId, runtimeId: runner.runtimeId ?? null });
        await deps.reportStatus({ spaceId, status: "stopped", runtimeId: runner.runtimeId ?? null, connectionId: runner.connectionId }).catch((error) =>
          logger.warn("[Relay] failed to report stopped", { spaceId, error }),
        );
      }
      runner = null;
    };

    socket.once("close", () => void cleanup().catch((error) => logger.warn("[Relay] cleanup failed", { error })));
    socket.on("error", () => socket.terminate());
  }

  // ── Agent side (cloud peer ⇒ gateway) ────────────────────────────────────
  // A cloud peer connects to /internal/sandbox-relay/:spaceId. The gateway asks
  // the registered runner to dial a fresh data channel, then pipes the two raw.

  async function handlePeerConnection(socket: WebSocket, request: IncomingMessage, spaceId: string) {
    // The peer route shares the public port with /ws, so it must be authenticated.
    // Only cloud services holding the shared worker secret may attach.
    if (!secretsEqual(request.headers["x-worker-secret"], deps.workerSecret)) {
      closeSocket(socket, 4401, "unauthorized");
      return;
    }
    const runner = runnersBySpace.get(spaceId);
    if (!runner) {
      closeSocket(socket, 4404, "local sandbox not connected");
      return;
    }

    const channelId = randomUUID();
    // Publish the routing hint before the runner can dial: the data connection
    // may land on any replica, and that replica must be able to find this pod
    // when the dial arrives. A failed publish only degrades cross-pod pairing
    // — a dial landing here directly still pairs locally — so continue
    // best-effort rather than failing the peer outright.
    try {
      await deps.publishChannelHint(channelId, deps.selfEndpoint);
    } catch (error) {
      logger.warn("[Relay] channel hint unavailable; cross-pod pairing degraded", { spaceId, channelId, error });
    }
    if (socket.readyState !== socket.OPEN) return;

    const timer = setTimeout(() => {
      if (pendingPeers.delete(channelId)) {
        logger.warn("[Relay] data channel pairing timed out", { spaceId, channelId, runtimeId: runnersBySpace.get(spaceId)?.runtimeId ?? null });
        void deps.clearChannelHint(channelId).catch(() => undefined);
        closeSocket(socket, 4408, "pairing timed out");
      }
    }, DATA_PAIR_TIMEOUT_MS);

    pendingPeers.set(channelId, { channelId, spaceId, peerSocket: socket, createdAt: Date.now(), timer, connectionId: runner.connectionId, tokenHash: runner.tokenHash });
    socket.on("close", () => {
      if (pendingPeers.delete(channelId)) {
        clearTimeout(timer);
        void deps.clearChannelHint(channelId).catch(() => undefined);
      }
    });

    try {
      runner.socket.send(JSON.stringify({ type: "open", channel: channelId }));
    } catch (error) {
      clearTimeout(timer);
      pendingPeers.delete(channelId);
      logger.warn("[Relay] failed to ask runner to open channel", { spaceId, channelId, runtimeId: runnersBySpace.get(spaceId)?.runtimeId ?? null, error });
      closeSocket(socket, 4503, "runner unavailable");
      return;
    }
  }

  // ── Data channel (runner dial-out ⇒ gateway) ─────────────────────────────
  // The runner dials /sandbox/relay/data?channel=<id>. The pod holding the
  // pending peer pairs the two and relays frames transparently in both
  // directions; any other replica forwards the dial to that owner.

  function handleDataConnection(runnerSocket: WebSocket, request: IncomingMessage) {
    const channelId = getQueryParam(request, "channel");
    if (!channelId) {
      closeSocket(runnerSocket, 4400, "channel is required");
      return;
    }
    if (pendingPeers.has(channelId)) {
      pairDataChannel(runnerSocket, request, channelId);
      return;
    }
    // No pending peer locally: with multiple replicas the peer most likely
    // landed on another pod. Consult the cluster hint before giving up.
    void forwardDataConnection(runnerSocket, request, channelId);
  }

  // Internal entry point on the owning replica, reached via dialForward. The
  // channel id travels in the path: /internal/sandbox-relay-forward/<id>.
  function handleDataForwardConnection(runnerSocket: WebSocket, request: IncomingMessage) {
    if (!secretsEqual(request.headers["x-worker-secret"], deps.workerSecret)) {
      closeSocket(runnerSocket, 4401, "unauthorized");
      return;
    }
    const channelId = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.split("/").pop() ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
      closeSocket(runnerSocket, 4400, "channel is required");
      return;
    }
    pairDataChannel(runnerSocket, request, channelId);
  }

  async function forwardDataConnection(runnerSocket: WebSocket, request: IncomingMessage, channelId: string) {
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    let endpoint: string | null = null;
    try {
      endpoint = await deps.readChannelHint(channelId);
    } catch {
      // Redis being unavailable must not be worse than today: unknown channel.
    }
    if (!endpoint || endpoint === deps.selfEndpoint) {
      logger.warn("[Relay] data channel without pending peer", { channelId, pendingCount: pendingPeers.size });
      closeSocket(runnerSocket, 4404, "unknown or expired channel");
      return;
    }
    let target: WebSocket;
    try {
      target = await deps.dialForward(endpoint, channelId, authorization);
    } catch (error) {
      logger.warn("[Relay] data channel forward failed", { channelId, endpoint, error });
      closeSocket(runnerSocket, 4404, "unknown or expired channel");
      return;
    }
    logger.info("[Relay] data channel forwarded", { channelId, endpoint });
    relayFrames(runnerSocket, target);
  }

  function pairDataChannel(runnerSocket: WebSocket, request: IncomingMessage, channelId: string) {
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
    void deps.clearChannelHint(channelId).catch(() => undefined);
    logger.info("[Relay] data channel paired", { spaceId: pending.spaceId, channelId, runtimeId: runner.runtimeId ?? null });
    relayFrames(pending.peerSocket, runnerSocket);
  }

  return { handleControlConnection, handlePeerConnection, handleDataConnection, handleDataForwardConnection };
}
