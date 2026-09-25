import { basename } from "node:path";
import { SandboxRpcError } from "@cohub/sandbox-client";
import {
  spaceFsVersionMatches,
  type SpaceFsEntry,
  type SpaceFsFileResponse,
  type SpaceFsMoveInput,
  type SpaceFsReadFilesResponse,
  type SpaceFsTreeResponse,
  type SpaceFsUploadResponse,
  type SpaceFsUploadTargetVersion,
  type SpaceFsWriteFileInput,
} from "@cohub/protocol/fs";
import type { RpcEventPayload } from "@cohub/protocol/sandbox";
import { INLINE_UPLOAD_MAX_FILES, LOCAL_SANDBOX_UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import { assertSafeRelativePath, getMimeType, isTextMime, resolveReadMimeType, sanitizeFileName, SpaceFsError } from "./space-fs.js";
import type { SpaceFsVisibility } from "./space-fs-ignore.js";
import { callSandboxRpc, getSandboxCapabilities, SandboxOfflineError } from "./space-sandbox-rpc.js";

// Local-sandbox filesystem backend. Mirrors the direct (PVC) backend's public
// surface so routes stay provider-agnostic, but every operation is served over
// the sandbox RPC relay against the user's machine. Reads never touch cloud
// storage; writes land only on the local workspace.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_READ_FILES = 50;
const MAX_BATCH_READ_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_READ_CONCURRENCY = 8;
const MAX_TREE_ENTRIES = 1000;

// Local spaces are owner-only (M1), so the owner always gets full visibility.
// Filtered visibility has no meaningful server-side enforcement here yet.
function assertFullVisibility(visibility: SpaceFsVisibility) {
  if (visibility === "filtered") {
    throw new SpaceFsError(403, "forbidden", "Filtered file access is not available for local sandboxes.");
  }
}

// Reject paths that would escape the workspace. Unlike fs.* RPCs (fenced by the
// sandbox via realpath), the mkdir/rm/mv operations run through process.start
// argv, which the sandbox fence does not inspect. We therefore enforce a
// lexical containment check here for every path we hand to the backend, keeping
// local parity with the cloud backend's assertInsideRoot guard. Symlink-based
// escape is out of scope (owner-only spaces on the user's own machine).
const assertSafeSubpath = assertSafeRelativePath;

// Translate sandbox RPC failures into the SpaceFsError vocabulary the routes
// and web client already understand. Offline errors bubble up as 503.
function mapRpcError(error: unknown): never {
  if (error instanceof SpaceFsError || error instanceof SandboxOfflineError) throw error;
  if (error instanceof SandboxRpcError) {
    switch (error.rpcErrorCode) {
      case "NOT_FOUND":
        throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
      case "NOT_DIRECTORY":
        throw new SpaceFsError(400, "not_a_directory", "The selected path is not a directory.");
      case "INVALID_PATH":
      case "ACCESS_DENIED":
        throw new SpaceFsError(400, "path_invalid", "Invalid path.");
      case "READ_ONLY_FILESYSTEM":
        throw new SpaceFsError(403, "read_only", "This path is read-only.");
      case "CONFLICT":
        throw new SpaceFsError(409, "file_conflict", "File changed since it was opened.");
      default:
        throw new SpaceFsError(500, "space_fs_error", error.message);
    }
  }
  throw new SpaceFsError(500, "space_fs_error", "space file operation failed");
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

const toPosixJoin = (base: string, rel: string) => {
  if (!base) return rel;
  if (!rel) return base;
  return `${base.replace(/\/+$/, "")}/${rel}`;
};

const parentPath = (path: string) => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
};

async function collectMissingRemoteDirectories(spaceId: string, targetDir: string) {
  if (!targetDir) return [];
  const parts = targetDir.split("/").filter(Boolean);
  const missing: string[] = [];
  let prefix = "";
  for (let index = 0; index < parts.length; index += 1) {
    prefix = prefix ? `${prefix}/${parts[index]}` : (parts[index] as string);
    if (missing.length > 0) {
      missing.push(prefix);
      continue;
    }
    const stats = await callSandboxRpc(spaceId, "fs.stat", { path: prefix });
    if (!stats?.exists) missing.push(prefix);
  }
  return missing;
}

export async function listSpaceDirectory(
  spaceId: string,
  path = "",
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsTreeResponse> {
  const visibility = options?.visibility ?? "full";
  assertFullVisibility(visibility);
  try {
    const result = await callSandboxRpc(spaceId, "fs.tree", {
      path: path || ".",
      depth: 1,
      limit: MAX_TREE_ENTRIES,
      respectGitignore: false,
    });
    const entries: SpaceFsEntry[] = result.entries.map((entry) => {
      const relPath = toPosixJoin(path, entry.path);
      return {
        name: entry.name,
        path: relPath,
        type: entry.type,
        size: entry.size,
        mimeType: entry.type === "file" ? getMimeType(entry.name) : null,
        mtimeMs: entry.mtimeMs,
      };
    });
    return { path, entries };
  } catch (error) {
    mapRpcError(error);
  }
}

function buildFileResponse(relativePath: string, params: {
  content: string;
  contentBase64?: string;
  mimeType?: string;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}): SpaceFsFileResponse {
  // Prefer filename text types over generic sandbox sniffs (e.g. .npmrc → octet-stream).
  const mimeType = resolveReadMimeType(getMimeType(relativePath), params.mimeType);
  const kind = isTextMime(mimeType) ? "text" : "binary";
  const content = kind === "text"
    ? (params.contentBase64 ? Buffer.from(params.contentBase64, "base64").toString("utf8") : params.content)
    : (params.contentBase64 ?? Buffer.from(params.content, "utf8").toString("base64"));
  return {
    path: relativePath,
    name: basename(relativePath) || relativePath,
    size: params.size ?? Buffer.byteLength(content),
    mimeType,
    mtimeMs: params.mtimeMs ?? Date.now(),
    ctimeMs: params.ctimeMs,
    kind,
    encoding: kind === "text" ? "utf-8" : "base64",
    content,
    delivery: "inline",
  };
}

async function readFileEnforcingLimit(spaceId: string, path: string): Promise<SpaceFsFileResponse> {
  const stat = await callSandboxRpc(spaceId, "fs.stat", { path });
  if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  if (stat.isDirectory) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
  if (typeof stat.size === "number" && stat.size > MAX_FILE_BYTES) {
    throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");
  }
  // Always read binary-safe; buildFileResponse decides text vs base64 by MIME.
  const read = await callSandboxRpc(spaceId, "fs.read", { path, binary: true });
  return buildFileResponse(path, read);
}

// Stat a file for batch reads: validates it is a readable file within the
// per-file cap and returns its size so the caller can enforce the batch total
// before pulling any content into API memory.
async function statForBatch(spaceId: string, path: string): Promise<number> {
  const stat = await callSandboxRpc(spaceId, "fs.stat", { path });
  if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  if (stat.isDirectory) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
  const size = typeof stat.size === "number" ? stat.size : 0;
  if (size > MAX_FILE_BYTES) {
    throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");
  }
  return size;
}

export async function readSpaceFile(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsFileResponse> {
  assertFullVisibility(options?.visibility ?? "full");
  try {
    return await readFileEnforcingLimit(spaceId, path);
  } catch (error) {
    mapRpcError(error);
  }
}

export async function readSpaceFiles(
  spaceId: string,
  paths: string[],
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsReadFilesResponse> {
  assertFullVisibility(options?.visibility ?? "full");
  if (paths.length === 0) throw new SpaceFsError(400, "paths_required", "paths are required.");
  if (paths.length > MAX_BATCH_READ_FILES) {
    throw new SpaceFsError(413, "too_many_files", `Cannot read more than ${MAX_BATCH_READ_FILES} files at once.`);
  }
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== "string" || !p) throw new SpaceFsError(400, "path_invalid", "Every path must be a non-empty string.");
    if (seen.has(p)) throw new SpaceFsError(400, "duplicate_path", "Duplicate paths are not allowed.");
    seen.add(p);
  }

  const files: SpaceFsFileResponse[] = [];
  const errors: SpaceFsReadFilesResponse["errors"] = [];

  const toReadError = (path: string, error: unknown) => {
    if (error instanceof SandboxOfflineError) throw error;
    if (error instanceof SandboxRpcError && error.rpcErrorCode === "IO_ERROR") throw new SandboxOfflineError(spaceId, error);
    const status = error instanceof SpaceFsError ? error.status : 500;
    const code = error instanceof SpaceFsError ? error.code : "space_fs_error";
    const message = error instanceof Error ? error.message : "Failed to read file.";
    return { path, code, message, status };
  };

  // Phase 1: stat all paths (bounded concurrency) to learn sizes cheaply.
  const stats = await mapWithConcurrency(paths, MAX_BATCH_READ_CONCURRENCY, async (path) => {
    try {
      return { ok: true as const, path, size: await statForBatch(spaceId, path) };
    } catch (error) {
      return { ok: false as const, error: toReadError(path, error) };
    }
  });

  // Phase 2: enforce the batch total against stat sizes, then read only the
  // files that fit — never pulling more than the cap into API memory.
  const toRead: string[] = [];
  let totalBytes = 0;
  for (const result of stats) {
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    if (totalBytes + result.size > MAX_BATCH_READ_TOTAL_BYTES) {
      throw new SpaceFsError(413, "batch_too_large", "Total inline file size exceeds 20MB.");
    }
    totalBytes += result.size;
    toRead.push(result.path);
  }

  const read = await mapWithConcurrency(toRead, MAX_BATCH_READ_CONCURRENCY, async (path) => {
    try {
      const content = await callSandboxRpc(spaceId, "fs.read", { path, binary: true });
      return { ok: true as const, file: buildFileResponse(path, content) };
    } catch (error) {
      return { ok: false as const, error: toReadError(path, error) };
    }
  });

  for (const result of read) {
    if (result.ok) files.push(result.file);
    else errors.push(result.error);
  }

  return { files, errors };
}

export async function statSpaceFileVersion(spaceId: string, path: string): Promise<SpaceFsUploadTargetVersion> {
  const safePath = assertSafeSubpath(path);
  try {
    const result = await callSandboxRpc(spaceId, "fs.stat", { path: safePath });
    if (!result.exists) return { exists: false };
    if (result.isDirectory || result.isFile === false) {
      throw new SpaceFsError(400, "not_a_file", "The upload target is not a file.");
    }
    if (typeof result.size !== "number" || typeof result.mtimeMs !== "number") {
      throw new SpaceFsError(500, "space_fs_error", "Upload target metadata is unavailable.");
    }
    return { exists: true, size: result.size, mtimeMs: Math.trunc(result.mtimeMs) };
  } catch (error) {
    mapRpcError(error);
  }
}

export async function writeSpaceFile(spaceId: string, input: SpaceFsWriteFileInput) {
  const path = assertSafeSubpath(input.path);
  try {
    const capabilities = await getSandboxCapabilities(spaceId);
    const supportsDisposition = capabilities?.fsWriteDisposition === true;
    const current = input.expected || !supportsDisposition
      ? await callSandboxRpc(spaceId, "fs.stat", { path })
      : null;
    if (input.expected) {
      if (!spaceFsVersionMatches(current, input.expected)) {
        throw new SpaceFsError(409, "file_conflict", "File changed since it was opened.");
      }
    }
    const legacyCreatedDirs = supportsDisposition
      ? []
      : await collectMissingRemoteDirectories(spaceId, parentPath(path));
    // Pass expected through to the sandbox: the version check and the write
    // run atomically under the sandbox's per-path lock, closing the TOCTOU
    // window between the stat above and the write. mtimeMs is truncated to
    // whole milliseconds to match the Go RPC's int64 field (see
    // matchesSpaceFsVersion). Only forwarded when the sandbox advertises
    // fsWriteExpected: older sandboxes silently ignore unknown fields, which
    // would downgrade a conditional write to an unconditional one.
    const supportsExpected = capabilities?.fsWriteExpected === true;
    const result = await callSandboxRpc(spaceId, "fs.write", {
      path,
      content: input.content,
      encoding: input.encoding,
      ...(input.expected && supportsExpected
        ? { expected: { size: input.expected.size, mtimeMs: Math.trunc(input.expected.mtimeMs) } }
        : {}),
    });
    return {
      path,
      size: result.bytesWritten,
      mtimeMs: result.mtimeMs ?? Date.now(),
      created: supportsDisposition ? result.created === true : !current?.exists,
      createdDirs: supportsDisposition ? result.createdDirs ?? [] : legacyCreatedDirs,
    };
  } catch (error) {
    mapRpcError(error);
  }
}

export async function createSpaceFileExclusive(spaceId: string, input: SpaceFsWriteFileInput) {
  const path = assertSafeSubpath(input.path);
  try {
    const capabilities = await getSandboxCapabilities(spaceId);
    const supportsDisposition = capabilities?.fsWriteDisposition === true;
    const legacyCreatedDirs = supportsDisposition
      ? []
      : await collectMissingRemoteDirectories(spaceId, parentPath(path));
    // Atomic exclusive create: the sandbox opens with O_EXCL and fails with
    // ALREADY_EXISTS if the path is taken, so concurrent creates cannot clobber.
    const result = await callSandboxRpc(spaceId, "fs.write", {
      path,
      content: input.content,
      encoding: input.encoding,
      exclusive: true,
    });
    return {
      path,
      size: result.bytesWritten,
      mtimeMs: result.mtimeMs ?? Date.now(),
      created: true,
      createdDirs: supportsDisposition ? result.createdDirs ?? [] : legacyCreatedDirs,
    };
  } catch (error) {
    if (error instanceof SandboxRpcError && error.rpcErrorCode === "ALREADY_EXISTS") {
      throw new SpaceFsError(409, "path_exists", "A file already exists at this path.");
    }
    mapRpcError(error);
  }
}

// Run a shell-less argv command and capture stderr for error reporting.
async function runProcess(spaceId: string, argv: string[]): Promise<{ exitCode: number | null; stderr: string }> {
  let stderr = "";
  const onEvent = (event: RpcEventPayload) => {
    if (event.type === "stderr") stderr += event.chunk;
  };
  const result = await callSandboxRpc(spaceId, "process.start", { argv }, { onEvent });
  return { exitCode: result.exitCode, stderr: stderr.trim() };
}

async function ensureRemoteDirectories(spaceId: string, path: string, supportsMkdir: boolean) {
  if (!path) return { createdDirs: [] as string[], mtimeMs: Date.now() };
  if (supportsMkdir) {
    const result = await callSandboxRpc(spaceId, "fs.mkdir", { path });
    return { createdDirs: result.createdDirs, mtimeMs: result.mtimeMs ?? Date.now() };
  }

  const createdDirs = await collectMissingRemoteDirectories(spaceId, path);
  const { exitCode, stderr } = await runProcess(spaceId, ["mkdir", "-p", "--", path]);
  if (exitCode !== 0) throw new SpaceFsError(400, "mkdir_failed", stderr || "failed to create directory");
  const stats = await callSandboxRpc(spaceId, "fs.stat", { path });
  return { createdDirs, mtimeMs: stats.mtimeMs ?? Date.now() };
}

export async function createSpaceDirectory(spaceId: string, path: string) {
  const safePath = assertSafeSubpath(path);
  try {
    const capabilities = await getSandboxCapabilities(spaceId);
    const result = await ensureRemoteDirectories(spaceId, safePath, capabilities?.fsMkdir === true);
    return {
      path: safePath,
      mtimeMs: result.mtimeMs,
      created: result.createdDirs.includes(safePath),
      createdDirs: result.createdDirs,
    };
  } catch (error) {
    mapRpcError(error);
  }
}

export async function deleteSpaceNode(spaceId: string, path: string, recursive = false) {
  const safePath = assertSafeSubpath(path);
  try {
    const stat = await callSandboxRpc(spaceId, "fs.stat", { path: safePath });
    if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
    const nodeType: SpaceFsEntry["type"] | "unknown" = stat.isDirectory ? "dir" : "file";
    // Non-recursive directory delete must fail on non-empty dirs (rmdir parity).
    const argv = stat.isDirectory
      ? (recursive ? ["rm", "-rf", "--", safePath] : ["rmdir", "--", safePath])
      : ["rm", "-f", "--", safePath];
    const { exitCode, stderr } = await runProcess(spaceId, argv);
    if (exitCode !== 0) {
      if (/not empty|directory not empty/i.test(stderr)) {
        throw new SpaceFsError(400, "directory_not_empty", "Directory is not empty.");
      }
      throw new SpaceFsError(400, "delete_failed", stderr || "failed to delete");
    }
    return { path: safePath, deleted: true, nodeType };
  } catch (error) {
    mapRpcError(error);
  }
}

export async function moveSpaceNode(spaceId: string, input: SpaceFsMoveInput) {
  const from = assertSafeSubpath(input.fromPath);
  const to = assertSafeSubpath(input.toPath);
  try {
    const stat = await callSandboxRpc(spaceId, "fs.stat", { path: from });
    if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
    const nodeType: SpaceFsEntry["type"] | "unknown" = stat.isDirectory ? "dir" : "file";
    const targetParent = parentPath(to);
    const capabilities = await getSandboxCapabilities(spaceId);
    const directoryResult = await ensureRemoteDirectories(spaceId, targetParent, capabilities?.fsMkdir === true);
    // BSD mv has no -T flag. Reject an existing destination directory before
    // using the portable argv form so the API keeps exact-target semantics.
    const targetStat = await callSandboxRpc(spaceId, "fs.stat", { path: to });
    if (targetStat.exists && targetStat.isDirectory) {
      throw new SpaceFsError(400, "move_failed", "Destination path is a directory.");
    }
    const { exitCode, stderr } = await runProcess(spaceId, ["mv", "--", from, to]);
    if (exitCode !== 0) throw new SpaceFsError(400, "move_failed", stderr || "failed to move");
    return { fromPath: from, toPath: to, nodeType, createdDirs: directoryResult.createdDirs };
  } catch (error) {
    mapRpcError(error);
  }
}

// Download variant: local files are read over RPC (bounded); routes serve the
// buffer directly (no CDN path for local spaces).
export async function downloadSpaceFile(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<{ name: string; mimeType: string | null; buffer: Buffer }> {
  assertFullVisibility(options?.visibility ?? "full");
  try {
    const file = await readFileEnforcingLimit(spaceId, path);
    const buffer = file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8");
    return { name: file.name, mimeType: file.mimeType, buffer };
  } catch (error) {
    mapRpcError(error);
  }
}

type UploadCandidate = { file: File; name: string; path: string };

function prepareUploadCandidates(
  files: File[],
  targetDir: string,
): { candidates: UploadCandidate[]; errors: SpaceFsUploadResponse["errors"] } {
  const candidates: UploadCandidate[] = [];
  const errors: SpaceFsUploadResponse["errors"] = [];
  for (const file of files.slice(0, INLINE_UPLOAD_MAX_FILES)) {
    const safeName = sanitizeFileName(file.name);
    if (!safeName) {
      errors.push({ name: file.name, code: "name_invalid", message: "invalid file name" });
      continue;
    }
    if (file.size > LOCAL_SANDBOX_UPLOAD_MAX_FILE_BYTES) {
      errors.push({ name: safeName, code: "file_too_large", message: `file exceeds ${LOCAL_SANDBOX_UPLOAD_MAX_FILE_BYTES / (1024 * 1024)}MB limit for local sandboxes` });
      continue;
    }
    try {
      candidates.push({
        file,
        name: safeName,
        path: assertSafeSubpath(targetDir ? `${targetDir}/${safeName}` : safeName),
      });
    } catch {
      errors.push({ name: safeName, code: "path_invalid", message: "invalid file path" });
    }
  }
  return { candidates, errors };
}

export async function uploadSpaceFiles(
  spaceId: string,
  files: File[],
  targetDir: string,
): Promise<SpaceFsUploadResponse> {
  const safeTargetDir = targetDir ? assertSafeSubpath(targetDir) : "";
  const { candidates, errors } = prepareUploadCandidates(files, safeTargetDir);
  if (candidates.length === 0) return { uploaded: [], errors, createdDirs: [] };

  try {
    const capabilities = await getSandboxCapabilities(spaceId);
    const supportsDisposition = capabilities?.fsWriteDisposition === true;
    const createdDirs = new Set(
      supportsDisposition ? [] : await collectMissingRemoteDirectories(spaceId, safeTargetDir),
    );
    const uploaded: SpaceFsUploadResponse["uploaded"] = [];

    for (const candidate of candidates) {
      try {
        const existing = supportsDisposition
          ? null
          : await callSandboxRpc(spaceId, "fs.stat", { path: candidate.path });
        const buffer = Buffer.from(await candidate.file.arrayBuffer());
        const result = await callSandboxRpc(spaceId, "fs.write", {
          path: candidate.path,
          content: buffer.toString("base64"),
          encoding: "base64",
        });
        if (supportsDisposition) {
          for (const path of result.createdDirs ?? []) createdDirs.add(path);
        }
        uploaded.push({
          path: candidate.path,
          name: candidate.name,
          size: result.bytesWritten,
          mimeType: getMimeType(candidate.name),
          mtimeMs: result.mtimeMs ?? Date.now(),
          created: supportsDisposition ? result.created === true : !existing?.exists,
        });
      } catch (error) {
        if (error instanceof SandboxOfflineError) throw error;
        errors.push({ name: candidate.name, code: "write_failed", message: "failed to write file" });
      }
    }

    return { uploaded, errors, createdDirs: uploaded.length > 0 ? [...createdDirs] : [] };
  } catch (error) {
    mapRpcError(error);
  }
}
