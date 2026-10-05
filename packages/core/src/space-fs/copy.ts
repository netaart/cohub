import { createHash } from "node:crypto";
import type { SpaceFsCopyOptions, SpaceFsCopyResult, SpaceFsCopySource } from "@cohub/protocol/fs";
import type { SpaceFsVisibility } from "./ignore.js";

export const SPACE_FS_COPY_JOB = "space_fs.copy";

export type SpaceFsCopyJobSource = SpaceFsCopySource & {
  visibility: SpaceFsVisibility;
};

export type SpaceFsCopyJobData = {
  copyId: string;
  actorUserId: string;
  targetSpaceId: string;
  sources: SpaceFsCopyJobSource[];
  destination: string;
  options: SpaceFsCopyOptions;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type SpaceFsCopyJobResult =
  | { ok: true; result: SpaceFsCopyResult }
  | { ok: false; status: number; code: string; message: string };

const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

export function buildSpaceFsCopyId(input: Pick<SpaceFsCopyJobData, "actorUserId" | "targetSpaceId" | "sources" | "destination" | "options"> & { mutationId: string }) {
  const payload = JSON.stringify([
    input.actorUserId,
    input.targetSpaceId,
    input.sources.map((source) => [source.spaceId, source.path]),
    input.destination,
    [input.options.recursive === true, input.options.noClobber === true, input.options.preserveTimestamps === true],
  ]);
  const payloadHash = createHash("sha1").update(payload).digest("hex").slice(0, 16);
  const key = SAFE_TOKEN.test(input.mutationId)
    ? input.mutationId
    : createHash("sha1").update(input.mutationId).digest("hex").slice(0, 32);
  return `${key}-${payloadHash}`;
}

export const isValidSpaceFsCopyId = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export const buildSpaceFsCopyJobId = (targetSpaceId: string, copyId: string) => `space-fs-copy-${targetSpaceId}-${copyId}`;

export type SpaceFsCopyRecord = {
  actorUserId: string;
  outcome: SpaceFsCopyJobResult;
};

export const buildSpaceFsCopyResultKey = (env: string, targetSpaceId: string, copyId: string) =>
  `space-fs-copy:${env}:${targetSpaceId}:${copyId}`;

export const SPACE_FS_COPY_RESULT_TTL_SECONDS = 3600;
