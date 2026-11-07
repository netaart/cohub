import { join } from "node:path";
import { asc, eq, gt } from "drizzle-orm";
import { checkpoints, spaces } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { checkpointGitDir, checkpointManifestKey, hasCommit } from "@cohub/core/checkpoint/storage";
import { db } from "../db.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";
import { checkpointObjectExists } from "./assets.js";
import { uploadPack, writeManifest } from "./manifest.js";
import { packObjects } from "./objects.js";
import { mapLimit } from "./limit.js";
import { getCheckpointSystemRepoDir } from "./paths.js";

export const CHECKPOINT_STORAGE_BACKFILL_JOB = "checkpoint.storage_backfill";

export type CheckpointStorageBackfillJobData = { spaceId?: string; cursor?: string | null; batch?: number };

const logger = createLogger({ serviceName: "cohub-worker" });

async function filterAsync<T>(items: T[], limit: number, predicate: (item: T) => Promise<boolean>) {
  const keep = await mapLimit(items, limit, predicate);
  return items.filter((_, index) => keep[index]);
}

/**
 * Upload a space's pre-v3 checkpoint history: one pack holding every legacy
 * commit, and a baseline manifest for each commit that has none.
 */
export async function backfillSpaceCheckpointStorage(spaceId: string) {
  const rows = await db.select({ commitHash: checkpoints.commitHash }).from(checkpoints).where(eq(checkpoints.spaceId, spaceId));
  const commits = [...new Set(rows.map((row) => row.commitHash))];
  const missing = await filterAsync(commits, 8, async (commit) => !await checkpointObjectExists(checkpointManifestKey(commit)));
  if (missing.length === 0) return { spaceId, written: 0, unavailable: [] as string[] };

  const repoDir = getCheckpointSystemRepoDir(spaceId);
  const present = await filterAsync(missing, 8, (commit) => hasCommit(repoDir, commit));
  const unavailable = missing.filter((commit) => !present.includes(commit));
  const [tip] = present;
  if (!tip) return { spaceId, written: 0, unavailable };

  const tmpDir = getWorkerLocalTmpDir("checkpoint-backfill", spaceId);
  try {
    await ensureWorkerLocalTmpDir(tmpDir);
    const pack = await packObjects({ env: { GIT_DIR: checkpointGitDir(repoDir) }, cwd: repoDir, outDir: join(tmpDir, "pack"), include: present, exclude: [] });
    const ref = await uploadPack(spaceId, pack, { first: 0, last: 0, tip });
    const written = await filterAsync(present, 8, (commit) => writeManifest({ version: 1, commit, parent: null, seq: 0, packs: [{ ...ref, tip: commit }] }));
    return { spaceId, written: written.length, unavailable };
  } finally {
    await removeWorkerLocalTmpDir(tmpDir).catch(() => undefined);
  }
}

/** Backfill one page of spaces; the caller re-enqueues with the returned cursor. */
export async function backfillCheckpointStoragePage(data: CheckpointStorageBackfillJobData) {
  const batch = Math.min(Math.max(data.batch ?? 20, 1), 200);
  const page = data.spaceId
    ? [{ id: data.spaceId }]
    : await db.select({ id: spaces.id }).from(spaces).where(data.cursor ? gt(spaces.id, data.cursor) : undefined).orderBy(asc(spaces.id)).limit(batch);
  const results = [];
  for (const space of page) {
    try {
      results.push(await backfillSpaceCheckpointStorage(space.id));
    } catch (error) {
      logger.warn("[CheckpointBackfill] space failed", { spaceId: space.id, error });
      results.push({ spaceId: space.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const nextCursor = !data.spaceId && page.length === batch ? page.at(-1)?.id ?? null : null;
  return { results, nextCursor };
}
