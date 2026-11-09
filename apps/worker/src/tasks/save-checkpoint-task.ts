import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { Job } from "bullmq";
import type { TaskPayload } from "@cohub/protocol/task";
import { normalizeRequestSource } from "@cohub/protocol/provenance";
import { HOME_SPACE_SLUG } from "@cohub/protocol/public-identifiers";
import { checkpoints, spaces } from "@cohub/db";
import { readCheckpointManifest } from "@cohub/core/checkpoint/storage";
import { checkpointForkReference } from "@cohub/core/references";
import { enqueueReferences } from "../reference-index-queue.js";
import { registerTask } from "./registry.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { publishUserConfigFromWorkspace, publishConfigFromWorkspace } from "../config-publish.js";
import { getGenerationsDir, publishGenerationsCacheFromDir } from "../generations-cache.js";
import { publishModelsCacheFromFile } from "../models-cache.js";
import { publishModelTasksCacheFromFile } from "../model-tasks-cache.js";
import { publishDecisionsCacheFromFile } from "../decisions-cache.js";
import { getPromptsDir, publishPromptsCacheFromDir } from "../prompts-cache.js";
import { getSkillsDir, publishSkillsCacheFromDir } from "../skills-cache.js";
import { publishSpaceEvent } from "../space-events.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";
import { checkpointObjectStore } from "../checkpoint/assets.js";
import { diffChanges } from "../checkpoint/change-diff.js";
import {
  materializeDiffMeta,
  type PrecomputedDiffStats,
  type CheckpointDiffMeta,
} from "../checkpoint/diff-precompute.js";
import { collectUserGitRepos } from "../checkpoint/git-bundles.js";
import { saveBoardCheckpointSnapshots } from "../checkpoint/board.js";
import { enqueueCheckpointCompaction } from "../checkpoint/compact.js";
import { type FileIndexEntry, loadFileIndex, loadStagedFileIndex, promoteFileIndex, stageFileIndex } from "../checkpoint/file-index.js";
import { foldCovers, tilesSequence, uploadPack, writeManifest } from "../checkpoint/manifest.js";
import { readLatestCommit, refreshLatest } from "../checkpoint/materialize.js";
import { findCheckpointForTaskRun, updateCheckpointMeta } from "../checkpoint/metadata.js";
import { createObjectBuilder, packObjects, writeCommit } from "../checkpoint/objects.js";
import { CHECKPOINT_ASSET_MANIFEST_PATH, CHECKPOINT_META_PATH, USER_GIT_REPOS_PATH, ensureCheckpointDirs, getCheckpointLatestSubPath } from "../checkpoint/paths.js";
import { saveCheckpointWithLock, type SaveCheckpointInput, type SaveCheckpointResult } from "../checkpoint/save.js";
import { buildSnapshot } from "../checkpoint/snapshot.js";
import { type ScannedFile, scanWorkspace } from "../checkpoint/scan.js";
import { writeTrees } from "../checkpoint/trees.js";

const SAVE_VERSION = 3;

/** For a run resumed after its worker died: what the staged index of `commit` changed against the last promoted one. */
async function indexChanges(systemDir: string, commit: string) {
  const [previous, staged] = await Promise.all([loadFileIndex(systemDir), loadStagedFileIndex(systemDir)]);
  if (!previous || staged?.commit !== commit) return null;
  const upserts = [...staged.entries].filter(([path, entry]) => previous.entries.get(path)?.oid !== entry.oid || previous.entries.get(path)?.mode !== entry.mode).map(([path]) => path);
  const deletes = [...previous.entries.keys()].filter((path) => !staged.entries.has(path));
  return { from: previous.commit, upserts, deletes };
}

const buildCommitMessage = (description?: string | null) => {
  const trimmed = description?.trim();
  return trimmed?.length ? `checkpoint: ${trimmed}` : "checkpoint: save from cohub";
};

type SaveCheckpointTimings = Record<string, number>;

type ConfigPublishWarning = {
  scope: "platform" | "user";
  target: "config_files" | "models_cache" | "model_tasks_cache" | "decisions_cache" | "generations_cache" | "prompts_cache" | "skills_cache";
  message: string;
};

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const timeIt = async <T>(timings: SaveCheckpointTimings, label: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const duration = Math.round(performance.now() - start);
    timings[label] = (timings[label] ?? 0) + duration;
    console.info(`[save_checkpoint] ⏱ ${label}: ${duration}ms`);
  }
};

export const saveCheckpointForSpace = async (input: SaveCheckpointInput): Promise<SaveCheckpointResult> => {
  const localTmpDir = getWorkerLocalTmpDir("checkpoint-save", input.spaceId, crypto.randomUUID());
  await ensureWorkerLocalTmpDir(localTmpDir);
  try {
    return await saveCheckpointInDir(input, localTmpDir);
  } finally {
    await removeWorkerLocalTmpDir(localTmpDir).catch(() => undefined);
  }
};

const saveCheckpointInDir = async (input: SaveCheckpointInput, localTmpDir: string): Promise<SaveCheckpointResult> => {
  const spaceId = input.spaceId;
  const description = input.description ?? null;

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) throw new Error("space not found");

  const timings: SaveCheckpointTimings = {};
  const progress = async (stage: string, extra?: Record<string, unknown>) => { await input.onProgress?.({ stage, updatedAt: new Date().toISOString(), timings, ...extra }); };
  await progress("prepare");
  // The task run id doubles as the checkpoint id, so a retried run can find what it already committed.
  const checkpointId = input.sourceTaskRunId ?? crypto.randomUUID();
  const createdAt = new Date();
  const branch = "main";
  const commitMessage = buildCommitMessage(description);
  const dirs = await timeIt(timings, "ensureCheckpointDirs", () => ensureCheckpointDirs(spaceId));
  const context: SaveContext = { input, space, dirs, timings, progress };

  const committed = input.sourceTaskRunId ? await findCheckpointForTaskRun(db, spaceId, input.sourceTaskRunId) : null;
  if (committed) return finishCheckpoint({ ...context, checkpoint: committed, latestChanges: null });

  const parentCheckpointId = space.headCheckpointId ?? null;
  const parent = parentCheckpointId
    ? (await db.select({ commitHash: checkpoints.commitHash, rootCheckpointId: checkpoints.rootCheckpointId }).from(checkpoints).where(eq(checkpoints.id, parentCheckpointId)).limit(1))[0] ?? null
    : null;
  if (parentCheckpointId && !parent) throw new Error(`head checkpoint ${parentCheckpointId} not found`);
  const parentCommitHash = parent?.commitHash ?? null;
  const rootCheckpointId = parentCheckpointId ? (parent?.rootCheckpointId ?? parentCheckpointId) : checkpointId;

  const parentManifest = parentCommitHash
    ? await timeIt(timings, "readParentManifest", async () => {
      const manifest = await readCheckpointManifest(checkpointObjectStore, parentCommitHash);
      return manifest && tilesSequence(manifest.packs, 0, manifest.seq) ? manifest : null;
    })
    : null;
  // A parent without a manifest predates object storage: this save becomes a parentless baseline with its full snapshot.
  const gitParent = parentManifest ? parentCommitHash : null;
  const previousIndex = gitParent
    ? await timeIt(timings, "loadFileIndex", async () => {
      const index = await loadFileIndex(dirs.systemDir);
      return index?.commit === gitParent ? index : null;
    })
    : null;

  await progress("scan_workspace");
  const scanStartedAtNs = BigInt(Date.now()) * 1_000_000n;
  const scan = await timeIt(timings, "scanWorkspace", () => scanWorkspace(dirs.workspaceDir));

  await progress("bundle_git_repos", { fileCount: scan.files.length, gitRepoCount: scan.gitRepos.length });
  const userGitRepos = await timeIt(timings, "collectUserGitRepos", () => collectUserGitRepos({
    workspaceDir: dirs.workspaceDir,
    systemDir: dirs.systemDir,
    repoPaths: scan.gitRepos.map((repo) => repo.path),
  }));

  const gitCheckpointMeta = {
    version: 1,
    saveVersion: SAVE_VERSION,
    spaceId,
    checkpointId,
    createdAt: createdAt.toISOString(),
    description: description?.trim() || "Checkpoint",
    branch,
  };

  await progress("upload_assets", { fileCount: scan.files.length });
  const builder = await createObjectBuilder(localTmpDir);
  const snapshot = await timeIt(timings, "writeObjects", () => buildSnapshot({
    builder,
    files: scan.files,
    previous: previousIndex,
    assetThresholdBytes: config.checkpointAssetThresholdBytes,
    scanStartedAtNs,
    systemFiles: { checkpointMeta: gitCheckpointMeta, userGitRepos: { version: 2, repos: userGitRepos } },
    onAssetTiming: (label, ms) => { timings[label] = (timings[label] ?? 0) + Math.round(ms); },
  }));
  const trees = await timeIt(timings, "writeTrees", () => writeTrees({ env: builder.env, cwd: localTmpDir, leaves: snapshot.leaves, dirty: snapshot.dirty, previous: previousIndex?.trees ?? new Map() }));
  const commitHash = await timeIt(timings, "writeCommit", () => writeCommit(builder, { tree: trees.root, parent: gitParent, message: commitMessage, date: createdAt }));

  await progress("commit_checkpoint", { commitHash });
  const seq = parentManifest ? parentManifest.seq + 1 : 0;
  const pack = await timeIt(timings, "packObjects", () => packObjects({
    env: builder.env,
    cwd: localTmpDir,
    outDir: join(localTmpDir, "pack"),
    objects: [...snapshot.blobs, ...trees.written, commitHash],
    fast: true,
  }));
  const packRef = await timeIt(timings, "uploadPack", () => uploadPack(spaceId, pack, { first: seq, last: seq, tip: commitHash }));

  const previousEntries = previousIndex?.entries ?? new Map<string, FileIndexEntry>();
  const assetPaths = new Set(snapshot.assets.map((asset) => asset.path));
  for (const [path, entry] of previousEntries) if (entry.asset) assetPaths.add(path);
  let diffStats: PrecomputedDiffStats = { changedFileCount: 0, addedFileCount: 0, modifiedFileCount: 0, deletedFileCount: 0, renamedFileCount: 0, copiedFileCount: 0, additions: 0, deletions: 0 };
  let diffMeta: CheckpointDiffMeta | null = null;
  // Against a pre-manifest parent nothing is known about what changed; the API diffs those on demand.
  if (gitParent || !parentCommitHash) {
    try {
      const diff = await timeIt(timings, "buildDiff", async () => diffChanges({
        builder,
        latestDir: dirs.latestDir,
        latestMatchesParent: await readLatestCommit(dirs.latestDir) === parentCommitHash,
        changes: [
          ...snapshot.changed.map((path) => ({ path, before: previousEntries.get(path), after: snapshot.leaves.get(path) })),
          ...snapshot.deleted.map((path) => ({ path, before: previousEntries.get(path), after: undefined })),
        ],
        assetPaths,
        checkpointId,
        commitHash,
        parentCheckpointId,
        parentCommitHash,
        spaceId,
      }));
      diffStats = diff.stats;
      diffMeta = await timeIt(timings, "materializeDiffMeta", () => materializeDiffMeta({ summary: diff.summary, commitHash, spaceId, checkpointId, tmpDir: localTmpDir, files: diff.patches }));
    } catch (error) {
      // Diff precompute must never fail a save. API can still compute on demand.
      console.warn(`[save_checkpoint] failed to materialize diff meta space=${spaceId} checkpoint=${checkpointId}:`, error);
    }
  }

  const manifest = await timeIt(timings, "writeManifest", async () => {
    const basePacks = parentManifest ? await foldCovers(parentManifest.packs) : [];
    const value = { version: 1 as const, commit: commitHash, parent: gitParent, seq, packs: [...basePacks, packRef] };
    await writeManifest(value);
    return value;
  });
  await timeIt(timings, "stageFileIndex", () => stageFileIndex(dirs.systemDir, { commit: commitHash, entries: snapshot.entries, trees: trees.trees }));

  const smallFiles = scan.files.filter((file) => !assetPaths.has(file.path));
  const smallFileCount = smallFiles.length;
  const smallFileBytes = smallFiles.reduce((sum, file) => sum + file.size, 0);
  const assetCount = snapshot.assets.length;
  const assetBytes = snapshot.assets.reduce((sum, asset) => sum + asset.size, 0);
  const detectedGitRepoCount = userGitRepos.length;
  const bundledGitRepoCount = userGitRepos.filter((repo) => repo.bundles.length > 0).length;
  const gitBundleBytes = userGitRepos.reduce((sum, repo) => sum + repo.bundles.reduce((total, bundle) => total + bundle.size, 0), 0);
  const stats = {
    fileCount: smallFileCount + assetCount,
    fileBytes: smallFileBytes + assetBytes,
    changedFileCount: diffStats.changedFileCount,
    addedFileCount: diffStats.addedFileCount,
    modifiedFileCount: diffStats.modifiedFileCount,
    deletedFileCount: diffStats.deletedFileCount,
    renamedFileCount: diffStats.renamedFileCount,
    copiedFileCount: diffStats.copiedFileCount,
    additions: diffStats.additions,
    deletions: diffStats.deletions,
    smallFileCount,
    smallFileBytes,
    assetCount,
    assetBytes,
    hashedFileCount: snapshot.hashedFileCount,
    ignoredCount: scan.ignoredCount,
    unsupportedCount: scan.warnings.length,
    detectedGitRepoCount,
    bundledGitRepoCount,
    gitBundleBytes,
    packBytes: pack.size,
  };

  await progress("write_checkpoint_record");
  const checkpoint = await timeIt(timings, "writeCheckpointRecord", () => db.transaction(async (tx) => {
    const boards = await saveBoardCheckpointSnapshots(tx, { checkpointId, spaceId });
    const [row] = await tx.insert(checkpoints).values({
      id: checkpointId,
      spaceId,
      commitHash,
      description: description?.trim() || "Checkpoint",
      parentCheckpointId,
      rootCheckpointId,
      saveVersion: SAVE_VERSION,
      meta: {
        version: SAVE_VERSION,
        branch,
        commitMessage,
        paths: {
          assetManifest: CHECKPOINT_ASSET_MANIFEST_PATH,
          checkpointMeta: CHECKPOINT_META_PATH,
          userGitRepos: USER_GIT_REPOS_PATH,
          latestSubPath: getCheckpointLatestSubPath(spaceId),
        },
        storage: { seq: manifest.seq, packCount: manifest.packs.length, baseline: !parentManifest },
        board: { snapshotCount: boards.count },
        stats,
        timings,
        ...(diffMeta ? { diffs: { parent: diffMeta } } : {}),
        warnings: [
          ...scan.warnings,
          ...userGitRepos.flatMap((repo) => repo.remotes.filter((remote) => remote.credentialSanitized).map((remote) => ({
            path: repo.path,
            type: "git_remote",
            action: "sanitized" as const,
            reason: "credential_in_remote_url",
            remote: remote.name,
          }))),
        ],
        source: input.reason ?? "save_checkpoint",
        sourceTaskRunId: input.sourceTaskRunId ?? null,
        savedBy: input.userId ?? null,
        ...(input.requestSource ? { requestSource: input.requestSource } : {}),
      },
      createdAt,
    }).returning();
    if (!row) throw new Error("failed to create checkpoint record");
    // Compare-and-swap: a save only lands on the head it was built from.
    const moved = await tx.update(spaces)
      .set({ headCheckpointId: row.id, updatedAt: new Date() })
      .where(and(eq(spaces.id, spaceId), parentCheckpointId ? eq(spaces.headCheckpointId, parentCheckpointId) : isNull(spaces.headCheckpointId)))
      .returning({ id: spaces.id });
    if (moved.length === 0) throw new Error(`space ${spaceId} head moved during save; retry the save`);
    return row;
  }));

  return finishCheckpoint({
    ...context,
    checkpoint,
    latestChanges: previousIndex ? { from: previousIndex.commit, upserts: snapshot.changed, deletes: snapshot.deleted } : null,
    files: scan.files,
  });
};

type SaveContext = {
  input: SaveCheckpointInput;
  space: typeof spaces.$inferSelect;
  dirs: Awaited<ReturnType<typeof ensureCheckpointDirs>>;
  timings: SaveCheckpointTimings;
  progress: (stage: string, extra?: Record<string, unknown>) => Promise<void>;
};

type CheckpointMeta = {
  commitMessage?: string;
  storage?: { seq?: number };
  stats?: { changedFileCount?: number; assetCount?: number; detectedGitRepoCount?: number };
  savedBy?: string | null;
};

/**
 * Everything after the checkpoint row commits. Idempotent, so a retried task
 * whose worker died after the commit runs only this part.
 */
const finishCheckpoint = async (ctx: SaveContext & {
  checkpoint: typeof checkpoints.$inferSelect;
  /** What changed since the previous index; null when resuming, where it is recomputed from the staged index. */
  latestChanges: { from: string; upserts: string[]; deletes: string[] } | null;
  files?: ScannedFile[];
}): Promise<SaveCheckpointResult> => {
  const { input, space, dirs, timings, progress, checkpoint } = ctx;
  const spaceId = space.id;
  const commitHash = checkpoint.commitHash;
  const meta = (checkpoint.meta ?? {}) as CheckpointMeta;
  const resumed = !ctx.files;
  const publishWarnings: ConfigPublishWarning[] = [];
  const recordPublishWarning = async (warning: ConfigPublishWarning, error: unknown) => {
    publishWarnings.push(warning);
    await progress("publish_config_warning", { publishWarnings });
    console.warn(`[save_checkpoint] failed to publish ${warning.scope} ${warning.target}:`, error);
  };

  if (typeof meta.storage?.seq === "number") enqueueCheckpointCompaction({ spaceId, commit: commitHash, seq: meta.storage.seq });
  if (checkpoint.parentCheckpointId) {
    enqueueReferences([
      checkpointForkReference({
        spaceId,
        checkpointId: checkpoint.id,
        parentCheckpointId: checkpoint.parentCheckpointId,
        rootCheckpointId: checkpoint.rootCheckpointId,
      }),
    ]);
  }

  const latestChanges = ctx.latestChanges ?? await timeIt(timings, "loadIndexChanges", () => indexChanges(dirs.systemDir, commitHash)).catch(() => null);
  await timeIt(timings, "promoteFileIndex", () => promoteFileIndex(dirs.systemDir, commitHash))
    .catch((error) => console.warn(`[save_checkpoint] failed to promote the stat index space=${spaceId}:`, error));

  // A failed refresh leaves latest marked incomplete; the next refresh rebuilds it.
  const latestMeta = {
    version: 1,
    saveVersion: checkpoint.saveVersion,
    spaceId,
    checkpointId: checkpoint.id,
    createdAt: (checkpoint.createdAt ?? new Date()).toISOString(),
    description: checkpoint.description,
    branch: "main",
    commitHash,
    materializedAt: new Date().toISOString(),
  };
  await progress("materialize_latest", { commitHash });
  const latestError = await timeIt(timings, "materializeLatest", () => refreshLatest({
    latestDir: dirs.latestDir,
    workspaceDir: dirs.workspaceDir,
    checkpointMeta: latestMeta,
    changes: latestChanges,
    scanFiles: async () => ctx.files ?? (await scanWorkspace(dirs.workspaceDir)).files,
  })).then(() => null, (error: unknown) => formatErrorMessage(error));
  if (latestError) console.warn(`[save_checkpoint] failed to refresh latest space=${spaceId} checkpoint=${checkpoint.id}: ${latestError}`);

  let publishedUserConfig: { targetDir: string; copiedPaths: string[]; meta: Record<string, unknown> } | null = null;
  if (!latestError && space.slug === HOME_SPACE_SLUG) {
    publishedUserConfig = await timeIt(timings, "publishUserConfig", () => publishUserConfigFromWorkspace({ userId: space.userUuid, spaceId: space.id, checkpointId: checkpoint.id, workspaceDir: dirs.latestDir })).catch(async (error) => {
      await recordPublishWarning({ scope: "user", target: "config_files", message: formatErrorMessage(error) }, error);
      return null;
    });
  }
  if (publishedUserConfig) {
    await publishModelsCacheFromFile({ modelsPath: join(publishedUserConfig.targetDir, ".cohub", "models.json"), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "models_cache", message: formatErrorMessage(error) }, error));
    await publishModelTasksCacheFromFile({ configPath: join(publishedUserConfig.targetDir, ".cohub", "model-tasks.json"), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "model_tasks_cache", message: formatErrorMessage(error) }, error));
    await publishDecisionsCacheFromFile({ configPath: join(publishedUserConfig.targetDir, ".cohub", "decisions.json"), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "decisions_cache", message: formatErrorMessage(error) }, error));
    await publishGenerationsCacheFromDir({ generationsDir: getGenerationsDir(publishedUserConfig.targetDir), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "generations_cache", message: formatErrorMessage(error) }, error));
    await publishPromptsCacheFromDir({ promptsDir: getPromptsDir(publishedUserConfig.targetDir), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "prompts_cache", message: formatErrorMessage(error) }, error));
    await publishSkillsCacheFromDir({ skillsDir: getSkillsDir(publishedUserConfig.targetDir), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id, sandboxDir: "/configs/user/.agents/skills" }).catch((error) => recordPublishWarning({ scope: "user", target: "skills_cache", message: formatErrorMessage(error) }, error));
  }

  let publishedPlatformConfig: { targetDir: string; copiedPaths: string[]; meta: Record<string, unknown> } | null = null;
  if (!latestError && config.platformSpaceId && spaceId === config.platformSpaceId) {
    publishedPlatformConfig = await timeIt(timings, "publishPlatformConfig", () => publishConfigFromWorkspace({ workspaceDir: dirs.latestDir, checkpointId: checkpoint.id, targetDir: "/configs/platform", whitelist: ["AGENTS.md", "CLAUDE.md", ".agents", ".cohub"], sourceLabel: "platform" }));
    await publishModelsCacheFromFile({ modelsPath: join(publishedPlatformConfig.targetDir, ".cohub", "models.json"), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "models_cache", message: formatErrorMessage(error) }, error));
    await publishModelTasksCacheFromFile({ configPath: join(publishedPlatformConfig.targetDir, ".cohub", "model-tasks.json"), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "model_tasks_cache", message: formatErrorMessage(error) }, error));
    await publishDecisionsCacheFromFile({ configPath: join(publishedPlatformConfig.targetDir, ".cohub", "decisions.json"), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "decisions_cache", message: formatErrorMessage(error) }, error));
    await publishGenerationsCacheFromDir({ generationsDir: getGenerationsDir(publishedPlatformConfig.targetDir), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "generations_cache", message: formatErrorMessage(error) }, error));
    await publishPromptsCacheFromDir({ promptsDir: getPromptsDir(publishedPlatformConfig.targetDir), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "prompts_cache", message: formatErrorMessage(error) }, error));
    await publishSkillsCacheFromDir({ skillsDir: getSkillsDir(publishedPlatformConfig.targetDir), scope: "platform", sourceCheckpointId: checkpoint.id, sandboxDir: "/configs/platform/.agents/skills" }).catch((error) => recordPublishWarning({ scope: "platform", target: "skills_cache", message: formatErrorMessage(error) }, error));
  }

  await timeIt(timings, "updateCheckpointMeta", () => updateCheckpointMeta(db, checkpoint.id, {
    [resumed ? "resumedTimings" : "timings"]: timings,
    ...(latestError ? { latestRefreshError: latestError } : {}),
    ...(publishWarnings.length > 0 ? { publishWarnings } : {}),
  })).catch((error) => console.warn(`[save_checkpoint] failed to record timings for checkpoint=${checkpoint.id}:`, error));

  await progress("completed", { checkpointId: checkpoint.id, commitHash, ...(publishWarnings.length > 0 ? { publishWarnings } : {}) });
  await publishSpaceEvent({
    type: "checkpoint.created",
    spaceId,
    payload: {
      checkpointId: checkpoint.id,
      commitHash,
      parentCheckpointId: checkpoint.parentCheckpointId,
      rootCheckpointId: checkpoint.rootCheckpointId,
      description: checkpoint.description,
      savedBy: meta.savedBy ?? input.userId ?? null,
    },
  }).catch((error) => console.warn(`[save_checkpoint] failed to publish checkpoint.created for space=${spaceId}:`, error));
  return {
    checkpointId: checkpoint.id,
    commitHash,
    branch: "main",
    commitMessage: meta.commitMessage ?? "",
    changedFiles: meta.stats?.changedFileCount ?? 0,
    stats: meta.stats,
    assetCount: meta.stats?.assetCount ?? 0,
    detectedGitRepoCount: meta.stats?.detectedGitRepoCount ?? 0,
    timings,
    spaceId,
    latestSubPath: getCheckpointLatestSubPath(spaceId),
    ...(resumed ? { resumed: true } : {}),
    ...(publishedUserConfig ? { publishedUserConfig } : {}),
    ...(publishedPlatformConfig ? { publishedPlatformConfig } : {}),
    ...(publishWarnings.length > 0 ? { publishWarnings } : {}),
  };
};

const saveCheckpointHandler = async (job: Job, context?: { taskRunId: string }) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  if (!spaceId) throw new Error("spaceId is required for save_checkpoint task");
  const description = (payload.data?.description as string | undefined) ?? null;
  const reason = (payload.data?.reason as string | undefined) ?? "save_checkpoint";
  const requestSource = normalizeRequestSource(payload.data?.requestSource);
  return saveCheckpointWithLock({
    spaceId,
    userId: payload.userId,
    description,
    reason,
    sourceTaskRunId: context?.taskRunId ?? null,
    requestSource,
    onProgress: (progress) => job.updateProgress(progress),
  }, saveCheckpointForSpace);
};

registerTask("save_checkpoint", saveCheckpointHandler);
