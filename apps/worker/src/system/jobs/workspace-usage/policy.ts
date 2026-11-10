import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { spaceSandboxes, spaces, spaceWorkspaceUsage } from "@cohub/db";

type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// NAS protection: at most two scans at a time across all workers. Scans wait on
// NFS round trips (≈5% CPU), so 16 threads ran ≈3.5x faster than 4 in prod.
export const SCAN_CONCURRENCY = 2;
export const PDU_THREADS = 16;
export const SCAN_TIMEOUT_MS = 40 * 60_000;
// An unfinished attempt is exclusive for this long. It outlives the hard scan
// deadline, so a paused or dead holder's pdu cannot still be running after it.
export const SCAN_LEASE_MS = SCAN_TIMEOUT_MS + 2 * 60_000;
// Stopped workspaces are measured once writes settle. Running ones are re-measured
// after agent activity, plus a slow safety pass for writers that record none.
export const QUIET_MS = 2 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const IDLE_INTERVAL_MS = 2 * 60 * 60_000;
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;
// Short on purpose: dedup keeps a queued job's priority, so a long queue would
// delay a newly urgent space behind lower-priority scans.
export const SWEEP_BATCH = 5;

/** BullMQ priorities (lower runs first). */
export const SCAN_PRIORITY = { stopped: 1, active: 5, idle: 10 } as const;

const ms = (value: number) => sql.raw(`interval '${value} milliseconds'`);

// Claims clear `error`; success sets measuredAt to the attempt, failure sets error.
const inFlight = sql`(${spaceWorkspaceUsage.error} is null
  and ${spaceWorkspaceUsage.attemptedAt} is distinct from ${spaceWorkspaceUsage.measuredAt})`;

/** Sweep candidates, or with `spaceId`, whether that space is due right now (the consumer's re-check). */
export async function findDueWorkspaces(database: Database, limit: number, spaceId?: string) {
  const usage = spaceWorkspaceUsage;
  const sandbox = spaceSandboxes;
  const idleSince = sql`coalesce(${sandbox.stoppedAt}, ${sandbox.updatedAt})`;
  const backoff = sql`least(${ms(MIN_INTERVAL_MS)} * power(2, greatest(${usage.failures} - 1, 0)), ${ms(MAX_BACKOFF_MS)})`;
  const stopped = sql`(${sandbox.id} is null or ${sandbox.status} in ('stopped', 'terminated'))`;
  const live = sql`${sandbox.status} in ('ready', 'running')`;
  const active = sql`(${usage.measuredAt} is null or ${sandbox.lastActivityAt} > ${usage.measuredAt})`;
  const int = (value: number) => sql.raw(String(Math.trunc(value)));
  const priority = sql<number>`case when ${stopped} then ${int(SCAN_PRIORITY.stopped)}
    when ${active} then ${int(SCAN_PRIORITY.active)} else ${int(SCAN_PRIORITY.idle)} end`.mapWith(Number);
  const rows = await database.select({
    spaceId: spaces.id, priority, attemptedAt: usage.attemptedAt, due: sql<number>`count(*) over ()`.mapWith(Number),
  }).from(spaces)
    .leftJoin(sandbox, eq(sandbox.spaceId, spaces.id))
    .leftJoin(usage, eq(usage.spaceId, spaces.id))
    .where(sql`
      ${spaceId ? sql`${spaces.id} = ${spaceId} and ` : sql``}${spaces.createdAt} < now() - ${ms(QUIET_MS)}
      and (${sandbox.id} is null or ${sandbox.provider} = 'cloud')
      and (${usage.attemptedAt} is null or not ${inFlight} or ${usage.attemptedAt} < now() - ${ms(SCAN_LEASE_MS)})
      and (${usage.error} is null or ${usage.attemptedAt} < now() - ${backoff})
      and ((${stopped}
          and (${sandbox.id} is null or ${idleSince} < now() - ${ms(QUIET_MS)})
          and (${usage.changedAt} is null or ${usage.changedAt} < now() - ${ms(QUIET_MS)})
          and (${usage.measuredAt} is null
            or ${sandbox.stoppedAt} > ${usage.measuredAt}
            or ${usage.changedAt} > ${usage.measuredAt}))
        or (${live} and (${usage.measuredAt} is null
          or (${sandbox.lastActivityAt} > ${usage.measuredAt} and ${usage.attemptedAt} < now() - ${ms(MIN_INTERVAL_MS)})
          or ${usage.measuredAt} < now() - ${ms(IDLE_INTERVAL_MS)})))`)
    .orderBy(priority, sql`${usage.attemptedAt} asc nulls first`)
    .limit(limit);
  return { candidates: rows.map(({ spaceId, priority, attemptedAt }) => ({ spaceId, priority, attemptedAt })), due: rows[0]?.due ?? 0 };
}

// Millisecond precision so the stamp round-trips through a JS Date unchanged.
export const dbNowMs = sql`date_trunc('milliseconds', clock_timestamp())`;

/**
 * Stamps the attempt with the database clock, like change markers, so a write
 * that lands after the claim is always newer than the measurement. Returns the
 * stamp that fences this attempt's result, or null when another attempt started
 * since `observedAt` was read, or an unfinished one is within `exclusiveMs`
 * (a stale holder must not displace it).
 */
export async function claimScan(database: Database, spaceId: string, observedAt: Date | null, exclusiveMs: number) {
  const [row] = await database.insert(spaceWorkspaceUsage).values({ spaceId, attemptedAt: dbNowMs, updatedAt: dbNowMs })
    .onConflictDoUpdate({
      target: spaceWorkspaceUsage.spaceId,
      set: { attemptedAt: dbNowMs, error: null, updatedAt: dbNowMs },
      setWhere: sql`${spaceWorkspaceUsage.attemptedAt} is not distinct from ${observedAt?.toISOString() ?? null}::timestamptz
        and (${spaceWorkspaceUsage.attemptedAt} is null or not ${inFlight}
          or ${spaceWorkspaceUsage.attemptedAt} < clock_timestamp() - ${ms(exclusiveMs)})`,
    })
    .returning({ attemptedAt: spaceWorkspaceUsage.attemptedAt });
  return row?.attemptedAt ?? null;
}

/** Records the outcome only if this attempt still owns the row; returns whether it did. */
export async function finishScan(database: Database, spaceId: string, attemptedAt: Date, outcome: { bytes: number } | { error: string }) {
  const rows = await database.update(spaceWorkspaceUsage)
    .set("bytes" in outcome
      ? { bytes: outcome.bytes, measuredAt: attemptedAt, failures: 0, error: null, updatedAt: dbNowMs }
      : { failures: sql`${spaceWorkspaceUsage.failures} + 1`, error: outcome.error, updatedAt: dbNowMs })
    .where(and(eq(spaceWorkspaceUsage.spaceId, spaceId), eq(spaceWorkspaceUsage.attemptedAt, attemptedAt)))
    .returning({ spaceId: spaceWorkspaceUsage.spaceId });
  return rows.length > 0;
}

export async function resolveWorkspacePath(root: string, spaceId: string) {
  const base = await realpath(root);
  const path = join(base, spaceId, "workspace");
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("workspace directory not found");
  const rel = relative(base, await realpath(path));
  if (rel !== join(spaceId, "workspace") || rel.startsWith(`..${sep}`)) throw new Error("workspace path escapes the storage root");
  return path;
}

/** A hung NAS stat cannot be cancelled, but it must not hold a scan slot. */
export function withDeadline<T>(promise: Promise<T>, deadline: number) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("workspace path check timed out")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
