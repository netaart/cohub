import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurns } from "@cohub/db";
import type { TurnSpeechSegment, TurnSpeechTarget } from "@cohub/protocol";

type Database = PostgresJsDatabase<Record<string, unknown>>;

// Strictly increasing, so clients that merge turns by `updatedAt` keep every speech write.
const nextUpdatedAt = sql`greatest(${sessionTurns.updatedAt} + interval '1 millisecond', clock_timestamp())`;

const storedSegments = (voice: string) => sql`${sessionTurns.meta}->'speech'->${voice}::text`;

export async function swapTurnSpeech(db: Database, turnId: string, voice: string, expected: unknown, next: TurnSpeechSegment[]) {
  const meta = sql`jsonb_set(coalesce(${sessionTurns.meta}, '{}'::jsonb), '{speech}', coalesce(${sessionTurns.meta}->'speech', '{}'::jsonb))`;
  const [row] = await db.update(sessionTurns).set({
    meta: sql`jsonb_set(${meta}, array['speech', ${voice}::text], ${JSON.stringify(next)}::jsonb)`,
    updatedAt: nextUpdatedAt,
  }).where(and(
    eq(sessionTurns.id, turnId),
    sql`${storedSegments(voice)} is not distinct from ${expected == null ? null : JSON.stringify(expected)}::jsonb`,
  )).returning();
  return row ?? null;
}

export async function settleTurnSpeechSegment(
  db: Database,
  target: TurnSpeechTarget,
  segment: TurnSpeechSegment & { status: "completed" | "failed" },
) {
  const index = sql.raw(String(target.index));
  const [row] = await db.update(sessionTurns).set({
    meta: sql`jsonb_set(${sessionTurns.meta}, array['speech', ${target.voice}::text, '${index}'], ${JSON.stringify(segment)}::jsonb)`,
    updatedAt: nextUpdatedAt,
  }).where(and(
    eq(sessionTurns.id, target.turnId),
    sql`${storedSegments(target.voice)}->${index}->>'taskId' = ${segment.taskId}`,
  )).returning();
  return row ?? null;
}
