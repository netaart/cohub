import { randomUUID } from "node:crypto";
import { asc, eq, gt } from "drizzle-orm";
import { DelayedError, type Job } from "bullmq";
import { spaceSandboxes, spaces } from "@cohub/db";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import { RECONCILE_USAGE_SCRIPT, reconcileUsageArgs, usageKey, usageDueKey, usagePrefix, parseWorkspaceUsage } from "@cohub/infra/workspace-usage";
import { WORKSPACE_USAGE_DISPATCH_JOB, WORKSPACE_USAGE_SCAN_JOB, WORKSPACE_USAGE_UPDATED_EVENT } from "@cohub/protocol";
import { config } from "../../../config.js";
import { db } from "../../../db.js";
import { redisCommandClient as redis } from "../../../redis.js";
import { publishSpaceEvent } from "../../../space-events.js";
import { registerSystemJob } from "../../registry.js";
import { usagePolicy } from "./policy.js";
import { resolveWorkspaceScanPath, scanWorkspaceUsage } from "./pdu.js";
import { CLAIM_SCAN, RENEW_SCAN, FINISH_SCAN, RESERVE_DUE } from "./scripts.js";

const queue = createBullmqQueue(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl, telemetryServiceName: "cohub-workspace-usage",
});
const prefix = usagePrefix(config.env);
const dueKey = usageDueKey(config.env);
const slotsKey = `${prefix}:slots`;
const pendingKey = `${prefix}:pending`;
const cursorKey = `${prefix}:cursor`;
const leaseMs = 90_000;

async function reconcileSpace(spaceId: string, minScanIntervalMs: number) {
  const [row] = await db.select({ id: spaces.id, sandbox: spaceSandboxes }).from(spaces)
    .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id)).where(eq(spaces.id, spaceId)).limit(1);
  if (!row) {
    await redis.del(usageKey(config.env, spaceId));
    await redis.zrem(dueKey, spaceId);
    return false;
  }
  await redis.eval(RECONCILE_USAGE_SCRIPT, 2, ...reconcileUsageArgs(config.env, spaceId, row.sandbox, minScanIntervalMs));
  return row.sandbox?.provider !== "local";
}

registerSystemJob(WORKSPACE_USAGE_DISPATCH_JOB, async () => {
  const policy = usagePolicy();
  if (!policy.enabled) return { skipped: "disabled" };
  // This bounded inventory repairs missing/evicted Redis records without touching NAS.
  // Cursor is only a hint: repeating a page after a crash is safe.
  const cursor = await redis.get(cursorKey);
  const page = await db.select({ id: spaces.id, sandbox: spaceSandboxes }).from(spaces)
    .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
    .where(cursor ? gt(spaces.id, cursor) : undefined).orderBy(asc(spaces.id)).limit(200);
  const pipeline = redis.pipeline();
  for (const row of page) pipeline.eval(RECONCILE_USAGE_SCRIPT, 2, ...reconcileUsageArgs(config.env, row.id, row.sandbox, policy.minScanIntervalMs));
  const results = await pipeline.exec();
  for (const result of results ?? []) if (result[0]) throw result[0];
  const lastId = page.at(-1)?.id;
  if (page.length < 200 || !lastId) await redis.del(cursorKey);
  else await redis.set(cursorKey, lastId);

  const ids = await redis.eval(RESERVE_DUE, 2, dueKey, pendingKey, Date.now(), policy.batchSize) as string[];
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
  const policy = usagePolicy();
  if (!policy.enabled) return { skipped: "disabled" };
  const spaceId = job.data?.spaceId;
  if (!spaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spaceId)) throw new Error("Invalid space ID / Space ID 无效");
  await redis.zadd(pendingKey, Date.now() + 600_000, spaceId);
  if (!await reconcileSpace(spaceId, policy.minScanIntervalMs)) return { skipped: "local_or_deleted" };
  const key = usageKey(config.env, spaceId);
  const state = await redis.hgetall(key);
  if (state.dirty === "0" && state.running !== "1" && state.bytes !== undefined) return { skipped: "unchanged" };
  const path = await resolveWorkspaceScanPath(config.spaceStorageRoot, spaceId);
  const token = randomUUID();
  const claim = await redis.eval(CLAIM_SCAN, 3, key, dueKey, slotsKey,
    spaceId, token, Date.now(), leaseMs, policy.concurrency, policy.minScanIntervalMs) as [string, string?] | null;
  if (claim?.[0] === "cooldown") return { skipped: "cooldown" };
  if (claim?.[0] !== "claimed" || !claim[1]) {
    // Release this ordinary system task's worker slot while the NAS is busy.
    if (!job.token) throw new Error("Missing job token / 任务令牌缺失");
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
      const ok = await redis.eval(RENEW_SCAN, 2, key, slotsKey, token, Date.now() + leaseMs, Date.now());
      if (ok !== 1) abort.abort();
      else renewedAt = Date.now();
      await redis.zadd(pendingKey, Date.now() + 600_000, spaceId);
    } catch { abort.abort(); } finally { renewing = false; }
  }, 15_000);
  heartbeat.unref();
  try {
    const bytes = await scanWorkspaceUsage({ path, threads: policy.threads, timeoutMs: policy.timeoutMs, signal: abort.signal });
    if (!await reconcileSpace(spaceId, policy.minScanIntervalMs)) return { skipped: "local_or_deleted" };
    if (abort.signal.aborted) throw new Error("Scan lease lost / 扫描租约失效");
    const committed = await redis.eval(FINISH_SCAN, 3, key, dueKey, slotsKey,
      spaceId, token, revision, Date.now(), bytes, "", policy.minScanIntervalMs, 300_000);
    if (committed !== 1) throw new Error("Scan lease lost / 扫描租约失效");
    const usage = parseWorkspaceUsage(await redis.hgetall(key));
    await publishSpaceEvent({ type: WORKSPACE_USAGE_UPDATED_EVENT, spaceId, payload: { workspaceUsage: usage } })
      .catch((error) => console.error("Workspace usage event failed / 空间统计事件发送失败", error));
    return { spaceId, ...usage };
  } catch (error) {
    // A partial result must never replace the last complete measurement.
    await redis.eval(FINISH_SCAN, 3, key, dueKey, slotsKey,
      spaceId, token, revision, Date.now(), "", "scan_failed", policy.minScanIntervalMs, 300_000).catch(() => undefined);
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
