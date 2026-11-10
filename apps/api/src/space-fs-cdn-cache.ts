import { basename } from "node:path";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";
import {
  FS_CDN_FAIL_TTL_SECONDS,
  FS_CDN_MANIFEST_TTL_SECONDS,
  FS_CDN_POLL_INTERVAL_MS,
  type FsCdnManifest,
  type FsCdnWarmReason,
} from "./space-fs-cdn-constants.js";
import { enqueueFsCdnWarmFile } from "./space-fs-cdn-queue.js";
import {
  buildFsCdnFailKey,
  buildFsCdnManifestKey,
  cdnDownloadUrl,
  shouldUseFsCdnCache,
} from "./space-fs-cdn-policy.js";
import { isTextMime, type SpaceFsFileResponse, type SpaceFsPreparingFile } from "@cohub/protocol/fs";

export type FsCdnFileMeta = {
  spaceId: string;
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  ctimeMs?: number;
};

export function shouldUseFsCdnForMeta(meta: Pick<FsCdnFileMeta, "path" | "mimeType" | "size">) {
  return shouldUseFsCdnCache(meta);
}

function parseManifest(value: string | null): FsCdnManifest | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as FsCdnManifest;
  } catch {
    return null;
  }
}

function isManifestFresh(manifest: FsCdnManifest | null, meta: FsCdnFileMeta) {
  return Boolean(manifest && manifest.path === meta.path && manifest.size === meta.size && manifest.mtimeMs === meta.mtimeMs);
}

export async function getFsCdnManifest(meta: FsCdnFileMeta) {
  const key = buildFsCdnManifestKey({ env: config.env, spaceId: meta.spaceId, path: meta.path });
  const manifest = parseManifest(await redisCommandClient.get(key));
  return isManifestFresh(manifest, meta) ? manifest : null;
}

export async function getFreshFsCdnManifests(items: FsCdnFileMeta[]) {
  if (items.length === 0) return new Map<string, FsCdnManifest>();
  const keys = items.map((item) => buildFsCdnManifestKey({ env: config.env, spaceId: item.spaceId, path: item.path }));
  const values = await redisCommandClient.mget(keys);
  const result = new Map<string, FsCdnManifest>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const manifest = parseManifest(values[index] ?? null);
    if (isManifestFresh(manifest, item)) result.set(item.path, manifest as FsCdnManifest);
  }
  return result;
}

export async function enqueueFsCdnWarmForMeta(meta: FsCdnFileMeta, reason: FsCdnWarmReason) {
  const failKey = buildFsCdnFailKey({
    env: config.env,
    spaceId: meta.spaceId,
    path: meta.path,
    size: meta.size,
    mtimeMs: meta.mtimeMs,
  });
  if (await redisCommandClient.get(failKey)) return;
  await enqueueFsCdnWarmFile({
    spaceId: meta.spaceId,
    path: meta.path,
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    mimeType: meta.mimeType,
    requestedAt: Date.now(),
    reason,
  }).catch(async (error) => {
    await redisCommandClient.set(failKey, error instanceof Error ? error.message : String(error), "EX", FS_CDN_FAIL_TTL_SECONDS).catch(() => undefined);
    throw error;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForFsCdnManifests(items: FsCdnFileMeta[], timeoutMs: number) {
  const pending = new Map(items.map((item) => [item.path, item]));
  const ready = new Map<string, FsCdnManifest>();
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    const metas = Array.from(pending.values());
    const manifests = await getFreshFsCdnManifests(metas);
    for (const [path, manifest] of manifests) {
      ready.set(path, manifest);
      pending.delete(path);
    }
    if (pending.size === 0) break;
    await sleep(Math.min(FS_CDN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }

  return { ready, pending: Array.from(pending.values()) };
}

export async function ensureFsCdnManifest(meta: FsCdnFileMeta, reason: FsCdnWarmReason, timeoutMs: number) {
  const cached = await getFsCdnManifest(meta);
  if (cached) return cached;
  await enqueueFsCdnWarmForMeta(meta, reason);
  const waited = await waitForFsCdnManifests([meta], timeoutMs);
  return waited.ready.get(meta.path) ?? null;
}

export function buildUrlFileResponse(meta: FsCdnFileMeta, manifest: FsCdnManifest): SpaceFsFileResponse {
  const kind = isTextMime(meta.mimeType) ? "text" : "binary";
  return {
    path: meta.path,
    name: meta.name || basename(meta.path),
    size: meta.size,
    mimeType: meta.mimeType,
    mtimeMs: meta.mtimeMs,
    ctimeMs: meta.ctimeMs,
    kind,
    encoding: kind === "text" ? "utf-8" : "base64",
    content: "",
    delivery: "url",
    url: manifest.url,
    downloadUrl: cdnDownloadUrl(manifest.url),
    ...(manifest.media ? { media: manifest.media } : {}),
  };
}

export function buildPreparingFile(meta: FsCdnFileMeta, retryAfterMs = 2000): SpaceFsPreparingFile {
  return {
    path: meta.path,
    name: meta.name || basename(meta.path),
    size: meta.size,
    mimeType: meta.mimeType,
    mtimeMs: meta.mtimeMs,
    retryAfterMs,
  };
}

export function getFsCdnManifestTtlSeconds() {
  return FS_CDN_MANIFEST_TTL_SECONDS;
}
