import { SESSION_TURN_REPLY_JOB, type SessionTurnReplyJobData } from "@cohub/protocol";
import { needsTurnReplyDelivery } from "@cohub/protocol/model";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "./bullmq/index.js";
import { createLogger } from "./logging/index.js";
import { injectTrace } from "./tracing/propagator.js";

export type SettledTurn = { id: string; status: string; meta?: unknown };

export function createTurnSettledHandler(input: { redisUrl: string; telemetryServiceName: string }) {
  let queue: ReturnType<typeof createBullmqQueue<SessionTurnReplyJobData>> | null = null;
  const logger = createLogger({ serviceName: input.telemetryServiceName });

  async function deliverReplyLater(turn: SettledTurn) {
    queue ??= createBullmqQueue<SessionTurnReplyJobData>(COHUB_SYSTEM_QUEUE, {
      redisUrl: input.redisUrl,
      telemetryServiceName: input.telemetryServiceName,
    });
    await queue.add(SESSION_TURN_REPLY_JOB, { turnId: turn.id, trace: injectTrace() }, {
      jobId: `session-turn-reply-${turn.id}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      ...defaultJobRetention,
      removeOnComplete: true,
    });
  }

  return async (turn: SettledTurn) => {
    if (!needsTurnReplyDelivery(turn)) return;
    await deliverReplyLater(turn).catch((error) => logger.error("[SessionReply] failed to queue reply delivery", { turnId: turn.id, error }));
  };
}
