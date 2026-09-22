import { isBillingAccessBlockedError } from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { eq, sql } from "drizzle-orm";
import type { Job } from "bullmq";
import type { TaskPayload } from "@cohub/protocol/task";
import { registerTask } from "./registry.js";
import { db } from "../db.js";
import { checkpoints, spaces } from "@cohub/db";
import { checkpointForkReference, spaceForkReference } from "@cohub/core/references";
import { enqueueReferences } from "../reference-index-queue.js";
import { assertDirectoryEmpty, ensureSpaceWorkspaceReady, getSpaceWorkspaceDir, runGit } from "../git.js";
import { publishSpaceEvent, publishSpaceFsChanged } from "../space-events.js";
import { enqueueTask } from "./enqueue.js";
import { restoreBoardCheckpointSnapshots } from "../checkpoint/board.js";
import { restoreWorkspaceFromCheckpoint, restoreSystemRepoFromCheckpoint } from "../checkpoint/restore.js";
import { ensureCheckpointDirs, getCheckpointLatestSubPath } from "../checkpoint/paths.js";
import { materializeLatest } from "../checkpoint/materialize.js";
import { scanWorkspace } from "../checkpoint/scan.js";
import { isGiteaMirrorEnabled, mirrorRepositoryToGitea } from "../gitea.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";
import {
  resolveCreateSpaceSource,
  type ResolvedSpaceCreateSource,
} from "./create-space-source.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const SAVE_VERSION = 2;
type BootstrapStatus = "pending" | "running" | "ready" | "failed";
type BootstrapStage = "prepare" | "import" | "checkpoint_restore" | "finalize";

const SAFE_GIT_REF_REGEX = /^[a-zA-Z0-9._/-]+$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const getBootstrapMeta = (space: typeof spaces.$inferSelect) => {
  const meta = isRecord(space.meta) ? space.meta : {};
  const bootstrap = isRecord(meta.bootstrap) ? meta.bootstrap : {};
  return { meta, bootstrap: isRecord(bootstrap) ? bootstrap : undefined };
};

const sanitizeBootstrapError = (value: unknown) => {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/(https?:\/\/[^:\s/@]+:)([^@\s]+)(@)/g, "$1***$3");
};

const getBootstrapErrorCode = (value: unknown) => {
  if (isBillingAccessBlockedError(value)) return value.code;
  return null;
};

const ensureValidGitRef = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || !SAFE_GIT_REF_REGEX.test(trimmed) || trimmed.startsWith("-") || trimmed.includes("..")) throw new Error("invalid git ref");
  return trimmed;
};

const updateBootstrap = async (input: {
  space: typeof spaces.$inferSelect;
  taskRunId: string;
  source?: ResolvedSpaceCreateSource;
  status: BootstrapStatus;
  stage?: BootstrapStage;
  errorMessage?: string | null;
  errorCode?: string | null;
  startedAt?: string;
  finishedAt?: string;
  stageTimings?: Record<string, number>;
  initialCheckpointTaskRunId?: string | null;
}) => {
  const { meta, bootstrap: existingBootstrap } = getBootstrapMeta(input.space);
  const nextMeta = {
    ...meta,
    bootstrap: {
      ...existingBootstrap,
      taskRunId: input.taskRunId,
      source: input.source ?? existingBootstrap?.source ?? { type: "blank" },
      status: input.status,
      stage: input.stage ?? null,
      errorMessage: input.errorMessage ?? null,
      errorCode: input.errorCode ?? null,
      startedAt: input.startedAt ?? existingBootstrap?.startedAt ?? (input.status === "running" ? new Date().toISOString() : null),
      finishedAt: input.finishedAt ?? (input.status === "ready" || input.status === "failed" ? new Date().toISOString() : null),
      stageTimings: input.stageTimings ?? existingBootstrap?.stageTimings ?? {},
      ...("initialCheckpointTaskRunId" in input ? { initialCheckpointTaskRunId: input.initialCheckpointTaskRunId } : {}),
    },
  };
  const [updated] = await db.update(spaces).set({ meta: nextMeta, updatedAt: new Date() }).where(eq(spaces.id, input.space.id)).returning();
  if (!updated) throw new Error("failed to update bootstrap state");
  return updated;
};

const assertRepoUrl = (value: string, hasToken: boolean) => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("git repo url must use https");
  if (!hasToken) {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) throw new Error("git repo url is not allowed for public access");
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) throw new Error("git repo url is not allowed for public access");
  }
  return url.toString();
};

const buildCloneUrl = (repoUrl: string, token?: string) => {
  if (!token) return repoUrl;
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
};

const bootstrapFromGitRepo = async (input: { workspaceDir: string; repoUrl: string; ref?: string | null; gitToken?: string }) => {
  const repoUrl = assertRepoUrl(input.repoUrl, Boolean(input.gitToken));
  await assertDirectoryEmpty(input.workspaceDir);
  await runGit(["clone", buildCloneUrl(repoUrl, input.gitToken), "."], input.workspaceDir);
  if (input.ref) await runGit(["checkout", ensureValidGitRef(input.ref)], input.workspaceDir);
  await runGit(["remote", "set-url", "origin", repoUrl], input.workspaceDir).catch(() => undefined);
  await runGit(["remote", "rename", "origin", "upstream"], input.workspaceDir).catch(() => undefined);
};

const timeIt = async <T>(label: string, fn: () => Promise<T>): Promise<{ result: T; duration: number }> => {
  const start = performance.now();
  const result = await fn();
  const duration = Math.round(performance.now() - start);
  logger.info(`[CreateSpace] ⏱ ${label}: ${duration}ms`);
  return { result, duration };
};

async function createCheckpointAlias(input: {
  targetSpace: typeof spaces.$inferSelect;
  sourceCheckpoint: typeof checkpoints.$inferSelect;
}) {
  const id = crypto.randomUUID();
  const rootCheckpointId = input.sourceCheckpoint.rootCheckpointId ?? input.sourceCheckpoint.id;
  const [alias] = await db.insert(checkpoints).values({
    id,
    spaceId: input.targetSpace.id,
    commitHash: input.sourceCheckpoint.commitHash,
    description: `Fork from checkpoint ${input.sourceCheckpoint.id}`,
    parentCheckpointId: input.sourceCheckpoint.id,
    rootCheckpointId,
    saveVersion: SAVE_VERSION,
    meta: {
      version: SAVE_VERSION,
      kind: "fork_alias",
      sourceCheckpointId: input.sourceCheckpoint.id,
      sourceSpaceId: input.sourceCheckpoint.spaceId,
      paths: { latestSubPath: getCheckpointLatestSubPath(input.targetSpace.id) },
    },
    createdAt: new Date(),
  }).returning();
  if (!alias) throw new Error("failed to create checkpoint alias");
  const [updated] = await db.update(spaces).set({ headCheckpointId: alias.id, baseCheckpointId: input.sourceCheckpoint.id, updatedAt: new Date() }).where(eq(spaces.id, input.targetSpace.id)).returning();
  await db.update(checkpoints).set({ forkCount: sql`${checkpoints.forkCount} + 1` }).where(eq(checkpoints.id, input.sourceCheckpoint.id));
  // Index the fork lineage: the new space forks from the source checkpoint, and
  // the alias checkpoint derives from it. Enqueued for async, retryable
  // indexing so stats never block or fail the fork.
  enqueueReferences([
    spaceForkReference({
      spaceId: input.targetSpace.id,
      baseCheckpointId: input.sourceCheckpoint.id,
      sourceSpaceId: input.sourceCheckpoint.spaceId,
    }),
    checkpointForkReference({
      spaceId: input.targetSpace.id,
      checkpointId: alias.id,
      parentCheckpointId: input.sourceCheckpoint.id,
      rootCheckpointId: alias.rootCheckpointId,
    }),
  ]);
  return { alias, space: updated ?? input.targetSpace };
}

async function enqueueInitialCheckpoint(input: { space: typeof spaces.$inferSelect }) {
  const { taskRunId } = await enqueueTask({
    type: "save_checkpoint",
    spaceId: input.space.id,
    userId: input.space.userUuid,
    data: {
      description: "Initialize space",
      reason: "create_space_init",
    },
  });
  return taskRunId ?? null;
}

async function postCheckpointRestore(input: {
  targetSpace: typeof spaces.$inferSelect;
  sourceCheckpoint: typeof checkpoints.$inferSelect;
  sourceSpaceId: string;
}) {
  const stages: Record<string, unknown> = {};
  const dirs = await ensureCheckpointDirs(input.targetSpace.id);
  const { duration: systemRepoDuration } = await timeIt("restoreSystemRepo", () => restoreSystemRepoFromCheckpoint({ sourceSpaceId: input.sourceSpaceId, targetRepoDir: dirs.repoDir, commitHash: input.sourceCheckpoint.commitHash }));
  const systemRepo = { status: "ready", durationMs: systemRepoDuration };
  stages.systemRepoRestore = systemRepo;

  const latest = await timeIt("materializeLatest", async () => {
    const scan = await scanWorkspace(dirs.workspaceDir);
    await materializeLatest({ latestDir: dirs.latestDir, files: scan.files, checkpointMeta: {
      version: 1,
      saveVersion: SAVE_VERSION,
      spaceId: input.targetSpace.id,
      checkpointId: input.targetSpace.headCheckpointId,
      commitHash: input.sourceCheckpoint.commitHash,
      materializedAt: new Date().toISOString(),
      source: "create_space_from_checkpoint",
    } });
    return scan.files.length;
  }).then(({ result, duration }) => ({ status: "ready", durationMs: duration, files: result }), (error) => ({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  stages.latestMaterialization = latest;

  const mirror = await timeIt("mirrorSystemRepo", async () => {
    if (!isGiteaMirrorEnabled()) return { status: "disabled" as const };
    await mirrorRepositoryToGitea(dirs.repoDir, input.targetSpace.storageRepoName, "main");
    return { status: "pushed" as const };
  }).then(({ result, duration }) => ({ ...result, durationMs: duration }), (error) => ({ status: "failed" as const, error: error instanceof Error ? error.message : String(error) }));
  stages.mirror = mirror;
  return stages;
}

const createSpaceHandler = async (job: Job) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const taskRunId = String(job.id ?? "");
  if (!spaceId) throw new Error("spaceId is required for create_space task");
  if (!taskRunId) throw new Error("task run id is required for create_space task");

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) throw new Error("space not found");

  let resolvedSource: ReturnType<typeof resolveCreateSpaceSource>;
  try {
    resolvedSource = resolveCreateSpaceSource(payload);
  } catch (error) {
    await updateBootstrap({
      space,
      taskRunId,
      status: "failed",
      errorMessage: sanitizeBootstrapError(error),
      errorCode: getBootstrapErrorCode(error),
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
  const { source, gitToken } = resolvedSource;
  const progress = (stage: string, extra?: Record<string, unknown>) => job.updateProgress({ stage, updatedAt: new Date().toISOString(), ...extra });
  const stageTimings: Record<string, number> = {};
  let currentSpace = await updateBootstrap({ space, taskRunId, source, status: "running", stage: source.type === "checkpoint" ? "checkpoint_restore" : source.type === "git_repo" ? "import" : "prepare", startedAt: new Date().toISOString() });

  try {
    await progress("prepare");
    const { duration: workspaceDuration } = await timeIt("ensureSpaceWorkspaceReady", () => ensureSpaceWorkspaceReady(currentSpace.id));
    stageTimings.ensureSpaceWorkspaceReady = workspaceDuration;
    const workspaceDir = getSpaceWorkspaceDir(currentSpace.id);
    let result: Record<string, unknown>;

    if (source.type === "checkpoint") {
      const restoreTmpDir = getWorkerLocalTmpDir("restore", currentSpace.id, taskRunId);
      await ensureWorkerLocalTmpDir(restoreTmpDir);
      await progress("restore_workspace", { checkpointId: source.checkpointId });
      const { result: restoreResult, duration: restoreDuration } = await timeIt("restoreWorkspaceFromCheckpoint", () => restoreWorkspaceFromCheckpoint({ checkpointId: source.checkpointId, targetWorkspaceDir: workspaceDir, restoreTmpDir })).finally(async () => {
        await removeWorkerLocalTmpDir(restoreTmpDir).catch((error) => logger.warn(`[CreateSpace] failed to clean restore tmp ${restoreTmpDir}: ${error instanceof Error ? error.message : String(error)}`));
      });
      stageTimings.restoreWorkspaceFromCheckpoint = restoreDuration;
      await progress("create_checkpoint_alias");
      const { result: aliasResult, duration: aliasDuration } = await timeIt("createCheckpointAlias", () => createCheckpointAlias({ targetSpace: currentSpace, sourceCheckpoint: restoreResult.checkpoint }));
      stageTimings.createCheckpointAlias = aliasDuration;
      currentSpace = aliasResult.space;
      await progress("restore_board_snapshots");
      const { result: boardRestoreResult, duration: boardRestoreDuration } = await timeIt("restoreBoardCheckpointSnapshots", () => restoreBoardCheckpointSnapshots({ checkpointId: source.checkpointId, targetSpaceId: currentSpace.id, workspaceDir }));
      stageTimings.restoreBoardCheckpointSnapshots = boardRestoreDuration;
      await progress("bootstrap_ready", { checkpointAliasId: aliasResult.alias.id });
      currentSpace = await updateBootstrap({ space: currentSpace, taskRunId, source, status: "ready", stage: "finalize", finishedAt: new Date().toISOString(), stageTimings });
      await publishSpaceFsChanged(currentSpace.id, { source: "bootstrap", resync: true, changes: [] }).catch((error) => logger.warn(`[CreateSpace] Failed to publish bootstrap fs resync for ${currentSpace.id}: ${error instanceof Error ? error.message : String(error)}`));
      await publishSpaceEvent({
        type: "space.workspace.ready",
        spaceId: currentSpace.id,
        payload: {
          source,
          stage: "finalize",
          checkpointAliasId: aliasResult.alias.id,
        },
      }).catch((error) => logger.warn(`[CreateSpace] Failed to publish workspace ready for ${currentSpace.id}: ${error instanceof Error ? error.message : String(error)}`));
      await progress("post_materialization");
      const postStages = await postCheckpointRestore({ targetSpace: currentSpace, sourceCheckpoint: restoreResult.checkpoint, sourceSpaceId: restoreResult.sourceSpace.id });
      result = { ok: true, spaceId: currentSpace.id, checkpointAliasId: aliasResult.alias.id, commitHash: restoreResult.checkpoint.commitHash, source, stages: { workspaceRestore: { status: "ready", durationMs: restoreDuration }, checkpointAlias: { status: "ready", durationMs: aliasDuration }, boardRestore: { status: "ready", durationMs: boardRestoreDuration, count: boardRestoreResult.count }, ...postStages } };
    } else {
      if (source.type === "git_repo") {
        currentSpace = await updateBootstrap({ space: currentSpace, taskRunId, source, status: "running", stage: "import", stageTimings });
        await progress("import_git_repo");
        const { duration } = await timeIt("bootstrapFromGitRepo", () => bootstrapFromGitRepo({ workspaceDir, repoUrl: source.repoUrl, ref: source.ref, gitToken }));
        stageTimings.bootstrapFromGitRepo = duration;
      } else {
        await progress("prepare_blank_workspace");
      }

      await progress("enqueue_initial_checkpoint");
      const { result: initialCheckpointTaskRunId, duration: enqueueInitialCheckpointDuration } = await timeIt("enqueueInitialCheckpoint", () => enqueueInitialCheckpoint({ space: currentSpace }));
      stageTimings.enqueueInitialCheckpoint = enqueueInitialCheckpointDuration;
      await progress("bootstrap_ready", { initialCheckpointTaskRunId });
      currentSpace = await updateBootstrap({ space: currentSpace, taskRunId, source, status: "ready", stage: "finalize", finishedAt: new Date().toISOString(), stageTimings, initialCheckpointTaskRunId });
      await publishSpaceFsChanged(currentSpace.id, { source: "bootstrap", resync: true, changes: [] }).catch((error) => logger.warn(`[CreateSpace] Failed to publish bootstrap fs resync for ${currentSpace.id}: ${error instanceof Error ? error.message : String(error)}`));
      await publishSpaceEvent({
        type: "space.workspace.ready",
        spaceId: currentSpace.id,
        payload: {
          source,
          stage: "finalize",
          initialCheckpointTaskRunId,
        },
      }).catch((error) => logger.warn(`[CreateSpace] Failed to publish workspace ready for ${currentSpace.id}: ${error instanceof Error ? error.message : String(error)}`));
      result = { ok: true, spaceId: currentSpace.id, source, initialCheckpointTaskRunId };
    }

    return result;
  } catch (error) {
    await updateBootstrap({ space: currentSpace, taskRunId, source, status: "failed", errorMessage: sanitizeBootstrapError(error), errorCode: getBootstrapErrorCode(error), stageTimings, finishedAt: new Date().toISOString() }).catch(() => undefined);
    throw error;
  }
};

registerTask("create_space", createSpaceHandler);
