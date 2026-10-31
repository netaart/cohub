import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { posix } from "node:path";
import {
  batchUploadEntries,
  LocalWorkspaceUnavailableError,
  localWorkspaceHttpError,
  mimeTypeForPath,
  type CohubHttpClient,
  type LocalWorkspace,
  type SpaceFsUploadEntry,
} from "@neta-art/cohub";
import { putLocalFile } from "../http-put.js";
import { createLimiter } from "./limit.js";

export type SpaceFiles = ReturnType<CohubHttpClient["space"]>["files"];

export type LocalUploadEntry = {
  localPath: string;
  relativePath: string;
  size: number;
};

const PUT_CONCURRENCY = 4;

type UploadOptions = {
  targetDir?: string;
  onUploaded?: (entry: LocalUploadEntry) => void;
};

export const uploadsDirectly = async (files: SpaceFiles) => Boolean((await files.workspace())?.put);

export async function uploadLocalFiles(files: SpaceFiles, entries: LocalUploadEntry[], options: UploadOptions = {}) {
  const workspace = await files.workspace();
  if (!workspace?.put) return uploadThroughApi(files, entries, options);
  const { uploaded, remaining } = await putLocalFiles(workspace, workspace.put, entries, options);
  if (!remaining.length) return { uploaded, uploadIds: [] };
  const rest = await uploadThroughApi(files, remaining, options);
  return { uploaded: [...uploaded, ...rest.uploaded], uploadIds: rest.uploadIds };
}

async function putLocalFiles(workspace: LocalWorkspace, put: NonNullable<LocalWorkspace["put"]>, entries: LocalUploadEntry[], options: UploadOptions) {
  const limit = createLimiter(PUT_CONCURRENCY);
  const uploaded: SpaceFsUploadEntry[] = [];
  const remaining: LocalUploadEntry[] = [];
  const failures: unknown[] = [];
  await Promise.all(entries.map((entry) => limit(async () => {
    const path = options.targetDir ? posix.join(options.targetDir, entry.relativePath) : entry.relativePath;
    try {
      // As the API's uploads do: a file edited meanwhile is a conflict, never overwritten.
      const version = await workspace.fs.statVersion(path);
      const expected = version.exists ? { expected: { size: version.size, mtimeMs: version.mtimeMs } } : { exclusive: true as const };
      const result = await put(path, await openAsBlob(entry.localPath), expected);
      const name = posix.basename(path);
      uploaded.push({ path, name, size: result.bytesWritten, mimeType: mimeTypeForPath(name), mtimeMs: result.mtimeMs ?? Date.now(), created: result.created });
      options.onUploaded?.(entry);
    } catch (error) {
      if (error instanceof LocalWorkspaceUnavailableError) remaining.push(entry);
      else failures.push(error);
    }
  })));
  if (failures.length) throw localWorkspaceHttpError(failures[0]);
  return { uploaded, remaining };
}

async function uploadThroughApi(files: SpaceFiles, entries: LocalUploadEntry[], options: UploadOptions) {
  const uploaded: SpaceFsUploadEntry[] = [];
  const uploadIds: string[] = [];
  const limit = createLimiter(PUT_CONCURRENCY);
  for (const batch of batchUploadEntries(entries, (entry) => entry.size)) {
    const byId = new Map<string, LocalUploadEntry>(batch.map((entry) => [randomUUID(), entry]));
    const plan = await files.createUpload({
      destination: { kind: "workspace", targetDir: options.targetDir },
      entries: [...byId].map(([id, entry]) => ({
        id,
        name: entry.relativePath.split("/").at(-1) ?? entry.relativePath,
        relativePath: entry.relativePath,
        size: entry.size,
        mimeType: null,
      })),
    });
    await Promise.all(plan.entries.map((item) => limit(async () => {
      const entry = byId.get(item.id);
      if (!entry) throw new Error(`Missing upload entry: ${item.id}`);
      if (item.uploadUrl) {
        await putLocalFile({ url: item.uploadUrl, filePath: entry.localPath, size: entry.size, headers: item.headers, label: entry.relativePath });
      }
      options.onUploaded?.(entry);
    })));
    const result = await files.completeUpload(plan.uploadId, { entries: plan.entries.map((item) => ({ id: item.id })) });
    uploaded.push(...result.uploaded);
    uploadIds.push(plan.uploadId);
  }
  return { uploaded, uploadIds };
}
