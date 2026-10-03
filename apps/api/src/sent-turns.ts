import { normalizeSentTurnRef, type SentTurnRef } from "@cohub/protocol/model";
import { and, eq, sql } from "drizzle-orm";
import { sessionTurns } from "@cohub/db";
import { db } from "./db/index.js";

/**
 * Appends a child Turn to the caller Turn's `meta.messagesSent`.
 *
 * Array concatenation at one jsonb path, so concurrent children both survive
 * with no read-modify-write, and the rest of `meta` is untouched. Deliberately
 * unbounded: the caller is the only side that knows which Sessions it prompted.
 * Best-effort — the child's own `meta.origin` is authoritative.
 */
export const recordSentTurn = async (input: {
  callerSessionId: string;
  callerTurnId: string;
  ref: SentTurnRef;
}): Promise<boolean> => {
  const ref = normalizeSentTurnRef(input.ref);
  if (!ref) return false;
  const [updated] = await db.update(sessionTurns)
    .set({
      meta: sql`jsonb_set(
        coalesce(${sessionTurns.meta}, '{}'::jsonb),
        '{messagesSent}',
        coalesce(${sessionTurns.meta}->'messagesSent', '[]'::jsonb) || ${JSON.stringify([ref])}::jsonb,
        true
      )`,
    })
    .where(and(
      eq(sessionTurns.id, input.callerTurnId),
      eq(sessionTurns.sessionId, input.callerSessionId),
    ))
    .returning({ id: sessionTurns.id });
  return Boolean(updated);
};
