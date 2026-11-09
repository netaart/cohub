import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import {
  isLlmUsageMessage,
  SESSION_MESSAGE_POSTPROCESS_JOB,
  type SessionMessagePostprocessJobData,
} from "@cohub/protocol";
import { env } from "./env.js";

const queue = createBullmqQueue<SessionMessagePostprocessJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: env.BULLMQ_REDIS_URL,
  telemetryServiceName: "cohub-agent-message-postprocess",
});

/**
 * Enqueue LLM-message side effects (billing, referral, hourly usage).
 *
 * No fixed jobId: steps are idempotent (llm op id, referral lease, usageAggregatedAt CAS),
 * and a stable jobId would block re-drive while a failed/completed job still exists.
 */
export const enqueueSessionMessagePostprocess = async (input: {
  sessionId: string;
  message: { id: string; role: string; meta?: unknown };
}) => {
  if (!isLlmUsageMessage(input.message)) return;
  const data: SessionMessagePostprocessJobData = { sessionId: input.sessionId, messageId: input.message.id, trace: injectTrace() };
  await queue.add(SESSION_MESSAGE_POSTPROCESS_JOB, data, {
    attempts: 8,
    backoff: { type: "exponential", delay: 1_000 },
    ...defaultJobRetention,
  });
};
