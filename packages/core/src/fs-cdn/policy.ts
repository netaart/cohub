import { createHash } from "node:crypto";
import { basename } from "node:path";
import { SPACE_CUSTOM_THEME_CSS_PATH } from "@cohub/protocol";
import { mimeTypeForPath, normalizeMime } from "@cohub/protocol/fs";
import { FS_CDN_LARGE_FILE_THRESHOLD_BYTES, type FsCdnEnvironment } from "./types.js";

const forcedCdnPaths = new Set([SPACE_CUSTOM_THEME_CSS_PATH]);

const normalizeFsCdnPath = (path: string) => path.replace(/\\/g, "/").replace(/^\.\/+/, "");

export function isForcedFsCdnPath(path: string) {
  return forcedCdnPaths.has(normalizeFsCdnPath(path));
}

const isMediaMime = (mime: string | null) =>
  Boolean(
    mime &&
      (mime.startsWith("image/") ||
        mime.startsWith("video/") ||
        mime.startsWith("audio/") ||
        mime.startsWith("model/") ||
        mime === "application/pdf"),
  );

/** Media, documents and 3D models are served from the CDN regardless of size. */
export function isFsCdnMediaLike(path: string, mimeType: string | null) {
  return isMediaMime(normalizeMime(mimeType)) || isMediaMime(mimeTypeForPath(path));
}

export function shouldUseFsCdnCache(input: { path: string; mimeType: string | null; size: number }) {
  return isForcedFsCdnPath(input.path) || isFsCdnMediaLike(input.path, input.mimeType) || input.size >= FS_CDN_LARGE_FILE_THRESHOLD_BYTES;
}

export function fsCdnPathHash(path: string) {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export function safeFsCdnFilename(path: string) {
  const name = basename(path)
    .split("")
    .map((char) => (char.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(char) ? "_" : char))
    .join("")
    .trim();
  return name || "file";
}

export function buildFsCdnObjectKey(input: {
  env: FsCdnEnvironment;
  spaceId: string;
  path: string;
  size: number;
  mtimeMs: number;
}) {
  const prefix = input.env === "dev" ? "dev/" : "";
  const pathHash = fsCdnPathHash(input.path);
  const safeFilename = safeFsCdnFilename(input.path);
  const version = `${input.size}-${Math.trunc(input.mtimeMs)}`;
  return `${prefix}fs-cache/spaces/${input.spaceId}/files/${pathHash}/${version}/${safeFilename}`;
}

/** Cohub CDN zones answer `Content-Disposition: attachment` when this query is present and keep it out of the cache key. */
export const CDN_DOWNLOAD_QUERY = "download";

export function cdnDownloadUrl(url: string) {
  const download = new URL(url);
  download.searchParams.set(CDN_DOWNLOAD_QUERY, "1");
  return download.toString();
}

export function buildFsCdnManifestKey(input: { env: FsCdnEnvironment; spaceId: string; path: string }) {
  return `space-fs-cdn:${input.env}:${input.spaceId}:${fsCdnPathHash(input.path)}`;
}

export function buildFsCdnJobId(input: {
  env: FsCdnEnvironment;
  spaceId: string;
  path: string;
  size: number;
  mtimeMs: number;
}) {
  return `fs-cdn|${input.env}|${input.spaceId}|${fsCdnPathHash(input.path)}|${input.size}|${Math.trunc(input.mtimeMs)}`;
}

export function buildFsCdnFailKey(input: {
  env: FsCdnEnvironment;
  spaceId: string;
  path: string;
  size: number;
  mtimeMs: number;
}) {
  return `space-fs-cdn-fail:${input.env}:${input.spaceId}:${fsCdnPathHash(input.path)}:${input.size}:${Math.trunc(input.mtimeMs)}`;
}
