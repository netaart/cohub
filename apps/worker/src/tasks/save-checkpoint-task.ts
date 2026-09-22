import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import type { TaskPayload } from "@cohub/protocol/task";
import { normalizeRequestSource } from "@cohub/protocol/provenance";
import { checkpoints, spaces } from "@cohub/db";
import { checkpointForkReference } from "@cohub/core/references";
import { enqueueReferences } from "../reference-index-queue.js";
import { registerTask } from "./registry.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { publishUserConfigFromWorkspace, publishConfigFromWorkspace } from "../config-publish.js";
import { getGenerationsDir, publishGenerationsCacheFromDir } from "../generations-cache.js";
import { publishModelsCacheFromFile } from "../models-cache.js";
import { publishModelTasksCacheFromFile } from "../model-tasks-cache.js";
import { getPromptsDir, publishPromptsCacheFromDir } from "../prompts-cache.js";
import { getSkillsDir, publishSkillsCacheFromDir } from "../skills-cache.js";
import { publishSpaceEvent } from "../space-events.js";
import { uploadAssetIfMissing } from "../checkpoint/assets.js";
import {
  buildStagedDiffSummary,
  materializeDiffMeta,
  materializeFilePatches,
  type CheckpointDiffMeta,
} from "../checkpoint/diff-precompute.js";
import { ensureGitRepo, runGit, runGitWithOutput } from "../checkpoint/git.js";
import { collectUserGitRepos } from "../checkpoint/git-bundles.js";
import { saveBoardCheckpointSnapshots } from "../checkpoint/board.js";
import { materializeLatest } from "../checkpoint/materialize.js";
import { updateCheckpointMeta } from "../checkpoint/metadata.js";
import { CHECKPOINT_ASSET_MANIFEST_PATH, CHECKPOINT_META_PATH, USER_GIT_REPOS_PATH, ensureCheckpointDirs, getCheckpointLatestSubPath } from "../checkpoint/paths.js";
import { syncSystemRepo, type CheckpointAsset } from "../checkpoint/repo-sync.js";
import { saveCheckpointWithLock, type SaveCheckpointInput, type SaveCheckpointResult } from "../checkpoint/save.js";
import { hashFile, scanWorkspace, type ScannedFile } from "../checkpoint/scan.js";
import { isGiteaMirrorEnabled, mirrorRepositoryToGitea } from "../gitea.js";

const SAVE_VERSION = 2;

const buildCommitMessage = (description?: string | null) => {
  const trimmed = description?.trim();
  return trimmed?.length ? `checkpoint: ${trimmed}` : "checkpoint: save from cohub";
};

type SaveCheckpointTimings = Record<string, number>;

type ConfigPublishWarning = {
  scope: "platform" | "user";
  target: "models_cache" | "model_tasks_cache" | "generations_cache" | "prompts_cache" | "skills_cache";
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

  await timeIt(timings, "ensureGitRepo", () => ensureGitRepo(dirs.repoDir, branch));
  await progress("scan_workspace");
  const scan = await timeIt(timings, "scanWorkspace", () => scanWorkspace(dirs.workspaceDir));
  await progress("upload_assets", { fileCount: scan.files.length, gitRepoCount: scan.gitRepos.length });
  const assets: CheckpointAsset[] = [];
  const smallFiles: ScannedFile[] = [];
  await timeIt(timings, "processAssets", async () => {
    for (const file of scan.files) {
      if (file.type === "file" && file.size > config.checkpointAssetThresholdBytes) {
        const sha256 = await timeIt(timings, "hashAssets", () => hashFile(file.absPath));
        const objectKey = await timeIt(timings, "uploadAssets", () => uploadAssetIfMissing({ filePath: file.absPath, sha256, size: file.size, mimeType: file.mimeType }));
        assets.push({ path: file.path, sha256, size: file.size, mimeType: file.mimeType, objectKey });
      } else {
        smallFiles.push(file);
      }
    }
  });

  await progress("bundle_git_repos", { assetCount: assets.length });
  const userGitRepos = await timeIt(timings, "collectUserGitRepos", () => collectUserGitRepos({
    workspaceDir: dirs.workspaceDir,
    systemDir: dirs.systemDir,
    tmpDir: dirs.tmpDir,
    repoPaths: scan.gitRepos.map((repo) => repo.path),
  }));
  const userGitReposManifest = { version: 1, repos: userGitRepos };

  const gitCheckpointMeta = {
    version: 1,
    saveVersion: SAVE_VERSION,
    spaceId,
    checkpointId,
    createdAt: createdAt.toISOString(),
    description: description?.trim() || "Checkpoint",
    branch,
  };

  await progress("commit_checkpoint", { gitRepoCount: userGitRepos.length });
  await timeIt(timings, "syncSystemRepo", () => syncSystemRepo({ repoDir: dirs.repoDir, smallFiles, assets, gitCheckpointMeta, userGitRepos: userGitReposManifest }));
  await timeIt(timings, "gitAdd", () => runGit(["add", "-A"], dirs.repoDir));

  // Resolve parent commit once — used both for lineage and precomputed diff.
  const parentCheckpointId = space.headCheckpointId ?? null;
  const parentCommitHash = await timeIt(timings, "resolveParentCommit", async () => {
    if (!parentCheckpointId) return null;
    const [parent] = await db
      .select({ commitHash: checkpoints.commitHash, rootCheckpointId: checkpoints.rootCheckpointId })
      .from(checkpoints)
      .where(eq(checkpoints.id, parentCheckpointId))
      .limit(1);
    return parent?.commitHash ?? null;
  });

  // Staged diff summary is pure git metadata (name-status + numstat). No workspace walk.
  const assetPaths = new Set(assets.map((asset) => asset.path));
  const stagedDiff = await timeIt(timings, "buildStagedDiffSummary", () => buildStagedDiffSummary({
    repoDir: dirs.repoDir,
    spaceId,
    checkpointId,
    parentCheckpointId,
    parentCommitHash,
    assetPaths,
  }));
  const diffStats = stagedDiff.stats;

  await timeIt(timings, "gitCommit", () => runGit(["commit", "--allow-empty", "-m", commitMessage], dirs.repoDir));
  const head = await timeIt(timings, "gitRevParse", () => runGitWithOutput(["rev-parse", "HEAD"], dirs.repoDir));
  const commitHash = head.stdout.trim();

  // Persist precomputed parent diff: inline in meta when small, OSS when large.
  // Also precompute a capped set of text file patches (sequential, NFS-friendly).
  let diffMeta: CheckpointDiffMeta | null = null;
  try {
    const filePatches = await timeIt(timings, "materializeFilePatches", () => materializeFilePatches({
      repoDir: dirs.repoDir,
      parentCommitHash,
      commitHash,
      files: stagedDiff.summary.files,
      spaceId,
      checkpointId,
      tmpDir: dirs.tmpDir,
    }));
    diffMeta = await timeIt(timings, "materializeDiffMeta", () => materializeDiffMeta({
      summary: stagedDiff.summary,
      commitHash,
      spaceId,
      checkpointId,
      tmpDir: dirs.tmpDir,
      files: filePatches,
    }));
  } catch (error) {
    // Diff precompute must never fail a save. API can still compute on demand.
    console.warn(`[save_checkpoint] failed to materialize diff meta space=${spaceId} checkpoint=${checkpointId}:`, error);
  }

  const latestMeta = { ...gitCheckpointMeta, commitHash, materializedAt: new Date().toISOString() };
  await progress("materialize_latest", { commitHash });
  await timeIt(timings, "materializeLatest", () => materializeLatest({ latestDir: dirs.latestDir, files: scan.files, checkpointMeta: latestMeta }));

  const smallFileCount = smallFiles.length;
  const smallFileBytes = smallFiles.reduce((sum, file) => sum + file.size, 0);
  const assetCount = assets.length;
  const assetBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  const detectedGitRepoCount = userGitRepos.length;
  const bundledGitRepoCount = userGitRepos.filter((repo) => repo.bundle).length;
  const gitBundleBytes = userGitRepos.reduce((sum, repo) => sum + (repo.bundle?.size ?? 0), 0);
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
    ignoredCount: scan.ignoredCount,
    unsupportedCount: scan.warnings.length,
    detectedGitRepoCount,
    bundledGitRepoCount,
    gitBundleBytes,
  };

  await progress("write_checkpoint_record");
  const rootCheckpointId = await timeIt(timings, "resolveRootCheckpoint", async () => (
    parentCheckpointId ? ((await db.select({ rootCheckpointId: checkpoints.rootCheckpointId, id: checkpoints.id }).from(checkpoints).where(eq(checkpoints.id, parentCheckpointId)).limit(1))[0]?.rootCheckpointId ?? parentCheckpointId) : checkpointId
  ));
  const [checkpoint] = await timeIt(timings, "writeCheckpointRecord", () => db.insert(checkpoints).values({
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
      mirror: { status: "queued" },
    },
    createdAt,
  }).returning());

  if (!checkpoint) throw new Error("failed to create checkpoint record");
  // Index checkpoint lineage. Enqueued for async, retryable indexing so stats
  // never block or fail the save.
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
  await timeIt(timings, "updateSpaceHead", () => db.update(spaces).set({ headCheckpointId: checkpoint.id, updatedAt: new Date() }).where(eq(spaces.id, spaceId)));

  if (isGiteaMirrorEnabled()) await progress("mirror_repository");
  const mirrorMeta = await timeIt(timings, "mirrorRepository", async () => {
    if (!isGiteaMirrorEnabled()) return { provider: "none" as const, status: "disabled" as const };
    try {
      await mirrorRepositoryToGitea(dirs.repoDir, space.storageRepoName, branch);
      return { provider: "gitea" as const, status: "pushed" as const, pushedAt: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[save_checkpoint] failed to mirror repo for space=${spaceId} checkpoint=${checkpoint.id}:`, error);
      return { provider: "gitea" as const, status: "failed" as const, error: message };
    }
  });
  await timeIt(timings, "updateMirrorMeta", () => updateCheckpointMeta(db, checkpoint.id, { mirror: mirrorMeta, timings }));

  let publishedUserConfig: { targetDir: string; copiedPaths: string[]; meta: Record<string, unknown> } | null = null;
  if (space.name === "config") {
    publishedUserConfig = await timeIt(timings, "publishUserConfig", () => publishUserConfigFromWorkspace({ userId: space.userUuid, spaceId: space.id, checkpointId: checkpoint.id, workspaceDir: dirs.latestDir }));
    await publishModelsCacheFromFile({ modelsPath: join(publishedUserConfig.targetDir, ".cohub", "models.json"), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "models_cache", message: formatErrorMessage(error) }, error));
    await publishModelTasksCacheFromFile({ configPath: join(publishedUserConfig.targetDir, ".cohub", "model-tasks.json"), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "model_tasks_cache", message: formatErrorMessage(error) }, error));
    await publishGenerationsCacheFromDir({ generationsDir: getGenerationsDir(publishedUserConfig.targetDir), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "generations_cache", message: formatErrorMessage(error) }, error));
    await publishPromptsCacheFromDir({ promptsDir: getPromptsDir(publishedUserConfig.targetDir), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "user", target: "prompts_cache", message: formatErrorMessage(error) }, error));
    await publishSkillsCacheFromDir({ skillsDir: getSkillsDir(publishedUserConfig.targetDir), scope: "user", userId: space.userUuid, sourceCheckpointId: checkpoint.id, sandboxDir: "/configs/user/.agents/skills" }).catch((error) => recordPublishWarning({ scope: "user", target: "skills_cache", message: formatErrorMessage(error) }, error));
  }

  let publishedPlatformConfig: { targetDir: string; copiedPaths: string[]; meta: Record<string, unknown> } | null = null;
  if (config.platformSpaceId && spaceId === config.platformSpaceId) {
    publishedPlatformConfig = await timeIt(timings, "publishPlatformConfig", () => publishConfigFromWorkspace({ workspaceDir: dirs.latestDir, checkpointId: checkpoint.id, targetDir: "/configs/platform", whitelist: ["AGENTS.md", "CLAUDE.md", ".agents", ".cohub"], sourceLabel: "platform" }));
    await publishModelsCacheFromFile({ modelsPath: join(publishedPlatformConfig.targetDir, ".cohub", "models.json"), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "models_cache", message: formatErrorMessage(error) }, error));
    await publishModelTasksCacheFromFile({ configPath: join(publishedPlatformConfig.targetDir, ".cohub", "model-tasks.json"), scope: "platform", sourceCheckpointId: checkpoint.id }).catch((error) => recordPublishWarning({ scope: "platform", target: "model_tasks_cache", message: formatErrorMessage(error) }, error));
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
