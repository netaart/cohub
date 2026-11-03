import { randomUUID } from "node:crypto";
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import { maybeEnqueueSpaceHookTask } from "@cohub/infra/space-hooks";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultCriticalJobOptions } from "@cohub/infra/bullmq";
import { config } from "./config.js";
import { enqueueFsCdnWarmForChanges } from "./space-fs-cdn-prewarm.js";
import { dispatchRealtimeEvent } from "./channels.js";
import type { RealtimeEnvelope, RealtimeRoom, RealtimeServerEvent } from "@cohub/protocol/realtime";
import { createLogger } from "@cohub/infra/logging";
import { redisCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-api" });

const systemQueue = createBullmqQueue(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-space-hooks",
});

function enqueueSpaceHookFromEvent(input: {
  id?: string | null;
  type: string;
  timestamp?: number;
  spaceId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown> | null;
}) {
  return maybeEnqueueSpaceHookTask({
    event: input,
    redis: redisCommandClient,
    enqueue: (name, payload, options) => systemQueue.add(name, payload, {
      ...defaultCriticalJobOptions,
      ...options,
    }),
  }).catch((error) => {
    logger.warn("[SpaceHooks] failed to enqueue space_hook.dispatch", {
      type: input.type,
      spaceId: input.spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
}

type SpaceEventDispatchOptions = {
  skipHooks?: boolean;
  skipRealtime?: boolean;
};

export async function dispatchSpaceDomainEvent(input: (RealtimeServerEvent | RealtimeEnvelope) & {
  rooms?: RealtimeRoom[];
}, options?: SpaceEventDispatchOptions) {
  const deliveries: Promise<unknown>[] = [];
  if (!options?.skipRealtime) deliveries.push(dispatchRealtimeEvent(input));
  if (!options?.skipHooks) {
    deliveries.push(enqueueSpaceHookFromEvent({
      id: input.id,
      type: input.type,
      timestamp: input.timestamp,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      payload: input.payload as Record<string, unknown>,
    }));
  }
  await Promise.all(deliveries);
}

export async function dispatchSpaceFsChanged(spaceId: string, payload: SpaceFsChangedPayload, options?: SpaceEventDispatchOptions) {
  await Promise.all([
    dispatchSpaceDomainEvent({
      id: randomUUID(),
      timestamp: Date.now(),
      domain: "space",
      type: "space.fs.changed",
      spaceId,
      sessionId: null,
      payload,
    }, options),
    enqueueFsCdnWarmForChanges(spaceId, payload.changes).catch((error) => {
      logger.error("[SpaceFS] Failed to enqueue CDN prewarm:", error);
    }),
  ]);
}
