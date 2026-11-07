import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  CHECKPOINT_COVER_FANOUT,
  checkpointGitDir,
  ensureCheckpointCommits,
  isCommitOid,
  runCheckpointGit,
} from "@cohub/core/checkpoint/storage";
import { join } from "node:path";
import { config } from "../config.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";
import { checkpointObjectStore } from "./assets.js";
import { coverLevelsEndingAt, readCover, uploadPack, writeCover } from "./manifest.js";
import { packObjects } from "./objects.js";
import { getCheckpointSystemRepoDir } from "./paths.js";

export const CHECKPOINT_COMPACT_JOB = "checkpoint.compact";

export type CheckpointCompactJobData = { spaceId: string; commit: string; seq: number };

const logger = createLogger({ serviceName: "cohub-worker" });

let queue: ReturnType<typeof createBullmqQueue<CheckpointCompactJobData>> | null = null;

/** Never throws: a missing cover only leaves more packs in later manifests. */
export function enqueueCheckpointCompaction(data: CheckpointCompactJobData) {
  if (coverLevelsEndingAt(data.seq).length === 0) return;
  queue ??= createBullmqQueue<CheckpointCompactJobData>(COHUB_SYSTEM_QUEUE, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: "cohub-worker-checkpoint-compact",
  });
  void queue.add(CHECKPOINT_COMPACT_JOB, data, {
    jobId: `${CHECKPOINT_COMPACT_JOB}-${data.commit}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    ...defaultJobRetention,
  }).catch((error) => logger.warn("[CheckpointCompact] failed to enqueue", { ...data, error }));
}

/**
 * Build the cover packs ending at `commit`. A level-k cover holds everything
 * reachable from the commit and not from its FANOUT^k-th ancestor, which is
 * exactly the union of the saves it replaces.
 */
export async function compactCheckpointCovers(data: CheckpointCompactJobData) {
  if (!isCommitOid(data.commit)) throw new Error("invalid commit");
  const levels = coverLevelsEndingAt(data.seq);
  if (levels.length === 0) return { built: [] as number[] };
  const repoDir = getCheckpointSystemRepoDir(data.spaceId);
  await ensureCheckpointCommits(checkpointObjectStore, repoDir, [data.commit]);
  const tmpDir = getWorkerLocalTmpDir("checkpoint-compact", data.commit);
  const built: number[] = [];
  try {
    await ensureWorkerLocalTmpDir(tmpDir);
    for (const level of levels) {
      if (await readCover(data.commit, level)) continue;
      const span = CHECKPOINT_COVER_FANOUT ** level;
      const env = { GIT_DIR: checkpointGitDir(repoDir) };
      const base = (await runCheckpointGit(["rev-parse", "--verify", `${data.commit}~${span}^{commit}`], { cwd: repoDir, env })).stdout.trim();
      const pack = await packObjects({ env, cwd: repoDir, outDir: join(tmpDir, `L${level}`), include: [data.commit], exclude: [base] });
      const ref = await uploadPack(data.spaceId, pack, { first: data.seq - span + 1, last: data.seq, tip: data.commit });
      await writeCover({ version: 1, level, pack: ref });
      built.push(level);
    }
    return { built };
  } finally {
    await removeWorkerLocalTmpDir(tmpDir).catch(() => undefined);
  }
}
