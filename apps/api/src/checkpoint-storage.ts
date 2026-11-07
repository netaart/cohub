import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ensureCheckpointCommits, type CheckpointObjectReader } from "@cohub/core/checkpoint/storage";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";

const logger = createLogger({ serviceName: "cohub-api" });

let client: S3Client | null = null;
const getClient = () => {
  if (!config.checkpointAssetOssBucket || !config.checkpointAssetOssEndpoint || !config.checkpointAssetOssAccessKeyId || !config.checkpointAssetOssSecretAccessKey) {
    throw new Error("CHECKPOINT_ASSET_OSS_* is required to read checkpoint storage");
  }
  client ??= new S3Client({
    endpoint: config.checkpointAssetOssEndpoint,
    region: config.checkpointAssetOssRegion,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: config.checkpointAssetOssAccessKeyId, secretAccessKey: config.checkpointAssetOssSecretAccessKey },
  });
  return client;
};

const isNotFound = (error: unknown) => {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return value?.name === "NoSuchKey" || value?.name === "NotFound" || value?.$metadata?.httpStatusCode === 404;
};

const getObject = (key: string) => getClient()
  .send(new GetObjectCommand({ Bucket: config.checkpointAssetOssBucket, Key: key }), { abortSignal: AbortSignal.timeout(120_000) })
  .catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });

const objectStore: CheckpointObjectReader = {
  async download(key, filePath) {
    const result = await getObject(key);
    if (!result) return false;
    if (!result.Body) throw new Error(`empty object body: ${key}`);
    await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(filePath));
    return true;
  },
  async readText(key) {
    const result = await getObject(key);
    return result?.Body ? await result.Body.transformToString("utf8") : null;
  },
};

const pending = new Map<string, Promise<void>>();

/**
 * Make checkpoint commits readable in a space's cache repository, fetching
 * their packs from object storage on first use. Completion is recorded in
 * the repository itself, so a deleted cache is refilled on the next read.
 * Concurrent callers share one hydration per commit.
 */
export async function ensureCheckpointObjects(repoDir: string, commits: string[]) {
  await Promise.all([...new Set(commits)].map((commit) => {
    const key = `${repoDir}\0${commit}`;
    let task = pending.get(key);
    if (!task) {
      const started = performance.now();
      task = ensureCheckpointCommits(objectStore, repoDir, [commit]).then(({ installed }) => {
        if (installed > 0) logger.info("[checkpoint-storage] hydrated cache repository", { repoDir, commit, packs: installed, durationMs: Math.round(performance.now() - started) });
      }).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return task;
  }));
}
