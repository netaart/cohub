import { refreshSessionStatsAndPublish } from "@cohub/core/sessions";
import { isSettledStatsTurn } from "@cohub/protocol/model";
import { db } from "./db.js";
import { randomUUID } from "node:crypto";
import { REALTIME_OUTBOUND_CHANNEL, type RealtimeSessionRecord, type RealtimeTaskRecord } from "@cohub/protocol/realtime";
import type { spaceSessions } from "@cohub/db";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { TaskRunStatus } from "@cohub/protocol/task";
import { redisCommandClient } from "./redis.js";
import { enqueueSpaceHookFromEvent } from "./space-hooks.js";

const toIsoOrNull = (value: Date | string | null | undefined) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
};

const toIso = (value: Date | string | null | undefined) => toIsoOrNull(value) ?? new Date().toISOString();

const toTaskRunStatus = (value: string): TaskRunStatus =>
  value === "running" || value === "completed" || value === "failed" ? value : "pending";

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

async function publishTaskEvent(input: {
  type: "task.created" | "task.updated";
  task: Parameters<typeof toRealtimeTaskRecord>[0];
  changed?: string[];
}) {
  const task = toRealtimeTaskRecord(input.task);
  if (!task.spaceId && !task.userId) return;

  const id = randomUUID();
  const timestamp = Date.now();
  const payload = {
    task,
    ...(input.changed ? { changed: input.changed } : {}),
    ...(task.userId && !task.spaceId ? { userId: task.userId } : {}),
  };

  // Same pattern as publishSpaceEvent: realtime push and hook dispatch run in
  // parallel; hooks only apply to space-scoped events. Re-entrancy protection
  // (space_hook tasks and their derived run_command children) lives in
  // maybeEnqueueSpaceHookTask.
  await Promise.all([
    redisCommandClient.publish(
      REALTIME_OUTBOUND_CHANNEL,
      JSON.stringify({
        id,
        timestamp,
        domain: "space",
        type: input.type,
        spaceId: task.spaceId,
        sessionId: task.sessionId,
        payload,
      }),
    ),
    task.spaceId
      ? enqueueSpaceHookFromEvent({
          id,
          type: input.type,
          timestamp,
          spaceId: task.spaceId,
          sessionId: task.sessionId,
          payload,
        })
      : Promise.resolve(null),
  ]);
}

export const dispatchTaskCreated = (task: Parameters<typeof toRealtimeTaskRecord>[0]) =>
  publishTaskEvent({ type: "task.created", task });

export const dispatchTaskUpdated = async (input: {
  task: Parameters<typeof toRealtimeTaskRecord>[0];
  changed: string[];
}) => {
  if (input.task.sessionId && ["generation", "generation.billing_retry"].includes(input.task.taskType) && ["completed", "failed"].includes(input.task.status)) {
    await refreshWorkerSessionStats(input.task.sessionId);
  }
  await publishTaskEvent({ type: "task.updated", task: input.task, changed: input.changed });
};

export async function dispatchSessionUpdated(input: { session: typeof spaceSessions.$inferSelect; changed: string[] }) {
  const session: RealtimeSessionRecord = {
    id: input.session.id,
    spaceId: input.session.spaceId,
    userUuid: input.session.userUuid ?? null,
    title: input.session.title,
    source: input.session.source,
    status: input.session.status,
    externalSessionId: input.session.externalSessionId,
    latestMessageText: input.session.latestMessageText ?? null,
    lastMessageAt: toIsoOrNull(input.session.lastMessageAt),
    lastMessageId: input.session.lastMessageId,
    createdAt: toIso(input.session.createdAt),
    updatedAt: toIso(input.session.updatedAt),
  };
  await redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify({
    id: randomUUID(), timestamp: Date.now(), domain: "session", type: "session.updated",
    spaceId: session.spaceId, sessionId: session.id,
    payload: { session, changed: input.changed },
  }));
}

async function dispatchTurnEvent(input: {
  type: "session.turn.created" | "session.turn.updated";
  spaceId: string;
  turn: SessionTurnRecord;
}) {
  await redisCommandClient.publish(
    REALTIME_OUTBOUND_CHANNEL,
    JSON.stringify({
      id: randomUUID(),
      timestamp: Date.now(),
      domain: "session",
      type: input.type,
      spaceId: input.spaceId,
      sessionId: input.turn.sessionId,
      payload: { turn: input.turn },
    }),
  );
}

export const dispatchTurnCreated = (input: { spaceId: string; turn: SessionTurnRecord }) =>
  dispatchTurnEvent({ type: "session.turn.created", ...input });

export async function refreshWorkerSessionStats(sessionId: string) {
  await refreshSessionStatsAndPublish(db, sessionId, (event) => redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(event)))
    .catch((error) => console.warn("[Metrics] failed to refresh session stats", error));
}

export async function dispatchTurnUpdated(input: { spaceId: string; turn: SessionTurnRecord }) {
  if (isSettledStatsTurn(input.turn)) await refreshWorkerSessionStats(input.turn.sessionId);
  await dispatchTurnEvent({ type: "session.turn.updated", ...input });
}
