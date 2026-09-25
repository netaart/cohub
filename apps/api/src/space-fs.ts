
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { createLogger } from "@cohub/infra/logging";
import { BOARD_EXTENSION, BOARD_MIME_TYPE, INLINE_UPLOAD_MAX_FILE_BYTES, INLINE_UPLOAD_MAX_FILES } from "@cohub/protocol";
import { getTracer } from "@cohub/infra/tracing/propagator";
import {
  buildPreparingFile,
  buildUrlFileResponse,
  ensureFsCdnManifest,
  enqueueFsCdnWarmForMeta,
  getFreshFsCdnManifests,
  shouldUseFsCdnForMeta,
  waitForFsCdnManifests,
  type FsCdnFileMeta,
} from "./space-fs-cdn-cache.js";
import { FS_CDN_READ_MANY_WAIT_TIMEOUT_MS, FS_CDN_READ_WAIT_TIMEOUT_MS } from "./space-fs-cdn-constants.js";
import { config } from "./config.js";
import { createSpaceGitignoreFilter, type SpaceFsVisibility } from "./space-fs-ignore.js";
import {
  matchesSpaceFsVersion,
  type SpaceFsEntry,
  type SpaceFsFileResponse,
  type SpaceFsMoveInput,
  type SpaceFsReadFilesError,
  type SpaceFsReadFilesResponse,
  type SpaceFsPreparingFile,
  type SpaceFsTreeResponse,
  type SpaceFsUploadResponse,
  type SpaceFsUploadTargetVersion,
  type SpaceFsWriteFileInput,
} from "@cohub/protocol/fs";
import { isTextMime } from "./space-fs-mime.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_READ_FILES = 50;
const MAX_BATCH_READ_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_READ_CONCURRENCY = 8;
const MAX_DIR_ENTRIES = 1000;
const MAX_PATH_CHARS = 4096;
const MAX_PATH_DEPTH = 64;
const SPACE_REAL_ROOT_CACHE_TTL_MS = 30_000;
const logger = createLogger({ serviceName: "cohub-api" });
const tracer = getTracer("cohub-api");

export class SpaceFsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpaceFsError";
  }
}

const mimeByExt: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".csv": "text/csv",
  [BOARD_EXTENSION]: BOARD_MIME_TYPE,
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".svelte": "text/x-svelte",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++src",
  ".hpp": "text/x-c++hdr",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".pdf": "application/pdf",
  ".exe": "application/x-msdownload",
  ".dmg": "application/x-apple-diskimage",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
};

export function getMimeType(path: string) {
  const lower = basename(path).toLowerCase();
  if (lower === "dockerfile") return "text/x-dockerfile";
  if (lower === "makefile") return "text/x-makefile";

  const extMimeType = mimeByExt[extname(lower)];
  if (extMimeType) return extMimeType;

  if (lower.startsWith(".")) return "text/plain";
  return null;
}

export { isTextMime, normalizeMime, resolveReadMimeType } from "./space-fs-mime.js";

/**
 * Prefer inline UTF-8 for text-like files even when CDN policy would otherwise
 * force URL delivery (e.g. `.cohub/theme.css`). The browser editor needs content;
 * CDN can still serve styles/downloads in parallel after background warm.
 */
export function prefersInlineTextPreview(
  meta: { mimeType: string | null; size: number },
  maxInlineBytes = MAX_FILE_BYTES,
) {
  return isTextMime(meta.mimeType) && meta.size <= maxInlineBytes;
}

function ensureStorageConfigured() {
  if (!config.spaceStorageRoot) {
    throw new SpaceFsError(503, "space_storage_not_configured", "Space file storage is not configured.");
  }
}

function getSpaceBaseDir(spaceId: string) {
  ensureStorageConfigured();
  return resolve(config.spaceStorageRoot, spaceId);
}

export function getSpaceRoot(spaceId: string) {
  return resolve(getSpaceBaseDir(spaceId), "workspace");
}

export async function ensureSpaceWorkspaceReady(spaceId: string) {
  const spaceBaseDir = getSpaceBaseDir(spaceId);
  const workspaceDir = getSpaceRoot(spaceId);
  await mkdir(spaceBaseDir, { recursive: true, mode: 0o775 });
  await mkdir(workspaceDir, { recursive: true, mode: 0o775 });
  await Promise.all([
    chmod(spaceBaseDir, 0o775).catch(() => undefined),
    chmod(workspaceDir, 0o775).catch(() => undefined),
  ]);
  return { spaceBaseDir, workspaceDir };
}

export function assertSafeRelativePath(input: string, options?: { allowEmpty?: boolean }) {
  const value = String(input ?? "").replace(/\\/g, "/").trim();
  if (!value) {
    if (options?.allowEmpty) return "";
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  if (value.startsWith("/") || value.includes("\0")) {
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  const normalized = posix.normalize(value);
  if (normalized === ".") {
    if (options?.allowEmpty) return "";
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  if (normalized.length > MAX_PATH_CHARS || normalized.split("/").length > MAX_PATH_DEPTH) {
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  return normalized;
}

type CachedSpaceRealRoot = {
  root: string;
  rootReal: string;
  expiresAt: number;
};

const spaceRealRootCache = new Map<string, CachedSpaceRealRoot>();

async function resolveSpaceRealRoot(spaceId: string) {
  const root = getSpaceRoot(spaceId);
  const now = Date.now();
  const cached = spaceRealRootCache.get(spaceId);
  if (cached && cached.root === root && cached.expiresAt > now) return { root, rootReal: cached.rootReal };
  try {
    const rootReal = await realpath(root);
    spaceRealRootCache.set(spaceId, { root, rootReal, expiresAt: now + SPACE_REAL_ROOT_CACHE_TTL_MS });
    return { root, rootReal };
  } catch {
    spaceRealRootCache.delete(spaceId);
    throw new SpaceFsError(404, "space_not_found", "Space directory not found.");
  }
}

export function assertInsideRoot(target: string, root: string) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new SpaceFsError(400, "path_invalid", "Invalid path.");
}

async function resolveTarget(
  spaceId: string,
  inputPath: string,
  options?: { allowEmpty?: boolean },
) {
  const safePath = assertSafeRelativePath(inputPath, { allowEmpty: options?.allowEmpty });
  const { rootReal } = await resolveSpaceRealRoot(spaceId);
  const target = resolve(rootReal, safePath);
  assertInsideRoot(target, rootReal);
  return { root: rootReal, target, relativePath: safePath };
}

async function ensureDirectories(root: string, targetDir: string) {
  const rel = relative(root, targetDir);
  if (!rel || rel === ".") return [];
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const created: string[] = [];
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] as string);
    try {
      await mkdir(current);
      created.push(parts.slice(0, index + 1).join("/"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await stat(current)).isDirectory()) {
        throw new SpaceFsError(400, "not_a_directory", "A parent path is not a directory.");
      }
    }
  }
  return created;
}

async function writeFileWithDisposition(path: string, data: Buffer) {
  while (true) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx");
      try {
        await handle.writeFile(data);
        return true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      handle = await open(path, constants.O_WRONLY | constants.O_TRUNC);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      await handle.writeFile(data);
      return false;
    } finally {
      await handle.close();
    }
  }
}

async function assertVisiblePath(
  filter: Awaited<ReturnType<typeof createSpaceGitignoreFilter>> | null,
  relativePath: string,
  options?: { isDirectory?: boolean },
) {
  if (!filter || !relativePath) return;
  if (filter.isIgnored(relativePath, options)) {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
}

async function createVisibilityFilter(root: string, visibility: SpaceFsVisibility) {
  return visibility === "filtered" ? await createSpaceGitignoreFilter(root) : null;
}

function toRelativePath(root: string, absPath: string) {
  return relative(root, absPath).replace(/\\/g, "/");
}

function entryType(stats: Awaited<ReturnType<typeof lstat>>): SpaceFsEntry["type"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  return "file";
}

async function toEntry(root: string, absPath: string, name: string): Promise<SpaceFsEntry> {
  const stats = await lstat(absPath);
  const type = entryType(stats);
  return {
    name,
    path: toRelativePath(root, absPath),
    type,
    size: stats.size,
    mimeType: type === "file" ? getMimeType(name) : null,
    mtimeMs: stats.mtimeMs,
  };
}

type SpaceFsOperation = "tree" | "file" | "directory_files" | "files" | "stream";

type ObservationMeta = Record<string, string | number | boolean | null | undefined>;

type SpaceFsStage = ObservationMeta & {
  name: string;
  durationMs: number;
  reason?: string;
  outcome: "ok" | "error";
};

type SpaceFsObservation = {
  operation: SpaceFsOperation;
  requestedSpaceId: string;
  requestedPath: string | undefined;
  visibility: SpaceFsVisibility;
  spanStageOverrides?: Partial<Record<string, boolean>>;
  stages: SpaceFsStage[];
  span: Span;
  normalizedPath?: string;
  result?: ObservationMeta;
};

const roundMs = (value: number) => Math.round(value * 100) / 100;

function envFlag(name: string, defaultValue = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value == null || value === "") return defaultValue;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envNumber(name: string, defaultValue: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

const FS_OBSERVABILITY_DETAILED = envFlag("OTEL_FS_OBSERVABILITY_DETAILED", false);
const FS_OBSERVABILITY_LOG_MIN_MS = envNumber("OTEL_FS_OBSERVABILITY_LOG_MIN_MS", 1000);

const pathTelemetry = (path: string | undefined) => {
  const normalized = path ?? "";
  const dotIndex = normalized.lastIndexOf(".");
  const slashIndex = normalized.lastIndexOf("/");
  const extension = dotIndex > slashIndex ? normalized.slice(dotIndex + 1).toLowerCase() : "";
  return {
    pathLength: normalized.length,
    pathDepth: normalized ? normalized.split("/").length : 0,
    pathExtension: extension || null,
  };
};

const setSpanAttributes = (span: Span, attributes: ObservationMeta) => {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    span.setAttribute(key, value);
  }
};

const errorTelemetry = (error: unknown): ObservationMeta => {
  const name = error instanceof Error ? error.name : typeof error;
  const sysCode = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: name,
    errorCode: error instanceof SpaceFsError ? error.code : sysCode,
    errorStatus: error instanceof SpaceFsError ? error.status : null,
    errorMessage: message.length <= 256 ? message : `${message.slice(0, 256)}…`,
  };
};

const isExpectedError = (error: unknown) => error instanceof SpaceFsError && error.status < 500;

const safeErrorMessage = (error: unknown) => {
  const telemetry = errorTelemetry(error);
  return String(telemetry.errorCode ?? telemetry.errorName ?? "space_fs_error");
};

const shouldLogObservation = (durationMs: number, error: unknown) =>
  logger.isInfoEnabled() && (FS_OBSERVABILITY_DETAILED || durationMs >= FS_OBSERVABILITY_LOG_MIN_MS || (error != null && !isExpectedError(error)));

const SPACE_FS_SPAN_STAGES = new Set([
  "resolve_target",
  "target_stat",
  "visibility_filter",
  "directory_read",
  "entry_stats",
  "cdn_manifest",
  "inline_read",
  "inline_encode",
  "directory_walk",
  "metadata_read",
  "cdn_manifest_read",
  "cdn_warm_enqueue",
  "cdn_manifest_wait",
]);

const shouldCreateStageSpan = (name: string) => SPACE_FS_SPAN_STAGES.has(name);

const stageSpanAttributes = (stage: SpaceFsStage): ObservationMeta => {
  const attributes: ObservationMeta = {
    "space_fs.stage.name": stage.name,
    "space_fs.stage.duration_ms": stage.durationMs,
    "space_fs.stage.outcome": stage.outcome,
  };
  if (stage.reason) attributes["space_fs.stage.reason"] = stage.reason;
  for (const [key, value] of Object.entries(stage)) {
    if (["name", "durationMs", "reason", "outcome"].includes(key)) continue;
    attributes[`space_fs.stage.${key}`] = value;
  }
  return attributes;
};

async function observeSpaceFsStage<T>(
  observation: SpaceFsObservation,
  name: string,
  reason: string,
  fn: () => Promise<T> | T,
  metaForResult?: (result: T) => ObservationMeta,
): Promise<T> {
  const createSpan = observation.spanStageOverrides?.[name] ?? shouldCreateStageSpan(name);
  const stageSpan = createSpan ? tracer.startSpan(`api.space_fs.${observation.operation}.${name}`) : null;
  const startedAt = performance.now();
  const run = async () => {
    try {
      const result = await fn();
      const durationMs = roundMs(performance.now() - startedAt);
      const stage: SpaceFsStage = {
        name,
        ...(FS_OBSERVABILITY_DETAILED ? { reason } : {}),
        outcome: "ok",
        durationMs,
        ...(metaForResult?.(result) ?? {}),
      };
      observation.stages.push(stage);
      if (stageSpan) {
        setSpanAttributes(stageSpan, stageSpanAttributes(stage));
        stageSpan.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error) {
      const durationMs = roundMs(performance.now() - startedAt);
      const stage: SpaceFsStage = {
        name,
        ...(FS_OBSERVABILITY_DETAILED ? { reason } : {}),
        outcome: "error",
        durationMs,
        ...errorTelemetry(error),
      };
      observation.stages.push(stage);
      if (stageSpan) {
        setSpanAttributes(stageSpan, stageSpanAttributes(stage));
        if (!isExpectedError(error)) {
          stageSpan.recordException({ name: error instanceof Error ? error.name : typeof error, message: safeErrorMessage(error) });
          stageSpan.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
        }
      }
      throw error;
    } finally {
      stageSpan?.end();
    }
  };

  return stageSpan ? await context.with(trace.setSpan(context.active(), stageSpan), run) : await run();
}

const summarizeStages = (stages: SpaceFsStage[]) =>
  stages.map((stage) => ({
    name: stage.name,
    durationMs: stage.durationMs,
    ...(stage.reason ? { reason: stage.reason } : {}),
    outcome: stage.outcome,
    ...Object.fromEntries(Object.entries(stage).filter(([key]) => !["name", "durationMs", "reason", "outcome"].includes(key))),
  }));

async function observeSpaceFs<T>(
  operation: SpaceFsOperation,
  input: { spaceId: string; path?: string; visibility: SpaceFsVisibility },
  fn: (observation: SpaceFsObservation) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(`api.space_fs.${operation}`, {
    attributes: {
      "space_fs.operation": operation,
      "space_fs.space_id": input.spaceId,
      "space_fs.visibility": input.visibility,
      ...Object.fromEntries(Object.entries(pathTelemetry(input.path)).map(([key, value]) => [`space_fs.request.${key}`, value ?? ""])),
    },
  });
  const observation: SpaceFsObservation = {
    operation,
    requestedSpaceId: input.spaceId,
    requestedPath: input.path,
    visibility: input.visibility,
    spanStageOverrides: {
      visibility_filter: input.visibility === "filtered",
    },
    stages: [],
    span,
  };
  const startedAt = performance.now();
  let operationError: unknown;

  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(observation);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      operationError = error;
      if (!isExpectedError(error)) {
        span.recordException({ name: error instanceof Error ? error.name : typeof error, message: safeErrorMessage(error) });
        span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(error) });
      }
      throw error;
    } finally {
      const durationMs = roundMs(performance.now() - startedAt);
      const result = observation.result ?? {};
      setSpanAttributes(span, {
        "space_fs.duration_ms": durationMs,
        "space_fs.stage_count": observation.stages.length,
        "space_fs.outcome": operationError ? "error" : "ok",
        ...Object.fromEntries(Object.entries(result).map(([key, value]) => [`space_fs.result.${key}`, value])),
      });
      if (shouldLogObservation(durationMs, operationError)) {
        logger.info("[space-fs] operation observed", {
          operation,
          outcome: operationError ? "error" : "ok",
          durationMs,
          spaceId: input.spaceId,
          visibility: input.visibility,
          ...(operationError ? { error: errorTelemetry(operationError) } : {}),
          requestedPath: pathTelemetry(input.path),
          normalizedPath: pathTelemetry(observation.normalizedPath),
          stageCount: observation.stages.length,
          stages: summarizeStages(observation.stages),
          result,
        });
      }
      span.end();
    }
  });
}

export async function listSpaceDirectory(
  spaceId: string,
  path = "",
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsTreeResponse> {
  const visibility = options?.visibility ?? "full";
  return observeSpaceFs("tree", { spaceId, path, visibility }, async (observation) => {
    const { root, target, relativePath } = await observeSpaceFsStage(
      observation,
      "resolve_target",
      "Normalize the requested path, resolve the workspace root, and protect against path traversal; slow when storage metadata or realpath is cold.",
      () => resolveTarget(spaceId, path, { allowEmpty: true }),
      (result) => pathTelemetry(result.relativePath),
    );
    observation.normalizedPath = relativePath;

    const targetStats = await observeSpaceFsStage(
      observation,
      "target_stat",
      "Read filesystem metadata for the requested node; slow when the backing volume is cold or under IO pressure.",
      async () => {
        try {
          return await lstat(target);
        } catch {
          throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
        }
      },
      (stats) => ({
        nodeType: entryType(stats),
        fileSizeBytes: stats.size,
        isDirectory: stats.isDirectory(),
        isSymlink: stats.isSymbolicLink(),
      }),
    );

    const filter = await observeSpaceFsStage(
      observation,
      "visibility_filter",
      "Build the visibility filter from workspace ignore rules when filtered access is requested; slow when ignore files need to be read.",
      () => createVisibilityFilter(root, visibility),
      (result) => ({ filterEnabled: result !== null }),
    );

    await observeSpaceFsStage(
      observation,
      "visibility_check",
      "Check whether the requested directory is visible to the caller; slow only when ignore matching is complex.",
      () => assertVisiblePath(filter, relativePath, { isDirectory: targetStats.isDirectory() }),
      () => ({ visible: true }),
    );

    await observeSpaceFsStage(
      observation,
      "directory_check",
      "Validate that the requested node is a readable directory.",
      () => {
        if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
          throw new SpaceFsError(400, "not_a_directory", "The selected path is not a directory.");
        }
      },
      () => ({ isDirectory: true }),
    );

    const names = await observeSpaceFsStage(
      observation,
      "directory_read",
      "Read directory entry names; slow when the directory is large or the backing volume is under IO pressure.",
      async () => {
        try {
          return await readdir(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
          }
          throw error;
        }
      },
      (result) => ({
        entryCount: result.length,
        scannedEntryLimit: MAX_DIR_ENTRIES,
        truncated: result.length > MAX_DIR_ENTRIES,
      }),
    );

    const entries = await observeSpaceFsStage(
      observation,
      "entry_stats",
      "Stat visible candidate entries and apply ignore filtering; slow when there are many entries or per-entry stat calls hit cold storage.",
      () =>
        Promise.all(
          names.slice(0, MAX_DIR_ENTRIES).map(async (name) => {
            const absPath = join(target, name);
            try {
              const entry = await toEntry(root, absPath, name);
              return filter?.isIgnored(entry.path, { isDirectory: entry.type === "dir" }) ? null : entry;
            } catch (error) {
              const code = (error as NodeJS.ErrnoException | null)?.code;
              if (code === "ENOENT") return null;
              throw error;
            }
          }),
        ),
      (result) => {
        const counts = result.reduce((value, entry) => {
          if (entry === null) value.skippedEntries += 1;
          else value.visibleEntries += 1;
          return value;
        }, { visibleEntries: 0, skippedEntries: 0 });
        return {
          scannedEntries: Math.min(names.length, MAX_DIR_ENTRIES),
          ...counts,
        };
      },
    );

    const visibleEntries = entries.filter((entry): entry is SpaceFsEntry => entry !== null);

    await observeSpaceFsStage(
      observation,
      "entry_sort",
      "Sort directories, symlinks, and files for a stable response; slow only when the visible entry list is large.",
      () => {
        visibleEntries.sort((a: SpaceFsEntry, b: SpaceFsEntry) => {
          const typeRank = (item: SpaceFsEntry) => item.type === "dir" ? 0 : item.type === "symlink" ? 1 : 2;
          return typeRank(a) - typeRank(b) || a.name.localeCompare(b.name);
        });
      },
      () => ({ visibleEntries: visibleEntries.length }),
    );

    observation.result = {
      entryCount: visibleEntries.length,
      truncated: names.length > MAX_DIR_ENTRIES,
    };

    return { path: relativePath, entries: visibleEntries };
  });
}

async function readSpaceFileMetadata(
  spaceId: string,
  path: string,
  options?: { enforcePreviewLimit?: boolean; visibility?: SpaceFsVisibility; observation?: SpaceFsObservation },
) {
  const observation = options?.observation;
  const observe = <T>(
    name: string,
    reason: string,
    fn: () => Promise<T> | T,
    metaForResult?: (result: T) => ObservationMeta,
  ) => observation ? observeSpaceFsStage(observation, name, reason, fn, metaForResult) : Promise.resolve(fn()).then((result) => result);

  const { root, target, relativePath } = await observe(
    "resolve_target",
    "Normalize the requested path, resolve the workspace root, and protect against path traversal; slow when storage metadata or realpath is cold.",
    () => resolveTarget(spaceId, path),
    (result) => pathTelemetry(result.relativePath),
  );
  if (observation) observation.normalizedPath = relativePath;

  const stats = await observe(
    "target_stat",
    "Read filesystem metadata for the requested file; slow when the backing volume is cold or under IO pressure.",
    async () => {
      try {
        return await lstat(target);
      } catch {
        throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
      }
    },
    (result) => ({
      nodeType: entryType(result),
      fileSizeBytes: result.size,
      isFile: result.isFile(),
      isDirectory: result.isDirectory(),
      isSymlink: result.isSymbolicLink(),
    }),
  );

  const filter = await observe(
    "visibility_filter",
    "Build the visibility filter from workspace ignore rules when filtered access is requested; slow when ignore files need to be read.",
    () => createVisibilityFilter(root, options?.visibility ?? "full"),
    (result) => ({ filterEnabled: result !== null }),
  );

  await observe(
    "visibility_check",
    "Check whether the requested file is visible to the caller; slow only when ignore matching is complex.",
    () => assertVisiblePath(filter, relativePath, { isDirectory: stats.isDirectory() }),
    () => ({ visible: true }),
  );

  await observe(
    "file_check",
    "Validate node type and preview size limits before reading content.",
    () => {
      if (stats.isSymbolicLink()) throw new SpaceFsError(400, "symlink_not_supported", "Symlink preview is not supported.");
      if (!stats.isFile()) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
      if (options?.enforcePreviewLimit !== false && stats.size > MAX_FILE_BYTES) {
        throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");
      }
    },
    () => ({
      fileSizeBytes: stats.size,
      previewLimitBytes: options?.enforcePreviewLimit === false ? null : MAX_FILE_BYTES,
    }),
  );

  return { target, relativePath, stats };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function toReadFilesError(path: string, error: unknown): SpaceFsReadFilesError {
  if (error instanceof SpaceFsError) {
    return { path, code: error.code, message: error.message, status: error.status };
  }
  const message = error instanceof Error ? error.message : "Failed to read file.";
  return { path, code: "space_fs_error", message, status: 500 };
}

function toFsCdnMeta(spaceId: string, target: string, relativePath: string, stats: Stats, mimeType: string | null): FsCdnFileMeta {
  return {
    spaceId,
    path: relativePath,
    name: basename(target),
    size: stats.size,
    mimeType,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function toInlineFileResponse(target: string, relativePath: string, stats: Stats, buffer: Buffer, mimeType: string | null): SpaceFsFileResponse {
  const kind = isTextMime(mimeType) ? "text" : "binary";
  return {
    path: relativePath,
    name: basename(target),
    size: stats.size,
    mimeType,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    kind,
    encoding: kind === "text" ? "utf-8" : "base64",
    content: kind === "text" ? buffer.toString("utf8") : buffer.toString("base64"),
    delivery: "inline",
  };
}

export async function readSpaceFile(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsFileResponse | SpaceFsPreparingFile> {
  const visibility = options?.visibility ?? "full";
  return observeSpaceFs("file", { spaceId, path, visibility }, async (observation) => {
    const { target, relativePath, stats } = await readSpaceFileMetadata(spaceId, path, {
      enforcePreviewLimit: false,
      visibility,
      observation,
    });

    const mimeType = await observeSpaceFsStage(
      observation,
      "mime_detect",
      "Infer the response MIME type from the filename extension.",
      () => getMimeType(target),
      (result) => ({ mimeType: result }),
    );

    const cdnMeta = await observeSpaceFsStage(
      observation,
      "cdn_meta",
      "Build CDN metadata used for large or binary file delivery decisions.",
      () => toFsCdnMeta(spaceId, target, relativePath, stats, mimeType),
      (result) => ({
        fileSizeBytes: result.size,
        mimeType: result.mimeType,
      }),
    );

    const useCdn = await observeSpaceFsStage(
      observation,
      "cdn_decision",
      "Decide between inline response and CDN-backed delivery; large or browser-heavy assets may avoid inline transfer.",
      () => shouldUseFsCdnForMeta(cdnMeta) && !prefersInlineTextPreview(cdnMeta),
      (result) => ({
        useCdn: result,
        fileSizeBytes: stats.size,
        mimeType,
      }),
    );

    if (useCdn) {
      const manifest = await observeSpaceFsStage(
        observation,
        "cdn_manifest",
        "Read or wait for the CDN manifest; slow when object upload, manifest creation, Redis, or object storage is pending.",
        () => ensureFsCdnManifest(cdnMeta, "read_miss", FS_CDN_READ_WAIT_TIMEOUT_MS),
        (result) => ({
          manifestReady: result !== null,
          waitTimeoutMs: FS_CDN_READ_WAIT_TIMEOUT_MS,
        }),
      );
      if (manifest) {
        const response = await observeSpaceFsStage(
          observation,
          "cdn_response",
          "Build the URL response from the ready CDN manifest.",
          () => buildUrlFileResponse(cdnMeta, manifest),
          (result) => ({
            delivery: result.delivery,
            fileSizeBytes: result.size,
            mimeType: result.mimeType,
          }),
        );
        observation.result = {
          delivery: response.delivery,
          fileSizeBytes: response.size,
          mimeType: response.mimeType,
          prepared: true,
        };
        return response;
      }

      const preparing = await observeSpaceFsStage(
        observation,
        "preparing_response",
        "Return a preparing response while CDN warmup continues asynchronously.",
        () => buildPreparingFile(cdnMeta),
        (result) => ({
          delivery: "preparing",
          fileSizeBytes: result.size,
          mimeType: result.mimeType,
        }),
      );
      observation.result = {
        delivery: "preparing",
        fileSizeBytes: preparing.size,
        mimeType: preparing.mimeType,
        prepared: false,
      };
      return preparing;
    }

    // Keep CDN warm for forced text paths (theme.css) so style/download can still use URLs.
    if (shouldUseFsCdnForMeta(cdnMeta)) {
      void enqueueFsCdnWarmForMeta(cdnMeta, "read_miss").catch(() => undefined);
    }

    await observeSpaceFsStage(
      observation,
      "inline_limit_check",
      "Validate the inline preview size limit before reading file content into memory.",
      () => {
        if (stats.size > MAX_FILE_BYTES) {
          throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");
        }
      },
      () => ({
        fileSizeBytes: stats.size,
        previewLimitBytes: MAX_FILE_BYTES,
      }),
    );

    const buffer = await observeSpaceFsStage(
      observation,
      "inline_read",
      "Read file bytes from workspace storage; slow when the file is large, cold, or the backing volume is under IO pressure.",
      () =>
        readFile(target).catch((error: NodeJS.ErrnoException) => {
          if (error?.code === "ENOENT") {
            throw new SpaceFsError(404, "file_read_failed", "File not found.");
          }
          throw new SpaceFsError(500, "file_read_failed", error?.message ?? "Failed to read file.");
        }),
      (result) => ({
        fileSizeBytes: stats.size,
        bytesRead: result.byteLength,
      }),
    );

    const response = await observeSpaceFsStage(
      observation,
      "inline_encode",
      "Encode text as UTF-8 or binary content as base64 for the JSON response; slow when the response body is large.",
      () => toInlineFileResponse(target, relativePath, stats, buffer, mimeType),
      (result) => ({
        delivery: result.delivery,
        kind: result.kind,
        fileSizeBytes: result.size,
        mimeType: result.mimeType,
      }),
    );

    observation.result = {
      delivery: response.delivery,
      kind: response.kind,
      fileSizeBytes: response.size,
      mimeType: response.mimeType,
      prepared: true,
    };

    return response;
  });
}

export async function readSpaceFiles(
  spaceId: string,
  paths: string[],
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsReadFilesResponse> {
  const visibility = options?.visibility ?? "full";
  return observeSpaceFs("files", { spaceId, visibility }, async (observation) => {
    await observeSpaceFsStage(
      observation,
      "validate_batch",
      "Validate batch size and duplicate input paths before storage access.",
      () => {
        if (paths.length === 0) throw new SpaceFsError(400, "paths_required", "paths are required.");
        if (paths.length > MAX_BATCH_READ_FILES) {
          throw new SpaceFsError(413, "too_many_files", `Cannot read more than ${MAX_BATCH_READ_FILES} files at once.`);
        }
        const seenPaths = new Set<string>();
        for (const path of paths) {
          if (typeof path !== "string" || !path) throw new SpaceFsError(400, "path_invalid", "Every path must be a non-empty string.");
          if (seenPaths.has(path)) throw new SpaceFsError(400, "duplicate_path", "Duplicate paths are not allowed.");
          seenPaths.add(path);
        }
      },
      () => ({ requestedFiles: paths.length, maxFiles: MAX_BATCH_READ_FILES }),
    );

    const metadataResults = await observeSpaceFsStage(
      observation,
      "metadata_read",
      "Resolve and stat each requested file with bounded concurrency; slow when many files are cold or filtered access needs ignore matching.",
      () =>
        mapWithConcurrency(paths, MAX_BATCH_READ_CONCURRENCY, async (path) => {
          try {
            return {
              ok: true as const,
              path,
              metadata: await readSpaceFileMetadata(spaceId, path, {
                enforcePreviewLimit: false,
                visibility,
              }),
            };
          } catch (error) {
            return { ok: false as const, path, error: toReadFilesError(path, error) };
          }
        }),
      (result) => ({
        requestedFiles: paths.length,
        readableFiles: result.reduce((count, item) => count + (item.ok ? 1 : 0), 0),
        errorCount: result.reduce((count, item) => count + (item.ok ? 0 : 1), 0),
        concurrency: MAX_BATCH_READ_CONCURRENCY,
      }),
    );

    const readableResults = metadataResults.filter((result) => result.ok);
    const cdnItems: Array<{ target: string; relativePath: string; stats: Stats; meta: FsCdnFileMeta }> = [];
    const inlineItems: Array<{ target: string; relativePath: string; stats: Stats; mimeType: string | null }> = [];

    await observeSpaceFsStage(
      observation,
      "delivery_split",
      "Classify readable files into CDN-backed or inline delivery.",
      () => {
        for (const result of readableResults) {
          const { target, relativePath, stats } = result.metadata;
          const mimeType = getMimeType(target);
          const meta = toFsCdnMeta(spaceId, target, relativePath, stats, mimeType);
          // Text-like files stay inline for editor preview even when CDN policy forces them.
          if (shouldUseFsCdnForMeta(meta) && !prefersInlineTextPreview(meta)) {
            cdnItems.push({ target, relativePath, stats, meta });
          } else {
            if (shouldUseFsCdnForMeta(meta)) {
              void enqueueFsCdnWarmForMeta(meta, "read_many_miss").catch(() => undefined);
            }
            inlineItems.push({ target, relativePath, stats, mimeType });
          }
        }
      },
      () => ({ readableFiles: readableResults.length, cdnFiles: cdnItems.length, inlineFiles: inlineItems.length }),
    );
    observation.spanStageOverrides = {
      ...observation.spanStageOverrides,
      cdn_manifest_read: cdnItems.length > 0,
    };

    const inlineTotalBytes = await observeSpaceFsStage(
      observation,
      "inline_limit_check",
      "Validate total inline response size before reading file content into memory.",
      () => {
        const totalBytes = inlineItems.reduce((sum, item) => sum + item.stats.size, 0);
        if (totalBytes > MAX_BATCH_READ_TOTAL_BYTES) {
          throw new SpaceFsError(413, "batch_too_large", "Total inline file size exceeds 20MB.");
        }
        return totalBytes;
      },
      (totalBytes) => ({ inlineTotalBytes: totalBytes, maxInlineBytes: MAX_BATCH_READ_TOTAL_BYTES }),
    );

    const files: SpaceFsFileResponse[] = [];
    const preparing: SpaceFsPreparingFile[] = [];
    const errors = metadataResults.filter((result) => !result.ok).map((result) => result.error);

    const initialManifests = await observeSpaceFsStage(
      observation,
      "cdn_manifest_read",
      "Read fresh CDN manifests for files that should use URL delivery; slow when Redis or manifest storage is slow.",
      () => getFreshFsCdnManifests(cdnItems.map((item) => item.meta)),
      (result) => ({ cdnFiles: cdnItems.length, readyManifests: result.size }),
    );

    const missingCdnItems = cdnItems.filter((item) => {
      const manifest = initialManifests.get(item.meta.path);
      if (manifest) {
        files.push(buildUrlFileResponse(item.meta, manifest));
        return false;
      }
      return true;
    });
    observation.spanStageOverrides = {
      ...observation.spanStageOverrides,
      cdn_manifest_read: cdnItems.length > 0,
      cdn_warm_enqueue: missingCdnItems.length > 0,
      cdn_manifest_wait: missingCdnItems.length > 0,
    };

    await observeSpaceFsStage(
      observation,
      "cdn_warm_enqueue",
      "Enqueue CDN warmup for missing manifests; slow when queue Redis calls are slow.",
      () =>
        Promise.allSettled(
          missingCdnItems.map(async (item) => {
            try {
              await enqueueFsCdnWarmForMeta(item.meta, "read_many_miss");
            } catch (error) {
              errors.push(toReadFilesError(item.meta.path, error));
            }
          }),
        ),
      () => ({ missingCdnFiles: missingCdnItems.length, errorCount: errors.length }),
    );

    const enqueuedCdnItems = missingCdnItems.filter((item) => !errors.some((error) => error.path === item.meta.path));
    const waited = await observeSpaceFsStage(
      observation,
      "cdn_manifest_wait",
      "Wait briefly for newly warmed CDN manifests; slow when object upload or manifest creation is still pending.",
      () => waitForFsCdnManifests(enqueuedCdnItems.map((item) => item.meta), FS_CDN_READ_MANY_WAIT_TIMEOUT_MS),
      (result) => ({ waitingFiles: enqueuedCdnItems.length, readyFiles: result.ready.size, pendingFiles: result.pending.length, waitTimeoutMs: FS_CDN_READ_MANY_WAIT_TIMEOUT_MS }),
    );
    for (const item of enqueuedCdnItems) {
      const manifest = waited.ready.get(item.meta.path);
      if (manifest) files.push(buildUrlFileResponse(item.meta, manifest));
    }
    for (const item of waited.pending) preparing.push(buildPreparingFile(item));

    const inlineFiles = await observeSpaceFsStage(
      observation,
      "inline_read",
      "Read and encode inline files with bounded concurrency; slow when files are large or storage is cold.",
      () =>
        mapWithConcurrency(inlineItems, MAX_BATCH_READ_CONCURRENCY, async (item) => {
          const buffer = await readFile(item.target).catch((error: NodeJS.ErrnoException) => {
            if (error?.code === "ENOENT") {
              throw new SpaceFsError(404, "file_read_failed", "File not found.");
            }
            throw new SpaceFsError(500, "file_read_failed", error?.message ?? "Failed to read file.");
          });
          return toInlineFileResponse(item.target, item.relativePath, item.stats, buffer, item.mimeType);
        }),
      (result) => ({ inlineFiles: result.length, inlineTotalBytes, concurrency: MAX_BATCH_READ_CONCURRENCY }),
    );
    files.push(...inlineFiles);

    observation.result = { files: files.length, preparing: preparing.length, errors: errors.length, inlineTotalBytes };
    return { files, preparing, errors };
  });
}

export async function streamSpaceFile(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<{ path: string; name: string; size: number; mimeType: string | null; mtimeMs: number; target: string; }> {
  const visibility = options?.visibility ?? "full";
  return observeSpaceFs("stream", { spaceId, path, visibility }, async (observation) => {
    const { root, target, relativePath } = await observeSpaceFsStage(
      observation,
      "resolve_target",
      "Normalize the requested path, resolve the workspace root, and protect against path traversal; slow when storage metadata or realpath is cold.",
      () => resolveTarget(spaceId, path),
      (result) => pathTelemetry(result.relativePath),
    );
    observation.normalizedPath = relativePath;

    const stats = await observeSpaceFsStage(
      observation,
      "target_stat",
      "Read filesystem metadata for the requested stream file; slow when the backing volume is cold or under IO pressure.",
      async () => {
        try {
          return await lstat(target);
        } catch {
          throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
        }
      },
      (result) => ({ nodeType: entryType(result), fileSizeBytes: result.size, isFile: result.isFile(), isDirectory: result.isDirectory(), isSymlink: result.isSymbolicLink() }),
    );

    const filter = await observeSpaceFsStage(
      observation,
      "visibility_filter",
      "Build the visibility filter from workspace ignore rules when filtered access is requested; slow when ignore files need to be read.",
      () => createVisibilityFilter(root, visibility),
      (result) => ({ filterEnabled: result !== null }),
    );

    await observeSpaceFsStage(
      observation,
      "stream_check",
      "Check visibility and validate that the requested node can be streamed as a file.",
      async () => {
        await assertVisiblePath(filter, relativePath, { isDirectory: stats.isDirectory() });
        if (!stats.isFile() || stats.isSymbolicLink()) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
      },
      () => ({ visible: true, fileSizeBytes: stats.size }),
    );

    const response = {
      path: relativePath,
      name: basename(target),
      size: stats.size,
      mimeType: getMimeType(target),
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      target,
    };
    observation.result = { fileSizeBytes: response.size, mimeType: response.mimeType };
    return response;
  });
}

export async function statSpaceFileVersion(spaceId: string, path: string): Promise<SpaceFsUploadTargetVersion> {
  const { target } = await resolveTarget(spaceId, path);
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
  if (!info.isFile()) throw new SpaceFsError(400, "not_a_file", "The upload target is not a file.");
  return { exists: true, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
}

export async function writeSpaceFile(spaceId: string, input: SpaceFsWriteFileInput) {
  const { root, target, relativePath } = await resolveTarget(spaceId, input.path);
  if (input.expected) {
    let current: Stats;
    try {
      current = await stat(target);
    } catch {
      throw new SpaceFsError(409, "file_conflict", "File changed since it was opened.");
    }
    if (!matchesSpaceFsVersion(current, input.expected)) {
      throw new SpaceFsError(409, "file_conflict", "File changed since it was opened.");
    }
  }
  const createdDirs = await ensureDirectories(root, dirname(target));
  const data = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  const created = await writeFileWithDisposition(target, data);
  const file = await stat(target);
  return { path: relativePath, size: file.size, mtimeMs: file.mtimeMs, created, createdDirs };
}

export async function createSpaceFileExclusive(spaceId: string, input: SpaceFsWriteFileInput) {
  const { root, target, relativePath } = await resolveTarget(spaceId, input.path);
  const createdDirs = await ensureDirectories(root, dirname(target));
  const data = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(target, "wx");
    await handle.writeFile(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") throw new SpaceFsError(409, "path_exists", "A file already exists at this path.");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const file = await stat(target);
  return { path: relativePath, size: file.size, mtimeMs: file.mtimeMs, created: true, createdDirs };
}

export async function createSpaceDirectory(spaceId: string, path: string) {
  const { root, target, relativePath } = await resolveTarget(spaceId, path);
  const createdDirs = await ensureDirectories(root, target);
  const info = await stat(target);
  return { path: relativePath, mtimeMs: info.mtimeMs, created: createdDirs.includes(relativePath), createdDirs };
}

export const deleteSpaceNode = async (spaceId: string, path: string, recursive = false) => {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  let nodeType: SpaceFsEntry["type"] | "unknown" = "unknown";
  try {
    const before = await lstat(target);
    nodeType = entryType(before);
    await rm(target, { recursive, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
    if (code === "ENOTEMPTY") throw new SpaceFsError(400, "directory_not_empty", "Directory is not empty.");
    throw error;
  }
  return { path: relativePath, deleted: true, nodeType };
}

export async function moveSpaceNode(spaceId: string, input: SpaceFsMoveInput) {
  const from = await resolveTarget(spaceId, input.fromPath);
  const to = await resolveTarget(spaceId, input.toPath);
  const nodeType = entryType(await lstat(from.target));
  const createdDirs = await ensureDirectories(to.root, dirname(to.target));
  await rename(from.target, to.target);
  return { fromPath: from.relativePath, toPath: to.relativePath, nodeType, createdDirs };
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

type DirectUploadCandidate = { file: File; name: string; relativePath: string };

function prepareDirectUploadCandidates(
  files: File[],
  targetDir: string,
): { candidates: DirectUploadCandidate[]; errors: SpaceFsUploadResponse["errors"] } {
  const candidates: DirectUploadCandidate[] = [];
  const errors: SpaceFsUploadResponse["errors"] = [];
  for (const file of files.slice(0, INLINE_UPLOAD_MAX_FILES)) {
    const safeName = sanitizeFileName(file.name);
    if (!safeName) {
      errors.push({ name: file.name, code: "name_invalid", message: "invalid file name" });
      continue;
    }
    if (file.size > INLINE_UPLOAD_MAX_FILE_BYTES) {
      errors.push({ name: safeName, code: "file_too_large", message: `file exceeds ${INLINE_UPLOAD_MAX_FILE_BYTES / (1024 * 1024)}MB limit` });
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

export async function uploadSpaceFiles(
  spaceId: string,
  files: File[],
  targetDir: string,
): Promise<SpaceFsUploadResponse> {
  const safeTargetDir = targetDir ? assertSafeRelativePath(targetDir, { allowEmpty: true }) : "";
  const { candidates, errors } = prepareDirectUploadCandidates(files, safeTargetDir);
  if (candidates.length === 0) return { uploaded: [], errors, createdDirs: [] };

  const { workspaceDir } = await ensureSpaceWorkspaceReady(spaceId);
  const dir = safeTargetDir ? resolve(workspaceDir, safeTargetDir) : workspaceDir;
  assertInsideRoot(dir, workspaceDir);
  const createdDirs = await ensureDirectories(workspaceDir, dir);
  const uploaded: SpaceFsUploadResponse["uploaded"] = [];

  for (const candidate of candidates) {
    const targetPath = join(dir, candidate.name);
    try {
      const buffer = Buffer.from(await candidate.file.arrayBuffer());
      const created = await writeFileWithDisposition(targetPath, buffer);
      const stats = await stat(targetPath);
      uploaded.push({
        path: candidate.relativePath,
        name: candidate.name,
        size: stats.size,
        mimeType: getMimeType(candidate.name),
        mtimeMs: stats.mtimeMs,
        created,
      });
    } catch {
      errors.push({ name: candidate.name, code: "write_failed", message: "failed to write file" });
    }
  }

  return { uploaded, errors, createdDirs };
}

export function spaceFsJsonError(error: unknown) {
  if (error instanceof SpaceFsError) {
    return { status: error.status, body: { code: error.code, message: error.message.toLowerCase().replace(/\.$/, "") } };
  }
  // Local sandbox offline (matched by name to avoid a cross-module import cycle).
  if (error instanceof Error && error.name === "SandboxOfflineError") {
    return { status: 503, body: { code: "sandbox_offline", message: "local sandbox is offline" } };
  }
  const detail = error instanceof Error ? error.message : String(error);
  const truncated = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return { status: 500, body: { code: "space_fs_error", message: `space file operation failed: ${truncated}` } };
}
