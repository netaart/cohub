import type { Job, Queue } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { spaceSandboxes, spaces, spaceWorkspaceUsage } from "@cohub/db";
import { attachWorkerEventLogger, closeWorkerGracefully, createBullmqQueue, createBullmqWorker, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  isSandboxIdleForWorkspaceUsage,
  isUuidLike,
  toWorkspaceUsage,
  WORKSPACE_USAGE_QUEUE,
  WORKSPACE_USAGE_SWEEP_JOB,
  WORKSPACE_USAGE_UPDATED_EVENT,
} from "@cohub/protocol";
import { config } from "../../../config.js";
import { db } from "../../../db.js";
import { publishSpaceEvent } from "../../../space-events.js";
import { registerSystemJob } from "../../registry.js";
import { isPduAvailable, pduBinary, runPdu } from "./pdu.js";
import { findDueWorkspaces, PDU_THREADS, resolveWorkspacePath, SCAN_TIMEOUT_MS, SWEEP_BATCH } from "./policy.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_SCHEDULER_ID = "workspace-usage-sweep";
const SCAN_JOB = "workspace_usage.scan";

type ScanJobData = { spaceId: string };

let queue: ReturnType<typeof createBullmqQueue<ScanJobData>> | null = null;
export function getWorkspaceUsageQueue() {
  queue ??= createBullmqQueue<ScanJobData>(WORKSPACE_USAGE_QUEUE, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: "cohub-workspace-usage",
  });
  return queue;
}

registerSystemJob(WORKSPACE_USAGE_SWEEP_JOB, async () => {
  const scanQueue = getWorkspaceUsageQueue();
  const backlog = await scanQueue.getWaitingCount();
  if (backlog >= SWEEP_BATCH) return { backlog, enqueued: 0 };
  const ids = await findDueWorkspaces(db, SWEEP_BATCH - backlog);
  for (const spaceId of ids) {
    await scanQueue.add(SCAN_JOB, { spaceId }, {
      deduplication: { id: `workspace-usage-${spaceId}` },
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 100 },
      removeOnFail: { age: 3 * 24 * 3600, count: 100 },
    });
  }
  return { backlog, enqueued: ids.length };
});

async function loadState(spaceId: string) {
  const [row] = await db.select({ sandbox: spaceSandboxes, usage: spaceWorkspaceUsage }).from(spaces)
    .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
    .leftJoin(spaceWorkspaceUsage, eq(spaceWorkspaceUsage.spaceId, spaces.id))
    .where(eq(spaces.id, spaceId)).limit(1);
  return row;
}

export async function processWorkspaceUsageScan(job: Job<ScanJobData>) {
  const spaceId = job.data?.spaceId;
  if (!isUuidLike(spaceId)) throw new Error("workspace usage scan requires a valid spaceId");
  const state = await loadState(spaceId);
  if (!state) return { skipped: "deleted" };
  if (state.sandbox?.provider === "local") return { skipped: "local" };
  if (!isSandboxIdleForWorkspaceUsage(state.sandbox?.status)) return { skipped: "running" };

  // measuredAt is the scan start, so anything that changes during the scan is
  // newer than the measurement and keeps the workspace due.
  const startedAt = new Date();
  await db.insert(spaceWorkspaceUsage).values({ spaceId, attemptedAt: startedAt, updatedAt: startedAt })
    .onConflictDoUpdate({ target: spaceWorkspaceUsage.spaceId, set: { attemptedAt: startedAt, updatedAt: startedAt } });
  const owned = and(eq(spaceWorkspaceUsage.spaceId, spaceId), eq(spaceWorkspaceUsage.attemptedAt, startedAt));

  let result: Record<string, unknown>;
  try {
    const bytes = await runPdu({
      path: await resolveWorkspacePath(config.spaceStorageRoot, spaceId),
      threads: PDU_THREADS,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    await db.update(spaceWorkspaceUsage)
      .set({ bytes, measuredAt: startedAt, failures: 0, error: null, updatedAt: new Date() })
      .where(owned);
    result = { spaceId, bytes, durationMs: Date.now() - startedAt.getTime() };
  } catch (error) {
    // The last complete measurement stays; the sweep retries with backoff.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await db.update(spaceWorkspaceUsage)
      .set({ failures: sql`${spaceWorkspaceUsage.failures} + 1`, error: message, updatedAt: new Date() })
      .where(owned);
    logger.warn(`[WorkspaceUsage] scan failed spaceId=${spaceId}: ${message}`);
    result = { spaceId, error: message };
  }

  const latest = await loadState(spaceId);
  if (latest) {
    await publishSpaceEvent({
      type: WORKSPACE_USAGE_UPDATED_EVENT,
      spaceId,
      payload: { workspaceUsage: toWorkspaceUsage(latest.usage, latest.sandbox) },
    }).catch((error) => logger.warn(`[WorkspaceUsage] publish failed spaceId=${spaceId}`, error));
  }
  return result;
}

/**
 * Starts the scan consumer and the sweep schedule. Deployments without the
 * pinned pdu binary (e.g. non-amd64 images) skip the feature instead of
 * recording failures for every workspace.
 */
export async function startWorkspaceUsage(systemQueue: Queue) {
  if (!config.spaceStorageRoot || !await isPduAvailable()) {
    logger.warn(`[WorkspaceUsage] disabled: ${config.spaceStorageRoot ? `pdu ${pduBinary()} unavailable` : "SPACE_STORAGE_ROOT unset"}`);
    await systemQueue.removeJobScheduler(SWEEP_SCHEDULER_ID).catch(() => undefined);
    return async () => undefined;
  }
  await getWorkspaceUsageQueue().setGlobalConcurrency(1);
  const { worker, connection } = createBullmqWorker<ScanJobData>(WORKSPACE_USAGE_QUEUE, processWorkspaceUsageScan, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: "cohub-workspace-usage",
    concurrency: 1,
  });
  attachWorkerEventLogger(worker, { serviceName: "WorkspaceUsage", queueName: WORKSPACE_USAGE_QUEUE });
  await systemQueue.upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_INTERVAL_MS }, {
    name: WORKSPACE_USAGE_SWEEP_JOB,
    data: {},
    opts: { attempts: 1, ...defaultJobRetention },
  });
  logger.info("[WorkspaceUsage] started", { threads: PDU_THREADS, timeoutMs: SCAN_TIMEOUT_MS });
  return async () => {
    await closeWorkerGracefully(worker, { serviceName: "WorkspaceUsage", timeoutMs: 10_000 });
    await queue?.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  };
}
