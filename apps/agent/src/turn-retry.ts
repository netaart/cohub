import type { Job } from "bullmq";
import { defaultJobRetention } from "@cohub/infra/bullmq";
import { enqueueAgentTurnJob, type AgentTurnJobData } from "./queue.js";
import { env } from "./env.js";

type RetryReason = "session_busy";

const retryAttemptsByKey = new Map<string, number>();
const BUSY_RETRY_BASE_DELAY_MS = env.AGENT_BUSY_RETRY_BASE_DELAY_MS;
export const BUSY_RETRY_MAX_DELAY_MS = env.AGENT_BUSY_RETRY_MAX_DELAY_MS;

function getRetryKey(data: AgentTurnJobData, reason: RetryReason) {
  return `${reason}:${data.sessionId}`;
}

function nextRetryDelayMs(key: string) {
  const attempt = (retryAttemptsByKey.get(key) ?? 0) + 1;
  retryAttemptsByKey.set(key, attempt);
  return Math.min(BUSY_RETRY_MAX_DELAY_MS, BUSY_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 12));
}

export function clearRetryState(data: AgentTurnJobData) {
  retryAttemptsByKey.delete(getRetryKey(data, "session_busy"));
}

export async function requeueTurnJob(data: AgentTurnJobData, reason: RetryReason, job?: Job<AgentTurnJobData>, meta?: Record<string, unknown>) {
  const retryKey = getRetryKey(data, reason);
  const delay = nextRetryDelayMs(retryKey);
  await enqueueAgentTurnJob({ ...data, reason: "retry" }, {
    jobId: `agent-session-retry-${reason}-${data.sessionId}-${Math.max(1, Math.ceil(Date.now() / delay))}`,
    delay,
    removeOnComplete: true,
    removeOnFail: defaultJobRetention.removeOnFail,
  });
  return { skipped: reason, retryInMs: delay, jobId: job?.id ?? null, ...meta };
}
