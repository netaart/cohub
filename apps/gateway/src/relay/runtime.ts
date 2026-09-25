import { createAgentTurnsQueue, enqueueRuntimeRecovery } from "@cohub/infra/agent-queue";
import { AGENT_TURN_ABORT_CHANNEL, runtimeRegistrationKey, type RuntimeRegistration } from "@cohub/protocol";
import { createLogger } from "@cohub/infra/logging";
import { authorizeLocalSandbox } from "../api-client.js";
import { gatewayConfig } from "../config.js";
import { createPubSubRedisClient, redisCommandClient } from "../redis.js";
import { createRuntimeRecoveryLifecycle, createRuntimeRelay } from "./runtime-relay.js";
import { publishRuntimeChanged } from "./status.js";
import { forwardNativeRuntimeEvent } from "../native-runtime-client.js";

const recoveryQueue = createAgentTurnsQueue(gatewayConfig.bullmqRedisUrl, "cohub-gateway-runtime");
const recovery = createRuntimeRecoveryLifecycle({
  enqueue: (spaceId, ownerUserId, execution) => enqueueRuntimeRecovery(recoveryQueue, {
    spaceId,
    sessionId: execution.sessionId,
    expectedTurnId: execution.turnId,
    expectedHarness: execution.harness,
    expectedOwnerUserId: ownerUserId,
  }),
  close: () => recoveryQueue.close(),
});
// Claim script: an absent lease is claimed, and the same Runtime (runtimeId + owner) always retakes
// its own lease, so a reconnect replaces a stale entry instead of waiting out the TTL.
const claimScript =
  "local current = redis.call('GET', KEYS[1]) " +
  "if not current then redis.call('SET', KEYS[1], ARGV[1], 'EX', 40) return 1 end " +
  "local existing = cjson.decode(current) " +
  "if (existing.runtimeId or '') == ARGV[2] and existing.ownerUserId == ARGV[3] then redis.call('SET', KEYS[1], ARGV[1], 'EX', 40) return 1 end " +
  "return 0";
const relay = createRuntimeRelay({
  recover: recovery.recover,
  nativeEvent: (spaceId, ownerUserId, requestId, event) => forwardNativeRuntimeEvent({ spaceId, ownerUserId, requestId, event }),
  secret: gatewayConfig.workerSecret,
  endpoint: (spaceId, connectionId) => {
    const host = gatewayConfig.podIp.includes(":") ? `[${gatewayConfig.podIp}]` : gatewayConfig.podIp;
    return `ws://${host}:${gatewayConfig.port}/internal/runtime-relay/${spaceId}?connection=${connectionId}`;
  },
  authorize: (authToken, spaceId) => authorizeLocalSandbox({ authToken, spaceId }),
  claim: async (spaceId: string, record: RuntimeRegistration) => {
    const claimed = await redisCommandClient.eval(claimScript, 1, runtimeRegistrationKey(spaceId),
      JSON.stringify(record), record.runtimeId ?? "", record.ownerUserId) === 1;
    if (claimed) await publishRuntimeChanged(spaceId).catch(() => undefined);
    return claimed;
  },
  renew: async (spaceId, record) => await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 40) else return 0 end", 1, runtimeRegistrationKey(spaceId), JSON.stringify(record)) === 1,
  release: async (spaceId, record) => {
    const released = await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, runtimeRegistrationKey(spaceId), JSON.stringify(record));
    if (released === 1) await publishRuntimeChanged(spaceId).catch(() => undefined);
  },
});

export const handleRuntimeConnection = relay.control;
export const handleRuntimePeer = relay.peer;

const logger = createLogger({ serviceName: "cohub-gateway" });

/**
 * Stop requests reach a Runtime as a push, not by the Runtime polling: every Gateway listens and
 * the one holding the Space's Runtime connection forwards the request.
 */
let stopSubscriber: ReturnType<typeof createPubSubRedisClient> | null = null;

export async function startRuntimeStopSubscriber() {
  // The shared pub/sub client logs its own errors and reconnects, resubscribing on its own.
  const client = createPubSubRedisClient();
  stopSubscriber = client;
  if (client.status === "wait") await client.connect();
  await client.subscribe(AGENT_TURN_ABORT_CHANNEL);
  client.on("message", (channel, message) => {
    if (channel !== AGENT_TURN_ABORT_CHANNEL) return;
    try {
      const event = JSON.parse(message) as { spaceId?: unknown; sessionId?: unknown; turnId?: unknown };
      if (typeof event.spaceId !== "string" || typeof event.sessionId !== "string" || typeof event.turnId !== "string") return;
      relay.stop({ spaceId: event.spaceId, sessionId: event.sessionId, turnId: event.turnId });
    } catch (error) {
      logger.warn("runtime.native.stop_invalid", { error });
    }
  });
}

export async function closeRuntimeRelay() {
  await Promise.all([recovery.close(), stopSubscriber?.quit().catch(() => undefined)]);
  stopSubscriber = null;
}
