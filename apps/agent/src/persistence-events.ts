import { and, eq, inArray, sql } from "drizzle-orm";
import type { MessageRecord, SessionTurnRecord } from "@cohub/protocol/model";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { sessionTurns, spaceSessions, userProfiles } from "@cohub/db";
import { listResourceLabelRefs } from "@cohub/core/labels";
import { readRecordedTurnInitiator } from "@cohub/protocol/model";
import { publishSessionTurnStates } from "@cohub/core/sessions";
import { scheduleSessionSnapshot } from "./session-snapshot.js";
import { onTurnSettled } from "./turn-settled.js";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { publishRealtimeEnvelope, clearPersistedSessionStreamSnapshot } from "./redis.js";
import { pickRealtimeMessageMeta } from "./realtime-message-meta.js";
import { toTurnRecord } from "./persistence-records.js";

const fallbackDisplayName = (userUuid: string) => userUuid.replaceAll("-", "").slice(0, 8);

async function hydrateTurnAuthorProfile(turn: SessionTurnRecord): Promise<SessionTurnRecord> {
  if (!turn.userUuid) return { ...turn, authorProfile: null };
  const [profile] = await db.select({
    userUuid: userProfiles.userUuid,
    displayName: userProfiles.displayName,
    avatarUrl: userProfiles.avatarUrl,
  }).from(userProfiles).where(eq(userProfiles.userUuid, turn.userUuid)).limit(1);
  return {
    ...turn,
    authorProfile: profile
      ? {
          userUuid: profile.userUuid,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl ?? null,
        }
      : {
          userUuid: turn.userUuid,
          displayName: fallbackDisplayName(turn.userUuid),
          avatarUrl: null,
        },
  };
}

export async function publishMessagePersisted(spaceId: string, message: MessageRecord) {
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.message.persisted",
    spaceId,
    sessionId: message.sessionId,
    payload: {
      message: { ...message, text: message.content.length > 0 ? null : message.text, meta: pickRealtimeMessageMeta(message.meta) },
    },
  });
}

export async function publishTurnState(spaceId: string, turn: SessionTurnRecord) {
  await publishSessionTurnStates(db, spaceId, [turn], publishRealtimeEnvelope).catch((error) => {
    logger.warn("[Realtime] failed to publish user turn state", { sessionId: turn.sessionId, error });
  });
}

export async function publishTurnCreated(spaceId: string, turn: SessionTurnRecord) {
  const hydratedTurn = await hydrateTurnAuthorProfile(turn);
  await publishRealtimeEnvelope({ domain: "session", type: "session.turn.created", spaceId, sessionId: hydratedTurn.sessionId, payload: { turn: hydratedTurn } });
  await publishTurnState(spaceId, hydratedTurn);
}

const truncateTurnPreview = (text: string | null | undefined) => {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

export async function publishSessionTurnsUpdated(input: {
  sessionId: string;
  turnIds: string[];
}) {
  const turnIds = [...new Set(input.turnIds.filter(Boolean))];
  if (turnIds.length === 0) return;
  const rows = await db.select({
    turn: sessionTurns,
    spaceId: spaceSessions.spaceId,
    sessionUserUuid: spaceSessions.userUuid,
    sessionMeta: sql<unknown>`jsonb_build_object('participants', ${spaceSessions.meta}->'participants')`,
  }).from(sessionTurns).innerJoin(
    spaceSessions,
    eq(spaceSessions.id, sessionTurns.sessionId),
  ).where(and(
    eq(sessionTurns.sessionId, input.sessionId),
    inArray(sessionTurns.id, turnIds),
  ));
  await Promise.all(rows.map(async ({ turn, spaceId }) => {
    const record = toTurnRecord(turn);
    await publishRealtimeEnvelope({
      domain: "session",
      type: "session.turn.updated",
      spaceId,
      sessionId: input.sessionId,
      payload: { turn: record },
    });
  }));
  const first = rows[0];
  if (first) {
    await publishSessionTurnStates(db, first.spaceId, rows.map(({ turn }) => toTurnRecord(turn)), publishRealtimeEnvelope, {
      id: input.sessionId, spaceId: first.spaceId, userUuid: first.sessionUserUuid, meta: first.sessionMeta,
    }).catch((error) => logger.warn("[Realtime] failed to publish user turn states", { sessionId: input.sessionId, error }));
  }
}

export async function publishTurnFinalized(spaceId: string, turn: SessionTurnRecord) {
  void scheduleSessionSnapshot(turn.sessionId, turn.sequence);
  void onTurnSettled(turn);
  await clearPersistedSessionStreamSnapshot(spaceId, turn.sessionId, turn.id);
  const sessionLabelRefs = await listResourceLabelRefs({
    db,
    spaceId,
    resourceType: "session",
    resourceRef: turn.sessionId,
  }).catch((error) => {
    logger.warn("[Realtime] failed to load session labels for finalized turn", {
      spaceId,
      sessionId: turn.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.turn.finalized",
    spaceId,
    sessionId: turn.sessionId,
    payload: { turn, sessionLabelRefs },
  });
  await publishTurnState(spaceId, turn);
  if (!turn.userUuid) return;
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.turn.notify",
    spaceId,
    sessionId: turn.sessionId,
    rooms: [getRealtimeUserRoom(turn.userUuid)],
    payload: {
      spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      status: turn.status,
      initiator: readRecordedTurnInitiator(turn.meta),
      finishReason: turn.summary?.finishReason ?? null,
      userPreview: truncateTurnPreview(turn.userText),
      durationMs: turn.durationMs,
      stepCount: turn.intermediateSummary?.messageCount ?? null,
      sequence: turn.sequence ?? null,
      provider: turn.provider,
      model: turn.model,
      completedAt: turn.completedAt,
    },
  });
}
