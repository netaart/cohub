import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurnSegments, sessionTurns, spaceSessions, taskRuns } from "@cohub/db";
import { emptyExecutionStats, mergeExecutionStats, metricsRecord, readSessionStats, readStatsUsage, readTurnStats, sumStatsUsage, type SessionStats } from "@cohub/protocol/model";
import type { SessionUpdatedEvent } from "@cohub/protocol/realtime";
import type { Usage } from "@cohub/protocol/core";

type Database = PostgresJsDatabase<Record<string, unknown>>;

/** Rebuildable projection. Serialize reads + writes on the Session row; never update
 * activity timestamps or replace other meta namespaces. No transcript/object reads. */
export async function refreshSessionStats(db: Database, sessionId: string) {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, sessionId)).for("update");
    if (!session) return null;
    const segments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId));
    const visible = segments.length ? or(...segments.map((segment) => and(
      eq(sessionTurns.sessionId, segment.sourceSessionId),
      gte(sessionTurns.sequence, segment.fromSequence),
      segment.toSequence == null ? undefined : lte(sessionTurns.sequence, segment.toSequence),
    ))) : eq(sessionTurns.sessionId, sessionId);
    const sourceSessionIds = [...new Set([sessionId, ...segments.map((segment) => segment.sourceSessionId)])];
    const rows = await tx.select({
      sessionId: sessionTurns.sessionId, status: sessionTurns.status, intent: sessionTurns.intent,
      executionKind: sessionTurns.executionKind,
      totalUsage: sql<Usage | null>`case when ${sessionTurns.executionKind} = 'direct_generation' then null else ${sessionTurns.totalUsage} end`,
      finalUsage: sql<Usage | null>`case when ${sessionTurns.executionKind} = 'direct_generation' then null else ${sessionTurns.finalUsage} end`,
      durationMs: sessionTurns.durationMs, createdAt: sessionTurns.createdAt, completedAt: sessionTurns.completedAt,
      intermediateSummary: sessionTurns.intermediateSummary,
      meta: sql<Record<string, unknown>>`jsonb_build_object('llm', ${sessionTurns.meta}->'llm', 'metrics', ${sessionTurns.meta}->'metrics', 'generation', jsonb_build_object('officialCostUsd', ${sessionTurns.meta}->'generation'->'officialCostUsd'), 'generationTaskId', ${sessionTurns.meta}->'generationTaskId', 'imageToText', ${sessionTurns.meta}->'imageToText')`,
    }).from(sessionTurns).where(visible);
    const stats: SessionStats = { version: 1, revision: (readSessionStats(session.meta)?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), own: emptyExecutionStats(), inherited: emptyExecutionStats(), auxiliaryUsage: null };
    // Tool/CLI generation tasks need not have their own Turn. Count each task once;
    // a direct-generation Turn already represents its task's costs and duration.
    const representedTasks = new Set(rows.filter((turn) => turn.executionKind === "direct_generation").map((turn) => metricsRecord(turn.meta).generationTaskId));
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
    for (const turn of rows) {
      const key = turn.sessionId === sessionId ? "own" : "inherited";
      stats[key] = mergeExecutionStats(stats[key], readTurnStats(turn));
    }
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

/** Also refresh descendants whose timeline inherits this Session. Call after commit,
 * not from inside a Turn transaction. Duplicate notifications simply rebuild facts. */
export async function refreshSessionStatsAndPublish(db: Database, sessionId: string, publish: (event: SessionUpdatedEvent) => Promise<unknown>, fromSequence?: number) {
  const descendants = await db.selectDistinct({ id: sessionTurnSegments.sessionId }).from(sessionTurnSegments)
    .where(and(
      eq(sessionTurnSegments.sourceSessionId, sessionId),
      fromSequence == null ? undefined : or(isNull(sessionTurnSegments.toSequence), gte(sessionTurnSegments.toSequence, fromSequence)),
    ));
  for (const id of new Set([sessionId, ...descendants.map((row) => row.id)])) {
    const result = await refreshSessionStats(db, id);
    if (!result) continue;
    const { session, stats } = result;
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    await publish({
      id: randomUUID(), timestamp: Date.now(), domain: "session", type: "session.updated",
      spaceId: session.spaceId, sessionId: id,
      payload: { changed: ["stats"], session: {
        id, spaceId: session.spaceId, userUuid: session.userUuid, title: session.title, source: session.source,
        status: session.status, externalSessionId: session.externalSessionId, latestMessageText: session.latestMessageText,
        lastMessageAt: iso(session.lastMessageAt), lastMessageId: session.lastMessageId,
        createdAt: iso(session.createdAt) ?? stats.updatedAt, updatedAt: iso(session.updatedAt) ?? stats.updatedAt,
        stats,
      } },
    });
  }
}
