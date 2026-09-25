import { randomUUID } from "node:crypto";
import { gatewayConfig } from "../config.js";
import { redisCommandClient, REALTIME_OUTBOUND_CHANNEL } from "../redis.js";
import { parseRuntimeRegistration, runtimeRegistrationKey, runtimeWorkspaceKey } from "@cohub/protocol";
import { publishRuntimeChanged } from "./status.js";
import { authorizeLocalSandbox, reportLocalSandboxStatus } from "../api-client.js";
import { enqueueSpaceHookFromEvent } from "../space-hooks.js";
import { WebSocket as WebSocketClient, type WebSocket } from "ws";
import { createSandboxRelay, CHANNEL_HINT_TTL_SECONDS, DATA_FORWARD_DIAL_TIMEOUT_MS, type RegisteredRunner } from "./sandbox.js";

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

const relayChannelHintKey = (channelId: string) => `sandbox:relay:channel:${channelId}`;

const renewWorkspaceLease = async (runner: RegisteredRunner) => {
  const raw = await redisCommandClient.get(runtimeRegistrationKey(runner.spaceId));
  const owner = raw ? parseRuntimeRegistration(raw) : null;
  if (!raw || !owner || owner.runtimeId !== runner.runtimeId || owner.ownerUserId !== runner.ownerUserId) return false;
  const receipt = JSON.stringify({ runtimeId: runner.runtimeId, connectionId: runner.connectionId, observedAt: new Date().toISOString() });
  const renewed = await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] and (ARGV[3] == '' or redis.call('GET', KEYS[2]) == ARGV[3]) then redis.call('SET', KEYS[2], ARGV[2], 'EX', 60) return 1 else return 0 end", 2, runtimeRegistrationKey(runner.spaceId), runtimeWorkspaceKey(runner.spaceId), raw, receipt, runner.receipt);
  if (renewed === 1) runner.receipt = receipt;
  return renewed === 1;
};

const releaseWorkspaceLease = async (spaceId: string, receipt: string) => {
  const released = await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, runtimeWorkspaceKey(spaceId), receipt);
  if (released === 1) await publishRuntimeChanged(spaceId).catch(() => undefined);
};

const hostHeader = (host: string) => (host.includes(":") ? `[${host}]` : host);

const sandboxRelay = createSandboxRelay({
  workerSecret: gatewayConfig.workerSecret,
  nodeId: gatewayConfig.nodeId,
  selfEndpoint: `${hostHeader(gatewayConfig.podIp)}:${gatewayConfig.port}`,
  peerEndpoint: (spaceId) => `ws://${hostHeader(gatewayConfig.podIp)}:${gatewayConfig.port}/internal/sandbox-relay/${spaceId}`,
  authorize: (authToken, spaceId) => authorizeLocalSandbox({ authToken, spaceId }),
  renewWorkspace: renewWorkspaceLease,
  releaseWorkspace: releaseWorkspaceLease,
  reportStatus: reportLocalSandboxStatus,
  runtimeChanged: publishRuntimeChanged,
  publishWatcherEvent: publishRelayWatcherEvent,
  storeWatcherStatus: async (spaceId, status) => { await redisCommandClient.set(`sandbox:watcher:${spaceId}`, JSON.stringify(status), "EX", 60); },
  publishChannelHint: async (channelId, endpoint) => { await redisCommandClient.set(relayChannelHintKey(channelId), endpoint, "EX", CHANNEL_HINT_TTL_SECONDS); },
  readChannelHint: (channelId) => redisCommandClient.get(relayChannelHintKey(channelId)),
  clearChannelHint: async (channelId) => { await redisCommandClient.del(relayChannelHintKey(channelId)); },
  dialForward: (endpoint, channelId, authorization) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocketClient(`ws://${endpoint}/internal/sandbox-relay-forward/${channelId}`, {
        headers: { authorization, "x-worker-secret": gatewayConfig.workerSecret },
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("forward dial timed out"));
      }, DATA_FORWARD_DIAL_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }),
});

export const handleRelayControlConnection = sandboxRelay.handleControlConnection;
export const handleRelayPeerConnection = sandboxRelay.handlePeerConnection;
export const handleRelayDataConnection = sandboxRelay.handleDataConnection;
export const handleRelayDataForwardConnection = sandboxRelay.handleDataForwardConnection;
