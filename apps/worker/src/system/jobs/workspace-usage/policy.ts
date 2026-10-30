import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { spaceSandboxes, spaces, spaceWorkspaceUsage } from "@cohub/db";

type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// NAS protection: one scan at a time across all workers, four pdu threads
// (≈4x a single thread on NFS; more threads add load for little gain).
export const PDU_THREADS = 4;
export const SCAN_TIMEOUT_MS = 20 * 60_000;
// Only stopped workspaces are measured, after writes have settled.
export const QUIET_MS = 10 * 60_000;
const MIN_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;
export const SWEEP_BATCH = 10;

const ms = (value: number) => sql.raw(`interval '${value} milliseconds'`);

export async function findDueWorkspaces(database: Database, limit: number) {
  const usage = spaceWorkspaceUsage;
  const sandbox = spaceSandboxes;
  const idleSince = sql`coalesce(${sandbox.stoppedAt}, ${sandbox.updatedAt})`;
  const retryAfter = sql`case when ${usage.error} is null then ${ms(MIN_INTERVAL_MS)}
    else least(${ms(MIN_INTERVAL_MS)} * power(2, greatest(${usage.failures} - 1, 0)), ${ms(MAX_BACKOFF_MS)}) end`;
  const rows = await database.select({ spaceId: spaces.id, due: sql<number>`count(*) over ()`.mapWith(Number) }).from(spaces)
    .leftJoin(sandbox, eq(sandbox.spaceId, spaces.id))
    .leftJoin(usage, eq(usage.spaceId, spaces.id))
    .where(sql`
      ${spaces.createdAt} < now() - ${ms(QUIET_MS)}
      and (${sandbox.id} is null or (${sandbox.provider} = 'cloud'
        and ${sandbox.status} in ('stopped', 'terminated') and ${idleSince} < now() - ${ms(QUIET_MS)}))
      and (${usage.changedAt} is null or ${usage.changedAt} < now() - ${ms(QUIET_MS)})
      and (${usage.attemptedAt} is null or ${usage.attemptedAt} < now() - ${retryAfter})
      and (${usage.measuredAt} is null
        or ${sandbox.stoppedAt} > ${usage.measuredAt}
        or ${usage.changedAt} > ${usage.measuredAt})`)
    .orderBy(sql`${usage.attemptedAt} asc nulls first`)
    .limit(limit);
  return { spaceIds: rows.map((row) => row.spaceId), due: rows[0]?.due ?? 0 };
}

// Millisecond precision so the stamp round-trips through a JS Date unchanged.
export const dbNowMs = sql`date_trunc('milliseconds', clock_timestamp())`;

/**
 * Stamps the attempt with the database clock, like change markers, so a write
 * that lands after the claim is always newer than the measurement. Returns the
 * stamp that fences this attempt's result, or null when another attempt
 * claimed the space within `exclusiveMs` (a stale holder must not displace it).
 */
export async function claimScan(database: Database, spaceId: string, exclusiveMs: number) {
  const [row] = await database.insert(spaceWorkspaceUsage).values({ spaceId, attemptedAt: dbNowMs, updatedAt: dbNowMs })
    .onConflictDoUpdate({
      target: spaceWorkspaceUsage.spaceId,
      set: { attemptedAt: dbNowMs, updatedAt: dbNowMs },
      setWhere: sql`${spaceWorkspaceUsage.attemptedAt} is null or ${spaceWorkspaceUsage.attemptedAt} < clock_timestamp() - ${ms(exclusiveMs)}`,
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

type DateLike = Date | string | null | undefined;
const time = (value: DateLike) => (value ? new Date(value).getTime() : 0);

/** Re-checked when a queued scan starts: a write since enqueue restarts the quiet period. */
export function isQuietForScan(
  sandbox: { stoppedAt: DateLike; updatedAt: DateLike } | null | undefined,
  usage: { changedAt: DateLike } | null | undefined,
  now = Date.now(),
) {
  const idleSince = sandbox ? time(sandbox.stoppedAt) || time(sandbox.updatedAt) : 0;
  return now - idleSince >= QUIET_MS && now - time(usage?.changedAt) >= QUIET_MS;
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

/** A hung NAS stat cannot be cancelled, but it must not hold the single scan slot. */
export function withDeadline<T>(promise: Promise<T>, deadline: number) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("workspace path check timed out")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
