import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { SPACE_CUSTOM_THEME_CSS_PATH } from "@cohub/protocol";
import { FS_CDN_LARGE_FILE_THRESHOLD_BYTES, type FsCdnEnvironment } from "./types.js";

// Do not reuse objects/manifests produced before descriptor-bound reads.
const FS_CDN_CACHE_VERSION = "v2";
const forcedCdnPaths = new Set([SPACE_CUSTOM_THEME_CSS_PATH]);

const normalizeFsCdnPath = (path: string) => path.replace(/\\/g, "/").replace(/^\.\/+/, "");

export function isForcedFsCdnPath(path: string) {
  return forcedCdnPaths.has(normalizeFsCdnPath(path));
}

const mediaExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".svg",
  ".bmp",
  ".ico",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".pdf",
]);

export function isFsCdnMediaLike(path: string, mimeType: string | null) {
  if (mimeType?.startsWith("image/")) return true;
  if (mimeType?.startsWith("video/")) return true;
  if (mimeType?.startsWith("audio/")) return true;
  if (mimeType === "application/pdf") return true;
  return mediaExtensions.has(extname(path).toLowerCase());
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
  return `${prefix}fs-cache/${FS_CDN_CACHE_VERSION}/spaces/${input.spaceId}/files/${pathHash}/${version}/${safeFilename}`;
}

export function buildFsCdnManifestKey(input: { env: FsCdnEnvironment; spaceId: string; path: string }) {
  return `space-fs-cdn:${FS_CDN_CACHE_VERSION}:${input.env}:${input.spaceId}:${fsCdnPathHash(input.path)}`;
}

export function buildFsCdnJobId(input: {
  env: FsCdnEnvironment;
  spaceId: string;
  path: string;
  size: number;
  mtimeMs: number;
}) {
  return `fs-cdn|${FS_CDN_CACHE_VERSION}|${input.env}|${input.spaceId}|${fsCdnPathHash(input.path)}|${input.size}|${Math.trunc(input.mtimeMs)}`;
}

export function buildFsCdnFailKey(input: {
  env: FsCdnEnvironment;
  spaceId: string;
  path: string;
  size: number;
  mtimeMs: number;
}) {
  return `space-fs-cdn-fail:${FS_CDN_CACHE_VERSION}:${input.env}:${input.spaceId}:${fsCdnPathHash(input.path)}:${input.size}:${Math.trunc(input.mtimeMs)}`;
}
