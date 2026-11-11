import { listSpaceAudienceUserIds } from "@cohub/core/permissions";
import { createSessionSnapshotScheduler, publishSessionSnapshot, publishSessionTurnStates } from "@cohub/core/sessions";
import { isSettledStatsTurn } from "@cohub/protocol/model";
import { db } from "./db.js";
import { randomUUID } from "node:crypto";
import { getRealtimeUserRoom, REALTIME_OUTBOUND_CHANNEL, type RealtimeTaskRecord } from "@cohub/protocol/realtime";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { TaskRunStatus } from "@cohub/protocol/task";
import { redisCommandClient } from "./redis.js";
import { enqueueSpaceHookFromEvent } from "./space-hooks.js";
import { syncSessionBoardsLater } from "./board-session-sync.js";
import { syncFinishedTaskBoards } from "./board-task-sync.js";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-worker" });

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

async function publishCronJobRunFinished(task: { cronJobId: string; userUuid: string; spaceId: string | null }) {
  const audience = (task.spaceId && (await listSpaceAudienceUserIds(db, task.spaceId, [task.userUuid]))) || [task.userUuid];
  await redisCommandClient.publish(
    REALTIME_OUTBOUND_CHANNEL,
    JSON.stringify({
      id: randomUUID(),
      timestamp: Date.now(),
      domain: "space",
      type: "cronjob.list.changed",
      rooms: audience.map(getRealtimeUserRoom),
      payload: { cronJobId: task.cronJobId, spaceId: task.spaceId, revision: new Date().toISOString() },
    }),
  );
}

export const dispatchTaskCreated = (task: Parameters<typeof toRealtimeTaskRecord>[0]) =>
  publishTaskEvent({ type: "task.created", task });

export const dispatchTaskUpdated = async (input: {
  task: Parameters<typeof toRealtimeTaskRecord>[0];
  changed: string[];
}) => {
  const finished = input.task.status === "completed" || input.task.status === "failed";
  if (finished && input.task.sessionId && input.task.taskType === "generation") {
    void scheduleSessionSnapshot(input.task.sessionId);
  }
  if (finished) void syncFinishedTaskBoards(input.task).catch((error) => logger.warn("[BoardTasks] sync failed", { taskRunId: input.task.id, error }));
  if (finished && input.task.cronJobId && input.task.userUuid) void publishCronJobRunFinished({ cronJobId: input.task.cronJobId, userUuid: input.task.userUuid, spaceId: input.task.spaceId }).catch((error) => logger.warn("[CronJob] list notify failed", { taskRunId: input.task.id, error }));
  await publishTaskEvent({ type: "task.updated", task: input.task, changed: input.changed });
};

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
  await publishSessionTurnStates(db, input.spaceId, [input.turn], (event) => redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(event)))
    .catch((error) => console.warn("[Realtime] failed to publish user turn state", { sessionId: input.turn.sessionId, error }));
}

export const dispatchTurnCreated = (input: { spaceId: string; turn: SessionTurnRecord }) =>
  dispatchTurnEvent({ type: "session.turn.created", ...input });

export const scheduleSessionSnapshot = createSessionSnapshotScheduler(
  async (sessionId, fromSequence) => {
    await publishSessionSnapshot(db, sessionId, (event) => redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(event)), fromSequence);
    void syncSessionBoardsLater(sessionId);
  },
  (error, sessionId) => console.warn("[Realtime] failed to publish session snapshot", { sessionId, error }),
);

export async function dispatchTurnUpdated(input: { spaceId: string; turn: SessionTurnRecord }) {
  if (isSettledStatsTurn(input.turn)) void scheduleSessionSnapshot(input.turn.sessionId, input.turn.sequence);
  await dispatchTurnEvent({ type: "session.turn.updated", ...input });
}
