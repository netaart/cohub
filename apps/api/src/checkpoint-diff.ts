import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { checkpoints } from "@cohub/db";
import type {
  CheckpointDiffFile,
  CheckpointDiffFileResponse,
  CheckpointDiffPatchKind,
  CheckpointDiffPatchLine,
  CheckpointDiffStats,
  CheckpointDiffStatus,
  CheckpointDiffSummary,
} from "@cohub/protocol/fs";
import {
  CheckpointFsError,
  getCheckpointForSpace,
  resolveCheckpointRepo,
  runGit,
  readAssetManifestMap,
} from "./checkpoint-fs.js";
import { parseNameStatus, parseNumstat } from "./checkpoint-diff-parse.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { createPresignedGetObjectUrl } from "./object-presign.js";
import { redisCommandClient } from "./redis.js";

export { parseNameStatus, parseNumstat } from "./checkpoint-diff-parse.js";

// Git empty tree — used as the base for root checkpoints.
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Browser/CDN-friendly cache for immutable parent diffs (auth still required at origin). */
export const CHECKPOINT_DIFF_CACHE_CONTROL = "private, max-age=604800, immutable";

const DIFF_SUMMARY_MAX_FILES = 500;
const DIFF_PATCH_MAX_BYTES = 512 * 1024;
/** Short Redis TTL only for on-demand fallback of legacy checkpoints (no precomputed meta). */
const DIFF_FALLBACK_CACHE_TTL_SECONDS = 2 * 60 * 60;
const SYSTEM_PATH_PREFIX = ".cohub/system/";
const ASSET_POINTER_PREFIX = "version https://cohub.run/spec/asset-pointer/v1";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const cacheKey = (kind: "summary" | "file", head: string, base: string, path = "") =>
  `checkpoint-diff:${kind}:v2:${head}:${base}${path ? `:${sha256Hex(path)}` : ""}`;

type StoredFilePatchMeta =
  | {
      version: 1;
      delivery: "inline";
      patch: CheckpointDiffFileResponse;
    }
  | {
      version: 1;
      delivery: "url";
      objectKey: string;
      size: number;
      sha256: string;
      path: string;
      oldPath?: string | null;
      kind: CheckpointDiffFileResponse["kind"];
      status: CheckpointDiffStatus | null;
      binary: boolean;
      asset: boolean;
      additions: number | null;
      deletions: number | null;
      oldSize?: number | null;
      newSize?: number | null;
      truncated: boolean;
    };

type StoredParentDiffMeta =
  | {
      version: 1;
      kind: "parent";
      delivery: "inline";
      summary: CheckpointDiffSummary;
      files?: Record<string, StoredFilePatchMeta>;
    }
  | {
      version: 1;
      kind: "parent";
      delivery: "url";
      objectKey: string;
      size: number;
      sha256: string;
      stats: CheckpointDiffStats;
      truncated: boolean;
      baseCheckpointId: string | null;
      baseCommitHash: string | null;
      fileCount: number;
      files?: Record<string, StoredFilePatchMeta>;
    };

function readParentDiffMeta(checkpoint: { meta?: unknown; id: string; commitHash: string }): StoredParentDiffMeta | null {
  const meta = checkpoint.meta as Record<string, unknown> | null | undefined;
  const diffs = meta?.diffs as Record<string, unknown> | undefined;
  const parent = diffs?.parent as StoredParentDiffMeta | undefined;
  if (parent?.version !== 1 || parent.kind !== "parent") return null;
  if (parent.delivery === "inline" && parent.summary) return parent;
  if (parent.delivery === "url" && typeof parent.objectKey === "string") return parent;
  return null;
}

function fromPrecomputedFilePatch(stored: StoredFilePatchMeta): CheckpointDiffFileResponse & { precomputed: true } {
  if (stored.delivery === "inline") {
    return {
      ...stored.patch,
      delivery: "inline",
      precomputed: true,
    };
  }
  const signed = presignDiffObject(stored.objectKey);
  return {
    path: stored.path,
    oldPath: stored.oldPath ?? null,
    status: stored.status,
    kind: stored.kind,
    binary: stored.binary,
    asset: stored.asset,
    additions: stored.additions,
    deletions: stored.deletions,
    oldSize: stored.oldSize ?? null,
    newSize: stored.newSize ?? null,
    truncated: stored.truncated,
    lines: [],
    delivery: "url",
    url: signed.downloadUrl,
    precomputed: true,
  };
}

function presignDiffObject(objectKey: string) {
  return createPresignedGetObjectUrl({
    endpoint: config.checkpointAssetOssEndpoint,
    publicEndpoint: config.checkpointAssetOssPublicEndpoint,
    region: config.checkpointAssetOssRegion,
    bucket: config.checkpointAssetOssBucket,
    accessKeyId: config.checkpointAssetOssAccessKeyId,
    secretAccessKey: config.checkpointAssetOssSecretAccessKey,
  }, objectKey);
}

function emptyStats(): CheckpointDiffStats {
  return {
    changedFileCount: 0,
    addedFileCount: 0,
    modifiedFileCount: 0,
    deletedFileCount: 0,
    renamedFileCount: 0,
    copiedFileCount: 0,
    additions: 0,
    deletions: 0,
  };
}

function isSystemPath(path: string) {
  return path === ".cohub/system" || path.startsWith(SYSTEM_PATH_PREFIX);
}

function accumulateStats(stats: CheckpointDiffStats, file: CheckpointDiffFile) {
  stats.changedFileCount += 1;
  if (file.status === "A") stats.addedFileCount += 1;
  else if (file.status === "M" || file.status === "T") stats.modifiedFileCount += 1;
  else if (file.status === "D") stats.deletedFileCount += 1;
  else if (file.status === "R") stats.renamedFileCount += 1;
  else if (file.status === "C") stats.copiedFileCount += 1;
  if (typeof file.additions === "number") stats.additions += file.additions;
  if (typeof file.deletions === "number") stats.deletions += file.deletions;
}

function isAssetPointerContent(content: string | Buffer) {
  const head = typeof content === "string" ? content.slice(0, 80) : content.subarray(0, 80).toString("utf8");
  return head.startsWith(ASSET_POINTER_PREFIX);
}

function parseAssetPointer(content: string): { size: number | null; sha256: string | null } {
  let size: number | null = null;
  let sha256: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("size ")) {
      const value = Number.parseInt(trimmed.slice(5).trim(), 10);
      if (Number.isFinite(value)) size = value;
    } else if (trimmed.startsWith("sha256 ")) {
      sha256 = trimmed.slice(7).trim() || null;
    }
  }
  return { size, sha256 };
}

function parseUnifiedDiffLines(patch: string): CheckpointDiffPatchLine[] {
  const lines: CheckpointDiffPatchLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("similarity index") || raw.startsWith("rename from") || raw.startsWith("rename to") || raw.startsWith("copy from") || raw.startsWith("copy to") || raw.startsWith("new file mode") || raw.startsWith("deleted file mode") || raw.startsWith("Binary files")) {
      lines.push({ type: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("@@")) {
      lines.push({ type: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ type: "add", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ type: "del", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("\\")) {
      lines.push({ type: "meta", text: raw });
      continue;
    }
    // Context lines start with a space; bare empty lines are also context.
    lines.push({ type: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  // Drop trailing empty context produced by split.
  while (lines.length > 0 && lines[lines.length - 1]?.type === "context" && lines[lines.length - 1]?.text === "") {
    lines.pop();
  }
  return lines;
}

async function resolveBaseCommit(input: {
  spaceId: string;
  head: { id: string; parentCheckpointId: string | null; commitHash: string };
  baseCheckpointId?: string | null;
}): Promise<{ baseCheckpointId: string | null; baseCommitHash: string }> {
  if (input.baseCheckpointId) {
    if (input.baseCheckpointId === input.head.id) {
    throw new CheckpointFsError(400, "diff_base_invalid", "Base and head checkpoint must differ.");
    }
    const [base] = await db
      .select({ id: checkpoints.id, commitHash: checkpoints.commitHash })
      .from(checkpoints)
      .where(and(eq(checkpoints.id, input.baseCheckpointId), eq(checkpoints.spaceId, input.spaceId)))
      .limit(1);
    if (!base) throw new CheckpointFsError(404, "checkpoint_not_found", "Base checkpoint not found.");
    return { baseCheckpointId: base.id, baseCommitHash: base.commitHash };
  }
  if (!input.head.parentCheckpointId) {
    return { baseCheckpointId: null, baseCommitHash: EMPTY_TREE_HASH };
  }
  const [parent] = await db
    .select({ id: checkpoints.id, commitHash: checkpoints.commitHash })
    .from(checkpoints)
    .where(and(eq(checkpoints.id, input.head.parentCheckpointId), eq(checkpoints.spaceId, input.spaceId)))
    .limit(1);
  if (!parent) {
    // Parent record missing — fall back to empty tree so the endpoint still works.
    return { baseCheckpointId: null, baseCommitHash: EMPTY_TREE_HASH };
  }
  return { baseCheckpointId: parent.id, baseCommitHash: parent.commitHash };
}

async function readCachedJson<T>(key: string): Promise<T | null> {
  const raw = await redisCommandClient.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    await redisCommandClient.del(key).catch(() => undefined);
    return null;
  }
}

async function writeCachedJson(key: string, value: unknown) {
  await redisCommandClient.set(key, JSON.stringify(value), "EX", DIFF_FALLBACK_CACHE_TTL_SECONDS).catch(() => undefined);
}

function isDefaultParentBase(input: {
  headParentId: string | null;
  requestedBase?: string | null;
  resolvedBaseId: string | null;
}) {
  // Precomputed meta always covers the parent (or root/empty) comparison.
  if (!input.requestedBase) return true;
  if (!input.headParentId) return false;
  return input.requestedBase === input.headParentId || input.requestedBase === input.resolvedBaseId;
}

function fromPrecomputedMeta(
  head: { id: string; commitHash: string; parentCheckpointId: string | null },
  stored: StoredParentDiffMeta,
): CheckpointDiffSummary {
  if (stored.delivery === "inline") {
    return {
      ...stored.summary,
      headCheckpointId: head.id,
      headCommitHash: head.commitHash || stored.summary.headCommitHash,
      delivery: "inline",
      precomputed: true,
    };
  }
  const signed = presignDiffObject(stored.objectKey);
  return {
    baseCheckpointId: stored.baseCheckpointId,
    baseCommitHash: stored.baseCommitHash,
    headCheckpointId: head.id,
    headCommitHash: head.commitHash,
    files: [],
    truncated: stored.truncated,
    stats: stored.stats,
    delivery: "url",
    url: signed.downloadUrl,
    precomputed: true,
  };
}

export async function getCheckpointDiffSummary(input: {
  spaceId: string;
  checkpointId: string;
  baseCheckpointId?: string | null;
}): Promise<CheckpointDiffSummary> {
  const head = await getCheckpointForSpace(input.spaceId, input.checkpointId);
  const base = await resolveBaseCommit({
    spaceId: input.spaceId,
    head: {
      id: head.id,
      parentCheckpointId: head.parentCheckpointId,
      commitHash: head.commitHash,
    },
    baseCheckpointId: input.baseCheckpointId,
  });

  // Hot path: save-time precomputed parent diff (inline meta or OSS object).
  // Avoids NFS git entirely for the common case.
  const stored = readParentDiffMeta(head);
  if (
    stored &&
    isDefaultParentBase({
      headParentId: head.parentCheckpointId,
      requestedBase: input.baseCheckpointId,
      resolvedBaseId: base.baseCheckpointId,
    })
  ) {
    return fromPrecomputedMeta(head, stored);
  }

  // Legacy / custom base: compute on demand. Short Redis cache only — not the primary store.
  const key = cacheKey("summary", head.commitHash, base.baseCommitHash);
  const cached = await readCachedJson<CheckpointDiffSummary>(key);
  if (cached) return { ...cached, delivery: cached.delivery ?? "inline", precomputed: false };

  const repoDir = await resolveCheckpointRepo(head.spaceId, [head.commitHash, ...(base.baseCommitHash === EMPTY_TREE_HASH ? [] : [base.baseCommitHash])]);
  const assets = await readAssetManifestMap(repoDir, head).catch(() => new Map<string, { sha256: string; size: number; mimeType: string | null; objectKey: string }>());

  // Root checkpoints (no parent) use diff-tree against the empty tree; otherwise range diff.
  const isRoot = base.baseCommitHash === EMPTY_TREE_HASH;
  const nameStatusArgs = isRoot
    ? ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", "-M", head.commitHash]
    : ["diff", "--name-status", "-z", "-M", `${base.baseCommitHash}..${head.commitHash}`];
  const numstatArgs = isRoot
    ? ["diff-tree", "--no-commit-id", "--numstat", "-r", "-z", "--root", "-M", head.commitHash]
    : ["diff", "--numstat", "-z", "-M", `${base.baseCommitHash}..${head.commitHash}`];

  const [nameStatus, numstat] = await Promise.all([
    runGit(repoDir, nameStatusArgs, 2 * 1024 * 1024),
    runGit(repoDir, numstatArgs, 2 * 1024 * 1024),
  ]);

  const nameEntries = parseNameStatus(nameStatus.stdout);
  const numstatMap = parseNumstat(numstat.stdout);
  const stats = emptyStats();
  const files: CheckpointDiffFile[] = [];
  let truncated = false;

  for (const entry of nameEntries) {
    if (isSystemPath(entry.path) || (entry.oldPath && isSystemPath(entry.oldPath))) continue;
    if (files.length >= DIFF_SUMMARY_MAX_FILES) {
      truncated = true;
      const stub: CheckpointDiffFile = {
        status: entry.status,
        path: entry.path,
        oldPath: entry.oldPath ?? null,
        additions: null,
        deletions: null,
        binary: false,
        asset: false,
      };
      accumulateStats(stats, stub);
      continue;
    }
    const counts = numstatMap.get(entry.path);
    const asset = assets.has(entry.path) || (entry.oldPath ? assets.has(entry.oldPath) : false);
    const file: CheckpointDiffFile = {
      status: entry.status,
      path: entry.path,
      oldPath: entry.oldPath ?? null,
      additions: asset ? null : (counts?.additions ?? null),
      deletions: asset ? null : (counts?.deletions ?? null),
      binary: asset ? true : Boolean(counts?.binary),
      asset,
    };
    files.push(file);
    accumulateStats(stats, file);
  }

  if (truncated) {
    const full = emptyStats();
    for (const entry of nameEntries) {
      if (isSystemPath(entry.path) || (entry.oldPath && isSystemPath(entry.oldPath))) continue;
      const counts = numstatMap.get(entry.path);
      const asset = assets.has(entry.path) || (entry.oldPath ? assets.has(entry.oldPath) : false);
      accumulateStats(full, {
        status: entry.status,
        path: entry.path,
        oldPath: entry.oldPath ?? null,
        additions: asset ? null : (counts?.additions ?? null),
        deletions: asset ? null : (counts?.deletions ?? null),
        binary: asset ? true : Boolean(counts?.binary),
        asset,
      });
    }
    Object.assign(stats, full);
  }

  const response: CheckpointDiffSummary = {
    baseCheckpointId: base.baseCheckpointId,
    baseCommitHash: base.baseCommitHash === EMPTY_TREE_HASH ? null : base.baseCommitHash,
    headCheckpointId: head.id,
    headCommitHash: head.commitHash,
    files,
    truncated,
    stats,
    delivery: "inline",
    precomputed: false,
  };
  await writeCachedJson(key, response);
  return response;
}

async function showBlob(
  repoDir: string,
  commitHash: string,
  path: string,
): Promise<{ kind: "ok"; buffer: Buffer } | { kind: "missing" } | { kind: "too_large" }> {
  if (commitHash === EMPTY_TREE_HASH || !path) return { kind: "missing" };
  try {
    const result = await runGit(repoDir, ["show", `${commitHash}:${path}`], DIFF_PATCH_MAX_BYTES + 1024);
    return { kind: "ok", buffer: result.stdout };
  } catch (error) {
    if (error instanceof CheckpointFsError) {
      if (error.code === "path_not_found" || error.status === 404) return { kind: "missing" };
      if (error.code === "checkpoint_blob_too_large") return { kind: "too_large" };
    }
    throw error;
  }
}

export async function getCheckpointDiffFile(input: {
  spaceId: string;
  checkpointId: string;
  path: string;
  baseCheckpointId?: string | null;
}): Promise<CheckpointDiffFileResponse> {
  const normalizedPath = String(input.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedPath || normalizedPath.includes("\0") || normalizedPath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CheckpointFsError(400, "path_invalid", "Invalid path.");
  }
  if (isSystemPath(normalizedPath)) {
    throw new CheckpointFsError(400, "path_invalid", "System paths are not included in diffs.");
  }

  const head = await getCheckpointForSpace(input.spaceId, input.checkpointId);
  const base = await resolveBaseCommit({
    spaceId: input.spaceId,
    head: {
      id: head.id,
      parentCheckpointId: head.parentCheckpointId,
      commitHash: head.commitHash,
    },
    baseCheckpointId: input.baseCheckpointId,
  });

  // Hot path: save-time precomputed file patch for parent comparison.
  const storedParent = readParentDiffMeta(head);
  if (
    storedParent?.files &&
    isDefaultParentBase({
      headParentId: head.parentCheckpointId,
      requestedBase: input.baseCheckpointId,
      resolvedBaseId: base.baseCheckpointId,
    })
  ) {
    const storedFile =
      storedParent.files[normalizedPath] ??
      Object.values(storedParent.files).find((entry) => {
        if (entry.delivery === "inline") {
          return entry.patch.path === normalizedPath || entry.patch.oldPath === normalizedPath;
        }
        return entry.path === normalizedPath;
      });
    if (storedFile) return fromPrecomputedFilePatch(storedFile);
  }

  const key = cacheKey("file", head.commitHash, base.baseCommitHash, normalizedPath);
  const cached = await readCachedJson<CheckpointDiffFileResponse>(key);
  if (cached) return { ...cached, delivery: cached.delivery ?? "inline" };

  const repoDir = await resolveCheckpointRepo(head.spaceId, [head.commitHash, ...(base.baseCommitHash === EMPTY_TREE_HASH ? [] : [base.baseCommitHash])]);
  const assets = await readAssetManifestMap(repoDir, head).catch(() => new Map());

  // Resolve rename: if the path is only present as a rename target, capture oldPath from name-status.
  let status: CheckpointDiffStatus | null = null;
  let oldPath: string | null = null;
  let headPath = normalizedPath;
  try {
    const isRoot = base.baseCommitHash === EMPTY_TREE_HASH;
    const nameStatusArgs = isRoot
      ? ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", "-M", head.commitHash, "--", normalizedPath]
      : ["diff", "--name-status", "-z", "-M", `${base.baseCommitHash}..${head.commitHash}`, "--", normalizedPath];
    const nameStatus = await runGit(repoDir, nameStatusArgs, 64 * 1024);
    const entries = parseNameStatus(nameStatus.stdout);
    const match = entries.find((entry) => entry.path === normalizedPath || entry.oldPath === normalizedPath);
    if (match) {
      status = match.status;
      oldPath = match.oldPath ?? null;
      headPath = match.path;
    }
  } catch {
    // Fall through — file may still have content on one side.
  }

  const basePath = oldPath && (status === "R" || status === "C") ? oldPath : normalizedPath;

  const [baseResult, headResult] = await Promise.all([
    showBlob(repoDir, base.baseCommitHash, basePath),
    showBlob(repoDir, head.commitHash, headPath),
  ]);

  if (baseResult.kind === "too_large" || headResult.kind === "too_large") {
    const response: CheckpointDiffFileResponse = {
      path: headPath,
      oldPath,
      status: status ?? (baseResult.kind === "missing" ? "A" : headResult.kind === "missing" ? "D" : "M"),
      kind: "too_large",
      binary: false,
      asset: false,
      additions: null,
      deletions: null,
      oldSize: baseResult.kind === "ok" ? baseResult.buffer.length : null,
      newSize: headResult.kind === "ok" ? headResult.buffer.length : null,
      truncated: true,
      lines: [],
    };
    await writeCachedJson(key, response);
    return response;
  }

  const baseBlob = baseResult.kind === "ok" ? baseResult.buffer : null;
  const headBlob = headResult.kind === "ok" ? headResult.buffer : null;

  if (!baseBlob && !headBlob) {
    throw new CheckpointFsError(404, "path_not_found", "File not found in either checkpoint.");
  }

  const headAsset = assets.get(headPath) ?? null;
  const baseIsPointer = baseBlob ? isAssetPointerContent(baseBlob) : false;
  const headIsPointer = headBlob ? isAssetPointerContent(headBlob) : false;
  const asset = Boolean(headAsset) || baseIsPointer || headIsPointer;

  let oldSize: number | null = baseBlob?.length ?? null;
  let newSize: number | null = headBlob?.length ?? null;
  if (baseIsPointer && baseBlob) {
    oldSize = parseAssetPointer(baseBlob.toString("utf8")).size;
  }
  if (headIsPointer && headBlob) {
    newSize = parseAssetPointer(headBlob.toString("utf8")).size;
  } else if (headAsset) {
    newSize = headAsset.size;
  }

  if (asset) {
    const response: CheckpointDiffFileResponse = {
      path: headPath,
      oldPath,
      status: status ?? (baseBlob ? (headBlob ? "M" : "D") : "A"),
      kind: "asset",
      binary: true,
      asset: true,
      additions: null,
      deletions: null,
      oldSize,
      newSize,
      truncated: false,
      lines: [],
    };
    await writeCachedJson(key, response);
    return response;
  }

  // Binary detection: null byte in either side.
  const looksBinary = (blob: Buffer | null) => Boolean(blob?.includes(0));
  if (looksBinary(baseBlob) || looksBinary(headBlob)) {
    const response: CheckpointDiffFileResponse = {
      path: headPath,
      oldPath,
      status: status ?? (baseBlob ? (headBlob ? "M" : "D") : "A"),
      kind: "binary",
      binary: true,
      asset: false,
      additions: null,
      deletions: null,
      oldSize,
      newSize,
      truncated: false,
      lines: [],
    };
    await writeCachedJson(key, response);
    return response;
  }

  // Size guard before requesting the full patch.
  if ((baseBlob?.length ?? 0) > DIFF_PATCH_MAX_BYTES || (headBlob?.length ?? 0) > DIFF_PATCH_MAX_BYTES) {
    const response: CheckpointDiffFileResponse = {
      path: headPath,
      oldPath,
      status: status ?? (baseBlob ? (headBlob ? "M" : "D") : "A"),
      kind: "too_large",
      binary: false,
      asset: false,
      additions: null,
      deletions: null,
      oldSize,
      newSize,
      truncated: true,
      lines: [],
    };
    await writeCachedJson(key, response);
    return response;
  }

  let lines: CheckpointDiffPatchLine[] = [];
  let additions = 0;
  let deletions = 0;
  let truncated = false;

  // Root / deleted / added files: synthesize from blobs when range diff is awkward.
  const synthesizeFromBlobs = base.baseCommitHash === EMPTY_TREE_HASH || !baseBlob || !headBlob;
  if (synthesizeFromBlobs) {
    const oldText = baseBlob?.toString("utf8") ?? "";
    const newText = headBlob?.toString("utf8") ?? "";
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === "") newLines.pop();
    lines = [
      { type: "hunk", text: `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@` },
      ...oldLines.map((text) => ({ type: "del" as const, text })),
      ...newLines.map((text) => ({ type: "add" as const, text })),
    ];
    additions = newLines.length;
    deletions = oldLines.length;
  } else {
    try {
      const result = await runGit(
        repoDir,
        [
          "diff",
          "--no-color",
          "--find-renames",
          "--unified=3",
          base.baseCommitHash,
          head.commitHash,
          "--",
          ...(oldPath && oldPath !== headPath ? [oldPath, headPath] : [normalizedPath]),
        ],
        DIFF_PATCH_MAX_BYTES + 64 * 1024,
      );
      truncated = result.stdout.length > DIFF_PATCH_MAX_BYTES;
      const patchText = (truncated ? result.stdout.subarray(0, DIFF_PATCH_MAX_BYTES) : result.stdout).toString("utf8");
      lines = parseUnifiedDiffLines(patchText);
      for (const line of lines) {
        if (line.type === "add") additions += 1;
        else if (line.type === "del") deletions += 1;
      }
    } catch (error) {
      if (error instanceof CheckpointFsError && error.code === "checkpoint_blob_too_large") {
        const response: CheckpointDiffFileResponse = {
          path: headPath,
          oldPath,
          status: status ?? (baseBlob ? (headBlob ? "M" : "D") : "A"),
          kind: "too_large",
          binary: false,
          asset: false,
          additions: null,
          deletions: null,
          oldSize,
          newSize,
          truncated: true,
          lines: [],
        };
        await writeCachedJson(key, response);
        return response;
      }
      throw error;
    }
  }

  const kind: CheckpointDiffPatchKind = "text";
  const response: CheckpointDiffFileResponse = {
    path: headPath,
    oldPath,
    status: status ?? (baseBlob ? (headBlob ? "M" : "D") : "A"),
    kind,
    binary: false,
    asset: false,
    additions,
    deletions,
    oldSize,
    newSize,
    truncated,
    lines,
  };
  await writeCachedJson(key, response);
  return response;
}

// Re-export helpers used by pending-diff.
export { isSystemPath, isAssetPointerContent, parseAssetPointer, emptyStats, accumulateStats, DIFF_SUMMARY_MAX_FILES };
