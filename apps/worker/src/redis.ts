import { Redis } from "ioredis";
import { config } from "./config.js";

export const redisCommandClient = new Redis(config.redisUrl, { disableClientInfo: true });

/** Fail-fast client for best-effort state that must never queue behind a Redis outage. */
export const redisBestEffortCommandClient = new Redis(config.redisUrl, {
  commandTimeout: 250,
  disableClientInfo: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
redisBestEffortCommandClient.on("error", () => undefined);
