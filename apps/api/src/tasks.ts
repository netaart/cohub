import { COHUB_TASKS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { enqueueTaskRun } from "@cohub/core/tasks";
import { deleteCronJobNotificationOverride } from "@cohub/core/preferences";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { cronJobs } from "@cohub/db";
import type { TaskPayload, TaskScheduleConfig } from "@cohub/protocol/task";
import { GENERATION_TASK_TYPE } from "@cohub/protocol/generation";
import { dispatchTaskCreated } from "./realtime-events.js";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
type TaskEnqueueOptions = Omit<JobsOptions, "scheduledAt"> & { scheduledAt?: Date | null; taskRunId?: string };

const QUEUE_NAME = COHUB_TASKS_QUEUE;

/** bullmq v6 job scheduler id for a cron job; stored in cronJobs.bullJobKey. */
const cronSchedulerId = (cronJobId: string) => `cron-${cronJobId}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function removeCronScheduler(schedulerId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await taskQueue.removeJobScheduler(schedulerId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to remove scheduler ${schedulerId}`);
}

export const taskQueue = createBullmqQueue(QUEUE_NAME, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api",
});

export const SUPPORTED_TASK_TYPES = new Set<string>(["send_message", "save_checkpoint", "create_space", "run_command", "space_hook", GENERATION_TASK_TYPE]);

export const enqueueTask = async (
  payload: TaskPayload,
  opts?: TaskEnqueueOptions,
) => enqueueTaskRun({
  db,
  payload,
  options: opts,
  enqueue: (name, taskPayload, options) => taskQueue.add(name, taskPayload, options),
  onTaskCreated: (taskRun) => dispatchTaskCreated(taskRun).catch((error) => {
    logger.warn("[Realtime] failed to dispatch task.created", error);
  }),
});

export const createCronJob = async (params: {
  userId: string;
  title: string;
  taskType: string;
  payload: Record<string, unknown>;
  schedule: TaskScheduleConfig;
  spaceId?: string | null;
  sessionId?: string | null;
}) => {
  const cronJobResult = await db.insert(cronJobs).values({
    userUuid: params.userId,
    title: params.title,
    taskType: params.taskType,
    payload: params.payload,
    cronExpression: params.schedule.pattern,
    timezone: params.schedule.timezone ?? "Asia/Shanghai",
    bullJobKey: "",
    spaceId: params.spaceId ?? null,
    sessionId: params.sessionId ?? null,
  }).returning();

  const cronJob = cronJobResult[0];
  if (!cronJob) throw new Error("Failed to create cron job record");

  let schedulerId: string | null = null;
  try {
    schedulerId = await replaceCronScheduler(cronJob.id, {
      taskType: params.taskType,
      payload: params.payload,
      cronExpression: params.schedule.pattern,
      timezone: params.schedule.timezone ?? "Asia/Shanghai",
      userUuid: params.userId,
      spaceId: params.spaceId,
      sessionId: params.sessionId,
    });

    await db
      .update(cronJobs)
      .set({ bullJobKey: schedulerId })
      .where(eq(cronJobs.id, cronJob.id));

    const [createdJob] = await db
      .select()
      .from(cronJobs)
      .where(eq(cronJobs.id, cronJob.id))
      .limit(1);
    if (!createdJob) throw new Error("Failed to load cron job record after scheduling");

    return createdJob;
  } catch (queueError) {
    if (schedulerId) {
      try {
        await removeCronScheduler(schedulerId);
      } catch (cleanupError) {
        logger.warn("[CronJob] failed to clean up scheduler after create failure", {
          cronJobId: cronJob.id,
          schedulerId,
          error: cleanupError,
        });
      }
    }
    try {
      await db
        .update(cronJobs)
        .set({ enabled: false, bullJobKey: schedulerId ?? "", updatedAt: new Date() })
        .where(eq(cronJobs.id, cronJob.id));
    } catch (persistenceError) {
      logger.warn("[CronJob] failed to persist failed create state", {
        cronJobId: cronJob.id,
        schedulerId,
        error: persistenceError,
      });
    }

    throw new Error(
      `Cron job record created but failed to schedule in queue: ${queueError instanceof Error ? queueError.message : String(queueError)}`,
    );
  }
};

/** Returns whether the owner's notification override for the job was removed with it. */
export const removeCronJob = async (job: { id: string; userUuid: string }) => {
  await removeCronScheduler(cronSchedulerId(job.id));
  return db.transaction(async (tx) => {
    await tx
      .update(cronJobs)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(cronJobs.id, job.id));
    // Notifications go to the owner, so only their preferences can reference the job.
    return deleteCronJobNotificationOverride(tx, job.userUuid, job.id);
  });
};

export const disableCronJob = async (cronJobId: string) => {
  await removeCronScheduler(cronSchedulerId(cronJobId));
  await db
    .update(cronJobs)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(cronJobs.id, cronJobId));
};

type CronJobScheduleData = {
  taskType: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  userUuid: string;
  spaceId?: string | null;
  sessionId?: string | null;
};

const cronJobOptions = {
  ...defaultJobRetention,
  attempts: 3,
  backoff: { type: "exponential", delay: 60_000 },
};

async function replaceCronScheduler(
  cronJobId: string,
  jobData: CronJobScheduleData,
  previousSchedulerId?: string,
) {
  const schedulerId = cronSchedulerId(cronJobId);

  const taskPayload: TaskPayload = {
    type: jobData.taskType,
    spaceId: jobData.spaceId ?? undefined,
    sessionId: jobData.sessionId ?? undefined,
    userId: jobData.userUuid,
    data: jobData.payload,
    cronJobId,
  };

  await taskQueue.upsertJobScheduler(
    schedulerId,
    { pattern: jobData.cronExpression, tz: jobData.timezone },
    {
      name: jobData.taskType,
      data: taskPayload,
      opts: cronJobOptions,
    },
  );

  if (previousSchedulerId && previousSchedulerId !== schedulerId) {
    try {
      await removeCronScheduler(previousSchedulerId);
    } catch (error) {
      await removeCronScheduler(schedulerId).catch((cleanupError) => {
        logger.warn("[CronJob] failed to roll back new scheduler after cleanup failure", {
          cronJobId,
          schedulerId,
          error: cleanupError,
        });
      });
      throw error;
    }
  }

  return schedulerId;
}

const cronJobScheduleData = (job: CronJobRow): CronJobScheduleData => ({
  taskType: job.taskType,
  payload: job.payload as Record<string, unknown>,
  cronExpression: job.cronExpression,
  timezone: job.timezone,
  userUuid: job.userUuid,
  spaceId: job.spaceId,
  sessionId: job.sessionId,
});

export const enableCronJob = async (cronJobId: string, jobData: CronJobScheduleData) => {
  const schedulerId = await replaceCronScheduler(cronJobId, jobData);

  try {
    await db
      .update(cronJobs)
      .set({ enabled: true, bullJobKey: schedulerId, updatedAt: new Date() })
      .where(eq(cronJobs.id, cronJobId));
  } catch (error) {
    try {
      await removeCronScheduler(schedulerId);
    } catch (cleanupError) {
      logger.warn("[CronJob] failed to remove scheduler after enable persistence failure", {
        cronJobId,
        schedulerId,
        error: cleanupError,
      });
      try {
        await db
          .update(cronJobs)
          .set({ enabled: true, bullJobKey: schedulerId, updatedAt: new Date() })
          .where(eq(cronJobs.id, cronJobId));
      } catch (persistenceError) {
        logger.warn("[CronJob] failed to persist scheduler after enable failure", {
          cronJobId,
          schedulerId,
          error: persistenceError,
        });
      }
    }
    throw error;
  }

  const [enabledJob] = await db
    .select()
    .from(cronJobs)
    .where(eq(cronJobs.id, cronJobId))
    .limit(1);
  if (!enabledJob) throw new Error("Failed to load enabled cron job");

  return enabledJob;
};

type CronJobRow = typeof cronJobs.$inferSelect;

type CronJobUpdatePatch = {
  title?: string;
  payload?: Record<string, unknown>;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export const updateCronJob = async (
  current: CronJobRow,
  patch: CronJobUpdatePatch,
) => {
  const next = {
    ...current,
    ...patch,
  };
  const changesReschedule =
    patch.payload !== undefined ||
    patch.cronExpression !== undefined ||
    patch.timezone !== undefined;

  if (next.enabled && changesReschedule) {
    const [updatedConfig] = await db
      .update(cronJobs)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
        ...(patch.cronExpression !== undefined ? { cronExpression: patch.cronExpression } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(cronJobs.id, current.id))
      .returning();
    if (!updatedConfig) throw new Error("Failed to update cron job");

    let nextSchedulerId: string | null = null;
    try {
      nextSchedulerId = await replaceCronScheduler(
        current.id,
        cronJobScheduleData(updatedConfig),
        current.bullJobKey,
      );
      const [updatedJob] = await db
        .update(cronJobs)
        .set({ bullJobKey: nextSchedulerId, enabled: true, updatedAt: new Date() })
        .where(eq(cronJobs.id, current.id))
        .returning();
      if (!updatedJob) throw new Error("Failed to persist cron job schedule");
      return updatedJob;
    } catch (error) {
      if (nextSchedulerId) {
        await removeCronScheduler(nextSchedulerId).catch((cleanupError) => {
          logger.warn("[CronJob] failed to remove partially scheduled repeat job", { cronJobId: current.id, error: cleanupError });
        });
      }
      const [rolledBack] = await db
        .update(cronJobs)
        .set({
          title: current.title,
          payload: current.payload,
          cronExpression: current.cronExpression,
          timezone: current.timezone,
          bullJobKey: current.bullJobKey,
          enabled: current.enabled,
          updatedAt: new Date(),
        })
        .where(eq(cronJobs.id, current.id))
        .returning();
      if (!rolledBack) logger.warn("[CronJob] failed to roll back cron job after reschedule failure", { cronJobId: current.id });
      if (current.enabled) {
        try {
          const restoredBullJobKey = await replaceCronScheduler(
            current.id,
            cronJobScheduleData(current),
            current.bullJobKey,
          );
          await db
            .update(cronJobs)
            .set({ bullJobKey: restoredBullJobKey, enabled: true, updatedAt: new Date() })
            .where(eq(cronJobs.id, current.id));
        } catch (restoreError) {
          logger.warn("[CronJob] failed to restore previous repeat job after reschedule failure", { cronJobId: current.id, error: restoreError });
        }
      }
      throw error;
    }
  }

  if (patch.enabled === true && !current.enabled) {
    const enabledJob = await enableCronJob(current.id, cronJobScheduleData({ ...current, ...patch }));
    if (patch.title === undefined) return enabledJob;
    const [updatedJob] = await db
      .update(cronJobs)
      .set({ title: patch.title, updatedAt: new Date() })
      .where(eq(cronJobs.id, current.id))
      .returning();
    if (!updatedJob) throw new Error("Failed to update cron job");
    return updatedJob;
  }

  if (patch.enabled === false && current.enabled) {
    await disableCronJob(current.id);
  }

  const [updatedJob] = await db
    .update(cronJobs)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      ...(patch.cronExpression !== undefined ? { cronExpression: patch.cronExpression } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(cronJobs.id, current.id))
    .returning();
  if (!updatedJob) throw new Error("Failed to update cron job");
  return updatedJob;
};
