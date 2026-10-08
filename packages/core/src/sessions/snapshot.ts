import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, max, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurnSegments, sessionTurns, spaceSessions } from "@cohub/db";
import type { SessionActiveTurn } from "@cohub/protocol/model";
import { getRealtimeSpaceRoom, type RealtimeRoom, type SessionUpdatedEvent } from "@cohub/protocol/realtime";
import { ACTIVE_TURN_STATUSES, activeTurnFromRow } from "./active-turn.js";
import { resolveSessionAudienceRooms } from "./session-audience.js";
import { readSessionParticipantUserUuids } from "./session-meta.js";
import { refreshSessionStats } from "./stats.js";

type Database = PostgresJsDatabase<Record<string, unknown>>;

export type SessionSnapshotEvent = SessionUpdatedEvent & { rooms: RealtimeRoom[] };

const SNAPSHOT_FIELDS = ["title", "latestMessageText", "lastMessageAt", "lastMessageId", "participantUserUuids", "activeTurn", "activeTurnSequence", "stats"];

export async function readSessionActiveTurn(db: Database, sessionId: string): Promise<{ activeTurn: SessionActiveTurn | null; activeTurnSequence?: number }> {
  const [[active], [latest]] = await Promise.all([
    db.select({
      id: sessionTurns.id, sequence: sessionTurns.sequence, status: sessionTurns.status,
      provider: sessionTurns.provider, model: sessionTurns.model, startedAt: sessionTurns.startedAt,
      meta: sql<unknown>`jsonb_build_object('userMessageId', ${sessionTurns.meta}->'userMessageId')`,
    }).from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), inArray(sessionTurns.status, [...ACTIVE_TURN_STATUSES])))
      .orderBy(desc(sessionTurns.sequence))
      .limit(1),
    db.select({ sequence: max(sessionTurns.sequence) }).from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)),
  ]);
  const activeTurn = activeTurnFromRow(active ?? null);
  const activeTurnSequence = activeTurn?.sequence ?? latest?.sequence ?? null;
  return { activeTurn, ...(activeTurnSequence == null ? {} : { activeTurnSequence }) };
}

/** Refreshes stats and publishes the Session's complete record, plus descendants'. Call after commit. */
export async function publishSessionSnapshot(
  db: Database,
  sessionId: string,
  publish: (event: SessionSnapshotEvent) => Promise<unknown>,
  fromSequence?: number,
) {
  const descendants = await db.selectDistinct({ id: sessionTurnSegments.sessionId }).from(sessionTurnSegments)
    .where(and(
      eq(sessionTurnSegments.sourceSessionId, sessionId),
      fromSequence == null ? undefined : or(isNull(sessionTurnSegments.toSequence), gte(sessionTurnSegments.toSequence, fromSequence)),
    ));
  let statsError: unknown;
  for (const id of new Set([sessionId, ...descendants.map((row) => row.id)])) {
    const result = await refreshSessionStats(db, id, id === sessionId ? fromSequence : undefined).catch(async (error: unknown) => {
      statsError ??= error;
      const [session] = await db.select().from(spaceSessions).where(eq(spaceSessions.id, id));
      return session ? { session, stats: undefined } : null;
    });
    if (!result) continue;
    const { session, stats } = result;
    const [active, rooms] = await Promise.all([
      readSessionActiveTurn(db, id),
      resolveSessionAudienceRooms(db, session).catch(() => [getRealtimeSpaceRoom(session.spaceId)]),
    ]);
    const now = new Date().toISOString();
    const iso = (date: Date | null) => date?.toISOString() ?? now;
    await publish({
      id: randomUUID(), timestamp: Date.now(), domain: "session", type: "session.updated",
      spaceId: session.spaceId, sessionId: id, rooms,
      payload: { changed: stats ? SNAPSHOT_FIELDS : SNAPSHOT_FIELDS.filter((field) => field !== "stats"), session: {
        id, spaceId: session.spaceId, userUuid: session.userUuid, title: session.title, source: session.source,
        status: session.status, externalSessionId: session.externalSessionId, latestMessageText: session.latestMessageText,
        lastMessageAt: session.lastMessageAt?.toISOString() ?? null, lastMessageId: session.lastMessageId,
        createdAt: iso(session.createdAt), updatedAt: iso(session.updatedAt),
        participantUserUuids: readSessionParticipantUserUuids(session.meta),
        ...active,
        ...(stats ? { stats } : {}),
      } },
    });
  }
  if (statsError) throw statsError;
}
