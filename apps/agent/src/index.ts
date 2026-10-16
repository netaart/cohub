import "./tracing.js";


import { Worker, type Job, type Processor } from "bullmq";
import {
  attachWorkerEventLogger,
  closeWorkerGracefully,
  createBullmqRedisConnection,
  createQueueTelemetry,
  authenticateQueueJob,
  readQueueSigningKey,
  QueueAuthenticationError,
} from "@cohub/infra/bullmq";
import { env } from "./env.js";
import { AGENT_SANDBOX_BASH_JOB_NAME, AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME, AGENT_RUN_COMMAND_JOB_NAME, AGENT_SESSION_FORK_JOB_NAME, AGENT_TURN_JOB_NAME, AGENT_TURN_QUEUE_NAME, AGENT_SANDBOX_FS_MUTATION_JOB_NAME, AGENT_SANDBOX_FS_INSTALL_JOB_NAME, type AgentJobData, type AgentTurnJobData, type AgentSessionForkJobData, type AgentSandboxBashUploadJobData, type AgentRunCommandJobData, type AgentSandboxFsMutationJobData, type AgentSandboxFsInstallJobData } from "./queue.js";
import { processAgentTurnJob, disposeAllSessionHandles } from "./processor.js";
import { AGENT_RUNTIME_RECOVERY_JOB_NAME, type AgentRuntimeRecoveryJobData } from "@cohub/infra/agent-queue";
import { recoverRuntime } from "./runtime/recovery.js";
import { processSessionForkJob } from "./fork.js";
import { processSandboxBashJob } from "./sandbox-bash.js";
import { processSandboxFsInstallJob } from "./sandbox-fs-install.js";
import { processSandboxFsMutationJob, redactSandboxFsMutationJobPayload } from "./sandbox-fs-mutation.js";
import { processRunCommandJob } from "./run-command.js";
import { subscribeAbortEvents, closeAbortSubscriber } from "./abort.js";
import { abortActiveTurnExecutions } from "./active-turns.js";
import { closeDb } from "./db.js";
import { closeOwnershipRedis } from "./ownership.js";
import { closeRedisConnections } from "./redis.js";
import { logger } from "./logger.js";
import { invalidateSandboxConnection, closeSandboxPool } from "./sandbox-pool.js";
import { closeSandboxLifecycleEventSubscriber, subscribeSandboxLifecycleEvents } from "./sandbox-events.js";
import { SandboxRpcError } from "@cohub/sandbox-client";

export const __test = {
  runInSessionOperation: async <T>(_handle: unknown, fn: () => Promise<T>) => fn(),
};

const signingKey = readQueueSigningKey();
const connection = createBullmqRedisConnection(env.BULLMQ_REDIS_URL);

const processor: Processor<AgentJobData> = async (job) => {
  authenticateQueueJob(job, signingKey);
  if (job.name === AGENT_RUNTIME_RECOVERY_JOB_NAME) return recoverRuntime(job.data as AgentRuntimeRecoveryJobData);
  if (job.name === AGENT_SESSION_FORK_JOB_NAME) {
    return processSessionForkJob(job as Job<AgentSessionForkJobData>);
  }
  if (job.name === AGENT_TURN_JOB_NAME) {
    return processAgentTurnJob(job as Job<AgentTurnJobData>);
  }
  if (job.name === AGENT_SANDBOX_BASH_JOB_NAME || job.name === AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME) {
    return processSandboxBashJob(job as Job<AgentSandboxBashUploadJobData>);
  }
  if (job.name === AGENT_SANDBOX_FS_MUTATION_JOB_NAME) {
    return processSandboxFsMutationJob(job as Job<AgentSandboxFsMutationJobData>);
  }
  if (job.name === AGENT_SANDBOX_FS_INSTALL_JOB_NAME) {
    return processSandboxFsInstallJob(job as Job<AgentSandboxFsInstallJobData>);
  }
  if (job.name === AGENT_RUN_COMMAND_JOB_NAME) {
    return processRunCommandJob(job as Job<AgentRunCommandJobData>);
  }
  throw new Error(`Unknown agent job: ${job.name}`);
};

const worker = new Worker<AgentJobData>(AGENT_TURN_QUEUE_NAME, processor, {
  connection,
  concurrency: env.AGENT_WORKER_CONCURRENCY,
  lockDuration: env.AGENT_JOB_LOCK_DURATION_MS,
  lockRenewTime: env.AGENT_JOB_LOCK_RENEW_TIME_MS,
  stalledInterval: env.AGENT_JOB_STALLED_INTERVAL_MS,
  maxStalledCount: env.AGENT_JOB_MAX_STALLED_COUNT,
  telemetry: createQueueTelemetry("cohub-agent"),
});

attachWorkerEventLogger(worker, {
  serviceName: "AgentWorker",
  queueName: AGENT_TURN_QUEUE_NAME,
  logCompletedResult: true,
  shouldLogCompleted: (_job, result) => {
    const skipped = result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).skipped
      : null;
    return skipped !== "session_busy";
  },
});

// Redact file content only after BullMQ has finalized the job. Redacting inside
// the processor would let a stalled retry execute with an empty payload.
const redactFinishedMutation = (job: Job<AgentJobData> | undefined) => {
  if (!job || job.name !== AGENT_SANDBOX_FS_MUTATION_JOB_NAME) return;
  void redactSandboxFsMutationJobPayload(job as Job<AgentSandboxFsMutationJobData>).catch((error) => {
    logger.warn(`[AgentWorker] failed to redact sandbox mutation payload jobId=${job.id ?? "unknown"}`, error);
  });
};
worker.on("completed", (job) => redactFinishedMutation(job));
worker.on("failed", (job, error) => {
  if (!(error instanceof QueueAuthenticationError)) redactFinishedMutation(job);
});

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

function isKnownNonFatalError(error: unknown) {
  return error instanceof SandboxRpcError || (
    error instanceof Error &&
    error.name === "SandboxRpcError" &&
    (error as { toolCallError?: unknown }).toolCallError === true
  );
}

process.on("unhandledRejection", (reason) => {
  logger.error("[AgentWorker] unhandled rejection", { reason: serializeError(reason) });
  if (isKnownNonFatalError(reason)) return;
  void shutdown("unhandledRejection", { exitCode: 1 });
});

process.on("uncaughtException", (error) => {
  logger.error("[AgentWorker] uncaught exception", { error: serializeError(error) });
  void shutdown("uncaughtException", { exitCode: 1 });
});

await subscribeAbortEvents((event) => {
  const { controllersAborted, handlesAborted } = abortActiveTurnExecutions(event);
  if (controllersAborted + handlesAborted === 0) {
    logger.debug("[AgentAbort] no local active execution", {
      spaceId: event.spaceId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      reason: event.reason,
    });
    return;
  }
  logger.info("[AgentAbort] aborted local active executions", {
    spaceId: event.spaceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    reason: event.reason,
    controllersAborted,
    handlesAborted,
  });
});

await subscribeSandboxLifecycleEvents((event) => {
  invalidateSandboxConnection(event.spaceId, `sandbox replacing: ${event.reason}`);
  logger.info("[SandboxEvents] invalidated sandbox connection", {
    spaceId: event.spaceId,
    reason: event.reason,
    generation: event.generation,
  });
}).catch((error) => {
  logger.error("[SandboxEvents] failed to subscribe; continuing without proactive sandbox invalidation", {
    error: serializeError(error),
  });
});

logger.info("[AgentWorker] Starting BullMQ agent worker...");
logger.info("[AgentWorker] Queue:", AGENT_TURN_QUEUE_NAME);
logger.info("[AgentWorker] Concurrency:", env.AGENT_WORKER_CONCURRENCY);

let shuttingDown = false;
async function shutdown(signal: string, options?: { exitCode?: number }) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[AgentWorker] Received ${signal}, draining...`);
  await closeWorkerGracefully(worker, {
    serviceName: "AgentWorker",
    timeoutMs: env.AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    pauseBeforeClose: true,
  });
  await disposeAllSessionHandles();
  closeSandboxPool();
  await closeAbortSubscriber().catch(() => undefined);
  await closeSandboxLifecycleEventSubscriber().catch(() => undefined);
  await closeOwnershipRedis().catch(() => undefined);
  await closeRedisConnections().catch(() => undefined);
  await closeDb().catch(() => undefined);
  await connection.quit().catch(() => undefined);
  process.exit(options?.exitCode ?? 0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
