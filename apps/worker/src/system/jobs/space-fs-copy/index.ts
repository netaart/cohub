import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Job } from "bullmq";
import {
  buildSpaceFsCopyResultKey,
  createSpaceGitignoreFilter,
  SPACE_FS_COPY_JOB,
  SPACE_FS_COPY_RESULT_TTL_SECONDS,
  SPACE_FS_STAGING_PREFIX,
  type SpaceFsCopyJobData,
  type SpaceFsCopyJobResult,
  type SpaceFsCopyRecord,
} from "@cohub/core/space-fs";
import {
  createAgentTurnsQueue,
  enqueueAgentSandboxFsInstallJob,
  type AgentSandboxFsInstallJobData,
  type AgentSandboxFsInstallJobResult,
} from "@cohub/infra/agent-queue";
import { createLogger } from "@cohub/infra/logging";
import type { SpaceFsCopyResult, SpaceFsCopyStats } from "@cohub/protocol/fs";
import { getAgentQueueEvents } from "../../../agent-queue-events.js";
import { config } from "../../../config.js";
import { getSpaceWorkspaceDir } from "../../../git.js";
import { redisCommandClient } from "../../../redis.js";
import { registerSystemJob } from "../../registry.js";
import {
  CopyRequestError,
  createCopyLimits,
  describeFsError,
  emptyCopyStats,
  joinPath,
  parentPath,
  planCopy,
  removeStaging,
  stageCopyOp,
  type CopyOp,
  type CopyRoot,
} from "./tree.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const COPY_IO_CONCURRENCY = 16;
const PROGRESS_INTERVAL_MS = 1000;
const INSTALL_START_TIMEOUT_MS = 10 * 60 * 1000;

let agentQueue: ReturnType<typeof createAgentTurnsQueue<AgentSandboxFsInstallJobData, AgentSandboxFsInstallJobResult>> | null = null;

function getAgentQueue() {
  agentQueue ??= createAgentTurnsQueue<AgentSandboxFsInstallJobData, AgentSandboxFsInstallJobResult>(config.bullmqRedisUrl, "cohub-worker-space-fs-copy");
  return agentQueue;
}

async function openRoot(spaceId: string, visibility: "full" | "filtered"): Promise<CopyRoot> {
  const root = await realpath(getSpaceWorkspaceDir(spaceId)).catch(() => {
    throw new CopyRequestError(404, "space_not_found", "space directory not found");
  });
  return { spaceId, root, filter: visibility === "filtered" ? await createSpaceGitignoreFilter(root) : null };
}

async function installInSandbox(data: SpaceFsCopyJobData, installId: string, entries: AgentSandboxFsInstallJobData["entries"]) {
  const job = await enqueueAgentSandboxFsInstallJob(getAgentQueue(), {
    spaceId: data.targetSpaceId,
    installId,
    entries,
    requestId: data.requestId ?? null,
    trace: data.trace,
  });
  const events = await getAgentQueueEvents();
  while (true) {
    try {
      return await job.waitUntilFinished(events, INSTALL_START_TIMEOUT_MS) as AgentSandboxFsInstallJobResult;
    } catch (error) {
      if (!/timed out/i.test(error instanceof Error ? error.message : String(error))) throw error;
      if (await job.isWaiting()) {
        await job.remove().catch(() => undefined);
        throw error;
      }
    }
  }
}

async function copy(job: Job<SpaceFsCopyJobData>): Promise<SpaceFsCopyJobResult> {
  const data = job.data;
  const limits = createCopyLimits(COPY_IO_CONCURRENCY);
  const target = await openRoot(data.targetSpaceId, "full");
  const roots = new Map<string, Promise<CopyRoot>>();
  const rootFor = (source: SpaceFsCopyJobData["sources"][number]) => {
    const key = `${source.spaceId}:${source.visibility}`;
    if (!roots.has(key)) roots.set(key, openRoot(source.spaceId, source.visibility));
    return roots.get(key) as Promise<CopyRoot>;
  };
  const sources = await Promise.all(data.sources.map(async (source) => ({ root: await rootFor(source), path: source.path })));

  const plan = await planCopy({ target, sources, destination: data.destination, options: data.options, limits });
  const result: SpaceFsCopyResult = { ...emptyCopyStats(), paths: plan.paths, overwritten: 0, skipped: plan.skipped, errors: plan.errors };
  const finish = (): SpaceFsCopyJobResult => {
    result.errors.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, result };
  };
  if (plan.ops.length === 0) return finish();

  const progress = emptyCopyStats();
  const reportProgress = () => job.updateProgress({ ...progress }).catch(() => undefined);
  const timer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
  const stagingId = randomUUID().slice(0, 8);
  const stagingPath = (op: CopyOp, index: number) => joinPath(parentPath(op.targetPath), `${SPACE_FS_STAGING_PREFIX}copy-${stagingId}-${index}`);
  const staged: Array<{ op: CopyOp; stagingPath: string; stats: SpaceFsCopyStats }> = [];

  try {
    await Promise.all(plan.ops.map(async (op, index) => {
      const path = stagingPath(op, index);
      try {
        const outcome = await stageCopyOp({ op, stagingPath: path, targetRoot: target.root, options: data.options, limits, progress });
        result.skipped += outcome.skipped;
        staged.push({ op, stagingPath: path, stats: outcome.stats });
      } catch (error) {
        logger.warn("[SpaceFsCopy] failed to stage entry", { targetSpaceId: data.targetSpaceId, targetPath: op.targetPath, error: error instanceof Error ? error.message : String(error) });
        result.errors.push({ path: op.targetPath, code: "copy_failed", message: `cannot copy '${op.sourcePath || "."}': ${describeFsError(error)}` });
      }
    }));
    await reportProgress();
    if (staged.length === 0) return finish();
    staged.sort((a, b) => a.op.targetPath.localeCompare(b.op.targetPath));

    const install = await installInSandbox(data, `${data.copyId}-${stagingId}`, staged.map(({ op, stagingPath }) => ({
      path: op.targetPath,
      stagingPath,
      kind: op.sourceType === "file" ? "file" : "tree",
      ...(op.expected ? { expected: op.expected } : {}),
    })));
    if (!install.ok) return install;

    const outcomes = new Map(install.results.map((entry) => [entry.path, entry]));
    for (const { op, stats } of staged) {
      const outcome = outcomes.get(op.targetPath);
      if (!outcome?.ok) {
        result.errors.push({ path: op.targetPath, code: outcome?.code ?? "install_failed", message: `cannot create '${op.targetPath}': ${outcome?.message ?? "not installed"}` });
        continue;
      }
      result.files += stats.files;
      result.dirs += stats.dirs;
      result.symlinks += stats.symlinks;
      result.bytes += stats.bytes;
      if (op.kind === "replace") result.overwritten += 1;
    }
    return finish();
  } finally {
    clearInterval(timer);
    await Promise.all(staged.map(({ stagingPath }) => removeStaging(target.root, stagingPath, limits).catch((error) => {
      logger.warn("[SpaceFsCopy] failed to remove staging entry", { targetSpaceId: data.targetSpaceId, stagingPath, error: error instanceof Error ? error.message : String(error) });
    })));
  }
}

async function processSpaceFsCopyJob(job: Job<SpaceFsCopyJobData>) {
  const data = job.data;
  let outcome: SpaceFsCopyJobResult;
  try {
    outcome = await copy(job);
  } catch (error) {
    if (!(error instanceof CopyRequestError)) {
      logger.error("[SpaceFsCopy] copy failed", error, { targetSpaceId: data.targetSpaceId, copyId: data.copyId });
      await rememberOutcome(data, { ok: false, status: 500, code: "copy_failed", message: "failed to copy files" });
      throw error;
    }
    outcome = { ok: false, status: error.status, code: error.code, message: error.message };
  }
  await rememberOutcome(data, outcome);
  return outcome;
}

async function rememberOutcome(data: SpaceFsCopyJobData, outcome: SpaceFsCopyJobResult) {
  const record: SpaceFsCopyRecord = { actorUserId: data.actorUserId, outcome };
  await redisCommandClient
    .set(buildSpaceFsCopyResultKey(config.env, data.targetSpaceId, data.copyId), JSON.stringify(record), "EX", SPACE_FS_COPY_RESULT_TTL_SECONDS)
    .catch((error) => logger.warn("[SpaceFsCopy] failed to persist copy outcome", { copyId: data.copyId, error: error instanceof Error ? error.message : String(error) }));
}

registerSystemJob(SPACE_FS_COPY_JOB, (job) => processSpaceFsCopyJob(job as Job<SpaceFsCopyJobData>));
