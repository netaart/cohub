import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { spaceSandboxes, spaces, spaceWorkspaceUsage } from "@cohub/db";

type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// NAS protection: one scan at a time across all workers, four pdu threads
// (≈4x a single thread on NFS; more threads add load for little gain).
export const PDU_THREADS = 4;
export const SCAN_TIMEOUT_MS = 20 * 60_000;
// Only stopped workspaces are measured, after writes have settled.
const QUIET_MS = 10 * 60_000;
const MIN_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;
// Bounds staleness from writers that do not mark the workspace changed.
const RECALIBRATE_MS = 30 * 24 * 60 * 60_000;
export const SWEEP_BATCH = 10;

const ms = (value: number) => sql.raw(`interval '${value} milliseconds'`);

export async function findDueWorkspaces(database: Database, limit: number) {
  const usage = spaceWorkspaceUsage;
  const sandbox = spaceSandboxes;
  const idleSince = sql`coalesce(${sandbox.stoppedAt}, ${sandbox.updatedAt})`;
  const retryAfter = sql`case when ${usage.error} is null then ${ms(MIN_INTERVAL_MS)}
    else least(${ms(MIN_INTERVAL_MS)} * power(2, greatest(${usage.failures} - 1, 0)), ${ms(MAX_BACKOFF_MS)}) end`;
  const rows = await database.select({ spaceId: spaces.id }).from(spaces)
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
        or ${usage.changedAt} > ${usage.measuredAt}
        or ${usage.measuredAt} < now() - ${ms(RECALIBRATE_MS)})`)
    .orderBy(sql`${usage.attemptedAt} asc nulls first`)
    .limit(limit);
  return rows.map((row) => row.spaceId);
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
