import type { RpcEventPayload, RpcRequestMap } from "../sandbox/index.js";
import type {
  SpaceFsEntry,
  SpaceFsFileResponse,
  SpaceFsListOptions,
  SpaceFsMoveInput,
  SpaceFsReadFilesResponse,
  SpaceFsTreePage,
  SpaceFsTreeResponse,
  SpaceFsUploadResponse,
  SpaceFsUploadTargetVersion,
  SpaceFsWriteFileInput,
} from "./index.js";
import { spaceFsVersionMatches } from "./index.js";
import { isModelMime, isTextMime, mimeTypeForPath, normalizeMime } from "./mime.js";

export class SpaceFsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SpaceFsError";
    this.status = status;
    this.code = code;
  }
}

export const spaceFsErrorBody = (error: SpaceFsError) => ({
  code: error.code,
  message: error.message.toLowerCase().replace(/\.$/, ""),
});

const MAX_PATH_CHARS = 4096;
const MAX_PATH_DEPTH = 64;

function normalizeRelative(value: string) {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  const joined = parts.join("/");
  if (!joined) return ".";
  return value.endsWith("/") ? `${joined}/` : joined;
}

export function assertSafeRelativePath(input: string, options?: { allowEmpty?: boolean }) {
  const invalid = () => new SpaceFsError(400, "path_invalid", "Invalid path.");
  const value = String(input ?? "").replace(/\\/g, "/").trim();
  if (!value) {
    if (options?.allowEmpty) return "";
    throw invalid();
  }
  if (value.startsWith("/") || value.includes("\0")) throw invalid();
  const normalized = normalizeRelative(value);
  if (normalized === ".") {
    if (options?.allowEmpty) return "";
    throw invalid();
  }
  if (normalized === ".." || normalized.startsWith("../")) throw invalid();
  if (normalized.length > MAX_PATH_CHARS || normalized.split("/").length > MAX_PATH_DEPTH) throw invalid();
  return normalized;
}

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

const isMediaMime = (mime: string) =>
  mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || mime === "application/pdf";

export function resolveReadMimeType(byName: string | null | undefined, provided: string | null | undefined): string | null {
  const nameMime = normalizeMime(byName);
  const providedMime = normalizeMime(provided);
  if (isTextMime(nameMime) || isModelMime(nameMime)) return nameMime;
  if (providedMime && (isTextMime(providedMime) || isMediaMime(providedMime))) return providedMime;
  return nameMime ?? providedMime;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const utf8 = new TextEncoder();

export type SandboxFsRpcError = Error & { rpcErrorCode: string };
export const isSandboxFsRpcError = (error: unknown): error is SandboxFsRpcError =>
  error instanceof Error && typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === "string";

type FsMethod = keyof RpcRequestMap;

export type SandboxFsCall = <M extends FsMethod>(
  method: M,
  params: RpcRequestMap[M]["params"],
  options?: { onEvent?: (event: RpcEventPayload) => void },
) => Promise<RpcRequestMap[M]["result"]>;

export type SandboxFsFeatures = {
  fsTreePagination?: boolean;
  fsWriteDisposition?: boolean;
  fsWriteExpected?: boolean;
  fsMkdir?: boolean;
  fsDelete?: boolean;
  fsMove?: boolean;
};

export const CURRENT_SANDBOX_FS_FEATURES: Required<SandboxFsFeatures> = {
  fsTreePagination: true,
  fsWriteDisposition: true,
  fsWriteExpected: true,
  fsMkdir: true,
  fsDelete: true,
  fsMove: true,
};

export type SandboxSpaceFsOptions = {
  call: SandboxFsCall;
  features: () => Promise<SandboxFsFeatures | null | undefined>;
  pageLegacy?: (tree: SpaceFsTreeResponse, options: SpaceFsListOptions, truncated: boolean) => SpaceFsTreePage;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_READ_FILES = 50;
const MAX_BATCH_READ_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_READ_CONCURRENCY = 8;
const MAX_TREE_ENTRIES = 1000;
// Older sandboxes reject listings that race a write.
const DIRECTORY_CHANGED_RETRY_DELAYS_MS = [100, 250] as const;

const RPC_ERRORS: Record<string, [number, string, string?]> = {
  INVALID_CURSOR: [400, "invalid_cursor"],
  BAD_REQUEST: [400, "invalid_cursor"],
  DIRECTORY_CHANGED: [409, "directory_changed", "Directory changed. Restart the listing."],
  NOT_FOUND: [404, "path_not_found", "File or directory not found."],
  NOT_DIRECTORY: [400, "not_a_directory", "The selected path is not a directory."],
  NOT_FILE: [400, "not_a_file", "The selected path is not a file."],
  INVALID_PATH: [400, "path_invalid", "Invalid path."],
  ACCESS_DENIED: [400, "path_invalid", "Invalid path."],
  READ_ONLY_FILESYSTEM: [403, "read_only", "This path is read-only."],
  CONFLICT: [409, "file_conflict", "File changed since it was opened."],
  ALREADY_EXISTS: [409, "path_exists", "A file already exists at this path."],
  DIRECTORY_NOT_EMPTY: [400, "directory_not_empty", "Directory is not empty."],
};

export function toSpaceFsError(error: unknown): unknown {
  if (!isSandboxFsRpcError(error)) return error;
  const [status, code, message] = RPC_ERRORS[error.rpcErrorCode] ?? [500, "space_fs_error"];
  return new SpaceFsError(status, code, message ?? error.message);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index] as T);
    }
  }));
  return results;
}

const joinPath = (base: string, rel: string) => (!base ? rel : !rel ? base : `${base.replace(/\/+$/, "")}/${rel}`);
const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

function fileResponse(path: string, read: RpcRequestMap["fs.read"]["result"]): SpaceFsFileResponse {
  const mimeType = resolveReadMimeType(mimeTypeForPath(path), read.mimeType);
  const text = isTextMime(mimeType);
  const content = text
    ? (read.contentBase64 ? new TextDecoder().decode(base64ToBytes(read.contentBase64)) : read.content)
    : (read.contentBase64 ?? bytesToBase64(utf8.encode(read.content)));
  return {
    path,
    name: baseName(path) || path,
    size: read.size ?? utf8.encode(content).length,
    mimeType,
    mtimeMs: read.mtimeMs ?? Date.now(),
    ctimeMs: read.ctimeMs,
    kind: text ? "text" : "binary",
    encoding: text ? "utf-8" : "base64",
    content,
    delivery: "inline",
  };
}

export type SandboxSpaceFs = ReturnType<typeof createSandboxSpaceFs>;

export function createSandboxSpaceFs(options: SandboxSpaceFsOptions) {
  const { call } = options;
  const features = async () => (await options.features()) ?? {};

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw toSpaceFsError(error);
    }
  };

  const tooLarge = () => new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");

  async function statFile(path: string) {
    const stat = await call("fs.stat", { path });
    if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
    if (stat.isDirectory) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
    const size = typeof stat.size === "number" ? stat.size : 0;
    if (size > MAX_FILE_BYTES) throw tooLarge();
    return size;
  }

  async function readFile(path: string) {
    await statFile(path);
    return fileResponse(path, await call("fs.read", { path, binary: true }));
  }

  async function missingDirectories(targetDir: string) {
    if (!targetDir) return [];
    const missing: string[] = [];
    let prefix = "";
    for (const part of targetDir.split("/").filter(Boolean)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (missing.length > 0 || !(await call("fs.stat", { path: prefix }))?.exists) missing.push(prefix);
    }
    return missing;
  }

  async function runArgv(argv: string[]) {
    let stderr = "";
    const result = await call("process.start", { argv }, {
      onEvent: (event) => {
        if (event.type === "stderr") stderr += event.chunk;
      },
    });
    return { exitCode: result.exitCode, stderr: stderr.trim() };
  }

  async function ensureDirectories(path: string, supportsMkdir: boolean) {
    if (!path) return { createdDirs: [] as string[], mtimeMs: Date.now() };
    if (supportsMkdir) {
      const result = await call("fs.mkdir", { path });
      return { createdDirs: result.createdDirs, mtimeMs: result.mtimeMs ?? Date.now() };
    }
    const createdDirs = await missingDirectories(path);
    const { exitCode, stderr } = await runArgv(["mkdir", "-p", "--", path]);
    if (exitCode !== 0) throw new SpaceFsError(400, "mkdir_failed", stderr || "failed to create directory");
    const stats = await call("fs.stat", { path });
    return { createdDirs, mtimeMs: stats.mtimeMs ?? Date.now() };
  }

  /** Native fs.delete/fs.move report OS failures as IO_ERROR; keep the argv path's 400 contract. */
  async function nativeMutation(code: "delete_failed" | "move_failed", operation: () => Promise<unknown>) {
    try {
      await operation();
    } catch (error) {
      if (isSandboxFsRpcError(error) && error.rpcErrorCode === "IO_ERROR") throw new SpaceFsError(400, code, error.message);
      throw error;
    }
  }

  async function readDirectory(path: string, pagination: SpaceFsListOptions | undefined): Promise<SpaceFsTreeResponse | SpaceFsTreePage> {
    const paginated = (await features()).fsTreePagination === true;
    const entries: SpaceFsEntry[] = [];
    let cursor = paginated ? pagination?.cursor : undefined;
    const seen = new Set(cursor ? [cursor] : []);
    let truncated = false;
    do {
      const result = await call("fs.tree", {
        path: path || ".",
        depth: 1,
        limit: pagination?.limit && paginated ? pagination.limit : MAX_TREE_ENTRIES,
        respectGitignore: false,
        ...(paginated ? { pagination: true, cursor } : {}),
      });
      if (paginated && result.nextCursor === undefined) {
        throw new SpaceFsError(502, "invalid_pagination", "Sandbox returned an invalid directory page.");
      }
      for (const entry of result.entries) {
        entries.push({
          name: entry.name,
          path: joinPath(path, entry.path),
          type: entry.type,
          size: entry.size,
          mimeType: entry.type === "file" ? mimeTypeForPath(entry.name) : null,
          mtimeMs: entry.mtimeMs,
        });
      }
      truncated ||= result.truncated !== false;
      const next = paginated ? result.nextCursor : null;
      if (next && seen.has(next)) throw new SpaceFsError(502, "invalid_cursor", "Sandbox returned a repeated directory cursor.");
      if (next) seen.add(next);
      cursor = next ?? undefined;
    } while (!pagination && cursor);
    if (!pagination) return { path, entries };
    if (paginated) return { path, entries, nextCursor: cursor ?? null, truncated };
    if (!options.pageLegacy) throw new SpaceFsError(502, "invalid_pagination", "Sandbox cannot page directories.");
    return options.pageLegacy({ path, entries }, pagination, truncated);
  }

  return {
    list: (path = "", pagination?: SpaceFsListOptions) => run(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await readDirectory(path, pagination);
        } catch (error) {
          const delay = DIRECTORY_CHANGED_RETRY_DELAYS_MS[attempt];
          const changed = isSandboxFsRpcError(error) && error.rpcErrorCode === "DIRECTORY_CHANGED";
          if (!changed || delay === undefined || pagination?.cursor) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }),

    read: (path: string) => run(() => readFile(path)),

    readMany: (paths: string[]) => run(async (): Promise<SpaceFsReadFilesResponse> => {
      if (paths.length === 0) throw new SpaceFsError(400, "paths_required", "paths are required.");
      if (paths.length > MAX_BATCH_READ_FILES) {
        throw new SpaceFsError(413, "too_many_files", `Cannot read more than ${MAX_BATCH_READ_FILES} files at once.`);
      }
      const seen = new Set<string>();
      for (const path of paths) {
        if (typeof path !== "string" || !path) throw new SpaceFsError(400, "path_invalid", "Every path must be a non-empty string.");
        if (seen.has(path)) throw new SpaceFsError(400, "duplicate_path", "Duplicate paths are not allowed.");
        seen.add(path);
      }
      const files: SpaceFsFileResponse[] = [];
      const errors: SpaceFsReadFilesResponse["errors"] = [];
      const readError = (path: string, error: unknown) => {
        const mapped = toSpaceFsError(error);
        if (!(mapped instanceof SpaceFsError)) throw error;
        return { path, code: mapped.code, message: mapped.message, status: mapped.status };
      };
      const stats = await mapWithConcurrency(paths, MAX_BATCH_READ_CONCURRENCY, async (path) => {
        try {
          return { ok: true as const, path, size: await statFile(path) };
        } catch (error) {
          return { ok: false as const, error: readError(path, error) };
        }
      });
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
      const reads = await mapWithConcurrency(toRead, MAX_BATCH_READ_CONCURRENCY, async (path) => {
        try {
          return { ok: true as const, file: fileResponse(path, await call("fs.read", { path, binary: true })) };
        } catch (error) {
          return { ok: false as const, error: readError(path, error) };
        }
      });
      for (const result of reads) {
        if (result.ok) files.push(result.file);
        else errors.push(result.error);
      }
      return { files, errors };
    }),

    statVersion: (path: string) => run(async (): Promise<SpaceFsUploadTargetVersion> => {
      const result = await call("fs.stat", { path: assertSafeRelativePath(path) });
      if (!result.exists) return { exists: false };
      if (result.isDirectory || result.isFile === false) throw new SpaceFsError(400, "not_a_file", "The upload target is not a file.");
      if (typeof result.size !== "number" || typeof result.mtimeMs !== "number") {
        throw new SpaceFsError(500, "space_fs_error", "Upload target metadata is unavailable.");
      }
      return { exists: true, size: result.size, mtimeMs: Math.trunc(result.mtimeMs) };
    }),

    write: (input: SpaceFsWriteFileInput) => run(async () => {
      const path = assertSafeRelativePath(input.path);
      const supported = await features();
      const disposition = supported.fsWriteDisposition === true;
      const current = input.expected || !disposition ? await call("fs.stat", { path }) : null;
      if (input.expected && !spaceFsVersionMatches(current, input.expected)) {
        throw new SpaceFsError(409, "file_conflict", "File changed since it was opened.");
      }
      const legacyCreatedDirs = disposition ? [] : await missingDirectories(parentPath(path));
      // The sandbox re-checks expected atomically with the write under its
      // per-path lock. Older sandboxes ignore unknown fields, which would
      // silently downgrade a conditional write, so only send it when supported.
      const result = await call("fs.write", {
        path,
        content: input.content,
        encoding: input.encoding,
        ...(input.expected && supported.fsWriteExpected === true
          ? { expected: { size: input.expected.size, mtimeMs: Math.trunc(input.expected.mtimeMs) } }
          : {}),
      });
      return {
        path,
        size: result.bytesWritten,
        mtimeMs: result.mtimeMs ?? Date.now(),
        created: disposition ? result.created === true : !current?.exists,
        createdDirs: disposition ? result.createdDirs ?? [] : legacyCreatedDirs,
      };
    }),

    create: (input: SpaceFsWriteFileInput) => run(async () => {
      const path = assertSafeRelativePath(input.path);
      const disposition = (await features()).fsWriteDisposition === true;
      const legacyCreatedDirs = disposition ? [] : await missingDirectories(parentPath(path));
      const result = await call("fs.write", { path, content: input.content, encoding: input.encoding, exclusive: true });
      return {
        path,
        size: result.bytesWritten,
        mtimeMs: result.mtimeMs ?? Date.now(),
        created: true,
        createdDirs: disposition ? result.createdDirs ?? [] : legacyCreatedDirs,
      };
    }),

    mkdir: (path: string) => run(async () => {
      const safePath = assertSafeRelativePath(path);
      const result = await ensureDirectories(safePath, (await features()).fsMkdir === true);
      return { path: safePath, mtimeMs: result.mtimeMs, created: result.createdDirs.includes(safePath), createdDirs: result.createdDirs };
    }),

    remove: (path: string, recursive = false) => run(async () => {
      const safePath = assertSafeRelativePath(path);
      const stat = await call("fs.stat", { path: safePath });
      if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
      const nodeType: "file" | "dir" = stat.isDirectory ? "dir" : "file";
      if ((await features()).fsDelete === true) {
        await nativeMutation("delete_failed", () => call("fs.delete", { path: safePath, recursive }));
        return { path: safePath, deleted: true as const, nodeType };
      }
      // Non-recursive directory delete must fail on non-empty dirs (rmdir parity).
      const argv = stat.isDirectory
        ? (recursive ? ["rm", "-rf", "--", safePath] : ["rmdir", "--", safePath])
        : ["rm", "-f", "--", safePath];
      const { exitCode, stderr } = await runArgv(argv);
      if (exitCode !== 0) {
        if (/not empty|directory not empty/i.test(stderr)) throw new SpaceFsError(400, "directory_not_empty", "Directory is not empty.");
        throw new SpaceFsError(400, "delete_failed", stderr || "failed to delete");
      }
      return { path: safePath, deleted: true as const, nodeType };
    }),

    move: (input: SpaceFsMoveInput) => run(async () => {
      const from = assertSafeRelativePath(input.fromPath);
      const to = assertSafeRelativePath(input.toPath);
      const stat = await call("fs.stat", { path: from });
      if (!stat.exists) throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
      const nodeType: "file" | "dir" = stat.isDirectory ? "dir" : "file";
      const supported = await features();
      const directories = await ensureDirectories(parentPath(to), supported.fsMkdir === true);
      // BSD mv has no -T flag. Reject an existing destination directory so the
      // move keeps exact-target semantics on every backend.
      const target = await call("fs.stat", { path: to });
      if (target.exists && target.isDirectory) throw new SpaceFsError(400, "move_failed", "Destination path is a directory.");
      if (supported.fsMove === true) {
        await nativeMutation("move_failed", () => call("fs.move", { fromPath: from, toPath: to }));
      } else {
        const { exitCode, stderr } = await runArgv(["mv", "--", from, to]);
        if (exitCode !== 0) throw new SpaceFsError(400, "move_failed", stderr || "failed to move");
      }
      return { fromPath: from, toPath: to, nodeType, createdDirs: directories.createdDirs };
    }),

    upload: (files: File[], targetDir: string, limits: { maxFiles: number; maxFileBytes: number }) => run(async (): Promise<SpaceFsUploadResponse> => {
      const safeTargetDir = targetDir ? assertSafeRelativePath(targetDir) : "";
      const errors: SpaceFsUploadResponse["errors"] = [];
      const candidates: Array<{ file: File; name: string; path: string }> = [];
      for (const file of files.slice(0, limits.maxFiles)) {
        const name = sanitizeFileName(file.name);
        if (!name) {
          errors.push({ name: file.name, code: "name_invalid", message: "invalid file name" });
          continue;
        }
        if (file.size > limits.maxFileBytes) {
          errors.push({ name, code: "file_too_large", message: `file exceeds ${limits.maxFileBytes / (1024 * 1024)}MB limit for local sandboxes` });
          continue;
        }
        try {
          candidates.push({ file, name, path: assertSafeRelativePath(safeTargetDir ? `${safeTargetDir}/${name}` : name) });
        } catch {
          errors.push({ name, code: "path_invalid", message: "invalid file path" });
        }
      }
      if (candidates.length === 0) return { uploaded: [], errors, createdDirs: [] };

      const disposition = (await features()).fsWriteDisposition === true;
      const createdDirs = new Set(disposition ? [] : await missingDirectories(safeTargetDir));
      const uploaded: SpaceFsUploadResponse["uploaded"] = [];
      for (const candidate of candidates) {
        try {
          const existing = disposition ? null : await call("fs.stat", { path: candidate.path });
          const result = await call("fs.write", {
            path: candidate.path,
            content: bytesToBase64(new Uint8Array(await candidate.file.arrayBuffer())),
            encoding: "base64",
          });
          if (disposition) for (const path of result.createdDirs ?? []) createdDirs.add(path);
          uploaded.push({
            path: candidate.path,
            name: candidate.name,
            size: result.bytesWritten,
            mimeType: mimeTypeForPath(candidate.name),
            mtimeMs: result.mtimeMs ?? Date.now(),
            created: disposition ? result.created === true : !existing?.exists,
          });
        } catch (error) {
          if (!isSandboxFsRpcError(error)) throw error;
          errors.push({ name: candidate.name, code: "write_failed", message: "failed to write file" });
        }
      }
      return { uploaded, errors, createdDirs: uploaded.length > 0 ? [...createdDirs] : [] };
    }),
  };
}
