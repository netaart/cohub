import { randomUUID } from "node:crypto";
import type { SpaceFsUploadTargetVersion } from "@cohub/protocol/fs";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";
import { createUserUploadGetUrl, createUserUploadPutUrl } from "./user-upload-storage.js";

const UPLOAD_TTL_SECONDS = 24 * 60 * 60;

export type SpaceUploadManifestEntry = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string | null;
  /** Private staging object when client PUTs. Absent when entry is remote (downloadUrl). */
  objectKey?: string;
  /** Durable public URL already uploaded elsewhere; complete pulls from this. */
  downloadUrl?: string;
  /** Target version captured before the client began uploading. */
  targetVersion?: SpaceFsUploadTargetVersion;
};

export type SpaceUploadDestination =
  | { kind: "workspace"; targetDir?: string }
  | { kind: "sandbox_tmp"; sessionId?: string };

export type SpaceUploadManifest = {
  uploadId: string;
  spaceId: string;
  userId: string;
  destination: SpaceUploadDestination;
  entries: SpaceUploadManifestEntry[];
  createdAt: string;
  expiresAt: string;
};

export const createSpaceUploadId = () => randomUUID();

export const buildSpaceUploadObjectKey = (input: { spaceId: string; uploadId: string; entryId: string }) => {
  const envPrefix = config.env === "prod" ? "" : `${config.env}/`;
  return `${envPrefix}uploads/${input.spaceId}/${input.uploadId}/${input.entryId}`;
};

const manifestKey = (spaceId: string, uploadId: string) => `space:fs:upload:${spaceId}:${uploadId}`;
const completeKey = (spaceId: string, uploadId: string) => `space:fs:upload:complete:${spaceId}:${uploadId}`;

export const saveSpaceUploadManifest = async (manifest: SpaceUploadManifest) => {
  await redisCommandClient.set(
    manifestKey(manifest.spaceId, manifest.uploadId),
    JSON.stringify(manifest),
    "EX",
    UPLOAD_TTL_SECONDS,
  );
};

export const getSpaceUploadManifest = async (spaceId: string, uploadId: string) => {
  const raw = await redisCommandClient.get(manifestKey(spaceId, uploadId));
  return raw ? JSON.parse(raw) as SpaceUploadManifest : null;
};

export const deleteSpaceUploadManifest = async (spaceId: string, uploadId: string) => {
  await redisCommandClient.del(manifestKey(spaceId, uploadId));
};

export const beginSpaceUploadComplete = async (spaceId: string, uploadId: string) => {
  const key = completeKey(spaceId, uploadId);
  const ok = await redisCommandClient.set(key, "pending", "EX", UPLOAD_TTL_SECONDS, "NX");
  if (ok === "OK") return { acquired: true as const };
  return { acquired: false as const, taskRunId: await redisCommandClient.get(key) };
};

export const finishSpaceUploadComplete = async (spaceId: string, uploadId: string, taskRunId: string) => {
  await redisCommandClient.set(completeKey(spaceId, uploadId), taskRunId, "EX", UPLOAD_TTL_SECONDS);
};

export const cancelSpaceUploadComplete = async (spaceId: string, uploadId: string) => {
  const key = completeKey(spaceId, uploadId);
  const value = await redisCommandClient.get(key);
  if (value === "pending") await redisCommandClient.del(key);
};

export const createPresignedPutUrl = (
  objectKey: string,
  contentType: string | null | undefined,
  contentLength: number,
) =>
  createUserUploadPutUrl({
    kind: "space_upload",
    objectKey,
    contentType,
    contentLength,
  });

export const createPresignedGetUrl = (objectKey: string) =>
  createUserUploadGetUrl("space_upload", objectKey);
