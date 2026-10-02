import { randomUUID } from "node:crypto";
import type { sessionMessages } from "@cohub/db";
import { sessionTurns } from "@cohub/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RealtimeMessageRecord, RealtimeSessionRecord, RealtimeTaskRecord, RealtimeTurnRecord, SpacePresenceSnapshot } from "@cohub/protocol/realtime";
import { getRealtimeSpaceRoom, getRealtimeUserRoom } from "@cohub/protocol/realtime";
import type { MessageRecord, SessionActiveTurn, SessionRecord, SessionTurnRecord } from "@cohub/protocol/model";
import type { TaskRunStatus } from "@cohub/protocol/task";
import { dispatchRealtimeEvent } from "./channels.js";
import { buildResourceLabelSnapshot, type LabelResourceType } from "@cohub/core/labels/resource-events";
import { db } from "./db/index.js";
import { activeTurnFromRow, activeTurnFromTurn, ACTIVE_TURN_STATUSES, isActiveTurnStatus } from "./session-active-turns.js";

const toIsoOrNull = (value: Date | string | null | undefined) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
};

const toIso = (value: Date | string | null | undefined) => toIsoOrNull(value) ?? new Date().toISOString();

const toTaskRunStatus = (value: string): TaskRunStatus =>
  value === "running" || value === "completed" || value === "failed" ? value : "pending";

const pickRealtimeMessageMeta = (meta: Record<string, unknown> | null | undefined) => {
  if (!meta) return null;
  const keys = [
    "messageKind",
    "messageOrdinal",
    "clientMessageId",
    "anchorUserMessageId",
    "userId",
    "contentDetail",
    "contentPlaceholder",
    "historySummary",
    "turnId",
    "messageId",
  ];
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (meta[key] !== undefined) picked[key] = meta[key];
  }
  return Object.keys(picked).length > 0 ? picked : null;
};

export const toRealtimeSessionRecord = (session: SessionRecord | {
  id: string;
  spaceId: string;
  userUuid?: string | null;
  title: string | null;
  source: string | null;
  status: string | null;
  externalSessionId: string | null;
  latestMessageText?: string | null;
  lastMessageAt: Date | string | null;
  lastMessageId: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  activeTurn?: SessionActiveTurn | null;
  activeTurnSequence?: number;
}): RealtimeSessionRecord => ({
  id: session.id,
  spaceId: session.spaceId,
  userUuid: session.userUuid ?? null,
  title: session.title,
  source: session.source,
  status: session.status,
  ...(session.activeTurn !== undefined
    ? { activeTurn: session.activeTurn }
    : {}),
  ...(session.activeTurnSequence !== undefined
    ? { activeTurnSequence: session.activeTurnSequence }
    : {}),
  externalSessionId: session.externalSessionId,
  latestMessageText: session.latestMessageText ?? null,
  lastMessageAt: toIsoOrNull(session.lastMessageAt),
  lastMessageId: session.lastMessageId,
  createdAt: toIso(session.createdAt),
  updatedAt: toIso(session.updatedAt),
});

export const messageRecordFromRow = (message: typeof sessionMessages.$inferSelect): MessageRecord => ({
  ...message,
  role: message.role as MessageRecord["role"],
  meta: message.meta && typeof message.meta === "object" && !Array.isArray(message.meta) ? message.meta as Record<string, unknown> : null,
  startedAt: toIsoOrNull(message.startedAt),
  completedAt: toIsoOrNull(message.completedAt),
  createdAt: toIso(message.createdAt),
});

export const toRealtimeMessageRecord = (message: MessageRecord): RealtimeMessageRecord => ({
  id: message.id,
  sessionId: message.sessionId,
  role: message.role,
  content: message.content,
  text: message.content.length > 0 ? null : message.text,
  sequence: message.sequence,
  provider: message.provider,
  model: message.model,
  stopReason: message.stopReason,
  errorMessage: message.errorMessage,
  usage: message.usage,
  meta: pickRealtimeMessageMeta(message.meta),
  startedAt: message.startedAt,
  completedAt: message.completedAt,
  durationMs: message.durationMs,
  createdAt: message.createdAt,
});

export const toRealtimeTurnRecord = (turn: SessionTurnRecord): RealtimeTurnRecord => ({
  id: turn.id,
  sessionId: turn.sessionId,
  sequence: turn.sequence,
  executionKind: turn.executionKind,
  status: turn.status,
  intent: turn.intent,
  userUuid: turn.userUuid,
  authorProfile: turn.authorProfile,
  userContent: turn.userContent,
  userText: turn.userText,
  assistantContent: turn.assistantContent,
  assistantText: turn.assistantText,
  provider: turn.provider,
  model: turn.model,
  stopReason: turn.stopReason,
  errorMessage: turn.errorMessage,
  finalUsage: turn.finalUsage,
  totalUsage: turn.totalUsage,
  summary: turn.summary,
  intermediateIndex: turn.intermediateIndex,
  intermediateSummary: turn.intermediateSummary,
  harnessIndex: turn.harnessIndex ?? null,
  meta: turn.meta,
  thinkingLevel: turn.thinkingLevel ?? null,
  startedAt: turn.startedAt,
  completedAt: turn.completedAt,
  durationMs: turn.durationMs,
  createdAt: turn.createdAt,
  updatedAt: turn.updatedAt,
});

export const toRealtimeTaskRecord = (task: {
  id: string;
  jobId: string;
  cronJobId: string | null;
  taskType: string;
  status: string;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  userUuid: string | null;
  attemptCount: number;
  scheduledAt: Date | string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  errorMessage: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}): RealtimeTaskRecord => ({
  id: task.id,
  type: task.taskType,
  status: toTaskRunStatus(task.status),
  jobId: task.jobId,
  cronJobId: task.cronJobId,
  spaceId: task.spaceId,
  sessionId: task.sessionId,
  turnId: task.turnId,
  userId: task.userUuid,
  attemptCount: task.attemptCount,
  scheduledAt: toIsoOrNull(task.scheduledAt),
  startedAt: toIsoOrNull(task.startedAt),
  finishedAt: toIsoOrNull(task.finishedAt),
  errorMessage: task.errorMessage,
  createdAt: toIso(task.createdAt),
  updatedAt: toIso(task.updatedAt),
});

export async function dispatchSessionCreated(session: Parameters<typeof toRealtimeSessionRecord>[0]) {
  const realtimeSession = toRealtimeSessionRecord(session);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.created",
    spaceId: realtimeSession.spaceId,
    sessionId: realtimeSession.id,
    payload: { session: realtimeSession },
  });
}

export async function dispatchSessionUpdated(input: {
  session: Parameters<typeof toRealtimeSessionRecord>[0];
  changed: string[];
}) {
  if (input.changed.length === 0) return;
  const realtimeSession = toRealtimeSessionRecord(input.session);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.updated",
    spaceId: realtimeSession.spaceId,
    sessionId: realtimeSession.id,
    payload: { session: realtimeSession, changed: input.changed },
  });
}

const activeTurnDispatches = new Map<string, Promise<void>>();

async function dispatchSessionActiveTurnNow(input: {
  spaceId: string;
  sessionId: string;
  userUuid?: string | null;
  activeTurn: SessionActiveTurn | null;
  activeTurnSequence: number;
}) {
  const rooms = [getRealtimeSpaceRoom(input.spaceId)];
  if (input.userUuid) rooms.push(getRealtimeUserRoom(input.userUuid));
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.updated",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    rooms,
    payload: {
      session: {
        id: input.sessionId,
        spaceId: input.spaceId,
        activeTurn: input.activeTurn,
        activeTurnSequence: input.activeTurnSequence,
      },
      changed: ["activeTurn", "activeTurnSequence"],
    },
  });
}

export async function dispatchSessionActiveTurn(input: {
  spaceId: string;
  sessionId: string;
  turn: SessionTurnRecord;
}) {
  const previous = activeTurnDispatches.get(input.sessionId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const activeTurn = isActiveTurnStatus(input.turn.status)
        ? activeTurnFromTurn(input.turn)
        : await (async () => {
            const [active] = await db
              .select({
                sessionId: sessionTurns.sessionId,
                id: sessionTurns.id,
                sequence: sessionTurns.sequence,
                status: sessionTurns.status,
                provider: sessionTurns.provider,
                model: sessionTurns.model,
                startedAt: sessionTurns.startedAt,
                meta: sessionTurns.meta,
              })
              .from(sessionTurns)
              .where(and(
                eq(sessionTurns.sessionId, input.sessionId),
                inArray(sessionTurns.status, [...ACTIVE_TURN_STATUSES]),
              ))
              .orderBy(desc(sessionTurns.sequence))
              .limit(1);
            return activeTurnFromRow(active ?? null);
          })();
      await dispatchSessionActiveTurnNow({
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        userUuid: input.turn.userUuid,
        activeTurn,
        activeTurnSequence: activeTurn?.sequence ?? input.turn.sequence,
      });
    });
  activeTurnDispatches.set(input.sessionId, current);
  await current.finally(() => {
    if (activeTurnDispatches.get(input.sessionId) === current) activeTurnDispatches.delete(input.sessionId);
  });
}

export async function dispatchTurnCreated(input: {
  spaceId: string;
  sessionId: string;
  turn: SessionTurnRecord;
  requestId?: string | null;
}) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.created",
    requestId: input.requestId ?? null,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    payload: {
      turn: toRealtimeTurnRecord(input.turn),
    },
  });
  await dispatchSessionActiveTurn({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turn: input.turn,
  });
}

export async function dispatchTaskCreated(task: Parameters<typeof toRealtimeTaskRecord>[0]) {
  const realtimeTask = toRealtimeTaskRecord(task);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "task.created",
    spaceId: realtimeTask.spaceId,
    sessionId: realtimeTask.sessionId,
    payload: {
      task: realtimeTask,
      ...(realtimeTask.userId && !realtimeTask.spaceId ? { userId: realtimeTask.userId } : {}),
    },
  });
}

export async function dispatchTaskUpdated(input: {
  task: Parameters<typeof toRealtimeTaskRecord>[0];
  changed: string[];
}) {
  if (input.changed.length === 0) return;
  const realtimeTask = toRealtimeTaskRecord(input.task);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "task.updated",
    spaceId: realtimeTask.spaceId,
    sessionId: realtimeTask.sessionId,
    payload: {
      task: realtimeTask,
      changed: input.changed,
      ...(realtimeTask.userId && !realtimeTask.spaceId ? { userId: realtimeTask.userId } : {}),
    },
  });
}

export async function dispatchSpacePresenceUpdated(snapshot: SpacePresenceSnapshot) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "space.presence.updated",
    spaceId: snapshot.spaceId,
    sessionId: null,
    payload: snapshot,
  });
}

export async function dispatchLabelAssignmentsUpdated(input: {
  spaceId: string;
  resourceType: LabelResourceType;
  resourceRef: string;
  sessionId?: string | null;
  affectedLabelIds?: string[];
}) {
  const snapshot = await buildResourceLabelSnapshot({ db, ...input });
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "label",
    type: "label.assignments.updated",
    spaceId: input.spaceId,
    sessionId: input.sessionId ?? (input.resourceType === "session" ? input.resourceRef : null),
    payload: {
      resourceType: input.resourceType,
      resourceRef: input.resourceRef,
      labels: snapshot.labels,
      assignments: snapshot.assignments,
      items: snapshot.items,
      affectedLabelIds: snapshot.affectedLabelIds,
    },
  });
}
