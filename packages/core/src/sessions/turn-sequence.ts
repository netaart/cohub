import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurnSegments, sessionTurns } from "@cohub/db";

type Db = PostgresJsDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SessionTurnSequenceExecutor = Db | Tx;

/** The next sequence a session can use, including a fork's local segment boundary. */
export async function nextSessionTurnSequence(
  db: SessionTurnSequenceExecutor,
  sessionId: string,
): Promise<number> {
  const [seqRow] = await db.select({
    max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int`,
  }).from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId));
  const [localSegment] = await db.select({
    fromSequence: sessionTurnSegments.fromSequence,
  }).from(sessionTurnSegments).where(and(
    eq(sessionTurnSegments.sessionId, sessionId),
    eq(sessionTurnSegments.sourceSessionId, sessionId),
    isNull(sessionTurnSegments.toSequence),
  )).orderBy(desc(sessionTurnSegments.ordinal)).limit(1);
  return seqRow?.max ? seqRow.max + 1 : localSegment?.fromSequence ?? 1;
}
