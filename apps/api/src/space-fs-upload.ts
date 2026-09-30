/**
 * Multipart upload helpers shared by the direct, remote and sandbox write
 * paths. Kept free of space-fs.ts imports so they stay testable in isolation.
 */
import { INLINE_UPLOAD_MAX_FILE_BYTES, INLINE_UPLOAD_MAX_FILES, INLINE_WRITE_MAX_BYTES } from "@cohub/protocol";
import type { SpaceFsUploadResponse } from "@cohub/protocol/fs";
import { getMimeType } from "./space-fs-mime.js";

export function sanitizeFileName(name: string): string | null {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, "")
    .split("")
    .filter((c) => c.charCodeAt(0) > 0x1f)
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 255);
  return cleaned || null;
}

export type UploadCandidate = { file: File; name: string; relativePath: string };
export type UploadLimit = { maxBytes: number; message: string };

export const DIRECT_UPLOAD_LIMIT: UploadLimit = {
  maxBytes: INLINE_UPLOAD_MAX_FILE_BYTES,
  message: `file exceeds ${INLINE_UPLOAD_MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
};

/** Inline sandbox writes travel through the job queue, which caps their size. */
export const SANDBOX_UPLOAD_LIMIT: UploadLimit = {
  maxBytes: INLINE_WRITE_MAX_BYTES,
  message: `file exceeds ${INLINE_WRITE_MAX_BYTES / (1024 * 1024)}MB limit while the sandbox is running; use a staged upload`,
};

export function prepareUploadCandidates(
  files: File[],
  targetDir: string,
  limit: UploadLimit,
): { candidates: UploadCandidate[]; errors: SpaceFsUploadResponse["errors"] } {
  const candidates: UploadCandidate[] = [];
  const errors: SpaceFsUploadResponse["errors"] = [];
  for (const file of files.slice(0, INLINE_UPLOAD_MAX_FILES)) {
    const safeName = sanitizeFileName(file.name);
    if (!safeName) {
      errors.push({ name: file.name, code: "name_invalid", message: "invalid file name" });
      continue;
    }
    if (file.size > limit.maxBytes) {
      errors.push({ name: safeName, code: "file_too_large", message: limit.message });
      continue;
    }
    candidates.push({
      file,
      name: safeName,
      relativePath: targetDir ? `${targetDir}/${safeName}` : safeName,
    });
  }
  return { candidates, errors };
}

export type SandboxUploadWrite = (input: { path: string; content: string }) => Promise<{
  path: string;
  size: number;
  mtimeMs: number;
  created: boolean;
  createdDirs: string[];
}>;

/**
 * Writes multipart uploads through a running cloud sandbox, one base64 write
 * per file, so the sandbox watcher and workspace index see every file and
 * every directory the writes create. `targetDir` must already be validated.
 */
export async function writeUploadsThroughSandbox(
  files: File[],
  targetDir: string,
  write: SandboxUploadWrite,
): Promise<SpaceFsUploadResponse> {
  const { candidates, errors } = prepareUploadCandidates(files, targetDir, SANDBOX_UPLOAD_LIMIT);
  const uploaded: SpaceFsUploadResponse["uploaded"] = [];
  const createdDirs: string[] = [];
  for (const candidate of candidates) {
    try {
      const content = Buffer.from(await candidate.file.arrayBuffer()).toString("base64");
      const result = await write({ path: candidate.relativePath, content });
      for (const dir of result.createdDirs) {
        if (!createdDirs.includes(dir)) createdDirs.push(dir);
      }
      uploaded.push({
        path: result.path,
        name: candidate.name,
        size: result.size,
        mimeType: getMimeType(candidate.name),
        mtimeMs: result.mtimeMs,
        created: result.created,
      });
    } catch (error) {
      // SpaceFsError messages are written for clients; others stay internal.
      // Matched by name to avoid importing space-fs.ts.
      const message = error instanceof Error && error.name === "SpaceFsError"
        ? error.message.toLowerCase().replace(/\.$/, "")
        : "failed to write file";
      errors.push({ name: candidate.name, code: "write_failed", message });
    }
  }
  return { uploaded, errors, createdDirs };
}
