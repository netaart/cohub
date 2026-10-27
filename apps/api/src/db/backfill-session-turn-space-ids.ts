import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * Backfill session_turns.space_id from space_sessions. Idempotent and resumable; dry-run unless --write.
 * Small keyset batches keep row locks short, so running Turns are never blocked for long.
 *
 * Rollout: build the index before migration 0078 so it never blocks Turn writes (the migration then no-ops):
 *   ALTER TABLE v2.session_turns ADD COLUMN IF NOT EXISTS space_id uuid;
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS v2_idx_session_turns_space_created_at
 *     ON v2.session_turns (space_id, created_at DESC NULLS FIRST, id DESC NULLS FIRST);
 * Deploy, then run this with --write; older Turns are missing from Space Turn lists until it finishes.
 *
 * Usage, in the API image (or `pnpm tsx src/db/backfill-session-turn-space-ids.ts` from apps/api):
 *   node dist/db/backfill-session-turn-space-ids.js [--write] [--batch-size N] [--sleep-ms N]
 */
type Database = PgDatabase<PgQueryResultHKT>;
type Options = { write: boolean; batchSize: number; sleepMs?: number; log?: (event: Record<string, unknown>) => void };

// postgres-js resolves to the row array, PGlite to { rows }.
const rows = async <T>(db: Database, query: ReturnType<typeof sql>) => {
  const result = await db.execute(query) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
};

export async function backfillSessionTurnSpaceIds(db: Database, { write, batchSize, sleepMs = 0, log = () => {} }: Options) {
  const mode = write ? "write" : "dry-run";
  let cursor = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const ids = await rows<{ id: string }>(db, sql`
      SELECT id FROM v2.session_turns WHERE id > ${cursor}::uuid ORDER BY id LIMIT ${batchSize}`);
    const last = ids.at(-1);
    if (!last) break;
    const from = cursor;
    cursor = last.id;
    scanned += ids.length;
    const range = sql`t.id > ${from}::uuid AND t.id <= ${cursor}::uuid AND t.space_id IS NULL`;
    const [result] = await rows<{ count: number }>(db, write
      ? sql`
        WITH changed AS (
          UPDATE v2.session_turns t SET space_id = s.space_id
          FROM v2.space_sessions s WHERE s.id = t.session_id AND ${range}
          RETURNING 1)
        SELECT count(*)::int AS count FROM changed`
      : sql`
        SELECT count(*)::int AS count FROM v2.session_turns t
        JOIN v2.space_sessions s ON s.id = t.session_id WHERE ${range}`);
    updated += Number(result?.count ?? 0);
    log({ event: "session_turn_space_id_backfill_batch", mode, cursor, scanned, updated });
    if (write && sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  const [orphans] = await rows<{ count: number }>(db, sql`
    SELECT count(*)::int AS count FROM v2.session_turns t
    WHERE t.space_id IS NULL AND EXISTS (SELECT 1 FROM v2.space_sessions s WHERE s.id = t.session_id)`);
  const summary = { event: "session_turn_space_id_backfill_finished", mode, scanned, updated, remaining: Number(orphans?.count ?? 0) };
  log(summary);
  return summary;
}

function readNumber(argv: string[], name: string, fallback: number, max: number) {
  const index = argv.indexOf(name);
  const value = Number(index >= 0 ? argv[index + 1] : fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return Math.min(Math.floor(value), max);
}

async function main() {
  await import("dotenv/config");
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub", { prepare: false });
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  try {
    await backfillSessionTurnSpaceIds(drizzle(client) as unknown as Database, {
      write: argv.includes("--write"),
      batchSize: Math.max(1, readNumber(argv, "--batch-size", 1_000, 10_000)),
      sleepMs: readNumber(argv, "--sleep-ms", 50, 60_000),
      log: (event) => console.log(JSON.stringify(event)),
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
