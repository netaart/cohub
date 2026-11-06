import { createLogger } from "@cohub/infra/logging";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mediaFactsMetadata } from "@cohub/protocol/core";
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
  readMediaFacts,
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

function assertInsideRoot(target: string, root: string) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error("path is outside of space root");
}

function assertSafeRelativePath(input: string) {
  const value = String(input ?? "").replace(/\\/g, "/").trim();
  if (!value || value.startsWith("/") || value.includes("\0")) throw new Error("invalid path");
  return value;
}

async function resolveSpaceFile(spaceId: string, inputPath: string) {
  const safePath = assertSafeRelativePath(inputPath);
  const root = await realpath(resolve(config.spaceStorageRoot, spaceId, "workspace"));
  const target = resolve(root, safePath);
  assertInsideRoot(target, root);
  const realTarget = await realpath(target);
  assertInsideRoot(realTarget, root);
  return { target: realTarget, relativePath: safePath };
}

async function processWarmFile(job: Job<FsCdnWarmFileJob>) {
  const payload = job.data;
  const startedAt = Date.now();
  const { target, relativePath } = await resolveSpaceFile(payload.spaceId, payload.path);
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("target is not a regular file");
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

  const media = await readMediaFacts(target, payload.mimeType);
  // The SDK does not handle Body stream errors (e.g. NFS ESTALE after a concurrent rename):
  // they crash the process and the request never finishes. Give it an error-free stream and
  // abort the upload on source failure so only the job fails.
  const source = createReadStream(target);
  const body = new PassThrough();
  const upload = new AbortController();
  let readError: unknown;
  source.on("error", (error) => {
    readError ??= error;
    upload.abort(error);
  });
  source.pipe(body);
  try {
    await getS3Client().send(new PutObjectCommand({
      Bucket: config.turnObjectS3Bucket,
      Key: objectKey,
      Body: body,
      ContentType: payload.mimeType ?? "application/octet-stream",
      ContentLength: before.size,
      CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
      ...(media ? { Metadata: mediaFactsMetadata(media) } : {}),
    }), { abortSignal: upload.signal });
  } catch (error) {
    throw readError ?? error;
  } finally {
    source.destroy();
    body.destroy();
  }

  const after = await lstat(target);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
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
    ...(media ? { media } : {}),
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
