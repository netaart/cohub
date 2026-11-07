import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { Job } from "bullmq";
import type { TaskPayload } from "@cohub/protocol/task";
import { normalizeRequestSource } from "@cohub/protocol/provenance";
import { HOME_SPACE_SLUG } from "@cohub/protocol/public-identifiers";
import { checkpoints, spaces } from "@cohub/db";
import {
  checkpointGitDir,
  ensureCheckpointCommits,
  initCheckpointRepo,
  markCheckpointCommitComplete,
  readCheckpointManifest,
  runCheckpointGit,
} from "@cohub/core/checkpoint/storage";
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
import {
  buildCommitDiffSummary,
  materializeDiffMeta,
  materializeFilePatches,
  type CheckpointDiffMeta,
} from "../checkpoint/diff-precompute.js";
import { collectUserGitRepos } from "../checkpoint/git-bundles.js";
import { saveBoardCheckpointSnapshots } from "../checkpoint/board.js";
import { enqueueCheckpointCompaction } from "../checkpoint/compact.js";
import { loadFileIndex, writeFileIndex } from "../checkpoint/file-index.js";
import { foldCovers, tilesSequence, uploadPack, writeManifest } from "../checkpoint/manifest.js";
import { applyLatestChanges, materializeLatest, readLatestCommit } from "../checkpoint/materialize.js";
import { updateCheckpointMeta } from "../checkpoint/metadata.js";
import { commitTree, createObjectBuilder, installLocalPack, packObjects, writeTree } from "../checkpoint/objects.js";
import { CHECKPOINT_ASSET_MANIFEST_PATH, CHECKPOINT_META_PATH, USER_GIT_REPOS_PATH, ensureCheckpointDirs, getCheckpointLatestSubPath } from "../checkpoint/paths.js";
import { saveCheckpointWithLock, type SaveCheckpointInput, type SaveCheckpointResult } from "../checkpoint/save.js";
import { buildSnapshot } from "../checkpoint/snapshot.js";
import { scanWorkspace } from "../checkpoint/scan.js";

const SAVE_VERSION = 3;

/** Saves before v3 kept a working tree in the cache repository; nothing reads it any more. */
async function removeLegacyWorkingTree(repoDir: string) {
  const names = await readdir(repoDir).catch(() => []);
  await Promise.all(names.filter((name) => name !== ".git").map((name) => rm(join(repoDir, name), { recursive: true, force: true })));
  await rm(join(repoDir, ".git", "index"), { force: true });
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
  const publishWarnings: ConfigPublishWarning[] = [];
  const progress = (stage: string, extra?: Record<string, unknown>) => input.onProgress?.({ stage, updatedAt: new Date().toISOString(), timings, ...extra });
  const recordPublishWarning = async (warning: ConfigPublishWarning, error: unknown) => {
    publishWarnings.push(warning);
    await progress("publish_config_warning", { publishWarnings });
    console.warn(`[save_checkpoint] failed to publish ${warning.scope} ${warning.target}:`, error);
  };
  await progress("prepare");
  const checkpointId = crypto.randomUUID();
  const createdAt = new Date();
  const branch = "main";
  const commitMessage = buildCommitMessage(description);
  const dirs = await timeIt(timings, "ensureCheckpointDirs", () => ensureCheckpointDirs(spaceId));
  await timeIt(timings, "initCheckpointRepo", () => initCheckpointRepo(dirs.repoDir));

  const parentCheckpointId = space.headCheckpointId ?? null;
  const parent = parentCheckpointId
    ? (await db.select({ commitHash: checkpoints.commitHash, rootCheckpointId: checkpoints.rootCheckpointId }).from(checkpoints).where(eq(checkpoints.id, parentCheckpointId)).limit(1))[0] ?? null
    : null;
  if (parentCheckpointId && !parent) throw new Error(`head checkpoint ${parentCheckpointId} not found`);
  const parentCommitHash = parent?.commitHash ?? null;
  const rootCheckpointId = parentCheckpointId ? (parent?.rootCheckpointId ?? parentCheckpointId) : checkpointId;

  const parentManifest = parentCommitHash
    ? await timeIt(timings, "loadParentObjects", async () => {
      await ensureCheckpointCommits(checkpointObjectStore, dirs.repoDir, [parentCommitHash]);
      const manifest = await readCheckpointManifest(checkpointObjectStore, parentCommitHash);
      return manifest && tilesSequence(manifest.packs, 0, manifest.seq) ? manifest : null;
    })
    : null;
  const previousIndex = await timeIt(timings, "loadFileIndex", () => loadFileIndex(dirs.systemDir, parentCommitHash));

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
  const builder = await createObjectBuilder(dirs.repoDir, localTmpDir);
  const snapshot = await timeIt(timings, "writeObjects", () => buildSnapshot({
    builder,
    files: scan.files,
    previous: previousIndex,
    assetThresholdBytes: config.checkpointAssetThresholdBytes,
    scanStartedAtNs,
    systemFiles: { checkpointMeta: gitCheckpointMeta, userGitRepos: { version: 2, repos: userGitRepos } },
    onAssetTiming: (label, ms) => { timings[label] = (timings[label] ?? 0) + Math.round(ms); },
  }));
  const tree = await timeIt(timings, "writeTree", () => writeTree(builder, snapshot.tree));
  const commitHash = await timeIt(timings, "commitTree", () => commitTree(builder, { tree, parent: parentCommitHash, message: commitMessage, date: createdAt }));

  await progress("commit_checkpoint", { commitHash });
  const seq = parentManifest ? parentManifest.seq + 1 : 0;
  const pack = await timeIt(timings, "packObjects", () => packObjects({
    env: builder.env,
    cwd: localTmpDir,
    outDir: join(localTmpDir, "pack"),
    include: [commitHash],
    exclude: parentManifest && parentCommitHash ? [parentCommitHash] : [],
    fast: true,
  }));
  const packRef = await timeIt(timings, "uploadPack", () => uploadPack(spaceId, pack, { first: seq, last: seq, tip: commitHash }));
  await timeIt(timings, "installPack", async () => {
    await installLocalPack(dirs.repoDir, pack);
    await markCheckpointCommitComplete(dirs.repoDir, commitHash);
  });

  const assetPaths = new Set(snapshot.assets.map((asset) => asset.path));
  const diff = await timeIt(timings, "buildDiffSummary", () => buildCommitDiffSummary({
    repoDir: dirs.repoDir,
    checkpointId,
    commitHash,
    parentCheckpointId,
    parentCommitHash,
    assetPaths,
  }));
  const diffStats = diff.stats;

  let diffMeta: CheckpointDiffMeta | null = null;
  try {
    const filePatches = await timeIt(timings, "materializeFilePatches", () => materializeFilePatches({
      repoDir: dirs.repoDir,
      parentCommitHash,
      commitHash,
      files: diff.summary.files,
      spaceId,
      checkpointId,
      tmpDir: localTmpDir,
    }));
    diffMeta = await timeIt(timings, "materializeDiffMeta", () => materializeDiffMeta({
      summary: diff.summary,
      commitHash,
      spaceId,
      checkpointId,
      tmpDir: localTmpDir,
      files: filePatches,
    }));
  } catch (error) {
    // Diff precompute must never fail a save. API can still compute on demand.
    console.warn(`[save_checkpoint] failed to materialize diff meta space=${spaceId} checkpoint=${checkpointId}:`, error);
  }

  const manifest = await timeIt(timings, "writeManifest", async () => {
    const basePacks = parentManifest ? await foldCovers(parentManifest.packs) : [];
    const value = { version: 1 as const, commit: commitHash, parent: parentCommitHash, seq, packs: [...basePacks, packRef] };
    await writeManifest(value);
    return value;
  });

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
    hashedFileCount: snapshot.changed.length,
    ignoredCount: scan.ignoredCount,
    unsupportedCount: scan.warnings.length,
    detectedGitRepoCount,
    bundledGitRepoCount,
    gitBundleBytes,
    packBytes: pack.size,
  };

  await progress("write_checkpoint_record");
  const checkpoint = await timeIt(timings, "writeCheckpointRecord", () => db.transaction(async (tx) => {
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

  await timeIt(timings, "finalizeRepo", async () => {
    await runCheckpointGit(["update-ref", "refs/heads/main", commitHash], { cwd: dirs.repoDir, env: { GIT_DIR: checkpointGitDir(dirs.repoDir) } });
    await removeLegacyWorkingTree(dirs.repoDir);
    await writeFileIndex(dirs.systemDir, { version: 1, commit: commitHash, entries: snapshot.entries });
  }).catch((error) => console.warn(`[save_checkpoint] failed to finalize cache repo space=${spaceId}:`, error));
  enqueueCheckpointCompaction({ spaceId, commit: commitHash, seq: manifest.seq });

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

  const boardSnapshots = await timeIt(timings, "saveBoardCheckpointSnapshots", () => saveBoardCheckpointSnapshots({ checkpointId: checkpoint.id, spaceId }));
  await timeIt(timings, "updateCheckpointBoardMeta", () => updateCheckpointMeta(db, checkpoint.id, { board: { snapshotCount: boardSnapshots.count }, timings }));

  // The checkpoint is committed; a failed refresh leaves latest marked incomplete and the next save rebuilds it.
  const latestMeta = { ...gitCheckpointMeta, commitHash, materializedAt: new Date().toISOString() };
  await progress("materialize_latest", { commitHash });
  const latestError = await timeIt(timings, "materializeLatest", async () => {
    const incremental = previousIndex && await readLatestCommit(dirs.latestDir) === parentCommitHash;
    if (incremental) await applyLatestChanges({ latestDir: dirs.latestDir, upserts: snapshot.changed, deletes: snapshot.deleted, checkpointMeta: latestMeta });
    else await materializeLatest({ latestDir: dirs.latestDir, files: scan.files, checkpointMeta: latestMeta });
  }).then(() => null, (error: unknown) => formatErrorMessage(error));
  if (latestError) {
    console.warn(`[save_checkpoint] failed to refresh latest space=${spaceId} checkpoint=${checkpoint.id}: ${latestError}`);
    await updateCheckpointMeta(db, checkpoint.id, { latestRefreshError: latestError, timings }).catch(() => undefined);
  }

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

  if (publishWarnings.length > 0) {
    await timeIt(timings, "updatePublishWarningsMeta", () => updateCheckpointMeta(db, checkpoint.id, { publishWarnings, timings }));
  }

  await progress("completed", { checkpointId: checkpoint.id, commitHash, ...(publishWarnings.length > 0 ? { publishWarnings } : {}) });
  await publishSpaceEvent({
    type: "checkpoint.created",
    spaceId,
    payload: {
      checkpointId: checkpoint.id,
      commitHash,
      parentCheckpointId,
      rootCheckpointId,
      description: checkpoint.description,
      savedBy: input.userId ?? null,
    },
  }).catch((error) => console.warn(`[save_checkpoint] failed to publish checkpoint.created for space=${spaceId}:`, error));
  return { checkpointId: checkpoint.id, commitHash, branch, commitMessage, changedFiles: diffStats.changedFileCount, stats, assetCount, detectedGitRepoCount, timings, spaceId, latestSubPath: getCheckpointLatestSubPath(spaceId), ...(publishedUserConfig ? { publishedUserConfig } : {}), ...(publishedPlatformConfig ? { publishedPlatformConfig } : {}), ...(publishWarnings.length > 0 ? { publishWarnings } : {}) };
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
