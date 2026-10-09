import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurnIsActive, sessionTurnSegments, sessionTurns, spaceSessions } from "@cohub/db";
import { getRealtimeSpaceRoom, type RealtimeRoom, type SessionUpdatedEvent } from "@cohub/protocol/realtime";
import { type SessionActiveTurnState, sessionActiveTurnState } from "./active-turn.js";
import { resolveSessionAudienceRooms } from "./session-audience.js";
import { readSessionParticipantUserUuids } from "./session-meta.js";
import { refreshSessionStats } from "./stats.js";

type Database = PostgresJsDatabase<Record<string, unknown>>;

export type SessionSnapshotEvent = SessionUpdatedEvent & { rooms: RealtimeRoom[] };

const SNAPSHOT_FIELDS = ["title", "latestMessageText", "lastMessageAt", "lastMessageId", "participantUserUuids", "activeTurn", "activeTurnSequence", "lastTurnIssue", "stats"];
const SETTLED_TURN_STATUSES = ["completed", "failed", "interrupted"] as const;
const TURN_ISSUE_ERROR_LIMIT = 240;

export async function readSessionActiveTurns(db: Database, sessionIds: string[]): Promise<Map<string, SessionActiveTurnState>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Map();
  const latestTurn = db.select({ sequence: sessionTurns.sequence }).from(sessionTurns)
    .where(eq(sessionTurns.sessionId, spaceSessions.id))
    .orderBy(desc(sessionTurns.sequence))
    .limit(1)
    .as("latest_turn");
  const settledTurn = db.select({
    id: sessionTurns.id,
    sequence: sessionTurns.sequence,
    status: sessionTurns.status,
    reason: sql<string | null>`${sessionTurns.summary}->>'reason'`.as("turn_issue_reason"),
    errorMessage: sql<string | null>`left(${sessionTurns.errorMessage}, ${TURN_ISSUE_ERROR_LIMIT})`.as("turn_issue_error"),
  }).from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, spaceSessions.id), inArray(sessionTurns.status, SETTLED_TURN_STATUSES)))
    .orderBy(desc(sessionTurns.sequence))
    .limit(1)
    .as("settled_turn");
  const [activeRows, latestRows] = await Promise.all([
    db.selectDistinctOn([sessionTurns.sessionId], {
      sessionId: sessionTurns.sessionId,
      id: sessionTurns.id,
      sequence: sessionTurns.sequence,
      status: sessionTurns.status,
      provider: sessionTurns.provider,
      model: sessionTurns.model,
      startedAt: sessionTurns.startedAt,
      meta: sql<unknown>`jsonb_build_object('userMessageId', ${sessionTurns.meta}->'userMessageId')`,
    }).from(sessionTurns)
      .where(and(inArray(sessionTurns.sessionId, ids), sessionTurnIsActive(sessionTurns.status)))
      .orderBy(sessionTurns.sessionId, desc(sessionTurns.sequence)),
    db.select({
      sessionId: spaceSessions.id,
      sequence: latestTurn.sequence,
      settledId: settledTurn.id,
      settledSequence: settledTurn.sequence,
      settledStatus: settledTurn.status,
      settledReason: settledTurn.reason,
      settledErrorMessage: settledTurn.errorMessage,
    }).from(spaceSessions)
      .leftJoinLateral(latestTurn, sql`true`)
      .leftJoinLateral(settledTurn, sql`true`)
      .where(inArray(spaceSessions.id, ids)),
  ]);
  const activeBySessionId = new Map(activeRows.map((row) => [row.sessionId, row]));
  return new Map(latestRows.map((row) => [
    row.sessionId,
    sessionActiveTurnState(
      activeBySessionId.get(row.sessionId) ?? null,
      row.sequence,
      row.settledId && row.settledSequence != null && row.settledStatus
        ? { id: row.settledId, sequence: row.settledSequence, status: row.settledStatus, reason: row.settledReason, errorMessage: row.settledErrorMessage }
        : null,
    ),
  ]));
}

export async function readSessionActiveTurn(db: Database, sessionId: string): Promise<SessionActiveTurnState> {
  return (await readSessionActiveTurns(db, [sessionId])).get(sessionId) ?? { activeTurn: null, lastTurnIssue: null };
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
