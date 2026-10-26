import { randomUUID } from "node:crypto";
import { batchUploadEntries, type CohubHttpClient, type SpaceFsUploadEntry } from "@neta-art/cohub";
import { localUploadSource } from "../local-upload-source.js";
import { createLimiter } from "./limit.js";

export type SpaceFiles = ReturnType<CohubHttpClient["space"]>["files"];

export type LocalUploadEntry = {
  localPath: string;
  relativePath: string;
  size: number;
};

const PUT_CONCURRENCY = 4;

export async function uploadLocalFiles(files: SpaceFiles, entries: LocalUploadEntry[], options: {
  targetDir?: string;
  onUploaded?: (entry: LocalUploadEntry) => void;
} = {}) {
  const uploaded: SpaceFsUploadEntry[] = [];
  const uploadIds: string[] = [];
  const limit = createLimiter(PUT_CONCURRENCY);
  for (const batch of batchUploadEntries(entries, (entry) => entry.size)) {
    const byId = new Map<string, LocalUploadEntry>(batch.map((entry) => [randomUUID(), entry]));
    const plan = await files.createUpload({
      uploadProtocol: "multipart_v1",
      uploadRequestId: randomUUID(),
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
      if (item.uploadUrl || item.multipart) {
        const source = await localUploadSource(entry.localPath, entry.size);
        await files.createUploadTask(item, source).run();
      }
      options.onUploaded?.(entry);
    })));
    const result = await files.completeUpload(plan.uploadId, { entries: plan.entries.map((item) => ({ id: item.id })) });
    uploaded.push(...result.uploaded);
    uploadIds.push(plan.uploadId);
  }
  return { uploaded, uploadIds };
}
