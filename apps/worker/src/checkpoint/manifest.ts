import {
  CHECKPOINT_COVER_FANOUT,
  CHECKPOINT_COVER_MAX_LEVEL,
  checkpointCoverKey,
  checkpointManifestKey,
  checkpointPackKey,
  parseCoverRecord,
  type CheckpointCoverRecord,
  type CheckpointPackRef,
  type CheckpointStorageManifest,
} from "@cohub/core/checkpoint/storage";
import { checkpointObjectStore, putCheckpointJsonIfMissing, uploadObjectFileIfMissing } from "./assets.js";
import type { BuiltPack } from "./objects.js";

const PACK_MIME = "application/x-git-packed-objects";

export async function uploadPack(spaceId: string, pack: BuiltPack, range: { first: number; last: number; tip: string }): Promise<CheckpointPackRef> {
  const packKey = checkpointPackKey(spaceId, pack.checksum, "pack");
  const idxKey = checkpointPackKey(spaceId, pack.checksum, "idx");
  await uploadObjectFileIfMissing({ filePath: pack.packPath, objectKey: packKey, size: pack.size, mimeType: PACK_MIME });
  await uploadObjectFileIfMissing({ filePath: pack.idxPath, objectKey: idxKey, size: pack.idxSize, mimeType: PACK_MIME });
  return { checksum: pack.checksum, packKey, idxKey, size: pack.size, idxSize: pack.idxSize, ...range };
}

/** Packs must tile 0..seq without gaps for the closure invariant to hold. */
export function tilesSequence(packs: CheckpointPackRef[], first: number, last: number) {
  const sorted = [...packs].sort((a, b) => a.first - b.first);
  let next = first;
  for (const pack of sorted) {
    if (pack.first !== next) return false;
    next = pack.last + 1;
  }
  return next === last + 1;
}

export async function readCover(tip: string, level: number): Promise<CheckpointCoverRecord | null> {
  const raw = await checkpointObjectStore.readText(checkpointCoverKey(tip, level));
  return raw ? parseCoverRecord(raw) : null;
}

/** Replace runs of packs with the cover packs compaction has already built for them. */
export async function foldCovers(packs: CheckpointPackRef[], read: typeof readCover = readCover) {
  let result = [...packs];
  for (let level = 1; level <= CHECKPOINT_COVER_MAX_LEVEL; level += 1) {
    const span = CHECKPOINT_COVER_FANOUT ** level;
    for (const end of result.filter((pack) => pack.last >= span && pack.last % span === 0)) {
      const first = end.last - span + 1;
      const inRange = result.filter((pack) => pack.first >= first && pack.last <= end.last);
      if (inRange.length < 2 || !tilesSequence(inRange, first, end.last)) continue;
      const cover = await read(end.tip, level);
      if (!cover || cover.pack.first !== first || cover.pack.last !== end.last || cover.pack.tip !== end.tip) continue;
      result = [...result.filter((pack) => !inRange.includes(pack)), cover.pack];
    }
  }
  return result.sort((a, b) => a.first - b.first);
}

export function buildManifest(input: { commit: string; parent: CheckpointStorageManifest | null; parentCommit: string | null; pack: CheckpointPackRef }): CheckpointStorageManifest {
  if (!input.parent) return { version: 1, commit: input.commit, parent: input.parentCommit, seq: 0, packs: [input.pack] };
  return { version: 1, commit: input.commit, parent: input.parentCommit, seq: input.parent.seq + 1, packs: [...input.parent.packs, input.pack] };
}

export const writeManifest = (manifest: CheckpointStorageManifest) =>
  putCheckpointJsonIfMissing(checkpointManifestKey(manifest.commit), manifest);

export const writeCover = (cover: CheckpointCoverRecord) =>
  putCheckpointJsonIfMissing(checkpointCoverKey(cover.pack.tip, cover.level), cover);

export const coverLevelsEndingAt = (seq: number) => {
  const levels: number[] = [];
  for (let level = 1; level <= CHECKPOINT_COVER_MAX_LEVEL; level += 1) {
    const span = CHECKPOINT_COVER_FANOUT ** level;
    if (seq < span || seq % span !== 0) break;
    levels.push(level);
  }
  return levels;
};
