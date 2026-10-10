import "dotenv/config";
import "./tracing.js";
import { configureBillingRuntime } from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";


import { Worker, type Processor } from "bullmq";
import {
  resolveQueueConcurrencyPerWorkerByName,
  attachWorkerEventLogger,
  closeWorkerGracefully,
  COHUB_TASKS_QUEUE,
  createBullmqRedisConnection,
  createQueueTelemetry,
  getRedisHost,
  authenticateQueueJob,
  readQueueSigningKey,
  QueueAuthenticationError,
} from "@cohub/infra/bullmq";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { getTracer, extractTrace } from "@cohub/infra/tracing/propagator";
import { config, assertRequiredConfig } from "./config.js";
import { getTaskHandler, getRegisteredTasks, markTaskRunFailed } from "./tasks/registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });
// Auto-register all tasks
import "./tasks/index.js";

assertRequiredConfig();
configureBillingRuntime({
  config,
  redis: (await import("./redis.js")).redisCommandClient,
});

const signingKey = readQueueSigningKey();
const connection = createBullmqRedisConnection(config.bullmqRedisUrl);

const tracer = getTracer("cohub-worker");

const processor: Processor = async (job) => {
  authenticateQueueJob(job, signingKey);
  const handler = getTaskHandler(job.name);
  if (!handler) {
    throw new Error(`No handler registered for task type: ${job.name}`);
  }
  // Extract trace context from job data (if enqueued with trace propagation)
  const parentCtx = extractTrace(job.data as unknown as Record<string, unknown>);
  const span = tracer.startSpan("worker.job.process", {
    attributes: {
      "job.id": job.id ?? "",
      "job.name": job.name,
      "job.queue": job.queueName,
      "job.attempt": job.attemptsMade,
    },
  });
  return context.with(trace.setSpan(parentCtx, span), async () => {
    try {
      return await handler(job);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
};

const taskWorker = new Worker(COHUB_TASKS_QUEUE, processor, {
  connection,
  concurrency: resolveQueueConcurrencyPerWorkerByName(COHUB_TASKS_QUEUE),
  telemetry: createQueueTelemetry("cohub-worker"),
});

attachWorkerEventLogger(taskWorker, {
  serviceName: "Worker",
  queueName: COHUB_TASKS_QUEUE,
  logCompletedResult: true,
});

taskWorker.on("failed", (job, error) => {
  if (!job || error instanceof QueueAuthenticationError) return;
  void markTaskRunFailed(job, error).catch((updateError) => {
    logger.error("[Worker] failed to sync BullMQ failure to task_runs", updateError);
  });
});

logger.info("[Worker] Starting task worker...");
logger.info("[Worker] BullMQ Redis:", getRedisHost(config.bullmqRedisUrl));
logger.info("[Worker] App Redis:", getRedisHost(config.redisUrl));
logger.info("[Worker] Registered tasks:", getRegisteredTasks());

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`[Worker] Received ${signal}, shutting down...`);
  await closeWorkerGracefully(taskWorker, {
    serviceName: "Worker",
    timeoutMs: Number(process.env.TASK_WORKER_SHUTDOWN_TIMEOUT_MS ?? 30_000),
    pauseBeforeClose: true,
  });
  await connection.quit().catch(() => undefined);
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
