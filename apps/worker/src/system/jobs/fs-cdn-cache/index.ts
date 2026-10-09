import { createLogger } from "@cohub/infra/logging";
import { assertWorkspaceId, openSpaceFile } from "@cohub/core/space-fs";
import { basename, isAbsolute, posix, resolve } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Job } from "bullmq";
import { config } from "../../../config.js";
import { redisCommandClient } from "../../../redis.js";
import { registerSystemJob } from "../../registry.js";
import {
  FS_CDN_FAIL_TTL_SECONDS,
  FS_CDN_MANIFEST_TTL_SECONDS,
  FS_CDN_WARM_FILE_JOB,
  type FsCdnManifest,
  type FsCdnWarmFileJob,
} from "./types.js";
import {
  buildFsCdnFailKey,
  buildFsCdnManifestKey,
  buildFsCdnObjectKey,
  fsCdnPathHash,
  shouldUseFsCdnCache,
} from "./policy.js";


const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

const logger = createLogger({ serviceName: "cohub-worker" });
let s3Client: S3Client | null = null;

function getS3Client() {
  if (!config.turnObjectS3Bucket) throw new Error("TURN_OBJECT_S3_BUCKET is required for FS CDN cache");
  if (!config.turnObjectS3Endpoint) throw new Error("TURN_OBJECT_S3_ENDPOINT is required for FS CDN cache");
  if (!config.turnObjectS3AccessKeyId || !config.turnObjectS3SecretAccessKey) {
    throw new Error("TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for FS CDN cache");
  }
  s3Client ??= new S3Client({
    endpoint: config.turnObjectS3Endpoint,
    region: config.turnObjectS3Region,
    forcePathStyle: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.turnObjectS3AccessKeyId,
      secretAccessKey: config.turnObjectS3SecretAccessKey,
    },
  });
  return s3Client;
}

function getCdnBaseUrl() {
  return (process.env.SPACE_FS_CDN_BASE_URL ?? config.turnObjectCdnBaseUrl).replace(/\/+$/, "");
}

function createCdnUrl(objectKey: string) {
  return `${getCdnBaseUrl()}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

function assertSafeRelativePath(input: string) {
  const value = String(input ?? "").replace(/\\/g, "/").trim();
  if (!value || value.startsWith("/") || value.includes("\0")) throw new Error("invalid path");
  const normalized = posix.normalize(value).replace(/\/$/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) throw new Error("invalid path");
  return normalized;
}

async function processWarmFile(job: Job<FsCdnWarmFileJob>) {
  const payload = job.data;
  const startedAt = Date.now();
  assertWorkspaceId(payload.spaceId);
  const relativePath = assertSafeRelativePath(payload.path);
  const file = await openSpaceFile(resolve(config.spaceStorageRoot, payload.spaceId, "workspace"), relativePath);
  try {
    const before = await file.stat();
    if (before.size !== payload.size || before.mtimeMs !== payload.mtimeMs) {
      return { skipped: true, reason: "stale_payload" };
    }
    if (!shouldUseFsCdnCache({ path: relativePath, mimeType: payload.mimeType, size: before.size })) {
      return { skipped: true, reason: "policy_miss" };
    }

    const objectKey = buildFsCdnObjectKey({
      env: config.env,
      spaceId: payload.spaceId,
      path: relativePath,
      size: before.size,
      mtimeMs: before.mtimeMs,
    });

    const body = file.createReadStream({ autoClose: false });
    try {
      await getS3Client().send(new PutObjectCommand({
        Bucket: config.turnObjectS3Bucket,
        Key: objectKey,
        Body: body,
        ContentType: payload.mimeType ?? "application/octet-stream",
        ContentLength: before.size,
        CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
      }));
    } catch (error) {
      body.destroy();
      throw error;
    }

    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      await getS3Client().send(new DeleteObjectCommand({
        Bucket: config.turnObjectS3Bucket,
        Key: objectKey,
      })).catch((error) => {
        logger.warn("[SystemWorker] failed to delete stale fs cdn object", error instanceof Error ? error.message : String(error));
      });
      return { skipped: true, reason: "changed_during_upload" };
    }

    const manifest: FsCdnManifest = {
      path: relativePath,
      pathHash: fsCdnPathHash(relativePath),
      size: before.size,
      mtimeMs: before.mtimeMs,
      mimeType: payload.mimeType,
      objectKey,
      url: createCdnUrl(objectKey),
      createdAt: Date.now(),
      expiresAt: Date.now() + FS_CDN_MANIFEST_TTL_SECONDS * 1000,
    };
    await redisCommandClient.set(
      buildFsCdnManifestKey({ env: config.env, spaceId: payload.spaceId, path: relativePath }),
      JSON.stringify(manifest),
      "EX",
      FS_CDN_MANIFEST_TTL_SECONDS,
    );

    logger.info("[SystemWorker] fs cdn warmed", JSON.stringify({
      spaceId: payload.spaceId,
      pathHash: manifest.pathHash,
      name: basename(relativePath),
      size: manifest.size,
      durationMs: Date.now() - startedAt,
      reason: payload.reason,
    }));
    return { objectKey, size: manifest.size, durationMs: Date.now() - startedAt };
  } finally {
    await file.close();
  }
}

registerSystemJob(FS_CDN_WARM_FILE_JOB, async (job: Job<FsCdnWarmFileJob>) => {
  try {
    return await processWarmFile(job);
  } catch (error) {
    const data = job.data;
    await redisCommandClient.set(
      buildFsCdnFailKey({ env: config.env, spaceId: data.spaceId, path: data.path, size: data.size, mtimeMs: data.mtimeMs }),
      error instanceof Error ? error.message : String(error),
      "EX",
      FS_CDN_FAIL_TTL_SECONDS,
    ).catch(() => undefined);
    throw error;
  }
});
