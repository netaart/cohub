import type { Job } from "bullmq";
import { CHECKPOINT_COMPACT_JOB, compactCheckpointCovers, type CheckpointCompactJobData } from "../../../checkpoint/compact.js";
import { registerSystemJob } from "../../registry.js";

registerSystemJob(CHECKPOINT_COMPACT_JOB, async (job: Job) => compactCheckpointCovers(job.data as CheckpointCompactJobData));
