import { withSpaceSaveLock } from "./lock.js";

export type SaveCheckpointProgress = Record<string, unknown>;

export type SaveCheckpointInput = {
  spaceId: string;
  userId?: string | null;
  description?: string | null;
  reason?: string;
  sourceTaskRunId?: string | null;
  requestSource?: import("@cohub/protocol/provenance").RequestSource | null;
  onProgress?: (progress: SaveCheckpointProgress) => Promise<void> | void;
};

export type SaveCheckpointResult = {
  checkpointId: string;
  commitHash: string;
  branch: string;
  commitMessage: string;
  changedFiles: number;
  assetCount: number;
  spaceId: string;
  latestSubPath: string;
  [key: string]: unknown;
};

export async function saveCheckpointWithLock(
  input: SaveCheckpointInput,
  save: (input: SaveCheckpointInput) => Promise<SaveCheckpointResult>,
): Promise<{ skipped: true; reason: "save_checkpoint_lock_busy"; spaceId: string } | SaveCheckpointResult> {
  const locked = await withSpaceSaveLock(input.spaceId, input.sourceTaskRunId ?? crypto.randomUUID(), () => save(input));
  if (!locked.acquired) return { skipped: true, reason: "save_checkpoint_lock_busy", spaceId: input.spaceId };
  return locked.result;
}
