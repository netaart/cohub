import { COHUB_AGENT_TURNS_QUEUE, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import {
  createAgentTurnsQueue,
  type AgentRuntimeRecoveryJobData,
  AGENT_SANDBOX_BASH_JOB_NAME,
  AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME,
  AGENT_RUN_COMMAND_JOB_NAME,
  AGENT_SANDBOX_FS_MUTATION_JOB_NAME,
  AGENT_SANDBOX_FS_INSTALL_JOB_NAME,
  buildAgentSandboxBashJobId,
  buildAgentRunCommandJobId,
  buildAgentSandboxFsMutationJobId,
  type AgentSandboxBashUploadJobData,
  type AgentRunCommandJobData,
  type AgentRunCommandJobResult,
  type AgentSandboxFsMutationJobData,
  type AgentSandboxFsMutationJobResult,
  type AgentSandboxFsMutationOperation,
  type AgentSandboxFsInstallEntry,
  type AgentSandboxFsInstallEntryResult,
  type AgentSandboxFsInstallJobData,
  type AgentSandboxFsInstallJobResult,
} from "@cohub/infra/agent-queue";
import { env } from "./env.js";

export const AGENT_TURN_QUEUE_NAME = COHUB_AGENT_TURNS_QUEUE;
export const AGENT_TURN_JOB_NAME = "agent_turns";
export const AGENT_SESSION_FORK_JOB_NAME = "agent_session_fork";
export {
  AGENT_SANDBOX_BASH_JOB_NAME,
  AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME,
  AGENT_RUN_COMMAND_JOB_NAME,
  AGENT_SANDBOX_FS_MUTATION_JOB_NAME,
  AGENT_SANDBOX_FS_INSTALL_JOB_NAME,
};
export type {
  AgentSandboxBashUploadJobData,
  AgentRunCommandJobData,
  AgentRunCommandJobResult,
  AgentSandboxFsMutationJobData,
  AgentSandboxFsMutationJobResult,
  AgentSandboxFsMutationOperation,
  AgentSandboxFsInstallEntry,
  AgentSandboxFsInstallEntryResult,
  AgentSandboxFsInstallJobData,
  AgentSandboxFsInstallJobResult,
};

export type AgentTurnJobData = {
  spaceId: string;
  sessionId: string;
  reason?: "prompt" | "steer" | "drain" | "retry" | "recovery" | "generation_complete" | "generation_failed";
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

export type AgentJobData = AgentRuntimeRecoveryJobData | AgentTurnJobData | AgentSessionForkJobData | AgentSandboxBashUploadJobData | AgentRunCommandJobData | AgentSandboxFsMutationJobData | AgentSandboxFsInstallJobData;

export const agentTurnQueue = createAgentTurnsQueue<AgentJobData, unknown>(env.BULLMQ_REDIS_URL, "cohub-agent");
export const buildSandboxBashJobId = buildAgentSandboxBashJobId;
export const buildRunCommandJobId = buildAgentRunCommandJobId;
export const buildSandboxFsMutationJobId = buildAgentSandboxFsMutationJobId;

export async function enqueueAgentTurnJob(data: AgentTurnJobData, options: JobsOptions = {}) {
  const trace = injectTrace();
  const jobId = options.jobId ?? (data.reason === "drain" ? null : `agent-session-wakeup-${data.sessionId}`);
  return agentTurnQueue.add(AGENT_TURN_JOB_NAME, {
    ...data,
    requestId: getCurrentRequestId() ?? data.requestId ?? null,
    trace: Object.keys(trace).length > 0 ? trace : data.trace,
  }, {
    ...(jobId ? { jobId } : {}),
    // Covers queue/DB failures before claim; claimed LLM turns retry in session-runtime.
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
    removeOnComplete: true,
    removeOnFail: defaultJobRetention.removeOnFail,
    ...options,
  });
}

export async function enqueueAgentSessionForkJob(data: AgentSessionForkJobData, options: JobsOptions = {}) {
  return agentTurnQueue.add(AGENT_SESSION_FORK_JOB_NAME, {
    ...data,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: `agent-session-fork-${data.sessionId}-${data.anchorEntryId ?? data.anchorTurnId}`,
    attempts: 3,
    backoff: { type: "fixed", delay: 1000 },
    ...defaultJobRetention,
    ...options,
  });
}
