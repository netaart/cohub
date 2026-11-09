import { join } from "node:path";
import {
  buildCommitDiffSummary,
  materializeFilePatches,
  type CheckpointDiffFilePatchMeta,
  type PrecomputedDiffStats,
  type PrecomputedDiffSummary,
} from "./diff-precompute.js";
import type { FileIndexEntry } from "./file-index.js";
import { writeBlobs, writeTree, type BlobSource, type ObjectBuilder } from "./objects.js";
import { assetPointerContent } from "./snapshot.js";
import type { TreeLeaf } from "./trees.js";

type Change = { path: string; before: FileIndexEntry | undefined; after: TreeLeaf | undefined };

type DiffResult = { summary: PrecomputedDiffSummary; stats: PrecomputedDiffStats; patches: Record<string, CheckpointDiffFilePatchMeta> };

/**
 * Diff a save against its parent from the change list: git diffs two small
 * trees holding only the changed paths, so renames, line counts and patches
 * match a full tree diff. Old contents come from `latest`, which holds the
 * parent's files; returns null unless every one hashes to the id the index
 * recorded, and the API then diffs on demand.
 */
export async function diffChanges(input: {
  builder: ObjectBuilder;
  latestDir: string;
  changes: Change[];
  assetPaths: Set<string>;
  checkpointId: string;
  commitHash: string;
  parentCheckpointId: string | null;
  parentCommitHash: string | null;
  spaceId: string;
}): Promise<DiffResult | null> {
  const old = input.changes.filter((change) => change.before);
  const sources = old.map((change): BlobSource => {
    const before = change.before as FileIndexEntry;
    if (before.asset) return { kind: "content", content: assetPointerContent({ path: change.path, size: before.size, ...before.asset }) };
    return { kind: before.type, path: join(input.latestDir, change.path) };
  });
  const oids = await writeBlobs(input.builder, sources).catch(() => null);
  if (!oids?.every((oid, index) => oid === old[index]?.before?.oid)) return null;
  const oldTree = await writeTree(input.builder, old.map((change) => ({ path: change.path, mode: (change.before as FileIndexEntry).mode, oid: (change.before as FileIndexEntry).oid })));
  const newTree = await writeTree(input.builder, input.changes.filter((change) => change.after).map((change) => ({ path: change.path, ...(change.after as TreeLeaf) })));
  const repoDir = input.builder.env.GIT_DIR as string;
  const diff = await buildCommitDiffSummary({ repoDir, checkpointId: input.checkpointId, commitHash: newTree, parentCheckpointId: input.parentCheckpointId, parentCommitHash: oldTree, assetPaths: input.assetPaths });
  const patches = await materializeFilePatches({ repoDir, parentCommitHash: oldTree, commitHash: newTree, files: diff.summary.files, spaceId: input.spaceId, checkpointId: input.checkpointId, tmpDir: input.builder.tmpDir });
  diff.summary.baseCommitHash = input.parentCommitHash;
  diff.summary.headCommitHash = input.commitHash;
  return { ...diff, patches };
}
