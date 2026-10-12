import { randomUUID } from "node:crypto";
import { asc, eq, gt } from "drizzle-orm";
import { DelayedError, type Job } from "bullmq";
import { spaceSandboxes, spaces } from "@cohub/db";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  RECONCILE_USAGE_SCRIPT,
  USAGE_CLEAN_RECALIBRATION_MS,
  USAGE_MIN_SCAN_INTERVAL_MS,
  USAGE_QUIET_MS,
  parseWorkspaceUsage,
  reconcileUsageArgs,
  usageDueKey,
  usageKey,
  usagePrefix,
} from "@cohub/infra/workspace-usage";
import { isUuidLike, WORKSPACE_USAGE_DISPATCH_JOB, WORKSPACE_USAGE_SCAN_JOB, WORKSPACE_USAGE_UPDATED_EVENT } from "@cohub/protocol";
import { config } from "../../../config.js";
import { db } from "../../../db.js";
import { redisCommandClient as redis } from "../../../redis.js";
import { publishSpaceEvent } from "../../../space-events.js";
import { registerSystemJob } from "../../registry.js";
import { resolveWorkspaceScanPath, scanWorkspaceUsage } from "./pdu.js";
import { CLAIM_SCAN, RENEW_SCAN, FINISH_SCAN, RESERVE_DUE } from "./scripts.js";

const logger = createLogger({ serviceName: "cohub-worker" });

// Fixed NAS protection policy, documented in docs/workspace-usage.md.
const SCAN_SLOTS = 1;
const PDU_THREADS = 1;
const SCAN_TIMEOUT_MS = 5 * 60_000;
// Reserved scans beyond the free slots only wait for one, so the window stays small.
const DISPATCH_BATCH = 4;
const INVENTORY_PAGE = 200;
const LEASE_MS = 90_000;
// A reserved scan that never ran is reserved again after REDISPATCH_MS and
// stops counting against the batch after PENDING_TTL_MS.
const PENDING_TTL_MS = 10 * 60_000;
const REDISPATCH_MS = 5 * 60_000;

const queue = createBullmqQueue(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl, telemetryServiceName: "cohub-workspace-usage",
});
const prefix = usagePrefix(config.env);
const dueKey = usageDueKey(config.env);
const slotsKey = `${prefix}:slots`;
const pendingKey = `${prefix}:pending`;
const cursorKey = `${prefix}:cursor`;

/**
 * Records a failed or abandoned scan attempt: the last complete measurement
 * stays, dirty stays set, and the next attempt waits for the backoff and the
 * minimum interval instead of retrying every dispatch.
 */
export async function recordScanFailure(input: { key: string; dueKey: string; slotsKey: string; spaceId: string; token: string; revision: string }) {
  return redis.eval(FINISH_SCAN, 3, input.key, input.dueKey, input.slotsKey,
    input.spaceId, input.token, input.revision, Date.now(), "", "scan_failed", USAGE_MIN_SCAN_INTERVAL_MS, USAGE_QUIET_MS);
}

async function reconcileSpace(spaceId: string) {
  const [row] = await db.select({ id: spaces.id, sandbox: spaceSandboxes }).from(spaces)
    .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id)).where(eq(spaces.id, spaceId)).limit(1);
  if (!row) {
    await redis.del(usageKey(config.env, spaceId));
    await redis.zrem(dueKey, spaceId);
    return false;
  }
  await redis.eval(RECONCILE_USAGE_SCRIPT, 2, ...reconcileUsageArgs(config.env, spaceId, row.sandbox));
  return row.sandbox?.provider !== "local";
}

registerSystemJob(WORKSPACE_USAGE_DISPATCH_JOB, async () => {
  // This bounded inventory repairs missing/evicted Redis records without touching NAS.
  // Cursor is only a hint: repeating a page after a crash is safe.
  const cursor = await redis.get(cursorKey);
  const page = await db.select({ id: spaces.id, sandbox: spaceSandboxes }).from(spaces)
    .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
    .where(cursor ? gt(spaces.id, cursor) : undefined).orderBy(asc(spaces.id)).limit(INVENTORY_PAGE);
  const pipeline = redis.pipeline();
  for (const row of page) pipeline.eval(RECONCILE_USAGE_SCRIPT, 2, ...reconcileUsageArgs(config.env, row.id, row.sandbox));
  const results = await pipeline.exec();
  for (const result of results ?? []) if (result[0]) throw result[0];
  const lastId = page.at(-1)?.id;
  if (page.length < INVENTORY_PAGE || !lastId) await redis.del(cursorKey);
  else await redis.set(cursorKey, lastId);

  const ids = await redis.eval(RESERVE_DUE, 2, dueKey, pendingKey, Date.now(), DISPATCH_BATCH, PENDING_TTL_MS, REDISPATCH_MS) as string[];
  for (const spaceId of ids) {
    // Simple deduplication lasts through waiting/active/delayed; the due set is
    // retained so enqueue failures and Redis/worker restarts are recoverable.
    await queue.add(WORKSPACE_USAGE_SCAN_JOB, { spaceId }, {
      deduplication: { id: `workspace-usage-${spaceId}` },
      removeOnComplete: true,
      removeOnFail: { age: 3 * 24 * 3600, count: 100 },
      attempts: 1,
    });
  }
  return { inventoried: page.length, enqueued: ids.length };
});

async function processUsageScan(job: Job<{ spaceId: string }>) {
  const spaceId = job.data?.spaceId;
  if (!isUuidLike(spaceId)) throw new Error("workspace usage scan job has no valid spaceId");
  await redis.zadd(pendingKey, Date.now() + PENDING_TTL_MS, spaceId);
  if (!await reconcileSpace(spaceId)) return { skipped: "local_or_deleted" };
  const key = usageKey(config.env, spaceId);
  const state = await redis.hgetall(key);
  const lastScanAt = Number(state.lastScanAt ?? state.measuredAt ?? 0);
  if (state.dirty === "0" && state.running !== "1" && state.bytes !== undefined && Date.now() < lastScanAt + USAGE_CLEAN_RECALIBRATION_MS) {
    return { skipped: "unchanged" };
  }
  const token = randomUUID();
  const claim = await redis.eval(CLAIM_SCAN, 3, key, dueKey, slotsKey,
    spaceId, token, Date.now(), LEASE_MS, SCAN_SLOTS, USAGE_MIN_SCAN_INTERVAL_MS) as [string, string?] | null;
  if (claim?.[0] === "cooldown") return { skipped: "cooldown" };
  if (claim?.[0] !== "claimed" || !claim[1]) {
    // Release this ordinary system task's worker slot while the NAS is busy.
    if (!job.token) throw new Error("workspace usage scan job has no token");
    await job.moveToDelayed(Date.now() + 30_000 + Math.floor(Math.random() * 15_000), job.token);
    throw new DelayedError();
  }
  const revision = claim[1];
  const abort = new AbortController();
  let renewing = false;
  let renewedAt = Date.now();
  const heartbeat = setInterval(async () => {
    if (Date.now() - renewedAt > 45_000) abort.abort();
    if (renewing || abort.signal.aborted) return;
    renewing = true;
    try {
      const ok = await redis.eval(RENEW_SCAN, 2, key, slotsKey, token, Date.now() + LEASE_MS, Date.now());
      if (ok !== 1) abort.abort();
      else renewedAt = Date.now();
      await redis.zadd(pendingKey, Date.now() + PENDING_TTL_MS, spaceId);
    } catch { abort.abort(); } finally { renewing = false; }
  }, 15_000);
  heartbeat.unref();
  try {
    // Resolved under the claim so a missing workspace backs off like a failed scan.
    const path = await resolveWorkspaceScanPath(config.spaceStorageRoot, spaceId);
    const bytes = await scanWorkspaceUsage({ path, threads: PDU_THREADS, timeoutMs: SCAN_TIMEOUT_MS, signal: abort.signal });
    if (!await reconcileSpace(spaceId)) return { skipped: "local_or_deleted" };
    if (abort.signal.aborted) throw new Error("workspace scan lease lost");
    const committed = await redis.eval(FINISH_SCAN, 3, key, dueKey, slotsKey,
      spaceId, token, revision, Date.now(), bytes, "", USAGE_MIN_SCAN_INTERVAL_MS, USAGE_QUIET_MS);
    if (committed !== 1) throw new Error("workspace scan lease lost");
    const usage = parseWorkspaceUsage(await redis.hgetall(key));
    await publishSpaceEvent({ type: WORKSPACE_USAGE_UPDATED_EVENT, spaceId, payload: { workspaceUsage: usage } })
      .catch((error) => logger.warn(`[WorkspaceUsage] failed to publish usage update spaceId=${spaceId}`, error));
    return { spaceId, ...usage };
  } catch (error) {
    // A partial result must never replace the last complete measurement.
    await recordScanFailure({ key, dueKey, slotsKey, spaceId, token, revision }).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
    await redis.zrem(slotsKey, token).catch(() => undefined);
  }
}

registerSystemJob(WORKSPACE_USAGE_SCAN_JOB, async (job: Job<{ spaceId: string }>) => {
  let delayed = false;
  try {
    return await processUsageScan(job);
  } catch (error) {
    delayed = error instanceof DelayedError;
    throw error;
  } finally {
    if (!delayed && job.data?.spaceId) await redis.zrem(pendingKey, job.data.spaceId).catch(() => undefined);
  }
});
