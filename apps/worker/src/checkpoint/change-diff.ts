import { join } from "node:path";
import {
  buildCommitDiffSummary,
  materializeFilePatches,
  type CheckpointDiffFilePatchMeta,
  type PrecomputedDiffFile,
  type PrecomputedDiffStats,
  type PrecomputedDiffSummary,
} from "./diff-precompute.js";
import type { FileIndexEntry } from "./file-index.js";
import { writeBlobs, writeTree, type BlobSource, type ObjectBuilder } from "./objects.js";
import { assetPointerContent } from "./snapshot.js";
import type { TreeLeaf } from "./trees.js";

const SUMMARY_MAX_FILES = 500;

type Change = { path: string; before: FileIndexEntry | undefined; after: TreeLeaf | undefined };

/**
 * Diff a save against its parent from the change list alone. Old contents
 * come from `latest`, which holds the parent's files, and each one must hash
 * to the id the index recorded; otherwise, or past 500 changes, the summary
 * lists paths without line counts and the API diffs on demand.
 */
export async function diffChanges(input: {
  builder: ObjectBuilder;
  latestDir: string;
  latestMatchesParent: boolean;
  changes: Change[];
  assetPaths: Set<string>;
  checkpointId: string;
  commitHash: string;
  parentCheckpointId: string | null;
  parentCommitHash: string | null;
  spaceId: string;
}): Promise<{ summary: PrecomputedDiffSummary; stats: PrecomputedDiffStats; patches?: Record<string, CheckpointDiffFilePatchMeta> }> {
  const changes = [...input.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const old = changes.filter((change) => change.before);
  if (changes.length <= SUMMARY_MAX_FILES && (old.length === 0 || input.latestMatchesParent)) {
    const sources = old.map((change): BlobSource => {
      const before = change.before as FileIndexEntry;
      if (before.asset) return { kind: "content", content: assetPointerContent({ path: change.path, size: before.size, ...before.asset }) };
      return { kind: before.type, path: join(input.latestDir, change.path) };
    });
    const oids = await writeBlobs(input.builder, sources).catch(() => null);
    if (oids?.every((oid, index) => oid === old[index]?.before?.oid)) {
      const oldTree = await writeTree(input.builder, old.map((change) => ({ path: change.path, mode: (change.before as FileIndexEntry).mode, oid: (change.before as FileIndexEntry).oid })));
      const newTree = await writeTree(input.builder, changes.filter((change) => change.after).map((change) => ({ path: change.path, ...(change.after as TreeLeaf) })));
      const repoDir = input.builder.env.GIT_DIR as string;
      const diff = await buildCommitDiffSummary({ repoDir, checkpointId: input.checkpointId, commitHash: newTree, parentCheckpointId: input.parentCheckpointId, parentCommitHash: oldTree, assetPaths: input.assetPaths });
      const patches = await materializeFilePatches({ repoDir, parentCommitHash: oldTree, commitHash: newTree, files: diff.summary.files, spaceId: input.spaceId, checkpointId: input.checkpointId, tmpDir: input.builder.tmpDir });
      diff.summary.baseCommitHash = input.parentCommitHash;
      diff.summary.headCommitHash = input.commitHash;
      return { ...diff, patches };
    }
  }

  const stats: PrecomputedDiffStats = { changedFileCount: 0, addedFileCount: 0, modifiedFileCount: 0, deletedFileCount: 0, renamedFileCount: 0, copiedFileCount: 0, additions: 0, deletions: 0 };
  const files: PrecomputedDiffFile[] = [];
  for (const { path, before, after } of changes) {
    const status = !before ? "A" : !after ? "D" : (before.mode === "120000") !== (after.mode === "120000") ? "T" : "M";
    stats.changedFileCount += 1;
    if (status === "A") stats.addedFileCount += 1;
    else if (status === "D") stats.deletedFileCount += 1;
    else stats.modifiedFileCount += 1;
    const asset = input.assetPaths.has(path);
    if (files.length < SUMMARY_MAX_FILES) files.push({ status, path, oldPath: null, additions: null, deletions: null, binary: asset, asset });
  }
  const summary: PrecomputedDiffSummary = {
    baseCheckpointId: input.parentCheckpointId,
    baseCommitHash: input.parentCommitHash,
    headCheckpointId: input.checkpointId,
    headCommitHash: input.commitHash,
    files,
    truncated: changes.length > SUMMARY_MAX_FILES,
    stats,
    precomputed: true,
    delivery: "inline",
  };
  return { summary, stats };
}
