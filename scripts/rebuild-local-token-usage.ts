import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { recordTokenUsage, resolveUsageActorUserId, tokenUsageIncrements } from "@cohub/core/sessions";
import * as schema from "@cohub/db";
import { isLlmUsageMessage } from "@cohub/protocol";
import { isUuid } from "@cohub/protocol/identifiers";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Relabel local Harness usage; a Session commits only if its totals are unchanged.
// pnpm tsx scripts/rebuild-local-token-usage.ts [--write] [--session UUID] [--batch-size N]

const { sessionMessages, sessionTurns, spaceSessions, tokenUsageStatsHourly: stats } = schema;

// biome-ignore lint/suspicious/noExplicitAny: any Postgres driver, including transactions.
type Db = PgDatabase<PgQueryResultHKT, any, any>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Outcome = "changed" | "unchanged" | "mismatch" | "missing" | "failed";

const MAX_ATTEMPTS = 5;

class Rollback extends Error {
  constructor(readonly outcome: Outcome, readonly detail = "") { super(outcome); }
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") write = true;
    else if (arg === "--session" || arg === "--batch-size") {
      const value = argv[++index]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      values.set(arg, value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const session = values.get("--session")?.toLowerCase() ?? null;
  if (session && !isUuid(session)) throw new Error("Invalid --session");
  const batchSize = Number(values.get("--batch-size") ?? 1_000);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error("Invalid --batch-size");
  return { write, session, batchSize };
}

async function* candidateSessions(db: Db, batchSize: number): AsyncGenerator<string> {
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page: { id: string; sessionId: string; local: boolean }[] = await db
      .select({ id: sessionTurns.id, sessionId: sessionTurns.sessionId, local: sql<boolean>`coalesce(${sessionTurns.meta}->>'harness', 'cohub') <> 'cohub'` })
      .from(sessionTurns)
      .where(after ? gt(sessionTurns.id, after) : undefined)
      .orderBy(asc(sessionTurns.id))
      .limit(batchSize);
    if (!page.length) return;
    after = page.at(-1)?.id ?? null;
    for (const { sessionId, local } of page) {
      if (!local || seen.has(sessionId)) continue;
      seen.add(sessionId);
      yield sessionId;
    }
  }
}

const metricColumns = [
  stats.requestCount, stats.successCount, stats.errorCount,
  stats.inputTokens, stats.outputTokens, stats.cacheReadTokens, stats.cacheWriteTokens, stats.totalTokens,
  stats.costInput, stats.costOutput, stats.costCacheRead, stats.costCacheWrite, stats.costTotal,
];

async function totals(tx: Tx, sessionId: string) {
  const rows = await tx
    .select({
      bucketStartAt: stats.bucketStartAt,
      userId: stats.userId,
      model: stats.model,
      metrics: sql<string>`concat_ws(',', ${sql.join(metricColumns.map((column) => sql`sum(${column})`), sql`, `)})`,
    })
    .from(stats)
    .where(eq(stats.sessionId, sessionId))
    .groupBy(stats.bucketStartAt, stats.userId, stats.model)
    .orderBy(stats.bucketStartAt, sql`${stats.userId} nulls first`, sql`${stats.model} nulls first`);
  return JSON.stringify(rows);
}

async function labels(tx: Tx, sessionId: string) {
  const rows = await tx
    .select({ harness: stats.harness, provider: stats.provider, model: stats.model, tokens: sql<string>`sum(${stats.totalTokens})::text`, rows: sql<string>`count(*)::text` })
    .from(stats)
    .where(eq(stats.sessionId, sessionId))
    .groupBy(stats.harness, stats.provider, stats.model)
    .orderBy(stats.harness, stats.provider, stats.model);
  return rows.map((row) => `${row.harness}:${row.provider ?? "∅"}/${row.model ?? "∅"} ${row.tokens} tokens in ${row.rows} rows`);
}

const aggregatedCount = async (tx: Tx, sessionId: string) => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), isNotNull(sessionMessages.usageAggregatedAt)));
  return row?.count ?? 0;
};

async function rebuild(db: Db, sessionId: string, write: boolean): Promise<{ outcome: Outcome; detail: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const detail = await db.transaction(async (tx) => {
        const [session] = await tx.select({ spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, sessionId));
        if (!session) throw new Rollback("missing", "session not found");
        const beforeTotals = await totals(tx, sessionId);
        const beforeLabels = await labels(tx, sessionId);
        const messages = await tx
          .select()
          .from(sessionMessages)
          .where(and(eq(sessionMessages.sessionId, sessionId), isNotNull(sessionMessages.usageAggregatedAt)))
          .orderBy(asc(sessionMessages.sequence));

        await tx.delete(stats).where(eq(stats.sessionId, sessionId));
        for (const message of messages) {
          if (!isLlmUsageMessage(message)) continue;
          const userId = await resolveUsageActorUserId(tx, message);
          for (const increment of tokenUsageIncrements(message, { spaceId: session.spaceId, userId })) {
            await recordTokenUsage(tx, increment);
          }
        }

        if (await aggregatedCount(tx, sessionId) !== messages.length) throw new Error("Session usage changed during rebuild");
        if (await totals(tx, sessionId) !== beforeTotals) throw new Rollback("mismatch", "recomputed totals differ from stored ones; left untouched");
        const afterLabels = await labels(tx, sessionId);
        if (afterLabels.join("\n") === beforeLabels.join("\n")) throw new Rollback("unchanged");
        const detail = `\n    - ${beforeLabels.join("\n    - ")}\n    + ${afterLabels.join("\n    + ")}`;
        if (!write) throw new Rollback("changed", detail);
        return detail;
      });
      return { outcome: "changed", detail };
    } catch (error) {
      if (error instanceof Rollback) return { outcome: error.outcome, detail: error.detail };
      if (attempt >= MAX_ATTEMPTS) return { outcome: "failed", detail: String(error) };
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const dbClient = postgres(process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub", { prepare: false });
  const db = drizzle(dbClient, { schema });
  try {
    console.log(`[rebuild-local-token-usage] ${args.write ? "WRITE" : "DRY RUN"}`);
    const counts: Record<Outcome, number> = { changed: 0, unchanged: 0, mismatch: 0, missing: 0, failed: 0 };
    const sessions = args.session ? [args.session] : candidateSessions(db, args.batchSize);
    for await (const sessionId of sessions) {
      const { outcome, detail } = await rebuild(db, sessionId, args.write);
      counts[outcome] += 1;
      if (outcome !== "unchanged") console.log(`  ${sessionId} ${outcome}${outcome === "changed" ? detail : `: ${detail}`}`);
    }
    console.log(`[rebuild-local-token-usage] ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")}`);
    if (counts.failed) process.exitCode = 1;
    if (args.write && counts.changed) {
      console.log("Trending caches the day's model board; delete `api:trending:models:*` in Redis to show the rebuilt rows.");
    }
  } finally {
    await dbClient.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
