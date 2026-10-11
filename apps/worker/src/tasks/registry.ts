import { serializeBillingBlocked, isBillingAccessBlockedError } from "@cohub/billing";
import type { Job } from "bullmq";
import { recordJobFailure } from "@cohub/infra/bullmq";
import type { TaskPayload } from "@cohub/protocol/task";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db.js";
import { taskRuns } from "@cohub/db";
import { dispatchTaskCreated, dispatchTaskUpdated } from "../realtime-events.js";
import { createLogger } from "@cohub/infra/logging";
import { failGenerationSession } from "./generation-session.js";
import { TaskRunFailure } from "./task-run-failure.js";


const logger = createLogger({ serviceName: "cohub-worker" });
export type TaskHandlerContext = {
  taskRunId: string;
};

export type TaskHandler = (
  job: Job,
  context?: TaskHandlerContext,
) => Promise<Record<string, unknown> | undefined>;

const registry = new Map<string, TaskHandler>();

/**
 * Register a task handler. Automatically wrapped with task_runs lifecycle management.
 *
 * Lifecycle:
 *   - If task_runs exists (API-enqueued → pending): update to running
 *   - If not (cron-spawned): insert as running
 *   - On success: update to completed
 *   - On failure: update to failed (then rethrow for BullMQ retry)
 */
function billingFailureResult(error: unknown) {
  if (!isBillingAccessBlockedError(error)) return null;
  return { error: serializeBillingBlocked(error) };
}

function failureResult(error: unknown): Record<string, unknown> | null {
  return billingFailureResult(error) ?? (error instanceof TaskRunFailure ? error.result : null);
}

export const markTaskRunFailed = async (job: Job, error: unknown) => {
  const jobId = job.id;
  if (!jobId) return;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const result = failureResult(error);
  const [taskRun] = await db
    .update(taskRuns)
    .set({
      status: "failed",
      result,
      errorMessage,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(taskRuns.jobId, jobId), ne(taskRuns.status, "failed")))
    .returning();

  if (taskRun) {
    await dispatchTaskUpdated({
      task: taskRun,
      changed: ["status", "result", "errorMessage", "finishedAt"],
    }).catch((dispatchError) => logger.warn("[Realtime] failed to dispatch task.updated", dispatchError));
  }
};

export const registerTask = (type: string, handler: TaskHandler) => {
  const wrapped: TaskHandler = async (job) => {
    const jobId = job.id;
    if (!jobId) throw new Error("Job has no id");

    const payload = job.data as TaskPayload;
    const now = new Date();

    // UPSERT: insert if cron-spawned, or update pending → running
    const existing = await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.jobId, jobId))
      .limit(1);

    let taskRunId = existing[0]?.id ?? crypto.randomUUID();

    if (existing.length > 0) {
      // Already exists (API-enqueued with pending status)
      const [taskRun] = await db
        .update(taskRuns)
        .set({
          status: "running",
          startedAt: now,
          attemptCount: job.attemptsMade,
          updatedAt: now,
        })
        .where(eq(taskRuns.jobId, jobId))
        .returning();
      if (taskRun) {
        await dispatchTaskUpdated({
          task: taskRun,
          changed: ["status", "startedAt", "attemptCount"],
        }).catch((error) => logger.warn("[Realtime] failed to dispatch task.updated", error));
      }
    } else {
      // Cron-spawned or manually enqueued — first time we see this job.
      // Use onConflictDoNothing to handle retry after DB write interruption.
      const inserted = await db.insert(taskRuns).values({
        id: taskRunId,
        jobId,
        cronJobId: payload.cronJobId ?? null,
        taskType: job.name,
        status: "running",
        payload,
        spaceId: payload.spaceId ?? null,
        sessionId: payload.sessionId ?? null,
        turnId: payload.turnId ?? null,
        userUuid: payload.userId ?? null,
        startedAt: now,
        attemptCount: job.attemptsMade,
      }).onConflictDoNothing().returning();

      if (inserted[0]?.id) {
        taskRunId = inserted[0].id;
        await dispatchTaskCreated(inserted[0]).catch((error) => logger.warn("[Realtime] failed to dispatch task.created", error));
      } else {
        const [createdByPeer] = await db
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .where(eq(taskRuns.jobId, jobId))
          .limit(1);
        if (!createdByPeer) throw new Error(`Task run not found after insert conflict for job ${jobId}`);
        taskRunId = createdByPeer.id;
      }
    }

    try {
      const result = await handler(job, { taskRunId });

      const [taskRun] = await db
        .update(taskRuns)
        .set({
          status: "completed",
          result: result ?? null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taskRuns.jobId, jobId))
        .returning();
      if (taskRun) {
        await dispatchTaskUpdated({
          task: taskRun,
          changed: ["status", "result", "finishedAt"],
        }).catch((error) => logger.warn("[Realtime] failed to dispatch task.updated", error));
      }

      return result;
    } catch (error) {
      if (job.name === "generation") {
        await failGenerationSession({ taskRunId, payload, error }).catch((sessionError) => {
          logger.warn("[GenerationSession] failed to persist failure", sessionError);
        });
      }
      await recordJobFailure(job, error, {
        reason: "task_failed",
        meta: {
          taskRunId,
          taskType: job.name,
          spaceId: payload.spaceId ?? null,
          sessionId: payload.sessionId ?? null,
          turnId: payload.turnId ?? null,
          cronJobId: payload.cronJobId ?? null,
        },
      });

      await markTaskRunFailed(job, error);

      throw error; // Rethrow so BullMQ handles retry/backoff
    }
  };

  registry.set(type, wrapped);
};

export const getTaskHandler = (type: string): TaskHandler | undefined => {
  return registry.get(type);
};

export const getRegisteredTasks = () => {
  return Array.from(registry.keys());
};
