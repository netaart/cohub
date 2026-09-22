import { randomUUID } from "node:crypto";
import { redisCommandClient, REALTIME_OUTBOUND_CHANNEL } from "../redis.js";

/** Invalidation, not a second status authority. Clients fetch the current leases. */
export async function publishRuntimeChanged(spaceId: string) {
  await redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify({
    id: randomUUID(), timestamp: Date.now(), domain: "space", type: "space.runtime.changed",
    spaceId, sessionId: null, payload: {},
  }));
}
