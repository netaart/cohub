import { randomUUID } from "node:crypto";
import {
  UPLOAD_MAX_BATCH_BYTES,
  UPLOAD_MAX_BATCH_FILES,
  type CohubHttpClient,
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

function batches(entries: LocalUploadEntry[]) {
  const result: LocalUploadEntry[][] = [];
  let batch: LocalUploadEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length > 0 && (batch.length >= UPLOAD_MAX_BATCH_FILES || bytes + entry.size > UPLOAD_MAX_BATCH_BYTES)) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.size;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

export async function uploadLocalFiles(files: SpaceFiles, entries: LocalUploadEntry[], options: {
  targetDir?: string;
  onUploaded?: (entry: LocalUploadEntry) => void;
} = {}) {
  const uploaded: SpaceFsUploadEntry[] = [];
  const uploadIds: string[] = [];
  const limit = createLimiter(PUT_CONCURRENCY);
  for (const batch of batches(entries)) {
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
