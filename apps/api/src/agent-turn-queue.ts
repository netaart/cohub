import { COHUB_AGENT_TURNS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { config } from "./config.js";

export const AGENT_TURN_QUEUE_NAME = COHUB_AGENT_TURNS_QUEUE;
export const AGENT_TURN_JOB_NAME = "agent_turns";
export const AGENT_SESSION_FORK_JOB_NAME = "agent_session_fork";

export type AgentTurnJobData = {
  spaceId: string;
  sessionId: string;
  reason?: "prompt" | "steer" | "goal" | "drain" | "retry" | "recovery";
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentSessionForkJobData = {
  spaceId: string;
  sessionId: string;
  parentSessionId: string;
  anchorTurnId: string;
  anchorSequence: number;
  anchorEntryId?: string | null;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentJobData = AgentTurnJobData | AgentSessionForkJobData;

export const agentTurnQueue = createBullmqQueue<AgentJobData>(AGENT_TURN_QUEUE_NAME, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-agent-turns",
});

export async function enqueueAgentTurnJob(
  data: AgentTurnJobData,
  options: JobsOptions = {},
) {
  return agentTurnQueue.add(AGENT_TURN_JOB_NAME, data, {
    jobId: `agent-session-wakeup-${data.sessionId}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
    removeOnComplete: true,
    removeOnFail: defaultJobRetention.removeOnFail,
    ...options,
  });
}

export async function enqueueAgentSessionForkJob(
  data: AgentSessionForkJobData,
  options: JobsOptions = {},
) {
  return agentTurnQueue.add(AGENT_SESSION_FORK_JOB_NAME, data, {
    jobId: `agent-session-fork-${data.sessionId}-${data.anchorEntryId ?? data.anchorTurnId}`,
    attempts: 3,
    backoff: { type: "fixed", delay: 1000 },
    ...defaultJobRetention,
    ...options,
  });
}
