import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { spaceSessions } from "@cohub/db";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type {
  RealtimeRoom,
  SessionTurnUpdatedEvent,
} from "@cohub/protocol/realtime";
import {
  resolveSessionAudienceRooms,
  type SessionAudienceInput,
} from "./session-audience.js";

type Database = Parameters<typeof resolveSessionAudienceRooms>[0];
type TurnState = Pick<
  SessionTurnRecord,
  | "id"
  | "sessionId"
  | "sequence"
  | "status"
  | "executionKind"
  | "provider"
  | "model"
  | "startedAt"
  | "updatedAt"
  | "errorMessage"
  | "summary"
  | "meta"
>;
export type SessionTurnStateEvent = SessionTurnUpdatedEvent & {
  rooms: RealtimeRoom[];
};

export async function publishSessionTurnStates(
  db: Database,
  spaceId: string,
  turns: readonly TurnState[],
  publish: (event: SessionTurnStateEvent) => Promise<unknown>,
  knownSession?: SessionAudienceInput,
) {
  const first = turns[0];
  if (!first || turns.some((turn) => turn.sessionId !== first.sessionId))
    return;
  const session =
    knownSession ??
    (
      await db
        .select({
          id: spaceSessions.id,
          spaceId: spaceSessions.spaceId,
          userUuid: spaceSessions.userUuid,
          meta: sql<unknown>`jsonb_build_object('participants', ${spaceSessions.meta}->'participants')`,
        })
        .from(spaceSessions)
        .where(eq(spaceSessions.id, first.sessionId))
        .limit(1)
    )[0];
  if (!session || session.id !== first.sessionId || session.spaceId !== spaceId)
    return;
  const rooms = (await resolveSessionAudienceRooms(db, session)).filter(
    (room) => room.startsWith("user:"),
  );
  if (!rooms.length) return;
  await Promise.all(
    turns.map((turn) =>
      publish({
        id: randomUUID(),
        timestamp: Date.now(),
        domain: "session",
        type: "session.turn.updated",
        spaceId,
        sessionId: turn.sessionId,
        rooms,
        payload: {
          turn: {
            id: turn.id,
            sessionId: turn.sessionId,
            sequence: turn.sequence,
            status: turn.status,
            executionKind: turn.executionKind,
            provider: turn.provider,
            model: turn.model,
            startedAt: turn.startedAt,
            updatedAt: turn.updatedAt,
            errorMessage: turn.errorMessage?.slice(0, 240) ?? null,
            summary: { reason: turn.summary?.reason },
            meta: {
              userMessageId:
                typeof turn.meta?.userMessageId === "string"
                  ? turn.meta.userMessageId
                  : null,
            },
          },
        },
      }),
    ),
  );
}
