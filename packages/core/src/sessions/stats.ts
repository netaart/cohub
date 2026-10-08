import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurnSegments, sessionTurns, spaceSessions, taskRuns } from "@cohub/db";
import { emptyExecutionStats, isSettledStatsTurn, mergeExecutionStats, metricsRecord, readSessionStats, readStatsUsage, readTurnStats, sumStatsUsage, TURN_STATS_VERSION, type ExecutionStats, type SessionStats, type TurnStatsRecord } from "@cohub/protocol/model";
import type { Usage } from "@cohub/protocol/core";

type Database = PostgresJsDatabase<Record<string, unknown>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const WRITE_CHUNK = 500;

/** Rebuildable projection from per-Turn `stats`, re-derived when missing, outdated, or at/after `fromSequence`. */
export async function refreshSessionStats(db: Database, sessionId: string, fromSequence?: number) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session-stats:${sessionId}`}))`);
    const [session] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, sessionId));
    if (!session) return null;
    const segments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId));
    const visible = segments.length ? or(...segments.map((segment) => and(
      eq(sessionTurns.sessionId, segment.sourceSessionId),
      gte(sessionTurns.sequence, segment.fromSequence),
      segment.toSequence == null ? undefined : lte(sessionTurns.sequence, segment.toSequence),
    ))) : eq(sessionTurns.sessionId, sessionId);
    const sourceSessionIds = [...new Set([sessionId, ...segments.map((segment) => segment.sourceSessionId)])];
    const turns = await tx.select({
      id: sessionTurns.id, sessionId: sessionTurns.sessionId, sequence: sessionTurns.sequence,
      status: sessionTurns.status, stats: sessionTurns.stats,
      generationTaskId: sql<string | null>`case when ${sessionTurns.executionKind} = 'direct_generation' then ${sessionTurns.meta}->>'generationTaskId' end`,
    }).from(sessionTurns).where(visible);
    const settled = turns.filter(isSettledStatsTurn);
    const stale = settled.filter((turn) => turn.stats?.version !== TURN_STATS_VERSION
      || (fromSequence != null && turn.sessionId === sessionId && turn.sequence >= fromSequence));
    const derived = await deriveTurnStats(tx, stale.map((turn) => turn.id).sort());

    const stats: SessionStats = { version: 1, revision: (readSessionStats(session.meta)?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), own: emptyExecutionStats(), inherited: emptyExecutionStats(), auxiliaryUsage: null };
    for (const turn of settled) {
      const own = derived.get(turn.id) ?? turn.stats?.stats;
      if (!own) continue;
      const key = turn.sessionId === sessionId ? "own" : "inherited";
      stats[key] = mergeExecutionStats(stats[key], own);
    }
    // Tool/CLI generation tasks need not have their own Turn. Count each task once;
    // a direct-generation Turn already represents its task's costs and duration.
    const representedTasks = new Set(turns.map((turn) => turn.generationTaskId).filter(Boolean));
    const generations = await tx.select({ id: taskRuns.id, sessionId: taskRuns.sessionId, status: taskRuns.status,
      cost: sql<unknown>`${taskRuns.result}->'cost'`,
    }).from(taskRuns).leftJoin(sessionTurns, and(
      eq(taskRuns.turnId, sessionTurns.id), eq(taskRuns.sessionId, sessionTurns.sessionId),
      inArray(sessionTurns.sessionId, sourceSessionIds),
    )).where(and(
      inArray(taskRuns.sessionId, sourceSessionIds),
      eq(taskRuns.taskType, "generation"), inArray(taskRuns.status, ["completed", "failed"]),
      or(eq(taskRuns.sessionId, sessionId), visible),
    ));
    for (const task of generations) {
      if (representedTasks.has(task.id)) continue;
      const contribution = readTurnStats({ status: task.status, executionKind: "direct_generation", meta: { generation: { officialCostUsd: task.cost } } });
      // Nested/background tasks are not extra user turns or extra wall-clock time.
      contribution.turns = 0;
      const key = task.sessionId === sessionId ? "own" : "inherited";
      stats[key] = mergeExecutionStats(stats[key], contribution);
    }
    const meta = metricsRecord(session.meta);
    const title = metricsRecord(meta.title);
    const ownTitle = !meta.fork || (typeof title.generatedAt === "string" && session.createdAt && Date.parse(title.generatedAt) >= session.createdAt.getTime());
    const titleUsage = ownTitle ? metricsRecord(title.usage) : {};
    // Legacy title tasks already retain these usages; do not count them as replies.
    for (const value of Object.values(titleUsage)) {
      stats.auxiliaryUsage = sumStatsUsage(stats.auxiliaryUsage, readStatsUsage(value));
    }
    const [updated] = await tx.update(spaceSessions).set({
      meta: sql`coalesce(${spaceSessions.meta}, '{}'::jsonb) || jsonb_build_object('stats', ${JSON.stringify(stats)}::jsonb)`,
    }).where(eq(spaceSessions.id, sessionId)).returning();
    return updated ? { session: updated, stats } : null;
  });
}

async function deriveTurnStats(tx: Transaction, turnIds: string[]) {
  const derived = new Map<string, ExecutionStats>();
  for (let offset = 0; offset < turnIds.length; offset += WRITE_CHUNK) {
    const rows = await tx.select({
      id: sessionTurns.id, status: sessionTurns.status, intent: sessionTurns.intent,
      executionKind: sessionTurns.executionKind,
      totalUsage: sql<Usage | null>`case when ${sessionTurns.executionKind} = 'direct_generation' then null else ${sessionTurns.totalUsage} end`,
      finalUsage: sql<Usage | null>`case when ${sessionTurns.executionKind} = 'direct_generation' then null else ${sessionTurns.finalUsage} end`,
      durationMs: sessionTurns.durationMs, createdAt: sessionTurns.createdAt, completedAt: sessionTurns.completedAt,
      intermediateSummary: sessionTurns.intermediateSummary,
      meta: sql<Record<string, unknown>>`jsonb_build_object('llm', ${sessionTurns.meta}->'llm', 'metrics', ${sessionTurns.meta}->'metrics', 'generation', jsonb_build_object('officialCostUsd', ${sessionTurns.meta}->'generation'->'officialCostUsd'), 'generationTaskId', ${sessionTurns.meta}->'generationTaskId', 'imageToText', ${sessionTurns.meta}->'imageToText')`,
    }).from(sessionTurns).where(inArray(sessionTurns.id, turnIds.slice(offset, offset + WRITE_CHUNK))).orderBy(asc(sessionTurns.id));
    if (rows.length === 0) continue;
    const records = rows.map((row) => {
      const stats = readTurnStats(row);
      derived.set(row.id, stats);
      return sql`(${row.id}::uuid, ${JSON.stringify({ version: TURN_STATS_VERSION, stats } satisfies TurnStatsRecord)}::jsonb)`;
    });
    await tx.execute(sql`update ${sessionTurns} set stats = derived.stats
      from (values ${sql.join(records, sql`, `)}) as derived(id, stats)
      where ${sessionTurns.id} = derived.id`);
  }
  return derived;
}
