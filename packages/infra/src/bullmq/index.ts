import { Queue, Worker, type JobsOptions, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";
import { BullMQOtel } from "bullmq-otel";
import { Redis, type RedisOptions } from "ioredis";
import { createLogger } from "../logging/logger.js";

export * from "./job-diagnostics.js";

const logger = createLogger({ serviceName: "cohub-infra" });
export const COHUB_TASKS_QUEUE = "cohub-tasks";
export const COHUB_AGENT_TURNS_QUEUE = "cohub-agent-turns";
export const COHUB_SYSTEM_QUEUE = "cohub-system";

export const DEFAULT_TASK_WORKER_CONCURRENCY = 5;
export const DEFAULT_SYSTEM_WORKER_CONCURRENCY = 4;
export const DEFAULT_AGENT_WORKER_CONCURRENCY = 8;

export const queueDefinitions = [
  {
    name: COHUB_TASKS_QUEUE,
    owner: "worker",
    criticality: "critical",
    concurrencyEnv: "TASK_WORKER_CONCURRENCY",
    defaultConcurrencyPerWorker: DEFAULT_TASK_WORKER_CONCURRENCY,
    registeredJobs: ["send_message", "save_checkpoint", "create_space", "run_command", "space_hook"],
  },
  {
    name: COHUB_AGENT_TURNS_QUEUE,
    owner: "agent",
    criticality: "critical",
    concurrencyEnv: "AGENT_WORKER_CONCURRENCY",
    defaultConcurrencyPerWorker: DEFAULT_AGENT_WORKER_CONCURRENCY,
    registeredJobs: ["agent_turns", "agent_session_fork", "sandbox_bash", "sandbox_bash_atomic", "run_command", "sandbox_fs_mutation"],
  },
  {
    name: COHUB_SYSTEM_QUEUE,
    owner: "system-worker",
    criticality: "normal",
    concurrencyEnv: "SYSTEM_WORKER_CONCURRENCY",
    defaultConcurrencyPerWorker: DEFAULT_SYSTEM_WORKER_CONCURRENCY,
    registeredJobs: ["workspace.usage.scan", "workspace.usage.dispatch", "cdn_cache.warm_file", "sandbox.idle_check", "sandbox.idle_reaper", "work.publish_asset", "work.view_stats.flush", "references.index", "session.message.postprocess", "session.title.generate", "space_hook.dispatch"],
  },
] as const;

export type CohubQueueName = typeof queueDefinitions[number]["name"];
export type QueueDefinition = typeof queueDefinitions[number];

export type QueueParallelism = {
  workers: number;
  configuredConcurrencyPerWorker: number;
  estimatedMaxConcurrency: number;
  source: QueueDefinition["concurrencyEnv"];
};

export const getQueueDefinition = (name: string): QueueDefinition | undefined =>
  queueDefinitions.find((definition) => definition.name === name);

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

export const resolveQueueConcurrencyPerWorker = (
  definition: QueueDefinition,
  env: Record<string, string | undefined> = process.env,
) => parsePositiveInteger(env[definition.concurrencyEnv]) ?? definition.defaultConcurrencyPerWorker;

export const resolveQueueConcurrencyPerWorkerByName = (
  queueName: string,
  env?: Record<string, string | undefined>,
) => {
  const definition = getQueueDefinition(queueName);
  if (!definition) throw new Error(`Unknown BullMQ queue: ${queueName}`);
  return resolveQueueConcurrencyPerWorker(definition, env);
};

export const getQueueParallelism = (
  definition: QueueDefinition,
  workers: number,
  env?: Record<string, string | undefined>,
): QueueParallelism => {
  const configuredConcurrencyPerWorker = resolveQueueConcurrencyPerWorker(definition, env);
  return {
    workers,
    configuredConcurrencyPerWorker,
    estimatedMaxConcurrency: workers * configuredConcurrencyPerWorker,
    source: definition.concurrencyEnv,
  };
};

export const defaultJobRetention = {
  removeOnComplete: { age: 24 * 3600, count: 100 },
  removeOnFail: { age: 3 * 24 * 3600, count: 100 },
} satisfies Pick<JobsOptions, "removeOnComplete" | "removeOnFail">;

export const defaultCriticalJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  ...defaultJobRetention,
} satisfies JobsOptions;

export const createQueueTelemetry = (serviceName: string) =>
  new BullMQOtel({ tracerName: serviceName });

export const createBullmqConnectionOptions = (url: string) => ({ url, disableClientInfo: true });

export const createBullmqRedisConnection = (url: string, options: RedisOptions = {}) =>
  new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...options,
    disableClientInfo: true,
  });

export function createBullmqQueue<DataType = unknown, ResultType = unknown, NameType extends string = string>(
  queueName: string,
  options: Omit<QueueOptions, "connection" | "telemetry"> & {
    redisUrl: string;
    telemetryServiceName: string;
  },
) {
  const { redisUrl, telemetryServiceName, ...queueOptions } = options;
  return new Queue<DataType, ResultType, NameType>(queueName, {
    ...queueOptions,
    connection: createBullmqConnectionOptions(redisUrl),
    telemetry: createQueueTelemetry(telemetryServiceName),
  });
}

export function createBullmqWorker<DataType = unknown, ResultType = unknown, NameType extends string = string>(
  queueName: string,
  processor: Processor<DataType, ResultType, NameType>,
  options: Omit<WorkerOptions, "connection" | "telemetry"> & {
    redisUrl: string;
    telemetryServiceName: string;
  },
) {
  const { redisUrl, telemetryServiceName, ...workerOptions } = options;
  const connection = createBullmqRedisConnection(redisUrl);
  const worker = new Worker<DataType, ResultType, NameType>(queueName, processor, {
    ...workerOptions,
    connection,
    telemetry: createQueueTelemetry(telemetryServiceName),
  });
  return { worker, connection };
}

export type WorkerLoggerOptions = {
  serviceName: string;
  queueName: string;
  logCompletedResult?: boolean;
  shouldLogCompleted?: (job: { id?: string; name?: string; attemptsMade?: number } | undefined, result: unknown) => boolean;
};

const formatJob = (job: { id?: string; name?: string; attemptsMade?: number } | undefined) =>
  `jobId=${job?.id ?? "unknown"} jobName=${job?.name ?? "unknown"} attemptsMade=${job?.attemptsMade ?? 0}`;

export const attachWorkerEventLogger = (worker: Worker, options: WorkerLoggerOptions) => {
  const prefix = `[${options.serviceName}]`;
  const queue = `queue=${options.queueName}`;

  worker.on("active", (job) => {
    logger.info(`${prefix} bullmq.job.active ${queue} ${formatJob(job)}`);
  });

  worker.on("completed", (job, result) => {
    if (options.shouldLogCompleted && !options.shouldLogCompleted(job, result)) return;
    const suffix = options.logCompletedResult ? ` result=${safeJson(redactSensitiveData(result))}` : "";
    logger.info(`${prefix} bullmq.job.completed ${queue} ${formatJob(job)}${suffix}`);
  });

  worker.on("failed", (job, error) => {
    logger.error(`${prefix} bullmq.job.failed ${queue} ${formatJob(job)} error=${safeJson(redactSensitiveData(error))}`);
  });

  worker.on("stalled", (jobId) => {
    logger.error(`${prefix} bullmq.job.stalled ${queue} jobId=${jobId}`);
  });

  worker.on("drained", () => {
    logger.info(`${prefix} bullmq.queue.drained ${queue}`);
  });

  worker.on("paused", () => {
    logger.info(`${prefix} bullmq.worker.paused ${queue}`);
  });

  worker.on("resumed", () => {
    logger.info(`${prefix} bullmq.worker.resumed ${queue}`);
  });

  worker.on("error", (error) => {
    logger.error(`${prefix} bullmq.worker.error ${queue} error=${safeJson(redactSensitiveData(error))}`);
  });
};

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify("[unserializable]");
  }
};

export type CloseWorkerGracefullyOptions = {
  serviceName: string;
  timeoutMs: number;
  pauseBeforeClose?: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const closeWorkerGracefully = async (worker: Worker, options: CloseWorkerGracefullyOptions) => {
  if (options.pauseBeforeClose) {
    await worker.pause(true).catch((error: unknown) => {
      logger.error(`[${options.serviceName}] Failed to pause worker before shutdown:`, error);
    });
  }

  const closed = await Promise.race([
    worker.close()
      .then(() => true)
      .catch((error: unknown) => {
        logger.error(`[${options.serviceName}] Failed to close worker gracefully:`, safeJson(redactSensitiveData(error)));
        return false;
      }),
    sleep(options.timeoutMs).then(() => false),
  ]);

  if (!closed) {
    logger.warn(`[${options.serviceName}] Worker did not close within ${options.timeoutMs}ms, forcing close...`);
    await worker.close(true).catch((error: unknown) => {
      logger.error(`[${options.serviceName}] Failed to force-close worker:`, error);
    });
  }
};

export type QueueSnapshot = {
  name: string;
  counts: Awaited<ReturnType<Queue["getJobCounts"]>>;
  isPaused: boolean;
  workers: number;
  oldestWaitingJobAgeMs: number | null;
  parallelism: QueueParallelism | null;
  registeredJobs: readonly string[];
};

export type QueueSnapshotOptions = {
  redisUrl?: string;
};

const getRedisDbIndex = (redisUrl: string | undefined): string | null => {
  if (!redisUrl) return null;
  try {
    const url = new URL(redisUrl);
    return url.pathname.replace(/^\//, "") || "0";
  } catch {
    return null;
  }
};

const getWorkerCount = async (queue: Queue, options: QueueSnapshotOptions = {}) => {
  const redisDb = getRedisDbIndex(options.redisUrl);
  const workers = await queue.getWorkers();
  return redisDb ? workers.filter((worker) => worker.db === redisDb).length : workers.length;
};

export const getQueueSnapshot = async (queue: Queue, options: QueueSnapshotOptions = {}): Promise<QueueSnapshot> => {
  const [counts, isPaused, workers, waitingJobs] = await Promise.all([
    queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "prioritized", "waiting-children"),
    queue.isPaused(),
    getWorkerCount(queue, options).catch(() => 0),
    queue.getJobs(["waiting"], 0, 0, true),
  ]);

  const oldestWaitingJob = waitingJobs[0];
  const definition = getQueueDefinition(queue.name);
  return {
    name: queue.name,
    counts,
    isPaused,
    workers,
    oldestWaitingJobAgeMs: oldestWaitingJob ? Date.now() - oldestWaitingJob.timestamp : null,
    parallelism: definition ? getQueueParallelism(definition, workers) : null,
    registeredJobs: definition?.registeredJobs ?? [],
  };
};

export const getQueueSnapshots = async (queues: Queue[], options: QueueSnapshotOptions = {}) =>
  Promise.all(queues.map((queue) => getQueueSnapshot(queue, options)));

export type ExportQueuesPrometheusMetricsOptions = {
  includeQueueDefinitionLabels?: boolean;
};

const PROMETHEUS_HEADER_PATTERN = /^# (HELP|TYPE) bullmq_job_count /;

export const exportQueuesPrometheusMetrics = async (
  queues: Queue[],
  options: ExportQueuesPrometheusMetricsOptions = {},
) => {
  const chunks = await Promise.all(
    queues.map(async (queue, index) => {
      const definition = getQueueDefinition(queue.name);
      const labels = options.includeQueueDefinitionLabels && definition
        ? { owner: definition.owner, criticality: definition.criticality }
        : undefined;
      const metrics = await queue.exportPrometheusMetrics(labels);
      return index === 0
        ? metrics
        : metrics.split("\n").filter((line) => !PROMETHEUS_HEADER_PATTERN.test(line)).join("\n");
    }),
  );

  return `${chunks.join("\n")}\n`;
};

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|api[-_]?key|access[-_]?key|credential|executionAuth)/i;

const redactSensitiveDataInternal = (value: unknown, seen: WeakSet<object>): unknown => {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveDataInternal(item, seen));
  if (!value || typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    return redactSensitiveDataInternal({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
    }, seen);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitiveDataInternal(nestedValue, seen),
    ]),
  );
};

export const redactSensitiveData = (value: unknown): unknown => redactSensitiveDataInternal(value, new WeakSet());

export const getRedisHost = (value: string) => {
  try {
    return new URL(value).host;
  } catch {
    return "(invalid URL)";
  }
};
