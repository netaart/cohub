import type { Job } from "bullmq";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import {
  backfillCheckpointStoragePage,
  CHECKPOINT_STORAGE_BACKFILL_JOB,
  type CheckpointStorageBackfillJobData,
} from "../../../checkpoint/backfill.js";
import { config } from "../../../config.js";
import { registerSystemJob } from "../../registry.js";

let queue: ReturnType<typeof createBullmqQueue<CheckpointStorageBackfillJobData>> | null = null;

registerSystemJob(CHECKPOINT_STORAGE_BACKFILL_JOB, async (job: Job) => {
  const data = job.data as CheckpointStorageBackfillJobData;
  const { results, nextCursor } = await backfillCheckpointStoragePage(data);
  if (nextCursor) {
    queue ??= createBullmqQueue<CheckpointStorageBackfillJobData>(COHUB_SYSTEM_QUEUE, {
      redisUrl: config.bullmqRedisUrl,
      telemetryServiceName: "cohub-worker-checkpoint-backfill",
    });
    await queue.add(CHECKPOINT_STORAGE_BACKFILL_JOB, { ...data, cursor: nextCursor }, { jobId: `${CHECKPOINT_STORAGE_BACKFILL_JOB}-${nextCursor}`, ...defaultJobRetention });
  }
  return { processed: results.length, results, nextCursor };
});
