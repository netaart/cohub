import { QueueEvents, type Job } from "bullmq";
import {
  buildSpaceFsCopyJobId,
  buildSpaceFsCopyResultKey,
  SPACE_FS_COPY_JOB,
  type SpaceFsCopyJobData,
  type SpaceFsCopyJobResult,
  type SpaceFsCopyRecord,
} from "@cohub/core/space-fs";
import { COHUB_SYSTEM_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import type { SpaceFsCopyStats } from "@cohub/protocol/fs";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";

export const SPACE_FS_COPY_MAX_WAIT_MS = 20_000;

export type SpaceFsCopyState =
  | { status: "queued" | "running"; progress?: SpaceFsCopyStats }
  | { status: "finished"; outcome: SpaceFsCopyJobResult };

type CopyRef = { targetSpaceId: string; copyId: string; actorUserId: string };
type CopyJob = Job<SpaceFsCopyJobData, SpaceFsCopyJobResult, string>;

const FAILED: SpaceFsCopyJobResult = { ok: false, status: 500, code: "copy_failed", message: "failed to copy files" };

let queue: ReturnType<typeof createBullmqQueue<SpaceFsCopyJobData, SpaceFsCopyJobResult>> | null = null;
let queueEvents: Promise<QueueEvents> | null = null;

function getQueue() {
  queue ??= createBullmqQueue<SpaceFsCopyJobData, SpaceFsCopyJobResult>(COHUB_SYSTEM_QUEUE, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: "cohub-api-space-fs-copy",
  });
  return queue;
}

function getQueueEvents() {
  queueEvents ??= (async () => {
    const events = new QueueEvents(COHUB_SYSTEM_QUEUE, { connection: createBullmqConnectionOptions(config.bullmqRedisUrl) });
    await events.waitUntilReady();
    return events;
  })();
  return queueEvents;
}

const getJob = async (ref: CopyRef) =>
  await getQueue().getJob(buildSpaceFsCopyJobId(ref.targetSpaceId, ref.copyId)) as CopyJob | undefined;

async function getRecord(ref: CopyRef) {
  const raw = await redisCommandClient.get(buildSpaceFsCopyResultKey(config.env, ref.targetSpaceId, ref.copyId)).catch(() => null);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SpaceFsCopyRecord;
    return record.actorUserId === ref.actorUserId ? record.outcome : null;
  } catch {
    return null;
  }
}

async function readState(ref: CopyRef): Promise<SpaceFsCopyState | null> {
  const outcome = await getRecord(ref);
  if (outcome) return { status: "finished", outcome };
  const job = await getJob(ref);
  if (!job || job.data.actorUserId !== ref.actorUserId) return null;
  const state = await job.getState();
  if (state === "completed") return { status: "finished", outcome: job.returnvalue ?? FAILED };
  if (state === "failed") return { status: "finished", outcome: FAILED };
  const progress = job.progress && typeof job.progress === "object" ? job.progress as SpaceFsCopyStats : undefined;
  return { status: state === "active" ? "running" : "queued", ...(progress ? { progress } : {}) };
}

async function settle(ref: CopyRef, job: CopyJob, waitMs: number) {
  if (waitMs > 0) {
    try {
      await job.waitUntilFinished(await getQueueEvents(), waitMs);
    } catch {
    }
  }
  return readState(ref);
}

export async function startSpaceFsCopy(data: Omit<SpaceFsCopyJobData, "requestId" | "trace">): Promise<SpaceFsCopyState> {
  const ref = { targetSpaceId: data.targetSpaceId, copyId: data.copyId, actorUserId: data.actorUserId };
  const outcome = await getRecord(ref);
  if (outcome) return { status: "finished", outcome };
  const job = await getJob(ref) ?? await getQueue().add(SPACE_FS_COPY_JOB, {
    ...data,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: buildSpaceFsCopyJobId(data.targetSpaceId, data.copyId),
    attempts: 1,
    ...defaultJobRetention,
  }) as CopyJob;
  return await settle(ref, job, SPACE_FS_COPY_MAX_WAIT_MS) ?? { status: "finished", outcome: FAILED };
}

export async function getSpaceFsCopy(ref: CopyRef, waitMs: number): Promise<SpaceFsCopyState | null> {
  const job = await getJob(ref);
  if (job && job.data.actorUserId !== ref.actorUserId) return null;
  return job ? settle(ref, job, Math.min(Math.max(waitMs, 0), SPACE_FS_COPY_MAX_WAIT_MS)) : readState(ref);
}
