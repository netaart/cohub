import { FsPaginationError, pageDirectory } from "./fs-pagination.js";
import type { SpaceFsListOptions } from "@cohub/protocol/fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { and, eq } from "drizzle-orm";
import { checkpoints, spaces } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { getTracer } from "@cohub/infra/tracing/propagator";
import { isTextMime, mimeTypeForPath, type SpaceFsEntry, type SpaceFsFileResponse, type SpaceFsTreeResponse } from "@cohub/protocol/fs";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { createPresignedGetObjectUrl } from "./object-presign.js";
import { redisCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-api" });
const tracer = getTracer("cohub-api");

const GIT_TIMEOUT_MS = 3000;
const GIT_TREE_MAX_BYTES = 2 * 1024 * 1024;
const GIT_BLOB_MAX_BYTES = 20 * 1024 * 1024;
// Align with save-side externalization: fulltext git blobs are ≤4MB.
const BLOB_CACHE_MAX_BYTES = 4 * 1024 * 1024;
// Tree / asset pointer payloads are tiny; short fixed TTL is enough.
const META_CACHE_TTL_SECONDS = 2 * 60 * 60;

/** Size-tiered blob TTL. Returns null when the blob should not be cached. */
function blobCacheTtlSeconds(bytes: number): number | null {
  if (bytes > BLOB_CACHE_MAX_BYTES) return null;
  if (bytes <= 16 * 1024) return 2 * 60 * 60; // ≤16KB → 2h
  if (bytes <= 256 * 1024) return 60 * 60; // ≤256KB → 1h
  if (bytes <= 1024 * 1024) return 30 * 60; // ≤1MB → 30m
  return 15 * 60; // ≤4MB → 15m
}

export class CheckpointFsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type CheckpointRecord = typeof checkpoints.$inferSelect;

type GitOutput = {
  stdout: Buffer;
  stderr: string;
};

type AssetPointer = {
  sha256: string;
  size: number;
  mimeType: string | null;
  objectKey: string;
};

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const cacheKey = (kind: "asset" | "blob" | "tree", checkpointId: string, path: string) =>
  `checkpoint-fs:${kind}:${kind === "tree" ? "v2" : "v1"}:${checkpointId}:${sha256Hex(path)}`;

type CheckpointFsOperation = "tree" | "file";

type ObservationMeta = Record<string, string | number | boolean | null | undefined>;

type CheckpointFsStage = ObservationMeta & {
  name: string;
  durationMs: number;
  reason?: string;
  outcome: "ok" | "error";
};

type CheckpointFsObservation = {
  operation: CheckpointFsOperation;
  requestedSpaceId: string;
  requestedCheckpointId: string;
  requestedPath: string | undefined;
  spanStageOverrides?: Partial<Record<string, boolean>>;
  stages: CheckpointFsStage[];
  span: Span;
  normalizedPath?: string;
  resolvedCheckpointId?: string;
  commitHash?: string;
  result?: ObservationMeta;
};

const roundMs = (value: number) => Math.round(value * 100) / 100;

function envFlag(name: string, defaultValue = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value == null || value === "") return defaultValue;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envNumber(name: string, defaultValue: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

const FS_OBSERVABILITY_DETAILED = envFlag("OTEL_FS_OBSERVABILITY_DETAILED", false);
const FS_OBSERVABILITY_LOG_MIN_MS = envNumber("OTEL_FS_OBSERVABILITY_LOG_MIN_MS", 1000);

const pathTelemetry = (path: string | undefined) => {
  const normalized = path ?? "";
  const dotIndex = normalized.lastIndexOf(".");
  const slashIndex = normalized.lastIndexOf("/");
  const extension = dotIndex > slashIndex ? normalized.slice(dotIndex + 1).toLowerCase() : "";
  return {
    pathLength: normalized.length,
    pathDepth: normalized ? normalized.split("/").length : 0,
    pathExtension: extension || null,
  };
};

const setSpanAttributes = (span: Span, attributes: ObservationMeta) => {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    span.setAttribute(key, value);
  }
};

const errorTelemetry = (error: unknown): ObservationMeta => ({
  errorName: error instanceof Error ? error.name : typeof error,
  errorCode: error instanceof CheckpointFsError ? error.code : null,
  errorStatus: error instanceof CheckpointFsError ? error.status : null,
});

const isExpectedError = (error: unknown) => error instanceof CheckpointFsError && error.status < 500;

const safeErrorMessage = (error: unknown) => {
  const telemetry = errorTelemetry(error);
  return String(telemetry.errorCode ?? telemetry.errorName ?? "checkpoint_fs_error");
};

const shouldLogObservation = (durationMs: number, error: unknown) =>
  logger.isInfoEnabled() && (FS_OBSERVABILITY_DETAILED || durationMs >= FS_OBSERVABILITY_LOG_MIN_MS || (error != null && !isExpectedError(error)));

const CHECKPOINT_FS_SPAN_STAGES = new Set([
  "checkpoint_id_resolve",
  "checkpoint_row_lookup",
  "git_object_type",
  "tree_cache_read",
  "git_ls_tree",
  "asset_manifest_read",
  "tree_cache_write",
  "asset_cache_read",
  "asset_cache_write",
  "asset_presign",
  "file_blob_cache_read",
  "file_blob_git_show",
  "file_blob_cache_write",
  "encode_response",
]);

const shouldCreateStageSpan = (name: string) =>
  CHECKPOINT_FS_SPAN_STAGES.has(name) || name.endsWith("_git_show") || name.endsWith("_cache_read") || name.endsWith("_cache_write");

const stageSpanAttributes = (stage: CheckpointFsStage): ObservationMeta => {
  const attributes: ObservationMeta = {
    "checkpoint_fs.stage.name": stage.name,
    "checkpoint_fs.stage.duration_ms": stage.durationMs,
    "checkpoint_fs.stage.outcome": stage.outcome,
  };
  if (stage.reason) attributes["checkpoint_fs.stage.reason"] = stage.reason;
  for (const [key, value] of Object.entries(stage)) {
    if (["name", "durationMs", "reason", "outcome"].includes(key)) continue;
    attributes[`checkpoint_fs.stage.${key}`] = value;
  }
  return attributes;
};

async function observeStage<T>(
  observation: CheckpointFsObservation,
  name: string,
  reason: string,
  fn: () => Promise<T> | T,
  metaForResult?: (result: T) => ObservationMeta,
): Promise<T> {
  const createSpan = observation.spanStageOverrides?.[name] ?? shouldCreateStageSpan(name);
  const stageSpan = createSpan ? tracer.startSpan(`api.checkpoint_fs.${observation.operation}.${name}`) : null;
  const startedAt = performance.now();
  const run = async () => {
    try {
      const result = await fn();
      const durationMs = roundMs(performance.now() - startedAt);
      const stage: CheckpointFsStage = {
        name,
        ...(FS_OBSERVABILITY_DETAILED ? { reason } : {}),
        outcome: "ok",
        durationMs,
        ...(metaForResult?.(result) ?? {}),
      };
      observation.stages.push(stage);
      if (stageSpan) {
        setSpanAttributes(stageSpan, stageSpanAttributes(stage));
        stageSpan.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error) {
      const durationMs = roundMs(performance.now() - startedAt);
      const stage: CheckpointFsStage = {
        name,
        ...(FS_OBSERVABILITY_DETAILED ? { reason } : {}),
        outcome: "error",
        durationMs,
        ...errorTelemetry(error),
      };
      observation.stages.push(stage);
      if (stageSpan) {
        setSpanAttributes(stageSpan, stageSpanAttributes(stage));
        if (!isExpectedError(error)) {
          stageSpan.recordException({ name: error instanceof Error ? error.name : typeof error, message: safeErrorMessage(error) });
          stageSpan.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
        }
      }
      throw error;
    } finally {
      stageSpan?.end();
    }
  };

  return stageSpan ? await context.with(trace.setSpan(context.active(), stageSpan), run) : await run();
}

const summarizeStages = (stages: CheckpointFsStage[]) =>
  stages.map((stage) => ({
    name: stage.name,
    durationMs: stage.durationMs,
    ...(stage.reason ? { reason: stage.reason } : {}),
    outcome: stage.outcome,
    ...Object.fromEntries(Object.entries(stage).filter(([key]) => !["name", "durationMs", "reason", "outcome"].includes(key))),
  }));

async function observeCheckpointFs<T>(
  operation: CheckpointFsOperation,
  input: { spaceId: string; checkpointId: string; path?: string },
  fn: (observation: CheckpointFsObservation) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(`api.checkpoint_fs.${operation}`, {
    attributes: {
      "checkpoint_fs.operation": operation,
      "checkpoint_fs.space_id": input.spaceId,
      "checkpoint_fs.requested_checkpoint_id": input.checkpointId,
      "checkpoint_fs.requested_checkpoint_is_latest": input.checkpointId === "latest",
      ...Object.fromEntries(Object.entries(pathTelemetry(input.path)).map(([key, value]) => [`checkpoint_fs.request.${key}`, value ?? ""])),
    },
  });
  const observation: CheckpointFsObservation = {
    operation,
    requestedSpaceId: input.spaceId,
    requestedCheckpointId: input.checkpointId,
    requestedPath: input.path,
    spanStageOverrides: {
      checkpoint_id_resolve: input.checkpointId === "latest",
    },
    stages: [],
    span,
  };
  const startedAt = performance.now();
  let operationError: unknown;

  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(observation);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      operationError = error;
      if (!isExpectedError(error)) {
        span.recordException({ name: error instanceof Error ? error.name : typeof error, message: safeErrorMessage(error) });
        span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
      }
      throw error;
    } finally {
      const durationMs = roundMs(performance.now() - startedAt);
      const result = observation.result ?? {};
      setSpanAttributes(span, {
        "checkpoint_fs.duration_ms": durationMs,
        "checkpoint_fs.stage_count": observation.stages.length,
        "checkpoint_fs.outcome": operationError ? "error" : "ok",
        "checkpoint_fs.resolved_checkpoint_id": observation.resolvedCheckpointId,
        "checkpoint_fs.commit_hash": observation.commitHash?.slice(0, 12),
        ...Object.fromEntries(Object.entries(result).map(([key, value]) => [`checkpoint_fs.result.${key}`, value])),
      });
      if (shouldLogObservation(durationMs, operationError)) {
        logger.info("[checkpoint-fs] operation observed", {
          operation,
          outcome: operationError ? "error" : "ok",
          durationMs,
          spaceId: input.spaceId,
          requestedCheckpointId: input.checkpointId,
          resolvedCheckpointId: observation.resolvedCheckpointId,
          commitHash: observation.commitHash?.slice(0, 12),
          ...(operationError ? { error: errorTelemetry(operationError) } : {}),
          requestedPath: pathTelemetry(input.path),
          normalizedPath: pathTelemetry(observation.normalizedPath),
          stageCount: observation.stages.length,
          stages: summarizeStages(observation.stages),
          result,
        });
      }
      span.end();
    }
  });
}

const normalizeCheckpointPath = (input = "", options: { allowEmpty?: boolean } = {}) => {
  const value = String(input ?? "").replace(/\\/g, "/");
  if (!value) {
    if (options.allowEmpty) return "";
    throw new CheckpointFsError(400, "path_invalid", "Invalid path.");
  }
  if (value.length > 4096 || value.includes("\0") || isAbsolute(value)) {
    throw new CheckpointFsError(400, "path_invalid", "Invalid path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new CheckpointFsError(400, "path_invalid", "Invalid path.");
  }
  return parts.join("/");
};

export const getCheckpointRepoDir = (spaceId: string) => {
  if (!config.spaceSystemRoot) throw new CheckpointFsError(503, "checkpoint_repo_unavailable", "Checkpoint storage is not configured.");
  const root = resolve(config.spaceSystemRoot);
  const target = resolve(root, spaceId, "repo");
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new CheckpointFsError(400, "path_invalid", "Invalid checkpoint path.");
  return target;
};

const truncate = (value: string, max = 2048) => value.length > max ? value.slice(0, max) : value;

export const runGit = async (repoDir: string, args: string[], maxBytes: number): Promise<GitOutput> => {
  await access(repoDir).catch(() => {
    throw new CheckpointFsError(503, "checkpoint_repo_unavailable", "Checkpoint repository is unavailable.");
  });

  return await new Promise<GitOutput>((resolvePromise, reject) => {
    const child = spawn("git", ["-c", `safe.directory=${repoDir}`, ...args], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new CheckpointFsError(504, "checkpoint_fs_timeout", "Checkpoint file operation timed out."));
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new CheckpointFsError(413, "checkpoint_blob_too_large", "Checkpoint file is too large."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = truncate(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        if (stderr) logger.debug("[checkpoint-fs] git command failed", { repoDir, args, stderr });
        reject(new CheckpointFsError(404, "path_not_found", "File or directory not found."));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(chunks), stderr });
    });
  });
};

const gitObjectSpec = (commitHash: string, path: string) => path ? `${commitHash}:${path}` : commitHash;

async function assertGitObjectType(repoDir: string, checkpoint: CheckpointRecord, path: string, expected: "tree" | "blob", observation?: CheckpointFsObservation) {
  if (!path && expected === "tree") return;
  const readType = () =>
    runGit(repoDir, ["cat-file", "-t", gitObjectSpec(checkpoint.commitHash, path)], 1024).catch((error) => {
      if (error instanceof CheckpointFsError && error.code === "path_not_found") {
        throw new CheckpointFsError(404, "path_not_found", "File or directory not found.");
      }
      throw error;
    });
  const result = observation
    ? await observeStage(
      observation,
      "git_object_type",
      "git cat-file validates whether the path is a blob or tree before the expensive read.",
      readType,
      (output) => ({ expectedType: expected, stdoutBytes: output.stdout.length }),
    )
    : await readType();
  const type = result.stdout.toString("utf8").trim();
  if (expected === "tree" && type !== "tree") throw new CheckpointFsError(400, "not_a_directory", "The selected path is not a directory.");
  if (expected === "blob" && type !== "blob") throw new CheckpointFsError(400, "not_a_file", "The selected path is not a file.");
}

export async function getCheckpointForSpace(spaceId: string, checkpointId: string, observation?: CheckpointFsObservation) {
  const resolvedCheckpointId = await resolveCheckpointId(spaceId, checkpointId, observation);
  observation?.span.setAttribute("checkpoint_fs.resolved_checkpoint_id", resolvedCheckpointId);
  if (observation) observation.resolvedCheckpointId = resolvedCheckpointId;
  const query = () => db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, resolvedCheckpointId), eq(checkpoints.spaceId, spaceId)))
    .limit(1);
  const [checkpoint] = observation
    ? await observeStage(
      observation,
      "checkpoint_row_lookup",
      "Database lookup confirms the resolved checkpoint belongs to the requested space.",
      query,
      (rows) => ({ rowCount: rows.length, found: rows.length > 0 }),
    )
    : await query();
  if (!checkpoint) throw new CheckpointFsError(404, "checkpoint_not_found", "Checkpoint not found.");
  if (observation) {
    observation.commitHash = checkpoint.commitHash;
    observation.span.setAttribute("checkpoint_fs.commit_hash", checkpoint.commitHash.slice(0, 12));
  }
  return checkpoint;
}

async function resolveCheckpointId(spaceId: string, checkpointId: string, observation?: CheckpointFsObservation) {
  if (checkpointId !== "latest") {
    if (observation) {
      return await observeStage(
        observation,
        "checkpoint_id_resolve",
        "The request supplied a concrete checkpoint id, so no latest-head lookup is needed.",
        () => checkpointId,
        () => ({ requestedLatest: false }),
      );
    }
    return checkpointId;
  }
  const lookup = () => db.select({ headCheckpointId: spaces.headCheckpointId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  const [space] = observation
    ? await observeStage(
      observation,
      "checkpoint_id_resolve",
      "The request used latest, so the space head checkpoint is loaded from the database.",
      lookup,
      (rows) => ({ requestedLatest: true, rowCount: rows.length, hasHeadCheckpoint: Boolean(rows[0]?.headCheckpointId) }),
    )
    : await lookup();
  if (!space?.headCheckpointId) throw new CheckpointFsError(404, "checkpoint_not_found", "Checkpoint not found.");
  return space.headCheckpointId;
}

function parseLsTree(output: Buffer, dirPath: string, checkpoint: CheckpointRecord): SpaceFsEntry[] {
  const rawEntries = output.toString("utf8").split("\0").filter(Boolean);
  const entries = rawEntries.map((raw): SpaceFsEntry | null => {
    const tabIndex = raw.indexOf("\t");
    if (tabIndex < 0) return null;
    const meta = raw.slice(0, tabIndex).trim().split(/\s+/);
    const name = raw.slice(tabIndex + 1);
    const mode = meta[0] ?? "";
    const objectType = meta[1] ?? "";
    const sizeRaw = meta[3] ?? "0";
    const type: SpaceFsEntry["type"] = objectType === "tree" ? "dir" : mode === "120000" ? "symlink" : "file";
    const path = dirPath ? `${dirPath}/${name}` : name;
    const size = type === "dir" ? 0 : Number.parseInt(sizeRaw, 10) || 0;
    return {
      name,
      path,
      type,
      size,
      mimeType: type === "file" ? mimeTypeForPath(name) : null,
      mtimeMs: checkpoint.createdAt?.getTime() ?? 0,
    };
  }).filter((entry): entry is SpaceFsEntry => Boolean(entry));

  entries.sort((a, b) => {
    const typeRank = (item: SpaceFsEntry) => item.type === "dir" ? 0 : item.type === "symlink" ? 1 : 2;
    return typeRank(a) - typeRank(b) || a.name.localeCompare(b.name);
  });
  return entries;
}

const encodeCachedBlob = (content: Buffer) => JSON.stringify({ contentBase64: content.toString("base64") });
const decodeCachedBlob = (raw: string | null) => {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { contentBase64?: string };
  return typeof parsed.contentBase64 === "string" ? Buffer.from(parsed.contentBase64, "base64") : null;
};

async function getCachedBlob(repoDir: string, checkpoint: CheckpointRecord, path: string, observation?: CheckpointFsObservation, purpose = "blob") {
  const key = cacheKey("blob", checkpoint.id, path);
  const readCache = async () => {
    let redisError = false;
    const blob = await redisCommandClient.get(key).then(decodeCachedBlob).catch(() => {
      redisError = true;
      return null;
    });
    return { blob, redisError };
  };
  const cachedResult = observation
    ? await observeStage(
      observation,
      `${purpose}_cache_read`,
      "Redis blob cache avoids spawning git show for previously read file content.",
      readCache,
      (result) => ({ cacheKind: "blob", cacheHit: Boolean(result.blob), cachedBytes: result.blob?.length ?? 0, redisError: result.redisError }),
    )
    : await readCache();
  if (cachedResult.blob) return cachedResult.blob;
  const result = observation
    ? await observeStage(
      observation,
      `${purpose}_git_show`,
      "Git show reads blob bytes from the checkpoint repository after a cache miss.",
      () => runGit(repoDir, ["show", gitObjectSpec(checkpoint.commitHash, path)], GIT_BLOB_MAX_BYTES),
      (output) => ({ stdoutBytes: output.stdout.length, maxBytes: GIT_BLOB_MAX_BYTES }),
    )
    : await runGit(repoDir, ["show", gitObjectSpec(checkpoint.commitHash, path)], GIT_BLOB_MAX_BYTES);
  const ttlSeconds = blobCacheTtlSeconds(result.stdout.length);
  if (observation) {
    await observeStage(
      observation,
      `${purpose}_cache_write`,
      "Redis blob cache is refreshed so later reads can avoid git show.",
      async () => {
        if (ttlSeconds == null) return false;
        let written = true;
        await redisCommandClient.set(key, encodeCachedBlob(result.stdout), "EX", ttlSeconds).catch(() => {
          written = false;
        });
        return written;
      },
      (written) => ({
        cacheKind: "blob",
        cacheWritten: written,
        cacheSkipped: ttlSeconds == null,
        ttlSeconds,
        blobBytes: result.stdout.length,
        maxCacheBytes: BLOB_CACHE_MAX_BYTES,
      }),
    );
  } else if (ttlSeconds != null) {
    await redisCommandClient.set(key, encodeCachedBlob(result.stdout), "EX", ttlSeconds).catch(() => undefined);
  }
  return result.stdout;
}

function presignCheckpointAsset(objectKey: string) {
  const signed = createPresignedGetObjectUrl({
    endpoint: config.checkpointAssetOssEndpoint,
    publicEndpoint: config.checkpointAssetOssPublicEndpoint,
    region: config.checkpointAssetOssRegion,
    bucket: config.checkpointAssetOssBucket,
    accessKeyId: config.checkpointAssetOssAccessKeyId,
    secretAccessKey: config.checkpointAssetOssSecretAccessKey,
  }, objectKey);
  return signed;
}

export async function readAssetManifestMap(repoDir: string, checkpoint: CheckpointRecord, observation?: CheckpointFsObservation) {
  const manifestPath = ".cohub/system/checkpoint-assets.v1.json";
  const readManifest = async () => {
    try {
      return await getCachedBlob(repoDir, checkpoint, manifestPath, undefined, "asset_manifest");
    } catch (error) {
      if (error instanceof CheckpointFsError && error.code === "path_not_found") return null;
      logger.debug("[checkpoint-fs] asset manifest is unavailable", { checkpointId: checkpoint.id, error: errorTelemetry(error) });
      return null;
    }
  };
  const blob = observation
    ? await observeStage(
      observation,
      "asset_manifest_read",
      "Asset manifest lookup checks whether checkpoint files have external object-storage pointers.",
      readManifest,
      (value) => ({ manifestFound: Boolean(value), manifestBytes: value?.length ?? 0 }),
    )
    : await readManifest();
  if (!blob) return new Map<string, AssetPointer>();
  try {
    const parse = () => {
      const parsed = JSON.parse(blob.toString("utf8")) as { assets?: Array<{ path: string; sha256: string; size: number; mimeType?: string | null; objectKey: string }> };
      return new Map((parsed.assets ?? []).map((asset) => [asset.path, {
        sha256: asset.sha256,
        size: asset.size,
        mimeType: asset.mimeType ?? null,
        objectKey: asset.objectKey,
      }]));
    };
    return observation
      ? await observeStage(
        observation,
        "asset_manifest_parse",
        "Manifest JSON parsing determines which files can be served from checkpoint asset storage.",
        parse,
        (assets) => ({ assetCount: assets.size, manifestBytes: blob.length }),
      )
      : parse();
  } catch (error) {
    logger.warn("[checkpoint-fs] failed to parse asset manifest", { checkpointId: checkpoint.id, error });
    throw new CheckpointFsError(500, "checkpoint_asset_manifest_invalid", "Checkpoint asset manifest is invalid.");
  }
}

async function getAssetForPath(repoDir: string, checkpoint: CheckpointRecord, path: string, observation?: CheckpointFsObservation) {
  const key = cacheKey("asset", checkpoint.id, path);
  const readCache = async () => {
    let redisError = false;
    const value = await redisCommandClient.get(key).catch(() => {
      redisError = true;
      return null;
    });
    return { value, redisError };
  };
  const cached = observation
    ? await observeStage(
      observation,
      "asset_cache_read",
      "Redis asset pointer cache avoids reading and parsing the checkpoint asset manifest for a single file.",
      readCache,
      (result) => ({ cacheKind: "asset", cacheHit: result.value !== null, cachedBytes: result.value?.length ?? 0, redisError: result.redisError }),
    )
    : await readCache();
  if (cached.value) {
    try {
      return JSON.parse(cached.value) as AssetPointer | null;
    } catch (error) {
      logger.warn("[checkpoint-fs] ignored invalid asset cache", { key, error });
      await redisCommandClient.del(key).catch(() => undefined);
    }
  }
  const asset = (await readAssetManifestMap(repoDir, checkpoint, observation)).get(path) ?? null;
  if (observation) {
    await observeStage(
      observation,
      "asset_cache_write",
      "Redis stores the asset pointer lookup result, including misses, for later reads.",
      async () => {
        let written = true;
        await redisCommandClient.set(key, JSON.stringify(asset), "EX", META_CACHE_TTL_SECONDS).catch(() => {
          written = false;
        });
        return written;
      },
      (written) => ({ cacheKind: "asset", cacheWritten: written, assetFound: Boolean(asset), ttlSeconds: META_CACHE_TTL_SECONDS }),
    );
  } else {
    await redisCommandClient.set(key, JSON.stringify(asset), "EX", META_CACHE_TTL_SECONDS).catch(() => undefined);
  }
  return asset;
}

async function getCachedTree(key: string) {
  const cached = await redisCommandClient.get(key).catch(() => null);
  if (!cached) return null;
  try {
    return JSON.parse(cached) as SpaceFsTreeResponse;
  } catch (error) {
    logger.warn("[checkpoint-fs] ignored invalid tree cache", { key, error });
    await redisCommandClient.del(key).catch(() => undefined);
    return null;
  }
}

export async function listCheckpointDirectory(input: { spaceId: string; checkpointId: string; path?: string; pagination?: SpaceFsListOptions }) {
  return await observeCheckpointFs("tree", input, async (observation) => {
    const path = await observeStage(
      observation,
      "normalize_path",
      "Path validation rejects absolute paths, traversal, empty segments, and oversized input before storage access.",
      () => normalizeCheckpointPath(input.path, { allowEmpty: true }),
      (normalized) => pathTelemetry(normalized),
    );
    observation.normalizedPath = path;

    const checkpoint = await getCheckpointForSpace(input.spaceId, input.checkpointId, observation);
    const repoDir = await observeStage(
      observation,
      "repo_dir_resolve",
      "Local checkpoint repository path is derived and constrained under the configured storage root.",
      () => getCheckpointRepoDir(checkpoint.spaceId),
      () => ({ repoConfigured: Boolean(config.spaceSystemRoot) }),
    );
    const finish = (tree: SpaceFsTreeResponse) => input.pagination
      ? pageDirectory(tree, JSON.stringify([input.spaceId, path]), input.pagination, { version: checkpoint.id })
      : tree;
    const key = cacheKey("tree", checkpoint.id, path);
    const cached = await observeStage(
      observation,
      "tree_cache_read",
      "Redis tree cache avoids git ls-tree, manifest reads, and entry merge work for stable checkpoint directories.",
      () => getCachedTree(key),
      (value) => ({ cacheKind: "tree", cacheHit: Boolean(value), entryCount: value?.entries.length ?? 0 }),
    );
    if (cached) {
      observation.result = { delivery: "cache", entryCount: cached.entries.length, cacheHit: true };
      return finish(cached);
    }

    await assertGitObjectType(repoDir, checkpoint, path, "tree", observation);
    const result = await observeStage(
      observation,
      "git_ls_tree",
      "Git ls-tree enumerates directory entries after a tree cache miss.",
      () => runGit(repoDir, ["ls-tree", "-z", "-l", gitObjectSpec(checkpoint.commitHash, path)], GIT_TREE_MAX_BYTES),
      (output) => ({ stdoutBytes: output.stdout.length, maxBytes: GIT_TREE_MAX_BYTES }),
    );
    const entries = await observeStage(
      observation,
      "parse_tree",
      "NUL-delimited git output is decoded, sorted, and enriched with basic MIME metadata.",
      () => parseLsTree(result.stdout, path, checkpoint),
      (value) => ({ entryCount: value.length }),
    );
    const assets = await readAssetManifestMap(repoDir, checkpoint, observation);
    let assetMatches = 0;
    const merged = await observeStage(
      observation,
      "merge_asset_metadata",
      "Asset manifest pointers replace git blob size and MIME metadata for files stored outside git.",
      () => entries.map((entry) => {
        const asset = entry.type === "file" ? assets.get(entry.path) : null;
        if (!asset) return entry;
        assetMatches += 1;
        return { ...entry, size: asset.size, mimeType: asset.mimeType ?? mimeTypeForPath(entry.name) };
      }),
      (value) => ({ entryCount: value.length, assetCount: assets.size, assetMatches }),
    );
    const response = { path, entries: merged };
    await observeStage(
      observation,
      "tree_cache_write",
      "Redis tree cache stores the merged directory response for stable checkpoint browsing.",
      async () => {
        let written = true;
        await redisCommandClient.set(key, JSON.stringify(response), "EX", META_CACHE_TTL_SECONDS).catch(() => {
          written = false;
        });
        return written;
      },
      (written) => ({ cacheKind: "tree", cacheWritten: written, ttlSeconds: META_CACHE_TTL_SECONDS, entryCount: response.entries.length }),
    );
    observation.result = { delivery: "inline", entryCount: response.entries.length, cacheHit: false };
    return finish(response);
  });
}

export async function readCheckpointFile(input: { spaceId: string; checkpointId: string; path?: string }): Promise<SpaceFsFileResponse> {
  return await observeCheckpointFs("file", input, async (observation) => {
    const path = await observeStage(
      observation,
      "normalize_path",
      "Path validation rejects empty file paths, absolute paths, traversal, empty segments, and oversized input before storage access.",
      () => normalizeCheckpointPath(input.path, { allowEmpty: false }),
      (normalized) => pathTelemetry(normalized),
    );
    observation.normalizedPath = path;

    const checkpoint = await getCheckpointForSpace(input.spaceId, input.checkpointId, observation);
    const repoDir = await observeStage(
      observation,
      "repo_dir_resolve",
      "Local checkpoint repository path is derived and constrained under the configured storage root.",
      () => getCheckpointRepoDir(checkpoint.spaceId),
      () => ({ repoConfigured: Boolean(config.spaceSystemRoot) }),
    );
    await assertGitObjectType(repoDir, checkpoint, path, "blob", observation);
    const mimeType = await observeStage(
      observation,
      "mime_resolve",
      "MIME type decides whether non-asset blob content can be returned as UTF-8 text or base64 binary.",
      () => mimeTypeForPath(path),
      (value) => ({ mimeType: value ?? "unknown", textLike: isTextMime(value) }),
    );
    const asset = await observeStage(
      observation,
      "asset_lookup",
      "Asset pointer lookup checks whether this file should be served by signed object-storage URL instead of inline git bytes.",
      () => getAssetForPath(repoDir, checkpoint, path, observation),
      (value) => ({ assetFound: Boolean(value), assetBytes: value?.size ?? 0, assetMimeType: value?.mimeType ?? null }),
    );
    if (asset) {
      const signed = await observeStage(
        observation,
        "asset_presign",
        "Object-storage presign creates a temporary download URL for large or binary checkpoint assets.",
        () => presignCheckpointAsset(asset.objectKey),
        () => ({ delivery: "url", assetBytes: asset.size }),
      );
      const assetMime = asset.mimeType ?? mimeType;
      const kind: SpaceFsFileResponse["kind"] = isTextMime(assetMime) ? "text" : "binary";
      observation.result = { delivery: "url", size: asset.size, kind, mimeType: assetMime, cacheHit: null };
      return {
        path,
        name: basename(path),
        size: asset.size,
        mimeType: assetMime,
        mtimeMs: checkpoint.createdAt?.getTime() ?? 0,
        kind,
        encoding: kind === "text" ? "utf-8" as const : "base64" as const,
        content: "",
        delivery: "url",
        url: signed.downloadUrl,
      };
    }
    const blob = await getCachedBlob(repoDir, checkpoint, path, observation, "file_blob");
    const response = await observeStage(
      observation,
      "encode_response",
      "Inline response encoding converts git blob bytes to UTF-8 text or base64 depending on MIME classification.",
      () => {
        const kind: SpaceFsFileResponse["kind"] = isTextMime(mimeType) ? "text" : "binary";
        return {
          path,
          name: basename(path),
          size: blob.length,
          mimeType,
          mtimeMs: checkpoint.createdAt?.getTime() ?? 0,
          kind,
          encoding: kind === "text" ? "utf-8" as const : "base64" as const,
          content: kind === "text" ? blob.toString("utf8") : blob.toString("base64"),
          delivery: "inline" as const,
        };
      },
      (value) => ({ delivery: value.delivery, size: value.size, kind: value.kind, encoding: value.encoding }),
    );
    observation.result = { delivery: response.delivery, size: response.size, kind: response.kind, mimeType, cacheHit: false };
    return response;
  });
}

export function checkpointFsJsonError(error: unknown) {
  if (error instanceof CheckpointFsError || error instanceof FsPaginationError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : "Checkpoint file operation failed.";
  return { status: 500, body: { code: "checkpoint_fs_error", message } };
}
