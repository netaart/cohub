import { createSessionSnapshotScheduler, publishSessionSnapshot } from "@cohub/core/sessions";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { publishRealtimeEnvelope } from "./redis.js";

export const scheduleSessionSnapshot = createSessionSnapshotScheduler(
  (sessionId, fromSequence) => publishSessionSnapshot(db, sessionId, publishRealtimeEnvelope, fromSequence),
  (error, sessionId) => logger.warn("[Realtime] failed to publish session snapshot", { sessionId, error }),
);
