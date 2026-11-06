import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { CheckpointObjectReader } from "@cohub/core/checkpoint/storage";
import { config } from "../config.js";

const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

let client: S3Client | null = null;

export const getCheckpointAssetClient = () => {
  if (!config.checkpointAssetOssBucket) throw new Error("CHECKPOINT_ASSET_OSS_BUCKET is required for checkpoint assets");
  if (!config.checkpointAssetOssEndpoint) throw new Error("CHECKPOINT_ASSET_OSS_ENDPOINT is required for checkpoint assets");
  if (!config.checkpointAssetOssAccessKeyId || !config.checkpointAssetOssSecretAccessKey) {
    throw new Error("CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID and CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY are required for checkpoint assets");
  }
  client ??= new S3Client({
    endpoint: config.checkpointAssetOssEndpoint,
    region: config.checkpointAssetOssRegion,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.checkpointAssetOssAccessKeyId,
      secretAccessKey: config.checkpointAssetOssSecretAccessKey,
    },
  });
  return client;
};

export const buildAssetObjectKey = (sha256: string) =>
  `checkpoint-assets/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

export const uploadObjectFileIfMissing = async (input: {
  filePath: string;
  objectKey: string;
  size: number;
  mimeType: string | null;
  metadata?: Record<string, string>;
}) => {
  const Bucket = config.checkpointAssetOssBucket as string;
  const s3 = getCheckpointAssetClient();
  const exists = await s3.send(new HeadObjectCommand({ Bucket, Key: input.objectKey })).then(() => true, () => false);
  if (!exists) {
    await s3.send(new PutObjectCommand({
      Bucket,
      Key: input.objectKey,
      Body: createReadStream(input.filePath),
      ContentLength: input.size,
      ContentType: input.mimeType ?? undefined,
      CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
      Metadata: input.metadata,
    }));
  }
  return input.objectKey;
};

export const uploadAssetIfMissing = async (input: {
  filePath: string;
  sha256: string;
  size: number;
  mimeType: string | null;
}) => uploadObjectFileIfMissing({
  filePath: input.filePath,
  objectKey: buildAssetObjectKey(input.sha256),
  size: input.size,
  mimeType: input.mimeType,
  metadata: { sha256: input.sha256 },
});

const isNotFound = (error: unknown) => {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return value?.name === "NoSuchKey" || value?.name === "NotFound" || value?.$metadata?.httpStatusCode === 404;
};

export const checkpointObjectStore: CheckpointObjectReader = {
  async download(key, filePath) {
    const result = await getCheckpointAssetClient()
      .send(new GetObjectCommand({ Bucket: config.checkpointAssetOssBucket, Key: key }))
      .catch((error) => {
        if (isNotFound(error)) return null;
        throw error;
      });
    if (!result) return false;
    if (!result.Body) throw new Error(`empty object body: ${key}`);
    await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(filePath));
    return true;
  },
  async readText(key) {
    const result = await getCheckpointAssetClient()
      .send(new GetObjectCommand({ Bucket: config.checkpointAssetOssBucket, Key: key }))
      .catch((error) => {
        if (isNotFound(error)) return null;
        throw error;
      });
    if (!result) return null;
    if (!result.Body) throw new Error(`empty object body: ${key}`);
    return await result.Body.transformToString("utf8");
  },
};

export const checkpointObjectExists = (key: string) => getCheckpointAssetClient()
  .send(new HeadObjectCommand({ Bucket: config.checkpointAssetOssBucket, Key: key }))
  .then(() => true, (error) => {
    if (isNotFound(error)) return false;
    throw error;
  });

/** Write an immutable JSON object unless it already exists. */
export const putCheckpointJsonIfMissing = async (key: string, value: unknown) => {
  if (await checkpointObjectExists(key)) return false;
  await getCheckpointAssetClient().send(new PutObjectCommand({
    Bucket: config.checkpointAssetOssBucket,
    Key: key,
    Body: `${JSON.stringify(value)}\n`,
    ContentType: "application/json",
    CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
  }));
  return true;
};
