import {
  NOTIFICATION_TURN_JOB,
  SESSION_TURN_REPLY_JOB,
  type NotificationTurnJobData,
  type SessionTurnReplyJobData,
} from "@cohub/protocol";
import { needsTurnReplyDelivery } from "@cohub/protocol/model";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "./bullmq/index.js";
import { createLogger } from "./logging/index.js";
import { injectTrace } from "./tracing/propagator.js";

export type SettledTurn = { id: string; status: string; meta?: unknown };

const NOTIFYING_STATUSES = new Set(["completed", "failed"]);

export function createTurnJobs(input: { redisUrl: string; telemetryServiceName: string }) {
  let queue: ReturnType<typeof createBullmqQueue<SessionTurnReplyJobData | NotificationTurnJobData>> | null = null;
  const logger = createLogger({ serviceName: input.telemetryServiceName });
  const systemQueue = () => queue ??= createBullmqQueue(COHUB_SYSTEM_QUEUE, {
    redisUrl: input.redisUrl,
    telemetryServiceName: input.telemetryServiceName,
  });

  const notify = (turnId: string, event: NotificationTurnJobData["event"]) =>
    systemQueue().add(NOTIFICATION_TURN_JOB, { turnId, event, trace: injectTrace() }, {
      jobId: `notification-turn-${event}-${turnId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      ...defaultJobRetention,
      removeOnComplete: { age: 3_600 },
    }).catch((error) => logger.error("[Notifications] failed to queue turn notification", { turnId, event, error }));

  return {
    turnWritten: (turnId: string) => void notify(turnId, "written"),
    async turnSettled(turn: SettledTurn) {
      const work: Promise<unknown>[] = [];
      if (NOTIFYING_STATUSES.has(turn.status)) work.push(notify(turn.id, "settled"));
      if (needsTurnReplyDelivery(turn)) {
        work.push(systemQueue().add(SESSION_TURN_REPLY_JOB, { turnId: turn.id, trace: injectTrace() }, {
          jobId: `session-turn-reply-${turn.id}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 2_000 },
          ...defaultJobRetention,
          removeOnComplete: true,
        }).catch((error) => logger.error("[SessionReply] failed to queue reply delivery", { turnId: turn.id, error })));
      }
      await Promise.all(work);
    },
  };
}
