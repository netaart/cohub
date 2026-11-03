import type { Job, Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { spaceSandboxes, spaces, spaceWorkspaceUsage } from "@cohub/db";
import { attachWorkerEventLogger, closeWorkerGracefully, createBullmqQueue, createBullmqWorker, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  isUuidLike,
  toWorkspaceUsage,
  WORKSPACE_USAGE_QUEUE,
  WORKSPACE_USAGE_SWEEP_JOB,
  WORKSPACE_USAGE_UPDATED_EVENT,
} from "@cohub/protocol";
import { config } from "../../../config.js";
import { db } from "../../../db.js";
import { redisCommandClient } from "../../../redis.js";
import { publishSpaceEvent } from "../../../space-events.js";
import { registerSystemJob } from "../../registry.js";
import { isPduAvailable, pduBinary, runPdu } from "./pdu.js";
import { acquireScanLock } from "./scan-lock.js";
import { claimScan, findDueWorkspaces, finishScan, PDU_THREADS, resolveWorkspacePath, SCAN_CONCURRENCY, SCAN_LEASE_MS, SCAN_TIMEOUT_MS, SWEEP_BATCH, withDeadline } from "./policy.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const SWEEP_INTERVAL_MS = 60_000;
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
  // Prioritized jobs are not counted as waiting by BullMQ.
  const backlog = await scanQueue.getJobCountByTypes("waiting", "prioritized");
  const { candidates, due } = await findDueWorkspaces(db, SWEEP_BATCH);
  // Already-queued spaces are deduplicated and keep their first priority.
  const batch = candidates.slice(0, Math.max(0, SWEEP_BATCH - backlog));
  for (const { spaceId, priority } of batch) {
    await scanQueue.add(SCAN_JOB, { spaceId }, {
      priority,
      deduplication: { id: `workspace-usage-${spaceId}` },
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 100 },
      removeOnFail: { age: 3 * 24 * 3600, count: 100 },
    });
  }
  logger.info(`[WorkspaceUsage] sweep due=${due} waiting=${backlog} offered=${batch.length}`);
  return { due, waiting: backlog, offered: batch.length };
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
  // Fixed before the lock request: a delayed OK must not restart the budget.
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  const lock = await acquireScanLock(redisCommandClient, SCAN_LEASE_MS, SCAN_CONCURRENCY);
  if (!lock) return { skipped: "busy" };
  try {
    return await scanWorkspace(spaceId, deadline);
  } finally {
    await lock.release();
  }
}

async function scanWorkspace(spaceId: string, deadline: number) {
  // Same rule as the sweep: state may have changed since enqueue, or a
  // replacement execution may already have scanned it.
  const [due] = (await findDueWorkspaces(db, 1, spaceId)).candidates;
  if (!due) return { skipped: "not_due" };

  // measuredAt is the claim time, so anything that changes during the scan is
  // newer than the measurement and keeps the workspace due.
  // An execution whose deadline passed (e.g. a delayed lock reply) must not
  // claim: the space may already belong to its replacement.
  if (Date.now() >= deadline - 1000) return { skipped: "expired" };
  // Fenced on the attempt the due check saw, so nothing can start in between.
  const attemptedAt = await claimScan(db, spaceId, due.attemptedAt, SCAN_LEASE_MS);
  if (!attemptedAt) return { skipped: "claimed_elsewhere" };
  let result: Record<string, unknown>;
  try {
    const path = await withDeadline(resolveWorkspacePath(config.spaceStorageRoot, spaceId), deadline);
    const bytes = await runPdu({ path, threads: PDU_THREADS, deadline });
    const owned = await finishScan(db, spaceId, attemptedAt, { bytes });
    result = { spaceId, bytes, owned, priority: due.priority, durationMs: Date.now() - attemptedAt.getTime() };
  } catch (error) {
    // The last complete measurement stays; the sweep retries with backoff.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const owned = await finishScan(db, spaceId, attemptedAt, { error: message });
    logger.warn(`[WorkspaceUsage] scan failed spaceId=${spaceId}: ${message}`);
    result = { spaceId, error: message, owned };
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
 * Starts the scan consumer and the sweep schedule. Workers without the pinned
 * pdu binary (e.g. non-amd64 images) only skip consuming scans; they leave the
 * shared schedule alone so pdu-capable workers in the same deployment keep it.
 */
export async function startWorkspaceUsage(systemQueue: Queue) {
  if (!config.spaceStorageRoot || !await isPduAvailable()) {
    logger.warn(`[WorkspaceUsage] disabled: ${config.spaceStorageRoot ? `pdu ${pduBinary()} unavailable` : "SPACE_STORAGE_ROOT unset"}`);
    return async () => undefined;
  }
  await getWorkspaceUsageQueue().setGlobalConcurrency(SCAN_CONCURRENCY);
  const { worker, connection } = createBullmqWorker<ScanJobData>(WORKSPACE_USAGE_QUEUE, processWorkspaceUsageScan, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: "cohub-workspace-usage",
    concurrency: SCAN_CONCURRENCY,
  });
  attachWorkerEventLogger(worker, { serviceName: "WorkspaceUsage", queueName: WORKSPACE_USAGE_QUEUE });
  await systemQueue.upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_INTERVAL_MS }, {
    name: WORKSPACE_USAGE_SWEEP_JOB,
    data: {},
    opts: { attempts: 1, ...defaultJobRetention },
  });
  logger.info("[WorkspaceUsage] started", { concurrency: SCAN_CONCURRENCY, threads: PDU_THREADS, timeoutMs: SCAN_TIMEOUT_MS });
  return async () => {
    await closeWorkerGracefully(worker, { serviceName: "WorkspaceUsage", timeoutMs: 10_000 });
    await queue?.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  };
}
