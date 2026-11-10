import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECKPOINT_COVER_FANOUT,
  initCheckpointRepo,
  installPacks,
  isCommitOid,
  readCheckpointManifest,
  runCheckpointGit,
} from "@cohub/core/checkpoint/storage";
import { config } from "../config.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";
import { checkpointObjectStore } from "./assets.js";
import { coverLevelsEndingAt, readCover, tilesSequence, uploadPack, writeCover } from "./manifest.js";
import { builtPack } from "./objects.js";

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

/** Covers are built off the save path, so they can afford a bounded delta search over every object. */
const COVER_PACK_CONFIG = ["-c", "pack.window=10", "-c", "pack.threads=1", "-c", "pack.windowMemory=64m", "-c", "pack.deltaCacheSize=16m", "-c", "core.packedGitWindowSize=16m", "-c", "core.packedGitLimit=64m", "-c", "core.deltaBaseCacheLimit=16m"];

/** The `oids` a v2 pack index lists, by binary search over the file (20 bytes read per probe). */
async function packIndexLookup(idxPath: string, oids: string[]) {
  const handle = await open(idxPath, "r");
  try {
    const header = Buffer.alloc(8 + 256 * 4);
    await handle.read(header, 0, header.length, 0);
    if (header.readUInt32BE(0) !== 0xff744f63 || header.readUInt32BE(4) !== 2) throw new Error(`unsupported pack index ${idxPath}`);
    const probe = Buffer.alloc(20);
    const found = new Set<string>();
    for (const oid of oids) {
      const target = Buffer.from(oid, "hex");
      const first = target[0] as number;
      let low = first === 0 ? 0 : header.readUInt32BE(8 + (first - 1) * 4);
      let high = header.readUInt32BE(8 + first * 4);
      while (low < high) {
        const middle = (low + high) >>> 1;
        await handle.read(probe, 0, 20, header.length + middle * 20);
        const order = probe.compare(target);
        if (order === 0) {
          found.add(oid);
          break;
        }
        if (order < 0) low = middle + 1;
        else high = middle;
      }
    }
    return found;
  } finally {
    await handle.close();
  }
}

/**
 * Every object the range's commits reference must be in the range's packs or
 * in the base commit's closure; otherwise a manifest cannot rebuild some
 * checkpoint. Saves name reused objects by id without reading them, so this
 * is where a broken id is caught. Memory follows the range, not the history:
 * missing ids are looked up in the base manifest's pack indexes on disk.
 */
async function verifyRange(input: { repoDir: string; tmpDir: string; tip: string; base: string }) {
  const { stdout } = await runCheckpointGit(["rev-list", "--objects", "--missing=print", input.tip], { cwd: input.repoDir });
  let missing = stdout.split("\n").filter((line) => line.startsWith("?")).map((line) => line.slice(1));
  if (missing.length === 0) return;
  const baseManifest = await readCheckpointManifest(checkpointObjectStore, input.base);
  if (!baseManifest) throw new Error(`checkpoint manifest missing for ${input.base}`);
  for (const pack of baseManifest.packs) {
    const idxPath = join(input.tmpDir, `base-${pack.checksum}_idx`);
    if (!await checkpointObjectStore.download(pack.idxKey, idxPath)) throw new Error(`checkpoint pack index missing: ${pack.idxKey}`);
    const found = await packIndexLookup(idxPath, missing);
    missing = missing.filter((oid) => !found.has(oid));
    await rm(idxPath, { force: true });
    if (missing.length === 0) return;
  }
  throw new Error(`checkpoint range ending at ${input.tip} references ${missing.length} objects stored nowhere: ${missing.slice(0, 5).join(", ")}`);
}

/**
 * Build the cover packs ending at `commit` on worker-local disk. A level-k
 * cover is the union of the packs its range already has in the commit's
 * manifest (saves, or lower covers), recompressed with deltas. The first
 * level also checks that the range references only stored objects.
 */
export async function compactCheckpointCovers(data: CheckpointCompactJobData) {
  if (!isCommitOid(data.commit)) throw new Error("invalid commit");
  const levels = coverLevelsEndingAt(data.seq);
  if (levels.length === 0) return { built: [] as number[] };
  const manifest = await readCheckpointManifest(checkpointObjectStore, data.commit);
  if (!manifest) throw new Error(`checkpoint manifest missing for ${data.commit}`);
  const tmpDir = getWorkerLocalTmpDir("checkpoint-compact", data.commit);
  const built: number[] = [];
  try {
    await ensureWorkerLocalTmpDir(tmpDir);
    const repoDir = join(tmpDir, "repo");
    await initCheckpointRepo(repoDir);
    for (const level of levels) {
      if (await readCover(data.commit, level)) continue;
      const span = CHECKPOINT_COVER_FANOUT ** level;
      const first = data.seq - span + 1;
      const packs = manifest.packs.filter((pack) => pack.first >= first && pack.last <= data.seq);
      if (!tilesSequence(packs, first, data.seq)) throw new Error(`manifest of ${data.commit} does not tile ${first}..${data.seq}`);
      await installPacks(checkpointObjectStore, repoDir, packs);
      if (level === 1) {
        // `log` would read the parent, which lives outside the range; read the raw commit instead.
        const firstInRange = (await runCheckpointGit(["rev-parse", "--verify", `${data.commit}~${span - 1}`], { cwd: repoDir })).stdout.trim();
        const raw = (await runCheckpointGit(["cat-file", "commit", firstInRange], { cwd: repoDir })).stdout;
        const base = /^parent ([0-9a-f]{40})$/m.exec(raw)?.[1] ?? "";
        if (!isCommitOid(base)) throw new Error(`cannot resolve the base of ${data.commit}`);
        await verifyRange({ repoDir, tmpDir, tip: data.commit, base });
      }
      const outDir = join(tmpDir, `L${level}`);
      await mkdir(outDir, { recursive: true });
      const { stdout } = await runCheckpointGit(
        [...COVER_PACK_CONFIG, "pack-objects", "--stdin-packs", "--no-reuse-object", "--delta-base-offset", "-q", join(outDir, "pack")],
        { cwd: repoDir, input: `${packs.map((pack) => `pack-${pack.checksum}.pack`).join("\n")}\n` },
      );
      const ref = await uploadPack(data.spaceId, await builtPack(outDir, stdout), { first, last: data.seq, tip: data.commit });
      await writeCover({ version: 1, level, pack: ref });
      built.push(level);
    }
    return { built };
  } finally {
    await removeWorkerLocalTmpDir(tmpDir).catch(() => undefined);
  }
}
