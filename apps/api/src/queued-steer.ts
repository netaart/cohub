import { sessionTurns } from "@cohub/db";
import { and, eq, lte, sql } from "drizzle-orm";
import type { db } from "./db/index.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function rotateQueuedTurnSequences(tx: Transaction, target: { sessionId: string; sequence: number }) {
  // Park the occupied slots below zero so neither write can collide with the unique index.
  const queued = await tx.update(sessionTurns).set({ sequence: sql`-${sessionTurns.sequence}` }).where(and(
    eq(sessionTurns.sessionId, target.sessionId), eq(sessionTurns.status, "queued"), lte(sessionTurns.sequence, target.sequence),
  )).returning({ id: sessionTurns.id });

  await tx.execute(sql`
    with rotated as (
      select id, coalesce(lead(-sequence) over (order by sequence desc), min(-sequence) over ()) as next_sequence
      from v2.session_turns where session_id = ${target.sessionId} and sequence < 0
    )
    update v2.session_turns t set sequence = rotated.next_sequence,
      updated_at = case when t.intent = 'steer' then t.updated_at else statement_timestamp() end
    from rotated where t.id = rotated.id
  `);
  return queued.map((turn) => turn.id);
}
