import { createSessionStatsRefresher, refreshSessionStatsAndPublish } from "@cohub/core/sessions";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { publishRealtimeEnvelope } from "./redis.js";

export const scheduleSessionStatsRefresh = createSessionStatsRefresher(
  (sessionId, fromSequence) => refreshSessionStatsAndPublish(db, sessionId, publishRealtimeEnvelope, fromSequence),
  (error, sessionId) => logger.warn("[Metrics] failed to refresh session stats", { sessionId, error }),
);
