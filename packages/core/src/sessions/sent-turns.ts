import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurns } from "@cohub/db";
import { normalizeSentTurnRef, readSessionTurnReply, type SentTurnRef, type SessionTurnOrigin } from "@cohub/protocol/model";

export const sentTurnRefFor = (
  origin: SessionTurnOrigin | null | undefined,
  child: { spaceId: string; sessionId: string; turnId: string; meta?: unknown },
): SentTurnRef | null => {
  if (origin?.kind !== "prompt" || origin.turnId === child.turnId) return null;
  const { meta, ...ref } = child;
  return normalizeSentTurnRef({ ...ref, kind: origin.kind, toolCallId: origin.toolCallId, reply: readSessionTurnReply(meta)?.mode });
};

/** Appends at one jsonb path, so concurrent children never overwrite each other. */
export async function appendSentTurn(
  db: PostgresJsDatabase<Record<string, unknown>>,
  caller: Pick<SessionTurnOrigin, "sessionId" | "turnId">,
  ref: SentTurnRef,
) {
  const [row] = await db.update(sessionTurns)
    .set({
      meta: sql`jsonb_set(
        coalesce(${sessionTurns.meta}, '{}'::jsonb),
        '{messagesSent}',
        coalesce(${sessionTurns.meta}->'messagesSent', '[]'::jsonb) || ${JSON.stringify([ref])}::jsonb,
        true
      )`,
      updatedAt: new Date(),
    })
    .where(and(eq(sessionTurns.id, caller.turnId), eq(sessionTurns.sessionId, caller.sessionId)))
    .returning();
  return row ?? null;
}
